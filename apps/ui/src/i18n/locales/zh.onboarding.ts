/** Chinese-language strings for the onboarding domain. Merged in zh.ts. */
export default {
  "welcome.title": "欢迎使用 SuperClaw",
  "welcome.subtitle": "让我们开始吧",

  // ==================== Status Bar ====================
  "onboarding.starting_host": "正在启动 SuperClaw 服务器...",
  "onboarding.searching_host": "正在连接 SuperClaw 服务器...",
  "onboarding.getting_ready": "准备就绪",
  "onboarding.verifying": "验证安全握手",
  "onboarding.create_first_workspace": "创建您的第一个工作区",
  "onboarding.create_workspace": "创建工作区",
  "onboarding.start": "启动 SuperClaw",
  "onboarding.back": "返回",
  "onboarding.advanced_settings": "高级设置",
  "onboarding.checking_cli": "正在检查 OpenCode CLI...",
  "onboarding.cli_not_found": "未找到 OpenCode CLI。",
  "onboarding.cli_needs_update": "OpenCode CLI 需要更新以支持 serve。",
  "onboarding.cli_ready": "OpenCode CLI 就绪。",
  "onboarding.cli_version": "OpenCode {version}",
  "onboarding.windows_install_instruction":
    "安装 Windows 版 OpenCode，然后重启 SuperClaw。确保 opencode.exe 在 PATH 中。",
  "onboarding.install_instruction":
    "安装 OpenCode 以启用本地服务器（无需终端）。",
  "onboarding.install": "安装 OpenCode",
  "onboarding.ready_message": "OpenCode 已准备好启动本地服务器。",
  "onboarding.resolved_path": "解析路径",
  "onboarding.version": "版本",
  "onboarding.search_notes": "搜索说明",
  "onboarding.serve_help": "serve --help 输出",
  "onboarding.workspace_folder_label":
    "工作区是一个包含自己的 skills、插件和命令的文件夹。",
  "onboarding.theme_label": "主题",
  "onboarding.theme_current": "当前：{mode}",
  "onboarding.theme_system": "系统",
  "onboarding.theme_light": "浅色",
  "onboarding.theme_dark": "深色",
  "onboarding.access_label": "访问权限",
  "onboarding.folders_allowed": "{count} 个文件夹{plural}已授权",
  "onboarding.manage_access_hint": "您可以在高级设置中管理访问权限。",
  "onboarding.open_settings_hint": "需要引擎或访问选项？打开设置。",
  "onboarding.open_settings": "打开设置",
  "onboarding.add_folder_path": "添加文件夹路径",
  "onboarding.pick": "选择",
  "onboarding.add": "添加",
  "onboarding.remove": "移除",
  "onboarding.cli_label": "OpenCode CLI",
  "onboarding.cli_checking": "正在检查安装...",
  "onboarding.cli_not_found_hint": "未找到。请安装以运行本地服务器。",
  "onboarding.cli_version_installed": "已安装",
  "onboarding.cli_recheck": "重新检查",
  "onboarding.cli_install_commands":
    "使用以下命令之一安装 OpenCode，然后重启 SuperClaw。",
  "onboarding.show_search_notes": "显示搜索说明",
  "onboarding.last_checked": "上次检查时间 {time}",
  "onboarding.fix_migration": "修复迁移",
  "onboarding.fixing_migration": "正在修复迁移...",
  "onboarding.fix_migration_hint":
    "会停止本地引擎，执行 opencode db migrate，然后重试启动。",
  "onboarding.remote_workspace_title": "连接 SuperClaw 服务器",
  "onboarding.remote_workspace_description":
    "连接 SuperClaw 服务器以随时访问工作区。",
  "onboarding.remote_workspace_action": "连接",
  "onboarding.remote_workspace_card_title": "连接远程工作区",
  "onboarding.remote_workspace_card_description":
    "连接 SuperClaw 服务器以访问共享工作区。",
  "onboarding.welcome_title": "今天想如何运行 SuperClaw？",
  "onboarding.run_local": "本地运行",
  "onboarding.run_local_description":
    "SuperClaw 在本地运行并保持您的工作私密。",
  "onboarding.engine_running": "引擎已在运行",
  "onboarding.attach_description": "附加到此设备上的现有会话。",
  "onboarding.attach": "附加",
  "onboarding.remember_choice": "记住我的选择",
  "onboarding.authorize_folder": "授权文件夹",
  "onboarding.choose_workspace_folder": "选择工作区文件夹",

  // ==================== Common ====================
  "tour.attach_files.title": "工作区文件面板",
  "tour.attach_files.body":
    "此面板显示工作区中的所有文件和文件夹，包括您上传的以及由代理生成的内容。您可以在此处统一查看和管理所有内容。",
  "tour.choose_agent.title": "选择助手模式",
  "tour.choose_agent.body":
    "助手模式是专业化的工作方式。默认模式适用于大多数任务；切换其他模式可用于更具体的工作流程。",
  "tour.model_selection.title": "模型选择",
  "tour.model_selection.body":
    "选择当前会话使用的 AI 模型。本地模型保护数据隐私；云端模型功能最强。Auto Route 会根据您的任务自动选择合适的模型。",
  "tour.model_selection.cloud_only.body":
    "云端模型提供最强的功能。添加提供商和 API 密钥以开始使用，或在设置 → 模型路由中配置 Edge 服务器来启用本地模型。",
  "tour.sessions.title": "开始新任务",
  "tour.sessions.body":
    "点击“新建任务”开始新的对话或随时返回历史会话继续进行。",
  "tour.data_usage.title": "数据与用量",
  "tour.data_usage.body": "在此工作区的所有任务中监控您的Token使用情况。",
  "tour.advanced_config.title": "设置",
  "tour.advanced_config.body":
    "配置模型、定时任务、技能、MCP、频道和智能体设置。自定义 SuperClaw 的工作方式，以满足您的需求。",
  "tour.nav.skip": "跳过导览",
  "tour.nav.close": "关闭导览",
  "tour.nav.back": "上一步",
  "tour.nav.next": "下一步",
  "tour.nav.done": "完成",
  // ==================== zh-parity wiring batch 2026-06-04 (settings/identities/dashboard/scheduled) ====================
} as const;
