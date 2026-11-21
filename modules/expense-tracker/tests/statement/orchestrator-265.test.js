/**
 * #265: a statement run that already sent its summary must not report failure
 * or send a second "Failed processing statement" message, and the rebuilt
 * history keeps reasoning_content for the DeepSeek fallback.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/extractors.js", () => ({
  extractEmailContent: vi.fn(),
  extractPdfFromBuffer: vi.fn(),
}));

import { StatementProcessor } from "../../src/statement/orchestrator.js";
import { extractEmailContent } from "../../src/extractors.js";

const RAW = Buffer.from(
  "From: bank@example.com\r\nSubject: Statement\r\n\r\nStatement content.",
);

function toolTurn(calls, extra = {}) {
  return {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: calls.map(([name, args], i) => ({
            id: `call-${name}-${i}`,
            function: { name, arguments: JSON.stringify(args) },
          })),
          ...extra,
        },
      },
    ],
  };
}

describe("statement run after the summary was sent (#265)", () => {
  let tools;
  let processor;

  beforeEach(() => {
    vi.clearAllMocks();
    extractEmailContent.mockResolvedValue("Plain statement content.");
    tools = {
      setEmailContext: vi.fn(),
      getToolSchemas: vi.fn(() => []),
      executeTool: vi.fn((name) => {
        if (name === "record_statement") return Promise.resolve({ id: 7, status: "recorded" });
        if (name === "fetch_statement_history") return Promise.resolve(null);
        return Promise.resolve(true);
      }),
    };
    processor = new StatementProcessor(
      { deepseekApiKey: "sk-test", llmProvider: "deepseek", llmModel: "deepseek-flash" },
      tools,
    );
  });

  const notifies = () =>
    tools.executeTool.mock.calls.filter(([name]) => name === "notify_user");

  it("completes with the summary when the closing turn fails", async () => {
    processor._llm.chat = vi
      .fn()
      .mockResolvedValueOnce(
        toolTurn([
          ["record_statement", { account_id: "acc-1" }],
          ["notify_user", { message: "Statement reconciled: 2 outliers" }],
        ]),
      )
      .mockRejectedValueOnce(new Error("All LLM routes failed"));

    const result = await processor.processStatement("msg-1", RAW, null);

    expect(result.action).toBe("completed");
    expect(result.details).toContain("Statement reconciled: 2 outliers");
    expect(notifies()).toHaveLength(1);
    expect(tools.executeTool).toHaveBeenCalledWith("mark_email_read", {});
  });

  it("treats a prior-record hit plus notify as the summary too", async () => {
    tools.executeTool.mockImplementation((name) =>
      Promise.resolve(name === "fetch_statement_history" ? { id: 3 } : true));
    processor._llm.chat = vi
      .fn()
      .mockResolvedValueOnce(
        toolTurn([
          ["fetch_statement_history", { account_id: "acc-1" }],
          ["notify_user", { message: "Already processed" }],
        ]),
      )
      .mockRejectedValueOnce(new Error("All LLM routes failed"));

    const result = await processor.processStatement("msg-1", RAW, null);

    expect(result.action).toBe("completed");
    expect(notifies()).toHaveLength(1);
  });

  it("still reports an error after a notify that was not the summary", async () => {
    processor._llm.chat = vi
      .fn()
      .mockResolvedValueOnce(toolTurn([["notify_user", { message: "Need the PDF password" }]]))
      .mockRejectedValueOnce(new Error("All LLM routes failed"));

    const result = await processor.processStatement("msg-1", RAW, null);

    expect(result.action).toBe("error");
    expect(notifies()).toHaveLength(2);
  });

  it("completes without the max-iterations notice once the summary was sent", async () => {
    processor._llm.chat = vi
      .fn()
      .mockResolvedValueOnce(
        toolTurn([
          ["record_statement", { account_id: "acc-1" }],
          ["notify_user", { message: "Statement reconciled" }],
        ]),
      )
      .mockResolvedValue(toolTurn([["fetch_accounts", {}]]));

    const result = await processor.processStatement("msg-1", RAW, null);

    expect(result.action).toBe("completed");
    expect(notifies()).toHaveLength(1);
  }, 15000);

  it("passes reasoning_content back on one assistant message per turn", async () => {
    const seen = [];
    processor._llm.chat = vi.fn(async (messages) => {
      seen.push(structuredClone(messages));
      if (seen.length === 1) {
        return toolTurn([["fetch_accounts", {}]], {
          content: "Looking up accounts",
          reasoning_content: "think first",
        });
      }
      return { choices: [{ finish_reason: "stop", message: { content: "done" } }] };
    });

    await processor.processStatement("msg-1", RAW, null);

    const assistants = seen[1].filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({
      content: "Looking up accounts",
      reasoning_content: "think first",
    });
    expect(assistants[0].tool_calls).toHaveLength(1);
  });
});
