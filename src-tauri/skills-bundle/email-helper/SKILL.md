---
name: email-helper
description: Handle email tasks via IMAP/SMTP from the command line. Always use this skill whenever the user asks the Agent to check emails, read or list inbox messages, search for emails by sender or subject, send or reply to an email, save attachments, manage folders, or mark messages as read/unread. The skill automatically retrieves credentials from Windows Credential Manager. If the credentials are not yet configured or have expired, guide the user to obtain new credentials, and then help the user set them up once provided. (re-generation and provision of credentials is only required if security checks cause them to expire).
triggers: [email, 邮件, 发邮件, 查邮件, 回复邮件, 收件箱, inbox, smtp, imap, 邮箱, mail, send email, check email, reply email, 邮件附件, attachment, 邮件搜索, search email]
agentvisNetworkEntrypoints:
  scripts/email_helper.py: legacyNonHttp
---

# email-helper skill for AgentVis - Email Sending and Receiving Assistant Skill

In `ControlledNetwork`, run `python scripts/email_helper.py --action network_targets --account <account>` first to print the IMAP/SMTP host and port without opening a network connection. Use those targets only for an explicit direct-audit allowance; do not describe IMAP/SMTP as broker-proxied.

> ⚠️ **Credentials are fully managed automatically; no manual password search or password passing is needed!**
> Run the script commands below directly. Credentials are automatically read from Windows Credential Manager.
> If credentials have not yet been configured, the script will give clear guidance, and the Agent must not try to obtain the password through other methods.

Receive and manage email through the IMAP protocol, and send email through the SMTP protocol. Zero third-party dependencies; uses the Python standard library.
For sending email, uniformly recommend `--no-tls` (direct SSL connection), and fall back to not using this parameter only if it fails directly.

---

## ⚠️ Execution Notes

- **Timeout must be set**: When running any command from this skill, you **must** set `timeout >= 120` (seconds). IMAP connections require SSL handshakes and mailbox login, plus keyring credential reading, so cold startup takes significantly longer than ordinary scripts. The default 60 seconds is very likely to time out in VPN/proxy environments.
- **Large-batch searches**: When the `--count` value is large (100-200), `timeout: 180` is recommended.
- **Sending email**: SMTP also requires SSL + authentication; `timeout: 120` is recommended.

---

## Core Command Quick Reference

```bash
# [Must be completed first on initial use] Store mailbox credentials (avoids shell escaping problems)
python scripts/email_helper.py --action setup_account \
  --imap-host imap.qq.com --imap-port 993 \
  --smtp-host smtp.qq.com --smtp-port 587 \
  --username you@qq.com --password your_authorization_code

# List the latest N emails in the inbox (default 20)
python scripts/email_helper.py --action list_emails [--count 20] [--folder INBOX]

# Read the full content of a single email (plain text + HTML summary + attachment list)
python scripts/email_helper.py --action read_email --uid <UID>

# Search emails by conditions
python scripts/email_helper.py --action search_emails [--from "sender@example.com"] [--subject "keyword"] [--since 2024-01-01] [--before 2024-12-31] [--count 50]

# Send a new email (use --body directly for a short body)
python scripts/email_helper.py --action send_email --to "rcpt@example.com" --subject "subject" --body "body content" [--attachment "/path/to/file.pdf"] [--html]

# ⚡ Send a long-body email (write to a temp file first, then pass it with --body-file to avoid command-line truncation)
# Step 1: write the body content to a file
python -c "open('C:/tmp/email_body.txt','w',encoding='utf-8').write('your long body content...')"
# Step 2: send
python scripts/email_helper.py --action send_email --to "rcpt@example.com" --subject "subject" --body-file "C:/tmp/email_body.txt"

# Reply to an email (automatically fills In-Reply-To and References headers)
python scripts/email_helper.py --action reply_email --uid <UID> --body "reply content" [--attachment "/path/to/file"] [--html]

# Mark email as read / unread
python scripts/email_helper.py --action mark_read --uid <UID>
python scripts/email_helper.py --action mark_unread --uid <UID>

# Delete email (move to Trash/Deleted folder; some providers support direct deletion with --permanent)
python scripts/email_helper.py --action delete_email --uid <UID> [--permanent]

# List all mail folders
python scripts/email_helper.py --action list_folders

# Save attachments locally
python scripts/email_helper.py --action save_attachment --uid <UID> --output-dir "/path/to/save/" [--attachment-name "specific attachment name; omit to save all"]

# Multiple accounts: specify account alias with --account (default default)
python scripts/email_helper.py --action list_emails --account work
```

> The script path is relative to the current skill directory. The Agent should use the absolute path of the skill directory:
> `C:\Users\<User>\AppData\Roaming\com.agentvis.app\skills\external\packages\email-helper\scripts\email_helper.py`

---

## Parameter Reference

| Parameter | Description | Applicable Action |
|------|------|-------------|
| `--action` | Operation type (required, see quick reference above) | All |
| `--account` | Account alias (default `default`) | All |
| `--imap-host` | IMAP server address | setup_account |
| `--imap-port` | IMAP port (default 993) | setup_account |
| `--smtp-host` | SMTP server address | setup_account |
| `--smtp-port` | SMTP port (default 587) | setup_account |
| `--username` | Email address | setup_account |
| `--password` | Login password or authorization code | setup_account |
| `--no-tls` | Disable STARTTLS and use direct SSL connection instead (for port 465) | setup_account |
| `--uid` | Email UID (output by `list_emails`/`search_emails`) | read, reply, mark_*, delete, save_attachment |
| `--folder` | Mail folder name (default `INBOX`) | list_emails |
| `--count` | Maximum number of returned emails (default 20, maximum 200) | list_emails, search_emails |
| `--from` | Sender address filter | search_emails |
| `--subject` | Subject keyword filter / sending subject | search_emails, send_email |
| `--since` | Start date, format `YYYY-MM-DD` | search_emails |
| `--before` | End date, format `YYYY-MM-DD` | search_emails |
| `--to` | Recipient address (comma-separated for multiple recipients) | send_email |
| `--cc` | CC address (comma-separated) | send_email, reply_email |
| `--body` | Email body | send_email, reply_email |
| `--html` | Send body as HTML | send_email, reply_email |
| `--attachment` | Local attachment path (can be specified multiple times) | send_email, reply_email |
| `--permanent` | Delete directly instead of moving to trash | delete_email |
| `--output-dir` | Attachment save directory | save_attachment |
| `--attachment-name` | Attachment file name to save (omit to save all) | save_attachment |

---

## Credential Configuration

> **Credentials must be configured before first use. Use the `setup_account` action instead of a Python one-liner to completely avoid shell escaping failures when passwords contain special characters.**

### QQ Mail Example
```bash
python scripts/email_helper.py --action setup_account \
  --imap-host imap.qq.com --imap-port 993 \
  --smtp-host smtp.qq.com --smtp-port 587 \
  --username 570870247@qq.com --password your_authorization_code
```

### Gmail Example
```bash
python scripts/email_helper.py --action setup_account \
  --imap-host imap.gmail.com --imap-port 993 \
  --smtp-host smtp.gmail.com --smtp-port 587 \
  --username you@gmail.com --password your_app_password
```

### 163 Mail Example (Direct SSL Port 465)
```bash
python scripts/email_helper.py --action setup_account \
  --imap-host imap.163.com --imap-port 993 \
  --smtp-host smtp.163.com --smtp-port 465 --no-tls \
  --username you@163.com --password client_authorization_password
```

### Fallback Method (Only When setup_account Is Unavailable)
```bash
python -c "import keyring, json; keyring.set_password('email_credentials_default.AgentVis', '', json.dumps({'imap_host': 'imap.qq.com', 'imap_port': 993, 'smtp_host': 'smtp.qq.com', 'smtp_port': 587, 'username': 'YOU@qq.com', 'password': 'AUTHCODE', 'smtp_use_tls': True}))"
```

---

## Common Email Provider Configuration Reference

> **VPN users note**: 587/STARTTLS is rejected by email providers on many VPN exit nodes. **Uniformly use port 465 + `--no-tls` (direct SSL connection)**.

| Provider | IMAP Server | IMAP Port | SMTP Server | SMTP Port | Recommended Command Parameters |
|--------|------------|-----------|------------|-----------|------------|
| Gmail | imap.gmail.com | 993 | smtp.gmail.com | **465** | `--smtp-port 465 --no-tls` |
| QQ Mail | imap.qq.com | 993 | smtp.qq.com | **465** | `--smtp-port 465 --no-tls` |
| Outlook/Hotmail | outlook.office365.com | 993 | smtp.office365.com | 587 | `--smtp-port 587` |
| 163 Mail | imap.163.com | 993 | smtp.163.com | **465** | `--smtp-port 465 --no-tls` |
| Enterprise mailbox | Ask administrator | 993 | Ask administrator | 587/465 | Contact IT to obtain |

> Gmail requires enabling **2-Step Verification** first and generating an **app password** (16 digits). Do not use the account's main password.

---

## Recommended Workflow

### Handling User Inbox Tasks

1. **Get email list**: first use `list_emails` to understand recent email summaries and confirm UID
2. **Read as needed**: use `read_email --uid <UID>` to read fully, and pay attention to the attachment list in the output
3. **Reply or forward**: use `reply_email` to preserve thread continuity; use `send_email` for new emails
4. **Mark/archive**: after the task is complete, use `mark_read` to mark it processed

### Search for Specific Emails

```bash
# Search all recent emails from a client
python scripts/email_helper.py --action search_emails --from "client@company.com" --since 2024-01-01 --count 50

# Search unread emails containing a specific subject
python scripts/email_helper.py --action search_emails --subject "invoice" --count 20
```

### Save Attachments in Bulk

```bash
# After finding an email with attachments, save in bulk
python scripts/email_helper.py --action save_attachment --uid 12345 --output-dir "C:/Users/Admin/Downloads/email_attachments/"
```

---

## Output Format Notes

- `list_emails`: one email per line, format: `[UID] [date] [sender] [subject] [read/unread]`
- `read_email`: full email headers + plain text body + HTML body summary (up to 500 characters) + attachment list
- `search_emails`: same format as `list_emails`, but filtered by search conditions
- `send_email`/`reply_email`: on success outputs `✅ Email sent, Message-ID: <...>`
- All errors are output to stderr, exit code is non-zero

---

## Dependencies

- Python standard library: `imaplib`, `smtplib`, `email`, `ssl`, `argparse` (**no third-party libraries need to be installed**)
- `keyring` library: reads Windows Credential Manager credentials

```bash
# keyring is usually already installed with the AgentVis Python Runtime; if not installed:
pip install keyring
```
