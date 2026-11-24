import { createRoot } from "solid-js";
import { ATTACHMENT_KIND_ICON, attachmentKind, attachmentKindLabel } from "./attachment-type";

/** The chat chip's type icon as a detached element, for chips built outside JSX. */
export const fileMentionIcon = (filename: string): Node | null => {
  const Icon = ATTACHMENT_KIND_ICON[attachmentKind(filename)];
  // The icon is static, so its owner can be disposed as soon as the element exists.
  const element: unknown = createRoot((dispose) => {
    const node = <Icon size={12} class="shrink-0 text-dls-secondary" />;
    dispose();
    return node;
  });
  return element instanceof Node ? element : null;
};

/** The chat chip's friendly type label ("Markdown", "Word document", …). */
export const fileMentionTypeLabel = (filename: string) =>
  attachmentKindLabel(attachmentKind(filename));
