import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "plugins" / "dots"))
from release_proxy import ReleaseProxy, ReleaseProxyError


class ReleaseProxyTest(unittest.TestCase):
    def test_latest_exposes_only_apk_and_matching_checksum_metadata(self):
        github_release = {
            "tag_name": "v0.2.0.3",
            "html_url": "https://github.com/owner/repo/releases/tag/v0.2.0.3",
            "assets": [
                {"id": 12, "name": "Friday-0.2.0.3.apk", "size": 400},
                {"id": 13, "name": "Friday-0.2.0.3.apk.sha256", "size": 80},
                {"id": 14, "name": "notes.txt", "size": 20},
            ],
        }
        with patch("release_proxy.subprocess.run", return_value=subprocess.CompletedProcess([], 0, json.dumps(github_release).encode(), b"")) as run:
            result = ReleaseProxy("owner/repo").latest()

        self.assertEqual(result["tag_name"], "v0.2.0.3")
        self.assertEqual([asset["id"] for asset in result["assets"]], [12, 13])
        self.assertEqual(run.call_args.args[0], ["gh", "api", "repos/owner/repo/releases/latest"])

    def test_download_only_allows_assets_from_latest_release(self):
        release = {"tag_name": "v1.0", "html_url": "", "assets": [{"id": 12, "name": "Friday.apk", "size": 9}]}
        responses = [
            subprocess.CompletedProcess([], 0, json.dumps(release).encode(), b""),
            subprocess.CompletedProcess([], 0, b"apk-bytes", b""),
        ]
        with patch("release_proxy.subprocess.run", side_effect=responses) as run:
            self.assertEqual(ReleaseProxy("owner/repo").asset(12), b"apk-bytes")

        self.assertIn("repos/owner/repo/releases/assets/12", run.call_args.args[0])
        self.assertIn("Accept: application/octet-stream", run.call_args.args[0])

    def test_download_rejects_asset_ids_outside_latest_release(self):
        release = {"tag_name": "v1.0", "html_url": "", "assets": [{"id": 12, "name": "Friday.apk", "size": 400}]}
        with patch("release_proxy.subprocess.run", return_value=subprocess.CompletedProcess([], 0, json.dumps(release).encode(), b"")) as run:
            with self.assertRaises(ReleaseProxyError):
                ReleaseProxy("owner/repo").asset(999)

        self.assertEqual(run.call_count, 1)

    def test_repository_name_is_validated_before_calling_gh(self):
        with patch("release_proxy.subprocess.run") as run:
            with self.assertRaises(ReleaseProxyError):
                ReleaseProxy("owner/repo;gh auth token")

        run.assert_not_called()

    def test_gh_reads_the_app_login_not_an_ambient_token(self):
        release = {"tag_name": "v1.0", "html_url": "", "assets": []}
        ambient = {"GH_TOKEN": "stale", "GITHUB_TOKEN": "stale", "GH_CONFIG_DIR": "/elsewhere", "PATH": "/usr/bin"}
        with patch.dict("release_proxy.os.environ", ambient, clear=True), \
                patch("release_proxy.subprocess.run", return_value=subprocess.CompletedProcess([], 0, json.dumps(release).encode(), b"")) as run:
            ReleaseProxy("owner/repo").latest()

        env = run.call_args.kwargs["env"]
        self.assertEqual(env["GH_CONFIG_DIR"], "/opt/data/home/.config/gh")
        self.assertNotIn("GH_TOKEN", env)
        self.assertNotIn("GITHUB_TOKEN", env)
        self.assertEqual(env["PATH"].split(":"), ["/usr/bin", "/opt/data/.local/bin"])

    def test_gh_that_cannot_start_is_logged(self):
        with patch("release_proxy.subprocess.run", side_effect=FileNotFoundError(2, "No such file", "gh")), \
                self.assertLogs("release_proxy", "WARNING") as logs:
            with self.assertRaises(ReleaseProxyError):
                ReleaseProxy("owner/repo").latest()

        self.assertIn("could not run", logs.output[0])

    def test_gh_failure_is_logged_with_its_reason(self):
        failed = subprocess.CompletedProcess([], 1, b"", b"gh: Not Found (HTTP 404)\nmore")
        with patch("release_proxy.subprocess.run", return_value=failed), self.assertLogs("release_proxy", "WARNING") as logs:
            with self.assertRaises(ReleaseProxyError):
                ReleaseProxy("owner/repo").latest()

        self.assertIn("gh: Not Found (HTTP 404)", logs.output[0])
        self.assertNotIn("more", logs.output[0])


if __name__ == "__main__":
    unittest.main()
