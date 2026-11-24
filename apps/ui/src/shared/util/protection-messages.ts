/**
 * User-facing rewrites for confirm_file_protection status directives.
 *
 * The tool returns machine-readable instructions (PROTECTION_DISABLED / APPROVED /
 * ACTION_DENIED) that the model needs verbatim to pick its next step. Those strings
 * leak into two separate UI surfaces — the chat text parts rendered by PartView and
 * the Activity step rows rendered by MessageList — so the rewrite lives here rather
 * than being duplicated in either component.
 *
 * The backend contract is untouched; this is presentation only.
 */

const PROTECTION_DISABLED_RE = /PROTECTION_DISABLED:[^\n]+/g;
// The tool reports PROTECTION_DISABLED for two different reasons that must not
// share the same copy: a session pinned to the local model means the file never
// left the device, while mode-off means it may still leave the device unredacted.
const PROTECTION_DISABLED_LOCAL_FRIENDLY =
  "File Protection is off — this session is running locally, so the file stayed on your device and was not sent to the cloud.";
const PROTECTION_DISABLED_FRIENDLY =
  "File Protection is off. No masking is required.";

const PROTECTION_APPROVED_RE =
  /APPROVED:\s*proceed with task\(protected-file-agent\)[^\n]*/g;
const PROTECTION_APPROVED_FRIENDLY =
  "File Protection is on — your file will be processed through the secure pipeline before being sent for analysis.";

const PROTECTION_DENIED_RE = /ACTION_DENIED:[^\n]+(?:\n[^\n]+)*/g;
const PROTECTION_DENIED_FRIENDLY =
  "File Protection confirmation was declined. Your file will be processed without the secure pipeline for this request.";

const protectionDisabledReplacer = (match: string): string =>
  /stays on the device/i.test(match)
    ? PROTECTION_DISABLED_LOCAL_FRIENDLY
    : PROTECTION_DISABLED_FRIENDLY;

/** Replace any protection-status directive in `text` with its user-facing copy. */
export function sanitizeProtectionMessages(text: string): string {
  if (!text) return text;
  return text
    .replace(PROTECTION_APPROVED_RE, PROTECTION_APPROVED_FRIENDLY)
    .replace(PROTECTION_DENIED_RE, PROTECTION_DENIED_FRIENDLY)
    .replace(PROTECTION_DISABLED_RE, protectionDisabledReplacer);
}
