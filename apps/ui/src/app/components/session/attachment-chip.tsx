import { Show, createResource, createSignal } from "solid-js";
import { Dynamic } from "solid-js/web";
import { FolderOpen, X } from "lucide-solid";
import { t } from "../../../i18n";
import { formatBytes } from "~/shared/util/format";
import { isWorkspaceFilePreviewable } from "../../lib/workspace-file-preview";
import {
  FOLDER_MIME,
  attachmentLocalPath,
  isInlineAttachmentUrl,
  type MessageAttachment,
} from "./message-attachments";
import {
  ATTACHMENT_KIND_ICON,
  attachmentKind,
  attachmentKindLabel,
} from "./attachment-type";
import { FILE_MENTION_CLASS, FILE_MENTION_TYPE_CLASS } from "./composer.editor";

export type AttachmentChipProps = {
  filename: string;
  mime: string;
  /** A loadable image URL (data:/blob:); a local path cannot be shown by the webview. */
  thumbnailUrl?: string;
  /** Asked once for an image with no `thumbnailUrl`; until it answers, the type icon shows. */
  loadThumbnail?: () => Promise<string | null>;
  onThumbnailError?: () => void;
  /** Asked once for the byte size shown beside the type. */
  loadSize?: () => Promise<number | null>;
  onOpen?: () => void;
  /** Accessible name of the `onOpen` action; defaults to opening a preview. */
  openLabel?: string;
  onReveal?: () => void;
};

export function AttachmentChip(props: AttachmentChipProps) {
  const kind = () => attachmentKind(props.filename, props.mime);
  const [loadedSize] = createResource(() => props.loadSize, (load) => load());
  const thumbnailLoader = () =>
    props.thumbnailUrl === undefined && kind() === "image" ? props.loadThumbnail : undefined;
  const [loadedThumbnail] = createResource(thumbnailLoader, (load) => load());
  // A resource keeps its last value after its source is withdrawn (e.g. on a decode error).
  const thumbnail = () =>
    props.thumbnailUrl ?? (thumbnailLoader() ? loadedThumbnail() : undefined) ?? undefined;
  const typeLabel = () => {
    const label = attachmentKindLabel(kind());
    const size = loadedSize();
    return typeof size === "number" ? `${label}, ${formatBytes(size)}` : label;
  };
  const iconButtonClass =
    "shrink-0 rounded-compact p-1 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text";

  return (
    <div
      data-testid="attachment-chip"
      class="flex max-w-[280px] items-center gap-1 rounded-field border border-dls-border bg-dls-surface p-1.5 text-label shadow-[var(--dls-card-shadow)]"
    >
      <Dynamic
        component={props.onOpen ? "button" : "div"}
        type={props.onOpen ? "button" : undefined}
        class={`flex min-w-0 flex-1 items-center gap-2.5 rounded-inset py-1 pl-1 pr-3 text-left ${props.onOpen ? "transition-colors hover:bg-dls-hover" : ""}`}
        aria-label={
          props.onOpen
            ? `${props.openLabel ?? t("composer.attachment_open")}: ${props.filename}`
            : undefined
        }
        onClick={() => props.onOpen?.()}
      >
        <Show
          when={thumbnail()}
          fallback={
            <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-inset border border-dls-border bg-dls-sidebar text-dls-secondary">
              <Dynamic component={ATTACHMENT_KIND_ICON[kind()]} size={16} />
            </div>
          }
        >
          {(url) => (
            <div class="h-9 w-9 shrink-0 overflow-hidden rounded-inset border border-dls-border bg-dls-sidebar">
              <img
                src={url()}
                alt={props.filename}
                loading="lazy"
                decoding="async"
                class="h-full w-full object-cover"
                onError={() => props.onThumbnailError?.()}
              />
            </div>
          )}
        </Show>
        <div class="min-w-0">
          <div class="truncate leading-tight text-dls-text" title={props.filename}>
            {props.filename}
          </div>
          <div class="mt-0.5 truncate leading-tight text-tiny text-dls-muted">
            {typeLabel()}
          </div>
        </div>
      </Dynamic>
      <Show when={props.onReveal}>
        <button
          type="button"
          class={iconButtonClass}
          title={t("composer.attachment_reveal")}
          aria-label={`${t("composer.attachment_reveal")}: ${props.filename}`}
          onClick={() => props.onReveal?.()}
        >
          <FolderOpen size={14} />
        </button>
      </Show>
    </div>
  );
}

/** A composer attachment drawn as the `@` file pill (`createMentionSpan`), with a remove button. */
export function CompactAttachmentChip(props: { filename: string; mime: string; onRemove: () => void }) {
  const kind = () => attachmentKind(props.filename, props.mime);
  return (
    <span data-testid="attachment-chip" class={FILE_MENTION_CLASS} title={props.filename}>
      <Dynamic component={ATTACHMENT_KIND_ICON[kind()]} size={12} class="shrink-0 text-dls-secondary" />
      <span class="truncate">{props.filename}</span>
      <span class={FILE_MENTION_TYPE_CLASS}>· {attachmentKindLabel(kind())}</span>
      <button
        type="button"
        class="-mr-0.5 shrink-0 rounded-compact p-0.5 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
        aria-label={`${t("composer.attachment_remove")}: ${props.filename}`}
        onClick={() => props.onRemove()}
      >
        <X size={12} />
      </button>
    </span>
  );
}

/** A composer image: a 40 px thumbnail, the name, "Image" and remove. */
export function ComposerImageCard(props: {
  name: string;
  thumbnailUrl?: string;
  /** Asked once when there is no `thumbnailUrl`; until it answers, the image icon shows. */
  loadThumbnail?: () => Promise<string | null>;
  onRemove: () => void;
}) {
  const [loaded] = createResource(() => (props.thumbnailUrl ? undefined : props.loadThumbnail), (load) => load());
  const [failed, setFailed] = createSignal(false);
  const url = () => (failed() ? undefined : (props.thumbnailUrl ?? loaded() ?? undefined));
  return (
    <div
      data-testid="attachment-chip"
      class="flex items-center gap-2 rounded-card border border-dls-border bg-dls-hover px-3 py-2 text-caption text-dls-secondary"
    >
      <div class="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-inset border border-dls-border bg-dls-surface">
        <Show when={url()} fallback={<Dynamic component={ATTACHMENT_KIND_ICON.image} size={16} />}>
          {(src) => (
            <img src={src()} alt={props.name} decoding="async" class="h-full w-full object-cover" onError={() => setFailed(true)} />
          )}
        </Show>
      </div>
      <div class="max-w-[160px]">
        <div class="truncate text-dls-secondary" title={props.name}>
          {props.name}
        </div>
        <div class="text-tiny text-dls-secondary">{t("composer.attachment_image")}</div>
      </div>
      <button
        type="button"
        class="ml-1 rounded-pill p-1 text-dls-secondary hover:bg-dls-active hover:text-dls-text"
        aria-label={`${t("composer.attachment_remove")}: ${props.name}`}
        onClick={() => props.onRemove()}
      >
        <X size={12} />
      </button>
    </div>
  );
}

/** A transcript attachment: inline uploads show their own thumbnail; local files open, reveal, and load their size and image thumbnail. */
export function MessageAttachmentChip(props: {
  attachment: MessageAttachment;
  thumbnailFailed: boolean;
  onThumbnailError: () => void;
  onPreviewFile?: (path: string) => void;
  onRevealFile?: (path: string) => void;
  resolveFileSize?: (path: string) => Promise<number | null>;
  resolveImageThumbnail?: (path: string) => Promise<string | null>;
}) {
  const localPath = () => attachmentLocalPath(props.attachment);
  const isFolder = () => props.attachment.mime === FOLDER_MIME;
  const isFile = () => localPath() !== null && !isFolder();
  const withPath = <T,>(handler: ((path: string) => T) | undefined, when: boolean) => {
    const path = localPath();
    return handler && when && path !== null ? () => handler(path) : undefined;
  };

  return (
    <AttachmentChip
      filename={props.attachment.filename}
      mime={props.attachment.mime}
      thumbnailUrl={
        isInlineAttachmentUrl(props.attachment.url) &&
        props.attachment.mime.startsWith("image/") &&
        !props.thumbnailFailed
          ? props.attachment.url
          : undefined
      }
      loadThumbnail={withPath(props.resolveImageThumbnail, isFile() && !props.thumbnailFailed)}
      onThumbnailError={props.onThumbnailError}
      loadSize={withPath(props.resolveFileSize, isFile())}
      onOpen={
        isFolder()
          ? withPath(props.onRevealFile, true)
          : withPath(
              props.onPreviewFile,
              isFile() && isWorkspaceFilePreviewable(props.attachment.filename, "projects"),
            )
      }
      openLabel={isFolder() ? t("composer.attachment_reveal") : undefined}
      onReveal={withPath(props.onRevealFile, !isFolder())}
    />
  );
}
