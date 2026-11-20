"""The codex-router front refuses home-network callers without the LAN token.

4100 is published on every interface, so without this guard anything on the
home Wi-Fi could use the router's model subscriptions. Docker, host and
Tailscale serve callers arrive from loopback or a Docker bridge and need no
token. The token comes from a GitHub secret, never from the repository.
"""

from pathlib import Path
import unittest

import yaml

ROOT = Path(__file__).parents[2]


class TestRouterLanToken(unittest.TestCase):
    def test_caddyfile_refuses_lan_without_token(self):
        caddy = (ROOT / "modules/codex-router-front/Caddyfile").read_text(encoding="utf-8")
        self.assertIn("not remote_ip 127.0.0.0/8 172.16.0.0/12", caddy)
        self.assertIn('not header Authorization "Bearer {$CODEX_ROUTER_LAN_TOKEN}"', caddy)
        self.assertIn("respond @lan_without_token", caddy)
        # The guard must come before the proxy, or caddy would never reach it first.
        self.assertLess(caddy.index("respond @lan_without_token"), caddy.index("reverse_proxy"))

    def test_token_reaches_the_front_from_secrets(self):
        compose = yaml.safe_load((ROOT / "modules/docker-compose.yml").read_text(encoding="utf-8"))
        env = compose["services"]["codex-router"]["environment"]
        self.assertIn("CODEX_ROUTER_LAN_TOKEN=${CODEX_ROUTER_LAN_TOKEN:-}", env)
        workflow = (ROOT / ".github/workflows/deploy.yml").read_text(encoding="utf-8")
        self.assertIn("CODEX_ROUTER_LAN_TOKEN: ${{ secrets.CODEX_ROUTER_LAN_TOKEN }}", workflow)

    def test_cdp_forward_stays_off_the_home_network(self):
        unit = (ROOT / "cdp-forward.service").read_text(encoding="utf-8")
        self.assertIn("bind=172.17.0.1", unit)
        self.assertNotIn("bind=0.0.0.0", unit)


if __name__ == "__main__":
    unittest.main()
