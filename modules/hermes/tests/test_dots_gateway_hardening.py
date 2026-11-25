"""Dots gateway hardening for publishing it beyond the tailnet (Tailscale Funnel).

Runs inside the Hermes image (the adapter imports gateway internals):
    python3 -m unittest /path/to/test_dots_gateway_hardening.py
"""

import asyncio
import logging
import sys
import unittest
from types import SimpleNamespace

sys.path.append("/opt/hermes")
import aiohttp  # noqa: E402
from aiohttp import web  # noqa: E402
from plugins.platforms.dots.adapter import DotsAdapter, _GatewayRunner  # noqa: E402

LOGGER = "plugins.platforms.dots.adapter"

TOKEN = "t" * 43


def gateway():
    adapter = object.__new__(DotsAdapter)
    adapter._token = TOKEN
    adapter._agent_id = "b7dd404ef0fcd08f"
    adapter._web_origins = set()
    adapter._update_repo = "owner/repo"
    adapter._web_tokens = SimpleNamespace(check=lambda _token: None)
    adapter.platform = SimpleNamespace(value="dots")
    return adapter


def serve(path, headers=None):
    """GET ``path`` from the gateway as connect() serves it (its runner, on a local port).
    Returns (status, Server header, body text, the adapter's log records)."""
    async def run():
        runner = _GatewayRunner(gateway()._app(), access_log=None)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        try:
            async with aiohttp.ClientSession() as client:
                async with client.get(f"http://127.0.0.1:{port}{path}", headers=headers or {}) as response:
                    return response.status, response.headers.get("Server"), await response.text()
        finally:
            await runner.cleanup()

    with unittest.TestCase().assertLogs(LOGGER, "WARNING") as logs:
        result = asyncio.run(run())
        # assertLogs needs at least one record; a quiet request leaves only this one.
        logging.getLogger(LOGGER).warning("end")
    return (*result, [r for r in logs.records if r.getMessage() != "end"])


def call(path, headers=None):
    """Status, JSON body and refusal log lines of a request the routes answer."""
    status, _, text, records = serve(path, headers)
    return status, __import__("json").loads(text), [r.getMessage() for r in records if "Refused" in r.getMessage()]


class Health(unittest.TestCase):
    def test_anyone_learns_only_that_it_is_up(self):
        status, body, refused = call("/dots/health")
        self.assertEqual((200, {"ok": True}), (status, body))
        self.assertEqual([], refused)

    def test_a_token_holder_also_learns_which_profile_answers(self):
        _, body, _ = call("/dots/health", {"Authorization": f"Bearer {TOKEN}"})
        self.assertEqual({"ok": True, "agent_id": "b7dd404ef0fcd08f"}, body)


class Refusals(unittest.TestCase):
    def test_a_wrong_token_is_refused_and_logged_with_the_address_tailscale_saw(self):
        # A client can send its own X-Forwarded-For; Tailscale appends the real address last.
        status, _, refused = call("/dots/releases/latest?repo=owner/repo",
                                  {"Authorization": "Bearer guess", "X-Forwarded-For": "1.2.3.4, 203.0.113.9"})
        self.assertEqual(401, status)
        self.assertEqual(1, len(refused))
        self.assertIn("GET /dots/releases/latest from 203.0.113.9 (401)", refused[0])
        self.assertNotIn("guess", refused[0])


class NothingAboutTheServer(unittest.TestCase):
    def test_a_crashing_handler_keeps_its_traceback_but_not_in_the_reply(self):
        adapter = gateway()
        adapter._web_tokens = None  # check() now raises inside the handler
        records = []
        status, server, text = asyncio.run(self.fetch(adapter, "/dots/ws", {"Sec-WebSocket-Protocol": "dots.token.x"}, records))
        self.assertEqual((500, "dots", "500: Internal Server Error"), (status, server, text))
        self.assertTrue([r for r in records if r.exc_info], "the crash is logged with its traceback")

    @staticmethod
    async def fetch(adapter, path, headers, records):
        handler = logging.Handler()
        handler.emit = records.append
        logging.getLogger(LOGGER).addHandler(handler)
        runner = _GatewayRunner(adapter._app(), access_log=None)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        try:
            async with aiohttp.ClientSession() as client:
                url = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}{path}"
                async with client.get(url, headers=headers) as response:
                    return response.status, response.headers.get("Server"), await response.text()
        finally:
            await runner.cleanup()
            logging.getLogger(LOGGER).removeHandler(handler)

    def test_no_reply_names_the_server_software(self):
        for path in ("/dots/health", "/dots/ws", "/nowhere"):
            self.assertEqual("dots", serve(path)[1], path)

    def test_a_broken_websocket_handshake_does_not_echo_the_request(self):
        # A web token without the upgrade headers (Funnel over HTTP/2 drops them) fails in ws.prepare.
        status, server, text, _ = serve("/dots/ws", {"Sec-WebSocket-Protocol": "dots.v1, dots.token.guess"})
        self.assertEqual((400, "dots", "400: Bad Request"), (status, server, text))

    def test_an_oversized_header_is_one_log_line_and_a_bare_reply(self):
        status, server, text, records = serve("/dots/health", {"X-Big": "a" * 20000})
        self.assertEqual((400, "dots", "400: Bad Request"), (status, server, text))
        self.assertNotIn("aaaa", text)
        rejected = [r for r in records if "unparsable" in r.getMessage()]
        self.assertEqual(1, len(rejected))
        self.assertIsNone(rejected[0].exc_info, "no traceback")


if __name__ == "__main__":
    unittest.main()
