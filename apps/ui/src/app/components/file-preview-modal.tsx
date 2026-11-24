import { For, Show, createMemo, onCleanup, type JSX } from "solid-js";
import { marked } from "marked";
import { X, FileText, Loader2 } from "lucide-solid";
import { usePlatform } from "../context/platform";
import { base64ToBytes } from "~/shared/util/base64-bytes";
import { uiLogError, uiLogInfo } from "../lib/log";
import OfficeInstallPanel from "./office-install-panel";
import type { OfficeInstallState } from "../lib/office-preview-install";
import { splitTrimmedBracketLabel, trimUnmatchedBracket } from "./part-view.links";
import { renderSvgFence } from "./markdown-svg-fence";
import { MAX_IMAGE_BASE64_CHARS } from "../pages/session.file-preview.images";

export type FilePreviewModalProps = {
  open: boolean;
  title: string;
  content: string | null;
  /** Data URIs for relative image links in markdown `content`, keyed by link. */
  images?: ReadonlyMap<string, string>;
  contentType?: "markdown" | "html" | "pdf" | "image" | "text" | "spreadsheet";
  loading?: boolean;
  error?: string | null;
  /** Offer, progress or outcome of installing LibreOffice for an Office file. */
  install?: OfficeInstallState | null;
  onInstallOffer?: () => void;
  onInstall?: () => void;
  onInstallRecheck?: () => void;
  onInstallDecline?: () => void;
  tone?: "light" | "dark";
  headerActions?: JSX.Element;
  onClose: () => void;
};

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

export function createPreviewRenderer(
  tone: "light" | "dark",
  { drawSvg = true, images }: { drawSvg?: boolean; images?: ReadonlyMap<string, string> } = {},
) {
  const renderer = new marked.Renderer();
  const codeBlockClass =
    tone === "dark"
      ? "bg-dls-code-block/10 border-dls-code-border/20 text-dls-text"
      : "bg-dls-surface-solid/80 border-dls-border/70 text-dls-text";
  const inlineCodeClass =
    tone === "dark"
      ? "bg-dls-code-block/15 text-dls-text"
      : "bg-dls-code-inline-bg/70 text-dls-text";

  const isSafeUrl = (url: string) => {
    const normalized = (url || "").trim().toLowerCase();
    if (normalized.startsWith("javascript:")) return false;
    if (normalized.startsWith("data:")) return normalized.startsWith("data:image/");
    return true;
  };

  renderer.html = ({ text }) => escapeHtml(text);

  renderer.code = ({ text, lang }) => {
    const language = lang || "";
    const codeBlock = `
      <div class="rounded-card border px-4 py-3 my-4 ${codeBlockClass}">
        ${
          language
            ? `<div class="text-tiny uppercase tracking-[0.2em] text-dls-muted mb-2">${escapeHtml(language)}</div>`
            : ""
        }
        <pre class="overflow-x-auto whitespace-pre text-body leading-relaxed font-mono"><code>${escapeHtml(text)}</code></pre>
      </div>
    `;
    return (drawSvg && renderSvgFence(text, language, codeBlock)) || codeBlock;
  };

  renderer.codespan = ({ text }) => {
    return `<code class="rounded-subtle px-1.5 py-0.5 text-body font-mono ${inlineCodeClass}">${escapeHtml(text)}</code>`;
  };

  // Previews show third-party files (hub skills), so images must not reach
  // plain-http hosts such as local service ports.
  const isSafeImageUrl = (url: string) => {
    const normalized = (url || "").trim().toLowerCase();
    return normalized.startsWith("https:") || normalized.startsWith("data:image/");
  };

  renderer.link = ({ href, title, text, tokens }) => {
    const rawHref = (href ?? "#").trim();
    const cleanHref = trimUnmatchedBracket(rawHref);
    const safeHref = isSafeUrl(cleanHref) ? escapeHtml(cleanHref) : "#";
    const safeTitle = title ? escapeHtml(title) : "";
    const { label, trailing } = splitTrimmedBracketLabel(rawHref, text);
    const labelHtml = trailing ? escapeHtml(label) : renderer.parser.parseInline(tokens);
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" class="underline underline-offset-2 text-dls-accent hover:text-[var(--dls-accent-hover)]" ${safeTitle ? `title="${safeTitle}"` : ""}>${labelHtml}</a>${escapeHtml(trailing)}`;
  };

  // A loaded image is copied into the HTML at every link to it, so repeated
  // links would multiply what the loader budgeted once.
  let loadedLeft = MAX_IMAGE_BASE64_CHARS;
  renderer.image = ({ href, title, text }) => {
    const loaded = images?.get(href);
    if (loaded) {
      const base64Chars = loaded.length - loaded.indexOf(",") - 1;
      if (base64Chars > loadedLeft) return escapeHtml(text || "");
      loadedLeft -= base64Chars;
    }
    const src = loaded ?? href;
    const safeHref = isSafeImageUrl(src) ? escapeHtml(src) : "";
    // An empty src requests the current document. Skip the tag when the url
    // is rejected or was not loaded, and keep the alt text as plain content.
    if (!safeHref) return escapeHtml(text || "");
    const safeTitle = title ? escapeHtml(title) : "";
    return `<img src="${safeHref}" alt="${escapeHtml(text || "")}" ${safeTitle ? `title="${safeTitle}"` : ""} loading="lazy" decoding="async" class="max-w-full h-auto rounded-control my-4" />`;
  };

  return renderer;
}

export default function FilePreviewModal(props: FilePreviewModalProps) {
  const platform = usePlatform();
  const tone = () => props.tone ?? "light";
  const contentType = () => props.contentType ?? "markdown";
  const isHtml = () => contentType() === "html";
  const isPdf = () => contentType() === "pdf";
  const isImage = () => contentType() === "image";
  const isText = () => contentType() === "text";
  const isSpreadsheet = () => contentType() === "spreadsheet";

  // Spreadsheet content is a JSON-encoded string[][] of rows (see session.tsx),
  // rendered as a real <table> via <For> rather than innerHTML so cell values
  // are always text-escaped, never interpreted as markup.
  const spreadsheetRows = createMemo<string[][]>(() => {
    if (!isSpreadsheet()) return [];
    const content = props.content;
    if (!content) return [];
    try {
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  const renderedHtml = createMemo(() => {
    const content = props.content;
    if (!content?.trim()) return "";
    if (isPdf() || isImage() || isText() || isSpreadsheet()) return "";
    try {
      const renderer = createPreviewRenderer(tone(), { images: props.images });
      const result = marked.parse(content, {
        breaks: true,
        gfm: true,
        renderer,
        async: false,
      });
      return typeof result === "string" ? result : "";
    } catch {
      return "";
    }
  });

  const pdfBlobUrl = createMemo(() => {
    if (!isPdf()) return null;
    const base64 = props.content;
    if (!base64) return null;
    try {
      // Timed because this runs on the UI thread while the modal already shows
      // a spinner: for a large office->PDF conversion the payload can be
      // hundreds of KB of base64, and this decode was previously a per-byte
      // charCodeAt loop. The log makes the client-side share of a slow preview
      // measurable alongside the server's office-preview.completed timings.
      const startedAt = performance.now();
      const bytes = base64ToBytes(base64);
      const decodeMs = performance.now() - startedAt;
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      uiLogInfo("preview.pdf.decode", "Decoded PDF preview payload", {
        base64Bytes: base64.length,
        pdfBytes: bytes.byteLength,
        decodeMs: Math.round(decodeMs),
        blobMs: Math.round(performance.now() - startedAt - decodeMs),
      });
      return url;
    } catch (error) {
      uiLogError("preview.pdf.decode", "Failed to decode PDF preview payload", {
        base64Bytes: base64.length,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  });

  // Revoke blob URL when it changes or component unmounts
  let lastBlobUrl: string | null = null;
  createMemo(() => {
    const url = pdfBlobUrl();
    if (lastBlobUrl && lastBlobUrl !== url) {
      URL.revokeObjectURL(lastBlobUrl);
    }
    lastBlobUrl = url;
  });
  onCleanup(() => {
    if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
  });

  const handleBackdropClick = (event: MouseEvent) => {
    if (event.target === event.currentTarget) {
      props.onClose();
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      props.onClose();
    }
  };

  const handleMarkdownClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const anchor = target.closest("a");
    if (!(anchor instanceof HTMLAnchorElement)) return;

    event.preventDefault();
    event.stopPropagation();

    const href = anchor.getAttribute("href")?.trim();
    if (!href) return;
    if (!/^(https?|mailto|tel):/i.test(href)) return;
    platform.openLink(href);
  };

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-[60] dls-modal-backdrop flex items-center justify-center p-4"
        onClick={handleBackdropClick}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
        ref={(el) => el.focus()}
      >
        <div
          class="border w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col dls-modal-surface"
          onClick={(event) => event.stopPropagation()}
        >
          {/* Header */}
          <div class="flex items-center justify-between border-b border-dls-border px-5 py-3 shrink-0">
            <div class="flex items-center gap-2 min-w-0">
              <FileText size={16} class="text-dls-secondary shrink-0" />
              <span class="text-body-lg font-semibold text-dls-text truncate">
                {props.title}
              </span>
              <Show when={(isHtml() || isPdf() || isImage() || isSpreadsheet()) && !props.error}>
                <span class="shrink-0 rounded-control border border-dls-border bg-dls-surface-raised px-1.5 py-0.5 text-tiny font-mono text-dls-secondary">
                  {isPdf() ? "PDF" : isHtml() ? "HTML" : isSpreadsheet() ? "XLSX" : "IMG"}
                </span>
              </Show>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              {props.headerActions}
              <button
                data-testid="close-file-preview-btn"
                type="button"
                class="h-8 w-8 flex items-center justify-center rounded-control text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors"
                onClick={props.onClose}
                aria-label="Close preview"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {/* Body */}
          <div class="flex-1 overflow-y-auto px-6 py-5">
            <Show when={props.loading}>
              <div class="flex items-center justify-center py-12 gap-2 text-dls-secondary">
                <Loader2 size={18} class="animate-spin" />
                <span class="text-body-lg">Loading...</span>
              </div>
            </Show>

            <Show when={props.error && !props.install}>
              <div class="text-center py-12 text-body-lg text-dls-danger-text">
                {props.error}
              </div>
            </Show>

            <Show when={props.install}>
              {(state) => (
                <OfficeInstallPanel
                  state={state()}
                  unavailableMessage={props.error ?? null}
                  onOffer={() => props.onInstallOffer?.()}
                  onInstall={() => props.onInstall?.()}
                  onRecheck={() => props.onInstallRecheck?.()}
                  onDecline={() => props.onInstallDecline?.()}
                />
              )}
            </Show>

            <Show when={!props.loading && !props.error && props.content}>
              {/* PDF: render via blob URL in embed */}
              <Show when={isPdf()}>
                <Show
                  when={pdfBlobUrl()}
                  fallback={
                    <div class="text-center py-12 text-body-lg text-dls-danger-text">
                      Unable to decode PDF content.
                    </div>
                  }
                >
                  {(url) => (
                    // Rendered in an iframe (not <object>) because the app CSP
                    // sets object-src 'none'; frame-src allows blob: so the
                    // webview's built-in PDF viewer can display it.
                    <iframe
                      src={`${url()}#toolbar=1&navpanes=0`}
                      title={props.title}
                      class="w-full rounded-inset border border-dls-border"
                      style={{ height: "70vh" }}
                    />
                  )}
                </Show>
              </Show>
              {/* HTML: fully sandboxed iframe — agent-written HTML must not run script */}
              <Show when={isHtml()}>
                <iframe
                  srcdoc={props.content ?? ""}
                  sandbox=""
                  title={props.title}
                  class="w-full rounded-inset border border-dls-border"
                  style={{ height: "70vh" }}
                />
              </Show>
              <Show when={isImage()}>
                <div class="flex items-center justify-center py-4">
                  <img
                    src={props.content ?? ""}
                    alt={props.title}
                    class="max-w-full max-h-[70vh] rounded-inset border border-dls-border object-contain"
                  />
                </div>
              </Show>
              <Show when={isText()}>
                <pre class="whitespace-pre-wrap wrap-break-word text-body leading-relaxed font-mono text-dls-text">{props.content}</pre>
              </Show>
              <Show when={isSpreadsheet()}>
                <Show
                  when={spreadsheetRows().length > 0}
                  fallback={
                    <div class="text-center py-12 text-body-lg text-dls-danger-text">
                      Unable to parse spreadsheet content.
                    </div>
                  }
                >
                  <div class="overflow-auto max-h-[70vh] rounded-inset border border-dls-border">
                    <table class="w-full border-collapse text-caption">
                      <For each={spreadsheetRows()}>
                        {(row, rowIndex) => (
                          <tr>
                            <For each={row}>
                              {(cell) =>
                                rowIndex() === 0 ? (
                                  <th class="text-left border border-dls-border px-2 py-1.5 bg-dls-surface font-semibold whitespace-nowrap">
                                    {cell}
                                  </th>
                                ) : (
                                  <td class="border border-dls-border px-2 py-1.5 whitespace-nowrap">
                                    {cell}
                                  </td>
                                )
                              }
                            </For>
                          </tr>
                        )}
                      </For>
                    </table>
                  </div>
                </Show>
              </Show>
              <Show when={!isHtml() && !isPdf() && !isImage() && !isText() && !isSpreadsheet()}>
                <div
                  class="prose prose-sm max-w-none text-dls-text leading-relaxed
                    [&_h1]:text-display [&_h1]:mt-6 [&_h1]:mb-3
                    [&_h2]:text-heading [&_h2]:mt-5 [&_h2]:mb-2
                    [&_h3]:text-title [&_h3]:leading-title [&_h3]:mt-4 [&_h3]:mb-2
                    [&_p]:type-markdown-body [&_p]:mb-3
                    [&_ul]:my-2 [&_ul]:ml-4 [&_ul]:list-disc
                    [&_ol]:my-2 [&_ol]:ml-4 [&_ol]:list-decimal
                    [&_li]:mb-1
                    [&_blockquote]:border-l-3 [&_blockquote]:border-dls-border [&_blockquote]:pl-4 [&_blockquote]:my-3 [&_blockquote]:text-dls-secondary [&_blockquote]:italic
                    [&_hr]:my-6 [&_hr]:border-dls-border
                    [&_table]:w-full [&_table]:my-4 [&_table]:border-collapse
                    [&_th]:text-left [&_th]:border [&_th]:border-dls-border [&_th]:px-3 [&_th]:py-2 [&_th]:bg-dls-surface [&_th]:text-body-lg [&_th]:font-semibold
                    [&_td]:border [&_td]:border-dls-border [&_td]:px-3 [&_td]:py-2 [&_td]:text-body-lg
                  "
                  innerHTML={renderedHtml()}
                  onClick={handleMarkdownClick}
                />
              </Show>
            </Show>

            <Show when={!props.loading && !props.error && !props.install && !props.content}>
              <div class="text-center py-12 text-body-lg text-dls-secondary">
                No content available.
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}