import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePayload } from "./crypto.ts";

/**
 * Le `launcher_icon` du message d'appairage suit les clés #136
 * (friday #231) : le téléphone n'envoie plus que default / night / day.
 * Une ancienne couleur d'avant #136 retombe sur Default, comme une
 * valeur inconnue ou absente. `validatePayload` est une validation pure
 * (pas de WebCrypto ici), donc ces tests tournent sans clés.
 */
function payload(launcherIcon: unknown): unknown {
  const agent: Record<string, unknown> = {
    url: "wss://example.invalid/dots/ws",
    token: "token",
    session_id: "session",
  };
  if (launcherIcon !== undefined) agent.launcher_icon = launcherIcon;
  return { v: 1, agents: [agent] };
}

test("crypto.launcherIcon.night", () => {
  const { agents } = validatePayload(payload("night"));
  assert.equal(
    agents[0]?.launcher_icon,
    "night",
    "crypto.launcherIcon.night failed: night was dropped to Default",
  );
});

test("crypto.launcherIcon.day", () => {
  const { agents } = validatePayload(payload("day"));
  assert.equal(
    agents[0]?.launcher_icon,
    "day",
    "crypto.launcherIcon.day failed: day was dropped to Default",
  );
});

test("crypto.launcherIcon.oldColour", () => {
  const { agents } = validatePayload(payload("blue"));
  assert.equal(
    agents[0]?.launcher_icon,
    "default",
    "crypto.launcherIcon.oldColour failed: a pre-#136 colour survived validation",
  );
});

test("crypto.launcherIcon.missing", () => {
  const { agents } = validatePayload(payload(undefined));
  assert.equal(agents[0]?.launcher_icon, "default");
});
