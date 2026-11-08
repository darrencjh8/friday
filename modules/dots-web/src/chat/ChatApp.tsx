import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ClayDot } from "../dot/ClayDot";
import { paletteStyle } from "../dot/palettes";
import type { GatewayClient } from "../gateway/GatewayClient";
import { getClient, syncClients, useGateway } from "../gateway/registry";
import { PairingScreen } from "../pairing/PairingScreen";
import type { WebAgent } from "../types";
import { ChatView } from "./ChatView";
import { Icon } from "./icons";
import { t } from "./strings";
import "./chat.css";

/**
 * Le chat web : la liste des agents appairés (barre latérale sur ordinateur, sélecteur en haut sur
 * téléphone) et la conversation de l'agent choisi. Une connexion reste ouverte par agent.
 */

const ACTIVE_KEY = "dots.active.v1";

function readActive(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

function writeActive(sessionId: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, sessionId);
  } catch {
    /* stockage indisponible */
  }
}

/** Largeur de téléphone : même seuil que la feuille de style. */
function usePhone(): boolean {
  const query = "(max-width: 720px)";
  const [phone, setPhone] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setPhone(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return phone;
}

export function ChatApp({ agents }: { agents: WebAgent[] }) {
  // Les connexions suivent la liste du store ; avant le rendu, pour que chaque agent ait la sienne.
  useMemo(() => syncClients(agents), [agents]);

  const [activeId, setActiveId] = useState<string | null>(readActive);
  const [pairing, setPairing] = useState(false);
  const phone = usePhone();
  const known = useRef(new Set(agents.map((a) => a.session_id)));

  const active = agents.find((a) => a.session_id === activeId) ?? agents[0];
  const activeClient = active ? getClient(active) : undefined;

  // Nouvel agent appairé depuis l'écran du QR code : on referme l'écran et on ouvre sa conversation.
  useEffect(() => {
    const added = agents.filter((a) => !known.current.has(a.session_id));
    known.current = new Set(agents.map((a) => a.session_id));
    if (added.length > 0) {
      setActiveId(added[added.length - 1].session_id);
      setPairing(false);
    }
  }, [agents]);

  useEffect(() => {
    if (active) writeActive(active.session_id);
    for (const agent of agents) getClient(agent)?.setActive(agent.session_id === active?.session_id);
  }, [active, agents]);

  useUnreadTitle(agents);

  // Échap referme l'écran du QR code.
  useEffect(() => {
    if (!pairing) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPairing(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pairing]);

  return (
    <div class="chat-app">
      <AgentList
        agents={agents}
        active={active}
        phone={phone}
        onSelect={(a) => setActiveId(a.session_id)}
        onAdd={() => setPairing(true)}
      />
      <main class="chat-main">
        {active && activeClient && <ChatView key={active.session_id} agent={active} client={activeClient} />}
      </main>
      {pairing && (
        <div class="pairing-overlay" role="dialog" aria-modal="true">
          <PairingScreen onCancel={() => setPairing(false)} />
        </div>
      )}
    </div>
  );
}

function AgentList({
  agents,
  active,
  phone,
  onSelect,
  onAdd,
}: {
  agents: WebAgent[];
  active: WebAgent | undefined;
  phone: boolean;
  onSelect: (agent: WebAgent) => void;
  onAdd: () => void;
}) {
  return (
    <nav class="agents" aria-label={t.agents}>
      {!phone && <div class="agents-title t-label-sm">{t.agents}</div>}
      <div class="agents-list">
        {agents.map((agent) => (
          <AgentItem
            key={agent.session_id}
            agent={agent}
            client={getClient(agent)}
            selected={agent.session_id === active?.session_id}
            size={phone ? 28 : 38}
            onSelect={() => onSelect(agent)}
          />
        ))}
        <button type="button" class="agent-item agent-add" onClick={onAdd}>
          <span class="agent-add-icon">
            <Icon name="plus" size={phone ? 16 : 18} />
          </span>
          <span class="agent-name">{t.addAgent}</span>
        </button>
      </div>
    </nav>
  );
}

function AgentItem({
  agent,
  client,
  selected,
  size,
  onSelect,
}: {
  agent: WebAgent;
  client: GatewayClient | undefined;
  selected: boolean;
  size: number;
  onSelect: () => void;
}) {
  const snapshot = useGateway(client);
  const status = snapshot?.status ?? "connecting";
  const busy = status === "online" && snapshot?.activity !== "idle";
  const unread = selected ? 0 : snapshot?.unread ?? 0;
  const label =
    status === "online" ? (busy ? (snapshot!.activity === "typing" ? t.typing : t.thinking) : t.online) : status === "offline" ? t.offline : t.connecting;
  return (
    <button
      type="button"
      class={`agent-item${selected ? " is-selected" : ""}`}
      style={paletteStyle(agent.palette)}
      aria-current={selected ? "page" : undefined}
      onClick={onSelect}
    >
      <span class="agent-avatar">
        <ClayDot
          species={agent.species}
          palette={agent.palette}
          accessory={agent.accessory}
          mood={status === "online" ? "idle" : "sleeping"}
          size={size}
        />
        <span class={`agent-presence is-${status}`} />
      </span>
      <span class="agent-text dot-scope">
        <span class="agent-name">{agent.name || snapshot?.serverName || "Hermes"}</span>
        <span class={`agent-sub${busy ? " is-busy" : ""}`}>{label}</span>
      </span>
      {unread > 0 && <span class="agent-unread">{unread > 99 ? "99+" : unread}</span>}
    </button>
  );
}

/** « (3) Hermes » dans l'onglet quand des messages attendent. */
function useUnreadTitle(agents: WebAgent[]) {
  useEffect(() => {
    const clients = agents.map(getClient).filter((c): c is GatewayClient => !!c);
    const base = "Hermes";
    const update = () => {
      const total = clients.reduce((sum, c) => sum + c.getSnapshot().unread, 0);
      document.title = total > 0 ? `(${total}) ${base}` : base;
    };
    update();
    const unsubscribe = clients.map((c) => c.subscribe(update));
    return () => unsubscribe.forEach((u) => u());
  }, [agents]);
}
