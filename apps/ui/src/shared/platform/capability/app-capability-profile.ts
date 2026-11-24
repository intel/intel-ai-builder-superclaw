/**
 * G1 — pure App-facing capability Profile adapter.
 *
 * Wraps the single shared `AppCapabilityProfileSchema` (never a hand-rolled
 * copy) and exposes fail-closed selectors. Selectors only ever look at
 * `lifecycle_state` + `descriptor.feature_flags`; they never branch on
 * `product_profile_id`, `primary_bundle`, model IDs, or backend — those are
 * display-only and must not gate features here.
 */
import {
  AppCapabilityProfileSchema,
  type AppCapabilityProfile,
  type ActiveAppCapabilityProfile,
} from "@different-ai/openwork-contracts/capability";

/** Thrown by `parseAppCapabilityProfile` when the payload fails schema validation. */
export class AppCapabilityProfileParseError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "AppCapabilityProfileParseError";
  }
}

export function parseAppCapabilityProfile(value: unknown): AppCapabilityProfile {
  const result = AppCapabilityProfileSchema.safeParse(value);
  if (!result.success) {
    throw new AppCapabilityProfileParseError("Invalid AppCapabilityProfile payload.", result.error);
  }
  return result.data;
}

function isActive(profile: AppCapabilityProfile): profile is ActiveAppCapabilityProfile {
  return profile.lifecycle_state === "active";
}

type FeatureFlagKey = keyof ActiveAppCapabilityProfile["descriptor"]["feature_flags"];

/**
 * Agent names whose UI availability is gated by a specific descriptor feature
 * flag. Agents absent from this map are treated as base agents: always available
 * for any active profile (e.g. superclaw-default, local-file-agent, websearch-agent).
 */
const FEATURE_GATED_AGENTS: Partial<Record<string, FeatureFlagKey>> = {
  "email-agent": "email_agent",
  "hybrid-deep-research": "hybrid_deep_research_agent",
  build: "hybrid_coding_agent",
};

export function isAgentAllowed(profile: AppCapabilityProfile, agentName: string): boolean {
  if (!isActive(profile)) return false;
  const flagKey = FEATURE_GATED_AGENTS[agentName];
  // `=== true` because the descriptor now carries at least one optional flag
  // (`voice_input`), so an indexed lookup is `boolean | undefined`. A flag the
  // packaged Profile never heard of must read as "off" — fail closed.
  if (flagKey !== undefined) return profile.descriptor.feature_flags[flagKey] === true;
  return true;
}

/** Always true for active profiles — runtime skill gating is no longer in the descriptor. */
export function isRuntimeSkillAllowed(profile: AppCapabilityProfile, _skillName: string): boolean {
  return isActive(profile);
}

export function isIntentClassifierEnabled(profile: AppCapabilityProfile): boolean {
  return isActive(profile) && profile.descriptor.feature_flags.intent_classifier;
}

/** Always true for active profiles — MCP availability is not separately gated in the descriptor. */
export function isMcpEnabled(profile: AppCapabilityProfile): boolean {
  return isActive(profile);
}

export function isMcpToolPermissionsEnabled(profile: AppCapabilityProfile): boolean {
  return isActive(profile) && profile.descriptor.feature_flags.mcp_tool_permissions === true;
}

/** Always true for active profiles — scheduler availability is not separately gated in the descriptor. */
export function isSchedulerEnabled(profile: AppCapabilityProfile): boolean {
  return isActive(profile);
}

export function isHybridDeepResearchEnabled(profile: AppCapabilityProfile): boolean {
  return isActive(profile) && profile.descriptor.feature_flags.hybrid_deep_research_agent;
}

export function isSkillsUiEnabled(profile: AppCapabilityProfile): boolean {
  return isActive(profile) && profile.descriptor.feature_flags.skills_ui;
}

export function isAgentAuthoringEnabled(profile: AppCapabilityProfile): boolean {
  return isActive(profile) && profile.descriptor.feature_flags.agent_authoring;
}

/**
 * Whether the LOCAL (on-device) voice-input option may be offered. Cloud voice
 * input is not gated — it predates the Profile and exists everywhere.
 *
 * `voice_input` is optional in the descriptor so Profiles packaged before the
 * flag existed still validate, which makes the `=== true` explicit: `undefined`
 * must read as "off", never as "on".
 */
export function isVoiceInputEnabled(profile: AppCapabilityProfile): boolean {
  return isActive(profile) && profile.descriptor.feature_flags.voice_input === true;
}

/** Adding a local-command (stdio) MCP server. An absent flag reads as "off". */
export function isMcpLocalCommandEnabled(profile: AppCapabilityProfile): boolean {
  return isActive(profile) && profile.descriptor.feature_flags.mcp_local_command === true;
}

/** Running a local-command MCP server on this computer, outside the sandbox. An absent flag reads as "off". */
export function isHostMcpExecutionEnabled(profile: AppCapabilityProfile): boolean {
  return isActive(profile) && profile.descriptor.feature_flags.mcp_host_execution === true;
}

/** Pointing a sandboxed browser MCP at the host's visible SuperClaw Edge. An absent flag reads as "off". */
export function isHostBrowserEnabled(profile: AppCapabilityProfile): boolean {
  return isActive(profile) && profile.descriptor.feature_flags.host_browser === true;
}
