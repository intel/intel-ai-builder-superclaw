/** English-language strings for the skills domain. Merged in en.ts. */
export default {
  "share_skill_destination.title": "Where should this skill go?",
  "share_skill_destination.subtitle":
    "Choose an existing project or create a new one before importing this shared skill.",
  "share_skill_destination.skill_label": "Shared skill",
  "share_skill_destination.fallback_skill_name": "Shared skill",
  "share_skill_destination.trigger_label": "Trigger",
  "share_skill_destination.current_badge": "Current",
  "share_skill_destination.existing_workers": "Existing projects",
  "share_skill_destination.no_workers":
    "No projects are ready yet. Create one or connect a remote host to install this skill.",
  "share_skill_destination.new_destination": "New destination",
  "share_skill_destination.selected_badge": "Selected",
  "share_skill_destination.selected_hint":
    "Selected. Review the destination below, then confirm.",
  "share_skill_destination.footer_idle": "Choose a project to continue.",
  "share_skill_destination.footer_selected": "Selected project:",
  "share_skill_destination.confirm_button": "Add skill to project",
  "share_skill_destination.confirm_busy": "Adding skill...",
  "share_skill_destination.local_badge": "Local",
  "share_skill_destination.remote_badge": "Remote",
  "share_skill_destination.create_worker": "Create new project",
  "share_skill_destination.create_worker_desc":
    "Open the project setup flow, then add this skill after the new project is ready.",
  "share_skill_destination.connect_remote": "Connect remote host",
  "share_skill_destination.connect_remote_desc":
    "Attach a SuperClaw host, then choose it from the list to import this skill.",
  "skills.title": "Skills",
  "skills.refresh": "Refresh",
  "skills.host_mode_only": "Local worker only",
  "skills.installed_label": "Installed",
  "skills.import_local": "Import local skill",
  "skills.import_local_hint":
    "Copy an existing skill folder into this worker (folder name must match the skill name).",
  "skills.installed": "Installed skills",
  "skills.no_skills":
    "No skills detected in `.opencode/skills`, `.claude/skills`, or `~/.agents/skills`.",
  "skills.desktop_required": "Skill management requires the desktop app.",
  "skills.host_only_error":
    "Skill management requires a local worker or connected SuperClaw server.",
  "skills.install_skill_creator_hint":
    "This skill allows you to create other skills from within the chat.",
  "skills.install_skill_finder_hint":
    "Describe what you need; search GitHub repos and skill marketplaces for a matching skill.",
  "skills.installing_skill_finder": "Installing skill finder...",
  "skills.skill_finder_installed": "Skill finder installed.",
  "skills.skill_finder_already_installed": "Skill finder is already installed.",
  "skills.installing_skill_creator": "Installing skill creator...",
  "skills.skill_creator_installed": "Skill creator installed.",
  "skills.skill_creator_already_installed":
    "Skill creator is already installed.",
  "skills.install_failed": "Skill install failed.",
  "skills.reveal_failed": "Failed to open skills folder.",
  "skills.uninstall": "Uninstall",
  "skills.uninstall_title": "Uninstall skill?",
  "skills.uninstall_warning":
    "This will permanently delete the `{name}` skill from your worker.",
  "skills.uninstall_failed": "Failed to uninstall skill.",
  "skills.uninstalled": "Skill removed.",
  "skills.pick_workspace_first": "Pick a worker folder first.",
  "skills.no_skills_found": "No skills found yet.",
  "skills.failed_to_load": "Failed to load skills",
  "skills.plugin_management_host_only":
    "Plugin management requires the desktop app.",
  "skills.plugins_host_only": "Plugins are only available in the desktop app.",
  "skills.pick_project_for_plugins":
    "Pick a project folder to manage project plugins.",
  "skills.pick_project_for_active":
    "Pick a project folder to load active plugins.",
  "skills.no_opencode_found":
    "No opencode.json found yet. Add a plugin to create one.",
  "skills.no_opencode_workspace": "No opencode.json in this worker yet.",
  "skills.failed_parse_opencode": "Failed to parse opencode.json",
  "skills.failed_load_opencode": "Failed to load opencode.json",
  "skills.failed_load_active": "Failed to load active plugins.",
  "skills.enter_plugin_name": "Enter a plugin package name.",
  "skills.plugin_already_listed": "Plugin already listed in opencode.json.",
  "skills.failed_update_opencode": "Failed to update opencode.json",
  "skills.pick_project_first": "Pick a project folder first.",
  "skills.select_skill_folder": "Select skill folder",
  "skills.import_skill_file_title": "Import SKILL.md file",
  "skills.import_skill_file_hint":
    "Import a single SKILL.md file (must be named SKILL.md).",
  "skills.import_failed": "Import failed ({status})",
  "skills.imported": "Imported.",
  "skills.imported_named": "Imported {name}.",
  "skills.installed_named": "Installed {name}.",
  "skills.saved": "Saved.",
  "skills.unknown_error": "Unknown error",
  "skills.local_workers_required_import":
    "Local workers are required to import skills.",
  "skills.select_exact_skill_md":
    "Please select a file named exactly 'SKILL.md' (all uppercase).",
  "skills.selected_folder_not_skill":
    "Selected folder is not a skill: no SKILL.md at its root.",
  "skills.selected_file_parent_unresolved":
    "Failed to resolve the selected file's parent folder.",
  "skills.selected_skill_md_excluded_by_scan":
    "Selected SKILL.md was excluded from the folder scan. Move it into a smaller folder and try again.",
  "skills.selected_skill_md_not_in_scan":
    "Selected SKILL.md was not returned by the folder scan.",
  "skills.validation_name_kebab":
    "The name field must be kebab-case, 1-64 chars: lowercase letters/digits separated by single hyphens, with no leading/trailing '-' and no '--'.",
  "skills.validation_description_length":
    "The description field must be 1-1024 characters.",
  "skills.create_new": "Create New Skill",
  "skills.create_name_match_hint":
    "Name must match the name in SKILL.md YAML exactly.",
  "skills.create_yaml_label": "SKILL.md YAML",
  "skills.create_body_label": "SKILL.md body",
  "skills.create_action": "Create Skill",
  "skills.creating": "Creating...",
  "skills.create_exists": 'Skill "{name}" already exists.',
  "skills.create_invalid_markdown": "Invalid SKILL.md content.",
  "skills.create_success": 'Created skill "{name}".',
  "skills.create_failed": "Failed to create skill.",
  "skills.search_installed_placeholder": "Search installed or hub skills",
  "skills.install_from_link": "Install from link",
  "skills.install_from_link_desc":
    "Paste an OpenWork bundle URL or a GitHub SKILL.md link, preview it, then install.",
  "skills.link_label": "Link",
  "skills.install_link_placeholder":
    "https://share.openwork.software/b/... or https://github.com/owner/repo/blob/main/path/to/SKILL.md",
  "skills.preview": "Preview",
  "skills.skill_label": "Skill:",
  "skills.name_already_installed":
    "A skill with this name is already installed.",
  "skills.installing": "Installing...",
  "skills.keep_both": "Keep both",
  "skills.overwrite": "Overwrite",
  "skills.editor_name_label": "Name",
  "skills.editor_name_locked_hint":
    "Name is locked to the skill folder and cannot be edited here.",
  "skills.editor_frontmatter_label": "Frontmatter YAML",
  "skills.editor_frontmatter_hint":
    "Required: description. Optional: license, compatibility, metadata (string-to-string map). Unknown keys are ignored.",
  "skills.editor_body_label": "Body",
  "skills.editor_error_failed_load": "Failed to load skill.",
  "skills.editor_error_failed_save": "Failed to save skill.",
  "skills.create_chat_action": "Create with AI chat",
  "skills.import_action": "Import from files",
  "skills.install_link_action": "Install from URL",
  "skills.import_dialog_hint": "Choose how to import an existing skill.",
  "skills.error_generic": "Something went wrong",
  "skills.custom_repo_owner_repo_required": "Owner and repo are required.",
  "skills.preview_link_required": "Paste a link to preview",
  "skills.github_skill_md_only": "Only GitHub links to SKILL.md are supported",
  "skills.fetch_skill_md_failed": "Failed to fetch SKILL.md ({status}){detail}",
  "skills.fetch_bundle_failed": "Failed to fetch bundle ({status}){detail}",
  "skills.link_not_openwork_bundle":
    "This link is not an OpenWork skill bundle",
  "skills.bundle_missing_name": "Bundle is missing a skill name",
  "skills.bundle_missing_content": "Bundle is missing skill content",
  "skills.hub_no_skills_found": "No hub skills found.",
  "skills.hub_failed_to_load": "Failed to load hub skills.",
  "skills.validation_name_required_short": "Skill name is required.",
  "skills.source_missing": "Skill source information is missing.",
  "skills.offline_skill_not_found": "Bundled offline skill not found.",
  "skills.openwork_unavailable_install":
    "OpenWork server unavailable. Connect to install skills.",
  "skills.openwork_unavailable_load":
    "OpenWork server unavailable. Connect to load skills.",
  "skills.openwork_unavailable_view":
    "OpenWork server unavailable. Connect to view skills.",
  "skills.openwork_unavailable_edit":
    "OpenWork server unavailable. Connect to edit skills.",
  "skills.openwork_write_required_uninstall":
    "OpenWork server with write access is required to uninstall skills on a remote worker.",
  "skills.opencode_client_unavailable": "OpenCode client unavailable.",
  "skills.online_hub_disabled":
    "Online GitHub hub is disabled. Only offline bundled skills are supported.",
  "skills.local_workers_required_view":
    "Local workers are required to view skills.",
  "skills.local_workers_required_edit":
    "Local workers are required to edit skills.",
  "skills.local_workers_required_install":
    "Local workers are required to install skills.",
  "skills.installed_partial_openwork":
    "Installed {name}; {count} additional file(s) require OpenWork server.",
  "skills.validation_invalid_format":
    "Invalid SKILL.md format. Add a frontmatter block between '---' lines.",
  "skills.validation_yaml_invalid_at":
    "Skill YAML format is invalid at line {line}, col {col}. Please check the Frontmatter YAML.",
  "skills.validation_yaml_invalid":
    "Skill YAML format is invalid. Please check the Frontmatter YAML.",
  "skills.validation_frontmatter_mapping":
    "Frontmatter must be a YAML mapping (key/value object).",
  "skills.validation_name_required":
    "Frontmatter is missing required field: name.",
  "skills.validation_description_required":
    "Frontmatter is missing required field: description.",
  "skills.validation_license_string":
    "'license' must be a string when provided.",
  "skills.validation_compatibility_string":
    "'compatibility' must be a string when provided.",
  "skills.validation_metadata_mapping":
    "'metadata' must be a mapping of string keys to string values.",
  "skills.validation_folder_name_match":
    "Skill folder name '{expected}' must match the 'name' '{actual}' declared in SKILL.md.",

  // ==================== Plugins ====================

  // ==================== Apps (MCP) ====================
} as const;
