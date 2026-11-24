/**
 * Port-conflict dialog — the app's first-and-only screen when a port SuperClaw
 * hard-depends on is already taken.
 *
 * Exit is the only action: the conflicting process lives outside the app, so
 * there is nothing SuperClaw can retry or work around. The user has to free the
 * port and relaunch.
 *
 * Every conflicting port is listed (not just the first) so the user can free
 * them all in one pass, along with the holding process when it could be
 * resolved. Visual structure mirrors `hardware-requirements-dialog.tsx` so the
 * two startup blockers look like siblings.
 *
 * Deliberately says nothing about *which* internal service wants each port:
 * backend service names are an implementation detail with no meaning to the
 * user, and the port number plus its current holder is all that is actionable.
 */
import { For, Show } from "solid-js";
import { t } from "../../i18n";
import type { PortConflict } from "../lib/port-preflight";
import Button from "./button";

export type PortConflictDialogProps = {
  open: boolean;
  conflicts: PortConflict[];
  /** Invoked when the exit button is clicked. */
  onExit: () => void;
};

/** "held by python.exe (PID 12345)", degrading as far as the data allows. */
function ownerHint(conflict: PortConflict): string | null {
  const { ownerName, ownerPid } = conflict;
  if (ownerName && ownerPid != null) {
    return t("capability.port_owner_name_pid")
      .replace("{name}", ownerName)
      .replace("{pid}", String(ownerPid));
  }
  if (ownerName) return t("capability.port_owner_name").replace("{name}", ownerName);
  if (ownerPid != null) return t("capability.port_owner_pid").replace("{pid}", String(ownerPid));
  return null;
}

export default function PortConflictDialog(props: PortConflictDialogProps) {
  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-[100000] flex items-center justify-center dls-modal-backdrop">
        <div class="w-[min(460px,92vw)] border p-5 space-y-3 dls-modal-surface">
          <div class="text-body-lg font-semibold text-dls-danger-text">
            {t("capability.port_conflict_title")}
          </div>
          <div class="text-caption text-dls-secondary leading-relaxed">
            {t("capability.port_conflict_body")}
          </div>
          <ul class="space-y-1.5">
            <For each={props.conflicts}>
              {(conflict) => (
                <li class="text-caption text-dls-text">
                  <span class="font-medium tabular-nums">{conflict.port}</span>
                  <Show when={ownerHint(conflict)}>
                    {(hint) => <span class="text-dls-secondary"> — {hint()}</span>}
                  </Show>
                </li>
              )}
            </For>
          </ul>
          <div class="text-caption text-dls-secondary leading-relaxed">
            {t("capability.port_conflict_hint")}
          </div>
          <div class="flex items-center justify-end gap-2 pt-1">
            <Button variant="secondary" class="text-caption h-8 py-0 px-4" onClick={props.onExit}>
              {t("capability.port_conflict_exit")}
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}
