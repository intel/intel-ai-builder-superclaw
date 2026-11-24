export type BackendBootPhase = "init" | "install" | "container" | "models" | "ready";

export type BackendBootStageInfo = {
  phase: BackendBootPhase;
  title: string;
  description: string;
};

export type BackendRetryAction =
  | "wait"
  | "restart-backend-manager"
  | "provision-system"
  | "refresh-token"
  | "provision-inference";

export type BackendRetryPolicy = {
  action: BackendRetryAction;
  label: string;
};

export type BackendBootSnapshotLike = {
  ready: boolean;
  stage: string | null;
  message: string | null;
  pct: number | null;
  error: string | null;
  readyPayload: unknown | null;
};

export type RecoverableBootSnapshot = {
  stage: string;
  message: string | null;
  pct: number | null;
  error: string | null;
};

export function getRecoverableBootSnapshot(
  snap: BackendBootSnapshotLike,
): RecoverableBootSnapshot | null {
  if (snap.ready) return null;
  if (!snap.stage) return null;
  if (snap.stage === "skipped") return null;
  return {
    stage: snap.stage,
    message: snap.message,
    pct: snap.pct,
    error: snap.error,
  };
}

export function describeBackendBootStage(stage: string | null): BackendBootStageInfo {
  const s = stage ?? "";

  if (s === "reuse.probing") {
    return {
      phase: "init",
      title: "Connecting to Existing Service",
      description: "Checking whether the previous SuperClaw backend is still responsive…",
    };
  }

  if (s === "" || s === "initializing") {
    return {
      phase: "init",
      title: "Starting SuperClaw",
      description: "Launching the local SuperClaw service…",
    };
  }
  if (s === "retrying") {
    return {
      phase: "init",
      title: "Retrying",
      description: "Attempting to start the SuperClaw service again…",
    };
  }
  if (s === "local_llm_skipped") {
    return {
      phase: "models",
      title: "Local Model Skipped",
      description: "Host hardware does not qualify for local LLM — configure an edge model in Settings.",
    };
  }
  if (s === "ready") {
    return {
      phase: "ready",
      title: "SuperClaw Ready",
      description: "Connecting to your workspace…",
    };
  }
  if (s === "handshake.complete") {
    return {
      phase: "init",
      title: "Handshake Complete",
      description: "SuperClaw is online — checking system status…",
    };
  }
  if (s.startsWith("handshake.")) {
    return {
      phase: "init",
      title: "Waiting for SuperClaw Service",
      description: "Establishing connection with SuperClaw service…",
    };
  }
  if (s.startsWith("reuse.stale")) {
    return {
      phase: "init",
      title: "Recovering SuperClaw Service",
      description: "Existing SuperClaw service was unresponsive — restarting it…",
    };
  }
  if (s === "status.ready") {
    return {
      phase: "container",
      title: "Container Running",
      description: "Sandbox container is ready — obtaining token…",
    };
  }
  if (s === "status.unreachable") {
    return {
      phase: "container",
      title: "Checking Backend Services",
      description: "SuperClaw is online, but system status is temporarily unreachable…",
    };
  }
  if (s === "sandbox.stopped") {
    return {
      phase: "container",
      title: "Sandbox Stopped",
      description: "The sandbox is not running. Retry will restart backend services…",
    };
  }
  if (s === "sandbox.error") {
    return {
      phase: "container",
      title: "Sandbox Needs Recovery",
      description: "The sandbox container reported an error. Retry will reprovision backend services…",
    };
  }
  if (s === "owt.fetching") {
    return {
      phase: "container",
      title: "Obtaining Token",
      description: "Fetching workspace access token…",
    };
  }
  if (s.startsWith("operation.")) {
    return describeOperation(s.slice("operation.".length));
  }
  return {
    phase: "init",
    title: "Starting SuperClaw",
    description: s || "Working…",
  };
}

export function getBackendRetryPolicy(stage: string | null): BackendRetryPolicy {
  const s = stage ?? "";

  if (s === "reuse.probing" || s === "reuse.stale.recovering") {
    return { action: "wait", label: "Waiting" };
  }

  if (
    s.startsWith("reuse.") ||
    s.startsWith("handshake.") ||
    s.startsWith("spawn.") ||
    s === "error"
  ) {
    return { action: "restart-backend-manager", label: "Restart Backend" };
  }

  if (s === "owt.failed") {
    return { action: "refresh-token", label: "Refresh Token" };
  }
  if (s === "owt.stale") {
    return { action: "refresh-token", label: "Refresh Token" };
  }

  if (
    s === "boot.timeout" ||
    s === "status.unreachable" ||
    s === "sandbox.stopped" ||
    s === "sandbox.error" ||
    s === "status.ready" ||
    s.startsWith("operation.sandbox")
  ) {
    return { action: "provision-system", label: "Retry Backend Services" };
  }

  if (
    s.startsWith("operation.model") ||
    s.startsWith("operation.server_start") ||
    s.startsWith("operation.model_server")
  ) {
    return { action: "provision-inference", label: "Retry Model Services" };
  }

  return { action: "restart-backend-manager", label: "Retry" };
}

function describeOperation(kind: string): BackendBootStageInfo {
  switch (kind) {
    case "sandbox.install":
      return {
        phase: "install",
        title: "Installing SuperClaw Service",
        description: "Setting up the local sandbox environment…",
      };
    case "sandbox.control":
      return {
        phase: "container",
        title: "Configuring Sandbox",
        description: "Applying sandbox runtime configuration…",
      };
    case "sandbox.ensure_ready":
      return {
        phase: "container",
        title: "Preparing Sandbox",
        description: "Waiting for the sandbox to become ready…",
      };
    case "sandbox.owt_issue":
      return {
        phase: "container",
        title: "Issuing Access Token",
        description: "Provisioning a session token for the sandbox…",
      };
    case "model_download":
      return {
        phase: "models",
        title: "Downloading Model",
        description: "Fetching model weights from HuggingFace…",
      };
    case "model_verify":
      return {
        phase: "models",
        title: "Verifying Model",
        description: "Checking integrity of model files…",
      };
    case "server_start":
    case "model_server.ensure_ready":
      return {
        phase: "models",
        title: "Starting Inference Server",
        description: "Loading the model into the inference runtime…",
      };
    default:
      return {
        phase: "init",
        title: humanizeKind(kind),
        description: "Working…",
      };
  }
}

function humanizeKind(kind: string): string {
  return kind.replace(/[_.]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
