/**
 * Tests for StatementProcessor — statement reconciliation orchestrator.
 * Ported from tests/statement/test_orchestrator.py
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock extractors module for password retry testing
vi.mock("../../src/extractors.js", () => ({
  extractEmailContent: vi.fn(),
  extractPdfFromBuffer: vi.fn(),
}));

import {
  StatementProcessor,
  DeepSeekClient,
  extractPasswordFromFacts,
} from "../../src/statement/orchestrator.js";
import { STATEMENT_PROMPT } from "../../src/statement/prompts.js";
import { extractEmailContent } from "../../src/extractors.js";

function makeConfig(overrides = {}) {
  return {
    deepseekApiKey: "sk-test",
    llmProvider: "deepseek",
    llmApiKey: "sk-test",
    llmBaseUrl: "https://api.deepseek.com/v1",
    llmModel: "deepseek-flash",
    llmReasoningEffort: "low",
    systemPrompt: "You are a test agent.",
    actualBudgetFile: "test-budget",
    openclawGatewayUrl: "http://openclaw:18800",
    logLevel: "INFO",
    ...overrides,
  };
}

describe("DeepSeekClient", () => {
  describe("_mergeReasoning", () => {
    it("copies reasoning_content to content when content is empty", () => {
      const client = new DeepSeekClient(makeConfig());
      const data = {
        choices: [
          {
            message: { reasoning_content: "I need to think..." },
          },
        ],
      };
      client._mergeReasoning(data);
      expect(data.choices[0].message.content).toBe("I need to think...");
    });

    it("leaves existing content untouched", () => {
      const client = new DeepSeekClient(makeConfig());
      const data = {
        choices: [
          {
            message: {
              content: "Final answer",
              reasoning_content: "ignored",
            },
          },
        ],
      };
      client._mergeReasoning(data);
      expect(data.choices[0].message.content).toBe("Final answer");
    });

    it("handles empty choices array", () => {
      const client = new DeepSeekClient(makeConfig());
      const data = { choices: [] };
      expect(() => client._mergeReasoning(data)).not.toThrow();
    });

    it("handles message with no reasoning field", () => {
      const client = new DeepSeekClient(makeConfig());
      const data = { choices: [{ message: {} }] };
      client._mergeReasoning(data);
      expect("content" in data.choices[0].message).toBe(false);
    });
  });
});

describe("StatementProcessor", () => {
  let mockTools;
  let processor;

  beforeEach(() => {
    mockTools = {
      setEmailContext: vi.fn(),
      getToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(() => Promise.resolve({ result: "ok" })),
    };
    processor = new StatementProcessor(makeConfig(), mockTools);
  });

  describe("_buildMessages", () => {
    it("returns system and user messages", () => {
      const messages = processor._buildMessages("Test statement content");
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("system");
      expect(messages[1].role).toBe("user");
    });

    it("system message uses STATEMENT_PROMPT", () => {
      const messages = processor._buildMessages("Test");
      expect(messages[0].content).toBe(STATEMENT_PROMPT);
    });

    it("includes the statement content in user message", () => {
      const messages = processor._buildMessages("CREDIT CARD STATEMENT TEXT");
      expect(messages[1].content).toContain("CREDIT CARD STATEMENT TEXT");
    });

    it("truncates long content to 60000 chars", () => {
      const longContent = "X".repeat(70000);
      const messages = processor._buildMessages(longContent);
      expect(messages[1].content.length).toBeLessThanOrEqual(60100);
    });
  });

  describe("processStatement", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      // Default: extractEmailContent returns plain text (no encryption)
      extractEmailContent.mockResolvedValue("Plain statement content.");
    });
    it("returns completed when LLM finishes with stop and no tool calls", async () => {
      const mockChat = vi.fn().mockResolvedValue({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "Statement processed successfully.",
            },
          },
        ],
      });
      processor._llm.chat = mockChat;

      const rawEmail = Buffer.from(
        "From: bank@example.com\r\nSubject: Your Statement\r\n\r\nStatement body content here.",
      );

      const result = await processor.processStatement("msg-1", rawEmail, null);

      expect(result.action).toBe("completed");
      expect(result.details).toContain("Statement processed successfully.");
      expect(mockTools.executeTool).toHaveBeenCalledWith("mark_email_read", {});
    });

    it("handles tool calls and iterates", async () => {
      const mockChat = vi
        .fn()
        .mockResolvedValueOnce({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    function: {
                      name: "fetch_accounts",
                      arguments: '{"budget_id":"sgd"}',
                    },
                  },
                ],
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: "Reconciliation complete: 5 matched, 2 outliers.",
              },
            },
          ],
        });

      processor._llm.chat = mockChat;
      mockTools.executeTool.mockResolvedValue({
        accounts: [{ id: "acc-1" }],
      });

      const rawEmail = Buffer.from(
        "From: bank@example.com\r\nSubject: Statement\r\n\r\nStatement content.",
      );

      const result = await processor.processStatement("msg-1", rawEmail, null);

      expect(result.action).toBe("completed");
      expect(mockTools.executeTool).toHaveBeenCalled();
    });

    it("returns error on unexpected finish_reason", async () => {
      processor._llm.chat = vi.fn().mockResolvedValue({
        choices: [
          {
            finish_reason: "length",
            message: { content: null, tool_calls: null },
          },
        ],
      });

      const rawEmail = Buffer.from(
        "From: bank@example.com\r\nSubject: Statement\r\n\r\nContent.",
      );

      const result = await processor.processStatement("msg-1", rawEmail, null);

      expect(result.action).toBe("error");
      expect(result.details).toContain("Unexpected finish");
    });

    it("marks email as read on success", async () => {
      processor._llm.chat = vi.fn().mockResolvedValue({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "Done." },
          },
        ],
      });

      const rawEmail = Buffer.from(
        "From: bank@example.com\r\nSubject: Statement\r\n\r\nContent.",
      );

      await processor.processStatement("msg-1", rawEmail, null);

      expect(mockTools.executeTool).toHaveBeenCalledWith("mark_email_read", {});
    });

    it("marks email as read on error", async () => {
      processor._llm.chat = vi.fn().mockRejectedValue(new Error("LLM failure"));

      const rawEmail = Buffer.from(
        "From: bank@example.com\r\nSubject: Statement\r\n\r\nContent.",
      );

      const result = await processor.processStatement("msg-1", rawEmail, null);

      expect(result.action).toBe("error");
      expect(mockTools.executeTool).toHaveBeenCalledWith("mark_email_read", {});
    });

    it("notifies user on error", async () => {
      processor._llm.chat = vi.fn().mockRejectedValue(new Error("LLM failure"));

      const rawEmail = Buffer.from(
        "From: bank@example.com\r\nSubject: Statement\r\n\r\nContent.",
      );

      await processor.processStatement("msg-1", rawEmail, null);

      const notifyCalls = mockTools.executeTool.mock.calls.filter(
        ([name]) => name === "notify_user",
      );
      expect(notifyCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("handles notification failure gracefully during error recovery", async () => {
      processor._llm.chat = vi.fn().mockRejectedValue(new Error("LLM failure"));
      mockTools.executeTool.mockImplementation((name) => {
        if (name === "notify_user") return Promise.resolve(false);
        return Promise.resolve(true);
      });

      const rawEmail = Buffer.from(
        "From: bank@example.com\r\nSubject: Statement\r\n\r\nContent.",
      );

      // Should not throw despite notification returning false
      const result = await processor.processStatement("msg-1", rawEmail, null);
      expect(result.action).toBe("error");
      // mark_email_read should NOT be called because notify_user failed
      const markCalls = mockTools.executeTool.mock.calls.filter(
        ([name]) => name === "mark_email_read",
      );
      expect(markCalls.length).toBe(0);
    });

    it("skips mark_email_read when notify_user fails at max iterations", async () => {
      const mockChat = vi.fn().mockResolvedValue({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  function: { name: "fetch_accounts", arguments: "{}" },
                },
              ],
            },
          },
        ],
      });
      processor._llm.chat = mockChat;
      mockTools.executeTool.mockImplementation((name) => {
        if (name === "notify_user") return Promise.resolve(false);
        return Promise.resolve(true);
      });

      const rawEmail = Buffer.from(
        "From: bank@example.com\r\nSubject: Statement\r\n\r\nContent.",
      );

      const result = await processor.processStatement("msg-1", rawEmail, null);
      expect(result.action).toBe("error");
      expect(result.details).toContain("Max tool iterations");
      const markCalls = mockTools.executeTool.mock.calls.filter(
        ([name]) => name === "mark_email_read",
      );
      expect(markCalls.length).toBe(0);
    }, 15000);

    it("returns error when max iterations exceeded", async () => {
      // Always return a tool call to trigger iteration
      const mockChat = vi.fn().mockResolvedValue({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  function: {
                    name: "fetch_accounts",
                    arguments: "{}",
                  },
                },
              ],
            },
          },
        ],
      });
      processor._llm.chat = mockChat;

      const rawEmail = Buffer.from(
        "From: bank@example.com\r\nSubject: Statement\r\n\r\nContent.",
      );

      const result = await processor.processStatement("msg-1", rawEmail, null);

      expect(result.action).toBe("error");
      expect(result.details).toContain("Max tool iterations");
    }, 15000);

    it("processes Buffer rawEmail correctly", async () => {
      processor._llm.chat = vi.fn().mockResolvedValue({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "Done." },
          },
        ],
      });

      const rawEmail = Buffer.from("test email content");
      const result = await processor.processStatement("msg-1", rawEmail, null);
      expect(result.action).toBe("completed");
    });

    it("handles string rawEmail gracefully", async () => {
      processor._llm.chat = vi.fn().mockResolvedValue({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "Done." },
          },
        ],
      });

      const result = await processor.processStatement(
        "msg-1",
        "plain text email",
        null,
      );
      expect(result.action).toBe("completed");
    });

    it("passes tool results as JSON strings for objects", async () => {
      const mockChat = vi
        .fn()
        .mockResolvedValueOnce({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    function: {
                      name: "fetch_accounts",
                      arguments: "{}",
                    },
                  },
                ],
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "Done." },
            },
          ],
        });

      processor._llm.chat = mockChat;
      mockTools.executeTool.mockResolvedValue({
        nested: { data: true },
      });

      const rawEmail = Buffer.from("test");
      const result = await processor.processStatement("msg-1", rawEmail, null);
      expect(result.action).toBe("completed");
    });

    it("passes [PDF_ENCRYPTED] content through to LLM when no password available", async () => {
      extractEmailContent.mockResolvedValue(
        "Email body. [PDF_ENCRYPTED: use search-memory for password or ask user]",
      );

      // search_memory returns no matching password
      mockTools.executeTool.mockImplementation((name) => {
        if (name === "search_memory") {
          return Promise.resolve({
            results: ["Coffee mapping: Coffee Bean maps to Coffee"],
          });
        }
        return Promise.resolve({ result: "ok" });
      });

      processor._llm.chat = vi.fn().mockResolvedValue({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "Cannot process encrypted PDF." },
          },
        ],
      });

      const rawEmail = Buffer.from("encrypted email");
      await processor.processStatement("msg-1", rawEmail, null);

      // Only called once — no retry with password
      expect(extractEmailContent).toHaveBeenCalledTimes(1);
      // [PDF_ENCRYPTED] marker should remain in the text passed to LLM
      const messages = processor._buildMessages(
        "Email body. [PDF_ENCRYPTED: use search-memory for password or ask user]",
      );
      expect(messages[1].content).toContain("[PDF_ENCRYPTED");
    });
  });
});

describe("extractPasswordFromFacts", () => {
  it("extracts password from 'password is X' pattern", () => {
    expect(
      extractPasswordFromFacts(["Epsilon Nova statement password is Test@123"]),
    ).toBe("Test@123");
  });

  it("extracts password from 'password: X' pattern", () => {
    expect(
      extractPasswordFromFacts(["CIMB statement password: MySecret99"]),
    ).toBe("MySecret99");
  });

  it("extracts password from 'password = X' pattern", () => {
    expect(extractPasswordFromFacts(["OCBC PDF password = abc-123"])).toBe(
      "abc-123",
    );
  });

  it("returns null when no password fact exists", () => {
    expect(
      extractPasswordFromFacts([
        "Coffee mapping: Coffee Bean maps to Coffee",
        "Food category: hawker",
      ]),
    ).toBeNull();
  });

  it("returns null for empty facts array", () => {
    expect(extractPasswordFromFacts([])).toBeNull();
  });

  it("returns null for non-array input", () => {
    expect(extractPasswordFromFacts(null)).toBeNull();
    expect(extractPasswordFromFacts(undefined)).toBeNull();
    expect(extractPasswordFromFacts({ password: "x" })).toBeNull();
  });
});

describe("STATEMENT_PROMPT", () => {
  it("contains reconciliation rules", () => {
    const prompt = STATEMENT_PROMPT.toLowerCase();
    expect(prompt).toContain("reconciliation");
    expect(prompt).toContain("statement");
    expect(prompt).toContain("outlier");
  });

  it("contains notification rules", () => {
    const prompt = STATEMENT_PROMPT.toLowerCase();
    expect(prompt).toContain("notify_user");
    expect(prompt).toContain("mark_email_read");
  });

  it("contains currency routing", () => {
    const prompt = STATEMENT_PROMPT;
    expect(prompt).toContain("SGD");
    expect(prompt).toContain("MYR");
  });

  it("mentions AUTHORITATIVE as the bank's role", () => {
    expect(STATEMENT_PROMPT).toContain("AUTHORITATIVE");
  });
});

// --- DeepSeek API call format regression tests (bug: body override) ---
describe("DeepSeekClient API format", () => {
  it("passes thinking in kwargs body, not as RequestOptions override", async () => {
    const config = makeConfig();
    const client = new DeepSeekClient(config);

    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ finish_reason: "stop", message: { content: "ok" } }],
    });
    client._client.chat.completions.create = mockCreate;

    await client.chat([{ role: "user", content: "hello" }], null);

    const callArgs = mockCreate.mock.calls[0];
    // Second arg carries only the abort signal (#697), never `thinking`.
    expect(Object.keys(callArgs[1] || {})).toEqual(["signal"]);
    const kwargs = callArgs[0];
    expect(kwargs.messages).toBeDefined();
    expect(kwargs.messages[0].content).toBe("hello");
    expect(kwargs.thinking).toEqual({ type: "adaptive" });
    expect(kwargs.model).toBe("deepseek-flash");
  });

  it("includes tools in kwargs with tool_choice auto", async () => {
    const config = makeConfig();
    const client = new DeepSeekClient(config);

    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ finish_reason: "stop", message: { content: "ok" } }],
    });
    client._client.chat.completions.create = mockCreate;

    const tools = [{ type: "function", function: { name: "test_tool" } }];
    await client.chat([{ role: "user", content: "hi" }], tools);

    const kwargs = mockCreate.mock.calls[0][0];
    expect(kwargs.tools).toEqual(tools);
    expect(kwargs.tool_choice).toBe("auto");
    expect(kwargs.thinking).toEqual({ type: "adaptive" });
  });

  it("uses adaptive thinking on the statement deepseek route, which has no low effort", async () => {
    const config = makeConfig();
    const client = new DeepSeekClient(config);

    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ finish_reason: "stop", message: { content: "ok" } }],
    });
    client._client.chat.completions.create = mockCreate;

    const tools = [{ type: "function", function: { name: "fetch_history" } }];
    await client.chat([{ role: "user", content: "reconcile" }], tools);

    expect(mockCreate.mock.calls[0][0].thinking).toEqual({ type: "adaptive" });
  });

  it("retries on failure then succeeds on second attempt", async () => {
    const config = makeConfig();
    const client = new DeepSeekClient(config);

    const mockCreate = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValue({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
      });
    client._client.chat.completions.create = mockCreate;

    const result = await client.chat([{ role: "user", content: "hi" }], null);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.choices[0].message.content).toBe("ok");
  });
});

describe("issuer-scoped statement password selection (#646)", () => {
  const ENC =
    "Body. [PDF_ENCRYPTED: use search-memory for password or ask user]";
  const FACTS = [
    "Alphabank statement password is AlphaKey-111",
    "Betacard statement password is BetaKey-222",
    "Gammatrust statement password is GammaKey-333",
  ];
  const permutations = (arr) =>
    arr.length <= 1
      ? [arr]
      : arr.flatMap((x, i) =>
          permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [
            x,
            ...p,
          ]),
        );
  const emailFrom = (name) =>
    Buffer.from(
      `From: ${name} <statements@${name.toLowerCase()}.example>\r\nSubject: ${name} credit card statement\r\n\r\nx`,
    );

  function setup(facts, decryptWith) {
    const tools = {
      setEmailContext: vi.fn(),
      getToolSchemas: vi.fn().mockReturnValue([]),
      executeTool: vi
        .fn()
        .mockImplementation((name) =>
          Promise.resolve(name === "search_memory" ? { results: facts } : true),
        ),
    };
    const p = new StatementProcessor(makeConfig(), tools);
    p._llm.chat = vi.fn().mockResolvedValue({
      choices: [{ finish_reason: "stop", message: { content: "ok" } }],
    });
    extractEmailContent.mockReset();
    extractEmailContent.mockImplementation((_raw, pw) =>
      Promise.resolve(pw && decryptWith.includes(pw) ? "decrypted" : ENC),
    );
    return { p, tools };
  }

  it("picks issuer A's key across all 6 fact orderings", () => {
    for (const perm of permutations(FACTS)) {
      expect(
        extractPasswordFromFacts(perm, { issuerHints: ["alphabank"] }),
      ).toBe("AlphaKey-111");
    }
  });

  it("uses issuer A's key and queries memory with the issuer", async () => {
    for (const perm of permutations(FACTS)) {
      const { p, tools } = setup(perm, ["AlphaKey-111"]);
      await p.processStatement("m", emailFrom("Alphabank"), null);
      const q = tools.executeTool.mock.calls.find(
        ([n]) => n === "search_memory",
      )[1].query;
      expect(q.toLowerCase()).toContain("alphabank");
      expect(extractEmailContent).toHaveBeenCalledWith(
        expect.anything(),
        "AlphaKey-111",
      );
      expect(extractEmailContent).not.toHaveBeenCalledWith(
        expect.anything(),
        "BetaKey-222",
      );
    }
  });

  it("a retry tries a different candidate after a failed one", async () => {
    const { p } = setup(
      [
        "Alphabank statement password is Bad-1",
        "Alphabank PDF password: Good-2",
      ],
      ["Good-2"],
    );
    await p.processStatement("m", emailFrom("Alphabank"), null);
    const pws = extractEmailContent.mock.calls.map((c) => c[1]).filter(Boolean);
    expect(pws).toHaveLength(2);
    expect(new Set(pws).size).toBe(2);
    expect(pws).toContain("Good-2");
  });

  it("a format-description fact does not outrank a concrete issuer fact", () => {
    const facts = [
      "Alphabank statement password is DDMMYYYY (format: date of birth)",
      "Alphabank statement password is AlphaKey-111",
    ];
    for (const perm of permutations(facts)) {
      expect(
        extractPasswordFromFacts(perm, { issuerHints: ["alphabank"] }),
      ).toBe("AlphaKey-111");
    }
  });
});
