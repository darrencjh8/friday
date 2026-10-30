#!/usr/bin/env python3
"""Read-only Gmail CLI (stdlib only).

Read-only is enforced by Google, not by this code: login requests only the
gmail.readonly scope, so the token cannot send, delete, label, archive, or mark
mail read, whoever holds it. The code also only ever issues GET requests.

Commands: login [--manual], status, logout (deletes the local token only;
revoke at Google account > Security > Third-party access), list, read.

OAuth reuses the gtasks Google project (GTASKS_CLIENT_ID/SECRET, which the
terminal already passes through) and its callback listener on 127.0.0.1:8299.
The client id and secret are saved with the token so refresh also works from a
cron pre-check script that does not have them in its environment.
"""
import argparse
import base64
import datetime as _dt
import html
import json
import os
import re
import secrets
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gtasks  # noqa: E402  (shared OAuth helpers; same directory)

SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"
CALLBACK_PATHS = ("/callback", "/gmail/callback")
DEFAULT_QUERY = "in:inbox -category:promotions -category:social -category:forums"
EXIT_AUTH_EXPIRED = 3


class AuthExpired(Exception):
    pass


def _token_path():
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(base, "gmail-readonly", "token.json")


def _save_token(data):
    path = _token_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w") as fh:
        json.dump(data, fh)
    os.chmod(path + ".tmp", 0o600)
    os.replace(path + ".tmp", path)


def load_token():
    try:
        with open(_token_path()) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _now():
    return _dt.datetime.now(_dt.timezone.utc).timestamp()


def _valid_token():
    token = load_token()
    if not token or not token.get("refresh_token"):
        raise AuthExpired()
    if token.get("expiry", 0) - 60 > _now():
        return token
    out = gtasks._post_token({"grant_type": "refresh_token", "refresh_token": token["refresh_token"],
                              "client_id": token["client_id"], "client_secret": token["client_secret"]})
    if out.get("error") or not out.get("access_token"):
        if gtasks.is_auth_expired(out):
            raise AuthExpired()
        raise RuntimeError("token refresh failed")
    token["access_token"] = out["access_token"]
    token["expiry"] = _now() + out.get("expires_in", 3600)
    _save_token(token)
    return token


def get(path, params=None):
    """GET only: this CLI has no write path."""
    token = _valid_token()
    url = API_BASE + path + ("?" + urllib.parse.urlencode(params, doseq=True) if params else "")
    req = urllib.request.Request(url, method="GET")
    req.add_header("Authorization", "Bearer " + token["access_token"])
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)
    except Exception as exc:
        status = getattr(exc, "code", None)
        if status == 401:
            raise AuthExpired()
        raw = ""
        try:
            raw = exc.read().decode()[:200]
        except Exception:
            pass
        raise RuntimeError("Gmail API error: %s" % (raw or exc))


def _header(payload, name):
    for item in payload.get("headers", []):
        if item.get("name", "").lower() == name.lower():
            return item.get("value", "")
    return ""


def list_messages(query=DEFAULT_QUERY, after_ms=0, limit=20):
    """Oldest-first metadata for messages matching query newer than after_ms."""
    q = query + (" after:%d" % (after_ms // 1000) if after_ms else "")
    ids = [m["id"] for m in get("/messages", {"q": q, "maxResults": 100}).get("messages", [])]
    out = []
    for mid in ids:
        msg = get("/messages/" + mid, {"format": "metadata", "metadataHeaders": ["From", "Subject", "Date"]})
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


def cmd_login(args):
    cid, csec = gtasks._client_env()
    redirect_uri = args.redirect_uri or os.environ.get("GMAIL_REDIRECT_URI", gtasks.DEFAULT_REDIRECT_URI)
    state = secrets.token_urlsafe(32)
    verifier, challenge = gtasks.pkce_pair()
    print("Open this URL in your browser and allow read-only Gmail access:\n%s\n"
          % gtasks.build_auth_url(cid, redirect_uri, state, challenge, scope=SCOPE), flush=True)
    if args.manual:
        print("If the browser then cannot open the page, copy its full address and paste it below.", flush=True)
        try:
            code = gtasks.parse_pasted_callback(input("Redirect URL: "), state)
        except EOFError:
            raise SystemExit("Login cancelled.")
    else:
        print("Waiting for the callback (%ds) ..." % args.timeout, flush=True)
        code = gtasks.wait_for_code(port=args.port, expected_state=state, timeout=args.timeout, paths=CALLBACK_PATHS)
    out = gtasks._post_token({"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri,
                              "client_id": cid, "client_secret": csec, "code_verifier": verifier})
    if out.get("error") or not out.get("access_token") or not out.get("refresh_token"):
        raise SystemExit("Login failed at token exchange.")
    if set(out.get("scope", SCOPE).split()) != {SCOPE}:
        # Never keep a token that can do more than read.
        raise SystemExit("Login refused: Google granted scopes other than gmail.readonly.")
    _save_token({"access_token": out["access_token"], "refresh_token": out["refresh_token"],
                 "expiry": _now() + out.get("expires_in", 3600), "client_id": cid, "client_secret": csec})
    print("Login saved (read-only).")


def main(argv=None):
    parser = argparse.ArgumentParser(prog="gmail", description="Read-only Gmail.")
    sub = parser.add_subparsers(dest="command", required=True)
    login = sub.add_parser("login")
    login.add_argument("--redirect-uri", default="")
    login.add_argument("--port", type=int, default=gtasks.CALLBACK_PORT)
    login.add_argument("--timeout", type=int, default=gtasks.LOGIN_TIMEOUT)
    login.add_argument("--manual", action="store_true", help="paste the redirect URL instead of listening")
    sub.add_parser("status")
    sub.add_parser("logout")
    lst = sub.add_parser("list")
    lst.add_argument("--query", default=DEFAULT_QUERY)
    lst.add_argument("--max", type=int, default=20)
    read = sub.add_parser("read")
    read.add_argument("id")
    read.add_argument("--max-chars", type=int, default=4000)
    args = parser.parse_args(argv)
    try:
        if args.command == "login":
            cmd_login(args)
        elif args.command == "status":
            print("logged in (read-only)" if load_token() else "not logged in")
        elif args.command == "logout":
            if os.path.exists(_token_path()):
                os.remove(_token_path())
            print("Local token deleted. Revoke access at Google account > Security > Third-party access.")
        elif args.command == "list":
            print(json.dumps(list_messages(args.query, limit=args.max), indent=2, ensure_ascii=False))
        elif args.command == "read":
            msg = get("/messages/" + urllib.parse.quote(args.id, safe=""), {"format": "full"})
            payload = msg.get("payload", {})
            print("From: %s\nSubject: %s\nDate: %s\n\n%s" % (
                _header(payload, "From"), _header(payload, "Subject"), _header(payload, "Date"),
                message_text(payload)[:args.max_chars]))
    except AuthExpired:
        sys.stderr.write("Gmail login missing or expired. Run `gmail login` again.\n")
        return EXIT_AUTH_EXPIRED
    except (RuntimeError, TimeoutError, ValueError) as exc:
        sys.stderr.write("%s\n" % exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
