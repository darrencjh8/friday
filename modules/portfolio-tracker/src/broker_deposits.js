/**
 * Broker deposits from the IBKR flex statement, handed to the expense tracker.
 *
 * The bank alert for a transfer to the broker says only "Withdrawal", with no
 * destination, so the expense tracker books it as Misc. The flex
 * CashTransactions row is the broker's own record of the deposit and carries
 * the exact amount, so each one is sent to the expense tracker's
 * `match_broker_deposit`, which rebooks the one Misc debit it matches (or
 * changes nothing). The flex data lands about a day late; the match is a
 * later correction, never a booking.
 */

const DEPOSIT_TYPES = new Set(["Deposits/Withdrawals", "Deposits", "Deposit"]);

/** `20261026`, `20261026;101500` or `2026-10-26` → `2026-10-26`; "" otherwise. */
function isoDate(value) {
    const m = String(value || "").match(/^(\d{4})-?(\d{2})-?(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

/**
 * Incoming deposits in a flex XML: [{ currency, amount_cents, date }].
 * Reads the raw sign: the shared trade parser takes the absolute value of
 * every Deposits/Withdrawals row, which would turn a withdrawal into a deposit.
 */
export async function brokerDeposits(xml) {
    if (!xml) return [];
    const cheerioMod = await import("cheerio");
    const cheerio = cheerioMod.default || cheerioMod;
    const $ = cheerio.load(xml, { xmlMode: true });
    const out = [];
    $("CashTransaction").each((_, el) => {
        const attr = (name) => ($(el).attr(name) || "").trim();
        if (!DEPOSIT_TYPES.has(attr("type"))) return;
        const detail = attr("levelOfDetail");
        if (detail && detail.toUpperCase() !== "DETAIL") return;
        const amount = Number(attr("amount").replace(/,/g, ""));
        if (!Number.isFinite(amount) || amount <= 0) return;
        const date = isoDate(attr("dateTime")) || isoDate(attr("reportDate"));
        const currency = attr("currency").toUpperCase();
        if (!date || !currency) return;
        out.push({ currency, amount_cents: Math.round(amount * 100), date });
    });
    return out;
}

/**
 * Send each deposit to the expense tracker. Never throws: a failed call is
 * recorded on that deposit and the sync carries on.
 */
export async function matchBrokerDeposits(deposits, { fetch = globalThis.fetch, env = process.env } = {}) {
    const base = (env.EXPENSE_TRACKER_URL || "http://expense-tracker:8080").replace(/\/+$/, "");
    const budgets = {
        [(env.ACTUAL_PRIMARY_CURRENCY || "SGD").toUpperCase()]: env.ACTUAL_PRIMARY_BUDGET_FILE,
        [(env.ACTUAL_SECONDARY_CURRENCY || "MYR").toUpperCase()]: env.ACTUAL_SECONDARY_BUDGET_FILE,
    };
    const results = [];
    for (const deposit of deposits || []) {
        const budgetId = budgets[deposit.currency];
        if (!budgetId) {
            results.push({ ...deposit, matched: 0, skipped: "no_budget" });
            continue;
        }
        try {
            const r = await fetch(`${base}/tools/match-broker-deposit`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    budget_id: budgetId,
                    amount_cents: deposit.amount_cents,
                    on_date: deposit.date,
                    payee_name: env.IBKR_DEPOSIT_PAYEE || "IBKR",
                    category_name: env.IBKR_DEPOSIT_CATEGORY || "General Investment",
                }),
                signal: AbortSignal.timeout(30000),
            });
            if (!r.ok) {
                results.push({ ...deposit, matched: 0, error: `HTTP ${r.status}` });
                continue;
            }
            const body = await r.json();
            results.push({ ...deposit, matched: body?.matched === 1 ? 1 : 0 });
        } catch (e) {
            results.push({ ...deposit, matched: 0, error: e.message });
        }
    }
    return results;
}
