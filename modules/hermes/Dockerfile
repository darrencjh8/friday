FROM nousresearch/hermes-agent:stable@sha256:36099926da316742423544e055d4734777105ffe6341873af5459b957d0c2919
# gh and ntn live in the persisted /opt/data volume, installed by the
# "Ensure Hermes container tooling" step in .github/workflows/deploy.yml, so
# rebuilding this image does not reinstall them.
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    qpdf \
    && rm -rf /var/lib/apt/lists/*
# Own Google Tasks CLI (stdlib only, no third-party binary).
COPY scripts/gtasks.py /usr/local/bin/gtasks
RUN chmod 0755 /usr/local/bin/gtasks
# The dev-loop checkout is refreshed at runtime, but its Python imports must be
# available in the image before gateway startup. Keep this manifest local to the
# Hermes image so the build does not depend on a runtime-mounted checkout.
# They get their own venv: the Hermes venv is sealed (no pip, never written),
# and these pins would downgrade its core packages (mcp 2.0.0 -> 1.30.0,
# uvicorn 0.41.0 -> 0.35.0, rich 14 -> 13). Run codex-router's tests with
# `codex-router-python scripts/run_tests.py`; it is a wrapper, not a symlink,
# because a symlinked venv interpreter does not find the venv's packages.
COPY requirements-codex-router.txt /tmp/requirements-codex-router.txt
# v0.22.2 omits PyYAML from the sealed agent venv; WebUI bootstrap imports yaml.
# Keep its one required dependency isolated and expose it only to the WebUI service.
RUN uv_bin="$(python3 -c 'from pm import uv_launcher; print(uv_launcher("uv"))')" \
    && "$uv_bin" venv /opt/codex-router-venv --python /usr/bin/python3 \
    && "$uv_bin" pip install --no-cache --python /opt/codex-router-venv/bin/python \
        --requirement /tmp/requirements-codex-router.txt \
    && "$uv_bin" pip install --target /opt/hermes-webui-deps --python /usr/bin/python3 PyYAML==6.0.3 \
    && rm /tmp/requirements-codex-router.txt \
    && printf '#!/bin/sh\nexec /opt/codex-router-venv/bin/python "$@"\n' > /usr/local/bin/codex-router-python \
    && chmod 755 /usr/local/bin/codex-router-python
# Issue #650: upstream runs a state.db quick_check on the event loop after an
# unclean exit (an hour+ on a multi-GB store). Move it to a background thread.
# The patch fails the build if the upstream text changes, so an image bump
# cannot silently drop it.
COPY patches/patch-lifecycle-ledger.py /tmp/patch-lifecycle-ledger.py
RUN python3 /tmp/patch-lifecycle-ledger.py /opt/hermes/gateway/lifecycle_ledger.py \
    && rm /tmp/patch-lifecycle-ledger.py
# Webhook sessions are one-shot, but a restart mid-run (and builds before upstream
# added the close hook) leaves them open, and prune only deletes ended rows. Add
# webhook to the automatic stale-open sweep. Fails the build on upstream drift.
COPY patches/patch-stale-open-webhook.py /tmp/patch-stale-open-webhook.py
RUN python3 /tmp/patch-stale-open-webhook.py /opt/hermes/hermes_state.py \
    && rm /tmp/patch-stale-open-webhook.py
# Auto-prune only bounds sessions by age. Also cap the session count and state.db size
# (sessions.max_sessions / sessions.max_db_mb). Fails the build on upstream drift.
COPY patches/patch-session-caps.py /tmp/patch-session-caps.py
RUN python3 /tmp/patch-session-caps.py /opt/hermes/hermes_state_maintenance.py \
    && rm /tmp/patch-session-caps.py
# Slack: upstream's block fallback misses msg_blocks_too_long (rich_blocks > 50 blocks) and has none
# for cannot_reply_to_message (gone thread parent), so those replies were dropped. Retry once as plain
# text / without thread_ts. Fails the build on upstream drift.
COPY patches/patch-slack-send-fallback.py /tmp/patch-slack-send-fallback.py
RUN python3 /tmp/patch-slack-send-fallback.py /opt/hermes/plugins/platforms/slack/adapter.py \
    && rm /tmp/patch-slack-send-fallback.py
COPY config.yaml SOUL.md.template /opt/hermes-defaults/
COPY skills/ /opt/hermes-defaults/skills/
COPY scripts/ /opt/hermes-defaults/scripts/
COPY profiles/ /opt/hermes-defaults/profiles/
COPY plugins/log-issue-triage/ /opt/hermes/plugins/log-issue-triage/
COPY plugins/learning-commands/ /opt/hermes/plugins/learning-commands/
# Read-only financial email intake, shadow mode (#783).
COPY plugins/email-intake/ /opt/hermes/plugins/platforms/email_intake/
# Precompile the source tree's bytecode at build time (upstream #136618): the
# image sets PYTHONDONTWRITEBYTECODE=1 and the tree is read-only at runtime, so
# every fresh agent process otherwise recompiles every import (~13s measured).
# Venv interpreter pins the bytecode format to the runtime. No behavior change.
RUN /opt/hermes/.venv/bin/python -m compileall -q -j 0 -x '/uv-cache/' /opt/hermes
RUN chmod +x /opt/hermes-defaults/scripts/*.sh
COPY 50-seed-defaults /etc/cont-init.d/50-seed-defaults
RUN chmod +x /etc/cont-init.d/50-seed-defaults
# Hermes WebUI (github.com/nesquena/hermes-webui) as a supervised service in
# this container, so it shares /opt/hermes, the agent venv, and HERMES_HOME with
# the gateway instead of holding a second copy of the agent source.
#
# Pinned to the commit behind tag v0.52.113. The fetch names the commit rather
# than the tag, so re-pointing the tag upstream cannot change what a rebuild
# produces, and a commit that no longer exists fails the build instead of
# silently building a different revision.
ARG HERMES_WEBUI_REF=c67fd2dd270a1128c2754200406bca58e9d9a25a
RUN git init /opt/hermes-webui \
    && cd /opt/hermes-webui \
    && git remote add origin https://github.com/nesquena/hermes-webui.git \
    && git fetch --depth 1 origin "$HERMES_WEBUI_REF" \
    && git checkout --detach FETCH_HEAD
COPY patches/patch-webui-api-mode.py /tmp/patch-webui-api-mode.py
RUN python3 /tmp/patch-webui-api-mode.py /opt/hermes-webui/api/streaming.py \
    && rm /tmp/patch-webui-api-mode.py
COPY webui/s6-rc.d/hermes-webui /etc/s6-overlay/s6-rc.d/hermes-webui
RUN chmod +x /etc/s6-overlay/s6-rc.d/hermes-webui/run \
    && touch /etc/s6-overlay/s6-rc.d/user/contents.d/hermes-webui
# Reminders dashboard (read-only stdlib page over the reminder snapshot).
COPY webui/s6-rc.d/reminders /etc/s6-overlay/s6-rc.d/reminders
RUN chmod +x /etc/s6-overlay/s6-rc.d/reminders/run \
    && touch /etc/s6-overlay/s6-rc.d/user/contents.d/reminders
# Debian's /etc/profile replaces PATH before it sources /etc/profile.d, so a
# login shell (`bash -lc`, `sh -lc`) loses the image PATH entry for the
# persisted volume directory and cannot see gh or ntn. Put it back for them;
# non-login shells already inherit it from the image environment.
RUN printf 'PATH="$PATH:/opt/data/.local/bin"\n' > /etc/profile.d/90-hermes-local-bin.sh
