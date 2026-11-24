import json
import argparse
import hashlib
import os
import re
import secrets
import sqlite3
import sys
import time
import base64
import email as email_lib
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests as http_requests

from google.oauth2.credentials import Credentials
from google.auth.exceptions import RefreshError
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.errors import HttpError
from googleapiclient.http import HttpRequest

# The scripts import each other as top-level modules. The Windows-native agent Python
# runs under a ._pth file, which leaves the script directory off sys.path (EG1-8).
sys.path.insert(0, str(Path(__file__).resolve().parent))

from gmail_common import (
    SCOPES as _COMMON_SCOPES,
    RequestsAdapter,
    RequestsResponse,
    build_google_service,
    save_credentials as _common_save_credentials,
    read_existing_refresh_token,
    write_json_atomic,
    decode_gmail_body,
    strip_html,
    clean_body_text as _common_clean_body_text,
    is_supported_inbox_message,
    supported_inbox_query,
    gmail_paused,
    raise_if_paused,
)

# --------------------------------------------------------------------------- #
#  Constants                                                                    #
# --------------------------------------------------------------------------- #

BASE_DIR = Path(__file__).resolve().parent
# Read runtime files from GMAIL_DATA_DIR; fall back to the script dir for local dev.
DATA_DIR = Path(os.environ.get("GMAIL_DATA_DIR") or BASE_DIR)
# Ensure the runtime data directory exists.
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "gmail.db"
PENDING_AUTH_FILE = DATA_DIR / "pending_auth.json"
AUTH_STATE_MAX_AGE_SECONDS = 10 * 60

SCOPES = _COMMON_SCOPES
CREDENTIALS_FILE = str(DATA_DIR / "credentials.json")
TOKEN_FILE = str(DATA_DIR / "token.json")

# --------------------------------------------------------------------------- #
#  Authentication                                                               #
# --------------------------------------------------------------------------- #


# Re-exported from gmail_common for backward compatibility.
# (RequestsAdapter, RequestsResponse, read_existing_refresh_token,
#  write_json_atomic, strip_html, decode_gmail_body are imported above.)


def authenticate():
    """
    Authenticate with Google APIs using OAuth2.
    Loads token.json if present; refreshes an expired token if a refresh_token
    is available.  Raises RuntimeError with a clear setup message when the
    token is missing or cannot be refreshed without user interaction. A refresh
    that could not reach Google, or that Google says to retry, is raised as is:
    signing in again would not fix it.
    """
    raise_if_paused(TOKEN_FILE)
    creds = None

    if Path(TOKEN_FILE).exists():
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)

    if creds and creds.refresh_token and (not creds.valid or creds.expired or creds.expiry is None):
        try:
            print("Refreshing token...", file=sys.stderr)
            creds.refresh(Request())
            save_credentials(creds)
        except RefreshError as e:
            if e.retryable:
                raise
            raise_invalid_token_error()

    if not creds or not creds.valid:
        if not Path(TOKEN_FILE).exists():
            raise_missing_token_error()
        raise_invalid_token_error()

    return creds


def raise_missing_token_error():
    raise RuntimeError(
        f"Gmail is not authenticated: '{TOKEN_FILE}' not found.\n"
        "Run the OAuth setup flow first to generate a token:\n"
        '  uv run python -c "'
        "from google_auth_oauthlib.flow import InstalledAppFlow; "
        f"import json; flow = InstalledAppFlow.from_client_secrets_file('{CREDENTIALS_FILE}', {SCOPES}); "
        f"creds = flow.run_local_server(port=0); open('{TOKEN_FILE}','w').write(creds.to_json())\""
    )


def raise_invalid_token_error():
    raise RuntimeError(
        f"Gmail token in '{TOKEN_FILE}' is invalid and cannot be refreshed.\n"
        f"Delete '{TOKEN_FILE}' and run the OAuth setup flow again."
    )


def save_credentials(creds):
    """Persist Google OAuth credentials to token.json with an atomic replace."""
    _common_save_credentials(creds, TOKEN_FILE)




def credentials_from_token_response(token_data, client):
    """Build Credentials from Google's token endpoint response."""
    expiry = None
    expires_in = token_data.get("expires_in")
    if expires_in is not None:
        try:
            expiry = datetime.now(timezone.utc) + timedelta(seconds=int(expires_in))
        except (TypeError, ValueError):
            expiry = None

    return Credentials(
        token=token_data["access_token"],
        refresh_token=token_data.get("refresh_token"),
        token_uri=client["token_uri"],
        client_id=client["client_id"],
        client_secret=client["client_secret"],
        scopes=SCOPES,
        expiry=expiry,
    )


def _build_service_with_adapter(api_name, version, creds):
    """Build a Google API service using a requests-based HTTP adapter."""
    return build_google_service(api_name, version, creds)


# --------------------------------------------------------------------------- #
#  Database helpers                                                            #
# --------------------------------------------------------------------------- #


def read_last_sync_timestamp(conn):
    """Read the last sync timestamp from the state table. Returns a datetime or None."""
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM state WHERE key = 'last_sync_timestamp'")
        row = cursor.fetchone()
        if row:
            return datetime.strptime(row[0], "%Y-%m-%d %H:%M:%S")
    except (sqlite3.OperationalError, ValueError):
        pass
    return None


def write_last_sync_timestamp(conn):
    """Write the current UTC timestamp to the state table."""
    now = datetime.now(timezone.utc).replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S")
    cursor = conn.cursor()
    cursor.execute(
        "INSERT OR REPLACE INTO state (key, value) VALUES ('last_sync_timestamp', ?)",
        (now,),
    )
    conn.commit()
    return now


def read_history_id(conn):
    """Read the last stored historyId from the state table. Returns a string or None."""
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM state WHERE key = 'last_history_id'")
        row = cursor.fetchone()
        if row:
            return row[0]
    except sqlite3.OperationalError:
        pass
    return None


def write_history_id(conn, history_id):
    """Write the latest historyId to the state table."""
    cursor = conn.cursor()
    cursor.execute(
        "INSERT OR REPLACE INTO state (key, value) VALUES ('last_history_id', ?)",
        (str(history_id),),
    )
    conn.commit()


def setup_database(db_path=DB_PATH, clear_inbox=False, clear_calendar=False):
    """Initializes the shared DB, creating both tables, and optionally clears them."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS state (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS ai_inbox (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            email_id             TEXT UNIQUE,
            conversation_id      TEXT,
            subject              TEXT,
            from_name            TEXT,
            from_email           TEXT,
            to_recipients        TEXT,
            cc_recipients        TEXT,
            received_time        DATETIME,
            body                 TEXT,
            unread               INTEGER,
            original_importance  INTEGER,
            priority_score       INTEGER DEFAULT NULL,
            summary              TEXT    DEFAULT NULL,
            draft_response       TEXT    DEFAULT NULL
        )
        """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS ai_calendar (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            email_id             TEXT UNIQUE,
            conversation_id      TEXT,
            subject              TEXT,
            organizer            TEXT,
            required_attendees   TEXT,
            start_time           DATETIME,
            end_time             DATETIME,
            location             TEXT,
            body                 TEXT,
            is_recurring         INTEGER,
            priority_score       INTEGER DEFAULT NULL,
            summary              TEXT    DEFAULT NULL
        )
        """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS owner (
            id       INTEGER PRIMARY KEY CHECK (id = 1),
            name     TEXT NOT NULL,
            email_id TEXT NOT NULL
        )
        """)

    if clear_inbox:
        print("Option --clear-inbox detected: Wiping 'ai_inbox' table...")
        cursor.execute("DELETE FROM ai_inbox")

    if clear_calendar:
        print("Option --clear-calendar detected: Wiping 'ai_calendar' table...")
        cursor.execute("DELETE FROM ai_calendar")

    if clear_inbox and clear_calendar:
        cursor.execute("DELETE FROM state WHERE key = 'last_sync_timestamp'")
        cursor.execute("DELETE FROM state WHERE key = 'last_history_id'")

    conn.commit()
    return conn


# --------------------------------------------------------------------------- #
#  Text / name helpers                                                         #
# --------------------------------------------------------------------------- #


def clean_body_text(text):
    return _common_clean_body_text(text)


def normalize_name(name):
    """Convert 'Lastname, Firstname' to 'Firstname Lastname' if a comma is present."""
    if not name:
        return name
    name = name.strip()
    if "," in name:
        parts = name.split(",", 1)
        return f"{parts[1].strip()} {parts[0].strip()}"
    return name


def normalize_recipients(recipients_str):
    """Normalize a semicolon-separated list of recipient names."""
    if not recipients_str:
        return recipients_str
    return "; ".join(normalize_name(r.strip()) for r in recipients_str.split(";"))


# --------------------------------------------------------------------------- #
#  Gmail message parsing helpers                                               #
# --------------------------------------------------------------------------- #


def get_header(headers, name):
    """Extract a specific header value from a Gmail API headers list."""
    for header in headers:
        if header["name"].lower() == name.lower():
            return header["value"]
    return ""


def parse_address(raw):
    """
    Parse a raw RFC 2822 address like 'John Doe <john@example.com>' into
    (display_name, email). Falls back gracefully if the address is bare.
    """
    if not raw:
        return "", ""
    name, addr = email_lib.utils.parseaddr(raw)
    return name.strip(), addr.strip().lower()




def decode_body(payload):
    """Recursively extract plain-text body from a Gmail API message payload.

    Preference order: text/plain > text/html (stripped) > None.
    """
    result = decode_gmail_body(payload)
    return result if result else None


def parse_gmail_date(date_str):
    """
    Parse a Gmail internalDate (epoch ms string) or an RFC 2822 Date header
    into a naive local datetime string '%Y-%m-%d %H:%M:%S'.
    Returns (datetime_obj, formatted_str) or (None, None) on failure.
    """
    if not date_str:
        return None, None
    try:
        # internalDate is epoch milliseconds as a string
        epoch_ms = int(date_str)
        dt = datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc).replace(
            tzinfo=None
        )
        return dt, dt.strftime("%Y-%m-%d %H:%M:%S")
    except (ValueError, TypeError):
        pass
    try:
        # Fallback: RFC 2822 header format
        dt_tuple = email_lib.utils.parsedate_to_datetime(date_str)
        dt = dt_tuple.astimezone(timezone.utc).replace(tzinfo=None)
        return dt, dt.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return None, None


def gmail_importance_from_labels(label_ids):
    """
    Map Gmail label IDs to an importance integer:
      2 = high (IMPORTANT), 1 = normal, 0 = low
    """
    if "IMPORTANT" in label_ids:
        return 2
    return 1


# --------------------------------------------------------------------------- #
#  Owner detection                                                             #
# --------------------------------------------------------------------------- #


def derive_owner_from_profile(gmail_service, people_service):
    """
    Retrieve the authenticated user's email from the Gmail profile endpoint,
    and their real display name from the People API (people/me).

    The People API returns the name exactly as set in the user's Google Account,
    so no heuristics are needed. Falls back to deriving a name from the email
    address local-part if the People API call fails.

    Returns (name, email) or (None, None) on failure.
    """
    # Step 1: email address — Gmail profile is the canonical source
    try:
        profile = gmail_service.users().getProfile(userId="me").execute()
        email = profile.get("emailAddress", "").lower().strip()
    except Exception as e:
        print(f"⚠️  Could not fetch Gmail profile: {e}")
        return None, None

    if not email:
        return None, None

    # Step 2: display name — People API people/me with personFields=names
    name = None
    try:
        person = (
            people_service.people()
            .get(resourceName="people/me", personFields="names")
            .execute()
        )
        names = person.get("names", [])
        if names:
            # Prefer an account-level source (PROFILE or DOMAIN_PROFILE)
            for entry in names:
                source_type = (
                    entry.get("metadata", {}).get("source", {}).get("type", "")
                )
                if source_type in ("PROFILE", "DOMAIN_PROFILE"):
                    name = entry.get("displayName", "").strip()
                    break
            # Fall back to the first entry if no preferred source matched
            if not name:
                name = names[0].get("displayName", "").strip() or None
    except Exception as e:
        print(f"⚠️  Could not fetch display name from People API: {e}")

    # Step 3: last-resort fallback — derive name from email local part
    if not name:
        name = email.split("@")[0].replace(".", " ").replace("_", " ").title()

    return name, email


def sync_owner(conn, gmail_service, people_service):
    """Derive the mailbox owner via Gmail + People APIs and upsert into the owner table."""
    print("Detecting mailbox owner...")
    name, email = derive_owner_from_profile(gmail_service, people_service)
    if not name or not email:
        print("Could not determine owner — owner table not updated.")
        return

    conn.cursor().execute(
        "INSERT OR REPLACE INTO owner (id, name, email_id) VALUES (1, ?, ?)",
        (name, email),
    )
    conn.commit()
    print(f"Owner set to: {name} <{email}>")


# --------------------------------------------------------------------------- #
#  Inbox sync                                                                  #
# --------------------------------------------------------------------------- #


def fetch_message_page(gmail_service, page_token=None, max_results=500):
    """
    List one page of inbox message stubs (id + threadId only).
    Returns (messages_list, next_page_token).
    """
    kwargs = dict(
        userId="me",
        labelIds=["INBOX"],
        q=supported_inbox_query(),
        maxResults=max_results,
    )
    if page_token:
        kwargs["pageToken"] = page_token

    result = gmail_service.users().messages().list(**kwargs).execute()
    return result.get("messages", []), result.get("nextPageToken")


def fetch_full_message(gmail_service, msg_id):
    """Fetch a single full message by ID."""
    return (
        gmail_service.users()
        .messages()
        .get(userId="me", id=msg_id, format="full")
        .execute()
    )


def sync_inbox(
    conn,
    gmail_service,
    last_sync,
    num_emails=1000,
    output_file="gmail_inbox.json",
    generate_json=False,
):
    """
    Fetch inbox messages from Gmail and upsert them into ai_inbox.

    De-duplication strategy: only the most recent
    message per thread (conversation_id = threadId) is kept.
    """
    print(f"Scanning up to {num_emails} emails from Gmail inbox...")

    def format_addr_list(raw):
        if not raw:
            return ""
        parsed = email_lib.utils.getaddresses([raw])
        return "; ".join(
            normalize_name(name) if name else addr for name, addr in parsed
        )

    latest_emails = {}  # threadId -> row dict
    scanned = 0
    stop_early = False
    page_token = None

    while scanned < num_emails and not stop_early:
        batch_size = min(500, num_emails - scanned)
        stubs, page_token = fetch_message_page(gmail_service, page_token, batch_size)

        if not stubs:
            break

        for stub in stubs:
            if scanned >= num_emails:
                break

            msg_id = stub["id"]
            thread_id = stub.get("threadId", msg_id)

            # Skip if we already have a message from this thread
            if thread_id in latest_emails:
                scanned += 1
                continue

            try:
                msg = fetch_full_message(gmail_service, msg_id)
            except HttpError as e:
                print(f"  ⚠️  Skipping message {msg_id}: {e}")
                scanned += 1
                continue

            headers = msg.get("payload", {}).get("headers", [])
            label_ids = msg.get("labelIds", [])
            if not is_supported_inbox_message(label_ids):
                scanned += 1
                continue

            from_raw = get_header(headers, "From")
            from_name, from_email = parse_address(from_raw)
            subject = get_header(headers, "Subject") or ""

            # Use internalDate (epoch ms) for reliable ordering
            internal_date = msg.get("internalDate", "")
            received_dt, received_str = parse_gmail_date(internal_date)

            # Since Gmail API returns messages newest-first, stop once we pass last_sync
            if last_sync and received_dt and received_dt <= last_sync:
                print(
                    f"  Reached emails older than last sync at item {scanned}. Stopping."
                )
                stop_early = True
                break

            to_raw = get_header(headers, "To")
            cc_raw = get_header(headers, "Cc")

            body_text = decode_body(msg.get("payload", {})) or ""
            unread = 1 if "UNREAD" in label_ids else 0
            importance = gmail_importance_from_labels(label_ids)

            latest_emails[thread_id] = {
                "email_id": msg_id,
                "conversation_id": thread_id,
                "subject": subject,
                "from_name": normalize_name(from_name),
                "from_email": from_email,
                "to_recipients": format_addr_list(to_raw),
                "cc_recipients": format_addr_list(cc_raw),
                "received_time": received_str,
                "body": clean_body_text(body_text),
                "unread": unread,
                "original_importance": importance,
            }

            scanned += 1

            if scanned % 100 == 0:
                print(f"  Scanned {scanned}... (Threads: {len(latest_emails)})")

        if not page_token:
            break

    cursor = conn.cursor()
    sql = """
        INSERT OR REPLACE INTO ai_inbox (
            email_id, conversation_id, subject, from_name, from_email,
            to_recipients, cc_recipients, received_time, body, unread,
            original_importance
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    db_rows = [
        (
            e["email_id"],
            e["conversation_id"],
            e["subject"],
            e["from_name"],
            e["from_email"],
            e["to_recipients"],
            e["cc_recipients"],
            e["received_time"],
            e["body"],
            e["unread"],
            e["original_importance"],
        )
        for e in latest_emails.values()
    ]
    cursor.executemany(sql, db_rows)
    conn.commit()
    print(f"Inbox done! {len(db_rows)} unique threads stored.")

    if generate_json:
        cursor.execute("SELECT * FROM ai_inbox")
        rows = [dict(row) for row in cursor.fetchall()]
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(rows, f, indent=2, ensure_ascii=False)
        print(f"Inbox JSON dump exported to {output_file}.")


# --------------------------------------------------------------------------- #
#  History API-based delta sync                                                #
# --------------------------------------------------------------------------- #


def sync_inbox_history(conn, gmail_service, start_history_id):
    """
    Perform an incremental sync using Gmail History API.

    Reconciles message additions, deletions, and label changes (read/unread,
    INBOX removal) that occurred since start_history_id.

    Returns the new historyId to store, or None if a full sync is required
    (when history is expired / 404).
    """
    print(f"Delta sync via History API (startHistoryId={start_history_id})...")

    added_msg_ids = set()
    deleted_msg_ids = set()
    label_changes = {}  # msg_id -> {"added": set(), "removed": set()}

    page_token = None
    history_id = start_history_id

    while True:
        try:
            kwargs = dict(
                userId="me",
                startHistoryId=start_history_id,
                historyTypes=[
                    "messageAdded",
                    "messageDeleted",
                    "labelAdded",
                    "labelRemoved",
                ],
                labelId="INBOX",
                maxResults=500,
            )
            if page_token:
                kwargs["pageToken"] = page_token

            result = gmail_service.users().history().list(**kwargs).execute()
        except HttpError as e:
            if e.resp.status == 404:
                # History expired — caller should do a full sync
                print("  ⚠️  History expired (404). Full re-sync required.")
                return None
            raise

        # Update to the latest historyId from this response
        history_id = result.get("historyId", history_id)

        for record in result.get("history", []):
            for added in record.get("messagesAdded", []):
                msg = added.get("message", {})
                msg_id = msg.get("id")
                label_ids = msg.get("labelIds", [])
                if msg_id and is_supported_inbox_message(label_ids):
                    added_msg_ids.add(msg_id)

            # Messages deleted
            for deleted in record.get("messagesDeleted", []):
                msg = deleted.get("message", {})
                msg_id = msg.get("id")
                if msg_id:
                    deleted_msg_ids.add(msg_id)

            # Labels added (e.g., marked unread, moved back to inbox)
            for label_added in record.get("labelsAdded", []):
                msg = label_added.get("message", {})
                msg_id = msg.get("id")
                labels = label_added.get("labelIds", [])
                if msg_id and labels:
                    label_changes.setdefault(msg_id, {"added": set(), "removed": set()})
                    label_changes[msg_id]["added"].update(labels)

            # Labels removed (e.g., marked read, archived/removed from inbox)
            for label_removed in record.get("labelsRemoved", []):
                msg = label_removed.get("message", {})
                msg_id = msg.get("id")
                labels = label_removed.get("labelIds", [])
                if msg_id and labels:
                    label_changes.setdefault(msg_id, {"added": set(), "removed": set()})
                    label_changes[msg_id]["removed"].update(labels)

        page_token = result.get("nextPageToken")
        if not page_token:
            break

    cursor = conn.cursor()

    # --- Handle deletions: remove from local DB ---
    if deleted_msg_ids:
        placeholders = ",".join("?" for _ in deleted_msg_ids)
        cursor.execute(
            f"DELETE FROM ai_inbox WHERE email_id IN ({placeholders})",
            list(deleted_msg_ids),
        )
        print(f"  Deleted {cursor.rowcount} messages from local DB.")

    # --- Handle INBOX removal (archived): remove from local DB ---
    inbox_removed_ids = set()
    for msg_id, changes in label_changes.items():
        if "INBOX" in changes["removed"] and msg_id not in added_msg_ids:
            inbox_removed_ids.add(msg_id)
    if inbox_removed_ids:
        placeholders = ",".join("?" for _ in inbox_removed_ids)
        cursor.execute(
            f"DELETE FROM ai_inbox WHERE email_id IN ({placeholders})",
            list(inbox_removed_ids),
        )
        print(f"  Removed {cursor.rowcount} archived messages from local DB.")

    # --- Handle read/unread label changes ---
    read_ids = []
    unread_ids = []
    for msg_id, changes in label_changes.items():
        if msg_id in deleted_msg_ids or msg_id in inbox_removed_ids:
            continue
        if "UNREAD" in changes["removed"]:
            read_ids.append(msg_id)
        elif "UNREAD" in changes["added"]:
            unread_ids.append(msg_id)

    if read_ids:
        placeholders = ",".join("?" for _ in read_ids)
        cursor.execute(
            f"UPDATE ai_inbox SET unread = 0 WHERE email_id IN ({placeholders})",
            read_ids,
        )
        print(f"  Marked {cursor.rowcount} messages as read.")

    if unread_ids:
        placeholders = ",".join("?" for _ in unread_ids)
        cursor.execute(
            f"UPDATE ai_inbox SET unread = 1 WHERE email_id IN ({placeholders})",
            unread_ids,
        )
        print(f"  Marked {cursor.rowcount} messages as unread.")

    # --- Handle importance label changes ---
    important_added = []
    important_removed = []
    for msg_id, changes in label_changes.items():
        if msg_id in deleted_msg_ids or msg_id in inbox_removed_ids:
            continue
        if "IMPORTANT" in changes["added"]:
            important_added.append(msg_id)
        elif "IMPORTANT" in changes["removed"]:
            important_removed.append(msg_id)

    if important_added:
        placeholders = ",".join("?" for _ in important_added)
        cursor.execute(
            f"UPDATE ai_inbox SET original_importance = 2 WHERE email_id IN ({placeholders})",
            important_added,
        )

    if important_removed:
        placeholders = ",".join("?" for _ in important_removed)
        cursor.execute(
            f"UPDATE ai_inbox SET original_importance = 1 WHERE email_id IN ({placeholders})",
            important_removed,
        )

    conn.commit()

    # --- Fetch and insert newly added messages ---
    # Exclude messages that were also deleted in the same history window
    new_msg_ids = added_msg_ids - deleted_msg_ids - inbox_removed_ids

    def format_addr_list(raw):
        if not raw:
            return ""
        parsed = email_lib.utils.getaddresses([raw])
        return "; ".join(
            normalize_name(name) if name else addr for name, addr in parsed
        )

    new_rows = []
    for msg_id in new_msg_ids:
        try:
            msg = fetch_full_message(gmail_service, msg_id)
        except HttpError as e:
            print(f"  ⚠️  Skipping added message {msg_id}: {e}")
            continue

        headers = msg.get("payload", {}).get("headers", [])
        label_ids = msg.get("labelIds", [])

        if not is_supported_inbox_message(label_ids):
            continue

        from_raw = get_header(headers, "From")
        from_name, from_email = parse_address(from_raw)
        subject = get_header(headers, "Subject") or ""

        internal_date = msg.get("internalDate", "")
        _, received_str = parse_gmail_date(internal_date)

        to_raw = get_header(headers, "To")
        cc_raw = get_header(headers, "Cc")

        body_text = decode_body(msg.get("payload", {})) or ""
        unread = 1 if "UNREAD" in label_ids else 0
        importance = gmail_importance_from_labels(label_ids)

        new_rows.append(
            (
                msg_id,
                msg.get("threadId", msg_id),
                subject,
                normalize_name(from_name),
                from_email,
                format_addr_list(to_raw),
                format_addr_list(cc_raw),
                received_str,
                clean_body_text(body_text),
                unread,
                importance,
            )
        )

    if new_rows:
        sql = """
            INSERT OR REPLACE INTO ai_inbox (
                email_id, conversation_id, subject, from_name, from_email,
                to_recipients, cc_recipients, received_time, body, unread,
                original_importance
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """
        cursor.executemany(sql, new_rows)
        conn.commit()
        print(f"  Added {len(new_rows)} new messages to local DB.")

    total_changes = (
        len(deleted_msg_ids)
        + len(inbox_removed_ids)
        + len(read_ids)
        + len(unread_ids)
        + len(new_rows)
    )
    print(f"History sync complete. {total_changes} total changes applied.")
    return str(history_id)


# --------------------------------------------------------------------------- #


def get_work_week_range():
    """
    Returns (time_min, time_max) as RFC 3339 UTC strings spanning
    last Monday through next Friday.
    """
    today = datetime.now(tz=timezone.utc)
    current_weekday = today.weekday()  # Monday=0
    last_monday = today - timedelta(days=current_weekday + 7)
    next_friday = today - timedelta(days=current_weekday) + timedelta(days=11)

    time_min = last_monday.replace(
        hour=0, minute=0, second=0, microsecond=0
    ).isoformat()
    time_max = next_friday.replace(
        hour=23, minute=59, second=59, microsecond=0
    ).isoformat()
    return time_min, time_max


def parse_calendar_datetime(dt_obj):
    """
    Parse a Google Calendar start/end object into a naive UTC datetime string.
    Handles both 'dateTime' (specific time) and 'date' (all-day) fields.
    """
    if not dt_obj:
        return None, None
    if "dateTime" in dt_obj:
        raw = dt_obj["dateTime"]
        try:
            # RFC 3339 format — parse with timezone awareness then strip tz
            dt = datetime.fromisoformat(raw)
            if dt.tzinfo:
                dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
            return dt, dt.strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            return None, raw
    if "date" in dt_obj:
        raw = dt_obj["date"]  # YYYY-MM-DD all-day event
        try:
            dt = datetime.strptime(raw, "%Y-%m-%d")
            return dt, dt.strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            return None, raw
    return None, None


def sync_calendar(
    conn,
    calendar_service,
    last_sync,
    output_file="gmail_calendar.json",
    generate_json=False,
):
    """
    Fetch Google Calendar events for the work-week window and upsert them
    into ai_calendar.
    """
    time_min, time_max = get_work_week_range()
    print(f"Fetching calendar events from {time_min[:10]} to {time_max[:10]}...")

    events = []
    page_token = None

    while True:
        kwargs = dict(
            calendarId="primary",
            timeMin=time_min,
            timeMax=time_max,
            singleEvents=True,  # Expand recurring events into individual instances
            orderBy="startTime",
            maxResults=2500,
        )
        if page_token:
            kwargs["pageToken"] = page_token

        try:
            result = calendar_service.events().list(**kwargs).execute()
        except HttpError as e:
            raise RuntimeError(f"Failed to list calendar events: {e}") from e

        items = result.get("items", [])

        for item in items:
            try:
                event_id = item.get("id", "")
                ical_uid = item.get("iCalUID", "")
                summary = (item.get("summary") or "").strip()

                # Organizer: prefer displayName, fall back to email
                organizer_obj = item.get("organizer", {})
                organizer = (
                    organizer_obj.get("displayName")
                    or organizer_obj.get("email")
                    or "Unknown"
                )

                # Attendees — collect all non-resource, non-organizer attendees
                attendees = item.get("attendees", [])
                required_list = [
                    (a.get("displayName") or a.get("email", ""))
                    for a in attendees
                    if not a.get("resource", False)
                ]
                required_attendees = "; ".join(required_list)

                start_obj = item.get("start", {})
                end_obj = item.get("end", {})
                start_dt, start_str = parse_calendar_datetime(start_obj)
                _, end_str = parse_calendar_datetime(end_obj)

                location = (item.get("location") or "").strip()
                body = clean_body_text(item.get("description") or "")

                # is_recurring: True when the event has a recurringEventId
                is_recurring = 1 if item.get("recurringEventId") else 0

                # Stable key for recurring instances (iCalUID + start time)
                if is_recurring:
                    # Non-security: stable ID for recurring events, not a signature.
                    stable_key = hashlib.sha1(
                        f"{ical_uid}|{start_str}|{organizer}".encode(),
                        usedforsecurity=False,
                    ).hexdigest()
                    db_event_id = f"recurring:{stable_key}"
                    conversation_id = ical_uid  # All instances share the same iCalUID
                else:
                    db_event_id = event_id
                    conversation_id = ical_uid

                events.append(
                    {
                        "email_id": db_event_id,
                        "conversation_id": conversation_id,
                        "subject": summary,
                        "organizer": organizer,
                        "required_attendees": required_attendees,
                        "start_time": start_str,
                        "end_time": end_str,
                        "location": location,
                        "body": body,
                        "is_recurring": is_recurring,
                    }
                )

            except Exception:
                continue

        page_token = result.get("nextPageToken")
        if not page_token:
            break

    cursor = conn.cursor()
    window_start = datetime.fromisoformat(time_min).replace(tzinfo=None)
    window_end = datetime.fromisoformat(time_max).replace(tzinfo=None)
    active_event_ids = [e["email_id"] for e in events]
    if active_event_ids:
        placeholders = ",".join("?" for _ in active_event_ids)
        cursor.execute(
            "DELETE FROM ai_calendar "
            "WHERE start_time >= ? AND start_time <= ? "
            f"AND email_id NOT IN ({placeholders})",
            [
                window_start.strftime("%Y-%m-%d %H:%M:%S"),
                window_end.strftime("%Y-%m-%d %H:%M:%S"),
                *active_event_ids,
            ],
        )
    else:
        cursor.execute(
            "DELETE FROM ai_calendar WHERE start_time >= ? AND start_time <= ?",
            (
                window_start.strftime("%Y-%m-%d %H:%M:%S"),
                window_end.strftime("%Y-%m-%d %H:%M:%S"),
            ),
        )
    stale_count = cursor.rowcount

    sql = """
        INSERT OR REPLACE INTO ai_calendar (
            email_id, conversation_id, subject, organizer,
            required_attendees, start_time, end_time,
            location, body, is_recurring
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    db_rows = [
        (
            e["email_id"],
            e["conversation_id"],
            e["subject"],
            e["organizer"],
            e["required_attendees"],
            e["start_time"],
            e["end_time"],
            e["location"],
            e["body"],
            e["is_recurring"],
        )
        for e in events
    ]
    cursor.executemany(sql, db_rows)
    conn.commit()
    print(f"Calendar done! {len(db_rows)} events stored, {stale_count} stale removed.")

    if generate_json:
        cursor.execute("SELECT * FROM ai_calendar")
        rows = [dict(row) for row in cursor.fetchall()]
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(rows, f, indent=2, ensure_ascii=False)
        print(f"Calendar JSON dump exported to {output_file}.")


# --------------------------------------------------------------------------- #
#  OAuth setup commands (used by the OpenWork server callback flow)           #
# --------------------------------------------------------------------------- #


def cmd_check_auth():
    """Print 'authenticated' / 'unauthenticated' / 'no_credentials' / 'paused' and exit."""
    if not Path(CREDENTIALS_FILE).exists():
        print("no_credentials", flush=True)
        sys.exit(2)
    if gmail_paused(TOKEN_FILE):
        print("paused", flush=True)
        sys.exit(3)
    if not Path(TOKEN_FILE).exists():
        print("unauthenticated", flush=True)
        sys.exit(1)
    # Validate token usability, refreshing and persisting it if needed.
    try:
        authenticate()
    except Exception:
        print("unauthenticated", flush=True)
        sys.exit(1)
    print("authenticated", flush=True)
    sys.exit(0)


def _api_state(request: HttpRequest) -> str:
    """'enabled' when the request succeeds, 'disabled' when the project has the API turned off,
    'not_granted' when the user left that access unticked on Google's consent screen."""
    try:
        request.execute()
        return "enabled"
    except HttpError as e:
        body = e.content.decode("utf-8", "replace") if isinstance(e.content, bytes) else str(e.content)
        if e.resp.status == 403 and ("SERVICE_DISABLED" in body or "accessNotConfigured" in body):
            return "disabled"
        if e.resp.status == 403 and (
            "ACCESS_TOKEN_SCOPE_INSUFFICIENT" in body or "insufficientPermissions" in body
        ):
            return "not_granted"
        return "unknown"
    except Exception:
        return "unknown"


def _granted_scopes(creds) -> set[str] | None:
    """The scopes Google actually granted the saved token, or None when that cannot be asked.

    token.json stores the scopes requested, not granted, and Google's consent screen lets
    the user untick single permissions, such as sending mail, while granting the rest."""
    try:
        # egress-surface: gmail_api_setup_check
        resp = http_requests.get(
            "https://oauth2.googleapis.com/tokeninfo",
            params={"access_token": creds.token},
            timeout=10,
        )
        if resp.status_code != 200:
            return None
        return set(str(resp.json().get("scope", "")).split())
    except (http_requests.RequestException, ValueError):
        return None


# The server reads only this exit code as "sign in again"; a crash or an offline refresh
# exits 1 and must not.
NOT_AUTHORIZED_EXIT = 3


def cmd_check_apis() -> None:
    """Print, as JSON, whether Gmail and Calendar answer for the saved token, and exit.

    Exits NOT_AUTHORIZED_EXIT when there is no token or Google rejects it. Settings
    polls this after sign-in, so the setup guide knows when the user has turned both
    APIs on in their Google Cloud project.
    An API that answers but lacks a scope SuperClaw needs (say, sending mail) reports
    `not_granted`: the read-only probes alone would call it ready.
    """
    try:
        creds = authenticate()
    except RuntimeError:
        sys.exit(NOT_AUTHORIZED_EXIT)
    # egress-surface: gmail_api_setup_check
    gmail_service = _build_service_with_adapter("gmail", "v1", creds)
    calendar_service = _build_service_with_adapter("calendar", "v3", creds)
    result = {
        "gmail": _api_state(gmail_service.users().getProfile(userId="me")),
        "calendar": _api_state(calendar_service.calendarList().list(maxResults=1)),
    }
    granted = _granted_scopes(creds)
    if granted is not None:
        for api in ("gmail", "calendar"):
            needed = {s for s in SCOPES if f"/auth/{api}" in s}
            if result[api] == "enabled" and not needed <= granted:
                result[api] = "not_granted"
    print(json.dumps(result), flush=True)
    sys.exit(0)


def cmd_get_auth_url(redirect_uri: str):
    """
    Generate an OAuth authorization URL, persist a pending-auth state file
    (for CSRF validation), print the URL, and exit.
    """
    if not Path(CREDENTIALS_FILE).exists():
        print(
            f"❌ '{CREDENTIALS_FILE}' not found. Cannot start auth flow.",
            file=sys.stderr,
        )
        sys.exit(2)

    flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_FILE, SCOPES)
    flow.redirect_uri = redirect_uri
    state = secrets.token_urlsafe(32)

    # Generate PKCE code_verifier / code_challenge so we can include the
    # verifier in the token-exchange step (different process, can't reuse flow).
    code_verifier = secrets.token_urlsafe(43)
    code_challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode()).digest())
        .rstrip(b"=")
        .decode()
    )

    auth_url, _ = flow.authorization_url(
        access_type="offline",
        prompt="consent",
        state=state,
        code_challenge=code_challenge,
        code_challenge_method="S256",
    )

    pending = {
        "state": state,
        "redirect_uri": redirect_uri,
        "code_verifier": code_verifier,
        "created_at": time.time(),
    }
    PENDING_AUTH_FILE.write_text(json.dumps(pending))
    print(auth_url, flush=True)
    sys.exit(0)


def cmd_complete_auth(code: str, redirect_uri: str, state: str):
    """
    Exchange an authorization code for tokens and save token.json.
    Uses requests directly to avoid PKCE / state-mismatch issues that arise
    when reconstructing an InstalledAppFlow in a separate process.
    """
    if not Path(CREDENTIALS_FILE).exists():
        print(f"❌ '{CREDENTIALS_FILE}' not found.", file=sys.stderr)
        sys.exit(2)

    with open(CREDENTIALS_FILE) as fh:
        cred_data = json.load(fh)

    client = cred_data.get("installed") or cred_data.get("web")
    if not client:
        print("❌ Unrecognised credentials.json format.", file=sys.stderr)
        sys.exit(1)

    if not PENDING_AUTH_FILE.exists():
        print(
            "❌ OAuth state is missing or expired. Restart Gmail authorization.",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        pending_data = json.loads(PENDING_AUTH_FILE.read_text())
    except json.JSONDecodeError:
        print("❌ OAuth state is invalid. Restart Gmail authorization.", file=sys.stderr)
        sys.exit(1)

    expected_state = pending_data.get("state")
    expected_redirect_uri = pending_data.get("redirect_uri")
    created_at = pending_data.get("created_at")
    code_verifier = pending_data.get("code_verifier")

    if not expected_state or not secrets.compare_digest(str(expected_state), state):
        print("❌ OAuth state mismatch. Restart Gmail authorization.", file=sys.stderr)
        sys.exit(1)
    if expected_redirect_uri != redirect_uri:
        print(
            "❌ OAuth redirect URI mismatch. Restart Gmail authorization.",
            file=sys.stderr,
        )
        sys.exit(1)
    if not code_verifier:
        print(
            "❌ OAuth PKCE verifier is missing. Restart Gmail authorization.",
            file=sys.stderr,
        )
        sys.exit(1)
    try:
        state_age = time.time() - float(created_at)
    except (TypeError, ValueError):
        print(
            "❌ OAuth state timestamp is invalid. Restart Gmail authorization.",
            file=sys.stderr,
        )
        sys.exit(1)
    if state_age > AUTH_STATE_MAX_AGE_SECONDS:
        print("❌ OAuth state expired. Restart Gmail authorization.", file=sys.stderr)
        sys.exit(1)

    post_data: dict = {
        "code": code,
        "client_id": client["client_id"],
        "client_secret": client["client_secret"],
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }
    post_data["code_verifier"] = code_verifier

    # Retry token exchange up to 3 times to handle transient proxy failures.
    resp = None
    for attempt in range(3):
        try:
            # egress-surface: gmail_oauth_token_exchange
            resp = http_requests.post(
                client["token_uri"],
                data=post_data,
                timeout=30,
            )
            break
        except http_requests.exceptions.ConnectionError:
            if attempt < 2:
                time.sleep(2**attempt)  # 1s, 2s backoff
        except http_requests.exceptions.RequestException:
            print(
                "Gmail authorization could not be completed because the request timed out or failed. Check your internet connection and restart Gmail authorization.",
                file=sys.stderr,
            )
            sys.exit(1)
    if resp is None:
        print(
            "Gmail authorization failed because Google could not be reached after several attempts. Check your internet connection and try again.",
            file=sys.stderr,
        )
        sys.exit(1)
    if not resp.ok:
        print(
            "Google rejected the Gmail authorization code, which may have expired or already been used. Restart Gmail authorization and try again.",
            file=sys.stderr,
        )
        sys.exit(1)

    token_data = resp.json()

    # Build a Credentials-compatible JSON file (same schema as Credentials.to_json())
    creds = credentials_from_token_response(token_data, client)
    save_credentials(creds)

    # Clean up pending auth state
    PENDING_AUTH_FILE.unlink(missing_ok=True)

    print("✅ Gmail authentication complete! token.json saved.", flush=True)
    sys.exit(0)


# --------------------------------------------------------------------------- #
#  Entry point                                                                  #
# --------------------------------------------------------------------------- #


def main():
    parser = argparse.ArgumentParser(
        description="Sync Gmail inbox and Google Calendar to a single SQLite database."
    )
    # -- Auth sub-commands (handled early, exit before any sync logic) --
    parser.add_argument(
        "--check-auth",
        action="store_true",
        help="Check if Gmail is authenticated and exit (0=ok, 1=not authed, 2=no credentials, 3=paused)",
    )
    parser.add_argument(
        "--check-apis",
        action="store_true",
        help="Print whether the Gmail and Calendar APIs answer for the saved token, as JSON, and exit",
    )
    parser.add_argument(
        "--get-auth-url",
        metavar="REDIRECT_URI",
        help="Generate an OAuth authorization URL for the given redirect URI and exit",
    )
    parser.add_argument(
        "--complete-auth",
        metavar="CODE",
        help="Complete the OAuth flow with the given authorization code",
    )
    parser.add_argument(
        "--redirect-uri",
        metavar="URI",
        help="Redirect URI used during --get-auth-url (required with --complete-auth)",
    )
    parser.add_argument(
        "--state",
        metavar="STATE",
        help="OAuth state value (required with --complete-auth for CSRF validation)",
    )
    # -- Sync options --
    parser.add_argument("--inbox-only", action="store_true", help="Sync inbox only")
    parser.add_argument(
        "--calendar-only", action="store_true", help="Sync calendar only"
    )
    parser.add_argument(
        "--json", action="store_true", help="Dump database tables to JSON"
    )
    parser.add_argument(
        "--clear-inbox", action="store_true", help="Wipe ai_inbox table before sync"
    )
    parser.add_argument(
        "--clear-calendar",
        action="store_true",
        help="Wipe ai_calendar table before sync",
    )
    parser.add_argument(
        "--clear", action="store_true", help="Wipe both tables before sync"
    )
    parser.add_argument("--db-path", default=DB_PATH, help="SQLite file path")
    parser.add_argument(
        "--num-emails", type=int, default=1000, help="Max emails to scan from inbox"
    )
    parser.add_argument(
        "--inbox-output",
        default="gmail_inbox.json",
        help="JSON output filename for inbox",
    )
    parser.add_argument(
        "--calendar-output",
        default="gmail_calendar.json",
        help="JSON output filename for calendar",
    )

    args = parser.parse_args()

    # --- Dispatch auth sub-commands first (they exit immediately) ---
    if args.check_auth:
        cmd_check_auth()

    if args.check_apis:
        cmd_check_apis()

    if args.get_auth_url:
        cmd_get_auth_url(args.get_auth_url)

    if args.complete_auth:
        if not args.redirect_uri:
            print("❌ --redirect-uri is required with --complete-auth", file=sys.stderr)
            sys.exit(1)
        if not args.state:
            print("❌ --state is required with --complete-auth", file=sys.stderr)
            sys.exit(1)
        cmd_complete_auth(args.complete_auth, args.redirect_uri, args.state)

    clear_inbox = args.clear_inbox or args.clear
    clear_calendar = args.clear_calendar or args.clear

    run_inbox = not args.calendar_only
    run_calendar = not args.inbox_only

    # --- Authenticate once, build both services ---
    try:
        creds = authenticate()
    except FileNotFoundError:
        print(
            f"❌ '{CREDENTIALS_FILE}' not found.\n"
            "   → Download it from: https://console.cloud.google.com\n"
            "   → APIs & Services → Credentials → OAuth 2.0 Client IDs → Download JSON\n"
            f"   → Save it as '{CREDENTIALS_FILE}' in this folder.",
            file=sys.stderr,
        )
        sys.exit(1)
    except RuntimeError as e:
        print(f"❌ {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"❌ Authentication failed: {e}", file=sys.stderr)
        sys.exit(1)

    gmail_service = _build_service_with_adapter("gmail", "v1", creds)
    calendar_service = _build_service_with_adapter("calendar", "v3", creds)
    people_service = _build_service_with_adapter("people", "v1", creds)
    print("✅ Connected to Gmail, Google Calendar, and People APIs!\n")

    conn = setup_database(
        args.db_path,
        clear_inbox=clear_inbox,
        clear_calendar=clear_calendar,
    )

    # Read shared timestamp before any sync
    last_sync = None
    stored_history_id = None
    if not (clear_inbox and clear_calendar):
        last_sync = read_last_sync_timestamp(conn)
        stored_history_id = read_history_id(conn)
        if stored_history_id:
            print(f"Incremental sync: using historyId={stored_history_id}.")
        elif last_sync:
            print(f"Incremental sync: using last sync timestamp {last_sync} (UTC).")
            print(
                "  (No historyId stored — will do timestamp-based sync then store historyId.)"
            )
        else:
            print("No previous sync state found. Performing full sync.")

    print("\n--- Syncing Owner ---")
    sync_owner(conn, gmail_service, people_service)

    if run_inbox:
        print("\n--- Syncing Inbox ---")
        new_history_id = None

        if stored_history_id and not clear_inbox:
            # Use History API for delta sync
            new_history_id = sync_inbox_history(conn, gmail_service, stored_history_id)
            if new_history_id is None:
                # History expired — fall back to full sync
                print("  Falling back to full sync (history expired)...")
                sync_inbox(
                    conn,
                    gmail_service,
                    last_sync=None,
                    num_emails=args.num_emails,
                    output_file=args.inbox_output,
                    generate_json=args.json,
                )
        else:
            # Full sync (initial or --clear-inbox)
            sync_inbox(
                conn,
                gmail_service,
                last_sync=last_sync if not clear_inbox else None,
                num_emails=args.num_emails,
                output_file=args.inbox_output,
                generate_json=args.json,
            )

        # Fetch and store the current historyId from the Gmail profile
        try:
            profile = gmail_service.users().getProfile(userId="me").execute()
            current_history_id = profile.get("historyId")
            if current_history_id:
                write_history_id(conn, current_history_id)
                print(f"  Stored historyId={current_history_id} for next delta sync.")
        except Exception as e:
            print(f"  ⚠️  Could not fetch historyId from profile: {e}")
            # If we got a new_history_id from the history list response, use that
            if new_history_id:
                write_history_id(conn, new_history_id)

    if run_calendar:
        print("\n--- Syncing Calendar ---")
        sync_calendar(
            conn,
            calendar_service,
            last_sync=last_sync if not clear_calendar else None,
            output_file=args.calendar_output,
            generate_json=args.json,
        )

    written_ts = write_last_sync_timestamp(conn)
    conn.close()

    print(f"\nSync timestamp updated to {written_ts} (UTC) in 'state' table")


if __name__ == "__main__":
    main()
