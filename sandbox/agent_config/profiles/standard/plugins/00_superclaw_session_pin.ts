/**
 * SuperClaw Session Pin — captures the parent session ID and writes it
 * so the LLM logger can consolidate all logs (parent + subagents) into
 * one directory.
 *
 * Writes: $LOGDIR/current_parent_session_id.txt
 *
 * The parent is identified by agent name "superclaw-default".
 * When a subagent runs, the pin file still contains the parent's session ID,
 * so the logger can always resolve back to the parent directory.
 *
 * Env vars:
 *   SUPERCLAW_PARENT_AGENT — agent name to pin (default: "superclaw-default")
 */

import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"

const PARENT_AGENT = process.env.SUPERCLAW_PARENT_AGENT ?? "superclaw-default"

function getBaseLogdir(): string {
  return process.env.SUPERCLAW_LOGDIR
    ?? process.env.LOGDIR
    ?? "/workspace/logs"
}

function pinFilePath(): string {
  return join(getBaseLogdir(), "current_parent_session_id.txt")
}

function readPin(): string | null {
  const p = pinFilePath()
  if (!existsSync(p)) return null
  try {
    return readFileSync(p, "utf-8").trim() || null
  } catch {
    return null
  }
}

function writePin(sessionID: string): void {
  const base = getBaseLogdir()
  mkdirSync(base, { recursive: true })
  writeFileSync(pinFilePath(), sessionID, "utf-8")
  console.log(`[session-pin] pinned parent session: ${sessionID}`)
}

export const SuperclawSessionPin: Plugin = async () => {
  let currentPin: string | null = readPin()

  return {
    "experimental.chat.messages.transform": async (_input: any, output: any) => {
      const msgs = output?.messages ?? []
      if (msgs.length === 0) return
      const last = msgs[msgs.length - 1]
      const agent = last?.info?.agent
      const sid: string | undefined = last?.info?.sessionID
      if (!sid || agent !== PARENT_AGENT) return
      if (sid !== currentPin) {
        writePin(sid)
        currentPin = sid
      }
    },

    "chat.message": async (input: any) => {
      const agent = input?.agent
      const sid: string | undefined = input?.sessionID
      if (!sid || agent !== PARENT_AGENT) return
      if (sid !== currentPin) {
        writePin(sid)
        currentPin = sid
      }
    },
  }
}

export default SuperclawSessionPin
