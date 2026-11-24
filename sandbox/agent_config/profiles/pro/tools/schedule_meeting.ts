import { tool } from "@opencode-ai/plugin"
import { ensureGmailAuthOrMessage, callEmailSend, askOrDenied } from "./_email_helpers"

export default tool({
  description:
    "Schedule a Google Calendar meeting and send invitations to the attendees. The user is asked to confirm the attendee list and start time before the invite is sent. Resolve attendee email addresses (e.g. via run_email_pipeline) before calling this tool.",
  args: {
    attendees: tool.schema
      .array(tool.schema.string())
      .describe("List of attendee email addresses."),
    subject: tool.schema.string().describe("Meeting title / subject."),
    start_time: tool.schema
      .string()
      .describe(
        "Meeting start time as an ISO 8601 datetime (e.g. '2026-05-21T14:00:00'). Local time unless 'timezone' is provided.",
      ),
    duration_minutes: tool.schema
      .number()
      .optional()
      .describe("Meeting duration in minutes (default 60)."),
    description: tool.schema
      .string()
      .optional()
      .describe("Optional meeting agenda / description."),
    location: tool.schema
      .string()
      .optional()
      .describe("Optional location string or video-conferencing link."),
    timezone: tool.schema
      .string()
      .optional()
      .describe(
        "Optional IANA timezone (e.g. 'America/Los_Angeles'). Defaults to the system local timezone.",
      ),
  },
  async execute(args, context) {
    const authMessage = await ensureGmailAuthOrMessage()
    if (authMessage) return authMessage

    const denied = await askOrDenied(
      context,
      {
        permission: "schedule_meeting",
        patterns: args.attendees,
        always: args.attendees,
        metadata: {
          attendees: args.attendees,
          subject: args.subject,
          start_time: args.start_time,
          duration_minutes: args.duration_minutes ?? 60,
          location: args.location ?? "",
          timezone: args.timezone ?? "",
        },
      },
      "schedule_meeting",
    )
    if (denied) return denied

    const result = await callEmailSend("send_meeting_invite", {
      attendees: args.attendees,
      subject: args.subject,
      start_time: args.start_time,
      duration_minutes: args.duration_minutes ?? 60,
      description: args.description ?? "",
      location: args.location ?? "",
      timezone: args.timezone ?? "",
    })

    if (!result.success) {
      return (
        `ACTION_FAILED: The meeting could not be scheduled.\n` +
        `Status: NOT performed. No calendar invite was sent.\n` +
        `Error: ${result.error ?? "unknown error"}\n` +
        `\nDo NOT report this action as successful. Tell the user it failed.`
      )
    }

    return (
      `✅ Meeting scheduled with ${args.attendees.join(", ")}` +
      `\nSubject: ${args.subject}` +
      `\nStart: ${result.start ?? args.start_time}` +
      (result.html_link ? `\nCalendar link: ${result.html_link}` : "")
    )
  },
})
