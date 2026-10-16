/**
 * Tests for hermes webhook config — verify notify route is a system push alert.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(__dirname, "../../hermes/config.yaml");

function parseSimpleYaml(content) {
    const lines = content.split("\n");
    const result = {};
    const stack = [result];
    let currentIndent = -1;

    for (const line of lines) {
        if (!line.trim() || line.trim().startsWith("#")) continue;
        const indent = line.search(/\S/);
        const trimmed = line.trim();

        // Pop stack if indent decreases
        while (stack.length > 1 && indent <= currentIndent) {
            stack.pop();
            currentIndent = stack.length > 1 ? indent : -1;
        }

        const colonIdx = trimmed.indexOf(":");
        if (colonIdx >= 0) {
            const key = trimmed.slice(0, colonIdx).trim();
            let value = trimmed.slice(colonIdx + 1).trim();

            if (value === "|") {
                // Multi-line string — read subsequent indented lines
                const parts = [];
                let j = lines.indexOf(line) + 1;
                while (j < lines.length) {
                    const nextLine = lines[j];
                    const nextIndent = nextLine.search(/\S/);
                    if (nextIndent <= indent || !nextLine.trim()) break;
                    parts.push(nextLine.trim());
                    j++;
                }
                value = parts.join("\n");
            } else if (value === "") {
                // Could be a mapping — push stack
                const obj = {};
                stack[stack.length - 1][key] = obj;
                stack.push(obj);
                currentIndent = indent;
                continue;
            } else {
                // Strip quotes
                if (
                    (value.startsWith('"') && value.endsWith('"')) ||
                    (value.startsWith("'") && value.endsWith("'"))
                ) {
                    value = value.slice(1, -1);
                }
            }

            if (
                typeof stack[stack.length - 1] === "object" &&
                !Array.isArray(stack[stack.length - 1])
            ) {
                stack[stack.length - 1][key] = value;
            }
        }
    }
    return result;
}

describe("hermes webhook config", () => {
    let config;

    beforeAll(() => {
        const content = readFileSync(configPath, "utf8");
        config = parseSimpleYaml(content);
    });

    test("notify webhook prompt is a generic system push alert — no tools, no acknowledgement", () => {
        // The notify route prompt should:
        // 1. Tell the agent this is an automated push from a service/module
        // 2. Forbid calling any tools or skills
        // 3. Instruct the agent to relay (not acknowledge) the message
        // 4. Include the {message} template variable
        const routes = config?.platforms?.webhook?.extra?.routes;
        expect(routes).toBeDefined();
        expect(routes.notify).toBeDefined();

        const prompt = routes.notify.prompt;
        expect(prompt).toBeDefined();
        expect(prompt).toContain("do NOT call any tools or skills");
        expect(prompt).toContain("Do NOT acknowledge receipt");
        expect(prompt).toContain("Message: {message}");

        // Should NOT use deliver_only — agent is needed for personalization
        expect(routes.notify.deliver_only).toBeUndefined();
        expect(routes.notify.deliver).toBe("telegram");
    });

    test("notify webhook prompt prevents table wrapping for single-item notifications", () => {
        // The simple YAML parser truncates multi-line strings, so read raw content
        const raw = readFileSync(configPath, "utf8");
        // The notify route prompt block should instruct against table wrapping
        expect(raw).toMatch(/single.*transaction.*notification/i);
        expect(raw).toMatch(/do NOT wrap.*table|NOT wrap in a table/i);
        expect(raw).toMatch(/multi-item/i);
    });
});
