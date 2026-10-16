/**
 * Issue #783 Phase 2: while Hermes's processing request runs, the registry
 * hands notifications and learning offers to the request instead of sending
 * them, so the user hears about each email exactly once, from Hermes.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ToolRegistry } from "../src/tools.js";

describe("ToolRegistry notification and offer sinks (#783)", () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function registry() {
    const dir = mkdtempSync(join(tmpdir(), "sinks-"));
    dirs.push(dir);
    const reg = new ToolRegistry(
      { notifyUrl: "http://notify.invalid", notifySecret: "s", pendingLearningPath: join(dir, "p.json") },
      null,
    );
    reg._get = vi.fn(async () => [{ name: "Food" }, { name: "Drinks" }]);
    return reg;
  }

  it("notify_user goes to the sink, not the network, while one is set", async () => {
    const reg = registry();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const seen = [];
    reg.setNotificationSink(async (m) => (seen.push(m), true));

    expect(await reg.executeTool("notify_user", { message: "hello" })).toBe(true);
    expect(seen).toEqual(["hello"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("a learning offer goes to the sink, not Telegram", async () => {
    const reg = registry();
    const notifier = { sendOffer: vi.fn() };
    reg.setLearningNotifier(notifier);
    const seen = [];
    reg.setOfferSink(async (o) => seen.push(o));

    const res = await reg.executeTool("propose_learning", { descriptor: "Alpha Cafe", payee: "Food" });

    expect(res.offered).toBe(true);
    expect(notifier.sendOffer).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: res.id, descriptor: "Alpha Cafe", payee: "Food" });
  });

  it("clearing the sinks restores normal delivery", async () => {
    const reg = registry();
    const notifier = { sendOffer: vi.fn() };
    reg.setLearningNotifier(notifier);
    reg.setOfferSink(async () => {});
    reg.setOfferSink(null);

    await reg.executeTool("propose_learning", { descriptor: "Beta Bar", payee: "Drinks" });
    expect(notifier.sendOffer).toHaveBeenCalledTimes(1);
  });
});
