"""Jobs that refresh the Google token at the same moment must not see an expired login."""

import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1] / "hermes" / "scripts"))


class TokenFileTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        patcher = mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": tmp.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.g = importlib.reload(importlib.import_module("gtasks"))

    def test_save_uses_a_temp_file_of_its_own(self):
        opened = []
        real_open = open

        def spy(path, *args, **kwargs):
            opened.append(str(path))
            return real_open(path, *args, **kwargs)

        with mock.patch("builtins.open", spy):
            self.g._save_token({"access_token": "a"})
        self.assertIn("%s.%d.tmp" % (self.g._token_path(), os.getpid()), opened)
        self.assertEqual(self.g._load_token(), {"access_token": "a"})

    def test_load_reads_again_after_a_half_written_file(self):
        self.g._save_token({"access_token": "a"})
        path = self.g._token_path()
        good = open(path).read()
        with open(path, "w") as fh:
            fh.write(good[:5])

        def finish_write(_seconds):
            with open(path, "w") as fh:
                fh.write(good)

        with mock.patch.object(self.g.time, "sleep", finish_write):
            self.assertEqual(self.g._load_token(), {"access_token": "a"})

    def test_missing_token_is_still_none(self):
        with mock.patch.object(self.g.time, "sleep"):
            self.assertIsNone(self.g._load_token())


if __name__ == "__main__":
    unittest.main()
