import { Show } from "solid-js";
import { Volume2, VolumeX } from "lucide-solid";
import type { NarrationState } from "~/features/tts";
import { t } from "../../../i18n";
import { Tooltip } from "~/shared/ui/tooltip";

export function NarrationToggle(props: {
  narration: NarrationState;
  speaking: boolean;
  onToggle: () => void;
  variant?: "toolbar" | "pill";
}) {
  const pill = () => props.variant === "pill";
  const iconSize = () => (pill() ? 13 : 16);
  const on = () => props.narration === "on";
  // While starting, a click cancels, so the control reads as "stop" already.
  const engaged = () => props.narration !== "off";
  return (
    <Tooltip
      content={engaged() ? t("composer.tts_stop") : t("composer.tts_start")}
      placement="bottom"
      maxWidthClass="max-w-[160px]"
    >
      <button
        type="button"
        class={
          pill()
            ? `inline-flex items-center justify-center rounded-pill border px-2.5 py-1 transition-colors ${
                on()
                  ? "border-dls-success-border bg-dls-success-bg text-dls-success-text hover:bg-dls-success-bg/80"
                  : "border-dls-border bg-transparent text-dls-text hover:bg-dls-hover"
              }`
            : `rounded-subtle p-1.5 transition-colors ${
                on()
                  ? "text-dls-success-text bg-dls-success-bg hover:bg-dls-success-bg/80"
                  : "text-dls-secondary hover:bg-dls-hover"
              }`
        }
        onClick={() => props.onToggle()}
        aria-label={engaged() ? t("composer.tts_stop") : t("composer.tts_start")}
        aria-pressed={engaged()}
      >
        {/* Speaker glyph with an "EN" language label stacked underneath:
            Kokoro narration is English-only for now. Plain text (no box) so it
            never overlaps the speaker symbol and inherits the button's color
            (green when active). */}
        <span class="inline-flex flex-col items-center leading-none">
          <Show when={engaged()} fallback={<VolumeX size={iconSize()} />}>
            <span
              class={props.speaking || props.narration === "starting" ? "inline-flex animate-pulse" : "inline-flex"}
            >
              <Volume2 size={iconSize()} />
            </span>
          </Show>
          <span
            aria-hidden="true"
            class="mt-[1px] text-micro font-bold uppercase leading-none tracking-[0.06em]"
          >
            EN
          </span>
        </span>
      </button>
    </Tooltip>
  );
}
