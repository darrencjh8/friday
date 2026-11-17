QUESTIONS
q: Night logo — does it need the cardigan, or is the night look bare-shoulder? | a: (c) night needs no cardigan, it is not part of the style. Night logo stays the bare-shoulder night portrait.
q: Is the logo-vs-animation cardigan mismatch acceptable as-is? | a: Yes, acceptable as-is.
q: Sleeping videos — generate them, or use Still? | a: No sleeping videos, use Still. Sleeping maps to the Still clip; no nap clip is shipped.
q: Still with less movement — generate a blink-only Still? | a: Yes, generate the blink-only Still (becomes the idle home base; Darren picks it before use).
q: Approve this plan and the animation preview? | a: Approved — the build proceeds.

# Friday logo (cardigan fully worn) + new animation — plan

Darren, 2026-11-17. Supersedes friday #231 rev-3 and hermes-dots #110 final in substance (see §10).
**Approved 2026-11-17 (see §12). The build proceeds.**

## 1. What this changes

- **Logo:** the friday app logo and the PWA icons become the cardigan **fully worn** portrait. The logo picker in settings offers the three cardigan portraits.
- **Animation:** the web app and the Android app play the new animation from the Friday Animation page. Idle is **(still, bangs, shoulder) with still in the middle** — still is the home base between the two flourishes. The settings selector for Friday picks the variant.
- **Thinking / typing:** thinking crossfades into the working (typing) animation.
- **Sleeping:** no sleeping videos — sleeping uses Still (see §6).

## 2. The current set (source of truth: Friday Animation page, v99 live)

20 tiles, 4 variants × 5 loops. Every clip shows the **new smile face, no barrette** (frame-checked first + last frame). The old-face / barrette clips (`still-white-5s-v12`, `shoulder-white-10s-v11`) are **not** on the page. The old photo-rig Bangs (`friday-sources/videos/bangs-white.mp4`, md5 `611afa0f`, black camisole + bionic arm) is **not** on the page and must never be used.

| Variant | Still | Thinking | Working | Shoulder | Bangs |
|---|---|---|---|---|---|
| **Day-white** (white bg; white top, cardigan OFF shoulders) | `day-still-white-10s-v1.mp4` `a72eafc2` 10s seam 6.02 | `day-thinking-white-10s-v1.mp4` `82347c53` 10s, played ONCE | `day-working-white-5s-v1.mp4` `4d4a9772` 5s seam 2.38 (avatar, headphones + laptop, ¾ view) | `day-shoulder-white-10s-v1.mp4` `c2023c35` 10s (take 13) | `day-bangs-white-8s-straight-v1.mp4` `eb169708` **8s** seam 6.95 ([0,8] cut of take 5) |
| **Day-black** (black bg; same outfit/face) | `day-still-black-10s-v1.mp4` `63e269ce` 10s seam 4.97 (take 12) | `day-thinking-black-10s-v1.mp4` `78926fa1` 10s, ONCE (take 4) | `day-working-black-8s-v2.mp4` `a99e45b9` 8s seam 2.57 (avatar dark) | `day-shoulder-black-10s-v1.mp4` `1698e7ff` 10s (Gemini take 2) | `day-bangs-black-10s-straight-v1.mp4` `8ff64622` 10s seam 5.09 (take 3) |
| **Night-white** (white bg; black camisole, NO cardigan) | `night-still-white-10s-v1.mp4` `65a2368d` 10s seam 5.04 (take 1; mid-clip defect — eyes shut at 1s, head turns at 3s; you approved it anyway) | `night-thinking-white-10s-v1.mp4` `336bccee` 10s, ONCE (take 1) | `working-white-5s.mp4` `7f3740cc` 5s | `night-shoulder-white-10s-v2.mp4` `d7cb431b` 10s seam 7.18 (take 2) | `night-bangs-white-10s-v1.mp4` `e7ef860e` 10s seam 5.28 (take 2; **ends eyes-shut**) |
| **Night-black** (black bg; black camisole, NO cardigan) | `night-still-black-10s-v9.mp4` `d181121c` 10s seam 3.52 (look-around v9) | `night-thinking-black-10s-v1.mp4` `9e2c8849` 10s, ONCE (take 1) | `working-black-5s-v4.mp4` `18f93924` 5s seam 1.09 | `night-shoulder-black-10s-v1.mp4` `89aaa72c` 10s seam **10.70 (over the 8 gate; you approved it)** | `night-bangs-black-10s-v1.mp4` `eb897cf1` 10s seam 4.05 (take 2) |

Current idle cycle on the page: one shared clock, **Step 1 Still → Step 2 Shoulder → Step 3 Bangs**, 3 × 10s = 30s, all four variants in lockstep. Wink is gone from the cycle and the tiles.

## 3. The logo — cardigan fully worn

- **Day white:** `friday-sources/outfits/day-portrait-white-cardigan-full.jpg`, md5 `22b11e9d`, 2048×2048 — new smile face, no barrette, cardigan fully worn (covers shoulders, sleeves on upper arms, open at front over the white top). Verified by eye.
- **Day black:** `friday-sources/outfits/day-portrait-black-cardigan-full.jpg`, md5 `19810411`, 2048×2048 — same look on black.
- **Night:** there is **no night cardigan-full portrait at all**. The night portraits (`night-portrait-white.jpg` `2f0bf28d`, `night-portrait-black.jpg` `efdc94aa`) are the black camisole with **bare shoulders, no cardigan**.
- **⚠️ Do not use md5 `8158c440`.** It is the OLD day face (rounder, fuller cheeks, larger eyes) **with a silver barrette**, cardigan worn OFF the shoulders (`friday-canonical-backup/28-day-portrait-white-pre-newsmile-2026-11-15.jpg`). Shipping it as the logo would put the old face with a barrette in the app. The correct fully-worn new-face file is `22b11e9d`.
- **Mismatch — DECIDED (§12 Q2): accepted.** The logo is cardigan fully worn; the Day animation keeps the cardigan off the shoulders. The logo is a still portrait and the animation is the moving character; they do not have to match frame-for-frame. The alternative (re-generating the Day loops with the cardigan fully worn) is not in this plan.
- **Night logo — DECIDED (§12 Q1): night needs no cardigan, it is not part of the style.** The night logo stays the bare-shoulder night portrait (`night-portrait-white.jpg` `2f0bf28d`, `night-portrait-black.jpg` `efdc94aa`). No night cardigan portrait is generated.

### Where the logo goes

- **dots-web PWA** (`friday` repo, `modules/dots-web/public/icons/` + manifests): `nova-default`, `nova-night`, `nova-day` `-192`/`-512` PNGs become the cardigan portraits (default = day white cardigan-full; night = night cardigan-full once it exists; day = day cardigan-full). The 14 old colour PNGs and the 7 old manifests are already deleted in the #231 build — this plan reuses that work and swaps the portrait in.
- **Android launcher icon picker** (`hermes-dots` repo, `app/src/main/kotlin/app/dotshermes/ui/AppIcon.kt`): the picker offers Default / Night / Day, each showing its cardigan portrait. This is the picker the dots-web PWA follows — `modules/dots-web/src/appIcon.ts` (`setAppIcon`, `LOGOS = ["night", "day"]`) already reads the phone's `launcherIcon`, so the PWA follows the phone's choice with no new wiring.
- **dots-web settings:** verify at build whether dots-web has its own logo-picker UI or only follows the phone; if it only follows the phone, the Android picker is the single picker and the plan says so.

## 4. The animation — web + Android

### The new idle: still in the middle

Still is the home base. The mechanism already exists on Android — `DotSpecies.kt`'s `IdleSequencer`: after every flourish it returns Still, and the flourishes come from a **shuffled bag without replacement** (each flourish plays once per cycle, in shuffled order). This plan reuses it, it does not reimplement sequencing.

- The change is the **enabled set: {Still, Bangs, Shoulder}**. It falls out of dropping Glance / Wink / Wind from the `IdleClipId` enum — `IdleSequencer.next` defaults `enabled` to all enum entries, so removing the three leaves exactly these three. Still returns after every flourish, so Still is in the middle of all — Bangs-first and Shoulder-first both occur on different cycles, in shuffled order.
- One cycle, in order (one possible bag order — the preview shows Bangs first): **Still → Bangs → Still → Shoulder → Still**. There is **no direct Bangs-end → Shoulder-start jump** (that was the rough join in the old cycle). Each flourish returns to Still before the next one starts.
- Cycle length follows the clips, not a fixed clock: **Day-white 48s** (10 + 8 + 10 + 10 + 10 — its Bangs is 8s), **the other three variants 50s** (10 + 10 + 10 + 10 + 10). Each step plays for its own duration (a playlist), they do not pad the Day Bangs to 10s — holding its last frame for 2s would freeze her with her eyes nearly shut (see §5).
- **Web sequencer:** `VideoDot.tsx` today renders a single `<img>` per mood — a `CLIPS` map alone cannot express a 5-step cycle. The web gets a timer in `VideoDot` that mirrors `IdleSequencer`: a shuffled bag of {Bangs, Shoulder} without replacement, Still between every flourish, each step for its own duration, using the `CLIPS` entries for the current background.
- The preview (48s, Day-white, the exact page clips) is attached with this plan. Joins measured 6.5–8.9 mean abs diff (the loop gate is 8; the re-encode adds ~1–2 points — the page's own Still seam is 6.02). The Bangs→Still join was checked by eye: same face, same outfit, same pose, eyes open. The preview shows one bag order (Bangs first); the apps shuffle which flourish comes first per cycle.

### Mood map (final, per your rulings)

| Mood | Plays |
|---|---|
| idle | the Still-middle cycle above |
| thinking | the Thinking clip, **once** (10s), then holds on its last frame until the state changes — **this is a change, not current behaviour** (§5). Android: `BustPlayer.onEnded` must not restart it. Web: the Thinking WebP is encoded with loop count 1. |
| typing / working | the Working clip, looped |
| talking | Working (your 2026-11-14 ruling: talking now plays Working) |
| happy | idle (your 2026-11-14 ruling: happy maps to idle) |
| sleeping | the Still clip — **DECIDED (§12 Q3): no sleeping videos, sleeping uses Still.** No nap clip is shipped; the nap files are not used. |
| speaking | **deleted everywhere** — the 2 speaking files go; `speaking_in` as a separate clip is gone (it was the opening gesture into the speaking clip, and there is nothing to open into anymore) |

### What ships where

- **Format (both platforms): animated WebP, not mp4.** Android `res/raw/` holds animated WebP (21 files today; only `nova_idle.mp4` is an mp4, the pre-Android-9 fallback) and `PortraitBust.kt` decodes each clip with `ImageDecoder` → `AnimatedImageDrawable` — an mp4 there fails `decodeDrawable` and the bust renders nothing. So every page loop is **converted mp4 → animated WebP** first, with the proven #110 command (`ffmpeg -i <clip>.mp4 -vf scale=480:480 -an -c:v libwebp -quality 80 -loop 0 -pix_fmt yuv420p <target>.webp`), per file, from the page's mp4s. Each WebP's md5 is recorded at build time (the §2 md5s are the mp4s'; the WebPs will differ). `res/raw` is the WebP home for both platforms.
- **Android** (`hermes-dots` `app/src/main/res/raw/`): the converted WebPs, named `nova_state_<mood>_<white|black>.webp` (still / thinking / working / bangs / shoulder × white / black — 10 files; nap is not shipped, sleeping uses Still). The `DotSpecies.kt` PortraitRig `IdleClipId` set drops Glance / Wink / Wind (retired from the idle set; files stay on disk, unplayed by default) — the enabled set becomes {Still, Bangs, Shoulder} and `IdleSequencer` does the rest (§4). `thinking` and `working` point at the page's Thinking / Working files. The speaking files (`nova_state_speaking.webp`, `nova_state_speaking_in.webp`) are deleted; `talking` maps to Working.
- **Web** (`hermes-dots` `web/`): `VideoDot.tsx`'s `CLIPS` map is rebuilt from the converted WebPs. Today it still maps `talking` to `speaking.webp` and serves the stale `#100`-era webp clips (`nova_state_*`); this plan replaces those with the new WebPs, delivered through `web/scripts/sync-clips.mjs` (a plain copy from Android `res/raw` to `web/public/clips/`, created by `prebuild` — it converts nothing, so the conversion above must run first). The sync list is extended to the new set (still / thinking / working / bangs / shoulder × white / black — 10 files) and `speaking` is dropped from it (today it copies only 7 files and still includes `speaking`). The `loadAvatarBackground()` white / near-black key stays — it picks the background half of the variant.
- **Variant:** outfit (Day / Night) × background (white / near-black) = the 4 page variants. The background half already exists in both apps; the outfit half is the new selector (§7).

## 5. Known rough edges (named honestly, not hidden)

- **Night-white Bangs ends eyes-shut.** Bangs→Still jumps eyes-shut to eyes-open in that variant. Putting Still in the middle does not remove this join — it only keeps Bangs away from Shoulder. Acceptable as-is, or the build trims the last ~0.5s of the Night-white Bangs (it is a 10s take; a [0,9.5] cut keeps the eyes open — verify at build, do not assume).
- **Day-white Bangs ends eyes-nearly-shut** at the exact 8s cut point (frame 191). The take-5 record's claim "ends facing at 8s with eyes open" is wrong at the cut. Same remedy as above if you want it: trim ~0.5s, verify by eye.
- **Night-white Still has a mid-clip defect** (eyes shut at 1s, head turns at 3s). You approved it and it is live; the joins are fine. Not fixed in this plan.
- **Night-black Shoulder seam 10.70** is over the 8 gate. You approved it. Not fixed in this plan.
- **Day-black Shoulder:** memory records a barrette in this take; first + last frame checks show none. The build checks mid-clip frames (3–6s) before finalising.
- **Thinking plays once, not looped — but that is the page's behaviour, not the apps'.** Today Android `BustPlayer.onEnded` restarts the clip when the next pick is the same (`if (next == loop) animated?.start()`), and `IdleSequencer.next` returns the same Thinking clip for any non-idle mood — so Thinking replays. On the web the Thinking WebP has ANIM loop count 0 (infinite), so an `<img>` loops it forever. The build changes both: Android holds the last frame on Thinking (no restart in `onEnded` for that mood); web encodes Thinking with loop count 1 and `VideoDot` holds the last frame. The build verifies by playing the encoded Thinking WebP and confirming it stops on the last frame. If thinking lasts longer than 10s, the last frame holds.

## 6. Sleeping — DECIDED: no sleeping videos, sleeping uses Still

You promised the day sleeping clip and the night nap on 2026-11-14, and said on 2026-11-17 "you should have everything you needed now" — but no sleeping video arrived (no `*sleep*` / `*nap*` file newer than 2026-11-14 exists anywhere in the workspace). You decided 2026-11-17: **no sleeping, use Still.** The sleeping mood plays the Still clip. No nap clip is shipped, no sleeping video is generated or awaited, and the old nap files (`nap-white.mp4` `4d1b4ef0`, `nap-black.mp4` `274c07df`, both 2026-11-11) are not used.

## 7. The settings selector for Friday

- **Web (hermes web) settings:** the avatar-background setting (white / near-black, `web/src/chat/avatarBackground.ts`, per-browser localStorage) stays. **Add a Friday outfit selector: Day / Night.** The two together pick the variant (Day-white, Day-black, Night-white, Night-black). This is the new "settings selector for Friday".
- **Android settings:** the same Friday outfit selector (Day / Night) in the appearance settings (`AppearanceStore.kt` area — exact placement verified at build). Background follows the app theme / the existing background setting.
- **Android launcher icon picker** (`AppIcon.kt`): Default / Night / Day — the logo picker (§3). It is separate from the animation selector: the logo is the still portrait, the animation selector is the moving variant.
- **dots-web:** follows the phone's launcher icon for the logo (§3); verify at build whether it needs its own animation selector or follows the phone's outfit choice through the gateway.

## 8. Thinking / typing crossfade

- When the state moves thinking → typing, the app crossfades from the Thinking clip to the Working clip (opacity crossfade, ~0.5s) instead of a hard cut.
- **The framing changes and the crossfade does not hide it.** Thinking is a head-to-chest portrait; Working Day is a different shot (¾ view, laptop, headphones, wider framing), and Working Night is the old 5s loop. The crossfade softens the cut but the pose and framing visibly change. That is stated here so it is a decision, not a surprise.
- Web: the crossfade is a CSS opacity transition between the two layers in `VideoDot`. Android: the equivalent crossfade on the clip surface. The build verifies the crossfade reads as a smooth handover, not a flicker, on both backgrounds.

## 9. Still video with less movement — your question

You asked whether another still video with less movement is needed. The current Still is a look-around (eyes-only glances, head still) — it is calm, and the joins measure at the gate. **DECIDED (§12 Q4): yes, generate the blink-only Still.** It becomes the idle home base (replacing the look-around Still in the apps' cycle). Generation: from the current portrait, JEV-gated, you pick it before use (one item, side-by-side with the look-around Still). Day-white first; the other three variants follow the same way once you pick the approach. The preview's Still is the look-around (a sequencing demo); the final Still is the blink-only one you pick. Note: a blink-only rest was built before (2026-11-10, `blink-only-rest.mp4`, 5.06s, from the most stable window of a drifty generation, ping-ponged) but it is the old green-screen set, not the current white/black set — so a new one is generated for the current set. The prompt does not use the word "blink" (Nov 10 lesson: the model overdoes it).

## 10. How this relates to #231 and #110

- This plan **supersedes** friday #231 rev-3 (`44921b77`) and hermes-dots #110 final (`accc873a`) in substance. Both were escalated (plan budget of 3 rounds) and neither was approved — and both say "regenerate" for the sleeping videos, which you overruled on 2026-11-14 ("Both" — you supply them).
- Their **built work is reused, not discarded:** #231's build (head `afa5cdc`, review-clean, 38 files — icon keys default/night/day, old colours deleted, 19/19 tests) is the base for the logo work; #110's build (head `5444e18`, Steps 1–3 — `sync-clips.mjs`, `VideoDot.tsx`, `ChatView.tsx` wiring) is the base for the web animation. The new work is the cardigan portrait swap, the Still-middle idle, the mood-map fixes (talking→working, speaking deletion), the crossfade, and the selectors.
- The #231 push is **still blocked** on the friday-maintainer App lacking the `workflows` permission (the branch touches `.github/workflows/test.yml`). That block carries over: you need to grant the App `workflows` permission before any of this can be pushed as a PR.
- Filing: the build will be filed under the existing issues (#231 for the logo/PWA, #110 for the animation) or a new issue if you prefer — decided at build time, not in this plan.

## 11. Build steps (summary)

- **Step 0 — verify (before any change):** verify all 20 clips by md5 against the page's asset files at `~/workspace/ts-spaces/shoulder-fade-demo/assets/` (the Night Working files `working-white-5s.mp4` `7f3740cc` and `working-black-5s-v4.mp4` `18f93924` **are** there — an earlier draft wrongly said they were not locatable; the `night-loops/` dir no longer exists, but the asset dir holds them, and the `day-fix` / `night-fix` raw dirs hold byte-identical copies where they exist). Also check the Day-black Shoulder mid-clip frames (3–6s) for a barrette.
- **Step 1 — logo:** cardigan portraits → PNG icons + manifests (dots-web); Android launcher icon picker (Default / Night / Day). Night logo uses the bare-shoulder night portrait (no cardigan — decided §12 Q1).
- **Step 1.5 — blink-only Still:** generate the blink-only Still (Day-white first, 10s, from the current portrait, JEV-gated; Darren picks it side-by-side with the look-around Still, then the other three variants the same way). The apps' Still is the blink-only one once picked. Record its exact prompt verbatim next to the video.
- **Step 2 — clips:** convert each page mp4 → animated WebP with the #110 command (`scale=480:480`, `-c:v libwebp -quality 80 -loop 0`, `-pix_fmt yuv420p`; Thinking uses loop count 1 — see Step 3), record each WebP md5, place them in Android `res/raw` (`nova_state_<mood>_<white|black>.webp`), and extend `sync-clips.mjs` to copy the 10-file set to web `public/clips/`. Delete the speaking files (`nova_state_speaking.webp`, `nova_state_speaking_in.webp`) and drop `speaking` from the sync list.
- **Step 3 — behaviour:** Still-middle idle via `IdleSequencer` (enabled set {Still, Bangs, Shoulder} — falls out of dropping Glance / Wink / Wind from the enum) + the web timer in `VideoDot` mirroring it; mood map (talking→working, happy→idle, speaking deleted); Thinking holds on its last frame (Android: no restart in `BustPlayer.onEnded` for Thinking; web: loop count 1 + `VideoDot` freeze); thinking→working crossfade, in `VideoDot.tsx` and in Android `DotSpecies.kt` / PortraitRig.
- **Step 4 — selectors:** web outfit selector (Day / Night), Android outfit selector, Android launcher icon picker.
- **Step 5 — gates:** update the #231 / #110 tests for the new map and cycle; dev-loop review rounds (only Critical / High block; Medium / Low / Nit are accepted-risk, never fixed by editing the plan or code); **never present a PR until ALL CI checks on its head are green** (hermes-dots CI via the friday GHA); never run full test suites locally. You merge; Friday never merges.

## 12. Decisions — all answered, plan APPROVED (Darren, 2026-11-17)

1. **Night logo:** (c) — night needs no cardigan, it is not part of the style. Night logo stays the bare-shoulder night portrait.
2. **Logo vs animation cardigan mismatch:** yes, acceptable as-is.
3. **Sleeping videos:** no sleeping, use Still. Sleeping maps to the Still clip; no nap clip is shipped.
4. **Still with less movement:** yes, generate the blink-only Still (becomes the idle home base; Darren picks it before use).
5. **Approve this plan + the animation preview:** approved — the build proceeds.

---

### Sources

- Friday Animation page, v99 live — 20 tiles, idle cycle Step 1 Still / Step 2 Shoulder / Step 3 Bangs. Clip table in §2 verified md5-by-md5 against the page's recorded md5s; faces/outfits frame-checked.
- Cardigan portraits: `~/workspace/your_files/friday-sources/outfits/day-portrait-white-cardigan-full.jpg` (`22b11e9d`), `day-portrait-black-cardigan-full.jpg` (`19810411`); night portraits `images/night-portrait-white.jpg` (`2f0bf28d`), `night-portrait-black.jpg` (`efdc94aa`).
- Preview: `~/workspace/your_files/friday-animation/idle-preview-day-white-still-middle.mp4` (48s, 960×960, md5 `9b820077`) — Still t5 `a72eafc2` → Bangs t5 [0,8] `eb169708` → Still t5 → Shoulder t13 `c2023c35` → Still t5.
- Page asset files: `~/workspace/ts-spaces/shoulder-fade-demo/assets/` (all 20 §2 mp4s md5-verified against this dir, including Night Working `7f3740cc` / `18f93924`).
- Conversion command (from `docs/plans/110-nova-rig-canonical-portrait.md:176` in the #110 clone): `ffmpeg -i <clip>.mp4 -vf scale=480:480 -an -c:v libwebp -quality 80 -loop 0 -pix_fmt yuv420p <target>.webp`.
- Android mechanisms (read 2026-11-17): `DotSpecies.kt` `IdleSequencer` (shuffled bag without replacement, Still after every flourish, `enabled` defaults to all enum entries); `PortraitBust.kt` `onEnded` (`if (next == loop) animated?.start()`) and `ImageDecoder.decodeDrawable` → `AnimatedImageDrawable`; `res/raw/` holds animated WebP (only `nova_idle.mp4` is mp4). Web Thinking loop count verified by parsing the ANIM chunk (0 = infinite).

---

## Review round 1 (2026-11-17)

- **Verdict: DIRTY** — 1 Critical (C1: wrong clip format, conversion omitted), 3 High (H1: `IdleSequencer` not named, no web sequencer; H2: Night Working files wrongly called unlocatable; H3: Thinking hold not implemented on either platform). All four fixed in this revision (see the §4, §5, §11 and Sources changes above).
- **Accepted-risk (Medium / Low / Nit — not fixed, per the Low/Nit rule):** M1 (§8 crossfade mechanism under-specified — Android already has the fade path, Thinking is not in `fadeAfterClips`; the worker reading `BustPlayer` finds it); M2 (preview joins 8.74 / 8.88 / 8.73 above the 8 gate, and the re-encode adds +2.94 on first-vs-last — disclosed honestly, Darren judges the preview himself); M3 (§10 filing — how the supersession is recorded in the dev-loop is a process detail for the orchestrator); N1 (§3 — dots-web follows the phone, no dots-web picker; the plan still says "verify at build").

## Approval (Darren, 2026-11-17)

Plan approved with: Q1 (c) night no cardigan — it is not part of the style; Q2 yes, mismatch accepted; Q3 no sleeping, use Still; Q4 yes, generate the blink-only Still. The build proceeds (workers spawned 2026-11-17; the blink-only Still is generated separately, Day-white first, Darren picks it before use).
- Code read 2026-11-17: `modules/dots-web/src/appIcon.ts` (`setAppIcon`, `LOGOS = ["night", "day"]`), `hermes-dots/web/src/dot/VideoDot.tsx` (CLIPS map, still maps talking → `speaking.webp`), `hermes-dots/web/src/chat/avatarBackground.ts` (white / near-black, localStorage), `hermes-dots/app/src/main/kotlin/app/dotshermes/ui/dot/DotSpecies.kt` (IdleClipId Still / Glance / Bangs / Wink / Wind / Shoulder), `hermes-dots/app/src/main/kotlin/app/dotshermes/ui/AppIcon.kt` (launcher icon picker).
