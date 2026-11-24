import { attachmentKind } from "./attachment-type";

export type ImageMention = { path: string; name: string; span: HTMLElement };

/**
 * Reports the editor's @-mentioned images and hides their inline pills, so each is drawn as a
 * card above the text. The pill stays in the editor: it is what sends the `@path`.
 */
export const watchImageMentions = (
  editor: HTMLElement,
  onChange: (mentions: ImageMention[]) => void,
) => {
  let current: HTMLElement[] = [];
  const sync = () => {
    const spans = Array.from(editor.querySelectorAll<HTMLElement>('[data-mention-kind="file"]')).filter(
      (span) => attachmentKind(span.dataset.mentionValue ?? "") === "image",
    );
    if (spans.length === current.length && spans.every((span, index) => span === current[index])) return;
    current = spans;
    onChange(
      spans.map((span) => {
        // Inline, because the pill's own `inline-flex` class would otherwise compete with `hidden`.
        span.style.display = "none";
        const path = span.dataset.mentionValue ?? "";
        const label = span.dataset.mentionLabel || path;
        return { path, name: label.split(/[\\/]/).pop() || label, span };
      }),
    );
  };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(editor, { childList: true, subtree: true });
  return () => observer.disconnect();
};

/** Removes an image mention and the space typed after it. */
export const removeImageMention = (mention: ImageMention) => {
  const next = mention.span.nextSibling;
  if (next !== null && next.nodeType === Node.TEXT_NODE && /^[ \u00a0]$/.test(next.textContent ?? "")) next.remove();
  mention.span.remove();
};
