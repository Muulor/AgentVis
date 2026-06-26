#!/usr/bin/env python3
"""
yt-dlp Video Downloader Script

A wrapper around yt-dlp's Python API for downloading videos and audio
from YouTube, Bilibili, Twitter/X, and 1000+ other websites.

Usage:
    python download.py URL [URL...] [options]

Examples:
    python download.py "https://www.youtube.com/watch?v=..."
    python download.py "https://www.youtube.com/watch?v=..." --audio-only
    python download.py "https://www.youtube.com/watch?v=..." --subs-only --sub-lang zh-Hans
    python download.py "https://www.youtube.com/watch?v=..." --info-only
    python download.py "https://www.youtube.com/watch?v=..." --subtitles --sub-lang "en,zh-Hans"
    python download.py "https://www.youtube.com/watch?v=..." --proxy "http://127.0.0.1:7890"
"""

import argparse
import glob
import io
import json
import os
import re
import sys
import time

# Force UTF-8 output on Windows to handle non-ASCII characters (e.g., Chinese titles)
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

try:
    import yt_dlp
except ImportError:
    print("Error: yt-dlp is not installed. Please install it with:")
    print("  pip install yt-dlp")
    sys.exit(0)


def format_size(bytes_count):
    """Format bytes into human-readable size string."""
    if bytes_count is None:
        return "Unknown"
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if abs(bytes_count) < 1024.0:
            return f"{bytes_count:.1f} {unit}"
        bytes_count /= 1024.0
    return f"{bytes_count:.1f} PB"


def format_duration(seconds):
    """Format seconds into human-readable duration string."""
    if seconds is None:
        return "Unknown"
    seconds = int(seconds)
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours > 0:
        return f"{hours}h {minutes}m {secs}s"
    elif minutes > 0:
        return f"{minutes}m {secs}s"
    else:
        return f"{secs}s"


class DownloadLogger:
    """Custom logger for yt-dlp that provides clean console output."""

    def debug(self, msg):
        if msg.startswith("[debug] "):
            return
        self.info(msg)

    def info(self, msg):
        try:
            print(msg)
        except UnicodeEncodeError:
            print(msg.encode("utf-8", errors="replace").decode("utf-8"))

    def warning(self, msg):
        try:
            print(f"[WARNING] {msg}")
        except UnicodeEncodeError:
            pass

    def error(self, msg):
        try:
            print(f"[ERROR] {msg}")
        except UnicodeEncodeError:
            pass


def create_progress_hook():
    """Create a progress hook that shows download progress."""
    last_update = {"time": 0}

    def hook(d):
        now = time.time()
        if d["status"] == "downloading":
            # Throttle updates to avoid flooding the console
            if now - last_update["time"] < 1.0:
                return
            last_update["time"] = now

            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            downloaded = d.get("downloaded_bytes", 0)
            speed = d.get("speed")
            eta = d.get("eta")

            parts = []
            if total:
                percent = downloaded / total * 100
                parts.append(f"{percent:.1f}%")
                parts.append(f"{format_size(downloaded)}/{format_size(total)}")
            else:
                parts.append(format_size(downloaded))

            if speed:
                parts.append(f"@ {format_size(speed)}/s")
            if eta:
                parts.append(f"ETA: {format_duration(eta)}")

            print(f"\r  Downloading: {' | '.join(parts)}    ", end="", flush=True)

        elif d["status"] == "finished":
            filename = d.get("filename", "unknown")
            print(f"\n  [OK] Download complete: {os.path.basename(filename)}")

    return hook


# ==================== Subtitle Cleaning ====================


def clean_subtitle_to_markdown(srt_path: str, video_title: str = "", video_url: str = "") -> str:
    """
    Clean an SRT/VTT subtitle file into readable Markdown plain text.

    Specifically handles special formats in YouTube automatic subtitles:
    - Per-word timestamp lines (lines containing <c> and <00:00:xx.xxx> tags)
    - Progressive duplicate lines (automatic subtitles repeat previous content on each frame)
    - VTT headers and STYLE blocks
    """
    try:
        with open(srt_path, "r", encoding="utf-8") as f:
            content = f.read()
    except UnicodeDecodeError:
        with open(srt_path, "r", encoding="latin-1") as f:
            content = f.read()

    lines = content.split("\n")
    text_lines: list[str] = []

    # SRT index lines (pure numbers).
    srt_index_pattern = re.compile(r"^\d+\s*$")
    # SRT timecode lines: 00:00:01,000 --> 00:00:03,000
    srt_time_pattern = re.compile(r"^\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->")
    # VTT timecode lines: 00:00.000 --> 00:03.000, or with position/align tags.
    vtt_time_pattern = re.compile(r"^[\d:.]+\s*-->")
    # Signature of YouTube automatic subtitle per-word timestamp lines: includes
    # <c> tags and embedded timestamps <00:00:xx>.
    # Example: AI<00:00:25.439><c> assistant</c><00:00:26.080><c> that</c>
    youtube_cue_pattern = re.compile(r"<\d{2}:\d{2}[:\.]\d{2,3}[.\d]*>")
    # All tag types (HTML + VTT cue tags).
    tag_pattern = re.compile(r"<[^>]+>")
    # VTT header keywords.
    vtt_header_keywords = {"WEBVTT", "Kind:", "Language:", "STYLE", "NOTE"}

    in_style_block = False
    for line in lines:
        stripped = line.strip()

        # Skip empty lines.
        if not stripped:
            in_style_block = False
            continue

        # Skip VTT STYLE blocks.
        if stripped == "STYLE":
            in_style_block = True
            continue
        if in_style_block:
            continue

        # Skip VTT headers.
        if any(stripped.startswith(kw) for kw in vtt_header_keywords):
            continue

        # Skip SRT index lines.
        if srt_index_pattern.match(stripped):
            continue

        # Skip timecode lines.
        if srt_time_pattern.match(stripped) or vtt_time_pattern.match(stripped):
            continue

        # Key signature of YouTube automatic subtitles: per-word timestamp lines.
        # These lines include embedded timestamps in the <00:00:xx.xxx><c> word</c> format.
        # They are redundant (the previous line already has a plain-text version), so skip them.
        if youtube_cue_pattern.search(stripped):
            continue

        # Remove all remaining tags.
        cleaned = tag_pattern.sub("", stripped).strip()
        if not cleaned:
            continue

        # Remove consecutive duplicates and progressive duplicates (common in automatic subtitles).
        # Automatic subtitles often have progressive overlap: "Hello" -> "Hello world" -> "Hello world foo".
        if text_lines:
            prev = text_lines[-1]
            # Exact duplicate.
            if prev == cleaned:
                continue
            # Current line is fully contained in the previous line (substring of the previous line).
            if cleaned in prev:
                continue
            # Previous line is fully contained in the current line (current line is the expanded version), replace it.
            if prev in cleaned:
                text_lines[-1] = cleaned
                continue

        text_lines.append(cleaned)

    # Merge into continuous paragraph text.
    full_text = " ".join(text_lines)
    # Segment by period/question mark/exclamation mark, with blank lines for readability.
    # Handles both Chinese and English punctuation.
    full_text = re.sub(r"([。！？\.!?])\s*", r"\1\n\n", full_text)
    # Clean extra blank lines.
    full_text = re.sub(r"\n{3,}", "\n\n", full_text).strip()

    # Assemble Markdown.
    md = ""
    if video_title:
        md += f"# {video_title}\n\n"
    if video_url:
        md += f"> Source: {video_url}\n\n"
    md += full_text + "\n"

    return md


def find_subtitle_files(output_dir: str, video_id: str) -> list[str]:
    """
    Find downloaded subtitle files.

    Subtitle filename format generated by yt-dlp: Title [video_id].lang.ext
    """
    patterns = [
        os.path.join(output_dir, f"*{video_id}*.srt"),
        os.path.join(output_dir, f"*{video_id}*.vtt"),
        os.path.join(output_dir, f"*{video_id}*.ass"),
    ]
    found: list[str] = []
    for pattern in patterns:
        found.extend(glob.glob(pattern))
    return sorted(found)


def extract_info_to_markdown(info: dict, output_dir: str) -> str:
    """
    Extract video metadata into a Markdown file.

    Outputs key fields: title, channel, publish time, duration, description, tags, and more.
    """
    title = info.get("title", "Unknown")
    video_id = info.get("id", "unknown")

    md = f"# {title}\n\n"
    md += "| Field | Value |\n|------|-----|\n"
    md += f"| Link | {info.get('webpage_url', '')} |\n"
    md += f"| Channel | {info.get('uploader', '')} |\n"
    md += f"| Published At | {info.get('upload_date', '')} |\n"
    md += f"| Duration | {format_duration(info.get('duration'))} |\n"
    md += f"| Views | {info.get('view_count', 'N/A'):,} |\n" if info.get('view_count') else ""
    md += f"| Likes | {info.get('like_count', 'N/A'):,} |\n" if info.get('like_count') else ""
    md += f"| Comments | {info.get('comment_count', 'N/A'):,} |\n" if info.get('comment_count') else ""
    md += "\n"

    desc = info.get("description", "").strip()
    if desc:
        md += f"## Description\n\n{desc}\n\n"

    tags = info.get("tags", [])
    if tags:
        md += f"## Tags\n\n{' · '.join(tags)}\n\n"

    # Only clean illegal characters in the filename; do not break directory separators.
    safe_title = re.sub(r'[<>:"/\\|?*]', '_', title)
    filename = f"{safe_title} [{video_id}].info.md"
    filepath = os.path.join(output_dir, filename)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(md)

    return filepath


# ==================== yt-dlp Option Building ====================


def build_ydl_opts(args):
    """Build yt-dlp options dict from parsed arguments."""
    opts = {
        "logger": DownloadLogger(),
        "progress_hooks": [create_progress_hook()],
        "noplaylist": not args.playlist,
        "restrictfilenames": False,
        "windowsfilenames": True,
    }

    # Output directory and filename template
    output_dir = os.path.abspath(args.output_dir)
    os.makedirs(output_dir, exist_ok=True)
    opts["paths"] = {"home": output_dir}
    opts["outtmpl"] = {"default": "%(title)s [%(id)s].%(ext)s"}

    # Subtitle extraction mode: download subtitles only, not video.
    subs_only = getattr(args, "subs_only", False)
    info_only = getattr(args, "info_only", False)

    if subs_only:
        opts["skip_download"] = True
        opts["writesubtitles"] = True
        opts["writeautomaticsub"] = True
        if args.sub_lang:
            opts["subtitleslangs"] = args.sub_lang.split(",")
        else:
            opts["subtitleslangs"] = ["en", "zh-Hans", "zh-Hant"]
        # Do not use FFmpegSubtitlesConvertor because ffmpeg may not be installed.
        # Subtitle cleaning is done in Python, directly processing raw VTT/SRT formats.
        return opts, output_dir

    if info_only:
        opts["skip_download"] = True
        opts["writeinfojson"] = True
        return opts, output_dir

    # Format selection
    if args.audio_only:
        opts["format"] = "bestaudio/best"
        opts["postprocessors"] = [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ]
    elif args.format:
        opts["format"] = args.format
    else:
        opts["format"] = "bestvideo+bestaudio/best"
        opts["merge_output_format"] = "mp4"

    # Subtitles (downloaded together with the video).
    if args.subtitles:
        opts["writesubtitles"] = True
        opts["writeautomaticsub"] = True
        if args.sub_lang:
            opts["subtitleslangs"] = args.sub_lang.split(",")
        else:
            opts["subtitleslangs"] = ["en", "zh-Hans", "zh-Hant"]
        # Subtitle format conversion.
        convert_fmt = getattr(args, "convert_subs", None)
        if convert_fmt:
            if "postprocessors" not in opts:
                opts["postprocessors"] = []
            opts["postprocessors"].append(
                {"key": "FFmpegSubtitlesConvertor", "format": convert_fmt}
            )

    # Cookies from browser
    if args.cookies_from:
        opts["cookiesfrombrowser"] = (args.cookies_from,)

    # Proxy
    if args.proxy:
        opts["proxy"] = args.proxy

    # Rate limit
    if args.rate_limit:
        opts["ratelimit"] = _parse_rate_limit(args.rate_limit)

    # Embed metadata and thumbnail
    if args.embed_metadata:
        if "postprocessors" not in opts:
            opts["postprocessors"] = []
        opts["postprocessors"].append({"key": "FFmpegMetadata"})
        opts["postprocessors"].append({"key": "EmbedThumbnail"})
        opts["writethumbnail"] = True

    # Write thumbnail as separate file
    if args.write_thumbnail:
        opts["writethumbnail"] = True

    # Playlist items range
    if args.playlist_items:
        opts["playlist_items"] = args.playlist_items

    # Multi-threaded fragment download (significantly faster for HLS/DASH scenarios).
    concurrent_fragments = getattr(args, "concurrent_fragments", None)
    if concurrent_fragments:
        opts["concurrent_fragment_downloads"] = concurrent_fragments

    # Video section download (requires ffmpeg; supports timestamps such as
    # "*10:15-15:00" and chapter-name matching).
    download_sections = getattr(args, "download_sections", None)
    if download_sections:
        # download_range_func accepts chapters (regex list) and ranges ([(start_sec, end_sec), ...]).
        sections_list = [download_sections]  # Convert a single value to a list, aligned with CLI action='append'.
        chapters, ranges = [], []
        for section in sections_list:
            if section.startswith("*"):
                # Time-range mode: parse "*START-END" format.
                parsed = _parse_time_range(section[1:])
                if parsed:
                    ranges.append(parsed)
            else:
                # Chapter-name regex matching mode.
                chapters.append(re.compile(section))
        opts["download_ranges"] = yt_dlp.utils.download_range_func(
            chapters or None, ranges or None
        )
        opts["force_keyframes_at_cuts"] = True

    # cookies.txt file support (recommended for platforms such as Bilibili that require login).
    cookies_file = getattr(args, "cookies", None)
    if cookies_file:
        opts["cookiefile"] = cookies_file

    return opts, output_dir


def _parse_time_range(time_spec: str) -> list[float] | None:
    """
    Parse a "START-END" time-range string into [start_seconds, end_seconds].

    Supported formats:
    - "10:15-15:00" -> [615.0, 900.0]
    - "0:30-inf"    -> [30.0, inf]
    - "1:00:00-"    -> [3600.0, inf]  (omitted end defaults to inf)
    - "-5:00"       -> [0.0, 300.0]  (omitted start defaults to 0)
    """
    from yt_dlp.utils import parse_duration

    # Split START and END (hyphens cannot simply be split with split('-'); use regex).
    # Format: optional start part, then '-', then optional end part.
    match = re.match(
        r'^(?P<start>[\d:.]*)\s*-\s*(?P<end>[\d:.]*|inf|infinite)$',
        time_spec.strip()
    )
    if not match:
        return None

    start_str = match.group("start").strip()
    end_str = match.group("end").strip()

    # Parse start time.
    if not start_str:
        start_sec = 0.0
    else:
        start_sec = parse_duration(start_str)
        if start_sec is None:
            return None

    # Parse end time.
    if not end_str or end_str in ("inf", "infinite"):
        end_sec = float("inf")
    else:
        end_sec = parse_duration(end_str)
        if end_sec is None:
            return None

    return [start_sec, end_sec]


def _parse_rate_limit(rate_str):
    """Parse rate limit string like '1M', '500K' into bytes/second."""
    rate_str = rate_str.strip().upper()
    multipliers = {"K": 1024, "M": 1024 * 1024, "G": 1024 * 1024 * 1024}
    if rate_str[-1] in multipliers:
        return int(float(rate_str[:-1]) * multipliers[rate_str[-1]])
    return int(rate_str)


def download_videos(urls, args):
    """Download videos and return results summary."""
    opts, output_dir = build_ydl_opts(args)
    results = []
    subs_only = getattr(args, "subs_only", False)
    info_only = getattr(args, "info_only", False)

    print("=" * 60)
    if subs_only:
        print("yt-dlp Subtitle Extractor")
    elif info_only:
        print("yt-dlp Info Extractor")
    else:
        print("yt-dlp Video Downloader")
    print("=" * 60)
    print(f"  URLs: {len(urls)}")
    print(f"  Output: {output_dir}")
    if subs_only:
        lang = args.sub_lang or "en,zh-Hans,zh-Hant"
        print(f"  Mode: Subtitles only")
        print(f"  Languages: {lang}")
    elif info_only:
        print("  Mode: Info extraction only")
    elif args.audio_only:
        print("  Mode: Audio only (MP3)")
    elif args.format:
        print(f"  Format: {args.format}")
    else:
        print("  Format: Best quality (MP4)")
    if not subs_only and not info_only and args.subtitles:
        lang = args.sub_lang or "en,zh-Hans,zh-Hant"
        print(f"  Subtitles: {lang}")
    if args.proxy:
        print(f"  Proxy: {args.proxy}")
    if args.rate_limit:
        print(f"  Rate limit: {args.rate_limit}")
    if args.embed_metadata:
        print("  Embed: metadata + thumbnail")
    if args.playlist_items:
        print(f"  Playlist items: {args.playlist_items}")
    concurrent_fragments = getattr(args, "concurrent_fragments", None)
    if concurrent_fragments:
        print(f"  Concurrent fragments: {concurrent_fragments}")
    download_sections = getattr(args, "download_sections", None)
    if download_sections:
        print(f"  Download sections: {download_sections}")
    cookies_file = getattr(args, "cookies", None)
    if cookies_file:
        print(f"  Cookies file: {cookies_file}")
    print("-" * 60)

    with yt_dlp.YoutubeDL(opts) as ydl:
        for i, url in enumerate(urls, 1):
            print(f"\n[{i}/{len(urls)}] Processing: {url}")
            try:
                # Extract info and download
                info = ydl.extract_info(url, download=True)

                if info is None:
                    results.append(
                        {"url": url, "success": False, "error": "No info returned"}
                    )
                    continue

                # Process each video in the playlist.
                entries = [info]
                if "_type" in info and info["_type"] == "playlist":
                    entries = [e for e in info.get("entries", []) if e]

                for entry in entries:
                    video_id = entry.get("id", "unknown")
                    video_title = entry.get("title", "Unknown")
                    video_url = entry.get("webpage_url", url)

                    result = {
                        "url": video_url,
                        "success": True,
                        "title": video_title,
                        "duration": entry.get("duration"),
                        "filesize": entry.get("filesize") or entry.get("filesize_approx"),
                        "uploader": entry.get("uploader"),
                    }

                    # Subtitle extraction mode: clean subtitles and output Markdown.
                    if subs_only:
                        sub_files = find_subtitle_files(output_dir, video_id)
                        if sub_files:
                            for sub_file in sub_files:
                                md_content = clean_subtitle_to_markdown(
                                    sub_file, video_title, video_url
                                )
                                # Extract the language code from the subtitle filename.
                                base = os.path.basename(sub_file)
                                lang_code = base.rsplit(".", 2)[-2] if base.count(".") >= 2 else "unknown"
                                md_filename = f"{video_title} [{video_id}].{lang_code}.md"
                                md_filename = re.sub(r'[<>:"/\\|?*]', '_', md_filename)
                                md_path = os.path.join(output_dir, md_filename)
                                with open(md_path, "w", encoding="utf-8") as f:
                                    f.write(md_content)
                                print(f"  [OK] Subtitle cleaned: {md_filename}")
                            result["subtitle_files"] = [os.path.basename(f) for f in sub_files]
                        else:
                            print(f"  [WARN] No subtitle files found for {video_id}")
                            result["subtitle_files"] = []

                    # Metadata extraction mode: output Markdown summary.
                    if info_only:
                        md_path = extract_info_to_markdown(entry, output_dir)
                        print(f"  [OK] Info saved: {os.path.basename(md_path)}")
                        result["info_file"] = os.path.basename(md_path)

                    results.append(result)

            except yt_dlp.utils.DownloadError as e:
                error_msg = str(e)
                print(f"  [WARN] Download error: {error_msg}")

                # In subtitle mode, failures for some languages (such as 429 rate limits)
                # should not block cleaning subtitles that were already downloaded.
                # yt-dlp may have successfully downloaded some languages before raising an error.
                if subs_only:
                    # Try to get video_id from the info dict (if extract_info returned partial
                    # info before throwing).
                    try:
                        partial_info = ydl.extract_info(url, download=False)
                        video_id = partial_info.get("id", "unknown") if partial_info else "unknown"
                        video_title = partial_info.get("title", "Unknown") if partial_info else "Unknown"
                        video_url_resolved = partial_info.get("webpage_url", url) if partial_info else url
                    except Exception:
                        video_id = "unknown"
                        video_title = "Unknown"
                        video_url_resolved = url

                    sub_files = find_subtitle_files(output_dir, video_id)
                    if sub_files:
                        print(f"  [INFO] Found {len(sub_files)} subtitle file(s) despite error, cleaning...")
                        result = {
                            "url": url,
                            "success": True,
                            "title": video_title,
                            "uploader": "",
                            "warning": error_msg,
                        }
                        for sub_file in sub_files:
                            md_content = clean_subtitle_to_markdown(
                                sub_file, video_title, video_url_resolved
                            )
                            base = os.path.basename(sub_file)
                            lang_code = base.rsplit(".", 2)[-2] if base.count(".") >= 2 else "unknown"
                            safe_title = re.sub(r'[<>:"/\\|?*]', '_', video_title)
                            md_filename = f"{safe_title} [{video_id}].{lang_code}.md"
                            md_path = os.path.join(output_dir, md_filename)
                            with open(md_path, "w", encoding="utf-8") as f:
                                f.write(md_content)
                            print(f"  [OK] Subtitle cleaned: {md_filename}")
                        result["subtitle_files"] = [os.path.basename(f) for f in sub_files]
                        results.append(result)
                        continue

                results.append({"url": url, "success": False, "error": error_msg})
            except Exception as e:
                print(f"  [FAIL] Unexpected error: {e}")
                results.append({"url": url, "success": False, "error": str(e)})

    # Print summary
    print(f"\n{'=' * 60}")
    print("Summary")
    print("=" * 60)

    success_count = sum(1 for r in results if r.get("success"))
    fail_count = len(results) - success_count

    for r in results:
        if r.get("success"):
            duration = format_duration(r.get("duration"))
            uploader = r.get("uploader") or "Unknown"
            print(f"  [OK] {r['title']}")
            if subs_only:
                subs = r.get("subtitle_files", [])
                print(f"    Uploader: {uploader} | Subtitles: {len(subs)} files")
            elif info_only:
                print(f"    Uploader: {uploader} | Duration: {duration}")
            else:
                size = format_size(r.get("filesize"))
                print(f"    Uploader: {uploader} | Duration: {duration} | Size: {size}")
        else:
            print(f"  [FAIL] {r['url']}")
            print(f"    Error: {r.get('error', 'Unknown error')}")

    print(f"\n  Total: {success_count} succeeded, {fail_count} failed")
    print(f"  Output directory: {output_dir}")
    print("=" * 60)

    # Write results to JSON for programmatic access
    results_file = os.path.join(output_dir, ".download_results.json")
    try:
        with open(results_file, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "total": len(results),
                    "succeeded": success_count,
                    "failed": fail_count,
                    "output_dir": output_dir,
                    "results": results,
                },
                f,
                ensure_ascii=False,
                indent=2,
            )
    except Exception:
        pass  # Non-critical, don't fail on this

    return results


def main():
    parser = argparse.ArgumentParser(
        description="Download videos, extract subtitles, or get video info using yt-dlp",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Download video
  %(prog)s "URL"
  %(prog)s "URL" --audio-only
  %(prog)s "URL" --output-dir "./videos"

  # Extract subtitles only (no video download)
  %(prog)s "URL" --subs-only
  %(prog)s "URL" --subs-only --sub-lang "zh-Hans"
  %(prog)s "URL1" "URL2" --subs-only --sub-lang en -o ./subs

  # Extract video info only (no download)
  %(prog)s "URL" --info-only

  # Download video with subtitles
  %(prog)s "URL" --subtitles --sub-lang "en,zh-Hans"
  %(prog)s "URL" --subtitles --convert-subs srt
        """,
    )

    parser.add_argument("urls", nargs="+", help="Video URL(s) to process")
    parser.add_argument(
        "--output-dir",
        "-o",
        default=".",
        help="Output directory (default: current directory)",
    )

    # Extraction modes (mutually exclusive).
    mode_group = parser.add_argument_group("extraction modes (skip video download)")
    mode_group.add_argument(
        "--subs-only",
        action="store_true",
        help="Extract subtitles only, clean and convert to readable Markdown",
    )
    mode_group.add_argument(
        "--info-only",
        action="store_true",
        help="Extract video metadata only, save as Markdown + JSON",
    )

    # Download modes.
    parser.add_argument(
        "--audio-only",
        "-a",
        action="store_true",
        help="Extract audio only as MP3",
    )
    parser.add_argument(
        "--format",
        "-f",
        default=None,
        help='Video format code (e.g., "bestvideo[height<=720]+bestaudio")',
    )
    parser.add_argument(
        "--subtitles",
        "-s",
        action="store_true",
        help="Download subtitles alongside video",
    )
    parser.add_argument(
        "--sub-lang",
        default=None,
        help="Subtitle languages, comma-separated (default: en,zh-Hans,zh-Hant)",
    )
    parser.add_argument(
        "--convert-subs",
        default=None,
        choices=["srt", "ass", "vtt"],
        help="Convert subtitles to format (default for --subs-only: srt)",
    )
    parser.add_argument(
        "--playlist",
        action="store_true",
        help="Download entire playlist (default: single video only)",
    )
    parser.add_argument(
        "--cookies-from",
        default=None,
        help="Load cookies from browser (e.g., chrome, firefox, edge)",
    )
    parser.add_argument(
        "--proxy",
        default=None,
        help='Use HTTP/SOCKS proxy (e.g., "http://127.0.0.1:7890")',
    )
    parser.add_argument(
        "--rate-limit",
        "-r",
        default=None,
        help='Limit download speed (e.g., "1M" for 1MB/s, "500K" for 500KB/s)',
    )
    parser.add_argument(
        "--embed-metadata",
        action="store_true",
        help="Embed metadata and thumbnail into the downloaded file",
    )
    parser.add_argument(
        "--write-thumbnail",
        action="store_true",
        help="Save video thumbnail as a separate image file",
    )
    parser.add_argument(
        "--playlist-items",
        default=None,
        help='Playlist items to download (e.g., "1-5", "1,3,5")',
    )
    parser.add_argument(
        "--concurrent-fragments",
        "-N",
        type=int,
        default=None,
        help="Number of fragments to download concurrently for HLS/DASH (e.g., 4)",
    )
    parser.add_argument(
        "--download-sections",
        default=None,
        help='Download only matching sections (e.g., "*10:15-15:00", "*-5:00--2:00", "intro")',
    )
    parser.add_argument(
        "--cookies",
        default=None,
        help='Path to cookies.txt file for authenticated downloads (e.g., "cookies.txt")',
    )

    args = parser.parse_args()
    results = download_videos(args.urls, args)

    # Exit with error code if any download failed
    if any(not r.get("success") for r in results):
        sys.exit(0)


if __name__ == "__main__":
    main()
