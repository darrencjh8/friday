/**
 * Regression coverage for the production incidents of 2026-09-19, driven by the
 * real alert bodies from the production inbox.
 *
 * Fixtures are the production bodies with identifying values replaced:
 *   - the account holder's legal name -> "ACCOUNT HOLDER"
 *   - the clinic merchant -> "CLINIC MERCHANT"
 * Amounts, dates, times, product names, and account suffixes are retained: they
 * are what resolution keys on, and they are not secret.
 *
 * Each `it` names the issue it guards.
 */
import { describe, expect, it, vi } from "vitest";
import {
    looksLikePersonName,
    parseBankMovement,
} from "../src/bank-movement.js";

// ── Production bodies (redacted) ────────────────────────────────

/** uid 919 - Ryt Bank outgoing, counterparty is the holder's own name. */
const RYT_SENT_OWN_NAME =
    "Hi Darren, You've sent RM100.00 to ACCOUNT HOLDER on 19/9/2026, 12:58 PM (GMT+8) using your Main Account.";

/** uid 911 - Ryt Bank incoming credit from the holder's own name. */
const RYT_RECEIVED_OWN_NAME =
    "Hi Darren, Money's in! You've received RM62.00 from ACCOUNT HOLDER on 18/9/2026, 5:04 AM (GMT+8).";

/** uid 916 - one-sided OCBC deposit whose only sender evidence is `Reference:`. */
const OCBC_REFERENCE_DEPOSIT = `Dear Valued Customer,

A deposit was made in your account. Here are the details:

Time of deposit: 9:31 AM
Amount: SGD 3,006.00
Account that money was deposited in: (-166600)
Reference: from ACCOUNT HOLDER
`;

/** uid 912 - OCBC DuitNow debit to the holder's own Ryt account (redacted). */
const OCBC_DUITNOW_OWN_ACCOUNT = `Dear ACCOUNT HOLDER,

As you instructed, we have made the following transfer:

Transfer Date: 18 Sep 2026 5.04AM
Amount: MYR 62.00
From your account: OCBC 360 ACCOUNT ******2444
To payee: ACCOUNT HOLDER (********2333)
Reference number: REDACTED
`;

/** uid 917 - Ryt Bank card payment to a real (but unknown-to-memory) merchant. */
const RYT_PAID_MERCHANT =
    "Hi Darren, You've paid RM255.00 to CLINIC MERCHANT on 19/9/2026, 10:50 AM (GMT+8) using your Ryt Credit.";

/** uid 918 - ordinary Ryt merchant purchase that poisoned a generic memory key. */
const RYT_BOUGHT_MERCHANT =
    "Hi Darren, You've paid RM27.70 to BAKERY MERCHANT on 19/9/2026, 11:00 AM (GMT+8) using your Ryt Credit.";

/**
 * The bodies above are the alert sentence alone. Production sends the sentence
 * inside a marketing template: a banner, the sentence, a wrap that splits the
 * `using your <account>` clause across a newline, then a confidentiality footer.
 * The parser must survive that, so every fixture below keeps the real frame.
 */
const RYT_FRAME = (sentence) => `[https://cdn.example/bee/Images/bmsx/tracker/money%20on%20the%20move.png]

Hi Darren,

${sentence}

Need help? Reach out to our Help & Support Centre at support@rytbank.my
[support@rytbank.my]. 

[https://cdn.example/bee/Images/bmsx/tracker/Footer.png]https://track.example/ls/click?upn=redacted

This email and any hyperlinks are confidential and intended only for the
recipient. Please do not reply. If received in error, delete it and notify us at
support@rytbank.my. Unauthorised use, disclosure, or distribution is prohibited.
While we take precautions, YTL Digital Bank Berhad, operating under the brand
name Ryt Bank is not responsible for any damage caused by malicious code or
errors in this email. Ryt Bank is a member of PIDM. Ryt Bank deposits are
protected by PIDM up to RM250,000 for each depositor.

[https://track.example/wf/open?upn=redacted]`;

/** uid 919 as actually delivered: sentence wrapped mid-clause, then a footer. */
const RYT_SENT_OWN_NAME_REAL = RYT_FRAME(
    "You've sent RM100.00 to ACCOUNT HOLDER on 19/9/2026, 12:58 PM (GMT+8) using your\nMain Account.",
);

/** uid 911 as actually delivered. */
const RYT_RECEIVED_OWN_NAME_REAL = RYT_FRAME(
    "Money's in! You've received RM62.00 from ACCOUNT HOLDER on 18/9/2026, 5:04 AM (GMT+8).",
);

/**
 * #654 — the `paid ... to <person>` form. Same sentence grammar as
 * `sent`/`received` (bank-movement.js accepts `received|sent|paid`), a real
 * person as the counterparty, and the merchant-verb `paid` on the front.
 */
const RYT_SENT_PERSON = RYT_FRAME(
    "You've paid RM255.00 to LEE WEI LING on 19/9/2026, 10:50 AM (GMT+8) using your\nRyt Credit.",
);

/**
 * #654 boundary — the incoming person credit from a name that is NOT the
 * holder, so the release predicate (not the own-identity arm) decides the row.
 * Same person, same amount, opposite direction to RYT_SENT_PERSON.
 */
const RYT_RECEIVED_FROM_PERSON = RYT_FRAME(
    "Money's in! You've received RM255.00 from LEE WEI LING on 18/9/2026, 5:04 AM (GMT+8) using your\nMain Account.",
);

/**
 * #654 / uid 1012 — the Ryt scheduled-transfer completion. It names a person
 * and NO source account (own_account is {name:null, bank, suffix:null}), so with
 * two live accounts at the bank nothing can pin the source.
 */
const RYT_SCHEDULED_PERSON =
    "Dear Customer,\n\nYour scheduled transfer of RM908.25 to LEE WEI LING on 1/10/2026, 10:02 AM (GMT+8) was successfully completed.\n\nThank you for banking with us.\nRyt Bank App and head to Scheduled Transfers.";

/** uid 132 — the `was paid at <MERCHANT>` form; a different branch entirely. */
const RYT_PAID_AT_MERCHANT =
    "Hi Customer,\n\nRM200.00 was paid at TNG-EWALLET ECOM 3-EC using your Main Account on 2/9/2026, 12:46 AM (GMT+8).\n\nIf this was not you, give us a call.";

/** uid 917 as actually delivered: a real merchant whose name reads like a person. */
const RYT_PAID_MERCHANT_REAL = RYT_FRAME(
    "You've paid RM255.00 to CFF UNITED PLT on 19/9/2026, 10:50 AM (GMT+8) using your\nRyt Credit.",
);

/** uid 918 as actually delivered. */
const RYT_BOUGHT_MERCHANT_REAL = RYT_FRAME(
    "You've paid RM27.70 to 365 BAKERY on 19/9/2026, 11:00 AM (GMT+8) using your Ryt\nCredit.",
);

describe("person-name detection is structural, not a name list", () => {
    it("accepts a bare person name", () => {
        expect(looksLikePersonName("ACCOUNT HOLDER")).toBe(true);
        expect(looksLikePersonName("LOW JUN HAO")).toBe(true);
    });

    it("rejects businesses, banks, and descriptors", () => {
        expect(looksLikePersonName("CLINIC MERCHANT")).toBe(false);
        expect(looksLikePersonName("TNG-EWALLET ECOM 3-EC")).toBe(false);
        expect(looksLikePersonName("Example Pte Ltd")).toBe(false);
        expect(looksLikePersonName("Trust Bank")).toBe(false);
        expect(looksLikePersonName("Bank payment")).toBe(false);
        expect(looksLikePersonName("")).toBe(false);
        expect(looksLikePersonName("Solo")).toBe(false);
    });

    it("rejects business suffixes that are not in any keyword list", () => {
        for (const business of [
            "CFF UNITED PLT",
            "ACME LIMITED",
            "ACME LLC",
            "ACME PLC",
            "ACME GMBH",
            "ACME S.A.",
            "CFF UNITED PLT.",
            "ACME LIMITED.",
        ]) {
            expect(looksLikePersonName(business), business).toBe(false);
        }
    });
});

describe("Ryt Bank owned-name alerts (#585)", () => {
    it("parses the real uid 919 body, footer and line wrap included", () => {
        const movement = parseBankMovement(RYT_SENT_OWN_NAME_REAL, {
            senderBank: "Ryt",
            receivedAt: "2026-09-19T04:58:02.000Z",
        });

        expect(movement).toMatchObject({
            direction: "outgoing",
            amount_cents: -10000,
            currency: "MYR",
            occurred_at: "2026-09-19T12:58:00+08:00",
            own_account: { name: "Main Account", bank: "Ryt", suffix: null },
            counterparty: { name: "ACCOUNT HOLDER", bank: null, suffix: null },
            person_transfer: true,
        });
    });

    it("parses the real uid 911 body inside its template", () => {
        const movement = parseBankMovement(RYT_RECEIVED_OWN_NAME_REAL, {
            senderBank: "Ryt",
            receivedAt: "2026-09-17T21:04:10.000Z",
        });

        expect(movement).toMatchObject({
            direction: "incoming",
            amount_cents: 6200,
            currency: "MYR",
            occurred_at: "2026-09-18T05:04:00+08:00",
            own_account: { bank: "Ryt", suffix: null },
            counterparty: { name: "ACCOUNT HOLDER", bank: null, suffix: null },
            person_transfer: true,
        });
    });

    it("does not flag a real merchant payment whose name reads like a person", () => {
        const movement = parseBankMovement(RYT_PAID_MERCHANT_REAL, {
            senderBank: "Ryt",
            receivedAt: "2026-09-19T02:50:21.000Z",
        });

        expect(movement).toMatchObject({
            direction: "outgoing",
            amount_cents: -25500,
            merchant_display_name: "CFF UNITED PLT",
        });
        expect(movement.person_transfer).toBe(false);
    });
});

describe("one-sided OCBC deposit with a Reference sender (#584)", () => {
    it("surfaces the reference sender instead of dropping it", () => {
        const movement = parseBankMovement(OCBC_REFERENCE_DEPOSIT, {
            senderBank: "OCBC",
            receivedAt: "2026-09-19T01:31:20.000Z",
        });

        expect(movement).toMatchObject({
            direction: "incoming",
            amount_cents: 300600,
            currency: "SGD",
            own_account: { bank: "OCBC", suffix: "166600" },
            counterparty: { name: "ACCOUNT HOLDER", bank: null, suffix: null },
        });
    });

    it("still invents no counterparty when the reference is empty", () => {
        const movement = parseBankMovement(
            `
A deposit was made in your account.
Time of deposit : 11:59 PM
Amount : SGD 0.20
Account that money was deposited in : (-166600)
Reference :
`,
            { senderBank: "OCBC", receivedAt: "2026-09-02T00:05:00+08:00" },
        );

        expect(movement).toMatchObject({
            direction: "incoming",
            amount_cents: 20,
            counterparty: null,
        });
    });
});

describe("hold behaviour for person-name movements (#584 / #585)", () => {
    /** Orchestrator over a single Ryt/OCBC account and no matching payee. */
    async function orchestrate(body, { senderBank, receivedAt, accounts, payees = [], extraFacts = [], legalFact = "Legal name: ACCOUNT HOLDER", listFacts = [] }) {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const calls = [];
        const tools = {
            executeTool: vi.fn(async (name, args) => {
                calls.push({ name, args });
                if (name === "fetch_context")
                    return { accounts, categories: [], payees };
                if (name === "search_memory") {
                    return args.query === "ACCOUNT HOLDER"
                        ? { results: [{ text: legalFact }, ...extraFacts] }
                        : { results: extraFacts };
                }
                // The FULL deterministic fact read the person-hold release
                // predicate uses. Distinct from search_memory on purpose: a recall
                // miss must not release a hold, so the two are stubbed separately
                // and a test can prove a fact releases only via this route.
                if (name === "list_facts") return { facts: listFacts };
                if (name === "check_duplicate") return false;
                if (name === "check_schedule_collision") return false;
                // The far-side read the #598 fix makes before reserving. Nothing
                // is pre-booked in Actual for these fixtures, so there is no
                // candidate and the insert path stays unchanged.
                if (name === "find_link_candidate")
                    return { candidate: null, matches: 0 };
                return true;
            }),
            getPhase1ToolSchemas: vi.fn(() => []),
            setEmailContext: vi.fn(),
        };
        const orch = new AgentOrchestrator(
            {
                primaryCurrency: "SGD",
                secondaryCurrency: "MYR",
                primaryBudgetFile: "budget-sgd",
                secondaryBudgetFile: "budget-myr",
                llmProvider: "deepseek",
                llmApiKey: "test",
                deepseekApiKey: "test",
            },
            tools,
        );
        orch._llm.chat = vi.fn();
        const phase1 = await orch._runPhase1(body, { senderBank, receivedAt });
        // A dropped alert (no parser resolves it and the LLM declines) is a real
        // outcome this change pins — `_resolvePhase2(null)` would throw, so stop
        // at the null instead of pretending phase 2 ran.
        const phase2 = phase1 ? await orch._resolvePhase2(phase1) : null;
        const result = phase2 ? await orch._executePhase3(phase2) : null;
        return { phase1, phase2, result, calls, llm: orch._llm.chat };
    }

    const rytAccounts = [{ id: "ryt-bank", name: "Ryt Bank", closed: false }];
    const ocbcAccounts = [
        { id: "ocbc-360", name: "OCBC 360", closed: false },
    ];
    const ownAccountTransferAccounts = [
        { id: "ocbc-360", name: "OCBC 360", closed: false },
        { id: "ryt-bank", name: "Ryt Bank", closed: false },
    ];

    const ownAccountTransferPayees = [
        { id: "p-ocbc-360", name: "OCBC 360", transfer_acct: "ocbc-360" },
        { id: "p-ryt-bank", name: "Ryt Bank", transfer_acct: "ryt-bank" },
    ];

    // Standard Chartered savings accounts and their transfer payees, for the
    // DBS FAST / SC PayNow reconciliation cases (#592).
    const scAccounts = [
        { id: "posb-cashback", name: "POSB Cashback", closed: false },
        { id: "dbs-account", name: "DBS Account", closed: false },
        { id: "sc-bonus", name: "SC Bonus Saver", closed: false },
    ];
    const scTransferPayees = [
        { id: "p-posb", name: "POSB Cashback", transfer_acct: "posb-cashback" },
        { id: "p-dbs", name: "DBS Account", transfer_acct: "dbs-account" },
        { id: "p-sc", name: "SC Bonus Saver", transfer_acct: "sc-bonus" },
    ];

    it("books the redacted uid 912 own-name debit as a transfer when both suffixes identify accounts (#569)", async () => {
        const { phase2, result, calls } = await orchestrate(OCBC_DUITNOW_OWN_ACCOUNT, {
            senderBank: "OCBC",
            receivedAt: "2026-09-17T21:04:12.000Z",
            accounts: ownAccountTransferAccounts,
            payees: ownAccountTransferPayees,
            // The live suffix facts for this pair of accounts. Without them the
            // masked trailing digits cannot name an account, and the movement is
            // not determinable — which is the next case.
            extraFacts: [
                "Account ending 2444 belongs to OCBC 360",
                "Account ending 2333 belongs to Ryt Bank",
            ],
        });

        expect(phase2).toMatchObject({
            account_id: "ocbc-360",
            payee_name: "Ryt Bank",
            category_id: null,
            _is_transfer: true,
            _transfer: {
                source_account_id: "ocbc-360",
                destination_account_id: "ryt-bank",
            },
        });
        expect(phase2._hold_unresolved_transfer).toBeUndefined();
        expect(result.action).not.toBe("notified");
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(true);
    });

    it("holds the same own-name debit as Misc with no category when neither account is known (#569)", async () => {
        const { phase2, result, calls } = await orchestrate(OCBC_DUITNOW_OWN_ACCOUNT, {
            senderBank: "OCBC",
            receivedAt: "2026-09-17T21:04:12.000Z",
            accounts: ownAccountTransferAccounts,
            payees: ownAccountTransferPayees,
        });

        expect(phase2).toMatchObject({
            payee_name: "Misc",
            account_id: "ocbc-360",
            _hold_unresolved_transfer: true,
        });
        expect(phase2.category_id ?? null).toBe(null);
        expect(result.action).toBe("notified");
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
        expect(calls.some((c) => c.name === "notify_user")).toBe(true);
    });

    it("holds the uid 919 own-name debit as Misc with no category (#585)", async () => {
        const { phase2, result, calls, llm } = await orchestrate(
            RYT_SENT_OWN_NAME,
            {
                senderBank: "Ryt",
                receivedAt: "2026-09-19T04:58:02.000Z",
                accounts: rytAccounts,
            },
        );

        expect(llm).not.toHaveBeenCalled();
        expect(phase2).toMatchObject({
            payee_name: "Misc",
            account_id: "ryt-bank",
            _hold_unresolved_transfer: true,
        });
        expect(phase2.category_id ?? null).toBe(null);
        expect(phase2.payee_name).not.toBe("Work");
        expect(result.action).toBe("notified");
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
        expect(calls.some((c) => c.name === "notify_user")).toBe(true);
    });

    it("holds the uid 911 own-name credit rather than booking income (#585)", async () => {
        const { phase2, result, calls } = await orchestrate(
            RYT_RECEIVED_OWN_NAME,
            {
                senderBank: "Ryt",
                receivedAt: "2026-09-17T21:04:10.000Z",
                accounts: rytAccounts,
            },
        );

        expect(phase2).toMatchObject({ payee_name: "Misc" });
        expect(phase2.category_id ?? null).toBe(null);
        expect(result.action).toBe("notified");
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
    });

    it("holds the RM200 own-name debit even when the live legal-name fact carries a password suffix (#592)", async () => {
        // Production fact shape stores the statement-password mnemonic after an
        // arrow: `Legal name: <holder> -> <MNEMONIC> (statement password)`. The
        // old capture read the whole tail, so the holder name never matched and
        // the RM200 was booked as spending instead of being held.
        const { phase2, result, calls, llm } = await orchestrate(
            "Hi Darren, You've sent RM200.00 to ACCOUNT HOLDER on 21/9/2026, 12:22 AM (GMT+8) using your Main Account.",
            {
                senderBank: "Ryt",
                receivedAt: "2026-09-20T16:22:04.000Z",
                accounts: rytAccounts,
                legalFact:
                    "Legal name: ACCOUNT HOLDER -> ACCOUNT (statement password)",
            },
        );

        expect(llm).not.toHaveBeenCalled();
        expect(phase2).toMatchObject({
            payee_name: "Misc",
            account_id: "ryt-bank",
            _hold_unresolved_transfer: true,
        });
        expect(phase2.category_id ?? null).toBe(null);
        expect(result.action).toBe("notified");
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
        expect(calls.some((c) => c.name === "notify_user")).toBe(true);
    });

    it("holds the RM200 own-name debit with a clean legal-name fact too (#592)", async () => {
        const { phase2, result, calls } = await orchestrate(
            "Hi Darren, You've sent RM200.00 to ACCOUNT HOLDER on 21/9/2026, 12:22 AM (GMT+8) using your Main Account.",
            {
                senderBank: "Ryt",
                receivedAt: "2026-09-20T16:22:04.000Z",
                accounts: rytAccounts,
            },
        );

        expect(phase2).toMatchObject({ payee_name: "Misc" });
        expect(phase2.category_id ?? null).toBe(null);
        expect(result.action).toBe("notified");
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
    });

    // The two SC PayNow credits and the DBS FAST emails that book their other
    // leg, from production on 2026-09-21 (SC credit uid 930/932; DBS debit
    // uid 929/931). The DBS alerts are internal FAST transfers
    // (POSB/My Account -> SC Bonus Saver) whose SOURCE suffix had no memory
    // fact, so the deterministic parser bailed and the LLM booked the
    // destination name as a merchant expense.
    const SC_CREDIT_5589 = `
Dear Valued Customer,

Banking Transaction
You have received a PayNow/FAST transfer of SGD 55.89 from ACCOUNT HOLDER| on 21-Sep-26 12:29 AM.
`;
    const SC_CREDIT_3100 = `
Dear Valued Customer,

Banking Transaction
You have received a PayNow/FAST transfer of SGD 31.00 from ACCOUNT HOLDER| on 21-Sep-26 12:33 AM.
`;
    const DBS_FAST_5589 = `Transaction Ref: 17899237848838872763

Dear Customer,

We refer to your FAST Interbank Funds Transfer transaction dated 21 Sep. We are pleased to confirm that the transaction was completed.

Date & Time: 21 Sep 00:29 (SGT)
Amount: SGD55.89
From: POSB Cashback A/C ending 5500
To: ACCOUNT HOLDER SC A/C ending 2555
`;
    const DBS_FAST_3100 = `Transaction Ref: 17899270420627426494

Dear Customer,

We refer to your FAST Interbank Funds Transfer transaction dated 21 Sep. We are pleased to confirm that the transaction was completed.

Date & Time: 21 Sep 00:33 (SGT)
Amount: SGD31.00
From: My Account A/C ending 7222
To: ACCOUNT HOLDER SC A/C ending 2555
`;

    it("holds the DBS FAST transfer when its source suffix is unknown, instead of booking a phantom expense (#592)", async () => {
        const { phase2, result, calls, llm } = await orchestrate(DBS_FAST_5589, {
            senderBank: "DBS",
            receivedAt: "2026-09-20T16:29:52.000Z",
            accounts: scAccounts,
            payees: scTransferPayees,
            // Live memory knows the destination 2555 but not the source 5500.
            extraFacts: ["Account ending 2555 belongs to SC Bonus Saver"],
        });

        expect(llm).not.toHaveBeenCalled();
        expect(phase2).toMatchObject({
            payee_name: "Misc",
            account_id: "sc-bonus",
            _hold_unresolved_transfer: true,
        });
        expect(phase2.category_id ?? null).toBe(null);
        expect(phase2.payee_name).not.toBe("Household stuffs");
        expect(result.action).toBe("notified");
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
        expect(calls.some((c) => c.name === "notify_user")).toBe(true);
    });

    it("books the DBS FAST transfer when both suffixes are known (#592)", async () => {
        const { phase2, result } = await orchestrate(DBS_FAST_3100, {
            senderBank: "DBS",
            receivedAt: "2026-09-20T16:33:34.000Z",
            accounts: scAccounts,
            payees: scTransferPayees,
            // Live memory: destination 2555 and source 7222 both known.
            extraFacts: [
                "Account ending 2555 belongs to SC Bonus Saver",
                "Account ending 7222 belongs to DBS Account",
            ],
        });

        expect(phase2._is_transfer).toBe(true);
        expect(phase2._transfer).toMatchObject({
            source_account_id: "dbs-account",
            destination_account_id: "sc-bonus",
            amount_cents: 3100,
        });
        expect(result.action).not.toBe("notified");
    });

    it("clears the SC PayNow hold when the matching DBS transfer leg is already booked (#592)", async () => {
        const booked = {
            id: "leg-5589",
            budget_id: "budget-sgd",
            source_account_id: "posb-cashback",
            destination_account_id: "sc-bonus",
            currency: "SGD",
            amount_cents: 5589,
            occurred_at: "2026-09-21T00:29:00+08:00",
        };
        const tools = {
            executeTool: vi.fn(async (name) => {
                if (name === "find_inserted_transfer") return booked;
                if (name === "list_facts") return { facts: [] };
                // The far-side read the #598 fix makes before reserving. These
                // legs come from the journal, not from existing Actual rows.
                if (name === "find_link_candidate")
                    return { candidate: null, matches: 0 };
                if (name === "fetch_context")
                    return {
                        accounts: [
                            { id: "sc-bonus", name: "SC Bonus Saver", closed: false },
                        ],
                        categories: [],
                        payees: [],
                    };
                return { results: [] };
            }),
            getPhase1ToolSchemas: vi.fn(() => []),
            setEmailContext: vi.fn(),
        };
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const orch = new AgentOrchestrator(
            {
                primaryCurrency: "SGD",
                secondaryCurrency: "MYR",
                primaryBudgetFile: "budget-sgd",
                secondaryBudgetFile: "budget-myr",
                llmProvider: "deepseek",
                llmApiKey: "x",
                deepseekApiKey: "x",
            },
            tools,
        );
        const p1 = {
            merchant: "ACCOUNT HOLDER",
            raw_description:
                "You have received a PayNow/FAST transfer of SGD 55.89 from ACCOUNT HOLDER| on 21-Sep-26 12:29 AM.",
            amount_cents: 5589,
            date: "2026-09-21",
            currency: "SGD",
            account_id: "sc-bonus",
            account_name: "SC Bonus Saver",
            budget_id: "budget-sgd",
            action: "insert",
            payee_name: "",
            category_id: "",
            notes: "",
            reasoning: "",
            _is_paynow: true,
            received_at: "2026-09-20T16:32:00.000Z",
        };
        const p2 = await orch._resolvePhase2(p1);

        expect(p2._hold_unresolved_paynow).toBeUndefined();
        expect(p2._is_transfer).toBe(true);
        expect(p2._transfer).toMatchObject({
            source_account_id: "posb-cashback",
            destination_account_id: "sc-bonus",
            amount_cents: 5589,
        });
    });

    it("holds the uid 916 reference-named deposit instead of booking income (#584)", async () => {
        const { phase2, result, calls } = await orchestrate(
            OCBC_REFERENCE_DEPOSIT,
            {
                senderBank: "OCBC",
                receivedAt: "2026-09-19T01:31:20.000Z",
                accounts: ocbcAccounts,
            },
        );

        expect(phase2).toMatchObject({
            payee_name: "Misc",
            account_id: "ocbc-360",
            _hold_unresolved_transfer: true,
        });
        expect(result.action).toBe("notified");
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
    });

    it("books the uid 917 merchant payment instead of holding it (#587)", async () => {
        const { phase2, result, calls } = await orchestrate(RYT_PAID_MERCHANT, {
            senderBank: "Ryt",
            receivedAt: "2026-09-19T02:50:21.000Z",
            accounts: rytAccounts,
        });

        expect(phase2._hold_unresolved_transfer).toBeUndefined();
        expect(phase2.payee_name).toBe("Misc");
        expect(phase2.category_id ?? null).toBe(null);
        expect(result.action).not.toBe("notified");
        expect(
            calls.find((c) => c.name === "insert_transaction")?.args,
        ).toMatchObject({
            account_id: "ryt-bank",
            amount_cents: -25500,
            category_id: undefined,
        });
    });

    it("books the uid 918 merchant purchase with no category (#588)", async () => {
        const { phase2, calls } = await orchestrate(RYT_BOUGHT_MERCHANT_REAL, {
            senderBank: "Ryt",
            receivedAt: "2026-09-19T03:00:00.000Z",
            accounts: rytAccounts,
        });

        // No memory fact existed, so the merchant stays Misc with no category
        // and nothing is learned.
        expect(phase2).toMatchObject({ payee_name: "Misc" });
        expect(phase2.category_id ?? null).toBe(null);
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(true);
        expect(
            calls.some(
                (c) => c.name === "learn_fact" && /category/i.test(c.args?.fact || ""),
            ),
        ).toBe(false);
    });

    it("books the real uid 917 payment even though CFF UNITED PLT reads as a person name (#587)", async () => {
        const { phase2, calls } = await orchestrate(RYT_PAID_MERCHANT_REAL, {
            senderBank: "Ryt",
            receivedAt: "2026-09-19T02:50:21.000Z",
            accounts: rytAccounts,
        });

        expect(phase2._hold_unresolved_transfer).toBeUndefined();
        expect(phase2.payee_name).toBe("Misc");
        expect(calls.find((c) => c.name === "insert_transaction")?.args).toMatchObject({
            account_id: "ryt-bank",
            amount_cents: -25500,
        });
    });

    it("HOLDS a sent payment to an unlisted person-shaped business descriptor (#654)", async () => {
        // This pin was "must book" until #654 and is AMENDED, not deleted: a
        // transfer whose counterparty is an unremembered person-shaped name is
        // now held for the user instead of being posted as spend. `ACME
        // CONSULTANCY` is person-shaped (two alphabetic tokens, no NON_PERSON
        // keyword, no digits), so it takes the same path as a real person name.
        // Disclosed in the plan's Behaviour change #1 and the PR body.
        //
        // The genuine must-book merchant pins are DIFFERENT sentence forms and
        // are unaffected: `You've paid … to CLINIC MERCHANT` / `365 BAKERY` are
        // protected by `looksLikePersonName` REJECTING those names, and
        // `RM200.00 was paid at TNG-EWALLET ECOM 3-EC` is a separate branch that
        // carries no `person_transfer` key at all.
        const body = RYT_FRAME(
            "You've sent RM255.00 to ACME CONSULTANCY on 19/9/2026, 10:50 AM (GMT+8) using your\nRyt Credit.",
        );
        const { phase2, result, calls } = await orchestrate(body, {
            senderBank: "Ryt",
            receivedAt: "2026-09-19T02:50:21.000Z",
            accounts: rytAccounts,
        });

        expect(phase2).toMatchObject({
            payee_name: "Misc",
            account_id: "ryt-bank",
            _hold_unresolved_transfer: true,
        });
        expect(phase2.category_id ?? null).toBe(null);
        expect(result.action).toBe("notified");
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
    });

    it("holds the real uid 919 body delivered inside its template (#585)", async () => {
        const { phase2, result, calls } = await orchestrate(RYT_SENT_OWN_NAME_REAL, {
            senderBank: "Ryt",
            receivedAt: "2026-09-19T04:58:02.000Z",
            accounts: rytAccounts,
        });

        expect(phase2).toMatchObject({
            payee_name: "Misc",
            account_id: "ryt-bank",
            _hold_unresolved_transfer: true,
        });
        expect(result.action).toBe("notified");
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
    });

    // ── #654 pins ───────────────────────────────────────────────────────────
    // A person transfer is held in BOTH directions, and the held row names the
    // actual counterparty, not the destination-account field.

    it("holds a `paid ... to <person>` transfer: the `paid` verb is not a merchant-only form (#654)", async () => {
        // The Ryt sentence grammar accepts `received|sent|paid`, and the
        // `person_transfer` gate excluded `paid`, so this form booked as spend.
        const body = RYT_FRAME(
            "You've paid RM255.00 to LEE WEI LING on 19/9/2026, 10:50 AM (GMT+8) using your\nRyt Credit.",
        );
        const { phase2, result, calls } = await orchestrate(body, {
            senderBank: "Ryt",
            receivedAt: "2026-09-19T02:50:21.000Z",
            accounts: rytAccounts,
        });

        expect(phase2).toMatchObject({
            payee_name: "Misc",
            account_id: "ryt-bank",
            _hold_unresolved_transfer: true,
            _hold_cause: "person_identity_unverified",
        });
        expect(result.action).toBe("notified");
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
    });

    it("still BOOKS `was paid at <merchant>`: that branch carries no person flag (#654)", async () => {
        // The genuine merchant pins are protected by `looksLikePersonName`
        // REJECTING the name, not by the verb gate — and this `was paid at` form
        // is a different branch that never sets the key at all.
        const movement = parseBankMovement(
            "Hi Customer,\n\nRM200.00 was paid at TNG-EWALLET ECOM 3-EC using your Main Account on 2/9/2026, 12:46 AM (GMT+8).\n\nIf this was not you, give us a call.",
            { senderBank: "Ryt", receivedAt: "2026-09-02T00:00:00.000Z" },
        );
        expect(movement.person_transfer).toBeUndefined();

        const { phase2, calls } = await orchestrate(RYT_PAID_AT_MERCHANT, {
            senderBank: "Ryt",
            receivedAt: "2026-09-02T00:00:00.000Z",
            accounts: rytAccounts,
        });
        expect(phase2._hold_unresolved_transfer).toBeUndefined();
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(true);
    });

    it("holds an INCOMING person credit when the sender bank has ONE live account (#654)", async () => {
        const { phase2, result, calls } = await orchestrate(RYT_RECEIVED_OWN_NAME_REAL, {
            senderBank: "Ryt",
            receivedAt: "2026-09-18T00:00:00.000Z",
            accounts: rytAccounts,
        });

        expect(phase2).toMatchObject({
            payee_name: "Misc",
            _hold_unresolved_transfer: true,
            _hold_cause: "person_identity_unverified",
        });
        // The held row names the SENDER, never the holder's own account.
        expect(phase2.merchant).toBe("ACCOUNT HOLDER");
        expect(result.action).toBe("notified");
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
    });

    it("still DROPS an incoming person credit when TWO accounts share the sender bank (#654 boundary)", async () => {
        // Not fixed by this change and pinned so the claim cannot silently widen:
        // `resolveAccountByBank` refuses an ambiguous bank, so the movement never
        // reaches the hold site, and F2's new branch is keyed on `outgoing`.
        const { phase1 } = await orchestrate(RYT_RECEIVED_OWN_NAME_REAL, {
            senderBank: "Ryt",
            receivedAt: "2026-09-18T00:00:00.000Z",
            accounts: [
                { id: "ryt-bank", name: "Ryt Bank", closed: false },
                { id: "ryt-savings", name: "Ryt Savings", closed: false },
            ],
        });

        expect(phase1).toBeNull();
    });

    it("keys the hold on the counterparty, so a `maps to ... payee` fact releases it (#654)", async () => {
        // Only the payee/category mapping grammar can release a person hold, and
        // it must be read from the FULL fact list, not from search_memory.
        const { phase2, calls } = await orchestrate(RYT_SENT_PERSON, {
            senderBank: "Ryt",
            receivedAt: "2026-09-19T02:50:21.000Z",
            accounts: rytAccounts,
            listFacts: ["LEE WEI LING merchant maps to Bak Kwa Trading payee"],
        });

        expect(phase2._hold_unresolved_transfer).toBeUndefined();
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(true);
    });

    // The release predicate is direction-independent, but the booking arms are
    // not: `_resolveMovementToOutput` has no incoming arm for a non-internal
    // movement that has a counterparty, so it falls to `return null`. Both
    // outcomes of the incoming leg are pinned here — inherited at HEAD, out of
    // scope for this change, and pinned so the boundary cannot silently widen.
    it("HOLDS an incoming person credit when no fact releases it (#654)", async () => {
        const { phase2, calls } = await orchestrate(RYT_RECEIVED_FROM_PERSON, {
            senderBank: "Ryt",
            receivedAt: "2026-09-18T00:00:00.000Z",
            accounts: rytAccounts,
        });

        expect(phase2._hold_cause).toBe("person_identity_unverified");
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
    });

    it("still DROPS that incoming credit once a `maps to ... payee` fact releases it (#654 boundary)", async () => {
        const { phase1, calls } = await orchestrate(RYT_RECEIVED_FROM_PERSON, {
            senderBank: "Ryt",
            receivedAt: "2026-09-18T00:00:00.000Z",
            accounts: rytAccounts,
            listFacts: ["LEE WEI LING merchant maps to Bak Kwa Trading payee"],
        });

        // Released, and then dropped for want of an incoming booking arm — NOT
        // booked as income and NOT held. Closing this means adding an incoming
        // person arm, which is its own change with its own reproduction.
        expect(phase1).toBeNull();
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
    });

    it("does NOT release the hold from a legal-name or account-type fact (#654)", async () => {
        // Fail-closed: a fact that names the holder or an account is not evidence
        // that the counterparty is a real non-person entity. An overlap rule
        // here would release a real person transfer behind this one.
        const { phase2 } = await orchestrate(RYT_SENT_PERSON, {
            senderBank: "Ryt",
            receivedAt: "2026-09-19T02:50:21.000Z",
            accounts: rytAccounts,
            listFacts: [
                "Legal name: LEE WEI LING -> LW (statement password)",
                "LEE WEI LING is a bank account",
            ],
        });

        expect(phase2._hold_unresolved_transfer).toBe(true);
        expect(phase2._hold_cause).toBe("person_identity_unverified");
    });

    it("each hold cause renders its OWN notification text (#654)", async () => {
        const personHold = await orchestrate(RYT_SENT_PERSON, {
            senderBank: "Ryt",
            receivedAt: "2026-09-19T02:50:21.000Z",
            accounts: rytAccounts,
        });
        const personText = personHold.calls.find((c) => c.name === "notify_user")?.args?.message || "";
        expect(personText).toMatch(/transfer to "LEE WEI LING"/);
        expect(personText).not.toMatch(/destination/i);
        // A held email is marked read, so it does not re-notify on every poll.
        expect(personHold.calls.some((c) => c.name === "mark_email_read")).toBe(true);

        // The F2 ambiguity is a DIFFERENT cause with a different story: the
        // source account was unclear, not the counterparty.
        const sourceAmbiguous = await orchestrate(RYT_SCHEDULED_PERSON, {
            senderBank: "Ryt",
            receivedAt: "2026-10-01T02:03:00.000Z",
            accounts: [
                { id: "ryt-bank", name: "Ryt Bank", closed: false },
                { id: "ryt-savings", name: "Ryt Savings", closed: false },
            ],
        });
        expect(sourceAmbiguous.phase2._hold_cause).toBe("source_account_ambiguous");
        const sourceText = sourceAmbiguous.calls.find((c) => c.name === "notify_user")?.args?.message || "";
        expect(sourceText).toMatch(/which of your accounts it left/);
        // It never reaches the person-hold site, so it never claims that cause.
        expect(sourceAmbiguous.phase2._hold_cause).not.toBe("person_identity_unverified");
    });
});

describe("due schedule collision (#586)", () => {
    /**
     * The production schedule, exactly as the live actual-api returns it. Shape
     * captured from `actual.getSchedules()` against the running service:
     * ALL_KEYS = account, amount, amountOp, completed, date, id, name,
     * next_date, payee, posts_transaction, rule. `amount` is a top-level number
     * and `next_date` a top-level "YYYY-MM-DD" string, which is what the guard
     * reads. Schedule 49d0925d is the one that produced the duplicate pair.
     */
    const RENT_SCHEDULE = [
        {
            id: "49d0925d-a391-4924-ad32-4d5307d8e5ef",
            name: "Prepare: Rent",
            next_date: "2026-09-19",
            completed: false,
            posts_transaction: true,
            amount: -300600,
            amountOp: "is",
            account: "223311f9-0a52-4db7-916d-9a714fa39db3",
            payee: "35f7e181-b723-434f-8c7d-82f62ecfefa8",
            date: "2026-09-19",
            rule: "rule-id",
        },
    ];

    it("matches a due schedule by magnitude whatever its own account", async () => {
        const { ToolRegistry } = await import("../src/tools.js");
        const registry = new ToolRegistry({}, null);
        registry._get = vi.fn(async () => RENT_SCHEDULE);

        await expect(
            registry.executeTool("check_schedule_collision", {
                budget_id: "budget-sgd",
                amount_cents: 300600,
                date: "2026-09-19",
            }),
        ).resolves.toBe(true);
    });

    it("does not match an unrelated amount or a distant date", async () => {
        const { ToolRegistry } = await import("../src/tools.js");
        const registry = new ToolRegistry({}, null);
        registry._get = vi.fn(async () => RENT_SCHEDULE);

        await expect(
            registry.executeTool("check_schedule_collision", {
                budget_id: "budget-sgd",
                amount_cents: 300600,
                date: "2026-12-01",
            }),
        ).resolves.toBe(false);
        await expect(
            registry.executeTool("check_schedule_collision", {
                budget_id: "budget-sgd",
                amount_cents: 12345,
                date: "2026-09-19",
            }),
        ).resolves.toBe(false);
    });

    it("ignores completed and non-posting schedules", async () => {
        const { ToolRegistry } = await import("../src/tools.js");
        const registry = new ToolRegistry({}, null);
        registry._get = vi.fn(async () => [
            { ...RENT_SCHEDULE[0], completed: true },
            { ...RENT_SCHEDULE[0], posts_transaction: false },
        ]);

        await expect(
            registry.executeTool("check_schedule_collision", {
                budget_id: "budget-sgd",
                amount_cents: 300600,
                date: "2026-09-19",
            }),
        ).resolves.toBe(false);
    });

    it("throws when the schedule list cannot be read, so the caller holds", async () => {
        const { ToolRegistry } = await import("../src/tools.js");
        const registry = new ToolRegistry({}, null);
        registry._get = vi.fn(async () => ({ error: "schedules unavailable" }));

        await expect(
            registry.executeTool("check_schedule_collision", {
                budget_id: "budget-sgd",
                amount_cents: 300600,
                date: "2026-09-19",
            }),
        ).rejects.toThrow();
    });

    /** uid 916 shape with the reference stripped: a genuine one-sided deposit. */
    const UNREFERENCED_DEPOSIT = `
A deposit was made in your account.
Time of deposit : 9:31 AM
Amount : SGD 3,006.00
Account that money was deposited in : (-166600)
Reference :
`;

    it("holds a one-sided deposit when a matching schedule is due", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const calls = [];
        const tools = {
            executeTool: vi.fn(async (name, args) => {
                calls.push({ name, args });
                if (name === "fetch_context")
                    return {
                        accounts: [{ id: "ocbc-360", name: "OCBC 360", closed: false }],
                        categories: [],
                        payees: [],
                    };
                if (name === "search_memory") return { results: [] };
                if (name === "check_duplicate") return false;
                if (name === "check_schedule_collision") return true;
                return true;
            }),
            getPhase1ToolSchemas: vi.fn(() => []),
            setEmailContext: vi.fn(),
        };
        const orch = new AgentOrchestrator(
            {
                primaryCurrency: "SGD",
                secondaryCurrency: "MYR",
                primaryBudgetFile: "budget-sgd",
                secondaryBudgetFile: "budget-myr",
                llmProvider: "deepseek",
                llmApiKey: "test",
                deepseekApiKey: "test",
            },
            tools,
        );
        orch._llm.chat = vi.fn();

        const phase1 = await orch._runPhase1(UNREFERENCED_DEPOSIT, {
            senderBank: "OCBC",
            receivedAt: "2026-09-19T01:31:20.000Z",
        });
        expect(phase1).toMatchObject({
            amount_cents: 300600,
            _structured_movement: true,
        });

        const phase2 = await orch._resolvePhase2(phase1);
        const result = await orch._executePhase3(phase2);

        expect(result.details).toContain("schedule");
        expect(
            calls.find((c) => c.name === "check_schedule_collision")?.args,
        ).toMatchObject({
            budget_id: "budget-sgd",
            amount_cents: 300600,
            date: "2026-09-19",
        });
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
        expect(calls.some((c) => c.name === "notify_user")).toBe(true);
    });

    it("holds a one-sided deposit when the schedule list cannot be read", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const calls = [];
        const tools = {
            executeTool: vi.fn(async (name, args) => {
                calls.push({ name, args });
                if (name === "fetch_context")
                    return {
                        accounts: [{ id: "ocbc-360", name: "OCBC 360", closed: false }],
                        categories: [],
                        payees: [],
                    };
                if (name === "search_memory") return { results: [] };
                if (name === "check_duplicate") return false;
                if (name === "check_schedule_collision")
                    throw new Error("schedules unavailable");
                return true;
            }),
            getPhase1ToolSchemas: vi.fn(() => []),
            setEmailContext: vi.fn(),
        };
        const orch = new AgentOrchestrator(
            {
                primaryCurrency: "SGD",
                secondaryCurrency: "MYR",
                primaryBudgetFile: "budget-sgd",
                secondaryBudgetFile: "budget-myr",
                llmProvider: "deepseek",
                llmApiKey: "test",
                deepseekApiKey: "test",
            },
            tools,
        );
        orch._llm.chat = vi.fn();

        const phase1 = await orch._runPhase1(UNREFERENCED_DEPOSIT, {
            senderBank: "OCBC",
            receivedAt: "2026-09-19T01:31:20.000Z",
        });
        const phase2 = await orch._resolvePhase2(phase1);
        await orch._executePhase3(phase2);

        // An unreadable list is not proof of absence.
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);

        // ...and the hold must not claim a match it never observed. Reporting
        // "matches a scheduled transaction" during an actual-api outage names a
        // cause that did not occur.
        const notify = calls.find((c) => c.name === "notify_user")?.args?.message;
        expect(notify).toMatch(/could not read the schedule list/i);
        expect(notify).not.toMatch(/matches a scheduled transaction/i);
        expect(
            calls.find((c) => c.name === "log_decision")?.args?.action,
        ).toBe("held_schedule_check_failed");
    });

    it("books a one-sided deposit when no schedule matches", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const calls = [];
        const tools = {
            executeTool: vi.fn(async (name, args) => {
                calls.push({ name, args });
                if (name === "fetch_context")
                    return {
                        accounts: [{ id: "ocbc-360", name: "OCBC 360", closed: false }],
                        categories: [],
                        payees: [],
                    };
                if (name === "search_memory") return { results: [] };
                if (name === "check_duplicate") return false;
                if (name === "check_schedule_collision") return false;
                return true;
            }),
            getPhase1ToolSchemas: vi.fn(() => []),
            setEmailContext: vi.fn(),
        };
        const orch = new AgentOrchestrator(
            {
                primaryCurrency: "SGD",
                secondaryCurrency: "MYR",
                primaryBudgetFile: "budget-sgd",
                secondaryBudgetFile: "budget-myr",
                llmProvider: "deepseek",
                llmApiKey: "test",
                deepseekApiKey: "test",
            },
            tools,
        );
        orch._llm.chat = vi.fn();

        const phase1 = await orch._runPhase1(UNREFERENCED_DEPOSIT, {
            senderBank: "OCBC",
            receivedAt: "2026-09-19T01:31:20.000Z",
        });
        const phase2 = await orch._resolvePhase2(phase1);
        await orch._executePhase3(phase2);

        expect(calls.some((c) => c.name === "insert_transaction")).toBe(true);
    });

    it("books an unscheduled merchant row despite a matching schedule", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const calls = [];
        const tools = {
            executeTool: vi.fn(async (name, args) => {
                calls.push({ name, args });
                if (name === "fetch_context")
                    return {
                        accounts: [{ id: "ocbc-360", name: "OCBC 360", closed: false }],
                        categories: [],
                        payees: [],
                    };
                if (name === "search_memory") return { results: [] };
                if (name === "check_duplicate") return false;
                if (name === "check_schedule_collision") return true;
                return true;
            }),
            getPhase1ToolSchemas: vi.fn(() => []),
            setEmailContext: vi.fn(),
        };
        const orch = new AgentOrchestrator(
            {
                primaryCurrency: "SGD",
                secondaryCurrency: "MYR",
                primaryBudgetFile: "budget-sgd",
                secondaryBudgetFile: "budget-myr",
                llmProvider: "deepseek",
                llmApiKey: "test",
                deepseekApiKey: "test",
            },
            tools,
        );

        await orch._executePhase3({
            action: "insert",
            account_id: "ocbc-360",
            account_name: "OCBC 360",
            payee_name: "Misc",
            amount_cents: -300600,
            date: "2026-09-19",
            currency: "SGD",
            budget_id: "budget-sgd",
            merchant: "Some Merchant",
            category_id: null,
        });

        // An outgoing merchant charge is never the schedule's credit leg.
        expect(calls.some((c) => c.name === "check_schedule_collision")).toBe(false);
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(true);
    });
});
