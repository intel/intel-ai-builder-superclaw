/**
 * Typed client for `asr_manager` (`/speech-to-text/v1/*`) through ServiceHub.
 *
 * Everything goes through the shared `requestServiceHubJson` helper — no new
 * transport. That helper always sends `Content-Type: application/json` and
 * `JSON.stringify`s the body, which is why `/transcribe` carries base64 audio
 * in a JSON field instead of raw bytes: sending octet-stream would mean editing
 * the shared transport module, a cross-PR change.
 *
 * Timeouts are passed explicitly on every call. The shared default is 10 s,
 * which is shorter than both the on-demand spawn budget (`ready_timeout_s` is
 * 120) and the hub's own 30 s upstream read timeout, so relying on it would
 * turn server-side waits into client-side `AbortError`s and misattribute them.
 */
import {
  requestServiceHubJson,
  type ServiceHubRequestOptions,
} from "~/shared/platform/transport/servicehub";

import type { DictationRefineMode } from "./voice-input-prefs";

/** Service name as it appears in `GET /app/services/catalog`. */
export const ASR_SERVICE_NAME = "asr_manager";

/** Proxy prefix registered in `servicehub/service_cfg.json`. */
export const ASR_PREFIX = "/speech-to-text/v1";

/**
 * Cold-start budget. `GET /download/status`, `POST /download` and
 * `POST /prepare` may each trigger the on-demand spawn, whose `ready_timeout_s`
 * is 120 s.
 */
export const ASR_COLD_TIMEOUT_MS = 120_000;

/** Polling budget once the child is known to be up. */
export const ASR_POLL_TIMEOUT_MS = 10_000;

/**
 * Transcribe budget. Deliberately larger than the hub's hard-coded 30 s
 * upstream read timeout so the user sees the hub's 504 `gateway_timeout`
 * instead of a client abort that would be blamed on the network.
 */
export const ASR_TRANSCRIBE_TIMEOUT_MS = 45_000;

/**
 * Clean-up budget, for the same reason as the one above: larger than the hub's
 * hard-coded 30 s upstream read timeout, so a slow cloud model surfaces as the
 * hub's 504 `gateway_timeout` rather than as a client abort the user would read
 * as a network fault.
 *
 * `asr_manager` gives its own upstream call 20 s (`refine/client.py`), so a
 * healthy clean-up never approaches either number; this only decides *who*
 * reports a pathological one.
 */
export const ASR_REFINE_TIMEOUT_MS = 45_000;

export type AsrDownloadState =
  | "idle"
  | "downloading"
  | "verifying"
  | "loading"
  | "ready"
  | "error";

/** `GET /speech-to-text/v1/download/status` snapshot. */
export type AsrDownloadSnapshot = {
  state: AsrDownloadState;
  done_bytes: number;
  total_bytes: number;
  source: string | null;
  error: string | null;
  model_loaded: boolean;
  /**
   * Whether the weights are on disk. An addition over `tts_manager`'s snapshot:
   * `/health` is the one endpoint that does NOT cold-start the child, so on a
   * dormant service it answers `service_dormant` and cannot distinguish "never
   * downloaded" from "not running". With this field the UI needs exactly one
   * polling endpoint.
   */
  weights_present: boolean;
};

/** `POST /speech-to-text/v1/transcribe` request body. */
export type AsrTranscribeRequest = {
  /** base64 (standard alphabet, padded) of the raw audio bytes. */
  audio: string;
  encoding: "pcm_s16le" | "wav";
  /** Must be exactly 16000; the service rejects anything else. */
  sample_rate: number;
  /** Must be exactly 1. */
  channels: number;
  language?: "en";
  /**
   * Dictionary entries (names, project names, jargon) the contextual beam biases
   * toward. Omit — do not send `[]` — when the user has none; both decode greedy,
   * and an absent field keeps the ordinary request unchanged from before the
   * Dictionary existed.
   *
   * The host validates this: a non-array, a non-string entry, more than 250
   * entries or an entry over 100 characters is a 400, not a silent drop. See
   * `features/voice-input/voice-dictionary.ts`, which enforces the same two limits
   * on this side so the user cannot build a list the host will refuse.
   */
  dictionary?: string[];
};

/**
 * What `/transcribe` thinks of this clip as clean-up material.
 *
 * The two audio-derived rules (a clip at least 1 s long; peak above 0.02 or RMS
 * above 0.005) can only be evaluated where the decoded samples are, which is
 * inside `/transcribe` — so the verdict rides home on its response instead of
 * the UI re-deriving it. Nothing here needs `pcm-capture` to measure anything.
 */
export type AsrRefineGate = {
  /** `refine` — worth polishing. `asr_only` — insert as dictated. `empty` — silence. */
  action: "refine" | "asr_only" | "empty";
  /** Human-readable reason, for logs and bug reports. Never rendered verbatim. */
  reason: string;
};

/** `POST /speech-to-text/v1/transcribe` 200 response. */
export type AsrTranscribeResponse = {
  /** The only field the UI consumes. Already punctuated — never post-process. */
  text: string;
  language: string;
  audio_seconds: number;
  transcribe_seconds: number;
  rtf: number;
  model: string;
  decode: string;
  /**
   * Optional on purpose: an `asr_manager` that predates LLM clean-up omits it
   * entirely, and an absent gate is "no opinion", not "do not refine". Treating
   * absence as a veto would silently disable the feature against an older
   * service instead of letting `/refine` answer for itself.
   */
  refine_gate?: AsrRefineGate;
};

/** `POST /speech-to-text/v1/refine` request body. */
export type AsrRefineRequest = {
  /** The raw transcript. The service caps this at 20 000 characters. */
  text: string;
  /** Which model serves the pass; see `DictationRefineMode`. */
  mode: DictationRefineMode;
};
/*
 * NO `model` FIELD, AND THAT IS THE SECURITY PROPERTY RATHER THAN tidiness.
 *
 * It used to carry the user's pick for `preset` mode. `asr_manager` binds
 * `127.0.0.1:18829` and holds `LRM_HOST_API_KEY` — the credential granted to
 * it alone to keep agent-authored code off LRM's pinned route — so that field
 * was an arbitrary-model spend against the user's key, reachable by anything
 * on the machine with no `Authorization` header at all. The port now requires
 * the process credential only ServiceHub holds (#3351); the field stays gone
 * as defence in depth.
 *
 * The clean-up model is now host-side state, set through
 * `PUT /speech-to-text/v1/refine/preference`. `/refine` REFUSES a body that
 * carries `model` (400 `model_not_accepted`) rather than ignoring it, so a
 * client that still believes it is choosing finds out.
 */

/** `GET`/`PUT /speech-to-text/v1/refine/preference` 200 response. */
export type AsrRefinePreference = {
  /** The stored clean-up model, or the dictation default when nothing is saved. */
  model: string;
  /** The default the service falls back to, so the UI need not hardcode it. */
  default: string;
};

/** `POST /speech-to-text/v1/refine` 200 response. */
export type AsrRefineResponse = {
  /** The text to insert. Equal to the request's `text` when `refined` is false. */
  text: string;
  /**
   * Whether a model actually ran. False is a legitimate 200: the service's own
   * length rule declined to spend a round trip on a three-character utterance,
   * which is not the same answer as "the model returned it unchanged".
   */
  refined: boolean;
  reason: string;
  /** Empty when no model ran. */
  model: string;
  prompt_id: string;
  /** Endpoint that served the request, when the provider names one. */
  served_by: string;
};

/**
 * Whether a model's chain-of-thought can be switched off.
 *
 * `unknown` is a real answer, not a failure: the service keeps one table of the
 * providers it has characterised, and a model missing from it is a model nobody
 * has measured. Treating that as "probably reasons" would warn about models with
 * no evidence against them.
 */
export type AsrReasoningSupport = "yes" | "no" | "unknown";

/** `GET /speech-to-text/v1/refine/model` 200 response. */
export type AsrRefineModelInfo = {
  provider: string;
  model: string;
  reasoning_support: AsrReasoningSupport;
  /**
   * The model to offer instead when `reasoning_support` is `"no"`. Read from the
   * response rather than hardcoded, so changing which model serves the dedicated
   * route does not need a matching UI edit.
   */
  recommended: { provider: string; model: string };
};

type CatalogResponse = { services?: Array<{ name?: string }> };

export type AsrClient = ReturnType<typeof createAsrClient>;

export function createAsrClient(settings: { baseUrl: string; token: string }) {
  const baseUrl = settings.baseUrl.replace(/\/+$/, "");
  const token = settings.token.trim();

  const request = <T>(path: string, options: ServiceHubRequestOptions) =>
    requestServiceHubJson<T>(baseUrl, path, token, options);

  return {
    baseUrl,

    /**
     * Whether this build/Profile registers `asr_manager` at all. Read before
     * anything else: a 404 `service_not_found` from `/speech-to-text` means the
     * local option must be hidden, not retried.
     */
    async hasAsrService(): Promise<boolean> {
      const catalog = await request<CatalogResponse>("/app/services/catalog", {
        timeoutMs: ASR_POLL_TIMEOUT_MS,
      });
      return catalog.services?.some((service) => service.name === ASR_SERVICE_NAME) ?? false;
    },

    /**
     * Progress snapshot. This is also the wake-up call: `/health` is
     * whitelisted out of `ensure_started`, so it can never start the child.
     *
     * @param cold pass true for the first call after the app (re)connects, so
     *   the timeout covers an on-demand spawn instead of failing at 10 s.
     */
    downloadStatus(options?: { cold?: boolean; signal?: AbortSignal }) {
      return request<AsrDownloadSnapshot>(`${ASR_PREFIX}/download/status`, {
        timeoutMs: options?.cold ? ASR_COLD_TIMEOUT_MS : ASR_POLL_TIMEOUT_MS,
        signal: options?.signal,
      });
    },

    /** Consent-gated ~630 MB fetch. 202 + snapshot; never blocks on the download. */
    startDownload() {
      return request<AsrDownloadSnapshot>(`${ASR_PREFIX}/download`, {
        method: "POST",
        timeoutMs: ASR_COLD_TIMEOUT_MS,
      });
    },

    /**
     * Loads already-present weights into RAM. Also the activity ping that
     * resets the service's idle-unload timer.
     */
    prepare() {
      return request<AsrDownloadSnapshot>(`${ASR_PREFIX}/prepare`, {
        method: "POST",
        timeoutMs: ASR_COLD_TIMEOUT_MS,
      });
    },

    transcribe(body: AsrTranscribeRequest, signal?: AbortSignal) {
      return request<AsrTranscribeResponse>(`${ASR_PREFIX}/transcribe`, {
        method: "POST",
        body,
        timeoutMs: ASR_TRANSCRIBE_TIMEOUT_MS,
        signal,
      });
    },

    /**
     * Optional clean-up pass over a transcript the decoder already produced.
     *
     * A second request rather than a flag on `/transcribe`, because that is what
     * keeps a slow or dead cloud endpoint from delaying — or losing — text the
     * on-device recogniser has already finished.
     */
    refine(body: AsrRefineRequest, signal?: AbortSignal) {
      return request<AsrRefineResponse>(`${ASR_PREFIX}/refine`, {
        method: "POST",
        body,
        timeoutMs: ASR_REFINE_TIMEOUT_MS,
        signal,
      });
    },

    /**
     * Whether a model's reasoning can be turned off, asked before the user ever
     * dictates.
     *
     * The table lives on the host so there is exactly one copy of it; a
     * TypeScript duplicate would drift the first time either side was edited
     * alone. Omit `target` to have the service describe its own dedicated model.
     *
     * Polling-length timeout, not the clean-up one: this is a table lookup with
     * no upstream call behind it, and the only caller is a settings-page probe
     * whose answer nothing is blocked on.
     */
    /**
     * The clean-up model the dictation path will actually use.
     *
     * Read from the host rather than from `localStorage`: the value on screen
     * has to be the value that will really be sent, and a renderer-held copy
     * could disagree with the file the service reads.
     */
    refinePreference(signal?: AbortSignal) {
      return request<AsrRefinePreference>(`${ASR_PREFIX}/refine/preference`, {
        timeoutMs: ASR_POLL_TIMEOUT_MS,
        signal,
      });
    },

    /**
     * Set the clean-up model. The ONLY way in — `/refine` refuses one in its
     * body. Returns the stored form, which is what the picker should show: the
     * host trims and validates, and showing the sent value rather than the typed
     * one is what keeps the picker from looking like it forgot the choice.
     */
    setRefinePreference(model: string, signal?: AbortSignal) {
      return request<AsrRefinePreference>(`${ASR_PREFIX}/refine/preference`, {
        method: "PUT",
        body: { model },
        timeoutMs: ASR_POLL_TIMEOUT_MS,
        signal,
      });
    },

    refineModel(target?: { provider: string; model: string }, signal?: AbortSignal) {
      const query = target
        ? `?provider=${encodeURIComponent(target.provider)}&model=${encodeURIComponent(target.model)}`
        : "";
      return request<AsrRefineModelInfo>(`${ASR_PREFIX}/refine/model${query}`, {
        timeoutMs: ASR_POLL_TIMEOUT_MS,
        signal,
      });
    },
  };
}
