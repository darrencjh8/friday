package name.abuchen.portfolio.cli;

import static org.junit.Assert.*;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Map;

import name.abuchen.portfolio.model.Account;
import name.abuchen.portfolio.model.AccountTransaction;
import name.abuchen.portfolio.model.Client;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * Comprehensive edge-case tests for PpClient.updateBalance().
 * Covers: account not found, bare account, all 13 transaction types,
 * BUY/SELL on account (BUY=debit, SELL=credit), TRANSFER_IN/OUT,
 * INTEREST_CHARGE (debit), fractional amounts, rounding,
 * sequential updates, other accounts untouched.
 *
 * Uses AccountTransaction.Type.isDebit() to determine sign,
 * matching PP official UI AccountSnapshot.create().
 */
public class PpClientUpdateBalanceEdgeTest {

    private static final String TEST_FILE = "src/test/resources/test-all-edges.xml";
    private Path tmpCopy;

    @Before
    public void setUp() throws Exception {
        File src = new File(TEST_FILE);
        if (!src.exists()) {
            throw new RuntimeException("Test file not found: " + new File(TEST_FILE).getAbsolutePath());
        }
        tmpCopy = Files.createTempFile("pp-edge-test-", ".xml");
        Files.copy(src.toPath(), tmpCopy, StandardCopyOption.REPLACE_EXISTING);
        tmpCopy.toFile().deleteOnExit();
    }

    @After
    public void tearDown() {
        if (tmpCopy != null) {
            try { Files.deleteIfExists(tmpCopy); } catch (Exception ignored) {}
        }
    }

    private Map<String, Object> inv(String accountId, double amount,
            String currency, String date, String notes) throws IOException {
        PpClient ppc = new PpClient(tmpCopy.toFile());
        return ppc.updateBalance(accountId, amount, currency, date, notes);
    }

    // ====================================================================
    // account not found
    // ====================================================================

    @Test
    public void testAccountNotFound() throws Exception {
        try {
            inv("nonexistent-id", 100.00, "SGD", "2026-06-06", "test");
            fail("Expected IOException");
        } catch (IOException e) {
            assertTrue(e.getMessage().contains("Account not found"));
        }
    }

    // ====================================================================
    // bare account (0 transactions)
    // ====================================================================

    @Test
    public void testBareAccountZeroBalance() throws Exception {
        Map<String, Object> r = inv("acct-bare", 0.00, "SGD", "2026-06-06", "test");
        assertEquals("unchanged", r.get("status"));
        assertEquals(0, ((Integer) r.get("delta")).intValue());
        assertEquals(0.00, (Double) r.get("current_balance"), 0.01);
    }

    @Test
    public void testBareAccountTargetPositive() throws Exception {
        Map<String, Object> r = inv("acct-bare", 500.00, "SGD", "2026-06-06", "init");
        assertEquals("updated", r.get("status"));
        assertEquals(500.00, (Double) r.get("delta"), 0.01);
        assertEquals(0.00, (Double) r.get("current_balance"), 0.01);
    }

    @Test
    public void testBareAccountTargetNegative() throws Exception {
        // Balance 0, target 0 → unchanged (can't go below 0)
        Map<String, Object> r = inv("acct-bare", 0.00, "SGD", "2026-06-06", "test");
        assertEquals("unchanged", r.get("status"));
    }

    // ====================================================================
    // all 13 transaction types (DEPOSIT, REMOVAL, DIVIDENDS, INTEREST,
    // INTEREST_CHARGE, FEES, TAXES, TAX_REFUND, FEES_REFUND,
    // BUY, SELL, TRANSFER_IN, TRANSFER_OUT)
    // ====================================================================

    @Test
    public void testAllTypesAccountBalance() throws Exception {
        // acct-all-types (account-only, all 13 txn types):
        // DEPOSIT       +15000  (two deposits 1000000+500000) credit
        // REMOVAL        -2000  (200000) debit
        // DIVIDENDS       +500  (50000) credit
        // INTEREST        +100  (10000) credit
        // FEES             -50  (5000) debit
        // TAXES            -30  (3000) debit
        // TAX_REFUND       +20  (2000) credit
        // FEES_REFUND      +10  (1000) credit
        // INTEREST_CHARGE  -40  (4000) debit
        // BUY            -2000  (200000) debit
        // SELL            +1500  (150000) credit
        // TRANSFER_IN    +6000  (600000) credit
        // TRANSFER_OUT   -2500  (250000) debit
        // EXPECTED: 16510.00
        PpClient ppc = new PpClient(tmpCopy.toFile());
        Client c = ppc.load();
        Account acct = findAccount(c, "acct-all-types");
        assertEquals((Long) 1651000L, (Long) computeBalance(c, acct));
    }

    @Test
    public void testAllTypesDeltaPositive() throws Exception {
        // Balance 16510, Target 18000 → delta +1490
        Map<String, Object> r = inv("acct-all-types", 18000.00, "SGD", "2026-06-06", "test");
        assertEquals("updated", r.get("status"));
        assertEquals(1490.00, (Double) r.get("delta"), 0.01);
        assertEquals(16510.00, (Double) r.get("current_balance"), 0.01);
    }

    @Test
    public void testAllTypesDeltaNegative() throws Exception {
        // Balance 16510, Target 10000 → delta -6510
        Map<String, Object> r = inv("acct-all-types", 10000.00, "SGD", "2026-06-06", "test");
        assertEquals("updated", r.get("status"));
        assertEquals(-6510.00, (Double) r.get("delta"), 0.01);
    }

    @Test
    public void testAllTypesDeltaZero() throws Exception {
        Map<String, Object> r = inv("acct-all-types", 16510.00, "SGD", "2026-06-06", "test");
        assertEquals("unchanged", r.get("status"));
        assertEquals(0, ((Integer) r.get("delta")).intValue());
    }

    // ====================================================================
    // BUY/SELL on account + INTEREST_CHARGE + TRANSFER_IN/OUT
    // BUY=debit(subtract), SELL=credit(add), INTEREST_CHARGE=debit(subtract)
    // TRANSFER_IN=credit(add), TRANSFER_OUT=debit(subtract)
    // ====================================================================

    @Test
    public void testBuySellAccountBalance() throws Exception {
        // acct-buysell:
        // DEPOSIT         +10000  (1000000) credit
        // BUY              -3000  (300000)  debit
        // SELL             +1500  (150000)  credit
        // INTEREST_CHARGE    -50  (5000)    debit
        // TRANSFER_IN      +2000  (200000)  credit
        // TRANSFER_OUT     -1000  (100000)  debit
        // EXPECTED: 10000 - 3000 + 1500 - 50 + 2000 - 1000 = 9450
        PpClient ppc = new PpClient(tmpCopy.toFile());
        Client c = ppc.load();
        Account acct = findAccount(c, "acct-buysell");
        assertEquals((Long) 945000L, (Long) computeBalance(c, acct));
    }

    @Test
    public void testBuySellAccountDelta() throws Exception {
        // Balance 9450, Target 10050 → delta +600
        Map<String, Object> r = inv("acct-buysell", 10050.00, "USD", "2026-06-06", "test");
        assertEquals("updated", r.get("status"));
        assertEquals(600.00, (Double) r.get("delta"), 0.01);
    }

    // ====================================================================
    // fractional amounts
    // ====================================================================

    @Test
    public void testFractionalCentsPrecision() throws Exception {
        Map<String, Object> r = inv("acct-bare", 100.50, "SGD", "2026-06-06", "test");
        assertEquals(100.50, (Double) r.get("delta"), 0.01);
    }

    @Test
    public void testFractionalOneCent() throws Exception {
        Map<String, Object> r = inv("acct-bare", 0.01, "SGD", "2026-06-06", "test");
        assertEquals(0.01, (Double) r.get("delta"), 0.01);
    }

    @Test
    public void testFractionalSmallDelta() throws Exception {
        // Balance 16510, target 16510.05 → delta 0.05
        Map<String, Object> r = inv("acct-all-types", 16510.05, "SGD", "2026-06-06", "test");
        assertEquals(0.05, (Double) r.get("delta"), 0.001);
    }

    // ====================================================================
    // rounding
    // ====================================================================

    @Test
    public void testRoundingTruncates() throws Exception {
        // 100.001 → Math.round(10000.1) = 10000 cents
        Map<String, Object> r = inv("acct-bare", 100.001, "SGD", "2026-06-06", "test");
        assertEquals(100.00, (Double) r.get("delta"), 0.01);
    }

    @Test
    public void testRoundingHalfCentDown() throws Exception {
        // 100.004 → Math.round(10000.4) = 10000
        Map<String, Object> r = inv("acct-bare", 100.004, "SGD", "2026-06-06", "test");
        assertEquals(100.00, (Double) r.get("delta"), 0.01);
    }

    @Test
    public void testRoundingHalfCentUp() throws Exception {
        // 100.005 → Math.round(10000.5) = 10001 cents = 100.01
        Map<String, Object> r = inv("acct-bare", 100.005, "SGD", "2026-06-06", "test");
        assertEquals(100.01, (Double) r.get("delta"), 0.01);
    }

    // ====================================================================
    // sequential updates
    // ====================================================================

    @Test
    public void testSequentialUpdates() throws Exception {
        inv("acct-bare", 5000.00, "SGD", "2026-06-06", "step 1");
        Map<String, Object> r2 = inv("acct-bare", 8000.00, "SGD", "2026-06-06", "step 2");
        assertEquals(3000.00, (Double) r2.get("delta"), 0.01);

        Map<String, Object> r3 = inv("acct-bare", 3000.00, "SGD", "2026-06-06", "step 3");
        assertEquals(-5000.00, (Double) r3.get("delta"), 0.01);

        Map<String, Object> r4 = inv("acct-bare", 3000.00, "SGD", "2026-06-06", "step 4");
        assertEquals("unchanged", r4.get("status"));
    }

    // ====================================================================
    // other accounts untouched
    // ====================================================================

    @Test
    public void testOnlyTargetAccountModified() throws Exception {
        PpClient ppc = new PpClient(tmpCopy.toFile());
        Client before = ppc.load();
        java.util.Map<String, Long> beforeBalances = new java.util.HashMap<>();
        for (Account a : before.getAccounts()) {
            beforeBalances.put(a.getUUID(), computeBalance(before, a));
        }

        inv("acct-all-types", 15000.00, "SGD", "2026-06-06", "test");

        Client after = new PpClient(tmpCopy.toFile()).load();
        for (Account a : after.getAccounts()) {
            long afterBal = computeBalance(after, a);
            long beforeBal = beforeBalances.get(a.getUUID());
            if ("acct-all-types".equals(a.getUUID())) {
                assertNotEquals((Long) beforeBal, (Long) afterBal);
            } else {
                assertEquals((Long) beforeBal, (Long) afterBal);
            }
        }
    }

    // ====================================================================
    // helpers
    // ====================================================================

    private Account findAccount(Client c, String id) {
        for (Account a : c.getAccounts()) {
            if (a.getUUID().equals(id)) return a;
        }
        throw new RuntimeException("Account not found: " + id);
    }

    private long computeBalance(Client c, Account acct) {
        long bal = 0;
        for (AccountTransaction t : acct.getTransactions()) {
            long amt = t.getMonetaryAmount().getAmount();
            if (t.getType().isDebit())
                bal -= amt;
            else
                bal += amt;
        }
        return bal;
    }
}
