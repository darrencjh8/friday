import os
from pathlib import Path
import unittest

import yaml


REPO_ROOT = Path(__file__).parents[2]
DOCKERFILE = REPO_ROOT / "modules/hermes/Dockerfile"
COMPOSE_FILE = REPO_ROOT / "modules/docker-compose.yml"
SERVICE_DIR = REPO_ROOT / "modules/hermes/webui/s6-rc.d/sysstat"


class SysstatHostMetricsTests(unittest.TestCase):
    def test_sysstat_installed_in_hermes_image(self):
        text = DOCKERFILE.read_text(encoding="utf-8")
        start = text.index("apt-get install")
        block = text[start : text.index("&& rm -rf", start)]
        packages = block.replace("\\", " ").split()
        self.assertIn("sysstat", packages)

    def test_sa_volume_persisted(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        volumes = compose["services"]["hermes"]["volumes"]
        self.assertIn(
            "/home/runner/data/hermes/sysstat:/var/log/sysstat", volumes
        )

    def test_collector_service_installed(self):
        run = SERVICE_DIR / "run"
        self.assertEqual(
            "longrun", (SERVICE_DIR / "type").read_text(encoding="utf-8").strip()
        )
        self.assertTrue((SERVICE_DIR / "dependencies.d" / "base").exists())
        self.assertTrue(os.access(run, os.X_OK))
        text = run.read_text(encoding="utf-8")
        self.assertIn("sa1", text)
        self.assertIn("sleep 120", text)
        self.assertIn("-mtime +28", text)
        self.assertIn("/var/log/sysstat", text)

    def test_collector_runs_as_root(self):
        text = (SERVICE_DIR / "run").read_text(encoding="utf-8")
        self.assertNotIn("s6-setuidgid", text)

    def test_collector_service_installed_in_image(self):
        text = DOCKERFILE.read_text(encoding="utf-8")
        self.assertIn(
            "COPY webui/s6-rc.d/sysstat /etc/s6-overlay/s6-rc.d/sysstat", text
        )
        self.assertIn("chmod +x /etc/s6-overlay/s6-rc.d/sysstat/run", text)
        self.assertIn(
            "touch /etc/s6-overlay/s6-rc.d/user/contents.d/sysstat", text
        )


if __name__ == "__main__":
    unittest.main()
