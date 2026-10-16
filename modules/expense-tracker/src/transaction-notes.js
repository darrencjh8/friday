/**
 * Canonical transaction-notes composer.
 *
 * Produces deterministic notes from a raw merchant descriptor and/or a
 * statement reference, preserving any existing user notes. See
 * tests/transaction-notes.test.js for the full contract.
 */

const MAX_MERCHANT_CODE_POINTS = 500;

// C0 (0x00-0x1F), DEL (0x7F), C1 (0x80-0x9F), Unicode line/paragraph
// separators, bidi/formatting controls, zero-width characters, and BOM.
const CONTROL_OR_FORMATTING =
    /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200B\u200C\u200D\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Sanitize a generated merchant descriptor or statement reference:
 * NFC-normalize, replace control/formatting characters with ASCII spaces,
 * collapse whitespace runs to a single space, trim, and cap at 500 code points.
 *
 * @param {unknown} value - raw descriptor or statement reference
 * @returns {string} sanitized value, or "" if empty/non-string
 */
export function sanitizeDescriptor(value) {
    if (typeof value !== "string") return "";
    let out = value.normalize("NFC");
    out = out.replace(CONTROL_OR_FORMATTING, " ");
    out = out.replace(/\s+/g, " ");
    out = out.trim();
    if (!out) return "";

    const codePoints = Array.from(out);
    if (codePoints.length > MAX_MERCHANT_CODE_POINTS) {
        out = codePoints.slice(0, MAX_MERCHANT_CODE_POINTS - 1).join("") + "\u2026";
    }
    return out;
}

/**
 * Normalize a metadata value for equivalence comparison: NFC, collapse
 * whitespace runs, and trim boundaries.
 */
function normalizeForCompare(value) {
    return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

function isMerchantLine(line) {
    return /^\s*merchant\s*:/i.test(line);
}

function isStatementLine(line) {
    return /^\s*statement\s*:/i.test(line);
}

function metadataValue(line, kind) {
    return line.replace(new RegExp(`^\\s*${kind}\\s*:\\s*`, "i"), "");
}

function valuesEquivalent(a, b) {
    return normalizeForCompare(a) === normalizeForCompare(b);
}

/**
 * Merge an existing set of metadata lines with a new canonical value.
 * Equivalent existing lines collapse to the new canonical line; different
 * existing lines are preserved (prepended after the new canonical line).
 */
function mergeMetadata(existingLines, newValue, kind) {
    if (!newValue) return existingLines.slice();
    const newLine = `${kind}: ${newValue}`;
    const equivalent = existingLines.some((line) =>
        valuesEquivalent(metadataValue(line, kind), newValue),
    );
    if (equivalent) {
        const nonEquivalent = existingLines.filter(
            (line) => !valuesEquivalent(metadataValue(line, kind), newValue),
        );
        return [newLine, ...nonEquivalent];
    }
    return [newLine, ...existingLines];
}

/**
 * Compose canonical notes.
 *
 * @param {object} options
 * @param {string} [options.notes] existing notes to preserve
 * @param {unknown} [options.merchantDescriptor] raw merchant descriptor
 * @param {unknown} [options.statementRef] statement reference
 * @returns {string} canonical notes (no trailing newline)
 */
export function composeNotes({
    notes = "",
    merchantDescriptor = "",
    statementRef = "",
} = {}) {
    const existingLines = typeof notes === "string" && notes
        ? notes.split(/\r?\n/)
        : [];

    const merchantLines = [];
    const statementLines = [];
    const userLines = [];
    for (const line of existingLines) {
        if (isMerchantLine(line)) merchantLines.push(line);
        else if (isStatementLine(line)) statementLines.push(line);
        else userLines.push(line);
    }

    // Drop separator blank lines at the boundaries of the user-note block.
    while (userLines.length && userLines[0].trim() === "") userLines.shift();
    while (userLines.length && userLines[userLines.length - 1].trim() === "")
        userLines.pop();

    const newMerchant = sanitizeDescriptor(merchantDescriptor);
    const newStatement = sanitizeDescriptor(statementRef);

    const mergedMerchant = mergeMetadata(merchantLines, newMerchant, "Merchant");
    const mergedStatement = mergeMetadata(statementLines, newStatement, "Statement");
    const metadata = [...mergedMerchant, ...mergedStatement];

    if (metadata.length && userLines.length) {
        return metadata.join("\n") + "\n\n" + userLines.join("\n");
    }
    if (metadata.length) {
        return metadata.join("\n");
    }
    return userLines.join("\n");
}
