#!/usr/bin/env python3
"""Own Google Tasks CLI (stdlib only).

Covers the upstream skill surface without the BRO3886 binary:
tasklists view/add/rm, tasks view/info/add/done/undo/clear/update/rm.
Login lives in `google login` (google_login.py), which grants one token shared
with the read-only gmail and gcal CLIs; the OAuth helpers stay here.

OAuth redirects to the loopback http://localhost:9090/callback (Google rejects
tailnet https redirects for this client). The browser reaches the listener on
port 8299 through `ssh -L 9090:localhost:8299 <user>@<host>`, or the redirect
URL is pasted back with `login --manual`. The CLI validates path, single use,
timeout, state and PKCE itself.
"""
import argparse
import base64
import calendar
import datetime as _dt
import hashlib
import http.server
import json
import os
import secrets
import socket
import sys
import threading
import urllib.parse
import urllib.request

VERSION = "0.1.0"
SCOPE = "https://www.googleapis.com/auth/tasks"
GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"
# Everything `google login` asks for. Login refuses a token granting anything
# else, which is what keeps Gmail and Calendar read-only.
LOGIN_SCOPES = (SCOPE, GMAIL_SCOPE, CALENDAR_SCOPE)
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
API_BASE = "https://tasks.googleapis.com/tasks/v1"
DEFAULT_REDIRECT_URI = "http://localhost:9090/callback"
CALLBACK_PORT = 8299
# All interfaces inside the container: Docker delivers the published port to the
# container's network interface, never to its loopback, so a 127.0.0.1 bind is
# unreachable from the host. Compose publishes it on host loopback only
# (127.0.0.1:8299:8299), and the listener only runs during a login.
CALLBACK_HOST = "0.0.0.0"
CALLBACK_PATHS = ("/callback", "/gtasks/callback")
LOGIN_TIMEOUT = 300
EXIT_AUTH_EXPIRED = 3


def audit(event, **fields):
    """Redacted stderr log. Callers pass counts/bools only, never secrets."""
    safe = {k: v for k, v in fields.items()
            if isinstance(v, (bool, int, float))}
    sys.stderr.write("gtasks %s %s\n" % (event, json.dumps(safe)))


def auth_expired_message():
    return ("Google token expired or revoked. "
            "Run `google login` again interactively to reconnect.")


def is_auth_expired(payload):
    if not isinstance(payload, dict):
        return False
    err = str(payload.get("error", "")).lower()
    return err in ("invalid_grant", "unauthorized", "invalid_credentials",
                   "expired_token", "autherror")


class AuthExpired(Exception):
    def __str__(self):
        return auth_expired_message()


class MissingScope(Exception):
    pass


class CallbackState:
    """Single-use OAuth callback gate. No secrets are logged."""

    def __init__(self, paths=CALLBACK_PATHS):
        self.paths = paths
        self.consumed = False
        self.code = None

    def handle(self, method, path, query, expected_state):
        pure_path = path.split("?", 1)[0]
        if method != "GET" or pure_path not in self.paths:
            return 404, "not found"
        if self.consumed:
            return 410, "callback already used"
        if query.get("error"):
            return 400, "authorization failed"
        code = query.get("code")
        state = query.get("state")
        if not code or not state:
            return 400, "missing code or state"
        if not expected_state or state != expected_state:
            return 400, "state mismatch"
        self.consumed = True
        self.code = code
        return 200, "ok"


class _Handler(http.server.BaseHTTPRequestHandler):
    state = None
    expected = ""

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        query = {k: v[0] for k, v in
                 urllib.parse.parse_qs(parsed.query).items()}
        status, _ = _Handler.state.handle("GET", parsed.path, query,
                                          _Handler.expected)
        audit("callback", status=status,
              consumed=bool(_Handler.state.consumed))
        body = ("<h1>Done. Return to your terminal.</h1>".encode()
                if status == 200 else b"OAuth callback rejected.")
        self.send_response(status)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        if status in (200, 410):
            threading.Thread(target=self.server.shutdown,
                             daemon=True).start()

    def log_message(self, *args):
        pass


def wait_for_code(port=CALLBACK_PORT, expected_state="", timeout=LOGIN_TIMEOUT,
                  paths=CALLBACK_PATHS):
    state = CallbackState(paths)
    _Handler.state = state
    _Handler.expected = expected_state
    server = http.server.HTTPServer((CALLBACK_HOST, port), _Handler)
    server.timeout = 1
    deadline = _dt.datetime.now().timestamp() + timeout
    while _dt.datetime.now().timestamp() < deadline:
        server.handle_request()
        if state.code:
            return state.code
    raise TimeoutError("timed out waiting for OAuth callback")


def pkce_pair():
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return verifier, challenge


def build_auth_url(client_id, redirect_uri, state, challenge, scope=SCOPE):
    params = urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": scope,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "access_type": "offline",
        "prompt": "consent",
    })
    return "%s?%s" % (AUTH_URL, params)


def _config_dir():
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(base, "gtasks")


def _token_path():
    # ponytail: the shared Google token keeps the gtasks path so the existing
    # tasks-only login keeps working until the next `google login`.
    return os.path.join(_config_dir(), "token.json")


def _client_env():
    cid = os.environ.get("GTASKS_CLIENT_ID", "")
    csec = os.environ.get("GTASKS_CLIENT_SECRET", "")
    if not cid or not csec:
        sys.stderr.write("GTASKS_CLIENT_ID/GTASKS_CLIENT_SECRET must be set.\n")
        raise SystemExit(2)
    return cid, csec


def _save_token(data):
    os.makedirs(_config_dir(), exist_ok=True)
    tmp = _token_path() + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh)
    os.chmod(tmp, 0o600)
    os.replace(tmp, _token_path())


def _load_token():
    try:
        with open(_token_path()) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _post_token(payload):
    data = urllib.parse.urlencode(payload).encode()
    req = urllib.request.Request(TOKEN_URL, data=data)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)
    except Exception as exc:  # urllib raises HTTPError (has .read)
        body = ""
        try:
            body = exc.read().decode()  # ponytail: best-effort error body
        except Exception:
            pass
        try:
            return json.loads(body) if body else {"error": str(exc)}
        except ValueError:
            return {"error": str(exc)}


def _refresh(token):
    # The client saved at login lets refresh work where GTASKS_* are unset.
    cid, csec = token.get("client_id"), token.get("client_secret")
    if not cid or not csec:
        cid, csec = _client_env()
    if not token.get("refresh_token"):
        raise AuthExpired()
    payload = {"grant_type": "refresh_token",
               "refresh_token": token["refresh_token"],
               "client_id": cid, "client_secret": csec}
    out = _post_token(payload)
    if out.get("error"):
        if is_auth_expired(out):
            raise AuthExpired()
        raise RuntimeError("token refresh failed")
    token["access_token"] = out["access_token"]
    token["expiry"] = (_dt.datetime.now(
        _dt.timezone.utc).timestamp() + out.get("expires_in", 3600))
    _save_token(token)
    return token


def _valid_token():
    token = _load_token()
    if not token or not token.get("access_token"):
        raise AuthExpired()
    if token.get("expiry", 0) - 60 > _dt.datetime.now(
            _dt.timezone.utc).timestamp():
        return token
    return _refresh(token)


def granted_scopes(token=None):
    """Scopes the saved token carries; a token saved before `google login`
    recorded them was a tasks-only login."""
    token = token if token is not None else _load_token()
    if not token:
        return set()
    return set(token.get("scopes") or [SCOPE])


def token_for(scope):
    """Valid access token whose grant includes scope."""
    token = _valid_token()
    if scope not in granted_scopes(token):
        raise MissingScope("The Google login does not include %s. Run `google login` again "
                           "and allow it." % scope.rsplit("/", 1)[-1])
    return token["access_token"]


def _api(method, path, body=None, _retried=False):
    token = _valid_token()
    url = API_BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token["access_token"])
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except Exception as exc:
        raw = ""
        try:
            raw = exc.read().decode()
        except Exception:
            pass
        try:
            payload = json.loads(raw) if raw else {}
        except ValueError:
            payload = {}
        status = getattr(exc, "code", None) or getattr(exc, "status", None)
        if status == 401 and not _retried:
            _refresh(token)
            return _api(method, path, body, _retried=True)
        if status == 401 or is_auth_expired(
                payload.get("error", payload)):
            raise AuthExpired()
        # 403 from a valid token means API disabled, missing scope, or a
        # bad resource — never an expired login. Say so precisely.
        raise RuntimeError("Tasks API error: %s" % (raw[:200] or exc))


def _tasks_path(list_id, task_id="", action=""):
    """Tasks API endpoints live under /lists/{id}, not /users/@me/lists.

    Only the tasklists methods use the @me segment; every tasks method
    (list/insert/get/patch/delete/clear) hangs off /lists/{tasklist}.
    Centralized so a wrong prefix breaks once, here, loudly in tests.
    """
    if action == "clear":
        return "/lists/%s/clear" % list_id
    path = "/lists/%s/tasks" % list_id
    if task_id:
        path += "/%s" % task_id
    return path


def _find_list(name):
    out = _api("GET", "/users/@me/lists?maxResults=100")
    for item in out.get("items", []):
        if item.get("title") == name:
            return item
    return None


def _list_id_or_exit(name):
    if not name:
        lists = _api("GET", "/users/@me/lists?maxResults=100").get("items", [])
        if len(lists) == 1:
            return lists[0]["id"]
        raise SystemExit("Multiple lists; pass -l \"<name>\".")
    item = _find_list(name)
    if not item:
        raise SystemExit("List not found: %s" % name)
    return item["id"]


def _ordered_tasks(list_id, include_completed=False):
    # Completed tasks include cleared (hidden) ones, so the monthly clear
    # never hides a task from the wiki reminder dedup; pages past 100.
    params = {"maxResults": 100, "showCompleted": str(include_completed).lower(),
              "showHidden": str(include_completed).lower()}
    items = []
    while True:
        out = _api("GET", _tasks_path(list_id) + "?%s"
                   % urllib.parse.urlencode(params))
        items += out.get("items", [])
        if not out.get("nextPageToken"):
            return items
        params["pageToken"] = out["nextPageToken"]


def _resolve_number(list_id, number, include_completed=True):
    items = _ordered_tasks(list_id, include_completed)
    try:
        idx = int(number) - 1
    except ValueError:
        raise SystemExit("Task number must be an integer.")
    if idx < 0 or idx >= len(items):
        raise SystemExit("Task number out of range; re-view the list first.")
    return items[idx]


def _to_due(date_str):
    try:
        day = _dt.datetime.strptime(date_str, "%Y-%m-%d").date()
    except ValueError:
        raise ValueError("Date must be YYYY-MM-DD.")
    return "%sT00:00:00.000Z" % day.isoformat()


def repeat_dates(start, pattern, count=None, until=None):
    """Expand -d + --repeat into YYYY-MM-DD dates (stdlib calendar math)."""
    try:
        day = _dt.datetime.strptime(start, "%Y-%m-%d").date()
    except ValueError:
        raise ValueError("Date must be YYYY-MM-DD.")
    if pattern not in ("daily", "weekly", "monthly", "yearly"):
        raise ValueError("Repeat must be daily/weekly/monthly/yearly.")
    if count is not None and count < 1:
        raise ValueError("Repeat count must be at least 1.")
    end = None
    if until:
        try:
            end = _dt.datetime.strptime(until, "%Y-%m-%d").date()
        except ValueError:
            raise ValueError("Repeat-until must be YYYY-MM-DD.")
        if end < day:
            raise ValueError("Repeat-until is before the start date.")

    def step(d):
        if pattern == "daily":
            return d + _dt.timedelta(days=1)
        if pattern == "weekly":
            return d + _dt.timedelta(weeks=1)
        # ponytail: calendar-aware month/year step, day clamped to month end
        months = 1 if pattern == "monthly" else 12
        m = d.month - 1 + months
        year, month = d.year + m // 12, m % 12 + 1
        last = calendar.monthrange(year, month)[1]
        return _dt.date(year, month, min(d.day, last))

    dates, cur = [], day
    while True:
        if end is not None and cur > end:
            break
        if count is not None and len(dates) >= count:
            break
        if count is None and end is None:
            raise ValueError("Repeat needs --repeat-count or --repeat-until.")
        dates.append(cur.isoformat())
        if count is not None and len(dates) >= count:
            break
        cur = step(cur)
        if len(dates) > 366:
            raise ValueError("Repeat expands to too many tasks (cap 366).")
    return dates


def forward_hint(redirect_uri, listen_port,
                 ssh_target="user@your-host.your-tailnet.ts.net"):
    """PC-side forward so the PC browser's localhost reaches the listener.

    Google redirects the browser to the loopback redirect_uri, which resolves
    on the PC, not in the container. Mapping PC <redirect-port> to the
    container listener via the host closes the gap without touching the
    registered redirect. Pure function for testing.
    """
    redirect_port = urllib.parse.urlparse(redirect_uri).port or 80
    return ("On your PC, run: ssh -L %d:localhost:%d %s "
            "then open the URL above in the PC browser."
            % (redirect_port, listen_port, ssh_target))


def parse_pasted_callback(text, expected_state):
    """Manual fallback: user pastes the localhost URL their browser failed
    to open (no port forward needed). Returns the code or raises ValueError.
    The pasted value is used once and never logged.
    """
    text = (text or "").strip().strip("\"'")
    if text.startswith("http"):
        query = {k: v[0] for k, v in urllib.parse.parse_qs(
            urllib.parse.urlparse(text).query).items()}
    else:
        query = dict(urllib.parse.parse_qsl(text))
    if query.get("error"):
        raise ValueError("authorization failed")
    code = query.get("code")
    state = query.get("state")
    if not code or not state:
        raise ValueError("no code/state found; paste the full redirect URL")
    if state != expected_state:
        raise ValueError("state mismatch")
    return code


def cmd_login(args):
    """`google login`: one consent for tasks, read-only Gmail and read-only Calendar."""
    cid, csec = _client_env()
    redirect_uri = args.redirect_uri or os.environ.get(
        "GTASKS_REDIRECT_URI", DEFAULT_REDIRECT_URI)
    state = secrets.token_urlsafe(32)
    verifier, challenge = pkce_pair()
    url = build_auth_url(cid, redirect_uri, state, challenge, scope=" ".join(LOGIN_SCOPES))
    print("Open this URL in your PC/phone browser:\n%s\n" % url)
    if args.manual:
        print("If the browser cannot reach the callback (connection refused), "
              "copy the full localhost address from its address bar and paste "
              "it below. It expires within minutes and is used once.")
        try:
            pasted = input("Redirect URL: ")
        except EOFError:
            raise SystemExit("Login cancelled.")
        code = parse_pasted_callback(pasted, state)
        audit("login", manual=True, code_len=len(code))
    elif redirect_uri.startswith("http://localhost"):
        print("Listening for the callback and: %s"
              % forward_hint(redirect_uri, args.port,
                             os.environ.get("GTASKS_SSH_TARGET",
                                            "user@your-host.your-tailnet.ts.net")))
        code = wait_for_code(port=args.port, expected_state=state,
                             timeout=args.timeout)
    elif redirect_uri.startswith("https://"):
        print("Waiting for tailnet callback to %s ..." % redirect_uri)
        code = wait_for_code(port=args.port, expected_state=state,
                             timeout=args.timeout)
    else:
        raise SystemExit("Unsupported redirect URI.")
    out = _post_token({"grant_type": "authorization_code", "code": code,
                       "redirect_uri": redirect_uri, "client_id": cid,
                       "client_secret": csec, "code_verifier": verifier})
    if out.get("error") or not out.get("access_token"):
        raise SystemExit("Login failed at token exchange.")
    granted = set(out.get("scope", "").split())
    if not granted or granted - set(LOGIN_SCOPES):
        # Never keep a token that could send, delete, or edit mail or events.
        raise SystemExit("Login refused: Google granted scopes beyond tasks, "
                         "gmail.readonly and calendar.readonly.")
    token = {"access_token": out["access_token"],
             "refresh_token": out.get("refresh_token", ""),
             "expiry": _dt.datetime.now(_dt.timezone.utc).timestamp()
             + out.get("expires_in", 3600),
             "scopes": sorted(granted), "client_id": cid, "client_secret": csec}
    if not token["refresh_token"]:
        raise SystemExit("No refresh_token returned; retry login with consent.")
    _save_token(token)
    audit("login", ok=True, scopes=len(granted))
    names = ", ".join(sorted(s.rsplit("/", 1)[-1] for s in granted))
    print("Login saved: %s." % names)
    if granted != set(LOGIN_SCOPES):
        print("Some access was left unticked; run `google login` again to add it.")


def cmd_tasklists(args):
    if args.action == "view":
        for item in _api("GET", "/users/@me/lists?maxResults=100").get(
                "items", []):
            print(item.get("title", ""))
    elif args.action == "add":
        if not args.title:
            raise SystemExit("Pass -t \"<title>\".")
        out = _api("POST", "/users/@me/lists", {"title": args.title})
        print("Created: %s" % out.get("title", ""))
    elif args.action == "rm":
        lid = _list_id_or_exit(args.name)
        _api("DELETE", "/users/@me/lists/%s" % lid)
        print("Deleted list.")


def cmd_tasks(args):
    if args.action == "view":
        lid = _list_id_or_exit(args.list)
        items = _ordered_tasks(lid, args.include_completed)
        if args.max is not None:
            items = items[:args.max]
        if getattr(args, "sort", None) in ("due", "title"):
            items = sorted(items, key=lambda t: t.get(args.sort, ""))
        if args.format == "json":
            print(json.dumps(items))
        else:
            for n, t in enumerate(items, 1):
                mark = "x" if t.get("status") == "completed" else " "
                print("%d [%s] %s" % (n, mark, t.get("title", "")))
    elif args.action == "info":
        lid = _list_id_or_exit(args.list)
        task = _resolve_number(lid, args.number)
        print(json.dumps(task, indent=2))
    elif args.action == "add":
        lid = _list_id_or_exit(args.list)
        if not args.title:
            raise SystemExit("Pass -t \"<title>\".")
        dates = [args.due] if args.due else [None]
        if args.repeat:
            if not args.due:
                raise SystemExit("Repeat needs -d YYYY-MM-DD.")
            dates = repeat_dates(args.due, args.repeat,
                                 args.repeat_count, args.repeat_until)
        for due in dates:
            body = {"title": args.title}
            if args.note:
                body["notes"] = args.note
            if due:
                body["due"] = _to_due(due)
            _api("POST", _tasks_path(lid), body)
        print("Task created%s." % (" x%d" % len(dates) if len(dates) > 1 else ""))
    elif args.action in ("done", "undo"):
        lid = _list_id_or_exit(args.list)
        # Explicit --id short-circuits the positional-list resolution:
        # closing by a re-resolved index could hit a moving target.
        task_id = args.id or _resolve_number(lid, args.number)["id"]
        status = "completed" if args.action == "done" else "needsAction"
        _api("PATCH", _tasks_path(lid, task_id), {"status": status})
        print("Marked %s." % args.action)
    elif args.action == "clear":
        lid = _list_id_or_exit(args.list)
        if not args.force:
            raise SystemExit("Pass --force to hide completed tasks.")
        _api("POST", _tasks_path(lid, action="clear"))
        print("Cleared completed tasks.")
    elif args.action == "update":
        lid = _list_id_or_exit(args.list)
        task = _resolve_number(lid, args.number)
        body = {}
        if args.title:
            body["title"] = args.title
        if args.note:
            body["notes"] = args.note
        if args.due:
            body["due"] = _to_due(args.due)
        if not body:
            raise SystemExit("Nothing to update.")
        _api("PATCH", _tasks_path(lid, task["id"]), body)
        print("Task updated.")
    elif args.action == "rm":
        lid = _list_id_or_exit(args.list)
        task = _resolve_number(lid, args.number)
        _api("DELETE", _tasks_path(lid, task["id"]))
        print("Task deleted.")


def _hoist_action(argv):
    """Accept `tasks -l LIST view` as well as `tasks view -l LIST`.

    The wiki-reminders helper (and cobra-style CLIs) put flags before the
    action word; argparse only accepts them after. Move the first known
    action token to the front so both orders parse identically.
    """
    if len(argv) < 2 or argv[0] not in ("tasks", "tasklists"):
        return argv
    if not argv[1].startswith("-"):
        return argv
    actions = {"view", "add", "rm", "info", "done", "undo", "clear",
               "update"}
    for i in range(1, len(argv)):
        if argv[i] in actions:
            return [argv[0], argv[i]] + argv[1:i] + argv[i + 1:]
    return argv


def build_parser():
    parser = argparse.ArgumentParser(prog="gtasks")
    parser.add_argument("-v", "--version", action="version",
                        version="gtasks version %s" % VERSION)
    sub = parser.add_subparsers(dest="command", required=True)

    tasklists = sub.add_parser("tasklists")
    tasklists.add_argument("action", choices=("view", "add", "rm"))
    tasklists.add_argument("-t", "--title", default="")
    tasklists.add_argument("name", nargs="?", default="")

    tasks = sub.add_parser("tasks")
    tasks.add_argument("action",
                       choices=("view", "info", "add", "done", "undo",
                                "clear", "update", "rm"))
    tasks.add_argument("number", nargs="?", default="")
    tasks.add_argument("-l", "--list", default="")
    tasks.add_argument("-t", "--title", default="")
    tasks.add_argument("-n", "--note", default="")
    tasks.add_argument("-d", "--due", default="")
    tasks.add_argument("-i", "--include-completed", action="store_true")
    tasks.add_argument("--id", default="")
    tasks.add_argument("--sort", default="position",
                       choices=("position", "due", "title"))
    tasks.add_argument("--max", type=int, default=None)
    tasks.add_argument("--format", default="text")
    tasks.add_argument("--repeat", default="",
                       choices=("", "daily", "weekly", "monthly", "yearly"))
    tasks.add_argument("--repeat-count", type=int, default=None)
    tasks.add_argument("--repeat-until", default=None)
    tasks.add_argument("--force", action="store_true")
    return parser


def main(argv=None):
    args = build_parser().parse_args(_hoist_action(list(argv) if argv is not None else sys.argv[1:]))
    try:
        if args.command == "tasklists":
            cmd_tasklists(args)
        elif args.command == "tasks":
            cmd_tasks(args)
    except AuthExpired:
        sys.stderr.write(auth_expired_message() + "\n")
        raise SystemExit(EXIT_AUTH_EXPIRED)
    except MissingScope as exc:
        sys.stderr.write("%s\n" % exc)
        raise SystemExit(EXIT_AUTH_EXPIRED)
    except BrokenPipeError:
        raise SystemExit(0)


if __name__ == "__main__":
    # One minimal self-check: PKCE challenge is well-formed base64url.
    _v, _c = pkce_pair()
    assert "=" not in _c and len(_c) == 43, "pkce"
    main()
