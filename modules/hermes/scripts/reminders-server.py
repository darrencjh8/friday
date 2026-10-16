#!/usr/bin/env python3
"""Read-only reminders dashboard (stdlib only).

Serves the structured snapshot written by wiki-reminder-tasks.py
--snapshot-out as a tailnet-only page: GET / renders the dashboard,
GET /api/reminders returns the snapshot JSON, GET /health answers ok.
Everything else is 404. No secrets, tokens, or task data are logged —
only the startup line and 4xx/5xx statuses hit stderr.
"""
import http.server
import json
import os
import sys

PORT = int(os.environ.get("REMINDERS_PORT", "8300"))
SNAPSHOT = os.environ.get("REMINDERS_SNAPSHOT",
                           "/opt/data/reminders/reminders.json")

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
</script>
</main></body></html>
"""


def load_snapshot():
    try:
        with open(SNAPSHOT, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {"version": 1, "generated_at": None, "run_date": None,
                "task_list": "Planned", "items": [], "problems": [],
                "summary": {"created": 0, "skipped": 0, "pending": 0}}


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
        elif path == "/health":
            self._send(200, '{"ok":true}', "application/json")
        else:
            sys.stderr.write("reminders 404 %s\n" % path[:80])
            self._send(404, "not found", "text/plain")

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
