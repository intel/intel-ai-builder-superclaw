import { tool } from "@opencode-ai/plugin"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { resolveReadersPython } from "./_python_env"

// The Windows-native payload ships the interpreter and extract_text.py as READERS_VENV and
// READERS_DIR. Hardcoding Linux paths made parse_pdf crash in native mode.
function resolveScript() {
  const dir = process.env.READERS_DIR?.trim()
  if (dir) {
    const native = join(dir, "extract_text.py")
    if (existsSync(native)) return native
  }
  return "/opt/readers/extract_text.py"
}

const PYTHON = resolveReadersPython()
const SCRIPT = resolveScript()

export default tool({
  description:
    "One-time parsing step for PDF files. Extracts ALL pages from the PDF and saves the full content as a markdown file. " +
    "Returns the path to the markdown file. After calling this tool, use the Read or Grep tools on the returned markdown path to access the content - never read the original .pdf file directly. " +
    "This tool always processes the complete PDF regardless of file size. Do NOT pass page range arguments. " +
    "Call this once per PDF file; subsequent reads should use the returned markdown path.",
  args: {
    file_path: tool.schema.string().describe("Absolute path to the PDF file"),
  },
  async execute(r, _ctx) {
    if (!/\.pdf$/i.test(r.file_path)) {
      throw new Error(
        `parse_pdf: '${r.file_path}' is not a .pdf file. This tool only extracts PDF content — ` +
        `use 'read', 'grep', or 'bash' for other file types instead.`
      )
    }
    const bun = globalThis.Bun
    let raw
    try {
      // Run via Bun.spawn() (not the Bun $ shell-template API, which has no
      // windowsHide equivalent) so the subprocess never flashes a console
      // window on Windows.
      const proc = bun.spawn([PYTHON, SCRIPT, r.file_path, "--advanced"], {
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
        const error = new Error(`process exited with code ${exitCode}`)
        error.stdout = stdout
        error.stderr = stderr
        error.exitCode = exitCode
        throw error
      }
      raw = stdout.trim()
    } catch (n) {
      const t = (m) => m instanceof Uint8Array ? new TextDecoder().decode(m) : String(m ?? "")
      const u = t(n?.stdout), v = t(n?.stderr), l = n?.exitCode ?? n?.code ?? "unknown"
      const s = n instanceof Error ? n.stack : undefined
      throw new Error(
        [`parse_pdf failed: ${n instanceof Error ? n.message : String(n)}`,
         `file_path: ${r.file_path}`, `exitCode: ${String(l)}`,
         u && `--- stdout ---\n${u}`, v && `--- stderr ---\n${v}`,
         s && `--- stack ---\n${s}`].filter(Boolean).join("\n")
      )
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`parse_pdf: failed to parse script output as JSON\n${raw}`)
    }
    if (!parsed.ok) {
      throw new Error(`parse_pdf: extraction failed: ${parsed.error ?? "unknown error"}`)
    }
    return `PDF parsed successfully (${parsed.pages ?? "?"} pages). Markdown saved to: ${parsed.md_path}\nUse the Read or Grep tools on that path to read the content.`
  },
})
