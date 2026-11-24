// Real-time TTS narrator: consumes the assistant's streaming reply text, cuts it
// into sentence-sized segments, synthesizes each via the ServiceHub-proxied
// `/tts-narration/v1/tts` host service, and plays the audio segments strictly in
// order. Because Kokoro runs faster than real-time (RTF ~0.4 on the host CPU),
// synthesis stays ahead of the playhead and speech is continuous. The first
// segment of a turn is cut eagerly (soft boundaries and a ~45-char force-cut; see
// FIRST_* constants below) so time-to-first-audio is ~1.1s rather than a full
// opening sentence.
//
// Synthesis runs on the native Windows host (tts_manager, a ServiceHub child),
// outside the sandbox. Audio flows webview → ServiceHub → host TTS child; getBaseUrl
// returns the ServiceHub base URL and getToken returns the hub bearer.
//
// This is the *stream consumer* — the sentence cutting lives here, never in the
// agent. Feed it appended text with `pushText`; call `finishTurn` when the reply
// stops streaming so the trailing partial sentence is flushed.

import { requestServiceHubBinary, ServiceHubHttpError } from "~/shared/platform/transport/servicehub";

export interface TtsNarratorOptions {
  /** Returns the ServiceHub base URL (e.g. http://127.0.0.1:19000) or "" if unavailable. */
  getBaseUrl: () => string;
  /** Returns the ServiceHub bearer (hub token), or undefined. */
  getToken: () => string | undefined;
  /** Voice preset key sent to /tts-narration/v1/tts (e.g. "english", "default"). */
  getVoice: () => string;
  /** Optional: called on each state change for UI (speaking indicator). */
  onStateChange?: (state: { speaking: boolean; queued: number }) => void;
  /** Optional error sink. */
  onError?: (message: string) => void;
}

// Flush a segment when the buffer ends on a boundary, or when it grows past this
// many characters (so a long clause without punctuation still speaks).
const MAX_SEGMENT_CHARS = 180;
// Boundaries come in two strengths. HARD enders (. ! ? 。 ！ ？ newline) always
// cut. SOFT enders (, ; : and CJK equivalents) cut too — but only once the clause
// is at least MIN_SOFT_CHARS long, so a long leading clause ("Newton's First Law
// (Law of Inertia):") starts synthesizing immediately instead of waiting for the
// sentence-final period, while short fragments ("1, 2, 3") are not chopped into
// choppy pieces. This slashes time-to-first-audio; later chunks synthesize behind
// the playhead (Kokoro RTF < 1) so mid-stream latency stays hidden.
const BOUNDARY = /[.!?。！？\n,;:，；：]+[\s"'”’)\]]*/g;
const HARD_BOUNDARY_CHAR = /[.!?。！？\n]/;
const MIN_SOFT_CHARS = 32;
// Time-to-first-audio dominates the perceived latency: synth time grows with the
// first segment's length (~0.6s fixed + ~length), so a comma-less opening
// sentence isn't cut until its period (~75 chars → ~1.9s). Until the FIRST
// audible segment of a turn is emitted we cut much more eagerly — soft
// boundaries (, ; :) fire almost immediately, and a long comma-less opener is
// force-cut at a word boundary well before MAX_SEGMENT_CHARS. Kokoro runs faster
// than real-time (RTF < 1), so the short first chunk starts audio sooner and the
// remaining longer chunks synthesize behind the playhead without a gap.
const FIRST_MIN_SOFT_CHARS = 12;
// ~45 chars keeps first-audio near ~1.1s (measured), vs ~2.3s when a comma-less
// opener runs to its period at ~62 chars. Below ~40 the fixed model overhead
// (~0.9s) dominates, so shrinking further just makes the opener choppy.
const FIRST_SEGMENT_MAX_CHARS = 45;

// Emoji, pictographs, and standalone symbols (weather 🌦️, arrows ←, dingbats,
// etc.) are not speakable: Kokoro's g2p renders them as silence, and — worse —
// an astral-plane emoji is a UTF-16 surrogate pair, often followed by a U+FE0F
// variation selector and/or U+200D joiners. Left in the text they desync the
// segment that carries them mid-turn, so narration stops at the symbol and the
// rest of the reply is never spoken. Strip them before segmentation. Ranges:
// U+2190–21FF arrows, U+2300–27BF misc-technical/symbols/dingbats,
// U+2B00–2BFF misc symbols & arrows, U+FE00–FE0F variation selectors,
// U+200D zero-width joiner, U+1F000–1FAFF emoji/pictograph planes. NOTE: this
// deliberately does NOT touch CJK (so the non-Latin HALT logic below still
// fires) nor common typographic marks like ° or em dashes (which Kokoro speaks).
const NON_SPEAKABLE_SYMBOLS =
  /[‍←-⇿⌀-➿⬀-⯿︀-️]|[\u{1F000}-\u{1FAFF}]/gu;

// Strip markdown that should not be spoken and skip code blocks entirely.
function sanitizeForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")        // fenced code blocks
    .replace(/`[^`]*`/g, " ")               // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")  // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> link text
    .replace(/[*_#>]/g, " ")                 // md emphasis / headings / quotes
    .replace(NON_SPEAKABLE_SYMBOLS, " ")     // emoji / arrows / dingbats / symbols
    .replace(/[ \t]+/g, " ");
}

// English-only narration. Kokoro is loaded with the English voice, so CJK (and
// other non-Latin) text would be mispronounced or dropped by the g2p. Rather than
// strip it and speak the leftovers, we treat any non-Latin character as a hard
// stop signal (see the two modes below). English letters, digits, punctuation and
// whitespace are all speakable; only these should ever reach synthesis.
//
// Match "any character that belongs to a specific non-Latin script": the negated
// class excludes Latin plus the two script-less categories — Common (ASCII/typo-
// graphic punctuation, digits, symbols like $ + = % °, and whitespace) and
// Inherited (combining marks). So $5, 3.14, C++ and café stay speakable, while
// Han, Hiragana/Katakana, Hangul, Cyrillic, Arabic, Greek, Hebrew, etc. all halt.
// (A prior CJK-only range let Cyrillic/Arabic/Greek slip through to the English
// g2p; anchoring on Script=Common/Inherited fixes that without penalizing symbols.)
const HAS_NONLATIN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
// A segment worth synthesizing has at least one letter or digit — a pure
// punctuation/whitespace fragment is silence, so we skip it (without halting).
const HAS_SPEAKABLE = /[A-Za-z0-9]/;

export class TtsNarrator {
  private readonly opts: TtsNarratorOptions;
  private enabled = false;

  // Text intake: full sanitized text seen so far, and how much we've already
  // consumed into segments. Working on the cumulative string (not deltas) makes
  // us robust to the UI re-emitting the whole message on each streaming update.
  private consumedChars = 0;
  private pending = "";
  // Set true for the rest of a streaming turn once a segment contains any
  // non-Latin (e.g. Chinese) character. From that point we stop consuming and
  // enqueueing — already-queued English keeps playing, but nothing further in
  // this turn is spoken. Reset per turn in beginTurn()/speak().
  private halted = false;
  // False until the first audible segment of the current turn is enqueued. While
  // false, drainSentences() cuts eagerly to minimize time-to-first-audio (see the
  // FIRST_* constants). Reset per turn in beginTurn()/speak().
  private firstSegmentEmitted = false;

  // Ordered synthesis + playback pipeline.
  private segments: string[] = [];
  private synthesizing = false;
  private audioQueue: AudioBuffer[] = [];
  private audioCtx: AudioContext | null = null;
  private currentSource: AudioBufferSourceNode | null = null;
  private playing = false;
  private generation = 0; // bumped on stop() to cancel in-flight work

  constructor(opts: TtsNarratorOptions) {
    this.opts = opts;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.warmup();
    else this.stop();
  }

  /**
   * Create and RESUME the AudioContext up front — ideally from the user gesture
   * that flips narration on (the 🔊 toggle) or clicks read-aloud. This is the fix
   * for a first-turn-only truncation: previously the context was created lazily
   * inside the first synth callback (an async network continuation, NOT a user
   * gesture), so on the very first reply it was born `suspended`; Chromium/WebView2
   * autoplay then kept it suspended and pumpPlayback's `resume()` — also off-gesture
   * — could resolve without actually starting the clock, so the first segment played
   * (once activation caught up) but the queued follow-on segments were dropped. Every
   * later turn reused the now-`running` context and played in full, which is exactly
   * why the bug was "first time only". Resuming here, under the enabling gesture,
   * makes the context `running` before any reply streams, so pumpPlayback's resume is
   * a no-op and turn 1 behaves like every other turn. Safe to call repeatedly.
   */
  warmup(): void {
    const ctx = this.ensureCtx();
    if (ctx && ctx.state === "suspended") {
      void ctx.resume().catch(() => { /* autoplay may still gate; pumpPlayback retries */ });
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Called when a new assistant turn starts — resets intake state. */
  beginTurn(): void {
    if (!this.enabled) return;
    this.consumedChars = 0;
    this.pending = "";
    this.halted = false;
    this.firstSegmentEmitted = false;
  }

  /**
   * Feed the assistant message's *cumulative* visible text. Safe to call on every
   * streaming update; only newly-appended text is processed.
   */
  pushText(cumulativeText: string): void {
    if (!this.enabled || this.halted) return;
    const sanitized = sanitizeForSpeech(cumulativeText);
    if (sanitized.length <= this.consumedChars) return;
    this.pending += sanitized.slice(this.consumedChars);
    this.consumedChars = sanitized.length;
    this.drainSentences(false);
  }

  /** Called when the assistant reply is complete — flush the trailing partial. */
  finishTurn(): void {
    if (!this.enabled || this.halted) return;
    this.drainSentences(true);
  }

  /**
   * One-shot playback of a complete message, on demand and INDEPENDENT of the
   * streaming `enabled` gate. Used by the per-message speaker button (like the
   * "read aloud" affordance in ChatGPT/Gemini): the user can play a single reply
   * even when auto-narration is off. Barges in on any current playback first, so
   * clicking a second message replaces the first.
   */
  speak(text: string): boolean {
    this.stop();                 // barge-in: cancels streaming narration or a prior one-shot
    this.warmup();               // resume the context under this click, so segment 1's
                                 // playback doesn't strand the rest (see warmup()).
    this.halted = false;
    this.firstSegmentEmitted = false;
    const sanitized = sanitizeForSpeech(text);
    if (!sanitized.trim()) return false;
    // Read-aloud is whole-message all-or-nothing: if the reply contains ANY
    // non-Latin (e.g. Chinese) character, refuse to speak it at all rather than
    // read a mangled English-only subset. (Auto-narration uses per-segment
    // halting instead — see enqueueSegment.)
    if (HAS_NONLATIN.test(sanitized)) return false;
    this.pending = sanitized;
    this.consumedChars = sanitized.length;
    this.drainSentences(true);   // cut the whole message into segments and flush the tail
    // True when at least one speakable segment was accepted for synthesis. Use
    // firstSegmentEmitted (set the instant a segment is pushed, in enqueueSegment)
    // rather than the live queues: enqueueSegment kicks pumpSynthesis, which runs
    // synchronously up to its first await and can already have shift()ed the only
    // segment out of `segments` — with the buffer not yet in audioQueue and
    // playing still false — so the queue-based check would wrongly return false
    // for a single-segment message and the caller would clear the speaking state
    // just as playback begins.
    return this.firstSegmentEmitted || this.segments.length > 0 || this.audioQueue.length > 0 || this.playing;
  }

  /** Stop everything and clear queues (barge-in: new user message / toggle off). */
  stop(): void {
    this.generation += 1;
    this.segments = [];
    this.audioQueue = [];
    this.pending = "";
    this.consumedChars = 0;
    this.synthesizing = false;
    this.playing = false;
    if (this.currentSource) {
      // Call stop() WITHOUT nulling onended: the handler resolves the promise
      // that pumpPlayback() is awaiting, so the suspended async frame (and its
      // decoded AudioBuffer) is released instead of leaking. The generation bump
      // above makes pumpPlayback's while-loop bail on its next tick.
      try { this.currentSource.stop(); } catch { /* ignore */ }
      this.currentSource = null;
    }
    this.emit();
  }

  // ── internals ───────────────────────────────────────────────────────────

  private emit(): void {
    this.opts.onStateChange?.({
      speaking: this.playing,
      queued: this.segments.length + this.audioQueue.length,
    });
  }

  private drainSentences(flushTail: boolean): void {
    BOUNDARY.lastIndex = 0;
    let match: RegExpExecArray | null;
    let cut = 0;
    while ((match = BOUNDARY.exec(this.pending)) !== null) {
      const end = match.index + match[0].length;
      const isHard = HARD_BOUNDARY_CHAR.test(match[0]);
      // Soft boundaries (, ; :) only cut once the clause is long enough — this
      // keeps short lists intact while still cutting long leading clauses early.
      // Before the first audible segment we use a much lower threshold so the
      // opening clause starts synthesizing almost immediately (fast first audio).
      const minSoft = this.firstSegmentEmitted ? MIN_SOFT_CHARS : FIRST_MIN_SOFT_CHARS;
      if (!isHard && end - cut < minSoft) continue;
      const segment = this.pending.slice(cut, end).trim();
      if (segment) this.enqueueSegment(segment);
      cut = end;
    }
    // Force-cut an over-long remainder even without a boundary. The cap is much
    // smaller for the first segment (comma-less opener → cut at a word boundary
    // early) than for later segments (bigger chunks keep playback smooth).
    let rest = this.pending.slice(cut);
    // Recompute the cap each pass: the flag flips true after the first enqueue, so
    // the opener is cut small and any later chunks in this same drain grow larger.
    for (let maxChars = this.firstSegmentEmitted ? MAX_SEGMENT_CHARS : FIRST_SEGMENT_MAX_CHARS;
      rest.length > maxChars;
      maxChars = this.firstSegmentEmitted ? MAX_SEGMENT_CHARS : FIRST_SEGMENT_MAX_CHARS) {
      const sliceAt = rest.lastIndexOf(" ", maxChars);
      const at = sliceAt > 20 ? sliceAt : maxChars;
      const segment = rest.slice(0, at).trim();
      if (segment) this.enqueueSegment(segment);
      rest = rest.slice(at);
      cut += at;
    }
    if (flushTail) {
      const tail = rest.trim();
      if (tail) this.enqueueSegment(tail);
      this.pending = "";
    } else {
      this.pending = rest;
    }
  }

  private enqueueSegment(text: string): void {
    if (this.halted) return;
    // English-only, per-segment halt: the first segment that contains ANY
    // non-Latin (e.g. Chinese) character halts the rest of this turn. Whatever
    // English was already queued keeps playing; nothing from here on is spoken.
    // This is the streaming/auto-narration policy — read-aloud refuses the whole
    // message up front (see speak()).
    if (HAS_NONLATIN.test(text)) {
      this.halted = true;
      this.pending = "";
      return;
    }
    // Skip pure punctuation/whitespace fragments (silence), without halting.
    if (!HAS_SPEAKABLE.test(text)) return;
    this.segments.push(text.trim());
    this.firstSegmentEmitted = true; // subsequent cuts use the larger, smoother thresholds
    this.emit();
    void this.pumpSynthesis();
  }

  private async pumpSynthesis(): Promise<void> {
    if (this.synthesizing) return;
    const baseUrl = this.opts.getBaseUrl().trim();
    if (!baseUrl) return;
    this.synthesizing = true;
    const gen = this.generation;
    try {
      while (this.segments.length > 0 && gen === this.generation) {
        const text = this.segments.shift()!;
        const buffer = await this.synthesize(baseUrl, text);
        if (gen !== this.generation) return; // stopped mid-flight
        if (buffer) {
          this.audioQueue.push(buffer);
          this.emit();
          void this.pumpPlayback();
        }
      }
    } finally {
      if (gen === this.generation) this.synthesizing = false;
    }
  }

  private async synthesize(baseUrl: string, text: string): Promise<AudioBuffer | null> {
    const token = this.opts.getToken();
    if (!token) {
      this.opts.onError?.("TTS request error: no ServiceHub token");
      return null;
    }
    try {
      // Route through the Tauri plugin-http fetch (requestServiceHubBinary) so the
      // audio/wav response reaches the webview without CORS trouble and the hub
      // Bearer is attached. The WAV bytes are decoded straight into an AudioBuffer.
      const { data } = await requestServiceHubBinary(
        baseUrl,
        "/tts-narration/v1/tts",
        token,
        { method: "POST", body: { text, voice: this.opts.getVoice() } },
      );
      const ctx = this.ensureCtx();
      if (!ctx) return null;
      return await ctx.decodeAudioData(data);
    } catch (error) {
      if (error instanceof ServiceHubHttpError) {
        this.opts.onError?.(`TTS request failed: HTTP ${error.status}`);
        return null;
      }
      this.opts.onError?.(`TTS request error: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // Returns null (rather than asserting) when the Web Audio API is unavailable,
  // so callers can bail gracefully instead of throwing an "Ctor is not a
  // constructor" deep in the playback loop.
  private ensureCtx(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!this.audioCtx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        this.opts.onError?.("Web Audio API unavailable; TTS narration disabled.");
        return null;
      }
      this.audioCtx = new Ctor();
    }
    return this.audioCtx;
  }

  private async pumpPlayback(): Promise<void> {
    if (this.playing) return;
    // Resolve the audio context BEFORE flipping `playing`: if Web Audio is
    // unavailable, bail without setting the flag so a permanent-true `playing`
    // can't wedge every future pumpPlayback() at the guard above.
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const gen = this.generation;
    this.playing = true;
    this.emit();
    if (ctx.state === "suspended") { try { await ctx.resume(); } catch { /* ignore */ } }

    while (this.audioQueue.length > 0 && gen === this.generation) {
      const buffer = this.audioQueue.shift()!;
      // Re-resume per segment if the context slipped back to suspended. On the
      // first turn the context is often born suspended off a user gesture and a
      // single pre-loop resume() can resolve without the clock actually starting;
      // a source.start() on a suspended context never fires `onended`, so the
      // await below would hang and every queued follow-on segment would be
      // stranded — the exact first-reply-only truncation. Re-checking here means
      // segment 2+ still start once activation lands, instead of being dropped.
      if (ctx.state === "suspended") { try { await ctx.resume(); } catch { /* ignore */ } }
      await new Promise<void>((resolve) => {
        if (gen !== this.generation) { resolve(); return; }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.onended = () => {
          // Only clear currentSource if it still points at THIS source; a stop()
          // that already swapped in a newer turn's source must not be clobbered
          // by a late-firing ended event from the one we just superseded.
          if (this.currentSource === source) this.currentSource = null;
          resolve();
        };
        this.currentSource = source;
        source.start();
      });
      this.emit();
    }
    if (gen === this.generation) {
      this.playing = false;
      this.emit();
    }
  }
}
