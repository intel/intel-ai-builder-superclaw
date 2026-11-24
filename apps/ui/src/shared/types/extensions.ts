export type SkillCard = {
  name: string;
  path: string;
  description?: string;
  trigger?: string;
};

export type HubSkillRepo = {
  owner: string;
  repo: string;
  ref: string;
};

export type HubSkillCard = {
  name: string;
  description?: string;
  trigger?: string;
  source: HubSkillRepo & {
    path: string;
  };
};

export type PluginInstallStep = {
  title: string;
  description: string;
  command?: string;
  url?: string;
  path?: string;
  note?: string;
};

export type SuggestedPlugin = {
  name: string;
  packageName: string;
  description: string;
  tags: string[];
  aliases?: string[];
  installMode?: "simple" | "guided";
  steps?: PluginInstallStep[];
};

export type PluginScope = "project" | "global";

export type SharedSkillItem = {
  name: string;
  description?: string;
  content: string;
  trigger?: string;
};

export type SkillsSetBundleV1 = {
  schemaVersion: 1;
  type: "skills-set";
  name: string;
  description: string;
  skills: SharedSkillItem[];
  sourceWorkspace?: {
    id?: string;
    name?: string;
  };
};
