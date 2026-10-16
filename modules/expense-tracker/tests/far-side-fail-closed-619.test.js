/**
 * Issue #619: the far-side read was fail-open for an existing far row that
 * does not match the exact Misc/uncleared/same-day shape. `matches: 0` made
 * the caller book with a transfer payee, creating a duplicate counterpart.
 */
import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../src/tools.js";
import { AgentOrchestrator } from "../src/orchestrator.js";

const PAYEES = [
    { id: "misc", name: "Misc", transfer_acct: null },
    { id: "merchant", name: "Some Merchant", transfer_acct: null },
    { id: "p-dbs", name: "DBS Account", transfer_acct: "acc-dbs" },
];

function registry(rows) {
    const reg = new ToolRegistry({}, null);
    const queries = [];
    reg._get = async (path, _b, params) => {
        if (path === "/payees") return PAYEES;
        if (path === "/transactions") {
            queries.push(params);
            return rows;
        }
        return [];
    };
    reg.queries = queries;
    return reg;
}
const base = {
    id: "far",
    account: "acc-dbs",
    amount: 100000,
    transfer_id: null,
    cleared: false,
    payee: "misc",
    date: "2026-10-01",
};
const find = (reg) =>
    reg._handle_find_link_candidate({
        budget_id: "b",
        account_id: "acc-dbs",
        amount_cents: -100000,
        on_date: "2026-10-01",
    });

describe("find_link_candidate fail-closed (#619)", () => {
    it("reports an unlinked same-amount row with a merchant payee as unmatched", async () => {
        const r = await find(registry([{ ...base, payee: "merchant" }]));
        expect(r.candidate).toBeNull();
        expect(r.unmatched).toBe(1);
    });
    it("reports an already-cleared far row as unmatched", async () => {
        const r = await find(registry([{ ...base, cleared: true }]));
        expect(r.candidate).toBeNull();
        expect(r.unmatched).toBe(1);
    });
    it("reports a far row one day off (UTC vs SGT) as unmatched", async () => {
        const reg = registry([{ ...base, date: "2026-09-30" }]);
        const r = await find(reg);
        expect(r.candidate).toBeNull();
        expect(r.unmatched).toBe(1);
        expect(reg.queries[0].since_date).toBe("2026-09-30");
        expect(reg.queries[0].until_date).toBe("2026-10-02");
    });
    it("guard: exact row still links", async () => {
        const r = await find(registry([base]));
        expect(r).toEqual({ candidate: { id: "far", account_id: "acc-dbs" }, matches: 1 });
    });
    it("guard: exact row links even with an unrelated adjacent-day row", async () => {
        const r = await find(registry([base, { ...base, id: "x", date: "2026-10-02", cleared: true }]));
        expect(r.candidate).toEqual({ id: "far", account_id: "acc-dbs" });
    });
    it("guard: no row, wrong amount, or already linked rows are a true absence", async () => {
        for (const rows of [
            [],
            [{ ...base, amount: 5000 }],
            [{ ...base, transfer_id: "t" }],
            [{ ...base, amount: -100000 }],
            [{ ...base, account: "other" }],
        ]) {
            expect(await find(registry(rows))).toEqual({ candidate: null, matches: 0 });
        }
    });
});

describe("_findExistingFarSide holds on unmatched far row (#619)", () => {
    const mk = (found) => {
        const tools = { executeTool: vi.fn(async () => found) };
        return new AgentOrchestrator(
            { primaryCurrency: "SGD", secondaryCurrency: "MYR", primaryBudgetFile: "b", secondaryBudgetFile: "c", llmProvider: "deepseek", llmApiKey: "k", deepseekApiKey: "k" },
            tools,
        );
    };
    const args = {
        transfer: { source_account_id: "acc-ocbc", destination_account_id: "acc-dbs" },
        bookedAccountId: "acc-ocbc",
        amountCents: -100000,
        date: "2026-10-01",
        budgetId: "b",
    };
    it("holds when unmatched > 0", async () => {
        const r = await mk({ candidate: null, matches: 0, unmatched: 1 })._findExistingFarSide(args);
        expect(r).toEqual({ hold: true, reason: "unmatched" });
    });
    it("guard: matches 0 and no unmatched still books normally", async () => {
        const r = await mk({ candidate: null, matches: 0 })._findExistingFarSide(args);
        expect(r).toEqual({ farRowId: null });
    });
});
