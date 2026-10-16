"""Auto-prune must also enforce a session-count cap and a state.db size cap (#650).

Applies patches/patch-session-caps.py to a verbatim copy of upstream v0.22.2
hermes_state_maintenance.py, checks the source wiring, and runs the injected cap helpers
against an in-memory stand-in for SessionDB.
"""

import importlib.util
import logging
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PATCH_PATH = HERE.parent / "patches" / "patch-session-caps.py"
FIXTURE = HERE / "fixtures" / "upstream_hermes_state_maintenance_v0.22.2.py"
CONFIG = HERE.parent / "config.yaml"


def load_patch_module():
    spec = importlib.util.spec_from_file_location("patch_session_caps", PATCH_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def helpers():
    ns = {"logger": logging.getLogger("test_session_caps")}
    exec(load_patch_module().HELPERS, ns)
    return ns


class FakeDB:
    """Ended sessions with ascending last_active; each one occupies `page_per_session` pages."""

    PAGE = 4096

    def __init__(self, ended, open_rows=0, pinned=(), page_per_session=10, guarded=()):
        self.rows = {f"s{i}": {"last_active": float(i), "pinned": f"s{i}" in pinned}
                     for i in range(ended)}
        self.open_rows = open_rows
        self.page_per_session = page_per_session
        self.guarded = set(guarded)
        self.freelist = 0
        self.deleted = []

    def _read_one(self, sql, params=()):
        assert sql == "SELECT COUNT(*) FROM sessions"
        return (len(self.rows) + self.open_rows,)

    def list_prune_candidates(self, older_than_days=None):
        assert older_than_days is None
        return [{"id": k, "last_active": v["last_active"]}
                for k, v in sorted(self.rows.items(), key=lambda kv: kv[1]["last_active"])
                if not v["pinned"]]

    def prune_sessions(self, older_than_days=None, sessions_dir=None,
                       exclude_active_write_guards=False, last_active_before=None):
        assert older_than_days is None and exclude_active_write_guards
        gone = [k for k, v in self.rows.items() if v["last_active"] < last_active_before
                and not v["pinned"] and k not in self.guarded]
        for k in gone:
            del self.rows[k]
            self.freelist += self.page_per_session
        self.deleted.extend(gone)
        return len(gone)

    def _page_pragmas(self, names, fail_msg):
        assert names == ("page_count", "freelist_count", "page_size")
        pages = (len(self.rows) + self.open_rows) * self.page_per_session + self.freelist
        return [pages, self.freelist, self.PAGE]


class SessionCapsTest(unittest.TestCase):
    def test_count_cap_deletes_oldest_ended_down_to_cap(self):
        db = FakeDB(ended=10, open_rows=2)
        removed = helpers()["_openclaw_enforce_caps"](db, None, limits=(8, 0.0))
        self.assertEqual(removed, 4)
        self.assertEqual(db.deleted, ["s0", "s1", "s2", "s3"])

    def test_count_cap_never_touches_pinned_or_open(self):
        db = FakeDB(ended=3, open_rows=5, pinned={"s0", "s1"})
        removed = helpers()["_openclaw_enforce_caps"](db, None, limits=(1, 0.0))
        self.assertEqual(db.deleted, ["s2"])
        self.assertEqual(removed, 1)

    def test_size_cap_deletes_oldest_until_used_bytes_fit(self):
        db = FakeDB(ended=20, page_per_session=256)  # 1 MiB per session
        removed = helpers()["_openclaw_enforce_caps"](db, None, limits=(0, 5.0))
        self.assertEqual(len(db.rows), 5)
        self.assertEqual(removed, 15)
        self.assertEqual(db.deleted[0], "s0")

    def test_both_caps_take_the_tighter_one(self):
        db = FakeDB(ended=20, page_per_session=256)
        helpers()["_openclaw_enforce_caps"](db, None, limits=(15, 3.0))
        self.assertEqual(len(db.rows), 3)

    def test_guarded_oldest_rows_do_not_stall_the_caps(self):
        db = FakeDB(ended=10, guarded={"s0", "s1"})
        helpers()["_openclaw_enforce_caps"](db, None, limits=(5, 0.0))
        self.assertEqual(len(db.rows), 5)
        self.assertIn("s0", db.rows)

    def test_zero_limits_are_disabled(self):
        db = FakeDB(ended=10)
        self.assertEqual(helpers()["_openclaw_enforce_caps"](db, None, limits=(0, 0.0)), 0)
        self.assertEqual(db.deleted, [])

    def test_patch_wires_caps_into_auto_prune_before_vacuum(self):
        text = FIXTURE.read_text()
        patched = load_patch_module().patch_source(text)
        compile(patched, "hermes_state_maintenance_patched", "exec")
        body = patched.split("def maybe_auto_prune_and_vacuum", 1)[1]
        self.assertLess(body.index("_openclaw_enforce_caps(self, sessions_dir)"),
                        body.index("if vacuum and pruned > 0 and vacuum_due"))
        self.assertIn("def _openclaw_enforce_caps", patched)

    def test_patch_is_idempotent_and_fails_loudly_on_drift(self):
        mod = load_patch_module()
        once = mod.patch_source(FIXTURE.read_text())
        self.assertEqual(mod.patch_source(once), once)
        with self.assertRaises(mod.PatchError):
            mod.patch_source("def maybe_auto_prune_and_vacuum():\n    pass\n")

    def test_baked_config_sets_30_day_retention_and_caps(self):
        import yaml
        sessions = yaml.safe_load(CONFIG.read_text())["sessions"]
        self.assertEqual(sessions["retention_days"], 30)
        self.assertGreater(sessions["max_sessions"], 0)
        self.assertGreater(sessions["max_db_mb"], 0)


if __name__ == "__main__":
    unittest.main()
