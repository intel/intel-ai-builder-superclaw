import { t } from "~/i18n";

export function getWorkspaceTaskLoadErrorDisplay(error?: string | null) {
  const raw = error?.trim() ?? "";
  const failed = t("workspace.tasks_load_failed");
  return {
    message: failed,
    title: raw || failed,
  };
}
