import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { ChevronDown, ExternalLink, Loader2, X } from "lucide-solid";
import Button from "~/shared/ui/button";
import TextInput from "~/shared/ui/text-input";
import type { McpDirectoryInfo } from "~/shared/util/constants";
import { resolveMcpSetup } from "./mcp-config";
import { CommandLineInput, LocalOptionsFields, SecretInput } from "./mcp-form-fields";
import {
  joinCommand,
  rowsToRecord,
  splitCommand,
  type KeyValueRow,
} from "./mcp-input-parse";
import { validateObsidianVault } from "~/shared/platform/tauri";
import { isTauriRuntime } from "~/shared/platform/runtime-env";
import { t, type Language } from "../../i18n";

export type McpCatalogFormProps = {
  open: boolean;
  onClose: () => void;
  onConnect: (entry: McpDirectoryInfo) => void;
  entry: McpDirectoryInfo | null;
  busy: boolean;
  language: Language;
};

/**
 * Short form for a catalog card: only the preset's required inputs, with a local
 * server's command pinned. Advanced unlocks the full local fields. Preset environment
 * (e.g. MiniMax's API host) stays hidden and is always applied underneath user rows.
 */
export default function McpCatalogForm(props: McpCatalogFormProps) {
  const tr = (key: string) => t(key, props.language);
  const [values, setValues] = createSignal<Record<string, string>>({});
  const [advanced, setAdvanced] = createSignal(false);
  const [commandLine, setCommandLine] = createSignal("");
  const [env, setEnv] = createSignal<KeyValueRow[]>([]);
  const [error, setError] = createSignal<string | null>(null);

  const presetCommand = () => joinCommand(props.entry?.command ?? []);
  const isLocal = () => props.entry?.type === "local" && Boolean(props.entry.command?.length);

  const reset = () => {
    setValues({});
    setAdvanced(false);
    setCommandLine(presetCommand());
    setEnv([]);
    setError(null);
  };

  createEffect(() => {
    if (props.open && props.entry) reset();
  });

  const handleClose = () => {
    setValues({});
    setError(null);
    props.onClose();
  };

  const requiredValuesPresent = createMemo(() =>
    (props.entry?.setup?.inputs ?? []).every(
      (input) => !input.required || Boolean(values()[input.key]?.trim()),
    ),
  );

  const setValue = (key: string, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  const openSetupUrl = async (url: string) => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const withAdvancedFields = (entry: McpDirectoryInfo): McpDirectoryInfo | string => {
    if (!isLocal() || !advanced()) return entry;
    const command = splitCommand(commandLine());
    if (command.length === 0) return tr("mcp.command_required");
    const environment = { ...entry.environment, ...rowsToRecord(env()) };
    return {
      ...entry,
      command,
      environment: Object.keys(environment).length > 0 ? environment : undefined,
    };
  };

  const handleSubmit = async () => {
    const entry = props.entry;
    if (!entry) return;

    setError(null);
    const base = withAdvancedFields(entry);
    if (typeof base === "string") {
      setError(base);
      return;
    }
    const vaultInput = entry.setup?.inputs.find(
      (input) => input.target.kind === "workspaceFolderArgument",
    );
    try {
      if (vaultInput && isTauriRuntime()) {
        await validateObsidianVault(values()[vaultInput.key] ?? "");
      }
      props.onConnect(resolveMcpSetup(base, values()));
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : tr("mcp.connect_failed"),
      );
      return;
    }

    handleClose();
  };

  return (
    <Show when={props.open && props.entry}>
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          class="absolute inset-0 dls-modal-backdrop"
          onClick={handleClose}
        />

        <div
          role="dialog"
          aria-label={`${tr("mcp.connect")} ${props.entry?.name ?? ""}`}
          class="relative flex max-h-[calc(100vh-2rem)] w-full max-w-md flex-col overflow-hidden border dls-modal-surface"
        >
          {/* Header */}
          <div class="relative px-6 py-4 border-b border-dls-border-strong">
            <button
              type="button"
              class="absolute top-3 right-4 p-2 text-dls-secondary hover:text-dls-text hover:bg-dls-surface-muted rounded-control transition-colors"
              onClick={handleClose}
            >
              <X size={20} />
            </button>
            <h2 class="text-heading font-semibold text-dls-text pr-10">
              {tr("mcp.connect")} {props.entry?.name}
            </h2>
            <Show when={props.entry?.setup?.descriptionKey}>
              {(descriptionKey) => (
                <p class="mt-1 text-body-lg text-dls-secondary pr-10">{tr(descriptionKey())}</p>
              )}
            </Show>
          </div>

          {/* Content */}
          <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
            <Show when={props.entry?.setup?.callbackUrl}>
              {(callbackUrl) => (
                <div class="rounded-control border border-dls-panel-border bg-dls-panel-bg px-3 py-2.5">
                  <p class="text-caption font-medium text-dls-text">
                    {tr("mcp.oauth_callback_url")}
                  </p>
                  <p class="mt-0.5 text-caption text-dls-secondary">
                    {tr("mcp.oauth_callback_hint")}
                  </p>
                  <code class="mt-2 block overflow-x-auto rounded-compact bg-dls-panel-inset-bg px-2.5 py-2 text-caption text-dls-text">
                    {callbackUrl()}
                  </code>
                </div>
              )}
            </Show>
            <For each={props.entry?.setup?.inputs ?? []}>
              {(input, index) => (
                <Show
                  when={input.type === "password"}
                  fallback={
                    <TextInput
                      label={tr(input.labelKey)}
                      placeholder={tr(input.placeholderKey)}
                      class="placeholder:text-dls-secondary/50"
                      value={values()[input.key] ?? ""}
                      onInput={(event) => setValue(input.key, event.currentTarget.value)}
                      autofocus={index() === 0}
                      autocomplete="off"
                    />
                  }
                >
                  <SecretInput
                    label={tr(input.labelKey)}
                    placeholder={tr(input.placeholderKey)}
                    value={values()[input.key] ?? ""}
                    onInput={(value) => setValue(input.key, value)}
                    autofocus={index() === 0}
                    language={props.language}
                  />
                </Show>
              )}
            </For>
            <Show when={isLocal()}>
              <CommandLineInput
                label={tr("mcp.server_command")}
                value={advanced() ? commandLine() : presetCommand()}
                onInput={setCommandLine}
                locked={!advanced()}
                language={props.language}
              />
              <button
                type="button"
                class="inline-flex items-center gap-1 text-caption font-medium text-dls-secondary hover:text-dls-text"
                aria-expanded={advanced()}
                onClick={() => setAdvanced((current) => !current)}
              >
                {tr("mcp.catalog_advanced")}
                <ChevronDown size={13} class={`transition-transform ${advanced() ? "rotate-180" : ""}`} />
              </button>
              <Show when={advanced()}>
                <p class="text-caption text-dls-secondary">{tr("mcp.catalog_advanced_hint")}</p>
                <LocalOptionsFields
                  env={env()}
                  onEnvChange={setEnv}
                  language={props.language}
                />
              </Show>
            </Show>
            <Show when={props.entry?.setup?.url}>
              {(url) => (
                <button
                  type="button"
                  class="inline-flex items-center gap-1.5 text-caption font-medium text-dls-info-text hover:text-dls-info-text"
                  onClick={() => void openSetupUrl(url())}
                >
                  {tr(props.entry?.setup?.linkLabelKey ?? "mcp.setup_link")}
                  <ExternalLink size={13} />
                </button>
              )}
            </Show>
            <Show when={error()}>
              <div class="rounded-control border border-dls-danger-border bg-dls-danger-bg px-3 py-2 text-caption text-dls-danger-text">
                {error()}
              </div>
            </Show>
          </div>

          {/* Footer */}
          <div class="flex items-center justify-end gap-3 px-6 py-4 border-t border-dls-border-strong bg-dls-surface-solid">
            <Button variant="ghost" onClick={handleClose}>
              {tr("mcp.auth.cancel")}
            </Button>
            <Button variant="secondary" onClick={() => void handleSubmit()} disabled={props.busy || !requiredValuesPresent()}>
              <Show when={props.busy} fallback={null}>
                <Loader2 size={16} class="animate-spin" />
              </Show>
              {tr("mcp.connect")}
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}
