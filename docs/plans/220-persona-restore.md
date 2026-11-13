QUESTIONS
q: Where does the persona live, friday-memory or env vars? | a: friday-memory is the source of truth; the env-var SOUL.md.template is only the fresh-volume fallback (owner decision D1 on #220).
q: Where do her calendar and preferences live? | a: Not in friday-memory. friday-memory holds sensitive data, so the owner moved the shared persona files (calendar, preferences) to a separate private persona repo that every Friday agent reads; syncing it into Hermes is a separate issue. This change does not touch persona/ (owner decision on #220, revising D2).
q: Separate IDENTITY.md or fold identity into SOUL.md? | a: Fold into SOUL.md. Hermes only loads $HERMES_HOME/SOUL.md (agent/context_file_sources.py), never IDENTITY.md (owner decision on #220).
q: How are conflicts between the live volume and friday-memory resolved? | a: Single writer, live volume wins. Restore runs only on a fresh volume or as a retry after a failed restore; a retry first keeps a pre-restore copy. Rollback-to-old-snapshot and a direct or second writer are accepted risks, recoverable from friday-memory git history (owner decision on #220).
q: Who writes the persona text? | a: Not this change. The Muse-side agent drafts it, the owner approves, and it is written to the live volume through Hermes after this ships. No persona text in this public repo.

# Plan: restore SOUL.md and memory from friday-memory on a fresh volume (#220 Phase 1-2, code side)

Phase 0 audit: #219.

## Problem

- `modules/hermes/scripts/memory-restore.sh` is never called. Only `tests/test-memory-restore.sh` runs it.
- The only boot restore is an inline block near the end of `modules/hermes/50-seed-defaults`:
  - it runs as root and clones `MEMORY_REPO_URL` with no credentials, so the clone fails on a private repo;
  - it copies the whole repo into `/opt/data/memories/` (the wrong place);
  - `2>/dev/null ... || true` hides the failure.
- `SOUL.md.template` is seeded early in `50-seed-defaults`, before any restore. On a fresh volume the live `SOUL.md` is always the env template, and the next `memory-backup` pushes that template over the real `SOUL.md` in friday-memory.
- `memory-restore.sh` builds `https://<token>@...` for every token. A GitHub App token (`ghs_`) needs `x-access-token:<token>@`, as `memory-backup.sh` already does.
- `memory-backup.sh` backs up `memories/topics/` but restore never restores it.

## Design

One writer: the live volume. friday-memory is its copy.
- Fresh volume (no `memories/MEMORY.md`): restore everything from friday-memory, then seed the template only if `SOUL.md` is still missing.
- Existing volume: restore does nothing, and live files win. This cannot overwrite an edit that has not been backed up yet.
- Fresh-volume restore failure: write a marker. Backup refuses to run while the marker exists, so an unrestored volume can never overwrite friday-memory. The next boot retries and keeps a copy of anything live before overwriting it.

## Changes

1. `modules/hermes/scripts/memory-restore.sh`
   - Exit 0 early unless `$SRC_DIR/MEMORY.md` is missing or `$DATA_DIR/.memory-restore-failed` exists. The whole script becomes the first-boot restore, so the inner `$FIRST_BOOT` guard on `MEMORY.md`/`USER.md` goes away.
   - Fail closed. On entry to the fresh-or-retry path, `touch` the marker before anything else, and `rm -f` it only as the very last line. Any failure (no token, clone failure, or a `set -e` exit from a later `cp`/`mkdir`) leaves the marker set. No auth token or clone failure: log and exit 0, so boot never blocks. Remember whether the marker existed before the `touch`; that is what tells a retry apart from a first boot for the keep-copy below.
   - Always build the URL as `https://x-access-token:${AUTH_TOKEN}@...`. GitHub accepts any username with a PAT, so one line covers both App (`ghs_`) and PAT tokens.
   - Retry only (marker present at start): before copying, copy each live path that exists into `$DATA_DIR/pre-restore-<UTC timestamp>/`, keeping its relative path: `memories/MEMORY.md`, `memories/USER.md`, `SOUL.md`, `memories/topics/`. Log the directory.
   - Restore `topics/` to `$SRC_DIR/topics/`.
2. `modules/hermes/scripts/memory-backup.sh`
   - At the top, after the `MEMORY_REPO_URL` check: if `$DATA_DIR/.memory-restore-failed` exists, print the reason to stderr and `exit 1`. The cron then reports a failure.
3. `modules/hermes/50-seed-defaults`
   - Remove the early `[ ! -f /opt/data/SOUL.md ] && cp ... SOUL.md.template` line.
   - Directly after the `github-auth.sh` block, add:
     - `chown hermes:hermes /opt/data` and `chown -R hermes:hermes /opt/data/memories /opt/data/profiles 2>/dev/null || true`. Root created these earlier in the script (`mkdir -p /opt/data/memories/topics`, profile seeding), and the existing blanket `chown -R hermes:hermes /opt/data` only runs at the very end. Without this, the hermes-run restore hits EACCES;
     - a call `su -m -s /bin/sh hermes -c 'HOME=/opt/data/home /opt/hermes-defaults/scripts/memory-restore.sh' || echo "WARNING: ..." >&2`. This runs as `hermes` with the `HOME` `github-auth.sh` configured `gh` under;
     - then the template seed line, unchanged.
   - Both run before the existing `${VAR}` substitution step, so the fallback template is still rendered.
   - Delete the inline first-boot clone block near the end. The pointer step after it stays, and its "runs after the first-boot restore" comment stays true.
4. Side fixes
   - `modules/hermes/skills/expense-tracker/SKILL.md`: drop "~" from "warm, feminine, ~", and from the example line `3 tx updated~`. The template bans the tilde for TTS.
   - `modules/hermes/skills/image-gen/SKILL.md`: remove the bullet that loads the non-existent `selfie` skill (selfies are a later phase).

## Tests (CI runs them; `test.yml` already runs both scripts' tests)

New cases are added to the existing shell test files:
- `modules/hermes/tests/test-memory-restore.sh`
  - fresh volume restores `SOUL.md` and `topics/`;
  - existing volume is a no-op (a live `SOUL.md` is untouched);
  - clone failure writes the marker and exits 0;
  - a failure after the clone (an unwritable target directory) leaves the marker set;
  - a retry with a marker keeps the live `MEMORY.md` under `pre-restore-*/memories/MEMORY.md`, then restores and clears the marker;
  - a `ghs_` token clones through an `x-access-token:` URL.
- `modules/hermes/tests/test-memory-backup.sh`
  - the marker makes the script exit non-zero without committing.
- `modules/hermes/tests/test-50-seed-defaults.sh`
  - the restore call precedes the template seed line;
  - the inline clone block is gone.

RED control for the tests gate: `bash modules/hermes/tests/test-memory-restore.sh`. Its new case `fresh volume restores topics/` fails at base (the base script does not restore `topics/`) and passes at HEAD. Each shell test file prints `FAIL <label>` and exits non-zero on any failing case. The other two files' new cases are also RED at base, and CI runs all three through `test.yml`.

## Out of scope

- Persona files (calendar, preferences): they live in the separate persona repo, and syncing it into Hermes is its own issue.
- `cron/jobs.json` restore, a drift check against the Muse-side backup, and any persona text.

## Risks

- Production is unchanged on merge: the live volume has `memories/MEMORY.md`, so restore is skipped. The new path runs only on a fresh volume, which Phase 3's round-trip test proves end to end.
- A restore that copies over a partly built fresh volume is intended (the repo is the truth until the first successful restore). The retry keep-copy covers the one case where live data could be lost.
