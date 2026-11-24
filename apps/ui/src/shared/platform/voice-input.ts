import { createSignal, onCleanup } from "solid-js";

import { t } from "~/i18n";

/**
 * i18n key per `SpeechRecognitionErrorEvent.error` code.
 *
 * `not-allowed` and `service-not-allowed` share a message because the remedy is
 * the same OS privacy toggle. Chromium also reports `not-allowed` when no
 * capture device exists, so that message must not claim the user denied
 * anything.
 *
 * A Map, not an object: plain lookup inherits `toString`/`constructor` from
 * Object.prototype, so those codes would return a function instead of falling
 * back to the unknown-error message.
 */
const TOAST_KEY_BY_ERROR = new Map<string, string>([
  ["audio-capture", "composer.voice_audio_capture"],
  ["no-speech", "composer.voice_no_speech"],
  ["not-allowed", "composer.voice_mic_denied"],
  ["service-not-allowed", "composer.voice_mic_denied"],
  ["network", "composer.voice_network"],
  ["aborted", "composer.voice_aborted"],
  ["language-not-supported", "composer.voice_language_unsupported"],
]);

/**
 * Toast key for a recognition error, or null for the `aborted` we cause
 * ourselves. Unknown codes fall back rather than going unreported.
 */
export const voiceErrorToastKey = (
  error: string,
  options?: { selfAborted?: boolean },
): string | null => {
  if (error === "aborted" && options?.selfAborted) return null;
  return TOAST_KEY_BY_ERROR.get(error) ?? "composer.voice_error_unknown";
};

/** i18n key per `getUserMedia` rejection name. A Map, for the same reason. */
const TOAST_KEY_BY_MIC_REQUEST = new Map<string, string>([
  ["NotFoundError", "composer.voice_no_microphone"],
  ["OverconstrainedError", "composer.voice_no_microphone"],
  ["NotAllowedError", "composer.voice_mic_denied"],
  ["SecurityError", "composer.voice_mic_denied"],
  // A device is there, we just cannot read it -- in use, or a dead endpoint.
  ["NotReadableError", "composer.voice_audio_capture"],
  ["AbortError", "composer.voice_audio_capture"],
]);

/**
 * How to report a failed mic request, and whether it proves absent hardware.
 *
 * This is the distinction `SpeechRecognition` cannot make -- it reports
 * `not-allowed` both for a refused permission and for a machine with no capture
 * device -- so only `getUserMedia` can tell the user which one they have.
 */
export const micRequestFailure = (
  name: string,
): { toastKey: string; missing: boolean } => ({
  toastKey: TOAST_KEY_BY_MIC_REQUEST.get(name) ?? "composer.voice_error_unknown",
  // Absent hardware, as opposed to a device we merely cannot use right now.
  // Only these two may mute the button.
  missing: name === "NotFoundError" || name === "OverconstrainedError",
});

/**
 * Owns the composer's Web Speech session and mic-presence state.
 *
 * Must be called during component setup: it registers an `onCleanup` that both
 * drops the `devicechange` listener and aborts any live recognition.
 */
export function createVoiceInput(options: {
  onToast: (message: string) => void;
  onTranscript: (transcript: string) => void;
}) {
  // Resolved per start(), not captured once: tests install a mock constructor
  // after the composer has mounted.
  const speechRecognitionCtor = () =>
    window.SpeechRecognition || window.webkitSpeechRecognition;

  const [listening, setListening] = createSignal(false);
  // Only set true by a mic request that proves there is no capture device.
  const [micMissing, setMicMissing] = createSignal(false);
  // Bumped each time a request proves the microphone is missing, so the
  // note above the button can show again on a later press.
  const [micAbsenceTick, setMicAbsenceTick] = createSignal(0);

  let recognitionRef: SpeechRecognition | null = null;
  let requesting = false;
  /**
   * Bumped by everything that makes an in-flight mic request's outcome
   * irrelevant: an abort, a component cleanup, a device change. A request
   * captures this before it awaits and then applies NOTHING -- no `start()`, no
   * `micMissing` write, no toast -- if it has moved on since.
   *
   * A counter rather than a boolean flag because requests are not strictly
   * serialised with the events that invalidate them: a `devicechange` must
   * invalidate the older request without permanently poisoning the next one.
   */
  let requestGeneration = 0;

  /**
   * Detaches the ref before aborting, which is what lets `onerror` tell our own
   * abort from a real failure. Every abort path must go through here.
   */
  const abort = () => {
    // A pending permission prompt can outlive the thing that opened it: both
    // `sendDraft()` and `onCleanup()` abort, and the user may answer "Allow"
    // afterwards. Without this bump that late grant opens the mic for an
    // already-aborted session, or for a composer that is gone.
    requestGeneration++;
    const recognition = recognitionRef;
    recognitionRef = null;
    setListening(false);
    recognition?.abort();
  };

  const start = () => {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      if (recognitionRef !== recognition) return;
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          transcript += event.results[i][0].transcript;
        }
      }
      if (transcript) options.onTranscript(transcript);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.warn("Speech recognition error:", event.error);
      const selfAborted = recognitionRef !== recognition;
      if (!selfAborted) {
        recognitionRef = null;
        setListening(false);
      }
      const toastKey = voiceErrorToastKey(event.error, { selfAborted });
      if (toastKey) options.onToast(t(toastKey));
    };

    recognition.onend = () => {
      if (recognitionRef !== recognition) return;
      recognitionRef = null;
      setListening(false);
    };

    recognitionRef = recognition;
    try {
      recognition.start();
      setListening(true);
      options.onToast(t("composer.voice_cloud_notice"));
    } catch (error) {
      recognitionRef = null;
      setListening(false);
      options.onToast(
        error instanceof Error
          ? error.message
          : t("composer.voice_start_failed"),
      );
    }
  };

  /**
   * Asks for capture before opening recognition. Returns false when the caller
   * must not proceed, having already toasted the reason.
   *
   * This replaced an `enumerateDevices()` probe that ran at mount, for two
   * reasons -- the second is why the probe could not be repaired in place:
   *
   * - Chromium withholds `audioinput` entries until mic permission is granted,
   *   so an empty list cannot tell absent hardware from a withheld permission.
   *   Reading it as absence muted the button on every machine that had never
   *   granted the permission, which is every machine on first run.
   * - Nothing else asks for the permission. While the button was muted no
   *   request was ever made, so the permission could never be granted and the
   *   muted state could never clear: the gate locked out the one thing that
   *   would have opened it.
   */
  const requestMicrophone = async (generation: number): Promise<boolean> => {
    // A host with no device layer at all keeps voice input rather than losing
    // it silently; let recognition report whatever then goes wrong.
    if (!navigator.mediaDevices?.getUserMedia) return true;
    // True once this request's outcome has stopped mattering -- see
    // `requestGeneration`.
    const superseded = () => generation !== requestGeneration;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Recognition opens its own capture, so this stream existed only to ask.
      // Released BEFORE the superseded check, or a grant that arrives after an
      // abort leaves the mic -- and its OS indicator -- open with no owner.
      for (const track of stream.getTracks()) track.stop();
      if (superseded()) return false;
      setMicMissing(false);
      return true;
    } catch (error) {
      console.warn("Microphone request failed:", error);
      // A rejection from a request issued before a `devicechange` describes
      // hardware that no longer exists: muting the button on its `NotFoundError`
      // would undo the unmute the plug-in event just performed, and leave it
      // muted until another device event or a restart.
      if (superseded()) return false;
      const { toastKey, missing } = micRequestFailure(
        error instanceof Error ? error.name : "",
      );
      setMicMissing(missing);
      if (missing) setMicAbsenceTick((tick) => tick + 1);
      // Absence is said by the button, next to the control. The other
      // failures have no such label, so they still use the composer toast.
      if (!missing) options.onToast(t(toastKey));
      return false;
    }
  };

  const beginListening = async () => {
    // The request can take as long as the user takes to answer the prompt, and
    // the button stays live throughout.
    if (requesting) return;
    requesting = true;
    // Captured before the await: `requestMicrophone` returns false if this has
    // moved on by the time the user answers, which is what stops `start()`.
    const generation = requestGeneration;
    try {
      if (await requestMicrophone(generation)) start();
    } finally {
      requesting = false;
    }
  };

  if (speechRecognitionCtor()) {
    // A plug/unplug invalidates an earlier "no microphone", so let the next
    // click ask again instead of staying muted until the app restarts.
    const onDeviceChange = () => {
      // Invalidate any request already in flight before clearing the state: it
      // was asked under the old hardware set, so its answer must not be allowed
      // to re-mute the button we are unmuting here.
      requestGeneration++;
      setMicMissing(false);
    };
    navigator.mediaDevices?.addEventListener("devicechange", onDeviceChange);
    onCleanup(() => {
      navigator.mediaDevices?.removeEventListener(
        "devicechange",
        onDeviceChange,
      );
      abort();
    });
  }

  return {
    supported: Boolean(speechRecognitionCtor()),
    listening,
    micMissing,
    micAbsenceTick,
    abort,
    toggle: () => {
      if (listening()) {
        recognitionRef?.stop();
        setListening(false);
        return;
      }
      // Ask again even when the last press found nothing. WebView2 does not
      // fire `devicechange` for a microphone plugged in before a capture
      // permission exists, so skipping this request would keep the button
      // muted until restart.
      void beginListening();
    },
    buttonLabel: () => {
      if (listening()) return t("composer.voice_stop_listening");
      if (micMissing()) return t("composer.voice_no_microphone");
      return t("composer.voice_start");
    },
  };
}
