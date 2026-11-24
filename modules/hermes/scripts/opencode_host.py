#!/usr/bin/env python3
"""Hand coding work to the `opencode serve` running on Hermes's host.

    opencode-host start <repo-or-dir> <task...>   new session, send the task
    opencode-host read <session-id>               latest reply, and whether it is done
    opencode-host send <session-id> <message...>  follow up in a session
    opencode-host list                            recent sessions

The server is the laptop's systemd user service (opencode-serve), reached from
this container at host.docker.internal. The API lives under /api and needs the
basic-auth password in OPENCODE_SERVER_PASSWORD.
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request

URL = os.environ.get("OPENCODE_SERVER_URL", "http://host.docker.internal:4096").rstrip("/")
# Repos are checked out here on the host; a bare name like `friday` means this folder.
WORKSPACE = "/home/darren/workspace"


def call(method, path, body=None):
    password = os.environ.get("OPENCODE_SERVER_PASSWORD")
    if not password:
        sys.exit("OPENCODE_SERVER_PASSWORD is not set")
    token = base64.b64encode(f"opencode:{password}".encode()).decode()
    request = urllib.request.Request(
        f"{URL}/api{path}", method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Basic {token}", "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.loads(response.read() or b"null")
    except urllib.error.HTTPError as error:
        sys.exit(f"opencode answered {error.code}: {error.read()[:300].decode(errors='replace')}")
    except urllib.error.URLError as error:
        sys.exit(f"opencode is unreachable at {URL}: {error.reason}")
    return payload.get("data", payload) if isinstance(payload, dict) else payload


def directory(target):
    return target if target.startswith("/") else f"{WORKSPACE}/{target}"


def latest(messages):
    """Return (reply text, done) from a session's messages, in any order."""
    messages = sorted(messages, key=lambda m: (m.get("time") or {}).get("created", 0))
    reply = ""
    for message in messages:
        if message.get("type") == "assistant":
            parts = message.get("content") or []
            reply = "".join(p.get("text", "") for p in parts if p.get("type") == "text") or reply
    done = bool(messages) and messages[-1].get("type") == "idle"
    return reply, done


def main(argv):
    if len(argv) >= 3 and argv[0] == "start":
        session = call("POST", "/session", {"title": " ".join(argv[2:])[:80], "location": {"directory": directory(argv[1])}})
        call("POST", f"/session/{session['id']}/prompt", {"text": " ".join(argv[2:])})
        print(f"started {session['id']} in {directory(argv[1])}; check it with: opencode-host read {session['id']}")
    elif len(argv) >= 3 and argv[0] == "send":
        call("POST", f"/session/{argv[1]}/prompt", {"text": " ".join(argv[2:])})
        print(f"sent; check it with: opencode-host read {argv[1]}")
    elif len(argv) == 2 and argv[0] == "read":
        reply, done = latest(call("GET", f"/session/{argv[1]}/message"))
        print(("done" if done else "still working") + "\n" + (reply or "(no reply yet)"))
    elif argv == ["list"]:
        for session in call("GET", "/session")[:15]:
            print(session.get("id"), "|", session.get("title"), "|", (session.get("location") or {}).get("directory", ""))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
