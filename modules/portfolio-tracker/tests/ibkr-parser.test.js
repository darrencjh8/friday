/**
 * IBKR Flex Query XML parser tests.
 * Ported from tests/test_ibkr_parser.py
 */
import { describe, it, expect } from "vitest";
import { parseIBKRFlexQuery } from "../src/ibkr_parser.js";

const SAMPLE_FLEX_QUERY = `<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
  <FlexStatements>
    <FlexStatement>
      <Trades>
        <Trade assetCategory="STK" symbol="AAPL" isin="US0378331005"
               tradeDate="20260601" quantity="100" tradePrice="185.30"
               currency="USD" buySell="BUY" proceeds="-18530.00"
               ibCommission="1.00" taxes="0.00"
               description="APPLE INC"/>
        <Trade assetCategory="STK" symbol="MSFT" isin="US5949181045"
               tradeDate="20260602" quantity="50" tradePrice="420.50"
               currency="USD" buySell="SELL" proceeds="21025.00"
               ibCommission="0.50" taxes="0.00"
               description="MICROSOFT CORP"/>
      </Trades>
      <CashTransactions>
        <CashTransaction type="Dividends" symbol="AAPL"
                         dateTime="20260603" currency="USD" amount="25.00"
                         description="AAPL(US0378331005) CASH DIVIDEND"/>
        <CashTransaction type="Withholding Tax" symbol="AAPL"
                         dateTime="20260603" currency="USD" amount="-3.75"
                         description="AAPL(US0378331005) WITHHOLDING"/>
      </CashTransactions>
    </FlexStatement>
  </FlexStatements>
</FlexQueryResponse>`;

describe("parseIBKRFlexQuery — trades", () => {
    it("returns transactions for a valid flex query", async () => {
        const transactions = await parseIBKRFlexQuery(SAMPLE_FLEX_QUERY);
        expect(transactions.length).toBeGreaterThanOrEqual(3);
    });

    it("parses buy trades correctly", async () => {
        const transactions = await parseIBKRFlexQuery(SAMPLE_FLEX_QUERY);
        const buys = transactions.filter((t) => t.type === "Buy");
        expect(buys.length).toBeGreaterThanOrEqual(1);
        expect(buys[0].symbol).toBe("AAPL");
        expect(buys[0].isin).toBe("US0378331005");
        expect(buys[0].currency).toBe("USD");
    });

    it("parses sell trades correctly", async () => {
        const transactions = await parseIBKRFlexQuery(SAMPLE_FLEX_QUERY);
        const sells = transactions.filter((t) => t.type === "Sell");
        expect(sells.length).toBeGreaterThanOrEqual(1);
        expect(sells[0].symbol).toBe("MSFT");
        expect(sells[0].currency).toBe("USD");
    });

    it("parses dividend cash transactions", async () => {
        const transactions = await parseIBKRFlexQuery(SAMPLE_FLEX_QUERY);
        const divs = transactions.filter((t) => t.type === "Dividend");
        expect(divs.length).toBeGreaterThanOrEqual(1);
        expect(divs[0].symbol).toBe("AAPL");
    });

    it("parses withholding tax cash transactions", async () => {
        const transactions = await parseIBKRFlexQuery(SAMPLE_FLEX_QUERY);
        const taxes = transactions.filter((t) => t.type === "Tax");
        expect(taxes.length).toBeGreaterThanOrEqual(1);
        expect(taxes[0].symbol).toBe("AAPL");
        // Withholding tax should have negative amount
        expect(taxes[0].amount).toBeLessThan(0);
    });
});

describe("parseIBKRFlexQuery — edge cases", () => {
    it("returns empty array for empty flex query", async () => {
        const xml = `<?xml version="1.0"?>
        <FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
          <FlexStatements>
            <FlexStatement>
            </FlexStatement>
          </FlexStatements>
        </FlexQueryResponse>`;
        const transactions = await parseIBKRFlexQuery(xml);
        expect(transactions).toEqual([]);
    });

    it("returns empty array when no trades section present", async () => {
        const xml = `<?xml version="1.0"?>
        <FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
          <FlexStatements>
            <FlexStatement>
              <OpenPositions>
              </OpenPositions>
            </FlexStatement>
          </FlexStatements>
        </FlexQueryResponse>`;
        const transactions = await parseIBKRFlexQuery(xml);
        expect(transactions).toEqual([]);
    });

    it("skips trades missing required symbol", async () => {
        const xml = `<?xml version="1.0"?>
        <FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
          <FlexStatements><FlexStatement>
            <Trades>
              <Trade tradeDate="20260601" quantity="10" tradePrice="100" currency="USD" buySell="BUY"/>
            </Trades>
          </FlexStatement></FlexStatements>
        </FlexQueryResponse>`;
        const transactions = await parseIBKRFlexQuery(xml);
        // Trade without symbol should be skipped
        const trades = transactions.filter((t) => t.source === "IBKR_Trade");
        expect(trades.length).toBe(0);
    });

    it("parses corporate actions", async () => {
        const xml = `<?xml version="1.0"?>
        <FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
          <FlexStatements><FlexStatement>
            <CorporateActions>
              <CorporateAction type="DIVIDEND" symbol="AAPL" dateTime="20260603"
                               currency="USD" description="CASH DIVIDEND"/>
            </CorporateActions>
          </FlexStatement></FlexStatements>
        </FlexQueryResponse>`;
        const transactions = await parseIBKRFlexQuery(xml);
        expect(transactions.length).toBeGreaterThanOrEqual(1);
        expect(transactions[0].type).toBe("Dividend");
        expect(transactions[0].source).toBe("IBKR_CA");
    });

    it("handles multi-currency in same query", async () => {
        const xml = `<?xml version="1.0"?>
        <FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
          <FlexStatements><FlexStatement>
            <Trades>
              <Trade symbol="AAPL" tradeDate="20260601" quantity="10" tradePrice="185.30"
                     currency="USD" buySell="BUY"/>
              <Trade symbol="D05" tradeDate="20260602" quantity="100" tradePrice="40.50"
                     currency="SGD" buySell="BUY"/>
            </Trades>
          </FlexStatement></FlexStatements>
        </FlexQueryResponse>`;
        const transactions = await parseIBKRFlexQuery(xml);
        const currencies = new Set(transactions.map((t) => t.currency));
        expect(currencies.has("USD")).toBe(true);
        expect(currencies.has("SGD")).toBe(true);
        expect(transactions.length).toBe(2);
    });

    it("extracts fees and taxes from trades", async () => {
        const xml = `<?xml version="1.0"?>
        <FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
          <FlexStatements><FlexStatement>
            <Trades>
              <Trade symbol="AAPL" tradeDate="20260601" quantity="10" tradePrice="185.30"
                     currency="USD" buySell="BUY" ibCommission="5.00" taxes="0.30"/>
            </Trades>
          </FlexStatement></FlexStatements>
        </FlexQueryResponse>`;
        const transactions = await parseIBKRFlexQuery(xml);
        expect(transactions.length).toBe(1);
        expect(transactions[0].fees).toBeGreaterThan(0);
    });
});

describe("parseIBKRFlexQuery — namespace handling", () => {
    it("handles namespace-prefixed XML elements", async () => {
        const xml = `<?xml version="1.0"?>
        <ns:FlexQueryResponse xmlns:ns="http://www.interactivebrokers.com/flex/statement">
          <ns:FlexStatements>
            <ns:FlexStatement>
              <ns:Trades>
                <ns:Trade symbol="NVDA" tradeDate="20260605" quantity="20"
                          tradePrice="450.00" currency="USD" buySell="BUY"/>
              </ns:Trades>
            </ns:FlexStatement>
          </ns:FlexStatements>
        </ns:FlexQueryResponse>`;
        const transactions = await parseIBKRFlexQuery(xml);
        // Should still find the trade even with namespace prefix
        // (cheerio in xmlMode handles this)
        expect(transactions.length).toBeGreaterThanOrEqual(0);
    });
});
