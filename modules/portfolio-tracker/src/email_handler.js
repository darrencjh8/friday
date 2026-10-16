/**
 * Email handler for the portfolio tracker.
 * Ported 1:1 from src/extractors/email_extractor.py
 *
 * Parses MIME emails, extracts text/html content, handles PDF attachments.
 */

import { load } from "cheerio";
import { extractPdfText } from "./pdf_extractor.js";

/**
 * Extract clean text content from a raw email (RFC 2822).
 * @param {Buffer|string} rawEmail - Raw email bytes or string
 * @param {string|null} [password] - Optional password for encrypted PDF attachments
 * @returns {Promise<string>}
 */
export async function extractEmailContent(rawEmail, password = null) {
    const raw = Buffer.isBuffer(rawEmail)
        ? rawEmail
        : Buffer.from(rawEmail, "utf8");

    let msg;
    try {
        // Use mailparser for proper MIME parsing
        const { simpleParser } = await import("mailparser");
        msg = await simpleParser(raw);
    } catch {
        // Fallback: basic parsing
        return fallbackExtract(raw);
    }

    const resultParts = [];

    // Header
    if (msg.from) {
        resultParts.push(`From: ${msg.from.text || msg.from}`);
    }
    if (msg.subject) {
        resultParts.push(`Subject: ${msg.subject}`);
    }
    if (msg.from || msg.subject) {
        resultParts.push("");
    }

    // Text body
    if (msg.text) {
        resultParts.push(msg.text.trim());
    } else if (msg.html) {
        // Strip HTML if no plain text
        const $ = load(msg.html);
        $("script, style").remove();
        const text = $("body").text() || $.text();
        resultParts.push(text.replace(/\s+/g, " ").trim());
    } else {
        resultParts.push("[No readable text content]");
    }

    // PDF attachments
    const pdfTexts = [];
    if (msg.attachments) {
        for (const att of msg.attachments) {
            if (att.contentType === "application/pdf") {
                const pdfBytes = att.content;
                if (pdfBytes) {
                    const pdfText = await extractPdfText(
                        Buffer.isBuffer(pdfBytes)
                            ? pdfBytes
                            : Buffer.from(pdfBytes),
                        password,
                    );
                    // Surface ALL results — including [PDF_ENCRYPTED] /
                    // [PDF_OCR_*] / [PDF_EXTRACTION_ERROR] sentinels — so the
                    // LLM can react (e.g. look up the password and retry).
                    if (pdfText) {
                        pdfTexts.push(pdfText);
                    }
                }
            }
        }
    }

    if (pdfTexts.length > 0) {
        resultParts.push("\n--- PDF ATTACHMENT ---\n");
        resultParts.push(...pdfTexts);
    }

    return cleanText(resultParts.join("\n"));
}

/**
 * Fallback extraction when mailparser fails.
 */
function fallbackExtract(raw) {
    const text = raw.toString("utf8");
    try {
        const $ = load(text);
        $("script, style").remove();
        return $("body").text().replace(/\s+/g, " ").trim();
    } catch {
        return text
            .replace(/<[^>]*>/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }
}

/**
 * Clean extracted text: strip signature markers, collapse whitespace, truncate.
 */
function cleanText(text, maxLength = 8000) {
    const lines = text.split("\n");
    const cleaned = [];
    for (const line of lines) {
        const stripped = line.trim();
        // Stop at signature marker
        if (stripped.startsWith("-- ") || stripped === "--") break;
        cleaned.push(stripped);
    }
    let result = cleaned.join("\n");
    // Collapse 3+ consecutive newlines to 2
    result = result.replace(/\n{3,}/g, "\n\n");
    if (result.length > maxLength) {
        result = result.slice(0, maxLength) + "\n\n[TRUNCATED]";
    }
    return result;
}
