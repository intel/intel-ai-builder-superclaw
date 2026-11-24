import { For, Match, Show, Switch, createEffect, createSignal, onCleanup } from "solid-js";
import type { OnboardingStep, StartupPreference } from "../types";
import type { WorkspaceInfo } from "../lib/tauri";
import { CheckCircle2, ChevronDown, Circle, Globe } from "lucide-solid";

import Button from "../components/button";
import OnboardingWorkspaceSelector from "../components/onboarding-workspace-selector";
import TextInput from "../components/text-input";
import { isTauriRuntime, isWindowsPlatform } from "../utils/index";
import { currentLocale, t } from "../../i18n";

export type OnboardingViewProps = {
  startupPreference: StartupPreference | null;
  onboardingStep: OnboardingStep;
  rememberStartupChoice: boolean;
  busy: boolean;
  clientDirectory: string;
  openworkHostUrl: string;
  openworkToken: string;
  newAuthorizedDir: string;
  authorizedDirs: string[];
  activeWorkspacePath: string;
  workspaces: WorkspaceInfo[];
  localHostLabel: string;
  engineRunning: boolean;
  engineBaseUrl: string | null;
  engineDoctorFound: boolean | null;
  engineDoctorSupportsServe: boolean | null;
  engineDoctorVersion: string | null;
  engineDoctorResolvedPath: string | null;
  engineDoctorNotes: string[];
  engineDoctorServeHelpStdout: string | null;
  engineDoctorServeHelpStderr: string | null;
  engineDoctorCheckedAt: number | null;
  engineInstallLogs: string | null;
  error: string | null;
  canRepairMigration: boolean;
  migrationRepairUnavailableReason: string | null;
  migrationRepairBusy: boolean;
  migrationRepairResult: { ok: boolean; message: string } | null;
  developerMode: boolean;
  isWindows: boolean;
  onClientDirectoryChange: (value: string) => void;
  onOpenworkHostUrlChange: (value: string) => void;
  onOpenworkTokenChange: (value: string) => void;
  onSelectStartup: (mode: StartupPreference) => void;
  onRememberStartupToggle: () => void;
  onStartHost: () => void;
  onRepairMigration: () => void;
  onCreateWorkspace: (preset: "starter" | "automation" | "minimal", folder: string | null) => void;
  onPickWorkspaceFolder: () => Promise<string | null>;
  onImportWorkspaceConfig: () => void;
  importingWorkspaceConfig: boolean;
  onAttachHost: () => void;
  onConnectClient: () => void;
  onBackToWelcome: () => void;
  onSetAuthorizedDir: (value: string) => void;
  onAddAuthorizedDir: () => void;
  onAddAuthorizedDirFromPicker: () => void;
  onRemoveAuthorizedDir: (index: number) => void;
  onRefreshEngineDoctor: () => void;
  onInstallEngine: () => void;
  onShowSearchNotes: () => void;
  onOpenSettings: () => void;
  themeMode: "light" | "dark" | "system";
  setThemeMode: (value: "light" | "dark" | "system") => void;
};

export default function OnboardingView(props: OnboardingViewProps) {
  // Translation helper that uses current language from i18n
  const translate = (key: string) => t(key, currentLocale());
  const [openworkTokenVisible, setOpenworkTokenVisible] = createSignal(false);
  const [connectingFallbackVisible, setConnectingFallbackVisible] = createSignal(false);

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (props.onboardingStep !== "connecting") {
      setConnectingFallbackVisible(false);
      return;
    }
    setConnectingFallbackVisible(false);
    const timer = window.setTimeout(() => setConnectingFallbackVisible(true), 4_000);
    onCleanup(() => window.clearTimeout(timer));
  });

  const engineDoctorAvailable = () =>
    props.engineDoctorFound === true && props.engineDoctorSupportsServe === true;

  const engineStatusLabel = () => {
    if (props.engineDoctorFound == null || props.engineDoctorSupportsServe == null) {
      return translate("onboarding.checking_cli");
    }
    if (!props.engineDoctorFound) return translate("onboarding.cli_not_found");
    if (!props.engineDoctorSupportsServe) return translate("onboarding.cli_needs_update");
    if (props.engineDoctorVersion) {
      return translate("onboarding.cli_version").replace("{version}", props.engineDoctorVersion);
    }
    return translate("onboarding.cli_ready");
  };

  const serveHelpOutput = () => {
    const parts = [
      props.engineDoctorServeHelpStdout,
      props.engineDoctorServeHelpStderr,
    ].filter((value): value is string => Boolean(value && value.trim()));
    return parts.join("\n\n");
  };

  return (
    <Switch>
      <Match when={props.onboardingStep === "connecting"}>
        <div class="min-h-screen flex flex-col items-center justify-center bg-dls-surface-solid text-dls-text p-6 relative overflow-hidden">
          <div class="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-dls-surface-raised via-dls-surface-solid to-dls-surface-solid opacity-50" />
          <div class="z-10 flex flex-col items-center gap-6">
            <div class="relative">
              <img src="/icon.png" alt="SuperClaw" width={40} height={40} class="select-none pointer-events-none" />
            </div>
            <div class="text-center">
              <h2 class="text-heading-lg font-medium mb-2">
                {props.startupPreference === "local"
                  ? translate("onboarding.starting_host")
                  : translate("onboarding.searching_host")}
              </h2>
              <p class="text-dls-secondary text-body-lg">
                {props.startupPreference === "local"
                  ? translate("onboarding.getting_ready")
                  : translate("onboarding.verifying")}
              </p>

              <Show when={props.error}>
                <div class="mt-4 rounded-card bg-dls-danger-bg px-5 py-4 text-body-lg text-dls-danger-text border border-dls-danger-border text-left">
                  {props.error}
                </div>
              </Show>

              <Show when={connectingFallbackVisible()}>
                <div class="mt-5 flex items-center justify-center gap-2">
                  <Button variant="secondary" onClick={props.onOpenSettings} disabled={props.busy}>
                    {translate("onboarding.open_settings")}
                  </Button>
                  <Button variant="ghost" onClick={props.onBackToWelcome} disabled={props.busy}>
                    {translate("onboarding.back")}
                  </Button>
                </div>
                <div class="mt-3 text-caption text-dls-secondary">{translate("onboarding.open_settings_hint")}</div>
              </Show>

            </div>
          </div>
        </div>
      </Match>

      <Match when={props.onboardingStep === "local"}>
        <div class="min-h-screen flex flex-col items-center justify-center bg-dls-surface-solid text-dls-text p-6 relative">
          <div class="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-dls-surface-raised to-transparent opacity-20 pointer-events-none" />

          <div class="max-w-lg w-full z-10 space-y-6">
              <div class="text-center space-y-2">
                <div class="">
                  <img src="/icon.png" alt="SuperClaw" width={48} height={48} class="select-none pointer-events-none" />
                </div>
              <h2 class="text-display font-bold tracking-tight">
                {props.workspaces.length <= 1 ? translate("onboarding.create_first_workspace") : translate("onboarding.create_workspace")}
              </h2>
              <p class="text-dls-secondary text-body-lg leading-relaxed">
                  {translate("onboarding.workspace_folder_label")}
              </p>
            </div>

            <div class="space-y-4">
              <div class="bg-dls-surface-raised/40 border border-dls-border rounded-card p-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div class="text-caption font-semibold text-dls-secondary uppercase tracking-wider">{translate("onboarding.theme_label")}</div>
                  <div class="text-body-lg text-dls-text">{translate("onboarding.theme_current").replace("{mode}", props.themeMode)}</div>
                </div>
                <div class="flex flex-wrap gap-2">
                  <button
                    class={`text-caption px-3 py-1 rounded-pill border transition-colors ${
                      props.themeMode === "system"
                        ? "bg-dls-neutral-overlay/10 text-dls-text border-dls-border/30"
                        : "text-dls-secondary border-dls-border hover:text-dls-text"
                    }`}
                    onClick={() => props.setThemeMode("system")}
                  >
                    {translate("onboarding.theme_system")}
                  </button>
                  <button
                    class={`text-caption px-3 py-1 rounded-pill border transition-colors ${
                      props.themeMode === "light"
                        ? "bg-dls-neutral-overlay/10 text-dls-text border-dls-border/30"
                        : "text-dls-secondary border-dls-border hover:text-dls-text"
                    }`}
                    onClick={() => props.setThemeMode("light")}
                  >
                    {translate("onboarding.theme_light")}
                  </button>
                  <button
                    class={`text-caption px-3 py-1 rounded-pill border transition-colors ${
                      props.themeMode === "dark"
                        ? "bg-dls-neutral-overlay/10 text-dls-text border-dls-border/30"
                        : "text-dls-secondary border-dls-border hover:text-dls-text"
                    }`}
                    onClick={() => props.setThemeMode("dark")}
                  >
                    {translate("onboarding.theme_dark")}
                  </button>
                </div>
              </div>

              <OnboardingWorkspaceSelector
                defaultPath="~/OpenWork/Worker"
                onConfirm={props.onCreateWorkspace}
                onPickFolder={props.onPickWorkspaceFolder}
              />

              <div class="rounded-card border border-dls-border bg-dls-surface-solid/50 px-4 py-3">
                <div class="flex items-center justify-between gap-4">
                  <div class="min-w-0">
                    <div class="text-caption font-semibold text-dls-secondary uppercase tracking-wider">Import</div>
                    <div class="mt-1 text-body-lg text-dls-text">Use an existing workspace config.</div>
                    <div class="text-caption text-dls-secondary">Imports `.opencode` and `opencode.json` only.</div>
                  </div>
                  <Button
                    variant="secondary"
                    class="text-caption h-8 px-3 shrink-0"
                    onClick={props.onImportWorkspaceConfig}
                    disabled={props.importingWorkspaceConfig || props.busy}
                  >
                    Import config
                  </Button>
                </div>
              </div>

              <div class="rounded-card border border-dls-border bg-dls-surface-solid/50 px-4 py-3">
                <div class="flex items-center justify-between gap-4">
                  <div class="min-w-0">
                    <div class="text-caption font-semibold text-dls-secondary uppercase tracking-wider">{translate("onboarding.access_label")}</div>
                    <div class="mt-1 text-body-lg text-dls-text">
                      {translate("onboarding.folders_allowed")
                        .replace("{count}", String(props.authorizedDirs.length))
                        .replace("{plural}", props.authorizedDirs.length === 1 ? "" : "s")}
                    </div>
                    <div class="text-caption text-dls-secondary">{translate("onboarding.manage_access_hint")}</div>
                  </div>
                  <div class="text-caption text-dls-low font-mono truncate max-w-[9rem]">
                    <Show when={props.developerMode}>{props.authorizedDirs[0] ?? ""}</Show>
                  </div>
                </div>
              </div>
            </div>
            <Button
              onClick={props.onStartHost}
              disabled={props.busy || !props.activeWorkspacePath.trim()}
              class="w-full py-3 text-body-xl leading-title"
            >
              {translate("onboarding.start")}
            </Button>

            <Button variant="ghost" onClick={props.onBackToWelcome} disabled={props.busy} class="w-full">
              {translate("onboarding.back")}
            </Button>

            <details class="rounded-card border border-dls-border bg-dls-panel-input-bg px-4 py-3">
              <summary class="flex items-center justify-between cursor-pointer text-caption text-dls-secondary">
                {translate("onboarding.advanced_settings")}
                <ChevronDown size={14} class="text-dls-low" />
              </summary>
              <div class="pt-3 space-y-3">
                <div class="text-caption text-dls-secondary">{translate("onboarding.manage_access_hint")}</div>

                <div class="flex items-center justify-between gap-3 rounded-inset border border-dls-border bg-dls-panel-inset-bg px-3 py-2">
                  <div class="text-caption text-dls-secondary">{translate("onboarding.open_settings_hint")}</div>
                  <Button
                    variant="outline"
                    class="text-caption h-8 py-0 px-3 shrink-0"
                    onClick={props.onOpenSettings}
                  >
                    {translate("onboarding.open_settings")}
                  </Button>
                </div>

                <div class="space-y-3">
                  <div class="flex gap-2">
                    <input
                      class="w-full bg-dls-surface border border-dls-border rounded-inset px-3 py-2 text-body-lg text-dls-text placeholder:text-dls-secondary focus:outline-none focus:ring-1 focus:ring-[rgb(var(--dls-accent-rgb)/0.2)] focus:border-dls-accent transition-all"
                      placeholder={translate("onboarding.add_folder_path")}
                      value={props.newAuthorizedDir}
                      onInput={(e) => props.onSetAuthorizedDir(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          if (e.isComposing || e.keyCode === 229) return;
                          props.onAddAuthorizedDir();
                        }
                      }}
                    />
                    <Show when={isTauriRuntime()}>
                      <Button
                        variant="outline"
                        onClick={props.onAddAuthorizedDirFromPicker}
                        disabled={props.busy}
                      >
                        {translate("onboarding.pick")}
                      </Button>
                    </Show>
                    <Button
                      variant="secondary"
                      onClick={props.onAddAuthorizedDir}
                      disabled={!props.newAuthorizedDir.trim()}
                    >
                      {translate("onboarding.add")}
                    </Button>
                  </div>
                  <div class="text-caption text-dls-secondary">{engineStatusLabel()}</div>

                  <Show when={props.authorizedDirs.length}>
                    <div class="space-y-2">
                      <For each={props.authorizedDirs}>
                        {(dir, idx) => (
                          <div class="flex items-center justify-between gap-3 rounded-inset bg-dls-surface-solid/20 border border-dls-border px-3 py-2">
                            <div class="min-w-0 text-caption font-mono text-dls-secondary truncate">{dir}</div>
                            <Button
                              variant="ghost"
                              class="!p-2 rounded-control text-caption text-dls-secondary hover:text-dls-text"
                              onClick={() => props.onRemoveAuthorizedDir(idx())}
                              disabled={props.busy}
                              title={translate("onboarding.remove")}
                            >
                              {translate("onboarding.remove")}
                            </Button>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>

                <Show when={isTauriRuntime() && props.developerMode}>
                  <div class="rounded-card bg-dls-surface-raised/40 border border-dls-border p-4">
                    <div class="flex items-start justify-between gap-4">
                      <div class="min-w-0">
                        <div class="text-body-lg font-medium text-dls-text">{translate("onboarding.cli_label")}</div>
                        <div class="mt-1 text-caption text-dls-secondary">
                          <Show when={props.engineDoctorFound != null} fallback={<span>{translate("onboarding.cli_checking")}</span>}>
                            <Show when={props.engineDoctorFound} fallback={<span>{translate("onboarding.cli_not_found_hint")}</span>}>
                              <span class="font-mono">{props.engineDoctorVersion ?? translate("onboarding.cli_version_installed")}</span>
                              <Show when={props.engineDoctorResolvedPath}>
                                <span class="text-dls-low"> · </span>
                                <span class="font-mono text-dls-low truncate">{props.engineDoctorResolvedPath}</span>
                              </Show>
                            </Show>
                          </Show>
                        </div>
                      </div>

                      <Button variant="secondary" onClick={props.onRefreshEngineDoctor} disabled={props.busy}>
                        {translate("onboarding.cli_recheck")}
                      </Button>
                    </div>

                    <Show when={props.engineDoctorFound === false}>
                      <div class="mt-4 space-y-2">
                        <div class="text-caption text-dls-secondary">
                          {isWindowsPlatform()
                            ? translate("onboarding.cli_install_commands")
                            : translate("onboarding.install_instruction")}
                        </div>
                        <Show when={isWindowsPlatform()}>
                          <div class="text-caption text-dls-secondary space-y-1 font-mono">
                            <div>choco install opencode</div>
                            <div>scoop install extras/opencode</div>
                            <div>npm install -g opencode-ai</div>
                          </div>
                        </Show>
                        <div class="flex gap-2 pt-2">
                          <Button onClick={props.onInstallEngine} disabled={props.busy}>
                            {translate("onboarding.install")}
                          </Button>
                          <Button variant="outline" onClick={props.onShowSearchNotes} disabled={props.busy}>
                            {translate("onboarding.show_search_notes")}
                          </Button>
                        </div>
                      </div>
                    </Show>

                    <Show when={props.engineInstallLogs}>
                      <pre class="mt-4 max-h-48 overflow-auto rounded-inset bg-dls-surface-solid/50 border border-dls-border p-3 text-caption text-dls-secondary whitespace-pre-wrap">
                        {props.engineInstallLogs}
                      </pre>
                    </Show>

                    <Show when={props.engineDoctorCheckedAt != null}>
                      <div class="mt-3 text-label text-dls-low">
                        {translate("onboarding.last_checked").replace("{time}", new Date(props.engineDoctorCheckedAt ?? 0).toLocaleTimeString())}
                      </div>
                    </Show>
                  </div>
                </Show>

                <Show when={!engineDoctorAvailable()}>
                  <div class="text-caption text-dls-secondary">
                    {props.isWindows
                      ? translate("onboarding.windows_install_instruction")
                      : translate("onboarding.install_instruction")}
                  </div>
                </Show>

                <Show when={engineDoctorAvailable()}>
                  <div class="text-caption text-dls-low">{translate("onboarding.ready_message")}</div>
                </Show>

                <Show
                  when={
                    props.engineDoctorResolvedPath ||
                    props.engineDoctorVersion ||
                    props.engineDoctorNotes.length ||
                    serveHelpOutput()
                  }
                >
                  <div class="rounded-inset bg-dls-panel-inset-bg border border-dls-border p-3 space-y-3 text-caption text-dls-secondary">
                    <Show when={props.engineDoctorResolvedPath}>
                      <div>
                        <div class="text-label text-dls-subtle">{translate("onboarding.resolved_path")}</div>
                        <div class="font-mono break-all">{props.engineDoctorResolvedPath}</div>
                      </div>
                    </Show>
                    <Show when={props.engineDoctorVersion}>
                      <div>
                        <div class="text-label text-dls-subtle">{translate("onboarding.version")}</div>
                        <div class="font-mono">{props.engineDoctorVersion}</div>
                      </div>
                    </Show>
                    <Show when={props.engineDoctorNotes.length}>
                      <div>
                        <div class="text-label text-dls-subtle">{translate("onboarding.search_notes")}</div>
                        <pre class="whitespace-pre-wrap break-words text-caption text-dls-secondary">
                          {props.engineDoctorNotes.join("\n")}
                        </pre>
                      </div>
                    </Show>
                    <Show when={serveHelpOutput()}>
                      <div>
                        <div class="text-label text-dls-subtle">{translate("onboarding.serve_help")}</div>
                        <pre class="whitespace-pre-wrap break-words text-caption text-dls-secondary">{serveHelpOutput()}</pre>
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>
            </details>

            <Show when={props.error || props.migrationRepairResult}>
              <div class="rounded-card border border-dls-danger-border bg-dls-danger-bg px-5 py-4 text-body-lg text-dls-danger-text space-y-3">
                <Show when={props.error}>
                  <div>{props.error}</div>
                </Show>
                <Show when={props.migrationRepairResult}>
                  {(result) => (
                    <div
                      class={`rounded-inset border px-3 py-2 text-caption ${
                        result().ok
                          ? "border-dls-success-border bg-dls-success-bg text-dls-success-text"
                          : "border-dls-danger-border bg-dls-danger-bg text-dls-danger-text"
                      }`}
                    >
                      {result().message}
                    </div>
                  )}
                </Show>
                <Show when={props.canRepairMigration}>
                  <div class="flex flex-wrap items-center gap-2">
                    <Button
                      variant="secondary"
                      class="text-caption h-8 px-3"
                      onClick={props.onRepairMigration}
                      disabled={props.busy || props.migrationRepairBusy}
                    >
                      {props.migrationRepairBusy
                        ? translate("onboarding.fixing_migration")
                        : translate("onboarding.fix_migration")}
                    </Button>
                    <span class="text-caption text-dls-danger-text/80">{translate("onboarding.fix_migration_hint")}</span>
                  </div>
                </Show>
                <Show when={!props.canRepairMigration && props.migrationRepairUnavailableReason}>
                  <div class="text-caption text-dls-danger-text/80">{props.migrationRepairUnavailableReason}</div>
                </Show>
              </div>
            </Show>
          </div>
        </div>
      </Match>

      <Match when={props.onboardingStep === "server"}>
        <div class="min-h-screen flex flex-col items-center justify-center bg-dls-surface-solid text-dls-text p-6 relative">
          <div class="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-dls-surface-raised to-transparent opacity-20 pointer-events-none" />

          <div class="max-w-md w-full z-10 space-y-8">
              <div class="text-center space-y-2">
                <div class="w-12 h-12 bg-dls-surface-raised rounded-card mx-auto flex items-center justify-center border border-dls-border mb-6">
                  <Globe size={20} class="text-dls-secondary" />
                </div>
                <h2 class="text-display font-bold tracking-tight">{translate("onboarding.remote_workspace_title")}</h2>
              <p class="text-dls-secondary text-body-lg leading-relaxed">
                  {translate("onboarding.remote_workspace_description")}
              </p>
            </div>

            <div class="space-y-4">
              <div class="rounded-card border border-dls-border bg-dls-surface-solid/50 px-4 py-3">
                <div class="text-caption font-semibold text-dls-secondary uppercase tracking-wider">
                  {translate("onboarding.remote_workspace_title")}
                </div>
                <div class="mt-1 text-body-lg text-dls-text">{translate("onboarding.remote_workspace_description")}</div>
              </div>

              <div class="space-y-4">
                <TextInput
                  label={translate("dashboard.openwork_host_label")}
                  placeholder={translate("dashboard.openwork_host_placeholder")}
                  value={props.openworkHostUrl}
                  onInput={(e) => props.onOpenworkHostUrlChange(e.currentTarget.value)}
                  hint={translate("dashboard.openwork_host_hint")}
                />
                <label class="block">
                  <div class="mb-1 text-caption font-medium text-dls-secondary">{translate("dashboard.openwork_host_token_label")}</div>
                  <div class="flex items-center gap-2">
                    <input
                      type={openworkTokenVisible() ? "text" : "password"}
                      value={props.openworkToken}
                      onInput={(e) => props.onOpenworkTokenChange(e.currentTarget.value)}
                      placeholder={translate("dashboard.openwork_host_token_placeholder")}
                      disabled={props.busy}
                      class="w-full rounded-inset bg-dls-panel-hover-bg px-3 py-2 text-body-lg text-dls-text placeholder:text-dls-secondary shadow-[var(--dls-token-input-highlight)] focus:outline-none focus:ring-2 focus:ring-dls-border-strong/20"
                    />
                    <Button
                      variant="outline"
                      class="text-caption h-9 px-3 shrink-0"
                      onClick={() => setOpenworkTokenVisible((prev) => !prev)}
                      disabled={props.busy}
                    >
                      {openworkTokenVisible() ? translate("common.hide") : translate("common.show")}
                    </Button>
                  </div>
                  <div class="mt-1 text-caption text-dls-secondary">{translate("dashboard.openwork_host_token_hint")}</div>
                </label>
                <TextInput
                  label={translate("dashboard.remote_directory_label")}
                  placeholder={translate("dashboard.remote_directory_placeholder")}
                  value={props.clientDirectory}
                  onInput={(e) => props.onClientDirectoryChange(e.currentTarget.value)}
                  hint={translate("dashboard.remote_directory_hint")}
                />
              </div>

              <Button
                onClick={() => props.onConnectClient()}
                disabled={props.busy || !props.openworkHostUrl.trim()}
                class="w-full py-3 text-body-xl leading-title"
              >
                {translate("onboarding.remote_workspace_action")}
              </Button>

              <Button
                variant="secondary"
                onClick={props.onOpenSettings}
                disabled={props.busy}
                class="w-full"
              >
                {translate("onboarding.open_settings")}
              </Button>

              <Button variant="ghost" onClick={props.onBackToWelcome} disabled={props.busy} class="w-full">
                {translate("onboarding.back")}
              </Button>

              <Show when={props.error}>
                <div class="rounded-card bg-dls-danger-bg px-5 py-4 text-body-lg text-dls-danger-text border border-dls-danger-border">
                  {props.error}
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Match>

      <Match when={true}>
        <div class="min-h-screen flex flex-col items-center justify-center bg-dls-surface-solid text-dls-text p-6 relative">
          <div class="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-dls-surface-raised to-transparent opacity-20 pointer-events-none" />

          <div class="max-w-xl w-full z-10 space-y-12">
            <div class="text-center space-y-4">
              <div class="flex items-center justify-center gap-3 mb-6">
                <div class="">
                  <img src="/icon.png" alt="SuperClaw" width={48} height={48} class="select-none pointer-events-none" />
                </div>
                <h1 class="text-display-lg font-bold tracking-tight text-dls-text">OpenWork</h1>
              </div>
              <h2 class="text-heading-lg text-dls-secondary">{translate("onboarding.welcome_title")}</h2>
            </div>

            <div class="space-y-4">
              <button
                onClick={() => props.onSelectStartup("local")}
                class="group w-full relative bg-dls-surface-raised hover:bg-dls-hover border border-dls-border hover:border-dls-border p-6 md:p-8 rounded-shell text-left transition-all duration-300 hover:shadow-2xl hover:shadow-dls-selection-icon/10 hover:-translate-y-0.5 flex items-start gap-6"
              >
                <div class="shrink-0 w-14 h-14 rounded-card bg-gradient-to-br from-dls-selection/20 to-dls-secondary-accent/20 flex items-center justify-center border border-dls-selection/20 group-hover:border-dls-selection/40 transition-colors">
                  <Circle size={18} class="text-dls-selection-text" />
                </div>
                <div>
                  <h3 class="text-heading-lg font-medium text-dls-text mb-2">{translate("onboarding.run_local")}</h3>
                  <p class="text-dls-secondary text-body-lg leading-relaxed mb-4">
                      {translate("onboarding.run_local_description")}
                  </p>
                  <Show when={props.developerMode}>
                    <div class="flex items-center gap-2 text-caption font-mono text-dls-selection-text/80 bg-dls-selection-soft-bg/10 w-fit px-2 py-1 rounded-compact border border-dls-selection/10">
                      <div class="w-1.5 h-1.5 rounded-pill bg-dls-selection animate-pulse" />
                      {props.localHostLabel}
                    </div>
                  </Show>
                </div>
              </button>

              <Show when={props.engineRunning && props.engineBaseUrl}>
                <div class="rounded-card bg-dls-surface-raised/40 border border-dls-border p-5 flex items-center justify-between">
                  <div>
                    <div class="text-body-lg text-dls-text font-medium">{translate("onboarding.engine_running")}</div>
                    <div class="text-caption text-dls-secondary">{translate("onboarding.attach_description")}</div>
                    <Show when={props.developerMode}>
                      <div class="text-caption text-dls-secondary font-mono truncate max-w-[14rem] md:max-w-[22rem]">
                        {props.engineBaseUrl}
                      </div>
                    </Show>
                  </div>
                  <Button variant="secondary" onClick={props.onAttachHost} disabled={props.busy}>
                    {translate("onboarding.attach")}
                  </Button>
                </div>
              </Show>

              <button
                onClick={() => props.onSelectStartup("server")}
                class="group w-full relative bg-dls-surface-raised hover:bg-dls-hover border border-dls-border hover:border-dls-border p-6 md:p-8 rounded-shell text-left transition-all duration-300 hover:shadow-2xl hover:shadow-dls-neutral-overlay/10 hover:-translate-y-0.5 flex items-start gap-6"
              >
                <div class="shrink-0 w-14 h-14 rounded-card bg-gradient-to-br from-dls-low/20 to-dls-faint/10 flex items-center justify-center border border-dls-border group-hover:border-dls-border transition-colors">
                  <Globe size={18} class="text-dls-secondary" />
                </div>
                <div>
                  <h3 class="text-heading-lg font-medium text-dls-text mb-2">
                    {translate("onboarding.remote_workspace_card_title")}
                  </h3>
                  <p class="text-dls-secondary text-body-lg leading-relaxed mb-4">
                    {translate("onboarding.remote_workspace_card_description")}
                  </p>
                </div>
              </button>

              <div class="flex items-center gap-2 px-2 py-1">
                <button
                  onClick={props.onRememberStartupToggle}
                  class="flex items-center gap-2 text-caption text-dls-secondary hover:text-dls-secondary transition-colors group"
                >
                  <div
                    class={`w-4 h-4 rounded-compact border flex items-center justify-center transition-colors ${
                      props.rememberStartupChoice
                        ? "bg-dls-selection border-dls-selection text-dls-text"
                        : "border-dls-border bg-transparent group-hover:border-dls-border"
                    }`}
                  >
                    <Show when={props.rememberStartupChoice}>
                      <CheckCircle2 size={10} />
                    </Show>
                  </div>
                  {translate("onboarding.remember_choice")}
                </button>
              </div>

              <Show when={props.error}>
                <div class="rounded-card bg-dls-danger-bg px-5 py-4 text-body-lg text-dls-danger-text border border-dls-danger-border">
                  {props.error}
                </div>
              </Show>

              <Show when={props.developerMode}>
                <div class="text-center text-caption text-dls-subtle">{props.localHostLabel}</div>
              </Show>
            </div>
          </div>
        </div>
      </Match>
    </Switch>
  );
}
