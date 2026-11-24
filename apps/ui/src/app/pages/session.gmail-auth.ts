import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { Setter } from "solid-js";

import type { OpenworkServerSettings } from "../lib/openwork-server";
import type { OpenworkServerInfo } from "../lib/tauri";
import type { MessageWithParts } from "../types";

const GMAIL_OAUTH_URL_RGX =
  /https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"')>]+/i;

type GmailConnectionState = "none" | "no_credentials" | "no_token" | "ready";

/**
 * Reactive inputs arrive as thunks so the controller reads them in its
 * caller's tracking scope instead of capturing a value at setup time.
 */
type GmailAuthDeps = {
  selectedSessionAgent: () => string | null;
  selectedSessionId: () => string | null;
  sessionStatus: () => string;
  messages: () => MessageWithParts[];
  getMessagesBySessionId: (sessionId: string | null) => MessageWithParts[];
  serverSettings: () => OpenworkServerSettings;
  serverHostInfo: () => OpenworkServerInfo | null;
  serverWorkspaceId: () => string | null;
  abortSession: (sessionId?: string) => Promise<void>;
  setToastMessage: (message: string) => void;
  openLink: (url: string) => void | Promise<void>;
};

type GmailAuthController = {
  /** Drives the settings-panel indicator; only populated for `email-agent`. */
  connectionStatus: () => GmailConnectionState;
  /** Resolves the current credential status before a same-turn email send. */
  refreshConnectionStatus: () => Promise<GmailConnectionState>;
  statusModalOpen: () => boolean;
  setStatusModalOpen: Setter<boolean>;
  /** Forget which session triggered the current run (called on session reset). */
  clearRunSession: () => void;
};

/**
 * Watches an email-agent run for the Google OAuth URL it prints when Gmail
 * credentials exist but no token does, and opens that URL once per run.
 *
 * The agent can also run as a subagent, in which case the URL appears in a
 * child session's messages and the cached connection status is never
 * populated — so before opening a browser the controller re-checks the server,
 * which is the only authoritative source.
 */
export function createGmailAuth(deps: GmailAuthDeps): GmailAuthController {
  const [connectionStatus, setConnectionStatus] =
    createSignal<GmailConnectionState>("none");
  const [statusModalOpen, setStatusModalOpen] = createSignal(false);
  let statusEpoch = 0;
  let runSessionId: string | null = null;
  let lastOpenedUrl: string | null = null;

  type CredentialsStatus = { hasCredentials: boolean; hasToken: boolean; paused?: boolean };
  type CredentialsRequest = { url: string; headers: Record<string, string> };

  /**
   * Request for the workspace's Gmail credential status, or null when the
   * server URL or workspace is not known yet.
   */
  const credentialsStatusRequest = (): CredentialsRequest | null => {
    const settings = deps.serverSettings();
    const baseUrl = (
      deps.serverHostInfo()?.baseUrl ??
      settings.urlOverride ??
      ""
    ).trim();
    const wid = deps.serverWorkspaceId()?.trim();
    if (!baseUrl || !wid) return null;
    const token = settings.token?.trim() ?? "";
    return {
      url: `${baseUrl}/workspace/${encodeURIComponent(wid)}/gmail/credentials/status`,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    };
  };

  const fetchCredentialsStatus = async (
    request: CredentialsRequest,
  ): Promise<CredentialsStatus | null> => {
    const res = await fetch(request.url, { headers: request.headers });
    if (!res.ok) return null;
    return (await res.json()) as CredentialsStatus;
  };

  // Returns true if the server says Gmail credentials exist but have no token yet.
  // This is the authoritative check — avoids relying on connectionStatus which
  // is only populated when the parent session agent is "email-agent" (not for subagent runs).
  // Paused from Connections is authorized already, so an old OAuth link in the session is not opened.
  const serverNeedsAuth = async (): Promise<boolean> => {
    const request = credentialsStatusRequest();
    if (!request) return false;
    try {
      const data = await fetchCredentialsStatus(request);
      return data ? data.hasCredentials && !data.hasToken && !data.paused : false;
    } catch {
      return false;
    }
  };

  const statusFromCredentials = (data: CredentialsStatus): GmailConnectionState => {
    if (!data.hasCredentials) return "no_credentials";
    if (!data.hasToken) return "no_token";
    return "ready";
  };

  const refreshConnectionStatus = async (): Promise<GmailConnectionState> => {
    const epoch = statusEpoch;
    const request = credentialsStatusRequest();
    if (!request) {
      if (epoch === statusEpoch) setConnectionStatus("no_credentials");
      return "no_credentials";
    }
    try {
      const data = await fetchCredentialsStatus(request);
      if (epoch !== statusEpoch) return connectionStatus();
      if (!data) return connectionStatus();
      const next = statusFromCredentials(data);
      setConnectionStatus(next);
      return next;
    } catch {
      if (epoch !== statusEpoch) return connectionStatus();
      setConnectionStatus("no_credentials");
      return "no_credentials";
    }
  };

  // Check Gmail status when email-agent is selected and when tab regains focus (user returns from OAuth tab). This drives the settings panel status indicator.
  createEffect(() => {
    statusEpoch += 1;
    const isEmailAgent = deps.selectedSessionAgent() === "email-agent";
    if (!isEmailAgent) {
      setConnectionStatus("none");
      return;
    }
    const request = credentialsStatusRequest();
    if (!request) {
      setConnectionStatus("no_credentials");
      return;
    }
    const fetchStatus = async () => {
      try {
        const data = await fetchCredentialsStatus(request);
        if (!data) return;
        if (!data.hasCredentials) {
          setConnectionStatus("no_credentials");
        } else if (!data.hasToken) {
          setConnectionStatus("no_token");
        } else {
          setConnectionStatus("ready");
        }
      } catch {
        setConnectionStatus("no_credentials");
      }
    };
    void fetchStatus();
    // Re-check when user returns to this tab (e.g. after completing OAuth in another tab).
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void fetchStatus().then(() => {
        if (connectionStatus() === "ready" && deps.sessionStatus() !== "idle") {
          void deps.abortSession();
          runSessionId = null;
          deps.setToastMessage(
            "Gmail connected! Send your request again to continue.",
          );
        }
      });
    };
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() =>
      document.removeEventListener("visibilitychange", onVisible),
    );
  });

  const latestAuthUrl = createMemo<string | null>(() => {
    // Only evaluate after streaming completes
    if (deps.sessionStatus() !== "idle") return null;
    // Direct email-agent: fast path using cached status signal
    if (
      deps.selectedSessionAgent() === "email-agent" &&
      connectionStatus() === "ready"
    )
      return null;

    const scanMessages = (messages: MessageWithParts[]): string | null => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]!;
        if ((msg.info as { role?: string })?.role !== "assistant") continue;
        for (const part of msg.parts) {
          let rawOutput = "";
          if (part.type === "text") {
            rawOutput = (part as { text?: string }).text ?? "";
          } else if (part.type === "tool") {
            const state = (part as { state?: { output?: unknown } }).state;
            if (typeof state?.output === "string") {
              rawOutput = state.output;
            }
          }
          if (!rawOutput) continue;
          const match = rawOutput.match(GMAIL_OAUTH_URL_RGX);
          if (match) return match[0];
        }
      }
      return null;
    };

    const messages = deps.messages();

    // Direct email agent session
    if (deps.selectedSessionAgent() === "email-agent") {
      const direct = scanMessages(messages);
      if (direct) return direct;
    }

    // Email agent executing as a subagent
    for (
      let messageInput = messages.length - 1;
      messageInput >= 0;
      messageInput--
    ) {
      const message = messages[messageInput]!;
      for (let pi = message.parts.length - 1; pi >= 0; pi--) {
        const part = message.parts[pi]!;
        if (part.type !== "tool") continue;
        const toolPart = part as {
          tool?: string;
          state?: Record<string, unknown>;
        };
        if (toolPart.tool !== "task") continue;
        const state = toolPart.state ?? {};
        const metadata = (state.metadata ?? {}) as Record<string, unknown>;
        const childSessionId =
          (metadata.sessionId as string) ??
          (metadata.sessionID as string) ??
          (state.sessionId as string) ??
          (state.sessionID as string) ??
          null;
        if (!childSessionId) continue;
        const childMessages = deps.getMessagesBySessionId(childSessionId);
        if (!childMessages?.length) continue;
        const url = scanMessages(childMessages);
        if (url) return url;
      }
    }

    return null;
  });

  createEffect(
    on(
      deps.sessionStatus,
      (status, prev) => {
        if (prev === "idle" && status !== "idle") {
          runSessionId = deps.selectedSessionId() ?? null;
        }
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      latestAuthUrl,
      (url) => {
        if (!url) return;
        // Cross session guard, only fire for the session that triggered this run
        if (deps.selectedSessionId() !== runSessionId) return;
        // Dedup within a run: same URL was already opened
        if (url === lastOpenedUrl) return;
        // Server-side authoritative check: only open browser if token truly missing.
        // This handles both the direct email-agent case and the subagent case
        // (where connectionStatus is always "none" so cannot be trusted).
        void serverNeedsAuth().then((needsAuth) => {
          if (!needsAuth) return;
          lastOpenedUrl = url;
          deps.openLink(url);
        });
      },
      { defer: true },
    ),
  );

  return {
    connectionStatus,
    refreshConnectionStatus,
    statusModalOpen,
    setStatusModalOpen,
    clearRunSession: () => {
      runSessionId = null;
    },
  };
}
