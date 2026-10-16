/**
 * Issue #796: a dry run of the processing contract, for the pre-cutover parity
 * replay. The whole pipeline runs, including Phase 3, but every tool that could
 * change something (Actual, the dedup journal, memory, the mailbox, Telegram)
 * is recorded with its arguments and answered with a stub. The recorded
 * insert_transaction arguments are exactly what a real run would book.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHmac } from "crypto";

vi.mock("../src/extractors.js", async (orig) => {
  const actual = await orig();
  return { ...actual, extractEmailContent: vi.fn(async (raw) => String(raw)) };
});

import { ToolRegistry } from "../src/tools.js";
import {
  ProcessingService,
  RequestJournal,
  createProcessHandler,
  signProcessRequest,
  STATUS,
} from "../src/processing.js";

const raw = () => Buffer.from("From: bank\nSubject: alert\n\nYou spent SGD 5.00").toString("base64");

describe("ToolRegistry.dryRun", () => {
  let registry;
  beforeEach(() => {
    registry = new ToolRegistry({ dedupDbPath: ":memory:", notifyUrl: "http://notify.invalid" }, null);
  });

  it("records a write with its arguments instead of executing it", async () => {
    const post = vi.spyOn(registry, "_post");
    const handler = vi.spyOn(registry, "_handle_insert_transaction");
    const args = { account_id: "acc-1", date: "2026-01-02", amount_cents: -500, budget_id: "b" };

    const { result, calls } = await registry.dryRun(() => registry.executeTool("insert_transaction", args));

    expect(handler).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: expect.stringMatching(/^dry-run/) });
    expect(calls).toEqual([{ tool: "insert_transaction", args }]);
  });

  it("never sends a notification", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { result, calls } = await registry.dryRun(() =>
      registry.executeTool("notify_user", { message: "hello" }),
    );
    expect(result).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toEqual([{ tool: "notify_user", args: { message: "hello" } }]);
    fetchSpy.mockRestore();
  });

  it.each([
    ["reserve_transfer", { status: "reserved" }],
    ["propose_learning", { offered: false }],
    ["learn_fact", { added: false }],
    ["mark_email_read", { dry_run: true }],
    ["update_transaction", { dry_run: true }],
  ])("stubs %s", async (name, shape) => {
    const handler = vi.spyOn(registry, `_handle_${name}`);
    const { result, calls } = await registry.dryRun(() => registry.executeTool(name, { x: 1 }));
    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject(shape);
    expect(calls).toEqual([{ tool: name, args: { x: 1 } }]);
  });

  it("runs read tools for real and does not record them", async () => {
    const handler = vi
      .spyOn(registry, "_handle_fetch_context")
      .mockResolvedValue({ accounts: [] });
    const { result, calls } = await registry.dryRun(() =>
      registry.executeTool("fetch_context", { budget_id: "b" }),
    );
    expect(handler).toHaveBeenCalledWith({ budget_id: "b" });
    expect(result).toEqual({ accounts: [] });
    expect(calls).toEqual([]);
  });

  it("reports a duplicate but lets the run continue to the would-be booking", async () => {
    vi.spyOn(registry, "_handle_check_duplicate").mockResolvedValue(true);
    const args = { date: "2026-01-02", amount_cents: -500, account_id: "acc-1" };
    const { result, calls } = await registry.dryRun(() => registry.executeTool("check_duplicate", args));
    expect(result).toBe(false);
    expect(calls).toEqual([{ tool: "check_duplicate", args, would_be_duplicate: true }]);
  });

  it("looks up a booked transfer leg without claiming it", async () => {
    registry.setEmailContext("req-1", "", null);
    const lookup = vi.spyOn(registry._dedup, "findInsertedTransferInto").mockReturnValue(null);
    await registry.dryRun(() => registry.executeTool("find_inserted_transfer", { alert_id: "req-1", a: 1 }));
    expect(lookup).toHaveBeenCalledWith({ alert_id: null, a: 1 });
  });

  it("restores real execution afterwards, even after a throw", async () => {
    await expect(registry.dryRun(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const handler = vi.spyOn(registry, "_handle_mark_email_read").mockResolvedValue(true);
    await registry.executeTool("mark_email_read", {});
    expect(handler).toHaveBeenCalled();
  });

  it("never stubs a concurrent real call outside the dry run", async () => {
    const handler = vi.spyOn(registry, "_handle_mark_email_read").mockResolvedValue("real");
    let release;
    const gate = new Promise((r) => (release = r));
    const dry = registry.dryRun(async () => {
      await gate;
      return registry.executeTool("mark_email_read", {});
    });
    // The watcher books while the dry run is still in flight.
    const real = await registry.executeTool("mark_email_read", {});
    release();
    const { result, calls } = await dry;
    expect(real).toBe("real");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ dry_run: true });
    expect(calls).toEqual([{ tool: "mark_email_read", args: {} }]);
  });

  it("still rejects an unknown tool", async () => {
    await expect(registry.dryRun(() => registry.executeTool("no_such_tool", {}))).rejects.toThrow(
      "Unknown tool",
    );
  });
});

describe("ProcessingService dry run", () => {
  let dir;
  let journal;
  let orchestrator;
  let tools;
  let service;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dry-run-"));
    journal = new RequestJournal(join(dir, "p.db"));
    orchestrator = {
      processEmail: vi.fn(async () => ({ action: "insert", details: "ok", transaction_id: "t1" })),
    };
    tools = {
      setNotificationSink: vi.fn(),
      setOfferSink: vi.fn(),
      dryRun: vi.fn(async (fn) => ({
        result: await fn(),
        calls: [{ tool: "insert_transaction", args: { amount_cents: -500 } }],
      })),
    };
    service = new ProcessingService({ orchestrator, statementProcessor: {}, tools, journal });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns the would-be writes and journals nothing", async () => {
    const res = await service.processTransaction({
      request_id: "req-00001",
      evidence: { raw_email_b64: raw() },
      dry_run: true,
    });
    expect(res).toMatchObject({
      request_id: "req-00001",
      status: STATUS.DRY_RUN,
      action: "insert",
      writes: [{ tool: "insert_transaction", args: { amount_cents: -500 } }],
    });
    expect(tools.dryRun).toHaveBeenCalledTimes(1);
    expect(journal.get("req-00001")).toBeNull();
  });

  it("a dry run does not block the real booking of the same request", async () => {
    await service.processTransaction({ request_id: "req-00002", evidence: { raw_email_b64: raw() }, dry_run: true });
    const real = await service.processTransaction({ request_id: "req-00002", evidence: { raw_email_b64: raw() } });
    expect(real.status).toBe(STATUS.PROCESSED);
    expect(orchestrator.processEmail).toHaveBeenCalledTimes(2);
  });

  it("statements have no dry run", async () => {
    const res = await service.processStatement({
      request_id: "req-00003",
      evidence: { raw_email_b64: raw() },
      dry_run: true,
    });
    expect(res).toMatchObject({ status: STATUS.INVALID, reason: "dry_run_unsupported" });
  });

  it("rejects a non-boolean dry_run", async () => {
    const res = await service.processTransaction({
      request_id: "req-00004",
      evidence: { raw_email_b64: raw() },
      dry_run: "yes",
    });
    expect(res).toMatchObject({ status: STATUS.INVALID, reason: "bad_dry_run" });
    expect(orchestrator.processEmail).not.toHaveBeenCalled();
  });
});

describe("dry run signature", () => {
  const secret = "test-secret";

  function call(body, signature) {
    const service = {
      processTransaction: vi.fn(async () => ({ status: "dry_run" })),
      processStatement: vi.fn(),
    };
    const handler = createProcessHandler({ service, kind: "transaction", secret });
    const res = { status: vi.fn(() => res), json: vi.fn() };
    return handler({ body, get: () => signature }, res).then(() => ({ service, res }));
  }

  const body = { request_id: "req-00005", evidence: { raw_email_b64: raw() } };

  it("accepts a dry run signed as a dry run", async () => {
    const dry = { ...body, dry_run: true };
    const { service } = await call(dry, signProcessRequest(dry, secret, "transaction:dry_run"));
    expect(service.processTransaction).toHaveBeenCalled();
  });

  it("rejects a dry run carrying a booking signature", async () => {
    const dry = { ...body, dry_run: true };
    const { service, res } = await call(dry, signProcessRequest(body, secret, "transaction"));
    expect(res.status).toHaveBeenCalledWith(403);
    expect(service.processTransaction).not.toHaveBeenCalled();
  });

  it("a captured dry run cannot be replayed as a booking", async () => {
    const dry = { ...body, dry_run: true };
    const sig = signProcessRequest(dry, secret, "transaction:dry_run");
    const { service, res } = await call(body, sig);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(service.processTransaction).not.toHaveBeenCalled();
  });
});

describe("dry run end to end (real orchestrator and registry)", () => {
  // Fictional alert: a deposit into an own account, decided by the
  // deterministic route, so no LLM is involved.
  const ALERT =
    "You have received SGD 42.50 via FAST transfer on 02 Oct 2026 09:15 SGT. " +
    "To: Your DBS/ POSB account ending 1234";

  it("reaches the insert and records the exact booking, writing nothing", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const registry = new ToolRegistry({ dedupDbPath: ":memory:", notifyUrl: "http://notify.invalid" }, null);
    const facts = ["Account ending 1234 belongs to Test Account"];
    vi.spyOn(registry, "_handle_fetch_context").mockResolvedValue({
      accounts: [{ id: "acc-test", name: "Test Account", closed: false }],
      categories: [],
      payees: [],
    });
    vi.spyOn(registry, "_handle_search_memory").mockImplementation(async ({ query }) => ({
      results: facts.filter((f) => f.toLowerCase().includes(String(query).toLowerCase())).map((text) => ({ text })),
    }));
    vi.spyOn(registry, "_handle_list_facts").mockResolvedValue({ facts: facts.map((text) => ({ text })) });
    vi.spyOn(registry, "_handle_check_schedule_collision").mockResolvedValue(false);
    vi.spyOn(registry, "_handle_find_link_candidate").mockResolvedValue({ candidate: null, matches: 0 });
    // Replayed mail was already booked by the old watcher.
    vi.spyOn(registry, "_handle_check_duplicate").mockResolvedValue(true);
    const post = vi.spyOn(registry, "_post");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const orch = new AgentOrchestrator(
      {
        primaryCurrency: "SGD",
        secondaryCurrency: "MYR",
        primaryBudgetFile: "Budget SGD",
        secondaryBudgetFile: "Budget MYR",
        llmProvider: "deepseek",
        llmApiKey: "test-key",
        deepseekApiKey: "test-key",
      },
      registry,
    );
    orch._llm = { chat: vi.fn() };

    const { result, calls } = await registry.dryRun(() =>
      orch.processEmail("req-00009", ALERT, null, "alerts@dbs.com", "You've received a transfer"),
    );

    const insert = calls.find((c) => c.tool === "insert_transaction");
    expect(insert?.args).toMatchObject({ account_id: "acc-test", amount_cents: 4250, date: "2026-10-02" });
    expect(calls.find((c) => c.tool === "check_duplicate")).toMatchObject({ would_be_duplicate: true });
    expect(result.action).not.toBe("error");
    expect(post).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(orch._llm.chat).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
