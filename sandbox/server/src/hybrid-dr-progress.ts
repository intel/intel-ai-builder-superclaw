// Pure helpers for the Hybrid Deep Research progress overlay in server.ts: the
// registry record the HDR tool writes per tool call, and how a running tool
// part's title, web searches and phase progress are derived from it.

const HYBRID_DR_PHASE_ORDER = [
  "input_local",
  "input_web",
  "plan",
  "section_write",
  "fill",
  "conclusion",
  "fill_conclusion",
  "assemble",
  "polish",
] as const;
const HYBRID_DR_PHASE_HUMAN: Record<string, string> = {
  input_local: "Reading local data",
  input_web: "Web research",
  plan: "Planning sections",
  section_write: "Drafting sections",
  fill: "Filling placeholders",
  conclusion: "Writing conclusion",
  fill_conclusion: "Filling conclusion",
  assemble: "Assembling report",
  polish: "Polishing report",
};

export type HybridDrProgressRegistry = {
  opencodeSessionId?: string;
  toolCallId?: string;
  sidecarSessionId?: string;
  sidecarUrl?: string;
  status?: string;
  updatedAt?: number;
  terminal?: boolean;
  webSearches?: unknown;
  hdrProgress?: unknown;
};

export function validHybridDrRegistry(registry: HybridDrProgressRegistry, sessionId: string, toolId: string): boolean {
  return !!registry && registry.opencodeSessionId === sessionId && registry.toolCallId === toolId
    && typeof registry.sidecarSessionId === "string" && registry.sidecarSessionId.length === 28
    && /^ses_[0-9a-f]{24}$/.test(registry.sidecarSessionId);
}

export function terminalHybridDrRegistry(registry: HybridDrProgressRegistry): boolean {
  return registry.terminal === true || ["completed", "done", "cancelled", "failed", "error"].includes(registry.status || "");
}

/** The tool's `context.metadata` does not reach a running part, so the web searches and phase
 * progress it shows travel on the registry. The UI validates their fields. */
export function hybridDrRegistryDisplay(registry: HybridDrProgressRegistry): Record<string, unknown> {
  const { webSearches, hdrProgress } = registry;
  return {
    ...(Array.isArray(webSearches) ? { webSearches } : {}),
    ...(hdrProgress && typeof hdrProgress === "object" && !Array.isArray(hdrProgress) ? { hdrProgress } : {}),
  };
}

export function hybridDrTitleForPhase(phase: string): { title: string; terminal: boolean } {
  const normalized = phase.trim().toLowerCase();
  if (normalized === "done") return { title: "Hybrid Deep Research [Done]", terminal: true };
  if (normalized === "failed") return { title: "Hybrid Deep Research [Failed]", terminal: true };
  if (normalized === "cancelled") return { title: "Hybrid Deep Research [Cancelled]", terminal: true };
  const idx = HYBRID_DR_PHASE_ORDER.indexOf(normalized as typeof HYBRID_DR_PHASE_ORDER[number]);
  if (idx < 0) return { title: "Hybrid Deep Research", terminal: false };
  const human = HYBRID_DR_PHASE_HUMAN[normalized] ?? normalized;
  return { title: `Hybrid Deep Research [${idx + 1}/${HYBRID_DR_PHASE_ORDER.length}: ${human}]`, terminal: false };
}

export function hybridDrToolIdCandidates(part: Record<string, unknown>): string[] {
  const state = part.state && typeof part.state === "object" ? part.state as Record<string, unknown> : {};
  const candidates = [
    part.id,
    part.messageID,
    part.messageId,
    part.callID,
    part.callId,
    state.callID,
    state.callId,
    state.toolCallID,
    state.toolCallId,
  ];
  return Array.from(new Set(candidates.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())));
}

export function hybridDrToolOutputStatus(part: Record<string, unknown>): string {
  const state = part.state && typeof part.state === "object" ? part.state as Record<string, unknown> : {};
  const output = typeof state.output === "string" ? state.output.trim() : "";
  if (!output) return "";
  try {
    const parsed = JSON.parse(output) as { status?: unknown };
    return typeof parsed.status === "string" ? parsed.status.trim().toLowerCase() : "";
  } catch {
    return "";
  }
}
