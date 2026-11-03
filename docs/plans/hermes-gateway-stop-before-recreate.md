QUESTIONS
q: Which stage of the s6 shutdown uses up the 60 s on a deploy that records no SIGTERM? | assumption: Not proven. The services under /run/service get their TERM late in the s6 shutdown, and the gateway heartbeat kept running for 59 s of the 60 s on the logged recreate. The fix does not depend on which stage it is, because it stops the gateways before any of them starts.
q: Does `s6-svc -d` survive into the new container and keep a gateway down? | a: No. It changes only the supervisor's running state, and `/run/service` belongs to the old container. It writes no `down` file.
q: Does a deploy that leaves the container in place keep its gateways down? | a: It would, because compose does not recreate a container whose image and config are unchanged, so the deploy brings them back with `s6-svc -u`. On a new container that call does nothing.
q: Can a gateway that needs longer than 45 s hold the deploy forever? | a: No. `-T 45000` bounds the wait and the deploy continues, leaving today's behaviour as the fallback.

# Stop the hermes gateways before a deploy recreates the container

Issue: https://github.com/darrencjh8/friday/issues/107

## Problem

Deploys that recreate `hermes` often leave `Previous gateway life ... exited UNCLEANLY` with no `Received SIGTERM` line, which is followed by a state.db integrity check of up to six minutes. A plain gateway restart delivers SIGTERM, so the loss is in the path through a container stop. Not every recreate kills: the deploy on 2026-11-02 recorded a clean SIGTERM.

## Change

1. Add `modules/hermes/scripts/deploy-gateway-stop.sh`, sourced by `deploy.sh` like `deploy-ready-budget.sh`, with two functions.
   - `stop_hermes_gateways` runs `s6-svc -wD -T 45000 -d` on each `/run/service/gateway-*` inside `hermes`, in parallel, so the total wait stays at 45 s.
   - `start_hermes_gateways` runs `s6-svc -u` on the same services.
   - Both tolerate a missing or stopped container, because a first deploy has none.
2. In `deploy.sh`, when hermes is a target, call `stop_hermes_gateways` before the existing `docker stop` and `compose up`.
3. Call `start_hermes_gateways` after `compose up`, including when `up` fails, so a failed deploy does not leave a running container with no gateways. The failure still ends the deploy.

## Cost

A deploy with hermes as a target restarts its gateways even if compose would not recreate the container. That restart is a clean one.

## Tests

`modules/tests/test_hermes_gateway_stop.py` runs the helpers against a stubbed `docker` under `set -e`, and checks the order of the calls in `deploy.sh`.

These tests cannot show that the unclean exits stop. Only a real deploy can: the next recreate should log `Received SIGTERM` and no `exited UNCLEANLY` line.
