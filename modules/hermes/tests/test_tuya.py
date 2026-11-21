import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("tuya", Path(__file__).parents[1] / "scripts" / "tuya.py")
tuya = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tuya)

CLOUD = [
    {"id": "plug1", "name": "Desk Fan", "key": "k1", "category": "cz",
     "mapping": {"1": {"code": "switch_1"}, "9": {"code": "countdown_1"}}},
    {"id": "bulb1", "name": "Bed Lamp", "key": "k2", "category": "dj",
     "mapping": {"20": {"code": "switch_led"}, "22": {"code": "bright_value_v2"}}},
    {"id": "door1", "name": "Door Sensor", "key": "k3", "category": "mcs", "mapping": {"1": {"code": "doorcontact_state"}}},
    {"id": "blind1", "name": "Bedroom Blinds", "key": "k4", "category": "cl",
     "mapping": {"1": {"code": "control"}, "2": {"code": "percent_control"}}},
    {"id": "ir1", "name": "Aircon", "key": "", "category": "infrared_ac", "mapping": {}},
]


class FakeDevice:
    """A Tuya device on the LAN: answers when the address and protocol version are right."""

    answers = {}  # ip -> (version, dps)
    sent = []

    def __init__(self, dev_id, address, local_key, **_):
        self.id, self.ip, self.version = dev_id, address, None

    def set_version(self, version):
        self.version = version

    def status(self):
        version, dps = self.answers.get(self.ip, (None, None))
        return {"dps": dps} if version == self.version else {"Error": "Network Error", "Err": "905"}

    def set_value(self, dp, value):
        self.sent.append((self.id, dp, value))
        return self.status()


class TuyaTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        cloud = types.SimpleNamespace(error=None, getdevices=lambda include_map: [dict(d) for d in CLOUD])
        fake = types.SimpleNamespace(Cloud=lambda **kw: cloud, Device=FakeDevice)
        FakeDevice.answers, FakeDevice.sent = {}, []
        for p in (patch.dict(sys.modules, tinytuya=fake), patch.object(tuya, "CONFIG", os.path.join(self.dir.name, "tuya.json"))):
            p.start()
            self.addCleanup(p.stop)

    def test_setup_saves_switchable_devices_with_their_switch(self):
        found, skipped = tuya.setup("sg", "id", "secret")
        self.assertEqual([(d["name"], d["type"], d["dp"]) for d in found], [("Desk Fan", "plug", "1"), ("Bed Lamp", "light", "20"), ("Bedroom Blinds", "blinds", "1")])
        self.assertEqual(skipped, [("Door Sensor", "no on/off switch Friday knows (category mcs, data points: doorcontact_state)"),
                                   ("Aircon", "no local key: a virtual device, or one only the cloud controls")])
        self.assertEqual(os.stat(tuya.CONFIG).st_mode & 0o777, 0o600)
        self.assertNotIn("secret", Path(tuya.CONFIG).read_text())

    def test_setup_again_keeps_addresses(self):
        tuya.setup("sg", "id", "secret")
        FakeDevice.answers = {"192.0.2.5": (3.4, {"1": True})}
        tuya.set_ip(tuya.load(), "desk", "192.0.2.5")
        tuya.setup("sg", "id", "secret")
        fan = tuya.load()["devices"][0]
        self.assertEqual((fan["ip"], fan["version"]), ("192.0.2.5", 3.4))

    def test_ip_finds_the_protocol_version(self):
        tuya.setup("sg", "id", "secret")
        FakeDevice.answers = {"192.0.2.6": (3.5, {"20": False})}
        self.assertEqual(tuya.set_ip(tuya.load(), "Bed Lamp", "192.0.2.6")["version"], 3.5)
        with self.assertRaisesRegex(tuya.TuyaError, "did not answer at 192.0.2.9"):
            tuya.set_ip(tuya.load(), "Desk Fan", "192.0.2.9")

    def test_list_and_switch(self):
        tuya.setup("sg", "id", "secret")
        FakeDevice.answers = {"192.0.2.5": (3.3, {"1": True})}
        tuya.set_ip(tuya.load(), "Desk Fan", "192.0.2.5")
        cfg = tuya.load()
        found = tuya.devices(cfg)
        self.assertEqual([(d["name"], d["on"]) for d in found], [("Desk Fan", True), ("Bed Lamp", False), ("Bedroom Blinds", False)])
        tuya.set_on(cfg, found[0], False)
        self.assertEqual(FakeDevice.sent, [("plug1", "1", False)])
        with self.assertRaisesRegex(tuya.TuyaError, 'no address yet: run `tuya ip "Bed Lamp" <ip>`'):
            tuya.set_on(cfg, found[1], True)

    def test_blinds_open_and_close(self):
        tuya.setup("sg", "id", "secret")
        FakeDevice.answers = {"192.0.2.8": (3.3, {"1": "open"})}
        tuya.set_ip(tuya.load(), "blinds", "192.0.2.8")
        cfg = tuya.load()
        blinds = next(d for d in tuya.devices(cfg) if d["type"] == "blinds")
        self.assertTrue(blinds["on"])
        tuya.set_on(cfg, blinds, False)
        tuya.set_on(cfg, blinds, True)
        self.assertEqual(FakeDevice.sent, [("blind1", "1", "close"), ("blind1", "1", "open")])

    def test_not_set_up(self):
        with self.assertRaisesRegex(tuya.TuyaError, "tuya setup"):
            tuya.load()

    def test_switch_dp_without_cloud_mapping(self):
        self.assertEqual(tuya.switch_dp("dj", None), "20")
        self.assertEqual(tuya.switch_dp("cz", {}), "1")
        self.assertIsNone(tuya.switch_dp("mcs", {"1": {"code": "doorcontact_state"}}))


if __name__ == "__main__":
    unittest.main()
