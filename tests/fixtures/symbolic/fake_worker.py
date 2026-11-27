#!/usr/bin/env python3
"""Deterministic Python worker for TypeScript process-contract tests only."""
import hashlib
import json
import sys
import time
from pathlib import Path

request = json.loads(sys.stdin.buffer.read())
mode = request["binaryPath"]
if mode == "timeout" or mode == "cancel":
    time.sleep(10)
if mode == "large":
    sys.stdout.write("x" * 3_000_000)
    raise SystemExit(0)
if mode == "nonzero":
    print("intentional worker failure", file=sys.stderr)
    raise SystemExit(7)
if mode == "invalid-json":
    print("not json")
    raise SystemExit(0)
if mode == "invalid-schema":
    print(json.dumps({"schemaVersion": 1, "status": "completed"}))
    raise SystemExit(0)
worker_sha = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
result = {
    "schemaVersion": 1,
    "status": "completed",
    "paths": [{
        "id": "fake-target-1",
        "targetAddress": "0x401000",
        "addressHistory": ["0x401000", "0x401020"],
        "constraints": [{"expression": "stdin == 1", "address": "0x401020"}],
        "satisfiable": True,
        "reachedTarget": True,
        "statesExplored": 2,
    }],
    "solvedInputs": [{
        "pathId": "fake-target-1",
        "inputHex": "01",
        "inputBase64": "AQ==",
        "execution": {"exitCode": 0, "stdout": "FAKE_ONLY\n", "stderr": "", "verified": True, "timedOut": False},
    }],
    "solver": {"name": "fake-test-worker", "version": "0"},
    "stats": {"statesExplored": 2, "pathsFound": 1, "elapsedMs": 1},
    "limitations": ["Test-double worker output is not real symbolic execution evidence."],
    "provenance": {
        "binaryPath": mode,
        "binarySha256": "1" * 64,
        "workerSha256": worker_sha,
        "pythonVersion": "test-double",
        "angrVersion": "test-double",
        "requestedAt": "2026-01-01T00:00:00+00:00",
        "completedAt": "2026-01-01T00:00:01+00:00",
    },
}
if mode == "mismatched":
    result["provenance"]["binaryPath"] = "different-binary"
print(json.dumps(result))
