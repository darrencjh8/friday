/**
 * Tests for centralized recursive log redaction.
 *
 * Contract (from expense-tracker-merchant-notes-plan.md):
 * - Recursively redact case-insensitive keys before serialization.
 * - Keys: notes, statement_ref, raw_text, raw_description,
 *   raw_merchant_descriptor, pdf_bytes_b64, password, authorization,
 *   token, secret, api_key.
 * - Replacement: [REDACTED].
 * - Do not mutate original args/results.
 */
import { describe, it, expect } from "vitest";
import { redactSensitive } from "../src/logging.js";

describe("redactSensitive", () => {
    it("redacts a sensitive key", () => {
        expect(redactSensitive({ notes: "secret" })).toEqual({
            notes: "[REDACTED]",
        });
    });

    it("matches keys case-insensitively", () => {
        expect(
            redactSensitive({
                Notes: "a",
                NOTES: "b",
                notes: "c",
                Statement_Ref: "d",
            }),
        ).toEqual({
            Notes: "[REDACTED]",
            NOTES: "[REDACTED]",
            notes: "[REDACTED]",
            Statement_Ref: "[REDACTED]",
        });
    });

    it("redacts nested objects recursively", () => {
        expect(
            redactSensitive({ outer: { inner: { token: "abc" } } }),
        ).toEqual({ outer: { inner: { token: "[REDACTED]" } } });
    });

    it("redacts inside arrays", () => {
        expect(redactSensitive([{ secret: "x" }, { ok: "y" }])).toEqual([
            { secret: "[REDACTED]" },
            { ok: "y" },
        ]);
    });

    it("does not mutate the original value", () => {
        const input = { notes: "keep me", nested: { token: "t" } };
        const snapshot = JSON.stringify(input);
        redactSensitive(input);
        expect(JSON.stringify(input)).toBe(snapshot);
    });

    it("leaves non-sensitive keys and scalar values intact", () => {
        expect(
            redactSensitive({ merchant: "M", amount: 5, ok: true, arr: [1, 2] }),
        ).toEqual({ merchant: "M", amount: 5, ok: true, arr: [1, 2] });
    });

    it("redacts all documented keys", () => {
        const input = {
            notes: 1,
            statement_ref: 2,
            raw_text: 3,
            raw_description: 4,
            raw_merchant_descriptor: 5,
            pdf_bytes_b64: 6,
            password: 7,
            authorization: 8,
            token: 9,
            secret: 10,
            api_key: 11,
        };
        const out = redactSensitive(input);
        for (const key of Object.keys(out)) {
            expect(out[key]).toBe("[REDACTED]");
        }
    });

    it("returns primitives unchanged", () => {
        expect(redactSensitive("plain")).toBe("plain");
        expect(redactSensitive(42)).toBe(42);
        expect(redactSensitive(null)).toBe(null);
    });
});
