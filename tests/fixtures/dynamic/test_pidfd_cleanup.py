import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("pidfd_cleanup", ROOT / "scripts" / "pidfd_cleanup.py")
assert SPEC and SPEC.loader
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


class PidfdCleanupTests(unittest.TestCase):
    def invoke(self, start_ticks: int):
        request = json.dumps({"targets": [{"pid": 100, "pgid": 100, "startTicks": start_ticks}]}).encode()
        stdin = io.TextIOWrapper(io.BytesIO(request), encoding="utf-8")
        output = io.StringIO()
        with (
            patch.object(sys, "stdin", stdin),
            contextlib.redirect_stdout(output),
            patch.object(helper.os, "pidfd_open", return_value=77, create=True),
            patch.object(helper.os, "close"),
            patch.object(helper, "proc_stat", return_value=(200, 456)),
            patch.object(helper.signal, "SIGKILL", 9, create=True),
            patch.object(helper.signal, "pidfd_send_signal", create=True) as send,
        ):
            code = helper.main()
        return code, json.loads(output.getvalue()), send

    def test_pidfd_identity_survives_a_post_open_pgid_change(self):
        code, result, send = self.invoke(456)
        self.assertEqual(code, 0)
        self.assertEqual(result["results"], [{"pid": 100, "status": "killed"}])
        send.assert_called_once_with(77, 9, None, 0)

    def test_pidfd_identity_still_rejects_a_reused_pid(self):
        code, result, send = self.invoke(455)
        self.assertEqual(code, 1)
        self.assertEqual(result["results"], [{"pid": 100, "status": "mismatch"}])
        send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
