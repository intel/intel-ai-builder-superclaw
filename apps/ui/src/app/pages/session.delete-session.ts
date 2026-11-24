export type ConfirmDeleteSessionDeps = {
  busy: () => boolean;
  setBusy: (busy: boolean) => void;
  pendingSessionId: () => string | null;
  deleteSession: (sessionId: string) => Promise<void>;
  close: () => void;
  toast: (message: string) => void;
  describeError: (error: unknown) => string;
};

/**
 * The dialog does not navigate. The sidebar can delete any session, and
 * `deleteSession` already leaves the route when it points at the deleted one.
 */
export const createConfirmDeleteSession =
  (deps: ConfirmDeleteSessionDeps) => async (): Promise<void> => {
    if (deps.busy()) return;
    const sessionId = deps.pendingSessionId();
    if (!sessionId) return;
    deps.setBusy(true);
    try {
      await deps.deleteSession(sessionId);
      deps.close();
      deps.toast("Session deleted");
    } catch (error) {
      deps.toast(deps.describeError(error) || "Failed to delete session");
    } finally {
      deps.setBusy(false);
    }
  };
