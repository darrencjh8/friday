package name.abuchen.portfolio.cli;

import java.io.File;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

public class Main {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    public static void main(String[] args) {
        if (args.length == 0 || args[0].equals("--help") || args[0].equals("-h")) {
            printHelp();
            return;
        }

        try {
            String command = args[0];
            Map<String, String> params = parseArgs(args);

            File file = new File(params.getOrDefault("file", "/data/portfolio.xml"));
            String password = params.get("password");
            PpClient ppc = password != null
                ? new PpClient(file, password.toCharArray())
                : new PpClient(file);

            Object result;
            switch (command) {
                case "accounts":
                    result = ppc.listAccounts();
                    break;
                case "securities":
                    result = ppc.listSecurities();
                    break;
                case "insert":
                    result = ppc.insertTransaction(
                            require(params, "account-id"),
                            params.get("security-id"),
                            require(params, "type"),
                            require(params, "date"),
                            parseFiniteNonNegative(params.getOrDefault("shares", "0"), "shares"),
                            parseFiniteNonNegative(require(params, "price"), "price"),
                            require(params, "currency"),
                            parseFiniteNonNegative(params.getOrDefault("fees", "0"), "fees"),
                            parseFiniteNonNegative(params.getOrDefault("taxes", "0"), "taxes"),
                            params.getOrDefault("notes", ""),
                            params.get("offset-account-id"),
                            params.get("portfolio-id")
                    );
                    break;
                case "balance":
                    result = ppc.updateBalance(
                            require(params, "account-id"),
                            parseFinite(require(params, "amount"), "amount"),
                            require(params, "currency"),
                            require(params, "date"),
                            params.getOrDefault("notes", "")
                    );
                    break;
                case "taxonomy":
                    String namesRaw = require(params, "names");
                    List<String> names = Arrays.asList(namesRaw.split(","));
                    result = ppc.queryTaxonomies(names);
                    break;
                case "portfolio":
                    result = ppc.dumpPortfolio();
                    break;
                case "transactions":
                    result = ppc.dumpTransactions();
                    break;
                case "status":
                    result = ppc.getStatus();
                    break;
                case "query":
                    result = ppc.querySecurity(
                        require(params, "search"),
                        params.get("account-id")
                    );
                    break;
                case "import":
                    result = ppc.importIbkr(
                            new File(require(params, "ibkr-xml")),
                            params.getOrDefault("ibkr-sgd-account", ""),
                            params.getOrDefault("ibkr-usd-account", ""),
                            params.getOrDefault("ibkr-portfolio-account", "")
                    );
                    break;
                default:
                    System.err.println(GSON.toJson(Map.of(
                            "error", "Unknown command: " + command,
                            "available", List.of("accounts", "securities", "insert", "balance", "taxonomy", "portfolio")
                    )));
                    throw new IllegalArgumentException("Unknown command: " + command);
            }

            System.out.println(GSON.toJson(result));

        } catch (Exception e) {
            System.err.println(GSON.toJson(Map.of("error", e.getMessage())));
            throw new RuntimeException(e.getMessage(), e);
        }
    }

    private static Map<String, String> parseArgs(String[] args) {
        Map<String, String> params = new java.util.LinkedHashMap<>();
        for (int i = 1; i < args.length; i++) {
            String arg = args[i];
            if (arg.startsWith("--")) {
                String key = arg.substring(2);
                if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
                    params.put(key, args[i + 1]);
                    i++;
                } else {
                    params.put(key, "true");
                }
            } else if (arg.startsWith("-")) {
                String key = arg.substring(1);
                if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
                    params.put(key, args[i + 1]);
                    i++;
                } else {
                    params.put(key, "true");
                }
            }
        }
        return params;
    }

    private static String require(Map<String, String> params, String key) {
        String value = params.get(key);
        if (value == null || value.isEmpty()) {
            throw new IllegalArgumentException("Missing required parameter: " + key);
        }
        return value;
    }

    private static double parseFiniteNonNegative(String raw, String name) {
        double value = Double.parseDouble(raw);
        if (!Double.isFinite(value) || value < 0) {
            throw new IllegalArgumentException(
                name + " must be a finite non-negative number, got: " + raw);
        }
        return value;
    }

    private static double parseFinite(String raw, String name) {
        double value = Double.parseDouble(raw);
        if (!Double.isFinite(value)) {
            throw new IllegalArgumentException(
                name + " must be a finite number, got: " + raw);
        }
        return value;
    }

    private static void printHelp() {
        System.out.println("Portfolio Performance CLI Tool");
        System.out.println();
        System.out.println("Usage: java -jar pp-cli.jar <command> [options]");
        System.out.println();
        System.out.println("Commands:");
        System.out.println("  accounts    --file <path>              List all accounts and portfolios");
        System.out.println("  securities  --file <path>              List all securities");
        System.out.println("  insert      --file <path> --account-id <id> [--security-id <id>]");
        System.out.println("              --type <Buy|Sell|Dividend|Deposit|Withdrawal|Fee|Tax|Interest>");
        System.out.println("              --date <YYYY-MM-DD> --shares <n>");
        System.out.println("              --price <n> --currency <CODE>");
        System.out.println("              [--fees <n>] [--taxes <n>] [--notes <text>]");
        System.out.println("  balance     --file <path> --account-id <id> --amount <n>");
        System.out.println("              --currency <CODE> --date <YYYY-MM-DD> [--notes <text>]");
        System.out.println("  taxonomy    --file <path> --names <tax1,tax2,...>");
        System.out.println("  portfolio   --file <path>              Dump full portfolio structure");
        System.out.println("  transactions --file <path>             Dump all transaction hashes");
        System.out.println("  status      --file <path>              Portfolio performance summary");
        System.out.println("  query       --file <path> --search <t> Query security by ticker/ISIN");
        System.out.println("  --help, -h                             Show this help");
    }
}
