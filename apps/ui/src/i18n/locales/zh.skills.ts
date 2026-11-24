/** Chinese-language strings for the skills domain. Merged in zh.ts. */
export default {
  "share_skill_destination.title": "此技能应添加到哪里？",
  "share_skill_destination.subtitle":
    "在导入此共享技能前，请选择现有项目或创建一个新项目。",
  "share_skill_destination.skill_label": "共享技能",
  "share_skill_destination.trigger_label": "触发器",
  "share_skill_destination.current_badge": "当前",
  "share_skill_destination.existing_workers": "现有项目",
  "share_skill_destination.no_workers":
    "尚无可用项目。请创建一个项目或连接远程主机以安装此技能。",
  "share_skill_destination.new_destination": "新建目标",
  "share_skill_destination.selected_badge": "已选择",
  "share_skill_destination.selected_hint": "已选择。请在下方确认目标后继续。",
  "share_skill_destination.footer_idle": "选择一个项目以继续。",
  "share_skill_destination.footer_selected": "已选择项目：",
  "share_skill_destination.confirm_button": "将技能添加到项目",
  "share_skill_destination.confirm_busy": "正在添加技能...",
  "share_skill_destination.local_badge": "本地",
  "share_skill_destination.remote_badge": "远程",
  "share_skill_destination.create_worker": "创建新项目",
  "share_skill_destination.create_worker_desc":
    "打开项目设置流程，待新项目就绪后再添加此技能。",
  "share_skill_destination.connect_remote": "连接远程主机",
  "share_skill_destination.connect_remote_desc":
    "接入一个 SuperClaw 主机，然后从列表中选择它以导入此技能。",
  "share_skill_destination.fallback_skill_name": "共享技能",

  // ==================== Workspace ====================
  "skills.title": "技能",
  "skills.refresh": "刷新",
  "skills.host_mode_only": "仅本地工作区",
  "skills.installed_label": "已安装",
  "skills.import_local": "导入本地 skill",
  "skills.import_local_hint":
    "将现有 skill 文件夹复制到此工作区（文件夹名必须与 skill 名一致）。",
  "skills.installed": "已安装的 skills",
  "skills.no_skills":
    "在 `.opencode/skills`、`.claude/skills` 或 `~/.agents/skills` 中未检测到 skills。",
  "skills.desktop_required": "技能管理需要桌面应用。",
  "skills.host_only_error":
    "技能管理需要本地工作区或已连接的 SuperClaw 服务器。",
  "skills.install_skill_creator_hint":
    "此 skill 可让你在聊天中创建其他 skills。",
  "skills.install_skill_finder_hint":
    "描述你的需求；在 GitHub 仓库和技能市场中搜索匹配技能。",
  "skills.installing_skill_finder": "正在安装技能查找器...",
  "skills.skill_finder_installed": "技能查找器已安装。",
  "skills.skill_finder_already_installed": "技能查找器已经安装过了。",
  "skills.installing_skill_creator": "正在安装 skill creator...",
  "skills.skill_creator_installed": "Skill creator 已安装。",
  "skills.skill_creator_already_installed": "Skill creator 已经安装过了。",
  "skills.install_failed": "技能安装失败。",
  "skills.reveal_failed": "打开 skills 文件夹失败。",
  "skills.uninstall": "卸载",
  "skills.uninstall_title": "卸载 skill？",
  "skills.uninstall_warning": "这将永久从工作区删除 `{name}` skill。",
  "skills.uninstall_failed": "卸载 skill 失败。",
  "skills.uninstalled": "Skill 已删除。",
  "skills.pick_workspace_first": "先选择一个工作区文件夹。",
  "skills.no_skills_found": "还没有找到技能。",
  "skills.failed_to_load": "加载技能失败",
  "skills.plugin_management_host_only": "插件管理需要桌面应用。",
  "skills.plugins_host_only": "插件仅在桌面应用中可用。",
  "skills.pick_project_for_plugins": "选择项目文件夹以管理项目插件。",
  "skills.pick_project_for_active": "选择项目文件夹以加载活动插件。",
  "skills.no_opencode_found": "尚未找到 opencode.json。添加插件以创建一个。",
  "skills.no_opencode_workspace": "此工作区中还没有 opencode.json。",
  "skills.failed_parse_opencode": "解析 opencode.json 失败",
  "skills.failed_load_opencode": "加载 opencode.json 失败",
  "skills.failed_load_active": "加载活动插件失败。",
  "skills.enter_plugin_name": "输入插件包名称。",
  "skills.plugin_already_listed": "插件已在 opencode.json 中列出。",
  "skills.failed_update_opencode": "更新 opencode.json 失败",
  "skills.pick_project_first": "先选择一个项目文件夹。",
  "skills.select_skill_folder": "选择 skill 文件夹",
  "skills.import_skill_file_title": "导入 SKILL.md 文件",
  "skills.import_skill_file_hint":
    "导入单个 SKILL.md 文件（文件名必须为 SKILL.md）。",
  "skills.import_failed": "导入失败（{status}）",
  "skills.imported": "已导入。",
  "skills.imported_named": "已导入 {name}。",
  "skills.installed_named": "已安装 {name}。",
  "skills.saved": "已保存。",
  "skills.unknown_error": "未知错误",
  "skills.local_workers_required_import": "导入技能需要本地工作区。",
  "skills.select_exact_skill_md":
    "请选择文件名严格为 'SKILL.md'（全大写）的文件。",
  "skills.selected_folder_not_skill":
    "所选文件夹不是 skill：其根目录下缺少 SKILL.md。",
  "skills.selected_file_parent_unresolved": "无法解析所选文件的父目录。",
  "skills.selected_skill_md_excluded_by_scan":
    "所选 SKILL.md 未包含在文件夹扫描结果中。请将其放到更小的目录后重试。",
  "skills.selected_skill_md_not_in_scan":
    "所选 SKILL.md 不在文件夹扫描结果中。",
  "skills.validation_name_kebab":
    "name 字段必须为 kebab-case，长度 1-64：仅允许小写字母/数字，用单个连字符分隔，不能以 '-' 开头或结尾，也不能包含 '--'。",
  "skills.validation_description_length":
    "description 字段长度必须在 1-1024 个字符之间。",
  "skills.create_new": "创建新技能",
  "skills.create_name_match_hint":
    "名称必须与 SKILL.md YAML 中的 name 完全一致。",
  "skills.create_yaml_label": "SKILL.md YAML",
  "skills.create_body_label": "SKILL.md 正文",
  "skills.create_action": "创建技能",
  "skills.creating": "创建中...",
  "skills.create_exists": '技能 "{name}" 已存在。',
  "skills.create_invalid_markdown": "SKILL.md 内容无效。",
  "skills.create_success": '已创建技能 "{name}"。',
  "skills.create_failed": "创建技能失败。",
  "skills.search_installed_placeholder": "搜索已安装或 Hub 中的技能",
  "skills.install_from_link": "从链接安装",
  "skills.install_from_link_desc":
    "粘贴 OpenWork bundle 链接或 GitHub SKILL.md 链接，先预览再安装。",
  "skills.link_label": "链接",
  "skills.install_link_placeholder":
    "https://share.openwork.software/b/... 或 https://github.com/owner/repo/blob/main/path/to/SKILL.md",
  "skills.preview": "预览",
  "skills.skill_label": "技能：",
  "skills.name_already_installed": "同名技能已安装。",
  "skills.installing": "安装中...",
  "skills.keep_both": "全部保留",
  "skills.overwrite": "覆盖",
  "skills.editor_name_label": "名称",
  "skills.editor_name_locked_hint": "名称与技能目录绑定，不能在这里编辑。",
  "skills.editor_frontmatter_label": "Frontmatter YAML",
  "skills.editor_frontmatter_hint":
    "必填：description。可选：license、compatibility、metadata（字符串到字符串映射）。未知字段会被忽略。",
  "skills.editor_body_label": "正文",
  "skills.editor_error_failed_load": "加载技能失败。",
  "skills.editor_error_failed_save": "保存技能失败。",
  "skills.create_chat_action": "AI 对话创建",
  "skills.import_action": "从文件导入",
  "skills.install_link_action": "从链接安装",
  "skills.import_dialog_hint": "选择导入已有技能的方式。",
  "skills.error_generic": "发生了未知错误",
  "skills.custom_repo_owner_repo_required": "Owner 和 repo 不能为空。",
  "skills.preview_link_required": "请粘贴链接后再预览",
  "skills.github_skill_md_only": "仅支持指向 SKILL.md 的 GitHub 链接",
  "skills.fetch_skill_md_failed": "获取 SKILL.md 失败（{status}）{detail}",
  "skills.fetch_bundle_failed": "获取 bundle 失败（{status}）{detail}",
  "skills.link_not_openwork_bundle": "该链接不是 OpenWork skill bundle",
  "skills.bundle_missing_name": "bundle 缺少 skill 名称",
  "skills.bundle_missing_content": "bundle 缺少 skill 内容",
  "skills.hub_no_skills_found": "未找到 Hub 技能。",
  "skills.hub_failed_to_load": "加载 Hub 技能失败。",
  "skills.validation_name_required_short": "Skill 名称不能为空。",
  "skills.source_missing": "缺少 skill 来源信息。",
  "skills.offline_skill_not_found": "未找到离线内置技能。",
  "skills.openwork_unavailable_install":
    "OpenWork 服务器不可用。请连接后再安装技能。",
  "skills.openwork_unavailable_load":
    "OpenWork 服务器不可用。请连接后再加载技能。",
  "skills.openwork_unavailable_view":
    "OpenWork 服务器不可用。请连接后再查看技能。",
  "skills.openwork_unavailable_edit":
    "OpenWork 服务器不可用。请连接后再编辑技能。",
  "skills.openwork_write_required_uninstall":
    "远程工作区卸载技能需要 OpenWork 服务器写权限。",
  "skills.opencode_client_unavailable": "OpenCode 客户端不可用。",
  "skills.online_hub_disabled":
    "在线 GitHub Hub 已禁用。当前仅支持离线内置技能。",
  "skills.local_workers_required_view": "查看技能需要本地工作区。",
  "skills.local_workers_required_edit": "编辑技能需要本地工作区。",
  "skills.local_workers_required_install": "安装技能需要本地工作区。",
  "skills.installed_partial_openwork":
    "已安装 {name}；另有 {count} 个附加文件需要 OpenWork 服务器。",
  "skills.validation_invalid_format":
    "SKILL.md 格式无效。请在 '---' 之间添加 frontmatter。",
  "skills.validation_yaml_invalid_at":
    "Skill YAML 格式无效（第 {line} 行，第 {col} 列）。请检查 Frontmatter YAML。",
  "skills.validation_yaml_invalid":
    "Skill YAML 格式无效。请检查 Frontmatter YAML。",
  "skills.validation_frontmatter_mapping":
    "Frontmatter 必须是 YAML 键值映射对象。",
  "skills.validation_name_required": "Frontmatter 缺少必填字段：name。",
  "skills.validation_description_required":
    "Frontmatter 缺少必填字段：description。",
  "skills.validation_license_string": "提供 license 时，其值必须是字符串。",
  "skills.validation_compatibility_string":
    "提供 compatibility 时，其值必须是字符串。",
  "skills.validation_metadata_mapping": "metadata 必须是字符串到字符串的映射。",
  "skills.validation_folder_name_match":
    "技能文件夹名 '{expected}' 必须与 SKILL.md 中声明的 name '{actual}' 一致。",

  // ==================== Plugins ====================

  // ==================== MCP (Model Context Protocol) ====================
} as const;
