/** Shared version/build info panel used by both SessionView and DashboardView sidebars. */
import { Show } from "solid-js";
import { t } from "../../i18n";
import { useCapabilityGate } from "~/shared/platform/capability/capability-gate";
import UpdateAvailablePill from "./update-available-pill";

export type VersionInfoPanelProps = {
  versionLabel: string | null;
  debugBuildCommit: string | null;
  debugBuildCommitLabel: string | null;
  commitCopied: boolean;
  onCopyCommit: () => void;
};

export function VersionInfoPanel(props: VersionInfoPanelProps) {
  const capability = useCapabilityGate();

  return (
    // Height keyed only on __BUILD_DEBUG__ (compile-time constant), not on debugBuildCommit (resolves async)
    // otherwise the reserved height itself would jump once the commit id loads
    <div class={`border-t border-dls-border/50 mt-1 pt-2.5 px-3 ${__BUILD_DEBUG__ ? "min-h-[54px]" : "min-h-[44px]"}`}>
      <div class="flex max-w-full items-center gap-1">
        <Show when={props.versionLabel}>
          {(versionLabel) => (
            <div class="inline-flex w-fit min-w-0 max-w-full items-center rounded-control bg-dls-hover/50 px-2.5 py-1.5">
              <div class="flex min-w-0 max-w-full flex-col items-start gap-1">
                <div class="flex min-w-0 max-w-full items-center gap-1 text-tiny font-mono text-dls-secondary/80 select-none leading-none">
                  <span class="sr-only">{t("dashboard.version_label")}</span>
                  <span class="shrink-0" aria-hidden="true">{t("dashboard.version_short")}</span>
                  <span class="min-w-0 truncate">{versionLabel()}</span>
                  <Show when={capability.productProfileId()}>
                    {(profileId) => <span class="shrink-0">({profileId()})</span>}
                  </Show>
                </div>
                <Show when={__BUILD_DEBUG__ && props.debugBuildCommit}>
                  <button
                    type="button"
                    class="max-w-full cursor-copy truncate text-left text-tiny font-mono text-dls-secondary/80 leading-none hover:text-dls-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-dls-accent"
                    onClick={props.onCopyCommit}
                    title={`Copy full commit ID: ${props.debugBuildCommit}`}
                    aria-label={`Copy full commit ID: ${props.debugBuildCommit}`}
                  >
                    {props.commitCopied ? "Copied!" : `Commit ID: ${props.debugBuildCommitLabel}`}
                  </button>
                </Show>
              </div>
            </div>
          )}
        </Show>
        <UpdateAvailablePill />
      </div>
    </div>
  );
}
