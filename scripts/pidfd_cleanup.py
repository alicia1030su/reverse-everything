#!/usr/bin/env python3
"""Safely kill explicitly identified Linux processes using pidfds.

Input: {"targets":[{"pid":123,"pgid":123,"startTicks":456}]}
The PID is opened first, then its identity is rechecked before SIGKILL is sent
through the pidfd. This avoids PID/PGID reuse races inherent in kill(pid).
"""
from __future__ import annotations

import json
import os
import signal
import sys
from pathlib import Path


def proc_stat(pid: int) -> tuple[int, int] | None:
    try:
        text = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    fields = text[text.rfind(")") + 2 :].split()
    return int(fields[2]), int(fields[19])  # pgid, start_ticks


def main() -> int:
    try:
        request = json.loads(sys.stdin.buffer.read(65_537))
        if len(sys.stdin.buffer.read(1)):
            raise ValueError("request too large")
        if not isinstance(request, dict):
            raise ValueError("request must be an object")
        targets = request.get("targets")
        if not isinstance(targets, list) or len(targets) > 4096:
            raise ValueError("invalid targets")
    except Exception as exc:
        print(json.dumps({"results": [], "error": str(exc)[:500]}), flush=True)
        return 2

    results = []
    for target in targets:
        if not isinstance(target, dict):
            results.append({"pid": None, "status": "invalid"})
            continue
        pid = target.get("pid")
        pgid = target.get("pgid")
        start_ticks = target.get("startTicks")
        if not all(isinstance(value, int) and value > 0 for value in (pid, pgid, start_ticks)):
            results.append({"pid": pid, "status": "invalid"})
            continue
        try:
            fd = os.pidfd_open(pid, 0)
        except ProcessLookupError:
            results.append({"pid": pid, "status": "gone"})
            continue
        except OSError as exc:
            results.append({"pid": pid, "status": "error", "error": str(exc)[:500]})
            continue
        try:
            current = proc_stat(pid)
            if current is None:
                results.append({"pid": pid, "status": "gone"})
            elif current != (pgid, start_ticks):
                results.append({"pid": pid, "status": "mismatch"})
            else:
                signal.pidfd_send_signal(fd, signal.SIGKILL, None, 0)
                results.append({"pid": pid, "status": "killed"})
        except ProcessLookupError:
            results.append({"pid": pid, "status": "gone"})
        except Exception as exc:
            results.append({"pid": pid, "status": "error", "error": str(exc)[:500]})
        finally:
            os.close(fd)
    print(json.dumps({"results": results}), flush=True)
    return 0 if all(item["status"] in ("killed", "gone") for item in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
