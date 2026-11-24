import { tool } from "@opencode-ai/plugin"

declare const process: { env: Record<string, string | undefined> }

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

/** Return the shared denial set, creating it the first time it is needed. */
function deniedSessions(): Set<string> {
  const g = globalThis as unknown as Record<string, Set<string> | undefined>
  return (g[DENIAL_KEY] ??= new Set<string>())
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

/**
 * User Dialog Handling
 * Returns true when the user explicitly rejects the dialog.
 * Other errors (timeout, network, SDK failure) return false.
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


export default tool({
  description:
    "Show the user a native approval dialog before dispatching to the protected-file-agent. " +
    "If data-protection mode is none, skips the dialog and returns PROTECTION_DISABLED so the agent uses local-file-agent. " +
    "Calling this tool IS how you confirm with the user — it pops the Allow/Deny dialog itself. " +
    "Do NOT ask the user for confirmation in chat first; just call this tool immediately as your " +
    "first action for any file request. Returns APPROVED (then call task(protected-file-agent)) or " +
    "PROTECTION_DISABLED/PROTECTION_DECLINED (then do NOT dispatch to protected-file-agent; use the " +
    "documented local-file-agent fallback, which runs on the cloud model unmasked).",
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

    const sourceFilePaths = (args.source_file_paths ?? (args.source_file_path ? [args.source_file_path] : []))
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    if (sourceFilePaths.length === 0) {
      return "PROTECTION_PREFLIGHT_FAILED: The selected file could not be validated for protected processing. Please retry the request."
    }

    // Check if data-protection is disabled
    const mode = await fetchFileProtectionMode()
    if (mode === "none") {
      deniedSessions().add(context.sessionID)
      return (
        "PROTECTION_DISABLED: Data-protection mode is set to none. The protected pipeline was NOT run and no confirmation " +
        "dialog was shown. Do NOT dispatch to protected-file-agent. For THIS request ONLY, delegate to local-file-agent " +
        "with the original user request. In this profile local-file-agent runs on the cloud model (router-bypass), so the " +
        "file will be analyzed WITHOUT masking — tell the user PII was not masked for this request."
      )
    }

    for (const path of sourceFilePaths) {
      const preflightFailure = await preflightSourceFile(path, context.sessionID)
      if (preflightFailure) return preflightFailure
    }
    
    // local-file-agent runs on the cloud model in this profile, so every session gets the dialog
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
    
    // User clicked "Deny": local-file-agent runs on the cloud model unmasked. The App opened the
    // host-read grant for this session when the user clicked Deny, so it can
    // still read files inside sensitive/.
    if (denied) {
      deniedSessions().add(context.sessionID)
      return (
        "PROTECTION_DECLINED: The user declined to send this file through the protected pipeline. Do NOT dispatch to " +
        "protected-file-agent. For THIS request ONLY, delegate to local-file-agent with the original user request. In " +
        "this profile local-file-agent runs on the cloud model (router-bypass), so the file will be analyzed WITHOUT " +
        "masking — tell the user PII was not masked for this request. This fallback is scoped to the current request " +
        "only; call confirm_file_protection again before processing any other protected file."
      )
    }

    // User clicked "Allow" - proceed with protected-file-agent
    // The guard will consume this approval token on the next task() dispatch
    approvedPaths.set(context.sessionID, sourceFilePaths)
    approvedSessions().add(context.sessionID)
    return "APPROVED: proceed with task(protected-file-agent) now."
  },
})