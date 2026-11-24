import type { ModelRef } from "./types";

export type PendingSessionRoutingOptions = {
  sessionID: string;
  pendingAgent: string | null;
  pendingModel: ModelRef | null;
  setSessionAgent: (sessionID: string, agent: string | null) => void;
  setSessionModel: (sessionID: string, model: ModelRef) => void;
  clearPendingAgent: () => void;
  clearPendingModel: () => void;
  prepareAgentModelPolicy: (
    sessionID: string,
    agent: string,
    pendingModel?: ModelRef | null,
  ) => (() => void) | null;
};

export function resolveDraftAgentModel(
  model: ModelRef,
  agent: string | null,
  localModel: ModelRef | null,
  forceLocalAgents: ReadonlySet<string>,
): ModelRef {
  if (
    localModel &&
    agent &&
    forceLocalAgents.has(agent) &&
    model.providerID === "llmrouter" &&
    model.modelID === "auto"
  ) {
    return localModel;
  }
  return model;
}

export function applyPendingSessionRouting(
  options: PendingSessionRoutingOptions,
): boolean {
  const { pendingAgent, pendingModel } = options;
  let commitAgentModelPolicy: (() => void) | null = null;

  if (pendingAgent) {
    commitAgentModelPolicy = options.prepareAgentModelPolicy(
      options.sessionID,
      pendingAgent,
      pendingModel,
    );
    if (!commitAgentModelPolicy) return false;
  }

  if (pendingModel) {
    options.setSessionModel(options.sessionID, pendingModel);
    options.clearPendingModel();
  }

  if (pendingAgent) {
    options.setSessionAgent(options.sessionID, pendingAgent);
    commitAgentModelPolicy?.();
    options.clearPendingAgent();
  }

  return true;
}