/**
 * Tests for StatementJournal — SQLite-backed statement period tracker.
 * Ported from tests/statement/test_journal.py and test_statement_journal.py
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StatementJournal } from "../../src/tools.js";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";

function tempDbPath() {
    const dir = join(
        tmpdir(),
        "et-stmt-test-" + Math.random().toString(36).slice(2),
    );
    mkdirSync(dir, { recursive: true });
    return join(dir, "test_journal.db");
}

describe("StatementJournal", () => {
    let journal;
    let dbPath;

    beforeEach(() => {
        dbPath = tempDbPath();
        journal = new StatementJournal(dbPath);
    });

    afterEach(() => {
        journal.close();
        try {
            unlinkSync(dbPath);
        } catch {}
    });

    describe("table creation", () => {
        it("creates statement_journal table on init", () => {
            const row = journal._db
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='statement_journal'",
                )
                .get();
            expect(row).not.toBeNull();
        });

        it("creates statement_transactions table on init", () => {
            const row = journal._db
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='statement_transactions'",
                )
                .get();
            expect(row).not.toBeNull();
        });

        it("creates the index on account_id and period_start", () => {
            const row = journal._db
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_stmt_journal_account'",
                )
                .get();
            expect(row).not.toBeNull();
        });
    });

    describe("recordStatement", () => {
        it("returns a positive integer id", () => {
            const sid = journal.recordStatement(
                "acc-1",
                "sgd",
                "2025-06-01",
                "2025-07-01",
                5,
                2,
            );
            expect(sid).toBeGreaterThan(0);
            expect(Number.isInteger(sid)).toBe(true);
        });

        it("stores all fields correctly", () => {
            const sid = journal.recordStatement(
                "acc-1",
                "myr",
                "2025-06-01",
                "2025-07-01",
                3,
                1,
                150000,
                "2025-07-15",
                "MYR",
            );

            const result = journal.checkProcessed(
                "acc-1",
                "2025-06-01",
                "2025-07-01",
            );
            expect(result).not.toBeNull();
            expect(result.account_id).toBe("acc-1");
            expect(result.budget_id).toBe("myr");
            expect(result.matched_count).toBe(3);
            expect(result.outlier_count).toBe(1);
            expect(result.total_amount_cents).toBe(150000);
            expect(result.due_date).toBe("2025-07-15");
            expect(result.currency).toBe("MYR");
            expect(result.processed_at).not.toBeNull();
        });

        it("uses defaults for optional fields", () => {
            journal.recordStatement(
                "acc-1",
                "sgd",
                "2025-01-01",
                "2025-01-31",
                0,
                0,
            );
            const result = journal.checkProcessed(
                "acc-1",
                "2025-01-01",
                "2025-01-31",
            );
            expect(result.total_amount_cents).toBeNull();
            expect(result.currency).toBe("SGD");
        });

        it("rejects duplicate (account_id, period_start, period_end) due to UNIQUE constraint", () => {
            journal.recordStatement(
                "acc-1",
                "sgd",
                "2025-06-01",
                "2025-07-01",
                1,
                0,
            );
            expect(() =>
                journal.recordStatement(
                    "acc-1",
                    "sgd",
                    "2025-06-01",
                    "2025-07-01",
                    2,
                    0,
                ),
            ).toThrow();
        });

        it("allows same account with different periods", () => {
            const sid1 = journal.recordStatement(
                "acc-1",
                "sgd",
                "2025-01-01",
                "2025-01-31",
                1,
                0,
            );
            const sid2 = journal.recordStatement(
                "acc-1",
                "sgd",
                "2025-02-01",
                "2025-02-28",
                2,
                0,
            );
            expect(sid2).not.toBe(sid1);
        });
    });

    describe("checkProcessed", () => {
        it("returns null for an unrecorded period", () => {
            const result = journal.checkProcessed(
                "acc-none",
                "2025-06-01",
                "2025-07-01",
            );
            expect(result).toBeNull();
        });

        it("returns the record when the period exists", () => {
            journal.recordStatement(
                "acc-1",
                "sgd",
                "2025-06-01",
                "2025-07-01",
                5,
                1,
            );
            const result = journal.checkProcessed(
                "acc-1",
                "2025-06-01",
                "2025-07-01",
            );
            expect(result).not.toBeNull();
            expect(result.account_id).toBe("acc-1");
            expect(result.matched_count).toBe(5);
            expect(result.outlier_count).toBe(1);
        });
    });

    describe("addTransaction", () => {
        let statementId;

        beforeEach(() => {
            statementId = journal.recordStatement(
                "acc-1",
                "sgd",
                "2025-06-01",
                "2025-07-01",
                0,
                0,
            );
        });

        it("adds a reconciled transaction and returns a positive id", () => {
            const tid = journal.addTransaction(
                statementId,
                "2025-06-15",
                "NTUC FairPrice",
                -5000,
                "reconciled",
                "ab-42",
            );
            expect(tid).toBeGreaterThan(0);
            expect(Number.isInteger(tid)).toBe(true);
        });

        it("adds an outlier transaction", () => {
            const tid = journal.addTransaction(
                statementId,
                "2025-06-20",
                "Unknown merchant",
                -9999,
                "outlier",
                null,
                "No matching AB transaction found",
            );
            expect(tid).toBeGreaterThan(0);
        });

        it("rejects invalid status values (CHECK constraint)", () => {
            expect(() =>
                journal.addTransaction(
                    statementId,
                    "2025-06-15",
                    "Test",
                    -5000,
                    "invalid_status",
                ),
            ).toThrow();
        });
    });

    describe("getHistory", () => {
        it("returns statements in reverse chronological order (newest first)", () => {
            journal.recordStatement(
                "acc-1",
                "sgd",
                "2025-01-01",
                "2025-01-31",
                1,
                0,
            );
            journal.recordStatement(
                "acc-1",
                "sgd",
                "2025-03-01",
                "2025-03-31",
                2,
                0,
            );
            journal.recordStatement(
                "acc-1",
                "sgd",
                "2025-02-01",
                "2025-02-28",
                0,
                1,
            );

            const history = journal.getHistory("acc-1");
            expect(history).toHaveLength(3);
            expect(history[0].period_start).toBe("2025-03-01");
            expect(history[1].period_start).toBe("2025-02-01");
            expect(history[2].period_start).toBe("2025-01-01");
        });

        it("filters by account_id", () => {
            journal.recordStatement(
                "acc-1",
                "sgd",
                "2025-06-01",
                "2025-07-01",
                1,
                0,
            );
            const history = journal.getHistory("acc-2");
            expect(history).toEqual([]);
        });

        it("returns expected fields", () => {
            journal.recordStatement(
                "acc-1",
                "sgd",
                "2025-06-01",
                "2025-07-01",
                3,
                2,
            );
            const history = journal.getHistory("acc-1");
            expect(history).toHaveLength(1);
            const entry = history[0];
            expect(entry).toHaveProperty("id");
            expect(entry).toHaveProperty("account_id");
            expect(entry).toHaveProperty("budget_id");
            expect(entry).toHaveProperty("period_start");
            expect(entry).toHaveProperty("period_end");
            expect(entry).toHaveProperty("matched_count");
            expect(entry).toHaveProperty("outlier_count");
            expect(entry).toHaveProperty("processed_at");
        });
    });

    describe("close", () => {
        it("closes the database connection without error", () => {
            expect(() => journal.close()).not.toThrow();
        });
    });
});
