/**
 * Web search for a merchant memory does not know.
 *
 * The bank descriptor is trimmed to the merchant's name (no payment wrapper,
 * branch, card-not-present tag, company suffix or long digit run) and searched
 * once with Firecrawl. The results are evidence for Jev only: they are
 * untrusted, capped, stripped of links, and never learned. It runs whenever
 * FIRECRAWL_API_KEY is set.
 */

import { isAmaze, withoutAmazeLocation } from "./amaze.js";
import { scrubEvidence } from "./jev.js";
import { descriptorOf } from "./learning.js";
import { logger } from "./logging.js";
import { factNamesMerchant } from "./memory.js";

export const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";

const MAX_RESULTS = 5;
const MAX_TITLE_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 300;
const REQUEST_TIMEOUT_MS = 10000;

/** Country name and Firecrawl country code for the alert's currency. */
const COUNTRY_BY_CURRENCY = {
    SGD: { name: "Singapore", code: "SG" },
    MYR: { name: "Malaysia", code: "MY" },
};

/**
 * The country to search in: the one the currency implies, except for an Amaze
 * charge, whose SGD and Singapore location are Amaze's own (amaze.js).
 */
function searchCountry(descriptor, currency) {
    if (isAmaze(descriptor)) return null;
    return COUNTRY_BY_CURRENCY[String(currency || "").toUpperCase()] || null;
}

/**
 * The search query for a bank descriptor: the merchant's own name plus the
 * country its currency implies. Falls back to the descriptor when trimming
 * leaves nothing usable.
 */
export function merchantQuery(descriptor, currency) {
    const raw = withoutAmazeLocation(descriptor);
    if (!raw) return "";
    const name = raw
        // Payment wrappers name the processor, not the merchant: "AMAZE* X",
        // "GRB*X", "CARDUP-X".
        .replace(/^[A-Za-z]{2,10}\s?\*\s*/, "")
        .replace(/^CARDUP-/i, "")
        // Branch or terminal after "@", store code or CNP tag after "_".
        .replace(/[@_].*$/, "")
        // Company suffixes and everything after them.
        .replace(/\s+(?:PTE\.?\s*LT.*|SDN\.?\s*BHD.*|\(S\).*)$/i, "")
        // Phone, store and terminal numbers; a trailing country code.
        .replace(/\+?\d{4,}/g, " ")
        .replace(/\s\+\d{1,3}$/, "")
        .replace(/\s(?:SG|SGP|MY|MYS)$/i, "")
        .replace(/\s+/g, " ")
        .trim();
    const base = name.replace(/[^A-Za-z]/g, "").length >= 2 ? name : raw;
    const country = searchCountry(raw, currency);
    return country ? `${base} ${country.name}` : base;
}

/** Words too generic to stand alone as a remembered merchant key. */
const GENERIC_KEYS = new Set([
    "BAKERY", "BILL", "CAFE", "COFFEE", "FOOD", "GIRO", "KOPI", "MALAYSIA", "MART",
    "ONLINE", "PARKING", "PAYMENT", "PAYMENTS", "PAYNOW", "RESTAURANT", "SHOP",
    "SINGAPORE", "STORE", "TAXI", "TOPUP", "TRANSFER",
]);
const MIN_KEY_LETTERS = 5;

const letterCount = (text) => (text.match(/[A-Za-z]/g) || []).length;

/**
 * The key to offer remembering a merchant under: its name without the payment
 * wrapper, branch, store code, company suffix, or trailing number and country,
 * so one confirmation covers every branch ("X@T3" -> "X"). Only the start and
 * the end are cut, never the middle, so the key always matches the descriptor
 * it came from. A short or generic name falls back to the whole descriptor;
 * when neither is a usable key there is no offer.
 * @returns {string|null}
 */
export function merchantKey(descriptor) {
    // A line break or control character is never a bank descriptor.
    if (/[\u0000-\u001f\u007f]/.test(String(descriptor ?? ""))) return null;
    const raw = String(descriptor || "").replace(/ +/g, " ").trim();
    if (!raw) return null;
    let name = raw
        .replace(/^[A-Za-z]{2,10}\s?\*\s*/, "")
        .replace(/^CARDUP-/i, "")
        .replace(/[@_].*$/, "")
        .replace(/\s+(?:PTE\.?\s*LT.*|SDN\.?\s*BHD.*|\(S\).*)$/i, "");
    for (let previous = ""; previous !== name; ) {
        previous = name;
        name = name
            .replace(/\s+\+?\d+$/, "")
            .replace(/\s(?:SG|SGP|MY|MYS)$/i, "")
            .replace(/[\s*.-]+$/, "")
            .trim();
    }
    const usable = (key) =>
        Boolean(key) && !GENERIC_KEYS.has(key.toUpperCase()) && factNamesMerchant(`${key} maps to X payee`, raw);
    const trimmed = descriptorOf(name);
    if (usable(trimmed) && letterCount(trimmed) >= MIN_KEY_LETTERS) return trimmed;
    const whole = descriptorOf(raw);
    return usable(whole) ? whole : null;
}

function clip(value, max) {
    return scrubEvidence(String(value || "").replace(/\s+/g, " ").trim()).slice(0, max);
}

function hostOf(url) {
    try {
        return new URL(String(url)).hostname.replace(/^www\./, "");
    } catch {
        return "";
    }
}

/**
 * One Firecrawl web search for the descriptor.
 * @returns {Promise<{query: string, results: {title: string, description: string, host: string}[]}>}
 */
export async function searchMerchant({ config, descriptor, currency, fetchImpl = fetch }) {
    const query = merchantQuery(descriptor, currency);
    const empty = { query, results: [] };
    if (!config?.firecrawlApiKey || !query) return empty;
    const country = searchCountry(descriptor, currency);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetchImpl(FIRECRAWL_SEARCH_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.firecrawlApiKey}`,
            },
            body: JSON.stringify({
                query,
                limit: MAX_RESULTS,
                sources: ["web"],
                ...(country ? { country: country.code } : {}),
                timeout: REQUEST_TIMEOUT_MS,
            }),
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        // v2 nests web hits under data.web; v1 returned data as the array.
        const hits = Array.isArray(body?.data?.web) ? body.data.web : Array.isArray(body?.data) ? body.data : [];
        const results = hits
            .slice(0, MAX_RESULTS)
            .map((hit) => ({
                title: clip(hit?.title, MAX_TITLE_CHARS),
                description: clip(hit?.description ?? hit?.snippet, MAX_DESCRIPTION_CHARS),
                host: hostOf(hit?.url),
            }))
            .filter((hit) => hit.title || hit.description);
        return { query, results };
    } catch (error) {
        // Never log the key or the response: only that the search failed.
        logger.warn({ event: "merchant_search_failed", error: error?.message || "unknown" });
        return empty;
    } finally {
        clearTimeout(timer);
    }
}
