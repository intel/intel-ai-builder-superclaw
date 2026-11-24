import { For, Show, createEffect, createSignal } from "solid-js";

import { CheckCircle2, FolderPlus, Loader2, X } from "lucide-solid";
import { t } from "../../i18n";
import type { WorkspacePreset } from "../types";

import Button from "./button";

export default function CreateWorkspaceModal(props: {
  open: boolean;
  onClose: () => void;
  onConfirm: (preset: WorkspacePreset, folder: string | null) => void;
  onPickFolder: () => Promise<string | null>;
  submitting?: boolean;
  inline?: boolean;
  showClose?: boolean;
  defaultPreset?: WorkspacePreset;
  title?: string;
  subtitle?: string;
  confirmLabel?: string;
}) {
  let pickFolderRef: HTMLButtonElement | undefined;

  const [preset, setPreset] = createSignal<WorkspacePreset>("starter");
  const [selectedFolder, setSelectedFolder] = createSignal<string | null>(null);
  const [pickingFolder, setPickingFolder] = createSignal(false);

  createEffect(() => {
    if (props.open) {
      setPreset(props.defaultPreset ?? "starter");
      requestAnimationFrame(() => pickFolderRef?.focus());
    }
  });

  const options = () => [
    {
      id: "starter" as const,
      name: t("dashboard.starter_workspace"),
      desc: t("dashboard.starter_workspace_desc"),
    },
    {
      id: "minimal" as const,
      name: t("dashboard.empty_workspace"),
      desc: t("dashboard.empty_workspace_desc"),
    },
    {
      id: "automation" as const,
      name: t("dashboard.blueprints_workspace"),
      desc: t("dashboard.blueprints_workspace_desc"),
    },
  ];

  const folderLabel = () => {
    const folder = selectedFolder();
    if (!folder) return t("dashboard.choose_folder");
    const parts = folder.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] ?? folder;
  };

  const folderSubLabel = () => {
    const folder = selectedFolder();
    if (!folder) return t("dashboard.choose_folder_next");
    return folder;
  };

  const handlePickFolder = async () => {
    if (pickingFolder()) return;
    setPickingFolder(true);
    try {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      const next = await props.onPickFolder();
      if (next) {
        setSelectedFolder(next);
      }
    } finally {
      setPickingFolder(false);
    }
  };

  const showClose = () => props.showClose ?? true;
  const title = () => props.title ?? t("dashboard.create_workspace_title");
  const subtitle = () => props.subtitle ?? t("dashboard.create_workspace_subtitle");
  const confirmLabel = () => props.confirmLabel ?? t("dashboard.create_workspace_confirm");
  const isInline = () => props.inline ?? false;
  const submitting = () => props.submitting ?? false;
  const content = (
    <div class="border w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] dls-modal-surface">
      <div class="p-6 border-b border-dls-border flex justify-between items-center bg-dls-surface-solid">
        <div>
          <h3 class="font-semibold text-dls-text text-heading">{title()}</h3>
          <p class="text-dls-secondary text-body-lg">{subtitle()}</p>
        </div>
        <Show when={showClose()}>
          <button
            onClick={props.onClose}
            disabled={submitting()}
            class={`hover:bg-dls-hover p-1 rounded-pill ${submitting() ? "opacity-50 cursor-not-allowed" : ""}`.trim()}
          >
            <X size={20} class="text-dls-secondary" />
          </button>
        </Show>
      </div>

          <div class="p-6 flex-1 overflow-y-auto space-y-8">
            <div class="space-y-4">
              <div class="flex items-center gap-3 text-body-lg font-medium text-dls-text">
                <div class="w-6 h-6 rounded-pill bg-dls-surface-muted flex items-center justify-center text-caption">
                  1
                </div>
                {t("dashboard.select_folder")}
              </div>
              <div class="ml-9">
                <button
                  type="button"
                  ref={pickFolderRef}
                  onClick={handlePickFolder}
                  disabled={pickingFolder() || submitting()}
                  class={`w-full border border-dashed border-dls-border bg-dls-surface-raised/50 rounded-inset p-4 text-left transition ${
                    pickingFolder() ? "opacity-70 cursor-wait" : "hover:border-dls-border"
                  }`.trim()}
                >
                  <div class="flex items-center gap-3 text-dls-text">
                    <FolderPlus size={20} class="text-dls-secondary" />
                    <div class="flex-1 min-w-0">
                      <div class="text-body-lg font-medium text-dls-text truncate">{folderLabel()}</div>
                      <div class="text-caption text-dls-secondary font-mono truncate mt-1">{folderSubLabel()}</div>
                    </div>
                    <Show
                      when={pickingFolder()}
                      fallback={<span class="text-caption text-dls-secondary">{t("dashboard.change")}</span>}
                    >
                      <span class="flex items-center gap-2 text-caption text-dls-secondary">
                        <Loader2 size={12} class="animate-spin" />
                        {t("dashboard.opening")}
                      </span>
                    </Show>
                  </div>
                </button>
              </div>
            </div>

            <div class="space-y-4">
              <div class="flex items-center gap-3 text-body-lg font-medium text-dls-text">
                <div class="w-6 h-6 rounded-pill bg-dls-surface-muted flex items-center justify-center text-caption">
                  2
                </div>
                {t("dashboard.choose_preset")}
              </div>
              <div class={`ml-9 grid gap-3 ${!selectedFolder() ? "opacity-50" : ""}`.trim()}>
                <For each={options()}>
                  {(opt) => (
                    <div
                      onClick={() => {
                        if (!selectedFolder()) return;
                        if (submitting()) return;
                        setPreset(opt.id);
                      }}
                      class={`p-4 rounded-inset border cursor-pointer transition-all ${
                        preset() === opt.id
                          ? "bg-dls-selection/10 border-dls-selection/50"
                          : "bg-dls-surface-raised border-dls-border hover:border-dls-border"
                      } ${!selectedFolder() || submitting() ? "pointer-events-none" : ""}`.trim()}
                    >
                      <div class="flex justify-between items-start">
                        <div>
                          <div
                            class={`font-medium text-body-lg ${
                              preset() === opt.id ? "text-dls-selection-text" : "text-dls-text"
                            }`}
                          >
                            {opt.name}
                          </div>
                          <div class="text-caption text-dls-secondary mt-1">{opt.desc}</div>
                        </div>
                        <Show when={preset() === opt.id}>
                          <CheckCircle2 size={16} class="text-dls-selection-icon" />
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </div>

      <div class="p-6 border-t border-dls-border bg-dls-surface-solid flex flex-col gap-3">
        <div class="flex justify-end gap-3">
          <Show when={showClose()}>
            <Button variant="ghost" onClick={props.onClose} disabled={submitting()}>
              {t("common.cancel")}
            </Button>
          </Show>
          <Button
            onClick={() => props.onConfirm(preset(), selectedFolder())}
            disabled={!selectedFolder() || submitting()}
            title={!selectedFolder() ? t("dashboard.choose_folder_continue") : undefined}
          >
            <Show when={submitting()} fallback={confirmLabel()}>
              <span class="inline-flex items-center gap-2">
                <Loader2 size={16} class="animate-spin" />
                {t("dashboard.creating")}
              </span>
            </Show>
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <Show when={props.open || isInline()}>
      <div
        class={
          isInline()
            ? "w-full"
            : "fixed inset-0 z-50 dls-modal-backdrop flex items-center justify-center p-4 animate-in fade-in duration-200"
        }
      >
        {content}
      </div>
    </Show>
  );
}
