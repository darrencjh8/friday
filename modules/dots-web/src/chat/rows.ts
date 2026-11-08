import type { Activity, ChatMessage, ToolCall } from "../gateway/model";
import { dayKey } from "./format";

/**
 * Lignes prêtes à afficher, portage de `buildChatRows` (ChatRows.kt) : séparateurs de jour,
 * bulles groupées, sur-messages d'outils placés avant la réponse de l'agent qu'ils précèdent.
 * Ici dans l'ordre de lecture (du plus ancien au plus récent), la page défile normalement.
 */
export type ChatRow =
  | { type: "day"; key: string; ts: number }
  | {
      type: "bubble";
      key: string;
      message: ChatMessage;
      groupedWithPrev: boolean;
      groupedWithNext: boolean;
      showReceipt: boolean;
      /** Juste sous un sur-message d'outils : la bulle s'y accroche. */
      afterTools: boolean;
    }
  | { type: "tools"; key: string; calls: ToolCall[] }
  | { type: "typing"; key: string };

/** Deux bulles se collent sous 3 minutes d'écart. */
const GROUP_WINDOW_MS = 3 * 60_000;

export function buildChatRows(messages: ChatMessage[], tools: ToolCall[], activity: Activity): ChatRow[] {
  const rows: ChatRow[] = [];
  const lastUserKey = [...messages].reverse().find((m) => m.role === "user")?.key;
  const trail = new ToolTrail(tools);
  let openTurn: string | null = null;

  messages.forEach((message, index) => {
    const previous = messages[index - 1];
    const next = messages[index + 1];
    if (message.role === "user") {
      // Nouveau tour : les outils restants du précédent (utilisés après sa réponse) se referment ici.
      if (openTurn) {
        const rest = trail.rest(openTurn);
        if (rest) rows.push(rest);
      }
      openTurn = message.id ?? message.key;
    }
    if (!previous || dayKey(previous.ts) !== dayKey(message.ts)) {
      rows.push({ type: "day", key: `day-${dayKey(message.ts)}`, ts: message.ts });
    }
    const toolsRow = message.role === "agent" && message.turn ? trail.before(message.turn, message.ts) : null;
    if (toolsRow) rows.push(toolsRow);
    rows.push({
      type: "bubble",
      key: message.key,
      message,
      groupedWithPrev: !toolsRow && !!previous && sameGroup(previous, message),
      groupedWithNext: !!next && sameGroup(message, next) && trail.isEmptyBefore(next.turn, next.ts),
      showReceipt: message.key === lastUserKey,
      afterTools: !!toolsRow,
    });
  });
  rows.push(...trail.remaining());

  // Les trois points : l'agent travaille et rien d'autre ne le montre déjà (réponse en cours
  // d'écriture, outil qui tourne).
  const last = messages[messages.length - 1];
  const streaming = last && last.role === "agent" && !last.final;
  const toolRunning = tools.some((t) => t.state === "running");
  if (activity !== "idle" && !streaming && !toolRunning) rows.push({ type: "typing", key: "typing" });
  return rows;
}

/** Outils regroupés par tour et triés : chaque réponse de l'agent « consomme » ceux lancés avant elle. */
class ToolTrail {
  private readonly pending = new Map<string, ToolCall[]>();

  constructor(tools: ToolCall[]) {
    const sorted = tools.filter((t) => t.turn).sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    for (const tool of sorted) {
      const queue = this.pending.get(tool.turn!) ?? [];
      queue.push(tool);
      this.pending.set(tool.turn!, queue);
    }
  }

  before(turn: string, at: number): ChatRow | null {
    const queue = this.pending.get(turn);
    if (!queue) return null;
    const taken: ToolCall[] = [];
    while (queue.length > 0 && queue[0].ts <= at) taken.push(queue.shift()!);
    return taken.length > 0 ? { type: "tools", key: `tools-${taken[0].id}`, calls: taken } : null;
  }

  isEmptyBefore(turn: string | null, at: number): boolean {
    if (!turn) return true;
    const first = this.pending.get(turn)?.[0];
    return !first || first.ts > at;
  }

  rest(turn: string): ChatRow | null {
    const queue = this.pending.get(turn);
    if (!queue || queue.length === 0) return null;
    const calls = queue.splice(0);
    return { type: "tools", key: `tools-${calls[0].id}`, calls };
  }

  remaining(): ChatRow[] {
    return [...this.pending.keys()].map((turn) => this.rest(turn)).filter((r): r is ChatRow => r != null);
  }
}

/** Même auteur, même jour, moins de 3 min d'écart, et deux bulles de texte. */
function sameGroup(a: ChatMessage, b: ChatMessage): boolean {
  return (
    a.role === b.role &&
    a.type === "message" &&
    b.type === "message" &&
    a.kind === "text" &&
    b.kind === "text" &&
    dayKey(a.ts) === dayKey(b.ts) &&
    b.ts - a.ts < GROUP_WINDOW_MS
  );
}
