QUESTIONS
q: Can the implementation run read Dependabot alerts through the GitHub App or MCP, or must the re-list use Darren's credentialed read? | assumption: No — the App returns 403 on the alerts endpoint and the MCP tool list has no alerts tool, so batch 0 re-lists via Darren's `gh api` or the Dependabot UI, and no batch proceeds until that re-list lands.
q: What is alert 317's fixed guava version? | assumption: Unknown from here; implementation reads it from the alert in batch 0 and bumps to that version, or to latest 33.8.0-jre if the alert's fixed version is at or below it.
q: May the sharp fix use an npm `overrides` entry (a major bump of a transitive dep) rather than a direct version bump? | a: Yes — the same pattern as the existing protobufjs/tinypool overrides in both modules' package.json; overrides change only the resolved version, not the declared ranges.
q: If the sharp override breaks @xenova/transformers at runtime, is migrating to @huggingface/transformers v3 acceptable in this change? | assumption: Only as a fallback if the override fails verification; the migration is a rename plus a major bump and is split out if it grows beyond a drop-in replacement.
q: What is the 11th high alert (95 - 84 = 11, but only 10 are listed as stay-open)? | assumption: Unknown; batch 0's re-list identifies it, and it joins the next batch under the same non-major-first rule.

# Clear the high Dependabot alerts in friday (#123)

## Alert state, verified at base 51cc1a0 (2026-11-09)

The issue body (2026-11-01) recorded 95 open high alerts: 84 fixable with
non-major lockfile updates plus the litellm pin, and 11 stay-open. PR #124
cleared the 84 and was squash-merged 2026-11-01 (commit 6f8c742); its content
is in this base — `modules/tests/test_critical_dependency_floors.py` passes
at HEAD and pins every fixed floor, and `litellm[proxy]==1.100.4` is in
`modules/hermes/requirements-codex-router.txt`. The 84 stay fixed; the floors
test is the guard.

What is left, verified from the lockfiles and pom at this base:

| Group | Alerts | Current state | Status |
| --- | --- | --- | --- |
| zod < 4.6.6 (via MCP SDK / openai) | 296, 187, 128 (3) | All three lockfiles resolve `node_modules/zod` 4.6.7; no zod 3.x resolved anywhere | Already fixed in-tree by PR #159 (zod 3.25.76 -> 4.6.7, merged 2026-11-09). Needs only Dependabot re-scan confirmation. |
| sharp < 0.35.5 (via @xenova/transformers) | 281, 254, 222, 113, 86, 54 (6) | sharp 0.32.6 in expense-tracker and portfolio-tracker lockfiles; @xenova/transformers 2.17.2 is the latest 2.x | **The work: batch 1.** |
| com.google.guava:guava in pp-cli/pom.xml | 317 (1) | guava 33.4.0-jre; latest on Maven Central is 33.8.0-jre | **The work: batch 2.** Fixed version for alert 317 is not readable from here (see batch 0). |
| Unaccounted | 1 | 95 - 84 = 11 stay-open, but only 10 are listed above | **Unknown; batch 0 identifies it.** |

Honest limit: the App cannot list Dependabot alerts (GET
`/repos/darrencjh8/friday/dependabot/alerts` returns 403) and the GitHub MCP
tool list has no alerts tool, so the live alert count cannot be verified from
this run. Every count above rests on the 2026-11-01 issue body plus the
lockfile/pom state at this base. Batch 0 exists to close that gap before any
code changes.

## Batch order

Non-major fixes first, one batch verified before the next starts. Major bumps
stay out and are listed as follow-ups, the same rule as PR #124.

### Batch 0 — Re-list the alerts (no code; blocks everything else)

With a credentialed read (Darren's `gh api
repos/darrencjh8/friday/dependabot/alerts?state=open&severity=high,critical`
or the Dependabot UI), record: the current open high/critical count; whether
alerts 296/187/128 (zod) are closed after the #159 merge; the fixed version
for alert 317 (guava); and the identity of the 11th alert. If the re-list
shows new high alerts since 2026-11-01, they join the queue under the same
non-major-first rule. If the re-list shows the sharp/guava alerts already
closed, the corresponding batch is skipped and the plan notes why.

### Batch 1 — sharp (6 alerts)

- Add `"sharp": "^0.35.5"` to the `overrides` in
  `modules/expense-tracker/package.json` and
  `modules/portfolio-tracker/package.json`, next to the existing protobufjs /
  tinypool overrides. No `package.json` declared range changes.
- Regenerate both lockfiles with `npm install --package-lock-only
  --ignore-scripts` in node:22 (same command PR #124 used). Only
  `package-lock.json` files change besides the two `package.json` overrides.
- Extend `modules/tests/test_critical_dependency_floors.py`: add a
  `"sharp": [(0, 35, 5)]` floor, so the existing
  `test_no_lockfile_resolves_a_vulnerable_version` test pins it. The test
  fails at base (sharp 0.32.6) and passes at HEAD.
- Blast radius: sharp is transitive only — no source file in either module
  imports it. It arrives via @xenova/transformers 2.17.2, used for local
  embeddings in `modules/expense-tracker/src/memory.js` and
  `modules/portfolio-tracker/src/memory_facts.js` (`pipeline` import). The
  risk is the native binding, not the JS surface.
- Verify: the floors test (RED at base, GREEN at HEAD), then the full
  expense-tracker and portfolio-tracker suites, including the
  embedding-parity tests that exercise the transformers pipeline.
- Fallback, only if the override fails verification: migrate
  @xenova/transformers 2.17.2 to @huggingface/transformers v3 (the renamed
  package). That is a rename plus a major bump; if it is not a drop-in
  replacement for the `pipeline` / `env` imports in memory.js and
  memory_facts.js, split it out as its own change instead.

### Batch 2 — guava (1 alert)

- Bump `com.google.guava:guava` in
  `modules/portfolio-tracker/pp-cli/pom.xml` from 33.4.0-jre to the fixed
  version from alert 317 (batch 0), or to latest 33.8.0-jre if the alert's
  fixed version is at or below it. Same major line (33.x): a minor bump, not
  a major.
- Extend `modules/tests/test_critical_dependency_floors.py` with a guava
  check that reads the version out of `pp-cli/pom.xml` and asserts it is at
  or above the fixed version. Same test file, same RED-at-base / GREEN-at-HEAD
  control.
- Verify: the floors test, then the pp-cli Maven test suite
  (`mvn -f modules/portfolio-tracker/pp-cli/pom.xml test` or the repo's
  existing wrapper for it).

### Batch 3 — zod confirmation (no code)

- From the batch 0 re-list, confirm alerts 296/187/128 are closed. If any
  zod 3.x is still resolved anywhere (nested or otherwise), it becomes a
  batch of its own under the same rule; the lockfiles at this base show none.

## Verification (implementation stage)

- `python3 -m unittest modules/tests/test_critical_dependency_floors.py` —
  RED at base, GREEN at HEAD (test id
  `modules.tests.test_critical_dependency_floors.CriticalDependencyFloorTests.test_no_lockfile_resolves_a_vulnerable_version`,
  plus the litellm pin test which must stay green).
- Full module suites for expense-tracker and portfolio-tracker on the new
  lockfiles; pp-cli Maven tests on the bumped pom.
- CI on the PR head must be all green before the PR is presented for review
  (CI rule); Darren is requested as reviewer on the PR.
- Close-out: the issue closes when the batch 0 re-list re-run after merge
  shows zero open high alerts, or when every remaining open high alert is a
  named major-bump follow-up with its own issue. The re-list is the proof —
  lockfile state alone does not close the issue.

## Not in scope

- The 84 alerts cleared by PR #124 (guarded by the floors test; no rework).
- Dependabot PR #196 (qs / @vitest/mocker / uuid group bump) — separate PR,
  separate CI failures.
- Any major bump except the sharp override (transitive, via overrides) and
  the transformers v3 fallback above.
- `.github/workflows/*` changes: none expected. If one turns up, the App
  cannot push it — hand it over as a patch comment on the issue instead.
