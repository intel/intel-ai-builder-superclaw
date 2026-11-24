import { tool } from "@opencode-ai/plugin"
import { callConnector } from "./_connector_client"

/**
 * Reads one web page through SuperClaw's Connector (Connector IPC `fetch_result`).
 *
 * The Connector decides what may be read and how: a page that sc_search_web returned in the same
 * session is read directly, any other public page only once the user approves it. This tool never
 * fetches anything itself, so without a Connector it refuses.
 *
 * A desktop session's request also names the root session of its chat (`root_session_id`), so the
 * user can answer "Allow all sites for this chat" once for the chat and its sub-agents. The root only
 * names a chat: it never widens what one request may read, which the Connector still decides.
 */

// Longer than the Connector's 90 s approval hold, so a fetch waiting on approval gets an answer.
const TIMEOUT_MS = 120_000
// The contract's whole rule for a fetch_result URL; anything else would be refused there too.
const MAX_URL_CHARS = 4096
const URL_SHAPE = /^https?:\/\/\S+$/

type ConnectorError = { code: string; retryable: boolean; approval_id?: string }

function failureMessage(error: ConnectorError, httpStatus: unknown): string {
  const retry = error.retryable ? "It may work if tried again later." : "Do NOT retry this URL."
  const reasons: Record<string, string> = {
    destination_refused:
      "the Connector will not read that address: it never reads an IP address, localhost, a local name or a port other than 80 or 443, and where nobody can approve a request it reads only pages that sc_search_web returned",
    destination_unreachable: "the site could not be reached",
    destination_http_error: `the site answered HTTP ${httpStatus}`,
    redirect_limit_exceeded: "the page redirected more than 5 times",
    unsupported_content_type: "the page is not text, HTML, JSON or XML",
    approval_required: "reading it needs the user's approval first",
    approval_denied: "the user declined to let SuperClaw read it",
    approval_expired: "nobody approved reading it in time",
  }
  const code = error.approval_id ? `${error.code} (approval ${error.approval_id})` : error.code
  const reason = reasons[error.code]
  return `ERROR: sc_fetch_url did not read the page - ${code}${reason ? `: ${reason}` : ""}. ${retry}`
}

// A chat thread cannot approve a read, so the Connector refused at once. The marker is what the channel
// bridge looks for in this result (sandbox/channels/src/event-stream.ts) to tell the thread.
const NO_APPROVER_MARKER = "NO_INTERACTIVE_APPROVER"

function noApproverMessage(error: ConnectorError): string {
  const code = error.approval_id ? `approval_required (approval ${error.approval_id})` : "approval_required"
  return `ERROR: sc_fetch_url did not read the page - ${code}: this chat cannot ask the user to approve reading a page that sc_search_web did not return, so it was skipped (${NO_APPROVER_MARKER}). Do NOT retry this URL or ask the user to approve it here; use the sc_search_web results instead.`
}

// Filled by plugins/06_superclaw_channel_session_marker.ts for sessions a Slack or Telegram thread owns.
// A request that says "no interactive approver" can only be refused sooner, never allowed more.
const CHANNEL_SESSIONS_KEY = "__sc_channel_sessions"

function isChannelSession(sessionID: string | undefined): boolean {
  const g = globalThis as unknown as Record<string, Set<string> | undefined>
  return sessionID !== undefined && (g[CHANNEL_SESSIONS_KEY]?.has(sessionID) ?? false)
}

// Filled by the same plugin with each desktop session's root session. A channel session never sends one.
const ROOT_SESSIONS_KEY = "__sc_root_sessions"

function rootSessionOf(sessionID: string | undefined): string | undefined {
  const g = globalThis as unknown as Record<string, Map<string, string> | undefined>
  return sessionID === undefined ? undefined : g[ROOT_SESSIONS_KEY]?.get(sessionID)
}

function fetchRequestBody(url: string, sessionID: string | undefined, noApprover: boolean): Record<string, unknown> {
  if (noApprover) return { url, approver: "none" }
  const root = rootSessionOf(sessionID)
  return root === undefined ? { url } : { url, root_session_id: root }
}

function formatPage(requested: string, page: Record<string, unknown>): string {
  const lines = [`URL: ${page.url}`]
  if (page.url !== requested) lines.push(`REQUESTED_URL: ${requested} (redirected ${page.redirects} times)`)
  lines.push(`CONTENT_TYPE: ${page.content_type ?? "not stated"}`)
  if (page.truncated === true) {
    lines.push("TRUNCATED: the page is longer than the Connector returns; only its beginning is below.")
  }
  lines.push("CONTENT:", String(page.text))
  return lines.join("\n")
}

export default tool({
  description:
    "Read the text of a web page through SuperClaw's Connector. A page that sc_search_web returned in this session is read at once. Any other public http or https URL needs the user's approval: SuperClaw asks them and this call waits for the answer. When the user gives you a link, call this tool with it directly instead of searching for it first or asking the user to search.",
  args: {
    url: tool.schema.string().describe("The full http or https URL of the page"),
  },
  async execute(args, context) {
    const url = args.url
    if (url.length > MAX_URL_CHARS || !URL_SHAPE.test(url)) {
      return `ERROR: sc_fetch_url did not read the page - the URL must start with http:// or https://, contain no spaces, and be at most ${MAX_URL_CHARS} characters.`
    }
    const connectorConfig = process.env.SUPERCLAW_CONNECTOR_CONFIG?.trim()
    if (!connectorConfig) {
      return "ERROR: sc_fetch_url is not available - SuperClaw reads web pages only through its Connector, which this runtime does not have. No page was read."
    }
    let body: Record<string, unknown>
    const noApprover = isChannelSession(context?.sessionID)
    try {
      body = await callConnector(
        connectorConfig,
        "fetch_result",
        fetchRequestBody(url, context?.sessionID, noApprover),
        context?.sessionID,
        TIMEOUT_MS,
      )
    } catch (error: unknown) {
      return `ERROR: sc_fetch_url Connector failed - ${error instanceof Error ? error.message : String(error)}`
    }
    if (body.error) {
      const error = body.error as ConnectorError
      if (noApprover && error.code === "approval_required") return noApproverMessage(error)
      return failureMessage(error, body.http_status)
    }
    return formatPage(url, body)
  },
})
