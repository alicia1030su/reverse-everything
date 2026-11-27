#!/usr/bin/env python3
"""Bounded angr/Z3 worker. Reads one JSON request on stdin, writes one JSON result.

Only explicitly authorized local binaries are analyzed and executed. No shell is used.
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

LIMITS = {
    "timeoutMs": 600_000,
    "maxPaths": 256,
    "maxStates": 100_000,
    "sizeBytes": 1_048_576,
}
MAX_CONSTRAINT_CHARS = 4_000
MAX_CONSTRAINTS = 512
MAX_HISTORY = 4_096
_ACTIVE_NATIVE_PROC: subprocess.Popen | None = None


def install_native_signal_handlers() -> None:
    """Ensure a terminated worker cannot leave its separate native process group behind."""
    if os.name != "posix":
        return

    def terminate(signum, _frame):
        proc = _ACTIVE_NATIVE_PROC
        if proc is not None:
            try:
                os.killpg(proc.pid, 9)
            except ProcessLookupError:
                pass
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, terminate)


class RequestError(ValueError):
    pass


def bounded_request(raw: dict) -> dict:
    if raw.get("authorized") is not True:
        raise RequestError("authorized: true is required")
    binary = raw.get("binaryPath")
    if not isinstance(binary, str) or not binary or len(binary) > 4_096:
        raise RequestError("invalid binaryPath")
    target = raw.get("target")
    if not isinstance(target, dict):
        raise RequestError("invalid target")
    function, address = target.get("function"), target.get("address")
    if function is None and address is None:
        raise RequestError("target function or address is required")
    if function is not None and (not isinstance(function, str) or not function or len(function) > 512):
        raise RequestError("invalid target function")
    if address is not None:
        if not isinstance(address, str) or not address.startswith(("0x", "0X")):
            raise RequestError("invalid target address")
        int(address, 16)
    output = target.get("expectedOutput")
    if output is not None and (not isinstance(output, str) or len(output) > 65_536):
        raise RequestError("invalid expectedOutput")
    spec = raw.get("input")
    if not isinstance(spec, dict) or spec.get("source") != "stdin":
        raise RequestError("only stdin input is supported")
    size = spec.get("sizeBytes")
    if not isinstance(size, int) or isinstance(size, bool) or not 1 <= size <= LIMITS["sizeBytes"]:
        raise RequestError("invalid input size")
    concrete = spec.get("inputBytes", "")
    if not isinstance(concrete, str) or len(concrete) > size * 2 or len(concrete) % 2:
        raise RequestError("invalid concrete input")
    try:
        bytes.fromhex(concrete)
    except ValueError as exc:
        raise RequestError("invalid concrete input") from exc
    for name in ("timeoutMs", "maxPaths", "maxStates"):
        value = raw.get(name, {"timeoutMs": 30_000, "maxPaths": 32, "maxStates": 10_000}[name])
        if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= LIMITS[name]:
            raise RequestError(f"invalid {name}")
        raw[name] = value
    entry = raw.get("entry", {})
    if not isinstance(entry, dict):
        raise RequestError("invalid entry")
    for key in ("function", "address"):
        value = entry.get(key)
        if value is not None and (not isinstance(value, str) or not value or len(value) > 512):
            raise RequestError("invalid entry")
    if "address" in entry:
        int(entry["address"], 16)
    raw["input"] = {"source": "stdin", "sizeBytes": size, "inputBytes": concrete.lower()}
    raw["target"] = target
    raw["entry"] = entry
    return raw


def digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(block)
    return sha.hexdigest()


def constrain_concrete(state, symbolic_bytes: list, concrete: bytes) -> None:
    for index, byte in enumerate(symbolic_bytes):
        if index < len(concrete):
            state.solver.add(byte == concrete[index])


def symbol_address(project, name: str) -> int | None:
    symbol = project.loader.find_symbol(name)
    return symbol.rebased_addr if symbol is not None else None


def bounded_constraint(expression: str) -> str:
    if len(expression) <= MAX_CONSTRAINT_CHARS:
        return expression
    marker = "...[truncated]"
    return expression[:MAX_CONSTRAINT_CHARS - len(marker)] + marker


def posix_group_alive(group_id: int) -> bool:
    if sys.platform.startswith("linux"):
        try:
            for entry in os.listdir("/proc"):
                if not entry.isdigit():
                    continue
                try:
                    stat = Path(f"/proc/{entry}/stat").read_text(encoding="utf-8")
                    fields = stat[stat.rfind(")") + 2:].split()
                    if fields and fields[0] != "Z" and int(fields[2]) == group_id:
                        return True
                except (OSError, ValueError, IndexError):
                    continue
            return False
        except OSError:
            pass
    try:
        os.killpg(group_id, 0)
        return True
    except ProcessLookupError:
        return False


def kill_process_tree(proc: subprocess.Popen) -> None:
    """Kill the native sample and its descendants, then reap the direct child."""
    if os.name == "posix":
        try:
            os.killpg(proc.pid, 9)
        except ProcessLookupError:
            pass
    else:
        try:
            subprocess.run(["taskkill", "/pid", str(proc.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3, check=False)
        except (OSError, subprocess.TimeoutExpired):
            try:
                proc.kill()
            except ProcessLookupError:
                pass
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=3)
    if os.name == "posix":
        deadline = time.monotonic() + 2
        while posix_group_alive(proc.pid) and time.monotonic() < deadline:
            time.sleep(0.02)


def execute_binary(binary: str, data: bytes, expected: str | None, timeout: float, args: list[str] | None = None) -> dict:
    """Execute with bounded streaming capture; output overflow kills the process tree."""
    output_limit = 65_536
    overflow = threading.Event()
    with tempfile.NamedTemporaryFile(prefix="symbolic-input-", delete=False) as stream:
        stream.write(data)
        name = stream.name
    proc = None
    try:
        kwargs = {"start_new_session": True} if os.name == "posix" else {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
        with open(name, "rb") as input_stream:
            proc = subprocess.Popen([binary, *(args or [])], stdin=input_stream, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
        global _ACTIVE_NATIVE_PROC
        _ACTIVE_NATIVE_PROC = proc
        captured = {"stdout": bytearray(), "stderr": bytearray()}
        truncated = {"stdout": False, "stderr": False}

        def pump(stream_name: str, stream) -> None:
            stream_object = captured[stream_name]
            while True:
                chunk = stream.read(8192)
                if not chunk:
                    break
                remaining = output_limit - len(stream_object)
                if len(chunk) > remaining:
                    stream_object.extend(chunk[:max(0, remaining)])
                    truncated[stream_name] = True
                    overflow.set()
                    kill_process_tree(proc)
                    break
                stream_object.extend(chunk)

        readers = [threading.Thread(target=pump, args=(stream_name, getattr(proc, stream_name)), daemon=True) for stream_name in ("stdout", "stderr")]
        for reader in readers:
            reader.start()
        timed_out = False
        try:
            proc.wait(timeout=max(0.01, timeout))
        except subprocess.TimeoutExpired:
            timed_out = True
            kill_process_tree(proc)
        if os.name == "posix":
            # The direct child may have exited while descendants still hold inherited pipes.
            try:
                os.killpg(proc.pid, 9)
            except ProcessLookupError:
                pass
        for reader in readers:
            reader.join(timeout=3)
        stdout = bytes(captured["stdout"])
        stderr = bytes(captured["stderr"])
        output_exceeded = overflow.is_set()
        return {
            "exitCode": proc.returncode,
            "stdout": stdout.decode("utf-8", errors="replace"),
            "stderr": stderr.decode("utf-8", errors="replace"),
            "stdoutTruncated": truncated["stdout"],
            "stderrTruncated": truncated["stderr"],
            "outputLimitExceeded": output_exceeded,
            "verified": not timed_out and not output_exceeded and proc.returncode == 0 and expected is not None and expected.encode("utf-8") in stdout,
            "timedOut": timed_out,
        }
    finally:
        if proc is not None and proc.poll() is None:
            kill_process_tree(proc)
        if proc is not None and _ACTIVE_NATIVE_PROC is proc:
            _ACTIVE_NATIVE_PROC = None
        Path(name).unlink(missing_ok=True)


def analyze(request: dict, worker_sha256: str, started_at: str, started: float) -> dict:
    import angr
    import claripy
    import z3

    binary = Path(request["binaryPath"]).resolve(strict=True)
    if not binary.is_file():
        raise RequestError("binaryPath is not a regular file")
    project = angr.Project(str(binary), auto_load_libs=False)
    if project.arch.name.lower() != "amd64":
        raise RequestError("Wave 2 supports amd64 binaries only")
    target = request["target"]
    entry_spec = request["entry"]
    entry_symbol = entry_spec.get("function")
    if entry_spec.get("address"):
        entry = int(entry_spec["address"], 16)
    elif entry_symbol:
        entry = symbol_address(project, entry_symbol)
        if entry is None:
            fn = project.kb.functions.function(name=entry_symbol)
            if fn is None:
                raise RequestError(f"entry function not found: {entry_symbol}")
            entry = fn.addr
    else:
        entry = symbol_address(project, "main")
        if entry is None:
            fn = project.kb.functions.function(name="main")
            entry = fn.addr if fn is not None else project.entry

    target_address = int(target["address"], 16) if target.get("address") else None
    target_function = None
    if target.get("function"):
        matches = list(project.kb.functions.get_by_name(target["function"]))
        if len(matches) == 1:
            target_function = matches[0]
        else:
            resolved = symbol_address(project, target["function"])
            if resolved is None:
                raise RequestError(f"target function must resolve uniquely: {target['function']}")
            target_function = project.kb.functions.function(addr=resolved, create=True)
            if target_function is None:
                raise RequestError(f"target function could not be created: {target['function']}")
        if target_address is None:
            target_address = target_function.addr
        elif target_address != target_function.addr:
            raise RequestError("target address does not match the resolved target function")

    def reached_target(state) -> bool:
        if state.addr == target_address:
            return True
        if target_function is not None:
            frame = state.callstack.func_address
            return frame == target_function.addr
        return False

    deadline = started + request["timeoutMs"] / 1000
    if time.monotonic() >= deadline:
        raise TimeoutError("symbolic analysis timed out during binary loading")
    size = request["input"]["sizeBytes"]
    symbolic_bytes = [claripy.BVS(f"stdin_{index}", 8) for index in range(size)]
    concrete = bytes.fromhex(request["input"]["inputBytes"])
    stdin_file = angr.SimFileStream(name="stdin", content=claripy.Concat(*symbolic_bytes), has_end=True)
    state = project.factory.call_state(entry, stdin=stdin_file)
    # argv contents are concrete, not symbolic; supply a valid argv[0] for amd64 main.
    argv = state.regs.sp - 0x2000
    state.regs.rdi = 1
    state.regs.rsi = argv
    binary_string = str(binary).encode("utf-8") + b"\x00"
    string_address = argv - ((len(binary_string) + 15) & ~15)
    state.memory.store(argv, claripy.BVV(string_address, project.arch.bits), endness=project.arch.memory_endness)
    state.memory.store(argv + project.arch.bytes, claripy.BVV(0, project.arch.bits), endness=project.arch.memory_endness)
    state.memory.store(string_address, claripy.BVV(int.from_bytes(binary_string, "little"), len(binary_string) * 8), endness=project.arch.memory_endness)
    constrain_concrete(state, symbolic_bytes, concrete)
    manager = project.factory.simulation_manager(state)
    paths: list[dict] = []
    solved_inputs: list[dict] = []
    states_explored = 0
    truncated = False
    max_paths = request["maxPaths"]
    max_states = request["maxStates"]

    def record(found_state, reached: bool, path_id: str) -> None:
        constraints = []
        constraint_chars = 0
        for constraint in list(found_state.solver.constraints)[:MAX_CONSTRAINTS]:
            expression = bounded_constraint(str(constraint))
            if constraint_chars + len(expression) > 65_536:
                break
            constraint_chars += len(expression)
            constraints.append({"expression": expression})
        history = [hex(item) for item in list(found_state.history.bbl_addrs)[:MAX_HISTORY]]
        satisfiable = found_state.solver.satisfiable()
        paths.append({
            "id": path_id,
            "targetAddress": hex(target_address),
            "addressHistory": history,
            "constraints": constraints,
            "satisfiable": satisfiable,
            "reachedTarget": reached,
            "statesExplored": states_explored,
        })
        if reached and satisfiable and len(solved_inputs) < max_paths:
            model = found_state.solver.eval(claripy.Concat(*symbolic_bytes), cast_to=bytes)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("symbolic solver timed out")
            execution = execute_binary(str(binary), model, target.get("expectedOutput"), remaining)
            solved_inputs.append({
                "pathId": path_id,
                "inputHex": model.hex(),
                "inputBase64": __import__("base64").b64encode(model).decode("ascii"),
                "execution": execution,
            })

    while manager.active:
        if time.monotonic() >= deadline:
            raise TimeoutError("symbolic analysis deadline exceeded")
        if states_explored >= max_states or len(manager.active) + states_explored > max_states:
            truncated = True
            break
        manager.step(find=reached_target)
        states_explored += len(manager.active) + len(manager.found) + len(manager.deadended)
        if time.monotonic() >= deadline:
            raise TimeoutError("symbolic analysis deadline exceeded")
        newly_found = manager.found
        manager.found = []
        for found_state in newly_found:
            if len(paths) >= max_paths:
                truncated = True
                break
            record(found_state, True, f"path-target-{len(solved_inputs) + 1}")
        if truncated:
            break
    if not manager.active:
        for found_state in manager.deadended:
            if len(paths) >= max_paths:
                truncated = True
                break
            record(found_state, False, f"path-deadend-{len(paths) + 1}")
    limitations = [
        "Only stdin-backed symbolic input is supported; filesystem, network, environment and argv contents are not symbolic.",
        "Target reachability is established at a function call/address; native execution verifies expected stdout rather than instruction-level coverage.",
        "Auto-loading shared libraries is disabled; SimProcedures may abstract library behavior.",
        "Wave 2 entry setup supports amd64 System V arguments only.",
    ]
    if len(concrete) < size:
        limitations.append("Unspecified input bytes are unconstrained and may produce arbitrary models.")
    if truncated or len(paths) >= max_paths:
        limitations.append("Path/state budget was reached; exploration is not exhaustive.")
    if any(not item["execution"]["verified"] for item in solved_inputs):
        limitations.append("One or more solved inputs did not reproduce the expected output during native execution.")
    return {
        "schemaVersion": 1,
        "status": "partial" if truncated or len(paths) >= max_paths or any(not item["execution"]["verified"] for item in solved_inputs) else "completed",
        "paths": paths,
        "solvedInputs": solved_inputs,
        "solver": {"name": "angr/claripy/Z3", "version": z3.get_version_string()},
        "stats": {"statesExplored": states_explored, "pathsFound": len(paths), "elapsedMs": round((time.monotonic() - started) * 1000)},
        "limitations": limitations,
        "provenance": {
            "binaryPath": request["binaryPath"],
            "binarySha256": digest(binary),
            "workerSha256": worker_sha256,
            "pythonVersion": platform.python_version(),
            "angrVersion": angr.__version__,
            "requestedAt": started_at,
            "completedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        },
    }


def main() -> int:
    install_native_signal_handlers()
    started_at = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
    started = time.monotonic()
    worker_sha256 = digest(Path(__file__).resolve())
    request = None
    raw_binary_path = ""
    try:
        raw = sys.stdin.buffer.read(16_385)
        if len(raw) > 16_384:
            raise RequestError("request exceeds 16384 bytes")
        decoded = json.loads(raw)
        if isinstance(decoded, dict) and isinstance(decoded.get("binaryPath"), str):
            raw_binary_path = decoded["binaryPath"][:4_096]
        request = bounded_request(decoded)
        result = analyze(request, worker_sha256, started_at, started)
    except TimeoutError as exc:
        result = {
            "schemaVersion": 1, "status": "timeout", "paths": [], "solvedInputs": [],
            "solver": {"name": "angr/Z3", "version": "unavailable"},
            "stats": {"statesExplored": 0, "pathsFound": 0, "elapsedMs": round((time.monotonic() - started) * 1000)},
            "limitations": ["The worker hit its internal deadline before producing path evidence."],
            "provenance": {
                "binaryPath": request["binaryPath"] if request else raw_binary_path, "binarySha256": "0" * 64,
                "workerSha256": worker_sha256, "pythonVersion": platform.python_version(), "angrVersion": "unavailable",
                "requestedAt": started_at,
                "completedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
            },
            "error": str(exc),
        }
    except Exception as exc:  # Emit a bounded, machine-readable failure instead of a traceback.
        result = {
            "schemaVersion": 1, "status": "error", "paths": [], "solvedInputs": [],
            "solver": {"name": "angr/Z3", "version": "unavailable"},
            "stats": {"statesExplored": 0, "pathsFound": 0, "elapsedMs": round((time.monotonic() - started) * 1000)},
            "limitations": ["No completed symbolic path evidence is claimed."],
            "provenance": {
                "binaryPath": request["binaryPath"] if request else raw_binary_path, "binarySha256": "0" * 64,
                "workerSha256": worker_sha256, "pythonVersion": platform.python_version(), "angrVersion": "unavailable",
                "requestedAt": started_at,
                "completedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
            },
            "error": f"{type(exc).__name__}: {exc}"[:16_000],
        }
    encoded = json.dumps(result, separators=(",", ":")).encode("utf-8")
    if len(encoded) > 2_097_152:
        # A completed bounded response is preferable to silently truncating JSON.
        result["status"] = "partial"
        result["paths"] = []
        result["solvedInputs"] = []
        result["stats"]["pathsFound"] = 0
        result["limitations"].append("Worker response exceeded its budget and path records were omitted.")
        result["error"] = "worker response budget exceeded"
        encoded = json.dumps(result, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(encoded + b"\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
