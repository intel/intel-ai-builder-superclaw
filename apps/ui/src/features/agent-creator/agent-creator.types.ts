/** Types for the agent-creator form and its capability model. */
import type { Component, JSX } from "solid-js";

export type AgentInfo = {
  name: string;
  description?: string;
};

export type AgentCreatorViewProps = {
  onSave: (agent: AgentFormData) => Promise<void>;
  agents: AgentInfo[];
  busy: boolean;
  canEdit: boolean;
  canDelete: boolean;
  loadToolsSkills?: () => Promise<{
    tools: Array<{ name: string; description?: string }>;
    skills: Array<{ name: string; description?: string; source: "workspace-user" | "builtin" }>;
    mcpServers: Array<{ name: string; source: "config.project" | "config.global" | "config.remote" }>;
    protectedFilePipelineAvailable: boolean;
  }>;
  watchToolsSkillsChanges?: (since?: number) => Promise<{
    items: Array<{ reason: "plugins" | "skills" | "mcp" | "config" | "agents" | "commands" }>;
    cursor?: number;
    disabled?: boolean;
  }>;
  refreshAgents: () => void;
  readAgent: (name: string) => Promise<{ content: string } | null>;
  saveAgent: (name: string, content: string) => Promise<void>;
  deleteAgent: (name: string) => Promise<void>;
  /** Description for a bundled skill, or `undefined` when it has none. */
  skillDescription: (name: string) => string | undefined;
  /** The read-only Markdown preview modal; the Dashboard supplies `app/`'s `FilePreviewModal`. */
  filePreview: Component<AgentFilePreviewProps>;
};

export type AgentFilePreviewProps = {
  open: boolean;
  title: string;
  content: string;
  loading: boolean;
  error: string | null;
  headerActions: JSX.Element;
  onClose: () => void;
};

export type AgentFormData = {
  name: string;
  description: string;
  systemPrompt: string;
  selectedTools: string[];
  selectedSkills: string[];
  askTools?: string[];
  protectedFilePipelineEnabled: boolean;
};

export type CapabilityItem = {
  name: string;
  description?: string;
  source?: "workspace-user" | "builtin";
};

export type CapabilityCategory = {
  id: string;
  labelKey: string;
  descriptionKey: string;
};

export type RiskLevel = "low" | "high";

export type PackageLevel = "none" | RiskLevel;
