/**
 * Whether to warn that the model cleaning up dictations cannot stop reasoning,
 * and what to offer about it.
 *
 * ## Why a warning exists at all
 *
 * Clean-up is a transform: the answer is a tidied copy of the input, so
 * chain-of-thought buys nothing. A model that reasons anyway spends 3-5x the
 * completion tokens on text the user never sees, bills for every one of them,
 * and adds a whole reasoning pass to the latency of EVERY dictation. Gemini is
 * the named case — it accepts the off switch, ignores it, and does not error, so
 * there is no signal at request time that reasoning is still on. Nothing
 * downstream can detect this; it has to be said up front or not at all.
 *
 * ## It is asked about whichever model is actually serving clean-up
 *
 * Once the user can PICK the OpenRouter model, the rule stops being about the
 * agent model: a chosen model that reasons costs exactly as much as an agent
 * model that reasons. So the gate selects its subject from `modeInUse` — the
 * agent model in `agent` mode, the chosen model in `preset` mode — and
 * everything downstream (the copy, the dismissal key) follows that one choice.
 * That is why {@link ReasoningHintDecision} carries the model id: the card must
 * name the model the verdict is about, not whichever one it happened to probe.
 *
 * ## `local` mode has no subject, so it has nothing to warn about
 *
 * The warning is only ever actionable against a model someone chose. In `local`
 * mode nobody chose one — the hardware→bundle chain did (AGENTS.md §5c) — and
 * the reasoning off switch is already applied to it by the process that serves
 * it: `llmrouter_manager/local/supervisor.py` launches llama-server with
 * `--reasoning off --reasoning-budget 0` and
 * `--chat-template-kwargs {"enable_thinking":false}`. So there is no cloud bill
 * to warn about, no model id the user could change, and no off switch left to
 * ask for. Both of this file's probes describe CLOUD models, so without an
 * explicit gate the `preset` branch below would fire in `local` mode and warn
 * about the user's OpenRouter pick while no OpenRouter model is being used at
 * all.
 *
 * ## Why this is a pure function in its own file
 *
 * Eight inputs, four of them asynchronous, and a user-visible "cry wolf" failure
 * mode on each. Reactive code cannot be exercised under `bun test` — SolidJS
 * effects are inert in the build that lane resolves — so the decision lives here
 * and `use-dictation-refine.ts` only supplies the signals. The rendering is
 * covered from the vitest lane in
 * `app/pages/settings.voice-refine-card.vitest.tsx`.
 */
import type { AsrReasoningSupport } from "./asr-client";
import type { DictationRefineMode } from "./voice-input-prefs";

export type ReasoningHintInput = {
  /** The clean-up preference. Off means there is nothing to warn about. */
  cleanupEnabled: boolean;
  /**
   * The mode a dictation is actually sent with — `refineModeInUse`, not the
   * stored preference. A stored `preset` with no OpenRouter key falls back to
   * `agent`, and that fallback is exactly the case the warning is about.
   */
  modeInUse: DictationRefineMode;
  /**
   * The host's verdict on the AGENT model, or `null` while the probe has not
   * answered. `null` is kept distinct from `"unknown"`: one is "we have not
   * asked", the other is "we asked and nobody has characterised this model".
   */
  reasoningSupport: AsrReasoningSupport | null;
  /** The agent model's id, as the host echoed it back. `""` if unknown. */
  currentModelId: string;
  /** The host's verdict on the model CHOSEN for `preset` mode. Same `null` rule. */
  presetReasoningSupport: AsrReasoningSupport | null;
  /** The chosen `preset` model's id, as the host echoed it back. `""` if unknown. */
  presetModelId: string;
  /** Whether `preset` mode can run at all (the user's own OpenRouter key). */
  presetAvailable: boolean;
  /** The model id a previous dismissal was recorded against; `""` if never dismissed. */
  dismissedModelId: string;
};

/**
 * `switch` — offer the one-click move to the dictation default. Only in `agent`
 * mode: there is nothing of the user's own to overwrite.
 * `needs_key` — say what is wrong, offer no button. The switch would be a
 * control that silently does nothing, which is worse than no control: the user
 * presses it, nothing visible changes, and they conclude the warning is broken.
 * `pick_other` — the user chose this model themselves and the picker is on the
 * same card. Point at it rather than offering a button: one click that silently
 * replaces an explicit choice is the destructive surprise this card's copy
 * promises not to spring, and it would also be a no-op in the one case where the
 * chosen model already IS the default.
 */
export type ReasoningHintAction = "switch" | "needs_key" | "pick_other";

export type ReasoningHintDecision =
  | { show: false }
  | {
      show: true;
      action: ReasoningHintAction;
      /**
       * The model the warning is about — the agent model or the chosen one,
       * depending on the mode. Also the id a dismissal must be recorded against,
       * so the card never keys "I know" on a model it did not name.
       */
      modelId: string;
    };

const HIDDEN: ReasoningHintDecision = { show: false };

/**
 * The gate is deliberately narrow. Each `return HIDDEN` below is a case where
 * showing the hint would be worse than silence.
 */
export function decideReasoningHint(input: ReasoningHintInput): ReasoningHintDecision {
  // Nothing is being cleaned up, so no tokens are being spent on reasoning.
  if (!input.cleanupEnabled) return HIDDEN;

  // The on-device model already runs with reasoning off, and neither probe below
  // is about it. Gated BEFORE the subject is selected, because the `preset`
  // branch is the else-branch of `agentMode` and would otherwise claim this mode
  // and warn about the user's OpenRouter pick. See the module docstring.
  if (input.modeInUse === "local") return HIDDEN;

  // Whichever model is actually going to answer. In `preset` mode that is the
  // user's pick, which they can now set to anything in the catalog — including
  // a Gemini, which is the named case this whole warning exists for.
  const agentMode = input.modeInUse === "agent";
  const support = agentMode ? input.reasoningSupport : input.presetReasoningSupport;
  const modelId = agentMode ? input.currentModelId : input.presetModelId;

  // `"yes"` is the happy path and `"unknown"` is an absence of evidence, not
  // evidence of a problem: warning on an uncharacterised model would cry wolf on
  // every model the host's table has not been taught yet, and the user has no
  // way to tell that from a real finding. `null` is the pre-probe state and must
  // render nothing, or the card would flash a warning on open and withdraw it.
  if (support !== "no") return HIDDEN;

  // Without an id there is nothing to key the dismissal on, so showing the hint
  // would mean a dismissal that cannot be remembered — a warning that reappears
  // forever. The host always echoes the id back, so this is defence in depth.
  if (!modelId) return HIDDEN;

  // Dismissal is per-model, so this suppresses the warning for the model the
  // user acknowledged and for no other. A different reasoning model later is a
  // different, un-acknowledged fact.
  if (input.dismissedModelId === modelId) return HIDDEN;

  if (!agentMode) return { show: true, action: "pick_other", modelId };
  return {
    show: true,
    action: input.presetAvailable ? "switch" : "needs_key",
    modelId,
  };
}
