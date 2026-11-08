/**
 * Thème de ce navigateur : suit le système par défaut, ou forcé depuis le menu du chat.
 * Tout passe par `color-scheme` sur la racine : les couleurs sont des `light-dark()` (theme.css).
 */
export type ThemeMode = "system" | "light" | "dark";

const KEY = "dots.theme.v1";
const ORDER: ThemeMode[] = ["system", "light", "dark"];

export function readTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(KEY) as ThemeMode | null;
    return saved && ORDER.includes(saved) ? saved : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(mode: ThemeMode = readTheme()): void {
  document.documentElement.style.colorScheme = mode === "system" ? "" : mode;
}

/** Passe au mode suivant, le garde et l'applique. */
export function cycleTheme(current: ThemeMode): ThemeMode {
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Navigation privée : le choix vaut pour cette page seulement.
  }
  applyTheme(next);
  return next;
}
