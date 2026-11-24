/** Chinese-language strings for the capability domain. Merged in zh.ts. */
export default {
  "capability.model_change_title": "应用模型更改",
  "capability.model_change_body":
    "模型更改将在生效前完成准备和验证。如果当前产品配置支持该模型，应用将保持运行。",
  "capability.model_change_cancel": "取消",
  "capability.model_change_apply": "应用模型更改",
  "capability.model_change_resume": "恢复",
  "capability.model_change_stage_lost":
    "该模型更改已不再处于待应用状态。请关闭此对话框后重新点击“连接”。",
  "capability.switch_phase.validating": "正在校验\u2026",
  "capability.switch_phase.connecting_edge": "正在连接 Edge 服务器\u2026",
  "capability.switch_phase.preparing_local": "正在准备本地模型\u2026",
  "capability.switch_phase.applying": "正在应用\u2026",
  "capability.switch_phase.recovery_required": "模型激活需要恢复。",
  "capability.probe_step.discover": "在 Edge 服务器上发现模型",
  "capability.probe_step.chat": "对话模型探测",
  "capability.probe_step.embedding": "嵌入模型探测",
  "capability.bundle_step.chat": "对话模型",
  "capability.bundle_step.embedding": "嵌入模型",
  "capability.probe_error.timeout":
    "Edge 服务器 10 秒内未响应，模型可能正在冷启动或离线。",
  "capability.probe_error.connection_failed":
    "无法连接到 Edge 服务器，请检查 URL 和网络。",
  "capability.probe_error.auth_failed":
    "Edge 服务器拒绝了连接密钥（401/403）。",
  "capability.probe_error.model_not_found": "Edge 服务器上未部署该模型。",
  "capability.probe_error.invalid_response":
    "Edge 服务器返回了不符合预期的响应。",
  "capability.probe_error.bundle_mismatch":
    "Edge 服务器未同时提供所需的对话与嵌入模型。",
  "capability.probe_error.upstream_error": "Edge 服务器返回 5xx 错误。",
  "capability.probe_error.config_changed":
    "准备过程中 Edge 配置发生变化，请重试。",
  "capability.probe_error.not_configured": "未配置 Edge。",
  "capability.probe_error.unknown": "Edge 准备失败，请查看服务器日志了解详情。",
  "capability.download_confirm_title": "需要下载模型",
  "capability.download_confirm_body":
    "以下模型需要先下载才能继续。首次启动可能需要几分钟。",
  "capability.security_only_model_note":
    "本地模型仅作为安全预处理层，在请求发送到云端之前对敏感信息进行脱敏处理",
  "capability.download_role_chat": "（对话）",
  "capability.download_role_embedding": "（向量）",
  "capability.download_total": "总下载大小",
  "capability.download_confirm": "确认",
  "capability.download_cancel": "取消",
  "capability.download_progress_title": "正在下载模型",
  "capability.download_progress_body":
    "正在下载模型文件，可在下方查看每项的进度。",
  "capability.download_in_progress": "下载中…",
  "capability.download_ready_title": "模型已就绪",
  "capability.download_verifying_title": "正在校验模型文件",
  "capability.download_verifying_body":
    "正在按校验和核对已在磁盘上的文件。除非发现文件损坏，否则无需重新下载。",
  "capability.download_verifying_hint": "校验中…",
  "capability.download_failed_title": "模型准备失败",
  "capability.download_failed_body":
    "模型未能准备就绪，下方为后端返回的详细信息。",
  "capability.download_ready_body":
    "所有模型文件均已下载并校验完成，正在启动运行时…",
  "capability.download_ready_hint": "已就绪",
  "capability.tts_download_confirm_title": "下载语音模型",
  "capability.tts_download_confirm_body": "朗读回复需要一个语音合成模型。仅需下载一次，之后可重复使用。",
  "capability.tts_download_lang_note": "该语音模型目前仅支持英语朗读，暂不支持其他语言。",
  "capability.tts_download_progress_title": "正在下载语音模型",
  "capability.tts_download_progress_body": "正在下载语音模型，可在下方查看进度。",
  "capability.tts_download_ready_title": "语音模型已就绪",
  "capability.tts_download_ready_body": "语音模型已下载并校验完成，正在开启朗读…",
  "capability.hardware_insufficient_title": "硬件条件不满足",
  "capability.hardware_insufficient_body":
    "当前设备资源不足，无法运行本地模型。以下要求未满足：",
  "capability.hardware_req_memory": "系统内存",
  "capability.hardware_req_model_memory": "所选模型所需内存",
  "capability.hardware_req_disk": "磁盘可用空间",
  "capability.hardware_req_detail": "需要 {required}，当前可用 {free}",
  "capability.hardware_req_detail_required": "需要 {required}",
  "capability.hardware_req_detail_free": "当前可用 {free}",
  "capability.hardware_exit": "退出",
  "capability.hardware_cancel": "取消",
  "capability.port_conflict_title": "所需端口已被占用",
  "capability.port_conflict_body": "SuperClaw 无法启动，以下所需端口已被占用：",
  "capability.port_conflict_hint":
    "请关闭占用这些端口的程序，然后重新启动 SuperClaw。",
  "capability.port_conflict_exit": "退出",
  "capability.port_owner_name_pid": "被 {name}（PID {pid}）占用",
  "capability.port_owner_name": "被 {name} 占用",
  "capability.port_owner_pid": "被 PID {pid} 占用",
  "capability.elevated_title": "SuperClaw 不能以管理员身份运行",
  "capability.elevated_body": "请关闭 SuperClaw，然后从开始菜单或桌面快捷方式正常启动。",
  "capability.elevated_hint":
    "如果每次都以管理员身份打开，请右键单击快捷方式，选择“属性 > 兼容性”，然后取消勾选“以管理员身份运行此程序”。如果此电脑已关闭用户帐户控制（UAC），请先重新开启并重启电脑；如果电脑由组织管理，请联系 IT 管理员。",
  "capability.elevated_exit": "退出",
  "capability.download_retry": "重试",
  "capability.download_cancel_download": "取消",
} as const;
