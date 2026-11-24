import { tool } from "@opencode-ai/plugin"

declare const process: { env: Record<string, string | undefined> }

const PATH = "/v1/file/local-read"

function url(): string {
  const host = process.env.DATA_PROTECTION_HOST ?? "127.0.0.1"
  const port = process.env.DATA_PROTECTION_PORT ?? "18826"
  return `http://${host}:${port}${PATH}`
}

// The App opened the host grant under the session the user declined in; this tool runs in a child of
// it. plugins/93_protected_pipeline_terminal_guard.ts records which session that was.
function grantSession(sessionID: string): string {
  const g = globalThis as unknown as Record<string, Map<string, string> | undefined>
  return g.__sc_local_read_grant_session?.get(sessionID) ?? sessionID
}

export default tool({
  description:
    "Read a file inside the sensitive/ folder through the host. Use ONLY when protection is off or the user " +
    "declined it. Supports .csv .tsv .txt .md .json .log. Returns columns, up to 500 rows, total_rows and " +
    "truncated. Never substitute a same-named file from another folder if this fails.",
  args: {
    source_file_path: tool.schema.string().describe("Exact absolute path of the file inside sensitive/."),
  },
  async execute(args, context) {
    const apiKey = process.env.PRIVACY_API_KEY?.trim()
    if (!apiKey) {
      return JSON.stringify({ success: false, error: "privacy_credential_unavailable",
        message: "Could not read the sensitive file. STOP and tell the user. Do NOT read a same-named file elsewhere." })
    }
    try {
      // egress-surface: data_protection_file_pipeline
      const res = await fetch(url(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ source_file_path: args.source_file_path, session_id: grantSession(context.sessionID) }),
        signal: AbortSignal.timeout(30_000),
      })
      const body = await res.text()
      if (res.ok) return body
      return JSON.stringify({ success: false, error: "local_read_failed", status: res.status,
        message: `The sensitive file could not be read (${res.status}). STOP and tell the user. Do NOT read a same-named file elsewhere.`,
        detail: body.slice(0, 300) })
    } catch {
      return JSON.stringify({ success: false, error: "local_read_unreachable",
        message: "The read service is unreachable. STOP and tell the user. Do NOT read a same-named file elsewhere." })
    }
  },
})