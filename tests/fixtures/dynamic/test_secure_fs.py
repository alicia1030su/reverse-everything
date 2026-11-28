import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("secure_fs", ROOT / "scripts" / "secure_fs.py")
assert SPEC and SPEC.loader
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


def make_junction(link: Path, target: Path) -> None:
    if os.name == "nt":
        subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], check=True, capture_output=True)
    else:
        os.symlink(target, link, target_is_directory=True)


class SecureFsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="secure-fs-test-")
        self.root = Path(self.temp.name)
        self.work = self.root / "work"
        self.work.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def test_write_read_copy_round_trip(self):
        written = helper.secure_write({
            "operation": "write", "root": str(self.root), "directoryParts": ["work"],
            "subdirectory": "reports", "fileName": "report.json", "contentBase64": "aGVsbG8=", "maxBytes": 1024,
        })
        self.assertEqual(written["sha256"], "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
        read = helper.secure_read({
            "operation": "read", "root": str(self.root), "directoryParts": ["work"],
            "fileParts": ["reports", "report.json"], "maxBytes": 1024,
        })
        self.assertEqual(read["contentBase64"], "aGVsbG8=")
        copied = helper.secure_copy({
            "operation": "copy", "source": written["path"], "root": str(self.root), "directoryParts": ["work"],
            "fileName": "copy.json", "maxBytes": 1024, "expectedSha256": written["sha256"],
        })
        self.assertEqual(copied["sha256"], written["sha256"])

    def test_rejects_linked_report_directory(self):
        outside = self.root / "outside"
        outside.mkdir()
        make_junction(self.work / "reports", outside)
        with self.assertRaises(helper.SecureFsError) as caught:
            helper.secure_write({
                "operation": "write", "root": str(self.root), "directoryParts": ["work"],
                "subdirectory": "reports", "fileName": "report.json", "contentBase64": "aGVsbG8=", "maxBytes": 1024,
            })
        self.assertEqual(caught.exception.code, "PATH_FORBIDDEN")
        self.assertEqual(list(outside.iterdir()), [])

    def test_open_directory_handle_survives_parent_replacement(self):
        reports = self.work / "reports"
        reports.mkdir()
        outside = self.root / "outside"
        outside.mkdir()
        if os.name == "nt":
            directory, opened = helper._win_directory_chain(str(self.root), ["work"], "reports")
        else:
            directory, opened = helper._posix_directory_chain(str(self.root), ["work"], "reports")
        try:
            reports.rename(self.work / "reports-original")
            make_junction(reports, outside)
            if os.name == "nt":
                handle = helper._nt_create_relative(directory, "race.json", directory=False, create=True, write=True)
                try:
                    helper._win_write(handle, b"safe")
                finally:
                    helper._close_win(handle)
            else:
                fd = os.open("race.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory)
                try:
                    helper._write_all(fd, b"safe")
                finally:
                    os.close(fd)
        finally:
            if os.name == "nt":
                for handle in reversed(opened):
                    helper._close_win(handle)
            else:
                for fd in reversed(opened):
                    os.close(fd)
        self.assertEqual(list(outside.iterdir()), [])
        self.assertEqual((self.work / "reports-original" / "race.json").read_bytes(), b"safe")

    def test_rejects_hard_linked_input(self):
        source = self.root / "source.json"
        source.write_bytes(b"safe")
        linked = self.work / "linked.json"
        os.link(source, linked)
        with self.assertRaises(helper.SecureFsError) as caught:
            helper.secure_read({
                "operation": "read", "root": str(self.root), "directoryParts": ["work"],
                "fileParts": ["linked.json"], "maxBytes": 1024,
            })
        self.assertEqual(caught.exception.code, "PATH_FORBIDDEN")


if __name__ == "__main__":
    unittest.main()
