import type { WebAgent } from "./types";

/**
 * Agents appairés, gardés dans le localStorage de ce navigateur. Chaque accès est protégé : en
 * navigation privée ou avec le stockage bloqué, l'app marche quand même, le temps de l'onglet.
 */
const KEY = "dots.agents.v1";
let memory: WebAgent[] = [];
const listeners = new Set<(agents: WebAgent[]) => void>();

export function loadAgents(): WebAgent[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) memory = JSON.parse(raw) as WebAgent[];
  } catch {
    /* stockage indisponible : on garde la copie en mémoire */
  }
  return memory;
}

export function saveAgents(agents: WebAgent[]): void {
  memory = agents;
  try {
    localStorage.setItem(KEY, JSON.stringify(agents));
  } catch {
    /* idem */
  }
  listeners.forEach((l) => l(agents));
}

/** Ajoute ou remplace (même gateway) les agents reçus d'un appairage. */
export function mergeAgents(incoming: WebAgent[]): WebAgent[] {
  const key = (a: WebAgent) => a.agent_id ?? a.url;
  const next = [...loadAgents().filter((a) => !incoming.some((b) => key(b) === key(a))), ...incoming];
  saveAgents(next);
  return next;
}

export function removeAgent(agent: WebAgent): void {
  saveAgents(loadAgents().filter((a) => a !== agent && a.session_id !== agent.session_id));
}

export function onAgentsChange(listener: (agents: WebAgent[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
