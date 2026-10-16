# Setup

For full detail see [DEPLOY.md](../DEPLOY.md) and [SETUP.md](../SETUP.md).

Prerequisites:

- Docker and Docker Compose on the host.
- A Telegram bot token, or a Slack app with Socket Mode tokens, or both.
- Credentials for the services you intend to run: DeepSeek, Actual Budget, an IMAP mailbox, OneDrive, IBKR Flex, Google Sheets.

Short happy path:

```bash
git clone <repo-url> friday
cd friday

# Copy every .env.example that exists in the repo:
cp modules/expense-tracker/.env.example modules/expense-tracker/.env
cp modules/portfolio-tracker/.env.example modules/portfolio-tracker/.env
cp modules/image-gen/.env.example modules/image-gen/.env

# Fill in the values, then deploy everything:
./modules/deploy.sh --component all --non-interactive
```

`modules/hermes/` has **no** `.env.example` in the repo. The deploy script validates `modules/hermes/.env` for the Hermes variables (LLM keys, Telegram, Slack, webhook secret, GitHub App, dashboard auth, and the `IDENTITY_*` / `SOUL_VOICE_*` persona variables), so create that file by hand, or supply the same names as environment variables. In production they come from GitHub Actions secrets and variables — see `.github/workflows/deploy.yml`.

To deploy a single component:

```bash
./modules/deploy.sh --component expense-tracker --non-interactive
./modules/build.sh --component hermes        # build images only, no restart
```

`deploy.sh` flags: `--component <name>` (repeatable; names: `all`, `hermes`, `portfolio-tracker`, `expense-tracker`, `actual-api`, `codex-router`, `image-gen`), `--non-interactive` (skip the OneDrive auth prompt), and `--skip-build` (skip the internal `git pull` and image build — used by CI, which builds earlier in the same workflow).
