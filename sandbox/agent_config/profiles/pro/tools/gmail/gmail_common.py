"""
Shared utilities for the Gmail email agent modules.

Consolidates credential management, HTTP adapter, service builder,
body decoding, and text cleaning that were previously duplicated across
email_sync.py, email_send.py, and email_pipeline.py.
"""

from __future__ import annotations

import base64
import json
import os
import re
import time
from pathlib import Path

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import AuthorizedSession, Request
from googleapiclient.discovery import build
from googleapiclient.http import HttpRequest


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/userinfo.profile",
]

SUPPORTED_INBOX_CATEGORY_LABELS = frozenset(
    {"CATEGORY_PERSONAL", "CATEGORY_UPDATES"}
)
SUPPORTED_INBOX_QUERY = "{category:primary category:updates}"


def is_supported_inbox_message(label_ids: list[str]) -> bool:
    labels = set(label_ids)
    return "INBOX" in labels and bool(labels & SUPPORTED_INBOX_CATEGORY_LABELS)


def supported_inbox_query(query: str = "") -> str:
    return f"{query.strip()} {SUPPORTED_INBOX_QUERY}".strip()


# ---------------------------------------------------------------------------
# HTTP Adapter (makes AuthorizedSession compatible with googleapiclient)
# ---------------------------------------------------------------------------


class RequestsAdapter:
    """Adapter to make AuthorizedSession compatible with googleapiclient."""

    def __init__(self, session):
        self.session = session

    def request(self, url, method="GET", body=None, headers=None, **kwargs):
        response = self.session.request(
            method=method, url=url, data=body, headers=headers, **kwargs
        )
        return RequestsResponse(response), response.content


class RequestsResponse:
    """Wraps requests.Response to look like an httplib2 response."""

    def __init__(self, response):
        self.status = response.status_code
        self.reason = response.reason
        self._response = response

    def __getitem__(self, key):
        return self._response.headers.get(key)

    def get(self, key, default=None):
        return self._response.headers.get(key, default)


# ---------------------------------------------------------------------------
# Service Builder
# ---------------------------------------------------------------------------


def build_google_service(api_name: str, version: str, creds: Credentials):
    """Build a Google API service using a requests-based HTTP adapter."""
    # egress-surface: gmail_google_apis
    session = AuthorizedSession(creds)
    adapter = RequestsAdapter(session)

    def build_request(http, *args, **kwargs):
        return HttpRequest(adapter, *args, **kwargs)

    # egress-surface: gmail_google_apis
    return build(api_name, version, credentials=creds, requestBuilder=build_request)


# ---------------------------------------------------------------------------
# Credential Management
# ---------------------------------------------------------------------------

GMAIL_PAUSED_MESSAGE = (
    "Gmail is paused in SuperClaw. Turn Gmail back on in Connections to use it; "
    "nothing needs to be set up again."
)


def gmail_paused(token_file: Path | str) -> bool:
    """True while the user has paused Gmail from Connections: the token is kept beside it as token.json.paused.

    A refresh that was in flight when the user paused can write token.json again; Gmail stays paused.
    """
    token_path = Path(token_file)
    return token_path.with_name(f"{token_path.name}.paused").exists()


def raise_if_paused(token_file: Path | str) -> None:
    if gmail_paused(token_file):
        raise RuntimeError(GMAIL_PAUSED_MESSAGE)


def save_credentials(creds: Credentials, token_file: Path | str) -> None:
    """Persist Google OAuth credentials to token.json atomically.

    Preserves the refresh_token from the existing file if the new credentials
    object doesn't include one (common after a token refresh).
    """
    token_path = Path(token_file)
    token_data = json.loads(creds.to_json())
    if not token_data.get("refresh_token"):
        existing_refresh_token = read_existing_refresh_token(token_path)
        if existing_refresh_token:
            token_data["refresh_token"] = existing_refresh_token
    write_json_atomic(token_path, token_data)


def read_existing_refresh_token(token_file: Path | str) -> str | None:
    """Read the refresh_token from an existing token.json file."""
    try:
        return json.loads(Path(token_file).read_text()).get("refresh_token")
    except Exception:
        return None


def write_json_atomic(path: Path | str, data: dict) -> None:
    """Write a JSON file atomically using a temp file + rename."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f"{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        temp_path.write_text(json.dumps(data), encoding="utf-8")
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Body Decoding
# ---------------------------------------------------------------------------


def decode_gmail_body(payload: dict) -> str:
    """Recursively extract plain-text body from a Gmail API message payload.

    Preference order: text/plain > text/html (stripped) > empty string.
    """
    mime_type = payload.get("mimeType", "")
    body_data = payload.get("body", {}).get("data")

    if mime_type == "text/plain" and body_data:
        return base64.urlsafe_b64decode(body_data).decode("utf-8", errors="replace")

    if mime_type.startswith("multipart"):
        for part in payload.get("parts", []):
            result = decode_gmail_body(part)
            if result:
                return result

    if mime_type == "text/html" and body_data:
        html = base64.urlsafe_b64decode(body_data).decode("utf-8", errors="replace")
        return strip_html(html)

    return ""


def strip_html(html: str) -> str:
    """Lightweight HTML-to-text: remove tags and decode common entities."""
    text = re.sub(
        r"<style[^>]*>.*?</style>", " ", html, flags=re.DOTALL | re.IGNORECASE
    )
    text = re.sub(
        r"<script[^>]*>.*?</script>", " ", text, flags=re.DOTALL | re.IGNORECASE
    )
    text = re.sub(r"<[^>]+>", " ", text)
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
    )
    return text


# ---------------------------------------------------------------------------
# Text Cleaning
# ---------------------------------------------------------------------------


def clean_body_text(text: str) -> str:
    """Normalize whitespace in body text (collapse newlines/tabs/spaces)."""
    if not text:
        return ""
    text = re.sub(r"[\r\n\t]+", " ", text)
    return re.sub(r" +", " ", text).strip()
