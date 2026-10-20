/**
 * Processing contract for Hermes email-intake (issue #783, Phase 2).
 *
 * Hermes owns the mailbox, classification and every user notification. It
 * hands the tracker one email's evidence per request, identified by a stable
 * request_id, and gets back a typed status. The tracker:
 *
 *  - books with its existing pipeline and safeguards (orchestrator, statement
 *    processor, financial dedup) — nothing about booking changes here;
 *  - never notifies the user and never sends a learning offer itself: both are
 *    captured into the result for Hermes to deliver once;
 *  - never touches a mailbox: the pipeline gets a read-only no-op mailbox;
 *  - books a request at most once. A finished request replays its stored
 *    result. A request found still "in progress" (a crash after a write but
 *    before the result was stored) is never retried blindly: it is reported
 *    as needing reconciliation;
 *  - runs one request at a time, because the tool registry still carries
 *    per-email context.
 */

import { createHash, createHmac, timingSafeEqual } from "crypto";
import { mkdirSync } from "fs";
import { dirname } from "path";
import Database from "better-sqlite3";
import { extractEmailContent } from "./extractors.js";
import { logger } from "./logging.js";

export const STATUS = Object.freeze({
  PROCESSED: "processed",
  DUPLICATE: "duplicate",
  NEEDS_CONFIRMATION: "needs_confirmation",
  SKIPPED: "skipped",
  BLOCKED_ENCRYPTED: "blocked_encrypted",
  FAILED: "failed",
  INVALID: "invalid",
  DRY_RUN: "dry_run",
});

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
// Base64 of this stays under the app-wide 10mb JSON body limit.
const MAX_EVIDENCE_BYTES = 7 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/\r\n]*={0,2}\s*$/;

/** Orchestrator / statement-processor action → contract status. */
const ACTION_STATUS = {
  insert: STATUS.PROCESSED,
  inserted: STATUS.PROCESSED,
  completed: STATUS.PROCESSED,
  transfer_pair_linked: STATUS.PROCESSED,
  duplicate: STATUS.DUPLICATE,
  transfer_counterpart_deduplicated: STATUS.DUPLICATE,
  skipped: STATUS.SKIPPED,
  notified: STATUS.NEEDS_CONFIRMATION,
  notify_failed: STATUS.NEEDS_CONFIRMATION,
  held_unresolved_paynow: STATUS.NEEDS_CONFIRMATION,
  held_unresolved_transfer: STATUS.NEEDS_CONFIRMATION,
  llm_unavailable: STATUS.FAILED,
  error: STATUS.FAILED,
};

/** A mailbox the pipeline may call into without changing anything. */
const READ_ONLY_MAILBOX = Object.freeze({
  readOnly: true,
  async markRead() {},
});

/** Durable record of every request, so a retry never books twice. */
export class RequestJournal {
  constructor(path) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this._db = new Database(path);
    this._db.pragma("journal_mode = WAL");
    this._db.exec(`CREATE TABLE IF NOT EXISTS processing_requests (
      request_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      result TEXT,
      updated_at TEXT NOT NULL
    )`);
  }

  get(requestId) {
    const row = this._db
      .prepare("SELECT kind, state, result FROM processing_requests WHERE request_id = ?")
      .get(requestId);
    return row ? { ...row, result: row.result ? JSON.parse(row.result) : null } : null;
  }

  begin(requestId, kind) {
    this._db
      .prepare(
        `INSERT INTO processing_requests (request_id, kind, state, updated_at)
         VALUES (?, ?, 'in_progress', ?)
         ON CONFLICT(request_id) DO UPDATE SET state = 'in_progress', updated_at = excluded.updated_at`,
      )
      .run(requestId, kind, new Date().toISOString());
  }

  finish(requestId, result) {
    this._db
      .prepare(
        "UPDATE processing_requests SET state = 'done', result = ?, updated_at = ? WHERE request_id = ?",
      )
      .run(JSON.stringify(result), new Date().toISOString(), requestId);
  }

  /** A thrown error leaves no booking behind, so the request may be retried. */
  release(requestId) {
    this._db.prepare("DELETE FROM processing_requests WHERE request_id = ?").run(requestId);
  }
}

/** Validated evidence bytes, or a reason string. */
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

/** Header values from the raw email, for the orchestrator's sender signals. */
function headerOf(bytes, name) {
  const head = bytes.subarray(0, 16 * 1024).toString("utf8").split(/\r?\n\r?\n/, 1)[0];
  const m = head.match(new RegExp(`^${name}:\\s*(.*)$`, "im"));
  return m ? m[1].trim() : "";
}

export class ProcessingService {
  /**
   * @param {{orchestrator: any, statementProcessor: any, tools: any, journal: RequestJournal}} deps
   */
  constructor({ orchestrator, statementProcessor, tools, journal }) {
    this._orchestrator = orchestrator;
    this._statements = statementProcessor;
    this._tools = tools;
    this._journal = journal;
    this._queue = Promise.resolve();
  }

  processTransaction(request) {
    return this._serialised(() => this._process("transaction", request));
  }

  processStatement(request) {
    return this._serialised(() => this._process("statement", request));
  }

  _serialised(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  async _process(kind, { request_id: requestId, evidence, dry_run: dryRun, jev_calibration: calibrate } = {}) {
    if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) {
      return { status: STATUS.INVALID, reason: "bad_request_id" };
    }
    if (dryRun !== undefined && typeof dryRun !== "boolean") {
      return { request_id: requestId, status: STATUS.INVALID, reason: "bad_dry_run" };
    }
    // Calibration only adds Jev scores to a dry run; it never books.
    if (calibrate !== undefined && (typeof calibrate !== "boolean" || (calibrate && dryRun !== true))) {
      return { request_id: requestId, status: STATUS.INVALID, reason: "bad_jev_calibration" };
    }
    const decoded = decodeEvidence(evidence);
    if (!decoded.bytes) return { request_id: requestId, status: STATUS.INVALID, reason: decoded.reason };
    if (dryRun) {
      if (kind !== "transaction") {
        return { request_id: requestId, status: STATUS.INVALID, reason: "dry_run_unsupported" };
      }
      return this._dryRun(requestId, decoded.bytes, { calibrate: calibrate === true });
    }

    const prior = this._journal.get(requestId);
    if (prior) {
      if (prior.kind !== kind) {
        return { request_id: requestId, status: STATUS.INVALID, reason: "request_id_kind_mismatch" };
      }
      if (prior.state === "done") return { ...prior.result, replay: true };
      logger.warn({ event: "processing_needs_reconciliation", request_id: requestId });
      return { request_id: requestId, status: STATUS.FAILED, reason: "needs_reconciliation" };
    }

    if (kind === "statement") {
      const text = await extractEmailContent(decoded.bytes).catch(() => "");
      if (String(text).includes("[PDF_ENCRYPTED")) {
        // Not journaled: intake may retry once it has decrypted the evidence.
        return { request_id: requestId, status: STATUS.BLOCKED_ENCRYPTED };
      }
    }

    const messages = [];
    let candidate = null;
    this._journal.begin(requestId, kind);
    this._tools.setNotificationSink(async (message) => {
      messages.push(String(message));
      return true;
    });
    this._tools.setOfferSink(async (offer) => {
      candidate = {
        id: offer.id,
        descriptor: offer.descriptor,
        payee: offer.payee,
        ...(offer.example ? { example: offer.example } : {}),
        ...(offer.category ? { category: offer.category } : {}),
      };
    });
    let outcome;
    try {
      outcome =
        kind === "statement"
          ? await this._statements.processStatement(requestId, decoded.bytes, READ_ONLY_MAILBOX)
          : await this._orchestrator.processEmail(
              requestId,
              decoded.bytes,
              READ_ONLY_MAILBOX,
              headerOf(decoded.bytes, "From"),
              headerOf(decoded.bytes, "Subject"),
            );
    } catch (error) {
      logger.error({ event: "processing_failed", request_id: requestId, error: error.message });
      this._journal.release(requestId);
      return { request_id: requestId, status: STATUS.FAILED, reason: "error", messages };
    } finally {
      this._tools.setNotificationSink(null);
      this._tools.setOfferSink(null);
    }

    const action = outcome?.action || "error";
    if (action === "llm_unavailable") {
      // Nothing was booked; like the old watcher, leave it retryable (#694).
      this._journal.release(requestId);
      return { request_id: requestId, kind, status: STATUS.FAILED, reason: "error", action, messages };
    }
    const result = {
      request_id: requestId,
      kind,
      status: ACTION_STATUS[action] || STATUS.FAILED,
      action,
      details: outcome?.details ? String(outcome.details).slice(0, 500) : "",
      messages,
      mapping_candidate: candidate,
    };
    if (outcome?.transaction_id) result.transaction_id = outcome.transaction_id;
    this._journal.finish(requestId, result);
    return result;
  }

  /**
   * The full pipeline with every write recorded instead of executed (#796
   * parity replay). Nothing is journaled, so the same request can still be
   * booked for real later.
   */
  async _dryRun(requestId, bytes, { calibrate = false } = {}) {
    try {
      const { result: outcome, calls } = await this._tools.dryRun(() =>
        this._orchestrator.processEmail(
          requestId,
          bytes,
          READ_ONLY_MAILBOX,
          headerOf(bytes, "From"),
          headerOf(bytes, "Subject"),
        ),
        { calibrate },
      );
      return {
        request_id: requestId,
        kind: "transaction",
        status: STATUS.DRY_RUN,
        action: outcome?.action || "error",
        details: outcome?.details ? String(outcome.details).slice(0, 500) : "",
        writes: calls,
      };
    } catch (error) {
      logger.error({ event: "processing_dry_run_failed", request_id: requestId, error: error.message });
      return { request_id: requestId, status: STATUS.FAILED, reason: "error" };
    }
  }
}

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");

/** HMAC over kind, request_id and the evidence digest. */
export function signProcessRequest(body, secret, kind = "transaction") {
  const evidence = body?.evidence?.raw_email_b64 ?? "";
  return createHmac("sha256", String(secret))
    .update(`${kind}:${body?.request_id ?? ""}:${sha256(evidence)}`)
    .digest("hex");
}

/** Express handler for POST /process/{transaction,statement}. */
export function createProcessHandler({ service, kind, secret }) {
  return async (req, res) => {
    const given = req.get?.("X-Process-Signature");
    // A dry run is signed as its own kind, so a captured dry run can never be
    // replayed as a booking by dropping the flag (#796).
    const signedKind = req.body?.dry_run === true ? `${kind}:dry_run` : kind;
    const want = secret ? signProcessRequest(req.body, secret, signedKind) : "";
    const ok =
      secret &&
      typeof given === "string" &&
      given.length === want.length &&
      timingSafeEqual(Buffer.from(given), Buffer.from(want));
    if (!ok) {
      logger.warn({ event: "process_request_rejected", kind });
      return res.status(403).json({ status: STATUS.INVALID, reason: "forbidden" });
    }
    const result =
      kind === "statement"
        ? await service.processStatement(req.body)
        : await service.processTransaction(req.body);
    return res.json(result);
  };
}
