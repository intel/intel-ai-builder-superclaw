import { tool } from "@opencode-ai/plugin"
import { ensureGmailAuthOrMessage, callEmailSend, askOrDenied } from "./_email_helpers"

export default tool({
  description:
    "Send a new email via Gmail. The user is asked to confirm the recipient(s) before the email is actually sent. Use this only when you have already resolved the recipient email address (use run_email_pipeline to search for the address first if needed).",
  args: {
    to: tool.schema
      .string()
      .describe(
        "Recipient email address. Use a comma-separated list for multiple recipients.",
      ),
    subject: tool.schema.string().describe("Email subject line."),
    body: tool.schema.string().describe("Email body (plain text)."),
    cc: tool.schema
      .string()
      .optional()
      .describe("Optional CC recipients, comma-separated."),
    bcc: tool.schema
      .string()
      .optional()
      .describe("Optional BCC recipients, comma-separated."),
  },
  async execute(args, context) {
    const authMessage = await ensureGmailAuthOrMessage()
    if (authMessage) return authMessage

    const recipients = [args.to, args.cc, args.bcc]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .flatMap((v) => v.split(","))
      .map((v) => v.trim())
      .filter((v) => v.length > 0)

    const denied = await askOrDenied(
      context,
      {
        permission: "email_send",
        patterns: recipients,
        always: recipients,
        metadata: {
          to: args.to,
          cc: args.cc ?? "",
          bcc: args.bcc ?? "",
          subject: args.subject,
          body_preview: args.body.slice(0, 240),
        },
      },
      "email_send",
    )
    if (denied) return denied

    const result = await callEmailSend("send_email", {
      to: args.to,
      subject: args.subject,
      body: args.body,
      cc: args.cc ?? "",
      bcc: args.bcc ?? "",
    })

    if (!result.success) {
      return (
        `ACTION_FAILED: The email could not be sent.\n` +
        `Status: NOT performed. The email was NOT delivered to ${args.to}.\n` +
        `Error: ${result.error ?? "unknown error"}\n` +
        `\nDo NOT report this action as successful. Tell the user it failed.`
      )
    }

    return (
      `✅ Email sent to ${args.to}` +
      (args.cc ? ` (cc: ${args.cc})` : "") +
      (args.bcc ? ` (bcc: ${args.bcc})` : "") +
      `\nSubject: ${args.subject}` +
      `\nMessage ID: ${result.message_id ?? "(unknown)"}`
    )
  },
})
