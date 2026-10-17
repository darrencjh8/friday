import { describe, it, expect, vi } from "vitest";
import { Config } from "../src/config.js";
import { ToolRegistry } from "../src/tools.js";

const testEnv = {
    DEEPSEEK_API_KEY: "sk-test",
    ACTUAL_BUDGET_URL: "http://test:5006",
    ACTUAL_BUDGET_PASSWORD: "pw",
    ACTUAL_PRIMARY_BUDGET_FILE: "test-budget",
    DEDUP_DB_PATH: ":memory:",
};

describe("inbox context guard", () => {
    it("keeps listInbox working after read-only mailbox overwrites context", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const realHandler = {
            listInbox: vi.fn().mockResolvedValue([
                { uid: 9, from: "a@test.com", subject: "Hi", date: "2026-06-15T10:00:00.000Z" },
            ]),
            markRead: vi.fn(),
        };
        registry.setEmailContext(null, null, realHandler);
        registry.setEmailContext("req-1", Buffer.from("raw"), { markRead: async () => {} });

        const result = await registry.executeTool("list_inbox_emails", { limit: 20 });

        expect(realHandler.listInbox).toHaveBeenCalledWith({ limit: 20 });
        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(1);
    });
});
