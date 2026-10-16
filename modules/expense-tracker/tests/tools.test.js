/**
 * Tests for ToolRegistry — ported from tests/test_tools.py
 */
import { describe, it, expect } from "vitest";
import { Config } from "../src/config.js";
import { ToolRegistry, NotificationCooldown } from "../src/tools.js";
import { DedupJournal } from "../src/dedup.js";

const testEnv = {
    DEEPSEEK_API_KEY: "sk-test",
    ACTUAL_BUDGET_URL: "http://test:5006",
    ACTUAL_BUDGET_PASSWORD: "pw",
    ACTUAL_PRIMARY_BUDGET_FILE: "test-budget",
    DEDUP_DB_PATH: ":memory:",
};

describe("ToolRegistry", () => {
    it("returns all tool schemas", () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const schemas = registry.getToolSchemas();
        expect(schemas.length).toBeGreaterThan(10);
        const names = schemas.map((s) => s.function.name);
        expect(names).toContain("search_memory");
        expect(names).toContain("learn_fact");
        expect(names).toContain("fetch_accounts");
        expect(names).toContain("insert_transaction");
        expect(names).toContain("reconcile_transaction");
        expect(names).toContain("fetch_unreconciled_transactions");
    });

    it("extract_pdf_text schema includes optional password field", () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const schemas = registry.getToolSchemas();
        const pdfTool = schemas.find(
            (s) => s.function.name === "extract_pdf_text",
        );
        expect(pdfTool).toBeDefined();
        expect(pdfTool.function.parameters.properties).toHaveProperty(
            "password",
        );
        expect(pdfTool.function.parameters.required).toEqual(["pdf_bytes_b64"]);
    });

    it("extract_email_content schema includes optional password field", () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const schemas = registry.getToolSchemas();
        const emailTool = schemas.find(
            (s) => s.function.name === "extract_email_content",
        );
        expect(emailTool).toBeDefined();
        expect(emailTool.function.parameters.properties).toHaveProperty(
            "password",
        );
        expect(emailTool.function.parameters.properties.password).toMatchObject(
            { type: "string" },
        );
        if (emailTool.function.parameters.required) {
            expect(emailTool.function.parameters.required).not.toContain(
                "password",
            );
        }
    });

    it("_handle_extract_email_content accepts password parameter and passes to extractEmailContent", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        // Set up a mock email context so the handler doesn't short-circuit
        registry.setEmailContext(
            "test-msg-id",
            Buffer.from("From: test@test.com\r\nSubject: test\r\n\r\nbody"),
            null,
        );
        // With password, should not throw and should return a string
        const result = await registry.executeTool("extract_email_content", {
            include_headers: false,
            password: "test123",
        });
        expect(typeof result).toBe("string");
    });

    it("check_statement_duplicate falls back to AB API when dedup misses", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        // Mock fetch for AB API fallback
        const origFetch = global.fetch;
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [
                { id: "txn-1", date: "2026-06-01", amount: -1280 },
            ],
        });

        try {
            const result = await registry.executeTool(
                "check_statement_duplicate",
                {
                    date: "2026-06-01",
                    amount_cents: -1280,
                    account_id: "acc-test",
                },
            );
            // Should return true because AB API found a matching transaction
            expect(result).toBe(true);
            // fetch should have been called (AB fallback was triggered)
            expect(global.fetch).toHaveBeenCalled();
        } finally {
            global.fetch = origFetch;
        }
    });

    it("check_statement_duplicate returns false when neither dedup nor AB matches", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const origFetch = global.fetch;
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [],
        });

        try {
            const result = await registry.executeTool(
                "check_statement_duplicate",
                {
                    date: "2026-07-15",
                    amount_cents: -9999,
                    account_id: "acc-test",
                },
            );
            expect(result).toBe(false);
        } finally {
            global.fetch = origFetch;
        }
    });

    it("executes known tool", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const result = await registry.executeTool("log_decision", {
            action: "test",
            reasoning: "unit test",
        });
        expect(result).toBe(true);
    });

    it("list_inbox_emails delegates to imapHandler.listInbox", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const mockImapHandler = {
            listInbox: vi
                .fn()
                .mockResolvedValue([
                    {
                        uid: 1,
                        from: "a@test.com",
                        subject: "Hello",
                        date: "2026-06-15T10:00:00.000Z",
                    },
                ]),
        };
        registry.setEmailContext(null, null, mockImapHandler);

        const result = await registry.executeTool("list_inbox_emails", {
            limit: 20,
        });
        expect(mockImapHandler.listInbox).toHaveBeenCalledWith({ limit: 20 });
        expect(result).toHaveLength(1);
        expect(result[0].subject).toBe("Hello");
    });

    it("list_inbox_emails returns error when no imapHandler", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const result = await registry.executeTool("list_inbox_emails", {
            limit: 10,
        });
        expect(result).toHaveProperty("error");
        expect(result.error).toContain("not connected");
    });

    it("list_inbox_emails uses default limit when not provided", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const mockImapHandler = {
            listInbox: vi.fn().mockResolvedValue([]),
        };
        registry.setEmailContext(null, null, mockImapHandler);

        await registry.executeTool("list_inbox_emails", {});
        expect(mockImapHandler.listInbox).toHaveBeenCalledWith({ limit: 50 });
    });

    it("read_inbox_email delegates to imapHandler.readInboxEmail", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const mockEmail = {
            uid: 42,
            from: "sender@test.com",
            subject: "Important",
            text: "Body text",
            html: "<p>Body</p>",
            date: "2026-06-16T12:00:00.000Z",
        };

        const mockImapHandler = {
            readInboxEmail: vi.fn().mockResolvedValue(mockEmail),
        };
        registry.setEmailContext(null, null, mockImapHandler);

        const result = await registry.executeTool("read_inbox_email", {
            uid: 42,
        });
        expect(mockImapHandler.readInboxEmail).toHaveBeenCalledWith(42);
        expect(result.subject).toBe("Important");
        expect(result.text).toBe("Body text");
    });

    it("read_inbox_email returns error when no imapHandler", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const result = await registry.executeTool("read_inbox_email", {
            uid: 1,
        });
        expect(result).toHaveProperty("error");
        expect(result.error).toContain("not connected");
    });

    it("read_inbox_email returns not-found when email missing", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const mockImapHandler = {
            readInboxEmail: vi.fn().mockResolvedValue(null),
        };
        registry.setEmailContext(null, null, mockImapHandler);

        const result = await registry.executeTool("read_inbox_email", {
            uid: 999,
        });
        expect(result).toHaveProperty("error");
        expect(result.error).toContain("not found");
    });

    it("mark_email_read schema includes optional uid field", () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const schemas = registry.getToolSchemas();
        const markTool = schemas.find(
            (s) => s.function.name === "mark_email_read",
        );
        expect(markTool).toBeDefined();
        expect(markTool.function.parameters.properties).toHaveProperty("uid");
        expect(markTool.function.parameters.properties.uid).toMatchObject({
            type: "number",
        });
        if (markTool.function.parameters.required) {
            expect(markTool.function.parameters.required).not.toContain("uid");
        }
    });

    it("mark_email_read with uid marks that specific UID directly", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const mockImapHandler = {
            markRead: vi.fn().mockResolvedValue(undefined),
        };
        registry.setEmailContext(null, null, mockImapHandler);

        const result = await registry.executeTool("mark_email_read", {
            uid: 42,
        });
        expect(mockImapHandler.markRead).toHaveBeenCalledWith(42);
        expect(result).toBe(true);
    });

    it("mark_email_read with no uid falls back to email context", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const mockImapHandler = {
            markRead: vi.fn().mockResolvedValue(undefined),
        };
        registry.setEmailContext("msg-1", Buffer.from("raw"), mockImapHandler);

        const result = await registry.executeTool("mark_email_read", {});
        expect(mockImapHandler.markRead).toHaveBeenCalledWith("msg-1");
        expect(result).toBe(true);
    });

    it("mark_email_read with no uid and no context returns error (not silent true)", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const mockImapHandler = {
            markRead: vi.fn().mockResolvedValue(undefined),
        };
        registry.setEmailContext(null, null, mockImapHandler);

        const result = await registry.executeTool("mark_email_read", {});
        expect(result).toHaveProperty("error");
        expect(mockImapHandler.markRead).not.toHaveBeenCalled();
    });

    it("mark_email_read returns error when imapHandler missing", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const result = await registry.executeTool("mark_email_read", { uid: 42 });
        expect(result).toHaveProperty("error");
        expect(result.error).toContain("not connected");
    });

    it("mark_email_read rejects invalid uid (zero, negative, non-integer)", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const mockImapHandler = {
            markRead: vi.fn().mockResolvedValue(undefined),
        };
        registry.setEmailContext(null, null, mockImapHandler);

        for (const badUid of [0, -1, 1.5, "42", NaN]) {
            const result = await registry.executeTool("mark_email_read", {
                uid: badUid,
            });
            expect(result).toHaveProperty("error");
            expect(result.error).toContain("positive integer");
        }
        expect(mockImapHandler.markRead).not.toHaveBeenCalled();
    });

    it("mark_email_read returns error when markRead throws", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const mockImapHandler = {
            markRead: vi.fn().mockRejectedValue(new Error("IMAP down")),
        };
        registry.setEmailContext("msg-1", Buffer.from("raw"), mockImapHandler);

        const result = await registry.executeTool("mark_email_read", {});
        expect(result).toHaveProperty("error");
        expect(result.error).toContain("Failed to mark email read");
    });

    it("throws on unknown tool", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        await expect(registry.executeTool("nonexistent", {})).rejects.toThrow(
            "Unknown tool",
        );
    });

    it("search_memory returns empty with no memory", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const result = await registry.executeTool("search_memory", {
            query: "test",
        });
        expect(result).toEqual({ results: [] });
    });

    it("learn_fact returns no-store with no memory", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const result = await registry.executeTool("learn_fact", {
            fact: "test",
        });
        expect(result.added).toBe(false);
    });

    it("passes live budget accounts into memory writes (#561)", async () => {
        const cfg = new Config(testEnv);
        const calls = [];
        const registry = new ToolRegistry(cfg, {
            add: async (...args) => { calls.push(["add", args]); return { added: false }; },
            update: (...args) => { calls.push(["update", args]); return { updated: false }; },
        });
        const accounts = [{ id: "ocbc", name: "OCBC 360", closed: false }];
        registry._handle_fetch_accounts = async () => accounts;

        await registry.executeTool("learn_fact", { fact: "OCBC 360 maps to Food category" });
        await registry.executeTool("update_fact", {
            old_text: "Old maps to Food payee",
            new_text: "OCBC 360 maps to Spotify payee",
        });

        expect(calls).toEqual([
            ["add", ["OCBC 360 maps to Food category", accounts]],
            ["update", ["Old maps to Food payee", "OCBC 360 maps to Spotify payee", accounts]],
        ]);
    });

    it("refuses a fact write when the account list cannot be read (#561)", async () => {
        const cfg = new Config(testEnv);
        const calls = [];
        const registry = new ToolRegistry(cfg, {
            add: async (...args) => { calls.push(["add", args]); return { added: true }; },
            update: (...args) => { calls.push(["update", args]); return { updated: true }; },
        });
        registry._handle_fetch_accounts = async () => ({ error: "upstream down" });

        await expect(
            registry.executeTool("learn_fact", { fact: "OCBC 360 maps to Food category" }),
        ).resolves.toMatchObject({ added: false, skipped: true });
        await expect(
            registry.executeTool("update_fact", {
                old_text: "Old maps to Food payee",
                new_text: "OCBC 360 maps to Spotify payee",
            }),
        ).resolves.toMatchObject({ updated: false, found: false });
        expect(calls).toEqual([]);
    });

    it("_post does not mutate the caller's body object", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const body = { name: "test", value: 42 };
        const original = { ...body };

        // Mock fetch to avoid real network call
        const origFetch = global.fetch;
        global.fetch = async () => ({ ok: true, json: async () => ({}) });
        try {
            await registry._post("/test", body, "my-budget");
        } finally {
            global.fetch = origFetch;
        }
        // The original body must remain unchanged
        expect(body).toEqual(original);
        expect(body.budget_id).toBeUndefined();
    });

    // Every HTTP helper shares the same error builder, so each one is covered.
    for (const [helper, call] of [
        ["_get", (registry) => registry._get("/accounts", "test-budget")],
        ["_post", (registry) => registry._post("/accounts", {}, "test-budget")],
        [
            "_patch",
            (registry) => registry._patch("/accounts", {}, "test-budget"),
        ],
    ]) {
        it(`${helper} includes the actual-api error body in the thrown message`, async () => {
            const cfg = new Config(testEnv);
            const registry = new ToolRegistry(cfg);

            const origFetch = global.fetch;
            global.fetch = async () => ({
                ok: false,
                status: 500,
                text: async () => '{"error":"No budget file is open"}',
            });
            try {
                await expect(call(registry)).rejects.toThrow(
                    'actual-api 500 {"error":"No budget file is open"}',
                );
            } finally {
                global.fetch = origFetch;
            }
        });

        it(`${helper} keeps the bare status when the error body cannot be read`, async () => {
            const cfg = new Config(testEnv);
            const registry = new ToolRegistry(cfg);

            const origFetch = global.fetch;
            global.fetch = async () => ({
                ok: false,
                status: 502,
                text: async () => {
                    throw new Error("stream closed");
                },
            });
            try {
                await expect(call(registry)).rejects.toThrow(
                    /^actual-api 502$/,
                );
            } finally {
                global.fetch = origFetch;
            }
        });
    }

    it("fetch_context returns accounts, categories, and payees in parallel with balances", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const accounts = [
            { id: "a1", name: "Epsilon Nova", closed: false },
            { id: "a2", name: "OCBC Closed", closed: true },
        ];
        const categories = [{ id: "c1", name: "Food" }];
        const payees = [{ id: "p1", name: "Coffee" }];
        const balanceA1 = 50000;

        const origFetch = global.fetch;
        let callCount = 0;
        global.fetch = vi.fn(async (url) => {
            callCount++;
            if (url.includes("/accounts/balance"))
                return {
                    ok: true,
                    json: async () => ({ id: "a1", balance: balanceA1 }),
                };
            if (url.includes("/accounts"))
                return { ok: true, json: async () => accounts };
            if (url.includes("/categories"))
                return { ok: true, json: async () => categories };
            if (url.includes("/payees"))
                return { ok: true, json: async () => payees };
            return { ok: false, json: async () => ({}) };
        });

        try {
            const result = await registry.executeTool("fetch_context", {
                budget_id: "test-budget",
            });
            expect(result.accounts).toEqual([
                { id: "a1", name: "Epsilon Nova", closed: false, balance: 50000 },
            ]);
            expect(result.categories).toEqual(categories);
            expect(result.payees).toEqual(payees);
            // 3 context calls + 1 balance call for the active account
            expect(callCount).toBe(4);
        } finally {
            global.fetch = origFetch;
        }
    });

    it("fetch_context sets balance to null when balance fetch fails, but preserves categories + payees", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const accounts = [
            { id: "a1", name: "Epsilon Nova", closed: false },
        ];
        const categories = [{ id: "c1", name: "Food" }];
        const payees = [{ id: "p1", name: "Coffee" }];

        const origFetch = global.fetch;
        global.fetch = vi.fn(async (url) => {
            if (url.includes("/accounts/balance"))
                return { ok: false, json: async () => ({ error: "fail" }) };
            if (url.includes("/accounts"))
                return { ok: true, json: async () => accounts };
            if (url.includes("/categories"))
                return { ok: true, json: async () => categories };
            if (url.includes("/payees"))
                return { ok: true, json: async () => payees };
            return { ok: false, json: async () => ({}) };
        });

        try {
            const result = await registry.executeTool("fetch_context", {
                budget_id: "test-budget",
            });
            expect(result.accounts[0].balance).toBeNull();
            expect(result.categories).toEqual(categories);
            expect(result.payees).toEqual(payees);
        } finally {
            global.fetch = origFetch;
        }
    });

    it("fetch_accounts includes balances for active accounts", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const accounts = [
            { id: "a1", name: "Epsilon Nova", closed: false },
            { id: "a2", name: "OCBC Closed", closed: true },
        ];

        const origFetch = global.fetch;
        global.fetch = vi.fn(async (url) => {
            if (url.includes("/accounts/balance"))
                return {
                    ok: true,
                    json: async () => ({ id: "a1", balance: 0 }),
                };
            if (url.includes("/accounts"))
                return { ok: true, json: async () => accounts };
            return { ok: false, json: async () => ({}) };
        });

        try {
            const result = await registry.executeTool("fetch_accounts", {
                budget_id: "test-budget",
            });
            // Only active accounts, closed filtered out
            expect(result).toHaveLength(1);
            expect(result[0].id).toBe("a1");
            expect(result[0].balance).toBe(0); // zero balance preserved (not coerced to null)
        } finally {
            global.fetch = origFetch;
        }
    });
});

describe("NotificationCooldown", () => {
    it("should not suppress first notification", () => {
        const c = new NotificationCooldown();
        expect(c.shouldSuppress("msg-1")).toBe(false);
    });

    it("should suppress repeat within cooldown", () => {
        const c = new NotificationCooldown();
        c.record("msg-1");
        expect(c.shouldSuppress("msg-1")).toBe(true);
    });

    it("should clear all entries", () => {
        const c = new NotificationCooldown();
        c.record("msg-1");
        c.record("msg-2");
        c.clear();
        expect(c.shouldSuppress("msg-1")).toBe(false);
    });

    it("should not suppress different messages", () => {
        const c = new NotificationCooldown();
        c.record("msg-1");
        expect(c.shouldSuppress("msg-2")).toBe(false);
    });
});

describe("reserve_transfer far-side reconciliation (#557)", () => {
    // Live case: the OCBC "Deposit in your account" alert booked OCBC 360 +1.00
    // as an unidentified deposit before the UOB transfer alert arrived, and the
    // counterpart Actual creates on transfer insert then doubled it.
    const args = {
        budget_id: "Darren SGD",
        source_account_id: "uob-one",
        destination_account_id: "ocbc-360",
        currency: "SGD",
        amount_cents: 100,
        occurred_at: "2026-09-13T08:53:57.000Z",
        payee_id: "p-uob-transfer",
    };

    it("reports a possible far-side duplicate without deleting anything", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        registry._dedup = new DedupJournal(":memory:");
        const deleted = [];
        global.fetch = async (url, options = {}) => {
            if (options.method === "DELETE") {
                deleted.push(String(url));
                return { ok: true, json: async () => ({ status: "deleted" }) };
            }
            if (String(url).includes("/payees")) {
                return {
                    ok: true,
                    json: async () => [{ id: "p-misc", name: "Misc" }],
                };
            }
            return {
                ok: true,
                json: async () => [
                    {
                        id: "stale-1",
                        amount: 100,
                        payee: "p-misc",
                        cleared: false,
                        transfer_id: null,
                    },
                ],
            };
        };

        const reservation = await registry.executeTool(
            "reserve_transfer",
            args,
        );

        expect(reservation.status).toBe("reserved");
        expect(reservation.far_side_candidate).toBe("stale-1");
        // No field the route returns proves the row is ours, so the row is
        // reported to the user, never removed.
        expect(deleted).toEqual([]);
    });

    it("leaves a cleared or linked row alone", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        registry._dedup = new DedupJournal(":memory:");
        const deleted = [];
        global.fetch = async (url, options = {}) => {
            if (options.method === "DELETE") {
                deleted.push(String(url));
                return { ok: true, json: async () => ({ status: "deleted" }) };
            }
            if (String(url).includes("/payees")) {
                return {
                    ok: true,
                    json: async () => [{ id: "p-misc", name: "Misc" }],
                };
            }
            return {
                ok: true,
                json: async () => [
                    {
                        id: "real-1",
                        amount: 100,
                        payee: "p-misc",
                        cleared: true,
                        transfer_id: null,
                    },
                ],
            };
        };

        const reservation = await registry.executeTool(
            "reserve_transfer",
            args,
        );

        expect(reservation.status).toBe("reserved");
        expect(reservation.far_side_candidate).toBeUndefined();
        expect(deleted).toEqual([]);
    });
});

describe("find_inserted_transfer claims only for the current email (#578)", () => {
    const leg = (registry) => {
        const reserved = registry._dedup.reserveTransfer({
            budget_id: "b",
            source_account_id: "src",
            destination_account_id: "dst",
            currency: "SGD",
            amount_cents: 100,
            occurred_at: "2026-09-15T10:00:00.000Z",
        });
        registry._dedup.markTransferInserted(reserved.entry.id, "tx-1");
        return reserved.entry.id;
    };
    const lookup = (registry, extra = {}) =>
        registry.executeTool("find_inserted_transfer", {
            budget_id: "b",
            destination_account_id: "dst",
            amount_cents: 100,
            currency: "SGD",
            at: "2026-09-15T10:00:30.000Z",
            ...extra,
        });

    it("claims the leg for the email being processed", async () => {
        const registry = new ToolRegistry(new Config(testEnv));
        const id = leg(registry);
        registry.setEmailContext("101", null, null);
        expect(await lookup(registry, { alert_id: "101" })).not.toBeNull();
        expect(registry._dedup.getTransfer(id).counterpart_alert_id).toBe("101");
        registry.setEmailContext("102", null, null);
        expect(await lookup(registry, { alert_id: "102" })).toBeNull();
    });

    it("does not claim for an id that is not the current email", async () => {
        const registry = new ToolRegistry(new Config(testEnv));
        const id = leg(registry);
        registry.setEmailContext("101", null, null);
        expect(await lookup(registry, { alert_id: "evil" })).not.toBeNull();
        expect(registry._dedup.getTransfer(id).counterpart_alert_id).toBeNull();
    });

    it("does not claim for pasted text while an email uid is still in context", async () => {
        // processText (Telegram/MCP) never sets an email context, so the uid
        // of the last email is still there; the text passes no alert_id.
        const registry = new ToolRegistry(new Config(testEnv));
        const id = leg(registry);
        registry.setEmailContext("101", null, null);
        expect(await lookup(registry)).not.toBeNull();
        expect(registry._dedup.getTransfer(id).counterpart_alert_id).toBeNull();
    });
});
