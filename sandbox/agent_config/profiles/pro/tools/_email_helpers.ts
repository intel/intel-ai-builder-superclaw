// Shared helpers for email_send, email_reply, and schedule_meeting tools.

const OPENWORK_HOST_PORT = process.env.OPENWORK_HOST_PORT ?? "8787"
const GMAIL_OAUTH_REDIRECT_URI = `http://localhost:${OPENWORK_HOST_PORT}/api/gmail/oauth/callback`

const OPENCODE_CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR ?? `/workspace/.opencode`
export const GMAIL_TOOLS_DIR = `${OPENCODE_CONFIG_DIR}/tools/gmail`

// Must stay OUTSIDE GMAIL_TOOLS_DIR: that path is inside the Product Profile
// tree, which the orchestrator validates against the packaged source on every
// container start. `uv`'s default <cwd>/.venv plants symlinks it rejects, so the
// backend then exits on every later launch (#2269). Same reason as ocr.ts.
export const GMAIL_TOOLS_VENV =
  process.env.GMAIL_TOOLS_VENV || "/data/gmail-tools-venv"

export function gmailUvEnv(): Record<string, string | undefined> {
  return { ...process.env, UV_PROJECT_ENVIRONMENT: GMAIL_TOOLS_VENV }
}

/**
 * Wrap context.ask() so that a user rejection returns a structured, unambiguous
 * denial string instead of throwing. This ensures intermediate LLMs (email-agent)
 * and the parent orchestrator (superclaw-default) both see an explicit
 * ACTION_DENIED status that cannot be misinterpreted as success.
 *
 * Returns null if the user approved, or a denial message string if rejected.
 */
export async function askOrDenied(
  context: { ask: (opts: any) => Promise<void> },
  opts: Record<string, unknown>,
  actionLabel: string,
): Promise<string | null> {
  try {
    await context.ask(opts)
    return null
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return (
      `ACTION_DENIED: The user declined the ${actionLabel} confirmation.\n` +
      `Status: NOT performed. No email was sent, no meeting was scheduled.\n` +
      `Reason: ${msg}\n` +
      `\nDo NOT report this action as successful. Tell the user it was cancelled.`
    )
  }
}

/**
 * The argv that runs a Gmail script with `args`. On native, the payload's agent
 * Python (`GMAIL_PYTHON`, EG1-8), which carries the Google libraries and needs no
 * network to start; elsewhere `uv run`, which installs the script project's
 * dependencies on first use.
 */
export function gmailScriptCommand(script: string, args: string[] = []): string[] {
  const python = process.env.GMAIL_PYTHON?.trim()
  return python ? [python, script, ...args] : ["uv", "run", script, ...args]
}

export type GmailScriptResult = { exitCode: number; stdout: string; stderr: string }

/**
 * Run a Gmail script from `cwd` and collect its output; a non-zero exit is a
 * result, and only a process that cannot start throws.
 *
 * Bun.spawn, not the bun.$ shell template: on the Windows-native runtime bun.$
 * fails to start the interpreter with "Operation not permitted" (measured on the
 * installed app, where the same command from the agent's shell runs), and it has
 * no windowsHide, so each call would flash a console. The other Profile tools that
 * run Python (ocr, parse_pdf, sc_search_web) already go through Bun.spawn.
 */
export async function runGmailScript(script: string, args: string[], cwd: string): Promise<GmailScriptResult> {
  const bun = (globalThis as unknown as {
    Bun: {
      spawn(cmd: string[], options: Record<string, unknown>): {
        stdout: ReadableStream<Uint8Array>
        stderr: ReadableStream<Uint8Array>
        exited: Promise<number>
      }
    }
  }).Bun
  // egress-surface: gmail_tools_uv_install
  const proc = bun.spawn(gmailScriptCommand(script, args), {
    cwd,
    env: gmailUvEnv(),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

/** Same wording as `GMAIL_PAUSED_MESSAGE` in gmail/gmail_common.py. */
export const GMAIL_PAUSED_MESSAGE =
  "**Gmail is paused in SuperClaw.** Turn Gmail back on in Connections to use it; nothing needs to be set up again."

/**
 * Verify Gmail OAuth is in place. Returns null on success, or a user-facing
 * message that must be relayed verbatim if auth is missing or expired.
 */
export async function ensureGmailAuthOrMessage(): Promise<string | null> {
  let authStatus = "unknown"
  try {
    const check = await runGmailScript("email_sync.py", ["--check-auth"], GMAIL_TOOLS_DIR)
    authStatus = check.stdout.trim().toLowerCase()
  } catch {
    authStatus = "unauthenticated"
  }

  if (authStatus === "authenticated") return null

  if (authStatus === "paused") return GMAIL_PAUSED_MESSAGE

  if (authStatus === "no_credentials") {
    return (
      "**Gmail credentials.json not found.**\n\n" +
      "The `credentials.json` file was not found. Please create and download your OAuth 2.0 Client ID credentials from the Google Cloud Console.\n\n" +
      "Follow the [Google Workspace Developer Guide](https://developers.google.com/workspace/guides/create-credentials) to generate this file.\n\n" +
      "Then upload the file into the SuperClaw app using Advanced > Connections > Gmail Credentials."
    )
  }

  const authUrl = await gmailAuthUrl(GMAIL_TOOLS_DIR, GMAIL_OAUTH_REDIRECT_URI)

  return (
    "**Gmail authorization required.**\n\n" +
    "Please open the following authorization URL in your browser " +
    "to grant Gmail access:\n\n" +
    `[Authorize Gmail access](${authUrl})\n\n` +
    "If the link above is not clickable, copy and paste this URL into your browser:\n\n" +
    "```\n" +
    `${authUrl}\n` +
    "```\n\n" +
    "**Steps:**\n" +
    "1. Open the URL above in your browser.\n" +
    "2. Sign in with your Google account and grant the requested permissions.\n" +
    "3. You will be redirected to a page that says *'Gmail Connected!'* — that means authorization succeeded.\n\n" +
    "Once you see the success page, input the task again and I'll continue.\n"
  )
}

/** The OAuth URL email_sync.py builds for `redirectUri`; throws with the script's stderr when it cannot. */
export async function gmailAuthUrl(cwd: string, redirectUri: string): Promise<string> {
  let result: GmailScriptResult
  try {
    result = await runGmailScript("email_sync.py", ["--get-auth-url", redirectUri], cwd)
  } catch (err) {
    throw new Error(`Failed to generate Gmail auth URL: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `email_sync.py exited with code ${result.exitCode}`
    throw new Error(`Failed to generate Gmail auth URL: ${detail}`)
  }
  return result.stdout.trim()
}

export async function callEmailSend(
  action: "send_email" | "reply_to_email" | "send_meeting_invite" | "lookup_inbox",
  params: Record<string, unknown>,
): Promise<{ success: boolean; error?: string; [key: string]: unknown }> {
  const paramsJson = JSON.stringify(params)

  const result = await runGmailScript("email_send.py", ["--action", action, "--params", paramsJson], GMAIL_TOOLS_DIR)
  const stdout = result.stdout.trim()
  const stderr = result.stderr.trim()

  if (result.exitCode !== 0) {
    return { success: false, error: stderr || stdout || `email_send.py exited with code ${result.exitCode}` }
  }
  try {
    return JSON.parse(stdout)
  } catch {
    return { success: false, error: `email_send.py returned non-JSON output: ${stdout}` }
  }
}
