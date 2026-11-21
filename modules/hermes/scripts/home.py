#!/usr/bin/env python3
"""Friday's smart home: every light and plug, whichever system it belongs to.

  home list [--cached]        devices: name, type (light, plug), on, system
  home on|off <name>...       exact names, or a unique part of one each

Systems today: IKEA TRÅDFRI (`ikea`, paired once with `ikea pair`) and Tuya / Smart Life
(`tuya`, once with `tuya setup` and `tuya ip`), and infrared appliances through a Broadlink
RM (`broadlink`, `broadlink add` then `broadlink learn` per button), and Xiaomi / Mi Home
(`xiaomi`, `xiaomi add` per device with its token). A system that is not set up is skipped. `--cached` answers from the last list (instantly; the on/off states may be
stale), listing afresh only when there is none. Switching uses the last list too, so it is
one call per device, all at once; a name it doesn't know lists afresh first.
"""

import importlib.machinery
import importlib.util
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

CACHE = os.environ.get("HOME_DEVICES_CACHE", "/opt/data/home-devices.json")
HERE = os.path.dirname(os.path.realpath(__file__))


class HomeError(Exception):
    pass


def _backend(name):
    """A system's CLI script next to this one, as a module (installed without .py)."""
    for path in (os.path.join(HERE, f"{name}.py"), os.path.join(HERE, name)):
        if os.path.exists(path):
            loader = importlib.machinery.SourceFileLoader(name, path)
            module = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader))
            loader.exec_module(module)
            return module
    raise HomeError(f"{name} is not installed")


class Backend:
    """A system's CLI script used as a module: load(), devices(cfg), set_on(cfg, device, on)."""

    def __init__(self, name, error, script=None):
        self.name, self._error = name, error
        self.mod = _backend(script or name)

    def ready(self):
        try:
            self.cfg = self.mod.load()
            return True
        except self.error():
            return False

    def devices(self):
        return self.mod.devices(self.cfg)

    def set_on(self, device, on):
        self.mod.set_on(self.cfg, device, on)

    def error(self):
        return getattr(self.mod, self._error)


# Add a system here: its script next to this one, with load(), devices(cfg), set_on(cfg,
# device, on) and an error class.
SYSTEMS = (
    lambda: Backend("ikea", "IkeaError"),
    lambda: Backend("tuya", "TuyaError"),
    # Not broadlink.py: run as a script, that name would shadow the broadlink library.
    lambda: Backend("broadlink", "BroadlinkError", "broadlink_rm"),
    lambda: Backend("xiaomi", "XiaomiError"),
)


def systems():
    ready = [s for s in (cls() for cls in SYSTEMS) if s.ready()]
    if not ready:
        raise HomeError("no smart home system set up yet (IKEA: `ikea pair <gateway-ip>`, Tuya: `tuya setup`, Broadlink: `broadlink add <ip>`, Xiaomi: `xiaomi add <name> <ip>`)")
    return {s.name: s for s in ready}


def save(found):
    tmp = CACHE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(found, f, ensure_ascii=False)
    os.replace(tmp, CACHE)


def cached():
    try:
        with open(CACHE) as f:
            found = json.load(f)
        return found if isinstance(found, list) else None
    except (OSError, ValueError):
        return None


def fresh(ready):
    found = []
    for system in ready.values():
        try:
            found += [{**d, "system": system.name} for d in system.devices()]
        except system.error() as error:
            raise HomeError(f"{system.name}: {error}") from None
    save(found)
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
    raise HomeError(f"{'several' if partial else 'no'} devices match {name!r}: {names}")


def switch(names, on):
    ready = systems()
    found = cached() or []
    try:
        targets = [pick(found, n) for n in names]
    except HomeError:
        found = fresh(ready)  # a device added or renamed since the last list
        targets = [pick(found, n) for n in names]

    def one(device):
        system = ready.get(device.get("system"))
        if system is None:
            return f"{device['name']}: its system is not set up"
        try:
            system.set_on(device, on)
            device["on"] = on
            return None
        except system.error() as error:
            return f"{device['name']}: {error}"

    with ThreadPoolExecutor(max_workers=8) as pool:
        failed = [e for e in pool.map(one, targets) if e]
    save(found)  # the switched devices' new state
    if failed:
        raise HomeError("; ".join(failed))
    return [d["name"] for d in targets]


def main(argv):
    if argv[:1] == ["list"] and argv[1:] in ([], ["--cached"]):
        found = (argv[1:] and cached()) or fresh(systems())
        print(json.dumps([{k: d[k] for k in ("name", "type", "on", "system")} for d in found], indent=2, ensure_ascii=False))
    elif len(argv) >= 2 and argv[0] in ("on", "off"):
        for name in switch(argv[1:], argv[0] == "on"):
            print(f"{name}: {argv[0]}")
    else:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except HomeError as error:
        print(f"home: {error}", file=sys.stderr)
        sys.exit(1)
