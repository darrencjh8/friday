import DOMPurify from "dompurify";
import { Marked } from "marked";
import { useMemo } from "preact/hooks";
import { t } from "./strings";

/**
 * Markdown complet des réponses de l'agent : `marked` (GFM, retours à la ligne simples conservés)
 * puis `DOMPurify`. Le texte vient d'un modèle, donc de n'importe où : rien n'est inséré sans
 * passer par le nettoyage.
 */

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // Bloc de code avec son bouton « Copier » (géré par délégation dans <Markdown>).
    code({ text, lang }) {
      const language = (lang || "").match(/^\S*/)?.[0] ?? "";
      return (
        `<div class="md-code">` +
        `<div class="md-code-bar"><span>${escapeHtml(language)}</span>` +
        `<button type="button" class="md-copy" data-copy>${escapeHtml(t.copy)}</button></div>` +
        `<pre><code>${escapeHtml(text)}</code></pre></div>`
      );
    },
  },
});

// Tous les liens s'ouvrent dans un nouvel onglet, sans transmettre l'origine ni l'accès à la page.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.hasAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"], FORBID_TAGS: ["style", "form", "input"] });
}

function onCopyClick(e: MouseEvent) {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-copy]");
  if (!button) return;
  e.stopPropagation();
  const code = button.closest(".md-code")?.querySelector("code")?.textContent ?? "";
  navigator.clipboard?.writeText(code).then(() => {
    button.textContent = t.copied;
    button.classList.add("is-done");
    window.setTimeout(() => {
      button.textContent = t.copy;
      button.classList.remove("is-done");
    }, 1500);
  });
}

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div class="md" onClick={onCopyClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
