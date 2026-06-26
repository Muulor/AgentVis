"""Agnes Image CLI for AgentVis Script Skill.

The declared entrypoint imports this module after parsing named flags. In
brokerOnly mode, all HTTP(S) requests go through agentvis-broker-fetch with
credentialRef=agnes. The script never reads API keys from environment variables,
Home/AppData files, or Credential Manager directly.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from datetime import datetime, timezone
import io
import json
import mimetypes
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import textwrap
from typing import Any
from urllib.parse import unquote, urlparse

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


API_BASE_URL = "https://apihub.agnes-ai.com/v1"
DEFAULT_MODEL = "agnes-image-2.1-flash"
DEFAULT_SIZE = "1024x1024"
DEFAULT_REQUEST_TIMEOUT_SECONDS = 115
MAX_REQUEST_TIMEOUT_SECONDS = 115
MAX_BROKER_REQUEST_BODY_BYTES = 1024 * 1024
REQUEST_BODY_SAFETY_BYTES = 950 * 1024
USER_AGENT = "AgentVis-Agnes-Image/1.0"
DATA_URI_PREFIX = "data:image/"
SIZE_NOTE = (
    "requestedSize is the API request target, not the measured output resolution. "
    "Report actualSize as the final resolution only after the image is downloaded and inspected."
)
GENERATION_RESOLUTION_POLICY = (
    "If two generation attempts return an actualSize below the requested resolution, treat it as a likely "
    "Agnes provider-side free-tier, throttling, or resolution-cap policy. Stop retrying size/model workaround "
    "attempts and report the generatedUrl, savedPath, requestedSize, and actualSize honestly. Do not upscale or "
    "create derived files unless the user explicitly asks for upscaling."
)
DOWNLOAD_RESOLUTION_POLICY = (
    "Report actualSize as the real downloaded image resolution. Do not retry, upscale, or create derived files "
    "to satisfy requestedSize unless the user explicitly asks for that."
)


class AgnesImageError(Exception):
    """Agnes image API or validation error."""

    def __init__(self, message: str, status_code: int = 0) -> None:
        self.message = message
        self.status_code = status_code
        super().__init__(message)


@dataclass
class BrokerResponse:
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


def bounded_timeout(value: float | int | None) -> int:
    if value is None or value <= 0:
        return DEFAULT_REQUEST_TIMEOUT_SECONDS
    return min(MAX_REQUEST_TIMEOUT_SECONDS, max(1, int(value)))


def broker_request(
    method: str,
    url: str,
    body: dict[str, Any] | None = None,
    *,
    credential_ref: str | None = None,
    save_path: str = "",
    timeout_seconds: int = DEFAULT_REQUEST_TIMEOUT_SECONDS,
    accept: str = "application/json",
) -> BrokerResponse:
    if not broker_helper_available():
        raise AgnesImageError(
            "Agnes image network actions must run inside AgentVis brokerOnly mode so the broker can apply the configured Agnes API key."
        )

    helper = os.environ.get("AGENTVIS_BROKER_FETCH") or "agentvis-broker-fetch"
    request: dict[str, Any] = {
        "method": method.upper(),
        "url": url,
        "headers": [
            {"name": "Accept", "value": accept},
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
        raise AgnesImageError(f"Broker helper returned invalid JSON: {exc}") from exc

    if completed.returncode != 0 or payload.get("ok") is not True:
        error = payload.get("error") or completed.stderr or "unknown broker helper failure"
        normalized_error = str(error).lower()
        reason_code = str(payload.get("reasonCode") or "").strip()
        if (
            reason_code in {"broker_credential_missing", "broker_credential_rejected"}
            or "credentialref 'agnes' is required" in normalized_error
            or "credentialref \"agnes\" is required" in normalized_error
            or ("agnes" in normalized_error and "no credential is configured" in normalized_error)
        ):
            raise AgnesImageError(
                "Agnes API key is not configured in AgentVis. Ask the user to open the AgentVis settings panel, "
                "configure the Agnes AI API key for provider 'agnes', and then rerun this skill."
            )
        raise AgnesImageError(f"Broker helper request failed: {error}{broker_failure_diagnostics(payload, url)}")

    return BrokerResponse(
        status_code=int(payload.get("status") or 0),
        headers=normalize_headers(payload.get("headers") or []),
        body=base64.b64decode(payload.get("bodyBase64") or ""),
        credential_applied=bool(payload.get("credentialApplied")),
        saved_path=str(payload.get("savedPath") or ""),
        bytes_in=int(payload.get("bytesIn") or 0),
        final_url=str(payload.get("finalUrl") or ""),
    )


def parse_error_message(response: BrokerResponse) -> str:
    try:
        data = response.json()
        if isinstance(data, dict):
            nested_error = data.get("error")
            if isinstance(nested_error, dict):
                return str(nested_error.get("message") or nested_error)
            return str(data.get("message") or nested_error or response.text[:500])
    except (json.JSONDecodeError, ValueError):
        pass
    return response.text[:500] or "empty response"


def ensure_success(response: BrokerResponse) -> None:
    if 200 <= response.status_code < 300:
        return
    message = parse_error_message(response)
    if response.status_code in {401, 403}:
        message = (
            f"{message}\n"
            "The configured Agnes API key is missing, invalid, expired, or was not applied by the broker. "
            "Update the AgentVis Agnes API key setting and try again."
        )
    if response.status_code == 429:
        message = f"{message}\nAgnes rate limit or quota was exceeded. Retry later or check the Agnes account quota."
    raise AgnesImageError(message, response.status_code)


def is_data_uri(value: str) -> bool:
    return value.lower().startswith(DATA_URI_PREFIX) and ";base64," in value[:100].lower()


def validate_image_reference(value: str, field_name: str) -> None:
    if is_data_uri(value):
        return
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.netloc:
        raise AgnesImageError(f"{field_name} must be a public HTTPS URL or a data:image/*;base64 Data URI.")
    host = parsed.hostname or ""
    if host in {"localhost", "127.0.0.1", "::1"} or host.endswith(".local"):
        raise AgnesImageError(f"{field_name} must not point to a local-only host.")


def validate_generated_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise AgnesImageError("Generated image URL must be HTTPS before it can be downloaded.")


def parse_images(value: str) -> list[str]:
    cleaned = value.strip()
    if not cleaned:
        return []
    if cleaned.startswith("["):
        try:
            data = json.loads(cleaned)
        except json.JSONDecodeError as exc:
            raise AgnesImageError(f"images must be a JSON array, newline-separated list, or comma-separated list: {exc}") from exc
        if not isinstance(data, list) or not all(isinstance(item, str) for item in data):
            raise AgnesImageError("images JSON must be an array of URL/Data URI strings")
        return [item.strip() for item in data if item.strip()]
    separators = "\n" if "\n" in cleaned else ","
    return [item.strip() for item in cleaned.split(separators) if item.strip()]


def mime_type_for_path(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(path.name)
    if guessed and guessed.startswith("image/"):
        return guessed
    suffix = path.suffix.lower()
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".bmp": "image/bmp",
    }.get(suffix, "image/png")


def jpeg_dimensions_from_file(handle: Any) -> tuple[int, int] | None:
    if handle.read(2) != b"\xff\xd8":
        return None

    start_of_frame_markers = {
        0xC0,
        0xC1,
        0xC2,
        0xC3,
        0xC5,
        0xC6,
        0xC7,
        0xC9,
        0xCA,
        0xCB,
        0xCD,
        0xCE,
        0xCF,
    }

    while True:
        prefix = handle.read(1)
        if not prefix:
            return None
        if prefix != b"\xff":
            continue

        marker = handle.read(1)
        while marker == b"\xff":
            marker = handle.read(1)
        if not marker:
            return None

        marker_byte = marker[0]
        if marker_byte in {0xD8, 0xD9} or 0xD0 <= marker_byte <= 0xD7:
            continue

        segment_length_raw = handle.read(2)
        if len(segment_length_raw) != 2:
            return None
        segment_length = struct.unpack(">H", segment_length_raw)[0]
        if segment_length < 2:
            return None

        if marker_byte in start_of_frame_markers:
            frame_header = handle.read(5)
            if len(frame_header) != 5:
                return None
            height, width = struct.unpack(">HH", frame_header[1:5])
            return width, height

        handle.seek(segment_length - 2, os.SEEK_CUR)


def image_dimensions(path_value: str) -> tuple[int, int] | None:
    if not path_value:
        return None

    path = Path(path_value)
    try:
        with path.open("rb") as handle:
            header = handle.read(64)
            if header.startswith(b"\x89PNG\r\n\x1a\n") and len(header) >= 24:
                width, height = struct.unpack(">II", header[16:24])
                return width, height
            if header[:6] in {b"GIF87a", b"GIF89a"} and len(header) >= 10:
                width, height = struct.unpack("<HH", header[6:10])
                return width, height
            if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
                if header[12:16] == b"VP8X" and len(header) >= 30:
                    width = int.from_bytes(header[24:27], "little") + 1
                    height = int.from_bytes(header[27:30], "little") + 1
                    return width, height
                if header[12:16] == b"VP8L" and len(header) >= 25 and header[20] == 0x2F:
                    bits = int.from_bytes(header[21:25], "little")
                    width = (bits & 0x3FFF) + 1
                    height = ((bits >> 14) & 0x3FFF) + 1
                    return width, height
                if header[12:16] == b"VP8 " and len(header) >= 30:
                    width = int.from_bytes(header[26:28], "little") & 0x3FFF
                    height = int.from_bytes(header[28:30], "little") & 0x3FFF
                    return width, height
            if header.startswith(b"\xff\xd8"):
                handle.seek(0)
                return jpeg_dimensions_from_file(handle)
    except (OSError, struct.error):
        return None
    return None


def add_image_dimension_metadata(target: dict[str, Any]) -> None:
    dimensions = image_dimensions(str(target.get("savedPath") or ""))
    if not dimensions:
        return
    width, height = dimensions
    target["actualWidth"] = width
    target["actualHeight"] = height
    target["actualSize"] = f"{width}x{height}"


def image_path_to_data_uri(raw_path: str) -> str:
    path = Path(raw_path).expanduser()
    if not path.exists() or not path.is_file():
        raise AgnesImageError(f"imagePath does not exist or is not a file: {raw_path}")
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type_for_path(path)};base64,{data}"


def build_input_images(args: Any) -> list[str]:
    images: list[str] = []
    if args.image.strip():
        images.append(args.image.strip())
    images.extend(parse_images(args.images))
    if args.image_path.strip():
        images.append(image_path_to_data_uri(args.image_path.strip()))

    for index, value in enumerate(images, 1):
        validate_image_reference(value, f"images[{index}]")
    return images


def sanitize_filename(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip(".-")
    return cleaned[:120] or "agnes-image"


def image_extension_from_url(url: str) -> str:
    parsed = urlparse(url)
    name = Path(unquote(parsed.path)).name if parsed.path else ""
    suffix = Path(name).suffix.lower()
    if suffix in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
        return suffix
    return ".png"


def workdir() -> Path:
    return Path(os.environ.get("AGENTVIS_WORKDIR") or os.getcwd()).resolve()


def default_image_filename(custom_name: str = "", image_url: str = "") -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    stem = sanitize_filename(custom_name) if custom_name.strip() else f"agnes-image-{timestamp}"
    return f"{stem}{image_extension_from_url(image_url)}"


def ensure_under_workdir(path: Path) -> Path:
    base = workdir()
    resolved = path.resolve()
    try:
        resolved.relative_to(base)
    except ValueError as exc:
        raise AgnesImageError(f"savePath must stay under the AgentVis workdir: {base}") from exc
    return resolved


def resolve_save_path(save_path: str, *, custom_name: str = "", image_url: str = "") -> str:
    base = workdir()
    default_name = default_image_filename(custom_name, image_url)
    raw = save_path.strip()
    if not raw:
        path = base / "agnes-image" / default_name
    else:
        candidate = Path(raw)
        if not candidate.is_absolute():
            candidate = base / "agnes-image" / candidate
        if raw.endswith(("/", "\\")) or candidate.name in {"", ".", ".."}:
            candidate = candidate / default_name
        if candidate.suffix == "":
            candidate = candidate.with_suffix(image_extension_from_url(image_url))
        path = candidate
    return str(ensure_under_workdir(path))


def size_from_aspect_ratio(aspect_ratio: str, image_size: str) -> str:
    ratio = aspect_ratio.strip() or "1:1"
    tier = image_size.strip() or "1K"
    if tier.lower() == "auto":
        return DEFAULT_SIZE
    if re.fullmatch(r"\d{2,5}x\d{2,5}", tier):
        return tier

    normalized_ratio = {
        "1:4": "9:16",
        "1:8": "9:16",
        "4:1": "16:9",
        "8:1": "16:9",
    }.get(ratio, ratio)
    table = {
        "2K": {
            "1:1": "2048x2048",
            "16:9": "2048x1152",
            "9:16": "1152x2048",
            "4:3": "2048x1536",
            "3:4": "1536x2048",
            "3:2": "2048x1360",
            "2:3": "1360x2048",
            "4:5": "1632x2048",
            "5:4": "2048x1632",
            "21:9": "2560x1088",
        },
        "4K": {
            "1:1": "2880x2880",
            "16:9": "3840x2160",
            "9:16": "2160x3840",
            "4:3": "3072x2304",
            "3:4": "2304x3072",
            "3:2": "3520x2352",
            "2:3": "2352x3520",
            "4:5": "2576x3216",
            "5:4": "3216x2576",
            "21:9": "3840x1648",
        },
        "1K": {
            "1:1": "1024x1024",
            "16:9": "1536x864",
            "9:16": "864x1536",
            "4:3": "1280x960",
            "3:4": "960x1280",
            "3:2": "1536x1024",
            "2:3": "1024x1536",
            "4:5": "1024x1280",
            "5:4": "1280x1024",
            "21:9": "1792x768",
        },
    }
    return table.get(tier, table["1K"]).get(normalized_ratio, DEFAULT_SIZE)


def resolve_size(args: Any) -> str:
    explicit = args.size.strip()
    if explicit:
        if not re.fullmatch(r"\d{2,5}x\d{2,5}", explicit):
            raise AgnesImageError("size must use WIDTHxHEIGHT format, such as 1024x1024")
        return explicit
    return size_from_aspect_ratio(args.aspect_ratio, args.image_size)


def build_payload(args: Any) -> dict[str, Any]:
    prompt = args.prompt.strip()
    if not prompt:
        raise AgnesImageError(f"action={args.action} requires --prompt")

    payload: dict[str, Any] = {
        "model": args.model.strip() or DEFAULT_MODEL,
        "prompt": prompt,
        "size": resolve_size(args),
        "extra_body": {
            "response_format": "url",
        },
    }

    images = build_input_images(args)
    if images:
        payload["extra_body"]["image"] = images

    validate_payload_size(payload)
    return payload


def validate_payload_size(payload: dict[str, Any]) -> None:
    body_size = len(json.dumps(payload).encode("utf-8"))
    if body_size <= REQUEST_BODY_SAFETY_BYTES:
        return
    raise AgnesImageError(
        "Agnes image request body is too large for the AgentVis broker. "
        f"Request body is {body_size} bytes; broker limit is {MAX_BROKER_REQUEST_BODY_BYTES} bytes. "
        "Use a public HTTPS image URL for image-to-image. If editing a prior Agnes output, read "
        "workdir/agnes-image/latest-url.md or the sidecar .url.md and pass the generated HTTPS URL as image; "
        "do not compress or re-encode the downloaded local copy. For other local-reference workflows, use generate_image."
    )


def extract_first_image_item(data: dict[str, Any]) -> dict[str, Any]:
    items = data.get("data")
    if not isinstance(items, list) or not items or not isinstance(items[0], dict):
        raise AgnesImageError("Agnes image response did not include data[0]")
    return items[0]


def create_image(payload: dict[str, Any], timeout_seconds: int) -> tuple[dict[str, Any], bool]:
    response = broker_request(
        "POST",
        f"{API_BASE_URL}/images/generations",
        payload,
        credential_ref="agnes",
        timeout_seconds=timeout_seconds,
    )
    ensure_success(response)
    data = response.json()
    if not isinstance(data, dict):
        raise AgnesImageError("Agnes image response was not a JSON object")
    return data, response.credential_applied


def save_base64_image(b64_json: str, save_path: str) -> dict[str, Any]:
    resolved = ensure_under_workdir(Path(save_path))
    resolved.parent.mkdir(parents=True, exist_ok=True)
    raw = base64.b64decode(b64_json)
    resolved.write_bytes(raw)
    return {
        "savedPath": str(resolved),
        "bytes": len(raw),
        "status": 200,
        "finalUrl": "",
    }


def download_image_url(image_url: str, save_path: str) -> dict[str, Any]:
    cleaned_url = image_url.strip()
    validate_generated_url(cleaned_url)
    response = broker_request(
        "GET",
        cleaned_url,
        save_path=save_path,
        timeout_seconds=MAX_REQUEST_TIMEOUT_SECONDS,
        accept="image/*,*/*",
    )
    if not 200 <= response.status_code < 300 and response.saved_path:
        try:
            os.remove(response.saved_path)
        except OSError:
            pass
    ensure_success(response)
    if not response.saved_path:
        raise AgnesImageError("Broker did not report a saved path for the image download")
    return {
        "savedPath": response.saved_path,
        "bytes": response.bytes_in,
        "status": response.status_code,
        "finalUrl": response.final_url or cleaned_url,
    }


def display_image_ref(value: str) -> str:
    if is_data_uri(value):
        return "data:image/*;base64,..."
    return value


def markdown_note(result: dict[str, Any]) -> str:
    source_images = result.get("sourceImages") or []
    source_lines = "\n".join(f"- {display_image_ref(str(item))}" for item in source_images) or "- none"
    requested_size = str(result.get("requestedSize") or "").strip()
    size_lines = []
    if requested_size:
        size_lines.append(f"Requested size: `{requested_size}`")
    size_lines.append(f"Actual image size: `{result.get('actualSize') or 'unknown'}`")
    size_metadata = "\n        ".join(size_lines)
    return textwrap.dedent(f"""\
        # Agnes Image URL

        Generated at: {result.get("createdAt")}

        Generated URL:

        ```text
        {result.get("generatedUrl") or ""}
        ```

        Local image path:

        ```text
        {result.get("savedPath") or ""}
        ```

        Model: `{result.get("model")}`
        {size_metadata}
        Resolution policy: {result.get("resolutionPolicy") or "Report actualSize as the real output resolution."}

        Prompt:

        ```text
        {result.get("prompt") or ""}
        ```

        Source images:

        {source_lines}

        Future edit hint: pass the generated URL above as `image` to `agnes-image` with a new `prompt`.
        """)


def write_url_notes(result: dict[str, Any]) -> dict[str, str]:
    base = workdir() / "agnes-image"
    base.mkdir(parents=True, exist_ok=True)

    saved_path = str(result.get("savedPath") or "").strip()
    if saved_path:
        sidecar = Path(saved_path).with_suffix(".url.md")
    else:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        sidecar = base / f"agnes-image-{timestamp}.url.md"
    sidecar = ensure_under_workdir(sidecar)
    sidecar.parent.mkdir(parents=True, exist_ok=True)
    sidecar.write_text(markdown_note(result), encoding="utf-8")

    latest = ensure_under_workdir(base / "latest-url.md")
    latest.write_text(markdown_note(result), encoding="utf-8")
    return {
        "urlNotePath": str(sidecar),
        "latestUrlPath": str(latest),
    }


def generate(args: Any) -> dict[str, Any]:
    payload = build_payload(args)
    timeout_seconds = bounded_timeout(args.request_timeout)
    response_data, credential_applied = create_image(payload, timeout_seconds)
    item = extract_first_image_item(response_data)
    generated_url = str(item.get("url") or "").strip()
    b64_json = str(item.get("b64_json") or "").strip()

    if not generated_url and not b64_json:
        raise AgnesImageError("Agnes image response did not include data[0].url or data[0].b64_json")

    download: dict[str, Any] | None = None
    saved_path = ""
    if not args.skip_download:
        save_path = resolve_save_path(args.save_path, custom_name=args.custom_name, image_url=generated_url)
        if generated_url:
            download = download_image_url(generated_url, save_path)
        else:
            download = save_base64_image(b64_json, save_path)
        saved_path = str(download.get("savedPath") or "")
        add_image_dimension_metadata(download)

    result: dict[str, Any] = {
        "action": "generate",
        "model": payload["model"],
        "prompt": payload["prompt"],
        "requestedSize": payload["size"],
        "sizeNote": SIZE_NOTE,
        "resolutionPolicy": GENERATION_RESOLUTION_POLICY,
        "generatedUrl": generated_url,
        "savedPath": saved_path,
        "credentialApplied": credential_applied,
        "sourceImages": payload.get("extra_body", {}).get("image", []),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "apiCreated": response_data.get("created"),
    }
    if download:
        result["download"] = download
        for key in ("actualWidth", "actualHeight", "actualSize"):
            if key in download:
                result[key] = download[key]
    if generated_url:
        result.update(write_url_notes(result))
    return result


def download_url(args: Any) -> dict[str, Any]:
    image_url = (args.image_url or args.image).strip()
    if not image_url:
        raise AgnesImageError("action=download-url requires --imageUrl or --image")
    validate_generated_url(image_url)
    save_path = resolve_save_path(args.save_path, custom_name=args.custom_name, image_url=image_url)
    download = download_image_url(image_url, save_path)
    add_image_dimension_metadata(download)
    result: dict[str, Any] = {
        "action": "download-url",
        "model": "",
        "prompt": args.prompt.strip(),
        "generatedUrl": image_url,
        "savedPath": download.get("savedPath") or "",
        "credentialApplied": False,
        "sizeNote": SIZE_NOTE,
        "resolutionPolicy": DOWNLOAD_RESOLUTION_POLICY,
        "sourceImages": [],
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "download": download,
    }
    for key in ("actualWidth", "actualHeight", "actualSize"):
        if key in download:
            result[key] = download[key]
    result.update(write_url_notes(result))
    return result


def compact_payload_for_display(payload: dict[str, Any]) -> dict[str, Any]:
    cloned = json.loads(json.dumps(payload))
    images = cloned.get("extra_body", {}).get("image")
    if isinstance(images, list):
        cloned["extra_body"]["image"] = [display_image_ref(str(item)) for item in images]
    return cloned


def format_text(result: dict[str, Any]) -> str:
    action = result.get("action")
    if action == "payload":
        return "# Agnes Image Payload Preview\n\n" + json.dumps(result.get("payload"), ensure_ascii=False, indent=2)

    lines = [
        f"# Agnes Image {action}",
        "",
        f"credentialApplied: {bool(result.get('credentialApplied'))}",
    ]
    if result.get("model"):
        lines.append(f"model: {result.get('model')}")
    if result.get("requestedSize"):
        lines.append(f"requestedSize: {result.get('requestedSize')}")
    if result.get("actualSize"):
        lines.append(f"actualSize: {result.get('actualSize')}")
    elif result.get("savedPath") or result.get("generatedUrl") or result.get("requestedSize"):
        lines.append("actualSize: unknown")
    if result.get("sizeNote"):
        lines.append(f"sizeNote: {result.get('sizeNote')}")
    if result.get("resolutionPolicy"):
        lines.append(f"resolutionPolicy: {result.get('resolutionPolicy')}")
    if result.get("generatedUrl"):
        lines.extend(["", f"generated_url: {result.get('generatedUrl')}"])
    if result.get("savedPath"):
        lines.append(f"savedPath: {result.get('savedPath')}")
    if result.get("urlNotePath"):
        lines.append(f"urlNotePath: {result.get('urlNotePath')}")
    if result.get("latestUrlPath"):
        lines.append(f"latestUrlPath: {result.get('latestUrlPath')}")
    download = result.get("download")
    if isinstance(download, dict):
        lines.extend([
            "",
            "Downloaded image:",
            f"bytes: {download.get('bytes')}",
            f"finalUrl: {download.get('finalUrl') or result.get('generatedUrl')}",
        ])
    if result.get("generatedUrl"):
        lines.extend([
            "",
            "Future edit: pass generated_url as the agnes-image `image` argument with a new prompt.",
        ])
    return "\n".join(lines)


def print_result(result: dict[str, Any], output_format: str) -> None:
    if output_format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    print(format_text(result))


def run(args: Any) -> int:
    action = args.action.strip().lower()
    output_format = (args.output_format or "text").strip().lower()
    if output_format not in {"text", "json"}:
        raise AgnesImageError("outputFormat must be text or json")
    if action not in {"payload", "generate", "download-url"}:
        raise AgnesImageError("Unsupported action. Use payload, generate, or download-url.")
    args.action = action

    if action == "payload":
        payload = build_payload(args)
        print_result({"action": "payload", "payload": compact_payload_for_display(payload)}, output_format)
        return 0
    if action == "generate":
        print_result(generate(args), output_format)
        return 0
    if action == "download-url":
        print_result(download_url(args), output_format)
        return 0

    raise AgnesImageError(f"Unsupported action: {action}")
