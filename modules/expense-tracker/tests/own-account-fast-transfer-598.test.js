/**
 * Regression coverage for issue #598: one own-account FAST transfer
 * (OCBC 360 -> POSB Cashback, SGD 1,000.00, 2026-09-23) produced TWO separate
 * `Misc` rows with no category, one on each leg, instead of one transfer pair.
 *
 * Both alert bodies below are the production bodies verbatim: the only edits
 * are the account holder's legal name -> "ACCOUNT HOLDER", and the statement
 * password mnemonic is dropped from the legal-name fact. Amounts, dates, times,
 * reference numbers, suffixes, and product names are retained — they are what
 * resolution keys on, and they are not secret.
 *
 * The load-bearing detail is the reference: the OCBC ref `2609230000266880`
 * appears inside the DBS ref `012609230000266880EPS6064508` as its middle
 * segment, which is the only identity the two alerts share.
 */
import { describe, expect, it, vi } from "vitest";
import { parseBankMovement } from "../src/bank-movement.js";

// ── Production bodies ───────────────────────────────────────────

/** Email uid 943 — OCBC "We have processed your funds transfer request". */
const OCBC_TRANSFER_REQUEST = `Dear Valued Customer

We have received your request to make the following transfer:

Date of Transfer   : 23 Sep 2026
Time of Transfer   : 12.36 AM SGT
Amount             : SGD 1000.00
From your account  : 360 Account (-166600)
To account         : Darren POSB (-155500) at DBS BANK LTD
Reference number   : 2609230000266880
`;

/** Email uid 942 — DBS "digibank Alerts - You've received a transfer". */
const DBS_RECEIVED_TRANSFER = `Transaction Ref: 012609230000266880EPS6064508

Dear Customer,

You have received SGD 1000.00 via FAST transfer on 23 Sep 2026 00:36  SGT.
From: ACCOUNT HOLDER
To: Your DBS/ POSB account ending 5500
`;

// ── Account 1: the DBS received-transfer sentence ───────────────

describe("DBS received-transfer sentence (#598)", () => {
    it("parses the uid 942 body as an incoming movement", () => {
        const movement = parseBankMovement(DBS_RECEIVED_TRANSFER, {
            senderBank: "DBS",
            receivedAt: "2026-09-22T16:36:44.000Z",
        });

        expect(movement).toMatchObject({
            kind: "bank_movement",
            direction: "incoming",
            amount_cents: 100000,
            currency: "SGD",
            occurred_at: "2026-09-23T00:36:00+08:00",
            own_account: { bank: "DBS", suffix: "5500" },
            counterparty: { name: "ACCOUNT HOLDER", suffix: null },
        });
        // The reference is what ties this leg to the OCBC request.
        expect(movement.reference_number).toBe("012609230000266880EPS6064508");
    });

    it("reads the bare `ending 5500` form without a masked or bracketed suffix", () => {
        const movement = parseBankMovement(
            `Transaction Ref: 012609230000266880EPS6064508

You have received SGD 42.50 via FAST transfer on 1 Oct 2026 09:15 SGT.
From: SOMEONE ELSE
To: Your DBS/ POSB account ending 1234
`,
            { senderBank: "DBS", receivedAt: "2026-10-01T01:15:30.000Z" },
        );

        expect(movement).toMatchObject({
            direction: "incoming",
            amount_cents: 4250,
            own_account: { bank: "DBS", suffix: "1234" },
            counterparty: { name: "SOMEONE ELSE" },
        });
    });

    it("invents no counterparty when the From line is absent", () => {
        const movement = parseBankMovement(
            `You have received SGD 7.00 via FAST transfer on 1 Oct 2026 09:15 SGT.
To: Your DBS/ POSB account ending 1234
`,
            { senderBank: "DBS", receivedAt: "2026-10-01T01:15:30.000Z" },
        );

        expect(movement).toMatchObject({
            direction: "incoming",
            amount_cents: 700,
            counterparty: null,
        });
    });
});

// ── Account 2: the OCBC destination resolves ────────────────────

describe("OCBC transfer-request destination resolution (#598)", () => {
    it("keeps the parenthesised (-155500) destination suffix", () => {
        const movement = parseBankMovement(OCBC_TRANSFER_REQUEST, {
            senderBank: "OCBC",
            receivedAt: "2026-09-22T16:36:43.000Z",
        });

        expect(movement).toMatchObject({
            direction: "outgoing",
            amount_cents: -100000,
            own_account: { bank: "OCBC", suffix: "166600" },
            counterparty: { name: "Darren POSB", bank: "DBS", suffix: "155500" },
            reference_number: "2609230000266880",
        });
    });
});

// ── The two legs reconcile into one transfer pair ───────────────

describe("the two legs become one transfer pair (#598)", () => {
    /**
     * The live account set at the time of the incident: OCBC 360 (the source)
     * and POSB Cashback (the destination). Both carry an Actual transfer payee,
     * which is what lets a leg be booked as a transfer at all.
     */
    const accounts = [
        { id: "ocbc-360", name: "OCBC 360", closed: false },
        { id: "posb-cashback", name: "POSB Cashback", closed: false },
        { id: "sc-bonus", name: "SC Bonus Saver", closed: false },
    ];
    const payees = [
        { id: "p-ocbc", name: "OCBC 360", transfer_acct: "ocbc-360" },
        { id: "p-posb", name: "POSB Cashback", transfer_acct: "posb-cashback" },
        { id: "p-sc", name: "SC Bonus Saver", transfer_acct: "sc-bonus" },
    ];
    // 5500 is POSB Cashback's own suffix, learned from this very alert; the
    // alias names the "Darren POSB" product the OCBC alert writes.
    const facts = [
        { text: "Account ending 166600 belongs to OCBC 360", score: 1 },
        { text: "Account ending 5500 belongs to POSB Cashback", score: 1 },
        { text: "Darren POSB is a POSB Cashback account", score: 1 },
        { text: "Legal name: ACCOUNT HOLDER", score: 1 },
    ];

    async function orchestrate(body, { senderBank, receivedAt, extraCalls = [] } = {}) {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const calls = [];
        const tools = {
            executeTool: vi.fn(async (name, args) => {
                calls.push({ name, args });
                if (name === "fetch_context")
                    return { accounts, categories: [], payees };
                if (name === "search_memory") return { results: facts };
                if (name === "check_duplicate") return false;
                if (name === "check_schedule_collision") return false;
                for (const extra of extraCalls) {
                    const result = extra(name, args);
                    if (result !== undefined) return result;
                }
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
                llmApiKey: "sk-test",
                deepseekApiKey: "sk-test",
            },
            tools,
        );
        orch._llm.chat = vi.fn();
        const phase1 = await orch._runPhase1(body, { senderBank, receivedAt });
        const phase2 = await orch._resolvePhase2(phase1);
        const result = await orch._executePhase3(phase2);
        return { phase1, phase2, result, calls, llm: orch._llm.chat };
    }

    it("holds the uid 942 DBS credit rather than inventing income or a source account", async () => {
        const { phase2, calls } = await orchestrate(DBS_RECEIVED_TRANSFER, {
            senderBank: "DBS",
            receivedAt: "2026-09-22T16:36:44.000Z",
        });

        // Credited account is POSB Cashback (from the DBS "ending 5500" mask).
        expect(phase2.account_id).toBe("posb-cashback");
        expect(phase2.amount_cents).toBe(100000);
        // The DBS notice names only the SENDER'S NAME, never which of the
        // holder's accounts sent it, so the sending leg cannot be identified
        // from this email alone: the credit is held as Misc with no category,
        // not booked as income and not guessed at (issue #584 / #598).
        expect(phase2.payee_name).toBe("Misc");
        expect(phase2.category_id).toBeNull();
        expect(phase2._is_transfer).toBeUndefined();
        expect(phase2._hold_unresolved_transfer).toBe(true);
        // No merchant lookup ran for the person name, and no expense was booked.
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
        // The reference still ties this leg to the OCBC request.
        expect(phase2.notes).toBe("Statement: 012609230000266880EPS6064508");
    });

    it("books the uid 943 OCBC request as the outgoing half of the same transfer", async () => {
        const { phase2 } = await orchestrate(OCBC_TRANSFER_REQUEST, {
            senderBank: "OCBC",
            receivedAt: "2026-09-22T16:36:43.000Z",
        });

        expect(phase2).toMatchObject({
            account_id: "ocbc-360",
            amount_cents: -100000,
            payee_name: "POSB Cashback",
            category_id: null,
            _is_transfer: true,
            _transfer: {
                source_account_id: "ocbc-360",
                destination_account_id: "posb-cashback",
            },
        });
        expect(phase2._hold_unresolved_transfer).toBeUndefined();
    });

    it("learns the (-155500) destination mapping, so the next alert resolves without help", async () => {
        const { phase2 } = await orchestrate(OCBC_TRANSFER_REQUEST, {
            senderBank: "OCBC",
            receivedAt: "2026-09-22T16:36:43.000Z",
        });

        // Only the DESTINATION suffix is new ground truth: 166600 is already a
        // stored fact, so it is not re-learned, while 155500 is not.
        expect(phase2._suffix_mappings).toEqual([
            { suffix: "155500", accountName: "POSB Cashback" },
        ]);
        // And the fact is written in the canonical grammar the readers parse.
        const learned = phase2._suffix_mappings.map(
            (m) => `Account ending ${m.suffix} belongs to ${m.accountName}`,
        );
        expect(learned).toEqual(["Account ending 155500 belongs to POSB Cashback"]);
    });

    it("holds the leg when the destination cannot be resolved into an own account", async () => {
        // Same OCBC alert, but the destination alias is gone: the leg must hold
        // as Misc with no category rather than book a phantom expense (#592).
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const calls = [];
        const tools = {
            executeTool: vi.fn(async (name) => {
                calls.push(name);
                if (name === "fetch_context")
                    return { accounts: [accounts[0]], categories: [], payees: [payees[0]] };
                if (name === "search_memory")
                    return {
                        results: [
                            { text: "Account ending 166600 belongs to OCBC 360", score: 1 },
                            { text: "Legal name: ACCOUNT HOLDER", score: 1 },
                        ],
                    };
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
                llmApiKey: "sk-test",
                deepseekApiKey: "sk-test",
            },
            tools,
        );
        orch._llm.chat = vi.fn();
        const phase1 = await orch._runPhase1(OCBC_TRANSFER_REQUEST, {
            senderBank: "OCBC",
            receivedAt: "2026-09-22T16:36:43.000Z",
        });
        const phase2 = await orch._resolvePhase2(phase1);

        expect(phase2._is_transfer).toBeUndefined();
        expect(phase2.payee_name).toBe("Misc");
        expect(phase2.category_id).toBeNull();
        expect(phase2._hold_unresolved_transfer).toBe(true);
    });
});

// ── AC-3: the two already-booked rows become one pair ───────────

describe("books the pair and links the existing row on the far side (#598)", () => {
    /**
     * The production incident: BOTH legs were already separate `Misc` rows when
     * the second alert was processed, so the fix has to join two rows that
     * already exist instead of only booking its own half.
     */
    const accounts = [
        { id: "ocbc-360", name: "OCBC 360", closed: false },
        { id: "posb-cashback", name: "POSB Cashback", closed: false },
    ];
    const payees = [
        { id: "p-ocbc", name: "OCBC 360", transfer_acct: "ocbc-360" },
        { id: "p-posb", name: "POSB Cashback", transfer_acct: "posb-cashback" },
        { id: "p-misc", name: "Misc", transfer_acct: null },
    ];
    const facts = [
        { text: "Account ending 166600 belongs to OCBC 360", score: 1 },
        { text: "Account ending 5500 belongs to POSB Cashback", score: 1 },
        { text: "Darren POSB is a POSB Cashback account", score: 1 },
    ];
    // Both rows as Actual holds them in the incident.
    const OUTGOING_ROW = "cb446e1b-d5ea-4e55-9d03-ad6e8d681f57";
    const INCOMING_ROW = "fc63bac4-6f08-46a6-989a-f28997bbde51";

    async function run(body, { candidate, matches = "auto", senderBank, receivedAt }) {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const calls = [];
        // Rows as Actual would hold them, and the WIRE body each insert produced.
        // The distinction matters: the orchestrator-supplied args are not what
        // Actual sees. `insert_transaction` re-derives a payee from
        // `imported_description` when no explicit id is given, so the body can
        // carry a transfer payee even when `args.payee_id` is undefined — the
        // exact hole that let a green suite ship a broken fix twice (#598 R2-H1).
        const rows = new Map();
        const wires = [];
        let inserts = 0;
        // The pre-existing far row, exactly as the incident held it: the POSB
        // credit already booked as an ordinary uncategorised `Misc` row.
        rows.set(INCOMING_ROW, {
            id: INCOMING_ROW,
            account: "posb-cashback",
            amount: 100000,
            payee: "p-misc",
            transfer_id: null,
            cleared: false,
        });
        // Mirrors `_handle_insert_transaction`: an explicit id wins, otherwise
        // the imported description is resolved against the live payee list.
        const resolveWirePayee = (args) => {
            if (args.suppress_transfer_payee) return { payee: null, name: "Misc" };
            if (args.payee_id) return { payee: args.payee_id, name: null };
            const named = payees.find((p) => p.name === args.imported_description);
            return { payee: named ? named.id : null, name: args.imported_description };
        };
        const tools = {
            executeTool: vi.fn(async (name, args) => {
                calls.push({ name, args });
                if (name === "fetch_context")
                    return { accounts, categories: [], payees };
                if (name === "search_memory") return { results: facts };
                if (name === "check_duplicate") return false;
                if (name === "check_schedule_collision") return false;
                if (name === "find_link_candidate" && args.account_id === "posb-cashback")
                    return {
                        candidate,
                        matches:
                            matches === "auto" ? (candidate ? 1 : 0) : matches,
                    };
                if (name === "insert_transaction") {
                    inserts += 1;
                    const id = inserts === 1 ? OUTGOING_ROW : `inserted-${inserts}`;
                    const wire = resolveWirePayee(args);
                    wires.push({ id, ...wire, account: args.account_id });
                    rows.set(id, {
                        id,
                        account: args.account_id,
                        amount: args.amount_cents,
                        payee: wire.payee,
                        transfer_id: null,
                    });
                    // Actual's route runs addTransactions(..., {runTransfers:true}):
                    // a TRANSFER payee on the wire makes the engine create the
                    // counterpart and link the row itself.
                    const wirePayee = payees.find((p) => p.id === wire.payee);
                    if (wirePayee?.transfer_acct) {
                        const counterpart = `counterpart-${rows.size}`;
                        rows.set(counterpart, {
                            id: counterpart,
                            account: wirePayee.transfer_acct,
                            amount: -args.amount_cents,
                            payee: null,
                            transfer_id: id,
                        });
                        rows.get(id).transfer_id = counterpart;
                    }
                    return { id, error: null };
                }
                if (name === "reserve_transfer")
                    return { status: "reserved", entry: { id: 1 } };
                if (name === "complete_transfer") return true;
                if (name === "link_transfer_pair") {
                    // The route rejects a leg that is already inside a transfer.
                    const out = rows.get(args.outgoing_id);
                    const inc = rows.get(args.incoming_id);
                    if (!out || !inc) return { error: "Transaction not found" };
                    if (out.transfer_id || inc.transfer_id)
                        return { error: "Transaction is already part of a transfer" };
                    out.transfer_id = inc.id;
                    inc.transfer_id = out.id;
                    out.payee = "p-ocbc";
                    inc.payee = "p-posb";
                    return { status: "linked" };
                }
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
                llmApiKey: "sk-test",
                deepseekApiKey: "sk-test",
            },
            tools,
        );
        orch._llm.chat = vi.fn();
        const phase1 = await orch._runPhase1(body, { senderBank, receivedAt });
        const phase2 = await orch._resolvePhase2(phase1);
        const result = await orch._executePhase3(phase2);
        return { phase1, phase2, result, calls, wires, rows };
    }

    it("links the OCBC leg to the exact POSB row it matches, without inserting a second row", async () => {
        const { calls, result, wires, rows } = await run(OCBC_TRANSFER_REQUEST, {
            candidate: { id: INCOMING_ROW, account_id: "posb-cashback" },
            senderBank: "OCBC",
            receivedAt: "2026-09-22T16:36:43.000Z",
        });

        const link = calls.find((c) => c.name === "link_transfer_pair");
        expect(link.args).toEqual({
            budget_id: "budget-sgd",
            outgoing_id: OUTGOING_ROW,
            incoming_id: INCOMING_ROW,
        });
        // The candidate lookup ran against the far account, not the booked one.
        const find = calls.find((c) => c.name === "find_link_candidate");
        expect(find.args).toMatchObject({
            account_id: "posb-cashback",
            amount_cents: -100000,
            on_date: "2026-09-23",
        });
        // The regression this suite exists for, asserted on the WIRE rather than
        // on the args: no transfer payee may reach Actual, or `runTransfers`
        // creates a counterpart of its own, the route then refuses the already
        // linked near leg, and the incident ends with three rows instead of two.
        const transferPayeeIds = payees
            .filter((p) => p.transfer_acct)
            .map((p) => p.id);
        for (const wire of wires) {
            expect(transferPayeeIds).not.toContain(wire.payee);
        }
        // Exactly one row per leg: the pre-existing POSB row plus the new OCBC
        // row. A third row means a duplicate counterpart was created.
        expect(rows.size).toBe(2);
        expect([...rows.values()].filter((r) => r.account === "posb-cashback")).toHaveLength(1);
        expect(result.action).not.toBe("notified");
    });

    it("books nothing and reserves nothing when the far side is ambiguous", async () => {
        // Several rows could be the far leg: writing either one is a guess, and
        // inserting the near leg would create a counterpart and orphan them all.
        const { calls, result } = await run(OCBC_TRANSFER_REQUEST, {
            candidate: null,
            matches: 2,
            senderBank: "OCBC",
            receivedAt: "2026-09-22T16:36:43.000Z",
        });

        expect(calls.some((c) => c.name === "link_transfer_pair")).toBe(false);
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
        expect(calls.some((c) => c.name === "reserve_transfer")).toBe(false);
        expect(calls.some(
            (c) => c.name === "notify_user" && /more than one uncleared row/.test(c.args.message),
        )).toBe(true);
        expect(result.action).toBe("notified");
    });

    it("books nothing and reserves nothing when the far account cannot be read", async () => {
        // An unreadable far side is not an absent one: booking would risk the
        // duplicate counterpart this fix removes. Nothing may be reserved
        // either, or the transfer goes `pending` and every later alert is
        // short-circuited before the read runs again (#598 review round 2).
        const { calls, result } = await run(OCBC_TRANSFER_REQUEST, {
            candidate: null,
            matches: null,
            senderBank: "OCBC",
            receivedAt: "2026-09-22T16:36:43.000Z",
        });

        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
        expect(calls.some((c) => c.name === "link_transfer_pair")).toBe(false);
        expect(calls.some((c) => c.name === "reserve_transfer")).toBe(false);
        expect(result.action).toBe("notified");
    });

    it("inserts normally when no far side exists yet", async () => {
        // The ordinary case: the alert arrives first, so the row goes in with
        // its transfer payee and Actual creates the counterpart as before.
        const { calls, wires } = await run(OCBC_TRANSFER_REQUEST, {
            candidate: null,
            matches: 0,
            senderBank: "OCBC",
            receivedAt: "2026-09-22T16:36:43.000Z",
        });

        const insert = calls.find((c) => c.name === "insert_transaction");
        expect(insert.args.payee_id).toBe("p-posb");
        expect(insert.args.suppress_transfer_payee).toBeUndefined();
        // The counterpart still gets created on this path — the suppression is
        // only for the far-side-found case.
        expect(wires[0].payee).toBe("p-posb");
        expect(calls.some((c) => c.name === "link_transfer_pair")).toBe(false);
    });
});

// ── The suppression, on the real handler ────────────────────────

describe("insert_transaction suppresses the derived transfer payee (#598)", () => {
    /**
     * The regression that shipped a broken fix twice: clearing `payee_id` at
     * the call site is not enough, because the real handler re-derives a payee
     * from `imported_description` and would put the destination's transfer payee
     * on the wire anyway. These tests drive the real `ToolRegistry`, so the
     * suppression has to exist in `tools.js` — a mock cannot fake it.
     */
    async function registry(posted = []) {
        const { Config } = await import("../src/config.js");
        const { ToolRegistry } = await import("../src/tools.js");
        const cfg = new Config({
            DEEPSEEK_API_KEY: "sk-test",
            ACTUAL_BUDGET_URL: "http://test:5006",
            ACTUAL_BUDGET_PASSWORD: "pw",
            ACTUAL_PRIMARY_BUDGET_FILE: "test-budget",
            DEDUP_DB_PATH: ":memory:",
        });
        const reg = new ToolRegistry(cfg);
        reg._get = vi.fn(async (path) => {
            if (path === "/payees")
                return [
                    { id: "p-posb", name: "POSB Cashback", transfer_acct: "posb-cashback" },
                    { id: "p-misc", name: "Misc", transfer_acct: null },
                ];
            if (path === "/accounts")
                return [
                    { id: "ocbc-360", name: "OCBC 360", closed: false },
                    { id: "posb-cashback", name: "POSB Cashback", closed: false },
                ];
            return [];
        });
        reg._post = vi.fn(async (path, body) => {
            posted.push({ path, body });
            return { id: "actual-row-1" };
        });
        return reg;
    }

    it("sends no transfer payee when the far side was already found", async () => {
        const posted = [];
        const reg = await registry(posted);

        const result = await reg.executeTool("insert_transaction", {
            budget_id: "budget-sgd",
            account_id: "ocbc-360",
            date: "2026-09-23",
            amount_cents: -100000,
            imported_description: "POSB Cashback",
            suppress_transfer_payee: true,
        });

        expect(result.error).toBeUndefined();
        const body = posted.find((p) => p.path === "/transactions").body;
        expect(body.payee).toBeUndefined();
        // Without the flag the same call WOULD carry the derived transfer payee.
        expect(body.payee_name).toBe("Misc");
    });

    it("still derives the transfer payee when the far side was not found", async () => {
        const posted = [];
        const reg = await registry(posted);

        await reg.executeTool("insert_transaction", {
            budget_id: "budget-sgd",
            account_id: "ocbc-360",
            date: "2026-09-23",
            amount_cents: -100000,
            imported_description: "POSB Cashback",
        });

        const body = posted.find((p) => p.path === "/transactions").body;
        // The ordinary path keeps its behaviour: the imported description
        // resolves to the destination's transfer payee, and Actual books the
        // counterpart itself.
        expect(body.payee).toBe("p-posb");
    });
});

// ── The Actual-side link ────────────────────────────────────────

describe("link_transfer_pair reaches the actual-api link route (#598)", () => {
    async function registry() {
        const { Config } = await import("../src/config.js");
        const { ToolRegistry } = await import("../src/tools.js");
        const cfg = new Config({
            DEEPSEEK_API_KEY: "sk-test",
            ACTUAL_BUDGET_URL: "http://test:5006",
            ACTUAL_BUDGET_PASSWORD: "pw",
            ACTUAL_PRIMARY_BUDGET_FILE: "test-budget",
            DEDUP_DB_PATH: ":memory:",
        });
        return new ToolRegistry(cfg);
    }

    it("posts both leg ids to /transactions/link-transfer", async () => {
        const reg = await registry();
        const posted = [];
        reg._post = vi.fn(async (path, body) => {
            posted.push({ path, body });
            return { status: "linked" };
        });

        const result = await reg.executeTool("link_transfer_pair", {
            budget_id: "budget-sgd",
            outgoing_id: "cb446e1b-d5ea-4e55-9d03-ad6e8d681f57",
            incoming_id: "fc63bac4-6f08-46a6-989a-f28997bbde51",
        });

        expect(posted).toEqual([
            {
                path: "/transactions/link-transfer",
                body: {
                    budget_id: "budget-sgd",
                    outgoing_id: "cb446e1b-d5ea-4e55-9d03-ad6e8d681f57",
                    incoming_id: "fc63bac4-6f08-46a6-989a-f28997bbde51",
                },
            },
        ]);
        expect(result).toMatchObject({ status: "linked" });
    });

    it("refuses when a leg id is missing rather than posting a half pair", async () => {
        const reg = await registry();
        reg._post = vi.fn();

        const result = await reg.executeTool("link_transfer_pair", {
            budget_id: "budget-sgd",
            outgoing_id: "cb446e1b-d5ea-4e55-9d03-ad6e8d681f57",
        });

        expect(reg._post).not.toHaveBeenCalled();
        expect(result.error).toMatch(/incoming_id/);
    });

    it("surfaces a route failure as an error instead of claiming a link", async () => {
        const reg = await registry();
        reg._post = vi.fn(async () => {
            throw new Error("actual-api 400 {\"error\":\"Transaction not found\"}");
        });

        const result = await reg.executeTool("link_transfer_pair", {
            budget_id: "budget-sgd",
            outgoing_id: "cb446e1b-d5ea-4e55-9d03-ad6e8d681f57",
            incoming_id: "fc63bac4-6f08-46a6-989a-f28997bbde51",
        });

        expect(result.error).toMatch(/Transaction not found/);
        expect(result.status).toBeUndefined();
    });
});
