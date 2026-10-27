/**
 * Amaze card charges. Amaze is a card-linking wallet: its charge reaches the
 * bank as `AMAZE* <merchant>`, the merchant cut to 12 characters, and on a
 * Citi alert every one ends with Amaze's own location, `SINGAPORE SGP`, even
 * when the money was spent abroad. So the location says nothing about where
 * the purchase was made, and must not steer the web search or Jev.
 */

const AMAZE_RE = /^AMAZE\*/i;
const AMAZE_LOCATION_RE = /\s+SINGAPORE\s+SGP$/i;

const collapse = (text) => String(text || "").replace(/\s+/g, " ").trim();

/** True for an `AMAZE* …` descriptor. */
export function isAmaze(descriptor) {
    return AMAZE_RE.test(collapse(descriptor));
}

/** The descriptor without Amaze's own trailing location. */
export function withoutAmazeLocation(descriptor) {
    return collapse(descriptor).replace(AMAZE_LOCATION_RE, "");
}

/**
 * The Amaze descriptor an alert names, the same on every run, or null. The
 * Citi form keeps its `SINGAPORE SGP` tail, so a remembered key with or
 * without it still matches (`factNamesMerchant` finds a key inside a longer
 * merchant). The Standard Chartered debit form has no location.
 *   Citi: `Transaction details : AMAZE* ACMESHOP63 S    SINGAPORE     SGP`
 *   SC:   `… on 01-Jan-2026 09:00 AM at AMAZE* ACMEINSURERS. …`
 * @param {string} text - The alert text, with or without its line breaks.
 * @returns {string|null}
 */
export function amazeDescriptor(text) {
    const body = String(text || "");
    const citi = body.match(/\bAMAZE\*\s*([^\n]{1,30}?)\s+SINGAPORE\s+SGP\b/i);
    if (citi) return `AMAZE* ${collapse(citi[1])} SINGAPORE SGP`;
    const sc = body.match(/\bat\s+AMAZE\*\s*([^\n]{1,30}?)(?:\s+has\s+been\s+reversed)?\.(?:\s|$)/i);
    if (sc) return `AMAZE* ${collapse(sc[1])}`;
    return null;
}
