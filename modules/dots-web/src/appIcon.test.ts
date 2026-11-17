import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { appName, setAppIcon } from "./appIcon.ts";
import type { WebAgent } from "./types.ts";

/**
 * L'icône de l'onglet et de la PWA suit le choix du logo du téléphone
 * (friday #211, #231) : Night / Day pointent vers leurs portraits
 * (Night = portrait nuit sans cardigan, Day = portrait jour cardigan
 * entièrement porté), et Default est le portrait jour — la silhouette
 * noire ne sert plus. Tout le reste (inconnu, absent, ancienne couleur)
 * retombe sur Default.
 * Le nom de l'app suit le premier agent appairé (friday #212) : "Hermes" avant tout
 * appairage, le nom du premier agent ensuite, via ?name= sur le manifeste.
 * `document` est un faux minimal : seuls les `link[rel]` lus par setAppIcon
 * existent, avec leur href enregistré.
 * Les fichiers d'icônes eux-mêmes sont vérifiés plus bas : Default et Day
 * sont le même portrait (donc les mêmes octets), Night en est un autre,
 * et les six PNG ont la bonne taille.
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

test("appIcon.launcherIcon.night", () => {
  installDocument();
  setAppIcon("nova", "night");
  assert.equal(
    seen.get("icon"),
    "/icons/nova-night-192.png",
    "appIcon.launcherIcon.night failed: icon href stayed on the Default icon",
  );
  assert.equal(seen.get("apple-touch-icon"), "/icons/nova-night-192.png");
  assert.equal(seen.get("manifest"), "/manifest-nova-night.webmanifest?name=Hermes");
});

test("appIcon.launcherIcon.day", () => {
  installDocument();
  setAppIcon("nova", "day");
  assert.equal(
    seen.get("icon"),
    "/icons/nova-day-192.png",
    "appIcon.launcherIcon.day failed: icon href stayed on the Default icon",
  );
  assert.equal(seen.get("apple-touch-icon"), "/icons/nova-day-192.png");
  assert.equal(seen.get("manifest"), "/manifest-nova-day.webmanifest?name=Hermes");
});

test("appIcon.launcherIcon.oldColour", () => {
  installDocument();
  setAppIcon("nova", "blue");
  assert.equal(
    seen.get("icon"),
    "/icons/nova-default-192.png",
    "appIcon.launcherIcon.oldColour failed: a stored pre-#136 colour still maps to its old icon",
  );
  assert.equal(seen.get("manifest"), "/manifest-nova-default.webmanifest?name=Hermes");
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
  assert.equal(seen.get("icon"), "/icons/nova-default-192.png");
  assert.equal(seen.get("manifest"), "/manifest-nova-default.webmanifest?name=Hermes");
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
  assert.equal(seen.get("icon"), "/icons/nova-default-192.png");
  assert.equal(seen.get("manifest"), "/manifest-nova-default.webmanifest?name=Hermes");
});

test("appIcon.launcherIcon.named", () => {
  installDocument();
  setAppIcon("nova", "night", "Friday");
  assert.equal(seen.get("icon"), "/icons/nova-night-192.png");
  assert.equal(seen.get("manifest"), "/manifest-nova-night.webmanifest?name=Friday");
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
  assert.equal(seen.get("icon"), "/icons/nova-default-192.png");
  assert.equal(seen.get("apple-touch-icon"), "/icons/nova-default-192.png");
  assert.equal(seen.get("manifest"), "/manifest-nova-default.webmanifest?name=Friday");
});

test("appIcon.manifestNameFallback", () => {
  installDocument();
  setAppIcon("nova");
  assert.equal(seen.get("manifest"), "/manifest-nova-default.webmanifest?name=Hermes");
});

test("appIcon.manifestNameEncoded", () => {
  installDocument();
  setAppIcon("nova", undefined, "Mon Agent");
  assert.equal(seen.get("manifest"), "/manifest-nova-default.webmanifest?name=Mon%20Agent");
});

// Contenu des fichiers d'icônes (friday #231, portraits cardigan) :
// Default et Day sont le même portrait jour (cardigan entièrement porté),
// Night est le portrait nuit sans cardigan. Ces tests lisent les PNG
// servis par la PWA ; ils échouent tant que Default est la silhouette.
const iconsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

function iconBytes(name: string): Buffer {
  return readFileSync(join(iconsDir, name));
}

function pngSize(name: string): { width: number; height: number } {
  const bytes = iconBytes(name);
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG", `${name} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("iconFiles.defaultEqualsDay", () => {
  // Buffer.equals, not assert.deepEqual: deepEqual on Buffers hangs in
  // this Node version (verified: 20s+ on two 18/44 KB buffers).
  assert.ok(
    iconBytes("nova-default-192.png").equals(iconBytes("nova-day-192.png")),
    "iconFiles.defaultEqualsDay failed: Default is not the Day portrait (still the silhouette?)",
  );
  assert.ok(iconBytes("nova-default-512.png").equals(iconBytes("nova-day-512.png")));
});

test("iconFiles.nightDiffersFromDay", () => {
  assert.ok(
    !iconBytes("nova-night-192.png").equals(iconBytes("nova-day-192.png")),
    "iconFiles.nightDiffersFromDay failed: Night uses the Day portrait",
  );
  assert.ok(!iconBytes("nova-night-512.png").equals(iconBytes("nova-day-512.png")));
});

test("iconFiles.dimensions", () => {
  for (const key of ["nova-default", "nova-night", "nova-day"]) {
    assert.deepEqual(pngSize(`${key}-192.png`), { width: 192, height: 192 });
    assert.deepEqual(pngSize(`${key}-512.png`), { width: 512, height: 512 });
  }
});
