import type {
  Message,
  Part,
  PermissionRequest as ApiPermissionRequest,
  QuestionRequest,
} from "@opencode-ai/sdk/v2/client";

export type SidebarSessionItem = {
  id: string;
  title: string;
  slug?: string | null;
  parentID?: string | null;
  time?: {
    updated?: number | null;
    created?: number | null;
  };
  directory?: string | null;
};

export type PlaceholderAssistantMessage = {
  id: string;
  sessionID: string;
  role: "assistant" | "user";
  time: {
    created: number;
    completed?: number;
  };
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  agent: string;
  path: {
    cwd: string;
    root: string;
  };
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
  // Set on synthetic session-error placeholders so MessageList can key its
  // "Go to Settings" CTA off this instead of parsing the synthetic message id.
  errorKind?: SessionErrorTurnKind;
};

export type MessageInfo = Message | PlaceholderAssistantMessage;

export type MessageWithParts = {
  info: MessageInfo;
  parts: Part[];
};

export type SessionErrorTurnKind =
  | "cloud-not-configured"
  | "local-not-configured"
  | "auto-not-configured";

export type SessionErrorTurn = {
  id: string;
  text: string;
  kind?: SessionErrorTurnKind;
  afterMessageID: string | null;
  // The message whose failure produced this turn. Stable lifecycle key: when
  // that message leaves the authoritative transcript (removed, or hidden behind
  // the session's revert boundary) the turn is reconciled away. Null for
  // session-level errors not tied to a specific message.
  sourceMessageID?: string | null;
  time: number;
};

export type ClassifierResponseKind = "greeting" | "ambiguous" | "redirect" | "generic";

export type SessionClassifierTurn = {
  id: string;
  text: string;
  kind: ClassifierResponseKind;
  afterMessageID: string | null;
  time: number;
};

export type SessionClassifierUserTurn = {
  id: string;
  text: string;
  afterMessageID: string | null;
  time: number;
  // What the intent classifier was sent, when that differs from `text`.
  // A collapsed paste stays in `text`; matching the display cache uses this.
  classifierText?: string;
};

export type SessionCompactTurn = {
  id: string;
  text: string;
  afterMessageID: string | null;
  time: number;
};

export const SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX = "session-error:";
export const SYNTHETIC_SESSION_CLASSIFIER_MESSAGE_PREFIX = "session-classifier:";
export const SYNTHETIC_SESSION_CLASSIFIER_USER_MESSAGE_PREFIX = "session-classifier-user:";
export const SYNTHETIC_SESSION_COMPACT_MESSAGE_PREFIX = "session-compact:";
export const PENDING_USER_MESSAGE_PREFIX = "pending-user:";

export type ToolStepMode = "exploration" | "standalone";

export type MessageGroup =
  | { type: "text"; part: Part }
  | { type: "tool-steps"; id: string; parts: Part[]; mode: ToolStepMode };

export type ArtifactItem = {
  id: string;
  name: string;
  path?: string;
  kind: "file" | "text";
  size?: string;
  messageId?: string;
};

export type PendingPermission = ApiPermissionRequest & {
  receivedAt: number;
};

export type PendingQuestion = QuestionRequest & {
  receivedAt: number;
};

export type TodoItem = {
  id?: string;
  content: string;
  status: string;
  priority: string;
};
