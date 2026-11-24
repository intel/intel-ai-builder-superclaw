/**
 * file_path_arg_rename — normalise the `file_path` arg name to `filePath` for
 * read/write/edit tools.
 *
 * Background: opencode's read/write/edit tool schemas use camelCase
 * `filePath`, but some models (Claude-trained) emit snake_case `file_path`.
 * Opencode then rejects the call with a schema-validation error and the
 * model burns retries on the same shape. We rename the arg in place at the
 * `tool.execute.before` hook so the call goes through.
 *
 * Mutates `output.args` in place — opencode keeps a reference to that object
 * after the trigger returns (same pattern as 03_strip_model_id_prompt.ts),
 * so reassignment would not stick.
 */
import type { Plugin } from "@opencode-ai/plugin";

const TARGET_TOOLS = new Set(["read", "write", "edit"]);

export const FilePathArgRename: Plugin = async ({ client }) => {
  await client.app.log({
    body: {
      service: "file-path-arg-rename",
      level: "info",
      message: `Plugin initialised; remaps file_path -> filePath for ${[...TARGET_TOOLS].join(",")}`,
    },
  });

  return {
    "tool.execute.before": async (input, output) => {
      if (!TARGET_TOOLS.has(input.tool)) return;

      const args = (output.args ?? {}) as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(args, "file_path")) return;
      // Don't clobber an explicitly set filePath — drop the snake_case dup.
      if (!Object.prototype.hasOwnProperty.call(args, "filePath")) {
        args.filePath = args.file_path;
      }
      delete args.file_path;
      output.args = args;

      await client.app.log({
        body: {
          service: "file-path-arg-rename",
          level: "info",
          message: `Renamed file_path -> filePath tool='${input.tool}' callID=${input.callID.slice(0, 10)}`,
        },
      });
    },
  };
};

export default FilePathArgRename;
