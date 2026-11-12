import assert from "node:assert/strict";
import { test } from "node:test";
import { loadAgents, mergeAgents, removeAgent, saveAgents } from "./store.ts";
import type { WebAgent } from "./types.ts";

/**
 * mergeAgents garde le premier agent à sa place quand on le ré-appaire (friday #212) :
 * c'est ce qui fait tenir le nom "premier agent connecté". localStorage est un faux
 * minimal (Map) : le module ne le touche que dans ses fonctions.
 */
const backing = new Map<string, string>();

(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => {
    backing.set(key, value);
  },
};

const agent = (over: Partial<WebAgent> = {}): WebAgent => ({
  url: "wss://example.invalid/dots/ws",
  token: "token",
  session_id: "session",
  agent_id: "agent",
  name: "Friday",
  species: "nova",
  palette: "sky",
  accessory: "none",
  ...over,
});

const friday = agent({ session_id: "friday", agent_id: "friday", name: "Friday", url: "wss://phone/dots/ws" });
const galet = agent({ session_id: "galet", agent_id: "galet", name: "Galet", species: "galet", url: "wss://phone2/dots/ws" });

test("mergeAgents.repairKeepsFirst", () => {
  saveAgents([friday, galet]);
  const updated = mergeAgents([{ ...friday, name: "Friday 2" }]);
  assert.deepEqual(
    updated.map((a) => a.session_id),
    ["friday", "galet"],
    "mergeAgents.repairKeepsFirst failed: re-pairing the first agent moved it to the end",
  );
  assert.equal(updated[0].name, "Friday 2");
  assert.deepEqual(loadAgents().map((a) => a.session_id), ["friday", "galet"]);
});

test("mergeAgents.newAgentAppends", () => {
  saveAgents([friday, galet]);
  const nuage = agent({ session_id: "nuage", agent_id: "nuage", name: "Nuage", species: "nuage" });
  const updated = mergeAgents([nuage]);
  assert.deepEqual(
    updated.map((a) => a.session_id),
    ["friday", "galet", "nuage"],
    "mergeAgents.newAgentAppends failed: a genuinely new agent did not append at the end",
  );
});

test("mergeAgents.removeFirstPromotesNext", () => {
  saveAgents([friday, galet]);
  removeAgent(friday);
  assert.deepEqual(
    loadAgents().map((a) => a.session_id),
    ["galet"],
    "mergeAgents.removeFirstPromotesNext failed: removing the first agent did not promote the next one",
  );
});
