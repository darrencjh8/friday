/**
 * The account holder's own legal name, for fixtures only.
 *
 * A test that asserts holder-name matching needs *a* name, not *your* name.
 * So the literal never lives in the repo: it comes from OWN_LEGAL_NAME, with a
 * synthetic default that keeps `npm test` green in CI without a secret.
 *
 *   OWN_LEGAL_NAME="Ada Lovelace" npm test   # local, if you want a real shape
 *   npm test                                  # CI, synthetic default
 *
 * Because `ownLegalName()` and the assertions share this one constant, the
 * holder-matching logic is exercised identically either way — only the
 * characters differ. Never assert on the name's literal value in a test body;
 * call `ownLegalName()` instead, or the test silently depends on the env var.
 */
export const OWN_LEGAL_NAME = process.env.OWN_LEGAL_NAME || "ACCOUNT HOLDER";

/** Upper-case form, as a bank alert renders the holder. */
export const OWN_LEGAL_NAME_UPPER = OWN_LEGAL_NAME.toUpperCase();

/** `Legal name: <name> -> <MNEMONIC> (statement password)`, the live fact shape. */
export const OWN_LEGAL_NAME_FACT = `Legal name: ${OWN_LEGAL_NAME}`;

export default OWN_LEGAL_NAME;
