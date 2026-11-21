#!/usr/bin/env python3
"""Switch Tuya (Smart Life) lights and plugs on the LAN, with tinytuya.

  tuya setup                  once: fetch every device's local key from a Tuya IoT project
  tuya ip <name> <ip>         the device's LAN address (give it a fixed one in the router)
  tuya list                   devices with type, address and on/off state

Each device answers on the LAN only to its own local key. `tuya setup` asks for the Access ID
and Access Secret of a Tuya IoT cloud project linked to the Smart Life app, downloads the keys
into /opt/data/tuya.json (0600), and forgets the secret. Run it again after re-pairing a device
in the app (its key changes); addresses already given are kept.

Friday's container cannot hear the devices' LAN broadcasts, so each one needs its address once
(`tuya ip`), which also finds the protocol version it speaks.
"""

import getpass
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

CONFIG = os.environ.get("TUYA_CONFIG", "/opt/data/tuya.json")
# Tuya product categories that are lights; any other device with a power switch is a plug.
LIGHTS = {"dj", "dd", "dc", "xdd", "fwd", "tgq", "fsd", "gyd", "sxd", "tyndj"}
# The data point that switches a device, by its code in the cloud's mapping, most specific first.
SWITCH_CODES = ("switch_led", "switch", "switch_1")
# Blinds and curtains (category cl) move by a `control` data point: open, stop, close. Friday's
# on is open and off is close. ponytail: their state is the last command they report, so blinds
# stopped half-way, or reporting `stop`, read as closed; percent_state would give the position.
BLINDS = "cl"
BLINDS_CODE = "control"
VERSIONS = (3.3, 3.4, 3.5, 3.1)
REGIONS = ("us", "us-e", "eu", "eu-w", "in", "sg", "cn")


class TuyaError(Exception):
    pass


def ask(prompt, hidden=False):
    """A prompt in a terminal; without one (Friday's app sends the answers on stdin), just the next line."""
    if not sys.stdin.isatty():
        return sys.stdin.readline().strip()
    return (getpass.getpass(prompt) if hidden else input(prompt)).strip()


def load():
    try:
        with open(CONFIG) as f:
            cfg = json.load(f)
    except (OSError, json.JSONDecodeError):
        raise TuyaError("not set up yet: run `tuya setup`") from None
    if not cfg.get("devices"):
        raise TuyaError("no devices: run `tuya setup`")
    return cfg


def save(cfg):
    tmp = CONFIG + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    os.replace(tmp, CONFIG)


def switch_dp(category, mapping):
    """The data point that turns the device on and off, or None for a device without one."""
    codes = {str(v.get("code")): str(dp) for dp, v in (mapping or {}).items() if isinstance(v, dict)}
    for code in (*SWITCH_CODES, BLINDS_CODE):
        if code in codes:
            return codes[code]
    if mapping:
        return None  # a sensor, a remote: nothing to switch
    return "20" if category in LIGHTS else "1"  # no mapping from the cloud: Tuya's usual ones


def _type(category, mapping, dp):
    if category == BLINDS or (mapping or {}).get(dp, {}).get("code") == BLINDS_CODE:
        return "blinds"
    return "light" if category in LIGHTS else "plug"


def setup(region, access_id, secret):
    """Saves the switchable devices; returns them and the skipped ones, each with the reason."""
    import tinytuya

    cloud = tinytuya.Cloud(apiRegion=region, apiKey=access_id, apiSecret=secret)
    if getattr(cloud, "error", None):
        raise TuyaError(f"cloud refused: {cloud.error.get('Payload', cloud.error)}")
    listed = cloud.getdevices(include_map=True)
    if not isinstance(listed, list):
        raise TuyaError(f"cloud refused: {listed.get('Payload', listed) if isinstance(listed, dict) else listed}")
    try:
        known = {d["id"]: d for d in load()["devices"]}
    except TuyaError:
        known = {}
    devices, skipped = [], []
    for raw in listed:
        dp = switch_dp(raw.get("category", ""), raw.get("mapping"))
        name = raw.get("name") or raw["id"]
        if not raw.get("key"):
            skipped.append((name, "no local key: a virtual device, or one only the cloud controls"))
            continue
        if dp is None:
            codes = sorted(str(v.get("code")) for v in raw["mapping"].values() if isinstance(v, dict))
            skipped.append((name, f"no on/off switch Friday knows (category {raw.get('category')}, data points: {', '.join(codes)})"))
            continue
        old = known.get(raw["id"], {})
        devices.append({
            "id": raw["id"],
            "name": name,
            "key": raw["key"],
            "type": _type(raw.get("category"), raw.get("mapping"), dp),
            "dp": dp,
            "ip": old.get("ip"),
            "version": old.get("version"),
        })
    save({"devices": devices})
    return devices, skipped


def _device(device, version=None):
    import tinytuya

    d = tinytuya.Device(device["id"], device["ip"], device["key"], connection_timeout=3,
                        connection_retry_limit=1, connection_retry_delay=0)
    d.set_version(float(version or device["version"]))
    return d


def _answered(reply):
    return isinstance(reply, dict) and "Error" not in reply


def set_ip(cfg, name, ip):
    """Saves the device's address, with the first protocol version it answers to."""
    device = pick(cfg["devices"], name)
    for version in VERSIONS:
        if _answered(_device({**device, "ip": ip}, version).status()):
            device.update(ip=ip, version=version)
            save(cfg)
            return device
    raise TuyaError(f"{device['name']} did not answer at {ip}: check the address, and that its key is current")


def _state(device):
    if not device.get("ip"):
        return False
    reply = _device(device).status()
    if not _answered(reply):
        return False
    value = reply.get("dps", {}).get(device["dp"])
    return value == "open" if device["type"] == "blinds" else bool(value)


def devices(cfg):
    """Every device; one that has no address yet, or did not answer, reads as off."""
    with ThreadPoolExecutor(max_workers=8) as pool:
        states = list(pool.map(_state, cfg["devices"]))
    return [{"id": d["id"], "name": d["name"], "type": d["type"], "on": on} for d, on in zip(cfg["devices"], states)]


def set_on(cfg, device, on):
    """Switches a device from `devices`."""
    saved = next((d for d in cfg["devices"] if d["id"] == device["id"]), None)
    if saved is None:
        raise TuyaError("unknown device: run `tuya setup` again")
    if not saved.get("ip"):
        raise TuyaError(f"no address yet: run `tuya ip \"{saved['name']}\" <ip>`")
    value = ("open" if on else "close") if saved["type"] == "blinds" else bool(on)
    if not _answered(_device(saved).set_value(saved["dp"], value)):
        raise TuyaError("did not answer")


def pick(found, name):
    wanted = name.strip().lower()
    exact = [d for d in found if d["name"].lower() == wanted]
    if exact:
        return exact[0]
    partial = [d for d in found if wanted in d["name"].lower()]
    if len(partial) == 1:
        return partial[0]
    names = ", ".join(d["name"] for d in (partial or found))
    raise TuyaError(f"{'several' if partial else 'no'} devices match {name!r}: {names}")


def main(argv):
    if argv == ["setup"]:
        region = ask(f"Data center ({'/'.join(REGIONS)}) [sg]: ") or "sg"
        if region not in REGIONS:
            raise TuyaError(f"unknown data center {region!r}")
        access_id = ask("Access ID: ")
        secret = ask("Access Secret: ", hidden=True)
        if not access_id or not secret:
            raise TuyaError("both the Access ID and the Access Secret are needed (in a terminal, run it with `docker exec -it`)")
        found, skipped = setup(region, access_id, secret)
        print(f"{len(found)} devices saved; give each its address with `tuya ip \"<name>\" <ip>`:")
        for d in found:
            print(f"  {d['name']} ({d['type']}){': ' + d['ip'] if d['ip'] else ''}")
        if skipped:
            print(f"{len(skipped)} skipped:")
            for name, reason in skipped:
                print(f"  {name}: {reason}")
        if not found and not skipped:
            print("The cloud project lists no devices: link the Smart Life app to it, in the data center of the app account.")
    elif len(argv) == 3 and argv[0] == "ip":
        device = set_ip(load(), argv[1], argv[2])
        print(f"{device['name']}: {device['ip']} (protocol {device['version']})")
    elif argv == ["list"]:
        cfg = load()
        ips = {d["id"]: d.get("ip") for d in cfg["devices"]}
        print(json.dumps([{**d, "ip": ips[d["id"]]} for d in devices(cfg)], indent=2, ensure_ascii=False))
    else:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except TuyaError as error:
        print(f"tuya: {error}", file=sys.stderr)
        sys.exit(1)
    except EOFError:
        print("\ntuya: setup asks questions: run it with `docker exec -it`", file=sys.stderr)
        sys.exit(1)
