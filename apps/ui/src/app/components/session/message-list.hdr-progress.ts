import type { Part } from "@opencode-ai/sdk/v2/client";

export const HDR_TOOL = "hybrid_dr_post_polish_processor";

export type HdrWebSearch = {
  query: string;
  results: { title: string; url: string }[];
};

/**
 * Web searches Hybrid Deep Research ran in its sidecar. They are not chat tool
 * steps, so the HDR tool reports them on its part's `state.metadata.webSearches`,
 * while it runs and on its result.
 */
export function hdrWebSearches(part: Part): HdrWebSearch[] {
  if (part.type !== "tool" || part.tool !== HDR_TOOL) return [];
  const metadata = (part.state as { metadata?: { webSearches?: unknown } })
    .metadata;
  const raw = metadata?.webSearches;
  if (!Array.isArray(raw)) return [];
  const searches: HdrWebSearch[] = [];
  for (const entry of raw) {
    const query = typeof entry?.query === "string" ? entry.query.trim() : "";
    if (!query) continue;
    const results: HdrWebSearch["results"] = [];
    for (const result of Array.isArray(entry.results) ? entry.results : []) {
      const url = typeof result?.url === "string" ? result.url.trim() : "";
      if (!url) continue;
      const title = typeof result.title === "string" ? result.title.trim() : "";
      results.push({ title, url });
    }
    searches.push({ query, results });
  }
  return searches;
}

export type HdrPhaseStatus = "done" | "running" | "failed" | "pending" | "skipped";

export type HdrPhase = {
  phase: string;
  label: string;
  status: HdrPhaseStatus;
  durationMs?: number;
};

export type HdrSection = {
  title: string;
  stage: "writing" | "reviewing" | "done";
  attempt?: number;
};

export type HdrProgress = {
  phases: HdrPhase[];
  localFiles: string[];
  /** Sections in the plan; `sections` holds only the ones the writer has started. */
  sectionCount: number;
  sections: HdrSection[];
};

const PHASE_STATUSES = new Set<string>(["done", "running", "failed", "pending", "skipped"]);
const SECTION_STAGES = new Set<string>(["writing", "reviewing", "done"]);

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/**
 * The phases, local file names and planned sections the HDR tool reports on
 * `state.metadata.hdrProgress`, the same way as its web searches. Null until
 * the tool has reported a phase.
 */
export function hdrProgress(part: Part): HdrProgress | null {
  if (part.type !== "tool" || part.tool !== HDR_TOOL) return null;
  const raw = (part.state as { metadata?: { hdrProgress?: unknown } }).metadata
    ?.hdrProgress as
    | { phases?: unknown; localFiles?: unknown; sectionCount?: unknown; sections?: unknown }
    | undefined;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.phases)) return null;
  const phases: HdrPhase[] = [];
  for (const entry of raw.phases) {
    if (!entry || typeof entry !== "object") continue;
    const phase = text(entry?.phase);
    const status = text(entry?.status);
    if (!phase || !PHASE_STATUSES.has(status)) continue;
    const durationMs = entry.durationMs;
    phases.push({
      phase,
      label: text(entry.label) || phase,
      status: status as HdrPhaseStatus,
      ...(typeof durationMs === "number" && durationMs >= 0 ? { durationMs } : {}),
    });
  }
  if (phases.length === 0) return null;
  const localFiles = (Array.isArray(raw.localFiles) ? raw.localFiles : [])
    .map(text)
    .filter(Boolean);
  const sections = (Array.isArray(raw.sections) ? raw.sections : []).flatMap(
    (entry: { title?: unknown; stage?: unknown; attempt?: unknown } | null): HdrSection[] => {
      const title = text(entry?.title);
      const stage = text(entry?.stage);
      if (!title || !SECTION_STAGES.has(stage)) return [];
      const attempt = entry?.attempt;
      return [
        {
          title,
          stage: stage as HdrSection["stage"],
          ...(typeof attempt === "number" && Number.isInteger(attempt) && attempt > 0 ? { attempt } : {}),
        },
      ];
    },
  );
  const count = raw.sectionCount;
  const sectionCount =
    typeof count === "number" && Number.isInteger(count) && count >= sections.length ? count : sections.length;
  return { phases, localFiles, sectionCount, sections };
}

/** The text the HDR Activity rows show, so a search matches only what it can reveal: result
 * titles and URLs appear as favicons there, not as text. */
export function hdrActivityText(progress: HdrProgress, searches: HdrWebSearch[]): string {
  return [
    ...progress.phases.map((phase) => phase.label),
    ...progress.localFiles,
    ...searches.map((search) => search.query),
    ...progress.sections.map((section) => section.title),
  ].join("\n");
}

export function hdrWebSearchUrls(part: Part): string[] {
  return hdrWebSearches(part).flatMap((search) =>
    search.results.map((result) => result.url),
  );
}

export function hdrWebSearchText(searches: HdrWebSearch[]): string {
  return searches
    .map((search) => {
      const count = search.results.length;
      const heading = `Web search: ${search.query} (${count} ${count === 1 ? "result" : "results"})`;
      const lines = search.results.map((result) =>
        result.title ? `- ${result.title}\n  ${result.url}` : `- ${result.url}`,
      );
      return [heading, ...lines].join("\n");
    })
    .join("\n\n");
}
