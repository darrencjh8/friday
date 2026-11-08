import { useState } from "preact/hooks";
import type { ToolCall } from "../gateway/model";
import { formatDuration } from "./format";
import { Icon, KindIcon } from "./icons";
import { t } from "./strings";

/**
 * Sur-message d'outils (ToolTrail.kt) : une capsule discrète au-dessus de la réponse de l'agent,
 * jamais une bulle. En direct, elle montre l'outil en cours ; une fois le tour fini, elle se résume
 * (« 3 actions · 2,6 s ») et se déplie d'un clic en frise chronologique.
 */
export function ToolTrail({ calls }: { calls: ToolCall[] }) {
  const [expanded, setExpanded] = useState(false);
  const current = [...calls].reverse().find((c) => c.state === "running");
  const single = calls.length === 1 ? calls[0] : null;
  const headline = current ?? single;

  return (
    <div class="trail">
      <button
        type="button"
        class={`trail-pill${current ? " is-live" : ""}`}
        aria-expanded={expanded}
        title={expanded ? t.collapse : t.expand}
        onClick={() => setExpanded(!expanded)}
      >
        <KindStack calls={calls} running={!!current} />
        <span class="trail-headline" key={current?.id ?? "summary"}>
          {headline ? (
            <>
              <span class="trail-label">{headline.label}</span>
              {headline.detail && <span class="trail-detail">{headline.detail}</span>}
            </>
          ) : (
            <span class="trail-label">{summary(calls)}</span>
          )}
        </span>
        <Icon name="chevron" size={14} class={`trail-chevron${expanded ? " is-open" : ""}`} />
      </button>
      {expanded && (
        <ol class="trail-timeline">
          {calls.map((call) => (
            <li key={call.id} class={`trail-step is-${call.state}`}>
              <span class="trail-node">
                <KindIcon kind={call.kind} size={14} />
              </span>
              <span class="trail-text">
                <span class="trail-step-label">{call.label}</span>
                {call.detail && <span class="trail-step-detail">{call.detail}</span>}
              </span>
              <span class="trail-state">
                {call.state === "running" ? (
                  <span class="spinner" aria-label="…" />
                ) : call.state === "error" ? (
                  <span class="trail-error">
                    <Icon name="alert" size={15} />
                  </span>
                ) : (
                  call.durationMs != null && formatDuration(call.durationMs)
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Jusqu'à trois pastilles d'icônes qui se chevauchent, une par famille d'outil utilisée. */
function KindStack({ calls, running }: { calls: ToolCall[]; running: boolean }) {
  const kinds: string[] = [];
  for (const call of [...calls].reverse()) {
    if (!kinds.includes(call.kind)) kinds.push(call.kind);
    if (kinds.length === 3) break;
  }
  kinds.reverse();
  return (
    <span class="trail-stack" style={{ width: `${24 + (kinds.length - 1) * 14}px` }}>
      {kinds.map((kind, i) => (
        <span
          key={kind}
          class={`trail-chip${i === kinds.length - 1 ? " is-front" : ""}${running && i === kinds.length - 1 ? " is-pulsing" : ""}`}
          style={{ left: `${i * 14}px` }}
        >
          <KindIcon kind={kind} size={13} />
        </span>
      ))}
    </span>
  );
}

function summary(calls: ToolCall[]): string {
  const total = calls.reduce((sum, c) => sum + (c.durationMs ?? 0), 0);
  const failed = calls.filter((c) => c.state === "error").length;
  return [t.actions(calls.length), total > 0 ? formatDuration(total) : null, failed > 0 ? t.failed(failed) : null]
    .filter(Boolean)
    .join(" · ");
}
