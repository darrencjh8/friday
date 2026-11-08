"""Speech-to-text for Hermes: POST audio bytes to /transcribe, get plain text back.

Runs apart from the gateway so a model that outgrows its memory limit costs one
transcript rather than the gateway. Only the compose network can reach it.
"""
import gc
import os
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = os.environ.get("WHISPER_MODEL", "small")
CPU_THREADS = int(os.environ.get("WHISPER_CPU_THREADS", "2"))
IDLE_SECONDS = int(os.environ.get("WHISPER_IDLE_SECONDS", "600"))
MAX_BYTES = 25 * 1024 * 1024


class Transcriber:
    """Loads the model on first use and frees it when idle: the host has 8 GB to share."""

    def __init__(self, load, idle_seconds):
        self._load = load
        self._idle_seconds = idle_seconds
        self._model = None
        self._used_at = 0.0
        self._lock = threading.Lock()

    def transcribe(self, path):
        with self._lock:
            if self._model is None:
                self._model = self._load()
            segments, _ = self._model.transcribe(path, vad_filter=True)
            text = " ".join(segment.text.strip() for segment in segments).strip()
            self._used_at = time.monotonic()
            return text

    def unload_if_idle(self):
        with self._lock:
            if self._model is not None and time.monotonic() - self._used_at >= self._idle_seconds:
                self._model = None
                gc.collect()

    @property
    def loaded(self):
        return self._model is not None


def load_model():
    from faster_whisper import WhisperModel

    return WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=CPU_THREADS)


def make_handler(transcriber):
    class Handler(BaseHTTPRequestHandler):
        def _reply(self, status, text=""):
            body = text.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self._reply(200, "ok") if self.path == "/health" else self._reply(404, "not found")

        def do_POST(self):
            if self.path != "/transcribe":
                return self._reply(404, "not found")
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                return self._reply(411, "length required")
            if not 0 < length <= MAX_BYTES:
                return self._reply(413, "audio must be 1 byte to 25 MB")
            with tempfile.NamedTemporaryFile() as audio:
                audio.write(self.rfile.read(length))
                audio.flush()
                try:
                    text = transcriber.transcribe(audio.name)
                except Exception as error:
                    return self._reply(422, f"could not transcribe: {error}")
            self._reply(200, text)

        def log_message(self, *args):
            pass  # Default logging would print every request; transcripts stay out of the logs either way.

    return Handler


def main():
    transcriber = Transcriber(load_model, IDLE_SECONDS)

    def fetch_model_once():
        # Fetched at boot so the first voice note doesn't wait for the download; a failure retries on first use.
        from faster_whisper import download_model

        try:
            download_model(MODEL)
        except Exception as error:
            print(f"model download failed, will retry on first use: {error}", flush=True)

    def unload_loop():
        while True:
            time.sleep(30)
            transcriber.unload_if_idle()

    threading.Thread(target=fetch_model_once, daemon=True).start()
    threading.Thread(target=unload_loop, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 8000), make_handler(transcriber)).serve_forever()


if __name__ == "__main__":
    main()
