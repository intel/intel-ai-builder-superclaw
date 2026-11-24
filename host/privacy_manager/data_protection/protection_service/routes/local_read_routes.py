"""Host-side read of sensitive/ files for local-file-agent.

Allowed only when Protection is OFF (mode "none") or the user declined the
confirmation dialog (short-lived grant). The file is read as the host user, so
the sandbox ACL deny on sensitive/ is not bypassed or loosened. File types and
readers are the same ones the protected-file pipeline uses.
"""

from __future__ import annotations

import logging
import os
import secrets
import tempfile
import time
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from file_protection.documents import (
    SUPPORTED_DOCUMENT_SUFFIXES,
    _apply_transform,
    check_zip_safety,
)
from file_protection.io import SUPPORTED_INPUT_SUFFIXES, load_table
from protection_service.app_state import ProtectionAppState
from protection_service.constants import WORKSPACE_ROOT
from protection_service.io.source_validation import validate_source_path
from protection_service.io.workspace_paths import resolve_workspace_path_to_host
from protection_service.routes.protect_routes import fetch_file_protection_settings
from protection_service.routes.text_routes import PROCESS_CREDENTIAL_HEADER

logger = logging.getLogger(__name__)

# Under ServiceHub's proxy prefix: the proxy forwards the path unchanged, and only ServiceHub calls it.
GRANT_PATH = "/data-protection/v1/file/local-read/grant"
GRANT_TTL_SECONDS = 600
MAX_ROWS = 500
MAX_TEXT_CHARS = 200_000
DOCX_SUFFIX = ".docx"

class LocalReadRequest(BaseModel):
    source_file_path: str = Field(min_length=1)
    session_id: str | None = None

class GrantRequest(BaseModel):
    session_id: str = Field(min_length=1)

def _sensitive_root() -> Path:
    return (WORKSPACE_ROOT / "sensitive").resolve()

def _inside(candidate: Path, root: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False

def _text_result(text: str) -> dict[str, Any]:
    return {
        "kind": "text",
        "content": text[:MAX_TEXT_CHARS],
        "truncated": len(text) > MAX_TEXT_CHARS,
    }

def _read_table(path: Path) -> dict[str, Any]:
    # force_str=True: preserve ids like leading-zero postcodes, which pandas would
    # otherwise infer as numeric before our own astype(str) below runs.
    df = load_table(path, force_str=True)  # same reader (and xlsx zip-safety check) as the protected pipeline
    head = df.head(MAX_ROWS).fillna("").astype(str)
    return {
        "kind": "table",
        "columns": [str(c) for c in df.columns],
        "rows": head.values.tolist(),
        "total_rows": int(len(df)),
        "truncated": len(df) > MAX_ROWS,
    }

def _read_prose(path: Path) -> dict[str, Any]:
    """txt / md / html via the pipeline's own document walker, collecting text only."""
    segments: list[str] = []

    def collect(text: str) -> str:
        segments.append(text)
        return text

    # _apply_transform always writes a destination file; point it at a throwaway temp dir.
    with tempfile.TemporaryDirectory() as tmp:
        _apply_transform(path, Path(tmp) / f"out{path.suffix}", collect)
    return _text_result("\n".join(segments))


def _read_docx(path: Path) -> dict[str, Any]:
    from docx import Document

    check_zip_safety(path)  # same zip-bomb guard as the pipeline
    doc = Document(str(path))
    lines: list[str] = []

    def walk_paragraphs(paragraphs) -> None:
        lines.extend(p.text for p in paragraphs if p.text.strip())

    def walk_tables(tables) -> None:
        for table in tables:
            for row in table.rows:
                lines.append(" | ".join(cell.text.strip() for cell in row.cells))
                for cell in row.cells:
                    walk_tables(cell.tables)  # nested tables

    for section in doc.sections:
        walk_paragraphs(section.header.paragraphs)
    walk_paragraphs(doc.paragraphs)
    walk_tables(doc.tables)
    for section in doc.sections:
        walk_paragraphs(section.footer.paragraphs)
    return _text_result("\n".join(lines))

def require_grant_credential(request: Request) -> None:
    """Only ServiceHub, relaying the user's Deny from the App, may open a grant (#3665).

    Fails closed when no process credential is configured (a standalone run).
    """
    expected = getattr(request.app.state, "process_credential", "")
    supplied = request.headers.get(PROCESS_CREDENTIAL_HEADER, "")
    # bytes: compare_digest raises TypeError on a str with non-ASCII characters, which would be a 500
    if not expected or not secrets.compare_digest(expected.encode(), supplied.encode()):
        raise HTTPException(status_code=403, detail="local_read_grant_forbidden")


async def _fetch_mode_or_none_on_failure() -> str | None:
    """Return the applied protection mode, or None if the LRM lookup failed.

    fetch_file_protection_settings() falls back to DEFAULT_PROTECTION_MODE
    ("none") on any lookup failure, which this caller must not conflate with a
    confirmed-off setting.
    """
    try:
        mode, _ = await fetch_file_protection_settings()
        return mode
    except Exception:
        return None

def register_local_read_routes(app: FastAPI, state: ProtectionAppState) -> None:
    """Register /v1/file/local-read and the ServiceHub-only grant at GRANT_PATH."""
    config = state.config
    auth_dep = state.auth_dep
    grant_expires_at = 0.0
    # Sessions whose user actually declined protection in the confirmation dialog.
    # PRIVACY_API_KEY is in the runtime's environment, so it alone must not be
    # enough to open a read window: the grant takes the process credential, which
    # only ServiceHub holds, and no data-plane key (its proxy strips Authorization).
    declined_sessions: set[str] = set()

    @app.post(
        GRANT_PATH,
        dependencies=[Depends(require_grant_credential)],
        tags=["file"],
    )
    async def grant_local_read(req: GrantRequest) -> dict[str, bool]:
        """Record that the user declined protection for this session; opens a short read window."""
        nonlocal grant_expires_at
        declined_sessions.add(req.session_id)
        grant_expires_at = time.monotonic() + GRANT_TTL_SECONDS
        logger.info("local_read grant opened ttl_s=%s session=%s", GRANT_TTL_SECONDS, req.session_id)
        return {"success": True}

    @app.post("/v1/file/local-read", dependencies=[Depends(auth_dep)], tags=["file"])
    async def local_read(req: LocalReadRequest) -> dict[str, Any]:
        mode = await _fetch_mode_or_none_on_failure()
        has_grant = (
            req.session_id is not None
            and req.session_id in declined_sessions
            and time.monotonic() < grant_expires_at
        )
        # mode is None when the LRM lookup failed; refuse rather than defaulting to allow.
        if mode != "none" and not has_grant:
            raise HTTPException(
                status_code=403,
                detail={"error": "local_read_not_permitted",
                        "message": "Protection is on and the user has not declined it."},
            )

        host_path = resolve_workspace_path_to_host(req.source_file_path)
        lexical = Path(os.path.abspath(os.path.expanduser(host_path)))
        resolved = validate_source_path(req.source_file_path, config.redact)
        root = _sensitive_root()
        if not (_inside(lexical, root) and _inside(resolved, root)):
            raise HTTPException(
                status_code=400,
                detail={"error": "outside_sensitive_folder",
                        "message": "Only files inside sensitive/ can be read here."},
            )

        suffix = resolved.suffix.lower()
        if suffix in SUPPORTED_INPUT_SUFFIXES:
            body = await run_in_threadpool(_read_table, resolved)
        elif suffix == DOCX_SUFFIX:
            body = await run_in_threadpool(_read_docx, resolved)
        elif suffix in SUPPORTED_DOCUMENT_SUFFIXES:
            body = await run_in_threadpool(_read_prose, resolved)
        else:
            raise HTTPException(
                status_code=415,
                detail={"error": "unsupported_type",
                        "message": f"{suffix or 'this file type'} is not supported."},
            )

        logger.info("local_read ok session=%s name=%s kind=%s truncated=%s",
                    req.session_id, resolved.name, body["kind"], body["truncated"])
        return {"success": True, "source_file_path": req.source_file_path, **body}