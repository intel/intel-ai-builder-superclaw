import type { Plugin } from "@opencode-ai/plugin";

// Compatibility fix for config decoding/merging that places known permission
// fields before the catch-all. OpenCode uses the LAST matching rule. Preserve
// every configured action and scoped pattern; put the default deny first.
export const SuperClawPermissionPrecedence: Plugin = async () => ({
  config: async (config) => {
    const agent = config.agent?.["superclaw-default"];
    const permission = agent?.permission;
    if (!permission || typeof permission !== "object" || permission["*"] !== "deny") return;
    agent.permission = {
      "*": "deny",
      ...Object.fromEntries(Object.entries(permission).filter(([key]) => key !== "*")),
    };
  },
});
