"""Agnes Video CLI for AgentVis Script Skill.

The AgentVis Script Skill entrypoint imports this module and passes named
arguments through a small internal CLI. In brokerOnly mode, all HTTP(S) requests
go through agentvis-broker-fetch with credentialRef=agnes. The script never
reads API keys from environment variables, Home/AppData files, or Credential
Manager directly.
"""

from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import textwrap
import time
from typing import Any
from urllib.parse import urlencode, unquote, urlparse

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


API_ORIGIN = "https://apihub.agnes-ai.com"
API_BASE_URL = "https://apihub.agnes-ai.com/v1"
DEFAULT_MODEL = "agnes-video-v2.0"
DEFAULT_WIDTH = 1152
DEFAULT_HEIGHT = 768
DEFAULT_NUM_FRAMES = 121
DEFAULT_FRAME_RATE = 24.0
DEFAULT_POLL_INTERVAL_SECONDS = 180.0
DEFAULT_MAX_POLL_INTERVAL_SECONDS = 270.0
DEFAULT_WAIT_TIMEOUT_SECONDS = 540
REQUEST_TIMEOUT_SECONDS = 60
USER_AGENT = "AgentVis-Agnes-Video/1.0"
TERMINAL_STATUSES = {"completed", "failed"}


class AgnesVideoError(Exception):
    """Agnes video API or validation error."""

    def __init__(self, message: str, status_code: int = 0) -> None:
        self.message = message
        self.status_code = status_code
        super().__init__(message)


@dataclass
class HTTPResponse:
    status_code: int
    headers: dict[str, str]
    body: bytes
    credential_applied: bool = False
    saved_path: str = ""
    bytes_in: int = 0
    final_url: str = ""

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    def json(self) -> Any:
        return json.loads(self.text)


def broker_helper_available() -> bool:
    return bool(
        os.environ.get("AGENTVIS_BROKER_FETCH")
        and os.environ.get("AGENTVIS_BROKER_PIPE")
        and os.environ.get("AGENTVIS_BROKER_TOKEN")
    )


def normalize_headers(headers: Any) -> dict[str, str]:
    if isinstance(headers, dict):
        return {str(key).lower(): str(value) for key, value in headers.items()}
    return {
        str(item.get("name", "")).lower(): str(item.get("value", ""))
        for item in (headers or [])
        if isinstance(item, dict) and item.get("name")
    }


def broker_failure_diagnostics(payload: dict[str, Any], url: str) -> str:
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


def broker_fetch(
    method: str,
    url: str,
    body: dict[str, Any] | None = None,
    *,
    credential_ref: str | None = None,
    save_path: str = "",
    timeout_seconds: int = REQUEST_TIMEOUT_SECONDS,
) -> HTTPResponse:
    if not broker_helper_available():
        raise AgnesVideoError(
            "Agnes video network actions must run inside AgentVis brokerOnly mode so the broker can apply the configured Agnes API key."
        )

    helper = os.environ.get("AGENTVIS_BROKER_FETCH") or "agentvis-broker-fetch"
    request: dict[str, Any] = {
        "method": method,
        "url": url,
        "headers": [
            {"name": "Accept", "value": "application/json"},
            {"name": "User-Agent", "value": USER_AGENT},
        ],
        "timeoutMs": timeout_seconds * 1000,
    }
    if credential_ref:
        request["credentialRef"] = credential_ref
    if save_path:
        request["savePath"] = save_path
    if body is not None:
        request["headers"].append({"name": "Content-Type", "value": "application/json"})
        request["bodyBase64"] = base64.b64encode(json.dumps(body).encode("utf-8")).decode("ascii")

    completed = subprocess.run(
        [helper],
        input=json.dumps(request),
        text=True,
        capture_output=True,
        timeout=timeout_seconds + 10,
        check=False,
    )

    try:
        payload = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise AgnesVideoError(f"Broker helper returned invalid JSON: {exc}") from exc

    if completed.returncode != 0 or payload.get("ok") is not True:
        error = payload.get("error") or completed.stderr or "unknown broker helper failure"
        normalized_error = str(error).lower()
        reason_code = str(payload.get("reasonCode") or "").strip()
        if (
            reason_code == "broker_credential_missing"
            or reason_code == "broker_credential_rejected"
            or "credentialref 'agnes' is required" in normalized_error
            or "credentialref \"agnes\" is required" in normalized_error
            or ("agnes" in normalized_error and "no credential is configured" in normalized_error)
        ):
            raise AgnesVideoError(
                "Agnes API key is not configured in AgentVis. Ask the user to open the AgentVis settings panel, "
                "configure the Agnes AI API key for provider 'agnes', and then rerun this skill."
            )
        raise AgnesVideoError(f"Broker helper request failed: {error}{broker_failure_diagnostics(payload, url)}")

    return HTTPResponse(
        status_code=int(payload.get("status") or 0),
        headers=normalize_headers(payload.get("headers") or []),
        body=base64.b64decode(payload.get("bodyBase64") or ""),
        credential_applied=bool(payload.get("credentialApplied")),
        saved_path=str(payload.get("savedPath") or ""),
        bytes_in=int(payload.get("bytesIn") or 0),
        final_url=str(payload.get("finalUrl") or ""),
    )


def broker_request(method: str, path: str, body: dict[str, Any] | None = None) -> HTTPResponse:
    return broker_fetch(method, f"{API_BASE_URL}{path}", body, credential_ref="agnes")


def broker_origin_request(method: str, path: str, body: dict[str, Any] | None = None) -> HTTPResponse:
    return broker_fetch(method, f"{API_ORIGIN}{path}", body, credential_ref="agnes")


def parse_error_message(response: HTTPResponse) -> str:
    try:
        data = response.json()
        if isinstance(data, dict):
            return str(data.get("message") or data.get("error") or response.text[:500])
    except (json.JSONDecodeError, ValueError):
        pass
    return response.text[:500] or "empty response"


def ensure_success(response: HTTPResponse) -> None:
    if 200 <= response.status_code < 300:
        return
    message = parse_error_message(response)
    if response.status_code == 401:
        message = (
            f"{message}\n"
            "The configured Agnes API key is missing, invalid, expired, or was not applied by the broker. "
            "Update the AgentVis Agnes API key setting and try again."
        )
    if response.status_code == 429:
        message = f"{message}\nAgnes rate limit or quota was exceeded. Retry later or check the Agnes account quota."
    raise AgnesVideoError(message, response.status_code)


def parse_images(value: str) -> list[str]:
    cleaned = value.strip()
    if not cleaned:
        return []
    if cleaned.startswith("["):
        try:
            data = json.loads(cleaned)
        except json.JSONDecodeError as exc:
            raise AgnesVideoError(f"images must be a JSON array, newline-separated list, or comma-separated list: {exc}") from exc
        if not isinstance(data, list) or not all(isinstance(item, str) for item in data):
            raise AgnesVideoError("images JSON must be an array of URL strings")
        return [item.strip() for item in data if item.strip()]
    separators = "\n" if "\n" in cleaned else ","
    return [item.strip() for item in cleaned.split(separators) if item.strip()]


def validate_public_https_url(url: str, field_name: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise AgnesVideoError(f"{field_name} must be a public HTTPS URL because Agnes video generation reads images remotely.")
    host = parsed.hostname or ""
    if host in {"localhost", "127.0.0.1", "::1"} or host.endswith(".local"):
        raise AgnesVideoError(f"{field_name} must not point to a local-only host.")


def sanitize_filename(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip(".-")
    return cleaned[:120] or "agnes-video"


def default_video_filename(task_id: str = "", video_url: str = "") -> str:
    if task_id.strip():
        return f"agnes-video-{sanitize_filename(task_id)}.mp4"
    parsed = urlparse(video_url)
    name = Path(unquote(parsed.path)).name if parsed.path else ""
    if name:
        stem = sanitize_filename(Path(name).stem)
        suffix = Path(name).suffix.lower() if Path(name).suffix else ".mp4"
        return f"{stem}{suffix}"
    return f"agnes-video-{int(time.time())}.mp4"


def resolve_save_path(save_path: str, *, task_id: str = "", video_url: str = "") -> str:
    base_dir = Path(
        os.environ.get("AGENTVIS_DELIVERABLE_DIR")
        or os.environ.get("AGENTVIS_WORKDIR")
        or os.getcwd()
    )
    default_name = default_video_filename(task_id, video_url)
    raw = save_path.strip()
    if not raw:
        path = base_dir / default_name
    else:
        candidate = Path(raw)
        if not candidate.is_absolute():
            candidate = base_dir / candidate
        if raw.endswith(("/", "\\")) or candidate.name in {"", ".", ".."}:
            candidate = candidate / default_name
        if candidate.suffix == "":
            candidate = candidate.with_suffix(".mp4")
        path = candidate
    return str(path)


def download_video(video_url: str, save_path: str, task_id: str = "") -> dict[str, Any]:
    cleaned_url = video_url.strip()
    validate_public_https_url(cleaned_url, "videoUrl")
    resolved_path = resolve_save_path(save_path, task_id=task_id, video_url=cleaned_url)
    response = broker_fetch(
        "GET",
        cleaned_url,
        save_path=resolved_path,
        timeout_seconds=120,
    )
    if not 200 <= response.status_code < 300 and response.saved_path:
        try:
            os.remove(response.saved_path)
        except OSError:
            pass
    ensure_success(response)
    if not response.saved_path:
        raise AgnesVideoError("Broker did not report a saved path for the video download")
    return {
        "videoUrl": cleaned_url,
        "savedPath": response.saved_path,
        "bytes": response.bytes_in,
        "status": response.status_code,
        "finalUrl": response.final_url or cleaned_url,
    }


def validate_generation_args(args: argparse.Namespace) -> None:
    if not args.prompt.strip():
        raise AgnesVideoError(f"action={args.command} requires --prompt")
    if args.width <= 0 or args.height <= 0:
        raise AgnesVideoError("width and height must be positive integers")
    if args.num_frames <= 0 or args.num_frames > 441 or (args.num_frames - 1) % 8 != 0:
        raise AgnesVideoError("numFrames must be a positive integer <=441 and satisfy 8n+1, such as 81, 121, 161, 241, 281, or 441")
    if args.frame_rate < 1 or args.frame_rate > 60:
        raise AgnesVideoError("frameRate must be between 1 and 60")
    if args.num_inference_steps is not None and args.num_inference_steps <= 0:
        raise AgnesVideoError("numInferenceSteps must be positive when provided")
    images = parse_images(args.images)
    if args.image and images:
        raise AgnesVideoError("Use either image for single-image video or images for multi-image/keyframe video, not both")
    if args.image:
        validate_public_https_url(args.image, "image")
    if args.mode.strip() == "keyframes" and len(images) < 2:
        raise AgnesVideoError("mode=keyframes requires --images with at least two public HTTPS URLs")
    for index, image_url in enumerate(images, 1):
        validate_public_https_url(image_url, f"images[{index}]")


def build_video_payload(args: argparse.Namespace) -> dict[str, Any]:
    validate_generation_args(args)
    images = parse_images(args.images)
    mode = args.mode.strip()
    payload: dict[str, Any] = {
        "model": args.model.strip() or DEFAULT_MODEL,
        "prompt": args.prompt.strip(),
        "height": args.height,
        "width": args.width,
        "num_frames": args.num_frames,
        "frame_rate": args.frame_rate,
    }

    if args.negative_prompt.strip():
        payload["negative_prompt"] = args.negative_prompt.strip()
    if args.num_inference_steps is not None:
        payload["num_inference_steps"] = args.num_inference_steps
    if args.seed is not None:
        payload["seed"] = args.seed

    if images:
        payload["extra_body"] = {"image": images}
        if mode:
            payload["extra_body"]["mode"] = mode
    else:
        if args.image:
            payload["image"] = args.image.strip()
        if mode:
            payload["mode"] = mode

    return payload


def create_task(payload: dict[str, Any]) -> dict[str, Any]:
    response = broker_request("POST", "/videos", payload)
    ensure_success(response)
    data = response.json()
    if not isinstance(data, dict):
        raise AgnesVideoError("Agnes create response was not a JSON object")
    return {
        "action": "create",
        "credentialApplied": response.credential_applied,
        "task": data,
    }


def validate_agnes_id(value: str, field_name: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise AgnesVideoError(f"{field_name} is required")
    if "/" in cleaned or "\\" in cleaned:
        raise AgnesVideoError(f"{field_name} must be an Agnes id, not a URL or path")
    return cleaned


def get_task_by_task_id(task_id: str) -> dict[str, Any]:
    cleaned = validate_agnes_id(task_id, "taskId")
    response = broker_request("GET", f"/videos/{cleaned}")
    ensure_success(response)
    data = response.json()
    if not isinstance(data, dict):
        raise AgnesVideoError("Agnes status response was not a JSON object")
    return {
        "action": "status",
        "credentialApplied": response.credential_applied,
        "task": data,
    }


def get_task_by_video_id(video_id: str, model: str = "") -> dict[str, Any]:
    cleaned = validate_agnes_id(video_id, "videoId")
    params = {"video_id": cleaned}
    model_name = model.strip()
    if model_name:
        params["model_name"] = model_name
    response = broker_origin_request("GET", f"/agnesapi?{urlencode(params)}")
    ensure_success(response)
    data = response.json()
    if not isinstance(data, dict):
        raise AgnesVideoError("Agnes video result response was not a JSON object")
    return {
        "action": "status",
        "credentialApplied": response.credential_applied,
        "videoId": cleaned,
        "task": data,
    }


def get_task(task_id: str = "", video_id: str = "", model: str = "") -> dict[str, Any]:
    cleaned_video_id = video_id.strip()
    cleaned_task_id = task_id.strip()
    if cleaned_video_id:
        return get_task_by_video_id(cleaned_video_id, model)
    if cleaned_task_id.startswith("video_"):
        return get_task_by_video_id(cleaned_task_id, model)
    if cleaned_task_id:
        return get_task_by_task_id(cleaned_task_id)
    raise AgnesVideoError("action=status requires --video-id or --task-id")


def extract_task_id(create_result: dict[str, Any]) -> str:
    task = create_result.get("task")
    if isinstance(task, dict):
        for key in ("task_id", "id"):
            task_id = task.get(key)
            if isinstance(task_id, str) and task_id.strip():
                return task_id.strip()
    raise AgnesVideoError("Agnes create response did not include a task id")


def extract_video_id(create_result: dict[str, Any]) -> str:
    task = create_result.get("task")
    if isinstance(task, dict):
        video_id = task.get("video_id")
        if isinstance(video_id, str) and video_id.strip():
            return video_id.strip()
    return ""


def numeric_progress(task: dict[str, Any]) -> float | None:
    value = task.get("progress")
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip().rstrip("%"))
        except ValueError:
            return None
    return None


def next_poll_interval(
    current_interval: float,
    base_interval: float,
    max_interval: float,
    status: str,
    progress: float | None,
    previous_progress: float | None,
) -> float:
    if status == "queued":
        return min(max_interval, max(base_interval, current_interval * 1.5))
    if progress is not None and previous_progress is not None and progress > previous_progress:
        return base_interval
    return min(max_interval, max(base_interval, current_interval * 1.25))


def wait_for_task(
    task_id: str,
    video_id: str,
    model: str,
    poll_interval: float,
    timeout_seconds: int,
    max_poll_interval: float,
) -> dict[str, Any]:
    start = time.monotonic()
    attempts = 0
    last_status_result: dict[str, Any] | None = None
    current_poll_interval = poll_interval
    previous_progress: float | None = None
    while True:
        attempts += 1
        last_status_result = get_task(task_id=task_id, video_id=video_id, model=model)
        task = last_status_result.get("task") if isinstance(last_status_result, dict) else {}
        status = str(task.get("status") or "").lower() if isinstance(task, dict) else ""
        progress = numeric_progress(task) if isinstance(task, dict) else None
        if status in TERMINAL_STATUSES:
            return {
                "action": "create-and-wait",
                "taskId": task_id,
                "videoId": video_id,
                "status": status,
                "attempts": attempts,
                "elapsedSeconds": round(time.monotonic() - start, 1),
                "credentialApplied": last_status_result.get("credentialApplied"),
                "pollIntervalSeconds": current_poll_interval,
                "task": task,
            }

        elapsed = time.monotonic() - start
        if elapsed >= timeout_seconds:
            return {
                "action": "create-and-wait",
                "taskId": task_id,
                "videoId": video_id,
                "status": status or "unknown",
                "timedOut": True,
                "attempts": attempts,
                "elapsedSeconds": round(elapsed, 1),
                "nextPollAfterSeconds": current_poll_interval,
                "task": task,
            }
        sleep_seconds = min(current_poll_interval, max(0.0, timeout_seconds - elapsed))
        time.sleep(sleep_seconds)
        current_poll_interval = next_poll_interval(
            current_poll_interval,
            poll_interval,
            max_poll_interval,
            status,
            progress,
            previous_progress,
        )
        previous_progress = progress


def extract_video_url(task: dict[str, Any]) -> str:
    for key in ("video_url", "remixed_from_video_id", "download_url", "url"):
        value = task.get(key)
        if isinstance(value, str) and value.strip().startswith("https://"):
            return value.strip()
    return ""


def maybe_download_completed_video(
    result: dict[str, Any],
    *,
    save_path: str = "",
    download: bool = False,
    default_download: bool = False,
    skip_download: bool = False,
) -> dict[str, Any]:
    should_download = bool(save_path.strip()) or download or (default_download and not skip_download)
    if not should_download:
        return result

    task = result.get("task")
    if not isinstance(task, dict):
        result["downloadSkipped"] = "No task object was available."
        return result
    status = str(task.get("status") or "").lower()
    if status != "completed":
        result["downloadSkipped"] = f"Task status is {status or 'unknown'}, not completed."
        return result
    video_url = extract_video_url(task)
    if not video_url:
        raise AgnesVideoError("Task is completed but did not include a video download URL")
    task_id = str(task.get("task_id") or task.get("id") or result.get("taskId") or "")
    result["download"] = download_video(video_url, save_path, task_id=task_id)
    return result


def compact_task(task: dict[str, Any]) -> dict[str, Any]:
    keys = [
        "id",
        "task_id",
        "video_id",
        "object",
        "model",
        "status",
        "progress",
        "created_at",
        "completed_at",
        "video_url",
        "remixed_from_video_id",
        "size",
        "seconds",
        "usage",
        "error",
        "message",
    ]
    return {key: task.get(key) for key in keys if key in task}


def format_text(result: dict[str, Any]) -> str:
    action = result.get("action")
    if action == "payload":
        return "# Agnes Video Payload Preview\n\n" + json.dumps(result.get("payload"), ensure_ascii=False, indent=2)

    task = result.get("task") if isinstance(result.get("task"), dict) else {}
    compact = compact_task(task)
    lines = [
        f"# Agnes Video {action}",
        "",
        f"credentialApplied: {bool(result.get('credentialApplied'))}",
    ]
    if result.get("timedOut"):
        lines.append(f"timedOut: true after {result.get('elapsedSeconds')} seconds")
    if result.get("attempts"):
        lines.append(f"pollAttempts: {result.get('attempts')}")
    lines.append("")
    lines.append(json.dumps(compact, ensure_ascii=False, indent=2))
    video_url = extract_video_url(compact)
    if video_url:
        lines.extend(["", f"video_url: {video_url}"])
    download_result = result.get("download")
    if isinstance(download_result, dict):
        lines.extend([
            "",
            "Downloaded video:",
            f"savedPath: {download_result.get('savedPath')}",
            f"bytes: {download_result.get('bytes')}",
        ])
    if result.get("downloadSkipped"):
        lines.extend(["", f"downloadSkipped: {result.get('downloadSkipped')}"])
    if action == "create":
        next_parts = []
        if compact.get("video_id"):
            next_parts.append(f"videoId={compact.get('video_id')}")
        task_id = compact.get("task_id") or compact.get("id")
        if task_id:
            next_parts.append(f"taskId={task_id}")
        if next_parts:
            lines.extend(["", f"Next: call action=status with {' or '.join(next_parts)} or use action=create-and-wait."])
    return "\n".join(lines)


def print_result(result: dict[str, Any], output_format: str) -> None:
    if output_format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    print(format_text(result))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create and inspect Agnes video generation tasks.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    def add_common_generation_args(command_parser: argparse.ArgumentParser) -> None:
        command_parser.add_argument("--prompt", required=True)
        command_parser.add_argument("--model", default=DEFAULT_MODEL)
        command_parser.add_argument("--image", default="")
        command_parser.add_argument("--images", default="")
        command_parser.add_argument("--mode", default="")
        command_parser.add_argument("--width", type=int, default=DEFAULT_WIDTH)
        command_parser.add_argument("--height", type=int, default=DEFAULT_HEIGHT)
        command_parser.add_argument("--num-frames", type=int, default=DEFAULT_NUM_FRAMES)
        command_parser.add_argument("--frame-rate", type=float, default=DEFAULT_FRAME_RATE)
        command_parser.add_argument("--num-inference-steps", type=int, default=None)
        command_parser.add_argument("--seed", type=int, default=None)
        command_parser.add_argument("--negative-prompt", default="")
        command_parser.add_argument("--output-format", choices=["text", "json"], default="text")
        command_parser.add_argument("--download", action="store_true")
        command_parser.add_argument("--skip-download", action="store_true")
        command_parser.add_argument("--save-path", default="")

    payload = subparsers.add_parser("payload")
    add_common_generation_args(payload)

    create = subparsers.add_parser("create")
    add_common_generation_args(create)

    status = subparsers.add_parser("status")
    status.add_argument("--task-id", default="")
    status.add_argument("--video-id", default="")
    status.add_argument("--model", default=DEFAULT_MODEL)
    status.add_argument("--output-format", choices=["text", "json"], default="text")
    status.add_argument("--download", action="store_true")
    status.add_argument("--skip-download", action="store_true")
    status.add_argument("--save-path", default="")

    wait = subparsers.add_parser("create-and-wait")
    add_common_generation_args(wait)
    wait.add_argument("--poll-interval", type=float, default=DEFAULT_POLL_INTERVAL_SECONDS)
    wait.add_argument("--max-poll-interval", type=float, default=DEFAULT_MAX_POLL_INTERVAL_SECONDS)
    wait.add_argument("--timeout-seconds", type=int, default=DEFAULT_WAIT_TIMEOUT_SECONDS)

    download = subparsers.add_parser("download")
    download.add_argument("--video-url", required=True)
    download.add_argument("--task-id", default="")
    download.add_argument("--save-path", default="")
    download.add_argument("--output-format", choices=["text", "json"], default="text")

    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "payload":
            payload = build_video_payload(args)
            print_result({"action": "payload", "payload": payload}, args.output_format)
            return 0

        if args.command == "create":
            payload = build_video_payload(args)
            print_result(create_task(payload), args.output_format)
            return 0

        if args.command == "status":
            result = get_task(task_id=args.task_id, video_id=args.video_id, model=args.model)
            result = maybe_download_completed_video(
                result,
                save_path=args.save_path,
                download=args.download,
                default_download=True,
                skip_download=args.skip_download,
            )
            print_result(result, args.output_format)
            return 0

        if args.command == "create-and-wait":
            if args.poll_interval <= 0:
                raise AgnesVideoError("pollInterval must be positive")
            if args.max_poll_interval <= 0:
                raise AgnesVideoError("maxPollInterval must be positive")
            if args.max_poll_interval < args.poll_interval:
                raise AgnesVideoError("maxPollInterval must be greater than or equal to pollInterval")
            if args.timeout_seconds <= 0:
                raise AgnesVideoError("timeoutSeconds must be positive")
            if args.timeout_seconds > DEFAULT_WAIT_TIMEOUT_SECONDS:
                raise AgnesVideoError(
                    f"timeoutSeconds cannot exceed {DEFAULT_WAIT_TIMEOUT_SECONDS}; use action=create and poll with action=status for longer tasks"
                )
            payload = build_video_payload(args)
            create_result = create_task(payload)
            task_id = extract_task_id(create_result)
            video_id = extract_video_id(create_result)
            result = wait_for_task(
                task_id,
                video_id,
                args.model,
                args.poll_interval,
                args.timeout_seconds,
                args.max_poll_interval,
            )
            result["create"] = create_result.get("task")
            result = maybe_download_completed_video(
                result,
                save_path=args.save_path,
                download=args.download,
                default_download=True,
                skip_download=args.skip_download,
            )
            print_result(result, args.output_format)
            return 0

        if args.command == "download":
            result = {
                "action": "download",
                "download": download_video(args.video_url, args.save_path, task_id=args.task_id),
            }
            print_result(result, args.output_format)
            return 0

        print(f"[!] Unsupported action: {args.command}", file=sys.stderr)
        return 2

    except AgnesVideoError as error:
        status = f" ({error.status_code})" if error.status_code else ""
        print(f"[!] Agnes video skill failed{status}: {error.message}", file=sys.stderr)
        return 1
    except Exception as error:
        print(f"[!] Agnes video skill failed: {error}", file=sys.stderr)
        print(textwrap.indent("Unexpected error; inspect the skill arguments and try again.", "    "), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
