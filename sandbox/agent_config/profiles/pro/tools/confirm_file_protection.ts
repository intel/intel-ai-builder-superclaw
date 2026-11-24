import { tool } from "@opencode-ai/plugin"

declare const process: { env: Record<string, string | undefined> }

/**
 * confirm_file_protection
 *
 * routing tool that decides whether to use protected-file-agent or local-file-agent
 * for sensitive file types (.csv, .xlsx, .parquet, etc.).
 *
 * SECURITY MODEL:
 * - If the session is pinned to the local model: No protection needed → local-file-agent
 * - If data could reach cloud: Show user approval dialog → protected-file-agent (if approved)
 *
 * TWO-STAGE CHECK:
 * 1. Is data-protection mode enabled globally? (Check settings)
 * 2. Is THIS session pinned to the local model? (llmrouter/local-model)
 *
 * DECISION TREE:
 * Mode = "none"                   → PROTECTION_DISABLED → local-file-agent (no dialog)
 * Pinned to the local model       → PROTECTION_DISABLED → local-file-agent (no dialog)
 * auto/cloud-model/unknown model  → Show dialog:
 *                             - User approves → protected-file-agent
 *                             - User denies → local-file-agent (fallback for this request only)
 *
 * WHY THE LOCAL-MODEL BYPASS IS SAFE:
 * The router never escalates a request for llmrouter/local-model, so the file content never
 * leaves the device. /v1/session/{id}/locality is not consulted: it reports only the latest
 * request's route, and an `auto` session can be routed to the cloud on any later turn.
 * The protected pipeline's purpose is to mask PII before cloud processing - if there's no
 * cloud, masking is unnecessary overhead. User gets seamless local experience.
 *
 * FAIL-SAFE BEHAVIOR:
 * If the session's model is unknown, we treat it as not pinned and show the dialog.
 * This is safer than assuming local routing.
 */

// ============================================================================
// ONE-SHOT APPROVAL/DENIAL TRACKING
// ============================================================================
// These global sets track user decisions for the CURRENT REQUEST ONLY.
// The agent must call confirm_file_protection again for each new file request.
// This prevents "remember my choice" security issues where one approval
// would apply to all future files without re-confirmation.

// Sessions that received user approval for protected-file-agent.
// The pipeline guard consumes this approval token on the next task() dispatch.
const APPROVAL_KEY = "__sc_confirm_file_protection_approved"
const APPROVED_PATHS_KEY = "__sc_confirm_file_protection_paths"

/** Return the shared approval set, creating it the first time it is needed. */
function approvedSessions(): Set<string> {
  const g = globalThis as unknown as Record<string, Set<string> | undefined>
  return (g[APPROVAL_KEY] ??= new Set<string>())
}

// Sessions where the user declined protected-file-agent OR protection was disabled.
// The default tool guard consumes this denial to allow local-file-agent as a fallback
// for THIS REQUEST ONLY. Next file request requires a new confirm_file_protection call.
const DENIAL_KEY = "__sc_confirm_file_protection_denied"

const DEFAULT_DATA_PROTECTION_HOST = "127.0.0.1"
const DEFAULT_DATA_PROTECTION_PORT = "18826"
const PREFLIGHT_PATH = "/v1/file/preflight"
// Whole-segment match for the sensitive/ drop folder (duplicated from the terminal guard plugin).
const SENSITIVE_FOLDER_PATH_RE = /(?:^|[\/\\\s'"=:(])sensitive(?=[\/\\'"\s;&|)]|$)/i

/** Return the shared denial set, creating it the first time it is needed. */
function deniedSessions(): Set<string> {
  const g = globalThis as unknown as Record<string, Set<string> | undefined>
  return (g[DENIAL_KEY] ??= new Set<string>())
}

// Sessions whose decline was already used to dispatch local-file-agent; the terminal guard
// reads this when the child session is created.
const DECLINE_FALLBACK_KEY = "__sc_decline_fallback_parents"
function declineFallbackParents(): Set<string> {
  const g = globalThis as unknown as Record<string, Set<string> | undefined>
  return (g[DECLINE_FALLBACK_KEY] ??= new Set<string>())
}

function buildPreflightUrl(): string {
  const host = process.env.DATA_PROTECTION_HOST ?? DEFAULT_DATA_PROTECTION_HOST
  const port = process.env.DATA_PROTECTION_PORT ?? DEFAULT_DATA_PROTECTION_PORT
  return `http://${host}:${port}${PREFLIGHT_PATH}`
}

async function preflightSourceFile(sourceFilePath: string, sessionId: string): Promise<string | null> {
  const apiKey = process.env.PRIVACY_API_KEY?.trim()
  if (!apiKey) {
    return "PROTECTION_PREFLIGHT_FAILED: The selected file could not be validated for protected processing. Please retry the request."
  }
  try {
    // egress-surface: data_protection_file_pipeline
    const response = await fetch(buildPreflightUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ source_file_path: sourceFilePath, session_id: sessionId }),
      signal: AbortSignal.timeout(10_000),
    })
    if (response.ok) return null
    if (response.status === 413) {
      return "PROTECTION_FILE_TOO_LARGE: The selected file exceeds the protected pipeline size limit. Please choose a smaller file and retry."
    }
    return "PROTECTION_PREFLIGHT_FAILED: The selected file could not be validated for protected processing. Please retry the request."
  } catch {
    return "PROTECTION_PREFLIGHT_FAILED: The selected file could not be validated for protected processing. Please retry the request."
  }
}

async function fetchFileProtectionMode(): Promise<string | null> {
  const apiKey = process.env.LRM_API_KEY?.trim()
  const bases = [
    process.env.LRM_API_BASE_URL,
    "http://127.0.0.1:18321",
    "http://host.docker.internal:18321",
  ].filter((value): value is string => Boolean(value?.trim()))

  for (const base of bases) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    try {
      // egress-surface: lrm_data_protection_mode
      const response = await fetch(`${base.replace(/\/$/, "")}/llm-router/v1/data-protection/mode`, {
        signal: controller.signal,
        ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
      })
      if (!response.ok) continue
      const data = await response.json() as { applied?: unknown }
      if (typeof data.applied === "string") return data.applied.trim().toLowerCase()
    } catch {
      continue
    } finally {
      clearTimeout(timer)
    }
  }

  return null
}

// ============================================================================
// STAGE 2 CHECK: Is THIS session pinned to the local model?
// ============================================================================

// "<providerID>/<model id>" of each session's latest request, published by
// plugins/08_protected_pipeline_confirm_guard.ts from chat.params.
const SESSION_MODELS_KEY = "__sc_session_models"
const PINNED_LOCAL_MODEL = "llmrouter/local-model"

function isPinnedLocal(sessionId: string): boolean {
  const g = globalThis as unknown as Record<string, Map<string, string> | undefined>
  return g[SESSION_MODELS_KEY]?.get(sessionId) === PINNED_LOCAL_MODEL
}

// ============================================================================
// USER DIALOG HANDLING
// ============================================================================

/**
 * Return true when the dialog failed because the user clicked Deny/Reject.
 * This distinguishes user denial from other errors (network issues, timeouts).
 */
function isUserRejection(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  // Keep this aligned with the SDK's user-denied error shape.
  return err.message.includes("denied") || err.message.includes("rejected") || (err as any).code === "USER_DENIED"
}

/**
 * Show approval dialog and handle user response.
 *
 * @param context The execution context with ask() capability
 * @param opts Dialog options (permission, patterns, metadata)
 * @param actionLabel Human-readable label for error messages
 * @returns null if approved, error message string if denied
 */
export async function askOrDenied(
  context: { ask: (opts: any) => Promise<void> },
  opts: Record<string, unknown>,
  actionLabel: string,
): Promise<string | null> {
  try {
    await context.ask(opts)
    return null  // User approved
  } catch (err: unknown) {
    if (isUserRejection(err)) {
      const msg = err instanceof Error ? err.message : String(err)
      return (
        `ACTION_DENIED: The user declined the ${actionLabel} confirmation.\n` +
        `Status: The protected pipeline was NOT run and you must NOT dispatch to protected-file-agent.\n` +
        `Reason: ${msg}\n` +
        `\nFor THIS request ONLY, use the non-protected fallback path. If you are superclaw-default, ` +
        `first tell the user in one sentence that protection was declined and the task will now continue ` +
        `with local-file-agent on the local model, then ` +
        `delegate to local-file-agent with the original user request. If you are another agent, complete ` +
        `only the parts you are permitted to complete without protected-file-agent.\n` +
        `This fallback permission is scoped to the current request only. For any later/next request you ` +
        `MUST call confirm_file_protection again before reading or processing a protected file — do NOT ` +
        `assume this approval carries over.`
      )
    }
    // Non-user-rejection error (network, timeout, etc.) - rethrow
    throw err
  }
}

// ============================================================================
// MAIN TOOL EXECUTION
// ============================================================================

export default tool({
  description:
    "Show the user a native approval dialog before dispatching to the protected-file-agent. " +
    "If data-protection mode is none, or the session is pinned to the local model (data never leaves the device), " +
    "skips the dialog and returns PROTECTION_DISABLED so the agent uses local-file-agent. " +
    "Calling this tool IS how you confirm with the user — it pops the Allow/Deny dialog itself. " +
    "Do NOT ask the user for confirmation in chat first; just call this tool immediately as your " +
    "first action for any file request. Returns APPROVED (then call task(protected-file-agent)) " +
    "or ACTION_DENIED/PROTECTION_DISABLED (then do NOT dispatch to protected-file-agent; use the documented fallback).",
  args: {
    user_request: tool.schema
      .string()
      .describe("The file request that will be sent to the protected pipeline."),
    source_file_path: tool.schema
      .string()
      .optional()
      .describe("Exact absolute path of the selected source file (for example, /workspace/data.csv). Use this OR source_file_paths, not both."),
    source_file_paths: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Exact absolute paths of every source file to protect, when the request involves more than one file."),
  },
  async execute(args, context) {
    const approvedPaths = (globalThis as unknown as Record<string, Map<string, string[]> | undefined>)[APPROVED_PATHS_KEY] ??= new Map<string, string[]>()
    approvedPaths.delete(context.sessionID)
    // A new request starts without any previous decline token.
    deniedSessions().delete(context.sessionID)
    declineFallbackParents().delete(context.sessionID)
    // ========================================================================
    // STAGE 1: Check if data-protection is globally disabled
    // ========================================================================
    // If the user has set data-protection mode to "none" in settings,
    // skip all protection checks and route directly to local-file-agent.
    // This is a global "turn off all protection" switch.
    
    const mode = await fetchFileProtectionMode()
    if (mode === "none") {
      deniedSessions().add(context.sessionID)
      return (
        "PROTECTION_DISABLED: Data-protection mode is set to none. " +
        "The protected pipeline was NOT run and no confirmation dialog was shown. " +
        "Do NOT dispatch to protected-file-agent. For THIS request ONLY, delegate to local-file-agent with the original user request."
      )
    }

    // ========================================================================
    // STAGE 2: Check whether THIS session is pinned to the local model
    // ========================================================================
    // Even with protection enabled globally, if THIS SPECIFIC SESSION is
    // pinned to llmrouter/local-model, the file content never leaves the
    // device. In that case, masking PII is unnecessary overhead.
    //
    // SECURITY RATIONALE:
    // The protected pipeline's purpose is to mask PII before cloud processing.
    // If there's no cloud processing (local-model pin), there's no exposure
    // risk, so we can safely skip the protection dialog and use local-file-agent.
    //
    // ROUTING CONTEXT:
    // The router never escalates llmrouter/local-model, but it can route
    // llmrouter/auto to the cloud on any turn, so where the session's last
    // request went (/v1/session/{id}/locality) says nothing about the next one.
    //
    // FAIL-SAFE BEHAVIOR:
    // If the session's model is unknown, it is not pinned and we proceed to
    // show the dialog. This is safer than assuming local routing.

    // The guard only lets local-file-agent read sensitive/ when mode is "none" or the user declined,
    // so a pinned-local session must still go through the masking pipeline for those files.
    const requestedPaths = [...(args.source_file_paths ?? []), ...(args.source_file_path ? [args.source_file_path] : [])]
    const touchesSensitiveFolder = requestedPaths.some((p) => SENSITIVE_FOLDER_PATH_RE.test(p))
    
    // Pinned to the local model: data stays on device
    if (isPinnedLocal(context.sessionID) && !touchesSensitiveFolder) {
      deniedSessions().add(context.sessionID)
      return (
        "PROTECTION_DISABLED: This session is pinned to the local model, so file content stays on the device. " +
        "The protected pipeline was NOT run and no confirmation dialog was shown. " +
        "Do NOT dispatch to protected-file-agent. For THIS request ONLY, delegate to local-file-agent with the original user request."
      )
    }

    const sourceFilePaths = (args.source_file_paths ?? (args.source_file_path ? [args.source_file_path] : []))
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    if (sourceFilePaths.length === 0) {
      return "PROTECTION_PREFLIGHT_FAILED: The selected file could not be validated for protected processing. Please retry the request."
    }
    for (const path of sourceFilePaths) {
      const preflightFailure = await preflightSourceFile(path, context.sessionID)
      if (preflightFailure) return preflightFailure
    }
    
    // Not pinned to the local model (auto, cloud-model or unknown): show the approval dialog

    // ========================================================================
    // STAGE 3: Show user approval dialog
    // ========================================================================
    // If we reach here, either:
    // - the session is not pinned to the local model (data could reach cloud)
    // - a requested path is under sensitive/
    //
    // Show the Allow/Deny dialog. User's choice determines routing:
    // - Allow → protected-file-agent (masks PII before cloud processing)
    // - Deny → local-file-agent (fallback for THIS request only)
    //
    // ONE-SHOT PERMISSION:
    // The approval/denial is consumed immediately and does not persist.
    // The agent must call confirm_file_protection again for each new file.
    
    const denied = await askOrDenied(
      context,
      {
        permission: "confirm_file_protection",
        patterns: ["protected-file-agent"],
        always: [],
        metadata: { user_request: args.user_request, source_file_paths: sourceFilePaths },
      },
      "protected file pipeline",
    )
    
    // User clicked "Deny" - allow local-file-agent fallback for this request.
    // The App opened the host-read grant for this session when the user clicked Deny.
    if (denied) {
      deniedSessions().add(context.sessionID)
      return denied  // Contains full fallback instructions for the agent
    }

    // User clicked "Allow" - proceed with protected-file-agent
    // The guard will consume this approval token on the next task() dispatch
    approvedPaths.set(context.sessionID, sourceFilePaths)
    approvedSessions().add(context.sessionID)
    return "APPROVED: proceed with task(protected-file-agent) now."
  },
})
