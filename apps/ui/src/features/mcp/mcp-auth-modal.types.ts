/** Props for the MCP auth modal. */
import type { McpStatus } from "~/shared/types/mcp";
import type { McpDirectoryInfo } from "~/shared/util/constants";
import type { Language } from "../../i18n";

export type McpAuthModalProps = {
  open: boolean;
  onClose: () => void;
  onComplete: () => void | Promise<void>;
  onReloadEngine?: () => void | Promise<void>;
  reloadRequired?: boolean;
  reloadBlocked?: boolean;
  activeSessions?: Array<{ id: string; title: string }>;
  isRemoteWorkspace?: boolean;
  getStatus: (name: string) => Promise<McpStatus | null>;
  startAuth: (name: string) => Promise<{ authorizationUrl?: string }>;
  completeAuth: (name: string, code: string) => Promise<void>;
  entry: McpDirectoryInfo | null;
  language: Language;
  onForceStopSession?: (sessionID: string) => void | Promise<void>;
};
