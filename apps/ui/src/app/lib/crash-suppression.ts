type CrashSuppressionRule = {
  matches: (message: string) => boolean;
};

const CRASH_SUPPRESSION_RULES: readonly CrashSuppressionRule[] = [
  {
    matches: (message) => /^The resource id \d+ is invalid\.$/.test(message),
  },
];

function extractMessage(reason: unknown): string | undefined {
  if (typeof reason === "string") return reason.trim();
  if (reason instanceof Error) return reason.message.trim();
  if (typeof reason === "object" && reason !== null && "message" in reason) {
    const message = (reason as { message?: unknown }).message;
    return typeof message === "string" ? message.trim() : undefined;
  }
  return undefined;
}

export function isSuppressedFrontendCrash(reason: unknown): boolean {
  const message = extractMessage(reason);
  return message !== undefined && CRASH_SUPPRESSION_RULES.some((rule) => rule.matches(message));
}