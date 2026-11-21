import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("home", Path(__file__).parents[1] / "scripts" / "home.py")
home = importlib.util.module_from_spec(spec)
spec.loader.exec_module(home)


class FakeSystem:
    """Stands in for a smart home system: a fixed device list, switches recorded."""

    name = "fake"

    class Error(Exception):
        pass

    def __init__(self):
        self.listed = 0
        self.switched = []
        self.found = [
            {"id": 1, "name": "Speaker L", "type": "plug", "on": False},
            {"id": 2, "name": "Speaker R", "type": "plug", "on": False},
            {"id": 3, "name": "Toilet Light", "type": "light", "on": True},
        ]

    def ready(self):
        return True

    def devices(self):
        self.listed += 1
        return [dict(d) for d in self.found]

    def set_on(self, device, on):
        if device["name"] == "Broken":
            raise self.Error("gateway did not answer")
        self.switched.append((device["id"], on))

    def error(self):
        return self.Error


class HomeTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.system = FakeSystem()
        patcher = patch.multiple(home, CACHE=os.path.join(self.dir.name, "devices.json"), SYSTEMS=(lambda: self.system,))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_list_tags_system_and_caches(self):
        found = home.fresh(home.systems())
        self.assertEqual({d["system"] for d in found}, {"fake"})
        self.assertEqual(home.cached(), found)
        self.assertEqual(os.stat(home.CACHE).st_mode & 0o777, 0o600)

    def test_switch_uses_cache_without_listing(self):
        home.fresh(home.systems())
        self.system.listed = 0
        self.assertEqual(home.switch(["speaker l", "Speaker R"], True), ["Speaker L", "Speaker R"])
        self.assertEqual(self.system.listed, 0)
        self.assertEqual(sorted(self.system.switched), [(1, True), (2, True)])
        self.assertTrue(all(d["on"] for d in home.cached() if d["name"].startswith("Speaker")))

    def test_unknown_name_lists_afresh_once(self):
        home.fresh(home.systems())
        self.system.found.append({"id": 4, "name": "Fan", "type": "plug", "on": False})
        self.system.listed = 0
        home.switch(["fan"], True)
        self.assertEqual(self.system.listed, 1)
        self.assertEqual(self.system.switched, [(4, True)])

    def test_ambiguous_and_missing_names_list_choices(self):
        with self.assertRaisesRegex(home.HomeError, "several devices match 'speaker': Speaker L, Speaker R"):
            home.switch(["speaker"], True)
        with self.assertRaisesRegex(home.HomeError, "no devices match 'oven'"):
            home.switch(["oven"], True)
        self.assertEqual(self.system.switched, [])

    def test_failed_device_reported_others_still_switch(self):
        self.system.found.append({"id": 5, "name": "Broken", "type": "plug", "on": False})
        with self.assertRaisesRegex(home.HomeError, "Broken: gateway did not answer"):
            home.switch(["Broken", "Speaker L"], True)
        self.assertEqual(self.system.switched, [(1, True)])

    def test_nothing_set_up(self):
        self.system.ready = lambda: False
        with self.assertRaisesRegex(home.HomeError, "no smart home system set up"):
            home.systems()

    def test_cached_list_skips_systems(self):
        home.save([{"name": "Lamp", "type": "light", "on": True, "system": "fake", "id": 9}])
        with patch("builtins.print") as out:
            self.assertEqual(home.main(["list", "--cached"]), 0)
        self.assertEqual(json.loads(out.call_args[0][0]), [{"name": "Lamp", "type": "light", "on": True, "system": "fake"}])
        self.assertEqual(self.system.listed, 0)

    def test_ikea_backend_loads_from_installed_script(self):
        self.assertTrue(hasattr(home._backend("ikea"), "set_on"))


class BackendTest(unittest.TestCase):
    def test_every_system_script_loads_and_is_skipped_until_set_up(self):
        with tempfile.TemporaryDirectory() as d, patch.dict(os.environ, IKEA_CONFIG=f"{d}/i.json", TUYA_CONFIG=f"{d}/t.json"):
            for make in home.SYSTEMS:
                system = make()
                self.assertFalse(system.ready(), system.name)
                self.assertTrue(issubclass(system.error(), Exception))


if __name__ == "__main__":
    unittest.main()
