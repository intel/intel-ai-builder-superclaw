import type { ParentProps } from "solid-js";

import App from "./app";
import { AppErrorBoundary } from "./components/app-error-boundary";
import UpdateInstallConfirmModal from "./components/update-install-confirm-modal";
import { AppCapabilityProfileProvider } from "~/shared/platform/capability/app-capability-provider";
import { HostMcpEarlyWake } from "~/features/host-mcp";
import { CapabilityStartupResolver } from "./capability/capability-startup-resolver";
import { ElevationGate } from "./capability/elevation-gate";
import { HostClientProvider, useHostClient } from "./capability/host-client-provider";
import { PortConflictGate } from "./capability/port-conflict-gate";
import { GlobalSDKProvider } from "./context/global-sdk";
import { GlobalSyncProvider } from "./context/global-sync";
import { LocalProvider } from "./context/local";
import { ServerProvider } from "./context/server";
import { isWebDeployment } from "./lib/openwork-deployment";
import { isTauriRuntime } from "./utils";

/**
 * Bridges `HostClientProvider`'s Hub settings into `AppCapabilityProfileProvider`
 * so its fetch/retry state machine has a `{baseUrl, token}` to call
 * `GET /app/capability-profile` once ServiceHub reports ready. The
 * `CapabilityStartupResolver` then gates mounting of the runtime tree on the
 * capability profile: it shows a startup progress overlay while first-launch
 * activation runs, and only mounts the app once the profile is active.
 * Dark-safe: when gating is OFF (backend 404 → transport_error), the resolver
 * passes through to the runtime tree unchanged.
 */
function CapabilityProfileBridge(props: ParentProps) {
  const host = useHostClient();
  return (
    <AppCapabilityProfileProvider settings={host.settings}>
      {/* Outside the resolver: the host MCP gateway must be up before the runtime connects to it. */}
      <HostMcpEarlyWake settings={host.settings} />
      <CapabilityStartupResolver>{props.children}</CapabilityStartupResolver>
    </AppCapabilityProfileProvider>
  );
}

export default function AppEntry() {
  // [Remote-first] No default URL — user must add a remote worker manually.
  // For hosted web deployments, use same-origin proxy.
  const defaultUrl = (() => {
    if (isWebDeployment() && import.meta.env.PROD && typeof window !== "undefined") {
      return `${window.location.origin}/opencode`;
    }
    return "";
  })();

  // The runtime tree MUST be a component (not a pre-created JSX value) so its
  // SolidJS owner is established WHERE IT IS RENDERED (inside the capability
  // providers), not where it is declared. A pre-created `const runtimeTree = (…)`
  // captures AppEntry as its owner, so `useContext(AppCapabilityContext)` inside
  // App/session resolves against AppEntry's owner chain — which is OUTSIDE the
  // providers — and silently falls back to the passthrough gate (gating off,
  // e.g. quick-agent buttons never filtered). Rendering it as <RuntimeTree/>
  // inside the bridge fixes the owner so context flows correctly.
  const RuntimeTree = () => (
    <ServerProvider defaultUrl={defaultUrl}>
      <GlobalSDKProvider>
        <GlobalSyncProvider>
          <LocalProvider>
            <App />
            <UpdateInstallConfirmModal />
          </LocalProvider>
        </GlobalSyncProvider>
      </GlobalSDKProvider>
    </ServerProvider>
  );

  // `HostClientProvider`/`AppCapabilityProfileProvider` are the outermost
  // layer, wrapping the entire runtime tree (per
  // docs/design/2026-07-16_servicehub_能力分级_C1_C4_G1_G3_分步开发与推送计划.md §9's
  // target composition), so a future `StartupShellResolver` can be inserted
  // between them and `runtimeTree` to conditionally mount it — instead of
  // nesting them inside the tree they're meant to eventually gate.
  //
  // HostClientProvider's default bridge calls real Tauri `listen`/`invoke`
  // APIs, which are unavailable in web deployments — only mount it (and the
  // capability profile provider it feeds) inside the installed desktop app.
  if (!isTauriRuntime())
    return (
      <AppErrorBoundary scope="root" variant="root">
        <RuntimeTree />
      </AppErrorBoundary>
    );

  // `ElevationGate` and then `PortConflictGate` sit OUTSIDE everything, including HostClientProvider.
  // A port conflict means no managed service can start at all, so there is
  // nothing for the host client or capability providers to talk to — mounting
  // them would only fire doomed startup effects behind the dialog. Its Rust
  // counterpart has already declined to spawn ServiceHub by this point.
  return (
    <AppErrorBoundary scope="root" variant="root">
      <ElevationGate>
        <PortConflictGate>
          <HostClientProvider>
            <CapabilityProfileBridge>
              <RuntimeTree />
            </CapabilityProfileBridge>
          </HostClientProvider>
        </PortConflictGate>
      </ElevationGate>
    </AppErrorBoundary>
  );
}
