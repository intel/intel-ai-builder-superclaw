// Public surface of the `tts` slice — import from here, not from a module inside it.

export { useTtsNarration, type NarrationState, type ReadAloudState } from "./useTtsNarration";
export {
  DEFAULT_READ_ALOUD_VOICE,
  READ_ALOUD_VOICES,
  readReadAloudVoice,
  writeReadAloudVoice,
  type ReadAloudVoice,
} from "./tts-voice-prefs";
