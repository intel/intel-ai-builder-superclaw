import { tool } from "@opencode-ai/plugin"
import { resolveReadersPython } from "./_python_env"

export default tool({
  description:
    `Aggregate a CSV or XLSX file deterministically — sums, counts, averages, group-by, filters, sort, top-N. Use this for any arithmetic over a tabular file; never sum rows in your head. A wrong column name returns an error listing the available columns.

Example — asset-class weights from portfolio holdings:
  local_dr_query_table({
    path: "/abs/path/portfolio_holdings.csv",
    group_by: ["Asset_Class"],
    aggregate: [{col:"Market_Value", op:"sum"}],
    add_pct_of_total: true
  })
  → rows: [{Asset_Class:"Equity", Market_Value_sum:12300, Market_Value_sum_pct:10.0}, ...]
     grand_total: {Market_Value_sum: 123000}

Aggregate output columns are named "<col>_<op>" (e.g. "Market_Value_sum"); use that name in sort_by.`,
  args: {
    path: tool.schema
      .string()
      .describe('Absolute path to a .csv or .xlsx file. e.g. "/abs/path/portfolio_holdings_q4_2024.csv"'),
    sheet: tool.schema
      .string()
      .optional()
      .describe('XLSX only — sheet name; defaults to the first sheet. e.g. "Active Contracts"'),
    filter: tool.schema
      .array(tool.schema.object({
        col: tool.schema.string(),
        op:  tool.schema.string()
              .describe("One of: == != > < >= <= in contains isnull notnull"),
        val: tool.schema.any().optional(),
      }))
      .optional()
      .describe(
        'Row filter. Multiple filters AND together. ' +
        'e.g. [{col:"Vendor", op:"==", val:"Texas Instruments"}] · ' +
        '[{col:"Delivery_Status", op:"in", val:["Delivered","In Transit"]}]'
      ),
    group_by: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe('Columns to group by; output has one row per group. e.g. ["Asset_Class"] · ["Department","Location"]'),
    aggregate: tool.schema
      .array(tool.schema.object({
        col: tool.schema.string(),
        op:  tool.schema.string()
              .describe("One of: sum mean count min max first nunique"),
      }))
      .optional()
      .describe(
        'Aggregations to compute. Output column is named "<col>_<op>". ' +
        'e.g. [{col:"Market_Value", op:"sum"}] · ' +
        '[{col:"Voluntary_Turnover_Pct_TTM", op:"mean"}]'
      ),
    sort_by: tool.schema
      .object({
        col: tool.schema.string(),
        dir: tool.schema.string().optional()
              .describe("'asc' (default) or 'desc'"),
      })
      .optional()
      .describe(
        'Sort the result. Use the OUTPUT column name. ' +
        'e.g. {col:"Market_Value_sum", dir:"desc"}'
      ),
    limit: tool.schema
      .number()
      .optional()
      .describe("Return at most this many rows after sort. e.g. 3"),
    add_pct_of_total: tool.schema
      .boolean()
      .optional()
      .describe('Add a pct-of-total column for each *_sum / *_count aggregation.'),
  },
  async execute(args, context) {
    const toolsDir = (import.meta as any).dir
      ?? `${context.worktree}/.opencode/tools`
    const payload = JSON.stringify({
      path:             args.path,
      sheet:            args.sheet ?? null,
      filter:           args.filter ?? null,
      group_by:         args.group_by ?? null,
      aggregate:        args.aggregate ?? null,
      sort_by:          args.sort_by ?? null,
      limit:            args.limit ?? null,
      add_pct_of_total: !!args.add_pct_of_total,
    })

    try {
      // Bun.spawn() (not the shell-template API, which has no windowsHide equivalent) so this
      // subprocess never flashes a console window on Windows.
      const bun = (globalThis as any).Bun
      const py = resolveReadersPython()
      const proc = bun.spawn([py, "local_dr_query_table.py", payload], {
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
      // Surface stderr (which is the {"error":...} JSON) directly to the agent
      // so it sees "available columns: [...]" inline.
      throw new Error(stderr.trim() || `local_dr_query_table exited rc=${exitCode}`)
    } catch (error) {
      throw new Error(
        `local_dr_query_table failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  },
})
