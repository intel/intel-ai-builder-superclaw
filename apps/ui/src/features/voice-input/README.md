# `features/voice-input/`

Dictation with the on-device ASR engine: the mode preference, the model's download consent
and lifecycle, PCM capture and its length ceiling, the push-to-talk hotkeys, the user
dictionary and the correction history that promotes words into it, the optional LLM clean-up
of a dictation (and the warning when its model cannot stop reasoning), the microphone
presence check, and the controller the composer's mic button is built from.

**Public surface:** `index.ts` — `useVoiceInput` and `createVoiceController`, plus the
hotkey, dictionary, corrections, prefs, reasoning-hint and model-state helpers the settings
page needs. The file lists them explicitly.

**Depends on:** `~/shared/platform/transport/servicehub` and
`~/shared/platform/transport/llmrouter-client`, `~/shared/platform/voice-input` (the
cloud/browser provider, which stays in `shared/` because the composer reaches it without the
local engine), `~/shared/util/base64-bytes`, `~/shared/util/constants` and `src/i18n`.

**Contract:** leaf UI slice ([`../README.md`](../README.md)).

**Still in `app/`:** the settings UI — `app/pages/settings.voice-input-section.tsx`,
`settings.voice-dictionary-card.tsx` and `settings.voice-refine-card.tsx` — and the
composer's mic button.

**Verify:** from `apps/ui`, `pnpm test src/features/voice-input` and
`pnpm test:workspace-files-panel src/features/voice-input`. The second is not optional: the
`.vitest.ts` specs cover the reactive paths that are inert under `bun test`.
