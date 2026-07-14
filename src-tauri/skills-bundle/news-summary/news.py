# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "httpx>=0.27",
# ]
# ///

"""
News Summary CLI — multi-source RSS news aggregation tool

Fetch RSS from international and domestic news sources, parse it into structured data, and output by category.

Usage:
    python news.py [category] [options]    Fetch news list
    python news.py detail <url> [--max N]  Fetch article body

Categories:
    general     General news (default)
    ai          AI & frontier tech
    finance     Global finance and markets
    culture     Culture, ideas, and essays
    all         All categories

Options:
    --limit N   Number of news items to display per source (default 5)
    --source X  Fetch only from the specified source (such as NPR, 36Kr)
    --list      List all available news sources
    --max N     Maximum output characters for the detail command (default 3000)
"""

import argparse
import base64
import html
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from urllib.parse import urlparse
import xml.etree.ElementTree as ET

# Windows terminal UTF-8 encoding compatibility
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")


# ==================== Data Models ====================


@dataclass
class NewsItem:
    """Single news item."""
    title: str
    description: str
    link: str
    pub_date: str
    source: str
    sort_ts: float = 0.0


@dataclass
class FeedConfig:
    """RSS source configuration."""
    name: str
    url: str
    category: str
    language: str  # "en" or "zh"


class HTTPTimeoutError(Exception):
    """HTTP request timed out."""


class HTTPStatusError(Exception):
    """HTTP request returned a non-success status code."""

    def __init__(self, status_code: int, url: str) -> None:
        self.status_code = status_code
        self.url = url
        super().__init__(f"HTTP {status_code}: {url}")


# ==================== RSS Source Registry ====================
# Organized by category to make adding new sources easier


FEEDS: list[FeedConfig] = [
    # ━━ AI 前沿 (AI & Frontier Tech) ━━
    FeedConfig("AI HOT", "https://aihot.virxact.com/feed.xml", "ai", "zh"),
    FeedConfig("The Verge AI", "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", "ai", "en"),
    FeedConfig("MIT Tech Review AI", "https://www.technologyreview.com/topic/artificial-intelligence/feed/", "ai", "en"),
    FeedConfig("Ars Technica", "https://arstechnica.com/information-technology/feed/", "ai", "en"),
    FeedConfig("Wired Science", "https://www.wired.com/feed/tag/ai/latest/rss", "ai", "en"),
    FeedConfig("TechCrunch AI", "https://techcrunch.com/category/artificial-intelligence/feed/", "ai", "en"),

    # ━━ 财经风向 (Global Finance & Markets) ━━
    FeedConfig("FT Markets", "https://www.ft.com/markets?format=rss", "finance", "en"),
    FeedConfig("TechCrunch Venture", "https://techcrunch.com/feed/", "finance", "en"),
    FeedConfig("华尔街见闻中文", "https://rsshub.app/wallstreetcn/live", "finance", "zh"),
    FeedConfig("36氪", "https://36kr.com/feed", "finance", "zh"),

    # ━━ 文化与深思 (Culture, Ideas & Essay) ━━
    FeedConfig("The Atlantic", "https://www.theatlantic.com/feed/all/", "culture", "en"),
    FeedConfig("New Yorker Culture", "https://www.newyorker.com/feed/culture", "culture", "en"),
    FeedConfig("Aeon Magazine", "https://aeon.co/feed.rss", "culture", "en"),
    FeedConfig("Nowness", "https://www.nowness.com/rss", "culture", "en"),
    FeedConfig("Southern Weekly (南方周末)", "https://feedx.net/rss/infzm.xml", "culture", "zh"),

    # ━━ 综合新闻 ━━
    FeedConfig("新华社", "https://plink.anyfeeder.com/newscn/whxw", "general", "zh"),
    FeedConfig("纽约时报双语版", "https://feedx.net/rss/nytimesdual.xml", "general", "zh"),
    FeedConfig("界面新闻", "https://a.jiemian.com/index.php?m=article&a=rss", "general", "zh"),
    FeedConfig("澎湃新闻", "https://plink.anyfeeder.com/thepaper", "general", "zh"),
    FeedConfig("NPR", "https://feeds.npr.org/1001/rss.xml", "general", "en"),
    FeedConfig("Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml", "general", "en"),
]


CATEGORY_LABELS: dict[str, str] = {
    "general": "综合新闻",
    "ai": "AI 前沿",
    "finance": "财经风向",
    "culture": "文化与深思",
    "all": "All categories",
}

CATEGORY_ALIASES: dict[str, str] = {
    "world": "general",
    "china": "general",
    "tech": "ai",
    "business": "finance",
}


def normalize_category(category: str) -> str:
    """Normalize category names, keeping old CLI aliases working."""
    normalized = category.strip().lower()
    return CATEGORY_ALIASES.get(normalized, normalized)


def get_feeds_for_category(category: str) -> list[FeedConfig]:
    """Filter sources by category."""
    category = normalize_category(category)
    if category == "all":
        return FEEDS
    return [f for f in FEEDS if f.category == category]


def get_feed_by_name(name: str) -> list[FeedConfig]:
    """Fuzzy-match by source name."""
    name_lower = name.lower()
    return [f for f in FEEDS if name_lower in f.name.lower()]


# ==================== RSS Parser ====================


_TEXT_SKIP_TAGS = frozenset([
    "script", "style", "noscript", "iframe", "svg", "math",
    "button", "input", "select", "textarea", "label",
])

_TEXT_BLOCK_TAGS = frozenset([
    "p", "div", "section", "article", "main", "h1", "h2", "h3", "h4", "h5", "h6",
    "li", "tr", "blockquote", "pre", "br", "hr",
])

_NOISE_LINE_PATTERNS = [
    re.compile(pattern, re.IGNORECASE)
    for pattern in [
        r"^(advertisement|ad|sponsored|subscribe|sign in|log in|read more|share|shares?)$",
        r"^(accessibility links|keyboard shortcuts.*|skip to main content|menu|search|listen|watch|news)$",
        r"^(cookies?|privacy policy|hide caption|toggle caption|caption)$",
        r"^(责任编辑|责编|编辑|校对|来源|举报|广告|分享|收藏|字号|版权声明)[:：]?.*$",
        r"^(相关阅读|相关报道|点击查看|展开全文|收起全文)$",
    ]
]


def _normalize_text_line(text: str) -> str:
    """Normalize one plain-text line."""
    text = html.unescape(text)
    text = text.replace("\u200b", "").replace("\ufeff", "")
    return re.sub(r"[ \t\r\f\v]+", " ", text).strip()


def _is_noise_line(line: str) -> bool:
    """Return whether a line is likely page chrome rather than article content."""
    if not line:
        return True
    if len(line) <= 2:
        return True
    return any(pattern.search(line) for pattern in _NOISE_LINE_PATTERNS)


def _clean_text_block(text: str, *, preserve_paragraphs: bool, filter_noise: bool = False) -> str:
    """Normalize whitespace, optionally remove page-noise lines, and deduplicate repeats."""
    raw_lines = [_normalize_text_line(line) for line in text.splitlines()]
    result: list[str] = []
    seen_lines: set[str] = set()
    prev_empty = False

    for line in raw_lines:
        if filter_noise and _is_noise_line(line):
            continue

        if not line:
            if preserve_paragraphs and result and not prev_empty:
                result.append("")
                prev_empty = True
            continue

        normalized_for_dedupe = re.sub(r"\s+", " ", line).casefold()
        if len(normalized_for_dedupe) > 5 and normalized_for_dedupe in seen_lines:
            continue
        if len(normalized_for_dedupe) > 5:
            seen_lines.add(normalized_for_dedupe)

        result.append(line)
        prev_empty = False

    while result and result[-1] == "":
        result.pop()

    if preserve_paragraphs:
        return "\n".join(result).strip()
    return re.sub(r"\s+", " ", " ".join(line for line in result if line)).strip()


class _HTMLTextParser(HTMLParser):
    """Small text extractor for RSS snippets and article fragments."""

    def __init__(self, *, skip_tags: frozenset[str], preserve_paragraphs: bool) -> None:
        super().__init__(convert_charrefs=True)
        self.pieces: list[str] = []
        self.skip_tags = skip_tags
        self.preserve_paragraphs = preserve_paragraphs
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag_lower = tag.lower()
        if tag_lower in self.skip_tags:
            self._skip_depth += 1
        elif self.preserve_paragraphs and tag_lower in _TEXT_BLOCK_TAGS and self.pieces:
            self.pieces.append("\n")
        elif tag_lower == "br":
            self.pieces.append("\n" if self.preserve_paragraphs else " ")

    def handle_endtag(self, tag: str) -> None:
        tag_lower = tag.lower()
        if tag_lower in self.skip_tags and self._skip_depth > 0:
            self._skip_depth -= 1
        elif self.preserve_paragraphs and tag_lower in _TEXT_BLOCK_TAGS:
            self.pieces.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0:
            self.pieces.append(data)

    def get_text(self, *, filter_noise: bool = False) -> str:
        return _clean_text_block(
            "".join(self.pieces),
            preserve_paragraphs=self.preserve_paragraphs,
            filter_noise=filter_noise,
        )


def _clean_html(text: str) -> str:
    """Clean HTML tags and entities, extracting plain text."""
    if not text:
        return ""
    text = re.sub(r'<!\[CDATA\[(.*?)\]\]>', r'\1', text, flags=re.DOTALL)
    parser = _HTMLTextParser(skip_tags=_TEXT_SKIP_TAGS, preserve_paragraphs=False)
    try:
        parser.feed(text)
        return parser.get_text(filter_noise=True)
    except Exception:
        fallback = re.sub(r"<[^>]+>", " ", html.unescape(text))
        return _clean_text_block(fallback, preserve_paragraphs=False, filter_noise=True)


def _parse_pub_date(date_str: str) -> tuple[str, float]:
    """Parse publication date into a display string and sortable timestamp."""
    if not date_str:
        return "", 0.0

    date_str = html.unescape(date_str.strip())
    normalized_date = re.sub(r"\s+", " ", date_str)
    try:
        dt = parsedate_to_datetime(normalized_date)
        return dt.strftime("%m-%d %H:%M"), dt.timestamp()
    except (TypeError, ValueError, OverflowError):
        pass

    iso_candidate = normalized_date.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(iso_candidate)
        return dt.strftime("%m-%d %H:%M"), dt.timestamp()
    except ValueError:
        pass

    for fmt in [
        "%a, %d %b %Y %H:%M:%S %z",   # RFC 2822 (BBC)
        "%a, %d %b %Y %H:%M:%S %Z",   # With timezone name
        "%Y-%m-%dT%H:%M:%S%z",         # ISO 8601
        "%Y-%m-%dT%H:%M:%SZ",          # ISO 8601 UTC
        "%Y-%m-%d %H:%M:%S",           # Simple format
        "%Y-%m-%d %H:%M",              # Simple format without seconds
    ]:
        try:
            dt = datetime.strptime(normalized_date, fmt)
            return dt.strftime("%m-%d %H:%M"), dt.timestamp()
        except ValueError:
            continue

    display = normalized_date[:16] if len(normalized_date) > 16 else normalized_date
    return display, 0.0


def _sort_news_items(items: list[NewsItem]) -> list[NewsItem]:
    """Sort dated items newest-first while keeping undated items in source order."""
    dated = [item for item in items if item.sort_ts > 0]
    undated = [item for item in items if item.sort_ts <= 0]
    return sorted(dated, key=lambda item: item.sort_ts, reverse=True) + undated


def parse_rss(xml_content: str, source_name: str) -> list[NewsItem]:
    """Parse RSS XML into a list of NewsItem objects."""
    items: list[NewsItem] = []

    try:
        root = ET.fromstring(xml_content)
    except ET.ParseError:
        return items

    # Standard RSS 2.0 format
    for item_elem in root.iter("item"):
        title = _clean_html(item_elem.findtext("title", ""))
        desc = _clean_html(item_elem.findtext("description", ""))
        link = (item_elem.findtext("link", "") or "").strip()
        pub_date, sort_ts = _parse_pub_date(item_elem.findtext("pubDate", ""))

        if title:
            # Truncate overly long descriptions (reduce Agent context consumption)
            if len(desc) > 200:
                desc = desc[:200] + "..."
            items.append(NewsItem(
                title=title,
                description=desc,
                link=link,
                pub_date=pub_date,
                source=source_name,
                sort_ts=sort_ts,
            ))

    # Atom format fallback (some sources use Atom)
    if not items:
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        for entry in root.findall(".//atom:entry", ns):
            title = _clean_html(entry.findtext("atom:title", "", ns))
            # Atom summary or content
            desc = _clean_html(
                entry.findtext("atom:summary", "", ns) or
                entry.findtext("atom:content", "", ns)
            )
            link_elem = entry.find("atom:link", ns)
            link = link_elem.get("href", "") if link_elem is not None else ""
            pub_date, sort_ts = _parse_pub_date(
                entry.findtext("atom:updated", "", ns) or
                entry.findtext("atom:published", "", ns)
            )

            if title:
                if len(desc) > 200:
                    desc = desc[:200] + "..."
                items.append(NewsItem(
                    title=title,
                    description=desc,
                    link=link,
                    pub_date=pub_date,
                    source=source_name,
                    sort_ts=sort_ts,
                ))

    return _sort_news_items(items)


# ==================== HTTP Fetching ====================


def broker_helper_available() -> bool:
    """Return whether AgentVis brokerOnly helper environment is present."""
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


def _broker_get_text(url: str, headers: dict[str, str], timeout: float) -> str:
    """Fetch text through the AgentVis broker helper."""
    helper = os.environ.get("AGENTVIS_BROKER_FETCH") or "agentvis-broker-fetch"
    request = {
        "method": "GET",
        "url": url,
        "headers": [
            {"name": name, "value": value}
            for name, value in headers.items()
            if value
        ],
        "timeoutMs": int(timeout * 1000),
    }
    completed = subprocess.run(
        [helper],
        input=json.dumps(request),
        text=True,
        capture_output=True,
        timeout=timeout + 10,
        check=False,
    )

    try:
        payload = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Broker helper returned invalid JSON: {exc}") from exc

    if completed.returncode != 0 or payload.get("ok") is not True:
        error = payload.get("error") or completed.stderr or "unknown broker helper failure"
        diagnostic_error = f"{error}{broker_failure_diagnostics(payload, url)}"
        if "timeout" in str(error).lower() or "timed out" in str(error).lower():
            raise HTTPTimeoutError(str(diagnostic_error))
        raise RuntimeError(f"Broker helper request failed: {diagnostic_error}")

    status_code = int(payload.get("status") or 0)
    if status_code >= 400:
        raise HTTPStatusError(status_code, url)

    body = base64.b64decode(payload.get("bodyBase64") or "")
    return body.decode("utf-8", errors="replace")


def _direct_get_text(url: str, headers: dict[str, str], timeout: float) -> str:
    """Fetch text with httpx for local/non-broker execution."""
    import httpx

    try:
        response = httpx.get(
            url,
            timeout=timeout,
            follow_redirects=True,
            headers=headers,
        )
        response.raise_for_status()
        return response.text
    except httpx.TimeoutException as exc:
        raise HTTPTimeoutError(str(exc)) from exc
    except httpx.HTTPStatusError as exc:
        raise HTTPStatusError(exc.response.status_code, url) from exc


def _http_get_text(url: str, headers: dict[str, str], timeout: float = 20.0) -> str:
    """Fetch text through brokerOnly helper when available, otherwise httpx."""
    if broker_helper_available():
        return _broker_get_text(url, headers, timeout)
    return _direct_get_text(url, headers, timeout)


def fetch_feed(feed: FeedConfig, timeout: float = 20.0) -> list[NewsItem]:
    """Fetch and parse a single RSS source."""
    try:
        text = _http_get_text(
            feed.url,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) NewsBot/1.0",
                "Accept": "application/rss+xml, application/xml, text/xml",
            },
            timeout=timeout,
        )
        return parse_rss(text, feed.name)
    except HTTPTimeoutError:
        print(f"  [Timeout] {feed.name} ({feed.url})", file=sys.stderr)
        return []
    except HTTPStatusError as e:
        print(f"  [HTTP {e.status_code}] {feed.name}", file=sys.stderr)
        return []
    except Exception as e:
        print(f"  [Error] {feed.name}: {e}", file=sys.stderr)
        return []


# ==================== Output Formatting ====================


# Category emoji mapping
CATEGORY_EMOJI: dict[str, str] = {
    "general": "📰",
    "ai": "🤖",
    "finance": "💹",
    "culture": "📚",
}


def format_output(all_items: dict[str, list[NewsItem]], limit: int,
                  full_texts: dict[str, str] | None = None) -> str:
    """Format news output as structured plain text.

    full_texts: mapping from URL -> article body text (used in --full mode)
    """
    lines: list[str] = []
    today = datetime.now().strftime("%Y-%m-%d")
    lines.append(f"📰 News Summary [{today}]")
    lines.append("")

    source_entries = [
        (source_name, _sort_news_items(items))
        for source_name, items in all_items.items()
    ]
    source_entries = [
        entry for _, entry in sorted(
            enumerate(source_entries),
            key=lambda pair: (
                max((item.sort_ts for item in pair[1][1]), default=0.0),
                -pair[0],
            ),
            reverse=True,
        )
    ]

    for source_name, items in source_entries:
        if not items:
            continue

        lines.append(f"━━ {source_name} ━━")
        for item in items[:limit]:
            date_prefix = f"[{item.pub_date}] " if item.pub_date else ""
            lines.append(f"  • {date_prefix}{item.title}")
            if item.description:
                lines.append(f"    {item.description}")
            if item.link:
                lines.append(f"    {item.link}")
            # --full mode: append article body below each news item
            if full_texts and item.link and item.link in full_texts:
                body = full_texts[item.link]
                if body:
                    lines.append("")
                    lines.append("    ── Body ──")
                    # Indent each body line by 4 spaces to keep hierarchy clear
                    for body_line in body.splitlines():
                        lines.append(f"    {body_line}" if body_line.strip() else "")
                    lines.append("    ── /Body ──")
        lines.append("")

    if not any(all_items.values()):
        lines.append("  (No news data)")

    return "\n".join(lines)


# ==================== Command Implementations ====================


def _fetch_article_text(url: str, max_chars: int) -> str:
    """Fetch the body text of a single article (used in --full mode)."""
    try:
        text = _http_get_text(
            url,
            timeout=20.0,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            },
        )
        body = _extract_article_body(text)
        if len(body) > max_chars:
            body = body[:max_chars] + f"\n... [Truncated, exceeded {max_chars} characters]"
        return body
    except Exception as e:
        return f"[Fetch failed: {e}]"


def cmd_fetch(category: str, limit: int, source_filter: str | None,
             full: bool = False, max_chars: int = 1500) -> None:
    """Fetch news.

    full: whether to also fetch the full body of each article
    max_chars: maximum number of characters per article body in --full mode
    """
    category = normalize_category(category)
    if source_filter:
        feeds = get_feed_by_name(source_filter)
        if not feeds:
            print(f"Source not found: {source_filter}")
            print(f"Use --list to view all available sources")
            sys.exit(1)
    else:
        feeds = get_feeds_for_category(category)

    if not feeds:
        print(f"No available news sources under category '{category}'")
        sys.exit(1)

    print(f"Fetching {len(feeds)} news sources...", file=sys.stderr)

    all_items: dict[str, list[NewsItem]] = {}
    for feed in feeds:
        items = fetch_feed(feed)
        if items:
            all_items[f"{CATEGORY_EMOJI.get(feed.category, '📰')} {feed.name}"] = items

    # --full mode: traverse all article links to fetch body text
    full_texts: dict[str, str] | None = None
    if full:
        full_texts = {}
        # Collect URLs to fetch (truncated by limit)
        urls_to_fetch: list[str] = []
        for items in all_items.values():
            for item in items[:limit]:
                if item.link:
                    urls_to_fetch.append(item.link)

        total = len(urls_to_fetch)
        print(f"Fetching {total} article bodies...", file=sys.stderr)
        for i, url in enumerate(urls_to_fetch, 1):
            print(f"  [{i}/{total}] {url[:60]}...", file=sys.stderr)
            full_texts[url] = _fetch_article_text(url, max_chars)

    output = format_output(all_items, limit, full_texts)
    print(output)


def cmd_list_sources() -> None:
    """List all available sources."""
    print("\nAvailable news sources:\n")
    by_category: dict[str, list[FeedConfig]] = {}
    for feed in FEEDS:
        by_category.setdefault(feed.category, []).append(feed)

    for cat, feeds in by_category.items():
        emoji = CATEGORY_EMOJI.get(cat, "📰")
        print(f"{emoji} {cat.upper()}")
        for f in feeds:
            lang_tag = f"[{f.language}]"
            print(f"  • {f.name} {lang_tag}")
            print(f"    {f.url}")
        print()


# ==================== Article Body Extraction ====================


# Non-body HTML tags to skip
_SKIP_TAGS = frozenset([
    "script", "style", "noscript", "iframe", "svg", "math",
    "nav", "header", "footer", "aside", "form", "button",
    "input", "select", "textarea", "label",
    "figcaption", "figure",
])

# Article semantic container tags (prefer extracting content inside these containers)
_ARTICLE_TAGS = frozenset(["article", "main"])

# Block-level tags (need line breaks before and after)
_BLOCK_TAGS = frozenset([
    "p", "div", "section", "h1", "h2", "h3", "h4", "h5", "h6",
    "li", "tr", "blockquote", "pre", "br", "hr",
])


class _ArticleHTMLParser(HTMLParser):
    """Article body extractor based on Python's built-in html.parser.

    Traverse the HTML tag tree, skip non-body tags such as script/style/nav,
    insert line breaks at block-level tags, and finally output clean plain text.
    """

    def __init__(self) -> None:
        super().__init__()
        self.pieces: list[str] = []
        self._skip_depth: int = 0  # Nested depth of skipped tags

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag_lower = tag.lower()
        if tag_lower in _SKIP_TAGS:
            self._skip_depth += 1
        elif tag_lower in _BLOCK_TAGS and self.pieces:
            self.pieces.append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag_lower = tag.lower()
        if tag_lower in _SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1
        elif tag_lower in _BLOCK_TAGS:
            self.pieces.append("\n")

    def handle_data(self, data: str) -> None:
        # Do not collect text while inside skipped tags
        if self._skip_depth == 0:
            self.pieces.append(data)

    def get_text(self) -> str:
        raw = "".join(self.pieces)
        return _clean_text_block(raw, preserve_paragraphs=True, filter_noise=True)


def _article_text_score(text: str) -> int:
    """Score extracted text candidates by body-like density."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return 0
    total_chars = sum(len(line) for line in lines)
    long_lines = sum(1 for line in lines if len(line) >= 45)
    short_lines = sum(1 for line in lines if len(line) <= 12)
    link_like = sum(1 for line in lines if re.search(r"^(http|www\.|更多|阅读|查看|share)", line, re.I))
    return total_chars + long_lines * 80 - short_lines * 15 - link_like * 120


def _best_article_candidate(candidates: list[str]) -> str:
    """Pick the best article text candidate from parsed page fragments."""
    candidates = [candidate for candidate in candidates if len(candidate) > 80]
    if not candidates:
        return ""
    return max(candidates, key=_article_text_score)


def _extract_article_body(html_content: str) -> str:
    """Extract article body from HTML using semantic containers and density scoring."""
    candidates: list[str] = []

    for tag in _ARTICLE_TAGS:
        pattern = re.compile(rf'<{tag}[^>]*>(.*?)</{tag}>', re.DOTALL | re.IGNORECASE)
        candidates.extend(_parse_html_fragment(match.group(1)) for match in pattern.finditer(html_content))

    # Strategy 2: common article body class/id pattern matching
    # Many news sites mark article body areas with specific classes
    content_patterns = [
        r'(?:class|id)\s*=\s*["\'][^"\']*(?:article[_-]?(?:content|body|text|detail)|'
        r'post[_-]?(?:content|body|text)|'
        r'entry[_-]?(?:content|body)|'
        r'news[_-]?(?:content|body|text)|'
        r'content[_-]?(?:area|body|text|detail)|'
        r'main[_-]?(?:content|text)|'
        r'rich[_-]?text|'
        r'paragraph)',
    ]
    for cp in content_patterns:
        # Find a div containing that class/id and extract its content
        div_pattern = re.compile(
            rf'<div\s+[^>]*{cp}[^>]*>(.*?)</div>',
            re.DOTALL | re.IGNORECASE
        )
        for m in div_pattern.finditer(html_content):
            candidates.append(_parse_html_fragment(m.group(1)))

    # Strategy 3: fall back to <body>, but try to select the best <div> by text density
    body_match = re.search(
        r'<body[^>]*>(.*?)</body>',
        html_content, re.DOTALL | re.IGNORECASE
    )
    content = body_match.group(1) if body_match else html_content

    # Try to find the top-level div with the highest text density
    div_pattern = re.compile(
        r'<div[^>]*>(.*?)</div>',
        re.DOTALL | re.IGNORECASE
    )
    for m in div_pattern.finditer(content):
        candidates.append(_parse_html_fragment(m.group(1)))

    full_body = _parse_html_fragment(content)
    candidates.append(full_body)
    best_text = _best_article_candidate(candidates)

    return best_text or full_body


def _parse_html_fragment(html_fragment: str) -> str:
    """Parse an HTML fragment into plain text."""
    parser = _ArticleHTMLParser()
    parser.feed(html_fragment)
    return parser.get_text()


def cmd_detail(url: str, max_chars: int) -> None:
    """Fetch article body."""
    print(f"Fetching: {url}", file=sys.stderr)

    try:
        text = _http_get_text(
            url,
            timeout=20.0,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            },
        )
    except HTTPTimeoutError:
        print("Fetch timed out", file=sys.stderr)
        sys.exit(1)
    except HTTPStatusError as e:
        print(f"HTTP error: {e.status_code}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Fetch failed: {e}", file=sys.stderr)
        sys.exit(1)

    # Extract title
    title_match = re.search(r'<title[^>]*>(.*?)</title>',
                            text, re.DOTALL | re.IGNORECASE)
    title = _clean_html(title_match.group(1)) if title_match else ""

    # Extract body
    body_text = _extract_article_body(text)

    # Truncate output (control Agent context consumption)
    truncated = False
    if len(body_text) > max_chars:
        body_text = body_text[:max_chars]
        truncated = True

    # Output
    if title:
        print(f"\nTitle: {title}")
    print(f"Source: {url}")
    print(f"Character count: {len(body_text)}")
    print("\n" + "=" * 60 + "\n")
    print(body_text)
    if truncated:
        print(f"\n... [Truncated, original text exceeded {max_chars} characters] ...")
    print()


# ==================== Main Entry ====================


def main() -> None:
    # Detect the "detail" subcommand (intercept before argparse to avoid conflict with choices)
    if len(sys.argv) >= 2 and sys.argv[1] == "detail":
        detail_parser = argparse.ArgumentParser(
            description="Fetch article body",
            usage="python news.py detail <url> [--max N]",
        )
        detail_parser.add_argument("url", help="Article URL")
        detail_parser.add_argument("--max", "-m", type=int, default=3000,
                                   dest="max_chars",
                                   help="Maximum output characters (default: 3000)")
        # Skip argv[1] ("detail") and parse the remaining arguments
        args = detail_parser.parse_args(sys.argv[2:])
        cmd_detail(args.url, args.max_chars)
        return

    parser = argparse.ArgumentParser(
        description="News Summary CLI — multi-source RSS news aggregation",
        usage="python news.py [category] [options]  |  python news.py detail <url>",
    )
    parser.add_argument("category", nargs="?", default="general",
                        choices=[*CATEGORY_LABELS.keys(), *CATEGORY_ALIASES.keys()],
                        help="News category (default: general)")
    parser.add_argument("--limit", "-n", type=int, default=5,
                        help="Number of items to display per source (default: 5)")
    parser.add_argument("--source", "-s", type=str, default=None,
                        help="Fetch only from the specified source (fuzzy-match source name)")
    parser.add_argument("--full", "-f", action="store_true",
                        help="Also fetch the full body of each article")
    parser.add_argument("--max", "-m", type=int, default=800,
                        dest="max_chars",
                        help="Maximum number of characters per article body in --full mode (default: 800)")
    parser.add_argument("--list", "-l", action="store_true",
                        help="List all available sources")

    args = parser.parse_args()

    if args.list:
        cmd_list_sources()
    else:
        cmd_fetch(args.category, args.limit, args.source,
                  full=args.full, max_chars=args.max_chars)


if __name__ == "__main__":
    main()
