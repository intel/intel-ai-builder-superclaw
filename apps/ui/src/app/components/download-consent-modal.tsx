import { Show, For, createSignal, createEffect, createMemo, on } from "solid-js";
import { Brain, CheckCircle2, Download, Loader2 } from "lucide-solid";

import Button from "./button";

// ── Types ────────────────────────────────────────────────────────────────────

/** Model info returned by the `get_download_models_info` Tauri command (dormant; command removed with backend-manager). */
export type ModelInfo = {
  id: string;
  name: string | null;
  expectedSizeBytes: number;
  actualSizeBytes: number;
  ready: boolean;
};

type DownloadItemDef = {
  id: string;
  label: string;
  size: string;
  icon: typeof Brain;
  ready: boolean;
};

type ModalPhase = "consent" | "downloading" | "starting";

export type DownloadConsentModalProps = {
  open: boolean;
  /** Current backend-manager stage (from superclaw://backend-progress) */
  stage: string | null;
  /** Current progress message */
  message: string | null;
  /** Current percentage (0–1 fraction) */
  pct: number | null;
  /** Backend is fully ready */
  ready: boolean;
  /** Backend boot error (non-null means failure) */
  error: string | null;
  /** Dynamic model list from backend (null = loading/unavailable) */
  models: ModelInfo[] | null;
  /** Called when user acknowledges consent and starts monitoring */
  onContinue: () => void;
  /** Called when user cancels / exits */
  onCancel: () => void;
  /** Called automatically when downloads complete and server is ready */
  onClose: () => void;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function formatDownloadMessage(msg: string | null): string | null {
  if (!msg) return null;
  const match = msg.match(/^(\d+)\/(\d+)\s*bytes$/);
  if (!match) return null;
  const downloaded = parseInt(match[1], 10);
  const total = parseInt(match[2], 10);
  return `${formatBytes(downloaded)} / ${formatBytes(total)}`;
}

/** Build display items from backend model info. */
function buildItems(models: ModelInfo[]): DownloadItemDef[] {
  return models.map((m) => ({
    id: m.id,
    label: m.name || m.id,
    size: formatBytes(m.expectedSizeBytes),
    icon: Brain,
    ready: m.ready,
  }));
}

// ── Circular Progress ────────────────────────────────────────────────────────

function CircularProgress(props: { pct: number; done: boolean; size?: number }) {
  const sz = () => props.size ?? 40;
  const stroke = 3;
  const radius = () => (sz() - stroke) / 2;
  const circumference = () => 2 * Math.PI * radius();
  const offset = () => circumference() - (props.pct / 100) * circumference();

  return (
    <div
      class="relative flex items-center justify-center shrink-0"
      style={{ width: `${sz()}px`, height: `${sz()}px` }}
    >
      <Show
        when={!props.done}
        fallback={
          <CheckCircle2 size={sz() * 0.55} class="text-dls-success-text" />
        }
      >
        {/* Background circle */}
        <svg class="absolute inset-0" viewBox={`0 0 ${sz()} ${sz()}`}>
          <circle
            cx={sz() / 2}
            cy={sz() / 2}
            r={radius()}
            fill="none"
            stroke="currentColor"
            stroke-width={stroke}
            class="text-dls-soft"
          />
          <circle
            cx={sz() / 2}
            cy={sz() / 2}
            r={radius()}
            fill="none"
            stroke="currentColor"
            stroke-width={stroke}
            stroke-linecap="round"
            stroke-dasharray={`${circumference()}`}
            stroke-dashoffset={offset()}
            class="text-dls-info transition-[stroke-dashoffset] duration-300"
            style={{ transform: "rotate(-90deg)", "transform-origin": "50% 50%" }}
          />
        </svg>
        <span class="text-tiny font-medium text-dls-secondary">
          {props.pct > 0 ? `${Math.round(props.pct)}%` : "…"}
        </span>
      </Show>
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function DownloadConsentModal(props: DownloadConsentModalProps) {
  const [phase, setPhase] = createSignal<ModalPhase>("consent");
  const [itemProgress, setItemProgress] = createSignal<Record<string, number>>({});
  const [activeItem, setActiveItem] = createSignal<string | null>(null);
  const [itemMessages, setItemMessages] = createSignal<Record<string, string | null>>({});
  const [startingStatus, setStartingStatus] = createSignal("Starting inference servers...");

  // Derive display items from props.models (dynamic) with graceful fallback
  const displayItems = createMemo<DownloadItemDef[]>(() => {
    if (props.models && props.models.length > 0) {
      return buildItems(props.models);
    }
    // Fallback: show generic placeholder while loading
    return [];
  });

  // Items that actually need downloading (not already ready)
  const pendingItems = createMemo(() => displayItems().filter((i) => !i.ready));

  // Total download size for pending items only
  const pendingTotalSize = createMemo(() => {
    if (!props.models) return "";
    const bytes = props.models.filter((m) => !m.ready).reduce((sum, m) => sum + m.expectedSizeBytes, 0);
    return bytes > 0 ? formatBytes(bytes) : "";
  });

  // Sequential download tracking: only pending (non-ready) models download.
  // We detect file transitions by watching the total byte count change.
  const [currentPendingIdx, setCurrentPendingIdx] = createSignal(0);
  const [lastFileTotal, setLastFileTotal] = createSignal(0);

  // Track progress from backend events
  createEffect(
    on(
      () => [props.stage, props.pct, props.message] as const,
      ([stage, _pct, message]) => {
        // ── Starting phase: only update status from meaningful stages ──
        if (phase() === "starting") {
          if (stage?.includes("owt")) {
            setStartingStatus("Obtaining workspace token...");
          } else if (stage?.includes("server_start")) {
            setStartingStatus(message || "Starting inference servers...");
          }
          return;
        }

        if (phase() !== "downloading") return;

        const items = pendingItems();
        if (items.length === 0) return;

        // Only process model_download child events
        if (!stage?.includes("model_download")) return;

        // "models downloaded" = all done
        if (message?.includes("models downloaded")) {
          const allDone = Object.fromEntries(
            items.map((i) => [i.id, 100]),
          ) as Record<string, number>;
          setItemProgress(allDone);
          return;
        }

        let itemIdx = currentPendingIdx();

        const byteMatch = message?.match(/^(\d+)\/(\d+)\s*bytes$/);
        if (byteMatch) {
          const downloaded = parseInt(byteMatch[1], 10);
          const total = parseInt(byteMatch[2], 10);

          // Detect file transition: total changed = new model file started
          if (total !== lastFileTotal() && lastFileTotal() > 0) {
            // Mark previous item as done
            setItemProgress((prev) => ({ ...prev, [items[itemIdx].id]: 100 }));
            // Advance to next item
            const nextIdx = Math.min(itemIdx + 1, items.length - 1);
            if (nextIdx !== itemIdx) {
              setCurrentPendingIdx(nextIdx);
              itemIdx = nextIdx;
            }
          }
          setLastFileTotal(total);

          const item = items[itemIdx];
          setActiveItem(item.id);
          const itemPct = total > 0 ? (downloaded / total) * 100 : 0;
          setItemProgress((prev) => ({ ...prev, [item.id]: Math.max(prev[item.id] ?? 0, itemPct) }));
          const formatted = formatDownloadMessage(message);
          if (formatted) setItemMessages((prev) => ({ ...prev, [item.id]: formatted }));
        } else if (message?.includes("verifying")) {
          const item = items[itemIdx];
          setActiveItem(item.id);
          setItemProgress((prev) => ({ ...prev, [item.id]: 100 }));
          setItemMessages((prev) => ({ ...prev, [item.id]: "Verifying..." }));
        } else if (message?.includes("downloading")) {
          // Initial "downloading <path>" message — just set active, no progress yet
          const item = items[itemIdx];
          setActiveItem(item.id);
        }
      },
    ),
  );

  // Transition to "starting" when all pending models reach 100% but not yet ready
  createEffect(
    on(
      () => itemProgress(),
      (progress) => {
        const pending = pendingItems();
        if (phase() === "downloading" && pending.length > 0) {
          const allDone = pending.every((i) => (progress[i.id] ?? 0) >= 100);
          if (allDone) setPhase("starting");
        } else if (phase() === "downloading" && pending.length === 0) {
          // Edge case: all models were already ready
          setPhase("starting");
        }
      },
    ),
  );

  // Auto-close when backend reports ready
  createEffect(
    on(
      () => props.ready,
      (ready) => {
        if (ready && (phase() === "downloading" || phase() === "starting")) {
          const items = displayItems();
          const allDone = Object.fromEntries(items.map((i) => [i.id, 100]));
          setItemProgress(allDone);
          props.onClose();
        }
      },
    ),
  );

  // Close modal on backend error so the boot overlay's retry UI is visible
  createEffect(
    on(
      () => props.error,
      (err) => {
        if (err && phase() !== "consent") {
          props.onClose();
        }
      },
    ),
  );

  const handleContinue = () => {
    setPhase("downloading");
    props.onContinue();
  };

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-[80] dls-modal-backdrop flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="download-consent-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (phase() === "consent") props.onCancel();
          }
        }}
      >
        <div class="border w-full max-w-lg overflow-hidden dls-modal-surface">
          <div class="p-6">
            {/* Header */}
            <div class="flex items-center gap-3 mb-5">
              <div class="shrink-0 w-10 h-10 rounded-pill bg-dls-warning-bg text-dls-warning-text flex items-center justify-center">
                <Show
                  when={phase() !== "starting"}
                  fallback={<Loader2 size={20} class="animate-spin" />}
                >
                  <Download size={20} />
                </Show>
              </div>
              <div>
                <h3 id="download-consent-title" class="text-body-xl leading-title font-semibold text-dls-text">
                  {phase() === "consent"
                    ? "Required Local Models"
                    : phase() === "downloading"
                      ? "Downloading Models…"
                      : "Starting Server"}
                </h3>
                <p class="text-caption text-dls-secondary mt-0.5">
                  {phase() === "consent"
                    ? pendingItems().length > 0
                      ? pendingTotalSize()
                        ? `${pendingTotalSize()} download required`
                        : "Download required"
                      : "All models are already downloaded"
                    : phase() === "downloading"
                      ? "This may take a few minutes depending on your network."
                      : startingStatus()}
                </p>
              </div>
            </div>

            {/* Download items list */}
            <Show when={phase() !== "starting"}>
            <Show
              when={displayItems().length > 0}
              fallback={
                <div class="flex items-center gap-2 py-4 text-body-lg text-dls-secondary">
                  <Loader2 size={16} class="animate-spin" />
                  <span>Loading model information…</span>
                </div>
              }
            >
            <div class="space-y-3">
              <For each={displayItems()}>
                {(item) => {
                  const pct = () => itemProgress()[item.id] ?? (item.ready ? 100 : 0);
                  const isActive = () => activeItem() === item.id && phase() === "downloading";
                  const isDone = () => pct() >= 100;
                  const Icon = item.icon;

                  return (
                    <div
                      class="flex items-center gap-3 p-3 rounded-inset border transition-colors"
                      classList={{
                        "border-dls-success-border bg-dls-success-bg": (phase() === "consent" && item.ready) || (isDone() && phase() !== "consent"),
                        "border-dls-border-soft bg-dls-surface-tint/30": phase() === "consent" && !item.ready,
                        "border-dls-info/40 bg-dls-info/5": isActive() && !isDone(),
                        "border-dls-border-soft bg-dls-surface-tint/20": phase() === "downloading" && !isActive() && !isDone(),
                      }}
                    >
                      <Show
                        when={phase() !== "consent"}
                        fallback={
                          <Show
                            when={!item.ready}
                            fallback={
                              <div class="shrink-0 w-10 h-10 rounded-pill bg-dls-success-bg flex items-center justify-center text-dls-success-text">
                                <CheckCircle2 size={18} />
                              </div>
                            }
                          >
                            <div class="shrink-0 w-10 h-10 rounded-pill bg-dls-surface-muted/50 flex items-center justify-center text-dls-secondary">
                              <Icon size={18} />
                            </div>
                          </Show>
                        }
                      >
                        <CircularProgress pct={pct()} done={isDone()} />
                      </Show>

                      <div class="min-w-0 flex-1">
                        <p class="text-body-lg font-medium text-dls-text">{item.label}</p>
                        <p class="text-caption text-dls-secondary truncate">
                          <Show
                            when={phase() === "downloading" && isActive() && itemMessages()[item.id]}
                            fallback={
                              <Show when={item.ready && phase() === "consent"} fallback={item.size}>
                                <span class="text-dls-success-text">{item.size} · Already downloaded</span>
                              </Show>
                            }
                          >
                            {itemMessages()[item.id]}
                          </Show>
                        </p>
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
            </Show>
            </Show>

            {/* Buttons */}
            <div class="mt-6 flex justify-end gap-2">
              <Show when={phase() === "consent"}>
                <Button variant="outline" onClick={props.onCancel}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={handleContinue}>
                  Continue
                </Button>
              </Show>

              <Show when={phase() === "downloading"}>
                <Button variant="outline" onClick={props.onCancel}>
                  Cancel
                </Button>
              </Show>

              <Show when={phase() === "starting"}>
                <div class="flex items-center gap-2 text-caption text-dls-secondary">
                  <Loader2 size={14} class="animate-spin" />
                  <span>Please wait…</span>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
