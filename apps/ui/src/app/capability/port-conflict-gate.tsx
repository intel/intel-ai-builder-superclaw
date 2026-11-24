/**
 * Startup port-conflict gate — the outermost gate in the frontend tree.
 *
 * Renders **nothing** until the port verdict is known, then either mounts its
 * children (gate passed / verdict unknown) or the exit-only conflict dialog.
 * Nothing downstream — no provider, no capability resolver, no runtime tree —
 * gets mounted while a conflict stands, so no startup work is attempted.
 *
 * This is only the *visible* half of the gate. The authoritative half is in
 * Rust: `lib.rs::setup()` probes the ports and refuses to spawn ServiceHub
 * before the WebView even loads. That ordering is what guarantees "nothing
 * starts before the check passes"; this component just makes the outcome
 * visible and offers the exit.
 */
import { createResource, Show, type ParentProps } from "solid-js";

import PortConflictDialog from "../components/port-conflict-dialog";
import { exitApp, fetchPortPreflightReport } from "../lib/port-preflight";

export function PortConflictGate(props: ParentProps) {
  const [report] = createResource(fetchPortPreflightReport);

  const conflicts = () => report()?.conflicts ?? [];
  const isBlocked = () => conflicts().length > 0;

  return (
    // While the probe result is in flight we render nothing rather than the
    // children: mounting the runtime tree first and unmounting it on a conflict
    // would let providers fire their startup effects — exactly what this gate
    // exists to prevent. The read is a cached in-process value, so this is a
    // frame or two, not a perceptible delay.
    <Show when={!report.loading}>
      <Show when={isBlocked()} fallback={props.children}>
        <PortConflictDialog open conflicts={conflicts()} onExit={() => void exitApp()} />
      </Show>
    </Show>
  );
}
