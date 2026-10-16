# shellcheck shell=bash
# Readiness budgets for the post-deploy health checks.
#
# The container is allowed longer to become ready than the deploy used to wait:
# the codex-router entrypoint gate polls /health/liveliness for 120 attempts of
# 3s (360s), and the router supervisor allows a cold start of
# CODEX_ROUTER_ROUTER_READY_SECONDS (420s by default). A deploy health check
# that gives up sooner reports a recovering router as a failed deploy -- and
# because sync-codex-router.yml reads the codex-router revision out of
# successful deploy runs only, that false failure re-dispatches a router-only
# deployment every five minutes, recreating the container it just declared dead.
#
# Both budgets are overridable from the environment. The attempt count is
# derived from them, so the deploy can never wait less than the container is
# allowed to take.
CONTAINER_READY_SECONDS="${CONTAINER_READY_SECONDS:-360}"
ROUTER_READY_SECONDS="${ROUTER_READY_SECONDS:-420}"
HEALTH_RETRY_SLEEP="${HEALTH_RETRY_SLEEP:-6}"
# shellcheck disable=SC2034  # read by modules/deploy.sh, which sources this file
ROUTER_READY_ATTEMPTS=$(( ROUTER_READY_SECONDS / HEALTH_RETRY_SLEEP + 1 ))
