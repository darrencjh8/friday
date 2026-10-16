/**
 * Integration test: real qpdf + pdftotext against the repo fixture
 * test-protected.pdf (password "Test@123"). Auto-skips when the binaries are
 * not installed (e.g. local dev), so it runs in CI / the Docker image where
 * qpdf + poppler-utils are present.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { extractPdfText } from "../src/pdf_extractor.js";

function has(bin) {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const FIXTURE = resolve(__dirname, "../../../test-protected.pdf");
const toolchain = has("qpdf") && has("pdftotext");
const canRun = toolchain && existsSync(FIXTURE);
const PW = "Test@123";

describe.skipIf(!canRun)("extractPdfText — real qpdf integration", () => {
  it("returns [PDF_ENCRYPTED] without a password", async () => {
    const text = await extractPdfText(readFileSync(FIXTURE));
    expect(text).toContain("[PDF_ENCRYPTED");
  });

  it("returns [PDF_ENCRYPTED] with a wrong password", async () => {
    const text = await extractPdfText(readFileSync(FIXTURE), "definitely-wrong");
    expect(text).toContain("[PDF_ENCRYPTED");
  });

  it("extracts real text with the correct password", async () => {
    const text = await extractPdfText(readFileSync(FIXTURE), PW);
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("[PDF_ENCRYPTED");
  });
});
