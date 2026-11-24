/**
 * GitHub CLI (`gh`) credential store for the sandbox.
 *
 * A thin wrapper over the `gh` binary; this never installs anything. The
 * Windows-native payload ships gh and the broker names it in `SUPERCLAW_GH_BIN`
 * (EG1-11), so a developer's own gh on PATH cannot stand in for it; elsewhere
 * `gh` on PATH is used. `gh` owns the store ($GH_CONFIG_DIR/hosts.yml) - we never
 * hand-write it and never return the token, so callers get a login name and a
 * scope list. On native the broker sets `GH_CONFIG_DIR` to a directory in the
 * file_tool tier's data, shared with the agent's gh. Without it there is no
 * fallback: the old `/config/gh` default is `C:\config\gh` on Windows, readable by
 * every local account, so GitHub sign-in fails with `github_unavailable` and says so.
 *
 * `loginWithToken` is the single write path, and goes through
 * `gh auth login --with-token` so an invalid credential is rejected here rather
 * than mid-task. The browser sign-in in github-device-flow.ts ends up here too.
 * The token goes in hosts.yml, never the OS keyring: the tier account has no
 * profile to hold one, and the agent's gh must find it in the same store.
 *
 * GitHub sign-in is a registered direct exception in egress phase 1; on a proxied
 * network gh reaches github.com through the proxy the broker passes in.
 *
 * `GH_TOKEN` / `GITHUB_TOKEN` outrank the stored credential for any `gh` that
 * inherits them, so both are scrubbed from our calls.
 *
 * Pausing (the Connections toggle) moves hosts.yml aside to hosts.yml.paused in
 * the same store, so neither this server's gh nor the agent's finds a sign-in;
 * resuming moves it back. A new sign-in or a sign-out drops the paused copy.
 */

import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ApiError } from "./errors.js";

/** The payload's gh on native, by absolute path; `gh` on PATH elsewhere. */
function ghBin(): string {
  return process.env.SUPERCLAW_GH_BIN?.trim() || "gh";
}

/** Shared with github-device-flow.ts, which authorizes against the same host. */
export const GITHUB_HOST = "github.com";

export type GithubAuthStatus = {
  /** Whether `gh` can be used here: false when the binary is missing, and also
   * when GitHub is unavailable, in which case `unavailableReason` says why. */
  installed: boolean;
  authenticated: boolean;
  login: string | null;
  scopes: string[];
  /** Why GitHub cannot be used in this sandbox; null when it can. */
  unavailableReason: string | null;
  /** A sign-in an older build left in the legacy store, which can still be removed. */
  legacyCredential: boolean;
  /** A sign-in the user paused: kept in the store, and found by no gh until resumed. */
  paused: boolean;
};

type GhResult = { exitCode: number; stdout: string; stderr: string };

const GITHUB_UNAVAILABLE_MESSAGE =
  "GitHub sign-in is not available in this version of SuperClaw, because it has no protected place to keep the GitHub token.";

/** How gh reports a request that never reached GitHub, as opposed to an answer. */
const GH_NETWORK_FAILURE =
  /error connecting to|dial tcp|i\/o timeout|no such host|connection refused|connection reset|proxyconnect|tls handshake timeout|context deadline exceeded|network is unreachable/i;

/** Where gh keeps hosts.yml. Reported in audit records so a credential write is
 * traceable to a path. Throws `github_unavailable` when no store was provided. */
export function githubConfigDir(): string {
  const dir = process.env.GH_CONFIG_DIR?.trim();
  if (!dir) throw new ApiError(503, "github_unavailable", GITHUB_UNAVAILABLE_MESSAGE);
  return dir;
}

/**
 * The store builds before this one fell back to when `GH_CONFIG_DIR` was unset
 * (`C:\config\gh` on Windows). Never written to again; read only so a sign-in left
 * there can still be removed. Mutable only for the test seam below.
 */
let legacyConfigDir = "/config/gh";

export function setLegacyGithubConfigDirForTests(dir: string): void {
  legacyConfigDir = dir;
}

function legacySignInPresent(): boolean {
  return existsSync(join(legacyConfigDir, "hosts.yml"));
}

const PAUSED_HOSTS_FILE = "hosts.yml.paused";

function pausedSignInPresent(configDir: string): boolean {
  return existsSync(join(configDir, PAUSED_HOSTS_FILE)) && !existsSync(join(configDir, "hosts.yml"));
}

/**
 * Pause or resume the stored sign-in without removing it. Throws
 * `github_not_connected` when there is neither a sign-in nor a paused one to switch.
 */
export async function setGithubEnabled(enabled: boolean): Promise<GithubAuthStatus> {
  const dir = githubConfigDir();
  const active = join(dir, "hosts.yml");
  const paused = join(dir, PAUSED_HOSTS_FILE);
  if (enabled) {
    if (existsSync(active)) rmSync(paused, { force: true });
    else if (existsSync(paused)) renameSync(paused, active);
    else throw new ApiError(409, "github_not_connected", "There is no GitHub sign-in to switch on.");
  } else if (existsSync(active)) {
    renameSync(active, paused);
  } else if (!existsSync(paused)) {
    throw new ApiError(409, "github_not_connected", "There is no GitHub sign-in to switch off.");
  }
  return readGithubAuthStatus();
}

/** The stores a sign-out removes from: the configured one, and the legacy one while
 * a sign-in an older build left there is present (or when no store is configured).
 * Upgrades keep the legacy file, readable by every local account, so it is removed
 * alongside rather than only while GitHub is unavailable. Removing stores nothing,
 * so it does not need a protected store. */
export function githubLogoutTargets(): string[] {
  const configured = process.env.GH_CONFIG_DIR?.trim();
  const targets = configured ? [configured] : [];
  if (!configured || legacySignInPresent()) targets.push(legacyConfigDir);
  return targets;
}

async function runGh(
  args: string[],
  options: { stdin?: string; configDir?: string } = {},
): Promise<GhResult> {
  // Strip inherited GitHub tokens so we always act on the stored credential,
  // and disable prompts/update checks so gh can never block on a TTY it does
  // not have.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === "GH_TOKEN" || key === "GITHUB_TOKEN") continue;
    env[key] = value;
  }
  env.GH_PROMPT_DISABLED = "1";
  env.GH_NO_UPDATE_NOTIFIER = "1";
  // Pinned, not inherited, so the store gh writes is always the path
  // githubConfigDir() reports to approvals and audit. An env missing it would
  // put the token under $HOME while the audit record still claims /config.
  env.GH_CONFIG_DIR = options.configDir ?? githubConfigDir();

  // A closure so `proc` keeps the type narrowed by these literal options
  // (stdout/stderr are ReadableStreams because they are "pipe").
  // egress-surface: openwork_github_cli
  const spawnGh = () =>
    Bun.spawn([ghBin(), ...args], {
      env,
      stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
      // The server has no console on Windows, so a console child would flash one (#2694).
      windowsHide: true,
    });

  let proc: ReturnType<typeof spawnGh>;
  try {
    proc = spawnGh();
  } catch (err) {
    throw new ApiError(
      503,
      "github_cli_missing",
      `The GitHub CLI is not available in this sandbox: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * Scopes from `gh auth status`, rendered as
 * `- Token scopes: 'gist', 'read:org', 'repo'`. [] when the line is absent
 * (fine-grained PATs report no classic scopes).
 */
export function parseTokenScopes(authStatusOutput: string): string[] {
  const match = /Token scopes:\s*(.+)/i.exec(authStatusOutput);
  if (!match) return [];
  return Array.from(match[1].matchAll(/'([^']+)'/g), (m) => m[1]);
}

/**
 * Login from `gh auth status`, reported as `account monalisa` on current gh and
 * `as monalisa` on older builds. Reading it here avoids a second `gh api user`
 * round trip on every status poll. Null on an unrecognised format, in which
 * case the UI shows "Connected" without a name.
 */
export function parseAuthStatusLogin(authStatusOutput: string): string | null {
  return /Logged in to \S+ (?:account|as) (\S+)/i.exec(authStatusOutput)?.[1] ?? null;
}

/** Whether the `gh` binary is present and runnable. */
export async function ghInstalled(): Promise<boolean> {
  try {
    return (await runGh(["--version"])).exitCode === 0;
  } catch {
    return false;
  }
}

export async function readGithubAuthStatus(): Promise<GithubAuthStatus> {
  let dir: string;
  try {
    dir = githubConfigDir();
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return {
      installed: false,
      authenticated: false,
      login: null,
      scopes: [],
      unavailableReason: err.message,
      legacyCredential: legacySignInPresent(),
      paused: false,
    };
  }
  const paused = pausedSignInPresent(dir);

  // One subprocess, not two: a missing binary makes runGh throw, so this read
  // doubles as the install probe. It is polled every few seconds during sign-in.
  let status: GhResult;
  try {
    status = await runGh(["auth", "status", "--hostname", GITHUB_HOST]);
  } catch {
    return { installed: false, authenticated: false, login: null, scopes: [], unavailableReason: null, legacyCredential: legacySignInPresent(), paused };
  }
  if (status.exitCode !== 0) {
    return { installed: true, authenticated: false, login: null, scopes: [], unavailableReason: null, legacyCredential: legacySignInPresent(), paused };
  }

  // `gh auth status` writes its human-readable report to stderr in some
  // versions and stdout in others; scan both rather than depend on which.
  const report = `${status.stdout}\n${status.stderr}`;
  return {
    installed: true,
    authenticated: true,
    login: parseAuthStatusLogin(report),
    scopes: parseTokenScopes(report),
    unavailableReason: null,
    legacyCredential: legacySignInPresent(),
    paused: false,
  };
}

/**
 * Store `token` as the gh credential for github.com. gh validates it against
 * the API first, so an invalid or under-scoped token is rejected here.
 */
export async function loginWithToken(token: string): Promise<GithubAuthStatus> {
  const trimmed = token.trim();
  if (!trimmed) throw new ApiError(400, "invalid_payload", "token is required");

  const result = await runGh(
    ["auth", "login", "--hostname", GITHUB_HOST, "--with-token", "--insecure-storage"],
    { stdin: `${trimmed}\n` },
  );
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    // gh validates the token against the API, so a dead connection fails here too.
    if (GH_NETWORK_FAILURE.test(detail)) {
      throw new ApiError(
        502,
        "github_unreachable",
        `Could not reach GitHub to check the token (${detail}). The token was not rejected; check the network or proxy settings, then try again.`,
      );
    }
    throw new ApiError(
      400,
      "github_token_rejected",
      detail || "GitHub rejected the token. Check that it is valid and has the 'repo' scope.",
    );
  }
  // The new sign-in supersedes one an older build left where every local account can read it.
  await removeLegacySignIn();
  rmSync(join(githubConfigDir(), PAUSED_HOSTS_FILE), { force: true });
  return readGithubAuthStatus();
}

/** Remove a sign-in an older build left in the legacy store: through gh where it
 * can (a keyring token is only reachable that way), and then the legacy hosts.yml
 * itself, so a missing gh cannot leave it behind. */
async function removeLegacySignIn(): Promise<void> {
  if (!legacySignInPresent()) return;
  try {
    await runGh(["auth", "logout", "--hostname", GITHUB_HOST], { configDir: legacyConfigDir });
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
  }
  rmSync(join(legacyConfigDir, "hosts.yml"), { force: true });
}

/** Drop the stored credential, and any sign-in an older build left in the legacy
 * store. Idempotent: a no-credential logout is a success. */
export async function logoutGithub(): Promise<void> {
  await removeLegacySignIn();
  const configured = process.env.GH_CONFIG_DIR?.trim();
  if (!configured) return;
  rmSync(join(configured, PAUSED_HOSTS_FILE), { force: true });
  const result = await runGh(["auth", "logout", "--hostname", GITHUB_HOST]);
  if (result.exitCode === 0) return;
  const detail = `${result.stdout}\n${result.stderr}`;
  if (/not logged in|no accounts|no authenticated/i.test(detail)) return;
  throw new ApiError(500, "github_logout_failed", detail.trim() || "Failed to sign out of GitHub");
}
