QUESTIONS
q: How does the phone's launcher-icon selection reach the web app? | a: The phone sends it in the pairing payload, the same channel that already carries species/palette/accessory — WebPairer.kt adds one `.put("launcher_icon", ...)` per agent, and the web stores it on the WebAgent in localStorage. No web-side picker, no live push.
q: What is the icon before any choice is made, or when the phone has not sent one? | a: Unchanged — today's Nova half-body photo (nova-192/512.png, manifest-nova.webmanifest). "default" and any unknown/missing value resolve to it.
q: Do the icon files needed already exist in the repo, or must they be generated? | a: They must be derived: the 7 square Friday portraits live only in hermes-dots as adaptive-icon foregrounds (drawable-nodpi webps, full-bleed on their background colour). The implementation resizes each to 192/512 PNG and commits the 14 files under public/icons/. No new photo generation.
q: Can the phone supply the choice live, or only at pairing? | a: Only at pairing. The gateway hello replays chat, not appearance, so a selection changed on the phone reaches the web after the next QR re-pairing.
q: How does a changed choice take effect for an already-installed PWA? | a: The tab icon and apple-touch-icon change on the next load (plain link swaps). The installed home-screen icon only changes when the browser re-reads the manifest: Chrome on Android updates it via WebAPK once the manifest changed, all PWA windows are closed, and the device is charging on Wi-Fi (manifest checked at most once a day on launch); desktop Chrome/Edge never replaces the installed icon; iOS Safari never refreshes it — delete and re-add. An already-installed PWA may need a reinstall to show the new icon; fresh installs get it right away.
q: Does the logo apply when the active agent is not Nova? | a: No. The logos are Friday portraits, so they only replace the Nova icon; galet/nuage/pave keep their species icons. (Android's launcher icon is global, so this diverges from the phone when a non-Nova agent is active; accepted.)
q: Must the hermes-dots phone change land first? | assumption: No — the web field is optional and defaults to today's icon, so the friday change is safe to land first; the phone side follows as a companion change in hermes-dots. The implementer verifies the field name matches on both sides.

# Plan: dots-web PWA icon follows the launcher-icon selection

Issue: darrencjh8/friday#211
Base: friday main `98aaa85`
Kind: bug (PWA/tab icon ignores the logo selection)

## Fact-check (verified 2026-11-12, live main)

- `modules/dots-web/src/appIcon.ts:7-11`: `setAppIcon(species)` only switches
  icon / apple-touch-icon / manifest per species (`/icons/${species}-192.png`,
  `/manifest-${species}.webmanifest`). It takes no logo choice.
- `modules/dots-web/src/chat/ChatApp.tsx:74`: the only caller,
  `setAppIcon(active.species)`, runs when the active agent changes.
- `modules/dots-web/public/manifest-nova.webmanifest`: lists nova-192/512.png
  for both `any` and `maskable`. `index.html:11-13` links icon,
  apple-touch-icon and manifest to the Nova files by default.
- `modules/dots-web/public/icons/nova-192.png` (verified by viewing it) is the
  half-body office photo; the 8 launcher logos are square head-and-shoulders
  portraits. No per-logo icon or manifest exists in the friday repo.
- The 8 logos live only in hermes-dots: `LauncherIcon` in
  `app/src/main/kotlin/app/dotshermes/ui/AppIcon.kt` — keys `default`, `blue`,
  `lavender`, `teal`, `pink`, `peach`, `white`, `office`; the 7 Friday
  foregrounds are `app/src/main/res/drawable-nodpi/ic_launcher_friday_<key>_foreground.webp`
  (square, ~1420px, full-bleed portrait on its background colour). The choice
  is stored as `DotAppearance.launcherIcon` (`AppearanceStore.kt:28-29`,
  default `"default"`).
- The channel already exists: the phone transmits the agent's appearance in
  the pairing deposit (`WebPairer.kt:108-119` puts `species`, `palette`,
  `accessory` per agent; spec in hermes-dots `docs/appairage-web.md:53-62`),
  and the web validates it field-by-field in
  `modules/dots-web/src/pairing/crypto.ts` (`validAgent`, allowlist via
  `pick()` — a new field must be added there or it is dropped) and persists
  the whole `WebAgent` as JSON in localStorage (`store.ts:13-30`,
  `mergeAgents`/`saveAgents`), so a new field flows through with no store
  change.
- hermes-dots #49 plan said "Web: no launcher icon (PWA manifest icons are
  build-time). Out" — this plan supersedes that note: the manifest stays
  build-time (one static file per logo), and the *selection* travels at
  pairing time instead.
- `appIcon.ts` is local to friday (added in #180, `1263933`), not a vendored
  upstream file, so editing it has no vendor-sync cost. There is no service
  worker in dots-web, so no SW cache layer stands between the browser and
  the manifest.
- Repro (recorded): `appIcon.launcherIcon.blue` fails at base
  (`node --test src/appIcon.test.ts` in `modules/dots-web`) — with a blue
  logo requested, the icon href stays `/icons/nova-192.png`. The other four
  cases in the same file pass at base (default, unknown, non-Nova, missing).

## The change (friday side)

Naming follows the existing convention (`<species>-192.png`,
`manifest-<species>.webmanifest`): per-logo files are
`nova-<key>-192.png` / `nova-<key>-512.png` and
`manifest-nova-<key>.webmanifest` for the 7 explicit keys. `Default` keeps
today's `nova-192/512.png` and `manifest-nova.webmanifest`; no new files
for it. Manifests keep `name`/`short_name`/`theme_color`/`background_color`
identical to `manifest-nova.webmanifest` — only the `icons` array changes,
and as today the same file serves both `any` and `maskable`.

1. `modules/dots-web/src/types.ts`: add `launcher_icon` to `WebAgent` —
   the wire key, following the `session_id` / `agent_id` precedent (property
   name = wire key). Type it as the 8-key union (`"default" | "blue" |
   "lavender" | "teal" | "pink" | "peach" | "white" | "office"`).
2. `modules/dots-web/src/pairing/crypto.ts`: in `validAgent`, pick
   `launcher_icon` from the payload against the same 8-key allowlist,
   falling back to `"default"` for an unknown or missing value (same
   `pick()` pattern as species/palette/accessory). Without this step the
   field is dropped by validation and the fix silently does nothing.
3. `modules/dots-web/src/appIcon.ts`: `setAppIcon(species, launcherIcon?)`.
   When the species is `nova` and the key is one of the 7 explicit logos,
   point the three links at the per-logo files; everything else (default,
   unknown, missing, non-Nova species) keeps today's species files.
   One function, no new module, no new setting.
4. `modules/dots-web/src/chat/ChatApp.tsx:74`: pass the stored choice —
   `setAppIcon(active.species, active.launcher_icon)`. Old stored agents
   (paired before this change) have no field; `undefined` means default.
5. Seven manifests + fourteen PNGs, all static files under `public/`:
   `manifest-nova-<key>.webmanifest` per explicit key, and
   `icons/nova-<key>-192.png` / `icons/nova-<key>-512.png` resized from
   the matching hermes-dots foreground webp (full-bleed already, so resize
   only — no compositing, no new photo). `index.html` is untouched.
6. `modules/dots-web/src/appIcon.test.ts` (already written as the repro):
   five cases — blue logo switches all three links, default keeps Nova,
   unknown key falls back to Nova, non-Nova species ignores the logo,
   missing choice keeps Nova.

## Companion change (hermes-dots, separate issue — not this PR)

- `WebPairer.kt:payload()`: one line, `.put("launcher_icon",
  g.look.launcherIcon)`, next to the existing `species`/`palette`/
  `accessory` puts. `docs/appairage-web.md` gains the field in the agents
  example. The friday side lands first: until the phone sends the field,
  every agent reads as default and nothing changes.

## What does not change (out of scope, on purpose)

- No launcher-icon picker or settings UI in the web client — the phone owns
  the selection; the web only follows it. No second source of truth.
- No live push of a changed selection: after changing the logo on the
  phone, the web picks it up on the next QR re-pairing.
- No change to galet/nuage/pave icons, to `index.html` defaults, or to the
  pairing crypto itself (v1, same keys, same deposit shape plus one field).
- No service worker, no manifest URL versioning, no cache-busting renames:
  the per-logo files are new names, so a fresh install can never serve a
  stale icon from the old URLs.

## Verification

- RED control (recorded at base, replayed green at HEAD):
  `cd modules/dots-web && node --test src/appIcon.test.ts` — the
  `appIcon.launcherIcon.blue` case fails at base and passes at HEAD; the
  other four pass at both. Same file also covers the `crypto.ts` allowlist
  only indirectly — add one case there if the implementer splits
  validation coverage: a payload with `launcher_icon: "blue"` survives
  `validatePayload`, an unknown value becomes `"default"`. (Only if it
  fits the existing `crypto.ts` test shape; do not build a second harness.)
- Existing gates, unchanged: `node --test server.test.mjs`,
  `npm run build` (`tsc --noEmit && vite build`), and the CI `dots-web`
  job (`.github/workflows/test.yml`: node 24, server tests, docker build +
  smoke curl of `/` and `/api/pair`). The new PNGs/manifests are static
  files; verify each manifest parses as JSON and its four icon `src` paths
  resolve to files in `public/icons/`.
- Manual (Darren's phone is the acceptance): pair with a phone build that
  sends `launcher_icon: "blue"` — the tab icon becomes the blue portrait
  and a fresh PWA install shows the blue portrait on the home screen;
  change the selection on the phone, re-pair, and the icon follows. The
  generated PNGs are eyeballed once against the hermes-dots foregrounds
  (same portrait, same background).
- Installed-PWA honesty: an already-installed PWA may keep the old icon
  until the browser refreshes it (Android WebAPK conditions above) or
  until it is deleted and re-installed (desktop Chrome/Edge, iOS) — the
  change cannot force that, and the plan does not claim otherwise.

## Implementation (after approval)

1. One PR in friday, branch `fix/issue-211-dots-web-pwa-icon`: the
   `types.ts` + `crypto.ts` + `appIcon.ts` + `ChatApp.tsx` edits, the 7
   manifests, the 14 PNGs, and the test file — then the RED control green
   at HEAD, the existing dots-web gates, and a code-review round.
2. Separate hermes-dots issue/PR for the one-line `WebPairer.kt` change +
   spec-doc line; file it when the friday PR opens so the field name is
   pinned on both sides before either merges.
3. Darren verifies on his phone (fresh install shows the selected logo;
   re-pair after changing the selection follows it) and merges.
