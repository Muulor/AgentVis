"""
YouTube video data collection script

Fetch video details, channel uploads, and search results through YouTube Data API v3.
Requires an API Key (free to apply for).

Dependency: httpx (included in runtime)
"""

import argparse
import io
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse, parse_qs

# Windows terminal encoding compatibility: force UTF-8 output to avoid charmap errors
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

import httpx

# YouTube Data API v3 endpoint
YT_API_BASE = "https://www.googleapis.com/youtube/v3"

# Persistent API Key cache file — users only need to configure once, then it is reused automatically
YT_CONFIG_CACHE_PATH = Path.home() / ".youtube_config.json"

# Daily quota note: default 10,000 units/day
# videos.list = 1 unit, search.list = 100 units, channels.list = 1 unit
QUOTA_WARNING_THRESHOLD = 50  # Warn about quota consumption when search result count exceeds this value


# ==================== API Key Persistence ====================


def _load_api_key_from_cache() -> Optional[str]:
    """
    Load YouTube API Key from the local cache file.

    Supported formats:
    - JSON object: {"api_key": "AIzaSy..."}
    - Plain string: directly stored key value
    """
    if not YT_CONFIG_CACHE_PATH.exists():
        return None
    try:
        raw = YT_CONFIG_CACHE_PATH.read_text(encoding="utf-8").strip()
        if not raw:
            return None
        if raw.startswith("{"):
            data = json.loads(raw)
            key = data.get("api_key", "")
            if key:
                print(f"[INFO] Loaded API Key from cache: {YT_CONFIG_CACHE_PATH}")
                return str(key)
            return None
        if raw:
            print(f"[INFO] Loaded API Key from cache: {YT_CONFIG_CACHE_PATH}")
            return raw
        return None
    except Exception as exc:
        print(f"[WARN] Failed to read API Key cache: {exc}")
        return None


def _save_api_key_to_cache(api_key: str) -> None:
    """
    Persist API Key to the local cache file in JSON format.

    Store as a JSON object to make it easier to add other configuration fields in the future.
    """
    try:
        existing: dict = {}
        if YT_CONFIG_CACHE_PATH.exists():
            try:
                raw = YT_CONFIG_CACHE_PATH.read_text(encoding="utf-8").strip()
                if raw.startswith("{"):
                    existing = json.loads(raw)
            except Exception:
                pass
        existing["api_key"] = api_key
        YT_CONFIG_CACHE_PATH.write_text(
            json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"[INFO] API Key cached to: {YT_CONFIG_CACHE_PATH}")
    except Exception as exc:
        print(f"[WARN] Failed to save API Key cache: {exc}")


# ==================== URL/ID Parsing ====================


def extract_video_id(raw: str) -> str:
    """
    Extract YouTube video ID from URL or ID.

    Supported formats:
    - dQw4w9WgXcQ
    - https://www.youtube.com/watch?v=dQw4w9WgXcQ
    - https://youtu.be/dQw4w9WgXcQ
    - https://www.youtube.com/embed/dQw4w9WgXcQ
    """
    raw = raw.strip()

    # Full URL format
    if "youtube.com" in raw or "youtu.be" in raw:
        parsed = urlparse(raw)

        # youtube.com/watch?v=xxx
        if "youtube.com" in parsed.hostname and parsed.path == "/watch":
            qs = parse_qs(parsed.query)
            if "v" in qs:
                return qs["v"][0]

        # youtu.be/xxx
        if "youtu.be" in parsed.hostname:
            return parsed.path.lstrip("/").split("/")[0]

        # youtube.com/embed/xxx or youtube.com/v/xxx
        embed_match = re.search(r"/(embed|v)/([A-Za-z0-9_-]{11})", parsed.path)
        if embed_match:
            return embed_match.group(2)

    # Plain ID format (11 alphanumeric characters)
    if re.match(r"^[A-Za-z0-9_-]{11}$", raw):
        return raw

    raise ValueError(f"Unable to parse YouTube video ID from '{raw}'")


def extract_channel_id(raw: str) -> tuple[str, str]:
    """
    Parse channel identifier from URL or ID.

    Returns (id_type, id_value), where id_type is 'id' or 'handle'.

    Supported formats:
    - UCxxxx (channel ID)
    - @channelHandle
    - https://www.youtube.com/channel/UCxxxx
    - https://www.youtube.com/@channelHandle
    """
    raw = raw.strip()

    # URL format
    if "youtube.com" in raw:
        # /channel/UCxxxx
        channel_match = re.search(r"/channel/(UC[A-Za-z0-9_-]+)", raw)
        if channel_match:
            return ("id", channel_match.group(1))

        # /@handle
        handle_match = re.search(r"/@([A-Za-z0-9_.-]+)", raw)
        if handle_match:
            return ("handle", handle_match.group(1))

    # Plain channel ID
    if raw.startswith("UC") and len(raw) == 24:
        return ("id", raw)

    # @ handle
    if raw.startswith("@"):
        return ("handle", raw[1:])

    raise ValueError(
        f"Unable to parse YouTube channel ID from '{raw}'."
        "Please provide a UCxxxx channel ID, @handle, or channel URL"
    )


# ==================== API Calls ====================


def get_api_key(args_key: Optional[str]) -> str:
    """
    Resolve YouTube API Key from multiple sources.

    Priority: --api-key parameter > YOUTUBE_API_KEY environment variable > ~/.youtube_config.json cache.
    After it is passed through the parameter for the first time, it is automatically persisted and --api-key can be omitted later.
    """
    if args_key:
        _save_api_key_to_cache(args_key)
        return args_key

    env_key = os.environ.get("YOUTUBE_API_KEY")
    if env_key:
        return env_key

    cached_key = _load_api_key_from_cache()
    if cached_key:
        return cached_key

    raise ValueError(
        "Missing YouTube API Key. Please pass it through the --api-key parameter "
        "(automatically cached after first configuration, can be omitted later).\n"
        "Application URL: https://console.cloud.google.com/apis/credentials"
    )


def api_get(client: httpx.Client, endpoint: str, params: dict) -> dict:
    """Generic YouTube API GET request."""
    url = f"{YT_API_BASE}/{endpoint}"
    resp = client.get(url, params=params)
    resp.raise_for_status()
    data = resp.json()

    if "error" in data:
        error_msg = data["error"].get("message", "Unknown error")
        error_code = data["error"].get("code", "?")
        raise RuntimeError(f"YouTube API error ({error_code}): {error_msg}")

    return data


def fetch_videos_by_ids(
    client: httpx.Client,
    api_key: str,
    video_ids: list[str],
) -> list[dict]:
    """
    Batch fetch video details (up to 50 at a time).

    Uses videos.list API, consuming 1 quota unit per call.
    """
    results: list[dict] = []
    # videos.list supports at most 50 IDs per call
    batch_size = 50

    for i in range(0, len(video_ids), batch_size):
        batch = video_ids[i : i + batch_size]
        data = api_get(client, "videos", {
            "key": api_key,
            "part": "snippet,statistics,contentDetails",
            "id": ",".join(batch),
        })
        results.extend(data.get("items", []))

    return results


def resolve_channel_id(
    client: httpx.Client,
    api_key: str,
    id_type: str,
    id_value: str,
) -> tuple[str, str]:
    """
    Resolve channel ID and name.

    The handle type requires an additional channels.list API query.
    Returns (channel_id, channel_title).
    """
    if id_type == "id":
        data = api_get(client, "channels", {
            "key": api_key,
            "part": "snippet",
            "id": id_value,
        })
    else:
        data = api_get(client, "channels", {
            "key": api_key,
            "part": "snippet",
            "forHandle": id_value,
        })

    items = data.get("items", [])
    if not items:
        raise RuntimeError(f"Channel not found: {id_value}")

    channel = items[0]
    return channel["id"], channel["snippet"]["title"]


def fetch_channel_videos(
    client: httpx.Client,
    api_key: str,
    channel_id: str,
    max_results: int = 50,
) -> list[str]:
    """
    Fetch the video ID list for a channel.

    Uses search.list API, consuming 100 quota units per call.
    Each call supports up to 50 results, and more are fetched through pagination.
    """
    video_ids: list[str] = []
    page_token: Optional[str] = None
    per_page = min(max_results, 50)

    while len(video_ids) < max_results:
        params = {
            "key": api_key,
            "part": "id",
            "channelId": channel_id,
            "type": "video",
            "order": "date",
            "maxResults": per_page,
        }
        if page_token:
            params["pageToken"] = page_token

        data = api_get(client, "search", params)

        for item in data.get("items", []):
            if item["id"].get("videoId"):
                video_ids.append(item["id"]["videoId"])
                if len(video_ids) >= max_results:
                    break

        page_token = data.get("nextPageToken")
        if not page_token:
            break

    return video_ids


def search_videos(
    client: httpx.Client,
    api_key: str,
    query: str,
    max_results: int = 20,
) -> list[str]:
    """
    Search videos and return a list of video IDs.

    Consumes 100 quota units per call.
    """
    video_ids: list[str] = []
    per_page = min(max_results, 50)

    data = api_get(client, "search", {
        "key": api_key,
        "part": "id",
        "q": query,
        "type": "video",
        "maxResults": per_page,
    })

    for item in data.get("items", []):
        if item["id"].get("videoId"):
            video_ids.append(item["id"]["videoId"])

    return video_ids


# ==================== Data Formatting ====================


def parse_duration(iso_duration: str) -> tuple[str, int]:
    """
    Parse ISO 8601 duration format (PT1H2M3S).

    Returns (readable string, total seconds).
    """
    match = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso_duration)
    if not match:
        return iso_duration, 0

    hours = int(match.group(1) or 0)
    minutes = int(match.group(2) or 0)
    seconds = int(match.group(3) or 0)
    total_seconds = hours * 3600 + minutes * 60 + seconds

    if hours:
        return f"{hours}:{minutes:02d}:{seconds:02d}", total_seconds
    return f"{minutes}:{seconds:02d}", total_seconds


def format_number(n: str | int) -> str:
    """Format a number with thousands separators."""
    return f"{int(n):,}"


def video_to_markdown(item: dict) -> str:
    """Format YouTube API video data as a Markdown fragment."""
    snippet = item["snippet"]
    stats = item.get("statistics", {})
    content = item.get("contentDetails", {})

    duration_str, _ = parse_duration(content.get("duration", ""))
    published = snippet.get("publishedAt", "")[:10]
    tags = snippet.get("tags", [])

    md = f"""## {snippet['title']}

| Field | Value |
|------|-----|
| Video ID | `{item['id']}` |
| Link | https://www.youtube.com/watch?v={item['id']} |
| Channel | {snippet.get('channelTitle', 'Unknown')} |
| Publish Time | {published} |
| Duration | {duration_str} |
| Views | {format_number(stats.get('viewCount', 0))} |
| Likes | {format_number(stats.get('likeCount', 0))} |
| Comments | {format_number(stats.get('commentCount', 0))} |

"""
    desc = snippet.get("description", "").strip()
    if desc:
        # Truncate overly long descriptions
        if len(desc) > 500:
            desc = desc[:500] + "..."
        md += f"**Description**: {desc}\n\n"

    if tags:
        md += f"**Tags**: {' · '.join(tags[:15])}\n\n"

    md += "---\n\n"
    return md


def video_to_dict(item: dict) -> dict:
    """Extract video data into a flattened dictionary (for JSON output)."""
    snippet = item["snippet"]
    stats = item.get("statistics", {})
    content = item.get("contentDetails", {})
    duration_str, duration_seconds = parse_duration(content.get("duration", ""))

    return {
        "video_id": item["id"],
        "title": snippet["title"],
        "url": f"https://www.youtube.com/watch?v={item['id']}",
        "channel_title": snippet.get("channelTitle", ""),
        "channel_id": snippet.get("channelId", ""),
        "published_at": snippet.get("publishedAt", ""),
        "duration": duration_str,
        "duration_seconds": duration_seconds,
        "description": snippet.get("description", ""),
        "views": int(stats.get("viewCount", 0)),
        "likes": int(stats.get("likeCount", 0)),
        "comments": int(stats.get("commentCount", 0)),
        "tags": snippet.get("tags", []),
        "thumbnail": snippet.get("thumbnails", {}).get("high", {}).get("url", ""),
    }


# ==================== Output ====================


def write_markdown(videos: list[dict], output_path: str, title: str) -> str:
    """Output the video list to a Markdown file."""
    content = f"# {title}\n\n"
    content += f"> Total {len(videos)} videos · Collection time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n---\n\n"

    for item in videos:
        content += video_to_markdown(item)

    filepath = os.path.join(output_path, "youtube_videos.md")
    os.makedirs(output_path, exist_ok=True)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)

    return filepath


def write_json(videos: list[dict], output_path: str) -> str:
    """Output the video list to a JSON file."""
    records = [video_to_dict(v) for v in videos]
    filepath = os.path.join(output_path, "youtube_videos.json")
    os.makedirs(output_path, exist_ok=True)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)

    return filepath


# ==================== CLI ====================


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line argument parser."""
    parser = argparse.ArgumentParser(
        description="YouTube video data collection tool — fetch video details through Data API v3",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s video dQw4w9WgXcQ --api-key YOUR_KEY
  %(prog)s video "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --api-key YOUR_KEY
  %(prog)s channel UCxxxx --api-key YOUR_KEY --limit 30
  %(prog)s channel "@handle" --api-key YOUR_KEY
  %(prog)s search "Python tutorial" --api-key YOUR_KEY --max-results 10

API Key application: https://console.cloud.google.com/apis/credentials
        """,
    )

    parser.add_argument(
        "--api-key", "-k",
        default=None,
        help=(
            "YouTube API Key. "
            "Automatically cached to ~/.youtube_config.json after first input; this parameter can be omitted later. "
            "It can also be set through the YOUTUBE_API_KEY environment variable. "
            "Application URL: https://console.cloud.google.com/apis/credentials"
        ),
    )

    subparsers = parser.add_subparsers(dest="command", help="Operation mode")

    # video subcommand
    video_parser = subparsers.add_parser("video", help="Fetch details by video ID/URL")
    video_parser.add_argument("targets", nargs="+", help="Video ID or URL (supports multiple)")

    # channel subcommand
    ch_parser = subparsers.add_parser("channel", help="Fetch the video list for a channel")
    ch_parser.add_argument("target", help="Channel ID (UCxxxx), @handle, or channel URL")
    ch_parser.add_argument("--limit", "-l", type=int, default=50, help="Maximum number of videos to fetch (default: 50)")

    # search subcommand
    search_parser = subparsers.add_parser("search", help="Search videos")
    search_parser.add_argument("query", help="Search keyword")
    search_parser.add_argument("--max-results", "-m", type=int, default=20, help="Maximum number of results (default: 20)")

    # Common parameters
    for sub in [video_parser, ch_parser, search_parser]:
        sub.add_argument("--output-dir", "-o", default="./youtube_output", help="Output directory (default: ./youtube_output)")
        sub.add_argument("--format", "-f", choices=["md", "json", "both"], default="md", help="Output format (default: md)")

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    api_key = get_api_key(args.api_key)
    client = httpx.Client(timeout=15.0, follow_redirects=True)

    try:
        if args.command == "video":
            video_ids = [extract_video_id(t) for t in args.targets]
            print(f"=== YouTube Video Fetch === Total {len(video_ids)} videos")
            videos = fetch_videos_by_ids(client, api_key, video_ids)
            title = "YouTube Video Data"

        elif args.command == "channel":
            id_type, id_value = extract_channel_id(args.target)
            print(f"=== YouTube Channel Video Fetch ===")

            # Resolve channel ID and name
            channel_id, channel_title = resolve_channel_id(client, api_key, id_type, id_value)
            print(f"Channel: {channel_title} ({channel_id})")

            # Quota reminder: every 50 search results consume 100 units
            estimated_quota = ((args.limit + 49) // 50) * 100 + 1
            print(f"Estimated quota consumption: ~{estimated_quota} units (daily limit 10,000)")

            # Fetch video list
            print(f"Fetching video list (up to {args.limit})...")
            video_ids = fetch_channel_videos(client, api_key, channel_id, max_results=args.limit)
            print(f"Found {len(video_ids)} videos, fetching details...")
            videos = fetch_videos_by_ids(client, api_key, video_ids)
            title = f"{channel_title} Videos"

        elif args.command == "search":
            print(f'=== YouTube Search === Query: "{args.query}"')
            if args.max_results > QUOTA_WARNING_THRESHOLD:
                print(f"⚠️  Searching {args.max_results} items will consume a lot of quota; recommended ≤50")

            video_ids = search_videos(client, api_key, args.query, max_results=args.max_results)
            print(f"Found {len(video_ids)} videos, fetching details...")
            videos = fetch_videos_by_ids(client, api_key, video_ids)
            title = f'YouTube Search: "{args.query}"'

        else:
            parser.print_help()
            sys.exit(1)

        if not videos:
            print("No video data was fetched")
            sys.exit(1)

        # Output results
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
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 403:
            print("❌ API Key is invalid or quota is exhausted. Please check the Key or view quota in Google Cloud Console.", file=sys.stderr)
        else:
            print(f"❌ HTTP error ({e.response.status_code}): {e}", file=sys.stderr)
        sys.exit(1)
    except httpx.HTTPError as e:
        print(f"❌ Network error: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        client.close()


if __name__ == "__main__":
    main()
