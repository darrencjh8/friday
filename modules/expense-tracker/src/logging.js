/**
 * Structured JSON logger using pino.
 * Replaces all console.log/error/warn JSON calls with pino methods.
 */
import pino from "pino";

const logger = pino({
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
        level(label) {
            return { level: label };
        },
    },
});

/**
 * Returns a child logger with a `logger` binding for module-level identification.
 */
export function getLogger(name) {
    return logger.child({ logger: name });
}

/**
 * Update log level at runtime.
 */
export function setLogLevel(level) {
    logger.level = level;
}

export { logger };

/**
 * Case-insensitive keys that must never appear in serialized logs.
 */
const SENSITIVE_KEYS = new Set([
    "notes",
    "statement_ref",
    "raw_text",
    "raw_description",
    "raw_merchant_descriptor",
    "evidence",
    "pdf_bytes_b64",
    "password",
    "authorization",
    "token",
    "secret",
    "api_key",
]);

const REDACTED = "[REDACTED]";

function isSensitiveKey(key) {
    return SENSITIVE_KEYS.has(String(key).toLowerCase());
}

/**
 * Recursively redact sensitive fields from a value before serialization.
 * Returns a new structure; the input is never mutated.
 *
 * @param {unknown} value - args, result, or nested structure to redact
 * @returns {unknown} a deep copy with sensitive object keys replaced by `[REDACTED]`
 */
export function redactSensitive(value) {
    if (Array.isArray(value)) {
        return value.map((item) => redactSensitive(item));
    }
    if (value !== null && typeof value === "object") {
        const out = {};
        for (const [key, val] of Object.entries(value)) {
            out[key] = isSensitiveKey(key) ? REDACTED : redactSensitive(val);
        }
        return out;
    }
    return value;
}
