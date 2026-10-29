QUESTIONS
q: What kills the gateway on a deploy restart? | a: Two clocks. deploy.sh runs `docker stop hermes`, which SIGKILLs after the container's stop timeout (Docker default 10 s; the hermes service sets no `stop_grace_period`). Inside the image, s6-overlay 3.2.3.0 /init SIGTERMs every process at shutdown and SIGKILLs the survivors after `S6_KILL_GRACETIME`, default 3000 ms; the hermes service sets no S6_* variable.
q: Is the timing consistent with the evidence? | a: Yes. `gateway-exit-diag.log` shows every `gateway.previous_unclean_exit` since 2026-10-27 right after a container restart, and the one clean stop (2026-10-28 12:58 UTC) tore down in about 1.9 s, inside the 3 s s6 window. A gateway mid-turn takes longer and is killed.
q: Does `docker stop` without `-t` use the compose value? | a: Yes. Compose stores `stop_grace_period` as the container's StopTimeout, and `docker stop` without `-t` uses it, so deploy.sh needs no change.
q: Which values? | assumption: 60 s for Docker and 45 s for s6, so s6 always finishes or kills inside Docker's window. A hung gateway then delays a deploy by at most a minute, which fits the existing deploy health budget.

# Plan: give the hermes gateway time to shut down (issue #80)

## Problem

Since 2026-10-27 every gateway life that ends on a deploy restart is recorded as an unclean exit (#80). The SIGTERM arrives but no exit path runs before the process is killed, which risks a hard kill mid-write of the 530 MB state.db. Integrity checks have been `ok` so far.

## Change

In `modules/docker-compose.yml`, on the `hermes` service only:

1. Add `stop_grace_period: 60s` with a comment naming #80.
2. Add `S6_KILL_GRACETIME=45000` to its environment with a comment.

No change to deploy.sh, the image, or other services.

## Tests

- New `modules/tests/test_hermes_stop_grace.py` (the reproduction, `HermesStopGraceTests.test_docker_waits_a_minute_before_sigkill`) asserts both values and that the s6 window fits inside Docker's. RED at base, GREEN after.
- Existing `python3 -m unittest discover -s modules/tests -p 'test_*.py'`.

## Verification after deploy

The next deploy restart should log `asyncio.run.returned` instead of a following `gateway.previous_unclean_exit` in `gateway-exit-diag.log`; the nightly checks that.

## Out of scope

Making the gateway's own shutdown faster.
