#!/usr/bin/env python3
"""Wake the user's PC on the LAN (wake-on-LAN).

  wol set <pc-ip> <pc-mac>   once; saved in /opt/data/wol.json (0600)
  wol                        send the magic packet to the saved PC
  wol show                   the saved PC

The packet goes straight to the PC's IP (UDP port 9), not to a broadcast address: Hermes runs
on a Docker bridge, and broadcasts from a container never reach the LAN. A sleeping PC still
answers for its IP when its network card keeps ARP offload on.
"""

import ipaddress
import json
import os
import re
import socket
import sys

CONFIG = os.environ.get("WOL_CONFIG", "/opt/data/wol.json")
PORT = 9
MAC = re.compile(r"^[0-9a-f]{2}([:-]?)[0-9a-f]{2}(\1[0-9a-f]{2}){4}$", re.I)


class WolError(Exception):
    pass


def parse(ip, mac):
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        raise WolError(f"not an IP address: {ip!r}") from None
    # Only the home network: this never sends packets anywhere else.
    if address.version != 4 or not address.is_private or address.is_loopback:
        raise WolError(f"not a home network IPv4 address: {ip}")
    if not MAC.match(mac.strip()):
        raise WolError(f"not a MAC address: {mac!r} (like 98-8D-46-93-3E-4C)")
    return str(address), re.sub(r"[:-]", "", mac.strip()).upper()


def save(ip, mac):
    ip, mac = parse(ip, mac)
    fd = os.open(CONFIG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"ip": ip, "mac": mac}, f)
    return ip, mac


def load():
    try:
        with open(CONFIG) as f:
            cfg = json.load(f)
        return parse(cfg["ip"], cfg["mac"])
    except (OSError, ValueError, KeyError, TypeError):
        raise WolError("no PC saved yet: run `wol set <pc-ip> <pc-mac>`") from None


def packet(mac):
    """Six 0xFF bytes, then the MAC sixteen times."""
    return b"\xff" * 6 + bytes.fromhex(mac) * 16


def wake(ip, mac):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.sendto(packet(mac), (ip, PORT))
        except OSError as error:
            raise WolError(f"could not send to {ip}: {error.strerror or error}") from None


def main(argv):
    if len(argv) == 3 and argv[0] == "set":
        ip, mac = save(argv[1], argv[2])
        print(json.dumps({"ip": ip, "mac": mac}))
    elif argv == ["show"]:
        ip, mac = load()
        print(json.dumps({"ip": ip, "mac": mac}))
    elif argv == []:
        ip, mac = load()
        wake(ip, mac)
        print(f"magic packet sent to {ip}")
    else:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except WolError as error:
        print(f"wol: {error}", file=sys.stderr)
        sys.exit(1)
