const fs = require("fs");
const path = require("path");

function substituteTemplate(template, env) {
  const vars = Object.keys(env).filter(
    (k) => !k.includes("PATH") && !k.includes("HOME") && !k.includes("SHLVL") && !k.includes("PWD"),
  );
  vars.sort((a, b) => b.length - a.length);
  let result = template;
  for (const k of vars) {
    const re = new RegExp("\\$" + k + "(?![a-zA-Z0-9_])", "g");
    result = result.replace(re, env[k] || "");
  }
  return result;
}

describe("docker-entrypoint.sh template substitution", () => {
  test("replaces a single env var in template", () => {
    const template = "Hello $USER_NAME!";
    const env = { USER_NAME: "TestUser" };
    expect(substituteTemplate(template, env)).toBe("Hello TestUser!");
  });

  test("replaces multiple env vars in template", () => {
    const template = "You are $USER_NAME. Budget: $ACTUAL_BUDGET_FILE. Token: $TELEGRAM_BOT_TOKEN";
    const env = {
      USER_NAME: "TestUser",
      ACTUAL_BUDGET_FILE: "Test SGD",
      TELEGRAM_BOT_TOKEN: "123:abc",
    };
    expect(substituteTemplate(template, env)).toBe(
      "You are TestUser. Budget: Test SGD. Token: 123:abc",
    );
  });

  test("replaces var when followed by punctuation", () => {
    const template = "$BUDGET_FILE, $BUDGET_FILE. $BUDGET_FILE!";
    const env = { BUDGET_FILE: "MyBudget" };
    expect(substituteTemplate(template, env)).toBe("MyBudget, MyBudget. MyBudget!");
  });

  test("replaces var when followed by newline", () => {
    const template = "$BUDGET_FILE\n$USER_NAME";
    const env = { BUDGET_FILE: "MyBudget", USER_NAME: "TestUser" };
    expect(substituteTemplate(template, env)).toBe("MyBudget\nTestUser");
  });

  test("does NOT replace var when followed by alphanumeric (word boundary)", () => {
    const template = "$BUDGET_FILE_ID should not match, but $BUDGET_FILE should";
    const env = { BUDGET_FILE: "MyBudget" };
    const result = substituteTemplate(template, env);
    expect(result).toBe("$BUDGET_FILE_ID should not match, but MyBudget should");
  });

  test("replaces longest var name first to avoid partial matches", () => {
    const template = "$ACTUAL_BUDGET_FILE is my budget, file: $ACTUAL_BUDGET";
    const env = { ACTUAL_BUDGET_FILE: "Test SGD", ACTUAL_BUDGET: "default" };
    const result = substituteTemplate(template, env);
    expect(result).toBe("Test SGD is my budget, file: default");
  });

  test("leaves unknown vars unchanged", () => {
    const template = "Hello $UNKNOWN_VAR!";
    const env = { USER_NAME: "TestUser" };
    expect(substituteTemplate(template, env)).toBe("Hello $UNKNOWN_VAR!");
  });

  test("empty env produces unchanged template", () => {
    const template = "No $VARS here";
    expect(substituteTemplate(template, {})).toBe("No $VARS here");
  });

  test("excludes PATH, HOME, SHLVL, PWD from substitution", () => {
    const template = "$PATH $HOME $SHLVL $PWD";
    const env = { PATH: "/usr/bin", HOME: "/home", SHLVL: "2", PWD: "/app", USER_NAME: "TestUser" };
    const result = substituteTemplate(template, env);
    expect(result).toBe("$PATH $HOME $SHLVL $PWD");
  });

  test("env var with empty value is replaced with empty string", () => {
    const template = "Prefix $SOMETHING suffix";
    const env = { SOMETHING: "" };
    const result = substituteTemplate(template, env);
    expect(result).toBe("Prefix  suffix");
  });

  test("replaces var at end of template", () => {
    const template = "Budget: $ACTUAL_BUDGET_FILE";
    const env = { ACTUAL_BUDGET_FILE: "Test SGD" };
    expect(substituteTemplate(template, env)).toBe("Budget: Test SGD");
  });

  test("replaces var at start of template", () => {
    const template = "$USER_NAME is logged in";
    const env = { USER_NAME: "TestUser" };
    expect(substituteTemplate(template, env)).toBe("TestUser is logged in");
  });

  test("replaces vars with underscores in names", () => {
    const template = "$MY_LONG_VAR_NAME value";
    const env = { MY_LONG_VAR_NAME: "found" };
    expect(substituteTemplate(template, env)).toBe("found value");
  });

  test("does not confuse $ as regex boundary when literal $ present", () => {
    const template = "Price: $10.50 for $ITEM";
    const env = { ITEM: "coffee" };
    const result = substituteTemplate(template, env);
    expect(result).toBe("Price: $10.50 for coffee");
  });

  test("AGENTS.md template with realistic content", () => {
    const template = `You are $USER_NAME's personal finance assistant with access to Actual Budget.
Keep responses short, punchy, and conversational.

$SYSTEM_PROMPT_EXTRA

## Tools

All tools at http://expense-tracker:8080/tools/<name> via POST with JSON body.

## Budgets

- **$ACTUAL_BUDGET_FILE** — default`;

    const env = {
      USER_NAME: "TestUser",
      SYSTEM_PROMPT_EXTRA: "Additional context here.",
      PATH: "/usr/bin",
      HOME: "/home/darren",
    };

    const result = substituteTemplate(template, env);
    expect(result).toContain("You are TestUser's personal finance assistant");
    expect(result).toContain("Additional context here.");
    expect(result).toContain("$ACTUAL_BUDGET_FILE");
    expect(result).not.toContain("$USER_NAME");
    expect(result).not.toContain("$SYSTEM_PROMPT_EXTRA");
  });
});
