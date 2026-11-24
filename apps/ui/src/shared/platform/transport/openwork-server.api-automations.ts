/**
 * Agent Lab scheduled-automation management.
 */
import { requestJson } from "./openwork-server.transport";
import type { AgentLabAutomationItem, AgentLabSchedulePayload } from "./openwork-server.types";
import type { OpenworkClientContext } from "./openwork-server.client-context";

export function createAutomationsApi(ctx: OpenworkClientContext) {
  const { baseUrl, token, hostToken } = ctx;
  return {
    // AgentLab Automations
    listAgentLabAutomations: (workspaceId: string) =>
      requestJson<{ items: AgentLabAutomationItem[]; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/agentlab/automations`,
        { token, hostToken },
      ),
    createAgentLabAutomation: (
      workspaceId: string,
      // Omit `agent` to keep the stored one; "" resets to the default agent.
      payload: { id?: string; name: string; prompt: string; enabled?: boolean; schedule: AgentLabSchedulePayload; model?: string; agent?: string },
    ) =>
      requestJson<{ items: AgentLabAutomationItem[]; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/agentlab/automations`,
        { token, hostToken, method: "POST", body: payload },
      ),
    deleteAgentLabAutomation: (workspaceId: string, automationId: string) =>
      requestJson<{ ok: boolean }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/agentlab/automations/${encodeURIComponent(automationId)}`,
        { token, hostToken, method: "DELETE" },
      ),
    runAgentLabAutomation: (workspaceId: string, automationId: string, model?: string) =>
      requestJson<{ ok: boolean; automationId: string; sessionId: string; ranAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/agentlab/automations/${encodeURIComponent(automationId)}/run`,
        // Above the server's 45 s wait for the intent classifier on an unpinned prompt.
        { token, hostToken, method: "POST", body: model ? { model } : undefined, timeoutMs: 75_000 },
      ),
  };
}
