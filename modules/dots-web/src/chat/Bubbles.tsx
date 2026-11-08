import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatMessage } from "../gateway/model";
import { lang } from "../i18n";
import type { GatewayClient } from "../gateway/GatewayClient";
import { ApprovalCard, ClarifyCard, TakeoverCard } from "./Cards";
import { formatClock, formatFull, formatSize, formatTime } from "./format";
import { Icon } from "./icons";
import { Markdown } from "./Markdown";
import type { ChatRow } from "./rows";
import { t } from "./strings";

/** Une ligne « bulle » du fil (MessageBubbles.kt) : texte, carte, pièce jointe ou vocal. */
export function MessageRow({
  row,
  client,
  online,
}: {
  row: Extract<ChatRow, { type: "bubble" }>;
  client: GatewayClient;
  online: boolean;
}) {
  const message = row.message;
  const fromUser = message.role === "user";
  const tight = row.groupedWithPrev || row.afterTools;
  let body;
  if (message.type === "approval") {
    body = <ApprovalCard message={message} online={online} onAnswer={(ok) => client.answerApproval(message.key, ok)} />;
  } else if (message.type === "clarify") {
    body = <ClarifyCard message={message} online={online} onAnswer={(r) => client.answerClarify(message.key, r)} />;
  } else if (message.kind === "takeover") {
    body = <TakeoverCard message={message} />;
  } else if (message.kind === "file") {
    body = <FileBubble message={message} client={client} />;
  } else if (message.kind === "voice") {
    body = <VoiceBubble message={message} client={client} />;
  } else {
    body = <TextBubble row={row} onReact={() => client.toggleReaction(message.key, "👍")} />;
  }
  return (
    <div class={`row ${fromUser ? "is-user" : "is-agent"}${tight ? " is-tight" : ""}`}>
      {body}
      {row.showReceipt && <div class="receipt">{receiptLabel(message)}</div>}
    </div>
  );
}

function receiptLabel(message: ChatMessage): string {
  if (message.delivery === "sending") return t.sending;
  if (message.delivery === "sent") return t.sent;
  return t.read(formatTime(message.ts));
}

/** Coins resserrés côté auteur quand les bulles se suivent (façon iMessage). */
function bubbleRadius(fromUser: boolean, prev: boolean, next: boolean): string {
  const r = "var(--radius-bubble)";
  const tight = "6px";
  return fromUser
    ? `${r} ${prev ? tight : r} ${next ? tight : r} ${r}`
    : `${prev ? tight : r} ${r} ${r} ${next ? tight : r}`;
}

function Reactions({ message }: { message: ChatMessage }) {
  const emojis = [...new Set([message.reactions.agent, message.reactions.user].filter(Boolean))] as string[];
  if (emojis.length === 0) return null;
  return (
    <span class="reactions" key={emojis.join("")}>
      {emojis.map((e) => (
        <span key={e}>{e}</span>
      ))}
    </span>
  );
}

function TextBubble({ row, onReact }: { row: Extract<ChatRow, { type: "bubble" }>; onReact: () => void }) {
  const { message } = row;
  const fromUser = message.role === "user";
  const hasReactions = !!(message.reactions.agent || message.reactions.user);
  return (
    <div class={`bubble-wrap${hasReactions ? " has-reactions" : ""}`}>
      <div
        class={`bubble ${fromUser ? "bubble-user" : "bubble-agent"}${message.delivery === "sending" ? " is-sending" : ""}`}
        style={{ borderRadius: bubbleRadius(fromUser, row.groupedWithPrev, row.groupedWithNext) }}
        title={`${formatFull(message.ts)}${message.id ? ` — ${t.reactHint}` : ""}`}
        onDblClick={(e) => {
          // Pas de réaction quand on double-clique pour sélectionner un mot dans une bulle.
          window.getSelection()?.removeAllRanges();
          e.preventDefault();
          onReact();
        }}
      >
        {fromUser ? <div class="plain">{message.text}</div> : <Markdown text={message.text} />}
        {!fromUser && !message.final && <span class="stream-caret" />}
      </div>
      <Reactions message={message} />
    </div>
  );
}

/* -- Pièces jointes et vocaux -------------------------------------------------------------------- */

function useAttachment(client: GatewayClient, message: ChatMessage, kind: "file" | "audio") {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const url = useRef<string | null>(null);
  useEffect(() => () => void (url.current && URL.revokeObjectURL(url.current)), []);
  async function load(): Promise<string | null> {
    if (url.current) return url.current;
    if (!message.id) return null;
    setState("loading");
    try {
      const blob = await client.fetchAttachment(message.id, kind);
      url.current = URL.createObjectURL(blob);
      setState("idle");
      return url.current;
    } catch {
      setState("error");
      return null;
    }
  }
  return { state, load };
}

function FileBubble({ message, client }: { message: ChatMessage; client: GatewayClient }) {
  const fromUser = message.role === "user";
  const { state, load } = useAttachment(client, message, "file");
  const name = message.name || t.file;
  const ext = (name.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? "").toUpperCase();
  const isImage = (message.mime || "").startsWith("image/");

  async function download() {
    const href = await load();
    if (!href) return;
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <div class={`attachment ${fromUser ? "is-user" : "is-agent"}`}>
      <button type="button" class="file-card" onClick={download} disabled={state === "loading"} title={t.download}>
        <span class="file-icon">{isImage ? <Icon name="image" size={18} /> : ext ? <b>{ext}</b> : <Icon name="read" size={18} />}</span>
        <span class="file-meta">
          <span class="file-name">{name}</span>
          <span class="file-sub">
            {state === "error" ? t.unavailable : [formatSize(message.size), formatTime(message.ts)].filter(Boolean).join(" · ")}
          </span>
        </span>
        <span class="file-action">{state === "loading" ? <span class="spinner" /> : <Icon name="download" size={16} />}</span>
      </button>
      {message.text && (
        <div class={`bubble ${fromUser ? "bubble-user" : "bubble-agent"} attachment-caption`}>
          {fromUser ? <div class="plain">{message.text}</div> : <Markdown text={message.text} />}
        </div>
      )}
    </div>
  );
}

const BARS = 40;

/** Onde réduite à 40 barres (l'app en envoie 40 ; 64 au plus côté plugin). */
function bars(waveform: number[] | undefined): number[] {
  if (!waveform || waveform.length === 0) return Array.from({ length: BARS }, (_, i) => 0.25 + 0.2 * Math.abs(Math.sin(i * 1.7)));
  return Array.from({ length: BARS }, (_, i) => waveform[Math.floor((i * waveform.length) / BARS)] ?? 0);
}

function VoiceBubble({ message, client }: { message: ChatMessage; client: GatewayClient }) {
  const fromUser = message.role === "user";
  const { state, load } = useAttachment(client, message, "audio");
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const duration = message.durationMs ?? 0;

  useEffect(() => () => audio.current?.pause(), []);

  async function toggle() {
    if (audio.current && !audio.current.paused) {
      audio.current.pause();
      return;
    }
    if (!audio.current) {
      const src = await load();
      if (!src) return;
      const el = new Audio(src);
      el.ontimeupdate = () => setProgress(el.duration ? el.currentTime / el.duration : 0);
      el.onplay = () => setPlaying(true);
      el.onpause = () => setPlaying(false);
      el.onended = () => {
        setPlaying(false);
        setProgress(0);
      };
      audio.current = el;
    }
    audio.current.play().catch(() => setPlaying(false));
  }

  const levels = bars(message.waveform);
  return (
    <div class={`attachment ${fromUser ? "is-user" : "is-agent"}`}>
      <div class={`voice ${fromUser ? "bubble-user" : "bubble-agent"}`}>
        <button type="button" class="voice-play" onClick={toggle} aria-label={playing ? t.pause : t.play} disabled={state === "loading"}>
          {state === "loading" ? <span class="spinner" /> : <Icon name={playing ? "pause" : "play"} size={16} />}
        </button>
        <span class="voice-wave" aria-hidden="true">
          {levels.map((v, i) => (
            <span
              key={i}
              class={i / BARS < progress ? "is-played" : ""}
              style={{ height: `${Math.max(12, Math.min(1, v) * 100)}%` }}
            />
          ))}
        </span>
        <span class="voice-time">{state === "error" ? t.unavailable : formatClock(duration)}</span>
      </div>
      {message.transcript && <div class="voice-transcript">{lang === "fr" ? `« ${message.transcript} »` : `“${message.transcript}”`}</div>}
    </div>
  );
}

/** Les trois points qui rebondissent pendant que l'agent travaille. */
export function TypingBubble() {
  return (
    <div class="row is-agent">
      <div class="bubble bubble-agent typing" aria-label={t.typing}>
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}
