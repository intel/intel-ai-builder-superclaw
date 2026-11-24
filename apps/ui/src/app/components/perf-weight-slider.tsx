import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";

import { readOpenworkServerSettings } from "../lib/openwork-server";
import { requestServiceHubJson } from "../lib/servicehub";
import { perfWeightVisible } from "../lib/settings-visibility";
import { fetchPerfWeight } from "~/shared/platform/capability/model-binding-activation-client";
import { useCapabilityGate } from "~/shared/platform/capability/capability-gate";
import { t } from "../../i18n";

type PerfWeightState = { perf_weight: number; supported: boolean };

// The last read, kept outside the component because Settings unmounts on every
// tab switch. A remount draws the section at once instead of popping it in when
// the read returns, so the Model page keeps one height and the scrollbar does
// not jump. `prefetchPerfWeight` fills it at start-up for the first visit.
// A signal, so the Settings search can tell whether the section is drawn.
const [cachedPerfWeight, setCachedPerfWeight] = createSignal<PerfWeightState | null>(null);

/** Whether the last read found a routing balance to set; the section is hidden otherwise. */
export const perfWeightSupported = (): boolean => cachedPerfWeight()?.supported === true;
let perfWeightReadGeneration = 0;
let perfWeightWrite: Promise<void> = Promise.resolve();
let pendingPerfWeightWrites = 0;
const [perfWeightSaving, setPerfWeightSaving] = createSignal(false);

const perfWeightHub = (): { baseUrl: string; token: string } | null => {
  const s = readOpenworkServerSettings();
  const baseUrl = s.hubUrl?.trim() ?? "";
  const token = s.hubToken?.trim() ?? "";
  return baseUrl && token ? { baseUrl, token } : null;
};

async function readPerfWeight(): Promise<PerfWeightState | null> {
  const h = perfWeightHub();
  if (!h) return null; // no control-plane creds yet — leave hidden
  const data = await fetchPerfWeight({ baseUrl: h.baseUrl, token: h.token });
  if (!data || typeof data.perf_weight !== "number" || typeof data.supported !== "boolean") return null;
  return { perf_weight: Math.min(1, Math.max(0, data.perf_weight)), supported: data.supported };
}

/** Read the balance ahead of the first Settings visit. Best-effort. */
export function prefetchPerfWeight(): void {
  const generation = perfWeightReadGeneration;
  void readPerfWeight()
    .then((data) => {
      if (data && generation === perfWeightReadGeneration) setCachedPerfWeight(data);
    })
    .catch(() => undefined);
}

/** Forget the cached read. Tests use it to start clean. */
export function resetPerfWeightCache(): void {
  setCachedPerfWeight(null);
  perfWeightReadGeneration = 0;
  perfWeightWrite = Promise.resolve();
  pendingPerfWeightWrites = 0;
  setPerfWeightSaving(false);
}

/**
 * PerfWeightSlider — the quality-vs-cost balance dial for AUTO routing.
 *
 * Standalone section (not inside the Cloud card) because perf_weight governs the
 * routing DECISION between local and cloud — it matters to both, so it lives as
 * its own section beneath Cloud rather than under a single provider.
 *
 * Self-contained: fetch/save GET/PUT /llm-router/v1/perf-weight through the
 * ServiceHub control plane. Auth uses the HUB url + HUB token (same as the
 * auto-router health probe) — NOT settings.token, which the hub proxy rejects.
 * `supported` is false when the active router has no perf_weight knob; the whole
 * section stays hidden in that case (and until the fetch succeeds).
 */
export default function PerfWeightSlider() {
  const [perfWeight, setPerfWeight] = createSignal(cachedPerfWeight()?.perf_weight ?? 0.7);
  const [supported, setSupported] = createSignal(cachedPerfWeight()?.supported ?? false);
  const [error, setError] = createSignal<string | null>(null);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  // The value a pending debounced save would send. Read by `onCleanup` to flush
  // it immediately instead of discarding it: Settings unmounts on
  // every navigation to chat, so a drag followed at once by "go to chat" must
  // still persist, not lose the change the debounce was waiting to send.
  let pendingValue: number | null = null;

  // Capability gating: the cloud-only Lite Profile hides this local/cloud
  // balancing control. Dark-safe:
  // when capability gating isn't active this is always false and behavior is
  // unchanged.
  const capability = useCapabilityGate();

  const fetchPerfWeight = async () => {
    const generation = ++perfWeightReadGeneration;
    try {
      await perfWeightWrite;
      const data = await readPerfWeight();
      if (generation === perfWeightReadGeneration && data) {
        setCachedPerfWeight(data);
        setPerfWeight(data.perf_weight);
        setSupported(data.supported);
      }
    } catch {
      // best-effort: leave the section hidden if the knob can't be read
    }
  };

  // The PUT itself, split from the debounce so `onCleanup` can send a pending
  // value through the same path with no timer involved.
  const putPerfWeight = (value: number) => {
    perfWeightReadGeneration += 1;
    pendingPerfWeightWrites += 1;
    setPerfWeightSaving(true);
    setError(null);
    const next = perfWeightWrite.then(async () => {
      const h = perfWeightHub();
      if (!h) return;
      await requestServiceHubJson(
        h.baseUrl,
        "/llm-router/v1/perf-weight",
        h.token,
        { method: "PUT", body: { perf_weight: value } },
      );
      setCachedPerfWeight({ perf_weight: value, supported: true });
    });
    perfWeightWrite = next.catch(() => undefined);
    void next.catch((err: unknown) => {
      setError(err instanceof Error ? err.message : t("model.perf_weight_save_failed"));
    }).finally(() => {
      pendingPerfWeightWrites -= 1;
      if (pendingPerfWeightWrites === 0) setPerfWeightSaving(false);
    });
    return next;
  };

  // Debounced save so dragging doesn't spam PUTs; persists + live-updates the
  // router via PUT /llm-router/v1/perf-weight.
  const savePerfWeight = (value: number) => {
    if (saveTimer) clearTimeout(saveTimer);
    pendingValue = value;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      pendingValue = null;
      void putPerfWeight(value);
    }, 400);
  };

  onMount(() => {
    void fetchPerfWeight();
  });
  // Releasing the Lite gate must RE-READ the authoritative routing balance
  // because the switch does not touch this
  // signal.
  // The slider lives in the Settings tab the switch runs from, so it never
  // remounts and `onMount` never re-fetches — the section would un-hide at 1.
  let wasForceCloud = false;
  createEffect(() => {
    const forceCloud = capability.forceCloudRouting();
    if (forceCloud) {
      perfWeightReadGeneration += 1;
      setSupported(false);
    } else if (wasForceCloud) {
      setSupported(false);
      // Until the re-read lands the section is hidden, and the search must agree.
      setCachedPerfWeight(null);
      void fetchPerfWeight();
    }
    wasForceCloud = forceCloud;
  });
  onCleanup(() => {
    perfWeightReadGeneration += 1;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      // Flush rather than discard: a drag immediately followed by "go to chat"
      // must not lose the change the debounce was waiting to send.
      if (pendingValue !== null) {
        const value = pendingValue;
        pendingValue = null;
        void putPerfWeight(value);
      }
    }
  });

  return (
    <Show when={supported() && perfWeightVisible(capability)}>
      <div data-settings-anchor="perf_weight" class="space-y-3">
        <div class="text-label font-semibold uppercase tracking-wider text-dls-secondary">
          {t("model.perf_weight_section")}
        </div>
        <div class="bg-dls-panel-bg border border-dls-panel-border rounded-card p-5 space-y-2">
          <div class="flex items-center justify-between gap-2">
            <span class="text-label font-medium text-dls-secondary">
              {t("model.perf_weight_title")}
            </span>
            <span class="text-caption font-mono text-dls-text tabular-nums">
              {perfWeight().toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={perfWeight()}
            disabled={perfWeightSaving()}
            class="w-full cursor-pointer disabled:opacity-50"
            onInput={(e) => setPerfWeight(Number(e.currentTarget.value))}
            onChange={(e) => savePerfWeight(Number(e.currentTarget.value))}
          />
          <div class="flex items-center justify-between text-tiny text-dls-secondary">
            <span>{t("model.perf_weight_cost")}</span>
            <span>{t("model.perf_weight_quality")}</span>
          </div>
          <Show when={error()}>
            <div class="text-tiny text-dls-danger-text">{error()}</div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
