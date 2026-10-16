/**
 * Issue #694 review finding M1: the classifier's Responses call must leave room
 * for reasoning tokens, or a reasoning hop returns `incomplete` and every email
 * silently classifies as "transaction".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.fn();
const mockResponsesCreate = vi.fn();

vi.mock("openai", () => ({
    default: vi.fn(() => ({
        chat: { completions: { create: mockCreate } },
        responses: { create: mockResponsesCreate },
    })),
}));

import { classifyEmail } from "../src/classify.js";

const routerConfig = {
    llmProvider: "litellm",
    llmApiKey: "router-key",
    llmBaseUrl: "http://codex-router:4100/v1",
    llmModel: "auto-thinking",
    llmFallbackModel: "",
    deepseekApiKey: "deepseek-key",
};

beforeEach(() => {
    vi.clearAllMocks();
});

describe("classifyEmail Responses call (#694 M1)", () => {
    it("asks for low reasoning effort and a budget that leaves room for reasoning", async () => {
        mockResponsesCreate.mockResolvedValueOnce({
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: "statement" }] }],
        });

        const result = await classifyEmail(
            "Your monthly eStatement is ready",
            "Your Monthly eStatement",
            "bank@example.com",
            routerConfig,
        );

        expect(result).toBe("statement");
        const request = mockResponsesCreate.mock.calls[0][0];
        expect(request.reasoning).toEqual({ effort: "low" });
        expect(request.max_output_tokens).toBeGreaterThanOrEqual(64);
    });

    it("does not coerce an incomplete router answer into 'statement'/'skip'; it tries the next route", async () => {
        mockResponsesCreate.mockResolvedValueOnce({ status: "incomplete", output: [] });
        mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "skip" } }] });

        const result = await classifyEmail(
            "Your monthly eStatement is ready",
            "Your Monthly eStatement",
            "bank@example.com",
            routerConfig,
        );

        expect(result).toBe("skip");
        expect(mockCreate).toHaveBeenCalledTimes(1);
    });
});
