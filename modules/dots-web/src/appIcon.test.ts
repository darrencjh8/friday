import assert from "node:assert/strict";
import { test } from "node:test";
import { setAppIcon } from "./appIcon.ts";

/**
 * L'icône de l'onglet et de la PWA suit le choix du logo du téléphone
 * (friday #211) : un logo explicite remplace la photo demi-buste de Nova.
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
  assert.equal(seen.get("manifest"), "/manifest-nova-blue.webmanifest");
});

test("appIcon.launcherIcon.default", () => {
  installDocument();
  setAppIcon("nova", "default");
  assert.equal(seen.get("icon"), "/icons/nova-192.png");
  assert.equal(seen.get("manifest"), "/manifest-nova.webmanifest");
});

test("appIcon.launcherIcon.unknown", () => {
  installDocument();
  setAppIcon("nova", "nope");
  assert.equal(seen.get("icon"), "/icons/nova-192.png");
  assert.equal(seen.get("manifest"), "/manifest-nova.webmanifest");
});

test("appIcon.launcherIcon.nonNova", () => {
  installDocument();
  setAppIcon("galet", "blue");
  assert.equal(seen.get("icon"), "/icons/galet-192.png");
  assert.equal(seen.get("manifest"), "/manifest-galet.webmanifest");
});

test("appIcon.launcherIcon.missing", () => {
  installDocument();
  setAppIcon("nova");
  assert.equal(seen.get("icon"), "/icons/nova-192.png");
  assert.equal(seen.get("manifest"), "/manifest-nova.webmanifest");
});
