/**
 * Settings → Voice input.
 *
 * Owns the cloud/on-device choice, the in-app shortcut, (on-device only) the capture device, the Dictionary and the optional
 * LLM clean-up pass — the last two live in `settings.voice-dictionary-card.tsx`
 * and `settings.voice-refine-card.tsx` so no file grows past the 800-line
 * limit. The state itself lives in
 * `features/voice-input/use-voice-input.ts`; this file is presentation plus the
 * hotkey capture interaction.
 *
 * Three product rules are visible in the markup:
 *
 *  * **"English only" sits on the on-device option itself**, not only in the
 *    download dialog, so the limitation is readable before anyone commits to
 *    630 MB.
 *  * **The microphone picker is on-device only.** The Web Speech API cannot be
 *    pointed at a device, so offering it for cloud mode would be a control that
 *    silently does nothing.
 *  * **Several shortcuts may be bound at once**, each a key chord or a mouse
 *    button, because that is the only good answer to a binding that a given
 *    keyboard layout cannot produce (see the AltGr note in `voice-hotkey.ts`):
 *    add a second one rather than replacing the first.
 */
import { AlertTriangle, Keyboard, Languages, Mic, Volume2, X } from "lucide-solid";
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";

import {
  READ_ALOUD_VOICES,
  readReadAloudVoice,
  writeReadAloudVoice,
  type ReadAloudVoice,
} from "~/features/tts";
import {
  MAX_VOICE_HOTKEYS,
  createHotkeyCapture,
  formatHotkey,
  hotkeyIdentity,
  hotkeyNeedsAltGrNote,
  type HotkeyRejection,
  type VoiceHotkey,
  type VoiceInputController,
} from "~/features/voice-input";

import { t } from "../../i18n";
import Button from "../components/button";
import Dropdown from "~/shared/ui/dropdown";

import VoiceDictionaryCard from "./settings.voice-dictionary-card";
import VoiceRefineCard from "./settings.voice-refine-card";

const REJECTION_KEY: Record<HotkeyRejection, string> = {
  typing_key: "voice.hotkey_error_typing_key",
  reserved: "voice.hotkey_error_reserved",
  duplicate: "voice.hotkey_error_duplicate",
  too_many: "voice.hotkey_error_too_many",
};

const READ_ALOUD_VOICE_LABEL_KEY: Record<ReadAloudVoice, string> = {
  english: "voice.read_aloud_voice_english",
  "english-male": "voice.read_aloud_voice_english_male",
  british: "voice.read_aloud_voice_british",
};

export default function VoiceInputSettingsSection(props: { voice: VoiceInputController }) {
  const voice = props.voice;
  const [capturing, setCapturing] = createSignal(false);
  const rejection = voice.hotkeyRejection;
  const [readAloudVoice, setReadAloudVoice] = createSignal<ReadAloudVoice>(readReadAloudVoice());
  const changeReadAloudVoice = (value: string) => {
    const next = READ_ALOUD_VOICES.find((voiceKey) => voiceKey === value);
    if (!next) return;
    setReadAloudVoice(next);
    writeReadAloudVoice(next);
  };

  onMount(() => {
    // Device labels are only populated once a capture permission has been held,
    // so this can legitimately come back unlabelled on a fresh install.
    void voice.refreshDevices();
  });

  /**
   * One capture session. Held in a ref rather than rebuilt per event because a
   * chord is assembled across several presses, and the release that commits it
   * has to know what was held before.
   */
  const capture = createHotkeyCapture();
  onCleanup(() => capture.reset());

  const closeCapture = () => {
    capture.reset();
    setCapturing(false);
  };

  const openCapture = () => {
    capture.reset();
    voice.clearHotkeyRejection();
    setCapturing(true);
  };

  /** Commit, closing the field only on success so the reason stays actionable. */
  const commit = (candidate: VoiceHotkey | null) => {
    if (!candidate) return;
    if (voice.addHotkey(candidate)) closeCapture();
    else capture.reset();
  };

  const onCaptureKeyDown = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    // Escape is reserved, so it can serve as the way out of the field.
    if (event.code === "Escape") {
      closeCapture();
      return;
    }
    capture.keyDown(event);
  };

  const onCaptureKeyUp = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.code === "Escape") return;
    commit(capture.keyUp(event));
  };

  /**
   * Mouse bindings are captured on press, and only inside this field: a stray
   * side-button click anywhere else in Settings must not bind anything.
   */
  const onCaptureMouseDown = (event: MouseEvent) => {
    const candidate = capture.mouseDown(event);
    if (!candidate) return; // left/right click: let it focus the field as usual
    event.preventDefault();
    event.stopPropagation();
    commit(candidate);
  };

  /** The Web Speech API cannot be pointed at a device; see the header. */
  const deviceDisabled = () => voice.mode() !== "local" || !voice.localAvailable();

  return (
    <div class="space-y-6" data-testid="settings-voice-content">
      <div>
        <h2 class="text-display-lg font-bold text-dls-text">{t("voice.settings_title")}</h2>
      </div>

      {/* ── Mode ─────────────────────────────────────────────────────────── */}
      <div data-settings-anchor="voice_mode" class="bg-dls-panel-bg border border-dls-panel-border rounded-card p-5 space-y-4">
        <div class="flex items-center gap-2">
          <Mic size={16} class="text-dls-secondary" />
          <div class="text-body-lg font-medium text-dls-text">{t("voice.mode_heading")}</div>
        </div>

        <Show when={!voice.localAvailable()}>
          <div class="flex items-start gap-2 rounded-inset border border-dls-panel-border bg-dls-surface-tint p-3 text-caption text-dls-secondary">
            <AlertTriangle size={13} class="mt-0.5 shrink-0" />
            <span>{t("voice.mode_local_unavailable")}</span>
          </div>
        </Show>

        <div class="space-y-2">
          <label
            class={`flex cursor-pointer items-start gap-3 rounded-inset border p-3 ${
              voice.mode() === "local" && voice.localAvailable()
                ? "border-[rgb(var(--dls-accent-rgb)/0.5)] bg-[rgb(var(--dls-accent-rgb)/0.06)]"
                : "border-dls-panel-inset-border bg-dls-panel-inset-bg"
            } ${voice.localAvailable() ? "" : "opacity-60"}`}
          >
            <input
              type="radio"
              name="voice-mode"
              class="mt-0.5"
              value="local"
              checked={voice.mode() === "local"}
              disabled={!voice.localAvailable()}
              onChange={() => voice.setMode("local")}
              data-testid="voice-mode-local"
            />
            <span class="min-w-0 flex-1">
              <span class="flex flex-wrap items-center gap-1.5">
                <span class="text-body-lg text-dls-text">{t("voice.mode_local_title")}</span>
                {/* English-only, on the option itself. */}
                <span class="inline-flex items-center gap-1 rounded-pill border border-dls-panel-border bg-dls-surface-tint px-1.5 py-px text-tiny font-medium text-dls-secondary">
                  <Languages size={10} />
                  {t("voice.mode_local_badge")}
                </span>
              </span>
              <span class="mt-1 block text-caption text-dls-secondary leading-relaxed">
                {t("voice.mode_local_desc")}
              </span>
            </span>
          </label>

          <label
            class={`flex cursor-pointer items-start gap-3 rounded-inset border p-3 ${
              voice.mode() === "cloud" || !voice.localAvailable()
                ? "border-[rgb(var(--dls-accent-rgb)/0.5)] bg-[rgb(var(--dls-accent-rgb)/0.06)]"
                : "border-dls-panel-inset-border bg-dls-panel-inset-bg"
            }`}
          >
            <input
              type="radio"
              name="voice-mode"
              class="mt-0.5"
              value="cloud"
              checked={voice.mode() === "cloud" || !voice.localAvailable()}
              onChange={() => voice.setMode("cloud")}
              data-testid="voice-mode-cloud"
            />
            <span class="min-w-0 flex-1">
              <span class="text-body-lg text-dls-text">{t("voice.mode_cloud_title")}</span>
              <span class="mt-1 block text-caption text-dls-secondary leading-relaxed">
                {t("voice.mode_cloud_desc")}
              </span>
            </span>
          </label>
        </div>
      </div>

      {/* ── Shortcut ─────────────────────────────────────────────────────── */}
      <div data-settings-anchor="voice_hotkey" class="bg-dls-panel-bg border border-dls-panel-border rounded-card p-5 space-y-3">
        <div class="flex items-center gap-2">
          <Keyboard size={16} class="text-dls-secondary" />
          <div class="text-body-lg font-medium text-dls-text">{t("voice.hotkey_heading")}</div>
        </div>
        <p class="text-caption text-dls-secondary leading-relaxed">{t("voice.hotkey_desc")}</p>

        {/* Every binding, each removable. Any one of them toggles recording, so
            they are a list and not a radio group. */}
        <div class="flex flex-wrap items-center gap-2" data-testid="voice-hotkey-list">
          <For each={voice.hotkeys()}>
            {(hotkey, index) => (
              <span
                class="inline-flex items-center gap-1 rounded-subtle border border-dls-panel-border bg-dls-surface-tint py-1 pl-2 pr-1 text-caption text-dls-text"
                data-testid="voice-hotkey-value"
              >
                <kbd class="font-mono">{formatHotkey(hotkey)}</kbd>
                <button
                  type="button"
                  class="rounded-compact p-0.5 text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
                  aria-label={`${t("voice.hotkey_remove")} ${formatHotkey(hotkey)}`}
                  onClick={() => voice.removeHotkey(index())}
                  data-testid={`voice-hotkey-remove-${hotkeyIdentity(hotkey)}`}
                >
                  <X size={12} />
                </button>
              </span>
            )}
          </For>
          <Show when={voice.hotkeys().length === 0 && !capturing()}>
            <span class="text-caption text-dls-secondary" data-testid="voice-hotkey-empty">
              {t("voice.hotkey_none")}
            </span>
          </Show>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <Show
            when={capturing()}
            fallback={
              <>
                <Button
                  variant="outline"
                  class="text-caption h-8 py-0 px-3"
                  disabled={voice.hotkeys().length >= MAX_VOICE_HOTKEYS}
                  onClick={openCapture}
                  data-testid="voice-hotkey-change"
                >
                  {t("voice.hotkey_add")}
                </Button>
                <button
                  type="button"
                  class="text-caption text-dls-accent underline underline-offset-2 hover:opacity-80"
                  onClick={() => voice.resetHotkeys()}
                >
                  {t("voice.hotkey_reset")}
                </button>
              </>
            }
          >
            {/* A focused element captures the chord, so the combination never
                reaches the app while it is being chosen. `onBlur` is not a
                closer here: a mouse-button press inside the field can move focus
                on some platforms, and closing on that would drop the binding the
                user just made. [Cancel] and Escape are the ways out. */}
            <div
              tabindex={0}
              ref={(element) => queueMicrotask(() => element.focus())}
              class="rounded-subtle border border-[rgb(var(--dls-accent-rgb)/0.6)] bg-[rgb(var(--dls-accent-rgb)/0.08)] px-3 py-1.5 text-caption text-dls-text outline-none"
              onKeyDown={onCaptureKeyDown}
              onKeyUp={onCaptureKeyUp}
              onMouseDown={onCaptureMouseDown}
              data-testid="voice-hotkey-capture"
            >
              {t("voice.hotkey_capture")}
            </div>
            <Button variant="outline" class="text-caption h-8 py-0 px-3" onClick={closeCapture}>
              {t("voice.hotkey_cancel")}
            </Button>
          </Show>
        </div>

        <Show when={rejection()}>
          {(reason) => (
            <div
              class="rounded-inset border border-dls-danger-border bg-dls-danger-bg p-3 text-caption text-dls-danger-text"
              data-testid="voice-hotkey-rejection"
            >
              {t(REJECTION_KEY[reason()])}
            </div>
          )}
        </Show>

        {/* Informational, not an error: the remedy is to add a second binding,
            which this card already offers. */}
        <Show when={hotkeyNeedsAltGrNote(voice.hotkeys())}>
          <div
            class="flex items-start gap-2 rounded-inset border border-dls-panel-border bg-dls-surface-tint p-3 text-caption text-dls-secondary"
            data-testid="voice-hotkey-altgr-note"
          >
            <AlertTriangle size={13} class="mt-0.5 shrink-0" />
            <span>{t("voice.hotkey_altgr_note")}</span>
          </div>
        </Show>

        {/* Bound mouse buttons keep their normal action, which is surprising if
            nobody says so. */}
        <Show when={voice.hotkeys().some((hotkey) => hotkey.type === "mouse")}>
          <p class="text-caption text-dls-secondary leading-relaxed">{t("voice.hotkey_mouse_note")}</p>
        </Show>
      </div>

      {/* ── Microphone (on-device only) ──────────────────────────────────── */}
      <div data-settings-anchor="voice_device" class="bg-dls-panel-bg border border-dls-panel-border rounded-card p-5 space-y-3">
        <div class="text-body-lg font-medium text-dls-text">{t("voice.device_heading")}</div>
        <Show when={deviceDisabled()}>
          <p
            class="text-caption text-dls-secondary leading-relaxed"
            data-testid="voice-device-local-only"
          >
            {t("voice.device_local_only")}
          </p>
        </Show>
        <div class="flex flex-wrap items-center gap-2">
          <Dropdown
            class="min-w-[220px]"
            value={voice.deviceId()}
            disabled={deviceDisabled()}
            onChange={(deviceId) => voice.setDeviceId(deviceId)}
            data-testid="voice-device-select"
            aria-label={t("voice.device_heading")}
            options={[
              { value: "", label: t("voice.device_system_default") },
              ...voice.devices().map((device) => ({
                value: device.deviceId,
                label: device.label,
              })),
            ]}
          />
          <Button
            variant="outline"
            class="text-caption h-8 py-0 px-3"
            onClick={() => void voice.refreshDevices()}
          >
            {t("voice.device_refresh")}
          </Button>
        </div>
      </div>

      {/* ── Read-aloud voice ─────────────────────────────────────────────── */}
      <div data-settings-anchor="read_aloud" class="bg-dls-panel-bg border border-dls-panel-border rounded-card p-5 space-y-3">
        <div class="flex items-center gap-2">
          <Volume2 size={16} class="text-dls-secondary" />
          <div class="text-body-lg font-medium text-dls-text">{t("voice.read_aloud_voice_heading")}</div>
        </div>
        <Dropdown
          class="min-w-[220px]"
          value={readAloudVoice()}
          onChange={changeReadAloudVoice}
          data-testid="read-aloud-voice-select"
          aria-label={t("voice.read_aloud_voice_heading")}
          options={READ_ALOUD_VOICES.map((key) => ({
            value: key,
            label: t(READ_ALOUD_VOICE_LABEL_KEY[key]),
          }))}
        />
      </div>

      {/* ── LLM clean-up ─────────────────────────────────────────────────── */}
      <VoiceRefineCard voice={voice} />

      {/* ── Dictionary ───────────────────────────────────────────────────── */}
      <VoiceDictionaryCard voice={voice} />
    </div>
  );
}
