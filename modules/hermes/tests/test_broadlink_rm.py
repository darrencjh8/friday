import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("broadlink_rm", Path(__file__).parents[1] / "scripts" / "broadlink_rm.py")
rm_cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rm_cli)


class BroadlinkException(Exception):
    pass


class ReadError(BroadlinkException):
    pass


class StorageError(BroadlinkException):
    pass


class FakeRM:
    """An RM on the LAN: hands out a code after `presses_after` checks, records what it sends."""

    presses_after = 1
    sent = []
    online = True

    def __init__(self):
        self.checks = 0

    def auth(self):
        if not self.online:
            raise BroadlinkException("timed out")

    def enter_learning(self):
        pass

    def check_data(self):
        self.checks += 1
        if self.presses_after is None or self.checks < self.presses_after:
            raise ReadError("no data")
        return b"\x26\x00\x01"

    def send_data(self, code):
        self.sent.append(code)


class BroadlinkTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        FakeRM.presses_after, FakeRM.sent, FakeRM.online = 1, [], True
        lib = types.SimpleNamespace(hello=lambda host, timeout: FakeRM())
        exceptions = types.SimpleNamespace(BroadlinkException=BroadlinkException, ReadError=ReadError, StorageError=StorageError)
        for p in (
            patch.dict(sys.modules, {"broadlink": lib, "broadlink.exceptions": exceptions}),
            patch.object(rm_cli, "CONFIG", os.path.join(self.dir.name, "broadlink.json")),
            patch.object(rm_cli.time, "sleep", lambda s: None),
        ):
            p.start()
            self.addCleanup(p.stop)
        rm_cli.add("192.0.2.7")

    def test_learn_saves_the_button(self):
        FakeRM.presses_after = 3
        device = rm_cli.learn(rm_cli.load(), "Aircon", "on")
        rm_cli.learn(rm_cli.load(), "aircon", "off")
        self.assertEqual(rm_cli.load()["devices"], [{"name": "Aircon", "type": "plug", "on": False, "codes": {"on": "260001", "off": "260001"}}])
        self.assertEqual(device["name"], "Aircon")
        self.assertEqual(os.stat(rm_cli.CONFIG).st_mode & 0o777, 0o600)

    def test_learn_times_out_when_nothing_pressed(self):
        FakeRM.presses_after = None
        with self.assertRaisesRegex(rm_cli.BroadlinkError, "no button pressed within 0 s"):
            rm_cli.learn(rm_cli.load(), "Fan", "power", wait=0)

    def test_on_off_codes_and_remembered_state(self):
        rm_cli.learn(rm_cli.load(), "Aircon", "on")
        cfg = rm_cli.load()
        [aircon] = rm_cli.devices(cfg)
        rm_cli.set_on(cfg, aircon, True)
        self.assertEqual(FakeRM.sent, [b"\x26\x00\x01"])
        self.assertTrue(rm_cli.devices(rm_cli.load())[0]["on"])
        with self.assertRaisesRegex(rm_cli.BroadlinkError, "no off button learned"):
            rm_cli.set_on(rm_cli.load(), aircon, False)

    def test_power_toggle_only_when_state_differs(self):
        rm_cli.learn(rm_cli.load(), "Fan", "power", kind="plug")
        fan = rm_cli.devices(rm_cli.load())[0]
        rm_cli.set_on(rm_cli.load(), fan, False)  # already off: pressing power would turn it on
        self.assertEqual(FakeRM.sent, [])
        rm_cli.set_on(rm_cli.load(), fan, True)
        rm_cli.set_on(rm_cli.load(), fan, False)
        self.assertEqual(len(FakeRM.sent), 2)

    def test_offline_rm(self):
        FakeRM.online = False
        with self.assertRaisesRegex(rm_cli.BroadlinkError, "the RM at 192.0.2.7 did not answer"):
            rm_cli.add("192.0.2.7")

    def test_not_set_up(self):
        os.remove(rm_cli.CONFIG)
        with self.assertRaisesRegex(rm_cli.BroadlinkError, "broadlink add"):
            rm_cli.load()


if __name__ == "__main__":
    unittest.main()
