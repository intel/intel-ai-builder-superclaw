"""
Gmail Write Operations
======================
Provides send email, reply to email, and send meeting invite capabilities
using the Gmail API and Google Calendar API.
"""

import base64
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request

# The scripts import each other as top-level modules. The Windows-native agent Python
# runs under a ._pth file, which leaves the script directory off sys.path (EG1-8).
sys.path.insert(0, str(Path(__file__).resolve().parent))

from gmail_common import (
    SCOPES,
    build_google_service,
    raise_if_paused,
    save_credentials as _common_save_credentials,
)

# --------------------------------------------------------------------------- #
#  Constants                                                                    #
# --------------------------------------------------------------------------- #

BASE_DIR = Path(__file__).resolve().parent
# Read token/credentials from GMAIL_DATA_DIR; fall back to script dir for local dev.
DATA_DIR = Path(os.environ.get("GMAIL_DATA_DIR") or BASE_DIR)
DATA_DIR.mkdir(parents=True, exist_ok=True)
TOKEN_FILE = str(DATA_DIR / "token.json")
CREDENTIALS_FILE = str(DATA_DIR / "credentials.json")
DB_FILE = DATA_DIR / "gmail.db"


def _open_inbox_db(value_for_error: str) -> sqlite3.Connection:
    """Open the local inbox DB; raise ValueError with actionable context."""
    if not DB_FILE.exists():
        raise ValueError(
            f"Cannot resolve inbox id {value_for_error!r}: local inbox DB not "
            f"found at {DB_FILE}. Run run_email_pipeline to sync the inbox first."
        )
    try:
        return sqlite3.connect(DB_FILE)
    except sqlite3.Error as exc:
        raise ValueError(
            f"Cannot resolve inbox id {value_for_error!r}: SQLite error: {exc}"
        ) from exc


def _resolve_gmail_message_id(value: str) -> str:
    """Translate a digits-only ai_inbox row id into the Gmail message id
    stored in ai_inbox.email_id. Non-digit values pass through unchanged.
    Raises ValueError if a digits-only id cannot be resolved.
    """
    if not value or not value.isdigit():
        return value
    try:
        with _open_inbox_db(value) as conn:
            row = conn.execute(
                "SELECT email_id FROM ai_inbox WHERE id = ?", (int(value),)
            ).fetchone()
    except sqlite3.Error as exc:
        raise ValueError(
            f"Cannot resolve inbox row id {value!r}: SQLite error: {exc}"
        ) from exc
    if not row or not row[0]:
        raise ValueError(
            f"Local inbox row id {value!r} has no matching Gmail message id. "
            "Run run_email_pipeline to refresh the inbox, then retry with "
            "the Gmail message id printed under 'Gmail ID:'."
        )
    return str(row[0])


def lookup_inbox(message_id: str) -> dict:
    """Return sender/subject/recipients for an inbox row, looked up by either
    the numeric ai_inbox row id or the Gmail message id. Used by the email
    write tools to show a meaningful confirmation prompt before sending.
    """
    try:
        gmail_id = _resolve_gmail_message_id(message_id)
        with _open_inbox_db(message_id) as conn:
            row = conn.execute(
                "SELECT email_id, from_name, from_email, subject, "
                "to_recipients, cc_recipients "
                "FROM ai_inbox WHERE email_id = ?",
                (gmail_id,),
            ).fetchone()
    except ValueError as exc:
        return {"success": False, "error": str(exc)}
    except sqlite3.Error as exc:
        return {"success": False, "error": f"SQLite error: {exc}"}

    if not row:
        return {
            "success": False,
            "error": f"No inbox row matches Gmail id {gmail_id!r}.",
        }
    return {
        "success": True,
        "email_id": row[0] or "",
        "from_name": row[1] or "",
        "from_email": row[2] or "",
        "subject": row[3] or "",
        "to_recipients": row[4] or "",
        "cc_recipients": row[5] or "",
    }


# SCOPES is imported from gmail_common.


# --------------------------------------------------------------------------- #
#  Auth helpers                                                                 #
# --------------------------------------------------------------------------- #


def _get_credentials() -> Credentials:
    """Load and refresh credentials from token.json."""
    raise_if_paused(TOKEN_FILE)
    if not Path(TOKEN_FILE).exists():
        raise RuntimeError(
            f"Gmail token file not found: {TOKEN_FILE}\n"
            "Run the OAuth setup flow first (gmail_pipeline.ps1) to authenticate."
        )
    creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
    if creds and creds.refresh_token and (not creds.valid or creds.expired or creds.expiry is None):
        try:
            creds.refresh(Request())
            _common_save_credentials(creds, TOKEN_FILE)
        except Exception as exc:
            raise RuntimeError(
                f"Gmail token is invalid/expired and cannot be refreshed.\n"
                f"Delete '{TOKEN_FILE}' and re-run the OAuth flow."
            ) from exc
    if not creds or not creds.valid:
        raise RuntimeError(
            f"Gmail token is invalid/expired and cannot be refreshed.\n"
            f"Delete '{TOKEN_FILE}' and re-run the OAuth flow."
        )
    return creds


def _build_gmail_service():
    """Build the Gmail API service."""
    creds = _get_credentials()
    return build_google_service("gmail", "v1", creds)


def _build_calendar_service():
    """Build the Google Calendar API service."""
    creds = _get_credentials()
    return build_google_service("calendar", "v3", creds)


def _get_user_email() -> str:
    """Get the authenticated user's email address."""
    service = _build_gmail_service()
    profile = service.users().getProfile(userId="me").execute()
    return profile.get("emailAddress", "")


# --------------------------------------------------------------------------- #
#  Send new email                                                              #
# --------------------------------------------------------------------------- #


def send_email(to: str, subject: str, body: str, cc: str = "", bcc: str = "") -> dict:
    """
    Send a new email via Gmail API.

    Args:
        to: Recipient email address(es), comma-separated for multiple.
        subject: Email subject line.
        body: Email body text.
        cc: Optional CC recipients, comma-separated.
        bcc: Optional BCC recipients, comma-separated.

    Returns:
        Dict with 'success', 'message_id', and 'thread_id' on success,
        or 'success' False and 'error' on failure.
    """
    try:
        service = _build_gmail_service()
        message = MIMEMultipart()
        message["to"] = to
        message["subject"] = subject
        if cc:
            message["cc"] = cc
        if bcc:
            message["bcc"] = bcc
        message.attach(MIMEText(body, "plain"))

        raw = base64.urlsafe_b64encode(message.as_bytes()).decode("utf-8")
        sent = service.users().messages().send(userId="me", body={"raw": raw}).execute()
        return {
            "success": True,
            "message_id": sent.get("id", ""),
            "thread_id": sent.get("threadId", ""),
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# --------------------------------------------------------------------------- #
#  Reply to an email                                                           #
# --------------------------------------------------------------------------- #


def reply_to_email(
    original_message_id: str,
    body: str,
    reply_all: bool = False,
) -> dict:
    """
    Reply to an existing email thread via Gmail API.

    Args:
        original_message_id: The Gmail message ID to reply to.
        body: Reply body text.
        reply_all: If True, reply to all recipients. Otherwise reply only to sender.

    Returns:
        Dict with 'success', 'message_id', and 'thread_id' on success,
        or 'success' False and 'error' on failure.
    """
    try:
        original_message_id = _resolve_gmail_message_id(original_message_id)
    except ValueError as exc:
        return {"success": False, "error": str(exc)}

    try:
        service = _build_gmail_service()

        # Fetch the original message to get headers
        original = (
            service.users()
            .messages()
            .get(
                userId="me",
                id=original_message_id,
                format="metadata",
                metadataHeaders=[
                    "From",
                    "To",
                    "Cc",
                    "Subject",
                    "Message-ID",
                    "References",
                    "In-Reply-To",
                ],
            )
            .execute()
        )

        headers = {
            h["name"].lower(): h["value"]
            for h in original.get("payload", {}).get("headers", [])
        }
        thread_id = original.get("threadId", "")

        # Determine recipients
        from_addr = headers.get("from", "")
        original_to = headers.get("to", "")
        original_cc = headers.get("cc", "")
        subject = headers.get("subject", "")
        message_id = headers.get("message-id", "")
        references = headers.get("references", "")

        if not subject.lower().startswith("re:"):
            subject = f"Re: {subject}"

        # Build reply
        reply = MIMEMultipart()
        reply["subject"] = subject

        if reply_all:
            my_email = _get_user_email()
            # Reply to sender + all original To/Cc, excluding self
            all_recipients = set()
            all_recipients.add(from_addr)
            for addr in original_to.split(","):
                addr = addr.strip()
                if addr and my_email.lower() not in addr.lower():
                    all_recipients.add(addr)
            reply["to"] = ", ".join(all_recipients)
            if original_cc:
                cc_addrs = [
                    a.strip()
                    for a in original_cc.split(",")
                    if a.strip() and my_email.lower() not in a.lower()
                ]
                if cc_addrs:
                    reply["cc"] = ", ".join(cc_addrs)
        else:
            reply["to"] = from_addr

        # Threading headers
        if message_id:
            reply["In-Reply-To"] = message_id
            reply["References"] = f"{references} {message_id}".strip()

        reply.attach(MIMEText(body, "plain"))

        raw = base64.urlsafe_b64encode(reply.as_bytes()).decode("utf-8")
        sent = (
            service.users()
            .messages()
            .send(userId="me", body={"raw": raw, "threadId": thread_id})
            .execute()
        )
        return {
            "success": True,
            "message_id": sent.get("id", ""),
            "thread_id": sent.get("threadId", ""),
            "replied_to": from_addr,
            "subject": subject,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# --------------------------------------------------------------------------- #
#  Send meeting invite                                                         #
# --------------------------------------------------------------------------- #


def send_meeting_invite(
    attendees: list[str],
    subject: str,
    start_time: str,
    duration_minutes: int = 60,
    description: str = "",
    location: str = "",
    timezone: str = "",
) -> dict:
    """
    Create a Google Calendar event and send invitations.

    Args:
        attendees: List of attendee email addresses.
        subject: Meeting title/summary.
        start_time: ISO 8601 datetime string for meeting start (e.g. '2025-01-15T10:00:00').
        duration_minutes: Duration of the meeting in minutes (default 60).
        description: Optional meeting description/agenda.
        location: Optional meeting location or video link.
        timezone: IANA timezone (e.g. 'America/Los_Angeles'). Defaults to local.

    Returns:
        Dict with 'success', 'event_id', 'html_link', and 'start'/'end' on success,
        or 'success' False and 'error' on failure.
    """
    try:
        if not timezone:
            try:
                from tzlocal import get_localzone

                timezone = str(get_localzone())
            except ImportError:
                timezone = "America/Los_Angeles"

        service = _build_calendar_service()

        # Parse start time
        start_dt = datetime.fromisoformat(start_time)
        end_dt = start_dt + timedelta(minutes=duration_minutes)

        event_body = {
            "summary": subject,
            "description": description,
            "location": location,
            "start": {
                "dateTime": start_dt.isoformat(),
                "timeZone": timezone,
            },
            "end": {
                "dateTime": end_dt.isoformat(),
                "timeZone": timezone,
            },
            "attendees": [{"email": email.strip()} for email in attendees],
            "reminders": {
                "useDefault": True,
            },
        }

        event = (
            service.events()
            .insert(calendarId="primary", body=event_body, sendUpdates="all")
            .execute()
        )

        return {
            "success": True,
            "event_id": event.get("id", ""),
            "html_link": event.get("htmlLink", ""),
            "start": event.get("start", {}).get("dateTime", ""),
            "end": event.get("end", {}).get("dateTime", ""),
            "attendees": [a.get("email") for a in event.get("attendees", [])],
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# --------------------------------------------------------------------------- #
#  CLI entrypoint (called by email_pipeline.py via subprocess)                 #
# --------------------------------------------------------------------------- #


def main():
    """CLI dispatcher: accepts JSON commands via stdin or --action argument."""
    import argparse

    parser = argparse.ArgumentParser(description="Gmail write operations")
    parser.add_argument(
        "--action",
        required=True,
        choices=["send_email", "reply_to_email", "send_meeting_invite", "lookup_inbox"],
    )
    parser.add_argument(
        "--params", required=True, help="JSON string with action parameters"
    )
    args = parser.parse_args()

    params = json.loads(args.params)

    if args.action == "send_email":
        result = send_email(
            to=params["to"],
            subject=params["subject"],
            body=params["body"],
            cc=params.get("cc", ""),
            bcc=params.get("bcc", ""),
        )
    elif args.action == "reply_to_email":
        result = reply_to_email(
            original_message_id=params["original_message_id"],
            body=params["body"],
            reply_all=params.get("reply_all", False),
        )
    elif args.action == "send_meeting_invite":
        result = send_meeting_invite(
            attendees=params["attendees"],
            subject=params["subject"],
            start_time=params["start_time"],
            duration_minutes=params.get("duration_minutes", 60),
            description=params.get("description", ""),
            location=params.get("location", ""),
            timezone=params.get("timezone", ""),
        )
    elif args.action == "lookup_inbox":
        result = lookup_inbox(message_id=params["message_id"])
    else:
        result = {"success": False, "error": f"Unknown action: {args.action}"}

    print(json.dumps(result))


if __name__ == "__main__":
    main()
