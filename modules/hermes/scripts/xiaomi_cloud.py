"""Xiaomi cloud: sign in by a QR code scanned in the Mi Home app, then list the account's devices with
their LAN address and token. Used by `xiaomi cloud-qr` / `xiaomi cloud-wait`; Friday never sees the
password. Adapted from PiotrMachowski/Xiaomi-cloud-tokens-extractor (MIT).

The sign-in spans two commands (show the code, then wait for the scan), so the half-done session is
kept in /opt/data/xiaomi-login.json (0600) between them and deleted once used. Nothing of the
account is stored afterwards: only the tokens of the devices that get added, in xiaomi.json.
"""

import base64
import hashlib
import json
import os
import random
import time

CONFIG = os.environ.get("XIAOMI_LOGIN", "/opt/data/xiaomi-login.json")
# Xiaomi's regional clouds; an account's devices live on one of them.
SERVERS = ("sg", "cn", "de", "us", "ru", "tw", "in", "i2")
ACCOUNT = "https://account.xiaomi.com"
WAIT_S = 180


class CloudError(Exception):
    pass


def _session(cookies=None):
    import requests

    session = requests.Session()
    session.headers["User-Agent"] = (
        "".join(chr(random.randint(97, 122)) for _ in range(18)) + "-"
        + "".join(chr(random.randint(65, 69)) for _ in range(13)) + " APP/com.xiaomi.mihome APPV/10.5.201"
    )
    session.cookies.update(cookies or {})
    return session


def _json(text):
    return json.loads(text.replace("&&&START&&&", ""))


def _save(state):
    fd = os.open(CONFIG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(state, f)


def start():
    """A fresh QR code to scan: {"qr": PNG data URL, "url": the same sign-in as a link}."""
    import requests

    session = _session()
    try:
        reply = session.get(f"{ACCOUNT}/longPolling/loginUrl", timeout=15, params={
            "_qrsize": "480", "qs": "%3Fsid%3Dxiaomiio%26_json%3Dtrue", "callback": "https://sts.api.io.mi.com/sts",
            "_hasLogo": "false", "sid": "xiaomiio", "serviceParam": "", "_locale": "en_GB",
            "_dc": str(int(time.time() * 1000)),
        })
        data = _json(reply.text)
        image = session.get(data["qr"], timeout=15).content
    except (requests.RequestException, ValueError, KeyError):
        raise CloudError("Xiaomi's sign-in did not answer; try again") from None
    _save({"lp": data["lp"], "cookies": session.cookies.get_dict(), "agent": session.headers["User-Agent"]})
    return {"qr": "data:image/png;base64," + base64.b64encode(image).decode(), "url": data["loginUrl"]}


def wait(seconds=WAIT_S):
    """Waits for the code from `start` to be scanned; then every device of the account (all clouds)."""
    import requests

    try:
        with open(CONFIG) as f:
            state = json.load(f)
    except (OSError, ValueError):
        raise CloudError("no sign-in started: show the QR code first") from None
    os.remove(CONFIG)  # one use, whatever happens
    session = _session(state["cookies"])
    session.headers["User-Agent"] = state["agent"]
    deadline = time.monotonic() + seconds
    while True:
        try:
            reply = session.get(state["lp"], timeout=10)
            if reply.status_code == 200:
                break
        except requests.Timeout:
            pass
        except requests.RequestException:
            raise CloudError("lost Xiaomi's sign-in; show a new QR code") from None
        if time.monotonic() > deadline:
            raise CloudError("the QR code was not scanned in time; show a new one")
    try:
        login = _json(reply.text)
        token = session.get(login["location"], timeout=15).cookies["serviceToken"]
    except (requests.RequestException, ValueError, KeyError):
        raise CloudError("Xiaomi refused the sign-in; show a new QR code") from None
    api = _Api(session, str(login["userId"]), login["ssecurity"], token)
    found = {}
    for server in SERVERS:
        for device in api.devices(server):
            found.setdefault(device.get("did"), device)
    return list(found.values())


class _Api:
    """Xiaomi's app API: RC4-encrypted, signed requests with the session's ssecurity."""

    def __init__(self, session, user_id, ssecurity, token):
        self.session, self.user_id, self.ssecurity, self.token = session, user_id, ssecurity, token

    def devices(self, server):
        homes = []
        got = self._call(server, "/v2/homeroom/gethome", {"fg": True, "fetch_share": True, "fetch_share_dev": True, "limit": 300, "app_ver": 7})
        homes += [(h["id"], self.user_id) for h in ((got or {}).get("result") or {}).get("homelist") or []]
        got = self._call(server, "/v2/user/get_device_cnt", {"fetch_own": True, "fetch_share": True})
        shared = (((got or {}).get("result") or {}).get("share") or {}).get("share_family") or []
        homes += [(h["home_id"], h["home_owner"]) for h in shared]
        devices = []
        for home_id, owner in homes:
            got = self._call(server, "/v2/home/home_device_list", {"home_owner": int(owner), "home_id": int(home_id), "limit": 200,
                                                                    "get_split_device": True, "support_smart_home": True})
            devices += ((got or {}).get("result") or {}).get("device_info") or []
        return devices

    def _call(self, server, path, data):
        import requests

        url = f"https://{'' if server == 'cn' else server + '.'}api.io.mi.com/app{path}"
        nonce = base64.b64encode(os.urandom(8) + int(time.time() / 60).to_bytes(4, "big")).decode()
        signed = base64.b64encode(hashlib.sha256(base64.b64decode(self.ssecurity) + base64.b64decode(nonce)).digest()).decode()
        params = {"data": json.dumps(data)}
        params["rc4_hash__"] = _signature(path, params, signed)
        params = {k: base64.b64encode(_rc4(signed, v.encode())).decode() for k, v in params.items()}
        params.update(signature=_signature(path, params, signed), ssecurity=self.ssecurity, _nonce=nonce)
        cookies = {"userId": self.user_id, "serviceToken": self.token, "yetAnotherServiceToken": self.token,
                   "locale": "en_GB", "channel": "MI_APP_STORE"}
        headers = {"Accept-Encoding": "identity", "Content-Type": "application/x-www-form-urlencoded",
                   "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2", "MIOT-ENCRYPT-ALGORITHM": "ENCRYPT-RC4"}
        try:
            reply = self.session.post(url, params=params, cookies=cookies, headers=headers, timeout=15)
            return json.loads(_rc4(signed, base64.b64decode(reply.text))) if reply.status_code == 200 else None
        except (requests.RequestException, ValueError):
            return None  # this cloud is not the account's, or did not answer


def _signature(path, params, signed_nonce):
    parts = ["POST", path, *(f"{k}={v}" for k, v in params.items()), signed_nonce]
    return base64.b64encode(hashlib.sha1("&".join(parts).encode()).digest()).decode()


def _rc4(key_b64, data):
    """RC4 with the first 1024 bytes of keystream dropped, as Xiaomi's API does."""
    from cryptography.hazmat.decrepit.ciphers.algorithms import ARC4
    from cryptography.hazmat.primitives.ciphers import Cipher

    stream = Cipher(ARC4(base64.b64decode(key_b64)), mode=None).encryptor()
    stream.update(bytes(1024))
    return stream.update(data)
