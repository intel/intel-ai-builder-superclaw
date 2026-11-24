/**
 * Settings → Voice input → LLM clean-up.
 *
 * An optional second pass over a dictation: a model drops filler words, fixes
 * punctuation and repairs words the on-device recogniser got wrong. Three
 * choices serve it — the user's agent cloud model, the on-device model this
 * machine was set up with, or an OpenRouter model of their own.
 *
 * Its own file rather than another card inside `settings.voice-input-section.tsx`
 * for the reason the Dictionary card gives: that file is already 507 lines, this
 * card carries a switch, a radio group and three reason-bearing states, and both
 * files have to stay under the 800-line limit.
 *
 * Three rules are visible in the markup, and each of them is the answer to a way
 * this card could mislead:
 *
 *  * **The tradeoff is the first thing on the card.** A user who chose on-device
 *    recognition and then discovered their words going to a cloud model would be
 *    right to call that a betrayal. So the help text says what leaves the
 *    machine, what it costs in latency, and that it is off by default — before
 *    the switch, not under it. It also stops short of promising the cloud: one of
 *    the three modes keeps the text on the machine, and a blanket "this sends
 *    your text to a cloud model" would be false there.
 *  * **Disabled, never hidden.** "Clean-up is not wired on this install", "you
 *    have no OpenRouter key" and "you have no on-device model" all leave the
 *    control on screen with the reason next to it. Hiding a control makes a
 *    setting the user already chose look lost, and gives them nothing to act on.
 *    The on-device option goes one step further and stays *selectable* under its
 *    reason — see `localBlocked`.
 *  * **The second mode is not called a "preset".** It needs the user's own
 *    OpenRouter key — nothing in the product bundles a credential for it — and a
 *    word implying "ready to use" would be false on every install that has not
 *    added one.
 *
 * The card also carries {@link ReasoningHint}, the reminder shown when the
 * configured clean-up model cannot be told to stop reasoning.
 */
import { Sparkles, X } from "lucide-solid";
import { createEffect, Match, onMount, Show, Switch, type JSX } from "solid-js";

import type {
  DictationRefineMode,
  ReasoningHintAction,
  VoiceInputController,
} from "~/features/voice-input";

import { t } from "../../i18n";
import ModelCombobox from "../components/model-combobox";
import ToggleSwitch from "~/shared/ui/toggle-switch";

/** One mode as a radio-card, matching the engine chooser in the parent section. */
function ModeOption(props: {
  mode: DictationRefineMode;
  titleKey: string;
  /** Omitted when the title already says everything the option costs. */
  descKey?: string;
  selected: boolean;
  disabled: boolean;
  /** Rendered inside the card when the option cannot be chosen. */
  blockedReason?: string;
  onSelect: () => void;
  testId: string;
  /**
   * Controls that configure THIS option, rendered inside its box but outside the
   * `<label>`.
   *
   * BOTH HALVES OF THAT ARE REQUIRED. Inside the box, because a model picker
   * floating at card level — directly under a heading reading "Which model cleans
   * it up" — reads as configuring the user's agents, which is the one misreading
   * this card spends most of its copy preventing. Outside the `<label>`, because
   * a `<label>` forwards every click inside it to its control: a combobox nested
   * in one would re-select the radio on every keystroke-adjacent click and on
   * every option row pressed in its popover.
   */
  children?: JSX.Element;
}) {
  return (
    <div
      class={`rounded-inset border ${
        props.selected && !props.disabled
          ? "border-[rgb(var(--dls-accent-rgb)/0.5)] bg-[rgb(var(--dls-accent-rgb)/0.06)]"
          : "border-dls-panel-border bg-dls-surface-raised"
      } ${props.disabled ? "opacity-60" : ""}`}
    >
      <label class={`flex items-start gap-3 p-3 ${props.disabled ? "" : "cursor-pointer"}`}>
        <input
          type="radio"
          name="voice-refine-mode"
          class="mt-0.5"
          value={props.mode}
          checked={props.selected}
          disabled={props.disabled}
          onChange={props.onSelect}
          data-testid={props.testId}
        />
        <span class="min-w-0 flex-1">
          <span class="text-body-lg text-dls-text">{t(props.titleKey)}</span>
          <Show when={props.descKey}>
            {(key) => (
              <span class="mt-1 block text-caption text-dls-secondary leading-relaxed">{t(key())}</span>
            )}
          </Show>
          {/*
            The reason sits inside the card it explains. A reason in a shared box
            under the group would not say WHICH option it refers to, which is the
            only thing the user needs from it.
          */}
          <Show when={props.blockedReason}>
            {(reason) => (
              <span
                class="mt-1.5 block text-caption text-dls-warning-text"
                data-testid={`${props.testId}-blocked`}
              >
                {reason()}
              </span>
            )}
          </Show>
        </span>
      </label>
      {/* Left-padded to the radio's text column, so the control reads as part of
          the sentence above it rather than as a new field. */}
      <Show when={props.children}>
        <div class="px-3 pb-3 pl-9">{props.children}</div>
      </Show>
    </div>
  );
}

/**
 * The "this model cannot stop reasoning" reminder.
 *
 * A hint, not a dialog, and that distinction is the requirement rather than a
 * style choice: it is `role="status"`, it traps no focus, it blocks neither this
 * page nor the composer, and one click on the X retires it. It follows
 * `app/components/session/voice-hint-bubble.tsx` — same non-modal contract, same
 * persisted dismissal — but renders inline in the card instead of floating,
 * because the control it is talking about is the radio group three lines below
 * it. A bubble over the composer would describe a setting the user cannot see.
 *
 * It sits inside the card rather than in its own file for the reason the card
 * keeps `ModeOption` here: it is this card's state in this card's markup, and a
 * file for it would be a module with one consumer.
 */
function ReasoningHint(props: {
  /**
   * `switch` renders the button; `needs_key` and `pick_other` each render a
   * sentence and no button, for opposite reasons — see the action's own doc
   * comment in `dictation-reasoning-hint.ts`.
   */
  action: ReasoningHintAction;
  /** Model id, named in the copy so the user can check the claim. */
  modelId: string;
  onSwitch: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      class="rounded-inset border border-dls-warning-border bg-dls-warning-bg p-3 space-y-2"
      data-testid="voice-refine-reasoning-hint"
      // Not a dialog and not focus-trapping: this is advice about a cost, and it
      // must never be able to stop the user reaching the controls underneath it.
      role="status"
      aria-live="polite"
    >
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <div class="text-caption font-medium text-dls-warning-text">
            {t("voice.refine_reasoning_hint_title")}
          </div>
          <p class="mt-1 text-caption text-dls-warning-text/90 leading-relaxed">
            {/* `t()` does no interpolation, and the model id comes from the host
                rather than the locale file, so it is substituted at the call
                site. */}
            {t("voice.refine_reasoning_hint_body").replace("{model}", props.modelId)}
          </p>
        </div>
        <button
          type="button"
          class="shrink-0 rounded-compact p-0.5 text-dls-warning-text/80 hover:bg-dls-warning-bg hover:text-dls-warning-text"
          onClick={props.onDismiss}
          aria-label={t("voice.refine_reasoning_hint_dismiss")}
          data-testid="voice-refine-reasoning-hint-dismiss"
        >
          <X size={12} />
        </button>
      </div>
      <Switch>
        <Match when={props.action === "switch"}>
          {/* The scope disclaimer sits next to the button it is about, not in a
              help text elsewhere: the fear this answers — "will this repoint my
              agents?" — occurs at the moment of pressing. */}
          <p class="text-caption text-dls-warning-text/80 leading-relaxed">
            {t("voice.refine_reasoning_hint_scope")}
          </p>
          <div class="flex justify-end">
            <button
              type="button"
              class="rounded-subtle border border-dls-warning-border bg-dls-surface-solid px-2 py-1 text-label font-medium text-dls-warning-text hover:bg-dls-warning-bg"
              onClick={props.onSwitch}
              data-testid="voice-refine-reasoning-hint-switch"
            >
              {t("voice.refine_reasoning_hint_switch")}
            </button>
          </div>
        </Match>
        <Match when={props.action === "needs_key"}>
          {/* No button at all. Offering the switch without the key behind it
              would be a control that silently does nothing, which the user reads
              as the reminder being broken rather than as a missing credential —
              so the sentence names the credential instead. */}
          <p
            class="text-caption text-dls-warning-text/90 leading-relaxed"
            data-testid="voice-refine-reasoning-hint-needs-key"
          >
            {t("voice.refine_reasoning_hint_needs_key")}
          </p>
        </Match>
        <Match when={props.action === "pick_other"}>
          {/* No button either, for the opposite reason: this model is the user's
              own pick, made in the field a few lines above. Replacing an
              explicit choice on one click is the destructive surprise the scope
              line promises not to spring. */}
          <p
            class="text-caption text-dls-warning-text/90 leading-relaxed"
            data-testid="voice-refine-reasoning-hint-pick-other"
          >
            {t("voice.refine_reasoning_hint_pick_other")}
          </p>
        </Match>
      </Switch>
    </div>
  );
}

export default function VoiceRefineCard(props: { voice: VoiceInputController }) {
  const voice = props.voice;

  /**
   * Both of this card's probes ask about state the user changes on the Model
   * Routing page — the OpenRouter key and the agent's cloud model — and neither
   * page emits anything the hook could subscribe to. Re-asking on mount is what
   * makes "I just connected OpenRouter" visible here without an app restart;
   * without it the second option stayed disabled under a message telling the
   * user to do the thing they had just done.
   */
  onMount(() => voice.refreshRefineProbes());

  /**
   * Clean-up runs on `asr_manager`'s own route, so it is on-device-mode only —
   * the same predicate the Dictionary card uses, and for the same reason: in
   * cloud mode this card would be claiming an effect it cannot have.
   */
  const supported = () =>
    voice.mode() === "local" && voice.localAvailable() && voice.refineAvailable();

  /**
   * WHY `supported()` IS NOT ENOUGH TO EXPLAIN ITSELF. It is false for two
   * unrelated reasons, and one sentence covering both is false in one of them:
   *
   *  * the user picked the cloud speech engine above — nothing is missing, the
   *    clean-up pass just runs on `asr_manager`'s route and so has nothing to
   *    attach to. One click on the engine chooser fixes it, and the copy has to
   *    say that, because "not set up on this installation" reads as a broken
   *    install and gives the user nothing to do.
   *  * `asr_manager` is genuinely absent, or `/refine` answered that it is not
   *    configured — then the install really is the problem.
   *
   * Ordered engine-first because that is the cheaper and far more likely cause.
   */
  const unavailableReasonKey = () => {
    if (supported()) return undefined;
    if (voice.mode() !== "local") return "voice.refine_local_mode_only";
    return "voice.refine_unavailable";
  };

  /**
   * The OpenRouter option is blocked only once the probe has actually answered.
   * Blocking it while the answer is unknown would show a reason for a second on
   * every page open and then withdraw it, which reads as a bug.
   */
  const presetBlocked = () => voice.refineOpenRouterChecked() && !voice.refineOpenRouterReady();

  /**
   * The on-device option, on the same "only once the probe answered" rule.
   *
   * It is a REASON, not a disable. The option stays selectable: the mode is the
   * only one that keeps a dictation off the network, so a probe that is briefly
   * wrong — LLMRouter can report a null primary bundle during a startup or
   * model-switch window — must not be able to take the private choice away. A
   * user who picks it with no local model gets a legible failure and their raw
   * transcript, which is a better trade than a greyed-out control that tells
   * them to go and do something they may already have done.
   */
  const localBlocked = () => voice.refineLocalChecked() && !voice.refineLocalReady();

  /** The modes are meaningless until the feature is on; disabled, not hidden. */
  const modesEnabled = () => supported() && voice.refineEnabled();

  /**
   * The model picker is live only when the option it configures is the one in
   * force. Disabled rather than hidden, per the card's rule — but with no reason
   * line of its own: the radio sitting immediately above it IS the reason, and a
   * sentence repeating "this option is not selected" would be noise on a card
   * that already carries two explanations.
   */
  const modelPickerEnabled = () =>
    modesEnabled() && !presetBlocked() && voice.refineMode() === "preset";

  /**
   * Fetch the OpenRouter catalog only once the picker can actually be used.
   *
   * ~389 models come back on a live key. Asking for them on every Settings open
   * — including the overwhelming majority where clean-up is off, or the agent
   * model is the chosen one — would be a round trip spent on a list nobody is
   * about to read.
   */
  createEffect(() => {
    if (modelPickerEnabled()) voice.ensureRefineModels();
  });

  /**
   * The reasoning reminder's decision, or `undefined` for "show nothing" — one
   * accessor so the markup has a single truthy test instead of unwrapping a
   * discriminated union inside JSX.
   *
   * `supported()` is re-checked on top of the hint's own gate. The probe behind
   * it runs whether or not this card can act on the answer, and a warning about
   * the clean-up model on an install where clean-up cannot run at all would be
   * advice about nothing.
   */
  const reasoningHint = (): { action: ReasoningHintAction; modelId: string } | undefined => {
    if (!supported()) return undefined;
    const hint = voice.refineReasoningHint();
    return hint.show ? { action: hint.action, modelId: hint.modelId } : undefined;
  };

  return (
    <div
      class="bg-dls-panel-bg border border-dls-panel-border rounded-card p-5 space-y-3"
      data-testid="voice-refine-card"
      data-settings-anchor="voice_refine"
    >
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <Sparkles size={16} class="text-dls-secondary" />
          <div class="text-body-lg font-medium text-dls-text">{t("voice.refine_heading")}</div>
        </div>
        <ToggleSwitch
          checked={voice.refineEnabled()}
          disabled={!supported()}
          onChange={(next) => voice.setRefineEnabled(next)}
          aria-label={t("voice.refine_toggle_label")}
          data-testid="voice-refine-toggle"
        />
      </div>

      {/* Directly under the heading and above every control, so the sentence that
          decides whether turning this on is the right call is read before the
          modes are. The switch itself sits in the header row — the house pattern
          for this settings page — so it is reachable before this text; that is
          deliberate for a returning user who only wants to flip it back off. */}
      <p class="text-caption text-dls-secondary leading-relaxed">{t("voice.refine_desc")}</p>

      <Show when={unavailableReasonKey()}>
        {(key) => (
          <div
            class="rounded-inset border border-dls-panel-border bg-dls-surface-tint p-3 text-caption text-dls-secondary"
            data-testid="voice-refine-unavailable"
          >
            {t(key())}
          </div>
        )}
      </Show>

      <div class="space-y-2 border-t border-dls-panel-border pt-3">
        <div class="text-caption font-medium text-dls-text">{t("voice.refine_mode_heading")}</div>
        <ModeOption
          mode="agent"
          titleKey="voice.refine_mode_agent_title"
          selected={voice.refineMode() === "agent"}
          disabled={!modesEnabled()}
          onSelect={() => voice.setRefineMode("agent")}
          testId="voice-refine-mode-agent"
        />
        {/*
          SECOND, not first, and the order is the argument. The group reads
          top-to-bottom as "how much setup does this need": `agent` is the
          default and reuses what the user already configured for their agents;
          `local` needs a committed on-device model but no credential and no
          money; `preset` needs the user's own OpenRouter key. Putting `local`
          first would read as a recommendation the default does not back up, and
          a radio group whose default is not its first row makes "what happens if
          I just flip the switch" harder to answer than it needs to be.

          Unlike the other two it carries NO model picker. There is nothing to
          pick: the hardware→bundle→Binding chain owns which local model exists
          (AGENTS.md §5c), and offering a chooser here would imply this card can
          override a decision it must not even read.
        */}
        <ModeOption
          mode="local"
          titleKey="voice.refine_mode_local_title"
          descKey="voice.refine_mode_local_desc"
          selected={voice.refineMode() === "local"}
          // Disabled only by the toggle, never by its own probe — see
          // `localBlocked`. The reason shows; the choice stays.
          disabled={!modesEnabled()}
          blockedReason={localBlocked() ? t("voice.refine_mode_local_blocked") : undefined}
          onSelect={() => voice.setRefineMode("local")}
          testId="voice-refine-mode-local"
        />
        <ModeOption
          mode="preset"
          titleKey="voice.refine_mode_preset_title"
          selected={voice.refineMode() === "preset"}
          // Blocked for a reason of its own, on top of the toggle being off.
          disabled={!modesEnabled() || presetBlocked()}
          blockedReason={presetBlocked() ? t("voice.refine_mode_preset_blocked") : undefined}
          onSelect={() => voice.setRefineMode("preset")}
          testId="voice-refine-mode-preset"
        >
          {/* The SAME control as the Model Routing page's model field — the user
              asked for that one by name, and 389 models is not a dropdown. */}
          <div class="space-y-1.5">
            <div class="flex items-center gap-1.5">
              <label class="block text-caption font-medium text-dls-text">
                {t("voice.refine_model_label")}
              </label>
              {/* "Default", not "Recommended": it states how the product is set up and
                  claims nothing about the vendor. The speed-tuning claim stays in the
                  measured-scope note below the picker. Keyed on the host's own default, so
                  it follows the service if that ever changes. */}
              <Show
                when={
                  voice.refineDefaultModel() !== "" &&
                  voice.refineModel() === voice.refineDefaultModel()
                }
              >
                <span
                  class="rounded-pill border border-dls-panel-border bg-dls-surface-tint px-1.5 py-px text-tiny font-medium text-dls-secondary"
                  data-testid="voice-refine-model-default"
                >
                  {t("voice.refine_model_default_badge")}
                </span>
              </Show>
            </div>
            <ModelCombobox
              testIdPrefix="voice-refine-model"
              aria-label={t("voice.refine_model_label")}
              options={voice.refineModelOptions()}
              value={voice.refineModel()}
              placeholder={t("voice.refine_model_placeholder")}
              disabled={!modelPickerEnabled()}
              onChange={(modelId) => voice.setRefineModel(modelId)}
              status={
                <>
                  <Show when={voice.refineModelsLoading()}>
                    <div
                      class="mt-1 text-label text-dls-secondary"
                      data-testid="voice-refine-model-loading"
                    >
                      {t("voice.refine_model_loading")}
                    </div>
                  </Show>
                  {/* A failed catalog is not a failed feature: the chosen model
                      is still sent on every dictation. The copy says so, and
                      deliberately promises no typed-id escape hatch, because the
                      combobox only commits a model from the list. */}
                  <Show when={voice.refineModelsFailed()}>
                    <div
                      class="mt-1 text-label text-dls-warning-text"
                      data-testid="voice-refine-model-failed"
                    >
                      {t("voice.refine_model_failed")}
                    </div>
                  </Show>
                  <Show
                    when={
                      modelPickerEnabled() &&
                      !voice.refineModelsLoading() &&
                      !voice.refineModelsFailed() &&
                      voice.refineModelOptions().length === 0
                    }
                  >
                    <div class="mt-1 text-label text-dls-secondary">
                      {t("voice.refine_model_empty")}
                    </div>
                  </Show>
                </>
              }
            />
            <p class="text-label text-dls-secondary leading-relaxed">
              {t("voice.refine_model_note")}
            </p>
          </div>
        </ModeOption>
      </div>

      {/*
        Below the radio group, not above it: its one action moves the radio that
        is now visible directly above, so the user can see what the button did
        instead of taking the card's word for it.

        `supported()` is re-checked here on top of the hint's own gate. The probe
        behind it runs whether or not this card can act on the answer, and a
        warning about a clean-up model on an install where clean-up cannot run at
        all would be advice about nothing.
      */}
      <Show when={reasoningHint()}>
        {(hint) => (
          <ReasoningHint
            action={hint().action}
            // From the DECISION, not from a probe: in `preset` mode the warning
            // is about the model the user picked, and naming the agent model
            // there would be a warning about a model nobody is using.
            modelId={hint().modelId}
            onSwitch={() => {
              // Retire the reminder FIRST, while the decision it was keyed on is
              // still the one on screen. After the switch the subject model has
              // changed, so a dismissal recorded then would be filed against the
              // wrong id and this reminder would come back.
              voice.dismissRefineReasoningHint();
              // Only the dictation clean-up mode and model. The user's agent
              // cloud model is deliberately left alone — repointing it from a
              // dictation setting would be a destructive surprise, and the copy
              // promises we do not.
              voice.useRecommendedRefineModel();
            }}
            onDismiss={() => voice.dismissRefineReasoningHint()}
          />
        )}
      </Show>

      {/* The promise that makes the feature safe to try, stated on the card and
          not only in a toast the user sees after it has already happened. */}
      <p class="text-caption text-dls-secondary leading-relaxed" data-testid="voice-refine-failure-note">
        {t("voice.refine_failure_note")}
      </p>
    </div>
  );
}
