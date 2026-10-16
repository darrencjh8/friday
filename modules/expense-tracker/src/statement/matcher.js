/**
 * Fuzzy matching for statement line items against Actual Budget transactions.
 * Ported 1:1 from src/statement/matcher.py
 *
 * Scores each uncleared AB transaction candidate by amount proximity,
 * date proximity, and merchant description token overlap.
 * Returns top 3 candidate matches above a minimum threshold of 50.
 */

/**
 * Score and rank uncleared AB transactions against a statement line item.
 *
 * @param {string} stmtDate - Statement transaction date (YYYY-MM-DD)
 * @param {number} stmtAmountCents - Statement transaction amount in cents
 * @param {string} stmtDescription - Statement transaction description/merchant
 * @param {Array<object>} unclearedTxns - List of uncleared AB txns, each with:
 *   id, date, amount, payee (or imported_payee)
 * @returns {Array<{ txn: object, score: number }>} Top 3 candidates with score >= 50
 */
export function fuzzyMatch(
    stmtDate,
    stmtAmountCents,
    stmtDescription,
    unclearedTxns,
) {
    const candidates = [];
    const stmtTokens = new Set(_normalize(stmtDescription).split(/\s+/));

    for (const txn of unclearedTxns) {
        let score = 0;

        const txnAmount = txn.amount ?? 0;
        if (txnAmount === stmtAmountCents) {
            score += 80;
        } else if (Math.abs(txnAmount - stmtAmountCents) <= 20) {
            score += 50;
        }

        const txnDate = txn.date || "";
        const dateDiff = _dateDiff(stmtDate, txnDate);
        if (dateDiff === 0) {
            score += 30;
        } else if (dateDiff <= 2) {
            score += 15;
        }

        const txnPayee = txn.payee || txn.imported_payee || "";
        const txnTokens = new Set(_normalize(txnPayee).split(/\s+/));
        if (_jaccard(stmtTokens, txnTokens) > 0.5) {
            score += 20;
        }

        if (score < 50) continue;

        candidates.push({ txn, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, 3);
}

export function _normalize(s) {
    return s.toLowerCase().trim();
}

export function _dateDiff(d1, d2) {
    if (!d1 || !d2) return 99;
    try {
        const parts1 = d1.split("-").map(Number);
        const parts2 = d2.split("-").map(Number);
        if (parts1.length < 3 || parts2.length < 3) return 99;
        if (parts1.some(isNaN) || parts2.some(isNaN)) return 99;
        const date1 = new Date(parts1[0], parts1[1] - 1, parts1[2]);
        const date2 = new Date(parts2[0], parts2[1] - 1, parts2[2]);
        if (isNaN(date1.getTime()) || isNaN(date2.getTime())) return 99;
        return Math.abs(Math.round((date2 - date1) / (1000 * 60 * 60 * 24)));
    } catch {
        return 99;
    }
}

export function _jaccard(a, b) {
    if (!a.size || !b.size) return 0.0;
    const intersection = new Set([...a].filter((x) => b.has(x)));
    return intersection.size / (a.size + b.size - intersection.size);
}
