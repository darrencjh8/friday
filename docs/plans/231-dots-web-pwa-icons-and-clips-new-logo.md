QUESTIONS
q: The five web moods need still / thinking / idle / sleeping / speaking, but the accepted canonical loop set has no speaking or sleeping loop — generate two new short loops, or map those moods to still? | a: Generate two short loops from the current canonical day portrait via the established Friday loop workflow (same route as the accepted loops, first frame = portrait, verified frame-by-frame). Mapping talking to a static image would be a visible regression.
q: If a speaking / sleeping generation is not accepted, does the PR still ship the rest? | assumption: Yes — ship the icons plus still / thinking / idle and call out the remaining old clip(s) in the PR body, tracked on this issue. Do not block the icon fix on the two hardest clips.
q: What is the PWA / tab icon before any pairing, or for an unknown value — keep today's half-body Nova photo or move to the Default silhouette? | a: Move to Default (the black line-art silhouette, `nova-default-192/512.png`). The half-body photo is the old portrait (bionic arm), so it goes with the rest; delete `nova-192/512.png` and `manifest-nova.webmanifest`.
q: Day or night loop set for the transparent web cut-outs? | a: Day set only. The background key-out needs a light background (the #136 flood-fill key relies on near-white); the transparent result works on light and dark themes, as today.
q: Should the new icon-mapping tests run in CI, or stay driver-only? | a: Run them in CI — one line in the dots-web job. CI today runs only `server.test.mjs`, so the icon mapping is currently unguarded there.
q: Does the phone on Darren's device already send night / day (is the #136 build installed)? | assumption: No device check gates the build. Either order is safe: a phone still sending an old colour maps to Default on the new web, and a #136 phone sending night / day falls back to Default on the old web.

# Plan: dots-web PWA icons and Nova clips use the new canonical logo (#136)

Issue: darrencjh8/friday#231
Base: friday main `a424d64`
Kind: bug (webapp, PWA icon and animation still show the old logo)

## Fact-check (verified 2026-11-14 on main `a424d64`)

**What the new logo is (hermes-dots #136 / PR #138, merged 2026-11-13).**
The seven pre-coloured launcher foregrounds (blue, lavender, office, peach,
pink, teal, white — old portrait, bionic arm) are deleted from Android.
`LauncherIcon` is now Default / Night / Day
(`app/src/main/kotlin/app/dotshermes/ui/AppIcon.kt:73-75`):
Default is the existing vector `ic_launcher_foreground` (the black line-art
silhouette); Night and Day are new cut-out foregrounds
`ic_launcher_friday_night_foreground.webp` (499 KB) and
`ic_launcher_friday_day_foreground.webp` (397 KB) from the current avatar
portraits (night: black camisole + beige cardigan; day: white top +
cardigan). The seven-colour row at the bottom of the picker only tints the
notification picture and the preview — the home-screen icon stays white,
and no colour field exists in the pairing payload. The phone now sends
only `default | night | day` per agent (`g.look.launcherIcon` in
`WebPairer.kt:payload()`; spec `docs/appairage-web.md:63`, test
`tests/test_issue_113.py:56` `KEYS = ("default", "night", "day")`).

**What friday dots-web still serves (wrong).**
- PWA icons: `modules/dots-web/public/icons/nova-{blue,lavender,office,
  peach,pink,teal,white}-192/512.png` + `manifest-nova-*.webmanifest`
  (last changed 2026-11-11, #211 rework, resized from the old Android
  foregrounds). Viewed: `nova-blue-192.png` is the old portrait on blue —
  no cardigan, bionic arm visible at bottom left — in a rounded-square
  tile (corner alpha 0, edge alpha 255). `nova-default-192.png` is the
  black silhouette on white: already current, untouched by #136.
  `nova-192/512.png` + `manifest-nova.webmanifest` are the half-body
  office photo (old portrait), used as the pre-pairing default
  (`index.html:10-12`) and as the fallback for unknown values.
- Animation clips: `modules/dots-web/public/dots/nova/{still,thinking,
  idle,sleeping,speaking}.webp` (last changed 2026-11-08/09, #180/#182),
  360x388 transparent cut-outs (still 1 frame, thinking 61, idle 153,
  sleeping 82, speaking 49). Frame 0 viewed for all five: every clip
  shows the old portrait — black camisole, no cardigan, bionic arm at
  bottom left. The Android `nova_state_*` raw clips these derive from
  were last regenerated 2026-11-11 (#100), before the 13 Nov cardigan
  restyle, so they are stale too and are not a source for this fix.
- Wiring, all still on the old 8-key set: `src/types.ts:12`
  `LauncherIconId = "default" | "blue" | "lavender" | "teal" | "pink" |
  "peach" | "white" | "office"`; `src/pairing/crypto.ts:104`
  `LAUNCHER_ICONS` (same 8) with `pick()` (line 108) falling back to
  `"default"` for unknown values — so a phone sending `"night"` / `"day"`
  today is silently dropped to Default, and an old colour still maps to
  its old icon. `src/appIcon.ts:9` `LOGOS` is the 7 colours; `"default"`
  maps to `nova-default`, anything else unrecognised maps to the
  half-body `nova` files. `src/chat/ChatApp.tsx:74` passes the stored
  choice: `setAppIcon(active.species, active.launcher_icon, ...)`.
  Stored agents bypass validation — `src/store.ts:loadAgents` is a raw
  `JSON.parse` of localStorage — so `setAppIcon` itself must map stored
  old colours to Default; fixing `crypto.ts` alone leaves paired
  browsers on the old icons.
- `PortraitDot.tsx` maps moods to clips (`idle`, `thinking`, `speaking`,
  `sleeping`, plus `still` for reduced motion) and needs no code change:
  the clip paths and mood mapping stay the same.
- The dots-web CI job (`.github/workflows/test.yml`, `dots-web`) runs
  only `node --test server.test.mjs` plus a Docker smoke test;
  `src/appIcon.test.ts` (133 lines, the #211 RED control) is not run in
  CI. There is no crypto test file today.

**Boundary with hermes-dots #110 (separate work, no duplication).**
The two webs are not the same deployed app:
- friday `modules/dots-web`: own deployment (Docker, `server.mjs`,
  `127.0.0.1:8789` per `docs/operations.md:43`), vendored from upstream
  Drevero/Dots-hermes `web/` at `8dae04e` plus friday-local additions.
  Nova is filmed WebP loops in `public/dots/nova/`; PWA icons and
  per-logo manifests live in `public/icons/` + `public/*.webmanifest`.
- hermes-dots `web/`: separate copy in the hermes-dots repo (Vercel
  config), Nova is a layered-still rig (`dot_nova_body`,
  `dot_nova_work_body`, eyes/mouth layers in `web/public/dots/`) — no
  `nova/` filmed loops, no `icons/` directory, no manifests at all.
  friday `public/dots/` has no `dot_nova_*` layer files, so #110's
  files do not exist here.
#110 covers the layered rig (and its plan, approved 2026-11-11, predates
#136, so it needs its own re-pointing — a separate worker is revising
it). This plan touches friday files only and shares no files with #110.

## The change

Naming follows the existing convention (`nova-<key>-192/512.png`,
`manifest-nova-<key>.webmanifest`).

1. `modules/dots-web/src/types.ts:12`: shrink `LauncherIconId` to
   `"default" | "night" | "day"`.
2. `modules/dots-web/src/pairing/crypto.ts:104`: `LAUNCHER_ICONS`
   becomes `["default", "night", "day"]`. `pick()` is unchanged: an
   unknown or missing value (including any old colour in a fresh
   payload) falls back to `"default"`.
3. `modules/dots-web/src/appIcon.ts`: `LOGOS` becomes
   `["night", "day"]`. Nova + night/day points the three links at the
   new per-logo files; Nova + anything else (default, unknown, missing,
   or a stored old colour) points at `nova-default` — never again at
   the half-body `nova` files. Non-Nova species unchanged. One
   function, no new module.
4. `modules/dots-web/index.html:10-12`: default links point at
   `/icons/nova-default-192.png` and `/manifest-nova-default.webmanifest`
   (the pre-pairing icon is now the Default silhouette, matching the
   phone's Default launcher icon).
5. New static files under `modules/dots-web/public/`:
   - `icons/nova-night-192.png` / `-512.png` and
     `icons/nova-day-192.png` / `-512.png`, derived from the hermes-dots
     foregrounds `ic_launcher_friday_night/day_foreground.webp`
     (1421x1421 transparent cut-outs, #95 placement: portrait 0.64
     scale, y 0.19). Composite each onto a white canvas with the same
     22% rounded-square mask as the existing tiles, keeping that
     placement so the V sticks to the bottom edge and the portrait
     fills the frame (not floating). Verify by viewing against the old
     `nova-blue` tile: same framing, only portrait and background
     differ. No new photo generation for the icons.
   - `manifest-nova-night.webmanifest` and
     `manifest-nova-day.webmanifest`: copies of
     `manifest-nova-default.webmanifest` with only the `icons` array
     swapped (same `name` / `short_name` / `theme_color` /
     `background_color`, same file serving `any` and `maskable`).
6. Delete: the 14 old colour PNGs, the 7 old colour manifests, and
   `icons/nova-192/512.png` + `manifest-nova.webmanifest` (half-body
   old photo, no longer referenced). `nova-default-192/512.png` and
   `manifest-nova-default.webmanifest` are unchanged (already current).
7. Animation clips — regenerate all five under
   `modules/dots-web/public/dots/nova/` from the current canonical
   avatar, day set only, exported as 360x388 transparent animated
   WebP (same framing as today, bust to the waist; `PortraitDot.tsx`
   `SCALE = 2` box unchanged):
   - `still.webp` and `idle.webp` ← Day Still v8
     (`~/workspace/imagine_media/day-loops/still-white-5s-v8.mp4`,
     5.0s; idle loops the still clip, per the #182 precedent).
   - `thinking.webp` ← `~/workspace/imagine_media/day-loops/thinking-white-10s.mp4`.
   - `speaking.webp` and `sleeping.webp` ← two new short loops
     generated from the current canonical day portrait via the
     established Friday loop workflow (same route as the accepted
     loops; first frame = the portrait; verified frame-by-frame
     against it, no bionic arm, cardigan on): speaking is a subtle
     mouth-movement loop, sleeping is eyes closed, slow rest.
     No canonical loop exists for either mood, so there is nothing to
     re-derive — this is the only new generation in the change.
   - Conversion for the re-derived clips: key out the white background
     with the proven flood-fill method from
     `hidden_files/regen_icons_136.py` (near-white neutral key,
     flood-fill from the borders, ~2px feather), then crop/resize to
     360x388. Day set only, because the key needs a light background;
     the transparent result works on light and dark themes, as today.
8. Tests — RED control, `cd modules/dots-web`:
   `node --test src/appIcon.test.ts src/pairing/crypto.test.ts`
   (plus `npm run build` green at HEAD for the typecheck):
   - Extend `src/appIcon.test.ts`: night maps to
     `/icons/nova-night-192.png` + `/manifest-nova-night.webmanifest`;
     day maps to the day files; old colour `"blue"` maps to
     `nova-default`; unknown `"nope"` maps to `nova-default` (changed
     from `nova-192`); missing choice maps to `nova-default` (changed);
     non-Nova ignores the logo (unchanged).
   - New `src/pairing/crypto.test.ts`: `validatePayload` on a
     fabricated payload (pure validation, no WebCrypto needed) — night
     stays night, day stays day, `"blue"` becomes `"default"`,
     missing becomes `"default"`. At base the night/day cases fail
     (dropped to Default) and the old-colour case fails (blue kept),
     so the file is RED at base and green at HEAD.
   - Add one line to the `dots-web` job in
     `.github/workflows/test.yml` so CI runs
     `node --test src/appIcon.test.ts src/pairing/crypto.test.ts`
     alongside `server.test.mjs` (it runs neither today).
9. Visual verification (same bar as #211 / #136): view each new icon
   and the first frame of each new clip against the current canonical
   portrait — cardigan on, both arms human, no bionic arm — and confirm
   the tile framing matches the old tiles. Name any drift honestly in
   the PR; do not claim a match that is not there.

## What does not change (out of scope, on purpose)

- No launcher-icon picker or settings UI in the web client — the phone
  owns the selection; the web only follows it. No second source of
  truth. No live push of a changed selection.
- No change for the phone's seven-colour row: it only tints the
  notification picture / preview, and no colour field travels in the
  pairing payload, so there is nothing for the web to follow.
- No change to galet / nuage / pave icons or clips, to the pairing
  crypto itself (v1, same keys, same deposit shape), or to the vendored
  upstream files — `appIcon.ts`, `crypto.ts`, `types.ts`,
  `PortraitDot.tsx` and the `nova/` clips are friday-local additions
  (#180 / #182 / #211), so there is no vendor-sync cost.
- No service worker, no manifest URL versioning, no cache-busting
  renames: the new icon files have new names, so a fresh install can
  never serve a stale icon from the old URLs.
- Nothing in hermes-dots (see boundary above).

## Known limits (tell Darren, not hidden)

- A logo change on the phone reaches the web only at the next QR
  re-pairing (the gateway hello replays chat, not appearance) — same
  as #211. A stored old colour in localStorage maps to Default on the
  next load with no re-pairing needed.
- An already-installed PWA may need a reinstall for its home-screen
  icon to change: Chrome on Android refreshes it via WebAPK only once
  the manifest changed, all PWA windows are closed, and the device is
  charging on Wi-Fi (manifest checked at most once a day on launch);
  desktop Chrome / Edge never replace the installed icon; iOS Safari
  never refreshes it — delete and re-add. Fresh installs get the new
  icon right away; the tab icon and apple-touch-icon change on the
  next load (plain link swaps).
- The two generated clips (speaking, sleeping) are new video
  generations and carry the usual drift risk; they are verified
  frame-by-frame against the day portrait before the PR, and if one
  is not accepted the PR ships the rest and says so (see QUESTIONS).

## Verification

- RED control (recorded at base, replayed green at HEAD):
  `cd modules/dots-web && node --test src/appIcon.test.ts
  src/pairing/crypto.test.ts` — the night / day / old-colour cases
  fail at base and pass at HEAD; the unchanged cases pass at both.
- `npm run build` (tsc + vite) green at HEAD.
- CI gate for the build (friday CI on the PR head, `.github/workflows/
  test.yml` `dots-web` job): `node --test server.test.mjs`, the new
  `node --test src/appIcon.test.ts src/pairing/crypto.test.ts` line,
  Docker build + smoke (`curl /` contains `<title>Hermes`, pair
  endpoint 204). No full test suite runs locally (standing rule — CI
  tests it).
- After deploy: re-pair once from the phone, confirm the tab icon,
  the installed PWA icon (fresh install), and all five moods show the
  cardigan portrait; confirm a pre-#136 stored agent (old colour in
  localStorage) shows Default, not an old colour or the half-body
  photo.
