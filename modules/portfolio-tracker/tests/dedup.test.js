/**
 * DedupJournal tests — check, record, bulkSeed.
 * Uses in-memory SQLite (':memory:') for speed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DedupJournal, computeHash } from "../src/dedup.js";
import { existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import crypto from "crypto";

describe("computeHash", () => {
    it("produces deterministic hash for same inputs", () => {
        const h1 = computeHash("2026-06-01", 10000, "acct-1", "sec-a", "Buy");
        const h2 = computeHash("2026-06-01", 10000, "acct-1", "sec-a", "Buy");
        expect(h1).toBe(h2);
    });

    it("produces different hashes for different dates", () => {
        const h1 = computeHash("2026-06-01", 10000, "acct-1");
        const h2 = computeHash("2026-06-02", 10000, "acct-1");
        expect(h1).not.toBe(h2);
    });

    it("produces different hashes for different amounts", () => {
        const h1 = computeHash("2026-06-01", 10000, "acct-1");
        const h2 = computeHash("2026-06-01", 20000, "acct-1");
        expect(h1).not.toBe(h2);
    });

    it("produces different hashes for different account IDs", () => {
        const h1 = computeHash("2026-06-01", 10000, "acct-1");
        const h2 = computeHash("2026-06-01", 10000, "acct-2");
        expect(h1).not.toBe(h2);
    });

    it("produces different hashes for different security IDs", () => {
        const h1 = computeHash("2026-06-01", 10000, "acct-1", "sec-a");
        const h2 = computeHash("2026-06-01", 10000, "acct-1", "sec-b");
        expect(h1).not.toBe(h2);
    });

    it("produces different hashes for different transaction types", () => {
        const h1 = computeHash("2026-06-01", 10000, "acct-1", "sec-a", "Buy");
        const h2 = computeHash("2026-06-01", 10000, "acct-1", "sec-a", "Sell");
        expect(h1).not.toBe(h2);
    });

    it("empty security and type default to empty strings", () => {
        const h1 = computeHash("2026-06-01", 10000, "acct-1");
        const h2 = computeHash("2026-06-01", 10000, "acct-1", "", "");
        expect(h1).toBe(h2);
    });

    it("returns a 64-char hex string", () => {
        const h = computeHash("2026-06-01", 10000, "acct-1");
        expect(h).toHaveLength(64);
        expect(h).toMatch(/^[0-9a-f]+$/);
    });
});

describe("DedupJournal", () => {
    let journal;
    let dbPath;

    beforeEach(() => {
        // Use a temp path but with ':memory:' we won't create the dir
        dbPath = join(tmpdir(), `test-dedup-${crypto.randomUUID()}.db`);
        journal = new DedupJournal(dbPath);
    });

    afterEach(() => {
        try {
            if (journal && journal._db) journal._db.close();
            if (existsSync(dbPath)) unlinkSync(dbPath);
            // Clean up the directory too if it's in tmpdir
            const dir = join(tmpdir(), "test-dedup-data");
            // No standard cleanup needed since we use in-memory approach
        } catch {
            // ignore cleanup errors
        }
    });

    describe("check", () => {
        it("returns false for unknown transaction", () => {
            const result = journal.check("2026-06-01", 10000, "acct-1");
            expect(result).toBe(false);
        });

        it("returns false for unknown transaction with all fields", () => {
            const result = journal.check(
                "2026-06-01",
                10000,
                "acct-1",
                "sec-a",
                "Buy",
            );
            expect(result).toBe(false);
        });

        it("returns true after recording", () => {
            journal.record("2026-06-01", 10000, "acct-1", "corr-1");
            const result = journal.check("2026-06-01", 10000, "acct-1");
            expect(result).toBe(true);
        });

        it("returns false for different date after recording", () => {
            journal.record("2026-06-01", 10000, "acct-1", "corr-1");
            const result = journal.check("2026-06-02", 10000, "acct-1");
            expect(result).toBe(false);
        });

        it("returns true with security and type after recording", () => {
            journal.record(
                "2026-06-01",
                10000,
                "acct-1",
                "corr-1",
                "sec-a",
                "Buy",
            );
            const result = journal.check(
                "2026-06-01",
                10000,
                "acct-1",
                "sec-a",
                "Buy",
            );
            expect(result).toBe(true);
        });

        it("returns false with different security", () => {
            journal.record(
                "2026-06-01",
                10000,
                "acct-1",
                "corr-1",
                "sec-a",
                "Buy",
            );
            const result = journal.check(
                "2026-06-01",
                10000,
                "acct-1",
                "sec-b",
                "Buy",
            );
            expect(result).toBe(false);
        });
    });

    describe("record", () => {
        it("inserts a transaction and makes it detectable", () => {
            journal.record("2026-06-01", 10000, "acct-1", "corr-1");
            expect(journal.check("2026-06-01", 10000, "acct-1")).toBe(true);
        });

        it("inserts with all optional fields", () => {
            journal.record(
                "2026-06-01",
                10000,
                "acct-1",
                "corr-1",
                "sec-a",
                "Buy",
            );
            expect(
                journal.check("2026-06-01", 10000, "acct-1", "sec-a", "Buy"),
            ).toBe(true);
        });

        it("is idempotent (no duplicate insert)", () => {
            journal.record("2026-06-01", 10000, "acct-1", "corr-1");
            journal.record("2026-06-01", 10000, "acct-1", "corr-2"); // same hash, different corr-id
            // Should still have only one row
            const rows = journal._db
                .prepare("SELECT COUNT(*) as cnt FROM dedup_journal")
                .get();
            expect(rows.cnt).toBe(1);
        });

        it("allows same hash with different correlation_id (INSERT OR IGNORE)", () => {
            journal.record("2026-06-01", 10000, "acct-1", "corr-1");
            journal.record("2026-06-01", 10000, "acct-1", "corr-2");
            const rows = journal._db
                .prepare("SELECT COUNT(*) as cnt FROM dedup_journal")
                .get();
            expect(rows.cnt).toBe(1);
        });
    });

    describe("bulkSeed", () => {
        it("inserts multiple records and returns count", () => {
            const records = [
                ["2026-06-01", 10000, "acct-1", "corr-1", "sec-a", "Buy"],
                ["2026-06-02", 20000, "acct-1", "corr-2", "sec-b", "Sell"],
                ["2026-06-03", 30000, "acct-1", "corr-3", "sec-c", "Dividend"],
            ];
            const count = journal.bulkSeed(records);
            expect(count).toBe(3);
            expect(
                journal.check("2026-06-01", 10000, "acct-1", "sec-a", "Buy"),
            ).toBe(true);
            expect(
                journal.check("2026-06-02", 20000, "acct-1", "sec-b", "Sell"),
            ).toBe(true);
            expect(
                journal.check(
                    "2026-06-03",
                    30000,
                    "acct-1",
                    "sec-c",
                    "Dividend",
                ),
            ).toBe(true);
        });

        it("returns 0 for empty array", () => {
            const count = journal.bulkSeed([]);
            expect(count).toBe(0);
        });

        it("ignores duplicate records and returns new insert count", () => {
            const records = [
                ["2026-06-01", 10000, "acct-1", "corr-1", "sec-a", "Buy"],
                ["2026-06-01", 10000, "acct-1", "corr-2", "sec-a", "Buy"], // duplicate hash
            ];
            const count = journal.bulkSeed(records);
            expect(count).toBe(1);
            const rows = journal._db
                .prepare("SELECT COUNT(*) as cnt FROM dedup_journal")
                .get();
            expect(rows.cnt).toBe(1);
        });

        it("handles mixed new and duplicate records", () => {
            journal.record(
                "2026-06-01",
                10000,
                "acct-1",
                "corr-1",
                "sec-a",
                "Buy",
            );
            const records = [
                ["2026-06-01", 10000, "acct-1", "corr-2", "sec-a", "Buy"], // duplicate
                ["2026-06-02", 20000, "acct-1", "corr-3", "sec-b", "Sell"], // new
            ];
            const count = journal.bulkSeed(records);
            expect(count).toBe(1);
        });

        it("can seed large batches", () => {
            const records = [];
            for (let i = 0; i < 100; i++) {
                records.push([
                    `2026-06-${String(i + 1).padStart(2, "0")}`,
                    i * 100,
                    `acct-${i}`,
                    `corr-${i}`,
                    "",
                    "Buy",
                ]);
            }
            const count = journal.bulkSeed(records);
            expect(count).toBe(100);
        });
    });
});
