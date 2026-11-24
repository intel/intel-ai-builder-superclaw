/** English-language strings for the dashboard domain. Merged in en.ts. */
export default {
  "dashboard.remote": "Remote",
  "dashboard.repairing_cache": "Repairing cache",
  "dashboard.repair_cache": "Repair cache",
  "dashboard.retry": "Retry",
  "dashboard.create_workspace_title": "Create Worker",
  "dashboard.create_workspace_subtitle":
    "Initialize a new folder-based worker.",
  "dashboard.create_workspace_confirm": "Create Worker",
  "dashboard.create_remote_workspace_title": "Add Remote Worker",
  "dashboard.create_remote_workspace_subtitle":
    "Save a SuperClaw server as a worker.",
  "dashboard.create_remote_workspace_confirm": "Add Worker",
  "dashboard.edit_remote_workspace_title": "Edit Remote Connection",
  "dashboard.edit_remote_workspace_subtitle":
    "Update the SuperClaw server details for this worker.",
  "dashboard.edit_remote_workspace_confirm": "Save connection",
  "dashboard.remote_workspace_title": "Worker",
  "dashboard.remote_workspace_hint":
    "Track a SuperClaw server and reconnect anytime.",
  "dashboard.remote_base_url_required": "Add a server URL to continue.",
  "dashboard.openwork_host_label": "SuperClaw server URL",
  "dashboard.openwork_host_placeholder": "https://your-server.openwork.app",
  "dashboard.openwork_host_hint":
    "Use the URL shared by your SuperClaw server.",
  "dashboard.openwork_host_token_label": "Collaborator or owner token",
  "dashboard.openwork_host_token_placeholder": "Paste your token",
  "dashboard.openwork_host_token_hint":
    "Optional. Paste a collaborator token for routine access or an owner token when this client must answer permission prompts.",
  "dashboard.remote_connection_openwork": "SuperClaw",
  "dashboard.remote_connection_direct": "Direct",
  "dashboard.remote_directory_label": "Worker directory (optional)",
  "dashboard.remote_directory_placeholder": "/home/team/project",
  "dashboard.remote_directory_hint": "Leave blank to use the server default.",
  "dashboard.remote_display_name_label": "Display name (optional)",
  "dashboard.remote_display_name_placeholder": "Design team worker",
  "dashboard.select_folder": "Select Folder",
  "dashboard.choose_folder": "Choose a folder",
  "dashboard.choose_folder_next": "Share files with your worker.",
  "dashboard.change": "Change",
  "dashboard.opening": "Opening...",
  "dashboard.choose_preset": "Choose Preset",
  "dashboard.choose_folder_continue": "Choose a folder to continue.",
  "dashboard.starter_workspace": "Starter worker",
  "dashboard.starter_workspace_desc":
    "Preconfigured to show you how to use plugins, commands, and skills.",
  "dashboard.empty_workspace": "Empty worker",
  "dashboard.empty_workspace_desc":
    "Start with a blank folder and add what you need.",
  "dashboard.blueprints_workspace": "Blueprints",
  "dashboard.blueprints_workspace_desc":
    "Start with an automation-ready worker for reusable skills, commands, and shared flows.",

  // ==================== Workspace ====================
  "dashboard.advanced": "Settings",
  "dashboard.back": "Back",
  "dashboard.close_settings": "Close settings",
  "dashboard.creating": "Creating...",
  "dashboard.collaborator_token": "Collaborator token",
  "dashboard.collaborator_token_host_hint":
    "Routine remote access to this host without owner-only actions.",
  "dashboard.collaborator_token_routine_hint":
    "Routine remote access when you do not need owner-only actions.",
  "dashboard.connected_token": "Connected token",
  "dashboard.connected_token_hint":
    "This worker is currently connected with this token.",
  "dashboard.data_usage": "Data & Usage",
  "dashboard.desktop_app_required": "Desktop app required",
  "dashboard.directory": "Directory",
  "dashboard.directory_auto_placeholder": "(auto)",
  "dashboard.export_already_running": "Export is already running.",
  "dashboard.export_desktop_only": "Export is available in the desktop app.",
  "dashboard.export_local_desktop_only":
    "Export is available for local workers in the desktop app.",
  "dashboard.export_local_only": "Export is only supported for local workers.",
  "dashboard.invite_link_collaborator_hint":
    "One link that prefills the worker URL and collaborator token.",
  "dashboard.invite_link_owner_hint":
    "One link that prefills the worker URL and owner token for permission prompts.",
  "dashboard.invite_link_short_hint":
    "One link that prefills worker URL and token.",
  "dashboard.kind_local": "Local",
  "dashboard.kind_remote": "Remote",
  "dashboard.local_host_not_ready": "Local SuperClaw host is not ready yet.",
  "dashboard.missing_openwork_host": "Missing SuperClaw host URL.",
  "dashboard.missing_openwork_token": "Missing SuperClaw token.",
  "dashboard.navigation": "Navigation",
  "dashboard.new_task_label": "New task",
  "dashboard.no_server_connection": "No server connection",
  "dashboard.no_skills_in_workspace": "No skills found in this workspace.",
  "dashboard.open_navigation": "Open navigation",
  "dashboard.opencode_base_url": "OpenCode base URL",
  "dashboard.openwork_host_token_required":
    "SuperClaw host URL and token are required.",
  "dashboard.openwork_invite_link": "SuperClaw invite link",
  "dashboard.openwork_worker_url": "SuperClaw worker URL",
  "dashboard.owner_token": "Owner token",
  "dashboard.owner_token_host_hint":
    "Use on phones or laptops connecting to this host when the remote client must answer permission prompts.",
  "dashboard.provider_auth_in_progress":
    "Provider auth is already in progress.",
  "dashboard.publish_profile_failed": "Failed to publish workspace profile",
  "dashboard.publish_skills_failed": "Failed to publish skills set",
  "dashboard.resize_workspace_column": "Resize workspace column",
  "dashboard.resolve_worker_host_failed":
    "Could not resolve this worker on the SuperClaw host.",
  "dashboard.resolve_worker_local_failed":
    "Could not resolve this worker on the local SuperClaw host.",
  "dashboard.select_worker_first": "Select a worker first.",
  "dashboard.set_token_in_advanced": "Set token in Advanced",
  "dashboard.share_links_openwork_only":
    "Share service links are available for SuperClaw workers.",
  "dashboard.share_note_direct_runtime":
    "Engine runtime is set to Direct. Switching local workers can restart the host and disconnect clients. The token may change after a restart.",
  "dashboard.starting_server": "Starting server...",
  "dashboard.tab_agent": "Agents",
  "dashboard.tab_channel": "Connections",
  "dashboard.tab_cloud": "Cloud",
  "dashboard.tab_config": "Config",
  "dashboard.tab_app_settings": "General",
  "dashboard.tab_privacy": "Privacy",
  "dashboard.license_agreement": "License Agreement",
  // Screen-reader-only tail on the License control: it sits in the Settings nav but
  // opens the browser, which sighted users learn from its external-link icon.
  "dashboard.opens_in_browser": "opens in your browser",
  "dashboard.tab_mcp": "MCP",
  "dashboard.tab_model": "Model Routing",
  "dashboard.tab_scheduler": "Schedulers",
  "dashboard.tab_voice": "Dictation",
  "dashboard.tab_skill": "Skills",
  "dashboard.version_label": "Version:",
  "dashboard.version_short": "v.",
  "dashboard.worker": "Worker",
  "dashboard.worker_url_hint_phones":
    "Use on phones or laptops connecting to this worker.",
  "dashboard.worker_url_resolving_hint":
    "Worker URL is resolving; host URL shown as fallback.",

  // Other words the Settings search finds each section by, comma-separated.
  "dashboard.tab_app_settings_keywords": "settings, preferences, options",
  "dashboard.tab_model_keywords": "auto route, routing, local model, cloud model, LLM, AI model",
  "dashboard.tab_privacy_keywords": "security, protection, confidential",
  "dashboard.tab_channel_keywords": "Slack, Telegram, GitHub, Gmail, integrations, accounts, services",
  "dashboard.tab_voice_keywords": "voice input, microphone, mic, dictation, speech, talk, speech to text",
  "dashboard.tab_agent_keywords": "custom agent, assistant, persona, subagent",
  "dashboard.tab_skill_keywords": "plugins, abilities, skill hub",
  "dashboard.tab_mcp_keywords": "Model Context Protocol, tools, servers, extensions",
  "dashboard.tab_scheduler_keywords": "schedule, scheduled tasks, automation, recurring, cron, timer",
} as const;
