import { tool } from "@opencode-ai/plugin"

declare const process: { env: Record<string, string | undefined> };

/**
 * Sends a file-protection request to the host data_protection sidecar service.
 *
 * With a single `source_file_path` it posts to /v1/file/protect. With
 * `source_file_paths` (2+ files) it posts to /v1/file/protect/batch instead,
 * so multiple files can be masked in one call and handed to `build` together.
 * The backend reads the current llmrouter mode/threshold settings and decides
 * the protection mode (none / deterministic / hybrid / llm) per file.
 *
 * Single-file backend response shape:
 * { success, message, source_file_path, masked_file_path, final_answer, error?, resolved_by? }
 * Batch backend response shape: { results: [ <one of the above per file> ] }
 */

type ProtectionResolver = "llm" | "dps" | "none";
type ReviewContext = { ask?: (opts: any) => Promise<void> };

type MaskingSummary = {
    entity_count: number;
    categories: Array<{ category: string; count: number }>;
};

type ProtectedFilePipelineResult = {
    success: boolean;
    message: string;
    source_file_path?: string;
    masked_file_path?: string | null;
    operation_id?: string | null;
    operation_session_id?: string | null;
    final_answer?: unknown;
    error?: unknown;
    // Provenance for debugging and telemetry; dps means data protection service.
    resolved_by?: ProtectionResolver;
    masking_summary?: MaskingSummary | null;
};

type ProtectedFilePipelineBatchResult = {
    success: boolean;
    message: string;
    results: ProtectedFilePipelineResult[];
    error?: unknown;
};

const REQUEST_TIMEOUT_MS = 240_000; // 4 minutes
const DEFAULT_DATA_PROTECTION_HOST = "127.0.0.1";
const DEFAULT_DATA_PROTECTION_PORT = "18826";
const FILE_PROTECT_PATH = "/v1/file/protect";
const FILE_PROTECT_BATCH_PATH = "/v1/file/protect/batch";
const FILE_PROTECT_SUMMARY_PATH = "/v1/file/protect/summary";

function buildPipelineEndpointUrl(path: string): string {
    const host = process.env.DATA_PROTECTION_HOST ?? DEFAULT_DATA_PROTECTION_HOST;
    const port = process.env.DATA_PROTECTION_PORT ?? DEFAULT_DATA_PROTECTION_PORT;
    return `http://${host}:${port}${path}`;
}

/**
 * Words the user added during review are masked after the pipeline's own summary was computed,
 * so re-read the aggregate counts. Only counts are kept; the summary endpoint returns no values.
 */
async function refreshMaskingSummaries(
    operations: Array<{ operation_id?: string | null; operation_session_id?: string | null; masking_summary?: MaskingSummary | null }>,
): Promise<void> {
    const apiKey = process.env.PRIVACY_API_KEY?.trim();
    if (!apiKey) return;
    await Promise.all(
        operations.map(async (op) => {
            try {
                // egress-surface: data_protection_file_pipeline
                const response = await fetch(buildPipelineEndpointUrl(FILE_PROTECT_SUMMARY_PATH), {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
                    body: JSON.stringify({ session_id: op.operation_session_id, operation_id: op.operation_id }),
                    signal: AbortSignal.timeout(10_000),
                });
                if (!response.ok) return;
                const body = (await response.json()) as { masking_summary?: MaskingSummary | null };
                if (body.masking_summary) op.masking_summary = body.masking_summary;
            } catch {
                // Keep the summary from the original run.
            }
        }),
    );
}
/**
 * Pause before the masked file reaches the analysis model so the user can review what was
 * masked and add words the pipeline missed. The UI fetches the entity values and submits the
 * extra words straight to the data_protection sidecar, so no original value enters model context.
 * Returns null once the user continues; otherwise a fail-closed STOP message.
 */
async function reviewMaskedOutput(
    context: ReviewContext,
    operations: Array<{ operation_id?: string | null; operation_session_id?: string | null; source_file_path?: string; masked_file_path?: string | null; masking_summary?: MaskingSummary | null }>,
): Promise<string | null> {
    const reviewable = operations.filter((op) => op.operation_id && op.masked_file_path);
    if (reviewable.length === 0) return null;
    const stop =
        "MASKING REVIEW NOT CONFIRMED. The user did not confirm the masked file, so it must NOT be analyzed. " +
        "STOP now. DO NOT invoke the Build agent. Tell the user in one sentence that the review was cancelled.";
    if (typeof context.ask !== "function") return stop;
    try {
        await context.ask({
            permission: "review_masked_entities",
            patterns: reviewable.map((op) => op.masked_file_path as string),
            always: [],
            metadata: {
                operations: reviewable.map((op) => ({
                    operation_id: op.operation_id,
                    operation_session_id: op.operation_session_id ?? null,
                    source_file_path: op.source_file_path ?? null,
                })),
            },
        });
        await refreshMaskingSummaries(reviewable);
        return null;
    } catch {
        return stop;
    }
}

/**
 * When the backend answers 503 pii_model_not_ready, say why in words: the privacy models are
 * downloaded in the background after install, and a user cannot tell that from a real failure.
 * Only the error code, the state and the byte counts are read from the body; nothing else in it
 * is passed on.
 */
function privacyModelsNotReady(responseBody: string): string | null {
    try {
        const detail = (JSON.parse(responseBody) as { detail?: Record<string, unknown> }).detail;
        if (detail?.error !== "pii_model_not_ready") {
            return null;
        }
        const state = typeof detail.models_state === "string" ? detail.models_state : "unknown";
        // A failed download, or an installed model whose NER did not load, will not fix itself in
        // a few minutes; only the states below are still on their way to ready.
        if (!["pending", "downloading", "verifying", "activating"].includes(state)) {
            return null;
        }
        const done = Number(detail.models_done_bytes);
        const total = Number(detail.models_total_bytes);
        const progress = total > 0 ? `, ${Math.min(100, Math.floor((done / total) * 100))}% downloaded` : "";
        return `the privacy models are not ready yet (state: ${state}${progress}).`;
    } catch {
        return null;
    }
}

/** Fail closed: never mask a file that is itself a pipeline output. */
function isDerivedOutputPath(sourceFilePath: string): boolean {
    const normalizedSource = sourceFilePath.replace(/\\/g, "/");
    return (
        /data_protection_workspace\/masked_datasets\//i.test(normalizedSource) ||
        /_masked\.[A-Za-z0-9]+$/i.test(normalizedSource)
    );
}

export default tool({
    description: "Masks sensitive data in one or more files and returns safe masked versions for downstream analysis. Supports tabular files (.csv, .xlsx, .xls, .parquet) and documents (.txt, .md, .html, .htm, .docx). Pass `source_file_path` for a single file, or `source_file_paths` for multiple files in one request. Returns JSON: { success, masked_file_path, final_answer, error } for a single file, or { success, results: [...] } for multiple. Always check `success` (and each result's `success`) before using a `masked_file_path` — if false, do NOT proceed with analysis and report the error to the user.",
    args: {
        source_file_path: tool.schema
            .string()
            .optional()
            .describe("Absolute path to a single source file to process (e.g. /workspace/data.csv). Use this OR source_file_paths, not both. Extract the exact path from the user request -- do not pass the full request string."),
        source_file_paths: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Absolute paths to two or more source files to protect in one call. Use this when the request involves more than one protected-pipeline file, instead of calling this tool multiple times."),
    },

    async execute(args, context): Promise<string> {
        const sessionId = context?.sessionID ?? null;
        const reviewContext = context ?? {};
        const singlePath = args.source_file_path?.trim() ?? "";
        const multiplePaths = (args.source_file_paths ?? [])
            .map((p) => p.trim())
            .filter((p) => p.length > 0);

        // A weak model routinely fills BOTH args for one request. Protecting the
        // union is never less safe than protecting a subset, and rejecting here
        // burns the terminal guard's single-call budget, stranding the session
        // with nothing masked — so resolve the overlap instead of failing.
        const requestedPaths = [...new Set(singlePath.length > 0 ? [singlePath, ...multiplePaths] : multiplePaths)];
        const [firstPath] = requestedPaths;

        if (!firstPath) {
            return JSON.stringify({
                success: false,
                message: "The protected file pipeline requires a non-empty source_file_path or source_file_paths.",
                error: "empty_source_file_path",
            } satisfies ProtectedFilePipelineResult);
        }

        if (requestedPaths.length > 1) {
            return executeBatch(requestedPaths, sessionId, reviewContext);
        }

        return executeSingle(firstPath, sessionId, reviewContext);
    },
});

async function executeSingle(sourceFilePath: string, sessionId: string | null, context: ReviewContext): Promise<string> {
        if (isDerivedOutputPath(sourceFilePath)) {
            return JSON.stringify({
                success: false,
                message: "This file is already a protected/masked output, not an original input. STOP now. DO NOT run protection on it. If you already have a masked file, proceed to analyze it directly.",
                error: "source_is_derived_output",
                source_file_path: sourceFilePath,
            } satisfies ProtectedFilePipelineResult);
        }

        const apiKey = process.env.PRIVACY_API_KEY?.trim();
        if (!apiKey) {
            return JSON.stringify({
                success: false,
                message: "PROTECTION FAILED. The Privacy credential is unavailable. STOP now. DO NOT proceed to the next actions. Report the error directly to the user.",
                error: "privacy_credential_unavailable",
            } satisfies ProtectedFilePipelineResult);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            // Post the source file path and session id to the data_protection service's /v1/file/protect endpoint.
            // egress-surface: data_protection_file_pipeline
            const response = await fetch(buildPipelineEndpointUrl(FILE_PROTECT_PATH), {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({
                    source_file_path: sourceFilePath,
                    session_id: sessionId,
                }),
                signal: controller.signal,
            });
            const responseBody = await response.text();

            // If the backend returned a non-OK status, ask the agent to stop and report the error to the user. 
            if (!response.ok) {
                // 413 means the file exceeds ``max_source_bytes``, so the same file can never succeed.
                const tooLarge = response.status === 413;
                const notReady = response.status === 503 ? privacyModelsNotReady(responseBody) : null;
                return JSON.stringify({
                    success: false,
                    message: tooLarge
                       ? "PROTECTION FAILED. The file is too large to be protected. STOP now. DO NOT proceed to the next actions. DO NOT invoke the Build agent. DO NOT fall back to anything. Report the error directly to the user and ask them to retry the request with a smaller file."
                       : notReady
                       ? `PROTECTION FAILED. The file was NOT protected because ${notReady} The privacy models are downloaded in the background after install and this takes a few minutes. STOP now. DO NOT proceed to the next actions. DO NOT invoke the Build agent. Report to the user that the privacy models are still being set up, and ask them to retry the request in a few minutes.`
                       : "PROTECTION FAILED. The file was NOT protected. STOP now. DO NOT proceed to the next actions. DO NOT invoke the Build agent. Report the error directly to the user and ask them to retry the request.",

                    error: {
                        status: response.status,
                        detail: tooLarge
                            ? "Backend returned a 413 Payload Too Large response; raw response body was redacted."
                            : notReady
                            ? "Backend returned 503 pii_model_not_ready; the privacy models are not ready."
                            : "Backend returned a non-OK response; raw response body was redacted.",

                    },
                } satisfies ProtectedFilePipelineResult);
            }
            try {
                const parsed = JSON.parse(responseBody) as ProtectedFilePipelineResult;
                parsed.operation_session_id = sessionId;

                // Fail closed: if protection "succeeded" but produced no masked file, never fall back to the unprotected source that would leak real PII to the analysis step.
                if (parsed.success && !parsed.masked_file_path) {
                    if (!parsed.final_answer) {
                        return JSON.stringify({
                            success: false,
                            message: "PROTECTION INCOMPLETE. The backend reported success but returned no masked file, so the file is NOT safe to analyze. STOP now. DO NOT analyze the original file. Report the error to the user and ask them to retry the request.",
                            error: "masked_file_path_missing_despite_success",
                        } satisfies ProtectedFilePipelineResult);
                    }
                }

                // Proceed to file analysis with the masked file path if protection succeeded and produced a masked file.
                if (parsed.success && parsed.masked_file_path) {
                    const reviewStop = await reviewMaskedOutput(context, [parsed]);
                    if (reviewStop) {
                        return JSON.stringify({
                            success: false,
                            message: reviewStop,
                            error: "masking_review_not_confirmed",
                            source_file_path: sourceFilePath,
                        } satisfies ProtectedFilePipelineResult);
                    }
                    parsed.message =
                        "FILE PROTECTION COMPLETE." +
                        " DO NOT call confirm_file_protection again." +
                        " DO NOT call run_protected_file_pipeline again." +
                        " DO NOT invoke protected-file-agent for this file again." +
                        " You MUST proceed immediately to Step 3 analysis: call task(subagent_type='build') with " +
                        "the user's original analysis request and masked_file_path=" +
                        parsed.masked_file_path +
                        ". Record operation_id and operation_session_id for Step 4.";
                    if (parsed.final_answer) {
                        parsed.message +=
                            " The final_answer is a protection summary only; do not treat it as the user's requested analysis. Continue to Step 3 with the masked file.";
                    }
                }
                return JSON.stringify(parsed);
            } catch {
                // Failed to parse JSON response
            }
            return responseBody;
        } catch (error) {

            if (error instanceof DOMException && error.name === "AbortError") {
                return JSON.stringify({
                    success: false,
                    message: "PROTECTION TIMED OUT. The file was NOT protected. STOP now. DO NOT proceed to the next actions. Report the timeout error directly to the user and ask them to retry the request.",
                    error: { code: "request_timeout", timeout_ms: REQUEST_TIMEOUT_MS },
                } satisfies ProtectedFilePipelineResult);
            }
            return JSON.stringify({
                success: false,
                message: "PROTECTION FAILED. The file was NOT protected. STOP now. DO NOT proceed to the next actions. Report the error directly to the user and ask them to retry the request.",
                error: error instanceof Error ? error.message : String(error),
            } satisfies ProtectedFilePipelineResult);
        } finally {
            clearTimeout(timer);
        }
}

async function executeBatch(sourceFilePaths: string[], sessionId: string | null, context: ReviewContext): Promise<string> {
        const derived = sourceFilePaths.filter(isDerivedOutputPath);
        if (derived.length > 0) {
            return JSON.stringify({
                success: false,
                message: `These files are already protected/masked outputs, not original inputs: ${derived.join(", ")}. STOP now. DO NOT run protection on them.`,
                error: "source_is_derived_output",
                results: [],
            } satisfies ProtectedFilePipelineBatchResult);
        }

        const apiKey = process.env.PRIVACY_API_KEY?.trim();
        if (!apiKey) {
            return JSON.stringify({
                success: false,
                message: "PROTECTION FAILED. The Privacy credential is unavailable. STOP now. DO NOT proceed to the next actions. Report the error directly to the user.",
                error: "privacy_credential_unavailable",
                results: [],
            } satisfies ProtectedFilePipelineBatchResult);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            // egress-surface: data_protection_file_pipeline
            const response = await fetch(buildPipelineEndpointUrl(FILE_PROTECT_BATCH_PATH), {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({
                    source_file_paths: sourceFilePaths,
                    session_id: sessionId,
                }),
                signal: controller.signal,
            });
            const responseBody = await response.text();

            if (!response.ok) {
                const notReady = response.status === 503 ? privacyModelsNotReady(responseBody) : null;
                return JSON.stringify({
                    success: false,
                    message: notReady
                        ? `PROTECTION FAILED. None of the files were protected because ${notReady} The privacy models are downloaded in the background after install and this takes a few minutes. STOP now. DO NOT proceed to the next actions. DO NOT invoke the Build agent. Report to the user that the privacy models are still being set up, and ask them to retry the request in a few minutes.`
                        : "PROTECTION FAILED. None of the files were protected. STOP now. DO NOT proceed to the next actions. DO NOT invoke the Build agent. Report the error directly to the user and ask them to retry the request.",
                    error: { status: response.status, detail: "Backend returned a non-OK response; raw response body was redacted." },
                    results: [],
                } satisfies ProtectedFilePipelineBatchResult);
            }

            try {
                const parsedBody = JSON.parse(responseBody) as { results: ProtectedFilePipelineResult[] };
                const results = (parsedBody.results ?? []).map((r) => ({ ...r, operation_session_id: sessionId }));
                const failed = results.filter((r) => !r.success || !r.masked_file_path);
                const succeeded = results.filter((r) => r.success && r.masked_file_path);

                let message: string;
                if (succeeded.length === 0) {
                    message =
                        "PROTECTION FAILED for every file in this batch. STOP now. DO NOT invoke the Build agent. Report the errors directly to the user and ask them to retry.";
                } else {
                    const reviewStop = await reviewMaskedOutput(context, succeeded);
                    if (reviewStop) {
                        return JSON.stringify({
                            success: false,
                            message: reviewStop,
                            error: "masking_review_not_confirmed",
                            results: [],
                        } satisfies ProtectedFilePipelineBatchResult);
                    }
                    const maskedList = succeeded
                        .map((r) => `${r.source_file_path}=${r.masked_file_path}`)
                        .join(", ");
                    message =
                        "FILE PROTECTION COMPLETE for " + succeeded.length + " of " + results.length + " file(s)." +
                        " DO NOT call confirm_file_protection or run_protected_file_pipeline again for these files." +
                        " You MUST proceed immediately to Step 3 analysis: call task(subagent_type='build') ONCE with " +
                        "the user's original analysis request and every masked_file_path listed together: " + maskedList +
                        ". Record each result's operation_id and operation_session_id for Step 4.";
                    if (failed.length > 0) {
                        message +=
                            ` ${failed.length} file(s) FAILED protection and must NOT be analyzed: ` +
                            failed.map((r) => r.source_file_path ?? "unknown").join(", ") +
                            ". Report those failures to the user alongside the analysis of the succeeded files.";
                    }
                }

                return JSON.stringify({
                    success: succeeded.length > 0,
                    message,
                    results,
                } satisfies ProtectedFilePipelineBatchResult);
            } catch {
                return responseBody;
            }
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
                return JSON.stringify({
                    success: false,
                    message: "PROTECTION TIMED OUT. No files were protected. STOP now. Report the timeout error directly to the user and ask them to retry the request.",
                    error: { code: "request_timeout", timeout_ms: REQUEST_TIMEOUT_MS },
                    results: [],
                } satisfies ProtectedFilePipelineBatchResult);
            }
            return JSON.stringify({
                success: false,
                message: "PROTECTION FAILED. No files were protected. STOP now. Report the error directly to the user and ask them to retry the request.",
                error: error instanceof Error ? error.message : String(error),
                results: [],
            } satisfies ProtectedFilePipelineBatchResult);
        } finally {
            clearTimeout(timer);
        }
}
