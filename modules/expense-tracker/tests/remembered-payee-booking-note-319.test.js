/**
 * #319: a booking that relied on a remembered mapping names the mapping in
 * its notes, so the row carries its own provenance. Three shapes, all
 * synthetic here:
 *   - an outgoing DBS FAST transfer whose payee the owner's people-transfers
 *     row names (payee_source "memory");
 *   - an outgoing DBS FAST transfer whose destination a stored suffix fact
 *     resolved (an internal transfer between two live accounts);
 *   - an incoming Ryt credit whose sender-and-amount rule names the payee
 *     (payee_source "incoming_rule").
 * The note tests are RED at base (no `Remembered:` line exists yet); the
 * hold/book-direct tests are guards for the read side, which already works.
 */
import { describe, expect, it, vi } from "vitest";

const DBS_FAST_FOOTER = "Email-Sender: DBS <ibanking.alert@dbs.com>\nSubject: iBanking Alerts\n\nTransaction Ref: 17899237848838872763Dear Customer,We refer to your FAST Interbank Funds Transfer transaction dated 21 Sep. We are pleased to confirm that the transaction was completed. Date & Time: 21 Sep 00:29 (SGT) Amount: SGD55.89 From: POSB Cashback A/C ending 5500 To: ALEX SC A/C ending 2555 If unauthorised, please call our DBS hotline. To view transaction details, please log in to digibank. DBS Bank Ltd Co. Reg. No.: 196800306E";

const RYT_RECEIVED_FROM_PERSON = "Hi Alex,\n\nMoney's in! You've received RM88.00 from LEE WEI LING on 18/9/2026, 5:04 AM (GMT+8) using your\nMain Account.\n\nNeed help? Reach out to our Help & Support Centre.";

const CATEGORIES = [{ id: "cat-family", name: "Family Support" }];

describe("remembered payee booking note (#319)", () => {
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
    // A "heads-up" is a hold notification ("Held: ..."); the ordinary
    // "logged" line after a successful booking is not one.
    const heldNotices = (calls) => calls.filter((c) => c.name === "notify_user" && String(c.args?.message || "").startsWith("Held:"));

    // The SC account the suffix fact names is closed, so the transfer has no
    // live destination — only the owner's payee row can book it.
    const dbsAccounts = [
        { id: "posb-cashback", name: "POSB Cashback", closed: false },
        { id: "sc-old", name: "SC Bonus Saver", closed: true },
    ];
    const suffixFacts = ["Account ending 5500 belongs to POSB Cashback", "Account ending 2555 belongs to SC Bonus Saver"];

    it("319-note-names-mapping: a remembered payee books with the mapping named in its notes", async () => {
        const { phase2, calls } = await orchestrate(DBS_FAST_FOOTER, {
            senderBank: "DBS",
            receivedAt: "2026-09-20T16:29:00Z",
            accounts: dbsAccounts,
            searchFacts: suffixFacts,
            listFacts: [...suffixFacts, "ALEX SC maps to Friend Gifts payee"],
        });
        expect(phase2.payee_source).toBe("memory");
        expect(phase2.notes).toContain("Remembered: ALEX SC maps to Friend Gifts payee");
        expect(insertOf(calls).notes).toContain("Remembered: ALEX SC maps to Friend Gifts payee");
    });

    // Both legs live, so the suffix fact resolves the destination and the
    // transfer books as an internal transfer (a transfer payee names the leg).
    const dbsLiveAccounts = [
        { id: "posb-cashback", name: "POSB Cashback", closed: false },
        { id: "sc-live", name: "SC Bonus Saver", closed: false },
    ];
    const dbsLivePayees = [{ id: "payee-sc", name: "SC Bonus Saver", transfer_acct: "sc-live" }];

    it("319-suffix-note-names-mapping: a destination resolved via a stored suffix fact books with that mapping named in its notes", async () => {
        const { phase2, calls } = await orchestrate(DBS_FAST_FOOTER, {
            senderBank: "DBS",
            receivedAt: "2026-09-20T16:29:00Z",
            accounts: dbsLiveAccounts,
            payees: dbsLivePayees,
            searchFacts: suffixFacts,
            listFacts: suffixFacts,
        });
        expect(phase2._hold_unresolved_transfer).toBeUndefined();
        expect(phase2._remembered_destination_fact).toBe("Account ending 2555 belongs to SC Bonus Saver");
        expect(phase2.notes).toContain("Remembered: Account ending 2555 belongs to SC Bonus Saver");
        expect(insertOf(calls)).toMatchObject({ account_id: "posb-cashback", imported_description: "SC Bonus Saver" });
        expect(insertOf(calls).notes).toContain("Remembered: Account ending 2555 belongs to SC Bonus Saver");
    });

    it("319-remembered-recipient-books-direct: a second identical transfer to the remembered recipient books with no hold and no heads-up", async () => {
        const { phase2, calls } = await orchestrate(DBS_FAST_FOOTER, {
            senderBank: "DBS",
            receivedAt: "2026-09-20T16:29:00Z",
            accounts: dbsAccounts,
            searchFacts: suffixFacts,
            listFacts: [...suffixFacts, "ALEX SC maps to Friend Gifts payee"],
        });
        expect(phase2._hold_unresolved_transfer).toBeUndefined();
        expect(insertOf(calls)).toMatchObject({ account_id: "posb-cashback", amount_cents: -5589, imported_description: "Friend Gifts" });
        expect(heldNotices(calls)).toHaveLength(0);
    });

    it("319-first-time-still-heads-up: an unknown recipient still holds with exactly one heads-up", async () => {
        const { phase2, calls } = await orchestrate(DBS_FAST_FOOTER, {
            senderBank: "DBS",
            receivedAt: "2026-09-20T16:29:00Z",
            accounts: dbsAccounts,
            searchFacts: suffixFacts,
            listFacts: suffixFacts,
        });
        expect(phase2._hold_cause).toBe("destination_unresolved");
        expect(insertOf(calls)).toBeUndefined();
        expect(heldNotices(calls)).toHaveLength(1);
    });

    it("319-destination-fact-resolves: a suffix fact makes the transfer resolve instead of holding", async () => {
        const { phase2, calls } = await orchestrate(DBS_FAST_FOOTER, {
            senderBank: "DBS",
            receivedAt: "2026-09-20T16:29:00Z",
            accounts: dbsLiveAccounts,
            payees: dbsLivePayees,
            searchFacts: suffixFacts,
            listFacts: suffixFacts,
        });
        expect(phase2._hold_unresolved_transfer).toBeUndefined();
        expect(insertOf(calls)).toMatchObject({ account_id: "posb-cashback", amount_cents: -5589, imported_description: "SC Bonus Saver" });
    });

    it("319-incoming-rule-note-names-key: an incoming amount rule books with the rule key named in its notes", async () => {
        const { phase2, calls } = await orchestrate(RYT_RECEIVED_FROM_PERSON, {
            senderBank: "Ryt",
            receivedAt: "2026-09-17T21:04:00Z",
            accounts: [{ id: "ryt-bank", name: "Ryt Bank", closed: false }],
            searchFacts: ["LEE WEI LING maps to Family Support category"],
            listFacts: [
                "LEE WEI LING maps to Family Support payee",
                "Incoming MYR 88.00 from LEE WEI LING maps to Family Support payee",
                "LEE WEI LING maps to Family Support category",
            ],
        });
        expect(phase2.payee_source).toBe("incoming_rule");
        expect(phase2.notes).toContain("Remembered: Incoming MYR 88.00 from LEE WEI LING maps to Family Support payee");
        expect(insertOf(calls)).toMatchObject({ account_id: "ryt-bank", amount_cents: 8800, imported_description: "Family Support" });
        expect(insertOf(calls).notes).toContain("Remembered: Incoming MYR 88.00 from LEE WEI LING maps to Family Support payee");
    });
});
