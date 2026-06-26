"""
Douyin video data collection script.

Fetch video details, user homepage upload lists, and mix video lists through
Douyin Web APIs. Supports four modes: single video, multiple videos, user
homepage, and mix.

Anti-scraping strategy:
  - Prefer A-Bogus signatures (requires the gmssl library)
  - Automatically fall back to X-Bogus signatures when gmssl is unavailable
  - Support persistent Cookie files (shared cache with the video-downloader skill)

Dependencies: aiohttp (bundled with the runtime), gmssl (optional, enables A-Bogus)
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import io
import json
import os
import random
import re
import string
import sys
import time
from datetime import datetime
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlencode

# Windows terminal encoding compatibility.
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

import aiohttp

# ==================== A-Bogus Signature (optional; source: F2 project, Apache-2.0 License) ====================
# _abogus_impl.py shares the same implementation with the video-downloader skill.
# If gmssl is not installed, the script falls back to X-Bogus signatures (limited functionality).

try:
    from _abogus_impl import ABogus as _ABogus, BrowserFingerprintGenerator as _BrowserFP  # type: ignore
    _ABOGUS_AVAILABLE = True
except ImportError:
    _ABOGUS_AVAILABLE = False


def generate_abogus(query: str, user_agent: str, body: str = "") -> Optional[str]:
    """Generate an A-Bogus signature and append it to the query string.

    A-Bogus is a signature parameter required by Douyin since late 2024; APIs
    return empty data when it is missing. It depends on the gmssl library; when
    unavailable, this returns None and the caller falls back to X-Bogus.

    Args:
        query: URL query string (without a_bogus)
        user_agent: User-Agent string used by the request
        body: POST request body (empty string for GET requests)

    Returns:
        Full query string with a_bogus, or None when unavailable
    """
    if not _ABOGUS_AVAILABLE:
        return None
    try:
        fp = _BrowserFP.generate_fingerprint("Edge")
        signer = _ABogus(user_agent=user_agent, fp=fp)
        signed_query, _ab, _ua, _body = signer.generate_abogus(params=query, body=body)
        return signed_query
    except Exception as exc:
        print(f"[DEBUG] A-Bogus generation failed (falling back to X-Bogus): {exc}")
        return None


# ==================== X-Bogus Signature (source: F2/douyin-downloader project) ====================

class XBogus:
    """X-Bogus signer, used as the fallback when A-Bogus is unavailable.

    Implementation references utils/xbogus.py from the douyin-downloader project
    (MIT License).
    """

    _CHARACTER = "Dkdpgh4ZKsQB80/Mfvw36XIgR25+WqEJNLct7eoU1yTOPuzmFjYi_VHAaBbCDGrxklnXd9"
    _ua_key = b"\x00\x01\x0c\x0e"

    def __init__(self, user_agent: str) -> None:
        self._user_agent = user_agent

    def _md5_str_to_array(self, s: str) -> List[int]:
        return [int(s[i:i + 2], 16) for i in range(0, len(s), 2)]

    def _md5(self, input_data: Any) -> str:
        data = self._md5_str_to_array(input_data) if isinstance(input_data, str) else input_data
        return hashlib.md5(bytes(data)).hexdigest()

    def _md5_encrypt(self, url_path: str) -> List[int]:
        return self._md5_str_to_array(self._md5(self._md5_str_to_array(self._md5(url_path))))

    def _encoding_conversion(self, a, b, c, e, d, t, f, r, n, o, i, _, x, u, s, l, v, h, p) -> str:
        payload = [a]
        payload.append(int(i))
        payload.extend([b, _, c, x, e, u, d, s, t, l, f, v, r, h, n, p, o])
        return bytes(payload).decode("ISO-8859-1")

    def _encoding_conversion2(self, a: int, b: int, c: str) -> str:
        return chr(a) + chr(b) + c

    @staticmethod
    def _rc4_encrypt(key: bytes, data: bytes) -> bytearray:
        s = list(range(256))
        j = 0
        for i in range(256):
            j = (j + s[i] + key[i % len(key)]) % 256
            s[i], s[j] = s[j], s[i]
        encrypted = bytearray()
        i = j = 0
        for byte in data:
            i = (i + 1) % 256
            j = (j + s[i]) % 256
            s[i], s[j] = s[j], s[i]
            encrypted.append(byte ^ s[(s[i] + s[j]) % 256])
        return encrypted

    def _calculation(self, a1: int, a2: int, a3: int) -> str:
        x3 = ((a1 & 255) << 16) | ((a2 & 255) << 8) | (a3 & 255)
        return (
            self._CHARACTER[(x3 & 16515072) >> 18]
            + self._CHARACTER[(x3 & 258048) >> 12]
            + self._CHARACTER[(x3 & 4032) >> 6]
            + self._CHARACTER[x3 & 63]
        )

    def build(self, url: str) -> Tuple[str, str, str]:
        """Generate a URL with an X-Bogus signature."""
        ua_md5_array = self._md5_str_to_array(
            self._md5(
                base64.b64encode(
                    self._rc4_encrypt(self._ua_key, self._user_agent.encode("ISO-8859-1"))
                ).decode("ISO-8859-1")
            )
        )
        empty_md5_array = self._md5_str_to_array(
            self._md5(self._md5_str_to_array("d41d8cd98f00b204e9800998ecf8427e"))
        )
        url_md5_array = self._md5_encrypt(url)

        timer = int(time.time())
        ct = 536919696

        new_array = [
            64, 0.00390625, 1, 12,
            url_md5_array[14], url_md5_array[15],
            empty_md5_array[14], empty_md5_array[15],
            ua_md5_array[14], ua_md5_array[15],
            timer >> 24 & 255, timer >> 16 & 255, timer >> 8 & 255, timer & 255,
            ct >> 24 & 255, ct >> 16 & 255, ct >> 8 & 255, ct & 255,
        ]

        xor_result = new_array[0]
        for value in new_array[1:]:
            xor_result ^= int(value)
        new_array.append(xor_result)

        array3: List[int] = []
        array4: List[int] = []
        for idx in range(0, len(new_array), 2):
            array3.append(new_array[idx])
            if idx + 1 < len(new_array):
                array4.append(new_array[idx + 1])
        merged = array3 + array4

        garbled = self._encoding_conversion2(
            2, 255,
            self._rc4_encrypt(
                "ÿ".encode("ISO-8859-1"),
                self._encoding_conversion(*merged).encode("ISO-8859-1"),
            ).decode("ISO-8859-1"),
        )

        xb = ""
        for idx in range(0, len(garbled), 3):
            xb += self._calculation(ord(garbled[idx]), ord(garbled[idx + 1]), ord(garbled[idx + 2]))

        return f"{url}&X-Bogus={xb}", xb, self._user_agent


# ==================== msToken Generation ====================

def _generate_fallback_ms_token() -> str:
    """Generate a random msToken (A-Bogus can compensate for validity; this is only a placeholder)."""
    return "".join(random.choice(string.ascii_letters + string.digits) for _ in range(182)) + "=="


# ==================== Cookie Utilities ====================

# Shared cache file with the video-downloader skill; users only need to configure it once.
_COOKIE_CACHE_PATH = Path.home() / ".douyin_cookies.json"


def _sanitize_cookies(cookies: Dict[str, str]) -> Dict[str, str]:
    """Filter cookies and remove empty keys/values."""
    return {k: v for k, v in cookies.items() if k and v}


def _parse_cookie_string(raw: str) -> Dict[str, str]:
    """Parse a browser-format Cookie string (key=value; key=value...)."""
    result: Dict[str, str] = {}
    for part in raw.split(";"):
        part = part.strip()
        if "=" in part:
            key, _, value = part.partition("=")
            key = key.strip()
            value = value.strip()
            if key:
                result[key] = value
    return result


def _parse_cookie_file_content(raw: str) -> Dict[str, str]:
    """Intelligently parse Cookie file content; supports JSON and raw strings copied from a browser."""
    raw = raw.strip()
    if not raw:
        return {}

    # Try JSON object format.
    if raw.startswith("{"):
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                return _sanitize_cookies({k: str(v) for k, v in data.items()})
        except Exception:
            pass

    # Plain browser string format.
    return _sanitize_cookies(_parse_cookie_string(raw))


def load_cookies_from_cache() -> Dict[str, str]:
    """Load cookies from the persistent cache file."""
    if not _COOKIE_CACHE_PATH.exists():
        return {}
    try:
        raw = _COOKIE_CACHE_PATH.read_text(encoding="utf-8")
        cookies = _parse_cookie_file_content(raw)
        if cookies:
            print(f"[INFO] Loaded Cookie from cache: {_COOKIE_CACHE_PATH} ({len(cookies)} keys)")
        return cookies
    except Exception as exc:
        print(f"[WARN] Failed to read Cookie cache: {exc}")
        return {}


def save_cookies_to_cache(cookies: Dict[str, str]) -> None:
    """Save cookies to the persistent cache file."""
    try:
        _COOKIE_CACHE_PATH.write_text(
            json.dumps(cookies, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"[INFO] Cookie cached to: {_COOKIE_CACHE_PATH}")
    except Exception as exc:
        print(f"[WARN] Failed to save Cookie cache: {exc}")


# ==================== URL / ID Parsing ====================

_DOUYIN_BASE_URL = "https://www.douyin.com"

_USER_AGENT_POOL = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
]

# Short-link pattern (v.douyin.com).
_SHORT_LINK_PATTERN = re.compile(r"https?://v\.douyin\.com/")

# Regexes for extracting IDs from various URLs.
_VIDEO_ID_PATTERN = re.compile(r"/video/(\d+)")
_NOTE_ID_PATTERN = re.compile(r"/note/(\d+)")
_MODAL_ID_PATTERN = re.compile(r"modal_id=(\d+)")
_USER_ID_PATTERN = re.compile(r"/user/([A-Za-z0-9_=\-]+)")
_MIX_ID_PATTERN = re.compile(r"/mix/(\d+)")


def parse_aweme_id(raw: str) -> Optional[str]:
    """Extract aweme_id from a URL or plain numeric string.

    Supports plain numeric IDs, /video/xxx URLs, /note/xxx URLs, and modal_id=xxx parameters.
    """
    raw = raw.strip()

    # Plain numeric ID.
    if raw.isdigit():
        return raw

    # Short links are not handled here; the caller is responsible for expanding them.
    if _SHORT_LINK_PATTERN.match(raw):
        return None

    for pattern in (_VIDEO_ID_PATTERN, _NOTE_ID_PATTERN, _MODAL_ID_PATTERN):
        match = pattern.search(raw)
        if match:
            return match.group(1)

    return None


def parse_sec_uid(raw: str) -> Optional[str]:
    """Extract the user sec_uid from a URL or plain string."""
    raw = raw.strip()

    # Values starting with MS4 are generally plain sec_uid values.
    if raw.startswith("MS4") or (not raw.startswith("http") and "/" not in raw):
        return raw

    match = _USER_ID_PATTERN.search(raw)
    if match:
        return match.group(1)

    return None


def parse_mix_id(raw: str) -> Optional[str]:
    """Extract mix_id from a URL or plain numeric string."""
    raw = raw.strip()
    if raw.isdigit():
        return raw
    match = _MIX_ID_PATTERN.search(raw)
    if match:
        return match.group(1)
    return None


def is_short_link(url: str) -> bool:
    """Determine whether the URL is a Douyin short link."""
    return bool(_SHORT_LINK_PATTERN.match(url.strip()))


# Extract the first URL from arbitrary text (used for share-token parsing).
_ANY_URL_PATTERN = re.compile(r"https?://[^\s\u3000\uff0c\u3002\uff01\uff1f\uFF0C\u3002\uFF01\uFF1F'""]+")


def extract_url_from_token(text: str) -> Optional[str]:
    """Extract the first valid URL from a Douyin share token (arbitrary text).

    The Douyin app generates share-token text containing a short link, for example:
      '7.43 pda:/ remember me in seconds https://v.douyin.com/L5pbfdP/ copy this link...'
    This function extracts the https://... portion with a regex for later parsing.

    If the input itself appears to be a plain URL or numeric ID, it is returned unchanged.
    """
    text = text.strip()
    # Already a URL or plain numeric ID; no extraction needed.
    if text.startswith("http") or text.isdigit():
        return text

    match = _ANY_URL_PATTERN.search(text)
    if match:
        extracted = match.group(0).rstrip("/")
        print(f"[INFO] Extracted URL from token: {extracted}")
        return extracted + ("" if not match.group(0).endswith("/") else "/")

    return None


# ==================== API Client ====================

# When fetching video details, try two aid values in turn (6383 for image-text posts, 1128 for videos).
_DETAIL_AID_CANDIDATES = ("6383", "1128")


class DouyinDataClient:
    """Douyin Web API data collection client.

    Includes both A-Bogus (requires gmssl) and X-Bogus (fallback) signature
    mechanisms, using exactly the same signature strategy as DouyinClient in
    the video-downloader skill. Difference: this client focuses on data
    collection and does not include media-download logic.
    """

    def __init__(
        self,
        cookies: Optional[Dict[str, str]] = None,
        proxy: Optional[str] = None,
    ) -> None:
        self._cookies: Dict[str, str] = _sanitize_cookies(cookies or {})
        self._proxy = proxy
        self._session: Optional[aiohttp.ClientSession] = None
        self._user_agent = random.choice(_USER_AGENT_POOL)
        self._signer = XBogus(self._user_agent)
        self._ms_token: str = ""
        self._headers = {
            "User-Agent": self._user_agent,
            "Referer": f"{_DOUYIN_BASE_URL}/",
            "Accept": "application/json",
            "Accept-Encoding": "gzip, deflate",
            "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
            "Connection": "keep-alive",
        }

    async def __aenter__(self) -> "DouyinDataClient":
        await self._ensure_session()
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.close()

    async def _ensure_session(self) -> None:
        if self._session is None or self._session.closed:
            # Disable SSL verification: when the runtime accesses the network through a
            # proxy, the proxy uses a self-signed certificate.
            connector = aiohttp.TCPConnector(ssl=False)
            self._session = aiohttp.ClientSession(
                connector=connector,
                headers=self._headers,
                cookies=self._cookies,
                timeout=aiohttp.ClientTimeout(total=30),
                raise_for_status=False,
            )

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def _get_ms_token(self) -> str:
        """Get msToken, preferring the existing Cookie value; otherwise generate a fallback."""
        if self._ms_token:
            return self._ms_token

        existing = self._cookies.get("msToken", "").strip()
        if existing and len(existing) > 50:
            self._ms_token = existing
            return self._ms_token

        # A-Bogus signatures can compensate for msToken validity, so using a fallback
        # does not affect request success rate when A-Bogus is available.
        self._ms_token = _generate_fallback_ms_token()
        return self._ms_token

    async def _build_base_params(self) -> Dict[str, Any]:
        """Build common Douyin Web API request parameters (simulating a PC browser environment)."""
        ms_token = await self._get_ms_token()
        return {
            "device_platform": "webapp",
            "aid": "6383",
            "channel": "channel_pc_web",
            "update_version_code": "170400",
            "pc_client_type": "1",
            "version_code": "290100",
            "version_name": "29.1.0",
            "cookie_enabled": "true",
            "screen_width": "1920",
            "screen_height": "1080",
            "browser_language": "zh-CN",
            "browser_platform": "Win32",
            "browser_name": "Chrome",
            "browser_version": "130.0.0.0",
            "browser_online": "true",
            "engine_name": "Blink",
            "engine_version": "130.0.0.0",
            "os_name": "Windows",
            "os_version": "10",
            "cpu_core_num": "12",
            "device_memory": "8",
            "platform": "PC",
            "downlink": "10",
            "effective_type": "4g",
            "round_trip_time": "100",
            "msToken": ms_token,
        }

    def _build_signed_url(self, path: str, params: Dict[str, Any]) -> Tuple[str, str]:
        """Build and sign the full request URL.

        Prefer A-Bogus (requires gmssl); fall back to X-Bogus when unavailable.
        Key detail: when signing with A-Bogus, msToken must be empty (''), while
        the actual msToken is passed through Cookie. This references the
        implementation in Evil0ctal/Douyin_TikTok_Download_API. Returns
        (signed_url, user_agent).
        """
        base_url = f"{_DOUYIN_BASE_URL}{path}"

        # Prefer A-Bogus.
        if _ABOGUS_AVAILABLE:
            # Set msToken empty during signature calculation to avoid a random fallback
            # token affecting signature verification.
            sign_params = dict(params)
            sign_params["msToken"] = ""
            query_for_sign = urlencode(sign_params)
            ab_query = generate_abogus(query_for_sign, self._user_agent)
            if ab_query:
                # The actual request URL also uses msToken='' (msToken is carried by Cookie).
                return f"{base_url}?{ab_query}", self._user_agent

        # Fall back to X-Bogus (using full parameters).
        query = urlencode(params)
        signed_url, _, ua = self._signer.build(f"{base_url}?{query}")
        return signed_url, ua

    async def _request_json(
        self,
        path: str,
        params: Dict[str, Any],
        max_retries: int = 3,
    ) -> Dict[str, Any]:
        """Send a signed API request and return the JSON response, with retry logic."""
        await self._ensure_session()
        retry_delays = [1, 2, 5]
        last_error: Optional[Exception] = None

        for attempt in range(max_retries):
            signed_url, ua = self._build_signed_url(path, params)
            try:
                async with self._session.get(
                    signed_url,
                    headers={**self._headers, "User-Agent": ua},
                    proxy=self._proxy or None,
                    ssl=False,
                ) as response:
                    status = response.status
                    if status == 200:
                        try:
                            data = await response.json(content_type=None)
                            if isinstance(data, dict):
                                sc = data.get("status_code", 0)
                                if sc != 0:
                                    print(f"[DEBUG] API status_code={sc}, msg={data.get('status_msg')}")
                                return data
                            print(f"[DEBUG] Response is not a dict, Content-Length={response.headers.get('Content-Length', '?')}")
                            return {}
                        except Exception as json_exc:
                            body = await response.read()
                            print(f"[DEBUG] JSON parsing failed: {json_exc}, body={body[:200]}")
                            return {}
                    elif status < 500 and status != 429:
                        print(f"[WARN] Request failed path={path}, status={status}")
                        return {}
                    else:
                        last_error = RuntimeError(f"HTTP {status} for {path}")
            except Exception as exc:
                last_error = exc
                print(f"[DEBUG] Request exception (attempt {attempt + 1}/{max_retries}): {exc}")

            if attempt < max_retries - 1:
                delay = retry_delays[min(attempt, len(retry_delays) - 1)]
                await asyncio.sleep(delay)

        print(f"[ERROR] Request failed after {max_retries} attempts: {last_error}")
        return {}

    async def resolve_short_url(self, short_url: str) -> Optional[str]:
        """Resolve a short link (v.douyin.com) to the full URL."""
        try:
            await self._ensure_session()
            async with self._session.get(
                short_url,
                allow_redirects=True,
                proxy=self._proxy or None,
                ssl=False,
            ) as response:
                return str(response.url)
        except Exception as exc:
            print(f"[ERROR] Short-link resolution failed: {exc}")
            return None

    async def get_video_detail(self, aweme_id: str) -> Optional[Dict[str, Any]]:
        """Fetch detail data for a single video/image-text aweme.

        Try the two endpoints in turn with aid=6383 (image-text) and aid=1128
        (video), following the implementation logic of the douyin-downloader project.
        """
        for aid in _DETAIL_AID_CANDIDATES:
            params = await self._build_base_params()
            params["aweme_id"] = aweme_id
            params["aid"] = aid

            data = await self._request_json("/aweme/v1/web/aweme/detail/", params)
            if not data:
                continue

            detail = data.get("aweme_detail")
            if detail:
                return detail

            # If aweme_detail is null but filter_reason exists, the content type was
            # filtered; try the other aid.
            filter_info = data.get("filter_detail")
            if isinstance(filter_info, dict) and filter_info.get("filter_reason"):
                print(f"[DEBUG] aweme {aweme_id} was filtered (aid={aid}); retrying the other aid")
                continue

            break

        return None

    async def get_user_post(
        self, sec_uid: str, max_cursor: int = 0, count: int = 20
    ) -> Dict[str, Any]:
        """Fetch the user's posted video list (paginated)."""
        params = await self._build_base_params()
        params.update({
            "sec_user_id": sec_uid,
            "max_cursor": max_cursor,
            "count": count,
            "locate_query": "false",
            "show_live_replay_strategy": "1",
            "need_time_list": "1",
            "time_list_query": "0",
            "whale_cut_token": "",
            "cut_version": "1",
            "publish_video_strategy_type": "2",
        })
        raw = await self._request_json("/aweme/v1/web/aweme/post/", params)
        return _normalize_paged_response(raw)

    async def get_mix_aweme(
        self, mix_id: str, cursor: int = 0, count: int = 20
    ) -> Dict[str, Any]:
        """Fetch the mix video list (paginated)."""
        params = await self._build_base_params()
        params.update({"mix_id": mix_id, "cursor": cursor, "count": count})
        raw = await self._request_json("/aweme/v1/web/mix/aweme/", params)
        return _normalize_paged_response(raw)


def _normalize_paged_response(raw_data: Any) -> Dict[str, Any]:
    """Normalize paginated API response format and extract items, has_more, and max_cursor."""
    raw = raw_data if isinstance(raw_data, dict) else {}
    items: List[Dict[str, Any]] = []
    for key in ("items", "aweme_list", "mix_list"):
        value = raw.get(key)
        if isinstance(value, list):
            items = value
            break

    has_more_val = raw.get("has_more", False)
    try:
        has_more = bool(int(has_more_val))
    except (TypeError, ValueError):
        has_more = bool(has_more_val)

    max_cursor_val = raw.get("max_cursor") or raw.get("cursor", 0)
    try:
        max_cursor = int(max_cursor_val or 0)
    except (TypeError, ValueError):
        max_cursor = 0

    return {
        "items": items,
        "has_more": has_more,
        "max_cursor": max_cursor,
        "status_code": raw.get("status_code", 0),
    }


# ==================== Data Extraction ====================

def extract_video_stats(detail: Dict[str, Any]) -> Dict[str, Any]:
    """Extract all statistics and metadata fields from aweme_detail.

    Field structure references the aweme_detail response format of the Douyin Web API.
    """
    aweme_id = str(detail.get("aweme_id", ""))
    desc = detail.get("desc", "") or ""

    # Author information.
    author = detail.get("author", {}) or {}
    author_nickname = author.get("nickname", "")
    author_sec_uid = author.get("sec_uid", "")

    # Statistics data (statistics structure).
    # play_count is intentionally masked by the platform in Douyin Web APIs and always
    # returns 0, so it is not collected.
    # recommend_count is the actual recommendation count returned by the API and can be
    # used as a reference for spread.
    stats = detail.get("statistics", {}) or {}
    recommend_count = stats.get("recommend_count", 0)
    digg_count = stats.get("digg_count", 0)
    comment_count = stats.get("comment_count", 0)
    share_count = stats.get("share_count", 0)
    collect_count = stats.get("collect_count", 0)
    forward_count = stats.get("forward_count", 0)

    # Time (Unix timestamp, seconds).
    create_time = detail.get("create_time", 0)

    # Video duration (milliseconds -> seconds).
    video = detail.get("video", {}) or {}
    duration_ms = video.get("duration", 0)
    duration_seconds = (duration_ms // 1000) if duration_ms else 0

    # Tags.
    video_tags = detail.get("video_tag", []) or []
    tags = [t.get("tag_name", "") for t in video_tags if isinstance(t, dict) and t.get("tag_name")]

    # Content type (0=video, 68=image-text).
    aweme_type = detail.get("aweme_type", 0)
    content_type = "Image-text" if (aweme_type == 68 or detail.get("images")) else "Video"

    return {
        "aweme_id": aweme_id,
        "url": f"https://www.douyin.com/video/{aweme_id}",
        "description": desc.strip(),
        "author_nickname": author_nickname,
        "author_sec_uid": author_sec_uid,
        "content_type": content_type,
        "published_at": datetime.fromtimestamp(create_time).strftime("%Y-%m-%d %H:%M:%S") if create_time else "",
        "duration_seconds": duration_seconds,
        "duration": _format_duration(duration_seconds),
        "recommend_count": recommend_count,
        "digg_count": digg_count,
        "comment_count": comment_count,
        "share_count": share_count,
        "collect_count": collect_count,
        "forward_count": forward_count,
        "tags": tags,
    }


# ==================== Formatting Utilities ====================

def _format_duration(seconds: int) -> str:
    """Format seconds as mm:ss or hh:mm:ss."""
    if seconds <= 0:
        return "0:00"
    if seconds >= 3600:
        h = seconds // 3600
        m = (seconds % 3600) // 60
        s = seconds % 60
        return f"{h}:{m:02d}:{s:02d}"
    return f"{seconds // 60}:{seconds % 60:02d}"


def _format_number(n: int) -> str:
    """Format a number with thousands separators."""
    return f"{n:,}"


def video_to_markdown(stats: Dict[str, Any]) -> str:
    """Format a single video statistics item as a Markdown fragment."""
    desc_preview = stats["description"][:80] if stats["description"] else stats["aweme_id"]
    tags_str = " · ".join(stats["tags"]) if stats["tags"] else "—"

    md = f"""## {desc_preview}

| Field | Value |
|------|-----|
| Video ID | `{stats['aweme_id']}` |
| Link | {stats['url']} |
| Type | {stats['content_type']} |
| Author | {stats['author_nickname']} |
| Published At | {stats['published_at']} |
| Duration | {stats['duration']} |
| Recommendations | {_format_number(stats['recommend_count'])} |
| Likes | {_format_number(stats['digg_count'])} |
| Comments | {_format_number(stats['comment_count'])} |
| Shares | {_format_number(stats['share_count'])} |
| Favorites | {_format_number(stats['collect_count'])} |

"""
    if stats["description"]:
        md += f"**Description**: {stats['description']}\n\n"
    if stats["tags"]:
        md += f"**Tags**: {tags_str}\n\n"
    md += "---\n\n"
    return md


# ==================== Batch Collection Utilities ====================

async def collect_user_aweme_details(
    client: DouyinDataClient,
    sec_uid: str,
    limit: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Collect detail data for all videos posted on a user's homepage.

    First fetch the aweme_id list, then fetch details one by one, controlling
    request intervals to avoid rate limits.

    Args:
        sec_uid: User sec_uid
        limit: Maximum collection count; None means all

    Returns:
        Raw aweme_detail data list
    """
    aweme_ids: List[str] = []
    max_cursor = 0
    page = 0

    # Phase 1: page through all aweme_ids.
    print("Fetching video list...")
    while True:
        page += 1
        print(f"  Page {page} (cursor={max_cursor})...", end=" ", flush=True)
        data = await client.get_user_post(sec_uid, max_cursor=max_cursor)
        items = data.get("items", [])
        if not items:
            print("Done")
            break

        for item in items:
            if isinstance(item, dict):
                aid = item.get("aweme_id")
                if aid:
                    aweme_ids.append(str(aid))

        print(f"This page: {len(items)} items, cumulative: {len(aweme_ids)} items")

        if limit and len(aweme_ids) >= limit:
            aweme_ids = aweme_ids[:limit]
            break

        if not data.get("has_more"):
            break

        max_cursor = data.get("max_cursor", 0)
        if not max_cursor:
            break

        await asyncio.sleep(1)

    # Phase 2: fetch details one by one.
    details: List[Dict[str, Any]] = []
    total = len(aweme_ids)
    print(f"\nFound {total} videos. Starting detail fetch...")
    for idx, aweme_id in enumerate(aweme_ids, 1):
        print(f"  [{idx}/{total}] {aweme_id} ...", end=" ", flush=True)
        detail = await client.get_video_detail(aweme_id)
        if detail:
            details.append(detail)
            print("✓")
        else:
            print("✗ (failed to fetch details)")
        if idx < total:
            await asyncio.sleep(0.5)

    return details


async def collect_mix_aweme_details(
    client: DouyinDataClient,
    mix_id: str,
    limit: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Collect detail data for all videos in a mix.

    First page through the mix aweme_id list, then request details one by one.
    Note: some mix endpoints return complete aweme data directly in paginated
    responses; this still uses a second request uniformly to ensure field
    completeness.

    Args:
        mix_id: Mix mix_id
        limit: Maximum collection count; None means all

    Returns:
        Raw aweme_detail data list
    """
    aweme_ids: List[str] = []
    cursor = 0

    print("Fetching mix video list...")
    while True:
        data = await client.get_mix_aweme(mix_id, cursor=cursor)
        items = data.get("items", [])
        if not items:
            break

        for item in items:
            if isinstance(item, dict):
                aid = item.get("aweme_id")
                if aid:
                    aweme_ids.append(str(aid))

        if limit and len(aweme_ids) >= limit:
            aweme_ids = aweme_ids[:limit]
            break

        if not data.get("has_more"):
            break

        cursor = data.get("max_cursor", 0)
        if not cursor:
            break

        await asyncio.sleep(0.5)

    details: List[Dict[str, Any]] = []
    total = len(aweme_ids)
    print(f"Found {total} videos. Starting detail fetch...")
    for idx, aweme_id in enumerate(aweme_ids, 1):
        print(f"  [{idx}/{total}] {aweme_id} ...", end=" ", flush=True)
        detail = await client.get_video_detail(aweme_id)
        if detail:
            details.append(detail)
            print("✓")
        else:
            print("✗ (failed to fetch details)")
        if idx < total:
            await asyncio.sleep(0.5)

    return details


# ==================== Output Writing ====================

def write_markdown(
    stats_list: List[Dict[str, Any]], output_dir: str, title: str
) -> str:
    """Output the video data list as a Markdown file."""
    content = f"# {title}\n\n"
    content += (
        f"> Total {len(stats_list)} videos · "
        f"Collection time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n---\n\n"
    )
    for stats in stats_list:
        content += video_to_markdown(stats)

    filepath = os.path.join(output_dir, "douyin_videos.md")
    os.makedirs(output_dir, exist_ok=True)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)
    return filepath


def write_json(stats_list: List[Dict[str, Any]], output_dir: str) -> str:
    """Output the video data list as a JSON file."""
    filepath = os.path.join(output_dir, "douyin_videos.json")
    os.makedirs(output_dir, exist_ok=True)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(stats_list, f, ensure_ascii=False, indent=2)
    return filepath


# ==================== CLI Main Logic ====================

async def _run(args: argparse.Namespace) -> None:
    """Async main flow; execute the matching collection logic by subcommand."""
    # Load cookies: supports both raw Cookie strings and file paths.
    cookies: Dict[str, str] = {}
    if args.cookies:
        raw_input = args.cookies.strip()
        # If the input looks like a file path (contains a path separator or ends
        # with .json), automatically read from the file.
        looks_like_path = (
            raw_input.endswith(".json")
            or raw_input.startswith("/")
            or (len(raw_input) > 1 and raw_input[1] == ":")
            or "\\" in raw_input
            or "%" in raw_input  # When Windows environment variables have not expanded yet.
        )
        if looks_like_path:
            # Try expanding environment variables and ~.
            expanded_path = Path(os.path.expandvars(os.path.expanduser(raw_input)))
            if expanded_path.exists():
                print(f"[INFO] --cookies detected a file path; loading automatically from file: {expanded_path}")
                try:
                    raw_content = expanded_path.read_text(encoding="utf-8")
                    cookies = _parse_cookie_file_content(raw_content)
                except Exception as exc:
                    print(f"[ERROR] Failed to read Cookie file: {exc}", file=sys.stderr)
                    sys.exit(1)
            else:
                # Path does not exist; fall back to the cache file.
                print(f"[WARN] --cookies path does not exist ({expanded_path}); trying to load from the default cache")
                cookies = load_cookies_from_cache()
        else:
            # Parse directly as a Cookie string.
            cookies = _parse_cookie_file_content(raw_input)
        if cookies:
            save_cookies_to_cache(cookies)
        else:
            # Fall back to the cache instead of exiting immediately when parsing fails.
            print("[WARN] Cookie parsing failed; trying to use the cache")
            cookies = load_cookies_from_cache()
    else:
        cookies = load_cookies_from_cache()
        if not cookies:
            print("[WARN] No Cookie cache found; some videos may be inaccessible (lower crawl success rate)")

    proxy: Optional[str] = getattr(args, "proxy", None)
    output_dir: str = args.output_dir
    output_format: str = args.format

    print("=" * 60)
    print(f"Douyin Data Collection | A-Bogus: {'[OK]' if _ABOGUS_AVAILABLE else '[NO] gmssl required'}")
    print(f"Cookie key count: {len(cookies)}")
    print("=" * 60)

    async with DouyinDataClient(cookies=cookies, proxy=proxy) as client:
        details: List[Dict[str, Any]] = []
        title = "Douyin Video Data"

        # ---- video subcommand ----
        if args.command == "video":
            targets: List[str] = args.targets
            aweme_ids: List[str] = []

            for target in targets:
                # Share-token parsing: extract a URL from arbitrary text (for example,
                # share-token text from the Douyin app).
                extracted = extract_url_from_token(target)
                if extracted is None:
                    print(f"[WARN] Unable to extract a URL from input; skipping: {target[:80]}")
                    continue
                target = extracted

                # Short-link expansion.
                if is_short_link(target):
                    print(f"[INFO] Resolving short link: {target}")
                    resolved = await client.resolve_short_url(target)
                    if not resolved:
                        print(f"[WARN] Short-link resolution failed; skipping: {target}")
                        continue
                    target = resolved

                aid = parse_aweme_id(target)
                if not aid:
                    print(f"[WARN] Unable to parse video ID; skipping: {target}")
                    continue
                aweme_ids.append(aid)

            total = len(aweme_ids)
            print(f"Total {total} videos. Starting detail fetch...")
            for idx, aweme_id in enumerate(aweme_ids, 1):
                print(f"  [{idx}/{total}] {aweme_id} ...", end=" ", flush=True)
                detail = await client.get_video_detail(aweme_id)
                if detail:
                    details.append(detail)
                    print("✓")
                else:
                    print("✗ (fetch failed; Cookie may be invalid or the video may have been deleted)")
                if idx < total:
                    await asyncio.sleep(0.5)

        # ---- user subcommand ----
        elif args.command == "user":
            target = args.target
            # Share-token parsing.
            extracted = extract_url_from_token(target)
            if extracted is None:
                print(f"[ERROR] Unable to extract a URL from input: {target}", file=sys.stderr)
                sys.exit(1)
            target = extracted

            if is_short_link(target):
                print(f"[INFO] Resolving short link: {target}")
                resolved = await client.resolve_short_url(target)
                if not resolved:
                    print("[ERROR] Short-link resolution failed", file=sys.stderr)
                    sys.exit(1)
                target = resolved

            sec_uid = parse_sec_uid(target)
            if not sec_uid:
                print(f"[ERROR] Unable to parse user sec_uid: {target}", file=sys.stderr)
                sys.exit(1)

            limit = getattr(args, "limit", None)
            limit_desc = f"(limited to {limit} items)" if limit else "(all uploads)"
            print(f"User sec_uid: {sec_uid[:20]}... {limit_desc}")
            details = await collect_user_aweme_details(client, sec_uid, limit=limit)

        # ---- mix subcommand ----
        elif args.command == "mix":
            target = args.target
            # Share-token parsing.
            extracted = extract_url_from_token(target)
            if extracted is None:
                print(f"[ERROR] Unable to extract a URL from input: {target}", file=sys.stderr)
                sys.exit(1)
            target = extracted

            mix_id = parse_mix_id(target)
            if not mix_id:
                print(f"[ERROR] Unable to parse mix ID: {target}", file=sys.stderr)
                sys.exit(1)

            limit = getattr(args, "limit", None)
            print(f"Mix ID: {mix_id}")
            details = await collect_mix_aweme_details(client, mix_id, limit=limit)

    if not details:
        print("\n[WARN] No video data was fetched. Please check whether the Cookie is valid.")
        sys.exit(1)

    # Extract statistics fields.
    stats_list = [extract_video_stats(d) for d in details]

    # Write files according to --format.
    if output_format in ("md", "both"):
        filepath = write_markdown(stats_list, output_dir, title)
        print(f"\n✅ Markdown saved: {filepath}")

    if output_format in ("json", "both"):
        filepath = write_json(stats_list, output_dir)
        print(f"✅ JSON saved: {filepath}")

    print(f"\nSuccessfully collected {len(stats_list)} video data items")


def _build_parser() -> argparse.ArgumentParser:
    """Build the command-line argument parser."""
    parser = argparse.ArgumentParser(
        description="Douyin video data collection tool: supports single videos, user homepages, and mixes",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s video 7380308675841297704
  %(prog)s video "https://www.douyin.com/video/7380308675841297704"
  %(prog)s video "https://v.douyin.com/iShortXxx"
  %(prog)s video ID1 ID2 ID3 -o ./output
  %(prog)s user "https://www.douyin.com/user/MS4wLjABAAAA..." --limit 30
  %(prog)s mix 7380308675841297704 -f json
  %(prog)s video 7380308675841297704 --cookies "sessionid=xxx; ..."

Share-token examples (paste Douyin app share text directly; links are extracted automatically):
  %(prog)s video "7.43 pda:/ remember me in seconds https://v.douyin.com/L5pbfdP/ copy this link..."
  %(prog)s user "Sharing a Douyin account with you https://v.douyin.com/iXxxxxxx/ tap to view"
        """,
    )

    subparsers = parser.add_subparsers(dest="command", help="Operation mode")

    # video subcommand.
    video_parser = subparsers.add_parser("video", help="Fetch details by video ID/URL (multiple supported)")
    video_parser.add_argument(
        "targets", nargs="+",
        help="Video aweme_id, full link, or short link (multiple values supported, separated by spaces)",
    )

    # user subcommand.
    user_parser = subparsers.add_parser("user", help="Fetch all posted videos from a user homepage")
    user_parser.add_argument("target", help="User sec_uid or profile homepage URL")
    user_parser.add_argument(
        "--limit", "-l", type=int, default=None,
        help="Maximum number of videos to fetch (default: all)",
    )

    # mix subcommand.
    mix_parser = subparsers.add_parser("mix", help="Fetch the mix video list")
    mix_parser.add_argument("target", help="Mix mix_id or mix URL")
    mix_parser.add_argument(
        "--limit", "-l", type=int, default=None,
        help="Maximum number of videos to fetch (default: all)",
    )

    # Arguments shared by all subcommands.
    for sub in [video_parser, user_parser, mix_parser]:
        sub.add_argument(
            "--output-dir", "-o", default="./douyin_output",
            help="Output directory (default: ./douyin_output)",
        )
        sub.add_argument(
            "--format", "-f", choices=["md", "json", "both"], default="md",
            help="Output format (default: md)",
        )
        sub.add_argument(
            "--cookies",
            default=None,
            help=(
                "Cookie configuration. Supports two formats:\n"
                "  1. Raw Cookie string (copied from a browser): 'sessionid=xxx; odin_tt=yyy'\n"
                "  2. Cookie file path (.json format): C:/path/to/cookies.json\n"
                "  After first-time configuration, it is automatically cached to ~/.douyin_cookies.json;\n"
                "  later calls do not need to pass this parameter again (omit the --cookies parameter)"
            ),
        )
        sub.add_argument(
            "--proxy",
            default=None,
            help="HTTP proxy address (for example, http://127.0.0.1:7890)",
        )

    return parser


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    try:
        asyncio.run(_run(args))
    except KeyboardInterrupt:
        print("\n[INFO] Cancelled")
        sys.exit(130)
    except Exception as exc:
        print(f"[ERROR] Unexpected error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
