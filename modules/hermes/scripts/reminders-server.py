#!/usr/bin/env python3
"""Reminders dashboard (stdlib only).

Serves the structured snapshot written by wiki-reminder-tasks.py
--snapshot-out as a tailnet-only page: GET / renders the dashboard,
GET /api/reminders returns the snapshot JSON, GET /health answers ok.
GET /api/habits lists the live daily-habits wiki table. POST
/api/habits ({"action": "add"|"remove"}) rewrites that table atomically
and requires `Authorization: Bearer $REMINDERS_EDIT_TOKEN`; an unset
token disables editing (403, fail closed). Everything else is 404.
No secrets, tokens, or task data are logged — only the startup line
and 4xx/5xx statuses hit stderr.
"""
import hmac
import http.server
import json
import os
import re
import sys

PORT = int(os.environ.get("REMINDERS_PORT", "8300"))
SNAPSHOT = os.environ.get("REMINDERS_SNAPSHOT",
                           "/opt/data/reminders/reminders.json")
HABITS = os.environ.get(
    "REMINDERS_HABITS",
    "/opt/data/home/wiki/entities/accounts/daily-habits.md")
EDIT_TOKEN = os.environ.get("REMINDERS_EDIT_TOKEN", "")
MAX_BODY = 16384
SECTION_HEADING = "## Daily candidates"
TITLE_MAX = 120
NOTE_MAX = 500

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reminders</title>
<style>
:root{--bg:#f4f6fb;--card:#fff;--ink:#141a24;--muted:#5b6577;--line:#e2e7f0;
--ok:#0a7d43;--warn:#8a5a00;--err:#b00020}
@media (prefers-color-scheme:dark){:root{--bg:#0f131a;--card:#171c26;--ink:#e8ecf4;
--muted:#9aa5b8;--line:#28303d;--ok:#5fd39a;--warn:#e6bf6a;--err:#ff8a9b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:960px;margin:0 auto;padding:20px 16px 72px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;
padding:18px;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600}
.pill{display:inline-block;font-size:12px;font-weight:600;padding:2px 10px;
border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.pill.created,.pill.skipped{color:var(--ok);border-color:currentColor}
.pill.pending{color:var(--warn);border-color:currentColor}
.pill.overdue-manual,.pill.conflict,.pill.create-failed,
.pill.unclassified{color:var(--err);border-color:currentColor}
.note{white-space:pre-wrap;color:var(--muted);font-size:13px}
</style></head>
<body><main>
<h1>Reminders</h1>
<div class="card">
<h3 style="margin-top:0">Daily habits <span style="color:var(--muted);
font-weight:400;font-size:13px">live from the wiki — edits apply from the
next 08:15 run</span></h3>
<table><tbody id="habit-rows"></tbody></table>
<p id="habit-empty" class="note" hidden>No daily habits configured.</p>
<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
<input id="h-title" placeholder="New habit" maxlength="120"
 style="flex:1;min-width:140px;padding:6px 8px">
<input id="h-note" placeholder="Note (optional)" maxlength="500"
 style="flex:2;min-width:160px;padding:6px 8px">
<button id="h-add" style="padding:6px 14px">Add</button>
</div>
<details style="margin-top:10px"><summary class="note">Edit token</summary>
<input id="h-token" type="password" placeholder="edit token"
 style="width:100%;padding:6px 8px;margin-top:6px"></details>
<p class="note">Removing a habit stops future tasks; tasks already created
in Google Tasks are never deleted — clear them there. Titles and notes may
not contain | or backticks.</p>
<p id="habit-msg" class="note"></p>
</div>
<p class="sub" id="meta">loading…</p>
<div class="card"><table>
<thead><tr><th>Reminder</th><th>Type</th><th>Due</th><th>Status</th></tr></thead>
<tbody id="rows"></tbody>
</table></div>
<div class="card" id="problems-card" hidden>
<h3 style="margin-top:0">Problems</h3>
<table><tbody id="problems"></tbody></table>
</div>
<div class="card" id="notes-card" hidden>
<h3 style="margin-top:0">Notes</h3>
<div id="notes"></div>
</div>
<script>
const tokenBox = document.getElementById("h-token");
tokenBox.value = localStorage.getItem("reminders-edit-token") || "";
tokenBox.addEventListener("change", () => {
  localStorage.setItem("reminders-edit-token", tokenBox.value);
});
function habitMsg(text) {
  document.getElementById("habit-msg").textContent = text;
}
async function loadHabits() {
  const rows = document.getElementById("habit-rows");
  rows.textContent = "";
  let data;
  try {
    const r = await fetch("/api/habits", {cache: "no-store"});
    if (!r.ok) throw new Error("http " + r.status);
    data = await r.json();
  } catch (e) {
    habitMsg("Habits unavailable — the wiki section could not be read.");
    return;
  }
  document.getElementById("habit-empty").hidden = data.habits.length > 0;
  for (const h of data.habits) {
    const tr = document.createElement("tr");
    const tdTitle = document.createElement("td");
    tdTitle.textContent = h.title;
    const tdNote = document.createElement("td");
    tdNote.className = "note";
    tdNote.textContent = h.note || "";
    const tdBtn = document.createElement("td");
    tdBtn.style.textAlign = "right";
    const btn = document.createElement("button");
    btn.textContent = "Remove";
    btn.addEventListener("click", () => editHabits({action: "remove",
                                                    key: h.key}));
    tdBtn.appendChild(btn);
    tr.append(tdTitle, tdNote, tdBtn);
    rows.appendChild(tr);
  }
}
async function editHabits(payload) {
  habitMsg("");
  let r;
  try {
    r = await fetch("/api/habits", {
      method: "POST",
      headers: {"Content-Type": "application/json",
                "Authorization": "Bearer " + tokenBox.value},
      body: JSON.stringify(payload)});
  } catch (e) {
    habitMsg("Request failed: " + e.message);
    return;
  }
  if (r.status === 401 || r.status === 403) {
    habitMsg("Edit token missing or wrong — set it above.");
    return;
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    habitMsg(data.error || ("Error " + r.status));
    return;
  }
  loadHabits();
}
document.getElementById("h-add").addEventListener("click", () => {
  const title = document.getElementById("h-title").value.trim();
  const note = document.getElementById("h-note").value.trim();
  if (!title) { habitMsg("Title required."); return; }
  document.getElementById("h-title").value = "";
  document.getElementById("h-note").value = "";
  editHabits({action: "add", title: title, note: note});
});
async function load() {
  const meta = document.getElementById("meta");
  let snap;
  try {
    const r = await fetch("/api/reminders", {cache: "no-store"});
    if (!r.ok) throw new Error("http " + r.status);
    snap = await r.json();
  } catch (e) {
    meta.textContent = "No snapshot yet — the daily job has not run.";
    return;
  }
  const items = snap.items || [];
  meta.textContent = "Run " + (snap.run_date || "?") +
    " · created " + (snap.summary?.created ?? 0) +
    " · skipped " + (snap.summary?.skipped ?? 0) +
    " · pending " + (snap.summary?.pending ?? 0);
  const rows = document.getElementById("rows");
  rows.textContent = "";
  for (const it of items) {
    const tr = document.createElement("tr");
    const tdTitle = document.createElement("td");
    tdTitle.textContent = it.title || it.key;
    const tdType = document.createElement("td");
    tdType.textContent = it.type || "";
    const tdDue = document.createElement("td");
    tdDue.textContent = dueText(it);
    const tdStatus = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = "pill " + (it.status || "");
    pill.textContent = it.status || "";
    tdStatus.appendChild(pill);
    tr.append(tdTitle, tdType, tdDue, tdStatus);
    rows.appendChild(tr);
    if (it.note) {
      const ncard = document.getElementById("notes-card");
      ncard.hidden = false;
      const div = document.createElement("div");
      const h = document.createElement("h4");
      h.textContent = it.title || it.key;
      const p = document.createElement("p");
      p.className = "note";
      p.textContent = it.note;
      div.append(h, p);
      document.getElementById("notes").appendChild(div);
    }
  }
  const probs = snap.problems || [];
  if (probs.length) {
    document.getElementById("problems-card").hidden = false;
    const pb = document.getElementById("problems");
    pb.textContent = "";
    for (const p of probs) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.textContent = p;
      tr.appendChild(td);
      pb.appendChild(tr);
    }
  }
}
function dueText(it) {
  if (it.action_date == null || it.action_date === "") return "";
  if (it.days_left == null) return it.action_date;
  if (it.days_left === 0) return it.action_date + " · today";
  if (it.days_left === 1) return it.action_date + " · tomorrow";
  return it.action_date + " · " + it.days_left + "d";
}
load();
loadHabits();
</script>
</main></body></html>
"""


def load_snapshot():
    try:
        with open(SNAPSHOT, encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return {"version": 1, "generated_at": None, "run_date": None,
                "task_list": "Planned", "items": [], "problems": [],
                "summary": {"created": 0, "skipped": 0, "pending": 0}}
    except (OSError, ValueError) as exc:
        # A corrupt snapshot must not masquerade as "never ran": say so
        # on stderr so the container log names it, while still serving
        # the empty state so the page stays up.
        sys.stderr.write("reminders corrupt snapshot %s: %s\n"
                         % (SNAPSHOT, exc))
        return {"version": 1, "generated_at": None, "run_date": None,
                "task_list": "Planned", "items": [],
                "problems": ["snapshot unreadable; see container log"],
                "summary": {"created": 0, "skipped": 0, "pending": 0}}


class SectionMissing(Exception):
    """daily-habits.md exists but has no Daily candidates table."""


def _row_cells(line):
    text = line.strip()
    if not (text.startswith("|") and text.endswith("|")):
        return None
    return [cell.strip() for cell in text[1:-1].split("|")]


def _row_key(cells):
    if len(cells) < 2:
        return None
    first = cells[0]
    if len(first) > 2 and first.startswith("`") and first.endswith("`"):
        return first[1:-1]
    return None


def _table_rows(lines):
    """Line indexes of the Daily candidates table (header first).

    Raises SectionMissing when the heading or table is absent, so a
    write never guesses where rows live.
    """
    head = None
    for i, line in enumerate(lines):
        if line.strip() == SECTION_HEADING:
            head = i
            break
    if head is None:
        raise SectionMissing()
    rows = []
    i = head + 1
    while i < len(lines) and _row_cells(lines[i]) is None:
        if lines[i].strip().startswith("#"):
            raise SectionMissing()
        i += 1
    while i < len(lines) and _row_cells(lines[i]) is not None:
        rows.append(i)
        i += 1
    if len(rows) < 2:
        raise SectionMissing()
    return rows


def _read_lines():
    with open(HABITS, encoding="utf-8") as handle:
        return handle.read().splitlines()


def _write_lines(lines):
    tmp = HABITS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    os.replace(tmp, HABITS)


def read_habits():
    try:
        lines = _read_lines()
    except FileNotFoundError:
        # Same rule as the seed prompt: no file means zero habits,
        # never a problem.
        return []
    rows = _table_rows(lines)
    habits = []
    for idx in rows[2:]:
        cells = _row_cells(lines[idx])
        key = _row_key(cells) if cells else None
        if key is None:
            continue  # malformed row: skipped here, preserved on write
        habits.append({"key": key, "title": cells[1],
                       "note": cells[4] if len(cells) > 4 else ""})
    return habits


def _validate_text(value, field, limit):
    if not isinstance(value, str):
        raise ValueError(field + " must be a string")
    if any(ch in value for ch in ("|", "`", "\r", "\n")):
        raise ValueError(field + " may not contain |, backtick, or newline")
    if len(value) > limit:
        raise ValueError(field + " too long (max %d)" % limit)
    return value.strip()


def derive_key(title):
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    key = "habit-" + slug
    if not slug:
        raise ValueError("title must contain a letter or digit")
    return key


def add_habit(title, note):
    title = _validate_text(title, "title", TITLE_MAX)
    note = _validate_text(note, "note", NOTE_MAX)
    if not title:
        raise ValueError("title required")
    key = derive_key(title)
    try:
        lines = _read_lines()
    except FileNotFoundError:
        raise SectionMissing()
    rows = _table_rows(lines)
    existing = {_row_key(_row_cells(lines[idx]) or []) for idx in rows[2:]}
    if key in existing:
        raise ValueError("habit already exists")
    lines.insert(rows[-1] + 1,
                 "| `%s` | %s | today | daily | %s |" % (key, title, note))
    _write_lines(lines)


def remove_habit(key):
    if not isinstance(key, str) or not key:
        raise ValueError("key required")
    lines = _read_lines()
    rows = _table_rows(lines)
    for idx in rows[2:]:
        if _row_key(_row_cells(lines[idx]) or []) == key:
            del lines[idx]
            _write_lines(lines)
            return
    raise KeyError(key)


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "reminders/1"

    def _send(self, status, body, content_type):
        encoded = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/":
            self._send(200, PAGE, "text/html; charset=utf-8")
        elif path == "/api/reminders":
            self._send(200, json.dumps(load_snapshot()),
                       "application/json")
        elif path == "/api/habits":
            try:
                habits = read_habits()
            except SectionMissing:
                sys.stderr.write("reminders 500 /api/habits:"
                                 " section missing\n")
                self._send(500, '{"error":"habits section not found"}',
                           "application/json")
                return
            except OSError:
                sys.stderr.write("reminders 500 /api/habits: read error\n")
                self._send(500, '{"error":"habits unreadable"}',
                           "application/json")
                return
            self._send(200, json.dumps({"habits": habits}),
                       "application/json")
        elif path == "/health":
            self._send(200, '{"ok":true}', "application/json")
        else:
            sys.stderr.write("reminders 404 %s\n" % path[:80])
            self._send(404, "not found", "text/plain")

    def do_POST(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path != "/api/habits":
            self._send(404, "not found", "text/plain")
            return
        # Auth before the body is read; fail closed when unset.
        if not EDIT_TOKEN:
            self._send(403, '{"error":"editing disabled"}',
                       "application/json")
            return
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            self._send(401, '{"error":"token required"}',
                       "application/json")
            return
        if not hmac.compare_digest(header[7:], EDIT_TOKEN):
            sys.stderr.write("reminders 403 /api/habits: bad token\n")
            self._send(403, '{"error":"wrong token"}',
                       "application/json")
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            self._send(413, '{"error":"body too large"}',
                       "application/json")
            return
        try:
            payload = json.loads(self.rfile.read(length))
        except ValueError:
            self._send(400, '{"error":"malformed JSON"}',
                       "application/json")
            return
        if not isinstance(payload, dict):
            self._send(400, '{"error":"object expected"}',
                       "application/json")
            return
        try:
            if payload.get("action") == "add":
                add_habit(payload.get("title"), payload.get("note", ""))
            elif payload.get("action") == "remove":
                remove_habit(payload.get("key"))
            else:
                self._send(400, '{"error":"unknown action"}',
                           "application/json")
                return
        except ValueError as exc:
            self._send(400, json.dumps({"error": str(exc)}),
                       "application/json")
            return
        except KeyError:
            self._send(404, '{"error":"habit not found"}',
                       "application/json")
            return
        except (SectionMissing, FileNotFoundError):
            sys.stderr.write("reminders 500 /api/habits:"
                             " section missing\n")
            self._send(500, '{"error":"habits section not found"}',
                       "application/json")
            return
        except OSError:
            sys.stderr.write("reminders 500 /api/habits: write error\n")
            self._send(500, '{"error":"habits write failed"}',
                       "application/json")
            return
        self._send(200, json.dumps({"habits": read_habits()}),
                   "application/json")

    def log_message(self, *args):
        pass


def main():
    server = http.server.HTTPServer(("0.0.0.0", PORT), Handler)
    # 0.0.0.0 bind is deliberate (same reason as the WebUI): compose
    # publishes 127.0.0.1:8300 on the host and Docker forwards to the
    # container interface, not its loopback. Tailnet-only via serve.
    sys.stderr.write("reminders listening on :%d\n" % PORT)
    server.serve_forever()


if __name__ == "__main__":
    main()
