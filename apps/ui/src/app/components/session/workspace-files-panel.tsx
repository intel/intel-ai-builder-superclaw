import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { ChevronDown, ChevronRight, Eye, File, Folder, FolderOpen, Trash2, RefreshCw, HardDrive, X } from "lucide-solid";
import ConfirmModal from "~/shared/ui/confirm-modal";
import { Tooltip } from "~/shared/ui/tooltip";
import type { OpenworkServerClient, OpenworkInboxItem } from "../../lib/openwork-server";
import { listedWorkspaceFiles } from "../../lib/workspace-file-search";
import {
  isWorkspaceFilePreviewable,
  type WorkspaceFilePreviewSource,
} from "../../lib/workspace-file-preview";
import { t } from "../../../i18n";
import { isTauriRuntime } from "../../utils";
import { parseComposerInboxUploadPath, parseLegacyComposerInboxUploadPath } from "./composer.attachments";

// The host-native "sensitive" drop folder (see security-settings-section.tsx)
// is hidden from the sandbox, so its files must be listed/previewed/deleted
// through Tauri commands instead of the sandboxed openwork-server used for
// regular project files.
interface SensitiveFileEntry {
  name: string;
  path: string;
  size: number;
  modified_ms?: number | null;
}

// Mask registries are mirrored under data_protection_workspace/mask_registries
// as <stem>/<timestamp>/<file>.json, and tmpfs-shadowed to empty inside the
// sandbox the same way sensitive/ is, so they're listed via Tauri too.
interface MaskRegistryEntry {
  name: string;
  rel_path: string;
  path: string;
  size: number;
  modified_ms?: number | null;
}

export type WorkspaceFilesPanelProps = {
  client: OpenworkServerClient | null;
  workspaceId: string | null;
  /** Current session id; selection resets when session changes. */
  sessionId?: string | null;
  onToast?: (message: string) => void;
  /** Increment to trigger a refresh from outside (e.g. after inbox upload). */
  refreshVersion?: number;
  /** Called after files are successfully deleted, with their inbox-relative paths. */
  onFilesDeleted?: (paths: string[]) => void;
  /** Called when user clicks preview on a previewable file. */
  onPreview?: (itemId: string, fileName: string, source: WorkspaceFilePreviewSource) => void;
  /** Called when user click find file/folder in file explorer. */
  onOpenInFileExplorer?: (path: string, kind: "file" | "dir") => void;
  /** Called when file selection changes. Paths are prefixed like "inbox/path" or "projects/path". */
  onSelectionChange?: (selectedPaths: string[]) => void;
  /** Called with selected leaf-file count. Selected folders are expanded to their terminal files. */
  onSelectionFileCountChange?: (count: number) => void;
  /** Called with selected leaf-file paths. Selected folders are expanded to their terminal files. */
  onSelectionLeafFilesChange?: (paths: string[]) => void;
  /** Externally-controlled selected paths (e.g. after auto-select on upload). */
  selectedPaths?: string[];
};

// ---------------------------------------------------------------------------
// Tree data structure
// ---------------------------------------------------------------------------

interface TreeNode {
  name: string;
  /** Full relative path from inbox root */
  path: string;
  kind: "file" | "dir";
  size?: number;
  updatedAt?: number;
  /** Inbox item id — only set for files */
  inboxId?: string;
  children: TreeNode[];
}

function buildTree(items: OpenworkInboxItem[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const item of items) {
    const relPath = item.path ?? item.name ?? "";
    if (!relPath) continue;

    const isExplicitDir = item.kind === "dir";
    const parts = relPath.split("/").filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isLast = i === parts.length - 1;
      const pathSoFar = parts.slice(0, i + 1).join("/");
      const name = isLast
        ? (parseComposerInboxUploadPath(pathSoFar)?.filename ??
          parseLegacyComposerInboxUploadPath(`/workspace/${pathSoFar}`) ??
          part)
        : part;

      let node = current.find((n) => n.path === pathSoFar);
      if (!node) {
        node = {
          name,
          path: pathSoFar,
          kind: isLast && !isExplicitDir ? "file" : "dir",
          children: [],
        };
        if (isLast && !isExplicitDir) {
          node.size = item.size;
          node.updatedAt = item.updatedAt;
          node.inboxId = item.id;
        }
        if (isLast && isExplicitDir) {
          node.inboxId = item.id;
        }
        current.push(node);
      } else if (isLast && !isExplicitDir) {
        // File node was pre-created as dir for intermediate path — update it
        node.name = name;
        node.kind = "file";
        node.size = item.size;
        node.updatedAt = item.updatedAt;
        node.inboxId = item.id;
      }
      current = node.children;
    }
  }

  // Sort: directories first, then alphabetical
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.children.length > 0) sortNodes(n.children);
    }
  };
  sortNodes(root);
  return root;
}

function findTreeNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    const child = findTreeNode(node.children, path);
    if (child) return child;
  }
  return null;
}

function collectLeafFiles(node: TreeNode, out: Set<string>, namespace = "") {
  if (node.kind === "file") {
    out.add(`${namespace}${node.path}`);
    return;
  }
  for (const child of node.children) collectLeafFiles(child, out, namespace);
}

/**
 * Map Tauri-sourced sensitive-folder entries to flat TreeNode leaves.
 * `inboxId` is reused to carry the absolute host path (rather than an
 * openwork-server artifact id) so preview/delete handlers can route these
 * nodes to Tauri commands instead of the in-container client.
 */
function sensitiveEntriesToNodes(entries: SensitiveFileEntry[]): TreeNode[] {
  return entries.map((entry) => ({
    name: entry.name,
    path: `sensitive/${entry.name}`,
    kind: "file" as const,
    size: entry.size,
    updatedAt: entry.modified_ms ?? undefined,
    inboxId: entry.path,
    children: [],
  }));
}

/** Rebuild the <stem>/<timestamp>/<file>.json nesting from flat mask-registry entries. */
function maskRegistryEntriesToNodes(entries: MaskRegistryEntry[], basePath: string): TreeNode[] {
  const root: TreeNode[] = [];
  for (const entry of entries) {
    const parts = entry.rel_path.split("/").filter(Boolean);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isLast = i === parts.length - 1;
      const pathSoFar = `${basePath}/${parts.slice(0, i + 1).join("/")}`;
      let node = current.find((n) => n.name === part);
      if (!node) {
        node = {
          name: part,
          path: pathSoFar,
          kind: isLast ? "file" : "dir",
          children: [],
        };
        if (isLast) {
          node.size = entry.size;
          node.updatedAt = entry.modified_ms ?? undefined;
          node.inboxId = entry.path;
        }
        current.push(node);
      }
      current = node.children;
    }
  }
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.children.length > 0) sortNodes(n.children);
  };
  sortNodes(root);
  return root;
}

function collectSelectedLeafFiles(tree: TreeNode[], selected: Set<string>): Set<string> {
  const leafFiles = new Set<string>();
  for (const key of selected) {
    if (!key.startsWith("projects/")) {
      leafFiles.add(key);
      continue;
    }
    const rel = key.slice("projects/".length);
    if (!rel) continue;
    if (rel.endsWith("/")) {
      const node = findTreeNode(tree, rel.slice(0, -1));
      if (node) collectLeafFiles(node, leafFiles, "projects/");
      continue;
    }
    leafFiles.add(`projects/${rel}`);
  }
  return leafFiles;
}

function previewSourceForNode(node: TreeNode): WorkspaceFilePreviewSource {
  if (node.path.startsWith("sensitive/")) return "sensitive";
  if (node.path.startsWith("data_protection_workspace/mask_registries/")) {
    return "mask_registries";
  }
  return "projects";
}

// ---------------------------------------------------------------------------
// TreeNodeRow component
// ---------------------------------------------------------------------------

function TreeNodeRow(props: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onDelete: (node: TreeNode) => void;
  onPreview?: (node: TreeNode) => void;
  isPreviewable: (node: TreeNode) => boolean;
  onOpenInFileExplorer?: (path: string, kind: TreeNode["kind"]) => void;
  deleting: Set<string>;
  selected?: Set<string>;
  onToggleSelect?: (path: string, kind: TreeNode["kind"]) => void;
}) {
  const isDir = () => props.node.kind === "dir";
  const isExpanded = () => props.expanded.has(props.node.path);
  const isDeleting = () => props.deleting.has(props.node.path);
  const isPreviewable = () => !isDir() && props.isPreviewable(props.node);
  const selectionPath = () => isDir() ? `${props.node.path}/` : props.node.path;
  const isSelected = () => props.selected?.has(selectionPath()) ?? false;

  return (
    <>
      <div
        class={`group flex items-center gap-1 rounded-control px-1 py-0.5 hover:bg-dls-hover transition-colors cursor-default select-none ${isDeleting() ? "opacity-40" : ""}`}
        style={{ "padding-left": `${props.depth * 16 + 4}px` }}
      >
        {/* Checkbox for file/folder selection */}
        <Show when={props.onToggleSelect}>
            <input
              type="checkbox"
              data-testid="workspace-file-checkbox"
              checked={isSelected()}
              onChange={() => props.onToggleSelect!(props.node.path, props.node.kind)}
              class={`shrink-0 h-3 w-3 accent-dls-accent cursor-pointer transition-opacity ${isSelected() ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
              aria-label={isDir() ? "Select folder path for context" : "Select file for context"}
            />
        </Show>

        {/* Expand/collapse for directories */}
        <Show when={isDir()} fallback={<span class="w-4 shrink-0" />}>
          <button
            data-testid="workspace-tree-toggle"
            class="flex w-4 h-4 shrink-0 items-center justify-center text-dls-secondary hover:text-dls-text"
            onClick={() => props.onToggle(props.node.path)}
          >
            <Show when={isExpanded()} fallback={<ChevronRight size={12} />}>
              <ChevronDown size={12} />
            </Show>
          </button>
        </Show>

        {/* Icon */}
        <span class="shrink-0 text-dls-secondary">
          <Show when={isDir()} fallback={<File size={14} />}>
            <Show when={isExpanded()} fallback={<Folder size={14} />}>
              <FolderOpen size={14} />
            </Show>
          </Show>
        </span>

        {/* Name */}
        <span
          data-testid="workspace-file-name"
          class={`truncate text-caption ${isDir() ? "font-medium text-dls-text" : "text-dls-text"}`}
          title={props.node.path}
        >
          {props.node.name}
        </span>

        <div class="ml-auto shrink-0 flex items-center gap-1">
          {/* Preview is offered only when the source has a matching renderer. */}
          <Show when={isPreviewable() && props.onPreview}>
            <Tooltip content="Preview" placement="left" maxWidthClass="max-w-[140px]">
              <button
                type="button"
                data-testid="file-preview-btn"
                class="shrink-0 rounded-compact p-0.5 text-dls-secondary hover:text-dls-link hover:bg-dls-hover transition-colors"
                aria-label="Preview"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  props.onPreview!(props.node);
                }}
              >
                <Eye size={12} />
              </button>
            </Tooltip>
          </Show>

          {/* Find in explorer */}
          <Show when={props.onOpenInFileExplorer}>
            <Tooltip content={isDir() ? "Open in File Explorer" : "Find in File Explorer"} placement="left" maxWidthClass="max-w-[140px]">
              <button
                type="button"
                class="shrink-0 rounded-compact p-0.5 text-dls-secondary hover:text-dls-link hover:bg-dls-hover transition-colors"
                aria-label={isDir() ? "Open in File Explorer" : "Find in File Explorer"}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  props.onOpenInFileExplorer?.(props.node.path, props.node.kind);
                }}
              >
                <FolderOpen size={12} />
              </button>
            </Tooltip>
          </Show>

          {/* Delete button; workspace root folders are not deletable from here. */}
          <Show when={!(props.depth === 0 && isDir())}>
            <Tooltip content={t("common.delete")} placement="left" maxWidthClass="max-w-[140px]">
              <button
                class="shrink-0 rounded-compact p-0.5 text-dls-secondary hover:text-dls-danger-text hover:bg-dls-danger-bg transition-colors"
                aria-label={t("workspace_files.delete_item").replace("{name}", () => props.node.name)}
                disabled={isDeleting()}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onDelete(props.node);
                }}
              >
                <Trash2 size={12} />
              </button>
            </Tooltip>
          </Show>
        </div>
      </div>

      {/* Children (expanded dirs) */}
      <Show when={isDir() && isExpanded()}>
        <For each={props.node.children}>
          {(child) => (
            <TreeNodeRow
              node={child}
              depth={props.depth + 1}
              expanded={props.expanded}
              onToggle={props.onToggle}
              onDelete={props.onDelete}
              onPreview={props.onPreview}
              isPreviewable={props.isPreviewable}
              onOpenInFileExplorer={props.onOpenInFileExplorer}
              deleting={props.deleting}
              selected={props.selected}
              onToggleSelect={props.onToggleSelect}
            />
          )}
        </For>
      </Show>
    </>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export default function WorkspaceFilesPanel(props: WorkspaceFilesPanelProps) {
  // ── Projects state ───────────────────────────────────────────────────────
  const [projectItems, setProjectItems] = createSignal<OpenworkInboxItem[]>([]);
  const [projectsLoading, setProjectsLoading] = createSignal(false);
  const [projectsError, setProjectsError] = createSignal<string | null>(null);
  const [projectsExpanded, setProjectsExpanded] = createSignal<Set<string>>(new Set());
  const [deleting, setDeleting] = createSignal<Set<string>>(new Set());

  // ── Sensitive folder state (host-native, via Tauri — see sensitiveEntriesToNodes) ──
  const [sensitiveEntries, setSensitiveEntries] = createSignal<SensitiveFileEntry[]>([]);

  // ── Mask registries state (host-native, via Tauri — see maskRegistryEntriesToNodes) ──
  const [maskRegistryEntries, setMaskRegistryEntries] = createSignal<MaskRegistryEntry[]>([]);

  // ── File selection state ─────────────────────────────────────────────────
  // Keys stored as "projects/<path>" to avoid future collisions
  const [selectedFiles, setSelectedFiles] = createSignal<Set<string>>(new Set());

  // Sync externally-controlled selectedPaths into internal state
  createEffect(
    on(
      () => props.selectedPaths,
      (external) => {
        if (!external) return;
        const current = selectedFiles();
        const externalSet = new Set(external);
        // Only update if there's a difference
        if (externalSet.size !== current.size || [...externalSet].some((k) => !current.has(k))) {
          setSelectedFiles(externalSet);
        }
      },
    ),
  );

  const projectsSelected = createMemo(() => {
    const out = new Set<string>();
    for (const key of selectedFiles()) {
      if (key.startsWith("projects/")) out.add(key.slice(9));
    }
    return out;
  });

  const notifySelection = (next: Set<string>) => {
    props.onSelectionChange?.(Array.from(next));
    const leafPaths = Array.from(collectSelectedLeafFiles(projectsTree(), next));
    props.onSelectionLeafFilesChange?.(leafPaths);
    props.onSelectionFileCountChange?.(leafPaths.length);
  };

  const toggleProjectsSelect = (path: string, kind: TreeNode["kind"] = "file") => {
    setSelectedFiles((prev) => {
      const key = `projects/${path}${kind === "dir" ? "/" : ""}`;
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      notifySelection(next);
      return next;
    });
  };

  const clearSelectedFiles = () => {
    setSelectedFiles(() => {
      const next = new Set<string>();
      notifySelection(next);
      return next;
    });
  };

  const toast = (msg: string) => props.onToast?.(msg);
  const connected = createMemo(() => Boolean(props.client && (props.workspaceId ?? "").trim()));

  const projectsTree = createMemo(() => {
    const tree = buildTree(projectItems());
    // The sandbox tmpfs-shadows /workspace/sensitive to an empty view so
    // agents can't read it raw; splice in the host-native listing here so
    // the panel still shows what's actually in the drop folder.
    const sensitiveNode = tree.find((n) => n.name === "sensitive" && n.kind === "dir");
    if (sensitiveNode) {
      sensitiveNode.children = sensitiveEntriesToNodes(sensitiveEntries());
    }
    const maskRegistriesNode = findTreeNode(tree, "data_protection_workspace/mask_registries");
    if (maskRegistriesNode) {
      maskRegistriesNode.children = maskRegistryEntriesToNodes(maskRegistryEntries(), maskRegistriesNode.path);
    }
    return tree;
  });
  const projectsCount = createMemo(() => projectItems().length);
  const selectedLeafFiles = createMemo(() => collectSelectedLeafFiles(projectsTree(), selectedFiles()));
  const selectedLeafFileCount = createMemo(() => selectedLeafFiles().size);

  // Clear selected files when switching sessions to avoid carrying context
  // selections across unrelated tasks.
  createEffect(
    on(
      () => props.sessionId ?? null,
      (next, prev) => {
        if (next === prev) return;
        if (selectedFiles().size === 0) return;
        setSelectedFiles(new Set<string>());
        notifySelection(new Set<string>());
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    const leafPaths = Array.from(selectedLeafFiles());
    props.onSelectionLeafFilesChange?.(leafPaths);
    props.onSelectionFileCountChange?.(leafPaths.length);
  });

  // ── Refresh helpers ──────────────────────────────────────────────────────
  const refreshProjects = async () => {
    const client = props.client;
    const wid = (props.workspaceId ?? "").trim();
    if (!client || !wid) return;
    if (projectsLoading()) return; // avoid overlapping requests from 5s poll
    setProjectsLoading(true);
    setProjectsError(null);
    try {
      const result = await listedWorkspaceFiles.listProjects(client, wid);
      setProjectItems(result.items ?? []);
    } catch (err) {
      setProjectItems([]);
      const msg = err instanceof Error && /timed?\s*out/i.test(err.message)
        ? "Loading timed out — too many files"
        : "Failed to load project files";
      setProjectsError(msg);
    } finally {
      setProjectsLoading(false);
    }
  };

  const refreshAll = () => {
    void refreshProjects();
    void loadSensitiveFiles();
    void loadMaskRegistries();
  };

  /** Load the host-native sensitive-folder listing directly via Tauri (bypasses the sandbox). */
  const loadSensitiveFiles = async () => {
    if (!isTauriRuntime()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const entries = await invoke<SensitiveFileEntry[]>("sensitive_files_list");
      setSensitiveEntries(entries);
    } catch {
      setSensitiveEntries([]);
    }
  };

  /** Load the host-native mask-registries listing directly via Tauri (bypasses the sandbox). */
  const loadMaskRegistries = async () => {
    if (!isTauriRuntime()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const entries = await invoke<MaskRegistryEntry[]>("mask_registries_list");
      setMaskRegistryEntries(entries);
    } catch {
      setMaskRegistryEntries([]);
    }
  };

  // Auto-refresh when connected
  createEffect(on(connected, (ok) => { if (ok) refreshAll(); }));

  // Refresh projects when refreshVersion prop changes (after upload)
  createEffect(on(() => props.refreshVersion ?? 0, (v, prev) => {
    if (v !== prev && connected()) refreshAll();
  }));

  // Poll projects every 5s to pick up host filesystem changes
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  createEffect(on(connected, (ok) => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
    if (ok) {
      pollTimer = setInterval(() => { refreshAll(); }, 5000);
    }
  }));
  onCleanup(() => { if (pollTimer) clearInterval(pollTimer); });

  // ── Expand/collapse ──────────────────────────────────────────────────────
  const toggleProjectsExpand = (path: string) => {
    setProjectsExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // ── Delete ───────────────────────────────────────────────────────────────
  /** Delete a file from the host-native sensitive folder directly via Tauri. */
  const deleteSensitiveNode = async (node: TreeNode) => {
    if (!isTauriRuntime()) {
      toast("Sensitive files can only be managed in the desktop app.");
      return;
    }
    setDeleting((prev) => new Set([...prev, node.path]));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const entries = await invoke<SensitiveFileEntry[]>("sensitive_files_delete", { name: node.name });
      setSensitiveEntries(entries);
      toast(`Deleted ${node.name}`);
      props.onFilesDeleted?.([node.path]);
      setSelectedFiles((prev) => {
        const next = new Set(prev);
        next.delete(`projects/${node.path}`);
        notifySelection(next);
        return next;
      });
    } catch {
      toast(`Failed to delete ${node.name}`);
    } finally {
      setDeleting((prev) => {
        const next = new Set(prev);
        next.delete(node.path);
        return next;
      });
    }
  };

  const deleteProjectNode = async (node: TreeNode) => {
    if (node.path.startsWith("sensitive/")) {
      return deleteSensitiveNode(node);
    }
    if (node.path.startsWith("data_protection_workspace/mask_registries/")) {
      toast("Mask registries are read-only here — delete them in File Explorer if needed.");
      return;
    }

    const client = props.client;
    const wid = (props.workspaceId ?? "").trim();
    if (!client || !wid) return;

    // For directories, encode the dir path as an artifact id and send a single
    // DELETE — the backend now handles recursive directory removal.
    const itemId = node.inboxId
      ? node.inboxId
      : node.path
        ? btoa(unescape(encodeURIComponent(node.path))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
        : null;

    if (!itemId) {
      toast("No files to delete.");
      return;
    }

    const label = node.kind === "dir" ? `${node.name}/` : node.name;

    setDeleting((prev) => new Set([...prev, node.path]));
    try {
      try {
        await client.deleteProjectItem(wid, itemId);
        toast(`Deleted ${label}`);
        // Notify parent so artifacts panel can remove the deleted file immediately
        props.onFilesDeleted?.([node.path]);
        // Remove deleted path(s) from selection
        setSelectedFiles((prev) => {
          const next = new Set(prev);
          const prefix = `projects/${node.path}`;
          for (const key of prev) {
            if (key === prefix || key.startsWith(prefix + "/")) next.delete(key);
          }
          notifySelection(next);
          return next;
        });
      } catch {
        toast(`Failed to delete ${label}`);
      }
      await refreshProjects();
    } finally {
      setDeleting((prev) => {
        const next = new Set(prev);
        next.delete(node.path);
        return next;
      });
    }
  };

  // The backend deletes directories recursively, so every delete is confirmed first.
  const [pendingDelete, setPendingDelete] = createSignal<TreeNode | null>(null);
  // The target is a workspace-relative path, so it must not outlive its workspace.
  createEffect(
    on([() => props.client, () => props.workspaceId], () => setPendingDelete(null), { defer: true }),
  );

  const requestDelete = (node: TreeNode) => {
    if (node.path.startsWith("data_protection_workspace/mask_registries/")) {
      void deleteProjectNode(node);
      return;
    }
    setPendingDelete(node);
  };

  // A replacer function keeps "$&"-style sequences in file names literal.
  const deleteConfirmMessage = (node: TreeNode) => {
    if (node.kind === "file") {
      return t("workspace_files.delete_file_message").replace("{name}", () => node.name);
    }
    const files = new Set<string>();
    collectLeafFiles(node, files);
    const key =
      files.size === 0
        ? "workspace_files.delete_folder_message_empty"
        : files.size === 1
          ? "workspace_files.delete_folder_message_one"
          : "workspace_files.delete_folder_message";
    return t(key).replace("{count}", String(files.size)).replace("{name}", () => node.name);
  };

  const previewProjectNode = (node: TreeNode) => {
    const onPreview = props.onPreview;
    if (!onPreview) return;

    const source = previewSourceForNode(node);
    if (source === "sensitive" || source === "mask_registries") {
      // Host-native files carry their absolute path in inboxId.
      onPreview(node.inboxId ?? node.path, node.name, source);
      return;
    }

    if (node.inboxId) {
      onPreview(node.inboxId, node.name, source);
      return;
    }

    // Encode path as base64url (UTF-8 safe).
    const bytes = new TextEncoder().encode(node.path);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index]!);
    }
    const itemId = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    onPreview(itemId, node.name, source);
  };

  return (
    <div>
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-caption font-semibold text-dls-text flex items-center gap-1.5">
          {t("file_upload.tab_files")}
        </h3>
        <div class="flex items-center gap-1">
          <Show when={selectedFiles().size > 0}>
            <Tooltip
              content="Clear selected files from prompt context"
              placement="left"
              maxWidthClass="max-w-[180px]"
            >
              <button
                class="rounded-compact p-1 text-dls-secondary hover:bg-dls-hover hover:text-dls-text transition-colors"
                aria-label="Clear selected files"
                onClick={clearSelectedFiles}
              >
                <X size={12} />
              </button>
            </Tooltip>
          </Show>
          <Tooltip content="Refresh all" placement="left" maxWidthClass="max-w-[140px]">
            <button
              class="rounded-compact p-1 text-dls-secondary hover:bg-dls-hover hover:text-dls-text transition-colors"
              aria-label="Refresh all"
              disabled={projectsLoading() || !connected()}
              onClick={() => refreshAll()}
            >
              <RefreshCw size={12} class={projectsLoading() ? "animate-spin" : ""} />
            </button>
          </Tooltip>
        </div>
      </div>

      <Show when={!connected()}>
        <p class="text-label text-dls-secondary/60 py-2">Connect to a worker to view files.</p>
      </Show>

      <Show when={connected()}>
        {/* ── Project Files (host mount) ─────────────────────────── */}
        <div>
          <div class="flex items-center gap-1.5 mb-1">
            <HardDrive size={12} class="text-dls-secondary" />
            <span class="text-tiny font-semibold uppercase tracking-wider text-dls-secondary">{t("settings.label_workspaces")}</span>
            <Show when={projectsCount() > 0}>
              <span class="rounded-pill bg-dls-hover/60 px-1.5 py-0.5 text-tiny font-medium text-dls-secondary">
                {projectsCount()}
              </span>
            </Show>
          </div>
          <Show when={projectsTree().length > 0} fallback={
            <p class={`text-label py-1 pl-4 ${projectsError() ? "text-dls-danger-text" : "text-dls-secondary/60"}`}>
              {projectsLoading() ? "Loading..." : projectsError() ?? "No project files found."}
            </p>
          }>
            <div class="max-h-[35vh] overflow-y-auto -mx-1" data-testid="workspace-files-tree">
              <For each={projectsTree()}>
                {(node) => (
                  <TreeNodeRow
                    node={node}
                    depth={0}
                    expanded={projectsExpanded()}
                    onToggle={toggleProjectsExpand}
                    onDelete={requestDelete}
                    onPreview={props.onPreview ? previewProjectNode : undefined}
                    isPreviewable={(file) =>
                      isWorkspaceFilePreviewable(file.name, previewSourceForNode(file))
                    }
                    onOpenInFileExplorer={props.onOpenInFileExplorer}
                    deleting={deleting()}
                    selected={projectsSelected()}
                    onToggleSelect={toggleProjectsSelect}
                  />
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={pendingDelete()}>
        {(node) => (
          <Portal>
            <ConfirmModal
              open
              title={
                node().kind === "dir"
                  ? t("workspace_files.delete_folder_title")
                  : t("workspace_files.delete_file_title")
              }
              message={deleteConfirmMessage(node())}
              confirmLabel={t("common.delete")}
              cancelLabel={t("common.cancel")}
              variant="danger"
              data-testid="workspace-file-delete-confirm-btn"
              onConfirm={() => {
                const target = node();
                setPendingDelete(null);
                void deleteProjectNode(target);
              }}
              onCancel={() => setPendingDelete(null)}
            />
          </Portal>
        )}
      </Show>
    </div>
  );
}
