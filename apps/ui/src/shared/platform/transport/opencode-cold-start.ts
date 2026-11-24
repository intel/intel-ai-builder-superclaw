/**
 * One more try after the OpenCode transport gives up.
 *
 * Saving or deleting an agent, and installing or removing a skill, posts
 * `/instance/dispose` and returns before OpenCode has recreated the instance.
 * The next `app.agents` or `command.list` is that recreation. The transport
 * aborts it at 10s (`Request timed out.`). On a slow machine the instance is
 * up a moment later, so the same call succeeds — the retry the agent picker
 * was asking the user to click. Any other failure is the caller's to handle.
 */
const OPENCODE_REQUEST_TIMEOUT_MESSAGE = "Request timed out.";

export function isOpencodeRequestTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === OPENCODE_REQUEST_TIMEOUT_MESSAGE;
}

export async function retryOpencodeColdStart<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isOpencodeRequestTimeout(error)) throw error;
    return await run();
  }
}
