/**
 * Tests for email content extractors — HTML, plain text, MIME multipart, PDF attachments.
 */
import { describe, it, expect } from "vitest";
import { extractEmailContent } from "../src/extractors.js";

function buildMimeEmail({ text, html, pdfAttachment } = {}) {
    const parts = [];
    parts.push("From: test@example.com");
    parts.push("Subject: Test Email");
    parts.push("MIME-Version: 1.0");

    if (pdfAttachment) {
        const boundary = "----boundary123";
        parts.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
        parts.push("");
        parts.push(`--${boundary}`);
        parts.push("Content-Type: text/plain; charset=utf-8");
        parts.push("");
        if (text) parts.push(text);
        parts.push(`--${boundary}`);
        parts.push('Content-Type: application/pdf; name="statement.pdf"');
        parts.push('Content-Disposition: attachment; filename="statement.pdf"');
        parts.push("Content-Transfer-Encoding: base64");
        parts.push("");
        let b64 = pdfAttachment.toString("base64");
        while (b64.length % 4 !== 0) b64 += "=";
        parts.push(b64);
        parts.push(`--${boundary}--`);
    } else if (html) {
        parts.push("Content-Type: text/html; charset=utf-8");
        parts.push("");
        parts.push(html);
    } else {
        parts.push("Content-Type: text/plain; charset=utf-8");
        parts.push("");
        if (text) parts.push(text);
    }

    return parts.join("\r\n");
}

describe("extractEmailContent — text/HTML extraction", () => {
    it("extracts plain text from MIME email", async () => {
        const email = buildMimeEmail({ text: "Hello World" });
        const result = await extractEmailContent(email);
        expect(result).toContain("Hello World");
    });

    it("strips HTML tags from HTML-only email", async () => {
        const email = buildMimeEmail({
            html: "<html><body><p>Hello <b>World</b></p></body></html>",
        });
        const result = await extractEmailContent(email);
        expect(result).toContain("Hello World");
        expect(result).not.toContain("<b>");
    });

    it("prefers text/plain over text/html in multipart/alternative", async () => {
        const boundary = "----boundary123";
        const email = [
            "From: test@example.com",
            "Subject: Test",
            "MIME-Version: 1.0",
            `Content-Type: multipart/alternative; boundary="${boundary}"`,
            "",
            `--${boundary}`,
            "Content-Type: text/plain; charset=utf-8",
            "",
            "Plain text content",
            `--${boundary}`,
            "Content-Type: text/html; charset=utf-8",
            "",
            "<html><body><p>HTML content</p></body></html>",
            `--${boundary}--`,
        ].join("\r\n");
        const result = await extractEmailContent(email);
        expect(result).toContain("Plain text content");
        expect(result).not.toContain("HTML content");
    });

    it("falls back to HTML body when no text/plain", async () => {
        const email = buildMimeEmail({
            html: "<html><body><p>HTML only</p></body></html>",
        });
        const result = await extractEmailContent(email);
        expect(result).toContain("HTML only");
    });

    it("handles empty input", async () => {
        expect(await extractEmailContent("")).toBe("");
    });

    it("handles null/undefined input", async () => {
        expect(await extractEmailContent(null)).toBe("");
        expect(await extractEmailContent(undefined)).toBe("");
    });

    it("handles Buffer input", async () => {
        const email = buildMimeEmail({ text: "Buffer test" });
        const result = await extractEmailContent(Buffer.from(email));
        expect(result).toContain("Buffer test");
    });

    it("handles Unicode characters", async () => {
        const email = buildMimeEmail({
            html: "<p>🎉 S$12.80 at Café 东京</p>",
        });
        const result = await extractEmailContent(email);
        expect(result).toContain("Café");
        expect(result).toContain("东京");
    });

    it("strips script and style elements from HTML", async () => {
        const email = buildMimeEmail({
            html: "<html><head><style>.a{color:red}</style><script>alert(1)</script></head><body><p>Safe</p></body></html>",
        });
        const result = await extractEmailContent(email);
        expect(result).toContain("Safe");
        expect(result).not.toContain("alert");
    });

    it("handles large input", async () => {
        const email = buildMimeEmail({ text: "A".repeat(100000) });
        const result = await extractEmailContent(email);
        expect(result.length).toBeGreaterThan(0);
    });

    it("falls back to cheerio when mailparser fails", async () => {
        const result = await extractEmailContent(
            "<html><body><p>Fallback</p></body></html>",
        );
        expect(result).toContain("Fallback");
    });
});

describe("extractEmailContent — PDF error markers", () => {
    it("includes [PDF_EXTRACTION_ERROR] marker for corrupt PDF attachment", async () => {
        // A corrupt PDF that pdftotext will reject with a non-encryption error
        const corruptPdf = Buffer.from("this is not a pdf file at all");
        const email = buildMimeEmail({
            text: "Text body still extracted",
            pdfAttachment: corruptPdf,
        });

        const result = await extractEmailContent(email);
        // Text body should still be present
        expect(result).toContain("Text body still extracted");
        // pdftotext should fail with a parse error → marker
        expect(result).toContain("[PDF_EXTRACTION_ERROR");
        expect(result).not.toContain("[PDF_ENCRYPTED");
    });
});

describe("extractEmailContent — PDF/multipart structure", () => {
    it("extracts text body from multipart/mixed email with PDF attachment", async () => {
        const pdfContent = Buffer.from("%PDF-1.4\n%%EOF");
        const email = buildMimeEmail({
            text: "Your statement is attached.",
            pdfAttachment: pdfContent,
        });

        const result = await extractEmailContent(email);
        // The text body should be present (PDF text may or may not be extracted
        // depending on pdftotext availability, but the body should always be there)
        expect(result).toContain("Your statement is attached.");
    });

    it("skips non-PDF attachments (only extracts text body)", async () => {
        const boundary = "----boundary123";
        const email = [
            "From: test@example.com",
            "Subject: Test",
            "MIME-Version: 1.0",
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
            "",
            `--${boundary}`,
            "Content-Type: text/plain; charset=utf-8",
            "",
            "Main text here",
            `--${boundary}`,
            'Content-Type: image/png; name="logo.png"',
            'Content-Disposition: attachment; filename="logo.png"',
            "Content-Transfer-Encoding: base64",
            "",
            "iVBORw0KGgo=",
            `--${boundary}--`,
        ].join("\r\n");
        const result = await extractEmailContent(email);
        expect(result).toContain("Main text here");
        expect(result).not.toContain("iVBOR");
    });
});

describe("extractEmailContent keepLines (#720)", () => {
    const text = "Amount: SGD 2.27\nReference: 360 SAVE BONUS\n\n\n\nThis is an auto-generated email.   Do not reply.";

    it("flattens whitespace by default, exactly as before", async () => {
        const out = await extractEmailContent(Buffer.from(buildMimeEmail({ text })));
        expect(out).toBe("Amount: SGD 2.27 Reference: 360 SAVE BONUS This is an auto-generated email. Do not reply.");
    });

    it("keeps the email's own line breaks so a field ends where the sender ended it", async () => {
        const out = await extractEmailContent(Buffer.from(buildMimeEmail({ text })), null, { keepLines: true });
        expect(out).toBe("Amount: SGD 2.27\nReference: 360 SAVE BONUS\n\nThis is an auto-generated email. Do not reply.");
    });

    it("leaves attachment text out, since it is sent to a third-party model", async () => {
        const corruptPdf = Buffer.from("this is not a pdf file at all");
        const raw = Buffer.from(buildMimeEmail({ text, pdfAttachment: corruptPdf }));
        const out = await extractEmailContent(raw, null, { keepLines: true });
        expect(out).toContain("Reference: 360 SAVE BONUS");
        expect(out).not.toMatch(/PDF_/);
    });
});
