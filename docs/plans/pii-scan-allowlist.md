QUESTIONS
q: Which names must remain reportable? | a: Keep confirmed personal names and all unconfirmed findings reportable.
q: Can tests be excluded wholesale? | a: No; exclude only specific confirmed synthetic findings at specific historical locations.

# PII scan allowlist

The two scanners produce JSONL consumed by `scripts/pii-scan-alert.py`. Filter
only in that shared collector using a committed list of exact `DetectorName`,
`ExtraData.name`, value,
commit, and file combinations. An entry must not suppress another detector,
commit, file, or a commit-message occurrence. Never put real personal data or
credentials in the public allowlist. Start with confirmed fictional fixtures and
unambiguous synthetic or non-person findings; leave uncertain entries visible.

Use a JSON allowlist next to the scripts. Load and validate it before sending;
missing or malformed configuration must fail the run rather than hide findings.
Keep error output free of finding values. Do not skip entire test directories.

For each candidate, privately verify the scanner fields against the historical
source and the user's confirmation. Seed confirmed fictional fixtures and
clearly non-person terms only; never publish real personal data. Check at least
one confirmed historical fixture matches its exact entry, while an unapproved
neighbor remains reportable; do not reveal the neighbor in public evidence.

Write `test_allowlist_exact_occurrence` first in a new standalone test under
`tests/`, runnable with the repo virtual environment as
`python tests/test_pii_allowlist.py`. Run that control against base and HEAD via
the dev-loop mutation gate, and run `python scripts/test-pii-scan-alert.py` as
the existing regression suite. Cover both scanner formats, each independently
changed detector field, value, commit and file, commit messages, mixed allowed
and unallowed locations, and missing or malformed configuration. Implement the
smallest change, review the exact commit, and run CI on a PR.
