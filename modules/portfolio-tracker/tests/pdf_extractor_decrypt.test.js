/**
 * Decryption-pipeline tests for pdf_extractor.js (#88).
 *
 * Unit tests mock child_process (qpdf/pdftotext) + fs so they run anywhere,
 * even without the binaries installed. A guarded integration test exercises the
 * real toolchain against the repo fixture test-protected.pdf when qpdf exists.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  qpdfError: null,
  pdftotextError: null,
  outText: "",
  calls: [],
}));

vi.mock("child_process", () => ({
  execFile: (cmd, _args, cb) => {
    state.calls.push(cmd);
    if (cmd === "qpdf") return void cb(state.qpdfError);
    if (cmd === "pdftotext") return void cb(state.pdftotextError);
    cb(null);
  },
}));

vi.mock("fs", () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(() => state.outText),
  existsSync: vi.fn(() => true),
}));

// Force OCR deps unavailable so the fallback path deterministically returns
// [PDF_OCR_UNAVAILABLE] regardless of whether optionalDependencies installed.
vi.mock("pdf2pic", () => {
  throw new Error("pdf2pic not installed");
});
vi.mock("tesseract.js", () => {
  throw new Error("tesseract.js not installed");
});

import { extractPdfText } from "../src/pdf_extractor.js";
import { unlinkSync as realUnlink } from "fs";

beforeEach(() => {
  state.qpdfError = null;
  state.pdftotextError = null;
  state.outText = "";
  state.calls = [];
  vi.clearAllMocks();
});

describe("extractPdfText — decryption pipeline", () => {
  it("decrypts with qpdf then extracts with pdftotext (correct password)", async () => {
    state.outText = "DECRYPTED STATEMENT TEXT";
    const text = await extractPdfText(Buffer.from("enc"), "Test@123");
    expect(text).toBe("DECRYPTED STATEMENT TEXT");
    expect(state.calls).toEqual(["qpdf", "pdftotext"]);
  });

  it("returns [PDF_ENCRYPTED] when qpdf rejects (wrong password)", async () => {
    state.qpdfError = new Error("qpdf: invalid password supplied");
    const text = await extractPdfText(Buffer.from("enc"), "wrong");
    expect(text).toContain("[PDF_ENCRYPTED");
    // pdftotext must NOT run after qpdf fails
    expect(state.calls).toEqual(["qpdf"]);
  });

  it("treats qpdf exit 3 (success with warnings) as a successful decrypt (#647)", async () => {
    state.qpdfError = Object.assign(new Error("qpdf: operation succeeded with warnings"), { code: 3 });
    state.outText = "WARN DECRYPTED TEXT";
    const text = await extractPdfText(Buffer.from("enc"), "Test@123");
    expect(text).toBe("WARN DECRYPTED TEXT");
    expect(state.calls).toEqual(["qpdf", "pdftotext"]);
  });

  it("still fails on qpdf exit 2 (wrong password) (#647)", async () => {
    state.qpdfError = Object.assign(new Error("invalid password"), { code: 2 });
    const text = await extractPdfText(Buffer.from("enc"), "wrong");
    expect(text).toContain("[PDF_ENCRYPTED");
    expect(state.calls).toEqual(["qpdf"]);
  });

  it("extracts unencrypted PDF via pdftotext (no qpdf)", async () => {
    state.outText = "PLAIN STATEMENT TEXT";
    const text = await extractPdfText(Buffer.from("plain"));
    expect(text).toBe("PLAIN STATEMENT TEXT");
    expect(state.calls).toEqual(["pdftotext"]);
  });

  it("returns [PDF_ENCRYPTED] when pdftotext reports incorrect password (no pw given)", async () => {
    state.pdftotextError = new Error(
      "Command Line Error: Incorrect password",
    );
    const text = await extractPdfText(Buffer.from("enc"));
    expect(text).toContain("[PDF_ENCRYPTED");
  });

  it("falls back to OCR when pdftotext yields empty text", async () => {
    state.outText = "   ";
    const text = await extractPdfText(Buffer.from("scanned"));
    // OCR deps not installed in this env → unavailable marker
    expect(text).toBe("[PDF_OCR_UNAVAILABLE]");
  });

  it("cleans up temp files on success", async () => {
    state.outText = "OK";
    await extractPdfText(Buffer.from("plain"));
    expect(realUnlink).toHaveBeenCalled();
  });
});
