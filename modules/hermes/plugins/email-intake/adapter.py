"""Hermes platform glue for email-intake (issue #783, shadow mode).

The gateway starts this adapter when EMAIL_INTAKE_MODE=shadow and the IMAP
and Jev settings are present. connect() takes the single-owner lock and
starts the shadow loop on a background thread; it never calls
handle_message, so no email ever becomes an agent turn. send() refuses:
intake does not reply.
"""

import logging
import sys
import threading
from pathlib import Path

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, SendResult
from gateway.platforms._shared import get_scoped_secret

sys.path.insert(0, str(Path(__file__).resolve().parent))
from intake import service  # noqa: E402

logger = logging.getLogger(__name__)
NAME = "email_intake"


def _get(key, default=""):
    return get_scoped_secret(key, default)


class EmailIntakeAdapter(BasePlatformAdapter):
    def __init__(self, config: PlatformConfig):
        super().__init__(config=config, platform=Platform(NAME))
        self._settings = service.load_settings(_get)
        self._lock = None
        self._stop = None
        self._thread = None

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if self._settings is None:
            logger.info("[email-intake] not enabled or not fully configured")
            return False
        lock = service.OwnerLock(Path(self._settings.data_dir) / "owner.lock")
        if not lock.acquire():
            logger.warning("[email-intake] another instance owns the mailbox; not starting")
            return False
        self._lock, self._stop = lock, service.StopFlag()
        self._thread = threading.Thread(
            target=service.run_intake,
            kwargs={"settings": self._settings, "sleep": self._stop.wait, "stop": self._stop},
            name="email-intake",
            daemon=True,
        )
        self._thread.start()
        self._mark_connected()
        logger.info("[email-intake] %s mode started (interval %ss)", self._settings.mode, self._settings.interval)
        return True

    async def disconnect(self) -> None:
        if self._stop:
            self._stop.set()
        if self._lock:
            self._lock.release()
            self._lock = None
        self._mark_disconnected()

    async def send(self, chat_id, content, reply_to=None, metadata=None) -> SendResult:
        return SendResult(success=False, error="email-intake never sends messages")

    async def get_chat_info(self, chat_id):
        return {"name": chat_id, "type": "dm"}


def _check() -> bool:
    return True


def _env_enablement():
    settings = service.load_settings(_get)
    return {"mode": settings.mode} if settings else None


def register(ctx) -> None:
    ctx.register_platform(
        name=NAME,
        label="Email intake",
        adapter_factory=lambda cfg: EmailIntakeAdapter(cfg),
        check_fn=_check,
        required_env=["EMAIL_INTAKE_MODE", "IMAP_HOST", "IMAP_USERNAME", "IMAP_PASSWORD", "JEV_API_KEY"],
        install_hint="stdlib only",
        env_enablement_fn=_env_enablement,
        emoji="📥",
    )
