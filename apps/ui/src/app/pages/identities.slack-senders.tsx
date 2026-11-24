import { For, Show, createSignal, onCleanup, onMount } from "solid-js";

import Button from "~/shared/ui/button";
import { t } from "../../i18n";
import type { SlackSenders } from "~/shared/platform/transport/instance-api";
import { formatRequestError } from "./identities.channel-guards";
import type { ChannelCredentialsClient } from "./identities.types";

const formatTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Who the Slack bot answers: pending requests to approve, and approved senders to remove. */
export default function SlackSendersPanel(props: { client: Pick<ChannelCredentialsClient, "slackSenders" | "setSlackSender"> | null }) {
  const [senders, setSenders] = createSignal<SlackSenders | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busyUserId, setBusyUserId] = createSignal<string | null>(null);

  const load = async () => {
    const client = props.client;
    if (!client) return;
    try {
      const next = await client.slackSenders();
      // Replacing an unchanged list would re-create its rows and drop keyboard focus on every poll.
      if (JSON.stringify(next) !== JSON.stringify(senders())) setSenders(next);
      setError(null);
    } catch (err) {
      setError(formatRequestError(err));
    }
  };

  const update = async (userId: string, allowed: boolean) => {
    const client = props.client;
    if (!client) return;
    setBusyUserId(userId);
    try {
      setSenders(await client.setSlackSender(userId, allowed));
      setError(null);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setBusyUserId(null);
    }
  };

  onMount(() => {
    void load();
    // A request appears as soon as someone messages the bot, so keep the list current while it is open.
    const interval = window.setInterval(() => void load(), 5_000);
    onCleanup(() => window.clearInterval(interval));
  });

  return (
    <div data-testid="slack-senders" class="space-y-2 rounded-control border border-dls-border px-3 py-2.5">
      <div>
        <div class="text-body font-semibold text-dls-text">{t("identities.slack_senders_title")}</div>
        <div class="text-label text-dls-secondary mt-0.5">{t("identities.slack_senders_hint")}</div>
      </div>

      <Show when={error()}>{(value) => <div class="text-label text-dls-danger-text">{value()}</div>}</Show>

      <Show when={senders()}>
        {(list) => (
          <div class="space-y-1.5">
            <For each={list().pending}>
              {(entry) => (
                <div
                  data-testid="slack-sender-pending"
                  class="flex items-center justify-between gap-3 rounded-control border border-dls-warning-border bg-dls-warning-bg px-3 py-2"
                >
                  <div class="min-w-0">
                    <div class="font-mono text-caption text-dls-text truncate">{entry.userId}</div>
                    <div class="text-label text-dls-warning-text">
                      {t("identities.slack_sender_pending")} · {t("identities.slack_sender_last_message")} {formatTime(entry.lastSeenAt)}
                    </div>
                  </div>
                  <Button
                    data-testid="slack-sender-allow"
                    class="h-7 px-2.5 text-label flex-shrink-0"
                    disabled={busyUserId() !== null}
                    onClick={() => void update(entry.userId, true)}
                  >
                    {t("identities.slack_sender_allow")}
                  </Button>
                </div>
              )}
            </For>

            <For each={list().allowed}>
              {(entry) => (
                <div
                  data-testid="slack-sender-allowed"
                  class="flex items-center justify-between gap-3 rounded-control border border-dls-panel-inset-border bg-dls-panel-inset-bg px-3 py-2"
                >
                  <div class="min-w-0">
                    <div class="font-mono text-caption text-dls-text truncate">{entry.userId}</div>
                    <div class="text-label text-dls-secondary">
                      {entry.source === "env" ? t("identities.slack_sender_from_env") : t("identities.slack_sender_approved")}
                    </div>
                  </div>
                  <Show when={entry.source === "app"}>
                    <Button
                      data-testid="slack-sender-remove"
                      variant="outline"
                      class="h-7 px-2.5 text-label flex-shrink-0"
                      disabled={busyUserId() !== null}
                      onClick={() => void update(entry.userId, false)}
                    >
                      {t("identities.slack_sender_remove")}
                    </Button>
                  </Show>
                </div>
              )}
            </For>

            <Show when={list().pending.length === 0 && list().allowed.length === 0}>
              <div class="text-label text-dls-secondary">{t("identities.slack_senders_empty")}</div>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
