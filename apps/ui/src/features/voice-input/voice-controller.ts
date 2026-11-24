/**
 * Engine selection for the composer's microphone button.
 *
 * The composer calls this instead of `createVoiceInput` and gets one object with
 * the same members it always used (`supported` / `listening` / `micMissing` /
 * `abort` / `toggle` / `buttonLabel`). Which engine answers — the browser's
 * cloud speech service or the on-device `asr_manager` — is decided here from the
 * saved mode plus whether local mode is actually available.
 *
 * Both providers are constructed once during setup rather than swapped lazily:
 * each registers signals and an `onCleanup`, which SolidJS only allows inside a
 * reactive owner, and building them up front makes flipping the mode in Settings
 * take effect on the next press with no teardown dance.
 */
import { createEffect, on, onCleanup, type Accessor } from "solid-js";

import { createVoiceInput } from "~/shared/platform/voice-input";

import {
  createLocalVoiceInput,
  type LocalVoiceInput,
  type LocalVoiceInputOptions,
} from "./local-voice-input";
import {
  MODIFIER_RELEASE_GRACE_MS,
  ariaKeyShortcuts,
  createHotkeyMatcher,
  type HotkeyMatch,
  type VoiceHotkey,
} from "./voice-hotkey";
import type { VoiceInputMode } from "./voice-input-prefs";

/**
 * Builds the local provider. Supplied by `useVoiceInput` so the composer can
 * keep owning `onToast`/`onTranscript` while the feature slice owns the service
 * lifecycle. Absent (tests, or a build without the service) means cloud-only.
 */
export type LocalVoiceInputFactory = (
  options: Pick<LocalVoiceInputOptions, "onToast" | "onTranscript">,
) => LocalVoiceInput;

export type VoiceControllerOptions = {
  onToast: (message: string) => void;
  onTranscript: (transcript: string) => void;
  /** Saved preference. Defaults to cloud when voice input is not wired up. */
  mode?: Accessor<VoiceInputMode>;
  /** Whether the local engine may be used at all (service present + Profile flag). */
  localAvailable?: Accessor<boolean>;
  createLocal?: LocalVoiceInputFactory;
  /**
   * Bindings for the in-app hotkey — key chords and mouse buttons, any of which
   * toggles. No listener is installed when absent.
   */
  hotkeys?: Accessor<readonly VoiceHotkey[]>;
  /** Rendered into the tooltip, e.g. "Right Alt". */
  hotkeyLabel?: Accessor<string>;
  /** Recording began — the caller shows the first-run hint bubble once. */
  onRecordingStarted?: () => void;
  /**
   * Monotonic counter: every increment asks for a recording to start now. This
   * is how "Use cloud instead" starts recording immediately after switching the
   * mode, which the plan requires — the button lives in a dialog outside the
   * composer and cannot reach the provider directly.
   */
  startRequest?: Accessor<number>;
  /**
   * When false, abort any capture and ignore hotkeys, startRequest, and toggle.
   * Used while the composer is hidden on a read-only child transcript so
   * dictation cannot run without a visible stop control. Defaults to true.
   */
  enabled?: Accessor<boolean>;
};

export function createVoiceController(options: VoiceControllerOptions) {
  const cloud = createVoiceInput({
    onToast: options.onToast,
    onTranscript: options.onTranscript,
  });

  const local = options.createLocal?.({
    onToast: options.onToast,
    onTranscript: options.onTranscript,
  });

  const usingLocal = () =>
    Boolean(local) && options.mode?.() === "local" && Boolean(options.localAvailable?.());
  const enabled = () => options.enabled?.() ?? true;

  /**
   * The local engine when a press would use it, else undefined — for the two
   * members only it has (`transcribing`). {@link engine} is the one to reach for
   * otherwise.
   *
   * `usingLocal()` already implies `local` is defined, so these two re-test it
   * only to stay free of non-null assertions: `local!` six times over would be
   * six places for a future reader to re-derive that implication.
   */
  const localEngine = () => (usingLocal() ? local : undefined);
  /** Whichever engine a press would drive right now. */
  const engine = () => localEngine() ?? cloud;

  const listening = () => engine().listening();
  const micMissing = () => engine().micMissing();
  const micAbsenceTick = () => engine().micAbsenceTick();

  /** Stop whichever engine is running, whatever the current mode says. */
  const abort = () => {
    cloud.abort();
    local?.abort();
  };

  // Switching engines mid-recording would leave the old one holding the
  // microphone with no button to stop it.
  createEffect(on(usingLocal, () => abort(), { defer: true }));

  // A hidden read-only composer still mounts this controller; stop capture so
  // recording cannot continue without a visible mic / stop button.
  createEffect(
    on(
      enabled,
      (isEnabled) => {
        if (!isEnabled) abort();
      },
      { defer: true },
    ),
  );

  // One "first recording" trigger for both engines, so the hint bubble does not
  // have to know which provider started.
  createEffect(
    on(listening, (isListening) => {
      if (isListening) options.onRecordingStarted?.();
    }),
  );

  const toggle = () => {
    if (!enabled()) return;
    engine().toggle();
  };

  if (options.startRequest) {
    createEffect(
      on(
        options.startRequest,
        () => {
          if (!enabled() || listening()) return;
          toggle();
        },
        // Skips the initial value: mounting the composer must not record.
        { defer: true },
      ),
    );
  }

  /**
   * Local mode does not need `SpeechRecognition`, so the button must stay
   * visible on a WebView without it as long as `asr_manager` is usable.
   */
  const supported = () => (usingLocal() ? true : cloud.supported);

  const hotkeys = options.hotkeys;
  if (hotkeys) {
    // Window listeners are intentionally the whole "only while focused"
    // implementation: these are in-app shortcuts, not OS-level ones, so they
    // cannot fire while the user is typing in another application. The matcher
    // owns the arming rules (see `voice-hotkey.ts`); this block only translates
    // its verdict into DOM calls.
    const matcher = createHotkeyMatcher(hotkeys());
    let releaseGrace: ReturnType<typeof setTimeout> | undefined;
    const clearReleaseGrace = () => {
      if (releaseGrace === undefined) return;
      clearTimeout(releaseGrace);
      releaseGrace = undefined;
    };
    createEffect(
      on(
        hotkeys,
        (hotkeys) => {
          clearReleaseGrace();
          matcher.setHotkeys(hotkeys);
        },
        // The matcher was built with the current list already.
        { defer: true },
      ),
    );

    const act = (event: Event, match: HotkeyMatch) => {
      if (match.preventDefault) event.preventDefault();
      if (match.fire) {
        clearReleaseGrace();
        if (supported() && enabled()) toggle();
        return;
      }
      // A modifier chord is armed. Fire it if the keyup never comes, which is
      // the bare Right Alt case: the first press's release is dropped, so
      // waiting for that release is why the user has to press again.
      if (match.releaseGrace === true) {
        clearReleaseGrace();
        releaseGrace = setTimeout(() => {
          releaseGrace = undefined;
          if (matcher.commitPendingRelease().fire && supported() && enabled()) toggle();
        }, MODIFIER_RELEASE_GRACE_MS);
        return;
      }
      if (match.releaseGrace === false) clearReleaseGrace();
    };

    // While disabled (hidden child composer), feed nothing to the matcher at
    // all instead of computing a match and discarding it: that keeps a chord
    // from ever reaching `preventDefault` — a bound chord such as Ctrl+F would
    // otherwise swallow "find" on a read-only transcript — and `reset()` drops
    // any half-held chord so re-enabling later does not inherit stale state.
    const withEnabled =
      <E extends Event>(run: (event: E) => HotkeyMatch) =>
      (event: E) => {
        if (!enabled()) {
          clearReleaseGrace();
          matcher.reset();
          return;
        }
        act(event, run(event));
      };

    const onKeyDown = withEnabled((event: KeyboardEvent) => matcher.keyDown(event));
    const onKeyUp = withEnabled((event: KeyboardEvent) => matcher.keyUp(event));
    const onMouseDown = withEnabled((event: MouseEvent) => matcher.mouseDown(event));
    const onMouseUp = withEnabled((event: MouseEvent) => matcher.mouseUp(event));
    // Alt+Tab hides the window while holding a key of the default binding, and
    // its release never arrives. A bare Alt tap can also blur the webview (the
    // menu takes focus) without hiding the window; resetting there throws away
    // the press the user just made.
    const leaveApp = () => {
      clearReleaseGrace();
      matcher.reset();
    };
    const onBlur = () => {
      if (globalThis.document?.visibilityState === "hidden") leaveApp();
    };
    const onVisibility = () => {
      if (globalThis.document?.visibilityState === "hidden") leaveApp();
    };
    const doc = globalThis.document;

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", onBlur);
    doc?.addEventListener("visibilitychange", onVisibility);
    onCleanup(() => {
      clearReleaseGrace();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", onBlur);
      doc?.removeEventListener("visibilitychange", onVisibility);
    });
  }

  return {
    supported,
    listening,
    micMissing,
    micAbsenceTick,
    /** True only in local mode, while `/transcribe` is in flight. */
    transcribing: () => localEngine()?.transcribing() ?? false,
    abort,
    toggle,
    /**
     * What the button *does*, and nothing else. This is the accessible name and
     * the string the installed-app e2e spec pins ("Click to start voice input",
     * "Stop listening", "No microphone found. …"): appending the shortcut here
     * would make the accessible name change every time the user rebinds the
     * hotkey, and screen readers would read the chord as part of the action.
     * The shortcut is exposed through {@link keyShortcuts} instead, which is the
     * attribute ARIA defines for it.
     */
    buttonLabel: () => engine().buttonLabel(),
    /**
     * Tooltip text: the label plus the shortcut, which the plan wants readable
     * on hover ("開始語音輸入（Right Alt）"). Concatenated rather than
     * interpolated: `t()` has no placeholders, and a separate "label (key)"
     * phrase per locale would drift from the binding.
     */
    buttonTooltip: () => {
      const label = engine().buttonLabel();
      const hotkey = options.hotkeyLabel?.();
      return hotkey ? `${label} · ${hotkey}` : label;
    },
    /** `aria-keyshortcuts` value, or "" when no hotkey is wired up. */
    keyShortcuts: () => ariaKeyShortcuts(options.hotkeys?.() ?? []),
    /** Which engine a press would use right now; drives the hint bubble copy. */
    activeMode: (): VoiceInputMode => (usingLocal() ? "local" : "cloud"),
  };
}

export type VoiceController = ReturnType<typeof createVoiceController>;
