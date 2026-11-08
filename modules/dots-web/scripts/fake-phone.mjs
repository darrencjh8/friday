// Simule le téléphone pour tester l'appairage sans l'app Android (docs/appairage-web.md, section 3) :
//   node scripts/fake-phone.mjs "<url du QR>" <wsUrl> <jeton> [nom espèce palette]
// Analyse l'URL du QR, chiffre un message pour la clé du navigateur, le dépose sur <origine>/api/pair?id=.
const [qr, wsUrl, token, name = "Norti", species = "galet", palette = "tangerine"] = process.argv.slice(2);
if (!qr || !wsUrl || !token) {
  console.error('usage : node scripts/fake-phone.mjs "<url du QR>" <wsUrl> <jeton> [nom espèce palette]');
  process.exit(2);
}

const { subtle } = globalThis.crypto;
const enc = new TextEncoder();
const INFO = enc.encode("dots-pair-v1");
const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
const unb64u = (s) => new Uint8Array(Buffer.from(s, "base64url"));

// 1. URL du QR : https://<origine>/pair#v1.<id>.<pub>
const url = new URL(qr);
const m = /^#v1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{87})$/.exec(url.hash);
if (url.pathname !== "/pair" || !m) {
  console.error("URL de QR invalide");
  process.exit(2);
}
const [, id, pub] = m;

// 2. Message en clair.
const payload = {
  v: 1,
  agents: [
    {
      url: wsUrl,
      token,
      session_id: `fake-${crypto.randomUUID()}`,
      agent_id: null,
      name,
      species,
      palette,
      accessory: "winged_cap",
    },
  ],
  lang: "fr",
  issued_at: Date.now(),
};

// 3. ECIES : ECDH(e, pub) → HKDF-SHA256(sel = id, info) → AES-256-GCM(aad = info).
const browserKey = await subtle.importKey("raw", unb64u(pub), { name: "ECDH", namedCurve: "P-256" }, false, []);
const eph = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const secret = await subtle.deriveBits({ name: "ECDH", public: browserKey }, eph.privateKey, 256);
const ikm = await subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
const key = await subtle.deriveKey(
  { name: "HKDF", hash: "SHA-256", salt: unb64u(id), info: INFO },
  ikm,
  { name: "AES-GCM", length: 256 },
  false,
  ["encrypt"],
);
const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: INFO }, key, enc.encode(JSON.stringify(payload)));
const epk = new Uint8Array(await subtle.exportKey("raw", eph.publicKey));

// 4. Dépôt sur le relais.
const res = await fetch(`${url.origin}/api/pair?id=${id}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ v: 1, epk: b64u(epk), iv: b64u(iv), ct: b64u(new Uint8Array(ct)) }),
});
console.log(`POST ${url.origin}/api/pair?id=${id} → ${res.status}`);
process.exit(res.status === 201 ? 0 : 1);
