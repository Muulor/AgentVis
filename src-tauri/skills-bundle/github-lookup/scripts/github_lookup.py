"""
GitHub Lookup — GitHub repository information lookup CLI

Search repositories, read README and source files, browse directory structures,
and view Release and Issue lists through the GitHub REST API. No extra
dependencies are required except httpx.

Usage:
    python github_lookup.py search "langchain"
    python github_lookup.py info langchain-ai/langchain
    python github_lookup.py readme langchain-ai/langchain
    python github_lookup.py tree langchain-ai/langchain
    python github_lookup.py file langchain-ai/langchain README.md
    python github_lookup.py releases langchain-ai/langchain
    python github_lookup.py issues langchain-ai/langchain
"""

import argparse
import base64
import io
import json
import os
import re
import subprocess
import sys
import textwrap
from datetime import datetime
from urllib.parse import quote, urlencode, urlparse

# Windows terminals do not support UTF-8 by default; force UTF-8 output.
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

try:
    import httpx
except ImportError:
    print("[!] Missing httpx library. Please install it first: pip install httpx")
    sys.exit(1)


# ==================== Constants ====================

GITHUB_API_BASE = "https://api.github.com"

# Default request headers: GitHub API recommends using the Accept header to specify the version.
DEFAULT_HEADERS: dict[str, str] = {
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "AgentVis-GitHub-Lookup/1.0",
}

# Default maximum README character count (avoid overly long READMEs consuming Agent context).
DEFAULT_README_MAX_CHARS = 8000

# Default maximum file content character count.
DEFAULT_FILE_MAX_CHARS = 10000

# Output separator width.
SEPARATOR_WIDTH = 70

# Graphical prefixes for directory trees.
TREE_PIPE = "│   "
TREE_TEE = "├── "
TREE_LAST = "└── "
TREE_SPACE = "    "

# ==================== HTTP Client ====================

class GitHubAPIError(Exception):
    """GitHub API request exception, including HTTP status code and error message."""

    def __init__(self, status_code: int, message: str) -> None:
        self.status_code = status_code
        self.message = message
        super().__init__(f"GitHub API Error ({status_code}): {message}")


def create_client() -> httpx.Client:
    """
    Create a GitHub API HTTP client.

    Authentication is broker-managed in AgentVis brokerOnly mode. The script
    process never reads tokens from env, Home/AppData, or Credential Manager.
    Outside brokerOnly mode this client intentionally stays anonymous.
    """
    headers = DEFAULT_HEADERS.copy()

    return httpx.Client(
        base_url=GITHUB_API_BASE,
        headers=headers,
        timeout=30.0,
        follow_redirects=True,
    )


# Number of automatic network request retries (for occasional timeouts and disconnects).
MAX_API_RETRIES = 1


class CaseInsensitiveHeaders(dict):
    def get(self, key, default=None):
        return super().get(str(key).lower(), default)


class BrokerHTTPResponse:
    """Small response adapter used when the AgentVis broker helper is active."""

    def __init__(
        self,
        status_code: int,
        headers: list[dict],
        body_base64: str | None,
        credential_applied: bool = False,
    ) -> None:
        self.status_code = status_code
        self.credential_applied = credential_applied
        self.headers = CaseInsensitiveHeaders({
            str(item.get("name", "")).lower(): str(item.get("value", ""))
            for item in headers
            if item.get("name")
        })
        body = base64.b64decode(body_base64 or "")
        self.text = body.decode("utf-8", errors="replace")

    def json(self) -> dict | list:
        return json.loads(self.text)


def broker_helper_available() -> bool:
    return bool(
        os.environ.get("AGENTVIS_BROKER_FETCH")
        and os.environ.get("AGENTVIS_BROKER_PIPE")
        and os.environ.get("AGENTVIS_BROKER_TOKEN")
    )


def broker_failure_diagnostics(payload: dict, url: str) -> str:
    """Return stable broker diagnostics for Agent observations."""
    lines = []
    reason_code = str(payload.get("reasonCode") or "").strip()
    error_kind = str(payload.get("errorKind") or "").strip()
    if reason_code:
        lines.append(f"brokerReasonCode: {reason_code}")
    if error_kind:
        lines.append(f"brokerErrorKind: {error_kind}")
    target_host = str(payload.get("targetHost") or urlparse(url).hostname or "").strip()
    if target_host:
        lines.append(f"brokerTargetHost: {target_host}")
    credential_ref = str(payload.get("credentialRef") or "").strip()
    if credential_ref:
        lines.append(f"brokerCredentialRef: {credential_ref}")
    if "credentialApplied" in payload:
        lines.append(f"credentialApplied: {bool(payload.get('credentialApplied'))}")
    if not lines:
        return ""
    return "\n" + "\n".join(lines)


def build_broker_url(endpoint: str, params: dict[str, str | int] | None = None) -> str:
    url = f"{GITHUB_API_BASE}{endpoint}"
    if params:
        url = f"{url}?{urlencode(params)}"
    return url


def broker_get_response(
    url: str,
    headers: dict[str, str],
    timeout_seconds: int = 30,
    credential_ref: str | None = None,
) -> BrokerHTTPResponse:
    helper = os.environ.get("AGENTVIS_BROKER_FETCH") or "agentvis-broker-fetch"
    request = {
        "method": "GET",
        "url": url,
        "headers": [
            {"name": name, "value": value}
            for name, value in headers.items()
            if value
        ],
        "timeoutMs": timeout_seconds * 1000,
    }
    if credential_ref:
        request["credentialRef"] = credential_ref
    completed = subprocess.run(
        [helper],
        input=json.dumps(request),
        text=True,
        capture_output=True,
        timeout=timeout_seconds + 10,
        check=False,
    )
    try:
        payload = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise GitHubAPIError(0, f"Broker helper returned invalid JSON: {exc}") from exc

    if completed.returncode != 0 or payload.get("ok") is not True:
        error = payload.get("error") or completed.stderr or "unknown broker helper failure"
        raise GitHubAPIError(0, f"Broker helper request failed: {error}{broker_failure_diagnostics(payload, url)}")

    return BrokerHTTPResponse(
        status_code=int(payload.get("status") or 0),
        headers=payload.get("headers") or [],
        body_base64=payload.get("bodyBase64"),
        credential_applied=bool(payload.get("credentialApplied")),
    )


def api_get(client: httpx.Client, endpoint: str, params: dict[str, str | int] | None = None) -> dict | list:
    """
    Send a GitHub API GET request and return the parsed JSON.

    Automatically handles common error codes and network exceptions, with one
    built-in automatic retry.
    - 401: Token is invalid
    - 403: API quota exhausted
    - 404: Repository/resource does not exist
    """
    last_error: Exception | None = None

    if broker_helper_available():
        response = broker_get_response(
            build_broker_url(endpoint, params),
            {
                "Accept": client.headers.get("Accept", DEFAULT_HEADERS["Accept"]),
                "User-Agent": client.headers.get("User-Agent", DEFAULT_HEADERS["User-Agent"]),
            },
            credential_ref="github",
        )
    else:
        for attempt in range(MAX_API_RETRIES + 1):
            try:
                response = client.get(endpoint, params=params)
                break
            except httpx.TimeoutException:
                last_error = GitHubAPIError(0, "Request timed out (30 seconds). Please check the network connection or use a proxy")
                if attempt < MAX_API_RETRIES:
                    import time
                    time.sleep(2)
                    continue
                raise last_error
            except httpx.ConnectError:
                last_error = GitHubAPIError(0, "Unable to connect to api.github.com. Please check network or proxy settings")
                if attempt < MAX_API_RETRIES:
                    import time
                    time.sleep(2)
                    continue
                raise last_error
        else:
            raise last_error or GitHubAPIError(0, "Request failed (already retried)")

    if response.status_code == 200:
        return response.json()

    # Parse the error message.
    try:
        error_data = response.json()
        error_msg = error_data.get("message", "Unknown error")
    except (json.JSONDecodeError, ValueError):
        error_msg = response.text[:200]

    broker_mode = broker_helper_available()
    if response.status_code == 401:
        update_hint = (
            "Please update the GitHub Token in the AgentVis GitHub token setting.\n"
            if broker_mode
            else "Run this skill through AgentVis brokerOnly mode so the broker can apply the configured GitHub token.\n"
        )
        raise GitHubAPIError(401, (
            f"Authentication failed: {error_msg}\n"
            "[Important: after the task ends, the following information must be reported to MB for user feedback]\n"
            "The currently configured GitHub Token is invalid (possibly expired or revoked).\n"
            f"{update_hint}"
        ))
    if response.status_code == 403:
        # Check whether this is a rate limit.
        remaining = response.headers.get("X-RateLimit-Remaining", "?")
        reset_timestamp = response.headers.get("X-RateLimit-Reset", "")
        reset_hint = ""
        if reset_timestamp:
            try:
                reset_time = datetime.fromtimestamp(int(reset_timestamp))
                reset_hint = f" (limit resets at {reset_time.strftime('%H:%M:%S')})"
            except (ValueError, OSError):
                pass
        # Check whether a Token is configured and provide different guidance.
        has_token = bool(getattr(response, "credential_applied", False))
        if has_token:
            raise GitHubAPIError(403, (
                f"API quota exhausted (remaining={remaining}){reset_hint}\n"
                "[Important: after the task ends, the following information must be reported to MB for user feedback]\n"
                "A Token is currently configured, but the 5000 requests/hour quota has been used up.\n"
                f"Please try again later{reset_hint}, or check whether another program is sharing this Token's quota."
            ))
        else:
            configure_hint = (
                "Please guide the user to create a Personal Access Token and configure it in the AgentVis GitHub token setting.\n"
                if broker_mode
                else "Run this skill through AgentVis brokerOnly mode and configure the GitHub provider token in AgentVis.\n"
            )
            raise GitHubAPIError(403, (
                f"API quota exhausted (remaining={remaining}){reset_hint}\n"
                "[Important: after the task ends, the following information must be reported to MB for user feedback]\n"
                "No GitHub Token is currently configured. The anonymous-mode limit is only 60 requests/hour and has been exhausted.\n"
                f"After configuring a Token, the limit can be increased to 5000 requests/hour. {configure_hint}"
            ))
    if response.status_code == 404:
        raise GitHubAPIError(404, f"Resource does not exist: {error_msg}")

    raise GitHubAPIError(response.status_code, error_msg)


# ==================== Utility Functions ====================

def parse_repo(repo_str: str) -> tuple[str, str]:
    """
    Parse a repository identifier into an (owner, repo) tuple.

    Supports multiple formats:
    - owner/repo
    - https://github.com/owner/repo
    - github.com/owner/repo
    """
    # Remove the URL prefix.
    cleaned = re.sub(r'https?://(www\.)?github\.com/', '', repo_str.strip())
    cleaned = cleaned.strip('/')

    parts = cleaned.split('/')
    if len(parts) < 2:
        print(f"[!] Invalid repository format: '{repo_str}'")
        print("    Please use the owner/repo format (for example, langchain-ai/langchain)")
        sys.exit(0)

    return parts[0], parts[1]


def truncate_text(text: str, max_chars: int) -> str:
    """Truncate text and add a truncation notice."""
    if len(text) <= max_chars:
        return text
    truncated = text[:max_chars].rstrip()
    # Try to truncate at a line boundary.
    last_newline = truncated.rfind('\n')
    if last_newline > max_chars * 0.8:
        truncated = truncated[:last_newline]
    return truncated + f"\n\n... [truncated, original text has {len(text)} characters]"


def format_number(n: int) -> str:
    """Format large numbers into readable form (for example, 12345 -> 12.3k)."""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def format_date(date_str: str | None) -> str:
    """Format an ISO date string into readable form."""
    if not date_str:
        return "N/A"
    try:
        dt = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
        return dt.strftime("%Y-%m-%d")
    except (ValueError, AttributeError):
        return date_str[:10] if date_str else "N/A"


def format_size(size_bytes: int) -> str:
    """Convert byte count into readable form."""
    if size_bytes >= 1_048_576:
        return f"{size_bytes / 1_048_576:.1f} MB"
    if size_bytes >= 1_024:
        return f"{size_bytes / 1_024:.1f} KB"
    return f"{size_bytes} B"


# ==================== Command Handlers ====================

def cmd_search(args: argparse.Namespace) -> None:
    """
    Search GitHub repositories.

    Uses the GitHub Search API and supports various search qualifiers:
    - language:python     -> filter by language
    - stars:>1000         -> filter by Star count
    - topic:machine-learning -> filter by topic
    """
    client = create_client()

    params: dict[str, str | int] = {
        "q": args.query,
        "sort": args.sort,
        "order": "desc",
        "per_page": args.limit,
    }

    print(f"🔍 GitHub Search: \"{args.query}\"")
    print(f"   Sort: {args.sort} | Limit: {args.limit}")

    try:
        data = api_get(client, "/search/repositories", params=params)
    except GitHubAPIError as e:
        print(f"\n[!] {e}")
        sys.exit(0)
    finally:
        client.close()

    items = data.get("items", [])
    total_count = data.get("total_count", 0)

    if not items:
        print("\n  No matching repositories found.")
        return

    for idx, repo in enumerate(items, 1):
        stars = format_number(repo.get("stargazers_count", 0))
        forks = format_number(repo.get("forks_count", 0))
        lang = repo.get("language") or "N/A"
        updated = format_date(repo.get("updated_at"))
        desc = repo.get("description") or "(no description)"
        if len(desc) > 120:
            desc = desc[:120] + "..."

        print(f"\n  {idx}. {repo['full_name']}  ⭐ {stars}  🍴 {forks}")
        print(f"     Language: {lang}  |  Updated: {updated}")
        print(f"     {desc}")
        print(f"     {repo['html_url']}")

    print(f"\n📊 {format_number(total_count)} matching repositories in total (showing the first {len(items)})")


def cmd_info(args: argparse.Namespace) -> None:
    """
    Get basic repository information.

    Shows complete repository metadata: description, Star/Fork counts,
    language, license, topics, and more.
    """
    owner, repo = parse_repo(args.repo)
    client = create_client()

    try:
        data = api_get(client, f"/repos/{owner}/{repo}")
    except GitHubAPIError as e:
        print(f"\n[!] {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        client.close()

    print(f"\n{'='*SEPARATOR_WIDTH}")
    print(f"  📦 {data['full_name']}")
    print(f"{'='*SEPARATOR_WIDTH}")
    print(f"  Description: {data.get('description') or '(no description)'}")
    print(f"  URL: {data['html_url']}")
    print(f"  ⭐ Stars: {format_number(data.get('stargazers_count', 0))}")
    print(f"  🍴 Forks: {format_number(data.get('forks_count', 0))}")
    print(f"  👁️  Watchers: {format_number(data.get('subscribers_count', 0))}")
    print(f"  🐛 Open Issues: {format_number(data.get('open_issues_count', 0))}")
    print(f"  Language: {data.get('language') or 'N/A'}")
    print(f"  License: {data.get('license', {}).get('name', 'N/A') if data.get('license') else 'N/A'}")
    print(f"  Default Branch: {data.get('default_branch', 'main')}")
    print(f"  Created: {format_date(data.get('created_at'))}")
    print(f"  Updated: {format_date(data.get('updated_at'))}")
    print(f"  Size: {format_size(data.get('size', 0) * 1024)}")

    # Topics.
    topics = data.get("topics", [])
    if topics:
        print(f"  Topics: {', '.join(topics)}")

    # Homepage
    homepage = data.get("homepage")
    if homepage:
        print(f"  Homepage: {homepage}")

    print(f"{'='*SEPARATOR_WIDTH}")


def cmd_readme(args: argparse.Namespace) -> None:
    """
    Get repository README content.

    Fetches the Base64-encoded README content through the GitHub API and
    decodes it to text.
    Supports controlling the maximum output character count to avoid overly long
    READMEs consuming Agent context.
    """
    owner, repo = parse_repo(args.repo)
    client = create_client()

    try:
        data = api_get(client, f"/repos/{owner}/{repo}/readme")
    except GitHubAPIError as e:
        if e.status_code == 404:
            print(f"\n[!] Repository {owner}/{repo} has no README file")
        else:
            print(f"\n[!] {e}")
        sys.exit(0)
    finally:
        client.close()

    # README content is returned Base64-encoded.
    content_b64 = data.get("content", "")
    encoding = data.get("encoding", "base64")

    if encoding == "base64":
        try:
            content = base64.b64decode(content_b64).decode("utf-8", errors="replace")
        except Exception as e:
            print(f"\n[!] Failed to decode README: {e}")
            sys.exit(0)
    else:
        content = content_b64

    readme_name = data.get("name", "README.md")
    total_chars = len(content)

    print(f"\n📖 README: {owner}/{repo} ({readme_name})")
    print(f"   Total: {total_chars} chars")
    print(f"{'─'*SEPARATOR_WIDTH}\n")

    output = truncate_text(content, args.max)
    print(output)


def cmd_tree(args: argparse.Namespace) -> None:
    """
    Browse repository directory structure.

    Uses the Git Tree API to recursively fetch the complete directory structure
    and display it as a tree.
    Supports specifying a subpath to view only part of the directory.
    """
    owner, repo = parse_repo(args.repo)
    client = create_client()

    try:
        # Fetch default branch information first.
        repo_data = api_get(client, f"/repos/{owner}/{repo}")
        default_branch = repo_data.get("default_branch", "main")

        # Fetch the full directory tree through the Git Tree API (recursive).
        tree_data = api_get(client, f"/repos/{owner}/{repo}/git/trees/{default_branch}", params={"recursive": "1"})
    except GitHubAPIError as e:
        print(f"\n[!] {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        client.close()

    tree_items = tree_data.get("tree", [])
    truncated = tree_data.get("truncated", False)

    # If a subpath is specified, filter to show only content under that path.
    filter_path = args.path.strip("/") if args.path else ""
    if filter_path:
        tree_items = [
            item for item in tree_items
            if item["path"].startswith(filter_path + "/") or item["path"] == filter_path
        ]
        # Remove the prefix for simpler display.
        for item in tree_items:
            if item["path"].startswith(filter_path + "/"):
                item["_display_path"] = item["path"][len(filter_path) + 1:]
            else:
                item["_display_path"] = item["path"]
    else:
        for item in tree_items:
            item["_display_path"] = item["path"]

    if not tree_items:
        print(f"\n[!] No files found under path '{filter_path}'")
        sys.exit(0)

    # Limit display depth.
    max_depth = args.depth

    # Build the tree structure for output.
    display_path = f"{owner}/{repo}" + (f"/{filter_path}" if filter_path else "")
    print(f"\n🌳 {display_path}")

    # Group and sort by path, with directories first.
    sorted_items = sorted(tree_items, key=lambda x: (x["_display_path"].count("/"), x["type"] != "tree", x["_display_path"]))

    # Simplified output: indent by hierarchy.
    displayed_count = 0
    for item in sorted_items:
        display = item["_display_path"]
        depth = display.count("/")

        if max_depth is not None and depth >= max_depth:
            continue

        item_type = item["type"]
        size = item.get("size", 0)

        indent = "  " * (depth + 1)
        if item_type == "tree":
            print(f"{indent}📁 {display.split('/')[-1]}/")
        else:
            size_str = f" ({format_size(size)})" if size > 0 else ""
            print(f"{indent}📄 {display.split('/')[-1]}{size_str}")

        displayed_count += 1
        if displayed_count >= args.limit:
            remaining = len(sorted_items) - displayed_count
            if remaining > 0:
                print(f"\n  ... {remaining} more items (use --limit to adjust the number displayed)")
            break

    if truncated:
        print(f"\n  ⚠️  Directory tree has been truncated (too many repository files)")


def cmd_file(args: argparse.Namespace) -> None:
    """
    Read the content of a specific file in a repository.

    Fetches through the Contents API, supports specifying a branch and maximum
    character truncation.
    Automatically detects binary files and prompts to skip them.
    """
    owner, repo = parse_repo(args.repo)
    file_path = args.path.strip("/")
    client = create_client()

    endpoint = f"/repos/{owner}/{repo}/contents/{quote(file_path, safe='/')}"
    params: dict[str, str] = {}
    if args.ref:
        params["ref"] = args.ref

    try:
        data = api_get(client, endpoint, params=params if params else None)
    except GitHubAPIError as e:
        if e.status_code == 404:
            print(f"\n[!] File does not exist: {owner}/{repo}/{file_path}")
        else:
            print(f"\n[!] {e}")
        sys.exit(0)
    finally:
        client.close()

    # Check whether this is a directory.
    if isinstance(data, list):
        print(f"\n[!] '{file_path}' is a directory; please use the tree command to browse it")
        sys.exit(0)

    file_size = data.get("size", 0)
    encoding = data.get("encoding", "")

    # Binary file detection (larger than 1 MB or no Base64 encoding).
    binary_extensions = {'.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.pdf',
                         '.zip', '.tar', '.gz', '.woff', '.woff2', '.ttf', '.eot',
                         '.mp3', '.mp4', '.avi', '.mov', '.exe', '.dll', '.so', '.dylib'}
    file_ext = os.path.splitext(file_path)[1].lower()
    if file_ext in binary_extensions:
        print(f"\n[!] '{file_path}' is a binary file ({format_size(file_size)}); skipping content display")
        print(f"    Download link: {data.get('download_url', 'N/A')}")
        return

    content_b64 = data.get("content", "")
    if encoding == "base64" and content_b64:
        try:
            content = base64.b64decode(content_b64).decode("utf-8", errors="replace")
        except Exception as e:
            print(f"\n[!] Failed to decode file content: {e}")
            sys.exit(0)
    else:
        # When the file is too large, the API does not return content; notify the user.
        download_url = data.get("download_url")
        if download_url:
            print(f"\n[!] File is too large ({format_size(file_size)}); API does not return content")
            print(f"    Download link: {download_url}")
        else:
            print(f"\n[!] Unable to get file content")
        return

    print(f"\n📄 {owner}/{repo}/{file_path}")
    print(f"   Size: {format_size(file_size)} | SHA: {data.get('sha', 'N/A')[:8]}")
    print(f"{'─'*SEPARATOR_WIDTH}\n")

    output = truncate_text(content, args.max)
    print(output)


def cmd_releases(args: argparse.Namespace) -> None:
    """
    List repository Release versions.

    Shows version number, release date, title, and changelog summary.
    """
    owner, repo = parse_repo(args.repo)
    client = create_client()

    try:
        data = api_get(client, f"/repos/{owner}/{repo}/releases", params={"per_page": args.limit})
    except GitHubAPIError as e:
        print(f"\n[!] {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        client.close()

    if not data:
        print(f"\n  Repository {owner}/{repo} has not published any Releases.")
        return

    print(f"\n🏷️  Releases: {owner}/{repo}")

    for idx, release in enumerate(data, 1):
        tag = release.get("tag_name", "N/A")
        name = release.get("name") or tag
        published = format_date(release.get("published_at"))
        prerelease = " (pre-release)" if release.get("prerelease") else ""
        draft = " (draft)" if release.get("draft") else ""

        print(f"\n  {idx}. {name}{prerelease}{draft}")
        print(f"     Tag: {tag}  |  Published: {published}")

        # Changelog summary (truncated to 200 characters).
        body = release.get("body") or ""
        if body:
            # Clean Markdown formatting and extract a plain-text summary.
            body_clean = re.sub(r'[#*`\[\]()]', '', body).strip()
            body_clean = re.sub(r'\n+', ' ', body_clean)
            if len(body_clean) > 200:
                body_clean = body_clean[:200] + "..."
            print(f"     {body_clean}")

        print(f"     {release.get('html_url', '')}")

    print(f"\n📊 Showing {len(data)} Releases")


def cmd_issues(args: argparse.Namespace) -> None:
    """
    List repository Issues (including Pull Requests).

    Supports filtering by state (open/closed/all) and labels.
    """
    owner, repo = parse_repo(args.repo)
    client = create_client()

    params: dict[str, str | int] = {
        "state": args.state,
        "per_page": args.limit,
        "sort": "updated",
        "direction": "desc",
    }
    if args.labels:
        params["labels"] = args.labels

    try:
        data = api_get(client, f"/repos/{owner}/{repo}/issues", params=params)
    except GitHubAPIError as e:
        print(f"\n[!] {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        client.close()

    if not data:
        print(f"\n  Repository {owner}/{repo} has no Issues in {args.state} state.")
        return

    print(f"\n🐛 Issues: {owner}/{repo} (state={args.state})")

    for idx, issue in enumerate(data, 1):
        number = issue.get("number", "?")
        title = issue.get("title", "N/A")
        state = issue.get("state", "?")
        updated = format_date(issue.get("updated_at"))
        user = issue.get("user", {}).get("login", "?")
        comments = issue.get("comments", 0)

        # Distinguish Issues from Pull Requests.
        is_pr = "pull_request" in issue
        type_icon = "🔀" if is_pr else "🐛"
        type_label = "PR" if is_pr else "Issue"

        # Labels.
        labels = [label.get("name", "") for label in issue.get("labels", [])]
        labels_str = f"  [{', '.join(labels)}]" if labels else ""

        state_icon = "🟢" if state == "open" else "🔴"

        print(f"\n  {idx}. {type_icon} #{number} {title}{labels_str}")
        print(f"     {state_icon} {state} | By: {user} | Updated: {updated} | 💬 {comments}")

    print(f"\n📊 Showing {len(data)} {args.state} Issue/PR")


# ==================== CLI Entry ====================

def build_parser() -> argparse.ArgumentParser:
    """Build the CLI argument parser."""
    parser = argparse.ArgumentParser(
        description="GitHub repository information lookup tool",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            Examples:
              %(prog)s search "langchain"
              %(prog)s search "machine learning language:python stars:>1000"
              %(prog)s info langchain-ai/langchain
              %(prog)s readme langchain-ai/langchain
              %(prog)s tree langchain-ai/langchain --depth 2
              %(prog)s tree langchain-ai/langchain --path src
              %(prog)s file langchain-ai/langchain pyproject.toml
              %(prog)s releases pytorch/pytorch --limit 5
              %(prog)s issues langchain-ai/langchain --state open --limit 10
            
            Authentication:
              In AgentVis brokerOnly mode, authentication is broker-managed through
              credentialRef=github and the AgentVis Credential Manager provider 'github'.
              The script process does not read token environment variables or Home files.
              Without a configured broker credential, GitHub anonymous rate limits apply.
              Token settings page: https://github.com/settings/tokens
        """),
    )

    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # search subcommand
    search_parser = subparsers.add_parser("search", help="Search repositories")
    search_parser.add_argument("query", help="Search keyword (supports GitHub Search syntax)")
    search_parser.add_argument("--limit", "-n", type=int, default=10, help="Number of results (default 10)")
    search_parser.add_argument("--sort", choices=["stars", "forks", "updated", "best-match"], default="best-match", help="Sort method (default best-match)")

    # info subcommand
    info_parser = subparsers.add_parser("info", help="View repository information")
    info_parser.add_argument("repo", help="Repository (owner/repo or GitHub URL)")

    # readme subcommand
    readme_parser = subparsers.add_parser("readme", help="Get README")
    readme_parser.add_argument("repo", help="Repository (owner/repo or GitHub URL)")
    readme_parser.add_argument("--max", "-m", type=int, default=DEFAULT_README_MAX_CHARS, help=f"Maximum number of characters (default {DEFAULT_README_MAX_CHARS})")

    # tree subcommand
    tree_parser = subparsers.add_parser("tree", help="Browse directory structure")
    tree_parser.add_argument("repo", help="Repository (owner/repo or GitHub URL)")
    tree_parser.add_argument("--path", "-p", default="", help="Subpath (default root directory)")
    tree_parser.add_argument("--depth", "-d", type=int, default=3, help="Directory depth (default 3)")
    tree_parser.add_argument("--limit", "-n", type=int, default=100, help="Maximum number of items to display (default 100)")

    # file subcommand
    file_parser = subparsers.add_parser("file", help="Read file content")
    file_parser.add_argument("repo", help="Repository (owner/repo or GitHub URL)")
    file_parser.add_argument("path", help="File path (for example, src/main.py)")
    file_parser.add_argument("--ref", default=None, help="Branch/Tag/commitSHA (default main branch)")
    file_parser.add_argument("--max", "-m", type=int, default=DEFAULT_FILE_MAX_CHARS, help=f"Maximum number of characters (default {DEFAULT_FILE_MAX_CHARS})")

    # releases subcommand
    releases_parser = subparsers.add_parser("releases", help="View Release versions")
    releases_parser.add_argument("repo", help="Repository (owner/repo or GitHub URL)")
    releases_parser.add_argument("--limit", "-n", type=int, default=10, help="Number to display (default 10)")

    # issues subcommand
    issues_parser = subparsers.add_parser("issues", help="View Issue list")
    issues_parser.add_argument("repo", help="Repository (owner/repo or GitHub URL)")
    issues_parser.add_argument("--state", choices=["open", "closed", "all"], default="open", help="Issue state (default open)")
    issues_parser.add_argument("--labels", default=None, help="Filter by labels (comma-separated)")
    issues_parser.add_argument("--limit", "-n", type=int, default=10, help="Number to display (default 10)")

    return parser


def main() -> None:
    """CLI entry point."""
    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(0)

    # Command dispatch table.
    command_handlers: dict[str, callable] = {
        "search": cmd_search,
        "info": cmd_info,
        "readme": cmd_readme,
        "tree": cmd_tree,
        "file": cmd_file,
        "releases": cmd_releases,
        "issues": cmd_issues,
    }

    handler = command_handlers.get(args.command)
    if handler:
        handler(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
