export function resolveAgentForDispatch(
  mentionedAgent: string | null,
  sessionAgent: string | null,
): string | null {
  return mentionedAgent ?? sessionAgent;
}