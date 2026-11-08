/**
 * Relais d'appairage (docs/appairage-web.md, section 4), indépendant du stockage : la fonction Vercel
 * (api/pair.ts, Upstash Redis) et le serveur de dev (dev/relay.ts, en mémoire) partagent ce code.
 * Vercel ne sert pas les fichiers dont le nom commence par `_` comme des routes.
 *
 * Le relais ne voit que du chiffré : il vérifie la forme, garde 120 s au plus, efface à la lecture.
 */

export const TTL_SECONDS = 120;
export const MAX_BODY_BYTES = 16 * 1024;

/** Stockage minimal : écrire si absent avec expiration, lire et effacer d'un coup. */
export interface PairStore {
  /** true si stocké, false si la clé existait déjà. */
  setNx(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  getDel(key: string): Promise<string | null>;
}

const ID_RE = /^[A-Za-z0-9_-]{22}$/;
// base64url ; un éventuel bourrage `=` est toléré (Java en ajoute par défaut).
const B64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function reply(status: number, body?: string): Response {
  return new Response(body ?? null, {
    status,
    headers: body ? { ...HEADERS, "Content-Type": "application/json" } : HEADERS,
  });
}

/** Valide le corps déposé et le réécrit avec ses seuls champs connus ; null si invalide. */
export function normalizeDeposit(text: string): string | null {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const { v, epk, iv, ct } = o as Record<string, unknown>;
  for (const f of [epk, iv, ct]) if (typeof f !== "string" || !B64URL_RE.test(f)) return null;
  return JSON.stringify({ v, epk, iv, ct });
}

/** Traite `GET` et `POST /api/pair?id=` ; les autres méthodes reçoivent 405. */
export async function handlePair(request: Request, store: PairStore): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!ID_RE.test(id)) return reply(400);
  const key = `pair:${id}`;

  try {
    if (request.method === "GET") {
      const body = await store.getDel(key);
      return body === null ? reply(204) : reply(200, body);
    }

    if (request.method === "POST") {
      // Rejet précoce sur l'en-tête, puis vérification réelle de la taille lue.
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (declared > MAX_BODY_BYTES) return reply(413);
      const raw = new Uint8Array(await request.arrayBuffer());
      if (raw.byteLength > MAX_BODY_BYTES) return reply(413);
      const body = normalizeDeposit(new TextDecoder().decode(raw));
      if (body === null) return reply(400);
      return reply((await store.setNx(key, body, TTL_SECONDS)) ? 201 : 409);
    }
  } catch (e) {
    console.error("pair relay:", e);
    return reply(500);
  }

  return new Response(null, { status: 405, headers: { ...HEADERS, Allow: "GET, POST" } });
}
