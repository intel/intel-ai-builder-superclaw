/** Chinese-language strings for the voice-input domain. Merged in zh.ts. */
export default {
  // ── 下载同意框（整个流程里唯一会挡住画面的视窗） ──────────────────────────
  "voice.download_title": "要下载语音模型吗？",
  "voice.download_body":
    "语音输入默认在这台电脑上识别，声音不会离开电脑。需要先下载约 630 MB 的语音模型，下载后可离线使用。",
  "voice.download_english_only": "本地识别仅支持英文。云端语音服务会跟随系统语言。",
  "voice.download_confirm": "下载",
  "voice.download_use_cloud": "改用云端",
  "voice.download_progress_title": "正在下载语音模型…",
  "voice.download_progress_body": "可以继续做别的事。再次点击麦克风即可查看进度。",
  "voice.download_in_progress": "正在下载…",
  "voice.download_ready_title": "语音模型已就绪",
  "voice.download_ready_body": "再按一次麦克风即可开始录音。",
  "voice.download_failed_title": "下载失败",
  "voice.download_stalled": "下载没有开始。语音服务报告没有进度，本地也没有模型文件。",
  "voice.download_retry": "重试",
  "voice.download_cancel": "取消",
  // 关掉窗口但不换引擎：下载继续，再次点击麦克风即可查看进度。
  "voice.download_background": "在后台继续下载",
  "voice.download_close": "关闭",

  // ── 设置 → 语音输入 ────────────────────────────────────────────────────────
  "voice.settings_title": "语音输入",
  "voice.mode_heading": "识别模式",
  // 「本地」只指识别这一步，不指整条链路：口述出来的文字照旧发给用户配置的
  // 智能体模型，所以这里每句话都只说「声音」，不能让人以为整轮对话都在本地。
  "voice.mode_local_title": "本地",
  // 2 分钟上限写在这里：`MAX_AUDIO_SECONDS` 只作用于本地录音路径，
  // 原先放在两张卡片下方，等于替浏览器语音服务也宣称了一个它没有的限制。
  "voice.mode_local_desc":
    "在这台电脑上识别——声音不会离开本机，也可离线使用。需要一次性下载约 630 MB；每次录音在 2 分钟后停止。",
  "voice.mode_local_badge": "仅英文",
  "voice.mode_cloud_title": "云端",
  "voice.mode_cloud_desc": "声音会发送到浏览器的语音服务，需要网络连接。",
  "voice.mode_local_unavailable": "当前版本或当前配置不提供本地语音输入，将使用云端服务。",

  "voice.hotkey_heading": "快捷键",
  "voice.hotkey_desc": "在 SuperClaw 处于焦点时开始或停止录音。最多可添加四个按键或鼠标按钮。",
  "voice.hotkey_add": "新增快捷键",
  "voice.hotkey_remove": "移除快捷键",
  "voice.hotkey_none": "未设置快捷键——请用麦克风按钮。",
  "voice.hotkey_capture": "请按下按键，或鼠标侧键／滚轮键…",
  "voice.hotkey_cancel": "取消",
  "voice.hotkey_reset": "恢复默认",
  "voice.hotkey_error_typing_key":
    "会输入字符的单键在打字时会误触。请改用修饰键、功能键，或再加一个键。",
  "voice.hotkey_error_reserved": "Enter、Tab 和 Esc 由输入框占用。",
  "voice.hotkey_error_duplicate": "这组快捷键已经绑定过了。",
  "voice.hotkey_error_too_many": "最多四组，请先移除一组。",
  "voice.hotkey_altgr_note":
    "在某些键盘布局中，右 Alt 键用于输入字符（AltGr）。如果你的键盘如此，请再添加一个快捷键。",
  "voice.hotkey_mouse_note": "绑定的鼠标键仍保留原本功能，侧键照样可以「上一页」。",

  "voice.device_heading": "麦克风",
  "voice.device_system_default": "系统默认",
  "voice.device_refresh": "刷新",
  "voice.device_local_only": "云端模式始终使用系统默认麦克风。",

  "voice.read_aloud_voice_heading": "朗读语音",
  "voice.read_aloud_voice_english": "美式英语（女声）",
  "voice.read_aloud_voice_english_male": "美式英语（男声）",
  "voice.read_aloud_voice_british": "英式英语（女声）",

  "voice.dictionary_heading": "字典",
  "voice.dictionary_desc":
    "人名、项目名和术语。例如，添加“Superclaw”后就能被正确识别。",
  "voice.dictionary_local_only": "字典仅对本地识别有效。浏览器语音服务无法接受自定义词汇。",
  "voice.dictionary_placeholder_input": "添加名称或术语…",
  "voice.dictionary_add": "添加",
  "voice.dictionary_empty": "还没有词条。",
  "voice.dictionary_summary": "{n} 个词条 · {m} 个自动学习",
  "voice.dictionary_more": "另有 {n} 个",
  "voice.dictionary_manage": "管理词条",
  "voice.dictionary_dialog_title": "字典 · {n} / {max}",
  "voice.dictionary_dialog_close": "关闭",
  "voice.dictionary_search_placeholder": "搜索词条",
  "voice.dictionary_filter_all": "全部",
  "voice.dictionary_filter_learned": "自动学习（{m}）",
  "voice.dictionary_no_matches": "没有匹配的词条。",
  "voice.dictionary_select": "选择 {word}",
  "voice.dictionary_select_all": "全选",
  "voice.dictionary_selected": "已选 {k} 个",
  "voice.dictionary_remove_selected": "移除所选",
  "voice.dictionary_done": "完成",
  "voice.dictionary_import": "导入…",
  "voice.dictionary_export": "导出",
  "voice.dictionary_import_result": "已添加 {added} 个，跳过 {skipped} 个。",
  "voice.dictionary_import_failed": "无法读取该文件。",
  "voice.dictionary_import_hint":
    "选择一个 .txt 文件，每行一个词或短语。重复项及超出 {max} 个上限的部分会被跳过。",
  "voice.dictionary_export_hint":
    "将所有词保存到“下载”文件夹中的 dictionary.txt，每行一个。之后可通过导入恢复。",
  "voice.dictionary_export_saved": "已将 {n} 个词保存到 {path}",
  "voice.dictionary_export_failed": "无法保存文件：{error}",
  "voice.dictionary_error_empty": "请先输入内容。",
  "voice.dictionary_error_duplicate": "该词条已在字典中。",
  "voice.dictionary_error_too_long": "单个词条过长——只添加其中最关键的词。",
  "voice.dictionary_error_full": "字典已满。请先移除一个词条。",

  "voice.dictionary_learned_desc":
    "同一个词修正两三次就会自动加入——不必发送，停几秒就算。只保存该词，不保存讯息内容。",
  "voice.dictionary_origin_auto": "自动学习",
  "voice.dictionary_auto_added": "已把「{word}」加入字典——你在多次录音里都修正过它。若不需要，可到设置移除。",
  "voice.dictionary_auto_add_undo": "撤销",
  "voice.dictionary_auto_add_undone": "已移除「{word}」——以后不会再自动加入。",

  // 进度。少了这段，「完全没记录到」和「记录了一次、还差一次」在界面上长得一样。
  "voice.dictionary_progress_heading": "正在从你的修正中学习",
  "voice.dictionary_progress_waiting": "{threshold} 次录音中的第 {runs} 次",
  "voice.dictionary_progress_unsuitable": "不适合作为字典词",
  "voice.dictionary_progress_already_added": "已在字典中",
  "voice.dictionary_progress_removed": "你移除过这个字",

  // ── LLM 文本润色 ──────────────────────────────────────────────────────────
  // 文案先说代价，不先说好处：选了「本地识别」的人若发现自己的话被送上云端，
  // 有理由觉得被骗，所以卡片必须说清文字去了哪里。开关本身已经表明功能默认关闭，
  // 每次多花约一秒也不值得单写一句。
  "voice.refine_heading": "用 LLM 修正听写错误",
  // 整张卡片可信度的立足点，必须对三个选项都为真，
  // 所以明说云端是默认后果，而不是藏在「你选的模型」背后。
  "voice.refine_desc": "除非选择本地模型，否则文字会发送到云端模型。",
  "voice.refine_toggle_label": "润色口述文字",
  // 只置灰、不隐藏：控件消失会让已保存的设置看起来丢了。句子要说清少了什么。
  "voice.refine_unavailable": "此安装不支持此功能。",
  // 开关失效的另一个原因，而且常见得多。单独一条：此时说“没有配置”并不属实，
  // 只会让用户去找故障，而真正的解决办法就在上面那张卡片的引擎选择里。
  "voice.refine_local_mode_only": "仅适用于本地识别。",
  "voice.refine_mode_heading": "模型",
  "voice.refine_mode_agent_title": "智能体使用的云端模型",
  // 本机模型选项。刻意不提任何质量折扣：按参考测量，4B 的润色质量
  // 与云端预设相当（内容词 F1 90.5 比 91.3；模型评审 95.8 比 92.5），
  // 写一句道歉式的说明等于凭空造出数据并不支持的取舍。
  // 真正要讲的是会变的那一项：速度取决于机器而非网络。
  "voice.refine_mode_local_title": "本地模型",
  "voice.refine_mode_local_desc": "数据不会离开这台电脑。速度取决于你的硬件。",
  // 这是一句说明，不是置灰：选项仍然可选。
  // 所以句子说的是该做什么，而不宣称选项不可用——万一探测结果有误，口述照样能用。
  "voice.refine_mode_local_blocked": "还没有配置本机模型。请到模型供应商设置里选一个后再用此选项。",
  // 用户界面上不称其为「预设」：它需要用户自己的 OpenRouter 密钥，
  // 「预设」会让人误以为开箱可用。
  // 标题说的是「你可以选」而不是具体模型：这个选项现在带了一个选择框，
  // 若标题写着 MiniMax M3 而下面的字段显示另一个模型，卡片就自相矛盾了。
  // 这个选项不配说明文字：标题已经点明密钥，下面的选择框显示具体模型，
  // 节点路由则由 `voice.refine_model_note` 交代。
  "voice.refine_mode_preset_title": "通过你的 OpenRouter 密钥选择模型",
  "voice.refine_mode_preset_blocked": "请先到模型供应商设置里填入你的 OpenRouter 密钥。",
  // 选择框。标签写「润色模型」而不是只写「模型」，因为这张卡片要反复回答的那个
  // 担心就是「这会不会把我智能体的模型也改了」。
  "voice.refine_model_label": "润色模型",
  "voice.refine_model_default_badge": "默认",
  "voice.refine_model_placeholder": "搜索你的 OpenRouter 模型",
  // 明说实测的节点优先顺序只针对 MiniMax M3。换别的模型照样能用，只是走
  // OpenRouter 自己的调度——口述变慢时，这一点值得先知道。
  "voice.refine_model_note": "MiniMax M3 已针对速度优化。其他模型使用 OpenRouter 的默认路由。",
  "voice.refine_model_loading": "正在加载你的 OpenRouter 模型列表……",
  // 特意不写「可以直接输入模型 ID」：这个选择框只接受列表里的模型，没有列表就
  // 没得输入。承诺一条不存在的退路，比直说限制更糟。
  "voice.refine_model_failed":
    "读不到你的 OpenRouter 模型列表。润色仍会使用上面显示的模型——可以到模型供应商设置里检查密钥，然后重新打开本页再试。",
  "voice.refine_model_empty": "你的 OpenRouter 账户没有返回任何模型。",
  "voice.refine_failure_note": "如果清理失败，将按原样插入听写文字。",
  // 推理模型提醒。既然要打扰用户，文案就得把代价说清楚：润色本质上只是改写，
  // 那段推理既要计费又要等待，却完全到不了结果里。文案还必须自己声明影响范围——
  // 一个口述设置卡片去改用户智能体在用的模型，是破坏性的意外，所以这里明说它不会。
  "voice.refine_reasoning_hint_title": "此模型会先进行推理",
  "voice.refine_reasoning_hint_body":
    "{model} 总会先推理，这会增加费用和等待时间，但不会改善清理效果。",
  "voice.refine_reasoning_hint_switch": "改用 MiniMax M3 润色",
  "voice.refine_reasoning_hint_scope": "只更改听写清理，不影响你的智能体。",
  // 这种状态下不给按钮：切换需要用户还没有的 OpenRouter 密钥，
  // 一个按下去毫无反应的控件只会被当成故障。
  "voice.refine_reasoning_hint_needs_key":
    "想改用 MiniMax M3 润色，请先到模型供应商设置里填入你的 OpenRouter 密钥。",
  // 这种状态下同样不给按钮，但理由相反：这个模型是用户自己在上面那个字段里选的。
  // 一键替掉用户明确做过的选择，正是「影响范围」那句承诺不会发生的破坏性意外——
  // 所以这一条只指向选择框，把决定权留给用户。
  "voice.refine_reasoning_hint_pick_other":
    "这个润色模型是你自己选的，SuperClaw 不会替你改动。可以在上面换一个——当然，知道代价之后继续用也完全可以。",
  "voice.refine_reasoning_hint_dismiss": "忽略这条提醒",
  // 四条非阻断提示。每条都要同时说明「发生了什么」和「你拿到了什么」，
  // 否则「润色失败」会被读成「口述内容没了」。
  "voice.refine_toast_failed": "润色失败——已按原样插入你口述的文字。",
  "voice.refine_toast_timeout": "润色耗时过长——已按原样插入你口述的文字。",
  // 刻意去掉「云端」：这条对应 LLMRouter 的 424，意思是
  // 「你选的那种方式没有可服务的模型」——在本机模式下那往往是本机模型而非云端模型。
  // 这条提示拿不到当前模式（`classifyVoiceRefineError` 按设计只看错误码），
  // 所以唯一诚实的写法是对三种模式都成立的那个。
  "voice.refine_toast_no_model": "没有可用于润色的模型——已按原样插入你口述的文字。",
  // 仅用于本机模式。既包括「没有本机模型」，也包括「本机别名指向远程服务器」，
  // 所以不能写成「请配置模型」。
  "voice.refine_toast_not_on_device": "没有可用于润色的本机模型——已按原样插入你口述的文字。",
  "voice.refine_toast_unavailable": "这台机器上没有润色功能——已按原样插入你口述的文字。",
  // 说的是「哪一种方式」不可用，而不是整个功能，并指出另外两种仍然可用。
  // 这个失败是缺少仅限主机的凭据，只有「自带密钥」那一种方式才需要它——
  // 所以文案不能读成「润色坏了」，否则用户会因为一种方式不可用就把整个功能关掉。
  "voice.refine_toast_host_key_missing":
    "这台机器上无法用你自己选的模型润色——已按原样插入你口述的文字。智能体模型和本机模型仍然可用。",

  // ── 产品导览 ──────────────────────────────────────────────────────────────
  "tour.voice_input.title": "语音输入",
  "tour.voice_input.body":
    "点击麦克风即可用说话代替打字，也可以按右 Alt 键。默认在这台电脑上识别；可以在语音输入设置里改用云端服务。",

  // 设置搜索用来找到各项设置的其他词，用逗号分隔。
  "voice.mode_heading_keywords": "语音识别, 本地, 云端, 端侧",
  "voice.hotkey_heading_keywords": "快捷键, 热键, 键盘, 鼠标按键",
  "voice.device_heading_keywords": "麦克风, 输入设备, 音频输入, 耳机",
  "voice.read_aloud_voice_heading_keywords": "朗读, 语音播报, 文字转语音",
  "voice.refine_heading_keywords": "纠错, 润色, 标点, 大模型",
  "voice.dictionary_heading_keywords": "词典, 词汇, 自定义词, 专有名词",
};
