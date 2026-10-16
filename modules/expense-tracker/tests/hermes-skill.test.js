/**
 * Contract test for the Hermes expense-tracker skill.
 *
 * The skill is baked into the Hermes image (Dockerfile COPY skills/) and seeded
 * into the runtime on every boot (50-seed-defaults), so the repo copy is the
 * only source that matters. This pins the parts a future edit could silently
 * break: the MCP tool spellings Hermes must call, and the fact shapes the
 * tracker actually accepts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const skillPath = resolve(
  repoRoot,
  "modules/hermes/skills/expense-tracker/SKILL.md",
);
const dockerfilePath = resolve(repoRoot, "modules/hermes/Dockerfile");
const seedPath = resolve(repoRoot, "modules/hermes/50-seed-defaults");

describe("hermes expense-tracker skill", () => {
  const skill = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : "";

  it("exists in the repo (the copy that gets baked)", () => {
    expect(existsSync(skillPath)).toBe(true);
  });

  it("names the MCP tools Hermes can actually call", () => {
    for (const tool of [
      "search_facts",
      "fetch_context",
      "learn_fact",
      "update_fact",
      "delete_fact",
      "cleanup_facts",
    ]) {
      expect(skill).toContain(tool);
    }
  });

  it("does not tell Hermes to call search_memory (the HTTP-side name)", () => {
    expect(skill).not.toContain("search_memory");
  });

  it("documents the tolerant shapes the tracker accepts", () => {
    expect(skill).toContain("Card/account");
    expect(skill).toContain("ending in");
  });

  it("documents the canonical written form", () => {
    expect(skill).toContain("Card ending 7111 belongs to Epsilon Nova Card");
    expect(skill).toContain("Account ending 7222 belongs to Epsilon Account");
  });

  it("states that ambiguity refuses rather than guessing", () => {
    expect(skill.toLowerCase()).toContain("ambiguous");
    expect(skill.toLowerCase()).toContain("guess");
  });

  it("installs the PDF decryption tool the tracker invokes", () => {
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    expect(dockerfile).toMatch(/apt-get install[\s\S]*\bqpdf\b/);
  });

  it("is still baked into the image and seeded on boot", () => {
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    const seed = readFileSync(seedPath, "utf8");
    expect(dockerfile).toMatch(/COPY\s+skills\//);
    expect(seed).toContain("/opt/hermes-defaults/skills");
  });
});
