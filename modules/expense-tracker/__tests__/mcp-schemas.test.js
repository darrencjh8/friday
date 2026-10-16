/**
 * Tests for MCP server Zod schemas — budget_id .min(1) enforcement.
 *
 * Shapes are imported from the server rather than mirrored by hand, so a
 * production shape change can no longer drift past this suite. Issue #487.
 */
import { describe, test, expect } from "vitest";
import { z } from "zod";
import { toolShapes } from "../src/mcp-server.js";

// The server registers raw shapes; wrap each the way the MCP SDK does. The SDK
// special-cases a fully empty shape as a Zod v4 mini object, while this builds a
// Zod v3 object for it; the two agree on every accept/reject case below.
const schemas = Object.fromEntries(
    Object.entries(toolShapes).map(([name, shape]) => [name, z.object(shape)]),
);

describe("MCP Zod schemas — budget_id rejects empty string", () => {
    describe("fetch_context", () => {
        test("rejects empty budget_id", () => {
            const r = schemas.fetch_context.safeParse({ budget_id: "" });
            expect(r.success).toBe(false);
        });

        test("accepts non-empty budget_id", () => {
            const r = schemas.fetch_context.safeParse({
                budget_id: "My Budget",
            });
            expect(r.success).toBe(true);
        });

        test("rejects missing budget_id", () => {
            const r = schemas.fetch_context.safeParse({});
            expect(r.success).toBe(false);
        });
    });

    describe("fetch_budget_month", () => {
        test("rejects empty budget_id", () => {
            const r = schemas.fetch_budget_month.safeParse({ budget_id: "" });
            expect(r.success).toBe(false);
        });

        test("rejects missing budget_id", () => {
            const r = schemas.fetch_budget_month.safeParse({});
            expect(r.success).toBe(false);
        });

        test("accepts a YYYY-MM month", () => {
            const r = schemas.fetch_budget_month.safeParse({
                budget_id: "My MYR Budget",
                month: "2026-08",
            });
            expect(r.success).toBe(true);
        });

        test("accepts an omitted month", () => {
            const r = schemas.fetch_budget_month.safeParse({
                budget_id: "My MYR Budget",
            });
            expect(r.success).toBe(true);
        });

        test("rejects a malformed month", () => {
            const r = schemas.fetch_budget_month.safeParse({
                budget_id: "My MYR Budget",
                month: "2026-8",
            });
            expect(r.success).toBe(false);
        });

        test.each(["2026-13", "2026-00"])(
            "rejects the impossible month %s",
            (month) => {
                const r = schemas.fetch_budget_month.safeParse({
                    budget_id: "My MYR Budget",
                    month,
                });
                expect(r.success).toBe(false);
            },
        );
    });

    describe("fetch_recent_transactions", () => {
        test("rejects empty budget_id", () => {
            const r = schemas.fetch_recent_transactions.safeParse({
                budget_id: "",
            });
            expect(r.success).toBe(false);
        });

        test("accepts valid budget_id with optional id", () => {
            const r = schemas.fetch_recent_transactions.safeParse({
                budget_id: "My Budget",
                id: "txn-42",
            });
            expect(r.success).toBe(true);
            expect(r.data.id).toBe("txn-42");
        });

        test("accepts budget_id without id", () => {
            const r = schemas.fetch_recent_transactions.safeParse({
                budget_id: "My Budget",
            });
            expect(r.success).toBe(true);
        });
    });

    describe("insert_transaction", () => {
        test("rejects empty budget_id", () => {
            const r = schemas.insert_transaction.safeParse({
                budget_id: "",
                account_id: "acc-1",
                date: "2026-06-17",
                amount_cents: -425,
            });
            expect(r.success).toBe(false);
        });

        test("rejects empty account_id", () => {
            const r = schemas.insert_transaction.safeParse({
                budget_id: "My Budget",
                account_id: "",
                date: "2026-06-17",
                amount_cents: -425,
            });
            expect(r.success).toBe(false);
        });

        test("rejects empty date", () => {
            const r = schemas.insert_transaction.safeParse({
                budget_id: "My Budget",
                account_id: "acc-1",
                date: "",
                amount_cents: -425,
            });
            expect(r.success).toBe(false);
        });

        test("accepts valid full payload", () => {
            const r = schemas.insert_transaction.safeParse({
                budget_id: "My Budget",
                account_id: "acc-1",
                date: "2026-06-17",
                amount_cents: -1280,
                imported_description: "Toast Box",
                category_id: "cat-food",
                notes: "Lunch",
            });
            expect(r.success).toBe(true);
        });

        test("accepts minimum required fields", () => {
            const r = schemas.insert_transaction.safeParse({
                budget_id: "My Budget",
                account_id: "acc-1",
                date: "2026-06-17",
                amount_cents: -500,
            });
            expect(r.success).toBe(true);
        });
    });

    describe("update_transaction", () => {
        test("rejects empty budget_id", () => {
            const r = schemas.update_transaction.safeParse({
                id: "txn-1",
                budget_id: "",
            });
            expect(r.success).toBe(false);
        });

        test("rejects empty id", () => {
            const r = schemas.update_transaction.safeParse({
                id: "",
                budget_id: "My Budget",
            });
            expect(r.success).toBe(false);
        });

        test("accepts valid minimum payload", () => {
            const r = schemas.update_transaction.safeParse({
                id: "txn-1",
                budget_id: "My Budget",
            });
            expect(r.success).toBe(true);
        });

        test("rejects empty payee_name (#511)", () => {
            // A blank name reached the handler as a supplied-but-empty field and
            // came back as "At least one field must be provided to update".
            const r = schemas.update_transaction.safeParse({
                id: "txn-1",
                budget_id: "My Budget",
                payee_name: "",
            });
            expect(r.success).toBe(false);
        });

        test("accepts a non-empty payee_name (#511)", () => {
            const r = schemas.update_transaction.safeParse({
                id: "txn-1",
                budget_id: "My Budget",
                payee_name: "Deposit",
            });
            expect(r.success).toBe(true);
        });

        test("keeps payee_id, which selects a payee when a name collides (#421)", () => {
            // Zod strips unknown keys, so a field missing from this shape never
            // reaches the handler — the disambiguator has to be listed here too.
            // payee_name is omitted on purpose: the handler rejects both together.
            const r = schemas.update_transaction.safeParse({
                id: "txn-1",
                budget_id: "My Budget",
                payee_id: "payee-plain",
            });
            expect(r.success).toBe(true);
            expect(r.data.payee_id).toBe("payee-plain");
        });

        test("rejects an empty payee_id (#487)", () => {
            const r = schemas.update_transaction.safeParse({
                id: "txn-1",
                budget_id: "My Budget",
                payee_id: "",
            });
            expect(r.success).toBe(false);
        });

        test("accepts a null category_id, which the handler uses to clear (#421)", () => {
            const r = schemas.update_transaction.safeParse({
                id: "txn-1",
                budget_id: "My Budget",
                category_id: null,
            });
            expect(r.success).toBe(true);
            expect(r.data.category_id).toBeNull();
        });
    });

    describe("resolve_merchant", () => {
        test("rejects empty budget_id", () => {
            const r = schemas.resolve_merchant.safeParse({
                merchant: "Toast Box",
                budget_id: "",
            });
            expect(r.success).toBe(false);
        });

        test("rejects empty merchant", () => {
            const r = schemas.resolve_merchant.safeParse({
                merchant: "",
                budget_id: "My Budget",
            });
            expect(r.success).toBe(false);
        });

        test("accepts valid payload", () => {
            const r = schemas.resolve_merchant.safeParse({
                merchant: "Toast Box",
                budget_id: "My Budget",
            });
            expect(r.success).toBe(true);
        });
    });

    describe("reconcile_transaction", () => {
        test("rejects empty ab_transaction_ids array", () => {
            const r = schemas.reconcile_transaction.safeParse({
                ab_transaction_ids: [],
                budget_id: "My Budget",
            });
            expect(r.success).toBe(false);
        });

        test("rejects empty budget_id", () => {
            const r = schemas.reconcile_transaction.safeParse({
                ab_transaction_ids: ["txn-1"],
                budget_id: "",
            });
            expect(r.success).toBe(false);
        });

        test("accepts single ID in array", () => {
            const r = schemas.reconcile_transaction.safeParse({
                ab_transaction_ids: ["txn-1"],
                budget_id: "My Budget",
            });
            expect(r.success).toBe(true);
            expect(r.data.ab_transaction_ids).toEqual(["txn-1"]);
            expect(r.data.statement_ref).toBe("");
        });

        test("accepts multiple IDs with statement_ref", () => {
            const r = schemas.reconcile_transaction.safeParse({
                ab_transaction_ids: ["txn-1", "txn-2", "txn-3"],
                budget_id: "My Budget",
                statement_ref: "Affin Jun 2026",
            });
            expect(r.success).toBe(true);
            expect(r.data.ab_transaction_ids.length).toBe(3);
            expect(r.data.statement_ref).toBe("Affin Jun 2026");
        });
    });

    describe("unclear_transaction", () => {
        test("rejects empty ab_transaction_ids array", () => {
            const r = schemas.unclear_transaction.safeParse({
                ab_transaction_ids: [],
                budget_id: "My Budget",
            });
            expect(r.success).toBe(false);
        });

        test("rejects empty budget_id", () => {
            const r = schemas.unclear_transaction.safeParse({
                ab_transaction_ids: ["txn-1"],
                budget_id: "",
            });
            expect(r.success).toBe(false);
        });

        test("accepts single ID in array", () => {
            const r = schemas.unclear_transaction.safeParse({
                ab_transaction_ids: ["txn-1"],
                budget_id: "My Budget",
            });
            expect(r.success).toBe(true);
            expect(r.data.ab_transaction_ids).toEqual(["txn-1"]);
        });

        test("accepts multiple IDs", () => {
            const r = schemas.unclear_transaction.safeParse({
                ab_transaction_ids: ["txn-1", "txn-2", "txn-3"],
                budget_id: "My Budget",
            });
            expect(r.success).toBe(true);
            expect(r.data.ab_transaction_ids.length).toBe(3);
        });
    });

    describe("fetch_unreconciled_transactions", () => {
        test("rejects empty account_id", () => {
            const r = schemas.fetch_unreconciled_transactions.safeParse({
                account_id: "",
                date_from: "2026-06-01",
                date_to: "2026-06-30",
                budget_id: "My Budget",
            });
            expect(r.success).toBe(false);
        });

        test("rejects empty date_from", () => {
            const r = schemas.fetch_unreconciled_transactions.safeParse({
                account_id: "acc-1",
                date_from: "",
                date_to: "2026-06-30",
                budget_id: "My Budget",
            });
            expect(r.success).toBe(false);
        });

        test("rejects empty budget_id", () => {
            const r = schemas.fetch_unreconciled_transactions.safeParse({
                account_id: "acc-1",
                date_from: "2026-06-01",
                date_to: "2026-06-30",
                budget_id: "",
            });
            expect(r.success).toBe(false);
        });

        test("accepts valid payload", () => {
            const r = schemas.fetch_unreconciled_transactions.safeParse({
                account_id: "acc-1",
                date_from: "2026-06-01",
                date_to: "2026-06-30",
                budget_id: "My Budget",
            });
            expect(r.success).toBe(true);
        });
    });

    describe("list_inbox_emails", () => {
        test("accepts no arguments (uses defaults)", () => {
            const r = schemas.list_inbox_emails.safeParse({});
            expect(r.success).toBe(true);
            expect(r.data.limit).toBe(50);
        });

        test("accepts valid limit", () => {
            const r = schemas.list_inbox_emails.safeParse({ limit: 10 });
            expect(r.success).toBe(true);
            expect(r.data.limit).toBe(10);
        });

        test("rejects non-integer limit", () => {
            const r = schemas.list_inbox_emails.safeParse({ limit: 3.5 });
            expect(r.success).toBe(false);
        });

        test("rejects zero limit", () => {
            const r = schemas.list_inbox_emails.safeParse({ limit: 0 });
            expect(r.success).toBe(false);
        });

        test("rejects negative limit", () => {
            const r = schemas.list_inbox_emails.safeParse({ limit: -1 });
            expect(r.success).toBe(false);
        });

        test("rejects limit over 500", () => {
            const r = schemas.list_inbox_emails.safeParse({ limit: 501 });
            expect(r.success).toBe(false);
        });

        test("accepts limit of 500", () => {
            const r = schemas.list_inbox_emails.safeParse({ limit: 500 });
            expect(r.success).toBe(true);
        });
    });

    describe("read_inbox_email", () => {
        test("rejects missing uid", () => {
            const r = schemas.read_inbox_email.safeParse({});
            expect(r.success).toBe(false);
        });

        test("rejects zero uid", () => {
            const r = schemas.read_inbox_email.safeParse({ uid: 0 });
            expect(r.success).toBe(false);
        });

        test("rejects negative uid", () => {
            const r = schemas.read_inbox_email.safeParse({ uid: -1 });
            expect(r.success).toBe(false);
        });

        test("rejects non-integer uid", () => {
            const r = schemas.read_inbox_email.safeParse({ uid: "abc" });
            expect(r.success).toBe(false);
        });

        test("accepts valid uid", () => {
            const r = schemas.read_inbox_email.safeParse({ uid: 42 });
            expect(r.success).toBe(true);
            expect(r.data.uid).toBe(42);
        });
    });
});
