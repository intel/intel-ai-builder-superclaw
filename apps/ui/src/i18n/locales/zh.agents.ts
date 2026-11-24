/** Chinese-language strings for the agents domain. Merged in zh.ts. */
export default {
  "agents.capabilities_section_label": "能力",
  "agents.agent_description_unavailable": "暂无描述。",
  "agents.category_custom_skills_mcp_tools_label": "自定义 Skills 与 MCP",
  "agents.custom_skills_section_label": "自定义 Skills",
  "agents.custom_mcp_tools_section_label": "MCP",
  "agents.protected_file_pipeline_label": "受保护文件处理流程",
  "agents.protected_file_pipeline_description":
    "允许此智能体通过用户确认的保护流程处理受支持的敏感文件。每个请求都会先检查保护设置。若用户拒绝或保护已关闭，请求将交由 local-file-agent 处理，并使用当前产品配置的模型路由。保护流程失败时不会使用此回退方式。",
  "agents.protected_file_pipeline_permissions_intro": "启用后，此能力使用以下权限：",
  "agents.protected_file_pipeline_confirm_permission": "请求确认",
  "agents.protected_file_pipeline_agent_permission": "确认后允许调用",
  "agents.protected_file_pipeline_tool_permission": "由 protected-file-agent 使用；不直接授予",
  "agents.protected_file_pipeline_local_agent_permission": "保护被拒绝或关闭时允许调用",
  "agents.custom_none_found": "暂无可选项。",
  "agents.name": "智能体",
  "agents.create_agent": "创建智能体",
  "agents.delete_agent": "删除智能体",
  "agents.delete_confirmation":
    '确定要删除智能体"{name}"吗？此操作将删除该智能体文件，且无法撤销。',
  "agents.your_agent": "您的智能体",
  "agents.no_custom_agents": "暂无自定义智能体。请在下方创建一个。",
  "agents.create_new": "创建新的智能体",
  "agents.configuration_card": "配置",
  "agents.details_label": "详情",
  "agents.custom_skills_mcp_heading": "自定义 Skills · MCP",
  "agents.hint": "用作文件名。允许字母、数字、连字符和下划线。示例：my-agent",
  "agents.name_no_spaces": "名称不能包含空格。请使用连字符或下划线。",
  "agents.description_title": "描述",
  "agents.description_placeholder": "这个智能体的功能是什么？",
  "agents.edit_mode_form": "表单",
  "agents.edit_mode_markdown": "Markdown",
  "agents.edit_name_readonly": "名称即智能体的文件名，无法在此修改。",
  "agents.edit_form_scope": "工具、技能、权限和系统提示词将保持不变。如需修改，请切换到 Markdown。",
  "agents.edit_form_unsupported":
    "此文件的 Frontmatter 使用了表单无法安全编辑的 YAML（例如流式映射，或被其他字段引用的锚点）。请在 Markdown 中编辑。",
  "agents.upload_hint": "点击选择并上传 .md 文件",
  "agents.upload_success": "已加载 {name}",
  "agents.upload_invalid_type": "请上传 Markdown（.md）文件。",
  "agents.upload_empty": "所选 Markdown 文件为空。",
  "agents.upload_parse_error_prefix": "无法解析该智能体 Markdown。",
  "agents.upload_parse_error_fields": "请修复以下字段后重新上传：{fields}。",
  "agents.upload_autofill_success": "已自动填充字段：{fields}",
  "agents.quick_setup_next_step": "下一步：点击下方“创建智能体”完成创建。",
  "agents.field_frontmatter": "frontmatter 区段（--- ... ---）",
  "agents.field_name": "name",
  "agents.field_description": "description",
  "agents.field_system_prompt": "system prompt",
  "agents.tools_skills_field": "工具与技能",
  "agents.create_success": "智能体“{name}”创建成功。",
  "agents.quick_setup_title": "快速设置",
  "agents.custom_setup_title": "自定义设置",
  "agents.preconfigured_agents_title": "预配置智能体",
  "agents.upload_section_title": "上传智能体",
  "agents.click_to_view_details": "点击查看详情",
  "agents.open_category_details": "打开{name}详情",
  "agents.high_permission_confirm":
    "要为{name}启用 Advanced 吗？这将开放更强能力，并可能触发审批确认。",
  "agents.permission_low_label": "基础",
  "agents.permission_high_label": "高级",
  "agents.permission_low_short": "基础",
  "agents.permission_high_short": "高级",
  "agents.permission_disabled_short": "禁用",
  "agents.permission_disabled_label": "禁用",
  "agents.package_low_line_file_code_engine":
    "读取、检索与文件/代码审阅（含 OCR），不执行写入操作。",
  "agents.package_high_added_line_file_code_engine":
    "新增文档/表格技能（PDF、DOCX、PPTX、电子表格）、代码写入与命令执行能力。",
  "agents.package_low_line_email_calendar_operations":
    "读取并总结邮件与日历上下文，用于计划与分拣。",
  "agents.package_high_added_line_email_calendar_operations":
    "新增发信、回信和会议安排动作。",
  "agents.package_low_line_web_research_retrieval": "检索网页证据并总结结论。",
  "agents.package_high_added_line_web_research_retrieval":
    "新增更广泛的趋势情报检索流程。",
  "agents.toggle_risk_selection": "切换{name}技能包",
  "agents.back_to_categories": "返回",
  "agents.category_detail_included_hint": "已包含在您的智能体中。",
  "agents.permissions_label": "权限",
  "agents.tools_label": "工具",
  "agents.skills_label": "技能",
  "agents.no_tools_found": "未找到工具",
  "agents.no_skills_found": "未找到技能",
  "agents.category_file_code_engine_label": "File & Code Engine",
  "agents.category_file_code_engine_description":
    "源码浏览、代码修改与命令执行控制能力。",
  "agents.category_email_calendar_operations_label":
    "Email & Calendar Operations",
  "agents.category_email_calendar_operations_description":
    "收件箱智能处理、回复流程与日程安排动作。",
  "agents.category_web_research_retrieval_label": "Web & Research Retrieval",
  "agents.category_web_research_retrieval_description":
    "网页证据检索与研究趋势信息获取。",
  "agents.system_prompt_card": "系统提示词",
  "agents.system_prompt_hint": "你是一名专业的...",
  "agents.system_instructions": "支持 Markdown。",
  "agents.tools_skills_card": "工具与技能",
  "agents.validation_invalid_format":
    "智能体 Markdown 格式无效。请在 '---' 之间添加 frontmatter 区段。",
  "agents.validation_yaml_invalid_at":
    "智能体 YAML 格式无效（第 {line} 行，第 {col} 列）。请检查 Frontmatter YAML。",
  "agents.validation_yaml_invalid":
    "智能体 YAML 格式无效。请检查 Frontmatter YAML。",
  "agents.validation_frontmatter_mapping":
    "Frontmatter 必须是 YAML 键值映射对象。",
  "agents.validation_description_required":
    "Frontmatter 缺少必填字段：description。",
  "agents.validation_mode_required": "Frontmatter 缺少必填字段：mode。",
  "agents.validation_permission_required":
    "Frontmatter 缺少必填字段：permission 映射。",
  "agents.validation_mode_enum":
    "'mode' 必须是以下之一：primary、subagent、all。",
  "agents.validation_system_prompt_required": "system prompt 正文不能为空。",
  "agents.validation_description_length":
    "'description' 长度必须在 1-1024 个字符之间。",
  "agents.validation_name_pattern":
    "'name' 只能包含字母、数字、连字符和下划线。",
  "agents.validation_unknown_frontmatter": "未知的 frontmatter 字段：{field}。",
  "agents.validation_tool_key_not_allowed": "不允许的工具权限键：'{tool}'。",
  "agents.validation_permission_key_not_allowed":
    "不允许的权限键：'{key}'。仅允许 '*', 'skill', 'task' 以及白名单工具键。",
  "agents.validation_permission_block_mapping":
    "权限块 '{block}' 必须是仅包含 '*' 键的映射。",
  "agents.validation_permission_block_wildcard_required":
    "权限块 '{block}' 必须定义 '*' 键。",
  "agents.validation_permission_block_unexpected_key":
    "权限块 '{block}' 只允许 '*' 键，但发现了 '{key}'。",
  "agents.validation_permission_enum": "权限值只能是：allow、ask、deny。",
  "agents.validation_permission_value_shape":
    "权限值必须是字符串（allow/ask/deny）或嵌套权限映射。",
  "agents.validation_permission_key_empty": "权限键不能为空。",

  "agents.skill_tooltip_pdf": "读取和分析 PDF：正文、页数、表格与元数据。",
  "agents.skill_tooltip_docx": "读取和分析 Word（.docx）：正文、表格与元数据。",
  "agents.skill_tooltip_docx-create": "创建带封面、目录、表格和图片的 Word（.docx）文档。",
  "agents.skill_tooltip_pptx": "读取和分析 PowerPoint（.pptx）幻灯片与演示元数据。",
  "agents.skill_tooltip_pptx-create": "使用卡片、表格和原生图表版式创建色彩丰富的 PowerPoint（.pptx）演示文稿。",
  "agents.skill_tooltip_spreadsheet": "读取和分析 Excel（.xlsx）与 CSV 表格数据。",
  "agents.skill_tooltip_github": "通过 `gh` CLI 处理 Issue、PR、仓库与代码搜索。",
  "agents.skill_tooltip_email": "邮件与日历流水线：拉取、起草、发送、排程与每日计划。",
  "agents.skill_tooltip_local-safety-guard":
    "识别高风险 shell 命令、将编辑限制在安全路径，并在不可逆操作前要求确认。",
  "agents.skill_tooltip_local-security-review":
    "认证、输入、密钥与 API 设计的安全检查清单。",
  "agents.skill_tooltip_humanizer-lite":
    "让 AI 感或生硬的文字读起来更自然，且不改变事实（人性化 / 去 AI 味）。",
  "agents.skill_tooltip_frontend-design":
    "差异化 UI 方向：配色、字体与布局，避免模板化默认样式。",
  "agents.skill_tooltip_news-summarizer": "从 URL 或粘贴正文生成结构化新闻摘要。",
  "agents.skill_tooltip_ocr-document-parse":
    "本地 OCR（RapidOCR）将扫描件与页面图片转为 Markdown，无需视觉模型。",
  "agents.skill_tooltip_translate": "准确翻译，保留格式并按语言环境调整语气。",
  "agents.skill_tooltip_resume-tailor": "针对职位描述定制简历，并保持内容真实。",
  "agents.skill_tooltip_interview-prep-generator":
    "基于简历生成 STAR 故事、练习题与谈话要点。",
  "agents.skill_tooltip_skill-creator": "创建或更新工作区 Skill：流程、领域知识与工具用法。",
  "agents.skill_tooltip_skill-finder":
    "在已安装 Skill、GitHub Skill 仓库、SkillHub 与 ClawHub 中查找是否已有合适 Skill，避免重复创建。",

  // ==================== Status ====================
} as const;
