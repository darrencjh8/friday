"""Issue #91: seeded agent cron jobs must declare a failed run.

Hermes records a cron run as failed only when the agent's reply starts with the
exact line ``[CRON_FAILURE]``; anything else is recorded as ``ok``. Each seeded
agent prompt therefore has to tell the agent to use that marker.
"""

from pathlib import Path
import unittest

SEED = Path(__file__).parents[1] / "hermes" / "50-seed-defaults"

# The first words of each seeded agent cron prompt.
AGENT_PROMPTS = {
    "ops-log-issues": 'LOG_ISSUE_TRIAGE_PROMPT = """Review sanitized log evidence',
    "memory-compact": 'PROMPT = """Compact the always-loaded Hermes memory',
    "memory-approve-queue": 'PROMPT = """Triage the Hermes memory write-approval queue',
    "wiki-finance-refresh": 'PROMPT = """Maintain the private wiki using its SCHEMA.md',
    "wiki-repo-docs": 'PROMPT = """Refresh the repository side of the private wiki',
    "wiki-due-reminders": 'PROMPT = """Check the private wiki for payment, action, and habit dates',
}


RULES = (
    "first line of your reply exactly [CRON_FAILURE]",
    "comes after it",
    "Never reply [SILENT] after a failed step.",
)


def prompt_text(seed: str, start: str) -> str:
    head, sep, rest = seed.partition(start)
    if not sep:
        raise AssertionError(f"seed no longer has the prompt starting {start!r}")
    text, _, after = rest.partition('"""')
    # The live job only gets the rule if this prompt is the one its MANAGED dict seeds.
    var = start.split(" = ", 1)[0]
    managed = after.split("MANAGED = {", 1)[1].split("}", 1)[0]
    if f'"prompt": {var},' not in managed:
        raise AssertionError(f"MANAGED after {start!r} does not seed {var}")
    return text


class CronFailureMarkerTest(unittest.TestCase):
    def test_every_agent_cron_prompt_declares_failures(self):
        seed = SEED.read_text(encoding="utf-8")
        missing = [
            job for job, start in AGENT_PROMPTS.items()
            if not all(rule in prompt_text(seed, start) for rule in RULES)
        ]
        self.assertEqual(missing, [], "agent cron prompts without the failure marker")


if __name__ == "__main__":
    unittest.main()
