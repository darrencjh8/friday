import { describe, expect, it, vi } from "vitest";
import {
  identityMappingsFromFacts,
  parseBankMovement,
  resolveMovementAccounts,
} from "../src/bank-movement.js";

const accounts = [
  { id: "ocbc-111", name: "OCBC 111 6600", closed: false },
  { id: "trust-card", name: "Trust Card 2000", closed: false },
  { id: "dbs-vista", name: "Vista 1777", closed: false },
  { id: "citi-card", name: "Citi Points 2666", closed: false },
  { id: "ocbc-visa", name: "OCBC Visa 4400", closed: false },
];

const payees = [
  { id: "transfer-trust", transfer_acct: "trust-card" },
  { id: "transfer-citi", transfer_acct: "citi-card" },
  { id: "transfer-ocbc-visa", transfer_acct: "ocbc-visa" },
];

describe("parseBankMovement", () => {
  it("parses OCBC outgoing transfer without an LLM", () => {
    const movement = parseBankMovement(`
Date of Transfer : 01 Sep 2026
Time of Transfer : 01.06 AM SGT
Amount : SGD 14.25
From your account : 111 Account (-166600)
To account : Example Trust (-222000) at TRUST BANK SINGAPORE LIMITED
Reference number : REF-OCBC-1
`, { senderBank: "OCBC", receivedAt: "2026-09-01T01:07:00+08:00" });

    expect(movement).toMatchObject({
      kind: "bank_movement",
      direction: "outgoing",
      amount_cents: -1425,
      currency: "SGD",
      occurred_at: "2026-09-01T01:06:00+08:00",
      own_account: { bank: "OCBC", suffix: "166600" },
      counterparty: {
        bank: "Trust",
        suffix: "222000",
      },
      reference_number: "REF-OCBC-1",
    });
  });

  it("parses DBS card bill payment without card-product-specific code", () => {
    const movement = parseBankMovement(`
Transaction Ref: REF-DBS-1
Date and Time: 01 Sep 01:05 (SGT)
Amount: SGD 253.37
From: Vista (A/C ending 1777)
To: CITI CREDIT CARDS (Ref ending 2666)
`, { senderBank: "DBS", receivedAt: "2026-09-01T01:06:00+08:00" });

    expect(movement).toMatchObject({
      direction: "outgoing",
      amount_cents: -25337,
      occurred_at: "2026-09-01T01:05:00+08:00",
      own_account: { bank: "DBS", suffix: "1777" },
      counterparty: { bank: "Citi", suffix: "2666" },
      reference_number: "REF-DBS-1",
    });
  });

  it("parses the same DBS card bill payment when the email body is flattened to one line", () => {
    const movement = parseBankMovement(
      "Transaction Ref: REF-DBS-1 Date and Time: 01 Sep 01:05 (SGT) Amount: SGD 253.37 From: Vista (A/C ending 1777) To: CITI CREDIT CARDS (Ref ending 2666)",
      { senderBank: "DBS", receivedAt: "2026-09-01T01:06:00+08:00" },
    );

    expect(movement).toMatchObject({
      direction: "outgoing",
      amount_cents: -25337,
      occurred_at: "2026-09-01T01:05:00+08:00",
      own_account: { bank: "DBS", suffix: "1777" },
      counterparty: { bank: "Citi", suffix: "2666" },
      reference_number: "REF-DBS-1",
    });
  });

  it("parses a flattened OCBC outgoing transfer", () => {
    const movement = parseBankMovement(
      "Date of Transfer : 01 Sep 2026 Time of Transfer : 01.06 AM SGT Amount : SGD 14.25 From your account : 111 Account (-166600) To account : Example Trust (-222000) at TRUST BANK SINGAPORE LIMITED Reference number : REF-OCBC-1",
      { senderBank: "OCBC", receivedAt: "2026-09-01T01:07:00+08:00" },
    );

    expect(movement).toMatchObject({
      direction: "outgoing",
      amount_cents: -1425,
      own_account: { bank: "OCBC", suffix: "166600" },
      counterparty: { bank: "Trust", suffix: "222000" },
      reference_number: "REF-OCBC-1",
    });
  });

  it("parses Trust incoming counterpart", () => {
    const movement = parseBankMovement(
      "Sweet! You have received SGD 14.25 from OverseaChinese Banking Corporation Ltd A/C ending 6600 on 01 Sep 2026 01:06 SGT.",
      { senderBank: "Trust", receivedAt: "2026-09-01T01:07:00+08:00" },
    );

    expect(movement).toMatchObject({
      direction: "incoming",
      amount_cents: 1425,
      occurred_at: "2026-09-01T01:06:00+08:00",
      counterparty: { bank: "OCBC", suffix: "6600" },
    });
  });

  it("parses an OCBC bill payment whose cheerio text glues labels to values", () => {
    // extractEmailContent collapses OCBC's HTML table cells to one line with no
    // separator, so the next label is glued onto the previous value
    // ("2026Time of Payment", "SGTAmount", "4.00From your account").
    const movement = parseBankMovement(
      "Dear Valued CustomerAs you instructed, we have made the following bill payment:Date of Payment:01 Sep 2026Time of Payment:01:05 am SGTAmount:SGD 4.00From your account:111 Account (-166600)To account:OCBC 88.N Visa Card (-344400)Reference number:2609010016084129Billing Organisation may take up to three working days to process payment.",
      { senderBank: "OCBC", receivedAt: "2026-09-01T01:06:00+08:00" },
    );

    expect(movement).toMatchObject({
      direction: "outgoing",
      amount_cents: -400,
      currency: "SGD",
      own_account: { bank: "OCBC", suffix: "166600" },
      counterparty: { bank: "OCBC", suffix: "344400" },
      reference_number: expect.stringContaining("2609010016084129"),
    });
  });

  it("parses a Ryt Bank card payment without an Amount label", () => {
    const movement = parseBankMovement(
      "Hi Customer,\n\nRM200.00 was paid at TNG-EWALLET ECOM 3-EC using your Main Account on 2/9/2026, 12:46 AM (GMT+8).\n\nIf this was not you, give us a call.",
      { senderBank: "Ryt", receivedAt: "2026-09-01T01:00:00+08:00" },
    );

    expect(movement).toMatchObject({
      direction: "outgoing",
      amount_cents: -20000,
      currency: "MYR",
      own_account: { bank: "Ryt", suffix: null },
      merchant_display_name: "TNG-EWALLET ECOM 3-EC",
    });
  });

  it("parses a redacted Ryt merchant payment written as paid to", () => {
    const movement = parseBankMovement(
      "Hi Darren, You've paid RM255.00 to CLINIC MERCHANT on 19/9/2026, 10:50 AM (GMT+8) using your Ryt Credit.",
      { senderBank: "Ryt", receivedAt: "2026-09-19T02:50:21.000Z" },
    );

    expect(movement).toMatchObject({
      direction: "outgoing",
      amount_cents: -25500,
      currency: "MYR",
      occurred_at: "2026-09-19T10:50:00+08:00",
      own_account: { name: "Ryt Credit", bank: "Ryt", suffix: null },
      counterparty: { name: "CLINIC MERCHANT", bank: null, suffix: null },
      merchant_display_name: "CLINIC MERCHANT",
    });
  });

  it("parses a redacted Ryt own-name debit as a movement", () => {
    const movement = parseBankMovement(
      "Hi Darren, You've sent RM100.00 to ACCOUNT HOLDER on 19/9/2026, 12:58 PM (GMT+8) using your Main Account.",
      { senderBank: "Ryt", receivedAt: "2026-09-19T04:58:02.000Z" },
    );

    expect(movement).toMatchObject({
      direction: "outgoing",
      amount_cents: -10000,
      currency: "MYR",
      occurred_at: "2026-09-19T12:58:00+08:00",
      own_account: { name: "Main Account", bank: "Ryt", suffix: null },
      counterparty: { name: "ACCOUNT HOLDER", bank: null, suffix: null },
      merchant_display_name: "ACCOUNT HOLDER",
    });
  });

  it("parses a redacted Ryt own-name credit as a movement", () => {
    const movement = parseBankMovement(
      "Hi Darren, Money's in! You've received RM62.00 from ACCOUNT HOLDER on 18/9/2026, 5:04 AM (GMT+8).",
      { senderBank: "Ryt", receivedAt: "2026-09-17T21:04:10.000Z" },
    );

    expect(movement).toMatchObject({
      direction: "incoming",
      amount_cents: 6200,
      currency: "MYR",
      occurred_at: "2026-09-18T05:04:00+08:00",
      own_account: { bank: "Ryt", suffix: null },
      counterparty: { name: "ACCOUNT HOLDER", bank: null, suffix: null },
    });
  });

  it("parses one-sided OCBC deposit but does not invent a counterparty", () => {
    const movement = parseBankMovement(`
A deposit was made in your account.
Time of deposit : 11:59 PM
Amount : SGD 0.20
Account that money was deposited in : (-166600)
Reference :
`, { senderBank: "OCBC", receivedAt: "2026-09-02T00:05:00+08:00" });

    expect(movement).toMatchObject({
      direction: "incoming",
      amount_cents: 20,
      own_account: { bank: "OCBC", suffix: "166600" },
      counterparty: null,
      occurred_at: "2026-09-01T23:59:00+08:00",
    });
  });

  it("parses a UOB FAST transfer confirmation sentence (no labelled fields)", () => {
    const movement = parseBankMovement(
      "You made/scheduled a funds transfer(s) of SGD 84.50 to OCBC a/c ending 2468 from your a/c ending 1357 at 3:15AM SGT, 12 Aug 26. If unauthorised, call UOB 24/7 Fraud Hotline.",
      { senderBank: "UOB", receivedAt: "2026-08-12T04:00:00+08:00" },
    );

    expect(movement).toMatchObject({
      direction: "outgoing",
      amount_cents: -8450,
      currency: "SGD",
      occurred_at: "2026-08-12T03:15:00+08:00",
      own_account: { bank: "UOB", suffix: "1357" },
      counterparty: { bank: "OCBC", suffix: "2468" },
    });
  });

  it("parses PayNow UEN as external payment, not internal transfer", () => {
    const movement = parseBankMovement(`
The following PayNow transfer has been made to Example LLP using their Unique Entity Number (UEN) UEN123.
Date : 01 Sep 2026
Time : 19:34 PM SGT
Amount : SGD 7.30
From your account : 111 Account (-166600)
Description : UEN123-REFERENCE
`, { senderBank: "OCBC", receivedAt: "2026-09-01T19:35:00+08:00" });

    expect(movement).toMatchObject({
      direction: "outgoing",
      amount_cents: -730,
      own_account: { bank: "OCBC", suffix: "166600" },
      counterparty: null,
      merchant_display_name: "Example LLP",
      raw_merchant_descriptor: "UEN123-REFERENCE",
    });
  });

  it("keeps a personal PayNow recipient for self-identity resolution (#561)", () => {
    const movement = parseBankMovement(`
The following PayNow transfer has been made to TestUser.
Date : 01 Sep 2026
Time : 19:34 PM SGT
Amount : SGD 4.74
From your account : Trust Bank (-166600)
`, { senderBank: "Trust", receivedAt: "2026-09-01T19:35:00+08:00" });

    expect(movement).toMatchObject({
      is_paynow: true,
      counterparty: { name: "TestUser" },
      merchant_display_name: null,
    });
  });

  it("keeps a PayNow credit from an own identity as a transfer, not income (#561)", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name, args) => {
        if (name === "fetch_context") return {
          accounts: [
            { id: "trust", name: "Trust Bank", closed: false },
            { id: "ocbc", name: "OCBC 360 6600", closed: false },
          ],
          categories: [],
          payees: [{ id: "transfer-trust", transfer_acct: "trust" }],
        };
        if (name === "search_memory" && args?.query === "TestUser") {
          return { results: [{ text: "TestUser is a Trust Bank account", score: 1 }] };
        }
        return { results: [] };
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator({
      primaryCurrency: "SGD", secondaryCurrency: "MYR",
      primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
      llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
    }, tools);
    orch._llm.chat = vi.fn();

    const output = await orch._runPhase1(`
PayNow transfer from TestUser
Time of deposit : 19:34 PM SGT
Amount : SGD 4.74
Account that money was deposited in : OCBC 360 (-6600)
`, { senderBank: "OCBC", receivedAt: "2026-09-01T19:35:00+08:00" });

    expect(output).toMatchObject({
      account_id: "ocbc",
      amount_cents: 474,
      category_id: null,
      _is_transfer: true,
      _transfer: {
        source_account_id: "trust",
        destination_account_id: "ocbc",
      },
    });
  });

  it("declines an ordinary card-purchase alert whose 'To:' is a merchant, not an account (issue #398)", () => {
    // Regression test: this DBS "Card Transaction Alert" happens to use
    // generic From:/To:/Amount: labels, but "To: BUS/MRT" is a merchant
    // name, not a destination account (no bank alias, no digit suffix).
    // The generic From/To branch must decline (return null) rather than
    // fabricate a movement with counterparty:null / merchant:null — that
    // silently destroys the real merchant before fetch_context/search_memory
    // /the LLM are ever consulted, permanently losing the ability to
    // resolve it via the (pre-existing) "BUS/MRT maps to Public Transport
    // payee" memory fact. Declining lets it fall through to the generic
    // Phase-1 LLM path, which is the only place merchant/memory resolution
    // for unrecognized shapes should happen.
    const movement = parseBankMovement(
      `Card Transaction Alert
Transaction Ref: SP1300392943337844574576

Dear Sir / Madam,

We refer to your card transaction request dated 03/09/26. We are pleased to confirm that the transaction was completed.

Date & Time: 03 SEP 05:38 (SGT)
Amount: SGD4.60
From: DBS/POSB card ending 7111
To: BUS/MRT`,
      { senderBank: "DBS", receivedAt: "2026-09-03T05:39:00+08:00" },
    );

    expect(movement).toBeNull();
  });

  it("also declines when the destination names a bank but has no resolvable digit suffix", () => {
    // A destination identified only by bank name ("DBS Bank", no account
    // digits) is just as unresolvable as a bare merchant name — it already
    // produced counterparty: null today (`destination?.suffix ? ... : null`),
    // which would otherwise hit the exact same "Bank payment" placeholder
    // bug as #398. No special-casing by bank-alias-presence: the sole
    // criterion for declining is "no way to identify which tracked account
    // this refers to," so this also falls through to the LLM+memory path.
    const movement = parseBankMovement(
      `Amount : SGD 50.00
From your account : 111 Account (-166600)
To account : DBS Bank
Date : 01 Sep 2026
Time : 10:00 AM SGT`,
      { senderBank: "OCBC", receivedAt: "2026-09-01T10:01:00+08:00" },
    );

    expect(movement).toBeNull();
  });

  // ── SC "Confirmation Advice for FAST Transaction" (uid 977, 2026-09-28) ──
  //
  // Production incident: a S$1,275.00 transfer from SC Bonus Saver (******2555)
  // to DBS Account (******7222) was booked by neither side. The receiving bank's
  // alert (DBS uid 976) names the sender as a PERSON, not an account, so
  // `resolveMovementAccounts` fell back to `source = own` and both legs landed
  // on DBS Account — `internal` false, row held. Forwarding the SC advice
  // (uid 977) supplied the missing source account, but the body still did not
  // parse: this SC layout had no branch in `parseBankMovement` at all, so it
  // returned null and the whole alert fell through to the LLM extractor.
  //
  // The fixture is the real forwarded body, PII-redacted the way the repo does
  // it elsewhere (suffixes kept, names/addresses shortened) — see the header of
  // tests/ocbc-trust-transfer-hold.test.js.
  const SC_FAST_ADVICE = `Regards, Darren ---------- Forwarded message --------- From: <OnlineBanking.SG@sc.com> Date: Mon, Sep 28, 2026, 10:08 AM Subject: Confirmation Advice for FAST Transaction To: <accountholder@example.com> Dear Valued Customer, Your FAST transaction has been successful, transaction details below: Transaction reference: SG26050277698692365980 From account: ******2555 To account: ******7222 Amount: 1,275.00 Currency: SGD Transaction due date: 28/09/2026 10:08:02 Transaction type: FAST Payee Name: Darren DBS Payee Bank: Transaction message: Please call Client Contact Centre for enquiries. Thank you for using Standard Chartered Online Banking. Yours Sincerely, Transaction Banking Consumer Banking`;

  it("parses the SC FAST advice and resolves both legs of the transfer", () => {
    const movement = parseBankMovement(SC_FAST_ADVICE, {
      senderBank: "SC",
      receivedAt: "2026-09-28T03:14:27.000Z",
    });

    // Without this branch the SC advice returns null and the pair is never
    // linked: the DBS side holds and the SC side books unlinked via the LLM.
    expect(movement).not.toBeNull();
    expect(movement.direction).toBe("outgoing");
    // baseMovement() signs the amount from the direction, so an outgoing leg is
    // stored negative. The test pins the sign the parser actually produces.
    expect(movement.amount_cents).toBe(-127500);
    expect(movement.currency).toBe("SGD");
    // The masked source and destination, NOT the forwarding header's "From:".
    expect(movement.own_account.suffix).toBe("2555");
    expect(movement.counterparty.suffix).toBe("7222");
    // The transaction reference is the real one, not the "Transaction
    // reference:" label captured with the greeting.
    expect(movement.reference_number).toBe("SG26050277698692365980");
    // 2026-09-28 10:08 SGT, from "Transaction due date". Minute precision is the
    // module's convention: every other bank alert resolves to :00 seconds too,
    // because isoDateTime() parses hour and minute only.
    expect(movement.occurred_at).toBe("2026-09-28T10:08:00+08:00");
  });

  it("resolves the SC advice to the pair's two distinct own accounts", () => {
    const movement = parseBankMovement(SC_FAST_ADVICE, {
      senderBank: "SC",
      receivedAt: "2026-09-28T03:14:27.000Z",
    });
    const scAccounts = [
      { id: "sc-bonus-saver", name: "SC Bonus Saver", closed: false },
      { id: "dbs-account", name: "DBS Account", closed: false },
    ];
    const scPayees = [
      { id: "p-sc", name: "SC Bonus Saver", transfer_acct: "sc-bonus-saver" },
      { id: "p-dbs", name: "DBS Account", transfer_acct: "dbs-account" },
    ];
    const scFacts = [
      { text: "Account ending 2555 belongs to SC Bonus Saver", score: 1 },
      { text: "Account ending 7222 belongs to DBS Account", score: 1 },
    ];

    const resolved = resolveMovementAccounts(
      movement,
      scAccounts,
      scPayees,
      identityMappingsFromFacts(scFacts, scAccounts),
    );

    // The whole point of the branch: the source is the OTHER own account, not
    // the destination. This is what the DBS alert could not express, and it is
    // what makes `internal` true so the transfer pair links.
    expect(resolved.source_account.name).toBe("SC Bonus Saver");
    expect(resolved.destination_account.name).toBe("DBS Account");
    expect(resolved.source_account.id).not.toBe(resolved.destination_account.id);
    expect(resolved.internal).toBe(true);
  });

  // The first cut of this branch tried a `(?:^|\n)`-anchored alternative
  // first, but it matched against a string already flattened by
  // `.replace(/\s+/g, " ")`, where a newline can never survive — so that
  // alternative was unreachable and the branch worked only via its fallback.
  // The two-layout test pins the behaviour that is real. It does NOT, and
  // provably cannot, detect the dead alternative itself: it is behaviourally
  // inert, so a mutation test that reinstates it still passes. Removing it is a
  // simplification, not a behaviour fix.
  //
  // Review round 1 found three further defects this branch did not refuse.
  // Each test below reproduces the defect's exact observable failure, verified
  // by probe before the fix and gone after it.
  it("uses the transaction's own due date, not the received date, for a forwarded advice", () => {
    // Pre-fix this returned 2026-10-01: `isoDateTime` cannot read the dd/mm/yyyy
    // label, so it fell back to the receipt date, and the original test passed
    // anyway only because the fixture was received the same day.
    const movement = parseBankMovement(SC_FAST_ADVICE, {
      senderBank: "SC",
      receivedAt: "2026-10-01T09:00:00.000Z",
    });
    expect(movement).not.toBeNull();
    expect(movement.occurred_at).toBe("2026-09-28T10:08:00+08:00");
  });

  it("refuses the advice outright when the currency label is absent", () => {
    // Pre-fix this booked a record with `currency: "SC"`, the only path in the
    // file where a bank name can be written as a currency.
    const withoutCurrency = SC_FAST_ADVICE.replace(/ Currency: SGD/, "");
    expect(parseBankMovement(withoutCurrency, {
      senderBank: "SC",
      receivedAt: "2026-09-28T03:14:27.000Z",
    })).toBeNull();
  });

  // Round 2 caught that the previous gate was on `senderBank`, which production
  // derives as `bankFromSender(from)` — the outer `From:` header. For a
  // forwarded advice that is the forwarder, not SC, so the gate refused exactly
  // the case this branch exists for. `senderBank` is null/unknown here, the
  // value the production path would actually supply.
  it("parses a FORWARDED advice whose From: header is not SC", () => {
    const movement = parseBankMovement(SC_FAST_ADVICE, {
      senderBank: null, // forwarder's own domain, not a bank in DOMAIN_BANK_MAP
      receivedAt: "2026-10-01T09:00:00.000Z",
    });
    expect(movement).not.toBeNull();
    expect(movement.direction).toBe("outgoing");
    expect(movement.own_account.suffix).toBe("2555");
    expect(movement.own_account.bank).toBe("SC");
    expect(movement.counterparty.suffix).toBe("7222");
    expect(movement.occurred_at).toBe("2026-09-28T10:08:00+08:00");
    expect(movement.currency).toBe("SGD");
    expect(movement.amount_cents).toBe(-127500);
  });

  // Round 3 found the forwarded path still attributed the account to the
  // FORWARDER: the gate proved Standard Chartered sent the advice, and the code
  // then threw that away and used `senderBank` (the outer From: header) as the
  // fallback bank. Forwarding from an OCBC address labelled SC account 2555 as
  // OCBC. The masked value carries no bank name, so only the fallback decided.
  it("attributes the own account to SC, not the forwarding address, on every header", () => {
    for (const senderBank of [null, "OCBC", "UOB", "DBS"]) {
      const movement = parseBankMovement(SC_FAST_ADVICE, {
        senderBank,
        receivedAt: "2026-10-01T09:00:00.000Z",
      });
      expect(movement, `senderBank=${senderBank}`).not.toBeNull();
      expect(movement.own_account.bank, `senderBank=${senderBank}`).toBe("SC");
    }
  });

  // "Payee Bank:" is the advice's only statement of the recipient's bank, and
  // `bankFromText("******7222")` can only ever return null. The real advice
  // leaves the field empty, so this pins that a populated one is read AND that
  // the empty case does not run the bank name into the next field.
  it("reads the recipient bank from the Payee Bank label when the advice states it", () => {
    const withPayeeBank = SC_FAST_ADVICE.replace("Payee Bank:", "Payee Bank: DBS");
    const movement = parseBankMovement(withPayeeBank, {
      senderBank: "UOB",
      receivedAt: "2026-09-28T03:14:27.000Z",
    });
    expect(movement).not.toBeNull();
    expect(movement.counterparty.bank).toBe("DBS");
  });

  it("leaves the recipient bank unset when the advice leaves Payee Bank empty", () => {
    expect(SC_FAST_ADVICE).toMatch(/Payee Bank:\s+Transaction message:/);
    const movement = parseBankMovement(SC_FAST_ADVICE, {
      senderBank: "SC",
      receivedAt: "2026-09-28T03:14:27.000Z",
    });
    expect(movement).not.toBeNull();
    expect(movement.counterparty.bank).toBeNull();
  });

  it("does not claim a non-SC alert that happens to use the same label layout", () => {
    // "From account" / "To account" is generic FAST vocabulary. Pre-fix an
    // inbound advice in that shape was booked OUTGOING from the recipient's
    // account, inverting the direction and the leg pairing.
    //
    // Both the body signature AND the body mention of a bank are replaced, so
    // this input satisfies neither possible gate -- it cannot pass merely
    // because "DBS" is absent, and it cannot pass on a stale signature.
    const otherBank = SC_FAST_ADVICE
        .replace(/Standard Chartered Online Banking/g, "Some Bank Online Banking")
        .replace(/Payee Bank:/g, "Counterparty Bank:");
    expect(otherBank).not.toMatch(/Standard\s+Chartered/i);
    expect(parseBankMovement(otherBank, {
      senderBank: "DBS",
      receivedAt: "2026-09-28T03:14:27.000Z",
    })).toBeNull();
  });

  it("parses the SC advice whether the body is line-separated or flattened", () => {
    const lineSeparated = SC_FAST_ADVICE.replace(/ Forwarded message/, "\nForwarded message")
        .replace(/ Transaction reference/, "\nTransaction reference")
        .replace(/ From account/, "\nFrom account")
        .replace(/ To account/, "\nTo account")
        .replace(/ Amount/, "\nAmount")
        .replace(/ Currency/, "\nCurrency")
        .replace(/ Transaction due date/, "\nTransaction due date");

    for (const body of [SC_FAST_ADVICE, lineSeparated]) {
      const movement = parseBankMovement(body, {
        senderBank: "SC",
        receivedAt: "2026-09-28T03:14:27.000Z",
      });
      expect(movement).not.toBeNull();
      expect(movement.own_account.suffix).toBe("2555");
      expect(movement.counterparty.suffix).toBe("7222");
    }
  });
});

describe("SC FAST advice scoping (#639)", () => {
  const SC = `Dear Customer, Your FAST transaction has been successful: Transaction reference: SG26050277698692365980 From account: ******2555 To account: ******7222 Amount: 1,275.00 Currency: SGD Transaction due date: 28/09/2026 10:08:02 Transaction type: FAST Payee Bank: Transaction message: Thank you for using Standard Chartered Online Banking. Yours Sincerely`;
  const FOREIGN = `---------- Forwarded message --------- From: <alerts@examplebank.com> Subject: Debit Card Alert Transaction type: Debit Card Transaction From account: ******1111 To account: ******9999 Amount: 4,321.00 Currency: SGD Transaction due date: 28/09/2026 09:00:00 Thank you for using Standard Chartered Online Banking. Yours Sincerely, `;
  const opts = { senderBank: "UOB", receivedAt: "2026-10-01T09:00:00.000Z" };

  it("does not pair a foreign advice's accounts or amount", () => {
    expect(parseBankMovement(`${FOREIGN} ${SC}`, opts)).toBeNull();
    expect(parseBankMovement(`${SC} ${FOREIGN}`, opts)).toBeNull();
  });

  it("still parses a single advice", () => {
    const m = parseBankMovement(SC, opts);
    expect(m.own_account.suffix).toBe("2555");
    expect(m.counterparty.suffix).toBe("7222");
    expect(m.amount_cents).toBe(-127500);
  });
});

describe("identityMappingsFromFacts", () => {
  // Issue #569: an OCBC transfer alert masks both account numbers, so the only
  // evidence is the trailing digits after the asterisks. A bare digit run is
  // not a suffix — that would read a reference number as an account.
  it("reads a masked trailing suffix but never a bare reference number", () => {
    const from = parseBankMovement(
      `Dear Customer,\nAs you instructed, we have made the following transfer:\nTransfer Date: 18 Sep 2026 5.04AM\nAmount: MYR 62.00\nFrom your account: OCBC 360 ACCOUNT ******2444\nTo payee: A Person (********2333)\nReference number: 2609180147355231\n`,
      { senderBank: "OCBC", receivedAt: "2026-09-17T21:04:12.000Z" },
    );

    expect(from).toMatchObject({
      direction: "outgoing",
      amount_cents: -6200,
      own_account: { name: "OCBC 360 ACCOUNT", bank: "OCBC", suffix: "2444" },
      counterparty: { name: "A Person", suffix: "2333" },
    });
    // The reference number is longer than the masked suffixes, so it can never
    // be mistaken for one.
    expect(from.own_account.suffix).not.toBe("2609180147355231");
    expect(from.counterparty.suffix).not.toBe("2609180147355231");
  });

  it("maps identity facts whose account name ends in Account without truncating it", () => {
    const localAccounts = [
      { id: "dbs-account", name: "DBS Account", closed: false },
      { id: "dbs-nova", name: "DBS Nova Card", closed: false },
    ];
    const mappings = identityMappingsFromFacts([
      "Account ending 7222 belongs to DBS Account",
      "Card ending 7111 belongs to DBS Nova Card",
    ], localAccounts);

    expect(mappings.suffix.get("7222")?.name).toBe("DBS Account");
    expect(mappings.suffix.get("7111")?.name).toBe("DBS Nova Card");
  });

  it("still maps identity facts with a trailing filler account word", () => {
    const localAccounts = [
      { id: "ocbc-111", name: "OCBC 111", closed: false },
    ];
    const mappings = identityMappingsFromFacts([
      "Account ending 166600 belongs to OCBC 111 account",
    ], localAccounts);

    expect(mappings.suffix.get("166600")?.name).toBe("OCBC 111");
  });

  it("rejects conflicting facts for one account suffix", () => {
    const localAccounts = [
      { id: "dbs-one", name: "DBS One", closed: false },
      { id: "dbs-two", name: "DBS Two", closed: false },
      { id: "dbs-current", name: "DBS Current 7222", closed: false },
    ];
    const mappings = identityMappingsFromFacts([
      "Account ending 7222 belongs to DBS One",
      "Account ending 7222 belongs to DBS Two",
    ], localAccounts);
    const resolved = resolveMovementAccounts({
      direction: "outgoing",
      own_account: { bank: "DBS", suffix: "7222" },
      counterparty: null,
    }, localAccounts, [], mappings);

    expect(resolved.source_account).toBeNull();
  });
});

describe("structured movement orchestration", () => {
  it("insert notification for a deterministic (non-LLM) movement includes the Phase-2-resolved payee and category", async () => {
    // Deterministic bank-movement outputs always set notify_message: "" —
    // the notification is built entirely from Phase 2's resolution, so it
    // must reflect the real resolved payee/category, not just the raw
    // PayNow merchant string ("Example LLP").
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
      executeTool: vi.fn(async (name, args) => {
        calls.push({ name, args });
        if (name === "fetch_context")
          return {
            accounts: [{ id: "ocbc-111", name: "OCBC 111 6600", closed: false }],
            categories: [{ id: "cat-utilities", name: "Utilities", group_id: "g1" }],
            payees: [],
          };
        if (name === "search_memory") {
          if (String(args?.query || "").includes("Example LLP"))
            return { results: [{ text: "Example LLP maps to Utilities Board payee", score: 1 }] };
          if (String(args?.query || "").includes("Utilities Board"))
            return { results: [{ text: "Utilities Board maps to Utilities category", score: 1 }] };
          return { results: [] };
        }
        if (name === "check_duplicate") return false;
        if (name === "insert_transaction") return { id: "actual-1" };
        if (name === "notify_user") return true;
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator({
      primaryCurrency: "SGD", secondaryCurrency: "MYR",
      primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
      llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
    }, tools);
    orch._llm.chat = vi.fn();

    const phase1 = await orch._runPhase1(`
The following PayNow transfer has been made to Example LLP using their Unique Entity Number (UEN) UEN123.
Date : 01 Sep 2026
Time : 19:34 PM SGT
Amount : SGD 7.30
From your account : 111 Account (-6600)
Description : UEN123-REFERENCE
`, { senderBank: "OCBC", receivedAt: "2026-09-01T19:35:00+08:00" });

    expect(orch._llm.chat).not.toHaveBeenCalled();
    expect(phase1).toMatchObject({
      merchant: "Example LLP",
      account_id: "ocbc-111",
      notify_message: "",
    });

    const phase2 = await orch._resolvePhase2(phase1);
    await orch._executePhase3(phase2);

    const notifyCall = calls.find((c) => c.name === "notify_user");
    const { message } = notifyCall.args;
    expect(message).toContain("Utilities Board");
    expect(message).toContain("→ Utilities");
  });

  it("bypasses LLM and sends a transfer payee for DBS bill payment", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
      executeTool: vi.fn(async (name, args) => {
        calls.push({ name, args });
        if (name === "fetch_context") return {
          accounts: [
            { id: "dbs-vista", name: "Vista 1777", closed: false },
            { id: "citi-card", name: "Citi Points 2666", closed: false },
          ],
          categories: [],
          payees: [{ id: "transfer-citi", transfer_acct: "citi-card" }],
        };
        if (name === "search_memory") return { results: [
          { text: "Card ending 1777 belongs to Vista 1777", score: 1 },
        ] };
        if (name === "reserve_transfer") return { status: "reserved", entry: { id: 1 } };
        if (name === "check_duplicate") return false;
        // The far-side read the #598 fix always makes before a transfer insert.
        // An empty far account answers "no far side yet", so the insert
        // proceeds normally with its transfer payee.
        if (name === "find_link_candidate") return { candidate: null, matches: 0 };
        if (name === "insert_transaction") return { id: "actual-1" };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator({
      primaryCurrency: "SGD", secondaryCurrency: "MYR",
      primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
      llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
    }, tools);
    orch._llm.chat = vi.fn();

    const phase1 = await orch._runPhase1(`
Transaction Ref: REF-DBS-1
Date and Time: 01 Sep 01:05 (SGT)
Amount: SGD 253.37
From: Vista (A/C ending 1777)
To: CITI CREDIT CARDS (Ref ending 2666)
`, { senderBank: "DBS" });

    expect(orch._llm.chat).not.toHaveBeenCalled();
    expect(phase1).toMatchObject({
      account_id: "dbs-vista", payee_id: "transfer-citi",
      amount_cents: -25337, category_id: null, _is_transfer: true,
    });

    await orch._executePhase3(phase1);
    const insert = calls.find((call) => call.name === "insert_transaction");
    expect(insert.args).toMatchObject({
      account_id: "dbs-vista",
      amount_cents: -25337,
      payee_id: "transfer-citi",
      category_id: undefined,
    });
    expect(calls.some((call) => call.name === "complete_transfer")).toBe(true);
  });

  it("parses a flattened DBS bill-payment alert through real processEmail extraction", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
      executeTool: vi.fn(async (name, args) => {
        calls.push({ name, args });
        if (name === "fetch_context") return {
          accounts: [
            { id: "dbs-vista", name: "Vista 1777", closed: false },
            { id: "citi-card", name: "Citi Points 2666", closed: false },
          ],
          categories: [],
          payees: [{ id: "transfer-citi", transfer_acct: "citi-card" }],
        };
        if (name === "search_memory") return { results: [
          { text: "Card ending 1777 belongs to Vista 1777", score: 1 },
        ] };
        if (name === "reserve_transfer") return { status: "reserved", entry: { id: 1 } };
        if (name === "check_duplicate") return false;
        // The far-side read the #598 fix always makes before a transfer insert.
        // An empty far account answers "no far side yet", so the insert
        // proceeds normally with its transfer payee.
        if (name === "find_link_candidate") return { candidate: null, matches: 0 };
        if (name === "insert_transaction") return { id: "actual-1" };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator({
      primaryCurrency: "SGD", secondaryCurrency: "MYR",
      primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
      llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
    }, tools);
    orch._llm.chat = vi.fn();

    const rawEmail = [
      "Date: Tue, 01 Sep 2026 01:06:00 +0800",
      "From: DBS <noreply@dbs.com>",
      "Subject: Payment Alert",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Transaction Ref: REF-DBS-1",
      "Date and Time: 01 Sep 01:05 (SGT)",
      "Amount: SGD 253.37",
      "From: Vista (A/C ending 1777)",
      "To: CITI CREDIT CARDS (Ref ending 2666)",
      "",
    ].join("\r\n");

    await orch.processEmail(
      "dbs-bill-flattened",
      rawEmail,
      null,
      "noreply@dbs.com",
      "Payment Alert",
    );

    expect(orch._llm.chat).not.toHaveBeenCalled();
    const insert = calls.find((call) => call.name === "insert_transaction");
    expect(insert.args).toMatchObject({
      account_id: "dbs-vista",
      amount_cents: -25337,
      payee_id: "transfer-citi",
    });
    expect(calls.some((call) => call.name === "complete_transfer")).toBe(true);
  });

  it("passes the RFC email date to phase 1 across a year boundary", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async () => true),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator({
      primaryCurrency: "SGD", secondaryCurrency: "MYR",
      primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
      llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
    }, tools);
    orch._runPhase1 = vi.fn().mockResolvedValue({ action: "skip" });

    await orch.processEmail(
      "deposit-year-boundary",
      [
        "Date: Fri, 01 Jan 2027 00:01:00 +0800",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "A deposit was made in your account.",
      ].join("\r\n"),
      null,
      "Notifications@ocbc.com",
      "OCBC Alert: Deposit in your account",
    );

    expect(orch._runPhase1).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        senderBank: "OCBC",
        receivedAt: "2026-12-31T16:01:00.000Z",
      }),
    );
  });

  it("resolves the Nova bill-payment source account deterministically without the LLM", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context") return {
          accounts: [
            { id: "dbs-account", name: "DBS Account", closed: false },
            { id: "dbs-nova", name: "DBS Nova Card", closed: false },
          ],
          categories: [],
          payees: [{ id: "transfer-nova", transfer_acct: "dbs-nova" }],
        };
        if (name === "search_memory") return { results: [
          { text: "Account ending 7222 belongs to DBS Account", score: 1 },
          { text: "Card ending 7111 belongs to DBS Nova Card", score: 1 },
        ] };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator({
      primaryCurrency: "SGD", secondaryCurrency: "MYR",
      primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
      llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
    }, tools);
    orch._llm.chat = vi.fn();

    const phase1 = await orch._runPhase1(`
Transaction Ref: 17881923709657843541
Date and Time: 01 Sep 00:57 (SGT)
Amount: SGD 68.94
From: My Account (A/C ending 7222)
To: Nova (Ref ending 7111)
`, { senderBank: "DBS", receivedAt: "2026-09-01T01:10:00+08:00" });

    expect(orch._llm.chat).not.toHaveBeenCalled();
    expect(phase1).toMatchObject({
      account_id: "dbs-account",
      payee_id: "transfer-nova",
      amount_cents: -6894,
      _is_transfer: true,
    });
    expect(phase1._transfer).toMatchObject({
      source_account_id: "dbs-account",
      destination_account_id: "dbs-nova",
    });
  });

  it("resolves a legacy bill-payment format through identity facts, not account-name suffixes", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context") return {
          accounts: [
            { id: "dbs-account", name: "DBS Account", closed: false },
            { id: "dbs-nova", name: "DBS Nova Card", closed: false },
          ],
          categories: [],
          payees: [{ id: "transfer-nova", transfer_acct: "dbs-nova" }],
        };
        if (name === "search_memory") return { results: [
          { text: "Account ending 7222 belongs to DBS Account", score: 1 },
          { text: "Card ending 7111 belongs to DBS Nova Card", score: 1 },
        ] };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator({
      primaryCurrency: "SGD", secondaryCurrency: "MYR",
      primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
      llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
    }, tools);
    orch._llm.chat = vi.fn();

    const phase1 = await orch._runPhase1(`
Amount: SGD 68.94
From: My Account (A/C ending 7222)
To: Nova (Ref ending 7111)
`, { senderBank: "DBS", receivedAt: "2026-09-01T01:10:00+08:00" });

    expect(orch._llm.chat).not.toHaveBeenCalled();
    expect(phase1).toMatchObject({
      account_id: "dbs-account",
      payee_id: "transfer-nova",
      amount_cents: -6894,
      category_id: null,
      _is_transfer: true,
    });
  });

  it("does not resolve a closed account from a legacy bill-payment identity fact", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context") return {
          accounts: [{ id: "closed-dbs", name: "DBS Account", closed: true }],
          categories: [],
          payees: [],
        };
        if (name === "search_memory") return { results: [
          { text: "Account ending 7222 belongs to DBS Account", score: 1 },
        ] };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator({
      primaryCurrency: "SGD", secondaryCurrency: "MYR",
      primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
      llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
    }, tools);

    await expect(orch._runLegacyBillPaymentMovement(`
Amount: SGD 68.94
From: My Account (A/C ending 7222)
To: Nova (Ref ending 7111)
`, "DBS", "2026-09-01T01:10:00+08:00")).resolves.toBeNull();
  });

  it("does not assign a category to an internal transfer via payee→category memory", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name, query) => {
        if (name === "fetch_context") return {
          accounts: [
            { id: "dbs-account", name: "DBS Account", closed: false },
            { id: "dbs-nova", name: "DBS Nova Card", closed: false },
          ],
          categories: [{ id: "cat-food", name: "Food" }],
          payees: [{ id: "transfer-nova", transfer_acct: "dbs-nova" }],
        };
        if (name === "search_memory") return { results: [
          { text: "Account ending 7222 belongs to DBS Account", score: 1 },
          { text: "Card ending 7111 belongs to DBS Nova Card", score: 1 },
          { text: "DBS Nova Card maps to Food category", score: 1 },
        ] };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator({
      primaryCurrency: "SGD", secondaryCurrency: "MYR",
      primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
      llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
    }, tools);
    orch._llm.chat = vi.fn();

    const phase1 = await orch._runPhase1(`
Transaction Ref: 17881923709657843541
Date and Time: 01 Sep 00:57 (SGT)
Amount: SGD 68.94
From: My Account (A/C ending 7222)
To: Nova (Ref ending 7111)
`, { senderBank: "DBS", receivedAt: "2026-09-01T01:10:00+08:00" });

    const phase2 = await orch._resolvePhase2(phase1);

    expect(phase2._is_transfer).toBe(true);
    expect(phase2.payee_id).toBe("transfer-nova");
    expect(phase2.category_id).toBeFalsy();
    expect(phase2.category_name).toBeUndefined();
  });

  it("inserts a one-sided OCBC deposit deterministically without the LLM", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context") return {
          accounts: [{ id: "ocbc-111", name: "OCBC 111", closed: false }],
          categories: [],
          payees: [],
        };
        if (name === "search_memory") return { results: [
          { text: "Account ending 166600 belongs to OCBC 111", score: 1 },
        ] };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator({
      primaryCurrency: "SGD", secondaryCurrency: "MYR",
      primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
      llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
    }, tools);
    orch._llm.chat = vi.fn();

    const phase1 = await orch._runPhase1(`
A deposit was made in your account. Here are the details:

Time of deposit : 11:59 PM
Amount : SGD 0.20
Account that money was deposited in : (-166600)
Reference :
`, { senderBank: "OCBC", receivedAt: "2026-09-02T00:05:00+08:00" });

    expect(orch._llm.chat).not.toHaveBeenCalled();
    expect(phase1).toMatchObject({
      account_id: "ocbc-111",
      amount_cents: 20,
      merchant: "Unidentified deposit",
      _structured_movement: true,
    });
  });

  it("uses the LLM extractor fallback for an unknown-format email and resolves accounts in code", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context") return {
          accounts: [{ id: "ryt-bank", name: "Ryt Bank", closed: false }],
          categories: [],
          payees: [],
        };
        if (name === "search_memory") return { results: [] };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator({
      primaryCurrency: "SGD", secondaryCurrency: "MYR",
      primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
      llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
    }, tools);
    orch._llm.chat = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        direction: "outgoing", amount: 200, currency: "MYR",
        occurred_at: "2026-09-02T00:46:00+08:00",
        from_account: "your Main Account",
        to_account: "TNG-EWALLET ECOM 3-EC",
        merchant: "TNG-EWALLET ECOM 3-EC",
      }) } }],
    });

    const phase1 = await orch._runPhase1(
      "MYR 200.00 was transferred to TNG-EWALLET ECOM 3-EC from your Main Account on 2/9/2026, 12:46 AM (GMT+8).",
      { senderBank: "Ryt", receivedAt: "2026-09-02T00:46:00+08:00" },
    );

    expect(orch._llm.chat).toHaveBeenCalledTimes(1);
    expect(phase1).toMatchObject({
      account_id: "ryt-bank",
      amount_cents: -20000,
      _structured_movement: true,
    });
  });

  it("does not create an internal transfer from a bankless source without an identity fact", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context") return {
          accounts: [
            { id: "dbs-vista", name: "Vista 1777", closed: false },
            { id: "citi-card", name: "Citi Points 2666", closed: false },
          ],
          categories: [],
          payees: [{ id: "transfer-citi", transfer_acct: "citi-card" }],
        };
        if (name === "search_memory") return { results: [] };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator({
      primaryCurrency: "SGD", secondaryCurrency: "MYR",
      primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
      llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
    }, tools);
    orch._llm.chat = vi.fn();

    const phase1 = await orch._runPhase1(`
Transaction Ref: REF-DBS-NO-IDENTITY
Date and Time: 01 Sep 01:05 (SGT)
Amount: SGD 253.37
From: Vista (A/C ending 1777)
To: CITI CREDIT CARDS (Ref ending 2666)
`, { senderBank: "DBS", receivedAt: "2026-09-01T01:06:00+08:00" });

    expect(phase1).toBeNull();
    expect(orch._llm.chat).toHaveBeenCalled();
  });

  it("deduplicates Trust incoming alert without LLM or payee-memory account override", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
      executeTool: vi.fn(async (name, args) => {
        calls.push({ name, args });
        if (name === "fetch_context") return {
          accounts: [
            { id: "ocbc-111", name: "OCBC 111", closed: false },
            { id: "trust-card", name: "Trust Card", closed: false },
          ],
          categories: [],
          payees: [{ id: "transfer-trust", transfer_acct: "trust-card" }],
        };
        if (name === "search_memory") return { results: [
          { text: "Account ending 166600 belongs to OCBC 111", score: 1 },
          { text: "Trust alert recipient maps to Trust Card account", score: 1 },
          { text: "OverseaChinese Banking Corporation Ltd maps to Charity payee", score: 1 },
        ] };
        if (name === "reserve_transfer") return { status: "inserted", entry: { id: 1 } };
        // The far-side read the #598 fix makes before reserving. This credit's
        // counterpart is already recorded in the journal, so no Actual-row
        // candidate exists and the read must not change this path.
        if (name === "find_link_candidate") return { candidate: null, matches: 0 };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator({
      primaryCurrency: "SGD", secondaryCurrency: "MYR",
      primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
      llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
    }, tools);
    orch._llm.chat = vi.fn();

    const phase1 = await orch._runPhase1(
      "Sweet! You have received SGD 14.25 from OverseaChinese Banking Corporation Ltd A/C ending 6600 on 01 Sep 2026 01:06 SGT.",
      { senderBank: "Trust" },
    );

    expect(orch._llm.chat).not.toHaveBeenCalled();
    expect(phase1._transfer).toMatchObject({
      source_account_id: "ocbc-111", destination_account_id: "trust-card",
    });
    await orch._executePhase3(phase1);
    expect(calls.some((call) => call.name === "insert_transaction")).toBe(false);
    expect(calls.some((call) => call.name === "mark_email_read")).toBe(true);
  });
});

describe("resolveMovementAccounts", () => {
  it("resolves both sides from live Actual account names and transfer payee", () => {
    const resolved = resolveMovementAccounts({
      direction: "outgoing",
      own_account: { bank: "DBS", suffix: "1777" },
      counterparty: { bank: "Citi", suffix: "2666" },
    }, accounts, payees, identityMappingsFromFacts([
      "Card ending 1777 belongs to Vista 1777",
    ], accounts));

    expect(resolved).toEqual({
      source_account: accounts[2],
      destination_account: accounts[3],
      destination_payee: payees[1],
      internal: true,
    });
  });

  it("rejects bankless account names unless explicitly mapped", () => {
    const result = resolveMovementAccounts({
      direction: "outgoing",
      own_account: { bank: "DBS", suffix: "1777" },
      counterparty: { bank: "Citi", suffix: "2666" },
    }, accounts, payees);
    expect(result.source_account).toBeNull();
    expect(result.internal).toBe(false);
  });

  it("resolves a one-sided incoming deposit to the own account", () => {
    const accounts = [{ id: "ocbc-111", name: "OCBC 111", closed: false }];
    const mappings = identityMappingsFromFacts([
      "Account ending 166600 belongs to OCBC 111",
    ], accounts);
    const resolved = resolveMovementAccounts({
      direction: "incoming",
      own_account: { bank: "OCBC", suffix: "166600" },
      counterparty: null,
    }, accounts, [], mappings);

    expect(resolved.source_account?.id).toBe("ocbc-111");
    expect(resolved.destination_account?.id).toBe("ocbc-111");
  });

  it("resolves an outgoing movement by unique bank when the own account has no suffix", () => {
    const accounts = [
      { id: "ryt-bank", name: "Ryt Bank", closed: false },
      { id: "tng", name: "Touch N Go", closed: false },
    ];
    const resolved = resolveMovementAccounts({
      direction: "outgoing",
      own_account: { name: "your Main Account", bank: "Ryt", suffix: null },
      counterparty: { name: "TNG-EWALLET ECOM 3-EC", bank: null, suffix: null },
    }, accounts, [], { suffix: new Map(), recipient: new Map() });

    expect(resolved.source_account?.id).toBe("ryt-bank");
  });

  it("resolves a suffix alias matched by multiple facts pointing to the same account", () => {
    const accounts = [{ id: "ocbc-111", name: "OCBC 111", closed: false }];
    const mappings = identityMappingsFromFacts([
      "Account ending 166600 belongs to OCBC 111",
      "Account ending 6600 belongs to OCBC 111",
    ], accounts);
    const resolved = resolveMovementAccounts({
      direction: "outgoing",
      own_account: { bank: "OCBC", suffix: "166600" },
      counterparty: { bank: "OCBC", suffix: "6600" },
    }, accounts, [], mappings);

    expect(resolved.source_account?.id).toBe("ocbc-111");
    expect(resolved.destination_account?.id).toBe("ocbc-111");
  });

  it("uses unique short suffix but rejects ambiguous short suffix", () => {
    const resolved = resolveMovementAccounts({
      direction: "outgoing",
      own_account: { bank: "OCBC", suffix: "166600" },
      counterparty: { bank: "Trust", suffix: "2000" },
    }, accounts, payees);
    expect(resolved.internal).toBe(true);
    expect(resolved.source_account.id).toBe("ocbc-111");

    const ambiguous = resolveMovementAccounts({
      direction: "outgoing",
      own_account: { bank: "OCBC", suffix: "166600" },
      counterparty: { bank: "Citi", suffix: "2666" },
    }, [...accounts, { id: "citi-other", name: "Citi Other 2666", closed: false }], payees);
    expect(ambiguous.internal).toBe(false);
    expect(ambiguous.destination_account).toBeNull();
  });

  it("does not cross-bank match a banked suffix fact (falls back to unique-bank)", () => {
    const accounts = [
      { id: "dbs-card", name: "DBS Visa 1234", closed: false },
      { id: "ocbc-acct", name: "OCBC 365 Account", closed: false },
    ];
    const mappings = identityMappingsFromFacts(["Card ending 1234 belongs to DBS Visa 1234"], accounts);
    const resolved = resolveMovementAccounts({
      direction: "outgoing",
      own_account: { bank: "OCBC", suffix: "1234" },
      counterparty: { bank: "Citi", suffix: "9999" },
    }, accounts, [], mappings);
    expect(resolved.source_account.id).toBe("ocbc-acct");
  });

  it("does not cross-book an SC fact against OCBC evidence (SC now recognized)", () => {
    const accounts = [
      { id: "sc-card", name: "SC Visa 1234", closed: false },
      { id: "ocbc-acct", name: "OCBC 365 Account", closed: false },
    ];
    const mappings = identityMappingsFromFacts(["Card ending 1234 belongs to SC Visa 1234"], accounts);
    const resolved = resolveMovementAccounts({
      direction: "outgoing",
      own_account: { bank: "OCBC", suffix: "1234" },
      counterparty: { bank: "Citi", suffix: "9999" },
    }, accounts, [], mappings);
    expect(resolved.source_account.id).toBe("ocbc-acct");
  });
});

describe("suffix auto-learn", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const baseConfig = () => ({
    primaryCurrency: "SGD", secondaryCurrency: "MYR",
    primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
    llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
  });

  it("learns a Card-prefixed fact for a card-named account", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
      executeTool: vi.fn(async (name, args) => {
        calls.push({ name, args });
        return { added: true };
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);

    await orch._learnSuffixFact({ suffix: "7111", accountName: "DBS Nova Card" });

    const learn = calls.find((c) => c.name === "learn_fact");
    expect(learn.args.fact).toBe("Card ending 7111 belongs to DBS Nova Card");
  });

  it("learns an Account-prefixed fact for a bank account", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
      executeTool: vi.fn(async (name, args) => {
        calls.push({ name, args });
        return { added: true };
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);

    await orch._learnSuffixFact({ suffix: "7222", accountName: "DBS Account" });

    const learn = calls.find((c) => c.name === "learn_fact");
    expect(learn.args.fact).toBe("Account ending 7222 belongs to DBS Account");
  });

  it("updates a contradictory fact via update_fact", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name) => {
        if (name === "learn_fact")
          return { added: false, skipped: true, reason: "contradiction", existing: "Card ending 7111 belongs to DBS Vista Card" };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);

    await orch._learnSuffixFact({ suffix: "7111", accountName: "DBS Nova Card" });

    expect(tools.executeTool).toHaveBeenCalledWith("update_fact", {
      old_text: "Card ending 7111 belongs to DBS Vista Card",
      new_text: "Card ending 7111 belongs to DBS Nova Card",
      budget_id: "",
    });
  });

  it("does not overwrite a cross-bank suffix fact on contradiction", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
      executeTool: vi.fn(async (name, args) => {
        calls.push({ name, args });
        if (name === "learn_fact")
          return { added: false, skipped: true, reason: "contradiction", existing: "Card ending 1234 belongs to DBS Visa 1234" };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);

    await orch._learnSuffixFact({ suffix: "1234", accountName: "OCBC Visa 1234" });

    expect(calls.some((c) => c.name === "update_fact")).toBe(false);
  });

  it("strips LLM-injected _suffix_mappings from Phase-1 output", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context") return {
          accounts: [{ id: "acc-dbs", name: "DBS Account", closed: false }],
          categories: [],
          payees: [],
        };
        if (name === "search_memory") return { results: [] };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);
    orch._llm.chat = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        merchant: "X",
        amount_cents: -100,
        date: "2026-09-01",
        currency: "SGD",
        account_id: "acc-dbs",
        account_name: "DBS Account",
        skip: false,
        _suffix_mappings: [{ suffix: "7111", accountName: "DBS Nova Card" }],
      }) } }],
    });

    const result = await orch._runPhase1("card ending 7111", { senderBank: "DBS" });

    expect(result._suffix_mappings).toBeUndefined();
  });

  it("rejects a non-4-to-6-digit suffix without learning", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
      executeTool: vi.fn(async (name, args) => {
        calls.push({ name, args });
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);

    await orch._learnSuffixFact({ suffix: "12", accountName: "DBS Nova Card" });
    await orch._learnSuffixFact({ suffix: "", accountName: "DBS Nova Card" });

    expect(calls.some((c) => c.name === "learn_fact")).toBe(false);
  });

  it("does not attach suffix mappings to LLM-extracted movements", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context") return {
          accounts: [{ id: "dbs-visa", name: "DBS Visa 1234", closed: false }],
          categories: [],
          payees: [],
        };
        if (name === "search_memory") return { results: [] };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);
    orch._llm.chat = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        amount: 10,
        currency: "SGD",
        direction: "outgoing",
        occurred_at: "2026-09-01T00:00:00.000Z",
        from_account: "DBS Visa ending 1234",
      }) } }],
    });

    const phase1 = await orch._llmExtractMovement("unstructured bank alert", "DBS");

    expect(phase1._suffix_mappings).toEqual([]);
  });

  it("does not learn a longer alert suffix from shorter account-name digits", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const orch = new AgentOrchestrator(baseConfig(), {
      executeTool: vi.fn(),
      setEmailContext: vi.fn(),
      getPhase1ToolSchemas: vi.fn(() => []),
    });

    const mappings = orch._collectSuffixMappings({
      direction: "outgoing",
      own_account: { bank: "DBS", suffix: "991234" },
    }, {
      source_account: { id: "dbs-visa", name: "DBS Visa 1234", closed: false },
      destination_account: null,
      internal: false,
    });

    expect(mappings).toEqual([]);
  });

  it("attaches _suffix_mappings for a name-digit matched destination", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context") return {
          accounts: [
            { id: "dbs-vista", name: "Vista 1777", closed: false },
            { id: "citi-card", name: "Citi Points 2666", closed: false },
          ],
          categories: [],
          payees: [{ id: "transfer-citi", transfer_acct: "citi-card" }],
        };
        if (name === "search_memory") return { results: [
          { text: "Card ending 1777 belongs to Vista 1777", score: 1 },
        ] };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);
    orch._llm.chat = vi.fn();

    const phase1 = await orch._runPhase1(`
Transaction Ref: REF-DBS-1
Date and Time: 01 Sep 01:05 (SGT)
Amount: SGD 253.37
From: Vista (A/C ending 1777)
To: CITI CREDIT CARDS (Ref ending 2666)
`, { senderBank: "DBS" });

    expect(phase1._suffix_mappings).toEqual([
      { suffix: "2666", accountName: "Citi Points 2666" },
    ]);
  });

  it("does not attach _suffix_mappings when resolution is memory-fact-only", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context") return {
          accounts: [
            { id: "dbs-account", name: "DBS Account", closed: false },
            { id: "dbs-nova", name: "DBS Nova Card", closed: false },
          ],
          categories: [],
          payees: [{ id: "transfer-nova", transfer_acct: "dbs-nova" }],
        };
        if (name === "search_memory") return { results: [
          { text: "Account ending 7222 belongs to DBS Account", score: 1 },
          { text: "Card ending 7111 belongs to DBS Nova Card", score: 1 },
        ] };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);
    orch._llm.chat = vi.fn();

    const phase1 = await orch._runPhase1(`
Transaction Ref: 17881923709657843541
Date and Time: 01 Sep 00:57 (SGT)
Amount: SGD 68.94
From: My Account (A/C ending 7222)
To: Nova (Ref ending 7111)
`, { senderBank: "DBS", receivedAt: "2026-09-01T01:10:00+08:00" });

    expect(phase1._suffix_mappings).toEqual([]);
  });

  it("learns suffix mappings after a successful insert", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
      executeTool: vi.fn(async (name, args) => {
        calls.push({ name, args });
        if (name === "check_duplicate") return false;
        if (name === "insert_transaction") return { id: "actual-1" };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);

    await orch._executePhase3({
      action: "insert",
      account_id: "dbs-nova",
      account_name: "DBS Nova Card",
      payee_name: "Misc",
      amount_cents: -6894,
      date: "2026-09-01",
      currency: "SGD",
      budget_id: "budget-sgd",
      merchant: "BUS/MRT",
      category_id: null,
      _suffix_mappings: [{ suffix: "7111", accountName: "DBS Nova Card" }],
    });
    await flush();

    expect(calls.some((c) => c.name === "learn_fact" && c.args.fact === "Card ending 7111 belongs to DBS Nova Card")).toBe(true);
  });

  it("does not learn suffix mappings when insert fails", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
      executeTool: vi.fn(async (name, args) => {
        calls.push({ name, args });
        if (name === "check_duplicate") return false;
        if (name === "check_schedule_collision") return false;
        if (name === "insert_transaction") throw new Error("AB down");
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);

    const result = await orch._executePhase3({
      action: "insert",
      account_id: "dbs-nova",
      account_name: "DBS Nova Card",
      payee_name: "Misc",
      amount_cents: -6894,
      date: "2026-09-01",
      currency: "SGD",
      budget_id: "budget-sgd",
      merchant: "BUS/MRT",
      category_id: null,
      _suffix_mappings: [{ suffix: "7111", accountName: "DBS Nova Card" }],
    });
    await flush();

    expect(result.action).toBe("error");
    expect(calls.some((c) => c.name === "learn_fact")).toBe(false);
  });

  it("does not choose or learn an ambiguous same-bank bill-payment account", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const orch = new AgentOrchestrator(baseConfig(), {
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context") return {
          accounts: [
            { id: "vista", name: "DBS Vista 1234", closed: false },
            { id: "visa", name: "DBS Visa 1234", closed: false },
          ],
          categories: [],
          payees: [],
        };
        if (name === "search_memory") return { results: [] };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    });
    orch._llm.chat = vi.fn();

    const phase1 = await orch._runPhase1(`
Amount: SGD 12.00
From: My Account (A/C ending 1234)
To: Some Biller (Ref ending 5678)
`, { senderBank: "DBS", receivedAt: "2026-09-01T01:10:00+08:00" });

    expect(phase1).toBeNull();
  });

  it("resolves a unique tail-overlap bill-payment account without learning its suffix", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context") return {
          accounts: [{ id: "visa", name: "DBS Visa 15750", closed: false }],
          categories: [],
          payees: [],
        };
        if (name === "search_memory") return { results: [] };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);
    orch._llm.chat = vi.fn();

    const phase1 = await orch._runPhase1(`
Amount: SGD 12.00
From: My Account (A/C ending 7222)
To: Some Biller (Ref ending 1234)
`, { senderBank: "DBS", receivedAt: "2026-09-01T01:10:00+08:00" });

    expect(phase1).not.toBeNull();
    expect(phase1.account_id).toBe("visa");
    expect(phase1._suffix_mappings).toEqual([]);
  });

  it("does not learn a suffix that only tails account-name digits", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const orch = new AgentOrchestrator(baseConfig(), {
      executeTool: vi.fn(),
      setEmailContext: vi.fn(),
      getPhase1ToolSchemas: vi.fn(() => []),
    });

    const mappings = orch._collectSuffixMappings({
      direction: "outgoing",
      own_account: { bank: "DBS", suffix: "7222" },
    }, {
      source_account: { id: "visa", name: "DBS Visa 15750", closed: false },
      destination_account: null,
      internal: false,
    });

    expect(mappings).toEqual([]);
  });

  it("does not learn a cross-bank bill-payment mapping from substring bank collision", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context") return {
          accounts: [{ id: "discover", name: "Discover Card 7222", closed: false }],
          categories: [],
          payees: [],
        };
        if (name === "search_memory") return { results: [] };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);
    orch._llm.chat = vi.fn();

    const phase1 = await orch._runPhase1(`
Amount: SGD 12.00
From: My Account (A/C ending 7222)
To: Some Biller (Ref ending 1234)
`, { senderBank: "SC", receivedAt: "2026-09-01T01:10:00+08:00" });

    expect(phase1).toBeNull();
  });

  it("does not learn the external counterparty suffix for an incoming transfer", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const orch = new AgentOrchestrator(baseConfig(), {
      executeTool: vi.fn(),
      setEmailContext: vi.fn(),
      getPhase1ToolSchemas: vi.fn(() => []),
    });

    const mappings = orch._collectSuffixMappings({
      direction: "incoming",
      own_account: { bank: "Trust", suffix: "2000" },
      counterparty: { bank: "OCBC", suffix: "6600" },
    }, {
      source_account: { id: "ocbc-111", name: "OCBC 111 6600", closed: false },
      destination_account: { id: "trust-card", name: "Trust Card 2000", closed: false },
      destination_payee: { id: "p", transfer_acct: "trust-card" },
      internal: true,
    });

    expect(mappings).toEqual([
      { suffix: "2000", accountName: "Trust Card 2000" },
    ]);
  });
});
