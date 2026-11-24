import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { readJsoncFile } from "./jsonc.js";
import { listMcp } from "./mcp/mcp.js";
import { exists } from "./utils.js";

type AgentCatalog = {
  tools: Array<{ name: string; description?: string }>;
  skills: Array<{ name: string; description?: string; source: "workspace-user" | "builtin" }>;
  mcpServers: Array<{ name: string; source: "config.project" | "config.global" | "config.remote" }>;
  protectedFilePipelineAvailable: boolean;
};

type PermissionMap = Record<string, unknown>;

// These tools are excluded from the agent-creation catalog for one of two reasons:
//
// (a) Internal pipeline tools — only make sense when dispatched through a
//     specific built-in pipeline (protected-file PII masking, local sensitive
//     reads, messaging-bridge identities). Exposing them as generic user-agent
//     permissions would bypass the guarded handoff or grant an unusable tool.
//
// (b) Coordinator-only planning tools (todowrite, todoread) — in the shipped
//     design, ONLY coordinator agents (superclaw-default, local-deep-research)
//     receive these tools via an explicit permission grant. Every specialist
//     agent (websearch-agent, local-file-agent, email-agent, etc.) blocks them
//     via `"*": deny`. User-created agents are specialist agents; giving them
//     todowrite creates a planning-loop trap: when stuck, the model substitutes
//     todowrite calls for the real (denied) tools and loops until the step
//     budget is exhausted. Power users who genuinely need planning can add
//     these back via the agent markdown edit modal.
//
// (c) Dead / superseded web-search keys — "websearch" is OpenCode's built-in
//     EXA search, explicitly denied by the shipped superclaw-default in favour
//     of the Tavily-backed sc_search_web (which has a per-session budget guard).
//     "web-search" (hyphenated) is a phantom permission key with no backing
//     tool file; it was a copy-paste error from the capability-manifest layer.
//
// (d) Hybrid DR sidecar tool — hybrid_dr_post_polish_processor is the
//     implementation tool owned by the hybrid-deep-research agent, not a
//     general-purpose user-selectable web retrieval tool. Expose the agent, not
//     the sidecar implementation detail.
//
// (e) local_dr reader/query implementation tools — these are intentionally
//     hidden from creator UX policy. User-facing file intelligence is exposed
//     via curated file/category capabilities instead of direct local_dr tool
//     toggles.
//
// Excluding here means these names never reach `selectedTools` in the create
// UI, so the generated markdown falls through to the `"*": deny` catch-all.
const INTERNAL_PIPELINE_TOOL_NAMES = new Set([
  "confirm_file_protection",
  "run_protected_file_pipeline",
  "local_sensitive_read",
  "review_masked_entities", // approval key the protected-file pipeline asks for; no tool backs it
  "restore_agent_response",
  "opencode_router_send",
  "opencode_router_status",
  "todowrite",
  "todoread",
  "websearch",    // OpenCode built-in EXA search — shipped config denies it
  "web-search",   // phantom key; no backing tool file
  "hybrid_dr_post_polish_processor",
  "local_dr_query_table",
  "local_dr_read_csv_xlsx",
  "local_dr_read_docx",
  "local_dr_read_pptx",
]);

// Skills excluded from the catalog entirely. Parallel to INTERNAL_PIPELINE_TOOL_NAMES.
// llmrouter-bench is an internal LLMRouter benchmark orchestration skill;
// superclaw-default explicitly denies it. It must not appear in user-created agents.
const INTERNAL_SKILL_NAMES = new Set([
  "llmrouter-bench",
]);

function parseSkillMeta(folderName: string, content: string): { name: string; description?: string } {
  try {
    const { data } = parseFrontmatter(content);
    const resolvedName = typeof data.name === "string" && data.name.trim().length > 0
      ? data.name.trim()
      : folderName;
    const description = typeof data.description === "string" && data.description.trim().length > 0
      ? data.description.trim()
      : undefined;
    return { name: resolvedName, description };
  } catch {
    // Best-effort parsing: fall back to folder name.
  }
  return { name: folderName };
}

function addExplicitPermissionToolNames(permission: PermissionMap, tools: Set<string>): void {
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value !== "string") continue;
    if (value === "deny") continue;
    if (key === "*") continue;
    if (key === "task" || key === "skill" || key === "external_directory") continue;
    if (key.includes("*")) continue;
    tools.add(key);
  }
}

async function listSkillItems(
  skillsDir: string,
  source: "workspace-user" | "builtin",
): Promise<Array<{ name: string; description?: string; source: "workspace-user" | "builtin" }>> {
  if (!(await exists(skillsDir))) return [];

  const entries = await readdir(skillsDir, { withFileTypes: true });
  const byName = new Map<string, { name: string; description?: string; source: "workspace-user" | "builtin" }>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const directSkillPath = join(skillsDir, entry.name, "SKILL.md");
    if (await exists(directSkillPath)) {
      let content: string;
      try {
        content = await readFile(directSkillPath, "utf8");
      } catch {
        continue;
      }
      const item = { ...parseSkillMeta(entry.name, content), source };
      const existing = byName.get(item.name);
      if (!existing || (!existing.description && item.description)) {
        byName.set(item.name, item);
      }
      continue;
    }

    const domainDir = join(skillsDir, entry.name);
    const nested = await readdir(domainDir, { withFileTypes: true }).catch(() => []);
    for (const sub of nested) {
      if (!sub.isDirectory()) continue;
      const nestedSkillPath = join(domainDir, sub.name, "SKILL.md");
      if (!(await exists(nestedSkillPath))) continue;
      let content: string;
      try {
        content = await readFile(nestedSkillPath, "utf8");
      } catch {
        continue;
      }
      const item = { ...parseSkillMeta(sub.name, content), source };
      const existing = byName.get(item.name);
      if (!existing || (!existing.description && item.description)) {
        byName.set(item.name, item);
      }
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function extractToolDescription(content: string): string | undefined {
  const scoped = content.match(/export\s+default\s+tool\s*\(\s*\{([\s\S]*?)\}\s*\)/);
  const target = scoped?.[1] ?? content;
  const m = target.match(/description\s*:\s*(["'`])([\s\S]*?)\1/);
  if (!m?.[2]) return undefined;
  const normalized = m[2].replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

async function listToolItems(toolsDir: string): Promise<Array<{ name: string; description?: string }>> {
  if (!(await exists(toolsDir))) return [];

  const entries = await readdir(toolsDir, { withFileTypes: true });
  const byName = new Map<string, { name: string; description?: string }>();

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".js")) continue;

    const absolute = join(toolsDir, entry.name);
    let content: string;
    try {
      content = await readFile(absolute, "utf8");
    } catch {
      continue;
    }
    if (!/export\s+default\s+tool\s*\(/.test(content)) continue;
    const item = {
      name: entry.name.replace(/\.(ts|js)$/i, ""),
      description: extractToolDescription(content),
    };
    const existing = byName.get(item.name);
    if (!existing || (!existing.description && item.description)) {
      byName.set(item.name, item);
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

async function hasProtectedFilePipeline(configRoot: string): Promise<boolean> {
  const toolNames = new Set((await listToolItems(join(configRoot, "tools"))).map((item) => item.name));
  if (
    !toolNames.has("confirm_file_protection") ||
    !toolNames.has("run_protected_file_pipeline") ||
    !(await exists(join(configRoot, "plugins", "08_protected_pipeline_confirm_guard.ts")))
  ) {
    return false;
  }

  const { data } = await readJsoncFile<Record<string, unknown>>(join(configRoot, "opencode.jsonc"), {});
  const agents = asRecord(data.agent);
  const protectedAgent = asRecord(agents?.["protected-file-agent"]);
  const protectedPermissions = asRecord(protectedAgent?.permission);
  const protectedTaskPermissions = asRecord(protectedPermissions?.task);
  const localAgent = asRecord(agents?.["local-file-agent"]);

  return (
    protectedAgent?.mode === "subagent" &&
    protectedAgent.disable !== true &&
    protectedPermissions?.run_protected_file_pipeline === "allow" &&
    protectedTaskPermissions?.build === "allow" &&
    localAgent?.mode === "subagent" &&
    localAgent.disable !== true
  );
}

async function addPermissionBasedTools(opencodeJsoncPath: string, tools: Set<string>): Promise<void> {
  if (!(await exists(opencodeJsoncPath))) return;

  const { data } = await readJsoncFile<Record<string, unknown>>(opencodeJsoncPath, {});
  const agent = data.agent;
  if (!agent || typeof agent !== "object") return;

  for (const definition of Object.values(agent as Record<string, unknown>)) {
    if (!definition || typeof definition !== "object") continue;
    const permission = (definition as Record<string, unknown>).permission;
    if (!permission || typeof permission !== "object") continue;
    addExplicitPermissionToolNames(permission as PermissionMap, tools);
  }
}

function candidateOpencodeRoots(workspaceRoot: string): string[] {
  return [
    join(workspaceRoot, "sandbox", "agent_config", "profiles", "pro"),
    join(workspaceRoot, "superclaw-config", ".opencode"),
    join(workspaceRoot, ".opencode"),
  ];
}

function candidateEnvOpencodeRoots(): string[] {
  const roots = new Set<string>();
  // OPENCODE_CONFIG_DIR is the live config dir when the runtime has one. On the Windows-native
  // backend openwork-server has none; the broker instead names the published Profile generation as
  // OPENWORK_OPENCODE_CONFIG_SOURCE_DIR, read-only to this process (#2985).
  for (const name of ["OPENCODE_CONFIG_DIR", "OPENWORK_OPENCODE_CONFIG_SOURCE_DIR"]) {
    const fromEnv = process.env[name]?.trim();
    if (fromEnv) {
      roots.add(resolve(fromEnv));
    }
  }
  return [...roots];
}

async function findWorkspaceRoots(workspaceRoot: string): Promise<string[]> {
  const roots: string[] = [];
  let current = resolve(workspaceRoot);

  while (true) {
    roots.push(current);
    const gitPath = join(current, ".git");
    if (await exists(gitPath)) break;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }

  return roots;
}

export async function listAgentToolSkillCatalog(workspaceRoot: string): Promise<AgentCatalog> {
  const tools = new Map<string, { name: string; description?: string }>();
  const skills = new Map<string, { name: string; description?: string; source: "workspace-user" | "builtin" }>();
  const mcpServers = new Map<string, { name: string; source: "config.project" | "config.global" | "config.remote" }>();
  const normalizedWorkspaceRoot = resolve(workspaceRoot);

  const addToolItem = (item: { name: string; description?: string }) => {
    if (INTERNAL_PIPELINE_TOOL_NAMES.has(item.name)) return;
    const existing = tools.get(item.name);
    if (!existing || (!existing.description && item.description)) {
      tools.set(item.name, item);
    }
  };

  const addSkillItem = (item: { name: string; description?: string; source: "workspace-user" | "builtin" }) => {
    if (INTERNAL_SKILL_NAMES.has(item.name)) return;
    const existing = skills.get(item.name);
    if (!existing || (existing.source !== "workspace-user" && item.source === "workspace-user") || (!existing.description && item.description)) {
      skills.set(item.name, item);
    }
  };

  const workspaceRoots = await findWorkspaceRoots(normalizedWorkspaceRoot);
  const activeProfileRoot =
    process.env.OPENWORK_OPENCODE_CONFIG_SOURCE_DIR?.trim() ||
    process.env.OPENCODE_CONFIG_DIR?.trim();
  let protectedFilePipelineAvailable = false;
  if (activeProfileRoot) {
    protectedFilePipelineAvailable = await hasProtectedFilePipeline(resolve(activeProfileRoot));
  } else {
    for (const workspaceCandidate of workspaceRoots) {
      const profileRoot = join(workspaceCandidate, "sandbox", "agent_config", "profiles", "pro");
      if (!(await exists(profileRoot))) continue;
      protectedFilePipelineAvailable = await hasProtectedFilePipeline(profileRoot);
      break;
    }
  }

  for (const workspaceCandidate of workspaceRoots) {
    for (const root of candidateOpencodeRoots(workspaceCandidate)) {
      if (!(await exists(root))) continue;

      const toolItems = await listToolItems(join(root, "tools"));
      for (const item of toolItems) addToolItem(item);

      const source: "workspace-user" | "builtin" = root === join(normalizedWorkspaceRoot, ".opencode") ? "workspace-user" : "builtin";
      const skillItems = await listSkillItems(join(root, "skills"), source);
      for (const item of skillItems) addSkillItem(item);

      const permissionOnlyTools = new Set<string>();
      await addPermissionBasedTools(join(root, "opencode.jsonc"), permissionOnlyTools);
      for (const name of permissionOnlyTools) addToolItem({ name });
    }
  }

  for (const root of candidateEnvOpencodeRoots()) {
    if (!(await exists(root))) continue;

    const toolItems = await listToolItems(join(root, "tools"));
    for (const item of toolItems) addToolItem(item);

    const skillItems = await listSkillItems(join(root, "skills"), "builtin");
    for (const item of skillItems) addSkillItem(item);

    const permissionOnlyTools = new Set<string>();
    await addPermissionBasedTools(join(root, "opencode.jsonc"), permissionOnlyTools);
    for (const name of permissionOnlyTools) addToolItem({ name });
  }

  const mcpItems = await listMcp(normalizedWorkspaceRoot, { includeGlobal: false });
  for (const item of mcpItems) {
    mcpServers.set(item.name, { name: item.name, source: item.source });
  }

  return {
    tools: [...tools.values()].sort((a, b) => a.name.localeCompare(b.name)),
    skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
    mcpServers: [...mcpServers.values()].sort((a, b) => a.name.localeCompare(b.name)),
    protectedFilePipelineAvailable,
  };
}
