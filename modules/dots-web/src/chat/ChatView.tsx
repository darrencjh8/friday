import type { Ref } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { ClayDot, type DotMood } from "../dot/ClayDot";
import { paletteStyle } from "../dot/palettes";
import type { GatewayClient } from "../gateway/GatewayClient";
import { MAIN_CHAT, type GatewaySnapshot } from "../gateway/model";
import { useGateway } from "../gateway/registry";
import type { AccessoryId, PaletteId, SpeciesId, WebAgent } from "../types";
import { MessageRow, TypingBubble } from "./Bubbles";
import { dayLabel } from "./format";
import { Icon } from "./icons";
import { buildChatRows } from "./rows";
import { t } from "./strings";
import { ToolTrail } from "./ToolTrail";

/** Humeur de la mascotte selon l'activité (ChatScreen.kt `toMood`), endormie hors ligne. */
function moodOf(s: GatewaySnapshot): DotMood {
  if (s.status !== "online") return "sleeping";
  if (s.activity === "thinking") return "thinking";
  if (s.activity === "typing") return "talking";
  return "idle";
}

function statusLabel(s: GatewaySnapshot): string {
  if (s.status === "connecting") return t.connecting;
  if (s.status === "offline") return t.offline;
  if (s.activity === "thinking") return t.thinking;
  if (s.activity === "typing") return t.typing;
  return t.online;
}

/** Un brouillon par conversation (agent + dot), gardé quand on passe de l'une à l'autre. */
const drafts = new Map<string, string>();

/** Nom et mascotte d'un dot : le principal (apparence choisie dans l'app) ou un sous-dot. */
export interface DotLook {
  chat: string;
  name: string;
  species: SpeciesId;
  palette: PaletteId;
  accessory: AccessoryId;
}

function looksOf(agent: WebAgent, snapshot: GatewaySnapshot): DotLook[] {
  const main: DotLook = {
    chat: MAIN_CHAT,
    name: agent.name || snapshot.serverName || "Hermes",
    species: agent.species,
    palette: agent.palette,
    accessory: agent.accessory,
  };
  return [main, ...snapshot.dots.map((d) => ({ chat: d.id, name: d.name, species: d.species, palette: d.palette, accessory: d.accessory }))];
}

/**
 * La conversation ouverte d'un agent : en-tête (posé sur le fil, en dégradé du blanc vers le
 * transparent, comme l'app), fil et champ de saisie, teintés par la palette du dot ouvert.
 */
export function ChatView({ agent, client }: { agent: WebAgent; client: GatewayClient }) {
  const snapshot = useGateway(client)!;
  const looks = looksOf(agent, snapshot);
  const look = looks.find((l) => l.chat === snapshot.activeChat) ?? looks[0];
  const chatKey = `${agent.session_id}:${look.chat}`;
  const header = useRef<HTMLElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0);

  // Le fil passe sous l'en-tête : il commence juste en dessous, quelle que soit sa hauteur
  // (le sélecteur de dots l'agrandit).
  useLayoutEffect(() => {
    const el = header.current;
    if (!el) return;
    const measure = () => setHeaderHeight(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section class="chat" style={{ ...paletteStyle(look.palette), "--header-h": `${headerHeight}px` }}>
      <ChatHeader headerRef={header} look={look} looks={looks} client={client} snapshot={snapshot} />
      <Thread key={chatKey} client={client} snapshot={snapshot} look={look} />
      <Composer key={chatKey} draftKey={chatKey} client={client} name={look.name} />
    </section>
  );
}

function ChatHeader({
  headerRef,
  look,
  looks,
  client,
  snapshot,
}: {
  headerRef: Ref<HTMLElement>;
  look: DotLook;
  looks: DotLook[];
  client: GatewayClient;
  snapshot: GatewaySnapshot;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const busy = snapshot.status === "online" && snapshot.activity !== "idle";

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuOpen]);

  return (
    <header class="chat-header" ref={headerRef}>
      <div class="chat-header-side" />
      <div class="chat-identity">
        <ClayDot species={look.species} palette={look.palette} accessory={look.accessory} mood={moodOf(snapshot)} size={56} />
        <div class="chat-name t-title-sm">{look.name}</div>
        <div class={`chat-status is-${snapshot.status}${busy ? " is-busy" : ""}`} aria-live="polite">
          {statusLabel(snapshot)}
        </div>
      </div>
      <div class="chat-header-side is-end">
        {busy && (
          <button type="button" class="stop-btn" onClick={() => client.stop()}>
            <Icon name="stop" size={12} />
            {t.stop}
          </button>
        )}
        <div class="menu-anchor">
          <button
            type="button"
            class="icon-btn"
            aria-label={t.more}
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(!menuOpen);
            }}
          >
            <Icon name="more" size={18} />
          </button>
          {menuOpen && (
            <div class="menu" role="menu">
              <button
                type="button"
                role="menuitem"
                class="menu-item is-danger"
                onClick={() => {
                  if (window.confirm(t.logoutConfirm(looks[0].name))) client.logout();
                }}
              >
                <Icon name="logout" size={16} />
                {t.logout}
              </button>
            </div>
          )}
        </div>
      </div>
      {looks.length > 1 && <DotSwitcher looks={looks} client={client} snapshot={snapshot} />}
    </header>
  );
}

/**
 * Sélecteur des dots de l'agent : le principal puis ses sous-dots, chacun avec sa mascotte, une
 * pastille de non lus et un point quand il travaille. Sur l'app, on balaie la mascotte ; ici, on clique.
 */
function DotSwitcher({ looks, client, snapshot }: { looks: DotLook[]; client: GatewayClient; snapshot: GatewaySnapshot }) {
  return (
    <nav class="dot-switcher" aria-label={t.dots}>
      {looks.map((l) => {
        const selected = l.chat === snapshot.activeChat;
        const info = snapshot.chats[l.chat];
        const unread = selected ? 0 : info?.unread ?? 0;
        const busy = snapshot.status === "online" && (info?.activity ?? "idle") !== "idle";
        return (
          <button
            key={l.chat}
            type="button"
            class={`dot-chip${selected ? " is-selected" : ""}`}
            style={paletteStyle(l.palette)}
            aria-current={selected ? "true" : undefined}
            title={l.name}
            onClick={() => client.selectChat(l.chat)}
          >
            <ClayDot species={l.species} palette={l.palette} accessory={l.accessory} mood={busy ? "thinking" : "idle"} size={26} shadow={false} />
            <span class="dot-chip-name">{l.name}</span>
            {busy && <span class="dot-chip-busy" aria-label={t.thinking} />}
            {unread > 0 && <span class="dot-chip-unread">{unread > 99 ? "99+" : unread}</span>}
          </button>
        );
      })}
    </nav>
  );
}

/** Distance du bas en dessous de laquelle le fil suit les nouveaux messages. */
const STICK_PX = 80;
/** Distance du haut à partir de laquelle on demande la page précédente. */
const PREFETCH_PX = 400;

function Thread({ client, snapshot, look }: { client: GatewayClient; snapshot: GatewaySnapshot; look: DotLook }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const firstKey = useRef<string | undefined>(undefined);
  const rows = useMemo(
    () => buildChatRows(snapshot.messages, snapshot.tools, snapshot.status === "online" ? snapshot.activity : "idle"),
    [snapshot.messages, snapshot.tools, snapshot.activity, snapshot.status],
  );

  // Lu pendant le rendu, donc AVANT que le DOM change : hauteur et position d'avant la mise à jour,
  // pour garder le même message sous les yeux quand une page plus ancienne s'insère en tête.
  const before = scroller.current ? { height: scroller.current.scrollHeight, top: scroller.current.scrollTop } : null;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const first = snapshot.messages[0]?.key;
    const prepended =
      before && firstKey.current && first !== firstKey.current && snapshot.messages.some((m) => m.key === firstKey.current);
    if (prepended) {
      el.scrollTop = before.top + (el.scrollHeight - before.height);
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
    firstKey.current = first;
    maybeLoadOlder();
  }, [rows, snapshot.loadingOlder, snapshot.hasMore]);

  // Le champ de saisie grandit, la fenêtre change de taille : on reste collé en bas si on y était.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Message envoyé : on redescend, même si l'on lisait plus haut.
  useEffect(() => {
    const last = snapshot.messages[snapshot.messages.length - 1];
    if (last?.role === "user" && last.id == null) {
      stick.current = true;
      const el = scroller.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [snapshot.messages.length]);

  function maybeLoadOlder() {
    const el = scroller.current;
    if (el && el.scrollTop < PREFETCH_PX && snapshot.hasMore && !snapshot.loadingOlder) client.loadOlder();
  }

  function onScroll() {
    const el = scroller.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    maybeLoadOlder();
  }

  const online = snapshot.status === "online";

  return (
    <div class="thread" ref={scroller} onScroll={onScroll}>
      <div class="thread-inner">
        {!snapshot.loaded ? (
          <div class="thread-loading">
            <span class="spinner" />
          </div>
        ) : snapshot.messages.length === 0 ? (
          <div class="thread-empty">
            <ClayDot species={look.species} palette={look.palette} accessory={look.accessory} mood="happy" size={96} shadow />
            <div class="t-title">{t.empty(look.name)}</div>
          </div>
        ) : (
          <>
            <div class="thread-top">
              {snapshot.loadingOlder ? (
                <span class="spinner" aria-label={t.loadingOlder} />
              ) : (
                !snapshot.hasMore && <span class="t-label-sm t-secondary">{t.chatStart}</span>
              )}
            </div>
            {rows.map((row) => {
              switch (row.type) {
                case "day":
                  return (
                    <div key={row.key} class="day-separator t-label-sm">
                      {dayLabel(row.ts)}
                    </div>
                  );
                case "tools":
                  return <ToolTrail key={row.key} calls={row.calls} />;
                case "typing":
                  return <TypingBubble key={row.key} />;
                default:
                  return <MessageRow key={row.key} row={row} client={client} online={online} />;
              }
            })}
          </>
        )}
      </div>
    </div>
  );
}

function Composer({ draftKey, client, name }: { draftKey: string; client: GatewayClient; name: string }) {
  const [draft, setDraft] = useState(() => drafts.get(draftKey) ?? "");
  const field = useRef<HTMLTextAreaElement>(null);

  // Hauteur ajustée au contenu, jusqu'à ~8 lignes, puis défilement interne.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft]);

  useEffect(() => {
    // Sur un écran avec clavier physique, on peut écrire dès l'ouverture de la conversation.
    if (window.matchMedia("(pointer: fine)").matches) field.current?.focus();
  }, []);

  function update(value: string) {
    setDraft(value);
    drafts.set(draftKey, value);
  }

  function submit() {
    if (!draft.trim()) return;
    client.send(draft);
    update("");
  }

  return (
    <div class="composer-zone">
      <form
        class="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <button type="button" class="composer-plus" disabled title={t.attach} aria-label={t.attach}>
          <Icon name="plus" size={20} />
        </button>
        <div class="composer-field">
          <textarea
            ref={field}
            rows={1}
            value={draft}
            placeholder={t.placeholder(name)}
            aria-label={t.placeholder(name)}
            onInput={(e) => update((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              // Entrée envoie, Maj+Entrée revient à la ligne ; jamais pendant une composition (IME).
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button type="submit" class={`composer-send${draft.trim() ? " is-ready" : ""}`} disabled={!draft.trim()} aria-label={t.send}>
            <Icon name="arrowUp" size={18} />
          </button>
        </div>
      </form>
    </div>
  );
}
