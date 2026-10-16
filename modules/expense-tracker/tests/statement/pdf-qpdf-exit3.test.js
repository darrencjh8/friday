/**
 * #647: qpdf exits 3 when it succeeds with warnings; that must count as success.
 * Mirrors portfolio-tracker/tests/pdf_extractor_decrypt.test.js.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({ qpdfError: null, calls: [] }));

vi.mock("child_process", () => ({
    execFile: (cmd, _args, cb) => {
        state.calls.push(cmd);
        if (cmd === "qpdf") return void cb(state.qpdfError);
        cb(null);
    },
}));

vi.mock("fs", async (orig) => ({
    ...(await orig()),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readFileSync: vi.fn(() => "DECRYPTED TEXT"),
}));

import { extractPdfFromBuffer } from "../../src/extractors.js";

beforeEach(() => {
    state.qpdfError = null;
    state.calls = [];
});

describe("qpdf exit codes (#647)", () => {
    it("treats exit 3 (warnings) as success", async () => {
        state.qpdfError = Object.assign(new Error("warnings"), { code: 3 });
        await expect(extractPdfFromBuffer(Buffer.from("x"), "pw")).resolves.toBe("DECRYPTED TEXT");
        expect(state.calls).toEqual(["qpdf", "pdftotext"]);
    });

    it("rejects on exit 2 (wrong password)", async () => {
        state.qpdfError = Object.assign(new Error("invalid password"), { code: 2 });
        await expect(extractPdfFromBuffer(Buffer.from("x"), "bad")).rejects.toThrow("invalid password");
        expect(state.calls).toEqual(["qpdf"]);
    });
});
