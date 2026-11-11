import type { SpeciesId } from "./types";

/** Logos explicites : les 7 portraits de Friday ; "default" garde l'icône de la mascotte. */
const LOGOS = ["blue", "lavender", "teal", "pink", "peach", "white", "office"];

/**
 * Le logo de l'onglet et de la PWA suit le personnage de l'agent ouvert, puis le logo choisi
 * sur le téléphone pour Nova (friday #211). Un manifeste par espèce et par logo, fixes dans
 * public/ : le navigateur lit celui que désigne la page au moment d'installer.
 */
export function setAppIcon(species: SpeciesId, launcherIcon?: string): void {
  const set = (rel: string, href: string) => document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`)?.setAttribute("href", href);
  const logo = species === "nova" && launcherIcon !== undefined && LOGOS.includes(launcherIcon) ? launcherIcon : null;
  const icon = logo === null ? species : `nova-${logo}`;
  set("icon", `/icons/${icon}-192.png`);
  set("apple-touch-icon", `/icons/${icon}-192.png`);
  set("manifest", `/manifest-${icon}.webmanifest`);
}
