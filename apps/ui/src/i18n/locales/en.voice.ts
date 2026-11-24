/** English-language strings for the voice-input domain. Merged in en.ts. */
export default {
  // ── Download consent dialog (the only blocking step in the flow) ───────────
  "voice.download_title": "Download the speech model?",
  // Both facts the user needs before committing are in the first two sentences:
  // the size (630 MB) and that on-device recognition is English only.
  "voice.download_body":
    "Voice input recognizes speech on this computer by default, so your audio never leaves it. That needs a one-time download of about 630 MB, and afterwards it works offline.",
  "voice.download_english_only":
    "On-device recognition supports English only. The cloud speech service follows your system language.",
  "voice.download_confirm": "Download",
  "voice.download_use_cloud": "Use cloud instead",
  "voice.download_progress_title": "Downloading the speech model…",
  "voice.download_progress_body":
    "You can keep working. Click the microphone again to see progress.",
  "voice.download_in_progress": "Downloading…",
  "voice.download_ready_title": "Speech model ready",
  "voice.download_ready_body": "Press the microphone again to start recording.",
  "voice.download_failed_title": "Download failed",
  // Shown when the service keeps answering "idle, no model on disk" after a
  // download was started: nothing is running and nothing arrived, so waiting
  // longer cannot help.
  "voice.download_stalled":
    "The download didn't start. The speech service reports no progress and no model on disk.",
  "voice.download_retry": "Retry",
  "voice.download_cancel": "Cancel",
  // Leaves the modal without changing the engine: the download continues, and
  // another microphone click reopens its progress. The [Use cloud instead] button is
  // NOT an acceptable substitute for this — it switches away from the on-device
  // mode the user chose.
  "voice.download_background": "Continue in background",
  "voice.download_close": "Close",

  // ── Settings → Dictation ───────────────────────────────────────────────────
  "voice.settings_title": "Dictation",
  "voice.mode_heading": "Recognition mode",
  // "Local" / "Cloud", as the model-providers and MCP pages already name the
  // same choice. Each description carries only what the choice costs: where the
  // audio goes, and what it needs. The download's size is here because it is a
  // commitment made on selecting this option; its progress belongs to the
  // download dialog the microphone opens.
  //
  // "Local" NAMES THE RECOGNITION, NOT THE WHOLE PIPELINE. Dictated text still
  // goes wherever the user's agent model lives, so this card must never imply a
  // fully-local turn — every sentence here says "audio", and the clause is
  // "Recognition runs on this computer", not "nothing leaves this computer".
  "voice.mode_local_title": "Local",
  // Carries the 2-minute cap because `MAX_AUDIO_SECONDS` is in the PCM capture
  // path, which only this mode uses. As a note under both cards it claimed a
  // limit the browser speech service does not have.
  "voice.mode_local_desc":
    "Recognition runs on this computer — your audio never leaves it, and works offline. One-time ~630 MB download; each recording stops after 2 minutes.",
  "voice.mode_local_badge": "English only",
  "voice.mode_cloud_title": "Cloud",
  "voice.mode_cloud_desc":
    "Your audio is sent to the browser's speech service, which needs a network connection.",
  "voice.mode_local_unavailable":
    "On-device voice input isn't available in this build or for this profile, so the cloud service is used.",

  "voice.hotkey_heading": "Shortcut",
  "voice.hotkey_desc":
    "Toggles recording while SuperClaw is in focus. Add up to four keys or mouse buttons.",
  "voice.hotkey_add": "Add shortcut",
  "voice.hotkey_remove": "Remove shortcut",
  "voice.hotkey_none": "No shortcut — use the microphone button.",
  "voice.hotkey_capture": "Press keys, or a side or wheel mouse button…",
  "voice.hotkey_cancel": "Cancel",
  "voice.hotkey_reset": "Reset to default",
  // A single key is allowed as long as it types nothing: that is what makes the
  // Right Alt default possible, and it is also the whole reason for this rule.
  "voice.hotkey_error_typing_key":
    "A key that types something would fire while you write. Use a modifier, a function key, or add another key to it.",
  "voice.hotkey_error_reserved": "Enter, Tab and Esc are reserved by the composer.",
  "voice.hotkey_error_duplicate": "That shortcut is already bound.",
  "voice.hotkey_error_too_many": "Remove one first — four shortcuts is the limit.",
  // Right Alt is AltGr on German, French, Polish and other layouts. Shown for
  // the shipped default too, because the failure is layout-dependent and
  // invisible until someone tries it on such a keyboard.
  "voice.hotkey_altgr_note":
    "On some keyboard layouts Right Alt types characters (AltGr). If yours does, add a second shortcut.",
  "voice.hotkey_mouse_note":
    "A bound mouse button keeps its normal action as well, so a side button still navigates Back.",

  "voice.device_heading": "Microphone",
  "voice.device_system_default": "System default",
  "voice.device_refresh": "Refresh",
  // Shown only while the picker is disabled; in Local mode the card has no text.
  "voice.device_local_only": "Cloud mode uses the system default microphone.",

  "voice.read_aloud_voice_heading": "Read-aloud voice",
  "voice.read_aloud_voice_english": "American English (female)",
  "voice.read_aloud_voice_english_male": "American English (male)",
  "voice.read_aloud_voice_british": "British English (female)",

  "voice.dictionary_heading": "Dictionary",
  "voice.dictionary_desc":
    "Names, project names and terms. For example, adding \"Superclaw\" will allow it to be recognized correctly.",
  "voice.dictionary_local_only":
    "The Dictionary applies to on-device recognition only. The cloud speech service has no way to accept custom words.",
  "voice.dictionary_placeholder_input": "Add a name or term…",
  "voice.dictionary_add": "Add",
  "voice.dictionary_empty": "No words yet.",
  // Summary row that replaces the full chip list on the card.
  "voice.dictionary_summary": "{n} words · {m} learned automatically",
  "voice.dictionary_more": "+{n} more",
  "voice.dictionary_manage": "Manage words",
  // Manage words dialog.
  "voice.dictionary_dialog_title": "Dictionary · {n} / {max}",
  "voice.dictionary_dialog_close": "Close",
  "voice.dictionary_search_placeholder": "Search words",
  "voice.dictionary_filter_all": "All",
  "voice.dictionary_filter_learned": "Learned ({m})",
  "voice.dictionary_no_matches": "No matching words.",
  "voice.dictionary_select": "Select {word}",
  "voice.dictionary_select_all": "Select all",
  "voice.dictionary_selected": "{k} selected",
  "voice.dictionary_remove_selected": "Remove selected",
  "voice.dictionary_done": "Done",
  "voice.dictionary_import": "Import…",
  "voice.dictionary_export": "Export",
  "voice.dictionary_import_result": "Added {added}, skipped {skipped}.",
  "voice.dictionary_import_failed": "Couldn't read that file.",
  "voice.dictionary_import_hint":
    "Pick a .txt file with one word or phrase per line. Duplicates and anything past the {max}-word limit are skipped.",
  "voice.dictionary_export_hint":
    "Saves every word to dictionary.txt in your Downloads folder, one per line. Import it later to restore them.",
  "voice.dictionary_export_saved": "Saved {n} words to {path}",
  "voice.dictionary_export_failed": "Couldn't save the file: {error}",
  "voice.dictionary_error_empty": "Type a word first.",
  "voice.dictionary_error_duplicate": "That word is already in the Dictionary.",
  "voice.dictionary_error_too_long": "Too long for one entry — add the distinctive word on its own.",
  "voice.dictionary_error_full": "The Dictionary is full. Remove a word to add another.",

  // Learning from corrections. The description names the condition, because "it
  // learns" with no threshold attached invites both "why hasn't it?" and the
  // suspicion that everything typed here is being collected.
  "voice.dictionary_learned_desc":
    "Correct the same word two or three times and it's added automatically — no need to send, just pause a few seconds. Only the word is stored, never the message.",
  "voice.dictionary_origin_auto": "learned",
  "voice.dictionary_auto_added":
    "Added “{word}” to your Dictionary — you corrected it in more than one recording. Remove it in Settings if that was wrong.",
  // [Undo] on the notice above. Short, because it sits inline next to that sentence
  // and the sentence is what says which word it applies to.
  "voice.dictionary_auto_add_undo": "Undo",
  // Confirmed out loud, and it names the tombstone: [Undo] is the same thing as the
  // card's remove button, so the word does not come back off the stored evidence.
  "voice.dictionary_auto_add_undone":
    "Removed “{word}” — it will not be added again on its own.",

  // Progress, so that "nothing was recorded" and "recorded once, needs two" are
  // distinguishable. Without this the only feedback the loop gives is a word
  // appearing, which makes every failure look identical to waiting.
  "voice.dictionary_progress_heading": "Learning from your corrections",
  "voice.dictionary_progress_waiting": "{runs} of {threshold} recordings",
  "voice.dictionary_progress_unsuitable": "not suitable as a Dictionary word",
  "voice.dictionary_progress_already_added": "already in your Dictionary",
  "voice.dictionary_progress_removed": "you removed this word",

  // ── LLM clean-up ──────────────────────────────────────────────────────────
  // The copy names the tradeoff rather than selling the feature: a user who
  // turned on local recognition and then found their words going to a cloud
  // model would be right to call that a betrayal, so the card says where the
  // text goes. The toggle below already says the feature is off, and the
  // per-dictation second is not worth a sentence here.
  "voice.refine_heading": "Fix dictation mistakes with an LLM",
  // The sentence the whole card's honesty rests on — it must stay true for all
  // three modes, so it names the cloud as the default consequence rather than
  // burying it behind "whichever model you pick".
  "voice.refine_desc": "Text goes to a cloud model unless you choose the on-device one.",
  "voice.refine_toggle_label": "Clean up dictated text",
  // Disabled, never hidden: a toggle that disappears makes a saved setting look
  // lost. The sentence has to say what is missing, not just that something is.
  "voice.refine_unavailable": "Not available in this installation.",
  // The OTHER reason the switch is dead, and much the commoner one. Kept
  // separate because "not set up on this installation" would be simply untrue
  // here and would send the user looking for a fault instead of at the engine
  // chooser one card up, which is the whole fix.
  "voice.refine_local_mode_only": "Works only with Local recognition.",
  "voice.refine_mode_heading": "Model",
  "voice.refine_mode_agent_title": "Your agents' cloud model",
  // The on-device option. Deliberately promises NO quality penalty: on the
  // reference measurements the 4B's clean-up is competitive with the cloud
  // preset (content-token F1 90.5 vs 91.3; LLM-judge 95.8 vs 92.5), so copy
  // apologising for it would be inventing a tradeoff the numbers do not show.
  // What it does name is the real variable: speed moves with the machine rather
  // than the network.
  "voice.refine_mode_local_title": "On-device model",
  "voice.refine_mode_local_desc":
    "Nothing leaves this computer. Speed depends on your hardware.",
  // A reason, not a disabled control — the option stays selectable. So the
  // sentence says what to do, and does not claim the option is unusable: if the
  // probe is wrong, a dictation still works.
  "voice.refine_mode_local_blocked":
    "No on-device model is set up yet. Choose one under model providers to use this option.",
  // NOT called a "preset" in user-facing copy: it needs the user's own
  // OpenRouter key, and a word that implies "ready to go" would be a lie.
  // The title names the CHOICE rather than the default model: the option now
  // carries a picker, and a title reading "MiniMax M3" while the field under it
  // says something else is the card contradicting itself. It carries no
  // description: the title already names the key, the picker under it shows the
  // model, and `voice.refine_model_note` covers the endpoint routing.
  "voice.refine_mode_preset_title": "A model you choose, via your OpenRouter key",
  "voice.refine_mode_preset_blocked":
    "Add your OpenRouter key under model providers to use this option.",
  // The picker. Its label says "clean-up" and not just "model" because the one
  // fear this card has to keep answering is "will this repoint my agents?".
  "voice.refine_model_label": "Clean-up model",
  "voice.refine_model_default_badge": "Default",
  "voice.refine_model_placeholder": "Search your OpenRouter models",
  // Says out loud that the measured endpoint order is MiniMax M3's. Another
  // model still works, it just gets OpenRouter's own balancing — which is worth
  // knowing before blaming the feature for a slower dictation.
  "voice.refine_model_note":
    "MiniMax M3 is tuned for speed. Other models use OpenRouter's default routing.",
  "voice.refine_model_loading": "Loading your OpenRouter models…",
  // Deliberately does NOT say "type an id instead": the picker only commits a
  // model from the list, so with no list there is nothing to type. Promising an
  // escape hatch that does not exist is worse than naming the limit.
  "voice.refine_model_failed":
    "Could not list your OpenRouter models. Clean-up still uses the model shown above — check your key under model providers and reopen this page to try again.",
  "voice.refine_model_empty": "Your OpenRouter account returned no models.",
  "voice.refine_failure_note": "If clean-up fails, your text is inserted as dictated.",
  // The reasoning-model reminder. The copy has to earn the interruption, so it
  // says what reasoning costs here and why it buys nothing: clean-up is a
  // rewrite, so the chain of thought is paid for and waited on without ever
  // reaching the result. It also states its own blast radius — a settings card
  // for dictation offering to change the model the user's agents run on would be
  // a destructive surprise, so the copy says out loud that it does not.
  "voice.refine_reasoning_hint_title": "This model reasons first",
  "voice.refine_reasoning_hint_body":
    "{model} always reasons first, which adds cost and delay without improving clean-up.",
  "voice.refine_reasoning_hint_switch": "Use MiniMax M3 for clean-up",
  "voice.refine_reasoning_hint_scope": "Changes dictation clean-up only, not your agents.",
  // No button in this state: the switch would need an OpenRouter key the user
  // does not have, and a control that silently does nothing reads as a bug.
  "voice.refine_reasoning_hint_needs_key":
    "To clean up with MiniMax M3 instead, add your OpenRouter key under model providers.",
  // No button in this state either, for the opposite reason: the user picked
  // this model themselves, in the field directly above. Replacing an explicit
  // choice on one click is the destructive surprise the scope line promises not
  // to spring — so this arm points at the picker and leaves the decision theirs.
  "voice.refine_reasoning_hint_pick_other":
    "You chose this clean-up model yourself, so SuperClaw will not change it for you. Pick a different one above — or keep it, now that you know what it costs.",
  "voice.refine_reasoning_hint_dismiss": "Dismiss this reminder",
  // The four non-blocking notices. Each one says what happened AND what you got,
  // because "clean-up failed" on its own reads as "your dictation is gone".
  "voice.refine_toast_failed": "Clean-up failed — inserted your text as dictated.",
  "voice.refine_toast_timeout": "Clean-up took too long — inserted your text as dictated.",
  // "cloud" DELIBERATELY DROPPED. This fires on LLMRouter's 424, which means
  // "nothing is configured to serve the mode you picked" — and since the local
  // mode that is often an on-device model, not a cloud one. The toast has no
  // access to the mode (`classifyVoiceRefineError` switches on the error code
  // alone, by design), so the only honest wording is the one that is true of all
  // three modes.
  "voice.refine_toast_no_model":
    "No model is configured for clean-up — inserted your text as dictated.",
  // On-device mode only. Covers both "no local model" and "the local alias points
  // at a remote server", so it must not say "configure a model".
  "voice.refine_toast_not_on_device":
    "No on-device model is available for clean-up — inserted your text as dictated.",
  "voice.refine_toast_unavailable":
    "Clean-up is not available on this installation — inserted your text as dictated.",
  // Names the MODE, not the installation, and points at the two that still
  // work. The failure is a missing host-only credential, which only the
  // bring-your-own-key mode needs — so the copy must not read as "clean-up is
  // broken", or the user turns the whole feature off over one unavailable mode.
  "voice.refine_toast_host_key_missing":
    "Clean-up with a model you choose isn't available on this installation — inserted your text as dictated. The agent and on-device models still work.",

  // ── Product tour ──────────────────────────────────────────────────────────
  "tour.voice_input.title": "Dictation",
  "tour.voice_input.body":
    "Click the microphone to dictate instead of typing — or press Right Alt. Recognition runs on this computer by default; you can switch to the cloud service in Dictation settings.",

  // Other words the Settings search finds each setting by, comma-separated.
  "voice.mode_heading_keywords": "speech recognition, local, cloud, on-device, English only",
  "voice.hotkey_heading_keywords": "hotkey, keybinding, keyboard, shortcut key, mouse button",
  "voice.device_heading_keywords": "mic, input device, audio input, headset",
  "voice.read_aloud_voice_heading_keywords": "text to speech, TTS, read aloud, narration, speaker",
  "voice.refine_heading_keywords": "clean up, correct, fix mistakes, punctuation, LLM",
  "voice.dictionary_heading_keywords": "vocabulary, custom words, names, terms, spelling",
};
