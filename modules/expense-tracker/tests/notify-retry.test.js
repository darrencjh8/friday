import { afterEach, describe, expect, test, vi } from "vitest";
import { ToolRegistry } from "../src/tools.js";

afterEach(() => vi.unstubAllGlobals());

function notificationContext() {
  return {
    _notificationSink: null,
    _emailMsgId: null,
    _config: { notifyUrl: "http://notify.test" },
  };
}

function networkError(code) {
  const error = new Error(code);
  error.cause = { code };
  return error;
}

describe("notify_user network retry", () => {
  test("retries once after a network error", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(networkError("ECONNREFUSED"))
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", fetch);

    const result = await ToolRegistry.prototype._handle_notify_user.call(
      notificationContext(),
      { message: "synthetic notification" },
    );

    expect(result).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("retries once after an Undici connect timeout", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(networkError("UND_ERR_CONNECT_TIMEOUT"))
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", fetch);

    const result = await ToolRegistry.prototype._handle_notify_user.call(
      notificationContext(),
      { message: "synthetic notification" },
    );

    expect(result).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("stops after two network failures", async () => {
    const fetch = vi.fn().mockRejectedValue(networkError("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetch);

    const result = await ToolRegistry.prototype._handle_notify_user.call(
      notificationContext(),
      { message: "synthetic notification" },
    );

    expect(result).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
