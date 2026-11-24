import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { OpenworkInboxItem, OpenworkServerClient } from "../../lib/openwork-server";
import WorkspaceFilesPanel from "./workspace-files-panel";

const projectItems: OpenworkInboxItem[] = [
  { id: "notes", name: "notes.md", path: "notes.md", kind: "file" },
  { id: "audio", name: "recording.mp3", path: "recording.mp3", kind: "file" },
  { id: "video", name: "demo.mp4", path: "demo.mp4", kind: "file" },
  {
    id: "composer-upload",
    name: "composer-file-d2caf9d7-mock_info.txt",
    path: "composer-file-d2caf9d7-mock_info.txt",
    kind: "file",
  },
];

function renderWorkspaceFilesPanel(options?: {
  selectedPaths?: string[];
  onSelectionChange?: (paths: string[]) => void;
  items?: OpenworkInboxItem[];
}) {
  const client = {
    listProjects: async () => ({ items: options?.items ?? projectItems }),
  } as unknown as OpenworkServerClient;

  return render(() => (
    <WorkspaceFilesPanel
      client={client}
      workspaceId="workspace-1"
      onPreview={() => undefined}
      selectedPaths={options?.selectedPaths}
      onSelectionChange={options?.onSelectionChange}
    />
  ));
}

function previewButtonFor(fileName: string): HTMLButtonElement | null {
  const label = screen.getByText(fileName);
  const row = label.closest(".group");
  return row?.querySelector<HTMLButtonElement>('[data-testid="file-preview-btn"]') ?? null;
}

afterEach(() => cleanup());

describe("WorkspaceFilesPanel preview buttons", () => {
  test("hides binary audio and video previews while keeping readable files previewable", async () => {
    renderWorkspaceFilesPanel();

    await waitFor(() => expect(screen.getByText("notes.md")).not.toBeNull());

    expect(previewButtonFor("notes.md")).not.toBeNull();
    expect(previewButtonFor("recording.mp3")).toBeNull();
    expect(previewButtonFor("demo.mp4")).toBeNull();
  });

  test("shows original names for composer-uploaded files", async () => {
    renderWorkspaceFilesPanel();

    await waitFor(() => expect(screen.getByText("mock_info.txt")).not.toBeNull());

    expect(
      screen.queryByText("composer-file-d2caf9d7-mock_info.txt"),
    ).toBeNull();
  });

  test("shows the original name for a legacy flat composer upload", async () => {
    renderWorkspaceFilesPanel({
      items: [
        {
          id: "legacy-flat",
          name: "a1b2c3d4-photo.png",
          path: "a1b2c3d4-photo.png",
          kind: "file",
        },
      ],
    });

    await waitFor(() => expect(screen.getByText("photo.png")).not.toBeNull());

    expect(screen.queryByText("a1b2c3d4-photo.png")).toBeNull();
  });

  test("keeps a legacy composer file and a real file with the same name", async () => {
    renderWorkspaceFilesPanel({
      items: [
        {
          id: "legacy",
          name: "composer-file-a1b2c3d4-report.pdf",
          path: "composer-file-a1b2c3d4-report.pdf",
          kind: "file",
        },
        { id: "real", name: "report.pdf", path: "report.pdf", kind: "file" },
      ],
    });

    await waitFor(() =>
      expect(screen.getAllByText("report.pdf").length).toBe(2),
    );
  });

  test("clears selected files from prompt context without deleting them", async () => {
    const selections: string[][] = [];
    renderWorkspaceFilesPanel({
      selectedPaths: ["projects/notes.md"],
      onSelectionChange: (paths) => selections.push(paths),
    });

    await waitFor(() => expect(screen.getByText("notes.md")).not.toBeNull());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Clear selected files" })).not.toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear selected files" }));

    expect(selections).toContainEqual([]);
    expect(screen.getByText("notes.md")).not.toBeNull();
  });
});

describe("WorkspaceFilesPanel delete", () => {
  const treeItems: OpenworkInboxItem[] = [
    { id: "projects", name: "projects", path: "projects", kind: "dir" },
    { id: "reports", name: "reports", path: "projects/reports", kind: "dir" },
    { id: "a", name: "a.md", path: "projects/reports/a.md", kind: "file" },
    { id: "b", name: "b.md", path: "projects/reports/b.md", kind: "file" },
    { id: "notes", name: "notes.md", path: "notes.md", kind: "file" },
  ];

  function renderWithDelete() {
    const deleteProjectItem = vi.fn(async () => ({ ok: true, path: "" }));
    const client = {
      listProjects: async () => ({ items: treeItems }),
      deleteProjectItem,
    } as unknown as OpenworkServerClient;
    render(() => <WorkspaceFilesPanel client={client} workspaceId="workspace-1" />);
    return { deleteProjectItem };
  }

  async function expandProjects() {
    await waitFor(() => expect(screen.getByText("projects")).not.toBeNull());
    const row = screen.getByText("projects").closest(".group");
    const toggle = row?.querySelector<HTMLButtonElement>('[data-testid="workspace-tree-toggle"]');
    if (!toggle) throw new Error("projects row has no expand toggle");
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("reports")).not.toBeNull());
  }

  test("offers no delete button on a workspace root folder", async () => {
    renderWithDelete();
    await waitFor(() => expect(screen.getByText("projects")).not.toBeNull());

    expect(screen.queryByRole("button", { name: "Delete projects" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete notes.md" })).not.toBeNull();
  });

  test("asks before deleting a folder, naming it and its file count", async () => {
    const { deleteProjectItem } = renderWithDelete();
    await expandProjects();

    fireEvent.click(screen.getByRole("button", { name: "Delete reports" }));

    expect(
      screen.getByText('This will permanently delete "reports/" and the 2 files in it.'),
    ).not.toBeNull();
    expect(deleteProjectItem).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("workspace-file-delete-confirm-btn"));

    await waitFor(() => expect(deleteProjectItem).toHaveBeenCalledWith("workspace-1", "reports"));
    expect(screen.queryByTestId("workspace-file-delete-confirm-btn")).toBeNull();
  });

  test("cancelling the folder confirmation deletes nothing", async () => {
    const { deleteProjectItem } = renderWithDelete();
    await expandProjects();

    fireEvent.click(screen.getByRole("button", { name: "Delete reports" }));
    fireEvent.click(screen.getByTestId("modal-dismiss-btn"));

    expect(screen.queryByTestId("workspace-file-delete-confirm-btn")).toBeNull();
    expect(deleteProjectItem).not.toHaveBeenCalled();
    expect(screen.getByText("reports")).not.toBeNull();
  });

  test("switching workspace while the confirmation is open discards it", async () => {
    const deleteProjectItem = vi.fn(async () => ({ ok: true, path: "" }));
    const client = {
      listProjects: async () => ({ items: treeItems }),
      deleteProjectItem,
    } as unknown as OpenworkServerClient;
    const [workspaceId, setWorkspaceId] = createSignal("workspace-1");
    render(() => <WorkspaceFilesPanel client={client} workspaceId={workspaceId()} />);
    await waitFor(() => expect(screen.getByText("notes.md")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Delete notes.md" }));
    expect(screen.getByTestId("workspace-file-delete-confirm-btn")).not.toBeNull();

    setWorkspaceId("workspace-2");

    await waitFor(() => expect(screen.queryByTestId("workspace-file-delete-confirm-btn")).toBeNull());
    expect(deleteProjectItem).not.toHaveBeenCalled();
  });

  test("asks before deleting a single file", async () => {
    const { deleteProjectItem } = renderWithDelete();
    await waitFor(() => expect(screen.getByText("notes.md")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Delete notes.md" }));

    expect(screen.getByText('This will permanently delete "notes.md".')).not.toBeNull();
    expect(deleteProjectItem).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("workspace-file-delete-confirm-btn"));

    await waitFor(() => expect(deleteProjectItem).toHaveBeenCalledWith("workspace-1", "notes"));
  });
});