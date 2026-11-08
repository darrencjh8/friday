import type { Plugin } from "vite";
import { handlePair, MAX_BODY_BYTES, type PairStore } from "../api/_lib/pairing.js";

/**
 * Relais d'appairage en mémoire pour `npm run dev` : même API que la fonction Vercel (api/pair.ts),
 * même code de validation (api/_lib/pairing.ts), sans Upstash. Les dépôts expirent après 120 s.
 */
/** Ce qu'on utilise de la requête Node (le projet n'embarque pas @types/node). */
interface NodeRequest {
  method?: string;
  url?: string;
  originalUrl?: string;
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  on(event: "end", listener: () => void): void;
}

export function devRelay(): Plugin {
  const entries = new Map<string, { value: string; expires: number }>();
  const live = (key: string) => {
    const e = entries.get(key);
    if (e && e.expires <= Date.now()) entries.delete(key);
    return entries.get(key);
  };
  const store: PairStore = {
    setNx: async (key, value, ttl) => {
      if (live(key)) return false;
      entries.set(key, { value, expires: Date.now() + ttl * 1000 });
      return true;
    },
    getDel: async (key) => {
      const e = live(key);
      entries.delete(key);
      return e?.value ?? null;
    },
  };

  return {
    name: "dots-dev-relay",
    configureServer(server) {
      server.middlewares.use("/api/pair", (incoming, res) => {
        const req = incoming as unknown as NodeRequest;
        // Le montage sur /api/pair retire ce préfixe de req.url : on repart de l'URL d'origine.
        const url = new URL(req.originalUrl ?? req.url ?? "/", "http://localhost");
        const chunks: Uint8Array[] = [];
        let size = 0;
        req.on("data", (c: Uint8Array) => {
          // Au-delà de la limite, on cesse d'accumuler (le corps gardé la dépasse : handlePair répondra 413).
          if (size <= MAX_BODY_BYTES) chunks.push(c);
          size += c.byteLength;
        });
        req.on("end", async () => {
          const hasBody = req.method !== "GET" && req.method !== "HEAD";
          const body = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
          let off = 0;
          for (const c of chunks) {
            body.set(c, off);
            off += c.byteLength;
          }
          try {
            const request = new Request(url, { method: req.method, body: hasBody ? body : undefined });
            const response = await handlePair(request, store);
            res.statusCode = response.status;
            response.headers.forEach((v, k) => res.setHeader(k, v));
            res.end(await response.text());
          } catch {
            // Une promesse rejetée non rattrapée arrêterait le serveur de dev.
            res.statusCode = 500;
            res.end();
          }
        });
      });
    },
  };
}
