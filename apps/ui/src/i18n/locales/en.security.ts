/** English-language strings for the security domain. Merged in en.ts. */
export default {
  "consent.telemetry_restart_title": "Restart to apply",
  "consent.telemetry_restart_body":
    "Your telemetry preference will take effect after the local runtime restarts.",
  "consent.telemetry_restart_action": "Restart now",
  "consent.telemetry_restart_failed_title": "Could not restart local services",
  "consent.telemetry_restart_failed_body":
    "The telemetry preference was saved, but the local runtime could not be stopped safely. Restart was cancelled.",
  "consent.telemetry_save_failed_title": "Could not save telemetry preference",
  "consent.telemetry_save_failed_body":
    "The change was not applied. Try again before restarting.",

  // ==================== MCP (Extensions) ====================
  "security.section": "File Protection",
  "security.section_description":
    "Detection may not be fully accurate.",
  "security.supported_files_label": "Supported files:",
  "security.supported_files_value":
    "CSV, Excel (.xlsx), Parquet, TXT, Markdown (.md), HTML, Word (.docx)",
  "security.supported_agents_label": "Supported agents:",
  "security.supported_agents_value": "Default Agent, Coding Agent",
  "security.mode_title": "File protection mode",
  "security.mode_on": "On",
  "security.mode_off": "Off",
  "security.mode_none": "None",
  "security.mode_deterministic": "Deterministic",
  "security.mode_hybrid": "Hybrid",
  "security.mode_llm": "LLM",
  "security.mode_none_description":
    "No protection — files reach the agent unredacted.",
  "security.mode_deterministic_description":
    "Quick, rule-based masking (no LLM). Best for well-structured spreadsheets and tables.",
  "security.mode_hybrid_description":
    "File protection is enabled — files are protected and masked before cloud processing.",
  "security.mode_llm_description":
    "LLM reviews every file for the most accurate protection. Slower but best for sensitive or unstructured content.",
  "security.threshold_title": "Hybrid fallback threshold",
  "security.threshold_apply": "Apply",
  "security.threshold_description":
    "In hybrid mode, if any detected column's confidence is below this value, the request falls back to the LLM pipeline. Default 0.75. Range 0.0 – 1.0.",
  "security.threshold_invalid": "Threshold must be a number in [0.0, 1.0].",
  "security.applied_prefix": "In use:",
  "security.source_env": "env override",
  "security.source_store": "custom",
  "security.save_failed": "Failed to save the security setting.",
  "security.model_download_consent_title": "Download and enable privacy models?",
  "security.model_download_consent_body":
    "File Protection needs local privacy models. They download once and stay on this device.",
  "security.model_download_downloading_title": "Downloading privacy models",
  "security.model_download_downloading_body":
    "Downloading and verifying the models on this device.",
  "security.model_download_ready_title": "Privacy models ready",
  "security.model_download_ready_body":
    "The models are ready. File Protection is now enabled.",
  "security.model_download_failed_title": "Could not download privacy models",
  "security.model_download_models_heading": "Models used by File Protection",
  "security.model_download_pii_model": "PII entity detection (PPLX)",
  "security.model_download_name": "File Protection models",
  "security.model_download_estimate": "About 536 MB",
  "security.model_download_confirm": "Confirm",
  "security.model_download_cancel": "Cancel",
  "security.model_download_in_progress": "Downloading…",
  "security.model_download_ready_hint": "Ready",
  "security.model_download_status_failed": "Could not check privacy model status.",
  "security.model_download_try_later":
    "The privacy models could not be prepared. Turn File Protection on again later to retry.",
  "security.model_download_unavailable": "The privacy models are unavailable.",
  "security.model_download_unverified_models":
    "The configured privacy models could not be verified. File Protection remains off.",
  "security.sensitive_folder_title": "Sensitive files folder",
  "security.sensitive_folder_choose": "Choose files",
  "security.sensitive_folder_click": "Or click here to choose files",
  "security.sensitive_folder_open": "Open folder",
  "security.sensitive_folder_description":
    "Kept on this device. Never sent to the cloud.",
  "security.sensitive_folder_description_lite":
    "When protection is on and you allow it, sensitive details are masked on this device before a cloud model sees them. If you turn protection off or decline it, the file is sent without masking.",
  "security.sensitive_folder_drop": "Drop sensitive files here",
  "security.sensitive_folder_importing": "Adding files...",
  "security.sensitive_folder_desktop_only":
    "Sensitive file import is available in the installed desktop app.",
  "security.sensitive_folder_drop_unavailable":
    "Use Choose files to add files in this environment.",
  "security.sensitive_folder_import_failed": "Failed to add sensitive files.",
  "security.sensitive_folder_import_success":
    "Successfully added \"{name}\" to sensitive folder",
  "security.sensitive_folder_list_title": "Files in sensitive folder",
  "security.sensitive_folder_empty": "No files yet",
  "security.sensitive_folder_view_all": "View more in folder",
  "security.sensitive_folder_remove_failed": "Failed to remove file.",

  // ==================== Egress approvals ====================
  "egress_approval.title": "Allow this request?",
  "egress_approval.action.connector.fetch_result":
    "SuperClaw wants to open a web page that was not in its search results.",
  "egress_approval.action.connector.mcp_call":
    "SuperClaw wants to call a tool on a remote MCP server.",
  "egress_approval.action.connector.gmail_send": "SuperClaw wants to send an email.",
  "egress_approval.action.proxy.connect_domain":
    "A command wants to connect to a domain that is not on the allowed list.",
  "egress_approval.action.proxy.connect_unlisted":
    "A command the agent ran wants to connect to a site that is not on SuperClaw's list of allowed sites.",
  "egress_approval.action.router.send_new_target":
    "SuperClaw wants to send a message to a new conversation.",
  "egress_approval.target.connector.fetch_result": "Web address",
  "egress_approval.target.connector.mcp_call": "Tool",
  "egress_approval.target.connector.gmail_send": "Email",
  "egress_approval.target.proxy.connect_domain": "Domain",
  "egress_approval.target.proxy.connect_unlisted": "Site",
  "egress_approval.target.router.send_new_target": "Conversation",
  "egress_approval.caller": "Requested by",
  "egress_approval.caller.shell": "A command",
  "egress_approval.caller.channel": "A messaging channel",
  "egress_approval.caller.agent": "The agent",
  "egress_approval.audience": "Carried out by",
  "egress_approval.audience.connector": "Network connector",
  "egress_approval.audience.egress_proxy": "Egress proxy",
  "egress_approval.audience.router": "Message router",
  "egress_approval.requested_at": "Requested at",
  "egress_approval.expires_in": "Expires in",
  "egress_approval.seconds": "{seconds} s",
  "egress_approval.id": "Approval ID",
  "egress_approval.waiting": "{count} requests are waiting.",
  "egress_approval.shortened": "(shortened)",
  "egress_approval.maybe_lost": "That request has ended. Your earlier answer may not have reached it.",
  "egress_approval.allow": "Allow",
  "egress_approval.deny": "Deny",
  "egress_approval.allow_once": "Allow once",
  "egress_approval.allow_all_for_chat": "Allow all sites for this session",
  "egress_approval.chat": "Session",
  "egress_approval.chat_scope_note":
    "\"This session\" stays allowed until you switch it off next to the message box. SuperClaw never opens addresses on your local network or this computer, whatever you choose.",
  "egress_approval.unknown_chat_note":
    "SuperClaw could not tell which session this request belongs to, so it can only be allowed once.",
  "egress_approval.proxy.allow_all_for_chat": "Allow all unlisted sites until SuperClaw restarts",
  "egress_approval.proxy.chat_scope_note":
    "This applies to commands from every session, not only this one, until SuperClaw restarts. It is a convenience, not a security boundary. Sites on a private network or this computer are never allowed this way.",
  "chat_web_access.chip_label": "Web pages: {choice}",
  "chat_web_access.chip_unknown": "Web pages",
  "chat_web_access.read_failed": "Couldn't read this setting. Pick an option.",
  "chat_web_access.menu_title": "How should web page access be approved?",
  "chat_web_access.ask": "Ask for approval",
  "chat_web_access.allowed": "Allow for this session",
  "chat_web_access.allowed_detail": "Opens public web pages without asking",
  "chat_web_access.allow_failed": "Couldn't allow. Still asking for approval; try again.",
  "chat_web_access.ask_failed": "Couldn't turn off. Still allowed; try again.",

  // Other words the Settings search finds each setting by, comma-separated.
  "security.section_keywords": "privacy, protected files, sensitive files, confidential, share files with cloud, masking",
  "security.mode_title_keywords": "masking, mask, protect files",
  "security.sensitive_folder_title_keywords": "sensitive files, confidential, private files, local only",
} as const;
