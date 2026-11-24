"""CORS configuration for llmrouter_manager.

Dev-friendly origin list:

- ``tauri://localhost`` / ``http://tauri.localhost`` — production Tauri webview
- ``http://localhost:5173`` / ``http://127.0.0.1:5173`` — Vite dev server (``pnpm tauri dev`` HMR)

Production hardening (design doc Open Question #2): LRM's CORS likely only
needs to allow ServiceHub's origin once the frontend stops connecting
directly. Tighten when that cutover ships.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware


_ALLOWED_ORIGINS = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]


def install_cors(app: FastAPI) -> None:
    """Attach CORS middleware to the FastAPI app."""
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_ALLOWED_ORIGINS,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        max_age=600,
    )
