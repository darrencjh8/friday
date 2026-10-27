/**
 * The bank alert for a transfer to the broker says only "Withdrawal", so the
 * expense tracker books it as Misc. The broker's own flex CashTransactions row
 * carries the exact amount; the sync hands each deposit to the expense
 * tracker's `match_broker_deposit`, which rebooks the one Misc debit it
 * matches. Synthetic XML only.
 */
import { describe, it, expect, vi } from "vitest";
import { brokerDeposits, matchBrokerDeposits } from "../src/broker_deposits.js";

const flex = (rows) => `<FlexQueryResponse><FlexStatements count="1"><FlexStatement accountId="U0000000">
<CashTransactions>${rows.join("\n")}</CashTransactions>
</FlexStatement></FlexStatements></FlexQueryResponse>`;
const row = (attrs) =>
    `<CashTransaction ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")} />`;

describe("brokerDeposits", () => {
    it("reads an incoming deposit's exact amount, currency and date", async () => {
        const out = await brokerDeposits(flex([
            row({ type: "Deposits/Withdrawals", currency: "SGD", amount: "3930", dateTime: "20261026;101500", levelOfDetail: "DETAIL" }),
        ]));
        expect(out).toEqual([{ currency: "SGD", amount_cents: 393000, date: "2026-10-26" }]);
    });

    it("never treats a withdrawal from the broker as a deposit", async () => {
        // The shared trade parser takes the absolute value of every
        // Deposits/Withdrawals row; this reader keeps the raw sign.
        const out = await brokerDeposits(flex([
            row({ type: "Deposits/Withdrawals", currency: "SGD", amount: "-500", dateTime: "20261026", levelOfDetail: "DETAIL" }),
        ]));
        expect(out).toEqual([]);
    });

    it("ignores dividends, fees, summary rows and malformed amounts", async () => {
        const out = await brokerDeposits(flex([
            row({ type: "Dividends", currency: "USD", amount: "12.5", dateTime: "20261026" }),
            row({ type: "Other Fees", currency: "USD", amount: "-1", dateTime: "20261026" }),
            row({ type: "Deposits/Withdrawals", currency: "SGD", amount: "3930", dateTime: "20261026", levelOfDetail: "SUMMARY" }),
            row({ type: "Deposits/Withdrawals", currency: "SGD", amount: "abc", dateTime: "20261026" }),
        ]));
        expect(out).toEqual([]);
    });

    it("accepts an ISO reportDate and rounds to whole cents", async () => {
        const out = await brokerDeposits(flex([
            row({ type: "Deposits/Withdrawals", currency: "SGD", amount: "1,100.10", reportDate: "2026-10-01" }),
        ]));
        expect(out).toEqual([{ currency: "SGD", amount_cents: 110010, date: "2026-10-01" }]);
    });

    it("returns nothing for empty or unparseable XML", async () => {
        expect(await brokerDeposits("")).toEqual([]);
        expect(await brokerDeposits("<FlexQueryResponse/>")).toEqual([]);
    });
});

describe("matchBrokerDeposits", () => {
    const env = {
        ACTUAL_PRIMARY_BUDGET_FILE: "budget-sgd",
        ACTUAL_SECONDARY_BUDGET_FILE: "budget-myr",
    };
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });

    it("sends each deposit to the expense tracker under its currency's budget", async () => {
        const fetch = vi.fn().mockResolvedValue(ok({ matched: 1, id: "row-1" }));
        const out = await matchBrokerDeposits(
            [{ currency: "SGD", amount_cents: 393000, date: "2026-10-26" }],
            { fetch, env },
        );

        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, init] = fetch.mock.calls[0];
        expect(url).toBe("http://expense-tracker:8080/tools/match-broker-deposit");
        expect(JSON.parse(init.body)).toEqual({
            budget_id: "budget-sgd",
            amount_cents: 393000,
            on_date: "2026-10-26",
            payee_name: "IBKR",
            category_name: "General Investment",
        });
        expect(out).toEqual([{ currency: "SGD", amount_cents: 393000, date: "2026-10-26", matched: 1 }]);
    });

    it("honours the configured URL, payee and category", async () => {
        const fetch = vi.fn().mockResolvedValue(ok({ matched: 0, candidates: 0 }));
        await matchBrokerDeposits(
            [{ currency: "MYR", amount_cents: 1000, date: "2026-10-26" }],
            {
                fetch,
                env: {
                    ...env,
                    EXPENSE_TRACKER_URL: "http://et:9000/",
                    IBKR_DEPOSIT_PAYEE: "Broker",
                    IBKR_DEPOSIT_CATEGORY: "Investing",
                },
            },
        );
        const [url, init] = fetch.mock.calls[0];
        expect(url).toBe("http://et:9000/tools/match-broker-deposit");
        expect(JSON.parse(init.body)).toMatchObject({ budget_id: "budget-myr", payee_name: "Broker", category_name: "Investing" });
    });

    it("skips a currency with no budget, and never throws on a failed call", async () => {
        const fetch = vi.fn()
            .mockRejectedValueOnce(new Error("ECONNREFUSED"))
            .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: "x" }) });
        const out = await matchBrokerDeposits(
            [
                { currency: "USD", amount_cents: 100, date: "2026-10-26" },
                { currency: "SGD", amount_cents: 200, date: "2026-10-26" },
                { currency: "SGD", amount_cents: 300, date: "2026-10-26" },
            ],
            { fetch, env },
        );
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(out.map((d) => d.matched)).toEqual([0, 0, 0]);
        expect(out[0].skipped).toBe("no_budget");
        expect(out[1].error).toMatch(/ECONNREFUSED/);
        expect(out[2].error).toMatch(/500/);
    });
});
