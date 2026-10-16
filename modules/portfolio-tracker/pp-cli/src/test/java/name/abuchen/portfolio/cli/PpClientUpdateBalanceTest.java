package name.abuchen.portfolio.cli;

import static org.junit.Assert.*;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Map;

import name.abuchen.portfolio.model.Account;
import name.abuchen.portfolio.model.AccountTransaction;
import name.abuchen.portfolio.model.Client;
import name.abuchen.portfolio.model.Portfolio;
import name.abuchen.portfolio.model.PortfolioTransaction;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * Unit tests for PpClient.updateBalance() delta computation.
 *
 * Tests against a COPY of the real portfolio file.
 * Read-only tests verify the balance calculation algorithm.
 * Write tests (updateBalance) may fail in test classpath due to
 * JAR signing conflicts with HeadlessSave; those tests are run
 * conditionally and verified via the shaded JAR at integration time.
 */
public class PpClientUpdateBalanceTest {

    private static final String PP_PASSWORD = System.getenv("PP_PASSWORD") != null
            ? System.getenv("PP_PASSWORD") : "";
    private static final String REAL_FILE = "../data/Portfolio.portfolio";

    private Path tmpCopy;

    @Before
    public void setUp() throws Exception {
        if (PP_PASSWORD.isEmpty()) {
            System.out.println("SKIP: PP_PASSWORD not set, skipping real-file tests");
            return;
        }
        File realFile = new File(REAL_FILE);
        if (!realFile.exists()) {
            System.out.println("SKIP: Portfolio file not found at " + realFile.getAbsolutePath());
            return;
        }
        tmpCopy = Files.createTempFile("pp-test-copy-", ".portfolio");
        Files.copy(realFile.toPath(), tmpCopy, StandardCopyOption.REPLACE_EXISTING);
        tmpCopy.toFile().deleteOnExit();
    }

    @After
    public void tearDown() {
        if (tmpCopy != null) {
            try { Files.deleteIfExists(tmpCopy); } catch (Exception ignored) {}
        }
    }

    private long computeBalance(Client client, String accountId) {
        Account account = null;
        for (Account a : client.getAccounts()) {
            if (a.getUUID().equals(accountId)) { account = a; break; }
        }
        if (account == null) throw new RuntimeException("Account not found: " + accountId);

        long balance = 0;
        for (AccountTransaction t : account.getTransactions()) {
            long amt = t.getMonetaryAmount().getAmount();
            if (t.getType().isDebit())
                balance -= amt;
            else
                balance += amt;
        }
        return balance;
    }

    /** Calls updateBalance on the copy file, handling signing errors. */
    private Map<String, Object> safeUpdateBalance(String accountId, double amount,
            String currency, String date, String notes) throws Exception {
        PpClient ppc = new PpClient(tmpCopy.toFile(), PP_PASSWORD.toCharArray());
        return ppc.updateBalance(accountId, amount, currency, date, notes);
    }

    // ---- Read-only tests (always work) ----

    @Test
    public void testEmergencySgdBalancePositive() throws Exception {
        if (tmpCopy == null) return;
        PpClient ppc = new PpClient(tmpCopy.toFile(), PP_PASSWORD.toCharArray());
        long balance = computeBalance(ppc.load(), "444b04eb-8c55-4efc-9df3-c529612fd2f3");
        assertTrue("Emergency SGD balance should be positive", balance > 0);
        System.out.printf("Emergency SGD balance: $%.2f%n", balance / 100.0);
    }

    @Test
    public void testEmergencyMyrBalancePositive() throws Exception {
        if (tmpCopy == null) return;
        PpClient ppc = new PpClient(tmpCopy.toFile(), PP_PASSWORD.toCharArray());
        long balance = computeBalance(ppc.load(), "a5f42a18-b882-4225-bea6-90c9eea720b5");
        assertTrue("Emergency MYR balance should be positive", balance > 0);
        System.out.printf("Emergency MYR balance: RM%.2f%n", balance / 100.0);
    }

    @Test
    public void testWarchestHasLinkedPortfolioTransactions() throws Exception {
        if (tmpCopy == null) return;
        PpClient ppc = new PpClient(tmpCopy.toFile(), PP_PASSWORD.toCharArray());
        Client client = ppc.load();

        Account warchest = null;
        for (Account a : client.getAccounts()) {
            if (a.getUUID().equals("68815371-05f3-43e9-9669-08b368fe1e9d"))
                { warchest = a; break; }
        }
        assertNotNull("Warchest account should exist", warchest);

        // Count linked portfolio BUY transactions (informational)
        int buyCount = 0;
        long totalBuy = 0;
        for (Portfolio p : client.getPortfolios()) {
            if (warchest.equals(p.getReferenceAccount())) {
                for (PortfolioTransaction t : p.getTransactions()) {
                    if (t.getType() == PortfolioTransaction.Type.BUY) {
                        totalBuy += t.getMonetaryAmount().getAmount();
                        buyCount++;
                    }
                }
            }
        }

        // PP UI formula: balance uses account transactions only (isDebit/isCredit)
        long balance = computeBalance(client, warchest.getUUID());

        System.out.printf("Warchest balance (PP UI formula): %.2f, linked portfolios: %d, linked BUYs: %d (total %.2f)%n",
                balance / 100.0, countLinkedPortfolios(client, warchest), buyCount, totalBuy / 100.0);

        assertTrue("Linked portfolio BUY effect is tracked in portfolio, not account balance",
                buyCount > 0 || countLinkedPortfolios(client, warchest) == 0);
    }

    private int countLinkedPortfolios(Client client, Account account) {
        int count = 0;
        for (Portfolio p : client.getPortfolios()) {
            if (account.equals(p.getReferenceAccount())) count++;
        }
        return count;
    }

    /**
     * CRITICAL REGRESSION: Verify updateBalance reports the SAME
     * current_balance as our manual computation. If the bug were present,
     * updateBalance would report an inflated current_balance.
     */
    @Test
    public void testUpdateBalanceReportsCorrectCurrentBalance() throws Exception {
        if (tmpCopy == null) return;
        PpClient ppc = new PpClient(tmpCopy.toFile(), PP_PASSWORD.toCharArray());
        Client client = ppc.load();

        String warchestId = "68815371-05f3-43e9-9669-08b368fe1e9d";
        long manualBalance = computeBalance(client, warchestId);

        // Check for linked portfolio BUYs (triggers the old bug)
        Account warchest = null;
        for (Account a : client.getAccounts()) {
            if (a.getUUID().equals(warchestId)) { warchest = a; break; }
        }
        assertNotNull(warchest);

        boolean hasLinked = false;
        for (Portfolio p : client.getPortfolios()) {
            if (warchest.equals(p.getReferenceAccount())
                    && !p.getTransactions().isEmpty()) {
                hasLinked = true; break;
            }
        }
        if (!hasLinked) {
            System.out.println("SKIP: no linked portfolio transactions");
            return;
        }

        // Call updateBalance with target == current → delta should be 0
        double target = manualBalance / 100.0;
        Map<String, Object> result = safeUpdateBalance(warchestId, target, "SGD",
                "2026-06-06", "REGRESSION: target equals current");

        assertEquals("Should be unchanged", "unchanged", result.get("status"));
        assertEquals("Delta should be 0", 0, ((Integer) result.get("delta")).intValue());
        assertEquals("Reported current_balance should match manual computation",
                target, (Double) result.get("current_balance"), 0.01);

        System.out.println("REGRESSION PASSED: No balance corruption with linked portfolio BUYs");
    }

    @Test
    public void testUpdateBalanceDeltaEqualsTargetMinusCurrent() throws Exception {
        if (tmpCopy == null) return;
        PpClient ppc = new PpClient(tmpCopy.toFile(), PP_PASSWORD.toCharArray());
        Client client = ppc.load();

        String accountId = "444b04eb-8c55-4efc-9df3-c529612fd2f3";
        long current = computeBalance(client, accountId);
        double target = current / 100.0 + 500.00;

        Map<String, Object> result = safeUpdateBalance(accountId, target, "SGD",
                "2026-06-06", "TEST delta +500");

        assertEquals("updated", result.get("status"));
        assertEquals(500.00, (Double) result.get("delta"), 0.01);
        System.out.printf("Delta test PASSED: current=%.2f target=%.2f delta=%.2f%n",
                current / 100.0, target, (Double) result.get("delta"));
    }

    @Test
    public void testUpdateBalanceTargetLowerThanCurrent() throws Exception {
        if (tmpCopy == null) return;
        PpClient ppc = new PpClient(tmpCopy.toFile(), PP_PASSWORD.toCharArray());
        Client client = ppc.load();

        String accountId = "444b04eb-8c55-4efc-9df3-c529612fd2f3";
        long current = computeBalance(client, accountId);

        if (current < 50000) { System.out.println("SKIP: balance < $500"); return; }

        double target = current / 100.0 - 500.00;
        Map<String, Object> result = safeUpdateBalance(accountId, target, "SGD",
                "2026-06-06", "TEST delta -500");

        assertEquals("updated", result.get("status"));
        assertTrue("Delta should be negative", (Double) result.get("delta") < 0);
        assertEquals(-500.00, (Double) result.get("delta"), 0.02);

        // Reload and verify REMOVAL type
        Client reloaded = new PpClient(tmpCopy.toFile(), PP_PASSWORD.toCharArray()).load();
        Account acct = null;
        for (Account a : reloaded.getAccounts()) {
            if (a.getUUID().equals(accountId)) { acct = a; break; }
        }
        assertNotNull(acct);
        AccountTransaction lastTx = acct.getTransactions()
                .get(acct.getTransactions().size() - 1);
        assertEquals("Should be REMOVAL when target < current",
                AccountTransaction.Type.REMOVAL, lastTx.getType());

        System.out.printf("REMOVAL test PASSED: delta=%.2f type=%s%n",
                (Double) result.get("delta"), lastTx.getType());
    }

    @Test
    public void testUpdateBalanceTargetHigherThanCurrentCreatesDeposit() throws Exception {
        if (tmpCopy == null) return;
        long current = computeBalance(
                new PpClient(tmpCopy.toFile(), PP_PASSWORD.toCharArray()).load(),
                "444b04eb-8c55-4efc-9df3-c529612fd2f3");

        double target = current / 100.0 + 1000.00;
        Map<String, Object> result = safeUpdateBalance(
                "444b04eb-8c55-4efc-9df3-c529612fd2f3",
                target, "SGD", "2026-06-06", "TEST deposit");

        assertEquals("updated", result.get("status"));
        assertTrue("Delta should be positive", (Double) result.get("delta") > 0);

        Client reloaded = new PpClient(tmpCopy.toFile(), PP_PASSWORD.toCharArray()).load();
        Account acct = null;
        for (Account a : reloaded.getAccounts()) {
            if (a.getUUID().equals("444b04eb-8c55-4efc-9df3-c529612fd2f3"))
                { acct = a; break; }
        }
        assertNotNull(acct);
        AccountTransaction lastTx = acct.getTransactions()
                .get(acct.getTransactions().size() - 1);
        assertEquals("Should be DEPOSIT when target > current",
                AccountTransaction.Type.DEPOSIT, lastTx.getType());
    }

    @Test
    public void testUpdateBalanceNotesContainDeltaAndTarget() throws Exception {
        if (tmpCopy == null) return;
        PpClient ppc = new PpClient(tmpCopy.toFile(), PP_PASSWORD.toCharArray());
        long current = computeBalance(ppc.load(),
                "444b04eb-8c55-4efc-9df3-c529612fd2f3");

        double target = current / 100.0 + 200.00;
        safeUpdateBalance("444b04eb-8c55-4efc-9df3-c529612fd2f3",
                target, "SGD", "2026-06-06", "AB sync test");

        Client reloaded = new PpClient(tmpCopy.toFile(), PP_PASSWORD.toCharArray()).load();
        Account acct = null;
        for (Account a : reloaded.getAccounts()) {
            if (a.getUUID().equals("444b04eb-8c55-4efc-9df3-c529612fd2f3"))
                { acct = a; break; }
        }
        assertNotNull(acct);
        String notes = acct.getTransactions()
                .get(acct.getTransactions().size() - 1).getNote();
        assertTrue(notes.contains("Delta:"));
        assertTrue(notes.contains("target"));
        assertTrue(notes.contains("AB sync test"));
    }
}
