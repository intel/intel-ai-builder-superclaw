import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { t } from "../../../i18n";
import type { VoiceInputController } from "~/features/voice-input";

export const TOAST_DISMISS_MS = 2400;

export function ComposerToast(props: {
  message: string;
  class?: string;
  voiceInput?: VoiceInputController;
  onDismiss?: () => void;
}) {
  const [hovered, setHovered] = createSignal(false);

  createEffect(() => {
    // Held open while an [Undo] offer stands: a Dictionary word the loop just learned
    // is taken back from this notice, and 2.4 s is not long enough to read it and
    // disagree. A new message, or leaving the toast, restarts the full timeout.
    void props.message;
    if (hovered() || (props.voiceInput?.undoableAdd() ?? []).length > 0) return;
    const id = window.setTimeout(() => props.onDismiss?.(), TOAST_DISMISS_MS);
    onCleanup(() => window.clearTimeout(id));
  });

  return (
    <div
      data-testid="composer-toast"
      class={`max-w-sm rounded-inset border border-dls-border bg-dls-surface-solid px-3 py-2 text-caption text-dls-text shadow-lg backdrop-blur-md ${props.class ?? ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div class="flex items-center gap-3">
        <span>{props.message}</span>
        {/* Taking back a word the Dictionary just learned. Offered here rather
            than only in Settings because this notice is the one moment the user
            knows it happened; the timer above keeps the notice open while the
            offer stands. */}
        <Show when={(props.voiceInput?.undoableAdd() ?? []).length > 0}>
          <button
            type="button"
            data-testid="composer-toast-undo-dictionary"
            class="shrink-0 rounded-subtle border border-dls-border bg-dls-hover px-2 py-1 text-tiny text-dls-secondary hover:bg-dls-active"
            onClick={() => props.voiceInput?.undoAutoAdd()}
          >
            {t("voice.dictionary_auto_add_undo")}
          </button>
        </Show>
      </div>
    </div>
  );
}
