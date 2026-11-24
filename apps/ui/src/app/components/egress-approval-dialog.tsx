import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { ShieldAlert } from "lucide-solid";
import type {
  EgressApprovalDecision,
  EgressApprovalGrantScope,
} from "@different-ai/openwork-contracts/sandbox-manager-host-api";

import {
  PROXY_UNLISTED_ACTION,
  approvalChoices,
  liveApprovals,
  secondsLeft,
  type EgressApprovals,
} from "../../features/egress-approvals";
import { currentLocale, t } from "../../i18n";
import Button from "./button";

/** After a different approval appears, Allow stays off this long, so a click aimed at the one before cannot answer it. */
export const ARM_DELAY_MS = 700;
/** The Sandbox Manager ends a target it had to shorten with this character, and strips it from any text. */
const SHORTENED_MARK = "…";

export type EgressApprovalDialogProps = {
  egress: EgressApprovals;
};

/**
 * Asks about the oldest egress request still waiting (EG1-7, #16). The target is what the user
 * approves, so it is shown whole, as text, in a box that scrolls rather than an ellipsis.
 *
 * What the user clicks must be what they read: Allow is off for a moment after the approval on
 * screen changes, a press is bound to the approval that was shown when it began, Escape denies
 * (it never approves) and focus starts on Deny and stays inside.
 */
export default function EgressApprovalDialog(props: EgressApprovalDialogProps) {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (props.egress.approvals().length === 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    onCleanup(() => clearInterval(timer));
  });
  const live = createMemo(() => liveApprovals(props.egress.approvals(), now()));
  const shownId = createMemo(() => live()[0]?.approval_id ?? null);

  const [armed, setArmed] = createSignal(false);
  let dialog: HTMLDivElement | undefined;
  let pressedId: string | null = null;

  createEffect(
    on(shownId, (id) => {
      setArmed(false);
      if (id === null) return;
      const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS);
      onCleanup(() => clearTimeout(timer));
      dialog?.querySelector<HTMLElement>("[data-testid=egress-approval-deny-btn]")?.focus();
    }),
  );

  // Only an approval offering the chat names one: offered once alone, its chat could not be told.
  const chatName = createMemo(() => {
    const shown = live()[0];
    if (shown?.session_ref === undefined || !shown.grant_scopes?.includes("all_for_chat")) return null;
    return props.egress.chatName(shown.session_ref);
  });

  const answer = (decision: EgressApprovalDecision, grantScope?: EgressApprovalGrantScope) => {
    const current = shownId();
    const id = pressedId ?? current;
    pressedId = null;
    // A press that began on another approval than the one now shown answers nothing.
    if (id === null || id !== current) return;
    if (decision === "approve" && !armed()) return;
    // An approval that lists no scopes is answered as it always was: with none.
    if (grantScope === undefined) void props.egress.decide(id, decision);
    else void props.egress.decide(id, decision, grantScope);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (props.egress.decidingId() === null) answer("deny");
      return;
    }
    if (event.key !== "Tab" || !dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled])"));
    event.preventDefault();
    if (focusable.length === 0) return;
    const at = focusable.indexOf(document.activeElement as HTMLElement);
    const step = event.shiftKey ? -1 : 1;
    focusable[(at + step + focusable.length) % focusable.length]?.focus();
  };

  const Notice = () => (
    <Show when={props.egress.notice()}>
      {(message) => (
        <div
          data-testid="egress-approval-notice"
          class="mb-3 flex items-start justify-between gap-3 rounded-control border border-dls-warning-border bg-dls-warning-bg px-3 py-2 text-caption text-dls-warning-text"
        >
          <span>{message()}</span>
          <Button
            variant="outline"
            class="h-7 px-2 text-caption"
            data-testid="egress-approval-notice-close-btn"
            onClick={() => props.egress.dismissNotice()}
          >
            {t("common.close")}
          </Button>
        </div>
      )}
    </Show>
  );

  return (
    <>
      <Show when={live()[0]}>
        {(approval) => (
          <div class="fixed inset-0 z-[70] dls-modal-backdrop flex items-center justify-center p-4 font-sans">
            <div
              ref={dialog}
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="egress-approval-title"
              tabindex="-1"
              data-testid="egress-approval-dialog"
              class="w-full max-w-lg overflow-hidden border dls-modal-surface"
              onKeyDown={onKeyDown}
            >
              <div class="p-6">
                <Notice />
                <div class="flex items-start gap-4">
                  <div class="shrink-0 w-10 h-10 rounded-pill flex items-center justify-center bg-dls-warning-bg text-dls-warning-text">
                    <ShieldAlert size={20} />
                  </div>
                  <div class="min-w-0 flex-1">
                    <h3 id="egress-approval-title" class="text-body-lg font-semibold text-dls-text">
                      {t("egress_approval.title")}
                    </h3>
                    <p class="mt-2 text-body-lg text-dls-secondary">
                      {t(`egress_approval.action.${approval().action}`)}
                    </p>
                    <div class="mt-4 text-caption font-medium text-dls-secondary">
                      {t(`egress_approval.target.${approval().action}`)}
                      <Show when={approval().target.endsWith(SHORTENED_MARK)}>
                        <span data-testid="egress-approval-shortened" class="ml-2 font-normal text-dls-warning-text">
                          {t("egress_approval.shortened")}
                        </span>
                      </Show>
                    </div>
                    <div
                      data-testid="egress-approval-target"
                      class="mt-1 max-h-40 overflow-auto rounded-control border border-dls-panel-input-border bg-dls-panel-input-bg px-3 py-2 font-mono text-caption text-dls-text break-all whitespace-pre-wrap"
                    >
                      {approval().target}
                    </div>
                    <dl class="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-caption">
                      <dt class="text-dls-secondary">{t("egress_approval.caller")}</dt>
                      <dd class="text-dls-text">{t(`egress_approval.caller.${approval().caller}`)}</dd>
                      <Show when={chatName()}>
                        {(name) => (
                          <>
                            <dt class="text-dls-secondary">{t("egress_approval.chat")}</dt>
                            <dd data-testid="egress-approval-chat-name" class="text-dls-text break-all">
                              {name()}
                            </dd>
                          </>
                        )}
                      </Show>
                      <dt class="text-dls-secondary">{t("egress_approval.audience")}</dt>
                      <dd class="text-dls-text">
                        {t(`egress_approval.audience.${approval().audience}`)}
                      </dd>
                      <dt class="text-dls-secondary">{t("egress_approval.requested_at")}</dt>
                      <dd class="text-dls-text">
                        {new Date(approval().requested_at).toLocaleTimeString(currentLocale())}
                      </dd>
                      <dt class="text-dls-secondary">{t("egress_approval.expires_in")}</dt>
                      <dd class="text-dls-text">
                        {t("egress_approval.seconds").replace(
                          "{seconds}",
                          String(secondsLeft(approval(), now())),
                        )}
                      </dd>
                      <dt class="text-dls-secondary">{t("egress_approval.id")}</dt>
                      <dd class="font-mono text-dls-text break-all">{approval().approval_id}</dd>
                    </dl>
                    <Show when={approval().grant_scopes}>
                      {(scopes) => (
                        <p data-testid="egress-approval-chat-note" class="mt-3 text-caption text-dls-secondary">
                          {!scopes().includes("all_for_chat")
                            ? t("egress_approval.unknown_chat_note")
                            : approval().action === PROXY_UNLISTED_ACTION
                              ? t("egress_approval.proxy.chat_scope_note")
                              : t("egress_approval.chat_scope_note")}
                        </p>
                      )}
                    </Show>
                    <Show when={live().length > 1}>
                      <p class="mt-3 text-caption text-dls-secondary">
                        {t("egress_approval.waiting").replace("{count}", String(live().length))}
                      </p>
                    </Show>
                    <Show
                      when={
                        props.egress.decisionError()?.approvalId === approval().approval_id
                          ? props.egress.decisionError()
                          : null
                      }
                    >
                      {(failed) => (
                        <p role="alert" class="mt-3 text-caption text-dls-danger-text">
                          {failed().message}
                        </p>
                      )}
                    </Show>
                  </div>
                </div>

                <div class="mt-6 flex flex-wrap justify-end gap-2">
                  <For each={approvalChoices(approval())}>
                    {(choice) => (
                      <Button
                        variant={choice.decision === "deny" ? "outline" : undefined}
                        data-testid={choice.testId}
                        disabled={props.egress.decidingId() !== null || (choice.decision === "approve" && !armed())}
                        onPointerDown={() => (pressedId = shownId())}
                        onClick={() => answer(choice.decision, choice.grantScope)}
                      >
                        {t(choice.labelKey)}
                      </Button>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </div>
        )}
      </Show>
      <Show when={!live()[0] && props.egress.notice()}>
        <div class="fixed inset-0 z-[70] dls-modal-backdrop flex items-center justify-center p-4 font-sans">
          <div
            role="alertdialog"
            aria-modal="true"
            data-testid="egress-approval-notice-dialog"
            class="w-full max-w-md border p-6 dls-modal-surface"
          >
            <Notice />
          </div>
        </div>
      </Show>
    </>
  );
}
