import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { Boxes, ChevronDown, ChevronRight, Plus, Sparkles, X } from "lucide-solid";

type ExistingWorkerOption = {
  id: string;
  label: string;
  detail: string;
  badge: string;
  current: boolean;
  disabledReason: string | null;
};

export default function SharedBundleImportModal(props: {
  open: boolean;
  title: string;
  description: string;
  items: string[];
  workers: ExistingWorkerOption[];
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onCreateNewWorker: () => void;
  onSelectWorker: (workspaceId: string) => void;
}) {
  const [showWorkers, setShowWorkers] = createSignal(false);

  createEffect(() => {
    if (!props.open) return;
    setShowWorkers(false);
  });

  createEffect(() => {
    if (!props.open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      props.onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  const visibleItems = createMemo(() => props.items.filter(Boolean).slice(0, 4));
  const hiddenItemCount = createMemo(() => Math.max(0, props.items.filter(Boolean).length - visibleItems().length));
  const busy = () => Boolean(props.busy);

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 dls-modal-backdrop flex items-center justify-center p-4">
        <div class="w-full max-w-xl overflow-hidden border dls-modal-surface">
          <div class="border-b border-dls-border bg-dls-surface-solid px-6 py-5">
            <div class="flex items-start justify-between gap-4">
              <div class="flex items-start gap-3">
                <div class="flex h-11 w-11 items-center justify-center rounded-card bg-dls-selection/15 text-dls-selection-text">
                  <Boxes size={20} />
                </div>
                <div>
                  <h3 class="text-heading font-semibold text-dls-text">{props.title}</h3>
                  <p class="mt-1 text-body-lg leading-relaxed text-dls-secondary">{props.description}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={props.onClose}
                disabled={busy()}
                class="rounded-pill p-1 text-dls-secondary transition hover:bg-dls-hover hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <Show when={visibleItems().length > 0}>
              <div class="mt-4 flex flex-wrap gap-2">
                <For each={visibleItems()}>
                  {(item) => (
                    <span class="rounded-pill border border-dls-border bg-dls-surface-tint px-3 py-1 text-caption font-medium text-dls-secondary">
                      {item}
                    </span>
                  )}
                </For>
                <Show when={hiddenItemCount() > 0}>
                  <span class="rounded-pill border border-dls-border bg-dls-surface-tint px-3 py-1 text-caption font-medium text-dls-secondary">
                    +{hiddenItemCount()} more
                  </span>
                </Show>
              </div>
            </Show>
          </div>

          <div class="space-y-4 p-6">
            <Show when={props.error?.trim()}>
              <div class="rounded-inset border border-dls-danger-border bg-dls-danger-bg px-4 py-3 text-body-lg text-dls-danger-text">{props.error}</div>
            </Show>

            <button
              type="button"
              onClick={props.onCreateNewWorker}
              disabled={busy()}
              class="flex w-full items-center justify-between rounded-card border border-dls-selection/30 bg-dls-selection/10 px-4 py-4 text-left transition hover:border-dls-selection/50 hover:bg-dls-selection/15 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <div class="flex items-start gap-3">
                <div class="mt-0.5 flex h-10 w-10 items-center justify-center rounded-inset bg-dls-selection/20 text-dls-selection-text">
                  <Plus size={18} />
                </div>
                <div>
                  <div class="text-body-lg font-semibold text-dls-text">Create New Worker</div>
                  <div class="mt-1 text-body-lg text-dls-secondary">Open the existing new worker flow, then import this bundle into it.</div>
                </div>
              </div>
              <Sparkles size={18} class="text-dls-selection-text" />
            </button>

            <div class="rounded-card border border-dls-border bg-dls-surface-solid/70">
              <button
                type="button"
                onClick={() => setShowWorkers((value) => !value)}
                disabled={busy()}
                class="flex w-full items-center justify-between gap-3 px-4 py-4 text-left transition hover:bg-dls-hover/60 disabled:cursor-not-allowed disabled:opacity-60"
                aria-expanded={showWorkers()}
              >
                <div>
                  <div class="text-body-lg font-semibold text-dls-text">Add to existing worker</div>
                  <div class="mt-1 text-body-lg text-dls-secondary">Pick an existing worker and import the shared skills there.</div>
                </div>
                <Show when={showWorkers()} fallback={<ChevronRight size={18} class="text-dls-secondary" />}>
                  <ChevronDown size={18} class="text-dls-secondary" />
                </Show>
              </button>

              <Show when={showWorkers()}>
                <div class="space-y-3 border-t border-dls-border px-4 py-4">
                  <Show
                    when={props.workers.length > 0}
                    fallback={<div class="rounded-inset border border-dashed border-dls-border px-4 py-5 text-body-lg text-dls-secondary">No configured workers are available yet. Create a new worker to import this bundle.</div>}
                  >
                    <For each={props.workers}>
                      {(worker) => {
                        const disabledReason = () => worker.disabledReason?.trim() ?? "";
                        const disabled = () => Boolean(disabledReason()) || busy();
                        return (
                          <button
                            type="button"
                            onClick={() => props.onSelectWorker(worker.id)}
                            disabled={disabled()}
                            class="w-full rounded-inset border border-dls-border bg-dls-surface-raised px-4 py-3 text-left transition hover:border-dls-border hover:bg-dls-hover disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <div class="flex items-start justify-between gap-3">
                              <div class="min-w-0 flex-1">
                                <div class="flex flex-wrap items-center gap-2">
                                  <span class="text-body-lg font-semibold text-dls-text">{worker.label}</span>
                                  <span class="rounded-pill border border-dls-border bg-dls-surface-tint px-2 py-0.5 text-label font-medium uppercase tracking-wide text-dls-secondary">
                                    {worker.badge}
                                  </span>
                                  <Show when={worker.current}>
                                    <span class="rounded-pill border border-dls-success-border bg-dls-success-bg px-2 py-0.5 text-label font-medium uppercase tracking-wide text-dls-success-text">
                                      Current
                                    </span>
                                  </Show>
                                </div>
                                <div class="mt-1 truncate text-body-lg text-dls-secondary">{worker.detail}</div>
                                <Show when={disabledReason()}>
                                  <div class="mt-2 text-caption text-dls-warning-text">{disabledReason()}</div>
                                </Show>
                              </div>
                              <ChevronRight size={18} class="mt-0.5 shrink-0 text-dls-secondary" />
                            </div>
                          </button>
                        );
                      }}
                    </For>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
