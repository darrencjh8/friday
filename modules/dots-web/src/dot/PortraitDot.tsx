import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { DotMood } from "./ClayDot";

/**
 * Friday (espèce Nova) sur le web : ses boucles filmées, celles de l'app Android, en WebP animés.
 * ponytail: boucles seules, en fondu ; un <img> ne signale pas la fin d'un clip, donc pas de gestes
 * d'entrée et de sortie comme sur Android. WebCodecs ImageDecoder si on les veut un jour.
 */
const CLIPS: Record<DotMood, string> = { idle: "idle", thinking: "thinking", talking: "speaking", happy: "idle", sleeping: "sleeping" };
const FADE_MS = 200;
/** Le buste, cadré jusqu'à la taille, paraît petit dans la place d'un dot rond : il en prend le double. */
const SCALE = 2;
const clipSrc = (clip: string) => `/dots/nova/${clip}.webp`;

export function PortraitDot(props: { mood?: DotMood; size: number; class?: string }): JSX.Element {
  const clip = CLIPS[props.mood ?? "idle"];
  const shown = useRef(clip);
  const [leaving, setLeaving] = useState<string | null>(null);
  useEffect(() => {
    if (shown.current === clip) return;
    setLeaving(shown.current);
    shown.current = clip;
    const timer = setTimeout(() => setLeaving(null), FADE_MS);
    return () => clearTimeout(timer);
  }, [clip]);

  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const image = (name: string, cls: string) => (
    <img key={name} class={cls} src={still ? "/dots/nova/still.webp" : clipSrc(name)} alt="" draggable={false} decoding="async" />
  );
  const box = `${props.size * SCALE}px`;
  // L'ancien clip s'efface par-dessus le nouveau, déjà opaque : fondre les deux assombrirait le buste.
  return (
    <div class={`portrait-dot${props.class ? " " + props.class : ""}`} style={{ width: box, height: box }} aria-hidden="true">
      {image(clip, "is-showing")}
      {leaving && leaving !== clip && image(leaving, "is-leaving")}
    </div>
  );
}
