import { describe, it, expect } from "vitest";
import {
    bookableAmountCents,
    isBookableAmountCents,
} from "../src/amounts.js";

// The shared guard mirrored from the Actual route (`isSafeIntegerAmount`). A
// value it rejects must never be reinterpreted as money anywhere in the
// pipeline (#508).
describe("amount guard (#508)", () => {
    it("accepts a safe integer and a strict integer string", () => {
        for (const value of [0, -0, 1280, -1280, "0", "-0", " 1280 ", "-1280"]) {
            expect(isBookableAmountCents(value)).toBe(true);
            expect(bookableAmountCents(value)).toBe(Number(value));
        }
        expect(bookableAmountCents(" 1280 ")).toBe(1280);
    });

    it("rejects every other shape", () => {
        const rejected = [
            undefined,
            null,
            "",
            " ",
            "1e3",
            "0x10",
            "+1280",
            "1_000",
            "１２８０",
            "1.5",
            1.5,
            NaN,
            Infinity,
            -Infinity,
            true,
            false,
            [],
            [1280],
            {},
            "99999999999999999999",
            "9007199254740993",
        ];
        for (const value of rejected) {
            expect(isBookableAmountCents(value)).toBe(false);
            expect(bookableAmountCents(value)).toBeNull();
        }
    });

    it("keeps 0 (never treats it as absent)", () => {
        expect(bookableAmountCents(0)).toBe(0);
        expect(bookableAmountCents("0")).toBe(0);
    });
});
