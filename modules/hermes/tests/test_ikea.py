import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("ikea", Path(__file__).parents[1] / "scripts" / "ikea.py")
ikea = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ikea)

CFG = {"host": "10.0.0.5", "identity": "friday-1", "key": "k"}
GATEWAY = {
    "15001": [65537, 65538, 65539],
    "15001/65537": {"9001": "Speaker", "5750": 3, "3312": [{"5850": 0}]},
    "15001/65538": {"9001": "Desk lamp", "5750": 2, "3311": [{"5850": 1, "5851": 254}]},
    "15001/65539": {"9001": "Remote", "5750": 0},
}


def fake_gateway(calls):
    def run(command, **_):
        calls.append(command)
        path = command[-1].split(":5684/", 1)[1]
        if command[2] == "put":
            return subprocess.CompletedProcess(command, 0, "", "")
        return subprocess.CompletedProcess(command, 0, json.dumps(GATEWAY[path]), "")
    return run


class IkeaTest(unittest.TestCase):
    def test_list_keeps_lights_and_plugs_with_state(self):
        with patch.object(ikea.subprocess, "run", side_effect=fake_gateway([])):
            found = ikea.devices(CFG)
        self.assertEqual(found, [
            {"id": 65537, "name": "Speaker", "type": "plug", "on": False},
            {"id": 65538, "name": "Desk lamp", "type": "light", "on": True},
        ])

    def test_switch_puts_the_matching_control(self):
        calls = []
        with patch.object(ikea.subprocess, "run", side_effect=fake_gateway(calls)):
            ikea.switch(CFG, "speak", True)
            ikea.switch(CFG, "DESK LAMP", False)
        puts = [c for c in calls if c[2] == "put"]
        self.assertEqual(json.loads(puts[0][puts[0].index("-e") + 1]), {"3312": [{"5850": 1}]})
        self.assertTrue(puts[0][-1].endswith("/15001/65537"))
        self.assertEqual(json.loads(puts[1][puts[1].index("-e") + 1]), {"3311": [{"5850": 0}]})

    def test_unknown_name_lists_choices(self):
        with patch.object(ikea.subprocess, "run", side_effect=fake_gateway([])):
            with self.assertRaisesRegex(ikea.IkeaError, "no devices match 'fan': Speaker, Desk lamp"):
                ikea.switch(CFG, "fan", True)

    def test_coap_error_on_stderr_fails_even_with_exit_zero(self):
        refused = subprocess.CompletedProcess([], 0, "", "4.01 Unauthorized\n")
        with patch.object(ikea.subprocess, "run", return_value=refused):
            with self.assertRaisesRegex(ikea.IkeaError, "4.01 Unauthorized"):
                ikea.coap("get", "h", "15001", "i", "k")

    def test_silent_get_is_no_answer(self):
        with patch.object(ikea.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "", "")):
            with self.assertRaisesRegex(ikea.IkeaError, "did not answer"):
                ikea.coap("get", "h", "15001", "i", "k")

    def test_pair_saves_key_not_code_with_private_mode(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(ikea, "CONFIG", os.path.join(tmp, "ikea.json")):
            reply = subprocess.CompletedProcess([], 0, '{"9091":"psk","9029":"1.0"}', "")
            with patch.object(ikea.subprocess, "run", return_value=reply) as run:
                ikea.pair("10.0.0.5", "CODE123")
            command = run.call_args.args[0]
            self.assertEqual(command[command.index("-u") + 1], "Client_identity")
            self.assertEqual(command[command.index("-k") + 1], "CODE123")
            saved = Path(ikea.CONFIG)
            self.assertEqual(oct(saved.stat().st_mode & 0o777), "0o600")
            data = json.loads(saved.read_text())
            self.assertEqual((data["host"], data["key"]), ("10.0.0.5", "psk"))
            self.assertNotIn("CODE123", saved.read_text())


if __name__ == "__main__":
    unittest.main()
