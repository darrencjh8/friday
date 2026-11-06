"""Read the configured GitHub release using the host's existing gh auth."""

import json
import re
import subprocess

_REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_ASSET_ID = re.compile(r"^[1-9][0-9]*$")
_MAX_ASSET_BYTES = 128 * 1024 * 1024


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
        except (ReleaseProxyError, json.JSONDecodeError):
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
            result = subprocess.run(command, check=False, capture_output=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired):
            raise ReleaseProxyError("GitHub CLI unavailable") from None
        if result.returncode:
            raise ReleaseProxyError("GitHub API request failed")
        return result.stdout
