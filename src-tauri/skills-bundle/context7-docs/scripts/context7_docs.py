"""Context7 Docs CLI for AgentVis Script Skill.

The AgentVis Script Skill entrypoint imports this module and passes named
arguments through a small internal CLI. In brokerOnly mode, all HTTP(S) requests
go through agentvis-broker-fetch with credentialRef=context7. Local smoke runs
fall back to anonymous standard-library requests.
"""

from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
from datetime import datetime, timezone
import io
import json
import os
import subprocess
import sys
import textwrap
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


API_BASE_URL = "https://context7.com"
USER_AGENT = "AgentVis-Context7-Docs/1.0"
DEFAULT_LIMIT = 5
DEFAULT_TEXT_MAX_CHARS = 12000
REQUEST_TIMEOUT_SECONDS = 25


class Context7APIError(Exception):
    """Context7 API request error."""

    def __init__(
        self,
        status_code: int,
        message: str,
        rate_limit: dict[str, Any] | None = None,
    ) -> None:
        self.status_code = status_code
        self.message = message
        self.rate_limit = rate_limit or {}
        super().__init__(f"Context7 API Error ({status_code}): {message}")


@dataclass
class HTTPResponse:
    status_code: int
    headers: dict[str, str]
    body: bytes
    credential_applied: bool = False

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    def json(self) -> Any:
        return json.loads(self.text)


def broker_helper_available() -> bool:
    return bool(
        os.environ.get("AGENTVIS_BROKER_FETCH")
        and os.environ.get("AGENTVIS_BROKER_PIPE")
        and os.environ.get("AGENTVIS_BROKER_TOKEN")
    )


def normalize_headers(headers: Any) -> dict[str, str]:
    if isinstance(headers, dict):
        return {str(key).lower(): str(value) for key, value in headers.items()}
    return {
        str(item.get("name", "")).lower(): str(item.get("value", ""))
        for item in (headers or [])
        if isinstance(item, dict) and item.get("name")
    }


def broker_failure_diagnostics(payload: dict[str, Any], url: str) -> str:
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


def build_url(path: str, params: dict[str, str | int]) -> str:
    query = urlencode({key: value for key, value in params.items() if value != ""})
    return f"{API_BASE_URL}{path}?{query}" if query else f"{API_BASE_URL}{path}"


def request_context7(
    path: str,
    params: dict[str, str | int],
    *,
    accept: str = "application/json",
) -> HTTPResponse:
    url = build_url(path, params)
    headers = {
        "Accept": accept,
        "User-Agent": USER_AGENT,
    }
    if broker_helper_available():
        return request_context7_broker(url, headers)
    return request_context7_direct(url, headers)


def request_context7_broker(url: str, headers: dict[str, str]) -> HTTPResponse:
    helper = os.environ.get("AGENTVIS_BROKER_FETCH") or "agentvis-broker-fetch"
    request = {
        "method": "GET",
        "url": url,
        "headers": [
            {"name": name, "value": value}
            for name, value in headers.items()
            if value
        ],
        "credentialRef": "context7",
        "timeoutMs": REQUEST_TIMEOUT_SECONDS * 1000,
    }

    completed = subprocess.run(
        [helper],
        input=json.dumps(request),
        text=True,
        capture_output=True,
        timeout=REQUEST_TIMEOUT_SECONDS + 10,
        check=False,
    )

    try:
        payload = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise Context7APIError(0, f"Broker helper returned invalid JSON: {exc}") from exc

    if completed.returncode != 0 or payload.get("ok") is not True:
        error = payload.get("error") or completed.stderr or "unknown broker helper failure"
        raise Context7APIError(0, f"Broker helper request failed: {error}{broker_failure_diagnostics(payload, url)}")

    return HTTPResponse(
        status_code=int(payload.get("status") or 0),
        headers=normalize_headers(payload.get("headers") or []),
        body=base64.b64decode(payload.get("bodyBase64") or ""),
        credential_applied=bool(payload.get("credentialApplied")),
    )


def request_context7_direct(url: str, headers: dict[str, str]) -> HTTPResponse:
    request = Request(url, headers=headers, method="GET")
    try:
        with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            return HTTPResponse(
                status_code=int(response.status),
                headers=normalize_headers(dict(response.headers.items())),
                body=response.read(),
                credential_applied=False,
            )
    except HTTPError as error:
        return HTTPResponse(
            status_code=int(error.code),
            headers=normalize_headers(dict(error.headers.items())),
            body=error.read(),
            credential_applied=False,
        )
    except URLError as error:
        raise Context7APIError(0, f"Unable to connect to Context7: {error}") from error


def parse_rate_limit(response: HTTPResponse) -> dict[str, Any]:
    headers = response.headers
    reset_value = headers.get("ratelimit-reset") or headers.get("x-ratelimit-reset") or ""
    reset_iso = ""
    if reset_value.isdigit():
        try:
            reset_iso = datetime.fromtimestamp(int(reset_value), timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            reset_iso = ""
    return {
        "limit": headers.get("ratelimit-limit") or headers.get("x-ratelimit-limit") or "",
        "remaining": headers.get("ratelimit-remaining") or headers.get("x-ratelimit-remaining") or "",
        "reset": reset_value,
        "resetIso": reset_iso,
        "retryAfter": headers.get("retry-after") or "",
        "credentialApplied": response.credential_applied,
    }


def parse_error_message(response: HTTPResponse) -> str:
    try:
        data = response.json()
        if isinstance(data, dict):
            return str(data.get("message") or data.get("error") or response.text[:500])
    except (json.JSONDecodeError, ValueError):
        pass
    return response.text[:500] or "empty response"


def ensure_success(response: HTTPResponse) -> None:
    if 200 <= response.status_code < 300:
        return
    message = parse_error_message(response)
    if response.status_code == 401:
        message = (
            f"{message}\n"
            "The configured Context7 API key is invalid. Check that it starts with ctx7sk "
            "and update the AgentVis Context7 API key setting."
        )
    if response.status_code == 429:
        rate = parse_rate_limit(response)
        retry_after = rate.get("retryAfter") or "the reset window"
        message = (
            f"{message}\n"
            f"Context7 rate limit exceeded. Retry after {retry_after}, or configure a Context7 API key/plan."
        )
    raise Context7APIError(response.status_code, message, parse_rate_limit(response))


def search_libraries(library_name: str, query: str = "", limit: int = DEFAULT_LIMIT) -> dict[str, Any]:
    response = request_context7(
        "/api/v2/libs/search",
        {
            "libraryName": library_name,
            "query": query,
        },
    )
    ensure_success(response)
    data = response.json()
    results = list(data.get("results") or []) if isinstance(data, dict) else []
    return {
        "libraryName": library_name,
        "query": query,
        "results": results[:limit],
        "searchFilterApplied": bool(data.get("searchFilterApplied")) if isinstance(data, dict) else False,
        "rateLimit": parse_rate_limit(response),
    }


def get_context_docs(library_id: str, query: str, output_format: str = "text") -> dict[str, Any]:
    context_type = "json" if output_format == "json" else "txt"
    accept = "application/json" if context_type == "json" else "text/plain"
    response = request_context7(
        "/api/v2/context",
        {
            "libraryId": library_id,
            "query": query,
            "type": context_type,
        },
        accept=accept,
    )
    ensure_success(response)
    if context_type == "json":
        payload: Any = response.json()
    else:
        payload = response.text
    return {
        "libraryId": library_id,
        "query": query,
        "format": output_format,
        "content": payload,
        "rateLimit": parse_rate_limit(response),
    }


def resolve_docs(
    library_name: str,
    query: str,
    output_format: str,
    limit: int,
) -> dict[str, Any]:
    search_result = search_libraries(library_name, query=query, limit=max(limit, 1))
    results = search_result.get("results") or []
    if not results:
        raise Context7APIError(404, f"No Context7 libraries found for {library_name!r}.", search_result.get("rateLimit"))

    best = results[0]
    library_id = str(best.get("id") or "")
    if not library_id:
        raise Context7APIError(404, f"Context7 search result for {library_name!r} did not include an id.", search_result.get("rateLimit"))

    docs_result = get_context_docs(library_id, query=query, output_format=output_format)
    docs_result["resolvedLibrary"] = {
        key: best.get(key)
        for key in [
            "id",
            "title",
            "description",
            "branch",
            "lastUpdateDate",
            "state",
            "totalTokens",
            "totalSnippets",
            "stars",
            "trustScore",
            "benchmarkScore",
            "versions",
        ]
        if key in best
    }
    docs_result["searchRateLimit"] = search_result.get("rateLimit")
    return docs_result


def truncate_text(text: str, max_chars: int) -> str:
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    return f"{text[:max_chars]}\n\n[truncated: output exceeded {max_chars} characters]"


def format_rate_limit(rate_limit: dict[str, Any] | None) -> str:
    if not rate_limit:
        return ""
    parts = []
    for label, key in [
        ("limit", "limit"),
        ("remaining", "remaining"),
        ("reset", "resetIso"),
        ("retryAfter", "retryAfter"),
    ]:
        value = rate_limit.get(key)
        if value:
            parts.append(f"{label}={value}")
    parts.append(f"credentialApplied={bool(rate_limit.get('credentialApplied'))}")
    return ", ".join(parts)


def format_search_text(result: dict[str, Any], max_chars: int) -> str:
    lines = [
        f"# Context7 Library Search: {result.get('libraryName')}",
        "",
    ]
    if result.get("query"):
        lines.extend([f"Query: {result.get('query')}", ""])

    results = result.get("results") or []
    if not results:
        lines.append("No libraries found.")
    for index, item in enumerate(results, 1):
        lines.append(f"{index}. {item.get('title') or '(untitled)'}")
        lines.append(f"   id: {item.get('id')}")
        description = str(item.get("description") or "").strip()
        if description:
            lines.append(f"   description: {description}")
        meta = []
        for key in ["trustScore", "benchmarkScore", "stars", "lastUpdateDate", "totalSnippets"]:
            value = item.get(key)
            if value is not None and value != "":
                meta.append(f"{key}={value}")
        if meta:
            lines.append(f"   metadata: {', '.join(str(value) for value in meta)}")
        versions = item.get("versions") or []
        if versions:
            lines.append(f"   versions: {', '.join(str(value) for value in versions[:8])}")

    rate = format_rate_limit(result.get("rateLimit"))
    if rate:
        lines.extend(["", f"Rate limit: {rate}"])
    return truncate_text("\n".join(lines), max_chars)


def compact_json_docs(content: dict[str, Any], limit: int) -> dict[str, Any]:
    compact = dict(content)
    if isinstance(compact.get("codeSnippets"), list):
        compact["codeSnippets"] = compact["codeSnippets"][:limit]
    if isinstance(compact.get("infoSnippets"), list):
        compact["infoSnippets"] = compact["infoSnippets"][:limit]
    return compact


def format_docs_text(result: dict[str, Any], limit: int, max_chars: int) -> str:
    content = result.get("content")
    lines = []
    if result.get("resolvedLibrary"):
        library = result["resolvedLibrary"]
        lines.extend([
            f"# Context7 Docs: {library.get('title') or result.get('libraryId')}",
            f"Resolved library: {library.get('id')}",
        ])
        description = str(library.get("description") or "").strip()
        if description:
            lines.append(f"Description: {description}")
        lines.append("")
    else:
        lines.extend([
            f"# Context7 Docs: {result.get('libraryId')}",
            "",
        ])
    lines.extend([f"Query: {result.get('query')}", ""])

    if isinstance(content, str):
        lines.append(content.strip())
    elif isinstance(content, dict):
        code_snippets = list(content.get("codeSnippets") or [])[:limit]
        info_snippets = list(content.get("infoSnippets") or [])[:limit]

        for snippet in code_snippets:
            title = snippet.get("codeTitle") or snippet.get("pageTitle") or "Code snippet"
            lines.append(f"## {title}")
            description = str(snippet.get("codeDescription") or "").strip()
            if description:
                lines.append(description)
            for code_item in snippet.get("codeList") or []:
                language = code_item.get("language") or snippet.get("codeLanguage") or ""
                code = str(code_item.get("code") or "")
                lines.append(f"```{language}")
                lines.append(code)
                lines.append("```")
            source = snippet.get("codeId")
            if source:
                lines.append(f"Source: {source}")
            lines.append("")

        for snippet in info_snippets:
            breadcrumb = snippet.get("breadcrumb") or snippet.get("pageTitle") or "Info"
            lines.append(f"## {breadcrumb}")
            lines.append(str(snippet.get("content") or "").strip())
            source = snippet.get("pageId")
            if source:
                lines.append(f"Source: {source}")
            lines.append("")
    else:
        lines.append(str(content))

    rate = format_rate_limit(result.get("rateLimit"))
    if rate:
        lines.extend(["", f"Rate limit: {rate}"])
    search_rate = format_rate_limit(result.get("searchRateLimit"))
    if search_rate:
        lines.append(f"Search rate limit: {search_rate}")
    return truncate_text("\n".join(lines).strip(), max_chars)


def print_json(data: Any) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Search and retrieve Context7 documentation.")
    subparsers = parser.add_subparsers(dest="action", required=True)

    search = subparsers.add_parser("search")
    search.add_argument("--library-name", required=True)
    search.add_argument("--query", default="")
    search.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    search.add_argument("--max", type=int, default=DEFAULT_TEXT_MAX_CHARS)
    search.add_argument("--output-format", choices=["text", "json"], default="text")

    docs = subparsers.add_parser("docs")
    docs.add_argument("--library-id", required=True)
    docs.add_argument("--query", required=True)
    docs.add_argument("--output-format", choices=["text", "json"], default="text")
    docs.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    docs.add_argument("--max", type=int, default=DEFAULT_TEXT_MAX_CHARS)

    resolve = subparsers.add_parser("resolve-docs")
    resolve.add_argument("--library-name", required=True)
    resolve.add_argument("--query", required=True)
    resolve.add_argument("--output-format", choices=["text", "json"], default="text")
    resolve.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    resolve.add_argument("--max", type=int, default=DEFAULT_TEXT_MAX_CHARS)

    return parser


def main() -> int:
    args = build_parser().parse_args()

    try:
        if args.action == "search":
            result = search_libraries(args.library_name, query=args.query, limit=args.limit)
            if args.output_format == "json":
                print_json(result)
            else:
                print(format_search_text(result, args.max))
            return 0

        if args.action == "docs":
            result = get_context_docs(args.library_id, query=args.query, output_format=args.output_format)
            if args.output_format == "json":
                result = {
                    **result,
                    "content": compact_json_docs(result["content"], args.limit)
                    if isinstance(result.get("content"), dict)
                    else result.get("content"),
                }
                print_json(result)
            else:
                print(format_docs_text(result, args.limit, args.max))
            return 0

        if args.action == "resolve-docs":
            result = resolve_docs(args.library_name, query=args.query, output_format=args.output_format, limit=args.limit)
            if args.output_format == "json":
                result = {
                    **result,
                    "content": compact_json_docs(result["content"], args.limit)
                    if isinstance(result.get("content"), dict)
                    else result.get("content"),
                }
                print_json(result)
            else:
                print(format_docs_text(result, args.limit, args.max))
            return 0

        print(f"[!] Unsupported action: {args.action}", file=sys.stderr)
        return 2

    except Context7APIError as error:
        print(f"[!] {error.message}", file=sys.stderr)
        rate = format_rate_limit(error.rate_limit)
        if rate:
            print(textwrap.indent(f"Rate limit: {rate}", "    "), file=sys.stderr)
        return 1
    except Exception as error:
        print(f"[!] Context7 docs skill failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
