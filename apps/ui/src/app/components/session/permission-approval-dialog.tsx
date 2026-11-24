import { createEffect, createMemo, createUniqueId, For, on, onCleanup, Show } from "solid-js";
import { Shield } from "lucide-solid";

import type { PendingPermission } from "~/shared/types/session";
import Button from "../button";
import { t } from "../../../i18n";
import {
  permissionChoices,
  permissionCopy,
  type PermissionChoice,
  type PermissionReply,
} from "./permission-approval";

export type PermissionApprovalDialogProps = {
  permission: PendingPermission;
  busy: boolean;
  respond: (requestID: string, reply: PermissionReply) => void;
  respondAndRemember: (requestID: string, reply: PermissionReply) => void;
  safeStringify: (value: unknown) => string;
};

const FOCUSABLE = "summary, button:not([disabled])";

/**
 * Asks about an engine permission request (OpenCode `permission.asked`). Choices are named by what
 * they do, and the raw request sits behind Technical details.
 *
 * Focus goes to the dialog itself, never to a button, so a key press meant for the composer answers
 * nothing; it stays inside until the dialog closes and then returns to where it was. Keys pressed
 * inside do not reach the page's shortcuts. Escape is not bound: for file protection the reject
 * reply reads the file without masking.
 */
export default function PermissionApprovalDialog(props: PermissionApprovalDialogProps) {
  const titleId = createUniqueId();
  const summaryId = createUniqueId();
  let dialog: HTMLDivElement | undefined;

  const focusBefore = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement
    : null;
  onCleanup(() => {
    if (focusBefore?.isConnected) focusBefore.focus();
  });
  // A reply disables the buttons, and a disabled button that had focus drops it to the page, so a
  // reply in flight moves focus to the dialog first.
  createEffect(
    on([() => props.permission.id, () => props.busy], ([, busy]) => {
      if (!dialog || (!busy && dialog.contains(document.activeElement))) return;
      dialog.focus();
    }),
  );

  const choices = createMemo(() => permissionChoices(props.permission.permission));
  const copy = createMemo(() => permissionCopy(props.permission));
  const summary = () => {
    const [before = "", after = ""] = t(copy().summaryKey).split("{target}");
    return (
      <>
        {before}
        <Show when={copy().target}>
          <span class="font-medium text-dls-text break-all">{copy().target}</span>
        </Show>
        {after}
      </>
    );
  };

  const onKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key !== "Tab" || !dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    event.preventDefault();
    if (focusable.length === 0) return;
    const at = focusable.findIndex((element) => element === document.activeElement);
    const step = event.shiftKey ? -1 : 1;
    const next = at < 0 ? (step > 0 ? 0 : focusable.length - 1) : (at + step + focusable.length) % focusable.length;
    focusable[next]?.focus();
  };

  const choose = (reply: PermissionReply) =>
    reply === "always"
      ? props.respondAndRemember(props.permission.id, reply)
      : props.respond(props.permission.id, reply);
  const choiceButton = (choice: PermissionChoice) => (
    <Button
      variant={choice.variant}
      data-testid={choice.testId}
      onClick={() => choose(choice.reply)}
      disabled={props.busy}
    >
      {t(choice.labelKey)}
    </Button>
  );

  // Above the Settings dialog (z-50), which may be open when a request arrives: this takes focus.
  return (
    <div class="absolute inset-0 z-[60] dls-modal-backdrop flex items-center justify-center p-4 font-sans">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={summaryId}
        tabindex="-1"
        data-testid="permission-dialog"
        class="border w-full max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto dls-modal-surface"
        onKeyDown={onKeyDown}
      >
        <div class="p-6">
          <div class="flex items-start gap-4">
            <div class="shrink-0 w-10 h-10 rounded-pill flex items-center justify-center bg-dls-warning-bg text-dls-warning-text">
              <Shield size={20} />
            </div>
            <div class="min-w-0">
              <h3 id={titleId} class="text-title leading-title font-semibold text-dls-text">
                {t(copy().titleKey)}
              </h3>
              <p id={summaryId} data-testid="permission-summary" class="text-body-lg text-dls-secondary mt-1">
                {summary()}
              </p>
              <Show when={props.permission.permission === "confirm_file_protection"}>
                <p class="text-caption text-dls-warning-text mt-2">
                  {t("session.permission_protected_pipeline_info")}
                </p>
              </Show>
            </div>
          </div>

          <details
            data-testid="permission-technical-details"
            class="mt-4 mb-6 rounded-inset border border-dls-border bg-dls-surface-solid/50 p-3"
          >
            <summary class="cursor-pointer text-caption text-dls-secondary">
              {t("session.permission_technical_details")}
            </summary>
            <div class="text-caption text-dls-secondary uppercase tracking-wider mt-3 mb-1 font-semibold">
              {t("session.permission_label_uppercase")}
            </div>
            <div class="text-body-lg text-dls-text font-mono">{props.permission.permission}</div>
            <div class="text-caption text-dls-secondary uppercase tracking-wider mt-3 mb-1 font-semibold">
              {t("session.scope_label_uppercase")}
            </div>
            <div class="max-h-64 overflow-y-auto break-words whitespace-pre-wrap text-body-lg font-mono text-dls-text">
              {props.permission.patterns.join(", ")}
            </div>
            <Show when={Object.keys(props.permission.metadata ?? {}).length > 0}>
              <div class="text-caption text-dls-secondary uppercase tracking-wider mt-3 mb-1 font-semibold">
                {t("session.details_label")}
              </div>
              <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words text-caption text-dls-text">
                {props.safeStringify(props.permission.metadata)}
              </pre>
            </Show>
          </details>

          <div class="flex items-center justify-between gap-2">
            <For each={choices().slice(0, 1)}>{choiceButton}</For>
            <div class="flex items-center gap-2">
              <For each={choices().slice(1)}>{choiceButton}</For>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
