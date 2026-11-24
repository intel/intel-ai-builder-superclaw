import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import type { CapabilityGate } from "~/shared/platform/capability/capability-gate";
import { t } from "../../i18n";
import { readOpenworkServerSettings } from "../lib/openwork-server";
import { isTauriRuntime } from "../utils";
import { openUrl, revealItemInDir } from "./settings.platform-actions";

export type GmailCredentialStatus = {
  hasCredentials: boolean;
  hasToken: boolean;
  /** Paused from Connections: the token is kept but not used. Absent from servers that predate it. */
  paused?: boolean;
  fileSize: number | null;
  updatedAt: number | null;
};

/** `signed_out`: the saved sign-in no longer works (revoked, or a Testing client's 7 days ran out). */
type GmailApiState = "enabled" | "disabled" | "not_granted" | "signed_out" | "unknown";
export type GmailApiStatus = { gmail: GmailApiState; calendar: GmailApiState };
/** `failed` is worth trying again (offline, server error); `rejected` is the file itself. */
export type GmailUploadOutcome = "uploaded" | "rejected" | "failed";

type GmailCredentialsDeps = {
  serverUrl: () => string | undefined;
  workspaceId: () => string | null;
};

export type GmailCredentials = ReturnType<typeof createGmailCredentials>;

/** Gmail configures the Email Agent, so only Profiles with `email-agent` show it; dark-safe. */
export const gmailSettingsVisible = (
  capability: Pick<CapabilityGate, "isActive" | "isAgentAllowed">,
): boolean => !capability.isActive() || capability.isAgentAllowed("email-agent");

/** Poll interval while credentials exist but OAuth has not completed. */
const GMAIL_TOKEN_POLL_MS = 5000;
/** Retry interval until the first status read succeeds. */
const GMAIL_STATUS_RETRY_MS = 3000;
/** Long enough for a server busy starting up; a read with no answer must not block the retries. */
const GMAIL_STATUS_TIMEOUT_MS = 15_000;
/** Sign-in start runs the Gmail script through uv, which may install packages on first use. */
const GMAIL_AUTH_START_TIMEOUT_MS = 120_000;
/** Past the server's own 30 s limit on the check, so a stalled connection still lets polling resume. */
const GMAIL_API_CHECK_TIMEOUT_MS = 45_000;
const SIGNED_OUT: GmailApiStatus = { gmail: "signed_out", calendar: "signed_out" };

const GMAIL_CREDENTIALS_TEMPLATE = {
  installed: {
    client_id: "YOUR_CLIENT_ID.apps.googleusercontent.com",
    project_id: "your-project-id",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_secret: "YOUR_CLIENT_SECRET",
    redirect_uris: ["http://localhost"],
  },
};

/** Pulls the server's message off a failed response, falling back to `fallback`. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.text();
  try {
    const json = JSON.parse(body);
    if (typeof json.message === "string") return json.message;
  } catch {
    /* ignore */
  }
  return fallback;
}

/**
 * Gmail credential upload / OAuth state for the Email Agent settings card.
 * The caller owns the capability gate that decides whether the card renders.
 */
export function createGmailCredentials(deps: GmailCredentialsDeps) {
  const [status, setStatus] = createSignal<GmailCredentialStatus | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal<string | null>(null);
  const [authBusy, setAuthBusy] = createSignal(false);

  const apiBase = () => deps.serverUrl()?.trim() || "";

  const apiHeaders = () => {
    const settings = readOpenworkServerSettings();
    const headers: Record<string, string> = {};
    if (settings.token) headers.Authorization = `Bearer ${settings.token}`;
    if (settings.hostToken)
      headers["X-OpenWork-Host-Token"] = settings.hostToken;
    return headers;
  };

  /** Returns the credentials endpoint, or null when server/workspace is unset. */
  const endpoint = (suffix: string): string | null => {
    const base = apiBase();
    const wid = deps.workspaceId()?.trim();
    if (!base || !wid) return null;
    return `${base}/workspace/${encodeURIComponent(wid)}/gmail/${suffix}`;
  };

  // Every failure is shown on the card, not only logged: a Connect button that
  // does nothing is indistinguishable from a broken one (EG1-8, AGENTS.md §5c).
  // A failure also drops the upload's "check your browser window" message: no
  // browser opened, and the status chip already says the upload landed.
  const failAuth = (message: string) => {
    setSuccess(null);
    setError(message);
  };

  const startAuth = async () => {
    // A second start replaces the server's pending state and PKCE verifier, so the
    // sign-in tab already open could no longer finish.
    if (authBusy()) return;
    const url = endpoint("auth/start");
    if (!url) {
      failAuth(t("settings.gmail_no_server_or_workspace"));
      return;
    }
    setAuthBusy(true);
    setError(null);
    try {
      // A start that never answers would leave every later one ignored.
      const res = await fetch(url, {
        method: "POST",
        headers: apiHeaders(),
        signal: AbortSignal.timeout(GMAIL_AUTH_START_TIMEOUT_MS),
      });
      if (!res.ok) {
        failAuth(await errorMessage(res, t("settings.gmail_auth_failed")));
        return;
      }
      const { authURL } = await res.json();
      if (!authURL) {
        failAuth(t("settings.gmail_auth_failed"));
        return;
      }
      await openUrl(authURL);
    } catch (err) {
      console.warn("Failed to start Gmail auth:", err);
      failAuth(t("settings.gmail_auth_failed"));
    } finally {
      setAuthBusy(false);
    }
  };

  const refreshStatus = async () => {
    const url = endpoint("credentials/status");
    if (!url) return;
    try {
      const res = await fetch(url, {
        headers: apiHeaders(),
        signal: AbortSignal.timeout(GMAIL_STATUS_TIMEOUT_MS),
      });
      if (res.ok) setStatus(await res.json());
    } catch {
      // A missed read is retried below while the status is still unknown.
    }
  };

  /** Null when the check could not run; the setup guide just asks again later. */
  const checkApis = async (): Promise<GmailApiStatus | null> => {
    const url = endpoint("apis");
    if (!url) return null;
    try {
      const res = await fetch(url, {
        headers: apiHeaders(),
        signal: AbortSignal.timeout(GMAIL_API_CHECK_TIMEOUT_MS),
      });
      // A token that cannot be refreshed stays that way: only signing in again fixes it.
      if (res.status === 409) {
        const body = (await res.json()) as { code?: unknown };
        return body.code === "gmail_not_authorized" ? SIGNED_OUT : null;
      }
      return res.ok ? ((await res.json()) as GmailApiStatus) : null;
    } catch {
      return null;
    }
  };

  // A slow read is left to finish rather than abandoned and re-sent: a busy
  // server would otherwise never get an answer back in time.
  let statusRead: Promise<void> | null = null;
  const trackStatusRead = () => {
    const read = refreshStatus().finally(() => {
      if (statusRead === read) statusRead = null;
    });
    statusRead = read;
  };

  // Fetch Gmail credential status on mount and when workspace changes
  createEffect(() => {
    if (endpoint("credentials/status")) trackStatusRead();
  });

  // The card has nothing to offer until it knows whether credentials exist, so a
  // read that failed (server still starting) must not be the last one.
  const statusUnknown = createMemo(() => status() === null && endpoint("credentials/status") !== null);
  createEffect(() => {
    if (!statusUnknown()) return;
    const id = setInterval(() => {
      if (!statusRead) trackStatusRead();
    }, GMAIL_STATUS_RETRY_MS);
    onCleanup(() => clearInterval(id));
  });

  // Poll every 5s while credentials exist but OAuth is not yet done.
  // Derived into a memo so the interval effect only re-runs on true/false
  // transitions — not on every refreshStatus() response that updates
  // the full status object, which would otherwise restart the interval each tick.
  const needsTokenPoll = createMemo(() => {
    const s = status();
    return Boolean(s?.hasCredentials && !s?.hasToken && !s?.paused);
  });

  createEffect(() => {
    if (!needsTokenPoll()) return;
    const id = setInterval(() => void refreshStatus(), GMAIL_TOKEN_POLL_MS);
    onCleanup(() => clearInterval(id));
  });

  createEffect(() => {
    if (status()?.hasToken) setSuccess(null);
  });

  const upload = async (file: File): Promise<GmailUploadOutcome> => {
    const url = endpoint("credentials");
    if (!url) {
      setError(t("settings.gmail_no_server_or_workspace"));
      return "failed";
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(url, {
        method: "POST",
        headers: apiHeaders(),
        body: form,
      });
      if (!res.ok) {
        setError(await errorMessage(res, t("settings.gmail_upload_failed")));
        return res.status >= 500 ? "failed" : "rejected";
      }
      setSuccess(t("settings.gmail_upload_success"));
      await refreshStatus();
      await startAuth();
      return "uploaded";
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("settings.gmail_upload_failed"),
      );
      return "failed";
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const url = endpoint("credentials");
    if (!url) return;
    if (!window.confirm(t("settings.gmail_remove_confirm"))) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(url, { method: "DELETE", headers: apiHeaders() });
      if (!res.ok) {
        setError(await errorMessage(res, t("settings.gmail_delete_failed")));
        return;
      }
      setSuccess(t("settings.gmail_credentials_removed"));
      await refreshStatus();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("settings.gmail_delete_failed"),
      );
    } finally {
      setBusy(false);
    }
  };

  /** Pause or resume Gmail; the sign-in is kept either way. */
  const setEnabled = async (enabled: boolean) => {
    const url = endpoint("enabled");
    if (!url) {
      setError(t("settings.gmail_no_server_or_workspace"));
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { ...apiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        setError(await errorMessage(res, t("connections.switch_failed")));
        return;
      }
      // A resume puts token.json back and a pause moves it aside, so the answer settles both fields.
      const { paused } = (await res.json()) as { paused: boolean };
      setStatus((current) => (current ? { ...current, paused, hasToken: !paused } : current));
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("connections.switch_failed"));
    } finally {
      setBusy(false);
    }
  };

  let templateDownloading = false;
  const downloadTemplate = async () => {
    if (templateDownloading) return;
    templateDownloading = true;
    const json = JSON.stringify(GMAIL_CREDENTIALS_TEMPLATE, null, 2);

    if (isTauriRuntime()) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke<{ path: string; created: boolean }>(
          "write_gmail_credentials_template",
          { content: json },
        );
        setSuccess(
          result.created
            ? t("settings.gmail_template_downloaded") ||
                "credentials_template.json saved to Downloads — fill in your Client ID and Secret, then upload it."
            : t("settings.gmail_template_already_exists") ||
                "credentials_template.json already exists in Downloads — it has been revealed in your file explorer.",
        );
        try {
          await revealItemInDir(result.path);
        } catch {
          // best effort — reveal failure does not affect the file
        }
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setSuccess(null);
      } finally {
        templateDownloading = false;
      }
      return;
    }

    try {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "credentials_template.json";
      a.click();
      URL.revokeObjectURL(url);
      setSuccess(
        t("settings.gmail_template_downloaded") ||
          "credentials_template.json downloaded. Fill in your Client ID and Secret, then upload it.",
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSuccess(null);
    } finally {
      templateDownloading = false;
    }
  };

  return {
    /** The server and workspace these credentials belong to, or null while unset. */
    scope: () => endpoint(""),
    status,
    busy,
    error,
    success,
    authBusy,
    startAuth,
    checkApis,
    upload,
    remove,
    setEnabled,
    downloadTemplate,
  };
}
