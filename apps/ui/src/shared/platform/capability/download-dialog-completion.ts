/**
 * When the first-launch download dialog should close.
 *
 * Split out of `capability-startup-resolver.tsx` so the rule is testable without
 * importing that module's Solid component tree (which pulls in client-only icon
 * modules and cannot be loaded in a plain test environment).
 */

/** Dialog phases that matter to the completion rule. */
export type DownloadDialogPhase = "consent" | "downloading" | "ready";

export type DialogCompletionAction = "keep-open" | "enter-ready" | "already-ready";

/**
 * Decide what the dialog should do next, given its phase and whether every
 * asset has settled.
 *
 * The regression this guards: closing the dialog the instant the last asset
 * flips to `complete` hides the finished state entirely. Assets settle in size
 * order and a 506 MB embedding verifies ~30x faster than a 20 GB chat model, so
 * its "ready" tick and the close can land inside the same 1 s poll tick —
 * observed as the embedding row flashing by with no visible ready state. That is
 * invisible to a type check and easy to reintroduce by "simplifying" the branch
 * back to an immediate close, hence a named rule with tests.
 */
export function resolveDialogCompletion(
  phase: DownloadDialogPhase,
  assets: readonly { complete: boolean }[],
): DialogCompletionAction {
  if (assets.length === 0 || !assets.every((a) => a.complete)) return "keep-open";
  // Already holding the finished state: the dwell timer owns the close, so a
  // later poll tick must not queue a second one.
  return phase === "ready" ? "already-ready" : "enter-ready";
}
