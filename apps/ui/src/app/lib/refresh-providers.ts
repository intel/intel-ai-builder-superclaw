// Provider-list refresh helper extracted for testability.
//
// Why "dispose" before list:
// opencode keeps per-directory state in memory (config + providers). After a
// runtime upgrade — e.g. an edge-model apply/clear that restarts opencode —
// the upstream process is fresh, but the SDK client and request flow can
// still hand back stale provider data unless the directory state is
// explicitly invalidated. Calling /instance/dispose forces opencode to drop
// the directory cache so the next provider.list() rebuilds from disk.

export type ProviderListPayload = {
  all: unknown;
  connected?: unknown;
  default?: unknown;
};

export type RefreshClient = {
  instance: { dispose: () => Promise<unknown> };
  provider: { list: () => Promise<{ data?: ProviderListPayload; error?: unknown }> };
};

export type RefreshTrace = {
  disposeCalled: boolean;
  listCalled: boolean;
  result: ProviderListPayload | null;
};

export async function refreshProvidersWithDispose(
  client: RefreshClient | null,
  options?: { dispose?: boolean },
): Promise<RefreshTrace> {
  const trace: RefreshTrace = {
    disposeCalled: false,
    listCalled: false,
    result: null,
  };
  if (!client) return trace;

  if (options?.dispose) {
    trace.disposeCalled = true;
    try {
      await client.instance.dispose();
    } catch {
      // ignore dispose failure — still attempt to read fresh state
    }
  }

  trace.listCalled = true;
  const res = await client.provider.list();
  if (res.data !== undefined) {
    trace.result = res.data;
  }
  return trace;
}
