import hashlib
import importlib.util
import json
import os
import socket
import struct
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("xiaomi", Path(__file__).parents[1] / "scripts" / "xiaomi.py")
xiaomi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(xiaomi)

TOKEN = "00112233445566778899aabbccddeeff"


class FakeDevice(threading.Thread):
    """A miio device on localhost: answers hello, checks the checksum, keeps a power state."""

    def __init__(self, protocol):
        super().__init__(daemon=True)
        self.protocol, self.power, self.calls = protocol, False, []
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", 0))
        self.port = self.sock.getsockname()[1]

    def handle(self, method, params):
        self.calls.append(method)
        if self.protocol == "miot" and method == "get_properties":
            return [{"did": "power", "siid": 2, "piid": 1, "code": 0, "value": self.power}]
        if self.protocol == "miot" and method == "set_properties":
            self.power = params[0]["value"]
            return [{"did": "power", "siid": 2, "piid": 1, "code": 0}]
        if self.protocol == "miio" and method == "get_prop":
            return ["on" if self.power else "off"]
        if self.protocol == "miio" and method == "set_power":
            self.power = params[0] == "on"
            return ["ok"]
        return None

    def run(self):
        token = bytes.fromhex(TOKEN)
        while True:
            try:
                data, peer = self.sock.recvfrom(4096)
            except OSError:
                return
            if data == xiaomi.HELLO:
                self.sock.sendto(struct.pack(">HHIII", 0x2131, 32, 0, 0x1234, 500) + b"\x00" * 16, peer)
                continue
            if data[16:32] != hashlib.md5(data[:16] + token + data[32:]).digest():
                continue  # another token: a real device stays silent too
            request = json.loads(xiaomi.decrypt(token, data[32:]))
            result = self.handle(request["method"], request["params"])
            answer = {"id": request["id"], "result": result} if result is not None else {"id": request["id"], "error": {"code": -9999, "message": "user ack timeout"}}
            self.sock.sendto(xiaomi.packet(token, 0x1234, 501, json.dumps(answer).encode() + b"\x00"), peer)


class XiaomiTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        for p in (patch.object(xiaomi, "CONFIG", os.path.join(self.dir.name, "xiaomi.json")), patch.object(xiaomi, "TIMEOUT", 0.5)):
            p.start()
            self.addCleanup(p.stop)

    def device(self, protocol):
        fake = FakeDevice(protocol)
        fake.start()
        self.addCleanup(fake.sock.close)
        port = patch.object(xiaomi, "PORT", fake.port)
        port.start()
        self.addCleanup(port.stop)
        return fake

    def test_miot_add_list_switch(self):
        fake = self.device("miot")
        self.assertEqual(xiaomi.add("Desk Lamp", "127.0.0.1", TOKEN.upper(), "light")["protocol"], "miot")
        self.assertEqual(os.stat(xiaomi.CONFIG).st_mode & 0o777, 0o600)
        cfg = xiaomi.load()
        [lamp] = xiaomi.devices(cfg)
        self.assertEqual((lamp["name"], lamp["type"], lamp["on"]), ("Desk Lamp", "light", False))
        xiaomi.set_on(cfg, lamp, True)
        self.assertTrue(fake.power)
        self.assertTrue(xiaomi.devices(cfg)[0]["on"])

    def test_legacy_miio_is_detected(self):
        fake = self.device("miio")
        self.assertEqual(xiaomi.add("Purifier", "127.0.0.1", TOKEN)["protocol"], "miio")
        cfg = xiaomi.load()
        xiaomi.set_on(cfg, xiaomi.devices(cfg)[0], True)
        self.assertTrue(fake.power)
        self.assertIn("set_power", fake.calls)

    def test_wrong_token(self):
        self.device("miot")
        with self.assertRaisesRegex(xiaomi.XiaomiError, "no answer from 127.0.0.1"):
            xiaomi.add("Lamp", "127.0.0.1", "ff" * 16)
        self.assertFalse(os.path.exists(xiaomi.CONFIG))

    def test_bad_token_format(self):
        with self.assertRaisesRegex(xiaomi.XiaomiError, "32 hex digits"):
            xiaomi.add("Lamp", "127.0.0.1", "not-a-token")

    def test_offline_device_reads_off(self):
        fake = self.device("miot")
        xiaomi.add("Lamp", "127.0.0.1", TOKEN)
        fake.sock.close()
        self.assertFalse(xiaomi.devices(xiaomi.load())[0]["on"])

    def test_not_set_up(self):
        with self.assertRaisesRegex(xiaomi.XiaomiError, "xiaomi add"):
            xiaomi.load()


if __name__ == "__main__":
    unittest.main()
