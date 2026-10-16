/**
 * IBKR Flex Query XML parser.
 * Ported 1:1 from src/extractors/ibkr_parser.py
 *
 * Parses IBKR flex query XML into structured transaction objects.
 * Handles namespace-aware and namespace-less XML.
 * Parses: Trades, CashTransactions, CorporateActions.
 */

const IBKR_NS = "http://www.interactivebrokers.com/flex/statement";

const TRADE_TYPE_MAP = {
    BUY: "Buy",
    SELL: "Sell",
    "BUY (CA)": "Buy",
    "SELL (CA)": "Sell",
};

const CORP_ACTION_MAP = {
    DIVIDEND: "Dividend",
    DIVIDEND_REINVEST: "Dividend",
    STOCK_SPLIT: "Buy",
};

const CASH_TYPE_MAP = {
    Dividends: "Dividend",
    Dividend: "Dividend",
    "Withholding Tax": "Tax",
    Withholding: "Tax",
    "Deposits/Withdrawals": "Deposit",
    Deposit: "Deposit",
    Withdrawal: "Withdrawal",
    Interest: "Interest",
    "Broker Interest": "Interest",
    "Other Fees": "Fee",
    Fees: "Fee",
};

/**
 * Get text content of a child element or attribute.
 * Tries namespace-qualified first, then unqualified.
 */
function getTextNS($, el, tag) {
    // Try attribute
    const attr = $(el).attr(tag);
    if (attr !== undefined && attr !== null) return attr.trim();

    // Try ns:Tag
    let child = $(el).find(`ns\\:${tag}`).first();
    if (child.length > 0) return child.text().trim();

    // Try Tag (no namespace)
    child = $(el).find(tag).first();
    if (child.length > 0) return child.text().trim();

    return "";
}

function getFloatNS($, el, tag) {
    const val = getTextNS($, el, tag);
    if (!val) return 0;
    const cleaned = val.replace(/,/g, "");
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
}

function getDateNS($, el, tag) {
    const val = getTextNS($, el, tag);
    if (val && val.length >= 10) return val.slice(0, 10);
    return val;
}

function parseTrade($, trade) {
    const symbol = getTextNS($, trade, "symbol");
    const isin = getTextNS($, trade, "isin");
    if (!symbol) return null;

    const tradeTypeRaw = getTextNS($, trade, "buySell");
    const tradeType = TRADE_TYPE_MAP[tradeTypeRaw] || tradeTypeRaw;

    const date =
        getDateNS($, trade, "tradeDate") || getDateNS($, trade, "dateTime");
    const quantity = Math.abs(getFloatNS($, trade, "quantity"));
    const price =
        getFloatNS($, trade, "tradePrice") || getFloatNS($, trade, "price");
    const currency =
        getTextNS($, trade, "currency") || getTextNS($, trade, "currencyCode");
    const ibCommission = getFloatNS($, trade, "ibCommission");
    const xmlTaxes = getFloatNS($, trade, "taxes");
    const fees = ibCommission + xmlTaxes;
    const taxes = 0; // commission already included in fees
    const description =
        getTextNS($, trade, "description") || `${symbol} ${tradeTypeRaw}`;

    let amount = getFloatNS($, trade, "proceeds");
    if (amount < 0 && tradeType === "Buy") {
        amount = Math.abs(amount);
    }

    return {
        type: tradeType,
        symbol,
        isin,
        description,
        date,
        quantity,
        price,
        currency,
        fees,
        taxes,
        amount,
        source: "IBKR_Trade",
    };
}

function parseCashTransaction($, ct) {
    const ctype = getTextNS($, ct, "type");
    if (!ctype) return null;

    const txnType = CASH_TYPE_MAP[ctype] || ctype;
    const date = getDateNS($, ct, "dateTime") || getDateNS($, ct, "reportDate");
    const currency = getTextNS($, ct, "currency");
    let amount = getFloatNS($, ct, "amount");
    const description = getTextNS($, ct, "description") || ctype;
    const symbol = getTextNS($, ct, "symbol");

    // Fix sign conventions
    if (
        amount < 0 &&
        (txnType === "Deposit" ||
            txnType === "Dividend" ||
            txnType === "Interest")
    ) {
        amount = Math.abs(amount);
    } else if (
        amount > 0 &&
        (txnType === "Withdrawal" || txnType === "Fee" || txnType === "Tax")
    ) {
        amount = -Math.abs(amount);
    }

    return {
        type: txnType,
        symbol,
        isin: "",
        description,
        date,
        quantity: 0,
        price: amount ? Math.abs(amount) : 0,
        currency,
        fees: 0,
        taxes: 0,
        amount,
        source: "IBKR_Cash",
    };
}

function parseCorporateAction($, ca) {
    const caType = getTextNS($, ca, "type");
    if (!caType) return null;

    const mappedType = CORP_ACTION_MAP[caType] || "Dividend";
    const symbol = getTextNS($, ca, "symbol");
    const date = getDateNS($, ca, "dateTime") || getDateNS($, ca, "reportDate");
    const currency = getTextNS($, ca, "currency");
    const description =
        getTextNS($, ca, "description") || `${caType}: ${symbol}`;
    const quantity = getFloatNS($, ca, "quantity");

    return {
        type: mappedType,
        symbol,
        isin: "",
        description,
        date,
        quantity,
        price: 0,
        currency,
        fees: 0,
        taxes: 0,
        amount: 0,
        source: "IBKR_CA",
    };
}

/**
 * Parse an IBKR Flex Query XML response and extract all transactions.
 * @param {string} xmlContent - Raw XML string from IBKR flex query
 * @returns {object[]} Array of transaction objects
 */
export async function parseIBKRFlexQuery(xmlContent) {
    // Use cheerio with xmlMode
    const cheerioMod = await import("cheerio");
    const cheerio = cheerioMod.default || cheerioMod;
    const $ = cheerio.load(xmlContent, { xmlMode: true });

    const transactions = [];

    // --- Parse Trades ---
    // Try ns:Trades first
    let tradesElem = $("Trades").first();
    if (tradesElem.length > 0) {
        tradesElem.find("Trade").each((_, trade) => {
            const txn = parseTrade($, trade);
            if (txn) transactions.push(txn);
        });
    }

    // --- Parse CashTransactions ---
    let cashElem = $("CashTransactions").first();
    if (cashElem.length > 0) {
        cashElem.find("CashTransaction").each((_, ct) => {
            const txn = parseCashTransaction($, ct);
            if (txn) transactions.push(txn);
        });
    }

    // --- Parse CorporateActions ---
    let corpElem = $("CorporateActions").first();
    if (corpElem.length > 0) {
        corpElem.find("CorporateAction").each((_, ca) => {
            const txn = parseCorporateAction($, ca);
            if (txn) transactions.push(txn);
        });
    }

    return transactions;
}
