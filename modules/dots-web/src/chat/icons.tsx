import type { JSX } from "preact";

/**
 * Pictogrammes au trait (24 × 24, `currentColor`) : ceux des familles d'outils (ToolKind côté
 * Android) et ceux de l'interface. Dessinés ici pour ne dépendre d'aucune police d'icônes.
 */
const PATHS: Record<string, string[]> = {
  terminal: ["M4 17l6-5-6-5", "M12 19h8"],
  read: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5", "M9 13h6", "M9 17h4"],
  search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M20 20l-4-4"],
  write: ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"],
  web: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M3 12h18", "M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"],
  skill: ["M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z", "M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"],
  memory: ["M9 18h6", "M10 21h4", "M12 3a6 6 0 0 0-3.6 10.8c.6.5 1.1 1.3 1.1 2.2h5c0-.9.5-1.7 1.1-2.2A6 6 0 0 0 12 3z"],
  code: ["M16 18l6-6-6-6", "M8 6l-6 6 6 6"],
  delegate: ["M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M2 21a7 7 0 0 1 14 0", "M16 3.5a4 4 0 0 1 0 7", "M22 21a7 7 0 0 0-4-6.3"],
  plan: ["M10 6h10", "M10 12h10", "M10 18h10", "M3.5 6l1.5 1.5L7.5 5", "M3.5 12l1.5 1.5 2.5-2.5", "M3.5 18l1.5 1.5 2.5-2.5"],
  schedule: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"],
  vision: ["M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
  image: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z", "M21 15l-5-5L5 21"],
  audio: ["M4 10v4", "M8 6v12", "M12 3v18", "M16 8v8", "M20 11v2"],
  send: ["M22 2L11 13", "M22 2l-7 20-4-9-9-4z"],
  tool: [
    "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z",
  ],
  // Interface
  chevron: ["M6 9l6 6 6-6"],
  arrowUp: ["M12 19V5", "M5 12l7-7 7 7"],
  plus: ["M12 5v14", "M5 12h14"],
  more: [],
  stop: [],
  check: ["M20 6L9 17l-5-5"],
  checkCircle: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M8 12l3 3 5-6"],
  xCircle: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M15 9l-6 6", "M9 9l6 6"],
  alert: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 8v4", "M12 16h.01"],
  download: ["M12 3v12", "M7 10l5 5 5-5", "M5 21h14"],
  play: [],
  pause: [],
  logout: ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5", "M21 12H9"],
  close: ["M18 6L6 18", "M6 6l12 12"],
  hand: [
    "M18 11V6a2 2 0 0 0-4 0v5",
    "M14 10V4a2 2 0 0 0-4 0v6",
    "M10 10.5V6a2 2 0 0 0-4 0v8",
    "M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15",
  ],
};

/** Formes pleines (lecture, pause, stop, points de suspension). */
const FILLED: Record<string, JSX.Element> = {
  play: <path d="M8 5.5v13a1 1 0 0 0 1.5.9l10.2-6.5a1 1 0 0 0 0-1.8L9.5 4.6A1 1 0 0 0 8 5.5z" />,
  pause: (
    <>
      <rect x="6" y="5" width="4" height="14" rx="1.2" />
      <rect x="14" y="5" width="4" height="14" rx="1.2" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2.5" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </>
  ),
};

export const TOOL_KINDS = new Set([
  "terminal", "read", "search", "write", "web", "skill", "memory", "code",
  "delegate", "plan", "schedule", "vision", "image", "audio", "send", "tool",
]);

export function Icon({ name, size = 16, class: cls }: { name: string; size?: number; class?: string }) {
  const filled = FILLED[name];
  if (filled) {
    return (
      <svg class={cls} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        {filled}
      </svg>
    );
  }
  const paths = PATHS[name] ?? PATHS.tool;
  return (
    <svg
      class={cls}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** Icône d'une famille d'outil (`kind` envoyé par le gateway), « tool » par défaut. */
export function KindIcon({ kind, size = 14 }: { kind: string; size?: number }) {
  return <Icon name={TOOL_KINDS.has(kind) ? kind : "tool"} size={size} />;
}
