/** English-language strings for the app-shell domain. Merged in en.ts. */
export default {
  "error_boundary.root_title": "SuperClaw hit an unexpected error",
  "error_boundary.panel_title": "This section failed to load",
  "error_boundary.retry": "Try again",
  "error_boundary.reload": "Reload",

  // ==================== Welcome Message ==============
  "status.superclaw_ready": "SuperClaw Ready",
  "status.mcp_connected": "MCP connected",
  "status.ready_for_new_task": "Ready for new tasks",
  "status.provider_connected": "provider connected",
  "status.providers_connected": "providers connected",
  "feedback.label": "Feedback",
  "feedback.send": "Send feedback",
  "feedback.opened": "Opened.",
  "feedback.open_failed": "Open failed.",
  "feedback.modal_title": "Send feedback",
  "feedback.modal_description":
    "Tell us what happened. This goes to the SuperClaw team.",
  "feedback.modal_footnote":
    "Tell us what happened to improve the product. This goes to the SuperClaw team at Intel. Your message should not contain secrets or personal data.",
  "feedback.message_label": "Message",
  "feedback.message_placeholder":
    "What went wrong, or what would you like to see?",
  "feedback.category_label": "Category",
  "feedback.category_bug": "Bug",
  "feedback.category_idea": "Idea",
  "feedback.category_question": "Question",
  "feedback.category_other": "Other",
  "feedback.attach_diagnostic_label": "Attach diagnostic info",
  "feedback.attach_diagnostic_hint":
    "App version, OS, and channel only — no paths or message content.",
  "feedback.submit": "Send",
  "feedback.submitting": "Sending…",
  "feedback.submit_success": "Thanks — feedback received.",
  "feedback.submit_fallback": "Opened your email client instead.",
  "feedback.submit_fallback_github": "Opened GitHub to file an issue.",
  "feedback.submit_error": "Couldn't send. Please try again.",
  "feedback.submit_quota_exceeded":
    "Feedback from this network was already sent recently. You can try again in a few hours, or use Send again to open GitHub or email instead.",
  "feedback.log_assisted_bug_description":
    "Same flow as Report bug on a chat message: review logs, optionally describe the issue, then open a GitHub draft.",
  "feedback.log_assisted_bug_next_step_hint":
    "Continue to pick logs and describe what happened in the next step (same as Report bug on a message).",
  "feedback.report_bug_action": "Report bug",
  "workspace.rename_title": "Edit worker name",
  "workspace.rename_description": "Update the name shown in the sidebar.",
  "workspace.rename_label": "Worker name",
  "workspace.rename_placeholder": "Design team worker",

  // ==================== Workspace ====================

  // ==================== Session ====================
  "common.refresh": "Refresh",
  "common.name": "Name",
  "common.install": "Install",
  "common.delete": "Delete",
  "common.deleting": "Deleting...",
  "common.connect": "Connect",
  "common.edit": "Edit",
  "common.save": "Save",
  "common.saving": "Saving...",
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.show": "Show",
  "common.hide": "Hide",
  "common.retry": "Retry",
  "common.loading": "Loading...",
  "common.dismiss": "Dismiss",

  // ==================== Telemetry (restart hint) ====================
  "status.connected": "Connected",
  "status.disconnected": "Disconnected",
  "status.running": "Running",
  "status.live": "Live",
  "status.connecting": "Connecting",
  "status.creating_workspace": "Creating worker",
  "status.loading_session": "Loading session",
  "status.creating_task": "Creating new task",
  "status.reloading_engine": "Reloading engine",
  "status.restarting_engine": "Restarting engine",
  "status.installing_opencode": "Installing SuperClaw",
  "status.repairing_migration": "Repairing migration",
  "status.disconnecting": "Disconnecting",

  // ==================== Scheduler Automation ====================

  // ==================== Model Settings ====================
  "workspace.switching_title": "Opening {name}",
  "workspace.switching_title_unknown": "Opening worker",
  "workspace.switching_subtitle": "We’ll bring your recent work back.",
  "workspace.switching_status_preparing": "Getting things ready",
  "workspace.switching_status_connecting": "Checking your connection",
  "workspace.switching_status_loading": "Loading recent tasks",
  "workspace.tasks_load_failed": "Failed to load tasks",
  "app.connection_lost": "Server connection lost. Please reload.",
  "app.unknown_error": "Unknown error",
  "app.cleanup_disk_critical_toast_title": "Workspace almost full",
  "app.cleanup_disk_critical_toast_body":
    "Intermediate cleanup files are using {size} and auto-cleanup is off. Review and free space.",
  "app.cleanup_disk_critical_toast_action": "Review cleanup",
  "app.error.tauri_required": "This action requires the Tauri app runtime.",
  "app.error.choose_folder": "Choose a folder to continue.",
  "app.error.remote_base_url_required": "Add a server URL to continue.",
  "app.error.install_failed": "SuperClaw install failed. See logs above.",
  "app.migration.desktop_required":
    "Migration repair requires the desktop app.",
  "app.migration.local_only":
    "Migration repair is only available for local workers.",
  "app.migration.workspace_required":
    "Pick a local worker folder before repairing migration.",
  "app.migration.unsupported":
    "This OpenCode binary does not support `opencode db migrate`. Update OpenCode to >=1.2.6 or switch to bundled engine.",
  "app.migration.failed": "SuperClaw migration failed.",
  "app.migration.restart_failed":
    "Migration completed, but SuperClaw could not restart the local engine.",
  "app.migration.success": "Migration repaired. Local startup was retried.",

  // ==================== UI Tour  ====================
  "token.usage_title": "Token Usage",
  "token.usage_no_data": "No token data yet",
  "token.usage_placeholder":
    "Token usage will appear here once you start using AI assistants in your tasks.",
  "token.usage_no_model_data": "No model-specific data available.",
  "token.usage_nonsession_hint":
    "Some requests belong to no task — dictation clean-up, for example. Those are counted under All-time on this device below.",
  "token.nonsession_title": "All-time on this device",
  "token.nonsession_purpose": "Purpose",
  "token.nonsession_requests": "Requests",
  "token.nonsession_tokens": "Tokens",
  "token.nonsession_cost": "Est. cost",
  "token.nonsession_alias_dictation": "Dictation clean-up",
  "token.nonsession_alias_unaliased": "Unlabelled",
  // These buckets mix agent turns with agent-mode clean-up, so the label is
  // only the route.
  "token.nonsession_alias_cloud_model": "Cloud",
  "token.nonsession_alias_local_model": "On-device",
  "token.nonsession_alias_auto": "Auto",
  "token.nonsession_unattributed": "Older requests (per-request detail dropped)",
  "token.nonsession_empty": "No requests recorded on this device yet.",
  "token.nonsession_cost_note":
    "Estimated from each provider's published prices at the time of the request. This is not a bill — check your provider's dashboard for what you were actually charged.",

  // ==================== Edge Server ====================
} as const;
