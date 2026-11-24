/** Markdown prefill when the target repo has no `bug.yml` issue template. */
export function buildBugReportBodyMarkdown(options: {
  shortDescription?: string;
  additionalDetails?: string;
}): string {
  const short = options.shortDescription?.trim() ?? "";
  const extra = options.additionalDetails?.trim() ?? "";

  const lines = short
    ? ["## Short Description", "", short, ""]
    : ["## Short Description", "", ""];

  lines.push(
    "## Steps to Reproduce",
    "<!-- What were you doing when this happened? -->",
    "",
    "## Expected Behavior",
    "",
    "",
    "## Actual Behavior",
    "",
    "",
    "## CPU info, memory size and GPU info",
    "",
    "",
    "## Additional Details",
  );

  if (extra) {
    lines.push(extra);
  }
  return lines.join("\n");
}
