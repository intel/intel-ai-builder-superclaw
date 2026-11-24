import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";

import { isTauriRuntime } from "../utils";
import { openUrl } from "./settings.platform-actions";
import type {
  GmailApiStatus,
  GmailCredentialStatus,
  GmailUploadOutcome,
} from "./settings.gmail-credentials";

export const GMAIL_CREATE_CLIENT_URL = "https://console.cloud.google.com/auth/clients/create";
/** The manual path's page: older and plainer than the Auth Platform pages. */
export const GMAIL_CREDENTIALS_URL = "https://console.cloud.google.com/apis/credentials";

/** People is optional (the owner's display name); listing it costs the user no extra click. */
export function gmailEnableApisUrl(projectId: string | null): string {
  const url =
    "https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,people.googleapis.com";
  return projectId ? `${url}&project=${encodeURIComponent(projectId)}` : url;
}

const WATCH_INTERVAL_MS = 2000;
/** Each API check starts a Python process, so ask less often once the user has been away a while. */
const apiCheckDelay = (waitedMs: number) => (waitedMs < 60_000 ? 5000 : 20_000);
const NO_FILE_HINT_MS = 90_000;

export type GmailGuideStep = "client" | "signin" | "apis";

export type GmailClientDownload = {
  name: string;
  content: string;
  modifiedMs: number;
};

type GuideState = {
  /** The server and workspace setup was started for; nothing resumes on another. */
  scope: string | null;
  /** Downloads files written at or before this are not the new client. */
  watchSince: number;
  startedAt: number;
  /** From the downloaded client, so the enable page opens on the same project. */
  projectId: string | null;
  enablePageOpened: boolean;
};

type GmailSetupGuideDeps = {
  scope: () => string | null;
  status: () => GmailCredentialStatus | null;
  upload: (file: File) => Promise<GmailUploadOutcome>;
  busy: () => boolean;
  startAuth: () => Promise<void>;
  checkApis: () => Promise<GmailApiStatus | null>;
  /** Called once Gmail and Calendar both answer. */
  onDone?: () => void;
  findDownload?: ((sinceMs: number) => Promise<GmailClientDownload | null>) | null;
  /** `content` is what was uploaded: a file that changed since is not deleted. */
  removeDownload?: ((name: string, content: string) => Promise<void>) | null;
  now?: () => number;
};

/** `scope` is the server and workspace that holds the uploaded copy. */
type Leftover = { scope: string | null; name: string; content: string };

/** The last API answer, for one workspace and one uploaded client (`updatedAt`). */
type ApiCheck = {
  scope: string | null;
  updatedAt: number | null;
  result: GmailApiStatus;
  projectId: string | null;
};

export type GmailSetupGuide = ReturnType<typeof createGmailSetupGuide>;

// Outlives the card: closing Settings mid-setup must not move the cutoff, or the
// client JSON downloaded meanwhile would count as "already there" on return.
let savedState: GuideState | null = null;
// The uploaded client JSON still sitting in Downloads, offered for removal afterwards.
let savedLeftover: Leftover | null = null;
// Outlives the card too, so reopening Settings does not call a known problem "ready".
let savedCheck: ApiCheck | null = null;

async function findDownloadInTauri(sinceMs: number): Promise<GmailClientDownload | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<GmailClientDownload | null>("find_gmail_client_download", { sinceMs });
}

async function removeDownloadInTauri(name: string, content: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("remove_gmail_client_download", { name, content });
}

const clientFile = (download: GmailClientDownload) =>
  new File([download.content], download.name, { type: "application/json" });

function projectIdOf(content: string): string | null {
  try {
    const root = JSON.parse(content) as Record<string, { project_id?: unknown } | undefined>;
    const projectId = (root.installed ?? root.web)?.project_id;
    return typeof projectId === "string" && projectId ? projectId : null;
  } catch {
    return null;
  }
}

/**
 * Guided Gmail setup. The user creates a Desktop client; its JSON is uploaded as soon as
 * it lands in Downloads, which starts the browser sign-in. Once signed in, SuperClaw asks
 * Google whether Gmail and Calendar answer, and if not opens the enable page on the
 * client's own project and keeps asking until they do. Nothing waits on a Next button.
 */
export function createGmailSetupGuide(deps: GmailSetupGuideDeps) {
  const now = deps.now ?? Date.now;
  const tauri = isTauriRuntime();
  const findDownload =
    deps.findDownload !== undefined ? deps.findDownload : tauri ? findDownloadInTauri : null;
  const removeDownload =
    deps.removeDownload !== undefined ? deps.removeDownload : tauri ? removeDownloadInTauri : null;
  const [state, setStateSignal] = createSignal<GuideState | null>(savedState);
  const [clock, setClock] = createSignal(now());
  const [check, setCheckSignal] = createSignal<ApiCheck | null>(savedCheck);
  const [existing, setExisting] = createSignal<GmailClientDownload | null>(null);
  const [leftover, setLeftoverSignal] = createSignal<Leftover | null>(savedLeftover);

  const setState = (next: GuideState | null) => {
    savedState = next;
    setStateSignal(next);
  };
  const setLeftover = (next: Leftover | null) => {
    savedLeftover = next;
    setLeftoverSignal(next);
  };
  const setCheck = (next: ApiCheck | null) => {
    savedCheck = next;
    setCheckSignal(next);
  };
  // Taken before the request: an answer that comes back for another workspace or a
  // replaced client is dropped.
  const checkTarget = () => ({ scope: deps.scope(), updatedAt: deps.status()?.updatedAt ?? null });
  type CheckTarget = ReturnType<typeof checkTarget>;
  const stillTarget = (target: CheckTarget) => {
    const now = checkTarget();
    return now.scope === target.scope && now.updatedAt === target.updatedAt;
  };
  const recordCheck = (result: GmailApiStatus, target: CheckTarget) => {
    const prev = check();
    const sameClient = prev?.scope === target.scope && prev?.updatedAt === target.updatedAt;
    // An inconclusive answer (Google unreachable) does not clear a known problem.
    const keep = (api: keyof GmailApiStatus) =>
      result[api] === "unknown" && prev && sameClient ? prev.result[api] : result[api];
    setCheck({
      ...target,
      result: { gmail: keep("gmail"), calendar: keep("calendar") },
      projectId: state()?.projectId ?? check()?.projectId ?? null,
    });
  };
  // An answer about another workspace or an earlier client says nothing about this one.
  const apiStatus = () => {
    const c = check();
    const status = deps.status();
    if (!c || !status?.hasToken || c.scope !== deps.scope()) return null;
    return c.updatedAt === status.updatedAt ? c.result : null;
  };
  const keepFile = (found: GmailClientDownload) =>
    setLeftover({ scope: deps.scope(), name: found.name, content: found.content });
  // Offered only where SuperClaw holds the copy, so "keeps its own copy" stays true.
  const scopedLeftover = () => {
    const left = leftover();
    return left && left.scope === deps.scope() ? left : null;
  };
  const uploaded = () => deps.status()?.hasCredentials === true;
  const patch = (changes: Partial<GuideState>) => {
    const s = state();
    if (s) setState({ ...s, ...changes });
  };

  // Setup started for another server or workspace stays saved but idle here, so a
  // client downloaded for it is never sent to this one.
  const active = createMemo(() => {
    const s = state();
    return s !== null && s.scope === deps.scope();
  });
  // No step until the status is known: reopened mid-setup, an unknown status read as
  // "no client yet" would watch Downloads and could replace the uploaded client.
  // Paused hides the token, so the sign-in step would undo the pause; the progress waits for a resume.
  const step = createMemo<GmailGuideStep | null>(() => {
    const status = deps.status();
    if (!active() || !status || status.paused) return null;
    if (status.hasToken) return "apis";
    return status.hasCredentials ? "signin" : "client";
  });
  const canWatch = findDownload !== null;

  const showNoFileHint = () => {
    const s = state();
    if (!s || step() !== "client") return false;
    return !canWatch || clock() - s.startedAt >= NO_FILE_HINT_MS;
  };

  /** True once an API is known to be off, so the card can say where to turn it on. */
  const apisDisabled = () => {
    const s = apiStatus();
    return s?.gmail === "disabled" || s?.calendar === "disabled";
  };
  /** True when the sign-in expired or left out Gmail or Calendar; only signing in again fixes that. */
  const accessMissing = () => {
    const s = apiStatus();
    return [s?.gmail, s?.calendar].some((v) => v === "not_granted" || v === "signed_out");
  };
  const signedOut = () => apiStatus()?.gmail === "signed_out";

  const begin = (projectId: string | null) => {
    const at = now();
    setClock(at);
    setCheck(null);
    setLeftover(null);
    setState({
      scope: deps.scope(),
      watchSince: at,
      startedAt: at,
      projectId,
      enablePageOpened: false,
    });
  };

  const start = async () => {
    begin(null);
    await openUrl(GMAIL_CREATE_CLIENT_URL);
  };

  /** For a client file the user already has: upload it, then sign in and check the APIs. */
  const startFromFile = async (file: File) => {
    await deps.upload(file);
    if (uploaded()) begin(projectIdOf(await file.text()));
  };

  const useExisting = async () => {
    const found = existing();
    if (!found) return;
    setExisting(null);
    await startFromFile(clientFile(found));
    if (uploaded()) keepFile(found);
  };

  const removeLeftover = async () => {
    const left = scopedLeftover();
    if (!left || !removeDownload) return;
    try {
      await removeDownload(left.name, left.content);
      setLeftover(null);
    } catch (err) {
      console.warn("Gmail setup: removing the downloaded client failed:", err);
    }
  };

  const reopen = async () => {
    const current = step();
    if (current === "client") await openUrl(GMAIL_CREATE_CLIENT_URL);
    else if (current === "signin" || (current === "apis" && accessMissing())) await deps.startAuth();
    else if (current === "apis") await openUrl(gmailEnableApisUrl(state()?.projectId ?? null));
  };

  // The last API answer outlives the guide, so cancelling does not read as "ready".
  const stop = () => setState(null);

  /** Back to the API step after a cancel, on the same project, checking again from the start. */
  const resume = () => begin(check()?.projectId ?? null);

  let watching = false;
  const watchDownloads = async () => {
    setClock(now());
    const s = state();
    if (!s || !findDownload || watching || deps.busy() || step() !== "client") return;
    watching = true;
    try {
      const found = await findDownload(s.watchSince);
      // Cancelled, restarted or switched to another workspace during the lookup.
      if (!found || state() !== s || step() !== "client") return;
      patch({ projectId: projectIdOf(found.content) });
      const outcome = await deps.upload(clientFile(found));
      // A file the server could not take for now is tried again on the next scan. A
      // rejected one leaves its error up and the guide waits for a newer download.
      if (outcome !== "failed") patch({ watchSince: found.modifiedMs });
      if (uploaded()) keepFile(found);
    } catch (err) {
      console.warn("Gmail setup: reading Downloads failed:", err);
    } finally {
      watching = false;
    }
  };

  let checking = false;
  const checkApis = async () => {
    if (checking || step() !== "apis") return;
    checking = true;
    try {
      const target = checkTarget();
      const run = state();
      const result = await deps.checkApis();
      // A restarted guide or a replaced client must not be completed by this answer.
      if (!result || state() !== run || step() !== "apis" || !stillTarget(target)) return;
      recordCheck(result, target);
      if (result.gmail === "enabled" && result.calendar === "enabled") {
        stop();
        deps.onDone?.();
        return;
      }
      const s = state();
      if (s && !s.enablePageOpened && (result.gmail === "disabled" || result.calendar === "disabled")) {
        patch({ enablePageOpened: true });
        await openUrl(gmailEnableApisUrl(s.projectId));
      }
    } finally {
      checking = false;
    }
  };

  /** Runs `run` while the guide is on `target`, again after `delay(waitedMs)`, and on window focus. */
  const onStep = (
    target: GmailGuideStep,
    run: () => Promise<void>,
    delay: (waitedMs: number) => number,
  ) => {
    // A failed run (the browser did not open) must not end the polling.
    const runSafely = async () => {
      try {
        await run();
      } catch (err) {
        console.warn(`Gmail setup: the ${target} step failed:`, err);
      }
    };
    createEffect(() => {
      if (step() !== target) return;
      const since = now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let live = true;
      const loop = async () => {
        await runSafely();
        if (live) timer = setTimeout(() => void loop(), delay(now() - since));
      };
      untrack(() => void loop());
      const onFocus = () => void runSafely();
      window.addEventListener("focus", onFocus);
      onCleanup(() => {
        live = false;
        clearTimeout(timer);
        window.removeEventListener("focus", onFocus);
      });
    });
  };

  if (findDownload) onStep("client", watchDownloads, () => WATCH_INTERVAL_MS);
  onStep("apis", checkApis, apiCheckDelay);

  // A known problem is asked about once more when the card opens on it, so one fixed
  // in the meantime does not stay on screen. One process per open, only in that case.
  const blockedWhileIdle = createMemo(() => !active() && (apisDisabled() || accessMissing()));
  let rechecked = false;
  const recheck = async () => {
    try {
      const target = checkTarget();
      const result = await deps.checkApis();
      if (result && !active() && stillTarget(target)) recordCheck(result, target);
    } catch (err) {
      console.warn("Gmail setup: checking the APIs again failed:", err);
    }
  };
  createEffect(() => {
    if (rechecked || !blockedWhileIdle()) return;
    rechecked = true;
    untrack(() => void recheck());
  });

  // A client file already in Downloads, offered on the idle card for one-click setup.
  const idleWithoutCredentials = createMemo(
    () => !active() && deps.status()?.hasCredentials === false,
  );
  createEffect(() => {
    if (!idleWithoutCredentials() || !findDownload) {
      setExisting(null);
      return;
    }
    untrack(() => {
      findDownload(0)
        .then((found) => setExisting(idleWithoutCredentials() ? found : null))
        .catch(() => setExisting(null));
    });
  });

  return {
    step,
    canWatch,
    showNoFileHint,
    apisDisabled,
    accessMissing,
    signedOut,
    existing,
    leftover: () => scopedLeftover()?.name ?? null,
    canRemoveLeftover: removeDownload !== null,
    start,
    startFromFile,
    useExisting,
    removeLeftover,
    keepLeftover: () => setLeftover(null),
    reopen,
    resume,
    stop,
  };
}
