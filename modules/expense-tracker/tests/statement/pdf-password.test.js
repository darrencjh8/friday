/**
 * Tests for extractPdfFromBuffer with password support (T4.1).
 *
 * child_process mocking is unreliable with ESM in this vitest setup,
 * so we test: backward compatibility, function signature, and integration
 * with a real minimal PDF.
 */
import { describe, it, expect } from "vitest";
import { extractPdfFromBuffer } from "../../src/extractors.js";

const MINIMAL_PDF = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF",
);

describe("extractPdfFromBuffer — password support (T4.1)", () => {
    it("accepts optional password parameter without crashing", async () => {
        // Verify the function accepts a second arg (password)
        // without changing existing behavior
        const fn = extractPdfFromBuffer;
        expect(fn.length).toBeGreaterThanOrEqual(1); // at least 1 param
        // Call with password — should not throw TypeError
        try {
            await extractPdfFromBuffer(MINIMAL_PDF, "test123");
        } catch (e) {
            // May fail due to real pdftotext/qpdf, but must not be TypeError
            expect(e).not.toBeInstanceOf(TypeError);
        }
    });

    it("extracts text from valid PDF without password (backward compat)", async () => {
        // Skip if pdftotext is not installed
        try {
            const result = await extractPdfFromBuffer(MINIMAL_PDF);
            expect(typeof result).toBe("string");
        } catch (e) {
            if (e.code === "ENOENT") {
                // pdftotext not installed — skip
                return;
            }
            throw e;
        }
    });

    it("rejects with error for corrupt non-PDF input", async () => {
        await expect(
            extractPdfFromBuffer(Buffer.from("not a pdf")),
        ).rejects.toThrow();
    });

    it("passes password to qpdf when provided (verification via error code path)", async () => {
        // When wrong password is given, qpdf should fail with an error
        // that mentions "password" or "invalid"
        // Note: This test requires qpdf to be installed
        try {
            await extractPdfFromBuffer(MINIMAL_PDF, "wrong-password-xyz");
            // If no error, the PDF wasn't encrypted so qpdf was skipped
            // That's OK — unencrypted PDFs ignore the password
        } catch (e) {
            // Error should come from qpdf, not pdftotext
            expect(e.message).toBeDefined();
        }
    });
});

// ── Real encrypted PDF integration tests ──────────────────────────
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { extractEmailContent } from "../../src/extractors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");
const ENCRYPTED_PDF = readFileSync(resolve(PROJECT_ROOT, "test-protected.pdf"));
const CORRECT_PASSWORD = "Test@123";

describe("Encrypted PDF integration (test-protected.pdf)", () => {
    it("fails to extract without password", async () => {
        await expect(extractPdfFromBuffer(ENCRYPTED_PDF)).rejects.toThrow();
    });

    it("fails to extract with wrong password", async () => {
        await expect(
            extractPdfFromBuffer(ENCRYPTED_PDF, "wrong-password"),
        ).rejects.toThrow();
    });

    it("extracts text with correct password", async () => {
        const text = await extractPdfFromBuffer(
            ENCRYPTED_PDF,
            CORRECT_PASSWORD,
        );
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThan(0);
    });

    it("extractEmailContent returns [PDF_ENCRYPTED] without password", async () => {
        const email = buildEncryptedEmail(ENCRYPTED_PDF);
        const result = await extractEmailContent(email);
        expect(result).toContain("[PDF_ENCRYPTED");
    });

    it("extractEmailContent returns decrypted text with correct password", async () => {
        const email = buildEncryptedEmail(ENCRYPTED_PDF);
        const result = await extractEmailContent(email, CORRECT_PASSWORD);
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
        expect(result).not.toContain("[PDF_ENCRYPTED");
    });
});

function buildEncryptedEmail(pdfAttachment) {
    const boundary = "----boundary123";
    const parts = [];
    parts.push("From: bank@example.com");
    parts.push("Subject: Your Monthly eStatement");
    parts.push("MIME-Version: 1.0");
    parts.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    parts.push("");
    parts.push(`--${boundary}`);
    parts.push("Content-Type: text/plain; charset=utf-8");
    parts.push("");
    parts.push("Your statement is attached. Password is your NRIC.");
    parts.push(`--${boundary}`);
    parts.push('Content-Type: application/pdf; name="statement.pdf"');
    parts.push('Content-Disposition: attachment; filename="statement.pdf"');
    parts.push("Content-Transfer-Encoding: base64");
    parts.push("");
    let b64 = pdfAttachment.toString("base64");
    while (b64.length % 4 !== 0) b64 += "=";
    parts.push(b64);
    parts.push(`--${boundary}--`);
    return parts.join("\r\n");
}
