import {
  Match,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Switch,
} from "solid-js";
import CloudModelSettings from "../components/cloud-model-settings";
import LocalCtxSizeSlider from "../components/local-ctx-size-slider";
import PerfWeightSlider from "../components/perf-weight-slider";
import { showLocalCtxSlider } from "../lib/experimental-flags";
import DenSettingsPanel from "../components/den-settings-panel";
import EdgeServerCard from "../components/edge-server-card";
import LocalModelConfig from "../components/local-model-config";
import ProviderConnectionCard from "../components/provider-connection-card";
import type { SettingsTab } from "../types";
import { t } from "../../i18n";
import AppSettingsTab from "./settings.app-tab";
import PrivacyTab from "./settings.privacy-tab";
import { createWorkspaceCleanup } from "./settings.workspace-cleanup";
import WorkspaceCleanupConfirmDialog from "./settings.workspace-cleanup-confirm";
import VoiceInputSettingsSection from "./settings.voice-input-section";
import type { SettingsViewProps } from "./settings.types";
import { pendingModelSection, pinSectionToTop, setPendingModelSection } from "./settings.model-section";

// Re-exported from the extracted helpers so this module's public surface is unchanged.
export type { SettingsViewProps } from "./settings.types";

export default function SettingsView(props: SettingsViewProps) {
  const [providerConnectError, setProviderConnectError] = createSignal<
    string | null
  >(null);
  const [cloudTestSuccessMessage, setCloudTestSuccessMessage] = createSignal<
    string | null
  >(null);
  const [edgeTestSuccessMessage, setEdgeTestSuccessMessage] = createSignal<
    string | null
  >(null);
  const [edgeConnectKey, setEdgeConnectKey] = createSignal(0);
  const handleOpenProviderAuth = async () => {
    if (props.busy || props.providerAuthBusy) return;
    setProviderConnectError(null);
    try {
      await props.openProviderAuthModal();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t("settings.providers_open_failed");
      setProviderConnectError(message);
    }
  };

  const availableTabs = createMemo<SettingsTab[]>(() => {
    const tabs: SettingsTab[] = ["app", "model", "privacy"];
    // Voice input needs the controller from the app shell; without it the page
    // would have no state to show, so the tab stays out rather than rendering
    // an inert panel. Note the tab itself is NOT Profile-gated: cloud voice
    // input predates the Profile and exists everywhere — only the on-device
    // option inside the page is gated.
    // General is first, matching the tab strip in dashboard.tsx. The developer
    // Cloud tab sits just after it.
    if (props.voice) tabs.push("voice");
    if (props.developerMode) tabs.splice(1, 0, "den");
    // The "debug" tab was unreachable from 470d33d07 (2026-07-08) and its markup
    // was deleted; recover it from that commit if the runtime debug report or the
    // service restart controls are ever wanted back.
    return tabs;
  });

  const activeTab = createMemo<SettingsTab>(() => {
    const tabs = availableTabs();
    return tabs.includes(props.settingsTab) ? props.settingsTab : "model";
  });

  createEffect(() => {
    if (props.settingsTab !== activeTab()) {
      props.setSettingsTab(activeTab());
    }
  });

  const cleanup = createWorkspaceCleanup({
    anyActiveRuns: () => props.anyActiveRuns,
  });

  // Opened from the pencil on a chat model picker row: the page opens with
  // that section's heading at the top, with no scroll animation.
  let localSectionEl: HTMLDivElement | undefined;
  let cloudSectionEl: HTMLDivElement | undefined;
  // Not an onCleanup inside the effect: clearing the pending section re-runs
  // the effect, which would stop the pin as soon as it started.
  let stopPin: (() => void) | undefined;
  createEffect(() => {
    const section = pendingModelSection();
    if (!section || activeTab() !== "model") return;
    setPendingModelSection(null);
    const target = section === "local" ? localSectionEl : cloudSectionEl;
    stopPin?.();
    stopPin = target ? pinSectionToTop(target) : undefined;
  });
  onCleanup(() => stopPin?.());

  let edgeServerCardEl: HTMLDivElement | undefined;
  let edgeServerHighlightTimer: ReturnType<typeof setTimeout> | undefined;
  const focusEdgeServerCard = () => {
    const target = edgeServerCardEl;
    if (!target) return;
    if (edgeServerHighlightTimer !== undefined)
      clearTimeout(edgeServerHighlightTimer);
    target.classList.remove("edge-server-card-attention");
    void target.offsetWidth;
    target.classList.add("edge-server-card-attention");
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => {
      const urlInput = target.querySelector<HTMLInputElement>(
        '[data-edge-server-url-input="true"]',
      );
      const keyInput = target.querySelector<HTMLInputElement>(
        '[data-edge-server-key-input="true"]',
      );
      const focusTarget =
        urlInput && !urlInput.value.trim()
          ? urlInput
          : keyInput && !keyInput.value.trim()
            ? keyInput
            : undefined;
      focusTarget?.focus({ preventScroll: true });
    }, 300);
    edgeServerHighlightTimer = setTimeout(
      () => target.classList.remove("edge-server-card-attention"),
      2800,
    );
  };

  return (
    <section class="space-y-6">
      <Switch>
        <Match when={activeTab() === "den"}>
          <DenSettingsPanel
            developerMode={props.developerMode}
            connectRemoteWorkspace={props.connectRemoteWorkspace}
          />
        </Match>

        <Match when={activeTab() === "model"}>
          <div class="space-y-6" data-testid="settings-model-content">
            <h2 class="text-display-lg font-bold text-dls-text">
              {t("settings.model_routing_title")}
            </h2>

            {/* ── Local: edge server or on-device llama.cpp ── */}
            <div ref={localSectionEl} data-settings-anchor="local_model" class="scroll-mt-6 space-y-3">
              <div class="text-label font-semibold uppercase tracking-wider text-dls-secondary">
                {t("local.section_title")}
              </div>
              <LocalModelConfig
                edgeConfigured={props.edgeConfigured}
                capability={props.primaryBundleCapability}
                localModelHealth={() => props.localModelHealth}
                llmRouter={props.llmRouterClient}
                onConnectLocal={
                  props.connectLocal &&
                  ((bundleId) => {
                    setEdgeTestSuccessMessage(null);
                    return props.connectLocal?.(bundleId) ?? Promise.resolve(false);
                  })
                }
                clearHintsKey={edgeConnectKey()}
                switchMessage={props.bundleSwitchMessage}
                switchError={props.bundleSwitchError}
                switchSteps={props.bundleSwitchSteps}
                applying={props.bundleSwitchApplying} canResume={props.bundleSwitchCanResume}
                onApply={props.onApplyBundleSwitch}
                onCancelSwitch={props.onCancelSwitch}
                edgeCard={
                  <div
                    ref={edgeServerCardEl}
                    id="edge-server-card"
                    tabIndex={-1}
                    class="scroll-mt-6 rounded-card focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--dls-accent-rgb)/0.35)]"
                  >
                    <EdgeServerCard
                      edgeConfigured={props.edgeConfigured}
                      edgeConnected={props.edgeConnected}
                      edgeBaseUrl={props.edgeBaseUrl}
                      edgeModelName={props.edgeModelName}
                      edgeBypassProxy={props.edgeBypassProxy}
                      testing={props.edgeTesting}
                      error={props.edgeError}
                      testSuccessMessage={
                        edgeTestSuccessMessage() ?? props.edgeUpdatedMessage
                      }
                      onTest={async (input) => {
                        setEdgeTestSuccessMessage(null);
                        try {
                          const models = await props.testEdgeConnection(input);
                          setEdgeTestSuccessMessage(
                            t("edge.test_connection_succeeded"),
                          );
                          return models;
                        } catch (error) {
                          setEdgeTestSuccessMessage(null);
                          throw error;
                        }
                      }}
                      onConnect={(input) => {
                        setEdgeTestSuccessMessage(null);
                        setEdgeConnectKey((key) => key + 1);
                        return props.connectEdge(input);
                      }}
                      switchMessage={props.bundleSwitchMessage}
                      switchError={props.bundleSwitchError}
                      switchSteps={props.bundleSwitchSteps ?? undefined}
                      applying={props.bundleSwitchApplying} canResume={props.bundleSwitchCanResume}
                      onApply={props.onApplyBundleSwitch}
                      onCancelSwitch={props.onCancelSwitch}
                      canDisconnect={props.edgeDisconnectAvailable}
                      disconnecting={props.edgeDisconnecting}
                      onDisconnect={
                        props.disconnectEdge &&
                        (() => {
                          setEdgeTestSuccessMessage(null);
                          return props.disconnectEdge?.() ?? Promise.resolve();
                        })
                      }
                    />
                  </div>
                }
              />
            </div>

            {/* ── Cloud: connected providers + cloud model ── */}
            <div ref={cloudSectionEl} data-settings-anchor="cloud_model" class="scroll-mt-6 space-y-3">
              <div class="text-label font-semibold uppercase tracking-wider text-dls-secondary">
                {t("model.cloud_label")}
              </div>
              <Show
                when={
                  (props.openworkServerHostInfo?.baseUrl ??
                    props.openworkServerUrl) ||
                  ""
                }
              >
                {(resolvedBaseUrl) => (
                  <ProviderConnectionCard>
                    <CloudModelSettings
                      hideLocalRow
                      providers={props.providers}
                      providerConnectedIds={props.providerConnectedIds}
                      cloudModel={props.cloudModel}
                      cloudModelHealthError={props.cloudModelHealthError}
                      loading={props.cloudModelLoading}
                      deleting={props.cloudModelDeleting}
                      testing={props.cloudModelTesting}
                      localModelHealth={props.localModelHealth}
                      edgeConfigured={props.edgeConfigured}
                      edgeModelName={props.edgeModelName}
                      onTestSuccessMessage={cloudTestSuccessMessage()}
                      onOpenProviderAuth={() => void handleOpenProviderAuth()}
                      onLoadModels={props.loadProviderModels}
                      onSave={props.saveCloudModel}
                      onDelete={props.deleteCloudModel}
                      onDisconnectProvider={props.disconnectProvider}
                      onCheckModel={(input) => {
                        setCloudTestSuccessMessage(null);
                        return props.testProviderConnection(input);
                      }}
                      onTest={async (input) => {
                        setCloudTestSuccessMessage(null);
                        try {
                          await props.testProviderConnection(input);
                          setCloudTestSuccessMessage(
                            t("settings.connection_test_succeeded"),
                          );
                        } catch (error) {
                          setCloudTestSuccessMessage(null);
                          throw error;
                        }
                      }}
                      onConfigureEdgeServer={focusEdgeServerCard}
                    />
                  </ProviderConnectionCard>
                )}
              </Show>
            </div>

            {/* ── Routing balance: quality vs. cost (applies to BOTH local + cloud) ── */}
            <PerfWeightSlider />

            {/* ── Local llama-server context-size override (INTERNAL EXPERIMENT) ── */}
            {/* Gated on the build-time env var VITE_SHOW_LOCAL_CTX_SLIDER so it
                can be hidden at release without touching the component. Default
                ON for internal builds; set `VITE_SHOW_LOCAL_CTX_SLIDER=0` (or
                "false"/"no"/"off") in the release build environment to hide.
                Truthy: "1"/"true"/"yes"/"on" (case-insensitive). Empty/unset
                uses the default (ON). */}
            <Show when={showLocalCtxSlider()}>
              <LocalCtxSizeSlider />
            </Show>
          </div>
        </Match>

        <Match when={activeTab() === "voice" && props.voice}>
          {(voice) => <VoiceInputSettingsSection voice={voice()} />}
        </Match>

        <Match when={activeTab() === "app"}>
          <AppSettingsTab
            busy={props.busy}
            themeMode={props.themeMode}
            setThemeMode={props.setThemeMode}
            language={props.language}
            setLanguage={props.setLanguage}
            updateStatus={props.updateStatus}
            updateEnv={props.updateEnv}
            checkForUpdates={props.checkForUpdates}
            openUpdateDownloadPage={props.openUpdateDownloadPage}
            fullTelemetryEnabled={props.fullTelemetryEnabled}
            setFullTelemetryEnabled={props.setFullTelemetryEnabled}
            baselineTelemetryEnabled={props.baselineTelemetryEnabled}
            setBaselineTelemetryEnabled={props.setBaselineTelemetryEnabled}
            resetInstallId={props.resetInstallId}
            resetInstallIdFeedback={props.resetInstallIdFeedback}
            keepBackendOnExit={props.keepBackendOnExit}
            setKeepBackendOnExit={props.setKeepBackendOnExit}
            cleanup={cleanup}
          />
        </Match>

        <Match when={activeTab() === "privacy"}>
          <PrivacyTab
            runtimeSettings={props.runtimeSettings}
            runtimeSettingsStatus={props.runtimeSettingsStatus}
            saveRuntimeSettings={props.saveRuntimeSettings}
            openworkServerStatus={props.openworkServerStatus}
            openworkServerWorkspaceId={props.openworkServerWorkspaceId}
          />
        </Match>
      </Switch>

      <WorkspaceCleanupConfirmDialog cleanup={cleanup} />
    </section>
  );
}
