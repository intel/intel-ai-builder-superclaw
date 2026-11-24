/** English-language strings for the capability domain. Merged in en.ts. */
export default {
  "capability.model_change_title": "Apply model change",
  "capability.model_change_body":
    "The model change will be prepared and verified before it becomes active. The app stays open when the current product profile supports the model.",
  "capability.model_change_cancel": "Cancel",
  "capability.model_change_apply": "Apply model change",
  "capability.model_change_resume": "Resume",
  "capability.model_change_stage_lost":
    "This model change is no longer staged. Close this dialog and click Connect again.",
  "capability.switch_phase.validating": "Validating\u2026",
  "capability.switch_phase.connecting_edge": "Connecting to Edge server\u2026",
  "capability.switch_phase.preparing_local": "Preparing local model\u2026",
  "capability.switch_phase.applying": "Applying\u2026",
  "capability.switch_phase.recovery_required":
    "Model activation requires recovery.",
  "capability.probe_step.discover": "Discover models on edge server",
  "capability.probe_step.chat": "Chat model probe",
  "capability.probe_step.embedding": "Embedding model probe",
  "capability.bundle_step.chat": "Chat model",
  "capability.bundle_step.embedding": "Embedding model",
  "capability.probe_error.timeout":
    "Edge server did not respond within 10s. The model may be cold-starting or offline.",
  "capability.probe_error.connection_failed":
    "Could not reach the edge server. Check the URL and network path.",
  "capability.probe_error.auth_failed":
    "Edge server rejected the connection key (401/403).",
  "capability.probe_error.model_not_found":
    "Edge server does not serve this model.",
  "capability.probe_error.invalid_response":
    "Edge server returned an unexpected response shape.",
  "capability.probe_error.bundle_mismatch":
    "Edge server does not expose the required chat + embedding pair.",
  "capability.probe_error.upstream_error": "Edge server returned a 5xx error.",
  "capability.probe_error.config_changed":
    "Edge configuration changed while preparing. Please try again.",
  "capability.probe_error.not_configured": "Edge is not configured.",
  "capability.probe_error.unknown":
    "Edge preparation failed. Check server logs for details.",
  "capability.download_confirm_title": "Download required",
  "capability.download_confirm_body":
    "The following model needs to be downloaded before you can continue. This can take a few minutes on first launch.",
  "capability.security_only_model_note":
    "The local model serves solely as a security preprocessing layer, masking sensitive information before requests are transmitted to the cloud",
  "capability.download_role_chat": "(chat)",
  "capability.download_role_embedding": "(embedding)",
  "capability.download_total": "Total download",
  "capability.download_confirm": "Confirm",
  "capability.download_cancel": "Cancel",
  "capability.download_progress_title": "Downloading model",
  "capability.download_progress_body":
    "Downloading the model files. You can watch each item's progress below.",
  "capability.download_in_progress": "Downloading…",
  "capability.download_ready_title": "Models ready",
  "capability.download_verifying_title": "Verifying model files",
  "capability.download_verifying_body":
    "Checking the files already on disk against their checksums. No download is needed unless a file turns out to be damaged.",
  "capability.download_verifying_hint": "Verifying…",
  "capability.download_failed_title": "Model setup failed",
  "capability.download_failed_body":
    "The model could not be prepared. The details below are from the backend.",
  "capability.download_ready_body":
    "Every model file is downloaded and verified. Starting the runtime…",
  "capability.download_ready_hint": "Ready",
  "capability.download_retry": "Retry",
  "capability.download_cancel_download": "Cancel",
  "capability.tts_download_confirm_title": "Download voice model",
  "capability.tts_download_confirm_body": "Speaking responses aloud needs a text-to-speech voice model. It downloads once and is reused afterwards.",
  "capability.tts_download_lang_note": "This voice model speaks English only — other languages aren't supported yet.",
  "capability.tts_download_progress_title": "Downloading voice model",
  "capability.tts_download_progress_body": "Downloading the voice model. You can watch the progress below.",
  "capability.tts_download_ready_title": "Voice model ready",
  "capability.tts_download_ready_body": "The voice model is downloaded and verified. Enabling spoken responses…",
  "capability.hardware_insufficient_title": "Hardware requirements not met",
  "capability.hardware_insufficient_body":
    "This device does not have enough resources to run the local model. The following requirement(s) are not met:",
  "capability.hardware_req_memory": "System memory",
  "capability.hardware_req_model_memory": "Required memory",
  "capability.hardware_req_disk": "Free disk space",
  "capability.hardware_req_detail": "needs {required}, {free} available",
  "capability.hardware_req_detail_required": "needs {required}",
  "capability.hardware_req_detail_free": "{free} available",
  "capability.hardware_exit": "Exit",
  "capability.hardware_cancel": "Cancel",
  "capability.port_conflict_title": "Required ports are already in use",
  "capability.port_conflict_body":
    "SuperClaw cannot start, the following required port(s) are already in use:",
  "capability.port_conflict_hint":
    "Close the program using these ports, then start SuperClaw again.",
  "capability.port_conflict_exit": "Exit",
  "capability.port_owner_name_pid": "held by {name} (PID {pid})",
  "capability.port_owner_name": "held by {name}",
  "capability.port_owner_pid": "held by PID {pid}",
  "capability.elevated_title": "SuperClaw can't run as administrator",
  "capability.elevated_body":
    "Close SuperClaw and start it normally from the Start menu or the desktop shortcut.",
  "capability.elevated_hint":
    "If it opens this way every time, right-click the shortcut, choose Properties > Compatibility, and clear \"Run this program as an administrator\". If User Account Control (UAC) is turned off on this PC, turn it back on and restart first; on a managed PC, ask your IT administrator.",
  "capability.elevated_exit": "Exit",
} as const;
