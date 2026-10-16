/**
 * Issue #694: auto-thinking is Responses-only, and an LLM outage must not burn
 * the 12h retry cooldown of an unread email.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chatCreate = vi.fn();
const responsesCreate = vi.fn();

vi.mock("openai", () => {
    class APIConnectionError extends Error {}
    const OpenAI = vi.fn(() => ({
        chat: { completions: { create: chatCreate } },
        responses: { create: responsesCreate },
    }));
    OpenAI.APIConnectionError = APIConnectionError;
    return { default: OpenAI };
});

import { AgentOrchestrator, LLMClient } from "../src/orchestrator.js";
import { Config } from "../src/config.js";
import { DedupJournal, RETRY_COOLDOWN_MINUTES } from "../src/dedup.js";
import { ImapIdleHandler } from "../src/imap.js";
import OpenAI from "openai";
import { LLMUnavailableError, deterministicError, isOutageShaped } from "../src/llm-responses.js";

beforeEach(() => {
    chatCreate.mockReset();
    responsesCreate.mockReset();
});
afterEach(() => vi.useRealTimers());

const env = {
    ACTUAL_BUDGET_URL: "http://actual-api:3000",
    ACTUAL_BUDGET_PASSWORD: "pw",
    ACTUAL_PRIMARY_BUDGET_FILE: "SGD",
    ACTUAL_SECONDARY_BUDGET_FILE: "MYR",
    IMAP_HOST: "imap.example.com",
    IMAP_USERNAME: "u@example.com",
    IMAP_PASSWORD: "pw",
    NOTIFY_URL: "http://hermes:8644/webhooks/notify",
    HERMES_WEBHOOK_SECRET: "s",
    DEEPSEEK_API_KEY: "ds-key",
    DEDUP_DB_PATH: ":memory:",
    STATEMENT_DB_PATH: ":memory:",
    LLM_PROVIDER: "litellm_proxy",
    LLM_BASE_URL: "http://codex-router:4100/v1",
    LLM_MODEL: "auto-thinking",
    LLM_API_KEY: "router-key",
};
const routerConfig = (extra = {}) => new Config({ ...env, ...extra });

const textResponse = (text) => ({
    status: "completed",
    output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    ],
});

describe("router route speaks the Responses API (#694)", () => {
    it("calls responses.create, never chat.completions, for auto-thinking", async () => {
        responsesCreate.mockResolvedValueOnce(textResponse("{}"));
        const client = new LLMClient(routerConfig());

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
        expect(res.choices[0].message.content).toBe("{}");
        expect(res.choices[0].finish_reason).toBe("stop");
    });

    it("maps tools, tool calls and tool results between both shapes", async () => {
        responsesCreate.mockResolvedValueOnce({
            status: "completed",
            output: [
                { type: "function_call", call_id: "c1", name: "fetch_context", arguments: "{\"a\":1}" },
            ],
        });
        const client = new LLMClient(routerConfig());
        const tools = [
            { type: "function", function: { name: "fetch_context", description: "d", parameters: { type: "object" } } },
        ];

        const res = await client.chat(
            [
                { role: "user", content: "go" },
                { role: "assistant", content: null, tool_calls: [
                    { id: "c0", type: "function", function: { name: "fetch_context", arguments: "{}" } },
                ] },
                { role: "tool", tool_call_id: "c0", content: "result" },
            ],
            tools,
            "auto",
        );

        const req = responsesCreate.mock.calls[0][0];
        expect(req.tools).toEqual([
            { type: "function", name: "fetch_context", description: "d", parameters: { type: "object" } },
        ]);
        expect(req.tool_choice).toBe("auto");
        expect(req.input).toEqual([
            { role: "user", content: "go" },
            { type: "function_call", call_id: "c0", name: "fetch_context", arguments: "{}" },
            { type: "function_call_output", call_id: "c0", output: "result" },
        ]);
        const call = res.choices[0].message.tool_calls[0];
        expect(call).toEqual({
            id: "c1",
            type: "function",
            function: { name: "fetch_context", arguments: "{\"a\":1}" },
        });
        expect(res.choices[0].finish_reason).toBe("tool_calls");
    });

    it("keeps the direct DeepSeek final fallback on chat.completions", async () => {
        responsesCreate.mockRejectedValue(new Error("router down"));
        chatCreate.mockResolvedValueOnce({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] });
        const client = new LLMClient(routerConfig());

        await client.chat([{ role: "user", content: "hi" }]);

        expect(chatCreate.mock.calls[0][0].model).toBe("deepseek-flash");
    }, 15000);

    it("no longer defaults to the retired gpt-5.6-terra fallback", () => {
        expect(routerConfig().llmFallbackModel).toBe("");
    });

    it("names every failed route when all of them fail", async () => {
        responsesCreate.mockRejectedValue(new Error("400 unsupported_endpoint_for_model"));
        chatCreate.mockRejectedValue(new Error("402 Insufficient Balance"));
        const client = new LLMClient(routerConfig());

        await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
            /auto-thinking.*unsupported_endpoint_for_model[\s\S]*deepseek-flash.*Insufficient Balance/,
        );
    }, 15000);
});

describe("LLM outage is retryable, not 'couldn't understand' (#694)", () => {
    const makeTools = () => ({
        setEmailContext: vi.fn(),
        getToolSchemas: vi.fn(() => []),
        executeTool: vi.fn(async () => true),
    });

    it("returns llm_unavailable and says so when every route fails", async () => {
        const tools = makeTools();
        const orch = new AgentOrchestrator(routerConfig(), tools);
        orch._llm.chat = vi.fn().mockRejectedValue(new LLMUnavailableError("All LLM routes failed"));

        const result = await orch.processEmail(
            "1069",
            "Card Transaction Alert\nS$5.00 was spent on your card ending 7111 at SOME SHOP",
            null,
            "ibanking.alert@dbs.com",
            "Card Transaction Alert",
        );

        expect(result.action).toBe("llm_unavailable");
        const messages = tools.executeTool.mock.calls
            .filter(([name]) => name === "notify_user")
            .map(([, args]) => args.message);
        expect(messages.join("\n")).not.toMatch(/Couldn't understand/);
    }, 30000);

    it("recordProcessed with a retry delay re-opens the email after that delay, not 12h", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-07T21:32:00Z"));
        const dedup = new DedupJournal(":memory:");

        dedup.recordProcessed("1069", 5);
        expect(dedup.isRecentlyProcessed("1069")).toBe(true);

        vi.setSystemTime(new Date("2026-10-07T21:38:00Z"));
        expect(dedup.isRecentlyProcessed("1069")).toBe(false);

        dedup.recordProcessed("1070");
        vi.setSystemTime(new Date("2026-10-07T21:38:00Z"));
        expect(dedup.isRecentlyProcessed("1070")).toBe(true);
        expect(RETRY_COOLDOWN_MINUTES).toBe(720);
    });

    it("imap loop uses the short retry for llm_unavailable results", async () => {
        const dedup = {
            isRecentlyProcessed: vi.fn(() => false),
            isMessageBooked: () => false,
            recordProcessed: vi.fn(),
            markMessageBooked: vi.fn(),
            noteMailboxUidValidity: vi.fn().mockReturnValue(false),
        };
        const handler = new ImapIdleHandler("h", 993, "u", "p", dedup);
        const source = Buffer.from("From: a@dbs.com\r\nSubject: Card Transaction Alert\r\n\r\nBody");
        handler.connect = vi.fn(async () => {
            handler._client = {
                fetch: vi.fn(() => ({
                    [Symbol.asyncIterator]() {
                        let done = false;
                        return { async next() {
                            if (done) return { done: true };
                            done = true;
                            return { value: { uid: 1069, seq: 1069, source, envelope: {} }, done: false };
                        } };
                    },
                })),
                idle: vi.fn(async () => { handler._running = false; }),
                logout: vi.fn(async () => {}),
            };
        });

        await handler.idleLoop(async () => ({ action: "llm_unavailable" }));

        expect(dedup.recordProcessed).toHaveBeenCalledWith("1069", expect.any(Number));
        expect(dedup.recordProcessed.mock.calls[0][1]).toBeLessThan(60);
        expect(dedup.markMessageBooked).not.toHaveBeenCalled();
    });
});

describe("outage discriminator (#694)", () => {
    it("classifies each error shape", () => {
        expect(isOutageShaped(Object.assign(new Error("402"), { status: 402 }))).toBe(true);
        expect(isOutageShaped(new OpenAI.APIConnectionError())).toBe(true);
        expect(isOutageShaped(new Error("timeout"))).toBe(true);
        expect(isOutageShaped(deterministicError("LLM response truncated"))).toBe(false);
        expect(isOutageShaped(new TypeError("bad mapping"))).toBe(false);
    });

    it("all-truncated failures are a plain error, not an outage", async () => {
        responsesCreate.mockResolvedValue({ status: "incomplete", output: [] });
        chatCreate.mockResolvedValue({ choices: [{ message: { content: "x" }, finish_reason: "length" }] });
        const client = new LLMClient(routerConfig());

        const error = await client.chat([{ role: "user", content: "hi" }]).catch((e) => e);

        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(LLMUnavailableError);
    }, 30000);

    it("one outage-shaped failure among truncations is an outage", async () => {
        responsesCreate.mockResolvedValue({ status: "incomplete", output: [] });
        chatCreate.mockRejectedValue(Object.assign(new Error("402 Insufficient Balance"), { status: 402 }));
        const client = new LLMClient(routerConfig());

        await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(LLMUnavailableError);
    }, 30000);

    it("a deterministic LLM failure in Phase 1 still yields the old not-understood path", async () => {
        const tools = {
            setEmailContext: vi.fn(),
            getToolSchemas: vi.fn(() => []),
            executeTool: vi.fn(async () => true),
        };
        const orch = new AgentOrchestrator(routerConfig(), tools);
        orch._llm.chat = vi.fn().mockRejectedValue(deterministicError("LLM response truncated"));

        const result = await orch.processEmail("7", "Card Transaction Alert\nS$5.00 at SHOP", null, "a@dbs.com", "Card Transaction Alert");

        expect(result.action).toBe("notified");
    }, 30000);

    it("stops short-retrying after the cap and falls back to the 12h cooldown", async () => {
        const tools = {
            setEmailContext: vi.fn(),
            getToolSchemas: vi.fn(() => []),
            executeTool: vi.fn(async () => true),
        };
        const orch = new AgentOrchestrator(routerConfig(), tools);
        orch._llm.chat = vi.fn().mockRejectedValue(new LLMUnavailableError("down"));
        const run = () => orch.processEmail("9", "Card Transaction Alert\nS$5.00 at SHOP", null, "a@dbs.com", "Card Transaction Alert");

        for (let i = 0; i < 12; i++) expect((await run()).action).toBe("llm_unavailable");
        expect((await run()).action).toBe("notified");
        const notices = tools.executeTool.mock.calls.filter(([n]) => n === "notify_user");
        expect(notices).toHaveLength(1);
    }, 60000);
});
