# Dots platform plugin

Gateway for the Dots Android app. Vendored from `server/hermes-plugin-dots` in
[Drevero/Dots-hermes](https://github.com/Drevero/Dots-hermes) at commit
`1463121defc959d27eeb0edaf5ff12642c11f18b`, licensed GPL-3.0. Update it by copying a reviewed
commit over these files and changing the hash above, then reapplying the local change below.

Local change: `DotsAdapter._attach_screen_supervisor` in `adapter.py` (marked "Friday patch") attaches
a CDP supervisor to Hermes' running browser when none is live, so the live screen and takeover work
with `browser_exec`. Attach failures are logged as a warning.

Local change: `DotsAdapter.send` shows an expense-tracker learning offer ("Tap /remember_<id> or
/forget_<id>") as an approval card, and `_on_approval` answers a `learn_<id>` card once by sending
`/remember_<id>` (Approve) or `/forget_<id>` (Refuse) as the owner, for the `learning-commands` plugin. It runs
that plugin's `pre_gateway_dispatch` hook itself, since a tap while Friday is mid-turn would
otherwise steer the running turn and the model would see the bare command.
A Muse purchase request from the `muse-requests` cron ("Tap /buy_<n> or /skip_<n>") becomes a
`muse_<n>` card the same way: Buy tells the agent, as the owner, to buy friday-persona issue `<n>`
with the shopping skill, and Refuse tells it to comment and close the issue. Both are marked
"Friday patch".

Local change: `DotsAdapter.send` shows an email-intake review request ("Book it with /replay_<id>_tx
... or ignore it.") as a `replay_<id>` choice card, and `_on_review` answers it once: Transaction,
Statement or Portfolio sends `/replay_<id>_<tx|stmt|pf>` as the owner for the `intake-commands`
plugin, running its hook the same way; Ignore sends nothing. Marked "Friday patch".

Local addition: `vault_get`, `vault_add` and `vault_remove` socket frames manage Hermes' encrypted
autofill vault (the store behind `hermes vault`): logins, cards and addresses. Only the phone may use
them, never a paired browser; replies carry metadata only and no value is ever logged.

Local addition: `release_proxy.py` and the `/dots/releases/*` routes relay the private
`DOTS_UPDATE_REPO` release to the Android updater (master token), and `/dots/desktop/latest` and
`/dots/desktop/assets/{id}` serve the newest signed `desktop-v*` installer to the Windows app's
Tauri updater (master or web token), as a Tauri manifest (204 when there is none).

It stays dormant until the `DOTS_TOKEN` deploy secret is set. Browsers are refused unless
their origin is in the `DOTS_WEB_ORIGINS` deploy secret. `/dots/health` is the only route open without a
token, and it names the answering profile (`agent_id`) only to a token holder. Every refused request is
logged with the address Tailscale saw (the last `X-Forwarded-For` entry), so probing shows in the logs.
No reply names the server software (`Server: dots`) or echoes a malformed request back, and a request
aiohttp cannot parse logs one line rather than a traceback.
See `docs/operations.md` for how the port is exposed.
