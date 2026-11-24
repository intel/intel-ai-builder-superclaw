import type { MessageWithParts } from "../../types";
import type { TimelineMetaItem } from "./message-list.timeline-row";
import { t } from "../../../i18n";

type Part = MessageWithParts["parts"][number];
type Resolver = "dps" | "llm";

function resolversFromOutput(output: unknown): Resolver[] {
  if (typeof output !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const body = parsed as { resolved_by?: unknown; results?: unknown };
  const items = Array.isArray(body.results) ? body.results : [body];
  return items.flatMap((item) => {
    const value = (item as { resolved_by?: unknown } | null)?.resolved_by;
    return value === "dps" || value === "llm" ? [value] : [];
  });
}

export function maskingResolverMetaItem(part: Part): TimelineMetaItem | undefined {
  if (part.type !== "tool") return undefined;
  const tool = part as { tool?: unknown; state?: { status?: unknown; output?: unknown } };
  if (tool.tool !== "run_protected_file_pipeline" || tool.state?.status !== "completed") {
    return undefined;
  }
  const resolvers = new Set(resolversFromOutput(tool.state.output));
  // Put a badge for a mixed dps+llm batch instead of mislabeling it pure LLM masking
  if (resolvers.size !== 1) return undefined;
  if (resolvers.has("dps")) {
    return { text: t("session.masking_on_device"), title: t("session.masking_on_device_title") };
  }
  return { text: t("session.masking_llm"), title: t("session.masking_llm_title") };
}