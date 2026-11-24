/**
 * Thin adapter over the mainline G1 (`useAppCapability` + standalone selectors)
 * that exposes the ergonomic, fail-closed signatures our task1/2/3 gating code
 * uses: `useCapabilityGate()` returns bound selectors (no need to thread the
 * profile through every call site).
 *
 * Why an adapter (not calling useAppCapability directly everywhere):
 *  - Mainline `useAppCapability()` THROWS when no provider is mounted. Our
 *    gating must be fail-open (passthrough to current behavior) when capability
 *    gating is off — it's a product-behavior boundary, not a security gate.
 *  - Mainline selectors take `profile` as first arg; our call sites want
 *    `isAgentAllowed(name)` / `hdrEnabled()` bound to the active profile.
 *
 * All selectors fail-closed: they only return "allowed/enabled" for a validated
 * ACTIVE profile; loading / recovery / transport_error / no-provider → false.
 */
import { getOwner, useContext } from "solid-js";
import type {
  ProductProfileId,
  ActiveAppCapabilityProfile,
} from "@different-ai/openwork-contracts/capability";
import {
  AppCapabilityContext,
  type AppCapabilityContextValue,
} from "./app-capability-provider";
import { uiLogWarn } from "~/shared/platform/log/log";
import { isTauriRuntime } from "~/shared/platform/runtime-env";
import {
  isAgentAllowed as isAgentAllowedFor,
  isAgentAuthoringEnabled as isAgentAuthoringEnabledFor,
  isHostBrowserEnabled as isHostBrowserEnabledFor,
  isHostMcpExecutionEnabled as isHostMcpExecutionEnabledFor,
  isHybridDeepResearchEnabled as isHdrEnabledFor,
  isIntentClassifierEnabled as isIcEnabledFor,
  isMcpEnabled as isMcpEnabledFor,
  isMcpLocalCommandEnabled as isMcpLocalCommandEnabledFor,
  isMcpToolPermissionsEnabled as isMcpToolPermissionsEnabledFor,
  isSchedulerEnabled as isSchedulerEnabledFor,
  isSkillsUiEnabled as isSkillsUiEnabledFor,
  isVoiceInputEnabled as isVoiceInputEnabledFor,
} from "./app-capability-profile";

export type CapabilityGate = {
  /** True only for a validated active Profile. */
  isActive: () => boolean;
  /** True while the first profile is still resolving (503/loading). */
  isLoading: () => boolean;
  /**
   * The validated active Profile, or null unless active. Exposed for pure
   * policies (e.g. session-route-policy) that need the raw primary_bundle
   * signals; feature booleans should still use the bound selectors above.
   */
  activeProfile: () => ActiveAppCapabilityProfile | null;
  /** Active product profile id, or null unless active. */
  productProfileId: () => ProductProfileId | null;
  /** Built-in product agent visible for the active profile. Fail-closed. */
  isAgentAllowed: (agentName: string) => boolean;
  hdrEnabled: () => boolean;
  mcpEnabled: () => boolean;
  /** Whether an MCP server that runs a local command may be added. */
  mcpLocalCommandEnabled: () => boolean;
  /** Whether a local-command MCP server may run on this computer, outside the sandbox. */
  mcpHostExecutionEnabled: () => boolean;
  /** Whether a sandboxed browser MCP may drive the host's visible SuperClaw Edge. */
  hostBrowserEnabled: () => boolean;
  mcpToolPermissionsEnabled: () => boolean;
  schedulerEnabled: () => boolean;
  intentClassifierEnabled: () => boolean;
  skillsUiEnabled: () => boolean;
  agentAuthoringEnabled: () => boolean;
  /**
   * Whether the on-device voice-input option may be offered. Cloud voice input
   * is always available and is NOT gated by this.
   */
  voiceInputEnabled: () => boolean;
  /**
   * Hide the Routing balance control and force cloud routing. True only for the
   * active Lite Product Profile, which has no local model. Fail-closed.
   */
  forceCloudRouting: () => boolean;
  refresh: () => Promise<void>;
};

/** Fail-open gate used when no provider is mounted / gating disabled. */
const PASSTHROUGH_GATE: CapabilityGate = {
  isActive: () => false,
  isLoading: () => false,
  activeProfile: () => null,
  productProfileId: () => null,
  isAgentAllowed: () => false,
  hdrEnabled: () => false,
  mcpEnabled: () => false,
  mcpLocalCommandEnabled: () => false,
  mcpHostExecutionEnabled: () => false,
  hostBrowserEnabled: () => false,
  mcpToolPermissionsEnabled: () => false,
  schedulerEnabled: () => false,
  intentClassifierEnabled: () => false,
  skillsUiEnabled: () => false,
  agentAuthoringEnabled: () => false,
  voiceInputEnabled: () => false,
  forceCloudRouting: () => false,
  refresh: async () => {},
};

function buildGate(ctx: AppCapabilityContextValue): CapabilityGate {
  const active = () => ctx.activeProfile();
  return {
    isActive: () => active() !== null,
    isLoading: () => {
      const status = ctx.state().status;
      return status === "loading" || status === "initializing";
    },
    activeProfile: () => active(),
    productProfileId: () => active()?.product_profile_id ?? null,
    isAgentAllowed: (agentName) => {
      const p = active();
      return p ? isAgentAllowedFor(p, agentName) : false;
    },
    hdrEnabled: () => {
      const p = active();
      return p ? isHdrEnabledFor(p) : false;
    },
    mcpEnabled: () => {
      const p = active();
      return p ? isMcpEnabledFor(p) : false;
    },
    mcpLocalCommandEnabled: () => {
      const p = active();
      return p ? isMcpLocalCommandEnabledFor(p) : false;
    },
    mcpHostExecutionEnabled: () => {
      const p = active();
      return p ? isHostMcpExecutionEnabledFor(p) : false;
    },
    hostBrowserEnabled: () => {
      const p = active();
      return p ? isHostBrowserEnabledFor(p) : false;
    },
    mcpToolPermissionsEnabled: () => {
      const p = active();
      return p ? isMcpToolPermissionsEnabledFor(p) : false;
    },
    schedulerEnabled: () => {
      const p = active();
      return p ? isSchedulerEnabledFor(p) : false;
    },
    intentClassifierEnabled: () => {
      const p = active();
      return p ? isIcEnabledFor(p) : false;
    },
    skillsUiEnabled: () => {
      const p = active();
      return p ? isSkillsUiEnabledFor(p) : false;
    },
    agentAuthoringEnabled: () => {
      const p = active();
      return p ? isAgentAuthoringEnabledFor(p) : false;
    },
    voiceInputEnabled: () => {
      const p = active();
      return p ? isVoiceInputEnabledFor(p) : false;
    },
    forceCloudRouting: () => {
      const p = active();
      if (!p) return false;
      return p.product_profile_id === "lite";
    },
    refresh: ctx.refresh,
  };
}

/**
 * Whether resolving the passthrough gate is worth reporting.
 *
 * In the installed desktop app it is a bug: the caller's Solid owner landed
 * outside `AppCapabilityProfileProvider`, so gating is off and every selector
 * answers `false` — quick-agent buttons unfiltered, HDR reported absent.
 * Nothing surfaces that today, and on a `minimal` box there is nothing to
 * filter anyway, so it is indistinguishable from a healthy boot
 * (`entry.tsx:23` says as much). Refactors that re-parent components can
 * therefore disable gating and still pass review.
 *
 * Silent outside the Tauri runtime: web deployments never mount the capability
 * providers (`entry.tsx` returns the bare runtime tree), so passthrough there
 * is correct, and warning would be noise that teaches people to ignore it.
 *
 * Silent for an already-reported component, so a re-rendering component cannot
 * bury the rest of the log.
 */
export function shouldWarnPassthrough(input: {
  isDev: boolean;
  isTauri: boolean;
  component: string;
  alreadyWarned: ReadonlySet<string>;
}): boolean {
  if (!input.isDev || !input.isTauri) return false;
  return !input.alreadyWarned.has(input.component);
}

/** Components already reported, for the warn-once rule above. */
const warnedOwners = new Set<string>();

/**
 * Solid's DEV build names a component's computation after its function
 * (`devComponent`: `c.name = Comp.name`), which is the only handle we have on
 * *which* component resolved the wrong owner. `Owner` does not declare `name`
 * in the public types, and production builds never set it.
 */
function owningComponentName(): string {
  const owner = getOwner() as (ReturnType<typeof getOwner> & { name?: string }) | null;
  return owner?.name || "an unnamed component";
}

function warnPassthroughGate(): void {
  const component = owningComponentName();
  const shouldWarn = shouldWarnPassthrough({
    isDev: import.meta.env.DEV,
    isTauri: isTauriRuntime(),
    component,
    alreadyWarned: warnedOwners,
  });
  if (!shouldWarn) return;
  warnedOwners.add(component);
  uiLogWarn(
    "capability.gate_passthrough",
    `Capability gating is OFF for ${component}: it called useCapabilityGate() outside AppCapabilityProfileProvider, so every capability selector returns false. Check where the component is rendered, not where it is declared — a pre-created JSX value captures the owner of its declaration site.`,
    { component },
  );
}

/**
 * Fail-open capability gate. Safe to call outside a provider (returns the
 * passthrough gate) — gating is a product-behavior boundary, not a hard
 * dependency, so missing gating must never crash or hide surfaces. It warns in
 * dev rather than failing, for the reasons in `warnPassthroughGate`.
 */
export function useCapabilityGate(): CapabilityGate {
  const ctx = useContext(AppCapabilityContext);
  if (!ctx) {
    warnPassthroughGate();
    return PASSTHROUGH_GATE;
  }
  return buildGate(ctx);
}
