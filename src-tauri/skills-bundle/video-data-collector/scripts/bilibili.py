"""
Bilibili video data collection script.

Fetch video details and creator upload lists through public Bilibili APIs.
Supports single-video, batch-video, and all creator uploads modes.

Subtitle extraction has been moved to bilibili_download.py in the yt-dlp skill.

Dependency: httpx (bundled with the runtime)
"""

import argparse
import functools
import hashlib
import io
import json
import os
import re
import sys
import time
import random
from datetime import datetime
from typing import Optional
from urllib.parse import urlparse, parse_qs, urlencode
from pathlib import Path

# Windows terminal encoding compatibility: force UTF-8 output to avoid charmap errors.
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

import httpx

# Bilibili API endpoints.
BILIBILI_VIDEO_API = "https://api.bilibili.com/x/web-interface/view"
BILIBILI_UP_VIDEOS_API = "https://api.bilibili.com/x/space/wbi/arc/search"
BILIBILI_VIDEO_TAGS_API = "https://api.bilibili.com/x/tag/archive/tags"
BILIBILI_NAV_API = "https://api.bilibili.com/x/web-interface/nav"
# Subtitle-related APIs have been moved to bilibili_download.py in the yt-dlp skill.

# Cookie persistence cache file (anti-rate-limit strategy similar to the video-downloader skill).
# Users only need to configure it once; later runs reuse it automatically.
BILIBILI_COOKIE_CACHE_PATH = Path.home() / ".bilibili_cookies.json"

# Default request headers, simulating normal browser access.
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.bilibili.com/",
    "Origin": "https://www.bilibili.com",
}

# Request delay range (seconds), to avoid triggering rate limits.
REQUEST_DELAY_RANGE = (0.8, 1.5)

# Retry configuration.
MAX_RETRIES = 3
RETRY_BASE_DELAY = 2.0

# Obfuscation mapping table for Wbi signatures (fixed).
WBI_MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]


# ==================== Wbi Signature ====================


def _get_mixin_key(raw_key: str) -> str:
    """
    Generate the mixin key through the obfuscation mapping table.

    Bilibili concatenates img_key + sub_key, rearranges it through a fixed
    character-position mapping table, and takes the first 32 characters as the
    signing key.
    """
    return "".join(raw_key[i] for i in WBI_MIXIN_KEY_ENC_TAB)[:32]


def _fetch_wbi_keys(client: httpx.Client) -> tuple[str, str]:
    """
    Fetch the img_key and sub_key required for Wbi signatures.

    Extract them from the wbi_img field of the /x/web-interface/nav endpoint.
    These two keys rotate periodically, so they need to be fetched at the start
    of each session.
    """
    resp = client.get(BILIBILI_NAV_API)
    resp.raise_for_status()
    data = resp.json()["data"]

    wbi_img = data["wbi_img"]
    # img_url / sub_url format example: https://i0.hdslb.com/bfs/wbi/xxxxx.png
    img_key = wbi_img["img_url"].rsplit("/", 1)[-1].split(".")[0]
    sub_key = wbi_img["sub_url"].rsplit("/", 1)[-1].split(".")[0]
    return img_key, sub_key


_cached_mixin_key: str | None = None


def get_wbi_mixin_key(client: httpx.Client) -> str:
    """
    Get the currently valid Wbi mixin key (with caching).

    It only needs to be fetched once during the script run and is cached in a
    module-level variable.
    """
    global _cached_mixin_key
    if _cached_mixin_key is None:
        img_key, sub_key = _fetch_wbi_keys(client)
        _cached_mixin_key = _get_mixin_key(img_key + sub_key)
    return _cached_mixin_key


def sign_wbi_params(params: dict, mixin_key: str) -> dict:
    """
    Sign request parameters with Wbi.

    Steps:
    1. Add wts (current Unix timestamp)
    2. Sort by parameter name
    3. Filter special characters (!'()*)
    4. Join into a query string and append mixin_key
    5. Calculate MD5 to get w_rid
    """
    params["wts"] = int(time.time())
    # Sort by key.
    sorted_params = dict(sorted(params.items()))
    # Filter special characters in values.
    filtered = {
        k: "".join(c for c in str(v) if c not in "!'()*")
        for k, v in sorted_params.items()
    }
    query_str = urlencode(filtered)
    # MD5 signature.
    w_rid = hashlib.md5((query_str + mixin_key).encode()).hexdigest()
    filtered["w_rid"] = w_rid
    return filtered


# ==================== Cookie Persistence ====================


def _load_sessdata_from_cache() -> Optional[str]:
    """
    Load SESSDATA from the local cache file.

    Supported formats:
    - JSON object: {"SESSDATA": "xxx", ...}
    - Plain string: the stored value is SESSDATA directly
    """
    if not BILIBILI_COOKIE_CACHE_PATH.exists():
        return None
    try:
        raw = BILIBILI_COOKIE_CACHE_PATH.read_text(encoding="utf-8").strip()
        if not raw:
            return None
        # Try parsing as JSON.
        if raw.startswith("{"):
            data = json.loads(raw)
            sessdata = data.get("SESSDATA", "")
            if sessdata:
                print(f"[INFO] Loaded Cookie from cache: {BILIBILI_COOKIE_CACHE_PATH}")
                return str(sessdata)
            return None
        # Plain string format (remove the SESSDATA= prefix).
        value = raw[len("SESSDATA="):] if raw.startswith("SESSDATA=") else raw
        if value:
            print(f"[INFO] Loaded Cookie from cache: {BILIBILI_COOKIE_CACHE_PATH}")
            return value
        return None
    except Exception as exc:
        print(f"[WARN] Failed to read Cookie cache: {exc}")
        return None


def _save_sessdata_to_cache(sessdata: str) -> None:
    """
    Persist SESSDATA to the local cache file in JSON format.

    Store it as a JSON object for convenience and the principle of least
    privilege: if more Cookie fields (such as bili_jct) are needed later, they
    can be added directly.
    """
    try:
        existing: dict = {}
        if BILIBILI_COOKIE_CACHE_PATH.exists():
            try:
                raw = BILIBILI_COOKIE_CACHE_PATH.read_text(encoding="utf-8").strip()
                if raw.startswith("{"):
                    existing = json.loads(raw)
            except Exception:
                pass
        existing["SESSDATA"] = sessdata
        BILIBILI_COOKIE_CACHE_PATH.write_text(
            json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"[INFO] Cookie cached to: {BILIBILI_COOKIE_CACHE_PATH}")
    except Exception as exc:
        print(f"[WARN] Failed to save Cookie cache: {exc}")


# ==================== URL/ID Parsing ====================


def extract_bvid(raw: str) -> str:
    """
    Extract the BV ID from a URL or BV ID.

    Supported formats:
    - BV1fecTzKEne
    - https://www.bilibili.com/video/BV1fecTzKEne/
    - https://www.bilibili.com/video/BV1fecTzKEne/?vd_source=xxx
    """
    # Plain BV ID format.
    bv_pattern = re.compile(r"^(BV[A-Za-z0-9]+)$")
    match = bv_pattern.match(raw.strip())
    if match:
        return match.group(1)

    # Extract the BV ID from a URL.
    url_pattern = re.compile(r"/video/(BV[A-Za-z0-9]+)")
    match = url_pattern.search(raw)
    if match:
        return match.group(1)

    raise ValueError(f"Unable to parse a BV ID from '{raw}'. Please provide a valid BV ID or Bilibili video URL")


def extract_mid(raw: str) -> str:
    """
    Extract the creator MID from a URL or numeric ID.

    Supported formats:
    - 12345678
    - https://space.bilibili.com/12345678
    - https://space.bilibili.com/12345678/video
    """
    # Plain numeric MID.
    if raw.strip().isdigit():
        return raw.strip()

    # Extract the MID from a URL.
    url_pattern = re.compile(r"space\.bilibili\.com/(\d+)")
    match = url_pattern.search(raw)
    if match:
        return match.group(1)

    raise ValueError(f"Unable to parse the creator MID from '{raw}'. Please provide a numeric MID or Bilibili space URL")


# ==================== API Calls ====================


def fetch_video_info(client: httpx.Client, bvid: str) -> dict:
    """
    Fetch detailed information for a single video.

    Calls Bilibili's /x/web-interface/view API and returns full data including
    title, statistics, creator, and more.
    """
    resp = client.get(BILIBILI_VIDEO_API, params={"bvid": bvid})
    resp.raise_for_status()
    data = resp.json()

    if data["code"] != 0:
        raise RuntimeError(f"Bilibili API returned an error (BV: {bvid}): code={data['code']}, message={data.get('message', 'Unknown error')}")

    return data["data"]


def fetch_video_tags(client: httpx.Client, bvid: str) -> list[dict]:
    """Fetch the video's tag list."""
    try:
        resp = client.get(BILIBILI_VIDEO_TAGS_API, params={"bvid": bvid})
        resp.raise_for_status()
        data = resp.json()
        if data["code"] == 0:
            return data["data"]
    except Exception:
        pass
    return []



def fetch_up_video_list(
    client: httpx.Client,
    mid: str,
    limit: Optional[int] = None,
) -> list[str]:
    """
    Fetch the list of BV IDs for a creator's uploaded videos.

    Uses the /x/space/wbi/arc/search API (requires Wbi signing).
    The previously used /x/series/recArchivesByKeywords endpoint has been
    blocked by Bilibili (returns 412).
    """
    bv_list: list[str] = []
    page = 1
    page_size = 30

    # Get the Wbi mixin key for signing request parameters (required by Bilibili anti-scraping).
    mixin_key = get_wbi_mixin_key(client)

    while True:
        params = {
            "mid": mid,
            "ps": page_size,
            "pn": page,
            "order": "pubdate",
            "tid": 0,
        }
        signed_params = sign_wbi_params(params, mixin_key)

        # Request with retries.
        last_error = None
        for attempt in range(MAX_RETRIES):
            resp = client.get(BILIBILI_UP_VIDEOS_API, params=signed_params)

            # 412 is Bilibili's anti-scraping rate-limit response, not a network error.
            # Check it before deciding whether to retry; raise_for_status() would throw
            # immediately and skip the retry block.
            if resp.status_code == 412:
                wait = RETRY_BASE_DELAY * (2 ** attempt) + random.uniform(1, 3)
                print(f"    [Rate limited] Bilibili 412. Waiting {wait:.1f}s before retrying ({attempt + 1}/{MAX_RETRIES})...")
                time.sleep(wait)
                signed_params = sign_wbi_params(
                    {"mid": mid, "ps": page_size, "pn": page, "order": "pubdate", "tid": 0},
                    mixin_key,
                )
                last_error = "412 Precondition Failed"
                continue

            resp.raise_for_status()
            data = resp.json()

            if data["code"] == 0:
                last_error = None
                break
            elif data["code"] in (-799, -412) or "\u9891\u7e41" in data.get("message", ""):
                wait = RETRY_BASE_DELAY * (2 ** attempt) + random.uniform(0, 1)
                print(f"    [Rate limited] Waiting {wait:.1f}s before retrying ({attempt + 1}/{MAX_RETRIES})...")
                time.sleep(wait)
                # Wbi signatures include a timestamp, so re-sign when retrying after rate limits.
                signed_params = sign_wbi_params(
                    {"mid": mid, "ps": page_size, "pn": page, "order": "pubdate", "tid": 0},
                    mixin_key,
                )
                last_error = data.get("message", "Requests too frequent")
            else:
                raise RuntimeError(
                    f"Failed to fetch creator upload list (MID: {mid}): "
                    f"code={data['code']}, {data.get('message', 'Unknown error')}"
                )

        if last_error:
            raise RuntimeError(
                f"Failed to fetch creator upload list (MID: {mid}): "
                f"Still rate limited after {MAX_RETRIES} retries. Please try again later."
            )

        # Data structure of wbi/arc/search: data.list.vlist.
        vlist = data["data"].get("list", {}).get("vlist", [])
        if not vlist:
            break

        for video in vlist:
            bv_list.append(video["bvid"])
            if limit and len(bv_list) >= limit:
                return bv_list

        # Check whether all pages have been fetched.
        total = data["data"].get("page", {}).get("count", 0)
        if page * page_size >= total:
            break

        time.sleep(random.uniform(*REQUEST_DELAY_RANGE))
        page += 1

    return bv_list


def batch_fetch_videos(
    client: httpx.Client,
    bv_list: list[str],
    include_tags: bool = True,
) -> list[dict]:
    """
    Batch-fetch video details with built-in random request delays.

    Returns the list of successfully fetched video data; failed videos print a
    warning and are skipped.
    """
    results: list[dict] = []
    total = len(bv_list)

    for idx, bvid in enumerate(bv_list, 1):
        print(f"  [{idx}/{total}] Fetching {bvid} ...", end=" ", flush=True)
        try:
            video_data = fetch_video_info(client, bvid)
            # Fetch tags separately (the view API may not return the full tag list).
            if include_tags:
                tags = fetch_video_tags(client, bvid)
                video_data["tags"] = tags
            results.append(video_data)
            print("✓")
        except Exception as e:
            print(f"✗ ({e})")

        if idx < total:
            time.sleep(random.uniform(*REQUEST_DELAY_RANGE))

    return results


# ==================== Data Formatting ====================


def format_duration(seconds: int) -> str:
    """Format seconds as mm:ss or hh:mm:ss."""
    if seconds >= 3600:
        h = seconds // 3600
        m = (seconds % 3600) // 60
        s = seconds % 60
        return f"{h}:{m:02d}:{s:02d}"
    return f"{seconds // 60}:{seconds % 60:02d}"


def format_timestamp(ts: int) -> str:
    """Convert a Unix timestamp to a readable date."""
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")


def format_number(n: int) -> str:
    """Format a number with thousands separators."""
    return f"{n:,}"


def video_to_markdown(data: dict) -> str:
    """Format a single video data item as a Markdown fragment."""
    stat = data["stat"]
    owner = data["owner"]

    md = f"""## {data['title']}

| Field | Value |
|------|-----|
| BV ID | `{data['bvid']}` |
| Link | https://www.bilibili.com/video/{data['bvid']}/ |
| Creator | {owner['name']} (MID: {owner['mid']}) |
| Published At | {format_timestamp(data['ctime'])} |
| Duration | {format_duration(data['duration'])} |
| Category | {data.get('tname', 'Unknown')} |
| Views | {format_number(stat['view'])} |
| Likes | {format_number(stat['like'])} |
| Coins | {format_number(stat['coin'])} |
| Favorites | {format_number(stat['favorite'])} |
| Shares | {format_number(stat['share'])} |
| Danmaku | {format_number(stat['danmaku'])} |
| Comments | {format_number(stat['reply'])} |

"""
    # Description.
    desc = data.get("desc", "").strip()
    if desc and desc != "-":
        md += f"**Description**: {desc}\n\n"

    # Tags.
    tags = data.get("tags", [])
    if tags:
        tag_names = [t["tag_name"] for t in tags if "tag_name" in t]
        if tag_names:
            md += f"**Tags**: {' · '.join(tag_names)}\n\n"

    md += "---\n\n"
    return md


def video_to_dict(data: dict) -> dict:
    """Extract video data into a flattened key-field dictionary (for JSON output)."""
    stat = data["stat"]
    owner = data["owner"]
    tags = data.get("tags", [])

    return {
        "bvid": data["bvid"],
        "aid": data.get("aid"),
        "title": data["title"],
        "url": f"https://www.bilibili.com/video/{data['bvid']}/",
        "up_name": owner["name"],
        "up_mid": owner["mid"],
        "published_at": format_timestamp(data["ctime"]),
        "duration": format_duration(data["duration"]),
        "duration_seconds": data["duration"],
        "category": data.get("tname", ""),
        "description": data.get("desc", ""),
        "views": stat["view"],
        "likes": stat["like"],
        "coins": stat["coin"],
        "favorites": stat["favorite"],
        "shares": stat["share"],
        "danmaku": stat["danmaku"],
        "comments": stat["reply"],
        "tags": [t["tag_name"] for t in tags if "tag_name" in t],
    }


# ==================== Output ====================


def write_markdown(videos: list[dict], output_path: str, title: str) -> str:
    """Output the video list as a Markdown file."""
    content = f"# {title}\n\n"
    content += f"> Total {len(videos)} videos · Collection time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n---\n\n"

    for data in videos:
        content += video_to_markdown(data)

    filepath = os.path.join(output_path, "bilibili_videos.md")
    os.makedirs(output_path, exist_ok=True)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)

    return filepath


def write_json(videos: list[dict], output_path: str) -> str:
    """Output the video list as a JSON file."""
    records = [video_to_dict(v) for v in videos]
    filepath = os.path.join(output_path, "bilibili_videos.json")
    os.makedirs(output_path, exist_ok=True)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)

    return filepath


# ==================== CLI ====================


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line argument parser."""
    parser = argparse.ArgumentParser(
        description="Bilibili video data collection tool: fetch video details through public APIs",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s video BV1fecTzKEne
  %(prog)s video "https://www.bilibili.com/video/BV1fecTzKEne/"
  %(prog)s video BV1xxx BV2xxx BV3xxx -o ./output
  %(prog)s up 12345678 --limit 20
  %(prog)s up "https://space.bilibili.com/12345678" -o ./output

  # Subtitle extraction has been moved to the yt-dlp skill:
  # python yt-dlp/scripts/bilibili_download.py URL --subs-only -c SESSDATA
        """,
    )

    subparsers = parser.add_subparsers(dest="command", help="Operation mode")

    # video subcommand.
    video_parser = subparsers.add_parser("video", help="Fetch video details by BV ID/URL")
    video_parser.add_argument(
        "targets", nargs="+",
        help="BV ID or video URL (multiple values supported, separated by spaces)",
    )

    # up subcommand.
    up_parser = subparsers.add_parser("up", help="Fetch all uploaded videos from a creator")
    up_parser.add_argument("target", help="Creator MID or space URL")
    up_parser.add_argument(
        "--limit", "-l", type=int, default=None,
        help="Maximum number of videos to fetch (default: all)",
    )

    # Common arguments.
    for sub in [video_parser, up_parser]:
        sub.add_argument(
            "--output-dir", "-o", default="./bilibili_output",
            help="Output directory (default: ./bilibili_output)",
        )
        sub.add_argument(
            "--cookie",
            default=None,
            help=(
                "Bilibili login Cookie. Supports three formats: "
                "1) plain SESSDATA value; "
                "2) 'SESSDATA=xxx'; "
                '3) JSON object \'{\"SESSDATA\": \"xxx\"}\' '
                "-- after the first pass-in, it is automatically cached to ~/.bilibili_cookies.json, and this parameter can be omitted later"
            ),
        )
        sub.add_argument(
            "--format", "-f", choices=["md", "json", "both"], default="md",
            help="Output format (default: md)",
        )
        sub.add_argument(
            "--no-tags", action="store_true",
            help="Do not fetch video tags (reduces API calls)",
        )

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    # SESSDATA priority: --cookie argument > BILIBILI_SESSDATA environment variable > local cache file.
    # Supported formats: "SESSDATA=xxx", {"SESSDATA": "xxx"} JSON, or plain content string.
    raw_cookie = getattr(args, "cookie", None)
    sessdata_value: Optional[str] = None

    if raw_cookie:
        # The command line supports both JSON objects and plain strings.
        raw_stripped = raw_cookie.strip()
        if raw_stripped.startswith("{"):
            try:
                data = json.loads(raw_stripped)
                sessdata_value = str(data.get("SESSDATA", "")) or None
            except Exception:
                pass
        if not sessdata_value:
            sessdata_value = raw_stripped[len("SESSDATA="):] if raw_stripped.startswith("SESSDATA=") else raw_stripped
        if sessdata_value:
            # After first-time configuration, persist it automatically to the local cache;
            # later calls can omit the --cookie argument.
            _save_sessdata_to_cache(sessdata_value)
    else:
        # Try reading from the environment variable.
        env_val = os.environ.get("BILIBILI_SESSDATA")
        if env_val:
            sessdata_value = env_val
            print("Read login Cookie from the BILIBILI_SESSDATA environment variable")
        else:
            # Load from the local cache (the user configured --cookie previously, so it
            # does not need to be passed every time).
            sessdata_value = _load_sessdata_from_cache()

    # Create the HTTP client.
    # Note: do not inject authentication via headers["Cookie"], because Set-Cookie
    # returned by the warm-up request is automatically merged into httpx's cookie jar,
    # while a headers["Cookie"] string would be overwritten by the jar.
    # The correct approach is to let the jar manage all cookies through httpx's native
    # cookies mechanism.
    client = httpx.Client(
        headers=DEFAULT_HEADERS,
        timeout=15.0,
        follow_redirects=True,
    )

    # Warm up the session: visit the Bilibili homepage first to obtain cookies such as
    # buvid3/buvid4. This must happen before injecting SESSDATA, otherwise Set-Cookie
    # may clear the cookies.
    try:
        print("Initializing session...")
        client.get("https://www.bilibili.com/")
        time.sleep(0.5)
    except Exception:
        pass

    # Inject SESSDATA after warm-up so it is not overwritten by Set-Cookie responses.
    if sessdata_value:
        client.cookies.set("SESSDATA", sessdata_value, domain=".bilibili.com")
        print("Login Cookie (SESSDATA) set")

    try:
        if args.command == "video":
            bv_list = [extract_bvid(t) for t in args.targets]
            print(f"=== Bilibili Video Fetch === Total {len(bv_list)} videos")
            videos = batch_fetch_videos(client, bv_list, include_tags=not args.no_tags)
            title = "Bilibili Video Data"

        elif args.command == "up":
            mid = extract_mid(args.target)
            limit_desc = f"(limited to {args.limit} items)" if args.limit else "(all uploads)"
            print(f"=== Bilibili Creator Upload Fetch === MID: {mid} {limit_desc}")
            print("Fetching upload list...")
            bv_list = fetch_up_video_list(client, mid, limit=args.limit)
            print(f"Found {len(bv_list)} videos. Starting detail fetch...")
            videos = batch_fetch_videos(client, bv_list, include_tags=not args.no_tags)
            up_name = videos[0]["owner"]["name"] if videos else f"Creator {mid}"
            title = f"{up_name} Upload Videos"

        elif args.command == "subtitle":
            print("⚠️  The subtitle subcommand has been moved to the yt-dlp skill")
            print("Please use: python yt-dlp/scripts/bilibili_download.py URL --subs-only -c SESSDATA")
            sys.exit(1)

        else:
            parser.print_help()
            sys.exit(1)

        if not videos:
            print("No video data was fetched")
            sys.exit(1)

        # Output results.
        output_format = args.format
        output_dir = args.output_dir

        if output_format in ("md", "both"):
            filepath = write_markdown(videos, output_dir, title)
            print(f"\n✅ Markdown saved: {filepath}")

        if output_format in ("json", "both"):
            filepath = write_json(videos, output_dir)
            print(f"✅ JSON saved: {filepath}")

        print(f"\nSuccessfully collected {len(videos)} video data items")

    except ValueError as e:
        print(f"❌ Parameter error: {e}", file=sys.stderr)
        sys.exit(1)
    except RuntimeError as e:
        print(f"❌ API error: {e}", file=sys.stderr)
        sys.exit(1)
    except httpx.HTTPError as e:
        print(f"❌ Network error: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        client.close()


if __name__ == "__main__":
    main()
