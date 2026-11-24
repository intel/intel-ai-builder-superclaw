import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { Globe, Info, Loader2, Monitor, Plus, X } from "lucide-solid";
import {
  isBrowserAutomationCommand,
  type HostMcpApprovalMode,
} from "@different-ai/openwork-contracts/host-mcp-api";
import Button from "~/shared/ui/button";
import TextInput from "~/shared/ui/text-input";
import ToggleSwitch from "~/shared/ui/toggle-switch";
import type { McpDirectoryInfo } from "~/shared/util/constants";
import { isLocalWindowsMcpUrl } from "~/shared/platform/transport/sandbox-networking";
import { t, type Language } from "../../i18n";
import { CommandLineInput, LocalOptionsFields, SecretInput } from "./mcp-form-fields";
import { isPlaywrightMcpCommand, type McpConnectResult, type McpPlacement } from "./mcp-host-placement";
import {
  detectMode,
  rowsToRecord,
  splitCommand,
  suggestName,
  toServerUrl,
  type KeyValueRow,
} from "./mcp-input-parse";

export type AddMcpModalProps = {
  open: boolean;
  onClose: () => void;
  onAdd: (entry: McpDirectoryInfo) => void;
  busy: boolean;
  /** Why Local command is unavailable, or null when it may be offered. */
  localCommandBlock: LocalCommandBlock;
  /** Saves a local command placed on the host; absent when neither host placement may be offered. */
  onAddPlaced?: (entry: McpDirectoryInfo, placement: McpPlacement) => Promise<McpConnectResult>;
  /** Offer "Run on this computer" for a local command. */
  hostExecution?: boolean;
  /** Offer "Use SuperClaw browser" for a Playwright command. */
  hostBrowser?: boolean;
  language: Language;
};

export type LocalCommandBlock = "profile" | null;

const BLOCK_HINT_KEYS: Record<NonNullable<LocalCommandBlock>, string> = {
  profile: "mcp.local_cmd_unavailable_profile",
};

type ServerMode = "remote" | "stdio";

const MODES: ReadonlyArray<{ mode: ServerMode; labelKey: string }> = [
  { mode: "remote", labelKey: "mcp.type_remote" },
  { mode: "stdio", labelKey: "mcp.type_local_cmd" },
];

const APPROVAL_MODES: ReadonlyArray<{ mode: HostMcpApprovalMode; labelKey: string }> = [
  { mode: "prompt", labelKey: "mcp.host.approval_prompt" },
  { mode: "auto", labelKey: "mcp.host.approval_auto" },
];

export default function AddMcpModal(props: AddMcpModalProps) {
  const tr = (key: string) => t(key, props.language);

  const [input, setInput] = createSignal("");
  const [modeOverride, setModeOverride] = createSignal<ServerMode | null>(null);
  const [name, setName] = createSignal("");
  const [nameTouched, setNameTouched] = createSignal(false);
  const [oauthRequired, setOauthRequired] = createSignal(false);
  const [clientId, setClientId] = createSignal("");
  const [clientSecret, setClientSecret] = createSignal("");
  const [env, setEnv] = createSignal<KeyValueRow[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [onHost, setOnHost] = createSignal(false);
  const [approvalMode, setApprovalMode] = createSignal<HostMcpApprovalMode>("prompt");
  const [saving, setSaving] = createSignal(false);

  const mode = (): ServerMode =>
    props.localCommandBlock ? "remote" : modeOverride() ?? detectMode(input());
  const isLocalUrl = () => mode() === "remote" && isLocalWindowsMcpUrl(toServerUrl(input()));
  const hostOffered = () => mode() === "stdio" && props.hostExecution === true && Boolean(props.onAddPlaced);
  // A browser-automation command on the host would skip the SuperClaw browser relay's filter and could
  // drive the user's own signed-in browser, so the host toggle is held off for it.
  const hostRefused = () => isBrowserAutomationCommand(splitCommand(input()));
  const runsOnHost = () => hostOffered() && onHost() && !hostRefused();
  createEffect(() => {
    if (hostRefused()) setOnHost(false);
  });
  const browserAvailable = () =>
    mode() === "stdio"
    && props.hostBrowser === true
    && Boolean(props.onAddPlaced)
    && isPlaywrightMcpCommand(splitCommand(input()), rowsToRecord(env()));
  const browserOffered = () => browserAvailable() && !runsOnHost();
  // Both lines name the SuperClaw browser only when its card is there to use. The neutral one explains
  // a toggle held off; the warning is for a gateway that refused, which the form did not foresee.
  const unavailableHint = () =>
    tr(browserAvailable() ? "mcp.host.browser_automation_unavailable" : "mcp.host.browser_automation_not_in_version");
  const refusedHint = () =>
    tr(browserAvailable() ? "mcp.host.browser_automation_refused" : "mcp.host.browser_automation_not_in_version");
  const [gatewayRefused, setGatewayRefused] = createSignal(false);

  const reset = () => {
    setInput("");
    setModeOverride(null);
    setName("");
    setNameTouched(false);
    setOauthRequired(false);
    setClientId("");
    setClientSecret("");
    setEnv([]);
    setError(null);
    setOnHost(false);
    setGatewayRefused(false);
    setApprovalMode("prompt");
    setSaving(false);
  };

  // A host save registers on the gateway and then adds to the workspace; closing mid-way would hide
  // its outcome, so the form stays until it settles.
  const handleClose = () => {
    if (saving()) return;
    reset();
    props.onClose();
  };

  createEffect(() => {
    if (!props.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      handleClose();
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  const handleMainInput = (value: string) => {
    setError(null);
    setGatewayRefused(false);
    if (!nameTouched()) setName(suggestName(value));
    setInput(value);
  };

  const selectMode = (next: ServerMode) => {
    setModeOverride(next === detectMode(input()) ? null : next);
  };

  const buildEntry = (): McpDirectoryInfo | string => {
    const trimmedName = name().trim();
    if (!trimmedName) return tr("mcp.name_required");

    if (mode() === "remote") {
      const url = toServerUrl(input());
      if (!url) return tr("mcp.url_required");
      return {
        name: trimmedName,
        description: "",
        type: "remote",
        url,
        oauth: oauthRequired(),
        clientId: oauthRequired() ? clientId().trim() || undefined : undefined,
        clientSecret: oauthRequired() ? clientSecret().trim() || undefined : undefined,
      };
    }

    const command = splitCommand(input());
    if (command.length === 0) return tr("mcp.command_required");
    const environment = rowsToRecord(env());
    return {
      name: trimmedName,
      description: "",
      type: "local",
      command,
      oauth: false,
      environment: Object.keys(environment).length > 0 ? environment : undefined,
    };
  };

  const savePlaced = async (entry: McpDirectoryInfo, placement: McpPlacement) => {
    const save = props.onAddPlaced;
    if (!save || saving()) return;
    setSaving(true);
    setError(null);
    const result = await save(entry, placement);
    setSaving(false);
    if (result.ok) {
      handleClose();
      return;
    }
    if (result.code !== "host_mcp_browser_automation_refused") {
      setError(result.message);
      return;
    }
    // Off, so the SuperClaw browser card the warning may name is shown.
    setOnHost(false);
    setGatewayRefused(true);
  };

  const handleSubmit = (placement?: McpPlacement) => {
    const entry = buildEntry();
    if (typeof entry === "string") {
      setError(entry);
      return;
    }
    const chosen = placement ?? (runsOnHost() ? { kind: "host" as const, approvalMode: approvalMode() } : undefined);
    if (chosen) {
      void savePlaced(entry, chosen);
      return;
    }
    props.onAdd(entry);
    handleClose();
  };

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          class="absolute inset-0 dls-modal-backdrop"
          onClick={handleClose}
        />

        <div
          role="dialog"
          aria-label={tr("mcp.add_modal_title")}
          class="relative flex max-h-[calc(100vh-2rem)] w-full max-w-xl flex-col overflow-hidden border dls-modal-surface"
        >
          {/* Header */}
          <div class="flex items-center justify-between px-6 py-4 border-b border-dls-border-strong">
            <div>
              <h2 class="text-heading font-semibold text-dls-text">
                {tr("mcp.add_modal_title")}
              </h2>
            </div>
            <button
              type="button"
              class="p-2 text-dls-secondary hover:text-dls-text hover:bg-dls-surface-muted rounded-control transition-colors disabled:opacity-50"
              disabled={saving()}
              onClick={handleClose}
            >
              <X size={20} />
            </button>
          </div>

          {/* Content */}
          <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
            <Show
              when={!props.localCommandBlock}
              fallback={
                <p data-testid="mcp-local-command-unavailable" class="text-caption text-dls-secondary">
                  {tr(BLOCK_HINT_KEYS[props.localCommandBlock ?? "profile"])}
                </p>
              }
            >
              <div role="radiogroup" aria-label={tr("mcp.server_type")} class="inline-flex rounded-control border border-dls-panel-inset-border bg-dls-panel-inset-bg p-0.5">
                <For each={MODES}>
                  {(option) => (
                    <label
                      class={`cursor-pointer rounded-subtle px-3 py-1.5 text-caption font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[rgb(var(--dls-accent-rgb)/0.35)] ${
                        mode() === option.mode
                          ? "bg-dls-panel-bg text-dls-text shadow-sm"
                          : "text-dls-secondary hover:text-dls-text"
                      }`}
                    >
                      <input
                        type="radio"
                        name="mcp-server-type"
                        class="sr-only"
                        value={option.mode}
                        checked={mode() === option.mode}
                        onChange={() => selectMode(option.mode)}
                      />
                      {tr(option.labelKey)}
                    </label>
                  )}
                </For>
              </div>
            </Show>

            <CommandLineInput
              label={tr(mode() === "remote" ? "mcp.server_url" : "mcp.server_command")}
              placeholder={tr(mode() === "remote" ? "mcp.server_url_placeholder" : "mcp.server_command_placeholder")}
              hint={tr(mode() === "remote" ? "mcp.server_url_hint" : "mcp.server_command_hint")}
              value={input()}
              onInput={handleMainInput}
              autofocus
              language={props.language}
            />

            <TextInput
              label={tr("mcp.server_name")}
              placeholder={tr("mcp.server_name_placeholder")}
              class="placeholder:text-dls-secondary/50"
              value={name()}
              onInput={(event) => {
                setNameTouched(true);
                setName(event.currentTarget.value);
              }}
            />

            <Show
              when={mode() === "remote"}
              fallback={
                <>
                  <LocalOptionsFields env={env()} onEnvChange={setEnv} language={props.language} />
                  <Show when={hostOffered()}>
                    <div data-testid="mcp-host-execution" class="space-y-3 rounded-control border border-dls-panel-border bg-dls-panel-bg px-3 py-3">
                      <div class="flex items-start gap-3">
                        <Monitor size={16} class="mt-0.5 shrink-0 text-dls-secondary" />
                        <div class="min-w-0 flex-1">
                          <div id="mcp-host-execution-label" class="text-caption font-medium text-dls-text">
                            {tr("mcp.host.run_on_computer")}
                          </div>
                          <p class="mt-0.5 text-label leading-relaxed text-dls-secondary">
                            {tr("mcp.host.run_on_computer_warning")}
                          </p>
                        </div>
                        <ToggleSwitch
                          checked={onHost() && !hostRefused()}
                          disabled={hostRefused()}
                          aria-labelledby="mcp-host-execution-label"
                          onChange={(next) => {
                            setError(null);
                            setGatewayRefused(false);
                            setOnHost(next);
                          }}
                        />
                      </div>
                      <Show
                        when={gatewayRefused()}
                        fallback={
                          <Show when={hostRefused()}>
                            <p data-testid="mcp-host-browser-unavailable" class="pl-7 text-label leading-relaxed text-dls-secondary">
                              {unavailableHint()}
                            </p>
                          </Show>
                        }
                      >
                        <p
                          role="alert"
                          data-testid="mcp-host-browser-refused"
                          class="pl-7 text-label leading-relaxed text-dls-warning-text"
                        >
                          {refusedHint()}
                        </p>
                      </Show>
                      <Show when={runsOnHost()}>
                        <div role="radiogroup" aria-label={tr("mcp.host.approval_label")} class="space-y-1.5 pl-7">
                          <For each={APPROVAL_MODES}>
                            {(option) => (
                              <label class="flex items-center gap-2 text-caption text-dls-text">
                                <input
                                  type="radio"
                                  name="mcp-host-approval-mode"
                                  class="h-4 w-4"
                                  value={option.mode}
                                  checked={approvalMode() === option.mode}
                                  onChange={() => setApprovalMode(option.mode)}
                                />
                                {tr(option.labelKey)}
                              </label>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  </Show>
                  <Show when={browserOffered()}>
                    <div data-testid="mcp-host-browser" class="flex items-start gap-3 rounded-control border border-dls-info-border bg-dls-info-bg px-3 py-3">
                      <Globe size={16} class="mt-0.5 shrink-0 text-dls-info-text" />
                      <p class="min-w-0 flex-1 text-label leading-relaxed text-dls-info-text">
                        {tr("mcp.host.browser_hint")}
                      </p>
                      <Button
                        variant="outline"
                        class="h-8 shrink-0 px-3 text-caption"
                        disabled={props.busy || saving()}
                        onClick={() => handleSubmit({ kind: "host_browser" })}
                      >
                        {tr("mcp.host.use_browser")}
                      </Button>
                    </div>
                  </Show>
                </>
              }
            >
              <div class="space-y-3">
                <div class="flex gap-2 border-l-2 border-dls-panel-border pl-3 text-label leading-relaxed text-dls-secondary">
                  <Info size={14} class="mt-0.5 shrink-0 text-dls-secondary" />
                  <p>{tr("mcp.endpoint_path_hint")}</p>
                </div>

                <label class="flex items-center gap-2 text-caption text-dls-secondary">
                  <input
                    type="checkbox"
                    class="h-4 w-4 rounded-compact border border-dls-border"
                    checked={oauthRequired()}
                    onChange={(event) => setOauthRequired(event.currentTarget.checked)}
                  />
                  {tr("mcp.oauth_optional_label")}
                </label>

                <Show when={oauthRequired()}>
                  <TextInput
                    label={tr("mcp.client_id")}
                    placeholder={tr("mcp.client_id_placeholder")}
                    class="placeholder:text-dls-secondary/50"
                    value={clientId()}
                    onInput={(event) => setClientId(event.currentTarget.value)}
                    autocomplete="off"
                  />
                  <SecretInput
                    label={tr("mcp.client_secret")}
                    placeholder={tr("mcp.client_secret_placeholder")}
                    value={clientSecret()}
                    onInput={setClientSecret}
                    language={props.language}
                  />
                </Show>

                <Show when={isLocalUrl()}>
                  <div class="border-l-2 border-dls-info-border bg-dls-info-bg px-3 py-2 text-label leading-relaxed text-dls-info-text">
                    <div class="font-medium">{tr("mcp.local_server.title")}</div>
                    <div>{tr("mcp.local_server.hint")}</div>
                  </div>
                </Show>
              </div>
            </Show>
            <Show when={error()}>
              <div class="rounded-control bg-dls-danger-bg border border-dls-danger-border px-3 py-2 text-caption text-dls-danger-text">
                {error()}
              </div>
            </Show>
          </div>

          {/* Footer */}
          <div class="flex items-center justify-end gap-3 px-6 py-4 border-t border-dls-border-strong bg-dls-surface-solid">
            <Button variant="ghost" onClick={handleClose} disabled={saving()}>
              {tr("mcp.auth.cancel")}
            </Button>
            <Button variant="secondary" onClick={() => handleSubmit()} disabled={props.busy || saving()}>
              <Show when={props.busy || saving()} fallback={<Plus size={16} />}>
                <Loader2 size={16} class="animate-spin" />
              </Show>
              {tr("mcp.add_server_button")}
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}
