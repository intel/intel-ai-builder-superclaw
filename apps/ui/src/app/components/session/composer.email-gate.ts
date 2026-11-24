import type { ComposerProps } from "./composer.types";

// Same budget as the model probe before send. A Gmail status call that never
// returns must not keep the submission waiting.
const GMAIL_STATUS_WAIT_MS = 1_500;

type EmailGateProps = Pick<
  ComposerProps,
  | "selectedAgent"
  | "gmailConnectionStatus"
  | "ensureGmailCredentials"
  | "confirmEmailAgentCloudRisk"
  | "onGmailStatusClick"
>;

/**
 * Email Agent checks before a send. False stops the send, including when the
 * draft or chat changed during a wait. `props` is read live after each wait.
 */
export async function passEmailSendGates(
  props: EmailGateProps,
  submissionChanged: () => boolean,
): Promise<boolean> {
  // A leading @email-agent can select Email in this same turn. The status
  // effect starts its fetch then, so "none" here means the check has not
  // finished.
  // The probe is local. If it has not answered within the same budget the
  // model check uses, continue with whatever status is already known
  // instead of holding the send open.
  if (
    props.selectedAgent === "email-agent" &&
    props.gmailConnectionStatus === "none" &&
    props.ensureGmailCredentials
  ) {
    const pending = props.ensureGmailCredentials();
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, GMAIL_STATUS_WAIT_MS);
      }),
    ]);
    if (submissionChanged()) return false;
  }

  if (
    props.selectedAgent === "email-agent" &&
    props.confirmEmailAgentCloudRisk
  ) {
    if (!(await props.confirmEmailAgentCloudRisk())) return false;
    if (submissionChanged()) return false;
  }

  // Intercept send when email-agent is selected but Gmail is not configured
  if (
    props.selectedAgent === "email-agent" &&
    props.gmailConnectionStatus === "no_credentials"
  ) {
    props.onGmailStatusClick?.();
    return false;
  }
  return true;
}
