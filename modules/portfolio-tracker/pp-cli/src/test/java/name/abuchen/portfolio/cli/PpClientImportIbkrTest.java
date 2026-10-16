package name.abuchen.portfolio.cli;

import static org.junit.Assert.*;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.UUID;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * TDD for PpClient.importIbkr() — IBKR Flex XML import with dedup.
 *
 * Creates a minimal raw XML portfolio file (avoiding OSGi dependency),
 * then tests import with a synthetic IBKR flex XML containing a single AAPL BUY.
 */
public class PpClientImportIbkrTest {

    private Path tmpPortfolio;
    private Path tmpIbkrXml;

    private String sgdAccountId;
    private String usdAccountId;
    private String portfolioId;
    private String securityId;
    private String portfolioXml;

    private static final String IBKR_FLEX_XML = """
            <?xml version="1.0" encoding="UTF-8"?>
            <FlexQueryResponse queryName="TestPP" type="AF">
            <FlexStatements count="1">
            <FlexStatement accountId="U1234567" fromDate="20260617" toDate="20260617" period="LastNCalendarDays"
                whenGenerated="20260618;063607">
            <Trades>
            <Trade accountId="U1234567" acctAlias="Test" model="" currency="USD" fxRateToBase="1"
                assetCategory="STK" subCategory="COMMON" symbol="AAPL" description="Apple Inc"
                conid="265598" securityID="US0378331005" securityIDType="ISIN" cusip="037833100"
                isin="US0378331005" listingExchange="NASDAQ"
                tradeID="999999" multiplier="1" reportDate="20260617" dateTime="20260617;152915"
                tradeDate="20260617" settleDateTarget="20260618" transactionType="ExchTrade"
                exchange="DRCTEDGE" quantity="10" tradePrice="150" tradeMoney="1500" proceeds="-1500"
                taxes="-0.01" ibCommission="-0.35" ibCommissionCurrency="USD" netCash="-1500.36"
                closePrice="149.50" openCloseIndicator="O" notes="" cost="1500.36"
                fifoPnlRealized="0" mtmPnl="-5" buySell="BUY" clearingFirmID=""
                ibOrderID="12345" transactionID="987654" ibExecID="0000abcd.6a3287e9.01.01"
                levelOfDetail="EXECUTION" orderType="LMT" isAPIOrder="N"
                accruedInt="0" />
            </Trades>
            </FlexStatement>
            </FlexStatements>
            </FlexQueryResponse>
            """;

    @Before
    public void setUp() throws Exception {
        sgdAccountId = UUID.randomUUID().toString();
        usdAccountId = UUID.randomUUID().toString();
        portfolioId = UUID.randomUUID().toString();
        securityId = UUID.randomUUID().toString();

        portfolioXml = String.format("""
                <?xml version="1.0" encoding="UTF-8"?>
                <name.abuchen.portfolio.model.Client>
                  <accounts>
                    <name.abuchen.portfolio.model.Account>
                      <uuid>%s</uuid>
                      <name>Test SGD</name>
                      <currencyCode>SGD</currencyCode>
                      <transactions/>
                    </name.abuchen.portfolio.model.Account>
                    <name.abuchen.portfolio.model.Account>
                      <uuid>%s</uuid>
                      <name>Test USD</name>
                      <currencyCode>USD</currencyCode>
                      <transactions/>
                    </name.abuchen.portfolio.model.Account>
                  </accounts>
                  <portfolios>
                    <name.abuchen.portfolio.model.Portfolio>
                      <uuid>%s</uuid>
                      <name>Test Portfolio</name>
                      <referenceAccount>%s</referenceAccount>
                      <transactions/>
                    </name.abuchen.portfolio.model.Portfolio>
                  </portfolios>
                  <securities>
                    <name.abuchen.portfolio.model.Security>
                      <uuid>%s</uuid>
                      <name>Apple Inc.</name>
                      <isin>US0378331005</isin>
                      <tickerSymbol>AAPL</tickerSymbol>
                      <currencyCode>USD</currencyCode>
                      <prices/>
                    </name.abuchen.portfolio.model.Security>
                  </securities>
                </name.abuchen.portfolio.model.Client>
                """,
                sgdAccountId, usdAccountId,
                portfolioId, sgdAccountId,
                securityId);

        tmpPortfolio = Files.createTempFile("pp-test-import-", ".portfolio");
        Files.writeString(tmpPortfolio, portfolioXml);
        tmpPortfolio.toFile().deleteOnExit();

        tmpIbkrXml = Files.createTempFile("ibkr-test-flex-", ".xml");
        Files.writeString(tmpIbkrXml, IBKR_FLEX_XML);
        tmpIbkrXml.toFile().deleteOnExit();
    }

    @After
    public void tearDown() {
        try { Files.deleteIfExists(tmpPortfolio); } catch (Exception ignored) {}
        try { Files.deleteIfExists(tmpIbkrXml); } catch (Exception ignored) {}
    }

    @Test
    public void testImportSingleTrade() throws Exception {
        PpClient ppc = new PpClient(tmpPortfolio.toFile());
        Map<String, Object> result = ppc.importIbkr(
                tmpIbkrXml.toFile(), "", usdAccountId, portfolioId);

        assertEquals("ok", result.get("status"));
        assertEquals(1, ((Number) result.get("trades_imported")).intValue());
        assertEquals(0, ((Number) result.get("items_skipped")).intValue());
    }

    @Test
    public void testImportDuplicateSkipped() throws Exception {
        PpClient ppc = new PpClient(tmpPortfolio.toFile());

        Map<String, Object> r1 = ppc.importIbkr(
                tmpIbkrXml.toFile(), "", usdAccountId, portfolioId);
        assertEquals(1, ((Number) r1.get("trades_imported")).intValue());

        Map<String, Object> r2 = ppc.importIbkr(
                tmpIbkrXml.toFile(), "", usdAccountId, portfolioId);
        assertEquals(0, ((Number) r2.get("trades_imported")).intValue());
        assertEquals(1, ((Number) r2.get("items_skipped")).intValue());
    }

    @Test
    public void testImportSkippedWithoutAccountConfig() throws Exception {
        PpClient ppc = new PpClient(tmpPortfolio.toFile());
        Map<String, Object> result = ppc.importIbkr(
                tmpIbkrXml.toFile(), "", "", "");
        assertEquals(0, ((Number) result.get("trades_imported")).intValue());
        assertEquals(1, ((Number) result.get("items_skipped")).intValue());
    }

    @Test
    public void testImportUsdTradeSkipsWithOnlySgdAccount() throws Exception {
        PpClient ppc = new PpClient(tmpPortfolio.toFile());
        Map<String, Object> result = ppc.importIbkr(
                tmpIbkrXml.toFile(), sgdAccountId, "", portfolioId);
        assertEquals(0, ((Number) result.get("trades_imported")).intValue());
        assertEquals(1, ((Number) result.get("items_skipped")).intValue());
    }

    @Test
    public void testImportUsesFirstPortfolioWhenNotConfigured() throws Exception {
        PpClient ppc = new PpClient(tmpPortfolio.toFile());
        Map<String, Object> result = ppc.importIbkr(
                tmpIbkrXml.toFile(), "", usdAccountId, "");
        assertEquals(1, ((Number) result.get("trades_imported")).intValue());
    }

    @Test
    public void testImportThrowsOnMissingXmlFile() {
        PpClient ppc = new PpClient(tmpPortfolio.toFile());
        try {
            ppc.importIbkr(new File("/tmp/does-not-exist.xml"), "", "", "");
            fail("Expected IOException");
        } catch (Exception e) {
            assertTrue(e.getMessage().contains("not found"));
        }
    }

    @Test
    public void testImportEmptyXmlNoTrades() throws Exception {
        Path emptyXml = Files.createTempFile("ibkr-empty-", ".xml");
        Files.writeString(emptyXml, """
                <?xml version="1.0"?>
                <FlexQueryResponse><FlexStatements count="0">
                </FlexStatements></FlexQueryResponse>
                """);
        emptyXml.toFile().deleteOnExit();

        PpClient ppc = new PpClient(tmpPortfolio.toFile());
        Map<String, Object> result = ppc.importIbkr(
                emptyXml.toFile(), sgdAccountId, usdAccountId, portfolioId);
        assertEquals(0, ((Number) result.get("trades_imported")).intValue());
    }
}
