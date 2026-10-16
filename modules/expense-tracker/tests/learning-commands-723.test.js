/**
 * Issue #723: the learning offer is answered with /remember_<id> and
 * /forget_<id> on Hermes's own bot, so the model never holds the confirm path.
 * Offline: Telegram is a fetch double and the offer file is in a temp dir.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("mailparser", () => ({ simpleParser: vi.fn() }));
vi.mock("better-sqlite3", () => ({ default: vi.fn() }));
vi.mock("@xenova/transformers", () => ({ pipeline: vi.fn(), env: {} }));
vi.mock("../src/dedup.js", () => ({
    DedupJournal: vi.fn(function () {
        this.record = vi.fn();
        this.checkDuplicate = vi.fn(() => false);
        this.close = vi.fn();
    }),
}));

import { ToolRegistry } from "../src/tools.js";
import { Config } from "../src/config.js";
import { migratePendingLearning } from "../src/learning.js";
import { LearningNotifier, createAnswerHandler, signAnswer, verifyAnswer } from "../src/learning-notify.js";
import { toolShapes, createTools } from "../src/mcp-server.js";

const CHAT = "4242";
const TOKEN = "123:test-token";
// Shared with modules/hermes/tests/test_learning_commands_plugin.py.
const VECTOR = {
    action: "remember",
    id: "ABCDEFGH",
    signature: "a7f29839a966ef459f6f18be8b620e8319b0c31ad43894aed11ff1c9c5a1e9d8",
};
const PAYEES = [
    { id: "p-misc", name: "Misc" },
    { id: "p-interest", name: "Bank Interest" },
];

let dir;
let memory;
let telegram;

function telegramFetch() {
    telegram = [];
    return vi.fn(async (url, init) => {
        telegram.push({ method: String(url).split("/").pop(), body: JSON.parse(init.body) });
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) };
    });
}

const commandsConfig = { telegramBotToken: TOKEN, telegramHomeChannel: CHAT };

function registry(config = {}) {
    const reg = new ToolRegistry(
        {
            dedupDbPath: ":memory:",
            primaryBudgetFile: "budget-sgd",
            pendingLearningPath: join(dir, "state", "pending.json"),
            ...config,
        },
        memory,
    );
    reg._get = vi.fn(async () => PAYEES);
    return reg;
}

function setup(config = commandsConfig) {
    const reg = registry(config);
    const fetchFn = telegramFetch();
    const notifier = new LearningNotifier({ token: TOKEN, chatId: CHAT, fetchFn });
    reg.setLearningNotifier(notifier);
    const handler = createAnswerHandler({ registry: reg, token: config.telegramBotToken, chatId: config.telegramHomeChannel });
    return { reg, notifier, handler, fetchFn };
}

/** Calls the handler like Express would and returns {status, body}. */
async function answer(handler, body, signature) {
    const out = { status: 200, body: null };
    const res = {
        status(code) { out.status = code; return this; },
        json(value) { out.body = value; return this; },
    };
    const req = { body, get: (name) => (name.toLowerCase() === "x-learning-signature" ? signature : undefined) };
    await handler(req, res);
    return out;
}

async function offered() {
    const ctx = setup();
    const { id } = await ctx.reg.executeTool("propose_learning", {
        descriptor: "360 SAVE BONUS", payee: "Bank Interest", runner_up: "Salary", budget_id: "b",
    });
    return { ...ctx, id };
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "learning-723-"));
    memory = {
        search: vi.fn(async () => []),
        add: vi.fn(async () => ({ added: true, skipped: false, reason: "" })),
        listFacts: vi.fn(() => []),
    };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("answer signing (#723)", () => {
    it("matches the shared test vector the Hermes plugin also checks", () => {
        expect(signAnswer(VECTOR.action, VECTOR.id, TOKEN)).toBe(VECTOR.signature);
        expect(signAnswer(VECTOR.action, VECTOR.id.toLowerCase(), TOKEN)).toBe(VECTOR.signature);
        expect(verifyAnswer(VECTOR.signature, VECTOR.action, VECTOR.id, TOKEN)).toBe(true);
    });

    it("rejects a wrong action, id, token, length and type", () => {
        expect(verifyAnswer(VECTOR.signature, "forget", VECTOR.id, TOKEN)).toBe(false);
        expect(verifyAnswer(VECTOR.signature, VECTOR.action, "ZZZZZZZZ", TOKEN)).toBe(false);
        expect(verifyAnswer(VECTOR.signature, VECTOR.action, VECTOR.id, "other")).toBe(false);
        expect(verifyAnswer(VECTOR.signature.slice(1), VECTOR.action, VECTOR.id, TOKEN)).toBe(false);
        expect(verifyAnswer(undefined, VECTOR.action, VECTOR.id, TOKEN)).toBe(false);
    });
});

describe("sending an offer (#723)", () => {
    it("sends one plain message with tappable commands and no buttons", async () => {
        const { reg } = setup();
        const { id } = await reg.executeTool("propose_learning", {
            descriptor: "360 SAVE BONUS", payee: "Bank Interest", runner_up: "Salary", budget_id: "b",
        });
        expect(telegram).toHaveLength(1);
        const { method, body } = telegram[0];
        expect(method).toBe("sendMessage");
        expect(body.chat_id).toBe(CHAT);
        expect(body).not.toHaveProperty("reply_markup");
        expect(body.text).toContain("360 SAVE BONUS");
        expect(body.text).toContain("Bank Interest");
        expect(body.text).toContain("Salary");
        expect(body.text).toContain(`/remember_${id.toLowerCase()}`);
        expect(body.text).toContain(`/forget_${id.toLowerCase()}`);
        expect(`remember_${id.toLowerCase()}`).toMatch(/^[a-z0-9_]{1,32}$/);
    });

    it("never polls", async () => {
        await offered();
        expect(telegram.map((c) => c.method)).toEqual(["sendMessage"]);
    });

    it("a failed send does not fail the offer", async () => {
        const { reg, notifier } = setup();
        notifier._fetch = vi.fn(async () => { throw new Error("down"); });
        const result = await reg.executeTool("propose_learning", {
            descriptor: "360 SAVE BONUS", payee: "Bank Interest", budget_id: "b",
        });
        expect(result.offered).toBe(true);
    });
});

describe("POST /learning/answer (#723)", () => {
    it("remember learns exactly one fact and discards the offer", async () => {
        const { reg, handler, id } = await offered();
        const out = await answer(handler, { id: id.toLowerCase(), action: "remember" }, signAnswer("remember", id, TOKEN));
        expect(out.status).toBe(200);
        expect(out.body).toEqual({ ok: true, result: "remembered", descriptor: "360 SAVE BONUS", payee: "Bank Interest" });
        expect(memory.add).toHaveBeenCalledTimes(1);
        expect(memory.add.mock.calls[0][0]).toBe("360 SAVE BONUS maps to Bank Interest payee");
        expect(reg._pendingLearning.get(id)).toBeNull();
    });

    it("forget learns nothing and discards the offer", async () => {
        const { reg, handler, id } = await offered();
        const out = await answer(handler, { id, action: "forget" }, signAnswer("forget", id, TOKEN));
        expect(out.body).toMatchObject({ ok: true, result: "forgotten", descriptor: "360 SAVE BONUS" });
        expect(memory.add).not.toHaveBeenCalled();
        expect(reg._pendingLearning.get(id)).toBeNull();
    });

    it("a second remember is expired and learns nothing more", async () => {
        const { handler, id } = await offered();
        const sig = signAnswer("remember", id, TOKEN);
        await answer(handler, { id, action: "remember" }, sig);
        const again = await answer(handler, { id, action: "remember" }, sig);
        expect(again.status).toBe(404);
        expect(again.body).toEqual({ ok: false, reason: "expired" });
        expect(memory.add).toHaveBeenCalledTimes(1);
    });

    it("rejects a missing, forged or wrong-action signature with 403 and changes nothing", async () => {
        const { reg, handler, id } = await offered();
        for (const sig of [undefined, "a".repeat(64), signAnswer("forget", id, TOKEN), signAnswer("remember", id, "other")]) {
            const out = await answer(handler, { id, action: "remember" }, sig);
            expect(out.status).toBe(403);
            expect(out.body.ok).toBe(false);
        }
        expect(memory.add).not.toHaveBeenCalled();
        expect(reg._pendingLearning.get(id)).not.toBeNull();
    });

    it("rejects an unknown action and a malformed id", async () => {
        const { handler, id } = await offered();
        expect((await answer(handler, { id, action: "confirm" }, signAnswer("confirm", id, TOKEN))).status).toBe(403);
        expect((await answer(handler, { id: "a b", action: "remember" }, signAnswer("remember", "a b", TOKEN))).status).toBe(403);
        expect((await answer(handler, undefined, "x")).status).toBe(403);
    });

    it("rejects a validly signed answer for an unknown or expired offer", async () => {
        const { reg, handler, id } = await offered();
        expect((await answer(handler, { id: "NOPE", action: "remember" }, signAnswer("remember", "NOPE", TOKEN))).status).toBe(404);
        reg._pendingLearning._now = () => Date.now() + 8 * 24 * 60 * 60 * 1000;
        const out = await answer(handler, { id, action: "remember" }, signAnswer("remember", id, TOKEN));
        expect(out.body).toEqual({ ok: false, reason: "expired" });
        expect(memory.add).not.toHaveBeenCalled();
    });

    it("is 403 when commands mode is off, even with a correct-looking signature", async () => {
        const reg = registry();
        const handler = createAnswerHandler({ registry: reg, token: "", chatId: "" });
        const { id } = await reg.executeTool("propose_learning", { descriptor: "360 SAVE BONUS", payee: "Bank Interest", budget_id: "b" });
        const out = await answer(handler, { id, action: "remember" }, signAnswer("remember", id, ""));
        expect(out.status).toBe(403);
        expect(memory.add).not.toHaveBeenCalled();
    });

    it("reports a failed save as ok:false and keeps the offer", async () => {
        const { reg, handler, id } = await offered();
        memory.add.mockResolvedValueOnce({ added: false, skipped: false, reason: "invalid" });
        const out = await answer(handler, { id, action: "remember" }, signAnswer("remember", id, TOKEN));
        expect(out.status).toBe(500);
        expect(out.body.ok).toBe(false);
        expect(reg._pendingLearning.get(id)).not.toBeNull();
    });
});

describe("model-facing surface (#723)", () => {
    const names = (reg) => reg.getToolSchemas().map((t) => t.function.name);

    it("with commands on, confirm_learning is gone from the tools list and cannot be executed", async () => {
        const { reg } = setup();
        expect(names(reg)).not.toContain("confirm_learning");
        expect(names(reg)).toContain("decline_learning");
        expect(names(reg).some((n) => /answer|remember|forget/.test(n))).toBe(false);
        expect(await reg.executeTool("confirm_learning", { id: "ABCDEFGH" })).toMatchObject({ confirmed: false });
        expect(memory.add).not.toHaveBeenCalled();
    });

    it("with commands on, MCP does not register confirm_learning or the answer route", () => {
        const { reg } = setup();
        const tool = vi.fn();
        createTools({ tool }, reg);
        const registered = tool.mock.calls.map((c) => c[0]);
        expect(registered).not.toContain("confirm_learning");
        expect(registered.some((n) => /answer|remember|forget/.test(n))).toBe(false);
        expect(registered).toContain("decline_learning");
        expect(registered).toContain("list_pending_learning");
    });

    it("with commands on, list_pending_learning omits offer ids", async () => {
        const { reg } = setup();
        await reg.executeTool("propose_learning", { descriptor: "360 SAVE BONUS", payee: "Bank Interest", budget_id: "b" });
        const { offers } = await reg.executeTool("list_pending_learning", {});
        expect(offers).toHaveLength(1);
        expect(offers[0]).not.toHaveProperty("id");
    });

    it("one of the two settings alone leaves commands off", () => {
        expect(registry({ telegramBotToken: TOKEN }).learningCommandsEnabled).toBe(false);
        expect(registry({ telegramHomeChannel: CHAT }).learningCommandsEnabled).toBe(false);
    });

    it("without commands, nothing changes", async () => {
        const reg = registry();
        const tool = vi.fn();
        createTools({ tool }, reg);
        expect(names(reg)).toContain("confirm_learning");
        expect(tool.mock.calls.map((c) => c[0])).toContain("confirm_learning");
        const { id } = await reg.executeTool("propose_learning", { descriptor: "360 SAVE BONUS", payee: "Bank Interest", budget_id: "b" });
        expect((await reg.executeTool("list_pending_learning", {})).offers[0].id).toBe(id);
        expect(await reg.executeTool("confirm_learning", { id })).toMatchObject({ confirmed: true });
        expect(toolShapes.confirm_learning).toBeDefined();
    });
});

describe("config and store location (#723)", () => {
    it("reads Hermes's bot settings and defaults the store under state/", () => {
        const cfg = new Config({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_HOME_CHANNEL: "9" });
        expect(cfg.telegramBotToken).toBe("t");
        expect(cfg.telegramHomeChannel).toBe("9");
        expect(cfg.pendingLearningPath).toBe("state/pending-learning.json");
        expect(new Config({}).telegramBotToken).toBe("");
    });

    it("migrates the old offer file once and never overwrites the new one", () => {
        const oldPath = join(dir, "data", "pending-learning.json");
        const newPath = join(dir, "state", "pending-learning.json");
        mkdirSync(join(dir, "data"));
        writeFileSync(oldPath, '{"offers":[1]}');
        expect(migratePendingLearning(oldPath, newPath)).toBe(true);
        expect(existsSync(oldPath)).toBe(false);
        expect(readFileSync(newPath, "utf8")).toBe('{"offers":[1]}');

        writeFileSync(oldPath, '{"offers":[2]}');
        expect(migratePendingLearning(oldPath, newPath)).toBe(false);
        expect(readFileSync(newPath, "utf8")).toBe('{"offers":[1]}');
        expect(migratePendingLearning(join(dir, "none.json"), join(dir, "x", "y.json"))).toBe(false);
    });

    it("with commands on, never imports the shared-volume file, only deletes it", () => {
        const oldPath = join(dir, "data", "pending-learning.json");
        const newPath = join(dir, "state", "pending-learning.json");
        mkdirSync(join(dir, "data"));
        writeFileSync(oldPath, '{"offers":[{"id":"PLANTED"}]}');
        expect(migratePendingLearning(oldPath, newPath, { discard: true })).toBe(false);
        expect(existsSync(oldPath)).toBe(false);
        expect(existsSync(newPath)).toBe(false);
    });
});
