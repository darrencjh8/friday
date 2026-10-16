/**
 * Issue #783 Phase 2: portfolio-tracker's processing contract for Hermes
 * email-intake. Same shape as the expense-tracker's: one signed request per
 * email, a typed status, notifications captured for Hermes, booked once.
 *
 * The portfolio orchestrator is a model tool loop, so the status is derived
 * from the tools it actually ran, never from its free-text answer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("../src/email_handler.js", () => ({
  extractEmailContent: vi.fn(async (raw) =>
    String(raw).includes("ENCRYPTED-PDF") ? "x\n[PDF_ENCRYPTED: y]" : "plain",
  ),
}));

import {
  PortfolioProcessingService,
  RequestJournal,
  createProcessHandler,
  mountProcessingRoute,
  signProcessRequest,
  STATUS,
} from "../src/processing.js";
import { ToolRegistry } from "../src/tools.js";

const raw = (s = "Subject: trade\n\nBought 10 ABC") => Buffer.from(s).toString("base64");

/** A fake orchestrator that "runs" the given tool calls through the registry. */
function orchestratorRunning(tools, calls, outcome = { action: "completed", details: "done" }) {
  return {
    processEmail: vi.fn(async () => {
      for (const [name, args] of calls) await tools.executeTool(name, args);
      return outcome;
    }),
  };
}

function fakeTools(results = {}) {
  return {
    _observer: null,
    _sink: null,
    sent: [],
    setCallObserver(fn) { this._observer = fn; },
    setNotificationSink(fn) { this._sink = fn; },
    async executeTool(name, args) {
      if (name === "notify_user") {
        if (this._sink) return this._sink(args.message);
        this.sent.push(args.message);
        return { status: "sent" };
      }
      const result = results[name] ?? { status: "ok" };
      this._observer?.(name, args, result);
      return result;
    },
  };
}

describe("PortfolioProcessingService (#783)", () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pp-proc-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const make = (tools, orchestrator) =>
    new PortfolioProcessingService({ orchestrator, tools, journal: new RequestJournal(join(dir, "p.db")) });
  const req = (over = {}) => ({ request_id: "req-p0000001", evidence: { raw_email_b64: raw() }, ...over });

  it("rejects malformed requests without running the model", async () => {
    const tools = fakeTools();
    const orch = orchestratorRunning(tools, []);
    const svc = make(tools, orch);
    for (const bad of [{ request_id: "x" }, { evidence: {} }, { evidence: { raw_email_b64: "%%%" } }, { evidence: { path: "/etc" } }]) {
      expect((await svc.process(req(bad))).status).toBe(STATUS.INVALID);
    }
    expect(orch.processEmail).not.toHaveBeenCalled();
  });

  it("encrypted evidence is blocked before the model runs", async () => {
    const tools = fakeTools();
    const orch = orchestratorRunning(tools, []);
    const res = await make(tools, orch).process(req({ evidence: { raw_email_b64: raw("ENCRYPTED-PDF") } }));
    expect(res.status).toBe(STATUS.BLOCKED_ENCRYPTED);
    expect(orch.processEmail).not.toHaveBeenCalled();
  });

  it("a successful insert means processed", async () => {
    const tools = fakeTools({ insert_pp_transaction: { status: "inserted", transaction_id: "pp1" } });
    const orch = orchestratorRunning(tools, [["check_duplicate", {}], ["insert_pp_transaction", { amount: 1 }]]);
    const res = await make(tools, orch).process(req());
    expect(res.status).toBe(STATUS.PROCESSED);
    expect(res.bookings).toEqual([{ tool: "insert_pp_transaction", transaction_id: "pp1" }]);
  });

  it("a duplicate check with no insert means duplicate", async () => {
    const tools = fakeTools({ check_duplicate: { is_duplicate: true } });
    const orch = orchestratorRunning(tools, [["check_duplicate", {}]]);
    expect((await make(tools, orch).process(req())).status).toBe(STATUS.DUPLICATE);
  });

  it("asking the user means needs_confirmation, even if something else ran", async () => {
    const tools = fakeTools();
    const orch = orchestratorRunning(tools, [["ask_user_confirmation", { question: "q" }]]);
    expect((await make(tools, orch).process(req())).status).toBe(STATUS.NEEDS_CONFIRMATION);
  });

  it("a failed insert means failed, never processed", async () => {
    const tools = fakeTools({ insert_pp_transaction: { error: "bridge down" } });
    const orch = orchestratorRunning(tools, [["insert_pp_transaction", {}]]);
    expect((await make(tools, orch).process(req())).status).toBe(STATUS.FAILED);
  });

  it("an orchestrator error means failed", async () => {
    const tools = fakeTools();
    const orch = orchestratorRunning(tools, [], { action: "error", details: "max iterations" });
    expect((await make(tools, orch).process(req())).status).toBe(STATUS.FAILED);
  });

  it("no booking tool at all means skipped", async () => {
    const tools = fakeTools();
    const orch = orchestratorRunning(tools, [["log_decision", { action: "skip" }]]);
    expect((await make(tools, orch).process(req())).status).toBe(STATUS.SKIPPED);
  });

  it("captures notifications instead of sending them, then restores delivery", async () => {
    const tools = fakeTools();
    const orch = orchestratorRunning(tools, [["notify_user", { message: "Bought 10 ABC" }]]);
    const res = await make(tools, orch).process(req());
    expect(tools.sent).toEqual([]);
    expect(res.messages).toEqual(["Bought 10 ABC"]);
    await tools.executeTool("notify_user", { message: "later" });
    expect(tools.sent).toEqual(["later"]);
  });

  it("books once: a retry replays; an interrupted request needs reconciliation", async () => {
    const tools = fakeTools({ insert_pp_transaction: { status: "inserted" } });
    const orch = orchestratorRunning(tools, [["insert_pp_transaction", {}]]);
    const svc = make(tools, orch);
    await svc.process(req());
    expect(await svc.process(req())).toMatchObject({ replay: true, status: STATUS.PROCESSED });
    svc._journal.begin("req-p0000002");
    expect(await svc.process(req({ request_id: "req-p0000002" }))).toMatchObject({
      status: STATUS.FAILED,
      reason: "needs_reconciliation",
    });
    expect(orch.processEmail).toHaveBeenCalledTimes(1);
  });

  it("a thrown error releases the request for retry", async () => {
    const tools = fakeTools();
    const orch = { processEmail: vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ action: "completed" }) };
    const svc = make(tools, orch);
    expect((await svc.process(req())).status).toBe(STATUS.FAILED);
    expect((await svc.process(req())).status).toBe(STATUS.SKIPPED);
  });

  it("runs one request at a time", async () => {
    let active = 0;
    let peak = 0;
    const tools = fakeTools();
    const orch = {
      processEmail: vi.fn(async () => {
        active += 1; peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
        return { action: "completed" };
      }),
    };
    const svc = make(tools, orch);
    await Promise.all(["req-q0000001", "req-q0000002", "req-q0000003"].map((id) => svc.process(req({ request_id: id }))));
    expect(peak).toBe(1);
  });
});

describe("ToolRegistry hooks (#783)", () => {
  it("notify_user goes to the sink and every call reaches the observer", async () => {
    const reg = new ToolRegistry({}, { check: () => true }, null, null, null);
    const seen = [];
    const calls = [];
    reg.setNotificationSink(async (m) => (seen.push(m), { status: "captured" }));
    reg.setCallObserver((name, _a, result) => calls.push([name, result]));

    await reg.executeTool("notify_user", { message: "hi" });
    await reg.executeTool("check_duplicate", { date: "2026-01-01", amount_cents: 1, account_id: "a", type: "BUY" });

    expect(seen).toEqual(["hi"]);
    expect(calls).toContainEqual(["check_duplicate", { is_duplicate: true }]);
  });
});

describe("ToolRegistry hooks see thrown errors (#783)", () => {
  it("a booking tool that throws is observed as an error", async () => {
    const reg = new ToolRegistry({}, null, null, null, null);
    reg._dispatch = async () => { throw new Error("bridge down"); };
    const calls = [];
    reg.setCallObserver((name, _a, result) => calls.push([name, result]));
    await reg.executeTool("insert_pp_transaction", {});
    expect(calls).toEqual([["insert_pp_transaction", { error: "bridge down" }]]);
  });
});

describe("portfolio process HTTP handler (#783)", () => {
  const body = { request_id: "req-h0000001", evidence: { raw_email_b64: raw() } };
  const call = (handler, sig) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    return handler({ body, get: (h) => (h === "X-Process-Signature" ? sig : undefined) }, res).then(() => res);
  };

  it("refuses unsigned, mis-signed, or unconfigured requests", async () => {
    const service = { process: vi.fn() };
    expect((await call(createProcessHandler({ service, secret: "s" }), undefined)).code).toBe(403);
    expect((await call(createProcessHandler({ service, secret: "s" }), "00")).code).toBe(403);
    expect((await call(createProcessHandler({ service, secret: "" }), signProcessRequest(body, ""))).code).toBe(403);
    expect(service.process).not.toHaveBeenCalled();
  });

  it("accepts a signed request; the signature is bound to the portfolio kind", async () => {
    const service = { process: vi.fn(async () => ({ status: STATUS.PROCESSED })) };
    const res = await call(createProcessHandler({ service, secret: "s" }), signProcessRequest(body, "s"));
    expect(res.code).toBe(200);
    expect(signProcessRequest(body, "s")).not.toBe(signProcessRequest(body, "s", "transaction"));
  });
});

describe("mountProcessingRoute (#783)", () => {
  it("mounts POST /process/portfolio with a signed handler", () => {
    const routes = {};
    const app = { post: (p, h) => (routes[p] = h) };
    mountProcessingRoute(app, {
      orchestrator: { processEmail: vi.fn() },
      tools: fakeTools(),
      cfg: { processingDbPath: ":memory:", hermesWebhookSecret: "s" },
    });
    expect(Object.keys(routes)).toEqual(["/process/portfolio"]);
    expect(typeof routes["/process/portfolio"]).toBe("function");
  });
});
