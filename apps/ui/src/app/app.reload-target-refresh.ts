/**
 * Refreshes the list that a finished tool call wrote into, so a skill or agent
 * created from chat appears without a manual refresh.
 */
import type { ReloadTrigger } from "~/shared/types/opencode-connection";

type ReloadTargetRefreshDeps = {
  refreshWrittenSkill: (name?: string) => void;
  bumpAgentsVersion: () => void;
};

export const refreshWrittenReloadTarget = (
  trigger: ReloadTrigger,
  deps: ReloadTargetRefreshDeps,
) => {
  if (trigger.type === "skill") {
    deps.refreshWrittenSkill(trigger.name);
  } else if (trigger.type === "agent") {
    deps.bumpAgentsVersion();
  }
};
