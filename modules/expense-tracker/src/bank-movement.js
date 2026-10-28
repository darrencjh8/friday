import {
  accountAliases,
  matchAccountByName,
  parseSuffixFact,
  resolveFactAccount,
} from "./suffix-facts.js";

const BANK_ALIASES = [
  ["OCBC", /\b(?:ocbc|oversea[\s-]*chinese\s*banking)\b/i],
  ["DBS", /\b(?:dbs|posb)\b/i],
  ["Trust", /\btrust(?:\s+bank)?\b/i],
  ["Citi", /\b(?:citi|citibank)\b/i],
  ["UOB", /\buob\b/i],
  ["Ryt", /\bryt(?:\s+bank)?\b/i],
  ["SC", /\b(?:sc|standard\s+chartered)\b/i],
  ["HSBC", /\bhsbc\b/i],
  ["Maybank", /\bmaybank\b/i],
  ["CIMB", /\bcimb\b/i],
];

export function bankFromText(value, fallback = null) {
  for (const [bank, re] of BANK_ALIASES) {
    if (re.test(value || "")) return bank;
  }
  return fallback;
}

export function cents(currency, value, direction) {
  const amount = Math.round(Number(String(value).replace(/,/g, "")) * 100);
  if (!Number.isFinite(amount)) return null;
  return direction === "outgoing" ? -amount : amount;
}

function parseTime(raw) {
  const match = String(raw || "").match(/(\d{1,2})[.:](\d{2})\s*(AM|PM)?/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = (match[3] || "").toUpperCase();
  if (minute > 59 || hour > 23) return null;
  if (meridiem && hour <= 12) {
    if (hour === 12) hour = 0;
    if (meridiem === "PM") hour += 12;
  }
  return { hour, minute };
}

function receivedParts(receivedAt) {
  const date = new Date(receivedAt);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const pick = (type) => parts.find((p) => p.type === type)?.value;
  return { year: Number(pick("year")), month: Number(pick("month")), day: Number(pick("day")) };
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function isoDateTime(dateText, timeText, receivedAt) {
  const dateMatch = String(dateText || "").match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s+(\d{4}))?/i);
  const time = parseTime(timeText);
  if (!time) return null;
  const received = receivedParts(receivedAt);
  if (!received) return null;
  let year = received.year;
  let month = received.month;
  let day = received.day;
  if (dateMatch) {
    day = Number(dateMatch[1]);
    month = MONTHS[dateMatch[2].toLowerCase()];
    year = Number(dateMatch[3] || received.year);
  } else {
    // A time-only alert belongs to the closest completed Singapore date.
    const candidate = Date.UTC(year, month - 1, day, time.hour - 8, time.minute);
    const receivedMs = new Date(receivedAt).getTime();
    if (candidate > receivedMs + 5 * 60 * 1000) {
      const prior = new Date(Date.UTC(year, month - 1, day - 1));
      year = prior.getUTCFullYear();
      month = prior.getUTCMonth() + 1;
      day = prior.getUTCDate();
    }
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}:00+08:00`;
}

function field(text, labels) {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = String(text).match(new RegExp(`(?:^|\\n)\\s*(?:${escaped})\\s*:\\s*([^\\n]+)`, "i"));
  return match?.[1]?.trim() || "";
}

/**
 * The labelled reference as the email's own line ends it. The flattened text the
 * parser reads runs a trailing `Reference:` into the boilerplate that follows,
 * so a line-preserved copy bounds it. The line value wins only when the parsed
 * one starts with it; any other disagreement keeps the parser's value.
 */
export function exactReference(linesText, parsedReference) {
  const exact = field(linesText, ["Reference number", "Transaction Ref", "Reference"]);
  return exact && String(parsedReference || "").startsWith(exact) ? exact : parsedReference;
}

// Labels recognised by field(), longest-first so prefixed variants
// ("From your account") win over their short forms ("From").
const FIELD_LABELS = [
  "Account that money was deposited in",
  "Reference number",
  "Transaction Ref",
  "Date of Transfer",
  "Date of Payment",
  "Transfer Date",
  "Date and Time",
  "Time of Transfer",
  "Time of Payment",
  "Time of deposit",
  "From your account",
  "To account",
  "To payee",
  "Description",
  "Reference",
  "Amount",
  "From",
  "To",
  "Date",
  "Time",
];

// extractEmailContent() collapses whitespace, so a labelled alert body can
// arrive as one line and field()'s line-start anchors never fire. Re-insert a
// line break before each known label that is not already at a line start so
// the deterministic parser keeps working without loosening account matching.
//
// Re-inserting the break is the whole fix: once every label sits at a line
// start, the original single-line read in field() stops at the line break and
// each value is bounded. A flattened body
// ("Date of Transfer:01 Oct 2026Time of Transfer:12.36 AM SGT") has no
// newlines, so the later label used to win the greedy read and the date became
// "01 Oct 2026Time of Transfer:12.36 AM SGT" — the transfer then never parsed
// at all (OCBC "We have processed your funds transfer request", uid 1029,
// 2026-10-01). Verified: reverting this normalisation alone reproduces that.
function restoreFieldLines(text) {
  const escaped = FIELD_LABELS.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`(?<![\\n\\r])(?:${escaped})\\s*:`, "gi");
  return String(text).replace(re, "\n$&");
}

export function suffix(value) {
  const match = String(value || "").match(/(?:ending\s+|\(-)(\d{4,})\)?/i);
  return match?.[1] || null;
}

/**
 * Trailing account digits in a masked alert, e.g. "OCBC 360 ACCOUNT ******2444"
 * or "ACCOUNT HOLDER (********2333)". Bare 4-6 digit runs are deliberately not
 * matched: a reference number must never be read as an account.
 */
function maskedSuffix(value) {
  // A masked phone number ("(+******1234)") is a PayNow proxy, not an account.
  const match = String(value || "").match(/(?<![+*])\*{2,}\s*(\d{4,})\b/);
  return match?.[1] || null;
}

/** "<NAME> using his/her Mobile (+******1234)": a PayNow mobile/NRIC proxy. */
const PAYNOW_PROXY_RE = /\s+using\s+his\/her\s+(?:Mobile|NRIC|FIN)\b.*$/i;

function namedAccount(value, fallbackBank) {
  if (!value) return null;
  // The flattened DBS body runs "To: NAME A/C ending 2555" into the footer
  // ("If unauthorised, please call ..."), so the account ends at its digits.
  const text = String(value).replace(/^(.*?\bA\/C\s+ending\s+\d{4,})\b.*$/i, "$1");
  return {
    name: text.replace(/\s*\((?:A\/C|Ref)?\s*(?:ending\s+)?-?\*{0,}\d+\)[^)]*$/i, "")
      .replace(/\s+A\/C\s+ending\s+\d{4,}$/i, "")
      .replace(PAYNOW_PROXY_RE, "")
      .replace(/\s*\*+\d*\s*$/, "").trim(),
    bank: bankFromText(text, fallbackBank),
    suffix: suffix(text) || maskedSuffix(text),
    // The bare "NAME A/C ending NNNN" form names an account, not a merchant.
    ...(/\bA\/C\s+ending\s+\d{4,}$/i.test(text) && !/\(\s*A\/C/i.test(text) ? { account_ending: true } : {}),
  };
}

function baseMovement({ direction, amount, currency, occurredAt, ownAccount, counterparty = null, reference = "", merchant = null, descriptor = "", isPayNow = false, isPayNowMerchant = false, recipientBank = null }) {
  if (!amount || !currency || !occurredAt || !ownAccount?.suffix) return null;
  return {
    kind: "bank_movement",
    is_paynow: isPayNow,
    is_paynow_merchant: isPayNowMerchant,
    direction,
    amount_cents: cents(currency, amount, direction),
    currency: currency.toUpperCase(),
    occurred_at: occurredAt,
    own_account: ownAccount,
    counterparty,
    reference_number: reference,
    // The bank that sent the alert, when the credited own account has no other
    // evidence of it. The inbound FAST branch sets it so the recipient-account
    // fallback in `resolveMovementAccounts` can still name the leg (issue #598).
    recipient_bank: recipientBank,
    merchant_display_name: merchant,
    raw_merchant_descriptor: descriptor,
  };
}

/**
 * True when a counterparty string is a bare person name rather than a
 * business. Deliberately structural and list-free: a person name has 2-4
 * alphabetic tokens and no company, bank, or digit token. It is used only to
 * decide that an alert leg is a person-to-person movement whose destination
 * cannot be verified, never to identify a specific person.
 */
export function looksLikePersonName(value) {
  // Trailing punctuation is decoration, not a token: "ACME LIMITED." and
  // "ACME S.A." must be judged on their words. Stripping it here also keeps the
  // every-token test below from accepting a dotted business suffix.
  const tokens = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/[.,;:]+$/, ""))
    .filter(Boolean);
  if (tokens.length < 2 || tokens.length > 4) return false;
  // A bare number is never part of a person name ("365 BAKERY" is a business),
  // but "S.A." and "BHD." must still be recognised as organisation words, so
  // this runs on the de-punctuated token.
  if (tokens.some((token) => /^\d+$/.test(token))) return false;
  const NON_PERSON = new Set([
    // Malaysian / Singaporean private limited forms
    "pte", "ltd", "llp", "plc", "plt", "sdn", "bhd", "berhad", "sendirian",
    "pteltd", "sdnbhd",
    // Other corporate forms
    "inc", "co", "corp", "company", "limited", "llc", "gmbh", "ag", "sa",
    "nv", "bv", "oy", "ab", "as",
    // Group / trade words
    "group", "holdings", "enterprise", "enterprises", "trading", "services",
    "service",
    // Geography and business descriptors
    "singapore", "malaysia", "bank", "clinic", "wallet", "store", "shop",
    "restaurant", "cafe",
  ]);
  return tokens.every((token) => {
    if (!/^[A-Za-z][A-Za-z'’.-]*$/.test(token)) return false;
    // Dotted forms are the same word: "S.A." must hit the "sa" entry.
    return !NON_PERSON.has(token.replace(/\./g, "").toLowerCase());
  });
}

export function parseBankMovement(text, { senderBank = null, receivedAt } = {}) {
  const body = restoreFieldLines(String(text || ""));
  const reference = field(body, ["Reference number", "Transaction Ref", "Reference"]);

  // Bank card-payment alert — no "Amount :" label.
  //   "RM200.00 was paid at TNG-EWALLET ECOM 3-EC using your Main Account on 2/9/2026, 12:46 AM (GMT+8)."
  const ryt = body.match(/(SGD|RM|MYR)\s*([\d,.]+)\s+was paid at\s+(.+?)\s+using\s+(.+?)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})\s*,?\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
  if (ryt) {
    const currency = /^RM$/i.test(ryt[1]) || /^MYR$/i.test(ryt[1]) ? "MYR" : "SGD";
    const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const [d, mo, y] = ryt[5].split("/").map((n) => Number(n));
    const month = monthNames[mo - 1];
    if (!month || !Number.isFinite(d) || !Number.isFinite(y)) return null;
    const occurredAt = isoDateTime(`${d} ${month} ${y}`, ryt[6], receivedAt);
    if (!occurredAt) return null;
    const merchant = ryt[3].trim();
    return {
      kind: "bank_movement", direction: "outgoing",
      amount_cents: cents(currency, ryt[2], "outgoing"), currency,
      occurred_at: occurredAt,
      own_account: { name: ryt[4].trim(), bank: senderBank, suffix: null },
      counterparty: { name: merchant, bank: bankFromText(merchant), suffix: null },
      reference_number: "", recipient_bank: null,
      merchant_display_name: merchant,
      raw_merchant_descriptor: merchant,
    };
  }

  // Ryt transfer and payment alerts use sentence forms rather than labels.
  // The credited account is implicit for a received alert; a sent/paid alert
  // states the source after "using your".
  //
  // The sentence ships inside a marketing template: a banner above it and a
  // confidentiality footer below, with the `using your <account>` clause often
  // wrapped across a newline. So the search is neither line-anchored nor
  // end-anchored — it matches the sentence anywhere, over collapsed whitespace,
  // and ends at the sentence's own full stop.
  const rytSentence = body
    .replace(/\s+/g, " ")
    .match(
      /you'?ve\s+(received|sent|paid)\s+(SGD|RM|MYR)\s*([\d,.]+)\s+(?:from|to)\s+(.+?)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})\s*,?\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?)(?:\s*\(GMT\+8\))?(?:\s+using\s+your\s+([^.]+?))?\./i,
    );
  if (rytSentence) {
    const direction = rytSentence[1].toLowerCase() === "received" ? "incoming" : "outgoing";
    const currency = /^RM$/i.test(rytSentence[2]) || /^MYR$/i.test(rytSentence[2]) ? "MYR" : "SGD";
    const [day, monthNumber, year] = rytSentence[5].split("/").map(Number);
    const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const month = monthNames[monthNumber - 1];
    const occurredAt = month && isoDateTime(`${day} ${month} ${year}`, rytSentence[6], receivedAt);
    if (!occurredAt) return null;
    const counterparty = rytSentence[4].trim();
    const ownAccount = rytSentence[7]?.trim() || null;
    // A "received/sent/paid ... from|to <NAME>" alert is a person-to-person
    // movement, not a merchant payment. The `paid ... to <MERCHANT>` forms are NOT
    // separated out into a branch of their own — they reach this same line (the
    // pinned `You've paid RM255.00 to CLINIC MERCHANT` and `365 BAKERY` alerts do,
    // verified) and they carry this key; what protects them is
    // `looksLikePersonName` rejecting a business descriptor, not branch
    // separation. When the counterparty
    // is a bare person name it cannot be resolved to a tracked account or a real
    // merchant, so Phase 2 holds it instead of booking the holder's own money as
    // spend or income (#585). `paid` belongs in this list: the sentence form
    // "You've paid RMx to <PERSON> ... using your <account>" is a transfer to a
    // person wearing the same verb as a merchant payment, and excluding it left
    // the Critical open on that form.
    const personTransfer =
      /^(received|sent|paid)$/i.test(rytSentence[1]) && looksLikePersonName(counterparty);
    return {
      kind: "bank_movement", direction,
      amount_cents: cents(currency, rytSentence[3], direction), currency,
      occurred_at: occurredAt,
      own_account: { name: ownAccount, bank: senderBank, suffix: null },
      counterparty: { name: counterparty, bank: bankFromText(counterparty), suffix: null },
      reference_number: "", recipient_bank: direction === "incoming" ? senderBank : null,
      person_transfer: personTransfer,
      merchant_display_name: direction === "outgoing" ? counterparty : null,
      raw_merchant_descriptor: direction === "outgoing" ? counterparty : "",
    };
  }

  // Ryt scheduled-transfer completion — the third Ryt sentence form, and the
  // one that is not a "you've sent/received/paid" sentence:
  //   "Your scheduled transfer of RM908.25 to ACCOUNT HOLDER on 1/10/2026,
  //    10:02 AM (GMT+8) was successfully completed."
  // Without this branch the alert matches nothing, returns null, and the whole
  // email falls through to the LLM extractor — which cannot parse it either,
  // so the user gets "Couldn't understand email ... re: Scheduled transfer
  // completed successfully!" and the movement is never recorded (uid 999/1010/
  // 1012, 2026-10-01; three alerts in one run). The amount, destination and
  // time are all present in the sentence, so it is parsed rather than guessed.
  //
  // The completion clause is REQUIRED, not decoration. The same opening
  // sentence is used for notices that are not money movements — "was
  // unsuccessful", "is pending approval", a reminder that it "will be
  // processed". Matching the prefix alone booked those as real debits.
  const rytScheduled = body
    .replace(/\s+/g, " ")
    .match(
      /scheduled transfer of\s+(SGD|RM|MYR)\s*([\d,.]+)\s+to\s+(.+?)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})\s*,?\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?)(?:\s*\(GMT\+8\))?\s*(?:was|has\s+been)\s+(?:successfully\s+completed|completed\s+successfully)/i,
    );
  if (rytScheduled) {
    const currency = /^RM$/i.test(rytScheduled[1]) ? "MYR" : rytScheduled[1].toUpperCase();
    const [day, monthNumber, year] = rytScheduled[4].split("/").map(Number);
    const month = MONTH_NAMES[monthNumber - 1];
    const occurredAt = month && isoDateTime(`${day} ${month} ${year}`, rytScheduled[5], receivedAt);
    if (!occurredAt) return null;
    const counterparty = rytScheduled[3].trim();
    // A scheduled transfer always leaves the named source account, so it is
    // outgoing. The sentence does not carry the source account, so name and
    // suffix are left null on purpose: resolution falls back to the sender
    // bank, and holds rather than guessing when that is ambiguous. Do NOT
    // invent "Main Account" here — the alert never says it.
    return {
      kind: "bank_movement", direction: "outgoing",
      amount_cents: cents(currency, rytScheduled[2], "outgoing"), currency,
      occurred_at: occurredAt,
      own_account: { name: null, bank: senderBank, suffix: null },
      counterparty: { name: counterparty, bank: bankFromText(counterparty), suffix: null },
      reference_number: "",
      recipient_bank: null,
      person_transfer: looksLikePersonName(counterparty),
      merchant_display_name: counterparty,
      raw_merchant_descriptor: counterparty,
    };
  }

  // Trust credit-card repayment confirmation — names neither account:
  //   "Your credit card repayment of S$ 1.00 on 16 Sep 2026 07:55 SGT is successful."
  // The destination is the sender bank's own credit card and the funding
  // account is unstated, so neither carries a suffix. `card_repayment` tells the
  // orchestrator to resolve both legs from the holder's accounts and to hold
  // when it cannot do so unambiguously (issue #576).
  const trustRepayment = body.replace(/\s+/g, " ").match(
    /credit\s+card\s+repayment\s+of\s+(SGD|S\$)\s*([\d,.]+)\s+on\s+(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})\s+(\d{1,2}[:.]\d{2}\s*(?:AM|PM)?)\s*SGT\s+is\s+successful\b/i,
  );
  if (trustRepayment && /^trust$/i.test(senderBank || "")) {
    const occurredAt = isoDateTime(trustRepayment[3], trustRepayment[4], receivedAt);
    if (!occurredAt) return null;
    return {
      kind: "bank_movement", direction: "outgoing",
      amount_cents: cents("SGD", trustRepayment[2], "outgoing"), currency: "SGD",
      occurred_at: occurredAt,
      own_account: { name: null, bank: "Trust", suffix: null },
      counterparty: { name: "Trust Credit Card", bank: "Trust", suffix: null },
      reference_number: "", recipient_bank: null,
      card_repayment: true,
      merchant_display_name: null, raw_merchant_descriptor: "",
    };
  }

  // Trust outgoing PayNow: "Your PayNow transfer of SGD 1.00 from A/C ending
  // 1234 to ABCXX DEXX on 12 Oct 2026 00:41 SGT is successful." Trust masks the
  // recipient's name, so a masked payee (a token ending "XX") cannot be told
  // from the holder's own name by the text alone; `masked_payee` makes the
  // orchestrator look for the matching credit on the holder's own accounts.
  const trustPayNow = senderBank && /^trust$/i.test(senderBank)
    ? body.replace(/\s+/g, " ").match(/PayNow\s+transfer\s+of\s+(SGD|MYR)\s*([\d,.]+)\s+from\s+A\/C\s+ending\s+(\d{4,})\s+to\s+(.+?)\s+on\s+(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})\s+(\d{1,2}[:.]\d{2}\s*(?:AM|PM)?)\s*SGT\b/i)
    : null;
  if (trustPayNow) {
    const payee = trustPayNow[4].trim();
    const movement = baseMovement({
      direction: "outgoing", amount: trustPayNow[2], currency: trustPayNow[1],
      occurredAt: isoDateTime(trustPayNow[5], trustPayNow[6], receivedAt),
      ownAccount: { bank: "Trust", suffix: trustPayNow[3] },
      counterparty: { name: payee, bank: null, suffix: null },
      reference,
      isPayNow: true,
    });
    // Any other Trust PayNow keeps going to the LLM extractor as before.
    if (movement && payee.split(/\s+/).some((token) => /^[A-Za-z]+X{2,}$/.test(token))) {
      movement.masked_payee = true;
      return movement;
    }
  }

  // Trust's text/plain part can wrap the counterparty name at a column
  // boundary. Matching on collapsed whitespace keeps the parser independent
  // of MIME line wrapping while preserving the original body for labels.
  const trust = body.replace(/\s+/g, " ").match(/received\s+(SGD|MYR)\s*([\d,.]+)\s+from\s+(.+?)\s+A\/C\s+ending\s+(\d{4,})\s+on\s+(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})\s+(\d{1,2}[:.]\d{2}\s*(?:AM|PM)?)\s*SGT/i);
  if (trust) {
    return baseMovement({
      direction: "incoming", amount: trust[2], currency: trust[1],
      occurredAt: isoDateTime(trust[5], trust[6], receivedAt),
      ownAccount: { bank: senderBank || "Trust", suffix: null },
      counterparty: { name: trust[3].trim(), bank: bankFromText(trust[3]), suffix: trust[4] },
      reference,
    }) || {
      kind: "bank_movement", direction: "incoming", amount_cents: cents(trust[1], trust[2], "incoming"), currency: trust[1],
      occurred_at: isoDateTime(trust[5], trust[6], receivedAt), own_account: null,
      counterparty: { name: trust[3].trim(), bank: bankFromText(trust[3]), suffix: trust[4] }, reference_number: reference,
      recipient_bank: senderBank || "Trust", merchant_display_name: null, raw_merchant_descriptor: "",
    };
  }

  // UOB "You made/scheduled a funds transfer(s) of ... to X a/c ending N
  // from your a/c ending M at TIME SGT, DATE" confirmation — a sentence-style
  // alert with no labelled fields, unlike the OCBC/DBS "Amount:"/"From:" layouts.
  const uobFast = body.match(
    /transfer\(?s?\)?\s+of\s+(SGD|MYR)\s*([\d,.]+)\s+to\s+(.+?)\s+a\/c\s+ending\s+(\d{4,})\s+from\s+your\s+a\/c\s+ending\s+(\d{4,})\s+at\s+(\d{1,2}[:.]\d{2}\s*(?:AM|PM)?)\s*SGT,?\s*(\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4})/i,
  );
  if (uobFast) {
    const currency = /^MYR$/i.test(uobFast[1]) ? "MYR" : "SGD";
    const toName = uobFast[3].trim();
    const occurredAt = isoDateTime(uobFast[7], uobFast[6], receivedAt);
    if (!occurredAt) return null;
    return baseMovement({
      direction: "outgoing",
      amount: uobFast[2],
      currency,
      occurredAt,
      ownAccount: { bank: senderBank || "UOB", suffix: uobFast[5] },
      counterparty: {
        name: toName,
        bank: bankFromText(toName, senderBank),
        suffix: uobFast[4],
      },
      reference,
    });
  }

  // DBS inbound FAST transfer notice — no "Amount :" label.
  //   "You have received SGD 1000.00 via FAST transfer on 23 Sep 2026 00:36  SGT.
  //    From: ACCOUNT HOLDER
  //    To: Your DBS/ POSB account ending 5500"
  // The credited account is named only by the "To:" mask, so that suffix is the
  // own account. Without this branch the body exits at the `Amount :` guard
  // below, the whole alert falls through to the LLM extractor, and one FAST
  // transfer books as two separate Misc rows (issue #598).
  const dbsReceived = body
    .replace(/\s+/g, " ")
    .match(
      /You have received\s+(SGD|MYR)\s*([\d,.]+)\s+via\s+FAST transfer\s+on\s+(.+?)(?=\s*From:|\s*To:|$)/i,
    );
  if (dbsReceived) {
    const ownSuffix = suffix(
      body.match(/(?:^|\n)\s*To\s*:\s*([^\n]+)/i)?.[1] || "",
    );
    if (!ownSuffix) return null;
    return baseMovement({
      direction: "incoming",
      amount: dbsReceived[2],
      currency: dbsReceived[1],
      occurredAt: isoDateTime(dbsReceived[3], dbsReceived[3], receivedAt),
      ownAccount: { bank: senderBank, suffix: ownSuffix },
      counterparty: namedAccount(
        body.match(/(?:^|\n)\s*From\s*:\s*([^\n]+)/i)?.[1],
        null,
      ),
      reference,
      recipientBank: senderBank,
    });
  }

  // SC "Confirmation Advice for FAST Transaction" (uid 977, 2026-09-28):
  //   "From account: ******2555
  //    To account: ******7222
  //    Amount: 1,275.00
  //    Currency: SGD
  //    Transaction due date: 28/09/2026 10:08:02
  //    Transaction type: FAST"
  // SC states the currency and the amount on SEPARATE labels, so the
  // `Amount : <CCY> <n>` guard below never matches and the whole alert used to
  // fall through to the LLM extractor. That is not cosmetic: this is the only
  // alert that names the SOURCE account of an own-account transfer as a bare
  // masked suffix, with no account name or bank on the value (which is why this
  // branch reads `From account:` / `To account:` directly rather than via
  // `field()`); a receiving-bank alert names the sender as a person instead,
  // never an account. (OCBC also names a source account, but with a name and
  // bank attached.) Losing it
  // means the pair cannot link — the receiving side holds and this side books
  // unlinked, so the transfer is booked twice or not at all. That is the
  // source-account-alert half of #598, tracked on its own at #641.
  //
  // It also has to survive being FORWARDED, which is how a user gets it into
  // the tracker's own mailbox when the sending bank does not alert it. A
  // forwarded copy carries a `From: <the bank's online-banking sender>`
  // header that would otherwise win the `From` label, so this branch reads the
  // explicit "From account" / "To account" labels directly rather than via
  // `field()`.
  // Read on the flattened copy so the labels are matched the same way whether
  // the body arrived line-separated or already collapsed to one line. The
  // masked-digit form is required deliberately: a "To account" with no
  // resolvable digits is refused below rather than fabricated.
  const scFlat = body.replace(/\s+/g, " ");
  const scFast = scFlat.match(
    /From account\s*:\s*(\*+\d+)\s+To account\s*:\s*(\*+\d+)/i,
  );
  // Gated on the SENDING BANK'S OWN SIGNATURE, not on `senderBank` and not on
  // `bankFromText`.
  //
  // `senderBank` is `bankFromSender(from)` — the outer `From:` header, which
  // for a forwarded advice is the forwarder, not Standard Chartered. That is
  // exactly the case this branch exists for (the advice is normally forwarded
  // by hand, because SC does not alert the tracker's own mailbox), so gating on
  // it would refuse the alert the branch was written to parse.
  //
  // `bankFromText(body)` is no better: the real advice carries a
  // "Payee Bank: DBS" line naming the RECIPIENT's bank, so it resolves to DBS
  // and would refuse the genuine article. It also matches by alias order, so it
  // answers "which bank is mentioned", not "which bank sent this".
  //
  // The closing line ("Thank you for using Standard Chartered Online Banking")
  // is the sending bank's own words, present on every advice and retained
  // verbatim through a forward. "From account" / "To account" is generic FAST
  // vocabulary, so this is also what stops another bank's inbound advice in the
  // same shape being booked outgoing from the recipient's account.
  if (scFast && /Standard\s+Chartered\s+Online\s+Banking/i.test(scFlat)) {
    // One advice only (#639). The account pair and the digits-only `Amount:`
    // are generic FAST vocabulary, so a forward carrying a second advice can
    // supply them from the wrong one. The span cannot be recovered reliably
    // (a foreign advice may also quote the SC signature), so when more than
    // one pair or amount is present refuse rather than guess.
    const pairCount = (
      scFlat.match(/From account\s*:\s*\*+\d+\s+To account\s*:\s*\*+\d+/gi) || []
    ).length;
    const amountCount = (scFlat.match(/Amount\s*:\s*[\d,.]+/gi) || []).length;
    if (pairCount !== 1 || amountCount !== 1) return null;
    const [, fromValue, toValue] = scFast;
    const amountText = scFlat.match(/Amount\s*:\s*([\d,.]+)/i)?.[1] || "";
    // No fallback. Every other branch takes its currency from an explicit
    // (SGD|MYR) match and refuses when that is absent; substituting the sending
    // bank here would be the one place a record can be written with
    // `currency: "SC"`, which `baseMovement` only truthiness-checks.
    const currencyText = scFlat.match(/Currency\s*:\s*(SGD|MYR)/i)?.[1] || "";
    // "Transaction due date" is dd/mm/yyyy hh:mm:ss, but `isoDateTime` only
    // reads an `28 Sep`-style date (plus a bare time). Passing the raw string to
    // both arguments therefore looked right and silently used the *received*
    // date, which is wrong precisely when it matters: a forwarded advice filed
    // days later would date the transfer to the forwarding date. Normalise the
    // day and month into the form `isoDateTime` actually parses.
    const dueRaw = scFlat.match(
      /Transaction due date\s*:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+([\d:]+)/i,
    );
    const dueText = dueRaw
      ? `${dueRaw[1]} ${MONTH_NAMES[Number(dueRaw[2]) - 1]} ${dueRaw[3]} ${dueRaw[4]}`
      : "";
    const scReference =
      scFlat.match(/Transaction reference\s*:\s*(SG\d+)/i)?.[1] || reference;

    // The gate above has already established that Standard Chartered sent this,
    // so name the accounts from the advice itself rather than from
    // `senderBank`. `senderBank` is the outer `From:` header, which on the
    // forwarded path this branch now serves is the FORWARDER: forwarding from
    // an OCBC address would otherwise label SC account 2555 as OCBC. The
    // masked values carry no bank name, so `bankFromText` cannot recover it
    // from "******2555" — only the fallback decides.
    const ownAccount = namedAccount(fromValue, "SC");
    // "Payee Bank: DBS" names the RECIPIENT's bank and is the only statement of
    // it in the advice; `bankFromText("******7222")` can only ever return null,
    // so read the label instead of discarding the evidence. The value is
    // delimited by the next known label, because the real advice leaves this
    // field EMPTY ("Payee Bank: Transaction message:") and a bank name must not
    // be allowed to run into the following field's text.
    // The label is the bank's legal name ("DBS BANK LIMITED"); normalise it to
    // the tracker's bank key, or account facts scoped to "DBS" never match.
    const destinationBank =
      bankFromText(
        scFlat.match(
          /Payee Bank\s*:\s*([A-Za-z][A-Za-z .-]*?)\s+Transaction message\s*:/i,
        )?.[1]?.trim(),
        null,
      ) || bankFromText(toValue);
    const destination = namedAccount(toValue, destinationBank);
    // The regex already requires digits in both captures, so these guards are
    // defence in depth: decline rather than fabricate a partial movement.
    if (!destination?.suffix || !amountText || !ownAccount?.suffix) return null;
    if (!currencyText || !dueRaw) return null;
    return baseMovement({
      direction: "outgoing",
      amount: amountText,
      currency: currencyText,
      occurredAt: isoDateTime(dueText, dueText, receivedAt),
      ownAccount,
      counterparty: destination,
      reference: scReference,
    });
  }

  const currencyAmount = body.match(/Amount\s*:\s*(SGD|MYR)\s*([\d,.]+)/i);
  if (!currencyAmount) return null;
  const [, currency, amount] = currencyAmount;

  const deposited = field(body, ["Account that money was deposited in"]);
  if (deposited) {
    const payNowSender = body.match(/PayNow\s+transfer\s+from\s+(.+?)(?:\n|$)/i)?.[1]
      ?.replace(/[.,;:!?]+$/, "").trim();
    // OCBC one-sided deposits carry the sender solely in "Reference: from X".
    // Preserve that evidence so Phase 2 can hold an unverified person transfer
    // instead of turning it into income (#584).
    // The flattened body runs the reference into the footer ("For assistance
    // at any time, ..."), so the name ends where that sentence starts.
    const referenceSender = reference.match(/^from\s+(.+?)(?:\s+For assistance\b.*)?$/i)?.[1]
      ?.replace(/[.,;:!?]+$/, "").trim();
    const sender = payNowSender || referenceSender;
    return baseMovement({
      direction: "incoming", amount, currency,
      occurredAt: isoDateTime("", field(body, ["Time of deposit"]), receivedAt),
      ownAccount: { bank: senderBank, suffix: suffix(deposited) },
      counterparty: sender ? namedAccount(sender, bankFromText(sender)) : null,
      reference,
      isPayNow: /\bPayNow\b/i.test(body),
    });
  }

  const from = field(body, ["From your account", "From"]);
  const to = field(body, ["To account", "To payee", "To"]);
  const dateText = field(body, ["Date of Transfer", "Date of Payment", "Transfer Date", "Date and Time", "Date"]);
  const timeText = field(body, ["Time of Transfer", "Time of Payment", "Time"])
    || (dateText.match(/\d{1,2}[:.]\d{2}\s*(?:AM|PM)?/i)?.[0] || "");

  if (!from) return null;
  const ownAccount = namedAccount(from, senderBank);
  const destination = namedAccount(to, bankFromText(to));
  const payNow = /PayNow\s+transfer/i.test(body) && !to;
  const merchantMatch = body.match(/made to\s+(.+?)\s+using their\s+Unique Entity Number/i);
  const payNowRecipient = body.match(
    /PayNow\s+transfer\s+has\s+been\s+made\s+to\s+(.+?)(?:\s+using their\s+Unique Entity Number|\n|$)/i,
  )?.[1]?.replace(/[.,;:!?]+$/, "").trim();
  // Decline rather than fabricate a movement when we cannot identify which
  // tracked account (if any) "To:" refers to. This shape (generic From/To
  // labels) is also used by ordinary card-purchase alerts where "To:" is a
  // merchant, not an account — e.g. "To: BUS/MRT" (issue #398). Without this
  // check, that silently collapses to counterparty:null/merchant:null and
  // then a generic "Bank payment" placeholder downstream, destroying the
  // real merchant before fetch_context/search_memory/the LLM are ever
  // consulted. PayNow-UEN payments are the one case with a real merchant
  // name (via merchantMatch) despite having no tracked destination account.
  if (!destination?.suffix && !payNow) return null;
  const descriptor = field(body, ["Description"]);
  // A recipient reached by mobile number or NRIC is a person: the proxy names
  // no account, so nothing can verify who it is (bank-movement person hold).
  const proxyRecipient = !destination?.suffix && !merchantMatch && PAYNOW_PROXY_RE.test(payNowRecipient || "");
  const movement = baseMovement({
    direction: "outgoing", amount, currency,
    occurredAt: isoDateTime(dateText, timeText, receivedAt),
    ownAccount,
    counterparty: destination?.suffix
      ? destination
      : payNowRecipient && !merchantMatch
        ? namedAccount(payNowRecipient, bankFromText(payNowRecipient))
        : null,
    reference,
    merchant: payNow ? merchantMatch?.[1]?.trim() || null : null,
    descriptor,
    isPayNow: payNow,
    isPayNowMerchant: Boolean(merchantMatch),
  });
  if (movement && proxyRecipient) movement.person_transfer = true;
  return movement;
}

export function accountMatches(account, evidence) {
  if (!account?.name || account.closed || !evidence?.suffix) return false;
  const bank = bankFromText(account.name);
  if (evidence.bank && bank !== evidence.bank) return false;
  const digits = [...account.name.matchAll(/\d{4,}/g)].map((match) => match[0]);
  return digits.some((value) => value === evidence.suffix || evidence.suffix.endsWith(value) || value.endsWith(evidence.suffix));
}

function resolveAccount(evidence, accounts) {
  if (!evidence?.suffix) return null;
  const matches = accounts.filter((account) => accountMatches(account, evidence));
  return matches.length === 1 ? matches[0] : null;
}

export function identityMappingsFromFacts(facts, accounts) {
  const mappings = {
    suffix: new Map(),
    recipient: new Map(),
    aliases: accountAliases(facts, accounts),
  };
  for (const fact of facts || []) {
    const text = typeof fact === "string" ? fact : fact?.text || "";
    const parsed = parseSuffixFact(text);
    if (parsed) {
      // One shared resolver: normal matching, then a bounded filler-word
      // retry that only accepts an exact account name. Never containment, so a
      // named-but-absent account cannot resolve to a live sibling.
      // Aliases are deliberately NOT applied on this path: it can run with an
      // unknown bank (`evidence.bank` null leaves the candidate set unfiltered),
      // so a cross-bank alias could book the wrong account. The orchestrator
      // paths apply aliases and then check the resolved name against the sender
      // bank. Review round 1 on c1e1d10.
      const resolution = resolveFactAccount(parsed.accountName, accounts);
      const account = resolution.matched
        ? accounts.find((a) => a.id === resolution.id)
        : null;
      if (account) {
        const known = mappings.suffix.get(parsed.suffix);
        if (!mappings.suffix.has(parsed.suffix)) {
          mappings.suffix.set(parsed.suffix, account);
        } else if (known && known.id !== account.id) {
          mappings.suffix.set(parsed.suffix, null);
        }
      }
      continue;
    }
    const recipientMatch = text.match(/^(.+?)\s+alert recipient maps to\s+(.+?)\s+account$/i);
    if (recipientMatch) {
      const account = accounts.find((a) => a.name?.toLowerCase() === recipientMatch[2].trim().toLowerCase() && !a.closed);
      if (account) mappings.recipient.set(bankFromText(recipientMatch[1]), account);
    }
  }
  return mappings;
}

function hasConflictingMapping(evidence, mappings) {
  if (!evidence?.suffix) return false;
  return [...mappings.suffix.entries()].some(([knownSuffix, account]) =>
    !account && (
      knownSuffix === evidence.suffix ||
      knownSuffix.endsWith(evidence.suffix) ||
      evidence.suffix.endsWith(knownSuffix)
    ),
  );
}

function resolveMappedAccount(evidence, mappings) {
  if (!evidence?.suffix) return null;
  const matching = [...mappings.suffix.entries()].filter(([knownSuffix, account]) =>
    account && (
      knownSuffix === evidence.suffix ||
      knownSuffix.endsWith(evidence.suffix) ||
      evidence.suffix.endsWith(knownSuffix)
    ),
  );
  // A banked fact must match the evidence bank; bankless legacy facts stay
  // eligible so historical mappings for bankless account names still resolve.
  // Without this, a DBS fact could silently book an OCBC alert that happens
  // to share the same 4-digit suffix.
  const bankScoped = evidence.bank
    ? matching.filter(([, account]) => {
        const bank = bankFromText(account?.name);
        return bank === null || bank === evidence.bank;
      })
    : matching;
  const unique = [
    ...new Map(
      bankScoped.map(([, account]) => [account.id, account]),
    ).values(),
  ];
  // Dedup by account so two suffix aliases that resolve to the SAME account
  // (e.g. Beta 360 as both 166600 and 6600) are not treated as ambiguous.
  return unique.length === 1 ? unique[0] : null;
}

function resolveAccountByBank(evidence, accounts) {
  if (!evidence?.bank) return null;
  const matches = accounts.filter((a) => !a.closed && bankFromText(a.name) === evidence.bank);
  return matches.length === 1 ? matches[0] : null;
}

export function resolveMovementAccounts(movement, accounts, payees, mappings = { suffix: new Map(), recipient: new Map() }) {
  const ownConflict = hasConflictingMapping(movement.own_account, mappings);
  const otherConflict = hasConflictingMapping(movement.counterparty, mappings);
  const own = ownConflict ? null : (
    resolveMappedAccount(movement.own_account, mappings)
      || resolveAccount(movement.own_account, accounts)
      || resolveAccountByBank(movement.own_account, accounts)
      || (movement.direction === "incoming" && movement.recipient_bank
        ? mappings.recipient.get(movement.recipient_bank) || null
        : null)
  );
  const namedOther = movement.counterparty?.name
    ? matchAccountByName(movement.counterparty.name, accounts, mappings.aliases)
    : null;
  const other = otherConflict ? null : (
    resolveMappedAccount(movement.counterparty, mappings)
      || resolveAccount(movement.counterparty, accounts)
      || (namedOther?.matched
        ? accounts.find((account) => account.id === namedOther.id) || null
        : null)
  );
  const destination = movement.direction === "outgoing" ? other : own;
  // For a one-sided incoming movement (deposit into own account, no counterparty),
  // the source is the own account that received the funds.
  const source = movement.direction === "outgoing" ? own : (other || own);
  const sourcePayee = source
    ? payees.find((payee) => payee.transfer_acct === source.id) || null
    : null;
  const destinationPayee = destination
    ? payees.find((payee) => payee.transfer_acct === destination.id) || null
    : null;
  // Incoming alerts are booked on the credited account, so prefer the sending
  // account's transfer payee; legacy alerts can still reserve with destination.
  const transferPayee = movement.direction === "incoming"
    ? sourcePayee || destinationPayee
    : destinationPayee;
  return {
    source_account: source,
    destination_account: destination,
    destination_payee: transferPayee,
    internal: !!(source && destination && source.id !== destination.id && transferPayee),
  };
}
