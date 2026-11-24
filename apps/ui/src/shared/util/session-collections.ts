import type { Session } from "@opencode-ai/sdk/v2/client";
import type { ModelRef } from "~/shared/types/models";
import type { MessageInfo, MessageWithParts } from "~/shared/types/session";
import { LOCAL_PROVIDER_ALIASES } from "./model-ref";

export function upsertSession(list: Session[], next: Session) {
  const idx = list.findIndex((s) => s.id === next.id);
  if (idx === -1) return [...list, next];

  const copy = list.slice();
  copy[idx] = next;
  return copy;
}

export function normalizeSessionStatus(status: unknown) {
  if (!status || typeof status !== "object") return "idle";
  const record = status as Record<string, unknown>;
  if (record.type === "busy") return "running";
  if (record.type === "retry") return "retry";
  if (record.type === "idle") return "idle";
  return "idle";
}

export function modelFromUserMessage(info: MessageInfo): ModelRef | null {
  if (!info || typeof info !== "object") return null;
  // Placeholder messages can carry role "user" without a model attachment.
  if (info.role !== "user" || !("model" in info)) return null;

  const model = info.model;
  if (!model || typeof model !== "object") return null;

  const providerID = model.providerID;
  const modelID = model.modelID;

  if (typeof providerID !== "string" || typeof modelID !== "string")
    return null;

  const normalizedModelID = modelID.trim().toLowerCase();
  if (
    LOCAL_PROVIDER_ALIASES.has(providerID.trim().toLowerCase()) &&
    (normalizedModelID === "local-model" || normalizedModelID === "cloud-model")
  ) {
    return null;
  }

  return { providerID, modelID };
}

export function lastUserModelFromMessages(
  list: MessageWithParts[],
): ModelRef | null {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const model = modelFromUserMessage(list[i]?.info);
    if (model) return model;
  }

  return null;
}