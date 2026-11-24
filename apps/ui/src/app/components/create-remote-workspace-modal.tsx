import { Show, createEffect, createMemo, createSignal } from "solid-js";

import { Globe, X } from "lucide-solid";
import { t } from "../../i18n";

import Button from "./button";
import TextInput from "./text-input";

export default function CreateRemoteWorkspaceModal(props: {
  open: boolean;
  onClose: () => void;
  onConfirm: (input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => void;
  initialValues?: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  };
  submitting?: boolean;
  error?: string | null;
  inline?: boolean;
  showClose?: boolean;
  title?: string;
  subtitle?: string;
  confirmLabel?: string;
}) {
  let inputRef: HTMLInputElement | undefined;
  const [openworkHostUrl, setOpenworkHostUrl] = createSignal("");
  const [openworkToken, setOpenworkToken] = createSignal("");
  const [openworkTokenVisible, setOpenworkTokenVisible] = createSignal(false);
  const [directory, setDirectory] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");

  const showClose = () => props.showClose ?? true;
  const title = () => props.title ?? t("dashboard.create_remote_workspace_title");
  const subtitle = () => props.subtitle ?? t("dashboard.create_remote_workspace_subtitle");
  const confirmLabel = () => props.confirmLabel ?? t("dashboard.create_remote_workspace_confirm");
  const isInline = () => props.inline ?? false;
  const submitting = () => props.submitting ?? false;

  const canSubmit = createMemo(() => {
    if (submitting()) return false;
    return openworkHostUrl().trim().length > 0;
  });

  createEffect(() => {
    if (props.open) {
      requestAnimationFrame(() => inputRef?.focus());
    }
  });

  createEffect(() => {
    if (!props.open) return;
    const defaults = props.initialValues ?? {};
    setOpenworkHostUrl(defaults.openworkHostUrl?.trim() || "http://localhost:8787");
    setOpenworkToken(defaults.openworkToken?.trim() ?? "");
    setOpenworkTokenVisible(false);
    setDirectory(defaults.directory?.trim() ?? "");
    setDisplayName(defaults.displayName?.trim() ?? "");
  });

  const content = (
    <div class="border w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] dls-modal-surface">
      <div class="p-6 border-b border-dls-border flex justify-between items-center bg-dls-surface-solid">
        <div>
          <h3 class="font-semibold text-dls-text text-heading">{title()}</h3>
          <p class="text-dls-secondary text-body-lg">{subtitle()}</p>
        </div>
        <Show when={showClose()}>
          <button
            onClick={props.onClose}
            disabled={submitting()}
            data-testid="modal-dismiss-btn"
            class={`hover:bg-dls-hover p-1 rounded-pill ${submitting() ? "opacity-50 cursor-not-allowed" : ""}`.trim()}
          >
            <X size={20} class="text-dls-secondary" />
          </button>
        </Show>
      </div>

      <div class="p-6 flex-1 overflow-y-auto space-y-6">
        <div class="rounded-card border border-dls-border bg-dls-panel-inset-bg p-4 flex items-center gap-3">
          <div class="w-10 h-10 rounded-inset bg-dls-surface-tint flex items-center justify-center">
            <Globe size={20} class="text-dls-text" />
          </div>
          <div>
            <div class="text-body-lg font-medium text-dls-text">{t("dashboard.remote_workspace_title")}</div>
            <div class="text-caption text-dls-secondary">{t("dashboard.remote_workspace_hint")}</div>
          </div>
        </div>

        <div class="space-y-4">
          <TextInput
            ref={inputRef}
            label={t("dashboard.openwork_host_label")}
            placeholder={t("dashboard.openwork_host_placeholder")}
            value={openworkHostUrl()}
            onInput={(event) => setOpenworkHostUrl(event.currentTarget.value)}
            hint={t("dashboard.openwork_host_hint")}
            disabled={submitting()}
          />

          <label class="block">
            <div class="mb-1 text-caption font-medium text-dls-secondary">{t("dashboard.openwork_host_token_label")}</div>
            <div class="flex items-center gap-2">
              <input
                type={openworkTokenVisible() ? "text" : "password"}
                value={openworkToken()}
                onInput={(event) => setOpenworkToken(event.currentTarget.value)}
                placeholder={t("dashboard.openwork_host_token_placeholder")}
                disabled={submitting()}
                class="w-full rounded-control bg-dls-surface px-3 py-2 text-body-lg text-dls-text placeholder:text-dls-secondary border border-dls-border shadow-sm focus:outline-none focus:ring-2 focus:ring-[rgb(var(--dls-accent-rgb)/0.2)]"
              />
              <Button
                variant="outline"
                class="text-caption h-9 px-3 shrink-0"
                onClick={() => setOpenworkTokenVisible((prev) => !prev)}
                disabled={submitting()}
              >
                {openworkTokenVisible() ? t("common.hide") : t("common.show")}
              </Button>
            </div>
            <div class="mt-1 text-caption text-dls-secondary">{t("dashboard.openwork_host_token_hint")}</div>
          </label>

          <TextInput
            label={t("dashboard.remote_directory_label")}
            placeholder={t("dashboard.remote_directory_placeholder")}
            value={directory()}
            onInput={(event) => setDirectory(event.currentTarget.value)}
            hint={t("dashboard.remote_directory_hint")}
            disabled={submitting()}
          />
          <TextInput
            label={t("dashboard.remote_display_name_label")}
            placeholder={t("dashboard.remote_display_name_placeholder")}
            value={displayName()}
            onInput={(event) => setDisplayName(event.currentTarget.value)}
            disabled={submitting()}
          />
        </div>
      </div>

      <div class="p-6 border-t border-dls-border bg-dls-surface-solid space-y-3">
        <Show when={props.error}>
          <div class="p-3 rounded-control bg-dls-danger-bg border border-dls-danger-border text-body-lg text-dls-danger-text">
            {props.error}
          </div>
        </Show>
        <div class="flex justify-end gap-3">
          <Show when={showClose()}>
            <Button variant="ghost" onClick={props.onClose} disabled={submitting()}>
              {t("common.cancel")}
            </Button>
          </Show>
          <Button
            onClick={() =>
              props.onConfirm({
                openworkHostUrl: openworkHostUrl().trim(),
                openworkToken: openworkToken().trim(),
                directory: directory().trim() ? directory().trim() : null,
                displayName: displayName().trim() ? displayName().trim() : null,
              })
            }
            disabled={!canSubmit()}
            title={!openworkHostUrl().trim() ? t("dashboard.remote_base_url_required") : undefined}
          >
            {confirmLabel()}
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <Show when={props.open || isInline()}>
      <div
        class={
          isInline()
            ? "w-full"
            : "fixed inset-0 z-50 dls-modal-backdrop flex items-center justify-center p-4 animate-in fade-in duration-200"
        }
      >
        {content}
      </div>
    </Show>
  );
}
