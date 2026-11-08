import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import { ClayDot, type DotMood } from "../dot/ClayDot";
import { paletteStyle } from "../dot/palettes";
import { lang, strings } from "../i18n";
import { mergeAgents } from "../store";
import type { PairingPayload } from "../types";
import { decryptDeposit, generatePairingKeys, pairingUrl, type PairingKeys } from "./crypto";
import "./pairing.css";

/**
 * Écran d'appairage (docs/appairage-web.md) : un QR code « tournant » (id + clé publique éphémère,
 * renouvelés toutes les 30 s) que l'app Android scanne ; le navigateur relève ensuite le dépôt
 * chiffré sur le relais, le déchiffre et enregistre les agents reçus. main.tsx bascule alors sur le chat.
 *
 * `onCancel` : affiché comme bouton de fermeture quand on ajoute un agent depuis le chat ; il est
 * aussi appelé après un appairage réussi.
 */

const ROTATE_MS = 30_000;
const POLL_MS = 1_500;
/** Durée de l'écran de succès (mascottes contentes) avant d'ouvrir le chat. */
const SUCCESS_MS = 1_400;
const RING_R = 15;
const RING_C = 2 * Math.PI * RING_R;

const t = strings({
  en: {
    title: "Hermes in your browser",
    subtitle: "Pair this browser with your phone to chat with your agents from here.",
    step1: "Open Hermes on your phone",
    step2: "Menu → Connect a browser",
    step3: "Scan this code",
    qrLabel: "QR code to scan with the Hermes app",
    waiting: "Waiting for your phone…",
    receiving: "Connecting…",
    refresh: (n: number) => `New code in ${n} s`,
    badCode: "This pairing couldn’t be decrypted. Scan the new code.",
    network: "Can’t reach the pairing relay. Retrying…",
    success: (names: string) => `Connected to ${names}`,
    successSub: "Opening the chat…",
    fromLink: "This link is meant to be scanned with the Hermes app: scan the code below from your phone.",
    close: "Close",
    footer: "Your conversations go directly from this browser to your gateway; nothing goes through this site.",
  },
  fr: {
    title: "Hermes dans ton navigateur",
    subtitle: "Appaire ce navigateur avec ton téléphone pour discuter avec tes agents d’ici.",
    step1: "Ouvre Hermes sur ton téléphone",
    step2: "Menu → Connecter un navigateur",
    step3: "Scanne ce code",
    qrLabel: "QR code à scanner avec l’app Hermes",
    waiting: "En attente de ton téléphone…",
    receiving: "Connexion…",
    refresh: (n: number) => `Nouveau code dans ${n} s`,
    badCode: "Impossible de déchiffrer cet appairage. Scanne le nouveau code.",
    network: "Le relais d’appairage ne répond pas. Nouvel essai…",
    success: (names: string) => `Connecté à ${names}`,
    successSub: "Ouverture du chat…",
    fromLink: "Ce lien se scanne avec l’app Hermes : scanne le code ci-dessous depuis ton téléphone.",
    close: "Fermer",
    footer: "Tes conversations vont directement de ce navigateur à ton gateway ; rien ne passe par ce site.",
  },
});

type Status = "waiting" | "receiving" | "bad" | "network" | "success";

export function PairingScreen({ onCancel }: { onCancel?: () => void }) {
  const [keys, setKeys] = useState<PairingKeys | null>(null);
  const [status, setStatus] = useState<Status>("waiting");
  const [remaining, setRemaining] = useState(ROTATE_MS / 1000);
  const [names, setNames] = useState("");
  const [fromLink, setFromLink] = useState(false);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    // Arrivé ici par le lien du QR (appareil photo sans l'app) : on nettoie l'adresse, la clé
    // publique d'un autre écran n'a rien à faire dans l'historique.
    if (location.pathname === "/pair" || location.hash.startsWith("#v1.")) {
      history.replaceState(null, "", "/");
      setFromLink(true);
    }

    let alive = true;
    let done = false;
    let rotating: Promise<void> | null = null;
    let cur: PairingKeys | null = null;
    let prev: PairingKeys | null = null;
    let rotatedAt = 0;
    let pollTimer = 0;
    let badTimer = 0;

    const rotate = () =>
      (rotating ??= generatePairingKeys()
        .then((k) => {
          if (!alive) return;
          prev = cur;
          cur = k;
          rotatedAt = Date.now();
          setKeys(k);
          setRemaining(ROTATE_MS / 1000);
        })
        .finally(() => (rotating = null)));

    const succeed = (payload: PairingPayload) => {
      done = true;
      const list = payload.agents.map((a) => a.name);
      setNames(typeof Intl.ListFormat === "function" ? new Intl.ListFormat(lang, { type: "conjunction" }).format(list) : list.join(", "));
      setStatus("success");
      setTimeout(() => {
        mergeAgents(payload.agents);
        onCancelRef.current?.();
      }, SUCCESS_MS);
    };

    /** Relève le dépôt d'un id ; true si l'appairage est terminé (réussi) ou qu'il faut cesser ce tour. */
    const check = async (k: PairingKeys): Promise<boolean> => {
      const res = await fetch(`/api/pair?id=${k.id}`, { cache: "no-store" });
      if (res.status === 204) return false;
      if (res.status !== 200) throw new Error(`relais ${res.status}`);
      setStatus("receiving");
      try {
        succeed(await decryptDeposit(await res.json(), k.privateKey, k.idBytes));
      } catch (e) {
        // Dépôt illisible (déjà effacé du relais) : on le signale et on change de code.
        console.warn("appairage :", e);
        setStatus("bad");
        clearTimeout(badTimer);
        badTimer = window.setTimeout(() => alive && !done && setStatus((s) => (s === "bad" ? "waiting" : s)), 8_000);
        prev = null;
        await rotate();
      }
      return true;
    };

    const poll = async () => {
      if (!alive || done) return;
      if (!document.hidden && cur) {
        try {
          for (const k of [cur, prev]) if (k && (await check(k))) break;
          setStatus((s) => (s === "network" ? "waiting" : s));
        } catch {
          setStatus((s) => (s === "success" ? s : "network"));
        }
      }
      if (alive && !done) pollTimer = window.setTimeout(poll, POLL_MS);
    };

    // Horloge d'une seconde : compte à rebours affiché et rotation (suspendue onglet caché).
    const tick = window.setInterval(() => {
      if (done || document.hidden || !cur) return;
      const left = Math.ceil((ROTATE_MS - (Date.now() - rotatedAt)) / 1000);
      if (left <= 0) void rotate();
      else setRemaining(left);
    }, 1_000);

    const onVisible = () => {
      if (document.hidden || done) return;
      // De retour sur l'onglet : un code périmé est renouvelé tout de suite, et on relève aussitôt.
      if (Date.now() - rotatedAt >= ROTATE_MS) void rotate();
      clearTimeout(pollTimer);
      void poll();
    };
    document.addEventListener("visibilitychange", onVisible);

    void rotate().then(poll);

    return () => {
      alive = false;
      clearTimeout(pollTimer);
      clearTimeout(badTimer);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const mood: DotMood = status === "success" ? "happy" : status === "receiving" ? "thinking" : "idle";
  const message =
    status === "success" ? null : status === "bad" ? t.badCode : status === "network" ? t.network : status === "receiving" ? t.receiving : t.waiting;

  return (
    <div class="pair" style={paletteStyle("sky")}>
      {onCancel && (
        <button class="pair-close" type="button" onClick={onCancel} aria-label={t.close} title={t.close}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
          </svg>
        </button>
      )}

      {/* dot-scope sur un descendant : posé sur l'élément au style inline, il serait écrasé par celui-ci. */}
      <main class="pair-main dot-scope">
        <section class="pair-intro">
          <div class="pair-hero" aria-hidden="true">
            <ClayDot class="pair-hero-side" species="galet" palette="tangerine" mood={mood} size={104} />
            <ClayDot class="pair-hero-center" species="nuage" palette="sky" mood={mood} size={168} />
            <ClayDot class="pair-hero-side" species="pave" palette="grape" mood={mood} size={104} />
          </div>
          <h1 class="pair-title">{t.title}</h1>
          <p class="pair-subtitle t-body-lg t-secondary">{t.subtitle}</p>
          <ol class="pair-steps">
            <li><span class="pair-step-n">1</span>{t.step1}</li>
            <li><span class="pair-step-n">2</span>{t.step2}</li>
            <li><span class="pair-step-n">3</span>{t.step3}</li>
          </ol>
          {fromLink && <p class="pair-note t-body-sm">{t.fromLink}</p>}
        </section>

        <section class="pair-card" aria-live="polite">
          {status === "success" ? (
            <div class="pair-success">
              <ClayDot species="nuage" palette="sky" mood="happy" size={148} />
              <p class="t-headline">{t.success(names)}</p>
              <p class="t-body-sm t-secondary">{t.successSub}</p>
            </div>
          ) : (
            <>
              <div class={`pair-qr${status === "receiving" ? " is-busy" : ""}`}>
                {keys ? <QrCode text={pairingUrl(keys)} label={t.qrLabel} /> : <div class="pair-qr-placeholder" />}
              </div>
              <div class="pair-status">
                <CountdownRing key={keys?.id} remaining={remaining} />
                <div>
                  <p class={`t-title-sm${status === "bad" || status === "network" ? " pair-error" : ""}`}>{message}</p>
                  <p class="t-body-sm t-secondary">{t.refresh(remaining)}</p>
                </div>
              </div>
            </>
          )}
        </section>
      </main>

      <footer class="pair-footer t-body-sm t-secondary">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path
            d="M7 10V8a5 5 0 0 1 10 0v2m-11 0h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linejoin="round"
          />
        </svg>
        {t.footer}
      </footer>
    </div>
  );
}

/** QR code en SVG (correction d'erreur M), un chemin pour tous les modules sombres. */
function QrCode({ text, label }: { text: string; label: string }) {
  const { n, d } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return { n, d };
  }, [text]);
  // La zone de silence (2 modules + la marge blanche de la carte) est dans le viewBox.
  return (
    <svg class="pair-qr-svg" viewBox={`-2 -2 ${n + 4} ${n + 4}`} role="img" aria-label={label} shape-rendering="crispEdges">
      <path d={d} />
    </svg>
  );
}

/** Anneau du compte à rebours avant le prochain code. */
function CountdownRing({ remaining }: { remaining: number }) {
  const frac = remaining / (ROTATE_MS / 1000);
  return (
    <svg class="pair-ring" viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">
      <circle cx="18" cy="18" r={RING_R} class="pair-ring-track" />
      <circle
        cx="18"
        cy="18"
        r={RING_R}
        class="pair-ring-fill"
        stroke-dasharray={RING_C}
        stroke-dashoffset={RING_C * (1 - frac)}
        transform="rotate(-90 18 18)"
      />
      <text x="18" y="18" class="pair-ring-text" text-anchor="middle" dominant-baseline="central">
        {remaining}
      </text>
    </svg>
  );
}
