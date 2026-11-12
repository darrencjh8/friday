import assert from "node:assert/strict";
import { test } from "node:test";
import { appName, setAppIcon } from "./appIcon.ts";
import type { WebAgent } from "./types.ts";

/**
 * L'icône de l'onglet et de la PWA suit le choix du logo du téléphone
 * (friday #211) : un logo explicite remplace la photo demi-buste de Nova.
 * Le nom de l'app suit le premier agent appairé (friday #212) : "Hermes" avant tout
 * appairage, le nom du premier agent ensuite, via ?name= sur le manifeste.
 * `document` est un faux minimal : seuls les `link[rel]` lus par setAppIcon
 * existent, avec leur href enregistré.
 */
const seen = new Map<string, string>();

function installDocument(): void {
  seen.clear();
  const fake = {
    querySelector: (selector: string) => {
      const rel = /link\[rel="([^"]+)"\]/.exec(selector)?.[1];
      if (!rel) return null;
      return {
        setAttribute: (_name: string, value: string) => {
          seen.set(rel, value);
        },
      };
    },
  };
  (globalThis as unknown as { document: unknown }).document = fake;
}

test("appIcon.launcherIcon.blue", () => {
  installDocument();
  setAppIcon("nova", "blue");
  assert.equal(
    seen.get("icon"),
    "/icons/nova-blue-192.png",
    "appIcon.launcherIcon.blue failed: icon href stayed on the half-body Nova icon",
  );
  assert.equal(seen.get("apple-touch-icon"), "/icons/nova-blue-192.png");
  assert.equal(seen.get("manifest"), "/manifest-nova-blue.webmanifest?name=Hermes");
});

test("appIcon.launcherIcon.default", () => {
  installDocument();
  setAppIcon("nova", "default");
  assert.equal(
    seen.get("icon"),
    "/icons/nova-default-192.png",
    "appIcon.launcherIcon.default failed: icon href stayed on the half-body Nova icon",
  );
  assert.equal(seen.get("apple-touch-icon"), "/icons/nova-default-192.png");
  assert.equal(seen.get("manifest"), "/manifest-nova-default.webmanifest?name=Hermes");
});

test("appIcon.launcherIcon.unknown", () => {
  installDocument();
  setAppIcon("nova", "nope");
  assert.equal(seen.get("icon"), "/icons/nova-192.png");
  assert.equal(seen.get("manifest"), "/manifest-nova.webmanifest?name=Hermes");
});

test("appIcon.launcherIcon.nonNova", () => {
  installDocument();
  setAppIcon("galet", "blue");
  assert.equal(seen.get("icon"), "/icons/galet-192.png");
  assert.equal(seen.get("manifest"), "/manifest-galet.webmanifest?name=Hermes");
});

test("appIcon.launcherIcon.missing", () => {
  installDocument();
  setAppIcon("nova");
  assert.equal(seen.get("icon"), "/icons/nova-192.png");
  assert.equal(seen.get("manifest"), "/manifest-nova.webmanifest?name=Hermes");
});

test("appIcon.launcherIcon.named", () => {
  installDocument();
  setAppIcon("nova", "blue", "Friday");
  assert.equal(seen.get("icon"), "/icons/nova-blue-192.png");
  assert.equal(seen.get("manifest"), "/manifest-nova-blue.webmanifest?name=Friday");
});

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

test("appName.firstAgent", () => {
  assert.equal(appName([agent({ name: "Friday" })]), "Friday");
});

test("appName.noAgent", () => {
  assert.equal(appName([]), "Hermes");
});

test("appName.secondAgentIgnored", () => {
  assert.equal(
    appName([agent({ name: "Friday" }), agent({ name: "Galet", session_id: "other" })]),
    "Friday",
  );
});

test("appName.emptyFirstName", () => {
  assert.equal(appName([agent({ name: "" })]), "Hermes");
});

test("appIcon.manifestName", () => {
  installDocument();
  setAppIcon("nova", undefined, "Friday");
  assert.equal(seen.get("icon"), "/icons/nova-192.png");
  assert.equal(seen.get("apple-touch-icon"), "/icons/nova-192.png");
  assert.equal(seen.get("manifest"), "/manifest-nova.webmanifest?name=Friday");
});

test("appIcon.manifestNameFallback", () => {
  installDocument();
  setAppIcon("nova");
  assert.equal(seen.get("manifest"), "/manifest-nova.webmanifest?name=Hermes");
});

test("appIcon.manifestNameEncoded", () => {
  installDocument();
  setAppIcon("nova", undefined, "Mon Agent");
  assert.equal(seen.get("manifest"), "/manifest-nova.webmanifest?name=Mon%20Agent");
});
