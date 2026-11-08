/**
 * Anglais et français, comme l'app : la langue suit celle du navigateur, l'anglais par défaut.
 * Chaque module déclare ses propres textes avec `strings({ en: {...}, fr: {...} })`.
 */
export type Lang = "en" | "fr";

export const lang: Lang = (navigator.language || "en").toLowerCase().startsWith("fr") ? "fr" : "en";

document.documentElement.lang = lang;

export function strings<T extends Record<string, string | ((...args: any[]) => string)>>(table: { en: T; fr: T }): T {
  return table[lang];
}
