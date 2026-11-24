/**
 * What notice the model-change dialog should show below its checklist.
 *
 * Split out of `restart-required-dialog.tsx` so the rule is testable without
 * importing that module's Solid component tree (which pulls in client-only icon
 * modules and cannot be loaded in a plain test environment). Same reason as
 * `edge-server-card-url.ts` and `capability/download-dialog-completion.ts`.
 */

/** Only the field of `BundleSwitchStep` this rule reads. */
export type NoticeStep = { state: string };

export type RestartDialogNotice =
  | { kind: "none" }
  | { kind: "error"; text: string }
  | { kind: "progress"; text: string };

/**
 * Decide the single notice line, given the checklist and the switch's progress.
 *
 * The regression this guards (#1682): the error line used to be gated on
 * `progressError && !hasSteps()`, i.e. suppressed whenever the checklist had ANY
 * rows. The checklist only covers the LRM *prepare* probes (discover / chat /
 * embedding), so a failure in a later stage -- commit, snapshot, activate,
 * runtime-apply -- has no row of its own AND lost the global line. The reported
 * result was a dialog showing three green ticks, an enabled Apply button, and
 * no indication whatsoever that the switch had stranded: users
 * reported it as "clicked restart, nothing happened".
 *
 * The de-duplication the gate was reaching for is real -- when a probe row
 * already renders its own error, repeating it globally is noise -- so the
 * condition becomes "no step already explains it" rather than "no steps at all".
 * A failure attributable to a step stays on that step; anything else is stated
 * plainly instead of being swallowed.
 */
export function resolveRestartDialogNotice(input: {
  steps?: readonly NoticeStep[] | null;
  progressError?: string | null;
  progressMessage?: string | null;
}): RestartDialogNotice {
  const { steps, progressError, progressMessage } = input;
  if (progressError) {
    const explainedByStep = (steps ?? []).some((step) => step.state === "error");
    return explainedByStep ? { kind: "none" } : { kind: "error", text: progressError };
  }
  if (progressMessage) return { kind: "progress", text: progressMessage };
  return { kind: "none" };
}
