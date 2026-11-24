/**
 * hybrid_dr_selected_files — tell hybrid_dr_post_polish_processor which local files the user
 * selected on the current message (HDR-PR4, #2836).
 *
 * Before each call of that tool, this reads the session's persisted messages through the injected
 * SDK `client` (in-process: no port, token or network hop), takes the latest user message, and
 * records the local paths of its `file` parts - attachments and @-mentions - and of the
 * `[Selected file: …]` annotations the workspace panel adds to its text, on a globalThis registry
 * keyed by session (the same handoff `confirm_file_protection` uses). Synthetic text parts are
 * skipped: the classifier handoff quotes earlier turns. The tool refuses any model-supplied
 * data_path outside that set. On any failure the entry is removed, so the tool refuses local files
 * instead of trusting the model's list.
 *
 * Why a plugin: a directory tool receives only the tool context, which carries no message parts.
 *
 * This is an intent/privacy control, not an isolation boundary. Plugin, tool and HDR all run as the
 * file_tool identity; HDR's workspace-root, reparse, link-count and handle-identity checks are the
 * enforced boundary.
 */
import type { Plugin } from "@opencode-ai/plugin"

// OpenCode calls every exported function of a plugin module as a plugin; export only the plugin.

const DR_TOOL = "hybrid_dr_post_polish_processor"
// Shared with tools/_hdr_selected_files.ts, which reads it.
const SELECTED_FILES_KEY = "__sc_hdr_user_selected_files"

type SelectedFiles = { messageID: string; paths: string[] }

function registry(): Map<string, SelectedFiles> {
  const g = globalThis as unknown as Record<string, Map<string, SelectedFiles> | undefined>
  return (g[SELECTED_FILES_KEY] ??= new Map<string, SelectedFiles>())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The local path a `file:` part URL names. The UI sends unencoded paths (`file://C:\...`);
 * percent-encoded URLs are decoded, and one that does not decode names nothing.
 */
function localPathFromFileUrl(url: string): string | null {
  if (!/^file:/i.test(url)) return null
  let path = url.slice("file:".length).replace(/^\/\//, "")
  if (path.includes("%")) {
    try {
      path = decodeURIComponent(path)
    } catch {
      return null
    }
  }
  if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1)
  return path || null
}

// The closing `]` is the first one followed by whitespace or the end, so `a[1].txt` survives.
const SELECTED_FILE_ANNOTATION = /\[Selected file:\s*([^\r\n]+?)\](?=\s|$|\[Selected (?:file|folder):)/g

function selectedFilePathsFromParts(parts: unknown): string[] {
  if (!Array.isArray(parts)) return []
  const paths: string[] = []
  const add = (path: string | null) => {
    if (path && !paths.includes(path)) paths.push(path)
  }
  for (const part of parts) {
    if (!isRecord(part)) continue
    if (part.type === "file" && typeof part.url === "string") {
      add(localPathFromFileUrl(part.url))
    } else if (part.type === "text" && typeof part.text === "string" && part.synthetic !== true) {
      for (const match of part.text.matchAll(SELECTED_FILE_ANNOTATION)) {
        const raw = (match[1] ?? "").trim()
        add(/^file:/i.test(raw) ? localPathFromFileUrl(raw) : raw)
      }
    }
  }
  return paths
}

function latestUserMessage(messages: unknown): { id: string; parts: unknown } | null {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry: unknown = messages[i]
    if (!isRecord(entry) || !isRecord(entry.info)) continue
    if (entry.info.role === "user" && typeof entry.info.id === "string") {
      return { id: entry.info.id, parts: entry.parts }
    }
  }
  return null
}

export const HybridDrSelectedFiles: Plugin = async ({ client }) => ({
  "tool.execute.before": async (input) => {
    if (!input || input.tool !== DR_TOOL) return
    const selected = registry()
    selected.delete(input.sessionID)
    try {
      const response = await client.session.messages({ path: { id: input.sessionID } })
      const message = response.error ? null : latestUserMessage(response.data)
      if (!message) return
      const paths = selectedFilePathsFromParts(message.parts)
      selected.set(input.sessionID, { messageID: message.id, paths })
      await client.app.log({
        body: {
          service: "hybrid-dr-selected-files",
          level: "info",
          message: `Recorded selected_files=${paths.length} sessionID=...${input.sessionID.slice(-12)}`,
        },
      })
    } catch {
      // Nothing recorded is the fail-closed state; the tool refuses local files without it.
    }
  },
})

// PATCH plugin-export-form: opencode SDK expects a direct function as default export.
export default HybridDrSelectedFiles
