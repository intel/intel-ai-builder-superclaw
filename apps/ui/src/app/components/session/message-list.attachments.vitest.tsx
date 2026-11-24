import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, expect, test, vi } from "vitest";

import MessageList from "./message-list";
import { buildPromptParts } from "../../app.prompt-parts";
import { selectedWorkspacePath } from "../../pages/session.artifact-paths";
import { createMentionSpan } from "./composer.editor";
import { removeImageMention, watchImageMentions } from "./composer.image-mentions";
import { CompactAttachmentChip, ComposerImageCard } from "./attachment-chip";
import { PlatformProvider, type Platform } from "../../context/platform";
import type { MessageWithParts } from "../../types";

const platform: Platform = {
  platform: "web",
  openLink: () => undefined,
  restart: async () => undefined,
  notify: async () => undefined,
};

afterEach(() => cleanup());

const userMessage = (parts: Array<Record<string, unknown>>) =>
  ({
    info: { id: "message-1", role: "user", sessionID: "session-1", time: { created: 1 } },
    parts: parts.map((part, index) => ({ id: `part-${index}`, ...part })),
  }) as unknown as MessageWithParts;

const renderList = (
  message: MessageWithParts,
  handlers: {
    onPreviewFile?: (path: string) => void;
    onRevealFile?: (path: string) => void;
    resolveFileSize?: (path: string) => Promise<number | null>;
    resolveImageThumbnail?: (path: string) => Promise<string | null>;
    workspaceRoot?: string;
  } = {},
) =>
  render(() => (
    <PlatformProvider value={platform}>
      <MessageList
        messages={[message]}
        workspaceRoot={handlers.workspaceRoot}
        developerMode={false}
        showThinking={false}
        expandedStepIds={new Set<string>()}
        setExpandedStepIds={() => undefined}
        onPreviewFile={handlers.onPreviewFile}
        onRevealFile={handlers.onRevealFile}
        localFiles={{
          resolveHostFilePath: async () => null,
          fileSize: handlers.resolveFileSize ?? (async () => null),
          imageThumbnail: handlers.resolveImageThumbnail ?? (async () => null),
        }}
      />
    </PlatformProvider>
  ));

const docxPath = "C:\\Users\\jane\\SuperClawProjects\\superclaw-self-fix-workflow (2).docx";

test("a selected Windows file is a chip, not an annotation with the host path", async () => {
  const onPreviewFile = vi.fn();
  const onRevealFile = vi.fn();
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const { container, getByRole } = renderList(
    userMessage([
      { type: "text", text: "@superclaw-self-fix-workflow (2).docx summarize this file" },
      { type: "text", text: "\n" },
      { type: "text", text: `[Selected file: ${docxPath}]` },
    ]),
    { onPreviewFile, onRevealFile, workspaceRoot: "C:\\Users\\jane\\SuperClawProjects" },
  );

  const text = container.textContent ?? "";
  expect(text).toContain("summarize this file");
  expect(text).not.toContain("[Selected file:");
  expect(text).not.toContain("C:\\Users");

  const chip = container.querySelector('[data-testid="attachment-chip"]');
  expect(chip?.textContent).toContain("superclaw-self-fix-workflow (2).docx");
  expect(chip?.textContent).toContain("Word document");
  expect(text).not.toContain("@superclaw-self-fix-workflow");
  const bubble = Array.from(container.querySelectorAll("div")).find((el) => el.textContent === "summarize this file");
  expect(bubble && chip && chip.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  fireEvent.click(getByRole("button", { name: /^Open preview: / }));
  expect(onPreviewFile).toHaveBeenCalledWith(docxPath);
  fireEvent.click(getByRole("button", { name: /^Find in File Explorer: / }));
  expect(onRevealFile).toHaveBeenCalledWith(docxPath);
  fireEvent.click(getByRole("button", { name: "Copy message" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("summarize this file"));
});

test("prose between two annotations in one part still renders", () => {
  const { container } = renderList(
    userMessage([
      { type: "text", text: `[Selected folder: C:\\Users\\jane\\docs] summarize [x] now [Selected file: ${docxPath}]` },
    ]),
  );

  expect(container.textContent).toContain("summarize [x] now");
  expect(container.querySelectorAll('[data-testid="attachment-chip"]')).toHaveLength(2);
});

test("shows the file's size next to its type once it is read", async () => {
  const resolveFileSize = vi.fn(async () => 131072);
  const { findByText } = renderList(
    userMessage([
      { type: "text", text: "summarize this file" },
      { type: "text", text: `[Selected file: ${docxPath}]` },
    ]),
    { resolveFileSize },
  );

  expect(await findByText("Word document, 128 KB")).toBeTruthy();
  expect(resolveFileSize).toHaveBeenCalledWith(docxPath);
});

test("a folder or a file whose size cannot be read shows the type alone", async () => {
  const resolveFileSize = vi.fn(async () => null);
  const { container, findByText } = renderList(
    userMessage([
      { type: "text", text: `[Selected file: ${docxPath}]` },
      { type: "text", text: "[Selected folder: C:\\Users\\jane\\codex]" },
    ]),
    { resolveFileSize },
  );

  expect(await findByText("Word document")).toBeTruthy();
  expect(container.textContent).toContain("Folder");
  expect(resolveFileSize).toHaveBeenCalledTimes(1);
});

test("an @-mentioned text file part shows a friendly type and no file:// URL", () => {
  const { container } = renderList(
    userMessage([
      { type: "text", text: "@utf8-preview-check.md whats in this file" },
      {
        type: "file",
        url: "file://C:\\Users\\jane\\SuperClawProjects/utf8-preview-check.md",
        filename: "utf8-preview-check.md",
        mime: "text/plain",
      },
    ]),
  );

  const text = container.textContent ?? "";
  expect(text).not.toContain("file://");
  expect(text).not.toContain("C:\\Users");
  expect(text.toLowerCase()).not.toContain("text/plain");
  const chip = container.querySelector('[data-testid="attachment-chip"]');
  expect(chip?.textContent).toContain("utf8-preview-check.md");
  expect(chip?.textContent).toContain("Markdown");
});

const pngPath = "C:\\Users\\jane\\SuperClawProjects\\Screenshot 2026-08-06 114340.png";
const pngData = "data:image/png;base64,iVBORw0KGgo=";

test("an @-mentioned local image loads a thumbnail into its chip", async () => {
  const resolveImageThumbnail = vi.fn(async () => pngData);
  const { container } = renderList(
    userMessage([
      { type: "text", text: "summarize @Screenshot 2026-08-06 114340.png" },
      { type: "file", url: `file://${pngPath}`, filename: "Screenshot 2026-08-06 114340.png", mime: "text/plain" },
    ]),
    { resolveImageThumbnail },
  );

  await waitFor(() =>
    expect(container.querySelector('[data-testid="attachment-chip"] img')?.getAttribute("src")).toBe(pngData),
  );
  expect(resolveImageThumbnail).toHaveBeenCalledWith(pngPath);
  expect(container.querySelector('[data-testid="attachment-chip"]')?.textContent).toContain("Image");
});

test("an uploaded image keeps its preview and gains its workspace path for size and reveal", async () => {
  const uploadPath = "/workspace/composer-image-a1b2c3d4-photo.png";
  const onRevealFile = vi.fn();
  const resolveFileSize = vi.fn(async () => 2048);
  const { container, getByRole } = renderList(
    userMessage([
      { type: "file", url: "blob:photo", filename: "photo.png", mime: "image/png" },
      { type: "text", text: `[Selected file: ${uploadPath}]` },
    ]),
    { onRevealFile, resolveFileSize },
  );

  expect(container.querySelectorAll('[data-testid="attachment-chip"]')).toHaveLength(1);
  expect(container.querySelector('[data-testid="attachment-chip"] img')?.getAttribute("src")).toBe("blob:photo");
  await waitFor(() => expect(container.textContent).toContain("2 KB"));
  expect(resolveFileSize).toHaveBeenCalledWith(uploadPath);
  fireEvent.click(getByRole("button", { name: /^Find in File Explorer: photo\.png/ }));
  expect(onRevealFile).toHaveBeenCalledWith(uploadPath);
});

test("a local thumbnail that fails to decode falls back to the type icon", async () => {
  const { container } = renderList(
    userMessage([
      { type: "file", url: `file://${pngPath}`, filename: "Screenshot 2026-08-06 114340.png", mime: "text/plain" },
    ]),
    { resolveImageThumbnail: async () => pngData },
  );
  const thumbnail = () => container.querySelector('[data-testid="attachment-chip"] img');

  await waitFor(() => expect(thumbnail()).not.toBeNull());
  fireEvent.error(thumbnail() as Element);

  await waitFor(() => expect(thumbnail()).toBeNull());
});

test("an image the engine kept only as a hidden inline part is still a chip with its thumbnail", () => {
  const onRevealFile = vi.fn();
  const { container, getByRole } = renderList(
    userMessage([
      { type: "text", text: "summarize @Screenshot 2026-08-06 114340.png" },
      { type: "text", text: "Called the Read tool", synthetic: true },
      { type: "file", url: pngData, filename: "Screenshot 2026-08-06 114340.png", mime: "image/png", synthetic: true },
    ]),
    { onRevealFile, workspaceRoot: "C:\\Users\\jane\\SuperClawProjects" },
  );

  const chips = container.querySelectorAll('[data-testid="attachment-chip"]');
  expect(chips).toHaveLength(1);
  expect(chips[0]?.querySelector("img")?.getAttribute("src")).toBe(pngData);
  expect(container.textContent).not.toContain("Called the Read tool");
  expect(container.textContent).not.toContain("@Screenshot");
  expect(container.textContent).toContain("summarize");
  fireEvent.click(getByRole("button", { name: /^Find in File Explorer: / }));
  expect(onRevealFile).toHaveBeenCalledWith(pngPath);
});

test("a hidden inline copy of an image that already has a chip adds no second chip", () => {
  const { container } = renderList(
    userMessage([
      { type: "text", text: "summarize" },
      { type: "file", url: pngData, filename: "Screenshot 2026-08-06 114340.png", mime: "image/png", synthetic: true },
      { type: "file", url: `file://${pngPath}`, filename: "Screenshot 2026-08-06 114340.png", mime: "text/plain" },
    ]),
  );

  expect(container.querySelectorAll('[data-testid="attachment-chip"]')).toHaveLength(1);
});

test("a composer file mention carries the chat chip's type icon, name and type", async () => {
  const span = createMentionSpan({ type: "file", path: "notes/deploy_notes.md", label: "deploy_notes.md" });

  await waitFor(() => expect(span.querySelector("svg")).not.toBeNull());
  const labels = Array.from(span.querySelectorAll("span"), (child) => child.textContent);
  expect(labels).toEqual(["deploy_notes.md", "· Markdown"]);
  expect(span.dataset.mentionValue).toBe("notes/deploy_notes.md");
  expect(span.contentEditable).toBe("false");
});

test("a composer attachment is drawn as the file mention pill, with a remove button", () => {
  const onRemove = vi.fn();
  const { getByTestId, getByRole } = render(() => (
    <CompactAttachmentChip filename="deploy_notes.md" mime="text/markdown" onRemove={onRemove} />
  ));
  const chip = getByTestId("attachment-chip");
  const mention = createMentionSpan({ type: "file", path: "deploy_notes.md", label: "deploy_notes.md" });

  expect(chip.className).toBe(mention.className);
  expect(Array.from(chip.querySelectorAll("span"), (child) => child.textContent)).toEqual(["deploy_notes.md", "· Markdown"]);
  fireEvent.click(getByRole("button", { name: /deploy_notes\.md/ }));
  expect(onRemove).toHaveBeenCalledOnce();
});

test("an @-mentioned image is listed for a card and its inline pill is hidden; other files stay pills", async () => {
  const editor = document.createElement("div");
  const onChange = vi.fn();
  const stop = watchImageMentions(editor, onChange);
  const image = createMentionSpan({ type: "file", path: "shots/photo.png", label: "photo.png" });
  const notes = createMentionSpan({ type: "file", path: "notes/deploy_notes.md", label: "deploy_notes.md" });
  editor.append(image, document.createTextNode(" "), notes);

  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([{ path: "shots/photo.png", name: "photo.png", span: image }]));
  expect(image.style.display).toBe("none");
  expect(notes.style.display).toBe("");

  removeImageMention(onChange.mock.lastCall?.[0][0]);
  expect(editor.firstChild).toBe(notes);
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([]));
  stop();
});

test("a composer image card shows its thumbnail, then the image icon if it fails", async () => {
  const onRemove = vi.fn();
  const { getByTestId, getByRole, getByText } = render(() => (
    <ComposerImageCard name="photo.png" loadThumbnail={async () => pngData} onRemove={onRemove} />
  ));
  const card = getByTestId("attachment-chip");

  await waitFor(() => expect(card.querySelector("img")?.getAttribute("src")).toBe(pngData));
  expect(getByText("Image")).toBeTruthy();
  fireEvent.error(card.querySelector("img") as HTMLImageElement);
  expect(card.querySelector("img")).toBeNull();
  expect(card.querySelector("svg")).not.toBeNull();
  fireEvent.click(getByRole("button", { name: /photo\.png/ }));
  expect(onRemove).toHaveBeenCalledOnce();
});

test("a selected folder is a chip and its annotation is hidden", () => {
  const { container } = renderList(
    userMessage([
      { type: "text", text: "summarize [Selected folder: C:\\Users\\Jane Doe\\SuperClaw\\workspace\\codex]" },
    ]),
  );

  const text = container.textContent ?? "";
  expect(text).toContain("summarize");
  expect(text).not.toContain("[Selected folder:");
  const chip = container.querySelector('[data-testid="attachment-chip"]');
  expect(chip?.textContent).toContain("codex");
  expect(chip?.textContent).toContain("Folder");
});

test("clicking a folder chip's name reveals the folder", () => {
  const folderPath = "C:\\Users\\jane\\codex";
  const onRevealFile = vi.fn();
  const onPreviewFile = vi.fn();
  const { getAllByRole } = renderList(
    userMessage([{ type: "text", text: `[Selected folder: ${folderPath}]` }]),
    { onRevealFile, onPreviewFile },
  );

  const buttons = getAllByRole("button", { name: /codex/ });
  expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
    "Find in File Explorer: codex",
  ]);
  fireEvent.click(buttons[0] as Element);
  expect(onRevealFile).toHaveBeenCalledWith(folderPath);
  expect(onPreviewFile).not.toHaveBeenCalled();
});

test.each([
  "C:\\Projects",
  "C:/Projects",
  "/workspace",
])("renders sent workspace selections as cards with root %s", async (root) => {
  const path = selectedWorkspacePath("Quarterly reports/report.pdf", root);
  const parts = await buildPromptParts({
    mode: "prompt",
    text: "Review this",
    parts: [
      { type: "text", text: "Review this" },
      { type: "text", text: `[Selected file: ${path}]` },
    ],
    attachments: [],
  }, () => root);
  const message: MessageWithParts = {
    info: {
      id: "message-1",
      role: "user",
      sessionID: "session-1",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    },
    parts: parts.map((part, index) => ({
      ...part,
      id: `part-${index}`,
      sessionID: "session-1",
      messageID: "message-1",
    })),
  };
  const { container, getByText } = render(() => (
    <PlatformProvider value={platform}>
      <MessageList
        messages={[message]}
        workspaceRoot={root}
        developerMode={false}
        showThinking={false}
        expandedStepIds={new Set<string>()}
        setExpandedStepIds={() => undefined}
      />
    </PlatformProvider>
  ));

  expect(getByText("report.pdf")).toBeTruthy();
  expect(getByText("PDF")).toBeTruthy();
  expect(container.textContent).toContain("Review this");
  expect(container.textContent).not.toContain("[Selected file:");
  expect(container.textContent).not.toContain(path);
  expect(container.querySelector("a")).toBeNull();
});
