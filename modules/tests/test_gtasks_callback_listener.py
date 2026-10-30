"""The OAuth callback listener must be reachable through Docker's port publish."""

import importlib.util
import socket
import threading
import time
import unittest
import urllib.request
from pathlib import Path

GTASKS = Path(__file__).parents[1] / "hermes" / "scripts" / "gtasks.py"


def load_gtasks():
    spec = importlib.util.spec_from_file_location("gtasks_module", GTASKS)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class CallbackListenerTest(unittest.TestCase):
    def test_binds_all_container_interfaces(self):
        # Docker forwards a published port to the container interface, not its
        # loopback, so a 127.0.0.1 bind would never see the browser's callback.
        self.assertEqual(load_gtasks().CALLBACK_HOST, "0.0.0.0")

    def test_listener_returns_the_code_for_a_matching_state(self):
        gtasks = load_gtasks()
        port, result = free_port(), {}
        thread = threading.Thread(target=lambda: result.update(
            code=gtasks.wait_for_code(port=port, expected_state="s1", timeout=10)))
        thread.start()
        for _ in range(50):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/callback?code=abc&state=s1", timeout=2):
                    break
            except OSError:
                time.sleep(0.1)
        thread.join(10)
        self.assertEqual(result.get("code"), "abc")


if __name__ == "__main__":
    unittest.main()
