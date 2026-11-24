/** English-language strings for the settings domain. Merged in en.ts. */
export default {
  "settings.routing_mode": "Routing Mode",
  "settings.default_model": "Default model",
  "settings.session_model": "Model",
  "settings.test_connection": "Test Connection",
  "settings.connection_test_succeeded": "Connection successful.",
  "settings.connection_test_failed": "Connection failed.",
  "settings.search_models": "Search models…",
  "settings.showing_models": "Showing {count} of {total}",
  "settings.done": "Done",
  "settings.edit_model_settings": "Edit in Settings",
  "settings.edit_model_settings_named": "Edit {model} in Settings",
  "settings.no_models_match": "No models match your search.",
  "settings.no_providers_connected": "No providers connected yet.",
  "settings.update_checking": "Checking for SuperClaw updates…",
  "settings.update_available": "SuperClaw update available: v",
  "settings.update_required": "SuperClaw update required: v",
  "settings.reset": "Reset",
  "settings.language": "Language",
  "settings.appearance_title": "Appearance",
  "settings.theme_system": "System",
  "settings.theme_light": "Light",
  "settings.theme_dark": "Dark",

  // ==================== Reload ====================

  // ==================== Onboarding ====================
  "settings.backend_lifecycle_title": "Backend lifecycle",
  "settings.telemetry_title": "Privacy & Telemetry",
  "settings.telemetry_details": "Details",
  "settings.telemetry_baseline_enable": "Share app usage and health data",
  "settings.telemetry_baseline_enable_desc":
    "This helps us improve the app by showing how it is used and whether local services are working.",
  "settings.telemetry_baseline_identity":
    "A random Install ID used to group related events (it does not identify you), app version, operating system, release channel, and product bundle",
  "settings.telemetry_baseline_health":
    "Whether the app starts, becomes ready, and local services are available",
  "settings.telemetry_baseline_usage":
    "Counts of tool uses, runs, local service requests, and the amount of text processed",
  "settings.telemetry_excludes":
    "Usage and health data do not include prompts, model outputs, project names, tool arguments or results, cookies, account or email data, or unredacted file paths.",
  "settings.telemetry_enable": "Share crash reports",
  "settings.telemetry_crash_enable_desc":
    "This helps us fix app crashes by showing limited failure diagnostics.",
  "settings.telemetry_crash_diagnostics":
    "Error type, shortened error message, and where the failure happened",
  "settings.telemetry_crash_identity":
    "App version, release channel, affected service, product bundle, and a random Install ID used to group related reports (it does not identify you)",
  "settings.telemetry_reset_install_id": "Reset Install ID",
  "settings.telemetry_reset_install_id_desc":
    "Create a new random Install ID. The previous ID stops being used and cannot be linked to the new one.",
  "settings.telemetry_reset_install_id_action": "Reset",
  "settings.telemetry_reset_install_id_success":
    "Install identifier reset successfully.",
  "settings.telemetry_reset_install_id_error":
    "Failed to reset install identifier. Please try again.",
  "settings.clear": "Clear",
  "settings.app_settings_title": "General",
  "settings.privacy_tab_title": "Privacy",
  "settings.privacy_tab_empty":
    "No privacy settings are available for this configuration.",
  "settings.privacy_file_protection_unavailable":
    "File protection settings could not be loaded. Restart SuperClaw and try again.",
  "settings.github_cli_missing":
    "The GitHub CLI is missing from this sandbox. Update SuperClaw to get a backend image that includes it.",
  "settings.github_connect": "Connect",
  "settings.github_connected": "Connected",
  "settings.github_connected_toast": "GitHub account connected.",
  "settings.github_device_failed": "Could not start the GitHub browser sign-in.",
  "settings.github_device_help":
    "Approve a one-time code in your browser. The token is created and kept inside the sandbox \u2014 you never handle it.",
  "settings.github_disconnect_failed": "Could not disconnect the GitHub account.",
  "settings.github_disconnected_toast": "GitHub account disconnected.",
  "settings.github_not_connected": "Not connected",
  "settings.github_remove_legacy": "Remove the earlier GitHub sign-in",
  "settings.github_scopes_label": "Granted access:",
  "settings.github_sign_in_browser": "Sign in with browser",
  "settings.github_subtitle":
    "Lets agents work with your issues, pull requests, and repos.",
  "settings.github_title": "GitHub Account",
  "settings.github_token_failed": "GitHub rejected that token.",
  "settings.github_token_help":
    "Prefer a token? Paste a personal access token with the repo, read:org, and read:project scopes. Create one on",
  "settings.github_token_link": "GitHub",
  "settings.github_token_placeholder": "ghp_\u2026 or github_pat_\u2026",
  "settings.gmail_auth_failed": "Could not start Gmail authorization.",
  "settings.gmail_authorize_heading": "Next step to authorize Gmail:",
  "settings.gmail_credentials_removed": "Gmail credentials removed.",
  "settings.gmail_creds_configured": "Authorization required",
  "settings.gmail_authorized": "Gmail authorized — Email Agent is ready to use",
  "settings.gmail_apis_pending": "Signed in — turn on Gmail and Calendar",
  "settings.gmail_found_download": "{name} is in your Downloads folder.",
  "settings.gmail_use_download": "Use it",
  "settings.gmail_leftover": "{name} is still in Downloads. SuperClaw keeps its own copy.",
  "settings.gmail_leftover_keep": "Keep",
  "settings.gmail_leftover_remove": "Remove",
  "settings.gmail_opening": "Opening\u2026",
  "settings.gmail_didnt_open": "Didn't open?",
  "settings.gmail_delete_failed": "Delete failed",
  "settings.gmail_guide_apis_checking": "Checking Gmail and Calendar\u2026",
  "settings.gmail_guide_apis_not_granted":
    "Google was not given all the Gmail and Calendar access SuperClaw asks for. Sign in again and allow all of it.",
  "settings.gmail_guide_apis_signed_out": "Your Google sign-in has expired. Sign in again.",
  "settings.gmail_guide_apis_title": "Turn on Gmail and Calendar",
  "settings.gmail_guide_apis_waiting":
    "Turn them on in the page that opened\u2026",
  "settings.gmail_guide_cancel": "Cancel",
  "settings.gmail_guide_client_audience":
    "Asked to set up the Auth Platform? Work account: choose Internal. Personal account: choose External and add yourself as a test user; you'll sign in again every 7 days.",
  "settings.gmail_guide_client_body":
    "Choose Desktop app, click Create, then Download JSON.",
  "settings.gmail_guide_client_title": "Create a Desktop app client",
  "settings.gmail_guide_no_file": "Saved it elsewhere, or the page looks different?",
  "settings.gmail_guide_reopen": "Open the page again",
  "settings.gmail_guide_signin_body": "Choose your account and allow access.",
  "settings.gmail_guide_signin_reopen": "Open sign-in again",
  "settings.gmail_guide_signin_title": "Sign in with Google",
  "settings.gmail_guide_watching": "Waiting for the download\u2026",
  "settings.gmail_intro": "Connect Gmail and Calendar to the Email Agent.",
  "settings.gmail_manual_hint":
    "Create a Desktop app OAuth client, then upload its JSON.",
  "settings.gmail_no_creds": "No credentials",
  "settings.gmail_status_loading": "Checking Gmail…",
  "settings.gmail_no_server_or_workspace":
    "Server not connected or no workspace available.",
  "settings.gmail_remove_confirm":
    "Remove Gmail credentials? This will also clear your OAuth token. You will need to re-upload credentials and re-authorize.",
  "settings.gmail_remove_title": "Remove credentials",
  "settings.gmail_setup_button": "Set up Gmail",
  "settings.gmail_setup_manual": "Set up manually",
  "settings.gmail_setup_resume": "Continue setup",
  "settings.gmail_try_again": "Try again",
  "settings.gmail_template": "Template",
  "settings.gmail_template_downloaded":
    "credentials_template.json saved to Downloads. Fill in your Client ID and Secret, then upload it here.",
  "settings.gmail_template_already_exists":
    "credentials_template.json already exists in Downloads",
  "settings.gmail_title": "Gmail Credentials",
  "settings.gmail_upload_button": "Upload file",
  "settings.gmail_upload_failed": "Upload failed",
  "settings.gmail_upload_success":
    "Credentials uploaded successfully. Check your browser window to sign in and grant access.",
  "settings.gmail_auth_hint":
    "A browser window has been opened — sign in and grant access",
  "settings.keep_backend_running": "Keep backend running after exit",
  "settings.keep_backend_running_desc":
    "Faster next launch. Backend services stay running in the background after the app closes.",
  "settings.label_workspaces": "Workspaces",
  "settings.providers_open_failed": "Failed to open providers",
  "settings.model_routing_title": "Model Routing",
  "settings.save": "Save",
  "settings.search_no_tavily_default":
    "If no Tavily API key is configured, web search uses DuckDuckGo by default.",
  "settings.search_tavily_here": "here",
  "settings.search_tavily_recommended":
    "Tavily Search is recommended over the default DuckDuckGo search. Register and request an API key",
  "settings.search_title": "Web search",
  "settings.deep_research_privacy_no_share_title":
    "Do Not Share with Cloud LLM",
  "settings.deep_research_privacy_save_failed":
    "Failed to save local file privacy setting.",
  "settings.deep_research_privacy_saved": "Saved local file privacy setting.",
  "settings.deep_research_privacy_share_title": "Share with Cloud LLM",
  "settings.deep_research_privacy_title":
    "Hybrid Deep Research Local File Privacy Setting",
  "settings.tavily_clear_failed": "Failed to clear Tavily API key.",
  "settings.tavily_cleared": "Cleared Tavily API key.",
  "settings.tavily_configured": "Tavily configured",
  "settings.tavily_enter_before_save": "Enter a Tavily API key before saving.",
  "settings.tavily_not_configured": "Tavily not configured",
  "settings.tavily_placeholder_enter": "Enter Tavily API key",
  "settings.tavily_placeholder_replace":
    "Enter new Tavily API key to replace existing key",
  "settings.tavily_save_failed": "Failed to save Tavily API key.",
  "settings.tavily_saved": "Saved Tavily API key.",
  "settings.tavily_retry": "Retry",
  "settings.tavily_status_loading": "Checking...",
  "settings.tavily_status_unreadable": "Could not read the key status",
  "settings.tavily_unavailable_in_this_mode": "Not available in this mode",
  "settings.update_action_check": "Check",
  "settings.update_action_view": "View update",
  "settings.update_action_download": "Download update",
  "settings.update_action_install": "Restart and install",
  "settings.update_install_confirm_title": "Ready to install?",
  "settings.update_install_confirm_body":
    "SuperClaw will close, install the update with one admin prompt, and reopen.",
  "settings.update_install_confirm_active_runs": "A task is still running. Updating now will stop it.",
  "settings.update_install_confirm_start": "Restart and install",
  "settings.update_install_confirm_cancel": "Later",
  "settings.update_downloading": "Downloading SuperClaw update…",
  "settings.update_verifying": "Verifying SuperClaw installer…",
  "settings.update_launching": "Starting SuperClaw installer…",
  "settings.update_action_retry": "Retry",
  "settings.update_tooltip_downloading": "Downloading {pct}%",
  "settings.update_tooltip_update_failed": "Update failed, click to retry",
  "settings.update_tooltip_check": "Check for SuperClaw updates",
  "settings.update_tooltip_available": "Download update v{version}",
  "settings.update_tooltip_ready": "v{version} is ready. Click to restart and install (admin)",
  "settings.update_ready": "SuperClaw update ready to install: v",
  "settings.update_check_failed": "SuperClaw update check failed",
  "settings.update_install_failed": "SuperClaw update install failed",
  "settings.update_up_to_date": "SuperClaw is up to date",
  "settings.file_cleanup_title": "File Cleanup",
  "settings.file_cleanup_subtitle":
    "Deletes temporary files from inactive sessions. Saved files stay. Run now skips anything touched in the last hour.",
  "settings.enable_file_cleanup": "Enable automatic cleanup",
  "settings.cleanup_emergency_notice":
    "SuperClaw freed disk space automatically {when} because the workspace was critically full.",
  "settings.cleanup_retention_label": "Keep session files for",
  "settings.cleanup_retention_days": "days",
  "settings.cleanup_retention_custom": "Custom",
  "settings.cleanup_run_now": "Run cleanup now",
  "settings.cleanup_run_now_busy": "Scanning…",
  "settings.cleanup_checking": "Checking…",
  "settings.update_availability_label": "SuperClaw update status:",
  "settings.cleanup_confirm_body_run_now":
    "This removes ~{freed} of temporary research files that SuperClaw can recreate. Your reports and saved files won't be touched.",
  "settings.cleanup_confirm_body_enable":
    "Turning this on frees ~{freed} of temporary research files now (SuperClaw can recreate them). Your reports and saved files won't be touched.",
  "settings.cleanup_confirm_body_retention":
    "Shortening retention frees ~{freed} of temporary research files sooner (SuperClaw can recreate them). Your reports and saved files won't be touched.",
  "settings.cleanup_confirm_nothing_left":
    "Nothing eligible to remove right now.",
  "settings.cleanup_run_now_nothing": "Nothing eligible to clean up right now.",
  "settings.cleanup_run_now_done":
    "Deleted {dirs} dirs and {files} files - freed {freed}.",
  "settings.cleanup_run_now_dry_run":
    "Dry run: would remove {dirs} dirs and {files} files; no files were deleted. Estimated space: {freed}.",
  "settings.cleanup_run_now_blocked":
    "Cannot run cleanup while an agent task is active.",
  "settings.cleanup_run_now_busy_conflict":
    "A cleanup pass is already running. Try again in a moment.",
  "settings.cleanup_run_now_error":
    "Cleanup failed. Check the backend manager logs.",
  "settings.cleanup_info_folder_size": "Intermediate files",
  "settings.cleanup_unavailable":
    "Cleanup settings could not be loaded. The local sandbox service may still be starting.",
  "settings.cleanup_unavailable_retry": "Retry",
  "settings.cleanup_save_failed":
    "Could not save cleanup settings. The change was not applied.",
  "settings.cleanup_info_last_run": "Last cleaned",
  "settings.cleanup_info_never": "Never",
  "settings.cleanup_disk_warn":
    "Intermediate cleanup files are using {size} — approaching the {limit} warning limit. Consider running cleanup.",
  "settings.cleanup_disk_critical":
    "Intermediate cleanup files are using {size} and have exceeded the {limit} critical limit. Automatic emergency cleanup has been triggered.",
  "settings.cleanup_disk_critical_disabled":
    "Intermediate cleanup files are using {size} and have exceeded the {limit} critical limit. Auto-cleanup is off — review and delete them to free space.",
  "settings.cleanup_reclaimable_note":
    "{size} is past your {days}-day retention and will be removed on the next automatic run.",
  "settings.cleanup_disk_allow_delete": "Delete now",
  "settings.cleanup_policy_title": "What gets cleaned",
  "settings.cleanup_policy_subtitle":
    "The exact paths and thresholds the backend enforces. User files outside these patterns are never touched.",
  "settings.cleanup_policy_warn": "Warning size",
  "settings.cleanup_policy_critical": "Critical size",
  "settings.cleanup_confirm_title": "Free up space?",
  "settings.cleanup_confirm_enable_title":
    "Review before enabling automatic cleanup",
  "settings.cleanup_confirm_retention_title":
    "Review before shortening retention",
  "settings.cleanup_confirm_close": "Close",
  "settings.cleanup_confirm_confirm": "Delete",
  "settings.cleanup_confirm_proceed": "Continue",

  // ==================== Settings search ====================
  "settings_search.placeholder": "Search settings",
  "settings_search.results_label": "Matching settings",
  "settings_search.result_count": "{count} matching settings",
  "settings_search.no_results": "No settings match \"{query}\"",
  "settings_search.no_results_hint": "Try another word, such as \"theme\", \"microphone\" or \"storage\".",
  "settings.theme": "Theme",
  "settings.updates_title": "Updates",
  // Other words the search finds each setting by, comma-separated.
  "settings.updates_title_keywords": "upgrade, new version, check for updates, update status, release",
  "settings.appearance_title_keywords": "theme, dark mode, light mode, night, colors, look",
  "settings.theme_keywords": "dark mode, light mode, night mode, system theme, colors",
  "settings.language_keywords": "locale, translation, Chinese, English",
  "settings.file_cleanup_title_keywords": "storage, disk space, delete files, retention, free up space, cleanup",
  "settings.enable_file_cleanup_keywords": "automatic cleanup, auto delete, storage",
  "settings.cleanup_retention_label_keywords": "retention, days, keep files, storage",
  "settings.cleanup_run_now_keywords": "free up space, delete now, clean, disk space",
  "settings.telemetry_title_keywords": "analytics, tracking, crash reports, diagnostics, usage data, telemetry",
  "settings.telemetry_baseline_enable_keywords": "usage data, analytics, health data, tracking",
  "settings.telemetry_enable_keywords": "crash, error reports, diagnostics",
  "settings.telemetry_reset_install_id_keywords": "install id, identifier, anonymous id",
  "settings.backend_lifecycle_title_keywords": "background, backend, startup, launch",
  "settings.keep_backend_running_keywords": "keep running, faster launch, background services, exit",
  "settings.deep_research_privacy_title_keywords": "deep research, local files, share with cloud, privacy",
  "settings.github_title_keywords": "git, gh, repository, repo, pull request, issues, token",
  "settings.search_title_keywords": "Tavily, internet, browse, web, search engine, DuckDuckGo, API key",
  "settings.gmail_title_keywords": "email, mail, Google, calendar, email agent, credentials, OAuth",
} as const;
