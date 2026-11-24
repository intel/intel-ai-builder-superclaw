// Public surface of the `voice-input` slice — import from here, not from a
// module inside it. The cloud/browser provider lives outside this slice, in
// `shared/platform/voice-input.ts`; only the local engine, the model lifecycle
// and the engine selector live here.

export { useVoiceInput, type VoiceDownloadPhase, type VoiceInputController } from "./use-voice-input";
export {
  createVoiceController,
  type LocalVoiceInputFactory,
  type VoiceController,
} from "./voice-controller";
export type { VoiceLocalFailure } from "./local-voice-input";
export {
  decideReasoningHint,
  type ReasoningHintAction,
  type ReasoningHintDecision,
  type ReasoningHintInput,
} from "./dictation-reasoning-hint";
export { MAX_AUDIO_SECONDS } from "./pcm-capture";
export {
  DEFAULT_VOICE_INPUT_MODE,
  type DictationRefineMode,
  type VoiceInputMode,
} from "./voice-input-prefs";
export {
  MAX_VOICE_HOTKEYS,
  createHotkeyCapture,
  formatHotkey,
  hotkeyIdentity,
  hotkeyNeedsAltGrNote,
  type HotkeyRejection,
  type VoiceHotkey,
} from "./voice-hotkey";
export {
  MAX_DICTIONARY_ENTRY_CHARS,
  MAX_DICTIONARY_WORDS,
  addDictionaryWord,
  normalizeDictionary,
  removeDictionaryWord,
  type DictionaryRejection,
} from "./voice-dictionary";
export {
  type CorrectionRecord,
  type DictionaryOrigin,
  type PromotionBlock,
  type PromotionProgress,
  promotionThreshold,
} from "./voice-corrections";
export type { VoiceModelState } from "./asr-model-state";
export type { AsrDownloadSnapshot } from "./asr-client";
export { ASR_MODEL_BYTES, ASR_MODEL_NAME } from "./asr-model-info";
