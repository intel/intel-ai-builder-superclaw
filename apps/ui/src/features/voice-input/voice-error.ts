/**
 * Maps a failed local-mode call onto what the UI does about it.
 *
 * Two rules from the plan are encoded here and nowhere else:
 *
 *  1. **Local failure never falls back to cloud by itself.** Every failing
 *     outcome carries `offerCloud`, i.e. "render a button the user presses",
 *     never "switch the engine". The user chose local to keep audio off the
 *     network; changing that silently defeats the choice.
 *  2. **Switch on `.code`, never on `.message`.** `requestServiceHubJson`
 *     surfaces the hub/service error envelope as `ServiceHubHttpError` with a
 *     stable snake_case `code`; messages are human prose and change freely.
 */
import { ServiceHubHttpError } from "~/shared/platform/transport/servicehub";

export type VoiceLocalOutcome =
  /**
   * Nothing was heard. A SUCCESS shape, not a failure: silence produces
   * `200 {"text": ""}`, and `400 empty_audio` means the same thing. The
   * composer is left untouched and no cloud switch is offered.
   */
  | { kind: "nothing_heard" }
  /** Weights absent — show the 630 MB consent dialog ([Download] [Use cloud]). */
  | { kind: "needs_consent" }
  /** Download/verify/load in flight, or the child is still waking up. */
  | { kind: "model_busy" }
  /**
   * Idle-unload raced this request and a reload was kicked. Retry exactly once
   * after the given delay, then surface it as a failure.
   */
  | { kind: "retry_once"; delayMs: number }
  /** No service registered for `/speech-to-text`: hide the local option. */
  | { kind: "service_missing" }
  | {
      kind: "failed";
      /** i18n key of the message to show. */
      messageKey: string;
      /** Render an explicit "Use cloud instead" button. Never auto-switch. */
      offerCloud: boolean;
      /** Corrupt/truncated weights: offer "Download again" instead of a retry. */
      offerRedownload: boolean;
      /** Raw code (or "" when the failure carried none) for logs. */
      code: string;
    };

const failed = (
  messageKey: string,
  code: string,
  options?: { offerCloud?: boolean; offerRedownload?: boolean },
): VoiceLocalOutcome => ({
  kind: "failed",
  messageKey,
  offerCloud: options?.offerCloud ?? true,
  offerRedownload: options?.offerRedownload ?? false,
  code,
});

/**
 * Classifies an error thrown by {@link import("./asr-client").AsrClient}.
 *
 * Codes come from two sources the UI must not conflate: `asr_manager` itself
 * (model/audio problems) and ServiceHub (spawn/proxy problems). Both are listed
 * in the stage-0 contract; anything unrecognised is reported as a generic
 * failure rather than being swallowed.
 */
export function classifyVoiceLocalError(error: unknown): VoiceLocalOutcome {
  if (!(error instanceof ServiceHubHttpError)) {
    // Aborts are the user's own stop/cancel and are handled by the caller.
    return failed("composer.voice_local_failed", "");
  }

  switch (error.code) {
    // ── asr_manager ────────────────────────────────────────────────────────
    case "model_not_downloaded":
      return { kind: "needs_consent" };
    case "model_loading":
      return { kind: "model_busy" };
    case "model_load_failed":
      // Do NOT auto-retry: every attempt rebuilds and re-fails the ORT session.
      return failed("composer.voice_local_model_broken", error.code, {
        offerRedownload: true,
      });
    case "model_unloaded":
      return { kind: "retry_once", delayMs: 2_000 };
    case "empty_audio":
      return { kind: "nothing_heard" };
    case "audio_too_long":
      return failed("composer.voice_local_too_long", error.code, { offerCloud: false });
    case "unsupported_language":
      return failed("composer.voice_local_english_only", error.code);
    case "transcribe_failed":
      return failed("composer.voice_local_failed", error.code);
    // Client bugs: the UI built a request the service refuses. Surfaced as a
    // generic failure and logged, because there is nothing the user can fix.
    case "invalid_request":
    case "unsupported_encoding":
    case "unsupported_sample_rate":
    case "unsupported_channels":
      return failed("composer.voice_local_failed", error.code);

    // ── ServiceHub ─────────────────────────────────────────────────────────
    case "service_start_failed":
    case "service_unavailable":
      return failed("composer.voice_local_service_failed", error.code);
    case "service_dormant":
      // Not an error: only `/health` and `/version` can produce it, and it just
      // means "not running yet". `/download/status` is what starts the child.
      return { kind: "model_busy" };
    case "service_not_found":
      return { kind: "service_missing" };
    case "gateway_timeout":
      return failed("composer.voice_local_timeout", error.code);
    case "request_too_large":
      // Unreachable if the recorder's 120 s cap worked; still explain it.
      return failed("composer.voice_local_too_long", error.code, { offerCloud: false });
    case "upstream_error":
      // A non-conforming error body leaked through the hub's normalizer, so the
      // real reason was destroyed upstream. Log loudly: this is a service bug.
      console.warn(
        "[voice-input] asr_manager returned a non-conforming error envelope; " +
          "the reason was replaced by the hub normalizer",
      );
      return failed("composer.voice_local_failed", error.code);
    default:
      if (error.status === 404) return { kind: "service_missing" };
      return failed("composer.voice_local_failed", error.code ?? "");
  }
}

/**
 * What a failed `/refine` does to the UI.
 *
 * Not a {@link VoiceLocalOutcome}, and that is the point: every value of this
 * type ends with the raw transcript in the composer. Clean-up is an optional
 * improvement on text the user already has, so its failure is a **degradation**
 * with a one-line notice, never a blocking failure bubble with a [Use cloud
 * instead] button — the dictation did not fail and switching the recognition
 * engine would not have helped.
 */
export type VoiceRefineFailure = {
  /** i18n key for the non-blocking notice. */
  messageKey: string;
  /**
   * This install cannot clean up at all — no inference key reached
   * `asr_manager`, or the service predates the route. The caller latches
   * clean-up off rather than paying a doomed round trip per dictation, which is
   * what the user would otherwise feel as "dictation got slower for no reason".
   */
  unsupported: boolean;
  /** Raw code (or "" when the failure carried none) for logs. */
  code: string;
};

/**
 * Classifies an error thrown by `AsrClient.refine`.
 *
 * Same rule 2 as above — switch on `.code`, never on `.message`. The service
 * carries LLMRouter's own code through under a `refine_` prefix, so "nothing is
 * configured to serve this" stays distinguishable from "the provider failed";
 * anything it could not name arrives as `refine_upstream` or
 * `refine_upstream_<code>`, which is why the unrecognised case is a `default`
 * and not an exhaustive list.
 */
export function classifyVoiceRefineError(error: unknown): VoiceRefineFailure {
  if (!(error instanceof ServiceHubHttpError)) {
    return { messageKey: "voice.refine_toast_failed", unsupported: false, code: "" };
  }

  switch (error.code) {
    case "refine_not_configured":
      // The one failure that is a property of the install rather than of this
      // attempt: nothing upstream is wired, and the next dictation would fail
      // identically.
      return { messageKey: "voice.refine_toast_unavailable", unsupported: true, code: error.code };
    case "refine_host_key_missing":
      // A property of ONE MODE, not of the install — so `unsupported` stays
      // false and the latch is not set.
      //
      // The host-only credential is required by the pinned route alone, i.e. by
      // `preset` mode. `agent` and `local` go to the alias route, which takes
      // the shared key this install already has, so they keep working. Latching
      // here would let a single preset attempt disable them both — and losing
      // the on-device mode, which needs no cloud credential at all, because a
      // cloud credential was not granted is precisely backwards.
      return {
        messageKey: "voice.refine_toast_host_key_missing",
        unsupported: false,
        code: error.code,
      };
    case "refine_no_model":
      // LLMRouter has nothing to route to. Actionable by the user, so it gets
      // its own sentence instead of a generic "clean-up failed".
      return { messageKey: "voice.refine_toast_no_model", unsupported: false, code: error.code };
    case "refine_not_on_device":
      // Per-request, not per-install: activating a local model fixes it, so no latch.
      return {
        messageKey: "voice.refine_toast_not_on_device",
        unsupported: false,
        code: error.code,
      };
    case "refine_timeout":
    case "gateway_timeout":
      return { messageKey: "voice.refine_toast_timeout", unsupported: false, code: error.code };
    case "service_not_found":
      // The `/speech-to-text` route is gone entirely. Transcription will report
      // that on its own; here it only means "stop asking for clean-up".
      return { messageKey: "voice.refine_toast_unavailable", unsupported: true, code: error.code };
    default:
      // A 404 from a service that IS registered means this build's
      // `asr_manager` has no `/refine`. Same remedy as above: stop asking.
      if (error.status === 404) {
        return {
          messageKey: "voice.refine_toast_unavailable",
          unsupported: true,
          code: error.code ?? "",
        };
      }
      return {
        messageKey: "voice.refine_toast_failed",
        unsupported: false,
        code: error.code ?? "",
      };
  }
}
