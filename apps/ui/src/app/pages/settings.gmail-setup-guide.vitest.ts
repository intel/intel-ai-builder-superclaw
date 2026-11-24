import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { GmailApiStatus, GmailCredentialStatus } from "./settings.gmail-credentials";

const openUrl = vi.fn(async (_url: string) => {});

vi.mock("../utils", () => ({ isTauriRuntime: () => false }));
vi.mock("./settings.platform-actions", () => ({
  openUrl: (url: string) => openUrl(url),
}));

const { createGmailSetupGuide, gmailEnableApisUrl, GMAIL_CREATE_CLIENT_URL } = await import(
  "./settings.gmail-setup-guide"
);
type GmailClientDownload = import("./settings.gmail-setup-guide").GmailClientDownload;
type GmailSetupGuide = import("./settings.gmail-setup-guide").GmailSetupGuide;

const CLIENT = '{"installed":{"client_id":"1-a","client_secret":"b","project_id":"arbor-42"}}';

let clock = 1_000;
let downloads: GmailClientDownload[] = [];
let uploads: { name: string; text: string }[] = [];
let apiAnswers: (GmailApiStatus | null)[] = [];
let apiChecks = 0;
let authStarts = 0;
let done = 0;
let removed: { name: string; content: string }[] = [];
let serverDown = false;
/** While pending, every API check waits on it. */
let checkGate: Promise<void> = Promise.resolve();
let guide: GmailSetupGuide | undefined;
let dispose: (() => void) | undefined;
const [status, setStatus] = createSignal<GmailCredentialStatus | null>(null);
const [scope, setScope] = createSignal<string | null>(null);
const LOCAL = "http://127.0.0.1:8787/workspace/local/gmail/";

const noCredentials: GmailCredentialStatus = {
  hasCredentials: false,
  hasToken: false,
  fileSize: null,
  updatedAt: null,
};

/** Stands in for the Tauri command: newest file written after the cutoff. */
async function findDownload(sinceMs: number): Promise<GmailClientDownload | null> {
  const fresh = downloads.filter((d) => d.modifiedMs > sinceMs);
  return fresh.sort((a, b) => b.modifiedMs - a.modifiedMs)[0] ?? null;
}

function mount(find: typeof findDownload | null = findDownload): GmailSetupGuide {
  dispose?.();
  guide = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return createGmailSetupGuide({
      scope,
      status,
      upload: async (file) => {
        const text = await file.text();
        uploads.push({ name: file.name, text });
        if (serverDown) return "failed";
        // The server rejects anything that is not an OAuth client.
        if (!text.includes('"installed"')) return "rejected";
        setStatus({ ...noCredentials, hasCredentials: true, updatedAt: clock });
        return "uploaded";
      },
      busy: () => false,
      startAuth: async () => {
        authStarts += 1;
      },
      checkApis: async () => {
        apiChecks += 1;
        await checkGate;
        return apiAnswers.length > 1 ? (apiAnswers.shift() ?? null) : (apiAnswers[0] ?? null);
      },
      onDone: () => {
        done += 1;
      },
      findDownload: find,
      removeDownload: async (name, content) => {
        removed.push({ name, content });
      },
      now: () => clock,
    });
  });
  return guide;
}

const download = (name: string, modifiedMs: number, content = CLIENT) =>
  downloads.push({ name, content, modifiedMs });

const signIn = () =>
  setStatus({ ...(status() ?? noCredentials), hasCredentials: true, hasToken: true });

beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_000;
  downloads = [];
  uploads = [];
  apiAnswers = [];
  apiChecks = 0;
  authStarts = 0;
  done = 0;
  removed = [];
  serverDown = false;
  checkGate = Promise.resolve();
  setStatus(noCredentials);
  setScope(LOCAL);
  openUrl.mockClear();
});

afterEach(() => {
  // resume() starts over, which also drops the saved API answer; stop() then ends it.
  guide?.resume();
  guide?.stop();
  guide?.keepLeftover();
  dispose?.();
  dispose = undefined;
  guide = undefined;
  vi.useRealTimers();
});

/** Lets the intervals run with the clock moved forward. */
async function tick(ms = 2_000) {
  clock += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

describe("createGmailSetupGuide", () => {
  test("opens Google's create-client form on start", async () => {
    const g = mount();
    expect(g.step()).toBeNull();

    await g.start();

    expect(g.step()).toBe("client");
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(GMAIL_CREATE_CLIENT_URL);
  });

  test("uploads a client file downloaded after the guide started, then waits for sign-in", async () => {
    const g = mount();
    await g.start();

    download("client_secret_1.apps.googleusercontent.com.json", clock + 500);
    await tick();

    expect(uploads).toEqual([
      { name: "client_secret_1.apps.googleusercontent.com.json", text: CLIENT },
    ]);
    expect(g.step()).toBe("signin");
  });

  test("ignores a client file that was already in Downloads", async () => {
    download("credentials.json", 900);
    const g = mount();
    await g.start();
    await tick();
    await tick();

    expect(uploads).toEqual([]);
  });

  test("tries each file once, then picks up a newer download", async () => {
    const g = mount();
    await g.start();
    download("credentials.json", clock + 100, '{"type":"service_account"}');
    await tick();
    await tick();
    expect(uploads.map((u) => u.name)).toEqual(["credentials.json"]);
    expect(g.step()).toBe("client");

    download("client_secret_2.json", clock + 100);
    await tick();
    expect(uploads.map((u) => u.name)).toEqual(["credentials.json", "client_secret_2.json"]);
  });

  test("points to the manual path after 90 seconds without a file", async () => {
    const g = mount();
    await g.start();
    expect(g.showNoFileHint()).toBe(false);

    await tick(60_000);
    expect(g.showNoFileHint()).toBe(false);

    await tick(30_000);
    expect(g.showNoFileHint()).toBe(true);
  });

  test("points to the manual path at once when Downloads cannot be watched", async () => {
    const g = mount(null);
    expect(g.canWatch).toBe(false);
    await g.start();

    expect(g.showNoFileHint()).toBe(true);
  });

  test("keeps its cutoff when Settings is closed and reopened mid-setup", async () => {
    const g = mount();
    await g.start();
    dispose?.();

    download("client_secret_3.json", clock + 10_000);
    clock += 20_000;
    const reopened = mount();
    expect(reopened.step()).toBe("client");
    await tick();

    expect(uploads.map((u) => u.name)).toEqual(["client_secret_3.json"]);
  });

  test("stops watching once stopped", async () => {
    const g = mount();
    await g.start();
    g.stop();
    download("client_secret_4.json", clock + 100);
    await tick();

    expect(g.step()).toBeNull();
    expect(uploads).toEqual([]);
  });

  test("reopens sign-in while waiting for it", async () => {
    const g = mount();
    await g.start();
    download("client_secret_5.json", clock + 100);
    await tick();

    await g.reopen();

    expect(authStarts).toBe(1);
  });

  test("finishes after sign-in when Gmail and Calendar already answer", async () => {
    apiAnswers = [{ gmail: "enabled", calendar: "enabled" }];
    const g = mount();
    await g.start();
    download("client_secret_6.json", clock + 100);
    await tick();

    signIn();
    await tick(0);

    expect(g.step()).toBeNull();
    expect(done).toBe(1);
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(GMAIL_CREATE_CLIENT_URL);
  });

  test("offers the downloaded client for removal once it is uploaded", async () => {
    apiAnswers = [{ gmail: "enabled", calendar: "enabled" }];
    const g = mount();
    await g.start();
    download("client_secret_8.json", clock + 100);
    await tick();
    expect(g.leftover()).toBe("client_secret_8.json");

    await g.removeLeftover();

    // The uploaded content goes along, so a file replaced since is not deleted.
    expect(removed).toEqual([{ name: "client_secret_8.json", content: CLIENT }]);
    expect(g.leftover()).toBeNull();
  });

  test("offers the downloaded client for removal only on the workspace that holds its copy", async () => {
    const g = mount();
    await g.start();
    download("client_secret_12.json", clock + 100);
    await tick();
    expect(g.leftover()).toBe("client_secret_12.json");

    setScope("https://worker.example/workspace/remote/gmail/");
    expect(g.leftover()).toBeNull();
    await g.removeLeftover();
    expect(removed).toEqual([]);

    setScope(LOCAL);
    expect(g.leftover()).toBe("client_secret_12.json");
  });

  test("waits for a known status before resuming a step after Settings is reopened", async () => {
    const g = mount();
    await g.start();
    download("client_secret_9.json", clock + 100);
    await tick();
    expect(g.step()).toBe("signin");
    dispose?.();

    setStatus(null);
    download("client_secret_10.json", clock + 5_000);
    const reopened = mount();
    await tick(10_000);
    expect(reopened.step()).toBeNull();

    setStatus({ ...noCredentials, hasCredentials: true });
    await tick();
    expect(reopened.step()).toBe("signin");
    expect(uploads.map((u) => u.name)).toEqual(["client_secret_9.json"]);
  });

  test("offers no sign-in while Gmail is paused, and picks up where it was on resume", async () => {
    const g = mount();
    await g.start();
    download("client_secret_13.json", clock + 100);
    await tick();
    expect(g.step()).toBe("signin");
    dispose?.();

    setStatus({ ...noCredentials, hasCredentials: true, paused: true });
    const reopened = mount();
    await tick();
    expect(reopened.step()).toBeNull();
    await reopened.reopen();
    expect(authStarts).toBe(0);

    setStatus({ ...noCredentials, hasCredentials: true, paused: false });
    expect(reopened.step()).toBe("signin");
  });

  test("does not resume on another server or workspace, and resumes on the one it started for", async () => {
    mount();
    await guide?.start();
    dispose?.();

    setScope("https://worker.example/workspace/remote/gmail/");
    download("client_secret_11.json", clock + 100);
    const elsewhere = mount();
    await tick(10_000);
    expect(elsewhere.step()).toBeNull();
    expect(uploads).toEqual([]);
    dispose?.();

    setScope(LOCAL);
    const back = mount();
    await tick();
    expect(back.step()).toBe("signin");
    expect(uploads.map((u) => u.name)).toEqual(["client_secret_11.json"]);
  });

  test("drops a Downloads lookup that finishes after a switch to another workspace", async () => {
    let answer: (found: GmailClientDownload | null) => void = () => {};
    const slowFind = () =>
      new Promise<GmailClientDownload | null>((resolve) => {
        answer = resolve;
      });
    const g = mount(slowFind);
    await g.start();
    await tick(0);

    setScope("https://worker.example/workspace/remote/gmail/");
    answer({ name: "client_secret_13.json", content: CLIENT, modifiedMs: clock + 100 });
    await tick(0);

    expect(uploads).toEqual([]);
    setScope(LOCAL);
    expect(g.step()).toBe("client");
  });

  test("tries a client file again when the server could not take it", async () => {
    serverDown = true;
    const g = mount();
    await g.start();
    download("client_secret_14.json", clock + 100);
    await tick();
    expect(g.step()).toBe("client");

    serverDown = false;
    await tick();

    expect(uploads.map((u) => u.name)).toEqual(["client_secret_14.json", "client_secret_14.json"]);
    expect(g.step()).toBe("signin");
  });

  test("asks to sign in again when the saved sign-in has expired", async () => {
    apiAnswers = [{ gmail: "signed_out", calendar: "signed_out" }];
    const g = mount();
    await g.start();
    signIn();
    await tick(0);

    expect(g.accessMissing()).toBe(true);
    expect(g.signedOut()).toBe(true);
    await g.reopen();
    expect(authStarts).toBe(1);
  });

  test("keeps a known problem after Settings is reopened, and asks Google once more", async () => {
    apiAnswers = [{ gmail: "disabled", calendar: "enabled" }];
    const g = mount();
    await g.start();
    signIn();
    await tick(0);
    g.stop();
    dispose?.();
    const checksBefore = apiChecks;

    const reopened = mount();
    await tick(60_000);

    expect(reopened.step()).toBeNull();
    expect(reopened.apisDisabled()).toBe(true);
    expect(apiChecks).toBe(checksBefore + 1);
  });

  test("clears a known problem fixed while Settings was closed", async () => {
    apiAnswers = [
      { gmail: "disabled", calendar: "enabled" },
      { gmail: "enabled", calendar: "enabled" },
    ];
    const g = mount();
    await g.start();
    signIn();
    await tick(0);
    g.stop();
    dispose?.();

    const reopened = mount();
    await tick(0);

    expect(reopened.apisDisabled()).toBe(false);
  });

  test("does not hold an answer about an earlier client against a new one", async () => {
    apiAnswers = [{ gmail: "disabled", calendar: "enabled" }];
    const g = mount();
    await g.start();
    signIn();
    await tick(0);
    g.stop();

    setStatus({ ...noCredentials, hasCredentials: true, hasToken: true, updatedAt: clock + 1 });

    expect(g.apisDisabled()).toBe(false);
  });

  test("does not give a new client the answer of a check that started for the old one", async () => {
    apiAnswers = [{ gmail: "disabled", calendar: "enabled" }];
    const g = mount();
    await g.start();
    signIn();
    await tick(0);
    let release: () => void = () => {};
    checkGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    g.stop(); // the card rechecks the known problem; that check now hangs

    setStatus({ ...noCredentials, hasCredentials: true, hasToken: true, updatedAt: clock + 1 });
    release();
    await tick(0);

    expect(g.apisDisabled()).toBe(false);
  });

  test("does not let a check from before a restart complete the restarted guide", async () => {
    apiAnswers = [{ gmail: "enabled", calendar: "enabled" }];
    let release: () => void = () => {};
    checkGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const g = mount();
    await g.start();
    signIn();
    await tick(0); // this check now hangs

    g.resume(); // restarted: a new run on the API step
    release();
    await tick(0);

    expect(done).toBe(0);
    expect(g.step()).toBe("apis");
  });

  test("keeps a known problem when checking again cannot reach Google", async () => {
    apiAnswers = [
      { gmail: "disabled", calendar: "enabled" },
      { gmail: "unknown", calendar: "unknown" },
    ];
    const g = mount();
    await g.start();
    signIn();
    await tick(0);

    g.stop(); // the card checks the known problem again; Google does not answer
    await tick(0);

    expect(apiChecks).toBe(2);
    expect(g.apisDisabled()).toBe(true);
  });

  test("resumes at the API step on the same project after a cancel", async () => {
    apiAnswers = [{ gmail: "disabled", calendar: "enabled" }];
    const g = mount();
    await g.start();
    download("client_secret_15.json", clock + 100);
    await tick();
    signIn();
    await tick(0);
    g.stop();
    openUrl.mockClear();

    g.resume();
    await tick(0);

    expect(g.step()).toBe("apis");
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(gmailEnableApisUrl("arbor-42"));
  });

  test("asks to sign in again when Gmail or Calendar access was not granted", async () => {
    apiAnswers = [{ gmail: "enabled", calendar: "not_granted" }];
    const g = mount();
    await g.start();
    signIn();
    await tick(0);

    expect(g.accessMissing()).toBe(true);
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(GMAIL_CREATE_CLIENT_URL);
    await g.reopen();
    expect(authStarts).toBe(1);
  });

  test("still knows an API is off after the guide is cancelled", async () => {
    apiAnswers = [{ gmail: "disabled", calendar: "enabled" }];
    const g = mount();
    await g.start();
    signIn();
    await tick(0);

    g.stop();

    expect(g.step()).toBeNull();
    expect(g.apisDisabled()).toBe(true);
  });

  test("asks about the APIs every 5 seconds for a minute, then every 20", async () => {
    apiAnswers = [{ gmail: "disabled", calendar: "enabled" }];
    const g = mount();
    await g.start();
    signIn();
    await tick(0);
    for (let i = 0; i < 12; i++) await tick(5_000);
    const afterAMinute = apiChecks;

    await tick(15_000);
    expect(apiChecks).toBe(afterAMinute);
    await tick(5_000);
    expect(apiChecks).toBe(afterAMinute + 1);
    expect(g.step()).toBe("apis");
  });

  test("keeps checking when the enable page fails to open", async () => {
    apiAnswers = [
      { gmail: "disabled", calendar: "enabled" },
      { gmail: "enabled", calendar: "enabled" },
    ];
    const g = mount();
    await g.start();
    openUrl.mockRejectedValueOnce(new Error("opener unavailable"));
    signIn();
    await tick(0);

    await tick(5_000);

    expect(g.step()).toBeNull();
    expect(done).toBe(1);
  });

  test("offers a client file already in Downloads, and uses it in one click", async () => {
    download("client_secret_old.json", 500);
    const g = mount();
    await tick(0);
    expect(g.existing()?.name).toBe("client_secret_old.json");

    await g.useExisting();

    expect(uploads.map((u) => u.name)).toEqual(["client_secret_old.json"]);
    expect(g.step()).toBe("signin");
    expect(g.leftover()).toBe("client_secret_old.json");
    expect(openUrl).not.toHaveBeenCalled();
  });

  test("continues to sign-in and the API check after a picked file is uploaded", async () => {
    apiAnswers = [{ gmail: "disabled", calendar: "disabled" }];
    const g = mount();

    await g.startFromFile(new File([CLIENT], "credentials.json"));
    expect(g.step()).toBe("signin");
    expect(g.leftover()).toBeNull();

    signIn();
    await tick(0);
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(gmailEnableApisUrl("arbor-42"));
  });

  test("stays idle when a picked file is rejected", async () => {
    const g = mount();

    await g.startFromFile(new File(['{"type":"service_account"}'], "credentials.json"));

    expect(g.step()).toBeNull();
  });

  test("opens the enable page on the client's project once, and finishes when both APIs answer", async () => {
    apiAnswers = [
      { gmail: "disabled", calendar: "disabled" },
      { gmail: "enabled", calendar: "disabled" },
      { gmail: "enabled", calendar: "enabled" },
    ];
    const g = mount();
    await g.start();
    download("client_secret_7.json", clock + 100);
    await tick();

    signIn();
    await tick(0);
    expect(g.step()).toBe("apis");
    expect(g.apisDisabled()).toBe(true);
    expect(openUrl).toHaveBeenLastCalledWith(gmailEnableApisUrl("arbor-42"));
    expect(gmailEnableApisUrl("arbor-42")).toContain("&project=arbor-42");

    await tick(5_000);
    expect(g.step()).toBe("apis");
    await tick(5_000);

    expect(g.step()).toBeNull();
    expect(openUrl).toHaveBeenCalledTimes(2);
  });

  test("keeps asking, without opening a page, while the check cannot run", async () => {
    apiAnswers = [null];
    const g = mount();
    await g.start();
    signIn();
    await tick(0);
    await tick(5_000);

    expect(g.step()).toBe("apis");
    expect(g.apisDisabled()).toBe(false);
    expect(apiChecks).toBe(2);
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(GMAIL_CREATE_CLIENT_URL);
  });
});
