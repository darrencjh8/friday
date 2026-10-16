/**
 * Tests for reconciliation note composition (fetch-compose-clear).
 *
 * Contract (from expense-tracker-merchant-notes-plan.md):
 * - Fetch current notes by immutable ID.
 * - Compose canonical statement reference with current notes (preserving
 *   any Merchant line and user notes).
 * - Clear with the complete composed notes.
 * - GET/compose failure does not clear.
 */
import { describe, it, expect, vi } from "vitest";
import { Config } from "../src/config.js";
import { ToolRegistry } from "../src/tools.js";

const testEnv = {
    ACTUAL_BUDGET_URL: "http://test:5006",
    ACTUAL_BUDGET_PASSWORD: "pw",
    ACTUAL_PRIMARY_BUDGET_FILE: "test-budget",
    DEDUP_DB_PATH: ":memory:",
};

function makeRegistry() {
    const cfg = new Config(testEnv);
    return new ToolRegistry(cfg);
}

describe("reconcile_transaction — fetch-compose-clear", () => {
    it("preserves Merchant line and user notes while adding Statement line", async () => {
        const registry = makeRegistry();
        const posts = [];
        registry._get = vi.fn(async () => ({
            id: "id1",
            notes: "Merchant: WWW.TADA.G* N01A04E712\n\nmy note",
        }));
        registry._post = vi.fn(async (path, body) => {
            posts.push({ path, body });
            return { status: "cleared" };
        });

        const result = await registry._handle_reconcile_transaction({
            ab_transaction_ids: ["id1"],
            statement_ref: "Epsilon Nova | 2026-06-01..2026-06-30",
            budget_id: "b",
        });

        expect(result.cleared).toBe(1);
        expect(posts).toHaveLength(1);
        expect(posts[0].body.notes).toBe(
            "Merchant: WWW.TADA.G* N01A04E712\nStatement: Epsilon Nova | 2026-06-01..2026-06-30\n\nmy note",
        );
    });

    it("does not clear when GET fails", async () => {
        const registry = makeRegistry();
        registry._get = vi.fn(async () => {
            throw new Error("actual-api 500");
        });
        const post = vi.fn(async () => ({ status: "cleared" }));
        registry._post = post;

        const result = await registry._handle_reconcile_transaction({
            ab_transaction_ids: ["id1"],
            statement_ref: "S",
            budget_id: "b",
        });

        expect(result.failed).toBe(1);
        expect(post).not.toHaveBeenCalled();
    });

    it("clears without a notes body when there is nothing to compose", async () => {
        const registry = makeRegistry();
        const posts = [];
        registry._get = vi.fn(async () => ({ id: "id1", notes: "" }));
        registry._post = vi.fn(async (path, body) => {
            posts.push({ path, body });
            return { status: "cleared" };
        });

        await registry._handle_reconcile_transaction({
            ab_transaction_ids: ["id1"],
            statement_ref: "",
            budget_id: "b",
        });

        expect(posts).toHaveLength(1);
        expect(posts[0].body.notes).toBeUndefined();
    });
});
