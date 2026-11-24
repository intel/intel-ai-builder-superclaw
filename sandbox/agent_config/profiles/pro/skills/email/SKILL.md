---
name: email
description: Run the email and calendar pipeline. Supports fetching, summarizing, prioritizing, and drafting emails; sending new emails and replies; listing, summarizing, and counting calendar meetings; detecting conflicts and extracting action items; scheduling meetings; combined email+calendar views; daily planning; unread summaries with draft replies; and meeting prep.
---


## How to invoke

Call the `run_email_pipeline` tool with the `prompt` argument containing the user's request.
Pass the user's natural-language prompt directly — the pipeline classifies intent and routes
to the appropriate handler internally.

```
run_email_pipeline({ prompt: "<user's request>", email: "gmail" })
```

For write actions, use `run_email_pipeline` only to resolve concrete recipient
addresses, message IDs, or schedule details. Then call the dedicated write tool:
`email_send`, `email_reply`, or `schedule_meeting`. Those tools perform the
user-confirmed side effect.

## Supported intents and example prompts

### Email — Read
- "Fetch the latest 10 emails"
- "Show emails from alice@example.com this week"
- "Summarize emails about the project since Monday"
- "Prioritize my inbox for today"
- "Draft a reply to the most recent email from Bob"
- "Show unread emails from last week"

### Email — Write
- "Send an email to alice@example.com asking about the project status"
- "Reply to the latest email from Bob saying I will review it by Friday"
- "Send a response to the latest email from Carol indicating I am out of office"

### Calendar
- "Show my meetings for today"
- "How many meetings do I have tomorrow?"
- "List conflicting meetings for this week"
- "What are the action items from today's meetings?"
- "Summarize my meetings for next week"

### Calendar — Write
- "Send a meeting invite to alice@example.com at 10:00 am tomorrow for one hour"
- "Schedule a meeting with Bob next Monday at 2pm for 30 minutes"

### Combined Email + Calendar
- "Summarize my email and calendar today"
- "Prioritize my tasks from email and calendar this week"
- "Show my emails and meetings for today"

### Productivity
- "Build a focused plan from my tasks and calendar"
- "Summarize my unread messages and draft short replies"
- "Generate prep bullets for tomorrow's meetings"

## After completion

Relay the fetched data to the user in a clear, easy-to-understand format.
Display all dates in human-readable form (e.g., April 10th, 2026, 2:56 PM), omitting seconds.

If the tool returns an authorization or credentials error (messages starting with
`**Gmail authorization required.**` or `**Gmail credentials.json not found.**`),
relay the entire message verbatim — do not paraphrase or omit the authorization URL.
