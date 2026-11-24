import { tool } from "@opencode-ai/plugin"
import { GMAIL_PAUSED_MESSAGE, gmailAuthUrl, runGmailScript, type GmailScriptResult } from "./_email_helpers"

// Default host port for the OpenWork server. Can be overridden via OPENWORK_HOST_PORT.
const OPENWORK_HOST_PORT = process.env.OPENWORK_HOST_PORT ?? "8787"
const GMAIL_OAUTH_REDIRECT_URI = `http://localhost:${OPENWORK_HOST_PORT}/api/gmail/oauth/callback`

export default tool({
  description:
    "Run the read-only email and calendar pipeline. Supports: fetching/showing emails, summarizing, prioritizing, drafting (NOT sending) replies, listing/summarizing/counting calendar meetings, detecting conflicts, extracting action items, meeting prep, combined email+calendar summaries, daily planning, and unread email summaries. This tool MUST NOT be used to send emails, reply to emails, or schedule meetings — use the dedicated `email_send`, `email_reply`, and `schedule_meeting` tools for those, which require explicit user confirmation. The user prompt should specify the desired read-only action (e.g., 'Summarize the latest 5 emails', 'Show my meetings for tomorrow', 'Find the latest message from alice@example.com').",
  args: {
    prompt: tool.schema
      .string()
      .describe(
        "The user prompt from the email agent that is required to process email and calendar data.",
      ),
    email: tool.schema
      .enum(["gmail"])
      .default("gmail")
      .describe(
        "The email provider to use. Use 'gmail' for Gmail.",
      ),
  },
  async execute(args, context) {
    const emailProvider = args.email ?? "gmail"
    // Resolve scripts beside this tool so legacy source imports still use the
    // canonical Product Profile implementation.
    const syncScriptDir = `${import.meta.dir}/${emailProvider}`
    const syncDataDir = process.env.GMAIL_DATA_DIR ?? syncScriptDir
    // Keep the DB path absolute because the pipeline runs from the script directory.
    const dbPath = `${syncDataDir}/${emailProvider}.db`

    // For Gmail, check authentication status before attempting a sync.
    if (emailProvider === "gmail") {
      let authStatus = "unknown"
      try {
        const check = await runGmailScript("email_sync.py", ["--check-auth"], syncScriptDir)
        authStatus = check.stdout.trim().toLowerCase()
      } catch {
        authStatus = "unauthenticated"
      }

      if (authStatus !== "authenticated") {
        if (authStatus === "paused") return GMAIL_PAUSED_MESSAGE

        if (authStatus === "no_credentials") {
          return (
            "**Gmail credentials.json not found.**\n\n" +
            "The `credentials.json` file was not found. Please create and download your OAuth 2.0 Client ID credentials from the Google Cloud Console.\n\n" +
            "Follow the [Google Workspace Developer Guide](https://developers.google.com/workspace/guides/create-credentials) to generate this file.\n\n" +
            "Then upload the file into the SuperClaw app using Advanced > Connections > Gmail Credentials."
          )
        }

        // Not authenticated — start the OAuth flow.
        const authUrl = await gmailAuthUrl(syncScriptDir, GMAIL_OAUTH_REDIRECT_URI)

        // IMPORTANT: This message is intended to be relayed VERBATIM to the user.
        // The email agent prompt instructs the agent not to paraphrase or
        // summarize this block, because the OAuth URL must be presented exactly
        // as-is so the user can click/copy it. Do not reformat or trim the
        // authUrl — keep it on its own line so it survives any paraphrasing.
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
    }

    // Run each step separately so we can inspect its exit code and surface the
    // real stderr, labelled by which step failed. Without
    // this, a failing sync (e.g. Gmail unreachable) collapses into a generic
    // "No such file or directory" and the pipeline then runs against an
    // un-synced DB, failing later with an opaque "no such table: ai_inbox".
    const runStep = async (
      step: string,
      script: string,
      scriptArgs: string[],
    ): Promise<string> => {
      let result: GmailScriptResult
      try {
        result = await runGmailScript(script, scriptArgs, syncScriptDir)
      } catch (error) {
        // A thrown error here means the process could not be spawned at all
        // (e.g. the interpreter or `uv` not found), not a non-zero exit.
        const msg = error instanceof Error ? error.message : String(error)
        throw new Error(`${step} could not be started: ${msg}`)
      }

      const stdoutText = result.stdout.trim()
      const stderrText = result.stderr.trim()

      if (result.exitCode !== 0) {
        const detail =
          stderrText || stdoutText || `exited with code ${result.exitCode}`
        throw new Error(
          `${step} failed (exit ${result.exitCode}): ${detail}`,
        )
      }

      return stdoutText
    }

    // Step 1: sync Gmail into the local DB. This is the step that creates the
    // `ai_inbox`/`ai_calendar` tables the pipeline reads — if it fails, do NOT
    // proceed to the pipeline, or it will fail with a misleading schema error.
    await runStep("Gmail sync (email_sync.py)", "email_sync.py", [])

    // Step 2: run the read-only pipeline against the freshly synced DB.
    const output = await runStep(
      "Email pipeline (email_pipeline.py)",
      "email_pipeline.py",
      ["--prompt", args.prompt, "--db-path", dbPath],
    )

    return output
  },
})
