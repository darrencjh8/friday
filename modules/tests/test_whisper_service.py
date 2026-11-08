import http.client
import importlib.util
from pathlib import Path
import threading
import unittest
from http.server import ThreadingHTTPServer

import yaml

MODULES = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("whisper_server", MODULES / "whisper" / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class Segment:
    def __init__(self, text):
        self.text = text


class FakeModel:
    def transcribe(self, path, vad_filter):
        if Path(path).read_bytes() == b"bad":
            raise ValueError("not audio")
        return [Segment(" hello "), Segment("there ")], None


class TranscriberTests(unittest.TestCase):
    def test_joins_segments_and_loads_once(self):
        loads = []
        transcriber = server.Transcriber(lambda: loads.append(1) or FakeModel(), 600)
        self.assertEqual("hello there", transcriber.transcribe(__file__))
        transcriber.transcribe(__file__)
        self.assertEqual(1, len(loads))

    def test_frees_the_model_only_when_idle(self):
        busy = server.Transcriber(FakeModel, 600)
        busy.transcribe(__file__)
        busy.unload_if_idle()
        self.assertTrue(busy.loaded)

        idle = server.Transcriber(FakeModel, 0)
        idle.transcribe(__file__)
        idle.unload_if_idle()
        self.assertFalse(idle.loaded)


class EndpointTests(unittest.TestCase):
    def setUp(self):
        handler = server.make_handler(server.Transcriber(FakeModel, 600))
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)

    def request(self, method, path, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1])
        self.addCleanup(connection.close)
        connection.request(method, path, body)
        response = connection.getresponse()
        return response.status, response.read().decode()

    def test_health(self):
        self.assertEqual((200, "ok"), self.request("GET", "/health"))

    def test_returns_transcript_text(self):
        self.assertEqual((200, "hello there"), self.request("POST", "/transcribe", b"audio"))

    def test_undecodable_audio_is_an_error_not_a_transcript(self):
        status, _ = self.request("POST", "/transcribe", b"bad")
        self.assertEqual(422, status)

    def test_rejects_empty_and_oversized_bodies(self):
        self.assertEqual(413, self.request("POST", "/transcribe", b"")[0])
        connection = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1])
        self.addCleanup(connection.close)
        connection.putrequest("POST", "/transcribe")
        connection.putheader("Content-Length", str(server.MAX_BYTES + 1))
        connection.endheaders()
        self.assertEqual(413, connection.getresponse().status)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.compose = yaml.safe_load((MODULES / "docker-compose.yml").read_text(encoding="utf-8"))
        self.config = yaml.safe_load((MODULES / "hermes" / "config.yaml").read_text(encoding="utf-8"))

    def test_service_is_capped_and_not_published(self):
        whisper = self.compose["services"]["whisper"]
        self.assertEqual("1500m", whisper["mem_limit"])
        self.assertNotIn("ports", whisper)

    def test_hermes_keeps_transcription_on_the_server(self):
        # A command provider is relayed; the built-in openai provider hands its
        # base_url to desktop clients, which can't resolve a compose service name.
        stt = self.config["stt"]
        provider = stt["providers"][stt["provider"]]
        self.assertEqual("command", provider["type"])
        self.assertIn("http://whisper:8000/transcribe", provider["command"])


if __name__ == "__main__":
    unittest.main()
