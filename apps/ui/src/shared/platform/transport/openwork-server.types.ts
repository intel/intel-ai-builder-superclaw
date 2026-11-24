export type OpenworkServerCapabilities = {
  skills: {
    read: boolean;
    write: boolean;
    source: "openwork" | "opencode";
    packageImport?: {
      version: 1;
      maxFileBytes: number;
      maxTotalBytes: number;
      maxFiles: number;
      chunkBytes: number;
    };
  };
  hub?: {
    skills?: {
      read: boolean;
      install: boolean;
      repo?: { owner: string; name: string; ref: string };
    };
  };
  plugins: { read: boolean; write: boolean };
  mcp: { read: boolean; write: boolean };
  commands: { read: boolean; write: boolean };
  config: { read: boolean; write: boolean };
  sandbox?: { enabled: boolean; backend: "none" };
  proxy?: { opencode: boolean; opencodeRouter: boolean };
  toolProviders?: {
    browser?: {
      enabled: boolean;
      placement: "in-sandbox" | "host-machine" | "client-machine" | "external";
      mode: "none" | "headless" | "interactive";
    };
    files?: {
      injection: boolean;
      outbox: boolean;
      inboxPath: string;
      outboxPath: string;
      maxBytes: number;
    };
  };
};

export type OpenworkServerStatus = "connected" | "disconnected" | "limited";

export type OpenworkServerDiagnostics = {
  ok: boolean;
  version: string;
  uptimeMs: number;
  readOnly: boolean;
  approval: { mode: "manual" | "auto"; timeoutMs: number };
  corsOrigins: string[];
  workspaceCount: number;
  activeWorkspaceId: string | null;
  workspace: OpenworkWorkspaceInfo | null;
  authorizedRoots: string[];
  server: { host: string; port: number; configPath?: string | null };
  tokenSource: { client: string; host: string };
};

export type OpenworkRuntimeServiceName = "openwork-server" | "opencode" | "opencode-router";

export type OpenworkRuntimeServiceSnapshot = {
  name: OpenworkRuntimeServiceName;
  enabled: boolean;
  running: boolean;
  targetVersion: string | null;
  actualVersion: string | null;
  upgradeAvailable: boolean;
};

export type OpenworkRuntimeSnapshot = {
  ok: boolean;
  orchestrator?: {
    version: string;
    startedAt: number;
  };
  worker?: {
    workspace: string;
    sandboxMode: string;
  };
  upgrade?: {
    status: "idle" | "running" | "failed";
    startedAt: number | null;
    finishedAt: number | null;
    error: string | null;
    operationId: string | null;
    services: OpenworkRuntimeServiceName[];
  };
  services: OpenworkRuntimeServiceSnapshot[];
};

export type OpenworkServerSettings = {
  urlOverride?: string;
  portOverride?: number;
  token?: string;
  hostToken?: string;
  hubUrl?: string;
  hubToken?: string;
};

export type DeepResearchLocalFilePrivacy = "share_with_cloud" | "do_not_share_with_cloud";

export type OpenworkRuntimeSettings = {
  schemaVersion: 1;
  updatedAt: number | null;
  deepResearch: {
    localFilePrivacy: DeepResearchLocalFilePrivacy;
  };
};

export type OpenworkRuntimeSettingsPatch = {
  deepResearch?: {
    localFilePrivacy: DeepResearchLocalFilePrivacy;
  };
};

export type IntentClassificationResult = {
  category: string;
  agent: string | null;
  response: string | null;
  confidence?: number | null;
  rule_matched?: string | null;
  latency_ms?: number | null;
  intake_state?: "fast_reply" | "intake_chat" | "route_ready" | null;
  turn_count?: number | null;
  handoff_summary?: {
    handoff_version: string;
    source_agent: string;
    target_agent: string;
    routing_reason: string;
    user_goal: string;
    task_type: string;
    clarity_state: string;
    confirmed_facts: string[];
    open_questions: string[];
    transcript_window: Array<{ role: string; content: string }>;
  } | null;
};

export type IntentSessionDisplayTurn = {
  user_text: string;
  response: string;
  kind: "greeting" | "ambiguous" | "generic";
  category: string;
  recorded_at_ms: number;
};

export type IntentSessionDisplayResult = {
  session_id: string;
  turns: IntentSessionDisplayTurn[];
};

export type PiiCategories = {
  all_categories: string[];
  custom_skip_categories: string[];
  custom_mask_categories: string[];
};

export type MaskedReview = {
  entities: { placeholder: string; category: string; value: string }[];
  supports_extra_terms: boolean;
  masked_text?: string | null;
  masked_text_truncated?: boolean;
  file_extension?: string;
  preview_format?: "markdown" | "text";
};

export type MaskedExtraTermsResult = {
  added: { placeholder: string; category: string; value: string }[];
  not_found: string[];
};

export type OpenworkWorkspaceInfo = {
  id: string;
  name: string;
  path: string;
  workspaceType: "local" | "remote";
  baseUrl?: string;
  directory?: string;
  opencode?: {
    baseUrl?: string;
    directory?: string;
    username?: string;
    password?: string;
  };
};

export type OpenworkWorkspaceList = {
  items: OpenworkWorkspaceInfo[];
  activeId?: string | null;
};

export type OpenworkPluginItem = {
  spec: string;
  source: "config" | "dir.project" | "dir.global";
  scope: "project" | "global";
  path?: string;
};

export type OpenworkSkillItem = {
  name: string;
  path: string;
  description: string;
  scope: "project" | "global";
  trigger?: string;
};

export type OpenworkSkillContent = {
  item: OpenworkSkillItem;
  content: string;
};

export type OpenworkAgentToolSkillCatalog = {
  tools: Array<{ name: string; description?: string }>;
  skills: Array<{ name: string; description?: string; source: "workspace-user" | "builtin" }>;
  mcpServers: Array<{ name: string; source: "config.project" | "config.global" | "config.remote" }>;
  protectedFilePipelineAvailable: boolean;
};

export type OpenworkHubSkillItem = {
  name: string;
  description: string;
  trigger?: string;
  source: {
    owner: string;
    repo: string;
    ref: string;
    path: string;
  };
};

export type OpenworkHubRepo = {
  owner?: string;
  repo?: string;
  ref?: string;
};

export type OpenworkWorkspaceFileContent = {
  path: string;
  content: string;
  bytes: number;
  updatedAt: number;
};

export type OpenworkWorkspaceFileWriteResult = {
  ok: boolean;
  path: string;
  bytes: number;
  updatedAt: number;
  revision?: string;
};

export type OpenworkFileSession = {
  id: string;
  workspaceId: string;
  createdAt: number;
  expiresAt: number;
  ttlMs: number;
  canWrite: boolean;
};

export type OpenworkFileCatalogEntry = {
  path: string;
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
  revision: string;
};

export type OpenworkFileSessionEvent = {
  id: string;
  seq: number;
  workspaceId: string;
  type: "write" | "delete" | "rename" | "mkdir";
  path: string;
  toPath?: string;
  revision?: string;
  timestamp: number;
};

export type OpenworkFileReadBatchResult = {
  items: Array<
    | {
      ok: true;
      path: string;
      kind: "file";
      bytes: number;
      updatedAt: number;
      revision: string;
      contentBase64: string;
    }
    | {
      ok: false;
      path: string;
      code: string;
      message: string;
      maxBytes?: number;
      size?: number;
    }
  >;
};

export type OpenworkFileWriteBatchResult = {
  items: Array<
    | {
      ok: true;
      path: string;
      bytes: number;
      updatedAt: number;
      revision: string;
      previousRevision?: string | null;
    }
    | {
      ok: false;
      path: string;
      code: string;
      message: string;
      expectedRevision?: string;
      currentRevision?: string | null;
      maxBytes?: number;
      size?: number;
    }
  >;
  cursor: number;
};

export type OpenworkFileOpsBatchResult = {
  items: Array<Record<string, unknown>>;
  cursor: number;
};

export type OpenworkCommandItem = {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string | null;
  subtask?: boolean;
  scope: "workspace" | "global";
};

export type OpenworkOpenCodeRouterTelegramResult = {
  ok: boolean;
  persisted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  telegram?: {
    configured: boolean;
    enabled: boolean;
    applied?: boolean;
    starting?: boolean;
    error?: string;
  };
};

export type OpenworkOpenCodeRouterSlackResult = {
  ok: boolean;
  persisted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  slack?: {
    configured: boolean;
    enabled: boolean;
    applied?: boolean;
    starting?: boolean;
    error?: string;
  };
};

export type OpenworkOpenCodeRouterTelegramBotInfo = {
  id: number;
  username?: string;
  name?: string;
};

export type OpenworkOpenCodeRouterTelegramInfo = {
  ok: boolean;
  configured: boolean;
  enabled: boolean;
  bot: OpenworkOpenCodeRouterTelegramBotInfo | null;
};

export type OpenworkOpenCodeRouterTelegramEnabledResult = {
  ok: boolean;
  persisted?: boolean;
  enabled: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
};

export type OpenworkOpenCodeRouterHealthSnapshot = {
  ok: boolean;
  opencode: {
    url: string;
    healthy: boolean;
    version?: string;
  };
  channels: {
    telegram: boolean;
    whatsapp: boolean;
    slack: boolean;
  };
  config: {
    groupsEnabled: boolean;
  };
  activity?: {
    dayStart: number;
    inboundToday: number;
    outboundToday: number;
    lastInboundAt?: number;
    lastOutboundAt?: number;
    lastMessageAt?: number;
  };
  agent?: {
    scope: "workspace";
    path: string;
    loaded: boolean;
    selected?: string;
  };
};

export type OpenworkOpenCodeRouterBindingItem = {
  channel: string;
  identityId: string;
  peerId: string;
  directory: string;
  updatedAt?: number;
};

export type OpenworkOpenCodeRouterBindingsResult = {
  ok: boolean;
  items: OpenworkOpenCodeRouterBindingItem[];
};

export type OpenworkOpenCodeRouterIdentityItem = {
  id: string;
  enabled: boolean;
  running: boolean;
  access?: "public" | "private";
  pairingRequired?: boolean;
  /** The bot a running Telegram identity started as, reported by the router. */
  bot?: OpenworkOpenCodeRouterTelegramBotInfo;
};

export type OpenworkOpenCodeRouterTelegramIdentitiesResult = {
  ok: boolean;
  items: OpenworkOpenCodeRouterIdentityItem[];
};

export type OpenworkOpenCodeRouterSlackIdentitiesResult = {
  ok: boolean;
  items: OpenworkOpenCodeRouterIdentityItem[];
};

export type OpenworkOpenCodeRouterTelegramIdentityUpsertResult = {
  ok: boolean;
  persisted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  telegram?: {
    id: string;
    enabled: boolean;
    access?: "public" | "private";
    pairingRequired?: boolean;
    pairingCode?: string;
    applied?: boolean;
    starting?: boolean;
    error?: string;
    bot?: OpenworkOpenCodeRouterTelegramBotInfo | null;
  };
};

export type OpenworkOpenCodeRouterSlackIdentityUpsertResult = {
  ok: boolean;
  persisted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  slack?: {
    id: string;
    enabled: boolean;
    applied?: boolean;
    starting?: boolean;
    error?: string;
    /** Workspace the credentials verified against, echoed back by OpenCodeRouter. */
    teamName?: string;
    teamId?: string;
    botUserId?: string;
  };
};

export type OpenworkOpenCodeRouterTelegramIdentityDeleteResult = {
  ok: boolean;
  persisted?: boolean;
  deleted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  telegram?: {
    id: string;
    deleted: boolean;
  };
};

export type OpenworkOpenCodeRouterSlackIdentityDeleteResult = {
  ok: boolean;
  persisted?: boolean;
  deleted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  slack?: {
    id: string;
    deleted: boolean;
  };
};

export type OpenworkWorkspaceExport = {
  workspaceId: string;
  exportedAt: number;
  opencode?: Record<string, unknown>;
  openwork?: Record<string, unknown>;
  skills?: Array<{ name: string; description?: string; trigger?: string; content: string }>;
  commands?: Array<{ name: string; description?: string; template?: string }>;
};

export type OpenworkArtifactItem = {
  id: string;
  name?: string;
  path?: string;
  size?: number;
  createdAt?: number;
  updatedAt?: number;
  mime?: string;
};

export type OpenworkArtifactList = {
  items: OpenworkArtifactItem[];
};

export type OpenworkInboxItem = {
  id: string;
  name?: string;
  path?: string;
  size?: number;
  updatedAt?: number;
  kind?: "file" | "dir";
};

export type OpenworkInboxList = {
  items: OpenworkInboxItem[];
};

export type OpenworkInboxUploadResult = {
  ok: boolean;
  path: string;
  bytes: number;
};

/** Describes only a live or failed device login. Success is not reported here —
 * it shows up as `OpenworkGithubStatus.authenticated`. */
export type OpenworkGithubDeviceFlow = {
  status: "not_started" | "awaiting_authorization" | "error";
  userCode: string | null;
  verificationUri: string | null;
  expiresAt: number | null;
  error: { code: string; message: string } | null;
};

/** GitHub CLI connection state. Deliberately carries no token — the sandbox
 * stores it and only reports who is connected and what was granted. */
export type OpenworkGithubStatus = {
  installed: boolean;
  authenticated: boolean;
  login: string | null;
  scopes: string[];
  /** Why GitHub cannot be used in this sandbox; null when it can. Absent from
   * servers that predate it. */
  unavailableReason?: string | null;
  /** A sign-in an older build left behind, which can still be removed. */
  legacyCredential?: boolean;
  /** Paused from Connections: the sign-in is kept but `gh` does not see it. Absent from older servers. */
  paused?: boolean;
  deviceFlow: OpenworkGithubDeviceFlow;
};

export type RawJsonResponse<T> = {
  ok: boolean;
  status: number;
  json: T | null;
};

export type OpenworkActor = {
  type: "remote" | "host";
  clientId?: string;
  tokenHash?: string;
};

export type OpenworkAuditEntry = {
  id: string;
  workspaceId: string;
  actor: OpenworkActor;
  action: string;
  target: string;
  summary: string;
  timestamp: number;
};

export type OpenworkReloadTrigger = {
  type: "skill" | "plugin" | "config" | "mcp" | "agent" | "command";
  name?: string;
  action?: "added" | "removed" | "updated";
  path?: string;
};

export type OpenworkReloadEvent = {
  id: string;
  seq: number;
  workspaceId: string;
  reason: "plugins" | "skills" | "mcp" | "config" | "agents" | "commands";
  trigger?: OpenworkReloadTrigger;
  timestamp: number;
};

export type ApprovalItem = {
  id: string;
  workspaceId?: string;
  action: string;
  summary: string;
  paths?: string[];
  createdAt: number;
};

export type AgentLabSchedulePayload =
  | { kind: "interval"; seconds: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "days"; weekdays: number[]; hour: number; minute: number };

export type AgentLabAutomationItem = {
  id: string;
  name: string;
  enabled: boolean;
  schedule: AgentLabSchedulePayload;
  prompt: string;
  model?: string;
  /** OpenCode agent the automation runs as; unset = the default agent. */
  agent?: string;
  createdAt: number;
  updatedAt?: number;
  lastRunAt?: number;
  lastRunSessionId?: string;
  /** Why the scheduler refused the last run; absent once a run dispatches. */
  lastRunError?: string;
};
