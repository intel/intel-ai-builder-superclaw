import { For, Show, createSignal } from "solid-js";

import Button from "~/shared/ui/button";
import ConfirmModal from "~/shared/ui/confirm-modal";
import ToggleSwitch from "~/shared/ui/toggle-switch";
import type { OpenworkOpenCodeRouterIdentityItem } from "../lib/openwork-server";
import { t } from "../../i18n";
import { applyErrorMessage, classifySlackSaveError, formatRequestError } from "./identities.channel-guards";
import SlackInstallPanel from "./identities.slack-install";
import SlackSendersPanel from "./identities.slack-senders";
import type { ChannelCredentialsClient } from "./identities.types";

/**
 * The Slack dialog: each saved bot with its own switch and Remove, who they answer, and connecting one. The row's
 * toggle follows this workspace's bot.
 */
export default function SlackPanel(props: {
  client: ChannelCredentialsClient | null;
  /** This workspace's identity id; null until a workspace is active. */
  identityId: string | null;
  identities: OpenworkOpenCodeRouterIdentityItem[];
  identitiesError: string | null;
  refresh: () => void;
}) {
  const [saving, setSaving] = createSignal(false);
  const [status, setStatus] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [removeTarget, setRemoveTarget] = createSignal<string | null>(null);

  const remove = async (identityId: string) => {
    const client = props.client;
    if (saving() || !props.identityId || !identityId.trim()) return;
    if (!client) {
      setError(t("identities.host_service_unavailable"));
      return;
    }
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      const result = await client.deleteChannelIdentity("slack", identityId);
      setStatus(result.applied ? t("identities.slack_disconnected") : t("identities.slack_disconnected_pending_apply"));
      if (result.apply_error) setError(applyErrorMessage(result.apply_error));
      props.refresh();
    } catch (caught) {
      setError(formatRequestError(caught));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (identityId: string, enabled: boolean) => {
    const client = props.client;
    if (saving() || !props.identityId) return;
    if (!client) {
      setError(t("identities.host_service_unavailable"));
      return;
    }
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      const result = await client.setSlackIdentityEnabled(identityId, enabled);
      // Saved either way; a bot still starting is not an error, so only a real apply error is shown.
      setStatus(enabled ? t("identities.slack_switched_on") : t("identities.slack_switched_off"));
      if (result.apply_error) setError(applyErrorMessage(result.apply_error));
      props.refresh();
    } catch (caught) {
      // Slack no longer takes the kept tokens (the app was deleted or reinstalled), so only a new setup helps.
      setError(
        classifySlackSaveError(caught).kind === "invalid_token"
          ? t("identities.slack_switch_rejected")
          : formatRequestError(caught),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="space-y-3">
      <div class="text-body text-dls-secondary">{t("identities.slack_card_description")}</div>
      <Show when={props.identitiesError}>
        {(value) => (
          <div class="rounded-control border border-dls-warning-border bg-dls-warning-bg px-3 py-2 text-caption text-dls-warning-text">
            {value()}
          </div>
        )}
      </Show>

      <Show when={props.identities.length > 0}>
        <div class="space-y-2">
          <For each={props.identities}>
            {(item) => (
              <div class="flex items-center justify-between gap-3 rounded-control border border-dls-panel-inset-border bg-dls-panel-inset-bg px-3 py-2.5">
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <div class={`w-1.5 h-1.5 rounded-pill flex-shrink-0 ${item.running ? "bg-dls-success-dot" : "bg-dls-secondary"}`} />
                    <span class="font-mono text-caption font-semibold text-dls-text truncate">{item.id}</span>
                  </div>
                  <div class="text-label text-dls-secondary mt-0.5 pl-3.5" data-testid="slack-channel-status">
                    {item.enabled ? t("identities.enabled") : t("identities.disabled")} ·{" "}
                    {item.running ? t("identities.running") : t("identities.stopped")}
                  </div>
                </div>
                <div class="flex flex-shrink-0 items-center gap-2">
                  <ToggleSwitch
                    data-testid="slack-enabled-switch"
                    aria-label={t("identities.slack_switch_label")}
                    checked={item.enabled}
                    disabled={saving() || item.id === "env" || !props.identityId}
                    onChange={(enabled) => void toggle(item.id, enabled)}
                  />
                  <Button
                    data-testid="slack-disconnect-button"
                    variant="outline"
                    class="h-7 px-2.5 text-label"
                    disabled={saving() || item.id === "env" || !props.identityId}
                    onClick={() => setRemoveTarget(item.id)}
                  >
                    {t("identities.slack_remove")}
                  </Button>
                </div>
              </div>
            )}
          </For>
        </div>
        <SlackSendersPanel client={props.client} />
      </Show>

      <SlackInstallPanel
        client={props.client}
        identityId={props.identityId}
        connected={props.identities.length > 0}
        onConnected={(notice, applyError) => {
          setStatus(notice);
          setError(applyError);
          props.refresh();
        }}
      />

      <Show when={status()}>{(value) => <div class="text-label text-dls-secondary">{value()}</div>}</Show>
      <Show when={error()}>{(value) => <div class="text-label text-dls-danger-text">{value()}</div>}</Show>

      <ConfirmModal
        open={removeTarget() !== null}
        title={t("connections.slack_remove_title")}
        message={t("connections.slack_remove_message")}
        confirmLabel={t("identities.slack_remove")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        data-testid="slack-remove-confirm"
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          const target = removeTarget();
          setRemoveTarget(null);
          if (target) void remove(target);
        }}
      />
    </div>
  );
}
