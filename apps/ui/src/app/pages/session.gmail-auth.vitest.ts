import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { OpenworkServerSettings } from "../lib/openwork-server";
import type { MessageWithParts } from "../types";
import { createGmailAuth } from "./session.gmail-auth";

const OLD_OAUTH_URL = "https://accounts.google.com/o/oauth2/auth?client_id=old&state=earlier";

const assistantWithLink = {
  info: { role: "assistant" },
  parts: [{ type: "text", text: `Authorize Gmail here: ${OLD_OAUTH_URL}` }],
} as unknown as MessageWithParts;

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
});

async function turnWithAnOldOAuthLink(status: { hasCredentials: boolean; hasToken: boolean; paused?: boolean }) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })));
  const openLink = vi.fn();
  const [sessionStatus, setSessionStatus] = createSignal("idle");
  createRoot((done) => {
    dispose = done;
    createGmailAuth({
      selectedSessionAgent: () => "email-agent",
      selectedSessionId: () => "ses_1",
      sessionStatus,
      messages: () => [assistantWithLink],
      getMessagesBySessionId: () => [],
      serverSettings: () => ({ urlOverride: "http://127.0.0.1:8787", token: "t" }) as OpenworkServerSettings,
      serverHostInfo: () => null,
      serverWorkspaceId: () => "ws_1",
      abortSession: async () => {},
      setToastMessage: () => {},
      openLink,
    });
  });
  // The run is only tied to the session from the second turn after mount: the deferred `on` has no previous status.
  for (let turn = 0; turn < 2; turn++) {
    setSessionStatus("busy");
    setSessionStatus("idle");
  }
  // The first read is the status indicator's on mount; the second asks whether to open the link.
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return openLink;
}

describe("createGmailAuth", () => {
  test("a turn while Gmail is paused does not open an earlier OAuth link from the session", async () => {
    const openLink = await turnWithAnOldOAuthLink({ hasCredentials: true, hasToken: false, paused: true });
    expect(openLink).not.toHaveBeenCalled();
  });

  test("a turn with credentials and no token still opens the link", async () => {
    const openLink = await turnWithAnOldOAuthLink({ hasCredentials: true, hasToken: false });
    expect(openLink).toHaveBeenCalledWith(OLD_OAUTH_URL);
  });
});
