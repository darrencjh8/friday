#!/usr/bin/env bash
# =============================================================================
# Setup Self-Hosted GitHub Actions Runner
# Run this ONCE on the production server as a sudoer (e.g. darren).
#
# Usage:
#   1. Get a runner registration token from:
#      https://github.com/${REPO}/settings/actions/runners/new
#      (Settings → Actions → Runners → New self-hosted runner)
#   2. Run: bash scripts/setup-runner.sh <REGISTRATION_TOKEN>
#
# What this does:
#   - Creates a dedicated 'runner' user (no sudo except the chown line below)
#   - Adds runner to docker group
#   - Sets ACLs so runner can git pull + run deploy.sh in the repo
#   - Downloads (with SHA256 verification), registers, and starts the runner
#     as a systemd service
# =============================================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

REPO="${GITHUB_REPO:-darrencjh8/friday}"
REPO_PATH="${REPO_PATH:-/home/darren/workspace/hermes/${REPO#*/}}"
RUNNER_HOME="/home/runner"
RUNNER_DIR="$RUNNER_HOME/actions-runner"
RUNNER_VERSION="2.323.0"
RUNNER_NAME="prod-runner-01"
RUNNER_LABELS="self-hosted,production"
SERVICE_NAME="actions.runner.${REPO//\//-}.${RUNNER_NAME}"

# The hermes container runs as UID 10000 internally.
# deploy.sh chowns the workspace directory to this UID so the container
# can read/write files created by the host.
HERMES_UID=10000

# ---- preflight ----

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <REGISTRATION_TOKEN> [--force]"
  echo ""
  echo "  REGISTRATION_TOKEN  From GitHub → Settings → Actions → Runners → New self-hosted runner"
  echo "  --force             Re-register even if already configured"
  exit 1
fi

TOKEN="$1"
FORCE=false
[[ "${2:-}" == "--force" ]] && FORCE=true

if [[ $EUID -ne 0 ]] && ! sudo -n true 2>/dev/null; then
  echo -e "${RED}✗ This script needs sudo. Run as darren (sudoer).${NC}"
  exit 1
fi

# ---- step 1: create runner user ----

echo -e "${YELLOW}--- Step 1: Create runner user ---${NC}"

if id runner &>/dev/null; then
  echo "  runner user already exists"
else
  sudo useradd -m -s /bin/bash runner
  echo -e "  ${GREEN}✓ runner user created${NC}"
fi

# ---- step 2: docker group ----

echo -e "${YELLOW}--- Step 2: Docker group ---${NC}"

if groups runner | grep -q docker; then
  echo "  runner already in docker group"
else
  sudo usermod -aG docker runner
  echo -e "  ${GREEN}✓ runner added to docker group${NC}"
  echo -e "  ${YELLOW}⚠  Group change requires new login. The systemd service below gets a fresh session.${NC}"
fi

# ---- step 3: ACLs on repo ----

echo -e "${YELLOW}--- Step 3: Repo ACLs ---${NC}"

if [[ ! -d "$REPO_PATH" ]]; then
  echo -e "  ${RED}✗ Repo not found at $REPO_PATH${NC}"
  exit 1
fi

sudo setfacl -R -m u:runner:rwX "$REPO_PATH"
sudo setfacl -R -m d:u:runner:rwX "$REPO_PATH"
echo -e "  ${GREEN}✓ ACLs set on $REPO_PATH${NC}"

# ---- step 4: sudoers for workspace chown ----

echo -e "${YELLOW}--- Step 4: Sudoers ---${NC}"

# deploy.sh runs: sudo chown 10000:10000 "$HERMES_WS" (= /home/darren/workspace/hermes)
# The hermes Docker container runs as UID 10000 internally, so the workspace
# directory must be owned by 10000 for the container to write files.
SUDOERS_FILE="/etc/sudoers.d/runner"
CHOWN_PATH=$(which chown) || { echo -e "${RED}✗ chown not found in PATH${NC}"; exit 1; }
SUDOERS_RULE="runner ALL=(root) NOPASSWD: $CHOWN_PATH [0-9]* /home/darren/workspace/hermes"

if [[ -f "$SUDOERS_FILE" ]] && grep -qF "${HERMES_UID}:${HERMES_UID}" "$SUDOERS_FILE"; then
  echo "  sudoers entry already exists"
else
  echo "$SUDOERS_RULE" | sudo tee "$SUDOERS_FILE" > /dev/null
  sudo chmod 0440 "$SUDOERS_FILE"
  echo -e "  ${GREEN}✓ sudoers entry created${NC}"
fi

# ---- step 5: download + extract runner (with SHA256 verification) ----

echo -e "${YELLOW}--- Step 5: Download runner ---${NC}"

sudo -u runner mkdir -p "$RUNNER_DIR"

if [[ -f "$RUNNER_DIR/config.sh" ]] && [[ "$FORCE" != true ]]; then
  echo "  Runner already extracted (use --force to re-extract)"
else
  BASE_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}"
  TARBALL="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"

  cd "$RUNNER_DIR"

  sudo -u runner curl -o "$TARBALL" -L "${BASE_URL}/${TARBALL}"

  echo "  Verifying SHA256 checksum..."
  EXPECTED="0dbc9bf5a58620fc52cb6cc0448abcca964a8d74b5f39773b7afcad9ab691e19"
  ACTUAL=$(sha256sum "$TARBALL" | awk '{print $1}')
  if [[ "$ACTUAL" == "$EXPECTED" ]]; then
    echo -e "  ${GREEN}✓ Checksum verified${NC}"
  else
    echo -e "  ${RED}✗ SHA256 mismatch — aborting.${NC}"
    rm -f "$TARBALL"
    exit 1
  fi

  sudo -u runner tar xzf "$TARBALL"
  sudo -u runner rm -f "$TARBALL"
  echo -e "  ${GREEN}✓ Runner v${RUNNER_VERSION} extracted${NC}"
fi

# ---- step 6: register runner ----

echo -e "${YELLOW}--- Step 6: Register runner ---${NC}"

if [[ -f "$RUNNER_DIR/.runner" ]] && [[ "$FORCE" != true ]]; then
  echo "  Runner already registered (use --force to re-register)"
else
  sudo -u runner bash -c "
    cd '$RUNNER_DIR'
    ./config.sh \
      --url 'https://github.com/$REPO' \
      --token '$TOKEN' \
      --name '$RUNNER_NAME' \
      --labels '$RUNNER_LABELS' \
      --work '_work' \
      --unattended \
      --replace
  "
  echo -e "  ${GREEN}✓ Runner registered as '$RUNNER_NAME'${NC}"
fi

# ---- step 7: install + start systemd service ----

echo -e "${YELLOW}--- Step 7: Install systemd service ---${NC}"

cd "$RUNNER_DIR"

if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  echo "  Runner service already running — restarting..."
  sudo ./svc.sh stop
fi

sudo ./svc.sh install runner
sudo ./svc.sh start runner

echo ""
echo "========================================"
echo -e "  ${GREEN}✓ Runner installation complete.${NC}"
echo "========================================"
echo ""
echo "  Verify:"
echo "    systemctl status $SERVICE_NAME"
echo ""
echo "  Check GitHub:"
echo "    https://github.com/${REPO}/settings/actions/runners"
