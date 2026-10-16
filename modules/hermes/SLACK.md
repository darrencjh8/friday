# Slack integration for Hermes

Hermes ships first-party Slack support through its official adapter: `slack-bolt`
over **Socket Mode**. Socket Mode is an outbound WebSocket, so the gateway needs
no public URL and **no new published port** — it works behind the firewall on the
production host as-is.

Reference: <https://hermes-agent.nousresearch.com/docs/user-guide/messaging/slack>

## What is already wired in this repository

| Layer | File | What it does |
| --- | --- | --- |
| Platform behaviour | `modules/hermes/config.yaml` | `platforms.slack` block (threading, Block Kit, unfurls) |
| Container env | `modules/docker-compose.yml` | forwards the five Slack env vars into `hermes` |
| CI/CD | `.github/workflows/deploy.yml` | maps GitHub secrets/vars into the deploy step |
| Deploy gate | `modules/deploy.sh` | fails loudly when the two tokens are absent |
| Regression test | `modules/hermes/tests/test_slack_platform.py` | asserts all of the above |
| Manifest helper | `modules/hermes/scripts/slack-manifest.sh` | generates the Slack app manifest |

Slack is **enabled** in `modules/hermes/config.yaml`
(`platforms.slack.enabled: true`). The two tokens live in the `darren-prod`
GitHub environment scope, so `modules/deploy.sh` validates both on every deploy.
If either token is missing the deploy fails loudly with `MISSING:` naming it.

The platform answers **without an `@mention`** in every channel the bot is
invited to (`require_mention: false`, no `allowed_channels` whitelist). That
makes `SLACK_ALLOWED_USERS` the only thing standing between a channel message
and an agent turn, so keep it filled in.

## Talking in multiple channels

Nothing per-channel is configured. The adapter runs one session per channel and
thread, so each channel is an independent conversation, and the bot joins a
channel only when it is invited:

```
/invite @friday
```

Repeat that in every channel the bot should answer in, then just type — no
`@mention` needed. Thread replies stay threaded (`reply_in_thread: true`), and
other bots are ignored (`allow_bots: "none"`).

Two guards worth knowing:

- `SLACK_ALLOWED_USERS` (repository variable, comma-separated Member IDs) covers
  channels *and* DMs. Empty means nobody can reach the bot anywhere.
- To make one busy channel mention-only again, list it in
  `platforms.slack.extra.require_mention_channels`; that list overrides the
  global free-response setting. `free_response_channels` does the reverse under
  `require_mention: true`.

## Setup

### 1. Generate the app manifest

The manifest declares every Hermes slash command, OAuth scope, and event
subscription, and enables Socket Mode in one paste. Generate it from the same
Hermes version that runs the gateway, passing the name the installed app
already uses — the generator defaults to `Hermes` and would otherwise rename
the bot on the next manifest apply:

```bash
SLACK_MANIFEST_BOT_NAME=friday bash modules/hermes/scripts/slack-manifest.sh
```

The script runs `hermes slack manifest --agent-view --write` inside the `hermes`
container.

The Hermes CLI writes the manifest to `$HOME/.hermes/slack-manifest.json`. HOME
differs inside the container — the daemon uses `/opt/data` while `docker exec`
defaults to `/opt/data/home` — and only `/opt/data` is the host-mounted volume.
The script pins `HOME=/opt/data`, verifies the file, and prints the exact
container and host paths to read. Do not assume a bare `/opt/data/...json`
path: the file is under the `.hermes` subdirectory.

### 2. Create the Slack app

1. Open <https://api.slack.com/apps> → **Create New App** → **From an app manifest**
2. Pick your workspace, paste the manifest JSON, review, **Next** → **Create**

This handles scopes, event subscriptions, and slash commands. Verify:

- **Socket Mode** is ON (**Settings → Socket Mode**)
- **Messages Tab** is ON with "Allow users to send Slash commands and messages
  from the messages tab" (**Features → App Home**) — without it, DMs are blocked
  by Slack
- Bot events include `message.im`, `message.mpim`, `message.channels`,
  `message.groups`, `app_mention` (**Features → Event Subscriptions**)

If you build the app manually instead, the required bot scopes are `chat:write`,
`app_mentions:read`, `channels:history`, `channels:read`, `groups:history`,
`im:history`, `im:read`, `im:write`, `mpim:history`, `mpim:read`, `users:read`,
`files:read`, `files:write`. Optional: `groups:read`, `assistant:write`.

### 3. Collect the two tokens

| Token | Where | Prefix |
| --- | --- | --- |
| Bot User OAuth Token | **Settings → Install App** → Install to Workspace | `xoxb-` |
| App-Level Token | **Settings → Basic Information → App-Level Tokens** (scope `connections:write`) | `xapp-` |

Changing scopes or events later requires reinstalling the app.

### 4. Find your Slack Member ID

Hermes authorizes by **Member ID** (`U01ABC2DEF3`), not username. In Slack:
click your avatar → **View full profile** → **⋮** → **Copy member ID**.

### 5. Configure the repo secrets and variables

Secrets (**Settings → Secrets and variables → Actions → Secrets**):

| Name | Value |
| --- | --- |
| `SLACK_BOT_TOKEN` | `xoxb-…` |
| `SLACK_APP_TOKEN` | `xapp-…` |

Variables (**… → Variables**):

| Name | Value | Required |
| --- | --- | --- |
| `SLACK_ALLOWED_USERS` | comma-separated Member IDs | required — `deploy.sh` fails without it while Slack is enabled |
| `SLACK_HOME_CHANNEL` | channel ID for cron/scheduled delivery, e.g. `C01234567890` | optional |
| `SLACK_HOME_CHANNEL_NAME` | human-readable label, e.g. `general` | optional |

With free response enabled the allowlist is the only authorization gate, so the
deploy hard-requires it. Leaving it empty would otherwise produce a bot that
connects and answers nobody. Set it at the same scope the deploy job uses —
environment `darren-prod`, not repository scope.

The deployed value reaches the gateway through the profile's own `.env`, not
through the container environment: hermes authorizes a caller via the
per-profile secret scope, and with `gateway.multiplex_profiles` enabled a
container-only allowlist reads back empty — the bot connects and then rejects
every caller as unauthorized. `modules/hermes/50-seed-defaults` mirrors every
deployed `*_ALLOWED_USERS` into `$HERMES_HOME/.env` at boot, so redeploying the
variable is enough and the volume never needs a hand-edit. See
[DEPLOY.md](../../DEPLOY.md) for the full env-var path.

For a local (non-CI) deployment, put the same five keys in the gitignored
`modules/hermes/.env`:

```dotenv
SLACK_BOT_TOKEN=xoxb-…
SLACK_APP_TOKEN=xapp-…
SLACK_ALLOWED_USERS=U01ABC2DEF3
SLACK_HOME_CHANNEL=C01234567890
SLACK_HOME_CHANNEL_NAME=general
```

Never commit these values.

### 6. Deploy

`platforms.slack.enabled: true` is already committed. Merge (or redeploy), and
CI/CD rebuilds and restarts the gateway while `deploy.sh` verifies both tokens
are present. Then invite the bot to each channel where it should respond:

```
/invite @friday
```

The bot never auto-joins channels, and it joins only the channels you invite it
to. Once invited, it answers without an `@mention`.

### 7. Verify

- DM the bot → it answers without an `@mention`.
- In a channel, just type `status` (no mention) → it replies in a thread.
- Type `/` in Slack → Hermes slash commands appear in the autocomplete picker.

If it answers in DMs but not channels, the event subscriptions in step 2 are
missing, or it was never invited to that channel. If nothing responds at all,
confirm both tokens and that `SLACK_ALLOWED_USERS` contains a valid Member ID.

## Behaviour notes

- **No mention required in channels.** Every message from an allowlisted user
  reaches the agent, in every invited channel. Re-gate a noisy channel with
  `platforms.slack.extra.require_mention_channels` instead of changing the
  global flag.
- **Threading is on** (`reply_in_thread: true`), so channel conversations stay
  tidy. Multi-part replies attach to the user's message (`reply_to_mode: first`).
- **Link previews are suppressed** (`unfurl_links`/`unfurl_media: false`). This
  is not purely cosmetic: setting either key also switches native draft streaming
  to edit-based delivery, and media captions are posted as a separate message
  before the file (Slack's upload API cannot carry unfurl controls). Remove both
  keys to restore Slack's defaults and native streaming.
- **Block Kit rendering is on** (`rich_blocks: true`): tables and structured
  output render natively, with a plain-text fallback always sent alongside.
- **Other bots are ignored** (`allow_bots: "none"`).
- **Slash replies are ephemeral** ("Only visible to you") so command output does
  not spam a channel. Slack blocks native slash commands inside threads — use the
  `!` prefix there instead (`!status`, `!stop`).

## Rerouting push notifications to Slack

Webhook alerts currently deliver to Telegram:

```yaml
deliver: telegram
deliver_extra:
    chat_id: "${TELEGRAM_HOME_CHANNEL}"
```

To deliver them to Slack instead, change the route under
`platforms.webhook.extra.routes.notify`:

```yaml
deliver: slack
deliver_extra:
    chat_id: "${SLACK_HOME_CHANNEL}"
```

This is optional and independent of the Slack platform itself. Keeping Telegram
as the alert channel means a Slack outage cannot silence monitoring alerts.
