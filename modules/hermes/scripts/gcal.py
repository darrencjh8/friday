#!/usr/bin/env python3
"""Google Calendar CLI (stdlib only): events, add, delete.

Uses the shared token from `google login`. Reading uses calendar.readonly.
Adding uses calendar.app.created: events go on one secondary "Friday" calendar
that this CLI creates, and Google refuses any change to the user's own
calendars and events whoever holds the token. `add` inserts one event with no
attendees, sends no invites or updates, strips links from its text, and
refuses a second event for the same source message. A similar event on any of
the user's calendars the same day is reported as a possible duplicate instead
of being added (unless --confirm-new). `delete` removes an event Friday added,
and only from the Friday calendar. There is no update, move or accept command.
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

CAL_API = "https://www.googleapis.com/calendar/v3"
API_BASE = CAL_API + "/calendars/primary/events"
DEFAULT_TZ = "Asia/Singapore"
SOURCE_KEY = "friday_source"
FRIDAY_CALENDAR = "Friday"
FRIDAY_MARKER = "Events Friday added from email (gcal add)."
URL_RE = re.compile(r"(?i)\b(?:https?://|www\.)\S+"
                    r"|\b(?:[a-z0-9-]+\.)+[a-z]{2,24}(?:/\S*)?(?![\w.@-])")
STOP = {"a", "an", "the", "for", "to", "of", "and", "on", "at", "in", "with", "my", "me", "her", "his",
        "their", "your", "from", "by", "s", "re", "fw", "fwd"}


class NotFound(RuntimeError):
    pass


def enabled():
    return gtasks.CALENDAR_SCOPE in gtasks.granted_scopes()


def can_add():
    return gtasks.CALENDAR_APP_SCOPE in gtasks.granted_scopes()


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


def _clean(text, limit):
    """Event text comes from untrusted mail: no links, bounded length."""
    return re.sub(r"[ \t]+", " ", URL_RE.sub("[link removed]", text or "")).strip()[:limit]


def _parse_local(value, name):
    try:
        return datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M")
    except ValueError:
        raise ValueError("%s must be YYYY-MM-DDTHH:MM" % name)


def build_event(title, date=None, start=None, end=None, tz=DEFAULT_TZ, location="",
                description="", reminder_minutes=None, source=""):
    """Validated insert body and its dedupe anchor. Raises ValueError before any request."""
    title = _clean(title, 200)
    source = (source or "").strip()
    if not title:
        raise ValueError("--title is required")
    if not re.fullmatch(r"gmail:[A-Za-z0-9_-]{1,100}", source):
        raise ValueError("--source must be gmail:<message id>")
    if bool(date) == bool(start):
        raise ValueError("pass either --date (all-day) or --start with --end")
    body = {"summary": title}
    if date:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            raise ValueError("--date must be YYYY-MM-DD")
        try:
            day = datetime.date.fromisoformat(date)
        except ValueError:
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
    location = _clean(location, 300)
    if location:
        body["location"] = location
    note = _clean(description, 1500)
    body["description"] = ("Added by Friday from email (%s). Check the email before acting on this.%s"
                           % (source, "\n\n" + note if note else ""))
    if reminder_minutes is not None:
        if not 0 <= reminder_minutes <= 40320:
            raise ValueError("--reminder-minutes must be between 0 and 40320")
        body["reminders"] = {"useDefault": False,
                             "overrides": [{"method": "popup", "minutes": reminder_minutes}]}
    body["extendedProperties"] = {"private": {SOURCE_KEY: source}}
    return body, anchor


def _request(method, url, params=None, body=None, scope=None):
    """Calendar request with the given scope; NotFound on 404."""
    token = gtasks.token_for(scope or gtasks.CALENDAR_APP_SCOPE)
    url += "?" + urllib.parse.urlencode(params, doseq=True) if params else ""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except Exception as exc:
        code = getattr(exc, "code", None)
        if code == 401:
            raise gtasks.AuthExpired()
        if code in (404, 410):
            raise NotFound("not found: %s" % url.split("?")[0].rsplit("/", 2)[-2:])
        raw = ""
        try:
            raw = exc.read().decode()[:200]
        except Exception:
            pass
        raise RuntimeError("Google API error: %s" % (raw or exc))


def _post(url, body):
    """Writes go only to the app-created Friday calendar (calendar.app.created)."""
    return _request("POST", url, body=body, scope=gtasks.CALENDAR_APP_SCOPE)


def _state_path():
    return os.path.join(gtasks._config_dir(), "gcal-friday-calendar.json")


def _forget_friday_calendar():
    try:
        os.remove(_state_path())
    except OSError:
        pass


def friday_calendar_id():
    """The secondary calendar this CLI created; found again by its marker, else created once."""
    try:
        with open(_state_path()) as fh:
            cid = json.load(fh).get("id")
        if cid:
            return cid
    except (OSError, ValueError):
        pass
    listed = gmail.get(CAL_API + "/users/me/calendarList", {"maxResults": 250, "minAccessRole": "owner"},
                       scope=gtasks.CALENDAR_SCOPE).get("items", [])
    found = next((c for c in listed if c.get("summary") == FRIDAY_CALENDAR
                  and c.get("description") == FRIDAY_MARKER), None)
    cid = found.get("id") if found else _post(CAL_API + "/calendars", {
        "summary": FRIDAY_CALENDAR, "description": FRIDAY_MARKER, "timeZone": DEFAULT_TZ}).get("id")
    if not cid:
        raise RuntimeError("could not find or create the Friday calendar")
    os.makedirs(gtasks._config_dir(), exist_ok=True)
    with open(_state_path(), "w") as fh:
        json.dump({"id": cid}, fh)
    return cid


def _events_url(calendar_id):
    return CAL_API + "/calendars/%s/events" % urllib.parse.quote(calendar_id, safe="")


def _words(title):
    text = re.sub(r"['\u2019]s\b", "", (title or "").lower())
    return {w for w in re.findall(r"[a-z0-9]+", text) if w not in STOP and len(w) > 1}


def _similar(a, b):
    """Same thing in other words: most key words of the shorter title appear in the other."""
    wa, wb = _words(a), _words(b)
    if not wa or not wb:
        return False
    shared = wa & wb
    return len(shared) >= min(2, len(wa), len(wb)) and len(shared) / min(len(wa), len(wb)) >= 0.6


def _existing(body, anchor, calendar_id):
    """("exists", event) for an event made from the same source or with the same
    title within a day; ("possible_duplicate", matches) for similar titles on any
    calendar the user can see; (None, None) otherwise."""
    source = body["extendedProperties"]["private"][SOURCE_KEY]
    found = _request("GET", _events_url(calendar_id), {"privateExtendedProperty": "%s=%s" % (SOURCE_KEY, source),
                                                       "maxResults": 5}).get("items", [])
    if found:
        return "exists", found[0]
    window = {"timeMin": (anchor - datetime.timedelta(days=1)).isoformat(),
              "timeMax": (anchor + datetime.timedelta(days=1)).isoformat(),
              "singleEvents": "true", "maxResults": 2500}
    calendars = [("primary", "Primary", gtasks.CALENDAR_SCOPE)]
    listed = _request("GET", CAL_API + "/users/me/calendarList", {"maxResults": 250},
                      scope=gtasks.CALENDAR_SCOPE).get("items", [])
    for cal in listed:
        if cal.get("id") != calendar_id and not cal.get("primary") and cal.get("id"):
            calendars.append((cal["id"], cal.get("summaryOverride") or cal.get("summary", ""), gtasks.CALENDAR_SCOPE))
    calendars.append((calendar_id, FRIDAY_CALENDAR, gtasks.CALENDAR_APP_SCOPE))
    title, similar = _norm(body["summary"]), []
    for cid, name, scope in calendars:
        try:
            items = _request("GET", _events_url(cid), window, scope=scope).get("items", [])
        except NotFound:
            if cid == calendar_id:
                raise
            continue
        for e in items:
            if e.get("status") == "cancelled":
                continue
            if _norm(e.get("summary")) == title:
                return "exists", e
            if _similar(body["summary"], e.get("summary")):
                similar.append({"calendar": name, "id": e.get("id", ""), "summary": e.get("summary", ""),
                                "start": _start(e), "htmlLink": e.get("htmlLink", "")})
    return ("possible_duplicate", similar) if similar else (None, None)


def add_event(confirm_new=False, **kwargs):
    body, anchor = build_event(**kwargs)
    if not (can_add() and enabled()):
        raise gtasks.MissingScope("The Google login does not include calendar.app.created and "
                                  "calendar.readonly. Run `google login` again and allow both.")
    for attempt in (1, 2):
        calendar_id = friday_calendar_id()
        try:
            kind, found = _existing(body, anchor, calendar_id)
            if kind == "exists":
                return {"status": "exists", "id": found.get("id", ""), "htmlLink": found.get("htmlLink", ""),
                        "summary": found.get("summary", ""), "start": _start(found)}
            if kind == "possible_duplicate" and not confirm_new:
                return {"status": "possible_duplicate", "matches": found[:5],
                        "note": "not added; rerun with --confirm-new only if it is a different event"}
            made = _post(_events_url(calendar_id) + "?" + urllib.parse.urlencode({"sendUpdates": "none"}), body)
        except NotFound:
            if attempt == 2:
                raise
            _forget_friday_calendar()  # the user deleted the Friday calendar: find or make it again
            continue
        return {"status": "created", "id": made.get("id", ""), "htmlLink": made.get("htmlLink", ""),
                "summary": body["summary"], "start": _start(body), "calendar": FRIDAY_CALENDAR}


def delete_event(event_id):
    """Delete one event Friday added. Only the Friday calendar, only events with a source mark."""
    if not re.fullmatch(r"[A-Za-z0-9_]{5,1024}", event_id or ""):
        raise ValueError("--id must be an event id from gcal add")
    if not can_add():
        raise gtasks.MissingScope("The Google login does not include calendar.app.created. "
                                  "Run `google login` again and allow it.")
    calendar_id = friday_calendar_id()
    url = _events_url(calendar_id) + "/" + event_id
    try:
        event = _request("GET", url)
    except NotFound:
        raise ValueError("no such event on the Friday calendar; Friday can only delete events she added")
    if not ((event.get("extendedProperties") or {}).get("private") or {}).get(SOURCE_KEY):
        raise ValueError("that event was not added by Friday; ask Darren to remove it himself")
    _request("DELETE", url, {"sendUpdates": "none"})
    return {"status": "deleted", "id": event_id, "summary": event.get("summary", ""), "start": _start(event)}


def main(argv=None):
    parser = argparse.ArgumentParser(prog="gcal", description="Google Calendar: read events, add one event.")
    sub = parser.add_subparsers(dest="command", required=True)
    events = sub.add_parser("events")
    events.add_argument("--days", type=int, default=14)
    add = sub.add_parser("add", help='add one event to the "Friday" calendar (no attendees, no invites)')
    add.add_argument("--title", required=True)
    add.add_argument("--date", help="all-day event date YYYY-MM-DD (due dates)")
    add.add_argument("--start", help="local start YYYY-MM-DDTHH:MM")
    add.add_argument("--end", help="local end YYYY-MM-DDTHH:MM")
    add.add_argument("--tz", default=DEFAULT_TZ, help="IANA time zone of --start/--end")
    add.add_argument("--location", default="")
    add.add_argument("--description", default="")
    add.add_argument("--reminder-minutes", type=int, default=None)
    add.add_argument("--source", default="", help="the email it came from: gmail:<message id>")
    add.add_argument("--confirm-new", action="store_true",
                     help="add even though a similar event is on the calendar (only after checking)")
    delete = sub.add_parser("delete", help="delete one event Friday added (Friday calendar only)")
    delete.add_argument("--id", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "events":
            print(json.dumps(list_events(min(args.days, 31)), indent=2, ensure_ascii=False))
        elif args.command == "delete":
            print(json.dumps(delete_event(args.id), ensure_ascii=False))
        else:
            print(json.dumps(add_event(title=args.title, date=args.date, start=args.start, end=args.end,
                                       tz=args.tz, location=args.location, description=args.description,
                                       reminder_minutes=args.reminder_minutes, source=args.source,
                                       confirm_new=args.confirm_new),
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
