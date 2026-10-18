"""Tests for curator proposal generation, selection, and Telegram reply context."""

# prose-pins-file: Telegram message formatting and table output are the user-facing contract.

import ast
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import types
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve()
HERMES = HERE.parents[1] / "hermes"
SCRIPT = HERMES / "scripts" / "curator-proposals.py"
APPROVAL_SCRIPT = HERMES / "scripts" / "curator-proposal-approval.py"
REPLY_PATCH = HERMES / "patches" / "patch-telegram-reply-context.py"
REPLY_FIXTURE = HERMES / "tests" / "fixtures" / "upstream_telegram_reply_context_v0.22.2.py"


def fake_hermes(bindir: Path, run: dict | None, exit_code: int = 0) -> Path:
    """A `hermes` stand-in that writes one curator run.json, like the real dry run."""
    body = json.dumps(run) if run is not None else ""
    path = bindir / "hermes"
    path.write_text(textwrap.dedent(f"""\
        #!/bin/sh
        [ "$*" = "curator run --dry-run --consolidate --sync" ] || {{ echo "bad args: $*" >&2; exit 2; }}
        if [ -n '{body}' ]; then
            mkdir -p "$HERMES_HOME/logs/curator/20261018-041500"
            printf '%s' '{body}' > "$HERMES_HOME/logs/curator/20261018-041500/run.json"
        fi
        exit {exit_code}
        """), encoding="utf-8")
    path.chmod(0o755)
    return path


def llm_final(block: str) -> dict:
    return {"llm_final": f"Clusters reviewed.\n\n## Structured summary (required)\n```yaml\n{block}\n```", "llm_error": None}


class CuratorProposalsTest(unittest.TestCase):
    def run_script(self, run, exit_code=0):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            (home / "logs" / "curator" / "20261011-041500").mkdir(parents=True)
            (home / "logs" / "curator" / "20261011-041500" / "run.json").write_text("{}")
            hermes = fake_hermes(Path(tmp), run, exit_code)
            env = {**os.environ, "HERMES_HOME": str(home), "HERMES_BIN": str(hermes)}
            result = subprocess.run([sys.executable, str(SCRIPT)], env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout.strip()

    def test_no_proposals_is_silent(self):
        out = self.run_script(llm_final("consolidations: []\nprunings: []"))

        self.assertEqual(out.splitlines()[-1], '{"wakeAgent": false}')

    def test_proposals_become_a_table(self):
        out = self.run_script(llm_final(
            "consolidations:\n  - from: notion-pitfalls\n    into: notion\n    reason: same API | same gotchas\n"
            "prunings:\n  - name: old-skill\n    reason: unused since July"))

        self.assertIn("🧰 *Skill merge proposals · ", out)
        self.assertIn("| notion-pitfalls | notion | same API / same gotchas |", out)
        self.assertIn("| old-skill | unused since July |", out)
        self.assertNotIn("wakeAgent", out)

    def test_proposal_has_reference_to_its_saved_report(self):
        run = llm_final("consolidations:\n  - from: notion-pitfalls\n    into: notion\n    reason: same API")
        digest = hashlib.sha256(json.dumps(run).encode()).hexdigest()[:12]
        out = self.run_script(run)

        self.assertIn(f"proposal_id=20261018-041500-{digest}", out)

    def test_missing_report_is_one_error_line(self):
        out = self.run_script(None)

        self.assertEqual(out, "⚠️ *Skill merge proposals failed* · curator wrote no new report")

    def test_missing_structured_block_is_an_error(self):
        out = self.run_script({"llm_final": "no block here", "llm_error": None, "llm_summary": "done"})

        self.assertTrue(out.startswith("⚠️ *Skill merge proposals failed* · no structured summary"), out)

    def test_failed_curator_run_is_an_error(self):
        out = self.run_script(None, exit_code=3)

        self.assertTrue(out.startswith("⚠️ *Skill merge proposals failed* · curator run exited 3"), out)


class CuratorProposalApprovalTest(unittest.TestCase):
    def write_report(self, home: Path, report: dict) -> str:
        run_id = "20261018-041500"
        path = home / "logs" / "curator" / run_id / "run.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = json.dumps(report).encode()
        path.write_bytes(raw)
        return f"{run_id}-{hashlib.sha256(raw).hexdigest()[:12]}"

    def run_approval(self, home: Path, proposal_id: str, selection: str):
        return subprocess.run([sys.executable, str(APPROVAL_SCRIPT), proposal_id, selection],
                              env={**os.environ, "HERMES_HOME": str(home)},
                              text=True, capture_output=True)

    def test_selection_returns_only_original_report_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            report = {"llm_final": "```yaml\nconsolidations:\n  - from: one\n    into: umbrella\n    reason: first\n  - from: two\n    into: umbrella\n    reason: second\nprunings:\n  - name: stale\n    reason: unused\n```"}
            proposal_id = self.write_report(home, report)

            result = self.run_approval(home, proposal_id, "2")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["merges"], [
                {"from": "two", "into": "umbrella", "reason": "second"}])

    def test_all_selects_merges_but_not_pruning(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            report = {"llm_final": "```yaml\nconsolidations:\n  - from: one\n    into: umbrella\n    reason: first\nprunings:\n  - name: stale\n    reason: unused\n```"}
            proposal_id = self.write_report(home, report)

            result = self.run_approval(home, proposal_id, "all")

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual([row["from"] for row in payload["merges"]], ["one"])

    def test_modified_report_and_invalid_selection_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            proposal_id = self.write_report(home, {"llm_final": "```yaml\nconsolidations:\n  - from: one\n    into: umbrella\n    reason: first\n```"})
            invalid = self.run_approval(home, proposal_id, "2")
            report_path = home / "logs" / "curator" / "20261018-041500" / "run.json"
            report_path.write_text('{"llm_final":"changed"}')

            changed = self.run_approval(home, proposal_id, "all")

            self.assertNotEqual(changed.returncode, 0)
            self.assertNotEqual(invalid.returncode, 0)
            self.assertEqual(changed.stdout, "")
            self.assertEqual(invalid.stdout, "")

    def test_malformed_saved_summary_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            proposal_id = self.write_report(home, {"llm_final": "```yaml\nconsolidations: [\n```"})

            result = self.run_approval(home, proposal_id, "all")

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")

    def test_non_list_consolidations_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            proposal_id = self.write_report(home, {"llm_final": "```yaml\nconsolidations: {from: one, into: umbrella}\n```"})

            result = self.run_approval(home, proposal_id, "all")

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")

    def test_malformed_merge_entry_is_rejected_for_all_and_single_selection(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            proposal_id = self.write_report(home, {
                "llm_final": "```yaml\nconsolidations:\n  - from: one\n    reason: missing target\n```"})

            all_rows = self.run_approval(home, proposal_id, "all")
            one_row = self.run_approval(home, proposal_id, "1")

            self.assertNotEqual(all_rows.returncode, 0)
            self.assertNotEqual(one_row.returncode, 0)
            self.assertEqual(all_rows.stdout, "")
            self.assertEqual(one_row.stdout, "")


class TelegramReplyContextPatchTest(unittest.TestCase):
    def load_patch(self):
        spec = importlib.util.spec_from_file_location("telegram_reply_patch", REPLY_PATCH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_cached_original_rich_message_beats_partial_echo(self):
        source = REPLY_FIXTURE.read_text(encoding="utf-8")
        patched = self.load_patch().patch_adapter(source)
        namespace = {"Any": object}
        exec(compile(patched, "patched_adapter", "exec"), namespace)
        adapter = namespace["TelegramAdapter"]()
        adapter._rich_text = "table heading\nrow one\nrow two"
        message = types.SimpleNamespace(
            reply_to_message=types.SimpleNamespace(message_id=7, text="partial header", caption=None),
            quote=None,
            chat=types.SimpleNamespace(id=3),
        )
        store = types.SimpleNamespace(lookup=lambda chat_id, message_id: "heading\n| one |\n| two |")
        gateway = types.ModuleType("gateway")
        gateway.rich_sent_store = store

        with mock.patch.dict(sys.modules, {"gateway": gateway}):
            result = adapter._reply_context(message)

        self.assertEqual(result, ("7", "heading\n| one |\n| two |"))

    def test_explicit_partial_quote_remains_authoritative(self):
        source = self.load_patch().patch_adapter(REPLY_FIXTURE.read_text(encoding="utf-8"))
        namespace = {"Any": object}
        exec(compile(source, "patched_adapter", "exec"), namespace)
        message = types.SimpleNamespace(
            reply_to_message=types.SimpleNamespace(message_id=7, text=None, caption=None),
            quote=types.SimpleNamespace(text="selected line"),
            chat=types.SimpleNamespace(id=3),
        )

        self.assertEqual(namespace["TelegramAdapter"]()._reply_context(message), ("7", "selected line"))

    def test_patch_keeps_a_finite_long_message_cache_limit(self):
        patch = self.load_patch()
        patched = patch.patch_store("_MAX_TEXT_CHARS = 2000\n")
        self.assertIn("_MAX_TEXT_CHARS = 20000", patched)
        self.assertEqual(patch.patch_store(patched), patched)


if __name__ == "__main__":
    unittest.main()
