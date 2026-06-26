"""
email_helper.py — AgentVis Email helper script

Feature list:
  setup_account    - Store email credentials in Windows Credential Manager [must be run before first use]
  list_emails      - List summaries of the latest N emails in the inbox (or specified folder)
  read_email       - Read the full content of the specified UID email (including attachment list)
  search_emails    - Search emails by sender/subject/date range
  send_email       - Send a new email through SMTP (supports attachments and HTML body)
  reply_email      - Reply to the specified UID email (thread headers filled automatically)
  mark_read        - Mark the specified email as read
  mark_unread      - Mark the specified email as unread
  delete_email     - Delete an email (move to Trash, or delete directly with --permanent)
  list_folders     - List all mailbox folders
  save_attachment  - Save attachments from the specified email to a local directory

Credentials are read automatically from Windows Credential Manager:
  service = "email_credentials_{account}.AgentVis"
  username = "" (empty string, consistent with Rust keyring storage format)
"""

import argparse
import base64
import imaplib
import json
import mimetypes
import os
import re
import smtplib
import ssl
import sys
from datetime import datetime
from email import message_from_bytes, policy
from email.header import decode_header as _decode_header
from email.message import EmailMessage, Message
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email import encoders
from typing import Optional

# Import keyring at module level to avoid lazy-import cold start overhead on every function call (first import ~2-5s).
try:
    import keyring
except ImportError:
    keyring = None  # type: ignore[assignment]

# ─── Force UTF-8 Output in Windows Console ───────────────────────────────────

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except AttributeError:
        pass
if sys.stderr.encoding and sys.stderr.encoding.lower() != "utf-8":
    try:
        sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except AttributeError:
        pass

# ─── Constants ────────────────────────────────────────────────────────────────

DEFAULT_ACCOUNT = "default"
DEFAULT_LIST_COUNT = 20
MAX_LIST_COUNT = 200
# Maximum number of HTML body characters to display in read_email (avoid overly long output).
HTML_PREVIEW_CHARS = 800
# IMAP socket timeout (seconds): prevent SSL handshakes from hanging indefinitely under VPN/proxy environments.
IMAP_CONNECT_TIMEOUT_SECS = 30

# ─── Credential Management ───────────────────────────────────────────────────


def _get_keyring_service_key(account: str) -> str:
    """
    Build the keyring service name.
    The Rust keyring crate stores entries on Windows as "{username}.{service}",
    so the Python side reads service = "{account_key}.AgentVis", username = "".
    """
    return f"email_credentials_{account}.AgentVis"


def load_email_credentials(account: str) -> dict:
    """
    Read email credentials for the specified account from Windows Credential Manager.

    Credential format (JSON string):
    {
        "imap_host": "imap.gmail.com",
        "imap_port": 993,
        "smtp_host": "smtp.gmail.com",
        "smtp_port": 587,
        "username": "user@example.com",
        "password": "app_password",
        "smtp_use_tls": true
    }
    """
    if keyring is None:
        _fatal("Missing keyring library. Please run: pip install keyring")

    service = _get_keyring_service_key(account)
    raw = keyring.get_password(service, "")

    if not raw:
        _fatal(
            f"Email credentials for account '{account}' were not found.\n"
            "  Please report to the user that IMAP/SMTP information and credentials need to be configured,\n"
            "  or manually write them by referring to the \"Credential Configuration\" section in SKILL.md."
        )

    try:
        creds = json.loads(raw)
    except json.JSONDecodeError as exc:
        _fatal(f"Failed to parse credential format: {exc}")

    # Validate required fields.
    required_fields = ["imap_host", "imap_port", "smtp_host", "smtp_port", "username", "password"]
    missing = [f for f in required_fields if not creds.get(f)]
    if missing:
        _fatal(f"Credentials are incomplete, missing fields: {', '.join(missing)}")

    return creds


def action_setup_account(
    account: str,
    imap_host: str,
    imap_port: int,
    smtp_host: str,
    smtp_port: int,
    username: str,
    password: str,
    smtp_use_tls: bool,
) -> None:
    """
    Store email credentials in Windows Credential Manager.

    Design rationale: SKILL.md previously suggested writing to keyring with a
    Python one-liner, but the exec tool can hit shell escaping failures when
    handling passwords that contain special characters. Passing credentials
    through CLI arguments fully avoids escaping issues because argparse receives
    the raw strings directly without shell parsing.
    """
    if keyring is None:
        _fatal("Missing keyring library. Please run: pip install keyring")

    creds = {
        "imap_host": imap_host,
        "imap_port": imap_port,
        "smtp_host": smtp_host,
        "smtp_port": smtp_port,
        "username": username,
        "password": password,
        "smtp_use_tls": smtp_use_tls,
    }
    service = _get_keyring_service_key(account)
    keyring.set_password(service, "", json.dumps(creds))
    print(f"✅ Account '{account}' credentials saved")
    print(f"   Account : {username}")
    print(f"   IMAP    : {imap_host}:{imap_port}")
    print(f"   SMTP    : {smtp_host}:{smtp_port} (TLS: {smtp_use_tls})")
    print(f"   keyring : {service}")


def action_network_targets(creds: dict, account: str) -> None:
    """Print IMAP/SMTP direct-audit targets without opening any network connection."""
    targets = {
        "account": account,
        "targets": [
            {
                "protocol": "imap",
                "host": creds["imap_host"],
                "port": int(creds["imap_port"]),
            },
            {
                "protocol": "smtp",
                "host": creds["smtp_host"],
                "port": int(creds["smtp_port"]),
            },
        ],
    }
    print(json.dumps(targets, ensure_ascii=False))


# ─── IMAP Connection Helpers ─────────────────────────────────────────────────


def _imap_connect(creds: dict) -> imaplib.IMAP4_SSL:
    """Establish an IMAP SSL connection and log in."""
    host: str = creds["imap_host"]
    port: int = int(creds["imap_port"])
    username: str = creds["username"]
    password: str = creds["password"]

    try:
        ctx = ssl.create_default_context()
        mail = imaplib.IMAP4_SSL(
            host, port, ssl_context=ctx, timeout=IMAP_CONNECT_TIMEOUT_SECS
        )
        mail.login(username, password)
        return mail
    except imaplib.IMAP4.error as exc:
        _fatal(f"IMAP login failed ({host}:{port}): {exc}")
    except TimeoutError as exc:
        _fatal(f"IMAP connection timed out ({host}:{port}, {IMAP_CONNECT_TIMEOUT_SECS}s): {exc}")
    except OSError as exc:
        _fatal(f"Unable to connect to IMAP server ({host}:{port}): {exc}")


def _imap_select_folder(mail: imaplib.IMAP4_SSL, folder: str) -> None:
    """Select an IMAP folder and abort if it fails."""
    status, details = mail.select(f'"{folder}"')
    if status != "OK":
        # Try without quotes.
        status, details = mail.select(folder)
    if status != "OK":
        _fatal(f"Unable to select mail folder '{folder}': {details}")


# ─── Email Parsing Helpers ───────────────────────────────────────────────────


def _decode_mime_words(raw: str) -> str:
    """Decode MIME-encoded strings (=?UTF-8?...?=) and return a Python str."""
    parts = _decode_header(raw)
    decoded_parts: list[str] = []
    for part_bytes, enc in parts:
        if isinstance(part_bytes, bytes):
            charset = enc or "utf-8"
            try:
                decoded_parts.append(part_bytes.decode(charset, errors="replace"))
            except (LookupError, UnicodeDecodeError):
                decoded_parts.append(part_bytes.decode("utf-8", errors="replace"))
        else:
            decoded_parts.append(part_bytes)
    return " ".join(decoded_parts)


def _parse_email_summary(uid: str, raw_data: bytes) -> str:
    """
    Parse raw email bytes and return a single-line summary:
    [UID] [date] [sender] [subject] [flags]
    """
    try:
        msg = message_from_bytes(raw_data, policy=policy.default)
        subject = _decode_mime_words(msg.get("Subject", "(no subject)"))
        sender = _decode_mime_words(msg.get("From", "(unknown sender)"))
        date_str = msg.get("Date", "")
        # Truncate overly long sender display.
        if len(sender) > 50:
            sender = sender[:47] + "..."
        return f"[{uid:>8}]  {date_str[:25]:<26}  {sender:<52}  {subject}"
    except Exception as exc:
        return f"[{uid:>8}]  (parse failed: {exc})"


def _extract_body(msg: Message) -> tuple[str, str]:
    """
    Extract plain text body and HTML body from an email.
    Returns (plain_text, html_text).
    """
    plain_parts: list[str] = []
    html_parts: list[str] = []

    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            disposition = str(part.get("Content-Disposition", ""))
            # Skip attachments.
            if "attachment" in disposition:
                continue
            charset = part.get_content_charset() or "utf-8"
            payload = part.get_payload(decode=True)
            if payload is None:
                continue
            text = payload.decode(charset, errors="replace")
            if ctype == "text/plain":
                plain_parts.append(text)
            elif ctype == "text/html":
                html_parts.append(text)
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            charset = msg.get_content_charset() or "utf-8"
            text = payload.decode(charset, errors="replace")
            if msg.get_content_type() == "text/html":
                html_parts.append(text)
            else:
                plain_parts.append(text)

    return "\n".join(plain_parts), "\n".join(html_parts)


def _list_attachments(msg: Message) -> list[dict]:
    """List information for all attachments in an email."""
    attachments: list[dict] = []
    if not msg.is_multipart():
        return attachments

    for part in msg.walk():
        disposition = str(part.get("Content-Disposition", ""))
        if "attachment" in disposition:
            raw_fname = part.get_filename() or ""
            filename = _decode_mime_words(raw_fname) if raw_fname else "(unnamed)"
            content_type = part.get_content_type()
            payload = part.get_payload(decode=True)
            size_bytes = len(payload) if payload else 0
            attachments.append({
                "filename": filename,
                "content_type": content_type,
                "size_bytes": size_bytes,
            })
    return attachments


# ─── Batch FETCH Helpers ─────────────────────────────────────────────────────


def _batch_fetch_and_print_summaries(
    mail: imaplib.IMAP4_SSL, uid_list: list[str]
) -> None:
    """
    Fetch email headers in batches and print summaries.

    Join all UIDs with commas and perform a single IMAP FETCH, replacing N
    network round trips from per-message FETCH.
    Under VPN environments, a single RTT is about 100-300ms; 200 emails drop
    from 20-60s to <1s.

    IMAP batch FETCH responses alternate between (envelope, body) tuples and
    closing-paren bytes, so tuple entries must be filtered from msg_data to
    extract email data.
    """
    if not uid_list:
        return

    uid_csv = ",".join(uid_list)

    try:
        status, msg_data = mail.uid("fetch", uid_csv, "(BODY.PEEK[HEADER])")
    except imaplib.IMAP4.error as exc:
        # Some email providers may not support batch UID FETCH; fall back to per-message fetching.
        print(f"⚠️  Batch FETCH failed, falling back to per-message fetch: {exc}", file=sys.stderr)
        _fallback_fetch_and_print_summaries(mail, uid_list)
        return

    if status != "OK" or not msg_data:
        _fallback_fetch_and_print_summaries(mail, uid_list)
        return

    # Parse the batch FETCH response: extract the mapping from each UID to its header.
    # msg_data structure: [(b'uid_info', header_bytes), b')', (b'uid_info', header_bytes), b')', ...]
    uid_to_header: dict[str, bytes] = {}
    for item in msg_data:
        if not isinstance(item, tuple) or len(item) < 2:
            continue
        # item[0] has a format like b'123 (UID 456 BODY[HEADER] {size}'.
        envelope_line = item[0].decode("ascii", errors="replace") if isinstance(item[0], bytes) else str(item[0])
        uid_match = re.search(r"UID\s+(\d+)", envelope_line)
        if uid_match:
            uid_to_header[uid_match.group(1)] = item[1]

    # Output in the UID order specified by the caller (latest first).
    for uid in uid_list:
        if uid in uid_to_header:
            print(_parse_email_summary(uid, uid_to_header[uid]))
        else:
            print(f"[{uid:>8}]  (fetch failed)")


def _fallback_fetch_and_print_summaries(
    mail: imaplib.IMAP4_SSL, uid_list: list[str]
) -> None:
    """Per-message FETCH fallback used when batch FETCH is not supported by the provider."""
    for uid in uid_list:
        try:
            status, msg_data = mail.uid("fetch", uid, "(BODY.PEEK[HEADER])")
            if status != "OK" or not msg_data or msg_data[0] is None:
                print(f"[{uid:>8}]  (fetch failed)")
                continue
            raw_header: bytes = msg_data[0][1]  # type: ignore[index]
            print(_parse_email_summary(uid, raw_header))
        except imaplib.IMAP4.error:
            print(f"[{uid:>8}]  (fetch failed)")


# ─── Actions — IMAP ───────────────────────────────────────────────────────────


def action_list_emails(creds: dict, folder: str, count: int) -> None:
    """List summaries of the latest count emails in the specified folder."""
    count = min(count, MAX_LIST_COUNT)
    mail = _imap_connect(creds)

    try:
        _imap_select_folder(mail, folder)
        # Get all email UIDs (sorted by arrival time ascending).
        status, data = mail.uid("search", None, "ALL")
        if status != "OK":
            _fatal(f"Email search failed: {data}")

        uid_list: list[str] = data[0].decode().split()
        if not uid_list:
            print(f"📭 Folder '{folder}' has no emails.")
            return

        # Take the latest count emails (UID descending = latest first).
        recent_uids = uid_list[-count:][::-1]

        print(f"📬 Folder: {folder}  (total {len(uid_list)} emails, showing latest {len(recent_uids)} emails)")
        print(f"{'UID':>10}  {'Date':<26}  {'Sender':<52}  Subject")
        print("-" * 120)

        # Batch-fetch all UID headers: one IMAP round trip instead of N per-message FETCH calls.
        # Per-message FETCH for N emails = N RTTs; batch = 1 RTT, a major difference under VPN.
        _batch_fetch_and_print_summaries(mail, recent_uids)
    finally:
        mail.logout()


def action_read_email(creds: dict, uid: str) -> None:
    """Read the full content of a single email."""
    mail = _imap_connect(creds)

    try:
        _imap_select_folder(mail, "INBOX")
        status, msg_data = mail.uid("fetch", uid, "(RFC822)")
        if status != "OK" or not msg_data or msg_data[0] is None:
            _fatal(f"Failed to fetch email UID={uid}: {msg_data}")

        raw: bytes = msg_data[0][1]  # type: ignore[index]
        msg = message_from_bytes(raw, policy=policy.default)

        # Output email header information.
        print("=" * 80)
        print(f"  UID      : {uid}")
        print(f"  Subject   : {_decode_mime_words(msg.get('Subject', '(no subject)'))}")
        print(f"  Sender    : {_decode_mime_words(msg.get('From', ''))}")
        print(f"  Recipient : {_decode_mime_words(msg.get('To', ''))}")
        cc = msg.get("Cc", "")
        if cc:
            print(f"  CC        : {_decode_mime_words(cc)}")
        print(f"  Date      : {msg.get('Date', '')}")
        print(f"  Message-ID: {msg.get('Message-ID', '').strip()}")
        print("=" * 80)

        plain_body, html_body = _extract_body(msg)

        if plain_body.strip():
            print("\n[Body (plain text)]")
            print(plain_body.strip())
        elif html_body.strip():
            # When there is no plain text, output an HTML preview (tags removed).
            clean_html = re.sub(r"<[^>]+>", "", html_body)
            clean_html = re.sub(r"\s+", " ", clean_html).strip()
            preview = clean_html[:HTML_PREVIEW_CHARS]
            print("\n[Body (HTML preview, tags removed)]")
            print(preview)
            if len(clean_html) > HTML_PREVIEW_CHARS:
                print(f"\n... (body truncated, full HTML length {len(html_body)} characters)")
        else:
            print("\n(email body is empty)")

        # Attachment list.
        attachments = _list_attachments(msg)
        if attachments:
            print(f"\n[Attachment list (total {len(attachments)})]")
            for i, att in enumerate(attachments, 1):
                size_kb = att["size_bytes"] / 1024
                print(f"  {i}. {att['filename']}  ({att['content_type']}, {size_kb:.1f} KB)")
            print(f"\n💡 Use --action save_attachment --uid {uid} --output-dir <directory> to download attachments")
        else:
            print("\n(no attachments)")

    finally:
        mail.logout()


def action_search_emails(
    creds: dict,
    sender_filter: Optional[str],
    subject_filter: Optional[str],
    since_date: Optional[str],
    before_date: Optional[str],
    count: int,
) -> None:
    """Search emails by conditions and output a summary list."""
    count = min(count, MAX_LIST_COUNT)
    mail = _imap_connect(creds)

    try:
        _imap_select_folder(mail, "INBOX")

        # Build IMAP search criteria.
        criteria: list[str] = []

        if sender_filter:
            # IMAP FROM search matches sender address or name.
            criteria.extend(["FROM", f'"{sender_filter}"'])

        if subject_filter:
            criteria.extend(["SUBJECT", f'"{subject_filter}"'])

        if since_date:
            # IMAP date format: 01-Jan-2024.
            try:
                dt = datetime.strptime(since_date, "%Y-%m-%d")
                imap_date = dt.strftime("%d-%b-%Y")
                criteria.extend(["SINCE", imap_date])
            except ValueError:
                _fatal(f"--since date format error (expected YYYY-MM-DD): {since_date}")

        if before_date:
            try:
                dt = datetime.strptime(before_date, "%Y-%m-%d")
                imap_date = dt.strftime("%d-%b-%Y")
                criteria.extend(["BEFORE", imap_date])
            except ValueError:
                _fatal(f"--before date format error (expected YYYY-MM-DD): {before_date}")

        if not criteria:
            # No filters -> equivalent to list_emails ALL.
            criteria = ["ALL"]

        # IMAP search requires expanding criteria into multiple arguments.
        status, data = mail.uid("search", None, *criteria)
        if status != "OK":
            _fatal(f"Search failed: {data}")

        uid_list: list[str] = data[0].decode().split() if data[0] else []
        if not uid_list:
            print("🔍 No matching emails found.")
            return

        # Take the latest count emails.
        recent_uids = uid_list[-count:][::-1]

        print(f"🔍 Search results: found {len(uid_list)} emails, showing latest {len(recent_uids)} emails")
        print(f"{'UID':>10}  {'Date':<26}  {'Sender':<52}  Subject")
        print("-" * 120)

        # Batch-fetch all UID headers (shared with list_emails through the same batch FETCH function).
        _batch_fetch_and_print_summaries(mail, recent_uids)

    finally:
        mail.logout()


def action_mark_read(creds: dict, uid: str) -> None:
    """Mark the specified email as read."""
    _imap_flag_op(creds, uid, "+FLAGS", r"\Seen", "read")


def action_mark_unread(creds: dict, uid: str) -> None:
    """Mark the specified email as unread."""
    _imap_flag_op(creds, uid, "-FLAGS", r"\Seen", "unread")


def _imap_flag_op(creds: dict, uid: str, op: str, flag: str, label: str) -> None:
    """Generic IMAP flag operation."""
    mail = _imap_connect(creds)
    try:
        _imap_select_folder(mail, "INBOX")
        status, _ = mail.uid("store", uid, op, flag)
        if status != "OK":
            _fatal(f"Mark operation failed (uid={uid})")
        print(f"✅ Email UID={uid} marked as {label}")
    finally:
        mail.logout()


def action_delete_email(creds: dict, uid: str, permanent: bool) -> None:
    """
    Delete an email.
    - Default: move the email to the Trash/Deleted folder (folder names differ by provider)
    - --permanent: directly apply the \\Deleted flag and EXPUNGE
    """
    mail = _imap_connect(creds)
    try:
        _imap_select_folder(mail, "INBOX")

        if permanent:
            # Delete directly (EXPUNGE).
            mail.uid("store", uid, "+FLAGS", r"\Deleted")
            mail.expunge()
            print(f"✅ Email UID={uid} permanently deleted")
        else:
            # Try moving to Trash (folder names differ by provider).
            trash_candidates = ["Trash", "Deleted Items", "已删除邮件", "已删除", "[Gmail]/Trash"]
            moved = False
            for trash_folder in trash_candidates:
                status, _ = mail.uid("copy", uid, f'"{trash_folder}"')
                if status == "OK":
                    mail.uid("store", uid, "+FLAGS", r"\Deleted")
                    mail.expunge()
                    print(f"✅ Email UID={uid} moved to '{trash_folder}'")
                    moved = True
                    break

            if not moved:
                # Get the available folder list and prompt the user.
                _, folder_list = mail.list()
                folders = [f.decode() if isinstance(f, bytes) else f for f in (folder_list or [])]
                print(
                    f"⚠️  Could not automatically find the Trash folder; the email has been marked as deleted but was not moved.\n"
                    f"   Available folder list:\n" +
                    "\n".join(f"     {f}" for f in folders[:20]) +
                    f"\n   Please use --permanent to delete directly, or move it manually.",
                    file=sys.stderr,
                )
                # Fallback: mark as deleted but do not EXPUNGE, keeping it visible.
                mail.uid("store", uid, "+FLAGS", r"\Deleted")
                mail.expunge()

    finally:
        mail.logout()


def action_list_folders(creds: dict) -> None:
    """List all mailbox folders."""
    mail = _imap_connect(creds)
    try:
        status, folder_list = mail.list()
        if status != "OK":
            _fatal("Failed to get folder list")

        print(f"📁 Mail folder list (account: {creds['username']})")
        print("-" * 60)
        for item in (folder_list or []):
            raw = item.decode() if isinstance(item, bytes) else str(item)
            # IMAP LIST response format: (\Flags) "separator" "folder name".
            # Extract the last part (folder name) with a regular expression.
            match = re.match(r'\(.*?\)\s+"?.*?"?\s+"?(.+?)"?\s*$', raw)
            folder_name = match.group(1).strip('"') if match else raw
            print(f"  {folder_name}")
    finally:
        mail.logout()


def action_save_attachment(
    creds: dict,
    uid: str,
    output_dir: str,
    attachment_name: Optional[str],
) -> None:
    """Download and save attachments from the specified email to a local directory."""
    os.makedirs(output_dir, exist_ok=True)
    mail = _imap_connect(creds)

    try:
        _imap_select_folder(mail, "INBOX")
        status, msg_data = mail.uid("fetch", uid, "(RFC822)")
        if status != "OK" or not msg_data or msg_data[0] is None:
            _fatal(f"Failed to fetch email UID={uid}")

        raw: bytes = msg_data[0][1]  # type: ignore[index]
        msg = message_from_bytes(raw, policy=policy.default)

        saved_count = 0
        skipped_count = 0

        if msg.is_multipart():
            for part in msg.walk():
                disposition = str(part.get("Content-Disposition", ""))
                if "attachment" not in disposition:
                    continue

                raw_fname = part.get_filename() or f"attachment_{saved_count + 1}"
                filename = _decode_mime_words(raw_fname)

                # If a specific attachment name is provided, save only that attachment.
                if attachment_name and filename.lower() != attachment_name.lower():
                    skipped_count += 1
                    continue

                payload = part.get_payload(decode=True)
                if not payload:
                    print(f"⚠️  Attachment '{filename}' content is empty, skipping", file=sys.stderr)
                    continue

                # Handle filename conflicts.
                save_path = os.path.join(output_dir, filename)
                if os.path.exists(save_path):
                    base, ext = os.path.splitext(filename)
                    save_path = os.path.join(output_dir, f"{base}_{uid}{ext}")

                with open(save_path, "wb") as f:
                    f.write(payload)

                size_kb = len(payload) / 1024
                print(f"✅ Saved: {save_path}  ({size_kb:.1f} KB)")
                saved_count += 1

        if saved_count == 0:
            if attachment_name:
                print(f"⚠️  Attachment named '{attachment_name}' was not found. Please use read_email to view the attachment list first.")
            else:
                print(f"ℹ️  Email UID={uid} has no attachments.")
        else:
            print(f"\nSaved {saved_count} attachments to: {output_dir}")

    finally:
        mail.logout()


# ─── Actions — SMTP ───────────────────────────────────────────────────────────


def _build_mime_message(
    creds: dict,
    to_addrs: list[str],
    subject: str,
    body: str,
    is_html: bool,
    attachment_paths: list[str],
    cc_addrs: list[str],
    reply_to_message_id: Optional[str] = None,
    reply_to_subject: Optional[str] = None,
    reply_to_references: Optional[str] = None,
) -> MIMEMultipart:
    """
    Build a MIMEMultipart email object.
    When reply_to_message_id is non-empty, set the In-Reply-To and References
    headers automatically.
    """
    msg = MIMEMultipart("mixed")
    msg["From"] = creds["username"]
    msg["To"] = ", ".join(to_addrs)
    if cc_addrs:
        msg["Cc"] = ", ".join(cc_addrs)

    # Automatically build subject and thread headers for replies.
    if reply_to_message_id:
        subj = reply_to_subject or ""
        if not subj.lower().startswith("re:"):
            subj = f"Re: {subj}"
        msg["Subject"] = subject or subj
        msg["In-Reply-To"] = reply_to_message_id
        refs = reply_to_references or ""
        msg["References"] = f"{refs} {reply_to_message_id}".strip()
    else:
        msg["Subject"] = subject

    # Body part.
    body_mime = MIMEText(body, "html" if is_html else "plain", "utf-8")
    msg.attach(body_mime)

    # Attachment parts.
    for att_path in attachment_paths:
        if not os.path.isfile(att_path):
            print(f"⚠️  Attachment file does not exist, skipped: {att_path}", file=sys.stderr)
            continue

        mime_type, _ = mimetypes.guess_type(att_path)
        main_type, sub_type = (mime_type or "application/octet-stream").split("/", 1)

        with open(att_path, "rb") as f:
            att_data = f.read()

        att_mime = MIMEBase(main_type, sub_type)
        att_mime.set_payload(att_data)
        encoders.encode_base64(att_mime)
        att_mime.add_header(
            "Content-Disposition",
            "attachment",
            filename=os.path.basename(att_path),
        )
        msg.attach(att_mime)

    return msg


def _smtp_send(creds: dict, msg: MIMEMultipart, all_recipients: list[str]) -> str:
    """Send an email through SMTP and return the Message-ID."""
    host: str = creds["smtp_host"]
    port: int = int(creds["smtp_port"])
    username: str = creds["username"]
    password: str = creds["password"]
    use_tls: bool = bool(creds.get("smtp_use_tls", True))

    try:
        if use_tls:
            server = smtplib.SMTP(host, port, timeout=30)
            server.ehlo()
            server.starttls(context=ssl.create_default_context())
            server.ehlo()
        else:
            # Direct SSL connection (commonly port 465).
            ctx = ssl.create_default_context()
            server = smtplib.SMTP_SSL(host, port, context=ctx, timeout=30)

        server.login(username, password)
        server.sendmail(username, all_recipients, msg.as_string())
        server.quit()

        return msg.get("Message-ID", "(no Message-ID)")

    except smtplib.SMTPAuthenticationError as exc:
        _fatal(f"SMTP authentication failed: {exc}")
    except smtplib.SMTPException as exc:
        _fatal(f"SMTP send failed: {exc}")
    except OSError as exc:
        _fatal(f"Unable to connect to SMTP server ({host}:{port}): {exc}")


def action_send_email(
    creds: dict,
    to_addrs: list[str],
    subject: str,
    body: str,
    is_html: bool,
    attachment_paths: list[str],
    cc_addrs: list[str],
) -> None:
    """Send a new email."""
    if not to_addrs:
        _fatal("send_email requires at least one recipient (--to)")
    if not subject:
        _fatal("send_email requires the --subject argument")
    if body is None:
        _fatal("send_email requires the --body argument")

    msg = _build_mime_message(
        creds=creds,
        to_addrs=to_addrs,
        subject=subject,
        body=body,
        is_html=is_html,
        attachment_paths=attachment_paths,
        cc_addrs=cc_addrs,
    )

    all_recipients = to_addrs + cc_addrs
    msg_id = _smtp_send(creds, msg, all_recipients)
    print(f"✅ Email sent")
    print(f"   Recipients: {', '.join(to_addrs)}")
    print(f"   Subject   : {subject}")
    if cc_addrs:
        print(f"   CC        : {', '.join(cc_addrs)}")
    print(f"   Message-ID: {msg_id}")


def action_reply_email(
    creds: dict,
    uid: str,
    body: str,
    is_html: bool,
    attachment_paths: list[str],
    cc_addrs: list[str],
) -> None:
    """Reply to the specified UID email, automatically fetching the original email information and filling thread headers."""
    if not body:
        _fatal("reply_email requires the --body argument")

    # First read the original email headers through IMAP to get From / Message-ID / References / Subject.
    mail = _imap_connect(creds)
    try:
        _imap_select_folder(mail, "INBOX")
        status, msg_data = mail.uid("fetch", uid, "(BODY.PEEK[HEADER])")
        if status != "OK" or not msg_data or msg_data[0] is None:
            _fatal(f"Failed to fetch original email headers UID={uid}")
        raw_header: bytes = msg_data[0][1]  # type: ignore[index]
        orig = message_from_bytes(raw_header, policy=policy.default)
    finally:
        mail.logout()

    orig_from = _decode_mime_words(orig.get("From", ""))
    orig_subject = _decode_mime_words(orig.get("Subject", ""))
    orig_msg_id = orig.get("Message-ID", "").strip()
    orig_references = orig.get("References", "").strip()

    # Reply target is the original sender.
    # For group emails, Reply-To is more accurate.
    reply_to = orig.get("Reply-To", orig_from)
    to_addrs = [reply_to]

    msg = _build_mime_message(
        creds=creds,
        to_addrs=to_addrs,
        subject="",  # Re: subject is constructed internally.
        body=body,
        is_html=is_html,
        attachment_paths=attachment_paths,
        cc_addrs=cc_addrs,
        reply_to_message_id=orig_msg_id,
        reply_to_subject=orig_subject,
        reply_to_references=orig_references,
    )

    all_recipients = to_addrs + cc_addrs
    msg_id = _smtp_send(creds, msg, all_recipients)
    print(f"✅ Reply sent")
    print(f"   Reply to  : {', '.join(to_addrs)}")
    print(f"   Subject   : {msg['Subject']}")
    print(f"   Message-ID: {msg_id}")


# ─── Utility Functions ───────────────────────────────────────────────────────


def _fatal(message: str) -> None:
    """Output an error message to stderr and exit with code 1."""
    print(f"❌ {message}", file=sys.stderr)
    sys.exit(1)


def _parse_address_list(raw: Optional[str]) -> list[str]:
    """Parse a comma-separated email address list."""
    if not raw:
        return []
    return [addr.strip() for addr in raw.split(",") if addr.strip()]


def _resolve_body(body_inline: Optional[str], body_file: Optional[str], action_name: str) -> str:
    """
    Resolve the email body source, preferring file content.

    Design rationale: when the body is long, passing it directly through --body
    can make the command line too long. The exec tool may truncate the command,
    causing the script to fail with a non-zero exit code.
    The Agent should write the body to a temporary file first, then pass it via
    --body-file to fully avoid command-line length limits.
    """
    # Prefer reading from file (suitable for long bodies).
    if body_file:
        if not os.path.isfile(body_file):
            _fatal(f"{action_name}: file specified by --body-file does not exist: {body_file}")
        try:
            with open(body_file, "r", encoding="utf-8") as f:
                content = f.read()
            if not content.strip():
                _fatal(f"{action_name}: --body-file file content is empty: {body_file}")
            return content
        except OSError as exc:
            _fatal(f"{action_name}: failed to read body file: {exc}")

    # Fall back to inline body.
    if body_inline:
        return body_inline

    _fatal(
        f"{action_name} requires a body.\n"
        "  Short body: use --body \"content\"\n"
        "  Long body: write the content to a file first, then use --body-file /path/to/body.txt"
    )



# ─── CLI Entry ───────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description="AgentVis Email helper - manage email via IMAP/SMTP",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  list_emails:     python email_helper.py --action list_emails --count 10
  read_email:      python email_helper.py --action read_email --uid 12345
  search_emails:   python email_helper.py --action search_emails --from user@x.com --subject invoice
  send_email:      python email_helper.py --action send_email --to a@b.com --subject test --body hello
  reply_email:     python email_helper.py --action reply_email --uid 12345 --body "Received, thank you"
  mark_read:       python email_helper.py --action mark_read --uid 12345
  mark_unread:     python email_helper.py --action mark_unread --uid 12345
  delete_email:    python email_helper.py --action delete_email --uid 12345
  list_folders:    python email_helper.py --action list_folders
  save_attachment: python email_helper.py --action save_attachment --uid 12345 --output-dir C:/Downloads/
""",
    )
    parser.add_argument(
        "--action",
        required=True,
        choices=[
            "setup_account",
            "network_targets",
            "list_emails",
            "read_email",
            "search_emails",
            "send_email",
            "reply_email",
            "mark_read",
            "mark_unread",
            "delete_email",
            "list_folders",
            "save_attachment",
        ],
        help="Operation type",
    )
    parser.add_argument("--account", default=DEFAULT_ACCOUNT, help=f"Account alias (default: {DEFAULT_ACCOUNT})")

    # Shared by list_emails / search_emails.
    parser.add_argument("--folder", default="INBOX", help="Mail folder name (default: INBOX)")
    parser.add_argument("--count", type=int, default=DEFAULT_LIST_COUNT, help=f"Number of emails to return (default: {DEFAULT_LIST_COUNT}, max: {MAX_LIST_COUNT})")

    # Shared by read / reply / mark / delete / save_attachment.
    parser.add_argument("--uid", default=None, help="Email UID")

    # Dedicated to search_emails.
    parser.add_argument("--from", dest="sender", default=None, help="Sender address filter")
    parser.add_argument("--subject", default=None, help="Subject keyword filter / email subject for sending")
    parser.add_argument("--since", default=None, help="Search start date (YYYY-MM-DD)")
    parser.add_argument("--before", default=None, help="Search end date (YYYY-MM-DD)")

    # Dedicated to send_email / reply_email.
    parser.add_argument("--to", default=None, help="Recipient addresses (comma-separated)")
    parser.add_argument("--cc", default=None, help="CC addresses (comma-separated)")
    parser.add_argument("--body", default=None, help="Email body (suitable for short text; use --body-file for long bodies)")
    parser.add_argument("--body-file", "--body_file", default=None,
                        help="Body file path (prefer this instead of --body for longer content to avoid command-line length limits)")
    parser.add_argument("--html", action="store_true", help="Send body as HTML")
    parser.add_argument("--attachment", action="append", default=[], help="Attachment path (can be specified multiple times)")

    # Dedicated to delete_email.
    parser.add_argument("--permanent", action="store_true", help="Delete permanently directly (do not move to Trash)")

    # Dedicated to save_attachment.
    parser.add_argument("--output-dir", "--output_dir", default=None, help="Directory to save attachments")
    parser.add_argument("--attachment-name", "--attachment_name", default=None, help="Specify the attachment filename to save (omit to save all)")

    # Dedicated setup_account arguments (credential fields passed independently to avoid shell escaping issues).
    parser.add_argument("--imap-host", "--imap_host", default=None, help="IMAP server address")
    parser.add_argument("--imap-port", "--imap_port", type=int, default=993, help="IMAP port (default 993)")
    parser.add_argument("--smtp-host", "--smtp_host", default=None, help="SMTP server address")
    parser.add_argument("--smtp-port", "--smtp_port", type=int, default=587, help="SMTP port (default 587)")
    parser.add_argument("--username", default=None, help="Email login username (email address)")
    parser.add_argument("--password", default=None, help="Email login password or authorization code")
    parser.add_argument("--no-tls", action="store_true", help="Disable STARTTLS (use direct SSL connection instead, suitable for port 465)")

    args = parser.parse_args()

    # setup_account does not require existing credentials; handle it separately first.
    if args.action == "setup_account":
        missing_setup: list[str] = []
        if not args.imap_host:
            missing_setup.append("--imap-host")
        if not args.smtp_host:
            missing_setup.append("--smtp-host")
        if not args.username:
            missing_setup.append("--username")
        if not args.password:
            missing_setup.append("--password")
        if missing_setup:
            _fatal(f"setup_account is missing required arguments: {', '.join(missing_setup)}")
        action_setup_account(
            account=args.account,
            imap_host=args.imap_host,
            imap_port=args.imap_port,
            smtp_host=args.smtp_host,
            smtp_port=args.smtp_port,
            username=args.username,
            password=args.password,
            smtp_use_tls=not args.no_tls,
        )
        return

    # Load credentials (all other operations require credentials).
    creds = load_email_credentials(args.account)

    if args.action == "network_targets":
        action_network_targets(creds, args.account)
        return

    # ── Dispatch Action ─────────────────────────────────────────────────────

    if args.action == "list_emails":
        action_list_emails(creds, folder=args.folder, count=args.count)

    elif args.action == "read_email":
        if not args.uid:
            _fatal("read_email operation requires the --uid argument")
        action_read_email(creds, uid=args.uid)

    elif args.action == "search_emails":
        action_search_emails(
            creds,
            sender_filter=args.sender,
            subject_filter=args.subject,
            since_date=args.since,
            before_date=args.before,
            count=args.count,
        )

    elif args.action == "send_email":
        body_content = _resolve_body(args.body, args.body_file, action_name="send_email")
        action_send_email(
            creds,
            to_addrs=_parse_address_list(args.to),
            subject=args.subject or "",
            body=body_content,
            is_html=args.html,
            attachment_paths=args.attachment,
            cc_addrs=_parse_address_list(args.cc),
        )

    elif args.action == "reply_email":
        if not args.uid:
            _fatal("reply_email operation requires the --uid argument")
        body_content = _resolve_body(args.body, args.body_file, action_name="reply_email")
        action_reply_email(
            creds,
            uid=args.uid,
            body=body_content,
            is_html=args.html,
            attachment_paths=args.attachment,
            cc_addrs=_parse_address_list(args.cc),
        )

    elif args.action == "mark_read":
        if not args.uid:
            _fatal("mark_read operation requires the --uid argument")
        action_mark_read(creds, uid=args.uid)

    elif args.action == "mark_unread":
        if not args.uid:
            _fatal("mark_unread operation requires the --uid argument")
        action_mark_unread(creds, uid=args.uid)

    elif args.action == "delete_email":
        if not args.uid:
            _fatal("delete_email operation requires the --uid argument")
        action_delete_email(creds, uid=args.uid, permanent=args.permanent)

    elif args.action == "list_folders":
        action_list_folders(creds)

    elif args.action == "save_attachment":
        if not args.uid:
            _fatal("save_attachment operation requires the --uid argument")
        if not args.output_dir:
            _fatal("save_attachment operation requires the --output-dir argument")
        action_save_attachment(
            creds,
            uid=args.uid,
            output_dir=args.output_dir,
            attachment_name=args.attachment_name,
        )


if __name__ == "__main__":
    main()
