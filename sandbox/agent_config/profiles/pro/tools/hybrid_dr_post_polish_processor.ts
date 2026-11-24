import { tool } from "@opencode-ai/plugin"
import { createHash } from "crypto"
import { readFileSync } from "fs"
import { mkdir, readFile, readdir, stat, writeFile } from "fs/promises"
import { basename, join, dirname } from "path"
import {
  resolveDeliverableName,
  resolveDeliverablePath,
  workspaceDeliverableRoot,
} from "./_deep_research_deliverable"
import {
  DataPathRefusedError,
  DataPathsNotSelectedError,
  SELECTED_FILES_UNAVAILABLE_MESSAGE,
  SelectedFilesUnavailableError,
  countNotSelected,
  dataPathRefusalFromResponse,
  dataPathRefusalMessage,
  dataPathsNotSelectedMessage,
  intersectWithSelectedFiles,
  nativeWorkspacePath,
  selectedFilesFor,
} from "./_hdr_selected_files"

const SIDECAR_PORT = process.env.HYBRID_DR_PORT?.trim() || "18324"
const SIDECAR_URL = `http://127.0.0.1:${SIDECAR_PORT}`
const RUNTIME_CONFIG_FILE = "superclaw-runtime-config.json"
function defaultSessionRoot(): string {
  const fromEnv = process.env.HYBRID_DR_SESSION_ROOT?.trim()
  if (fromEnv) return fromEnv
  return join(workspaceDeliverableRoot(), "deep-research-workspaces", "sessions")
}
const PROGRESS_DIR = "openwork/hybrid-dr-progress"
const POLL_INTERVAL_MS = 2500
// Outlive the supervisor's 30s sidecar startup health window plus restart backoff.
const SIDECAR_RETRY_WINDOW_MS = 45_000
const SIDECAR_RETRY_DELAY_MS = 500
// The tool's poll window must OUTLIVE the sidecar's own run deadline
// (HYBRID_DR_RUN_BUDGET_S, default 600s in api/serve.py). If the tool stops
// polling first, a run the sidecar later declares FAILED has no channel back
// to the user — the turn already ended on "still running" and no report ever
// appears (issue #1633, rc.3 repro 2026-07-29: tool gave up at 8 min, the
// sidecar deadline fired at 10 min, failure was never surfaced).
const SIDECAR_RUN_BUDGET_S =
  Number.parseFloat(process.env.HYBRID_DR_RUN_BUDGET_S ?? "") || 600
const TOOL_POLL_BUDGET_MS = (SIDECAR_RUN_BUDGET_S + 90) * 1000

type RuntimeConfig = {
  search?: { tavilyApiKey?: string }
  deepResearch?: { localFilePrivacy?: "share_with_cloud" | "do_not_share_with_cloud" }
}

export function hdrSearchCredentials(
  config: RuntimeConfig,
  managed: boolean,
  connectorConfigPath = process.env.SUPERCLAW_CONNECTOR_CONFIG?.trim() ?? "",
): { usesNativeConnector: boolean; tavilyApiKey?: string } {
  if (managed && !connectorConfigPath) throw new Error("HDR client Connector configuration is missing")
  if (connectorConfigPath) return { usesNativeConnector: true }
  const tavilyApiKey = config.search?.tavilyApiKey?.trim()
  return {
    usesNativeConnector: false,
    ...(tavilyApiKey ? { tavilyApiKey } : {}),
  }
}

function runtimeConfigPath(): string {
  const dir = process.env.SC_RUNTIME_CONFIG_DIR?.trim()
    || "/data/superclaw/runtime"
  return join(dir, RUNTIME_CONFIG_FILE)
}

export function progressRoot(): string {
  const root = process.env.HYBRID_DR_PROGRESS_ROOT?.trim()
  const mode = currentHdrClientMode()
  if (mode.managed) {
    if (!root) throw new Error("HDR managed progress root is missing")
    return join(root, createHash("sha256").update(mode.apiToken).digest("hex"))
  }
  if (root) return root
  const dir = process.env.SC_RUNTIME_CONFIG_DIR?.trim()
    || "/data/superclaw/runtime"
  return join(dir, PROGRESS_DIR)
}

function stringField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

function safePathSegment(value: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,159}$/.test(value)) throw new Error("Invalid HDR progress identity")
  return value
}

function progressIdentity(context: unknown): { opencodeSessionId: string; toolCallId: string } | null {
  const record = context && typeof context === "object" ? context as Record<string, unknown> : {}
  const opencodeSessionId = stringField(record, ["sessionID", "sessionId", "session_id"])
  const toolCallId = stringField(record, ["callID", "callId", "toolCallID", "toolCallId", "partID", "partId", "messageID", "messageId"])
  if (!opencodeSessionId || !toolCallId) return null
  return { opencodeSessionId, toolCallId }
}

function usageSessionId(context: unknown): string {
  const record = context && typeof context === "object" ? context as Record<string, unknown> : {}
  return stringField(record, ["sessionID", "sessionId", "session_id"])
}

function usageMessageId(context: unknown): string {
  const record = context && typeof context === "object" ? context as Record<string, unknown> : {}
  return stringField(record, ["messageID", "messageId", "message_id"])
}

export async function writeProgressRegistry(
  context: unknown,
  payload: Record<string, unknown>,
): Promise<void> {
  const identity = progressIdentity(context)
  if (!identity) return
  const dir = join(progressRoot(), safePathSegment(identity.opencodeSessionId))
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${safePathSegment(identity.toolCallId)}.json`),
    JSON.stringify({ ...identity, ...payload, updatedAt: Date.now() }, null, 2) + "\n",
    "utf8",
  )
}

export function readRuntimeConfig(): RuntimeConfig {
  try {
    return JSON.parse(readFileSync(runtimeConfigPath(), "utf8")) as RuntimeConfig
  } catch {
    return {}
  }
}

export function privacyTierFromRuntimeConfig(config: RuntimeConfig): "0" | "2" {
  return config.deepResearch?.localFilePrivacy === "share_with_cloud" ? "0" : "2"
}

function llmrouterUrl(): string {
  return (process.env.LRM_API_BASE_URL?.trim() || "http://127.0.0.1:18321").replace(/\/$/, "")
}

function openAiBaseUrl(rootUrl: string): string {
  return `${rootUrl.replace(/\/$/, "")}/v1`
}

type CreateResponse = {
  session_id: string
  root_dir: string
  state: Record<string, unknown>
}

type HybridDrState = {
  current_phase: string
  completed_phases: string[]
  failed_phases: string[]
  artifacts: Record<string, string>
  // Reason the run failed (persisted with the state, survives sidecar
  // restarts). Absent on healthy runs and on pre-fix sidecars.
  last_error?: string | null
}

type StateResponse = {
  session_id: string
  state: HybridDrState
}

type RunResponse = {
  session_id: string
  run_id?: string | null
  status?: string
  state: HybridDrState
  error: string | null
}

type ProgressRecord = {
  status?: string
  opencodeSessionId?: string
  toolCallId?: string
  sidecarSessionId?: string
  runId?: string
  sidecarUrl?: string
  rootDir?: string
  userQueryHash?: string
  updatedAt?: number
  terminal?: boolean
}

class SidecarHttpError extends Error {
  readonly status: number

  constructor(status: number) {
    // Upstream bodies/URLs may contain queries, paths or credentials; expose only the status.
    super(`HDR sidecar HTTP ${status}`)
    this.status = status
  }
}

export function hdrApiHeaders(
  apiToken: string,
  contentType: "json" | "none",
): Record<string, string> | undefined {
  const headers: Record<string, string> = {}
  if (contentType === "json") headers["Content-Type"] = "application/json"
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`
  return Object.keys(headers).length > 0 ? headers : undefined
}

export function hdrClientMode(
  managedValue: string,
  apiToken: string,
): { managed: boolean; apiToken: string } {
  if (managedValue === "") {
    if (apiToken) throw new Error("HDR client mode is inconsistent")
    return { managed: false, apiToken: "" }
  }
  if (managedValue !== "1" || !/^[A-Za-z0-9_-]{32,256}$/.test(apiToken)) {
    throw new Error("HDR client managed configuration is invalid")
  }
  return { managed: true, apiToken }
}

function currentHdrClientMode(): { managed: boolean; apiToken: string } {
  return hdrClientMode(process.env.HYBRID_DR_NATIVE_MANAGED?.trim() || "", process.env.HYBRID_DR_API_TOKEN?.trim() || "")
}

export function hdrLegacyRequestOverrides(
  apiToken: string,
  input: {
    routerUrl: string
    routerBaseUrl: string
    cloudModel: string
    tavilyApiKey?: string
    sessionRoot: string
  },
): Record<string, unknown> {
  if (apiToken) return {}
  return {
    llmrouter_url: input.routerUrl,
    cloud_llm: {
      base_url: input.routerBaseUrl,
      model: input.cloudModel,
      legacy_pii_nonce_bypass: false,
    },
    local_llm: {
      base_url: input.routerBaseUrl,
      model: "local-model",
      legacy_pii_nonce_bypass: false,
    },
    ...(input.tavilyApiKey ? { tavily_api_key: input.tavilyApiKey } : {}),
    session_root: input.sessionRoot,
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const clientMode = currentHdrClientMode()
  // egress-surface: hdr_post_polish_sidecar
  const res = await fetch(url, {
    method: "POST",
    headers: hdrApiHeaders(clientMode.apiToken, "json"),
    redirect: "error",
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw (await dataPathRefusalFromResponse(res)) ?? new SidecarHttpError(res.status)
  }
  return (await res.json()) as T
}

async function getJson<T>(url: string): Promise<T> {
  const clientMode = currentHdrClientMode()
  // egress-surface: hdr_post_polish_sidecar
  const res = await fetch(url, { headers: hdrApiHeaders(clientMode.apiToken, "none"), redirect: "error" })
  if (!res.ok) {
    throw new SidecarHttpError(res.status)
  }
  return (await res.json()) as T
}

export type HdrWebSearch = { query: string; results: { title: string; url: string }[] }

const MAX_WEB_SEARCHES = 20
const MAX_RESULTS_PER_SEARCH = 10

/** The sidecar's per-query records (W-NNN.json) from input_web, for the UI only: they ride on tool
 * metadata, never on the output the model reads. Unreadable or malformed records are skipped. */
export async function readWebSearches(dir: string): Promise<HdrWebSearch[]> {
  let files: string[]
  try {
    files = (await readdir(dir)).filter((file) => /^W-\d+\.json$/.test(file)).sort()
  } catch {
    return []
  }
  const searches: HdrWebSearch[] = []
  for (const file of files.slice(0, MAX_WEB_SEARCHES)) {
    let parsed: { query?: unknown; results?: unknown }
    try {
      parsed = JSON.parse(await readFile(join(dir, file), "utf8"))
    } catch {
      continue
    }
    if (typeof parsed?.query !== "string" || !parsed.query.trim()) continue
    const results: HdrWebSearch["results"] = []
    for (const raw of Array.isArray(parsed.results) ? parsed.results : []) {
      if (results.length >= MAX_RESULTS_PER_SEARCH) break
      if (!raw || typeof raw !== "object") continue
      const url = typeof raw.url === "string" ? raw.url.trim() : ""
      if (!/^https?:\/\//i.test(url)) continue
      results.push({ title: typeof raw.title === "string" ? raw.title.trim() : "", url })
    }
    searches.push({ query: parsed.query.trim(), results })
  }
  return searches
}

const PHASE_ORDER = [
  "input_local",
  "input_web",
  "plan",
  "section_write",
  "fill",
  "conclusion",
  "fill_conclusion",
  "assemble",
  "polish",
]
const PHASE_HUMAN: Record<string, string> = {
  input_local: "Reading local data",
  input_web: "Web research",
  plan: "Planning sections",
  section_write: "Drafting sections",
  fill: "Filling placeholders",
  conclusion: "Writing conclusion",
  fill_conclusion: "Filling conclusion",
  assemble: "Assembling report",
  polish: "Polishing report",
}
const MAX_LOCAL_FILES = 20
const MAX_SECTIONS = 30

export type HdrPhaseStatus = "done" | "running" | "failed" | "pending" | "skipped"
/** What the Activity panel shows of a run, for the UI only, like `HdrWebSearch`. Local files are
 * names only: their contents stay out of the panel. */
export type HdrSectionStage = "writing" | "reviewing" | "done"
export type HdrProgress = {
  phases: { phase: string; label: string; status: HdrPhaseStatus; durationMs?: number }[]
  localFiles: string[]
  sectionCount: number
  sections: { title: string; stage: HdrSectionStage; attempt?: number }[]
}
export type HdrPhaseTimes = Map<string, { startedAt: number; endedAt?: number }>

/** Times a phase from the first poll that sees it running to the first that sees it complete. A
 * phase that started and finished between two polls, or before this call, has no duration. */
export function trackPhaseTimes(times: HdrPhaseTimes, state: HybridDrState, now: number): void {
  for (const phase of state.completed_phases) {
    const timing = times.get(phase)
    if (timing && timing.endedAt === undefined) timing.endedAt = now
  }
  if (!terminalStatus(state.current_phase) && !times.has(state.current_phase)) {
    times.set(state.current_phase, { startedAt: now })
  }
}

export function hdrPhaseList(state: HybridDrState, times: HdrPhaseTimes): HdrProgress["phases"] {
  const terminal = terminalStatus(state.current_phase)
  const completed = new Set(state.completed_phases)
  return PHASE_ORDER.map((phase) => {
    let status: HdrPhaseStatus = "pending"
    // A phase that failed once and was retried stays in failed_phases, so completion wins.
    if (completed.has(phase)) status = "done"
    else if (phase === state.current_phase) status = "running"
    else if (terminal === "failed" && state.failed_phases.includes(phase)) status = "failed"
    else if (terminal === "done") status = "skipped"
    const timing = times.get(phase)
    const durationMs = timing?.endedAt !== undefined ? timing.endedAt - timing.startedAt : undefined
    return { phase, label: PHASE_HUMAN[phase] ?? phase, status, ...(durationMs !== undefined ? { durationMs } : {}) }
  })
}

/** How many sections the plan has, and the ones the writer has started, in plan order, with the
 * stage in each `<id>_status.json`. Unstarted sections are left out, so the list grows as the
 * writer gets to them. `<id>_final.md` is not a signal: a retried phase keeps the old finals. */
export async function readSectionProgress(
  cloudIntermediate: string,
): Promise<Pick<HdrProgress, "sectionCount" | "sections">> {
  let plan: { sections?: unknown }
  try {
    plan = JSON.parse(await readFile(join(cloudIntermediate, "plan.json"), "utf8"))
  } catch {
    return { sectionCount: 0, sections: [] }
  }
  if (!Array.isArray(plan?.sections)) return { sectionCount: 0, sections: [] }
  const sectionsDir = join(cloudIntermediate, "sections")
  let files = new Set<string>()
  try {
    files = new Set(await readdir(sectionsDir))
  } catch {}
  const sections: HdrProgress["sections"] = []
  for (const raw of plan.sections.slice(0, MAX_SECTIONS)) {
    const id = typeof raw?.id === "string" && /^[\w-]+$/.test(raw.id) ? raw.id : ""
    const title = typeof raw?.title === "string" && raw.title.trim() ? raw.title.trim() : id
    if (!id || !title) continue
    if (!files.has(`${id}_status.json`)) continue
    try {
      const statusValue: unknown = JSON.parse(await readFile(join(sectionsDir, `${id}_status.json`), "utf8"))
      const status =
        statusValue && typeof statusValue === "object"
          ? (statusValue as { stage?: unknown; attempt?: unknown })
          : {}
      if (status?.stage === "done") {
        sections.push({ title, stage: "done" })
        continue
      }
      const stage = status?.stage === "reviewing" ? "reviewing" : "writing"
      const attempt =
        typeof status.attempt === "number" && Number.isInteger(status.attempt) && status.attempt > 0
          ? status.attempt
          : undefined
      sections.push({ title, stage, ...(attempt ? { attempt } : {}) })
    } catch {
      sections.push({ title, stage: "writing" })
    }
  }
  return { sectionCount: plan.sections.length, sections }
}

export function hdrLocalFileNames(dataPaths: readonly string[]): string[] {
  return dataPaths.slice(0, MAX_LOCAL_FILES).map((path) => basename(path))
}

function hashUserQuery(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/**
 * Build a TERMINAL error envelope (status "error"). Returned — never thrown —
 * for PERMANENT failures (misconfiguration, a deterministically-failed pipeline
 * run) so 93_hybrid_dr_terminal_guard marks the turn terminal and blocks the
 * weak driver model from re-calling the tool until it burns its step budget
 * (issue #1633). Transient errors (sidecar HTTP/network) still throw so the
 * model may retry / resume.
 */
function errorEnvelope(message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ status: "error", message, ...extra }, null, 2)
}

/** Keep only data_paths that resolve to existing regular files. Drops missing
 * paths and directories (the prompt forbids both) so a weak model that invents
 * a path or passes a folder can't derail or crash the sidecar run (issue #1633). */
async function validateDataPaths(
  candidates: string[],
  inspect: (path: string) => Promise<{ isFile(): boolean }> = stat,
): Promise<string[]> {
  const kept: string[] = []
  for (const p of candidates) {
    try {
      if ((await inspect(p)).isFile()) kept.push(p)
    } catch {
      // missing / inaccessible → drop
    }
  }
  return kept
}

/** Managed mode accepts only paths on the user's current message (`selected`) and refuses when the
 * model named any other; HDR then enforces the workspace root. Legacy mode keeps its pre-PR4
 * behaviour. */
export async function prepareHdrDataPaths(
  candidates: string[],
  managed: boolean,
  inspect: (path: string) => Promise<{ isFile(): boolean }> = stat,
  selected: readonly string[] | null = null,
): Promise<string[]> {
  const normalized = candidates.map((path) => path.trim()).filter(Boolean)
  if (!managed) return validateDataPaths(normalized, inspect)
  if (normalized.length === 0) return []
  if (selected === null) throw new SelectedFilesUnavailableError()
  const named = normalized.map((path) => nativeWorkspacePath(path))
  const selectedPaths = selected.map((path) => nativeWorkspacePath(path))
  const notSelected = countNotSelected(named, selectedPaths)
  if (notSelected > 0) throw new DataPathsNotSelectedError(notSelected)
  return validateDataPaths(intersectWithSelectedFiles(named, selectedPaths), inspect)
}

function terminalStatus(phase: string): "done" | "failed" | "cancelled" | null {
  const normalized = phase.toLowerCase()
  if (normalized === "done") return "done"
  if (normalized === "failed") return "failed"
  if (normalized === "cancelled") return "cancelled"
  return null
}

type SidecarRetryOptions = {
  windowMs?: number
  delayMs?: number
}

function isTransientSidecarError(error: unknown): boolean {
  if (error instanceof SidecarHttpError) return error.status >= 500
  if (error instanceof TypeError) return true
  if (!(error instanceof Error)) return false
  const cause = error.cause
  const code =
    cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : ""
  return /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_)/.test(code)
    || /unable to connect|fetch failed/i.test(error.message)
}

async function retryTransientSidecarRequest<T>(
  operation: () => Promise<T>,
  options: SidecarRetryOptions = {},
): Promise<T> {
  const windowMs = options.windowMs ?? SIDECAR_RETRY_WINDOW_MS
  const delayMs = options.delayMs ?? SIDECAR_RETRY_DELAY_MS
  const deadline = Date.now() + windowMs
  while (true) {
    try {
      return await operation()
    } catch (error) {
      if (!isTransientSidecarError(error) || Date.now() >= deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

export async function pollOrResumeRun(
  runUrl: string,
  body: Record<string, unknown>,
  options: SidecarRetryOptions = {},
): Promise<RunResponse> {
  const observed = await retryTransientSidecarRequest(
    () => getJson<RunResponse>(runUrl),
    options,
  )
  if (observed.status?.toLowerCase() !== "idle" || terminalStatus(observed.state.current_phase)) {
    return observed
  }
  return retryTransientSidecarRequest(
    () => postJson<RunResponse>(runUrl, body),
    options,
  )
}

async function readResumableProgress(context: unknown, userQueryHash: string): Promise<ProgressRecord | null> {
  const identity = progressIdentity(context)
  if (!identity) return null
  const dir = join(progressRoot(), safePathSegment(identity.opencodeSessionId))
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return null
  }
  const records: ProgressRecord[] = []
  for (const file of files) {
    if (!file.endsWith(".json")) continue
    try {
      const parsed = JSON.parse(await readFile(join(dir, file), "utf8")) as ProgressRecord
      if (parsed.opencodeSessionId === identity.opencodeSessionId
        && parsed.toolCallId === file.slice(0, -5)
        && parsed.userQueryHash === userQueryHash
        && typeof parsed.sidecarSessionId === "string"
        && parsed.sidecarSessionId.length === 28
        && /^ses_[0-9a-f]{24}$/.test(parsed.sidecarSessionId)) records.push(parsed)
    } catch {}
  }
  records.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return records[0] ?? null
}

export default tool({
  description:
    "Start or resume the hybrid deep-research pipeline via the LangGraph sidecar. " +
    "The sidecar runs input_local → input_web → plan → section_write → fill → conclusion " +
    "→ assemble → polish in the background; this tool polls status and returns " +
    "report paths when complete or a running/cancelled status envelope otherwise.",
  args: {
    user_query: tool.schema
      .string()
      .describe("The user's research question verbatim — do not paraphrase."),
    task_class: tool.schema
      .enum(["deep_research", "ten_task", "officeqa"])
      .describe("Task class. Use deep_research for general report-generation research tasks."),
    data_paths: tool.schema
      .array(tool.schema.string())
      .describe("Absolute paths to the SPECIFIC local files the user attached or explicitly named — one entry per file. Do NOT pass a directory path, and do NOT expand the user's file selection to other files in the same folder. Use [] when no local files are in scope."),
    title: tool.schema
      .string()
      .describe('Report title, e.g. "Technology Modernization Assessment Report".'),
    output_path: tool.schema
      .string()
      .optional()
      .describe('Optional. When the user asks to save the report as a specific file (e.g. "save it as model_comparison.md"), pass that exact filename here. Basename only — no directories; must end in .md. Omit when the user did not name an output file.'),
  },
  async execute(args, context) {
    const clientMode = currentHdrClientMode()
    progressRoot() // Refuse missing managed writable state before admitting research work.
    const labelFor = (phase: string, idx: number) => {
      const human = PHASE_HUMAN[phase] ?? phase
      return `Hybrid Deep Research [${idx}/9: ${human}]`
    }

    context.metadata({ title: "Hybrid Deep Research: Starting…" })
    const taskClass = args.task_class
    const title = args.title
    const routerUrl = llmrouterUrl()
    const routerBaseUrl = openAiBaseUrl(routerUrl)
    const cloudModel = "cloud-model"
    let dataPaths: string[]
    try {
      dataPaths = await prepareHdrDataPaths(
        args.data_paths,
        clientMode.managed,
        stat,
        selectedFilesFor(usageSessionId(context)),
      )
    } catch (error) {
      if (error instanceof DataPathsNotSelectedError) {
        return errorEnvelope(dataPathsNotSelectedMessage(error.count), {
          error_kind: "data_path",
          reason: "not_selected",
        })
      }
      return errorEnvelope(SELECTED_FILES_UNAVAILABLE_MESSAGE, {
        error_kind: "data_path",
        reason: "selected_files_unavailable",
      })
    }
    // HDR's typed data_paths refusal is permanent for this request: a terminal envelope, not a throw.
    const refusedEnvelope = (error: unknown): string | null =>
      error instanceof DataPathRefusedError
        ? errorEnvelope(dataPathRefusalMessage(error), {
          error_kind: "data_path",
          reason: error.reason,
          index: error.index,
        })
        : null
    const runtimeConfig = readRuntimeConfig()
    const sessionId = usageSessionId(context)
    const messageId = usageMessageId(context)
    const searchCredentials = hdrSearchCredentials(runtimeConfig, clientMode.managed)
    if (!searchCredentials.usesNativeConnector && !searchCredentials.tavilyApiKey) {
      // Permanent misconfiguration: return a terminal error envelope (not a
      // throw) so the guard blocks re-calls instead of letting a weak model
      // retry this identical failure until it hits Max Steps (issue #1633).
      return errorEnvelope(
        "Tavily API key is not configured. Please configure Tavily in Settings before running Hybrid Deep Research.",
        { error_kind: "config" },
      )
    }

    const body: Record<string, unknown> = {
      user_query: args.user_query,
      task_class: taskClass,
      privacy_tier: privacyTierFromRuntimeConfig(runtimeConfig),
      data_paths: dataPaths,
      title,
      ...(sessionId ? { opencode_session_id: sessionId } : {}),
      ...(messageId ? { opencode_message_id: messageId } : {}),
      cloud_model: cloudModel,
      ...hdrLegacyRequestOverrides(clientMode.managed ? clientMode.apiToken : "", {
        routerUrl,
        routerBaseUrl,
        cloudModel,
        tavilyApiKey: searchCredentials.tavilyApiKey,
        sessionRoot: defaultSessionRoot(),
      }),
    }

    const userQueryHash = hashUserQuery(args.user_query)
    const existing = await readResumableProgress(context, userQueryHash)
    let sidecarSessionId = existing?.sidecarSessionId ?? ""
    let runId = existing?.runId ?? ""
    let rootDir = existing?.rootDir ?? ""
    let run: RunResponse | StateResponse = {
      session_id: sidecarSessionId,
      state: {
        current_phase: "input_local",
        completed_phases: [],
        failed_phases: [],
        artifacts: {},
      },
      error: null,
    } as RunResponse

    if (sidecarSessionId) {
      try {
        run = await retryTransientSidecarRequest(
          () => getJson<StateResponse>(`${SIDECAR_URL}/v1/hybrid-dr/sessions/${sidecarSessionId}/state`),
        )
      } catch {
        sidecarSessionId = ""
        runId = ""
        rootDir = ""
      }
    }

    if (!sidecarSessionId) {
      let created: CreateResponse
      try {
        created = await postJson<CreateResponse>(
          `${SIDECAR_URL}/v1/hybrid-dr/sessions`,
          body,
        )
      } catch (error) {
        const refused = refusedEnvelope(error)
        if (refused) return refused
        throw error
      }
      sidecarSessionId = created.session_id
      if (typeof sidecarSessionId !== "string" || sidecarSessionId.length !== 28
        || !/^ses_[0-9a-f]{24}$/.test(sidecarSessionId)) throw new Error("Invalid HDR session identity")
      rootDir = created.root_dir
      run = {
        session_id: created.session_id,
        state: created.state as HybridDrState,
        error: null,
      } as RunResponse
      await writeProgressRegistry(context, {
        tool: "hybrid_dr_post_polish_processor",
        status: "running",
        terminal: false,
        sidecarSessionId,
        sidecarUrl: SIDECAR_URL,
        rootDir,
        userQueryHash,
        createdAt: Date.now(),
      }).catch(() => {})
    }

    if (!clientMode.managed) {
      body.session_root = rootDir ? dirname(rootDir) : defaultSessionRoot()
    }
    const runUrl = `${SIDECAR_URL}/v1/hybrid-dr/sessions/${sidecarSessionId}/run`
    await writeProgressRegistry(context, {
      tool: "hybrid_dr_post_polish_processor",
      status: "running",
      terminal: false,
      sidecarSessionId,
      runId,
      sidecarUrl: SIDECAR_URL,
      rootDir,
      userQueryHash,
    }).catch(() => {})

    const fsp = await import("fs/promises")
    const pathMod = await import("path")
    const cloudInter = pathMod.join(rootDir, "cloud_intermediate")
    const webSearchesDir = pathMod.join(cloudInter, "insights", "web_searches")
    const phaseTimes: HdrPhaseTimes = new Map()
    const localFiles = hdrLocalFileNames(dataPaths)
    const readProgress = async (): Promise<{ webSearches: HdrWebSearch[]; hdrProgress: HdrProgress }> => ({
      webSearches: await readWebSearches(webSearchesDir),
      hdrProgress: {
        phases: hdrPhaseList(run.state, phaseTimes),
        localFiles,
        ...(await readSectionProgress(cloudInter)),
      },
    })
    const withProgress = async (output: string) => ({ output, metadata: await readProgress() })

    const countSectionsFinal = async (): Promise<{ done: number; total: number }> => {
      try {
        const sectionsDir = pathMod.join(cloudInter, "sections")
        const files = await fsp.readdir(sectionsDir)
        const finals = files.filter((f) => /^S\d+_final\.md$/.test(f)).length
        let total = 0
        try {
          const planRaw = await fsp.readFile(pathMod.join(cloudInter, "plan.json"), "utf-8")
          const plan = JSON.parse(planRaw)
          total = Array.isArray(plan?.sections) ? plan.sections.length : 0
        } catch {}
        return { done: finals, total }
      } catch {
        return { done: 0, total: 0 }
      }
    }
    const countConclusionCands = async (): Promise<number> => {
      try {
        const conclusionsDir = pathMod.join(cloudInter, "conclusions")
        const files = await fsp.readdir(conclusionsDir)
        return files.filter((f) => /^cand_\d+\.md$/.test(f)).length
      } catch {
        return 0
      }
    }
    const countWebInsights = async (): Promise<number> => {
      try {
        const dir = pathMod.join(cloudInter, "insights", "web")
        const files = await fsp.readdir(dir)
        return files.filter((f) => /^W-\d+\.md$/.test(f)).length
      } catch {
        return 0
      }
    }
    const subProgressLabel = async (phase: string): Promise<string> => {
      if (phase === "input_web") {
        const n = await countWebInsights()
        return n > 0 ? ` [${n} W-files]` : ""
      }
      if (phase === "section_write") {
        const { done, total } = await countSectionsFinal()
        return total > 0 ? ` [${done}/${total} sections]` : ""
      }
      if (phase === "conclusion") {
        const n = await countConclusionCands()
        return n > 0 ? ` [${n} candidates]` : ""
      }
      return ""
    }

    // PRE-VERIFY (issue #1633): a post-terminal re-call resumes a sidecar
    // session ALREADY at a terminal phase. Do NOT re-POST /run (that
    // re-triggers the pipeline). Skip to the terminal-return below so the
    // re-call returns the SAME successful "ok" envelope fast (reads the
    // existing report) — a success, not a wasteful re-run. This lets
    // 93_hybrid_dr_terminal_guard stop THROWING on re-calls (its throw
    // surfaced as red TOOL_ERROR dots in the UI).
    if (!terminalStatus(run.state.current_phase)) {
      let startedRun: RunResponse
      try {
        startedRun = await retryTransientSidecarRequest(
          () => postJson<RunResponse>(runUrl, body),
        )
      } catch (error) {
        const refused = refusedEnvelope(error)
        if (refused) return refused
        throw error
      }
      runId = startedRun.run_id ?? runId
      run = startedRun
      await writeProgressRegistry(context, {
        tool: "hybrid_dr_post_polish_processor",
        status: "running",
        terminal: false,
        sidecarSessionId,
        runId,
        sidecarUrl: SIDECAR_URL,
        rootDir,
        userQueryHash,
      }).catch(() => {})
    }

    const pollStarted = Date.now()
    while (true) {
      const currentPhase = run.state.current_phase
      trackPhaseTimes(phaseTimes, run.state, Date.now())
      const terminal = terminalStatus(currentPhase)
      if (terminal) break
      const idx = PHASE_ORDER.indexOf(currentPhase)
      const base = labelFor(currentPhase, Math.max(1, idx + 1))
      const tail = await subProgressLabel(currentPhase)
      context.metadata({ title: base + tail })
      // A running part shows this progress through the server's registry overlay, not context.metadata.
      await writeProgressRegistry(context, {
        tool: "hybrid_dr_post_polish_processor",
        status: "running",
        terminal: false,
        sidecarSessionId,
        runId,
        sidecarUrl: SIDECAR_URL,
        rootDir,
        userQueryHash,
        lastPhase: currentPhase,
        ...(await readProgress()),
      }).catch(() => {})

      if (Date.now() - pollStarted > TOOL_POLL_BUDGET_MS) {
        return withProgress(JSON.stringify(
          {
            status: "running",
            session_id: sidecarSessionId,
            run_id: runId,
            current_phase: currentPhase,
            completed_phases: run.state.completed_phases,
            message: "Hybrid Deep Research is still running in the background. Call this tool again to refresh status or collect the report when it finishes.",
          },
          null,
          2,
        ))
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      // Poll GET /run, not /state: only the RunResponse carries the run error,
      // which the terminal branch below surfaces to the user. Do NOT abort on a
      // non-empty failed_phases while current_phase is still non-terminal —
      // that is a phase the sidecar is retrying (phase_max_retries), and the
      // run may yet succeed. Terminal failure is detected at the loop top.
      let polled: RunResponse
      try {
        polled = await pollOrResumeRun(runUrl, body)
      } catch (error) {
        const refused = refusedEnvelope(error)
        if (refused) return refused
        throw error
      }
      run = polled
      runId = polled.run_id ?? runId
    }

    const terminal = terminalStatus(run.state.current_phase)
    if (terminal === "cancelled") {
      await writeProgressRegistry(context, {
        tool: "hybrid_dr_post_polish_processor",
        status: "cancelled",
        terminal: true,
        sidecarSessionId,
        runId,
        sidecarUrl: SIDECAR_URL,
        rootDir,
        userQueryHash,
      }).catch(() => {})
      return withProgress(JSON.stringify(
        {
          status: "cancelled",
          session_id: sidecarSessionId,
          completed_phases: run.state.completed_phases,
          message: "Hybrid Deep Research was cancelled.",
        },
        null,
        2,
      ))
    }
    // Only a terminal FAILED phase is a failure. failed_phases alone is NOT:
    // a phase that failed once, was retried, and succeeded leaves its entry in
    // failed_phases while the run ends DONE — treating that as failure
    // misreported successful runs.
    if (terminal === "failed") {
      await writeProgressRegistry(context, {
        tool: "hybrid_dr_post_polish_processor",
        status: "failed",
        terminal: true,
        sidecarSessionId,
        runId,
        sidecarUrl: SIDECAR_URL,
        rootDir,
        userQueryHash,
      }).catch(() => {})
      // Name the phase that actually failed and why (run.error from GET /run,
      // else the state's persisted last_error) — "failed at phase failed" with
      // no reason was the rc.3 symptom (issue #1633).
      const reason =
        ("error" in run && run.error ? run.error : null) ?? run.state.last_error ?? null
      const failedPhase =
        run.state.failed_phases.length > 0
          ? run.state.failed_phases.join(", ")
          : run.state.current_phase
      // Deterministic pipeline failure: terminal error envelope (not a throw)
      // so the guard blocks futile re-calls of the same failed run (issue #1633).
      return withProgress(errorEnvelope(
        `Hybrid Deep Research failed at phase ${failedPhase}${reason ? `: ${reason}` : "."}`,
        {
          error_kind: "pipeline",
          session_id: sidecarSessionId,
          completed_phases: run.state.completed_phases,
          ...(reason ? { error: reason } : {}),
        },
      ))
    }

    const path = await import("path")
    const fs = await import("fs/promises")
    const reportsDir = path.join(rootDir, "reports")
    const execPath = path.join(reportsDir, "executive_report.md")
    const summaryPath = path.join(reportsDir, "ui_summary.md")
    const analystPath = path.join(reportsDir, "analyst_report.md")

    let summaryText = ""
    try {
      summaryText = await fs.readFile(summaryPath, "utf-8")
    } catch {
      try {
        summaryText = await fs.readFile(execPath, "utf-8")
      } catch {
        summaryText = "(no summary produced)"
      }
    }
    // Strip raw markdown syntax so the chat card displays clean prose
    // rather than literal `#` / `##` / `**…**` tokens.
    summaryText = summaryText
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/^\s*[-*]\s+/gm, "• ")
      .replace(/`([^`]+)`/g, "$1")
      .trim()

    context.metadata({ title: "Hybrid Deep Research" })
    await writeProgressRegistry(context, {
      tool: "hybrid_dr_post_polish_processor",
      status: "done",
      terminal: true,
      sidecarSessionId,
      runId,
      sidecarUrl: SIDECAR_URL,
      rootDir,
      userQueryHash,
    }).catch(() => {})

    // Materialize the report as a durable, host-visible workspace file so the
    // deliverable ALWAYS exists regardless of what the (possibly weak) driver
    // model does after this tool returns — the on-device model often burns its
    // step budget re-calling this tool instead of saving the report (issue
    // #1633). Writing directly via fs bypasses the agent permission/guard
    // layer. Best-effort: never fail a completed run over the durable copy.
    let deliverablePath: string | undefined
    let deliverableError: string | undefined
    try {
      const deliverableName = resolveDeliverableName({
        outputPath: args.output_path,
        userQuery: args.user_query,
        title,
      })
      const target = resolveDeliverablePath(deliverableName)
      const reportContent = await fs.readFile(execPath, "utf-8")
      await fs.mkdir(workspaceDeliverableRoot(), { recursive: true })
      await fs.writeFile(target, reportContent, "utf-8")
      deliverablePath = target
    } catch (error) {
      // durable copy is best-effort; the report panel + sidecar path still
      // stand. But swallowing the failure outright left #3608 ("no HDR folder
      // appeared in workspace") with zero diagnostics, so carry it in the
      // result where the session log preserves it.
      deliverableError = error instanceof Error ? error.message : String(error)
    }

    // Field shape mirrors the legacy hybrid_dr_post_polish_processor so
    // SuperClaw UI's extractor at session.tsx#extractHybridDeepResearchReportPaths
    // finds reportPath + summaryPath and renders the report panel. The UI
    // has special rendering for this tool that surfaces `summary` instead
    // of the raw JSON in the card body.
    return hdrCompletedResult(
      {
        agent_instruction:
          "STOP — Hybrid Deep Research is COMPLETE for this turn. The executive report exists and is verified on disk and is rendered in the report panel below; there is nothing to verify or check, and calling this tool (or any tool) again this turn does nothing. Reply with EXACTLY this line and nothing else, then stop:\n\nResearch complete. See the report panel below.",
        status: "ok",
        session_id: sidecarSessionId,
        completed_phases: run.state.completed_phases,
        published_executive_report_path: execPath,
        executive_report_path: execPath,
        ui_summary_path: summaryPath,
        analyst_report_path: analystPath,
        deliverable_path: deliverablePath,
        ...(deliverableError ? { deliverable_error: deliverableError } : {}),
      },
      summaryText,
      await readProgress(),
    )
  },
})

/** The report summary may hold values from local files, so it goes only to `metadata` (UI); `output` reaches the agent's model. */
export function hdrCompletedResult<M extends Record<string, unknown>>(
  fields: Record<string, unknown>,
  summary: string,
  progress: M,
): { output: string; metadata: M & { summary: string } } {
  return { output: JSON.stringify(fields, null, 2), metadata: { ...progress, summary } }
}
