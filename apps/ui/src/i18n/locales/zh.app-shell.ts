/** Chinese-language strings for the app-shell domain. Merged in zh.ts. */
export default {
  "error_boundary.root_title": "SuperClaw 遇到意外错误",
  "error_boundary.panel_title": "此部分加载失败",
  "error_boundary.retry": "重试",
  "error_boundary.reload": "重新加载",

  // ==================== Welcome Message ==============
  "status.superclaw_ready": "SuperClaw 已就绪",
  "status.mcp_connected": "MCP 已连接",
  "status.ready_for_new_task": "准备接受新任务",
  "status.provider_connected": "个服务商已连接",
  "status.providers_connected": "个服务商已连接",
  "feedback.label": "反馈",
  "feedback.send": "发送反馈",
  "feedback.opened": "已打开。",
  "feedback.open_failed": "打开失败。",
  "feedback.modal_title": "发送反馈",
  "feedback.modal_description":
    "告诉我们发生了什么，反馈会发送给 SuperClaw 团队。",
  "feedback.modal_footnote":
    "请说明发生了什么，以帮助我们改进产品。反馈将发送给 Intel 的 SuperClaw 团队。请勿在消息中包含密钥或个人数据。",
  "feedback.message_label": "反馈内容",
  "feedback.message_placeholder": "描述遇到的问题，或者你希望看到的改进",
  "feedback.category_label": "分类",
  "feedback.category_bug": "问题反馈",
  "feedback.category_idea": "建议",
  "feedback.category_question": "疑问",
  "feedback.category_other": "其他",
  "feedback.attach_diagnostic_label": "附加诊断信息",
  "feedback.attach_diagnostic_hint":
    "仅包含版本号、操作系统与渠道，不含路径或反馈内容。",
  "feedback.submit": "发送",
  "feedback.submitting": "发送中…",
  "feedback.submit_success": "已收到，感谢反馈。",
  "feedback.submit_fallback": "已改为打开邮件客户端。",
  "feedback.submit_fallback_github": "已在浏览器中打开 GitHub 以提交 issue。",
  "feedback.submit_error": "发送失败，请重试。",
  "feedback.submit_quota_exceeded":
    "此网络近期已提交过反馈，请几小时后再试，或再次点击发送以改用 GitHub 或邮件。",
  "feedback.log_assisted_bug_description":
    "与会话中「报告问题」相同：确认日志、可选填写说明，然后打开 GitHub 草稿 issue。",
  "feedback.log_assisted_bug_next_step_hint":
    "下一步将选择日志并填写问题说明（与会话消息上的「报告问题」相同）。",
  "feedback.report_bug_action": "报告问题",
  "workspace.rename_title": "编辑工作区名称",
  "workspace.rename_description": "更新侧边栏中显示的名称。",
  "workspace.rename_label": "工作区名称",
  "workspace.rename_placeholder": "设计团队工作区",

  // ==================== Workspace ====================

  // ==================== Session ====================
  "common.refresh": "刷新",
  "common.name": "名称",
  "common.install": "安装",
  "common.delete": "删除",
  "common.deleting": "删除中。。。",
  "common.connect": "连接",
  "common.edit": "编辑",
  "common.save": "保存",
  "common.saving": "正在保存…",
  "common.cancel": "取消",
  "common.close": "关闭",
  "common.show": "显示",
  "common.hide": "隐藏",
  "common.retry": "重试",
  "common.loading": "加载中...",
  "common.dismiss": "忽略",

  // ==================== 遥测（重启提示） ====================
  "status.connected": "已连接",
  "status.disconnected": "已断开",
  "status.running": "运行中",
  "status.live": "实时",
  "status.connecting": "正在连接",
  "status.creating_workspace": "正在创建工作区",
  "status.loading_session": "正在加载会话",
  "status.creating_task": "正在创建新任务",
  "status.reloading_engine": "正在重新加载引擎",
  "status.restarting_engine": "正在重启引擎",
  "status.installing_opencode": "正在安装 SuperClaw",
  "status.repairing_migration": "正在修复迁移",
  "status.disconnecting": "正在断开连接",

  // ==================== Scheduler Automation ====================

  // ==================== Model Settings ====================
  "workspace.switching_title": "正在打开 {name}",
  "workspace.switching_title_unknown": "正在打开工作区",
  "workspace.switching_subtitle": "马上带你回到最近的工作。",
  "workspace.switching_status_preparing": "正在准备",
  "workspace.switching_status_connecting": "正在检查连接",
  "workspace.switching_status_loading": "正在加载最近任务",
  "workspace.tasks_load_failed": "任务加载失败",
  "app.connection_lost": "服务器连接已断开。请重新加载。",
  "app.unknown_error": "未知错误",
  "app.cleanup_disk_critical_toast_title": "工作区空间即将用尽",
  "app.cleanup_disk_critical_toast_body":
    "中间清理文件已使用 {size}，且自动清理已关闭。请检查并释放空间。",
  "app.cleanup_disk_critical_toast_action": "查看清理",
  "app.error.tauri_required": "此操作需要 Tauri 应用运行时。",
  "app.error.choose_folder": "选择一个文件夹以继续。",
  "app.error.remote_base_url_required": "请先填写服务器地址。",
  "app.error.install_failed": "SuperClaw 安装失败。请查看上方日志。",
  "app.migration.desktop_required": "迁移修复需要桌面应用。",
  "app.migration.local_only": "迁移修复仅适用于本地工作区。",
  "app.migration.workspace_required": "请先选择本地工作区文件夹再修复迁移。",
  "app.migration.unsupported":
    "当前 OpenCode 二进制不支持 `opencode db migrate`。请将 OpenCode 更新到 >=1.2.6，或切换为内置引擎。",
  "app.migration.failed": "SuperClaw 迁移失败。",
  "app.migration.restart_failed": "迁移已完成，但 SuperClaw 无法重启本地引擎。",
  "app.migration.success": "迁移已修复，已重试本地启动。",

  // ==================== UI Tour  ====================
  "token.usage_title": "Token 使用统计",
  "token.usage_no_data": "暂无 Token 数据",
  "token.usage_placeholder":
    "开始在任务中使用 AI 助手后，将在此处显示 Token 使用情况。",
  "token.usage_no_model_data": "暂无模型维度数据",
  "token.usage_nonsession_hint":
    "部分请求不属于任何任务，例如听写文本润色。这类请求统计在下方的「本机累计」中。",
  "token.nonsession_title": "本机累计",
  "token.nonsession_purpose": "用途",
  "token.nonsession_requests": "请求数",
  "token.nonsession_tokens": "Tokens",
  "token.nonsession_cost": "估算费用",
  "token.nonsession_alias_dictation": "听写文本润色",
  "token.nonsession_alias_unaliased": "未标注",
  // 这些桶把智能体对话和智能体模式下的润色记在一起，所以标签只写路由。
  "token.nonsession_alias_cloud_model": "云端",
  "token.nonsession_alias_local_model": "本机",
  "token.nonsession_alias_auto": "自动",
  "token.nonsession_unattributed": "较早的请求（单条明细已不再保留）",
  "token.nonsession_empty": "本机尚无请求记录。",
  "token.nonsession_cost_note":
    "按请求当时服务商公开价目表估算，并非账单；实际扣费金额请以服务商后台为准。",
  // ==================== Edge Server ====================
} as const;
