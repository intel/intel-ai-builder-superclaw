import { tool } from "@opencode-ai/plugin"
import { ensureGmailAuthOrMessage, callEmailSend, askOrDenied } from "./_email_helpers"

export default tool({
  description:
    "Reply to an existing Gmail message. The user is asked to confirm before the reply is sent. Use run_email_pipeline first to look up the email; pass either the Gmail message ID (preferred, shown as 'Gmail ID:' in listings) or the small numeric inbox ID shown in brackets (the backend will resolve it to the Gmail ID).",
  args: {
    original_message_id: tool.schema
      .string()
      .describe(
        "Identifier of the email being replied to. Prefer the long alphanumeric Gmail message ID (shown as 'Gmail ID:' in run_email_pipeline listings). The numeric inbox ID shown in brackets (e.g. '10') is also accepted and will be resolved to the Gmail message ID against the local inbox database.",
      ),
    body: tool.schema.string().describe("Reply body (plain text)."),
    reply_all: tool.schema
      .boolean()
      .optional()
      .describe(
        "If true, reply to all recipients on the original thread. Defaults to false (reply only to the original sender).",
      ),
  },
  async execute(args, context) {
    const authMessage = await ensureGmailAuthOrMessage()
    if (authMessage) return authMessage

    const lookup = await callEmailSend("lookup_inbox", {
      message_id: args.original_message_id,
    })
    if (!lookup.success) {
      throw new Error(
        `email_reply: could not look up original message ${args.original_message_id}: ${lookup.error ?? "unknown error"}`,
      )
    }

    const fromEmail = String(lookup.from_email ?? "")
    const fromName = String(lookup.from_name ?? "")
    const subject = String(lookup.subject ?? "")
    const toRecipients = String(lookup.to_recipients ?? "")
    const ccRecipients = String(lookup.cc_recipients ?? "")
    const replyAll = args.reply_all ?? false

    const replyRecipients = replyAll
      ? [fromEmail, toRecipients, ccRecipients]
          .flatMap((v) => v.split(","))
          .map((v) => v.trim())
          .filter((v) => v.length > 0)
      : [fromEmail].filter((v) => v.length > 0)

    const denied = await askOrDenied(
      context,
      {
        permission: "email_reply",
        patterns: replyRecipients,
        always: replyRecipients,
        metadata: {
          replying_to:
            fromName && fromEmail ? `${fromName} <${fromEmail}>` : fromEmail,
          original_subject: subject,
          reply_all: replyAll,
          reply_recipients: replyRecipients.join(", "),
          original_message_id: args.original_message_id,
          body_preview: args.body.slice(0, 240),
        },
      },
      "email_reply",
    )
    if (denied) return denied

    const result = await callEmailSend("reply_to_email", {
      original_message_id: args.original_message_id,
      body: args.body,
      reply_all: replyAll,
    })

    if (!result.success) {
      return (
        `ACTION_FAILED: The email reply could not be sent.\n` +
        `Status: NOT performed. The reply was NOT delivered.\n` +
        `Error: ${result.error ?? "unknown error"}\n` +
        `\nDo NOT report this action as successful. Tell the user it failed.`
      )
    }

    return (
      `✅ Reply sent` +
      (typeof result.replied_to === "string" ? ` to ${result.replied_to}` : "") +
      (typeof result.subject === "string" ? `\nSubject: ${result.subject}` : "") +
      `\nMessage ID: ${result.message_id ?? "(unknown)"}`
    )
  },
})
