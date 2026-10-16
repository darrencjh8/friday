/**
 * Tests for the transaction-notes composer (canonical merchant/statement notes).
 *
 * Contract (from expense-tracker-merchant-notes-plan.md):
 * - Merchant first, statement second.
 * - One blank line before retained notes.
 * - No trailing newline.
 * - Existing user notes retained.
 * - Equivalent generated metadata collapses to one line.
 * - Different existing merchant/reference lines remain; never silently delete.
 * - Recomposition is byte-identical.
 * - Only full logical lines with `Merchant:` or `Statement:` are metadata candidates.
 * - Comparison uses NFC, trimmed boundaries, collapsed comparison whitespace,
 *   and case-insensitive prefix matching.
 * - Old `Statement [period]` is not equivalent to the new form and remains preserved.
 */
import { describe, it, expect } from "vitest";
import {
    sanitizeDescriptor,
    composeNotes,
} from "../src/transaction-notes.js";

describe("sanitizeDescriptor", () => {
    it("normalizes to NFC", () => {
        const nfc = "caf\u00e9"; // é precomposed
        const nfd = "cafe\u0301"; // e + combining acute
        expect(sanitizeDescriptor(nfd)).toBe(nfc);
    });

    it("replaces control characters and separators with spaces", () => {
        expect(sanitizeDescriptor("a\tb\nc\rd")).toBe("a b c d");
        expect(sanitizeDescriptor("a\u0000b\u001Fc\u2028d\u2029e")).toBe(
            "a b c d e",
        );
    });

    it("collapses whitespace and trims", () => {
        expect(sanitizeDescriptor("  WWW.TADA.G   *   N01A04E712  ")).toBe(
            "WWW.TADA.G * N01A04E712",
        );
    });

    it("returns empty string for non-string or empty input", () => {
        expect(sanitizeDescriptor(null)).toBe("");
        expect(sanitizeDescriptor(undefined)).toBe("");
        expect(sanitizeDescriptor(42)).toBe("");
        expect(sanitizeDescriptor("")).toBe("");
        expect(sanitizeDescriptor("   ")).toBe("");
    });

    it("caps at 500 code points, appending ellipsis", () => {
        const long = "x".repeat(501);
        const result = sanitizeDescriptor(long);
        expect([...result]).toHaveLength(500);
        expect(result.endsWith("\u2026")).toBe(true);
        expect([...result][498]).toBe("x");
    });

    it("keeps 500 code points unchanged", () => {
        const exact = "x".repeat(500);
        expect(sanitizeDescriptor(exact)).toBe(exact);
    });
});

describe("composeNotes", () => {
    it("adds a Merchant line when no notes exist", () => {
        expect(
            composeNotes({ merchantDescriptor: "WWW.TADA.G* N01A04E712" }),
        ).toBe("Merchant: WWW.TADA.G* N01A04E712");
    });

    it("adds a Statement line when no notes exist", () => {
        expect(
            composeNotes({ statementRef: "Epsilon Nova | 2026-06-01..2026-06-30" }),
        ).toBe("Statement: Epsilon Nova | 2026-06-01..2026-06-30");
    });

    it("orders Merchant before Statement", () => {
        const out = composeNotes({
            merchantDescriptor: "MERCHANT",
            statementRef: "STMT",
        });
        expect(out).toBe("Merchant: MERCHANT\nStatement: STMT");
    });

    it("omits Merchant line when descriptor is empty", () => {
        expect(composeNotes({ merchantDescriptor: "", statementRef: "S" })).toBe(
            "Statement: S",
        );
        expect(composeNotes({ merchantDescriptor: null })).toBe("");
    });

    it("preserves existing user notes with one blank line separator", () => {
        const out = composeNotes({
            notes: "my custom note",
            merchantDescriptor: "M",
        });
        expect(out).toBe("Merchant: M\n\nmy custom note");
    });

    it("has no trailing newline", () => {
        const out = composeNotes({
            merchantDescriptor: "M",
            statementRef: "S",
            notes: "user",
        });
        expect(out.endsWith("\n")).toBe(false);
        expect(out).toBe("Merchant: M\nStatement: S\n\nuser");
    });

    it("is idempotent (byte-identical recomposition)", () => {
        const once = composeNotes({
            merchantDescriptor: "M",
            statementRef: "S",
            notes: "user text",
        });
        const twice = composeNotes({ notes: once, merchantDescriptor: "M", statementRef: "S" });
        expect(twice).toBe(once);
    });

    it("collapses equivalent metadata to one line", () => {
        const out = composeNotes({
            notes: "Merchant: M\n\nuser",
            merchantDescriptor: "M",
        });
        expect(out).toBe("Merchant: M\n\nuser");
    });

    it("preserves a different existing merchant line without deleting it", () => {
        const out = composeNotes({
            notes: "Merchant: OLD",
            merchantDescriptor: "NEW",
        });
        expect(out).toBe("Merchant: NEW\nMerchant: OLD");
    });

    it("preserves old 'Statement [period]' form (no colon) as user content", () => {
        const out = composeNotes({
            notes: "Statement Jun 2026",
            statementRef: "Epsilon Nova | 2026-06-01..2026-06-30",
        });
        expect(out).toBe(
            "Statement: Epsilon Nova | 2026-06-01..2026-06-30\n\nStatement Jun 2026",
        );
    });

    it("matches merchant prefix case-insensitively", () => {
        const out = composeNotes({
            notes: "merchant: M",
            merchantDescriptor: "M",
        });
        expect(out).toBe("Merchant: M");
    });

    it("treats existing metadata value comparison as case-sensitive", () => {
        // Prefix is case-insensitive, but the value differs by case → distinct lines.
        const out = composeNotes({
            notes: "Merchant: m",
            merchantDescriptor: "M",
        });
        expect(out).toBe("Merchant: M\nMerchant: m");
    });
});
