"""A capped log collection is usable evidence, not a failed collection (#134)."""

import importlib.util
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

PLUGIN_PATH = Path(__file__).resolve().parents[1] / "plugins/log-issue-triage/__init__.py"
spec = importlib.util.spec_from_file_location("log_issue_triage_plugin_capped", PLUGIN_PATH)
triage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(triage)


class CappedCollectionTest(unittest.TestCase):
    def collect(self, snapshot):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot_root = Path(tmp) / "snapshots"
            snapshot_root.mkdir()
            (snapshot_root / "hermes.json").write_text(json.dumps(snapshot), encoding="utf-8")
            with patch.object(triage, "_STATE_ROOT", Path(tmp) / "state"), patch.object(triage, "_SNAPSHOT_ROOT", snapshot_root):
                with patch.object(triage, "_run", return_value={"ok": True, "stdout": "", "stderr": ""}):
                    return triage._collect({"component": "hermes"})

    def test_capped_collection_is_usable_and_still_reports_the_cap(self):
        result = self.collect({"component": "hermes", "collection_errors": [], "truncated": True})
        self.assertEqual(result["status"], "ok")
        self.assertIn("collection_id", result)
        self.assertTrue(result["snapshot"]["truncated"])

    def test_collection_errors_still_make_it_partial(self):
        result = self.collect({"component": "hermes", "collection_errors": ["docker log failure"], "truncated": False})
        self.assertEqual(result["status"], "partial")
        self.assertNotIn("collection_id", result)

    def test_prompt_does_not_fail_the_job_on_a_capped_sample(self):
        seed = (Path(__file__).resolve().parents[1] / "50-seed-defaults").read_text(encoding="utf-8")
        prompt = re.search(r'LOG_ISSUE_TRIAGE_PROMPT = """(.*?)"""', seed, re.DOTALL).group(1)
        self.assertNotIn("or truncation means partial", prompt)
        self.assertIn("`truncated: true` is a capped sample", prompt)


if __name__ == "__main__":
    unittest.main()
