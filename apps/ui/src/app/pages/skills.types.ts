/** Types for the Skills page: bundles, notices and import results. */
import type { HubSkillCard } from "../types";
import type { HubSkillRepo } from "../types";
import type { SkillCard } from "../types";

export type InstallResult = { ok: boolean; message: string };

export type SkillBundleV1 = {
  schemaVersion: 1;
  type: "skill";
  name: string;
  content: string;
  description?: string;
  trigger?: string;
};

export type NoticeTone = "info" | "success" | "error";

export type SkillsNotice = { message: string; tone: NoticeTone };

export type SkillImportResult = { ok: boolean; skillName?: string; message?: string; cancelled?: boolean };

export type SkillsViewProps = {
  workspaceName: string;
  busy: boolean;
  canInstallSkillCreator: boolean;
  canUseDesktopTools: boolean;
  canImportLocalSkill: boolean;
  canUninstallSkill: boolean;
  canEditSkill: boolean;
  accessHint?: string | null;
  refreshSkills: (options?: { force?: boolean }) => void;
  refreshHubSkills: (options?: { force?: boolean }) => void;
  skills: SkillCard[];
  skillsStatus: string | null;
  skillsStatusTone: NoticeTone;
  hubSkills: HubSkillCard[];
  hubSkillsStatus: string | null;
  hubRepo: HubSkillRepo | null;
  hubRepos: HubSkillRepo[];
  importLocalSkill: () => Promise<SkillImportResult>;
  importSkillFile: () => Promise<SkillImportResult>;
  installSkillCreator: () => Promise<InstallResult>;
  installSkillFinder: () => Promise<InstallResult>;
  installHubSkill: (skill: HubSkillCard) => Promise<InstallResult>;
  setHubRepo: (repo: Partial<HubSkillRepo> | null) => void;
  addHubRepo: (repo: Partial<HubSkillRepo>) => void;
  removeHubRepo: (repo: Partial<HubSkillRepo>) => void;
  revealSkillsFolder: () => void;
  uninstallSkill: (name: string) => void;
  readSkill: (name: string) => Promise<{ name: string; path: string; content: string } | null>;
  saveSkill: (input: { name: string; content: string; description?: string }) => Promise<{ ok: boolean; message: string }>;
  openNewTask: () => void;
  setPrompt: (value: string) => void;
};
