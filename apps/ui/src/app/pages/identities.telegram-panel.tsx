import { For, Show, createSignal, onCleanup } from "solid-js";
import { Copy, ExternalLink, Shield, Users } from "lucide-solid";

import Button from "~/shared/ui/button";
import ConfirmModal from "~/shared/ui/confirm-modal";
import type { OpenworkOpenCodeRouterIdentityItem } from "../lib/openwork-server";
import { t } from "../../i18n";
import { TelegramIcon } from "./identities.channel-icons";
import { applyErrorMessage, formatRequestError } from "./identities.channel-guards";
import type { ChannelCredentialsClient } from "./identities.types";
import { openUrl } from "./settings.platform-actions";

const STEP_BADGE =
  "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-pill bg-dls-active text-label font-semibold text-dls-text";

/** The router gives a bot only a short wait to start, so the list is read again once it has had time. */
const RECHECK_AFTER_SAVE_MS = 4_000;

type Access = "public" | "private";

/**
 * A private bot's pairing code, kept until it is disconnected: the host keeps only its hash, so this is the only
 * plaintext copy, and the dialog that shows it unmounts on close. Keyed by identity; in memory only.
 */
const pendingPairingCodes = new Map<string, string>();

/** The Telegram dialog: the saved bot and disconnecting it, or connecting one. The row's toggle pauses it. */
export default function TelegramPanel(props: {
  client: ChannelCredentialsClient | null;
  /** This workspace's identity id; null until a workspace is active. */
  identityId: string | null;
  identities: OpenworkOpenCodeRouterIdentityItem[];
  identitiesError: string | null;
  botUsername: string | null;
  refresh: () => void;
}) {
  const [token, setToken] = createSignal("");
  const [access, setAccess] = createSignal<Access>("public");
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [pairingCode, setPairingCodeShown] = createSignal<string | null>(
    props.identityId ? pendingPairingCodes.get(props.identityId) ?? null : null,
  );
  const [removeTarget, setRemoveTarget] = createSignal<string | null>(null);
  let recheck: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(recheck));

  const setPairingCode = (identityId: string, code: string | null) => {
    if (code) pendingPairingCodes.set(identityId, code);
    else pendingPairingCodes.delete(identityId);
    setPairingCodeShown(code);
  };

  const blocked = () => saving() || !props.identityId || !token().trim();

  const connect = async () => {
    const client = props.client;
    const identityId = props.identityId;
    const value = token().trim();
    const chosen = access();
    if (saving() || !identityId || !value) return;
    if (!client) {
      setError(t("identities.host_service_unavailable"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // The token goes to the host through ServiceHub; this process and openwork-server never hold it.
      const saved = await client.saveTelegramIdentity(identityId, { token: value, enabled: true, access: chosen });
      setPairingCode(identityId, chosen === "private" ? saved.pairingCode ?? null : null);
      if (saved.result.apply_error) setError(applyErrorMessage(saved.result.apply_error));
      setToken("");
      props.refresh();
      clearTimeout(recheck);
      recheck = setTimeout(props.refresh, RECHECK_AFTER_SAVE_MS);
    } catch (caught) {
      setError(formatRequestError(caught));
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async (identityId: string) => {
    const client = props.client;
    const workspaceIdentityId = props.identityId;
    if (saving() || !workspaceIdentityId || !identityId.trim()) return;
    if (!client) {
      setError(t("identities.host_service_unavailable"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await client.deleteChannelIdentity("telegram", identityId);
      setPairingCode(workspaceIdentityId, null);
      if (result.apply_error) setError(applyErrorMessage(result.apply_error));
      props.refresh();
    } catch (caught) {
      setError(formatRequestError(caught));
    } finally {
      setSaving(false);
    }
  };

  const copyPairingCode = async () => {
    const code = pairingCode();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      setError(t("identities.could_not_copy_pairing_code"));
    }
  };

  const botState = (item: OpenworkOpenCodeRouterIdentityItem) => {
    if (!item.enabled) return { label: t("connections.status_paused"), dot: "bg-dls-secondary" };
    if (item.running) return { label: t("identities.running"), dot: "bg-dls-success-dot" };
    return { label: t("connections.telegram_not_running"), dot: "bg-dls-warning-text" };
  };

  const accessOption = (value: Access, title: string, hint: string, icon: typeof Users) => {
    const Icon = icon;
    const selected = () => access() === value;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={selected()}
        data-testid={`telegram-access-${value}`}
        onClick={() => setAccess(value)}
        class={`flex items-start gap-2.5 rounded-control border px-3 py-2.5 text-left transition-colors ${
          selected() ? "border-dls-accent bg-dls-hover" : "border-dls-border hover:bg-dls-hover/60"
        }`}
      >
        <Icon size={16} class={`mt-0.5 shrink-0 ${selected() ? "text-dls-accent" : "text-dls-secondary"}`} />
        <span class="min-w-0">
          <span class="block text-body font-medium text-dls-text">{title}</span>
          <span class="block text-label text-dls-secondary leading-relaxed">{hint}</span>
        </span>
      </button>
    );
  };

  return (
    <div class="space-y-4">
      <Show when={props.identitiesError}>
        {(value) => (
          <div class="rounded-control border border-dls-warning-border bg-dls-warning-bg px-3 py-2 text-caption text-dls-warning-text">
            {value()}
          </div>
        )}
      </Show>

      <Show
        when={props.identities.length > 0}
        fallback={
          <div class="space-y-4" data-testid="telegram-setup">
            <div class="text-body text-dls-secondary">{t("connections.telegram_intro")}</div>
            <ol class="space-y-4">
              <li class="flex items-start gap-3">
                <span class={STEP_BADGE}>1</span>
                <div class="min-w-0 flex-1 space-y-2">
                  <div class="text-body text-dls-text">{t("connections.telegram_step_create")}</div>
                  <Button
                    variant="outline"
                    class="h-8 px-3 text-label"
                    data-testid="telegram-open-botfather"
                    onClick={() => void openUrl("https://t.me/BotFather")}
                  >
                    <ExternalLink size={13} />
                    {t("connections.telegram_open_botfather")}
                  </Button>
                </div>
              </li>
              <li class="flex items-start gap-3">
                <span class={STEP_BADGE}>2</span>
                <div class="min-w-0 flex-1 space-y-2">
                  <label for="telegram-token" class="block text-body text-dls-text">
                    {t("connections.telegram_step_token")}
                  </label>
                  <input
                    id="telegram-token"
                    data-testid="telegram-token-input"
                    class="w-full rounded-control border border-dls-border bg-dls-surface px-3 py-2.5 text-body-lg text-dls-text placeholder:text-dls-secondary outline-none focus:border-dls-accent"
                    placeholder={t("identities.telegram_token_placeholder")}
                    type="password"
                    autocomplete="off"
                    value={token()}
                    onInput={(event) => setToken(event.currentTarget.value)}
                  />
                </div>
              </li>
              <li class="flex items-start gap-3">
                <span class={STEP_BADGE}>3</span>
                <div class="min-w-0 flex-1 space-y-2">
                  <div class="text-body text-dls-text">{t("connections.telegram_step_access")}</div>
                  <div role="radiogroup" class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {accessOption("public", t("identities.public"), t("connections.telegram_public_hint"), Users)}
                    {accessOption("private", t("identities.private"), t("connections.telegram_private_hint"), Shield)}
                  </div>
                </div>
              </li>
            </ol>
            <button
              type="button"
              data-testid="telegram-connect"
              onClick={() => void connect()}
              disabled={blocked()}
              class={`flex w-full items-center justify-center gap-2 rounded-control px-4 py-2.5 text-body-lg font-semibold text-white transition-opacity ${
                blocked() ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:opacity-90"
              }`}
              style={{ background: "var(--dls-provider-telegram-brand)" }}
            >
              {saving() ? t("identities.connecting") : t("connections.telegram_connect")}
            </button>
          </div>
        }
      >
        <For each={props.identities}>
          {(item) => {
            const username = () => item.bot?.username ?? props.botUsername;
            const state = () => botState(item);
            return (
              <div
                class="space-y-3 rounded-control border border-dls-panel-inset-border bg-dls-panel-inset-bg p-4"
                data-testid="telegram-bot-card"
              >
                <div class="flex items-center justify-between gap-3">
                  <div class="flex min-w-0 items-center gap-3">
                    <TelegramIcon size={32} />
                    <div class="min-w-0">
                      <div class="truncate text-body-lg font-semibold text-dls-text">
                        {username() ? `@${username()}` : t("connections.telegram_bot_fallback_name")}
                      </div>
                      <div class="mt-0.5 flex items-center gap-1.5 text-label text-dls-secondary">
                        <span class={`h-1.5 w-1.5 rounded-pill ${state().dot}`} />
                        <span data-testid="telegram-bot-state">{state().label}</span>
                        <span aria-hidden="true">·</span>
                        <span>{item.access === "private" ? t("identities.private") : t("identities.public")}</span>
                      </div>
                    </div>
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    <Show when={username()}>
                      {(name) => (
                        <Button
                          variant="outline"
                          class="h-8 px-3 text-label"
                          data-testid="telegram-open-bot"
                          onClick={() => void openUrl(`https://t.me/${name()}`)}
                        >
                          <ExternalLink size={13} />
                          {t("connections.telegram_open_bot")}
                        </Button>
                      )}
                    </Show>
                    <Button
                      data-testid="telegram-disconnect-button"
                      variant="outline"
                      class="h-8 px-3 text-label"
                      disabled={saving() || item.id === "env" || !props.identityId}
                      onClick={() => setRemoveTarget(item.id)}
                    >
                      {t("identities.disconnect")}
                    </Button>
                  </div>
                </div>
                <div class="text-label text-dls-secondary leading-relaxed">
                  {item.access === "private" ? t("connections.telegram_private_hint") : t("connections.telegram_public_hint")}
                </div>
                <Show when={!item.enabled}>
                  <div class="text-label text-dls-secondary leading-relaxed">{t("connections.telegram_paused_note")}</div>
                </Show>
              </div>
            );
          }}
        </For>

        <Show when={pairingCode()}>
          {(code) => (
            <div class="space-y-2 rounded-inset border border-dls-pairing-border bg-dls-pairing-bg px-3.5 py-3">
              <div class="text-caption font-semibold text-dls-workspace-remote-text">{t("identities.private_pairing_code")}</div>
              <div class="flex items-center gap-2">
                <div class="flex-1 rounded-subtle border border-dls-pairing-code-border bg-dls-pairing-code-bg px-3 py-2 font-mono text-body tracking-[0.08em] text-dls-pairing-code-text">
                  {code()}
                </div>
                <Button variant="outline" class="h-8 px-3 text-label" onClick={() => void copyPairingCode()}>
                  <Copy size={12} />
                  {t("identities.copy_code")}
                </Button>
              </div>
              <div class="text-label text-dls-workspace-remote-text/90 leading-relaxed">
                {t("identities.pairing_instruction")}{" "}
                <code class="rounded-compact bg-dls-pairing-inline-bg px-1 py-0.5 font-mono text-tiny">/pair {code()}</code>.
              </div>
            </div>
          )}
        </Show>

        <div class="text-label text-dls-secondary">{t("connections.telegram_replace_note")}</div>
      </Show>

      <Show when={error()}>{(value) => <div class="text-label text-dls-danger-text">{value()}</div>}</Show>

      <ConfirmModal
        open={removeTarget() !== null}
        title={t("connections.telegram_disconnect_title")}
        message={t("connections.telegram_disconnect_message")}
        confirmLabel={t("identities.disconnect")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        data-testid="telegram-disconnect-confirm"
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          const target = removeTarget();
          setRemoveTarget(null);
          if (target) void disconnect(target);
        }}
      />
    </div>
  );
}
