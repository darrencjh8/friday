/**
 * Regression coverage for the held-transfer families found in the production
 * logs of 2026-10-01..2026-10-04 (expense-tracker).
 *
 * Every body below is a real alert. Third-party person names are replaced with
 * placeholders; amounts, dates, times, masked suffixes and product wording are
 * retained, because they are what resolution keys on. The holder's own name
 * strings ("Darren DBS", "Hi Darren") are kept, matching the existing
 * convention in `bank-movement.test.js`. Reference numbers are truncated to
 * their leading segment: no assertion here depends on their tail, and they are
 * the highest-entropy identifier in the body.
 *
 * Three production defects of 2026-10-01 are covered:
 *
 *  1. A DBS bill payment whose destination is one of the holder's own credit
 *     card accounts was booked as an external payment and posted a phantom
 *     expense. Two shapes: the destination named by product ("CITI CREDIT
 *     CARDS", a payee alias rather than an account name, so it cannot resolve
 *     by name at all) and the destination named by an EXISTING card account
 *     ("Altitude"/"Yuu" -> "DBS Altitude Card"/"DBS Yuu Card"), which the
 *     transfer gate refused even though the parser had already resolved both
 *     legs. RED on unmodified origin/main (uid 1025, 1031).
 *
 *  2. Ryt's "Scheduled transfer completed successfully!" sentence form had no
 *     branch at all, so the alert parsed as null and fell through to the LLM
 *     extractor, which could not read it either — the transfer was dropped and
 *     the user was told the email could not be understood (uid 999/1010/1012).
 *     RED on unmodified origin/main.
 *
 *  3. The OCBC "We have processed your funds transfer request" body arrives
 *     flattened to ONE line. `restoreFieldLines` (added in #377) re-inserts the
 *     label breaks that make `field()`'s line-anchored read work, so this shape
 *     already parses on origin/main. These two cases are therefore guard tests
 *     rather than RED: they pin the flattened-body contract that the fixes
 *     above must not disturb.
 */
import { describe, expect, it } from "vitest";
import { parseBankMovement } from "../src/bank-movement.js";

// ── Production bodies (redacted) ────────────────────────────────

/**
 * uid 1029 — OCBC "We have processed your funds transfer request".
 * Delivered FLATTENED: the extraction collapses the whole body to one line,
 * which is what defeats the line-anchored `field()` reader.
 */
const OCBC_TRANSFER_REQUEST_FLAT =
    "Dear Valued CustomerWe have received your request to make the following transfer:" +
    "Date of Transfer:01 Oct 2026Time of Transfer:09.14 PM SGTAmount:SGD 1000.00" +
    "From your account:360 Account (-166600)To account:Darren DBS (-667222) at DBS BANK LTD" +
    "Reference number:26100100114You can log in to OCBC Online Banking and select Customer " +
    "Service > Check internet transaction status to check the status of this transfer." +
    "If you have any questions, please call our Personal Banking Hotline: OCBC website > " +
    "Contact Us.Thank you for banking with us. We look forward to serving you again." +
    "Yours sincerelyDigital BusinessGlobal Consumer Financial ServicesOCBC";

/**
 * uid 1030 — DBS "digibank Alerts - You've received a transfer". The receiving
 * leg of the same movement. `From:` is the holder's own legal name, which is
 * why the leg is held as a person-to-person movement.
 */
const DBS_RECEIVED_TRANSFER_FLAT =
    "digibank Alerts - You've received a transfer Problems viewing this email? " +
    'Select "always display images" Transaction Ref: 0126100100114350 ' +
    "Dear Customer, You have received SGD 1000.00 via FAST transfer on 01 Oct 2026 21:14 SGT. " +
    "From: ACCOUNT HOLDER To: Your DBS/ POSB account ending 7222 " +
    "Didn't expect these funds? If this is a joint account, it may be for your joint " +
    "account holder. Otherwise, please call our DBS hotline.";

/**
 * uid 1025 — DBS bill payment, source `Altitude (A/C ending 1777)` (a CARD),
 * destination `CITI CREDIT CARDS (Ref ending 2666)`. Realised production row:
 * `S$345.64 at Citi Reward via DBS Altitude Card, logged` — an expense for a
 * transfer into the holder's own Citi card.
 */
const DBS_BILLPAY_TO_CITI_CARD =
    "Transaction Ref: 1790865962876580 Dear Customer, You've successfully made a bill payment. " +
    "Date and Time: 01 Oct 21:12 (SGT) Amount: SGD 345.64 From: Altitude (A/C ending 1777) " +
    "To: CITI CREDIT CARDS (Ref ending 2666) If unauthorised, please call our DBS hotline. " +
    "To view transaction details, please login to digibank. Thank you for banking with us.";

/** uid 1031 — same layout, destination `Altitude (Ref ending 1777)`. */
const DBS_BILLPAY_TO_ALTITUDE_CARD =
    "Transaction Ref: 1790867316694201 Dear Customer, You've successfully made a bill payment. " +
    "Date and Time: 01 Oct 21:17 (SGT) Amount: SGD 2435.35 From: My Account (A/C ending 7222) " +
    "To: Altitude (Ref ending 1777) If unauthorised, please call our DBS hotline. " +
    "To view transaction details, please login to digibank.";

/** uid 1032 — same layout, destination `Yuu (Ref ending 7111)`. */
const DBS_BILLPAY_TO_YUU_CARD =
    "Transaction Ref: 1790867027500568 Dear Customer, You've successfully made a bill payment. " +
    "Date and Time: 01 Oct 21:17 (SGT) Amount: SGD 121.89 From: My Account (A/C ending 7222) " +
    "To: Yuu (Ref ending 7111) If unauthorised, please call our DBS hotline.";

/**
 * uid 1012 — Ryt "Scheduled transfer completed successfully!". An outgoing
 * transfer whose counterparty is the holder's own name; the destination is only
 * knowable from the taught fact "Ryt Bank 'Transfer settled' alert 'sent to
 * ACCOUNT HOLDER' from Main Account means a transfer to Shopee Wallet."
 */
const RYT_SCHEDULED_TRANSFER =
    "Hi Darren, Your scheduled transfer of RM908.25 to ACCOUNT HOLDER on 1/10/2026, " +
    "10:02 AM (GMT+8) was successfully completed. For more details, just log into the " +
    "Ryt Bank App and head to Scheduled Transfers.";

// ── 1. A flattened labelled body must still parse ────────────────

describe("flattened labelled bodies survive field extraction", () => {
    it("parses the uid 1029 OCBC transfer request, not null", () => {
        const movement = parseBankMovement(OCBC_TRANSFER_REQUEST_FLAT, {
            senderBank: "OCBC",
            receivedAt: "2026-10-01T13:14:29.000Z",
        });

        expect(movement).toMatchObject({
            direction: "outgoing",
            amount_cents: -100000,
            currency: "SGD",
            own_account: { bank: "OCBC", suffix: "166600" },
            counterparty: { name: "Darren DBS", bank: "DBS", suffix: "667222" },
        });
    });

    it("does not invent a destination by swallowing the next label", () => {
        const movement = parseBankMovement(OCBC_TRANSFER_REQUEST_FLAT, {
            senderBank: "OCBC",
            receivedAt: "2026-10-01T13:14:29.000Z",
        });

        // The value must stop at the following label, so the destination
        // carries only the account name and its own suffix.
        expect(movement.counterparty.name).toBe("Darren DBS");
        expect(movement.counterparty.suffix).toBe("667222");
    });
});

// ── 2. A card-to-card bill payment is a transfer, not an expense ─

describe("a DBS bill payment to the holder's own card is a transfer", () => {
    it("keeps the destination suffix for uid 1025 (payee alias)", () => {
        const movement = parseBankMovement(DBS_BILLPAY_TO_CITI_CARD, {
            senderBank: "DBS",
            receivedAt: "2026-10-01T13:12:59.000Z",
        });

        expect(movement).toMatchObject({
            direction: "outgoing",
            amount_cents: -34564,
            own_account: { bank: "DBS", suffix: "1777" },
            counterparty: { name: "CITI CREDIT CARDS", suffix: "2666" },
        });
    });

    it("keeps the destination suffix for uid 1032 (existing card account)", () => {
        const movement = parseBankMovement(DBS_BILLPAY_TO_YUU_CARD, {
            senderBank: "DBS",
            receivedAt: "2026-10-01T13:17:08.000Z",
        });

        expect(movement).toMatchObject({
            direction: "outgoing",
            amount_cents: -12189,
            own_account: { bank: "DBS", suffix: "7222" },
            counterparty: { name: "Yuu", suffix: "7111" },
        });
    });

    it("keeps the destination suffix for uid 1031 (existing card account)", () => {
        const movement = parseBankMovement(DBS_BILLPAY_TO_ALTITUDE_CARD, {
            senderBank: "DBS",
            receivedAt: "2026-10-01T13:17:23.000Z",
        });

        expect(movement).toMatchObject({
            direction: "outgoing",
            amount_cents: -243535,
            own_account: { bank: "DBS", suffix: "7222" },
            counterparty: { name: "Altitude", suffix: "1777" },
        });
    });
});

// ── 3. The Ryt scheduled-transfer sentence form ──────────────────

describe("Ryt scheduled transfer completion", () => {
    it("parses the uid 1012 body as an outgoing movement", () => {
        const movement = parseBankMovement(RYT_SCHEDULED_TRANSFER, {
            senderBank: "Ryt",
            receivedAt: "2026-10-01T02:03:00.000Z",
        });

        expect(movement).toMatchObject({
            kind: "bank_movement",
            direction: "outgoing",
            amount_cents: -90825,
            currency: "MYR",
            own_account: { bank: "Ryt" },
            counterparty: { name: "ACCOUNT HOLDER" },
        });
    });

    it("does not treat a scheduled card payment as a transfer", () => {
        const movement = parseBankMovement(
            RYT_SCHEDULED_TRANSFER.replace("scheduled transfer", "scheduled payment"),
            {
                senderBank: "Ryt",
                receivedAt: "2026-10-01T02:03:00.000Z",
            },
        );

        expect(movement).toBeNull();
    });

    it("carries the movement date from the sentence, not the received date", () => {
        const movement = parseBankMovement(RYT_SCHEDULED_TRANSFER, {
            senderBank: "Ryt",
            receivedAt: "2026-10-03T02:03:00.000Z",
        });

        expect(movement.occurred_at.slice(0, 10)).toBe("2026-10-01");
    });
});
