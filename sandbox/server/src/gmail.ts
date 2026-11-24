import { copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { ApiError } from "./errors.js";
import type { WorkspaceInfo } from "./types.js";

export function gmailUvEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      ...process.env,
      UV_PROJECT_ENVIRONMENT: process.env.GMAIL_TOOLS_VENV || "/data/gmail-tools-venv",
    })
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** The Profile's Gmail scripts. On native the broker names them in the published generation
 * (`GMAIL_TOOLS_DIR`), because this process has no `OPENCODE_CONFIG_DIR`. */
export function gmailScriptDir(workspacePath: string): string {
  const named = process.env.GMAIL_TOOLS_DIR?.trim();
  if (named) return named;
  return join(process.env.OPENCODE_CONFIG_DIR ?? join(workspacePath, ".opencode"), "tools", "gmail");
}

/** Where credentials.json, token.json, the mail cache and a pending authorization live: the
 * scripts' `GMAIL_DATA_DIR`, else beside the scripts as in the container. */
export function gmailDataDir(workspacePath: string): string {
  return process.env.GMAIL_DATA_DIR?.trim() || gmailScriptDir(workspacePath);
}

/** Everything Settings and the scripts keep for one Gmail authorization. */
const GMAIL_DATA_FILES = ["credentials.json", "token.json", "gmail.db", "pending_auth.json"];

export type GmailMigration = { moved: string[]; removed: string[]; from: string; to: string };

/**
 * Move the Gmail data an older build kept beside the scripts, under the workspace's
 * .opencode (`<workspace>\.opencode\tools\gmail`), into GMAIL_DATA_DIR.
 *
 * An upgrade keeps that directory, but once the broker names GMAIL_DATA_DIR (EG1-8)
 * nothing reads it: Settings would neither show nor delete the old client secret and
 * token. The files are one authorization, so they move as a set: when the data
 * directory already holds a credentials.json, the old set is stale and is removed
 * rather than mixed in. Either way no copy is left in the workspace.
 */
const migrations = new Map<string, Promise<GmailMigration | null>>();

/** One pass at a time per workspace. Start-up and a status poll can both call this, and a
 * second pass that ran while the first was half done would see the moved credentials.json,
 * take the rest of the set for stale, and delete the token it was about to move. */
export function migrateLegacyGmailData(workspacePath: string): Promise<GmailMigration | null> {
  const key = resolve(workspacePath);
  const running = migrations.get(key);
  if (running) return running;
  const pass = migrateLegacyGmailDataOnce(workspacePath).finally(() => migrations.delete(key));
  migrations.set(key, pass);
  return pass;
}

async function migrateLegacyGmailDataOnce(workspacePath: string): Promise<GmailMigration | null> {
  const to = process.env.GMAIL_DATA_DIR?.trim();
  if (!to) return null;
  const from = join(process.env.OPENCODE_CONFIG_DIR ?? join(workspacePath, ".opencode"), "tools", "gmail");
  if (resolve(from) === resolve(to)) return null;
  const present = GMAIL_DATA_FILES.filter((name) => existsSync(join(from, name)));
  if (present.length === 0) return null;

  const result: GmailMigration = { moved: [], removed: [], from, to };
  const supersede = existsSync(join(to, "credentials.json"));
  if (!supersede) await mkdir(to, { recursive: true });
  for (const name of present) {
    const source = join(from, name);
    const target = join(to, name);
    if (supersede || existsSync(target)) {
      await rm(source, { force: true });
      result.removed.push(name);
      continue;
    }
    try {
      await rename(source, target);
    } catch {
      // The data directory may be on another volume, where rename cannot move a file.
      await copyFile(source, target);
      await rm(source, { force: true });
    }
    result.moved.push(name);
  }
  return result;
}

/** A token the user paused from Connections: kept beside the data, and read by no script until resumed. */
export const GMAIL_PAUSED_TOKEN_FILE = "token.json.paused";

/** Paused while the paused token exists, even if a refresh that was in flight wrote token.json again. */
export function gmailPaused(dataDir: string): boolean {
  return existsSync(join(dataDir, GMAIL_PAUSED_TOKEN_FILE));
}

/** Pause or resume Gmail without removing its authorization; false when there is no token to switch. */
export async function setGmailEnabled(dataDir: string, enabled: boolean): Promise<boolean> {
  const active = join(dataDir, "token.json");
  const paused = join(dataDir, GMAIL_PAUSED_TOKEN_FILE);
  if (enabled) {
    if (existsSync(active)) {
      await rm(paused, { force: true });
      return true;
    }
    if (!existsSync(paused)) return false;
    await rename(paused, active);
    return true;
  }
  if (existsSync(active)) {
    await rename(active, paused);
    return true;
  }
  return existsSync(paused);
}

/** Forget the authorization, paused or not, so the next use asks the user to authorize again. */
export async function removeGmailTokens(dataDir: string): Promise<void> {
  await rm(join(dataDir, "token.json"), { force: true });
  await rm(join(dataDir, GMAIL_PAUSED_TOKEN_FILE), { force: true });
}

/** The command that runs a Gmail script with `args`. On native, the payload's agent Python
 * (`GMAIL_PYTHON`, EG1-8), which carries the Google libraries and needs no network to start;
 * elsewhere `uv run`, which installs the script project's dependencies on first use. */
export function gmailScriptCommand(script: string, args: string[]): string[] {
  const python = process.env.GMAIL_PYTHON?.trim();
  return python ? [python, script, ...args] : ["uv", "run", script, ...args];
}

export const GMAIL_OAUTH_SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Gmail Connected</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    .card { background: #fff; border-radius: 12px; padding: 40px 48px; max-width: 440px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
    .icon { font-size: 48px; margin-bottom: 12px; }
    h1 { font-size: 22px; font-weight: 700; color: #111; margin: 0 0 8px; }
    p { color: #555; line-height: 1.6; margin: 0; }
    .tag { display: inline-block; margin-top: 20px; background: #ecfdf5; color: #059669; border-radius: 6px; padding: 4px 12px; font-size: 13px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>Gmail Connected!</h1>
    <p>Your Gmail account has been authorized successfully.<br/>You can close this tab.</p>
    <div class="tag">Authentication complete</div>
  </div>
</body>
</html>`;

export function gmailOAuthErrorHtml(message: string): string {
  const safe = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Authorization Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #fef2f2; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    .card { background: #fff; border-radius: 12px; padding: 40px 48px; max-width: 480px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
    .icon { font-size: 48px; margin-bottom: 12px; }
    h1 { font-size: 22px; font-weight: 700; color: #b91c1c; margin: 0 0 8px; }
    p { color: #555; line-height: 1.6; word-break: break-word; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">❌</div>
    <h1>Authorization Failed</h1>
    <p>${safe}</p>
    <p style="margin-top:16px;font-size:13px;color:#888">Return to the configuration and start the authorization flow again.</p>
  </div>
</body>
</html>`;
}

const TOKEN_EXCHANGE_FAILED =
  "Token exchange failed. Please return to the configuration, remove the existing credentials, re-upload your credentials.json, and start the authorization flow again.";

/** Handles Google's redirect after sign-in: checks the state, exchanges the code, and returns the page to show. */
export async function completeGmailOAuth(
  url: URL,
  workspaces: WorkspaceInfo[],
  workspaceId?: string,
): Promise<string> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return gmailOAuthErrorHtml(`Google returned an error: ${error}`);
  }
  if (!code || !state) {
    return gmailOAuthErrorHtml("Missing authorization code or state parameter.");
  }

  // Resolve workspace — prefer explicit workspaceId, otherwise use first workspace.
  const workspace = workspaceId
    ? workspaces.find((w) => w.id === workspaceId) ?? workspaces[0]
    : workspaces[0];

  if (!workspace?.path) {
    return gmailOAuthErrorHtml("No workspace configured on this server.");
  }

  // gmailDir = runtime artefacts (GMAIL_DATA_DIR); script dir = email sync script location.
  const scriptDir = gmailScriptDir(workspace.path);
  const gmailDir = gmailDataDir(workspace.path);
  const pendingFile = join(gmailDir, "pending_auth.json");

  // Validate the CSRF state token against the saved pending-auth file.
  type PendingAuth = { state: string; redirect_uri: string; created_at: number };
  let pendingAuth: PendingAuth | null = null;
  try {
    const raw = await readFile(pendingFile, "utf8");
    pendingAuth = JSON.parse(raw) as PendingAuth;
  } catch {
    return gmailOAuthErrorHtml(
      "No pending authorization found. Please start the Gmail authorization flow again from the configuration."
    );
  }

  if (pendingAuth === null || pendingAuth.state !== state) {
    return gmailOAuthErrorHtml("Invalid state token. This may be a CSRF attempt. Please try again.");
  }

  // Expire pending auth entries older than 10 minutes.
  if (Date.now() / 1000 - pendingAuth.created_at > 600) {
    return gmailOAuthErrorHtml(
      "The authorization session has expired (> 10 minutes). Please start the flow again."
    );
  }

  const { redirect_uri } = pendingAuth;

  // Remove old tokens, paused or not, before exchange so status reflects failure correctly.
  await removeGmailTokens(gmailDir);

  // Exchange the authorization code for tokens by calling the email sync script with --complete-auth.
  try {
    console.info(`[gmail-oauth] launch intent command=email_sync.py --complete-auth cwd=${scriptDir}`);
    // egress-surface: openwork_gmail_uv_install
    const proc = Bun.spawn(
      gmailScriptCommand("email_sync.py", [
        "--complete-auth", code,
        "--redirect-uri", redirect_uri,
        "--state", state,
      ]),
      { cwd: scriptDir, env: gmailUvEnv(), stdout: "pipe", stderr: "ignore", windowsHide: true }
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error(`[gmail-oauth] token exchange failed (exit ${exitCode})`);
      return gmailOAuthErrorHtml(TOKEN_EXCHANGE_FAILED);
    }
    console.info("[gmail-oauth] launch success command=email_sync.py --complete-auth");
  } catch {
    console.error("[gmail-oauth] token exchange could not be completed");
    return gmailOAuthErrorHtml(TOKEN_EXCHANGE_FAILED);
  }

  return GMAIL_OAUTH_SUCCESS_HTML;
}

type GmailApiState = "enabled" | "disabled" | "not_granted" | "unknown";
type GmailApiStatus = { gmail: GmailApiState; calendar: GmailApiState };

const API_STATES: readonly string[] = ["enabled", "disabled", "not_granted", "unknown"];
const CHECK_APIS_TIMEOUT_MS = 30_000;
// email_sync.py's NOT_AUTHORIZED_EXIT. Any other failure, such as a crash or a refresh that
// could not reach Google, is a failed check, not a reason to sign in again.
const GMAIL_NOT_AUTHORIZED_EXIT = 3;

/**
 * Whether the Gmail and Calendar APIs answer for the saved token. Settings polls this after
 * sign-in: a project that has not turned an API on still signs in fine, and only fails later.
 */
export async function checkGmailApis(
  scriptDir: string,
  timeoutMs = CHECK_APIS_TIMEOUT_MS,
): Promise<GmailApiStatus> {
  // egress-surface: openwork_gmail_uv_install
  const proc = Bun.spawn(gmailScriptCommand("email_sync.py", ["--check-apis"]), {
    cwd: scriptDir,
    env: gmailUvEnv(),
    stdout: "pipe",
    stderr: "ignore",
    windowsHide: true,
  }) as unknown as { exited: Promise<number>; stdout: ReadableStream<Uint8Array>; kill: () => void };
  // The Google client sets no network timeout, and a stalled check would stop the
  // setup guide asking again. Raced, not just killed: under `uv run` the Python
  // child can hold stdout open after its parent dies.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already exited */ }
      reject(new ApiError(504, "gmail_api_check_timeout", "Checking the Gmail and Calendar APIs timed out."));
    }, timeoutMs);
  });
  let exitCode: number;
  let stdout: string;
  try {
    [exitCode, stdout] = await Promise.race([
      Promise.all([proc.exited, new Response(proc.stdout).text()]),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (exitCode === GMAIL_NOT_AUTHORIZED_EXIT) {
    throw new ApiError(409, "gmail_not_authorized", "Gmail is not authorized yet.");
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? "");
    if (exitCode === 0 && value && typeof value === "object") parsed = value as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    throw new ApiError(500, "gmail_api_check_failed", "Could not check the Gmail and Calendar APIs.");
  }
  const state = (value: unknown): GmailApiState =>
    typeof value === "string" && API_STATES.includes(value) ? (value as GmailApiState) : "unknown";
  return { gmail: state(parsed.gmail), calendar: state(parsed.calendar) };
}
