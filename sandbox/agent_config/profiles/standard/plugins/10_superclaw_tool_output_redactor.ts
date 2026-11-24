/**
 * Redact platform credentials from tool results before they enter the model
 * context, session transcript, logs, or user-visible output.
 */
import type { Plugin } from "@opencode-ai/plugin";

const REDACTED = "<redacted>";
const EXPLICIT_SECRET_ENV_NAMES = new Set([
  "OPENCODE_SERVER_PASSWORD",
  "OPENWORK_HOST_TOKEN",
  "OPENWORK_TOKEN",
  "LRM_API_KEY",
  "LRM_EMBEDDING_API_KEY",
  "OTEL_EXPORTER_OTLP_HEADERS",
]);
const SECRET_ENV_NAME_SUFFIX = /_(?:TOKEN|API_KEY|PASSWORD)$/;

function sensitiveEnvironmentValues(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const values = new Set<string>();

  for (const [name, value] of Object.entries(environment)) {
    if (!value) continue;
    if (EXPLICIT_SECRET_ENV_NAMES.has(name) || SECRET_ENV_NAME_SUFFIX.test(name)) {
      values.add(value);
    }
  }

  return [...values].sort((left, right) => right.length - left.length);
}

function redactSensitiveEnvironmentValues(
  text: string,
  secretValues: readonly string[],
): string {
  let redacted = text;
  for (const value of secretValues) {
    redacted = redacted.replaceAll(value, REDACTED);
  }
  return redacted;
}

export const SuperclawToolOutputRedactor: Plugin = async ({ client }) => {
  const secretValues = sensitiveEnvironmentValues();

  await client.app.log({
    body: {
      service: "superclaw-tool-output-redactor",
      level: "info",
      message: `Plugin initialised; protecting ${secretValues.length} sensitive environment values`,
    },
  });

  return {
    "tool.execute.after": async (_input: unknown, output: { output?: unknown; title?: unknown }) => {
      if (typeof output.output === "string") {
        output.output = redactSensitiveEnvironmentValues(output.output, secretValues);
      }
      if (typeof output.title === "string") {
        output.title = redactSensitiveEnvironmentValues(output.title, secretValues);
      }
    },
  };
};

// The helpers ride on the plugin function rather than being exports of their own: opencode loads
// every export of a plugin module as a plugin and invokes a bare helper export as a factory.
export default Object.assign(SuperclawToolOutputRedactor, {
  sensitiveEnvironmentValues,
  redactSensitiveEnvironmentValues,
});
