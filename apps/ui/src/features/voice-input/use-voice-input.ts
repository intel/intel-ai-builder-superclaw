/**
 * Voice-input orchestration: mode preference, local-model lifecycle, download
 * consent, hotkey, first-run hint and device list.
 *
 * Structured like `features/tts/useTtsNarration.ts`: the app shell knows nothing
 * about `asr_manager`, it only forwards these accessors and actions down to the
 * composer, the settings page and the consent dialog. The composer's microphone
 * button is built by {@link createVoiceController}, which this hook feeds with a
 * ready-made local-provider factory.
 *
 * The invariant that survives every code path here: **nothing switches the mode
 * to cloud on the user's behalf.** `useCloudInstead` exists, but only a button
 * press reaches it.
 */
import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";

import { t } from "../../i18n";

import { createAsrClient, type AsrClient, type AsrDownloadSnapshot } from "./asr-client";
import {
  downloadPercent as percentFromSnapshot,
  voiceModelStateFromSnapshot,
  type VoiceModelState,
} from "./asr-model-state";
import { createLocalVoiceInput, type VoiceLocalFailure } from "./local-voice-input";
import { listMicrophones } from "./mic-presence";
import { useDictationRefine } from "./use-dictation-refine";
import { useVoiceCorrections } from "./use-voice-corrections";
import type { LocalVoiceInputFactory } from "./voice-controller";
import { classifyVoiceLocalError } from "./voice-error";
import {
  DEFAULT_VOICE_HOTKEYS,
  formatHotkey,
  hotkeyRejectionReason,
  type HotkeyRejection,
  type VoiceHotkey,
} from "./voice-hotkey";
import {
  isVoiceHintDismissed,
  markVoiceHintDismissed,
  readVoiceDeviceId,
  readVoiceHotkeys,
  readVoiceInputMode,
  writeVoiceDeviceId,
  writeVoiceHotkeys,
  writeVoiceInputMode,
  type VoiceInputMode,
} from "./voice-input-prefs";

/** Dialog phases, mirroring the TTS download dialog the user has already seen. */
export type VoiceDownloadPhase = "consent" | "downloading" | "ready" | "error";

/** Poll interval while a download/load is in flight. */
const POLL_INTERVAL_MS = 1_000;

/**
 * Consecutive polling failures tolerated before giving up.
 *
 * The budget is in seconds, not in ticks: a failing `/download/status` can burn
 * its own `ASR_POLL_TIMEOUT_MS` (10 s) before it rejects, and only then does the
 * 1 s gap start. So each tolerated failure costs up to ~11 s, and this count is
 * what the user actually waits with a progress bar that has stopped moving —
 * ~55 s here. (It was 15, documented as "15 s of silence"; the real worst case
 * was ~165 s, nearly three minutes of a frozen bar.)
 */
const MAX_POLL_FAILURES = 5;

/**
 * Consecutive "nothing on disk and nothing running" polls tolerated before the
 * dialog gives up.
 *
 * Polling is entered only after work was supposed to have started (a 202 from
 * `/download`, or a snapshot that said `downloading`/`verifying`). If the
 * service then reports `idle` with `weights_present: false` — a watchdog bounce
 * that lost the download thread, or a download that silently never began — no
 * terminal state will ever arrive: `voiceModelStateFromSnapshot()` returns
 * `not_downloaded`, which is neither `ready` nor `error`, so the dialog would
 * sit at "Downloading the speech model… 0 %" and re-poll at 1 Hz forever.
 *
 * A count rather than an immediate failure, because the contract does not
 * promise `/download` has already flipped the state by the time its 202 lands,
 * so the first tick or two may legitimately still read `idle`.
 */
const MAX_IDLE_POLLS = 10;

/** Upper bound on waiting for weights to load into RAM before a recording. */
const MAX_LOAD_WAIT_MS = 60_000;

/**
 * How long one successful call counts as proof that the on-demand child is up.
 *
 * Past this, the next call pays for a possible cold start again (the contract's
 * 120 s budget). A boolean "already warmed" latch cannot do that: `asr_manager`
 * is `startup: on_demand` with a watchdog, so the child can go away while the
 * window stays open, and the following call would then abort at 10 s and be
 * misreported as a generic local failure instead of waiting out the spawn.
 */
const WARM_TTL_MS = 60_000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type UseVoiceInputOptions = {
  /**
   * Builds the `asr_manager` client. Defaults to the real ServiceHub one; tests
   * substitute a stub so the download/poll/gate ordering can be asserted without
   * a hub, which is the only part of this file a browser is not needed for.
   */
  createClient?: (settings: { baseUrl: string; token: string }) => AsrClient;
  /**
   * Runs when a recording starts, from the mic button or a hotkey. The app uses
   * it to stop read-aloud so narration does not play into the microphone; this
   * slice stays unaware of TTS.
   */
  onRecordingStarted?: () => void;
};

export function useVoiceInput(
  baseUrl: Accessor<string>,
  token: Accessor<string | undefined>,
  /** `feature_flags.voice_input` for the active Profile, already fail-closed. */
  flagEnabled: Accessor<boolean>,
  options?: UseVoiceInputOptions,
) {
  const [mode, setModeSignal] = createSignal<VoiceInputMode>(readVoiceInputMode());
  const [serviceDetected, setServiceDetected] = createSignal(false);
  const [snapshot, setSnapshot] = createSignal<AsrDownloadSnapshot | null>(null);
  const [consentOpen, setConsentOpen] = createSignal(false);
  const [phase, setPhase] = createSignal<VoiceDownloadPhase>("consent");
  const [downloadError, setDownloadError] = createSignal<string | null>(null);
  const [redownloadHelps, setRedownloadHelps] = createSignal(false);
  const [failure, setFailure] = createSignal<VoiceLocalFailure | null>(null);
  const [hotkeys, setHotkeysSignal] = createSignal<VoiceHotkey[]>(readVoiceHotkeys());
  /** Why the last add was refused; cleared by the next successful one. */
  const [hotkeyRejection, setHotkeyRejection] = createSignal<HotkeyRejection | null>(null);
  const [deviceId, setDeviceIdSignal] = createSignal(readVoiceDeviceId());
  const [devices, setDevices] = createSignal<Array<{ deviceId: string; label: string }>>([]);
  const [hintVisible, setHintVisible] = createSignal(false);
  /** Bumped to ask the composer's provider to start recording. */
  const [startRequest, setStartRequest] = createSignal(0);

  let hintDismissed = isVoiceHintDismissed();

  /**
   * Where a non-blocking notice goes. Wired when the composer builds the local
   * provider (it owns the toast surface); a no-op until then.
   */
  let toast: ((message: string) => void) | null = null;
  /**
   * A notice raised before the composer existed. The catalog probe starts as
   * soon as this hook is created, so on a build without `asr_manager` it can
   * answer before the toast surface is wired — and a notice sent into a no-op
   * sink is the silent fallback this is supposed to end.
   */
  let pendingNotice: string | null = null;
  const notify = (message: string) => {
    if (toast) toast(message);
    else pendingNotice = message;
  };

  /**
   * This build/Profile has no `asr_manager`, so the local option disappears and
   * the cloud engine takes over — sanctioned by the plan's Profile-gating rule,
   * unlike a fallback after a local *failure*.
   *
   * It still has to be said out loud, because the user's saved preference says
   * `local` and the engine they get is the cloud one. Two callers reach here:
   * the catalog probe below (the common case — an older build or a Profile
   * without the service, where the local provider is never even consulted) and
   * a `service_not_found` from the proxy (catalog said yes, the route says no).
   * Only the probe used to be silent, which meant the main case never announced
   * itself at all.
   *
   * Once per session, and only in local mode: the catalog does not change while
   * the app is running, and a user on cloud mode had nothing changed on them.
   */
  let serviceMissingAnnounced = false;
  const noteServiceMissing = () => {
    setServiceDetected(false);
    if (mode() !== "local" || serviceMissingAnnounced) return;
    serviceMissingAnnounced = true;
    notify(t("composer.voice_local_service_missing"));
  };

  const buildClient = options?.createClient ?? createAsrClient;
  const client = createMemo(() => {
    const base = baseUrl().trim();
    if (!base) return null;
    return buildClient({ baseUrl: base, token: token() ?? "" });
  });

  /**
   * The local option exists only when BOTH gates agree: the service is
   * registered in this build's catalog AND the Profile allows the feature. Both
   * are fail-closed, so a probe that never answered keeps the cloud engine.
   */
  const localAvailable = createMemo(() => serviceDetected() && flagEnabled());

  /**
   * The Dictionary and the correction-learning loop.
   *
   * `notify` rather than the toast directly, so a word auto-added before the composer
   * exists is still announced through the same pending-notice path everything else
   * here uses.
   *
   * The gate is the same predicate the Dictionary card uses for its own enabled
   * state, and it has to be: the Dictionary only reaches the on-device decoder, so in
   * cloud mode a toast announcing an addition would be pointing at a card that says
   * the Dictionary does not apply and refuses to be edited. Cloud dictations
   * therefore teach nothing rather than filling a list the user cannot act on.
   */
  const corrections = useVoiceCorrections(notify, () => mode() === "local" && localAvailable());

  // The optional LLM clean-up pass — its own hook, documented there. Gated on
  // `localAvailable()`: it runs on `asr_manager`'s own route, so a build without
  // that service has no clean-up either.
  const refinement = useDictationRefine(baseUrl, token, localAvailable);

  const modelState = createMemo<VoiceModelState>(() =>
    voiceModelStateFromSnapshot(snapshot()),
  );
  const percent = createMemo(() => percentFromSnapshot(snapshot()));

  /**
   * When the service last answered. Calls within {@link WARM_TTL_MS} of that may
   * use the short timeout; anything later budgets for an on-demand spawn again.
   */
  let lastContactAt = 0;
  const isWarm = () => lastContactAt > 0 && Date.now() - lastContactAt < WARM_TTL_MS;

  /** Catalog probe. Cheap, does not start the on-demand child. */
  createEffect(() => {
    const asr = client();
    // A new base URL or token is a different (or restarted) hub: whatever was
    // running behind the old one proves nothing about this one.
    lastContactAt = 0;
    if (!asr) {
      setServiceDetected(false);
      return;
    }
    void asr
      .hasAsrService()
      .then((present) => {
        if (present) setServiceDetected(true);
        // Not registered at all: hide the local option AND say so, instead of
        // handing a user who chose on-device recognition the cloud engine in
        // silence. `noteServiceMissing` decides whether it is worth saying.
        else noteServiceMissing();
      })
      .catch(() => noteServiceMissing());
  });

  // ── polling ───────────────────────────────────────────────────────────────

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const stopPolling = () => {
    if (pollTimer) clearTimeout(pollTimer);
    if (closeTimer) clearTimeout(closeTimer);
    pollTimer = null;
    closeTimer = null;
  };

  const fetchSnapshot = async (options?: { cold?: boolean }) => {
    const asr = client();
    if (!asr) throw new Error("no ServiceHub connection");
    try {
      const next = await asr.downloadStatus({ cold: options?.cold ?? !isWarm() });
      lastContactAt = Date.now();
      setSnapshot(next);
      return next;
    } catch (error) {
      // The child going away is one of the reasons a call fails, so the next one
      // must be allowed to wait out a fresh spawn.
      lastContactAt = 0;
      throw error;
    }
  };

  /**
   * The only way into the "Failed" state, so a failure's message and its remedy
   * cannot drift apart.
   *
   * `redownload` answers exactly one question — *would fetching the 630 MB again
   * plausibly fix this?* — and `redownloadHelps()` reports the answer. A
   * failure to **reach** the service answers no: the hub refusing the on-demand
   * spawn, or polling losing contact, says nothing about the weights, and
   * `weights_present` is routinely `true` while it happens. Offering
   * [Retry download] there sends the user off to re-fetch 630 MB that cannot be
   * the problem, and hides the retry that could actually work.
   *
   * `redownloadHelps()` is only meaningful while `phase() === "error"`; every
   * path into that phase goes through here, so it is never read stale.
   */
  const failDownload = (message: string | null, options: { redownload: boolean }) => {
    setDownloadError(message);
    setRedownloadHelps(options.redownload);
    setPhase("error");
  };

  /** Polls `/download/status` until the model settles, driving the dialog. */
  const pollUntilSettled = () => {
    stopPolling();
    let failures = 0;
    let idlePolls = 0;

    const tick = async () => {
      try {
        const next = await fetchSnapshot({ cold: false });
        failures = 0;
        // Reuses the same snapshot→state mapping `modelState()` exposes, so the
        // dialog and every other reader can never disagree about being ready.
        //
        // Notably `weights_present` on its own is NOT ready here: the contract
        // only promises it means "the file is on disk", which is already true
        // while `verifying` is running and while `loading` is in flight. Calling
        // that ready would close this dialog over unfinished work and hide the
        // verify failure that follows.
        const pageState = voiceModelStateFromSnapshot(next);
        if (pageState === "error") {
          // The service's own download/verify failure: the weights on disk are
          // the thing that is wrong, so re-fetching them is the remedy.
          failDownload(next.error || null, { redownload: true });
          return;
        }
        if (pageState === "ready") {
          setPhase("ready");
          // Deliberately does NOT start recording: the plan wants the page to
          // say "Ready" and the user to press the microphone again, so a
          // download they kicked off and walked away from cannot record an
          // empty room.
          closeTimer = setTimeout(() => {
            closeTimer = null;
            setConsentOpen(false);
            setPhase("consent");
          }, 1_500);
          return;
        }
        // `not_downloaded` here means the service is idle with no weights on
        // disk, i.e. the work this dialog is reporting on is not happening. That
        // is a terminal state for the user even though the service calls it
        // `idle`, so it has to end the wait instead of being polled forever.
        if (pageState === "not_downloaded") {
          idlePolls += 1;
          if (idlePolls >= MAX_IDLE_POLLS) {
            // The service is idle with nothing on disk: the download never
            // happened, so asking for it again is precisely the retry.
            failDownload(next.error || t("voice.download_stalled"), { redownload: true });
            return;
          }
        } else {
          idlePolls = 0;
        }
      } catch (error) {
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) {
          // Contact is the thing that broke, not the weights. Re-downloading
          // cannot help when the service cannot be reached to ask.
          failDownload(
            error instanceof Error ? error.message : "Lost contact with the speech service.",
            { redownload: false },
          );
          return;
        }
      }
      pollTimer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    void tick();
  };

  // ── model gate used before every local recording ──────────────────────────

  /**
   * Waits for weights already on disk to become resident. `/prepare` may return
   * while loading is still in progress, so the snapshot is the source of truth.
   */
  const waitForLoad = async (): Promise<boolean> => {
    const deadline = Date.now() + MAX_LOAD_WAIT_MS;
    while (Date.now() < deadline) {
      await delay(POLL_INTERVAL_MS);
      let next: AsrDownloadSnapshot;
      try {
        next = await fetchSnapshot({ cold: false });
      } catch {
        return false;
      }
      if (next.state === "error") return false;
      if (next.model_loaded || next.state === "ready") return true;
    }
    return false;
  };

  const openConsent = () => {
    setDownloadError(null);
    setPhase("consent");
    setConsentOpen(true);
  };

  /**
   * Gate in front of every local recording: resolves true only when the service
   * can transcribe right now. Anything else leaves the user looking at the
   * consent dialog, a progress bar or an error with a "use cloud" button —
   * never at a silent no-op, and never at a cloud recording they did not ask
   * for.
   */
  const ensureModelReady = async (): Promise<boolean> => {
    const asr = client();
    if (!asr) {
      setFailure({
        kind: "failed",
        messageKey: "composer.voice_local_service_failed",
        offerCloud: true,
        offerRedownload: false,
        code: "no_connection",
      });
      return false;
    }

    setFailure(null);
    let current: AsrDownloadSnapshot;
    try {
      // First call of the session also cold-starts the on-demand child, hence
      // the 120 s budget inside the client.
      current = await fetchSnapshot();
    } catch (error) {
      const outcome = classifyVoiceLocalError(error);
      if (outcome.kind === "service_missing") {
        noteServiceMissing();
        return false;
      }
      setFailure(
        outcome.kind === "failed"
          ? outcome
          : {
              kind: "failed",
              messageKey: "composer.voice_local_service_failed",
              offerCloud: true,
              offerRedownload: false,
              code: "status_failed",
            },
      );
      return false;
    }

    if (current.state === "error") {
      setFailure({
        kind: "failed",
        messageKey: "composer.voice_local_model_broken",
        offerCloud: true,
        offerRedownload: true,
        code: "download_error",
      });
      return false;
    }

    // Work already in flight is checked BEFORE `weights_present`, and the order
    // matters: during a download the snapshot is `downloading` with the weights
    // not yet on disk, so asking about consent first would re-ask "Download the
    // speech model?" — with a [Download] button — at a user who is watching that
    // very download. Show them the progress they came for instead.
    if (current.state === "downloading" || current.state === "verifying") {
      // This is the one entry into the dialog that does not go through
      // `openConsent()`, so it has to clear the last attempt's error itself:
      // the dialog renders `error` in a red box regardless of phase, and a user
      // watching a healthy download was being shown "On-device voice input
      // failed." from a download that failed minutes ago.
      setDownloadError(null);
      setPhase("downloading");
      setConsentOpen(true);
      pollUntilSettled();
      return false;
    }

    if (!current.weights_present) {
      // The 630 MB decision. This is the one blocking dialog in the flow.
      openConsent();
      return false;
    }

    if (current.model_loaded) return true;

    // Weights on disk but not resident: load them now rather than after the
    // user has spoken, which would throw away the recording on a 409.
    try {
      const prepared = await asr.prepare();
      setSnapshot(prepared);
      if (prepared.model_loaded || prepared.state === "ready") return true;
    } catch (error) {
      const outcome = classifyVoiceLocalError(error);
      if (outcome.kind === "needs_consent") {
        openConsent();
        return false;
      }
      if (outcome.kind === "failed") {
        setFailure(outcome);
        return false;
      }
    }

    if (await waitForLoad()) return true;
    setFailure({
      kind: "failed",
      messageKey: "composer.voice_local_model_broken",
      offerCloud: true,
      offerRedownload: true,
      code: "load_timeout",
    });
    return false;
  };

  // ── actions ───────────────────────────────────────────────────────────────

  const setMode = (next: VoiceInputMode) => {
    setModeSignal(next);
    writeVoiceInputMode(next);
    if (next === "cloud") setFailure(null);
  };

  const confirmDownload = async () => {
    const asr = client();
    if (!asr) return;
    setDownloadError(null);
    setPhase("downloading");
    try {
      setSnapshot(await asr.startDownload());
      lastContactAt = Date.now();
    } catch (error) {
      lastContactAt = 0;
      const outcome = classifyVoiceLocalError(error);
      // The dialog renders this string verbatim in its error box, so it has to
      // be a sentence, not the wire identifier: `service_start_failed` means
      // nothing to the person who just pressed [Download]. The code still goes
      // to the console, where it is the thing worth grepping for.
      const code = outcome.kind === "failed" ? outcome.code : outcome.kind;
      console.warn("[voice-input] starting the model download failed:", code, error);
      failDownload(
        t(
          outcome.kind === "failed"
            ? outcome.messageKey
            : "composer.voice_local_service_failed",
        ),
        // `service_start_failed` is the common one here and it is a hub problem:
        // the child could not be spawned, so the download never began and the
        // weights are whatever they already were.
        { redownload: outcome.kind === "failed" && outcome.offerRedownload },
      );
      return;
    }
    pollUntilSettled();
  };

  /**
   * Closes the window. What happens to the work behind it depends on the phase,
   * and that difference is the whole point:
   *
   *  * **downloading** — the download keeps running *and keeps being polled*, so
   *    the progress a later microphone click reopens is current and the terminal
   *    state still arrives. This is what the dialog's own copy promises ("You can
   *    keep working. Click the microphone again to see progress."), which was a
   *    lie while the modal had no exit but [Use cloud instead] — a button that
   *    changes the engine the user deliberately chose.
   *  * **consent / ready / error** — nothing is in flight, so drop the poll
   *    timers and the error with the episode they belong to. Keeping the error
   *    would resurface it on top of the next attempt's progress.
   */
  const dismissConsent = () => {
    if (phase() === "downloading") {
      setConsentOpen(false);
      return;
    }
    stopPolling();
    setConsentOpen(false);
    setPhase("consent");
    setDownloadError(null);
  };

  /**
   * The consent dialog's second button, and the button attached to every local
   * failure. Switches the mode and starts recording straight away, which is the
   * pre-upgrade behaviour the user is asking for — including the cloud notice,
   * which the browser provider still emits on every start.
   */
  const useCloudInstead = () => {
    stopPolling();
    setConsentOpen(false);
    setPhase("consent");
    setDownloadError(null);
    setFailure(null);
    setMode("cloud");
    setStartRequest((n) => n + 1);
  };

  /** Retry after a failed/corrupt download: the service re-fetches and re-verifies. */
  const retryDownload = () => {
    setFailure(null);
    openConsent();
    setPhase("downloading");
    void confirmDownload();
  };

  const commitHotkeys = (next: VoiceHotkey[]) => {
    setHotkeysSignal(next);
    writeVoiceHotkeys(next);
  };

  /**
   * Add one binding. Returns whether it landed, so the capture field can stay
   * open on a refusal — the reason is useless once the field has closed.
   */
  const addHotkey = (candidate: VoiceHotkey): boolean => {
    const rejection = hotkeyRejectionReason(candidate, hotkeys());
    setHotkeyRejection(rejection);
    if (rejection) return false;
    commitHotkeys([...hotkeys(), candidate]);
    return true;
  };

  // An empty list is a legitimate end state ("no shortcut"), so nothing is
  // re-seeded here; [Reset to default] is how the user gets the default back.
  const removeHotkey = (index: number) => {
    setHotkeyRejection(null);
    commitHotkeys(hotkeys().filter((_, position) => position !== index));
  };

  const resetHotkeys = () => {
    setHotkeyRejection(null);
    commitHotkeys([...DEFAULT_VOICE_HOTKEYS]);
  };

  const setDeviceId = (next: string) => {
    setDeviceIdSignal(next);
    writeVoiceDeviceId(next);
  };

  const refreshDevices = async () => {
    const list = await listMicrophones();
    setDevices(list);
    // A device that disappeared must not stay selected, or every recording
    // would fail with an OverconstrainedError the user cannot explain.
    if (deviceId() && !list.some((device) => device.deviceId === deviceId())) {
      setDeviceId("");
    }
  };

  const noteRecordingStarted = () => {
    options?.onRecordingStarted?.();
    if (hintDismissed) return;
    setHintVisible(true);
  };

  const dismissHint = () => {
    hintDismissed = true;
    setHintVisible(false);
    markVoiceHintDismissed();
  };

  /** Hides the bubble for now without spending the one-time "got it". */
  const hideHint = () => setHintVisible(false);

  const createLocalProvider: LocalVoiceInputFactory = (providerOptions) => {
    toast = providerOptions.onToast;
    // A notice the catalog probe raised before this surface existed. Deferred a
    // microtask so it is not delivered in the middle of the composer's setup.
    if (pendingNotice !== null) {
      const message = pendingNotice;
      pendingNotice = null;
      queueMicrotask(() => toast?.(message));
    }
    return createLocalVoiceInput({
      ...providerOptions,
      ensureModelReady,
      transcribe: (body, signal) => {
        const asr = client();
        if (!asr) return Promise.reject(new Error("no ServiceHub connection"));
        return asr.transcribe(body, signal);
      },
      refine: (body, signal) => {
        const asr = client();
        if (!asr) return Promise.reject(new Error("no ServiceHub connection"));
        return asr.refine(body, signal);
      },
      // The two calls above each resolve `client()` for themselves, so a
      // connection change between them would hand install A's transcript to
      // install B. The provider captures this when the recording is sent and
      // re-reads it before clean-up; see `connection` on its options.
      connection: client,
      refineEnabled: refinement.refineEnabled,
      refineAvailable: refinement.refineAvailable, // so the latch below stops the calls
      // The effective mode and model, not the stored ones: a `preset` preference
      // with no OpenRouter key behind it is served by the agent model instead.
      refineTarget: refinement.refineTarget,
      onRefineUnsupported: refinement.noteRefineUnsupported,
      deviceId,
      dictionary: corrections.dictionary,
      onFailure: setFailure,
      onNeedsConsent: openConsent,
      onServiceMissing: noteServiceMissing,
    });
  };

  onCleanup(stopPolling);

  return {
    // state
    mode,
    localAvailable,
    serviceDetected,
    snapshot,
    modelState,
    downloadPercent: percent,
    consentOpen,
    downloadPhase: phase,
    downloadError,
    redownloadHelps,
    failure,
    hotkeys,
    hotkeyRejection,
    /**
     * The *first* binding only. The composer tooltip and the first-run bubble
     * render this into a single `<kbd>`; a list of four would not fit either, and
     * Settings is where the full list belongs.
     */
    hotkeyLabel: () => {
      const first = hotkeys()[0];
      return first ? formatHotkey(first) : "";
    },
    devices,
    deviceId,
    /**
     * The Dictionary, spread flat onto the controller so its consumers — the card,
     * the composer and the local provider — do not have to know it lives in a
     * separate hook. `useVoiceCorrections` is where the behaviour is documented.
     */
    ...corrections,
    /** The clean-up pass, spread flat for the same reason the Dictionary is. */
    ...refinement,
    hintVisible,
    startRequest,
    // actions
    setMode,
    confirmDownload,
    dismissConsent,
    useCloudInstead,
    retryDownload,
    clearFailure: () => setFailure(null),
    addHotkey,
    removeHotkey,
    resetHotkeys,
    /**
     * Cancelling or reopening the capture field drops the previous reason. Unlike
     * the Dictionary's, this rejection sits next to a control the user can back
     * out of, and a stale "already bound" under a fresh, empty field reads as a
     * complaint about a keystroke that has not happened yet.
     */
    clearHotkeyRejection: () => setHotkeyRejection(null),
    setDeviceId,
    refreshDevices,
    /**
     * Re-read the service's status. A successful check supersedes the previous
     * attempt's failure: {@link downloadError} carries hub-side failures that
     * never appear in the snapshot, so leaving it set would keep reporting
     * "Failed" over a snapshot that now says otherwise. Left alone while the
     * dialog is open, which owns the error it is displaying.
     */
    refreshStatus: async () => {
      let next: AsrDownloadSnapshot;
      try {
        next = await fetchSnapshot();
      } catch (error) {
        const outcome = classifyVoiceLocalError(error);
        if (outcome.kind === "service_missing") {
          noteServiceMissing();
          return null;
        }
        // Transient by definition — the child is still waking, or a load is in
        // flight. The next check answers it; painting "Failed" over it would be
        // a lie with a retry button attached.
        if (outcome.kind !== "failed") return null;
        // Reporting this is the entire point of the button. It used to be
        // `.catch(() => null)`, so a check that could not reach the service left
        // the card byte-for-byte as it was: no error, no state change, nothing.
        // Pressing [Check status] against a service that will not start was
        // indistinguishable from pressing a dead control — and a status check is
        // the one place where "I asked and this is what came back" is the whole
        // value of the interaction.
        console.warn("[voice-input] the status check failed:", outcome.code, error);
        failDownload(t(outcome.messageKey), { redownload: outcome.offerRedownload });
        return null;
      }
      if (next.state !== "error" && phase() === "error" && !consentOpen()) {
        setDownloadError(null);
        setPhase("consent");
      }
      return next;
    },
    /**
     * The pre-recording gate the local provider runs. Returned so the ordering
     * it encodes (in-flight download before consent, load before capture) is
     * testable on its own; nothing in the app calls it directly.
     */
    ensureModelReady,
    noteRecordingStarted,
    dismissHint,
    hideHint,
    createLocalProvider,
  };
}

export type VoiceInputController = ReturnType<typeof useVoiceInput>;
