import type { AccessoryId, PaletteId, PairingPayload, SpeciesId, WebAgent } from "../types";

/**
 * Côté navigateur de l'appairage par QR code (docs/appairage-web.md, sections 1 et 3).
 *
 * Le navigateur affiche `id` + sa clé publique ECDH P-256 ; le téléphone chiffre les agents pour
 * cette clé (ECIES : ECDH → HKDF-SHA256 → AES-256-GCM) et les dépose sur le relais. La clé privée
 * est non extractible : elle ne quitte jamais l'onglet, même pas vers le localStorage.
 */

const INFO = new TextEncoder().encode("dots-pair-v1");

// ---------------------------------------------------------------------------------------------
// base64url

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Accepte aussi un éventuel bourrage `=` (Base64.getUrlEncoder() de Java en ajoute par défaut). */
export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new Error("base64url invalide");
  const b64 = s.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Clés et QR

export interface PairingKeys {
  /** 16 octets en base64url sans `=` (22 caractères) : adresse sur le relais et sel HKDF. */
  id: string;
  idBytes: Uint8Array<ArrayBuffer>;
  /** Clé privée ECDH, non extractible. */
  privateKey: CryptoKey;
  /** Clé publique, point non compressé 0x04‖X‖Y (65 octets), base64url sans `=` (87 caractères). */
  pub: string;
}

export async function generatePairingKeys(): Promise<PairingKeys> {
  // `extractable: false` ne vaut que pour la clé privée : la publique reste exportable.
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const idBytes = crypto.getRandomValues(new Uint8Array(16));
  return { id: b64urlEncode(idBytes), idBytes, privateKey: pair.privateKey, pub: b64urlEncode(raw) };
}

/** Contenu du QR code : `https://<origine>/pair#v1.<id>.<pub>`. */
export function pairingUrl(keys: Pick<PairingKeys, "id" | "pub">): string {
  return `${location.origin}/pair#v1.${keys.id}.${keys.pub}`;
}

// ---------------------------------------------------------------------------------------------
// Déchiffrement d'un dépôt

/** Corps déposé sur le relais par le téléphone. */
export interface Deposit {
  v: 1;
  epk: string;
  iv: string;
  ct: string;
}

export async function decryptDeposit(deposit: unknown, privateKey: CryptoKey, idBytes: Uint8Array<ArrayBuffer>): Promise<PairingPayload> {
  const d = deposit as Partial<Deposit> | null;
  if (!d || typeof d !== "object" || d.v !== 1 || typeof d.epk !== "string" || typeof d.iv !== "string" || typeof d.ct !== "string") {
    throw new Error("dépôt mal formé");
  }
  const epk = b64urlDecode(d.epk);
  const iv = b64urlDecode(d.iv);
  const ct = b64urlDecode(d.ct);
  if (epk.length !== 65 || epk[0] !== 0x04) throw new Error("clé éphémère invalide");
  if (iv.length !== 12) throw new Error("iv invalide");
  if (ct.length < 16) throw new Error("chiffré trop court");

  // 1. secret = ECDH(clé privée du navigateur, E) : la coordonnée X, 32 octets.
  const ephemeral = await crypto.subtle.importKey("raw", epk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeral }, privateKey, 256);
  // 2. clé = HKDF-SHA256(secret, sel = id, info = "dots-pair-v1"), 32 octets.
  const ikm = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: idBytes, info: INFO },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  // 3. AES-256-GCM, aad = "dots-pair-v1", tag de 16 octets à la fin du chiffré.
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: INFO, tagLength: 128 }, key, ct);
  return validatePayload(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clear)));
}

// ---------------------------------------------------------------------------------------------
// Validation du message en clair

const SPECIES: SpeciesId[] = ["galet", "nuage", "pave"];
const PALETTES: PaletteId[] = ["tangerine", "bubblegum", "sky", "lime", "sun", "grape"];
const ACCESSORIES: AccessoryId[] = ["winged_cap", "none"];
const MAX_AGENTS = 32;
const MAX_NAME = 24;

const pick = <T extends string>(v: unknown, allowed: T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);

/**
 * `ws://` en clair n'est accepté que si l'app web elle-même tourne en local (développement) :
 * localhost, 127.0.0.1 ou une IP privée. En production, seulement `wss://`.
 */
function isLocalPage(): boolean {
  const h = location.hostname;
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "[::1]" ||
    /^10\.\d+\.\d+\.\d+$/.test(h) ||
    /^192\.168\.\d+\.\d+$/.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h)
  );
}

function validUrl(v: unknown): string {
  if (typeof v !== "string") throw new Error("url manquante");
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error("url invalide");
  }
  if (u.protocol === "wss:" || (u.protocol === "ws:" && isLocalPage())) return v;
  throw new Error("url non sécurisée");
}

function validAgent(a: unknown): WebAgent {
  if (!a || typeof a !== "object") throw new Error("agent invalide");
  const o = a as Record<string, unknown>;
  if (typeof o.token !== "string" || o.token.length === 0) throw new Error("jeton manquant");
  if (typeof o.session_id !== "string") throw new Error("session_id manquant");
  // Nom : rogné, 24 caractères au plus (en points de code, pour ne pas couper un emoji).
  const name = typeof o.name === "string" ? [...o.name.trim()].slice(0, MAX_NAME).join("").trim() : "";
  return {
    url: validUrl(o.url),
    token: o.token,
    session_id: o.session_id,
    agent_id: typeof o.agent_id === "string" && o.agent_id ? o.agent_id : null,
    name: name || "Hermes",
    species: pick(o.species, SPECIES, "galet"),
    palette: pick(o.palette, PALETTES, "tangerine"),
    accessory: pick(o.accessory, ACCESSORIES, "winged_cap"),
  };
}

/** Valide strictement le message déchiffré ; lève une erreur au moindre agent inutilisable. */
export function validatePayload(obj: unknown): PairingPayload {
  if (!obj || typeof obj !== "object") throw new Error("message invalide");
  const o = obj as Record<string, unknown>;
  if (o.v !== 1) throw new Error("version non prise en charge");
  if (!Array.isArray(o.agents) || o.agents.length === 0 || o.agents.length > MAX_AGENTS) throw new Error("liste d'agents invalide");
  return {
    v: 1,
    agents: o.agents.map(validAgent),
    lang: typeof o.lang === "string" ? o.lang : undefined,
    issued_at: typeof o.issued_at === "number" ? o.issued_at : undefined,
  };
}
