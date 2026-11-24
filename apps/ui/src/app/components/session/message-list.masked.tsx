import { For, Show, createSignal } from "solid-js";
import type { Setter } from "solid-js";
import type { Part } from "@opencode-ai/sdk/v2/client";
import {
  ChevronDown,
  Eye,
  FolderOpen,
  ShieldCheck,
} from "lucide-solid";
import type { MessageWithParts } from "../../types";
import { isWorkspaceFilePreviewable } from "../../lib/workspace-file-preview";
import { Tooltip } from "~/shared/ui/tooltip";
import { asToolPart } from "./message-list.exploration";
import { getTaskStepInfo } from "./message-list.tool";
import {
  extractMaskingSummary,
  formatMaskingCategory,
  type MaskingSummary,
} from "./masked-file-summary";
// Re-exported from the extracted helpers so this module's public surface is unchanged.
export type { MessageListProps } from "./message-list.types";

export type MaskedFile = {
  path: string;
  fileName: string;
  dataset: string;
  runStamp: string;
  maskingSummary: MaskingSummary | null;
};

const MASKED_DATASETS_SEGMENT = "data_protection_workspace/masked_datasets/";

// subagent nesting search for masked-file output
const MAX_SCAN_DEPTH = 3;

// Max files to shown in list before dropdown
const MAX_FILES_SHOWN = 2;

// Reads the masked output of successful run_protected_file_pipeline call
export function extractMaskedFiles(part: Part): MaskedFile[] {
  const record = asToolPart(part);
  if (!record || record.tool?.toLowerCase() !== "run_protected_file_pipeline") return [];

  const output = record.state?.output;
  if (!output) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];

  const result = parsed as {
    success?: unknown;
    masked_file_path?: unknown;
    results?: unknown;
    masking_summary?: unknown;
  };

  const toMaskedFile = (
    rawPath: unknown,
    maskingSummary: unknown,
  ): MaskedFile | null => {
    if (typeof rawPath !== "string") return null;
    const normalized = rawPath.replace(/\\/g, "/").trim();
    const index = normalized.toLowerCase().indexOf(MASKED_DATASETS_SEGMENT);
    if (index === -1) return null;
    const relative = normalized.slice(index);
    const segments = relative.split("/").filter(Boolean);
    const fileName = segments[segments.length - 1];
    const runStamp = segments[segments.length - 2];
    const dataset = segments[segments.length - 3];
    if (!fileName || !runStamp || !dataset) return null;
    return {
      path: relative,
      fileName,
      dataset,
      runStamp,
      maskingSummary: extractMaskingSummary(maskingSummary),
    };
  };

  // batch response: { success, results: [...] }
  if (Array.isArray(result.results)) {
    return result.results.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const entryRecord = entry as {
        masked_file_path?: unknown;
        masking_summary?: unknown;
      };
      const hit = toMaskedFile(
        entryRecord.masked_file_path,
        entryRecord.masking_summary ?? result.masking_summary,
      );
      return hit ? [hit] : [];
    });
  }

  // single-file response: { success, masked_file_path }
  if (result.success !== true) return [];
  const hit = toMaskedFile(result.masked_file_path, result.masking_summary);
  return hit ? [hit] : [];
}

export function formatMaskedRunStamp(runStamp: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(runStamp);
  if (!match) return runStamp;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  if (Number.isNaN(date.getTime())) return runStamp;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function collectMaskedFiles(options: {
  messages: MessageWithParts[];
  getMessagesBySessionId?: (sessionId: string | null) => MessageWithParts[];
  ensureSessionLoaded?: (sessionId: string) => Promise<void> | void;
}): MaskedFile[] {
  const visited = new Set<string>();
  const all: MaskedFile[] = [];

  const scan = (messages: MessageWithParts[], depth: number) => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const parts = message?.parts ?? [];
      for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
        const part = parts[partIndex];
        all.push(...extractMaskedFiles(part));
        if (depth >= MAX_SCAN_DEPTH) continue;
        const childId = getTaskStepInfo(part).sessionId;
        if (!childId || visited.has(childId)) continue;
        visited.add(childId);
        void options.ensureSessionLoaded?.(childId);
        scan(options.getMessagesBySessionId?.(childId) ?? [], depth + 1);
      }
      if (depth === 0 && message?.info.role === "user") break;
    }
  };
  scan(options.messages, 0);

  const seen = new Set<string>();
  return all.filter((file) => {
    if (seen.has(file.fileName)) return false;
    seen.add(file.fileName);
    return true;
  });
}

function MaskedFileRow(props: {
  file: MaskedFile;
  onPreviewFile?: (path: string) => void;
  onRevealFile?: (path: string) => void;
  collapsedMaskingSummaries: () => Set<string>;
  setCollapsedMaskingSummaries: Setter<Set<string>>;
}) {
  return (
    <div class="w-full overflow-hidden rounded-card border border-dls-border bg-dls-surface shadow-(--dls-card-shadow)">
      <div
        data-testid="masked-file-row"
        class="flex w-full items-center gap-2 px-3 py-2"
      >
        <ShieldCheck size={14} class="shrink-0 text-dls-success-text" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-body font-medium text-dls-text">
            {props.file.fileName}
          </div>
          <div class="truncate text-label text-dls-secondary">
            {`Masked file · ${props.file.dataset} · ${formatMaskedRunStamp(props.file.runStamp)}`}
          </div>
        </div>
        <Show
          when={
            !!props.onPreviewFile &&
            isWorkspaceFilePreviewable(props.file.fileName, "projects")
          }
        >
          <Tooltip
            content="Preview masked file"
            placement="bottom"
            maxWidthClass="max-w-[160px]"
          >
            <button
              type="button"
              class="shrink-0 rounded-compact p-1 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              aria-label="Preview masked file"
              onClick={() => props.onPreviewFile?.(props.file.path)}
            >
              <Eye size={14} />
            </button>
          </Tooltip>
        </Show>
        <Show when={!!props.onRevealFile}>
          <Tooltip
            content="Find in File Explorer"
            placement="bottom"
            maxWidthClass="max-w-[160px]"
          >
            <button
              type="button"
              class="shrink-0 rounded-compact p-1 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              aria-label="Find masked file in File Explorer"
              onClick={() => props.onRevealFile?.(props.file.path)}
            >
              <FolderOpen size={14} />
            </button>
          </Tooltip>
        </Show>
      </div>
      <Show when={props.file.maskingSummary}>
        {(summary) => (
          <details
            class="group/masking bg-dls-hover/30"
            open={!props.collapsedMaskingSummaries().has(props.file.path)}
            onToggle={(event) => {
              const path = props.file.path;
              props.setCollapsedMaskingSummaries((current) => {
                const next = new Set(current);
                if (event.currentTarget.open) next.delete(path);
                else next.add(path);
                return next;
              });
            }}
          >
            <summary
              data-testid="masked-file-summary"
              class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-left outline-none transition-colors hover:bg-dls-hover/70 focus-visible:bg-dls-hover/70"
            >
              <ChevronDown
                size={12}
                class="shrink-0 -rotate-90 text-dls-secondary transition-transform group-open/masking:rotate-0"
              />
              <span class="min-w-0 flex-1 text-label font-medium text-dls-text">
                Masking summary
              </span>
              <span class="shrink-0 text-tiny text-dls-secondary">
                {`${summary().entityCount} masked ${summary().entityCount === 1 ? "entity" : "entities"}`}
              </span>
            </summary>
            <div class="flex flex-wrap gap-1.5 px-3 pb-2.5 pl-7">
              <For each={summary().categories}>
                {(category) => (
                  <span
                    data-testid="masked-file-category"
                    class="inline-flex items-center gap-1 rounded-pill border border-dls-border/80 bg-dls-surface/80 px-2 py-0.5 text-tiny font-medium text-dls-secondary"
                  >
                    {formatMaskingCategory(category.category)}
                    <span class="min-w-4 rounded-pill bg-dls-hover px-1 text-center font-semibold tabular-nums text-dls-text">
                      {category.count}
                    </span>
                  </span>
                )}
              </For>
            </div>
          </details>
        )}
      </Show>
    </div>
  );
}

// Masked File shown under response
export function MaskedFilesPanel(props: {
  files: MaskedFile[];
  onPreviewFile?: (path: string) => void;
  onRevealFile?: (path: string) => void;
  collapsedMaskingSummaries: () => Set<string>;
  setCollapsedMaskingSummaries: Setter<Set<string>>;
}) {
  const [open, setOpen] = createSignal(false);

  return (
    <Show
      when={props.files.length > MAX_FILES_SHOWN}
      fallback={
        <For each={props.files}>
          {(file) => (
            <div class="mt-2 w-full max-w-190">
              <MaskedFileRow
                file={file}
                onPreviewFile={props.onPreviewFile}
                onRevealFile={props.onRevealFile}
                collapsedMaskingSummaries={props.collapsedMaskingSummaries}
                setCollapsedMaskingSummaries={props.setCollapsedMaskingSummaries}
              />
            </div>
          )}
        </For>
      }
    >
      <div class="mt-2 w-full max-w-190">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-control border border-dls-border bg-dls-surface px-2.5 py-1.5 text-caption font-medium text-dls-text shadow-(--dls-card-shadow) transition-colors hover:bg-dls-hover"
          aria-expanded={open()}
          onClick={() => setOpen((value) => !value)}
        >
          <ShieldCheck size={13} class="shrink-0 text-dls-secondary" />
          <span>{`${props.files.length} masked files`}</span>
          <ChevronDown
            size={11}
            class={`text-dls-secondary transition-transform duration-200 ${open() ? "rotate-0" : "-rotate-90"}`}
          />
        </button>
        <div
          style={{
            display: "grid",
            "grid-template-rows": open() ? "1fr" : "0fr",
            transition: "grid-template-rows 200ms ease",
          }}
        >
          <div class="overflow-hidden">
            <div class="mt-1 flex flex-col gap-1">
              <For each={props.files}>
                {(file) => (
                  <div>
                    <MaskedFileRow
                      file={file}
                      onPreviewFile={props.onPreviewFile}
                      onRevealFile={props.onRevealFile}
                      collapsedMaskingSummaries={props.collapsedMaskingSummaries}
                      setCollapsedMaskingSummaries={props.setCollapsedMaskingSummaries}
                    />
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
