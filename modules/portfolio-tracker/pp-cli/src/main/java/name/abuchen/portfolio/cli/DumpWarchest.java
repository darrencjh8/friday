package name.abuchen.portfolio.cli;

import java.io.File;
import name.abuchen.portfolio.model.*;
import name.abuchen.portfolio.model.ClientFactory;
import org.eclipse.core.runtime.NullProgressMonitor;

public class DumpWarchest {
    public static void main(String[] args) throws Exception {
        String file = args.length > 0 ? args[0] : "data/Portfolio.portfolio";
        String password = args.length > 1 ? args[1] : "";
        String accountId = args.length > 2 ? args[2] : "68815371-05f3-43e9-9669-08b368fe1e9d";

        Client client;
        if (!password.isEmpty()) {
            client = ClientFactory.load(new File(file), password.toCharArray(), new NullProgressMonitor());
        } else {
            client = ClientFactory.load(new File(file), null, new NullProgressMonitor());
        }

        Account account = null;
        for (Account a : client.getAccounts()) {
            if (a.getUUID().equals(accountId)) { account = a; break; }
        }
        if (account == null) { System.out.println("NOT FOUND"); return; }

        System.out.println("Account: " + account.getName());

        // Account transactions — match PP UI AccountSnapshot.create() formula
        long acctBal = 0;
        for (AccountTransaction t : account.getTransactions()) {
            long amt = t.getMonetaryAmount().getAmount();
            if (t.getType().isDebit())
                acctBal -= amt;
            else
                acctBal += amt;
        }
        System.out.printf("Account txns balance (PP UI formula): %d cents (%.2f)%n", acctBal, acctBal / 100.0);

        // Portfolio transactions
        long portBal = 0;
        int buyCount = 0, sellCount = 0, delIn = 0, delOut = 0, tfrIn = 0, tfrOut = 0;
        long buySum = 0, sellSum = 0, delInSum = 0, delOutSum = 0, tfrInSum = 0, tfrOutSum = 0;

        for (Portfolio p : client.getPortfolios()) {
            if (account.equals(p.getReferenceAccount())) {
                System.out.println("Portfolio: " + p.getName() + " (" + p.getTransactions().size() + " txns)");
                for (PortfolioTransaction t : p.getTransactions()) {
                    long amt = t.getMonetaryAmount().getAmount();
                    switch (t.getType()) {
                        case BUY: portBal -= amt; buyCount++; buySum += amt; break;
                        case SELL: portBal += amt; sellCount++; sellSum += amt; break;
                        case DELIVERY_INBOUND: portBal -= amt; delIn++; delInSum += amt; break;
                        case DELIVERY_OUTBOUND: portBal += amt; delOut++; delOutSum += amt; break;
                        case TRANSFER_IN: portBal -= amt; tfrIn++; tfrInSum += amt; break;
                        case TRANSFER_OUT: portBal += amt; tfrOut++; tfrOutSum += amt; break;
                    }
                }
            }
        }
        System.out.printf("  BUY: %d (%.2f), SELL: %d (%.2f)%n", buyCount, buySum/100.0, sellCount, sellSum/100.0);
        System.out.printf("  DELIVERY_IN: %d (%.2f), DELIVERY_OUT: %d (%.2f)%n", delIn, delInSum/100.0, delOut, delOutSum/100.0);
        System.out.printf("  TRANSFER_IN: %d (%.2f), TRANSFER_OUT: %d (%.2f)%n", tfrIn, tfrInSum/100.0, tfrOut, tfrOutSum/100.0);
        System.out.printf("Portfolio effect: %d cents (%.2f)%n", portBal, portBal / 100.0);
        System.out.printf("FULL balance: %d cents (%.2f)%n", acctBal + portBal, (acctBal + portBal) / 100.0);
    }
}
