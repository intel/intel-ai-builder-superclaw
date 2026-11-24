/**
 * GitHub browser sign-in: the OAuth device-authorization flow (RFC 8628).
 *
 * This is the only browser-based option that works here, because the credential
 * has to land inside a sandbox with no browser and no interactive terminal.
 * The user approves a short code on github.com; we poll for the resulting token
 * and hand it to github-auth.ts, which is what actually stores it.
 *
 * State is one in-memory flow at a time (`activeFlow`). Nothing is persisted, so
 * a restart simply loses a pending code - acceptable, since the code
 * is short-lived and re-minting it is one click.
 */

import { ApiError } from "./errors.js";
import { GITHUB_HOST, ghInstalled, githubConfigDir, loginWithToken } from "./github-auth.js";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const DEVICE_TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * The GitHub CLI's own public OAuth app, so the consent screen reads "GitHub
 * CLI" and the token is exactly what `gh auth login` would mint. Device flow
 * needs no client secret.
 */
const CLIENT_ID = "178c6fc778ccc68e1d6a";

/**
 * `repo` covers the agent's issue/PR work; `read:org` is required by `gh auth
 * login`'s own validation of classic credentials; `read:project` lets the agent
 * read Projects boards, which issue triage routinely needs and which `repo`
 * alone does not grant. All three are read-or-write on data the user already
 * owns, and stay narrower than gh's default, which also asks for `gist` and
 * `workflow`. The github skill's troubleshooting table covers the resulting
 * push rejection on `.github/workflows/**`.
 */
const DEVICE_SCOPES = "repo read:org read:project";

/** GitHub returns an `interval`; clamp it so a hostile/absent value can neither
 * busy-spin nor stall the poll loop. Mirrors the Copilot device flow bounds.
 * Mutable only for the test seam below; production never reassigns them. */
let pollMinIntervalS = 5;
let pollMaxIntervalS = 30;

/**
 * Lets the suite drive the loop without waiting out GitHub's protocol-minimum
 * 5s interval, the same way the Copilot flow's tests patch
 * COPILOT_POLL_MIN_INTERVAL. Without it the cancel/supersede races below are
 * only reachable by sleeping through a real interval per assertion.
 */
export function setPollIntervalBoundsForTests(minS: number, maxS: number): void {
  pollMinIntervalS = minS;
  pollMaxIntervalS = maxS;
}

const FETCH_TIMEOUT_MS = 30_000;

/** The code for a request that never reached GitHub, as opposed to an answer. */
const UNREACHABLE = "github_device_unreachable";

/**
 * Only ever describes a *live or failed* flow. A flow that succeeds is dropped,
 * because "the account is connected" is already carried by
 * `GithubAuthStatus.authenticated`; keeping a second signal meant every later
 * status read replayed a stale success to the UI.
 */
export type GithubDeviceFlowState = {
  status: "not_started" | "awaiting_authorization" | "error";
  userCode: string | null;
  verificationUri: string | null;
  /** Epoch ms at which the user code stops being redeemable. */
  expiresAt: number | null;
  error: { code: string; message: string } | null;
};

type DeviceFlow = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalS: number;
  expiresAt: number;
  status: Exclude<GithubDeviceFlowState["status"], "not_started">;
  error: { code: string; message: string } | null;
};

// One flow at a time. A fresh start() replaces any prior flow, which is the
// unambiguous reading of the user clicking "sign in" again.
let activeFlow: DeviceFlow | null = null;

/** Read a string field out of an untyped JSON body, "" when absent or wrong type. */
function strField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

/**
 * Checked, not trusted, for the same reason `interval` is clamped: the body is
 * only as trustworthy as the connection. This is the one field handed to the
 * user's real browser, so a substituted host would be a phishing page we opened.
 * `host` rather than `hostname` so an explicit port cannot ride along.
 */
function isGithubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.host === GITHUB_HOST;
  } catch {
    return false;
  }
}

/**
 * Whether `flow` is still the one the user is waiting on. Each poll loop is
 * detached and holds its own reference, so identity against the single slot is
 * how a retired loop learns to stop instead of racing the flow that replaced it
 * to store a credential.
 */
function isCurrentFlow(flow: DeviceFlow): boolean {
  return activeFlow === flow;
}

function flowState(flow: DeviceFlow | null): GithubDeviceFlowState {
  if (!flow) {
    return { status: "not_started", userCode: null, verificationUri: null, expiresAt: null, error: null };
  }
  const { status, userCode, verificationUri, expiresAt, error } = flow;
  return { status, userCode, verificationUri, expiresAt, error };
}

function failFlow(flow: DeviceFlow, code: string, message: string): void {
  flow.status = "error";
  flow.error = { code, message };
  console.warn(`[github-auth] device flow failed code=${code}`);
}

async function postForm(url: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
  console.info(`[github-auth] external access intent url=${url} host=${GITHUB_HOST}`);
  let response: Response;
  try {
    // egress-surface: openwork_github_device_flow
    response = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    // A connection that never lands (or times out) would otherwise escape as a
    // bare TypeError and reach the card as "Unexpected server error" (#2873).
    const cause = err instanceof Error ? err.message : String(err);
    throw new ApiError(
      502,
      UNREACHABLE,
      `Could not reach GitHub (${cause}). Check the network or proxy settings, then try again.`,
      { cause },
    );
  }
  if (!response.ok) {
    throw new ApiError(502, "github_device_unavailable", `GitHub returned HTTP ${response.status}`);
  }
  // Wrapped, not left as a bare SyntaxError: pollDeviceFlow tells an answer from
  // a connection that never landed by the error's code, so an unreadable body
  // would otherwise be reported as "could not reach GitHub" about a request that
  // demonstrably arrived.
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ApiError(502, "github_device_unavailable", `GitHub's response could not be read (${detail})`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError(502, "github_device_unavailable", "GitHub returned an unexpected response");
  }
  return payload as Record<string, unknown>;
}

export async function startGithubDeviceLogin(): Promise<GithubDeviceFlowState> {
  // Before the gh probe, which reports any failure as a missing binary: with no
  // protected store the real reason is that the token has nowhere to land.
  githubConfigDir();
  // A binary probe, not readGithubAuthStatus(), which would add a GitHub round
  // trip to a path the user is waiting on.
  if (!(await ghInstalled())) {
    throw new ApiError(503, "github_cli_missing", "The GitHub CLI is not available in this sandbox");
  }

  // The previous flow is retired by `activeFlow = flow` below, not here:
  // cancelling up front would discard a valid code if this request then failed.
  const payload = await postForm(DEVICE_CODE_URL, { client_id: CLIENT_ID, scope: DEVICE_SCOPES });
  const deviceCode = strField(payload, "device_code");
  const userCode = strField(payload, "user_code");
  const verificationUri = strField(payload, "verification_uri");
  if (!deviceCode || !userCode || !verificationUri) {
    throw new ApiError(502, "github_device_unavailable", "GitHub's device-code response was incomplete");
  }
  if (!isGithubUrl(verificationUri)) {
    throw new ApiError(
      502,
      "github_device_unavailable",
      "GitHub's device-code response pointed at an unexpected sign-in address, so it was not opened",
    );
  }

  const rawInterval = typeof payload.interval === "number" ? payload.interval : pollMinIntervalS;
  const expiresInS = typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : 900;
  const flow: DeviceFlow = {
    deviceCode,
    userCode,
    verificationUri,
    intervalS: Math.min(Math.max(rawInterval, pollMinIntervalS), pollMaxIntervalS),
    expiresAt: Date.now() + expiresInS * 1000,
    status: "awaiting_authorization",
    error: null,
  };
  activeFlow = flow;
  console.info(`[github-auth] device flow started expires_in=${expiresInS}s`);
  void pollDeviceFlow(flow);
  return flowState(flow);
}

export function githubDeviceLoginState(): GithubDeviceFlowState {
  return flowState(activeFlow);
}

export function cancelGithubDeviceLogin(): void {
  activeFlow = null;
}

async function pollDeviceFlow(flow: DeviceFlow): Promise<void> {
  // Cleared on every answer, so expiry can tell "the user never approved" from
  // "we never got through". Only the latest outcome matters: a flow that reaches
  // GitHub once and then loses the proxy is an egress failure, not a slow user.
  let lastTransientError: string | null = null;
  // Whether that last failure arrived as an HTTP answer rather than a connection
  // that never landed. Neither changes the loop; it only picks the wording at
  // expiry, since "could not reach GitHub (HTTP 502)" contradicts itself.
  let lastErrorWasFromGithub = false;

  while (isCurrentFlow(flow) && Date.now() < flow.expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, flow.intervalS * 1000));
    if (!isCurrentFlow(flow)) return;

    let payload: Record<string, unknown>;
    try {
      payload = await postForm(DEVICE_TOKEN_URL, {
        client_id: CLIENT_ID,
        device_code: flow.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      lastTransientError = null;
    } catch (err) {
      // Transient network/proxy blip: keep polling until the code expires. A 5xx
      // or an unreadable body is retried too — GitHub having a bad minute is not
      // a reason to make the user re-approve a code that is still valid.
      const cause = err instanceof ApiError ? (err.details as { cause?: unknown } | undefined)?.cause : undefined;
      lastTransientError = typeof cause === "string" ? cause : err instanceof Error ? err.message : String(err);
      lastErrorWasFromGithub = err instanceof ApiError && err.code !== UNREACHABLE;
      console.warn(`[github-auth] device poll transient error: ${lastTransientError}`);
      continue;
    }

    const accessToken = strField(payload, "access_token");
    if (accessToken) {
      // Re-checked after the round trip: a Cancel can land while it is in flight,
      // and storing now would connect an account the user just declined. Not
      // airtight — a cancel during the store below still writes hosts.yml.
      if (!isCurrentFlow(flow)) {
        console.info("[github-auth] device flow retired before store; discarding token");
        return;
      }
      try {
        await loginWithToken(accessToken);
      } catch (err) {
        failFlow(flow, "github_store_failed", err instanceof Error ? err.message : String(err));
        return;
      }
      // From here the account is described by readGithubAuthStatus(); a terminal
      // "success" left behind would replay on every later status read.
      if (isCurrentFlow(flow)) activeFlow = null;
      console.info("[github-auth] device flow complete");
      return;
    }

    const error = strField(payload, "error");
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      flow.intervalS = Math.min(flow.intervalS + 5, pollMaxIntervalS);
      continue;
    }
    if (error === "access_denied") {
      failFlow(flow, "user_cancelled", "The GitHub authorization request was denied");
      return;
    }
    if (error === "expired_token") {
      failFlow(flow, "device_code_expired", "The code expired before it was approved. Start again.");
      return;
    }
    failFlow(flow, "device_poll_error", `GitHub returned an unexpected response (${error || "no error code"})`);
    return;
  }

  if (!isCurrentFlow(flow) || flow.status !== "awaiting_authorization") return;

  // A flow whose last word was a failure never got a verdict, so "the code
  // expired" would send the user back to re-approve over and over when the real
  // fault is upstream — a blocked proxy looks exactly like a user who walked away.
  if (lastTransientError) {
    failFlow(
      flow,
      lastErrorWasFromGithub ? "github_device_refused" : UNREACHABLE,
      lastErrorWasFromGithub
        ? `The GitHub sign-in endpoint kept returning errors (${lastTransientError}). The requests are getting through, so this is not a blocked connection — wait a moment, then try again.`
        : `Could not reach GitHub to finish signing in (${lastTransientError}). Check the network or proxy settings, then try again.`,
    );
    return;
  }
  failFlow(flow, "device_code_expired", "The code expired before it was approved. Start again.");
}
