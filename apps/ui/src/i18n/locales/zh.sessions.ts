/** Chinese-language strings for the sessions domain. Merged in zh.ts. */
export default {
  "session.office_preview_unavailable":
    "这台电脑上没有安装 LibreOffice，无法预览 Office 文档。请安装 LibreOffice，或使用对应的应用打开该文件。",
  "session.office_preview_unavailable_remote":
    "工作区所在的服务器上没有安装 LibreOffice，无法预览 Office 文档。请联系服务器管理员安装 LibreOffice，或使用对应的应用打开该文件。",

  "session.office_preview_install_title": "安装 LibreOffice？",
  "session.office_preview_install_message":
    "预览 Word、PowerPoint 和 Excel 文件需要 LibreOffice，SuperClaw 本身不包含它。如果你同意，Windows 程序包管理器（winget）会从 The Document Foundation 下载并安装 LibreOffice（数百 MB，需要几分钟），Windows 会请求管理员权限。",
  "session.office_preview_install_license":
    "LibreOffice 是自由软件，采用 Mozilla 公共许可证 2.0（MPL-2.0）。",
  "session.office_preview_install_license_link": "查看许可证",
  "session.office_preview_install_confirm": "用 winget 安装",
  "session.office_preview_install_cancel": "暂不安装",
  "session.office_preview_install_starting": "正在用 winget 开始安装…",
  "session.office_preview_install_downloading": "正在下载 LibreOffice。根据网速，可能需要几分钟。",
  "session.office_preview_install_installing":
    "正在安装 LibreOffice。出现 Windows 权限提示时请点击允许；如果没看到，请在任务栏里找闪烁的图标。",
  "session.office_preview_install_elapsed": "已用时间",
  "session.office_preview_install_manual":
    "这台电脑上没有 Windows 程序包管理器（winget），SuperClaw 无法代为安装 LibreOffice。请下载并安装 LibreOffice，然后点击“重试”。",
  "session.office_preview_install_unreachable":
    "SuperClaw 无法连接到自己的后台服务，没能确认是否可以安装 LibreOffice。请稍后点击“重试”。",
  "session.office_preview_install_elsewhere":
    "这台电脑上已经安装了 LibreOffice，但它装在 SuperClaw 不会查找的文件夹里。请卸载后重新安装到默认位置（Program Files 下），然后点击“重试”。",
  "session.office_preview_install_retry": "重试",
  "session.office_preview_install_download_link": "自行下载 LibreOffice",
  "session.office_preview_install_failed": "无法安装 LibreOffice。",

  // ==================== Tavily Modal ====================

  // ==================== Dashboard ====================
  "session.new_session": "新会话",
  "session.new_task": "新建任务",
  "session.no_task": "暂无任务",
  "session.permission_title": "允许此操作？",
  "session.permission_file_protection_title": "分析前屏蔽敏感信息？",
  "session.permission_required_description": "SuperClaw 需要您的许可才能继续。",
  "session.permission_summary_file_protection": "SuperClaw 想要分析 {target}。",
  "session.permission_summary_file_protection_unnamed": "SuperClaw 想要分析一个可能包含敏感信息的文件。",
  "session.permission_summary_email_send": "SuperClaw 想要发送邮件给 {target}。",
  "session.permission_summary_email_reply": "SuperClaw 想要回复一封邮件，发送给 {target}。",
  "session.permission_summary_schedule_meeting": "SuperClaw 想要与 {target} 安排会议。",
  "session.permission_summary_doom_loop": "SuperClaw 已多次重复同一步骤，想要继续执行。",
  "session.permission_summary_other": "SuperClaw 需要您的许可才能继续处理 {target}。",
  "session.permission_technical_details": "技术详情",
  "session.permission_label_uppercase": "权限",
  "session.scope_label_uppercase": "范围",
  "session.details_label": "详情",
  "session.permission_mask_and_analyze": "屏蔽后分析",
  "session.permission_analyze_unmasked": "不屏蔽直接分析",
  "session.permission_allow_once": "允许一次",
  "session.permission_allow_session": "本次会话内允许",
  "session.permission_dont_allow": "不允许",
  "session.permission_protected_pipeline_info":
    "此文件中的敏感信息（如姓名、邮箱或证件号）将在分析前自动屏蔽。如果选择“不屏蔽直接分析”，文件将按原样分析，不做任何屏蔽。",
  "session.permission_already_declined":
    "您已选择不屏蔽直接分析此文件，因此只能再次发送“不屏蔽直接分析”。",
  "session.masking_on_device": "本地脱敏",
  "session.mask_review_title": "检查已屏蔽的内容",
  "session.mask_review_description":
    "以下内容已在云端分析前被屏蔽。请检查下方预览；如果仍有敏感信息（例如供应商名称）未被屏蔽，请添加后点击“应用”。",
  "session.mask_review_empty": "此文件中没有被屏蔽的内容。",
  "session.mask_review_no_preview": "此文件类型暂不支持预览。",
  "session.mask_review_truncated": "预览已截断；完整文件仍受保护。",
  "session.mask_review_list_summary": "已屏蔽项目（{count}）",
  "session.mask_review_apply": "应用",
  "session.mask_review_loading": "正在加载已屏蔽内容…",
  "session.mask_review_load_failed": "无法加载已屏蔽列表。您仍可继续或取消。",
  "session.mask_review_input_label": "需额外屏蔽的词语",
  "session.mask_review_input_placeholder": "例如：Globex Industries, Acme Corp（用逗号或换行分隔）",
  "session.mask_review_unsupported": "此文件类型不支持添加额外屏蔽词。",
  "session.mask_review_added": "已屏蔽：{terms}",
  "session.mask_review_not_found": "文件中未找到：{terms}",
  "session.mask_review_already_masked": "已被屏蔽，无法再次屏蔽：{terms}。请删除后继续。",
  "session.mask_review_submit_failed": "无法屏蔽额外词语，请重试。",
  "session.mask_review_continue": "屏蔽并继续",
  "session.mask_review_cancel": "取消",
  "session.masking_on_device_title": "在云端分析前，个人敏感信息已由本地确定性检测器（正则 + 本地 NER）屏蔽。",
  "session.masking_llm": "LLM 脱敏",
  "session.masking_llm_title": "个人敏感信息已由 LLM 脱敏流程屏蔽。",
  "session.base_url_label": "SuperClaw 基础 URL",
  "session.model": "模型",
  "session.model_badge_auto": "自动",
  "session.model_badge_local": "本地",
  "session.model_badge_cloud": "云端",
  "session.model_badge_hybrid": "混合",
  "session.model_badge_tooltip": "此回复使用的模型。",
  "session.model_badge_auto_tooltip":
    "自动表示路由模式：系统会为每个请求选择本地或云端模型；此标签不表示两者都已使用。",
  "session.model_badge_local_tooltip":
    "本地表示已配置的本地模型，运行在此设备或边缘服务器上。",
  "session.model_badge_cloud_tooltip":
    "云端表示通过已配置的云端服务商运行的模型。",
  "session.model_badge_hybrid_tooltip":
    "混合表示此轮对话同时使用了本地和云端模型，包括工具调用或子代理调用。",
  "session.token_split_tooltip":
    "显示此轮记录的模型 Token 中，本地模型（此设备或边缘服务器）与云端模型分别处理的比例。",
  "session.worked_for": "用时",
  "session.insert_prompt": "插入提示",
  "session.run": "运行",
  "session.rename_title": "重命名会话",
  "session.delete_title": "删除会话",
  "session.favourites": "收藏",
  "session.add_favourite": "添加收藏",
  "session.remove_favourite": "取消收藏",
  "session.recent": "最近",
  "session.updated": "更新于",
  "session.rename_description": "更新此会话名称。",
  "session.rename_label": "会话名称",
  "session.rename_placeholder": "输入新的名称",
  "session.token_usage": "Token 用量",

  // ==================== Commands ====================

  // ==================== Skills ====================
  "session.create_or_connect_worker": "创建或连接工作区",
  "session.tokens_total": "总计",
  "session.tokens_input": "输入",
  "session.tokens_messages": "消息",
  "session.tokens_output": "输出",
  "session.tokens_share": "分享",
  "session.delete_session_message_generic": "这将永久删除所选会话及其消息。",
  "session.deleting": "正在删除……",
  "session.auto_route_requires_cloud_title": "智能路由需要云端模型",
  "session.cloud_model_unavailable_title": "云端模型不可用",
  "session.auto_route_requires_local_title": "智能路由需要本地模型",
  "session.local_model_unavailable_title": "本地模型不可用",
  "session.auto_route_requires_both_title": "智能路由需要本地和云端模型",
  "session.auto_route_intro":
    "智能路由会智能地将每个任务分配给本地或云端模型。要使用此功能，请在设置中添加云端模型。如果您只想使用本地模型，请在模型选择器中选择本地模型。",
  "session.auto_route_local_intro":
    "智能路由会智能地将每个任务分配给本地或云端模型。当前没有可用的本地模型，请在设置中连接边缘服务器（或设置本地模型）以使用智能路由。",
  "session.auto_route_both_intro":
    "智能路由会智能地将每个任务分配给本地或云端模型。本地模型和云端模型均未配置，请在设置中配置两者。",
  "session.cloud_model_unavailable_message":
    "云端模型当前不可用。请在设置 → 模型路由中检查您的云端服务商连接。",
  "session.local_model_unavailable_message":
    "本地模型当前不可用。请确认模型服务正在运行后重试。",
  "session.cloud_model_not_configured_title": "云端模型尚未配置",
  "session.cloud_model_not_configured_message":
    "请先在设置中添加云端模型后再发送。",
  "session.local_model_not_configured_title": "本地模型尚未配置",
  "session.local_model_not_configured_message":
    "请先在设置中配置本地（边缘）模型后再发送。",
  "session.auto_route_not_configured_title": "自动路由不可用",
  "session.auto_route_not_configured_message":
    "请在模型路由中同时配置本地模型和云端模型。",
  "session.model_check_failed_title": "无法检查模型状态",
  "session.model_check_failed_message":
    "无法连接模型服务以确认其可用性。这通常是暂时的，请重新发送。如果问题持续存在，请在设置 → 模型路由中检查连接。",
  "session.go_to_settings": "前往设置",
  "session.skill_command_show_instructions": "显示技能说明",
  "session.skill_command_hide_instructions": "隐藏技能说明",
  "session.subagent_readonly_notice": "这是只读的子任务记录。请切换到父任务以继续对话。",
  "session.session_loading_notice": "会话仍在加载中。请稍候片刻后重试。",
  "session.edge_unreachable_title": "无法访问 Edge 服务器",
  "session.edge_rejected_key_title": "Edge 服务器拒绝了 API 密钥",
  "session.edge_connect_failed_title": "无法连接到 Edge 服务器",
  "session.edge_model_unavailable_title": "之前保存的 Edge 模型已不可用",
  "session.edge_model_unavailable_message": "{model} 已无法使用：Edge 服务器不再提供它所需的全部模型。请打开 Edge 设置选择其他模型。",
  "session.edge_model_unavailable_unknown": "之前使用的模型",
  "session.edge_profile_load_failed_title": "已连接到 Edge 服务器，但 SuperClaw 无法加载配置文件",
  "session.edge_profile_load_failed_message": "{message}。请重试以重新加载。",
  "session.edge_unreachable_message": "{message}。请修复服务器，或在设置中更新连接。",
  "session.edge_unreachable_unknown": "SuperClaw 无法连接到 Edge 服务器",
  "session.edge_connecting_title": "正在连接 Edge 服务器…",
  "session.edge_connecting_message": "Edge 服务器响应后，工作区即会打开。",
  "session.edge_open_settings": "打开 Edge 设置",
  "session.edge_retry": "重试",
  "session.edge_send_blocked": "请先连接模型：Edge 服务器尚未连接。请查看上方的提示。",
  "session.web_search_limited_title": "网络搜索可能受限",
  "session.default_agent_tavily_note":
    "尚未配置 Tavily Search，因此通用智能体的网络搜索将回退到 DuckDuckGo。搜索质量可能会受到影响。",
  "session.default_agent_tavily_reminder":
    "您稍后可在设置中添加 Tavily API 密钥。此提醒 7 天内不再显示。",
  "session.default_agent_tavily_unreadable":
    "无法确认是否已保存 Tavily API 密钥，因此通用智能体的网络搜索可能回退到 DuckDuckGo。",
  "session.default_agent_tavily_unreadable_hint":
    "请打开设置查看原因并重试。",
  "session.delete_confirm_prefix": '这将永久删除 "',
  "session.delete_confirm_suffix": '" 及其消息。',

  "session.global_search_sidebar_label": "搜索…",
  "session.global_search_title": "搜索任务",
  "session.global_search_placeholder": "按标题或消息内容搜索",
  "session.global_search_empty_query": "输入关键词以搜索任务",
  "session.global_search_searching": "搜索中…",
  "session.global_search_no_matches": "没有匹配的任务。",
  "session.global_search_match_title": "标题",
  "session.global_search_match_content": "消息",
  "session.global_search_truncated_metadata":
    "部分标题匹配已隐藏（最多 80 条）。请缩小搜索范围。",
  "session.global_search_incomplete_content":
    "部分消息历史未能完整搜索，结果可能不完整。",
  "session.global_search_failed": "搜索失败。请重试。",
  "question.fallback_header": "问题",
  "question.skip": "跳过",
  "question.next": "下一个",
  "question.submit": "提交",
  "question.dismiss": "不回答并关闭",
  "question.back": "返回",
  "question.composer_placeholder": "输入你自己的答案，或留空以使用所选选项",
  "question.composer_choose": "请在上方选择一个选项",
  "question.collapse": "收起问题",
  "question.expand": "展开问题",
  "question.multiple_hint": "可选择一个或多个选项。",
  "question.from_subagent": "来自子智能体的提问",
} as const;
