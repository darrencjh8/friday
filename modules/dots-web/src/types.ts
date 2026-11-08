/**
 * Types partagés par l'appairage et le chat.
 *
 * Un agent web, c'est ce que le téléphone a transmis par le QR code : l'adresse du gateway, un jeton
 * propre à ce navigateur (jamais le DOTS_TOKEN) et l'apparence choisie dans l'app.
 */

export type SpeciesId = "galet" | "nuage" | "pave";
export type PaletteId = "tangerine" | "bubblegum" | "sky" | "lime" | "sun" | "grape";
export type AccessoryId = "winged_cap" | "none";

export interface WebAgent {
  /** Adresse WebSocket du gateway, `wss://…/dots/ws`. */
  url: string;
  /** Jeton web émis par le gateway pour ce navigateur, révocable depuis le téléphone. */
  token: string;
  /** Id de la session web côté gateway (pour se déconnecter : `web_revoke`). */
  session_id: string;
  /** Identifiant stable de l'agent annoncé par le gateway, null pour un plugin d'avant 1.2. */
  agent_id: string | null;
  name: string;
  species: SpeciesId;
  palette: PaletteId;
  accessory: AccessoryId;
}

/** Contenu déchiffré d'un dépôt d'appairage (voir docs/appairage-web.md). */
export interface PairingPayload {
  v: 1;
  agents: WebAgent[];
  lang?: string;
  issued_at?: number;
}
