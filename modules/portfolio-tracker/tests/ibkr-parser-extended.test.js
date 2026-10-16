/**
 * Extended IBKR parser tests — cash transaction types, corporate action types,
 * namespace-less XML, real-world edge cases, signed amounts.
 */
import { describe, it, expect } from "vitest";
import { parseIBKRFlexQuery } from "../src/ibkr_parser.js";

describe("parseIBKRFlexQuery — cash transaction type mapping", () => {
  const makeCTXml = (type, amount) => `<?xml version="1.0"?>
<FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
  <FlexStatements><FlexStatement>
    <CashTransactions>
      <CashTransaction type="${type}" dateTime="20260605" currency="USD"
                       amount="${amount}" description="${type} desc"/>
    </CashTransactions>
  </FlexStatement></FlexStatements>
</FlexQueryResponse>`;

  it("maps 'Dividends' to Dividend type", async () => {
    const txn = await parseIBKRFlexQuery(makeCTXml("Dividends", "50.00"));
    expect(txn[0].type).toBe("Dividend");
  });

  it("maps 'Dividend' to Dividend type", async () => {
    const txn = await parseIBKRFlexQuery(makeCTXml("Dividend", "25.00"));
    expect(txn[0].type).toBe("Dividend");
  });

  it("maps 'Withholding Tax' to Tax type", async () => {
    const txn = await parseIBKRFlexQuery(makeCTXml("Withholding Tax", "-5.00"));
    expect(txn[0].type).toBe("Tax");
  });

  it("maps 'Withholding' to Tax type", async () => {
    const txn = await parseIBKRFlexQuery(makeCTXml("Withholding", "-3.00"));
    expect(txn[0].type).toBe("Tax");
  });

  it("maps 'Deposits/Withdrawals' to Deposit type", async () => {
    const txn = await parseIBKRFlexQuery(makeCTXml("Deposits/Withdrawals", "1000.00"));
    expect(txn[0].type).toBe("Deposit");
  });

  it("maps 'Deposit' to Deposit type", async () => {
    const txn = await parseIBKRFlexQuery(makeCTXml("Deposit", "500.00"));
    expect(txn[0].type).toBe("Deposit");
  });

  it("maps 'Withdrawal' to Withdrawal type", async () => {
    const txn = await parseIBKRFlexQuery(makeCTXml("Withdrawal", "-200.00"));
    expect(txn[0].type).toBe("Withdrawal");
  });

  it("maps 'Interest' to Interest type", async () => {
    const txn = await parseIBKRFlexQuery(makeCTXml("Interest", "0.50"));
    expect(txn[0].type).toBe("Interest");
  });

  it("maps 'Broker Interest' to Interest type", async () => {
    const txn = await parseIBKRFlexQuery(makeCTXml("Broker Interest", "1.25"));
    expect(txn[0].type).toBe("Interest");
  });

  it("maps 'Other Fees' to Fee type", async () => {
    const txn = await parseIBKRFlexQuery(makeCTXml("Other Fees", "-10.00"));
    expect(txn[0].type).toBe("Fee");
  });

  it("maps 'Fees' to Fee type", async () => {
    const txn = await parseIBKRFlexQuery(makeCTXml("Fees", "-5.00"));
    expect(txn[0].type).toBe("Fee");
  });

  it("keeps unknown type as-is", async () => {
    const txn = await parseIBKRFlexQuery(makeCTXml("CustomRefund", "100.00"));
    expect(txn[0].type).toBe("CustomRefund");
  });
});

describe("parseIBKRFlexQuery — sign conventions", () => {
  it("makes negative dividend positive", async () => {
    const xml = `<?xml version="1.0"?>
<FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
  <FlexStatements><FlexStatement>
    <CashTransactions>
      <CashTransaction type="Dividend" dateTime="20260605" currency="USD" amount="-25.00"/>
    </CashTransactions>
  </FlexStatement></FlexStatements>
</FlexQueryResponse>`;
    const txn = await parseIBKRFlexQuery(xml);
    expect(txn[0].amount).toBe(25.00);
  });

  it("makes positive withdrawal negative", async () => {
    const xml = `<?xml version="1.0"?>
<FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
  <FlexStatements><FlexStatement>
    <CashTransactions>
      <CashTransaction type="Withdrawal" dateTime="20260605" currency="USD" amount="200.00"/>
    </CashTransactions>
  </FlexStatement></FlexStatements>
</FlexQueryResponse>`;
    const txn = await parseIBKRFlexQuery(xml);
    expect(txn[0].amount).toBe(-200.00);
  });

  it("makes positive Fee negative", async () => {
    const xml = `<?xml version="1.0"?>
<FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
  <FlexStatements><FlexStatement>
    <CashTransactions>
      <CashTransaction type="Fees" dateTime="20260605" currency="USD" amount="10.00"/>
    </CashTransactions>
  </FlexStatement></FlexStatements>
</FlexQueryResponse>`;
    const txn = await parseIBKRFlexQuery(xml);
    expect(txn[0].amount).toBe(-10.00);
  });

  it("makes positive Tax negative", async () => {
    const xml = `<?xml version="1.0"?>
<FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
  <FlexStatements><FlexStatement>
    <CashTransactions>
      <CashTransaction type="Withholding Tax" dateTime="20260605" currency="USD" amount="5.00"/>
    </CashTransactions>
  </FlexStatement></FlexStatements>
</FlexQueryResponse>`;
    const txn = await parseIBKRFlexQuery(xml);
    expect(txn[0].amount).toBe(-5.00);
  });
});

describe("parseIBKRFlexQuery — corporate actions", () => {
  it("maps DIVIDEND to Dividend with IBKR_CA source", async () => {
    const xml = `<?xml version="1.0"?>
<FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
  <FlexStatements><FlexStatement>
    <CorporateActions>
      <CorporateAction type="DIVIDEND" symbol="VWRA" dateTime="20260605"
                       currency="USD" description="VWRA DIVIDEND"/>
    </CorporateActions>
  </FlexStatement></FlexStatements>
</FlexQueryResponse>`;
    const txn = await parseIBKRFlexQuery(xml);
    expect(txn.length).toBe(1);
    expect(txn[0].type).toBe("Dividend");
    expect(txn[0].source).toBe("IBKR_CA");
    expect(txn[0].symbol).toBe("VWRA");
  });

  it("maps DIVIDEND_REINVEST to Dividend", async () => {
    const xml = `<?xml version="1.0"?>
<FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
  <FlexStatements><FlexStatement>
    <CorporateActions>
      <CorporateAction type="DIVIDEND_REINVEST" symbol="AAPL" dateTime="20260605"
                       currency="USD" description="AAPL DRIP"/>
    </CorporateActions>
  </FlexStatement></FlexStatements>
</FlexQueryResponse>`;
    const txn = await parseIBKRFlexQuery(xml);
    expect(txn.length).toBe(1);
    expect(txn[0].type).toBe("Dividend");
  });

  it("maps STOCK_SPLIT to Buy", async () => {
    const xml = `<?xml version="1.0"?>
<FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
  <FlexStatements><FlexStatement>
    <CorporateActions>
      <CorporateAction type="STOCK_SPLIT" symbol="TSLA" dateTime="20260605"
                       currency="USD" description="TSLA 3:1 SPLIT" quantity="200"/>
    </CorporateActions>
  </FlexStatement></FlexStatements>
</FlexQueryResponse>`;
    const txn = await parseIBKRFlexQuery(xml);
    expect(txn.length).toBe(1);
    expect(txn[0].type).toBe("Buy");
    expect(txn[0].quantity).toBe(200);
  });

  it("returns null for corporate action without type", async () => {
    const xml = `<?xml version="1.0"?>
<FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
  <FlexStatements><FlexStatement>
    <CorporateActions>
      <CorporateAction symbol="AAPL" dateTime="20260605"/>
    </CorporateActions>
  </FlexStatement></FlexStatements>
</FlexQueryResponse>`;
    const txn = await parseIBKRFlexQuery(xml);
    expect(txn.length).toBe(0);
  });

  it("handles unknown corporate action type as Dividend fallback", async () => {
    const xml = `<?xml version="1.0"?>
<FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
  <FlexStatements><FlexStatement>
    <CorporateActions>
      <CorporateAction type="SPINOFF" symbol="GE" dateTime="20260605"
                       currency="USD" description="GEHC SPINOFF"/>
    </CorporateActions>
  </FlexStatement></FlexStatements>
</FlexQueryResponse>`;
    const txn = await parseIBKRFlexQuery(xml);
    expect(txn.length).toBe(1);
    expect(txn[0].type).toBe("Dividend"); // CORP_ACTION_MAP fallback
  });
});

describe("parseIBKRFlexQuery — namespace-less XML", () => {
  it("parses trades without namespace", async () => {
    const xml = `<?xml version="1.0"?>
<FlexQueryResponse>
  <Trades>
    <Trade symbol="AAPL" isin="US0378331005" tradeDate="20260601" quantity="10"
           tradePrice="185.30" currency="USD" buySell="BUY"/>
  </Trades>
</FlexQueryResponse>`;
    const txn = await parseIBKRFlexQuery(xml);
    expect(txn.length).toBe(1);
    expect(txn[0].symbol).toBe("AAPL");
    expect(txn[0].type).toBe("Buy");
  });

  it("parses cash transactions without namespace", async () => {
    const xml = `<?xml version="1.0"?>
<CashTransactions>
  <CashTransaction type="Dividends" dateTime="20260605" currency="USD"
                   amount="50.00" symbol="VWRA"/>
</CashTransactions>`;
    const txn = await parseIBKRFlexQuery(xml);
    expect(txn.length).toBe(1);
    expect(txn[0].type).toBe("Dividend");
  });

  it("parses mixed sections", async () => {
    const xml = `<?xml version="1.0"?>
<root>
  <Trades>
    <Trade symbol="AAPL" tradeDate="20260601" quantity="10" tradePrice="185.30"
           currency="USD" buySell="BUY"/>
  </Trades>
  <CashTransactions>
    <CashTransaction type="Dividends" dateTime="20260603" currency="USD"
                     amount="25.00" symbol="AAPL"/>
  </CashTransactions>
</root>`;
    const txn = await parseIBKRFlexQuery(xml);
    expect(txn.length).toBe(2);
    expect(txn.filter(t => t.source === "IBKR_Trade").length).toBe(1);
    expect(txn.filter(t => t.source === "IBKR_Cash").length).toBe(1);
  });
});

describe("parseIBKRFlexQuery — trade edge cases", () => {
  it("handles BUY (CA) as Buy type", async () => {
    const xml = `<?xml version="1.0"?>
<FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
  <Trades>
    <Trade symbol="AAPL" tradeDate="20260601" quantity="10" tradePrice="100"
           currency="USD" buySell="BUY (CA)"/>
  </Trades>
</FlexQueryResponse>`;
    const txn = await parseIBKRFlexQuery(xml);
    expect(txn.length).toBe(1);
    expect(txn[0].type).toBe("Buy");
  });

  it("handles SELL (CA) as Sell type", async () => {
    const xml = `<?xml version="1.0"?>
<FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
  <Trades>
    <Trade symbol="TSLA" tradeDate="20260601" quantity="5" tradePrice="250"
           currency="USD" buySell="SELL (CA)"/>
  </Trades>
</FlexQueryResponse>`;
    const txn = await parseIBKRFlexQuery(xml);
    expect(txn.length).toBe(1);
    expect(txn[0].type).toBe("Sell");
  });

  it("flips negative proceeds to positive for Buy", async () => {
    const xml = `<?xml version="1.0"?>
<FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
  <Trades>
    <Trade symbol="AAPL" tradeDate="20260601" quantity="100" tradePrice="185.30"
           currency="USD" buySell="BUY" proceeds="-18530.00"/>
  </Trades>
</FlexQueryResponse>`;
    const txn = await parseIBKRFlexQuery(xml);
    expect(txn.length).toBe(1);
    expect(txn[0].amount).toBe(18530.00);
  });

  it("uses dateTime as fallback when tradeDate missing", async () => {
    const xml = `<?xml version="1.0"?>
<FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
  <Trades>
    <Trade symbol="NVDA" dateTime="20260605" quantity="10" tradePrice="450"
           currency="USD" buySell="BUY"/>
  </Trades>
</FlexQueryResponse>`;
    const txn = await parseIBKRFlexQuery(xml);
    expect(txn.length).toBe(1);
    expect(txn[0].date).toBe("20260605");
  });

  it("returns empty array for completely empty XML", async () => {
    const txn = await parseIBKRFlexQuery("<?xml version=\"1.0\"?><root></root>");
    expect(txn).toEqual([]);
  });

  it("returns empty array for empty string", async () => {
    const txn = await parseIBKRFlexQuery("");
    expect(txn).toEqual([]);
  });
});

describe("parseIBKRFlexQuery — source tracking", () => {
  it("marks trades with IBKR_Trade source", async () => {
    const xml = `<?xml version="1.0"?>
<FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
  <Trades>
    <Trade symbol="AAPL" tradeDate="20260601" quantity="10" tradePrice="185.30"
           currency="USD" buySell="BUY"/>
  </Trades>
</FlexQueryResponse>`;
    const txn = await parseIBKRFlexQuery(xml);
    expect(txn[0].source).toBe("IBKR_Trade");
  });

  it("marks cash transactions with IBKR_Cash source", async () => {
    const xml = `<?xml version="1.0"?>
<FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
  <CashTransactions>
    <CashTransaction type="Dividends" dateTime="20260605" currency="USD" amount="50.00"/>
  </CashTransactions>
</FlexQueryResponse>`;
    const txn = await parseIBKRFlexQuery(xml);
    expect(txn[0].source).toBe("IBKR_Cash");
  });

  it("marks corporate actions with IBKR_CA source", async () => {
    const xml = `<?xml version="1.0"?>
<FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
  <CorporateActions>
    <CorporateAction type="DIVIDEND" symbol="AAPL" dateTime="20260605" currency="USD"/>
  </CorporateActions>
</FlexQueryResponse>`;
    const txn = await parseIBKRFlexQuery(xml);
    expect(txn[0].source).toBe("IBKR_CA");
  });
});

describe("parseIBKRFlexQuery — amount with commas", () => {
  it("strips commas from numeric values", async () => {
    const xml = `<?xml version="1.0"?>
<FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
  <Trades>
    <Trade symbol="BRK.B" tradeDate="20260601" quantity="5"
           tradePrice="430,000.00" currency="USD" buySell="BUY"/>
  </Trades>
</FlexQueryResponse>`;
    const txn = await parseIBKRFlexQuery(xml);
    expect(txn.length).toBe(1);
    expect(txn[0].price).toBe(430000.00);
  });
});
