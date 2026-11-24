import { Show, createMemo, createSignal } from "solid-js";

import {
  tavilyKeyControls,
  type TavilyKeyRequestStatus,
  type TavilyKeyView,
} from "~/features/tavily-api-key";
import Button from "../components/button";
import ConfirmModal from "~/shared/ui/confirm-modal";
import { t } from "../../i18n";
import { openUrl } from "./settings.platform-actions";

export type TavilyKeyRowProps = {
  view: TavilyKeyView;
  status: TavilyKeyRequestStatus;
  save: (apiKey: string) => Promise<void>;
  clear: () => Promise<void>;
  retry: () => Promise<void>;
  /** The line Settings shows under the search card: what happened to the last action. */
  onStatus: (message: string | null) => void;
};

/** The Tavily key row of Settings: the badge, the host's answer when it cannot be read, and the controls. */
export default function TavilyKeyRow(props: TavilyKeyRowProps) {
  const [input, setInput] = createSignal("");
  const [confirmingClear, setConfirmingClear] = createSignal(false);
  const controls = createMemo(() => tavilyKeyControls(props.view, props.status));
  const configured = () => controls().badge === "configured";
  const saved = () => configured() || controls().badge === "paused";
  const readError = () => (props.view.kind === "unreadable" ? props.view.message : null);
  const badgeText = () => {
    switch (controls().badge) {
      case "configured":
        return t("settings.tavily_configured");
      case "paused":
        return t("connections.status_paused");
      case "unavailable":
        return t("settings.tavily_unavailable_in_this_mode");
      case "unreadable":
        return t("settings.tavily_status_unreadable");
      case "loading":
        return t("settings.tavily_status_loading");
      default:
        return t("settings.tavily_not_configured");
    }
  };

  const save = async () => {
    const key = input().trim();
    if (!key) {
      props.onStatus(t("settings.tavily_enter_before_save"));
      return;
    }
    props.onStatus(null);
    try {
      await props.save(key);
      // The typed key stays in the box when a save fails, so the user can retry; it is
      // cleared here, once the host has taken it.
      setInput("");
      props.onStatus(t("settings.tavily_saved"));
    } catch (error) {
      props.onStatus(error instanceof Error ? error.message : t("settings.tavily_save_failed"));
    }
  };

  const clear = async () => {
    props.onStatus(null);
    try {
      await props.clear();
      setInput("");
      props.onStatus(t("settings.tavily_cleared"));
    } catch (error) {
      props.onStatus(error instanceof Error ? error.message : t("settings.tavily_clear_failed"));
    }
  };

  return (
    <div class="rounded-inset border border-dls-border-strong bg-dls-panel-inset-bg p-4 space-y-3">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="text-body-lg font-medium text-dls-text">Tavily</div>
          <div class="text-caption text-dls-secondary mt-1">{t("settings.search_no_tavily_default")}</div>
          <Show when={controls().showRecommendation}>
            <div class="text-caption text-dls-secondary mt-1">
              {t("settings.search_tavily_recommended")}{" "}
              <a
                href="https://www.tavily.com/"
                target="_blank"
                rel="noopener noreferrer"
                class="text-dls-accent underline underline-offset-2 hover:opacity-80"
                onClick={async (e) => {
                  e.preventDefault();
                  await openUrl("https://www.tavily.com/");
                }}
              >
                {t("settings.search_tavily_here")}
              </a>
              .
            </div>
          </Show>
        </div>
        <div
          data-testid="tavily-status-badge"
          class={`inline-flex items-center gap-2 rounded-pill border px-2.5 py-1 text-label font-medium ${configured() ? "bg-dls-success-bg text-dls-success-text border-dls-success-border" : "bg-dls-surface-muted text-dls-secondary border-dls-panel-border"}`}
        >
          <span data-testid="tavily-status-dot" class={`h-2 w-2 rounded-pill ${configured() ? "bg-dls-success-dot" : "bg-dls-hover"}`} />
          {badgeText()}
        </div>
      </div>
      <Show when={controls().canRetry}>
        <div
          data-testid="tavily-read-error"
          class="flex flex-wrap items-center gap-2 text-caption text-dls-danger-text"
        >
          <span>{readError()}</span>
          <Button
            variant="outline"
            class="text-caption h-7 px-2"
            data-testid="tavily-retry-btn"
            onClick={() => void props.retry()}
          >
            {t("settings.tavily_retry")}
          </Button>
        </div>
      </Show>
      <div class="flex flex-col gap-2 sm:flex-row">
        <input
          type="password"
          autocomplete="off"
          data-testid="tavily-api-key-input"
          class="min-w-0 flex-1 rounded-control border border-dls-border-strong bg-dls-panel-inset-bg px-3 py-2 text-body-lg text-dls-text outline-none focus:border-dls-accent disabled:opacity-60"
          placeholder={
            saved() ? t("settings.tavily_placeholder_replace") : t("settings.tavily_placeholder_enter")
          }
          value={input()}
          onInput={(event) => setInput((event.target as HTMLInputElement).value)}
          disabled={controls().inputDisabled}
        />
        <Button
          variant="secondary"
          class="text-caption h-9 px-3"
          data-testid="tavily-save-btn"
          onClick={() => void save()}
          disabled={controls().inputDisabled || !input().trim()}
        >
          {t("settings.save")}
        </Button>
        <Button
          variant="outline"
          class="text-caption h-9 px-3"
          data-testid="tavily-clear-btn"
          onClick={() => setConfirmingClear(true)}
          disabled={controls().clearDisabled}
        >
          {t("settings.clear")}
        </Button>
      </div>
      <ConfirmModal
        open={confirmingClear()}
        title={t("connections.tavily_clear_title")}
        message={t("connections.tavily_clear_message")}
        confirmLabel={t("settings.clear")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        data-testid="tavily-clear-confirm"
        onCancel={() => setConfirmingClear(false)}
        onConfirm={() => {
          setConfirmingClear(false);
          void clear();
        }}
      />
    </div>
  );
}
