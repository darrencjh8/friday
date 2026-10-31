#!/usr/bin/env python3
"""Google Calendar CLI (stdlib only): events, add.

Uses the shared token from `google login`. Reading uses calendar.readonly.
Adding uses calendar.events.owned (events on calendars Darren owns) and is the
only write: `add` inserts one event on the primary calendar with no attendees,
sends no invites or updates, and refuses a second event for the same source
message. There is no update, move, accept or delete command.
"""
import argparse
import datetime
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gmail  # noqa: E402  (shared GET helper; same directory)
import gtasks  # noqa: E402

API_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
DEFAULT_TZ = "Asia/Singapore"
SOURCE_KEY = "friday_source"


def enabled():
    return gtasks.CALENDAR_SCOPE in gtasks.granted_scopes()


def can_add():
    return gtasks.CALENDAR_EVENTS_SCOPE in gtasks.granted_scopes()


def _start(event):
    return (event.get("start") or {}).get("dateTime") or (event.get("start") or {}).get("date", "")


def list_events(days=14):
    """Primary-calendar events from now to `days` ahead, in start order."""
    now = datetime.datetime.now(datetime.timezone.utc)
    items = gmail.get(API_BASE, {
        "timeMin": now.isoformat(), "timeMax": (now + datetime.timedelta(days=days)).isoformat(),
        "singleEvents": "true", "orderBy": "startTime", "maxResults": 100,
    }, scope=gtasks.CALENDAR_SCOPE).get("items", [])
    return [{"id": e.get("id", ""), "status": e.get("status", ""), "summary": e.get("summary", ""),
             "location": e.get("location", ""),
             "start": _start(e),
             "end": (e.get("end") or {}).get("dateTime") or (e.get("end") or {}).get("date", ""),
             "description": (e.get("description") or "")[:500]} for e in items]


def _norm(title):
    return re.sub(r"\s+", " ", title or "").strip().lower()


def _parse_local(value, name):
    try:
        return datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M")
    except ValueError:
        raise ValueError("%s must be YYYY-MM-DDTHH:MM" % name)


def build_event(title, date=None, start=None, end=None, tz=DEFAULT_TZ, location="",
                description="", reminder_minutes=None, source=""):
    """Validated insert body. Raises ValueError before any request is made."""
    title = (title or "").strip()
    if not title:
        raise ValueError("--title is required")
    if not (source or "").strip():
        raise ValueError("--source is required (for example gmail:<message id>)")
    if bool(date) == bool(start):
        raise ValueError("pass either --date (all-day) or --start with --end")
    body = {"summary": title[:200]}
    if date:
        try:
            day = datetime.date.fromisoformat(date)
        except ValueError:
            raise ValueError("--date must be YYYY-MM-DD")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            raise ValueError("--date must be YYYY-MM-DD")
        body["start"] = {"date": day.isoformat()}
        body["end"] = {"date": (day + datetime.timedelta(days=1)).isoformat()}
        anchor = datetime.datetime.combine(day, datetime.time(12), tzinfo=ZoneInfo(DEFAULT_TZ))
    else:
        if not end:
            raise ValueError("--end is required with --start")
        try:
            zone = ZoneInfo(tz)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("unknown time zone: %s" % tz)
        begin, finish = _parse_local(start, "--start"), _parse_local(end, "--end")
        if finish <= begin:
            raise ValueError("--end must be after --start")
        body["start"] = {"dateTime": begin.isoformat(timespec="seconds"), "timeZone": tz}
        body["end"] = {"dateTime": finish.isoformat(timespec="seconds"), "timeZone": tz}
        anchor = begin.replace(tzinfo=zone)
    if location:
        body["location"] = location[:500]
    if description:
        body["description"] = description[:4000]
    if reminder_minutes is not None:
        if not 0 <= reminder_minutes <= 40320:
            raise ValueError("--reminder-minutes must be between 0 and 40320")
        body["reminders"] = {"useDefault": False,
                             "overrides": [{"method": "popup", "minutes": reminder_minutes}]}
    body["extendedProperties"] = {"private": {SOURCE_KEY: source.strip()[:200]}}
    return body, anchor


def _existing(body, anchor):
    """An event already made from the same source, or one with the same title
    starting within a day of this one (for example added by hand)."""
    source = body["extendedProperties"]["private"][SOURCE_KEY]
    found = gmail.get(API_BASE, {"privateExtendedProperty": "%s=%s" % (SOURCE_KEY, source),
                                 "maxResults": 5, "showDeleted": "false"},
                      scope=gtasks.CALENDAR_SCOPE).get("items", [])
    if found:
        return found[0]
    window = gmail.get(API_BASE, {
        "timeMin": (anchor - datetime.timedelta(days=1)).isoformat(),
        "timeMax": (anchor + datetime.timedelta(days=1)).isoformat(),
        "singleEvents": "true", "maxResults": 100,
    }, scope=gtasks.CALENDAR_SCOPE).get("items", [])
    title = _norm(body["summary"])
    return next((e for e in window if _norm(e.get("summary")) == title), None)


def _insert(body):
    """The one write: insert on the primary calendar, notifying nobody."""
    token = gtasks.token_for(gtasks.CALENDAR_EVENTS_SCOPE)
    url = API_BASE + "?" + urllib.parse.urlencode({"sendUpdates": "none"})
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST")
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)
    except Exception as exc:
        if getattr(exc, "code", None) == 401:
            raise gtasks.AuthExpired()
        raw = ""
        try:
            raw = exc.read().decode()[:200]
        except Exception:
            pass
        raise RuntimeError("Google API error: %s" % (raw or exc))


def add_event(**kwargs):
    body, anchor = build_event(**kwargs)
    if not can_add():
        raise gtasks.MissingScope("The Google login does not include calendar.events.owned. "
                                  "Run `google login` again and allow adding events.")
    found = _existing(body, anchor)
    if found:
        return {"status": "exists", "id": found.get("id", ""), "htmlLink": found.get("htmlLink", ""),
                "summary": found.get("summary", ""), "start": _start(found)}
    made = _insert(body)
    return {"status": "created", "id": made.get("id", ""), "htmlLink": made.get("htmlLink", ""),
            "summary": body["summary"], "start": _start(body)}


def main(argv=None):
    parser = argparse.ArgumentParser(prog="gcal", description="Google Calendar: read events, add one event.")
    sub = parser.add_subparsers(dest="command", required=True)
    events = sub.add_parser("events")
    events.add_argument("--days", type=int, default=14)
    add = sub.add_parser("add", help="add one event to the primary calendar (no attendees, no invites)")
    add.add_argument("--title", required=True)
    add.add_argument("--date", help="all-day event date YYYY-MM-DD (due dates)")
    add.add_argument("--start", help="local start YYYY-MM-DDTHH:MM")
    add.add_argument("--end", help="local end YYYY-MM-DDTHH:MM")
    add.add_argument("--tz", default=DEFAULT_TZ, help="IANA time zone of --start/--end")
    add.add_argument("--location", default="")
    add.add_argument("--description", default="")
    add.add_argument("--reminder-minutes", type=int, default=None)
    add.add_argument("--source", default="", help="where it came from, e.g. gmail:<message id>")
    args = parser.parse_args(argv)
    try:
        if args.command == "events":
            print(json.dumps(list_events(min(args.days, 31)), indent=2, ensure_ascii=False))
        else:
            print(json.dumps(add_event(title=args.title, date=args.date, start=args.start, end=args.end,
                                       tz=args.tz, location=args.location, description=args.description,
                                       reminder_minutes=args.reminder_minutes, source=args.source),
                             ensure_ascii=False))
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
