import type { SpeciesId, WebAgent } from "./types";

/** Le nom de l'app suit le premier agent appairé, "Hermes" avant tout appairage. */
export function appName(agents: WebAgent[]): string {
  return agents[0]?.name || "Hermes";
}

/** Logos explicites : les 7 portraits de Friday ; "default" prend la silhouette blanche de l'icône de l'appli. */
const LOGOS = ["blue", "lavender", "teal", "pink", "peach", "white", "office"];

/**
 * Le logo de l'onglet et de la PWA suit le personnage de l'agent ouvert, puis le logo choisi
 * sur le téléphone pour Nova (friday #211). Un manifeste par espèce et par logo, fixes dans
 * public/ : le navigateur lit celui que désigne la page au moment d'installer.
 * Le nom du manifeste suit le premier agent (friday #212) via ?name=.
 */
export function setAppIcon(species: SpeciesId, launcherIcon?: string, name = "Hermes"): void {
  const set = (rel: string, href: string) => document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`)?.setAttribute("href", href);
  const logo = species === "nova" && launcherIcon !== undefined && LOGOS.includes(launcherIcon) ? launcherIcon : null;
  const icon = logo !== null ? `nova-${logo}` : species === "nova" && launcherIcon === "default" ? "nova-default" : species;
  set("icon", `/icons/${icon}-192.png`);
  set("apple-touch-icon", `/icons/${icon}-192.png`);
  set("manifest", `/manifest-${icon}.webmanifest?name=${encodeURIComponent(name)}`);
}
