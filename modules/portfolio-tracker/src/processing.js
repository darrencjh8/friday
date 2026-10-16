/**
 * Processing contract for Hermes email-intake (issue #783, Phase 2).
 *
 * Same contract as the expense-tracker's /process routes: one signed request
 * per email, identified by a stable request_id, answered with a typed status.
 * The portfolio orchestrator is a model tool loop whose final answer is free
 * text, so the status is derived from the tools it actually ran:
 *
 *   ask_user_confirmation ran            -> needs_confirmation
 *   a booking tool returned an error     -> failed
 *   a booking tool succeeded             -> processed
 *   check_duplicate said duplicate       -> duplicate
 *   orchestrator error                   -> failed
 *   nothing booked                       -> skipped
 *
 * Notifications are captured for Hermes to deliver once. A request is booked
 * at most once; one left in progress by a crash needs reconciliation and is
 * never retried blindly. Requests run one at a time.
 */

import { createHash, createHmac, timingSafeEqual } from "crypto";
import { mkdirSync } from "fs";
import { dirname } from "path";
import Database from "better-sqlite3";
import { extractEmailContent } from "./email_handler.js";

export const STATUS = Object.freeze({
  PROCESSED: "processed",
  DUPLICATE: "duplicate",
  NEEDS_CONFIRMATION: "needs_confirmation",
  SKIPPED: "skipped",
  BLOCKED_ENCRYPTED: "blocked_encrypted",
  FAILED: "failed",
  INVALID: "invalid",
});

/** Tools whose success means something was written to the portfolio. */
const BOOKING_TOOLS = new Set(["insert_pp_transaction", "update_pp_balance"]);
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_EVIDENCE_BYTES = 7 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/\r\n]*={0,2}\s*$/;

export class RequestJournal {
  constructor(path) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this._db = new Database(path);
    this._db.pragma("journal_mode = WAL");
    this._db.exec(`CREATE TABLE IF NOT EXISTS processing_requests (
      request_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      result TEXT,
      updated_at TEXT NOT NULL
    )`);
  }

  get(id) {
    const row = this._db.prepare("SELECT state, result FROM processing_requests WHERE request_id = ?").get(id);
    return row ? { state: row.state, result: row.result ? JSON.parse(row.result) : null } : null;
  }

  begin(id) {
    this._db
      .prepare(
        `INSERT INTO processing_requests (request_id, state, updated_at) VALUES (?, 'in_progress', ?)
         ON CONFLICT(request_id) DO UPDATE SET state = 'in_progress', updated_at = excluded.updated_at`,
      )
      .run(id, new Date().toISOString());
  }

  finish(id, result) {
    this._db
      .prepare("UPDATE processing_requests SET state = 'done', result = ?, updated_at = ? WHERE request_id = ?")
      .run(JSON.stringify(result), new Date().toISOString(), id);
  }

  release(id) {
    this._db.prepare("DELETE FROM processing_requests WHERE request_id = ?").run(id);
  }
}

function decodeEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") return { reason: "missing_evidence" };
  const keys = Object.keys(evidence);
  if (keys.length !== 1 || keys[0] !== "raw_email_b64") return { reason: "unsupported_evidence" };
  const b64 = evidence.raw_email_b64;
  if (typeof b64 !== "string" || !b64.trim()) return { reason: "missing_evidence" };
  if (b64.length > Math.ceil((MAX_EVIDENCE_BYTES * 4) / 3) + 4) return { reason: "evidence_too_large" };
  if (!BASE64_RE.test(b64)) return { reason: "evidence_not_base64" };
  const bytes = Buffer.from(b64, "base64");
  if (!bytes.length) return { reason: "missing_evidence" };
  if (bytes.length > MAX_EVIDENCE_BYTES) return { reason: "evidence_too_large" };
  return { bytes };
}

/** Status from the tool calls a run made and the orchestrator's outcome. */
function statusOf(calls, outcome) {
  if (calls.some((c) => c.name === "ask_user_confirmation")) return STATUS.NEEDS_CONFIRMATION;
  const bookings = calls.filter((c) => BOOKING_TOOLS.has(c.name));
  if (bookings.some((c) => c.result?.error)) return STATUS.FAILED;
  if (bookings.length) return STATUS.PROCESSED;
  if (outcome?.action === "error") return STATUS.FAILED;
  if (calls.some((c) => c.name === "check_duplicate" && c.result?.is_duplicate)) return STATUS.DUPLICATE;
  return STATUS.SKIPPED;
}

export class PortfolioProcessingService {
  constructor({ orchestrator, tools, journal }) {
    this._orchestrator = orchestrator;
    this._tools = tools;
    this._journal = journal;
    this._queue = Promise.resolve();
  }

  process(request) {
    const run = this._queue.then(() => this._process(request), () => this._process(request));
    this._queue = run.catch(() => {});
    return run;
  }

  async _process({ request_id: requestId, evidence } = {}) {
    if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) {
      return { status: STATUS.INVALID, reason: "bad_request_id" };
    }
    const decoded = decodeEvidence(evidence);
    if (!decoded.bytes) return { request_id: requestId, status: STATUS.INVALID, reason: decoded.reason };

    const prior = this._journal.get(requestId);
    if (prior?.state === "done") return { ...prior.result, replay: true };
    if (prior) return { request_id: requestId, status: STATUS.FAILED, reason: "needs_reconciliation" };

    const text = await extractEmailContent(decoded.bytes).catch(() => "");
    if (String(text).includes("[PDF_ENCRYPTED")) {
      return { request_id: requestId, status: STATUS.BLOCKED_ENCRYPTED };
    }

    const messages = [];
    const calls = [];
    this._journal.begin(requestId);
    this._tools.setNotificationSink(async (message) => {
      messages.push(String(message));
      return { status: "captured" };
    });
    this._tools.setCallObserver((name, args, result) => calls.push({ name, result }));
    let outcome;
    try {
      outcome = await this._orchestrator.processEmail(requestId, decoded.bytes, null);
    } catch (error) {
      console.error(JSON.stringify({ event: "processing_failed", request_id: requestId, error: error.message }));
      this._journal.release(requestId);
      return { request_id: requestId, status: STATUS.FAILED, reason: "error", messages };
    } finally {
      this._tools.setNotificationSink(null);
      this._tools.setCallObserver(null);
    }

    const result = {
      request_id: requestId,
      kind: "portfolio",
      status: statusOf(calls, outcome),
      action: outcome?.action || "error",
      details: outcome?.details ? String(outcome.details).slice(0, 500) : "",
      messages,
      bookings: calls
        .filter((c) => BOOKING_TOOLS.has(c.name) && !c.result?.error)
        .map((c) => ({ tool: c.name, transaction_id: c.result?.transaction_id ?? null })),
    };
    this._journal.finish(requestId, result);
    return result;
  }
}

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");

export function signProcessRequest(body, secret, kind = "portfolio") {
  return createHmac("sha256", String(secret))
    .update(`${kind}:${body?.request_id ?? ""}:${sha256(body?.evidence?.raw_email_b64 ?? "")}`)
    .digest("hex");
}

/** Express handler for POST /process/portfolio. */
export function createProcessHandler({ service, secret }) {
  return async (req, res) => {
    const given = req.get?.("X-Process-Signature");
    const want = secret ? signProcessRequest(req.body, secret) : "";
    const ok =
      secret &&
      typeof given === "string" &&
      given.length === want.length &&
      timingSafeEqual(Buffer.from(given), Buffer.from(want));
    if (!ok) return res.status(403).json({ status: STATUS.INVALID, reason: "forbidden" });
    return res.json(await service.process(req.body));
  };
}

/** Mount the signed processing route on the service's Express app. */
export function mountProcessingRoute(app, { orchestrator, tools, cfg }) {
  const service = new PortfolioProcessingService({
    orchestrator,
    tools,
    journal: new RequestJournal(cfg.processingDbPath || "data/processing.db"),
  });
  app.post("/process/portfolio", createProcessHandler({ service, secret: cfg.hermesWebhookSecret || "" }));
  return service;
}
