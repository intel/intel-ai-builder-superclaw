import { For } from "solid-js";
import { Clock, X } from "lucide-solid";

import { t } from "../../i18n";
import { hostApprovalNoticeKey, hostApprovalNoticeText } from "./host-mcp";
import type { HostMcpApprovals } from "./useHostMcp";

export type HostMcpApprovalNoticesProps = {
  approvals: Pick<HostMcpApprovals, "notices" | "dismissNotice">;
};

/** Says that an approval ended without an answer, so its action did not run. Text only, never markup. */
export default function HostMcpApprovalNotices(props: HostMcpApprovalNoticesProps) {
  return (
    <For each={props.approvals.notices()}>
      {(notice) => (
        <div
          role="status"
          data-testid="host-mcp-approval-notice"
          data-ended={notice.ended}
          class={`flex w-full items-start gap-3 border-b px-4 py-1.5 text-caption ${
            notice.ended === "expired"
              ? "border-dls-infobar-attention-border bg-dls-infobar-attention-bg text-dls-infobar-attention-text"
              : "border-dls-infobar-neutral-border bg-dls-infobar-neutral-bg text-dls-infobar-neutral-text"
          }`}
        >
          <Clock size={16} class="mt-0.5 shrink-0" />
          <span data-testid="host-mcp-approval-notice-text" class="min-w-0 flex-1 break-words">
            {hostApprovalNoticeText(notice, t(hostApprovalNoticeKey(notice)))}
          </span>
          <button
            type="button"
            data-testid="host-mcp-approval-notice-dismiss"
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-subtle hover:bg-dls-hover"
            aria-label={t("mcp.dismiss_status")}
            title={t("mcp.dismiss_status")}
            onClick={() => props.approvals.dismissNotice(notice.approval.approval_id)}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </For>
  );
}
