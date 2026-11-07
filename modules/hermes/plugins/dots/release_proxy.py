"""Read the configured GitHub release using the host's existing gh auth."""

import json
import logging
import os
import re
import subprocess

logger = logging.getLogger(__name__)

_REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_ASSET_ID = re.compile(r"^[1-9][0-9]*$")
_MAX_ASSET_BYTES = 128 * 1024 * 1024
# Where github-auth.sh logs gh in as the GitHub App (it pins HOME=/opt/data/home).
_GH_CONFIG_DIR = "/opt/data/home/.config/gh"
# Where the image installs gh; the gateway's runtime PATH does not always include it.
_GH_BIN_DIR = "/opt/data/.local/bin"


class ReleaseProxyError(Exception):
    pass


class ReleaseProxy:
    def __init__(self, repo):
        if not _REPO.fullmatch(repo or ""):
            raise ReleaseProxyError("invalid release repository")
        self.repo = repo

    def latest(self):
        try:
            raw = self._api(f"repos/{self.repo}/releases/latest")
            release = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("[dots] latest release of %s is not JSON", self.repo)
            raise ReleaseProxyError("latest release unavailable") from None
        except ReleaseProxyError:
            raise ReleaseProxyError("latest release unavailable") from None
        if not isinstance(release, dict):
            raise ReleaseProxyError("invalid release response")

        assets = release.get("assets") or []
        apk = next((item for item in assets if str(item.get("name", "")).lower().endswith(".apk")), None)
        if apk is None:
            return None
        apk_name = apk.get("name")
        selected = [apk]
        selected.extend(item for item in assets if item.get("name") == f"{apk_name}.sha256")
        safe_assets = []
        for item in selected:
            asset_id, size = item.get("id"), item.get("size")
            if not isinstance(asset_id, int) or not isinstance(size, int) or not 0 <= size <= _MAX_ASSET_BYTES:
                raise ReleaseProxyError("invalid release asset metadata")
            safe_assets.append({"id": asset_id, "name": item["name"], "size": size})
        return {"tag_name": release.get("tag_name", ""), "html_url": release.get("html_url", ""), "assets": safe_assets}

    def asset(self, asset_id):
        if not _ASSET_ID.fullmatch(str(asset_id)):
            raise ReleaseProxyError("invalid release asset")
        release = self.latest()
        asset = next((item for item in (release or {}).get("assets", []) if str(item["id"]) == str(asset_id)), None)
        if asset is None:
            raise ReleaseProxyError("release asset not found")
        try:
            payload = self._api(
                f"repos/{self.repo}/releases/assets/{asset_id}",
                accept="application/octet-stream",
            )
        except ReleaseProxyError:
            raise ReleaseProxyError("release asset unavailable") from None
        if len(payload) != asset["size"]:
            raise ReleaseProxyError("release asset size mismatch")
        return payload

    @staticmethod
    def _api(endpoint, accept=None):
        command = ["gh", "api", endpoint]
        if accept:
            command.extend(["-H", f"Accept: {accept}"])
        try:
            result = subprocess.run(command, check=False, capture_output=True, timeout=60, env=_gh_env())
        except (OSError, subprocess.TimeoutExpired) as exc:
            logger.warning("[dots] gh api %s could not run: %s", endpoint, exc)
            raise ReleaseProxyError("GitHub CLI unavailable") from None
        if result.returncode:
            reason = result.stderr.decode(errors="replace").strip().splitlines()[:1]
            logger.warning("[dots] gh api %s failed (%d): %s", endpoint, result.returncode, reason[0] if reason else "")
            raise ReleaseProxyError("GitHub API request failed")
        return result.stdout


def _gh_env():
    """The gateway process environment can drift from the container's (Hermes adjusts it at runtime):
    always read the App login that github-auth.sh keeps fresh, never an ambient token."""
    env = {k: v for k, v in os.environ.items() if k not in ("GH_TOKEN", "GITHUB_TOKEN")}
    env["GH_CONFIG_DIR"] = _GH_CONFIG_DIR
    path = env.get("PATH", "")
    if _GH_BIN_DIR not in path.split(os.pathsep):
        env["PATH"] = os.pathsep.join(p for p in (path, _GH_BIN_DIR) if p)
    return env
