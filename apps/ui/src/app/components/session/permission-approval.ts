import type { PendingPermission } from "~/shared/types/session";

import { offersAllowForSession } from "../../pages/session.permission-replies";

export type PermissionReply = "once" | "always" | "reject";

export type PermissionChoice = {
  reply: PermissionReply;
  labelKey: string;
  testId: string;
  variant: "blue" | "ghost" | "outline" | "danger";
};

export type PermissionCopy = {
  titleKey: string;
  /** May contain `{target}`. */
  summaryKey: string;
  target: string;
};

const FILE_PROTECTION = "confirm_file_protection";

/**
 * The choices in the order shown, the primary last. Each test id stays bound to the reply it sends.
 *
 * For file protection, "reject" is the choice that reads the file without masking (see
 * `app.file-protection-decline.ts`), so it is named for that outcome and masking is the primary.
 */
export function permissionChoices(permission: string): PermissionChoice[] {
  if (permission === FILE_PROTECTION) {
    return [
      { reply: "reject", labelKey: "session.permission_analyze_unmasked", testId: "permission-deny-btn", variant: "outline" },
      { reply: "once", labelKey: "session.permission_mask_and_analyze", testId: "permission-once-btn", variant: "blue" },
    ];
  }
  const allowForSession = offersAllowForSession(permission);
  const choices: PermissionChoice[] = [
    { reply: "reject", labelKey: "session.permission_dont_allow", testId: "permission-deny-btn", variant: "danger" },
    {
      reply: "once",
      labelKey: "session.permission_allow_once",
      testId: "permission-once-btn",
      variant: allowForSession ? "ghost" : "blue",
    },
  ];
  if (allowForSession) {
    choices.push({
      reply: "always",
      labelKey: "session.permission_allow_session",
      testId: "permission-allow-session-btn",
      variant: "blue",
    });
  }
  return choices;
}

const fileName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

const sourceFileNames = (metadata: Record<string, unknown>): string => {
  const paths = metadata.source_file_paths;
  if (!Array.isArray(paths)) return "";
  return paths
    .filter((path): path is string => typeof path === "string" && path.length > 0)
    .map(fileName)
    .join(", ");
};

const SUMMARY_WITH_TARGET: Record<string, string> = {
  email_send: "session.permission_summary_email_send",
  email_reply: "session.permission_summary_email_reply",
  schedule_meeting: "session.permission_summary_schedule_meeting",
};

/** One plain sentence about the request, built only from what the request carries. */
export function permissionCopy(
  request: Pick<PendingPermission, "permission" | "patterns" | "metadata">,
): PermissionCopy {
  if (request.permission === FILE_PROTECTION) {
    const target = sourceFileNames(request.metadata);
    return {
      titleKey: "session.permission_file_protection_title",
      summaryKey: target
        ? "session.permission_summary_file_protection"
        : "session.permission_summary_file_protection_unnamed",
      target,
    };
  }
  const titleKey = "session.permission_title";
  if (request.permission === "doom_loop") {
    return { titleKey, summaryKey: "session.permission_summary_doom_loop", target: "" };
  }
  const target = request.patterns.join(", ");
  if (!target) return { titleKey, summaryKey: "session.permission_required_description", target };
  return {
    titleKey,
    summaryKey: SUMMARY_WITH_TARGET[request.permission] ?? "session.permission_summary_other",
    target,
  };
}
