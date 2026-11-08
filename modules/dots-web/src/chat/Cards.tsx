import { useState } from "preact/hooks";
import type { ChatMessage } from "../gateway/model";
import { Icon } from "./icons";
import { t } from "./strings";

/**
 * Cartes de l'agent (AgentCards.kt) : demande de feu vert, question, prise en main. Elles restent
 * dans le fil une fois tranchées, avec la décision visible.
 */

function CardHeader({ dot, label, tone }: { dot: string; label: string; tone?: string }) {
  return (
    <div class="card-head">
      <span class="card-dot" style={{ background: dot }} />
      <span class="t-label" style={{ color: tone ?? "var(--ink-secondary)" }}>
        {label}
      </span>
    </div>
  );
}

function StatusLine({ icon, label, color }: { icon: string; label: string; color: string }) {
  return (
    <div class="card-status" style={{ color }}>
      <Icon name={icon} size={18} />
      <span>{label}</span>
    </div>
  );
}

export function ApprovalCard({
  message,
  online,
  onAnswer,
}: {
  message: ChatMessage;
  online: boolean;
  onAnswer: (approve: boolean) => void;
}) {
  const approval = message.approval!;
  const pending = !approval.resolved;
  // Le gateway met la commande dans `command` et son explication dans `description` (Android : titre = description).
  const title = approval.description || approval.title || t.approvalDefaultTitle;
  return (
    <div class="card">
      <CardHeader
        dot={pending ? "var(--ink-warning)" : "var(--ink-tertiary)"}
        label={pending ? t.approvalRequired : t.approvalDecided}
        tone={pending ? "var(--ink-warning)" : undefined}
      />
      <div class="card-title t-title-sm">{title}</div>
      {approval.command && <pre class="card-detail">{approval.command}</pre>}
      {pending ? (
        <div class="card-actions">
          <button type="button" class="btn btn-secondary" disabled={!online} onClick={() => onAnswer(false)}>
            {t.decline}
          </button>
          <button type="button" class="btn btn-primary" disabled={!online} onClick={() => onAnswer(true)}>
            {t.approve}
          </button>
        </div>
      ) : approval.resolved === "deny" ? (
        <StatusLine icon="xCircle" label={t.declined} color="var(--ink-secondary)" />
      ) : (
        <StatusLine icon="checkCircle" label={t.approved} color="var(--ink-success)" />
      )}
    </div>
  );
}

export function ClarifyCard({
  message,
  online,
  onAnswer,
}: {
  message: ChatMessage;
  online: boolean;
  onAnswer: (response: string) => void;
}) {
  const clarify = message.clarify!;
  const [draft, setDraft] = useState("");
  const open = clarify.answer == null;
  return (
    <div class="card">
      <CardHeader dot={open ? "var(--dot-base)" : "var(--ink-tertiary)"} label={t.question} />
      <div class="card-title t-title-sm">{clarify.question}</div>
      {!open ? (
        <StatusLine icon="checkCircle" label={clarify.answer!} color="var(--dot-deep)" />
      ) : clarify.choices.length > 0 ? (
        <div class="card-choices">
          {clarify.choices.map((choice) => (
            <button key={choice} type="button" class="btn btn-choice" disabled={!online} onClick={() => onAnswer(choice)}>
              {choice}
            </button>
          ))}
        </div>
      ) : (
        <form
          class="card-answer"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) onAnswer(draft.trim());
          }}
        >
          <input
            class="card-input"
            value={draft}
            placeholder={t.answerPlaceholder}
            onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          />
          <button type="submit" class="btn btn-primary btn-small" disabled={!online || !draft.trim()}>
            {t.answer}
          </button>
        </form>
      )}
    </div>
  );
}

/**
 * L'agent attend l'utilisateur sur son navigateur. La prise en main (écran en direct) n'existe pas
 * encore sur le web : la carte renvoie vers l'app du téléphone.
 */
export function TakeoverCard({ message }: { message: ChatMessage }) {
  const pending = message.status === "pending";
  return (
    <div class="card">
      <CardHeader
        dot={pending ? "var(--ink-warning)" : "var(--ink-tertiary)"}
        label={pending ? t.takeoverNeeded : message.status === "expired" ? t.takeoverExpired : t.takeoverHandedBack}
        tone={pending ? "var(--ink-warning)" : undefined}
      />
      <div class="card-title t-title-sm">{message.text}</div>
      {pending ? (
        <div class="card-notice">
          <Icon name="hand" size={18} />
          <span>{t.takeoverHint}</span>
        </div>
      ) : message.status === "done" ? (
        <StatusLine icon="checkCircle" label={t.takeoverResumed} color="var(--ink-success)" />
      ) : null}
    </div>
  );
}
