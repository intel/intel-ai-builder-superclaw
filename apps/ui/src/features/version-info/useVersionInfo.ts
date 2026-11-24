import { createSignal, onCleanup, onMount } from "solid-js";
import { getBackendSystemStatus, getDebugBuildCommit } from "~/shared/platform/tauri";
import { isTauriRuntime } from "~/shared/platform/runtime-env";

// Single shared instance (created once in app.tsx and passed to both SessionView
// and DashboardView) so the two pages' sidebars show the same version/commit at
// the same time instead of each racing its own independent fetch.
export function useVersionInfo() {
  const [versionLabel, setVersionLabel] = createSignal<string | null>(null);
  const [debugBuildCommit, setDebugBuildCommit] = createSignal<string | null>(null);
  const [commitCopied, setCommitCopied] = createSignal(false);
  const debugBuildCommitLabel = () => debugBuildCommit()?.slice(0, 8) ?? null;

  // Guards against updating signals after the owner disposes. Timers are
  // intentionally left to fire (not cleared) on cleanup: the retry loop below
  // awaits a Promise that a backoff timer resolves, so clearing that timer
  // would leave the loop's await permanently pending instead of exiting via
  // the `disposed` check right after it.
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  const copyDebugBuildCommit = async () => {
    const commit = debugBuildCommit();
    if (!commit) return;
    try {
      await navigator.clipboard.writeText(commit);
      setCommitCopied(true);
      setTimeout(() => {
        if (!disposed) setCommitCopied(false);
      }, 2000);
    } catch {
      // best-effort
    }
  };

  onMount(async () => {
    if (!isTauriRuntime()) return;
    if (__BUILD_DEBUG__) {
      void (async () => {
        try {
          const commit = await getDebugBuildCommit();
          if (!disposed) setDebugBuildCommit(commit.trim() || null);
        } catch {
          if (!disposed) setDebugBuildCommit(null);
        }
      })();
    }
    const MAX_ATTEMPTS = 5;
    const BASE_DELAY_MS = 3_000;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (disposed) return;
      try {
        const raw = (await getBackendSystemStatus()) as Record<string, unknown>;
        const ver = typeof raw?.version === "string" ? raw.version.trim() : null;
        if (ver) {
          if (!disposed) setVersionLabel(ver);
          return;
        }
      } catch {
        // backend-manager not ready yet
      }
      if (disposed) return;
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, BASE_DELAY_MS * (attempt + 1)));
      }
    }
  });

  return {
    versionLabel,
    debugBuildCommit,
    debugBuildCommitLabel,
    commitCopied,
    copyDebugBuildCommit,
  };
}
