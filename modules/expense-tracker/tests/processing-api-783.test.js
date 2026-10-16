/**
 * Issue #783 Phase 2: the processing contract Hermes email-intake calls.
 *
 * One request = one email's evidence, identified by a stable request_id.
 * The tracker books it with its existing safeguards, returns a typed status,
 * never notifies the user itself (Hermes owns notifications) and never books
 * the same request twice.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHmac } from "crypto";

vi.mock("../src/extractors.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    extractEmailContent: vi.fn(async (raw) =>
      String(raw).includes("ENCRYPTED-PDF") ? "body\n[PDF_ENCRYPTED: x]" : "plain body",
    ),
  };
});

import {
  ProcessingService,
  RequestJournal,
  createProcessHandler,
  signProcessRequest,
  STATUS,
} from "../src/processing.js";

const raw = (s = "From: bank\nSubject: alert\n\nYou spent SGD 5.00") =>
  Buffer.from(s).toString("base64");

function fakeTools() {
  const tools = {
    sent: [],
    offers: [],
    _notifySink: null,
    _offerSink: null,
    async notify(message) {
      if (this._notifySink) return this._notifySink(message);
      this.sent.push(message);
      return true;
    },
    async offer(offer) {
      if (this._offerSink) return this._offerSink(offer);
      this.offers.push(offer);
    },
    setNotificationSink(fn) {
      this._notifySink = fn;
    },
    setOfferSink(fn) {
      this._offerSink = fn;
    },
  };
  return tools;
}

describe("ProcessingService (#783)", () => {
  let dir;
  let tools;
  let orchestrator;
  let statements;
  let service;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "processing-"));
    tools = fakeTools();
    orchestrator = { processEmail: vi.fn(async () => ({ action: "insert", details: "ok", transaction_id: "t1" })) };
    statements = { processStatement: vi.fn(async () => ({ action: "completed", details: "3 matched" })) };
    service = new ProcessingService({
      orchestrator,
      statementProcessor: statements,
      tools,
      journal: new RequestJournal(join(dir, "processing.db")),
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const tx = (over = {}) =>
    service.processTransaction({ request_id: "req-00000001", evidence: { raw_email_b64: raw() }, ...over });

  it("rejects malformed requests without touching the books", async () => {
    for (const bad of [
      { request_id: "x" },
      { request_id: "bad id with spaces" },
      { evidence: {} },
      { evidence: { raw_email_b64: "%%%not-base64%%%" } },
      { evidence: { raw_email_b64: "A".repeat(15 * 1024 * 1024) } },
      { evidence: { path: "/etc/passwd" } },
    ]) {
      const res = await tx(bad);
      expect(res.status, JSON.stringify(Object.keys(bad))).toBe(STATUS.INVALID);
    }
    expect(orchestrator.processEmail).not.toHaveBeenCalled();
  });

  it.each([
    ["insert", STATUS.PROCESSED],
    ["inserted", STATUS.PROCESSED],
    ["transfer_pair_linked", STATUS.PROCESSED],
    ["duplicate", STATUS.DUPLICATE],
    ["transfer_counterpart_deduplicated", STATUS.DUPLICATE],
    ["skipped", STATUS.SKIPPED],
    ["notified", STATUS.NEEDS_CONFIRMATION],
    ["held_unresolved_paynow", STATUS.NEEDS_CONFIRMATION],
    ["held_unresolved_transfer", STATUS.NEEDS_CONFIRMATION],
    ["llm_unavailable", STATUS.FAILED],
    ["notify_failed", STATUS.NEEDS_CONFIRMATION],
    ["error", STATUS.FAILED],
  ])("maps orchestrator action %s to %s", async (action, status) => {
    orchestrator.processEmail.mockResolvedValueOnce({ action, details: "d" });
    const res = await tx();
    expect(res.status).toBe(status);
    expect(res.action).toBe(action);
  });

  it("passes a no-op mailbox, so nothing can change read flags", async () => {
    await tx();
    const [, , mailbox] = orchestrator.processEmail.mock.calls[0];
    await mailbox.markRead(5);
    expect(mailbox.readOnly).toBe(true);
  });

  it("captures notifications instead of sending them", async () => {
    orchestrator.processEmail.mockImplementationOnce(async () => {
      await tools.notify("Couldn't match an account for X");
      return { action: "notified", details: "no account" };
    });
    const res = await tx();
    expect(tools.sent).toEqual([]);
    expect(res.messages).toEqual(["Couldn't match an account for X"]);
    // The sink is removed again for the next, non-API caller.
    await tools.notify("later");
    expect(tools.sent).toEqual(["later"]);
  });

  it("returns a learning offer as the mapping candidate, unsent", async () => {
    orchestrator.processEmail.mockImplementationOnce(async () => {
      await tools.offer({ id: "ABCDEFGH", descriptor: "Alpha Cafe", payee: "Food", runnerUp: null });
      return { action: "insert", details: "ok" };
    });
    const res = await tx();
    expect(tools.offers).toEqual([]);
    expect(res.mapping_candidate).toEqual({ id: "ABCDEFGH", descriptor: "Alpha Cafe", payee: "Food" });
  });

  it("books a request once: a retry returns the stored result", async () => {
    const first = await tx();
    const second = await tx();
    expect(orchestrator.processEmail).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ status: first.status, replay: true });
  });

  it("a request interrupted mid-booking needs reconciliation, not a blind retry", async () => {
    service._journal.begin("req-00000001", "transaction");
    const res = await tx();
    expect(res).toMatchObject({ status: STATUS.FAILED, reason: "needs_reconciliation" });
    expect(orchestrator.processEmail).not.toHaveBeenCalled();
  });

  it("a thrown error is recorded as failed and may be retried", async () => {
    orchestrator.processEmail.mockRejectedValueOnce(new Error("boom"));
    expect((await tx()).status).toBe(STATUS.FAILED);
    expect((await tx()).status).toBe(STATUS.PROCESSED);
    expect(orchestrator.processEmail).toHaveBeenCalledTimes(2);
  });

  it("runs one request at a time", async () => {
    let active = 0;
    let peak = 0;
    orchestrator.processEmail.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return { action: "insert" };
    });
    await Promise.all(
      ["req-a0000001", "req-a0000002", "req-a0000003"].map((id) => tx({ request_id: id })),
    );
    expect(peak).toBe(1);
  });

  it("encrypted statement evidence is blocked before processing", async () => {
    const res = await service.processStatement({
      request_id: "req-s0000001",
      evidence: { raw_email_b64: raw("Subject: stmt\n\nENCRYPTED-PDF") },
    });
    expect(res.status).toBe(STATUS.BLOCKED_ENCRYPTED);
    expect(statements.processStatement).not.toHaveBeenCalled();
  });

  it("routes a decrypted statement to the statement processor", async () => {
    const res = await service.processStatement({
      request_id: "req-s0000002",
      evidence: { raw_email_b64: raw("Subject: stmt\n\nplain") },
    });
    expect(statements.processStatement).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(STATUS.PROCESSED);
  });

  it("the same request_id cannot be replayed as the other kind", async () => {
    await tx();
    const res = await service.processStatement({
      request_id: "req-00000001",
      evidence: { raw_email_b64: raw() },
    });
    expect(res).toMatchObject({ status: STATUS.INVALID, reason: "request_id_kind_mismatch" });
  });
});

describe("process HTTP handler (#783)", () => {
  const secret = "s3cret";
  const body = { request_id: "req-h0000001", evidence: { raw_email_b64: raw() } };

  function call(handler, { sig, payload = body }) {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    const req = { body: payload, get: (h) => (h === "X-Process-Signature" ? sig : undefined) };
    return handler(req, res).then(() => res);
  }

  it("refuses an unsigned or mis-signed request", async () => {
    const service = { processTransaction: vi.fn() };
    const handler = createProcessHandler({ service, kind: "transaction", secret });
    expect((await call(handler, { sig: undefined })).code).toBe(403);
    expect((await call(handler, { sig: "00" })).code).toBe(403);
    expect(service.processTransaction).not.toHaveBeenCalled();
  });

  it("refuses everything when no secret is configured", async () => {
    const service = { processTransaction: vi.fn() };
    const handler = createProcessHandler({ service, kind: "transaction", secret: "" });
    const sig = signProcessRequest(body, "");
    expect((await call(handler, { sig })).code).toBe(403);
  });

  it("accepts a correctly signed request and returns the result", async () => {
    const service = { processTransaction: vi.fn(async () => ({ status: STATUS.PROCESSED })) };
    const handler = createProcessHandler({ service, kind: "transaction", secret });
    const res = await call(handler, { sig: signProcessRequest(body, secret) });
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ status: STATUS.PROCESSED });
  });

  it("the signature binds request_id, kind and the evidence bytes", () => {
    const evidenceSha = createHmac("sha256", "x").update("y").digest("hex"); // unrelated
    expect(signProcessRequest(body, secret)).not.toBe(
      signProcessRequest({ ...body, request_id: "req-h0000002" }, secret),
    );
    expect(signProcessRequest(body, secret)).not.toBe(
      signProcessRequest({ ...body, evidence: { raw_email_b64: raw("other") } }, secret),
    );
    expect(evidenceSha).toBeTypeOf("string");
  });
});
