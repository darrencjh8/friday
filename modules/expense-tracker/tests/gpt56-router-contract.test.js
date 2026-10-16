import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const responsesCreate = vi.fn();

vi.mock("openai", () => ({
  default: vi.fn(() => ({
    chat: { completions: { create } },
    responses: { create: responsesCreate },
  })),
}));

import { LLMClient } from "../src/orchestrator.js";
import { Config } from "../src/config.js";

beforeEach(() => {
  create.mockReset();
  responsesCreate.mockReset();
});

const requiredEnv = {
  ACTUAL_BUDGET_URL: "http://actual-api:3000",
  ACTUAL_BUDGET_PASSWORD: "test-password",
  ACTUAL_PRIMARY_BUDGET_FILE: "Example SGD",
  ACTUAL_SECONDARY_BUDGET_FILE: "Example MYR",
  ACTUAL_PRIMARY_CURRENCY: "SGD",
  ACTUAL_SECONDARY_CURRENCY: "MYR",
  IMAP_HOST: "imap.example.com",
  IMAP_USERNAME: "test@example.com",
  IMAP_PASSWORD: "test-password",
  NOTIFY_URL: "http://hermes:8644/webhooks/notify",
  HERMES_WEBHOOK_SECRET: "test-secret",
  DEEPSEEK_API_KEY: "deepseek-test-key",
};

function gptRouterConfig() {
  return new Config({
    ...requiredEnv,
    LLM_PROVIDER: "litellm",
    LLM_BASE_URL: "http://codex-router:4100/v1",
    LLM_MODEL: "gpt-5.6-luna",
    LLM_API_KEY: "router-local-key",
    LLM_REASONING_EFFORT: "low",
  });
}

describe("GPT-5.6 LiteLLM contract", () => {
  it("defaults LiteLLM traffic to the auto-thinking router pool", () => {
    const config = new Config({ ...requiredEnv, LLM_PROVIDER: "litellm" });

    expect(config.llmModel).toBe("auto-thinking");
    expect(config.llmFallbackModel).toBe("");
    expect(config.llmFinalFallbackProvider).toBe("deepseek");
  });

  it("sends the router only Responses parameters", async () => {
    responsesCreate.mockResolvedValueOnce({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }],
    });
    const client = new LLMClient(gptRouterConfig());

    await client.chat([{ role: "user", content: "parse transaction" }]);

    const request = responsesCreate.mock.calls[0][0];
    expect(request.model).toBe("gpt-5.6-luna");
    expect(request.reasoning).toEqual({ effort: "low" });
    expect(request).not.toHaveProperty("temperature");
    expect(request).not.toHaveProperty("thinking");
    expect(request).not.toHaveProperty("messages");
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps DeepSeek-only thinking and low temperature off router requests", async () => {
    responsesCreate.mockResolvedValueOnce({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }],
    });
    const client = new LLMClient(gptRouterConfig());

    await client.chat([{ role: "user", content: "parse transaction" }], undefined, undefined, {
      reasoning: "adaptive",
    });

    const request = responsesCreate.mock.calls[0][0];
    expect(request).not.toHaveProperty("thinking");
    expect(request).not.toHaveProperty("temperature");
  });

  it("falls back from the router to DeepSeek with the final fallback credential", async () => {
    responsesCreate.mockRejectedValue(new Error("router unavailable"));
    create.mockResolvedValueOnce({ choices: [{ message: { content: "{}" } }] });
    const client = new LLMClient(gptRouterConfig());

    await client.chat([{ role: "user", content: "parse transaction" }]);

    expect(responsesCreate.mock.calls.map(([request]) => request.model)).toEqual([
      "gpt-5.6-luna", // router is tried once: its 300s budget is not retried (#697)
    ]);
    expect(create.mock.calls[0][0].model).toBe("deepseek-flash");
    expect(create.mock.calls[0][0].temperature).toBe(0.1);
    expect(create.mock.calls[0][0].thinking).toEqual({ type: "adaptive" });
  }, 15000);
});
