import type { ApiErrorBody } from "./types.js";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// A Basic-challenged 401 is the OpenCode runtime rejecting openwork-server's credential, not the UI
// token; passed through, it reads as a stale UI token and can raise a native webview credential prompt.
// Endpoint-level 401s (e.g. PTY connect tokens) carry no Basic challenge and pass through.
export function throwIfRuntimeCredentialRejected(response: Response, path: string): void {
  if (response.status === 401 && /^basic\b/i.test(response.headers.get("www-authenticate") ?? "")) {
    response.body?.cancel().catch(() => {});
    throw new ApiError(
      502,
      "opencode_runtime_auth_failed",
      "The OpenCode runtime rejected openwork-server's credential",
      { path },
    );
  }
}

export function throwIfIntentClassifierCredentialRejected(response: Response, path: string): void {
  if (response.status === 401) {
    response.body?.cancel().catch(() => {});
    throw new ApiError(
      502,
      "intent_classifier_auth_failed",
      "The intent classifier rejected openwork-server's credential",
      { path },
    );
  }
}

export function formatError(err: ApiError): ApiErrorBody {
  return {
    code: err.code,
    message: err.message,
    details: err.details,
  };
}
