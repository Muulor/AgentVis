#!/usr/bin/env python3
"""
Bilibili Video Downloader & Subtitle Extractor

Download script dedicated to Bilibili, integrating two paths:
  1. yutto: video/audio download (bypasses yt-dlp's HTTP 412 anti-scraping limit)
  2. Bilibili API: subtitle extraction + cleaning to Markdown (direct API calls via Wbi signing)

Usage:
    python bilibili_download.py URL [options]       # Download video
    python bilibili_download.py URL --subs-only     # Extract subtitles only

Dependencies: yutto (pip install yutto), httpx (bundled with the runtime)
"""

import argparse
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import time
import random
from pathlib import Path
from typing import Optional
from urllib.parse import urlencode

# Force UTF-8 output on Windows to prevent mojibake in non-ASCII titles.
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


# ==================== Constants ====================

# Cookie persistence cache file shared with the video-data-collector skill.
# After the user configures it once in either skill, both skills can reuse it automatically.
BILIBILI_COOKIE_CACHE_PATH = Path.home() / ".bilibili_cookies.json"

# Bilibili quality-level mapping.
QUALITY_MAP = {
    127: "8K Ultra HD", 126: "Dolby Vision", 125: "4K HDR10", 120: "4K Ultra HD",
    116: "1080P 60fps", 112: "1080P High Bitrate", 100: "Smart Restoration", 80: "1080P HD",
    74: "720P 60fps", 64: "720P HD", 32: "480P SD", 16: "360P Smooth",
}

# Bilibili API endpoints.
_BILIBILI_VIDEO_API = "https://api.bilibili.com/x/web-interface/view"
_BILIBILI_NAV_API = "https://api.bilibili.com/x/web-interface/nav"
_BILIBILI_PLAYER_API = "https://api.bilibili.com/x/player/wbi/v2"

# Default request headers.
_DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.bilibili.com/",
    "Origin": "https://www.bilibili.com",
}

# Obfuscation mapping table for Wbi signatures (fixed by Bilibili).
_WBI_MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]


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
        if raw.startswith("{"):
            data = json.loads(raw)
            sessdata = data.get("SESSDATA", "")
            if sessdata:
                print(f"[INFO] Loaded Cookie from cache: {BILIBILI_COOKIE_CACHE_PATH}")
                return str(sessdata)
            return None
        # Plain string format.
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

    Store it as a JSON object so other Cookie fields (such as bili_jct) can be
    added later.
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


# ==================== BV ID Parsing ====================


def extract_bvid(raw: str) -> str:
    """
    Extract the BV ID from a URL or BV ID.

    Supported formats:
    - BV1fecTzKEne
    - https://www.bilibili.com/video/BV1fecTzKEne/
    - https://www.bilibili.com/video/BV1fecTzKEne/?vd_source=xxx
    """
    # Plain BV ID format.
    bv_match = re.match(r"^(BV[A-Za-z0-9]+)$", raw.strip())
    if bv_match:
        return bv_match.group(1)

    # Extract the BV ID from a URL.
    url_match = re.search(r"/video/(BV[A-Za-z0-9]+)", raw)
    if url_match:
        return url_match.group(1)

    raise ValueError(f"Unable to parse a BV ID from '{raw}'. Please provide a valid BV ID or Bilibili video URL")


# ==================== Wbi Signature System ====================
# Newer Bilibili APIs (such as player/wbi/v2) require Wbi signatures.


_cached_mixin_key: str | None = None


def _get_mixin_key(raw_key: str) -> str:
    """Generate the mixin key through the obfuscation mapping table and take the first 32 characters."""
    return "".join(raw_key[i] for i in _WBI_MIXIN_KEY_ENC_TAB)[:32]


def _fetch_wbi_keys(client) -> tuple[str, str]:
    """
    Fetch the img_key and sub_key required for Wbi signatures.

    Extract them from the wbi_img field of the /x/web-interface/nav endpoint.
    These two keys rotate periodically, so they need to be fetched at the start
    of each session.
    """
    resp = client.get(_BILIBILI_NAV_API)
    resp.raise_for_status()
    data = resp.json()["data"]
    wbi_img = data["wbi_img"]
    # img_url / sub_url format example: https://i0.hdslb.com/bfs/wbi/xxxxx.png
    img_key = wbi_img["img_url"].rsplit("/", 1)[-1].split(".")[0]
    sub_key = wbi_img["sub_url"].rsplit("/", 1)[-1].split(".")[0]
    return img_key, sub_key


def _get_wbi_mixin_key(client) -> str:
    """Get the currently valid Wbi mixin key (cached; fetched only once during the script run)."""
    global _cached_mixin_key
    if _cached_mixin_key is None:
        img_key, sub_key = _fetch_wbi_keys(client)
        _cached_mixin_key = _get_mixin_key(img_key + sub_key)
    return _cached_mixin_key


def _sign_wbi_params(params: dict, mixin_key: str) -> dict:
    """
    Sign request parameters with Wbi.

    Steps: add wts -> sort by key -> filter special characters -> MD5 signature -> append w_rid
    """
    params["wts"] = int(time.time())
    sorted_params = dict(sorted(params.items()))
    filtered = {
        k: "".join(c for c in str(v) if c not in "!'()*")
        for k, v in sorted_params.items()
    }
    query_str = urlencode(filtered)
    w_rid = hashlib.md5((query_str + mixin_key).encode()).hexdigest()
    filtered["w_rid"] = w_rid
    return filtered


# ==================== Bilibili API Calls ====================


def _fetch_video_info(client, bvid: str) -> dict:
    """Fetch detailed information for a single video (title, aid, cid, etc.)."""
    resp = client.get(_BILIBILI_VIDEO_API, params={"bvid": bvid})
    resp.raise_for_status()
    data = resp.json()
    if data["code"] != 0:
        raise RuntimeError(
            f"Bilibili API returned an error (BV: {bvid}): code={data['code']}, "
            f"message={data.get('message', 'Unknown error')}"
        )
    return data["data"]


def _fetch_subtitle_list(client, aid: int, cid: int, bvid: str) -> list[dict]:
    """
    Fetch the video's subtitle list (including AI subtitles and creator-uploaded subtitles).

    Calls the /x/player/wbi/v2 API and requires a SESSDATA Cookie.
    """
    try:
        resp = client.get(
            _BILIBILI_PLAYER_API,
            params={"aid": aid, "cid": cid, "bvid": bvid},
        )
        resp.raise_for_status()
        data = resp.json()
        if data["code"] == 0:
            return data.get("data", {}).get("subtitle", {}).get("subtitles", [])
    except Exception as e:
        print(f"  Failed to fetch subtitle list: {e}")
    return []


def _download_and_clean_subtitle(
    client,
    subtitle_info: dict,
    video_title: str,
    video_url: str,
    output_dir: str,
    bvid: str,
) -> Optional[str]:
    """
    Download Bilibili JSON subtitles and clean them into readable Markdown plain text.

    Cleaning strategy: extract plain text -> remove consecutive duplicates ->
    merge into coherent paragraphs -> segment by punctuation.
    """
    url = subtitle_info.get("subtitle_url", "")
    if not url:
        return None
    # Bilibili subtitle URLs may start with //.
    if url.startswith("//"):
        url = "https:" + url

    lan = subtitle_info.get("lan", "unknown")
    lan_doc = subtitle_info.get("lan_doc", lan)

    try:
        resp = client.get(url)
        resp.raise_for_status()
        sub_data = resp.json()
    except Exception as e:
        print(f"    Failed to download subtitle [{lan_doc}]: {e}")
        return None

    body = sub_data.get("body", [])
    if not body:
        print(f"    [{lan_doc}] Subtitle is empty")
        return None

    # Extract plain text and deduplicate.
    text_lines: list[str] = []
    for item in body:
        content = item.get("content", "").strip()
        if not content:
            continue
        # Remove consecutive duplicate lines.
        if text_lines and text_lines[-1] == content:
            continue
        text_lines.append(content)

    # Merge into coherent paragraph text and segment by punctuation for readability.
    full_text = " ".join(text_lines)
    full_text = re.sub(r"([。！？\.!?])\s*", r"\1\n\n", full_text)
    full_text = re.sub(r"\n{3,}", "\n\n", full_text).strip()

    # Assemble Markdown output.
    md = f"# {video_title}\n\n"
    md += f"> Source: {video_url}\n"
    md += f"> Subtitle language: {lan_doc}\n\n"
    md += full_text + "\n"

    # Save file.
    os.makedirs(output_dir, exist_ok=True)
    safe_title = re.sub(r'[<>:"/\\|?*]', '_', video_title)
    filename = f"{safe_title} [{bvid}].{lan}.md"
    filepath = os.path.join(output_dir, filename)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(md)

    return filepath


# ==================== Subtitle Extraction Mode ====================


def run_subtitle_extraction(args: argparse.Namespace) -> int:
    """
    Extract subtitles directly through the Bilibili API (without downloading video).

    Faster than yutto --subtitle-only because it does not need the full video
    parsing flow.
    """
    import httpx

    bvid = extract_bvid(args.url)
    output_dir = os.path.abspath(args.output_dir)

    print("=" * 60)
    print("Bilibili Subtitle Extraction (direct API)")
    print("=" * 60)
    print(f"  BV ID: {bvid}")
    print(f"  Output: {output_dir}")

    sessdata = args.sessdata
    if sessdata:
        masked = sessdata[:8] + "..." if len(sessdata) > 8 else sessdata
        print(f"  Auth: SESSDATA={masked}")
    else:
        print("  ⚠️  SESSDATA was not provided. Bilibili subtitles usually require login state")
        print("     Tip: -c 'YOUR_SESSDATA' (cached automatically after configuration; can be omitted later)")
    print("-" * 60)

    # Create the HTTP client.
    client = httpx.Client(
        headers=_DEFAULT_HEADERS.copy(),
        timeout=15.0,
        follow_redirects=True,
    )

    # Warm up the session: visit the Bilibili homepage first to obtain cookies such
    # as buvid3/buvid4. This must happen before injecting SESSDATA, otherwise
    # Set-Cookie responses may overwrite manually set cookies.
    print("Initializing session...")
    try:
        client.get("https://www.bilibili.com/")
        time.sleep(0.5)
    except Exception:
        pass

    # Inject SESSDATA after warm-up to ensure it is not overwritten by Set-Cookie responses.
    if sessdata:
        client.cookies.set("SESSDATA", sessdata, domain=".bilibili.com")

    try:
        # Fetch basic video information.
        video_info = _fetch_video_info(client, bvid)
        aid = video_info["aid"]
        cid = video_info["cid"]
        video_title = video_info["title"]
        video_url = f"https://www.bilibili.com/video/{bvid}/"
        print(f"  Title: {video_title}")

        # Fetch subtitle list.
        subs = _fetch_subtitle_list(client, aid, cid, bvid)
        if not subs:
            print("\n  ⚠️  No subtitles found (a login Cookie may be required, or this video has no subtitles)")
            return 1

        print(f"  Found {len(subs)} subtitles:")
        success_count = 0
        for sub in subs:
            lan_doc = sub.get("lan_doc", sub.get("lan", "?"))
            print(f"    - {lan_doc}")
            filepath = _download_and_clean_subtitle(
                client, sub, video_title, video_url, output_dir, bvid
            )
            if filepath:
                print(f"      ✅ Saved: {os.path.basename(filepath)}")
                success_count += 1

        print("\n" + "=" * 60)
        print(f"  [OK] Successfully extracted {success_count} subtitle files")
        print(f"  Output: {output_dir}")
        print("=" * 60)
        return 0

    except ValueError as e:
        print(f"\n  [FAIL] Parameter error: {e}")
        return 1
    except RuntimeError as e:
        print(f"\n  [FAIL] API error: {e}")
        return 1
    except Exception as e:
        print(f"\n  [FAIL] Error: {e}")
        return 1
    finally:
        client.close()


# ==================== Video Download Mode (yutto) ====================


def build_yutto_command(args: argparse.Namespace) -> list[str]:
    """Build the yutto CLI command list from parsed arguments."""
    cmd = [sys.executable, "-m", "yutto", args.url]

    # Authentication: SESSDATA.
    if args.sessdata:
        cmd.extend(["-c", args.sessdata])

    # Output directory.
    output_dir = os.path.abspath(args.output_dir)
    os.makedirs(output_dir, exist_ok=True)
    cmd.extend(["-d", output_dir])

    # Video quality.
    if args.quality:
        cmd.extend(["-q", str(args.quality)])

    # Video codec.
    if args.vcodec:
        cmd.extend(["--vcodec", args.vcodec])

    # Number of parallel workers.
    if args.num_workers:
        cmd.extend(["-n", str(args.num_workers)])

    # Proxy.
    if args.proxy:
        cmd.extend(["-x", args.proxy])

    # Output format.
    if args.output_format:
        cmd.extend(["--output-format", args.output_format])

    # Resource selection parameters.
    if args.audio_only:
        cmd.append("--audio-only")
    if args.danmaku_only:
        cmd.append("--danmaku-only")
    if args.cover_only:
        cmd.append("--cover-only")

    # Resource exclusion parameters.
    if args.no_danmaku:
        cmd.append("--no-danmaku")
    if args.no_subtitle:
        cmd.append("--no-subtitle")
    if args.no_cover:
        cmd.append("--no-cover")

    # Danmaku format.
    if args.danmaku_format:
        cmd.extend(["-df", args.danmaku_format])

    # Batch download.
    if args.batch:
        cmd.append("--batch")
    if args.episodes:
        cmd.extend(["-p", args.episodes])

    # Overwrite downloaded files.
    if args.overwrite:
        cmd.append("--overwrite")

    # Do not display progress bars (suitable for non-interactive environments and agent calls).
    cmd.append("--no-progress")

    return cmd


def run_yutto_download(args: argparse.Namespace) -> int:
    """Download video through the yutto CLI and stream logs in real time."""
    cmd = build_yutto_command(args)

    print("=" * 60)
    print("Bilibili Video Download (yutto)")
    print("=" * 60)
    print(f"  URL: {args.url}")
    print(f"  Output: {os.path.abspath(args.output_dir)}")

    if args.quality:
        quality_name = QUALITY_MAP.get(args.quality, "Unknown")
        print(f"  Quality: {args.quality} ({quality_name})")

    if args.sessdata:
        masked = args.sessdata[:8] + "..." if len(args.sessdata) > 8 else args.sessdata
        print(f"  Auth: SESSDATA={masked}")

    # Display mode.
    mode_parts = []
    if args.audio_only:
        mode_parts.append("Audio only")
    if args.danmaku_only:
        mode_parts.append("Danmaku only")
    if args.cover_only:
        mode_parts.append("Cover only")
    if args.batch:
        mode_parts.append("Batch download")
    if not mode_parts:
        mode_parts.append("Video + Audio")
    print(f"  Mode: {', '.join(mode_parts)}")

    if args.proxy:
        print(f"  Proxy: {args.proxy}")
    if args.vcodec:
        print(f"  Video codec: {args.vcodec}")
    if args.episodes:
        print(f"  Episodes: {args.episodes}")
    print("-" * 60)

    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"

    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=env,
            encoding="utf-8",
            errors="replace",
        )

        for line in process.stdout:
            print(line, end="")

        process.wait()
        exit_code = process.returncode

        print("\n" + "=" * 60)
        if exit_code == 0:
            print("  [OK] Download complete!")
            print(f"  Output: {os.path.abspath(args.output_dir)}")
        else:
            print(f"  [FAIL] Download failed (exit code: {exit_code})")
        print("=" * 60)
        return exit_code

    except FileNotFoundError:
        print("[ERROR] yutto is not installed. Please run: pip install yutto")
        return 1
    except KeyboardInterrupt:
        print("\n[INFO] Download cancelled")
        return 130


# ==================== CLI ====================


def main():
    parser = argparse.ArgumentParser(
        description="Bilibili video download and subtitle extraction (yutto + Bilibili API)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Download video
  %(prog)s "https://www.bilibili.com/video/BV1xxx" -c "SESSDATA"
  %(prog)s "BV1xxx" -c "SESSDATA" -q 80

  # Extract subtitles (through Bilibili API, without downloading video, faster)
  %(prog)s "URL" --subs-only -c "SESSDATA"

  # Extract danmaku only
  %(prog)s "URL" --danmaku-only

  # Download audio only
  %(prog)s "URL" --audio-only -c "SESSDATA"

  # Batch download bangumi episodes
  %(prog)s "https://www.bilibili.com/bangumi/play/ep12345" --batch -p 1-5
        """,
    )

    parser.add_argument("url", help="Bilibili video URL or BV/av/ep/ss ID")
    parser.add_argument(
        "--output-dir", "-o",
        default=".",
        help="Output directory (default: current directory)",
    )

    # Authentication parameters.
    auth_group = parser.add_argument_group("authentication")
    auth_group.add_argument(
        "--sessdata", "-c",
        default=None,
        help=(
            "Bilibili SESSDATA (required for premium membership, HD quality, and subtitle extraction)."
            "Supported formats: plain value, 'SESSDATA=xxx', or '{\"SESSDATA\":\"xxx\"}' JSON."
            "After the first pass-in, it is automatically cached to ~/.bilibili_cookies.json and can be omitted later."
        ),
    )

    # Main mode selection.
    mode_group = parser.add_argument_group("mode selection")
    mode_group.add_argument(
        "--subs-only", action="store_true",
        help="Extract subtitles only (directly through Bilibili API, without downloading video)",
    )
    mode_group.add_argument("--audio-only", action="store_true", help="Download audio stream only")
    mode_group.add_argument("--danmaku-only", action="store_true", help="Generate danmaku file only")
    mode_group.add_argument("--cover-only", action="store_true", help="Download cover only")

    # Video parameters.
    video_group = parser.add_argument_group("video options")
    video_group.add_argument(
        "--quality", "-q", type=int, default=None,
        choices=[127, 126, 125, 120, 116, 112, 100, 80, 74, 64, 32, 16],
        help="Video quality level (80=1080P, 120=4K)",
    )
    video_group.add_argument(
        "--vcodec", default=None,
        help='Video codec (for example, "avc:copy", "hevc:copy")',
    )
    video_group.add_argument(
        "--output-format", default=None,
        choices=["infer", "mp4", "mkv", "mov"],
        help="Output format (default: infer, automatically inferred)",
    )

    # Resource exclusion.
    resource_group = parser.add_argument_group("resource filters")
    resource_group.add_argument("--no-danmaku", action="store_true", help="Do not generate danmaku files")
    resource_group.add_argument("--no-subtitle", action="store_true", help="Do not generate subtitle files")
    resource_group.add_argument("--no-cover", action="store_true", help="Do not generate cover")
    resource_group.add_argument(
        "--danmaku-format", "-df", default=None,
        choices=["xml", "ass", "protobuf"],
        help="Danmaku format (default: ass)",
    )

    # Batch download parameters.
    batch_group = parser.add_argument_group("batch download")
    batch_group.add_argument("--batch", "-b", action="store_true", help="Enable batch download")
    batch_group.add_argument(
        "--episodes", "-p", default=None,
        help='Episode range (for example, "1-5", "1,3,5")',
    )

    # Other parameters.
    parser.add_argument("--proxy", "-x", default=None, help='Proxy address')
    parser.add_argument("--num-workers", "-n", type=int, default=None, help="Number of parallel download workers")
    parser.add_argument("--overwrite", "-w", action="store_true", help="Force overwrite downloaded files")

    args = parser.parse_args()

    # SESSDATA priority: -c argument > BILIBILI_SESSDATA environment variable > ~/.bilibili_cookies.json cache.
    # Supported formats: "SESSDATA=xxx", {"SESSDATA": "xxx"} JSON, or plain SESSDATA value.
    raw_sessdata = args.sessdata
    resolved_sessdata: Optional[str] = None

    if raw_sessdata:
        raw_stripped = raw_sessdata.strip()
        # JSON object format.
        if raw_stripped.startswith("{"):
            try:
                data = json.loads(raw_stripped)
                resolved_sessdata = str(data.get("SESSDATA", "")) or None
            except Exception:
                pass
        if not resolved_sessdata:
            # Remove the "SESSDATA=" prefix, also compatible with plain values.
            resolved_sessdata = (
                raw_stripped[len("SESSDATA="):]
                if raw_stripped.startswith("SESSDATA=")
                else raw_stripped
            )
        if resolved_sessdata:
            # After first-time configuration, persist automatically; both skills share
            # the same cache file.
            _save_sessdata_to_cache(resolved_sessdata)
    else:
        env_val = os.environ.get("BILIBILI_SESSDATA")
        if env_val:
            resolved_sessdata = env_val
            print("[INFO] Read login Cookie from the BILIBILI_SESSDATA environment variable")
        else:
            resolved_sessdata = _load_sessdata_from_cache()

    # Write the parsed plain SESSDATA value back to args, so subfunctions can use args.sessdata directly.
    args.sessdata = resolved_sessdata

    # Dispatch by mode.
    if args.subs_only:
        exit_code = run_subtitle_extraction(args)
    else:
        exit_code = run_yutto_download(args)

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
