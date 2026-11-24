import { For, Show, createMemo, createSignal } from "solid-js";
import { Eye, FolderOpen, Paperclip } from "lucide-solid";
import { Tooltip } from "~/shared/ui/tooltip";
import { isWorkspaceFilePreviewable } from "../../lib/workspace-file-preview";

export type ArtifactsPanelProps = {
  files: string[];
  workspaceRoot?: string;
  onRevealArtifact?: (path: string) => void;
  onOpenInObsidian?: (path: string) => void;
  onPreview?: (path: string) => void;
  obsidianAvailable?: boolean;
  maxPreview?: number;
  id?: string;
};

const normalizePath = (value: string) => value.trim().replace(/[\\/]+/g, "/");
const splitPathSegments = (value: string) => value.split(/[/\\]/).filter(Boolean);

const toWorkspaceRelative = (file: string, root?: string) => {
  const normalizedRoot = (root ?? "").trim().replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  if (!normalizedRoot) return file;

  const normalizedFile = file.replace(/[\\/]+/g, "/");
  const rootKey = normalizedRoot.toLowerCase();
  const fileKey = normalizedFile.toLowerCase();

  if (fileKey === rootKey) return normalizedFile.split("/").pop() ?? normalizedFile;
  if (fileKey.startsWith(`${rootKey}/`)) return normalizedFile.slice(normalizedRoot.length + 1);
  return normalizedFile;
};

const getBasename = (value: string) => {
  const segments = splitPathSegments(value);
  return segments[segments.length - 1] ?? value;
};

const getDirname = (value: string) => {
  const segments = splitPathSegments(value);
  if (segments.length <= 1) return "";
  return segments.slice(0, -1).join("/");
};

const isMarkdown = (value: string) => /\.(md|mdx|markdown)$/i.test(value);
const isImage = (value: string) => /\.(png|jpe?g|gif|webp|svg)$/i.test(value);
const isHtml = (value: string) => /\.html?$/i.test(value);
const isPdf = (value: string) => /\.pdf$/i.test(value);

type ArtifactKind = "markdown" | "image" | "html" | "pdf" | "file";

const artifactKind = (value: string): ArtifactKind => {
  if (isMarkdown(value)) return "markdown";
  if (isImage(value)) return "image";
  if (isHtml(value)) return "html";
  if (isPdf(value)) return "pdf";
  return "file";
};

export default function ArtifactsPanel(props: ArtifactsPanelProps) {
  const [showAll, setShowAll] = createSignal(false);
  const maxPreview = createMemo(() => {
    const raw = props.maxPreview ?? 6;
    if (!Number.isFinite(raw)) return 6;
    return Math.min(12, Math.max(3, Math.floor(raw)));
  });

  const normalizedArtifacts = createMemo(() => {
    const out: Array<{ path: string; kind: ArtifactKind; previewable: boolean }> = [];

    for (const entry of props.files ?? []) {
      const normalized = normalizePath(String(entry ?? ""));
      if (!normalized) continue;
      const base = getBasename(normalized);
      const kind = artifactKind(base);

      out.push({
        path: normalized,
        kind,
        previewable: isWorkspaceFilePreviewable(base, "projects"),
      });
      if (out.length >= 48) break;
    }

    return out;
  });

  const visibleArtifacts = createMemo(() => {
    const list = normalizedArtifacts();
    return showAll() ? list : list.slice(0, maxPreview());
  });

  const hiddenCount = createMemo(() => {
    const total = normalizedArtifacts().length;
    const shown = visibleArtifacts().length;
    return Math.max(0, total - shown);
  });

  const canRevealArtifact = createMemo(() => typeof props.onRevealArtifact === "function");
  const canOpenObsidian = createMemo(
    () => Boolean(props.obsidianAvailable) && typeof props.onOpenInObsidian === "function",
  );
  const canPreview = createMemo(() => typeof props.onPreview === "function");
  const prettyPath = (file: string) => toWorkspaceRelative(file, props.workspaceRoot);

  return (
    <div id={props.id}>
      <div class="flex items-center justify-between mb-2">
        <span class="text-caption font-semibold text-dls-text">Artifacts</span>
        <Show when={normalizedArtifacts().length > 0}>
          <span class="text-tiny font-medium bg-dls-hover/60 text-dls-secondary px-1.5 rounded-compact">
            {normalizedArtifacts().length}
          </span>
        </Show>
      </div>

      <div class="space-y-1">
        <Show
          when={visibleArtifacts().length > 0}
          fallback={<div class="text-caption text-dls-secondary/60 italic px-2 py-1">No artifacts yet.</div>}
        >
          <For each={visibleArtifacts()}>
            {(artifact) => {
              const display = () => prettyPath(artifact.path);
              const base = () => getBasename(display());
              const dir = () => getDirname(display());
              const md = () => artifact.kind === "markdown";
              return (
                <div
                  class="group w-full flex items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors border border-transparent hover:bg-dls-hover"
                  title={display()}
                >
                  <div class="shrink-0">
                    <Paperclip size={12} class="text-dls-secondary" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <div class="truncate text-caption font-medium text-dls-text leading-tight">{base()}</div>
                    </div>
                    <Show when={dir()}>
                      <div class="truncate text-label text-dls-secondary">{dir()}</div>
                    </Show>
                  </div>
                  <div class="shrink-0 flex items-center gap-1.5">
                    <Show when={canPreview() && artifact.previewable}>
                      <Tooltip content="Preview" placement="left" maxWidthClass="max-w-[140px]">
                        <button
                          type="button"
                          class="rounded-compact p-0.5 text-dls-secondary hover:text-dls-link hover:bg-dls-hover transition-colors"
                          onClick={() => props.onPreview?.(artifact.path)}
                          aria-label="Preview"
                        >
                          <Eye size={12} />
                        </button>
                      </Tooltip>
                    </Show>
                    <Show when={md() && canOpenObsidian()}>
                      <Tooltip content="Open in Obsidian" placement="left" maxWidthClass="max-w-[140px]">
                        <button
                          type="button"
                          class="rounded-control border border-dls-border bg-dls-hover px-1.5 py-0.5 text-tiny font-medium text-dls-secondary hover:text-dls-text hover:border-dls-border transition-colors"
                          onClick={() => props.onOpenInObsidian?.(artifact.path)}
                          aria-label="Open in Obsidian"
                        >
                          Obsidian
                        </button>
                      </Tooltip>
                    </Show>
                    <Show when={canRevealArtifact()}>
                      <Tooltip content="Find in File Explorer" placement="left" maxWidthClass="max-w-[140px]">
                        <button
                          type="button"
                          class="shrink-0 rounded-compact p-0.5 text-dls-secondary hover:text-dls-link hover:bg-dls-hover transition-colors"
                          onClick={() => props.onRevealArtifact?.(artifact.path)}
                          aria-label="Find in File Explorer"
                        >
                          <FolderOpen size={12} />
                        </button>
                      </Tooltip>
                    </Show>
                  </div>
                </div>
              );
            }}
          </For>
        </Show>

        <Show when={hiddenCount() > 0}>
          <button
            type="button"
            class="w-full mt-1 rounded-control px-2 py-1.5 text-caption text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors"
            onClick={() => setShowAll((prev) => !prev)}
          >
            {showAll() ? "Show fewer" : `Show ${hiddenCount()} more`}
          </button>
        </Show>
      </div>
    </div>
  );
}