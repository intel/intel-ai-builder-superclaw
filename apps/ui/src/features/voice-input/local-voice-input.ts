/**
 * LOCAL voice-input provider: press-to-record, release-to-transcribe against
 * `asr_manager` on this machine.
 *
 * It exposes the same surface as the cloud/browser provider in
 * `shared/platform/voice-input.ts` (`supported` / `listening` / `micMissing` / `abort` /
 * `toggle` / `buttonLabel`), so the composer never learns which engine is
 * behind the microphone button. Everything engine-specific — the download
 * consent gate, the model snapshot, error recovery offers — is handed in as
 * callbacks and owned by `use-voice-input.ts`.
 *
 * The one rule that shapes the whole file: **a local failure never switches to
 * the cloud by itself.** Failures are reported upwards so the UI can render an
 * explicit "Use cloud instead" button; nothing here changes the mode.
 *
 * The optional LLM clean-up pass does not bend that rule: it never runs unless
 * the user turned it on, it polishes text the on-device decoder has already
 * produced, and every way it can fail ends with that raw text in the composer.
 * Recognition stays on this machine either way.
 */
import { createSignal, onCleanup, type Accessor } from "solid-js";

import { t } from "../../i18n";

import type {
  AsrRefineGate,
  AsrRefineRequest,
  AsrRefineResponse,
  AsrTranscribeRequest,
  AsrTranscribeResponse,
} from "./asr-client";
import { createMicPresence } from "./mic-presence";
import {
  MAX_AUDIO_SECONDS,
  TARGET_SAMPLE_RATE,
  VoiceCaptureError,
  confirmMicrophone,
  startPcmRecording,
  type PcmRecorderHandle,
  type PcmRecording,
} from "./pcm-capture";
import {
  classifyVoiceLocalError,
  classifyVoiceRefineError,
  type VoiceLocalOutcome,
} from "./voice-error";

export type VoiceLocalFailure = Extract<VoiceLocalOutcome, { kind: "failed" }>;

export type LocalVoiceInputOptions = {
  /**
   * Resolves true when the weights are present and the service is usable.
   * Implementations are expected to open the 630 MB consent dialog (or report
   * download progress) and resolve false instead of throwing.
   */
  ensureModelReady: () => Promise<boolean>;
  /** Sends one `/transcribe`. Null when no ServiceHub connection is configured. */
  transcribe:
    | ((body: AsrTranscribeRequest, signal: AbortSignal) => Promise<AsrTranscribeResponse>)
    | null;
  /**
   * Sends one `/refine`. Same shape as {@link transcribe} — absent or null both
   * mean no clean-up is wired on this install, which is the ordinary case and
   * must simply insert the transcript as dictated.
   */
  refine?:
    | ((body: AsrRefineRequest, signal: AbortSignal) => Promise<AsrRefineResponse>)
    | null;
  /** Whether the user opted into the clean-up pass. Absent means off. */
  refineEnabled?: Accessor<boolean>;
  /**
   * Identity of the ServiceHub connection the two calls go to — anything whose
   * `!==` is meaningful; the caller passes its client instance.
   *
   * ONE DICTATION MUST BE ONE INSTALL. `/transcribe` and `/refine` are separate
   * round trips, and the caller resolves the client for each of them
   * independently, so a connection change in between handed the transcript
   * produced by install A to install B for clean-up — a different install, and
   * potentially a different cloud provider, neither of which the user dictated
   * into. Both reads were individually correct, which is why nothing noticed.
   * Raised by Copilot on superclaw#3027.
   *
   * Captured when the recording is sent and re-read before clean-up; a change
   * aborts the clean-up, so the raw transcript is inserted with a notice. Here
   * rather than in the caller's callbacks because the span that has to hold
   * still is one DICTATION, and this module is what owns a dictation.
   *
   * Absent means "do not check", which is right for a caller with a single
   * fixed connection.
   */
  connection?: () => unknown;
  /**
   * Whether a `/refine` can be reached on this install *right now* — the live
   * answer, which goes false once {@link onRefineUnsupported} has fired.
   *
   * Separate from {@link refineEnabled} because they are different questions and
   * the latch must not touch the saved preference: the user's choice stays as
   * they left it, and only this accessor stops the doomed calls. Absent means
   * "assume reachable", which is the right default for a caller that wires
   * `refine` but tracks no availability of its own.
   */
  refineAvailable?: Accessor<boolean>;
  /**
   * Which model serves the clean-up pass — mode, plus the chosen model id when
   * the mode is `preset`. Read at send time, like `dictionary`.
   *
   * One accessor rather than a mode and a model side by side, because the pair is
   * only meaningful together: a model id under `agent` mode is rejected by LRM's
   * data plane, so the mode decides whether the model may be sent at all.
   */
  refineTarget?: Accessor<Omit<AsrRefineRequest, "text">>;
  /**
   * This install can never clean up (no inference key, or an `asr_manager`
   * without the route). Reported once so the owner of the preference can stop
   * spending a doomed round trip per dictation.
   */
  onRefineUnsupported?: () => void;
  /** Chosen capture device; "" means the system default. */
  deviceId: Accessor<string>;
  /**
   * Dictionary entries to bias the decode toward. Read at send time, not at
   * provider-construction time, so a word added in Settings applies to the next
   * recording without the composer being rebuilt.
   */
  dictionary: Accessor<readonly string[]>;
  /** Insert recognised text into the composer. */
  onTranscript: (transcript: string) => void;
  /** Non-blocking status line (mic hint, "nothing heard", length cap). */
  onToast: (message: string) => void;
  /** A failure the user must decide about: shows the message + "Use cloud". */
  onFailure: (failure: VoiceLocalFailure) => void;
  /** Weights are missing: open the download consent dialog. */
  onNeedsConsent: () => void;
  /** `asr_manager` is not registered at all: the local option must disappear. */
  onServiceMissing: () => void;
};

export type VoiceCaptureErrorToastKey = string;

/** Capture failure → i18n key. Separate and pure so it can be tested directly. */
export function captureErrorMessageKey(error: unknown): VoiceCaptureErrorToastKey {
  if (!(error instanceof VoiceCaptureError)) return "composer.voice_start_failed";
  switch (error.kind) {
    case "permission_denied":
      return "composer.voice_mic_denied";
    case "no_device":
      return "composer.voice_no_microphone";
    case "sample_rate_unsupported":
      return "composer.voice_local_sample_rate";
    case "unsupported":
      return "composer.voice_local_capture_unsupported";
    default:
      return "composer.voice_audio_capture";
  }
}

/**
 * Assemble one `/transcribe` body. Pure and exported for the same reason
 * `captureErrorMessageKey` is: the alternative is driving a real capture session
 * to find out what went on the wire.
 *
 * `dictionary` is omitted entirely when empty rather than sent as `[]`. Both
 * decode greedy, so this is not about the host's behaviour: it keeps the common
 * request byte-for-byte what it was before the Dictionary existed, so a capture
 * bug cannot be confused with a Dictionary bug when reading a proxy log.
 */
export function buildTranscribeRequest(
  recording: Pick<PcmRecording, "audio">,
  words: readonly string[],
): AsrTranscribeRequest {
  return {
    audio: recording.audio,
    encoding: "pcm_s16le",
    sample_rate: TARGET_SAMPLE_RATE,
    channels: 1,
    // Parakeet is English-only; saying so explicitly means a future
    // multilingual model cannot silently change what this UI requests.
    language: "en",
    ...(words.length > 0 ? { dictionary: [...words] } : {}),
  };
}

/**
 * The three facts that decide whether a transcript is worth a clean-up call.
 * Grouped so the predicate below and the decision below it cannot be given
 * different answers to the same question.
 */
export type RefineContext = {
  /** `/transcribe`'s verdict, or undefined from a service that predates it. */
  gate: AsrRefineGate | undefined;
  /** The user's preference. */
  cleanupEnabled: boolean;
  /** A `/refine` can be reached at all on this install. */
  refineAvailable: boolean;
};

/** What came back from the clean-up attempt, including "we never made one". */
export type RefineAttempt =
  | { kind: "not_attempted" }
  | { kind: "refined"; text: string }
  /** Any failure at all — HTTP, timeout, malformed body. Carries its notice. */
  | { kind: "failed"; messageKey: string };

/** What lands in the composer, and what is said out loud about it. */
export type DictationInsert = {
  /** Text to insert. **Null means insert nothing**, which is not the same as "". */
  insert: string | null;
  /** i18n key for a non-blocking notice; null means stay silent. */
  toastKey: string | null;
};

/**
 * Whether to spend a `/refine` round trip on this transcript. Pure.
 *
 * `empty` is excluded here as well as in {@link decideDictationInsert}: that
 * clip was silence, so there is nothing to polish and no reason to pay a cloud
 * call to find that out. A short-but-audible clip arrives as `asr_only`, which
 * is also excluded — but it keeps its words.
 */
export function shouldRefineTranscript(context: RefineContext): boolean {
  if (!context.cleanupEnabled || !context.refineAvailable) return false;
  // An absent gate is "no opinion" — an older `asr_manager` omits the field
  // entirely, and treating that as a veto would disable the feature silently.
  if (!context.gate) return true;
  return context.gate.action === "refine";
}

/**
 * The whole insertion decision, pure and exported so it can be tested without
 * driving a capture session — the same reason {@link buildTranscribeRequest} is.
 *
 * Two of the branches are the ones that matter:
 *
 *  * **`empty`** inserts NOTHING. The clip was below both amplitude floors, so
 *    whatever the decoder emitted is almost certainly a hallucination, and
 *    inserting it is the single worst outcome of this feature — the user gets
 *    words they never said, in a message they are about to send to an agent.
 *    Only the amplitude rule produces this verdict; a clip that is merely SHORT
 *    arrives as `asr_only` and keeps its text, because a one-second "yes" is a
 *    real dictation and the host cannot tell it from a tap by duration alone.
 *  * **`failed`** inserts the RAW transcript. Clean-up is an improvement on text
 *    the user already produced; losing a dictation because the polish failed
 *    would make the feature worse than not having it.
 */
export function decideDictationInsert(
  context: RefineContext & { rawText: string; attempt: RefineAttempt },
): DictationInsert {
  if (context.gate?.action === "empty") {
    // Reuses the transcribe path's own notice: from the user's side this is the
    // same event — they pressed the microphone and nothing was heard.
    return { insert: null, toastKey: "composer.voice_local_nothing_heard" };
  }
  switch (context.attempt.kind) {
    case "refined":
      return { insert: context.attempt.text, toastKey: null };
    case "failed":
      return { insert: context.rawText, toastKey: context.attempt.messageKey };
    case "not_attempted":
      // Clean-up off, unavailable, or `asr_only`: today's behaviour exactly,
      // and silent — nothing was promised and nothing went wrong.
      return { insert: context.rawText, toastKey: null };
  }
}

export function createLocalVoiceInput(options: LocalVoiceInputOptions) {
  const [listening, setListening] = createSignal(false);
  /** A `/transcribe` is in flight. At most one, ever — the contract requires it. */
  const [transcribing, setTranscribing] = createSignal(false);
  /** The model is being woken/loaded before recording can start. */
  const [preparing, setPreparing] = createSignal(false);

  let recorder: PcmRecorderHandle | null = null;
  let inFlight: AbortController | null = null;
  /** Guards `toggle` against double-invocation while an await is pending. */
  let busy = false;
  /**
   * Bumped by `abort()`. `begin()` captures the value at entry and re-checks it
   * after each await (`confirmMicrophone`, `ensureModelReady`,
   * `startPcmRecording`); a mismatch means `abort()` ran while the start was
   * still pending, so the recorder it was about to open must not be kept.
   * Without this, a `begin()` already past `ensureModelReady` when the composer
   * is hidden mid-recording-start finishes afterward and calls
   * `setListening(true)` with no stop control visible.
   */
  let generation = 0;
  const mic = createMicPresence();

  const send = async (recording: PcmRecording, allowRetry: boolean): Promise<void> => {
    const transcribe = options.transcribe;
    if (!transcribe) {
      options.onFailure({
        kind: "failed",
        messageKey: "composer.voice_local_service_failed",
        offerCloud: true,
        offerRedownload: false,
        code: "no_connection",
      });
      return;
    }

    const controller = new AbortController();
    inFlight = controller;
    setTranscribing(true);
    // Read here, not at construction time, so a word added in Settings applies to
    // the next recording without the composer being rebuilt.
    const body = buildTranscribeRequest(recording, options.dictionary());
    // Which install this dictation belongs to. Read before the first round trip
    // so clean-up can refuse to send the transcript anywhere else.
    const startedOn = options.connection?.();
    try {
      const response = await transcribe(body, controller.signal);
      // An empty transcript is a 200: the user said nothing recognisable. The
      // composer is left exactly as it was and no cloud switch is offered,
      // because nothing failed.
      if (!response.text.trim()) {
        options.onToast(t("composer.voice_local_nothing_heard"));
        return;
      }
      // The optional clean-up pass. Everything about it is decided by the two
      // pure functions above; this block only performs the call.
      //
      // Deliberately inside the same `try` and on the same AbortController as
      // `/transcribe`: `transcribing()` therefore stays true for the whole span
      // (the mic button keeps saying "Transcribing…" instead of looking idle
      // while a cloud call runs), and a user pressing stop mid-clean-up gets the
      // same silence a mid-transcribe stop gives — see the `aborted` guards.
      const context: RefineContext = {
        gate: response.refine_gate,
        cleanupEnabled: options.refineEnabled?.() ?? false,
        // The caller's live availability, ANDed with having a callback at all.
        // `Boolean(options.refine)` alone was not availability: `use-voice-input`
        // always passes a callback, so this was permanently true and the
        // `onRefineUnsupported` latch below could never stop anything — after one
        // 404 or `refine_not_configured`, every later dictation paid the same
        // doomed round trip and showed the same failure notice again.
        refineAvailable: Boolean(options.refine) && (options.refineAvailable?.() ?? true),
      };
      let attempt: RefineAttempt = { kind: "not_attempted" };
      const refine = options.refine;
      if (refine && shouldRefineTranscript(context)) {
        try {
          // Thrown rather than returned early, so it lands in the catch below
          // and degrades exactly as any other clean-up failure does: raw
          // transcript inserted, one notice, no `onRefineUnsupported` latch.
          // The user keeps their words; only the polish is lost, and nothing
          // reaches an install they did not dictate into.
          if (options.connection !== undefined && options.connection() !== startedOn) {
            throw new Error("ServiceHub connection changed mid-dictation");
          }
          // The target is read HERE rather than at provider construction for the
          // reason the dictionary is: a change in Settings has to apply to the
          // next dictation without the composer being rebuilt.
          const refined = await refine(
            { text: response.text, ...(options.refineTarget?.() ?? { mode: "agent" }) },
            controller.signal,
          );
          // Checked on the SUCCESS path too, not only in `catch`. A cancel
          // during the response-body read cannot make this reject: the
          // ServiceHub transport drops its caller-abort listener in the
          // `finally` that runs when the headers arrive, and `await
          // response.text()` happens outside that scope. So a clean-up the user
          // cancelled — or one outstanding across an engine switch — resolves
          // normally, and without this it would insert text into a composer
          // that has moved on.
          if (controller.signal.aborted) return;
          attempt = { kind: "refined", text: refined.text };
        } catch (error) {
          if (controller.signal.aborted) return; // user pressed stop/cancel
          const failure = classifyVoiceRefineError(error);
          // Logged with the code, because the notice the user sees is prose and
          // `refine_upstream_<provider code>` is the part worth grepping for.
          console.warn("[voice-input] the clean-up pass failed:", failure.code, error);
          if (failure.unsupported) options.onRefineUnsupported?.();
          attempt = { kind: "failed", messageKey: failure.messageKey };
        }
      }
      const decision = decideDictationInsert({ ...context, rawText: response.text, attempt });
      // Inserted verbatim: both the decoder and the clean-up model already
      // punctuate and capitalise, and any post-processing here would fight them.
      //
      // Whatever lands here is what the Dictionary's correction loop anchors on,
      // via the composer's `noteTranscriptInserted` — which is why the refined
      // text is passed through this one seam rather than alongside the raw one.
      if (decision.insert !== null) options.onTranscript(decision.insert);
      if (decision.toastKey) options.onToast(t(decision.toastKey));
    } catch (error) {
      if (controller.signal.aborted) return; // user pressed stop/cancel
      const outcome = classifyVoiceLocalError(error);
      switch (outcome.kind) {
        case "nothing_heard":
          options.onToast(t("composer.voice_local_nothing_heard"));
          return;
        case "needs_consent":
          options.onNeedsConsent();
          return;
        case "model_busy":
          options.onToast(t("composer.voice_local_model_busy"));
          return;
        case "service_missing":
          options.onServiceMissing();
          return;
        case "retry_once": {
          // Idle-unload raced us and the service has already kicked a reload.
          // Exactly one retry, and only ever from a fresh recording's first
          // attempt, so a genuinely broken service cannot loop.
          if (!allowRetry) {
            options.onFailure({
              kind: "failed",
              messageKey: "composer.voice_local_failed",
              offerCloud: true,
              offerRedownload: false,
              code: "model_unloaded",
            });
            return;
          }
          options.onToast(t("composer.voice_local_model_busy"));
          await new Promise((resolve) => setTimeout(resolve, outcome.delayMs));
          await send(recording, false);
          return;
        }
        case "failed":
          options.onFailure(outcome);
          return;
      }
    } finally {
      if (inFlight === controller) inFlight = null;
      setTranscribing(false);
    }
  };

  const finish = async (): Promise<void> => {
    const handle = recorder;
    recorder = null;
    setListening(false);
    if (!handle) return;
    const recording = await handle.stop();
    if (recording.truncated) {
      options.onToast(t("composer.voice_local_max_duration"));
    }
    if (recording.sampleCount === 0) {
      options.onToast(t("composer.voice_local_nothing_heard"));
      return;
    }
    await send(recording, true);
  };

  /**
   * Toast a capture failure. A proved-absent microphone is the exception:
   * that sentence stays on the mic button, and the next press asks again.
   *
   * `NotFoundError` / `DevicesNotFoundError` are that proof. `OverconstrainedError`
   * is too, but only from the permission probe: that request is `{ audio: true }`,
   * so a constraint failure means nothing can capture. The recorder also asks
   * for one channel, and a microphone that exists can refuse that without being
   * absent. A saved device id that has disappeared fails the same way and must
   * not mute the machine.
   */
  const reportCaptureFailure = (
    error: unknown,
    deviceId: string | undefined,
    source: "probe" | "recording",
  ) => {
    if (!(error instanceof VoiceCaptureError)) {
      options.onToast(t(captureErrorMessageKey(error)));
      console.warn("[voice-input] microphone request failed:", error);
      return;
    }
    const absent =
      !deviceId &&
      (error.mediaName === "NotFoundError" ||
        error.mediaName === "DevicesNotFoundError" ||
        (source === "probe" && error.mediaName === "OverconstrainedError"));
    if (absent) {
      // The button's own label carries this. A composer toast lands on the
      // chat, away from the control the sentence is about.
      mic.noteAbsent();
      return;
    }
    if (error.kind === "no_device") {
      options.onToast(t("composer.voice_audio_capture"));
      console.warn("[voice-input] microphone request failed:", error.mediaName ?? error.kind, error);
      return;
    }
    options.onToast(t(captureErrorMessageKey(error)));
    console.warn("[voice-input] microphone request failed:", error.mediaName ?? error.kind, error);
  };

  const begin = async (): Promise<void> => {
    const startGeneration = ++generation;
    const epoch = mic.deviceEpoch();
    const deviceId = options.deviceId() || undefined;
    // Drop a latch left by an earlier press. This request is a new question:
    // a permission or capture failure must not keep the old "no microphone"
    // name, and a real absence sets the latch again below.
    mic.notePresent();
    // Ask before waking the model. On a fresh profile this is the call that
    // makes WebView2 show the permission prompt. The model download must not
    // start for a machine that has just been shown to have no microphone.
    try {
      await confirmMicrophone(deviceId);
    } catch (error) {
      if (startGeneration !== generation || epoch !== mic.deviceEpoch()) return;
      reportCaptureFailure(error, deviceId, "probe");
      return;
    }
    // A `devicechange` during the grant must not cancel this press. Chromium
    // fires one when permission makes device labels available.
    if (startGeneration !== generation) return;
    mic.notePresent();

    setPreparing(true);
    let ready = false;
    try {
      ready = await options.ensureModelReady();
    } finally {
      setPreparing(false);
    }
    // ensureModelReady already told the user what is happening (consent dialog,
    // progress, or an error with a "use cloud" button), so stay silent here.
    if (!ready) return;
    // abort() ran while the model-readiness await was pending (e.g. the
    // composer was hidden on a child transcript); do not open the microphone.
    if (startGeneration !== generation) return;

    try {
      const handle = await startPcmRecording({
        deviceId,
        onMaxDurationReached: () => {
          // The recorder stopped accepting audio at the cap; close the session
          // and transcribe what we have instead of pretending to still listen.
          void finish();
        },
      });
      if (startGeneration !== generation) {
        // abort() ran while startPcmRecording was pending; the mic was already
        // acquired, so close it immediately instead of leaving it open with no
        // visible stop control.
        handle.cancel();
        return;
      }
      recorder = handle;
      setListening(true);
    } catch (error) {
      // `devicechange` is not checked here. Granting permission fires one when
      // device labels appear, and that bump must not swallow this press's
      // recorder error. A change during the probe is the stale case, handled
      // above; `abort()` is the generation check.
      if (startGeneration !== generation) return;
      reportCaptureFailure(error, deviceId, "recording");
    }
  };

  /** Drops any recording and cancels an in-flight transcription. */
  const abort = () => {
    // Invalidates any `begin()` still awaiting the permission prompt, model
    // readiness, or the recorder, so it cannot resurrect the microphone once
    // this call has returned.
    generation++;
    const handle = recorder;
    recorder = null;
    setListening(false);
    handle?.cancel();
    inFlight?.abort();
    inFlight = null;
    setTranscribing(false);
  };

  onCleanup(abort);

  return {
    listening,
    transcribing,
    preparing,
    micMissing: mic.micMissing,
    micAbsenceTick: mic.absenceTick,
    abort,
    toggle: () => {
      // Clicks are ignored while a transcription is running: one `/transcribe`
      // in flight at a time is a hard requirement, and the label already says
      // "Transcribing…".
      if (busy || transcribing()) return;
      busy = true;
      // A missing microphone does not skip this. WebView2 withholds
      // `devicechange` until a capture permission exists, so the press is
      // what notices a microphone connected after the last failure.
      void (listening() ? finish() : begin())
        .catch((error: unknown) => {
          console.warn("[voice-input] local provider failed:", error);
          options.onToast(t("composer.voice_start_failed"));
        })
        .finally(() => {
          busy = false;
        });
    },
    buttonLabel: () => {
      if (transcribing()) return t("composer.voice_local_transcribing");
      if (preparing()) return t("composer.voice_local_preparing");
      if (listening()) return t("composer.voice_stop_listening");
      if (mic.micMissing()) return t("composer.voice_no_microphone");
      return t("composer.voice_start");
    },
    /** Exposed for the settings page copy ("stops automatically after 2 min"). */
    maxSeconds: MAX_AUDIO_SECONDS,
  };
}

export type LocalVoiceInput = ReturnType<typeof createLocalVoiceInput>;
