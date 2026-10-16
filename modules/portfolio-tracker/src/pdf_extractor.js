/**
 * PDF text extraction for trade confirmations and broker statements.
 *
 * Primary path: `pdftotext -layout` (machine-accurate for digital PDFs).
 * Encrypted PDFs: `qpdf --password=<pw> --decrypt` first, then `pdftotext`.
 * Fallback: OCR (pdf2pic + tesseract.js) only when pdftotext yields no text
 * on an unencrypted PDF (e.g. scanned image PDFs).
 *
 * Decryption pipeline ported from expense-tracker/src/extractors.js (proven in
 * production). Error sentinels are returned (not thrown) so the LLM can react:
 *   [PDF_ENCRYPTED]        — wrong/missing password on an encrypted PDF
 *   [PDF_EXTRACTION_ERROR] — other extraction failure
 *   [PDF_OCR_UNAVAILABLE]  — OCR deps missing and pdftotext produced no text
 *   [PDF_OCR_ERROR]        — OCR attempt failed
 */

import { execFile } from "child_process";
import { writeFileSync, unlinkSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let pdf2picAvailable = false;
let tesseractAvailable = false;

function tempPath(suffix) {
  return join(
    tmpdir(),
    `pdf-ext-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`,
  );
}

function safeUnlink(p) {
  try {
    unlinkSync(p);
  } catch {
    /* ignore */
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * qpdf exit codes: 0 = success, 3 = success with warnings, 2 = error (e.g.
 * wrong password). Exit 3 still writes a valid decrypted output (#647).
 * NOTE: keep in sync with qpdfSucceeded() in
 * modules/expense-tracker/src/extractors.js (separate packages).
 */
export function qpdfSucceeded(err) {
  return !err || err.code === 3;
}

function runQpdf(args) {
  return new Promise((resolve, reject) => {
    execFile("qpdf", args, (err) => (qpdfSucceeded(err) ? resolve() : reject(err)));
  });
}

/**
 * Extract text from PDF bytes via pdftotext, decrypting with qpdf first when a
 * password is supplied. Throws on failure (caller classifies the error).
 * @param {Buffer} pdfBytes
 * @param {string|null} password
 * @returns {Promise<string>}
 */
async function pdftotextExtract(pdfBytes, password = null) {
  const inPath = tempPath(".pdf");
  const outPath = inPath.replace(/\.pdf$/, ".txt");
  writeFileSync(inPath, pdfBytes);

  if (password) {
    const decPath = inPath.replace(/\.pdf$/, "-dec.pdf");
    try {
      await runQpdf([`--password=${password}`, "--decrypt", inPath, decPath]);
      await run("pdftotext", ["-layout", decPath, outPath]);
      return readFileSync(outPath, "utf8");
    } finally {
      safeUnlink(inPath);
      safeUnlink(decPath);
      safeUnlink(outPath);
    }
  }

  try {
    await run("pdftotext", ["-layout", inPath, outPath]);
    return readFileSync(outPath, "utf8");
  } finally {
    safeUnlink(inPath);
    safeUnlink(outPath);
  }
}

async function ensureOcrDeps() {
  if (pdf2picAvailable && tesseractAvailable) return;
  try {
    await import("pdf2pic");
    pdf2picAvailable = true;
  } catch {
    /* pdf2pic not installed */
  }
  try {
    await import("tesseract.js");
    tesseractAvailable = true;
  } catch {
    /* tesseract.js not installed */
  }
}

/** OCR fallback for scanned/image PDFs (unencrypted only). */
async function ocrExtract(pdfBytes) {
  await ensureOcrDeps();
  if (!pdf2picAvailable || !tesseractAvailable) {
    return "[PDF_OCR_UNAVAILABLE]";
  }
  try {
    const { fromBuffer } = await import("pdf2pic");
    const { default: Tesseract } = await import("tesseract.js");
    const options = {
      density: 300,
      saveFilename: "page",
      savePath: tmpdir(),
      format: "png",
      width: 2550,
      height: 3300,
    };
    const convert = fromBuffer(pdfBytes, options);
    const results = await convert(-1, { responseType: "buffer" });
    const pages = Array.isArray(results) ? results : [results];
    const texts = [];
    for (const page of pages) {
      const imageBuffer = page.buffer || page;
      if (!imageBuffer) continue;
      const { data } = await Tesseract.recognize(imageBuffer, "eng", {
        logger: () => {},
      });
      if (data.text && data.text.trim()) texts.push(data.text.trim());
    }
    return texts.join("\n--- PAGE BREAK ---\n");
  } catch (e) {
    return `[PDF_OCR_ERROR: ${e.message}]`;
  }
}

/**
 * Extract text from PDF bytes.
 * @param {Buffer} pdfBytes - Raw PDF file bytes
 * @param {string|null} [password] - Optional password for encrypted PDFs
 * @returns {Promise<string>}
 */
export async function extractPdfText(pdfBytes, password = null) {
  try {
    const text = await pdftotextExtract(pdfBytes, password);
    if (text && text.trim()) return text;
    // pdftotext succeeded but produced no text → likely a scanned PDF → OCR.
    return await ocrExtract(pdfBytes);
  } catch (e) {
    const msg = String(e.message || e).toLowerCase();
    if (msg.includes("password") || msg.includes("encrypt")) {
      return "[PDF_ENCRYPTED: use search_memory for password or ask user]";
    }
    // Non-encryption failure (pdftotext missing/corrupt) → OCR fallback for
    // scanned/image PDFs. Return OCR's result verbatim (text or [PDF_OCR_*]).
    return await ocrExtract(pdfBytes);
  }
}

/**
 * Extract text from a PDF file on disk.
 * @param {string} filepath
 * @param {string|null} [password]
 * @returns {Promise<string>}
 */
export async function extractPdfTextFromFile(filepath, password = null) {
  const { existsSync } = await import("fs");
  if (!existsSync(filepath)) {
    return "[PDF_FILE_NOT_FOUND]";
  }
  return extractPdfText(readFileSync(filepath), password);
}
