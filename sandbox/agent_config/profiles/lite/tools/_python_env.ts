// Shared interpreter resolvers for tools that shell out to Python.
//
// The bug this removes: every reader tool resolved Python differently and all of
// them assumed Linux — either the container venv layout (`<venv>/bin/python`) or a
// bare `python3` that does not exist on a stock Windows PATH and, even when it
// does, is not the venv that carries pandas / openpyxl / python-docx / rapidocr.
// On the Windows-native backend that made the whole reader family fail.
//
// The native backend names two environments and they are not interchangeable:
// READERS_VENV carries the reader libraries (pdfplumber, rapidocr, onnxruntime) and
// OPENCODE_PYTHON is the agent environment (tavily, ddgs), which has none of them.
//
// resolveReadersPython (first hit wins):
//   1. READERS_VENV               — Windows `Scripts\python.exe`, then POSIX `bin/python`
//   2. /opt/readers-venv          — the container's baked path (POSIX)
//   3. OPENCODE_PYTHON            — a partial dev build that staged no readers venv
//   4. "python3" / "python"       — last-resort PATH lookup (python on win32)
//
// resolveAgentPython: OPENCODE_PYTHON, else resolveReadersPython().
import { existsSync } from "node:fs"
import { join } from "node:path"

/** Absolute path (or PATH-relative name) of the Python that carries the reader libs. */
export function resolveReadersPython(): string {
  const venv = process.env.READERS_VENV?.trim()
  if (venv) {
    const win = join(venv, "Scripts", "python.exe")
    if (existsSync(win)) return win
    const posix = join(venv, "bin", "python")
    if (existsSync(posix)) return posix
  }

  if (existsSync("/opt/readers-venv/bin/python")) return "/opt/readers-venv/bin/python"

  const agent = process.env.OPENCODE_PYTHON?.trim()
  if (agent) return agent

  return process.platform === "win32" ? "python" : "python3"
}

/** Absolute path (or PATH-relative name) of the agent-environment Python. */
export function resolveAgentPython(): string {
  return process.env.OPENCODE_PYTHON?.trim() || resolveReadersPython()
}
