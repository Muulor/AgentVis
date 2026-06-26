"""
Douyin video downloader (single-file version).

Features:
  - Single-video download (/video/xxx)
  - Image-text note download
  - User homepage batch download (post/like modes)
  - Mix batch download

Uses a persistent Cookie file; Cookie only needs to be configured once and can
be used long term. Does not depend on Playwright, does not require administrator
privileges, and does not need to launch a browser.

Dependencies: aiohttp, aiofiles, gmssl

Copyright notice:
  This file references the API implementation from the douyin-downloader project
  (MIT License), and the ABogus signature algorithm from the F2 project
  (Apache-2.0 License) through _abogus_impl.py.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
import random
import re
import string
import sys
import time
import urllib.request
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlencode

import aiohttp

try:
    import aiofiles  # type: ignore
    _AIOFILES_AVAILABLE = True
except ImportError:
    _AIOFILES_AVAILABLE = False

# ==================== A-Bogus Signature (optional; source: F2 project, Apache-2.0 License) ====================
# _abogus_impl.py was copied from utils/abogus.py in the douyin-downloader project.
# If gmssl is not installed, the script falls back to X-Bogus signatures (limited functionality).

try:
    from _abogus_impl import ABogus as _ABogus, BrowserFingerprintGenerator as _BrowserFP  # type: ignore
    _ABOGUS_AVAILABLE = True
except ImportError:
    _ABOGUS_AVAILABLE = False


def generate_abogus(query: str, user_agent: str, body: str = "") -> Optional[str]:
    """Generate an A-Bogus signature parameter and append it to the query string.

    Uses the original ABogus implementation (F2 project, Apache-2.0 License) to
    ensure signature correctness.

    Args:
        query: URL query string (without a_bogus)
        user_agent: User-Agent string
        body: POST request body (empty string for GET requests)

    Returns:
        Full query string with a_bogus, or None when signing fails/is unavailable
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
    """X-Bogus signer.

    Used as the fallback when A-Bogus is unavailable.
    Implementation reference: douyin-downloader utils/xbogus.py (MIT License).
    """

    _CHARACTER = "Dkdpgh4ZKsQB80/Mfvw36XIgR25+WqEJNLct7eoU1yTOPuzmFjYi_VHAaBbCDGrxklnXd9"
    _ua_key = b"\x00\x01\x0c\x0e"

    def __init__(self, user_agent: str) -> None:
        self._user_agent = user_agent

    def _md5_str_to_array(self, s: str) -> List[int]:
        result = []
        for i in range(0, len(s), 2):
            result.append(int(s[i:i + 2], 16))
        return result

    def _md5(self, input_data: Any) -> str:
        data = self._md5_str_to_array(input_data) if isinstance(input_data, str) else input_data
        md5_hash = hashlib.md5()
        md5_hash.update(bytes(data))
        return md5_hash.hexdigest()

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
    """Generate a random msToken (fallback when it cannot be obtained through normal channels)."""
    return "".join(random.choice(string.ascii_letters + string.digits) for _ in range(182)) + "=="


def _extract_ms_token_from_set_cookie(headers: Any) -> Optional[str]:
    """Extract msToken from Set-Cookie response headers."""
    set_cookies = headers.get_all("Set-Cookie") if hasattr(headers, "get_all") else []
    for header in set_cookies or []:
        cookie = SimpleCookie()
        cookie.load(header)
        morsel = cookie.get("msToken")
        if morsel and morsel.value:
            return morsel.value.strip()
    return None


# ==================== Cookie Utilities ====================

_COOKIE_CACHE_PATH = Path.home() / ".douyin_cookies.json"

# Key Cookie names that need to be kept (denylist filtering; keys not listed here
# are kept, only obviously useless entries are excluded).
_COOKIE_DENYLIST = frozenset()


def sanitize_cookies(cookies: Dict[str, str]) -> Dict[str, str]:
    """Filter cookies and remove clearly invalid entries."""
    return {k: v for k, v in cookies.items() if k and v and k not in _COOKIE_DENYLIST}


def parse_cookie_string(raw: str) -> Dict[str, str]:
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

    # Try JSON format.
    if raw.startswith("{"):
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                return sanitize_cookies({k: str(v) for k, v in data.items()})
        except Exception:
            pass

    # Plain browser string format (key=value; ...).
    return sanitize_cookies(parse_cookie_string(raw))


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


# ==================== URL Parsing ====================

_DOUYIN_BASE_URL = "https://www.douyin.com"

_USER_AGENT_POOL = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
]


def parse_url_type(url: str) -> Tuple[str, Optional[str]]:
    """Parse URL type and ID.

    Returns:
        (type_str, id_str), where type_str is 'video'|'note'|'user'|'mix'|'music'|'unknown'
    """
    # Short link.
    if re.match(r"https?://v\.douyin\.com/", url):
        return "short", url

    # Video URL pattern.
    match = re.search(r"/video/(\d+)", url)
    if match:
        return "video", match.group(1)

    # Image-text note.
    match = re.search(r"/note/(\d+)", url)
    if match:
        return "note", match.group(1)

    # modal_id (featured-page modal URL).
    match = re.search(r"modal_id=(\d+)", url)
    if match:
        return "video", match.group(1)

    # User homepage.
    match = re.search(r"/user/([A-Za-z0-9_=\-]+)", url)
    if match:
        return "user", match.group(1)

    # Mix.
    match = re.search(r"/mix/(\d+)", url)
    if match:
        return "mix", match.group(1)

    return "unknown", None


def extract_user_id(url: str) -> Optional[str]:
    """Extract sec_uid from a user page URL."""
    match = re.search(r"/user/([A-Za-z0-9_=\-]+)", url)
    if match:
        return match.group(1)
    return None


def extract_mix_id(url: str) -> Optional[str]:
    """Extract mix_id from a mix URL."""
    match = re.search(r"/mix/(\d+)", url)
    if match:
        return match.group(1)
    return None


# ==================== API Client ====================

# Try both aid values, referencing the douyin-downloader implementation.
_DETAIL_AID_CANDIDATES = ("6383", "1128")


class DouyinClient:
    """Douyin Web API client.

    Includes both A-Bogus (requires gmssl) and X-Bogus signature mechanisms.
    Prefer A-Bogus and fall back to X-Bogus when it fails.
    """

    def __init__(
        self,
        cookies: Optional[Dict[str, str]] = None,
        proxy: Optional[str] = None,
    ) -> None:
        self._cookies: Dict[str, str] = sanitize_cookies(cookies or {})
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

    async def __aenter__(self) -> "DouyinClient":
        await self._ensure_session()
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.close()

    async def _ensure_session(self) -> None:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                headers=self._headers,
                cookies=self._cookies,
                timeout=aiohttp.ClientTimeout(total=30),
                raise_for_status=False,
            )

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def _get_ms_token(self) -> str:
        """Get msToken, preferring Cookie first and then fallback."""
        if self._ms_token:
            return self._ms_token

        # Use the existing msToken from Cookie.
        existing = self._cookies.get("msToken", "").strip()
        if existing and len(existing) > 50:
            self._ms_token = existing
            print(f"[INFO] Using existing msToken from Cookie (length {len(existing)})")
            return self._ms_token

        # Use fallback (A-Bogus signatures compensate for msToken validity issues).
        self._ms_token = _generate_fallback_ms_token()
        return self._ms_token

    async def _build_base_params(self) -> Dict[str, Any]:
        """Build common Douyin API request parameters."""
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

    def _build_signed_path(self, path: str, params: Dict[str, Any]) -> Tuple[str, str]:
        """Build and sign the API request URL.

        Prefer A-Bogus (requires gmssl) and fall back to X-Bogus.
        Since late 2024, Douyin Web APIs need A-Bogus to return non-empty responses.
        """
        query = urlencode(params)
        base_url = f"{_DOUYIN_BASE_URL}{path}"

        # Prefer A-Bogus signing.
        ab_query = generate_abogus(query, self._user_agent)
        if ab_query:
            return f"{base_url}?{ab_query}", self._user_agent

        # Fall back to X-Bogus.
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
            signed_url, ua = self._build_signed_path(path, params)
            try:
                async with self._session.get(
                    signed_url,
                    headers={**self._headers, "User-Agent": ua},
                    proxy=self._proxy or None,
                ) as response:
                    status = response.status
                    cl = response.headers.get("Content-Length", "?")
                    if status == 200:
                        try:
                            data = await response.json(content_type=None)
                            if isinstance(data, dict):
                                sc = data.get("status_code", 0)
                                if sc != 0:
                                    print(f"[DEBUG] API status_code={sc}, msg={data.get('status_msg')}")
                                return data
                            print(f"[DEBUG] Response is not a dict, Content-Length={cl}")
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
        """Resolve a short link to the full URL."""
        try:
            await self._ensure_session()
            async with self._session.get(
                short_url,
                allow_redirects=True,
                proxy=self._proxy or None,
            ) as response:
                return str(response.url)
        except Exception as exc:
            print(f"[ERROR] Short-link resolution failed: {exc}")
            return None

    async def get_video_detail(self, aweme_id: str) -> Optional[Dict[str, Any]]:
        """Fetch video/image-text details.

        Try two aid values (6383 for image-text, 1128 for video), referencing
        the douyin-downloader implementation.
        """
        print(f"[DEBUG] Fetching video details aweme_id={aweme_id}")
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

            # Content exists but aweme_detail is empty; check whether it was filtered by content type.
            filter_info = data.get("filter_detail")
            if isinstance(filter_info, dict) and filter_info.get("filter_reason"):
                print(f"[DEBUG] aweme {aweme_id} was filtered (aid={aid}, reason={filter_info['filter_reason']}); retrying the other aid")
                continue

            # aweme_detail is null and has no filter reason; stop retrying.
            break

        return None

    async def get_user_post(
        self, sec_uid: str, max_cursor: int = 0, count: int = 20
    ) -> Dict[str, Any]:
        """Fetch the user's posted video list."""
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
        return self._normalize_paged_response(raw)

    async def get_user_like(
        self, sec_uid: str, max_cursor: int = 0, count: int = 20
    ) -> Dict[str, Any]:
        """Fetch the user's liked video list."""
        params = await self._build_base_params()
        params.update({
            "sec_user_id": sec_uid,
            "max_cursor": max_cursor,
            "count": count,
            "locate_query": "false",
        })
        raw = await self._request_json("/aweme/v1/web/aweme/favorite/", params)
        return self._normalize_paged_response(raw)

    async def get_mix_aweme(
        self, mix_id: str, cursor: int = 0, count: int = 20
    ) -> Dict[str, Any]:
        """Fetch the mix video list."""
        params = await self._build_base_params()
        params.update({"mix_id": mix_id, "cursor": cursor, "count": count})
        raw = await self._request_json("/aweme/v1/web/mix/aweme/", params)
        return self._normalize_paged_response(raw)

    @staticmethod
    def _normalize_paged_response(raw_data: Any) -> Dict[str, Any]:
        """Normalize paginated API response format."""
        raw = raw_data if isinstance(raw_data, dict) else {}
        items: List[Dict[str, Any]] = []
        for key in ("items", "aweme_list", "mix_list", "music_list"):
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
            "aweme_list": items,
            "has_more": has_more,
            "max_cursor": max_cursor,
            "status_code": raw.get("status_code", 0),
        }


# ==================== Media Extraction ====================

def extract_video_download_url(detail: Dict[str, Any]) -> Optional[str]:
    """Extract the watermark-free video download link from aweme_detail."""
    # Prefer the highest bitrate in bit_rate (usually watermark-free).
    video = detail.get("video", {})

    # 1. Try the first item in the bit_rate list (highest quality).
    bit_rate_list = video.get("bit_rate", [])
    if isinstance(bit_rate_list, list) and bit_rate_list:
        best = bit_rate_list[0]
        play_addr = best.get("play_addr", {})
        urls = play_addr.get("url_list", [])
        if urls:
            return urls[0]

    # 2. Try play_addr (usually watermarked).
    play_addr = video.get("play_addr", {})
    urls = play_addr.get("url_list", [])
    if urls:
        return urls[0]

    # 3. Try download_addr.
    download_addr = video.get("download_addr", {})
    urls = download_addr.get("url_list", [])
    if urls:
        return urls[0]

    return None


def extract_image_urls(detail: Dict[str, Any]) -> List[str]:
    """Extract all image links from an image-text note aweme_detail."""
    images = detail.get("images", [])
    if not images:
        return []

    urls = []
    for img in images:
        if not isinstance(img, dict):
            continue
        url_list = img.get("url_list", [])
        if url_list:
            urls.append(url_list[0])
    return urls


def get_aweme_title(detail: Dict[str, Any]) -> str:
    """Get the video/note title and remove illegal filename characters."""
    desc = detail.get("desc", "") or detail.get("caption", "") or ""
    # Remove illegal characters from Windows/Mac filenames.
    desc = re.sub(r'[\\/:*?"<>|]', "_", desc).strip()
    aweme_id = detail.get("aweme_id", "unknown")
    return f"{desc[:50]}_{aweme_id}" if desc else str(aweme_id)


# ==================== Download Engine ====================

_DEFAULT_DOWNLOAD_HEADERS = {
    "Referer": f"{_DOUYIN_BASE_URL}/",
    "Accept": "video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.5,*/*;q=0.4",
}


async def _download_file(
    session: aiohttp.ClientSession,
    url: str,
    save_path: Path,
    proxy: Optional[str] = None,
    chunk_size: int = 65536,
) -> bool:
    """Download a single file and show progress."""
    try:
        async with session.get(
            url,
            headers=_DEFAULT_DOWNLOAD_HEADERS,
            proxy=proxy or None,
            allow_redirects=True,
            ) as resp:
            if resp.status != 200:
                print(f"[ERROR] Download failed, HTTP {resp.status}: {url}")
                return False

            total = int(resp.headers.get("Content-Length", 0))
            downloaded = 0
            save_path.parent.mkdir(parents=True, exist_ok=True)

            if _AIOFILES_AVAILABLE:
                import aiofiles
                async with aiofiles.open(save_path, "wb") as f:
                    async for chunk in resp.content.iter_chunked(chunk_size):
                        await f.write(chunk)
                        downloaded += len(chunk)
                        if total:
                            pct = downloaded / total * 100
                            print(f"\r  Downloading... {pct:.1f}% ({downloaded}/{total})", end="", flush=True)
            else:
                content = await resp.read()
                save_path.write_bytes(content)
                downloaded = len(content)

            print(f"\r  [OK] Saved: {save_path.name} ({downloaded} bytes)")
            return True
    except Exception as exc:
        print(f"[ERROR] Download exception: {exc}")
        return False


async def download_video(
    client: DouyinClient,
    aweme_id: str,
    output_dir: Path,
) -> bool:
    """Download a single video or image-text note."""
    print(f"[INFO] Fetching video details: {aweme_id}")
    detail = await client.get_video_detail(aweme_id)

    if not detail:
        print(f"[ERROR] Failed to fetch video details; Cookie may be invalid or the video may have been deleted: {aweme_id}")
        return False

    aweme_type = detail.get("aweme_type", 0)
    title = get_aweme_title(detail)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Determine download session.
    download_session = aiohttp.ClientSession(
        headers={"User-Agent": client._user_agent},
        timeout=aiohttp.ClientTimeout(total=300),
    )

    try:
        # Image-text note (aweme_type == 68 or images exist).
        if aweme_type == 68 or detail.get("images"):
            image_urls = extract_image_urls(detail)
            if image_urls:
                print(f"[INFO] Image-text note, {len(image_urls)} images")
                img_dir = output_dir / title
                img_dir.mkdir(parents=True, exist_ok=True)
                results = []
                for idx, img_url in enumerate(image_urls, 1):
                    save_path = img_dir / f"{idx:03d}.jpg"
                    print(f"  [{idx}/{len(image_urls)}] {save_path.name}")
                    ok = await _download_file(download_session, img_url, save_path, client._proxy)
                    results.append(ok)
                return all(results)
            else:
                print(f"[WARN] Image-text note but no images found; trying to download as video")

        # Regular video.
        video_url = extract_video_download_url(detail)
        if not video_url:
            print(f"[ERROR] No video download link found: {aweme_id}")
            return False

        # Replace the domain with the watermark-free endpoint (common optimization).
        video_url = video_url.replace("api.amemv.com", "aweme.snssdk.com")

        save_path = output_dir / f"{title}.mp4"
        print(f"[INFO] Starting download: {save_path.name}")
        return await _download_file(download_session, video_url, save_path, client._proxy)

    finally:
        await download_session.close()


async def batch_download(
    client: DouyinClient,
    aweme_ids: List[str],
    output_dir: Path,
    concurrency: int = 3,
) -> Tuple[int, int]:
    """Batch download videos while controlling concurrency.

    Returns:
        (success count, failure count)
    """
    semaphore = asyncio.Semaphore(concurrency)
    results: List[bool] = []

    async def _worker(aweme_id: str) -> bool:
        async with semaphore:
            return await download_video(client, aweme_id, output_dir)

    tasks = [asyncio.create_task(_worker(aid)) for aid in aweme_ids]
    for i, task in enumerate(asyncio.as_completed(tasks), 1):
        result = await task
        results.append(result)
        print(f"[INFO] Progress: {i}/{len(aweme_ids)}")

    success = sum(1 for r in results if r)
    failed = len(results) - success
    return success, failed


# ==================== User Homepage Batch Collection ====================

async def collect_user_aweme_ids(
    client: DouyinClient,
    sec_uid: str,
    mode: str = "post",
    max_count: int = 0,
) -> List[str]:
    """Collect all video IDs from a user.

    Args:
        mode: 'post' (posted) or 'like' (liked)
        max_count: Maximum collection count; 0 means unlimited
    """
    aweme_ids: List[str] = []
    max_cursor = 0
    page = 0

    while True:
        page += 1
        print(f"[INFO] Collecting page {page} (cursor={max_cursor})...")

        if mode == "like":
            data = await client.get_user_like(sec_uid, max_cursor=max_cursor)
        else:
            data = await client.get_user_post(sec_uid, max_cursor=max_cursor)

        items = data.get("items", [])
        if not items:
            print("[INFO] No more content; collection complete")
            break

        for item in items:
            if isinstance(item, dict):
                aweme_id = item.get("aweme_id")
                if aweme_id:
                    aweme_ids.append(str(aweme_id))

        print(f"[INFO] This page: {len(items)} items, cumulative: {len(aweme_ids)} items")

        if max_count > 0 and len(aweme_ids) >= max_count:
            aweme_ids = aweme_ids[:max_count]
            break

        if not data.get("has_more"):
            print("[INFO] has_more=False, collection complete")
            break

        max_cursor = data.get("max_cursor", 0)
        if not max_cursor:
            break

        await asyncio.sleep(1)  # Avoid overly frequent requests.

    return aweme_ids


# ==================== Main Entry ====================

async def _main_download(args: argparse.Namespace) -> bool:
    """Main download logic."""
    # Load Cookie.
    cookies: Dict[str, str] = {}
    cookie_cache_path = Path(args.cookie_cache) if args.cookie_cache else _COOKIE_CACHE_PATH

    if args.cookies:
        # Load from command-line argument and cache.
        cookies = _parse_cookie_file_content(args.cookies)
        if cookies:
            save_cookies_to_cache(cookies)
        else:
            print("[ERROR] Provided Cookie format is invalid")
            return False
    elif cookie_cache_path.exists():
        raw = cookie_cache_path.read_text(encoding="utf-8")
        cookies = _parse_cookie_file_content(raw)
        if cookies:
            print(f"[INFO] Loaded Cookie from cache: {cookie_cache_path} ({len(cookies)} keys)")
    else:
        print("[WARN] No Cookie cache found; trying without Cookie (low success rate)")

    proxy = getattr(args, "proxy", None)
    output_dir = Path(args.output or ".")
    url = args.url

    print("=" * 60)
    print("Douyin Video Downloader")
    print("=" * 60)
    print(f"  URL: {url}")
    print(f"  Output directory: {output_dir}")
    print(f"  Cookie key count: {len(cookies)}")
    print(f"  A-Bogus: {'[OK]' if _ABOGUS_AVAILABLE else '[NO] (gmssl not installed)'}")
    print("-" * 60)

    async with DouyinClient(cookies=cookies, proxy=proxy) as client:
        # Resolve short link.
        if re.match(r"https?://v\.douyin\.com/", url):
            print("[INFO] Resolving short link...")
            resolved = await client.resolve_short_url(url)
            if resolved:
                print(f"[INFO] Resolved to: {resolved}")
                url = resolved
            else:
                print("[ERROR] Short-link resolution failed")
                return False

        url_type, url_id = parse_url_type(url)

        if url_type in ("video", "note"):
            success = await download_video(client, url_id, output_dir)
            print()
            print("=" * 60)
            print(f"Result: {'success' if success else 'failure'}")
            print(f"Output directory: {output_dir}")
            return success

        elif url_type == "user":
            mode = getattr(args, "mode", "post")
            max_count = getattr(args, "max_count", 0)
            print(f"[INFO] Collecting user homepage videos (mode: {mode})")
            aweme_ids = await collect_user_aweme_ids(client, url_id, mode=mode, max_count=max_count)
            if not aweme_ids:
                print("[ERROR] No videos were collected; Cookie may have expired")
                return False
            print(f"[INFO] Collected {len(aweme_ids)} videos. Starting batch download...")
            success_count, fail_count = await batch_download(client, aweme_ids, output_dir)
            print()
            print("=" * 60)
            print(f"Result: {success_count} succeeded, {fail_count} failed")
            print(f"Output directory: {output_dir}")
            return fail_count == 0

        elif url_type == "mix":
            print(f"[INFO] Downloading mix {url_id}")
            all_ids: List[str] = []
            cursor = 0
            while True:
                data = await client.get_mix_aweme(url_id, cursor=cursor)
                items = data.get("items", [])
                for item in items:
                    if isinstance(item, dict):
                        aid = item.get("aweme_id")
                        if aid:
                            all_ids.append(str(aid))
                if not data.get("has_more"):
                    break
                cursor = data.get("max_cursor", 0)
                await asyncio.sleep(0.5)
            if not all_ids:
                print("[ERROR] Mix is empty or inaccessible")
                return False
            print(f"[INFO] Mix has {len(all_ids)} videos. Starting batch download...")
            success_count, fail_count = await batch_download(client, all_ids, output_dir)
            print()
            print("=" * 60)
            print(f"Result: {success_count} succeeded, {fail_count} failed")
            return fail_count == 0

        else:
            print(f"[ERROR] Unrecognized URL type: {url}")
            return False


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Douyin video downloader - supports single videos, image-text notes, and user homepage batch downloads"
    )
    parser.add_argument("url", help="Douyin video/user/mix URL")
    parser.add_argument("-o", "--output", default=".", help="Output directory (default: current directory)")
    parser.add_argument("--cookies", help="Browser Cookie string (for first-time configuration)")
    parser.add_argument("--cookie-cache", help=f"Cookie cache file path (default: {_COOKIE_CACHE_PATH})")
    parser.add_argument("--proxy", help="HTTP proxy address (for example, http://127.0.0.1:7890)")
    parser.add_argument(
        "--mode",
        choices=["post", "like"],
        default="post",
        help="User homepage download mode: post (posted) or like (liked)",
    )
    parser.add_argument("--max-count", type=int, default=0, help="Maximum batch download count (0=unlimited)")
    parser.add_argument("--concurrency", type=int, default=3, help="Concurrent download count (default: 3)")

    args = parser.parse_args()

    try:
        success = asyncio.run(_main_download(args))
        sys.exit(0 if success else 1)
    except KeyboardInterrupt:
        print("\n[INFO] Cancelled")
        sys.exit(130)


if __name__ == "__main__":
    main()
