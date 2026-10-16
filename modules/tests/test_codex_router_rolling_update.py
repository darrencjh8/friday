"""codex-router must roll with no downtime.

The router is split into a published caddy front and two interchangeable colour
containers, and deploy.sh rolls one colour at a time. These tests pin the shape
of that split, the load-balancing and streaming directives the front needs, and
the derived build/up lists that keep the front out of both.
"""

import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).parents[2]
COMPOSE_FILE = Path(__file__).parents[1] / "docker-compose.yml"
DEPLOY_SCRIPT = Path(__file__).parents[1] / "deploy.sh"
BUILD_SCRIPT = Path(__file__).parents[1] / "build.sh"
CADDYFILE = Path(__file__).parents[1] / "codex-router-front/Caddyfile"
RECOVERY_WORKFLOW = ROOT / ".github/workflows/recover-codex-router-auth.yml"

COLOURS = ("codex-router-a", "codex-router-b")
# The directives the front relies on: a stable pick (`lb_policy first` plus the
# upstream order), a retry window for a request that lands on the colour being
# stopped, health probing that takes a dead colour out of rotation, and
# unbuffered streaming.
EXPECTED_DIRECTIVES = {
    "lb_policy": "first",
    "lb_try_duration": "30s",
    "lb_try_interval": "250ms",
    "health_uri": "/health/liveliness",
    "health_interval": "10s",
    "health_timeout": "5s",
    "fail_duration": "30s",
    "flush_interval": "-1",
}


def statement(text, name):
    """Return the shell statement assigning `name`, including a multi-line $( )."""
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith(f"{name}="))
    end = start
    while not lines[end].rstrip().endswith(")"):
        end += 1
    return "\n".join(lines[start : end + 1])


def run_derivation(script, name, sample_name, sample_value):
    """Source one derived list out of a script and return its tokens for a sample list."""
    body = "\n".join(
        [
            "set -euo pipefail",
            f"{sample_name}={shlex.quote(sample_value)}",
            statement(script, name),
            'printf "%s\\n" "$' + name + '"',
        ]
    )
    result = subprocess.run(
        ["bash", "-c", body], capture_output=True, text=True, check=True
    )
    return result.stdout.split()


def component_normalisation(deploy, components):
    """Run deploy.sh's colour-to-component normalisation over a component list."""
    lines = deploy.splitlines()
    start = next(
        i
        for i, line in enumerate(lines)
        if line.strip() == 'for i in "${!COMPONENTS[@]}"; do'
    )
    end = next(i for i in range(start, len(lines)) if lines[i].strip() == "done")
    body = "\n".join(
        [
            "set -euo pipefail",
            "COMPONENTS=(" + " ".join(shlex.quote(c) for c in components) + ")",
            "\n".join(lines[start : end + 1]),
            'printf "%s\\n" "${COMPONENTS[@]}"',
        ]
    )
    result = subprocess.run(
        ["bash", "-c", body], capture_output=True, text=True, check=True
    )
    return result.stdout.split()


def function_block(text, name):
    """Return the shell function `name() { ... }` from a script."""
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == f"{name}() {{")
    end = next(i for i in range(start, len(lines)) if lines[i].strip() == "}")
    return "\n".join(lines[start : end + 1])


def run_shell_functions(deploy, names, body):
    """Run several extracted shell functions under the deploy's own strict mode."""
    script = "\n".join(
        ["set -euo pipefail"]
        + [function_block(deploy, name) for name in names]
        + [body]
    )
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True)


def colour_selection(deploy, running, ready):
    """Run deploy.sh's serving/idle selection with stubbed container probes."""
    lines = deploy.splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == 'serving=""')
    end = next(
        i for i in range(start, len(lines)) if lines[i].strip().startswith('echo "  serving:')
    )
    body = "\n".join(
        [
            "set -euo pipefail",
            f"RUNNING={shlex.quote(running)}",
            f"READY={shlex.quote(ready)}",
            "ROUTER_PROBE_ATTEMPTS=3; ROUTER_PROBE_SLEEP=0",
            "colour_container() {",
            '  for c in $RUNNING; do [ "$c" = "$1" ] && printf "%s\\n" "$c"; done',
            "  return 0",
            "}",
            "colour_ready() {",
            '  for c in $READY; do [ "$c" = "$1" ] && return 0; done',
            "  return 1",
            "}",
            "\n".join(lines[start:end]),
            # Close the guard that keeps a failed probe out of the roll.
            "fi",
            'printf "%s|%s\\n" "$serving" "$idle"',
        ]
    )
    out = subprocess.run(
        ["bash", "-c", body], capture_output=True, text=True, check=True
    ).stdout.strip()
    return tuple(out.split("|"))


def roll_selection(deploy, running, ready_after):
    """Run the selection through the candidate's `up`, with COMPOSE=echo.

    `ready_after` maps a colour to the probe call on which it starts answering
    (1 answers at once, 0 never answers). Probe waits are set to zero.
    """
    lines = deploy.splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == 'serving=""')
    up = next(
        i
        for i in range(start, len(lines))
        if "--force-recreate" in lines[i] and '"$idle"' in lines[i]
    )
    after = " ".join(f"{k}={v}" for k, v in ready_after.items())
    body = "\n".join(
        [
            "set -euo pipefail",
            "COMPOSE=echo",
            'RED=""; NC=""',
            "failed=0",
            "ROUTER_PROBE_ATTEMPTS=3; ROUTER_PROBE_SLEEP=0",
            "declare -A AFTER CALLS",
            f"for kv in {after}; do AFTER[${{kv%%=*}}]=${{kv#*=}}; done",
            f"RUNNING={shlex.quote(running)}",
            "colour_container() {",
            '  for c in $RUNNING; do [ "$c" = "$1" ] && printf "%s\\n" "$c"; done',
            "  return 0",
            "}",
            "colour_ready() {",
            "  CALLS[$1]=$(( ${CALLS[$1]:-0} + 1 ))",
            '  local a="${AFTER[$1]:-0}"',
            '  [ "$a" -gt 0 ] && [ "${CALLS[$1]}" -ge "$a" ]',
            "}",
            "\n".join(lines[start : up + 1]),
            "fi",
            'printf "serving=%s idle=%s\\n" "$serving" "$idle"',
        ]
    )
    return subprocess.run(["bash", "-c", body], capture_output=True, text=True)


class CodexRouterRollingUpdateTests(unittest.TestCase):
    def setUp(self):
        self.compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        self.services = self.compose["services"]

    def test_front_publishes_4100_and_colors_do_not(self):
        front = self.services["codex-router"]
        self.assertIn("0.0.0.0:4100:4100", front["ports"])
        # A stock caddy image, so nothing here to build and no router env to pass.
        self.assertNotIn("build", front)
        self.assertNotIn("environment", front)
        # Pinned on purpose: deploy.sh only runs `compose up -d`, so a floating
        # tag would keep using whatever caddy image is already local, and 2.11.6
        # cut HTTP/1.1 POST streams off 60s after the body was read (caddy #8103).
        self.assertEqual("caddy:2.11.7-alpine", front["image"])
        # The directory, not the file: `git checkout` can replace the Caddyfile's
        # inode, and a bind-mounted file keeps the old one, so a reload would read
        # the configuration the container booted with.
        self.assertEqual(
            ["./codex-router-front:/etc/caddy:ro"],
            front["volumes"],
        )
        # The front's own label is what identifies it as the front: the compose
        # service name is reused by the legacy router container until the cutover
        # replaces it, so the name alone cannot say which one is running.
        self.assertIn("modules.role=codex-router-front", front["labels"])
        # The log rotation every other service gets from the shared anchor.
        self.assertEqual(
            self.services["hermes"]["logging"], front["logging"]
        )

        for colour in COLOURS:
            with self.subTest(colour=colour):
                # Both colours publish nothing: the front owns the port, so the
                # two can run at once.
                self.assertNotIn("ports", self.services[colour])

    def test_colors_share_one_image_and_keep_the_router_env(self):
        router = self.services["codex-router-a"]
        self.assertEqual("./codex-router", router["build"]["context"])
        self.assertEqual("modules-codex-router:local", router["image"])

        for colour in COLOURS:
            with self.subTest(colour=colour):
                other = self.services[colour]
                self.assertEqual(router["image"], other["image"])
                self.assertEqual(router["environment"], other["environment"])
                self.assertEqual(router["volumes"], other["volumes"])
                self.assertEqual("1536m", other["mem_limit"])

        # The credentials and knobs the single router service used to carry.
        for key in (
            "CODEX_ROUTER_AUTH_PASSWORD",
            "MODEL_API_KEY",
            "CODEX_ROUTER_OPENCODE_ZEN_MODELS",
            "CODEX_ROUTER_AUTO_THINKING_TIMEOUT_SECONDS",
        ):
            with self.subTest(key=key):
                self.assertTrue(
                    any(entry.startswith(f"{key}=") for entry in router["environment"]),
                    f"{key} missing from the colour environment",
                )
        self.assertEqual(
            "codex_router_state:/app/state", router["volumes"][0]
        )

    def test_colors_have_no_published_ports_and_cap_the_drain(self):
        for colour in COLOURS:
            with self.subTest(colour=colour):
                self.assertNotIn("ports", self.services[colour])
                # Docker's default is 10s, which SIGKILLs a streaming response
                # mid-flight; deploy.sh stops the old colour with the same budget.
                self.assertEqual("10m", self.services[colour]["stop_grace_period"])
                self.assertEqual(
                    "curl -fsS http://127.0.0.1:4100/health/liveliness || exit 1",
                    self.services[colour]["healthcheck"]["test"][1],
                )

    def test_front_caddyfile_shape(self):
        text = CADDYFILE.read_text(encoding="utf-8")
        raw = [line for line in text.splitlines() if line.split("#", 1)[0].strip()]
        lines = [line.split("#", 1)[0].strip() for line in raw]

        self.assertEqual(":4100 {", lines[0])
        self.assertEqual("}", lines[-1])
        proxy = [line for line in lines if line.startswith("reverse_proxy ")]
        self.assertEqual(1, len(proxy))
        # Exactly one site block and one nested proxy block, and no TLS automation
        # in front of a listener the compose network already terminates.
        self.assertEqual([":4100 {", proxy[0]], [line for line in lines if line.endswith("{")])
        self.assertNotIn("auto_https", text)
        self.assertIn("codex-router-a:4100 codex-router-b:4100", proxy[0])

        # Every directive is indented inside the site block, and the set and the
        # values are exactly the ones the front's behaviour depends on: the retry
        # window has to outlast a colour swap, and the health interval has to be
        # short relative to a roll.
        directives = [
            line.split()
            for line in lines[1:]
            if not line.startswith("reverse_proxy ") and line != "}"
        ]
        self.assertEqual(
            [[name, value] for name, value in EXPECTED_DIRECTIVES.items()],
            directives,
        )
        for line in raw[1:-1]:
            self.assertTrue(line.startswith((" ", "\t")), f"not indented: {line!r}")
        self.assertIn("lb_policy first", text)
        self.assertIn("flush_interval -1", text)

    def test_deploy_builds_the_colors_and_up_leaves_them_to_the_roll(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        # The shape `--component all` produces: the full service list, with both
        # colour tokens already present because the front expands to them. An
        # expansion that copies a colour token instead of dropping it repeats
        # each colour here.
        everything = "actual-api codex-router codex-router-a codex-router-b expense-tracker "
        self.assertEqual(
            ["actual-api", "codex-router-a", "codex-router-b", "expense-tracker"],
            run_derivation(deploy, "BUILD_TARGETS", "TARGETS", everything),
        )
        self.assertEqual(
            ["actual-api", "expense-tracker"],
            run_derivation(deploy, "UP_TARGETS", "TARGETS", everything),
        )
        # The front is never built: it is a stock caddy image.
        self.assertNotIn(
            "codex-router",
            run_derivation(deploy, "BUILD_TARGETS", "TARGETS", everything),
        )
        # A router-only deploy builds the colours and leaves the up to the roll.
        self.assertEqual(
            ["codex-router-a", "codex-router-b"],
            run_derivation(deploy, "BUILD_TARGETS", "TARGETS", "codex-router "),
        )
        self.assertEqual([], run_derivation(deploy, "UP_TARGETS", "TARGETS", "codex-router "))
        # A per-colour deploy still reaches that colour's image.
        self.assertEqual(
            ["codex-router-a"], run_derivation(deploy, "BUILD_TARGETS", "TARGETS", "codex-router-a ")
        )

    def test_deploy_derives_its_lists_next_to_targets_and_guards_them(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        targets = deploy.index("TARGETS=$($COMPOSE config --services")
        self.assertGreater(deploy.index("BUILD_TARGETS=$(for TARGET in $TARGETS"), targets)
        self.assertLess(deploy.index("BUILD_TARGETS=$(for TARGET in $TARGETS"), deploy.index("UP_TARGETS=$(for TARGET in $TARGETS"))
        # `build` with no service argument builds every service in the file, so an
        # empty derived list must skip the call instead of making it bare.
        self.assertIn('if [ -n "$BUILD_TARGETS" ]; then', deploy)
        # `up -d` with no service argument reconciles the whole project, so an
        # empty derived list must skip the generic up instead of calling it bare.
        self.assertIn('if [ -n "$UP_TARGETS" ]; then', deploy)
        for line in deploy.splitlines():
            if "$COMPOSE build" in line or "$COMPOSE up -d" in line:
                self.assertNotIn("$TARGETS", line)

    def test_build_script_pulls_hermes_base_only_for_hermes_builds(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            bin_dir = tmp_path / "bin"
            bin_dir.mkdir()
            compose_log = tmp_path / "compose.log"
            compose = bin_dir / "docker-compose"
            compose.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$COMPOSE_LOG"\n')
            compose.chmod(0o755)
            env = {
                **os.environ,
                "PATH": f"{bin_dir}:{os.environ['PATH']}",
                "COMPOSE_LOG": str(compose_log),
            }

            for component in ("hermes", "codex-router"):
                result = subprocess.run(
                    ["bash", str(BUILD_SCRIPT), "--component", component],
                    capture_output=True,
                    text=True,
                    env=env,
                )
                self.assertEqual(0, result.returncode, result.stderr)
                calls = compose_log.read_text(encoding="utf-8").splitlines()
                build_call = next(line for line in calls if " build " in f" {line} ")
                if component == "hermes":
                    self.assertIn(" build --pull hermes", f" {build_call}")
                else:
                    self.assertNotIn("--pull", build_call)
                compose_log.unlink(missing_ok=True)

    def test_build_script_builds_the_colors_and_never_the_front(self):
        build = BUILD_SCRIPT.read_text(encoding="utf-8")

        self.assertEqual(
            ["codex-router-a", "codex-router-b"],
            run_derivation(build, "BUILD_SERVICES", "SERVICES", "codex-router "),
        )
        self.assertEqual(
            ["hermes"], run_derivation(build, "BUILD_SERVICES", "SERVICES", "hermes ")
        )
        # A colour name is not a component: asking for one has to build both
        # colours, or the roll can promote the other colour's stale image.
        self.assertEqual(
            ["codex-router-a", "codex-router-b"],
            run_derivation(build, "BUILD_SERVICES", "SERVICES", "codex-router-a "),
        )
        # `--component all`: one build per colour, front dropped, order kept.
        self.assertEqual(
            ["codex-router-a", "codex-router-b", "hermes"],
            run_derivation(
                build,
                "BUILD_SERVICES",
                "SERVICES",
                "codex-router codex-router-a codex-router-b hermes ",
            ),
        )
        # `--component codex-router-a` alone must not turn into a bare build of
        # everything, and the echo must not claim to build the front.
        self.assertIn('if [[ "$BUILD_SERVICES" =~ [^[:space:]] ]]; then', build)
        self.assertNotIn("$COMPOSE build $SERVICES", build)
        self.assertIn("$COMPOSE build $BUILD_SERVICES", build)
        self.assertIn('echo "Building: $BUILD_SERVICES"', build)

    def test_deploy_orders_the_roll_before_stopping_the_old_colour(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        up_idle = deploy.index('$COMPOSE up -d --remove-orphans --force-recreate "$idle"')
        ready_wait = deploy.index('docker exec "$idle_container" curl -fsS')
        front = deploy.index("$COMPOSE up -d --remove-orphans codex-router")
        reload = deploy.index("caddy reload --config /etc/caddy/Caddyfile")
        stop_serving = deploy.index('$COMPOSE stop -t "$ROUTER_DRAIN_SECONDS" "$serving"')
        self.assertLess(up_idle, ready_wait)
        self.assertLess(ready_wait, front)
        self.assertLess(front, reload)
        self.assertLess(reload, stop_serving)

        # The roll is a roll: the idle colour is chosen, never both at once, and
        # the derived targets exclude all three router services from the generic up.
        self.assertIn("BUILD_TARGETS=", deploy)
        self.assertIn("UP_TARGETS=", deploy)
        self.assertIn('if [ -n "$serving" ]; then', deploy)
        # The stop keeps the drain budget the compose grace period allows.
        self.assertIn('ROUTER_DRAIN_SECONDS="${ROUTER_DRAIN_SECONDS:-600}"', deploy)

    def test_a_single_failed_probe_does_not_demote_the_only_colour(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        # (a) fails twice, answers on the third try: still serving, so the
        # candidate is the other colour.
        run = roll_selection(deploy, "codex-router-a", {"codex-router-a": 3})
        self.assertEqual(0, run.returncode, run.stderr)
        self.assertIn("serving=codex-router-a idle=codex-router-b", run.stdout)
        self.assertIn("--force-recreate codex-router-b", run.stdout)
        self.assertNotIn("--force-recreate codex-router-a", run.stdout)

    def test_a_wedged_only_colour_is_never_recreated_before_the_other_is_ready(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        for only, other in (
            ("codex-router-a", "codex-router-b"),
            ("codex-router-b", "codex-router-a"),
        ):
            with self.subTest(only=only):
                # (b) never answers: it is presumed to be the front's upstream.
                run = roll_selection(deploy, only, {})
                self.assertEqual(0, run.returncode, run.stderr)
                self.assertIn(f"idle={other}", run.stdout)
                self.assertIn(f"--force-recreate {other}", run.stdout)
                self.assertNotIn(f"--force-recreate {only}", run.stdout)
                # It is handled as the old colour: stopped after the front moves.
                self.assertIn(f"serving={only}", run.stdout)

    def test_probe_retry_is_configurable_and_roll_unchanged_when_healthy(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        self.assertIn("ROUTER_PROBE_ATTEMPTS", deploy)
        self.assertIn("ROUTER_PROBE_SLEEP", deploy)
        # (c) healthy serving colour: rolls onto the other.
        run = roll_selection(deploy, "codex-router-a", {"codex-router-a": 1})
        self.assertIn("serving=codex-router-a idle=codex-router-b", run.stdout)
        # (d) first deploy, nothing running: default colour, nothing to stop.
        run = roll_selection(deploy, "", {})
        self.assertIn("serving= idle=codex-router-a", run.stdout)
        self.assertIn("--force-recreate codex-router-a", run.stdout)

    def test_roll_never_recreates_the_serving_colour(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        both = "codex-router-a codex-router-b"

        cases = (
            # running colours, colours that answer, expected serving, expected idle
            ("", "", "", "codex-router-a"),
            # The cutover deploy starts codex-router-a and has nothing to stop, so
            # the next deploy finds a single running colour that is serving: the
            # candidate has to be the other one, or the roll recreates the only
            # upstream the front has.
            ("codex-router-a", "codex-router-a", "codex-router-a", "codex-router-b"),
            ("codex-router-b", "codex-router-b", "codex-router-b", "codex-router-a"),
            # A sole colour that does not answer is presumed to be the front's
            # only upstream (#691): it is the old colour, the other is the candidate.
            ("codex-router-a", "", "codex-router-a", "codex-router-b"),
            (both, "codex-router-a", "codex-router-a", "codex-router-b"),
            (both, "codex-router-b", "codex-router-b", "codex-router-a"),
            # Two colours running and neither answering (a timed-out roll): the
            # leftover candidate is re-used rather than a third choice invented.
            (both, "", "", "codex-router-a"),
        )
        for running, ready, serving, idle in cases:
            with self.subTest(running=running, ready=ready):
                self.assertEqual(
                    (serving, idle), colour_selection(deploy, running, ready)
                )
                self.assertNotEqual(serving, idle)

    def test_colour_component_deploys_the_router_instead_of_nothing(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        # `--component codex-router-a` is not a component: it resolves to the
        # router, so the roll and the generic up both see a service to act on
        # instead of the build-only no-op that would exit 0 having deployed
        # nothing.
        self.assertEqual(
            ["codex-router"], component_normalisation(deploy, ["codex-router-a"])
        )
        self.assertEqual(
            ["codex-router"], component_normalisation(deploy, ["codex-router-b"])
        )
        self.assertEqual(
            ["codex-router", "hermes"],
            component_normalisation(deploy, ["codex-router-a", "hermes"]),
        )
        # Everything else, including the router itself and `all`, is untouched.
        self.assertEqual(
            ["codex-router"], component_normalisation(deploy, ["codex-router"])
        )
        self.assertEqual(["all"], component_normalisation(deploy, ["all"]))
        # The rewrite has to happen before TARGETS is derived from COMPONENTS.
        self.assertLess(
            deploy.index('for i in "${!COMPONENTS[@]}"; do'),
            deploy.index("TARGETS=$($COMPOSE config --services"),
        )
        # should_deploy reads COMPONENTS, so it now matches the router.
        self.assertIn('[[ "$c" == "all" || "$c" == "$1" ]] && return 0', deploy)

    def test_roll_readiness_failure_keeps_the_serving_colour(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        self.assertIn("colour_container()", deploy)
        self.assertIn(
            """--format '{{.Names}} {{.Label "com.docker.compose.service"}}'""",
            deploy,
        )
        self.assertIn("--filter label=com.docker.compose.project=modules", deploy)
        self.assertIn("awk -v service=", deploy)
        self.assertIn("for colour in codex-router-a codex-router-b; do", deploy)
        # The container name is re-resolved on every attempt: a colour that is
        # crash-looping when `up -d` returns must not leave the probe empty for
        # the whole readiness budget.
        self.assertLess(
            deploy.index('for _ in $(seq 1 "$ROUTER_READY_ATTEMPTS"); do'),
            deploy.index('idle_container="$(colour_container "$idle")"'),
        )
        # A readiness timeout is a failed deploy, not a silent cutover: the
        # front is not moved and the old colour keeps serving.
        self.assertIn("failed=$((failed + 1))", deploy)
        self.assertIn('echo -e "  ${RED}✗ $idle did not become ready', deploy)

    def test_front_is_started_explicitly_and_the_roll_never_recreates_it(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        def needs_start(running, force_all=None):
            # Model `docker ps -q` and not "print whatever was canned": a present
            # front prints its id, an absent one exits 0 and prints nothing (the
            # shell's command substitution strips the trailing newline), and a
            # failed lookup exits non-zero. `""` therefore reaches front_running as
            # an empty string, which is the absent case the line below pins.
            body = "\n".join(
                [
                    "COMPOSE=docker-compose",
                    "unset FORCE_ALL" if force_all is None else f"FORCE_ALL={force_all}",
                    "docker() { "
                    f"[ -z {shlex.quote(running)} ] || printf '%s\\n' {shlex.quote(running)}"
                    "; }",
                    "front_needs_start",
                ]
            )
            return run_shell_functions(
                deploy, ("front_running", "front_needs_start"), body
            ).returncode

        # No front yet (the cutover deploy, or a stopped one): create it.
        self.assertEqual(0, needs_start(""))
        # A front that is already up is left alone: `up -d` would recreate it if
        # its stanza or image changed, closing the only published listener.
        self.assertEqual(1, needs_start("modules-codex-router-1"))
        # A deliberate change to the front's own stanza is still applicable.
        self.assertEqual(0, needs_start("modules-codex-router-1", "true"))
        self.assertEqual(0, needs_start("", "true"))

        # The create is gated, and the reload still runs on every roll: the
        # Caddyfile is a bind mount compose does not hash.
        gate = deploy.index("if front_needs_start; then")
        front_up = deploy.index("$COMPOSE up -d --remove-orphans codex-router")
        self.assertLess(gate, front_up)
        self.assertLess(front_up, deploy.index("caddy reload --config /etc/caddy/Caddyfile"))
        # The ceiling the gate cuts: only a Caddyfile edit is applied to a running
        # front, so its image or resource stanza needs FORCE_ALL.
        self.assertIn("FORCE_ALL", deploy)

    def test_a_failed_front_lookup_never_recreates_the_listener(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        # Structural: the lookup keeps its failure, the way colour_container does,
        # instead of `|| true`-ing it into "the front is absent".
        lookup = function_block(deploy, "front_running")
        self.assertNotIn("|| true", lookup)
        self.assertIn("|| return 2", lookup)

        def gate(running, force_all=None):
            # `docker ps -q` prints a container's id, and for an absent front exits
            # 0 with no output at all; `return 1` is the failed lookup. The absent
            # case therefore reaches front_running as an empty string rather than as
            # a newline, which is what makes the assertion below about absence.
            docker = (
                "docker() { return 1; }"
                if running is None
                else "docker() { "
                f"[ -z {shlex.quote(running)} ] || printf '%s\\n' {shlex.quote(running)}"
                "; }"
            )
            body = "\n".join(
                [
                    docker,
                    "unset FORCE_ALL" if force_all is None else f"FORCE_ALL={force_all}",
                    "front_needs_start",
                ]
            )
            return run_shell_functions(
                deploy, ("front_running", "front_needs_start"), body
            ).returncode

        # A failed `docker ps` proves nothing, so it never starts the front: the
        # start is `up -d codex-router`, and that recreates the one container that
        # owns 0.0.0.0:4100, closing every in-flight stream. The reload that
        # follows is the check instead, and it fails on a genuinely absent front.
        self.assertEqual(1, gate(None))
        self.assertEqual(1, gate(None, "true"))

        # A confirmed absence is still created, and a running front is still left
        # alone.
        self.assertEqual(0, gate(""))
        self.assertEqual(1, gate("modules-codex-router-1"))

    def test_a_wedged_candidate_is_recreated_on_every_roll(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        # A colour that runs but never answers is the idle colour on every roll.
        # Re-running `up -d` on an unchanged container is a no-op, so without
        # --force-recreate that container is re-selected forever and the deploy
        # fails every time while holding a second 1536 MiB router.
        line = next(
            line.strip()
            for line in deploy.splitlines()
            if "$COMPOSE up -d" in line and '"$idle"' in line
        )
        self.assertIn("--force-recreate", line)
        run = subprocess.run(
            [
                "bash",
                "-c",
                "set -euo pipefail\n"
                "COMPOSE=echo\n"
                "idle=codex-router-b\n" + line,
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertEqual(
            "up -d --remove-orphans --force-recreate codex-router-b",
            run.stdout.strip(),
        )

    def test_colour_probe_survives_a_docker_failure(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        # A failing `docker ps` is not "no such container". The readiness loop
        # re-resolves the container with a bare assignment inside `set -euo
        # pipefail`, so a transient docker error used to exit the script mid-roll:
        # the front was never moved, the started colour was left running beside
        # the serving one, and the deploy was recorded as failed while 4100 kept
        # serving.
        aborted = run_shell_functions(
            deploy,
            ("colour_container",),
            "docker() { return 1; }\n"
            'found="$(colour_container codex-router-a)" || found="unreadable"\n'
            'printf "found=%s\\n" "$found"\n',
        )
        self.assertEqual(0, aborted.returncode, aborted.stderr)
        self.assertEqual("found=unreadable\n", aborted.stdout)

        # A docker error and a real no-match both print nothing, so the status is
        # what separates them: the caller must not read a failed probe as absence.
        unreadable = run_shell_functions(
            deploy,
            ("colour_container",),
            "docker() { return 1; }\n"
            "colour_container codex-router-a\n",
        )
        self.assertEqual(2, unreadable.returncode)
        self.assertEqual("", unreadable.stdout)

        absent = run_shell_functions(
            deploy,
            ("colour_container",),
            "docker() { return 0; }\n"
            "colour_container codex-router-a\n",
        )
        self.assertEqual(0, absent.returncode, absent.stderr)
        self.assertEqual("", absent.stdout)

        found = run_shell_functions(
            deploy,
            ("colour_container",),
            "docker() { printf '%s\\n' 'modules-codex-router-a-1 codex-router-a' "
            "'modules-codex-router-b-1 codex-router-b'; }\n"
            "colour_container codex-router-b\n",
        )
        self.assertEqual(0, found.returncode, found.stderr)
        self.assertEqual("modules-codex-router-b-1\n", found.stdout)

    def test_colour_normalisation_runs_before_the_router_preflight(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        # `--component codex-router-a` is rewritten to the router, and the
        # preflight is keyed on the component: rewriting it afterwards skips the
        # router's required secrets and starts a router with an empty auth
        # password.
        normalise = deploy.index('for i in "${!COMPONENTS[@]}"; do')
        self.assertLess(normalise, deploy.index('check_var "CODEX_ROUTER_AUTH_PASSWORD"'))
        self.assertLess(normalise, deploy.index('check_var_optional "MODEL_API_KEY"'))
        self.assertLess(normalise, deploy.index("TARGETS=$($COMPOSE config --services"))

    def test_recovery_workflow_scopes_the_colour_lookup_to_this_project(self):
        workflow = RECOVERY_WORKFLOW.read_text(encoding="utf-8")

        # The colour lookup is a `docker ps` by compose service label on the
        # runner host, where another project's lookalike service would otherwise
        # be exec'd into.
        block = workflow[
            workflow.index("for service in codex-router-a") : workflow.index("docker exec -i")
        ]
        self.assertIn('--filter "label=com.docker.compose.project=modules"', block)

    def test_recovery_workflow_targets_a_colour_not_the_front(self):
        workflow = RECOVERY_WORKFLOW.read_text(encoding="utf-8")

        self.assertIn('--filter "label=com.docker.compose.service=$service"', workflow)
        self.assertIn("for service in codex-router-a codex-router-b; do", workflow)
        self.assertIn('docker exec -i "$container_id" python -u - "$ACCOUNT"', workflow)
        self.assertNotIn("label=com.docker.compose.service=codex-router \\", workflow)


    def test_a_failed_probe_never_recreates_a_colour_it_could_not_see(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        # A docker error names no container, but that is not evidence that none is
        # running. The selection reads an unreadable probe as "nothing is up" and
        # falls back to a default candidate; in the steady state the colour it
        # never saw is the one the front serves, and recreating that colour takes
        # away the front's only upstream.
        def roll(probe_status, running):
            lines = deploy.splitlines()
            start = next(
                i for i, line in enumerate(lines) if line.strip() == 'serving=""'
            )
            up = next(
                i
                for i in range(start, len(lines))
                if "--force-recreate" in lines[i] and '"$idle"' in lines[i]
            )
            body = "\n".join(
                [
                    "set -euo pipefail",
                    "COMPOSE=echo",
                    'RED=""; NC=""',
                    "failed=0",
                    f"PROBE_STATUS={probe_status}",
                    f"RUNNING={shlex.quote(running)}",
                    "colour_container() {",
                    '  [ "$PROBE_STATUS" = "0" ] || return "$PROBE_STATUS"',
                    '  for c in $RUNNING; do [ "$c" = "$1" ] && printf "%s\\n" "$c"; done',
                    "  return 0",
                    "}",
                    "\n".join(lines[start : up + 1]),
                    "fi",
                    'printf "failed=%s\\n" "$failed"',
                ]
            )
            return subprocess.run(["bash", "-c", body], capture_output=True, text=True)

        # The daemon did not answer: nothing is started or stopped, and the roll is
        # reported as failed so the next deploy retries from the same state.
        unreadable = roll(2, "codex-router-a")
        self.assertEqual(0, unreadable.returncode, unreadable.stderr)
        self.assertNotIn("up -d", unreadable.stdout)
        self.assertIn("skipping the codex-router roll", unreadable.stdout)
        self.assertIn("failed=1", unreadable.stdout)

        # A genuine absence (the cutover deploy, where no colour exists yet) still
        # creates the default colour.
        cutover = roll(0, "")
        self.assertEqual(0, cutover.returncode, cutover.stderr)
        self.assertIn(
            "up -d --remove-orphans --force-recreate codex-router-a", cutover.stdout
        )
        self.assertIn("failed=0", cutover.stdout)

    def test_the_readiness_probe_never_looks_the_colour_up_again(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        # The selection resolves each colour's container through one guarded
        # lookup, which can tell a docker failure from a genuine no-match. A
        # lookup inside the readiness probe is a second, unguarded one: its
        # failure reads as "this colour is not serving", the caller falls through
        # to the candidate branch, and the steady state — where the only running
        # colour is the one the front serves — ends in a force-recreate of the
        # front's only upstream. The probe takes the name the caller already
        # resolved instead.
        probe = function_block(deploy, "colour_ready")
        self.assertNotIn("colour_container", probe)
        self.assertIn('docker exec "$1"', probe)

        lines = deploy.splitlines()
        start = next(i for i, line in enumerate(lines) if line.strip() == 'serving=""')
        up = next(
            i
            for i in range(start, len(lines))
            if "--force-recreate" in lines[i] and '"$idle"' in lines[i]
        )

        def roll(probe_lookup_fails):
            body = "\n".join(
                [
                    "set -euo pipefail",
                    "COMPOSE=echo",
                    'RED=""; NC=""',
                    "failed=0",
                    f"PROBE_LOOKUP_FAILS={probe_lookup_fails}",
                    "docker() {",
                    "  if [ \"$1\" = ps ]; then",
                    # Fail the `docker ps` that the probe reaches through
                    # `colour_container`, and only that one: the selection's own
                    # lookup must keep working, so a roll that recreates the
                    # serving colour is the probe's doing.
                    '    case " ${FUNCNAME[*]} " in',
                    '      *" colour_ready "*) [ "$PROBE_LOOKUP_FAILS" = true ] && return 1 ;;',
                    "    esac",
                    '    printf "%s\\n" "modules-codex-router-a-1 codex-router-a"',
                    "  fi",
                    "  return 0",
                    "}",
                    function_block(deploy, "colour_container"),
                    function_block(deploy, "colour_ready"),
                    "\n".join(lines[start : up + 1]),
                    "fi",
                    'printf "failed=%s\\n" "$failed"',
                ]
            )
            return subprocess.run(["bash", "-c", body], capture_output=True, text=True)

        # Control: the colour answers, so it serves and the other colour rolls.
        healthy = roll("false")
        self.assertEqual(0, healthy.returncode, healthy.stderr)
        self.assertIn("serving: codex-router-a; rolling: codex-router-b", healthy.stdout)
        self.assertNotIn("force-recreate codex-router-a", healthy.stdout)

        # The probe's own lookup failing must change nothing: the colour still
        # serves, and the roll still takes the other one.
        raced = roll("true")
        self.assertEqual(0, raced.returncode, raced.stderr)
        self.assertIn("serving: codex-router-a; rolling: codex-router-b", raced.stdout)
        self.assertNotIn("force-recreate codex-router-a", raced.stdout)
        self.assertIn("failed=0", raced.stdout)

    def test_every_colour_probe_is_time_bounded(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        # A colour that runs with 4100 bound but never answers holds the connection
        # in its listen backlog, so `curl` without a deadline waits forever: the
        # readiness loop would never iterate, the 426 s budget would never be
        # reached, and the deploy job would hang to its six-hour default while
        # holding the shared deploy runner behind `concurrency: production-deploy`.
        roll = deploy[
            deploy.index("colour_container() {") : deploy.index('health_ok "codex-router"')
        ]
        probes = roll.split("curl -fsS")[1:]
        self.assertEqual(2, len(probes))
        for probe in probes:
            self.assertIn("--max-time 5 --connect-timeout 2", probe.split("http")[0])

        # The reload reaches the front's admin API through the same kind of exec,
        # so it carries a deadline too.
        self.assertIn("timeout 30 $COMPOSE exec -T codex-router caddy reload", deploy)

    def test_a_failed_stop_is_reported_instead_of_aborting_the_deploy(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        lines = deploy.splitlines()
        start = next(
            i for i, line in enumerate(lines) if line.strip() == "if $idle_ready; then"
        )
        not_ready = next(
            i
            for i in range(start, len(lines))
            if "did not become ready in" in lines[i]
        )
        region = "\n".join(lines[start : not_ready + 1])

        def roll(stop_status, reload_failures=0):
            with tempfile.TemporaryDirectory() as tmp:
                compose = Path(tmp) / "fake-compose"
                compose.write_text(
                    "#!/bin/sh\n"
                    f'[ "$1" = "stop" ] && exit {stop_status}\n'
                    'if [ "$1" = "exec" ]; then\n'
                    f'  n=$(cat "{tmp}/execs" 2>/dev/null || echo 0)\n'
                    "  n=$((n + 1))\n"
                    f'  printf "%s\\n" "$n" > "{tmp}/execs"\n'
                    f'  [ "$n" -gt {reload_failures} ] || exit 1\n'
                    "fi\n"
                    "exit 0\n",
                    encoding="utf-8",
                )
                compose.chmod(0o755)
                body = "\n".join(
                    [
                        "set -euo pipefail",
                        f"COMPOSE={compose}",
                        'RED=""; NC=""; GREEN=""',
                        "failed=0",
                        "idle_ready=true",
                        "serving=codex-router-a",
                        "idle=codex-router-a",
                        "ROUTER_DRAIN_SECONDS=600",
                        "front_needs_start() { return 1; }",
                        region,
                        "fi",
                        'printf "failed=%s\\n" "$failed"',
                    ]
                )
                return subprocess.run(
                    ["bash", "-c", body], capture_output=True, text=True
                )

        stopped = roll(0)
        self.assertEqual(0, stopped.returncode, stopped.stderr)
        self.assertIn("stopping codex-router-a (drain 600s)", stopped.stdout)
        self.assertIn("failed=0", stopped.stdout)

        # A non-zero stop used to end the script under `set -euo pipefail` after the
        # front had already moved, so the post-roll checks and the summary never
        # ran. It is a counted failure now, not an abort.
        broken = roll(1)
        self.assertEqual(0, broken.returncode, broken.stderr)
        self.assertIn("✗ stop codex-router-a failed", broken.stdout)
        self.assertIn("failed=1", broken.stdout)

        # `up -d` returns when the front's container starts, not when caddy has
        # bound its admin listener, so the reload on the start paths can land on a
        # booting front. That is a race, not a broken configuration: retrying it
        # keeps a serving front from being reported as a failed deploy.
        retried = roll(0, reload_failures=1)
        self.assertEqual(0, retried.returncode, retried.stderr)
        self.assertIn("stopping codex-router-a (drain 600s)", retried.stdout)
        self.assertIn("failed=0", retried.stdout)

        # The retry is bounded: a configuration caddy keeps refusing still fails
        # the deploy, after a fixed number of attempts rather than forever.
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        reload_loop = deploy[
            deploy.index("reload_ok=false") : deploy.index("if [ \"$reload_ok\" = true ]")
        ]
        self.assertEqual(1, reload_loop.count("caddy reload --config"))
        self.assertIn("for _ in 1 2 3; do", reload_loop)
        self.assertIn("sleep 2", reload_loop)

        refused = roll(0, reload_failures=99)
        self.assertEqual(0, refused.returncode, refused.stderr)
        self.assertIn("✗ caddy reload failed", refused.stdout)
        self.assertIn("failed=1", refused.stdout)
        self.assertNotIn("stopping codex-router-a", refused.stdout)


if __name__ == "__main__":
    unittest.main()
