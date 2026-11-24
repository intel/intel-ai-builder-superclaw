/**
 * Log-formatting helpers shared by the orchestrator CLI logger.
 *
 * Extracted from `cli.ts` so pure formatting can be unit-tested without
 * importing the CLI entry point (which runs `main()` on import).
 */

/**
 * Startup-logging unification (2026-07-21 §4.5): the pretty log branch does not
 * emit attributes/resource, so the launch `boot_id` (injected as
 * `SUPERCLAW_BOOT_ID`) must be prepended to the line itself to
 * appear in `runtime-*.log`. An empty `bootId` (standalone runs) is a no-op.
 */
export function prefixPrettyLineWithBootId(line: string, bootId: string): string {
  const trimmed = bootId.trim();
  return trimmed ? `boot=${trimmed} ${line}` : line;
}
