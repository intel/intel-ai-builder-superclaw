import { tool } from "@opencode-ai/plugin"
import { resolveReadersPython } from "./_python_env"

export default tool({
  description:
    "Read a Word (.docx) file and return its content as markdown. Extracts paragraphs (preserving heading levels), bullet lists, and tables. Use this instead of the built-in read tool for .docx files.",
  args: {
    file_path: tool.schema
      .string()
      .describe("Absolute path to the .docx file to read"),
  },
  async execute(args, context) {
    // Use import.meta.dir (this file's on-disk directory) instead of
    // `${context.worktree}/.opencode/tools` — worktree resolves to the
    // git root, which doesn't include `local/` in our layout, so the
    // resulting path doesn't exist and the python subprocess fails.
    const toolsDir = (import.meta as any).dir
      ?? `${context.worktree}/.opencode/tools`
    const payload = JSON.stringify({ file_path: args.file_path })

    try {
      // Bun.spawn() (not the shell-template API, which has no windowsHide equivalent) so this
      // subprocess never flashes a console window on Windows.
      const bun = (globalThis as any).Bun
      const py = resolveReadersPython()
      const proc = bun.spawn([py, "local_dr_read_docx.py", payload], {
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
      if (exitCode !== 0) {
        throw new Error(stderr.trim() || `local_dr_read_docx exited rc=${exitCode}`)
      }
      return stdout.trim()
    } catch (error) {
      throw new Error(
        `local_dr_read_docx failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  },
})
