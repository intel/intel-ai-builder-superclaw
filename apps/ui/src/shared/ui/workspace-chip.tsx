import type { WorkspaceInfo } from "~/shared/platform/tauri";

import { t, currentLocale } from "../../i18n";

import { ChevronDown, Folder, Globe, Loader2, Zap } from "lucide-solid";

function iconForWorkspace(preset: string, workspaceType: string) {
  if (workspaceType === "remote") return Globe;
  if (preset === "starter") return Zap;
  if (preset === "automation") return Folder;
  if (preset === "minimal") return Globe;
  return Folder;
}

export default function WorkspaceChip(props: {
  workspace: WorkspaceInfo;
  onClick: () => void;
  connecting?: boolean;
}) {
  const Icon = iconForWorkspace(props.workspace.preset, props.workspace.workspaceType);
  const subtitle = () =>
    props.workspace.workspaceType === "remote"
      ? props.workspace.baseUrl ?? props.workspace.path
      : props.workspace.path;
  const translate = (key: string) => t(key, currentLocale());

  return (
    <button
      onClick={props.onClick}
      class="flex items-center gap-2 pl-3 pr-2 py-1.5 bg-dls-surface border border-dls-border rounded-control hover:border-dls-border hover:bg-dls-hover transition-all group"
    >
      <div
        class={`p-1 rounded-compact ${
          props.workspace.workspaceType !== "remote" && props.workspace.preset === "starter"
            ? "bg-dls-workspace-starter/10 text-dls-workspace-starter-text"
            : "bg-dls-workspace-default/10 text-dls-workspace-default-text"
        }`}
      >
        <Icon size={14} />
      </div>
      <div class="flex flex-col items-start mr-2 min-w-0">
        <div class="flex items-center gap-2">
          <span class="text-caption font-medium text-dls-text leading-none truncate max-w-[9.5rem]">
            {props.workspace.name}
          </span>
          {props.workspace.workspaceType === "remote" ? (
            <span class="text-tiny uppercase tracking-wide px-1.5 py-0.5 rounded-pill bg-dls-hover text-dls-secondary">
              {translate("dashboard.remote")}
            </span>
          ) : null}
        </div>
        <span class="text-tiny text-dls-secondary font-mono leading-none max-w-[120px] truncate">
          {subtitle()}
        </span>
      </div>
      <ChevronDown size={14} class="text-dls-secondary group-hover:text-dls-text" />
      {props.connecting ? <Loader2 size={14} class="text-dls-secondary animate-spin" /> : null}
    </button>
  );
}
