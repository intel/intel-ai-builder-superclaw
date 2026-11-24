import { createEffect, createSignal, on } from "solid-js";
import type { ProductProfileId } from "@different-ai/openwork-contracts/capability";
import {
  agentOptionsUnchanged,
  getVisibleAgentOptions,
} from "~/shared/platform/capability/visible-agent-roster";
import { isOpencodeRequestTimeout } from "~/shared/platform/transport/opencode-cold-start";

export const AGENT_LOAD_TIMEOUT_MESSAGE = "Loading agents timed out. Click to retry.";

/**
 * Above two OpenCode calls. Each call is aborted by the transport at 10s, and
 * the agent and command lists retry that abort once. A cold start after
 * `/instance/dispose` and a dead server look the same from here, so the retry
 * is the click the picker was already asking for. An 8s ceiling fired first,
 * dropped the in-flight call, and showed that error while the instance was
 * still coming back (WCL 16 GB, #3493).
 */
export const LOAD_TIMEOUT_MS = 30_000;

function loadErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return "Failed to load agents";
  if (isOpencodeRequestTimeout(err)) return AGENT_LOAD_TIMEOUT_MESSAGE;
  return err.message;
}

/**
 * Generic over the agent shape for the same reason `visible-agent-roster` is:
 * `name` is the only field read here, so the SDK's `Agent` type has no reason
 * to reach this layer. The caller's `listAgents` fixes `T`.
 */
type AgentOptionsDeps<T extends { name: string }> = {
  listAgents: () => Promise<T[]>;
  /** Bumped by the caller after an agent is created, to force a re-fetch. */
  agentsVersion: () => number;
  connectionKey: () => object | null;
  capabilityActive: () => boolean;
  isAgentAllowed: (agentName: string) => boolean;
  productProfileId: () => ProductProfileId | null;
};

type AgentOptionsController<T extends { name: string }> = {
  /** The visible agent roster for the active product profile, sorted by name. */
  options: () => T[];
  /** Every agent `listAgents` returned, including ones the picker hides. */
  roster: () => T[];
  busy: () => boolean;
  ready: () => boolean;
  error: () => string | null;
  load: (force?: boolean) => Promise<T[]>;
};

export function createAgentOptions<T extends { name: string }>(
  deps: AgentOptionsDeps<T>,
): AgentOptionsController<T> {
  const [options, setOptions] = createSignal<T[]>([]);
  const [roster, setRoster] = createSignal<T[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let refreshAfterLoad = false;

  const load = async (force = false): Promise<T[]> => {
    if (busy()) return options();
    if (ready() && !force) return options();
    setBusy(true);
    setError(null);
    const connection = deps.connectionKey();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const agents = await Promise.race([
        deps.listAgents(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(AGENT_LOAD_TIMEOUT_MESSAGE)),
            LOAD_TIMEOUT_MS,
          );
        }),
      ]);
      if (connection !== deps.connectionKey()) return options();
      const listed = [...agents].sort((a: T, b: T) => a.name.localeCompare(b.name));
      if (!agentOptionsUnchanged(roster(), listed)) setRoster(listed);
      const sorted = getVisibleAgentOptions(
        agents,
        deps.capabilityActive(),
        deps.isAgentAllowed,
        deps.productProfileId(),
      ).sort((a: T, b: T) => a.name.localeCompare(b.name));
      // Reuse the previous array/objects when the visible roster didn't
      // actually change (e.g. a background refetch triggered by an
      // unrelated hot-reload). The picker's <For> reconciles by object
      // reference, so replacing it with a freshly-fetched-but-identical
      // array would remount every row and flicker even though nothing
      // changed for the user.
      const previous = options();
      const unchanged = agentOptionsUnchanged(previous, sorted);
      if (!unchanged) setOptions(sorted);
      setReady(true);
      return unchanged ? previous : sorted;
    } catch (err) {
      if (connection !== deps.connectionKey()) return options();
      setError(loadErrorMessage(err));
      if (!ready()) {
        setOptions([]);
        setRoster([]);
      }
      return options();
    } finally {
      // The losing race arm keeps the timer alive for the full timeout window
      // otherwise, which holds this closure and rejects after the fact.
      clearTimeout(timeoutId);
      setBusy(false);
      if (refreshAfterLoad) {
        refreshAfterLoad = false;
        void load(true);
      }
    }
  };

  // Re-fetch when the backend roster or validated product profile changes.
  createEffect(
    on(
      () => deps.agentsVersion(),
      () => {
        if (busy()) {
          refreshAfterLoad = true;
          return;
        }
        if (!ready()) return;
        void load(true);
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => [deps.capabilityActive(), deps.productProfileId()] as const,
      () => {
        const current = options();
        const visible = getVisibleAgentOptions(
          current,
          deps.capabilityActive(),
          deps.isAgentAllowed,
          deps.productProfileId(),
        );
        if (visible.length !== current.length) setOptions(visible);
        if (busy()) {
          refreshAfterLoad = true;
          return;
        }
        if (!ready()) return;
        void load(true);
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => deps.connectionKey(),
      (connection, previous) => {
        if (previous !== undefined && connection !== previous) {
          setOptions([]);
          setRoster([]);
          setReady(false);
          setError(null);
        }
        if (!connection) {
          refreshAfterLoad = false;
          return;
        }
        if (busy()) {
          if (previous !== undefined && connection !== previous) refreshAfterLoad = true;
          return;
        }
        if (!ready() || connection !== previous) void load(true);
      },
    ),
  );

  return { options, roster, busy, ready, error, load };
}
