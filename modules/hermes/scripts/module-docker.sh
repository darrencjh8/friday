#!/bin/sh
# Docker CLI for the module containers (expense-tracker, codex-router-a/b,
# portfolio-tracker, actual-api, whisper, dots-web). Installed in the image as
# `module-docker`; it takes the same arguments as `docker`.
#
# When Hermes runs on another machine than the modules (the laptop), the
# compose override sets MODULES_DOCKER_HOST to the server's Docker over SSH,
# and this sends the command there. On the server it is unset (or empty), and
# this runs plain `docker` with the environment untouched, exactly as before.
# Commands for the hermes container itself use plain `docker`.
if [ -n "${MODULES_DOCKER_HOST:-}" ]; then
    DOCKER_HOST=$MODULES_DOCKER_HOST
    export DOCKER_HOST
fi
exec docker "$@"
