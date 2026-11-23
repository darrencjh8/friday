# Plan: friday #316 — Hermes-Dots CI: cover Rust (cargo check) for the desktop app

Issue: https://github.com/darrencjh8/friday/issues/316
Base: `main` @ `0273c036120c54e2ec89e0099955efb89ec88922` (Merge pull request #315, feat/home-setup-ux)
Status: plan only — Darren approves before any build.

## QUESTIONS

q: Does the rust job need the real web build, or would the persona-media fetch alone place the icon? | assumption: the job builds the real dist (the proven desktop sequence); whether fetch-alone suffices is unproven from here and is a follow-up simplification, not assumed.
q: Does `try_build` fail when bundle resource `uv/uv.exe` is missing from the checkout? | assumption: the GREEN run decides; the resource copy is unconditional with `?` propagation in the tauri-build source, but the glob-resolution semantics for a missing literal path were not fully proved. If the GREEN run fails on it, the build adds the pinned uv-download step copied verbatim from `hermes-dots-desktop.yml` and re-verifies GREEN.
q: Is the windows-latest runner's preinstalled Rust enough, with no toolchain install step? | a: yes — the desktop workflow's `build` job already relies on the preinstalled toolchain on windows-latest with no install step; the rust job makes the same assumption.
q: Does the cold-cache Windows check fit in the 30-minute timeout? | assumption: yes — check is cheaper than the desktop build job's 40-minute budget (no linking, no NSIS, no installer); the first run measures it.
q: Should the rust job run on every dispatch, even Android-only changes? | assumption: yes — no path filter; the job always runs like `unit`, keeping one dispatch shape and one gate.
q: Is there a Cargo.lock to pin dependency versions? | a: no — none is committed in `desktop/src-tauri`; the job resolves the latest compatible versions on a cold cache and reuses the rust-cache afterwards. Committing a lockfile is a separate change.

## Context, in simple terms

Hermes-Dots CI checks the Android app, but it never compiles the desktop
app's Rust code. Two recent fixes shipped Rust that CI never looked at
(#194's Spotify sign-in split, #196's sleep-the-PC command) — both carried
a "cargo check never ran" caveat, and the only compile check happened after
merge, when the desktop release built the installer. This change adds one
job to the same CI workflow that runs `cargo check` on the desktop Rust, so
a broken Rust change fails CI before merge, the same way a broken Android
test does.

## What was verified in the code (not taken on trust)

- `hermes-dots-ci.yml` (156 lines, friday main @ `0273c03`): triggers are
  `workflow_dispatch` (inputs `ref`, `smoke`) and `workflow_call` (same
  inputs); there is no `pull_request` trigger — the PR gate is manual, an
  agent dispatches with the PR head SHA and verifies the run succeeded on
  that SHA. Jobs are `unit` (ubuntu-latest, 30 min) and `smoke`
  (ubuntu-latest, 40 min, only when `inputs.smoke`). No `needs:` between
  jobs — they run in parallel, and the run's conclusion is success only
  when every non-skipped job succeeds. A new job in this workflow therefore
  gates the PR exactly like `unit` does, with no extra wiring.
- Both jobs check out hermes-dots at `${{ inputs.ref }}` with
  `secrets.SUBMODULE_PAT` (checkout@11d5960a326750d5838078e36cf38b85af677262
  # v4 — every action in the file is pinned by full SHA with a version
  comment; the new job follows the same convention).
- `hermes-dots-release.yml` calls this workflow as its pre-release gate
  (`test` job, `uses: ./.github/workflows/hermes-dots-ci.yml`, `ref:` the
  hermes-dots HEAD SHA, `secrets: inherit`, no `smoke` input) — so the new
  job also runs in the release gate, automatically. The release gate gets a
  few minutes longer; that is intended.
- `hermes-dots-desktop.yml`: the `build` job runs on `windows-latest` and
  compiles the Rust with `npx @tauri-apps/cli build` and **no toolchain
  install step** — it relies on the runner's preinstalled Rust. The new job
  makes the same assumption on the same runner family.
- `desktop/src-tauri/Cargo.toml` (hermes-dots, read from the #196 build
  clone): package `friday-spotlight`, edition 2021, build dep
  `tauri-build 2.7`, deps `tauri 2.12` + plugins + serde, and Windows-only
  deps under `[target.'cfg(windows)'.dependencies]` — `windows 0.61`,
  `windows-sys 0.59` (incl. `Win32_System_Power`, `Win32_Security` from
  #196), `tauri-winrt-notification 0.8`. No `rust-toolchain.toml`
  anywhere, no `Cargo.lock` committed. `build.rs` is one line:
  `tauri_build::build()`. `src/` is three files (`main.rs`, `update.rs`,
  `voice.rs`), no `#[cfg(test)]` anywhere — plain `cargo check` covers
  everything; no `--all-targets` needed.
- `main.rs:916` calls `tauri::generate_context!()`, and
  `tauri.conf.json` sets `build.frontendDist` to `../../web/dist`. That
  proc macro panics at compile time when the path does not exist
  (Spacedrive field report: "The `frontendDist` configuration is set to
  `"../dist"` but this path doesn't exist"). `web/dist` is build output —
  it does not exist in a fresh checkout (verified: absent in the
  hermes-dots clone). The job therefore builds the real dist, the same
  way the desktop workflow's `web` job does — an empty directory was the
  first draft and was dropped in round 1, because the build script needs
  more than the dist path (see next point).
- The build script needs two more generated-at-build-time inputs, both
  absent from a fresh checkout (verified: `git ls-files
  desktop/src-tauri/` lists 7 files, no `icons/` and no `uv/`). Read
  against the tauri-build source (docs.rs, latest, read 2026-11-22):
  `try_build` copies `bundle.resources` unconditionally with `?`
  propagation (lib.rs `copy_resources(...)` call, and `copy_file` errors
  "`{:?} does not exist`"), and on Windows it compiles a resource file
  from the window icon — `if window_icon_path.exists() { ... } else {
  return Err("`{}` not found; required for generating a Windows Resource
  file during tauri-build") }`, then `res.compile()` (so the icon must be
  a valid `.ico`, not just an existing file). The icon path defaults to
  `icons/icon.ico` from `tauri.conf.json`'s `bundle.icon` list. The
  desktop workflow generates the icons first (`npx @tauri-apps/cli icon
  ../../web/dist/icons/nova-default-512.png -o icons`) and downloads
  `uv.exe` before building. The rust job reuses the Icons step; the
  `uv.exe` question is the open QUESTIONS entry above.
- Where the icon comes from: `web/persona-media.version` is `v1`
  (verified present); the fetch script (`scripts/fetch-persona-media.sh`,
  `dots-web` target) unpacks the persona-media release's `media/dots-web`
  into `web/`; `web/public/icons/` in the checkout holds only
  galet/nuage/pave PNGs — the nova icon arrives via the fetch, and the
  vite build copies `public/` into `dist/`, which is what places
  `web/dist/icons/nova-default-512.png` for the Icons step. The web build
  script is `tsc --noEmit && vite build` (`web/package.json`) — so the
  rust job's prep also typechecks the web; a broken web build fails the
  rust job too. That coupling is named, not hidden.
- `main.rs` is full of `#[cfg(windows)]` / `#[cfg(not(windows))]`
  splits (24 sites). A Linux `cargo check` would compile the Windows-only
  code — the `sleep_pc` body, the Spotify auth, the media flyout, and the
  Windows-only deps — out entirely, which is exactly the code the two
  motivating PRs changed. That is why the job runs on `windows-latest`
  (host target = the code that ships), not ubuntu-latest with a
  `--target x86_64-pc-windows-msvc` cross-check, which would also need a
  target-std install and leaves the transitive C question unproven from
  here (no toolchain on this VM to inspect the dep tree with).
- Cost: friday is a public repo, so GitHub-hosted minutes are free — the
  added job costs $0. The only cost is wall-clock: cold cache is estimated
  8–15 min (web build ~2–4 min + registry + the Tauri dep tree, checked
  not linked), warm 2–5 min with the cache. windows-latest carries a 2x
  minute multiplier, irrelevant at $0. The `unit` job and the new job run
  in parallel (no `needs:`), so the run's wall-clock is max(unit, rust),
  not the sum.
- No Rust toolchain exists on this VM (`cargo: command not found`) — the
  plan's claims about `cargo check` rest on the files above plus the
  tauri-build source and the Spacedrive field report, not on a local run.
  The first CI run is the proof.

## Design (ponytail: laziest that works)

1. **One new job, `rust`, in `hermes-dots-ci.yml`, after `unit`.** No new
   inputs, no path filter, no `needs:` — it runs on every dispatch and
   every release-gate call, in parallel with `unit`.
   - `runs-on: windows-latest`, `timeout-minutes: 30` (same as `unit`).
   - Checkout hermes-dots at `${{ inputs.ref }}` with
     `secrets.SUBMODULE_PAT`, identical to the `unit` job's checkout step.
     No Java/Android setup — a check does not bundle an APK.
   - Checkout friday sparse into `.friday` for the fetch script only
     (same sparse-checkout pattern as the `unit` job:
     `scripts/fetch-persona-media.sh`, `sparse-checkout-cone-mode:
     false`).
   - Fetch persona media, `dots-web` target, into `web/` (`GH_TOKEN:
     ${{ secrets.SUBMODULE_PAT }}`, `bash
     .friday/scripts/fetch-persona-media.sh dots-web web`), then
     `rm -rf .friday` — same shape as the `unit` job's fetch step.
   - `actions/setup-node@v4` with `node-version: 24` (same as the
     desktop workflow's `web` job), then `npm ci` and `npm run build`
     (`working-directory: web`) — the real dist, which is also what the
     Icons step consumes. No separate typecheck/test steps: the build
     script already runs `tsc --noEmit`.
   - Icons step, copied from the desktop workflow's `build` job:
     `npx --yes @tauri-apps/cli@2.12.6 icon
     web/dist/icons/nova-default-512.png -o desktop/src-tauri/icons`
     (`shell: bash`). This is a build-script prerequisite, not a release
     artifact — the generated icons are never uploaded.
   - `Swatinem/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0`
     (`# v2.9.3`, SHA verified 2026-11-22; re-verify at build time) with
     `workspaces: desktop/src-tauri`. First run is cold; warm runs reuse
     the registry + target cache. The workflow always runs from friday's
     `main`, so the cache is shared across dispatches.
   - `cargo check` (`shell: bash`, `working-directory:
     desktop/src-tauri`). Host target, no `--target` flag, no extra
     features — the default check covers the lib/bins. Git Bash ships on
     windows-latest, so `shell: bash` keeps the file's shell idioms.
2. **One header-comment line** in the same file: "All jobs run on
   GitHub-hosted cloud runners (ubuntu-latest)" becomes "All jobs run on
   GitHub-hosted cloud runners; unit and smoke on ubuntu-latest, rust on
   windows-latest (the app ships on Windows, so the check runs where it
   ships)."
3. **Nothing else changes.** The dispatch command, the `ref`/`smoke`
   inputs, the `workflow_call` contract, and the release workflow are all
   untouched. The parent verifies a run the same way as today
   (`gh run view --json jobs`).

## Explicitly not in this change

- `cargo clippy` / `cargo fmt` — lint, not a compile check; a separate
  change if wanted. A failing clippy would be a new failure mode, not
  this gate.
- Committing a `Cargo.lock` — pins dependency versions; separate change.
- A Linux `cargo check` or a `--target x86_64-pc-windows-msvc`
  cross-check — deliberately not chosen (see the `#[cfg(windows)]` note
  above); the Windows runner checks the exact code that ships.
- A `rust` boolean input or a path filter — no new dispatch shape; the
  job always runs, like `unit`.
- Skipping the web build (fetch-alone icon, placeholder icon) — unproven
  from here; a follow-up simplification once the job is green, not
  assumed now.
- Any change to `hermes-dots-desktop.yml`, the release workflow, or the
  dispatch command.
- The hermes-dots `AGENTS.md` CI line ("otherwise only the unit job
  runs") goes stale when this lands — a one-line follow-up in hermes-dots,
  not this friday change.

## Tests

A workflow change has no unit tests; the verification is the CI run
itself, on a real PR head, with a RED control. Order matters: GREEN
first (it proves the prep steps work), then RED (only meaningful once
GREEN passes — otherwise a red job could be a broken prep step, not
broken Rust):

- **GREEN:** dispatch from the friday PR branch with `-f ref=<current
  hermes-dots main SHA>` (or the #198 merge SHA). Expect all jobs green
  including `rust`; verify in the rust job log that it checked out exactly
  that SHA, that the Icons step generated `icons/icon.ico`, and that
  `cargo check` finished with no errors. Note the cold wall-clock time
  against the 30-minute timeout. If GREEN fails on the missing `uv.exe`
  resource, see the P1-2 build note in the appendix.
- **RED control:** a scratch branch in hermes-dots with a one-line type
  error in `desktop/src-tauri/src/main.rs` (break a type, nothing else).
  Dispatch the CI workflow from the friday PR branch with
  `-f ref=<scratch SHA>`. Expect the `rust` job to FAIL while `unit`
  passes — that proves the job actually checks the Rust instead of
  passing vacuously. Delete the scratch branch afterwards.
- **Cache warm-up (optional, same dispatch):** dispatch a second time on
  the same ref and note the rust job time — it should drop to the
  2–5 min range.
- **YAML validity:** parse the edited file locally before opening the PR
  (`python3 -c yaml.safe_load`); the dispatch is the real proof.
- The friday PR is presented only with the GREEN dispatch above on the
  PR branch's workflow file. The driver records `ci-success` on the run
  the same way as for hermes-dots PRs.

## Host acceptance (on Darren's PC, via friday-claude + Darren)

None — this is a CI-only change. No host, no device, no install, no
Darren action. The proof is the green run plus the RED control above.
The first hermes-dots PR that touches `desktop/src-tauri` after this
merges is the live confirmation that the gate catches Rust breakage
before merge instead of after.

## Process note

Driver state (`init`, triage, `repro`, `plan`, plan approval) and the
`loop.py issue --ref` recording of accepted-risk findings happen at build
time — same as the #194/#196 plan workers. This plan file is not
committed in the clone; the build commits it byte-identical. JEV
adjudication happens at `loop.py record` time in the build phase
(advisory only). No execution-risk hold hit this clone (it cloned
cleanly); verification was read-only. Reproduction: none — this is a
feature (a new CI job), and `loop.py repro` refuses non-bug kinds; the
RED control above is the failing control instead. Triage judgement: full
lane (a workflow change with a cross-repo gate effect, not a trivial
one-liner).

## Review appendix

### Round 1 — REQUEST_CHANGES (dirty: 1 High)

0 Critical, 1 High, 1 Medium, 2 Low, 0 Nit. The High (P1-1) is fixed in
the plan below; the Medium/Low findings are closed as accepted-risk
(recorded here, per the brief — driver recording via `loop.py issue
--ref` happens at build time). Ponytail-review: "Lean already. Ship."

- P1-1 (High, fixed in the plan) — the rust job would fail on clean
  hermes-dots main before any Rust was type-checked: `icons/icon.ico`
  does not exist in the checkout, and tauri-build's build script
  hard-errors on Windows when it is missing. Fixed: the job now builds
  the real web dist (fetch persona media + `npm ci` + `npm run build`)
  and runs the desktop workflow's Icons step before `cargo check`; the
  empty-`mkdir -p web/dist` shortcut is gone. Verified independently by
  the plan author against the tauri-build source (docs.rs, latest):
  `try_build` copies `bundle.resources` unconditionally with `?`, and
  the Windows block errors when the window icon path does not exist,
  then `res.compile()` (so the icon must be a valid `.ico`, not just an
  existing file — the placeholder-icon idea is out). The QUESTIONS block
  gains the fetch-vs-build question; the cost estimate is now 8–15 min
  cold; the Tests section runs GREEN before RED so a red job means broken
  Rust, not broken prep.
- P1-2 (Medium, accepted-risk) — a second generated-at-build-time input
  is also absent and unaddressed: `bundle.resources` lists `uv/uv.exe`,
  not in the checkout (the desktop workflow downloads it). The
  resource copy in `try_build` is unconditional with `?` propagation,
  so this may fail the build script too — but the glob-resolution
  semantics for a missing literal path were not fully proved, and the
  P1-1 icon failure would have masked it on the first run. Build note:
  the GREEN run decides; if it fails on `uv.exe`, add the pinned
  uv-download step copied verbatim from `hermes-dots-desktop.yml`
  (`UV_VERSION: '0.13.9'`, same SHA256, `7z e uv.zip uv.exe -ouv -y`
  with `working-directory: desktop/src-tauri`) before `cargo check`
  and re-verify GREEN.
- P1-3 (Low, accepted-risk) — the `main.rs` cfg count is wrong: 9
  `#[cfg(windows)]` + 4 `#[cfg(not(windows))]` = 13 splits (14 cfg lines
  incl. one `cfg_attr`), not "24 sites". Build note: the correct count
  is 13; no design impact — the Windows-only code genuinely exists and
  the windows-latest choice stands.
- P1-4 (Low, accepted-risk) — the quoted header-comment original omits
  ", never on the self-hosted runner", and the proposed replacement drops
  that clause. Build note: keep the clause in the replacement line —
  "All jobs run on GitHub-hosted cloud runners; unit and smoke on
  ubuntu-latest, rust on windows-latest (the app ships on Windows, so the
  check runs where it ships), never on the self-hosted runner."

### Round 2 — APPROVE (clean)

0 Critical, 0 High, 0 Medium, 3 Low, 1 Nit. The P1-1 fix is verified
correct (prep sequence reproduces the desktop workflow's proven path;
each input exists when needed; the Icons command paths are correctly
translated to repo root). The P1-2/P1-4 appendix entries are accurate.
QUESTIONS all answered or explicitly assumed; cost estimate labelled
with first-run measurement; GREEN-before-RED order correct.
Ponytail-review: "Lean already. Ship."

- P2-1 (Low, accepted-risk) — the plan asserts every action in
  `hermes-dots-ci.yml` is pinned by full SHA, but the design specifies
  `actions/setup-node@v4` (unpinned). Build note: pin setup-node by SHA
  at build time (look up the current v4 SHA then); the body claim stays
  as written.
- P2-2 (Low, accepted-risk) — the Icons step states no
  `working-directory`, while the npm and cargo steps state one, and the
  step is described as copied from the desktop build job (cwd
  `desktop/src-tauri`) while the plan's command uses root-relative paths.
  Build note: run the Icons step at the repo root (default cwd); do not
  use the desktop build job's `desktop/src-tauri` cwd with these paths.
  The literal command is correct at repo root.
- P2-3 (Low, accepted-risk) — the appendix P1-2 rationale has the
  masking direction backwards: `copy_resources` runs BEFORE the Windows
  icon block, so a `uv.exe` resource failure would mask the icon
  failure, never the reverse. Build note: the P1-2 build note (GREEN
  decides; add the pinned uv step if GREEN fails on `uv.exe`) is correct
  either way; correct the masking direction in the record.
- P2-4 (Nit, accepted-risk) — the Tests GREEN bullet says "(or the #198
  merge SHA)" but #198 may not be merged at build time. Build note:
  dispatch GREEN on the current hermes-dots main SHA.
