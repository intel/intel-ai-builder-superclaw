import { marked } from "marked";
import { renderSvgFence } from "./markdown-svg-fence";
import { BARE_FILENAME_RE, classifyLinkTarget, displayFilePath, escapeHtml, renderInlineTextWithLinks, splitTrimmedBracketLabel } from "./part-view.links";

export const MARKDOWN_CACHE_MAX_ENTRIES = 100;

export const LARGE_TEXT_COLLAPSE_CHAR_THRESHOLD = 12_000;

export const LARGE_TEXT_PREVIEW_CHARS = 3_200;

export const markdownHtmlCache = new Map<string, string>();

export const expandedLargeTextPartIds = new Set<string>();

export const rendererByTone = new Map<
  "light" | "dark",
  ReturnType<typeof createCustomRenderer>
>();

export function markdownCacheKey(tone: "light" | "dark", text: string) {
  return `${tone}\u0000${text}`;
}

export function readMarkdownCache(key: string) {
  const cached = markdownHtmlCache.get(key);
  if (cached === undefined) return;
  markdownHtmlCache.delete(key);
  markdownHtmlCache.set(key, cached);
  return cached;
}

export function writeMarkdownCache(key: string, html: string) {
  if (markdownHtmlCache.has(key)) {
    markdownHtmlCache.delete(key);
  }
  markdownHtmlCache.set(key, html);

  while (markdownHtmlCache.size > MARKDOWN_CACHE_MAX_ENTRIES) {
    const oldest = markdownHtmlCache.keys().next().value;
    if (!oldest) break;
    markdownHtmlCache.delete(oldest);
  }
}

export function rendererForTone(tone: "light" | "dark") {
  const cached = rendererByTone.get(tone);
  if (cached) return cached;
  const next = createCustomRenderer(tone);
  rendererByTone.set(tone, next);
  return next;
}

const escapeLabel = (value: string) =>
  escapeHtml(value).replace(/&amp;(#\d+;|#x[0-9a-f]+;|[a-z][a-z0-9]*;)/gi, "&$1");

export function createCustomRenderer(tone: "light" | "dark") {
  const renderer = new marked.Renderer();
  const codeBlockClass =
    tone === "dark"
      ? "bg-dls-code-block/10 border-dls-code-border/20 text-dls-text"
      : "bg-dls-surface-solid/80 border-dls-border/70 text-dls-text";
  const inlineCodeClass =
    tone === "dark"
      ? "bg-dls-code-block/15 text-dls-text"
      : "bg-dls-code-inline-bg/70 text-dls-text";

  const isSafeImgUrl = (url: string) => {
    const normalized = (url || "").trim().toLowerCase();
    // A blank src, including one that is only spaces, requests the current document.
    if (!normalized) return false;
    if (normalized.startsWith("javascript:")) return false;
    // Allow data:image/* URIs (base64-encoded images from AI models) but block
    // other data: schemes (e.g. data:text/html) which could be used for XSS.
    if (normalized.startsWith("data:"))
      return normalized.startsWith("data:image/");
    return true;
  };

  renderer.html = ({ text }) => escapeHtml(text);

  renderer.text = (token) => {
    if (token.type === "text" && token.tokens && token.tokens.length > 0) {
      return renderer.parser.parseInline(token.tokens);
    }
    // NOTE: Cannot pass workspaceRoot here because this renderer is cached at
    // module level (shared across all PartView instances).  The workspace filter
    // is applied later in openMarkdownLink() when the user clicks a link.
    return renderInlineTextWithLinks(token.text);
  };

  renderer.code = ({ text, lang }) => {
    const language = lang || "";
    const codeBlock = `
      <div class="rounded-card border px-4 py-3 my-4 ${codeBlockClass}">
        ${
          language
            ? `<div class="text-tiny uppercase tracking-[0.2em] text-dls-muted mb-2">${escapeHtml(language)}</div>`
            : ""
        }
        <pre class="overflow-x-auto whitespace-pre text-body leading-relaxed font-mono"><code>${escapeHtml(
          text,
        )}</code></pre>
      </div>
    `;
    return renderSvgFence(text, language, codeBlock) ?? codeBlock;
  };

  renderer.codespan = ({ text }) => {
    const target = classifyLinkTarget(text);
    const displayText = displayFilePath(text);
    if (target?.type === "file" && displayText !== text) {
      return `<a href="#" data-file-href="${escapeHtml(target.href)}" class="rounded-control px-1.5 py-0.5 text-body font-mono underline underline-offset-2 text-[color:var(--dls-link)] hover:text-[color:var(--dls-link-hover)] ${inlineCodeClass}">${escapeHtml(displayText)}</a>`;
    }
    return `<code class="rounded-control px-1.5 py-0.5 text-body font-mono ${inlineCodeClass}">${escapeHtml(
      text,
    )}</code>`;
  };

  renderer.link = ({ href, title, text }) => {
    // `text` is the raw label source, so escape it before it reaches innerHTML,
    // keeping character references the author wrote (`&amp;` shows as `&`).
    const safeText = escapeLabel(text);
    const rawHref = (href ?? "").trim();
    if (!rawHref || rawHref === "#") {
      return safeText;
    }
    const numericAutolink =
      /^[\d.]+\/\d+$/.test(text) || /^v?\d[\d.]*\/\d[\d.]*$/.test(text);
    if (numericAutolink) {
      return safeText;
    }
    const target = classifyLinkTarget(rawHref);
    if (!target) {
      /* classifyLinkTarget skips bare filenames (isBareRelativeFilePath is disabled globally
       to prevent false positives in plain text). Explicit markdown [text](file.ext) links
       are intentional, so re-check here and treat them as file links. */
      if (
        BARE_FILENAME_RE.test(rawHref) &&
        !rawHref.includes("/") &&
        !rawHref.includes("\\")
      ) {
        return `<a href="#" data-file-href="${escapeHtml(rawHref)}" class="underline underline-offset-2 text-[color:var(--dls-link)] hover:text-[color:var(--dls-link-hover)]">${safeText}</a>`;
      }
      return `<strong>${safeText}</strong>`;
    }
    // File links are now clickable with data-file-href, matching renderInlineTextWithLinks
    if (target.type === "file") {
      return `<a href="#" data-file-href="${escapeHtml(target.href)}" class="underline underline-offset-2 text-[color:var(--dls-link)] hover:text-[color:var(--dls-link-hover)]">${safeText}</a>`;
    }
    const safeHref = escapeHtml(target.href);
    const safeTitle = title ? escapeHtml(title) : "";
    const { label, trailing } = splitTrimmedBracketLabel(rawHref, text);
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" class="underline underline-offset-2 text-[color:var(--dls-link)] hover:text-[color:var(--dls-link-hover)]"${safeTitle ? ` title="${safeTitle}"` : ""}>${escapeLabel(label)}</a>${escapeHtml(trailing)}`;
  };

  renderer.image = ({ href, title, text }) => {
    const safeHref = isSafeImgUrl(href) ? escapeHtml(href ?? "") : "";
    // An empty src requests the current document. Skip the tag when the url
    // is rejected or blank, and keep the alt text as plain content.
    if (!safeHref) return escapeHtml(text || "");
    const safeTitle = title ? escapeHtml(title) : "";
    return `
      <img
        src="${safeHref}"
        alt="${escapeHtml(text || "")}"
        ${safeTitle ? `title="${safeTitle}"` : ""}
        loading="lazy"
        decoding="async"
        class="max-w-full h-auto rounded-control my-4"
      />
    `;
  };

  return renderer;
}
