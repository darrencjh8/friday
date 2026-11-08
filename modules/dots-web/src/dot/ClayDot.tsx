import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { AccessoryId, PaletteId, SpeciesId } from "../types";
import "./ClayDot.css";

/**
 * Portage web de ClayDot.kt : la mascotte en pâte à modeler, faite de calques pré-rendus (cadres
 * carrés de 640 px, tous de la même taille) empilés puis animés indépendamment — flottement,
 * écrasement au rebond, clignement, regard, battement d'ailes, balancement de l'accessoire.
 *
 * Les formules sont celles de Compose, à l'identique. Pour rester léger avec beaucoup de dots à
 * l'écran : une seule boucle requestAnimationFrame pour toutes les instances, qui écrit directement
 * les `transform`/`opacity` dans le DOM (aucun rendu Preact par image), et qui saute les dots hors
 * de l'écran (IntersectionObserver).
 */
export type DotMood = "idle" | "thinking" | "talking" | "happy" | "sleeping";

export interface ClayDotProps {
  species: SpeciesId;
  palette: PaletteId;
  accessory?: AccessoryId;
  mood?: DotMood;
  /** Côté du cadre carré, en px. */
  size: number;
  shadow?: boolean;
  class?: string;
}

// ---------------------------------------------------------------------------------------------
// Repères de chaque espèce (DotSpecies.kt), en fractions du cadre.

interface Swaying {
  file: string;
  px: number;
  py: number;
  amplitude: number;
}

interface Art {
  prefix: string;
  bodyTop: number;
  bodyBottom: number;
  eyeY: number;
  mouthY: number;
  shadowY: number;
  /** Petit sourire permanent au repos (Nuage, Pavé) ; le Galet n'a pas de bouche au repos. */
  mouthRest: boolean;
  /** Accessoire d'une pièce qui se balance ; null pour le Galet (pétase + deux ailes). */
  swaying: Swaying | null;
}

const ART: Record<SpeciesId, Art> = {
  galet: { prefix: "dot_", bodyTop: 0.3478, bodyBottom: 0.85, eyeY: 0.5935, mouthY: 0.6421, shadowY: 0.88, mouthRest: false, swaying: null },
  nuage: {
    prefix: "dot_nuage_", bodyTop: 0.3344, bodyBottom: 0.8125, eyeY: 0.6135, mouthY: 0.6594, shadowY: 0.835, mouthRest: true,
    swaying: { file: "dot_nuage_antenna", px: 0.5, py: 0.336, amplitude: 9 },
  },
  pave: {
    prefix: "dot_pave_", bodyTop: 0.3719, bodyBottom: 0.8078, eyeY: 0.6085, mouthY: 0.6544, shadowY: 0.813, mouthRest: true,
    swaying: { file: "dot_pave_sprout", px: 0.5, py: 0.4, amplitude: 6 },
  },
};

// Pivots des ailes du Galet (ClayDot.kt, imprimés par render_mascot.py --app).
const WING_LEFT = "40.03% 33.26%";
const WING_RIGHT = "59.33% 30.94%";
const PALETTE_IDS: PaletteId[] = ["tangerine", "bubblegum", "sky", "lime", "sun", "grape"];

const src = (name: string) => `/dots/${name}.webp`;
const pct = (f: number) => `${(f * 100).toFixed(2)}%`;

// ---------------------------------------------------------------------------------------------
// Horloge et instances

const MOODS: DotMood[] = ["idle", "thinking", "talking", "happy", "sleeping"];
/** Durées des fondus entre humeurs (tween de animateFloatAsState dans ClayDot.kt). */
const FADE_MS: Record<DotMood, number> = { idle: 500, thinking: 500, talking: 400, happy: 400, sleeping: 700 };
const CYCLE_MS = 4800;
const TWO_PI = Math.PI * 2;

type Layers = Partial<Record<
  "shadow" | "body" | "eyesOpen" | "eyesHappy" | "eyesSleepy" | "mouthRest" | "mouthSmile" | "mouthO" | "sway" | "wingL" | "wingR" | "cap",
  HTMLElement
>>;

interface Instance {
  art: Art;
  size: number;
  layers: Layers;
  mood: DotMood;
  /** Avancement linéaire 0→1 de chaque humeur ; le poids affiché est lissé (smoothstep). */
  progress: Record<DotMood, number>;
  /** Regard (spring amorti 0.6, raideur 120 comme lookX/lookY). */
  look: { x: number; y: number; vx: number; vy: number };
  blink: number;
  nextBlink: number;
  /** Décalage d'horloge : chaque dot démarre son cycle à son apparition, comme en Compose. */
  t0: number;
  visible: boolean;
  /** En mouvement réduit : plus rien à animer une fois les fondus terminés. */
  settled: boolean;
}

const instances = new Set<Instance>();
let rafId = 0;
let lastFrame = 0;
const reducedQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
let reduced = !!reducedQuery?.matches;
reducedQuery?.addEventListener?.("change", (e) => {
  reduced = e.matches;
  instances.forEach((i) => (i.settled = false));
  wake();
});

const observer =
  typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        for (const e of entries) {
          const inst = byElement.get(e.target);
          if (inst) inst.visible = e.isIntersecting;
        }
        wake();
      })
    : null;
const byElement = new WeakMap<Element, Instance>();

function wake() {
  if (!rafId && instances.size > 0) {
    lastFrame = performance.now();
    rafId = requestAnimationFrame(frame);
  }
}

function frame(now: number) {
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  let busy = false;
  for (const inst of instances) {
    if (!inst.visible || inst.settled) continue;
    step(inst, now, dt);
    draw(inst, now);
    busy = true;
  }
  // La boucle s'arrête d'elle-même quand plus aucun dot n'est à animer (hors écran, mouvement réduit).
  rafId = busy ? requestAnimationFrame(frame) : 0;
}

const smooth = (p: number) => p * p * (3 - 2 * p);

function step(inst: Instance, now: number, dt: number) {
  let moving = false;
  for (const m of MOODS) {
    const target = inst.mood === m ? 1 : 0;
    const p = inst.progress[m];
    if (p === target) continue;
    const d = reduced ? 1 : (dt * 1000) / FADE_MS[m];
    inst.progress[m] = target > p ? Math.min(target, p + d) : Math.max(target, p - d);
    moving = true;
  }

  const tx = inst.mood === "thinking" ? 1 : 0;
  const ty = inst.mood === "thinking" ? -1 : 0;
  const lk = inst.look;
  if (reduced) {
    lk.x = tx;
    lk.y = ty;
    lk.vx = lk.vy = 0;
  } else {
    // Ressort amorti : a = k·(cible − x) − 2ζ√k·v, avec ζ = 0.6 et k = 120.
    const k = 120;
    const c = 2 * 0.6 * Math.sqrt(k);
    lk.vx += (k * (tx - lk.x) - c * lk.vx) * dt;
    lk.vy += (k * (ty - lk.y) - c * lk.vy) * dt;
    lk.x += lk.vx * dt;
    lk.y += lk.vy * dt;
    if (Math.abs(tx - lk.x) + Math.abs(ty - lk.y) + Math.abs(lk.vx) + Math.abs(lk.vy) < 1e-3) {
      lk.x = tx;
      lk.y = ty;
      lk.vx = lk.vy = 0;
    } else moving = true;
  }

  // Clignement : 70 ms pour fermer (jusqu'à 0.1), 130 ms pour rouvrir, toutes les 2 à 4,8 s.
  if (reduced || inst.mood === "sleeping") {
    inst.blink = 1;
    inst.nextBlink = now + 2000 + Math.random() * 2800;
  } else if (now >= inst.nextBlink) {
    const t = now - inst.nextBlink;
    if (t < 70) inst.blink = 1 - 0.9 * (t / 70);
    else if (t < 200) inst.blink = 0.1 + 0.9 * ((t - 70) / 130);
    else {
      inst.blink = 1;
      inst.nextBlink = now + 2000 + Math.random() * 2800;
    }
  }

  if (reduced && !moving) inst.settled = true;
}

function draw(inst: Instance, now: number) {
  const { art, layers: L, size: S } = inst;
  const phase = reduced ? 0 : (((now - inst.t0) % CYCLE_MS) / CYCLE_MS) * TWO_PI;
  const idle = smooth(inst.progress.idle);
  const thinking = smooth(inst.progress.thinking);
  const talking = smooth(inst.progress.talking);
  const happy = smooth(inst.progress.happy);
  const sleeping = smooth(inst.progress.sleeping);
  const sin = Math.sin;
  const abs = Math.abs;

  const lift =
    idle * sin(phase) * 0.016 +
    thinking * (0.5 + 0.5 * sin(2 * phase)) * 0.05 +
    talking * abs(sin(4 * phase)) * 0.03 +
    happy * abs(sin(3 * phase)) * 0.075;
  const squash =
    0.018 * sin(2 * phase) * (1 - 0.6 * sleeping) +
    happy * (1 - abs(sin(3 * phase))) ** 4 * 0.09 +
    talking * (1 - abs(sin(4 * phase))) ** 4 * 0.04;
  /** Suit le corps : un point à la hauteur anchorY descend quand le corps s'écrase vers sa base. */
  const follow = (anchorY: number) => (-lift + squash * (art.bodyBottom - anchorY)) * S;

  if (L.shadow) {
    const k = Math.min(1, Math.max(0.6, 1 - lift * 4));
    L.shadow.style.transform = `scale(${k})`;
    L.shadow.style.opacity = String(k);
  }
  if (L.body) {
    L.body.style.transform = `translateY(${-lift * S}px) scale(${1 + squash}, ${1 - squash})`;
    L.body.style.filter = sleeping > 0.001 ? `saturate(${1 - 0.65 * sleeping})` : "";
  }

  const eyeY = follow(art.eyeY);
  const eyesOpen = Math.min(1, Math.max(0, 1 - happy - sleeping));
  if (L.eyesOpen) {
    const lx = (inst.look.x * 0.025 + talking * 0.01 * sin(phase)) * S;
    const ly = eyeY + inst.look.y * 0.02 * S;
    L.eyesOpen.style.transform = `translate(${lx}px, ${ly}px) scaleY(${inst.blink})`;
    L.eyesOpen.style.opacity = String(eyesOpen);
  }
  setFollow(L.eyesHappy, eyeY, happy);
  setFollow(L.eyesSleepy, eyeY, sleeping);

  const mouthY = follow(art.mouthY);
  setFollow(L.mouthRest, mouthY, Math.min(1, idle + sleeping));
  setFollow(L.mouthSmile, mouthY, happy);
  if (L.mouthO) {
    // En parlant, la bouche s'ouvre et se ferme au rythme des petits rebonds.
    const open = 1 + talking * (abs(sin(4 * phase)) * 0.9 - 0.3);
    L.mouthO.style.transform = `translateY(${mouthY}px) scale(${open})`;
    L.mouthO.style.opacity = String(Math.max(thinking, talking));
  }

  const topY = follow(art.bodyTop);
  if (L.sway && art.swaying) {
    // Balancement en retard sur le rebond : l'accessoire semble souple, entraîné par le corps.
    const r =
      art.swaying.amplitude *
      (0.5 * sin(phase - 0.6) + happy * sin(3 * phase - 0.8) + talking * 0.6 * sin(4 * phase - 0.8) + thinking * 0.4 * sin(2 * phase));
    L.sway.style.transform = `translateY(${topY}px) rotate(${r}deg)`;
  }
  if (L.wingL || L.wingR || L.cap) {
    const flap = sin(2 * phase) * 5 + thinking * sin(6 * phase) * 8 + happy * sin(6 * phase) * 12;
    if (L.wingL) L.wingL.style.transform = `translateY(${topY}px) rotate(${flap}deg)`;
    if (L.wingR) L.wingR.style.transform = `translateY(${topY}px) rotate(${-flap}deg)`;
    if (L.cap) L.cap.style.transform = `translateY(${topY}px)`;
  }
}

function setFollow(el: HTMLElement | undefined, y: number, alpha: number) {
  if (!el) return;
  el.style.transform = `translateY(${y}px)`;
  el.style.opacity = String(alpha);
}

// ---------------------------------------------------------------------------------------------
// Composant

/** Fondu enchaîné du corps quand la couleur change (Crossfade 450 ms en Compose). */
const BODY_FADE_MS = 450;

export function ClayDot(props: ClayDotProps): JSX.Element {
  const { species, palette, accessory = "winged_cap", mood = "idle", size, shadow = true } = props;
  const art = ART[species] ?? ART.galet;
  const pal = PALETTE_IDS.includes(palette) ? palette : "tangerine";
  const bodySrc = src(`${art.prefix}body_${pal}`);

  const root = useRef<HTMLDivElement>(null);
  const inst = useRef<Instance | null>(null);
  if (!inst.current) {
    const now = performance.now();
    const progress = { idle: 0, thinking: 0, talking: 0, happy: 0, sleeping: 0 } as Record<DotMood, number>;
    progress[mood] = 1; // Pas de fondu à l'apparition.
    const lookOn = mood === "thinking";
    inst.current = {
      art, size, layers: {}, mood, progress,
      look: { x: lookOn ? 1 : 0, y: lookOn ? -1 : 0, vx: 0, vy: 0 },
      blink: 1, nextBlink: now + 2000 + Math.random() * 2800,
      t0: now - Math.random() * CYCLE_MS, visible: true, settled: false,
    };
  }

  // Corps affichés : le dernier entre en fondu par-dessus le précédent, retiré à la fin du fondu.
  const [bodies, setBodies] = useState<{ src: string; fade: boolean }[]>([{ src: bodySrc, fade: false }]);
  useEffect(() => {
    if (bodies[bodies.length - 1].src === bodySrc) return;
    setBodies((b) => [...b.slice(-1), { src: bodySrc, fade: true }]);
    const t = setTimeout(() => setBodies((b) => b.slice(-1)), BODY_FADE_MS);
    return () => clearTimeout(t);
  }, [bodySrc]);

  // Recense les calques après chaque rendu de structure, puis redessine tout de suite.
  useLayoutEffect(() => {
    const i = inst.current!;
    i.art = art;
    i.size = size;
    if (i.mood !== mood) i.mood = mood;
    const layers: Layers = {};
    root.current?.querySelectorAll<HTMLElement>("[data-l]").forEach((el) => {
      layers[el.dataset.l as keyof Layers] = el;
    });
    i.layers = layers;
    i.settled = false;
    draw(i, performance.now());
    wake();
  });

  useEffect(() => {
    const i = inst.current!;
    const el = root.current!;
    instances.add(i);
    byElement.set(el, i);
    observer?.observe(el);
    wake();
    return () => {
      instances.delete(i);
      observer?.unobserve(el);
    };
  }, []);

  const img = (name: string, l: keyof Layers, origin?: string) => (
    <img data-l={l} src={src(name)} alt="" draggable={false} decoding="async" style={origin ? { transformOrigin: origin } : undefined} />
  );
  const p = art.prefix;

  return (
    <div
      ref={root}
      class={`clay-dot${props.class ? " " + props.class : ""}`}
      style={{ width: `${size}px`, height: `${size}px` }}
      aria-hidden="true"
    >
      {shadow && img(`${p}shadow`, "shadow", `50% ${pct(art.shadowY)}`)}
      <div data-l="body" class="clay-dot-body" style={{ transformOrigin: `50% ${pct(art.bodyBottom)}` }}>
        {bodies.map((b) => (
          <img key={b.src} src={b.src} alt="" draggable={false} decoding="async" class={b.fade ? "clay-dot-fade" : undefined} />
        ))}
      </div>
      {img(`${p}eyes_open`, "eyesOpen", `50% ${pct(art.eyeY)}`)}
      {img(`${p}eyes_happy`, "eyesHappy")}
      {img(`${p}eyes_sleepy`, "eyesSleepy")}
      {art.mouthRest && img(`${p}mouth_rest`, "mouthRest")}
      {img(`${p}mouth_smile`, "mouthSmile")}
      {img(`${p}mouth_o`, "mouthO", `51.08% ${pct(art.mouthY)}`)}
      {accessory === "winged_cap" && art.swaying && img(art.swaying.file, "sway", `${pct(art.swaying.px)} ${pct(art.swaying.py)}`)}
      {accessory === "winged_cap" && !art.swaying && [
        <img key="wl" data-l="wingL" src={src("dot_wing_left")} alt="" draggable={false} decoding="async" style={{ transformOrigin: WING_LEFT }} />,
        <img key="wr" data-l="wingR" src={src("dot_wing_right")} alt="" draggable={false} decoding="async" style={{ transformOrigin: WING_RIGHT }} />,
        <img key="cap" data-l="cap" src={src("dot_cap")} alt="" draggable={false} decoding="async" />,
      ]}
    </div>
  );
}
