import { afterEach, describe, expect, test, vi } from "vitest";
import { ToolRegistry } from "../src/tools.js";

afterEach(() => vi.unstubAllGlobals());

describe("notify_user ambiguous delivery", () => {
  test("does not resend after remote delivery and lost response", async () => {
    let delivered = 0;
    const fetch = vi.fn(async () => {
      delivered++;
      if (delivered === 1) throw new Error("response connection reset");
      return { ok: true };
    });
    vi.stubGlobal("fetch", fetch);

    const result = await ToolRegistry.prototype._handle_notify_user.call(
      {
        _notificationSink: null,
        _emailMsgId: null,
        _config: { notifyUrl: "http://notify.test" },
      },
      { message: "synthetic notification" },
    );

    expect(result).toBe(false);
    expect(delivered).toBe(1);
  });
});
