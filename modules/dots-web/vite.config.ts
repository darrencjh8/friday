import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { devRelay } from "./dev/relay";

// En local, `vite` sert aussi le relais d'appairage (en mémoire) : la même API que la fonction
// Vercel de `api/pair.ts`, sans Upstash.
export default defineConfig({
  plugins: [preact(), devRelay()],
  server: { host: true, port: 5173 },
});
