import { invoke } from "@tauri-apps/api/core";

export type ExecResult = {
  ok: boolean;
  status: number;
  stdout: string;
  stderr: string;
};

export type ScheduledJobRun = {
  prompt?: string;
  command?: string;
  arguments?: string;
  files?: string[];
  agent?: string;
  model?: string;
  variant?: string;
  title?: string;
  share?: boolean;
  continue?: boolean;
  session?: string;
  runFormat?: string;
  attachUrl?: string;
  port?: number;
};

export type ScheduledJob = {
  scopeId?: string;
  timeoutSeconds?: number;
  invocation?: { command: string; args: string[] };
  slug: string;
  name: string;
  schedule: string;
  prompt?: string;
  attachUrl?: string;
  run?: ScheduledJobRun;
  source?: string;
  workdir?: string;
  createdAt: string;
  updatedAt?: string;
  lastRunAt?: string;
  lastRunExitCode?: number;
  lastRunError?: string;
  lastRunSource?: string;
  lastRunStatus?: string;
  needsDayReview?: boolean; // True for an AgentLab `daily`/`weekly` record saved before multi-day schedules worked (#3069)
};

export async function engineInstall(): Promise<ExecResult> {
  return invoke<ExecResult>("engine_install");
}

export async function opkgInstall(projectDir: string, pkg: string): Promise<ExecResult> {
  return invoke<ExecResult>("opkg_install", { projectDir, package: pkg });
}

export async function importSkill(
  projectDir: string,
  sourceDir: string,
  options?: { overwrite?: boolean },
): Promise<ExecResult> {
  return invoke<ExecResult>("import_skill", {
    projectDir,
    sourceDir,
    overwrite: options?.overwrite ?? false,
  });
}

export async function installSkillTemplate(
  projectDir: string,
  name: string,
  content: string,
  options?: { overwrite?: boolean },
): Promise<ExecResult> {
  return invoke<ExecResult>("install_skill_template", {
    projectDir,
    name,
    content,
    overwrite: options?.overwrite ?? false,
  });
}

export type LocalSkillCard = {
  name: string;
  path: string;
  description?: string;
  trigger?: string;
};

export type LocalSkillContent = {
  path: string;
  content: string;
};

export async function listLocalSkills(projectDir: string): Promise<LocalSkillCard[]> {
  return invoke<LocalSkillCard[]>("list_local_skills", { projectDir });
}

export async function readLocalSkill(projectDir: string, name: string): Promise<LocalSkillContent> {
  return invoke<LocalSkillContent>("read_local_skill", { projectDir, name });
}

export async function writeLocalSkill(projectDir: string, name: string, content: string): Promise<ExecResult> {
  return invoke<ExecResult>("write_local_skill", { projectDir, name, content });
}

export async function uninstallSkill(projectDir: string, name: string): Promise<ExecResult> {
  return invoke<ExecResult>("uninstall_skill", { projectDir, name });
}

export type SkillFromPathResult = {
  name: string;
  path: string;
  content: string;
};

/**
 * Read a skill's SKILL.md content from an arbitrary filesystem path.
 * Used to import local skills into a remote workspace via OpenWork server.
 */
export async function readSkillFromPath(skillPath: string): Promise<SkillFromPathResult> {
  return invoke<SkillFromPathResult>("read_skill_from_path", { skillPath });
}
