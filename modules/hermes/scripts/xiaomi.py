#!/usr/bin/env python3
"""Switch Xiaomi (Mi Home) lights, plugs and appliances on the LAN, over the miio protocol.

  xiaomi add "<name>" <ip> [light]    once per device; asks for its token (hidden)
  xiaomi list                         devices with type, address and on/off state
  xiaomi forget "<name>"

Each device answers only to its own 32-hex-digit token. Get the tokens once on a PC with the
Xiaomi Cloud Tokens Extractor (it lists every device of the Mi Home account with its IP and
token); Friday never logs in to the Xiaomi cloud. `add` checks the device answers and whether
it speaks MIoT (power at service 2, property 1) or the older miio `set_power`. Saved in
/opt/data/xiaomi.json (0600). Give each device a fixed address in the router.

ponytail: MIoT power is assumed at siid 2 / piid 1, true for Xiaomi's plugs, lights and
purifiers; a device keeping it elsewhere needs its spec (home.miot-spec.com) and an override.
"""

import getpass
import hashlib
import json
import os
import re
import socket
import struct
import sys
from concurrent.futures import ThreadPoolExecutor

CONFIG = os.environ.get("XIAOMI_CONFIG", "/opt/data/xiaomi.json")
PORT = 54321
TIMEOUT = 3.0


class XiaomiError(Exception):
    pass


# -- miio: a 32-byte header, then the JSON command, AES-128-CBC with keys derived from the token.


def _keys(token):
    key = hashlib.md5(token).digest()
    return key, hashlib.md5(key + token).digest()


def _cipher(token):
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    key, iv = _keys(token)
    return Cipher(algorithms.AES(key), modes.CBC(iv))


def encrypt(token, plain):
    from cryptography.hazmat.primitives import padding

    padder = padding.PKCS7(128).padder()
    enc = _cipher(token).encryptor()
    return enc.update(padder.update(plain) + padder.finalize()) + enc.finalize()


def decrypt(token, data):
    from cryptography.hazmat.primitives import padding

    dec = _cipher(token).decryptor()
    unpadder = padding.PKCS7(128).unpadder()
    return unpadder.update(dec.update(data) + dec.finalize()) + unpadder.finalize()


def packet(token, device_id, stamp, payload):
    """A command packet: the checksum is md5 over the header (with the token in its place) and data."""
    data = encrypt(token, payload)
    head = struct.pack(">HHIII", 0x2131, 32 + len(data), 0, device_id, stamp)
    return head + hashlib.md5(head + token + data).digest() + data


HELLO = bytes.fromhex("21310020") + b"\xff" * 28


class Miio:
    """One device, one command at a time: hello for its id and clock, then the command."""

    def __init__(self, ip, token):
        self.ip, self.token = ip, bytes.fromhex(token)
        self.ids = 0

    def _exchange(self, sock, data):
        sock.sendto(data, (self.ip, PORT))
        reply, _ = sock.recvfrom(4096)
        return reply

    def send(self, method, params):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(TIMEOUT)
            try:
                hello = self._exchange(sock, HELLO)
                _, _, _, device_id, stamp = struct.unpack(">HHIII", hello[:16])
                self.ids += 1
                body = json.dumps({"id": self.ids, "method": method, "params": params}).encode()
                reply = self._exchange(sock, packet(self.token, device_id, stamp + 1, body))
            except OSError:
                raise XiaomiError(f"no answer from {self.ip}") from None
        try:
            answer = json.loads(decrypt(self.token, reply[32:]).rstrip(b"\x00"))
        except ValueError:
            raise XiaomiError("unreadable answer: is the token right?") from None
        if "error" in answer:
            raise XiaomiError(f"refused: {answer['error'].get('message', answer['error'])}")
        return answer.get("result")


# -- Power, by the device's protocol: MIoT properties, or the older set_power / get_prop.


def get_power(device):
    miio = Miio(device["ip"], device["token"])
    if device["protocol"] == "miot":
        result = miio.send("get_properties", [{"did": "power", "siid": 2, "piid": 1}])
        if not result or result[0].get("code") != 0:
            raise XiaomiError("no power property at siid 2 / piid 1")
        return bool(result[0].get("value"))
    result = miio.send("get_prop", ["power"])
    if not result or result[0] not in ("on", "off"):
        raise XiaomiError("no power property")
    return result[0] == "on"


def put_power(device, on):
    miio = Miio(device["ip"], device["token"])
    if device["protocol"] == "miot":
        result = miio.send("set_properties", [{"did": "power", "siid": 2, "piid": 1, "value": bool(on)}])
        if not result or result[0].get("code") != 0:
            raise XiaomiError("refused the switch")
    else:
        miio.send("set_power", ["on" if on else "off"])


def detect(device):
    """The protocol the device answers power on: MIoT first, then the older miio."""
    for protocol in ("miot", "miio"):
        try:
            get_power({**device, "protocol": protocol})
            return protocol
        except XiaomiError as error:
            if "no answer" in str(error) or "token" in str(error):
                raise
    raise XiaomiError("it answers, but has no power switch Friday knows (see the MIoT note in `xiaomi` help)")


# -- Config and the `home` interface.


def load():
    try:
        with open(CONFIG) as f:
            cfg = json.load(f)
    except (OSError, json.JSONDecodeError):
        raise XiaomiError("not set up yet: run `xiaomi add \"<name>\" <ip>`") from None
    if not cfg.get("devices"):
        raise XiaomiError("no devices: run `xiaomi add \"<name>\" <ip>`")
    return cfg


def save(cfg):
    tmp = CONFIG + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    os.replace(tmp, CONFIG)


def add(name, ip, token, kind="plug"):
    token = token.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{32}", token):
        raise XiaomiError("a token is 32 hex digits")
    device = {"name": name.strip(), "ip": ip, "token": token, "type": kind}
    device["protocol"] = detect(device)
    try:
        cfg = load()
    except XiaomiError:
        cfg = {"devices": []}
    cfg["devices"] = [d for d in cfg["devices"] if d["name"].lower() != device["name"].lower()] + [device]
    save(cfg)
    return device


def forget(cfg, name):
    device = pick(cfg["devices"], name)
    cfg["devices"].remove(device)
    save(cfg)
    return device


def _state(device):
    try:
        return get_power(device)
    except XiaomiError:
        return False


def devices(cfg):
    """Every device; one that did not answer reads as off."""
    with ThreadPoolExecutor(max_workers=8) as pool:
        states = list(pool.map(_state, cfg["devices"]))
    return [{"id": d["name"], "name": d["name"], "type": d["type"], "on": on} for d, on in zip(cfg["devices"], states)]


def set_on(cfg, device, on):
    saved = next((d for d in cfg["devices"] if d["name"] == device["id"]), None)
    if saved is None:
        raise XiaomiError("unknown device: add it with `xiaomi add`")
    put_power(saved, on)


def pick(found, name):
    wanted = name.strip().lower()
    exact = [d for d in found if d["name"].lower() == wanted]
    if exact:
        return exact[0]
    partial = [d for d in found if wanted in d["name"].lower()]
    if len(partial) == 1:
        return partial[0]
    names = ", ".join(d["name"] for d in (partial or found))
    raise XiaomiError(f"{'several' if partial else 'no'} devices match {name!r}: {names}")


def main(argv):
    if len(argv) in (3, 4) and argv[0] == "add" and argv[3:] in ([], ["light"]):
        token = getpass.getpass(f"Token of {argv[1]}: ")
        device = add(argv[1], argv[2], token, "light" if argv[3:] else "plug")
        print(f"{device['name']}: {device['ip']} ({device['protocol']})")
    elif argv == ["list"]:
        cfg = load()
        ips = {d["name"]: d["ip"] for d in cfg["devices"]}
        print(json.dumps([{**d, "ip": ips[d["id"]]} for d in devices(cfg)], indent=2, ensure_ascii=False))
    elif len(argv) == 2 and argv[0] == "forget":
        print(f"{forget(load(), argv[1])['name']}: forgotten")
    else:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except XiaomiError as error:
        print(f"xiaomi: {error}", file=sys.stderr)
        sys.exit(1)
