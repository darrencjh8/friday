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
SECTIONS = {"daily": "## Daily candidates",
            "weekly": "## Weekly candidates",
            "monthly": "## Monthly candidate"}
PREFIXES = {"daily": "habit-", "weekly": "weekly-", "monthly": "monthly-"}
TITLE_MAX = 120
NOTE_MAX = 500
WHEN_MAX = 120
# Beyond | ` CR LF: every char str.splitlines() would break a written row on.
BAD_CHARS = ("|", "`", "\r", "\n", "\x0b", "\x0c", "\x1c", "\x1d",
            "\x1e", "\x85", "\u2028", "\u2029")

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reminders</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%E2%8F%B0%3C/text%3E%3C/svg%3E">
<style>
:root{--bg:#f4f6fb;--card:#fff;--ink:#141a24;--muted:#5b6577;--line:#e2e7f0;
--ok:#0a7d43;--warn:#8a5a00;--err:#b00020;--accent:#2563eb;
--ok-soft:#e0f3e9;--warn-soft:#f8eeda;--err-soft:#fbe4e9;--accent-soft:#e4ecfd}
@media (prefers-color-scheme:dark){:root{--bg:#0f131a;--card:#171c26;
--ink:#e8ecf4;--muted:#9aa5b8;--line:#28303d;--ok:#5fd39a;--warn:#e6bf6a;
--err:#ff8a9b;--accent:#8fb0ff;--ok-soft:#14301f;--warn-soft:#322610;
--err-soft:#38141e;--accent-soft:#1d2a4a}}
body.light{--bg:#f4f6fb;--card:#fff;--ink:#141a24;--muted:#5b6577;
--line:#e2e7f0;--ok:#0a7d43;--warn:#8a5a00;--err:#b00020;--accent:#2563eb;
--ok-soft:#e0f3e9;--warn-soft:#f8eeda;--err-soft:#fbe4e9;--accent-soft:#e4ecfd}
body.dark{--bg:#0f131a;--card:#171c26;--ink:#e8ecf4;--muted:#9aa5b8;
--line:#28303d;--ok:#5fd39a;--warn:#e6bf6a;--err:#ff8a9b;--accent:#8fb0ff;
--ok-soft:#14301f;--warn-soft:#322610;--err-soft:#38141e;--accent-soft:#1d2a4a}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--ink);
font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:960px;margin:0 auto;padding:0 16px 72px}
.topbar{position:sticky;top:0;z-index:5;padding:14px 16px;margin-bottom:16px;
background:var(--card);border-bottom:1px solid var(--line)}
.topbar-in{display:flex;justify-content:space-between;align-items:center;
max-width:960px;margin:0 auto}
h1{font-size:1.5rem;margin:0;letter-spacing:-.01em}
.card-title{margin:0 0 10px;font-size:1.05rem}
.hint{color:var(--muted);font-weight:400;font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;
padding:18px;margin-bottom:14px;box-shadow:0 1px 2px rgba(15,19,26,.06)}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600}
tr.group th{padding:12px 8px 2px;font-size:12px;text-transform:uppercase;
letter-spacing:.05em;border-bottom:none}
tr.attn td:first-child{border-left:3px solid var(--warn);padding-left:6px}
.pill{display:inline-block;font-size:12px;font-weight:600;padding:2px 10px;
border-radius:999px;color:var(--muted)}
.pill.created,.pill.skipped{background:var(--ok-soft);color:var(--ok)}
.pill.pending{background:var(--warn-soft);color:var(--warn)}
.pill.overdue-manual,.pill.conflict,.pill.create-failed,
.pill.unclassified{background:var(--err-soft);color:var(--err)}
.chips{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.chip{display:inline-block;font-size:12px;font-weight:600;padding:2px 10px;
border-radius:999px;color:var(--muted)}
.chip.ok{background:var(--ok-soft);color:var(--ok)}
.chip.warn{background:var(--warn-soft);color:var(--warn)}
.chip.err{background:var(--err-soft);color:var(--err)}
.chip.date{font-weight:400}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0 14px}
.tab{border:1px solid var(--line);background:transparent;color:var(--muted);
border-radius:999px;padding:6px 14px;font-weight:600}
.tab.active{background:var(--accent-soft);color:var(--accent);
border-color:currentColor}
.tab-count{font-weight:400;opacity:.75}
.empty{border:1px dashed var(--line);border-radius:10px;padding:10px 14px;
color:var(--muted);font-size:14px}
button,input,select{font-family:inherit;font-size:16px}
.field{border:1px solid var(--line);border-radius:10px;padding:8px 10px;
background:var(--card);color:var(--ink)}
.field::placeholder{color:var(--muted)}
.btn-primary{background:var(--accent);border:1px solid var(--accent);
color:#fff;border-radius:10px;padding:8px 16px;font-weight:600}
.btn-primary:disabled{opacity:.55}
.btn-quiet{background:transparent;border:1px solid var(--line);
color:var(--muted);border-radius:999px;padding:3px 12px;font-size:13px;
font-weight:600}
button:focus-visible,input:focus-visible,select:focus-visible,
summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
#h-form{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
#h-form .f1{flex:1;min-width:120px}
#h-form .f2{flex:2;min-width:140px}
.note{white-space:pre-wrap;color:var(--muted);font-size:13px}
@media (max-width:600px){th,td{padding:4px 4px}.card{padding:16px}}
</style></head>
<body><main>
<div class="topbar"><div class="topbar-in">
<h1>Reminders</h1>
<select id="theme" class="field">
<option value="auto">Auto</option><option value="light">Light</option>
<option value="dark">Dark</option>
</select>
</div></div>
<div class="card">
<h3 class="card-title">Habits <span class="hint">live from the wiki —
edits apply from the next 08:15 run</span></h3>
<div class="tabs" id="h-tabs">
<button type="button" class="tab active" data-tab="daily">Daily
<span class="tab-count" id="h-count-daily"></span></button>
<button type="button" class="tab" data-tab="weekly">Weekly
<span class="tab-count" id="h-count-weekly"></span></button>
<button type="button" class="tab" data-tab="monthly">Monthly
<span class="tab-count" id="h-count-monthly"></span></button>
</div>
<div data-section="daily">
<table><tbody id="habit-rows-daily"></tbody></table>
<p id="habit-empty-daily" class="empty" hidden>No daily habits.</p>
</div>
<div data-section="weekly" hidden>
<table><tbody id="habit-rows-weekly"></tbody></table>
<p id="habit-empty-weekly" class="empty" hidden>No weekly habits.</p>
</div>
<div data-section="monthly" hidden>
<table><tbody id="habit-rows-monthly"></tbody></table>
<p id="habit-empty-monthly" class="empty" hidden>No monthly habits.</p>
</div>
<form id="h-form">
<select id="h-section" class="field">
<option value="daily">Daily</option><option value="weekly">Weekly</option>
<option value="monthly">Monthly</option>
</select>
<input id="h-title" class="field f1" placeholder="New habit" maxlength="120">
<input id="h-when" class="field f1" placeholder="When (e.g. Sunday)"
maxlength="120" hidden>
<input id="h-note" class="field f2" placeholder="Note (optional)"
maxlength="500">
<button id="h-add" type="submit" class="btn-primary">Add</button>
</form>
<details id="h-token-details" style="margin-top:10px"><summary
class="hint">Edit token</summary>
<input id="h-token" type="password" placeholder="edit token" class="field"
style="width:100%;margin-top:6px"></details>
<p class="hint" style="margin-top:10px">Removing a habit stops future
tasks; tasks already created in Google Tasks are never deleted — clear
them there. Titles and notes may not contain | or backticks.</p>
<p id="habit-msg" class="hint"></p>
</div>
<div class="card">
<div class="chips" id="meta"><span class="chip date">loading…</span></div>
<table>
<thead><tr><th>Reminder</th><th>Type</th><th>Due</th><th>Status</th></tr></thead>
<tbody id="rows"></tbody>
</table>
<p id="rows-empty" class="empty" hidden>No reminders in the snapshot.</p>
</div>
<div class="card" id="problems-card" hidden>
<h3 style="margin-top:0">Problems</h3>
<table><tbody id="problems"></tbody></table>
</div>
<div class="card" id="notes-card" hidden>
<h3 style="margin-top:0">Notes</h3>
<div id="notes"></div>
</div>
<script>
// Served under a path prefix (tailscale --set-path /reminders): derive the
// API base from the mount path so fetches never escape it.
const BASE = location.pathname.replace(/\/+$/, "");
function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function load(k) { try { return localStorage.getItem(k) || ""; }
                   catch (e) { return ""; } }
const tokenBox = document.getElementById("h-token");
tokenBox.value = load("reminders-edit-token");
tokenBox.addEventListener("change", () => {
  store("reminders-edit-token", tokenBox.value);
});
const themeSel = document.getElementById("theme");
function applyTheme(v) { document.body.className = v === "auto" ? "" : v; }
themeSel.value = load("reminders-theme") || "auto";
applyTheme(themeSel.value);
themeSel.addEventListener("change", () => {
  store("reminders-theme", themeSel.value);
  applyTheme(themeSel.value);
});
function habitMsg(text) {
  document.getElementById("habit-msg").textContent = text;
}
async function loadHabits() {
  let data;
  try {
    const r = await fetch(BASE + "/api/habits", {cache: "no-store"});
    if (!r.ok) throw new Error("http " + r.status);
    data = await r.json();
  } catch (e) {
    for (const section of ["daily", "weekly", "monthly"]) {
      document.getElementById("h-count-" + section).textContent = "";
    }
    habitMsg("Habits unavailable — the wiki could not be read.");
    return;
  }
  for (const section of ["daily", "weekly", "monthly"]) {
    const rows = document.getElementById("habit-rows-" + section);
    rows.textContent = "";
    const list = data[section] || [];
    document.getElementById("h-count-" + section).textContent =
      "(" + list.length + ")";
    document.getElementById("habit-empty-" + section).hidden =
      list.length > 0;
    for (const h of list) {
      const tr = document.createElement("tr");
      const tdTitle = document.createElement("td");
      tdTitle.textContent = h.title;
      const cells = [tdTitle];
      if (section !== "daily") {
        const tdWhen = document.createElement("td");
        tdWhen.textContent = h.when || "";
        cells.push(tdWhen);
      }
      const tdNote = document.createElement("td");
      tdNote.className = "note";
      tdNote.textContent = h.note || "";
      cells.push(tdNote);
      const tdBtn = document.createElement("td");
      tdBtn.style.textAlign = "right";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-quiet";
      btn.textContent = "Remove";
      btn.addEventListener("click", () => editHabits(
        {action: "remove", section: section, key: h.key}, btn));
      tdBtn.appendChild(btn);
      cells.push(tdBtn);
      tr.append(...cells);
      rows.appendChild(tr);
    }
  }
}
const tokDetails = document.getElementById("h-token-details");
async function editHabits(payload, button) {
  if (button) button.disabled = true;
  habitMsg("Saving…");
  try {
    let r;
    try {
      r = await fetch(BASE + "/api/habits", {
        method: "POST",
        headers: {"Content-Type": "application/json",
                  "Authorization": "Bearer " + tokenBox.value},
        body: JSON.stringify(payload)});
    } catch (e) {
      habitMsg("Request failed: " + e.message);
      return;
    }
    if (r.status === 401 || r.status === 403) {
      tokDetails.open = true;
      tokenBox.focus();
      habitMsg("Edit token missing or wrong — set it above.");
      return;
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      habitMsg(data.error || ("Error " + r.status));
      return;
    }
    habitMsg(payload.action === "add" ? "Added"
                                      : "Removed");
    loadHabits();
  } finally {
    if (button) button.disabled = false;
  }
}
const addBtn = document.getElementById("h-add");
const whenBox = document.getElementById("h-when");
const sectionSel = document.getElementById("h-section");
sectionSel.addEventListener("change", () => switchTab(sectionSel.value));
// Tab bar: one section visible at a time; two-sided sync with the form
// select (programmatic .value sets do not fire change, so switchTab
// sets whenBox.hidden directly and the manual listener calls switchTab).
const tabButtons = Array.from(document.querySelectorAll("#h-tabs .tab"));
function switchTab(name) {
  for (const b of tabButtons)
    b.classList.toggle("active", b.dataset.tab === name);
  for (const wrap of document.querySelectorAll("[data-section]"))
    wrap.hidden = wrap.dataset.section !== name;
  sectionSel.value = name;
  whenBox.hidden = sectionSel.value === "daily";
}
for (const b of tabButtons)
  b.addEventListener("click", () => switchTab(b.dataset.tab));
document.getElementById("h-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const title = document.getElementById("h-title").value.trim();
  if (!title) { habitMsg("Title required."); return; }
  const payload = {action: "add", section: sectionSel.value, title: title,
                   note: document.getElementById("h-note").value.trim()};
  if (sectionSel.value !== "daily") {
    payload.when = whenBox.value.trim();
    if (!payload.when) { habitMsg("When required."); return; }
  }
  document.getElementById("h-title").value = "";
  document.getElementById("h-note").value = "";
  whenBox.value = "";
  addBtn.disabled = true;
  editHabits(payload, addBtn);
});
async function load() {
  const meta = document.getElementById("meta");
  let snap;
  try {
    const r = await fetch(BASE + "/api/reminders", {cache: "no-store"});
    if (!r.ok) throw new Error("http " + r.status);
    snap = await r.json();
  } catch (e) {
    meta.textContent = "No snapshot yet — the daily job has not run.";
    return;
  }
  const items = snap.items || [];
  const sum = snap.summary || {};
  const probs = snap.problems || [];
  meta.textContent = "";
  addChip(meta, "ok", "created " + (sum.created ?? 0));
  addChip(meta, "", "skipped " + (sum.skipped ?? 0));
  addChip(meta, "warn", "pending " + (sum.pending ?? 0));
  if (probs.length) addChip(meta, "err", "problems " + probs.length);
  addChip(meta, "date", "run " + (snap.run_date || "?"));
  const rows = document.getElementById("rows");
  rows.textContent = "";
  document.getElementById("rows-empty").hidden = items.length > 0;
  // Partition into Needs-attention (pending-like; unknown statuses count
  // as needing attention) and Done, pending group first, server order
  // kept inside each group.
  const ATTENTION = new Set(["pending", "overdue-manual", "conflict",
                             "create-failed", "unclassified"]);
  const groups = [[], []];
  for (const it of items)
    groups[ATTENTION.has(it.status) ? 0 : 1].push(it);
  const gname = ["Needs attention", "Done"];
  for (let g = 0; g < 2; g++) {
    if (!groups[g].length) continue;
    const cap = document.createElement("tr");
    cap.className = "group";
    const th = document.createElement("th");
    th.colSpan = 4;
    th.textContent = gname[g];
    cap.appendChild(th);
    rows.appendChild(cap);
    for (const it of groups[g]) rows.appendChild(snapshotRow(it, g === 0));
  }
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
function addChip(box, cls, text) {
  const sp = document.createElement("span");
  sp.className = "chip" + (cls ? " " + cls : "");
  sp.textContent = text;
  box.appendChild(sp);
}
function snapshotRow(it, attention) {
  const tr = document.createElement("tr");
  if (attention) tr.className = "attn";
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
  return tr;
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


def _table_rows(lines, heading):
    """Line indexes of one section's table (header first).

    Raises SectionMissing when the heading or table is absent, so a
    write never guesses where rows live.
    """
    head = None
    for i, line in enumerate(lines):
        if line.strip() == heading:
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
        return {name: [] for name in SECTIONS}
    result = {}
    for name, heading in SECTIONS.items():
        try:
            rows = _table_rows(lines, heading)
        except SectionMissing:
            result[name] = []  # absent section reads empty; writes 500
            continue
        habits = []
        for idx in rows[2:]:
            cells = _row_cells(lines[idx])
            key = _row_key(cells) if cells else None
            if key is None:
                continue  # malformed row: skipped here, preserved on write
            habits.append({"key": key, "title": cells[1],
                           "when": cells[2] if len(cells) > 2 else "",
                           "note": cells[4] if len(cells) > 4 else ""})
        result[name] = habits
    return result


def _validate_text(value, field, limit):
    if not isinstance(value, str):
        raise ValueError(field + " must be a string")
    if any(ch in value for ch in BAD_CHARS):
        raise ValueError(field + " may not contain |, backtick, or"
                         " line-break characters")
    if len(value) > limit:
        raise ValueError(field + " too long (max %d)" % limit)
    return value.strip()


def derive_key(section, title):
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    key = PREFIXES[section] + slug
    if not slug:
        raise ValueError("title must contain a letter or digit")
    return key


def _check_section(section):
    if section not in SECTIONS:
        raise ValueError("unknown section")


def add_habit(section, title, note, when):
    _check_section(section)
    title = _validate_text(title, "title", TITLE_MAX)
    note = _validate_text(note, "note", NOTE_MAX)
    if not title:
        raise ValueError("title required")
    if section == "daily":
        when = "today"
    else:
        when = _validate_text(when, "when", WHEN_MAX)
        if not when:
            raise ValueError("when required")
    key = derive_key(section, title)
    try:
        lines = _read_lines()
    except FileNotFoundError:
        raise SectionMissing()
    rows = _table_rows(lines, SECTIONS[section])
    existing = {_row_key(_row_cells(lines[idx]) or []) for idx in rows[2:]}
    if key in existing:
        raise ValueError("habit already exists")
    lines.insert(rows[-1] + 1,
                 "| `%s` | %s | %s | %s | %s |"
                 % (key, title, when, section, note))
    _write_lines(lines)


def remove_habit(section, key):
    _check_section(section)
    if not isinstance(key, str) or not key:
        raise ValueError("key required")
    lines = _read_lines()
    rows = _table_rows(lines, SECTIONS[section])
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
        self.send_header("Cache-Control", "no-store")
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
            except OSError:
                sys.stderr.write("reminders 500 /api/habits: read error\n")
                self._send(500, '{"error":"habits unreadable"}',
                           "application/json")
                return
            self._send(200, json.dumps(habits), "application/json")
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
        token = header[7:]
        if not token.isascii() or not hmac.compare_digest(token,
                                                          EDIT_TOKEN):
            sys.stderr.write("reminders 403 /api/habits: bad token\n")
            self._send(403, '{"error":"wrong token"}',
                       "application/json")
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._send(400, '{"error":"bad Content-Length"}',
                       "application/json")
            return
        if length < 0 or length > MAX_BODY:
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
            section = payload.get("section", "daily")
            if payload.get("action") == "add":
                add_habit(section, payload.get("title"),
                          payload.get("note", ""), payload.get("when", ""))
            elif payload.get("action") == "remove":
                remove_habit(section, payload.get("key"))
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
        self._send(200, json.dumps(read_habits()),
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
