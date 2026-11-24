import { Show, createEffect, createMemo, createSignal } from "solid-js";
import { Download, Mail, Trash2, Upload } from "lucide-solid";

import Button from "~/shared/ui/button";
import { t } from "../../i18n";
import { isTauriRuntime } from "../utils";
import { openUrl } from "./settings.platform-actions";
import type { GmailCredentials } from "./settings.gmail-credentials";
import {
  GMAIL_CREDENTIALS_URL,
  createGmailSetupGuide,
} from "./settings.gmail-setup-guide";
import GmailSetupGuidePanel from "./settings.gmail-setup-guide-panel";

/** The user finishes setup in the browser; bring SuperClaw back so they see it worked. */
async function focusApp(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const appWindow = getCurrentWindow();
    await appWindow.show();
    await appWindow.setFocus();
  } catch (err) {
    console.warn("Gmail setup: focusing SuperClaw failed:", err);
  }
}

const LINK = "text-label text-dls-accent underline underline-offset-2 hover:opacity-80";

/** Email Agent credential card. The caller owns the capability gate. */
export default function GmailCredentialsSection(props: {
  gmail: GmailCredentials;
}) {
  const guide = createGmailSetupGuide({
    scope: () => props.gmail.scope(),
    status: () => props.gmail.status(),
    upload: (file) => props.gmail.upload(file),
    busy: () => props.gmail.busy(),
    startAuth: () => props.gmail.startAuth(),
    checkApis: () => props.gmail.checkApis(),
    onDone: () => void focusApp(),
  });
  const [manualOpen, setManualOpen] = createSignal(false);
  const noCredentials = () => props.gmail.status()?.hasCredentials === false;

  // Signed in is not ready while the guide still waits for Gmail and Calendar, or after
  // it was cancelled with one of them known to be off or not granted.
  const apisBlocked = () => guide.step() === "apis" || guide.apisDisabled() || guide.accessMissing();
  const pill = createMemo(() => {
    const s = props.gmail.status();
    if (!s) return null;
    if (s.paused) return { tone: "warning", label: t("connections.status_paused") } as const;
    if (s.hasCredentials && s.hasToken && !apisBlocked())
      return { tone: "success", label: t("settings.gmail_authorized") } as const;
    if (s.hasCredentials)
      return {
        tone: "warning",
        label:
          s.hasToken && !guide.accessMissing()
            ? t("settings.gmail_apis_pending")
            : t("settings.gmail_creds_configured"),
      } as const;
    return { tone: "none", label: t("settings.gmail_no_creds") } as const;
  });

  const uploadPicked = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void guide.startFromFile(file);
    input.value = "";
  };

  createEffect(() => {
    if (props.gmail.status()?.hasCredentials) setManualOpen(false);
  });

  const startGuide = () => {
    setManualOpen(false);
    void guide.start();
  };

  // Removed mid-setup, the guide would fall back to watching Downloads and upload the
  // next client without a new Set up Gmail; the leftover offer no longer holds either.
  const removeCredentials = async () => {
    await props.gmail.remove();
    if (props.gmail.status()?.hasCredentials === false) {
      guide.stop();
      guide.keepLeftover();
    }
  };

  // Switching paths ends the guide, so a file it would pick up is not uploaded
  // twice alongside the manual upload.
  const openManual = () => {
    guide.stop();
    setManualOpen(true);
    void openUrl(GMAIL_CREDENTIALS_URL);
  };

  return (
    <div class="bg-dls-panel-bg border border-dls-panel-border rounded-card p-5 space-y-4">
      <div>
        <div class="flex items-center gap-2">
          <Mail size={16} class="text-dls-secondary" />
          <div class="text-body-lg font-medium text-dls-text">
            {t("settings.gmail_title")}
          </div>
        </div>
        <div class="text-caption text-dls-secondary mt-1">
          {t("settings.gmail_intro")}
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <Show
          when={pill()}
          fallback={
            <div data-testid="gmail-status-loading" class="text-caption text-dls-secondary">
              {t("settings.gmail_status_loading")}
            </div>
          }
        >
          {(p) => (
            <div
              data-testid="gmail-credentials-status"
              class={`flex items-center gap-2 rounded-pill border px-2.5 py-1 text-label font-medium ${
                p().tone === "success"
                  ? "bg-dls-success-bg text-dls-success-text border-dls-success-border"
                  : p().tone === "warning"
                    ? "bg-dls-warning-bg text-dls-warning-text border-dls-warning-border"
                    : "bg-dls-panel-badge-bg text-dls-panel-icon border-dls-panel-badge-border"
              }`}
            >
              <span
                class={`h-2 w-2 rounded-pill ${
                  p().tone === "success"
                    ? "bg-dls-success-dot"
                    : p().tone === "warning"
                      ? "bg-dls-warning-dot"
                      : "bg-dls-panel-dot"
                }`}
              />
              {p().label}
            </div>
          )}
        </Show>

        <Show when={props.gmail.status()?.hasCredentials}>
          <button
            data-testid="delete-credentials-button"
            type="button"
            class="inline-flex items-center justify-center rounded-control border border-dls-danger-border bg-dls-danger-bg p-2 text-dls-danger-text hover:bg-dls-danger-bg transition-colors"
            onClick={() => void removeCredentials()}
            disabled={props.gmail.busy()}
            title={t("settings.gmail_remove_title")}
          >
            <Trash2 size={14} />
          </button>
        </Show>
      </div>

      <Show when={props.gmail.status()?.paused}>
        <div data-testid="gmail-paused-note" class="text-caption text-dls-secondary">{t("connections.gmail_paused_note")}</div>
      </Show>

      <Show when={guide.step()}>
        <GmailSetupGuidePanel guide={guide} onManual={openManual} />
      </Show>

      <Show when={!guide.step() && !props.gmail.status()?.paused && props.gmail.status()?.hasToken && apisBlocked()}>
        <button data-testid="gmail-setup-resume" type="button" class={LINK} onClick={guide.resume}>
          {t("settings.gmail_setup_resume")}
        </button>
      </Show>

      <Show when={noCredentials() && !guide.step()}>
        <div class="flex flex-wrap items-center gap-4">
          <Button
            data-testid="gmail-setup-start"
            class="px-3 py-1.5 text-caption"
            onClick={startGuide}
            disabled={props.gmail.busy()}
          >
            {t("settings.gmail_setup_button")}
          </Button>
          <Show when={!manualOpen()}>
            <button data-testid="gmail-setup-manual" type="button" class={LINK} onClick={openManual}>
              {t("settings.gmail_setup_manual")}
            </button>
          </Show>
        </div>

        <Show when={guide.existing()}>
          {(found) => (
            <div
              data-testid="gmail-existing-download"
              class="rounded-inset border border-dls-info-border-subtle bg-dls-info-bg-subtle px-4 py-2.5 text-caption text-dls-info-text break-words"
            >
              {t("settings.gmail_found_download").replace("{name}", found().name)}{" "}
              <button
                data-testid="gmail-use-existing"
                type="button"
                class={`ml-1 whitespace-nowrap ${LINK}`}
                onClick={() => void guide.useExisting()}
                disabled={props.gmail.busy()}
              >
                {t("settings.gmail_use_download")}
              </button>
            </div>
          )}
        </Show>

        <Show when={manualOpen()}>
          <div
            data-testid="gmail-manual-setup"
            class="rounded-inset border border-dls-border bg-dls-surface px-4 py-3 space-y-2.5"
          >
            <div class="text-caption text-dls-secondary">
              {t("settings.gmail_manual_hint")}
            </div>
            <a
              href={GMAIL_CREDENTIALS_URL}
              target="_blank"
              rel="noopener noreferrer"
              class="block w-fit break-all select-all text-label text-dls-accent underline underline-offset-2 hover:opacity-80"
              onClick={(e) => {
                e.preventDefault();
                void openUrl(GMAIL_CREDENTIALS_URL);
              }}
            >
              {GMAIL_CREDENTIALS_URL}
            </a>
            <div class="flex flex-wrap items-center gap-3">
              <label
                data-testid="upload-gmail-credentials-button"
                class={`inline-flex items-center gap-1.5 rounded-control border border-dls-border bg-dls-surface px-3 py-2 text-caption text-dls-text cursor-pointer hover:bg-dls-hover transition-colors ${
                  props.gmail.busy() ? "opacity-50 pointer-events-none" : ""
                }`}
              >
                <Upload size={14} class="text-dls-secondary" />
                <span data-testid="upload-credentials-button">
                  {t("settings.gmail_upload_button")}
                </span>
                <input
                  type="file"
                  accept=".json,application/json"
                  class="hidden"
                  onChange={uploadPicked}
                  disabled={props.gmail.busy()}
                />
              </label>
              <button
                type="button"
                class="text-label text-dls-accent underline underline-offset-2 hover:opacity-80"
                onClick={() => void props.gmail.downloadTemplate()}
              >
                <Download size={13} class="inline mr-1 -mt-0.5" />
                {t("settings.gmail_template")}
              </button>
            </div>
          </div>
        </Show>
      </Show>

      <Show when={props.gmail.error()}>
        {(err) => <div class="text-caption text-dls-danger-text">{err()}</div>}
      </Show>

      <Show when={!guide.step() && props.gmail.success()}>
        {(msg) => <div class="text-caption text-dls-success-text">{msg()}</div>}
      </Show>

      <Show
        when={
          !guide.step() && props.gmail.status()?.hasCredentials && guide.canRemoveLeftover && guide.leftover()
        }
      >
        {(name) => (
          <div
            data-testid="gmail-leftover-download"
            class="text-caption text-dls-secondary break-words"
          >
            {t("settings.gmail_leftover").replace("{name}", name())}{" "}
            <button
              type="button"
              class={`ml-1 whitespace-nowrap ${LINK}`}
              onClick={() => void guide.removeLeftover()}
            >
              {t("settings.gmail_leftover_remove")}
            </button>
            <button
              type="button"
              class={`ml-3 whitespace-nowrap ${LINK}`}
              onClick={() => guide.keepLeftover()}
            >
              {t("settings.gmail_leftover_keep")}
            </button>
          </div>
        )}
      </Show>

      <Show
        when={
          props.gmail.status()?.hasCredentials &&
          !props.gmail.status()?.hasToken &&
          !props.gmail.status()?.paused &&
          !guide.step()
        }
      >
        <div class="rounded-inset border border-dls-info-border-subtle bg-dls-info-bg-subtle px-4 py-3 flex items-center justify-between gap-4">
          <div class="space-y-0.5 min-w-0">
            <div class="text-caption font-semibold text-dls-info-text">
              {t("settings.gmail_authorize_heading")}
            </div>
            {/* Only true once authorization started; after a failure the error
                above says why, and this would claim a browser that never opened. */}
            <Show when={!props.gmail.error()}>
              <div class="text-label text-dls-info-text leading-relaxed">
                {t("settings.gmail_auth_hint")}
              </div>
            </Show>
          </div>
          <button
            type="button"
            class="shrink-0 text-label font-medium text-dls-accent underline underline-offset-2 hover:opacity-80 transition-opacity disabled:opacity-40 whitespace-nowrap"
            onClick={() => void props.gmail.startAuth()}
            disabled={props.gmail.authBusy()}
          >
            {props.gmail.authBusy()
              ? t("settings.gmail_opening")
              : props.gmail.error()
                ? t("settings.gmail_try_again")
                : t("settings.gmail_didnt_open")}
          </button>
        </div>
      </Show>
    </div>
  );
}
