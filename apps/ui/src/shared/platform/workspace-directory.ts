import type { WorkspaceInfo } from "~/shared/platform/tauri";

/**
 * Resolve the directory path that should be sent to opencode/openwork-server
 * for a given workspace.
 *
 * - **Direct engine** (opencode running on the host, no sandbox): use
 *   the host-side `path`. The opencode process and the workspace folder share
 *   a filesystem.
 * - **Orchestrator engine** (opencode in the sandbox container): use
 *   `containerPath` (the bind-mounted, container-side mount point — typically
 *   `/workspace`). Falling back to `path` would send the host's Windows path
 *   `C:\Users\...` into Linux, where it gets misresolved as a relative path.
 *
 * `engineRuntime` may be `null`/`undefined` during initial load — in that case
 * we treat it as "unknown yet" and use the same resolution as the orchestrator
 * path: prefer `containerPath` when present, otherwise fall back to `path`.
 * Callers that have a stronger signal (e.g. `EngineInfo.runtime`) should pass
 * it.
 *
 * Introduced 2026-04-30 as part of the windows-path-leak fix; see
 * `docs/fixes/2026-04-30-windows-path-leak/`.
 */
export function resolveWorkspaceDirectory(
  workspace: WorkspaceInfo | null | undefined,
  engineRuntime: "direct" | "openwork-orchestrator" | null | undefined,
): string {
  if (!workspace) return "";

  // Remote workspaces (workspaceType === "remote") use `directory` semantics
  // already, and the backend they talk to runs in its own filesystem context.
  // We don't translate paths for remote.
  if (workspace.workspaceType === "remote") {
    return (workspace.directory ?? workspace.path ?? "").trim();
  }

  // Direct engine: opencode runs on the host, so the host path is correct.
  if (engineRuntime === "direct") {
    return (workspace.path ?? "").trim();
  }

  // Orchestrator engine (or unknown yet): prefer the container-side path, but
  // fall back to host path if the workspace was created on a pre-fix build
  // and hasn't been migrated yet (defense-in-depth — migration v4→v5 should
  // populate this for all local workspaces).
  const containerPath = (workspace.containerPath ?? "").trim();
  if (containerPath) return containerPath;
  return (workspace.path ?? "").trim();
}
