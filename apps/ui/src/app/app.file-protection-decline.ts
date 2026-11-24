type PermissionReply = "once" | "always" | "reject";

type ShownPermission = { id: string; sessionID: string; permission: string };

type DeclineDeps = {
  openGrant: (sessionId: string) => Promise<void>;
  respond: (requestID: string, reply: PermissionReply) => Promise<void>;
  warn: (message: string) => void;
  notifyAlreadyDeclined: () => void;
  isBusy: () => boolean;
  setBusy: (busy: boolean) => void;
  granted: Set<string>;
};

/**
 * Deny on `confirm_file_protection` means "read it locally, unprotected". The App, not the sandbox,
 * records that decision with privacy_manager before the agent sees the reply, so its
 * `local_sensitive_read` call finds the grant. A failed grant still sends the Deny: the host read
 * is then refused, which is the safe side.
 *
 * The busy guard is held from before the grant until the reply is sent, so the dialog's buttons stay
 * disabled meanwhile: otherwise a quick Deny then Once approves the request while also opening an
 * unprotected-read grant.
 *
 * `granted` holds the requests whose Deny opened a grant. A failed reply leaves such a request
 * pending, and an approval must not follow while that grant is live, so only Deny retries go out. A
 * dropped approval tells the user why, or the button would look dead.
 */
export async function replyRecordingFileProtectionDecline(
  shown: ShownPermission | null,
  requestID: string,
  reply: PermissionReply,
  deps: DeclineDeps,
): Promise<void> {
  if (deps.isBusy()) return;
  if (reply !== "reject" && deps.granted.has(requestID)) {
    deps.warn(`${requestID} was declined with a local-read grant; only Deny can be sent`);
    deps.notifyAlreadyDeclined();
    return;
  }
  deps.setBusy(true);
  try {
    if (
      reply === "reject" &&
      shown !== null &&
      shown.id === requestID &&
      shown.permission === "confirm_file_protection" &&
      !deps.granted.has(requestID)
    ) {
      try {
        await deps.openGrant(shown.sessionID);
        deps.granted.add(requestID);
      } catch (error) {
        deps.warn(`local-read grant failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await deps.respond(requestID, reply);
  } finally {
    deps.setBusy(false);
  }
}
