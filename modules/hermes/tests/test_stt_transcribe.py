"""stt-transcribe.sh with stubbed ffmpeg and curl: Parakeet first, Whisper as backup."""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "stt-transcribe.sh"

# Records each call as "<url> <uploaded file>" and answers per PARAKEET_MODE / WHISPER_MODE.
CURL = r"""#!/bin/sh
out= data= url=
while [ $# -gt 0 ]; do
    case $1 in
        -o) out=$2; shift ;;
        --data-binary) data=${2#@}; shift ;;
        --connect-timeout|--max-time|-H) shift ;;
        -*) ;;
        *) url=$1 ;;
    esac
    shift
done
echo "$url $data" >> "$STUB_LOG"
case $url in
    http://whisper:8000/*) mode=$WHISPER_MODE ;;
    *) mode=$PARAKEET_MODE ;;
esac
case $mode in
    ok-parakeet) printf '{"text": "hello from parakeet"}' > "$out" ;;
    empty) printf '{"text": ""}' > "$out" ;;
    badjson) printf '<html>oops</html>' > "$out" ;;
    notext) printf '{"error": "no"}' > "$out" ;;
    ok-whisper) printf 'hello from whisper' > "$out" ;;
    500) printf 'server error' > "$out"; echo "curl: (22) 500" >&2; exit 22 ;;
    down) echo "curl: (6) Could not resolve host" >&2; exit 6 ;;
esac
"""

# Writes the converted file and records the arguments it was given.
FFMPEG = r"""#!/bin/sh
echo "ffmpeg $*" >> "$STUB_LOG"
for last; do :; done
[ "$FFMPEG_MODE" = fail ] && exit 1
printf 'RIFF' > "$last"
"""

# Resolves every host unless GETENT_MODE=fail; records the lookup.
GETENT = r"""#!/bin/sh
echo "getent $*" >> "$STUB_LOG"
[ "$GETENT_MODE" = fail ] && exit 2
echo "192.0.2.1 $2"
"""


class TestSttTranscribe(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        bin_dir = self.dir / "bin"
        bin_dir.mkdir()
        for name, body in (("curl", CURL), ("ffmpeg", FFMPEG), ("getent", GETENT)):
            (bin_dir / name).write_text(body)
            (bin_dir / name).chmod(0o755)
        self.input = self.dir / "voice.ogg"
        self.input.write_bytes(b"OggS")
        self.output = self.dir / "transcript.txt"
        self.log = self.dir / "calls.log"
        self.env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "STUB_LOG": str(self.log),
                    "PARAKEET_URL": "http://parakeet.test:8765", "FFMPEG_MODE": "ok", "GETENT_MODE": "ok"}

    def run_stt(self, parakeet, whisper, **env):
        result = subprocess.run(["bash", str(SCRIPT), str(self.input), str(self.output)], capture_output=True,
                                text=True, env={**self.env, "PARAKEET_MODE": parakeet, "WHISPER_MODE": whisper, **env})
        calls = self.log.read_text().splitlines() if self.log.exists() else []
        return result, calls

    def transcript(self):
        return self.output.read_text() if self.output.exists() else ""

    def test_parakeet_answers(self):
        result, calls = self.run_stt("ok-parakeet", "ok-whisper")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("hello from parakeet", self.transcript())
        self.assertIn("served by parakeet", result.stderr)
        self.assertEqual("getent hosts parakeet.test", calls[0])
        self.assertIn("-ar 16000 -ac 1 -f wav", calls[1])
        self.assertTrue(calls[2].startswith("http://parakeet.test:8765/transcribe "))
        self.assertTrue(calls[2].endswith("audio.wav"))
        self.assertEqual(3, len(calls))  # Whisper never called

    def test_default_url_is_docker_desktop_host(self):
        env = dict(self.env)
        del env["PARAKEET_URL"]
        self.env = env
        _, calls = self.run_stt("ok-parakeet", "ok-whisper")
        self.assertEqual("getent hosts host.docker.internal", calls[0])
        self.assertTrue(calls[2].startswith("http://host.docker.internal:8765/transcribe "))

    def test_parakeet_down_falls_back_to_whisper_with_the_original_file(self):
        result, calls = self.run_stt("down", "ok-whisper")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("hello from whisper", self.transcript())
        self.assertEqual(f"http://whisper:8000/transcribe {self.input}", calls[-1])
        self.assertIn("served by whisper", result.stderr)

    def test_unresolvable_parakeet_host_goes_straight_to_whisper(self):
        # The server: no conversion, no connect attempt, just Whisper with the original file.
        result, calls = self.run_stt("ok-parakeet", "ok-whisper", GETENT_MODE="fail")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("hello from whisper", self.transcript())
        self.assertEqual(["getent hosts parakeet.test", f"http://whisper:8000/transcribe {self.input}"], calls)

    def test_parakeet_http_error_falls_back(self):
        result, _ = self.run_stt("500", "ok-whisper")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("hello from whisper", self.transcript())

    def test_parakeet_bad_reply_falls_back(self):
        for mode in ("badjson", "notext"):
            with self.subTest(mode=mode):
                result, _ = self.run_stt(mode, "ok-whisper")
                self.assertEqual(0, result.returncode, result.stderr)
                self.assertEqual("hello from whisper", self.transcript())

    def test_ffmpeg_failure_falls_back(self):
        result, calls = self.run_stt("ok-parakeet", "ok-whisper", FFMPEG_MODE="fail")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("hello from whisper", self.transcript())
        self.assertEqual([f"http://whisper:8000/transcribe {self.input}"], [c for c in calls if "/transcribe" in c])

    def test_empty_parakeet_transcript_is_kept(self):
        # Parakeet's voice check found no speech; Whisper would only say the same, slower.
        result, calls = self.run_stt("empty", "ok-whisper")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("", self.transcript())
        self.assertFalse(any("whisper:8000" in call for call in calls))

    def test_both_down_fails(self):
        for whisper in ("down", "500"):
            with self.subTest(whisper=whisper):
                result, _ = self.run_stt("down", whisper)
                self.assertNotEqual(0, result.returncode)
                self.assertNotIn("served by", result.stderr)


if __name__ == "__main__":
    unittest.main()
