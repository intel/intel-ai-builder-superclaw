/**
 * Startup elevation gate, outside the port gate. Rust has already declined to start ServiceHub when
 * this blocks, so nothing downstream is mounted.
 */
import { createResource, Show, type ParentProps } from "solid-js";

import ElevationDialog from "../components/elevation-dialog";
import { fetchElevationBlocked } from "../lib/elevation-preflight";
import { exitApp } from "../lib/port-preflight";

export function ElevationGate(props: ParentProps) {
  const [blocked] = createResource(fetchElevationBlocked);

  return (
    <Show when={!blocked.loading}>
      <Show when={blocked()} fallback={props.children}>
        <ElevationDialog open onExit={() => void exitApp()} />
      </Show>
    </Show>
  );
}
