"""
Web Scraper - web knowledge scraping script

Scrape web page content from any URL, extract structured knowledge, and output
it as a Markdown file. Supports single-page scraping, multi-page recursive
scraping, and automatic Sitemap discovery.

Dependencies: httpx, beautifulsoup4, lxml, chardet, tqdm
(all are already in runtime-requirements-v1.txt, no additional installation required)

Usage:
    python scrape.py "URL" [options]
    python scrape.py "URL" --depth 2 --max-pages 30 -o ./output
    python scrape.py "URL" --sitemap --max-pages 50 -o ./output
"""

import argparse
from copy import copy
from email.utils import parsedate_to_datetime
import importlib.util
import io
import json
import os
import random
import re
import sys

# Windows terminals use cp1252 by default and cannot output UTF-8 characters.
# Force stdout/stderr to use utf-8 and replace unencodable characters.
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
import time
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

import httpx
from bs4 import BeautifulSoup, Comment, Tag
from tqdm import tqdm

from spa_extractors import is_sparse_content, try_structured_spa_source

try:
    import chardet
except ImportError:
    chardet = None

try:
    from charset_normalizer import from_bytes as charset_from_bytes
except ImportError:
    charset_from_bytes = None


# ==================== Constants ====================

# Default User-Agent, impersonating a mainstream browser to avoid anti-scraping blocking.
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

# Default CSS selectors to exclude, filtering noisy areas such as navigation, sidebars, and footers.
DEFAULT_EXCLUDE_SELECTORS = [
    "nav", "header", "footer",
    ".sidebar", ".nav", ".navigation", ".menu",
    ".breadcrumb", ".breadcrumbs",
    ".toc", ".table-of-contents",
    ".left-sidebar", ".right-sidebar",
    ".reference-layout__toc", ".layout__right-sidebar",
    ".article-footer",
    ".ads", ".advertisement",
    ".cookie-banner", ".cookie-consent",
    "#cookie-banner", "#cookie-consent",
    "script", "style", "noscript", "iframe",
]

# Characters not allowed in filenames (Windows compatible).
FILENAME_UNSAFE_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

# Minimum text density threshold for body-content detection (character count / tag count).
MIN_TEXT_DENSITY = 20

# Network resilience defaults. Kept internal so the CLI stays small.
RETRIABLE_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}
SOFT_BLOCK_STATUS_CODES = {401, 403, 429}
MAX_FETCH_ATTEMPTS = 3
MAX_RETRY_AFTER_SECONDS = 15.0

CHALLENGE_PAGE_SIGNALS = (
    ("challenges.cloudflare.com", "Cloudflare challenge"),
    ("cf-chl-", "Cloudflare challenge"),
    ("turnstile", "Cloudflare Turnstile"),
    ("g-recaptcha", "reCAPTCHA"),
    ("hcaptcha.com", "hCaptcha"),
    ("datadome", "DataDome challenge"),
    ("perimeterx", "PerimeterX challenge"),
    ("px-captcha", "PerimeterX challenge"),
    ("akamai bot manager", "Akamai challenge"),
    ("_abck", "Akamai challenge"),
    ("please enable cookies", "cookie/JS challenge"),
    ("checking your browser", "browser verification"),
    ("verify you are human", "human verification"),
    ("unusual traffic", "traffic verification"),
    ("access denied", "access denied page"),
)

TRACKING_QUERY_PREFIXES = ("utm_",)
TRACKING_QUERY_PARAMS = {
    "fbclid",
    "gclid",
    "dclid",
    "gbraid",
    "wbraid",
    "mc_cid",
    "mc_eid",
    "igshid",
    "msclkid",
    "yclid",
}


def _is_hash_router_fragment(fragment: str) -> bool:
    """Return True for SPA route fragments such as #/docs or #!/docs."""
    return fragment.startswith("/") or fragment.startswith("!/")


def _is_local_anchor_href(href: str) -> bool:
    if not href.startswith("#"):
        return False
    return not _is_hash_router_fragment(href[1:])


def default_proxy_from_env() -> str | None:
    """Return the AgentVis broker proxy (or a standard proxy env) when present."""
    for key in (
        "AGENTVIS_NETWORK_PROXY_URL",
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ):
        value = os.environ.get(key)
        if value:
            return value
    return None


# ==================== HTTP Client ====================

# Browser fingerprint list supported by curl_cffi (common values).
SUPPORTED_IMPERSONATE = [
    "chrome131", "chrome124", "chrome120", "chrome116", "chrome110",
    "chrome107", "chrome104", "chrome101", "chrome100",
    "edge101", "edge99",
    "safari17_0", "safari15_5", "safari15_3",
]


def _major_from_impersonate(impersonate: str | None) -> str | None:
    if not impersonate:
        return None
    match = re.search(r"(chrome|edge)(\d+)", impersonate)
    return match.group(2) if match else None


def _user_agent_for_impersonate(user_agent: str, impersonate: str | None) -> str:
    """Keep the visible UA close to the TLS/browser profile when possible."""
    if not impersonate or user_agent != DEFAULT_USER_AGENT:
        return user_agent

    major = _major_from_impersonate(impersonate)
    if impersonate.startswith("edge") and major:
        return (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            f"Chrome/{major}.0.0.0 Safari/537.36 Edg/{major}.0.0.0"
        )
    if impersonate.startswith("chrome") and major:
        return (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            f"Chrome/{major}.0.0.0 Safari/537.36"
        )
    if impersonate.startswith("safari17"):
        return (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) "
            "Version/17.0 Safari/605.1.15"
        )
    if impersonate.startswith("safari15"):
        version = "15.5" if "15_5" in impersonate else "15.3"
        return (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) "
            f"Version/{version} Safari/605.1.15"
        )
    return user_agent


def _platform_hint_from_user_agent(user_agent: str) -> str:
    if "Macintosh" in user_agent:
        return "macOS"
    if "Linux" in user_agent:
        return "Linux"
    return "Windows"


def _build_browser_headers(user_agent: str, impersonate: str | None = None) -> dict[str, str]:
    user_agent = _user_agent_for_impersonate(user_agent, impersonate)
    headers = {
        "User-Agent": user_agent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
    }

    chrome_match = re.search(r"Chrome/(\d+)", user_agent)
    if chrome_match:
        major = chrome_match.group(1)
        platform = _platform_hint_from_user_agent(user_agent)
        if "Edg/" in user_agent:
            headers["Sec-CH-UA"] = (
                f'"Microsoft Edge";v="{major}", "Chromium";v="{major}", "Not_A Brand";v="24"'
            )
        else:
            headers["Sec-CH-UA"] = (
                f'"Google Chrome";v="{major}", "Chromium";v="{major}", "Not_A Brand";v="24"'
            )
        headers["Sec-CH-UA-Mobile"] = "?0"
        headers["Sec-CH-UA-Platform"] = f'"{platform}"'

    return headers


class CurlCffiResponse:
    """
    curl_cffi response adapter

    Maps curl_cffi's requests-like Response to an httpx.Response-compatible
    interface, so fetch_page does not need to distinguish the underlying HTTP library.
    """

    def __init__(self, resp: 'curl_cffi.requests.Response') -> None:
        self._resp = resp
        self.status_code: int = resp.status_code
        self.content: bytes = resp.content
        self.url = resp.url
        self.encoding: str | None = resp.encoding
        self.headers = resp.headers

    def raise_for_status(self) -> None:
        """Raise an exception when the HTTP status code is >= 400."""
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}",
                request=httpx.Request("GET", str(self.url)),
                response=httpx.Response(self.status_code),
            )


class CurlCffiClient:
    """
    curl_cffi client adapter

    Wraps curl_cffi.requests.Session and provides .get() / .close() interfaces
    compatible with httpx.Client. Uses browser TLS fingerprint impersonation to
    bypass some anti-scraping detection.

    Advantages of curl_cffi over regular httpx:
    - TLS fingerprints match real browsers (JA3/JA4 fingerprint)
    - Supports HTTP/2 protocol negotiation
    - Automatically handles Brotli/Zstd compression
    """

    def __init__(
        self,
        timeout: float = 15.0,
        proxy: str | None = None,
        headers: dict[str, str] | None = None,
        impersonate: str = "chrome131",
        cookies: dict[str, str] | None = None,
    ) -> None:
        from curl_cffi import requests as curl_requests
        self._session = curl_requests.Session(
            impersonate=impersonate,
            timeout=timeout,
            proxies={"http": proxy, "https": proxy} if proxy else None,
            headers=headers or {},
        )
        if cookies:
            self._session.cookies.update(cookies)

    def get(self, url: str, headers: dict[str, str] | None = None) -> CurlCffiResponse:
        """Issue a GET request and return the adapted response."""
        resp = self._session.get(url, allow_redirects=True, headers=headers)
        return CurlCffiResponse(resp)

    def close(self) -> None:
        """Close the underlying session."""
        self._session.close()


def create_http_client(
    timeout: float = 15.0,
    proxy: str | None = None,
    headers: dict[str, str] | None = None,
    user_agent: str = DEFAULT_USER_AGENT,
    http2: bool = True,
    impersonate: str | None = None,
    cookies: dict[str, str] | None = None,
) -> httpx.Client | CurlCffiClient:
    """
    Create an HTTP client (supports both httpx and curl_cffi backends).

    Uses curl_cffi (browser TLS fingerprint impersonation) when the impersonate
    parameter is specified; otherwise uses httpx (lightweight and fast).

    @param impersonate: Browser fingerprint identifier (for example 'chrome131');
        uses curl_cffi when provided.
    @param cookies: Cookie dictionary attached to all requests, with higher
        priority than Set-Cookie response headers.
    """
    default_headers = _build_browser_headers(user_agent, impersonate)
    if headers:
        default_headers.update(headers)

    # Use curl_cffi's browser fingerprint impersonation mode.
    if impersonate:
        try:
            return CurlCffiClient(
                timeout=timeout,
                proxy=proxy,
                headers=default_headers,
                impersonate=impersonate,
                cookies=cookies,
            )
        except ImportError:
            print("[!] curl_cffi is not installed, falling back to httpx")
        except Exception as e:
            print(f"[!] curl_cffi initialization failed: {e}, falling back to httpx")

    # Use httpx by default.
    # Automatically detects whether the h2 dependency is available; silently falls back to HTTP/1.1 if not.
    use_http2 = False
    if http2:
        try:
            import h2  # noqa: F401
            use_http2 = True
        except ImportError:
            pass

    return httpx.Client(
        timeout=timeout,
        headers=default_headers,
        proxy=proxy,
        follow_redirects=True,
        http2=use_http2,
        cookies=cookies or {},
    )


# ==================== Encoding Detection ====================

def detect_encoding(content: bytes, declared_encoding: str | None = None) -> str:
    """
    Intelligently detect web page encoding.

    Prefer the encoding declared in the HTTP response header, then fall back to
    chardet auto-detection. This correctly handles non-UTF-8 scenarios such as
    Chinese web pages.
    """
    if declared_encoding:
        try:
            content.decode(declared_encoding)
            return declared_encoding
        except (UnicodeDecodeError, LookupError):
            pass

    # chardet auto-detection
    if chardet is not None:
        detection = chardet.detect(content)
        if detection and detection.get("encoding"):
            detected = detection["encoding"]
            confidence = detection.get("confidence", 0)
        # Only accept the detection result when confidence is above 0.7.
            if confidence > 0.7:
                return detected

    # Final fallback to UTF-8.
    # charset_normalizer is common in the httpx dependency chain and serves as a lightweight fallback.
    if charset_from_bytes is not None:
        try:
            best = charset_from_bytes(content).best()
            if best and best.encoding:
                return best.encoding
        except Exception:
            pass

    return "utf-8"


# ==================== Page Fetching ====================

def _get_response_header(response: object, name: str) -> str:
    headers = getattr(response, "headers", None)
    if not headers:
        return ""
    try:
        return str(headers.get(name, "") or headers.get(name.lower(), ""))
    except AttributeError:
        return ""


def _retry_after_seconds(response: object | None) -> float | None:
    if response is None:
        return None

    retry_after = _get_response_header(response, "retry-after").strip()
    if not retry_after:
        return None

    try:
        return min(float(retry_after), MAX_RETRY_AFTER_SECONDS)
    except ValueError:
        pass

    try:
        retry_at = parsedate_to_datetime(retry_after)
        if retry_at.tzinfo is None:
            retry_at = retry_at.replace(tzinfo=timezone.utc)
        seconds = (retry_at - datetime.now(timezone.utc)).total_seconds()
        return min(max(seconds, 0.0), MAX_RETRY_AFTER_SECONDS)
    except (TypeError, ValueError, OverflowError):
        return None


def _polite_sleep(delay: float, jitter_ratio: float = 0.35) -> None:
    if delay <= 0:
        return
    low = max(0.05, delay * (1 - jitter_ratio))
    high = max(low, delay * (1 + jitter_ratio))
    time.sleep(random.uniform(low, high))


def _sleep_before_retry(attempt: int, response: object | None = None, error: Exception | None = None) -> None:
    retry_after = _retry_after_seconds(response)
    if retry_after is None:
        retry_after = min(8.0, 0.7 * (2 ** (attempt - 1))) + random.uniform(0.1, 0.6)

    if response is not None:
        status = getattr(response, "status_code", "?")
        print(f"  [retry] HTTP {status}, retrying after {retry_after:.1f}s")
    elif error is not None:
        print(f"  [retry] {type(error).__name__}: {error}, retrying after {retry_after:.1f}s")

    time.sleep(retry_after)


def _request_with_retries(
    client: httpx.Client,
    url: str,
    max_attempts: int = MAX_FETCH_ATTEMPTS,
    headers: dict[str, str] | None = None,
):
    last_error: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            response = client.get(url, headers=headers) if headers else client.get(url)
        except Exception as exc:
            last_error = exc
            if attempt >= max_attempts:
                raise
            _sleep_before_retry(attempt, error=exc)
            continue

        status = getattr(response, "status_code", 0)
        if status in RETRIABLE_STATUS_CODES and attempt < max_attempts:
            _sleep_before_retry(attempt, response=response)
            continue
        return response

    if last_error:
        raise last_error
    raise RuntimeError(f"Request failed: {url}")


def _detect_challenge_signal(html_text: str, final_url: str) -> str | None:
    sample = (final_url + "\n" + html_text[:120_000]).lower()
    for needle, label in CHALLENGE_PAGE_SIGNALS:
        if needle in sample:
            return label
    return None


def _warn_if_challenge_page(html_text: str, final_url: str) -> None:
    signal = _detect_challenge_signal(html_text, final_url)
    if signal:
        print(
            f"  [WARN] The page appears to have returned an anti-scraping/verification page ({signal}): {final_url}\n"
            f"         The output may be empty or not body content; try providing login cookies, switching network/proxy, or using a browser-rendering solution."
        )


def fetch_page(
    client: httpx.Client,
    url: str,
    forced_encoding: str | None = None,
) -> tuple[str, str]:
    """
    Fetch page HTML content.

    Returns (html_text, final_url), where final_url accounts for the actual URL after redirects.
    """
    response = _request_with_retries(client, url)
    status = getattr(response, "status_code", 0)
    if status in SOFT_BLOCK_STATUS_CODES:
        print(f"  [WARN] Target returned HTTP {status}; cookies, a proxy, or browser rendering may be required: {url}")
    response.raise_for_status()

    # Get the final URL (after redirects).
    final_url = str(response.url)

    # Encoding detection
    if forced_encoding:
        html_text = response.content.decode(forced_encoding, errors="replace")
    else:
        declared = response.encoding
        encoding = detect_encoding(response.content, declared)
        html_text = response.content.decode(encoding, errors="replace")

    _warn_if_challenge_page(html_text, final_url)
    return html_text, final_url


def _extract_meta_refresh_url(html_text: str, base_url: str) -> str | None:
    soup = BeautifulSoup(html_text, "lxml")
    meta = soup.find("meta", attrs={"http-equiv": lambda value: str(value).lower() == "refresh"})
    if not meta or not isinstance(meta, Tag):
        return None

    content = str(meta.get("content", "")).strip()
    match = re.search(r"url\s*=\s*([^;]+)$", content, flags=re.IGNORECASE)
    if not match:
        return None

    return urljoin(base_url, match.group(1).strip().strip("\"'"))


# ==================== Content Extraction ====================

def extract_metadata(soup: BeautifulSoup, url: str) -> dict[str, str]:
    """
    Extract page metadata (title, description, keywords, etc.).
    """
    metadata: dict[str, str] = {"url": url}

    # Title: prefer og:title over the title tag.
    og_title = soup.find("meta", property="og:title")
    if og_title and isinstance(og_title, Tag) and og_title.get("content"):
        metadata["title"] = str(og_title["content"]).strip()
    elif soup.title and soup.title.string:
        metadata["title"] = soup.title.string.strip()
    else:
        metadata["title"] = urlparse(url).path.split("/")[-1] or "Untitled"

    # Description
    desc_tag = soup.find("meta", attrs={"name": "description"})
    if desc_tag and isinstance(desc_tag, Tag) and desc_tag.get("content"):
        metadata["description"] = str(desc_tag["content"]).strip()

    # Keywords
    keywords_tag = soup.find("meta", attrs={"name": "keywords"})
    if keywords_tag and isinstance(keywords_tag, Tag) and keywords_tag.get("content"):
        metadata["keywords"] = str(keywords_tag["content"]).strip()

    return metadata


def find_main_content(
    soup: BeautifulSoup,
    selector: str | None = None,
    exclude_selectors: list[str] | None = None,
) -> Tag | None:
    """
    Locate the page body content area.

    Strategy priority:
    1. User-specified CSS selector
    2. Common semantic tags: <main>, <article>, [role=main]
    3. Text-density-based heuristic detection of the largest content block
    """
    if exclude_selectors is None:
        exclude_selectors = DEFAULT_EXCLUDE_SELECTORS

    # First remove copies of excluded areas.
    work_soup = BeautifulSoup(str(soup), "lxml")
    for sel in exclude_selectors:
        for element in work_soup.select(sel):
            element.decompose()
    # Remove HTML comments.
    for comment in work_soup.find_all(string=lambda text: isinstance(text, Comment)):
        comment.extract()

    # Strategy 1: user-specified selector
    if selector:
        result = work_soup.select_one(selector)
        if result:
            return result

    # Strategy 2: semantic tags
    for semantic_selector in ["main", "article", '[role="main"]', "#content", ".content", ".main-content"]:
        result = work_soup.select_one(semantic_selector)
        if result and len(result.get_text(strip=True)) > 100:
            return result

    # Strategy 3: text-density heuristic detection.
    # Find the div/section block containing the most text.
    best_block = None
    best_text_length = 0

    for block in work_soup.find_all(["div", "section"]):
        text = block.get_text(strip=True)
        text_length = len(text)

        # Calculate text density: text length / number of child tags.
        child_tags = block.find_all(True)
        tag_count = max(len(child_tags), 1)
        density = text_length / tag_count

        if text_length > best_text_length and density > MIN_TEXT_DENSITY:
            best_text_length = text_length
            best_block = block

    return best_block


# ==================== HTML to Markdown Conversion ====================

def _class_tokens(tag: Tag) -> set[str]:
    classes = tag.get("class", [])
    if isinstance(classes, str):
        classes = classes.split()
    return {str(cls) for cls in classes}


def _is_hidden_element(tag: Tag) -> bool:
    """Skip inactive tabs/code samples and explicitly hidden page fragments."""
    classes = _class_tokens(tag)
    style = str(tag.get("style", "")).replace(" ", "").lower()
    return (
        tag.has_attr("hidden")
        or tag.get("aria-hidden") == "true"
        or "hidden" in classes
        or "headerlink" in classes
        or "example-header" in classes
        or "language-name" in classes
        or "sr-only" in classes
        or "visually-hidden" in classes
        or "display:none" in style
    )


def _is_sphinx_docutils_page(html_text: str) -> bool:
    sample = html_text[:80_000].lower()
    return (
        'name="generator" content="sphinx' in sample
        or "sphinx documentation" in sample
        or "docutils literal" in sample
    )


def _is_mkdocs_material_page(html_text: str) -> bool:
    sample = html_text[:120_000].lower()
    return (
        "material for mkdocs" in sample
        or "squidfunk.github.io" in sample
        or "md-content" in sample
        or "md-typeset" in sample
    )


def _is_mdn_page(html_text: str) -> bool:
    sample = html_text[:120_000].lower()
    return (
        "developer.mozilla.org" in sample
        or ("mdn" in sample and "layout__content" in sample)
    )


def _extract_balanced_json_after_marker(text: str, marker: str) -> str | None:
    start = text.find(marker)
    if start < 0:
        return None

    index = start + len(marker)
    while index < len(text) and text[index].isspace():
        index += 1

    if index >= len(text) or text[index] != "{":
        return None

    depth = 0
    in_string = False
    escaped = False
    quote = ""

    for pos in range(index, len(text)):
        char = text[pos]

        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                in_string = False
            continue

        if char in ("'", '"'):
            in_string = True
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[index:pos + 1]

    return None


def _extract_ssense_microsite_url(html_text: str, base_url: str) -> str | None:
    if "ssense.com" not in urlparse(base_url).netloc:
        return None

    state_text = _extract_balanced_json_after_marker(html_text, "window.INITIAL_STATE=")
    if state_text:
        try:
            state = json.loads(state_text)
            headers = (
                state.get("component", {})
                .get("props", {})
                .get("acf", {})
                .get("header", [])
            )
            if isinstance(headers, list):
                for item in headers:
                    if not isinstance(item, dict):
                        continue
                    microsite_url = str(item.get("url", "")).strip()
                    if (
                        item.get("acf_fc_layout") == "header_microsite"
                        and "microsite.ssense.com/_editorial/" in microsite_url
                    ):
                        return microsite_url
        except (TypeError, ValueError):
            pass

    match = re.search(r"https://microsite\.ssense\.com/_editorial/[-\w/]+", html_text)
    return match.group(0) if match else None


def _clean_inline_text(text: str) -> str:
    text = text.replace("\xa0", " ")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\s*\n\s*", " ", text)
    text = re.sub(r"\s+([,.;:!?%)\]])", r"\1", text)
    text = re.sub(r"([(\[])\s+", r"\1", text)
    return text.strip()


def _escape_markdown_link_text(text: str) -> str:
    return text.replace("[", "\\[").replace("]", "\\]")


def _inline_code(text: str) -> str:
    text = _clean_inline_text(text)
    if not text:
        return ""
    if "`" in text:
        return f"`` {text} ``"
    return f"`{text}`"


def _image_url_from_attr(value: object, base_url: str) -> str | None:
    if not value or not isinstance(value, str):
        return None
    candidate = value.strip()
    if not candidate:
        return None
    absolute_url = urljoin(base_url, candidate)
    if absolute_url.startswith("data:"):
        return None
    return absolute_url


def _best_image_src(img: Tag, base_url: str) -> str:
    for srcset_attr in ("srcset", "data-srcset"):
        srcset_val = img.get(srcset_attr, "")
        if srcset_val and isinstance(srcset_val, str) and srcset_val.strip():
            picked = _pick_best_srcset_url(srcset_val.strip(), base_url)
            if picked and not picked.startswith("data:"):
                return picked

    for src_attr in ("data-src", "data-original", "data-lazy-src", "data-croporisrc", "src"):
        picked = _image_url_from_attr(img.get(src_attr, ""), base_url)
        if picked:
            return picked

    return ""


def _render_inline(node: Tag | str | None, base_url: str = "") -> str:
    if node is None or isinstance(node, Comment):
        return ""

    if isinstance(node, str):
        return str(node)

    if not isinstance(node, Tag) or _is_hidden_element(node):
        return ""

    tag_name = node.name.lower()

    if tag_name == "br":
        return "\n"

    if tag_name == "code":
        return _inline_code(node.get_text())

    if tag_name in ("strong", "b"):
        text = _clean_inline_text("".join(_render_inline(child, base_url) for child in node.children))
        return f"**{text}**" if text else ""

    if tag_name in ("em", "i"):
        text = _clean_inline_text("".join(_render_inline(child, base_url) for child in node.children))
        return f"*{text}*" if text else ""

    if tag_name == "a":
        text = _clean_inline_text("".join(_render_inline(child, base_url) for child in node.children))
        href = str(node.get("href", "")).strip()
        if not text:
            return ""
        parent_name = node.parent.name.lower() if isinstance(node.parent, Tag) and node.parent.name else ""
        if href.startswith("#") and parent_name in ("h1", "h2", "h3", "h4", "h5", "h6", "dt"):
            return text
        if href and not href.startswith("javascript:"):
            return f"[{_escape_markdown_link_text(text)}]({href})"
        return text

    if tag_name == "img":
        src = _best_image_src(node, base_url)
        alt = str(node.get("alt", "")).strip()
        return f"![{alt}]({src})" if src else ""

    return "".join(_render_inline(child, base_url) for child in node.children)


def _render_block_inline(node: Tag, base_url: str = "") -> str:
    return _clean_inline_text(_render_inline(node, base_url))


def _detect_code_language(pre: Tag, code_tag: Tag | None) -> str:
    for node in (code_tag, pre):
        if not node:
            continue

        data_language = node.get("data-language")
        if data_language:
            return str(data_language).strip()

        for cls in _class_tokens(node):
            if cls.startswith("language-"):
                return cls[9:]
            if cls.startswith("lang-"):
                return cls[5:]
            if cls in ("js", "javascript", "mjs", "cjs"):
                return "js"
            if cls in ("ts", "typescript"):
                return "ts"
            if cls in ("py", "python"):
                return "python"
            if cls in ("html", "css", "json", "bash", "shell", "sh"):
                return "bash" if cls in ("shell", "sh") else cls

    return ""


def _remove_leading_line_number_block(text: str) -> str:
    """Remove copied line-number gutters that survived class-based cleanup."""
    lines = text.splitlines()
    expected = 1
    index = 0

    while index < len(lines) and lines[index].strip() == str(expected):
        expected += 1
        index += 1

    if index >= 3:
        return "\n".join(lines[index:])
    return text


def _extract_code_text(pre: Tag) -> tuple[str, str]:
    """
    Extract code from modern highlighted snippets.

    Many docs sites render line numbers as a nested floating <code> block inside
    the real <code data-language="..."> node. Using .find("code") recursively
    grabs the gutter first, so prefer the direct child and strip known gutters.
    """
    code_tag = pre.find("code", recursive=False) or pre.find("code")
    lang = _detect_code_language(pre, code_tag)

    root = copy(code_tag or pre)

    for node in root.find_all(class_=lambda value: value and "line-number" in str(value)):
        node.decompose()

    for nested_code in root.find_all("code"):
        classes = " ".join(_class_tokens(nested_code)).lower()
        style = str(nested_code.get("style", "")).replace(" ", "").lower()
        if "line-number" in classes or "float:left" in style:
            nested_code.decompose()

    text = root.get_text()
    text = text.replace("\xa0", " ")
    text = _remove_leading_line_number_block(text)
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    return text.strip("\n"), lang


def _markdown_has_broken_code_blocks(markdown: str) -> bool:
    code_blocks = re.findall(r"```[^\n]*\n(.*?)\n```", markdown, flags=re.DOTALL)
    for block in code_blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if len(lines) >= 3 and all(line == str(i + 1) for i, line in enumerate(lines[:10])):
            return True
    return False


def _should_fallback_from_trafilatura(html_text: str, markdown: str) -> bool:
    if _is_sphinx_docutils_page(html_text) or _is_mkdocs_material_page(html_text) or _is_mdn_page(html_text):
        return True

    html_has_code = "<pre" in html_text.lower() or "CodeSample" in html_text
    if not html_has_code:
        return False

    return "```" not in markdown or _markdown_has_broken_code_blocks(markdown)


def html_to_markdown(element: Tag, base_url: str = "") -> str:
    """
    Convert an HTML element to Markdown format.

    Implemented manually instead of relying on third-party libraries such as
    html2text, so the output format can be controlled precisely with zero
    additional dependencies.
    """
    lines: list[str] = []
    _process_element(element, lines, depth=0, base_url=base_url)

    # Merge consecutive blank lines (keep at most one blank line).
    result_lines: list[str] = []
    prev_empty = False
    for line in lines:
        is_empty = line.strip() == ""
        if is_empty:
            if not prev_empty:
                result_lines.append("")
            prev_empty = True
        else:
            result_lines.append(line)
            prev_empty = False

    return "\n".join(result_lines).strip()


def _process_element(element: Tag | None, lines: list[str], depth: int, base_url: str = "") -> None:
    """Recursively process an HTML element and convert it to Markdown lines."""
    if element is None:
        return

    for child in element.children:
        if isinstance(child, Comment):
            continue

        # Text node
        if isinstance(child, str):
            text = child.strip()
            if text:
                # Do not wrap automatically; let later processing merge it.
                if lines and lines[-1] and not lines[-1].endswith("\n"):
                    lines[-1] += " " + text
                else:
                    lines.append(text)
            continue

        if not isinstance(child, Tag):
            continue

        if _is_hidden_element(child):
            continue

        tag_name = child.name.lower()

        # Headings h1-h6
        if tag_name in ("h1", "h2", "h3", "h4", "h5", "h6"):
            level = int(tag_name[1])
            text = _render_block_inline(child, base_url)
            if text:
                lines.append("")
                lines.append(f"{'#' * level} {text}")
                lines.append("")

        # Paragraphs
        elif tag_name == "p":
            text = _render_block_inline(child, base_url)
            if text:
                lines.append("")
                lines.append(text)
                lines.append("")

        # Code blocks
        elif tag_name == "pre":
            code_text, lang = _extract_code_text(child)

            lines.append("")
            lines.append(f"```{lang}")
            lines.append(code_text.rstrip())
            lines.append("```")
            lines.append("")

        # Inline code
        elif tag_name == "code":
            # Skip if the parent element is pre (already handled in pre).
            if child.parent and child.parent.name == "pre":
                continue
            text = child.get_text()
            if text:
                inline = _inline_code(text)
                if lines and lines[-1]:
                    lines[-1] += " " + inline
                else:
                    lines.append(inline)

        # Unordered lists
        elif tag_name == "ul":
            _process_list(child, lines, depth, ordered=False, base_url=base_url)

        # Ordered lists
        elif tag_name == "ol":
            _process_list(child, lines, depth, ordered=True, base_url=base_url)

        # Definition lists (commonly used for MDN parameters/return values)
        elif tag_name == "dl":
            _process_definition_list(child, lines, depth, base_url=base_url)

        # Links
        elif tag_name == "a":
            href = child.get("href", "")
            text = _render_block_inline(child, base_url)
            if text and href:
                link_md = f"[{text}]({href})"
                if lines and lines[-1]:
                    lines[-1] += " " + link_md
                else:
                    lines.append(link_md)
            elif text:
                if lines and lines[-1]:
                    lines[-1] += " " + text
                else:
                    lines.append(text)

        # Images
        elif tag_name == "img":
            src = _best_image_src(child, base_url)
            alt = child.get("alt", "")
            if src:
                lines.append(f"![{alt}]({src})")

        # Bold
        elif tag_name in ("strong", "b"):
            text = _render_block_inline(child, base_url)
            if text:
                bold = f"**{text}**"
                if lines and lines[-1]:
                    lines[-1] += " " + bold
                else:
                    lines.append(bold)

        # Italic
        elif tag_name in ("em", "i"):
            text = _render_block_inline(child, base_url)
            if text:
                italic = f"*{text}*"
                if lines and lines[-1]:
                    lines[-1] += " " + italic
                else:
                    lines.append(italic)

        # Tables
        elif tag_name == "table":
            _process_table(child, lines, base_url)

        # Horizontal rule
        elif tag_name == "hr":
            lines.append("")
            lines.append("---")
            lines.append("")

        # Blockquotes
        elif tag_name == "blockquote":
            text = _render_block_inline(child, base_url)
            if text:
                lines.append("")
                for bq_line in text.split("\n"):
                    lines.append(f"> {bq_line.strip()}")
                lines.append("")

        # Other block-level elements: process recursively.
        elif tag_name in (
            "div", "section", "article", "main", "span", "dd", "dt",
            "figure", "figcaption", "astro-island",
        ):
            _process_element(child, lines, depth, base_url)

        # Line break
        elif tag_name == "br":
            lines.append("")


def _render_list_item_text(li: Tag, base_url: str = "") -> str:
    item_root = copy(li)
    for nested in item_root.find_all(["ul", "ol"]):
        nested.decompose()

    parts: list[str] = []
    for child in item_root.children:
        if isinstance(child, Comment):
            continue
        if isinstance(child, Tag) and child.name and child.name.lower() == "p":
            rendered = _render_block_inline(child, base_url)
        else:
            rendered = _render_inline(child, base_url)
        if rendered:
            parts.append(rendered)

    return _clean_inline_text(" ".join(parts))


def _process_list(list_tag: Tag, lines: list[str], depth: int, ordered: bool, base_url: str = "") -> None:
    if depth == 0 and (not lines or lines[-1].strip()):
        lines.append("")

    for idx, li in enumerate(list_tag.find_all("li", recursive=False), 1):
        text = _render_list_item_text(li, base_url)
        indent = "  " * depth
        prefix = f"{idx}." if ordered else "-"
        if text:
            lines.append(f"{indent}{prefix} {text}")
        else:
            lines.append(f"{indent}{prefix}")

        for nested in li.find_all(["ul", "ol"], recursive=False):
            _process_list(nested, lines, depth + 1, ordered=nested.name.lower() == "ol", base_url=base_url)

    if depth == 0 and lines and lines[-1].strip():
        lines.append("")


def _definition_list_item_text(dd: Tag, base_url: str = "") -> str:
    item_root = copy(dd)
    for nested in item_root.find_all(["dl", "ul", "ol"]):
        nested.decompose()
    return _render_block_inline(item_root, base_url)


def _process_definition_list(dl_tag: Tag, lines: list[str], depth: int, base_url: str = "") -> None:
    if depth == 0 and (not lines or lines[-1].strip()):
        lines.append("")

    current_term = ""
    indent = "  " * depth
    child_indent = "  " * (depth + 1)

    for child in dl_tag.find_all(["dt", "dd"], recursive=False):
        tag_name = child.name.lower()

        if tag_name == "dt":
            current_term = _render_block_inline(child, base_url)
            if current_term:
                lines.append(f"{indent}- {current_term}")
            continue

        if tag_name != "dd":
            continue

        description = _definition_list_item_text(child, base_url)
        if description:
            if current_term:
                lines.append(f"{child_indent}- {description}")
            else:
                lines.append(f"{indent}- {description}")

        for nested in child.find_all(["dl", "ul", "ol"], recursive=False):
            if nested.name.lower() == "dl":
                _process_definition_list(nested, lines, depth + 1, base_url=base_url)
            else:
                _process_list(nested, lines, depth + 1, ordered=nested.name.lower() == "ol", base_url=base_url)

    if depth == 0 and lines and lines[-1].strip():
        lines.append("")


def _process_table(table: Tag, lines: list[str], base_url: str = "") -> None:
    """Convert an HTML table to a Markdown table."""
    rows: list[list[str]] = []
    header_row_count = 0

    for tr in table.find_all("tr"):
        cells: list[str] = []
        is_header = False
        for cell in tr.find_all(["th", "td"]):
            cells.append(_render_block_inline(cell, base_url))
            if cell.name == "th":
                is_header = True
        if cells:
            rows.append(cells)
            if is_header:
                header_row_count += 1

    if not rows:
        return

    # Ensure all rows have the same number of columns.
    max_cols = max(len(row) for row in rows)
    for row in rows:
        while len(row) < max_cols:
            row.append("")

    lines.append("")

    # Output the header row.
    lines.append("| " + " | ".join(rows[0]) + " |")
    lines.append("| " + " | ".join(["---"] * max_cols) + " |")

    # Output data rows.
    for row in rows[1:]:
        lines.append("| " + " | ".join(row) + " |")

        lines.append("")


def _extract_body_with_beautifulsoup(
    soup: BeautifulSoup,
    base_url: str,
    selector: str | None = None,
    exclude_selectors: list[str] | None = None,
) -> str:
    main_content = find_main_content(soup, selector, exclude_selectors)
    if main_content:
        return html_to_markdown(main_content, base_url)

    body = soup.find("body")
    if body and isinstance(body, Tag):
        return html_to_markdown(body, base_url)

    return soup.get_text(strip=True)


# ==================== trafilatura Body Extraction (Optional Enhancement) ====================

def is_trafilatura_available() -> bool:
    try:
        return importlib.util.find_spec("trafilatura") is not None
    except Exception:
        return False


def _try_trafilatura(html_text: str, url: str) -> str | None:
    """
    Try to extract body content with trafilatura when it is available.

    trafilatura is designed specifically for web page body extraction, and its
    ability to handle complex page structures is significantly better than the
    manual heuristic (BeautifulSoup + text density detection).

    If it is not importable in the current Python environment, returns None and
    lets the caller fall back to BeautifulSoup extraction.
    """
    try:
        import trafilatura  # type: ignore

        result = trafilatura.extract(
            html_text,
            url=url,
            include_images=True,
            include_links=True,
            output_format="markdown",
            favor_recall=True,
        )
        return result or None
    except ImportError:
        return None
    except Exception:
        return None


# ==================== Markdown Post-processing ====================

def _is_markdown_structural_block(block: str) -> bool:
    first_line = next((line.strip() for line in block.splitlines() if line.strip()), "")
    if not first_line:
        return True

    return bool(
        re.match(r"^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?|\|)", first_line)
        or re.match(r"^(```|~~~)", first_line)
        or re.match(r"^(---|\*\*\*|___)$", first_line)
        or re.match(r"^(\[[^\]]+\]:\s+|!\[[^\]]*\]\()", first_line)
        or re.match(r"^(!!!|\?\?\?|:::)\s+", first_line)
    )


def _squash_markdown_paragraph(block: str) -> str:
    text = block.replace("\r\n", "\n").replace("\r", "\n").strip()
    text = re.sub(r"[ \t]*\n[ \t]*", " ", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\s+([,.;:!?%)\]])", r"\1", text)
    text = re.sub(r"([(\[])\s+", r"\1", text)
    return text.strip()


def _is_fragment_continuation(previous: str, current: str) -> bool:
    if _is_markdown_structural_block(previous) or _is_markdown_structural_block(current):
        return False

    current = current.lstrip()
    previous = previous.rstrip()
    if not current or not previous:
        return False

    if re.match(r"^[,.;:!?%)\]]", current):
        return True

    if previous.endswith(("`", ",", ";", "(", "[", "/")):
        return bool(re.match(r"^[a-z0-9]", current))

    return False


def _join_markdown_fragments(previous: str, current: str) -> str:
    current = current.lstrip()
    if re.match(r"^[,.;:!?%)\]]", current):
        joined = previous.rstrip() + current
    else:
        joined = previous.rstrip() + " " + current

    joined = re.sub(r"\s+([,.;:!?%)\]])", r"\1", joined)
    joined = re.sub(r"([(\[])\s+", r"\1", joined)
    return joined


def _tidy_markdown_prose(markdown: str) -> str:
    """
    Merge prose fragments produced by extractors around inline code.

    Some docs pages split inline-code-adjacent punctuation into separate
    paragraphs. Keep fenced code blocks and structural Markdown untouched.
    """
    if not markdown.strip():
        return markdown

    fence_pattern = re.compile(
        r"(^[ \t]*(?:```|~~~)[^\n]*\n.*?^[ \t]*(?:```|~~~)[ \t]*$)",
        flags=re.DOTALL | re.MULTILINE,
    )
    pieces = fence_pattern.split(markdown)
    output: list[str] = []

    for piece in pieces:
        if not piece:
            continue
        if fence_pattern.match(piece):
            output.append(piece.strip("\n"))
            continue

        blocks = [
            block.strip()
            for block in re.split(r"\n[ \t]*\n+", piece)
            if block.strip()
        ]
        normalized: list[str] = []

        for block in blocks:
            if _is_markdown_structural_block(block):
                tidy_block = block.strip()
            else:
                tidy_block = _squash_markdown_paragraph(block)

            if normalized and _is_fragment_continuation(normalized[-1], tidy_block):
                normalized[-1] = _join_markdown_fragments(normalized[-1], tidy_block)
            else:
                normalized.append(tidy_block)

        if normalized:
            output.append("\n\n".join(normalized))

    return "\n\n".join(output).strip()


def _drop_duplicate_leading_title(markdown: str, title: str) -> str:
    title = _clean_inline_text(title)
    if not title:
        return markdown

    lines = markdown.splitlines()
    while lines and not lines[0].strip():
        lines.pop(0)

    if not lines:
        return markdown

    first_line = lines[0].strip()
    first_text = re.sub(r"^#{1,6}\s+", "", first_line).strip()
    if _clean_inline_text(first_text) == title:
        return "\n".join(lines[1:]).lstrip()

    return markdown


def _is_wechat_article_url(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.netloc.lower() == "mp.weixin.qq.com" and parsed.path.startswith("/s/")


def _strip_markdown_emphasis_for_heading(line: str) -> str:
    text = line.replace("\xa0", " ")
    text = re.sub(r"^#{1,6}\s*", "", text).strip()
    text = re.sub(r"\*+", "", text)
    text = _clean_inline_text(text)
    text = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", text)
    return text.strip(" -—–")


def _wechat_visual_heading_text(line: str) -> str:
    stripped = line.strip()
    if stripped.startswith("#") or "http://" in stripped or "https://" in stripped:
        return ""
    if "****" not in stripped:
        return ""

    text = _strip_markdown_emphasis_for_heading(stripped)
    if not text or len(text) > 36:
        return ""
    if text in {"新智元报道"} or text.startswith("【"):
        return ""
    return text


def _wechat_subheading_text(line: str) -> str:
    stripped = line.strip()
    if stripped.startswith("#"):
        return ""

    text = _strip_markdown_emphasis_for_heading(stripped)
    if len(text) > 45:
        return ""
    if re.match(r"^第[一二三四五六七八九十]+是.+[。)]$", text):
        return text.rstrip("。")
    return ""


_MARKDOWN_IMAGE_PATTERN = re.compile(r"!\[[^\]]*\]\([^)]+\)")


def _markdown_images_in_line(line: str) -> list[str]:
    return _MARKDOWN_IMAGE_PATTERN.findall(line)


def _line_without_markdown_images(line: str) -> str:
    return _clean_inline_text(_MARKDOWN_IMAGE_PATTERN.sub("", line))


def _unwrap_bold_image_only_line(line: str) -> str:
    stripped = line.strip()
    match = re.fullmatch(r"\*\*\s*(!\[[^\]]*\]\([^)]+\))\s*\*\*", stripped)
    return match.group(1) if match else line


def _polish_wechat_markdown(markdown: str) -> str:
    """
    Restore Markdown structure for WeChat public-account articles.

    WeChat editors often build visual section titles with styled
    section/span/strong blocks instead of semantic h2/h3 elements. The generic
    converter preserves the text but emits it as plain bold prose; this pass
    promotes those WeChat-only visual blocks back into Markdown headings.
    """
    output: list[str] = []
    lines = markdown.splitlines()

    for raw_line in lines:
        line = raw_line.rstrip()
        stripped = line.strip()
        if not stripped:
            output.append("")
            continue

        images_in_line = _markdown_images_in_line(stripped)
        text_without_images = _line_without_markdown_images(stripped)

        heading_image_match = re.match(r"^#{1,6}\s+(.+)$", stripped)
        if heading_image_match and images_in_line and not _line_without_markdown_images(heading_image_match.group(1)):
            output.extend(["", *images_in_line, ""])
            continue

        unwrapped_image = _unwrap_bold_image_only_line(stripped)
        if unwrapped_image != stripped:
            output.extend(["", unwrapped_image, ""])
            continue

        if stripped.startswith("#") and _strip_markdown_emphasis_for_heading(stripped) == "新智元报道":
            output.extend(["", "**新智元报道**", ""])
            continue

        lead_match = re.match(r"^#{3,6}\s+\*\*(【[^】]{1,20}导读】.+?)\*\*$", stripped)
        if lead_match:
            output.extend(["", f"> {lead_match.group(1)}", ""])
            continue

        visual_heading = _wechat_visual_heading_text(text_without_images or stripped)
        if visual_heading:
            if images_in_line:
                output.extend(["", *images_in_line])
            output.extend(["", f"## {visual_heading}", ""])
            continue

        subheading = _wechat_subheading_text(text_without_images or stripped)
        if subheading:
            if images_in_line:
                output.extend(["", *images_in_line])
            output.extend(["", f"### {subheading}", ""])
            continue

        link_match = re.match(r"^(代码|模型|数据集|技术报告)[:：]\s*(https?://\S+)$", stripped)
        if link_match:
            output.append(f"- **{link_match.group(1)}**: {link_match.group(2)}")
            continue

        output.append(line)

    return _tidy_markdown_prose("\n".join(output))


# ==================== Content Quality Self-check ====================

# If any of the following phrases appear, the scraper may have captured a sidebar/related recommendations instead of body content.
_MISEXTRACTED_SIGNALS = [
    "related stories", "next story", "you may also like",
    "more from", "see also", "read more", "recommended",
]


def _quality_suggestions(use_trafilatura: bool) -> list[str]:
    trafilatura_available = is_trafilatura_available()
    if use_trafilatura and trafilatura_available:
        return [
            "trafilatura is available in this Python environment; this warning is about possible page structure noise, not a missing dependency",
            "Use --selector to manually specify the main body CSS selector",
            "Use --exclude-selector to remove sidebar, recommendation, or navigation areas",
        ]
    if use_trafilatura:
        return [
            "trafilatura is not importable by the Python executable running this script; confirm the command is using the AgentVis runtime Python",
            "Use --selector to manually specify the main body CSS selector",
            "Use browser DevTools to inspect the class/id of the body container on this page",
        ]
    if trafilatura_available:
        return [
            "trafilatura is available; rerun without --no-trafilatura unless BeautifulSoup-only extraction is intentional",
            "Use --selector to manually specify the main body CSS selector",
            "Use --exclude-selector to remove sidebar, recommendation, or navigation areas",
        ]
    return [
        "Use --selector to manually specify the main body CSS selector",
        "Use --exclude-selector to remove sidebar, recommendation, or navigation areas",
        "Use browser DevTools to inspect the class/id of the body container on this page",
    ]


def _format_suggestions(suggestions: list[str]) -> str:
    return "\n".join(f"  {index}. {suggestion}" for index, suggestion in enumerate(suggestions, 1))


def _check_content_quality(content_md: str, url: str, use_trafilatura: bool = True) -> None:
    """
    Self-check body content quality and print a [WARN] hint when a likely misclassification appears.

    Mainly helps the Agent notice content extraction failures and avoid silently
    returning incorrect results.
    """
    text_len = len(content_md.strip())

    if text_len < 200:
        print(
            f"[WARN] Body content is too short ({text_len} characters); content may not have been extracted correctly.\n"
            f"  Suggestions:\n"
            f"{_format_suggestions(_quality_suggestions(use_trafilatura))}"
        )
        return

    lower_content = content_md[:500].lower()
    hit = next((sig for sig in _MISEXTRACTED_SIGNALS if sig in lower_content), None)
    if hit:
        print(
            f"[WARN] The beginning of the body content appears to contain sidebar/recommendation content (matched keyword: '{hit}'), "
            f"so the wrong area may have been extracted.\n"
            f"  Suggestions:\n"
            f"{_format_suggestions(_quality_suggestions(use_trafilatura))}"
        )


# ==================== Link Discovery ====================


def _canonical_netloc(parsed_url) -> str:
    hostname = (parsed_url.hostname or "").lower()
    if not hostname:
        return parsed_url.netloc.lower()

    try:
        port = parsed_url.port
    except ValueError:
        port = None

    scheme = parsed_url.scheme.lower()
    if port and not ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
        return f"{hostname}:{port}"
    return hostname


def _is_tracking_query_param(name: str) -> bool:
    lower_name = name.lower()
    return lower_name in TRACKING_QUERY_PARAMS or any(
        lower_name.startswith(prefix) for prefix in TRACKING_QUERY_PREFIXES
    )


def normalize_crawl_url(url: str) -> str:
    """
    Normalize URLs for crawl de-duplication only.

    This intentionally keeps non-tracking query parameters because many docs and
    app pages use them as real state, while dropping ordinary anchor fragments
    and common analytics parameters that produce duplicate pages. Hash-router
    fragments are kept because #/docs/a and #/docs/b are different SPA routes.
    """
    parsed = urlparse(url)
    scheme = parsed.scheme.lower()
    netloc = _canonical_netloc(parsed)

    path = parsed.path or "/"
    path = re.sub(r"/{2,}", "/", path)
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")

    query_pairs = [
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if not _is_tracking_query_param(key)
    ]
    query = urlencode(sorted(query_pairs, key=lambda item: (item[0].lower(), item[1])))

    fragment = parsed.fragment if _is_hash_router_fragment(parsed.fragment) else ""

    return urlunparse((scheme, netloc, path, parsed.params, query, fragment))


def _unique_normalized_crawl_urls(urls: list[str]) -> list[str]:
    normalized_urls: list[str] = []
    seen_urls: set[str] = set()
    for url in urls:
        normalized_url = normalize_crawl_url(url)
        if not normalized_url or normalized_url in seen_urls:
            continue
        seen_urls.add(normalized_url)
        normalized_urls.append(normalized_url)
    return normalized_urls


def discover_links(
    soup: BeautifulSoup,
    base_url: str,
    same_domain_only: bool = True,
) -> list[str]:
    """
    Discover all scrapeable links from the page.

    Keep only same-domain HTML page links, excluding anchor links, static
    resources, etc.
    """
    parsed_base = urlparse(base_url)
    base_domain = _canonical_netloc(parsed_base)
    discovered: list[str] = []
    seen_urls: set[str] = set()

    for a_tag in soup.find_all("a", href=True):
        href = str(a_tag["href"]).strip()

        # Skip empty links, ordinary anchor links, and JavaScript links.
        if not href or _is_local_anchor_href(href) or href.startswith("javascript:"):
            continue

        # Convert to an absolute URL.
        absolute_url = urljoin(base_url, href)
        parsed = urlparse(absolute_url)

        # Same-domain check
        if same_domain_only and _canonical_netloc(parsed) != base_domain:
            continue

        # Exclude static resource files.
        path_lower = parsed.path.lower()
        skip_extensions = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".css", ".js",
                          ".pdf", ".zip", ".tar", ".gz", ".mp4", ".mp3", ".woff", ".woff2")
        if any(path_lower.endswith(ext) for ext in skip_extensions):
            continue

        # Normalize crawl URLs to avoid duplicate fetches.
        clean_url = normalize_crawl_url(absolute_url)
        if clean_url in seen_urls:
            continue
        seen_urls.add(clean_url)
        discovered.append(clean_url)

    scope_prefix = _crawl_scope_prefix(base_url)
    if not scope_prefix:
        return discovered

    def priority(index_and_url: tuple[int, str]) -> tuple[int, int]:
        index, link_url = index_and_url
        path = urlparse(link_url).path.rstrip("/") or "/"
        in_scope = path == scope_prefix or path.startswith(scope_prefix + "/")
        return (0 if in_scope else 1, index)

    return [link for _index, link in sorted(enumerate(discovered), key=priority)]


def _crawl_scope_prefix(base_url: str) -> str:
    path = urlparse(base_url).path.rstrip("/")
    if not path or path == "/":
        return ""
    segments = [segment for segment in path.split("/") if segment]
    if not segments:
        return ""
    return "/" + segments[0]


def extract_page_links(soup: BeautifulSoup, base_url: str) -> list[dict[str, str]]:
    """
    Extract all links and their text from the page (for --include-links output).
    """
    links: list[dict[str, str]] = []
    seen_urls: set[str] = set()

    for a_tag in soup.find_all("a", href=True):
        href = str(a_tag["href"]).strip()
        if not href or _is_local_anchor_href(href) or href.startswith("javascript:"):
            continue

        absolute_url = urljoin(base_url, href)
        if absolute_url in seen_urls:
            continue
        seen_urls.add(absolute_url)

        text = a_tag.get_text(strip=True)
        if text:
            links.append({"text": text, "url": absolute_url})

    return links




def _pick_best_srcset_url(srcset_value: str, base_url: str) -> str | None:
    """
    Pick the highest-resolution image URL from a srcset attribute value.

    srcset format: "url1 480w, url2 768w, url3 1280w"
    Each entry is separated by "comma + optional whitespace + URL starting character".

    Key detail: URLs from CDNs such as Cloudinary may contain commas internally,
    such as w_480,q_90,f_auto,dpr_auto. Do not simply split(',') or those
    internal commas will also be treated as separators, producing incomplete URLs.

    Correct strategy: split with the regex "comma + optional whitespace + URL
    starting character", so only commas between srcset entries are recognized as
    separators.
    """
    # Split by "comma + optional whitespace + URL starting character (http/https://, //, /, or ./)".
    entry_split_pattern = re.compile(r',\s*(?=https?://|//|/|\./)') 
    entries = entry_split_pattern.split(srcset_value)

    best_url: str | None = None
    best_width = -1

    for entry in entries:
        entry = entry.strip()
        if not entry:
            continue
        # Entry format: "URL [descriptor]"; split at the last space.
        last_space = entry.rfind(" ")
        if last_space > 0:
            candidate_url = entry[:last_space].strip()
            descriptor = entry[last_space + 1:].strip().lower()
        else:
            candidate_url = entry
            descriptor = ""

        # Parse the width descriptor (for example "768w").
        width = 0
        if descriptor.endswith("w"):
            try:
                width = int(descriptor[:-1])
            except ValueError:
                width = 0

        if width > best_width:
            best_width = width
            best_url = candidate_url

    if best_url:
        from urllib.parse import urljoin
        return urljoin(base_url, best_url)
    return None

def extract_image_urls(soup: BeautifulSoup, base_url: str) -> list[dict[str, str]]:
    """
    Extract all image URLs from the page (for --include-images output).

    Parses both src and srcset attributes, preferring the highest-resolution
    srcset version:
    - srcset/data-srcset: pick the URL with the largest width descriptor
    - src/data-src:       fallback source (usually a low-resolution placeholder)
    Also filters data: URIs (SVG placeholders, base64 images, etc.).
    """
    images: list[dict[str, str]] = []
    seen_srcs: set[str] = set()

    for img in soup.find_all("img"):
        alt = str(img.get("alt", "")).strip()
        candidate_url = _best_image_src(img, base_url)
        if not candidate_url:
            continue

        if candidate_url in seen_srcs:
            continue
        seen_srcs.add(candidate_url)

        images.append({"alt": alt, "src": candidate_url})

    return images

def extract_image_urls_from_markdown(md_text: str, base_url: str) -> list[str]:
    """
    Extract all image URLs from Markdown text (including srcset format generated by trafilatura).

    trafilatura sometimes writes the full HTML img srcset into Markdown, for example:
      ![alt]( https://cdn.example.com/img.jpg 480w,
              https://cdn.example.com/img@2x.jpg 1024w )

    Key detail: Cloudinary URLs can also contain comma parameters internally
    (w_480,q_90,...), so srcset detection must look for the width descriptor
    pattern "space + integer + w", rather than simply checking for "contains a
    comma and digit w"; otherwise single URLs with comma parameters can be
    misclassified.
    """
    # Match the full content inside Markdown image syntax ![](...).
    img_content_pattern = re.compile(r'!\[[^\]]*\]\(([^)]+)\)')
    # Width descriptor pattern: space + integer + w, followed by a comma or end of line.
    srcset_descriptor_pattern = re.compile(r'\s\d+w(?:\s*,|\s*$)')

    extracted: list[str] = []
    seen: set[str] = set()

    for match in img_content_pattern.finditer(md_text):
        content = match.group(1).strip()
        if not content:
            continue

        # Detect the "space + integer + w" width descriptor to identify srcset format.
        is_srcset_format = bool(srcset_descriptor_pattern.search(content))

        if is_srcset_format:
            picked = _pick_best_srcset_url(content, base_url)
            if picked and picked not in seen:
                seen.add(picked)
                extracted.append(picked)
        else:
            # Regular single URL: take the parenthesized content directly (preserve comma parameters inside Cloudinary URLs).
            stripped = content.strip()
            if stripped.startswith("http://") or stripped.startswith("https://"):
                abs_url = urljoin(base_url, stripped)
                if abs_url not in seen:
                    seen.add(abs_url)
                    extracted.append(abs_url)

    return extracted




# ==================== Image Download ====================

def download_images(
    client: httpx.Client,
    image_urls: list[str],
    images_dir: str,
    base_url: str,
    delay: float = 0.1,
) -> dict[str, str]:
    """
    Batch download images to the local images/ subdirectory.

    @param image_urls: List of absolute image URLs to download.
    @param images_dir: Local save directory (for example output/images).
    @param base_url: Source page URL (used to convert relative paths to absolute paths).
    @param delay: Interval between downloads (seconds) to avoid rate limiting.
    @returns: Mapping table {original URL -> local relative path(images/xxx.ext)}.
    """
    import mimetypes

    os.makedirs(images_dir, exist_ok=True)
    url_to_local: dict[str, str] = {}
    seen_names: dict[str, int] = {}

    for img_url in image_urls:
        # Convert to an absolute path.
        abs_url = urljoin(base_url, img_url)
        if abs_url in url_to_local:
            continue

        try:
            resp = _request_with_retries(client, abs_url)
            if hasattr(resp, 'status_code') and resp.status_code >= 400:
                print(f"  [!] Image download failed {resp.status_code}: {abs_url}")
                continue

            content = resp.content

            # Infer the file extension: prefer the URL path, then Content-Type.
            parsed_path = urlparse(abs_url).path
            ext = os.path.splitext(parsed_path)[-1].lower()
            if ext not in (".png", ".jpg", ".jpeg", ".gif", ".svg",
                           ".webp", ".ico", ".bmp", ".avif"):
                # Try to infer from the response header Content-Type.
                ct = ""
                if hasattr(resp, 'headers') and resp.headers:
                    ct = resp.headers.get("content-type", "").split(";")[0].strip()
                elif hasattr(resp, '_resp') and hasattr(resp._resp, 'headers'):
                    ct = resp._resp.headers.get("content-type", "").split(";")[0].strip()
                guessed = mimetypes.guess_extension(ct) if ct else ""
                ext = guessed or ".bin"

            # Generate a non-conflicting local filename.
            base_name = sanitize_filename(
                os.path.splitext(os.path.basename(parsed_path))[0] or "image",
                max_length=50,
            )
            candidate = base_name + ext
            if candidate in seen_names:
                seen_names[candidate] += 1
                candidate = f"{base_name}_{seen_names[candidate]}{ext}"
            else:
                seen_names[candidate] = 0

            local_path = os.path.join(images_dir, candidate)
            with open(local_path, "wb") as f:
                f.write(content)

            # Record the mapping (relative path, used when writing MD).
            relative = os.path.join("images", candidate).replace("\\", "/")
            url_to_local[abs_url] = relative
            url_to_local[img_url] = relative  # Also record the original path (possibly relative).

            print(f"  [IMG] {candidate}  <- {abs_url}")

        except Exception as e:
            print(f"  [!] Image download exception: {e} ({abs_url})")

        if delay > 0:
            _polite_sleep(delay)

    return url_to_local


def rewrite_image_srcs_in_markdown(md_text: str, url_map: dict[str, str]) -> str:
    """
    Replace remote URLs in all Markdown image references with local relative paths.

    Handles two formats:
    - Regular format: ![alt](url)
    - srcset format: ![alt]( url1 480w, url2 768w, url3 1280w )
      -> Find the local path corresponding to any URL in url_map and replace the whole block with ![alt](local_path)
    """
    if not url_map:
        return md_text

    # 1. Handle regular URL format (exact match, descending by length to avoid false prefix matches).
    for remote_url, local_path in sorted(url_map.items(), key=lambda x: -len(x[0])):
        escaped = re.escape(remote_url)
        md_text = re.sub(
            r'(!\[[^\]]*\])\(' + escaped + r'\)',
            lambda m, lp=local_path: f"{m.group(1)}({lp})",
            md_text,
        )

    # 2. Handle srcset format: ![alt]( ...multiple URLs and width descriptors... )
    # trafilatura sometimes writes the entire srcset into md, with multiple URLs + width descriptors in parentheses.
    # Find the first URL in the parenthesized content that matches url_map and replace the whole block with the local path.
    url_pattern_in_content = re.compile(r'https?://\S+')

    def _replace_srcset_block(match: re.Match) -> str:
        alt_part = match.group(1)
        content = match.group(2)
        for found_url in url_pattern_in_content.findall(content):
            # Remove the descriptor suffix (for example "1280w,") and extract the pure URL.
            clean_url = re.sub(r'\s+\d+[wx]\s*,?\s*$', '', found_url).rstrip(',')
            if clean_url in url_map:
                return f"{alt_part}({url_map[clean_url]})"
        return match.group(0)

    # Match srcset-format image blocks containing width descriptors.
    srcset_img_pattern = re.compile(r'(!\[[^\]]*\])\(([^)]*\s\d+w[^)]*)\)')
    md_text = srcset_img_pattern.sub(_replace_srcset_block, md_text)

    return md_text


# ==================== Markdown Output ====================

def sanitize_filename(name: str, max_length: int = 80) -> str:
    """
    Convert a string to a safe filename.

    Remove unsafe characters, truncate length, and strip leading/trailing spaces and dots.
    """
    safe = FILENAME_UNSAFE_CHARS.sub("_", name)
    safe = re.sub(r"_+", "_", safe).strip("_. ")
    if len(safe) > max_length:
        safe = safe[:max_length].rstrip("_. ")
    return safe or "untitled"


def _markdown_image_sources(md_text: str, base_url: str = "") -> set[str]:
    sources: set[str] = set()
    for match in re.finditer(r'!\[[^\]]*\]\(([^)]+)\)', md_text):
        source = match.group(1).strip()
        if not source:
            continue
        sources.add(source)
        if base_url:
            sources.add(urljoin(base_url, source))
    return sources


def _markdown_image_count(md_text: str) -> int:
    return len(_MARKDOWN_IMAGE_PATTERN.findall(md_text))


def _markdown_text_length(md_text: str) -> int:
    without_images = _MARKDOWN_IMAGE_PATTERN.sub("", md_text)
    without_links = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", without_images)
    plain_text = re.sub(r"[#*_`>\-\[\]()|:]+", " ", without_links)
    return len(re.sub(r"\s+", "", plain_text))


def _should_prefer_inline_image_markdown(reference_md: str, candidate_md: str) -> bool:
    if _markdown_image_count(reference_md) > 0 or _markdown_image_count(candidate_md) == 0:
        return False

    reference_len = _markdown_text_length(reference_md)
    candidate_len = _markdown_text_length(candidate_md)
    if reference_len == 0:
        return candidate_len > 0

    return candidate_len >= max(80, int(reference_len * 0.55))


def _images_not_already_in_content(
    images: list[dict[str, str]],
    content_md: str,
    base_url: str,
) -> list[dict[str, str]]:
    inline_sources = _markdown_image_sources(content_md, base_url)
    remaining: list[dict[str, str]] = []
    for image in images:
        src = str(image.get("src", "")).strip()
        if not src:
            continue
        candidates = {src}
        if base_url:
            candidates.add(urljoin(base_url, src))
        if candidates & inline_sources:
            continue
        remaining.append(image)
    return remaining


_HOTLINK_PROTECTED_IMAGE_HOSTS = (
    "mmbiz.qpic.cn",
    "mmbiz.qlogo.cn",
    "wx.qlogo.cn",
)


def _is_remote_image_source(src: str) -> bool:
    parsed = urlparse(src)
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def _is_hotlink_protected_image_source(src: str) -> bool:
    host = urlparse(src).netloc.lower()
    return any(host == protected or host.endswith(f".{protected}") for protected in _HOTLINK_PROTECTED_IMAGE_HOSTS)


def _collect_remote_markdown_image_sources(
    results: list[dict[str, str | list[dict[str, str]]]],
) -> tuple[int, set[str]]:
    remote_count = 0
    hotlink_hosts: set[str] = set()
    seen_sources: set[str] = set()

    for result in results:
        content_md = str(result.get("content_md", ""))
        for source in _markdown_image_sources(content_md):
            if not _is_remote_image_source(source) or source in seen_sources:
                continue
            seen_sources.add(source)
            remote_count += 1
            if _is_hotlink_protected_image_source(source):
                hotlink_hosts.add(urlparse(source).netloc.lower())

        images = result.get("images")
        if isinstance(images, list):
            for image in images:
                if not isinstance(image, dict):
                    continue
                source = str(image.get("src", "")).strip()
                if not _is_remote_image_source(source) or source in seen_sources:
                    continue
                seen_sources.add(source)
                remote_count += 1
                if _is_hotlink_protected_image_source(source):
                    hotlink_hosts.add(urlparse(source).netloc.lower())

    return remote_count, hotlink_hosts


def print_remote_image_preview_tip(
    results: list[dict[str, str | list[dict[str, str]]]],
    download_images_flag: bool,
) -> None:
    if download_images_flag:
        return

    remote_count, hotlink_hosts = _collect_remote_markdown_image_sources(results)
    if remote_count == 0:
        return

    if hotlink_hosts:
        hosts = ", ".join(sorted(hotlink_hosts))
        print(
            "[TIP] Markdown contains remote images from hotlink-protected hosts "
            f"({hosts}). Markdown previews loaded from localhost/file origins may show placeholder images. "
            "If inline URL images do not display, suggest rerunning with --include-images --download-images to save images locally."
        )
        return

    print(
        "[TIP] Markdown contains remote image URLs. If a Markdown preview cannot display inline URL images because of CDN referer or hotlink rules, "
        "suggest rerunning with --include-images --download-images to save images locally."
    )


def build_page_markdown(
    metadata: dict[str, str],
    content_md: str,
    links: list[dict[str, str]] | None = None,
    images: list[dict[str, str]] | None = None,
) -> str:
    """
    Build the complete page Markdown file content (including YAML frontmatter).
    """
    parts: list[str] = []

    # YAML frontmatter
    parts.append("---")
    parts.append(f'url: {metadata.get("url", "")}')
    parts.append(f'title: "{metadata.get("title", "Untitled")}"')
    if "description" in metadata:
        parts.append(f'description: "{metadata["description"]}"')
    parts.append(f'scraped_at: {datetime.now(timezone.utc).isoformat()}')
    parts.append("---")
    parts.append("")

    # Title
    title = metadata.get("title", "Untitled")
    parts.append(f"# {title}")
    parts.append("")

    # Body content
    parts.append(content_md)

    # Link list
    if links:
        parts.append("")
        parts.append("## Links")
        parts.append("")
        for link in links:
            parts.append(f'- [{link["text"]}]({link["url"]})')

    # Image list
    if images:
        images = _images_not_already_in_content(images, content_md, metadata.get("url", ""))
    if images:
        parts.append("")
        parts.append("## Images")
        parts.append("")
        for img in images:
            alt = img["alt"] or "image"
            parts.append(f'- ![{alt}]({img["src"]})')

    return "\n".join(parts) + "\n"


def build_summary_markdown(
    base_url: str,
    pages: list[dict[str, str]],
) -> str:
    """
    Build site summary Markdown (index file in multi-page mode).
    """
    parts: list[str] = []

    parts.append("---")
    parts.append(f"source: {base_url}")
    parts.append(f"total_pages: {len(pages)}")
    parts.append(f"scraped_at: {datetime.now(timezone.utc).isoformat()}")
    parts.append("---")
    parts.append("")
    parts.append("# Site Summary")
    parts.append("")
    parts.append(f"Source: {base_url}")
    parts.append(f"Total pages scraped: {len(pages)}")
    parts.append("")
    parts.append("## Pages")
    parts.append("")

    for idx, page in enumerate(pages, 1):
        title = page.get("title", "Untitled")
        filename = page.get("filename", "")
        url = page.get("url", "")
        parts.append(f"{idx}. [{title}]({filename}) - {url}")

    return "\n".join(parts) + "\n"


# ==================== Single-page Scraping ====================

def scrape_single_page(
    client: httpx.Client,
    url: str,
    selector: str | None = None,
    exclude_selectors: list[str] | None = None,
    include_links: bool = False,
    include_images: bool = False,
    forced_encoding: str | None = None,
    download_images_flag: bool = False,
    images_dir: str | None = None,
    image_delay: float = 0.1,
    use_trafilatura: bool = True,
    discover_links_for_crawl: bool = False,
) -> dict[str, str | list[dict[str, str]]]:
    """
    Scrape a single page and return structured results.

    Returns a dict containing: title, url, content_md, links(optional), images(optional).
    """
    html_text, final_url = fetch_page(client, url, forced_encoding)
    soup = BeautifulSoup(html_text, "lxml")

    meta_refresh_url = _extract_meta_refresh_url(html_text, final_url)
    if meta_refresh_url and meta_refresh_url != final_url:
        print(f"  [meta-refresh] Following refresh URL: {meta_refresh_url}")
        html_text, final_url = fetch_page(client, meta_refresh_url, forced_encoding)
        soup = BeautifulSoup(html_text, "lxml")

    # Extract metadata.
    metadata = extract_metadata(soup, final_url)
    content_html_text = html_text
    content_final_url = final_url
    content_soup = soup
    is_wechat_article = _is_wechat_article_url(final_url)
    effective_selector = selector
    if is_wechat_article and not selector:
        effective_selector = "#js_content"
        print("  [wechat] Detected WeChat article, using #js_content and preserving styled headings")

    ssense_microsite_url = _extract_ssense_microsite_url(html_text, final_url)
    if ssense_microsite_url:
        try:
            content_html_text, content_final_url = fetch_page(
                client, ssense_microsite_url, forced_encoding
            )
            content_soup = BeautifulSoup(content_html_text, "lxml")
            print(f"  [ssense] Detected editorial microsite, switching to body source: {content_final_url}")
        except Exception as exc:
            print(f"  [WARN] Failed to scrape SSENSE microsite body source, continuing with the main page: {exc}")

    # Body extraction strategy:
    # 1. If trafilatura is installed and no custom selector is specified, prefer trafilatura.
    # 2. When None is returned (not installed or extraction failed), fall back to the BeautifulSoup heuristic.
    content_md: str = ""
    if use_trafilatura and not effective_selector:
        tf_result = _try_trafilatura(content_html_text, content_final_url)
        if tf_result:
            if _should_fallback_from_trafilatura(content_html_text, tf_result):
                if _is_sphinx_docutils_page(content_html_text):
                    print("  [trafilatura] Detected a Sphinx/Docutils page, falling back to BeautifulSoup to preserve lists and inline code")
                elif _is_mkdocs_material_page(content_html_text):
                    print("  [trafilatura] Detected a MkDocs/Material page, falling back to BeautifulSoup to preserve nested list structure")
                elif _is_mdn_page(content_html_text):
                    print("  [trafilatura] Detected an MDN page, falling back to BeautifulSoup to preserve definition lists and link structure")
                else:
                    print("  [trafilatura] Detected abnormal code block formatting, falling back to BeautifulSoup conversion")
            else:
                content_md = tf_result
                print(f"  [trafilatura] Body extraction succeeded ({len(content_md)} characters)")
                if include_images or download_images_flag:
                    image_order_candidate = _extract_body_with_beautifulsoup(
                        content_soup,
                        content_final_url,
                        effective_selector,
                        exclude_selectors,
                    )
                    if _should_prefer_inline_image_markdown(content_md, image_order_candidate):
                        content_md = image_order_candidate
                        print("  [images] Preserving inline image order with BeautifulSoup body conversion")

    if not content_md:
        # Fallback: BeautifulSoup heuristic body mode.
        content_md = _extract_body_with_beautifulsoup(
            content_soup,
            content_final_url,
            effective_selector,
            exclude_selectors,
        )

    content_md = _tidy_markdown_prose(content_md)
    content_md = _drop_duplicate_leading_title(content_md, metadata.get("title", ""))
    if is_wechat_article:
        content_md = _polish_wechat_markdown(content_md)

    if is_sparse_content(content_md) and not effective_selector:
        structured_result = try_structured_spa_source(
            client,
            content_html_text,
            content_final_url,
            forced_encoding,
        )
        if structured_result:
            content_md = _drop_duplicate_leading_title(
                _tidy_markdown_prose(structured_result.markdown),
                structured_result.metadata.get("title") or metadata.get("title", ""),
            )
            metadata.update({k: v for k, v in structured_result.metadata.items() if v})

    # Content quality self-check; print [WARN] when suspicious signs appear.
    _check_content_quality(content_md, final_url, use_trafilatura=use_trafilatura and not effective_selector)

    # Download images and replace remote paths in MD with local paths.
    url_map: dict[str, str] = {}
    if download_images_flag and images_dir:
        # Merge two image URL sources to avoid missing anything:
        # 1. HTML img tag source (upgraded to read the highest-resolution srcset)
        # 2. Markdown embedded source (trafilatura sometimes writes srcset into md, requiring secondary parsing)
        html_img_urls = {img["src"] for img in extract_image_urls(content_soup, content_final_url)}
        md_img_urls = set(extract_image_urls_from_markdown(content_md, content_final_url))
        all_img_urls = list(html_img_urls | md_img_urls)

        if all_img_urls:
            url_map = download_images(
                client, all_img_urls, images_dir, content_final_url, delay=image_delay
            )
            content_md = rewrite_image_srcs_in_markdown(content_md, url_map)

    result: dict[str, str | list[dict[str, str]]] = {
        "title": metadata.get("title", "Untitled"),
        "url": final_url,
        "metadata": metadata,
        "content_md": content_md,
    }

    if include_links:
        result["links"] = extract_page_links(content_soup, content_final_url)

    if discover_links_for_crawl:
        result["_crawl_links"] = discover_links(soup, final_url)

    if include_images:
        # If downloaded, also replace src in the images list with local paths.
        raw_images = extract_image_urls(content_soup, content_final_url)
        if url_map:
            for img in raw_images:
                local = url_map.get(img["src"]) or url_map.get(urljoin(content_final_url, img["src"]))
                if local:
                    img["src"] = local
        result["images"] = raw_images

    return result


# ==================== Multi-page Scraping ====================

def scrape_multi_page(
    client: httpx.Client,
    start_url: str,
    depth: int = 1,
    max_pages: int = 20,
    use_sitemap: bool = False,
    selector: str | None = None,
    exclude_selectors: list[str] | None = None,
    include_links: bool = False,
    include_images: bool = False,
    forced_encoding: str | None = None,
    delay: float = 0.5,
    download_images_flag: bool = False,
    images_dir: str | None = None,
    image_delay: float = 0.1,
    use_trafilatura: bool = True,
    incremental_output_dir: str | None = None,
) -> list[dict[str, str | list[dict[str, str]]]]:
    """
    Multi-page recursive scraping.

    Two discovery strategies:
    1. Sitemap mode: get all URLs from sitemap.xml
    2. Crawl mode: recursively discover links by depth starting from the start page
    """
    urls_to_scrape: list[str] = []
    scraped_urls: set[str] = set()
    queued_urls: set[str] = set()
    effective_use_sitemap = use_sitemap
    effective_depth = depth

    if use_sitemap:
        # Try to discover URLs from sitemap.
        sitemap_urls = _discover_from_sitemap(client, start_url)
        if sitemap_urls:
            normalized_sitemap_urls = _unique_normalized_crawl_urls(sitemap_urls)
            urls_to_scrape = normalized_sitemap_urls[:max_pages]
            queued_urls.update(urls_to_scrape)
            print(
                f"Discovered {len(sitemap_urls)} URLs from sitemap "
                f"({len(normalized_sitemap_urls)} unique after normalization); "
                f"scraping the first {len(urls_to_scrape)}"
            )
        else:
            print("No sitemap found, falling back to link crawling mode")
            effective_use_sitemap = False
            if effective_depth <= 0 and max_pages > 1:
                effective_depth = 1
            start_crawl_url = normalize_crawl_url(start_url)
            urls_to_scrape = [start_crawl_url]
            queued_urls.add(start_crawl_url)
    else:
        start_crawl_url = normalize_crawl_url(start_url)
        urls_to_scrape = [start_crawl_url]
        queued_urls.add(start_crawl_url)

    results: list[dict[str, str | list[dict[str, str]]]] = []

    # BFS scraping by depth.
    current_depth = 0
    current_level_urls = urls_to_scrape[:]
    next_level_urls: list[str] = []

    progress_bar = tqdm(total=min(max_pages, len(urls_to_scrape) if effective_use_sitemap else max_pages),
                        desc="Scraping progress", unit="page")

    while current_level_urls and len(results) < max_pages:
        for url in current_level_urls:
            if len(results) >= max_pages:
                break
            url = normalize_crawl_url(url)
            if url in scraped_urls:
                continue

            scraped_urls.add(url)

            try:
                page_result = scrape_single_page(
                    client, url, selector, exclude_selectors,
                    include_links, include_images, forced_encoding,
                    download_images_flag=download_images_flag,
                    images_dir=images_dir,
                    image_delay=image_delay,
                    use_trafilatura=use_trafilatura,
                    discover_links_for_crawl=current_depth < effective_depth and not effective_use_sitemap,
                )
                results.append(page_result)
                if incremental_output_dir:
                    save_incremental_page_result(
                        page_result,
                        incremental_output_dir,
                        len(results),
                    )
                final_crawl_url = normalize_crawl_url(str(page_result.get("url") or url))
                scraped_urls.add(final_crawl_url)
                progress_bar.update(1)
                progress_bar.set_postfix_str(
                    f"{page_result.get('title', 'Untitled')}"[:40]
                )

                # Discover new links (for the next depth level).
                if current_depth < effective_depth and not effective_use_sitemap:
                    new_links = page_result.get("_crawl_links", [])
                    for link in new_links:
                        if not isinstance(link, str):
                            continue
                        normalized_link = normalize_crawl_url(link)
                        if normalized_link in scraped_urls or normalized_link in queued_urls:
                            continue
                        queued_urls.add(normalized_link)
                        next_level_urls.append(normalized_link)

            except httpx.HTTPStatusError as e:
                print(f"\n  [!] Skipping {url}: HTTP {e.response.status_code}")
            except httpx.RequestError as e:
                print(f"\n  [!] Skipping {url}: {e}")
            except Exception as e:
                print(f"\n  [!] Skipping {url}: {type(e).__name__}: {e}")

            # Request interval to avoid rate limiting.
            if delay > 0 and len(results) < max_pages:
                _polite_sleep(delay)

        # Next depth level.
        current_depth += 1
        if current_depth > effective_depth:
            break
        current_level_urls = next_level_urls[:]
        next_level_urls = []
        if current_level_urls:
            # Update the progress bar total.
            progress_bar.total = min(max_pages, len(scraped_urls) + len(current_level_urls))

    progress_bar.close()
    return results


def _discover_from_sitemap(client: httpx.Client, start_url: str) -> list[str]:
    """Discover a URL list from sitemap.xml."""
    parsed = urlparse(start_url)
    sitemap_candidates = [
        f"{parsed.scheme}://{parsed.netloc}/sitemap.xml",
        f"{parsed.scheme}://{parsed.netloc}/sitemap_index.xml",
        f"{parsed.scheme}://{parsed.netloc}/sitemap/sitemap.xml",
    ]

    for sitemap_url in sitemap_candidates:
        try:
            response = _request_with_retries(client, sitemap_url)
            if response.status_code == 200 and "xml" in response.headers.get("content-type", ""):
                from lxml import etree
                root = etree.fromstring(response.content)
                # Handle namespaces.
                nsmap = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}

                urls: list[str] = []

                # Check whether this is a sitemap index.
                sitemaps = root.findall(".//sm:sitemap/sm:loc", nsmap)
                if sitemaps:
                    # Recursively parse child sitemaps.
                    for sitemap_loc in sitemaps[:5]:
                        if sitemap_loc.text:
                            sub_urls = _parse_sitemap_xml(client, sitemap_loc.text.strip())
                            urls.extend(sub_urls)
                else:
                    # Directly parse the URL list.
                    for loc in root.findall(".//sm:url/sm:loc", nsmap):
                        if loc.text:
                            urls.append(loc.text.strip())

                if urls:
                    return urls
        except Exception:
            continue

    return []


def _parse_sitemap_xml(client: httpx.Client, sitemap_url: str) -> list[str]:
    """Parse a single sitemap XML file."""
    urls: list[str] = []
    try:
        response = _request_with_retries(client, sitemap_url)
        if response.status_code == 200:
            from lxml import etree
            root = etree.fromstring(response.content)
            nsmap = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
            for loc in root.findall(".//sm:url/sm:loc", nsmap):
                if loc.text:
                    urls.append(loc.text.strip())
    except Exception:
        pass
    return urls


# ==================== Main Flow ====================

def save_results(
    results: list[dict[str, str | list[dict[str, str]]]],
    output_dir: str,
    base_url: str,
    generate_summary: bool = False,
    download_images_flag: bool = False,
) -> None:
    """Save scraping results as Markdown files."""
    os.makedirs(output_dir, exist_ok=True)

    # Image statistics
    img_total = 0
    if download_images_flag:
        images_dir = os.path.join(output_dir, "images")
        if os.path.isdir(images_dir):
            img_total = len([f for f in os.listdir(images_dir)
                             if os.path.isfile(os.path.join(images_dir, f))])

    page_records: list[dict[str, str]] = []

    if len(results) == 1:
        # Single-page mode: use the title directly as the filename.
        result = results[0]
        title = str(result.get("title", "Untitled"))
        filename = sanitize_filename(title) + ".md"
        filepath = os.path.join(output_dir, filename)

        md_content = _page_result_to_markdown(result)
        _write_text_file(filepath, md_content)

        print(f"\n[OK] Saved: {filepath}")
        print(f"  Title: {title}")
        print(f"  Size: {len(md_content):,} characters")
        if download_images_flag:
            print(f"  Downloaded images: {img_total} -> {os.path.join(output_dir, 'images')}")

    else:
        # Multi-page mode: numbered filenames.
        for idx, result in enumerate(results, 1):
            title = str(result.get("title", "Untitled"))
            filename = f"page_{idx:03d}.md"
            filepath = os.path.join(output_dir, filename)

            md_content = _page_result_to_markdown(result)
            _write_text_file(filepath, md_content)

            page_records.append({
                "title": title,
                "filename": filename,
                "url": str(result.get("url", "")),
            })

        print(f"\n[OK] Saved {len(results)} pages to: {output_dir}")
        if download_images_flag:
            print(f"  Downloaded images: {img_total} -> {os.path.join(output_dir, 'images')}")

        # Generate summary file.
        if generate_summary or len(results) > 1:
            summary_md = build_summary_markdown(base_url, page_records)
            summary_path = os.path.join(output_dir, "summary.md")
            _write_text_file(summary_path, summary_md)
            print(f"  Summary file: {summary_path}")


def _page_result_to_markdown(result: dict[str, str | list[dict[str, str]]]) -> str:
    return build_page_markdown(
        result.get("metadata", {}),
        str(result.get("content_md", "")),
        result.get("links") if isinstance(result.get("links"), list) else None,
        result.get("images") if isinstance(result.get("images"), list) else None,
    )


def _write_text_file(filepath: str, content: str) -> None:
    os.makedirs(os.path.dirname(filepath) or ".", exist_ok=True)
    tmp_path = filepath + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(content)
    os.replace(tmp_path, filepath)


def save_incremental_page_result(
    result: dict[str, str | list[dict[str, str]]],
    output_dir: str,
    page_index: int,
) -> str:
    """Write one crawled page immediately in the multi-page filename format."""
    os.makedirs(output_dir, exist_ok=True)
    filename = f"page_{page_index:03d}.md"
    filepath = os.path.join(output_dir, filename)
    _write_text_file(filepath, _page_result_to_markdown(result))
    print(f"\n  [save] Page {page_index}: {filepath}")
    return filepath


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Web Scraper - web knowledge scraping tool",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s "https://docs.python.org/3/library/json.html" -o ./output
  %(prog)s "https://fastapi.tiangolo.com/" --depth 1 --max-pages 30 -o ./output
  %(prog)s "https://example.com/" --sitemap --max-pages 50 -o ./output
  %(prog)s "https://example.com/" --selector "article.main" -o ./output
        """,
    )

    parser.add_argument("url", help="Target URL")
    parser.add_argument("-o", "--output-dir", default="./scraped_output", help="Output directory (default: ./scraped_output)")
    parser.add_argument("-d", "--depth", type=int, default=0, help="Recursive scraping depth, 0 = current page only (default: 0)")
    parser.add_argument("-m", "--max-pages", type=int, default=20, help="Maximum number of pages to scrape (default: 20)")
    parser.add_argument("-s", "--selector", help="CSS selector for the body content area")
    parser.add_argument("-e", "--exclude-selector", action="append", help="CSS selector for areas to exclude (can be specified multiple times)")
    parser.add_argument("--include-links", action="store_true", help="Include the link list in the output")
    parser.add_argument("--include-images", action="store_true", help="Include image URLs in the output")
    parser.add_argument("--download-images", action="store_true",
                        help="Download images from the page to the images/ subdirectory and replace image links in MD with local relative paths")
    parser.add_argument("--sitemap", action="store_true", help="Use sitemap.xml to discover pages")
    parser.add_argument("-t", "--timeout", type=float, default=15.0, help="Request timeout in seconds (default: 15)")
    parser.add_argument("--delay", type=float, default=0.5, help="Request interval in seconds (default: 0.5)")
    parser.add_argument("--proxy", help="HTTP proxy address")
    parser.add_argument("--headers", help="Custom request headers (JSON string)")
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT, help="Custom User-Agent")
    parser.add_argument("--encoding", help="Force a specific web page encoding (auto-detect if not specified)")
    parser.add_argument("--summary", action="store_true", help="Generate site summary file summary.md")
    parser.add_argument("--impersonate", metavar="BROWSER",
                        help=f"Use curl_cffi to impersonate browser TLS fingerprints and bypass anti-scraping (for example chrome131). "
                             f"Optional values: {', '.join(SUPPORTED_IMPERSONATE[:5])}...")
    parser.add_argument("--cookies", metavar="JSON",
                        help="Additional cookies, in JSON string format, such as '{\"name\": \"value\"}', "
                             "often used for pages requiring login or to bypass session verification")
    parser.add_argument("--cookies-file", metavar="PATH",
                        help="Read cookies from a JSON file ({name: value} dictionary format), "
                             "which can be exported from the browser and arranged into this format")
    parser.add_argument("--no-trafilatura", action="store_true",
                        help="Disable trafilatura body extraction and force fallback to the BeautifulSoup heuristic")

    args = parser.parse_args()

    # Parse custom request headers.
    custom_headers = None
    if args.headers:
        try:
            custom_headers = json.loads(args.headers)
        except json.JSONDecodeError:
            print("Error: --headers must be a valid JSON string")
            sys.exit(1)

    # Parse cookies.
    cookies: dict[str, str] | None = None
    if args.cookies:
        try:
            cookies = json.loads(args.cookies)
        except json.JSONDecodeError:
            print("Error: --cookies must be a valid JSON string, such as \'{\"name\": \"value\"}'"
            )
            sys.exit(1)
    elif args.cookies_file:
        try:
            with open(args.cookies_file, encoding="utf-8") as _cf:
                cookies = json.load(_cf)
        except (OSError, json.JSONDecodeError) as e:
            print(f"Error: failed to read cookies file: {e}")
            sys.exit(1)

    # Merge exclude selectors.
    exclude_selectors = DEFAULT_EXCLUDE_SELECTORS[:]
    if args.exclude_selector:
        exclude_selectors.extend(args.exclude_selector)

    use_trafilatura = not args.no_trafilatura
    effective_proxy = args.proxy or default_proxy_from_env()

    # Create HTTP client.
    client = create_http_client(
        timeout=args.timeout,
        proxy=effective_proxy,
        headers=custom_headers,
        user_agent=args.user_agent,
        impersonate=args.impersonate,
        cookies=cookies,
    )

    print(f"[>] Target: {args.url}")
    print(f"[>] Output: {args.output_dir}")
    if args.impersonate:
        print(f"[>] Engine: curl_cffi (fingerprint: {args.impersonate})")
    else:
        print(f"[>] Engine: httpx")
    if cookies:
        print(f"[>] Cookie: loaded {len(cookies)} fields")
    if use_trafilatura:
        if is_trafilatura_available():
            print(f"[>] Body extraction: trafilatura available; trying it first and falling back to BeautifulSoup when needed")
        else:
            print(f"[>] Body extraction: trafilatura not importable by this Python executable; using BeautifulSoup fallback")
    else:
        print(f"[>] Body extraction: BeautifulSoup heuristic (--no-trafilatura specified)")
    if args.depth > 0:
        print(f"[>] Mode: recursive scraping (depth={args.depth}, max pages={args.max_pages})")
    elif args.sitemap:
        print(f"[>] Mode: Sitemap scraping (max pages={args.max_pages})")
    else:
        print(f"[>] Mode: single-page scraping")
    print()

    try:
        if args.depth > 0 or args.sitemap:
            # Multi-page mode
            results = scrape_multi_page(
                client,
                args.url,
                depth=args.depth,
                max_pages=args.max_pages,
                use_sitemap=args.sitemap,
                selector=args.selector,
                exclude_selectors=exclude_selectors,
                include_links=args.include_links,
                include_images=args.include_images,
                forced_encoding=args.encoding,
                delay=args.delay,
                download_images_flag=args.download_images,
                images_dir=os.path.join(args.output_dir, "images") if args.download_images else None,
                image_delay=0.1,
                use_trafilatura=use_trafilatura,
                incremental_output_dir=args.output_dir,
            )
        else:
            # Single-page mode
            result = scrape_single_page(
                client,
                args.url,
                selector=args.selector,
                exclude_selectors=exclude_selectors,
                include_links=args.include_links,
                include_images=args.include_images,
                forced_encoding=args.encoding,
                download_images_flag=args.download_images,
                images_dir=os.path.join(args.output_dir, "images") if args.download_images else None,
                image_delay=0.1,
                use_trafilatura=use_trafilatura,
            )
            results = [result]

        if not results:
            print("[!] Failed to scrape any content")
            sys.exit(1)

        save_results(results, args.output_dir, args.url, args.summary, args.download_images)
        print_remote_image_preview_tip(results, args.download_images)
        print(f"\n[OK] Done! Scraped {len(results)} pages in total")
        if len(results) == 1 and args.depth == 0 and not args.sitemap:
            print(
                "[TIP] Single-page mode scraped only the provided URL. "
                "If the user wants related child pages or a full documentation section, suggest rerunning with --depth 1/2 or --sitemap --max-pages N."
            )

    except httpx.HTTPStatusError as e:
        print(f"[ERR] HTTP error: {e.response.status_code} -- {args.url}")
        sys.exit(1)
    except (httpx.RequestError, Exception) as e:
        # Compatible with exception types from both httpx and curl_cffi.
        if isinstance(e, KeyboardInterrupt):
            raise
        print(f"[ERR] Request failed: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n[!] Interrupted by user")
        sys.exit(130)
    finally:
        client.close()


if __name__ == "__main__":
    main()
