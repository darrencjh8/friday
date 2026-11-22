#!/usr/bin/env python3
"""Switch infrared appliances (aircon, fan, TV, lamp) through a Broadlink RM remote, on the LAN.

  broadlink add <ip>                              once: the RM's address (fix it in the router)
  broadlink learn "<name>" on|off|power [light]   record one button of the appliance's remote
  broadlink list                                  appliances, learned buttons, believed state
  broadlink forget "<name>"

`learn` puts the RM in learning mode: point the appliance's remote at it and press the button
within 30 s. Learn `on` and `off` where the remote has both; a single power button (`power`)
toggles, so Friday only presses it when the appliance is not already in the wanted state.

Infrared is one-way: the state is what Friday last sent, not what the appliance is doing. A
remote pressed by hand, or a code that missed, puts them out of step; switching again fixes it.
Saved in /opt/data/broadlink.json (0600). ponytail: infrared only; RF remotes (433 MHz) need
the RM's frequency sweep, which `learn` does not do yet.
"""

import json
import os
import sys
import threading
import time

CONFIG = os.environ.get("BROADLINK_CONFIG", "/opt/data/broadlink.json")
BUTTONS = ("on", "off", "power")
LEARN_SECONDS = 30
# One RM sends one code at a time, and each send rewrites the state file: `home` switching
# several appliances at once goes through here one by one.
_SENDING = threading.Lock()


class BroadlinkError(Exception):
    pass


def load():
    try:
        with open(CONFIG) as f:
            cfg = json.load(f)
    except (OSError, json.JSONDecodeError):
        raise BroadlinkError("not set up yet: run `broadlink add <ip>`") from None
    if not cfg.get("host"):
        raise BroadlinkError("no RM address: run `broadlink add <ip>`")
    cfg.setdefault("devices", [])
    return cfg


def save(cfg):
    tmp = CONFIG + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    os.replace(tmp, CONFIG)


def connect(host):
    import broadlink
    from broadlink.exceptions import BroadlinkException

    try:
        rm = broadlink.hello(host, timeout=5)
        rm.auth()
        return rm
    except (BroadlinkException, OSError) as error:
        raise BroadlinkError(f"the RM at {host} did not answer ({error})") from None


def add(host):
    rm = connect(host)
    try:
        cfg = load()
    except BroadlinkError:
        cfg = {"devices": []}
    cfg["host"] = host
    save(cfg)
    return getattr(rm, "model", None) or type(rm).__name__


def learn(cfg, name, button, kind="plug", wait=LEARN_SECONDS):
    from broadlink.exceptions import ReadError, StorageError

    if button not in BUTTONS:
        raise BroadlinkError(f"button is one of {', '.join(BUTTONS)}")
    rm = connect(cfg["host"])
    rm.enter_learning()
    deadline = time.monotonic() + wait
    while True:
        time.sleep(1)
        try:
            code = rm.check_data()
            break
        except (ReadError, StorageError):  # nothing pressed yet
            if time.monotonic() > deadline:
                raise BroadlinkError(f"no button pressed within {wait} s") from None
    device = next((d for d in cfg["devices"] if d["name"].lower() == name.strip().lower()), None)
    if device is None:
        device = {"name": name.strip(), "type": kind, "on": False, "codes": {}}
        cfg["devices"].append(device)
    device["codes"][button] = code.hex()
    save(cfg)
    return device


def forget(cfg, name):
    device = pick(cfg["devices"], name)
    cfg["devices"].remove(device)
    save(cfg)
    return device


def devices(cfg):
    return [{"id": d["name"], "name": d["name"], "type": d["type"], "on": bool(d["on"])} for d in cfg["devices"]]


def set_on(cfg, device, on):
    """Sends the appliance's on or off code (or its power toggle, when not already so)."""
    saved = next((d for d in cfg["devices"] if d["name"] == device["id"]), None)
    if saved is None:
        raise BroadlinkError("unknown appliance: learn it with `broadlink learn`")
    codes = saved["codes"]
    code = codes.get("on" if on else "off")
    if code is None:
        if "power" not in codes:
            raise BroadlinkError(f"no {'on' if on else 'off'} button learned")
        if bool(saved["on"]) == bool(on):
            return  # a toggle would do the opposite
        code = codes["power"]
    from broadlink.exceptions import BroadlinkException

    with _SENDING:
        try:
            connect(cfg["host"]).send_data(bytes.fromhex(code))
        except BroadlinkException as error:
            raise BroadlinkError(f"the RM did not send ({error})") from None
        fresh = load()  # another appliance may have been switched since cfg was read
        for d in fresh["devices"]:
            if d["name"] == saved["name"]:
                d["on"] = bool(on)
        save(fresh)
        saved["on"] = bool(on)


def pick(found, name):
    wanted = name.strip().lower()
    exact = [d for d in found if d["name"].lower() == wanted]
    if exact:
        return exact[0]
    partial = [d for d in found if wanted in d["name"].lower()]
    if len(partial) == 1:
        return partial[0]
    names = ", ".join(d["name"] for d in (partial or found))
    raise BroadlinkError(f"{'several' if partial else 'no'} appliances match {name!r}: {names}")


def main(argv):
    if len(argv) == 2 and argv[0] == "add":
        print(f"RM at {argv[1]} saved ({add(argv[1])})")
    elif len(argv) in (3, 4) and argv[0] == "learn" and argv[3:] in ([], ["light"]):
        print(f"Point the remote at the RM and press {argv[1]}'s {argv[2]} button (within {LEARN_SECONDS} s)…", file=sys.stderr, flush=True)
        device = learn(load(), argv[1], argv[2], "light" if argv[3:] else "plug")
        print(f"{device['name']}: learned {', '.join(sorted(device['codes']))}")
    elif argv == ["list"]:
        cfg = load()
        print(json.dumps([{"name": d["name"], "type": d["type"], "on": d["on"], "buttons": sorted(d["codes"])} for d in cfg["devices"]], indent=2, ensure_ascii=False))
    elif len(argv) == 2 and argv[0] == "forget":
        print(f"{forget(load(), argv[1])['name']}: forgotten")
    else:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except BroadlinkError as error:
        print(f"broadlink: {error}", file=sys.stderr)
        sys.exit(1)
