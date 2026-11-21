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
_DESKTOP_TAG = re.compile(r"^desktop-v([0-9]+)\.([0-9]+)\.([0-9]+)$")
_MAX_SIGNATURE_BYTES = 4096
# Where github-auth.sh logs gh in as the GitHub App (it pins HOME=/opt/data/home).
_GH_CONFIG_DIR = "/opt/data/home/.config/gh"


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
        return self._download(asset)

    def _download(self, asset):
        try:
            payload = self._api(
                f"repos/{self.repo}/releases/assets/{asset['id']}",
                accept="application/octet-stream",
            )
        except ReleaseProxyError:
            raise ReleaseProxyError("release asset unavailable") from None
        if len(payload) != asset["size"]:
            raise ReleaseProxyError("release asset size mismatch")
        return payload

    def latest_desktop(self):
        """The newest desktop-v* release with a signed installer: what the Windows app's updater needs.
        Desktop releases are never GitHub's "latest" (that stays the APK), so pick by tag version."""
        try:
            releases = json.loads(self._api(f"repos/{self.repo}/releases?per_page=30"))
        except (ReleaseProxyError, json.JSONDecodeError):
            raise ReleaseProxyError("desktop releases unavailable") from None
        if not isinstance(releases, list):
            raise ReleaseProxyError("invalid releases response")
        candidates = []
        for release in releases:
            match = _DESKTOP_TAG.fullmatch(str(release.get("tag_name", ""))) if isinstance(release, dict) else None
            if match and not release.get("draft") and not release.get("prerelease"):
                candidates.append((tuple(int(part) for part in match.groups()), release))
        if not candidates:
            return None
        version, release = max(candidates, key=lambda item: item[0])
        assets = release.get("assets") or []
        exe = next((item for item in assets if str(item.get("name", "")).endswith("-setup.exe")), None)
        sig = exe and next((item for item in assets if item.get("name") == f"{exe['name']}.sig"), None)
        if sig is None:
            return None  # an unsigned build: nothing the updater could verify
        for item, cap in ((exe, _MAX_ASSET_BYTES), (sig, _MAX_SIGNATURE_BYTES)):
            if not isinstance(item.get("id"), int) or not isinstance(item.get("size"), int) or not 0 < item["size"] <= cap:
                raise ReleaseProxyError("invalid release asset metadata")
        try:
            signature = self._api(f"repos/{self.repo}/releases/assets/{sig['id']}", accept="application/octet-stream")
        except ReleaseProxyError:
            raise ReleaseProxyError("desktop signature unavailable") from None
        return {
            "version": ".".join(str(part) for part in version),
            "pub_date": release.get("published_at") or "",
            "signature": signature.decode("ascii", errors="replace").strip(),
            "asset": {"id": exe["id"], "name": exe["name"], "size": exe["size"]},
        }

    def desktop_asset(self, asset_id):
        """Only the newest desktop installer can be downloaded through here."""
        if not _ASSET_ID.fullmatch(str(asset_id)):
            raise ReleaseProxyError("invalid release asset")
        desktop = self.latest_desktop()
        if desktop is None or str(desktop["asset"]["id"]) != str(asset_id):
            raise ReleaseProxyError("release asset not found")
        return self._download(desktop["asset"])

    @staticmethod
    def _api(endpoint, accept=None):
        command = ["gh", "api", endpoint]
        if accept:
            command.extend(["-H", f"Accept: {accept}"])
        try:
            result = subprocess.run(command, check=False, capture_output=True, timeout=60, env=_gh_env())
        except (OSError, subprocess.TimeoutExpired):
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
    return env
