import { handlePair, type PairStore } from "./_lib/pairing.js";

/**
 * Fonction Vercel du relais d'appairage : `POST /api/pair?id=` dépose, `GET` relève (et efface).
 * Stockage : Upstash Redis via son API REST, en `fetch` simple (aucune dépendance). Variables posées
 * par l'intégration Vercel KV/Upstash : KV_REST_API_URL / KV_REST_API_TOKEN, ou
 * UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.
 */

declare const process: { env: Record<string, string | undefined> };

/** Exécute une commande Redis : `POST <url>` avec le tableau de la commande en JSON. */
async function redis(command: string[]): Promise<unknown> {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash non configuré (KV_REST_API_URL / KV_REST_API_TOKEN)");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const json = (await res.json()) as { result?: unknown; error?: string };
  if (!res.ok || json.error) throw new Error(`Upstash ${res.status}: ${json.error ?? "erreur"}`);
  return json.result;
}

const store: PairStore = {
  // SET … EX 120 NX répond "OK" si stocké, null si la clé existait déjà.
  setNx: async (key, value, ttl) => (await redis(["SET", key, value, "EX", String(ttl), "NX"])) === "OK",
  getDel: async (key) => {
    const r = await redis(["GETDEL", key]);
    return typeof r === "string" ? r : null;
  },
};

export async function GET(request: Request): Promise<Response> {
  return handlePair(request, store);
}

export async function POST(request: Request): Promise<Response> {
  return handlePair(request, store);
}
