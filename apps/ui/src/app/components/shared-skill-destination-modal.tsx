import { For, Show, createEffect, createMemo, createSignal } from "solid-js";

import { CheckCircle2, Folder, FolderPlus, Globe, Loader2, Sparkles, X } from "lucide-solid";
import type { WorkspaceInfo } from "../lib/tauri";
import { t, currentLocale } from "../../i18n";

import Button from "./button";

type SharedSkillSummary = {
  name: string;
  description?: string | null;
  trigger?: string | null;
};

export default function SharedSkillDestinationModal(props: {
  open: boolean;
  skill: SharedSkillSummary | null;
  workspaces: WorkspaceInfo[];
  activeWorkspaceId?: string | null;
  busyWorkspaceId?: string | null;
  onClose: () => void;
  onSubmitWorkspace: (workspaceId: string) => void | Promise<void>;
  onCreateWorker?: () => void;
  onConnectRemote?: () => void;
}) {
  const translate = (key: string) => t(key, currentLocale());
  const [selectedWorkspaceId, setSelectedWorkspaceId] = createSignal<string | null>(null);

  const displayName = (workspace: WorkspaceInfo) =>
    workspace.displayName?.trim() ||
    workspace.openworkWorkspaceName?.trim() ||
    workspace.name?.trim() ||
    workspace.directory?.trim() ||
    workspace.path?.trim() ||
    workspace.baseUrl?.trim() ||
    "Worker";

  const subtitle = (workspace: WorkspaceInfo) => {
    if (workspace.workspaceType === "local") {
      return workspace.path?.trim() || translate("share_skill_destination.local_badge");
    }
    return (
      workspace.directory?.trim() ||
      workspace.openworkHostUrl?.trim() ||
      workspace.baseUrl?.trim() ||
      workspace.path?.trim() ||
      translate("share_skill_destination.remote_badge")
    );
  };

  const workspaceBadge = (workspace: WorkspaceInfo) => {
    if (workspace.workspaceType === "remote") {
      return translate("share_skill_destination.remote_badge");
    }
    return translate("share_skill_destination.local_badge");
  };

  const footerBusy = () => Boolean(props.busyWorkspaceId?.trim());
  const selectedWorkspace = createMemo(() => props.workspaces.find((workspace) => workspace.id === selectedWorkspaceId()) ?? null);

  createEffect(() => {
    if (!props.open) return;
    const activeMatch = props.workspaces.find((workspace) => workspace.id === props.activeWorkspaceId) ?? props.workspaces[0] ?? null;
    setSelectedWorkspaceId(activeMatch?.id ?? null);
  });

  const submitSelectedWorkspace = () => {
    const workspaceId = selectedWorkspaceId()?.trim();
    if (!workspaceId || footerBusy()) return;
    void props.onSubmitWorkspace(workspaceId);
  };

  const workspaceCircleClass = (workspace: WorkspaceInfo, selected: boolean) => {
    if (selected) {
      return "bg-dls-workspace-selected/15 text-dls-workspace-selected-text border border-dls-workspace-selected/30";
    }
    if (workspace.workspaceType === "remote") {
      return "bg-dls-workspace-remote/10 text-dls-workspace-remote-text border border-dls-workspace-remote/20";
    }
    return "bg-dls-workspace-local/10 text-dls-workspace-local-text border border-dls-workspace-local/20";
  };

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 dls-modal-backdrop flex items-center justify-center p-4 animate-in fade-in duration-200">
        <div class="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden border dls-modal-surface">
          <div class="border-b border-dls-border bg-dls-surface-solid px-6 py-5">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0 space-y-3">
                <div class="inline-flex items-center gap-2 rounded-pill border border-dls-border bg-dls-surface-raised px-3 py-1 text-label font-semibold uppercase tracking-[0.18em] text-dls-secondary">
                  <Sparkles size={12} />
                  Shared skill
                </div>
                <div class="rounded-inset border border-dls-border bg-dls-surface-raised/40 px-4 py-4">
                  <div class="flex items-start gap-3">
                    <div class="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-pill border border-dls-selection/20 bg-dls-selection/10 text-dls-selection-text">
                      <Sparkles size={17} />
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="text-label font-semibold uppercase tracking-[0.18em] text-dls-muted">
                        {translate("share_skill_destination.skill_label")}
                      </div>
                      <h3 class="mt-1 text-heading font-semibold text-dls-text break-words">
                        {props.skill?.name ?? translate("share_skill_destination.fallback_skill_name")}
                      </h3>
                      <Show when={props.skill?.description?.trim()}>
                        <p class="mt-1 text-body-lg leading-relaxed text-dls-secondary break-words">{props.skill?.description?.trim()}</p>
                      </Show>
                      <Show when={props.skill?.trigger?.trim()}>
                        <div class="mt-3 inline-flex items-center gap-2 rounded-pill border border-dls-border bg-dls-surface-solid px-3 py-1 text-label text-dls-secondary">
                          <span class="font-semibold text-dls-text">{translate("share_skill_destination.trigger_label")}</span>
                          <span class="font-mono">{props.skill?.trigger?.trim()}</span>
                        </div>
                      </Show>
                    </div>
                  </div>
                </div>
                <div>
                  <h4 class="text-body-lg font-medium text-dls-text">{translate("share_skill_destination.title")}</h4>
                  <p class="mt-1 text-body-lg leading-relaxed text-dls-secondary">{translate("share_skill_destination.subtitle")}</p>
                </div>
              </div>

              <button
                onClick={props.onClose}
                disabled={footerBusy()}
                class={`rounded-pill p-2 text-dls-muted transition hover:bg-dls-hover hover:text-dls-text ${footerBusy() ? "cursor-not-allowed opacity-50" : ""}`.trim()}
                aria-label={translate("common.close")}
              >
                <X size={18} />
              </button>
            </div>
          </div>

          <div class="flex-1 space-y-5 overflow-y-auto px-6 py-5">
            <div class="space-y-3">
              <div class="flex items-center justify-between gap-3">
                <div class="text-body-lg font-medium text-dls-text">{translate("share_skill_destination.existing_workers")}</div>
                <Show when={props.workspaces.length > 0}>
                  <span class="text-label uppercase tracking-[0.18em] text-dls-muted">{props.workspaces.length}</span>
                </Show>
              </div>

              <Show
                when={props.workspaces.length > 0}
                fallback={
                  <div class="rounded-inset border border-dashed border-dls-border bg-dls-surface-raised/20 px-4 py-5 text-body-lg leading-relaxed text-dls-secondary">
                    {translate("share_skill_destination.no_workers")}
                  </div>
                }
              >
                <div class="space-y-2">
                  <For each={props.workspaces}>
                    {(workspace) => {
                      const isActive = () => workspace.id === props.activeWorkspaceId;
                      const isSelected = () => workspace.id === selectedWorkspaceId();
                      const isBusy = () => workspace.id === props.busyWorkspaceId;
                      const WorkspaceIcon = () => (workspace.workspaceType === "remote" ? <Globe size={16} /> : <Folder size={16} />);

                      return (
                        <button
                          type="button"
                          onClick={() => setSelectedWorkspaceId(workspace.id)}
                          disabled={footerBusy()}
                          aria-pressed={isSelected()}
                          class={`w-full rounded-inset border text-left transition-colors ${
                            isSelected()
                              ? "border-dls-selection/40 bg-dls-selection-soft-bg/20"
                              : "border-dls-border/40 bg-transparent hover:border-dls-border/50 hover:bg-dls-hover"
                          } ${footerBusy() ? "cursor-wait opacity-70" : ""}`.trim()}
                        >
                          <div class="flex items-start gap-3 px-4 py-3">
                            <div class={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-pill ${workspaceCircleClass(workspace, isSelected())}`.trim()}>
                              <WorkspaceIcon />
                            </div>

                            <div class="min-w-0 flex-1">
                              <div class="flex flex-wrap items-center gap-2">
                                <div class="text-body-lg font-semibold text-dls-text break-words">{displayName(workspace)}</div>
                                <Show when={isActive()}>
                                  <span class="rounded-pill bg-dls-surface-tint px-2 py-0.5 text-tiny uppercase tracking-[0.18em] text-dls-secondary">
                                    {translate("share_skill_destination.current_badge")}
                                  </span>
                                </Show>
                                <span class="rounded-pill bg-dls-surface-tint px-2 py-0.5 text-tiny uppercase tracking-[0.18em] text-dls-secondary">
                                  {workspaceBadge(workspace)}
                                </span>
                                <Show when={isSelected()}>
                                  <span class="rounded-pill bg-dls-selection-soft-bg/60 px-2 py-0.5 text-tiny uppercase tracking-[0.18em] text-dls-selection-text">
                                    {translate("share_skill_destination.selected_badge")}
                                  </span>
                                </Show>
                              </div>

                              <div class="mt-1 text-label font-mono break-all text-dls-subtle/80">{subtitle(workspace)}</div>
                              <Show when={isSelected()}>
                                <div class="mt-2 text-caption font-medium text-dls-secondary">{translate("share_skill_destination.selected_hint")}</div>
                              </Show>
                            </div>

                            <div class="shrink-0 pt-0.5 text-dls-muted">
                              <Show when={isBusy()} fallback={<CheckCircle2 size={16} class={isSelected() ? "text-dls-selection-text" : "text-dls-low"} />}>
                                <Loader2 size={16} class="animate-spin" />
                              </Show>
                            </div>
                          </div>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </div>

            <div class="space-y-3">
              <div class="text-body-lg font-medium text-dls-text">{translate("share_skill_destination.new_destination")}</div>
              <div class="grid gap-2 md:grid-cols-2">
                <Show when={props.onCreateWorker}>
                  <button
                    type="button"
                    onClick={props.onCreateWorker}
                    disabled={footerBusy()}
                    class={`rounded-inset border border-dls-border/40 bg-transparent px-4 py-3 text-left transition-colors hover:border-dls-border/50 hover:bg-dls-hover ${footerBusy() ? "cursor-wait opacity-70" : ""}`.trim()}
                  >
                    <div class="flex items-start gap-3">
                      <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-pill border border-dls-success-border bg-dls-success-bg text-dls-success-text">
                        <FolderPlus size={16} />
                      </div>
                      <div>
                        <div class="text-body-lg font-medium text-dls-text">{translate("share_skill_destination.create_worker")}</div>
                        <div class="mt-1 text-caption leading-relaxed text-dls-secondary">{translate("share_skill_destination.create_worker_desc")}</div>
                      </div>
                    </div>
                  </button>
                </Show>

                <Show when={props.onConnectRemote}>
                  <button
                    type="button"
                    onClick={props.onConnectRemote}
                    disabled={footerBusy()}
                    class={`rounded-inset border border-dls-border/40 bg-transparent px-4 py-3 text-left transition-colors hover:border-dls-border/50 hover:bg-dls-hover ${footerBusy() ? "cursor-wait opacity-70" : ""}`.trim()}
                  >
                    <div class="flex items-start gap-3">
                      <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-pill border border-dls-workspace-remote/20 bg-dls-workspace-remote/10 text-dls-workspace-remote-text">
                        <Globe size={16} />
                      </div>
                      <div>
                        <div class="text-body-lg font-medium text-dls-text">{translate("share_skill_destination.connect_remote")}</div>
                        <div class="mt-1 text-caption leading-relaxed text-dls-secondary">{translate("share_skill_destination.connect_remote_desc")}</div>
                      </div>
                    </div>
                  </button>
                </Show>
              </div>
            </div>
          </div>

          <div class="flex flex-col gap-3 border-t border-dls-border bg-dls-surface-solid px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div class="text-body-lg text-dls-secondary">
              <Show when={selectedWorkspace()} fallback={<span>{translate("share_skill_destination.footer_idle")}</span>}>
                {(workspace) => (
                  <span>
                    {translate("share_skill_destination.footer_selected")} <span class="font-medium text-dls-text">{displayName(workspace())}</span>
                  </span>
                )}
              </Show>
            </div>

            <div class="flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={props.onClose} disabled={footerBusy()}>
                {translate("common.cancel")}
              </Button>
              <Button onClick={submitSelectedWorkspace} disabled={!selectedWorkspaceId() || footerBusy()}>
                <Show when={footerBusy()} fallback={translate("share_skill_destination.confirm_button")}>
                  <>
                    <Loader2 size={15} class="animate-spin" />
                    {translate("share_skill_destination.confirm_busy")}
                  </>
                </Show>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
