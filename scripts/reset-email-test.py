#!/usr/bin/env python3
"""Clear dedup, restart Hermes + expense-tracker, then mark test email unread.

Secrets (IMAP_PASSWORD, etc.) are loaded from hermes/.env — never hardcoded.
"""

import imaplib
import os
import sqlite3
import subprocess
import time

# --- Paths (relative to this script) ---
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)  # one level up from scripts/

COMPOSE_DIR = os.path.join(REPO_ROOT, "gateway")
HERMES_ENV = os.path.join(REPO_ROOT, "modules", "hermes", ".env")
EXPENSE_TRACKER_ENV = os.path.join(REPO_ROOT, "modules", "expense-tracker", ".env")
DEDUP_DB = os.path.join(REPO_ROOT, "modules", "expense-tracker", "data", "dedup.db")


# --- Load .env ---
def load_env(path):
    """Minimal dotenv parser — no extra dependencies."""
    if not os.path.isfile(path):
        raise FileNotFoundError(f".env not found: {path}")
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip()
            # Strip quotes
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                value = value[1:-1]
            if key not in os.environ:
                os.environ[key] = value


load_env(HERMES_ENV)
load_env(EXPENSE_TRACKER_ENV)

# --- Config (secrets from env, safe defaults for non-secrets) ---
IMAP_HOST = os.environ.get("IMAP_HOST", "imap.zoho.com")
IMAP_PORT = int(os.environ.get("IMAP_PORT", "993"))
IMAP_USER = os.environ["IMAP_USERNAME"]
IMAP_PASS = os.environ["IMAP_PASSWORD"]
MAILBOX = os.environ.get("IMAP_MAILBOX", "INBOX")
TEST_UID = b"128"

# --- Step 1: Clear dedup ---
print("1. Clearing dedup...")
conn = sqlite3.connect(DEDUP_DB)
for t in ["dedup", "processed_uids"]:
    conn.execute(f"DELETE FROM {t}")
conn.commit()
conn.close()
print("   done")

# --- Step 2: Restart containers ---
print("2. Recreating containers...")
subprocess.run(
    [
        "docker",
        "compose",
        "--env-file",
        HERMES_ENV,
        "up",
        "-d",
        "--force-recreate",
        "expense-tracker",
        "hermes",
    ],
    cwd=COMPOSE_DIR,
    check=True,
)
# Wait for Hermes webhook server to be ready
print("   waiting for hermes webhook...")
for i in range(30):
    try:
        r = __import__("urllib.request").request.urlopen(
            "http://localhost:8644/health", timeout=2
        )
        if r.status == 200:
            break
    except Exception:
        pass
    time.sleep(2)
else:
    print("WARNING: hermes webhook not ready after 60s")
time.sleep(5)  # extra buffer
print("   done")

# --- Step 3: Mark email unread ---
print("3. Marking UID 128 unread...")
imap = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
imap.login(IMAP_USER, IMAP_PASS)
imap.select(MAILBOX)
imap.uid("STORE", TEST_UID, "-FLAGS", "(\\Seen)")
imap.logout()
print("   done — UID 128 marked unread")

print("\nWait ~10s then check logs:")
print("  docker logs expense-tracker --tail 5")
print("  docker logs hermes --tail 20")
