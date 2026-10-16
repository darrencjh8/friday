/**
 * Issue #695: the portfolio tracker must reach auto-thinking through the
 * router's Responses API, with direct DeepSeek (Chat Completions) as fallback.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const chatCreate = vi.fn();
const responsesCreate = vi.fn();

vi.mock("openai", () => ({
    default: vi.fn(() => ({
        chat: { completions: { create: chatCreate } },
        responses: { create: responsesCreate },
    })),
}));

import { LLMClient } from "../src/orchestrator.js";
import { Config } from "../src/config.js";

beforeEach(() => {
    chatCreate.mockReset();
    responsesCreate.mockReset();
});

const env = {
    DEEPSEEK_API_KEY: "ds-key",
    ACTUAL_BUDGET_URL: "http://actual-api:3000",
    ACTUAL_BUDGET_PASSWORD: "pw",
    ACTUAL_PRIMARY_BUDGET_FILE: "SGD",
    ONEDRIVE_CLIENT_ID: "cid",
};
const makeConfig = (extra = {}) => new Config({ ...env, ...extra });

const textResponse = (text) => ({
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
});

describe("config defaults (#695)", () => {
    it("points at the router's auto-thinking by default", () => {
        const config = makeConfig({ LLM_API_KEY: "router-key" });
        expect(config.llmBaseUrl).toBe("http://codex-router:4100/v1");
        expect(config.llmModel).toBe("auto-thinking");
        expect(config.llmApiKey).toBe("router-key");
        expect(config.llmReasoningEffort).toBe("low");
    });
});

describe("LLMClient router route (#695)", () => {
    it("calls responses.create, never chat.completions, for auto-thinking", async () => {
        responsesCreate.mockResolvedValueOnce(textResponse("done"));
        const client = new LLMClient(makeConfig({ LLM_API_KEY: "router-key" }));

        const res = await client.chat([
            { role: "system", content: "sys" },
            { role: "user", content: "hi" },
        ]);

        expect(chatCreate).not.toHaveBeenCalled();
        const req = responsesCreate.mock.calls[0][0];
        expect(req.model).toBe("auto-thinking");
        expect(req.input).toEqual([
            { role: "system", content: "sys" },
            { role: "user", content: "hi" },
        ]);
        expect(req.reasoning).toEqual({ effort: "low" });
        expect(req).not.toHaveProperty("messages");
        expect(res.choices[0].message.content).toBe("done");
        expect(res.choices[0].finish_reason).toBe("stop");
    });

    it("maps tools, tool calls and tool results between both shapes", async () => {
        responsesCreate.mockResolvedValueOnce({
            status: "completed",
            output: [{ type: "function_call", call_id: "c1", name: "book_trade", arguments: "{\"a\":1}" }],
        });
        const client = new LLMClient(makeConfig({ LLM_API_KEY: "router-key" }));
        const tools = [
            { type: "function", function: { name: "book_trade", description: "d", parameters: { type: "object" } } },
        ];

        const res = await client.chat(
            [
                { role: "user", content: "go" },
                { role: "assistant", content: null, tool_calls: [
                    { id: "c0", type: "function", function: { name: "book_trade", arguments: "{}" } },
                ] },
                { role: "tool", tool_call_id: "c0", content: "ok" },
            ],
            tools,
        );

        const req = responsesCreate.mock.calls[0][0];
        expect(req.tools).toEqual([
            { type: "function", name: "book_trade", description: "d", parameters: { type: "object" } },
        ]);
        expect(req.tool_choice).toBe("auto");
        expect(req.input).toEqual([
            { role: "user", content: "go" },
            { type: "function_call", call_id: "c0", name: "book_trade", arguments: "{}" },
            { type: "function_call_output", call_id: "c0", output: "ok" },
        ]);
        expect(res.choices[0].message.tool_calls[0]).toEqual({
            id: "c1",
            type: "function",
            function: { name: "book_trade", arguments: "{\"a\":1}" },
        });
        expect(res.choices[0].finish_reason).toBe("tool_calls");
    });

    it("falls back to direct DeepSeek on chat.completions when the router fails", async () => {
        responsesCreate.mockRejectedValue(new Error("router down"));
        chatCreate.mockResolvedValueOnce({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
        const client = new LLMClient(makeConfig({ LLM_API_KEY: "router-key" }));

        const res = await client.chat([{ role: "user", content: "hi" }]);

        expect(chatCreate.mock.calls[0][0].model).toBe("deepseek-flash");
        expect(res.choices[0].message.content).toBe("ok");
    }, 15000);

    it("treats a truncated router answer as a failure and tries the next route", async () => {
        responsesCreate.mockResolvedValue({ status: "incomplete", output: [] });
        chatCreate.mockResolvedValueOnce({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
        const client = new LLMClient(makeConfig({ LLM_API_KEY: "router-key" }));

        const res = await client.chat([{ role: "user", content: "hi" }]);

        expect(res.choices[0].message.content).toBe("ok");
    }, 15000);

    it("names every failed route when all of them fail", async () => {
        responsesCreate.mockRejectedValue(new Error("400 unsupported_endpoint_for_model"));
        chatCreate.mockRejectedValue(new Error("402 Insufficient Balance"));
        const client = new LLMClient(makeConfig({ LLM_API_KEY: "router-key" }));

        await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
            /auto-thinking.*unsupported_endpoint_for_model[\s\S]*deepseek-flash.*Insufficient Balance/,
        );
    }, 15000);
});
