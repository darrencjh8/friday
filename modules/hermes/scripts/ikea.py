#!/usr/bin/env python3
"""Switch IKEA TRÅDFRI lights and plugs through the (old) TRÅDFRI gateway, on the LAN.

The gateway speaks CoAP over DTLS; libcoap's `coap-client-gnutls` does the transport.

  ikea pair <gateway-ip> [security-code]   once; the code is on the gateway's label
  ikea list                                 devices with type and on/off state
  ikea on|off <device name>                 exact name, or a unique part of one

Pairing trades the security code for a key of Friday's own, saved in /opt/data/ikea.json
(0600). The code itself is never stored.
"""

import getpass
import json
import os
import re
import subprocess
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor

CONFIG = os.environ.get("IKEA_CONFIG", "/opt/data/ikea.json")
# The gateway only offers PSK-AES128-CCM8, which the image's OpenSSL refuses at its default
# security level ("handshake failure"); GnuTLS still negotiates it.
COAP = "coap-client-gnutls"
# Device "5750" types the gateway reports, and the control list each one carries.
KINDS = {2: ("light", "3311"), 3: ("plug", "3312")}


class IkeaError(Exception):
    pass


def coap(method, host, path, identity, key, payload=None):
    # coap-client exits 0 whatever happens: CoAP errors ("4.01 Unauthorized") go to stderr,
    # and with logging off (-v 0) a failed handshake leaves no output at all.
    command = [COAP, "-m", method, "-B", "10", "-v", "0", "-u", identity, "-k", key]
    if payload is not None:
        command += ["-e", json.dumps(payload)]
    command.append(f"coaps://{host}:5684/{path}")
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=20, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise IkeaError("gateway did not answer") from None
    refused = re.search(r"^[45]\.\d\d.*$", result.stderr, re.M)
    if result.returncode or refused:
        raise IkeaError(f"gateway refused: {refused.group(0)}" if refused else "gateway did not answer")
    out = result.stdout.strip()
    if not out:
        if method in ("get", "post"):
            raise IkeaError("gateway did not answer")
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        raise IkeaError("unexpected gateway reply") from None


def pair(host, code):
    identity = f"friday-{uuid.uuid4().hex[:8]}"
    reply = coap("post", host, "15011/9063", "Client_identity", code, {"9090": identity})
    if not isinstance(reply, dict) or not reply.get("9091"):
        raise IkeaError("pairing refused: check the address and the security code")
    fd = os.open(CONFIG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"host": host, "identity": identity, "key": reply["9091"]}, f)


def load():
    try:
        with open(CONFIG) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        raise IkeaError("not paired yet: run `ikea pair <gateway-ip>`") from None


def devices(cfg):
    ids = coap("get", cfg["host"], "15001", cfg["identity"], cfg["key"])
    # Each call is a DTLS handshake of about a second: ask for every device at once.
    with ThreadPoolExecutor(max_workers=8) as pool:
        raws = list(pool.map(lambda i: coap("get", cfg["host"], f"15001/{i}", cfg["identity"], cfg["key"]), ids))
    found = []
    for device_id, raw in zip(ids, raws):
        kind = KINDS.get(raw.get("5750"))
        if kind is None:
            continue  # remotes, sensors, repeaters: nothing to switch
        control = (raw.get(kind[1]) or [{}])[0]
        found.append({"id": device_id, "name": raw.get("9001", ""), "type": kind[0], "on": bool(control.get("5850"))})
    return found


def pick(found, name):
    wanted = name.strip().lower()
    exact = [d for d in found if d["name"].lower() == wanted]
    if exact:
        return exact[0]
    partial = [d for d in found if wanted in d["name"].lower()]
    if len(partial) == 1:
        return partial[0]
    names = ", ".join(d["name"] for d in (partial or found))
    raise IkeaError(f"{'several' if partial else 'no'} devices match {name!r}: {names}")


def set_on(cfg, device, on):
    """Switches a device from `devices` (no lookup: one gateway call)."""
    control = KINDS[2 if device["type"] == "light" else 3][1]
    coap("put", cfg["host"], f"15001/{device['id']}", cfg["identity"], cfg["key"], {control: [{"5850": int(on)}]})


def switch(cfg, name, on):
    device = pick(devices(cfg), name)
    set_on(cfg, device, on)
    return device


def main(argv):
    if len(argv) >= 2 and argv[0] == "pair":
        code = argv[2] if len(argv) > 2 else getpass.getpass("Security code: ")
        pair(argv[1], code.strip())
        print("paired")
    elif argv == ["list"]:
        print(json.dumps(devices(load()), indent=2, ensure_ascii=False))
    elif len(argv) >= 2 and argv[0] in ("on", "off"):
        device = switch(load(), " ".join(argv[1:]), argv[0] == "on")
        print(f"{device['name']}: {argv[0]}")
    else:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except IkeaError as error:
        print(f"ikea: {error}", file=sys.stderr)
        sys.exit(1)
