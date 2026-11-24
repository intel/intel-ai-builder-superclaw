import { Show } from "solid-js";
import { AtSign } from "lucide-solid";
import type { MessageWithParts } from "../../types";
import { agentTriggerLabel } from "../../pages/session.quick-agents";

/** The agent a sent message went to, shown under the user's bubble. */
export function MessageAgentBadge(props: { info: MessageWithParts["info"] }) {
  const agent = () => (props.info.role === "user" ? props.info.agent : "");
  return (
    <Show when={agent()}>
      {(name) => (
        <span
          data-testid="message-agent"
          data-agent={name()}
          class="flex items-center gap-1 text-label text-dls-secondary/80"
        >
          <AtSign size={11} />
          {agentTriggerLabel(name())}
        </span>
      )}
    </Show>
  );
}
