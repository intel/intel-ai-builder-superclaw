import { tool } from "@opencode-ai/plugin"
import { callConnector } from "./_connector_client"
import { resolveAgentPython } from "./_python_env"

/**
 * SuperClaw web search tool with no LLM summarisation.
 *
 * The websearch prompt asks the model to stop after a small number of searches,
 * but weak models may ignore prompt-only limits. This tool therefore enforces a
 * per-session budget in code. The counter is `seen.length` for the session:
 * values 0-7 allow real searches (calls 1-8); once it reaches SEARCH_BUDGET (8),
 * every call from #9 onward throws before any Tavily/DDG request runs, so repeat
 * attempts fail fast instead of executing another web search.
 *
 * Successful budget checks reserve a slot before the async search starts so
 * concurrent calls cannot all read the same stale count. Failed searches roll
 * the reservation back, preserving the rule that failed calls do not spend
 * search budget.
 */

const SEARCH_BUDGET = 8
const MAX_TRACKED_SESSIONS = 64
const searchLog = new Map<string, string[]>()
const QUERY_CARRIES_URL =
  "ERROR: sc_search_web did not search - the query contains a web address, which a search query may not. " +
  "Search again with words only. To read a page that a search returned, call sc_fetch_url with its URL."
type SearchCategory = "text" | "news"

function pythonRepr(value: string): string {
  return `'${value
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")}'`
}

export function formatConnectorSearch(body: any): string {
  const display = body.display
  const preamble = [
    `SEARCH_AS_OF: ${display.as_of}`,
    ...(display.query_normalized && display.query !== display.original_query
      ? [`QUERY_NORMALIZED: ${pythonRepr(display.original_query)} -> ${pythonRepr(display.query)} (past calendar year on a recency query was replaced with SEARCH_AS_OF year)`]
      : []),
  ].join("\n") + "\n"
  if (display.failure_message) return preamble + display.failure_message

  const provider = body.provider === "tavily" ? "Tavily" : "DuckDuckGo"
  const blocks = [`Web search results for query: ${pythonRepr(display.query)} [via ${provider}]\n`]
  for (const [index, row] of body.results.entries()) {
    let block = `=== RESULT ${index + 1} ===\nURL: ${row.url}\nTITLE: ${row.title}\n`
    if (body.provider === "tavily") {
      block += `SCORE: ${(Number(row.score_percent ?? 0) / 100).toFixed(2)}\nSOURCE_TYPE: ${row.source_type ?? "(no content available)"}\n`
    }
    blocks.push(`${block}CONTENT:\n${row.content}\n`)
  }
  const rendered = blocks.join("\n")
  const [header, ...rest] = rendered.split("\n")
  return `${header}\n${preamble}${rest.join("\n")}`
}

function priorQueries(sessionID: string | undefined): string[] | null {
  if (!sessionID) return null
  return searchLog.get(sessionID) ?? []
}

function recordQuery(sessionID: string | undefined, query: string): void {
  if (!sessionID) return
  const seen = searchLog.get(sessionID) ?? []
  seen.push(query)
  searchLog.set(sessionID, seen)
  // Bound growth: drop the oldest session once the map gets large.
  if (searchLog.size > MAX_TRACKED_SESSIONS) {
    const oldest = searchLog.keys().next().value
    if (oldest !== undefined) searchLog.delete(oldest)
  }
}

// Roll back the latest matching reservation when the reserved search fails.
function rollbackQuery(sessionID: string | undefined, query: string): void {
  if (!sessionID) return
  const seen = searchLog.get(sessionID)
  if (!seen) return
  const idx = seen.lastIndexOf(query)
  if (idx !== -1) seen.splice(idx, 1)
}

// Run the Python helper via Bun.spawn() (not the bun.$ shell-template API, which has
// no windowsHide equivalent) so the subprocess never flashes a console window on
// Windows. Mirrors the exact behavior of the previous bun.$ call: on non-zero exit,
// throw an Error carrying `stderr`; on success, return trimmed stdout.
//
// windowsHide behavior is covered by
// shared/contracts/src/__tests__/sc-search-web-windows-hide.test.ts, which asserts
// Bun.spawn is called with { windowsHide: true } for all three profiles. Actually
// observing "no console flash" requires an interactive Windows desktop session,
// which this development sandbox does not have (no GUI to watch a window flash or
// not); that observation was not performed here. windowsHide is a no-op on
// non-Windows platforms, so setting it unconditionally here is safe.
export async function runPythonHelper(
  py: string,
  script: string,
  payload: string,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  // No bun-types ambient declarations are wired up for this standalone tool script, so the
  // global is narrowed through `unknown` to the one method this file calls instead of `any`.
  const bun = (globalThis as unknown as {
    Bun: {
      spawn(cmd: string[], options: Record<string, unknown>): {
        stdout: ReadableStream<Uint8Array>
        stderr: ReadableStream<Uint8Array>
        exited: Promise<number>
      }
    }
  }).Bun
  const proc = bun.spawn([py, "-c", script, payload], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    const error = new Error(stderr.trim() || `python exited with code ${exitCode}`) as Error & {
      stderr?: string
    }
    error.stderr = stderr
    throw error
  }
  return stdout.trim()
}

function budgetExhaustedMessage(seen: string[]): string {
  return [
    `SEARCH BUDGET EXHAUSTED: you have already run ${seen.length} searches in this task`,
    `(limit ${SEARCH_BUDGET}). No further searches will run.`,
    "",
    "Queries already executed:",
    ...seen.map((q, i) => `  ${i + 1}. ${q}`),
    "",
    "Re-phrasing a query that already returned nothing will not surface new data —",
    "when a figure is absent from the results, the vendor most likely never published it.",
    "STOP SEARCHING NOW and write your answer from what you gathered. For anything you",
    'could not source, state "No information found regarding [topic]" and move on.',
  ].join("\n")
}

export default tool({
  description:
    "Search the web via Tavily with DuckDuckGo fallback and return provider-supplied result content. No LLM summarisation — the calling agent quotes directly from the source text. Use sc_fetch_url when a result does not contain enough detail or is truncated.\n" +
    "Choose `category` (used by the DuckDuckGo fallback):\n" +
    "- text (default): facts, how-to, docs, products, people/companies, and LIVE DATA pages " +
    "(weather, stock prices, exchange rates, schedules, scores). Use text whenever unsure.\n" +
    "- news: only when the question is about what HAPPENED - events, announcements, incidents, " +
    "recent developments. Never use news for live data such as weather.\n" +
    "Write the query as plain keywords in the user's language; do not pad it with the year or " +
    "words like 'latest'. If results are off-topic, switch category or keywords instead of " +
    "rephrasing the same query.",
  args: {
    query: tool.schema.string().describe("Search query to execute"),
    category: tool.schema
      .enum(["text", "news"])
      .optional()
      .describe("Search vertical: text (default) or news"),
  },
  async execute(args, context) {
    const category: SearchCategory = args.category ?? "text"
    const sessionID = (context as any)?.sessionID as string | undefined
    const seen = priorQueries(sessionID)
    if (seen && seen.length >= SEARCH_BUDGET) {
      throw new Error(budgetExhaustedMessage(seen))
    }

    // Reserve before the await so concurrent calls see the updated count.
    recordQuery(sessionID, args.query)

    const toolsDir = (import.meta as any).dir
    const toolsDirPy = JSON.stringify(String(toolsDir))
    const timeoutSeconds = 120
    const payload = JSON.stringify({ query: args.query, category })

    const connectorConfig = process.env.SUPERCLAW_CONNECTOR_CONFIG?.trim()
    if (connectorConfig) {
      let body: Record<string, unknown>
      try {
  body = await callConnector(
    connectorConfig,
    "search",
    { query: args.query, max_results: 5, category },
    sessionID,
    120_000,
  )
      } catch (error: any) {
        rollbackQuery(sessionID, args.query)
        return `ERROR: sc_search_web Connector failed - ${error?.message || String(error)}`
      }
      if ((body.error as { code?: unknown } | null)?.code === "search_query_carries_url") {
        rollbackQuery(sessionID, args.query)
        return QUERY_CARRIES_URL
      }
      return formatConnectorSearch(body)
    }
    // The helper below searches from inside the sandbox, which a runtime that requires the
    // Connector must never do.
    if (process.env.SUPERCLAW_CONNECTOR_REQUIRED?.trim() === "1") {
      rollbackQuery(sessionID, args.query)
      return "ERROR: sc_search_web Connector failed - the Connector is required but SUPERCLAW_CONNECTOR_CONFIG is not set"
    }

    // DO NOT CHANGE the indentation of the Python code below; it is passed to `python -c` and must be valid Python.
    const python = `
import json
import sys
import signal

sys.path.insert(0, ${toolsDirPy})
from sc_tavily_search import search_web

def _on_timeout(signum, frame):
    raise TimeoutError("Timed out")

if hasattr(signal, "SIGALRM"):
    signal.signal(signal.SIGALRM, _on_timeout)
    signal.alarm(${timeoutSeconds})

try:
    data = json.loads(sys.argv[1])
    result = search_web(data.get("query", ""), data.get("category"))
    if result is None:
        result = ""
    print(str(result))
except TimeoutError:
    print(f"ERROR: web search timed out after ${timeoutSeconds} seconds.", file=sys.stderr)
    sys.exit(124)
finally:
    if hasattr(signal, "SIGALRM"):
        signal.alarm(0)
`

    try {
      const env = { ...process.env }
      const py = resolveAgentPython()
      const output = await runPythonHelper(py, python, payload, toolsDir, env)
      return output
    } catch (error: any) {
      // Failed searches yield no usable data, so they should not spend budget.
      rollbackQuery(sessionID, args.query)
      const stderr = error?.stderr instanceof Uint8Array
        ? new TextDecoder().decode(error.stderr)
        : (error?.stderr ?? "")
      const msg = stderr.trim() || error?.message || String(error)
      return `ERROR: sc_search_web bridge failed - ${msg}`
    }
  },
})
