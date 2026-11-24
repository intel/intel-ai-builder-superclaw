# Dockerfile for hybrid_dr_orchestrator sidecar.
#
# Standalone image only used during local development / CI. In production
# the sidecar gets baked into the SuperClaw backend image via a COPY in
# packaging/docker/Dockerfile.backend that pulls in this whole tree at
# /opt/hdr_sidecar/ and installs it into the orchestrator-managed venv
# (see docs/INTEGRATION.md for the SuperClaw side).

FROM python:3.11-slim AS base

WORKDIR /opt/hybrid_dr_orchestrator

# System deps: nothing beyond what python:3.11-slim provides. uv is the
# fastest installer we have available, but we fall back to pip when uv is
# not present to keep the local-dev image self-contained.
RUN python -m pip install --no-cache-dir --upgrade pip

COPY pyproject.toml ./
COPY src ./src

RUN python -m pip install --no-cache-dir .

EXPOSE 18324

ENV HYBRID_DR_LLMROUTER_URL=http://127.0.0.1:18321 \
    HYBRID_DR_SESSION_ROOT=/workspace/deep-research-workspaces/sessions \
    PYTHONUNBUFFERED=1

# uvicorn entry: make_app() with default deps (HTTPLLMClient + Tavily).
CMD ["python", "-m", "uvicorn", \
     "hybrid_dr_orchestrator.api.serve:make_app", \
     "--factory", \
     "--host", "0.0.0.0", \
     "--port", "18324"]
