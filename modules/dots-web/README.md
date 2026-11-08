# Dots web app

Browser client for the Dots gateway, paired with the phone by QR code. Vendored unmodified from
`web/` in [Drevero/Dots-hermes](https://github.com/Drevero/Dots-hermes) at commit
`8dae04e6854e2261a5dcfa241f9c31e248874efc`, licensed GPL-3.0. Update it by copying a reviewed commit
over these files and changing the hash above.

Added here: `server.mjs`, `server.test.mjs`, `Dockerfile` and this file. `server.mjs` replaces Vercel
and Upstash: it serves the build and the pairing relay from one origin, keeping deposits in memory.

The service listens on host loopback only. See `docs/operations.md` for how it is exposed.
