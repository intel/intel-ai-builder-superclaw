import { existsSync } from "node:fs"
import { tool } from "@opencode-ai/plugin"
import { resolveReadersPython } from "./_python_env"

// No bun-types ambient declarations are wired up for this standalone tool script, so the
// global is narrowed through `unknown` to the one method this file calls instead of `any`.
interface BunLike {
  spawn(cmd: string[], options: Record<string, unknown>): {
    stdout: ReadableStream<Uint8Array>
    stderr: ReadableStream<Uint8Array>
    exited: Promise<number>
  }
}

const ENGINE_PROJECT_DIR = process.env.OCR_ENGINE_DIR
const ENGINE_VENV = process.env.OCR_ENGINE_VENV

export default tool({
  description:
    "Run OCR (RapidOCR, ONNXRuntime execution provider) on a page image. Returns JSON: `text` is the full transcription, one detected line per newline, and `lines[i]` gives line i's confidence and, when detection ran, its bounding box in image pixels. No vision-capable model is used and the image is never shown to any model. " +
    "The first call downloads the OCR engine and can take a few minutes; later calls reuse the persistent environment. " +
    "Copy the recognized characters exactly: never correct, complete or guess at them, even when they look wrong — you cannot see the image. " +
    "To present the result, reformat it into Markdown yourself, directly in your response text — this requires no further tool call.",
  args: {
    file_path: tool.schema
      .string()
      .describe("Absolute path to the image file to OCR"),
    region: tool.schema
      .array(tool.schema.number())
      .optional()
      .describe(
        "Optional part of the image to read, as [x1, y1, x2, y2] in image pixels (the same frame as a line's `box`)",
      ),
  },
  async execute(args, context) {
    const toolsDir =
      (import.meta as unknown as { dir?: string }).dir ??
      `${context.worktree}/.opencode/tools`

    const payload = JSON.stringify({
      file_path: args.file_path,
      ...(args.region ? { region: args.region } : {}),
    })

    const bun = (globalThis as unknown as { Bun?: BunLike }).Bun
    if (!bun) {
      throw new Error("ocr tool requires the Bun runtime")
    }

    const engineProject =
      ENGINE_PROJECT_DIR && existsSync(`${ENGINE_PROJECT_DIR}/uv.lock`) ? ENGINE_PROJECT_DIR : null
    // Bare "python3" does not exist on a stock Windows PATH, so the non-uv
    // fallback path has to resolve an interpreter per-platform.
    const py = resolveReadersPython()
    const script = `${toolsDir}/ocr_engine.py`

    try {
      // Run via Bun.spawn() (not the Bun $ shell-template API, which has no
      // windowsHide equivalent) so the subprocess never flashes a console
      // window on Windows.
      const proc = engineProject
        // egress-surface: ocr_engine_uv_run
        ? bun.spawn(
            ["uv", "run", "--frozen", "--project", engineProject, "python", script, payload],
            {
              cwd: toolsDir,
              env: {
                ...process.env,
                ...(ENGINE_VENV ? { UV_PROJECT_ENVIRONMENT: ENGINE_VENV } : {}),
                UV_PYTHON_PREFERENCE: "only-system",
              },
              stdout: "pipe",
              stderr: "pipe",
              windowsHide: true,
            },
          )
        : bun.spawn([py, script, payload], {
            cwd: toolsDir,
            env: process.env,
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
        const error = new Error(`process exited with code ${exitCode}`) as Error & {
          stdout?: string
          stderr?: string
          exitCode?: number
        }
        error.stdout = stdout
        error.stderr = stderr
        error.exitCode = exitCode
        throw error
      }
      const output = stdout.trim()

      // `uv run` reports exit code 0 even when the engine exits non-zero, so the
      // catch below never sees an engine failure: it arrives here as an empty
      // stdout, and returning that would tell the model the image holds no text.
      // The engine reports failure as an `error` key instead — surface both as a
      // tool error. Output that is not JSON is passed through unchanged, so a
      // stray warning on stdout stays as harmless as it was before.
      if (!output) {
        throw new Error(`ocr: engine produced no output for ${args.file_path}`)
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(output)
      } catch {
        return output
      }
      const engineError = (parsed as { error?: unknown }).error
      if (typeof engineError === "string") {
        throw new Error(`ocr: ${engineError}`)
      }

      return output
    } catch (error: unknown) {
      const decode = (v: unknown) =>
        v instanceof Uint8Array ? new TextDecoder().decode(v) : String(v ?? "")
      const err = error as Record<string, unknown>
      const stdout = decode(err?.stdout)
      const stderr = decode(err?.stderr)
      const exitCode = err?.exitCode ?? err?.code ?? "unknown"
      const stack = error instanceof Error ? error.stack : undefined

      throw new Error(
        [
          `ocr failed: ${error instanceof Error ? error.message : String(error)}`,
          `toolsDir: ${toolsDir}`,
          `file_path: ${args.file_path}`,
          `payload: ${payload}`,
          `exitCode: ${String(exitCode)}`,
          engineProject
            ? `engine: uv project ${engineProject} -> ${ENGINE_VENV ?? "its default environment"}`
            : `engine: ${py} (OCR_ENGINE_DIR is unset or has no uv.lock)`,
          stdout && `--- stdout ---\n${stdout}`,
          stderr && `--- stderr ---\n${stderr}`,
          stack && `--- stack ---\n${stack}`,
        ]
          .filter(Boolean)
          .join("\n"),
      )
    }
  },
})
