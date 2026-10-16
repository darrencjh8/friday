/**
 * Issue #697: a timed-out LLM request must be cancelled (AbortSignal), and the
 * router route's timeout/retries match its 300s per-hop budget.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chatCreate = vi.fn();
const responsesCreate = vi.fn();

vi.mock("openai", () => {
    const OpenAI = vi.fn(() => ({
        chat: { completions: { create: chatCreate } },
        responses: { create: responsesCreate },
    }));
    OpenAI.APIConnectionError = class extends Error {};
    return { default: OpenAI };
});

import { LLMClient } from "../src/orchestrator.js";
import { Config } from "../src/config.js";

beforeEach(() => {
    vi.useFakeTimers();
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
    ONEDRIVE_CLIENT_ID: "cid",
    LLM_API_KEY: "router-key",
    LLM_PROVIDER: "litellm_proxy", LLM_BASE_URL: "http://codex-router:4100/v1", LLM_MODEL: "auto-thinking",
};

/** A create() that never resolves but rejects when its signal aborts. */
const hung = (signals) =>
    vi.fn((_body, options) => {
        signals.push(options?.signal);
        return new Promise((_, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
    });

describe("router route timeout (#697)", () => {
    it("aborts the request at 300s, not 60s, and does not retry the router", async () => {
        const signals = [];
        responsesCreate.mockImplementation(hung(signals));
        chatCreate.mockRejectedValue(new Error("fallback down"));
        const client = new LLMClient(new Config(env));
        const p = client.chat([{ role: "user", content: "hi" }]).catch((e) => e);

        await vi.advanceTimersByTimeAsync(60_000);
        expect(signals[0]).toBeInstanceOf(AbortSignal);
        expect(signals[0].aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(240_000);
        expect(signals[0].aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await p).toBeInstanceOf(Error);
        expect(responsesCreate).toHaveBeenCalledTimes(1);
    });
});

describe("direct DeepSeek route timeout (#697)", () => {
    it("aborts at 60s and retries up to route.retries", async () => {
        const signals = [];
        chatCreate.mockImplementation(hung(signals));
        const cfg = new Config({ ...env, LLM_PROVIDER: "deepseek", LLM_BASE_URL: "", LLM_MODEL: "deepseek-flash" });
        const client = new LLMClient(cfg);
        const p = client.chat([{ role: "user", content: "hi" }]).catch((e) => e);
        await vi.advanceTimersByTimeAsync(59_000);
        expect(signals[0].aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(signals[0].aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(await p).toBeInstanceOf(Error);
        expect(signals.length).toBeGreaterThanOrEqual(3);
        expect(signals.every((s) => s.aborted)).toBe(true);
    });
});
