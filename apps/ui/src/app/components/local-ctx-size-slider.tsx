import { createSignal, onCleanup, onMount, Show } from "solid-js";

import { readOpenworkServerSettings } from "../lib/openwork-server";
import { requestServiceHubJson } from "../lib/servicehub";
import {
  fetchLocalCtxSize,
  type LocalCtxSizeState as CtxSizeState,
} from "~/shared/platform/capability/model-binding-activation-client";
import { t } from "../../i18n";

/**
 * LocalCtxSizeSlider — llama-server ``-c`` context-size override (experiment knob).
 *
 * Sits directly beneath `PerfWeightSlider` in Settings. This section is gated by
 * the build-time flag `VITE_SHOW_LOCAL_CTX_SLIDER` (see `showLocalCtxSlider()` in
 * `lib/experimental-flags.ts`) so it can be excluded from release builds.
 *
 * Semantics:
 *   * `ctx_size` (persisted override in the Store) is what the user picks.
 *   * `applied` is what llama-server is currently running with.
 *   * On PUT, the manager restarts llama-server (30-60s cold load) because
 *     `-c` is a launch-time flag with no runtime API. UI disables the panel
 *     while the PUT is in flight and shows a "restarting" message.
 *   * Quick-pick buttons for the common ctx sizes matching the shipped tiers
 *     (4B: 65536, 35B: 100000). Custom values are supported
 *     via the numeric input.
 *   * `source` labels ("default" / "custom override" / "env override")
 *     help the operator see which layer is currently active.
 *
 * Same hub-token auth pattern as PerfWeightSlider — uses `requestServiceHubJson`
 * with `hubToken`, NOT `settings.token` (which the hub proxy rejects).
 */

// Quick-pick presets — one per shipped chat tier's default_ctx.
const PRESETS: readonly number[] = [4096, 16384, 32768, 65536, 100000] as const;

const MIN_CTX = 1024;
const MAX_CTX = 262144;
// Covers LRM's 60s health and 300s model-load budgets plus restart overhead.
const APPLY_TIMEOUT_MS = 420_000;

// The last read, kept outside the component because Settings unmounts on every
// tab switch. A remount draws the section at once instead of popping it in when
// the read returns, so the Model page keeps one height and the scrollbar does
// not jump. `prefetchLocalCtxSize` fills it at start-up for the first visit.
// A signal, so the Settings search can tell whether the section is drawn.
const [cachedCtxState, setCachedCtxState] = createSignal<CtxSizeState | null>(null);

/** Whether the last read found a context size to set; the section is hidden otherwise. */
export const localCtxSupported = (): boolean => cachedCtxState()?.supported === true;
let ctxReadGeneration = 0;
let ctxSizeWrite: Promise<void> = Promise.resolve();
let pendingCtxSizeWrites = 0;
const [ctxSizeSaving, setCtxSizeSaving] = createSignal(false);

const ctxHub = (): { baseUrl: string; token: string } | null => {
  const s = readOpenworkServerSettings();
  const baseUrl = s.hubUrl?.trim() ?? "";
  const token = s.hubToken?.trim() ?? "";
  return baseUrl && token ? { baseUrl, token } : null;
};

async function readCtxState(): Promise<CtxSizeState | null> {
  const h = ctxHub();
  if (!h) return null;
  const data = await fetchLocalCtxSize({ baseUrl: h.baseUrl, token: h.token });
  if (!data || typeof data.supported !== "boolean") return null;
  return data;
}

function queueCtxSizeWrite(value: number | null): Promise<CtxSizeState | null> {
  ctxReadGeneration += 1;
  pendingCtxSizeWrites += 1;
  setCtxSizeSaving(true);
  const next = ctxSizeWrite.then(async () => {
    const h = ctxHub();
    if (!h) return null;
    const data = await requestServiceHubJson<CtxSizeState>(
      h.baseUrl,
      "/llm-router/v1/local/ctx-size",
      h.token,
      { method: "PUT", body: { ctx_size: value }, timeoutMs: APPLY_TIMEOUT_MS },
    );
    if (data && typeof data.supported === "boolean") setCachedCtxState(data);
    return data;
  });
  ctxSizeWrite = next.then(() => undefined, () => undefined);
  void next.finally(() => {
    pendingCtxSizeWrites -= 1;
    if (pendingCtxSizeWrites === 0) setCtxSizeSaving(false);
  }).catch(() => undefined);
  return next;
}

/** Read the context size ahead of the first Settings visit. Best-effort. */
export function prefetchLocalCtxSize(): void {
  const generation = ctxReadGeneration;
  void readCtxState()
    .then((data) => {
      if (data && generation === ctxReadGeneration) setCachedCtxState(data);
    })
    .catch(() => undefined);
}

export default function LocalCtxSizeSlider() {
  const cached = cachedCtxState();
  const [ctxSize, setCtxSize] = createSignal<number | null>(cached?.ctx_size ?? null);
  const [applied, setApplied] = createSignal<number | null>(cached?.applied ?? null);
  const [source, setSource] = createSignal<CtxSizeState["source"]>(cached?.source ?? "unknown");
  const [supported, setSupported] = createSignal(cached?.supported ?? false);
  // Local editable value in the input while the user is typing.
  const [draft, setDraft] = createSignal<string>(cached?.ctx_size == null ? "" : String(cached.ctx_size));
  const [error, setError] = createSignal<string | null>(null);

  const applyState = (data: CtxSizeState) => {
    setCachedCtxState(data);
    setCtxSize(data.ctx_size);
    setApplied(data.applied);
    setSource(data.source);
    setSupported(data.supported);
    // Seed the input with the persisted override if set; otherwise leave blank.
    // This avoids persisting an override + restarting when the user clicks Apply
    // without explicitly changing the value.
    const seed = data.ctx_size ?? "";
    setDraft(seed === "" ? "" : String(seed));
  };

  const fetchState = async () => {
    const generation = ++ctxReadGeneration;
    try {
      await ctxSizeWrite;
      const data = await readCtxState();
      if (generation === ctxReadGeneration && data) applyState(data);
    } catch {
      // best-effort: leave the section hidden if the knob can't be read
    }
  };

  const parseDraft = (raw: string): number | null | "invalid" => {
    const trimmed = raw.trim();
    if (trimmed === "") return null; // empty input clears the override
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < MIN_CTX || n > MAX_CTX) return "invalid";
    return n;
  };

  const applyValue = async (value: number | null) => {
    setError(null);
    try {
      const data = await queueCtxSizeWrite(value);
      if (data && typeof data.supported === "boolean") {
        applyState(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("model.local_ctx_save_failed"));
    }
  };

  const onApplyClick = async () => {
    const parsed = parseDraft(draft());
    if (parsed === "invalid") {
      setError(t("model.local_ctx_invalid_range"));
      return;
    }
    // Avoid an unnecessary restart when the persisted override isn't changing.
    if (parsed === ctxSize()) return;
    await applyValue(parsed);
  };

  const onResetClick = async () => {
    // Null override → server falls back to registry default_ctx.
    await applyValue(null);
  };

  const onPresetClick = async (value: number) => {
    setDraft(String(value));
    await applyValue(value);
  };

  const sourceLabel = () => {
    switch (source()) {
      case "env":
        return t("model.local_ctx_source_env");
      case "store":
        return t("model.local_ctx_source_store");
      case "registry":
        return t("model.local_ctx_source_registry");
      case "booster":
        return t("model.local_ctx_source_booster");
      case "unknown":
        return t("model.local_ctx_source_unknown");
      default:
        return "";
    }
  };

  onMount(() => {
    void fetchState();
  });
  onCleanup(() => {
    // no timers to clear — saves are user-initiated
  });

  return (
    <Show when={supported()}>
      <div data-settings-anchor="local_ctx" class="space-y-3">
        <div class="text-label font-semibold uppercase tracking-wider text-dls-secondary">
          {t("model.local_ctx_section")}
        </div>
        <div class="bg-dls-panel-bg border border-dls-panel-border rounded-card p-5 space-y-3">
          <div class="flex items-center justify-between gap-2">
            <span class="text-label font-medium text-dls-secondary">
              {t("model.local_ctx_title")}
            </span>
            <Show when={applied() !== null}>
              <span class="text-tiny text-dls-secondary">
                {t("model.local_ctx_applied_prefix")}
                <span class="ml-1 font-mono text-dls-text tabular-nums">
                  {applied()}
                </span>
                <Show when={sourceLabel()}>
                  <span class="ml-1 text-dls-secondary">
                    ({sourceLabel()})
                  </span>
                </Show>
              </span>
            </Show>
          </div>

          <div class="flex items-center gap-2">
            <input
              type="number"
              min={MIN_CTX}
              max={MAX_CTX}
              step="1024"
              value={draft()}
              placeholder={t("model.local_ctx_placeholder")}
              disabled={ctxSizeSaving()}
              class="flex-1 rounded-control border border-dls-border bg-dls-surface-raised px-3 py-1.5 text-caption font-mono text-dls-text tabular-nums disabled:opacity-50 focus:outline-none focus:border-dls-muted"
              onInput={(e) => setDraft(e.currentTarget.value)}
            />
            <button
              type="button"
              disabled={ctxSizeSaving()}
              class="rounded-control border border-dls-border bg-dls-surface-tint px-3 py-1.5 text-label font-medium text-dls-text hover:bg-dls-hover disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => void onApplyClick()}
            >
              {ctxSizeSaving()
                ? t("model.local_ctx_restarting")
                : t("model.local_ctx_apply")}
            </button>
            <button
              type="button"
              disabled={ctxSizeSaving() || (ctxSize() === null)}
              class="rounded-control border border-dls-border bg-transparent px-3 py-1.5 text-label font-medium text-dls-secondary hover:bg-dls-hover disabled:opacity-50 disabled:cursor-not-allowed"
              title={t("model.local_ctx_reset_title")}
              onClick={() => void onResetClick()}
            >
              {t("model.local_ctx_reset")}
            </button>
          </div>

          <div class="flex flex-wrap gap-1.5">
            {PRESETS.map((preset) => (
              <button
                type="button"
                disabled={ctxSizeSaving()}
                class={`rounded-control border px-2 py-0.5 text-tiny font-mono tabular-nums transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  applied() === preset
                    ? "border-dls-muted bg-dls-surface-muted text-dls-text"
                    : "border-dls-border bg-transparent text-dls-secondary hover:bg-dls-hover"
                }`}
                onClick={() => void onPresetClick(preset)}
              >
                {preset.toLocaleString()}
              </button>
            ))}
          </div>

          <div class="text-tiny text-dls-secondary">
            {t("model.local_ctx_description")}
          </div>
          <Show when={ctxSizeSaving()}>
            <div class="text-tiny text-dls-warning-text">
              {t("model.local_ctx_restarting_message")}
            </div>
          </Show>
          <Show when={error()}>
            <div class="text-tiny text-dls-danger-text">{error()}</div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
