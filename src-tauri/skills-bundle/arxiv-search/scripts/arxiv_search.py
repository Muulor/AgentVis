"""
arXiv Search CLI - academic paper search and PDF download.

Uses the public arXiv API directly. In AgentVis brokerOnly mode, HTTP(S)
requests are sent through agentvis-broker-fetch; local direct runs use Python's
standard library. No third-party Python package is required.
"""

from __future__ import annotations

import argparse
import base64
from http.client import IncompleteRead
from dataclasses import dataclass
from datetime import datetime
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import textwrap
from typing import Any
from urllib.parse import urlencode, urlparse
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


ARXIV_API_BASE = "http://export.arxiv.org/api/query"
ARXIV_ABS_BASE = "https://arxiv.org/abs"
ARXIV_PDF_BASE = "https://arxiv.org/pdf"
REQUEST_TIMEOUT_SECONDS = 25
MAX_REQUEST_RETRIES = 1
ARXIV_API_MIN_INTERVAL_SECONDS = 3.2
RATE_LIMIT_LOCK_MAX_WAIT_SECONDS = 15.0
RATE_LIMIT_STALE_LOCK_SECONDS = 30.0
DEFAULT_ABSTRACT_MAX_CHARS = 500
FILENAME_UNSAFE_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

ATOM_NS = "{http://www.w3.org/2005/Atom}"
ARXIV_NS = "{http://arxiv.org/schemas/atom}"
OPENSEARCH_NS = "{http://a9.com/-/spec/opensearch/1.1/}"


CATEGORY_NAMES: dict[str, str] = {
    "cs.AI": "Artificial Intelligence",
    "cs.CL": "Computation and Language (NLP)",
    "cs.CV": "Computer Vision",
    "cs.LG": "Machine Learning",
    "cs.CR": "Cryptography and Security",
    "cs.DB": "Databases",
    "cs.DS": "Data Structures and Algorithms",
    "cs.HC": "Human-Computer Interaction",
    "cs.IR": "Information Retrieval",
    "cs.IT": "Information Theory",
    "cs.NE": "Neural and Evolutionary Computing",
    "cs.PL": "Programming Languages",
    "cs.RO": "Robotics",
    "cs.SE": "Software Engineering",
    "cs.SD": "Sound",
    "stat.ML": "Machine Learning (Statistics)",
    "math.OC": "Optimization and Control",
    "eess.AS": "Audio and Speech Processing",
    "eess.IV": "Image and Video Processing",
    "eess.SP": "Signal Processing",
    "physics.comp-ph": "Computational Physics",
    "q-bio.BM": "Biomolecules",
    "q-fin.ST": "Statistical Finance",
}

CATEGORY_ALIASES: dict[str, str] = {
    "ai": "cs.AI",
    "nlp": "cs.CL",
    "cv": "cs.CV",
    "ml": "cs.LG",
    "robotics": "cs.RO",
    "security": "cs.CR",
    "ir": "cs.IR",
    "se": "cs.SE",
}

SORT_MAP = {
    "relevance": "relevance",
    "date": "submittedDate",
    "updated": "lastUpdatedDate",
}

SORT_ORDER_MAP = {
    "ascending": "ascending",
    "asc": "ascending",
    "oldest": "ascending",
    "descending": "descending",
    "desc": "descending",
    "newest": "descending",
}

FIELD_ALIASES = {
    "all": "all",
    "title": "ti",
    "ti": "ti",
    "author": "au",
    "au": "au",
    "abstract": "abs",
    "abs": "abs",
    "comment": "co",
    "co": "co",
    "journal": "jr",
    "jr": "jr",
    "category": "cat",
    "cat": "cat",
    "report": "rn",
    "rn": "rn",
    "id": "id",
}


class ArxivAPIError(Exception):
    """arXiv API request error."""


@dataclass
class HTTPResponse:
    status_code: int
    headers: dict[str, str]
    body: bytes

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")


@dataclass
class Paper:
    arxiv_id: str
    entry_id: str
    title: str
    authors: list[str]
    published: datetime | None
    updated: datetime | None
    summary: str
    categories: list[str]
    primary_category: str
    pdf_url: str
    doi: str
    journal_ref: str
    comment: str


def broker_helper_available() -> bool:
    return bool(
        os.environ.get("AGENTVIS_BROKER_FETCH")
        and os.environ.get("AGENTVIS_BROKER_PIPE")
        and os.environ.get("AGENTVIS_BROKER_TOKEN")
    )


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


def request_url(url: str, accept: str = "*/*") -> HTTPResponse:
    if url.startswith(ARXIV_API_BASE):
        wait_for_arxiv_api_slot()
    if broker_helper_available():
        return request_url_broker(url, accept)
    return request_url_direct(url, accept)


def skill_state_dir() -> Path:
    """Return a writable internal state directory outside the user's workdir."""
    candidates: list[Path] = []
    package_dir = os.environ.get("AGENTVIS_SKILL_PACKAGE_DIR")
    if package_dir:
        candidates.append(Path(package_dir) / ".agentvis_state")
    candidates.append(Path(tempfile.gettempdir()) / "agentvis_arxiv_search")

    for candidate in candidates:
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            return candidate
        except OSError:
            continue

    return Path(tempfile.gettempdir())


def wait_for_arxiv_api_slot() -> None:
    """Coordinate arXiv API calls across short-lived skill processes."""
    state_dir = skill_state_dir()
    lock_path = state_dir / "api_rate.lock"
    state_path = state_dir / "last_api_request.txt"
    started_at = time.time()
    lock_fd: int | None = None

    while lock_fd is None:
        try:
            lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_RDWR)
        except FileExistsError:
            try:
                if time.time() - lock_path.stat().st_mtime > RATE_LIMIT_STALE_LOCK_SECONDS:
                    lock_path.unlink(missing_ok=True)
                    continue
            except OSError:
                pass
            if time.time() - started_at >= RATE_LIMIT_LOCK_MAX_WAIT_SECONDS:
                time.sleep(ARXIV_API_MIN_INTERVAL_SECONDS)
                return
            time.sleep(0.1)

    try:
        with os.fdopen(lock_fd, "w", encoding="utf-8") as lock_file:
            lock_file.write(str(os.getpid()))
        last_request_at = 0.0
        try:
            last_request_at = float(state_path.read_text(encoding="utf-8").strip() or "0")
        except (OSError, ValueError):
            last_request_at = 0.0

        wait_seconds = ARXIV_API_MIN_INTERVAL_SECONDS - (time.time() - last_request_at)
        if wait_seconds > 0:
            time.sleep(wait_seconds)
        state_path.write_text(str(time.time()), encoding="utf-8")
    finally:
        try:
            lock_path.unlink(missing_ok=True)
        except OSError:
            pass


def request_url_broker(url: str, accept: str) -> HTTPResponse:
    helper = os.environ.get("AGENTVIS_BROKER_FETCH") or "agentvis-broker-fetch"
    payload = {
        "method": "GET",
        "url": url,
        "headers": [
            {"name": "Accept", "value": accept},
            {"name": "User-Agent", "value": "AgentVis-arXiv-Search/1.0"},
        ],
        "timeoutMs": REQUEST_TIMEOUT_SECONDS * 1000,
    }
    last_error = "unknown broker helper failure"
    for attempt in range(MAX_REQUEST_RETRIES + 1):
        completed = subprocess.run(
            [helper],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            timeout=REQUEST_TIMEOUT_SECONDS + 10,
            check=False,
        )
        try:
            data = json.loads(completed.stdout or "{}")
        except json.JSONDecodeError as exc:
            raise ArxivAPIError(f"Broker helper returned invalid JSON: {exc}") from exc
        if completed.returncode != 0 or data.get("ok") is not True:
            error = data.get("error") or completed.stderr or last_error
            last_error = f"{error}{broker_failure_diagnostics(data, url)}"
            if attempt >= MAX_REQUEST_RETRIES:
                raise ArxivAPIError(f"Broker helper request failed: {last_error}")
            time.sleep(1 + attempt)
            continue

        headers = {
            str(item.get("name", "")).lower(): str(item.get("value", ""))
            for item in data.get("headers") or []
            if item.get("name")
        }
        body = base64.b64decode(data.get("bodyBase64") or "")
        status_code = int(data.get("status") or 0)
        if status_code in {429, 502, 503} and attempt < MAX_REQUEST_RETRIES:
            retry_after = headers.get("retry-after")
            delay = int(retry_after) if retry_after and retry_after.isdigit() else 3 + attempt * 2
            time.sleep(delay)
            continue
        if status_code >= 400:
            raise ArxivAPIError(f"HTTP {status_code}: {body[:200].decode('utf-8', errors='replace')}")
        return HTTPResponse(status_code=status_code, headers=headers, body=body)
    raise ArxivAPIError(f"Broker helper request failed: {last_error}")


def request_url_direct(url: str, accept: str) -> HTTPResponse:
    request = Request(
        url,
        headers={
            "Accept": accept,
            "User-Agent": "AgentVis-arXiv-Search/1.0",
        },
    )
    last_error: Exception | None = None
    for attempt in range(MAX_REQUEST_RETRIES + 1):
        try:
            with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                return HTTPResponse(
                    status_code=response.status,
                    headers={k.lower(): v for k, v in response.headers.items()},
                    body=response.read(),
                )
        except HTTPError as exc:
            last_error = exc
            if exc.code not in {429, 502, 503} or attempt >= MAX_REQUEST_RETRIES:
                body = exc.read(200).decode("utf-8", errors="replace")
                raise ArxivAPIError(f"HTTP {exc.code}: {body or exc.reason}") from exc
            retry_after = exc.headers.get("Retry-After")
            delay = int(retry_after) if retry_after and retry_after.isdigit() else 3 + attempt * 2
            time.sleep(delay)
        except (TimeoutError, URLError, IncompleteRead) as exc:
            last_error = exc
            if attempt >= MAX_REQUEST_RETRIES:
                raise ArxivAPIError(f"Request failed: {exc}") from exc
            time.sleep(1 + attempt)
    raise ArxivAPIError(f"Request failed: {last_error}") from last_error


def build_api_url(params: dict[str, Any]) -> str:
    return f"{ARXIV_API_BASE}?{urlencode(params)}"


def fetch_feed(params: dict[str, Any]) -> tuple[list[Paper], int | None]:
    url = build_api_url(params)
    response = request_url(url, accept="application/atom+xml")
    try:
        root = ET.fromstring(response.body)
    except ET.ParseError as exc:
        raise ArxivAPIError(f"Unable to parse arXiv Atom feed: {exc}") from exc

    total_text = find_text(root, f"{OPENSEARCH_NS}totalResults")
    total_results = int(total_text) if total_text and total_text.isdigit() else None
    papers = [parse_entry(entry) for entry in root.findall(f"{ATOM_NS}entry")]
    return papers, total_results


def find_text(node: ET.Element, path: str) -> str:
    child = node.find(path)
    return normalize_space(child.text or "") if child is not None else ""


def normalize_space(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def parse_datetime(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def parse_entry(entry: ET.Element) -> Paper:
    entry_id = find_text(entry, f"{ATOM_NS}id")
    arxiv_id = extract_arxiv_id(entry_id)
    categories = [
        category.attrib.get("term", "")
        for category in entry.findall(f"{ATOM_NS}category")
        if category.attrib.get("term")
    ]
    primary = entry.find(f"{ARXIV_NS}primary_category")
    primary_category = primary.attrib.get("term", "") if primary is not None else (categories[0] if categories else "")

    pdf_url = f"{ARXIV_PDF_BASE}/{arxiv_id}.pdf"
    for link in entry.findall(f"{ATOM_NS}link"):
        if link.attrib.get("title") == "pdf" and link.attrib.get("href"):
            pdf_url = link.attrib["href"]
            break

    return Paper(
        arxiv_id=arxiv_id,
        entry_id=entry_id or f"{ARXIV_ABS_BASE}/{arxiv_id}",
        title=find_text(entry, f"{ATOM_NS}title"),
        authors=[
            find_text(author, f"{ATOM_NS}name")
            for author in entry.findall(f"{ATOM_NS}author")
            if find_text(author, f"{ATOM_NS}name")
        ],
        published=parse_datetime(find_text(entry, f"{ATOM_NS}published")),
        updated=parse_datetime(find_text(entry, f"{ATOM_NS}updated")),
        summary=find_text(entry, f"{ATOM_NS}summary"),
        categories=categories,
        primary_category=primary_category,
        pdf_url=pdf_url,
        doi=find_text(entry, f"{ARXIV_NS}doi"),
        journal_ref=find_text(entry, f"{ARXIV_NS}journal_ref"),
        comment=find_text(entry, f"{ARXIV_NS}comment"),
    )


def format_date(dt: datetime | None) -> str:
    if dt is None:
        return "N/A"
    return dt.strftime("%Y-%m-%d")


def format_authors(authors: list[str], max_display: int = 5) -> str:
    if len(authors) <= max_display:
        return ", ".join(authors) if authors else "N/A"
    return ", ".join(authors[:max_display]) + f" et al. ({len(authors)} authors)"


def extract_arxiv_id(raw_id: str) -> str:
    cleaned = raw_id.strip()
    for pattern in [
        r"https?://arxiv\.org/abs/",
        r"https?://arxiv\.org/pdf/",
        r"https?://export\.arxiv\.org/abs/",
    ]:
        cleaned = re.sub(pattern, "", cleaned)
    cleaned = re.sub(r"\.pdf$", "", cleaned)
    return cleaned.strip("/")


def sanitize_filename(name: str, max_length: int = 80) -> str:
    safe = FILENAME_UNSAFE_CHARS.sub("_", name)
    safe = re.sub(r"_+", "_", safe).strip("_. ")
    if len(safe) > max_length:
        safe = safe[:max_length].rstrip("_. ")
    return safe or "untitled"


def generated_pdf_filename(arxiv_id: str, title: str) -> str:
    safe_title = sanitize_filename(title, max_length=60)
    return f"{arxiv_id.replace('/', '_')}_{safe_title}.pdf"


def ensure_pdf_suffix(path: Path) -> Path:
    if path.suffix.lower() == ".pdf":
        return path
    return path.with_suffix(".pdf")


def resolve_output_path(output_dir: str, output_file: str, filename: str) -> Path:
    explicit_file = output_file.strip()
    if explicit_file:
        return ensure_pdf_suffix(Path(explicit_file))

    explicit_dir = output_dir.strip()
    if explicit_dir:
        candidate = Path(explicit_dir)
        if candidate.suffix.lower() == ".pdf" or candidate.is_file():
            return ensure_pdf_suffix(candidate)
        return candidate / filename

    for env_name in ("AGENTVIS_DELIVERABLE_DIR", "AGENTVIS_WORKDIR"):
        env_value = os.environ.get(env_name, "").strip()
        if env_value:
            return Path(env_value) / filename
    return Path("./arxiv_papers") / filename


def truncate_text(text: str, max_chars: int) -> str:
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip() + "..."


def normalize_query_value(value: str) -> str:
    cleaned = normalize_space(value)
    if not cleaned:
        return cleaned
    if cleaned.startswith('"') and cleaned.endswith('"'):
        return cleaned
    if any(token in cleaned for token in [":", "[", "]", "(", ")", '"']):
        return cleaned
    if re.search(r"\s", cleaned):
        return f'"{cleaned}"'
    return cleaned


def looks_like_advanced_query(query: str) -> bool:
    return bool(re.search(r"\b(AND|OR|ANDNOT)\b|[a-zA-Z]+:", query))


def field_clause(field: str, value: str) -> str:
    prefix = FIELD_ALIASES.get(field.lower())
    if not prefix:
        raise ArxivAPIError(f"Unsupported field '{field}'. Use all, title, author, abstract, category, or raw query syntax.")
    return f"{prefix}:{normalize_query_value(value)}"


def normalize_arxiv_date(value: str, *, end_of_day: bool) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ArxivAPIError("Date filters cannot be empty.")

    if re.fullmatch(r"\d{8}\d{4}", cleaned):
        return cleaned
    if re.fullmatch(r"\d{8}", cleaned):
        return cleaned + ("2359" if end_of_day else "0000")
    match = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", cleaned)
    if match:
        return "".join(match.groups()) + ("2359" if end_of_day else "0000")
    raise ArxivAPIError("Date filters must use YYYY-MM-DD, YYYYMMDD, or YYYYMMDDHHMM.")


def build_submitted_date_clause(date_from: str, date_to: str) -> str:
    start = normalize_arxiv_date(date_from, end_of_day=False) if date_from else "190001010000"
    end = normalize_arxiv_date(date_to, end_of_day=True) if date_to else "299912312359"
    return f"submittedDate:[{start} TO {end}]"


def build_search_query(args: argparse.Namespace) -> str:
    clauses: list[str] = []
    query = normalize_space(args.query or "")
    field = getattr(args, "field", "all") or "all"
    if query:
        if field.lower() == "all" or looks_like_advanced_query(query):
            clauses.append(query)
        else:
            clauses.append(field_clause(field, query))

    for attr_name, field_name in [
        ("title", "title"),
        ("author", "author"),
        ("abstract", "abstract"),
    ]:
        value = normalize_space(getattr(args, attr_name, "") or "")
        if value:
            clauses.append(field_clause(field_name, value))

    category = normalize_space(getattr(args, "category", "") or "")
    if category:
        resolved_category = CATEGORY_ALIASES.get(category.lower(), category)
        clauses.append(field_clause("category", resolved_category))

    if getattr(args, "date_from", "") or getattr(args, "date_to", ""):
        clauses.append(build_submitted_date_clause(args.date_from, args.date_to))

    raw_filter = normalize_space(getattr(args, "filter", "") or "")
    if raw_filter:
        clauses.append(f"({raw_filter})")

    if not clauses:
        raise ArxivAPIError("Search needs --query, --category, --filter, or another filter argument.")
    return " AND ".join(clauses)


def print_result_brief(paper: Paper, index: int, abstract_max: int = DEFAULT_ABSTRACT_MAX_CHARS) -> None:
    categories = ", ".join(paper.categories)
    abstract = truncate_text(paper.summary.replace("\n", " "), abstract_max)
    authors = format_authors(paper.authors)

    print(f"\n  {index}. {paper.title}")
    print(f"     Authors: {authors}")
    print(f"     Date: {format_date(paper.published)}  |  Categories: {categories}")
    print(f"     Abstract: {abstract}")
    print(f"     {paper.entry_id}")


def print_result_detail(paper: Paper) -> None:
    print(f"\n{'=' * 70}")
    print(f"  Title: {paper.title}")
    print(f"{'=' * 70}")
    print(f"  Authors: {format_authors(paper.authors, max_display=20)}")
    print(f"  Published: {format_date(paper.published)}")
    print(f"  Updated: {format_date(paper.updated)}")
    print(f"  Categories: {', '.join(paper.categories)}")
    print(f"  Primary Category: {paper.primary_category}")
    if paper.doi:
        print(f"  DOI: {paper.doi}")
    if paper.journal_ref:
        print(f"  Journal: {paper.journal_ref}")
    if paper.comment:
        print(f"  Comment: {paper.comment}")

    print("\n  Abstract:")
    wrapped = textwrap.fill(
        paper.summary.replace("\n", " "),
        width=70,
        initial_indent="    ",
        subsequent_indent="    ",
    )
    print(wrapped)
    print("\n  Links:")
    print(f"    Abstract: {paper.entry_id}")
    print(f"    PDF: {paper.pdf_url}")
    print(f"{'=' * 70}")


def cmd_search(args: argparse.Namespace) -> int:
    search_query = build_search_query(args)
    papers, total = fetch_feed({
        "search_query": search_query,
        "start": args.start,
        "max_results": args.limit,
        "sortBy": SORT_MAP.get(args.sort, "relevance"),
        "sortOrder": SORT_ORDER_MAP.get(args.sort_order, "descending"),
    })

    print(f'arXiv Search: "{search_query}"')
    print(f"   Sort: {args.sort} ({args.sort_order}) | Start: {args.start} | Limit: {args.limit}")
    for idx, paper in enumerate(papers, start=args.start + 1):
        print_result_brief(paper, idx, args.abstract_max)
    if not papers:
        print("\n  No matching papers found.")
    else:
        suffix = f" (reported total: {total})" if total is not None else ""
        print(f"\nFound {len(papers)} papers{suffix}.")
    return 0


def cmd_latest(args: argparse.Namespace) -> int:
    category = CATEGORY_ALIASES.get(args.category.lower(), args.category)
    category_name = CATEGORY_NAMES.get(category, category)
    papers, total = fetch_feed({
        "search_query": build_search_query(argparse.Namespace(
            query="",
            field="all",
            category=category,
            title="",
            author="",
            abstract="",
            date_from=args.date_from,
            date_to=args.date_to,
            filter=args.filter,
        )),
        "start": args.start,
        "max_results": args.limit,
        "sortBy": "submittedDate",
        "sortOrder": SORT_ORDER_MAP.get(args.sort_order, "descending"),
    })

    print(f"Latest Papers in {category} ({category_name})")
    print(f"   Sort: submittedDate ({args.sort_order}) | Start: {args.start} | Limit: {args.limit}")
    for idx, paper in enumerate(papers, start=args.start + 1):
        print_result_brief(paper, idx, args.abstract_max)
    if not papers:
        print(f"\n  No papers found in category {category}. Please confirm the category ID is correct.")
        print(f"  Common categories: {', '.join(list(CATEGORY_NAMES.keys())[:10])}")
    else:
        suffix = f" (reported total: {total})" if total is not None else ""
        print(f"\nRetrieved {len(papers)} latest papers{suffix}.")
    return 0


def fetch_paper(arxiv_id: str) -> Paper | None:
    papers, _ = fetch_feed({"id_list": arxiv_id, "start": 0, "max_results": 1})
    return papers[0] if papers else None


def cmd_detail(args: argparse.Namespace) -> int:
    arxiv_id = extract_arxiv_id(args.arxiv_id)
    print(f"Fetching paper: {arxiv_id}")
    paper = fetch_paper(arxiv_id)
    if not paper:
        print(f"\n[!] No paper found with ID '{arxiv_id}'. Please check whether the ID is correct.")
        return 1
    print_result_detail(paper)
    return 0


def cmd_download(args: argparse.Namespace) -> int:
    arxiv_id = extract_arxiv_id(args.arxiv_id)
    print(f"Downloading paper: {arxiv_id}")
    paper = fetch_paper(arxiv_id)
    if not paper:
        print(f"\n[!] No paper found with ID '{arxiv_id}'.")
        return 1

    filename = generated_pdf_filename(arxiv_id, paper.title)
    output_path = resolve_output_path(args.output_dir, args.output_file, filename)
    parent_dir = output_path.parent if str(output_path.parent) else Path(".")
    if parent_dir.exists() and not parent_dir.is_dir():
        raise ArxivAPIError(f"Output parent path is not a directory: {parent_dir}")
    parent_dir.mkdir(parents=True, exist_ok=True)

    response = request_url(paper.pdf_url, accept="application/pdf")
    output_path.write_bytes(response.body)
    print("\n  Download succeeded!")
    print(f"  Title: {paper.title}")
    print(f"  File: {output_path.resolve()}")
    print(f"  Size: {output_path.stat().st_size / 1024:.1f} KB")
    return 0


def cmd_categories(args: argparse.Namespace) -> int:
    _ = args
    print("Common arXiv categories:\n")
    print("  Category ID          | Name")
    print("  " + "-" * 55)
    for cat_id, cat_name in CATEGORY_NAMES.items():
        print(f"  {cat_id:<20} | {cat_name}")

    print("\nShort aliases:\n")
    print("  Alias      | Category ID")
    print("  " + "-" * 30)
    for alias, cat_id in CATEGORY_ALIASES.items():
        print(f"  {alias:<10} | {cat_id}")
    print("\nUse the arXiv category list: https://arxiv.org/category_taxonomy")
    return 0


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def non_negative_int(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be a non-negative integer")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="arXiv academic paper search and download tool",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            Examples:
              %(prog)s search "transformer attention"
              %(prog)s search "au:Vaswani AND ti:attention" --sort date
              %(prog)s search "AI agent" --category cs.AI --date-from 2026-03-01 --date-to 2026-05-31 --sort date
              %(prog)s latest cs.AI --limit 5
              %(prog)s latest ml --limit 10
              %(prog)s detail 1706.03762
              %(prog)s detail https://arxiv.org/abs/1706.03762
              %(prog)s download 1706.03762
              %(prog)s download 1706.03762 --output-dir ./papers
              %(prog)s download 1706.03762 --output-file ./attention.pdf
              %(prog)s categories
        """),
    )
    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    search_parser = subparsers.add_parser("search", help="Search papers by keyword")
    search_parser.add_argument("query", nargs="?", default="", help="Search keyword or arXiv query expression")
    search_parser.add_argument("--limit", "-n", type=positive_int, default=10)
    search_parser.add_argument("--start", type=non_negative_int, default=0)
    search_parser.add_argument("--sort", choices=["relevance", "date", "updated"], default="relevance")
    search_parser.add_argument("--sort-order", choices=["ascending", "asc", "oldest", "descending", "desc", "newest"], default="descending")
    search_parser.add_argument("--field", choices=sorted(FIELD_ALIASES.keys()), default="all")
    search_parser.add_argument("--category", default="")
    search_parser.add_argument("--title", default="")
    search_parser.add_argument("--author", default="")
    search_parser.add_argument("--abstract", default="")
    search_parser.add_argument("--date-from", default="")
    search_parser.add_argument("--date-to", default="")
    search_parser.add_argument("--filter", default="")
    search_parser.add_argument("--abstract-max", type=positive_int, default=DEFAULT_ABSTRACT_MAX_CHARS)

    latest_parser = subparsers.add_parser("latest", help="Get the latest papers in a category")
    latest_parser.add_argument("category", help="arXiv category ID or alias")
    latest_parser.add_argument("--limit", "-n", type=positive_int, default=10)
    latest_parser.add_argument("--start", type=non_negative_int, default=0)
    latest_parser.add_argument("--sort-order", choices=["ascending", "asc", "oldest", "descending", "desc", "newest"], default="descending")
    latest_parser.add_argument("--date-from", default="")
    latest_parser.add_argument("--date-to", default="")
    latest_parser.add_argument("--filter", default="")
    latest_parser.add_argument("--abstract-max", type=positive_int, default=DEFAULT_ABSTRACT_MAX_CHARS)

    detail_parser = subparsers.add_parser("detail", help="View paper details")
    detail_parser.add_argument("arxiv_id", help="arXiv ID or full URL")

    download_parser = subparsers.add_parser("download", help="Download paper PDF")
    download_parser.add_argument("arxiv_id", help="arXiv ID or full URL")
    download_parser.add_argument("--output-dir", "-o", default="")
    download_parser.add_argument("--output-file", default="")

    subparsers.add_parser("categories", help="List common categories and aliases")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return 2

    handlers = {
        "search": cmd_search,
        "latest": cmd_latest,
        "detail": cmd_detail,
        "download": cmd_download,
        "categories": cmd_categories,
    }
    try:
        return handlers[args.command](args)
    except ArxivAPIError as exc:
        print(f"\n[!] arXiv request failed: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
