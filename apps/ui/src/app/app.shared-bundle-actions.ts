/**
 * The three shared-bundle import handlers the UI calls directly: add a shared
 * skill to a worker the user picked, start the create-a-worker flow for a
 * bundle, and import a bundle into an existing worker.
 *
 * `features/workspace-import` owns the import primitives and
 * `app.shared-bundle.ts` owns the pure decisions. What is left here — and the
 * only reason these are not in either — is app-shell orchestration: moving the
 * user to a view/tab, driving the busy and error signals, clearing the invite,
 * and raising the toast. That is app.tsx's state, so it arrives as deps.
 *
 * All three share the shape of swallowing nothing: every failure path sets a
 * user-visible message, and the busy flag is released in `finally` so a thrown
 * import cannot leave a dead spinner behind.
 */
import type { Accessor, Setter } from "solid-js";

import type {
  SharedBundleCreateWorkerRequest,
  SharedBundleImportChoice,
  SharedSkillDestinationRequest,
  SharedSkillSuccessToast,
} from "./app.shared-bundle";
import {
  describeWorkspaceForToasts,
  isSharedBundleImportWorkspace,
  resolveSharedBundleImportTargetForWorkspace,
} from "./app.shared-bundle";
import type {
  SharedBundleDeepLink,
  SharedBundleImportTarget,
  SharedBundleV1,
} from "~/features/workspace-import";
import { isTauriRuntime } from "~/shared/platform/runtime-env";
import { safeStringify } from "~/shared/util/format";
import type { SettingsSection } from "./pages/settings-dialog.sections";
import type { WorkspaceDisplay } from "./types";
import { addOpencodeCacheHint } from "./utils";

export type SharedBundleActionsDeps = {
  error: Accessor<string | null>;
  setError: Setter<string | null>;
  openSettings: (section: SettingsSection) => void;

  sharedBundleImportBusy: Accessor<boolean>;
  setSharedBundleImportBusy: Setter<boolean>;
  sharedBundleImportChoice: Accessor<SharedBundleImportChoice | null>;
  setSharedBundleImportChoice: Setter<SharedBundleImportChoice | null>;
  setSharedBundleImportError: Setter<string | null>;
  setSharedBundleCreateWorkerRequest: Setter<SharedBundleCreateWorkerRequest | null>;
  setSharedBundleNoticeShown: Setter<boolean>;

  sharedSkillDestinationBusyId: Accessor<string | null>;
  setSharedSkillDestinationBusyId: Setter<string | null>;
  sharedSkillDestinationRequest: Accessor<SharedSkillDestinationRequest | null>;
  setSharedSkillDestinationRequest: Setter<SharedSkillDestinationRequest | null>;
  showSharedSkillSuccessToast: (toast: SharedSkillSuccessToast) => void;

  /** From `createSharedBundleImportFlow`. */
  createWorkerForSharedBundle: (
    request: SharedBundleDeepLink,
    bundle: SharedBundleV1,
  ) => Promise<unknown>;
  importSharedBundleIntoActiveWorker: (
    request: SharedBundleDeepLink,
    target: SharedBundleImportTarget | undefined,
    bundle: SharedBundleV1,
  ) => Promise<boolean>;
  importSharedBundlePayload: (
    bundle: SharedBundleV1,
    target: SharedBundleImportTarget,
  ) => Promise<unknown>;
  resolveActiveSharedBundleImportTarget: () => SharedBundleImportTarget;

  workspaceStore: {
    activateWorkspace: (workspaceId: string) => Promise<boolean>;
    setCreateWorkspaceOpen: Setter<boolean>;
    workspaces: Accessor<WorkspaceDisplay[]>;
  };
};

export const createSharedBundleActions = (deps: SharedBundleActionsDeps) => {
  // `deps` is a plain object of accessors built once by `App()`, not a Solid
  // props proxy, so destructuring copies function references without
  // collapsing reactivity.
  const {
    error,
    setError,
    openSettings,
    sharedBundleImportBusy,
    setSharedBundleImportBusy,
    sharedBundleImportChoice,
    setSharedBundleImportChoice,
    setSharedBundleImportError,
    setSharedBundleCreateWorkerRequest,
    setSharedBundleNoticeShown,
    sharedSkillDestinationBusyId,
    setSharedSkillDestinationBusyId,
    sharedSkillDestinationRequest,
    setSharedSkillDestinationRequest,
    showSharedSkillSuccessToast,
    createWorkerForSharedBundle,
    importSharedBundleIntoActiveWorker,
    importSharedBundlePayload,
    resolveActiveSharedBundleImportTarget,
    workspaceStore,
  } = deps;

  /** Report a thrown import on both the invite card and the app error banner. */
  const reportImportFailure = (thrown: unknown) => {
    const message =
      thrown instanceof Error ? thrown.message : safeStringify(thrown);
    const friendly = addOpencodeCacheHint(message);
    setSharedBundleImportError(friendly);
    setError(friendly);
  };

  const importSharedSkillIntoWorkspace = async (workspaceId: string) => {
    if (sharedSkillDestinationBusyId()) return;
    const destination = sharedSkillDestinationRequest();
    if (!destination) return;

    const workspace =
      workspaceStore.workspaces().find((item) => item.id === workspaceId) ??
      null;
    if (!workspace || !isSharedBundleImportWorkspace(workspace)) {
      setError("This worker cannot accept shared skills yet.");
      return;
    }

    openSettings("scheduled");
    setError(null);
    setSharedSkillDestinationBusyId(workspaceId);

    try {
      const ok = await workspaceStore.activateWorkspace(workspaceId);
      if (!ok) return;

      const imported = await importSharedBundleIntoActiveWorker(
        destination.request,
        resolveSharedBundleImportTargetForWorkspace(workspace),
        destination.bundle,
      );
      if (!imported) return;

      showSharedSkillSuccessToast({
        title: "Skill added",
        description: `Added '${destination.bundle.name.trim() || "Shared skill"}' to ${describeWorkspaceForToasts(workspace)}.`,
      });
      setSharedSkillDestinationRequest(null);
      setSharedBundleCreateWorkerRequest(null);
      setSharedBundleNoticeShown(false);
    } finally {
      setSharedSkillDestinationBusyId(null);
    }
  };

  const openSharedBundleCreateWorkerFlow = async () => {
    const choice = sharedBundleImportChoice();
    if (!choice || sharedBundleImportBusy()) return;

    setSharedBundleImportError(null);
    setError(null);

    if (isTauriRuntime()) {
      openSettings("scheduled");
      setSharedBundleCreateWorkerRequest({
        request: choice.request,
        bundle: choice.bundle,
        defaultPreset: "starter",
      });
      setSharedBundleImportChoice(null);
      workspaceStore.setCreateWorkspaceOpen(true);
      return;
    }

    setSharedBundleImportBusy(true);
    try {
      await createWorkerForSharedBundle(choice.request, choice.bundle);
      await importSharedBundlePayload(
        choice.bundle,
        resolveActiveSharedBundleImportTarget(),
      );
      setSharedBundleImportChoice(null);
      setError(null);
    } catch (thrown) {
      reportImportFailure(thrown);
    } finally {
      setSharedBundleImportBusy(false);
    }
  };

  const importSharedBundleIntoExistingWorkspace = async (
    workspaceId: string,
  ) => {
    const choice = sharedBundleImportChoice();
    if (!choice || sharedBundleImportBusy()) return;

    const workspace =
      workspaceStore.workspaces().find((item) => item.id === workspaceId) ??
      null;
    if (!workspace) {
      setSharedBundleImportError("The selected worker is no longer available.");
      return;
    }

    const target = resolveSharedBundleImportTargetForWorkspace(workspace);
    if (!target) {
      setSharedBundleImportError(
        "This worker cannot accept shared skill imports yet.",
      );
      return;
    }

    setSharedBundleImportBusy(true);
    setSharedBundleImportError(null);
    setError(null);

    try {
      openSettings("skills");
      const ok = await workspaceStore.activateWorkspace(workspace.id);
      if (!ok) {
        throw new Error(
          error() ||
            `Failed to switch to ${workspace.displayName?.trim() || workspace.name || "the selected worker"}.`,
        );
      }
      await importSharedBundlePayload(choice.bundle, target);
      setSharedBundleImportChoice(null);
      setError(null);
    } catch (thrown) {
      reportImportFailure(thrown);
    } finally {
      setSharedBundleImportBusy(false);
    }
  };

  return {
    importSharedBundleIntoExistingWorkspace,
    importSharedSkillIntoWorkspace,
    openSharedBundleCreateWorkerFlow,
  };
};
