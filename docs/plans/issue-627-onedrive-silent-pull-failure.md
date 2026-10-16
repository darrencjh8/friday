QUESTIONS
q: Fix pull() or move signal? | a: Fix pull() - it alone hardcodes "ok".
q: Skip sheet write on pull fail? | assumption: No - out of scope; see #627.
q: Test asserting "ok" on failure? | a: It enshrines the bug; becomes RED.
q: Fix MCP text surface too? | a: Yes - pull/push line in formatSyncResult.
q: Non-zero exit on dead leg? | assumption: No - visibility only; alerting in #627.

## Question detail

Full reasoning for the five declared questions above, kept out of the `QUESTIONS` prefix so the
judged window stays short.

**1. Fix `pull()` status, or keep `"ok"` and move the signal elsewhere?**
Fix the status. `push()` two methods below already derives `status` from `result.success`
(`java_bridge.js:428`), and the MCP `pp-pull` / `pp-push` tool handlers do the same
(`tools.js:665`, `tools.js:676`). `pull()` is the only path in the module that hardcodes `"ok"`
regardless of the outcome, so this is an inconsistency rather than a design decision. The
`catch` branch two lines below already returns `"error"`, so a thrown exception and a returned
failure are meant to agree.

**2. Should `_computeSyncAll()` skip the taxonomy export when the pull fails?**
Assumption: no, and deliberately out of scope. Aborting would mean a failed grant leaves
yesterday's cell values in place with no new write at all. That is a larger change to the job's
contract than this defect requires, and it needs its own decision about whether a stale cell or
no cell is the lesser evil, plus how the user is told. This fix makes the failure *visible and
machine-readable*; suppressing the write is a separate follow-up recorded in issue #627.

**3. The test at `java_bridge.test.js:351` currently asserts the defect. Update it?**
Yes, and it is the RED case. It asserts `status: "ok"` for a failed pull, so leaving it would
make the correct behaviour a test failure. It is corrected to expect `"error"` and fails against
the unfixed `java_bridge.js`, which is exactly the RED proof required. A second case asserts the
successful pull still reports `ok` / `downloaded`, so the fix cannot be satisfied by always
returning `"error"`.

**4. Should the MCP interactive text surface be fixed in this change?**

Yes. Round 1 established that `formatSyncResult()` (`mcp-server.js:15-43`) reads only `summary`,
`flex_import` and `sync_targets`, and its line-37 early return on `raw.analysis.message_body`
discards everything built before it. The corrected `pull` status would therefore never reach the
user through `portfolio_sync` — the one surface a human reads, and the one through which this
whole incident was reported. Fixing only the cron log would leave the user-visible symptom intact,
so the round stays dirty unless this is either fixed or declared out loud. It is fixed: the error
line is prepended to the *returned* analysis string, so healthy output is unchanged. Round 2
showed why the insertion point alone is not enough — see step 3.

**5. Should `portfolio-sync.sh` exit non-zero when a leg fails?**

Assumption: no, and deliberately so. The script ends in `log "sync complete"` and exits 0 today,
and the job is `deliver: local` with `no_agent: true`, so a non-zero exit surfaces as a cron error
string rather than an alert anyone reads. Changing the exit contract is a separate decision about
alerting (delivery channel, cadence) that this defect does not require; it is recorded in issue
#627. Declared here so the choice is auditable rather than made in passing.

**Note on how this step was arrived at.** Three consecutive rounds each found a real defect in
this one code block — round 2 cleared a variant, round 3 found a parse failure, round 4 found a
silent runtime failure plus a test that certified it. Every one of those rounds inspected the
block as text and reasoned about quoting. The lesson is recorded because it generalises past this
plan: for a change that moves code across a language or process boundary, the reviewable unit is
the boundary, and the only trustworthy check is executing the real thing. `bash -n` did not catch
the silent failure, the snippet-as-text review did not catch it, and a test that re-executed the
extracted block did not catch it either. What caught it was stubbing `python3` and reading the
`argv` the shell actually handed it. Step 5's test is now written to that standard for the same
reason.

**Note on the plan-approval route.** The live dev-loop `policy.json` under the agent config
directory (outside this repository; there is no `policy.json` in this worktree, and it is
untracked here) sets `human_approval_allow_agent_authored_comment: true`
and `human_approval_allow_self: true`, so the approval comment may be posted by the agent against
the driver account. It is recorded as an agent-authored / self-attested approval so the bypass
stays visible in the audit trail.

## Change scaffold

- **Files to be changed:** none that are not already changed. See "Status against HEAD" below: every step in this plan has already been implemented on this branch across five review rounds. What remains is the two residual items named there, and no step below is to be re-applied.
- **Status against HEAD (this is load-bearing, not a status note).** At the plan commit, `base..HEAD` differs in **fifteen** files, not one. Steps 1, 2, 3 and 5 of this plan are **already implemented and committed** on `fix/portfolio-onedrive-silent-pull-failure` (HEAD at the plan commit; the substantive claims below were verified against `748691c`). The `python3 -c "` string this plan quotes as the thing to escape no longer exists: `portfolio-sync.sh` now reads its parser from a quoted heredoc. The `mcp-server.js` early return this plan rewrites already assembles `legErrs`/`abortErrs` into `pre` and joins it with the analysis body. **Re-applying any step below to the current tree would delete shipped, tested visibility** — plan round 1 verified this by executing step 3 against HEAD, which rendered the healthy-looking string `"BODY"` for the expired-flex-token, flex-import-total-drop, Sheets-401 and Actual-Budget-abort payloads, where HEAD renders four distinct warning lines. That reproduction is `/tmp/mut/plan_r1_critical.mjs` (exit 1). The steps are kept below as the specification of the landed behaviour, not as instructions to re-run.
- **Repository test command:** `cd modules/portfolio-tracker && npm ci && npm test` (package.json `"test": "vitest run"`). `npm ci` is required because a fresh worktree has no `node_modules`; a bare `npx vitest run` would fetch a floating vitest instead of the pinned dependency. The shell surface is gated separately by `bash modules/hermes/tests/test-portfolio-sync-output.sh` and linted by `shellcheck modules/hermes/scripts/portfolio-sync.sh modules/hermes/tests/test-portfolio-sync-output.sh`, which CI runs at `.github/workflows/test.yml:152`.
- **Test files in scope:** `modules/portfolio-tracker/tests/java_bridge.test.js` (existing `describe("pull")` block, lines 343-366), `modules/portfolio-tracker/tests/mcp-server.test.js`, and the new `modules/hermes/tests/test-portfolio-sync-output.sh`.
- **CI caveat — an earlier revision of this line was false, and false in the reassuring
  direction. Corrected at plan round 3.** It used to say: "the `portfolio-tracker` job at
  `.github/workflows/test.yml:42-44` carries `continue-on-error: true` … That suite is therefore a
  **local** gate for this change, not a CI gate — CI will stay green even if the corrected assertion
  regresses." Both halves are wrong. The `continue-on-error: true` belongs to the **full** suite
  job (`test.yml:79`), which needs IBKR keys and live services. The **gating** job is
  `portfolio-tracker-unit` (`test.yml:59`), which sets no `continue-on-error`, and
  `tests/ci-gating.test.js` asserts that. `tests/java_bridge.test.js` — the file holding this
  change's RED/GREEN assertion — runs in that gating job; the comment block at `test.yml:39-46` says
  so explicitly. So the correct statement is: **this work is enforced by CI**, and the old framing
  understated the guard by precisely the amount a reader would use to justify skipping it. Do not
  propagate it. (The hermes shell test is CI-enforced too, via the step 5 edit described there.)
- **Spec in scope:** `specs/003-portfolio-tracker/spec.md` — "Taxonomy Export" (line ~372) documents that the taxonomy is written to Sheets. It does not specify pull-failure behaviour, so this change adds behaviour the spec does not yet describe.
- **Tracked issue:** #627.

## The defect

`PpJavaBridge.pull()` hardcodes `status: "ok"` and varies only `detail`:

```js
// modules/portfolio-tracker/src/java_bridge.js:343-353
async pull() {
    try {
        const result = await pullFromOneDrive();
        return {
            status: "ok",                                    // never "error" here
            detail: result.success ? "downloaded" : result.error,
        };
    } catch (e) {
        return { status: "error", detail: e.message };
    }
}
```

The consequence is not cosmetic. `_computeSyncAll()` (`tools.js:800-1076`) calls
`this._ppBridge.pull()` at line 808, logs the result, and never inspects `status`. The taxonomy
export then queries whatever stale `Portfolio.portfolio` is on disk and writes it to `B4` /
`G2:G5`. Production evidence in issue #627, with the grant expired:

```
{"event":"pp-pull","result":{"status":"ok","detail":"Token HTTP 400"}}
{"event":"pp-push","result":{"status":"error","detail":"Token HTTP 400"}}
```

One minute apart, same underlying failure. The cash-total cell was written from a frozen file in
which the loan balance was materially understated — a round-figure shortfall, consistent with a
tranche drawn or restructured after that copy was last written. The loan was always summed; it was
summed from an out-of-date balance. The whole bug is a correct formula over stale inputs.

The daily job `portfolio-daily-sync` runs `no_agent: true` with `deliver: local`, so nothing
alerted. Its output prints only `sync_targets`, and those three Actual Budget-fed accounts
reported `delta=0` precisely *because* the round trip was broken — a healthy run and a broken run
printed the same thing.

## Root cause, not symptom

The shared defect is "a failed OneDrive round trip is indistinguishable from a successful one at
the boundary." That is asserted in **three** places, so all three are fixed:

1. `java_bridge.js` `pull()` — the status value itself.
2. `portfolio-sync.sh` — the status never reaches the operator-visible job log.
3. `mcp-server.js` `formatSyncResult()` — the status never reaches the interactive
   `portfolio_sync` output, because the `raw.analysis.message_body` early return at line 37
   discards it. This is the surface a human actually reads.

Fixing only (1) would leave the cron output identical, because the script does not print the
`pull` key. Fixing only (2) would print `status: "ok"` for a failed pull. Fixing (1) and (2)
still leaves the interactive surface blind. All three are one-or-two-line changes at the
correct layer; no deeper refactor is warranted. Fixing (3) is a change to the *return shape*,
not an insertion above the early return — see step 3 for why that distinction is the whole fix.

## Status against HEAD

Everything in "Implementation" below is **already landed** on `fix/portfolio-onedrive-silent-pull-failure` at the plan commit (verified against `748691c`). It is kept as the specification of the landed behaviour and is **not** an instruction to re-apply. Plan round 1 found, and this plan now states, that re-applying it would delete shipped visibility.

Two items are genuinely outstanding. They are the whole of the remaining work.

### R1. `portfolio_status` is a sixth remote leg that neither surface reported

`tools.js:1025` stores a failed Portfolio.app status fetch as `{error: e.message}` and no
consumer reads it — `_buildAnalysis` takes `taxonomyData`, not the status — so the only trace was a
`console.warn` that never reaches the daily log. This is the same defect class as #627: a leg the
operator cannot see failing. Plan round 4 named it in passing; the structural leg test I had written
excluded it on a hand-wave ("not an operator surface") that turned out to be wrong.

**This section was under-specified and plan round 1 raised it as Critical. Read the exact shape
before writing anything.** An earlier revision said only that the shell leg loop "adds
`portfolio_status` to its tuple with the same rule". Applied literally — add the name to the tuple,
keep the shipped accessors — it renders:

```
portfolio_status: ? (Portfolio.app unreachable)
```

`?` is the *byte-identical-to-a-skipped-leg* shape this plan calls "the defect in a new place".
`portfolio_status` carries neither `status` nor `success` (the producer stores `{error: e.message}`,
`tools.js:1025`), so the loop's generic `status = r.get('status') or r.get('success')` yields
`None`. Verified by executing that literal reading against the shipped script with a stub `curl`:
exit 1. **The plan's own mutation control would still fail after landing R1 as previously
written**, falsifying its acceptance criterion while still printing a `portfolio_status` line for a
skimming reader to mistake for coverage.

**Change — shell surface.** Add a dedicated branch to the leg loop, inside the quoted heredoc, not
the `python3 -c "..."` string. It must be an **early return placed before the generic
`isinstance` guard**, so the error text is printed directly and cannot be lost to the generic reads:

```python
    for leg in ('pull', 'push', 'flex_pull', 'flex_import', 'taxonomy_export',
                'portfolio_status'):
        r = data.get(leg)
        if leg == 'portfolio_status' and isinstance(r, dict) and r.get('error'):
            # tools.js stores a failed status fetch as {error: msg} (tools.js:1025),
            # and no other leg or consumer reads it, so surface it here or the run
            # reports clean. Placed before the isinstance guard below because that
            # guard's `? ()` placeholder is exactly what must not be printed.
            print(f'  {leg}: error ({r["error"]})')
            continue
        if not isinstance(r, dict):
            # Absent, or an explicit null: render the placeholder. For
            # taxonomy_export this means the deployment does not export taxonomies.
            print(f'  {leg}: ? ()')
            continue
        status = r.get('status') or r.get('success')
        detail = r.get('detail') or r.get('error') or ''
        ...
```

**Why placement is load-bearing, and it was got wrong twice.** The generic read is
`status = r.get('status') or r.get('success')`, and `portfolio_status` carries **neither** key, so
without an early return the leg renders `status if status is not None else "?"` → `? (...)`, which
is the byte-identical-to-a-skipped-leg shape this plan calls "the defect in a new place". A branch
inserted *after* those reads but setting only `status` also works, because `detail` already falls
through `r.get('error')`; a branch inserted *before* them that only sets a local is silently
overwritten. Both acceptable forms were executed against the shipped script and agree on all three
payloads:

| payload | rendered |
|---|---|
| `portfolio_status: {error: "Portfolio.app unreachable"}` | `portfolio_status: error (Portfolio.app unreachable)` |
| `portfolio_status: {status: "ok", detail: "SGD ok"}` | `portfolio_status: ok (SGD ok)` |
| `portfolio_status` absent | `portfolio_status: ? ()` |

**Change — JS surface.** `formatSyncResult` reports `raw.portfolio_status.error` as its own line,
prefixed **`⚠️ Portfolio status: `** — a distinct prefix from the shell's bare
`portfolio_status: error (…)` and from every other leg's JS prefix, because this leg is a
*dependency* failure rather than a pull or export failure.

Its exact position: **push it onto `legErrs`** (`mcp-server.js:62`), alongside the other legs'
warnings, and fire only on `.error`:

```js
const ps = raw.portfolio_status;
if (ps && ps.error) {
    legErrs.push(`⚠️ Portfolio status: ${ps.error}`);
}
```

`legErrs` is joined into `pre` *before* the early return, which is what makes the placement safe —
this plan's step 3 exists because that join was missing, and step 3's re-application is a measured
destruction, so do not relocate this into the analysis branch or after the return. A healthy
`portfolio_status` is a full status object with no `.error` key, so the guard keeps it silent; a
full-suite run must gain no new line.

**Change — test (JS surface).** `tests/leg-coverage.test.js` drops `portfolio_status` from
`NOT_LEGS`, adds it to `REQUIRED`, **and adds its entry to the `failing` fixture map**:

```js
failing.portfolio_status = { error: "Budget service unreachable" };
```

That last clause is not optional. `leg-coverage.test.js` iterates `for (const leg of REQUIRED)` and
looks each leg up in `failing`; without an entry there, `failing[leg]` is `undefined`, the renderer
is handed a *healthy* payload, and the test fails with the misleading
`must not render byte-identical to a healthy run: expected 'BODY' not to be 'BODY'`. Verified by
removing the line: the exact predicted message appears.

**Change — test (shell surface).** `modules/hermes/tests/test-portfolio-sync-output.sh` gains a
`failed-status` case feeding a body whose only failure is
`portfolio_status: {error: "Portfolio.app unreachable"}`, asserting the rendered line is exactly:

```
  portfolio_status: error (Portfolio.app unreachable)
```

**Without this the shell half of R1 is unpinned by any committed test.** Plan round 2 raised that as
High, and it is right: `leg-coverage.test.js` imports `formatSyncResult` and never reads
`portfolio-sync.sh` (this plan says so at R2), and the shipped shell test had **zero**
`portfolio_status` references before this change. So the shell branch would be covered only by the
out-of-tree mutation control, which by this plan's own admission is not reproducible from a clone.
The fixture is the producer's real shape, for the reason the paragraph above gives.

**Change — test (JS surface, second return path).** `mcp-server.js` has **two** returns —
`return [...pre, ...lines]` (analysis present) and `return [...pre, ...lines].join("\n")` at
`mcp-server.js:159` (analysis absent) — and `analysis` is null whenever `taxonomyData` is falsy, so
the second is a real production path, not a theoretical one. R1's `legErrs` push is correct on both,
but only one of them is pinned by a committed test: `mcp-server.test.js:309` covers
`surfaces a failed OneDrive pull when there is no analysis`, and no test does the same for
`portfolio_status`.

So R1 must add that sibling case, asserting the warning survives the fallback return **and** that the
sync summary and target lines still render alongside it — mirroring the existing case exactly:

```js
it("surfaces a failed Portfolio status fetch when there is no analysis", () => {
    const raw = {
        summary: "Synced 1/2 accounts",
        portfolio_status: { error: "Portfolio.app unreachable" },
        sync_targets: [{ name: "Deposit Account", status: "error", error: "timeout" }],
    };
    const out = formatSyncResult(raw);
    expect(out).toContain("⚠️ Portfolio status: Portfolio.app unreachable");
    expect(out).toContain("🔄 Synced 1/2 accounts");
    expect(out).toContain("⚠️ Deposit Account: timeout");
});
```

Plan round 3 raised the absence of this as its one Medium, and the mutation proves it: dropping the
new warning from *only* the fallback return leaves all **80** tests in the four CI-gated suites
(`onedrive-legs`, `mcp-server`, `java_bridge`, `ci-gating` — exactly the four named at `test.yml:59`)
green at HEAD. Every other leg's fallback rendering *is* pinned — broadly dropping `pre` from that
return turns **nine** tests red — so `portfolio_status` would be the one leg in that file not
following the convention the rest of it follows. (All counts are measured at HEAD, where R1 is not
yet landed. R1's leg-coverage change adds **one** case, not a new test: the "reports a failing leg
on every surface" block iterates a single `failing` fixture map, so the gated total goes 80 → 81.)

**These two test changes are what discharge the mutation control.** Round 2 raised as Critical that
R1 as previously specified left the control red while the Validation section claimed the control
"goes green when R1 lands", and that the sentence explaining the one expected failure stays true
after R1 lands — so it is not a diagnostic and cannot tell an implementer whether R1 is incomplete
or the control is wrong. So, explicitly:

- **The gate for the shell half of R1 is
  `REPO_ROOT=$(git rev-parse --show-toplevel) bash /opt/data/mut-controls/repro-627-base-symptom.sh`,
  and the acceptance criterion is that it exits 0** — `REPRO FAILURES: 0`, with all five checks
  passing. At HEAD before R1 it exits 1 with `failed-status` the only failure.
- **After R1 lands, `failed-status` is not a "pending item".** It is the control's regression test
  for R1. If it fails after R1, R1 is wrong. The Validation section no longer describes it as
  known-pending.
- R1 is complete only when all three hold: the shell test case passes, the control exits 0, and
  `leg-coverage.test.js` is green.

**Status: NOT landed. The work is written and verified but is not in any commit, and this plan is
the record of it, not a claim that it shipped.** An earlier revision of this line said "implemented,
committed `3d32fee` and the following commit". That was false and plan round 3 raised it as
Critical: `3d32fee` is the *taxonomy export* commit and contains no `portfolio_status` at all; the
R1 work exists only in a stash. Do not read the rest of this plan as evidence that R1 shipped.

**Implementer instruction:** R1 and R2 are the only outstanding work in this plan. Both are held
out of the commit history on purpose — the pre-commit guard refuses implementation commits while
the plan gate is open, so they cannot be committed before the plan is approved. Apply R1 and R2
from the descriptions below, then run the Validation gates. Steps 1, 2, 3 and 5 are already landed
and must **not** be re-applied.

### R2. The shell leg tuple needs a test that pins it

`tests/leg-coverage.test.js` imports `formatSyncResult` and reads the payload literal in `tools.js`.
It never reads `portfolio-sync.sh`, so the shell tuple is pinned by hand-written fixtures in
`test-portfolio-sync-output.sh` only. That asymmetry is why the plan's step-2 comment could claim a
pin that does not exist.

**Change:** a **new sibling** `tests/shell-leg-coverage.test.js` reads the shipped
`portfolio-sync.sh` and compares its leg tuple to the producer's payload keys. (Not an extension of
`leg-coverage.test.js`: that file imports `formatSyncResult` and is deliberately about the JS
surface. Merging the two would make the shell assertion depend on the JS module loading.) This
closes the half of the surface that the JS-only test cannot see, and it is the test that would have
caught R1 on the shell side at the same moment it caught it on the JS side — plan round 3 verified
that asymmetry empirically: landing R1 on the JS surface alone, leaving the shell tuple stale, left
every committed test green.

**Status: NOT landed**, same as R1, for the same reason. The file does not exist in the tree.

**And it must assert the leg's *shape*, not just its presence in the tuple.** Plan round 1 raised the
justification above as false in the direction that matters, and the round's own Critical is the
proof: the R1 shell defect is a leg **present in the tuple** that still renders as a
success-shaped `? (...)`. A tuple-membership comparison passes that. So membership alone does not
discharge the job R2 exists to do, and the sibling test must, for every leg:

1. read the shipped `portfolio-sync.sh` and assert its tuple names exactly the legs the producer
   writes into the payload — this catches a leg that is never reported at all; **and**
2. drive the shipped script (or a faithful extraction of its parse block, including bash's
   parse-time quote removal) with each leg's **real failing fixture** and assert the rendered line
   is an error line, not `? (...)` — this catches a leg that is reported but unreadable.

Assertion 1 alone is what R2 was originally specified as, and it would have passed the broken R1.
Assertion 2 is what makes it a guard on the defect class this issue is actually about.

**Assertion 2 has exactly one acceptable implementation: drive the shipped script with a stub
`curl` on `PATH`, reusing the pattern `modules/hermes/tests/test-portfolio-sync-output.sh` already
uses.** Plan round 2 raised that offering "the shipped script *or* a faithful extraction" was not
implementable — the plan spends two rounds arguing that extraction is the hazard to avoid, because
it bypasses bash's parse-time quote removal and can pass on a script that prints nothing, and then
reintroduces it as an option. Pick one: **drive the script.** There is no second option, and a test
that extracts the parse block is not an acceptable substitute for this change.

**The six failing fixtures, as literals.** Round 2 also raised that "each leg's real failing
fixture" was not recoverable from the plan, and that the wrong choice produces a *green* test
silently. Here they are, and two carry traps:

| leg | failing payload | rendered line it must produce | trap |
|---|---|---|---|
| `pull` | `{"status": "error", "detail": "OneDrive grant revoked: invalid_grant"}` | `pull: error (OneDrive grant revoked: invalid_grant)` | — |
| `push` | `{"status": "error", "detail": "upload rejected"}` | `push: error (upload rejected)` | — |
| `flex_pull` | `{"success": false, "error": "IBKR Flex error 1012: Token has expired"}` | `flex_pull: error (IBKR Flex error 1012: Token has expired)` | **Must NOT carry `skipped: true` or `error: "Not configured"`.** The shipped skip guard (`portfolio-sync.sh`) tests both and `continue`s, so the leg renders *no line at all* and a test that only asserts "an error line exists" would still pass. |
| `flex_import` | `{"status": "ok", "items_skipped": 4, "trades_imported": 0, "dividends_imported": 0, "other_imported": 0, "errors": []}` | `flex_import: error (nothing imported - all 4 items skipped)` | **Status is hardcoded `"ok"`**, so a fixture or assertion keyed on `status` is dead code. Use the total-drop form, or one with a populated `errors[]`. |
| `taxonomy_export` | `{"status": "error", "detail": "Google Sheets API: 401"}` | `taxonomy_export: error (Google Sheets API: 401)` | Do **not** use `status: "skipped"` — that is configuration absence, not a failure, and is correctly silent. |
| `portfolio_status` | `{"error": "Portfolio.app unreachable"}` | `portfolio_status: error (Portfolio.app unreachable)` | No `status` key at all; a generic `{"status": "error"}` fixture proves nothing. |

**The assertion for each leg is that the rendered line starts with `<leg>: error`** — not merely
that the leg appears. That is the assertion that fails on `? (...)`, which is the whole point.

And the negative half, which is what would catch an over-broad fix: a **healthy** body — all legs
carrying their normal success shapes, no errors anywhere — must render **no** `error` line for any
leg. Without it, a parser that printed `error` unconditionally would pass every row above.

**And it must run in CI, or landing it changes nothing.** `leg-coverage.test.js` was, at the time
of round 3, executed by no gating job — `grep -c leg-coverage .github/workflows/test.yml` was 0.
A guard nobody runs is not a guard. So this change carries with it the wiring:

- add both `tests/leg-coverage.test.js` and `tests/shell-leg-coverage.test.js` to the
  `npx vitest run` line in the **gating** `portfolio-tracker-unit` job (`test.yml:59`);
- add the same two files to `RENDERER_TESTS` in `tests/ci-gating.test.js`, so the guard that
  enforces the gate is itself covered by the gate.

Verified: with the two files in `RENDERER_TESTS` but not yet in the workflow, `ci-gating.test.js`
fails with `must run tests/shell-leg-coverage.test.js`. The guard binds.

## Implementation

### 1. `java_bridge.js` — derive the status

```js
return {
    status: result.success ? "ok" : "error",
    detail: result.success ? "downloaded" : result.error,
};
```

### 2. `portfolio-sync.sh` — print the round-trip status

The `pull` and `push` objects are already in the response body; the existing parse block just does
not print them. Extend that block with the same loop — **inside the quoted heredoc, not inside the
`python3 -c "` string** (the hazard is spelled out immediately below, and the Critical round-4
finding was this snippet being read as the code to write):

> **The fenced block below is ILLUSTRATION, not code to run.** It is fenced as `text` and its first
> line is not valid Python, so it cannot be pasted, cannot execute, and cannot exit 0. It is here
> only to show the *shape of the defect*. The shipped parser does not do this — see the accessors
> after the block. Plan round 3 raised this as Medium: at the time, the block was fenced `python`,
> appeared **before** the warning, and was the step's only executable code. Executed verbatim it
> printed `flex_pull: ? ()` and `portfolio_status: ? ()` for a body where the IBKR token had
> expired — indistinguishable from an unconfigured deployment, i.e. #627 re-created one leg over on
> the operator surface, from a paste of the plan. The warning is now **above** the block for that
> reason.

```text
<<NOT RUNNABLE - ILLUSTRATION OF THE DEFECT>>
for leg in ('pull', 'push', 'flex_pull', 'flex_import', 'taxonomy_export',
            'portfolio_status'):
    r = data.get(leg) or {}
    print(f'  {leg}: {r.get("status", "?")} ({r.get("detail", "")})')
```

**The uniform `status`/`detail` read above is NOT what ships, and must not be taken from this
snippet.** Only `pull` and `push` carry those keys. The producer writes a different shape per leg:
`flex_pull` is `{success, error, skipped}` (`ibkr_flex.js`), `flex_import` is `{status, errors[],
items_skipped}` where `status` is hardcoded `"ok"` and failures live in `errors[]` (PpClient.java),
`taxonomy_export` is `{status, detail, errors[]}` with a `partial` status, and `portfolio_status` is
`{error}` with **no `status` key at all**. So **any leg whose producer writes neither `status` nor
`detail` renders as `? ()`** — and how many that is depends on the payload: on a full sync body it
is two (`flex_pull`, `portfolio_status`), on a pull/push-only body it is four. (An earlier revision
of this line said "four of the six on every run"; that was wrong and plan round 3 corrected it.) The
consequence does not depend on the count: `? ()` for a *skipped or unconfigured* leg is
**byte-identical** to `? ()` for a *failed* one, which is the defect in a new place. Plan round 1
raised this as a High and it is correct: the shipped parser reads each leg with the accessor its
producer actually writes, and `tests/leg-coverage.test.js` requires a failing shape for every leg
in `REQUIRED`.

Written here the way `python3 -c "` would deliver it — that is, with the double quotes stripped —
this loop is a `SyntaxError` (`r.get(status, ?)`), and `2>/dev/null || true` would swallow it, so the
script would exit 0 having printed nothing. Pasting the plain form above into that shell string is
precisely the defect; the heredoc is the fix, not a style preference.

**The block must move out of the shell string, and this is a structural change, not a quoting
one.** `portfolio-sync.sh:29` opens `python3 -c "`, so the Python program is a shell argument and
bash performs quote removal on it before Python ever sees the text. Every quote character inside
that string is therefore destroyed or reinterpreted, and *which* way it fails depends on the form:

| form in the block | what Python actually receives | outcome |
|---|---|---|
| `print(f"  {leg}: …")` | `print(f  {leg}: …)` — the f-string's own delimiter is stripped with the rest | `SyntaxError: invalid syntax`, swallowed, silent |
| `print(f'  {leg}: {r.get("status", "?")} …')` | `print(f'  {leg}: {r.get(status, ?)} …')` — keys become bare names | `SyntaxError: f-string: expecting '=', or '!', or ':', or '}'`, swallowed, silent |

**Both rows are swallowed, and neither is a `bash -n` failure.** An earlier draft of this table
claimed the double-quoted form makes `bash -n` exit 2; that was wrong, and plan round 1 raised it as a
Medium. Executed against bash's actual parse-time quote removal (`/tmp/mut/row1_check.sh`), both
forms deliver text that Python rejects at parse time, and `portfolio-sync.sh` ends in
`2>/dev/null || true`, so **both** exit 0 having printed nothing. `bash -n` returns 0 on both: bash
successfully splits the string and never validates the Python inside it. A third row asserting
`bash -n` catches this is what would have made an implementer trust a check that cannot fail.

Both rows were confirmed by running the shipped script with a stub `python3` on `PATH` capturing
real `argv`. The middle row is the dangerous one: it raises a `SyntaxError`, but
`portfolio-sync.sh:41` ends in `2>/dev/null || true`, so the script exits 0 having printed
**nothing**. The change would delete a signal that works today and replace it with silence.
`bash -n` does not catch it, because bash successfully splits the string; it never validates the
Python.

A third form — writing the dict keys single-quoted inside a single-quoted f-string — looks like
the way out, and is worth ruling out explicitly, because it is not a quoting problem at all:

```python
print(f'  {leg}: {r.get('status', '?')} ({r.get('detail', '')})')
```

Those inner single quotes **close the f-string**. Nested same-quote expressions in f-strings are
PEP 701, valid only from Python 3.12, so that line is a `SyntaxError` on any interpreter below 3.12
regardless of how bash handles the surrounding string. The identical line compiles on a 3.13 host,
which is exactly how it can look correct in review and break in production.

**The interpreter version is not pinned anywhere in this repository.** `portfolio-sync.sh` runs in
the `hermes` container, whose Dockerfile installs `python3` from apt with no version constraint, so
the exact minor version is whatever the base image ships on the day it is built. Do not assume 3.11.2
or 3.13.5; assert compatibility with the lowest version the base image can carry, which means
avoiding PEP 701 constructs entirely. The quoted heredoc makes that question moot for this code,
because the block contains no nested same-quote f-string expressions.

The program is therefore read into a variable by a **quoted heredoc**, which performs no expansion
and no quote removal, and then passed to Python as one argument:

```bash
read -r -d '' PARSE_PROG <<'PARSE_EOF' || true
import sys, json
try:
    … the existing block, unchanged, plus the two lines above …
except Exception as e:
    print(f'  (parse error: {e})')
PARSE_EOF
echo "$BODY" | python3 -c "$PARSE_PROG" 2>/dev/null || true
```

`read -d ''` returns non-zero at EOF, hence the `|| true`; the variable is assigned regardless.
Verified end to end: the snippet reaches Python byte-identical (`r.get("status", "?")` intact),
and the same block that printed nothing under `-c "` now prints `pull: error (Token HTTP 400)`.
The body is read on the program's own stdin, so no argv placeholder is needed.

Two details that are easy to get wrong and are pinned by the test in step 5:

- `data.get(leg) or {}` rather than `data.get(leg, {})`. The response can be partial — a leg that
  never ran is absent, and `data.get(leg, {})` returns `None` for an explicit JSON `null`, so
  `r.get(...)` would raise. `or {}` makes the absent case render as `pull: ? ()` instead of
  collapsing into the block's `except`, which prints `(parse error: ...)` and hides every target
  line above it.
- The defaults `'?'` and `''` are load-bearing for the same reason: a leg present but missing
  `status` must not raise.

Failures become visible in the job output without changing the script's exit code or the
`deliver: local` contract, so no alerting change is implied.

**Ordering: step 2 must land, and be `bash -n`-clean, before step 5.** Step 5's gate drives the
shipped script with a stub `curl` on `PATH` and asserts on its stdout. It does **not** extract and
execute the parse block in isolation: doing so bypasses bash's parse-time quote removal, the one step
that mangles the program text, so such a test passes on a script that prints nothing and certifies
the defect. The rest of the ordering is already stated in step 1: the bridge fix has to precede steps 2
and 3, or both would report `status: "ok"` for a failed pull.

### 3. `mcp-server.js` — surface the status *in the returned string*

**This step as written is superseded and must not be applied to the current tree.** It reads
`["pull", "push"]` and joins only those errors, which contradicts step 2's own six-leg tuple: three
legs would stay unreported on the interactive surface. Plan round 1 raised this as a High, and it is
worse than an omission — executing this snippet against HEAD drops the IBKR flex, Sheets export,
flex-import and abort lines that the current tree already prints (reproduced in
`/tmp/mut/plan_r1_critical.mjs`). What ships instead is `legErrs` (one entry per failing remote leg,
each read with the accessor its producer writes) plus `abortErrs`, joined as `pre` and prepended to
the analysis body by the early return.

Plan round 2 then raised the sharper form of the same objection: that an *insertion above the early
return* is a no-op, because the early return hands back `raw.analysis.message_body` and never joins
the array. That is correct about the original wording, and the answer is the return shape below,
which is what HEAD already implements. The sentence this plan used to get wrong — "pushed above the
early return, so the authoritative analysis block cannot suppress it" — is gone; the analysis block
*would* suppress it, and the fix is to change what is returned, not where a push lands.

The original reasoning is retained below because it is why the return is a shape change and not an
insertion above the early return.

The OneDrive error lines go in their own array, `onedriveErrs`, kept separate from `lines`.
That separation is load-bearing, not cosmetic: `lines` holds the sync summary and the
target errors, and the existing test at `mcp-server.test.js:275` asserts a healthy run
contains no sync header. Prepending `lines` to the analysis body would reintroduce it.

```js
const onedriveErrs = [];
for (const leg of ["pull", "push"]) {
    const r = raw[leg];
    if (r && r.status === "error") {
        onedriveErrs.push(`⚠️ OneDrive ${leg}: ${r.detail || "failed"}`);
    }
}
```

and the return becomes a **shape change**, not an insertion point:

```js
if (raw.analysis?.message_body) {
    return onedriveErrs.length
        ? [...onedriveErrs, raw.analysis.message_body].join("\n")
        : raw.analysis.message_body;
}
return [...onedriveErrs, ...lines].join("\n");
```

**Why the shape, and why not just "above the early return".** Round 2 proved the obvious
version is a no-op. The current function returns `raw.analysis.message_body` and never
joins `lines`, so a push into `lines` is discarded. Both the current function and that
variant were run on a dead-grant input; the outputs were byte-identical and neither
mentioned the failure. Only the return shape above survives, and the error-only condition
is what keeps a healthy run byte-identical (verified: healthy output is unchanged and
carries no sync header).

`analysis` is present in exactly the incident scenario, so the early return is on the
path for this bug: `_computeSyncAll()` builds `analysis` only when `taxonomyData` is
truthy, and the dead-grant run *did* export a taxonomy (that is how `2026!B4` was
written from the stale file). Stale file present means taxonomy data present means
analysis present means the early return fires.

### 4. `mcp-server.test.js` — both return paths

Two cases, because the two returns are genuinely different code and only one was covered:

1. `analysis.message_body` present **and** `pull.status === "error"`. The rendered text must
   contain the pull error. Fails against the current early return.
2. `analysis` **absent** and `pull.status === "error"`. The rendered text must contain the pull
   error *and* the `lines` content. This is the `return [...onedriveErrs, ...lines]` path, and it is
   live whenever `taxonomyData` is falsy — the gate is `if (taxonomyData)` at `tools.js:1032`, which
  is what leaves `analysis` as `null` (`tools.js:1030`) and hands `formatSyncResult` an empty body
  (built at `:1058`, returned at `:1086`) — a pull
   failure with no taxonomy to export, exactly the case where the user most needs to be
   told. Without this case a later refactor could drop `onedriveErrs` from that last line and
   every other planned test would still pass. Same defect shape as the round-2 `lines` finding: a
   value produced in one place and consumed in another. This case asserts the branch's **exact**
   output, not just that the error appears.

**What the byte-identity claim actually rests on.** Not the ternary, which is only the spelling of
the check. It is that the analysis branch returns `raw.analysis.message_body` *unmodified* when
the error array is empty. A healthy run's text is therefore the analysis string and nothing else,
and the only thing that could perturb it is an error line leaking in. That is why the condition is
error-only rather than a concatenation.

### 5. `modules/hermes/tests/test-portfolio-sync-output.sh` + a CI step for it

CI does **not** glob the hermes shell tests: `.github/workflows/test.yml:153-172` enumerates the
pre-existing hermes shell tests as explicit `- name:` / `run: bash modules/hermes/tests/test-<name>.sh`
pairs, one per file, with no matrix — **ten** of them at base `f04cc08`, and **eleven** at HEAD once
this change adds its own. (An earlier revision of this sentence said "ten" without qualification and
was stale against the branch it describes; plan round 3 flagged the same drift and round 1 counted
it again.) Adding a test therefore requires adding a step, and the standing proof is
`modules/hermes/tests/test-skills-backup-restore.sh`, which exists in the tree and is referenced by
no workflow at all. So a new test file with no step guards nothing.

**This step is already wired on the branch.** `.github/workflows/test.yml` now carries
`- name: Test portfolio-sync output` / `run: bash modules/hermes/tests/test-portfolio-sync-output.sh`
inside the `hermes-scripts` job, which sets no `continue-on-error`, so the gate is binding. The
enumeration problem above is the reason the step had to be added explicitly, not a reason it is
still outstanding. `tests/ci-gating.test.js` pins both ends of that chain, so deleting the step
or the deploy gate that consumes it fails a committed test.

Extraction is by `python3 -c "$PARSE_PROG" 2>/dev/null || true` after the step-2 rewrite, and the
test **runs the shipped script with a stubbed `curl`**, asserting on its stdout. It must not
re-execute the extracted program on its own: a test that reads the block off disk and feeds it to
its own `python3 -c` skips bash's parse-time quote removal, which is the *only* step that mangles
the text. Such a test passes on a script that prints nothing at all, because it never reproduces
the defect it exists to catch — it certifies it. The stub is a `curl` placed first on `PATH` that
emits a fixed body; the script reads no environment variable and has no token-path knob, so the
stub alone determines what it sees. The script otherwise runs unmodified.

The test feeds these bodies and asserts on stdout. **Every remote leg needs a failing fixture, not
just the two that were known when this step was written** — three bodies that all use `status`/`detail`
legs pass unchanged on a parser that renders every other leg as `? ()`, which is the exact defect the
High finding above describes. The `failed-status` row is the R1 check, and `expired-flex-token` is
the row that would catch the uniform-read regression.

**This table is the TARGET state, not a description of the shipped test.** Round 2 raised the
present-tense framing as misleading, and it is: this step's CI wiring is already landed, so a reader
taking "already wired" at face value would conclude every row below already exists. Seven of the
eight rows are present in the shipped `test-portfolio-sync-output.sh` today. The `failed-status` row
is **not**, and is added by R1 — see R1's "Change — test (shell surface)". Treat the table as the
list of cases the test must cover, and check it off against the file rather than assuming.

| body | expected stdout |
|---|---|
| healthy | `pull: ok (downloaded)`, and the existing `Deposit Account: updated (delta=0)` line still present |
| dead grant | `pull: error (Token HTTP 400)` |
| no `pull` / `push` keys | `pull: ? ()` — the `or {}` default, not a parse error |
| expired IBKR flex token | `flex_pull: error (IBKR Flex error 1012: Token has expired)` — and **not** `flex_pull: ? ()` |
| flex import with a populated `errors[]` | the joined item errors, and **not** `flex_import: ? ()` |
| Sheets export 401 | `taxonomy_export: error (Google Sheets API: 401)` |
| failed Portfolio status fetch | `portfolio_status: error (Portfolio.app unreachable)` — a leg with no `status` key at all |
| flex integration unconfigured | no `flex_pull` line whatsoever, not `flex_pull: error` and not a placeholder |

The first three rows are the RED cases against the unmodified script, where the summary prints
nothing. The `? ()` row is there because a leg absent from the body must not fall into the block's
`except`, which would print `(parse error: …)` and hide every target line above it. The last row is
the negative: asserting only that the word "error" is absent is too weak, because without the skip
guard the leg still renders as `skipped ()`, so the assertion is that **no line is emitted**. That
gap was found by mutation, not by review.

`.github/workflows/test.yml` gains a named step beside the last enumerated step (line 172 at HEAD):

```yaml
- name: Test portfolio-sync output
  run: bash modules/hermes/tests/test-portfolio-sync-output.sh
```

### 6. `java_bridge.test.js` — correct the assertion and add the RED case

`describe("pull")` currently asserts the defect:

```js
it("returns detail when pull returns error info", async () => {
    mockPullFromOneDrive.mockResolvedValue({ success: false, error: "Network error" });
    const result = await bridge.pull();
    expect(result).toEqual({ status: "ok", detail: "Network error" });  // wrong
});
```

It is changed to expect `status: "error"`, which is the RED case. The existing sibling case at
`java_bridge.test.js:344-349` already pins `ok` / `downloaded` and is left unchanged; it is
what prevents the fix being satisfied by always returning `error`.

## Validation

- RED: the corrected assertion fails at base — expected `{ status: "error" }`, received `{ status: "ok" }`.
- GREEN: `npm test` fully green in `modules/portfolio-tracker`, plus the hermes shell test green.
- `bash -n modules/hermes/scripts/portfolio-sync.sh` must pass before the GREEN claim — but it is
  **not sufficient on its own**, and the plan no longer leans on it. `bash -n` only checks that
  bash can split the script; it never validates the Python, so it returns 0 on a block that makes
  Python raise at runtime and the script swallow the error. The gate that actually catches this
  class is step 5's test, which runs the script. Both are listed because the first is a one-second
  check worth keeping, and the second is the one that has teeth.
- Mutation control: `/opt/data/mut-controls/repro-627-base-symptom.sh` — **outside the checkout, and
  that placement is forced, not chosen.** Recorded command:
  `REPO_ROOT=$(git rev-parse --show-toplevel) bash /opt/data/mut-controls/repro-627-base-symptom.sh`.
  It honours `REPO_ROOT` when set and otherwise walks up from `BASH_SOURCE`. It POSTs nothing and
  calls no live service — every run uses a stub `curl` on `PATH`. Recorded result: **4 of its 5 checks
  fail at base `f04cc08`, exit 1**; at the branch HEAD exactly one still fails — `failed-status` —
  which is R1, not yet landed (see R1's status line).

  **After R1 lands, `failed-status` stops being a pending item and becomes the control's regression
  test for R1: the control must then exit 0 with `REPRO FAILURES: 0`.** An earlier revision of this
  paragraph called the check "not yet landed" without saying what happens afterwards, so a reader
  could not tell a not-yet-complete R1 from a wrong control — and round 1's Critical was exactly that
  confusion. R1 names this control as the gate that discharges its shell half; the criterion is exit
  0, not "fewer failures than before".

  **Why it cannot be in-tree.** Plan round 3 raised as High that this script was described as
  tracked when it was not, and the obvious fix — track it — is *impossible* here, because three
  driver rules are jointly unsatisfiable:

  1. `loop.py repro` refuses with *"reproduction evidence must be recorded before the plan gate
     opens"*, so the repro must be recorded **before** `PLAN_REVIEWING`;
  2. `loop.py repro` runs the command in a **fresh worktree checked out at `base_sha`**
     (`loop.py:3641-3652`), where anything untracked or uncommitted is simply absent;
  3. `loop.py guard-staged` refuses every commit outside `APPROVED_OR_LATER_PHASES` =
     `{PLAN_APPROVED, TESTS_VALID, REVIEWING, REVIEW_VALID, CI_RUNNING, MERGE_READY}`
     (`loop.py:2062-2064`). `REPRODUCED` is not in that set.

  So a reproduction script can never be present in the base worktree, no matter how it is
  committed. Verified by simulation: at base, the in-tree path gives `No such file or directory`.

  **The cost, stated plainly: this control is not reproducible from a fresh clone.** That is a real
  loss and it is why the plan does not pretend otherwise. Anyone re-running it needs the script, so
  the five checks are named here and can be rewritten from this plan if the file is lost:
  `dead-grant` (a revoked OneDrive grant is reported as a success — the reported bug),
  `failed-status` (a failed `portfolio_status` fetch is reported — R1),
  `failed-taxonomy-export` (a Sheets 401 is reported), `expired-flex-token` (an IBKR 1012 is
  reported), and `healthy-run-stays-clean` (a healthy run prints no warning — the no-regression
  half, and the one that would catch an over-broad fix).
- `shellcheck modules/hermes/scripts/portfolio-sync.sh modules/hermes/tests/test-portfolio-sync-output.sh` must pass; CI runs the first of these at `.github/workflows/test.yml:152`. The reproduction script is outside the checkout, so it is linted with `shellcheck /opt/data/mut-controls/repro-627-base-symptom.sh` rather than being in CI's reach.
- The script change is verified hermetically by `modules/hermes/tests/test-portfolio-sync-output.sh` over fixed stub bodies, asserting behaviour rather than shell text. No live-service call is part of validation.

## Out of scope

- Not changing `_computeSyncAll()` to skip the taxonomy write when the pull fails (see #627).
- Not adding alerting or changing `deliver` on the cron job.
- Not touching `pullFromOneDrive` / `pushToOneDrive`; they already return `success: false` correctly. The bug is in the caller.
- Not re-authenticating OneDrive in code; that is a user-side `/onedrive setup` action, already performed 2026-09-27.
