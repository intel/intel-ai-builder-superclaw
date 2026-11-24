import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, test } from "vitest";
import type { MessageWithParts } from "../../types";
import { MessageAgentBadge } from "./message-agent-badge";

afterEach(cleanup);

const userInfo = (agent: string) =>
  ({ id: "u1", sessionID: "s1", role: "user", agent, time: { created: 0 } }) as MessageWithParts["info"];

describe("MessageAgentBadge", () => {
  test("names the agent a sent message went to", () => {
    render(() => <MessageAgentBadge info={userInfo("email-agent")} />);

    expect(screen.getByTestId("message-agent").textContent).toBe("Email Agent");
  });

  test("names the default agent General", () => {
    render(() => <MessageAgentBadge info={userInfo("superclaw-default")} />);

    expect(screen.getByTestId("message-agent").textContent).toBe("General");
  });

  test("renders nothing on an assistant reply", () => {
    const info = { id: "a1", sessionID: "s1", role: "assistant" } as MessageWithParts["info"];
    render(() => <MessageAgentBadge info={info} />);

    expect(screen.queryByTestId("message-agent")).toBeNull();
  });
});
