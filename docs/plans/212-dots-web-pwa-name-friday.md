QUESTIONS
q: How does a static manifest file carry a dynamic name? | a: Server-side substitution (approach a). `server.mjs` parses the built manifest and sets `name`/`short_name` from a validated `?name=` query parameter; the client appends it to the manifest link href in `setAppIcon`, which already re-points that link whenever the agent list changes. No manifest file is edited.
q: Why not a client-generated manifest (blob:/data: URL)? | a: Rejected. Chrome requires a same-origin manifest — a runtime-built blob: manifest is a known non-installable pattern (the manifest URL is what `start_url`/`scope` resolve against and they must stay on its origin), and iOS Safari reads the manifest only from a same-origin link. The server substitution keeps a plain same-origin URL.
q: What name shows before anything is paired? | a: "Hermes" — the static manifest, the static `index.html` title, and the `appName` fallback. There is no first agent to read yet, and hardcoding "Friday" as the fallback would reintroduce exactly the hardcoding Darren asked to remove.
q: Which agent's name — first connected, or the active one? | a: First connected: `agents[0]` in store order (`mergeAgents` appends new pairings at the end, so `agents[0]` is the oldest surviving pairing). Opening a second agent never renames the PWA. For Darren the first agent is Friday, so his PWA still says Friday.
q: What if the first agent is removed, or the user re-pairs to a different phone? | a: `agents[0]` becomes the next-oldest paired agent and the name follows it (tab title immediately; installed name on the platform refresh schedule). A re-pairing merges new agents in behind the existing ones, so the first agent — and the name — is unchanged. No agents at all: back to "Hermes".
q: Pairing screen — which strings change, and what about "Open Friday on your phone"? | a: The title and step 1 become functions of the app name: "{name} in your browser" / "Open {name} on your phone" (both locales). The honest wrinkle: step 1 names the agent, not the phone app the user must open — the phone launcher still says Hermes, so a first-time user looking for "Friday" in their app list will not find that label. That is what Darren asked for ("name everything the same"); renaming the phone launcher is a separate hermes-dots decision, out of scope. The QR label and the from-link note stay "Hermes": they name the phone app that does the scanning, and there is no "Friday app" on the phone.
q: Do the other "Hermes" strings change — agent-name fallbacks, pairing validation default? | a: No. `crypto.ts:149` stays "Hermes": it is the default for a nameless agent arriving in the pairing payload, and it feeds the dynamic name (a nameless first agent is consistently called Hermes everywhere). `ChatApp.tsx:185` and `ChatView.tsx:48` stay: they already show the agent's own name when known, and "Hermes" is only the unknown-name fallback. The `GatewayClient.ts` / `toolLabels.ts` mentions are code comments naming the product, not a user-visible name.
q: What does the CI smoke test assert now? | a: Unchanged: `.github/workflows/test.yml:363` still greps `<title>Hermes`. `curl` runs no JS, so it can only ever see the static served title — which is now the pre-pairing fallback by design. The dynamic title is covered by the new JS test instead (see Verification).
q: How does this sequence with #211's seven new per-logo manifests? | a: Order-independent, and #211's manifests need no content change: their static name stays "Hermes" (the correct pre-pairing fallback) and the server substitutes at serve time, whichever manifest file the link points at. The shared touch points are `appIcon.ts` and the `setAppIcon` call in `ChatApp.tsx` — whichever PR merges second rebases those. This change touches no manifest file, so the old manifest conflict is gone.
q: What happens for an already-installed PWA? | a: Same platform limit as #211's icon and the old plan: Chrome on Android refreshes the installed name via WebAPK when the manifest changes, all PWA windows closed, charging on Wi-Fi, manifest checked at most once a day on launch; desktop Chrome/Edge never replace the installed name; iOS Safari never refreshes it — delete and re-add. A fresh install after pairing shows the first agent's name immediately. An install made before pairing shows "Hermes" until the refresh or a reinstall.

## Plan change since 29386e44… (revision, static → dynamic)

Darren redirected the design (issuecomment-6802869209): no hardcoded
"Friday" — the PWA name follows the first agent that was connected,
and the pairing screen changes too. The old plan renamed static
strings to "Friday"; this revision replaces it wholesale:

- The four static manifests and `index.html` do NOT change any more
  (they are the pre-pairing fallback, "Hermes"), and the CI title grep
  at `test.yml:363` does NOT change either. The old plan's steps 1, 2
  and 5 are deleted.
- The name is dynamic instead: a one-line `appName(agents)` helper
  (`agents[0]?.name || "Hermes"`), the tab/unread title takes it, the
  manifest link carries it as `?name=`, and `server.mjs` substitutes
  it into the served manifest. Pairing-screen title + step 1 take it
  as a prop.
- The old RED control (`tests/test_issue_212.py`, static "Friday" in
  the manifests and the title) is superseded: the static files no
  longer change, so those assertions would be wrong at HEAD. The new
  RED control is the JS tests below; the implementation phase
  supersedes the recorded repro with them (`loop.py repro
  --supersede`) before the tests gate.
- File count 7 → 7, but a different 7: no manifest files, no
  `index.html`, no workflow file; instead `server.mjs`,
  `src/appIcon.test.ts` (new), and the `main.tsx` prop.

# Plan: dots-web PWA name follows the first connected agent (#212)

Issue: darrencjh8/friday#212
Base: friday main `98aaa85`
Kind: bug (installed PWA is named Hermes)

## Fact-check (verified 2026-11-12, live main)

- All four manifests in `modules/dots-web/public/` — `manifest-galet`,
  `manifest-nova`, `manifest-nuage`, `manifest-pave.webmanifest` — have
  `"name": "Hermes"` and `"short_name": "Hermes"`. Everything else is
  identical across the four except the `icons` array. The `id` is `"/"`
  in all four; `start_url` and `scope` are `"/"`. These stay as they
  are: they are the manifest the browser reads before anything is
  paired.
- `modules/dots-web/index.html:13` has `<title>Hermes</title>`. It
  stays: it is the title before JS runs, and the only title a `curl`
  smoke test can see.
- `useUnreadTitle` (`modules/dots-web/src/chat/ChatApp.tsx:193-208`)
  sets `document.title` from `const base = "Hermes"` (line 197) on
  mount and on every unread change (`(3) Hermes` with unread). It
  already receives `agents`, so the base can come from the first
  agent with no signature change.
- No `apple-mobile-web-app-title` meta exists in `index.html`, so
  there is no third name to change; iOS takes the name from the
  manifest.
- `setAppIcon` (`modules/dots-web/src/appIcon.ts`) already re-points
  the manifest link in the page (`link[rel="manifest"]`) whenever the
  agent list changes — `ChatApp.tsx` calls it in an effect on
  `[active, agents]`. The dynamic name rides that same link swap:
  the href gains `?name=`. #211 (branch
  `fix/issue-211-dots-web-pwa-icon`, head `9e48dca`, not merged)
  extends the same function with a launcher-icon argument; this
  change adds the name alongside it, in whichever order the two
  land (see the call-site note in The change).
- The store (`modules/dots-web/src/store.ts`) keeps paired agents in
  localStorage (`dots.agents.v1`) in pairing order: `mergeAgents`
  appends incoming agents after the existing ones, `removeAgent`
  filters one out. So `agents[0]` is the first agent that was
  connected and still is. Each `WebAgent` (`src/types.ts`) carries a
  `name` from the phone's pairing payload.
- The server (`modules/dots-web/server.mjs`) serves static files from
  `dist/` as-is: `serveFile` reads the file for `url.pathname` and
  answers with its content type (`.webmanifest` →
  `application/manifest+json`). The query string is ignored today,
  so `?name=` needs a branch in the manifest path — and only there.
  No caching headers are set today, so a substituted response needs
  its own `Cache-Control: no-store`.
- The pairing name is capped at the source: `pairing/crypto.ts`
  trims agent names to 24 code points (`MAX_NAME`) and defaults an
  empty name to `"Hermes"` (line 149). The server still must not
  trust the query string: a hand-crafted `?name=` could be longer
  or hostile, so the substitution sanitises it itself (see step 1).
- `PairingScreen` (`src/pairing/PairingScreen.tsx`) takes no name
  today: `main.tsx` renders it bare when no agent is paired, and
  `ChatApp.tsx` renders it in an overlay (only `onCancel`) when
  adding an agent. Its strings use the `strings({en, fr})` helper
  and function-valued strings are the established pattern there
  (`refresh: (n) => …`, `success: (names) => …`), so the title and
  step 1 become functions of the name the same way.
- The name is only a display string: no code reads `name` or
  `short_name` from a manifest, no service worker exists in
  dots-web, and the manifest `id` does not change — so the installed
  app keeps its identity and the update path in the QUESTIONS block
  applies.
- Full "Hermes" inventory in dots-web (repo-wide grep, 2026-11-12):
  the 4 manifests, `index.html`, `server.test.mjs` (fixture +
  assertions on served HTML), `ChatApp.tsx:185,197`,
  `ChatView.tsx:48`, `PairingScreen.tsx` (title, step1, qrLabel,
  fromLink, both locales), `crypto.ts:149`, and two code comments
  (`GatewayClient.ts:22`, `toolLabels.ts:4`). Nothing in
  `vercel.json`, `package.json`, `Dockerfile` or the README. Every
  one is decided in the QUESTIONS block or The change below.
- Repro (superseded — see Plan change): the recorded
  `tests.test_issue_212` asserted static "Friday" in the manifests
  and the title. That is no longer the fix, so the implementation
  phase replaces it with the JS tests in Verification.

## The change (7 files)

1. `modules/dots-web/server.mjs` — in the request handler, when the
   pathname ends `.webmanifest` and `?name=` is present: read the
   built manifest, `JSON.parse` it, set `name` and `short_name` to
   the sanitised name, and serve the re-serialised JSON with
   `application/manifest+json` plus `Cache-Control: no-store`.
   Sanitise: trim, strip control characters, cap at 24 code points
   (the pairing cap), empty after sanitising → serve the static
   file unchanged. JSON-safe by construction: parse → assign →
   stringify, never string interpolation into JSON text. Without
   `?name=`, the static file is served exactly as today. The
   substituted name is only ever shown to the browser that asked
   for it (tailnet-only server, per-browser install), so a
   hand-crafted query can rename only the requester's own PWA.
2. `modules/dots-web/src/appIcon.ts` — add the one-line helper
   `appName(agents: WebAgent[]): string`, returning
   `agents[0]?.name || "Hermes"`, next to `setAppIcon` (the module
   that already owns the app's tab icon and manifest link).
   `setAppIcon` takes the app name as a new argument and appends
   `?name=${encodeURIComponent(appName)}` to the manifest href it
   already sets; the icon hrefs are untouched. Final signature
   depends on merge order with #211: if #211 has merged first,
   `setAppIcon(species, launcherIcon?, appName?)`; if this lands
   first, `setAppIcon(species, appName?)` and #211 adds its
   argument. Either way the href carries both the logo file and
   the `?name=`.
3. `modules/dots-web/src/chat/ChatApp.tsx` — `useUnreadTitle` takes
   its base from `appName(agents)` instead of the `"Hermes"`
   literal; the `setAppIcon` effect passes `appName(agents)`; the
   pairing overlay passes `appName={appName(agents)}` to
   `PairingScreen`.
4. `modules/dots-web/src/pairing/PairingScreen.tsx` — take an
   `appName` prop (default `"Hermes"`); title and step 1 become
   functions of it: en `"{name} in your browser"` /
   `"Open {name} on your phone"`, fr `"{name} dans ton
   navigateur"` / `"Ouvre {name} sur ton téléphone"`. The QR label
   and the from-link note stay "Hermes" (they name the phone app
   that scans). Subtitle, steps 2–3, footer: unchanged.
5. `modules/dots-web/src/main.tsx` — pass
   `appName={appName(agents)}` to the bare `PairingScreen`
   (no agents → the `"Hermes"` fallback).
6. `modules/dots-web/server.test.mjs` — the manifest fixture
   becomes a realistic manifest (`{id: "/", name: "Hermes",
   short_name: "Hermes", …}`; today it is `"{}"`, which cannot
   show a substitution). New tests: `?name=Friday` serves JSON
   with `name`/`short_name` `"Friday"` and a manifest content
   type; no `?name=` serves the static `"Hermes"`; a hostile
   over-long name serves valid JSON with the name capped at 24.
7. `modules/dots-web/src/appIcon.test.ts` (new) — same minimal
   fake-`document` pattern as #211's `appIcon.test.ts`:
   `appName([])` → `"Hermes"`; first agent named `"Friday"` →
   `"Friday"`; a second agent named differently is ignored; a
   first agent with an empty name → `"Hermes"`; `setAppIcon`
   always sets the manifest href with the encoded `?name=` (no
   special case for the fallback — substituting "Hermes" into a
   "Hermes" manifest is identical, and the `no-store` on the
   substituted response is what lets the installed name follow a
   later change).

## What does not change (out of scope, on purpose)

- The four static manifests, `index.html`, and the CI title grep —
  they are the pre-pairing fallback by design (see QUESTIONS).
- The agent-name fallbacks and the pairing validation default
  (`crypto.ts:149`, `ChatApp.tsx:185`, `ChatView.tsx:48`) — they
  already follow the agent name when known; "Hermes" is only the
  unknown-name fallback.
- No change to manifest `id`, `start_url`, `scope`, `display`,
  colours, or icons; no new setting; no manifest URL versioning
  beyond the `?name=` the client already varies per logo/species.
- No change to the phone app: its launcher name stays Hermes, so
  the pairing step 1 names the agent rather than the app label
  (recorded wrinkle, see QUESTIONS).

## Verification

- RED control (new, replaces the recorded Python repro — fails at
  base and passes after the implementation lands at the
  implementation HEAD): `node --test src/appIcon.test.ts` —
  `appName` returns the first agent's name and the manifest href
  carries the encoded `?name=` (at base there is no `appName`
  export and no `?name=` in the href); `node --test
  server.test.mjs` — the `?name=Friday` manifest test fails at
  base (the server ignores the query and serves the static
  "Hermes") and passes at HEAD. The implementation phase supersedes
  the recorded repro with these two commands (`loop.py repro
  --supersede`) before the tests gate.
- Existing gates, unchanged: `node --test server.test.mjs`
  (fixture + new manifest tests), `npm run build` (`tsc --noEmit
  && vite build`), and the CI `dots-web` job
  (`.github/workflows/test.yml`: node 24, server tests, docker
  build + smoke curl of `/` and `/api/pair`, plus the title grep at
  :363 still asserting `<title>Hermes` — the static fallback).
  Each served manifest is re-validated as JSON after the edit
  (the substitution test parses it).
- Manual (Darren's phone is the acceptance): pair the phone → the
  tab title shows "Friday" (or "(N) Friday" with unread messages);
  the pairing screen title and step 1 show "Friday"; a fresh PWA
  install shows "Friday" on the home screen and in the app list.
- Installed-PWA honesty: an already-installed PWA may keep showing
  "Hermes" until the browser refreshes it (Android WebAPK
  conditions above) or until it is deleted and re-installed
  (desktop Chrome/Edge, iOS) — the change cannot force that, and
  the plan does not claim otherwise. An install made before
  pairing shows "Hermes" until the same refresh or reinstall.

## Implementation (after approval)

1. One PR in friday, branch `fix/issue-212-dots-web-pwa-name`: the
   `server.mjs` substitution, the `appIcon.ts` helper + href, the
   `ChatApp.tsx` / `PairingScreen.tsx` / `main.tsx` wiring, the two
   test files — then the RED control green at HEAD, the existing
   dots-web gates, and a code-review round. The old
   `tests/test_issue_212.py` repro is deleted as part of the
   supersede (it asserts the superseded static rename).
2. Darren verifies on his phone (pair → "Friday" in the tab, the
   pairing screen, and a fresh install; already-installed PWA
   follows the platform refresh or a reinstall) and merges.
