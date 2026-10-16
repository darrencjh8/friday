/**
 * email_handler PDF-attachment tests (#88): password passthrough + sentinel
 * surfacing. pdf_extractor is mocked so no qpdf/pdftotext binaries are needed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const calls = vi.hoisted(() => ({ passwords: [] }));

vi.mock("../src/pdf_extractor.js", () => ({
  extractPdfText: vi.fn(async (_bytes, password = null) => {
    calls.passwords.push(password);
    if (password === "Secret123") return "DECRYPTED: BUY 100 AAPL @ 150";
    return "[PDF_ENCRYPTED: use search_memory for password or ask user]";
  }),
}));

import { extractEmailContent } from "../src/email_handler.js";

function buildPdfEmail() {
  const fakePdf = Buffer.from("%PDF-1.4 fake encrypted bytes").toString("base64");
  return [
    "From: broker@example.com",
    "Subject: Statement",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain",
    "",
    "Your statement is attached.",
    "--b1",
    'Content-Type: application/pdf; name="stmt.pdf"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="stmt.pdf"',
    "",
    fakePdf,
    "--b1--",
  ].join("\r\n");
}

beforeEach(() => {
  calls.passwords = [];
  vi.clearAllMocks();
});

describe("extractEmailContent — encrypted PDF attachments", () => {
  it("surfaces [PDF_ENCRYPTED] when no password is provided", async () => {
    const result = await extractEmailContent(buildPdfEmail());
    expect(result).toContain("[PDF_ENCRYPTED");
    expect(calls.passwords).toEqual([null]);
  });

  it("passes the password through to the PDF extractor", async () => {
    await extractEmailContent(buildPdfEmail(), "Secret123");
    expect(calls.passwords).toEqual(["Secret123"]);
  });

  it("returns decrypted text (no sentinel) with the correct password", async () => {
    const result = await extractEmailContent(buildPdfEmail(), "Secret123");
    expect(result).toContain("BUY 100 AAPL");
    expect(result).not.toContain("[PDF_ENCRYPTED");
  });
});
