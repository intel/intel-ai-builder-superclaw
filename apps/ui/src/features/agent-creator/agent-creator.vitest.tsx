import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, test } from "vitest";

import AgentCreatorView from "./agent-creator";
import type { AgentCreatorViewProps, AgentFilePreviewProps, AgentFormData } from "./agent-creator.types";
import { t } from "../../i18n";

afterEach(cleanup);

function StubFilePreview(props: AgentFilePreviewProps) {
  return (
    <div data-testid="stub-file-preview">
      {props.headerActions}
      <button type="button" data-testid="stub-file-preview-close" onClick={() => props.onClose()} />
      <div data-testid="stub-file-preview-error">{props.error}</div>
      <pre data-testid="stub-file-preview-content">{props.loading ? "" : props.content}</pre>
    </div>
  );
}

function renderCreator(overrides: Partial<AgentCreatorViewProps> = {}) {
  const props: AgentCreatorViewProps = {
    onSave: async () => {},
    agents: [],
    busy: false,
    canEdit: true,
    canDelete: true,
    refreshAgents: () => {},
    readAgent: async () => null,
    saveAgent: async () => {},
    deleteAgent: async () => {},
    skillDescription: () => undefined,
    filePreview: StubFilePreview,
    ...overrides,
  };
  render(() => <AgentCreatorView {...props} />);
}

const nameInput = () => screen.getByPlaceholderText("my-agent") as HTMLInputElement;
const descriptionInput = () =>
  screen.getByPlaceholderText(t("agents.description_placeholder")) as HTMLInputElement;
const systemPromptInput = () =>
  screen.getByPlaceholderText(t("agents.system_prompt_hint")) as HTMLTextAreaElement;

describe("AgentCreatorView create", () => {
  test("a successful create shows the success banner with the name and clears the form", async () => {
    const saved: AgentFormData[] = [];
    renderCreator({ onSave: async (agent) => void saved.push(agent) });

    fireEvent.input(nameInput(), { target: { value: "my-agent" } });
    fireEvent.input(descriptionInput(), { target: { value: "Does things" } });
    fireEvent.input(systemPromptInput(), { target: { value: "You are helpful." } });
    fireEvent.click(screen.getByTestId("create-agent-btn"));

    const banner = await screen.findByTestId("agent-create-success");
    expect(banner.textContent).toContain(t("agents.create_success").replace("{name}", "my-agent"));
    expect(saved.map((agent) => agent.name)).toEqual(["my-agent"]);
    expect(nameInput().value).toBe("");
    expect(descriptionInput().value).toBe("");
    expect(systemPromptInput().value).toBe("");
  });

  test("the form is locked while the save is pending, so no edit can be discarded by the reset", async () => {
    let finishSave: () => void = () => {};
    renderCreator({ onSave: () => new Promise<void>((resolve) => (finishSave = resolve)) });

    fireEvent.input(nameInput(), { target: { value: "my-agent" } });
    fireEvent.click(screen.getByTestId("create-agent-btn"));

    // happy-dom does not propagate a disabled fieldset to its descendants the way
    // browsers do, so assert containment plus the fieldset's own state.
    const fieldset = screen.getByTestId("agent-custom-setup") as HTMLFieldSetElement;
    expect(fieldset.contains(nameInput())).toBe(true);
    expect(fieldset.contains(descriptionInput())).toBe(true);
    expect(fieldset.contains(systemPromptInput())).toBe(true);
    await waitFor(() => expect(fieldset.disabled).toBe(true));

    finishSave();
    await screen.findByTestId("agent-create-success");
    expect(fieldset.disabled).toBe(false);
  });

  test("typing after a create clears the success banner", async () => {
    renderCreator();

    fireEvent.input(nameInput(), { target: { value: "my-agent" } });
    fireEvent.click(screen.getByTestId("create-agent-btn"));
    await screen.findByTestId("agent-create-success");

    fireEvent.input(nameInput(), { target: { value: "n" } });
    await waitFor(() => expect(screen.queryByTestId("agent-create-success")).toBeNull());
  });

  test("offers protected-file access only when the active profile supports it and saves the opt-in", async () => {
    const saved: AgentFormData[] = [];
    renderCreator({
      loadToolsSkills: async () => ({
        tools: [{ name: "read" }, { name: "webfetch" }],
        skills: [],
        mcpServers: [],
        protectedFilePipelineAvailable: true,
      }),
      onSave: async (agent) => void saved.push(agent),
    });

    const checkbox = await screen.findByTestId("agent-protected-file-pipeline-checkbox");
    const capabilities = screen.getByTestId("agent-capabilities-list");
    expect(capabilities.contains(checkbox)).toBe(true);
    expect(capabilities.contains(screen.getByTestId("agent-category-checkbox-file-code-engine"))).toBe(true);
    expect(capabilities.contains(screen.getByTestId("agent-category-checkbox-web-research-retrieval"))).toBe(true);
    expect(screen.queryByText(t("agents.protected_file_pipeline_description"))).toBeNull();
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    fireEvent.click(checkbox);
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", {
      name: t("agents.open_category_details").replace("{name}", t("agents.category_file_code_engine_label")),
    }));
    expect(screen.queryByTestId("agent-protected-file-pipeline-checkbox")).toBeNull();
    fireEvent.click(screen.getByText(t("agents.back_to_categories")));
    expect((screen.getByTestId("agent-protected-file-pipeline-checkbox") as HTMLInputElement).checked).toBe(true);
    fireEvent.input(nameInput(), { target: { value: "protected-agent" } });
    fireEvent.input(descriptionInput(), { target: { value: "Analyzes protected files" } });
    fireEvent.input(systemPromptInput(), { target: { value: "Analyze the requested file." } });
    fireEvent.click(screen.getByTestId("create-agent-btn"));

    await screen.findByTestId("agent-create-success");
    expect(saved[0]?.protectedFilePipelineEnabled).toBe(true);
  });

  test("protected-file details describe the actual permissions without changing the selection", async () => {
    renderCreator({
      loadToolsSkills: async () => ({
        tools: [{ name: "read" }],
        skills: [],
        mcpServers: [],
        protectedFilePipelineAvailable: true,
      }),
    });

    await screen.findByTestId("agent-protected-file-pipeline-checkbox");
    const openDetails = () => fireEvent.click(screen.getByRole("button", {
      name: t("agents.open_category_details").replace("{name}", t("agents.protected_file_pipeline_label")),
    }));
    openDetails();

    expect(screen.getByText(t("agents.protected_file_pipeline_description"))).toBeTruthy();
    expect(screen.getByText(t("agents.protected_file_pipeline_permissions_intro"))).toBeTruthy();
    expect(screen.getByText("confirm_file_protection").closest("li")?.textContent)
      .toContain(t("agents.protected_file_pipeline_confirm_permission"));
    expect(screen.getByText("protected-file-agent").closest("li")?.textContent)
      .toContain(t("agents.protected_file_pipeline_agent_permission"));
    expect(screen.getByText("run_protected_file_pipeline").closest("li")?.textContent)
      .toContain(t("agents.protected_file_pipeline_tool_permission"));
    expect(screen.getByText("local-file-agent").closest("li")?.textContent)
      .toContain(t("agents.protected_file_pipeline_local_agent_permission"));
    expect(screen.getByText("local-file-agent").closest("li")?.textContent)
      .toContain("Allowed when protection is declined or disabled");
    expect(screen.getByText(t("agents.protected_file_pipeline_description")).textContent)
      .toContain("If declined or disabled, the request is delegated to local-file-agent using the active Product Profile's model routing.");
    expect(screen.queryByText(t("agents.category_detail_included_hint"))).toBeNull();

    fireEvent.click(screen.getByText(t("agents.back_to_categories")));
    const checkbox = screen.getByTestId("agent-protected-file-pipeline-checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    openDetails();
    expect(screen.getByText(t("agents.category_detail_included_hint"))).toBeTruthy();
    fireEvent.click(screen.getByText(t("agents.back_to_categories")));
    expect((screen.getByTestId("agent-protected-file-pipeline-checkbox") as HTMLInputElement).checked).toBe(true);
  });

  test("closes protected-file details if a catalog reload makes the capability unavailable", async () => {
    let available = true;
    let fail = false;
    let loads = 0;
    renderCreator({
      loadToolsSkills: async () => {
        loads += 1;
        if (fail) throw new Error("Catalog unavailable");
        return {
          tools: [{ name: "read" }],
          skills: [],
          mcpServers: [],
          protectedFilePipelineAvailable: available,
        };
      },
    });

    await screen.findByTestId("agent-protected-file-pipeline-checkbox");
    fireEvent.click(screen.getByTestId("agent-protected-file-pipeline-checkbox"));
    fireEvent.click(screen.getByRole("button", {
      name: t("agents.open_category_details").replace("{name}", t("agents.protected_file_pipeline_label")),
    }));
    fireEvent.click(screen.getByText(t("common.refresh")));
    await waitFor(() => {
      expect(loads).toBe(2);
      expect((screen.getByText(t("common.refresh")) as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.getByText(t("agents.protected_file_pipeline_description"))).toBeTruthy();

    available = false;
    fireEvent.click(screen.getByText(t("common.refresh")));
    await waitFor(() => expect(screen.queryByText(t("agents.protected_file_pipeline_description"))).toBeNull());
    expect(screen.queryByTestId("agent-protected-file-pipeline-checkbox")).toBeNull();

    available = true;
    fireEvent.click(screen.getByText(t("common.refresh")));
    await screen.findByTestId("agent-protected-file-pipeline-checkbox");
    expect((screen.getByTestId("agent-protected-file-pipeline-checkbox") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", {
      name: t("agents.open_category_details").replace("{name}", t("agents.protected_file_pipeline_label")),
    }));
    fail = true;
    fireEvent.click(screen.getByText(t("common.refresh")));
    await screen.findByText("Catalog unavailable");
    expect(screen.queryByText(t("agents.protected_file_pipeline_description"))).toBeNull();
  });

  test("does not offer protected-file access when the active profile does not support it", async () => {
    const saved: AgentFormData[] = [];
    renderCreator({
      loadToolsSkills: async () => ({
        tools: [{ name: "read" }],
        skills: [],
        mcpServers: [],
        protectedFilePipelineAvailable: false,
      }),
      onSave: async (agent) => void saved.push(agent),
    });

    await screen.findByTestId("agent-category-checkbox-file-code-engine");
    expect(screen.queryByTestId("agent-protected-file-pipeline-checkbox")).toBeNull();
    fireEvent.input(nameInput(), { target: { value: "regular-agent" } });
    fireEvent.click(screen.getByTestId("create-agent-btn"));
    await screen.findByTestId("agent-create-success");
    expect(saved[0]?.protectedFilePipelineEnabled).toBe(false);
  });
});

const AGENT_FILE = [
  "---",
  "description: >-",
  "  Reads the inbox",
  "  and summarises it",
  "mode: primary",
  "permission:",
  '  "*": deny',
  '  "read": allow',
  "  skill:",
  '    "*": deny',
  "---",
  "",
  "You summarise email.",
  "",
].join("\r\n");

function renderWithAgent(overrides: Partial<AgentCreatorViewProps> = {}, content = AGENT_FILE) {
  renderCreator({
    agents: [{ name: "mail-digest", description: "Reads the inbox and summarises it" }],
    readAgent: async () => ({ content }),
    ...overrides,
  });
}

async function openEditor(overrides: Partial<AgentCreatorViewProps> = {}, content = AGENT_FILE) {
  renderWithAgent(overrides, content);
  fireEvent.click(screen.getByTestId("user-agent-edit-btn"));
  await waitFor(() => expect(screen.queryByText(t("common.loading"))).toBeNull());
}

describe("AgentCreatorView preview", () => {
  test("clicking the card previews the file: description, then prompt, then the rest as YAML", async () => {
    renderWithAgent();
    fireEvent.click(screen.getByTestId("user-agent-card"));

    const content = await screen.findByTestId("stub-file-preview-content");
    await waitFor(() => expect(content.textContent).toContain("You summarise email."));
    const text = content.textContent ?? "";
    expect(text.indexOf("Reads the inbox and summarises it")).toBe(0);
    expect(text.indexOf("You summarise email.")).toBeLessThan(text.indexOf("```yaml"));
    expect(text).toContain('"read": allow');
    expect(text).not.toContain("description:");
    expect(screen.queryByTestId("agent-edit-form")).toBeNull();
  });

  test("the preview's Edit button opens the form", async () => {
    renderWithAgent();
    fireEvent.click(screen.getByTestId("user-agent-card"));
    const edit = (await screen.findByTestId("agent-preview-edit-btn")) as HTMLButtonElement;
    await waitFor(() => expect(edit.disabled).toBe(false));

    fireEvent.click(edit);
    await screen.findByTestId("agent-edit-form");
    expect(screen.queryByTestId("stub-file-preview")).toBeNull();
    expect((screen.getByTestId("agent-edit-description-input") as HTMLTextAreaElement).value).toBe(
      "Reads the inbox and summarises it",
    );
  });

  test("a file that cannot be read says so, with the reason", async () => {
    renderWithAgent({ readAgent: async () => Promise.reject(new Error("Not Found")) });
    fireEvent.click(screen.getByTestId("user-agent-card"));

    const error = await screen.findByTestId("stub-file-preview-error");
    await waitFor(() => expect(error.textContent).toBe("Failed to load agent file: Not Found"));
  });

  test("Enter on the card's pencil is left to the pencil, not turned into a preview", () => {
    renderWithAgent();
    fireEvent.keyDown(screen.getByTestId("user-agent-edit-btn"), { key: "Enter" });

    expect(screen.queryByTestId("stub-file-preview")).toBeNull();
  });
});

const editDescription = () => screen.getByTestId("agent-edit-description-input") as HTMLTextAreaElement;

describe("AgentCreatorView edit", () => {
  test("opens a form with the name and the parsed description", async () => {
    await openEditor();

    expect((screen.getByTestId("agent-edit-name-input") as HTMLInputElement).value).toBe("mail-digest");
    expect((screen.getByTestId("agent-edit-name-input") as HTMLInputElement).readOnly).toBe(true);
    expect(editDescription().value).toBe("Reads the inbox and summarises it");
    expect(screen.getByTestId("agent-edit-mode-form").getAttribute("aria-pressed")).toBe("true");
  });

  test("the name and description fields are labelled", async () => {
    await openEditor();

    expect(screen.getByLabelText(new RegExp(`^${t("common.name")}`))).toBe(screen.getByTestId("agent-edit-name-input"));
    expect(screen.getByLabelText(t("agents.description_title"))).toBe(editDescription());
  });

  test("saving a new description changes only the description in the file", async () => {
    const saved: string[] = [];
    await openEditor({ saveAgent: async (_name, content) => void saved.push(content) });

    fireEvent.input(editDescription(), { target: { value: "Summarises today's mail" } });
    fireEvent.click(screen.getByTestId("agent-edit-save-btn"));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toBe(AGENT_FILE.replace("  Reads the inbox\r\n  and summarises it", "  Summarises today's mail"));
  });

  test("switching to markdown shows the file with the form's edit applied, and back", async () => {
    await openEditor();

    fireEvent.input(editDescription(), { target: { value: "Edited" } });
    fireEvent.click(screen.getByTestId("agent-edit-mode-markdown"));
    const markdown = (await screen.findByTestId("agent-edit-markdown-input")) as HTMLTextAreaElement;
    expect(markdown.value).toContain("description: >-\r\n  Edited\r\nmode: primary");

    fireEvent.input(markdown, { target: { value: markdown.value.replace("  Edited", "  From markdown") } });
    fireEvent.click(screen.getByTestId("agent-edit-mode-form"));
    await screen.findByTestId("agent-edit-form");
    expect(editDescription().value).toBe("From markdown");
  });

  test("an aliased description survives a Markdown edit, a switch to Form and a save", async () => {
    const aliased = '---\nname: &agent mail-digest\ndescription: *agent\nmode: primary\npermission:\n  "*": deny\n---\nOld prompt.\n';
    const saved: string[] = [];
    await openEditor({ saveAgent: async (_name, content) => void saved.push(content) }, aliased);
    expect(editDescription().value).toBe("mail-digest");

    fireEvent.click(screen.getByTestId("agent-edit-mode-markdown"));
    const markdown = (await screen.findByTestId("agent-edit-markdown-input")) as HTMLTextAreaElement;
    fireEvent.input(markdown, { target: { value: aliased.replace("Old prompt.", "New prompt.") } });
    fireEvent.click(screen.getByTestId("agent-edit-mode-form"));
    await screen.findByTestId("agent-edit-form");
    fireEvent.click(screen.getByTestId("agent-edit-save-btn"));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toBe(aliased.replace("Old prompt.", "New prompt."));
  });

  test("a description the form did not touch is saved exactly as parsed, whitespace included", async () => {
    const keepsNewline = '---\ndescription: |\n  Keeps its newline\nmode: primary\npermission:\n  "*": deny\n---\nOld prompt.\n';
    const saved: string[] = [];
    await openEditor({ saveAgent: async (_name, content) => void saved.push(content) }, keepsNewline);

    fireEvent.click(screen.getByTestId("agent-edit-mode-markdown"));
    const markdown = (await screen.findByTestId("agent-edit-markdown-input")) as HTMLTextAreaElement;
    fireEvent.input(markdown, { target: { value: keepsNewline.replace("Old prompt.", "New prompt.") } });
    fireEvent.click(screen.getByTestId("agent-edit-mode-form"));
    await screen.findByTestId("agent-edit-form");
    fireEvent.click(screen.getByTestId("agent-edit-save-btn"));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toBe(keepsNewline.replace("Old prompt.", "New prompt."));
  });

  test("whitespace around a description the user typed is trimmed", async () => {
    const saved: string[] = [];
    await openEditor({ saveAgent: async (_name, content) => void saved.push(content) });

    fireEvent.input(editDescription(), { target: { value: "  Summarises today's mail\n" } });
    fireEvent.click(screen.getByTestId("agent-edit-save-btn"));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toBe(AGENT_FILE.replace("  Reads the inbox\r\n  and summarises it", "  Summarises today's mail"));
  });

  test("the description is read-only when the workspace cannot be edited", async () => {
    await openEditor({ canEdit: false });

    expect(editDescription().readOnly).toBe(true);
    expect((screen.getByTestId("agent-edit-save-btn") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a file whose frontmatter does not parse opens in the markdown editor", async () => {
    await openEditor({}, "---\ndescription: [unclosed\n---\nbody\n");

    expect(screen.getByTestId("agent-edit-mode-markdown").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("agent-edit-form")).toBeNull();
  });

  test("a file the form could not write back opens in Markdown and says why", async () => {
    await openEditor({}, '---\n{description: old, mode: primary, permission: {"*": deny}}\n---\nBody.\n');

    expect(screen.getByTestId("agent-edit-mode-markdown").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("agent-edit-form")).toBeNull();
    expect(screen.getByText(t("agents.edit_form_unsupported"))).toBeTruthy();
  });
});

describe("AgentCreatorView edit while a save is pending", () => {
  const FILES: Record<string, string> = {
    alpha: '---\ndescription: Alpha agent\nmode: primary\npermission:\n  "*": deny\n---\nAlpha prompt.\n',
    beta: '---\ndescription: Beta agent\nmode: subagent\npermission:\n  "read": allow\n---\nBeta prompt.\n',
  };
  let savedNames: string[] = [];
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const markdownInput = () => screen.getByTestId("agent-edit-markdown-input") as HTMLTextAreaElement;

  function renderPendingSave() {
    let finishSave: () => void = () => {};
    savedNames = [];
    renderCreator({
      agents: [
        { name: "alpha", description: "Alpha agent" },
        { name: "beta", description: "Beta agent" },
      ],
      readAgent: async (name) => ({ content: FILES[name] ?? "" }),
      saveAgent: (name) => {
        savedNames.push(name);
        return new Promise<void>((resolve) => (finishSave = resolve));
      },
    });
    return () => finishSave();
  }

  async function openAgentEditor(index: number) {
    fireEvent.click(screen.getAllByTestId("user-agent-edit-btn")[index] as HTMLElement);
    await screen.findByTestId("agent-edit-form");
    await waitFor(() => expect(screen.queryByText(t("common.loading"))).toBeNull());
  }

  test("a save that finishes after switching agents leaves the other agent's file alone", async () => {
    const finishSave = renderPendingSave();
    await openAgentEditor(0);
    fireEvent.input(editDescription(), { target: { value: "Alpha edited" } });
    fireEvent.click(screen.getByTestId("agent-edit-save-btn"));
    fireEvent.click(screen.getByText(t("common.close")));
    await openAgentEditor(1);

    expect(savedNames).toEqual(["alpha"]);
    finishSave();
    await settle();

    fireEvent.click(screen.getByTestId("agent-edit-mode-markdown"));
    expect(markdownInput().value).toBe(FILES.beta);
  });

  test("typing during a save keeps the newer text and leaves it unsaved", async () => {
    const finishSave = renderPendingSave();
    await openAgentEditor(0);
    fireEvent.click(screen.getByTestId("agent-edit-mode-markdown"));
    fireEvent.input(markdownInput(), { target: { value: FILES.alpha.replace("Alpha prompt.", "First edit.") } });
    fireEvent.click(screen.getByTestId("agent-edit-save-btn"));
    const newer = FILES.alpha.replace("Alpha prompt.", "Second edit.");
    fireEvent.input(markdownInput(), { target: { value: newer } });

    expect(savedNames).toEqual(["alpha"]);
    finishSave();
    await settle();

    expect(markdownInput().value).toBe(newer);
    expect((screen.getByTestId("agent-edit-save-btn") as HTMLButtonElement).disabled).toBe(false);
  });

  test("a save that fails after its dialog closed reports it as a toast, not in the next dialog", async () => {
    let failSave: (error: Error) => void = () => {};
    renderCreator({
      agents: [
        { name: "alpha", description: "Alpha agent" },
        { name: "beta", description: "Beta agent" },
      ],
      readAgent: async (name) => ({ content: FILES[name] ?? "" }),
      saveAgent: () => new Promise<void>((_, reject) => (failSave = reject)),
    });
    await openAgentEditor(0);
    fireEvent.input(editDescription(), { target: { value: "Alpha edited" } });
    fireEvent.click(screen.getByTestId("agent-edit-save-btn"));
    fireEvent.click(screen.getByText(t("common.close")));
    fireEvent.click(screen.getAllByTestId("user-agent-card")[1] as HTMLElement);
    const edit = (await screen.findByTestId("agent-preview-edit-btn")) as HTMLButtonElement;
    await waitFor(() => expect(edit.disabled).toBe(false));

    failSave(new Error("disk full"));
    await settle();
    expect(screen.getByTestId("stub-file-preview-error").textContent).toBe("");
    expect(screen.getByText('Agent "alpha" was not saved: disk full')).toBeTruthy();
    fireEvent.click(edit);
    expect(editDescription().value).toBe("Beta agent");
  });

  test("a read that finishes after its dialog closed leaves the open agent's file alone", async () => {
    const finishRead: Record<string, () => void> = {};
    const saved: Array<[string, string]> = [];
    renderCreator({
      agents: [
        { name: "alpha", description: "Alpha agent" },
        { name: "beta", description: "Beta agent" },
      ],
      readAgent: (name) =>
        new Promise((resolve) => (finishRead[name] = () => resolve({ content: FILES[name] ?? "" }))),
      saveAgent: async (name, content) => void saved.push([name, content]),
    });
    fireEvent.click(screen.getAllByTestId("user-agent-card")[0] as HTMLElement);
    fireEvent.click(screen.getByTestId("stub-file-preview-close"));
    fireEvent.click(screen.getAllByTestId("user-agent-edit-btn")[1] as HTMLElement);
    finishRead.beta?.();
    await waitFor(() => expect(editDescription().value).toBe("Beta agent"));
    finishRead.alpha?.();
    await settle();

    fireEvent.input(editDescription(), { target: { value: "Beta edited" } });
    fireEvent.click(screen.getByTestId("agent-edit-save-btn"));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved).toEqual([["beta", FILES.beta.replace("Beta agent", "Beta edited")]]);
  });
});
