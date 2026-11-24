import { createEffect, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js"
import { TtsNarrator } from "~/shared/platform/tts-narrator"
import { resolveServiceHubFetch } from "~/shared/platform/transport/servicehub"
import { isVisibleTextPart } from "~/shared/util/part-visibility"
import type { MessageWithParts } from "~/shared/types/session"
import { readReadAloudVoice } from "./tts-voice-prefs"

type TtsState = "idle" | "checking" | "downloading" | "ready" | "error";
type TtsDownloadPhase = "consent" | "downloading" | "ready";

/**
 * Which message the speaker button is acting on. `starting` covers the cold
 * start (on-demand `tts_manager` spawn plus model load, several seconds after a
 * restart), so the button responds the moment it is clicked.
 */
export type ReadAloudState = { messageId: string; phase: "starting" | "speaking" };

/** The auto-narration toggle; `starting` is the same cold start as above. */
export type NarrationState = "off" | "starting" | "on";

const messageIdFromInfo = (message: MessageWithParts) => {
  const id = (message.info as { id?: string | number }).id;
  if (typeof id === "string") return id;
  if (typeof id === "number") return String(id);
  return "";
};

// TTS orchestration
// The UI shell does not know the download gate or narration lifecycle; it only
// consumes the ready/available signals and the actions from this hook. The
// reusable speech engine lives in ~/shared/platform/tts-narrator.
export function useTtsNarration(
  baseUrl: Accessor<string>,
  token: Accessor<string | undefined>,
  activeMessages: Accessor<MessageWithParts[]>,
) {
  const [available, setAvailable] = createSignal(false);
  const [narrationOn, setNarrationOn] = createSignal(false);
  const [narrationStarting, setNarrationStarting] = createSignal(false);
  const [speaking, setSpeaking] = createSignal(false);
  const [speakingMessageId, setSpeakingMessageId] = createSignal<string | null>(null);
  const [startingMessageId, setStartingMessageId] = createSignal<string | null>(null);
  const [state, setState] = createSignal<TtsState>("idle");
  const [downloadOpen, setDownloadOpen] = createSignal(false);
  const [downloadPhase, setDownloadPhase] = createSignal<TtsDownloadPhase>("consent");
  const [downloadProgress, setDownloadProgress] = createSignal(0);
  const [downloadTotal, setDownloadTotal] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);

  const ttsFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> =
    (input, init) => resolveServiceHubFetch()(input, init);

  const ttsBase = () => baseUrl().replace(/\/+$/, "");
  const ttsHeaders = (): Record<string, string> => {
    const value = token();
    return value ? { Authorization: `Bearer ${value}` } : {};
  };

  let ttsPollTimer: ReturnType<typeof setTimeout> | null = null;
  let ttsReadyTimer: ReturnType<typeof setTimeout> | null = null;
  let ttsPendingReady: (() => void) | null = null;

  const stopTtsPoll = () => {
    if (ttsPollTimer) {
      clearTimeout(ttsPollTimer);
      ttsPollTimer = null;
    }
    if (ttsReadyTimer) {
      clearTimeout(ttsReadyTimer);
      ttsReadyTimer = null;
    }
  };

  const ttsNarrator = new TtsNarrator({
    getBaseUrl: ttsBase,
    getToken: token,
    getVoice: readReadAloudVoice,
    onStateChange: (nextState) => setSpeaking(nextState.speaking),
    onError: (message) => console.warn("[tts-narrator]", message),
  });

  const onDemandNarrator = new TtsNarrator({
    getBaseUrl: ttsBase,
    getToken: token,
    getVoice: readReadAloudVoice,
    onStateChange: (nextState) => {
      if (!nextState.speaking && nextState.queued === 0) {
        setSpeakingMessageId(null);
      }
    },
    onError: (message) => console.warn("[tts-read-aloud]", message),
  });

  createEffect(() => {
    ttsNarrator.setEnabled(narrationOn());
  });

  // Speak each assistant message EXACTLY ONCE, ever. activeMessages can flip
  // between transcripts (switching tasks/sessions, or background task updates),
  // which makes the "current assistant" id oscillate; without a hard guard each
  // flip would reset the narrator cursor and re-speak a completed reply, looping
  // "reply 1, reply 2, reply 1, reply 2…" forever. We therefore only ever begin a
  // turn for an id we have never begun before, and refuse to restart any id once
  // seen. `ttsCurrentAssistantId` is the one id currently allowed to stream more
  // text; every other seen id is inert.
  // Ids of assistant replies we've already decided about (spoken or deliberately
  // skipped), so a transcript flip can't re-trigger them. Bounded FIFO: a Set
  // preserves insertion order, so once it exceeds the cap we drop the oldest id.
  const TTS_SEEN_MAX = 10_000;
  const ttsSeenAssistantIds = new Set<string>();
  const rememberSeenAssistantId = (id: string): void => {
    ttsSeenAssistantIds.add(id);
    if (ttsSeenAssistantIds.size > TTS_SEEN_MAX) {
      const oldest = ttsSeenAssistantIds.values().next().value;
      if (oldest !== undefined) ttsSeenAssistantIds.delete(oldest);
    }
  };
  let ttsCurrentAssistantId: string | null = null;
  // The user message whose turn stopNarration interrupted. A tool-using turn can
  // open further assistant messages under it, and those stay silent too.
  let ttsMutedUserTurnId: string | null = null;
  const lastUserIndex = (msgs: MessageWithParts[]): number => {
    let lastUserIdx = -1;
    for (let i = 0; i < msgs.length; i++) {
      if ((msgs[i]!.info as { role?: string }).role === "user") lastUserIdx = i;
    }
    return lastUserIdx;
  };
  const lastUserMessageId = (msgs: MessageWithParts[]): string | null => {
    const user = msgs[lastUserIndex(msgs)];
    return user ? messageIdFromInfo(user) || null : null;
  };
  // The active reply is the assistant message AFTER the most recent user
  // message in this transcript.
  const activeReply = (msgs: MessageWithParts[]): MessageWithParts | undefined => {
    const lastUserIdx = lastUserIndex(msgs);
    let latest: MessageWithParts | undefined;
    for (let i = lastUserIdx + 1; i < msgs.length; i++) {
      if ((msgs[i]!.info as { role?: string }).role === "assistant") latest = msgs[i];
    }
    return latest;
  };
  createEffect(
    on(activeMessages, (msgs) => {
      if (!ttsNarrator.isEnabled()) return;
      const latest = activeReply(msgs);
      if (!latest) return;
      const id = messageIdFromInfo(latest);
      if (!id) return;

      if (id === ttsCurrentAssistantId) {
        // Streaming continuation of the reply we're already narrating.
        const text = latest.parts
          .filter((part) => isVisibleTextPart(part))
          .map((part) => String((part as { text?: string }).text ?? ""))
          .join("");
        if (text) ttsNarrator.pushText(text);
        return;
      }

      // A different id surfaced. If we've already seen it, it's a completed reply
      // resurfacing due to a transcript flip — never re-speak it.
      if (ttsSeenAssistantIds.has(id)) return;

      if (ttsMutedUserTurnId !== null && lastUserMessageId(msgs) === ttsMutedUserTurnId) {
        rememberSeenAssistantId(id);
        return;
      }

      // Only speak a reply we catch WHILE IT IS STREAMING. A never-seen id that
      // is already completed on first sight is not a live reply — it's a past
      // reply surfacing because the user switched to an old chat (or a background
      // task pushed its transcript in). Speaking it would narrate history the
      // moment you open a chat. Mark it seen (so a later flip can't re-trigger)
      // but stay silent; the user can still play it with the per-message button.
      const completed = Boolean((latest.info as { time?: { completed?: number } }).time?.completed);
      if (completed) {
        rememberSeenAssistantId(id);
        return;
      }

      // Genuinely new, still-streaming reply: finish the prior turn's tail, start
      // a fresh turn.
      ttsNarrator.finishTurn();
      ttsNarrator.beginTurn();
      ttsCurrentAssistantId = id;
      rememberSeenAssistantId(id);
      const text = latest.parts
        .filter((part) => isVisibleTextPart(part))
        .map((part) => String((part as { text?: string }).text ?? ""))
        .join("");
      if (text) ttsNarrator.pushText(text);
    }),
  );

  const pollTtsDownload = () => {
    stopTtsPoll();
    const base = ttsBase();
    if (!base) return;

    let consecutiveFailures = 0;
    const maxConsecutiveFailures = 15;

    const tick = async () => {
      try {
        const res = await ttsFetch(`${base}/tts-narration/v1/download/status`, {
          headers: ttsHeaders(),
        });

        if (!res.ok) {
          throw new Error(`status ${res.status}`);
        }

        const payload = (await res.json()) as {
          state?: string;
          done_bytes?: number;
          total_bytes?: number;
          error?: string | null;
          model_loaded?: boolean;
        };

        consecutiveFailures = 0;

        if (typeof payload.done_bytes === "number") {
          setDownloadProgress(payload.done_bytes);
        }
        if (typeof payload.total_bytes === "number" && payload.total_bytes > 0) {
          setDownloadTotal(payload.total_bytes);
        }

        if (payload.state === "error") {
          setError(payload.error || "Download failed.");
          setState("error");
          return;
        }

        if (payload.state === "ready" || payload.model_loaded) {
          setDownloadPhase("ready");
          ttsReadyTimer = setTimeout(() => {
            ttsReadyTimer = null;
            setDownloadOpen(false);
            const onReady = ttsPendingReady;
            ttsPendingReady = null;
            onReady?.();
          }, 1200);
          return;
        }
      } catch {
        consecutiveFailures += 1;
        if (consecutiveFailures >= maxConsecutiveFailures) {
          setError("Lost contact with the download service. Please try again.");
          setState("error");
          return;
        }
      }

      ttsPollTimer = setTimeout(() => {
        void tick();
      }, 1000);
    };

    void tick();
  };

  const confirmTtsDownload = async () => {
    const base = ttsBase();
    if (!base) return;

    setError(null);
    setDownloadProgress(0);
    setDownloadPhase("downloading");
    setState("downloading");

    try {
      const res = await ttsFetch(`${base}/tts-narration/v1/download`, {
        method: "POST",
        headers: ttsHeaders(),
      });

      if (!res.ok) {
        setError(`Could not start the download (HTTP ${res.status}).`);
        setState("error");
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
      return;
    }

    pollTtsDownload();
  };

  const dismissTtsDownload = () => {
    stopTtsPoll();
    ttsPendingReady = null;
    setDownloadOpen(false);
    setDownloadPhase("consent");
    setState("idle");
  };

  const prepareTtsModel = async (base: string): Promise<boolean> => {
    try {
      await ttsFetch(`${base}/tts-narration/v1/prepare`, {
        method: "POST",
        headers: ttsHeaders(),
      });
    } catch {
      return false;
    }

    for (let i = 0; i < 120; i += 1) {
      try {
        const res = await ttsFetch(`${base}/tts-narration/v1/health`, {
          headers: ttsHeaders(),
        });

        if (res.ok) {
          const payload = (await res.json()) as { model_loaded?: boolean };
          if (payload.model_loaded) {
            return true;
          }
        }
      } catch {
        // continue polling until timeout
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    return false;
  };

  const ensureReady = async () => {
    const base = ttsBase();
    if (!base) {
      setAvailable(false);
      setState("idle");
      return;
    }

    setState("checking");
    try {
      const res = await ttsFetch(`${base}/tts-narration/v1/health`, {
        headers: ttsHeaders(),
      });

      if (!res.ok) {
        setAvailable(false);
        setState("idle");
        return;
      }

      const payload = (await res.json()) as {
        model_loaded?: boolean;
        weights_present?: boolean;
      };

      setAvailable(true);
      setState(payload.model_loaded ? "ready" : "idle");
      setError(null);
    } catch (err) {
      setAvailable(false);
      setState("error");
      setError(err instanceof Error ? err.message : "Unknown TTS error");
    }
  };

  /**
   * `isCurrent` is false once the click that asked for TTS was cancelled; every
   * await is followed by a check, so a cancelled start neither loads the model
   * nor opens the download consent dialog later.
   */
  const ensureTtsWeights = async (onReady: () => void, isCurrent: () => boolean = () => true) => {
    const base = ttsBase();
    if (!base) return;

    let payload: { model_loaded?: boolean; weights_present?: boolean };
    try {
      // This business endpoint starts the on-demand TTS child; health stays
      // side-effect free so discovery probes never make it resident.
      const activate = await ttsFetch(`${base}/tts-narration/v1/download/status`, {
        headers: ttsHeaders(),
      });
      if (!activate.ok) throw new Error(`activation ${activate.status}`);
      const res = await ttsFetch(`${base}/tts-narration/v1/health`, {
        headers: ttsHeaders(),
      });
      if (!res.ok) throw new Error(`health ${res.status}`);
      payload = (await res.json()) as { model_loaded?: boolean; weights_present?: boolean };
    } catch {
      console.warn("[tts] health check failed; not enabling narration");
      return;
    }
    if (!isCurrent()) return;

    if (payload.model_loaded) {
      onReady();
      return;
    }

    if (payload.weights_present) {
      const ready = await prepareTtsModel(base);
      if (!isCurrent()) return;
      if (ready) {
        onReady();
      } else {
        console.warn("[tts] model did not become ready; not enabling narration");
      }
      return;
    }

    ttsPendingReady = onReady;
    setError(null);
    setDownloadProgress(0);
    setDownloadTotal(0);
    setDownloadPhase("consent");
    setDownloadOpen(true);
  };

  // Same role as speakRequest below: a second click while starting cancels, and
  // the late-arriving ready must not turn narration on behind the user's back.
  let narrationRequest = 0;

  const narrationState = (): NarrationState =>
    narrationOn() ? "on" : narrationStarting() ? "starting" : "off";

  const toggleNarration = async () => {
    if (narrationOn()) {
      setNarrationOn(false);
      return;
    }

    narrationRequest += 1;
    if (narrationStarting()) {
      setNarrationStarting(false);
      return;
    }

    const request = narrationRequest;
    setNarrationStarting(true);
    await ensureTtsWeights(
      () => {
        if (request === narrationRequest) setNarrationOn(true);
      },
      () => request === narrationRequest,
    );
    if (request === narrationRequest) setNarrationStarting(false);
  };

  // Bumped by every click and by stopNarration, so a cold start that finishes
  // after the user cancelled (or moved on) does not start playing.
  let speakRequest = 0;

  const readAloud = (): ReadAloudState | null => {
    const starting = startingMessageId();
    if (starting) return { messageId: starting, phase: "starting" };
    const speaking = speakingMessageId();
    return speaking ? { messageId: speaking, phase: "speaking" } : null;
  };

  const speakMessage = (messageId: string, text: string) => {
    speakRequest += 1;
    if (speakingMessageId() === messageId) {
      setStartingMessageId(null);
      onDemandNarrator.stop();
      setSpeakingMessageId(null);
      return;
    }

    if (startingMessageId() === messageId) {
      setStartingMessageId(null);
      return;
    }

    const request = speakRequest;
    setStartingMessageId(messageId);
    void ensureTtsWeights(
      () => {
        if (request !== speakRequest) return;
        const started = onDemandNarrator.speak(text);
        setSpeakingMessageId(started ? messageId : null);
      },
      () => request === speakRequest,
    ).finally(() => {
      if (request === speakRequest) setStartingMessageId(null);
    });
  };

  /**
   * Stops whatever is playing — the auto-narrated reply and a message's
   * read-aloud — without turning narration off, so the next reply still speaks.
   */
  const stopNarration = () => {
    speakRequest += 1;
    setStartingMessageId(null);
    // stop() rewinds the narrator's text cursor, so a reply that is still
    // streaming would be re-read from its start on the next update. Dropping the
    // current id lets the seen-id guard keep the interrupted reply silent.
    ttsCurrentAssistantId = null;
    // Marked seen even when narration is not on yet: a toggle still starting
    // would otherwise pick this reply up as new once ready and read it into the
    // microphone.
    const msgs = untrack(activeMessages);
    const interrupted = activeReply(msgs);
    const interruptedId = interrupted ? messageIdFromInfo(interrupted) : "";
    if (interruptedId) rememberSeenAssistantId(interruptedId);
    ttsMutedUserTurnId = lastUserMessageId(msgs);
    ttsNarrator.stop();
    onDemandNarrator.stop();
    setSpeakingMessageId(null);
  };

  // Discover TTS whenever the server base changes without touching the
  // on-demand child; the first user action calls a business endpoint instead.
  createEffect(() => {
    const base = ttsBase();
    if (!base) {
      setAvailable(false);
      return;
    }

    void (async () => {
      try {
        const res = await ttsFetch(`${base}/app/services/catalog`, {
          headers: ttsHeaders(),
        });

        if (!res.ok) {
          setAvailable(false);
          return;
        }

        const catalog = (await res.json()) as {
          services?: Array<{ name?: string }>;
        };
        setAvailable(
          catalog.services?.some((service) => service.name === "tts_manager") ?? false,
        );
      } catch {
        setAvailable(false);
      }
    })();
  });

  onCleanup(() => {
    stopTtsPoll();
    ttsNarrator.stop();
    onDemandNarrator.stop();
  });

  return {
    available,
    narrationOn,
    narrationState,
    speaking,
    speakingMessageId,
    readAloud,
    state,
    downloadOpen,
    downloadPhase,
    downloadProgress,
    downloadTotal,
    error,
    ensureReady,
    toggleNarration,
    speakMessage,
    stopNarration,
    confirmTtsDownload,
    dismissTtsDownload,
    setNarrationOn,
    setSpeaking,
    ttsNarrator,
    onDemandNarrator,
  };
}