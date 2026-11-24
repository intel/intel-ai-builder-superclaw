import {
  type ProductProfileDescriptor,
  type ProductProfileId,
  type ProductProfileRuntimeStatus,
} from "@different-ai/openwork-contracts/capability";
import type { IntentClassifierClassificationMode } from "./intent-classifier-service.js";
import {
  completeProfileTransition,
  readLiveProfileDescriptor,
  readTargetMarker,
  validateProfileDirectory,
  type ProfileDeploymentLayout,
} from "./profile-deployment.js";
import { join } from "node:path";

type RuntimeOperation =
  | { readonly owner: "idle" }
  | { readonly owner: "upgrade" };

export class RuntimeOperationLock {
  private operation: RuntimeOperation = { owner: "idle" };

  current(): RuntimeOperation {
    return this.operation;
  }

  tryAcquireUpgrade(): (() => void) | null {
    if (this.operation.owner !== "idle") return null;
    this.operation = { owner: "upgrade" };
    return () => this.release("upgrade");
  }

  private release(owner: "upgrade"): void {
    if (this.operation.owner === owner) this.operation = { owner: "idle" };
  }
}

// `untilReady` is for startup, where an HDR the owner is still bringing up is waited for rather
// than refused. Status polling takes a single look.
export interface HybridDrProofOptions {
  readonly untilReady?: boolean;
}

export interface StartupProofOptions {
  // Startup's OpenCode warm-up; the proof's OpenCode and openwork-server checks wait for it.
  readonly openCodeSettled?: Promise<void>;
  readonly onStep?: (step: string) => void;
}

export interface RuntimeProfileControllerDependencies {
  readonly bootstrapTarget: ProductProfileId;
  validatePackagedProfile(target: ProductProfileId): ProductProfileDescriptor;
  readMarker(): ProductProfileId | null;
  readLiveDescriptor(): ProductProfileDescriptor | null;
  completeTransition(target: ProductProfileId): void;
  isOpenCodeHealthy(): Promise<boolean>;
  isOpenWorkConnected(): Promise<boolean>;
  intentClassifierMode(): Promise<IntentClassifierClassificationMode | null>;
  isHybridDrHealthy(options?: HybridDrProofOptions): Promise<boolean>;
  isHybridDrAbsent(): Promise<boolean>;
  // True when Sandbox Manager owns HDR and probes it again in the pass that accepts the ready evidence.
  readonly hybridDrRecheckedByOwner?: boolean;
}

function requiredIntentClassifierMode(descriptor: ProductProfileDescriptor): IntentClassifierClassificationMode {
  return descriptor.feature_flags.intent_classifier ? "enabled" : "bypass";
}

export class RuntimeProfileController {
  constructor(private readonly dependencies: RuntimeProfileControllerDependencies) {}

  async getStatus(): Promise<ProductProfileRuntimeStatus> {
    let target = this.dependencies.bootstrapTarget;
    let profile: ProductProfileId | null = null;
    try {
      const marker = this.dependencies.readMarker();
      const live = this.dependencies.readLiveDescriptor();
      profile = live?.profile ?? null;
      target = marker ?? profile ?? this.dependencies.bootstrapTarget;
      if (marker === null && live && await this.hasFreshProof(live.profile, live)) {
        return { contract_version: 1, state: "ready", profile: live.profile };
      }
    } catch {
      return {
        contract_version: 1,
        state: "failed",
        profile,
        target_profile: target,
        error: { code: "runtime_profile_observation_failed", message: "Runtime Profile observation failed" },
      };
    }
    return { contract_version: 1, state: "applying", profile, target_profile: target };
  }

  async completeStartup(target: ProductProfileId, options: StartupProofOptions = {}): Promise<void> {
    const step = options.onStep ?? ((): void => undefined);
    const descriptor = this.dependencies.validatePackagedProfile(target);
    step("packaged_profile");
    if (!(await this.hasFreshStartupProof(target, descriptor, options.openCodeSettled, step))) {
      throw new Error("Fresh startup Runtime Profile proof failed");
    }
    this.dependencies.completeTransition(target);
    step("transition_complete");
  }

  private async hasFreshProof(
    target: ProductProfileId,
    descriptor: ProductProfileDescriptor,
    hybridDrOptions?: HybridDrProofOptions,
  ): Promise<boolean> {
    const live = this.dependencies.readLiveDescriptor();
    if (!live || live.profile !== target) return false;
    if (!(await this.dependencies.isOpenCodeHealthy())) return false;
    if (!(await this.dependencies.isOpenWorkConnected())) return false;
    if ((await this.dependencies.intentClassifierMode()) !== requiredIntentClassifierMode(descriptor)) return false;
    return this.hasHybridDrProof(descriptor, hybridDrOptions);
  }

  // The checks of `hasFreshProof`, reordered: only a Sandbox Manager owned HDR, the slow check, is
  // proved while OpenCode's warm-up settles, because Sandbox Manager probes it again in the pass that
  // accepts the ready evidence. Any other HDR proof, and the classifier, which Sandbox Manager never
  // probes, run after the warm-up. A request that reaches OpenCode during its lazy init can outlast
  // the 2 s timeout of the OpenCode and openwork-server checks, so those wait for the warm-up too.
  // The live tree is validated again by `completeTransition`.
  private async hasFreshStartupProof(
    target: ProductProfileId,
    descriptor: ProductProfileDescriptor,
    openCodeSettled: Promise<void> | undefined,
    step: (name: string) => void,
  ): Promise<boolean> {
    const live = this.dependencies.readLiveDescriptor();
    if (!live || live.profile !== target) return false;
    step("live_descriptor");
    const hybridDrEarly = descriptor.feature_flags.hybrid_deep_research_agent
      && this.dependencies.hybridDrRecheckedByOwner === true;
    if (hybridDrEarly) {
      if (!(await this.hasHybridDrProof(descriptor, { untilReady: true }))) return false;
      step("hybrid_dr");
    }
    await openCodeSettled;
    if (!(await this.dependencies.isOpenCodeHealthy())) return false;
    step("opencode");
    if (!(await this.dependencies.isOpenWorkConnected())) return false;
    step("openwork");
    if (!hybridDrEarly) {
      if (!(await this.hasHybridDrProof(descriptor, { untilReady: true }))) return false;
      step("hybrid_dr");
    }
    if ((await this.dependencies.intentClassifierMode()) !== requiredIntentClassifierMode(descriptor)) return false;
    step("intent_classifier");
    return true;
  }

  private hasHybridDrProof(descriptor: ProductProfileDescriptor, options?: HybridDrProofOptions): Promise<boolean> {
    return descriptor.feature_flags.hybrid_deep_research_agent
      ? this.dependencies.isHybridDrHealthy(options)
      : this.dependencies.isHybridDrAbsent();
  }
}

export async function readIntentClassifierMode(input: {
  readonly status: () => "absent" | "running" | "stopped";
  readonly healthUrl: string;
}): Promise<IntentClassifierClassificationMode | null> {
  const status = input.status();
  if (status === "absent") return "bypass";
  if (status !== "running") return null;
  try {
    // egress-surface: supervisor_health_intent_classifier
    const response = await fetch(input.healthUrl, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return null;
    const body = await response.json() as { classification_mode?: unknown };
    return body.classification_mode === "enabled" || body.classification_mode === "bypass"
      ? body.classification_mode
      : null;
  } catch {
    return null;
  }
}

async function fetchHealthy(url: string, headers?: Record<string, string>): Promise<boolean> {
  try {
    // egress-surface: supervisor_health_opencode
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

export function createRuntimeProfileController(input: {
  readonly bootstrapTarget: ProductProfileId;
  readonly productProfileSourceRoot: string;
  readonly profileLayout: ProfileDeploymentLayout;
  readonly opencodeHealthUrl: string;
  readonly opencodeHeaders: () => Record<string, string>;
  readonly isOpenWorkConnected: () => Promise<boolean>;
  readonly intentClassifierStatus: () => "absent" | "running" | "stopped";
  readonly intentClassifierHealthUrl: string;
  readonly isHybridDrRunning: () => boolean;
  readonly isHybridDrAbsent: () => boolean;
  readonly hybridDrHealthUrl: string;
  readonly hybridDrHealthHeaders?: () => Record<string, string>;
  readonly observeExternalHybridDr?: (options?: HybridDrProofOptions) => Promise<boolean>;
}): RuntimeProfileController {
  return new RuntimeProfileController({
    bootstrapTarget: input.bootstrapTarget,
    validatePackagedProfile: (target) => validateProfileDirectory(join(input.productProfileSourceRoot, target), target),
    readMarker: () => readTargetMarker(input.profileLayout.marker),
    readLiveDescriptor: () => readLiveProfileDescriptor(input.profileLayout.live),
    completeTransition: (target) => completeProfileTransition(input.profileLayout, target),
    isOpenCodeHealthy: () => fetchHealthy(input.opencodeHealthUrl, input.opencodeHeaders()),
    isOpenWorkConnected: input.isOpenWorkConnected,
    intentClassifierMode: () => readIntentClassifierMode({
      status: input.intentClassifierStatus,
      healthUrl: input.intentClassifierHealthUrl,
    }),
    isHybridDrHealthy: input.observeExternalHybridDr ?? (async () => input.isHybridDrRunning() && await fetchHealthy(
      input.hybridDrHealthUrl,
      input.hybridDrHealthHeaders?.(),
    )),
    isHybridDrAbsent: async () => input.isHybridDrAbsent(),
    hybridDrRecheckedByOwner: input.observeExternalHybridDr !== undefined,
  });
}
