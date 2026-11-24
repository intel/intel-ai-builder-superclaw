/**
 * Managed HDR local-file selection (HDR-PR4, #2836).
 *
 * `plugins/93_hybrid_dr_selected_files.ts` records, before each hybrid_dr_post_polish_processor
 * call, the files on the persisted user message of the current session: its `file` parts and its
 * workspace-panel `[Selected file: …]` annotations. The tool uses only the model-supplied
 * `data_paths` the user actually selected, and refuses legibly when the model named any other.
 *
 * This is an intent/privacy control, not an isolation boundary: plugin, tool and HDR all run as the
 * file_tool identity. HDR's own workspace-root, reparse, link-count and handle-identity checks are
 * the enforced boundary, and a file the user selected outside the workspace still reaches HDR so it
 * is refused there, legibly.
 */
import { workspaceDeliverableRoot } from "./_deep_research_deliverable"

/** Shared with the plugin, which writes it. */
export const HDR_SELECTED_FILES_KEY = "__sc_hdr_user_selected_files"

type HdrSelectedFiles = { messageID: string; paths: string[] }

/** The selection recorded for this session's current turn, or null when none was recorded. */
export function selectedFilesFor(sessionID: string): readonly string[] | null {
  const g = globalThis as unknown as Record<string, Map<string, HdrSelectedFiles> | undefined>
  return g[HDR_SELECTED_FILES_KEY]?.get(sessionID)?.paths ?? null
}

export class SelectedFilesUnavailableError extends Error {
  constructor() {
    super("HDR could not determine which files were selected on the current message")
  }
}

/** The model named local files that are not selected on the user's current message. */
export class DataPathsNotSelectedError extends Error {
  readonly count: number

  constructor(count: number) {
    super(`${count} local file(s) named for HDR are not selected on the current message`)
    this.count = count
  }
}

/**
 * The UI and the prompts name workspace files as `/workspace/<rel>`, the container mount point. On
 * native, where the workspace root is a drive path, that names `<root>\<rel>`.
 */
export function nativeWorkspacePath(path: string, root: string = workspaceDeliverableRoot()): string {
  const trimmed = path.trim()
  if (!/^[A-Za-z]:[\\/]/.test(root)) return trimmed
  const match = /^\/workspace(?:\/(.*))?$/.exec(trimmed)
  if (!match) return trimmed
  const base = root.replace(/[\\/]+$/, "")
  return match[1] ? `${base}\\${match[1].replace(/\//g, "\\")}` : base
}

/** Drive paths compare case- and separator-insensitively; anything else must match exactly. */
function comparisonKey(path: string): string {
  const normalized = path.trim().replace(/\//g, "\\")
  return /^[A-Za-z]:\\/.test(normalized) ? normalized.toLowerCase() : path.trim()
}

/** How many distinct model-named paths are not in the user's selection. */
export function countNotSelected(candidates: readonly string[], selected: readonly string[]): number {
  const selectedKeys = new Set(selected.map(comparisonKey))
  return new Set(candidates.map(comparisonKey).filter((key) => !selectedKeys.has(key))).size
}

/** Keep, in the model's order, the selected paths the model named, spelled as the user selected them. */
export function intersectWithSelectedFiles(
  candidates: readonly string[],
  selected: readonly string[],
): string[] {
  const byKey = new Map<string, string>()
  for (const path of selected) {
    const key = comparisonKey(path)
    if (key && !byKey.has(key)) byKey.set(key, path)
  }
  const kept: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const key = comparisonKey(candidate)
    const match = byKey.get(key)
    if (match === undefined || seen.has(key)) continue
    seen.add(key)
    kept.push(match)
  }
  return kept
}

/** HDR's typed `data_paths` refusal. Carries a reason code and an index, never a path. */
export class DataPathRefusedError extends Error {
  readonly reason: string
  readonly index: number | null

  constructor(reason: string, index: number | null) {
    super(`HDR refused a local data path (${reason})`)
    this.reason = reason
    this.index = index
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function dataPathRefusalFromBody(body: unknown): DataPathRefusedError | null {
  if (!isRecord(body)) return null
  const detail = body.detail
  if (!isRecord(detail)) return null
  if (detail.code !== "data_path_refused") return null
  const { reason, index } = detail
  if (typeof reason !== "string" || !/^[a-z_]{1,48}$/.test(reason)) return null
  if (index !== null && !(typeof index === "number" && Number.isInteger(index) && index >= 0 && index < 1000)) {
    return null
  }
  return new DataPathRefusedError(reason, index)
}

export async function dataPathRefusalFromResponse(response: Response): Promise<DataPathRefusedError | null> {
  if (response.status !== 400) return null
  try {
    return dataPathRefusalFromBody(await response.json())
  } catch {
    return null
  }
}

const REASON_TEXT: Record<string, string> = {
  outside_workspace_root: "is outside your SuperClaw workspace",
  reparse_point: "is reached through a link or junction",
  hard_link: "has more than one hard link",
  not_regular_file: "is not a regular file",
  not_found: "no longer exists",
  not_accessible: "could not be opened",
  identity_mismatch: "changed after it was checked",
  too_many_paths: "is part of a request with too many files",
  path_too_long: "has a path that is too long",
}

export function dataPathRefusalMessage(refusal: DataPathRefusedError): string {
  const which = refusal.index === null ? "the selected files" : `selected file ${refusal.index + 1}`
  const why = REASON_TEXT[refusal.reason] ?? "is not in a form Hybrid Deep Research accepts"
  return (
    `Hybrid Deep Research did not read ${which} because it ${why} (reason: ${refusal.reason}). ` +
    "Only regular files inside your SuperClaw workspace can be used for local research."
  )
}

export const SELECTED_FILES_UNAVAILABLE_MESSAGE =
  "Hybrid Deep Research could not confirm which files are attached to your message, so it did not " +
  "read any local files. Attach the files again and retry."

export function dataPathsNotSelectedMessage(count: number): string {
  const files = count === 1 ? "1 file" : `${count} files`
  return (
    `Hybrid Deep Research did not start because it was asked to read ${files} that you did not ` +
    "select for this message. Select the files in the workspace panel or @-mention them, then retry."
  )
}
