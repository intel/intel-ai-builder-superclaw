import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import ToggleSwitch from "~/shared/ui/toggle-switch";
import { useCapabilityGate } from "~/shared/platform/capability/capability-gate";
import { readOpenworkServerSettings } from "../lib/openwork-server";
import { requestServiceHubJson } from "../lib/servicehub";
import PrivacyModelDownloadDialog from "./privacy-model-download-dialog";
import {
  getPrivacyModelsHealth,
  preparePrivacyModels,
} from "~/shared/platform/transport/privacy-models";
import { isTauriRuntime } from "../utils";
import { t } from "../../i18n";
import { Trash2, FolderOpen } from "lucide-solid";

// Prefix every console message from this settings panel.
const TAG = "[SecuritySettings]";

/**
 * Settings panel for file and text data protection.
 *
 * These controls talk to llmrouter_manager through ServiceHub:
 *  - File protection mode: none | deterministic | hybrid | llm
 *  - Hybrid threshold: number from 0 to 1, shown only for hybrid mode
 *
 * Each endpoint returns both the stored value and the effective `applied` value.
 * If the backend says data protection is unsupported, this whole section stays hidden.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

type Mode = "none" | "deterministic" | "hybrid" | "llm";
type Source = "store" | "default";

/** Response from GET/PUT /data-protection/mode. */
interface ModeState {
  mode: Mode | null;
  applied: Mode;
  source: Source;
  supported: boolean;
}

interface SensitiveFileEntry {
  name: string;
  path: string;
  size: number;
  modified_ms?: number | null;
}

// The UI exposes file protection as a simple on/off switch: ON writes "hybrid"
// (the recommended default), OFF writes "none". The backend still accepts all
// four modes, so a stored "deterministic"/"llm" value is read back as ON —
// protection really is running, and rendering it as OFF would be misleading.
const MODE_ON: Mode = "hybrid";
const MODE_OFF: Mode = "none";

// ─── Component ────────────────────────────────────────────────────────────────

export type SecuritySettingsAvailability = "supported" | "unsupported" | "unavailable";

// The last settled read, kept past unmount so the Settings search knows
// whether the card is drawn. Null while a read is in flight or none has
// answered, which the card draws as shown.
const [lastAvailability, setLastAvailability] = createSignal<SecuritySettingsAvailability | null>(null);
// Bumped by each read the card starts, so a start-up read landing later does not override it.
let availabilityReadGeneration = 0;

/** False once a read has hidden the card; it shows while loading, so true before any answer. */
export const fileProtectionShown = (): boolean => {
  const availability = lastAvailability();
  return availability === null || availability === "supported";
};

/**
 * Ask whether file protection is supported when Settings opens, so its search
 * does not depend on Privacy having been opened.
 * Best-effort: a failed read leaves the card counted as shown, as it draws.
 */
export function prefetchFileProtection(): void {
  const s = readOpenworkServerSettings();
  const baseUrl = s.hubUrl?.trim() ?? "";
  const token = s.hubToken?.trim() ?? "";
  if (!baseUrl || !token) return;
  const generation = availabilityReadGeneration;
  void requestServiceHubJson<ModeState>(baseUrl, "/llm-router/v1/data-protection/mode", token)
    .then((m) => {
      if (generation !== availabilityReadGeneration || typeof m?.supported !== "boolean") return;
      setLastAvailability(m.supported ? "supported" : "unsupported");
    })
    .catch(() => undefined);
}

export type SecuritySettingsSectionProps = {
  /**
   * Called once loading settles: "unsupported" when the backend says data
   * protection is off for this install, "unavailable" when it could not be read.
   */
  onAvailabilityChange?: (availability: SecuritySettingsAvailability) => void;
};

export default function SecuritySettingsSection(
  props: SecuritySettingsSectionProps = {},
) {
  const capability = useCapabilityGate();
  let sensitiveDropRef: HTMLButtonElement | undefined;
  let unlistenSensitiveDrop: (() => void) | undefined;
  let sensitiveSuccessTimer: ReturnType<typeof setTimeout> | undefined;
  // The file dialog is modal, but two clicks can land before it appears.
  let choosingSensitiveFiles = false;

  // Null means the matching backend setting has not loaded yet.
  const [modeState, setModeState] = createSignal<ModeState | null>(null);

  // One save flag covers all controls so concurrent writes cannot overlap.
  const [saving, setSaving] = createSignal(false);

  const [modelDownloadOpen, setModelDownloadOpen] = createSignal(false);
  const [modelDownloadPhase, setModelDownloadPhase] =
    createSignal<"consent" | "downloading" | "ready">("consent");
  const [modelDownloadDone, setModelDownloadDone] = createSignal(0);
  const [modelDownloadTotal, setModelDownloadTotal] = createSignal(0);
  const [modelDownloadError, setModelDownloadError] = createSignal<string | null>(null);
  let modelPollTimer: ReturnType<typeof setTimeout> | undefined;
  let modelReadyTimer: ReturnType<typeof setTimeout> | undefined;
  let modelPollGeneration = 0;

  // Last save error shown below the card.
  const [error, setError] = createSignal<string | null>(null);
  // The request failed or the hub is not configured. Distinct from "still loading".
  const [unavailable, setUnavailable] = createSignal(false);

  const [sensitiveBusy, setSensitiveBusy] = createSignal(false);
  const [sensitiveDragging, setSensitiveDragging] = createSignal(false);
  const [sensitiveError, setSensitiveError] = createSignal<string | null>(null);
  const [sensitiveSuccess, setSensitiveSuccess] = createSignal<string | null>(
    null,
  );

  const [sensitiveFiles, setSensitiveFiles] = createSignal<SensitiveFileEntry[]>([])
  const [deleteError, setDeleteError] = createSignal<string | null>(null)

  const visibleSensitiveFiles = () => sensitiveFiles();
  const hasMoreSensitiveFiles = () => sensitiveFiles().length > 3;

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Read the ServiceHub URL and token saved in app settings.
   * Return null when either value is missing; callers then skip the request.
   */
  const hub = (): { baseUrl: string; token: string } | null => {
    const s = readOpenworkServerSettings();
    const baseUrl = s.hubUrl?.trim() ?? "";
    const token = s.hubToken?.trim() ?? "";
    if (!baseUrl || !token) {
      console.warn(
        `${TAG} ServiceHub URL or token not configured — skipping fetch`,
      );
      return null;
    }
    return { baseUrl, token };
  };

  /**
   * Show a label only when the value was explicitly saved.
   * Default backend values are left unlabeled to keep the UI quiet.
   */
  const sourceLabel = (s: Source): string => {
    switch (s) {
      case "store":
        return t("security.source_store");
      default:
        return "";
    }
  };

  /**
   * Keep the card on screen while the mode request is in flight. Hide it only
   * when the backend says protection is unsupported, or when the request cannot
   * be made. Waiting to mount the card is what made the Privacy tab look empty.
   */
  const showSection = () => {
    if (unavailable()) return false;
    const supported = modeState()?.supported;
    return supported !== false;
  };

  createEffect(() => {
    const state = modeState();
    if (!state) return;
    const availability = state.supported ? "supported" : "unsupported";
    setLastAvailability(availability);
    props.onAvailabilityChange?.(availability);
  });

  /** Any mode other than "none" means protection is active. */
  const isOn = () => {
    const applied = modeState()?.applied;
    return applied !== undefined && applied !== MODE_OFF;
  };

  /** Show the agents that support file protection mode for the pro product profile. */
  const showSupportedAgents = () => capability.productProfileId() === "pro";

  // ── Data fetching ─────────────────────────────────────────────────────────

  const markUnavailable = () => {
    setUnavailable(true);
    setLastAvailability("unavailable");
    props.onAvailabilityChange?.("unavailable");
  };

  /** Load the file-protection mode. This card does not render the other settings. */
  const fetchAll = async () => {
    // The card shows while this read is in flight, so the search offers it too.
    availabilityReadGeneration += 1;
    setLastAvailability(null);
    const h = hub();
    if (!h) {
      markUnavailable();
      return;
    }

    console.log(`${TAG} Fetching data-protection settings from ServiceHub`);

    // Mode is the only value this card renders.
    try {
      const m = await requestServiceHubJson<ModeState>(
        h.baseUrl,
        "/llm-router/v1/data-protection/mode",
        h.token,
      );

      if (m && typeof m.supported === "boolean") {
        console.log(
          `${TAG} Mode loaded — applied: ${m.applied}, source: ${m.source}, supported: ${m.supported}`,
        );
        setModeState(m);
      } else {
        markUnavailable();
      }
    } catch (err) {
      console.warn(`${TAG} Failed to fetch data-protection settings:`, err);
      markUnavailable();
    }
  };

  const fetchSensitiveFiles = async () => {
    if (!isTauriRuntime()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      const files = await invoke<SensitiveFileEntry[]>("sensitive_files_list")
      setSensitiveFiles(files)
    } catch (err) {
      console.warn(`${TAG} Failed to list sensitive files:`, err)
    }
  }

  // ── Mutation handlers ─────────────────────────────────────────────────────

  /**
   * Save a new file-protection mode.
   * Use the backend response as the source of truth in case it normalizes or
   * applies a different value than the one requested.
   */
  const applyMode = async (m: Mode): Promise<boolean> => {
    const h = hub();
    if (!h) return false;

    console.log(`${TAG} Applying mode: ${m}`);
    setSaving(true);
    setError(null);

    try {
      const data = await requestServiceHubJson<ModeState>(
        h.baseUrl,
        "/llm-router/v1/data-protection/mode",
        h.token,
        { method: "PUT", body: { mode: m } },
      );
      if (data && typeof data.supported === "boolean") {
        console.log(
          `${TAG} Mode saved — applied: ${data.applied}, source: ${data.source}`,
        );
        setModeState(data);
        return true;
      }
      return false;
    } catch (err) {
      console.error(`${TAG} Failed to save mode "${m}":`, err);
      setError(err instanceof Error ? err.message : t("security.save_failed"));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const stopModelHealthPolling = () => {
    modelPollGeneration += 1;
    if (modelPollTimer !== undefined) clearTimeout(modelPollTimer);
    if (modelReadyTimer !== undefined) clearTimeout(modelReadyTimer);
    modelPollTimer = undefined;
    modelReadyTimer = undefined;
  };

  const pollPrivacyModels = async (generation: number, consecutiveFailures = 0) => {
    const h = hub();
    if (!h) {
      setModelDownloadError(t("security.model_download_status_failed"));
      return;
    }

    try {
      const health = await getPrivacyModelsHealth(h.baseUrl, h.token);
      if (generation !== modelPollGeneration) return;
      setModelDownloadDone(health.models_done_bytes);
      setModelDownloadTotal(health.models_total_bytes);

      if (health.models_state === "ready" && !health.models_present) {
        setModelDownloadError(t("security.model_download_unverified_models"));
        return;
      }
      if (health.models_state === "ready" && health.models_present) {
        const saved = await applyMode(MODE_ON);
        if (generation !== modelPollGeneration) return;
        if (!saved) {
          setModelDownloadError(error() ?? t("security.save_failed"));
          return;
        }
        setModelDownloadPhase("ready");
        modelReadyTimer = setTimeout(() => {
          setModelDownloadOpen(false);
          setModelDownloadPhase("consent");
        }, 1600);
        return;
      }
      if (health.models_state === "failed") {
        setModelDownloadError(t("security.model_download_try_later"));
        return;
      }
      if (health.models_state === "disabled" || health.models_state === "unsupported") {
        setModelDownloadError(
          health.models_error ?? t("security.model_download_unavailable"),
        );
        return;
      }
      modelPollTimer = setTimeout(() => {
        void pollPrivacyModels(generation);
      }, 1000);
    } catch (err) {
      if (generation !== modelPollGeneration) return;
      const failures = consecutiveFailures + 1;
      if (failures >= 15) {
        setModelDownloadError(
          err instanceof Error ? err.message : t("security.model_download_status_failed"),
        );
        return;
      }
      modelPollTimer = setTimeout(() => {
        void pollPrivacyModels(generation, failures);
      }, 1000);
    }
  };

  const requestModeChange = async (enable: boolean) => {
    if (!enable) {
      void applyMode(MODE_OFF);
      return;
    }

    const h = hub();
    if (!h) return;
    setSaving(true);
    setError(null);
    try {
      const health = await getPrivacyModelsHealth(h.baseUrl, h.token);
      if (health.models_present) {
        await applyMode(MODE_ON);
        return;
      }
      setModelDownloadError(null);
      setModelDownloadPhase("consent");
      setModelDownloadOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("security.model_download_status_failed"));
    } finally {
      setSaving(false);
    }
  };

  const confirmModelDownload = async () => {
    setModelDownloadError(null);
    setModelDownloadPhase("downloading");
    const h = hub();
    if (!h) {
      setModelDownloadError(t("security.model_download_status_failed"));
      return;
    }
    try {
      await preparePrivacyModels(h.baseUrl, h.token);
    } catch (err) {
      setModelDownloadError(
        err instanceof Error ? err.message : t("security.model_download_status_failed"),
      );
      return;
    }
    stopModelHealthPolling();
    const generation = modelPollGeneration;
    void pollPrivacyModels(generation);
  };

  const cancelModelDownload = () => {
    stopModelHealthPolling();
    setModelDownloadOpen(false);
    setModelDownloadError(null);
    setModelDownloadPhase("consent");
  };

  /**
   * Import files into the user-facing "sensitive" folder.
   * Files placed there are blocked from raw access by the build agent's
   * terminal guard (Guard SENSITIVE_FOLDER_ACCESS in
   * 93_protected_pipeline_terminal_guard.ts) and the external_directory deny
   * rule in opencode.jsonc — only reachable through protected-file-agent's
   * masking pipeline.
   */
  const importSensitivePaths = async (paths: string[]) => {
    if (!isTauriRuntime() || paths.length === 0) return;
    const names = paths.map((p) => p.split(/[\\/]/).pop() ?? p);
    const label = t("security.sensitive_folder_import_success").replace(
      "{name}",
      names.join(", "),
    );
    setSensitiveBusy(true);
    setSensitiveError(null);
    setSensitiveSuccess(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const updated = await invoke<SensitiveFileEntry[]>("sensitive_files_import", { paths });
      setSensitiveFiles(updated)
      setSensitiveSuccess(label);
      if (sensitiveSuccessTimer !== undefined) clearTimeout(sensitiveSuccessTimer);
      sensitiveSuccessTimer = setTimeout(() => setSensitiveSuccess(null), 4000);
    } catch (err) {
      setSensitiveError(
        err instanceof Error
          ? err.message
          : t("security.sensitive_folder_import_failed"),
      );
    } finally {
      setSensitiveBusy(false);
    }
  };

  const chooseSensitiveFiles = async () => {
    if (sensitiveBusy() || choosingSensitiveFiles) return;
    if (!isTauriRuntime()) {
      setSensitiveError(t("security.sensitive_folder_desktop_only"));
      return;
    }
    choosingSensitiveFiles = true;
    setSensitiveError(null);
    try {
      const { pickFile } = await import("~/shared/platform/tauri/tauri.local-files");
      const picked = await pickFile({
        title: t("security.sensitive_folder_choose"),
        multiple: true,
      });
      if (picked == null) return;
      const paths = (Array.isArray(picked) ? picked : [picked]).filter(
        (path) => path.length > 0,
      );
      if (paths.length === 0) return;
      await importSensitivePaths(paths);
    } catch (err) {
      setSensitiveError(
        err instanceof Error
          ? err.message
          : t("security.sensitive_folder_import_failed"),
      );
    } finally {
      choosingSensitiveFiles = false;
    }
  };

  const openSensitiveFolder = async () => {
    const first = sensitiveFiles()[0]
    if (!first) return;
    try {
      const { revealItemInDir, openPath } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(first.path).catch(() => openPath(first.path));
    } catch (err) {
      console.warn(`${TAG} Failed to open sensitive folder:`, err)
    }
  }

  const deleteSensitiveFile = async (name: string) => {
    if (!isTauriRuntime()) return;
    setDeleteError(null)
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const updated = await invoke<SensitiveFileEntry[]>("sensitive_files_delete", { name });
      setSensitiveFiles(updated);
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : t("security.sensitive_folder_remove_failed"),
      )
    }
  };

  const fileDropPaths = (event: DragEvent): string[] =>
    Array.from(event.dataTransfer?.files ?? [])
      .map((file) => (file as File & { path?: string }).path ?? "")
      .filter((path) => path.length > 0);

  const handleSensitiveDrop = (event: DragEvent) => {
    event.preventDefault();
    setSensitiveDragging(false);
    const paths = fileDropPaths(event);
    if (paths.length === 0) {
      setSensitiveError(t("security.sensitive_folder_drop_unavailable"));
      return;
    }
    void importSensitivePaths(paths);
  };

  const isInsideSensitiveDrop = (position?: {
    x: number;
    y: number;
  }): boolean => {
    const dropTarget = sensitiveDropRef;
    if (!dropTarget || !position) return false;
    // Tauri reports the pointer in physical pixels; DOM geometry is in CSS
    // pixels. window.devicePixelRatio is the physical→CSS ratio the webview
    // actually renders at (Tauri's window scaleFactor can disagree under RDP).
    const ratio = window.devicePixelRatio || 1;
    const x = position.x / ratio;
    const y = position.y / ratio;
    // elementFromPoint uses viewport CSS coords, so it handles scrolling for us.
    const hit = document.elementFromPoint(x, y);
    return hit != null && dropTarget.contains(hit);
  };

  const installSensitiveDropListener = async () => {
    if (!isTauriRuntime()) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      unlistenSensitiveDrop = await win.onDragDropEvent(
        (event: unknown) => {
          const payload = (
            event as {
              payload?: {
                type?: string;
                paths?: string[];
                position?: { x: number; y: number };
              };
            }
          ).payload;
          if (payload?.type === "enter" || payload?.type === "over") {
            setSensitiveDragging(isInsideSensitiveDrop(payload.position));
            return;
          }
          if (payload?.type === "leave") {
            setSensitiveDragging(false);
            return;
          }
          if (payload?.type === "drop") {
            setSensitiveDragging(false);
            if (isInsideSensitiveDrop(payload.position)) {
              void importSensitivePaths(payload.paths ?? []);
            }
          }
        },
      );
    } catch {
      // Best-effort listener setup; ignore failures.
    }
  };

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  onMount(() => {
    void fetchAll();
    void fetchSensitiveFiles();
    void installSensitiveDropListener();
  });

  onCleanup(() => {
    stopModelHealthPolling();
    unlistenSensitiveDrop?.();
    if (sensitiveSuccessTimer !== undefined) clearTimeout(sensitiveSuccessTimer);
  });

  return (
    <Show when={showSection()}>
      <div data-settings-anchor="file_protection" class="bg-dls-panel-bg border border-dls-panel-border rounded-card p-5 space-y-4">
        <div>
          <div class="text-body-lg font-medium text-dls-text">
            {t("security.section")}
          </div>
          <div class="text-caption text-dls-secondary mt-1 space-y-0.5">
            <div>
              <span class="font-medium text-dls-secondary">
                {t("security.supported_files_label")}
              </span>{" "}
              {t("security.supported_files_value")}
            </div>
            <Show when={showSupportedAgents()}>
              <div>
                <span class="font-medium text-dls-secondary">
                  {t("security.supported_agents_label")}
                </span>{" "}
                {t("security.supported_agents_value")}
              </div>
            </Show>
          </div>
        </div>

        {/* File protection mode */}
        <div data-settings-anchor="protection_mode" class="space-y-2">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0 space-y-0.5">
              <div class="flex items-center gap-2">
                <span class="text-caption font-medium text-dls-secondary">
                  {t("security.mode_title")}
                </span>
                <Show when={modeState()}>
                  <span
                    class={`inline-flex items-center gap-1.5 rounded-pill border px-2 py-0.5 text-tiny font-semibold transition-colors duration-150 ${
                      isOn()
                        ? "border-dls-success-border bg-dls-success-bg text-dls-success-text"
                        : "border-dls-panel-inset-border bg-dls-panel-inset-bg text-dls-secondary"
                    }`}
                  >
                    <span
                      class={`h-1.5 w-1.5 rounded-pill ${isOn() ? "bg-dls-success-dot" : "bg-dls-panel-dot"}`}
                      aria-hidden="true"
                    />
                    {t("security.applied_prefix")} {modeState()!.applied}
                    <Show when={sourceLabel(modeState()!.source)}>
                      <span>· {sourceLabel(modeState()!.source)}</span>
                    </Show>
                  </span>
                </Show>
              </div>
              <Show when={modeState()}>
                {(state) => (
                  <div class="text-caption text-dls-secondary">
                    {t(`security.mode_${state().applied}_description`)}
                  </div>
                )}
              </Show>
            </div>
            <Show when={modeState()}>
              <div class="shrink-0">
                <ToggleSwitch
                  checked={isOn()}
                  disabled={saving() || modelDownloadOpen()}
                  onChange={(next) => void requestModeChange(next)}
                  aria-label={t("security.mode_title")}
                />
              </div>
            </Show>
          </div>
          <Show when={error()}>
            <div class="text-caption text-dls-danger-text">{error()}</div>
          </Show>
        </div>

        {/* Sensitive files folder */}
        <div data-settings-anchor="sensitive_folder" class="space-y-2 border-t border-dls-panel-divider pt-4">
          <div>
            <div class="text-caption font-medium text-dls-secondary">
              {t("security.sensitive_folder_title")}
            </div>
            <div class="text-caption text-dls-secondary">
              {t(
                capability.productProfileId() === "lite"
                  ? "security.sensitive_folder_description_lite"
                  : "security.sensitive_folder_description",
              )}
            </div>
          </div>
          <Show when={isTauriRuntime()}>
            <details class="rounded-inset border border-dls-panel-inset-border bg-dls-panel-inset-bg px-3 py-2 group">
                <summary class="text-caption text-dls-secondary cursor-pointer select-none list-none flex items-center gap-1.5">
                  <span class="inline-block transition-transform group-open:rotate-90">▸</span>
                  <span class="text-dls-secondary font-medium">
                    {t("security.sensitive_folder_list_title")} ({sensitiveFiles().length})
                  </span>
                   <Show when={hasMoreSensitiveFiles()}>
                    <button
                      type="button"
                      class="ml-auto inline-flex items-center gap-1 rounded-control border border-dls-panel-inset-border bg-dls-panel-hover-bg px-2 py-0.5 text-label text-dls-secondary hover:bg-dls-panel-hover-bg hover:border-dls-panel-border transition-colors shrink-0"
                      onClick={(e) => { e.preventDefault(); void openSensitiveFolder(); }}
                    >
                      <FolderOpen size={11} />
                      {t("security.sensitive_folder_view_all")}
                    </button>
                  </Show>
                </summary>
                <div class="mt-2 space-y-1">
                  <Show
                    when={sensitiveFiles().length > 0}
                    fallback={
                      <div class="text-caption text-dls-secondary py-1">
                        {t("security.sensitive_folder_empty")}
                      </div>
                    }
                  >
                    <ul class="space-y-1 max-h-24 overflow-y-auto pr-0.5">
                      <For each={visibleSensitiveFiles()}>
                        {(file) => (
                          <li class="rounded-control bg-dls-panel-input-bg border border-dls-panel-inset-border px-2.5 py-1.5 flex items-center justify-between gap-2">
                            <div class="min-w-0">
                              <div class="text-label text-dls-text font-mono truncate" title={file.name}>
                                {file.name}
                              </div>
                            </div>
                            <button
                              type="button"
                              class="shrink-0 text-label text-dls-secondary hover:text-dls-danger-text transition-colors"
                              onClick={() => void deleteSensitiveFile(file.name)}
                            >
                              <Trash2 size={13} />
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                  <Show when={deleteError()}>
                    <div class="text-caption text-dls-danger-text">{deleteError()}</div>
                  </Show>
                </div>
            </details>
          </Show>
          <button
            type="button"
            ref={sensitiveDropRef}
            class={`flex w-full flex-col items-center justify-center gap-1 rounded-control border border-dashed px-3 py-4 text-center transition-colors ${
              sensitiveBusy() ? "cursor-wait" : "cursor-pointer"
            } ${
              sensitiveDragging()
                ? "border-dls-warning-border bg-dls-warning-bg text-dls-warning-text"
                : "border-dls-panel-input-border bg-dls-panel-input-bg text-dls-secondary hover:border-dls-panel-border"
            }`}
            onClick={() => void chooseSensitiveFiles()}
            onDragEnter={(event) => {
              event.preventDefault();
              setSensitiveDragging(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
            }}
            onDragLeave={() => setSensitiveDragging(false)}
            onDrop={handleSensitiveDrop}
          >
            <span class="text-caption font-medium text-dls-secondary">
              {sensitiveBusy()
                ? t("security.sensitive_folder_importing")
                : t("security.sensitive_folder_drop")}
            </span>
            <span class="text-label font-medium text-dls-secondary">
              {t("security.sensitive_folder_click")}
            </span>
          </button>
          <Show when={sensitiveError()}>
            <div class="text-caption text-dls-danger-text">{sensitiveError()}</div>
          </Show>
          <Show when={sensitiveSuccess()}>
            <div class="rounded-control border border-dls-success-border bg-dls-success-bg px-2.5 py-1.5 text-caption text-dls-success-text">
              {sensitiveSuccess()}
            </div>
          </Show>
        </div>
        <div class="text-caption text-dls-secondary">
          {t("security.section_description")}
        </div>
      </div>
      <PrivacyModelDownloadDialog
        open={modelDownloadOpen()}
        phase={modelDownloadPhase()}
        doneBytes={modelDownloadDone()}
        totalBytes={modelDownloadTotal()}
        error={modelDownloadError()}
        onConfirm={() => void confirmModelDownload()}
        onCancel={cancelModelDownload}
      />
    </Show>
  );
}
