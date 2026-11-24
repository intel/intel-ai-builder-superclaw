import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, test } from "vitest";

import EdgeServerCard, { resetEdgeAttemptMemory } from "./edge-server-card";

const SAVED_URL = "http://edge.example:8080/v1";

afterEach(() => {
  cleanup();
  resetEdgeAttemptMemory();
});

// The key field is the card's only password input (its placeholder is just
// dots while a saved key exists).
const getKeyField = () => document.querySelector('input[type="password"]') as HTMLInputElement;
const getUrlField = () => screen.getByPlaceholderText("http://server-ip:port") as HTMLInputElement;
const getConnect = () => screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
const getModelField = () => screen.getByTestId("edge-model-input") as HTMLInputElement;
const SERVED = ["saved-model", "other-model"];
const runTest = async (served: string[]) => {
  fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
  await waitFor(() => {
    fireEvent.focus(getModelField());
    expect(screen.queryAllByRole("option").map((option) => option.textContent)).toEqual(served);
  });
  fireEvent.keyDown(getModelField(), { key: "Escape" });
};
// Listbox options select on mousedown, so a click would not pick one.
const pickModel = async (name: string) => {
  fireEvent.focus(getModelField());
  fireEvent.mouseDown(await screen.findByRole("option", { name }));
};

const renderConnectedCardWithApply = (onApply: () => Promise<boolean>) =>
  render(() => (
    <EdgeServerCard
      edgeConfigured
      edgeConnected
      edgeBaseUrl={SAVED_URL}
      edgeModelName="saved-model"
      edgeBypassProxy
      onConnect={async () => undefined}
      onApply={onApply}
    />
  ));

const renderConnectedCard = () =>
  render(() => (
    <EdgeServerCard
      edgeConfigured
      edgeConnected
      edgeBaseUrl={SAVED_URL}
      edgeModelName="saved-model"
      edgeBypassProxy
      onTest={async () => SERVED}
      onConnect={async () => undefined}
    />
  ));

describe("EdgeServerCard on a connected server", () => {
  test("shows Test Connection and Connect with editable fields, and no Edit", () => {
    renderConnectedCard();

    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeTruthy();
    expect(getUrlField().disabled).toBe(false);
    expect(getKeyField().disabled).toBe(false);
    expect(getModelField().disabled).toBe(false);
    // The saved key is kept by leaving the field blank; the dots are only a placeholder.
    expect(getKeyField().value).toBe("");
    expect(getKeyField().placeholder).toBe("••••••••••••");
    // Nothing changed yet, so Connect would re-save the same connection.
    expect(getConnect().disabled).toBe(true);
  });

  test("a new key enables Connect", () => {
    renderConnectedCard();

    fireEvent.input(getKeyField(), { target: { value: "sk-new" } });
    expect(getConnect().disabled).toBe(false);
  });

  test("picking another tested model enables Connect", async () => {
    renderConnectedCard();

    await runTest(SERVED);
    await pickModel("other-model");
    expect(getConnect().disabled).toBe(false);
  });

  test("a later empty test result clears the prior model and disables Connect", async () => {
    let call = 0;
    render(() => (
      <EdgeServerCard
        edgeConfigured
        edgeConnected
        edgeBaseUrl={SAVED_URL}
        edgeModelName="saved-model"
        edgeBypassProxy
        onTest={async () => (call++ === 0 ? SERVED : [])}
        onConnect={async () => undefined}
      />
    ));

    await runTest(SERVED);
    await pickModel("other-model");
    expect(getConnect().disabled).toBe(false);

    // A second test (e.g. the embedding model was removed) serves no trusted pair.
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    expect(await screen.findByText("This server serves no supported model.")).toBeTruthy();
    expect(getModelField().value).toBe("");
    expect(getModelField().disabled).toBe(true);
    expect(getConnect().disabled).toBe(true);
  });

  test("Connect after a model change opens the Apply pop-up", async () => {
    const connectCalls: boolean[] = [];
    render(() => (
      <EdgeServerCard
        edgeConfigured
        edgeConnected
        edgeBaseUrl={SAVED_URL}
        edgeModelName="saved-model"
        edgeBypassProxy
        onTest={async () => SERVED}
        onConnect={async () => {
          connectCalls.push(true);
        }}
        onApply={async () => false}
      />
    ));

    await runTest(SERVED);
    await pickModel("other-model");
    fireEvent.click(getConnect());

    expect(await screen.findByRole("button", { name: "Apply model change" })).toBeTruthy();
    expect(connectCalls).toEqual([true]);
  });

  test("Connect after a URL change also opens the Apply pop-up", async () => {
    const connectCalls: boolean[] = [];
    render(() => (
      <EdgeServerCard
        edgeConfigured
        edgeConnected
        edgeBaseUrl={SAVED_URL}
        edgeModelName="saved-model"
        edgeBypassProxy
        onTest={async () => SERVED}
        onConnect={async () => {
          connectCalls.push(true);
        }}
      />
    ));

    // Same server, so the saved key is reused and no new key is needed.
    fireEvent.input(getUrlField(), { target: { value: "http://edge.example:8080/api" } });
    await runTest(SERVED);
    fireEvent.click(getConnect());

    expect(await screen.findByRole("button", { name: "Apply model change" })).toBeTruthy();
    expect(connectCalls).toEqual([true]);
  });

  test("changing a field back to the saved value disables Connect again", async () => {
    renderConnectedCard();

    await runTest(SERVED);
    await pickModel("other-model");
    expect(getConnect().disabled).toBe(false);
    await pickModel("saved-model");
    expect(getConnect().disabled).toBe(true);
  });

  test("changing the URL drops the tested models and disables Connect until the next test", async () => {
    renderConnectedCard();

    fireEvent.input(getUrlField(), { target: { value: "http://edge.example:8080/api" } });
    expect(getModelField().disabled).toBe(true);
    expect(getModelField().value).toBe("");
    expect(getConnect().disabled).toBe(true);
    await runTest(SERVED);
    expect(getConnect().disabled).toBe(false);
  });
});

describe("EdgeServerCard after the user leaves the tab", () => {
  test("a remount shows the saved values again", () => {
    const view = renderConnectedCard();
    fireEvent.input(getUrlField(), { target: { value: "http://other.example:9000" } });
    fireEvent.input(getModelField(), { target: { value: "other-model" } });

    // Switching tabs unmounts the card; coming back mounts it again.
    view.unmount();
    renderConnectedCard();

    expect(getUrlField().value).toBe("http://edge.example:8080");
    expect(getModelField().value).toBe("saved-model");
    expect(getConnect().disabled).toBe(true);
  });
});

describe("EdgeServerCard messages from an earlier visit", () => {
  const OLD_ERROR = "could not reach edge upstream";

  test("an error set before the card mounted is hidden", () => {
    render(() => (
      <EdgeServerCard
        edgeConfigured
        edgeBaseUrl={SAVED_URL}
        edgeModelName="saved-model"
        error={OLD_ERROR}
        switchError="Switch failed."
        testSuccessMessage="Connection test succeeded."
        onConnect={async () => undefined}
      />
    ));
    expect(screen.queryByText(OLD_ERROR)).toBeNull();
    expect(screen.queryByText("Switch failed.")).toBeNull();
    expect(screen.queryByText("Connection test succeeded.")).toBeNull();
  });

  test("a new error after mount shows, even with the same text as the old one", () => {
    const [error, setError] = createSignal<string | null>(OLD_ERROR);
    render(() => (
      <EdgeServerCard
        edgeConfigured
        edgeBaseUrl={SAVED_URL}
        edgeModelName="saved-model"
        error={error()}
        onConnect={async () => undefined}
      />
    ));
    expect(screen.queryByText(OLD_ERROR)).toBeNull();

    // A new test clears the error first, then sets it again.
    setError(null);
    setError(OLD_ERROR);
    expect(screen.getByText(OLD_ERROR)).toBeTruthy();
  });
});

describe("EdgeServerCard after a failed attempt and a tab switch", () => {
  const renderWithError = (error: string | null) =>
    render(() => (
      <EdgeServerCard
        edgeConfigured
        edgeConnected
        edgeBaseUrl={SAVED_URL}
        edgeModelName="saved-model"
        edgeBypassProxy={false}
        error={error}
        onConnect={async () => undefined}
      />
    ));

  test("coming back shows a first-time setup: blank URL and key, no model, proxy bypass on", () => {
    const [error, setError] = createSignal<string | null>(null);
    const view = render(() => (
      <EdgeServerCard
        edgeConfigured
        edgeConnected
        edgeBaseUrl={SAVED_URL}
        edgeModelName="saved-model"
        edgeBypassProxy={false}
        error={error()}
        onConnect={async () => undefined}
      />
    ));
    setError("No available workers");
    // While the user stays on the tab, the fields are unchanged.
    expect(getUrlField().value).toBe("http://edge.example:8080");

    view.unmount();
    renderWithError(null);

    expect(getUrlField().value).toBe("");
    expect(getKeyField().value).toBe("");
    expect(getModelField().value).toBe("");
    expect(getModelField().disabled).toBe(true);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });

  test("with no failed attempt, coming back shows the saved server", () => {
    renderWithError(null).unmount();
    renderWithError(null);
    expect(getUrlField().value).toBe("http://edge.example:8080");
  });

  test("a success after the failure shows the saved server again next time", () => {
    const [error, setError] = createSignal<string | null>(null);
    const [success, setSuccess] = createSignal<string | null>(null);
    const view = render(() => (
      <EdgeServerCard
        edgeConfigured
        edgeBaseUrl={SAVED_URL}
        edgeModelName="saved-model"
        error={error()}
        testSuccessMessage={success()}
        onConnect={async () => undefined}
      />
    ));
    setError("No available workers");
    setError(null);
    setSuccess("Connection test succeeded.");

    view.unmount();
    renderWithError(null);
    expect(getUrlField().value).toBe("http://edge.example:8080");
  });
});

describe("EdgeServerCard after a failed Connect", () => {
  test("the typed values stay and the error shows", async () => {
    render(() => (
      <EdgeServerCard
        edgeConfigured
        edgeConnected
        edgeBaseUrl={SAVED_URL}
        edgeModelName="saved-model"
        edgeBypassProxy
        onTest={async () => SERVED}
        onConnect={async () => {
          throw new Error("ServiceHub is not connected.");
        }}
      />
    ));

    fireEvent.input(getUrlField(), { target: { value: "http://other.example:9000" } });
    fireEvent.input(getKeyField(), { target: { value: "sk-new" } });
    await runTest(SERVED);
    fireEvent.click(getConnect());

    expect(await screen.findByText("ServiceHub is not connected.")).toBeTruthy();
    expect(getUrlField().value).toBe("http://other.example:9000");
    expect(getKeyField().value).toBe("sk-new");
  });

  test("cancelling the Apply pop-up after a failed switch keeps the typed values", async () => {
    render(() => (
      <EdgeServerCard
        edgeConfigured
        edgeConnected
        edgeBaseUrl={SAVED_URL}
        edgeModelName="saved-model"
        edgeBypassProxy
        switchError="Chat model probe failed."
        onTest={async () => SERVED}
        onConnect={async () => undefined}
        onApply={async () => false}
      />
    ));

    await runTest(SERVED);
    await pickModel("other-model");
    fireEvent.click(getConnect());
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(getModelField().value).toBe("other-model");
  });
});

describe("EdgeServerCard same process as Local Connect", () => {
  test("the Apply pop-up opens only after the switch is staged", async () => {
    let finishStaging!: () => void;
    render(() => (
      <EdgeServerCard
        edgeConfigured={false}
        edgeBaseUrl=""
        edgeModelName=""
        onTest={async () => ["m1"]}
        onConnect={() => new Promise<void>((resolve) => (finishStaging = resolve))}
        onApply={async () => false}
      />
    ));
    fireEvent.input(getUrlField(), { target: { value: "http://new.example:8080" } });
    fireEvent.input(getKeyField(), { target: { value: "sk-new" } });
    await runTest(["m1"]);
    fireEvent.click(getConnect());

    expect(screen.queryByRole("button", { name: "Apply model change" })).toBeNull();
    finishStaging();
    expect(await screen.findByRole("button", { name: "Apply model change" })).toBeTruthy();
  });

  test("a failed staging shows the error and no pop-up", async () => {
    render(() => (
      <EdgeServerCard
        edgeConfigured={false}
        edgeBaseUrl=""
        edgeModelName=""
        onTest={async () => ["m1"]}
        onConnect={async () => {
          throw new Error("ServiceHub is not connected.");
        }}
      />
    ));
    fireEvent.input(getUrlField(), { target: { value: "http://new.example:8080" } });
    fireEvent.input(getKeyField(), { target: { value: "sk-new" } });
    await runTest(["m1"]);
    fireEvent.click(getConnect());

    expect(await screen.findByText("ServiceHub is not connected.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply model change" })).toBeNull();
  });

  test("a successful Apply closes the pop-up and clears the typed key", async () => {
    renderConnectedCardWithApply(async () => true);
    fireEvent.input(getKeyField(), { target: { value: "sk-new" } });
    fireEvent.click(getConnect());

    fireEvent.click(await screen.findByRole("button", { name: "Apply model change" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Apply model change" })).toBeNull());
    expect(getKeyField().value).toBe("");
  });
});

describe("EdgeServerCard key and messages", () => {
  test("a Test Connection error stays on the card while the Apply pop-up is open", async () => {
    const [error, setError] = createSignal<string | null>(null);
    render(() => (
      <EdgeServerCard
        edgeConfigured
        edgeConnected
        edgeBaseUrl={SAVED_URL}
        edgeModelName="saved-model"
        edgeBypassProxy
        error={error()}
        onTest={async () => SERVED}
        onConnect={async () => undefined}
        onApply={async () => false}
      />
    ));
    await runTest(SERVED);
    // Test Connection fails during this visit.
    setError("No available workers");
    await pickModel("other-model");
    fireEvent.click(getConnect());

    expect(await screen.findByRole("button", { name: "Apply model change" })).toBeTruthy();
    expect(screen.getByText("No available workers")).toBeTruthy();
  });

  test("the first Backspace on the saved URL clears the whole field", () => {
    renderConnectedCard();

    fireEvent.keyDown(getUrlField(), { key: "Backspace" });
    expect(getUrlField().value).toBe("");

    // After that, Backspace works as usual on what the user typed.
    fireEvent.input(getUrlField(), { target: { value: "http://new.example" } });
    const notCleared = fireEvent.keyDown(getUrlField(), { key: "Backspace" });
    expect(notCleared).toBe(true);
    expect(getUrlField().value).toBe("http://new.example");
  });

  test("Backspace clears the whole field after Test Connection on a changed URL", async () => {
    renderConnectedCard();

    // Point at a different server (a new origin needs its own key) and confirm it with Test Connection.
    fireEvent.input(getUrlField(), { target: { value: "http://new.example:9000" } });
    fireEvent.input(getKeyField(), { target: { value: "sk-new-server" } });
    await runTest(SERVED);

    // The clear-all shortcut is back for the just-tested URL, not only the saved one.
    fireEvent.keyDown(getUrlField(), { key: "Backspace" });
    expect(getUrlField().value).toBe("");
  });

  test("Backspace on an edited URL only deletes as usual", () => {
    renderConnectedCard();
    fireEvent.input(getUrlField(), { target: { value: "http://edge.example:808" } });

    const notCleared = fireEvent.keyDown(getUrlField(), { key: "Backspace" });

    expect(notCleared).toBe(true);
    expect(getUrlField().value).toBe("http://edge.example:808");
  });

  test("with no saved server, Backspace only deletes as usual", () => {
    render(() => (
      <EdgeServerCard edgeConfigured={false} edgeBaseUrl="" edgeModelName="" onConnect={async () => undefined} />
    ));
    fireEvent.input(getUrlField(), { target: { value: "http://new.example" } });

    expect(fireEvent.keyDown(getUrlField(), { key: "Backspace" })).toBe(true);
    expect(getUrlField().value).toBe("http://new.example");
  });

  test("changing the URL clears a typed key", () => {
    renderConnectedCard();
    fireEvent.input(getKeyField(), { target: { value: "sk-old-server" } });

    fireEvent.input(getUrlField(), { target: { value: "http://other.example:9000" } });

    expect(getKeyField().value).toBe("");
  });

  test("an error hides the success message, so only one message shows", () => {
    const [error, setError] = createSignal<string | null>(null);
    const [success, setSuccess] = createSignal<string | null>(null);
    render(() => (
      <EdgeServerCard
        edgeConfigured
        edgeBaseUrl={SAVED_URL}
        edgeModelName="saved-model"
        error={error()}
        testSuccessMessage={success()}
        onConnect={async () => undefined}
      />
    ));

    setSuccess("Edge connected.");
    setError("No available workers");

    expect(screen.getByText("No available workers")).toBeTruthy();
    expect(screen.queryByText("Edge connected.")).toBeNull();
  });
});

describe("EdgeServerCard busy state", () => {
  const expectOneBusyButton = () => {
    const busyButton = screen.getByTestId("edge-busy") as HTMLButtonElement;
    // Same look and size as Test Connection.
    expect(busyButton.disabled).toBe(true);
    expect(busyButton.className).toContain("h-8");
    expect(screen.queryByRole("button", { name: "Test Connection" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(document.querySelectorAll(".animate-spin")).toHaveLength(1);
  };

  test("while Test Connection runs, one spinner replaces both buttons", () => {
    render(() => (
      <EdgeServerCard
        edgeConfigured={false}
        edgeBaseUrl=""
        edgeModelName=""
        testing
        onTest={async () => undefined}
        onConnect={async () => undefined}
      />
    ));
    expectOneBusyButton();
  });

  test("while Connect stages the switch, one spinner replaces both buttons, and they come back after", async () => {
    let finishStaging!: () => void;
    render(() => (
      <EdgeServerCard
        edgeConfigured={false}
        edgeBaseUrl=""
        edgeModelName=""
        onTest={async () => ["m1"]}
        onConnect={() => new Promise<void>((resolve) => (finishStaging = resolve))}
        onApply={async () => false}
      />
    ));
    fireEvent.input(getUrlField(), { target: { value: "http://new.example:8080" } });
    fireEvent.input(getKeyField(), { target: { value: "sk-new" } });
    await runTest(["m1"]);
    fireEvent.click(getConnect());

    expectOneBusyButton();
    finishStaging();
    await waitFor(() => expect(screen.getByRole("button", { name: "Test Connection" })).toBeTruthy());
    expect(screen.queryByTestId("edge-busy")).toBeNull();
  });

  test("while Connect stages the switch, the fields are locked, so the dialog names what is staged", async () => {
    let finishStaging!: () => void;
    render(() => (
      <EdgeServerCard
        edgeConfigured={false}
        edgeBaseUrl=""
        edgeModelName=""
        onTest={async () => ["m1"]}
        onConnect={() => new Promise<void>((resolve) => (finishStaging = resolve))}
        onApply={async () => false}
      />
    ));
    fireEvent.input(getUrlField(), { target: { value: "http://new.example:8080" } });
    fireEvent.input(getKeyField(), { target: { value: "sk-new" } });
    await runTest(["m1"]);
    fireEvent.click(getConnect());

    const fieldset = getUrlField().closest("fieldset") as HTMLFieldSetElement;
    expect(fieldset.disabled).toBe(true);
    finishStaging();
    await waitFor(() => expect(fieldset.disabled).toBe(false));
  });
});

describe("EdgeServerCard with no saved server", () => {
  test("Connect waits for a model from Test Connection, which lists only what the server returns", async () => {
    render(() => (
      <EdgeServerCard
        edgeConfigured={false}
        edgeBaseUrl=""
        edgeModelName=""
        onTest={async () => ["m1", "m2"]}
        onConnect={async () => undefined}
      />
    ));
    fireEvent.input(getUrlField(), { target: { value: "http://new.example:8080" } });
    fireEvent.input(getKeyField(), { target: { value: "sk-new" } });
    expect(getModelField().disabled).toBe(true);
    expect(getModelField().placeholder).toBe("Test Connection to load models");
    expect(getConnect().disabled).toBe(true);

    await runTest(["m1", "m2"]);
    expect(getModelField().value).toBe("m1");
    expect(getConnect().disabled).toBe(false);
  });

  test("a successful test that serves no supported model says so and keeps Connect disabled", async () => {
    render(() => (
      <EdgeServerCard
        edgeConfigured={false}
        edgeBaseUrl=""
        edgeModelName=""
        onTest={async () => []}
        onConnect={async () => undefined}
      />
    ));
    fireEvent.input(getUrlField(), { target: { value: "http://new.example:8080" } });
    fireEvent.input(getKeyField(), { target: { value: "sk-new" } });
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));

    expect(await screen.findByText("This server serves no supported model.")).toBeTruthy();
    expect(getModelField().disabled).toBe(true);
    expect(getConnect().disabled).toBe(true);
  });
});

describe("EdgeServerCard one message box", () => {
  const getMessage = () => screen.queryByTestId("edge-message");

  // Like settings.tsx: the parent clears the success message, runs the test, then sets it again.
  const renderWithParentTest = (runTest: () => Promise<void>) => {
    const [successMessage, setSuccessMessage] = createSignal<string | null>(null);
    render(() => (
      <EdgeServerCard
        edgeConfigured
        edgeConnected
        edgeBaseUrl={SAVED_URL}
        edgeModelName="saved-model"
        edgeBypassProxy
        testSuccessMessage={successMessage()}
        onTest={async () => {
          setSuccessMessage(null);
          await runTest();
          setSuccessMessage("Connection successful.");
        }}
        onConnect={async () => undefined}
      />
    ));
    return { setSuccessMessage };
  };

  test("the success message stays in the same box while Test Connection runs again", async () => {
    let finishTest!: () => void;
    const { setSuccessMessage } = renderWithParentTest(
      () => new Promise<void>((resolve) => (finishTest = resolve)),
    );
    setSuccessMessage("Connection successful.");
    const box = getMessage();
    expect(box?.textContent).toBe("Connection successful.");

    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));

    // The parent cleared the message, but the same box still shows it.
    expect(getMessage()).toBe(box);
    expect(box?.textContent).toBe("Connection successful.");

    finishTest();
    await waitFor(() => expect(screen.getByRole("button", { name: "Test Connection" })).toBeTruthy());
    expect(getMessage()).toBe(box);
  });

  test("an error and a success use the same box and fade between colors", () => {
    const [error, setError] = createSignal<string | null>(null);
    const [successMessage, setSuccessMessage] = createSignal<string | null>(null);
    const [testing, setTesting] = createSignal(false);
    render(() => (
      <EdgeServerCard
        edgeConfigured
        edgeBaseUrl={SAVED_URL}
        edgeModelName="saved-model"
        error={error()}
        testSuccessMessage={successMessage()}
        testing={testing()}
        onConnect={async () => undefined}
      />
    ));
    setError("could not reach edge upstream");
    const box = getMessage();
    expect(box?.className).toContain("transition-colors");
    expect(box?.className).toContain("text-dls-danger-text");

    // A second Test Connection clears the error while it runs, then succeeds.
    setTesting(true);
    setError(null);
    expect(getMessage()).toBe(box);
    setSuccessMessage("Connection successful.");
    setTesting(false);

    expect(getMessage()).toBe(box);
    expect(box?.className).toContain("text-dls-success-text");
    expect(box?.textContent).toBe("Connection successful.");
  });
});

describe("EdgeServerCard Disconnect", () => {
  const renderLiteCard = (onDisconnect: () => Promise<void>, canDisconnect = true) =>
    render(() => (
      <EdgeServerCard
        edgeConfigured
        edgeConnected
        edgeBaseUrl={SAVED_URL}
        edgeModelName="saved-model"
        edgeBypassProxy
        onTest={async () => SERVED}
        onConnect={async () => undefined}
        canDisconnect={canDisconnect}
        onDisconnect={onDisconnect}
      />
    ));

  test("is hidden when the device cannot disconnect Edge", () => {
    renderLiteCard(async () => undefined, false);

    expect(screen.queryByTestId("edge-disconnect")).toBeNull();
  });

  test("replaces the disabled Connect action while Edge is connected", () => {
    renderLiteCard(async () => undefined);

    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeTruthy();
    expect(screen.getByTestId("edge-disconnect")).toBeTruthy();
  });

  test("restores Connect for edited settings so the change can be applied", async () => {
    const connectCalls: boolean[] = [];
    render(() => (
      <EdgeServerCard
        edgeConfigured
        edgeConnected
        edgeBaseUrl={SAVED_URL}
        edgeModelName="saved-model"
        edgeBypassProxy
        onTest={async () => SERVED}
        onConnect={async () => {
          connectCalls.push(true);
        }}
        onApply={async () => false}
        canDisconnect
        onDisconnect={async () => undefined}
      />
    ));

    fireEvent.input(getKeyField(), { target: { value: "sk-new" } });

    expect(screen.queryByTestId("edge-disconnect")).toBeNull();
    expect(getConnect().disabled).toBe(false);
    fireEvent.click(getConnect());

    expect(await screen.findByRole("button", { name: "Apply model change" })).toBeTruthy();
    expect(connectCalls).toEqual([true]);
  });

  test("stays visible after LRM released Edge, so a failed disconnect can be finished", () => {
    render(() => (
      <EdgeServerCard
        edgeConfigured={false}
        edgeConnected={false}
        edgeBaseUrl=""
        edgeModelName=""
        onConnect={async () => undefined}
        canDisconnect
        onDisconnect={async () => undefined}
      />
    ));

    expect(screen.getByTestId("edge-disconnect")).toBeTruthy();
  });

  test("can disconnect after Test Connection returns no supported models", async () => {
    let calls = 0;
    render(() => (
      <EdgeServerCard
        edgeConfigured
        edgeConnected
        edgeBaseUrl={SAVED_URL}
        edgeModelName="saved-model"
        onTest={async () => []}
        onConnect={async () => undefined}
        canDisconnect
        onDisconnect={async () => {
          calls += 1;
        }}
      />
    ));

    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    expect(await screen.findByText("This server serves no supported model.")).toBeTruthy();
    expect(getModelField().value).toBe("");
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();

    fireEvent.click(screen.getByTestId("edge-disconnect"));
    fireEvent.click(screen.getByTestId("edge-disconnect-confirm"));

    await waitFor(() => expect(calls).toBe(1));
    await waitFor(() => expect(getUrlField().value).toBe(""));
  });

  test("can retry a failed disconnect after remounting with a blank form", async () => {
    let calls = 0;
    const onDisconnect = async () => {
      calls += 1;
      if (calls === 1) throw new Error("Disconnect failed.");
    };
    const card = renderLiteCard(onDisconnect);

    fireEvent.click(screen.getByTestId("edge-disconnect"));
    fireEvent.click(screen.getByTestId("edge-disconnect-confirm"));
    await waitFor(() => expect(screen.getByTestId("edge-message").textContent).toBe("Disconnect failed."));

    card.unmount();
    renderLiteCard(onDisconnect);
    expect(getUrlField().value).toBe("");
    expect(getModelField().value).toBe("");
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();

    fireEvent.click(screen.getByTestId("edge-disconnect"));
    fireEvent.click(screen.getByTestId("edge-disconnect-confirm"));

    await waitFor(() => expect(calls).toBe(2));
  });

  test("asks for confirmation, and Cancel keeps the connection", () => {
    let calls = 0;
    renderLiteCard(async () => {
      calls += 1;
    });

    fireEvent.click(screen.getByTestId("edge-disconnect"));
    expect(screen.getByText("Disconnect Edge Server?")).toBeTruthy();
    fireEvent.click(screen.getByTestId("modal-dismiss-btn"));

    expect(screen.queryByText("Disconnect Edge Server?")).toBeNull();
    expect(calls).toBe(0);
  });

  test("confirming disconnects and clears the saved server from the form", async () => {
    let calls = 0;
    renderLiteCard(async () => {
      calls += 1;
    });

    fireEvent.click(screen.getByTestId("edge-disconnect"));
    fireEvent.click(screen.getByTestId("edge-disconnect-confirm"));

    await waitFor(() => expect(calls).toBe(1));
    await waitFor(() => expect(getUrlField().value).toBe(""));
  });

  test("a failed disconnect shows the error and keeps the form", async () => {
    renderLiteCard(async () => {
      throw new Error("Disconnect failed.");
    });

    fireEvent.click(screen.getByTestId("edge-disconnect"));
    fireEvent.click(screen.getByTestId("edge-disconnect-confirm"));

    await waitFor(() => expect(screen.getByTestId("edge-message").textContent).toBe("Disconnect failed."));
    expect(getUrlField().value).not.toBe("");
  });
});