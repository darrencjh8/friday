/**
 * #266: scanned statement pages have no text layer, so pdftotext returns them
 * blank. Blank pages get OCR'd (pdftoppm + tesseract); text pages are kept.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({ text: "", images: "", tesseractError: null, calls: [] }));

vi.mock("child_process", () => ({
    execFile: (cmd, args, cb) => {
        state.calls.push([cmd, ...args]);
        if (cmd === "pdfimages") return void cb(null, state.images);
        if (cmd === "tesseract") return void cb(state.tesseractError, "OCR STATEMENT\n");
        cb(null, "");
    },
}));

vi.mock("fs", async (orig) => ({
    ...(await orig()),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readFileSync: vi.fn(() => state.text),
}));

import { extractPdfFromBuffer } from "../../src/extractors.js";

beforeEach(() => {
    state.text = "";
    state.images = "page num type\n---- --- ----\n   1   0 image\n";
    state.tesseractError = null;
    state.calls = [];
});

const cmds = () => state.calls.map((c) => c[0]);

describe("OCR fallback for image-only pages (#266)", () => {
    it("OCRs only the blank page and keeps text pages", async () => {
        state.text = "  \n\fTERMS AND FEES\n\f";
        const text = await extractPdfFromBuffer(Buffer.from("x"));
        expect(text).toContain("OCR STATEMENT");
        expect(text).toContain("TERMS AND FEES");
        const ppm = state.calls.filter((c) => c[0] === "pdftoppm");
        expect(ppm).toHaveLength(1);
        expect(ppm[0]).toEqual(expect.arrayContaining(["-f", "1", "-l", "1"]));
    });

    it("OCRs blank pages of a decrypted PDF too", async () => {
        state.text = "\f";
        const text = await extractPdfFromBuffer(Buffer.from("x"), "pw");
        expect(text).toContain("OCR STATEMENT");
        expect(cmds()).toEqual(["qpdf", "pdftotext", "pdfimages", "pdftoppm", "tesseract"]);
    });

    it("marks the page plainly when OCR fails", async () => {
        state.text = "\fTERMS\f";
        state.tesseractError = new Error("spawn tesseract ENOENT");
        const text = await extractPdfFromBuffer(Buffer.from("x"));
        expect(text).toContain("[PDF_PAGE_1_IMAGE_ONLY");
        expect(text).toContain("TERMS");
    });

    it("leaves a blank page with no image alone", async () => {
        state.text = "\fTERMS\f";
        state.images = "page num type\n---- --- ----\n";
        await expect(extractPdfFromBuffer(Buffer.from("x"))).resolves.toBe(state.text);
        expect(cmds()).toEqual(["pdftotext", "pdfimages"]);
    });

    it("skips OCR when every page has text", async () => {
        state.text = "PAGE ONE\fPAGE TWO\f";
        await expect(extractPdfFromBuffer(Buffer.from("x"))).resolves.toBe(state.text);
        expect(cmds()).toEqual(["pdftotext"]);
    });
});
