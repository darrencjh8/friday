"""Guards that gh and ntn stay reachable from a login shell inside hermes (#667).

Debian's /etc/profile replaces PATH before it sources /etc/profile.d, so the
`/opt/data/.local/bin` entry the image environment carries is gone inside
`bash -lc` and `sh -lc`. gh and ntn are installed into that persisted volume
directory rather than an image layer, so a login shell finds neither: a live
agent reported "the gateway restart lost gh from PATH" while the binary was
present and current, and `docker exec ... sh -c 'command -v gh'` resolved it.

`docker compose config` cannot catch either half. It validates syntax, and the
PATH a login shell rebuilds is not part of the image environment it checks, so
assert both artifacts directly, like the other compose guards in this directory.
"""

from pathlib import Path
import unittest

import yaml


ROOT = Path(__file__).parents[2]
DOCKERFILE = ROOT / "modules/hermes/Dockerfile"
COMPOSE_FILE = ROOT / "modules/docker-compose.yml"

# /etc/profile.d is sourced after /etc/profile has already replaced PATH, so the
# volume directory has to be appended for the login shells that lost it.
PROFILE_SNIPPET = "/etc/profile.d/90-hermes-local-bin.sh"
PROFILE_PATH_ENTRY = 'PATH="$PATH:/opt/data/.local/bin"'
# run-parts only sources names matching this pattern, so the filename matters.
RUN_PARTS_NAME = r"^[a-zA-Z0-9_][a-zA-Z0-9._-]*\.sh$"

# github-auth.sh pins HOME=/opt/data/home, so gh's stored identity lives under
# that home; a shell keeping the container default reads an empty directory and
# reports "not logged into any GitHub hosts" while the App login is healthy.
GH_CONFIG_DIR = "GH_CONFIG_DIR=/opt/data/home/.config/gh"

HERMES_SERVICE = "hermes"


class LoginShellToolingTests(unittest.TestCase):
    def test_image_restores_the_volume_bin_directory_for_login_shells(self):
        dockerfile = DOCKERFILE.read_text(encoding="utf-8")
        self.assertIn(PROFILE_SNIPPET, dockerfile)
        self.assertIn(PROFILE_PATH_ENTRY, dockerfile)
        self.assertRegex(Path(PROFILE_SNIPPET).name, RUN_PARTS_NAME)

    def test_compose_pins_the_gh_config_directory_the_helper_writes(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        environment = compose["services"][HERMES_SERVICE].get("environment") or []
        self.assertIn(GH_CONFIG_DIR, environment)
