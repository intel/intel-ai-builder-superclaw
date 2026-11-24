# `features/tts/`

Narrating assistant replies out loud: the model's consent and download, the narrator's
lifecycle, which message is being spoken as new parts stream in, and the persisted
read-aloud voice preference (`tts-voice-prefs.ts`).

**Public surface:** `index.ts` — `useTtsNarration` with its `NarrationState` and
`ReadAloudState` types, and the voice preference: `READ_ALOUD_VOICES`,
`DEFAULT_READ_ALOUD_VOICE`, `readReadAloudVoice`, `writeReadAloudVoice`, `ReadAloudVoice`.

**Depends on:** `~/shared/platform/tts-narrator` (the narrator itself),
`~/shared/platform/transport/servicehub` (the fetch resolver), `isVisibleTextPart` from
`~/shared/util/part-visibility` (shared with the message list), `~/shared/types/session` and
`~/shared/util/constants`.

**Contract:** leaf UI slice ([`../README.md`](../README.md)).

**Still in `app/`:** the narration controls in `app/components/session/`.

**Verify:** from `apps/ui`, `pnpm test src/features/tts` and
`pnpm test:workspace-files-panel src/features/tts` (the streaming effect is inert under
`bun test`).
