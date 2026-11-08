// Recopie les calques des mascottes depuis l'app Android (source de vérité) vers public/dots.
import { cpSync, readdirSync } from "node:fs";
import { join } from "node:path";
const src = new URL("../../app/src/main/res/drawable-nodpi/", import.meta.url);
const dst = new URL("../public/dots/", import.meta.url);
const files = readdirSync(src).filter((f) => f.startsWith("dot_") && f.endsWith(".webp"));
for (const f of files) cpSync(join(src.pathname.replace(/^\/(\w:)/, "$1"), f), join(dst.pathname.replace(/^\/(\w:)/, "$1"), f));
console.log(`${files.length} calques copiés`);
