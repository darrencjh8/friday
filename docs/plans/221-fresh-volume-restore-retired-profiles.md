QUESTIONS
q: Must the restore keep operator-created (non-baked) profiles? | a: Yes — the skip is by retired-name list, not by baked-set membership, so an operator profile still restores. Backup copies every live profile; the seed only seeds baked ones.
q: Is skipping the repo copy of code-reviewer/config.yaml acceptable? | assumption: No — the repo copy may carry operator-owned non-routing keys the baked file lacks, so the plan re-runs the migration after the restore instead of skipping the copy. The migration only overwrites routing fields and preserves user-owned keys.
q: Should memory-backup.sh also prune retired folders from friday-memory? | assumption: No — out of scope. The restore-side skip makes the prune unnecessary, and deleting from the shared repo is a bigger blast radius than fixing the restore.
q: What if profiles/_active in friday-memory names a retired profile? | assumption: Do not restore the pointer; leave active_profile absent so the default applies.
q: Are the retired folders still in friday-memory right now? | assumption: Not verified from here — the GitHub App token gets 404 on darrencjh8/friday-memory, so the live repo contents could not be read. The fix works whether or not they are still there.

# Plan: fresh-volume restore must not bring back retired profiles or old code-reviewer routing (#221)

## Problem

Fixes friday #221 (Medium finding M1 from code review round 2 of the #220 Phase 1-2 change, accepted as a risk for that PR).

Verified by reading the code on `main` at `b130fc1`:

- Boot order in `modules/hermes/50-seed-defaults`: the retired-profile cleanup (`rm -rf` of `static-analyst`, `qa-engineer`, `quality-assurance`, `architect`, `project-manager`, `spec-auditor`) runs early; the profile seed and the `code-reviewer` routing migration run mid-file; the `memory-restore.sh` call runs after them, before the SOUL template seed.
- `modules/hermes/scripts/memory-restore.sh` restores profiles with plain `cp`: every profile directory in the cloned friday-memory repo is copied, including retired names, and `code-reviewer/config.yaml` is overwritten with the backed-up (older) routing.
- `modules/hermes/scripts/memory-backup.sh` never deletes a profile folder from the clone: it copies every live profile and runs `git add -A`, so retired folders already in friday-memory persist there.
- The retired list lives in exactly one code place, the seed loop in `50-seed-defaults`. The only baked profile is `code-reviewer` (`modules/hermes/profiles/`).

Reproduction (recorded with the dev-loop repro gate at base `b130fc1`):
`modules.hermes.tests.test_memory_restore_retired.TestRestoreRetired.test_retired_not_restored`
fails — a fixture repo holding `profiles/architect/SOUL.md` restores the retired profile. The same file's live-profile case (`code-reviewer` restores) stays green, so a fix cannot pass by skipping every profile.

## Design

Two half-fixes, one per half of the bug. No change to `memory-backup.sh`.

1. The restore never resurrects a retired profile: skip the six retired names in the restore's profile loop. The list is duplicated once, in the restore script, with a comment pointing at the seed loop — the restore must stay self-contained (it is also run standalone in tests) — and a test pins the two lists equal so they cannot drift.
2. The migration is the last word on routing: wrap the managed-routing migration block in a shell function and call it where it is today AND once more right after the restore call. The restored `code-reviewer/config.yaml` is then re-migrated in the same boot, keeping the repo copy's operator-owned keys (which a skip-the-copy fix would lose) while the routing fields come from the current baked defaults. The migration only writes routing fields and is idempotent, so running it twice is safe. The cleanup loop needs no re-run: with the skip, retired profiles never land.
3. If `profiles/_active` in friday-memory names a retired profile, do not restore the pointer.

Rejected: pruning retired folders in `memory-backup.sh`. It does not fix the routing overwrite, it only takes effect after a backup cycle pushes the prune, and it deletes data from the shared repo — a bigger blast radius for a partial fix. Once the restore skips retired names, the prune is unnecessary.

## Changes

1. `modules/hermes/scripts/memory-restore.sh`
   - In the profiles loop, skip the six retired names (`static-analyst`, `qa-engineer`, `quality-assurance`, `architect`, `project-manager`, `spec-auditor`) — the whole iteration, including the `mkdir`.
   - Do not copy `profiles/_active` to `active_profile` when it names a retired profile.
2. `modules/hermes/50-seed-defaults`
   - Wrap the managed-routing migration `python3 - <<'PY' ... PY` block in a shell function (definition around the existing block, no change to the block's text — the seed tests regex-match that text) and call it at the current spot and again immediately after the `memory-restore.sh` call.
3. Tests
   - `modules/hermes/tests/test_memory_restore_retired.py` — already written as the repro scaffold; commit it. Cases: retired profile not restored, live profile still restored. Add a case for `_active` naming a retired profile.
   - `modules/hermes/tests/test-memory-restore.sh` — change the fixture sample profile from `architect` to a live profile (`code-reviewer`), so the "profile files restored" case stops pinning the buggy behaviour. The retired case lives in the `.py` file; do not duplicate it here.
   - `modules/hermes/tests/test-50-seed-defaults.sh` — assert the restore script's retired list matches the seed's list; extend the existing restore-order check to assert the migration also runs after the restore call.
   - `.github/workflows/test.yml` — run the new `.py` in the hermes test job, one line in the same form as the other `python -m unittest modules/hermes/tests/...` lines.
   - No change to `modules/hermes/tests/test-memory-backup.sh`: backup still copies whatever is live, and the restore is what must refuse retired names. Its `architect` fixture still exercises "profile files are copied".

## Tests (CI runs them; `test.yml` already runs the hermes tests)

RED control for the tests gate: `python3 -m unittest modules/hermes/tests/test_memory_restore_retired.py -v`. Its `test_retired_not_restored` case fails at base (the base script restores `architect`) and passes at HEAD. The live-profile case passes at both.

## Out of scope

- Pruning retired folders from friday-memory in `memory-backup.sh` (see QUESTIONS).
- Registering restored non-baked profiles with `hermes profile create` — pre-existing behaviour, the restore runs after the seed loop.
- The two Low/Nit items from the same review round, accepted as risks on #221: `pre-restore-<timestamp>/` copies are never pruned, and the boot `WARNING` after the restore call only fires on a `set -e` exit (common failures exit 0 and log only the `[memory-restore]` line). Not fixed here.

## Risks

- Production is unchanged on merge: on a live volume `memories/MEMORY.md` exists, so restore is a no-op. The new path runs only on a fresh volume or a retry boot.
- A duplicated retired list can drift; the equality test pins it.
- On a retry boot the live `code-reviewer` config is re-migrated before the restore, and the post-restore migration re-applies routing over the restored copy, so a retry keeps repo truth for user-owned keys and current routing.
