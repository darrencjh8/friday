import type { AccessoryId, PaletteId, SpeciesId } from "../types";

/**
 * Modèle du fil tel que le chat l'affiche, construit à partir des trames du gateway
 * (docs/protocole-gateway.md). Tout est immuable : chaque changement produit un nouvel objet, ce
 * qui permet à Preact de comparer par référence.
 */

export type Activity = "idle" | "thinking" | "typing";
export type ConnectionStatus = "connecting" | "online" | "offline";
export type Delivery = "sending" | "sent" | "read";

/** Le dot principal ; chaque sous-dot a sa propre conversation, `dot-<id>`. */
export const MAIN_CHAT = "owner";

/**
 * Un sous-dot, tel que le gateway le garde dans `dots.json` (trames `welcome.dots` et `dots`).
 * L'apparence est déjà traduite vers les ids du web : le gateway écrit `Galet`, `WingedCap`…
 */
export interface SubDot {
  id: string;
  name: string;
  kind: "temporary" | "permanent";
  mission: string;
  species: SpeciesId;
  palette: PaletteId;
  accessory: AccessoryId;
  lastTs: number;
}

export interface Approval {
  title: string;
  command: string;
  description: string;
  /** Choix retenu (`once`, `session`, `always`, `deny`), null tant que la demande est ouverte. */
  resolved: string | null;
}

export interface Clarify {
  question: string;
  choices: string[];
  /** Réponse donnée depuis ce navigateur ; le gateway ne la renvoie pas dans l'historique. */
  answer: string | null;
}

export interface ChatMessage {
  /** Clé locale stable : `client_id` pour un message tapé ici, sinon l'id du serveur. */
  key: string;
  /** Id attribué par le gateway, null tant que l'`ack` n'est pas arrivé. */
  id: string | null;
  type: "message" | "approval" | "clarify";
  role: "user" | "agent";
  kind: "text" | "voice" | "file" | "takeover";
  text: string;
  ts: number;
  /** 0 pour un message local pas encore enregistré. */
  seq: number;
  /** Id du message de l'utilisateur dont ce tour est la réponse. */
  turn: string | null;
  final: boolean;
  delivery: Delivery;
  /** Réaction de l'utilisateur (posée ici) et de l'agent (trame `reaction`). */
  reactions: { user?: string; agent?: string };
  // Pièce jointe et vocal
  name?: string;
  mime?: string;
  size?: number;
  durationMs?: number;
  waveform?: number[];
  transcript?: string;
  // Prise en main : `pending`, `done` ou `expired`
  status?: string;
  approval?: Approval;
  clarify?: Clarify;
}

export type ToolState = "running" | "done" | "error";

export interface ToolCall {
  id: string;
  turn: string | null;
  name: string;
  kind: string;
  label: string;
  detail: string;
  state: ToolState;
  ts: number;
  seq: number;
  durationMs: number | null;
}

/** État d'une conversation (le dot principal ou un sous-dot). */
export interface ChatState {
  messages: ChatMessage[];
  tools: ToolCall[];
  activity: Activity;
  /** Première page reçue (le fil peut s'afficher). */
  loaded: boolean;
  hasMore: boolean;
  loadingOlder: boolean;
  /** Messages des dots arrivés pendant que cette conversation n'était pas à l'écran. */
  unread: number;
}

export const EMPTY_CHAT: ChatState = {
  messages: [],
  tools: [],
  activity: "idle",
  loaded: false,
  hasMore: false,
  loadingOlder: false,
  unread: 0,
};

/**
 * Ce que le chat affiche d'un agent : la conversation ouverte ([activeChat]) à plat, comme avant
 * les sous-dots, plus de quoi dessiner le sélecteur de dots.
 */
export interface GatewaySnapshot extends Omit<ChatState, "unread"> {
  status: ConnectionStatus;
  /** Nom du profil annoncé par `welcome` (le nom choisi dans l'app reste prioritaire à l'affichage). */
  serverName: string | null;
  /** Conversation ouverte : MAIN_CHAT ou l'id d'un sous-dot. */
  activeChat: string;
  dots: SubDot[];
  /** Par conversation : non lus et activité, pour les pastilles du sélecteur. */
  chats: Record<string, { unread: number; activity: Activity }>;
  /** Total des non lus de l'agent, toutes conversations confondues (liste des agents, titre). */
  unread: number;
}

export const EMPTY_SNAPSHOT: GatewaySnapshot = {
  ...EMPTY_CHAT,
  status: "connecting",
  serverName: null,
  activeChat: MAIN_CHAT,
  dots: [],
  chats: {},
  unread: 0,
};

const SPECIES: Record<string, SpeciesId> = { galet: "galet", nuage: "nuage", pave: "pave" };
const PALETTES: PaletteId[] = ["tangerine", "bubblegum", "sky", "lime", "sun", "grape"];

/** `dots` du gateway → sous-dots ; défauts de l'app (SubDots.kt) : Nuage, Sky, pétase. */
export function toDots(value: unknown): SubDot[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((d): d is Json => !!d && typeof d === "object" && typeof d.id === "string" && d.id !== "")
    .map((d) => ({
      id: d.id,
      name: str(d.name).trim() || "Dot",
      kind: d.kind === "permanent" ? "permanent" : "temporary",
      mission: str(d.mission),
      species: SPECIES[str(d.species).toLowerCase()] ?? "nuage",
      palette: (PALETTES as string[]).includes(str(d.palette)) ? (d.palette as PaletteId) : "sky",
      accessory: str(d.accessory) === "None" ? "none" : "winged_cap",
      lastTs: num(d.last_ts),
    }));
}

/* -- Conversion des événements du gateway ------------------------------------------------------- */

type Json = Record<string, any>;

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && isFinite(v) ? v : fallback);

/** Conversation d'un événement : absente = dot principal (plugin d'avant les sous-dots). */
export function chatOf(event: Json): string {
  return str(event.chat) || MAIN_CHAT;
}

/** Événement d'historique ou trame live (`message`, `approval`, `clarify`) → message ; null sinon. */
export function toMessage(event: Json): ChatMessage | null {
  const id = str(event.id);
  if (!id) return null;
  const base = {
    key: id,
    id,
    ts: num(event.ts, Date.now()),
    seq: num(event.seq),
    turn: str(event.turn) || null,
    final: event.final !== false,
    delivery: "read" as Delivery,
    reactions: {},
    text: str(event.text),
  };
  switch (event.type) {
    case "message": {
      const kind = (["voice", "file", "takeover"].includes(event.kind) ? event.kind : "text") as ChatMessage["kind"];
      return {
        ...base,
        type: "message",
        role: event.role === "user" ? "user" : "agent",
        kind,
        name: event.name != null ? str(event.name) : undefined,
        mime: event.mime != null ? str(event.mime) : undefined,
        size: event.size != null ? num(event.size) : undefined,
        durationMs: event.duration_ms != null ? num(event.duration_ms) : undefined,
        waveform: Array.isArray(event.waveform) ? event.waveform.map((v: unknown) => num(v)) : undefined,
        transcript: str(event.transcript) || undefined,
        status: kind === "takeover" ? str(event.status) || "pending" : undefined,
      };
    }
    case "approval":
      return {
        ...base,
        type: "approval",
        role: "agent",
        kind: "text",
        approval: {
          title: str(event.title),
          command: str(event.command),
          description: str(event.description),
          resolved: str(event.resolved) || null,
        },
      };
    case "clarify":
      return {
        ...base,
        type: "clarify",
        role: "agent",
        kind: "text",
        clarify: {
          question: str(event.question),
          choices: Array.isArray(event.choices) ? event.choices.map(str) : [],
          answer: null,
        },
      };
    default:
      return null;
  }
}

/** Événement `tool` (live ou rejoué : l'historique garde l'état final). */
export function toTool(event: Json, labelFor: (name: string) => string | null): ToolCall | null {
  const id = str(event.id);
  if (!id) return null;
  const name = str(event.name);
  const state = event.state === "done" || event.state === "error" ? event.state : "running";
  return {
    id,
    turn: str(event.turn) || null,
    name,
    kind: str(event.kind) || "tool",
    // Le gateway rédige déjà le libellé dans la langue annoncée par `hello` : il passe en premier.
    label: str(event.label) || labelFor(name) || name || "Tool",
    detail: str(event.detail),
    state,
    ts: num(event.ts, Date.now()),
    seq: num(event.seq),
    durationMs: event.duration_ms != null ? num(event.duration_ms) : null,
  };
}
