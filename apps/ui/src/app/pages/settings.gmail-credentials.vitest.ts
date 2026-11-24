import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";

const openUrl = vi.fn(async (_url: string) => {});

vi.mock("../../i18n", () => ({ t: (key: string) => key }));
vi.mock("../lib/openwork-server", () => ({ readOpenworkServerSettings: () => ({ token: "client-token" }) }));
vi.mock("../utils", () => ({ isTauriRuntime: () => false }));
vi.mock("./settings.platform-actions", () => ({
  openUrl: (url: string) => openUrl(url),
  revealItemInDir: async () => {},
}));

const { createGmailCredentials } = await import("./settings.gmail-credentials");

const GMAIL_UNAVAILABLE = "Gmail is not available in this version of SuperClaw.";

type AuthStartAnswer = () => Response | Promise<Response>;

let answerAuthStart: AuthStartAnswer;
let dispose: (() => void) | undefined;

beforeEach(() => {
  openUrl.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/gmail/auth/start")) return answerAuthStart();
      // The status read on mount; this suite is about starting authorization.
      return new Response(JSON.stringify({ hasCredentials: true, hasToken: false, fileSize: 1, updatedAt: 1 }));
    }),
  );
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function controller(workspaceId: string | null = "ws_1") {
  return createRoot((done) => {
    dispose = done;
    return createGmailCredentials({ serverUrl: () => "http://127.0.0.1:8787", workspaceId: () => workspaceId });
  });
}

describe("createGmailCredentials setEnabled", () => {
  test("shows the switch's answer even when the status read after it fails", async () => {
    let failReads = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/gmail/enabled") && init?.method === "PUT") {
          return new Response(JSON.stringify({ paused: true }));
        }
        if (failReads) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ hasCredentials: true, hasToken: true, paused: false, fileSize: 1, updatedAt: 1 }));
      }),
    );
    const gmail = controller();
    await vi.waitFor(() => expect(gmail.status()?.hasToken).toBe(true));

    failReads = true;
    await gmail.setEnabled(false);

    expect(gmail.status()?.paused).toBe(true);
    expect(gmail.error()).toBeNull();
  });

  test("a resume shows the token as present even when the status read after it fails", async () => {
    let failReads = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/gmail/enabled") && init?.method === "PUT") {
          return new Response(JSON.stringify({ paused: false }));
        }
        if (failReads) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ hasCredentials: true, hasToken: false, paused: true, fileSize: 1, updatedAt: 1 }));
      }),
    );
    const gmail = controller();
    await vi.waitFor(() => expect(gmail.status()?.paused).toBe(true));

    failReads = true;
    await gmail.setEnabled(true);

    expect(gmail.status()).toMatchObject({ paused: false, hasToken: true });
    expect(gmail.error()).toBeNull();
  });
});

describe("createGmailCredentials status", () => {
  test("asks again until the first status read succeeds, then stops", async () => {
    vi.useFakeTimers();
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        reads += 1;
        if (reads === 1) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ hasCredentials: false, hasToken: false, fileSize: null, updatedAt: null }));
      }),
    );
    const gmail = controller();
    await vi.advanceTimersByTimeAsync(0);
    expect(gmail.status()).toBeNull();

    await vi.advanceTimersByTimeAsync(3000);
    expect(gmail.status()?.hasCredentials).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads).toBe(2);
  });

  test("lets a slow first read finish instead of sending it again", async () => {
    vi.useFakeTimers();
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        reads += 1;
        await new Promise((r) => setTimeout(r, 10_000));
        return new Response(JSON.stringify({ hasCredentials: true, hasToken: true, fileSize: 1, updatedAt: 1 }));
      }),
    );
    const gmail = controller();

    await vi.advanceTimersByTimeAsync(9_000);
    expect(gmail.status()).toBeNull();
    expect(reads).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(gmail.status()?.hasToken).toBe(true);
    expect(reads).toBe(1);
  });
});

describe("createGmailCredentials.startAuth", () => {
  test("shows the server's reason when Gmail is not available (EG1-8)", async () => {
    // A 501 used to reach only the console, so the Connect button looked dead (#3053).
    answerAuthStart = () =>
      new Response(JSON.stringify({ code: "gmail_unavailable", message: GMAIL_UNAVAILABLE }), { status: 501 });
    const gmail = controller();

    await gmail.startAuth();

    expect(gmail.error()).toBe(GMAIL_UNAVAILABLE);
    expect(openUrl).not.toHaveBeenCalled();
  });

  test("says authorization could not start when the request itself fails", async () => {
    answerAuthStart = () => {
      throw new TypeError("Failed to fetch");
    };
    const gmail = controller();

    await gmail.startAuth();

    expect(gmail.error()).toBe("settings.gmail_auth_failed");
  });

  test("says so when the server answers without an authorization link", async () => {
    answerAuthStart = () => new Response(JSON.stringify({}));
    const gmail = controller();

    await gmail.startAuth();

    expect(gmail.error()).toBe("settings.gmail_auth_failed");
    expect(openUrl).not.toHaveBeenCalled();
  });

  test("says why when there is no server or workspace yet", async () => {
    answerAuthStart = () => {
      throw new Error("must not call the server without a workspace");
    };
    const gmail = controller(null);

    await gmail.startAuth();

    expect(gmail.error()).toBe("settings.gmail_no_server_or_workspace");
  });

  test("does not leave the upload's 'check your browser' message up when authorization failed", async () => {
    // The upload succeeds and then starts authorization; with Gmail gated the card
    // showed "uploaded, check your browser" beside "not available" (#3053).
    answerAuthStart = () =>
      new Response(JSON.stringify({ code: "gmail_unavailable", message: GMAIL_UNAVAILABLE }), { status: 501 });
    const upload = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    const fetchStub = globalThis.fetch as unknown as Mock<typeof fetch>;
    const answer = fetchStub.getMockImplementation()!; // set in beforeEach
    fetchStub.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/gmail/credentials") && init?.method === "POST" ? upload() : answer(input, init),
    );
    const gmail = controller();

    await gmail.upload(new File(["{}"], "credentials.json", { type: "application/json" }));

    expect(upload).toHaveBeenCalled();
    expect(gmail.error()).toBe(GMAIL_UNAVAILABLE);
    expect(gmail.success()).toBeNull();
  });

  test("opens the authorization link and clears an earlier error", async () => {
    answerAuthStart = () =>
      new Response(JSON.stringify({ code: "gmail_unavailable", message: GMAIL_UNAVAILABLE }), { status: 501 });
    const gmail = controller();
    await gmail.startAuth();

    answerAuthStart = () => new Response(JSON.stringify({ authURL: "https://accounts.google.com/o/oauth2/auth?x=1" }));
    await gmail.startAuth();

    expect(openUrl).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/auth?x=1");
    expect(gmail.error()).toBeNull();
  });

  test("does not start a second sign-in while one is starting", async () => {
    let starts = 0;
    let answer: (res: Response) => void = () => {};
    answerAuthStart = () => {
      starts += 1;
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    };
    const gmail = controller();

    const first = gmail.startAuth();
    await gmail.startAuth();
    answer(new Response(JSON.stringify({ authURL: "https://accounts.google.com/o/oauth2/auth?x=2" })));
    await first;

    expect(starts).toBe(1);
    expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://accounts.google.com/o/oauth2/auth?x=2");
  });

  test("reports an expired sign-in from the API check, so the guide can offer sign-in again", async () => {
    const fetchStub = globalThis.fetch as unknown as Mock<typeof fetch>;
    const answer = fetchStub.getMockImplementation()!; // set in beforeEach
    let code = "gmail_not_authorized";
    fetchStub.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/gmail/apis")
        ? new Response(JSON.stringify({ code }), { status: 409 })
        : answer(input, init),
    );
    const gmail = controller();

    expect(await gmail.checkApis()).toEqual({ gmail: "signed_out", calendar: "signed_out" });
    code = "something_else";
    expect(await gmail.checkApis()).toBeNull();
  });

  test("says whether a failed upload is worth trying again", async () => {
    const fetchStub = globalThis.fetch as unknown as Mock<typeof fetch>;
    const answer = fetchStub.getMockImplementation()!; // set in beforeEach
    let uploadStatus = 400;
    fetchStub.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/gmail/credentials") && init?.method === "POST"
        ? new Response(JSON.stringify({ message: "nope" }), { status: uploadStatus })
        : answer(input, init),
    );
    const gmail = controller();
    const file = () => new File(["{}"], "credentials.json", { type: "application/json" });

    expect(await gmail.upload(file())).toBe("rejected");
    uploadStatus = 503;
    expect(await gmail.upload(file())).toBe("failed");
  });

  test("gives up on a sign-in start that never answers, so it can be tried again", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const fetchStub = globalThis.fetch as unknown as Mock<typeof fetch>;
    const answer = fetchStub.getMockImplementation()!; // set in beforeEach
    fetchStub.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/gmail/auth/start")
        ? new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))),
          )
        : answer(input, init),
    );
    const gmail = controller();

    const hung = gmail.startAuth();
    expect(gmail.authBusy()).toBe(true);
    timeout.abort();
    await hung;

    expect(gmail.authBusy()).toBe(false);
    expect(gmail.error()).toBe("settings.gmail_auth_failed");
  });
});
