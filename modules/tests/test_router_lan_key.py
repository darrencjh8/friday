"""The codex-router front refuses home-network callers without the router key.

4100 is published on every interface, so without this guard anything on the
home Wi-Fi could use the router's model subscriptions. Docker, host and
Tailscale serve callers arrive from loopback or a Docker bridge and need no
key. The key is the router's LITELLM_MASTER_KEY (also the manager's write
key), from a GitHub secret, never from the repository.
"""

from pathlib import Path
import unittest

import yaml

ROOT = Path(__file__).parents[2]


class TestRouterLanToken(unittest.TestCase):
    def test_caddyfile_refuses_lan_without_token(self):
        caddy = (ROOT / "modules/codex-router-front/Caddyfile").read_text(encoding="utf-8")
        self.assertIn("not remote_ip 127.0.0.0/8 172.16.0.0/12 100.64.0.0/10", caddy)
        self.assertIn('not header Authorization "Bearer {$LITELLM_MASTER_KEY}"', caddy)
        self.assertIn("respond @lan_without_token", caddy)
        # The guard must come before the proxy, or caddy would never reach it first.
        self.assertLess(caddy.index("respond @lan_without_token"), caddy.index("reverse_proxy codex-router-a"))

    def test_laptop_hermes_is_trusted_without_the_key(self):
        # Hermes on the laptop calls the router from the LAN with `api_key: local`,
        # so the front trusts that one address, and only on the server-lan layout.
        caddy = (ROOT / "modules/codex-router-front/Caddyfile").read_text(encoding="utf-8")
        self.assertIn("100.64.0.0/10 {$CODEX_ROUTER_TRUSTED_IP}", caddy)
        lan = yaml.safe_load((ROOT / "modules/docker-compose.server-lan.yml").read_text(encoding="utf-8"))
        self.assertIn(
            "CODEX_ROUTER_TRUSTED_IP=${LAPTOP_LAN_HOST:?LAPTOP_LAN_HOST is required}",
            lan["services"]["codex-router"]["environment"],
        )
        base = yaml.safe_load((ROOT / "modules/docker-compose.yml").read_text(encoding="utf-8"))
        self.assertFalse(
            any("CODEX_ROUTER_TRUSTED_IP" in e for e in base["services"]["codex-router"]["environment"])
        )

    def test_one_key_reaches_the_front_and_both_colours_from_secrets(self):
        compose = yaml.safe_load((ROOT / "modules/docker-compose.yml").read_text(encoding="utf-8"))
        for service in ("codex-router", "codex-router-a", "codex-router-b"):
            env = compose["services"][service]["environment"]
            self.assertIn("LITELLM_MASTER_KEY=${LITELLM_MASTER_KEY:-}", env, service)
        workflow = (ROOT / ".github/workflows/deploy.yml").read_text(encoding="utf-8")
        self.assertIn("LITELLM_MASTER_KEY: ${{ secrets.LITELLM_MASTER_KEY }}", workflow)

    def test_cdp_forward_stays_off_the_home_network(self):
        unit = (ROOT / "cdp-forward.service").read_text(encoding="utf-8")
        self.assertIn("bind=172.17.0.1", unit)
        self.assertNotIn("bind=0.0.0.0", unit)


if __name__ == "__main__":
    unittest.main()
