#!/usr/bin/env python3
"""Handle-relative, no-follow file operations for untrusted task workspaces."""
from __future__ import annotations

import base64
import ctypes
import hashlib
import json
import os
import stat
import sys
from pathlib import Path
from typing import Callable


class SecureFsError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _parts(value: object, label: str, *, allow_empty: bool = True) -> list[str]:
    if not isinstance(value, list) or (not value and not allow_empty):
        raise SecureFsError("INVALID_PATH", f"{label} must be a path component list")
    if len(value) > 64:
        raise SecureFsError("INVALID_PATH", f"{label} has too many components")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item or item in (".", "..") or "/" in item or "\\" in item or "\0" in item:
            raise SecureFsError("INVALID_PATH", f"{label} contains an invalid component")
        result.append(item)
    return result


def _single(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or value in (".", "..") or "/" in value or "\\" in value or "\0" in value:
        raise SecureFsError("INVALID_PATH", f"{label} must be one safe path component")
    return value


def _limit(value: object, fallback: int = 32 * 1024 * 1024) -> int:
    if value is None:
        return fallback
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0 or value > 64 * 1024 * 1024:
        raise SecureFsError("INVALID_LIMIT", "maxBytes must be between 1 and 64MiB")
    return value


def _same_stat(before: os.stat_result, after: os.stat_result) -> bool:
    return (
        before.st_dev == after.st_dev
        and before.st_ino == after.st_ino
        and before.st_size == after.st_size
        and before.st_mtime_ns == after.st_mtime_ns
        and before.st_ctime_ns == after.st_ctime_ns
    )


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    written = 0
    while written < len(view):
        count = os.write(fd, view[written:])
        if count <= 0:
            raise SecureFsError("WRITE_FAILED", "short write")
        written += count


def _open_posix_directory(path: str) -> int:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise SecureFsError("PATH_FORBIDDEN", f"cannot open directory: {exc}") from exc
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        os.close(fd)
        raise SecureFsError("PATH_FORBIDDEN", "directory is a link or not a directory")
    return fd


def _open_posix_relative_directory(parent: int, name: str, *, create: bool) -> int:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        return os.open(name, flags, dir_fd=parent)
    except FileNotFoundError:
        if not create:
            raise SecureFsError("ARTIFACT_MISSING", f"missing directory component: {name}")
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError:
            pass
        try:
            return os.open(name, flags, dir_fd=parent)
        except OSError as exc:
            raise SecureFsError("PATH_FORBIDDEN", f"cannot open directory component: {exc}") from exc
    except OSError as exc:
        raise SecureFsError("PATH_FORBIDDEN", f"directory component is a link or inaccessible: {exc}") from exc


def _posix_directory_chain(root: str, parts: list[str], subdirectory: str | None) -> tuple[int, list[int]]:
    current = _open_posix_directory(root)
    opened = [current]
    try:
        for part in parts:
            current = _open_posix_relative_directory(current, part, create=False)
            opened.append(current)
        if subdirectory is not None:
            current = _open_posix_relative_directory(current, subdirectory, create=True)
            opened.append(current)
        return current, opened
    except Exception:
        for fd in reversed(opened):
            os.close(fd)
        raise


def _posix_read(root: str, parts: list[str], file_parts: list[str], max_bytes: int) -> bytes:
    directory, opened = _posix_directory_chain(root, parts, None)
    try:
        for part in file_parts[:-1]:
            directory = _open_posix_relative_directory(directory, part, create=False)
            opened.append(directory)
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(file_parts[-1], flags, dir_fd=directory)
        except OSError as exc:
            raise SecureFsError("ARTIFACT_MISSING", f"cannot open file: {exc}") from exc
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode) or before.st_nlink != 1:
                raise SecureFsError("PATH_FORBIDDEN", "input must be a single-link regular file")
            if before.st_size > max_bytes:
                raise SecureFsError("INPUT_TOO_LARGE", "input exceeds maxBytes")
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = os.read(fd, min(65536, max_bytes + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > max_bytes:
                    raise SecureFsError("INPUT_TOO_LARGE", "input exceeds maxBytes")
            after = os.fstat(fd)
            if not _same_stat(before, after):
                raise SecureFsError("INPUT_CHANGED", "input changed while reading")
            return b"".join(chunks)
        finally:
            os.close(fd)
    finally:
        for fd in reversed(opened):
            os.close(fd)


def _posix_write(root: str, parts: list[str], subdirectory: str | None, name: str, data: bytes) -> str:
    directory, opened = _posix_directory_chain(root, parts, subdirectory)
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(name, flags, 0o600, dir_fd=directory)
        except OSError as exc:
            raise SecureFsError("PATH_FORBIDDEN", f"cannot create output: {exc}") from exc
        try:
            _write_all(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
        return os.path.join(root, *parts, *([subdirectory] if subdirectory else []), name)
    finally:
        for fd in reversed(opened):
            os.close(fd)


def _posix_copy(source: str, root: str, parts: list[str], subdirectory: str | None, name: str, max_bytes: int, expected_sha256: str | None) -> tuple[str, str]:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        source_fd = os.open(source, flags)
    except OSError as exc:
        raise SecureFsError("ARTIFACT_MISSING", f"cannot open source: {exc}") from exc
    destination, opened = _posix_directory_chain(root, parts, subdirectory)
    try:
        before = os.fstat(source_fd)
        if not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode) or before.st_nlink != 1:
            raise SecureFsError("PATH_FORBIDDEN", "source must be a single-link regular file")
        if before.st_size > max_bytes:
            raise SecureFsError("INPUT_TOO_LARGE", "source exceeds maxBytes")
        out_fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=destination)
        try:
            digest = hashlib.sha256()
            total = 0
            while True:
                chunk = os.read(source_fd, min(65536, max_bytes + 1 - total))
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise SecureFsError("INPUT_TOO_LARGE", "source exceeds maxBytes")
                digest.update(chunk)
                _write_all(out_fd, chunk)
            after = os.fstat(source_fd)
            if not _same_stat(before, after):
                raise SecureFsError("INPUT_CHANGED", "source changed while copying")
            actual = digest.hexdigest()
            if expected_sha256 is not None and actual != expected_sha256:
                raise SecureFsError("HASH_MISMATCH", "source SHA-256 mismatch")
            os.fsync(out_fd)
        finally:
            os.close(out_fd)
        return os.path.join(root, *parts, *([subdirectory] if subdirectory else []), name), actual
    finally:
        os.close(source_fd)
        for fd in reversed(opened):
            os.close(fd)


if os.name == "nt":
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    ntdll = ctypes.WinDLL("ntdll")

    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
    GENERIC_READ = 0x80000000
    FILE_READ_DATA = 0x0001
    FILE_LIST_DIRECTORY = 0x0001
    FILE_WRITE_DATA = 0x0002
    FILE_READ_ATTRIBUTES = 0x0080
    FILE_WRITE_ATTRIBUTES = 0x0100
    DELETE = 0x00010000
    SYNCHRONIZE = 0x00100000
    FILE_SHARE_READ = 0x00000001
    FILE_SHARE_WRITE = 0x00000002
    FILE_SHARE_DELETE = 0x00000004
    FILE_SHARE_ALL = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
    OPEN_EXISTING = 3
    FILE_CREATE = 2
    FILE_OPEN = 1
    FILE_OPEN_IF = 3
    FILE_ATTRIBUTE_NORMAL = 0x00000080
    FILE_ATTRIBUTE_DIRECTORY = 0x00000010
    FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
    FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
    FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
    FILE_DIRECTORY_FILE = 0x00000001
    FILE_NON_DIRECTORY_FILE = 0x00000040
    FILE_OPEN_REPARSE_POINT = 0x00200000
    FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020
    STATUS_SUCCESS = 0
    STATUS_OBJECT_NAME_NOT_FOUND = 0xC0000034
    STATUS_OBJECT_PATH_NOT_FOUND = 0xC000003A

    class UNICODE_STRING(ctypes.Structure):
        _fields_ = [("Length", wintypes.USHORT), ("MaximumLength", wintypes.USHORT), ("Buffer", wintypes.LPWSTR)]

    class OBJECT_ATTRIBUTES(ctypes.Structure):
        _fields_ = [
            ("Length", wintypes.ULONG),
            ("RootDirectory", wintypes.HANDLE),
            ("ObjectName", ctypes.POINTER(UNICODE_STRING)),
            ("Attributes", wintypes.ULONG),
            ("SecurityDescriptor", wintypes.LPVOID),
            ("SecurityQualityOfService", wintypes.LPVOID),
        ]

    class IO_STATUS_BLOCK(ctypes.Structure):
        _fields_ = [("Status", wintypes.LONG), ("Information", ctypes.c_size_t)]

    class BY_HANDLE_FILE_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("dwFileAttributes", wintypes.DWORD),
            ("ftCreationTime", wintypes.FILETIME),
            ("ftLastAccessTime", wintypes.FILETIME),
            ("ftLastWriteTime", wintypes.FILETIME),
            ("dwVolumeSerialNumber", wintypes.DWORD),
            ("nFileSizeHigh", wintypes.DWORD),
            ("nFileSizeLow", wintypes.DWORD),
            ("nNumberOfLinks", wintypes.DWORD),
            ("nFileIndexHigh", wintypes.DWORD),
            ("nFileIndexLow", wintypes.DWORD),
        ]

    kernel32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel32.CreateFileW.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.GetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.POINTER(BY_HANDLE_FILE_INFORMATION)]
    kernel32.GetFileInformationByHandle.restype = wintypes.BOOL
    kernel32.GetFileSizeEx.argtypes = [wintypes.HANDLE, ctypes.POINTER(ctypes.c_longlong)]
    kernel32.GetFileSizeEx.restype = wintypes.BOOL
    kernel32.WriteFile.argtypes = [wintypes.HANDLE, wintypes.LPCVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
    kernel32.WriteFile.restype = wintypes.BOOL
    kernel32.ReadFile.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
    kernel32.ReadFile.restype = wintypes.BOOL
    kernel32.FlushFileBuffers.argtypes = [wintypes.HANDLE]
    kernel32.FlushFileBuffers.restype = wintypes.BOOL
    ntdll.NtCreateFile.argtypes = [
        ctypes.POINTER(wintypes.HANDLE), wintypes.ULONG, ctypes.POINTER(OBJECT_ATTRIBUTES),
        ctypes.POINTER(IO_STATUS_BLOCK), ctypes.POINTER(ctypes.c_longlong), wintypes.ULONG,
        wintypes.ULONG, wintypes.ULONG, wintypes.ULONG, wintypes.LPVOID, wintypes.ULONG,
    ]
    ntdll.NtCreateFile.restype = wintypes.LONG
    ntdll.RtlNtStatusToDosError.argtypes = [wintypes.LONG]
    ntdll.RtlNtStatusToDosError.restype = wintypes.ULONG

    def _win_error(message: str, code: str = "PATH_FORBIDDEN") -> SecureFsError:
        error = ctypes.get_last_error()
        return SecureFsError(code, f"{message}: win32 error {error}")

    def _close_win(handle: int) -> None:
        if handle and handle != INVALID_HANDLE_VALUE:
            kernel32.CloseHandle(handle)

    def _open_win_absolute(path: str, *, directory: bool) -> int:
        access = (FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE) if directory else GENERIC_READ
        flags = FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT
        handle = kernel32.CreateFileW(path, access, FILE_SHARE_ALL, None, OPEN_EXISTING, flags, None)
        if handle == INVALID_HANDLE_VALUE:
            raise _win_error("cannot open absolute path")
        _check_win_handle(handle, directory=directory)
        return handle

    def _check_win_handle(handle: int, *, directory: bool) -> None:
        info = BY_HANDLE_FILE_INFORMATION()
        if not kernel32.GetFileInformationByHandle(handle, ctypes.byref(info)):
            _close_win(handle)
            raise _win_error("cannot inspect handle")
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT:
            _close_win(handle)
            raise SecureFsError("PATH_FORBIDDEN", "reparse points and junctions are not allowed")
        if directory and not (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY):
            _close_win(handle)
            raise SecureFsError("PATH_FORBIDDEN", "expected a directory")
        if not directory and info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY:
            _close_win(handle)
            raise SecureFsError("PATH_FORBIDDEN", "expected a regular file")
        if not directory and info.nNumberOfLinks != 1:
            _close_win(handle)
            raise SecureFsError("PATH_FORBIDDEN", "hard links are not allowed")

    def _nt_create_relative(parent: int, name: str, *, directory: bool, create: bool, write: bool = False) -> int:
        raw = name.encode("utf-16-le")
        buffer = ctypes.create_unicode_buffer(name)
        unicode = UNICODE_STRING(len(raw), len(raw) + 2, ctypes.cast(buffer, wintypes.LPWSTR))
        attributes = OBJECT_ATTRIBUTES(ctypes.sizeof(OBJECT_ATTRIBUTES), parent, ctypes.pointer(unicode), 0, None, None)
        status_block = IO_STATUS_BLOCK()
        handle = wintypes.HANDLE()
        if directory:
            access = FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE
            disposition = FILE_OPEN_IF if create else FILE_OPEN
        else:
            access = (FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE) if write else (GENERIC_READ | SYNCHRONIZE)
            disposition = FILE_CREATE if create else FILE_OPEN
        options = (FILE_DIRECTORY_FILE if directory else FILE_NON_DIRECTORY_FILE) | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT
        status = ntdll.NtCreateFile(ctypes.byref(handle), access, ctypes.byref(attributes), ctypes.byref(status_block), None, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_ALL, disposition, options, None, 0)
        if status != STATUS_SUCCESS:
            if status in (STATUS_OBJECT_NAME_NOT_FOUND, STATUS_OBJECT_PATH_NOT_FOUND):
                raise SecureFsError("ARTIFACT_MISSING", f"missing path component: {name}")
            error = ntdll.RtlNtStatusToDosError(status)
            raise SecureFsError("PATH_FORBIDDEN", f"cannot open relative path: win32 error {error}")
        _check_win_handle(handle.value, directory=directory)
        return handle.value

    def _open_win_relative_directory(parent: int, name: str, *, create: bool) -> int:
        if create:
            return _nt_create_relative(parent, name, directory=True, create=True)
        try:
            return _nt_create_relative(parent, name, directory=True, create=False)
        except SecureFsError as exc:
            raise exc

    def _win_directory_chain(root: str, parts: list[str], subdirectory: str | None) -> tuple[int, list[int]]:
        current = _open_win_absolute(root, directory=True)
        opened = [current]
        try:
            for part in parts:
                current = _open_win_relative_directory(current, part, create=False)
                opened.append(current)
            if subdirectory is not None:
                current = _open_win_relative_directory(current, subdirectory, create=True)
                opened.append(current)
            return current, opened
        except Exception:
            for handle in reversed(opened):
                _close_win(handle)
            raise

    def _win_size(handle: int) -> int:
        size = ctypes.c_longlong()
        if not kernel32.GetFileSizeEx(handle, ctypes.byref(size)):
            raise _win_error("cannot get file size")
        return size.value

    def _win_identity(handle: int) -> tuple[int, int, int, int, int]:
        info = BY_HANDLE_FILE_INFORMATION()
        if not kernel32.GetFileInformationByHandle(handle, ctypes.byref(info)):
            raise _win_error("cannot inspect file identity")
        return (
            info.dwVolumeSerialNumber,
            (info.nFileIndexHigh << 32) | info.nFileIndexLow,
            (info.nFileSizeHigh << 32) | info.nFileSizeLow,
            info.ftLastWriteTime.dwLowDateTime,
            info.ftLastWriteTime.dwHighDateTime,
        )

    def _win_read(handle: int, max_bytes: int) -> bytes:
        before = _win_identity(handle)
        size = _win_size(handle)
        if size > max_bytes:
            raise SecureFsError("INPUT_TOO_LARGE", "input exceeds maxBytes")
        chunks: list[bytes] = []
        total = 0
        while True:
            buffer = ctypes.create_string_buffer(min(65536, max_bytes + 1 - total))
            read = wintypes.DWORD()
            if not kernel32.ReadFile(handle, buffer, len(buffer), ctypes.byref(read), None):
                raise _win_error("cannot read file")
            if read.value == 0:
                break
            chunks.append(buffer.raw[: read.value])
            total += read.value
            if total > max_bytes:
                raise SecureFsError("INPUT_TOO_LARGE", "input exceeds maxBytes")
        if _win_identity(handle) != before:
            raise SecureFsError("INPUT_CHANGED", "input identity changed while reading")
        return b"".join(chunks)

    def _win_write(handle: int, data: bytes) -> None:
        view = memoryview(data)
        written = 0
        while written < len(view):
            count = wintypes.DWORD()
            chunk = view[written : written + 65536]
            buffer = ctypes.create_string_buffer(bytes(chunk))
            if not kernel32.WriteFile(handle, buffer, len(chunk), ctypes.byref(count), None):
                raise _win_error("cannot write file", "WRITE_FAILED")
            if count.value <= 0:
                raise SecureFsError("WRITE_FAILED", "short write")
            written += count.value

    def _win_read_path(root: str, parts: list[str], file_parts: list[str], max_bytes: int) -> bytes:
        directory, opened = _win_directory_chain(root, parts, None)
        try:
            for part in file_parts[:-1]:
                directory = _open_win_relative_directory(directory, part, create=False)
                opened.append(directory)
            handle = _nt_create_relative(directory, file_parts[-1], directory=False, create=False)
            try:
                return _win_read(handle, max_bytes)
            finally:
                _close_win(handle)
        finally:
            for item in reversed(opened):
                _close_win(item)

    def _win_write_path(root: str, parts: list[str], subdirectory: str | None, name: str, data: bytes) -> str:
        directory, opened = _win_directory_chain(root, parts, subdirectory)
        try:
            handle = _nt_create_relative(directory, name, directory=False, create=True, write=True)
            try:
                _win_write(handle, data)
                if not kernel32.FlushFileBuffers(handle):
                    raise _win_error("cannot flush file", "WRITE_FAILED")
            finally:
                _close_win(handle)
            return os.path.join(root, *parts, *([subdirectory] if subdirectory else []), name)
        finally:
            for item in reversed(opened):
                _close_win(item)

    def _win_copy(source: str, root: str, parts: list[str], subdirectory: str | None, name: str, max_bytes: int, expected_sha256: str | None) -> tuple[str, str]:
        source_handle = _open_win_absolute(source, directory=False)
        destination, opened = _win_directory_chain(root, parts, subdirectory)
        try:
            source_identity = _win_identity(source_handle)
            size = _win_size(source_handle)
            if size > max_bytes:
                raise SecureFsError("INPUT_TOO_LARGE", "source exceeds maxBytes")
            out_handle = _nt_create_relative(destination, name, directory=False, create=True, write=True)
            try:
                digest = hashlib.sha256()
                total = 0
                while True:
                    buffer = ctypes.create_string_buffer(min(65536, max_bytes + 1 - total))
                    read = wintypes.DWORD()
                    if not kernel32.ReadFile(source_handle, buffer, len(buffer), ctypes.byref(read), None):
                        raise _win_error("cannot read source")
                    if read.value == 0:
                        break
                    total += read.value
                    if total > max_bytes:
                        raise SecureFsError("INPUT_TOO_LARGE", "source exceeds maxBytes")
                    chunk = buffer.raw[: read.value]
                    digest.update(chunk)
                    _win_write(out_handle, chunk)
                if _win_identity(source_handle) != source_identity:
                    raise SecureFsError("INPUT_CHANGED", "source identity changed while copying")
                actual = digest.hexdigest()
                if expected_sha256 is not None and actual != expected_sha256:
                    raise SecureFsError("HASH_MISMATCH", "source SHA-256 mismatch")
                if not kernel32.FlushFileBuffers(out_handle):
                    raise _win_error("cannot flush file", "WRITE_FAILED")
            finally:
                _close_win(out_handle)
            return os.path.join(root, *parts, *([subdirectory] if subdirectory else []), name), actual
        finally:
            _close_win(source_handle)
            for item in reversed(opened):
                _close_win(item)


def secure_read(request: dict) -> dict:
    root = request.get("root")
    if not isinstance(root, str) or not os.path.isabs(root):
        raise SecureFsError("INVALID_PATH", "root must be absolute")
    parts = _parts(request.get("directoryParts", []), "directoryParts")
    file_parts = _parts(request.get("fileParts"), "fileParts", allow_empty=False)
    max_bytes = _limit(request.get("maxBytes"))
    if os.name == "nt":
        data = _win_read_path(root, parts, file_parts, max_bytes)
    else:
        data = _posix_read(root, parts, file_parts, max_bytes)
    return {"path": os.path.join(root, *parts, *file_parts), "sha256": hashlib.sha256(data).hexdigest(), "contentBase64": base64.b64encode(data).decode("ascii")}


def secure_write(request: dict) -> dict:
    root = request.get("root")
    if not isinstance(root, str) or not os.path.isabs(root):
        raise SecureFsError("INVALID_PATH", "root must be absolute")
    parts = _parts(request.get("directoryParts", []), "directoryParts")
    subdirectory = request.get("subdirectory")
    if subdirectory is not None:
        subdirectory = _single(subdirectory, "subdirectory")
    name = _single(request.get("fileName"), "fileName")
    max_bytes = _limit(request.get("maxBytes"), 8 * 1024 * 1024)
    try:
        data = base64.b64decode(request.get("contentBase64", ""), validate=True)
    except Exception as exc:
        raise SecureFsError("INVALID_CONTENT", "contentBase64 is invalid") from exc
    if len(data) > max_bytes:
        raise SecureFsError("INPUT_TOO_LARGE", "content exceeds maxBytes")
    if os.name == "nt":
        path = _win_write_path(root, parts, subdirectory, name, data)
    else:
        path = _posix_write(root, parts, subdirectory, name, data)
    return {"path": path, "sha256": hashlib.sha256(data).hexdigest()}


def secure_copy(request: dict) -> dict:
    source = request.get("source")
    if not isinstance(source, str) or not os.path.isabs(source):
        raise SecureFsError("INVALID_PATH", "source must be absolute")
    root = request.get("root")
    if not isinstance(root, str) or not os.path.isabs(root):
        raise SecureFsError("INVALID_PATH", "root must be absolute")
    parts = _parts(request.get("directoryParts", []), "directoryParts")
    subdirectory = request.get("subdirectory")
    if subdirectory is not None:
        subdirectory = _single(subdirectory, "subdirectory")
    name = _single(request.get("fileName"), "fileName")
    max_bytes = _limit(request.get("maxBytes"))
    expected = request.get("expectedSha256")
    if expected is not None and (not isinstance(expected, str) or len(expected) != 64 or any(char not in "0123456789abcdef" for char in expected)):
        raise SecureFsError("INVALID_HASH", "expectedSha256 must be lowercase SHA-256")
    if os.name == "nt":
        path, digest = _win_copy(source, root, parts, subdirectory, name, max_bytes, expected)
    else:
        path, digest = _posix_copy(source, root, parts, subdirectory, name, max_bytes, expected)
    return {"path": path, "sha256": digest}


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(16 * 1024 * 1024 + 1)
        if len(raw) > 16 * 1024 * 1024:
            raise SecureFsError("REQUEST_TOO_LARGE", "request exceeds 16MiB")
        request = json.loads(raw.decode("utf-8"))
        if not isinstance(request, dict):
            raise SecureFsError("INVALID_REQUEST", "request must be an object")
        operation = request.get("operation")
        if operation == "read":
            result = secure_read(request)
        elif operation == "write":
            result = secure_write(request)
        elif operation == "copy":
            result = secure_copy(request)
        else:
            raise SecureFsError("INVALID_OPERATION", "unsupported operation")
        print(json.dumps({"ok": True, **result}), flush=True)
        return 0
    except SecureFsError as exc:
        print(json.dumps({"ok": False, "error": {"code": exc.code, "message": str(exc)[:1000]}}), flush=True)
        return 2
    except Exception as exc:
        print(json.dumps({"ok": False, "error": {"code": "INTERNAL", "message": str(exc)[:1000]}}), flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
