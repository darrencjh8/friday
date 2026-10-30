#!/usr/bin/env python3
"""Read-only Google Calendar CLI (stdlib only): events.

Uses the shared token from `google login`, whose Calendar scope is only
calendar.readonly, so Google refuses any change to the calendar. GET only.
"""
import argparse
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gmail  # noqa: E402  (shared GET helper; same directory)
import gtasks  # noqa: E402

API_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events"


def enabled():
    return gtasks.CALENDAR_SCOPE in gtasks.granted_scopes()


def list_events(days=14):
    """Primary-calendar events from now to `days` ahead, in start order."""
    now = datetime.datetime.now(datetime.timezone.utc)
    items = gmail.get(API_BASE, {
        "timeMin": now.isoformat(), "timeMax": (now + datetime.timedelta(days=days)).isoformat(),
        "singleEvents": "true", "orderBy": "startTime", "maxResults": 100,
    }, scope=gtasks.CALENDAR_SCOPE).get("items", [])
    return [{"id": e.get("id", ""), "status": e.get("status", ""), "summary": e.get("summary", ""),
             "location": e.get("location", ""),
             "start": (e.get("start") or {}).get("dateTime") or (e.get("start") or {}).get("date", ""),
             "end": (e.get("end") or {}).get("dateTime") or (e.get("end") or {}).get("date", ""),
             "description": (e.get("description") or "")[:500]} for e in items]


def main(argv=None):
    parser = argparse.ArgumentParser(prog="gcal", description="Read-only Google Calendar.")
    sub = parser.add_subparsers(dest="command", required=True)
    events = sub.add_parser("events")
    events.add_argument("--days", type=int, default=14)
    args = parser.parse_args(argv)
    try:
        print(json.dumps(list_events(min(args.days, 31)), indent=2, ensure_ascii=False))
    except gtasks.AuthExpired:
        sys.stderr.write(gtasks.auth_expired_message() + "\n")
        return gmail.EXIT_AUTH_EXPIRED
    except gtasks.MissingScope as exc:
        sys.stderr.write("%s\n" % exc)
        return gmail.EXIT_AUTH_EXPIRED
    except (RuntimeError, TimeoutError, ValueError) as exc:
        sys.stderr.write("%s\n" % exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
