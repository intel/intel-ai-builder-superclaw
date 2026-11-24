import { createEffect, createSignal, on, type Accessor } from "solid-js";

import type {
  InstanceApiClient,
  TavilyApiKeyAvailability,
} from "../../shared/platform/transport/instance-api";

export type TavilyApiKeyClient = Pick<
  InstanceApiClient,
  "tavilyApiKey" | "saveTavilyApiKey" | "clearTavilyApiKey" | "setTavilyApiKeyEnabled"
>;

export type UseTavilyApiKeyDeps = {
  instanceApiClient: Accessor<TavilyApiKeyClient | null>;
  safeStringify: (value: unknown) => string;
};

export function useTavilyApiKey(deps: UseTavilyApiKeyDeps) {
  const [tavilyApiKey, setTavilyApiKey] = createSignal<TavilyApiKeyAvailability | null>(null);
  const [tavilyApiKeyStatus, setTavilyApiKeyStatus] = createSignal<
    "idle" | "loading" | "saving" | "error"
  >("idle");
  const [tavilyApiKeyError, setTavilyApiKeyError] = createSignal<string | null>(null);

  const errorMessage = (error: unknown) =>
    error instanceof Error ? error.message : deps.safeStringify(error);

  // Reads can overlap (a client change, a Retry): only the newest one may set the state.
  let latestRead = 0;

  const refreshTavilyApiKey = async () => {
    const read = ++latestRead;
    const client = deps.instanceApiClient();
    if (!client) {
      setTavilyApiKey(null);
      setTavilyApiKeyStatus("idle");
      return;
    }
    setTavilyApiKeyStatus("loading");
    setTavilyApiKeyError(null);
    try {
      const answer = await client.tavilyApiKey();
      if (read !== latestRead) return;
      setTavilyApiKey(answer);
      setTavilyApiKeyStatus("idle");
    } catch (error) {
      if (read !== latestRead) return;
      // An answer that can no longer be refreshed is not shown as if it were current.
      setTavilyApiKey(null);
      setTavilyApiKeyStatus("error");
      setTavilyApiKeyError(errorMessage(error));
    }
  };

  const update = async (
    request: (client: TavilyApiKeyClient) => Promise<TavilyApiKeyAvailability>,
  ) => {
    const client = deps.instanceApiClient();
    if (!client) {
      throw new Error("ServiceHub is not connected.");
    }
    setTavilyApiKeyStatus("saving");
    setTavilyApiKeyError(null);
    try {
      setTavilyApiKey(await request(client));
      setTavilyApiKeyStatus("idle");
    } catch (error) {
      setTavilyApiKeyStatus("error");
      setTavilyApiKeyError(errorMessage(error));
      throw error;
    }
  };

  createEffect(
    on(deps.instanceApiClient, (client) => {
      if (!client) {
        setTavilyApiKey(null);
        setTavilyApiKeyStatus("idle");
        setTavilyApiKeyError(null);
        return;
      }
      void refreshTavilyApiKey();
    }),
  );

  return {
    tavilyApiKey,
    tavilyApiKeyStatus,
    tavilyApiKeyError,
    refreshTavilyApiKey,
    saveTavilyApiKey: (apiKey: string) => update((client) => client.saveTavilyApiKey(apiKey)),
    clearTavilyApiKey: () => update((client) => client.clearTavilyApiKey()),
    setTavilyApiKeyEnabled: (enabled: boolean) => update((client) => client.setTavilyApiKeyEnabled(enabled)),
  };
}
