import { createSignal, type Accessor } from "solid-js";

// Prompt dispatches and every other busy flow (workspace, engine, creating a
// task) hold separate flags, so one finishing cannot clear the other, and the
// composer can tell a dispatch apart from work that blocks every session.
// The label and clock stay shared: the header shows one busy state.
export const createAppBusy = () => {
  const [shellBusy, setBusy] = createSignal(false);
  const [dispatchBusy, setDispatchBusy] = createSignal(false);
  const [busyLabel, setBusyLabel] = createSignal<string | null>(null);
  const [busyStartedAt, setBusyStartedAt] = createSignal<number | null>(null);
  const busy: Accessor<boolean> = () => shellBusy() || dispatchBusy();
  return {
    busy,
    shellBusy,
    setBusy,
    setDispatchBusy,
    busyLabel,
    setBusyLabel,
    busyStartedAt,
    setBusyStartedAt,
  };
};

// A prompt dispatch blocks only its own session. Any other busy flow blocks
// every composer, whether or not a dispatch is also in flight.
export const composerBusyForSelection = (
  shellBusy: boolean,
  dispatchingSessionIds: ReadonlySet<string>,
  selectedSessionId: string | null,
): boolean =>
  shellBusy ||
  (selectedSessionId !== null && dispatchingSessionIds.has(selectedSessionId));
