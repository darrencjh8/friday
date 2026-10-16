/**
 * Tests for classify.js — email classification and dispatch logic.
 * Ported from Python test patterns.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyEmail,
  dispatchEmail,
  CLASSIFICATION_PROMPT,
} from "../src/classify.js";

// ── Mock openai ──────────────────────────────────────────────────────────
const mockCreate = vi.fn();
const mockResponsesCreate = vi.fn();

vi.mock("openai", () => ({
  default: vi.fn(() => ({
    chat: { completions: { create: mockCreate } },
    responses: { create: mockResponsesCreate },
  })),
}));

// ── Mock extractors ──────────────────────────────────────────────────────
vi.mock("../src/extractors.js", () => ({
  extractEmailContent: vi.fn((raw) => {
    // Simple pass-through for test inputs
    return String(raw)
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }),
}));

import OpenAI from "openai";

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
// classifyEmail tests
// ─────────────────────────────────────────────────────────────────────────

describe("classifyEmail", () => {
  const config = {
    llmApiKey: "sk-test-classify",
    llmBaseUrl: "https://api.deepseek.com/v1",
    llmModel: "deepseek-flash",
  };

  it("classifies a single-transaction email as 'transaction'", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "transaction" } }],
    });

    const result = await classifyEmail(
      "From: alerts@example.com\nSubject: Transaction Alert\n\nSGD 12.80 at Toast Box",
      "Transaction Alert",
      "alerts@example.com",
      config,
    );

    expect(result).toBe("transaction");
    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: config.llmApiKey,
      baseURL: config.llmBaseUrl,
    });
    expect(mockCreate).toHaveBeenCalledOnce();
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe(config.llmModel);
    expect(callArgs.temperature).toBe(0);
    expect(callArgs.max_tokens).toBe(5);
    expect(callArgs.messages[0].content).toBe(CLASSIFICATION_PROMPT);
  });

  it("classifies a bank statement email as 'statement'", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "statement" } }],
    });

    const result = await classifyEmail(
      "Subject: Your Monthly eStatement\nFrom: bank@example.com\n\nYour statement for May 2026 is ready",
      "Your Monthly eStatement",
      "bank@example.com",
      config,
    );

    expect(result).toBe("statement");
  });

  it("calls the router route over the Responses API, then falls back to DeepSeek chat", async () => {
    const routerConfig = {
      llmProvider: "litellm",
      llmApiKey: "router-key",
      llmBaseUrl: "http://codex-router:4100/v1",
      llmModel: "auto-thinking",
      llmFallbackModel: "",
      deepseekApiKey: "deepseek-key",
    };
    mockResponsesCreate.mockRejectedValueOnce(new Error("router down"));
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "transaction" } }],
    });

    await classifyEmail(
      "Card Number XXXX-XXXX-XXXX-5748\nTransaction Amount SGD5.86\nDescription SHOPEE SG MP",
      "Transaction Alerts (Credit Card)",
      "HSBC.Bank.Singapore.Limited@notification.hsbc.com.hk",
      routerConfig,
    );

    expect(mockResponsesCreate.mock.calls[0][0].model).toBe("auto-thinking");
    expect(mockResponsesCreate.mock.calls[0][0].input[0].role).toBe("system");
    const call = mockCreate.mock.calls[0][0];
    expect(call.model).toBe("deepseek-flash");
    expect(call.temperature).toBe(0);
  });

  it.each([
    ["Reminder: upcoming scheduled transfer", "info@alerts.rytbank.my"],
    ["digibank Alert - Unsuccessful bill payment", "ibanking.alert@dbs.com"],
    ["Your eDocument(s) are ready for viewing", "ibanking.alert@dbs.com"],
  ])("skips known bank notifications that are not completed transactions", async (subject, sender) => {
    const result = await classifyEmail("This is a reminder or document notification.", subject, sender, config);

    expect(result).toBe("skip");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("classifies an IBKR trade confirmation as 'skip'", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "skip" } }],
    });

    const result = await classifyEmail(
      "Subject: IBKR Trade Confirmation\nFrom: ibkr@test.com\n\nYour IBKR trade confirmation for AAPL",
      "IBKR Trade Confirmation",
      "ibkr@test.com",
      config,
    );

    expect(result).toBe("skip");
  });

  it("falls back to 'transaction' on API error", async () => {
    mockCreate.mockRejectedValueOnce(new Error("Network error"));

    const result = await classifyEmail(
      "Some email content",
      "Test Subject",
      "test@example.com",
      config,
    );

    expect(result).toBe("transaction");
  });

  it("falls back to 'transaction' on timeout", { timeout: 15000 }, async () => {
    // Simulate a timeout by never resolving
    mockCreate.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(resolve, 20000)),
    );

    const result = await classifyEmail(
      "Timeout test email",
      "Test",
      "test@example.com",
      config,
    );

    expect(result).toBe("transaction");
  });

  it("returns 'transaction' for empty input gracefully", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "transaction" } }],
    });

    const result = await classifyEmail("", "", "", config);

    expect(result).toBe("transaction");
    const userMessage = mockCreate.mock.calls[0][0].messages[1].content;
    expect(userMessage).toContain("Subject:");
    expect(userMessage).toContain("From:");
  });

  it("handles Buffer rawEmail input", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "skip" } }],
    });

    const buf = Buffer.from(
      "Subject: IBKR Activity Flex\nFrom: ibkr@test.com\n\nFlex Query results",
    );

    const result = await classifyEmail(
      buf,
      "IBKR Activity Flex",
      "ibkr@test.com",
      config,
    );

    expect(result).toBe("skip");
  });

  it("trims and lowercases the LLM response", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "  STATEMENT  " } }],
    });

    const result = await classifyEmail(
      "Statement email",
      "Statement",
      "bank@test.com",
      config,
    );

    expect(result).toBe("statement");
  });

  it("defaults to 'transaction' for unrecognized LLM output", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "unknown_blah" } }],
    });

    const result = await classifyEmail(
      "Some email",
      "Test",
      "test@example.com",
      config,
    );

    expect(result).toBe("transaction");
  });

  it("truncates body to 2000 chars for the classification prompt", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "transaction" } }],
    });

    const longBody = "A".repeat(5000);
    await classifyEmail(longBody, "Long email", "test@example.com", config);

    const userMsgContent = mockCreate.mock.calls[0][0].messages[1].content;
    // The body portion after headers should not exceed 2000 chars
    const bodyPart = userMsgContent.split("\n\n").slice(1).join("\n\n");
    expect(bodyPart.length).toBeLessThanOrEqual(2000);
  });

  it("handles null rawEmail gracefully", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "transaction" } }],
    });

    const result = await classifyEmail(
      null,
      "Subject",
      "sender@test.com",
      config,
    );

    expect(result).toBe("transaction");
    const userMsg = mockCreate.mock.calls[0][0].messages[1].content;
    expect(userMsg).toContain("Subject: Subject");
    expect(userMsg).toContain("From: sender@test.com");
  });

  it("handles undefined rawEmail gracefully", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "skip" } }],
    });

    const result = await classifyEmail(
      undefined,
      "Subj",
      "from@test.com",
      config,
    );

    expect(result).toBe("skip");
  });

  it("handles extractEmailContent throwing by falling back to raw", async () => {
    const { extractEmailContent } = await import("../src/extractors.js");
    extractEmailContent.mockImplementationOnce(() => {
      throw new Error("parse failure");
    });
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "transaction" } }],
    });

    const result = await classifyEmail(
      "raw fallback content",
      "Subject",
      "test@example.com",
      config,
    );

    expect(result).toBe("transaction");
    const userMsg = mockCreate.mock.calls[0][0].messages[1].content;
    expect(userMsg).toContain("raw fallback content");
  });

  it("handles special characters in subject and sender", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "transaction" } }],
    });

    const result = await classifyEmail(
      "body text",
      "🔥 Special! <script>alert('xss')</script>",
      '"Test User" <test+tag@example.com>',
      config,
    );

    expect(result).toBe("transaction");
    const userMsg = mockCreate.mock.calls[0][0].messages[1].content;
    expect(userMsg).toContain("🔥");
    expect(userMsg).toContain("test+tag@example.com");
  });

  it("handles very long subject line", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "transaction" } }],
    });

    const longSubject = "X".repeat(500);

    const result = await classifyEmail(
      "short body",
      longSubject,
      "test@example.com",
      config,
    );

    expect(result).toBe("transaction");
    const userMsg = mockCreate.mock.calls[0][0].messages[1].content;
    expect(userMsg).toContain(longSubject);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// dispatchEmail tests
// ─────────────────────────────────────────────────────────────────────────

describe("dispatchEmail", () => {
  let mockClassifyFn;
  let mockOrchestrator;
  let mockImapHandler;
  let mockStatementProcessor;

  const baseMsg = {
    msg_id: "msg-001",
    raw_email: "raw email content",
    subject: "Test Subject",
    from: "test@example.com",
  };

  beforeEach(() => {
    mockClassifyFn = vi.fn();
    mockOrchestrator = {
      processEmail: vi.fn().mockResolvedValue({ action: "completed" }),
    };
    mockImapHandler = {
      markRead: vi.fn().mockResolvedValue(undefined),
    };
    mockStatementProcessor = {
      processStatement: vi.fn().mockResolvedValue({
        action: "completed",
      }),
    };
  });

  it("skips email classified as 'skip' and marks as read", async () => {
    mockClassifyFn.mockResolvedValueOnce("skip");

    await dispatchEmail(
      baseMsg,
      mockClassifyFn,
      mockOrchestrator,
      mockImapHandler,
    );

    expect(mockClassifyFn).toHaveBeenCalledWith(
      baseMsg.raw_email,
      baseMsg.subject,
      baseMsg.from,
    );
    expect(mockImapHandler.markRead).toHaveBeenCalledWith("msg-001");
    expect(mockOrchestrator.processEmail).not.toHaveBeenCalled();
  });

  it("routes 'transaction' emails to the orchestrator", async () => {
    mockClassifyFn.mockResolvedValueOnce("transaction");

    await dispatchEmail(
      baseMsg,
      mockClassifyFn,
      mockOrchestrator,
      mockImapHandler,
    );

    expect(mockOrchestrator.processEmail).toHaveBeenCalledWith(
      "msg-001",
      "raw email content",
      mockImapHandler,
      "test@example.com",
      "Test Subject",
    );
    expect(mockImapHandler.markRead).not.toHaveBeenCalled();
  });

  it("routes 'statement' emails to the statementProcessor when provided", async () => {
    mockClassifyFn.mockResolvedValueOnce("statement");

    await dispatchEmail(
      baseMsg,
      mockClassifyFn,
      mockOrchestrator,
      mockImapHandler,
      mockStatementProcessor,
    );

    expect(mockStatementProcessor.processStatement).toHaveBeenCalledWith(
      "msg-001",
      "raw email content",
      mockImapHandler,
    );
    expect(mockOrchestrator.processEmail).not.toHaveBeenCalled();
    expect(mockImapHandler.markRead).not.toHaveBeenCalled();
  });

  it("falls back to orchestrator for 'statement' when no statementProcessor", async () => {
    mockClassifyFn.mockResolvedValueOnce("statement");

    await dispatchEmail(
      baseMsg,
      mockClassifyFn,
      mockOrchestrator,
      mockImapHandler,
      // no statementProcessor (undefined)
    );

    expect(mockOrchestrator.processEmail).toHaveBeenCalledWith(
      "msg-001",
      "raw email content",
      mockImapHandler,
      "test@example.com",
      "Test Subject",
    );
    expect(mockImapHandler.markRead).not.toHaveBeenCalled();
  });

  it("routes 'transaction' emails to the orchestrator even when statementProcessor exists", async () => {
    mockClassifyFn.mockResolvedValueOnce("transaction");

    await dispatchEmail(
      baseMsg,
      mockClassifyFn,
      mockOrchestrator,
      mockImapHandler,
      mockStatementProcessor,
    );

    expect(mockOrchestrator.processEmail).toHaveBeenCalledWith(
      "msg-001",
      "raw email content",
      mockImapHandler,
      "test@example.com",
      "Test Subject",
    );
    expect(mockStatementProcessor.processStatement).not.toHaveBeenCalled();
    expect(mockImapHandler.markRead).not.toHaveBeenCalled();
  });

  it("skips email without crashing when imapHandler is null", async () => {
    mockClassifyFn.mockResolvedValueOnce("skip");

    await expect(
      dispatchEmail(baseMsg, mockClassifyFn, mockOrchestrator, null),
    ).resolves.toBeUndefined();

    expect(mockOrchestrator.processEmail).not.toHaveBeenCalled();
  });

  it("handles empty msg fields gracefully", async () => {
    mockClassifyFn.mockResolvedValueOnce("transaction");

    const emptyMsg = {};
    await dispatchEmail(
      emptyMsg,
      mockClassifyFn,
      mockOrchestrator,
      mockImapHandler,
    );

    expect(mockClassifyFn).toHaveBeenCalledWith("", "", "");
    expect(mockOrchestrator.processEmail).toHaveBeenCalledWith(
      undefined,
      undefined,
      mockImapHandler,
      undefined,
      undefined,
    );
  });

  it("does not call markRead for non-existent imapHandler.markRead", async () => {
    mockClassifyFn.mockResolvedValueOnce("skip");
    const handlerWithoutMarkRead = {};

    await dispatchEmail(
      baseMsg,
      mockClassifyFn,
      mockOrchestrator,
      handlerWithoutMarkRead,
    );

    // Should not throw — gracefully handles missing markRead
    expect(mockOrchestrator.processEmail).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CLASSIFICATION_PROMPT content tests
// ─────────────────────────────────────────────────────────────────────────

describe("CLASSIFICATION_PROMPT", () => {
  it("contains the three classification categories", () => {
    expect(CLASSIFICATION_PROMPT).toContain("statement");
    expect(CLASSIFICATION_PROMPT).toContain("transaction");
    expect(CLASSIFICATION_PROMPT).toContain("skip");
  });

  it("includes IBKR and investment keywords for skip", () => {
    expect(CLASSIFICATION_PROMPT).toContain("IBKR");
    expect(CLASSIFICATION_PROMPT).toContain("trade confirmation");
    expect(CLASSIFICATION_PROMPT).toContain("portfolio");
  });

  it("includes statement keywords", () => {
    expect(CLASSIFICATION_PROMPT).toContain("eStatement");
    expect(CLASSIFICATION_PROMPT).toContain("billing cycle");
    expect(CLASSIFICATION_PROMPT).toContain("PDF attached");
  });

  it("instructs the LLM to respond with only one word", () => {
    expect(CLASSIFICATION_PROMPT).toContain("ONLY one word");
    expect(CLASSIFICATION_PROMPT).toContain("DO NOT explain");
  });
});
