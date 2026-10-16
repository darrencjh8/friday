/**
 * Email and PDF content extractors.
 * Ported 1:1 from src/extractors/ (Python) — enhanced with MIME multipart + PDF attachment handling.
 */

import { load } from "cheerio";
import { simpleParser } from "mailparser";
import { execFile } from "child_process";
import { writeFileSync, unlinkSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Extract readable text from a raw email (MIME bytes), including PDF attachments.
 * Uses mailparser for proper MIME parsing, cheerio for HTML→text, and
 * pdftotext for PDF attachments.
 *
 * @param {Buffer|string} rawEmail - raw MIME email bytes or string
 * @param {string} [password] - optional password for encrypted PDFs
 * @param {{keepLines?: boolean}} [options] - keepLines keeps the email's own line
 *   breaks (evidence for classification). The default flattens whitespace, which
 *   is what the parsers and Phase 1 read.
 *   ponytail: an HTML-only email is already flattened by cheerio, so keepLines
 *   cannot recover its breaks; block-aware HTML text is the upgrade path.
 * @returns {Promise<string>} extracted plain text
 */
export async function extractEmailContent(rawEmail, password = null, { keepLines = false } = {}) {
    const tidy = (text) =>
        keepLines
            ? String(text)
                  .replace(/[^\S\n]+/g, " ")
                  .replace(/ ?\n ?/g, "\n")
                  .replace(/\n{3,}/g, "\n\n")
                  .trim()
            : String(text).replace(/\s+/g, " ").trim();
    const raw = Buffer.isBuffer(rawEmail)
        ? rawEmail
        : Buffer.from(rawEmail || "");
    try {
        const parsed = await simpleParser(raw);
        const parts = [];

        // Text body
        if (parsed.text) parts.push(parsed.text.trim());
        // HTML body (fallback if no plain text)
        if (parsed.html && !parsed.text) {
            try {
                const $ = load(parsed.html);
                $("script, style").remove();
                const text = $("body").text().replace(/\s+/g, " ").trim();
                if (text) parts.push(text);
            } catch {}
        }

        // PDF attachments
        for (const att of parsed.attachments || []) {
            // keepLines output goes to a third-party model: no attachment text.
            if (!keepLines && att.contentType === "application/pdf" && att.content) {
                try {
                    const pdfText = await extractPdfFromBuffer(
                        att.content,
                        password,
                    );
                    if (pdfText.trim()) parts.push(pdfText.trim());
                } catch (e) {
                    const errMsg = String(e.message || e).toLowerCase();
                    if (
                        errMsg.includes("password") ||
                        errMsg.includes("encrypt")
                    ) {
                        parts.push(
                            "[PDF_ENCRYPTED: use search-memory for password or ask user]",
                        );
                    } else {
                        parts.push(
                            `[PDF_EXTRACTION_ERROR: ${String(e.message || e).slice(0, 200)}]`,
                        );
                    }
                }
            }
        }

        const result = tidy(parts.join("\n"));
        if (result) return result;

        // Fallback: try cheerio directly on raw bytes (handles non-MIME HTML)
        try {
            const $ = load(raw.toString("utf8"));
            $("script, style").remove();
            return $("body").text().replace(/\s+/g, " ").trim();
        } catch {
            return raw
                .toString("utf8")
                .replace(/<[^>]*>/g, "")
                .replace(/\s+/g, " ")
                .trim();
        }
    } catch {
        // mailparser failed — fall back to cheerio
        try {
            const $ = load(raw.toString("utf8"));
            $("script, style").remove();
            return $("body").text().replace(/\s+/g, " ").trim();
        } catch {
            return String(rawEmail)
                .replace(/<[^>]*>/g, "")
                .replace(/\s+/g, " ")
                .trim();
        }
    }
}

/**
 * qpdf exit codes: 0 = success, 3 = success with warnings, 2 = error (e.g.
 * wrong password). Exit 3 still writes a valid decrypted output (#647).
 * NOTE: keep in sync with qpdfSucceeded() in
 * modules/portfolio-tracker/src/pdf_extractor.js (separate packages).
 */
export function qpdfSucceeded(err) {
    return !err || err.code === 3;
}

/**
 * Extract text from a PDF buffer using pdftotext.
 *
 * @param {Buffer} pdfBuffer - raw PDF bytes
 * @param {string} [password] - optional password for encrypted PDFs
 * @returns {Promise<string>} extracted text
 */
export async function extractPdfFromBuffer(pdfBuffer, password = null) {
    const pdfPath = join(
        tmpdir(),
        `pdf-ext-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`,
    );
    const outPath = pdfPath.replace(".pdf", ".txt");
    writeFileSync(pdfPath, pdfBuffer);

    if (password) {
        // Decrypt with qpdf first, then pdftotext on decrypted output
        const decPath = pdfPath.replace(".pdf", "-dec.pdf");
        return new Promise((resolve, reject) => {
            execFile(
                "qpdf",
                ["--password=" + password, "--decrypt", pdfPath, decPath],
                (qpdfErr) => {
                    try {
                        unlinkSync(pdfPath);
                    } catch {}
                    if (!qpdfSucceeded(qpdfErr)) {
                        try {
                            unlinkSync(decPath);
                        } catch {}
                        reject(qpdfErr);
                        return;
                    }
                    execFile(
                        "pdftotext",
                        ["-layout", decPath, outPath],
                        (pdftotextErr) => {
                            try {
                                unlinkSync(decPath);
                            } catch {}
                            if (pdftotextErr) {
                                try {
                                    unlinkSync(outPath);
                                } catch {}
                                reject(pdftotextErr);
                            } else {
                                try {
                                    const text = readFileSync(outPath, "utf8");
                                    resolve(text);
                                } catch (e) {
                                    reject(e);
                                } finally {
                                    try {
                                        unlinkSync(outPath);
                                    } catch {}
                                }
                            }
                        },
                    );
                },
            );
        });
    }

    // No password — existing behavior
    return new Promise((resolve, reject) => {
        execFile("pdftotext", ["-layout", pdfPath, outPath], (err) => {
            try {
                unlinkSync(pdfPath);
            } catch {}
            if (err) {
                try {
                    unlinkSync(outPath);
                } catch {}
                reject(err);
            } else {
                try {
                    const text = readFileSync(outPath, "utf8");
                    resolve(text);
                } catch (e) {
                    reject(e);
                } finally {
                    try {
                        unlinkSync(outPath);
                    } catch {}
                }
            }
        });
    });
}

/** Extract text from PDF via base64 (kept for the extract_pdf_text tool) */
export async function extractPdfText(pdfBytesB64) {
    const pdfBuffer = Buffer.from(pdfBytesB64, "base64");
    return extractPdfFromBuffer(pdfBuffer);
}
