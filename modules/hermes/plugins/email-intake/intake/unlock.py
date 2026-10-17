"""Open password-protected statement PDFs (issue #783, cutover PR 3).

Statement passwords live in Bitwarden as STMT_PW_* secrets. Each encrypted
PDF in an email is tried against them with qpdf; the email is rebuilt with
the decrypted PDFs so the tracker reads it like any other statement. The
password reaches qpdf through a private temporary file, never argv or a log.
"""

import logging
import os
import subprocess
import tempfile
from email import policy
from email.parser import BytesParser

logger = logging.getLogger(__name__)

PREFIX = "STMT_PW_"
# qpdf exit 3 means warnings, and the decrypted output is still written (expense-tracker #647).
_QPDF_OK = (0, 3)


def statement_passwords(*sources):
    """The distinct STMT_PW_* values across mappings, in name order."""
    found = {}
    for source in sources:
        for name, value in (source or {}).items():
            value = str(value or "").strip()
            if name.startswith(PREFIX) and value:
                found.setdefault(name, value)
    return list(dict.fromkeys(found[name] for name in sorted(found)))


def is_encrypted(data):
    return b"/Encrypt" in data


def decrypt_pdf(data, passwords, run=subprocess.run):
    """The decrypted PDF, or None when no password opens it."""
    with tempfile.TemporaryDirectory(prefix="intake-pdf-") as tmp:
        source, target, secret = (os.path.join(tmp, n) for n in ("in.pdf", "out.pdf", "pw"))
        with open(source, "wb") as handle:
            handle.write(data)
        for password in passwords:
            with open(os.open(secret, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as handle:
                handle.write(password)
            try:
                result = run(["qpdf", f"--password-file={secret}", "--decrypt", source, target],
                             capture_output=True, timeout=60)
            except (OSError, subprocess.SubprocessError) as error:
                logger.warning("email-intake qpdf failed: %s", type(error).__name__)
                return None
            if result.returncode in _QPDF_OK and os.path.exists(target):
                with open(target, "rb") as handle:
                    opened = handle.read()
                if opened and not is_encrypted(opened):
                    return opened
            if os.path.exists(target):
                os.remove(target)
    return None


def _pdf_parts(msg):
    for part in msg.walk():
        if part.is_multipart():
            continue
        if part.get_content_type() == "application/pdf" or (part.get_filename() or "").lower().endswith(".pdf"):
            yield part


def unlock(raw, passwords, run=subprocess.run):
    """The email with every encrypted PDF opened; the same bytes when none is encrypted; None when one stays locked.

    `passwords` is called only for an email that needs it: reading Bitwarden is slow."""
    msg = BytesParser(policy=policy.default).parsebytes(raw)
    locked = [p for p in _pdf_parts(msg) if is_encrypted(p.get_payload(decode=True) or b"")]
    if not locked:
        return raw
    passwords = passwords()
    if not passwords:
        return None
    for part in locked:
        opened = decrypt_pdf(part.get_payload(decode=True), passwords, run=run)
        if opened is None:
            return None
        part.set_content(opened, maintype="application", subtype="pdf",
                         disposition=part.get_content_disposition() or "attachment",
                         filename=part.get_filename())
    return msg.as_bytes()
