"""Reproduction control for friday issue #184 (docs/spec drift).

Each check asserts a documented fact against the code/config as it is now.
At base every check fails (the docs are stale); after the fix they pass.
The durable guard is scripts/check-docs-drift.sh; this test pins the
concrete drift cases the issue was filed against, invokes the guard
directly, and mutation-probes it (one probe per guard check).
"""
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
GUARD = ROOT / "scripts" / "check-docs-drift.sh"


def run_guard(cwd):
    return subprocess.run(
        ["bash", "scripts/check-docs-drift.sh"],
        cwd=cwd, capture_output=True, text=True,
    )


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def compose_services():
    text = read("modules/docker-compose.yml")
    # Top-level service names sit under the `services:` key at 4-space indent.
    in_services = False
    names = []
    for line in text.splitlines():
        if line == "services:":
            in_services = True
            continue
        if in_services:
            m = re.match(r"    ([a-z][a-z0-9_-]*):\s*$", line)
            if m:
                names.append(m.group(1))
            elif line and not line.startswith(" "):
                break
    return names


class TestIssue184(unittest.TestCase):
    def test_docs_match_code(self):
        failures = []

        # 1. README says five runtime services; compose defines nine.
        if "five runtime services" in read("README.md"):
            failures.append(
                "README.md still says five runtime services, compose has "
                f"{len(compose_services())}"
            )

        # 2. AGENTS.md cites a db.sqlite that does not exist in the repo.
        if "modules/expense-tracker/db.sqlite" in read("AGENTS.md"):
            failures.append(
                "AGENTS.md still cites modules/expense-tracker/db.sqlite, "
                "which is not in the repo"
            )

        # 3. troubleshooting.md treats COMMANDCODE as required, but the
        # provider is retired: no commandcode anywhere in config or deploy.
        if "COMMANDCODE_API_KEY" in read("docs/troubleshooting.md") and (
            "commandcode" not in read("modules/hermes/config.yaml").lower()
            and "COMMANDCODE" not in read("modules/deploy.sh")
        ):
            failures.append(
                "docs/troubleshooting.md still describes COMMANDCODE_API_KEY "
                "as required, but no commandcode remains in config.yaml or "
                "deploy.sh"
            )

        # 4. design.md says Hermes mem_limit 3g; compose says 4g.
        if "mem_limit: 3g" in read("design.md"):
            failures.append(
                "design.md still says Hermes mem_limit 3g, compose says 4g"
            )

        # 5. SETUP.md says memory-compact runs Sundays; the seed is daily.
        setup = read("SETUP.md")
        if "memory-compact" in setup and "Sundays" in setup:
            failures.append(
                "SETUP.md still says memory-compact runs Sundays, the seed "
                "is daily (30 7 * * *)"
            )

        # 6. constitution §2.5 says expense-tracker mem_limit 1536m; compose
        # gives it no mem_limit (1536m is the x-codex-router-color anchor,
        # inherited only by codex-router-a/b).
        if "expense-tracker | 1536m" in read(
                ".specify/memory/constitution.md"):
            failures.append(
                "constitution §2.5 still says expense-tracker mem_limit "
                "1536m, compose gives it no mem_limit"
            )

        if failures:
            self.fail("docs drift: " + "; ".join(failures))

    def test_guard_present_and_green(self):
        if not GUARD.exists():
            self.fail("drift guard missing: scripts/check-docs-drift.sh")
        result = run_guard(ROOT)
        self.assertEqual(
            result.returncode, 0,
            "drift guard failed on the unmutated tree:\n" + result.stdout,
        )

    def test_guard_mutations(self):
        # One probe per guard check (plus learning-on/off variants for
        # check 6): mutate one documented value in a temp copy and the
        # guard must fail with a named FAIL line.
        probes = [
            ("1-doc-service-list", "README.md", "dots-web", ""),
            ("2-doc-mem-limit", "design.md", "4g", "3g"),
            ("2b-constitution-mem-limit",
             ".specify/memory/constitution.md", "no `mem_limit`", "1536m"),
            ("3-doc-port", "docs/operations.md", "8300", ""),
            ("4-doc-skill-list", "docs/README.md", "gtasks-cli", ""),
            ("5a-doc-cron-expr", "design.md", "30 7 * * *", "30 8 * * *"),
            ("5b-doc-interval", "design.md", "every 15m", "every 30m"),
            ("5c-doc-seeds-job", "design.md", "actual-backup", ""),
            # The three cron rows the old window-based extraction
            # mis-associated: each must fail on its own row's expr.
            ("5d-doc-cron-gtasks", "design.md", "0 7 1 * *", "0 7 2 * *"),
            ("5e-doc-cron-vacuum", "design.md", "0 3 * * 0", "0 4 * * 0"),
            ("5f-doc-cron-skills", "design.md", "15 4 * * 0", "15 5 * * 0"),
            ("6a-doc-raw-mcp", "design.md", "28", "27"),
            ("6b-doc-learning-rest", "design.md", "32", "31"),
            ("7-doc-test-job", "docs/testing.md", "dots-web", ""),
            ("8-doc-component", "README.md", "whisper", ""),
            ("9-deploy-override", ".github/workflows/deploy.yml",
             "modules/(docker-compose\\.yml|deploy\\.sh)$",
             "modules/(docker-compose\\.yml)$"),
            ("10a-doc-spekkit", "design.md", "specs/<NNN-name>/",
             ".speckit/features/"),
            # Insertion probe: append a retired-provider sentence; the
            # guard must fail because troubleshooting.md must not mention
            # COMMANDCODE_API_KEY at all.
            ("10b-doc-commandcode", "docs/troubleshooting.md", None,
             "\nCOMMANDCODE_API_KEY is required.\n"),
            ("11-spec-next", "SPECKIT.md", "next is 031", "next is 014"),
        ]
        if not GUARD.exists():
            self.fail("drift guard missing: scripts/check-docs-drift.sh")
        failures = []
        for name, rel, old, new in probes:
            with tempfile.TemporaryDirectory() as tmp:
                copy = Path(tmp) / "repo"
                shutil.copytree(
                    ROOT, copy,
                    ignore=shutil.ignore_patterns(".git", ".agents"),
                )
                target = copy / rel
                text = target.read_text(encoding="utf-8")
                if old is None:
                    target.write_text(text + new, encoding="utf-8")
                else:
                    if old not in text:
                        failures.append(
                            f"{name}: probe pattern not found in {rel}")
                        continue
                    target.write_text(text.replace(old, new, 1), encoding="utf-8")
                result = run_guard(copy)
                if result.returncode == 0:
                    failures.append(f"{name}: guard passed on mutated {rel}")
        if failures:
            self.fail("guard mutations not caught: " + "; ".join(failures))


if __name__ == "__main__":
    unittest.main()
