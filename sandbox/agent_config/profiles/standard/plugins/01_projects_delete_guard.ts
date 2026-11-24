import type { Plugin } from "@opencode-ai/plugin"

/**
 * Projects Delete Guard
 *
 * Intercepts destructive file operations (rm, rmdir, unlink, shred,
 * truncate --size 0) targeting /workspace/ and forces user approval via the
 * permission dialog. Non-destructive operations (read, write, edit) pass
 * through without interruption.
 *
 * Works in two layers:
 *   1. permission.ask — if a permission check reaches the hook and involves a
 *      destructive bash command targeting /workspace, override status to "ask".
 *   2. tool.execute.before — inspects bash tool args for destructive commands
 *      targeting /workspace and throws a DENIED error so the bash tool fails
 *      with a real error instead of silently rewriting the command. This gives
 *      the model an unambiguous "denied" signal so it stops retrying the same
 *      destructive shape.
 */

const PROJECTS_PATH_PATTERNS = [
  /(?:^|[\s"'`])\/workspace(?=\/|$|[\s"'`])/,
  /(?:^|[\s"'`])~\/workspace(?=\/|$|[\s"'`])/,
  /(?:^|[\s"'`])\$HOME\/workspace(?=\/|$|[\s"'`])/,
  // B2 (security review): also protect the container's sensitive system dirs.
  // /config holds OpenCode config + Gmail OAuth creds/tokens; /data holds user
  // data (Gmail data, etc.). A destructive bash command from agent output
  // (rm -rf /config, rm -rf /data) must hit the same ask/deny guard as
  // /workspace. Path-boundary-anchored so /database, /tmp/dataX won't match.
  /(?:^|[\s"'`])\/config(?=\/|$|[\s"'`])/,
  /(?:^|[\s"'`])\/data(?=\/|$|[\s"'`])/,
]

const DESTRUCTIVE_COMMAND_NAMES = new Set(["rm", "rmdir", "unlink", "shred", "truncate"])

const COMMAND_PREFIXES = new Set([
  "sudo", "env", "nice", "nohup", "time", "command", "exec", "builtin",
])

const PIPE_DESTRUCTIVE = [
  /\bxargs\b.*\brm\b/,
  /\bxargs\b.*\brmdir\b/,
  /\bxargs\b.*\bunlink\b/,
  /\bxargs\b.*\bshred\b/,
]

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
}

function normalizeToken(token: string): string {
  let result = ""
  let i = 0
  while (i < token.length) {
    if (token[i] === "\\" && i + 1 < token.length) {
      result += token[i + 1]
      i += 2
    } else if (token[i] === "'") {
      const end = token.indexOf("'", i + 1)
      if (end === -1) {
        result += token.slice(i + 1)
        break
      }
      result += token.slice(i + 1, end)
      i = end + 1
    } else if (token[i] === '"') {
      const end = token.indexOf('"', i + 1)
      if (end === -1) {
        result += token.slice(i + 1)
        break
      }
      result += token.slice(i + 1, end)
      i = end + 1
    } else {
      result += token[i]
      i++
    }
  }
  return result
}

function getEffectiveCommand(segment: string): string | null {
  const trimmed = segment.trim()
  const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
  if (!tokens) return null

  let prefixMode = false
  let skipNext = false

  for (const raw of tokens) {
    const token = normalizeToken(raw)
    if (isEnvAssignment(token)) { skipNext = false; continue }
    if (prefixMode && token.startsWith("-")) {
      const isShortWithArg = /^-[a-zA-Z]$/.test(token)
      const isLongWithoutValue = /^--[a-zA-Z]/.test(token) && !token.includes("=")
      skipNext = isShortWithArg || isLongWithoutValue
      continue
    }
    if (COMMAND_PREFIXES.has(token)) {
      prefixMode = true
      skipNext = false
      continue
    }
    if (!prefixMode) return token
    if (skipNext && !DESTRUCTIVE_COMMAND_NAMES.has(token) && !COMMAND_PREFIXES.has(token)) {
      skipNext = false
      continue
    }
    return token
  }

  return null
}

function segmentHasDestructiveCommand(segment: string): boolean {
  const cmd = getEffectiveCommand(segment)
  if (!cmd || !DESTRUCTIVE_COMMAND_NAMES.has(cmd)) return false
  if (cmd === "truncate") {
    return /(?:^|\s)--size(?:=|\s*)0(?:\b|(?=\s|$))/.test(segment)
  }
  return true
}

interface SegmentInfo {
  text: string
  separator: string
}

function splitShellSegments(command: string): SegmentInfo[] {
  const segments: SegmentInfo[] = []
  let current = ""
  let i = 0
  let inSingle = false
  let inDouble = false
  let nextSeparator = ""

  while (i < command.length) {
    const ch = command[i]

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      current += ch
      i++
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      current += ch
      i++
    } else if (ch === "\\" && !inSingle && i + 1 < command.length) {
      current += ch + command[i + 1]
      i += 2
    } else if (!inSingle && !inDouble) {
      if (ch === ";") {
        segments.push({ text: current, separator: nextSeparator })
        nextSeparator = ";"
        current = ""
        i++
      } else if (ch === "|") {
        segments.push({ text: current, separator: nextSeparator })
        current = ""
        i++
        if (i < command.length && command[i] === "|") {
          nextSeparator = "||"
          i++
        } else {
          nextSeparator = "|"
        }
      } else if (ch === "&") {
        segments.push({ text: current, separator: nextSeparator })
        current = ""
        i++
        if (i < command.length && command[i] === "&") {
          nextSeparator = "&&"
          i++
        } else {
          nextSeparator = "&"
        }
      } else {
        current += ch
        i++
      }
    } else {
      current += ch
      i++
    }
  }
  if (current.length > 0) segments.push({ text: current, separator: nextSeparator })
  return segments
}

function segmentCdTarget(segment: string): "projects" | "other" | null {
  const cmd = getEffectiveCommand(segment)
  if (cmd !== "cd" && cmd !== "pushd") return null
  if (PROJECTS_PATH_PATTERNS.some((p) => p.test(segment))) return "projects"
  return "other"
}

function hasOnlyAbsoluteNonProjectsPaths(segment: string): boolean {
  const trimmed = segment.trim()
  const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
  if (!tokens) return false

  const cmd = getEffectiveCommand(segment)
  const absolutePaths: string[] = []

  for (const raw of tokens) {
    const normalized = normalizeToken(raw)
    if (normalized === cmd) continue
    if (normalized.startsWith("-")) continue
    if (isEnvAssignment(normalized)) continue
    if (COMMAND_PREFIXES.has(normalized)) continue
    if (normalized.startsWith("/")) {
      absolutePaths.push(normalized)
    }
  }

  if (absolutePaths.length === 0) return false
  return absolutePaths.every(
    (p) => !PROJECTS_PATH_PATTERNS.some((pat) => pat.test(p))
  )
}

function isDestructiveProjectsCommand(command: string): boolean {
  const segments = splitShellSegments(command)

  let inProjectsContext = false
  let pipelineHasProjectsPath = false

  for (let i = 0; i < segments.length; i++) {
    const { text: segment, separator } = segments[i]

    if (separator !== "|") {
      pipelineHasProjectsPath = false
    }

    const hasProjectsPath = PROJECTS_PATH_PATTERNS.some((p) => p.test(segment))
    const hasDestructive = segmentHasDestructiveCommand(segment)

    if (hasProjectsPath && hasDestructive) return true

    if (inProjectsContext && hasDestructive && !hasOnlyAbsoluteNonProjectsPaths(segment)) {
      return true
    }

    if (separator === "|" && pipelineHasProjectsPath) {
      if (PIPE_DESTRUCTIVE.some((p) => p.test(segment))) return true
    }

    if (hasProjectsPath) pipelineHasProjectsPath = true
    const cdTarget = segmentCdTarget(segment)
    if (cdTarget === "projects") inProjectsContext = true
    else if (cdTarget === "other") inProjectsContext = false
  }

  return false
}

export const ProjectsDeleteGuard: Plugin = async ({ client }) => {
  await client.app.log({
    body: {
      service: "projects-delete-guard",
      level: "info",
      message: "Plugin initialized — guarding /workspace against destructive ops",
      extra: {},
    },
  })

  return {
    "permission.ask": async (input, output) => {
      const patterns = (input as any).pattern
        ? [].concat((input as any).pattern)
        : (input as any).patterns ?? []
      const title = (input as any).title ?? ""
      const metadata = (input as any).metadata ?? {}
      const command = metadata.command ?? metadata.cmd ?? title ?? ""

      const allText = [...patterns, title, command].join(" ")

      if (isDestructiveProjectsCommand(allText)) {
        output.status = "ask"
      }
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return

      const command = (output.args as any)?.command ?? ""
      if (typeof command !== "string") return

      if (isDestructiveProjectsCommand(command)) {
        // Throw so the bash tool surfaces a real error to the model to stop it from retrying the same destructive command shape.
        throw new Error(
            "DENIED by projects-delete-guard: you are not allowed to delete files under /workspace, /config, or /data. " +
              "Skip this delete step and continue. Do not retry, run another delete command, or attempt to bypass this guard."
        )
      }
    },
  }
}

// opencode loads every export of this module as a plugin, so a bare helper export is invoked
// as a plugin factory and fails the whole file. The helpers ride on the plugin function
// instead; unit tests read them off the default export.
export default Object.assign(ProjectsDeleteGuard, { isDestructiveProjectsCommand })
