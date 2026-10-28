/**
 * Person transfers the owner's people-transfers page names were held instead of
 * booked (production replay, 2026-10-28). Three shapes, all synthetic here:
 *   - a DBS FAST transfer whose "To:" ran into the email footer, to an account
 *     ending the holder no longer tracks;
 *   - an OCBC PayNow to a mobile number, whose masked phone digits were read as
 *     an account suffix;
 *   - a Ryt credit from a remembered sender, dropped for want of an incoming
 *     person arm (the #654 boundary).
 */
import { describe, expect, it, vi } from "vitest";
import { parseBankMovement } from "../src/bank-movement.js";

const DBS_FAST_FOOTER = "Email-Sender: DBS <ibanking.alert@dbs.com>\nSubject: iBanking Alerts\n\nTransaction Ref: 17899237848838872763Dear Customer,We refer to your FAST Interbank Funds Transfer transaction dated 21 Sep. We are pleased to confirm that the transaction was completed. Date & Time: 21 Sep 00:29 (SGT) Amount: SGD55.89 From: POSB Cashback A/C ending 5500 To: ALEX SC A/C ending 2555 If unauthorised, please call our DBS hotline. To view transaction details, please log in to digibank. DBS Bank Ltd Co. Reg. No.: 196800306E";

const OCBC_PAYNOW_MOBILE = "Email-Sender: OCBC <notifications@ocbc.com>\nSubject: PayNow transfer made\n\nDear Valued Customer The following PayNow transfer has been made to LEE WEI LING using his/her Mobile (+******1234).Date: 17 Oct 2026Time: 13:10 PM SGT Amount: SGD 30.00From your account: 360 Account (-123456)Description: giftReference number: 1234567890123456If you have any queries, please contact our Personal Banking hotline";

const RYT_RECEIVED_FROM_PERSON = "Hi Alex,\n\nMoney's in! You've received RM88.00 from LEE WEI LING on 18/9/2026, 5:04 AM (GMT+8) using your\nMain Account.\n\nNeed help? Reach out to our Help & Support Centre.";

describe("parser: person transfer names", () => {
    it("ends a DBS FAST destination name at its `A/C ending` token", () => {
        const movement = parseBankMovement(DBS_FAST_FOOTER, { senderBank: "DBS", receivedAt: "2026-09-21T00:00:00Z" });
        expect(movement.counterparty).toMatchObject({ name: "ALEX SC", suffix: "2555" });
        expect(movement.own_account).toMatchObject({ name: "POSB Cashback", suffix: "5500" });
    });

    it("reads a PayNow mobile recipient as a person with no account suffix", () => {
        const movement = parseBankMovement(OCBC_PAYNOW_MOBILE, { senderBank: "OCBC", receivedAt: "2026-10-17T00:00:00Z" });
        expect(movement.counterparty).toMatchObject({ name: "LEE WEI LING", suffix: null });
        expect(movement.person_transfer).toBe(true);
    });

    it("ends an OCBC reference at its digits when the footer runs into it", () => {
        const movement = parseBankMovement(OCBC_PAYNOW_MOBILE, { senderBank: "OCBC", receivedAt: "2026-10-17T00:00:00Z" });
        expect(movement.reference_number).toBe("1234567890123456");
        expect(movement.raw_merchant_descriptor).toBe("gift");
    });
});

const CATEGORIES = [{ id: "cat-family", name: "Family Support" }];

describe("booking person transfers the owner named", () => {
    async function orchestrate(body, { senderBank, receivedAt, accounts, payees = [], listFacts = [], searchFacts = [] }) {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const calls = [];
        const tools = {
            executeTool: vi.fn(async (name, args) => {
                calls.push({ name, args });
                if (name === "fetch_context") return { accounts, categories: CATEGORIES, payees };
                if (name === "fetch_categories") return CATEGORIES;
                if (name === "search_memory") return { results: searchFacts.map((text) => ({ text })) };
                if (name === "list_facts") return { facts: listFacts };
                if (name === "check_duplicate") return false;
                if (name === "check_schedule_collision") return false;
                if (name === "find_link_candidate") return { candidate: null, matches: 0 };
                if (name === "insert_transaction") return { id: "booked-1" };
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
        const phase2 = phase1 ? await orch._resolvePhase2(phase1) : null;
        const result = phase2 ? await orch._executePhase3(phase2) : null;
        return { phase1, phase2, result, calls, llm: orch._llm.chat };
    }
    const insertOf = (calls) => calls.find((c) => c.name === "insert_transaction")?.args;
    const searched = (calls) => calls.some((c) => c.name === "search_web" || c.name === "resolve_merchant");

    // The SC account the suffix fact names is closed, so the transfer has no
    // live destination.
    const dbsAccounts = [
        { id: "posb-cashback", name: "POSB Cashback", closed: false },
        { id: "sc-old", name: "SC Bonus Saver", closed: true },
    ];
    const dbsFacts = ["Account ending 5500 belongs to POSB Cashback", "Account ending 2555 belongs to SC Bonus Saver"];

    it("books a DBS transfer to a named descriptor with the owner's payee", async () => {
        const { phase2, calls } = await orchestrate(DBS_FAST_FOOTER, {
            senderBank: "DBS",
            receivedAt: "2026-09-20T16:29:00Z",
            accounts: dbsAccounts,
            searchFacts: dbsFacts,
            listFacts: [...dbsFacts, "ALEX SC maps to Friend Gifts payee"],
        });
        expect(phase2._hold_unresolved_transfer).toBeUndefined();
        expect(insertOf(calls)).toMatchObject({ account_id: "posb-cashback", amount_cents: -5589, imported_description: "Friend Gifts" });
        expect(searched(calls)).toBe(false);
    });

    it("still holds that DBS transfer when no row names the descriptor", async () => {
        const { phase2, calls } = await orchestrate(DBS_FAST_FOOTER, {
            senderBank: "DBS",
            receivedAt: "2026-09-20T16:29:00Z",
            accounts: dbsAccounts,
            searchFacts: dbsFacts,
            listFacts: dbsFacts,
        });
        expect(phase2._hold_cause).toBe("destination_unresolved");
        expect(insertOf(calls)).toBeUndefined();
    });

    const ocbcAccounts = [{ id: "ocbc-360", name: "OCBC 360", closed: false }];
    const ocbcFacts = ["Account ending 123456 belongs to OCBC 360"];

    it("books a PayNow to a remembered mobile recipient with the owner's payee", async () => {
        const { phase2, calls } = await orchestrate(OCBC_PAYNOW_MOBILE, {
            senderBank: "OCBC",
            receivedAt: "2026-10-17T05:10:00Z",
            accounts: ocbcAccounts,
            searchFacts: ocbcFacts,
            listFacts: [...ocbcFacts, "LEE WEI LING maps to Misc payee"],
        });
        expect(phase2._hold_unresolved_transfer).toBeUndefined();
        expect(insertOf(calls)).toMatchObject({ account_id: "ocbc-360", amount_cents: -3000, imported_description: "Misc" });
        expect(insertOf(calls).notes).not.toMatch(/queries|hotline/i);
        expect(searched(calls)).toBe(false);
    });

    it("holds a PayNow to an unremembered mobile recipient as an unverified person", async () => {
        const { phase2, calls } = await orchestrate(OCBC_PAYNOW_MOBILE, {
            senderBank: "OCBC",
            receivedAt: "2026-10-17T05:10:00Z",
            accounts: ocbcAccounts,
            searchFacts: ocbcFacts,
            listFacts: ocbcFacts,
        });
        expect(phase2._hold_cause).toBe("person_identity_unverified");
        expect(insertOf(calls)).toBeUndefined();
        expect(searched(calls)).toBe(false);
    });

    it("books a Ryt credit from a remembered sender with the owner's payee and category (#654)", async () => {
        const { phase2, calls } = await orchestrate(RYT_RECEIVED_FROM_PERSON, {
            senderBank: "Ryt",
            receivedAt: "2026-09-17T21:04:00Z",
            accounts: [{ id: "ryt-bank", name: "Ryt Bank", closed: false }],
            searchFacts: ["LEE WEI LING maps to Family Support category"],
            listFacts: ["LEE WEI LING maps to Family Support payee", "LEE WEI LING maps to Family Support category"],
        });
        expect(phase2._hold_unresolved_transfer).toBeUndefined();
        expect(insertOf(calls)).toMatchObject({ account_id: "ryt-bank", amount_cents: 8800, imported_description: "Family Support", category_id: "cat-family" });
        expect(searched(calls)).toBe(false);
    });
});
