// Decide whether a mutating tool call touched an `.opencode` asset the running
// server has already loaded (a skill, command, agent or config), so the UI can
// offer a reload. Pure text/shape inspection; extracted from `session.ts`
// unchanged. Whether the edit is in scope for the active workspace, and the
// dedupe of a reason already reported, stay with the store.

import type { Part, ToolStateCompleted } from "@opencode-ai/sdk/v2/client";

import type { ReloadReason, ReloadTrigger } from "~/shared/types/opencode-connection";
import { safeStringify } from "~/shared/util/format";

const skillPathPattern = /[\\/]\.opencode[\\/](skill|skills)[\\/]/i;
const skillNamePattern = /[\\/]\.opencode[\\/](?:skill|skills)[\\/]+([^\\/]+)/i;
const commandPathPattern = /[\\/]\.opencode[\\/](command|commands)[\\/]/i;
const commandNamePattern =
  /[\\/]\.opencode[\\/](?:command|commands)[\\/]+([^\\/]+)/i;
const agentPathPattern = /[\\/]\.opencode[\\/](agent|agents)[\\/]/i;
const agentNamePattern = /[\\/]\.opencode[\\/](?:agent|agents)[\\/]+([^\\/]+)/i;
const opencodeConfigPattern = /(?:^|[\\/])opencode\.jsonc?\b/i;
const opencodePathPattern = /(?:^|[\\/])\.opencode[\\/]/i;
const openworkConfigPattern = /[\\/]\.opencode[\\/]openwork\.json\b/i;
const mutatingTools = new Set(["write", "edit", "apply_patch"]);

const extractSearchText = (value: unknown) => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return safeStringify(value);
};

const detectReloadReason = (value: unknown): ReloadReason | null => {
  const text = extractSearchText(value);
  if (!text) return null;
  if (openworkConfigPattern.test(text)) return null;
  if (skillPathPattern.test(text)) return "skills";
  if (commandPathPattern.test(text)) return "commands";
  if (agentPathPattern.test(text)) return "agents";
  if (opencodeConfigPattern.test(text)) return "config";
  if (opencodePathPattern.test(text)) return "config";
  return null;
};

const detectReloadTriggerFromText = (text: string): ReloadTrigger | null => {
  if (openworkConfigPattern.test(text)) {
    return null;
  }
  if (skillPathPattern.test(text)) {
    const match = text.match(skillNamePattern);
    return {
      type: "skill",
      name: match?.[1],
      action: "updated",
      path: match?.[0],
    };
  }

  if (commandPathPattern.test(text)) {
    const match = text.match(commandNamePattern);
    const raw = match?.[1];
    const name = raw ? raw.replace(/\.md$/i, "") : undefined;
    return {
      type: "command",
      name,
      action: "updated",
      path: match?.[0],
    };
  }

  if (agentPathPattern.test(text)) {
    const match = text.match(agentNamePattern);
    return {
      type: "agent",
      name: match?.[1],
      action: "updated",
      path: match?.[0],
    };
  }

  if (opencodeConfigPattern.test(text) || opencodePathPattern.test(text)) {
    return {
      type: "config",
      action: "updated",
    };
  }
  return null;
};

const detectReloadReasonDeep = (value: unknown): ReloadReason | null => {
  if (!value) return null;
  if (typeof value === "string" || typeof value === "number") {
    return detectReloadReason(value);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const reason = detectReloadReasonDeep(entry);
      if (reason) return reason;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      const reason = detectReloadReasonDeep(entry);
      if (reason) return reason;
    }
  }
  return null;
};

const detectReloadTriggerDeep = (value: unknown): ReloadTrigger | null => {
  if (!value) return null;
  if (typeof value === "string" || typeof value === "number") {
    return detectReloadTriggerFromText(String(value));
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const trigger = detectReloadTriggerDeep(entry);
      if (trigger) return trigger;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      const trigger = detectReloadTriggerDeep(entry);
      if (trigger) return trigger;
    }
  }
  return null;
};

export const detectReloadFromPart = (
  part: Part,
): { reason: ReloadReason; trigger?: ReloadTrigger } | null => {
  if (part.type !== "tool") return null;
  const record = part as Record<string, unknown>;
  const toolName = typeof record.tool === "string" ? record.tool : "";
  if (!mutatingTools.has(toolName)) return null;
  const state = (record.state ?? {}) as Record<string, unknown>;
  const reason =
    detectReloadReasonDeep(state.input) ||
    detectReloadReasonDeep(state.patch) ||
    detectReloadReasonDeep(state.diff);
  if (!reason) return null;
  const trigger =
    detectReloadTriggerDeep(state.input) ||
    detectReloadTriggerDeep(state.patch) ||
    detectReloadTriggerDeep(state.diff);
  return { reason, trigger: trigger ?? undefined };
};

const writtenTargetPatterns = [
  { type: "skill", name: /(?:^|[\\/])\.(?:opencode|claude)[\\/](?:skill|skills)[\\/]+([^\\/]+)/i },
  { type: "agent", name: /(?:^|[\\/])\.opencode[\\/](?:agent|agents)[\\/]+([^\\/]+)/i },
] as const;

const patchHeaderPattern = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

const stringField = (value: unknown, key: string): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field ? field : undefined;
};

/**
 * The files a completed call wrote. `write` and `edit` take one `filePath`;
 * `apply_patch` reports its files in metadata, and an engine that does not is
 * read from the patch's own file headers.
 */
const writtenPaths = (tool: string, state: ToolStateCompleted): string[] => {
  if (tool !== "apply_patch") {
    const filePath = stringField(state.input, "filePath");
    return filePath ? [filePath] : [];
  }
  const files = state.metadata.files;
  if (Array.isArray(files)) {
    return files.flatMap((file) =>
      [stringField(file, "filePath"), stringField(file, "movePath")].filter((path) => path !== undefined),
    );
  }
  const patchText = stringField(state.input, "patchText") ?? "";
  return [...patchText.matchAll(patchHeaderPattern)].map((match) => match[1].trim());
};

/**
 * Every distinct skill and agent a completed mutating tool call wrote; one
 * `apply_patch` can touch several. Only destination paths count, not paths a
 * file's content mentions. `detectReloadFromPart` also matches a call that is
 * still running, before the file is on disk, so a list refetched at that point
 * would miss the new entry.
 */
export const detectWrittenReloadTargets = (part: Part): ReloadTrigger[] => {
  if (part.type !== "tool" || part.state.status !== "completed") return [];
  if (!mutatingTools.has(part.tool)) return [];
  const seen = new Set<string>();
  const targets: ReloadTrigger[] = [];
  for (const path of writtenPaths(part.tool, part.state)) {
    for (const { type, name } of writtenTargetPatterns) {
      const match = path.match(name);
      if (!match) continue;
      const key = `${type}:${match[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ type, name: match[1], action: "updated", path });
    }
  }
  return targets;
};
