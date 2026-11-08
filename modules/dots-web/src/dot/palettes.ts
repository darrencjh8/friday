import type { PaletteId } from "../types";

/** Les six couleurs de l'app (ui/theme/Color.kt, DotPalettes). */
export interface DotPalette {
  id: PaletteId;
  base: string;
  deep: string;
  light: string;
  onBase: string;
}

export const PALETTES: Record<PaletteId, DotPalette> = {
  tangerine: { id: "tangerine", base: "#ff8a3d", deep: "#e5611c", light: "#ffede0", onBase: "#ffffff" },
  bubblegum: { id: "bubblegum", base: "#ff5fa2", deep: "#dd3a80", light: "#ffe6f0", onBase: "#ffffff" },
  sky: { id: "sky", base: "#2f8cff", deep: "#1764d6", light: "#e3eeff", onBase: "#ffffff" },
  lime: { id: "lime", base: "#9ad83a", deep: "#6aae18", light: "#eff8de", onBase: "#1f3300" },
  sun: { id: "sun", base: "#ffc531", deep: "#e29e00", light: "#fff5d9", onBase: "#3b2800" },
  grape: { id: "grape", base: "#8e6bff", deep: "#6844e8", light: "#eee8ff", onBase: "#ffffff" },
};

export function palette(id: string | undefined): DotPalette {
  return PALETTES[(id as PaletteId) ?? "tangerine"] ?? PALETTES.tangerine;
}

/** Variables CSS d'une palette, à poser en `style` sur un conteneur (le web n'a que le thème clair). */
export function paletteStyle(id: string | undefined): Record<string, string> {
  const p = palette(id);
  return { "--dot-base": p.base, "--dot-deep": p.deep, "--dot-light": p.light, "--dot-on-base": p.onBase };
}
