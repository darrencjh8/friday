import { useEffect, useState } from "preact/hooks";
import type { WebAgent } from "../types";
import { GatewayClient } from "./GatewayClient";
import type { GatewaySnapshot } from "./model";

/**
 * Une connexion par agent appairé, gardées ouvertes pendant toute la vie de l'onglet (pastilles de
 * non-lus des agents qui ne sont pas à l'écran). La clé est la session web : un réappairage du même
 * agent donne un nouveau jeton, donc une nouvelle connexion.
 */
const clients = new Map<string, GatewayClient>();

/** L'onglet est visible ET a le focus : c'est ce que le gateway appelle « premier plan ». */
function isForeground(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

let foreground = isForeground();

function refreshForeground(): void {
  const next = isForeground();
  if (next === foreground) return;
  foreground = next;
  clients.forEach((c) => c.setForeground(next));
}

/** Réseau revenu ou onglet de retour : chaque socket coupée se reconnecte sans attendre son backoff. */
function wakeAll(): void {
  clients.forEach((c) => c.wake());
}

document.addEventListener("visibilitychange", () => {
  refreshForeground();
  if (document.visibilityState === "visible") wakeAll();
});
window.addEventListener("focus", refreshForeground);
window.addEventListener("blur", refreshForeground);
window.addEventListener("online", wakeAll);

/** Aligne les connexions sur la liste des agents du store : ouvre les nouvelles, ferme les oubliées. */
export function syncClients(agents: WebAgent[]): void {
  const keep = new Set(agents.map((a) => a.session_id));
  for (const [key, client] of clients) {
    if (!keep.has(key)) {
      client.dispose();
      clients.delete(key);
    }
  }
  for (const agent of agents) {
    const existing = clients.get(agent.session_id);
    if (existing) {
      existing.setAgent(agent);
    } else {
      const client = new GatewayClient(agent, foreground);
      clients.set(agent.session_id, client);
      client.start();
    }
  }
}

export function getClient(agent: WebAgent): GatewayClient | undefined {
  return clients.get(agent.session_id);
}

/** État courant d'une connexion, rafraîchi à chaque changement. */
export function useGateway(client: GatewayClient | undefined): GatewaySnapshot | null {
  const [snapshot, setSnapshot] = useState<GatewaySnapshot | null>(() => client?.getSnapshot() ?? null);
  useEffect(() => {
    if (!client) {
      setSnapshot(null);
      return;
    }
    setSnapshot(client.getSnapshot());
    return client.subscribe(() => setSnapshot(client.getSnapshot()));
  }, [client]);
  return snapshot;
}
