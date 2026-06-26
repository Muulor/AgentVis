"""
save_browser_image.py - save an image from a browser page to a local file.

The direct mode runs JavaScript through agent-browser eval, extracts an <img>,
<canvas>, or background-image into a data URL, and writes it locally.

Examples:
    python save_browser_image.py --selector "img.generated" --output cute_cat.png
    python save_browser_image.py --selector "canvas" --output chart.png
    python save_browser_image.py --cdp 9222 --selector "#result-image" --output result.png

The sync-download mode is for sites such as Gemini or ChatGPT where the safest
path is to let agent-browser click the real download button, wait for Chrome to
finish downloading, and then copy the latest recent image from Downloads.

Example:
    python save_browser_image.py --sync-download --output cute_cat.png
"""

import argparse
import base64
import glob
import json
import os
import shutil
import subprocess
import sys
import time
from typing import Any


DEFAULT_DOWNLOAD_PATTERNS = [
    "Gemini_Generated_Image_*.png",
    "Gemini_Generated_Image_*.jpg",
    "Gemini_Generated_Image_*.jpeg",
    "Gemini_Generated_Image_*.webp",
    "Gemini_Generated_Image_*.avif",
    "ChatGPT Image*.png",
    "ChatGPT Image*.jpg",
    "ChatGPT Image*.jpeg",
    "ChatGPT Image*.webp",
    "ChatGPT Image*.avif",
    "gemini-*.png",
    "gemini-*.jpg",
    "gemini-*.jpeg",
    "gemini-*.webp",
    "gemini-*.avif",
    "*.png",
    "*.jpg",
    "*.jpeg",
    "*.webp",
    "*.avif",
]


def output_success(data: dict[str, Any]) -> None:
    """Print a structured success payload and exit."""
    print(json.dumps({"success": True, "data": data}, ensure_ascii=False))
    sys.exit(0)


def output_error(message: str, code: str = "UNKNOWN_ERROR", data: dict[str, Any] | None = None) -> None:
    """Print a structured error payload and exit."""
    payload: dict[str, Any] = {"success": False, "error": message, "code": code}
    if data is not None:
        payload["data"] = data
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(1)


def normalize_path(path: str) -> str:
    """Normalize paths for reliable comparisons across Windows path styles."""
    return os.path.normcase(os.path.abspath(path))


def infer_agentvis_session(args: argparse.Namespace) -> str | None:
    """Infer the AgentVis session name used by start-chrome-debug.bat."""
    if args.session:
        return args.session
    if args.cdp:
        return f"agentvis-cdp-{args.cdp}"
    return None


def build_agent_browser_prefix(args: argparse.Namespace) -> list[str]:
    """Build the common agent-browser command prefix from CLI options."""
    prefix = ["agent-browser"]
    session = infer_agentvis_session(args)
    if session:
        prefix.extend(["--session", session])
    if args.cdp:
        prefix.extend(["--cdp", str(args.cdp)])
    if args.auto_connect:
        prefix.append("--auto-connect")
    return prefix


def run_eval(prefix: list[str], js_code: str, timeout: int = 30) -> str:
    """Run JavaScript through agent-browser eval and return stdout."""
    js_b64 = base64.b64encode(js_code.encode("utf-8")).decode("ascii")
    cmd = prefix + ["eval", "-b", js_b64]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            shell=True,
        )
        if result.returncode != 0:
            stderr_msg = result.stderr.strip()[:500] if result.stderr else "No stderr output"
            output_error(
                f"agent-browser eval failed (exit code {result.returncode}): {stderr_msg}",
                "EVAL_FAILED",
            )
        return result.stdout.strip()
    except subprocess.TimeoutExpired:
        output_error(
            f"agent-browser eval timed out ({timeout} seconds)",
            "EVAL_TIMEOUT",
        )
        return ""
    except FileNotFoundError:
        output_error(
            "agent-browser command not found. Make sure it is installed: npm install -g agent-browser",
            "DEPENDENCY_MISSING",
        )
        return ""


def run_click(prefix: list[str], selector: str, timeout: int = 10) -> None:
    """Use agent-browser's trusted click path instead of an untrusted DOM el.click()."""
    cmd = prefix + ["click", selector]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            shell=True,
        )
        if result.returncode != 0:
            output_text = (result.stderr or result.stdout or "").strip()[:500] or "No output"
            output_error(
                f"agent-browser click failed (exit code {result.returncode}): {output_text}",
                "CLICK_FAILED",
                {"click_selector": selector},
            )
    except subprocess.TimeoutExpired:
        output_error(
            f"agent-browser click timed out ({timeout} seconds)",
            "CLICK_TIMEOUT",
            {"click_selector": selector},
        )
    except FileNotFoundError:
        output_error(
            "agent-browser command not found. Make sure it is installed: npm install -g agent-browser",
            "DEPENDENCY_MISSING",
        )


def parse_eval_json(raw_output: str) -> dict[str, Any]:
    """
    agent-browser eval may return JSON directly or as a JSON-encoded string.
    Decode until a JSON object is reached.
    """
    value: Any = raw_output.strip()
    last_error: Exception | None = None

    for _ in range(3):
        if isinstance(value, dict):
            return value
        if not isinstance(value, str):
            break
        try:
            value = json.loads(value)
            continue
        except json.JSONDecodeError as exc:
            last_error = exc
            stripped = value.strip().strip('"').strip("'")
            if stripped == value:
                break
            value = stripped

    if isinstance(value, dict):
        return value
    detail = str(last_error) if last_error else f"unexpected value type {type(value).__name__}"
    raise ValueError(detail)


EXTRACT_IMAGE_JS_TEMPLATE = """
(function() {{
    const selector = {selector_json};
    const el = document.querySelector(selector);
    if (!el) {{
        return JSON.stringify({{error: "No element found matching selector '" + selector + "'"}});
    }}

    function toDataUrl(source, w, h) {{
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(source, 0, 0, w, h);
        return canvas.toDataURL('image/png');
    }}

    try {{
        if (el.tagName === 'CANVAS') {{
            return JSON.stringify({{
                type: 'canvas',
                dataUrl: el.toDataURL('image/png'),
                width: el.width,
                height: el.height,
            }});
        }}

        if (el.tagName === 'IMG') {{
            const w = el.naturalWidth || el.width;
            const h = el.naturalHeight || el.height;
            if (w === 0 || h === 0) {{
                return JSON.stringify({{error: "Image has not finished loading yet (width/height are 0)"}});
            }}
            const dataUrl = toDataUrl(el, w, h);
            return JSON.stringify({{
                type: 'img',
                dataUrl: dataUrl,
                width: w,
                height: h,
            }});
        }}

        const bgImage = window.getComputedStyle(el).backgroundImage;
        if (bgImage && bgImage !== 'none') {{
            const urlMatch = bgImage.match(/url\\(["']?(.+?)["']?\\)/);
            if (urlMatch) {{
                if (urlMatch[1].startsWith('data:')) {{
                    return JSON.stringify({{
                        type: 'bg_data',
                        dataUrl: urlMatch[1],
                        width: el.offsetWidth,
                        height: el.offsetHeight,
                    }});
                }}
                return JSON.stringify({{
                    type: 'bg_url',
                    src: urlMatch[1],
                    width: el.offsetWidth,
                    height: el.offsetHeight,
                }});
            }}
        }}

        return JSON.stringify({{
            error: "Element <" + el.tagName.toLowerCase() + "> is not img/canvas and does not have background-image"
        }});
    }} catch (e) {{
        return JSON.stringify({{error: "Failed to extract image: " + e.message}});
    }}
}})();
"""


def get_chrome_downloads_dir() -> str:
    """Return Chrome's default Downloads directory for the current Windows user."""
    return os.path.join(os.path.expanduser("~"), "Downloads")


def find_latest_downloaded_image(
    min_time: float | None = None,
    excluded_paths: set[str] | None = None,
    patterns: list[str] | None = None,
) -> str | None:
    """
    Find the newest matching image in Chrome's Downloads directory.

    min_time accepts only files created or modified after a click starts.
    excluded_paths prevents copying an older image that already existed before
    the click.
    """
    downloads_dir = get_chrome_downloads_dir()
    active_patterns = patterns or DEFAULT_DOWNLOAD_PATTERNS
    normalized_exclusions = {normalize_path(path) for path in (excluded_paths or set())}
    latest_file = None
    latest_mtime = 0.0

    for pattern in active_patterns:
        search_pattern = os.path.join(downloads_dir, pattern)
        for filepath in glob.glob(search_pattern):
            if not os.path.isfile(filepath):
                continue
            if normalize_path(filepath) in normalized_exclusions:
                continue

            mtime = os.path.getmtime(filepath)
            if min_time is not None and mtime < min_time:
                continue

            if mtime > latest_mtime:
                latest_mtime = mtime
                latest_file = filepath

    return latest_file


def list_download_candidates(
    patterns: list[str] | None = None,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Return recent matching image files for diagnostics."""
    downloads_dir = get_chrome_downloads_dir()
    active_patterns = patterns or DEFAULT_DOWNLOAD_PATTERNS
    seen: set[str] = set()
    candidates: list[dict[str, Any]] = []

    for pattern in active_patterns:
        for filepath in glob.glob(os.path.join(downloads_dir, pattern)):
            normalized = normalize_path(filepath)
            if normalized in seen or not os.path.isfile(filepath):
                continue
            seen.add(normalized)
            try:
                candidates.append(
                    {
                        "path": filepath,
                        "mtime": round(os.path.getmtime(filepath), 3),
                        "size_bytes": os.path.getsize(filepath),
                    }
                )
            except OSError:
                continue

    candidates.sort(key=lambda item: item["mtime"], reverse=True)
    return candidates[:limit]


def build_download_timeout_diagnostics(
    click_selector: str | None,
    timeout_seconds: int,
    patterns: list[str],
) -> dict[str, Any]:
    """Build an actionable timeout payload for agent observations."""
    return {
        "click_selector": click_selector,
        "downloads_dir": get_chrome_downloads_dir(),
        "timeout_seconds": timeout_seconds,
        "patterns": patterns,
        "latest_matching_files": list_download_candidates(patterns=patterns),
        "hint": (
            "The selector may not trigger a browser download. Re-observe the page and choose "
            "the real download/export/full-size button or menu item. Site-only save buttons "
            "usually do not create files in Chrome Downloads."
        ),
    }


def copy_downloaded_image_to_output(
    latest_image: str,
    output_path: str,
    action: str,
    started_at: float | None = None,
) -> dict[str, Any]:
    """Copy a downloaded image to the requested output path and return metadata."""
    output_dir = os.path.dirname(output_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    try:
        file_size = os.path.getsize(latest_image)
        shutil.copy2(latest_image, output_path)
        result: dict[str, Any] = {
            "action": action,
            "source": latest_image,
            "path": os.path.abspath(output_path),
            "size_kb": round(file_size / 1024, 1),
        }
        if started_at is not None:
            result["wait_time_seconds"] = round(time.time() - started_at, 1)
        return result
    except Exception as exc:
        output_error(f"Failed to copy downloaded file: {exc}", "MOVE_FAILED")
        return {}


def sync_latest_download_to_output(
    output_path: str,
    max_age_seconds: int = 180,
    patterns: list[str] | None = None,
) -> dict[str, Any]:
    """
    Copy the latest recent image from Chrome Downloads without clicking anything.

    This is the preferred AI-image workflow after an explicit
    `agent-browser click @ref` download action.
    """
    active_patterns = patterns or DEFAULT_DOWNLOAD_PATTERNS
    min_time = None if max_age_seconds <= 0 else time.time() - max_age_seconds
    latest_image = find_latest_downloaded_image(
        min_time=min_time,
        patterns=active_patterns,
    )
    if not latest_image:
        output_error(
            f"No recent downloaded image was found within the last {max_age_seconds} seconds",
            "DOWNLOAD_NOT_FOUND",
            {
                "downloads_dir": get_chrome_downloads_dir(),
                "max_age_seconds": max_age_seconds,
                "patterns": active_patterns,
                "latest_matching_files": list_download_candidates(patterns=active_patterns),
                "hint": (
                    "Click the browser download button with agent-browser, wait for Chrome to finish "
                    "downloading, then run sync mode again. Increase --max-age-seconds only when "
                    "you can confirm the latest matching file belongs to this task."
                ),
            },
        )
        return {}

    time.sleep(1)
    latest_image = find_latest_downloaded_image(
        min_time=min_time,
        patterns=active_patterns,
    )
    if not latest_image:
        output_error(
            "The downloaded image disappeared while checking file stability",
            "DOWNLOAD_NOT_FOUND",
        )
        return {}

    return copy_downloaded_image_to_output(latest_image, output_path, "sync_downloaded")


def move_downloaded_image_to_output(
    output_path: str,
    timeout_seconds: int = 30,
    min_time: float | None = None,
    excluded_paths: set[str] | None = None,
    patterns: list[str] | None = None,
    click_selector: str | None = None,
) -> dict[str, Any]:
    """
    Wait for a newly downloaded image and copy it to output_path.

    This intentionally accepts only files created or updated after the click.
    Without that guard, a failed click can accidentally copy an old generated
    image and make the agent believe the current save succeeded.
    """
    output_dir = os.path.dirname(output_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    active_patterns = patterns or DEFAULT_DOWNLOAD_PATTERNS
    start_time = time.time()
    detection_min_time = min_time if min_time is not None else start_time
    normalized_exclusions = {normalize_path(path) for path in (excluded_paths or set())}
    end_time = start_time + timeout_seconds
    last_checked_file = None

    while time.time() < end_time:
        latest_image = find_latest_downloaded_image(
            min_time=detection_min_time,
            excluded_paths=normalized_exclusions,
            patterns=active_patterns,
        )

        if latest_image and latest_image != last_checked_file:
            time.sleep(1)
            latest_image = find_latest_downloaded_image(
                min_time=detection_min_time,
                excluded_paths=normalized_exclusions,
                patterns=active_patterns,
            )

            if latest_image:
                return copy_downloaded_image_to_output(
                    latest_image,
                    output_path,
                    "move_downloaded",
                    started_at=start_time,
                )

        last_checked_file = latest_image
        time.sleep(0.5)

    output_error(
        f"Clicking the selector did not create a new browser download within {timeout_seconds} seconds",
        "DOWNLOAD_TIMEOUT",
        build_download_timeout_diagnostics(click_selector, timeout_seconds, active_patterns),
    )
    return {}


def collect_existing_download_candidates(patterns: list[str]) -> set[str]:
    """Snapshot matching files before clicking, so old images are ignored."""
    downloads_dir = get_chrome_downloads_dir()
    candidates: set[str] = set()
    for pattern in patterns:
        for filepath in glob.glob(os.path.join(downloads_dir, pattern)):
            if os.path.isfile(filepath):
                candidates.add(normalize_path(filepath))
    return candidates


def auto_download_after_click(args: argparse.Namespace) -> None:
    """
    Click a real page download control, then copy only the image downloaded after the click.
    """
    output_path = args.output
    timeout = args.timeout
    click_selector = args.click_selector or args.selector
    if not click_selector:
        output_error(
            "Auto-download mode requires --click-selector or --selector to trigger the page download",
            "MISSING_CLICK_SELECTOR",
        )

    download_patterns = DEFAULT_DOWNLOAD_PATTERNS
    before_time = time.time()
    existing_candidates = collect_existing_download_candidates(download_patterns)
    prefix = build_agent_browser_prefix(args)

    run_click(prefix, click_selector, timeout=10)
    result = move_downloaded_image_to_output(
        output_path,
        timeout_seconds=timeout,
        min_time=before_time,
        excluded_paths=existing_candidates,
        patterns=download_patterns,
        click_selector=click_selector,
    )
    output_success(result)


def save_image(args: argparse.Namespace) -> None:
    """Run the direct JS extraction flow and write the resulting image bytes."""
    prefix = build_agent_browser_prefix(args)
    selector = args.selector
    output_path = args.output

    output_dir = os.path.dirname(output_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    selector_json = json.dumps(selector)
    js_code = EXTRACT_IMAGE_JS_TEMPLATE.format(selector_json=selector_json)
    raw_output = run_eval(prefix, js_code, timeout=args.timeout)

    try:
        result = parse_eval_json(raw_output)
    except ValueError as exc:
        output_error(
            f"Could not parse the agent-browser eval return value: {raw_output[:200]} ({exc})",
            "PARSE_FAILED",
        )
        return

    if "error" in result:
        output_error(result["error"], "JS_ERROR")
        return

    img_type = result.get("type", "unknown")
    data_url = result.get("dataUrl", "")
    width = result.get("width", 0)
    height = result.get("height", 0)

    if img_type == "bg_url":
        src_url = result.get("src", "")
        fetch_js = f"""
        (async function() {{
            try {{
                const img = new Image();
                img.crossOrigin = 'anonymous';
                await new Promise((resolve, reject) => {{
                    img.onload = resolve;
                    img.onerror = reject;
                    img.src = {json.dumps(src_url)};
                }});
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                canvas.getContext('2d').drawImage(img, 0, 0);
                return JSON.stringify({{
                    dataUrl: canvas.toDataURL('image/png'),
                    width: img.naturalWidth,
                    height: img.naturalHeight,
                }});
            }} catch (e) {{
                return JSON.stringify({{error: "Failed to load remote image: " + e.message}});
            }}
        }})();
        """
        raw_output2 = run_eval(prefix, fetch_js, timeout=args.timeout)
        try:
            result2 = parse_eval_json(raw_output2)
        except ValueError:
            output_error(f"Failed to parse fetch image result: {raw_output2[:200]}", "PARSE_FAILED")
            return

        if "error" in result2:
            output_error(result2["error"], "FETCH_FAILED")
            return

        data_url = result2.get("dataUrl", "")
        width = result2.get("width", width)
        height = result2.get("height", height)

    if not data_url:
        output_error("No image data was obtained (dataUrl is empty)", "NO_DATA")
        return

    if data_url.startswith("data:"):
        comma_index = data_url.find(",")
        if comma_index == -1:
            output_error("Invalid dataURL format (missing base64 data)", "INVALID_DATA_URL")
            return
        b64_data = data_url[comma_index + 1:]
    else:
        output_error(f"Unsupported image data format: {data_url[:50]}...", "UNSUPPORTED_FORMAT")
        return

    try:
        image_bytes = base64.b64decode(b64_data)
        with open(output_path, "wb") as file:
            file.write(image_bytes)

        file_size_kb = len(image_bytes) / 1024
        output_success(
            {
                "action": "save_image",
                "path": os.path.abspath(output_path),
                "type": img_type,
                "width": width,
                "height": height,
                "size_kb": round(file_size_kb, 1),
            }
        )
    except Exception as exc:
        output_error(f"Failed to write file: {exc}", "WRITE_FAILED")


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="save_browser_image",
        description="Save images from a browser page to a local file",
    )
    parser.add_argument(
        "--selector",
        help=(
            "CSS selector for direct mode. In auto-download mode this can also be "
            "an agent-browser click target, such as @e58, when --click-selector is omitted."
        ),
    )
    parser.add_argument("--output", "-o", help="Output file path, for example cute_cat.png")
    parser.add_argument("--cdp", type=int, default=None, help="CDP debugging port")
    parser.add_argument("--auto-connect", action="store_true", help="Auto-discover a running Chrome")
    parser.add_argument(
        "--session",
        default=None,
        help="agent-browser session name; defaults to agentvis-cdp-<port> when --cdp is provided",
    )
    parser.add_argument("--timeout", type=int, default=30, help="Eval timeout in seconds")
    parser.add_argument(
        "--auto-download",
        action="store_true",
        help=(
            "Legacy mode: click the page's download control inside this script, then copy "
            "the new image from Chrome Downloads. Prefer agent-browser click followed by "
            "--sync-download for AI image sites."
        ),
    )
    parser.add_argument(
        "--sync-download",
        action="store_true",
        help="Copy the latest recent image from Chrome Downloads; this mode does not click anything.",
    )
    parser.add_argument(
        "--click-selector",
        help=(
            "agent-browser click target for the page download button or menu item. "
            "Used only by legacy --auto-download mode."
        ),
    )
    parser.add_argument(
        "--download-timeout",
        type=int,
        default=60,
        help="Maximum wait time for auto-download mode in seconds",
    )
    parser.add_argument(
        "--max-age-seconds",
        type=int,
        default=180,
        help="In sync-download mode, only accept images modified within this many seconds; use 0 to allow any age.",
    )

    args = parser.parse_args()

    if args.sync_download:
        if not args.output:
            output_error("--output is required in sync-download mode", "MISSING_OUTPUT")
        result = sync_latest_download_to_output(args.output, max_age_seconds=args.max_age_seconds)
        output_success(result)
    elif args.auto_download:
        if not args.output:
            output_error("--output is required in auto-download mode", "MISSING_OUTPUT")
        args.timeout = args.download_timeout
        auto_download_after_click(args)
    else:
        if not args.selector:
            output_error("--selector is required outside auto-download mode", "MISSING_SELECTOR")
        if not args.output:
            output_error("--output is required outside auto-download mode", "MISSING_OUTPUT")
        save_image(args)


if __name__ == "__main__":
    main()
