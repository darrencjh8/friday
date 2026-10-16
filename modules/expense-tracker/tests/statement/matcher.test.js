/**
 * Tests for fuzzy matching of statement line items against AB transactions.
 * Ported from tests/statement/test_matcher.py
 */

import { describe, it, expect } from "vitest";
import {
    fuzzyMatch,
    _normalize,
    _dateDiff,
    _jaccard,
} from "../../src/statement/matcher.js";

describe("_normalize", () => {
    it("lowercases input", () => {
        expect(_normalize("HELLO World")).toBe("hello world");
    });

    it("strips whitespace", () => {
        expect(_normalize("  padded  ")).toBe("padded");
    });

    it("handles empty string", () => {
        expect(_normalize("")).toBe("");
    });
});

describe("_dateDiff", () => {
    it("returns 0 for same day", () => {
        expect(_dateDiff("2025-06-01", "2025-06-01")).toBe(0);
    });

    it("returns 1 for one day apart", () => {
        expect(_dateDiff("2025-06-01", "2025-06-02")).toBe(1);
    });

    it("returns 2 for two days apart", () => {
        expect(_dateDiff("2025-06-01", "2025-06-03")).toBe(2);
    });

    it("returns 5 for five days apart", () => {
        expect(_dateDiff("2025-06-01", "2025-06-06")).toBe(5);
    });

    it("handles across months", () => {
        expect(_dateDiff("2025-05-31", "2025-06-01")).toBe(1);
    });

    it("returns 99 for empty first date", () => {
        expect(_dateDiff("", "2025-06-01")).toBe(99);
    });

    it("returns 99 for empty second date", () => {
        expect(_dateDiff("2025-06-01", "")).toBe(99);
    });

    it("returns 99 for both empty", () => {
        expect(_dateDiff("", "")).toBe(99);
    });

    it("returns 99 for invalid date", () => {
        expect(_dateDiff("not-a-date", "2025-06-01")).toBe(99);
    });

    it("returns 99 for malformed format", () => {
        expect(_dateDiff("06/01/2025", "2025-06-01")).toBe(99);
    });
});

describe("_jaccard", () => {
    it("returns 1.0 for identical sets", () => {
        expect(_jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1.0);
    });

    it("returns correct value for partial overlap", () => {
        const result = _jaccard(
            new Set(["a", "b", "c"]),
            new Set(["b", "c", "d"]),
        );
        expect(result).toBeCloseTo(2.0 / 4.0);
    });

    it("returns 0.0 for no overlap", () => {
        expect(_jaccard(new Set(["a"]), new Set(["b"]))).toBe(0.0);
    });

    it("returns 0.0 for empty first set", () => {
        expect(_jaccard(new Set(), new Set(["a"]))).toBe(0.0);
    });

    it("returns 0.0 for empty second set", () => {
        expect(_jaccard(new Set(["a"]), new Set())).toBe(0.0);
    });

    it("returns 0.0 for both empty", () => {
        expect(_jaccard(new Set(), new Set())).toBe(0.0);
    });
});

describe("fuzzyMatch", () => {
    function txn(overrides = {}) {
        return {
            id: overrides.id || "txn-1",
            date: overrides.date || "2025-06-01",
            amount: overrides.amount ?? -5000,
            payee: overrides.payee || "NTUC FairPrice",
        };
    }

    it("exact amount, date, and payee gives high score (>=130)", () => {
        const txns = [
            txn({ date: "2025-06-01", amount: -5000, payee: "NTUC FairPrice" }),
        ];
        const result = fuzzyMatch("2025-06-01", -5000, "NTUC FAIRPRICE", txns);
        expect(result).toHaveLength(1);
        expect(result[0].score).toBeGreaterThanOrEqual(130); // 80 + 30 + 20
    });

    it("exact amount only gives 80", () => {
        const txns = [
            txn({ date: "2025-05-15", amount: -5000, payee: "Something Else" }),
        ];
        const result = fuzzyMatch(
            "2025-06-01",
            -5000,
            "SHOPEE SINGAPORE",
            txns,
        );
        expect(result).toHaveLength(1);
        expect(result[0].score).toBe(80);
    });

    it("near amount within 20 cents gives 50", () => {
        const txns = [
            txn({ date: "2025-05-15", amount: -4990, payee: "Something" }),
        ];
        const result = fuzzyMatch("2025-06-01", -5000, "SHOPEE", txns);
        expect(result).toHaveLength(1);
        expect(result[0].score).toBe(50);
    });

    it("exact date plus amount passes threshold", () => {
        const txns = [
            txn({ date: "2025-06-01", amount: -5000, payee: "Random" }),
        ];
        const result = fuzzyMatch("2025-06-01", -5000, "NTUC", txns);
        expect(result).toHaveLength(1);
        expect(result[0].score).toBe(110); // 80 (amount) + 30 (date)
    });

    it("date within 2 days plus amount passes threshold", () => {
        const txns = [
            txn({ date: "2025-06-03", amount: -5000, payee: "Random" }),
        ];
        const result = fuzzyMatch("2025-06-01", -5000, "NTUC", txns);
        expect(result).toHaveLength(1);
        expect(result[0].score).toBe(95); // 80 (amount) + 15 (date within 2)
    });

    it("Jaccard match plus amount passes threshold", () => {
        const txns = [
            txn({
                date: "2025-05-15",
                amount: -5000,
                payee: "SHOPEE SINGAPORE",
            }),
        ];
        const result = fuzzyMatch(
            "2025-06-01",
            -5000,
            "SHOPEE SINGAPORE",
            txns,
        );
        expect(result).toHaveLength(1);
        expect(result[0].score).toBeGreaterThanOrEqual(100); // 80 + 20 (jaccard=1.0)
    });

    it("excludes scores below 50", () => {
        const txns = [
            txn({
                date: "2025-05-01",
                amount: -1,
                payee: "Completely Different",
            }),
        ];
        const result = fuzzyMatch("2025-06-01", -5000, "NTUC", txns);
        expect(result).toHaveLength(0);
    });

    it("returns at most top 3 candidates", () => {
        const txns = [
            txn({ id: "a", amount: -5000, date: "2025-06-01", payee: "NTUC" }),
            txn({ id: "b", amount: -5000, date: "2025-06-01", payee: "NTUC" }),
            txn({ id: "c", amount: -5000, date: "2025-06-01", payee: "NTUC" }),
            txn({ id: "d", amount: -5000, date: "2025-06-01", payee: "NTUC" }),
        ];
        const result = fuzzyMatch("2025-06-01", -5000, "NTUC", txns);
        expect(result).toHaveLength(3);
    });

    it("falls back to imported_payee when payee is absent", () => {
        const txn = {
            id: "txn-1",
            date: "2025-06-01",
            amount: -5000,
            imported_payee: "SHOPEE",
        };
        const result = fuzzyMatch("2025-06-01", -5000, "SHOPEE SINGAPORE", [
            txn,
        ]);
        expect(result).toHaveLength(1);
    });

    it("handles empty uncleared list", () => {
        const result = fuzzyMatch("2025-06-01", -5000, "NTUC", []);
        expect(result).toEqual([]);
    });

    it("single dimension below threshold is excluded", () => {
        // Very different amount → no match
        expect(
            fuzzyMatch("2025-06-01", -1, "NTUC", [
                txn({ date: "2025-06-01", amount: 99999, payee: "Z" }),
            ]),
        ).toEqual([]);

        // Very different date + amount → no match
        expect(
            fuzzyMatch("2025-06-01", -5000, "NTUC", [
                txn({ date: "2025-01-01", amount: -1, payee: "Z" }),
            ]),
        ).toEqual([]);
    });

    it("handles txn with null amount gracefully", () => {
        // Use direct object (not txn() helper which overrides null via ??)
        const txns = [
            { id: "txn-1", date: "2025-06-01", amount: null, payee: "NTUC" },
        ];
        const result = fuzzyMatch("2025-06-01", -5000, "NTUC", txns);
        expect(result).toHaveLength(1);
        // amount=null → txnAmount=0 (from ?? 0), no amount score.
        // Date exact = 30. Jaccard = 0.5 (NTUC vs NTUC) so...
        // Wait, _jaccard splits "ntuc" → ["ntuc"], same for both → 1.0 → +20.
        // Total = 30 + 20 = 50.
        expect(result[0].score).toBe(50);
    });
});
