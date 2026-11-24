/**
 * Voice-input preferences, persisted the same way the product tour is
 * (`UI_TOUR_PREF_KEY`): one versioned localStorage key per preference, every
 * access wrapped so a blocked/unavailable storage degrades to the default
 * instead of throwing inside a component's setup.
 */
import {
  VOICE_INPUT_CORRECTIONS_PREF_KEY,
  VOICE_INPUT_DEVICE_PREF_KEY,
  VOICE_INPUT_DICTIONARY_AUTO_PREF_KEY,
  VOICE_INPUT_DICTIONARY_PREF_KEY,
  VOICE_INPUT_DICTIONARY_SUPPRESSED_PREF_KEY,
  VOICE_INPUT_HINT_PREF_KEY,
  VOICE_INPUT_HOTKEY_PREF_KEY,
  VOICE_INPUT_MODE_PREF_KEY,
  VOICE_INPUT_REFINE_MODE_PREF_KEY,
  VOICE_INPUT_REFINE_PREF_KEY,
  VOICE_INPUT_REFINE_REASONING_HINT_PREF_KEY,
} from "~/shared/util/constants";

import {
  type CorrectionRecord,
  normalizeCorrectionRecords,
  normalizeDictionaryWord,
} from "./voice-corrections";
import { normalizeDictionary } from "./voice-dictionary";
import {
  DEFAULT_VOICE_HOTKEYS,
  parseHotkeys,
  serializeHotkeys,
  type VoiceHotkey,
} from "./voice-hotkey";

/**
 * Which engine the microphone button drives.
 *
 * `local` — asr_manager / Parakeet on this machine (English only).
 * `cloud` — the browser (WebView2) speech service, i.e. the pre-existing path.
 */
export type VoiceInputMode = "local" | "cloud";

/**
 * Privacy-first default, per the integration plan: audio stays on the device
 * unless the user opts into the cloud service. A machine where the local option
 * is unavailable (no `asr_manager` in the catalog, or `voice_input` off for the
 * Profile) still gets the cloud engine — that resolution lives in
 * `use-voice-input.ts`, not here, so the stored preference is never rewritten
 * just because a service is temporarily missing.
 */
export const DEFAULT_VOICE_INPUT_MODE: VoiceInputMode = "local";

function readItem(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeItem(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Preferences are a convenience; losing one must not break voice input.
  }
}

export function readVoiceInputMode(): VoiceInputMode {
  const raw = readItem(VOICE_INPUT_MODE_PREF_KEY);
  return raw === "cloud" || raw === "local" ? raw : DEFAULT_VOICE_INPUT_MODE;
}

export function writeVoiceInputMode(mode: VoiceInputMode): void {
  writeItem(VOICE_INPUT_MODE_PREF_KEY, mode);
}

/**
 * Which model cleans a dictation up.
 *
 * `agent`  — the cloud model already configured for agent turns, reached through
 *            LLMRouter's `cloud-model` alias. Nothing extra to set up.
 * `local`  — the on-device model this machine was gated onto, reached through
 *            LLMRouter's `local-model` alias. Costs nothing and sends nothing to
 *            a cloud provider; needs a committed local bundle. There is no model
 *            id to store for it — the hardware→bundle chain owns that choice
 *            (AGENTS.md §5c), so this UI must never name one.
 * `preset` — an OpenRouter model with a measured endpoint preference, which needs
 *            the user's **own** OpenRouter key: nothing in the product bundles a
 *            credential for it. Which model is
 *            {@link readDictationRefineModel}'s business.
 */
export type DictationRefineMode = "agent" | "local" | "preset";

/**
 * The mode that works with whatever the user has already configured, so turning
 * clean-up on never lands on an option that cannot run.
 *
 * Left at `agent` when `local` was added, deliberately. Changing a default
 * silently repoints clean-up for every install that already enabled it, and the
 * recipient of dictated text is not a setting to change on the user's behalf —
 * even in the direction that sends it nowhere.
 */
export const DEFAULT_DICTATION_REFINE_MODE: DictationRefineMode = "agent";

/**
 * Whether the clean-up pass runs at all.
 *
 * **Off unless the stored value says otherwise**, and deliberately not symmetric
 * with the other preferences: clean-up sends the dictated text to a cloud model,
 * so it must be opted into and never inherited — not from an upgrade, not from a
 * default, and not from an unreadable storage that degrades to "probably on".
 */
export function readDictationRefineEnabled(): boolean {
  return readItem(VOICE_INPUT_REFINE_PREF_KEY) === "on";
}

export function writeDictationRefineEnabled(enabled: boolean): void {
  // "off" is written rather than the key removed, so an explicit opt-out is
  // distinguishable in devtools from a user who never saw the toggle.
  writeItem(VOICE_INPUT_REFINE_PREF_KEY, enabled ? "on" : "off");
}

export function readDictationRefineMode(): DictationRefineMode {
  const raw = readItem(VOICE_INPUT_REFINE_MODE_PREF_KEY);
  return raw === "agent" || raw === "preset" || raw === "local"
    ? raw
    : DEFAULT_DICTATION_REFINE_MODE;
}

export function writeDictationRefineMode(mode: DictationRefineMode): void {
  writeItem(VOICE_INPUT_REFINE_MODE_PREF_KEY, mode);
}

/**
 * The measured dictation clean-up model.
 *
 * KEPT, WHILE THE READ/WRITE ACCESSORS WENT. The value itself is still needed
 * on this side — the picker renders it before the host's first answer arrives,
 * and the reasoning hint's one-click action asks for it by name — but it is no
 * longer *stored* here. The model is host-side state now
 * (`PUT /speech-to-text/v1/refine/preference`), because a value the renderer
 * holds is a value the request carries, and `/refine` sits on an
 * unauthenticated port with a credential that can spend money. The host owns
 * the validation too; `isPlausibleModelId` moved there as
 * `preference._MODEL_ID_RE`, since a validator living only in the thing being
 * protected from is not a validator.
 */
export const DEFAULT_DICTATION_REFINE_MODEL = "minimax/minimax-m3";

/**
 * The model id the reasoning-model hint was last dismissed for, or `""`.
 *
 * Returned raw — the comparison this feeds is against an id the host echoed
 * back, so normalising here could only make a stored dismissal stop matching the
 * model it was recorded against.
 */
export function readDictationReasoningHintDismissed(): string {
  return readItem(VOICE_INPUT_REFINE_REASONING_HINT_PREF_KEY) ?? "";
}

export function writeDictationReasoningHintDismissed(modelId: string): void {
  writeItem(VOICE_INPUT_REFINE_REASONING_HINT_PREF_KEY, modelId);
}

/**
 * Stored bindings, falling back to the default when absent or corrupted.
 *
 * An empty *stored* list is honoured as "no shortcut" — the user can remove every
 * binding, and resurrecting the default there would make the remove button look
 * broken. Only a missing or malformed value falls back.
 */
export function readVoiceHotkeys(): VoiceHotkey[] {
  const raw = readItem(VOICE_INPUT_HOTKEY_PREF_KEY);
  return (raw ? parseHotkeys(raw) : null) ?? [...DEFAULT_VOICE_HOTKEYS];
}

export function writeVoiceHotkeys(hotkeys: readonly VoiceHotkey[]): void {
  writeItem(VOICE_INPUT_HOTKEY_PREF_KEY, serializeHotkeys(hotkeys));
}

/** True once the user pressed "Got it" on the first-recording hint bubble. */
export function isVoiceHintDismissed(): boolean {
  // Unknown environment → treat as dismissed: a bubble that cannot be
  // dismissed (no storage to remember it) must not reappear forever.
  if (typeof window === "undefined") return true;
  return readItem(VOICE_INPUT_HINT_PREF_KEY) === "done";
}

export function markVoiceHintDismissed(): void {
  writeItem(VOICE_INPUT_HINT_PREF_KEY, "done");
}

/**
 * Preferred capture device for LOCAL mode only. The cloud engine (Web Speech)
 * cannot be pointed at a device, so the Settings picker is disabled there
 * rather than silently ignored.
 */
export function readVoiceDeviceId(): string {
  return readItem(VOICE_INPUT_DEVICE_PREF_KEY) ?? "";
}

export function writeVoiceDeviceId(deviceId: string): void {
  writeItem(VOICE_INPUT_DEVICE_PREF_KEY, deviceId);
}

/**
 * Dictionary entries for the on-device contextual beam.
 *
 * Every failure mode collapses to the empty list, which means "no biasing" — the
 * pre-Dictionary behaviour, and the only safe degradation: a Dictionary that
 * cannot be read must leave recognition working, never block a recording. The
 * value is re-normalised on every read rather than trusted, because a blob written
 * by an older build (or hand-edited in devtools) can hold anything, and it is
 * about to be sent to a host that 400s a malformed list.
 */
export function readVoiceDictionary(): string[] {
  const raw = readItem(VOICE_INPUT_DICTIONARY_PREF_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeDictionary(parsed) : [];
  } catch {
    return [];
  }
}

export function writeVoiceDictionary(words: readonly string[]): void {
  writeItem(VOICE_INPUT_DICTIONARY_PREF_KEY, JSON.stringify(normalizeDictionary(words)));
}

/** Dictionary entries the app added itself. Same degradation as the manual list. */
export function readVoiceDictionaryAuto(): string[] {
  const raw = readItem(VOICE_INPUT_DICTIONARY_AUTO_PREF_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeDictionary(parsed) : [];
  } catch {
    return [];
  }
}

export function writeVoiceDictionaryAuto(words: readonly string[]): void {
  writeItem(VOICE_INPUT_DICTIONARY_AUTO_PREF_KEY, JSON.stringify(normalizeDictionary(words)));
}

/**
 * Words the app must not auto-add again. Stored normalised, because the point of the
 * list is matching a future candidate, not display.
 */
export function readVoiceDictionarySuppressed(): string[] {
  const raw = readItem(VOICE_INPUT_DICTIONARY_SUPPRESSED_PREF_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const entry of parsed) {
      const key = typeof entry === "string" ? normalizeDictionaryWord(entry) : "";
      if (key && !out.includes(key)) out.push(key);
    }
    return out;
  } catch {
    return [];
  }
}

export function writeVoiceDictionarySuppressed(keys: readonly string[]): void {
  writeItem(VOICE_INPUT_DICTIONARY_SUPPRESSED_PREF_KEY, JSON.stringify([...new Set(keys)]));
}

/**
 * Correction evidence. Re-normalised on read for the reason stated on the storage
 * key: the bound to word pairs is the privacy property, so a value written by
 * another build is filtered rather than trusted.
 */
export function readVoiceCorrections(): CorrectionRecord[] {
  const raw = readItem(VOICE_INPUT_CORRECTIONS_PREF_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeCorrectionRecords(parsed) : [];
  } catch {
    return [];
  }
}

export function writeVoiceCorrections(records: readonly CorrectionRecord[]): void {
  writeItem(VOICE_INPUT_CORRECTIONS_PREF_KEY, JSON.stringify(records));
}
