import { createLlmRouterClient } from "./llmrouter-client";
import type { LocalModelHealthInfo } from "./local-model-availability";
import { readOpenworkServerSettings } from "./openwork-server";

export async function loadLocalModelHealth(): Promise<LocalModelHealthInfo | null> {
  const settings = readOpenworkServerSettings();
  const hubUrl = settings.hubUrl?.trim() ?? "";
  const hubToken = settings.hubToken?.trim() ?? "";
  if (!hubUrl || !hubToken) return null;

  const client = createLlmRouterClient({ baseUrl: hubUrl, token: hubToken });

  try {
    // Derive from `active_provider` (committed primary bundle, same source the
    // data plane serves `local-model` from), NOT the raw `local_provider` user
    // selection — so an auto-committed first-launch bundle reports identically
    // to a manual one. See LRM /status: active_provider is null only when no
    // local bundle is committed-and-ready.
    const status = (await client.status()) as {
      summary?: {
        active_provider?: string | null;
        selected_tier?: string | null;
        model_selections?: Array<{ role?: string; model_id?: string | null }>;
      };
    };
    const summary = status?.summary ?? {};
    const activeProvider = summary.active_provider;

    if (activeProvider !== "llamacpp" && activeProvider !== "edge") {
      return { status: "unset", model: null, provider: "llmrouter" };
    }

    const chat = summary.model_selections?.find((slot) => slot.role === "chat");
    const selectedModel = chat?.model_id?.trim() || summary.selected_tier?.trim();

    if (activeProvider === "llamacpp") {
      return {
        status: "healthy",
        model: selectedModel || "local-model",
        provider: "llmrouter",
      };
    }

    const edge = await client.getEdge();
    const model = edge.model_name?.trim() || selectedModel || "local-model";
    const probe = await client.testEdge();
    if (probe.status === "ok") {
      return {
        status: "healthy",
        model,
        provider: "llmrouter",
        latency_ms: probe.latency_ms,
      };
    }
    return {
      status: "unhealthy",
      model,
      provider: "llmrouter",
      latency_ms: probe.latency_ms,
      error: probe.error || probe.detail,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (message.includes("not configured")) {
      return { status: "unset", model: null, provider: "llmrouter" };
    }
    return null;
  }
}
