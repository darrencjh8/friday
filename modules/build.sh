#!/usr/bin/env bash
# Build Docker images (no downtime). Supports --component.
# Usage: ./modules/build.sh --component hermes --component portfolio-tracker
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

COMPONENTS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --component) COMPONENTS+=("$2"); shift ;;
  esac
  shift
done
# Default to all
[[ ${#COMPONENTS[@]} -eq 0 ]] && COMPONENTS=("all")

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODULES_DIR="$ROOT/modules"
source_revision_or_unknown() {
    local repo="$1"
    if [ -n "$(git -C "$repo" status --porcelain 2>/dev/null)" ]; then
        printf 'unknown'
    else
        git -C "$repo" rev-parse HEAD
    fi
}

export HERMES_SOURCE_REVISION="$(source_revision_or_unknown "$ROOT")"
export CODEX_ROUTER_REVISION="$(source_revision_or_unknown "$MODULES_DIR/codex-router")"
cd "$MODULES_DIR"

export COMPOSE_DOCKER_CLI_BUILD=1 DOCKER_BUILDKIT=1
COMPOSE="docker-compose --project-name modules"

if [[ " ${COMPONENTS[*]} " =~ " all " ]]; then
  SERVICES=$($COMPOSE config --services 2>/dev/null | tr '\n' ' ')
else
  SERVICES="${COMPONENTS[*]}"
fi

# codex-router builds the two router colours; `codex-router` itself is the caddy
# front, a stock image this build has nothing to add to. Derived per token
# because SERVICES is one space-separated line, so a line-anchored match finds
# nothing and `all` would still try to build the front. awk drops the repeat a
# SERVICES naming both the front and a colour would otherwise produce. A colour
# name is not a component either: asking for one builds both colours, because
# deploy.sh rolls either of them and the one left unbuilt would keep serving this
# revision's predecessor.
# shellcheck disable=SC2086  # the loop splits SERVICES on purpose
BUILD_SERVICES=$(for SERVICE in $SERVICES; do
  case "$SERVICE" in
    codex-router|codex-router-a|codex-router-b) printf 'codex-router-a\ncodex-router-b\n' ;;
    *) printf '%s\n' "$SERVICE" ;;
  esac
done | awk '!seen[$0]++' | tr '\n' ' ')

echo "Building: $BUILD_SERVICES"

# ---- Pre-build: pp-cli.jar (Java CLI for Portfolio Performance) ----
if [[ " $SERVICES " =~ " portfolio-tracker " ]] || [[ " $SERVICES " =~ " all " ]]; then
  PT_DIR="$MODULES_DIR/portfolio-tracker"
  if command -v mvn &>/dev/null && [ -d "$PT_DIR/pp-cli" ]; then
    cd "$PT_DIR/pp-cli"
    # Install PP model JAR to local Maven (not on Maven Central)
    if [ -f lib/name.abuchen.portfolio-0.84.1.jar ]; then
      mvn install:install-file -q -Dfile=lib/name.abuchen.portfolio-0.84.1.jar \
        -DpomFile=lib/name.abuchen.portfolio-0.84.1.pom \
        -DgroupId=name.abuchen.portfolio -DartifactId=name.abuchen.portfolio \
        -Dversion=0.84.1 -Dpackaging=jar
    fi
    echo "Building pp-cli.jar..."
    if mvn package -q -DskipTests; then
      if [ -f target/pp-cli.jar ]; then
        echo "  pp-cli.jar built"
      fi
    else
      echo "  WARNING: mvn build failed — Docker build will fail if JAR is missing" >&2
    fi
    cd "$MODULES_DIR"
  else
    echo "  (skipping pp-cli — mvn not found or pp-cli not present)"
  fi
fi

# An empty list means there was nothing here this build knows how to build; a
# bare `$COMPOSE build` would build every service in the file instead.
if [[ " $BUILD_SERVICES " == *" hermes "* ]]; then
  # Refresh the pinned upstream base on Hermes builds; leave other services alone.
  $COMPOSE build --pull hermes
  BUILD_SERVICES="${BUILD_SERVICES//hermes/}"
fi
if [[ "$BUILD_SERVICES" =~ [^[:space:]] ]]; then
  $COMPOSE build $BUILD_SERVICES
fi
echo "✓ Build complete"

# ---- Portfolio Tracker: Java CLI ----
if [[ " ${COMPONENTS[*]} " =~ " all " ]] || [[ " ${COMPONENTS[*]} " =~ " portfolio-tracker " ]]; then
  PT_DIR="$ROOT/modules/portfolio-tracker"
  if command -v mvn &>/dev/null && [ -d "$PT_DIR/pp-cli" ]; then
    cd "$PT_DIR/pp-cli"
    if [ -f lib/name.abuchen.portfolio-0.84.1.jar ]; then
      mvn install:install-file -q -Dfile=lib/name.abuchen.portfolio-0.84.1.jar \
        -DpomFile=lib/name.abuchen.portfolio-0.84.1.pom \
        -DgroupId=name.abuchen.portfolio -DartifactId=name.abuchen.portfolio \
        -Dversion=0.84.1 -Dpackaging=jar 2>/dev/null || true
    fi
    echo "Building pp-cli.jar..."
    if mvn package -q -DskipTests; then
      if [ -f target/pp-cli.jar ]; then
        echo -e "  ${GREEN}✓ pp-cli.jar built${NC}"
      else
        echo -e "  ${YELLOW}! pp-cli.jar not found after build — may need manual build${NC}"
      fi
    else
      echo -e "  ${YELLOW}! mvn build failed — will use cached JAR if exists${NC}"
    fi
  else
    echo -e "  ${YELLOW}! mvn not found or pp-cli not present — skipping (will use cached JAR if exists)${NC}"
  fi
  cd "$MODULES_DIR"
fi

# Prune old images and build cache (keep latest)
docker image prune -f 2>/dev/null || true
docker builder prune -f --keep-storage 2GB 2>/dev/null || true
