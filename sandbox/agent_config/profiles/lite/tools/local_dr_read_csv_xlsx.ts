import { tool } from "@opencode-ai/plugin"
import { resolveReadersPython } from "./_python_env"

export default tool({
  description:
    `Read a CSV or XLSX file and return its schema + deterministic auto-aggregations (sums grouped by every low-cardinality categorical column, with a TOTAL row). For small sheets (≤1000 cells = rows × cols) the full table is included; for larger sheets the rows are suppressed and you must call \`query_table\` to retrieve specifics.

For XLSX, every sheet is rendered in one call (each sheet is evaluated against the cell-count threshold independently).`,
  args: {
    path: tool.schema
      .string()
      .describe('Absolute path to a .csv or .xlsx file. e.g. "/abs/path/headcount_by_team.csv"'),
  },
  async execute(args, context) {
    const toolsDir = (import.meta as any).dir
      ?? `${context.worktree}/.opencode/tools`
    const payload = JSON.stringify({ path: args.path })

    try {
      // Bun.spawn() (not the shell-template API, which has no windowsHide equivalent) so this
      // subprocess never flashes a console window on Windows.
      const bun = (globalThis as any).Bun
      const py = resolveReadersPython()
      const proc = bun.spawn([py, "local_dr_read_csv_xlsx.py", payload], {
        cwd: toolsDir,
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (exitCode === 0) {
        return stdout.trim()
      }
      throw new Error(stderr.trim() || `local_dr_read_csv_xlsx exited rc=${exitCode}`)
    } catch (error) {
      throw new Error(
        `local_dr_read_csv_xlsx failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  },
})
