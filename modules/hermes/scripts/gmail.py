#!/usr/bin/env python3
"""Read-only Gmail CLI (stdlib only): list, read.

Uses the shared token from `google login`, whose Gmail scope is only
gmail.readonly, so Google refuses any change to the mailbox whoever holds it.
This code also only ever issues GET requests.
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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gtasks  # noqa: E402  (shared Google token; same directory)

API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"
DEFAULT_QUERY = "in:inbox -category:promotions -category:social -category:forums"
EXIT_AUTH_EXPIRED = 3
AuthExpired = gtasks.AuthExpired
MissingScope = gtasks.MissingScope


def enabled():
    return gtasks.GMAIL_SCOPE in gtasks.granted_scopes()


def get(url, params=None, scope=gtasks.GMAIL_SCOPE):
    """GET only: these CLIs have no write path."""
    token = gtasks.token_for(scope)
    url += "?" + urllib.parse.urlencode(params, doseq=True) if params else ""
    req = urllib.request.Request(url, method="GET")
    req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)
    except Exception as exc:
        if getattr(exc, "code", None) == 401:
            raise AuthExpired()
        raw = ""
        try:
            raw = exc.read().decode()[:200]
        except Exception:
            pass
        raise RuntimeError("Google API error: %s" % (raw or exc))


def _header(payload, name):
    for item in payload.get("headers", []):
        if item.get("name", "").lower() == name.lower():
            return item.get("value", "")
    return ""


def list_messages(query=DEFAULT_QUERY, after_ms=0, limit=20):
    """Oldest-first metadata for messages matching query newer than after_ms."""
    q = query + (" after:%d" % (after_ms // 1000) if after_ms else "")
    ids = [m["id"] for m in get(API_BASE + "/messages", {"q": q, "maxResults": 100}).get("messages", [])]
    out = []
    for mid in ids:
        msg = get(API_BASE + "/messages/" + mid, {"format": "metadata", "metadataHeaders": ["From", "Subject", "Date"]})
        received = int(msg.get("internalDate", 0))
        if received <= after_ms:
            continue
        payload = msg.get("payload", {})
        out.append({"id": mid, "thread_id": msg.get("threadId", ""), "received_ms": received,
                    "from": _header(payload, "From"), "subject": _header(payload, "Subject"),
                    "date": _header(payload, "Date"), "snippet": html.unescape(msg.get("snippet", "")),
                    "labels": msg.get("labelIds", [])})
    out.sort(key=lambda m: m["received_ms"])
    return out[:limit]


def _decode(data):
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", "replace")


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


def main(argv=None):
    parser = argparse.ArgumentParser(prog="gmail", description="Read-only Gmail.")
    sub = parser.add_subparsers(dest="command", required=True)
    lst = sub.add_parser("list")
    lst.add_argument("--query", default=DEFAULT_QUERY)
    lst.add_argument("--max", type=int, default=20)
    read = sub.add_parser("read")
    read.add_argument("id")
    read.add_argument("--max-chars", type=int, default=4000)
    args = parser.parse_args(argv)
    try:
        if args.command == "list":
            print(json.dumps(list_messages(args.query, limit=args.max), indent=2, ensure_ascii=False))
        elif args.command == "read":
            msg = get(API_BASE + "/messages/" + urllib.parse.quote(args.id, safe=""), {"format": "full"})
            payload = msg.get("payload", {})
            print("From: %s\nSubject: %s\nDate: %s\n\n%s" % (
                _header(payload, "From"), _header(payload, "Subject"), _header(payload, "Date"),
                message_text(payload)[:args.max_chars]))
    except AuthExpired:
        sys.stderr.write(gtasks.auth_expired_message() + "\n")
        return EXIT_AUTH_EXPIRED
    except MissingScope as exc:
        sys.stderr.write("%s\n" % exc)
        return EXIT_AUTH_EXPIRED
    except (RuntimeError, TimeoutError, ValueError) as exc:
        sys.stderr.write("%s\n" % exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
