/**
 * Settings → Model Routing → Cloud Model Settings.
 *
 * Picking a model only selects it. Connect tests the model, then saves it.
 * The combobox itself lives in `model-combobox.tsx` (shared with the dictation
 * clean-up card); the last block below pins its filtering, keyboard and revert
 * rules as this card uses them.
 *
 * Needs a DOM (a focus-out handler and delegated keydown), so it runs in the
 * vitest lane rather than under `bun test`.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { LlmRouterCloudModel } from "../lib/llmrouter-client";
import CloudModelSettings, {
  clearCloudModelListCache,
  resetCloudModelRemoval,
  resetCloudModelWriteQueue,
  type CloudModelSettingsProps,
} from "./cloud-model-settings";

const PROVIDERS = [
  { id: "openai", name: "OpenAI" },
  { id: "zai", name: "Z.ai" },
];
const MODELS = [
  { id: "gpt-a", name: "GPT A", release_date: "" },
  { id: "gpt-b", name: "GPT B", release_date: "" },
];
const SELECTED_HINT = "Model selected, click Connect to save.";
const SAVED_MESSAGE = "Cloud model saved. Connection successful.";

afterEach(() => {
  cleanup();
  clearCloudModelListCache();
  resetCloudModelWriteQueue();
  resetCloudModelRemoval();
  localStorage.clear();
});

const SAVED_GPT_A: LlmRouterCloudModel = {
  provider: "openai",
  model: "gpt-a",
  auth_mode: "api_key",
  max_tokens: 1,
  context_limit: 1,
};

function renderCard(overrides: Partial<CloudModelSettingsProps> = {}, savedModel: LlmRouterCloudModel | null = null) {
  const [cloudModel, setCloudModel] = createSignal<LlmRouterCloudModel | null>(savedModel);
  const onSave = vi.fn(async (input: { provider: string; model: string }) => {
    setCloudModel({ ...input, auth_mode: "api_key", max_tokens: 1, context_limit: 1 });
  });
  const onCheckModel = vi.fn(async () => undefined);
  const onDelete = vi.fn(async () => {
    setCloudModel(null);
  });
  const onDisconnectProvider = vi.fn(async () => undefined);
  render(() => (
    <CloudModelSettings
      providers={PROVIDERS}
      providerConnectedIds={["openai", "zai"]}
      cloudModel={cloudModel()}
      onLoadModels={async () => MODELS}
      onSave={onSave}
      onCheckModel={onCheckModel}
      onDelete={onDelete}
      onDisconnectProvider={onDisconnectProvider}
      {...overrides}
    />
  ));
  return { onSave, onCheckModel, onDelete, onDisconnectProvider };
}

async function pickModel(name: string) {
  fireEvent.focus(screen.getByTestId("cloud-model-input"));
  // Listbox options select on mousedown, so a click would not pick one.
  fireEvent.mouseDown(await screen.findByRole("option", { name }));
}

const getConnect = () => screen.getByTestId("cloud-model-connect-button") as HTMLButtonElement;

describe("CloudModelSettings Connect", () => {
  test("picking a model does not save it and asks for Connect", async () => {
    const { onSave } = renderCard();
    expect(getConnect().disabled).toBe(true);

    await pickModel("GPT A");

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(SELECTED_HINT)).toBeTruthy();
    expect(getConnect().disabled).toBe(false);
  });

  test("Connect tests the model, then saves it", async () => {
    const { onSave, onCheckModel } = renderCard();
    await pickModel("GPT A");

    fireEvent.click(getConnect());

    await waitFor(() => expect(screen.getByText(SAVED_MESSAGE)).toBeTruthy());
    expect(onCheckModel).toHaveBeenCalledWith({ provider: "openai", model: "gpt-a" });
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ provider: "openai", model: "gpt-a" }));
    expect(onCheckModel.mock.invocationCallOrder[0]).toBeLessThan(onSave.mock.invocationCallOrder[0]);
    expect(screen.queryByText(SELECTED_HINT)).toBeNull();
    // The saved model is the selection now, so there is nothing left to connect.
    expect(getConnect().disabled).toBe(true);
  });

  test("while Connect runs, the provider and model pickers are locked", async () => {
    let finishCheck!: () => void;
    renderCard({
      onCheckModel: () => new Promise<void>((resolve) => (finishCheck = resolve)),
    });
    await pickModel("GPT A");
    const providerTrigger = screen.getByTestId("cloud-provider-dropdown-trigger") as HTMLButtonElement;
    const modelInput = screen.getByTestId("cloud-model-input") as HTMLInputElement;

    fireEvent.click(getConnect());

    await waitFor(() => expect(screen.getByTestId("cloud-model-busy")).toBeTruthy());
    expect(providerTrigger.disabled).toBe(true);
    expect(modelInput.disabled).toBe(true);

    finishCheck();
    await waitFor(() => expect(screen.getByText(SAVED_MESSAGE)).toBeTruthy());
    expect(providerTrigger.disabled).toBe(false);
    expect(modelInput.disabled).toBe(false);
  });

  test("while Connect runs, the click-Connect hint stays visible with no gap, then the saved message replaces it", async () => {
    let finishCheck!: () => void;
    renderCard({
      onCheckModel: () => new Promise<void>((resolve) => (finishCheck = resolve)),
    });
    await pickModel("GPT A");
    expect(screen.getByText(SELECTED_HINT)).toBeTruthy();

    fireEvent.click(getConnect());

    await waitFor(() => expect(screen.getByTestId("cloud-model-busy")).toBeTruthy());
    // No blank gap: the hint the user was already looking at stays up while Connect runs.
    expect(screen.getByText(SELECTED_HINT)).toBeTruthy();

    finishCheck();
    await waitFor(() => expect(screen.getByText(SAVED_MESSAGE)).toBeTruthy());
    expect(screen.queryByText(SELECTED_HINT)).toBeNull();
  });

  test("a prior Test Connection success stays visible through Connect, then the saved message replaces it", async () => {
    let finishCheck!: () => void;
    const [testSuccessMessage, setTestSuccessMessage] = createSignal<string | null>(null);
    renderCard({
      get onTestSuccessMessage() {
        return testSuccessMessage();
      },
      onCheckModel: () => new Promise<void>((resolve) => (finishCheck = resolve)),
    });
    await pickModel("GPT A");
    expect(screen.getByText(SELECTED_HINT)).toBeTruthy();

    // Test Connection succeeds (the parent passes the message down as a prop).
    setTestSuccessMessage("Connection successful.");
    expect(screen.getByText("Connection successful.")).toBeTruthy();

    fireEvent.click(getConnect());

    await waitFor(() => expect(screen.getByTestId("cloud-model-busy")).toBeTruthy());
    // No blank gap: the Test Connection success stays up while Connect runs.
    expect(screen.getByText("Connection successful.")).toBeTruthy();

    finishCheck();
    await waitFor(() => expect(screen.getByText(SAVED_MESSAGE)).toBeTruthy());
    expect(screen.queryByText("Connection successful.")).toBeNull();
  });

  test("a success stays in the same box while Test Connection runs again, with no hint in between", async () => {
    let finishTest!: () => void;
    const [testSuccessMessage, setTestSuccessMessage] = createSignal<string | null>(null);
    renderCard({
      get onTestSuccessMessage() {
        return testSuccessMessage();
      },
      // Like settings.tsx: clear the message, run the test, then set it again.
      onTest: async () => {
        setTestSuccessMessage(null);
        await new Promise<void>((resolve) => (finishTest = resolve));
        setTestSuccessMessage("Connection successful.");
      },
    });
    await pickModel("GPT A");
    setTestSuccessMessage("Connection successful.");
    const box = screen.getByTestId("cloud-model-message");
    expect(box.textContent).toBe("Connection successful.");

    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));

    expect(screen.getByTestId("cloud-model-message")).toBe(box);
    expect(box.textContent).toBe("Connection successful.");

    finishTest();
    await waitFor(() => expect(screen.getByRole("button", { name: "Test Connection" })).toBeTruthy());
    expect(screen.getByTestId("cloud-model-message")).toBe(box);
    expect(box.textContent).toBe("Connection successful.");
  });

  test("Connect keeps the same message box and adds no Saving line", async () => {
    let finishSave!: () => void;
    const [saving, setSaving] = createSignal(false);
    renderCard({
      onSave: async () => {
        setSaving(true);
        await new Promise<void>((resolve) => (finishSave = resolve));
        setSaving(false);
      },
    });
    await pickModel("GPT A");
    const box = screen.getByTestId("cloud-model-message");

    fireEvent.click(getConnect());
    await waitFor(() => expect(saving()).toBe(true));

    // A line that shows only while saving makes the card taller for a moment.
    expect(screen.queryByText("Saving...")).toBeNull();
    expect(screen.getByTestId("cloud-model-message")).toBe(box);

    finishSave();
    await waitFor(() => expect(box.textContent).toBe(SAVED_MESSAGE));
    expect(screen.getByTestId("cloud-model-message")).toBe(box);
  });

  test("a failed test shows the error and saves nothing", async () => {
    const { onSave } = renderCard({
      onCheckModel: async () => {
        throw new Error("Model not reachable.");
      },
    });
    await pickModel("GPT B");

    fireEvent.click(getConnect());

    await waitFor(() => expect(screen.getByText("Model not reachable.")).toBeTruthy());
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByText(SAVED_MESSAGE)).toBeNull();
  });

  test("a delete from a removal still running when the card unmounts lands before the next card's Connect", async () => {
    let finishDelete: (() => void) | undefined;
    const [cloudModel, setCloudModel] = createSignal<LlmRouterCloudModel | null>(SAVED_GPT_A);
    const card = () => (
      <CloudModelSettings
        providers={PROVIDERS}
        providerConnectedIds={["openai", "zai"]}
        cloudModel={cloudModel()}
        onLoadModels={async () => MODELS}
        onSave={async (input) => {
          setCloudModel({ ...input, auth_mode: "api_key", max_tokens: 1, context_limit: 1 });
        }}
        onCheckModel={async () => undefined}
        onDelete={async () => {
          await new Promise<void>((resolve) => (finishDelete = resolve));
          setCloudModel(null);
        }}
        onDisconnectProvider={async () => undefined}
      />
    );
    const first = render(card);
    // Removing OpenAI clears its saved model first; the user leaves while that clear runs.
    fireEvent.click(screen.getByTestId("cloud-provider-dropdown-trigger"));
    await screen.findByRole("option", { name: /OpenAI/ });
    fireEvent.click(screen.getByRole("button", { name: "Remove provider: OpenAI" }));
    fireEvent.click(screen.getByTestId("remove-provider-confirm"));
    await waitFor(() => expect(finishDelete).toBeDefined());
    first.unmount();

    render(card);
    // The new instance stays locked (busy) until the removal from the old
    // instance finishes: no Connect can start while a provider is being signed
    // out. Finishing the delete here is what unlocks it.
    expect(screen.getByTestId("cloud-model-busy")).toBeTruthy();
    finishDelete?.();
    await waitFor(() => expect(screen.queryByTestId("cloud-model-busy")).toBeNull());

    fireEvent.click(screen.getByTestId("cloud-provider-dropdown-trigger"));
    fireEvent.mouseDown(await screen.findByRole("option", { name: /Z\.ai/ }));
    await pickModel("GPT B");
    fireEvent.click(getConnect());

    await waitFor(() => expect(screen.getByText(SAVED_MESSAGE)).toBeTruthy());
    expect(cloudModel()).toEqual(expect.objectContaining({ provider: "zai", model: "gpt-b" }));
  });

  test("a remount shows the card as busy while the previous instance's removal is still running", async () => {
    let finishDisconnect: (() => void) | undefined;
    const [cloudModel] = createSignal<LlmRouterCloudModel | null>(SAVED_GPT_A);
    const card = () => (
      <CloudModelSettings
        providers={PROVIDERS}
        providerConnectedIds={["openai", "zai"]}
        cloudModel={cloudModel()}
        onLoadModels={async () => MODELS}
        onSave={async () => undefined}
        onCheckModel={async () => undefined}
        onDelete={async () => undefined}
        onDisconnectProvider={async () => {
          await new Promise<void>((resolve) => (finishDisconnect = resolve));
        }}
      />
    );
    const first = render(card);
    // Removing OpenAI clears its saved model, then signs it out; the user
    // leaves Settings while that sign-out is still running.
    fireEvent.click(screen.getByTestId("cloud-provider-dropdown-trigger"));
    await screen.findByRole("option", { name: /OpenAI/ });
    fireEvent.click(screen.getByRole("button", { name: "Remove provider: OpenAI" }));
    fireEvent.click(screen.getByTestId("remove-provider-confirm"));
    await waitFor(() => expect(finishDisconnect).toBeDefined());
    first.unmount();

    render(card);
    // The new instance has no memory of the removal in its own state, but the
    // module-level lock must still show it as busy: no Connect button reachable.
    expect(screen.getByTestId("cloud-model-busy")).toBeTruthy();
    expect(screen.queryByTestId("cloud-model-connect-button")).toBeNull();

    finishDisconnect?.();
    await waitFor(() => expect(screen.queryByTestId("cloud-model-busy")).toBeNull());
  });

  test("a remount stays busy while the previous instance's Connect is still testing, so no removal can start", async () => {
    let finishCheck: (() => void) | undefined;
    const [cloudModel, setCloudModel] = createSignal<LlmRouterCloudModel | null>(null);
    const onDelete = vi.fn(async () => undefined);
    const card = () => (
      <CloudModelSettings
        providers={PROVIDERS}
        providerConnectedIds={["openai", "zai"]}
        cloudModel={cloudModel()}
        onLoadModels={async () => MODELS}
        onSave={async (input) => {
          setCloudModel({ ...input, auth_mode: "api_key", max_tokens: 1, context_limit: 1 });
        }}
        onCheckModel={() => new Promise<void>((resolve) => (finishCheck = resolve))}
        onDelete={onDelete}
        onDisconnectProvider={async () => undefined}
      />
    );
    const first = render(card);
    // Connect on OpenAI; the user leaves Settings while the model test runs.
    await pickModel("GPT A");
    fireEvent.click(getConnect());
    await waitFor(() => expect(finishCheck).toBeDefined());
    first.unmount();

    render(card);
    // The new card must not offer Connect or a removal until the old Connect ends.
    expect(screen.getByTestId("cloud-model-busy")).toBeTruthy();
    fireEvent.click(screen.getByTestId("cloud-provider-dropdown-trigger"));
    expect(screen.queryByRole("button", { name: "Remove provider: OpenAI" })).toBeNull();

    finishCheck?.();
    await waitFor(() => expect(screen.queryByTestId("cloud-model-busy")).toBeNull());
    expect(cloudModel()).toEqual(expect.objectContaining({ provider: "openai", model: "gpt-a" }));
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe("CloudModelSettings model list after a tab switch", () => {
  test("coming back shows the cached list at once, with no Loading models line", async () => {
    let finishSecondLoad!: (items: typeof MODELS) => void;
    let loads = 0;
    const onLoadModels = () => {
      loads += 1;
      if (loads === 1) return Promise.resolve(MODELS);
      return new Promise<typeof MODELS>((resolve) => (finishSecondLoad = resolve));
    };
    renderCard({ onLoadModels }, SAVED_GPT_A);
    await waitFor(() => expect(screen.queryByText(/Loading models/)).toBeNull());
    cleanup();

    // Back on the tab: the second load is still running.
    renderCard({ onLoadModels }, SAVED_GPT_A);
    expect(screen.queryByText(/Loading models/)).toBeNull();
    fireEvent.focus(screen.getByTestId("cloud-model-input"));
    expect(await screen.findByRole("option", { name: "GPT B" })).toBeTruthy();
    expect(loads).toBe(2);

    // The quiet refresh then replaces the list.
    finishSecondLoad([{ id: "gpt-c", name: "GPT C", release_date: "" }]);
    expect(await screen.findByRole("option", { name: "GPT C" })).toBeTruthy();
  });

  test("the first visit still shows Loading models", () => {
    renderCard({ onLoadModels: () => new Promise(() => undefined) });
    expect(screen.getByText(/Loading models/)).toBeTruthy();
  });

  test("a failed quiet refresh keeps the cached list and shows no error", async () => {
    let loads = 0;
    const onLoadModels = async () => {
      loads += 1;
      if (loads === 1) return MODELS;
      throw new Error("provider down");
    };
    renderCard({ onLoadModels }, SAVED_GPT_A);
    await waitFor(() => expect(loads).toBe(1));
    cleanup();

    renderCard({ onLoadModels }, SAVED_GPT_A);
    await waitFor(() => expect(loads).toBe(2));
    fireEvent.focus(screen.getByTestId("cloud-model-input"));
    expect(await screen.findByRole("option", { name: "GPT B" })).toBeTruthy();
    expect(screen.queryByText("Couldn't load model list")).toBeNull();
  });
});

describe("CloudModelSettings busy state", () => {
  test("while Connect runs, one spinner replaces both buttons, and they come back after", async () => {
    let finishCheck!: () => void;
    renderCard({
      onTest: async () => undefined,
      onCheckModel: () => new Promise<void>((resolve) => (finishCheck = resolve)),
    });
    await pickModel("GPT A");

    fireEvent.click(getConnect());

    await waitFor(() => expect(screen.getByTestId("cloud-model-busy")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Test Connection" })).toBeNull();
    expect(screen.queryByTestId("cloud-model-connect-button")).toBeNull();
    expect(document.querySelectorAll(".animate-spin")).toHaveLength(1);

    finishCheck();
    await waitFor(() => expect(screen.getByRole("button", { name: "Test Connection" })).toBeTruthy());
    expect(getConnect()).toBeTruthy();
    expect(screen.queryByTestId("cloud-model-busy")).toBeNull();
  });

  test("while Test Connection runs, one spinner replaces both buttons", () => {
    renderCard({ onTest: async () => undefined, testing: true });
    const busyButton = screen.getByTestId("cloud-model-busy") as HTMLButtonElement;
    // It is a disabled button with the same classes as Test Connection.
    expect(busyButton.tagName).toBe("BUTTON");
    expect(busyButton.disabled).toBe(true);
    expect(busyButton.className).toContain("h-8");
    expect(busyButton.className).toContain("px-4");
    expect(screen.queryByRole("button", { name: "Test Connection" })).toBeNull();
    expect(screen.queryByTestId("cloud-model-connect-button")).toBeNull();
  });
});

describe("CloudModelSettings one message at a time", () => {
  const getMessages = () => screen.queryAllByTestId("cloud-model-message");

  test("the health warning hides the success message", async () => {
    const [healthError, setHealthError] = createSignal<string | null>(null);
    renderCard({
      get cloudModelHealthError() {
        return healthError();
      },
    });
    await pickModel("GPT A");
    fireEvent.click(getConnect());
    await waitFor(() => expect(screen.getByText(SAVED_MESSAGE)).toBeTruthy());

    setHealthError("model not reachable");

    expect(getMessages()).toHaveLength(1);
    expect(getMessages()[0].textContent).toContain("model not reachable");
    expect(screen.queryByText(SAVED_MESSAGE)).toBeNull();
  });

  test("an error hides the health warning and the hint", async () => {
    renderCard({
      cloudModelHealthError: "model not reachable",
      onCheckModel: async () => {
        throw new Error("Model not reachable.");
      },
    });
    await pickModel("GPT B");
    fireEvent.click(getConnect());

    await waitFor(() => expect(screen.getByText("Model not reachable.")).toBeTruthy());
    expect(getMessages()).toHaveLength(1);
  });
});

describe("CloudModelSettings newly connected provider", () => {
  test("a saved model on a provider that is not connected does not block the new provider", async () => {
    const [connectedIds, setConnectedIds] = createSignal<string[]>([]);
    render(() => (
      <CloudModelSettings
        providers={[...PROVIDERS, { id: "github_copilot", name: "GitHub Copilot" }]}
        providerConnectedIds={connectedIds()}
        // Saved earlier on OpenAI, which is not connected any more.
        cloudModel={SAVED_GPT_A}
        onLoadModels={async () => MODELS}
        onSave={async () => undefined}
        onDelete={async () => undefined}
      />
    ));
    expect(screen.getByText("Connect a cloud provider to get started with Auto Route.")).toBeTruthy();

    // GitHub Copilot sign-in succeeds.
    setConnectedIds(["github_copilot"]);

    await waitFor(() => expect(screen.getByTestId("cloud-model-input")).toBeTruthy());
    expect(screen.getByTestId("cloud-provider-dropdown-trigger").textContent).toContain("GitHub Copilot");
  });

  test("a saved model on a connected provider stays selected when another provider connects", async () => {
    const [connectedIds, setConnectedIds] = createSignal<string[]>(["openai"]);
    render(() => (
      <CloudModelSettings
        providers={PROVIDERS}
        providerConnectedIds={connectedIds()}
        cloudModel={SAVED_GPT_A}
        onLoadModels={async () => MODELS}
        onSave={async () => undefined}
        onDelete={async () => undefined}
      />
    ));
    await waitFor(() => expect(screen.getByTestId("cloud-model-input")).toBeTruthy());

    setConnectedIds(["openai", "zai"]);

    // A provider added later is selected, as before this fix.
    await waitFor(() =>
      expect(screen.getByTestId("cloud-provider-dropdown-trigger").textContent).toContain("Z.ai"),
    );
  });
});

describe("CloudModelSettings buttons", () => {
  test("shows only Test Connection and Connect, with no Clear", () => {
    renderCard({ onTest: async () => undefined });
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeTruthy();
    expect(getConnect()).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });
});

describe("CloudModelSettings remove provider", () => {
  const openProviderMenu = () => fireEvent.click(screen.getByTestId("cloud-provider-dropdown-trigger"));
  const getRemoveButton = (providerName: string) => {
    const row = screen.getAllByRole("option").find((option) => option.textContent?.startsWith(providerName));
    return row?.querySelector(`button[aria-label="Remove provider: ${providerName}"]`) as HTMLButtonElement;
  };
  const providerRowLabels = () => screen.getAllByRole("option").map((option) => option.textContent ?? "");
  // Click the dustbin, then confirm in the dialog it opens.
  const removeProvider = (providerName: string) => {
    fireEvent.click(getRemoveButton(providerName));
    fireEvent.click(screen.getByTestId("remove-provider-confirm"));
  };

  test("the dustbin asks first, and Cancel removes nothing", async () => {
    const { onDisconnectProvider, onDelete } = renderCard({}, SAVED_GPT_A);
    openProviderMenu();
    await screen.findByRole("option", { name: /OpenAI/ });

    fireEvent.click(getRemoveButton("OpenAI"));
    expect(screen.getByText("Remove provider?")).toBeTruthy();
    // Portalled out of the card, so its backdrop covers the whole window.
    expect(screen.getByTestId("cloud-model-settings").contains(screen.getByText("Remove provider?"))).toBe(false);
    // Two lines: the provider and its model, then that sign-in is needed to get it back.
    expect(screen.getByText("OpenAI and its model gpt-a will be removed.")).toBeTruthy();
    expect(screen.getByText("To use OpenAI again, you must sign in again. Continue?")).toBeTruthy();
    expect(onDisconnectProvider).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("remove-provider-cancel"));
    expect(screen.queryByText("Remove provider?")).toBeNull();
    expect(onDisconnectProvider).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  test("for a provider with no model, the confirm message names only the provider", async () => {
    renderCard({}, SAVED_GPT_A);
    openProviderMenu();
    await screen.findByRole("option", { name: /Z\.ai/ });

    fireEvent.click(getRemoveButton("Z.ai"));
    expect(screen.getByText("Z.ai will be removed.")).toBeTruthy();
    expect(screen.getByText("To use Z.ai again, you must sign in again. Continue?")).toBeTruthy();
  });

  test("the confirm is a labelled modal dialog that takes focus, keeps Tab inside, and cancels on Escape", async () => {
    const { onDisconnectProvider } = renderCard({}, SAVED_GPT_A);
    openProviderMenu();
    await screen.findByRole("option", { name: /Z\.ai/ });
    const dustbin = getRemoveButton("Z.ai");
    dustbin.focus();
    fireEvent.click(dustbin);

    const dialog = screen.getByRole("dialog", { name: "Remove provider?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    // Cancel takes focus first, so Enter on a fresh dialog removes nothing.
    const cancel = screen.getByTestId("remove-provider-cancel");
    const confirm = screen.getByTestId("remove-provider-confirm");
    await waitFor(() => expect(document.activeElement).toBe(cancel));

    // Tab wraps between the two buttons, both ways.
    confirm.focus();
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);

    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onDisconnectProvider).not.toHaveBeenCalled();
    // Focus goes back to the provider dropdown (the menu holding the dustbin has closed).
    expect(document.activeElement).toBe(screen.getByTestId("cloud-provider-dropdown-trigger"));
  });

  test("while a removal runs, Connect and the pickers stay locked until the disconnect ends", async () => {
    let finishDelete: (() => void) | undefined;
    let finishDisconnect: (() => void) | undefined;
    renderCard(
      {
        onDelete: () => new Promise<void>((resolve) => (finishDelete = resolve)),
        onDisconnectProvider: () => new Promise<undefined>((resolve) => (finishDisconnect = () => resolve(undefined))),
      },
      SAVED_GPT_A,
    );
    await waitFor(() => expect((screen.getByTestId("cloud-model-input") as HTMLInputElement).value).toBe("GPT A"));
    openProviderMenu();
    await screen.findByRole("option", { name: /OpenAI/ });

    removeProvider("OpenAI");
    // Clearing the saved model: locked.
    await waitFor(() => expect(finishDelete).toBeDefined());
    expect(screen.getByTestId("cloud-model-busy")).toBeTruthy();
    expect(screen.queryByTestId("cloud-model-connect-button")).toBeNull();
    expect((screen.getByTestId("cloud-provider-dropdown-trigger") as HTMLButtonElement).disabled).toBe(true);

    // Signing the provider out: still locked.
    finishDelete?.();
    await waitFor(() => expect(finishDisconnect).toBeDefined());
    expect(screen.getByTestId("cloud-model-busy")).toBeTruthy();
    expect((screen.getByTestId("cloud-provider-dropdown-trigger") as HTMLButtonElement).disabled).toBe(true);

    finishDisconnect?.();
    await waitFor(() => expect(screen.queryByTestId("cloud-model-busy")).toBeNull());
    expect((screen.getByTestId("cloud-provider-dropdown-trigger") as HTMLButtonElement).disabled).toBe(false);
  });

  test("each other provider row has a hover-only remove button, and Add provider has none", async () => {
    renderCard();
    openProviderMenu();
    await screen.findByRole("option", { name: /Z\.ai/ });

    const removeButton = getRemoveButton("Z.ai");
    expect(removeButton).toBeTruthy();
    // Hidden until the row is hovered.
    expect(removeButton.className).toContain("opacity-0");
    expect(removeButton.className).toContain("group-hover:opacity-100");
    expect(getRemoveButton("+ Add provider")).toBeFalsy();
    // No tooltip: the dustbin icon says what it does.
    fireEvent.mouseEnter(removeButton);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  test("the provider in use has a green dot, and its dustbin takes the dot's place on hover", async () => {
    renderCard({}, { ...SAVED_GPT_A, provider: "zai" });
    openProviderMenu();
    await screen.findByRole("option", { name: /Z\.ai/ });

    // The provider of the saved model is first in the menu.
    expect(providerRowLabels()[0]).toBe("Z.ai");
    const dots = screen.getAllByTestId("cloud-provider-selected");
    expect(dots).toHaveLength(1);
    expect(dots[0].closest('[role="option"]')?.textContent).toBe("Z.ai");
    // Same grey dustbin as the other rows, hidden until hover.
    const removeButton = getRemoveButton("Z.ai");
    expect(removeButton.className).toBe(getRemoveButton("OpenAI").className);
    expect(removeButton.className).toContain("group-hover:opacity-100");
    // On hover the dot hides at once, with no fade.
    const dotSlot = dots[0].parentElement as HTMLElement;
    expect(dotSlot.className).toContain("group-hover:opacity-0");
    // The hidden dot must not catch the dustbin's click.
    expect(dotSlot.className).toContain("pointer-events-none");
    expect(dotSlot.className).not.toContain("transition");
    expect(removeButton.className).not.toContain("transition");
  });

  test("the selected provider has no check mark", async () => {
    renderCard({}, SAVED_GPT_A);
    openProviderMenu();
    const selectedRow = await screen.findByRole("option", { name: /OpenAI/ });
    expect(selectedRow.getAttribute("aria-selected")).toBe("true");
    expect(selectedRow.querySelector("svg.text-dls-success-dot")).toBeNull();
  });

  test("the green dot and the In use tag stay on the provider in use until Connect saves a model on another", async () => {
    renderCard({}, SAVED_GPT_A);
    const dotRow = () => screen.getByTestId("cloud-provider-selected").closest('[role="option"]')?.textContent;
    const inUseTag = () => screen.getByTestId("cloud-provider-in-use").textContent;
    expect(inUseTag()).toBe("In use OpenAI");
    openProviderMenu();
    fireEvent.mouseDown(await screen.findByRole("option", { name: /Z\.ai/ }));

    // Z.ai is picked, but chat still uses OpenAI, so the dot and the tag stay there.
    expect(inUseTag()).toBe("In use OpenAI");
    openProviderMenu();
    await screen.findByRole("option", { name: /Z\.ai/ });
    expect(screen.getAllByTestId("cloud-provider-selected")).toHaveLength(1);
    expect(dotRow()).toBe("OpenAI");
    // The provider of the saved model stays first.
    expect(providerRowLabels()[0]).toBe("OpenAI");
    fireEvent.keyDown(screen.getByTestId("cloud-provider-dropdown-trigger"), { key: "Escape" });

    await pickModel("GPT B");
    fireEvent.click(getConnect());
    await waitFor(() => expect(screen.getByText(SAVED_MESSAGE)).toBeTruthy());
    expect(inUseTag()).toBe("In use Z.ai");

    openProviderMenu();
    await screen.findByRole("option", { name: /Z\.ai/ });
    expect(screen.getAllByTestId("cloud-provider-selected")).toHaveLength(1);
    expect(dotRow()).toBe("Z.ai");
  });

  test("with no saved model the first provider is selected, with no green dot and no In use tag", async () => {
    renderCard();
    expect(screen.queryByTestId("cloud-provider-in-use")).toBeNull();
    openProviderMenu();
    const firstRow = await screen.findByRole("option", { name: /OpenAI/ });
    expect(firstRow.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("cloud-provider-selected")).toBeNull();
  });

  test("removes a provider without selecting its row", async () => {
    const { onDisconnectProvider, onDelete } = renderCard({}, SAVED_GPT_A);
    openProviderMenu();
    await screen.findByRole("option", { name: /Z\.ai/ });

    const removeButton = getRemoveButton("Z.ai");
    fireEvent.mouseDown(removeButton);
    fireEvent.click(removeButton);
    fireEvent.click(screen.getByTestId("remove-provider-confirm"));

    await waitFor(() => expect(onDisconnectProvider).toHaveBeenCalledWith("zai"));
    // The saved model belongs to another provider, so it stays.
    expect(onDelete).not.toHaveBeenCalled();
  });

  test("removing a provider shows no message", async () => {
    // The real disconnect returns a "Disconnected <id>" string.
    const onDisconnectProvider = vi.fn(async (providerId: string) => `Disconnected ${providerId}`);
    renderCard({ onDisconnectProvider });
    openProviderMenu();
    await screen.findByRole("option", { name: /OpenAI/ });

    removeProvider("OpenAI");

    await waitFor(() => expect(onDisconnectProvider).toHaveBeenCalledWith("openai"));
    await waitFor(() => expect(screen.getByTestId("cloud-provider-dropdown-trigger").textContent).toContain("Z.ai"));
    expect(screen.queryByTestId("cloud-model-message")).toBeNull();
  });

  test("clears the saved model first when it uses the removed provider", async () => {
    const { onDisconnectProvider, onDelete } = renderCard({}, SAVED_GPT_A);
    openProviderMenu();
    await screen.findByRole("option", { name: /OpenAI/ });

    // OpenAI is the selected row, and it has a dustbin too.
    removeProvider("OpenAI");

    await waitFor(() => expect(onDisconnectProvider).toHaveBeenCalledWith("openai"));
    expect(onDelete).toHaveBeenCalled();
    expect(onDelete.mock.invocationCallOrder[0]).toBeLessThan(onDisconnectProvider.mock.invocationCallOrder[0]);
  });

  test("removing the selected provider with one left selects that one, with the model empty and no green dot", async () => {
    const [connectedIds, setConnectedIds] = createSignal(["openai", "zai"]);
    renderCard(
      {
        get providerConnectedIds() {
          return connectedIds();
        },
        onDisconnectProvider: vi.fn(async (providerId: string) => {
          setConnectedIds((ids) => ids.filter((id) => id !== providerId));
        }),
      },
      SAVED_GPT_A,
    );
    openProviderMenu();
    await screen.findByRole("option", { name: /OpenAI/ });

    removeProvider("OpenAI");

    await waitFor(() =>
      expect(screen.getByTestId("cloud-provider-dropdown-trigger").textContent).toContain("Z.ai"),
    );
    // The saved model went with OpenAI, so no provider is in use until Connect.
    expect(screen.queryByTestId("cloud-provider-selected")).toBeNull();
    expect(screen.queryByTestId("cloud-provider-in-use")).toBeNull();
    expect((screen.getByTestId("cloud-model-input") as HTMLInputElement).value).toBe("");
  });

  test("removing the selected provider with several left clears the selection and hides the model section", async () => {
    const [connectedIds, setConnectedIds] = createSignal(["openai", "zai", "github_copilot"]);
    renderCard({
      providers: [...PROVIDERS, { id: "github_copilot", name: "GitHub Copilot" }],
      get providerConnectedIds() {
        return connectedIds();
      },
      onDisconnectProvider: vi.fn(async (providerId: string) => {
        setConnectedIds((ids) => ids.filter((id) => id !== providerId));
      }),
    });
    openProviderMenu();
    await screen.findByRole("option", { name: /OpenAI/ });

    removeProvider("OpenAI");

    await waitFor(() =>
      expect(screen.getByTestId("cloud-provider-dropdown-trigger").textContent).toContain("Select provider"),
    );
    expect(screen.queryByTestId("cloud-model-input")).toBeNull();
    expect(screen.queryByTestId("cloud-provider-selected")).toBeNull();
    // Other providers are still connected, so the first-time hint stays hidden.
    expect(screen.queryByText("Connect a cloud provider to get started with Auto Route.")).toBeNull();

    // The user can pick a provider again, once the removal has finished and the menu unlocks.
    await waitFor(() =>
      expect((screen.getByTestId("cloud-provider-dropdown-trigger") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.mouseDown(await screen.findByRole("option", { name: /Z\.ai/ }));
    await waitFor(() => expect(screen.getByTestId("cloud-model-input")).toBeTruthy());
    expect(screen.getByTestId("cloud-provider-dropdown-trigger").textContent).toContain("Z.ai");
  });

  test("removing a picked provider keeps the model saved on another provider", async () => {
    // Saved on OpenAI, then Z.ai is picked, with no Connect.
    const [connectedIds, setConnectedIds] = createSignal(["openai", "zai"]);
    const onDisconnectProvider = vi.fn(async (providerId: string) => {
      setConnectedIds((ids) => ids.filter((id) => id !== providerId));
    });
    const { onDelete, onSave } = renderCard(
      {
        get providerConnectedIds() {
          return connectedIds();
        },
        onDisconnectProvider,
      },
      SAVED_GPT_A,
    );
    openProviderMenu();
    fireEvent.mouseDown(await screen.findByRole("option", { name: /Z\.ai/ }));

    openProviderMenu();
    await screen.findByRole("option", { name: /Z\.ai/ });
    removeProvider("Z.ai");

    await waitFor(() => expect(onDisconnectProvider).toHaveBeenCalledWith("zai"));
    // The saved model is OpenAI's, so removing Z.ai leaves it, and chat with it.
    expect(onDelete).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("cloud-provider-dropdown-trigger").textContent).toContain("OpenAI"),
    );
    await waitFor(() => expect((screen.getByTestId("cloud-model-input") as HTMLInputElement).value).toBe("GPT A"));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId("cloud-model-settings").dataset.cloudModel).toBe("gpt-a");
    expect(screen.getByTestId("cloud-provider-in-use").textContent).toBe("In use OpenAI");
  });

  test("picking another provider writes nothing, so chat keeps the saved model until Connect", async () => {
    const { onDelete, onSave } = renderCard({}, SAVED_GPT_A);
    const savedOn = () => screen.getByTestId("cloud-model-settings").dataset;

    openProviderMenu();
    fireEvent.mouseDown(await screen.findByRole("option", { name: /Z\.ai/ }));
    await waitFor(() => expect((screen.getByTestId("cloud-model-input") as HTMLInputElement).value).toBe(""));

    expect(onDelete).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(savedOn().cloudProvider).toBe("openai");
    expect(savedOn().cloudModel).toBe("gpt-a");
  });

  test("a newly connected provider is picked in the card and writes nothing", async () => {
    const [connectedIds, setConnectedIds] = createSignal(["openai"]);
    const { onDelete, onSave } = renderCard(
      {
        get providerConnectedIds() {
          return connectedIds();
        },
      },
      SAVED_GPT_A,
    );
    await waitFor(() => expect(screen.getByTestId("cloud-model-input")).toBeTruthy());

    setConnectedIds(["openai", "zai"]);

    await waitFor(() =>
      expect(screen.getByTestId("cloud-provider-dropdown-trigger").textContent).toContain("Z.ai"),
    );
    expect(onDelete).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId("cloud-model-settings").dataset.cloudModel).toBe("gpt-a");
  });

  test("going back to the provider of the saved model fills it in, with nothing to Connect", async () => {
    const { onDelete, onSave, onCheckModel } = renderCard({}, SAVED_GPT_A);
    const modelInput = () => screen.getByTestId("cloud-model-input") as HTMLInputElement;
    await waitFor(() => expect(modelInput().value).toBe("GPT A"));

    openProviderMenu();
    fireEvent.mouseDown(await screen.findByRole("option", { name: /Z\.ai/ }));
    await waitFor(() => expect(modelInput().value).toBe(""));

    openProviderMenu();
    fireEvent.mouseDown(await screen.findByRole("option", { name: /OpenAI/ }));
    await waitFor(() => expect(modelInput().value).toBe("GPT A"));
    expect(onDelete).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(onCheckModel).not.toHaveBeenCalled();
    expect(getConnect().disabled).toBe(true);
    expect(screen.queryByText(SELECTED_HINT)).toBeNull();
  });

  test("a remembered model that is not the saved one asks for Connect, which tests it before saving", async () => {
    // Z.ai's model was connected once, then OpenAI's model replaced it.
    localStorage.setItem("openwork.cloud-model-by-provider.v1", JSON.stringify({ zai: "gpt-b" }));
    const { onSave, onCheckModel } = renderCard({}, SAVED_GPT_A);
    const modelInput = () => screen.getByTestId("cloud-model-input") as HTMLInputElement;
    await waitFor(() => expect(modelInput().value).toBe("GPT A"));

    openProviderMenu();
    fireEvent.mouseDown(await screen.findByRole("option", { name: /Z\.ai/ }));
    await waitFor(() => expect(modelInput().value).toBe("GPT B"));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(SELECTED_HINT)).toBeTruthy();

    fireEvent.click(getConnect());

    await waitFor(() => expect(screen.getByText(SAVED_MESSAGE)).toBeTruthy());
    expect(onCheckModel).toHaveBeenCalledWith({ provider: "zai", model: "gpt-b" });
    expect(onCheckModel.mock.invocationCallOrder[0]).toBeLessThan(onSave.mock.invocationCallOrder[0]);
  });

  test("ignores malformed remembered models", async () => {
    localStorage.setItem("openwork.cloud-model-by-provider.v1", "null");
    renderCard({}, SAVED_GPT_A);

    openProviderMenu();
    fireEvent.mouseDown(await screen.findByRole("option", { name: /Z\.ai/ }));

    await waitFor(() =>
      expect(screen.getByTestId("cloud-provider-dropdown-trigger").textContent).toContain("Z.ai"),
    );
    expect((screen.getByTestId("cloud-model-input") as HTMLInputElement).value).toBe("");
  });

  test("a removed provider forgets its model, so adding it again starts empty", async () => {
    const [connectedIds, setConnectedIds] = createSignal(["openai", "zai"]);
    const { onSave } = renderCard(
      {
        get providerConnectedIds() {
          return connectedIds();
        },
        onDisconnectProvider: vi.fn(async (providerId: string) => {
          setConnectedIds((ids) => ids.filter((id) => id !== providerId));
        }),
      },
      SAVED_GPT_A,
    );
    openProviderMenu();
    await screen.findByRole("option", { name: /OpenAI/ });
    removeProvider("OpenAI");
    await waitFor(() =>
      expect(screen.getByTestId("cloud-provider-dropdown-trigger").textContent).toContain("Z.ai"),
    );

    setConnectedIds(["zai", "openai"]);

    await waitFor(() =>
      expect(screen.getByTestId("cloud-provider-dropdown-trigger").textContent).toContain("OpenAI"),
    );
    expect((screen.getByTestId("cloud-model-input") as HTMLInputElement).value).toBe("");
    expect(onSave).not.toHaveBeenCalled();
  });

  test("removing the only provider removes its saved model too and asks for a provider again", async () => {
    const [connectedIds, setConnectedIds] = createSignal(["openai"]);
    const onDisconnectProvider = vi.fn(async () => {
      setConnectedIds([]);
    });
    const { onDelete } = renderCard(
      {
        get providerConnectedIds() {
          return connectedIds();
        },
        onDisconnectProvider,
      },
      SAVED_GPT_A,
    );
    openProviderMenu();
    await screen.findByRole("option", { name: /OpenAI/ });

    // The only provider has the green dot and the saved model.
    removeProvider("OpenAI");

    await waitFor(() => expect(onDisconnectProvider).toHaveBeenCalledWith("openai"));
    expect(onDelete.mock.invocationCallOrder[0]).toBeLessThan(onDisconnectProvider.mock.invocationCallOrder[0]);
    await waitFor(() => expect(screen.queryByTestId("cloud-model-input")).toBeNull());
    expect(screen.queryByTestId("cloud-model-connect-button")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByTestId("cloud-provider-dropdown-trigger").textContent).toContain("Select provider");
    expect(screen.getByText("Connect a cloud provider to get started with Auto Route.")).toBeTruthy();
  });

  test("removing every provider, the in-use one too, returns the card to its first-time state", async () => {
    const [connectedIds, setConnectedIds] = createSignal(["openai", "zai"]);
    const onDisconnectProvider = vi.fn(async (providerId: string) => {
      setConnectedIds((ids) => ids.filter((id) => id !== providerId));
    });
    const { onDelete } = renderCard(
      {
        get providerConnectedIds() {
          return connectedIds();
        },
        onDisconnectProvider,
      },
      SAVED_GPT_A,
    );

    // OpenAI has the green dot and holds the saved model.
    openProviderMenu();
    await screen.findByRole("option", { name: /OpenAI/ });
    removeProvider("OpenAI");
    await waitFor(() => expect(onDisconnectProvider).toHaveBeenCalledWith("openai"));
    expect(onDelete).toHaveBeenCalled();

    // Z.ai is the last provider, picked with no model, so it has no green dot. The menu stays open after a removal.
    await screen.findByRole("option", { name: /Z\.ai/ });
    expect(screen.queryByRole("option", { name: /OpenAI/ })).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("cloud-provider-dropdown-trigger").textContent).toContain("Z.ai"),
    );
    expect(screen.queryByTestId("cloud-provider-selected")).toBeNull();
    removeProvider("Z.ai");
    await waitFor(() => expect(onDisconnectProvider).toHaveBeenCalledWith("zai"));

    await waitFor(() => expect(screen.queryByTestId("cloud-model-input")).toBeNull());
    const afterRemoval = screen.getByTestId("cloud-model-settings").outerHTML;

    // Adding a provider again works as it did the first time.
    setConnectedIds(["zai"]);
    await waitFor(() => expect(screen.getByTestId("cloud-model-input")).toBeTruthy());
    expect(screen.getByTestId("cloud-provider-dropdown-trigger").textContent).toContain("Z.ai");
    cleanup();

    // A card that never had a provider.
    renderCard({ providerConnectedIds: [] });
    expect(screen.getByTestId("cloud-model-settings").outerHTML).toBe(afterRemoval);
  });
});

// Ported from the combobox tests that #3027 added when it moved the picker into
// `model-combobox.tsx`. Rewritten for this card's select-then-Connect rule: a
// pick changes the field but saves nothing.
describe("CloudModelSettings model combobox", () => {
  const getInput = () => screen.getByTestId("cloud-model-input") as HTMLInputElement;
  const optionNames = () => screen.queryAllByRole("option").map((node) => node.textContent?.trim() ?? "");
  const type = (value: string) => fireEvent.input(getInput(), { target: { value } });
  const key = (name: string) => fireEvent.keyDown(getInput(), { key: name });

  async function renderWithModels() {
    const card = renderCard();
    fireEvent.focus(getInput());
    await screen.findByRole("option", { name: "GPT A" });
    return card;
  }

  test("opens on the saved model, highlighted and scrolled into view", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, name: `Model ${i}`, release_date: "" }));
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.textContent?.trim() ?? "");
    };
    try {
      renderCard({ onLoadModels: async () => many }, { ...SAVED_GPT_A, model: "m6" });
      await waitFor(() => expect(getInput().value).toBe("Model 6"));

      fireEvent.focus(getInput());
      const row = await screen.findByRole("option", { name: "Model 6" });

      expect(scrolled).toEqual(["Model 6"]);
      expect(row.className).toContain("bg-dls-panel-hover-bg");
      // Enter keeps the saved model rather than jumping to the first row.
      key("Enter");
      expect(getInput().value).toBe("Model 6");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  test("opens on focus and lists every model the provider returned", async () => {
    await renderWithModels();

    expect(optionNames()).toEqual(["GPT A", "GPT B"]);
  });

  test("the model list shows at most four rows, then scrolls", async () => {
    await renderWithModels();

    const popover = screen.getByRole("listbox");
    expect(popover.className).toContain("max-h-38");
    expect(popover.className).toContain("overflow-auto");
  });

  test("typing filters the list", async () => {
    await renderWithModels();

    type("b");

    expect(optionNames()).toEqual(["GPT B"]);
  });

  test("the filter matches the model id, not only the display name", async () => {
    await renderWithModels();

    // "gpt-a" is in the id; the display name is "GPT A", with a space.
    type("gpt-a");

    expect(optionNames()).toEqual(["GPT A"]);
  });

  test("ArrowDown then Enter selects the highlighted option and saves nothing", async () => {
    const { onSave } = await renderWithModels();

    key("ArrowDown");
    key("Enter");

    // The highlight starts at 0, so one ArrowDown lands on the second option.
    expect(getInput().value).toBe("GPT B");
    expect(onSave).not.toHaveBeenCalled();
    expect(getConnect().disabled).toBe(false);
  });

  test("ArrowUp walks back and never falls off the top", async () => {
    await renderWithModels();

    key("ArrowDown");
    key("ArrowUp");
    key("ArrowUp");
    key("Enter");

    expect(getInput().value).toBe("GPT A");
  });

  test("an uncommitted query is reverted on blur", async () => {
    renderCard();
    await pickModel("GPT B");

    type("half-typed nonsense");
    expect(getInput().value).toBe("half-typed nonsense");

    fireEvent.focusOut(getInput());

    expect(getInput().value).toBe("GPT B");
  });

  test("Escape reverts the typed text", async () => {
    await renderWithModels();

    type("gpt");
    key("Escape");

    expect(getInput().value).toBe("");
    expect(optionNames()).toEqual([]);
  });

  test("a query matching nothing says so instead of showing an empty menu", async () => {
    await renderWithModels();

    type("zzzz-no-such-model");

    expect(optionNames()).toEqual([]);
    expect(screen.getByTestId("cloud-model-no-match")).toBeTruthy();
  });
});
