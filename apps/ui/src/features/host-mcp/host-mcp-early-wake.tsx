import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js";

import { useCapabilityGate } from "~/shared/platform/capability/capability-gate";
import { uiLogInfo, uiLogWarn } from "~/shared/platform/log/log";
import { createHostMcpApiClient, type HostMcpApiClient } from "~/shared/platform/transport/host-mcp-api";
import type { ServiceHubSettings } from "~/shared/platform/transport/servicehub";
import { HOST_MCP_POLL, sleepUnlessAborted } from "./host-mcp";

export type HostMcpWakeClient = Pick<HostMcpApiClient, "hasService" | "listServers">;

/**
 * Starts the on_demand host MCP gateway once per app start, as soon as ServiceHub is ready, its
 * catalog lists the gateway and a Profile flag allows it: before the workspace token, the runtime or
 * the MCP list, so the gateway already answers when OpenCode first connects its host servers. Waking
 * starts no host server; the gateway answers from its cached tool list.
 */
export function useHostMcpEarlyWake(deps: {
  settings: Accessor<ServiceHubSettings | null>;
  enabled: Accessor<boolean>;
  createClient?: (settings: ServiceHubSettings) => HostMcpWakeClient;
}): Accessor<boolean> {
  const [woken, setWoken] = createSignal(false);
  let started = false;

  createEffect(
    on([deps.settings, deps.enabled], ([settings, enabled]) => {
      if (!settings || !enabled || started) return;
      const client = (deps.createClient ?? createHostMcpApiClient)(settings);
      const stop = new AbortController();
      onCleanup(() => stop.abort());
      void (async () => {
        for (let failures = 0; !stop.signal.aborted; failures += 1) {
          let listed: boolean;
          try {
            listed = await client.hasService();
          } catch {
            await sleepUnlessAborted(
              Math.min(HOST_MCP_POLL.firstRetryMs * 2 ** failures, HOST_MCP_POLL.maxRetryMs),
              stop.signal,
            );
            continue;
          }
          if (!listed || stop.signal.aborted) return;
          started = true;
          try {
            await client.listServers({ cold: true });
            setWoken(true);
            uiLogInfo("mcp.host", "Woke the host MCP gateway once ServiceHub was ready");
          } catch (error) {
            uiLogWarn("mcp.host", "The host MCP gateway did not answer its early start-up call", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return;
        }
      })();
    }),
  );

  return woken;
}

/** Mounted beside the startup resolver, which holds the app back until the runtime is ready. */
export default function HostMcpEarlyWake(props: { settings: Accessor<ServiceHubSettings | null> }) {
  const capability = useCapabilityGate();
  useHostMcpEarlyWake({
    settings: props.settings,
    enabled: () => capability.mcpHostExecutionEnabled() || capability.hostBrowserEnabled(),
  });
  return null;
}
