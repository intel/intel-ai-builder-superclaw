/** English-language strings for the agents domain. Merged in en.ts. */
export default {
  "agents.name": "Agents",
  "agents.create_agent": "Create Agent",
  "agents.delete_agent": "Delete Agent",
  "agents.delete_confirmation":
    'Are you sure you want to delete agent "{name}"? This will remove the agent file and cannot be undone.',
  "agents.your_agent": "Your Agents",
  "agents.no_custom_agents": "No custom agents yet. Create one below.",
  "agents.create_new": "Create New Agent",
  "agents.configuration_card": "Config",
  "agents.details_label": "Details",
  "agents.custom_skills_mcp_heading": "Custom skills · MCP",
  "agents.hint":
    "Used as the filename. Letters, numbers, hyphens, and underscores are allowed. Example: my-agent",
  "agents.name_no_spaces":
    "Name cannot contain spaces. Use hyphens or underscores instead.",
  "agents.description_title": "Description",
  "agents.description_placeholder": "What does this agent do?",
  "agents.edit_mode_form": "Form",
  "agents.edit_mode_markdown": "Markdown",
  "agents.edit_name_readonly": "The name is the agent's file name and can't be changed here.",
  "agents.edit_form_scope":
    "Tools, skills, permissions and the system prompt are kept as they are. To change them, switch to Markdown.",
  "agents.edit_form_unsupported":
    "This file's frontmatter uses YAML the form can't edit safely (for example a flow mapping, or an anchor other fields refer to). Edit it in Markdown.",
  "agents.upload_hint": "Click to choose an .md file to upload",
  "agents.upload_success": "Loaded {name}",
  "agents.upload_invalid_type": "Please upload a Markdown (.md) file.",
  "agents.upload_empty": "The selected Markdown file is empty.",
  "agents.upload_parse_error_prefix": "Could not parse this agent Markdown. ",
  "agents.upload_parse_error_fields":
    "Please fix these fields and upload again: {fields}.",
  "agents.upload_autofill_success": "Auto-filled fields: {fields}",
  "agents.quick_setup_next_step":
    "Next: click Create Agent below to finish creating your agent.",
  "agents.field_frontmatter": "frontmatter section (--- ... ---)",
  "agents.field_name": "name",
  "agents.field_description": "description",
  "agents.field_system_prompt": "system prompt",
  "agents.tools_skills_field": "tools & skills",
  "agents.create_success": 'Agent "{name}" created successfully.',
  "agents.quick_setup_title": "Quick Setup",
  "agents.custom_setup_title": "Custom Setup",
  "agents.preconfigured_agents_title": "Preconfigured Agents",
  "agents.upload_section_title": "Upload Agent",
  "agents.click_to_view_details": "Click to view details",
  "agents.open_category_details": "Open {name} details",
  "agents.high_permission_confirm":
    "Enable Advanced for {name}? This unlocks stronger capabilities and may require approval prompts.",
  "agents.permission_low_label": "Basic",
  "agents.permission_high_label": "Advanced",
  "agents.permission_low_short": "Basic",
  "agents.permission_high_short": "Advanced",
  "agents.permission_disabled_short": "Disabled",
  "agents.permission_disabled_label": "Disabled",
  "agents.package_low_line_file_code_engine":
    "Read, search, and inspect files/code (including OCR) with no write operations.",
  "agents.package_high_added_line_file_code_engine":
    "Add document/table skills (PDF, DOCX, PPTX, spreadsheet), code writes, and command execution.",
  "agents.package_low_line_email_calendar_operations":
    "Read and summarize inbox/calendar context for planning.",
  "agents.package_high_added_line_email_calendar_operations":
    "Add email send/reply and meeting scheduling actions.",
  "agents.package_low_line_web_research_retrieval":
    "Retrieve web evidence and summarize findings.",
  "agents.package_high_added_line_web_research_retrieval":
    "Add broader trend-intelligence retrieval workflows.",
  "agents.toggle_risk_selection": "Toggle {name} package",
  "agents.back_to_categories": "Back",
  "agents.category_detail_included_hint": "Included for your agent.",
  "agents.permissions_label": "Permissions",
  "agents.tools_label": "Tools",
  "agents.skills_label": "Skills",
  "agents.no_tools_found": "No tools found",
  "agents.no_skills_found": "No skills found",
  "agents.category_file_code_engine_label": "File & Code Engine",
  "agents.category_file_code_engine_description":
    "Source-file navigation, code editing, and command execution controls.",
  "agents.category_email_calendar_operations_label":
    "Email & Calendar Operations",
  "agents.category_email_calendar_operations_description":
    "Inbox intelligence, response workflows, and scheduling actions.",
  "agents.category_web_research_retrieval_label": "Web & Research Retrieval",
  "agents.category_web_research_retrieval_description":
    "Web evidence lookup and trend-oriented research retrieval.",
  "agents.capabilities_section_label": "Capabilities",
  "agents.agent_description_unavailable": "No description.",
  "agents.category_custom_skills_mcp_tools_label": "Custom Skills & MCP",
  "agents.custom_skills_section_label": "SKILLS",
  "agents.custom_mcp_tools_section_label": "MCP",
  "agents.protected_file_pipeline_label": "Protected File Pipeline",
  "agents.protected_file_pipeline_description":
    "Allow this agent to request supported sensitive files through the user-approved protection flow. Each request checks protection first. If declined or disabled, the request is delegated to local-file-agent using the active Product Profile's model routing. A failed protected pipeline does not use this fallback.",
  "agents.protected_file_pipeline_permissions_intro": "When enabled, this capability uses these permissions:",
  "agents.protected_file_pipeline_confirm_permission": "Ask for confirmation",
  "agents.protected_file_pipeline_agent_permission": "Allowed after approval",
  "agents.protected_file_pipeline_tool_permission": "Used by protected-file-agent; not granted directly",
  "agents.protected_file_pipeline_local_agent_permission": "Allowed when protection is declined or disabled",
  "agents.custom_none_found": "No items found.",
  "agents.system_prompt_card": "System Prompt",
  "agents.system_prompt_hint": "You are an expert at...",
  "agents.system_instructions": "Supports Markdown.",
  "agents.tools_skills_card": "Tools and Skills",
  "agents.validation_invalid_format":
    "Invalid Agent Markdown format. Add a frontmatter block between '---' lines.",
  "agents.validation_yaml_invalid_at":
    "Agent YAML format is invalid at line {line}, col {col}. Please check the Frontmatter YAML.",
  "agents.validation_yaml_invalid":
    "Agent YAML format is invalid. Please check the Frontmatter YAML.",
  "agents.validation_frontmatter_mapping":
    "Frontmatter must be a YAML mapping (key/value object).",
  "agents.validation_description_required":
    "Frontmatter is missing required field: description.",
  "agents.validation_mode_required":
    "Frontmatter is missing required field: mode.",
  "agents.validation_permission_required":
    "Frontmatter is missing required field: permission mapping.",
  "agents.validation_mode_enum":
    "'mode' must be one of: primary, subagent, all.",
  "agents.validation_system_prompt_required":
    "System prompt body cannot be empty.",
  "agents.validation_description_length":
    "'description' must be 1-1024 characters.",
  "agents.validation_name_pattern":
    "'name' may contain only letters, numbers, hyphens, and underscores.",
  "agents.validation_unknown_frontmatter":
    "Unknown frontmatter field: {field}.",
  "agents.validation_tool_key_not_allowed":
    "Tool permission key '{tool}' is not allowed.",
  "agents.validation_permission_key_not_allowed":
    "Permission key '{key}' is not allowed. Only '*', 'skill', 'task', and allowlisted tool keys are allowed.",
  "agents.validation_permission_block_mapping":
    "Permission block '{block}' must be a mapping containing only '*' key.",
  "agents.validation_permission_block_wildcard_required":
    "Permission block '{block}' must define '*' key.",
  "agents.validation_permission_block_unexpected_key":
    "Permission block '{block}' only allows '*' key; found '{key}'.",
  "agents.validation_permission_enum":
    "Permission values must be one of: allow, ask, deny.",
  "agents.validation_permission_value_shape":
    "Permission values must be a string (allow/ask/deny) or a nested permission mapping.",
  "agents.validation_permission_key_empty": "Permission keys cannot be empty.",

  "agents.skill_tooltip_pdf":
    "Read and analyze PDFs—content, pages, tables, and metadata.",
  "agents.skill_tooltip_docx":
    "Read and analyze Word (.docx) files—content, tables, and metadata.",
  "agents.skill_tooltip_docx-create":
    "Create Word (.docx) documents with a title page, table of contents, tables, and images.",
  "agents.skill_tooltip_pptx":
    "Read and analyze PowerPoint (.pptx) slides and presentation metadata.",
  "agents.skill_tooltip_pptx-create":
    "Create colourful PowerPoint (.pptx) decks with card, table and native chart layouts.",
  "agents.skill_tooltip_spreadsheet":
    "Read and analyze Excel (.xlsx) and CSV tabular data.",
  "agents.skill_tooltip_github": "Issues, PRs, repos, and code search via the `gh` CLI.",
  "agents.skill_tooltip_email":
    "Email and calendar pipeline—fetch, draft, send, schedule, and daily planning.",
  "agents.skill_tooltip_local-safety-guard":
    "Detects risky shell commands, limits edits to safe paths, and confirms before irreversible actions.",
  "agents.skill_tooltip_local-security-review":
    "Security checklist for auth, input, secrets, and API design.",
  "agents.skill_tooltip_humanizer-lite":
    "Make AI-sounding or stiff writing read natural without changing facts (humanize / de-AI).",
  "agents.skill_tooltip_frontend-design":
    "Distinctive UI direction—palette, typography, layout beyond template defaults.",
  "agents.skill_tooltip_news-summarizer":
    "Structured news briefs from a URL or pasted article text.",
  "agents.skill_tooltip_ocr-document-parse":
    "OCR scans and page images to Markdown locally (RapidOCR)—no vision model.",
  "agents.skill_tooltip_translate":
    "Accurate translation with formatting and locale-appropriate tone.",
  "agents.skill_tooltip_resume-tailor":
    "Tailor a resume to a job posting while staying truthful.",
  "agents.skill_tooltip_interview-prep-generator":
    "STAR stories, practice questions, and talking points from a resume.",
  "agents.skill_tooltip_skill-creator":
    "Create or update workspace skills—workflows, knowledge, and tool patterns.",
  "agents.skill_tooltip_skill-finder":
    "Search installed skills, GitHub skill repos, SkillHub, and ClawHub for an existing skill before creating a duplicate.",

  // ==================== Status ====================
} as const;
