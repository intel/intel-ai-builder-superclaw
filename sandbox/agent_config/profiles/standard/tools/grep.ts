import { tool } from "@opencode-ai/plugin"
import { statSync } from "node:fs"
import path from "node:path"

/**
 * Replaces the runtime's built-in `grep` (same tool name, so the permission/budget plugin hooks keyed
 * on "grep" still apply).
 *
 * Why: the built-in only reads ripgrep's first 100 matches and then has to kill ripgrep, which is
 * still writing to a full stdout pipe. On Windows that kill can block forever, so any search with
 * more than 100 matches gets stuck at "Searching code" (tracked in issue #3886, follow-up to #3872).
 * This tool always drains ripgrep's stdout to completion (so it exits on its own) and only keeps the
 * first 100 parsed matches, with a timeout as a backstop instead of an unbounded kill-and-wait.
 *
 * Remove this override once the runtime pin includes the equivalent fix upstream in
 * packages/core/src/ripgrep.ts (agent-runtime).
 */

const LIMIT = 100
const TIMEOUT_MS = 60_000
const MAX_LINE_CHARS = 2_000

interface Match {
  file: string
  line: number
  text: string
}

interface RgMatchLine {
  type?: string
  data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number }
}

function parseMatches(stdout: string, cwd: string): { matches: Match[]; truncated: boolean } {
  const matches: Match[] = []
  let truncated = false
  for (const line of stdout.split("\n")) {
    if (!line) continue
    let json: RgMatchLine
    try {
      json = JSON.parse(line) as RgMatchLine
    } catch {
      continue
    }
    if (json.type !== "match") continue
    const data = json.data
    if (!data?.path?.text || typeof data.line_number !== "number") continue
    if (matches.length >= LIMIT) {
      truncated = true
      continue
    }
    const raw = (data.lines?.text ?? "").replace(/\r?\n$/, "")
    const text = raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)}...` : raw
    matches.push({ file: path.resolve(cwd, data.path.text), line: data.line_number, text })
  }
  return { matches, truncated }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export default tool({
  description:
    "Search file contents with a regular expression (ripgrep). Returns up to 100 matching lines as " +
    '`path:` headings with `Line N: text` rows. `path` may be a directory or a single file; `include` ' +
    'is a glob such as "*.ts".',
  args: {
    pattern: tool.schema.string().describe("The regex pattern to search for in file contents"),
    path: tool.schema
      .string()
      .optional()
      .describe("The directory or file to search in. Defaults to the current working directory."),
    include: tool.schema
      .string()
      .optional()
      .describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
  },
  async execute(args, context) {
    if (!args.pattern) throw new Error("pattern is required")

    await context.ask({
      permission: "grep",
      patterns: [args.pattern],
      always: ["*"],
      metadata: { pattern: args.pattern, path: args.path, include: args.include },
    })

    const requested = path.resolve(context.directory, args.path ?? ".")
    let isDirectory: boolean
    try {
      isDirectory = statSync(requested).isDirectory()
    } catch {
      return `ERROR: grep could not search - ${requested} does not exist`
    }

    if (!inside(context.directory, requested) && !inside(context.worktree, requested)) {
      const dir = isDirectory ? requested : path.dirname(requested)
      const glob = path.join(dir, "*").replaceAll("\\", "/")
      await context.ask({
        permission: "external_directory",
        patterns: [glob],
        always: [glob],
        metadata: { filepath: requested, parentDir: dir },
      })
    }

    const cwd = isDirectory ? requested : path.dirname(requested)
    const rgArgs = [
      "--no-config",
      "--json",
      "--hidden",
      "--no-messages",
      ...(args.include ? [`--glob=${args.include}`] : []),
      "--glob=!**/.git/**",
      "--",
      args.pattern,
      isDirectory ? "." : path.basename(requested),
    ]

    // Bun.spawn() (not the shell-template API) so this subprocess never flashes a console window on
    // Windows, matching the other profile tools in this directory.
    // no-egress: ripgrep only reads local files under cwd and makes no network connections
    const bun = (globalThis as any).Bun
    const proc = bun.spawn(["rg", ...rgArgs], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        proc.kill()
      } catch {
        // best effort: the process may have already exited
      }
    }, TIMEOUT_MS)

    let stdout: string
    let stderr: string
    let exitCode: number
    try {
      // Always read stdout/stderr to completion so ripgrep's pipe never fills up and blocks it -
      // this is the fix for the hang: the built-in tool stops reading after 100 matches instead.
      ;[stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
    } finally {
      clearTimeout(timer)
    }

    if (exitCode !== 0 && exitCode !== 1 && !(exitCode === 2 && stdout.includes('"type":"match"'))) {
      if (timedOut) {
        return `ERROR: grep could not search - timed out after ${TIMEOUT_MS / 1000}s`
      }
      return `ERROR: grep could not search - ${stderr.trim() || `ripgrep exited with code ${exitCode}`}`
    }

    const { matches, truncated } = parseMatches(stdout, cwd)
    if (matches.length === 0) {
      return timedOut
        ? `No matches found before the ${TIMEOUT_MS / 1000}s search timeout. Try a narrower path or pattern.`
        : "No files found"
    }

    const lines = [`Found ${matches.length} matches${truncated ? " (more matches available)" : ""}`]
    let current = ""
    for (const match of matches) {
      if (current !== match.file) {
        if (current !== "") lines.push("")
        current = match.file
        lines.push(`${match.file}:`)
      }
      lines.push(`  Line ${match.line}: ${match.text}`)
    }
    if (truncated) {
      lines.push("", "(Results truncated. Consider using a more specific path or pattern.)")
    }
    if (timedOut) {
      lines.push("", `(The search timed out after ${TIMEOUT_MS / 1000}s; these results may be incomplete.)`)
    }
    return lines.join("\n")
  },
})
