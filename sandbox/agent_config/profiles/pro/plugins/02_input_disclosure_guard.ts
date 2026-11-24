import type { Plugin } from "@opencode-ai/plugin";

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type MutableRecord = Record<string, unknown>;

const REFUSAL = "I can’t provide hidden system, developer, internal, tool-schema, or secret configuration details. I can help with public capabilities, safe usage guidance, or reviewing prompts and schemas that you provide.";
const TITLE_REFUSAL = "Request about unavailable internal instructions";
const SUMMARY_REFUSAL = "The request asked for unavailable internal instructions and was not forwarded.";
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;
const WHITESPACE = /\s+/g;
const EN_ACTION = /\b(?:show|print|repeat|summari[sz]e|describe|explain|enumerate|translate|rewrite|reconstruct|paraphrase|outline|convert|continue|reveal|display|dump|output|provide|give me|tell me|list|share|disclose|expose|copy|quote|include|see)\b/;
const EN_OWN_AGENT_TARGET = /\b(?:your|current|current-agent|hidden|internal)\b.{0,80}\b(?:system prompts?|system instructions?|developer (?:instructions?|prompts?)|internal (?:instructions?|rules?)|hidden (?:instructions?|rules?|prompts?)|tool schemas?|functions json|function schemas?|full tool schemas?|hidden config(?:uration)?|current env secrets?|environment secrets?|env secrets?|secrets?|credentials?|api keys?|access tokens?|environment variables)\b|\b(?:system prompts?|system instructions?|developer (?:instructions?|prompts?)|internal (?:instructions?|rules?)|hidden (?:instructions?|rules?|prompts?)|tool schemas?|functions json|function schemas?|full tool schemas?|hidden config(?:uration)?|current env secrets?|environment secrets?|env secrets?|secrets?|credentials?|api keys?|access tokens?|environment variables)\b.{0,80}\b(?:your|current|current-agent|hidden|internal)\b/;
const EN_EXPLICIT_TARGET = /\b(?:exact|complete|full)\b.{0,40}\b(?:system prompts?|system instructions?|developer (?:instructions?|prompts?)|hidden (?:instructions?|rules?|prompts?)|internal (?:instructions?|rules?))\b/;
const EN_BARE_DIRECT_REQUEST = /^(?:please )?(?:show|print|repeat|reveal|display|dump|output|provide|give me|tell me|share|disclose|expose|copy|quote)\s+(?:me\s+)?(?:the\s+)?(?:exact\s+|complete\s+|full\s+)?(?:system prompts?|system instructions?)\s*(?:please)?[.?!]?$/;
const EN_PREDICATE_QUESTION = /^(?:does|do|is|are|can)\b.{0,100}\b(?:your|current|current-agent|hidden|internal)\b.{0,80}\b(?:system prompts?|system instructions?|developer (?:instructions?|prompts?)|hidden (?:instructions?|rules?|prompts?)|internal (?:instructions?|rules?))\b.{0,80}\b(?:contains?|includes?|mentions?|uses?|has|have)\b/;
const EN_USER_OWNED_PROMPT = /\b(?:example|sample|template)\b.{0,80}\b(?:system prompts?|system instructions?)\b.{0,80}\bfor (?:a|an|my|our)\b|\b(?:system prompts?|system instructions?)\b.{0,60}\b(?:i|we) (?:wrote|provided|created)\b/;
const EN_DIRECT_QUESTION = /^(?:what (?:is|are) your .+|can i see your .+)\??$/;
const EN_PURE_PUBLIC_QUERY = /^(?:(?:what|which) (?:tools?|capabilities|tools and capabilities)(?: or capabilities)? (?:do you have|are available|can you use|are you allowed to use|can you access)|what can you do|what capabilities are enabled|list (?:your |available |approved )?(?:tools?|tool names|capabilities))\??$/;
const CN_ACTION = /(?:告诉|显示|打印|重复|翻译|总结|描述|解释|枚举|列出|提供|给我|输出|重写|改写|复述|概述|转换|续写|包含|含有|确认|是什么)/;
const CN_OWN_AGENT_TARGET = /(?:你的|当前|隐藏|内部).{0,40}(?:系统提示词|系统指令|开发者指令|内部指令|隐藏指令|隐藏规则|隐藏提示词|工具\s*schema|函数\s*json|隐藏配置|运行环境|token|密钥|秘密)|(?:系统提示词|系统指令|开发者指令|内部指令|隐藏指令|隐藏规则|隐藏提示词|工具\s*schema|函数\s*json|隐藏配置|运行环境|token|密钥|秘密).{0,40}(?:你的|当前|隐藏|内部)/;
const CN_PURE_PUBLIC_QUERY = /^(?:你有哪些工具|你有什么工具|你能做什么|介绍你的公开能力)[？?]?$/;

const SAFE_TOOLS: Record<string, string> = {
  read: "Read files from the workspace when allowed.",
  edit: "Edit workspace files when explicitly allowed.",
  bash: "Run approved shell commands when allowed.",
  sc_search_web: "Search the web for current public information when available.",
  get_mcp_status: "Report configured MCP server connection status.",
  parse_pdf: "Extract text from PDF files when allowed.",
};

export const SuperclawInputDisclosureGuard: Plugin = async () => ({
  config: (cfg) => {
    const provider = cfg.provider?.llmrouter;
    if (!provider) return;
    const options = provider.options ??= {};
    const priorFetch = typeof options.fetch === "function" ? options.fetch as FetchFn : undefined;
    options.fetch = guardedFetch(priorFetch);
  },
});

export default SuperclawInputDisclosureGuard;

function guardedFetch(priorFetch: FetchFn | undefined): FetchFn {
  return async (input, init) => {
    const upstream = priorFetch ?? fetch;
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const inspection = inspectChatRequest(input, init);
    if (!inspection) return upstream(input, init);
    const lastUserText = lastUserTextFromChat(inspection.body);
    if (lastUserText === undefined) return upstream(input, init);
    const text = normalizeText(lastUserText);
    const model = typeof inspection.body.model === "string" && inspection.body.model ? inspection.body.model : "superclaw-input-disclosure-guard";
    if (shouldBlockInputDisclosurePrompt(text)) {
      console.info("superclaw-input-disclosure-guard rule=input_disclosure");
      return syntheticResponse(contentForBlocked(inspection.headers), inspection.stream, model);
    }
    if (isPublicInfoQuery(text)) {
      console.info("superclaw-input-disclosure-guard rule=public_capabilities");
      return syntheticResponse(publicInfo(inspection.body), inspection.stream, model);
    }
    return upstream(input, init);
  };
}

function inspectChatRequest(input: RequestInfo | URL, init: RequestInit | undefined): { body: MutableRecord; headers: Headers; stream: boolean } | undefined {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method.toUpperCase() !== "POST" || typeof init?.body !== "string") return undefined;
  try {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname.replace(/\/+$/, "");
    if (path !== "/v1/chat/completions" && path !== "/chat/completions") return undefined;
    const body: unknown = JSON.parse(init.body);
    if (!isRecord(body) || !Array.isArray(body.messages)) return undefined;
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    return { body, headers, stream: body.stream === true };
  } catch {
    return undefined;
  }
}

function lastUserTextFromChat(body: MutableRecord): string | undefined {
  const messages = body.messages;
  if (!Array.isArray(messages)) return undefined;
  const last = messages.findLast((message) => isRecord(message) && message.role === "user");
  if (!isRecord(last)) return undefined;
  if (typeof last.content === "string") return last.content;
  if (!Array.isArray(last.content)) return undefined;
  const parts = last.content.flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []);
  return parts.length ? parts.join("\n") : undefined;
}

function shouldBlockInputDisclosurePrompt(text: string): boolean {
  if (EN_USER_OWNED_PROMPT.test(text) && !EN_OWN_AGENT_TARGET.test(text)) return false;
  return (CN_ACTION.test(text) && CN_OWN_AGENT_TARGET.test(text)) ||
    EN_BARE_DIRECT_REQUEST.test(text) || EN_PREDICATE_QUESTION.test(text) ||
    ((EN_ACTION.test(text) || EN_DIRECT_QUESTION.test(text)) && (EN_OWN_AGENT_TARGET.test(text) || EN_EXPLICIT_TARGET.test(text)));
}

function isPublicInfoQuery(value: string): boolean {
  const text = value.replace(/[.。]$/, "");
  return CN_PURE_PUBLIC_QUERY.test(text) || EN_PURE_PUBLIC_QUERY.test(text);
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(ZERO_WIDTH, "").replace(WHITESPACE, " ").trim().toLowerCase();
}

function contentForBlocked(headers: Headers): string {
  const agent = headers.get("superclaw-agent") ?? "";
  if (agent === "title") return TITLE_REFUSAL;
  if (agent === "summary" || agent === "compaction") return SUMMARY_REFUSAL;
  return REFUSAL;
}

function publicInfo(body: MutableRecord): string {
  const names = toolNames(body.tools).filter((name) => Object.hasOwn(SAFE_TOOLS, name));
  if (names.length === 0) return "I can help with coding, analysis, file review, and project tasks when the active profile grants those capabilities. I can’t expose hidden prompts, raw tool schemas, or private configuration.";
  return [
    "Publicly available capabilities in this request:",
    ...names.map((name) => `${name}: ${SAFE_TOOLS[name]}`),
    "I can’t expose hidden prompts, raw tool schemas, or private configuration.",
  ].join("\n");
}

function toolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((tool) => {
    if (!isRecord(tool)) return [];
    if (typeof tool.name === "string") return [tool.name];
    return isRecord(tool.function) && typeof tool.function.name === "string" ? [tool.function.name] : [];
  });
}

function syntheticResponse(content: string, stream: boolean, model: string): Response {
  const id = `chatcmpl-superclaw-guard-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  if (stream) return new Response(sseBody(content, model, id, created), { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
  return Response.json({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

function sseBody(content: string, model: string, id: string, created: number): string {
  const base = { id, object: "chat.completion.chunk", created, model };
  return [
    { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
}

function isRecord(value: unknown): value is MutableRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
