/**
 * SuperClaw LLM Logger — logs all LLM calls, outputs, and tool calls
 * for debugging agent delegation behavior.
 *
 * Logs consolidated per PARENT session:
 *   $SUPERCLAW_LOGDIR/<parent_session_id>/llm-input.log
 *   $SUPERCLAW_LOGDIR/<parent_session_id>/llm-output.log
 *   $SUPERCLAW_LOGDIR/<parent_session_id>/tool-calls.log
 *
 * Reads parent session ID from pin file written by 00_superclaw_session_pin.ts.
 * Subagent calls are logged under the parent's directory (not their own).
 *
 * Env vars:
 *   SUPERCLAW_LOGDIR — base directory for session logs (default: $LOGDIR or /workspace/logs)
 *   SUPERCLAW_DEBUG_OBSERVABILITY=1 — allow raw prompt/response text to be written to log files
 */

import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs"
import { join } from "path"

type ToolCallInfo = {
  tool: string
  sessionID: string
  agent: string
  model: string
  args: any
  timestamp: string
}

function truncateToolPayload(value: unknown, maxLength = 4000): string | undefined {
  if (value === undefined) return undefined
  const text = typeof value === "string" ? value : JSON.stringify(value)
  if (!text) return undefined
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...[truncated]`
}

type ModelInfo = {
  sessionID: string
  providerID: string
  modelID: string
}

type PendingTurnInfo = {
  messageID: string
  agentType: string
  providerID?: string
  modelID?: string
  startedAtMs: number
}

// Per-turn outcome accumulator. A turn (one user message -> agent done) can
// drive many LLM calls / tool calls, so we collect terminal signals across the
// turn and classify a single low-cardinality terminal_state at session.idle.
type TurnAccum = {
  messageID: string
  agentType: string
  providerID?: string
  modelID?: string
  hasTools: boolean
  errored: boolean
  aborted: boolean
  assistantTextLen: number
}

function asRecord(value: unknown): Record<string, any> | undefined {
  if (!value || typeof value !== "object") return undefined
  return value as Record<string, any>
}

function normalizeEvent(rawEvent: unknown): { type?: string; payload?: Record<string, any> } {
  const event = asRecord(rawEvent)
  if (!event) return {}
  const base = asRecord(event.payload) && typeof event.payload?.type === "string" ? asRecord(event.payload) : event
  return {
    type: typeof base.type === "string" ? base.type : undefined,
    payload: asRecord(base.properties) ?? asRecord(base.data) ?? base,
  }
}

function modelKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`
}

function llmPromptLoggingEnabled(): boolean {
  return (process.env.SUPERCLAW_DEBUG_OBSERVABILITY ?? "").trim() === "1"
}

let metricsExportEnabledCached = (process.env.SUPERCLAW_DEBUG_OBSERVABILITY ?? "").trim() === "1"

function metricsExportEnabled(): boolean {
  return metricsExportEnabledCached
}

function opencodeTelemetryBaseUrl(): string {
  const explicit = (process.env.OPENWORK_SERVER_URL ?? "").trim()
  if (explicit) return explicit.replace(/\/+$/, "")
  const port = (process.env.OPENWORK_HOST_PORT ?? process.env.OPENWORK_PORT ?? "8787").trim() || "8787"
  return `http://127.0.0.1:${port}`
}

async function postOpencodeTelemetry(events: Record<string, unknown>[]): Promise<void> {
  if (!metricsExportEnabled() || events.length === 0) return
  const token = (process.env.OPENWORK_TELEMETRY_TOKEN ?? "").trim()
  if (!token) return
  try {
    // egress-surface: opencode_telemetry_ingest
    await fetch(`${opencodeTelemetryBaseUrl()}/v1/runtime/opencode-telemetry`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        events,
      }),
    })
  } catch {
    // Telemetry is best-effort and must never affect agent execution.
  }
}

function getBaseLogdir(): string {
  return process.env.SUPERCLAW_LOGDIR
    ?? process.env.LOGDIR
    ?? "/workspace/logs"
}

function readParentPin(): string | null {
  const pinFile = join(getBaseLogdir(), "current_parent_session_id.txt")
  if (!existsSync(pinFile)) return null
  try {
    return readFileSync(pinFile, "utf-8").trim() || null
  } catch {
    return null
  }
}

function getSessionLogdir(sessionID: string): string {
  const parentSid = readParentPin() ?? sessionID
  const base = getBaseLogdir()
  const dir = join(base, parentSid)
  mkdirSync(dir, { recursive: true })
  return dir
}

export const SuperclawLLMLogger: Plugin = async ({ client }) => {
  const sessionInfo = new Map<string, { agent: string; model: string }>()
  const toolCallData = new Map<string, ToolCallInfo>()
  const sessionToModel = new Map<string, Omit<ModelInfo, "sessionID">>()
  const messageToModel = new Map<string, ModelInfo>()
  const pendingTurns = new Map<string, PendingTurnInfo>()
  const turnAccum = new Map<string, TurnAccum>()
  const seenTurnFailures = new Set<string>()
  const seenToolErrors = new Set<string>()
  const seenStepParts = new Set<string>()
  // child sessionID -> parent sessionID, populated from session.created events.
  // Used to skip subagent (child) turns so turn_completed counts only whole-task
  // (root session) completion, not each delegated subagent turn.
  const sessionParent = new Map<string, string>()

  const baseLogdir = getBaseLogdir()
  mkdirSync(baseLogdir, { recursive: true })
  console.log(`[superclaw-llm-logger] logging to ${baseLogdir}/<session_id>/`)

  // Emit exactly one turn_completed{terminal_state} per turn at the real turn
  // boundary (session.idle). terminal_state mirrors the trajectory tool's
  // TerminalState kinds so success rate is derivable in the collector without
  // shipping any prompt/response text.
  const finalizeTurn = async (sessionID: string) => {
    const accum = turnAccum.get(sessionID)
    if (!accum) return
    // Deleted synchronously (no await before this line), so a duplicate or
    // concurrent session.idle for the same sessionID naturally no-ops on the
    // second call — no separate messageID-keyed dedupe set is needed.
    turnAccum.delete(sessionID)
    // Only count whole-task completion: subagent (child) sessions run in their
    // own sessionID and emit their own session.idle; skip them so a delegated
    // task yields one turn_completed for the root session, not one per subagent.
    // sessionParent.delete() both answers "is this a child session" and drops
    // the mapping, since it's no longer needed once this session's turn is done.
    const isChildSession = sessionParent.delete(sessionID)
    if (isChildSession) return
    const terminalState = accum.aborted
      ? "aborted"
      : accum.errored
        ? "errored"
        : accum.assistantTextLen > 0
          ? "answered"
          : accum.hasTools
            ? "dispatched"
            : "stalled"
    await postOpencodeTelemetry([{
      event_name: "turn_completed",
      source: "opencode_plugin",
      session_id: sessionID,
      agent_type: accum.agentType,
      provider_id: accum.providerID,
      model_id: accum.modelID,
      terminal_state: terminalState,
      timestamp: new Date().toISOString(),
    }])
  }

  // Propagate a user abort up the child->parent lineage so the whole-task (root)
  // turn is classified "aborted" (which outranks "errored"). A user Stop surfaces
  // as MessageAbortedError on the aborted session while the parent task tool fails
  // with a downstream error; without this the root would look like a genuine failure.
  const markAbortedLineage = (sessionID: string) => {
    let cur = sessionID
    for (let i = 0; i < 64; i++) {
      const accum = turnAccum.get(cur)
      if (accum) accum.aborted = true
      const parent = sessionParent.get(cur)
      if (!parent) break
      cur = parent
    }
  }

  return {
    "chat.message": async (input: any, output: any) => {
      if (input.agent && input.model) {
        const modelInfo = `${input.model.providerID}/${input.model.modelID}`
        sessionInfo.set(input.sessionID, { agent: input.agent, model: modelInfo })
        sessionToModel.set(input.sessionID, {
          providerID: input.model.providerID,
          modelID: input.model.modelID,
        })
      }
      const messageID =
        (typeof input.messageID === "string" && input.messageID) ||
        (typeof output?.message?.id === "string" ? output.message.id : "")
      if (messageID) {
        pendingTurns.set(input.sessionID, {
          messageID,
          agentType: input.agent ?? "unknown",
          providerID: input.model?.providerID,
          modelID: input.model?.modelID,
          startedAtMs: Date.now(),
        })
        turnAccum.set(input.sessionID, {
          messageID,
          agentType: input.agent ?? "unknown",
          providerID: input.model?.providerID,
          modelID: input.model?.modelID,
          hasTools: false,
          errored: false,
          aborted: false,
          assistantTextLen: 0,
        })
      }
    },

    "experimental.chat.messages.transform": async (_input: any, output: any) => {
      try {
        const { messages } = output
        if (!messages || messages.length === 0) return

        const lastMessage = messages[messages.length - 1]
        const sessionID = lastMessage.info.sessionID
        // Only assistant messages carry agent/model; the last message mid-task is
        // usually a tool result or user input without them. Walk backwards for the
        // most recent real attribution and never overwrite a known value with
        // "unknown" — otherwise every tool call after turn 1 is logged as
        // model=unknown/unknown (gap F4a, 2026-06-12 gap analysis).
        let resolvedAgent = lastMessage.info.agent
        let resolvedModel = lastMessage.info.model
        for (let i = messages.length - 2; i >= 0 && (!resolvedAgent || !resolvedModel); i--) {
          resolvedAgent = resolvedAgent || messages[i].info.agent
          resolvedModel = resolvedModel || messages[i].info.model
        }
        const remembered = sessionToModel.get(sessionID)
        const agentName = resolvedAgent || sessionInfo.get(sessionID)?.agent || "unknown"
        const providerID = resolvedModel?.providerID || remembered?.providerID || "unknown"
        const modelID = resolvedModel?.modelID || remembered?.modelID || "unknown"

        sessionInfo.set(sessionID, { agent: agentName, model: `${providerID}/${modelID}` })
        if (providerID !== "unknown" && modelID !== "unknown") {
          sessionToModel.set(sessionID, { providerID, modelID })
        }

        let fullText = ""
        for (const msg of messages) {
          const role = msg.info.role
          fullText += `\n[${role}] `
          if (msg.parts && Array.isArray(msg.parts)) {
            for (const part of msg.parts) {
              if (part.type === "text" && part.text) {
                fullText += part.text + "\n"
              }
            }
          }
        }

      fullText = fullText.trim()
      const promptLoggingEnabled = llmPromptLoggingEnabled()
      let displayText: string | undefined
      if (promptLoggingEnabled) {
        displayText = fullText
        if (fullText.length > 2000) {
          displayText = fullText.substring(0, 300) + "\n\n[... truncated " + (fullText.length - 1100) + " chars ...]\n\n" + fullText.substring(fullText.length - 800)
        }
      }

      const logEntry = {
        timestamp: new Date().toISOString(),
        sessionID,
        agent: agentName,
        model: `${providerID}/${modelID}`,
        messageCount: messages.length,
        length: fullText.length,
        promptLoggingEnabled,
        ...(displayText !== undefined ? { text: displayText } : {}),
      }
        appendFileSync(`${getSessionLogdir(sessionID)}/llm-input.log`, JSON.stringify(logEntry) + "\n")
        console.log(`[superclaw-llm-logger] logged input for ${agentName} (${sessionID})`)
      } catch (e: any) {
        console.error(`[superclaw-llm-logger] ERROR in transform hook:`, e?.message ?? e)
      }
    },

    "experimental.text.complete": async (input: any, output: any) => {
      const info = sessionInfo.get(input.sessionID)
      const agentName = info?.agent || "unknown"
      const modelInfo = info?.model || "unknown"

      const logEntry = {
        timestamp: new Date().toISOString(),
        sessionID: input.sessionID,
        agent: agentName,
        model: modelInfo,
        outputLength: typeof output.text === "string" ? output.text.length : 0,
        promptLoggingEnabled: llmPromptLoggingEnabled(),
        ...(llmPromptLoggingEnabled() && typeof output.text === "string" ? { text: output.text } : {}),
      }

      const textAccum = turnAccum.get(input.sessionID)
      if (textAccum && typeof output.text === "string") {
        textAccum.assistantTextLen = output.text.trim().length
      }

      appendFileSync(`${getSessionLogdir(input.sessionID)}/llm-output.log`, JSON.stringify(logEntry) + "\n")
    },

    "tool.execute.before": async (input: any, output: any) => {
      const info = sessionInfo.get(input.sessionID)
      const agentName = info?.agent || "unknown"
      const modelInfo = info?.model || "unknown"

      toolCallData.set(input.callID, {
        tool: input.tool,
        sessionID: input.sessionID,
        agent: agentName,
        model: modelInfo,
        args: output.args,
        timestamp: new Date().toISOString(),
      })
    },

    "tool.execute.after": async (input: any, output: any) => {
      const beforeData = toolCallData.get(input.callID)
      if (!beforeData) return

      const logEntry = {
        timestamp: beforeData.timestamp,
        sessionID: input.sessionID,
        callID: input.callID,
        tool: input.tool,
        agent: beforeData.agent,
        model: beforeData.model,
        args: beforeData.args,
        title: output.title,
        output: typeof output.output === "string" ? output.output.substring(0, 500) : "",
      }

      appendFileSync(`${getSessionLogdir(input.sessionID)}/tool-calls.log`, JSON.stringify(logEntry) + "\n")
      const toolAccum = turnAccum.get(input.sessionID)
      if (toolAccum) toolAccum.hasTools = true
      await postOpencodeTelemetry([{
        event_name: "tool_call_completed",
        outcome: "success",
        source: "opencode_plugin",
        session_id: input.sessionID,
        tool_name: input.tool,
        agent_type: beforeData.agent,
      }])
      toolCallData.delete(input.callID)
    },

    event: async ({ event }: any) => {
      const normalized = normalizeEvent(event)
      const type = normalized.type
      const payload = normalized.payload
      if (!type || !payload) return

      if (type === "session.created") {
        const info = asRecord(payload.info) ?? payload
        const sid = typeof info?.id === "string" ? info.id : ""
        const parent = typeof info?.parentID === "string" ? info.parentID : ""
        if (sid && parent) sessionParent.set(sid, parent)
        return
      }

      if (type === "session.error") {
        const record = asRecord(payload) ?? {}
        const sessionID = typeof record.sessionID === "string" ? record.sessionID : ""
        if (!sessionID) return
        const errorObj = asRecord(record.error)
        const errorName = typeof errorObj?.name === "string" ? errorObj.name : undefined
        if (errorName === "MessageAbortedError") {
          // User Stop: mark the whole lineage aborted (outranks errored) so the
          // root turn reads "aborted", distinguishing a manual stop from a real failure.
          markAbortedLineage(sessionID)
          pendingTurns.delete(sessionID)
          return
        }
        const errAccum = turnAccum.get(sessionID)
        if (errAccum) errAccum.errored = true
        const pending = pendingTurns.get(sessionID)
        if (!pending) return
        const failureKey = `${sessionID}:${pending.messageID}`
        if (seenTurnFailures.has(failureKey)) {
          pendingTurns.delete(sessionID)
          return
        }
        seenTurnFailures.add(failureKey)
        pendingTurns.delete(sessionID)
        await postOpencodeTelemetry([{
          event_name: "assistant_turn_failed",
          source: "opencode_plugin",
          session_id: sessionID,
          agent_type: pending.agentType,
          provider_id: pending.providerID,
          model_id: pending.modelID,
          error_class: errorName,
          error:
            typeof errorObj?.message === "string"
              ? errorObj.message
              : typeof record.error === "string"
                ? record.error
                : "assistant turn failed",
        }])
        return
      }

      if (type === "message.updated") {
        const info = asRecord(payload.info) ?? payload
        const sessionID = typeof info?.sessionID === "string" ? info.sessionID : ""
        const messageID = typeof info?.id === "string" ? info.id : ""
        const providerID = typeof info?.providerID === "string" ? info.providerID : undefined
        const modelID = typeof info?.modelID === "string" ? info.modelID : undefined
        if (sessionID && messageID && providerID && modelID) {
          messageToModel.set(messageID, { sessionID, providerID, modelID })
          sessionToModel.set(sessionID, { providerID, modelID })
          const accum = turnAccum.get(sessionID)
          if (accum) {
            accum.providerID = providerID
            accum.modelID = modelID
          }
        }
        return
      }

      if (type === "session.idle") {
        const record = asRecord(payload) ?? {}
        const sessionID = typeof record.sessionID === "string" ? record.sessionID : ""
        if (sessionID) await finalizeTurn(sessionID)
        return
      }

      if (type !== "message.part.updated") return
      const part = asRecord(payload.part) ?? payload
      if (!part) return
      const sessionID = typeof part.sessionID === "string" ? part.sessionID : ""
      const messageID = typeof part.messageID === "string" ? part.messageID : ""
      const partID = typeof part.id === "string" ? part.id : ""
      if (!sessionID || !messageID || !partID) return

      if (part.type === "tool") {
        const status = typeof part.state?.status === "string" ? part.state.status : ""
        const tool = typeof part.tool === "string" ? part.tool : "unknown"
        const callID = typeof part.callID === "string" ? part.callID : `${messageID}:${partID}`
        if (status === "error" || tool === "invalid") {
          // A tool interrupted by a user Stop / abort is flagged interrupted by
          // opencode (error "Tool execution aborted"); it is not a genuine tool
          // failure, so skip tool_call_failed to avoid polluting the tool metric.
          const interrupted = part.state?.metadata?.interrupted === true
          const dedupeKey = `${callID}`
          if (!interrupted && !seenToolErrors.has(dedupeKey)) {
            seenToolErrors.add(dedupeKey)
            const failAccum = turnAccum.get(sessionID)
            if (failAccum) failAccum.errored = true
            const beforeData = toolCallData.get(callID)
            await postOpencodeTelemetry([{
              event_name: "tool_call_failed",
              outcome: "failure",
              source: "opencode_plugin",
              session_id: sessionID,
              message_id: messageID,
              part_id: partID,
              call_id: callID,
              tool_name: tool,
              agent_type: beforeData?.agent ?? sessionInfo.get(sessionID)?.agent ?? "unknown",
              tool_args: truncateToolPayload(beforeData?.args ?? part.args ?? part.input),
              tool_return: truncateToolPayload(part.state?.output ?? part.output),
              error: part.state?.error ?? (tool === "invalid" ? "invalid tool call arguments" : "tool failed"),
            }])
          }
          toolCallData.delete(callID)
        }
        return
      }

      if (part.type !== "step-finish") return
      if (seenStepParts.has(partID)) return
      seenStepParts.add(partID)

      const tokens = asRecord(part.tokens)
      const inputTokens = Number(tokens?.input ?? 0)
      const outputTokens = Number(tokens?.output ?? 0)
      const cache = asRecord(tokens?.cache)
      const cacheReadTokens = Number(cache?.read ?? tokens?.cacheRead ?? tokens?.cache_read ?? 0)
      const cacheWriteTokens = Number(cache?.write ?? tokens?.cacheWrite ?? tokens?.cache_write ?? tokens?.cache_creation ?? 0)
      const fromMessage = messageToModel.get(messageID)
      const fromSession = sessionToModel.get(sessionID)
      const providerID = fromMessage?.providerID ?? fromSession?.providerID ?? "unknown"
      const modelID = fromMessage?.modelID ?? fromSession?.modelID ?? "unknown"
      const totalTokens = inputTokens + outputTokens

      pendingTurns.delete(sessionID)

      await postOpencodeTelemetry([{
        event_name: "assistant_turn_completed",
        source: "opencode_plugin",
        session_id: sessionID,
        part_id: partID,
        agent_type: sessionInfo.get(sessionID)?.agent ?? "unknown",
        provider_id: providerID,
        model_id: modelID,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        cache_read_tokens: cacheReadTokens,
        cache_write_tokens: cacheWriteTokens,
        finish_reason: typeof part.finishReason === "string" ? part.finishReason : undefined,
        model_key: modelKey(providerID, modelID),
      }])
    },
  }
}

export default SuperclawLLMLogger
