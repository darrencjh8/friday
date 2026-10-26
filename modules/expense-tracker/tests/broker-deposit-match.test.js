/**
 * A bank alert that only says "Withdrawal" books as Misc: it names no
 * destination. The broker's own record of the deposit (the IBKR flex
 * CashTransactions row the portfolio sync already pulls) carries the exact
 * amount, so `match_broker_deposit` turns the one Misc debit it matches into
 * the broker transfer. Anything less than exactly one candidate changes
 * nothing.
 */
import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../src/tools.js";

const PAYEES = [
    { id: "misc", name: "Misc", transfer_acct: null },
    { id: "merchant", name: "Some Merchant", transfer_acct: null },
    { id: "p-broker", name: "Broker", transfer_acct: "acc-broker" },
];
const CATEGORIES = [
    { id: "cat-invest", name: "General Investment" },
    { id: "cat-fun", name: "Fun Money" },
];

function registry(rows, { payees = PAYEES } = {}) {
    const reg = new ToolRegistry({}, null);
    const calls = { queries: [], patches: [], notes: [] };
    reg._get = async (path, _b, params) => {
        if (path === "/payees") return payees;
        if (path === "/categories") return CATEGORIES;
        if (path === "/transactions") {
            calls.queries.push(params);
            return rows;
        }
        if (path.startsWith("/transactions/")) return rows.find((r) => `/transactions/${r.id}` === path) || null;
        return [];
    };
    reg._patch = async (path, body) => {
        calls.patches.push({ path, body });
        return { id: path.split("/").pop(), ...body };
    };
    reg._validateTransferTarget = async () => null;
    reg._notificationSink = async (message) => {
        calls.notes.push(message);
        return true;
    };
    reg.calls = calls;
    return reg;
}

const debit = {
    id: "row-1",
    account: "acc-bank",
    amount: -393000,
    payee: "misc",
    transfer_id: null,
    cleared: false,
    date: "2026-10-26",
};

const match = (reg, extra = {}) =>
    reg._handle_match_broker_deposit({
        budget_id: "b",
        amount_cents: 393000,
        on_date: "2026-10-26",
        payee_name: "Broker",
        category_name: "General Investment",
        ...extra,
    });

describe("match_broker_deposit", () => {
    it("rebooks the one Misc debit of the deposit amount as the broker transfer", async () => {
        const reg = registry([debit]);
        const r = await match(reg);

        expect(r).toMatchObject({ matched: 1, id: "row-1", account_id: "acc-bank" });
        expect(reg.calls.patches).toEqual([
            { path: "/transactions/row-1", body: { payee: "p-broker", category: "cat-invest" } },
        ]);
        expect(reg.calls.notes).toHaveLength(1);
        expect(reg.calls.notes[0]).toMatch(/Broker/);
        expect(reg.calls.notes[0]).toMatch(/3930\.00/);
    });

    it("looks back a few days, because the bank alert can precede the deposit", async () => {
        const reg = registry([{ ...debit, date: "2026-10-24" }]);
        const r = await match(reg);

        expect(r.matched).toBe(1);
        expect(reg.calls.queries[0]).toMatchObject({ since_date: "2026-10-23", until_date: "2026-10-27" });
    });

    it("changes nothing when two Misc debits could be the deposit", async () => {
        const reg = registry([debit, { ...debit, id: "row-2", account: "acc-other" }]);
        const r = await match(reg);

        expect(r).toMatchObject({ matched: 0, candidates: 2 });
        expect(reg.calls.patches).toHaveLength(0);
        expect(reg.calls.notes).toHaveLength(0);
    });

    it("never touches a row that is not an unlinked, uncleared Misc debit of that exact amount", async () => {
        for (const row of [
            { ...debit, payee: "merchant" },
            { ...debit, cleared: true },
            { ...debit, transfer_id: "t" },
            { ...debit, amount: -393001 },
            { ...debit, amount: 393000 },
            { ...debit, date: "2026-10-20" },
            { ...debit, account: "acc-broker" },
        ]) {
            const reg = registry([row]);
            const r = await match(reg);
            expect(r.matched).toBe(0);
            expect(reg.calls.patches).toHaveLength(0);
        }
    });

    it("is a no-op once the row is rebooked, so a repeated flex window does not rebook or re-notify", async () => {
        const reg = registry([{ ...debit, payee: "p-broker", transfer_id: "t" }]);
        const r = await match(reg);

        expect(r.matched).toBe(0);
        expect(reg.calls.notes).toHaveLength(0);
    });

    it("refuses without a broker transfer payee, a positive amount or a date", async () => {
        const noBroker = registry([debit], { payees: PAYEES.filter((p) => p.id !== "p-broker") });
        expect((await match(noBroker)).matched).toBe(0);
        expect(noBroker.calls.patches).toHaveLength(0);

        for (const bad of [{ amount_cents: 0 }, { amount_cents: -393000 }, { on_date: "" }, { budget_id: "" }]) {
            const reg = registry([debit]);
            expect((await match(reg, bad)).matched).toBe(0);
            expect(reg.calls.patches).toHaveLength(0);
        }
    });

    it("leaves the category unset when the named category does not exist", async () => {
        const reg = registry([debit]);
        const r = await match(reg, { category_name: "No Such Category" });

        expect(r.matched).toBe(1);
        expect(reg.calls.patches[0].body).toEqual({ payee: "p-broker" });
    });

    it("is not part of a dry run's read-only tool set", async () => {
        const reg = registry([debit]);
        const calls = [];
        await reg._dryRunScope.run(calls, () => reg.executeTool("match_broker_deposit", {
            budget_id: "b", amount_cents: 393000, on_date: "2026-10-26", payee_name: "Broker",
        }));
        expect(reg.calls.patches).toHaveLength(0);
    });
});
