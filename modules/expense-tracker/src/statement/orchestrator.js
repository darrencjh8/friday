/**
 * StatementProcessor — LLM conversation loop for credit card statement reconciliation.
 * Ported 1:1 from src/statement/orchestrator.py
 *
 * Uses the LLM tool-calling loop for multi-step reconciliation of bank/credit card
 * statements. Always marks the email as read and notifies the user on completion
 * or failure.
 */

import { LLMClient, DeepSeekClient } from "../orchestrator.js";
import { extractEmailContent } from "../extractors.js";
import { logger } from "../logging.js";
import { STATEMENT_PROMPT } from "./prompts.js";

const MAX_TOOL_ITERATIONS = 20;

// Re-export for backward compat with tests that import from here
export { DeepSeekClient };

const PASSWORD_RE = /password\s*(?:is|=|:)\s*(\S+)/i;
const GENERIC_TOKENS = new Set([
  "com",
  "net",
  "org",
  "edu",
  "gov",
  "www",
  "sg",
  "my",
  "co",
  "mail",
  "email",
  "emails",
  "noreply",
  "no",
  "reply",
  "donotreply",
  "alerts",
  "alert",
  "statement",
  "statements",
  "estatement",
  "credit",
  "card",
  "cards",
  "bank",
  "banking",
  "your",
  "monthly",
  "account",
  "the",
  "for",
  "and",
  "of",
  "pdf",
  "notification",
  "notifications",
  "service",
  "services",
  "customer",
  "online",
  "digital",
  "secure",
  "message",
  "info",
  "support",
  "billing",
  "payments",
  "payment",
  "fwd",
  "re",
  "fw",
]);

function headerValue(rawText, name) {
  const headerBlock = rawText
    .split(/\r?\n\r?\n/, 1)[0]
    .replace(/\r?\n[ \t]+/g, " ");
  const m = headerBlock.match(new RegExp(`^${name}:[ \\t]*(.*)$`, "im"));
  return m ? m[1] : "";
}

/**
 * Issuer hint tokens (lowercase) derived from the email's From and Subject
 * headers — the issuer is only known to the pipeline via the raw email.
 */
export function deriveIssuerHints(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "");
  const source = `${headerValue(text, "From")} ${headerValue(text, "Subject")}`;
  const tokens = new Set();
  for (const t of source.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3 && !GENERIC_TOKENS.has(t) && !/^\d+$/.test(t)) {
      tokens.add(t);
    }
  }
  return [...tokens];
}

function isFormatFact(fact, value) {
  if (
    /^[dmy]{4,}$/i.test(value.replace(/[^a-z]/gi, "")) &&
    /^[a-z]+$/i.test(value)
  ) {
    return true;
  }
  return /\b(format|pattern|ddmm\w*|mmdd\w*|yyyy\w*|combination|digits? of|characters? of|first \d+|last \d+)\b/i.test(
    fact,
  );
}

/**
 * Ordered, de-duplicated password candidates. Ranking is independent of the
 * input order: issuer-matching concrete facts, then other concrete facts, then
 * format-description facts; ties broken by value.
 */
export function extractPasswordCandidates(facts, opts = {}) {
  if (!Array.isArray(facts)) return [];
  const hints = (opts.issuerHints || []).map((h) => h.toLowerCase());
  const exclude = new Set(opts.exclude || []);
  const best = new Map();
  for (const f of facts) {
    if (typeof f !== "string") continue;
    const value = f.match(PASSWORD_RE)?.[1];
    if (!value || exclude.has(value)) continue;
    const lower = f.toLowerCase();
    const issuerMatch = hints.some((h) => lower.includes(h));
    const rank = isFormatFact(f, value) ? 0 : issuerMatch ? 2 : 1;
    if (!best.has(value) || best.get(value) < rank) best.set(value, rank);
  }
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([v]) => v);
}

export function extractPasswordFromFacts(facts, opts = {}) {
  return extractPasswordCandidates(facts, opts)[0] || null;
}

export class StatementProcessor {
  /**
   * Orchestrates the LLM conversation loop for processing bank statements.
   *
   * @param {object} config - Config instance
   * @param {object} tools - ToolRegistry instance
   */
  constructor(config, tools) {
    this._config = config;
    this._llm = new LLMClient(config);
    this._tools = tools;
  }

  get tools() {
    return this._tools;
  }

  /**
   * Process a statement email through LLM reconciliation.
   *
   * @param {string} msgId - IMAP message ID
   * @param {string|Buffer} rawEmail - raw email source
   * @param {object} imapHandler - IMAP handler with markRead(msgId)
   * @returns {Promise<object>} { action, matched_count?, outlier_count?, details }
   */
  async processStatement(msgId, rawEmail, imapHandler) {
    this._tools.setEmailContext(msgId, rawEmail, imapHandler);

    const raw = Buffer.isBuffer(rawEmail)
      ? rawEmail
      : Buffer.from(rawEmail || "");

    // Extract content, retrying with a different password candidate each time
    let emailText = "";
    const MAX_PASSWORD_RETRIES = 2;
    const issuerHints = deriveIssuerHints(raw);
    const tried = [];
    let facts = null;
    try {
      emailText = await extractEmailContent(raw);
    } catch {
      emailText = String(rawEmail || "");
    }

    for (
      let attempt = 0;
      attempt < MAX_PASSWORD_RETRIES && emailText.includes("[PDF_ENCRYPTED");
      attempt++
    ) {
      if (facts === null) {
        const memResult = await this._tools.executeTool("search_memory", {
          query: [...issuerHints, "statement password"].join(" "),
        });
        facts = (memResult && memResult.results) || [];
      }
      const password = extractPasswordFromFacts(facts, {
        issuerHints,
        exclude: tried,
      });
      if (!password) break;
      tried.push(password);
      try {
        emailText = await extractEmailContent(raw, password);
      } catch {
        // Password didn't work; next iteration tries another candidate
      }
    }

    const messages = this._buildMessages(emailText);
    const toolSchemas = this._tools.getToolSchemas();

    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        const response = await this._llm.chat(messages, toolSchemas);
        const choice = (response.choices || [{}])[0];
        const finishReason = choice.finish_reason;
        const message = choice.message || {};

        if (message.content) {
          messages.push({
            role: "assistant",
            content: message.content,
          });
        }

        const toolCalls = message.tool_calls;
        if (!toolCalls) {
          if (finishReason === "stop") {
            const result = {
              action: "completed",
              details: message.content || "",
            };
            await this._ensureEmailRead();
            return result;
          }
          return {
            action: "error",
            details: `Unexpected finish_reason: ${finishReason}`,
          };
        }

        const assistantMsg = {
          role: "assistant",
          content: message.content,
          tool_calls: toolCalls,
        };
        if (!assistantMsg.content) delete assistantMsg.content;
        messages.push(assistantMsg);

        for (const tc of toolCalls) {
          const func = tc.function || {};
          const name = func.name || "";
          let args = {};
          try {
            args = JSON.parse(func.arguments || "{}");
          } catch {}

          const result = await this._tools.executeTool(name, args);
          messages.push({
            role: "tool",
            tool_call_id: tc.id || "",
            content:
              typeof result === "string" ? result : JSON.stringify(result),
          });

          logger.info({
            event: "statement_tool_exec",
            tool: name,
            args,
            result:
              typeof result === "string"
                ? result.slice(0, 200)
                : JSON.stringify(result).slice(0, 200),
          });
        }
      }

      const notified = await this._tools.executeTool("notify_user", {
        message:
          "Statement processing exceeded maximum iterations — may be too large or malformed.",
      });
      if (notified) {
        await this._ensureEmailRead();
      } else {
        logger.error({
          event: "notify_user_failed",
          context: "statement_max_iterations",
        });
      }
      return {
        action: "error",
        details: "Max tool iterations exceeded",
      };
    } catch (e) {
      logger.error({
        event: "statement_processing_failed",
        error: e.message,
      });
      const notified = await this._tools.executeTool("notify_user", {
        message: `Failed processing statement: ${String(e).slice(0, 200)}`,
      });
      if (notified) {
        await this._ensureEmailRead();
      } else {
        logger.error({
          event: "notify_user_failed",
          context: "statement_processing_failed",
          error: e.message,
        });
      }
      return { action: "error", details: String(e).slice(0, 500) };
    }
  }

  async _ensureEmailRead() {
    try {
      await this._tools.executeTool("mark_email_read", {});
      logger.info({ event: "statement_marked_email_read" });
    } catch (e) {
      logger.warn({
        event: "statement_mark_read_failed",
        error: e.message,
      });
    }
  }

  _buildMessages(statementContent) {
    return [
      { role: "system", content: STATEMENT_PROMPT },
      {
        role: "user",
        content: `Process this credit card statement:\n\n${statementContent.slice(0, 60000)}`,
      },
    ];
  }
}
