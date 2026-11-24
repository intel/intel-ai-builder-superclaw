import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal, mergeProps } from "solid-js";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { buildPromptParts } from "../../app.prompt-parts";
import Composer from "./composer";
import type { ComposerProps } from "./composer.types";
import type { ComposerDraft } from "../../types";
import { t } from "../../../i18n";

const desktop = vi.hoisted(() => ({ value: false }));
vi.mock("../../utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils")>()),
  isTauriRuntime: () => desktop.value,
}));
const native = vi.hoisted(() => ({
  pickLocalFile: vi.fn(),
  readLocalFileBytes: vi.fn(),
  scanLocalFolder: vi.fn(),
}));
vi.mock("~/shared/platform/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/shared/platform/tauri")>()),
  ...native,
}));

const ROOT = "C:\\Users\\jian\\SuperClaw\\workspace";

function renderComposer(overrides: Partial<ComposerProps> = {}) {
  const drafts: ComposerDraft[] = [];
  const toasts: string[] = [];
  const defaults: ComposerProps = {
    prompt: "",
    developerMode: false,
    busy: false,
    isStreaming: false,
    onSend: () => undefined,
    onStop: () => undefined,
    onDraftChange: (draft) => drafts.push(draft),
    selectedModelLabel: "Auto",
    selectedModel: { providerID: "llmrouter", modelID: "auto" },
    selectedModelIsLocal: false,
    modelOptions: [],
    onSelectModel: () => undefined,
    onManageModels: () => undefined,
    agentLabel: "General",
    selectedAgent: null,
    agentPickerOpen: false,
    agentPickerBusy: false,
    agentPickerReady: true,
    agentPickerError: null,
    agentOptions: [],
    onToggleAgentPicker: () => undefined,
    onRetryAgentLoad: () => undefined,
    onSelectAgent: () => undefined,
    setAgentPickerRef: () => undefined,
    toast: null,
    onToast: (message) => toasts.push(message),
    loadAgentOptions: async () => [],
    recentFiles: [],
    searchFiles: async () => [],
    isRemoteWorkspace: false,
    isSandboxWorkspace: true,
    workspaceRoot: ROOT,
    attachmentsEnabled: true,
    attachmentsDisabledReason: null,
    listCommands: async () => [],
    ttsNarration: "off",
    ttsAvailable: false,
    ttsSpeaking: false,
    toggleTtsNarration: () => undefined,
  };
  // mergeProps keeps an override's getter live, where a spread would read it once.
  const props = mergeProps(defaults, overrides);
  render(() => <Composer {...props} />);
  const editor = screen.getByTestId("task-input");
  const paste = async (text: string) => {
    editor.focus();
    await Promise.resolve();
    fireEvent.paste(editor, {
      clipboardData: { items: [], files: [], getData: (type: string) => (type === "text/plain" ? text : "") },
    });
  };
  return { editor, paste, drafts, toasts };
}

const chips = (editor: HTMLElement) =>
  Array.from(editor.querySelectorAll<HTMLElement>("[data-outside-path]"));
const popover = () => screen.queryByTestId("outside-path-popover");

/** The `[Selected file: …]` annotations a draft sends when the SDK directory is a
 * Windows path, as on the native backend. */
async function sentFilePaths(drafts: ComposerDraft[]) {
  await waitFor(() => expect(drafts.at(-1)?.parts.some((part) => part.type === "file")).toBe(true));
  const draft = drafts.at(-1);
  if (!draft) throw new Error("no draft emitted");
  const parts = await buildPromptParts(draft, () => "C:\\Users\\jian\\SuperClawProjects");
  expect(parts.some((part) => part.type === "file")).toBe(false);
  return parts.flatMap((part) =>
    part.type === "text" && part.text.startsWith("[Selected file: ") ? [part.text] : [],
  );
}

beforeAll(() => {
  (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = class {};
});

beforeEach(() => {
  native.scanLocalFolder.mockRejectedValue(new Error("Folder path is not a directory"));
});

afterEach(() => {
  cleanup();
  desktop.value = false;
  vi.clearAllMocks();
});

describe("pasted paths outside the workspace", () => {
  test("become warning chips that keep the pasted text, and the popover explains them", async () => {
    const { editor, paste } = renderComposer();

    await paste("summarize C:\\Users\\jian\\workspace\\codex please");

    expect(chips(editor).map((chip) => chip.dataset.outsidePath)).toEqual([
      "C:\\Users\\jian\\workspace\\codex",
    ]);
    expect(editor.textContent).toBe("summarize C:\\Users\\jian\\workspace\\codex please");
    expect(popover()?.textContent).toContain(`codex ${t("composer.outside_path_notice")}`);
    // The shell's `contain: layout` would anchor a fixed popover to itself, off-screen.
    expect(popover()?.closest("[data-composer-shell]")).toBeNull();
  });

  test("leave paths inside the workspace, and any path in a local workspace, alone", async () => {
    const sandboxed = renderComposer();
    await sandboxed.paste(`${ROOT}\\inbox\\cv.docx`);
    expect(chips(sandboxed.editor)).toEqual([]);
    cleanup();

    const local = renderComposer({ isSandboxWorkspace: false });
    await local.paste("C:\\Users\\jian\\workspace\\codex");
    expect(chips(local.editor)).toEqual([]);
    expect(popover()).toBeNull();
  });

  test("keep their warning after typing closes the popover, and hover or a click reopens it", async () => {
    const { editor, paste } = renderComposer();
    await paste("D:\\finance\\Q2.xlsx");

    fireEvent.input(editor);
    expect(popover()).toBeNull();
    expect(chips(editor)).toHaveLength(1);

    fireEvent.mouseOver(chips(editor)[0]);
    expect(popover()).not.toBeNull();

    fireEvent.input(editor);
    fireEvent.click(chips(editor)[0]);
    expect(popover()).not.toBeNull();
  });

  test("close when the pointer leaves the chip, but not when it moves onto the popover", async () => {
    const { editor, paste } = renderComposer();
    await paste("D:\\finance\\Q2.xlsx");
    const chip = chips(editor)[0];
    vi.useFakeTimers();
    try {
      fireEvent.mouseOver(chip);
      fireEvent.mouseOut(chip, { relatedTarget: popover() });
      fireEvent.mouseEnter(popover() as HTMLElement);
      vi.advanceTimersByTime(1000);
      expect(popover()).not.toBeNull();

      fireEvent.mouseLeave(popover() as HTMLElement);
      vi.advanceTimersByTime(1000);
      expect(popover()).toBeNull();

      fireEvent.mouseOver(chip);
      fireEvent.mouseOut(chip, { relatedTarget: editor });
      vi.advanceTimersByTime(1000);
      expect(popover()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("Keep as text drops the mark and leaves the plain path", async () => {
    const { editor, paste } = renderComposer();
    await paste("why does it write to C:\\Users\\jian\\AppData\\Local\\Temp?");

    screen.getByRole("button", { name: t("composer.outside_path_keep_text") }).click();

    expect(chips(editor)).toEqual([]);
    expect(popover()).toBeNull();
    expect(editor.textContent).toBe("why does it write to C:\\Users\\jian\\AppData\\Local\\Temp?");
  });

  test("Keep as text from the keyboard returns focus to the editor, after the trailing space", async () => {
    const { editor, paste } = renderComposer();
    await paste("open D:\\finance\\Q2.xlsx");
    const chip = chips(editor)[0];

    chip.focus();
    fireEvent.keyDown(chip, { key: "Enter" });
    await Promise.resolve();
    const keep = screen.getByRole("button", { name: t("composer.outside_path_keep_text") });
    expect(document.activeElement).toBe(keep);
    keep.click();

    expect(document.activeElement).toBe(editor);
    window.getSelection()?.getRangeAt(0).insertNode(document.createTextNode("now"));
    expect(editor.textContent).toBe("open D:\\finance\\Q2.xlsx\u00a0now");
  });

  test("offer no Add in a shell command, which would send the link's text", async () => {
    desktop.value = true;
    const { editor, paste } = renderComposer({ prompt: "!", onUploadInboxFiles: async () => [] });
    await paste("type D:\\finance\\Q2.xlsx");

    expect(chips(editor)).toHaveLength(1);
    expect(popover()).not.toBeNull();
    expect(screen.queryByRole("button", { name: t("composer.outside_path_add_file") })).toBeNull();
  });

  test("close when the draft is sent", async () => {
    const sent: ComposerDraft[] = [];
    const { editor, paste } = renderComposer({ onSend: (draft) => void sent.push(draft) });
    await paste("D:\\finance\\Q2.xlsx");
    expect(popover()).not.toBeNull();

    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(sent).toHaveLength(1));
    await waitFor(() => expect(popover()).toBeNull());
  });

  test("close, and stay closed, while the composer is read-only", async () => {
    const [readOnly, setReadOnly] = createSignal(false);
    const { editor, paste } = renderComposer({
      get readOnly() {
        return readOnly();
      },
    });
    await paste("D:\\finance\\Q2.xlsx");
    expect(popover()).not.toBeNull();

    setReadOnly(true);

    await waitFor(() => expect(popover()).toBeNull());
    fireEvent.mouseOver(chips(editor)[0]);
    expect(popover()).toBeNull();
  });

  test("offer no Add button outside the desktop app", async () => {
    const { paste } = renderComposer({ onUploadInboxFiles: async () => [] });
    await paste("D:\\finance\\Q2.xlsx");

    expect(screen.queryByRole("button", { name: t("composer.outside_path_add_file") })).toBeNull();
  });

  test("Add folder confirms, uploads, and turns the chip into a workspace folder link", async () => {
    desktop.value = true;
    native.scanLocalFolder.mockResolvedValue({
      root: "C:\\Users\\Jane Doe\\workspace\\codex",
      entries: [{ name: "README.md", relativePath: "README.md", size: 5 }],
      totalBytes: 5,
      skippedDirs: [],
      truncated: false,
    });
    native.readLocalFileBytes.mockResolvedValue([104, 101, 108, 108, 111]);
    const upload = vi.fn(async (files: File[]) =>
      files.map((file) => ({ name: file.name, path: `inbox/${file.webkitRelativePath}` })),
    );
    const { editor, paste, drafts } = renderComposer({
      onUploadInboxFiles: upload,
      workspaceRoot: "C:\\Users\\Jane Doe\\SuperClaw\\workspace",
    });
    // Explorer's "Copy as path" quotes it; the quotes go with the chip.
    await paste('summarize "C:\\Users\\Jane Doe\\workspace\\codex"');
    expect(chips(editor)[0]?.textContent).toBe('"C:\\Users\\Jane Doe\\workspace\\codex"');

    screen.getByRole("button", { name: t("composer.outside_path_add_folder") }).click();
    await waitFor(() => expect(native.scanLocalFolder).toHaveBeenCalledWith("C:\\Users\\Jane Doe\\workspace\\codex"));
    (await screen.findByRole("button", { name: t("composer.upload") })).click();

    await waitFor(() => expect(editor.querySelector("[data-workspace-folder]")).not.toBeNull());
    const folder = editor.querySelector<HTMLElement>("[data-workspace-folder]");
    expect(folder?.dataset.workspaceFolder).toBe("C:\\Users\\Jane Doe\\SuperClaw\\workspace\\codex");
    expect(folder?.textContent).toBe("@codex");
    expect(chips(editor)).toEqual([]);
    await waitFor(() =>
      expect(drafts.at(-1)?.text.trim()).toBe(
        "summarize [Selected folder: C:\\Users\\Jane Doe\\SuperClaw\\workspace\\codex]",
      ),
    );
  });

  test("a folder whose name looks like a file still opens the folder review", async () => {
    desktop.value = true;
    native.scanLocalFolder.mockResolvedValue({
      root: "C:\\Users\\jian\\project.v2",
      entries: [{ name: "README.md", relativePath: "README.md", size: 5 }],
      totalBytes: 5,
      skippedDirs: [],
      truncated: false,
    });
    const { paste } = renderComposer({ onUploadInboxFiles: async () => [] });
    await paste("C:\\Users\\jian\\project.v2");

    screen.getByRole("button", { name: t("composer.outside_path_add_file") }).click();

    expect(await screen.findByRole("button", { name: t("composer.upload") })).not.toBeNull();
    expect(native.pickLocalFile).not.toHaveBeenCalled();
  });

  test("a folder the scan cannot read says why and opens no picker", async () => {
    desktop.value = true;
    native.scanLocalFolder.mockRejectedValue("IO error for operation on C:\\Users\\jian\\codex\\secret: Access is denied.");
    const { editor, paste, toasts } = renderComposer({ onUploadInboxFiles: async () => [] });
    await paste("C:\\Users\\jian\\codex");

    screen.getByRole("button", { name: t("composer.outside_path_add_folder") }).click();

    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0]).toContain(t("composer.folder_read_failed"));
    expect(toasts[0]).toContain("Access is denied");
    expect(native.pickLocalFile).not.toHaveBeenCalled();
    expect(chips(editor)).toHaveLength(1);
  });

  test("Add file picks the file natively, uploads it, and links it", async () => {
    desktop.value = true;
    native.pickLocalFile.mockResolvedValue("C:\\Users\\jian\\Downloads\\Q3 report.csv");
    native.readLocalFileBytes.mockResolvedValue([1, 2, 3]);
    // The server stores uploads at the workspace root and returns the relative path.
    const upload = vi.fn(async (files: File[], _options?: { notify?: boolean }) => [
      { name: files[0].name, path: files[0].name },
    ]);
    const { editor, paste, drafts } = renderComposer({ onUploadInboxFiles: upload });
    await paste("C:\\Users\\jian\\Downloads\\Q3 report.csv");

    screen.getByRole("button", { name: t("composer.outside_path_add_file") }).click();

    await waitFor(() => expect(editor.querySelector("[data-mention-kind='file']")).not.toBeNull());
    expect(native.pickLocalFile).toHaveBeenCalledWith("C:\\Users\\jian\\Downloads\\Q3 report.csv");
    expect(upload.mock.calls[0][0][0].name).toBe("Q3 report.csv");
    expect(upload.mock.calls[0][1]).toEqual({ notify: false });
    expect(chips(editor)).toEqual([]);
    expect(await sentFilePaths(drafts)).toEqual([
      "[Selected file: C:\\Users\\jian\\SuperClawProjects\\Q3 report.csv]",
    ]);
  });

  test("a cancelled native pick leaves the warning chip in place", async () => {
    desktop.value = true;
    native.pickLocalFile.mockResolvedValue(null);
    const { editor, paste } = renderComposer({ onUploadInboxFiles: async () => [] });
    await paste("D:\\finance\\Q2.xlsx");

    screen.getByRole("button", { name: t("composer.outside_path_add_file") }).click();

    await waitFor(() => expect(native.pickLocalFile).toHaveBeenCalled());
    expect(chips(editor)).toHaveLength(1);
  });

  test("a failed upload says so and leaves the warning chip in place", async () => {
    desktop.value = true;
    native.pickLocalFile.mockResolvedValue("D:\\finance\\Q2.xlsx");
    native.readLocalFileBytes.mockResolvedValue([1]);
    const { editor, paste, toasts } = renderComposer({ onUploadInboxFiles: async () => [] });
    await paste("D:\\finance\\Q2.xlsx");

    screen.getByRole("button", { name: t("composer.outside_path_add_file") }).click();

    await waitFor(() => expect(toasts).toEqual([t("composer.outside_path_add_failed")]));
    expect(chips(editor)).toHaveLength(1);
  });

  test("a file still uploading offers no second Add, and says where it went if the draft is sent first", async () => {
    desktop.value = true;
    native.pickLocalFile.mockResolvedValue("D:\\finance\\Q2.xlsx");
    native.readLocalFileBytes.mockResolvedValue([1]);
    let finish: (uploaded: Array<{ name: string; path: string }>) => void = () => undefined;
    const upload = vi.fn(
      () => new Promise<Array<{ name: string; path: string }>>((resolve) => (finish = resolve)),
    );
    const { editor, paste, toasts } = renderComposer({ onUploadInboxFiles: upload });
    await paste("D:\\finance\\Q2.xlsx");

    screen.getByRole("button", { name: t("composer.outside_path_add_file") }).click();
    await waitFor(() => expect(upload).toHaveBeenCalled());
    fireEvent.mouseOver(chips(editor)[0]);
    expect(popover()).toBeNull();

    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(chips(editor)).toEqual([]));
    finish([{ name: "Q2.xlsx", path: "Q2.xlsx" }]);

    await waitFor(() => expect(toasts).toEqual([t("composer.outside_path_added_after_send")]));
  });
});

describe("a pasted file the composer cannot attach", () => {
  test("is uploaded and linked by a path the native backend can open", async () => {
    const upload = vi.fn(async (files: File[], _options?: { notify?: boolean }) => [
      { name: files[0].name, path: files[0].name },
    ]);
    const { editor, drafts } = renderComposer({ onUploadInboxFiles: upload });
    const file = new File(["x"], "notes.md", { type: "text/markdown" });
    editor.focus();
    fireEvent.paste(editor, { clipboardData: { items: [], files: [file], getData: () => "" } });

    await waitFor(() => expect(upload).toHaveBeenCalled());
    expect(await sentFilePaths(drafts)).toEqual(["[Selected file: C:\\Users\\jian\\SuperClawProjects\\notes.md]"]);
  });
});
