import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const openUrl = vi.fn(async (_url: string) => {});
vi.mock("./settings.platform-actions", () => ({
  openUrl: (url: string) => openUrl(url),
  revealItemInDir: async () => {},
}));

const { default: GmailCredentialsSection } = await import("./settings.gmail-credentials-section");
const { GMAIL_CREATE_CLIENT_URL, GMAIL_CREDENTIALS_URL } = await import(
  "./settings.gmail-setup-guide"
);
type GmailCredentials = import("./settings.gmail-credentials").GmailCredentials;
type GmailCredentialStatus = import("./settings.gmail-credentials").GmailCredentialStatus;

let dispose: (() => void) | undefined;
beforeEach(() => openUrl.mockClear());
afterEach(() => {
  // The guide's state outlives the card on purpose; end it so tests stay independent.
  // Continue setup starts over, which also drops a saved API answer.
  document.querySelector<HTMLButtonElement>("[data-testid=gmail-setup-resume]")?.click();
  document.querySelector<HTMLButtonElement>("[data-testid=gmail-setup-cancel]")?.click();
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

/** Renders the card against a stub controller, returning the host element. */
function renderSection(overrides: Partial<GmailCredentials> = {}) {
  const [status] = createSignal<GmailCredentialStatus | null>(null);
  const gmail = {
    scope: () => "http://127.0.0.1:8787/workspace/local/gmail/",
    status,
    busy: () => false,
    error: () => null,
    success: () => null,
    authBusy: () => false,
    startAuth: async () => {},
    checkApis: async () => null,
    upload: async () => "uploaded" as const,
    remove: async () => {},
    downloadTemplate: async () => {},
    ...overrides,
  } as GmailCredentials;

  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <GmailCredentialsSection gmail={gmail} />, host);
  return host;
}

const withStatus = (status: Partial<GmailCredentialStatus>) => ({
  status: () => ({
    hasCredentials: false,
    hasToken: false,
    fileSize: null,
    updatedAt: null,
    ...status,
  }),
});

const q = (host: HTMLElement, testId: string) =>
  host.querySelector<HTMLElement>(`[data-testid=${testId}]`);

describe("GmailCredentialsSection", () => {
  test("says it is checking, and offers nothing status-specific, until the status call returns", () => {
    const host = renderSection();

    expect(q(host, "gmail-status-loading")?.textContent).toContain("Checking Gmail");
    expect(q(host, "gmail-credentials-status")).toBeNull();
    // No credentials known yet is not the same as "no credentials" — offering
    // setup here would flash the wrong state on every settings open.
    expect(q(host, "gmail-setup-start")).toBeNull();
    expect(q(host, "upload-gmail-credentials-button")).toBeNull();
  });

  test("makes Set up Gmail the primary action, with Set up manually beside it", () => {
    const host = renderSection(withStatus({ hasCredentials: false }));

    expect(q(host, "gmail-setup-start")?.textContent).toContain("Set up Gmail");
    expect(q(host, "gmail-setup-manual")?.textContent).toContain("Set up manually");
    expect(q(host, "upload-gmail-credentials-button")).toBeNull();
    expect(q(host, "delete-credentials-button")).toBeNull();
    expect(openUrl).not.toHaveBeenCalled();
  });

  test("Set up Gmail opens Google's create-client form and starts the guide", () => {
    const host = renderSection(withStatus({ hasCredentials: false }));

    q(host, "gmail-setup-start")?.click();
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(GMAIL_CREATE_CLIENT_URL);
    expect(q(host, "gmail-setup-guide")).not.toBeNull();
    expect(q(host, "gmail-setup-start")).toBeNull();
  });

  test("states Desktop app, Internal and the 7-day Testing limit on the client step", () => {
    const host = renderSection(withStatus({ hasCredentials: false }));
    q(host, "gmail-setup-start")?.click();

    const guide = q(host, "gmail-setup-guide")?.textContent ?? "";
    expect(guide).toContain("Desktop app");
    expect(guide).toContain("Internal");
    expect(guide).toContain("7 days");
  });

  test("Set up manually opens the credentials page and offers the upload", () => {
    const host = renderSection(withStatus({ hasCredentials: false }));

    q(host, "gmail-setup-manual")?.click();

    expect(openUrl).toHaveBeenLastCalledWith(GMAIL_CREDENTIALS_URL);
    expect(q(host, "gmail-manual-setup")?.textContent).toContain(GMAIL_CREDENTIALS_URL);
    expect(q(host, "upload-gmail-credentials-button")).not.toBeNull();
  });

  test("Set up manually from inside the guide ends the guide", () => {
    const host = renderSection(withStatus({ hasCredentials: false }));
    q(host, "gmail-setup-start")?.click();

    q(host, "gmail-setup-manual")?.click();

    expect(q(host, "gmail-setup-guide")).toBeNull();
    expect(q(host, "upload-gmail-credentials-button")).not.toBeNull();
  });

  test("keeps the guide, not the separate OAuth prompt, on screen through sign-in", () => {
    const [status, setStatus] = createSignal<GmailCredentialStatus | null>({
      hasCredentials: false,
      hasToken: false,
      fileSize: null,
      updatedAt: null,
    });
    const host = renderSection({ status });
    q(host, "gmail-setup-start")?.click();

    setStatus({ hasCredentials: true, hasToken: false, fileSize: 400, updatedAt: 1 });

    expect(q(host, "gmail-setup-guide")?.textContent).toContain("Open sign-in again");
    expect(host.textContent).not.toContain("Next step to authorize Gmail");
  });

  test("does not call Gmail ready while the guide waits for the APIs", () => {
    const [status, setStatus] = createSignal<GmailCredentialStatus | null>({
      hasCredentials: false,
      hasToken: false,
      fileSize: null,
      updatedAt: null,
    });
    const host = renderSection({ status });
    q(host, "gmail-setup-start")?.click();

    setStatus({ hasCredentials: true, hasToken: true, fileSize: 400, updatedAt: 1 });

    expect(q(host, "gmail-credentials-status")?.textContent).toContain(
      "Signed in — turn on Gmail and Calendar",
    );
  });

  test("does not call Gmail ready after the guide is cancelled with an API off", async () => {
    const [status, setStatus] = createSignal<GmailCredentialStatus | null>({
      hasCredentials: false,
      hasToken: false,
      fileSize: null,
      updatedAt: null,
    });
    const host = renderSection({
      status,
      checkApis: async () => ({ gmail: "disabled", calendar: "enabled" }),
    });
    q(host, "gmail-setup-start")?.click();
    setStatus({ hasCredentials: true, hasToken: true, fileSize: 400, updatedAt: 1 });
    await new Promise((r) => setTimeout(r, 0));

    q(host, "gmail-setup-cancel")?.click();

    expect(q(host, "gmail-setup-guide")).toBeNull();
    expect(q(host, "gmail-credentials-status")?.textContent).toContain(
      "Signed in — turn on Gmail and Calendar",
    );

    // Not a dead end: Continue setup goes back to the API step.
    q(host, "gmail-setup-resume")?.click();
    expect(q(host, "gmail-setup-guide")).not.toBeNull();
  });

  test("offers Set up manually only until a client is uploaded", () => {
    const [status, setStatus] = createSignal<GmailCredentialStatus | null>({
      hasCredentials: false,
      hasToken: false,
      fileSize: null,
      updatedAt: null,
    });
    const host = renderSection({ status });
    q(host, "gmail-setup-start")?.click();
    expect(q(host, "gmail-setup-manual")).not.toBeNull();

    setStatus({ hasCredentials: true, hasToken: false, fileSize: 400, updatedAt: 1 });

    expect(q(host, "gmail-setup-guide")).not.toBeNull();
    expect(q(host, "gmail-setup-manual")).toBeNull();
  });

  test("removing the credentials mid-setup ends the guide instead of watching Downloads again", async () => {
    const [status, setStatus] = createSignal<GmailCredentialStatus | null>({
      hasCredentials: false,
      hasToken: false,
      fileSize: null,
      updatedAt: null,
    });
    const host = renderSection({
      status,
      remove: async () => {
        setStatus({ hasCredentials: false, hasToken: false, fileSize: null, updatedAt: null });
      },
    });
    q(host, "gmail-setup-start")?.click();
    setStatus({ hasCredentials: true, hasToken: false, fileSize: 400, updatedAt: 1 });

    q(host, "delete-credentials-button")?.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(q(host, "gmail-setup-guide")).toBeNull();
    expect(q(host, "gmail-setup-start")).not.toBeNull();
  });

  test("offers delete, and no setup, once credentials exist", () => {
    const host = renderSection(withStatus({ hasCredentials: true }));

    expect(q(host, "delete-credentials-button")).not.toBeNull();
    expect(q(host, "gmail-setup-start")).toBeNull();
    expect(q(host, "upload-gmail-credentials-button")).toBeNull();
  });

  test("prompts to finish OAuth while credentials exist without a token", () => {
    const host = renderSection(
      withStatus({ hasCredentials: true, hasToken: false }),
    );

    expect(host.textContent).toContain("Next step to authorize Gmail");
    expect(q(host, "gmail-credentials-status")?.textContent).toContain(
      "Authorization required",
    );
  });

  test("drops the OAuth prompt once authorized", () => {
    const host = renderSection(
      withStatus({ hasCredentials: true, hasToken: true }),
    );

    expect(host.textContent).not.toContain("Next step to authorize Gmail");
    expect(q(host, "gmail-credentials-status")?.textContent).toContain(
      "Gmail authorized",
    );
  });

  test("disables the delete control while a request is in flight", () => {
    const host = renderSection({
      ...withStatus({ hasCredentials: true }),
      busy: () => true,
    });

    expect((q(host, "delete-credentials-button") as HTMLButtonElement).disabled).toBe(true);
  });

  test("does not claim a browser opened when authorization failed (#3053)", () => {
    const host = renderSection({
      ...withStatus({ hasCredentials: true, hasToken: false }),
      error: () => "Gmail is not available in this version of SuperClaw.",
    });

    expect(host.textContent).toContain("Gmail is not available in this version of SuperClaw.");
    expect(host.textContent).not.toContain("A browser window has been opened");
    expect(host.textContent).not.toContain("Didn't open?");
    expect(host.textContent).toContain("Try again");
  });
});
