/**
 * task_id_fresh_dispatch_strip - drop a bogus `task_id` on a fresh `task`
 * (subagent) dispatch so the call is not rejected.
 *
 * Background (#1367): the `task` tool's `task_id` is ONLY valid when resuming an
 * existing subagent session, and opencode requires its value to be a
 * system-generated id that starts with `"ses"`. Weak on-device models (e.g.
 * qwen3.5-0.8b) sometimes pass a human-readable label instead
 * (`task_id: "convert_scanned_to_markdown"`), which opencode rejects with
 * `Expected a string starting with "ses"`, and the agent then burns its whole
 * step budget retrying the same broken call ("CRITICAL - MAXIMUM STEPS
 * REACHED").
 *
 * A fresh dispatch should simply omit `task_id`. This guard enforces that at
 * the `tool.execute.before` hook: if `task_id` is present but is not a valid
 * `ses`-prefixed session id, it is stripped so the call is treated as a new
 * dispatch (the model's `description` / `prompt` still label the work). A real
 * `ses...` id (a genuine resume) is left untouched.
 *
 * Mutates `output.args` in place - opencode keeps a reference to that object
 * after the trigger returns (same pattern as 05_file_path_arg_rename.ts), so
 * reassignment alone would not stick.
 */
import type { Plugin } from "@opencode-ai/plugin";

const TASK_TOOL = "task";
// opencode's dispatch tool takes `task_id`; accept camelCase spellings a weak
// model might emit so none slips through.
const TASK_ID_KEYS = ["task_id", "taskId", "taskID"] as const;
const VALID_SESSION_PREFIX = "ses";

export const TaskIdFreshDispatchStrip: Plugin = async ({ client }) => {
  await client.app.log({
    body: {
      service: "task-id-fresh-dispatch-strip",
      level: "info",
      message:
        `Plugin initialised; strips a non-'${VALID_SESSION_PREFIX}' task_id on a fresh ${TASK_TOOL} dispatch (#1367)`,
    },
  });

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== TASK_TOOL) return;

      const args = (output.args ?? {}) as Record<string, unknown>;
      const stripped: string[] = [];
      for (const key of TASK_ID_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
        const value = args[key];
        // Keep a genuine resume id (string starting with "ses"); strip anything
        // else (labels, empty, non-string) so the dispatch runs as a new one.
        if (typeof value === "string" && value.startsWith(VALID_SESSION_PREFIX)) continue;
        delete args[key];
        stripped.push(`${key}=${JSON.stringify(value)}`);
      }
      if (stripped.length === 0) return;
      output.args = args;

      await client.app.log({
        body: {
          service: "task-id-fresh-dispatch-strip",
          level: "info",
          message:
            `Stripped bogus task id on fresh dispatch (${stripped.join(", ")}) ` +
            `callID=${input.callID.slice(0, 10)}`,
        },
      });
    },
  };
};

export default TaskIdFreshDispatchStrip;
