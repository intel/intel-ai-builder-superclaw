/** English-language strings for the composer domain. Merged in en.ts. */
export default {
  "composer.ai_disclaimer":
    "AI may make mistakes. Please verify important results.",
  "composer.voice_mic_denied":
    "Microphone access was blocked. Try again and choose Allow when prompted. If no prompt appears, turn on \"Let desktop apps access your microphone\" in Windows Settings > Privacy & security > Microphone.",
  "composer.voice_no_microphone":
    "No microphone found. Connect a microphone and try again.",
  "composer.voice_audio_capture":
    "Couldn't capture audio. Check that your microphone is connected and not in use by another app.",
  "composer.voice_network":
    "Couldn't reach the speech service. Check your network connection and try again.",
  "composer.voice_aborted": "Voice input stopped.",
  "composer.voice_language_unsupported":
    "Voice input doesn't support this language.",
  "composer.voice_error_unknown": "Voice input failed. Try again.",
  "composer.voice_no_speech": "No speech detected. Try again.",
  "composer.voice_cloud_notice":
    "Voice input uses your browser speech service and may process audio in the cloud.",
  "composer.voice_start_failed": "Couldn't start voice input.",
  // ── Local (on-device) voice input ──────────────────────────────────────────
  "composer.voice_local_preparing": "Preparing the speech model…",
  "composer.voice_local_transcribing": "Transcribing…",
  // Silence is a successful result, not a failure: say so without offering a
  // switch to the cloud.
  "composer.voice_local_nothing_heard": "Didn't hear anything. Try again.",
  "composer.voice_local_model_busy":
    "The speech model is still getting ready. Try again in a moment.",
  "composer.voice_local_max_duration":
    "Recording stopped at the 2-minute limit. Transcribing what was recorded.",
  "composer.voice_local_failed": "On-device voice input failed.",
  "composer.voice_local_model_broken":
    "The speech model couldn't be loaded. Downloading it again usually fixes this.",
  "composer.voice_local_too_long":
    "That recording is too long for on-device transcription. Try a shorter one.",
  "composer.voice_local_english_only":
    "On-device voice input only supports English.",
  "composer.voice_local_service_failed":
    "The on-device speech service couldn't be started.",
  // The local engine is absent from this build/profile (the catalog has no
  // `asr_manager`, or the proxy answers `service_not_found`), so the cloud
  // service takes over. Sanctioned by the plan's Profile gating — but the user
  // picked on-device, so the swap has to be announced, not silent. Worded
  // without "in this build": a catalog probe that could not be read at all
  // reaches the same fallback, and blaming the build would be a guess.
  "composer.voice_local_service_missing":
    "On-device voice input isn't available right now, so the cloud speech service will be used.",
  "composer.voice_local_timeout":
    "On-device transcription took too long and was stopped.",
  "composer.voice_local_sample_rate":
    "This microphone can't record at 16 kHz, which on-device recognition requires. Pick another microphone in Dictation settings.",
  "composer.voice_local_capture_unsupported":
    "This app build can't record audio, so on-device voice input is unavailable.",
  "composer.voice_local_use_cloud": "Use cloud instead",
  "composer.voice_local_redownload": "Download again",
  "composer.voice_error_dismiss": "Dismiss",
  "composer.voice_downloading_model": "Downloading the speech model",
  // First-recording hint bubble. Split into fragments because `t()` has no
  // interpolation and the hotkey is rendered as a <kbd> between them.
  "composer.voice_hint_press": "Tip: next time just press",
  "composer.voice_hint_local_mid":
    "to start and stop. Recognition is running on this computer, so your audio never leaves it — to save CPU you can switch to cloud in",
  "composer.voice_hint_local_after": ".",
  "composer.voice_hint_cloud_mid":
    "to start and stop. You're using the browser speech service — for offline use or more privacy you can switch to on-device in",
  "composer.voice_hint_cloud_after": ".",
  "composer.voice_hint_settings_link": "Dictation settings",
  "composer.voice_hint_got_it": "Got it",
  "composer.attachments_unavailable": "Attachments are unavailable.",
  "composer.attachment_too_large": "exceeds the 8MB limit.",
  "composer.attachment_too_large_encoded":
    "is too large after encoding. Try a smaller image.",
  "composer.image_count_limit":
    "You can attach up to 5 images per message. Extra images were ignored.",
  "composer.attachment_read_failed": "Failed to read attachment",
  "composer.inbox_upload_failed_fallback":
    "Couldn't upload. Inserted local links instead.",
  "composer.unsupported_attachment_type": "Unsupported attachment type.",
  "composer.inserted_unsupported_links":
    "Inserted links for unsupported files.",
  "composer.upload_folder": "Upload folder",
  "composer.folder_no_files": "Selected folder has no files to upload.",
  "composer.folder_total_size": "Total size",
  "composer.folder_skipped_note": "Skipped dependency/build folders",
  "composer.folder_truncated_warning":
    "Too many files - only the first 20,000 were scanned. Consider uploading a smaller subfolder.",
  "composer.folder_large_warning":
    "Large folder - uploading may take a while. You can cancel at any time.",
  "composer.folder_cancelling": "Cancelling...",
  "composer.folder_summary_uploaded": "Uploaded",
  "composer.folder_summary_of": "of",
  "composer.folder_summary_files_from": "files from",
  "composer.folder_summary_cancelled": "Folder upload cancelled —",
  "composer.folder_summary_failed": "failed",
  "composer.folder_read_failed": "Couldn't read selected folder.",
  "composer.outside_path_notice":
    "is outside this workspace, so SuperClaw can't open it.",
  "composer.outside_path_add_folder": "Add folder",
  "composer.outside_path_add_file": "Add file",
  "composer.outside_path_keep_text": "Keep as text",
  "composer.outside_path_add_failed":
    "Couldn't add the file. Its path is still in your message.",
  "composer.outside_path_added_after_send":
    "Added to the workspace after its path left your message. It's selected in Files, so your next message includes it.",
  "composer.upload_folder_confirm_title": "Upload folder?",
  "composer.upload_folder_confirm_prefix": "Upload",
  "composer.upload_folder_confirm_files_from": "files from",
  "composer.upload_folder_confirm_to_workspace": "to this workspace.",
  "composer.upload_this_folder_to_workspace":
    "Upload this folder to this workspace.",
  "composer.please_confirm": "Please confirm.",
  "composer.uploading": "Uploading...",
  "composer.upload": "Upload",
  "composer.no_matches_found": "No matches found.",
  "composer.loading_commands": "Loading commands...",
  "composer.no_commands_found": "No commands found.",
  "composer.attachment_image": "Image",
  "composer.attachment_file": "File",
  "composer.attachment_kind_folder": "Folder",
  "composer.attachment_kind_pdf": "PDF",
  "composer.attachment_kind_word": "Word document",
  "composer.attachment_kind_spreadsheet": "Spreadsheet",
  "composer.attachment_kind_presentation": "Presentation",
  "composer.attachment_kind_markdown": "Markdown",
  "composer.attachment_kind_text": "Text",
  "composer.attachment_kind_code": "Code",
  "composer.attachment_kind_archive": "Archive",
  "composer.attachment_open": "Open preview",
  "composer.attachment_reveal": "Find in File Explorer",
  "composer.attachment_remove": "Remove attachment",
  "composer.editor_placeholder": "Describe your task...",
  "composer.upload_files_or_folder": "Upload files or folder",
  "composer.upload_files": "Upload files",
  "composer.voice_stop_listening": "Stop listening",
  "composer.voice_start": "Click to start voice input",
  "composer.tts_start": "Speak responses aloud (real-time TTS)",
  "composer.tts_stop": "Turn off speaking responses",
  "composer.tts_read_aloud": "Read aloud",
  "composer.tts_stop_reading": "Stop reading",
  "composer.loading_agents": "Loading agents...",
  "composer.agent_general": "General",
  "composer.agent_general_default": "General (default)",
  "composer.hybrid_coding_agent_privacy_tooltip":
    "Files are protected before cloud analysis to ensure privacy.",
  "composer.local_model_tooltip": "Local model - your data stays on device",
  "composer.model_picker_tooltip": "Model routing mode",
  "composer.auto_model_description": "Routes between Local/Cloud",
  "composer.manage_models": "Manage models…",
  "composer.quick_agent_build_name": "Hybrid Coding Agent",
  "composer.quick_agent_build_description":
    "Reads, writes, edits, and debugs your code. Your files stay protected based on your protection setting.",
  "composer.quick_agent_hybrid_deep_research_name": "Hybrid Deep Research",
  "composer.quick_agent_hybrid_deep_research_description":
    "Researches a topic in depth for faster and more comprehensive results.",
  "composer.quick_agent_email_agent_name": "Email Agent",
  "composer.quick_agent_email_agent_description":
    "Summarizes and prioritizes Gmail emails and calendar events, filtering irrelevant content and focusing on recent activity. Requires one-time Gmail OAuth access.",
  "composer.start": "Start",
  "composer.stop": "Stop",
  "composer.paste_expand_hint": "Click to expand pasted text",
  "file_upload.tab_files": "Files",
  "workspace_files.delete_item": "Delete {name}",
  "workspace_files.delete_folder_title": "Delete folder?",
  "workspace_files.delete_file_title": "Delete file?",
  "workspace_files.delete_folder_message":
    'This will permanently delete "{name}/" and the {count} files in it.',
  "workspace_files.delete_folder_message_one":
    'This will permanently delete "{name}/" and the file in it.',
  "workspace_files.delete_folder_message_empty":
    'This will permanently delete "{name}/" and anything in it.',
  "workspace_files.delete_file_message": 'This will permanently delete "{name}".',
  // ==================== zh-i18n review-fix keys (2026-06-04) ====================
} as const;
