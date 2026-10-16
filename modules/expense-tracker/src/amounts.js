/**
 * Amount shape shared by the duplicate check, the insert path and the failure
 * notification, mirroring the Actual HTTP route guard (`isSafeIntegerAmount`).
 *
 * A quoted integer is accepted; hex, scientific, `+1280` and out-of-range digit
 * strings are not, and must never be silently reinterpreted as money. Issue #508.
 */
export function isBookableAmountCents(value) {
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (typeof value !== "string") return false;
  return /^-?\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value));
}

/** The value as a number when it is bookable, otherwise null. */
export function bookableAmountCents(value) {
  return isBookableAmountCents(value) ? Number(value) : null;
}
