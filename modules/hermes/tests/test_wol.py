import importlib.util
import json
import os
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("wol", Path(__file__).parents[1] / "scripts" / "wol.py")
wol = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wol)


class TestWol(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        patcher = patch.object(wol, "CONFIG", os.path.join(self.dir.name, "wol.json"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_set_saves_private_and_normalised(self):
        self.assertEqual(wol.save("10.0.0.7", "aa-bb-cc-dd-ee-ff"), ("10.0.0.7", "AABBCCDDEEFF"))
        self.assertEqual(os.stat(wol.CONFIG).st_mode & 0o777, 0o600)
        with open(wol.CONFIG) as f:
            self.assertEqual(json.load(f), {"ip": "10.0.0.7", "mac": "AABBCCDDEEFF"})

    def test_refuses_addresses_off_the_home_network(self):
        for ip in ("8.8.8.8", "127.0.0.1", "fe80::1", "pc"):
            with self.assertRaises(wol.WolError, msg=ip):
                wol.save(ip, "aa:bb:cc:dd:ee:ff")
        for mac in ("aa:bb:cc:dd:ee", "aa:bb-cc:dd:ee:ff", "zz:bb:cc:dd:ee:ff"):
            with self.assertRaises(wol.WolError, msg=mac):
                wol.save("10.0.0.7", mac)

    def test_not_set_yet(self):
        with self.assertRaisesRegex(wol.WolError, "wol set"):
            wol.load()

    def test_magic_packet_goes_to_the_pc_ip(self):
        wol.save("10.0.0.7", "aabbccddeeff")
        sent = []
        with patch.object(socket.socket, "sendto", lambda s, data, addr: sent.append((data, addr))):
            self.assertEqual(wol.main([]), 0)
        data, addr = sent[0]
        self.assertEqual(addr, ("10.0.0.7", 9))
        self.assertEqual(len(data), 102)
        self.assertEqual(data[:6], b"\xff" * 6)
        self.assertEqual(data[6:], bytes.fromhex("aabbccddeeff") * 16)


if __name__ == "__main__":
    unittest.main()
