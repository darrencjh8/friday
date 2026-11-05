# Dots platform plugin

Gateway for the Dots Android app. Vendored unmodified from `server/hermes-plugin-dots` in
[Drevero/Dots-hermes](https://github.com/Drevero/Dots-hermes) at commit
`8dae04e6854e2261a5dcfa241f9c31e248874efc`, licensed GPL-3.0. Update it by copying a reviewed
commit over these files and changing the hash above.

It stays dormant until the `DOTS_TOKEN` deploy secret is set. Browsers are refused because
`DOTS_WEB_ORIGINS` is unset. See `docs/operations.md` for how the port is exposed.
