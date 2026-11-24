/**
 * The read-aloud voice, persisted like the voice-input preferences: one
 * versioned localStorage key, every access wrapped so blocked storage degrades
 * to the default.
 */
import { TTS_VOICE_PREF_KEY } from "~/shared/util/constants";

/**
 * The `tts_manager` voices offered to the user — the English entries of
 * `host/tts_manager/src/tts_manager/voices.json`. The Mandarin voices are left
 * out on purpose: the narrator halts on non-Latin text
 * (`shared/platform/tts-narrator.ts`), so they would never be heard.
 */
export const READ_ALOUD_VOICES = ["english", "english-male", "british"] as const;

export type ReadAloudVoice = (typeof READ_ALOUD_VOICES)[number];

export const DEFAULT_READ_ALOUD_VOICE: ReadAloudVoice = "english";

function isReadAloudVoice(value: string | null): value is ReadAloudVoice {
  return READ_ALOUD_VOICES.some((voice) => voice === value);
}

export function readReadAloudVoice(): ReadAloudVoice {
  if (typeof window === "undefined") return DEFAULT_READ_ALOUD_VOICE;
  try {
    const raw = window.localStorage.getItem(TTS_VOICE_PREF_KEY);
    return isReadAloudVoice(raw) ? raw : DEFAULT_READ_ALOUD_VOICE;
  } catch {
    return DEFAULT_READ_ALOUD_VOICE;
  }
}

export function writeReadAloudVoice(voice: ReadAloudVoice): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TTS_VOICE_PREF_KEY, voice);
  } catch {
    // A preference is a convenience; losing it must not break read-aloud.
  }
}
