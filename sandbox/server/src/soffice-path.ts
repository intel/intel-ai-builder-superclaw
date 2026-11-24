import { join } from "node:path";
import { ApiError } from "./errors.js";
import { exists } from "./utils.js";

/**
 * Locate the LibreOffice launcher used by the Office preview, or undefined when
 * it is not installed. The first candidate that exists wins:
 *
 * 1. `SUPERCLAW_SOFFICE_PATH`, an explicit override.
 * 2. On Windows, `soffice.exe` in the default per-machine install folders.
 * 3. `/usr/bin/soffice`, where Linux packages put it.
 */
export async function findSoffice(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): Promise<string | undefined> {
  const candidates: string[] = [];
  const override = env.SUPERCLAW_SOFFICE_PATH?.trim();
  if (override) candidates.push(override);
  if (platform === "win32") {
    for (const programFiles of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
      if (programFiles) candidates.push(join(programFiles, "LibreOffice", "program", "soffice.exe"));
    }
  }
  candidates.push("/usr/bin/soffice");
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

/** The path from `findSoffice`, or a 503 `office_preview_not_installed`. */
export async function requireSoffice(): Promise<string> {
  const found = await findSoffice();
  if (!found) {
    throw new ApiError(503, "office_preview_not_installed", "Office preview package is not installed");
  }
  return found;
}
