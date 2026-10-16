"""Email-intake runtime pieces that do not depend on the Hermes gateway (issue #783).

Settings come from the environment; intake stays off unless explicitly
enabled and fully configured, and only shadow mode exists in this iteration.
One owner lock per data directory guarantees a single active scanner even if
the gateway builds a second adapter. The poll loop survives errors.
"""

import fcntl
import imaplib
import logging
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path

from . import jev, senders
from .journal import Journal
from .scanner import Scanner
from .shadow import ShadowRunner

logger = logging.getLogger(__name__)

MODES = ("shadow",)
DEFAULT_INTERVAL = 300
DEFAULT_SENDERS_FILE = "/opt/data/home/wiki/entities/email-senders.md"


@dataclass
class Settings:
    mode: str
    imap_host: str
    imap_username: str
    imap_password: str = field(repr=False)
    jev_api_key: str = field(repr=False)
    imap_port: int = 993
    data_dir: str = "/opt/data/email-intake"
    interval: int = DEFAULT_INTERVAL
    senders_file: str = DEFAULT_SENDERS_FILE


def load_settings(get):
    """`get(key, default)` reads one setting (env or Hermes scoped secret); None when intake is off."""
    mode = (get("EMAIL_INTAKE_MODE", "") or "").strip().lower()
    if mode not in MODES:
        return None
    values = {key: (get(key, "") or "").strip() for key in ("IMAP_HOST", "IMAP_USERNAME", "IMAP_PASSWORD", "JEV_API_KEY")}
    if not all(values.values()):
        return None
    try:
        port = int(get("IMAP_PORT", "") or 993)
        interval = max(60, int(get("EMAIL_INTAKE_INTERVAL", "") or DEFAULT_INTERVAL))
    except ValueError:
        return None
    return Settings(
        mode=mode,
        imap_host=values["IMAP_HOST"],
        imap_username=values["IMAP_USERNAME"],
        imap_password=values["IMAP_PASSWORD"],
        jev_api_key=values["JEV_API_KEY"],
        imap_port=port,
        data_dir=(get("EMAIL_INTAKE_DATA_DIR", "") or "/opt/data/email-intake").strip(),
        interval=interval,
        senders_file=(get("EMAIL_INTAKE_SENDERS_FILE", "") or DEFAULT_SENDERS_FILE).strip(),
    )


class OwnerLock:
    """Exclusive, non-blocking file lock: one active scanner per data directory."""

    def __init__(self, path):
        self._path = Path(path)
        self._handle = None

    def acquire(self) -> bool:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        handle = open(self._path, "a+")
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            return False
        self._handle = handle
        return True

    def release(self):
        if self._handle:
            fcntl.flock(self._handle, fcntl.LOCK_UN)
            self._handle.close()
            self._handle = None


class StopFlag:
    def __init__(self):
        self._event = threading.Event()

    def set(self):
        self._event.set()

    def is_set(self):
        return self._event.is_set()

    def wait(self, seconds):
        self._event.wait(seconds)


def run_loop(run_once, interval, sleep, stop):
    """Call run_once every `interval` seconds until stopped; an error never ends the loop."""
    while not stop.is_set():
        try:
            summary = run_once()
            logger.info("email-intake shadow run: %s", summary)
        except Exception as error:  # noqa: BLE001 - counts and error type only, never content
            logger.warning("email-intake run failed: %s", type(error).__name__)
        sleep(interval)


def run_intake(settings, sleep, stop):
    """Thread body: build the runner here, because its sqlite journal may only be used by its own thread."""
    try:
        runner = build_runner(settings)
    except Exception as error:  # noqa: BLE001 - error type only
        logger.warning("email-intake could not start: %s", type(error).__name__)
        return
    run_loop(runner.run_once, settings.interval, sleep, stop)


def build_runner(settings: Settings):
    """The shadow runner for these settings, with real IMAP and Jev."""
    os.makedirs(settings.data_dir, mode=0o700, exist_ok=True)
    journal = Journal(Path(settings.data_dir) / "journal.db")

    def connect():
        imap = imaplib.IMAP4_SSL(settings.imap_host, settings.imap_port, timeout=60)
        imap.login(settings.imap_username, settings.imap_password)
        return imap

    scanner = Scanner(connect, journal, account=settings.imap_username.lower(), baseline=True)
    return ShadowRunner(
        scanner=scanner,
        journal=journal,
        classify=lambda text, context="": jev.classify(state_text=text, api_key=settings.jev_api_key, context=context),
        senders=lambda: senders.load(settings.senders_file),
        notify_rules=lambda: senders.load_rules(settings.senders_file),
    )
