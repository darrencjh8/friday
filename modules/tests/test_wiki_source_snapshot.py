"""The wiki maintenance pre-run script writes hashed raw snapshots the wiki lint accepts,
skips a source whose data has not changed, and keeps card-like digit runs out of the wiki."""

from __future__ import annotations

import datetime
import hashlib
import importlib.util
import os
import re
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "hermes" / "scripts" / "wiki-source-snapshot.py"
# The wiki lint's own rules (scripts/lint.py in the wiki).
FM_RE = re.compile(r"^---\n(.*?)\n---\n", re.S)
CARD_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")


def load():
    spec = importlib.util.spec_from_file_location("wiki_source_snapshot", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WikiSourceSnapshotTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.mod = load()
        self.mod.WIKI = tmp.name
        self.mod.RAW = os.path.join(tmp.name, "raw", "articles")
        os.makedirs(self.mod.RAW)
        self.now = datetime.datetime(2026, 10, 12, 4, 0, tzinfo=self.mod.SGT)
        self.data = {"balance": 12345, "ratio": 1 / 3 * 4, "notes": f"card {'4' + '1' * 15} paid"}

    def fetch(self):
        return self.data, {"source_url": "test", "rows": 1}

    def test_snapshot_passes_the_wiki_lint_hash_and_card_rules(self) -> None:
        result = self.mod.record("actual-sgd", self.fetch, self.now)

        self.assertEqual(result["status"], "changed")
        text = Path(self.mod.WIKI, result["file"]).read_text()
        match = FM_RE.match(text)
        self.assertIsNotNone(match)
        for key in ("source_url", "ingested", "sha256", "captured_at"):
            self.assertIn(f"{key}:", match.group(1))
        body = text[match.end():]
        declared = re.search(r"sha256:\s*([0-9a-f]{64})", match.group(1)).group(1)
        self.assertEqual(hashlib.sha256(body.lstrip().encode()).hexdigest(), declared)
        self.assertEqual(CARD_RE.findall(body), [])

    def test_snapshot_is_markdown_because_it_carries_frontmatter(self) -> None:
        result = self.mod.record("actual-sgd", self.fetch, self.now)

        self.assertTrue(result["file"].endswith("actual-sgd-2026-10-12.md"), result["file"])

    def test_a_legacy_json_snapshot_still_counts_as_unchanged(self) -> None:
        first = self.mod.record("actual-sgd", self.fetch, self.now)
        legacy = Path(self.mod.WIKI, first["file"]).with_suffix(".json")
        Path(self.mod.WIKI, first["file"]).rename(legacy)

        second = self.mod.record("actual-sgd", self.fetch, self.now + datetime.timedelta(days=7))

        self.assertEqual(second["status"], "unchanged")
        self.assertEqual(second["file"], os.path.relpath(legacy, self.mod.WIKI))

    def test_unchanged_data_writes_no_new_file(self) -> None:
        first = self.mod.record("actual-sgd", self.fetch, self.now)
        later = self.now + datetime.timedelta(days=7)

        second = self.mod.record("actual-sgd", self.fetch, later)

        self.assertEqual(second["status"], "unchanged")
        self.assertEqual(second["file"], first["file"])
        self.assertEqual(len(os.listdir(self.mod.RAW)), 1)

    def test_changed_data_same_day_gets_its_own_file(self) -> None:
        first = self.mod.record("actual-sgd", self.fetch, self.now)
        self.data = {**self.data, "balance": 1}

        second = self.mod.record("actual-sgd", self.fetch, self.now + datetime.timedelta(minutes=5))

        self.assertEqual(second["status"], "changed")
        self.assertNotEqual(second["file"], first["file"])
        self.assertEqual(second["previous"], first["file"])

    def test_a_failing_source_is_reported_not_raised(self) -> None:
        def broken():
            raise ConnectionError("actual-api down")

        result = self.mod.record("actual-sgd", broken, self.now)

        self.assertEqual(result["status"], "error")
        self.assertIn("actual-api down", result["detail"])
        self.assertEqual(os.listdir(self.mod.RAW), [])

    def test_notion_projection_drops_private_columns(self) -> None:
        props = {
            "Name": {"type": "title", "title": [{"plain_text": "Card A"}]},
            "Number": {"type": "rich_text", "rich_text": [{"plain_text": "4111"}]},
            "Note": {"type": "rich_text", "rich_text": [{"plain_text": "secret"}]},
            "Gtask ID": {"type": "rich_text", "rich_text": []},
            "Linked": {"type": "relation", "relation": [{"id": "x"}]},
            "Status": {"type": "status", "status": {"name": "Active"}},
        }
        kept = {name for name, p in props.items()
                if p["type"] not in self.mod.NOTION_DROP_TYPES and not self.mod.NOTION_DROP.search(name)}

        self.assertEqual(kept, {"Name", "Status"})
        self.assertEqual(self.mod.notion_value(props["Name"]), "Card A")

    def test_only_captures_just_the_named_source(self) -> None:
        calls = []
        self.mod.notion = lambda ds: (calls.append(ds) or ([{"id": "r1", "Action date": {"start": "2026-11-20", "end": None}}],
                                                         {"source_url": "notion", "rows": 1}))
        self.mod.actual = lambda budget: self.fail("actual must not run")
        self.mod.portfolio = lambda: self.fail("portfolio must not run")
        self.mod.codex_router = lambda: self.fail("codex-router must not run")
        from unittest import mock
        with mock.patch("builtins.print") as printed:
            self.assertEqual(self.mod.main(["--only", "notion-accounts"]), 0)
        self.assertEqual(calls, [self.mod.NOTION_SOURCES["notion-accounts"]])
        out = "\n".join(str(c.args[0]) for c in printed.call_args_list)
        self.assertIn('"source": "notion-accounts"', out)
        self.assertNotIn("actual-sgd", out)

    def test_only_rejects_an_unknown_source(self) -> None:
        with self.assertRaises(SystemExit):
            self.mod.main(["--only", "nope"])

    def test_daily_wrapper_runs_only_notion_accounts(self) -> None:
        wrapper = SCRIPT.with_name("notion-accounts-snapshot.py").read_text(encoding="utf-8")
        self.assertIn("wiki-source-snapshot.py", wrapper)
        self.assertIn('"--only", "notion-accounts"', wrapper)

    def test_actual_meta_marks_the_transaction_window_complete(self) -> None:
        # actual-api /transactions returns every row in the window (no paging, no cap),
        # so the meta must not read as possibly truncated (an "incomplete" digest).
        self.mod.mcp_call = lambda *a, **k: {"accounts": [], "payees": []}
        self.mod.http_json = lambda *a, **k: ([], {})

        _, meta = self.mod.actual("Darren SGD")

        self.assertIs(meta["has_more"], False)
        self.assertIn("complete", meta["completeness"])
        self.assertNotIn("unpaged", str(meta))


if __name__ == "__main__":
    unittest.main()
