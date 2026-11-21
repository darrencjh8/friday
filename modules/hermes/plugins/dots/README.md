# Dots platform plugin

Gateway for the Dots Android app. Vendored from `server/hermes-plugin-dots` in
[Drevero/Dots-hermes](https://github.com/Drevero/Dots-hermes) at commit
`1463121defc959d27eeb0edaf5ff12642c11f18b`, licensed GPL-3.0. Update it by copying a reviewed
commit over these files and changing the hash above, then reapplying the local change below.

Local change: `DotsAdapter._attach_screen_supervisor` in `adapter.py` (marked "Friday patch") attaches
a CDP supervisor to Hermes' running browser when none is live, so the live screen and takeover work
with `browser_exec`. Attach failures are logged as a warning.

Local addition: `release_proxy.py` and the `/dots/releases/*` routes relay the private
`DOTS_UPDATE_REPO` release to the Android updater (master token), and `/dots/desktop/latest` and
`/dots/desktop/assets/{id}` serve the newest signed `desktop-v*` installer to the Windows app's
Tauri updater (master or web token), as a Tauri manifest (204 when there is none).

It stays dormant until the `DOTS_TOKEN` deploy secret is set. Browsers are refused unless
their origin is in the `DOTS_WEB_ORIGINS` deploy secret. See `docs/operations.md` for how the port is exposed.
