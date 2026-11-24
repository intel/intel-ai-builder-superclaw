import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { Globe, Monitor } from "lucide-solid";
import {
  hostMcpToolIsReadOnly,
  type HostMcpApprovalDecision,
  type HostMcpBrowserOriginApproval,
  type HostMcpGrantScope,
  type HostMcpPendingApproval,
  type HostMcpToolCallApproval,
} from "@different-ai/openwork-contracts/host-mcp-api";

import Button from "~/shared/ui/button";
import { t } from "../../i18n";
import {
  formatTimeLeft,
  hostApprovalChoices,
  liveHostApprovals,
  secondsLeft,
  standingGrantsLine,
  standingGrantsText,
} from "./host-mcp";
import type { HostMcpApprovals } from "./useHostMcp";

/** After a different approval appears, Allow stays off this long, so a click aimed at the one before cannot answer it. */
export const ARM_DELAY_MS = 700;

export type HostMcpApprovalDialogProps = {
  approvals: HostMcpApprovals;
  /** The bar's Stop all, offered here too because the dialog's overlay covers the bar. */
  stopAll?: () => Promise<void>;
};

const asToolCall = (approval: HostMcpPendingApproval): HostMcpToolCallApproval | null =>
  approval.kind === "tool_call" ? approval : null;
const asBrowserOrigin = (approval: HostMcpPendingApproval): HostMcpBrowserOriginApproval | null =>
  approval.kind === "browser_origin" ? approval : null;
const distinctTitle = (call: HostMcpToolCallApproval): string | null =>
  call.title && call.title.trim().toLowerCase() !== call.tool.trim().toLowerCase() ? call.title : null;

/**
 * Asks about the oldest host MCP request still waiting: a tool call on this computer, or a host
 * browser navigation. Every word about the request is text the gateway sent, shown as text.
 *
 * What the user clicks must be what they read: Allow is off for a moment after the approval on screen
 * changes, a press is bound to the approval that was shown when it began, Escape denies (it never
 * approves) and focus starts on the dialog, not on a button, and stays inside.
 */
export default function HostMcpApprovalDialog(props: HostMcpApprovalDialogProps) {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (props.approvals.approvals().length === 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    onCleanup(() => clearInterval(timer));
  });
  const live = createMemo(() => liveHostApprovals(props.approvals.approvals(), now()));
  const shownId = createMemo(() => live()[0]?.approval_id ?? null);

  const [armed, setArmed] = createSignal(false);
  const [stopping, setStopping] = createSignal(false);
  let dialog: HTMLDivElement | undefined;
  let pressedId: string | null = null;

  createEffect(
    on(shownId, (id) => {
      setArmed(false);
      if (id === null) return;
      const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS);
      onCleanup(() => clearTimeout(timer));
    }),
  );

  // Focus goes to the dialog itself, never to a button, so a Space or Enter meant for the page answers
  // nothing. It comes back whenever it left the dialog (a button disabled under it while a decision
  // was in flight, a failed decision), so Escape and Tab keep working, and returns to where it was
  // when the last approval goes.
  let focusBefore: HTMLElement | null = null;
  const restoreFocus = () => {
    const previous = focusBefore;
    focusBefore = null;
    if (previous?.isConnected) previous.focus();
  };
  createEffect(() => {
    const id = shownId();
    props.approvals.decidingId();
    props.approvals.decisionError();
    stopping();
    if (id === null) {
      restoreFocus();
      return;
    }
    if (!dialog || dialog.contains(document.activeElement)) return;
    if (focusBefore === null && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      focusBefore = document.activeElement;
    }
    dialog.focus();
  });
  onCleanup(restoreFocus);

  const answer = (decision: HostMcpApprovalDecision, grantScope?: HostMcpGrantScope) => {
    const current = shownId();
    const id = pressedId ?? current;
    pressedId = null;
    // A press that began on another approval than the one now shown answers nothing, and nothing is
    // answered while Stop all runs: it denies them all.
    if (id === null || id !== current || stopping()) return;
    if (decision === "approve" && !armed()) return;
    void props.approvals.decide(id, decision, grantScope);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (props.approvals.decidingId() === null && !stopping()) answer("deny");
      return;
    }
    if (event.key !== "Tab" || !dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled])"));
    event.preventDefault();
    if (focusable.length === 0) return;
    const at = focusable.indexOf(document.activeElement as HTMLElement);
    const step = event.shiftKey ? -1 : 1;
    const next = at < 0 ? (step > 0 ? 0 : focusable.length - 1) : (at + step + focusable.length) % focusable.length;
    focusable[next]?.focus();
  };

  const browserTitle = (origin: string) => {
    const [before = "", after = ""] = t("mcp.host.approval.browser_title").split("{origin}");
    return (
      <>
        {before}
        <span data-testid="host-mcp-approval-origin" class="font-mono break-all">
          {origin}
        </span>
        {after}
      </>
    );
  };

  return (
    <Show when={live()[0]}>
      {(approval) => (
        <div class="fixed inset-0 z-[70] dls-modal-backdrop flex items-center justify-center p-4 font-sans">
          <div
            ref={dialog}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="host-mcp-approval-title"
            tabindex="-1"
            data-testid="host-mcp-approval-dialog"
            class="w-full max-w-lg overflow-hidden border dls-modal-surface"
            onKeyDown={onKeyDown}
          >
            <div class="p-6">
              <div class="flex items-start gap-4">
                <div class="shrink-0 w-10 h-10 rounded-pill flex items-center justify-center bg-dls-warning-bg text-dls-warning-text">
                  <Show when={approval().kind === "browser_origin"} fallback={<Monitor size={20} />}>
                    <Globe size={20} />
                  </Show>
                </div>
                <div class="min-w-0 flex-1">
                  <Show when={asBrowserOrigin(approval())}>
                    {(browser) => (
                      <h3 id="host-mcp-approval-title" class="text-body-lg font-semibold text-dls-text">
                        {browserTitle(browser().origin)}
                      </h3>
                    )}
                  </Show>
                  <Show when={asToolCall(approval())}>
                    {(call) => (
                      <>
                        <h3 id="host-mcp-approval-title" class="text-body-lg font-semibold text-dls-text">
                          {t("mcp.host.approval.tool_title")}
                        </h3>
                        <p class="mt-2 text-body-lg text-dls-secondary">{t("mcp.host.approval.tool_subtitle")}</p>
                        <dl class="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-caption">
                          <dt class="text-dls-secondary">{t("mcp.host.approval.server")}</dt>
                          <dd data-testid="host-mcp-approval-server" class="font-mono text-dls-text break-all">
                            {call().server}
                          </dd>
                          <dt class="text-dls-secondary">{t("mcp.host.approval.tool")}</dt>
                          <dd data-testid="host-mcp-approval-tool" class="text-dls-text break-all">
                            <Show when={distinctTitle(call())}>
                              {(title) => <>{title()} </>}
                            </Show>
                            <span class="font-mono">{call().tool}</span>
                          </dd>
                          <Show when={standingGrantsLine(props.approvals.alwaysGranted(call().server), call().tool)}>
                            {(line) => (
                              <dd
                                data-testid="host-mcp-approval-standing-grants"
                                class="col-start-2 text-dls-secondary break-words"
                              >
                                {standingGrantsText(call().server, line(), {
                                  line: t("mcp.host.approval.always_granted"),
                                  more: t("mcp.host.approval.always_granted_more"),
                                  separator: t("mcp.host.approval.list_separator"),
                                })}
                              </dd>
                            )}
                          </Show>
                          <dt class="text-dls-secondary">{t("mcp.host.approval.effect")}</dt>
                          <dd>
                            <Show
                              when={hostMcpToolIsReadOnly(call().annotations)}
                              fallback={
                                <span
                                  data-testid="host-mcp-approval-may-change"
                                  class="rounded-pill bg-dls-warning-bg px-2 py-0.5 text-tiny font-medium text-dls-warning-text"
                                >
                                  {t("mcp.host.approval.may_change")}
                                </span>
                              }
                            >
                              <span
                                data-testid="host-mcp-approval-read-only"
                                class="rounded-pill bg-dls-success-bg px-2 py-0.5 text-tiny font-medium text-dls-success-text"
                              >
                                {t("mcp.host.approval.read_only")}
                              </span>
                            </Show>
                          </dd>
                        </dl>
                        <div class="mt-4 text-caption font-medium text-dls-secondary">
                          {t("mcp.host.approval.arguments")}
                        </div>
                        <div
                          data-testid="host-mcp-approval-arguments"
                          class="mt-1 max-h-40 overflow-auto rounded-control border border-dls-panel-input-border bg-dls-panel-input-bg px-3 py-2 font-mono text-caption text-dls-text break-all whitespace-pre-wrap"
                        >
                          {call().arguments_preview ?? t("mcp.host.approval.no_arguments")}
                        </div>
                      </>
                    )}
                  </Show>
                  <p data-testid="host-mcp-approval-countdown" class="mt-3 text-caption text-dls-secondary">
                    {t("mcp.host.approval.expires_in").replace(
                      "{time}",
                      formatTimeLeft(secondsLeft(approval(), now()), t("mcp.host.approval.seconds")),
                    )}
                  </p>
                  <Show when={live().length > 1}>
                    <p class="mt-1 text-caption text-dls-secondary">
                      {t("mcp.host.approval.waiting").replace("{count}", String(live().length))}
                    </p>
                  </Show>
                  <Show
                    when={
                      props.approvals.decisionError()?.approvalId === approval().approval_id
                        ? props.approvals.decisionError()
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
                <Show when={props.stopAll}>
                  {(stopAll) => (
                    <Button
                      variant="ghost"
                      class="mr-auto text-dls-danger-text hover:text-dls-danger-text"
                      data-testid="host-mcp-approval-stop-all-btn"
                      disabled={props.approvals.decidingId() !== null || stopping()}
                      onClick={() => {
                        setStopping(true);
                        void stopAll()().finally(() => setStopping(false));
                      }}
                    >
                      {t("mcp.host.banner.stop_all")}
                    </Button>
                  )}
                </Show>
                <For each={hostApprovalChoices(approval())}>
                  {(choice) => (
                    <Button
                      variant={choice.decision === "deny" ? "outline" : undefined}
                      data-testid={choice.testId}
                      disabled={
                        props.approvals.decidingId() !== null
                        || stopping()
                        || (choice.decision === "approve" && !armed())
                      }
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
  );
}
