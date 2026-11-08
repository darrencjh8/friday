import { lang } from "../i18n";

/**
 * Libellés des outils Hermes connus, comme `ToolLabels.kt` côté Android et `_TOOL_LABELS` du plugin.
 * Ne sert que si le gateway n'a pas envoyé de `label` (il le rédige normalement lui-même).
 */
const LABELS: Record<string, [en: string, fr: string]> = {
  terminal: ["Runs a command", "Exécute une commande"],
  process: ["Follows a process", "Suit un processus"],
  read_file: ["Reads a file", "Lit un fichier"],
  search_files: ["Searches files", "Cherche dans les fichiers"],
  write_file: ["Writes a file", "Écrit un fichier"],
  patch: ["Edits a file", "Modifie un fichier"],
  web_search: ["Searches the web", "Cherche sur le web"],
  web_extract: ["Reads a web page", "Lit une page web"],
  skill_view: ["Reads the skill", "Lit la skill"],
  skills_list: ["Browses its skills", "Parcourt ses skills"],
  skill_manage: ["Updates a skill", "Met à jour une skill"],
  memory: ["Memorizes", "Mémorise"],
  session_search: ["Digs through its memories", "Fouille ses souvenirs"],
  execute_code: ["Runs code", "Exécute du code"],
  delegate_task: ["Delegates to a sub-agent", "Délègue à un sous-agent"],
  todo: ["Updates its plan", "Met à jour son plan"],
  cronjob: ["Manages a scheduled task", "Gère une tâche planifiée"],
  vision_analyze: ["Analyzes an image", "Analyse une image"],
  image_generate: ["Generates an image", "Génère une image"],
  text_to_speech: ["Synthesizes speech", "Synthétise la voix"],
  send_message: ["Sends a message", "Envoie un message"],
  tool_search: ["Looks for a tool", "Cherche un outil"],
  tool_describe: ["Checks a tool", "Consulte un outil"],
  browser_request_takeover: ["Asks you to take over", "Te demande de prendre la main"],
};

const BROWSER: [string, string] = ["Browses the web", "Navigue sur le web"];

/** Libellé traduit d'un outil, null s'il est inconnu ; les autres outils `browser_*` naviguent. */
export function toolLabel(name: string): string | null {
  const pair = LABELS[name] ?? (name.startsWith("browser_") ? BROWSER : null);
  return pair ? pair[lang === "fr" ? 1 : 0] : null;
}
