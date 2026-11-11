QUESTIONS
q: Does the name change in all four manifests or only the Nova one? | a: All four. The manifest name is the app name, not the agent name: one installed app, one name. The manifest linked at install time depends on which agent was active, so renaming only Nova would make the installed name depend on install-time species (Friday if Nova was active, Hermes otherwise). The agent identity is expressed by the icon, not the name. The `id` is "/" in all four — same app identity, unchanged.
q: Does the browser tab title change too, or only the manifest name? | a: Both, and the tab title needs two lines, not one: `index.html:13` `<title>` plus the `base` in `useUnreadTitle` (`ChatApp.tsx:197`), which sets `document.title` on mount and on every unread change — an `index.html`-only rename reverts to "Hermes" the moment the app loads.
q: How does the rename sequence with #211's seven new per-logo manifests? | a: Order-independent, cheapest if this lands first. #211's plan says its new manifests keep `name`/`short_name` identical to `manifest-nova.webmanifest` (hash 2af21e9e…, `docs/plans/211-dots-web-pwa-icon-follows-logo-selection.md`, read in the #211 clone), so they inherit "Friday" automatically when #211 is implemented after this. If #211 lands first, this rename covers its seven manifests too — the implementer renames every `manifest-*.webmanifest` present at implementation time (4 files today, 11 if #211 has merged). Both PRs touch `manifest-nova.webmanifest`, so whichever merges second rebases. The fallback rule stands regardless of the inheritance claim.
q: What happens for an already-installed PWA? | a: Same platform limit as #211's icon: Chrome on Android refreshes the installed name via WebAPK when the manifest changes, all PWA windows closed, charging on Wi-Fi, manifest checked at most once a day on launch; desktop Chrome/Edge never replace the installed name; iOS Safari never refreshes it — delete and re-add. A fresh install shows "Friday" immediately.
q: Do the other "Hermes" strings in dots-web change — agent-name fallbacks and pairing-screen copy? | a: No. They name the phone app / gateway agent, not this PWA: the header fallback (`ChatApp.tsx:185`, `ChatView.tsx:48`, `pairing/crypto.ts:149`) and the pairing copy ("Open Hermes on your phone", `PairingScreen.tsx`). Renaming the phone app is a different product decision in hermes-dots, not this issue.

## Plan change since 409b2a02… (round-1 plan, CHANGES, 1 High + 1 Low + 1 Nit)

Round 1 found one real miss, so this revision fixes it and folds
the two wording fixes in — one mutation, one fresh clean round.
Everything else is unchanged.

- H1 (CI title grep): the plan omitted
  `.github/workflows/test.yml:363`, which pins `<title>Hermes` in
  the `dots-web` job's image smoke test. Added as step 5, plus a
  fact-check bullet and the grep in Verification. File count
  6 → 7.
- L1 (RED-control wording): "replayed green at HEAD" reworded to
  "fails at base and passes after the implementation lands at the
  implementation HEAD" — the plan HEAD itself still fails the
  repro.
- N1 (#211 citation): the inheritance claim now cites the #211
  plan hash and file, verified by reading it in the #211 clone;
  the fallback rule stands regardless.

# Plan: dots-web PWA name is Friday, not Hermes (#212)

Issue: darrencjh8/friday#212
Base: friday main `98aaa85`
Kind: bug (installed PWA is named Hermes)

## Fact-check (verified 2026-11-12, live main)

- All four manifests in `modules/dots-web/public/` — `manifest-galet`,
  `manifest-nova`, `manifest-nuage`, `manifest-pave.webmanifest` — have
  `"name": "Hermes"` and `"short_name": "Hermes"`. Everything else is
  identical across the four except the `icons` array. The `id` is `"/"`
  in all four; `start_url` and `scope` are `"/"`.
- `modules/dots-web/index.html:13` has `<title>Hermes</title>`.
- `useUnreadTitle` (`modules/dots-web/src/chat/ChatApp.tsx:193-208`)
  sets `document.title` from `const base = "Hermes"` (line 197) on
  mount and on every unread change (`(3) Hermes` with unread).
  Verified by reading the hook: an `index.html`-only rename is
  reverted on load.
- No `apple-mobile-web-app-title` meta exists in `index.html`, so
  there is no third name to change; iOS takes the name from the
  manifest.
- `modules/dots-web/server.test.mjs` pins the old name in four
  places: the fixture it writes (`<title>Hermes</title>`, line 17)
  and three `/Hermes/` assertions on served responses (lines 43,
  48, 59 — `/`, `/pair`, and the traversal-fallback responses all
  serve the fixture `index.html`). The test's purpose is serving
  the app, not the title string; the assertions follow the rename.
- The CI `dots-web` job pins the old title a second time, outside
  the test file: `.github/workflows/test.yml:363` smoke-tests the
  real built image with
  `curl -fsS http://127.0.0.1:8789/ | grep -q '<title>Hermes'`
  (comment at :360: only the image proves the real build is
  served, not the `server.test.mjs` fixture). It is the only
  `title>Hermes` pin in the repo outside the plan's other files
  (verified by repo-wide grep). It must follow the rename or the
  job goes red on the PR.
- The name is only a display string: no code reads `name` or
  `short_name` from a manifest, no service worker exists in
  dots-web, and the manifest `id` does not change — so the
  installed app keeps its identity and the update path in the
  QUESTIONS block applies.
- Repro (recorded): `tests.test_issue_212.TestIssue212.test_manifests_named_friday`
  fails at base (`python3 -m unittest discover -s tests -p 'test_issue_212.py' -v`:
  3 tests, 5 failures — the manifest test on all 4 subtests plus the
  tab-title test; the identity guard passes). The test file sits
  untracked in the clone for the build phase.

## The change (7 files, ~15 lines)

1. All four `modules/dots-web/public/manifest-*.webmanifest`:
   `"name": "Friday"`, `"short_name": "Friday"`. Nothing else in
   the files changes.
2. `modules/dots-web/index.html:13`: `<title>Friday</title>`.
3. `modules/dots-web/src/chat/ChatApp.tsx:193,197`: the comment
   (`« (3) Hermes »` → `« (3) Friday »`) and `const base = "Friday"`.
4. `modules/dots-web/server.test.mjs`: fixture `<title>Friday</title>`
   (line 17) and the three `/Hermes/` assertions → `/Friday/`
   (lines 43, 48, 59).
5. `.github/workflows/test.yml:363`: the image-smoke assertion
   `grep -q '<title>Hermes'` → `grep -q '<title>Friday'`.
   Without this step the CI `dots-web` job fails on the PR (the
   served page carries `<title>Friday</title>` after the rename).

If #211 has merged first, step 1 also renames its seven
`manifest-nova-<key>.webmanifest` files the same way (they copy
`name`/`short_name` from `manifest-nova`, so after this change
they say Friday too).

## What does not change (out of scope, on purpose)

- The agent/server name fallbacks and the pairing-screen copy (see
  QUESTIONS) — they name the phone app / gateway, not this PWA.
- No change to `id`, `start_url`, `scope`, `display`, colours, or
  icons in any manifest; no change to the icon files.
- No new files, no new setting, no manifest URL versioning: the
  manifest URLs stay the same, so the browser re-reads them on its
  normal schedule.

## Verification

- RED control (recorded at base, fails at base and passes after
  the implementation lands at the implementation HEAD):
  `python3 -m unittest discover -s tests -p 'test_issue_212.py' -v`
  — `test_manifests_named_friday` (4 subtests) and
  `test_tab_title_friday` fail at base and pass at HEAD;
  `test_manifest_identity_unchanged` guards that only the name
  changed (passes at both).
- Existing gates, unchanged: `node --test server.test.mjs`
  (fixture + assertions follow the rename),
  `npm run build` (`tsc --noEmit && vite build`), and the CI
  `dots-web` job (`.github/workflows/test.yml`: node 24, server
  tests, docker build + smoke curl of `/` and `/api/pair`, plus
  the title grep at :363 now asserting `<title>Friday`).
  Each manifest is re-validated as JSON after the edit.
- Manual (Darren's phone is the acceptance): a fresh PWA install
  shows "Friday" on the home screen and in the app list, and the
  tab shows "Friday" (or "(N) Friday" with unread messages).
- Installed-PWA honesty: an already-installed PWA may keep showing
  "Hermes" until the browser refreshes it (Android WebAPK
  conditions above) or until it is deleted and re-installed
  (desktop Chrome/Edge, iOS) — the change cannot force that, and
  the plan does not claim otherwise.

## Implementation (after approval)

1. One PR in friday, branch `fix/issue-212-dots-web-pwa-name`: the
   four manifest edits, the two title lines, the test-file edits,
   and the repro test — then the RED control green at HEAD, the
   existing dots-web gates, and a code-review round.
2. Darren verifies on his phone (fresh install shows "Friday";
   already-installed PWA follows the platform refresh or a
   reinstall) and merges.
