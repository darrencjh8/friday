#!/usr/bin/env python3
"""Read-only Gmail and Calendar through Darren's Apps Script bridge (stdlib only).

The bridge (apps-script/friday-bridge) runs in his Google account with its
scopes fixed to gmail.readonly and calendar.readonly, so Google refuses any
change to mail or calendar. Friday holds no Google token, only the bridge URL
and its shared key (FRIDAY_BRIDGE_URL, FRIDAY_BRIDGE_KEY), and the bridge has
no command that writes. This client only issues GETs.

Commands: status, mail, read <id>, events.
"""
import argparse
import base64
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request


class BridgeError(Exception):
    pass


def configured():
    return bool(os.environ.get("FRIDAY_BRIDGE_URL") and os.environ.get("FRIDAY_BRIDGE_KEY"))


def call(cmd, **params):
    url = os.environ.get("FRIDAY_BRIDGE_URL", "")
    key = os.environ.get("FRIDAY_BRIDGE_KEY", "")
    if not url or not key:
        raise BridgeError("FRIDAY_BRIDGE_URL/FRIDAY_BRIDGE_KEY are not set")
    query = urllib.parse.urlencode({"key": key, "cmd": cmd, **params})
    try:
        with urllib.request.urlopen(urllib.request.Request(f"{url}?{query}", method="GET"), timeout=60) as resp:
            body = json.load(resp)
    except Exception as exc:  # never echo the URL: it carries the key
        raise BridgeError(f"bridge {cmd} request failed: {type(exc).__name__}")
    if not isinstance(body, dict) or body.get("error"):
        raise BridgeError(f"bridge {cmd} refused: {body.get('error') if isinstance(body, dict) else 'bad reply'}")
    return body


def list_messages(after_ms=0, limit=20):
    """Oldest-first inbox metadata newer than after_ms (promotions, social, forums skipped)."""
    messages = call("mail", after=int(after_ms), limit=int(limit))["messages"]
    for m in messages:
        m["snippet"] = html.unescape(m.get("snippet", ""))
    return messages


def list_events(days=14):
    return call("events", days=int(days))["events"]


def _decode(data):
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", "replace")


def _header(payload, name):
    for item in payload.get("headers", []):
        if item.get("name", "").lower() == name.lower():
            return item.get("value", "")
    return ""


def message_text(payload):
    """Plain text of a message: text/plain parts, else tag-stripped text/html."""
    plain, rich = [], []

    def walk(part):
        mime = part.get("mimeType", "")
        data = part.get("body", {}).get("data")
        if data and mime == "text/plain":
            plain.append(_decode(data))
        elif data and mime == "text/html":
            rich.append(re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", _decode(data)))))
        for child in part.get("parts", []):
            walk(child)

    walk(payload)
    return "\n".join(plain or rich).strip()


def read_message(message_id, max_chars=4000):
    payload = call("read", id=message_id)["message"].get("payload", {})
    return "From: %s\nSubject: %s\nDate: %s\n\n%s" % (
        _header(payload, "From"), _header(payload, "Subject"), _header(payload, "Date"),
        message_text(payload)[:max_chars])


def main(argv=None):
    parser = argparse.ArgumentParser(prog="google_bridge", description="Read-only Gmail and Calendar.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    mail = sub.add_parser("mail")
    mail.add_argument("--after-ms", type=int, default=0)
    mail.add_argument("--max", type=int, default=20)
    read = sub.add_parser("read")
    read.add_argument("id")
    read.add_argument("--max-chars", type=int, default=4000)
    events = sub.add_parser("events")
    events.add_argument("--days", type=int, default=14)
    args = parser.parse_args(argv)
    try:
        if args.command == "status":
            print("configured" if configured() else "not configured (FRIDAY_BRIDGE_URL/FRIDAY_BRIDGE_KEY unset)")
        elif args.command == "mail":
            print(json.dumps(list_messages(args.after_ms, args.max), indent=2, ensure_ascii=False))
        elif args.command == "read":
            print(read_message(args.id, args.max_chars))
        elif args.command == "events":
            print(json.dumps(list_events(args.days), indent=2, ensure_ascii=False))
    except BridgeError as exc:
        sys.stderr.write(f"{exc}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
