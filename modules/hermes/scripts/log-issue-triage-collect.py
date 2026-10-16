#!/usr/bin/env python3
"""Emit a small, secret-redacted log delta for a fixed triage component."""

import argparse
import json
import re
import sys
from pathlib import Path

ALLOWED_COMPONENTS = {"actual-api", "codex-router", "expense-tracker", "hermes", "portfolio-tracker"}
SECRET_PATTERNS = (
    re.compile(r"(?i)\bauthorization\s*:\s*(?:bearer|basic)\s+\S+"),
    re.compile(r"(?i)\bbearer\s+\S+"),
    re.compile(r"(?i)(?:password|passwd|pin|otp|secret(?:[_-]?access[_-]?key)?|client[_-]?secret|private[_-]?key|token|api[_-]?key|authorization|cookie|session)\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;}]+)"),
    re.compile(r"(?i)\"(?:password|passwd|pin|otp|secret(?:[_-]?access[_-]?key)?|client[_-]?secret|private[_-]?key|token|api[_-]?key|authorization|cookie|session)\"\s*:\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;}]+)"),
    re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|AKIA[A-Z0-9]{16})\b"),
    re.compile(r"\b\d{6,12}:[A-Za-z0-9_-]{30,}\b"),  # telegram bot token
    re.compile(r"https://hooks\.slack\.com/services/[A-Za-z0-9/_-]+"),  # slack webhook URL
    re.compile(r"\bntn_[A-Za-z0-9]+\b"),  # notion token
    re.compile(r"(?i)\b(?:https?|postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?)://[^/\s:@]+:[^@\s/]+@[^\s]+"),
    re.compile(r"(?i)\b(?:xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,})\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
    re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----.*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----", re.DOTALL),
    re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    re.compile(r"(?i)\b(?:account|acct|account[_ -]?id|acct[_ -]?id|customer|customer[_ -]?id|member|member[_ -]?id|reference|ref)\s*(?:number|no\.?|id)?\s*(?:is\s*)?(?:[:=#-]\s*)?[A-Z0-9][A-Z0-9_-]{0,31}\b"),
    re.compile(r"(?<!\d)(?!\d{4}[\s./-]\d{1,2}[\s./-]\d{1,2}\b)(?:\+\d{1,3}[\s./-]?)?(?:\(\d{2,4}\)[\s./-]?)?(?:\d{3,4}(?:[\s./-]\d{2,4}){1,3}|\d{7,12})(?!\d)"),
    re.compile(r"(?<!\d)\d{10,15}(?!\d)"),
    re.compile(r"\b(?:\d[ -]?){13,19}\b"),
)


def redact(line):
    """Remove secrets and direct identifiers before an external model sees logs."""
    line = re.sub(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----.*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----", "[REDACTED]", line, flags=re.DOTALL)
    for pattern in SECRET_PATTERNS:
        line = pattern.sub("[REDACTED]", line)
    return line


def load_cursor(path):
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return max(0, int(payload.get("offset", 0)))
    except (FileNotFoundError, TypeError, ValueError, json.JSONDecodeError):
        return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--component", required=True, choices=sorted(ALLOWED_COMPONENTS))
    parser.add_argument("--source", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--max-lines", required=True, type=int)
    parser.add_argument("--max-bytes", required=True, type=int)
    args = parser.parse_args()

    if args.max_lines < 1 or args.max_bytes < 1:
        parser.error("max-lines and max-bytes must be positive")

    state_dir = Path(args.state_dir)
    cursor_path = state_dir / f"{args.component}.cursor.json"
    offset = load_cursor(cursor_path)
    next_offset = offset
    truncated = False
    raw_buffer = bytearray()
    if args.source == "-":
        # Streams cannot seek across runs; retain only the newest bounded bytes.
        stream = sys.stdin.buffer
        while chunk := stream.read(8192):
            raw_buffer.extend(chunk)
            if len(raw_buffer) > args.max_bytes:
                truncated = True
                del raw_buffer[: len(raw_buffer) - args.max_bytes]
    else:
        source = Path(args.source)
        try:
            size = source.stat().st_size
            if offset > size:
                offset = 0
            with source.open("rb") as handle:
                handle.seek(offset)
                raw_buffer.extend(handle.read(args.max_bytes))
                next_offset = handle.tell()
                truncated = next_offset < size
        except FileNotFoundError:
            next_offset = offset

    if len(raw_buffer) > args.max_bytes:
        truncated = True
        del raw_buffer[: len(raw_buffer) - args.max_bytes]
    raw = bytes(raw_buffer)
    if truncated and b"\n" in raw:
        raw = raw.split(b"\n", 1)[1]
    elif truncated:
        raw = b""
    text = bytes(raw).decode("utf-8", errors="replace")
    if truncated and "-----BEGIN " not in text:
        text = re.sub(
            r"\A.*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----",
            "[REDACTED]",
            text,
            count=1,
            flags=re.DOTALL,
        )
    raw_lines = text.splitlines()
    if len(raw_lines) > args.max_lines:
        truncated = True
    def event_timestamp(item):
        match = re.match(r"[^\t]*\t(\d{4}-\d{2}-\d{2}T[^\s]+)", item)
        return match.group(1) if match else None

    if any(event_timestamp(item) for item in raw_lines):
        raw_lines = [
            item for _, item in sorted(
                enumerate(raw_lines),
                key=lambda pair: (event_timestamp(pair[1]) or "", pair[0]),
            )
        ]
    collection_errors = []
    collected_containers = []
    container_images = []
    events = []
    marker_pattern = re.compile(r"^\[collector-(ok|error)\] container=([A-Za-z0-9_.-]+)(?: exit=(\d+))?$")
    metadata_pattern = re.compile(
        r"^\[collector-meta\] container=([A-Za-z0-9_.-]+) image_id=([^ ]*) image_ref=([^ ]*) revision=([^ ]*)$"
    )
    for line in raw_lines:
        metadata = metadata_pattern.fullmatch(line)
        if metadata:
            container_images.append({
                "container": metadata.group(1),
                "image_id": metadata.group(2) or None,
                "image_ref": metadata.group(3) or None,
                "revision": metadata.group(4) or None,
            })
            continue
        match = marker_pattern.fullmatch(line)
        if match and match.group(1) == "error":
            collection_errors.append(line)
        elif match:
            collected_containers.append(match.group(2))
        else:
            events.append(line)
    has_collection_markers = bool(collected_containers or collection_errors)
    if has_collection_markers and not collected_containers:
        raise SystemExit("all log sources failed")
    joined = "\n".join(events)
    redacted = redact(joined).splitlines()
    lines = [line for line in redacted[-args.max_lines :]]
    if args.source != "-":
        state_dir.mkdir(parents=True, exist_ok=True)
        cursor_path.write_text(json.dumps({"offset": next_offset}), encoding="utf-8")
    print(json.dumps({"component": args.component, "line_count": len(lines), "truncated": truncated, "collected_containers": collected_containers, "container_images": container_images, "collection_errors": collection_errors, "lines": lines}))


if __name__ == "__main__":
    main()
