import type { SpeciesId } from "./types";

/**
 * Le logo de l'onglet et de la PWA suit le personnage de l'agent ouvert. Un manifeste par espèce,
 * fixes dans public/ : le navigateur lit celui que désigne la page au moment d'installer.
 */
export function setAppIcon(species: SpeciesId): void {
  const set = (rel: string, href: string) => document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`)?.setAttribute("href", href);
  set("icon", `/icons/${species}-192.png`);
  set("apple-touch-icon", `/icons/${species}-192.png`);
  set("manifest", `/manifest-${species}.webmanifest`);
}
