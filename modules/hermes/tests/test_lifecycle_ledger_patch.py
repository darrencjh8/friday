"""Issue #650: the startup state.db quick_check must not block the gateway.

The check lives in the upstream image (gateway/lifecycle_ledger.py), so this repo
patches it at build time (patches/patch-lifecycle-ledger.py). These tests apply
that patch to a verbatim copy of upstream v0.22.2 and drive it.
"""

import importlib.util
import json
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PATCH_PATH = HERE.parent / "patches" / "patch-lifecycle-ledger.py"
FIXTURE = HERE / "fixtures" / "upstream_lifecycle_ledger_v0.22.2.py"


def load_patch_module():
    spec = importlib.util.spec_from_file_location("patch_lifecycle_ledger", PATCH_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class LifecycleLedgerPatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        (self.home / "state").mkdir()
        (self.home / "logs").mkdir()
        patched = load_patch_module().patch_source(FIXTURE.read_text())
        # Stubs for the two hermes modules the ledger imports lazily.
        const = types.ModuleType("hermes_constants")
        const.get_hermes_home = lambda: self.home
        const.get_process_hermes_home = lambda: self.home
        const.mkdir_under_hermes_home = lambda p: Path(p).mkdir(parents=True, exist_ok=True)
        wd = types.ModuleType("hermes_startup_watchdog")
        wd.report_startup_progress = lambda *a, **k: None
        self._saved = {k: sys.modules.get(k) for k in ("hermes_constants", "hermes_startup_watchdog")}
        sys.modules["hermes_constants"] = const
        sys.modules["hermes_startup_watchdog"] = wd
        self.addCleanup(self._restore)
        self.ledger = types.ModuleType("ledger_under_test")
        exec(compile(patched, "ledger_under_test", "exec"), self.ledger.__dict__)
        # Previous life died uncleanly: sentinel still says "running".
        (self.home / "state" / "gateway.lifecycle.json").write_text(
            json.dumps({"phase": "running", "pid": 999999, "start_time": 1.0})
        )

    def _restore(self):
        for k, v in self._saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v

    def _diag(self):
        path = self.home / "logs" / "gateway-exit-diag.log"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_record_startup_does_not_block_on_slow_integrity_check(self):
        release, entered = threading.Event(), threading.Event()

        def slow_check(home=None):
            entered.set()
            release.wait(30)
            return "ok"

        self.ledger.check_state_db_integrity = slow_check
        t0 = time.monotonic()
        evidence = self.ledger.record_startup(self.home)
        elapsed = time.monotonic() - t0
        try:
            self.assertIsNotNone(evidence, "fixture must look like an unclean exit")
            self.assertLess(elapsed, 3.0, "record_startup blocked on the integrity check")
            # Not scanned yet must never be recorded as healthy.
            self.assertEqual(evidence["state_db_integrity"], "pending")
            first = self._diag()[0]
            self.assertEqual(first["tag"], "gateway.previous_unclean_exit")
            self.assertEqual(first["state_db_integrity"], "pending")
            self.assertTrue(entered.wait(5), "background check never started")
        finally:
            release.set()
        self._join_checker()
        verdicts = [r for r in self._diag() if r["tag"] == "gateway.state_db_integrity_check"]
        self.assertEqual(len(verdicts), 1)
        self.assertEqual(verdicts[0]["state_db_integrity"], "ok")

    def test_failed_background_check_is_recorded_not_ok(self):
        self.ledger.check_state_db_integrity = lambda home=None: "*** in database main ***"
        with self.assertLogs(self.ledger.logger, level="ERROR") as logs:
            self.ledger.record_startup(self.home)
            self._join_checker()
        self.assertTrue(any("FAILED integrity check" in m for m in logs.output))
        verdicts = [r for r in self._diag() if r["tag"] == "gateway.state_db_integrity_check"]
        self.assertEqual(verdicts[0]["state_db_integrity"], "*** in database main ***")

    def test_check_that_raises_is_recorded_as_failed(self):
        def boom(home=None):
            raise RuntimeError("disk gone")

        self.ledger.check_state_db_integrity = boom
        self.ledger.record_startup(self.home)
        self._join_checker()
        verdicts = [r for r in self._diag() if r["tag"] == "gateway.state_db_integrity_check"]
        self.assertTrue(verdicts[0]["state_db_integrity"].startswith("check-failed"))

    def _join_checker(self):
        for t in threading.enumerate():
            if t.name == "state-db-integrity-check":
                t.join(10)
                self.assertFalse(t.is_alive())

    def test_patch_is_idempotent_and_fails_loudly_on_drift(self):
        mod = load_patch_module()
        once = mod.patch_source(FIXTURE.read_text())
        self.assertEqual(mod.patch_source(once), once)
        with self.assertRaises(mod.PatchError):
            mod.patch_source("def _report_unclean_exit(evidence, home):\n    pass\n")


if __name__ == "__main__":
    unittest.main()
