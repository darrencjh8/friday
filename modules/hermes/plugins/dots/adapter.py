"""Dots platform adapter: one authenticated WebSocket conversation for the Hermes Android app.

Protocol: docs/protocole-gateway.md in the app repository. The server listens on DOTS_BIND
(127.0.0.1:8787) and is meant to sit behind a TLS reverse proxy. Env: DOTS_TOKEN (required),
DOTS_BIND, DOTS_ALLOWED_USERS, DOTS_HOME_CHANNEL, DOTS_FCM_CREDENTIALS (service account JSON,
default ``~/.hermes/platforms/dots/fcm-service-account.json``; push is off when it is missing),
DOTS_AGENT_ID / DOTS_AGENT_NAME (identity of this agent in a multi-agent app, see ``_agent_identity``),
DOTS_WEB_ORIGINS (comma-separated origins of the web app, e.g. ``https://dots.vercel.app``; the web app
is refused while it is unset).

Identity: the bearer token is the trust boundary; every authenticated client is the single
``owner`` user, and the main chat is ``chat_id == "owner"``. Browsers never see DOTS_TOKEN: the phone
mints them a revocable web token of their own (``web_token_create``, see ``_WebTokens``). One plugin serves one Hermes profile:
several independent agents are several profiles, each with its own gateway, token and port.
"""

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import re
import secrets
import threading
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Optional

try:
    from aiohttp import WSMsgType, web
    AIOHTTP_AVAILABLE = True
except ImportError:
    AIOHTTP_AVAILABLE = False
    web = None  # type: ignore[assignment]

from gateway.config import Platform, PlatformConfig
from gateway.platforms._shared import extra_or_secret as _extra_or_secret
from gateway.platforms._shared import get_scoped_secret as _get_scoped_secret
from gateway.platforms._shared import seed_extra_from_env as _seed_extra_from_env
from gateway.platforms._shared import send_error
from gateway.platforms.base import BasePlatformAdapter, SendResult
from gateway.platforms.event import MessageEvent, MessageType
from gateway.platforms.helpers import MessageDeduplicator
from hermes_constants import get_hermes_home

logger = logging.getLogger(__name__)

OWNER = "owner"
DEFAULT_BIND = "127.0.0.1:8787"
WS_PATH = "/dots/ws"
SEND_PATH = "/dots/send"
# Web app: browsers cannot set an Authorization header on a WebSocket, so they offer two subprotocols,
# ``dots.v1`` (echoed back) and ``dots.token.<web token>``. A refused web token still gets the upgrade,
# then a close with WEB_UNAUTHORIZED: a browser cannot read the status of a refused handshake.
WEB_SUBPROTOCOL = "dots.v1"
WEB_TOKEN_PROTOCOL = "dots.token."
WEB_UNAUTHORIZED = 4401
MAX_WEB_TOKENS = 20
WEB_LABEL_MAX = 80
REPLAY_LIMIT = 600  # events replayed to a reconnecting app; beyond, it gets the latest page and resets
INITIAL_PAGE = 120  # events sent on a fresh connection; older ones come through history_page
MAX_PAGE = 200
MAX_MESSAGE_LENGTH = 16000
FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
PUSH_BODY_LIMIT = 1500
MAX_PUSH_TOKENS = 4
MAX_VOICE_BYTES = 6 * 1024 * 1024  # ~25 min of 32 kb/s AAC: plenty for a voice note
MAX_FILE_BYTES = 20 * 1024 * 1024  # attachments in either direction
SCREEN_FPS_DELAY = 0.3  # seconds between frames while the app watches the browser
TAKEOVER_FPS_DELAY = 0.12  # faster while the owner drives the page: their taps must feel immediate
# Keys the app can send while the owner drives the agent's browser (CDP key, code, Windows key code).
_KEYS = {"Enter": ("Enter", "Enter", 13, "\r"), "Backspace": ("Backspace", "Backspace", 8, ""),
         "Tab": ("Tab", "Tab", 9, ""), "Escape": ("Escape", "Escape", 27, "")}
SCREEN_SCALE = 0.6  # downscale frames: phone-sized, ~40-80 KB JPEG each
# Group room: the owner invites sub-dots into the current conversation; they debate for a few rounds,
# each in its own Hermes session ``<dot id>~<host chat>``, then the host dot concludes.
ROOM_SEP = "~"
ROOM_ROUNDS = 2
ROOM_MAX_ROUNDS = 3
ROOM_MAX_SPEAKERS = 4
ROOM_TURN_TIMEOUT_S = 600
ROOM_CONTEXT_EVENTS = 40  # at most this many recent events of the room are replayed to a speaker
# Usage heatmap: how often the token totals of Hermes' sessions are sampled, and the widest window
# the app may ask for at once (a month and a few days of margin for its time zone).
USAGE_SAMPLE_S = 300
USAGE_MAX_WINDOW_MS = 40 * 24 * 3600 * 1000
_MEDIA_MESSAGE_TYPES = {"image": MessageType.PHOTO, "video": MessageType.VIDEO, "audio": MessageType.AUDIO,
                        "document": MessageType.DOCUMENT}
VOICE_TYPES = {"audio/mp4": ".m4a", "audio/aac": ".aac", "audio/ogg": ".ogg", "audio/webm": ".webm"}
# Hermes echoes each STT result as ``🎙️ "…"`` (gateway.voice.transcript_echo_short, same in every
# locale). The app shows it under the voice bubble instead of as a separate message.
_TRANSCRIPT_ECHO = re.compile(r'^\s*🎙️\s*"(?P<text>.*)"\s*$', re.DOTALL)

# Tool name -> (kind, English label, French label). ``kind`` picks the icon in the app; the detail line
# comes from Hermes' own preview builder. Tools absent here fall back to ("tool", their humanised name).
# The app translates these names itself (ToolLabels.kt): keep both lists in sync.
_TOOL_LABELS: dict[str, tuple[str, str, str]] = {
    "terminal": ("terminal", "Runs a command", "Exécute une commande"),
    "process": ("terminal", "Follows a process", "Suit un processus"),
    "read_file": ("read", "Reads a file", "Lit un fichier"),
    "search_files": ("search", "Searches files", "Cherche dans les fichiers"),
    "write_file": ("write", "Writes a file", "Écrit un fichier"),
    "patch": ("write", "Edits a file", "Modifie un fichier"),
    "web_search": ("web", "Searches the web", "Cherche sur le web"),
    "web_extract": ("web", "Reads a web page", "Lit une page web"),
    "skill_view": ("skill", "Reads the skill", "Lit la skill"),
    "skills_list": ("skill", "Browses its skills", "Parcourt ses skills"),
    "skill_manage": ("skill", "Updates a skill", "Met à jour une skill"),
    "memory": ("memory", "Memorizes", "Mémorise"),
    "session_search": ("memory", "Digs through its memories", "Fouille ses souvenirs"),
    "execute_code": ("code", "Runs code", "Exécute du code"),
    "delegate_task": ("delegate", "Delegates to a sub-agent", "Délègue à un sous-agent"),
    "todo": ("plan", "Updates its plan", "Met à jour son plan"),
    "cronjob": ("schedule", "Manages a scheduled task", "Gère une tâche planifiée"),
    "vision_analyze": ("vision", "Analyzes an image", "Analyse une image"),
    "image_generate": ("image", "Generates an image", "Génère une image"),
    "text_to_speech": ("audio", "Synthesizes speech", "Synthétise la voix"),
    "send_message": ("send", "Sends a message", "Envoie un message"),
    "tool_search": ("tool", "Looks for a tool", "Cherche un outil"),
    "tool_describe": ("tool", "Checks a tool", "Consulte un outil"),
    "browser_request_takeover": ("web", "Asks you to take over", "Te demande de prendre la main"),
}

# Texts the plugin writes itself (pushes, chat notes, hints to the agent), in the app's language:
# the ``lang`` of the last ``hello``. Any other language falls back to English, like the app.
LANGUAGES = ("en", "fr")
DEFAULT_LANGUAGE = "en"
_LANGUAGE_NAMES = {"en": "English", "fr": "French"}
_TEXTS: dict[str, dict[str, str]] = {
    "en": {
        "browsing": "Browses the web",
        "tool": "Tool",
        "approval_title": "Command to approve",
        "voice_message": "🎙️ Voice message",
        "file": "file",
        "file_too_big": "(file too large for the app: {mb} MB)",
        "takeover_reason": "Take over my browser.",
        "default_mission": "help the owner",
    },
    "fr": {
        "browsing": "Navigue sur le web",
        "tool": "Outil",
        "approval_title": "Commande à approuver",
        "voice_message": "🎙️ Message vocal",
        "file": "fichier",
        "file_too_big": "(fichier trop lourd pour l'app : {mb} Mo)",
        "takeover_reason": "Prends la main sur mon navigateur.",
        "default_mission": "aider le propriétaire",
    },
}


def _language(value: Any) -> str:
    """``fr-FR``, ``fr`` -> ``fr`` ; unknown or missing -> English."""
    code = str(value or "").strip().lower().replace("_", "-").split("-")[0]
    return code if code in LANGUAGES else DEFAULT_LANGUAGE


def _text(lang: str, key: str, **args: Any) -> str:
    return _TEXTS.get(lang, _TEXTS[DEFAULT_LANGUAGE])[key].format(**args)
TAKEOVER_TIMEOUT_S = 15 * 60
# clarify already has its own card in the app.
_HIDDEN_TOOLS = frozenset({"clarify"})


def _now_ms() -> int:
    return int(time.time() * 1000)


def _token(extra: Optional[dict] = None) -> str:
    return (_extra_or_secret(extra or {}, "token", "DOTS_TOKEN") or "").strip()


def _agent_identity(extra: Optional[dict] = None) -> tuple[str, str]:
    """Stable id and display name of the agent this gateway serves.

    The app keeps one connection per agent and uses the id to route pushes to the right one. By
    default the id derives from the profile's home directory (stable across restarts and token
    rotations, distinct per profile) and the name is the profile's (``~/.hermes/profiles/<name>``),
    or "Hermes" for the default profile.
    """
    extra = extra or {}
    home = get_hermes_home()
    try:
        home = home.resolve()
    except OSError:
        pass
    agent_id = (_extra_or_secret(extra, "agent_id", "DOTS_AGENT_ID") or "").strip()
    if not agent_id:
        agent_id = hashlib.sha256(str(home).encode("utf-8")).hexdigest()[:16]
    name = (_extra_or_secret(extra, "agent_name", "DOTS_AGENT_NAME") or "").strip()
    if not name:
        name = home.name if home.parent.name == "profiles" else "Hermes"
    return agent_id[:64], name[:24]


def _parse_bind(value: str) -> tuple[str, int]:
    host, _, port = (value or DEFAULT_BIND).rpartition(":")
    return host or "127.0.0.1", int(port)


def _web_origins(extra: Optional[dict] = None) -> frozenset[str]:
    """Origins allowed to open a socket from a browser (``https://dots.vercel.app``), normalised."""
    raw = _extra_or_secret(extra or {}, "web_origins", "DOTS_WEB_ORIGINS") or ""
    return frozenset(_origin(o) for o in str(raw).split(",") if _origin(o))


def _origin(value: Any) -> str:
    """``HTTPS://Dots.Vercel.app/`` -> ``https://dots.vercel.app``: what a browser sends in ``Origin``."""
    return str(value or "").strip().rstrip("/").lower()


def check_requirements() -> bool:
    return AIOHTTP_AVAILABLE and bool(_get_scoped_secret("DOTS_TOKEN", "").strip())


def validate_config(config) -> bool:
    return bool(_token(getattr(config, "extra", {}) or {}))


def is_connected(config) -> bool:
    return validate_config(config)


class _History:
    """The whole conversation in SQLite: appends and in-place patches are single-row writes, and the
    app pages back through it (``history_page``) instead of receiving a fixed window."""

    def __init__(self, path: Path):
        import sqlite3
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, isolation_level=None)  # autocommit: one statement, one write
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, id TEXT, data TEXT NOT NULL)")
        # One conversation per dot: rows carry their chat (the main dot is ``owner``).
        if "chat" not in [r[1] for r in self._db.execute("PRAGMA table_info(events)")]:
            self._db.execute(f"ALTER TABLE events ADD COLUMN chat TEXT NOT NULL DEFAULT '{OWNER}'")
        self._db.execute("CREATE INDEX IF NOT EXISTS events_id ON events(id)")
        self._db.execute("CREATE INDEX IF NOT EXISTS events_chat ON events(chat, seq)")
        self._migrate_jsonl(path.with_name("history.jsonl"))
        self.seq = self._db.execute("SELECT COALESCE(MAX(seq), 0) FROM events").fetchone()[0]
        # Set by the adapter: rewrites an event before it is stored (a room speaker's session -> its room).
        self.route: Any = lambda event: event

    def _migrate_jsonl(self, legacy: Path) -> None:
        """One-time import of the former JSONL file, kept aside as ``history.jsonl.migrated``."""
        if not legacy.exists() or self._db.execute("SELECT 1 FROM events LIMIT 1").fetchone():
            return
        rows = []
        for line in legacy.read_text(encoding="utf-8").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event.get("seq"), int):
                rows.append((event["seq"], event.get("id"), json.dumps(event, ensure_ascii=False)))
        self._db.executemany("INSERT OR IGNORE INTO events (seq, id, data) VALUES (?, ?, ?)", rows)
        legacy.replace(legacy.with_name("history.jsonl.migrated"))

    def add(self, event: dict[str, Any]) -> dict[str, Any]:
        self.seq += 1
        event = self.route({**event, "seq": self.seq, "chat": event.get("chat") or OWNER})
        self._db.execute("INSERT INTO events (seq, id, data, chat) VALUES (?, ?, ?, ?)",
                         (self.seq, event.get("id"), json.dumps(event, ensure_ascii=False), event["chat"]))
        return event

    def get(self, event_id: str) -> Optional[dict[str, Any]]:
        row = self._db.execute("SELECT data FROM events WHERE id = ? ORDER BY seq DESC LIMIT 1", (event_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def update(self, event_id: str, **fields: Any) -> Optional[dict[str, Any]]:
        """Patch a stored event in place (streamed edits, tool outcome, transcript, approval)."""
        event = self.get(event_id)
        if event is None:
            return None
        event.update(fields)
        self._db.execute("UPDATE events SET data = ? WHERE seq = ?", (json.dumps(event, ensure_ascii=False), event["seq"]))
        return event

    def since(self, seq: int) -> tuple[list[dict[str, Any]], bool]:
        """Events after ``seq`` for a reconnecting app; (latest page, True) when the gap is too big."""
        rows = self._db.execute("SELECT data FROM events WHERE seq > ? ORDER BY seq LIMIT ?", (seq, REPLAY_LIMIT + 1)).fetchall()
        if len(rows) <= REPLAY_LIMIT:
            return [json.loads(r[0]) for r in rows], False
        return self.page(OWNER, None, INITIAL_PAGE)[0], True

    def page(self, chat: str, before: Optional[int], limit: int) -> tuple[list[dict[str, Any]], bool]:
        """``limit`` events of one chat before ``before`` (newest page when None), oldest first, plus has_more."""
        bound = before if before is not None else self.seq + 1
        rows = self._db.execute("SELECT data FROM events WHERE chat = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
                                (chat, bound, limit + 1)).fetchall()
        has_more = len(rows) > limit
        return [json.loads(r[0]) for r in reversed(rows[:limit])], has_more

    def after(self, chat: str, seq: int, limit: int) -> list[dict[str, Any]]:
        """The last ``limit`` events of one chat after ``seq``, oldest first (what a room speaker missed)."""
        rows = self._db.execute("SELECT data FROM events WHERE chat = ? AND seq > ? ORDER BY seq DESC LIMIT ?",
                                (chat, seq, limit)).fetchall()
        return [json.loads(r[0]) for r in reversed(rows)]

    def last_ts(self, chat: str) -> int:
        row = self._db.execute("SELECT data FROM events WHERE chat = ? ORDER BY seq DESC LIMIT 1", (chat,)).fetchone()
        return int(json.loads(row[0]).get("ts", 0)) if row else 0

    def delete_chat(self, chat: str) -> None:
        self._db.execute("DELETE FROM events WHERE chat = ?", (chat,))

    def messages_per_hour(self, start_ms: int, end_ms: int) -> dict[int, int]:
        """Messages (the owner's and the dots') per UTC hour since the epoch, every chat included."""
        rows = self._db.execute(
            "SELECT CAST(json_extract(data, '$.ts') / 3600000 AS INTEGER), COUNT(*) FROM events"
            " WHERE json_extract(data, '$.type') = 'message' AND json_extract(data, '$.ts') >= ?"
            " AND json_extract(data, '$.ts') < ? GROUP BY 1", (start_ms, end_ms)).fetchall()
        return {int(hour): int(count) for hour, count in rows}


class _Usage:
    """Tokens spent by the agent per UTC hour, every Hermes session included (scheduled tasks too).

    Hermes' ``state.db`` only keeps a running total per session, so this ledger samples those totals
    and books what each one grew by since the last look into the current hour. A session it has never
    seen (the whole past, on the first run) is spread over the hours of its own messages: a fair
    estimate, exact enough for a heatmap, and from then on every sample is an exact delta."""

    def __init__(self, path: Path, state_db: Path):
        import sqlite3
        path.parent.mkdir(parents=True, exist_ok=True)
        self._state_db = state_db
        # Sampled from a worker thread (asyncio.to_thread), read from the event loop: one lock for both.
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("CREATE TABLE IF NOT EXISTS usage_hours (hour INTEGER PRIMARY KEY, tokens INTEGER NOT NULL)")
        self._db.execute("CREATE TABLE IF NOT EXISTS usage_seen (session TEXT PRIMARY KEY, total INTEGER NOT NULL)")

    def sample(self, now: Optional[float] = None) -> None:
        import sqlite3
        if not self._state_db.exists():
            return
        hour = int((now if now is not None else time.time()) // 3600)
        state = sqlite3.connect(f"file:{self._state_db.as_posix()}?mode=ro", uri=True)
        try:
            # Totals read under the lock: two overlapping samples (the loop, an app request) must not
            # compare an older read with a newer mark, which would book the same growth twice.
            with self._lock:
                totals = state.execute(
                    "SELECT id, COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) FROM sessions").fetchall()
                seen = dict(self._db.execute("SELECT session, total FROM usage_seen").fetchall())
                booked: dict[int, int] = {}
                changed: list[tuple[str, int]] = []
                for session, total in totals:
                    total = int(total or 0)
                    before = seen.get(session)
                    if before == total:
                        continue
                    changed.append((session, total))
                    if before is None:
                        self._spread(state, session, total, hour, booked)
                    elif total > before:  # a total that shrinks (session rewound) just resets the mark
                        booked[hour] = booked.get(hour, 0) + total - before
                if not changed:
                    return
                # One transaction: the hours booked and the new marks land together, or not at all
                # (a half-written sample would book the same growth twice on the next one).
                self._db.execute("BEGIN")
                try:
                    self._db.executemany(
                        "INSERT INTO usage_hours (hour, tokens) VALUES (?, ?)"
                        " ON CONFLICT(hour) DO UPDATE SET tokens = tokens + excluded.tokens", list(booked.items()))
                    self._db.executemany(
                        "INSERT INTO usage_seen (session, total) VALUES (?, ?)"
                        " ON CONFLICT(session) DO UPDATE SET total = excluded.total", changed)
                    self._db.execute("COMMIT")
                except Exception:
                    self._db.execute("ROLLBACK")
                    raise
        finally:
            state.close()

    @staticmethod
    def _spread(state: Any, session: str, total: int, hour: int, booked: dict[int, int]) -> None:
        """Book a session first seen with ``total`` tokens over the hours its messages were written."""
        if total <= 0:
            return
        hours = state.execute("SELECT CAST(timestamp / 3600 AS INTEGER), COUNT(*) FROM messages"
                              " WHERE session_id = ? GROUP BY 1 ORDER BY 1", (session,)).fetchall()
        count = sum(n for _, n in hours)
        if not count:
            booked[hour] = booked.get(hour, 0) + total
            return
        left = total
        for i, (h, n) in enumerate(hours):
            share = left if i == len(hours) - 1 else total * n // count  # the rounding rest goes last
            booked[int(h)] = booked.get(int(h), 0) + share
            left -= share

    def tokens_per_hour(self, start_ms: int, end_ms: int) -> dict[int, int]:
        with self._lock:
            rows = self._db.execute("SELECT hour, tokens FROM usage_hours WHERE hour >= ? AND hour < ?",
                                    (start_ms // 3_600_000, -(-end_ms // 3_600_000))).fetchall()
        return {int(hour): int(tokens) for hour, tokens in rows}


class _Dots:
    """Sub-dots of the owner: ``temporary`` (one mission, meant to be closed) or ``permanent``
    (a lasting specialist with its own name and mascot). Each one is its own chat, hence its own
    Hermes session; the main dot stays the ``owner`` chat."""

    FIELDS = ("name", "kind", "mission", "species", "palette", "accessory")

    def __init__(self, path: Path):
        self._path = path
        try:
            self._dots: list[dict[str, Any]] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
        except json.JSONDecodeError:
            self._dots = []

    def all(self) -> list[dict[str, Any]]:
        return list(self._dots)

    def get(self, dot_id: str) -> Optional[dict[str, Any]]:
        return next((d for d in self._dots if d["id"] == dot_id), None)

    def create(self, fields: dict[str, Any]) -> dict[str, Any]:
        dot = {"id": f"dot-{uuid.uuid4().hex[:10]}", "created_at": _now_ms(), **self._clean(fields)}
        dot.setdefault("kind", "temporary")
        if not dot.get("name"):  # unnamed temporary dot: the first words of its mission
            dot["name"] = " ".join(str(dot.get("mission") or "Mission").split()[:3])[:40].capitalize() or "Mission"
        self._dots.append(dot)
        self._save()
        return dot

    def update(self, dot_id: str, fields: dict[str, Any]) -> Optional[dict[str, Any]]:
        dot = self.get(dot_id)
        if dot is not None:
            dot.update(self._clean(fields))
            self._save()
        return dot

    def delete(self, dot_id: str) -> bool:
        before = len(self._dots)
        self._dots = [d for d in self._dots if d["id"] != dot_id]
        self._save()
        return len(self._dots) < before

    def _clean(self, fields: dict[str, Any]) -> dict[str, Any]:
        out = {k: str(v).strip()[:2000 if k == "mission" else 40] for k, v in fields.items() if k in self.FIELDS and v is not None}
        if out.get("kind") not in (None, "temporary", "permanent"):
            out.pop("kind")
        return out

    def _save(self) -> None:
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._dots, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self._path)


def _describe_tool(name: str, args: Any, lang: str = DEFAULT_LANGUAGE) -> tuple[str, str, str]:
    """(kind, label, detail) shown by the app above the agent's reply, the label in the app's language."""
    if name in _TOOL_LABELS:
        kind, en, fr = _TOOL_LABELS[name]
        label = fr if lang == "fr" else en
    elif name.startswith("browser_"):
        kind, label = "web", _text(lang, "browsing")
    else:
        kind, label = "tool", name.replace("_", " ").strip().capitalize() or _text(lang, "tool")
    detail = ""
    try:
        from agent.display import build_tool_preview
        detail = build_tool_preview(name, args if isinstance(args, dict) else {}, max_len=90) or ""
    except Exception:
        logger.debug("tool preview failed for %s", name, exc_info=True)
    if detail.startswith("display."):  # untranslated i18n key: better nothing than a key
        detail = ""
    return kind, label, detail


class _WebTokens:
    """Tokens the phone mints for browsers, one per paired browser, revocable one by one.

    Only a SHA-256 of each token is kept on disk (``web_tokens.json``, mode 600): the file alone
    does not open the gateway. DOTS_TOKEN stays the master key and never leaves the phone.
    """

    def __init__(self, path: Path):
        self._path = path
        try:
            self._items: list[dict[str, Any]] = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            self._items = []

    @staticmethod
    def _digest(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(json.dumps(self._items), encoding="utf-8")
        try:
            self._path.chmod(0o600)
        except OSError:
            pass

    def create(self, label: str, origin: str) -> tuple[str, str]:
        """A fresh token and its id; beyond MAX_WEB_TOKENS the least recently used one is dropped."""
        token = secrets.token_urlsafe(32)  # 43 URL-safe characters: valid in a subprotocol name
        session_id = uuid.uuid4().hex[:12]
        now = _now_ms()
        self._items.append({"id": session_id, "hash": self._digest(token), "label": label[:WEB_LABEL_MAX],
                            "origin": origin, "created_at": now, "last_seen": now})
        self._items = sorted(self._items, key=lambda i: i.get("last_seen", 0))[-MAX_WEB_TOKENS:]
        self._save()
        return token, session_id

    def check(self, token: str) -> Optional[str]:
        """Id of the web session this token opens, or None; refreshes its last use."""
        if not token:
            return None
        digest = self._digest(token)
        for item in self._items:
            if hmac.compare_digest(item["hash"], digest):
                item["last_seen"] = _now_ms()
                self._save()
                return item["id"]
        return None

    def revoke(self, session_id: str) -> bool:
        kept = [i for i in self._items if i["id"] != session_id]
        if len(kept) == len(self._items):
            return False
        self._items = kept
        self._save()
        return True

    def public(self) -> list[dict[str, Any]]:
        """What the phone lists: never the hashes."""
        return [{k: i.get(k) for k in ("id", "label", "origin", "created_at", "last_seen")} for i in self._items]


class _Push:
    """FCM HTTP v1 sender. Data-only, high-priority messages: the app renders the notification."""

    def __init__(self, credentials_path: Path, store_path: Path):
        self._store = store_path
        self._creds = None
        self.tokens: list[str] = []
        if store_path.exists():
            try:
                self.tokens = [str(t) for t in json.loads(store_path.read_text(encoding="utf-8"))]
            except (json.JSONDecodeError, TypeError):
                self.tokens = []
        if credentials_path.exists():
            try:
                from google.oauth2 import service_account
                self._creds = service_account.Credentials.from_service_account_file(str(credentials_path), scopes=[FCM_SCOPE])
            except Exception as exc:
                logger.warning("[dots] FCM credentials unusable: %s", exc)

    @property
    def enabled(self) -> bool:
        return self._creds is not None

    def register(self, token: str) -> None:
        token = token.strip()
        if not token or (self.tokens and self.tokens[-1] == token):
            return
        self.tokens = [t for t in self.tokens if t != token][-(MAX_PUSH_TOKENS - 1):] + [token]
        self._store.write_text(json.dumps(self.tokens), encoding="utf-8")

    def _access_token(self) -> str:
        from google.auth.transport.requests import Request
        if not self._creds.valid:
            self._creds.refresh(Request())
        return self._creds.token

    async def send(self, data: dict[str, str]) -> None:
        if not self.enabled or not self.tokens:
            return
        import aiohttp
        try:
            bearer = await asyncio.to_thread(self._access_token)
        except Exception as exc:
            logger.warning("[dots] FCM auth failed: %s", exc)
            return
        url = f"https://fcm.googleapis.com/v1/projects/{self._creds.project_id}/messages:send"
        stale: list[str] = []
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as session:
            for token in list(self.tokens):
                body = {"message": {"token": token, "data": data, "android": {"priority": "high", "ttl": "86400s"}}}
                try:
                    async with session.post(url, json=body, headers={"Authorization": f"Bearer {bearer}"}) as resp:
                        if resp.status == 200:
                            continue
                        text = await resp.text()
                        # UNREGISTERED (404) / invalid token (400): app reinstalled or token rotated.
                        if resp.status == 404 or "UNREGISTERED" in text or "registration token" in text:
                            stale.append(token)
                        else:
                            logger.warning("[dots] FCM send failed (%d): %s", resp.status, text[:300])
                except Exception as exc:
                    logger.warning("[dots] FCM send error: %s", exc)
        if stale:
            self.tokens = [t for t in self.tokens if t not in stale]
            self._store.write_text(json.dumps(self.tokens), encoding="utf-8")


class DotsAdapter(BasePlatformAdapter):
    """aiohttp WebSocket server; every authenticated socket receives the conversation live."""

    MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH

    def __init__(self, config: PlatformConfig):
        super().__init__(config=config, platform=Platform("dots"))
        extra = config.extra or {}
        self._token = _token(extra)
        self._web_origins = _web_origins(extra)
        self._agent_id, self._agent_name = _agent_identity(extra)
        self._host, self._port = _parse_bind(_extra_or_secret(extra, "bind", "DOTS_BIND", DEFAULT_BIND))
        self._history = _History(get_hermes_home() / "platforms" / "dots" / "history.db")
        self._dots = _Dots(get_hermes_home() / "platforms" / "dots" / "dots.json")
        self._history.route = self._outward
        self._usage = _Usage(get_hermes_home() / "platforms" / "dots" / "usage.db", get_hermes_home() / "state.db")
        self._usage_task: Optional[asyncio.Task] = None
        # Group rooms: host chat -> running debate; synthetic message id -> its end of processing;
        # speaker session -> last history seq it has read.
        self._rooms: dict[str, asyncio.Task] = {}
        self._room_waiters: dict[str, asyncio.Future] = {}
        self._room_seen: dict[str, int] = {}
        self._room_current: dict[str, str] = {}  # host chat -> session speaking now (a speaker's, or the host's)
        self._dedup = MessageDeduplicator(max_size=1000, ttl_seconds=600)
        # Last acks by client_id: an app that lost an ack in a disconnect and sends again gets it back.
        self._acks: dict[str, dict[str, Any]] = {}
        self._runner: Optional["web.AppRunner"] = None
        # Every connected app (phone, quick reply from a notification, a second device, a browser): each
        # one says whether it is on screen and whether it watches the browser; ``web`` is the id of a
        # browser's web token (None for the phone, which holds DOTS_TOKEN).
        self._clients: dict["web.WebSocketResponse", dict[str, Any]] = {}
        self._activities: dict[str, str] = {}  # chat -> idle | thinking | typing
        self._approvals: dict[str, str] = {}  # approval_id -> session_key
        self._turns: dict[str, str] = {}  # chat -> id of the user message being answered
        self._tool_started: dict[str, float] = {}  # tool event id -> monotonic start
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        home = get_hermes_home() / "platforms" / "dots"
        # Language of the phone, from the last ``hello``: kept on disk so that a push sent after a
        # gateway restart, before the app reconnects, still speaks the right language.
        self._lang_file = home / "app_language"
        try:
            self._lang = _language(self._lang_file.read_text(encoding="utf-8"))
        except OSError:
            self._lang = DEFAULT_LANGUAGE
        creds = _extra_or_secret(extra, "fcm_credentials", "DOTS_FCM_CREDENTIALS", "") or str(home / "fcm-service-account.json")
        self._push_sender = _Push(Path(creds).expanduser(), home / "push_tokens.json")
        self._web_tokens = _WebTokens(home / "web_tokens.json")
        self._voice_dir = home / "voice"
        self._voice_dir.mkdir(parents=True, exist_ok=True)
        self._voice_turns: set[str] = set()  # user voice-message ids whose STT echo is still due
        self._files_dir = home / "files"
        self._files_dir.mkdir(parents=True, exist_ok=True)
        # Browser screen: task id of the last Dots browser tool, frames streamed while the app watches.
        self._browser_task: Optional[str] = None
        self._screen_task: Optional[asyncio.Task] = None
        self._screen_cdp: Any = None
        self._screen_sessions: dict[str, str] = {}  # page targetId -> attached CDP session
        self._screen_viewport = (1280, 720)
        # Takeover requests from the browser_request_takeover tool: id -> (event, owner's note).
        self._takeovers: dict[str, tuple[threading.Event, list[str]]] = {}  # CSS size of the last captured page, for input mapping

    # -- Lifecycle -------------------------------------------------------------------------------

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not AIOHTTP_AVAILABLE or not self._token:
            logger.warning("[%s] aiohttp missing or DOTS_TOKEN unset", self.name)
            return False
        app = web.Application()
        app.router.add_get(WS_PATH, self._handle_ws)
        app.router.add_post(SEND_PATH, self._handle_local_send)
        app.router.add_get("/dots/health", lambda _req: web.json_response({"ok": True, "agent_id": self._agent_id}))
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        try:
            await web.TCPSite(self._runner, self._host, self._port).start()
        except OSError as exc:
            logger.error("[%s] Cannot bind %s:%d: %s", self.name, self._host, self._port, exc)
            await self._runner.cleanup()
            self._runner = None
            return False
        self._loop = asyncio.get_running_loop()
        self._mark_connected()
        self._wire_plugin_handlers(None)
        _set_live_adapter(self)
        self._usage_task = asyncio.create_task(self._usage_loop())
        logger.info("[%s] Listening on %s:%d%s as agent %r (%s, push %s)", self.name, self._host, self._port, WS_PATH,
                    self._agent_name, self._agent_id, "on" if self._push_sender.enabled else "off")
        return True

    async def disconnect(self) -> None:
        self._running = False
        _set_live_adapter(None)
        self._mark_disconnected()
        if self._usage_task is not None:
            self._usage_task.cancel()
            self._usage_task = None
        for ws in list(self._clients):
            if not ws.closed:
                await ws.close()
        self._clients.clear()
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None
        logger.info("[%s] Disconnected", self.name)

    # -- HTTP / WebSocket ------------------------------------------------------------------------

    def _authorized(self, request: "web.Request") -> bool:
        """The master token in ``Authorization`` (the phone, the loopback cron sender)."""
        header = request.headers.get("Authorization", "")
        supplied = header[7:].strip() if header.lower().startswith("bearer ") else ""
        return bool(supplied) and hmac.compare_digest(supplied, self._token)

    @staticmethod
    def _offered_web_token(request: "web.Request") -> Optional[str]:
        """The web token a browser offers as a ``dots.token.<token>`` subprotocol, if any."""
        offered = [p.strip() for p in request.headers.get("Sec-WebSocket-Protocol", "").split(",")]
        return next((p[len(WEB_TOKEN_PROTOCOL):] for p in offered if p.startswith(WEB_TOKEN_PROTOCOL)), None)

    async def _handle_ws(self, request: "web.Request") -> "web.StreamResponse":
        # Browsers always send Origin, native apps don't: a page that is not the owner's web app cannot
        # open a socket from someone's browser, whatever it holds.
        origin = request.headers.get("Origin")
        if origin is not None and _origin(origin) not in self._web_origins:
            logger.warning("[%s] Refused socket from origin %r (see DOTS_WEB_ORIGINS)", self.name, origin)
            return web.json_response({"type": "error", "code": "origin_not_allowed"}, status=403)
        web_token = self._offered_web_token(request)
        web_session: Optional[str] = None
        if web_token is None:
            if not self._authorized(request):
                return web.json_response({"type": "error", "code": "unauthorized"}, status=401)
        else:
            web_session = self._web_tokens.check(web_token)
        ws = web.WebSocketResponse(heartbeat=30.0, max_msg_size=MAX_FILE_BYTES * 4 // 3 + (64 << 10),
                                   protocols=(WEB_SUBPROTOCOL,) if web_token is not None else ())
        await ws.prepare(request)
        if web_token is not None and web_session is None:
            await ws.send_str(json.dumps({"type": "error", "code": "unauthorized"}))
            await ws.close(code=WEB_UNAUTHORIZED, message=b"unauthorized")
            return ws
        self._clients[ws] = {"foreground": True, "watch": False, "takeover": False, "web": web_session}
        logger.info("[%s] %s connected (%d open)", self.name, "Browser" if web_session else "App", len(self._clients))
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    frame = json.loads(msg.data)
                except json.JSONDecodeError:
                    await self._push({"type": "error", "code": "bad_json"}, ws)
                    continue
                await self._on_frame(frame, ws)
        finally:
            self._clients.pop(ws, None)
            logger.info("[%s] App disconnected (%d open)", self.name, len(self._clients))
        return ws

    async def _handle_local_send(self, request: "web.Request") -> "web.Response":
        """Loopback endpoint used by the out-of-process cron sender."""
        if request.remote not in ("127.0.0.1", "::1") or not self._authorized(request):
            return web.json_response({"ok": False}, status=403)
        body = await request.json()
        result = await self.send(OWNER, str(body.get("text", "")))
        return web.json_response({"ok": result.success, "message_id": result.message_id})

    @property
    def _foreground(self) -> bool:
        """At least one app is on screen: the owner sees messages live, no push needed."""
        return any(c["foreground"] for c in self._clients.values())

    @property
    def _screen_watch(self) -> bool:
        return any(c["watch"] for c in self._clients.values())

    async def _push(self, frame: dict[str, Any], ws: Optional["web.WebSocketResponse"] = None) -> None:
        """To one app (reply to its request) or to all of them (conversation events)."""
        frame = self._outward(frame)
        targets = [ws] if ws is not None else list(self._clients)
        if not targets:
            return
        text = json.dumps(frame, ensure_ascii=False)
        for target in targets:
            if target.closed:
                continue
            try:
                await target.send_str(text)
            except (ConnectionResetError, RuntimeError) as exc:
                logger.debug("[%s] Push failed: %s", self.name, exc)

    async def _ack(self, frame: dict[str, Any], ws: "web.WebSocketResponse") -> None:
        self._acks[frame["client_id"]] = frame
        if len(self._acks) > 1000:
            self._acks.pop(next(iter(self._acks)))
        await self._push(frame, ws)

    async def _is_duplicate(self, client_id: str, ws: "web.WebSocketResponse") -> bool:
        """A message already received (retry after a lost ack): send its ack again, don't handle it twice."""
        if not self._dedup.is_duplicate(client_id):
            return False
        if client_id in self._acks:
            await self._push(self._acks[client_id], ws)
        return True

    async def _push_others(self, frame: dict[str, Any], sender: "web.WebSocketResponse") -> None:
        """An owner message to every app but the one that typed it (which already has it, acked): the
        phone sees what was written in the browser, live, and the other way round."""
        for ws in list(self._clients):
            if ws is not sender:
                await self._push(frame, ws)

    async def _on_frame(self, frame: dict[str, Any], ws: "web.WebSocketResponse") -> None:
        kind = frame.get("type")
        if kind == "hello":
            self._clients[ws]["foreground"] = bool(frame.get("foreground", True))
            if frame.get("lang"):
                self._set_language(frame["lang"])
            if frame.get("push_token") and self._clients[ws].get("web") is None:
                self._push_sender.register(str(frame["push_token"]))
            last_seq = int(frame.get("last_seq") or 0)
            if last_seq > 0:
                history, reset = self._history.since(last_seq)
                has_more = reset
            else:
                (history, has_more), reset = self._history.page(OWNER, None, INITIAL_PAGE), True
            activities, speakers = self._public_activities()
            await self._push({
                "type": "welcome", "agent": self._agent_name, "agent_id": self._agent_id, "seq": self._history.seq, "activity": activities.get(OWNER, "idle"),
                "activities": activities, "speakers": speakers, "history": history, "reset": reset, "has_more": has_more,
                "dots": self._dots_payload(),
            }, ws)
        elif kind == "message":
            await self._on_user_message(frame, ws)
        elif kind == "voice":
            await self._on_user_voice(frame, ws)
        elif kind == "history_page":
            chat = self._chat_of(frame)
            before = int(frame.get("before_seq") or 0) or None
            events, has_more = self._history.page(chat, before, min(int(frame.get("limit") or 80), MAX_PAGE))
            await self._push({"type": "history_page", "chat": chat, "before_seq": before, "events": events, "has_more": has_more}, ws)
        elif kind == "dot_create":
            dot = self._dots.create(frame.get("dot") or {})
            await self._push({"type": "dot_created", "id": dot["id"], "ref": frame.get("ref")}, ws)
            await self._push_dots()
        elif kind == "dot_update":
            if self._dots.update(str(frame.get("id") or ""), frame.get("dot") or {}):
                await self._push_dots()
        elif kind == "dot_delete":
            await self._delete_dot(str(frame.get("id") or ""))
        elif kind in ("audio_get", "file_get"):
            await self._send_stored(str(frame.get("id") or ""), ws, reply="audio" if kind == "audio_get" else "file_data")
        elif kind == "file":
            await self._on_user_file(frame, ws)
        elif kind == "screen_watch":
            self._clients[ws]["watch"] = bool(frame.get("on"))
            self._clients[ws]["takeover"] = bool(frame.get("takeover"))
            self._set_screen_watch()
        elif kind == "screen_input":
            await self._screen_input(frame)
        elif kind == "takeover_done":
            self._finish_takeover(str(frame.get("id") or ""), str(frame.get("note") or ""))
        elif kind == "activity_get":
            await self._push(await self._activity_snapshot(), ws)
        elif kind == "usage_get":
            await self._push(await self._usage_frame(frame), ws)
        elif kind == "cron_action":
            await self._cron_action(str(frame.get("id") or ""), str(frame.get("action") or ""))
            await self._push(await self._activity_snapshot(), ws)
        elif kind == "stop":
            chat = self._chat_of(frame)
            if not await self._cancel_room(chat):  # a debate stops as a whole, its current speaker included
                await self._stop_turn(chat)
        elif kind == "reaction":
            await self._on_user_reaction(frame)
        elif kind == "approval":
            await self._on_approval(frame)
        elif kind == "clarify":
            from tools.clarify_gateway import resolve_gateway_clarify
            resolve_gateway_clarify(str(frame.get("clarify_id", "")), str(frame.get("response", "")))
        elif kind == "presence":
            self._clients[ws]["foreground"] = bool(frame.get("foreground"))
        elif kind == "push_token":
            if self._clients[ws].get("web") is None:  # FCM tokens are the phone's business
                self._push_sender.register(str(frame.get("token") or ""))
        elif kind in ("web_token_create", "web_sessions_get", "web_revoke"):
            await self._on_web_session_frame(kind, frame, ws)
        else:
            await self._push({"type": "error", "code": "unknown_type"}, ws)

    # -- Web sessions (browsers paired by QR code) ----------------------------------------------

    async def _on_web_session_frame(self, kind: str, frame: dict[str, Any], ws: "web.WebSocketResponse") -> None:
        """Minting and revoking web tokens. Only the phone (master token) may mint or list them; a
        browser may only revoke its own session (logging out)."""
        own = self._clients[ws].get("web")
        if kind == "web_revoke":
            session_id = str(frame.get("id") or own or "")
            if own is not None and session_id != own:
                await self._push({"type": "error", "code": "forbidden"}, ws)
                return
            if self._web_tokens.revoke(session_id):
                for client, state in list(self._clients.items()):
                    if state.get("web") == session_id and not client.closed:
                        await client.close(code=WEB_UNAUTHORIZED, message=b"revoked")
            if own is None:
                await self._push({"type": "web_sessions", "sessions": self._web_tokens.public()}, ws)
            return
        if own is not None:
            await self._push({"type": "error", "code": "forbidden"}, ws)
            return
        if kind == "web_sessions_get":
            await self._push({"type": "web_sessions", "sessions": self._web_tokens.public()}, ws)
            return
        # web_token_create: the phone pairs a browser it scanned. The origin printed in the QR code
        # must be one this gateway trusts, or the browser could not connect anyway.
        origin = _origin(frame.get("origin"))
        if origin not in self._web_origins:
            await self._push({"type": "web_token", "ref": frame.get("ref"), "error": "origin_not_allowed",
                              "origin": origin}, ws)
            return
        token, session_id = self._web_tokens.create(str(frame.get("label") or "Browser"), origin)
        logger.info("[%s] Web session %s paired for %s", self.name, session_id, origin)
        await self._push({"type": "web_token", "ref": frame.get("ref"), "token": token, "id": session_id}, ws)

    # -- Chats (main dot + sub-dots) -------------------------------------------------------------

    def _chat_of(self, frame: dict[str, Any]) -> str:
        """Target chat of an app frame; anything unknown falls back to the main dot."""
        chat = str(frame.get("chat") or OWNER)
        return chat if chat == OWNER or self._dots.get(chat) else OWNER

    def _chat_name(self, chat: str) -> str:
        room = self._room_parts(chat)
        dot = self._dots.get(room[0] if room else chat)
        return dot["name"] if dot else "Hermes"

    def _dots_payload(self) -> list[dict[str, Any]]:
        return [{**d, "last_ts": self._history.last_ts(d["id"])} for d in self._dots.all()]

    async def _push_dots(self) -> None:
        await self._push({"type": "dots", "dots": self._dots_payload()})

    def _set_language(self, value: Any) -> None:
        lang = _language(value)
        if lang == self._lang:
            return
        self._lang = lang
        try:
            self._lang_file.write_text(lang, encoding="utf-8")
        except OSError as exc:
            logger.debug("[%s] app language not saved: %s", self.name, exc)

    def _t(self, key: str, **args: Any) -> str:
        return _text(self._lang, key, **args)

    def _channel_prompt(self, chat: str) -> Optional[str]:
        """A sub-dot's identity, as Hermes' per-channel prompt: applied on every call, never stored."""
        dot = self._dots.get(chat)
        if dot is None:
            return None
        mission = dot.get("mission") or self._t("default_mission")
        intro = (f"In this conversation you are \"{dot['name']}\", a sub-dot of the owner's main assistant: a separate, "
                 "focused conversation in the same Hermes app, with its own name and mascot. You keep your tools, "
                 f"memory and skills. Answer in {_LANGUAGE_NAMES[self._lang]} unless asked otherwise. ")
        if dot.get("kind") == "permanent":
            return intro + f"Your lasting specialization: {mission}. Stay in this role; for unrelated requests, " \
                           "suggest the owner asks the main dot instead."
        return intro + f"You are temporary, created for one mission: {mission}. Work on it until it is done, then " \
                       "say clearly that the mission is complete, so the owner can close this dot."

    def _source(self, chat: str, message_id: Optional[str] = None):
        return self.build_source(chat_id=chat, chat_name=self._chat_name(chat), chat_type="dm", user_id=OWNER,
                                 user_name=OWNER, message_id=message_id)

    async def _delete_dot(self, dot_id: str) -> None:
        """Close a sub-dot: interrupt its turn if any, drop its conversation, forget it."""
        if not self._dots.get(dot_id):
            return
        if self._activity_of(dot_id) != "idle":
            await self._stop_turn(dot_id)
        await self._cancel_room(dot_id)  # before it is forgotten: its speaker's words still land in its room
        self._dots.delete(dot_id)
        self._history.delete_chat(dot_id)
        self._activities.pop(dot_id, None)
        self._turns.pop(dot_id, None)
        for session in [s for s in self._room_seen if s.startswith(dot_id + ROOM_SEP) or s.endswith(ROOM_SEP + dot_id)]:
            self._room_seen.pop(session, None)
        await self._push({"type": "dot_deleted", "id": dot_id})
        await self._push_dots()

    async def _on_user_message(self, frame: dict[str, Any], ws: "web.WebSocketResponse") -> None:
        client_id = str(frame.get("client_id") or uuid.uuid4())
        text = str(frame.get("text") or "").strip()
        if not text or await self._is_duplicate(client_id, ws):
            return
        chat = self._chat_of(frame)
        speakers = self._room_speakers(chat, frame.get("room"))
        event = self._history.add({
            "type": "message", "id": uuid.uuid4().hex, "role": "user", "text": text, "ts": _now_ms(), "final": True, "chat": chat,
            **({"room": [d["id"] for d in speakers]} if speakers else {}),
        })
        await self._ack({"type": "ack", "client_id": client_id, "id": event["id"], "seq": event["seq"], "ts": event["ts"], "chat": chat}, ws)
        await self._push_others(event, ws)
        # A new message replaces a debate still running in this conversation.
        await self._cancel_room(chat, stop_host=False)
        if speakers:
            rounds = min(max(int(frame.get("rounds") or ROOM_ROUNDS), 1), ROOM_MAX_ROUNDS)
            self._rooms[chat] = asyncio.ensure_future(self._run_room(chat, event, speakers, rounds))
            return
        await self.handle_message(MessageEvent(
            text=text, message_type=MessageType.TEXT, source=self._source(chat, event["id"]), message_id=event["id"],
            raw_message=frame, timestamp=datetime.now(tz=UTC), channel_prompt=self._channel_prompt(chat)))

    # -- Group room (sub-dots invited into a conversation) ---------------------------------------

    def _room_parts(self, chat: Any) -> Optional[tuple[str, str]]:
        """``<dot>~<host>`` -> (speaking dot, conversation shown in the app); None for a plain chat."""
        if not isinstance(chat, str) or ROOM_SEP not in chat:
            return None
        dot, _, host = chat.partition(ROOM_SEP)
        return dot, host if host == OWNER or self._dots.get(host) else OWNER

    def _outward(self, event: dict[str, Any]) -> dict[str, Any]:
        """What a speaker says in its room session is stored and shown in the room, under its name."""
        room = self._room_parts(event.get("chat"))
        if room is None:
            return event
        # The name too: the room keeps showing who spoke after that sub-dot is closed.
        return {**event, "chat": room[1], "speaker": room[0], "speaker_name": self._chat_name(room[0])}

    def _room_speakers(self, host: str, ids: Any) -> list[dict[str, Any]]:
        """Sub-dots invited by the app, in its order: known, distinct, never the host itself."""
        if not isinstance(ids, list):
            return []
        speakers: list[dict[str, Any]] = []
        for dot_id in ids:
            dot = self._dots.get(str(dot_id))
            if dot and dot["id"] != host and dot not in speakers:
                speakers.append(dot)
        return speakers[:ROOM_MAX_SPEAKERS]

    def _public_activities(self) -> tuple[dict[str, str], dict[str, str]]:
        """Activity per conversation as the app knows them: a busy speaker makes its room busy."""
        activities = {chat: state for chat, state in self._activities.items() if self._room_parts(chat) is None}
        speakers: dict[str, str] = {}
        for chat, state in self._activities.items():
            room = self._room_parts(chat)
            if room and state != "idle":
                activities[room[1]], speakers[room[1]] = state, room[0]
        return activities, speakers

    async def _push_activity(self, chat: str, state: str) -> None:
        """Always sent (no change check): it also clears the speaker shown by the app."""
        self._activities[chat] = state
        await self._push({"type": "activity", "chat": chat, "state": state})

    async def _cancel_room(self, host: str, *, stop_host: bool = True) -> bool:
        """Stop the debate running in ``host``, and the turn of whoever is speaking. ``stop_host`` False:
        a new owner message replaces the debate, and that message already takes over the host's turn."""
        task = self._rooms.pop(host, None)
        if task is None or task.done():
            return False
        task.cancel()
        speaking = self._room_current.pop(host, host)
        if speaking != host:
            # Quiet from now on: a reply already on its way must not show its room as busy again.
            self._activities[speaking] = "idle"
        if speaking != host or stop_host:
            await self._stop_turn(speaking)
        return True

    def _room_lines(self, host: str, since: int, exclude: Optional[str] = None) -> str:
        """The room since ``since`` as a transcript, without what ``exclude`` said itself (it knows)."""
        lines = []
        for event in self._history.after(host, since, ROOM_CONTEXT_EVENTS):
            if event.get("type") != "message" or (exclude and event.get("speaker") == exclude):
                continue
            text = str(event.get("text") or event.get("transcript") or "").strip()
            if event.get("kind") == "file":
                text = f"[{event.get('name') or self._t('file')}] {text}".strip()
            if text:
                who = "Owner" if event.get("role") == "user" else self._chat_name(event.get("speaker") or host)
                lines.append(f"{who}: {text}")
        return "\n\n".join(lines) or "(nothing new)"

    def _room_prompt(self, dot: dict[str, Any], host: str, speakers: list[dict[str, Any]]) -> str:
        others = ", ".join(f"\"{d['name']}\"" for d in speakers if d["id"] != dot["id"]) or "nobody else"
        mission = dot.get("mission") or self._t("default_mission")
        return (f"In this conversation you are \"{dot['name']}\", a sub-dot of the owner's assistant, taking part in a "
                f"group discussion in the Hermes app. \"{self._chat_name(host)}\" moderates it and will conclude; the "
                f"other participants are {others}. Your specialty: {mission}. Speak only as yourself, in a few sentences: "
                "react to what the others just said, agree or disagree with reasons, add what your specialty brings, "
                "never repeat a point already made. No greeting, no heading, no sign-off. Use tools only when the "
                f"discussion really needs a fact. Answer in {_LANGUAGE_NAMES[self._lang]} unless asked otherwise.")

    async def _room_turn(self, chat: str, text: str, channel_prompt: Optional[str]) -> None:
        """One synthetic message to ``chat``'s session; returns once Hermes has finished answering it."""
        message_id = uuid.uuid4().hex
        done = asyncio.get_running_loop().create_future()
        self._room_waiters[message_id] = done
        try:
            await self.handle_message(MessageEvent(
                text=text, message_type=MessageType.TEXT, source=self._source(chat, message_id), message_id=message_id,
                raw_message={"type": "room"}, timestamp=datetime.now(tz=UTC), channel_prompt=channel_prompt))
            try:
                await asyncio.wait_for(asyncio.shield(done), ROOM_TURN_TIMEOUT_S)
            except asyncio.TimeoutError:
                logger.warning("[%s] Room speaker %s timed out", self.name, chat)
                await self._stop_turn(chat)
        finally:
            self._room_waiters.pop(message_id, None)

    async def _run_room(self, host: str, question: dict[str, Any], speakers: list[dict[str, Any]], rounds: int) -> None:
        """Each invited sub-dot speaks in turn for ``rounds`` rounds, seeing what the others said;
        then the host dot (the conversation's own) answers the owner with a conclusion."""
        current = host
        self._turns[host] = question["id"]
        await self._push({"type": "read", "id": question["id"]})
        await self._push_activity(host, "thinking")
        try:
            for round_no in range(1, rounds + 1):
                for dot in speakers:
                    if not self._dots.get(dot["id"]):  # closed during the debate
                        continue
                    current = self._room_current[host] = f"{dot['id']}{ROOM_SEP}{host}"
                    self._turns[current] = question["id"]
                    lines = self._room_lines(host, self._room_seen.get(current, question["seq"] - 1), exclude=dot["id"])
                    await self._room_turn(current, f"[Group discussion · round {round_no}/{rounds}]\n\n{lines}\n\n"
                                                   f"Your turn, {dot['name']}.", self._room_prompt(dot, host, speakers))
                    self._room_seen[current] = self._history.seq
                    self._turns.pop(current, None)
            current = self._room_current[host] = host
            names = ", ".join(d["name"] for d in speakers)
            await self._push_activity(host, "thinking")  # the host speaks now: no speaker shown any more
            await self._room_turn(host, f"[Group discussion with {names}; you moderate it]\n\n"
                                        f"{self._room_lines(host, question['seq'] - 1)}\n\n"
                                        "The discussion is over: now answer the owner yourself. Synthesize what matters, "
                                        "settle the disagreements and give a clear conclusion or next step, briefly, "
                                        "without repeating each participant.", self._channel_prompt(host))
        except asyncio.CancelledError:
            # _cancel_room already stopped the speaker; a debate that replaces this one sets its own activity.
            if host not in self._rooms:
                await self._push_activity(host, "idle")
            raise
        except Exception:
            logger.exception("[%s] Group room failed", self.name)
            await self._push_activity(host, "idle")
        finally:
            if self._turns.get(host) == question["id"]:
                self._turns.pop(host, None)
            if current != host:
                self._turns.pop(current, None)
            if self._rooms.get(host) is asyncio.current_task():
                self._rooms.pop(host, None)
                self._room_current.pop(host, None)

    async def _on_user_voice(self, frame: dict[str, Any], ws: "web.WebSocketResponse") -> None:
        """Voice note: stored on disk, replayable by the app, handed to Hermes as a VOICE event
        so the gateway's own STT pipeline transcribes it before the agent sees it."""
        client_id = str(frame.get("client_id") or uuid.uuid4())
        mime = str(frame.get("mime") or "audio/mp4")
        if await self._is_duplicate(client_id, ws) or mime not in VOICE_TYPES:
            return
        try:
            data = base64.b64decode(str(frame.get("audio") or ""), validate=True)
        except (ValueError, TypeError):
            data = b""
        if not data or len(data) > MAX_VOICE_BYTES:
            await self._push({"type": "error", "code": "bad_voice", "client_id": client_id}, ws)
            return
        chat = self._chat_of(frame)
        event_id = uuid.uuid4().hex
        path = self._voice_dir / f"{event_id}{VOICE_TYPES[mime]}"
        path.write_bytes(data)
        waveform = [round(min(max(float(v), 0.0), 1.0), 3) for v in (frame.get("waveform") or [])[:64]]
        event = self._history.add({
            "type": "message", "id": event_id, "role": "user", "kind": "voice", "text": "", "ts": _now_ms(), "chat": chat,
            "final": True, "audio": path.name, "mime": mime, "duration_ms": int(frame.get("duration_ms") or 0),
            "waveform": waveform,
        })
        await self._ack({"type": "ack", "client_id": client_id, "id": event_id, "seq": event["seq"], "ts": event["ts"]}, ws)
        await self._push_others(event, ws)
        self._voice_turns.add(event_id)
        await self.handle_message(MessageEvent(
            text="", message_type=MessageType.VOICE, source=self._source(chat, event_id), message_id=event_id,
            media_urls=[str(path)], media_types=[mime], raw_message={"type": "voice"},
            timestamp=datetime.now(tz=UTC), channel_prompt=self._channel_prompt(chat)))

    def _stored_path(self, event: dict[str, Any]) -> Optional[Path]:
        """File behind a voice note or attachment event, confined to the plugin's own folders."""
        for key, folder in (("audio", self._voice_dir), ("file", self._files_dir)):
            if event.get(key):
                path = folder / str(event[key])
                return path if path.parent == folder and path.exists() else None
        return None

    async def _send_stored(self, event_id: str, ws: "web.WebSocketResponse", reply: str) -> None:
        """The app fetches a voice note or attachment it does not have locally (other device, reinstall)."""
        event = self._history.get(event_id)
        path = self._stored_path(event) if event else None
        if path is None:
            await self._push({"type": reply, "id": event_id, "error": "not_found"}, ws)
            return
        data = await asyncio.to_thread(path.read_bytes)
        await self._push({"type": reply, "id": event_id, "mime": event.get("mime", "application/octet-stream"),
                          "name": event.get("name", path.name), "data": base64.b64encode(data).decode("ascii")}, ws)

    # -- Attachments -------------------------------------------------------------------------------

    async def _on_user_file(self, frame: dict[str, Any], ws: "web.WebSocketResponse") -> None:
        """Photo or document from the app: kept for replay, cached the Hermes way for the agent."""
        from gateway.platforms.base import cache_media_bytes
        client_id = str(frame.get("client_id") or uuid.uuid4())
        if await self._is_duplicate(client_id, ws):
            return
        name = Path(str(frame.get("name") or "fichier")).name[:120] or "fichier"
        mime = str(frame.get("mime") or "application/octet-stream")
        try:
            data = base64.b64decode(str(frame.get("data") or ""), validate=True)
        except (ValueError, TypeError):
            data = b""
        if not data or len(data) > MAX_FILE_BYTES:
            await self._push({"type": "error", "code": "bad_file", "client_id": client_id}, ws)
            return
        cached = await asyncio.to_thread(cache_media_bytes, data, filename=name, mime_type=mime)
        if cached is None:  # an image Hermes refuses (corrupt / unsupported)
            await self._push({"type": "error", "code": "bad_file", "client_id": client_id}, ws)
            return
        caption = str(frame.get("caption") or "").strip()
        chat = self._chat_of(frame)
        event_id = uuid.uuid4().hex
        stored = self._files_dir / f"{event_id}{Path(name).suffix[:10]}"
        await asyncio.to_thread(stored.write_bytes, data)
        event = self._history.add({
            "type": "message", "id": event_id, "role": "user", "kind": "file", "text": caption, "ts": _now_ms(), "chat": chat,
            "final": True, "file": stored.name, "name": name, "mime": cached.media_type or mime,
            "media": cached.kind, "size": len(data),
        })
        await self._ack({"type": "ack", "client_id": client_id, "id": event_id, "seq": event["seq"], "ts": event["ts"]}, ws)
        await self._push_others(event, ws)
        await self.handle_message(MessageEvent(
            text=caption, message_type=_MEDIA_MESSAGE_TYPES.get(cached.kind, MessageType.DOCUMENT), source=self._source(chat, event_id),
            message_id=event_id, media_urls=[str(cached.path)], media_types=[event["mime"]], media_text_inlined=[False],
            raw_message={"type": "file", "name": name}, timestamp=datetime.now(tz=UTC), channel_prompt=self._channel_prompt(chat)))

    async def _send_file(self, path: Optional[str], caption: Optional[str], *, name: Optional[str] = None,
                         data: Optional[bytes] = None, mime: Optional[str] = None, voice: bool = False,
                         chat: str = OWNER) -> SendResult:
        """Agent → app: any file the agent produced, shown as an image, a voice note or a file card."""
        import mimetypes
        try:
            if data is None:
                data = await asyncio.to_thread(Path(str(path)).expanduser().read_bytes)
        except OSError as exc:
            return SendResult(success=False, error=f"unreadable file: {exc}")
        if len(data) > MAX_FILE_BYTES:
            return await self.send(chat, f"{caption or ''}\n{self._t('file_too_big', mb=len(data) // 1_048_576)}".strip())
        name = Path(name or str(path or self._t("file"))).name
        mime = mime or mimetypes.guess_type(name)[0] or "application/octet-stream"
        event_id = uuid.uuid4().hex
        if voice:
            stored = self._voice_dir / f"{event_id}{Path(name).suffix or '.ogg'}"
            fields = {"kind": "voice", "audio": stored.name, "duration_ms": _audio_duration_ms(data)}
        else:
            stored = self._files_dir / f"{event_id}{Path(name).suffix[:10]}"
            fields = {"kind": "file", "file": stored.name, "media": mime.split("/")[0], "size": len(data)}
        await asyncio.to_thread(stored.write_bytes, data)
        event = self._history.add({
            "type": "message", "id": event_id, "role": "agent", "turn": self._turns.get(chat), "chat": chat, "text": caption or "",
            "ts": _now_ms(), "final": True, "name": name, "mime": mime, **fields,
        })
        await self._push(event)
        self._notify("message", event_id, caption or (self._t("voice_message") if voice else f"📎 {name}"), chat)
        if self._activity_of(chat) != "idle":
            await self._set_activity(chat, "typing")
        return SendResult(success=True, message_id=event_id)

    async def send_image_file(self, chat_id: str, image_path: str, caption: Optional[str] = None,
                              reply_to: Optional[str] = None, metadata: Optional[dict[str, Any]] = None, **kwargs) -> SendResult:
        return await self._send_file(image_path, caption, chat=self._known(chat_id))

    async def send_document(self, chat_id: str, file_path: str, caption: Optional[str] = None,
                            file_name: Optional[str] = None, reply_to: Optional[str] = None,
                            metadata: Optional[dict[str, Any]] = None, **kwargs) -> SendResult:
        return await self._send_file(file_path, caption, name=file_name, chat=self._known(chat_id))

    async def send_video(self, chat_id: str, video_path: str, caption: Optional[str] = None,
                         reply_to: Optional[str] = None, metadata: Optional[dict[str, Any]] = None, **kwargs) -> SendResult:
        return await self._send_file(video_path, caption, chat=self._known(chat_id))

    async def send_voice(self, chat_id: str, audio_path: str, caption: Optional[str] = None,
                         reply_to: Optional[str] = None, metadata: Optional[dict[str, Any]] = None, **kwargs) -> SendResult:
        return await self._send_file(audio_path, caption, voice=True, chat=self._known(chat_id))

    async def send_image(self, chat_id: str, image_url: str, caption: Optional[str] = None,
                         reply_to: Optional[str] = None, metadata: Optional[dict[str, Any]] = None) -> SendResult:
        """Remote image: downloaded once so the app shows it like any other attachment."""
        if image_url.startswith("file://"):
            return await self._send_file(image_url[7:], caption, chat=self._known(chat_id))
        import aiohttp
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as session:
                async with session.get(image_url) as resp:
                    resp.raise_for_status()
                    data = await resp.content.read(MAX_FILE_BYTES + 1)
                    mime = resp.headers.get("Content-Type", "image/jpeg").split(";")[0]
        except Exception as exc:
            logger.info("[%s] image download failed (%s), sending the link", self.name, exc)
            return await self.send(chat_id, f"{caption}\n{image_url}" if caption else image_url)
        name = Path(image_url.split("?")[0]).name or "image.jpg"
        return await self._send_file(None, caption, name=name, data=data, mime=mime, chat=self._known(chat_id))

    async def send_animation(self, chat_id: str, animation_url: str, caption: Optional[str] = None,
                             reply_to: Optional[str] = None, metadata: Optional[dict[str, Any]] = None) -> SendResult:
        return await self.send_image(chat_id, animation_url, caption)

    # -- Live browser screen -----------------------------------------------------------------------

    def browser_used(self, task_id: Optional[str]) -> None:
        """Called from the browser tool hooks: remember the session and show where it is."""
        if task_id:
            self._browser_task = task_id
        if not self._screen_watch:
            self.track_tool(self._push_one_frame())

    def _set_screen_watch(self) -> None:
        if self._screen_watch and (self._screen_task is None or self._screen_task.done()):
            self._screen_task = asyncio.ensure_future(self._stream_screen())

    def _capture_frame(self, scale: float) -> Optional[dict[str, Any]]:
        """One JPEG of the agent's page through Hermes' CDP seam for plugins (blocking: run in a thread)."""
        task_id = self._browser_task
        if not task_id:
            return None
        from tools.browser_supervisor import SUPERVISOR_REGISTRY
        from tools.browser_supervisor_capture import CapturedCDPInvalid
        try:
            cdp = self._screen_cdp
            if cdp is None or cdp.task_id != task_id or not cdp.is_valid():
                cdp = self._screen_cdp = SUPERVISOR_REGISTRY.capture(task_id, timeout=3)
                self._screen_sessions = {}
            session = self._visible_page_session(cdp)
            metrics = cdp.call("Page.getLayoutMetrics", session_id=session, timeout=4)["result"]
            view = metrics.get("cssVisualViewport") or metrics.get("layoutViewport") or {}
            width, height = int(view.get("clientWidth", 1280)), int(view.get("clientHeight", 720))
            self._screen_viewport = (width, height)
            shot = cdp.call("Page.captureScreenshot", {
                "format": "jpeg", "quality": 55, "optimizeForSpeed": True,
                "clip": {"x": view.get("pageX", 0), "y": view.get("pageY", 0), "width": width, "height": height, "scale": scale},
            }, session_id=session, timeout=6)["result"]
            history = cdp.call("Page.getNavigationHistory", session_id=session, timeout=4)["result"]
            entry = history["entries"][history["currentIndex"]]
            return {"data": shot["data"], "url": entry.get("url", ""), "title": entry.get("title", ""),
                    "width": int(width * scale), "height": int(height * scale)}
        except (CapturedCDPInvalid, TimeoutError, RuntimeError, KeyError, IndexError, TypeError):
            self._screen_cdp = None
            return None

    def _visible_page_session(self, cdp: Any) -> str:
        """The supervisor is pinned to Chromium's first tab, often a blank new-tab page, while the
        agent browses in another one: pick the newest real page and attach to it (sessions cached)."""
        targets = cdp.call("Target.getTargets", timeout=4)["result"]["targetInfos"]
        pages = [t for t in targets if t.get("type") == "page"
                 and not str(t.get("url", "")).startswith(("chrome://", "about:blank", "devtools://"))]
        if not pages:
            return cdp.page_session_id
        target_id = pages[-1]["targetId"]
        sessions = self._screen_sessions
        if target_id not in sessions:
            reply = cdp.call("Target.attachToTarget", {"targetId": target_id, "flatten": True}, timeout=4)
            sessions[target_id] = reply["result"]["sessionId"]
            self._screen_sessions = sessions
        return sessions[target_id]

    async def _screen_input(self, frame: dict[str, Any]) -> None:
        """The owner drives the agent's page from the app (login, captcha, cookie wall…).
        Coordinates arrive as fractions of the image and map onto the CSS viewport."""
        ok = await asyncio.to_thread(self._dispatch_input, frame)
        if ok and not self._screen_watch:
            await self._push_one_frame()

    def _dispatch_input(self, frame: dict[str, Any]) -> bool:
        cdp = self._screen_cdp
        if cdp is None or not cdp.is_valid():
            logger.info("[%s] screen input ignored: no live browser page", self.name)
            return False
        from tools.browser_supervisor_capture import CapturedCDPInvalid
        width, height = self._screen_viewport
        x = min(max(float(frame.get("x") or 0), 0.0), 1.0) * width
        y = min(max(float(frame.get("y") or 0), 0.0), 1.0) * height
        action = frame.get("action")
        try:
            session = self._visible_page_session(cdp)
            mouse = {"x": x, "y": y, "button": "left", "clickCount": 1}
            if action == "click":
                cdp.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y}, session_id=session, timeout=4)
                cdp.call("Input.dispatchMouseEvent", {"type": "mousePressed", **mouse}, session_id=session, timeout=4)
                cdp.call("Input.dispatchMouseEvent", {"type": "mouseReleased", **mouse}, session_id=session, timeout=4)
            elif action == "scroll":
                cdp.call("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": x, "y": y, "deltaX": 0,
                                                      "deltaY": float(frame.get("dy") or 0) * height}, session_id=session, timeout=4)
            elif action == "type" and frame.get("text"):
                cdp.call("Input.insertText", {"text": str(frame["text"])[:2000]}, session_id=session, timeout=4)
            elif action == "key" and frame.get("key") in _KEYS:
                key, code, vk, text = _KEYS[frame["key"]]
                down = {"type": "keyDown", "key": key, "code": code, "windowsVirtualKeyCode": vk}
                if text:
                    down["text"] = text
                cdp.call("Input.dispatchKeyEvent", down, session_id=session, timeout=4)
                cdp.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": key, "code": code, "windowsVirtualKeyCode": vk},
                         session_id=session, timeout=4)
            else:
                return False
            return True
        except (CapturedCDPInvalid, TimeoutError, RuntimeError, KeyError) as exc:
            logger.info("[%s] screen input failed: %s", self.name, exc)
            return False

    # -- Takeover requests (browser_request_takeover tool) ----------------------------------------

    async def open_takeover(self, takeover_id: str, reason: str, chat: str = OWNER) -> None:
        """A card in the conversation with a button straight into the live screen, plus a push."""
        event = self._history.add({
            "type": "message", "id": takeover_id, "role": "agent", "turn": self._turns.get(chat), "kind": "takeover", "chat": chat,
            "text": reason, "ts": _now_ms(), "final": True, "status": "pending",
        })
        await self._push(event)
        self._notify("takeover", takeover_id, f"🖐️ {reason}", chat)

    def _finish_takeover(self, takeover_id: str, note: str) -> None:
        waiting = self._takeovers.get(takeover_id)
        if waiting is None:
            return
        waiting[1].append(note)
        waiting[0].set()
        self._history.update(takeover_id, status="done")
        asyncio.ensure_future(self._push({"type": "takeover_done", "id": takeover_id}))

    def wait_for_takeover(self, reason: str, chat: str = OWNER) -> str:
        """Runs on the agent's worker thread: the turn (and its browser) stays open meanwhile."""
        takeover_id = uuid.uuid4().hex
        done, notes = threading.Event(), []
        self._takeovers[takeover_id] = (done, notes)
        self.track_tool(self.open_takeover(takeover_id, reason, chat))
        try:
            if not done.wait(TAKEOVER_TIMEOUT_S):
                self.track_tool(self._expire_takeover(takeover_id))
                return json.dumps({"status": "timeout", "message": "The owner did not take over within 15 minutes."})
            note = (notes[0] if notes else "").strip()
            return json.dumps({"status": "done", "message": "The owner finished on your browser and handed it back."
                               + (f" Their note: {note}" if note else "") + " Check the page state before continuing."})
        finally:
            self._takeovers.pop(takeover_id, None)

    async def _expire_takeover(self, takeover_id: str) -> None:
        self._history.update(takeover_id, status="expired")
        await self._push({"type": "takeover_done", "id": takeover_id, "expired": True})

    async def _push_one_frame(self) -> None:
        frame = await asyncio.to_thread(self._capture_frame, 0.4)
        if frame:
            await self._push({"type": "screen_frame", "live": False, "ts": _now_ms(), **frame})

    async def _stream_screen(self) -> None:
        """Frames while the app watches; a quieter poll while no browser runs (it may start any moment)."""
        idle_sent = False
        while self._screen_watch:
            frame = await asyncio.to_thread(self._capture_frame, SCREEN_SCALE)
            if frame:
                idle_sent = False
                await self._push({"type": "screen_frame", "live": True, "ts": _now_ms(), **frame})
                takeover = any(c.get("takeover") for c in self._clients.values())
                await asyncio.sleep(TAKEOVER_FPS_DELAY if takeover else SCREEN_FPS_DELAY)
            else:
                if not idle_sent:
                    await self._push({"type": "screen_idle"})
                    idle_sent = True
                await asyncio.sleep(1.5)

    # -- Activity ----------------------------------------------------------------------------------

    async def _activity_snapshot(self) -> dict[str, Any]:
        def crons() -> list[dict[str, Any]]:
            try:
                from cron.jobs import list_jobs
                jobs = list_jobs(include_disabled=True)
            except Exception as exc:
                logger.debug("[dots] cron listing failed: %s", exc)
                return []
            return [{
                "id": j.get("id"), "name": j.get("name") or "Tâche", "schedule": j.get("schedule_display") or "",
                "state": j.get("state") or "", "enabled": bool(j.get("enabled")), "next_run_at": j.get("next_run_at"),
                "last_run_at": j.get("last_run_at"), "last_status": j.get("last_status"), "deliver": j.get("deliver") or "",
                "prompt": str(j.get("prompt") or "")[:400],
            } for j in jobs]
        return {"type": "activity_snapshot", "crons": await asyncio.to_thread(crons), "turn": self._turns.get(OWNER),
                "state": self._activity_of(OWNER), "turns": self._turns, "browser": self._browser_task is not None}

    async def _usage_loop(self) -> None:
        """Samples the token totals every few minutes, so that each hour gets what was spent in it."""
        while True:
            try:
                await asyncio.to_thread(self._usage.sample)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("[dots] usage sampling failed", exc_info=True)
            await asyncio.sleep(USAGE_SAMPLE_S)

    async def _usage_frame(self, frame: dict[str, Any]) -> dict[str, Any]:
        """Tokens and messages per UTC hour in [from, to): the app sums them into days of its own time zone."""
        now_ms = _now_ms()
        try:
            end = min(int(frame.get("to") or now_ms), now_ms + 3_600_000)
            start = max(int(frame.get("from") or 0), end - USAGE_MAX_WINDOW_MS)
        except (TypeError, ValueError):
            end, start = now_ms, now_ms - USAGE_MAX_WINDOW_MS
        if end > now_ms - USAGE_SAMPLE_S * 1000:  # the window reaches today: count what was spent since the last sample
            try:
                await asyncio.to_thread(self._usage.sample)
            except Exception:
                logger.warning("[dots] usage sampling failed", exc_info=True)
        tokens = await asyncio.to_thread(self._usage.tokens_per_hour, start, end)
        messages = self._history.messages_per_hour(start, end)
        hours = sorted(set(tokens) | set(messages))
        return {"type": "usage", "from": start, "to": end,
                "hours": [[h, tokens.get(h, 0), messages.get(h, 0)] for h in hours]}

    async def _cron_action(self, job_id: str, action: str) -> None:
        from cron import jobs
        fn = {"pause": jobs.pause_job, "resume": jobs.resume_job, "run": jobs.trigger_job}.get(action)
        if fn and job_id:
            await asyncio.to_thread(fn, job_id)

    async def _stop_turn(self, chat: str = OWNER) -> None:
        """Same as typing /stop in that chat: Hermes interrupts its running turn. Not written to the conversation."""
        await self.handle_message(MessageEvent(text="/stop", message_type=MessageType.TEXT, source=self._source(chat),
                                               message_id=uuid.uuid4().hex, timestamp=datetime.now(tz=UTC)))

    async def _attach_transcript(self, chat: str, content: str) -> bool:
        """Turn Hermes' STT echo into the voice bubble's caption; True when it was one."""
        match = _TRANSCRIPT_ECHO.match(content or "")
        turn = self._turns.get(chat)
        if not match or turn not in self._voice_turns:
            return False
        text = match.group("text").strip()
        self._history.update(turn, transcript=text)
        await self._push({"type": "transcript", "id": turn, "text": text})
        return True

    async def _on_user_reaction(self, frame: dict[str, Any]) -> None:
        message_id, emoji = str(frame.get("message_id", "")), frame.get("emoji")
        if self._reaction_handler is None or not message_id:
            return
        await self._reaction_handler({
            "platform": "dots", "event_name": "reaction:added" if emoji else "reaction:removed",
            "reaction": emoji or "", "user_id": OWNER, "item_user_id": "hermes", "channel_id": OWNER,
            "message_ts": message_id, "event_ts": str(time.time()), "raw_event": frame,
        })

    async def _on_approval(self, frame: dict[str, Any]) -> None:
        from tools.approval import resolve_gateway_approval
        approval_id, choice = str(frame.get("approval_id", "")), str(frame.get("choice", "deny"))
        session_key = self._approvals.pop(approval_id, None)
        if session_key is None or choice not in ("once", "session", "always", "deny"):
            return
        resolve_gateway_approval(session_key, choice)
        self._history.update(approval_id, resolved=choice)
        await self._push({"type": "approval_resolved", "approval_id": approval_id, "choice": choice})

    # -- Activity --------------------------------------------------------------------------------

    def _known(self, chat_id: Optional[str]) -> str:
        """Hermes' chat id for an outbound call; cron and unknown targets land in the main dot. A room
        speaker's session is kept as is: ``_outward`` files what it says under its room."""
        if chat_id and self._room_parts(chat_id) and self._dots.get(chat_id.partition(ROOM_SEP)[0]):
            return chat_id
        return chat_id if chat_id and (chat_id == OWNER or self._dots.get(chat_id)) else OWNER

    def _activity_of(self, chat: str) -> str:
        return self._activities.get(chat, "idle")

    async def _set_activity(self, chat: str, state: str) -> None:
        if state != self._activity_of(chat):
            self._activities[chat] = state
            await self._push({"type": "activity", "chat": chat, "state": state})

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        # Le gateway rafraîchit la frappe toutes les 2 s : « réfléchit » tant que rien n'est écrit.
        chat = self._known(chat_id)
        if self._activity_of(chat) == "idle":
            await self._set_activity(chat, "thinking")

    async def stop_typing(self, chat_id: str) -> None:
        # Appelé aussi en plein traitement (pause avant envoi) : seul on_processing_complete
        # repasse à « idle », sinon l'app afficherait « En ligne » avant la réponse.
        return None

    async def on_processing_start(self, event: MessageEvent) -> None:
        chat = self._known(event.source.chat_id if event.source else None)
        # Room turns are synthetic messages: their turn stays the owner's question, nothing to mark read.
        if event.message_id and event.message_id not in self._room_waiters:
            self._turns[chat] = event.message_id
            await self._push({"type": "read", "id": event.message_id})
        await self._set_activity(chat, "thinking")

    async def on_processing_complete(self, event: MessageEvent, outcome) -> None:
        await super().on_processing_complete(event, outcome)
        chat = self._known(event.source.chat_id if event.source else None)
        waiter = self._room_waiters.get(event.message_id or "")
        if waiter is not None and not waiter.done():
            waiter.set_result(None)
        if self._room_parts(chat):
            # A speaker is done; the debate goes on: its room stays busy, the next speaker takes over.
            self._activities[chat] = "idle"
        else:
            await self._set_activity(chat, "idle")
        # Calls without a tool_call_id (or interrupted ones) never get a post hook: close them here.
        for call_id in list(self._tool_started):
            await self.tool_finished(call_id, failed=False)
        self._voice_turns.discard(event.message_id or "")
        if event.message_id and self._turns.get(chat) == event.message_id:
            self._turns.pop(chat, None)

    # -- Tool trail (fed by the pre/post_tool_call hooks, from the agent thread) -----------------

    def track_tool(self, coro) -> None:
        """Hooks run on the agent's worker thread: hop onto the adapter loop, never block the tool."""
        loop = self._loop
        if loop is None or loop.is_closed():
            coro.close()
            return
        asyncio.run_coroutine_threadsafe(coro, loop)

    async def tool_started(self, call_id: str, name: str, args: Any, chat: str = OWNER) -> None:
        kind, label, detail = _describe_tool(name, args, self._lang)
        event_id = call_id or uuid.uuid4().hex
        self._tool_started[event_id] = time.monotonic()
        event = self._history.add({
            "type": "tool", "id": event_id, "turn": self._turns.get(chat), "chat": chat, "name": name, "kind": kind,
            "label": label, "detail": detail, "state": "running", "ts": _now_ms(),
        })
        await self._push(event)

    async def tool_finished(self, call_id: str, failed: bool) -> None:
        started = self._tool_started.pop(call_id, None)
        if started is None:
            return
        fields = {"state": "error" if failed else "done", "duration_ms": int((time.monotonic() - started) * 1000)}
        self._history.update(call_id, **fields)
        await self._push({"type": "tool_update", "id": call_id, **fields})

    # -- Push --------------------------------------------------------------------------------------

    def _notify(self, kind: str, event_id: str, body: str, chat: str = OWNER) -> None:
        """Push only when nobody is looking: no live socket, or the app is in the background."""
        if self._foreground:
            return
        if not self._push_sender.enabled or not self._push_sender.tokens or not body.strip():
            return
        # ``title`` is empty for the main dot: the app shows the name the owner gave it. A room speaker
        # (approval, question) is named, and the notification opens its room.
        room = self._room_parts(chat)
        title = "" if chat == OWNER else self._chat_name(chat)
        # ``agent``: one phone may be paired with several gateways (one per Hermes profile); the app
        # routes the notification, its reply and its approval buttons to this one.
        data = {"kind": kind, "id": event_id, "agent": self._agent_id, "chat": room[1] if room else chat, "title": title,
                "body": body[:PUSH_BODY_LIMIT], "ts": str(_now_ms())}
        asyncio.ensure_future(self._push_sender.send(data))

    _FAIL_EMOJI = "⚠️"

    async def _add_reaction(self, chat_id: str, message_id: str, emoji: str) -> None:
        await self._push({"type": "reaction", "message_id": message_id, "emoji": emoji})

    async def _remove_reaction(self, chat_id: str, message_id: str) -> None:
        await self._push({"type": "reaction", "message_id": message_id, "emoji": None})

    # -- Outbound --------------------------------------------------------------------------------

    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None,
                   metadata: Optional[dict[str, Any]] = None) -> SendResult:
        chat = self._known(chat_id)
        if await self._attach_transcript(chat, content):
            return SendResult(success=True, message_id=self._turns.get(chat))
        event = self._history.add({
            "type": "message", "id": uuid.uuid4().hex, "role": "agent", "turn": self._turns.get(chat), "chat": chat,
            "text": content[:MAX_MESSAGE_LENGTH], "ts": _now_ms(), "final": True,
        })
        await self._push(event)
        if not self._room_parts(chat):  # a debate would ring once per speaker: only its conclusion notifies
            self._notify("message", event["id"], content, chat)
        if self._activity_of(chat) != "idle":
            await self._set_activity(chat, "typing")
        return SendResult(success=True, message_id=event["id"])

    async def edit_message(self, chat_id: str, message_id: str, content: str, *, finalize: bool = False) -> SendResult:
        if self._history.update(message_id, text=content[:MAX_MESSAGE_LENGTH], final=finalize) is None:
            return SendResult(success=False, error="Unknown message")
        chat = self._known(chat_id)
        # A room speaker's last edit is not the end of the debate: its room keeps "typing" until the next one.
        await self._set_activity(chat, "idle" if finalize and not self._room_parts(chat) else "typing")
        await self._push({"type": "edit", "id": message_id, "text": content[:MAX_MESSAGE_LENGTH], "final": finalize})
        return SendResult(success=True, message_id=message_id)

    async def _send_exec_approval_prompt(self, prompt) -> SendResult:
        approval_id = uuid.uuid4().hex
        self._approvals[approval_id] = prompt.session_key
        chat = self._chat_from_session_key(prompt.session_key)
        event = self._history.add({
            "type": "approval", "id": approval_id, "approval_id": approval_id, "ts": _now_ms(), "turn": self._turns.get(chat), "chat": chat,
            "title": self._t("approval_title"), "command": prompt.command, "description": prompt.description,
            "actions": [{"label": label, "choice": choice, "style": style} for label, choice, style in prompt.actions],
        })
        await self._push(event)
        # The bare command: the app titles the notification itself, in the phone's language.
        self._notify("approval", approval_id, prompt.command, chat)
        return SendResult(success=True, message_id=approval_id)

    async def send_clarify(self, chat_id: str, question: str, choices: Optional[list], clarify_id: str,
                           session_key: str, metadata: Optional[dict[str, Any]] = None) -> SendResult:
        chat = self._known(chat_id)
        event = self._history.add({
            "type": "clarify", "id": clarify_id, "clarify_id": clarify_id, "ts": _now_ms(), "turn": self._turns.get(chat), "chat": chat,
            "question": question, "choices": [str(c) for c in (choices or [])],
        })
        if not choices:
            from tools.clarify_gateway import mark_awaiting_text
            mark_awaiting_text(clarify_id)
        await self._push(event)
        self._notify("clarify", clarify_id, question, chat)
        return SendResult(success=True, message_id=clarify_id)

    def _chat_from_session_key(self, session_key: str) -> str:
        """Session keys embed the chat id (``…:dots:dm:<chat>…``): find which dot asked."""
        parts = str(session_key or "").split(":")
        room = next((p for p in parts if self._room_parts(p)), None)
        if room:  # a room speaker's session: ``_outward`` shows its card in the room, under its name
            return self._known(room)
        return next((d["id"] for d in self._dots.all() if d["id"] in parts), OWNER)

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        chat = self._known(chat_id)
        return {"name": self._chat_name(chat), "type": "dm", "chat_id": chat}


def _audio_duration_ms(data: bytes) -> int:
    """Duration of an agent voice note (TTS), via PyAV which faster-whisper already ships."""
    try:
        import io

        import av
        with av.open(io.BytesIO(data)) as container:
            return int((container.duration or 0) / 1000)
    except Exception:
        return 0


# -- Tool hooks ------------------------------------------------------------------------------------

_live_adapter: Optional[DotsAdapter] = None


def _set_live_adapter(adapter: Optional[DotsAdapter]) -> None:
    global _live_adapter
    _live_adapter = adapter


def _dots_adapter_for_this_turn() -> Optional[DotsAdapter]:
    """The hooks are global (Discord too): only report tools of turns run for the Dots chat."""
    adapter = _live_adapter
    if adapter is None:
        return None
    from gateway.session_context import get_session_env
    return adapter if get_session_env("HERMES_SESSION_PLATFORM", "") == "dots" else None


def _current_chat() -> str:
    from gateway.session_context import get_session_env
    return get_session_env("HERMES_SESSION_CHAT_ID", "") or OWNER


def _on_pre_tool_call(tool_name: str = "", args: Any = None, tool_call_id: Optional[str] = None,
                      task_id: Optional[str] = None, **_: Any) -> None:
    adapter = _dots_adapter_for_this_turn()
    if adapter is not None and tool_name.startswith("browser_") and task_id:
        adapter._browser_task = task_id
    if adapter is not None and tool_name not in _HIDDEN_TOOLS:
        adapter.track_tool(adapter.tool_started(str(tool_call_id or ""), tool_name, args, adapter._known(_current_chat())))
    return None  # observer only: no directive for the tool dispatcher


def _on_post_tool_call(tool_name: str = "", tool_call_id: Optional[str] = None, status: Any = None,
                       error_type: Any = None, **_: Any) -> None:
    adapter = _dots_adapter_for_this_turn()
    if adapter is not None and tool_call_id:
        failed = bool(error_type) or str(status or "").lower() in {"error", "failed", "failure", "timeout"}
        adapter.track_tool(adapter.tool_finished(str(tool_call_id), failed))
    if adapter is not None and tool_name.startswith("browser_"):
        adapter.browser_used(_.get("task_id"))


_TAKEOVER_SCHEMA = {
    "name": "browser_request_takeover",
    "description": (
        "Hand your web browser to the owner from their phone (Dots app), then wait until they hand it "
        "back. Use it whenever the current page needs a human: login or password, 2FA code, captcha, "
        "consent or payment wall, anything you must not or cannot type yourself. Leave the browser on "
        "that page before calling. This call blocks (up to 15 min) and keeps your browser open; never "
        "ask for passwords in the chat instead."
    ),
    "parameters": {
        "type": "object",
        "properties": {"reason": {"type": "string", "description": "Short sentence, in the owner's language, telling them what to do on the page."}},
        "required": ["reason"],
    },
}


def _takeover_tool(args: dict, **_: Any) -> str:
    adapter = _dots_adapter_for_this_turn()
    if adapter is None:
        return json.dumps({"status": "unavailable", "message": "Takeover only works in the Dots app conversation."})
    return adapter.wait_for_takeover(str((args or {}).get("reason") or adapter._t("takeover_reason")),
                                     adapter._known(_current_chat()))


def _takeover_available() -> bool:
    return _live_adapter is not None


# -- Plugin registration ---------------------------------------------------------------------------


def _env_enablement() -> Optional[dict]:
    token = _get_scoped_secret("DOTS_TOKEN", "").strip()
    if not token:
        return None
    seed = _seed_extra_from_env((("DOTS_BIND", "bind", None),), home_env="DOTS_HOME_CHANNEL", home_default=OWNER)
    return {"token": token, **seed}


async def _standalone_send(pconfig, chat_id: str, message: str, *, thread_id: Optional[str] = None,
                           media_files: Optional[list[str]] = None, force_document: bool = False) -> dict[str, Any]:
    """Cron jobs run outside the gateway: hand the message to the live adapter over loopback."""
    import aiohttp
    extra = getattr(pconfig, "extra", {}) or {}
    host, port = _parse_bind(_extra_or_secret(extra, "bind", "DOTS_BIND", DEFAULT_BIND))
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(f"http://{host}:{port}{SEND_PATH}", json={"text": message},
                                    headers={"Authorization": f"Bearer {_token(extra)}"}, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                data = await resp.json()
        if not data.get("ok"):
            return send_error("dots standalone send refused")
        return {"success": True, "platform": "dots", "chat_id": OWNER, "message_id": data.get("message_id")}
    except Exception as exc:
        return send_error(f"dots standalone send failed: {exc}")


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("post_tool_call", _on_post_tool_call)
    # Toolset named after the platform: Hermes adds it to the implicit ``hermes-dots`` bundle, so the
    # tool is offered in Dots conversations only. Its browser_ prefix lets the screen hooks treat it as web.
    ctx.register_tool(name="browser_request_takeover", toolset="dots", schema=_TAKEOVER_SCHEMA,
                      handler=_takeover_tool, check_fn=_takeover_available, emoji="🖐️",
                      description=_TAKEOVER_SCHEMA["description"])
    ctx.register_platform(
        name="dots", label="Dots", adapter_factory=lambda cfg: DotsAdapter(cfg),
        check_fn=check_requirements, validate_config=validate_config, is_connected=is_connected,
        required_env=["DOTS_TOKEN"], install_hint="aiohttp is already a Hermes dependency",
        env_enablement_fn=_env_enablement, cron_deliver_env_var="DOTS_HOME_CHANNEL",
        standalone_sender_fn=_standalone_send,
        allowed_users_env="DOTS_ALLOWED_USERS", allow_all_env="DOTS_ALLOW_ALL_USERS",
        max_message_length=MAX_MESSAGE_LENGTH, emoji="🟠", pii_safe=True,
        platform_hint=(
            "You are chatting with your owner in the Hermes mobile app (Dots style): a single, "
            "private conversation on their phone. Write like a thoughtful personal assistant in a "
            "chat — short paragraphs, light markdown (bold, lists, code) renders fine. "
            "You may message them first when something matters. Some messages are voice notes, "
            "transcribed automatically before you read them, and the owner can send photos and files. "
            "The owner can watch your web browser live from the app and take control of it: when a page "
            "needs them (login, password, captcha, 2FA, consent wall), call browser_request_takeover "
            "instead of ending your turn. Never ask them to send a password in the chat."
        ))
