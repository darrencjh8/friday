import shlex
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


HERMES_DOCKERFILE = Path(__file__).parents[1] / "hermes/Dockerfile"


class HermesCompileallTests(unittest.TestCase):
    def test_compileall_skips_cached_python2_sources(self):
        dockerfile = HERMES_DOCKERFILE.read_text(encoding="utf-8")
        command = next(
            line.removeprefix("RUN ").strip()
            for line in dockerfile.splitlines()
            if "python -m compileall" in line
        )
        args = shlex.split(command)
        args[0] = sys.executable

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "opt" / "hermes"
            cache = source / "uv-cache" / "sdists-v9" / "python-olm"
            cache.mkdir(parents=True)
            (cache / "legacy.py").write_text("def worker((first, last)):\n    pass\n", encoding="utf-8")
            runtime = source / "gateway.py"
            runtime.write_text("ready = True\n", encoding="utf-8")
            args[-1] = str(source)

            result = subprocess.run(args, capture_output=True, text=True)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(list(runtime.parent.rglob("gateway.*.pyc")))
            self.assertFalse(list(cache.rglob("*.pyc")))


if __name__ == "__main__":
    unittest.main()
