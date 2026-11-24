/** English-language strings for the sessions domain. Merged in en.ts. */
export default {
  "session.office_preview_unavailable":
    "Office documents can't be previewed because LibreOffice is not installed on this computer. Install LibreOffice, or open the file in its own app.",
  "session.office_preview_unavailable_remote":
    "Office documents can't be previewed because LibreOffice is not installed on the workspace's server. Ask whoever runs it to install LibreOffice, or open the file in its own app.",

  "session.office_preview_install_title": "Install LibreOffice?",
  "session.office_preview_install_message":
    "To preview Word, PowerPoint and Excel files, SuperClaw needs LibreOffice, which it does not include. If you agree, Windows Package Manager (winget) will download LibreOffice from The Document Foundation and install it (a few hundred MB, a few minutes), and Windows will ask for administrator permission.",
  "session.office_preview_install_license":
    "LibreOffice is free software under the Mozilla Public License 2.0 (MPL-2.0).",
  "session.office_preview_install_license_link": "View the license",
  "session.office_preview_install_confirm": "Install with winget",
  "session.office_preview_install_cancel": "Not now",
  "session.office_preview_install_starting": "Starting the install with winget…",
  "session.office_preview_install_downloading":
    "Downloading LibreOffice. This can take a few minutes, depending on your connection.",
  "session.office_preview_install_installing":
    "Installing LibreOffice. Approve the Windows permission prompt when it appears; if you don't see it, look for it blinking in the taskbar.",
  "session.office_preview_install_elapsed": "Time elapsed",
  "session.office_preview_install_manual":
    "SuperClaw can't install LibreOffice on this computer because Windows Package Manager (winget) isn't available. Download LibreOffice, install it, then choose Try again.",
  "session.office_preview_install_unreachable":
    "SuperClaw couldn't reach its own services to check whether LibreOffice can be installed. Choose Try again in a moment.",
  "session.office_preview_install_elsewhere":
    "LibreOffice is already installed on this computer, but in a folder SuperClaw doesn't look in. Uninstall it and install it again in the default location (under Program Files), then choose Try again.",
  "session.office_preview_install_retry": "Try again",
  "session.office_preview_install_download_link": "Download LibreOffice yourself",
  "session.office_preview_install_failed": "LibreOffice could not be installed.",

  // ==================== Session Name ====================

  // ==================== Tavily Modal ====================

  // ==================== Dashboard ====================
  "session.new_session": "New session",
  "session.new_task": "New task",
  "session.no_task": "No tasks yet.",
  "session.permission_title": "Allow this action?",
  "session.permission_file_protection_title": "Mask sensitive details before analysis?",
  "session.permission_required_description":
    "SuperClaw needs your permission before continuing.",
  "session.permission_summary_file_protection": "SuperClaw wants to analyze {target}.",
  "session.permission_summary_file_protection_unnamed":
    "SuperClaw wants to analyze a file that may contain sensitive details.",
  "session.permission_summary_email_send": "SuperClaw wants to send an email to {target}.",
  "session.permission_summary_email_reply": "SuperClaw wants to reply to an email, sending it to {target}.",
  "session.permission_summary_schedule_meeting": "SuperClaw wants to schedule a meeting with {target}.",
  "session.permission_summary_doom_loop":
    "SuperClaw has repeated the same step several times and wants to keep going.",
  "session.permission_summary_other": "SuperClaw needs your permission to continue with {target}.",
  "session.permission_technical_details": "Technical details",
  "session.permission_label_uppercase": "Permission",
  "session.scope_label_uppercase": "Scope",
  "session.details_label": "Details",
  "session.permission_mask_and_analyze": "Mask and analyze",
  "session.permission_analyze_unmasked": "Analyze without masking",
  "session.permission_allow_once": "Allow once",
  "session.permission_allow_session": "Allow for this session",
  "session.permission_dont_allow": "Don't allow",
  "session.permission_protected_pipeline_info":
    "Sensitive details in this file (like names, emails, or IDs) will be masked before analysis. If you choose Analyze without masking, the file will be analyzed as it is, with nothing masked.",
  "session.permission_already_declined":
    "You already chose to analyze this file without masking, so only Analyze without masking can be sent again.",
  "session.masking_on_device": "Masked on-device",
  "session.mask_review_title": "Review masked details",
  "session.mask_review_description":
    "These details were masked before cloud analysis. Check the preview below; if something sensitive is still visible (for example a vendor name), add it and click Apply.",
  "session.mask_review_empty": "Nothing was masked in this file.",
  "session.mask_review_no_preview": "No preview available for this file type.",
  "session.mask_review_truncated": "Preview truncated; the full file is still protected.",
  "session.mask_review_list_summary": "Masked items ({count})",
  "session.mask_review_apply": "Apply",
  "session.mask_review_loading": "Loading masked details…",
  "session.mask_review_load_failed": "Could not load the masked list. You can still continue or cancel.",
  "session.mask_review_input_label": "Extra words to mask",
  "session.mask_review_input_placeholder": "e.g. Globex Industries, Acme Corp (comma or new line separated)",
  "session.mask_review_unsupported": "Adding extra words is not supported for this file type.",
  "session.mask_review_added": "Masked: {terms}",
  "session.mask_review_not_found": "Not found in file: {terms}",
  "session.mask_review_already_masked": "Already masked and can't be masked again: {terms}. Remove it to continue.",
  "session.mask_review_submit_failed": "Could not mask the extra words. Please try again.",
  "session.mask_review_continue": "Mask and continue",
  "session.mask_review_cancel": "Cancel",
  "session.masking_on_device_title":
    "PII was masked locally by the deterministic detector (regex + local NER) before cloud analysis.",
  "session.masking_llm": "LLM masking",
  "session.masking_llm_title": "PII was masked by the LLM masking pipeline.",
  "session.base_url_label": "SuperClaw base URL",
  "session.model": "Model",
  "session.model_badge_auto": "Auto",
  "session.model_badge_local": "Local",
  "session.model_badge_cloud": "Cloud",
  "session.model_badge_hybrid": "Hybrid",
  "session.model_badge_tooltip": "Model used for this reply.",
  "session.model_badge_auto_tooltip":
    "Auto is the routing mode. It chooses a local or cloud model for each request; this label does not mean both were used.",
  "session.model_badge_local_tooltip":
    "Local means your configured local model, on this device or on your edge server.",
  "session.model_badge_cloud_tooltip":
    "Cloud means a model running through your configured cloud provider.",
  "session.model_badge_hybrid_tooltip":
    "Hybrid means this turn used both local and cloud models, including tool or sub-agent calls.",
  "session.token_split_tooltip":
    "Shows how this turn's recorded model tokens were split between local models (this device or your edge server) and cloud models.",
  "session.worked_for": "Worked for",
  "session.insert_prompt": "Insert prompt",
  "session.run": "Run",
  "session.rename_title": "Rename session",
  "session.delete_title": "Delete session",
  "session.favourites": "Favourites",
  "session.add_favourite": "Add favourite",
  "session.remove_favourite": "Remove favourite",
  "session.recent": "Recent",
  "session.updated": "Updated",
  "session.rename_description": "Update the name for this session.",
  "session.rename_label": "Session name",
  "session.rename_placeholder": "Enter a new name",
  "session.token_usage": "Token usage",

  // ==================== Commands ====================

  // ==================== Skills ====================
  "session.create_or_connect_worker": "Create or connect a worker",
  "session.tokens_total": "Total",
  "session.tokens_input": "Input",
  "session.tokens_messages": "Messages",
  "session.tokens_output": "Output",
  "session.tokens_share": "Share",
  "session.delete_session_message_generic":
    "This will permanently delete the selected session and its messages.",
  "session.deleting": "Deleting...",
  "session.auto_route_requires_cloud_title":
    "Auto Route Requires a Cloud Model",
  "session.cloud_model_unavailable_title": "Cloud Model Unavailable",
  "session.auto_route_requires_local_title":
    "Auto Route Requires a Local Model",
  "session.local_model_unavailable_title": "Local Model Unavailable",
  "session.auto_route_requires_both_title": "Auto Route Requires Both Models",
  "session.auto_route_intro":
    "Auto Route intelligently routes each task to a local or cloud model. To use it, please add a cloud model in Settings. If you prefer to use local models only, select the local model from the model picker.",
  "session.auto_route_local_intro":
    "Auto Route intelligently routes each task to a local or cloud model. No local model is available. Connect an Edge Server (or set up a local model) in Settings to use Auto Route.",
  "session.auto_route_both_intro":
    "Auto Route intelligently routes each task to a local or cloud model. Neither a local model nor a cloud model is configured. Please set up both models in Settings.",
  "session.cloud_model_unavailable_message":
    "The cloud model is currently unavailable. Please check your cloud provider connection in Settings → Model Routing.",
  "session.local_model_unavailable_message":
    "The local model is currently unavailable. Please verify that the model serving service is running and try again.",
  "session.cloud_model_not_configured_title": "Cloud Model Not Configured",
  "session.cloud_model_not_configured_message":
    "Please add a cloud model in Settings before sending.",
  "session.local_model_not_configured_title": "Local Model Not Configured",
  "session.local_model_not_configured_message":
    "Please set up a local (edge) model in Settings before sending.",
  "session.auto_route_not_configured_title": "Automatic Routing Unavailable",
  "session.auto_route_not_configured_message":
    "Configure both a local model and a cloud model in Model Routing.",
  "session.model_check_failed_title": "Couldn't Check Model Status",
  "session.model_check_failed_message":
    "Couldn't reach the model service to verify availability. This is usually temporary — please try sending again. If it persists, check the connection in Settings → Model Routing.",
  "session.go_to_settings": "Go to Settings",
  "session.skill_command_show_instructions": "Show skill instructions",
  "session.skill_command_hide_instructions": "Hide skill instructions",
  "session.subagent_readonly_notice":
    "This is a read-only subagent transcript. Switch to the parent task to continue chatting.",
  "session.session_loading_notice":
    "This session is still loading. Please wait a moment and try again.",
  "session.edge_unreachable_title": "Edge server unreachable",
  "session.edge_rejected_key_title": "Edge server rejected the API key",
  "session.edge_connect_failed_title": "Couldn't connect to Edge server",
  "session.edge_model_unavailable_title": "Your saved Edge model is no longer available",
  "session.edge_model_unavailable_message":
    "{model} can no longer be used: the Edge server no longer offers all the models it needs. Open Edge settings to choose another model.",
  "session.edge_model_unavailable_unknown": "The model you used before",
  "session.edge_profile_load_failed_title":
    "Connected to the Edge server, but SuperClaw couldn't load the Profile",
  "session.edge_profile_load_failed_message": "{message}. Retry to load it again.",
  "session.edge_unreachable_message":
    "{message}. Fix the server or update the connection in Settings.",
  "session.edge_unreachable_unknown": "SuperClaw couldn't connect to the Edge server",
  "session.edge_connecting_title": "Connecting to Edge server…",
  "session.edge_connecting_message":
    "Your workspace opens once the Edge server responds.",
  "session.edge_open_settings": "Open Edge settings",
  "session.edge_retry": "Retry",
  "session.edge_send_blocked":
    "Connect a model to start: the Edge server isn't connected yet. Check the banner above.",
  "session.web_search_limited_title": "Web Search May Be Limited",
  "session.default_agent_tavily_note":
    "Tavily Search is not configured, so the General agent's web search will fall back to DuckDuckGo. Search quality may be affected.",
  "session.default_agent_tavily_reminder":
    "You can add a Tavily API key in Settings later. This reminder will not appear again for 7 days.",
  "session.default_agent_tavily_unreadable":
    "Could not check whether a Tavily API key is saved, so the General agent's web search may fall back to DuckDuckGo.",
  "session.default_agent_tavily_unreadable_hint":
    "Open Settings to see the reason and try again.",
  "session.delete_confirm_prefix": 'This will permanently delete "',
  "session.delete_confirm_suffix": '" and its messages.',

  "session.global_search_sidebar_label": "Search…",
  "session.global_search_title": "Search tasks",
  "session.global_search_placeholder": "Search by title or message text",
  "session.global_search_empty_query": "Type to search tasks",
  "session.global_search_searching": "Searching…",
  "session.global_search_no_matches": "No matching tasks.",
  "session.global_search_match_title": "Title",
  "session.global_search_match_content": "Message",
  "session.global_search_truncated_metadata":
    "Some title matches are hidden (80 result cap). Refine your query.",
  "session.global_search_incomplete_content":
    "Some message history could not be fully searched; results may be incomplete.",
  "session.global_search_failed": "Search failed. Try again.",
  "question.fallback_header": "Question",
  "question.skip": "Skip",
  "question.next": "Next",
  "question.submit": "Submit",
  "question.dismiss": "Close without answering",
  "question.back": "Back",
  "question.composer_placeholder": "Type your own answer, or leave this blank to use the selected option",
  "question.composer_choose": "Choose an option above",
  "question.collapse": "Collapse question",
  "question.expand": "Expand question",
  "question.multiple_hint": "Select one or more options.",
  "question.from_subagent": "Asked by a subagent",
} as const;
