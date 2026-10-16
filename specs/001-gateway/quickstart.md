# Quickstart: Hermes Migration

**Spec**: 021-hermes-migration
**Purpose**: Copy-paste commands for each phase. Read alongside `tasks.md`.

---

## Phase 1: Local Hermes Setup

```bash
# Install Hermes Agent
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash

# Configure provider (DeepSeek)
hermes setup --portal
# → Select "Custom Provider"
# → Base URL: https://api.deepseek.com/v1
# → API Key: <your DEEPSEEK_API_KEY>
# → Model: deepseek-flash

# Test chat
hermes chat
# Type: "hello" → confirm response

# Configure Telegram
cat >> ~/.hermes/.env << 'EOF'
TELEGRAM_BOT_TOKEN=<your bot token>
TELEGRAM_ALLOWED_USERS=<your chat id>
EOF

# Start gateway
hermes gateway
# → Send "hello" from Telegram → confirm response
```

## Phase 2: expense-tracker MCP Adapter

```bash
cd modules/expense-tracker

# Add MCP SDK
npm install --save-dev @modelcontextprotocol/sdk zod

# Create MCP server file
# → See: modules/expense-tracker/src/mcp-server.ts (T008-T011)

# Test with MCP Inspector
npx @modelcontextprotocol/inspector node src/mcp-server.ts

# Verify with Hermes (add to ~/.hermes/config.yaml):
cat >> ~/.hermes/config.yaml << 'EOF'
mcp_servers:
  expense-tracker:
    url: "http://localhost:8080/mcp"
EOF

# Reload MCP in Hermes chat:
# /reload-mcp
# "list available MCP tools"
```

## Phase 3: Hermes Docker Compose

```bash
# Create config directory
mkdir -p gateway/hermes/memories

# config.yaml template → see T016
# .env template → see T017
# SOUL.md template → see T018

# Start Hermes
cd gateway
docker compose up -d hermes

# Verify
docker logs hermes --tail 20
# Should show: "Hermes Agent" banner, platforms connected

# Test Telegram
# Send "hello" via Telegram → Hermes responds
```

## Phase 4: Memory Migration

```bash
# Locate MEMORY.md
find modules/expense-tracker -name "MEMORY.md"

# Run migration
bash scripts/migrate-memory.sh

# Verify in Hermes chat:
# "what credit card ends with 1888?"
# → Should return: Delta Extra credit card

# Copy to Docker volume
cp ~/.hermes/memories/MEMORY.md gateway/hermes/memories/
cp ~/.hermes/memories/USER.md gateway/hermes/memories/
```

## Phase 5: Email End-to-End Test

```bash
# Start with email channel
docker compose up -d hermes

# Verify email connected
docker exec hermes hermes gateway status
# → Should show: Email: connected

# Send test receipt (from allowed sender)
# → Wait 15 seconds

# Check Hermes logs
docker logs hermes --tail 30 | grep -i "mcp_expense_tracker"

# Verify in Actual Budget
# → Transaction should appear
```

## Phase 6: Self-Debugger Test

```bash
# In Telegram, type:
"debug expense-tracker"
# → Thinker spawns, checks Docker logs + health

# Simulate failure
docker compose stop actual-api
# → In Telegram: "debug expense-tracker"
# → Thinker identifies actual-api is down
# → Recommends restart

# Approve restart
# → Reply "yes"
# → Hermes runs: docker compose restart actual-api
# → Confirms health: curl actual-api:3000/health → 200
```

## Phase 7: Daily Auditor

```bash
# In Hermes chat (or Telegram):
/cron add "every day at 3am" "Inspect Hermes logs for errors in the past 24 hours, check Docker container health (docker ps), check expense-tracker health endpoint (curl expense-tracker:8080/health), check actual-api health (curl actual-api:3000/health). If all healthy, respond with [SILENT]. If issues found, describe each issue and recommend action."

# Verify
hermes cron list

# Trigger manually
hermes cron run <job_id>

# Check output
ls ~/.hermes/cron/output/
```

## Phase 8: Production Deploy

```bash
# NOTE: All production commands require explicit approval per project rules

# Backup
ssh darren@<prod-host> 'cd ~/friday && git pull'

# Deploy configs
scp -r gateway/hermes/ darren@<prod-host>:~/friday/gateway/hermes/
scp gateway/docker-compose.yml darren@<prod-host>:~/friday/gateway/docker-compose.yml

# Build & start
ssh darren@<prod-host> 'cd ~/friday/gateway && docker compose build expense-tracker && docker compose up -d hermes expense-tracker'

# Verify
ssh darren@<prod-host> 'docker logs hermes --tail 20'
ssh darren@<prod-host> 'docker compose ps'
```

## Phase 10: OpenClaw Decommission

```bash
# NOTE: Only after 48h stable validation

ssh darren@<prod-host> << 'ENDSSH'
cd ~/friday/gateway
docker compose stop openclaw
# → Verify Hermes still processes emails

# Archive configs
mkdir -p archive/openclaw
mv openclaw.json openclaw.json.bk exec-approvals.json *.md.template archive/openclaw/

# Remove from compose
# → Edit docker-compose.yml: remove openclaw service + volumes

docker compose up -d
docker compose ps
# → Should show: hermes, expense-tracker, actual-api only
ENDSSH
```
