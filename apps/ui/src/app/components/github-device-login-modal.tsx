import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { Check, Copy, Loader2, X } from "lucide-solid";
import Button from "./button";
import { t } from "../../i18n";

export type GithubDeviceLoginModalProps = {
  open: boolean;
  userCode: string | null;
  verificationUri: string | null;
  /** Epoch ms at which the code stops being redeemable, for the countdown. */
  expiresAt: number | null;
  onOpenUrl: (url: string) => void;
  /** Dismiss and cancel the outstanding flow. */
  onClose: () => void;
};

/**
 * Device-code panel for connecting a GitHub account, deliberately a step-for-step
 * copy of the `oauth-device` view in `provider-auth-modal.tsx` (how you connect
 * GitHub Copilot): same chrome, same three numbered steps, same copyable code
 * box, same countdown. Users reach both from Settings, and sharing the
 * `provider_auth.device_*` strings keeps the wording from drifting apart.
 *
 * Only ever shows a live flow — the status poll reports both terminal outcomes
 * and unmounts this, success as `authenticated` and failure as an error on the
 * card underneath — so closing is always a cancel.
 */
export default function GithubDeviceLoginModal(props: GithubDeviceLoginModalProps): JSX.Element {
  const [copied, setCopied] = createSignal(false);
  const [nowMs, setNowMs] = createSignal(Date.now());

  const code = createMemo(() => props.userCode?.trim() ?? "");
  const uri = createMemo(() => props.verificationUri?.trim() ?? "");

  const copyCode = async () => {
    const value = code();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      // No clipboard permission. The code box is `select-all`, so it can still
      // be copied by hand.
    }
  };

  // Ticks only while the modal is up, so a dismissed dialog leaves no timer and
  // reopening starts from a clean copy button.
  createEffect(() => {
    if (!props.open) {
      setCopied(false);
      return;
    }
    setNowMs(Date.now());
    const tick = window.setInterval(() => setNowMs(Date.now()), 1_000);
    onCleanup(() => window.clearInterval(tick));
  });

  const countdown = createMemo(() => {
    const deadline = props.expiresAt;
    if (!deadline) return null;
    const secs = Math.max(0, Math.floor((deadline - nowMs()) / 1_000));
    return {
      expired: secs === 0,
      urgent: secs <= 30,
      label: `${Math.floor(secs / 60)}:${(secs % 60).toString().padStart(2, "0")}`,
    };
  });

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-[60] dls-modal-backdrop flex items-center justify-center p-4 overflow-y-auto">
        <div class="border w-full max-w-lg overflow-hidden max-h-[calc(100vh-2rem)] flex flex-col dls-modal-surface">
          <div class="px-6 pt-6 pb-4 border-b border-dls-border/50 flex items-start justify-between gap-4">
            <div>
              <h3 class="text-heading font-semibold text-dls-text">{t("settings.github_title")}</h3>
              <p class="text-body-lg text-dls-secondary mt-1">{t("provider_auth.oauth_device_subtitle")}</p>
            </div>
            <Button
              variant="ghost"
              class="!p-2 rounded-pill"
              onClick={() => props.onClose()}
              aria-label={t("common.close")}
              data-testid="modal-dismiss-btn"
            >
              <X size={16} />
            </Button>
          </div>

          <div class="px-6 py-4 flex flex-col gap-4 min-h-0">
            <ol class="space-y-3 text-caption text-dls-secondary">
              <li class="flex gap-2">
                <span class="text-dls-muted">1.</span>
                <span>
                  {t("provider_auth.device_step_open")}{" "}
                  <button
                    type="button"
                    class="underline font-medium text-dls-link hover:text-dls-link-hover transition-colors"
                    onClick={() => props.onOpenUrl(uri())}
                    disabled={!uri()}
                  >
                    {uri() || t("provider_auth.device_open_link")}
                  </button>
                </span>
              </li>
              <li class="flex flex-col gap-2">
                <div class="flex gap-2">
                  <span class="text-dls-muted">2.</span>
                  <span>{t("provider_auth.device_step_code")}</span>
                </div>
                <div class="flex items-center gap-2 pl-4">
                  <div
                    data-testid="github-device-code"
                    class="flex-1 rounded-subtle border border-dls-border/70 bg-dls-surface-solid/70 px-4 py-3 text-center font-mono text-heading-lg tracking-[0.3em] text-dls-text select-all"
                  >
                    {code() || "········"}
                  </div>
                  <Button
                    variant="outline"
                    class="!px-3 h-11 shrink-0"
                    onClick={() => void copyCode()}
                    disabled={!code()}
                    aria-label={t("provider_auth.device_copy_code")}
                  >
                    <Show when={copied()} fallback={<Copy size={16} />}>
                      <Check size={16} class="text-dls-success-text" />
                    </Show>
                  </Button>
                </div>
              </li>
              <li class="flex gap-2">
                <span class="text-dls-muted">3.</span>
                <span>{t("provider_auth.device_step_authorize")}</span>
              </li>
            </ol>

            <div class="flex items-center justify-between gap-3 border-t border-dls-border/40 pt-3">
              {/* Always spinning: while this modal is up the card is polling the
                  sandbox every couple of seconds, so there is no idle state to
                  represent. */}
              <div class="flex items-center gap-2 text-caption text-dls-muted">
                <Loader2 size={14} class="animate-spin" />
                <span>{t("provider_auth.checking_status")}</span>
              </div>
              <Show when={countdown()}>
                {(remaining) => (
                  <div
                    class={`text-label font-mono ${
                      remaining().urgent ? "text-dls-warning-text" : "text-dls-muted"
                    }`}
                  >
                    {remaining().expired
                      ? t("provider_auth.device_expired")
                      : `${t("provider_auth.device_expires_in")} ${remaining().label}`}
                  </div>
                )}
              </Show>
            </div>
          </div>

          <div class="px-6 pt-4 pb-6 border-t border-dls-border/50">
            <Button variant="ghost" class="w-full" onClick={() => props.onClose()}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}
