#!/usr/bin/env python3
"""Log Friday's own Microsoft account back into OneDrive, with no LLM in the loop.

portfolio-sync.sh runs this when the OneDrive grant has expired or is missing.
The email and password are read from Bitwarden (MICROSOFT_ACCOUNT_EMAIL and
MICROSOFT_ACCOUNT_PASSWORD, plus MICROSOFT_ACCOUNT_TOTP_SECRET for the
authenticator-app step) at run time, typed into a throwaway headless
Chromium, and never printed or stored. The `nativeclient?code=` redirect the
login ends on is handed to portfolio-tracker, which exchanges it for a new
refresh token.

The login screens are Microsoft's and change over time, so anything this does
not recognise (a captcha, an identity check, a new prompt) fails the run with
the page title rather than guessing.

    onedrive-login.py            log in and save the new token
    onedrive-login.py --dry-run  log in and stop once the code arrives
"""
import base64
import glob
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
import struct
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

TRACKER = os.environ.get("PORTFOLIO_TRACKER_URL", "http://portfolio-tracker:8081")
CHROME_GLOB = "/opt/hermes/tools/chromium-*/chrome-linux64/chrome"
TIMEOUT = 120
MAX_CLICKS = 6

# Reports what the page wants next. Buttons are clicked here; text fields are
# only focused, so the secret is typed over CDP and never sits in a script.
STEP_JS = r"""(() => {
  const vis = (e) => e && e.offsetParent !== null && !e.disabled;
  const q = (s) => [...document.querySelectorAll(s)].find(vis);
  const err = q('#usernameError, #passwordError, #idTD_Error, [role=alert]');
  if (err && err.innerText.trim()) return {kind: 'error', text: err.innerText.trim()};
  for (const [kind, sel] of [['password', 'input[type=password]'],
                             ['email', 'input[type=email], input[name=loginfmt]']]) {
    const f = q(sel);
    if (f) {
      if (f.value) return {kind: 'wait'};
      f.focus();
      return {kind};
    }
  }
  // Any other text field is a one-time code; never click past one left empty.
  const code = q('input[name=otc], input[type=tel], input[type=number], input[type=text]');
  if (code) {
    if (code.value) return {kind: 'wait'};
    code.focus();
    return {kind: 'code', text: document.title};
  }
  const label = (b) => (b.innerText || b.value || '').trim();
  const btns = [...document.querySelectorAll('button, input[type=submit], input[type=button], a')].filter(vis);
  for (const re of [/^use your password$/i, /^(skip for now|not now|maybe later)$/i,
                    /^(yes|accept|continue|next)$/i]) {
    const b = btns.find((x) => re.test(label(x)));
    if (b) { b.click(); return {kind: 'clicked', text: label(b)}; }
  }
  return {kind: 'wait'};
})()"""

SUBMIT_JS = r"""(() => {
  const b = [...document.querySelectorAll('button[type=submit], input[type=submit], #idSIButton9')]
    .find((e) => e.offsetParent !== null && !e.disabled);
  if (b) b.click();
})()"""


class LoginError(Exception):
    pass


def log(message):
    print(f"[onedrive-login] {message}", file=sys.stderr)


def tracker(path, body=None):
    req = urllib.request.Request(
        TRACKER + path, data=json.dumps(body or {}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        try:
            detail = json.load(e).get("error")
        except ValueError:
            detail = None
        raise LoginError(f"portfolio-tracker {path}: HTTP {e.code} {detail or ''}".strip()) from None


def totp(secret, now=None):
    """The current RFC 6238 authenticator code for a base32 secret."""
    secret = secret.replace(" ", "").upper()
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    mac = hmac.new(key, struct.pack(">Q", int((time.time() if now is None else now) // 30)), hashlib.sha1).digest()
    offset = mac[-1] & 15
    return f"{(struct.unpack('>I', mac[offset:offset + 4])[0] & 0x7FFFFFFF) % 1000000:06d}"


def credentials():
    """Email, password and authenticator secret (or None), fresh from Bitwarden on every run."""
    from hermes_cli.env_loader import hydrate_profile_secret_sources
    from hermes_constants import get_hermes_home

    secrets = hydrate_profile_secret_sources(get_hermes_home())
    email = secrets.get("MICROSOFT_ACCOUNT_EMAIL")
    password = secrets.get("MICROSOFT_ACCOUNT_PASSWORD")
    if not (email and password):
        raise LoginError("MICROSOFT_ACCOUNT_EMAIL or MICROSOFT_ACCOUNT_PASSWORD is not in Bitwarden")
    return email, password, secrets.get("MICROSOFT_ACCOUNT_TOTP_SECRET")


class Chromium:
    """A throwaway headless Chromium driven over the DevTools protocol."""

    def __init__(self):
        from websockets.sync.client import connect

        chrome = sorted(glob.glob(CHROME_GLOB))
        if not chrome:
            raise LoginError(f"no Chromium at {CHROME_GLOB}")
        self.dir = tempfile.mkdtemp(prefix="onedrive-login-")
        self.proc = subprocess.Popen(
            [chrome[-1], "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
             f"--user-data-dir={self.dir}", "--remote-debugging-port=0", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        port_file = os.path.join(self.dir, "DevToolsActivePort")
        for _ in range(100):
            if os.path.exists(port_file) and len(open(port_file).read().split()) == 2:
                break
            time.sleep(0.2)
        else:
            self.close()
            raise LoginError("Chromium did not start")
        port, path = open(port_file).read().split()
        self.ws = connect(f"ws://127.0.0.1:{port}{path}", max_size=None)
        self.next_id = 0
        self.session = None
        self.code_url = None
        target = self.call("Target.createTarget", url="about:blank")["targetId"]
        self.session = self.call("Target.attachToTarget", targetId=target, flatten=True)["sessionId"]
        # Hold the final redirect instead of loading it: only its URL is needed.
        self.call("Fetch.enable", patterns=[{"urlPattern": "*oauth2/nativeclient*"}])

    def call(self, method, **params):
        self.next_id += 1
        msg = {"id": self.next_id, "method": method, "params": params}
        if self.session:
            msg["sessionId"] = self.session
        self.ws.send(json.dumps(msg))
        while True:
            reply = json.loads(self.ws.recv(timeout=30))
            if reply.get("method") == "Fetch.requestPaused":
                self.code_url = reply["params"]["request"]["url"]
            if reply.get("id") == self.next_id:
                if "error" in reply:
                    raise LoginError(f"{method}: {reply['error'].get('message')}")
                return reply.get("result", {})

    def navigate(self, url):
        self.call("Page.navigate", url=url)

    def evaluate(self, js):
        try:
            result = self.call("Runtime.evaluate", expression=js, returnByValue=True)
        except LoginError:
            return None  # the page navigated mid-call; ask again next tick
        return result.get("result", {}).get("value")

    def type(self, text):
        self.call("Input.insertText", text=text)

    def location(self):
        url = urllib.parse.urlsplit(self.evaluate("location.href") or "")
        return f"'{self.evaluate('document.title') or ''}' at {url.netloc}{url.path}"

    def close(self):
        try:
            self.ws.close()
        except Exception:  # noqa: BLE001 - best-effort teardown
            pass
        self.proc.kill()
        self.proc.wait()
        shutil.rmtree(self.dir, ignore_errors=True)


def login(page, auth_url, email, password, totp_secret=None, timeout=TIMEOUT, pause=1.5):
    """Walk the login screens; return the redirect URL that carries the code."""
    page.navigate(auth_url)
    typed, clicks = set(), 0
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if page.code_url:
            return page.code_url
        step = page.evaluate(STEP_JS) or {"kind": "wait"}
        kind = step["kind"]
        if kind == "error":
            raise LoginError("Microsoft said: " + step["text"].replace(email, "<email>")[:200])
        if kind == "code" and not ("authenticator" in step["text"].lower() and totp_secret):
            raise LoginError(f"Microsoft wants a code this cannot provide: '{step['text']}'")
        if kind in ("email", "password", "code"):
            # A field asked for twice means the first answer was refused. Never
            # retry the password: repeated failures can lock the account.
            if kind in typed:
                raise LoginError(f"Microsoft asked for the {kind} again")
            typed.add(kind)
            page.type({"email": email, "password": password}.get(kind) or totp(totp_secret))
            page.evaluate(SUBMIT_JS)
        elif kind == "clicked":
            clicks += 1
            if clicks > MAX_CLICKS:
                raise LoginError(f"too many prompts, last one {page.location()}")
            log(f"clicked '{step['text']}'")
        time.sleep(pause)
    if page.code_url:
        return page.code_url
    raise LoginError(f"no code after {timeout}s, stuck on {page.location()}")


def main(argv=None):
    dry_run = "--dry-run" in (argv if argv is not None else sys.argv[1:])
    try:
        email, password, totp_secret = credentials()
        auth_url = tracker("/onedrive/auth-url")["url"]
        page = Chromium()
        try:
            code_url = login(page, auth_url, email, password, totp_secret)
        finally:
            page.close()
        log("got an authorization code")
        if dry_run:
            return 0
        result = tracker("/onedrive/auth-complete", {"redirect_uri": code_url})
        if not result.get("success"):
            raise LoginError(f"code exchange failed: {result.get('error')}")
        log("OneDrive login renewed")
        return 0
    except LoginError as e:
        log(f"ERROR: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
