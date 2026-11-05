QUESTIONS
q: Which names must remain reportable? | a: Keep confirmed personal names and all unconfirmed findings reportable.
q: Can tests be excluded wholesale? | a: No; exclude only specific confirmed synthetic findings at specific historical locations.

# PII scan allowlist

The two scanners produce JSONL consumed by `scripts/pii-scan-alert.py`. Filter
only in that shared collector using a committed list of exact detector, value,
commit, and file combinations. An entry must not suppress another detector,
commit, file, or a commit-message occurrence. Never put real personal data or
credentials in the public allowlist. Start with confirmed fictional fixtures and
unambiguous synthetic or non-person findings; leave uncertain entries visible.

Use a JSON allowlist next to the scripts. Load and validate it before sending;
missing or malformed configuration must fail the run rather than hide findings.
Keep error output free of finding values. Do not skip entire test directories.

Write failing tests first in `scripts/test-pii-scan-alert.py` that exercise both
scanner record formats, exact location matching, an unlisted finding, and bad
configuration. Run the script in the repository virtual environment, implement
the smallest change, and run it again. Review the exact commit, run CI on a PR,
and do not merge without the required gates.
