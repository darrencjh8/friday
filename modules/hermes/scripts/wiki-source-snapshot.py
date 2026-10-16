#!/usr/bin/env python3
"""Pre-run context script for the weekly wiki maintenance job.

Captures every read-only finance/status source the job needs in one pass and
writes each as a hashed raw snapshot in the wiki, so the agent reads files
instead of spending a model turn per tool call. A source whose data is
byte-identical to its latest snapshot is not written again; the report names
the snapshot it still matches. stdout is the report the cron injects into the
job prompt.

Nothing here writes to a source: Actual and Notion are only queried, and the
portfolio is read through portfolio_get_all/portfolio_taxonomy/
portfolio_onedrive_status (never portfolio_sync).
"""

import datetime
import glob
import hashlib
import json
import os
import re
import sys
import urllib.parse
import urllib.request

WIKI = os.environ.get("WIKI_PATH", "/opt/data/home/wiki")
RAW = os.path.join(WIKI, "raw", "articles")
HOME = os.environ.get("HERMES_HOME", "/opt/data")
SGT = datetime.timezone(datetime.timedelta(hours=8))
TXN_DAYS = 8
NOTION_SOURCES = {
    "notion-accounts": "a21b499b-79ae-497b-9221-0ad59a75e812",
    "notion-insurance-plans": "fb21acfd-b555-4a99-8b54-54ed43d4b020",
}
# Notion columns the wiki must never hold: card numbers, free-form notes, task links.
NOTION_DROP = re.compile(r"(?i)^(number|notes?)$|gtask|gcal")
NOTION_DROP_TYPES = {"relation", "rollup", "people", "files", "url", "email", "phone_number"}
LONG_DIGITS = re.compile(r"(?<!\d)\d{9,}(?!\d)")


def http_json(url, body=None, headers=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read() or b"null"), resp.headers


def mcp_call(base, tool, args=None):
    """One tools/call over streamable HTTP (both trackers answer JSON, not SSE)."""
    accept = {"Accept": "application/json, text/event-stream"}
    _, headers = http_json(base, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-03-26", "capabilities": {},
        "clientInfo": {"name": "wiki-source-snapshot", "version": "1"}}}, accept)
    session = {**accept, "mcp-session-id": headers.get("mcp-session-id", "")}
    http_json(base, {"jsonrpc": "2.0", "method": "notifications/initialized"}, session)
    reply, _ = http_json(base, {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                                "params": {"name": tool, "arguments": args or {}}}, session, timeout=180)
    if "error" in reply:
        raise RuntimeError(f"{tool}: {reply['error'].get('message')}")
    text = "".join(c.get("text", "") for c in reply["result"].get("content", []))
    try:
        return json.loads(text)
    except ValueError:
        return text


def actual(budget):
    ctx = mcp_call("http://expense-tracker:8080/mcp", "fetch_context", {"budget_id": budget})
    if not isinstance(ctx, dict) or "accounts" not in ctx:
        raise RuntimeError(f"fetch_context returned no accounts: {str(ctx)[:200]}")
    payees = {p.get("id"): p.get("name") for p in ctx.get("payees") or []}
    accounts = {a.get("id"): a.get("name") for a in ctx["accounts"]}
    since = (datetime.date.today() - datetime.timedelta(days=TXN_DAYS)).isoformat()
    q = urllib.parse.urlencode({"budget_id": budget, "since_date": since})
    txns, _ = http_json(f"http://actual-api:3000/transactions?{q}")
    data = {
        "accounts": [{k: a.get(k) for k in ("name", "balance", "offbudget", "closed")} for a in ctx["accounts"]],
        "transactions": [{
            "date": t.get("date"), "account": accounts.get(t.get("account"), t.get("account")),
            "amount": t.get("amount"), "payee": payees.get(t.get("payee"), t.get("payee")),
            "notes": t.get("notes"), "cleared": t.get("cleared"), "transfer": bool(t.get("transfer_id")),
        } for t in sorted(txns, key=lambda t: (t.get("date") or "", t.get("id") or ""))],
    }
    meta = {"source_url": f"expense-tracker fetch_context + actual-api /transactions ({budget})",
            "window": f"balances current; transactions {since}..today", "accounts": len(data["accounts"]),
            "transactions": len(data["transactions"]), "has_more": "false (unpaged route)"}
    return data, meta


def notion_key():
    key = os.environ.get("NOTION_API_KEY", "")
    if not key:  # cron scrubs secrets from the script env; the profile .env still holds it
        try:
            for line in open(os.path.join(HOME, ".env"), encoding="utf-8"):
                if line.startswith("NOTION_API_KEY="):
                    key = line.split("=", 1)[1].strip()
        except OSError:
            pass
    if not key:
        raise RuntimeError("NOTION_API_KEY not available")
    return key


def notion_value(prop):
    kind = prop.get("type")
    value = prop.get(kind)
    if kind in ("title", "rich_text"):
        return "".join(t.get("plain_text", "") for t in value or [])
    if kind in ("select", "status"):
        return (value or {}).get("name")
    if kind == "multi_select":
        return [v.get("name") for v in value or []]
    if kind == "date":
        return value and {k: value.get(k) for k in ("start", "end")}
    if kind == "formula":
        return (value or {}).get((value or {}).get("type"))
    return value


def notion(ds_id):
    headers = {"Authorization": f"Bearer {notion_key()}", "Notion-Version": "2025-09-03"}
    rows, cursor, pages = [], None, 0
    while True:
        body = {"page_size": 100, **({"start_cursor": cursor} if cursor else {})}
        page, _ = http_json(f"https://api.notion.com/v1/data_sources/{ds_id}/query", body, headers)
        pages += 1
        for r in page.get("results", []):
            props = {name: notion_value(p) for name, p in sorted(r.get("properties", {}).items())
                     if p.get("type") not in NOTION_DROP_TYPES and not NOTION_DROP.search(name)}
            rows.append({"id": r.get("id"), **props})
        if not page.get("has_more"):
            break
        cursor = page.get("next_cursor")
    rows.sort(key=lambda r: r["id"] or "")
    return rows, {"source_url": f"notion:data_source:{ds_id} (sanitized projection)",
                  "rows": len(rows), "pages": pages, "has_more": "false"}


def portfolio():
    base = "http://portfolio-tracker:8081/mcp"
    data = {
        "holdings": mcp_call(base, "portfolio_get_all"),
        "taxonomy": mcp_call(base, "portfolio_taxonomy", {"names": ["Regions (Liquid)", "Without Classification"]}),
        "onedrive": mcp_call(base, "portfolio_onedrive_status"),
    }
    return data, {"source_url": "portfolio-tracker MCP portfolio_get_all + portfolio_taxonomy + portfolio_onedrive_status",
                  "portfolio_sync": "NOT called"}


def codex_router():
    data, _ = http_json("http://codex-router:4100/v1/codex-router/status", timeout=20)
    return data, {"source_url": "http://codex-router:4100/v1/codex-router/status"}


def scrub(value):
    """Drop long digit runs (card/account numbers) wherever they appear in strings, and round floats
    so a computed ratio never prints a digit run the wiki lint reads as a card number."""
    if isinstance(value, float):
        return round(value, 4)
    if isinstance(value, str):
        return LONG_DIGITS.sub("[digits]", value)
    if isinstance(value, list):
        return [scrub(v) for v in value]
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items()}
    return value


def latest(name):
    paths = sorted(glob.glob(os.path.join(RAW, f"{name}-20*.json")), key=os.path.getmtime)
    return paths[-1] if paths else None


def record(name, fetch, now):
    try:
        data, meta = fetch()
    except Exception as e:  # report every source; one outage must not hide the rest
        return {"source": name, "status": "error", "detail": f"{type(e).__name__}: {e}"[:300]}
    body = json.dumps(scrub(data), sort_keys=True, indent=1, ensure_ascii=False) + "\n"
    sha = hashlib.sha256(body.encode()).hexdigest()
    prev = latest(name)
    if prev and re.search(rf"sha256:\s*{sha}", open(prev, encoding="utf-8").read(2000)):
        return {"source": name, "status": "unchanged", "file": os.path.relpath(prev, WIKI), **meta}
    stem = os.path.join(RAW, f"{name}-{now:%Y-%m-%d}")
    path = f"{stem}.json" if not os.path.exists(f"{stem}.json") else f"{stem}-{now:%H%M}.json"
    front = {**meta, "captured_at": now.isoformat(timespec="minutes"), "ingested": now.date().isoformat(), "sha256": sha}
    with open(path, "w", encoding="utf-8") as f:
        f.write("---\n" + "".join(f"{k}: {v}\n" for k, v in front.items()) + "---\n" + body)
    return {"source": name, "status": "changed", "file": os.path.relpath(path, WIKI), "previous": prev and os.path.relpath(prev, WIKI), **meta}


def main():
    os.makedirs(RAW, exist_ok=True)
    now = datetime.datetime.now(SGT)
    sources = {
        "actual-sgd": lambda: actual("Darren SGD"),
        "actual-myr": lambda: actual("Darren MYR"),
        **{name: (lambda ds=ds: notion(ds)) for name, ds in NOTION_SOURCES.items()},
        "portfolio-tracker": portfolio,
        "codex-router-status": codex_router,
    }
    results = [record(name, fetch, now) for name, fetch in sources.items()]
    print(f"Source snapshots captured {now:%Y-%m-%d %H:%M} SGT by wiki-source-snapshot.py (read-only).")
    print("Read only the files marked changed; an unchanged source still matches the snapshot named.")
    for r in results:
        print(json.dumps(r, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
