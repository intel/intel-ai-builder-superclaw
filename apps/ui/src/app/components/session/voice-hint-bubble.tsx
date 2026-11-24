/**
 * Small non-blocking bubbles anchored above the composer's microphone button.
 *
 *  * {@link VoiceHintBubble} — shown the first time a recording actually starts.
 *    The plan is explicit that first use must NOT be interrupted by a modal
 *    tutorial: the user already found the microphone and pressed it, so
 *    recording begins normally and this bubble just mentions the shortcut and
 *    the cloud/on-device choice. "Got it" retires it forever (localStorage,
 *    exactly like `UI_TOUR_PREF_KEY`).
 *  * {@link VoiceFailureBubble} — a local-mode failure. It always carries the
 *    explicit escape hatch instead of quietly re-routing audio to the cloud,
 *    because a user who picked on-device did so to keep their voice off the
 *    network.
 */
import { AlertTriangle, X } from "lucide-solid";
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";

import type { VoiceInputMode } from "~/features/voice-input";

import { t } from "../../../i18n";

/** Shared shell: the card, the tail, and the position above the button. */
function BubbleShell(props: {
  tone: "hint" | "error";
  testId: string;
  children: import("solid-js").JSX.Element;
}) {
  return (
    <div
      class={`absolute bottom-full right-0 z-50 mb-2 w-[min(320px,80vw)] rounded-inset border p-3 text-left shadow-[var(--dls-card-shadow)] ${
        props.tone === "error"
          ? "border-dls-danger-border-strong bg-dls-surface-solid"
          : "border-dls-border/70 bg-dls-surface-solid"
      }`}
      data-testid={props.testId}
      // Not a dialog and not focus-trapping: recording continues underneath and
      // the bubble must never steal the Enter key from the composer.
      role="status"
      aria-live="polite"
    >
      {props.children}
    </div>
  );
}

export function VoiceHintBubble(props: {
  /** Engine the current recording is using; decides the second sentence. */
  mode: VoiceInputMode;
  /** e.g. "Right Alt"; the first binding only, so the bubble stays one line. */
  hotkeyLabel: string;
  /** Opens Settings → Voice input. */
  onOpenSettings: () => void;
  /** "Got it" — never show this bubble again. */
  onDismiss: () => void;
  /** Close for now, keeping the one-time hint for next time. */
  onHide: () => void;
}) {
  const isLocal = () => props.mode === "local";
  return (
    <BubbleShell tone="hint" testId="voice-hint-bubble">
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1 text-caption leading-relaxed text-dls-secondary">
          {/* Fragments + a real <kbd>: `t()` has no interpolation, and the
              shortcut is user-editable, so it cannot live inside the phrase. */}
          {t("composer.voice_hint_press")}{" "}
          <kbd class="rounded-compact border border-dls-border/70 bg-dls-hover/60 px-1 py-px font-mono text-tiny text-dls-text">
            {props.hotkeyLabel}
          </kbd>{" "}
          {isLocal() ? t("composer.voice_hint_local_mid") : t("composer.voice_hint_cloud_mid")}{" "}
          <button
            type="button"
            class="underline decoration-dotted underline-offset-2 hover:text-dls-text"
            onClick={props.onOpenSettings}
          >
            {t("composer.voice_hint_settings_link")}
          </button>
          {isLocal()
            ? t("composer.voice_hint_local_after")
            : t("composer.voice_hint_cloud_after")}
        </div>
        <button
          type="button"
          class="shrink-0 rounded-compact p-0.5 text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
          onClick={props.onHide}
          aria-label={t("composer.voice_error_dismiss")}
        >
          <X size={12} />
        </button>
      </div>
      <div class="mt-2 flex justify-end">
        <button
          type="button"
          class="rounded-control border border-dls-border/70 px-2 py-1 text-label font-medium text-dls-text hover:bg-dls-hover"
          onClick={props.onDismiss}
          data-testid="voice-hint-got-it"
        >
          {t("composer.voice_hint_got_it")}
        </button>
      </div>
    </BubbleShell>
  );
}

/**
 * The "no microphone" sentence, anchored to the mic button.
 *
 * It shows when a press proves the microphone is missing, then leaves on
 * the same 2.4 s clock as the composer toast. `tick` moves on every such
 * press, including one that finds the microphone still missing, so the
 * note can appear again. `active` going false hides it at once.
 */
const MIC_MISSING_NOTE_MS = 2400;

export function VoiceMicMissingBubble(props: {
  message: string;
  tick: number;
  active: boolean;
}) {
  const [visible, setVisible] = createSignal(false);
  let timer: number | undefined;
  const clearTimer = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };

  createEffect(
    on(
      () => props.tick,
      (tick) => {
        if (tick === 0) return;
        setVisible(true);
        clearTimer();
        timer = window.setTimeout(() => setVisible(false), MIC_MISSING_NOTE_MS);
      },
    ),
  );
  createEffect(() => {
    if (props.active) return;
    clearTimer();
    setVisible(false);
  });
  onCleanup(clearTimer);

  return (
    <Show when={visible()}>
      <div
        data-testid="voice-mic-missing"
        role="status"
        class="pointer-events-none absolute bottom-full right-0 z-50 mb-2 w-max max-w-[240px] rounded-inset border border-dls-border bg-dls-surface-solid px-3 py-2 text-left text-caption text-dls-text shadow-lg"
      >
        {props.message}
      </div>
    </Show>
  );
}

export function VoiceFailureBubble(props: {
  /** Already-translated message. */
  message: string;
  /** Render "Use cloud instead". Some failures (audio too long) must not. */
  offerCloud: boolean;
  /** Render "Download again" for corrupt or unloadable weights. */
  offerRedownload: boolean;
  onUseCloud: () => void;
  onRedownload: () => void;
  onDismiss: () => void;
}) {
  return (
    <BubbleShell tone="error" testId="voice-failure-bubble">
      <div class="flex items-start gap-2">
        <AlertTriangle size={13} class="mt-0.5 shrink-0 text-dls-danger-text" />
        <div class="min-w-0 flex-1 text-caption leading-relaxed text-dls-danger-text">{props.message}</div>
        <button
          type="button"
          class="shrink-0 rounded-compact p-0.5 text-dls-danger-text/80 hover:bg-dls-danger-bg hover:text-dls-danger-text"
          onClick={props.onDismiss}
          aria-label={t("composer.voice_error_dismiss")}
        >
          <X size={12} />
        </button>
      </div>
      <div class="mt-2 flex justify-end gap-1.5">
        <Show when={props.offerRedownload}>
          <button
            type="button"
            class="rounded-control border border-dls-danger-border px-2 py-1 text-label font-medium text-dls-danger-text hover:bg-dls-danger-bg"
            onClick={props.onRedownload}
          >
            {t("composer.voice_local_redownload")}
          </button>
        </Show>
        {/* The user's own decision, never an automatic fallback. */}
        <Show when={props.offerCloud}>
          <button
            type="button"
            class="rounded-control border border-dls-border/70 bg-dls-surface-solid px-2 py-1 text-label font-medium text-dls-text hover:bg-dls-hover"
            onClick={props.onUseCloud}
            data-testid="voice-failure-use-cloud"
          >
            {t("composer.voice_local_use_cloud")}
          </button>
        </Show>
      </div>
    </BubbleShell>
  );
}
