"""The weekly curator dry run messages Darren only when it proposes something."""

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "curator-proposals.py"


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

    def test_missing_report_is_one_error_line(self):
        out = self.run_script(None)

        self.assertEqual(out, "⚠️ *Skill merge proposals failed* · curator wrote no new report")

    def test_missing_structured_block_is_an_error(self):
        out = self.run_script({"llm_final": "no block here", "llm_error": None, "llm_summary": "done"})

        self.assertTrue(out.startswith("⚠️ *Skill merge proposals failed* · no structured summary"), out)

    def test_failed_curator_run_is_an_error(self):
        out = self.run_script(None, exit_code=3)

        self.assertTrue(out.startswith("⚠️ *Skill merge proposals failed* · curator run exited 3"), out)


if __name__ == "__main__":
    unittest.main()
