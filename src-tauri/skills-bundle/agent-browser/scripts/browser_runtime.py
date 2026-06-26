"""AgentVis browser runtime launcher.

Starts or reuses a Chrome instance with a local CDP endpoint without killing the
user's normal Chrome. The default profile is kept stable so login state can be
reused across tasks.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import secrets
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_PORT = 9222
DEFAULT_VIEWPORT = "1600x1000"
DEFAULT_WINDOW_STATE = "offscreen"
DEFAULT_READY_TIMEOUT_SECS = 60.0
BACKGROUND_RENDERING_CHROME_ARGS = [
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-features=CalculateNativeWinOcclusion",
]
STATE_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "AgentVis" / "browser-runtime"
STATE_FILE = STATE_DIR / "state.json"
CONTROLLED_PROXY_EXTENSION_DIR = STATE_DIR / "controlled-proxy-auth-extension"


def session_name(port: int) -> str:
    return f"agentvis-cdp-{port}"


def command_wrapper_path() -> Path:
    return Path(__file__).with_name("browser-command.bat")


def agent_browser_command_prefix(port: int, session: str, controlled_network: bool) -> str:
    if controlled_network:
        return f'cmd /c "{command_wrapper_path()}"'
    return f"agent-browser --session {session} --cdp {port}"


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def parse_viewport(value: str) -> tuple[int, int] | None:
    if not value:
        return None
    normalized = value.lower().replace(",", "x").replace("*", "x").strip()
    parts = [part.strip() for part in normalized.split("x") if part.strip()]
    if len(parts) != 2:
        raise RuntimeError(f"Invalid viewport '{value}'. Use WIDTHxHEIGHT, for example 1600x1000.")
    width, height = int(parts[0]), int(parts[1])
    if width < 320 or height < 240:
        raise RuntimeError("Viewport is too small. Use at least 320x240.")
    return width, height


def viewport_text(viewport: tuple[int, int] | None) -> str | None:
    if not viewport:
        return None
    return f"{viewport[0]}x{viewport[1]}"


def merge_chrome_args(extra_args: list[str]) -> list[str]:
    merged: list[str] = []
    seen: set[str] = set()
    for value in [*BACKGROUND_RENDERING_CHROME_ARGS, *extra_args]:
        if value in seen:
            continue
        merged.append(value)
        seen.add(value)
    return merged


def resolve_agent_browser_command() -> str:
    command = shutil.which("agent-browser.cmd") or shutil.which("agent-browser")
    if not command:
        raise RuntimeError("agent-browser command not found in PATH.")
    return command


def effective_window_state(args: argparse.Namespace) -> str:
    if getattr(args, "maximized", False):
        return "maximized"
    if getattr(args, "visible", False) and args.window_state in {"minimized", "offscreen"}:
        return "normal"
    return args.window_state


def stable_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def controlled_network_enabled() -> bool:
    return (
        os.environ.get("AGENTVIS_SANDBOX_MODE") == "ControlledNetwork"
        and os.environ.get("AGENTVIS_NETWORK_PROXY_MODE") == "broker"
    )


def browser_proxy_server() -> str:
    return os.environ.get("AGENTVIS_BROWSER_PROXY_SERVER", "").strip()


def proxy_url_has_credentials(value: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError:
        return False
    return bool(parsed.username or parsed.password or "@" in parsed.netloc)


def validate_controlled_proxy_server(server: str) -> None:
    if not server:
        raise RuntimeError("Controlled-network browser runtime requires AGENTVIS_BROWSER_PROXY_SERVER.")
    parsed = urllib.parse.urlsplit(server)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or not parsed.port:
        raise RuntimeError("AGENTVIS_BROWSER_PROXY_SERVER must be an HTTP(S) server URL without credentials.")
    if proxy_url_has_credentials(server):
        raise RuntimeError("AGENTVIS_BROWSER_PROXY_SERVER must not contain credentials.")


def validate_controlled_chrome_args(extra_args: list[str]) -> None:
    blocked_prefixes = (
        "--proxy-server",
        "--proxy-bypass-list",
        "--proxy-pac-url",
        "--no-proxy-server",
        "--load-extension",
        "--disable-extensions",
        "--disable-extensions-except",
    )
    for arg in extra_args:
        lower = arg.strip().lower()
        if any(lower == prefix or lower.startswith(f"{prefix}=") for prefix in blocked_prefixes):
            raise RuntimeError(f"Chrome arg '{arg}' is not allowed in controlled-network browser runtime.")
        if proxy_url_has_credentials(arg):
            raise RuntimeError("Chrome proxy credential URLs are not allowed in controlled-network browser runtime.")


def write_proxy_auth_extension(username: str, password: str) -> Path | None:
    if not username and not password:
        return None
    CONTROLLED_PROXY_EXTENSION_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {
        "manifest_version": 3,
        "name": "AgentVis Controlled Browser Proxy Auth",
        "version": "1.0.0",
        "permissions": ["webRequest", "webRequestAuthProvider"],
        "host_permissions": ["<all_urls>"],
        "background": {"service_worker": "background.js"},
    }
    background = f"""
chrome.webRequest.onAuthRequired.addListener(
  function(details, callback) {{
    callback({{
      authCredentials: {{
        username: {json.dumps(username)},
        password: {json.dumps(password)}
      }}
    }});
  }},
  {{urls: ["<all_urls>"]}},
  ["asyncBlocking"]
);
""".strip()
    (CONTROLLED_PROXY_EXTENSION_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (CONTROLLED_PROXY_EXTENSION_DIR / "background.js").write_text(background, encoding="utf-8")
    return CONTROLLED_PROXY_EXTENSION_DIR


def controlled_proxy_chrome_args() -> tuple[list[str], dict[str, Any]]:
    if not controlled_network_enabled():
        return [], {"controlled_network": False}

    server = browser_proxy_server()
    validate_controlled_proxy_server(server)
    username = os.environ.get("AGENTVIS_BROWSER_PROXY_USERNAME", "")
    password = os.environ.get("AGENTVIS_BROWSER_PROXY_PASSWORD", "")
    args = [f"--proxy-server={server}"]
    if not username and not password:
        try:
            shutil.rmtree(CONTROLLED_PROXY_EXTENSION_DIR)
        except OSError:
            pass
    extension_dir = write_proxy_auth_extension(username, password)
    if extension_dir:
        args.append(f"--load-extension={extension_dir}")
    return args, {
        "controlled_network": True,
        "browser_proxy_server_hash": stable_hash(server),
        "proxy_auth_extension": bool(extension_dir),
    }


def ensure_existing_runtime_matches_controlled_state(previous: dict[str, Any] | None) -> None:
    if not controlled_network_enabled():
        return
    if not previous or not previous.get("controlled_network"):
        raise RuntimeError(
            "Existing browser runtime was not started in controlled-network mode. Run start-chrome-debug.bat stop and retry."
        )
    expected_hash = stable_hash(browser_proxy_server())
    if previous.get("browser_proxy_server_hash") != expected_hash:
        raise RuntimeError(
            "Existing controlled browser runtime is bound to a different broker proxy. Run start-chrome-debug.bat stop and retry."
        )


def controlled_runtime_state_matches(previous: dict[str, Any] | None) -> bool:
    if not controlled_network_enabled():
        return True
    if not previous or not previous.get("controlled_network"):
        return False
    return previous.get("browser_proxy_server_hash") == stable_hash(browser_proxy_server())


def terminate_saved_runtime(state: dict[str, Any] | None) -> bool:
    if not state or not state.get("pid"):
        return False
    try:
        pid = int(state["pid"])
    except (TypeError, ValueError):
        return False

    try:
        port = int(state.get("port") or 0)
    except (TypeError, ValueError):
        port = 0
    if port:
        close_result = graceful_close_runtime(port, timeout_secs=5.0)
        if close_result.get("closed"):
            return True

    if os.name == "nt":
        gentle = subprocess.run(
            ["taskkill", "/PID", str(pid), "/T"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if gentle.returncode == 0:
            time.sleep(1.0)
            if not port or not cdp_info(port):
                return True
        result = subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        result = subprocess.run(
            ["kill", str(pid)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    time.sleep(0.5)
    return result.returncode == 0


def output(data: dict[str, Any], json_only: bool) -> None:
    if json_only:
        print(json.dumps(data, ensure_ascii=False))
        return

    if data.get("success"):
        print(f"[AgentVis Browser Runtime] status: {data.get('status')}")
        if data.get("port"):
            label = "cdp_port" if data.get("cdp_url") else "last_cdp_port"
            print(f"[AgentVis Browser Runtime] {label}: {data.get('port')}")
            print(f"[AgentVis Browser Runtime] profile_dir: {data.get('profile_dir')}")
            print(f"[AgentVis Browser Runtime] cdp_url: {data.get('cdp_url')}")
            if data.get("viewport"):
                print(f"[AgentVis Browser Runtime] viewport: {data.get('viewport')}")
            if data.get("window_state"):
                print(f"[AgentVis Browser Runtime] window_state: {data.get('window_state')}")
            if data.get("cdp_url"):
                print(f"[AgentVis Browser Runtime] session: {data.get('session')}")
                print(f"[AgentVis Browser Runtime] command_prefix: {data.get('command_prefix')}")
                print(f"[AgentVis Browser Runtime] use: {data.get('command_prefix')} <command>")
                print(f"[AgentVis Browser Runtime] wrapper_single_command_only: cmd /c \"{command_wrapper_path()}\" <command>")
        elif data.get("state_file"):
            print(f"[AgentVis Browser Runtime] state_file: {data.get('state_file')}")
        if data.get("opened_url"):
            print(f"[AgentVis Browser Runtime] opened_url: {data.get('opened_url')}")
        if data.get("warning"):
            print(f"[AgentVis Browser Runtime] warning: {data.get('warning')}")
    else:
        print(f"[AgentVis Browser Runtime] error: {data.get('error')}", file=sys.stderr)
    print(json.dumps(data, ensure_ascii=False))


def local_control_urlopen(request: urllib.request.Request | str, timeout: float):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return opener.open(request, timeout=timeout)


def get_json(url: str, timeout: float = 1.0) -> dict[str, Any] | None:
    try:
        with local_control_urlopen(url, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8", errors="replace"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError):
        return None


def cdp_info(port: int) -> dict[str, Any] | None:
    data = get_json(f"http://127.0.0.1:{port}/json/version", timeout=1.0)
    if data and data.get("webSocketDebuggerUrl"):
        return data
    return None


def websocket_send_json(url: str, payload: dict[str, Any], timeout: float = 3.0) -> None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"ws", "wss"} or not parsed.hostname:
        raise RuntimeError(f"Unsupported CDP WebSocket URL: {url}")

    port = parsed.port or (443 if parsed.scheme == "wss" else 80)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    host_header = parsed.hostname if parsed.port is None else f"{parsed.hostname}:{port}"

    raw_sock = socket.create_connection((parsed.hostname, port), timeout=timeout)
    sock = raw_sock
    try:
        if parsed.scheme == "wss":
            sock = ssl.create_default_context().wrap_socket(
                raw_sock,
                server_hostname=parsed.hostname,
            )
        sock.settimeout(timeout)
        key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host_header}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        sock.sendall(request.encode("ascii"))
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = sock.recv(4096)
            if not chunk:
                break
            response += chunk
        if b" 101 " not in response.split(b"\r\n", 1)[0]:
            raise RuntimeError("CDP WebSocket upgrade was rejected.")

        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        header = bytearray([0x81])
        mask_bit = 0x80
        if len(data) < 126:
            header.append(mask_bit | len(data))
        elif len(data) <= 0xFFFF:
            header.append(mask_bit | 126)
            header.extend(struct.pack("!H", len(data)))
        else:
            header.append(mask_bit | 127)
            header.extend(struct.pack("!Q", len(data)))
        mask = secrets.token_bytes(4)
        header.extend(mask)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(data))
        sock.sendall(bytes(header) + masked)
    finally:
        try:
            sock.close()
        except OSError:
            pass


def wait_until_cdp_stops(port: int, timeout_secs: float) -> bool:
    deadline = time.time() + timeout_secs
    while time.time() < deadline:
        if not cdp_info(port):
            return True
        time.sleep(0.25)
    return not bool(cdp_info(port))


def graceful_close_runtime(port: int, timeout_secs: float = 5.0) -> dict[str, Any]:
    info = cdp_info(port)
    if not info:
        return {"attempted": False, "closed": False, "reason": "cdp_not_running"}
    ws_url = info.get("webSocketDebuggerUrl")
    if not isinstance(ws_url, str) or not ws_url:
        return {"attempted": False, "closed": False, "reason": "cdp_browser_ws_missing"}
    try:
        websocket_send_json(
            ws_url,
            {"id": 1, "method": "Browser.close"},
            timeout=min(3.0, timeout_secs),
        )
    except Exception as exc:
        return {"attempted": True, "closed": False, "reason": str(exc)}
    closed = wait_until_cdp_stops(port, timeout_secs)
    return {"attempted": True, "closed": closed, "reason": "browser_close" if closed else "cdp_still_running"}


def is_port_busy(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.25)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def choose_port(preferred: int, strict: bool, allow_existing_cdp: bool = True) -> int:
    if allow_existing_cdp and cdp_info(preferred):
        return preferred
    if not is_port_busy(preferred):
        return preferred
    if strict:
        raise RuntimeError(f"Port {preferred} is already in use and is not a Chrome CDP endpoint.")

    for port in range(49152, 49352):
        if not is_port_busy(port):
            return port
    raise RuntimeError("No free local port found for Chrome CDP.")


def find_chrome() -> str:
    env_path = os.environ.get("AGENTVIS_CHROME_EXE") or os.environ.get("CHROME_EXE")
    if env_path and Path(env_path).exists():
        return env_path

    candidates = [
        Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
        Path(os.environ.get("PROGRAMFILES", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)

    chrome = shutil.which("chrome") or shutil.which("chrome.exe")
    if chrome:
        return chrome
    raise RuntimeError("Chrome not found. Install Chrome or set AGENTVIS_CHROME_EXE.")


def default_profile_dir(profile_name: str) -> Path:
    env_profile = os.environ.get("AGENTVIS_BROWSER_PROFILE_DIR")
    if env_profile:
        return Path(env_profile)

    # Backward compatible with the old AgentVis CDP profile, so users do not
    # lose login state after upgrading the launcher.
    legacy_profile = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "ChromeCDP"
    if profile_name == "default" and legacy_profile.exists():
        return legacy_profile

    safe_name = "".join(ch if ch.isalnum() or ch in ("-", "_", ".") else "_" for ch in profile_name)
    return STATE_DIR / "profiles" / safe_name


def read_state() -> dict[str, Any] | None:
    if not STATE_FILE.exists():
        return None
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def write_state(state: dict[str, Any]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def mark_profile_clean(profile_dir: Path) -> None:
    preference_files = [
        profile_dir / "Default" / "Preferences",
        profile_dir / "Local State",
    ]
    for path in preference_files:
        if not path.exists():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        profile = data.setdefault("profile", {})
        if isinstance(profile, dict):
            profile["exit_type"] = "Normal"
            profile["exited_cleanly"] = True
        data["exited_cleanly"] = True
        try:
            path.write_text(
                json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
        except OSError:
            pass


def windows_virtual_screen_rect() -> dict[str, int] | None:
    if os.name != "nt":
        return None

    import ctypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    left = int(user32.GetSystemMetrics(76))  # SM_XVIRTUALSCREEN
    top = int(user32.GetSystemMetrics(77))  # SM_YVIRTUALSCREEN
    width = int(user32.GetSystemMetrics(78))  # SM_CXVIRTUALSCREEN
    height = int(user32.GetSystemMetrics(79))  # SM_CYVIRTUALSCREEN
    return {
        "left": left,
        "top": top,
        "right": left + width,
        "bottom": top + height,
        "width": width,
        "height": height,
    }


def offscreen_launch_position(viewport: tuple[int, int] | None) -> tuple[int, int] | None:
    virtual_rect = windows_virtual_screen_rect()
    if not virtual_rect:
        return None
    width, height = viewport or (1280, 720)
    margin = 96
    return virtual_rect["left"] - width - margin, virtual_rect["top"] - height - margin


def launch_chrome(
    chrome_exe: str,
    port: int,
    profile_dir: Path,
    window_state: str,
    viewport: tuple[int, int] | None,
    extra_args: list[str],
    controlled_proxy_args: list[str],
    url: str = "",
) -> int | None:
    profile_dir.mkdir(parents=True, exist_ok=True)
    mark_profile_clean(profile_dir)
    singleton_lock = profile_dir / "SingletonLock"
    if singleton_lock.exists():
        try:
            singleton_lock.unlink()
        except OSError:
            pass

    args = [
        chrome_exe,
        f"--remote-debugging-address=127.0.0.1",
        f"--remote-debugging-port={port}",
        "--remote-allow-origins=*",
        f"--user-data-dir={profile_dir}",
        "--no-first-run",
        "--disable-default-apps",
        "--disable-session-crashed-bubble",
    ]
    if viewport:
        args.append(f"--window-size={viewport[0]},{viewport[1]}")
    if window_state == "minimized":
        args.append("--start-minimized")
    elif window_state == "maximized":
        args.append("--start-maximized")
    elif window_state == "offscreen":
        position = offscreen_launch_position(viewport)
        if position:
            args.append(f"--window-position={position[0]},{position[1]}")
    args.extend(merge_chrome_args([*controlled_proxy_args, *extra_args]))
    if url:
        args.append(url)

    creation_flags = 0
    startupinfo = None
    if os.name == "nt":
        creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        if window_state == "minimized":
            startupinfo.wShowWindow = 7  # SW_SHOWMINNOACTIVE
        elif window_state == "maximized":
            startupinfo.wShowWindow = 3  # SW_SHOWMAXIMIZED
        elif window_state == "offscreen":
            startupinfo.wShowWindow = 4  # SW_SHOWNOACTIVATE
        else:
            startupinfo.wShowWindow = 1  # SW_SHOWNORMAL

    proc = subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creation_flags,
        startupinfo=startupinfo,
    )
    return proc.pid


def wait_for_cdp(port: int, timeout_secs: float) -> dict[str, Any] | None:
    deadline = time.time() + timeout_secs
    while time.time() < deadline:
        info = cdp_info(port)
        if info:
            return info
        time.sleep(0.25)
    return None


def run_agent_browser(port: int, session: str, args: list[str], timeout: float = 20) -> dict[str, Any]:
    command = [resolve_agent_browser_command(), "--session", session, "--cdp", str(port), *args]

    try:
        proc = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            else:
                proc.kill()
            stdout, stderr = proc.communicate()
            return {
                "success": False,
                "exit_code": proc.returncode,
                "stdout": stdout.strip(),
                "stderr": stderr.strip(),
                "error": f"agent-browser timed out after {timeout} seconds",
            }
        return {
            "success": proc.returncode == 0,
            "exit_code": proc.returncode,
            "stdout": stdout.strip(),
            "stderr": stderr.strip(),
        }
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def open_url(port: int, url: str, session: str) -> dict[str, Any]:
    if not url:
        return {"opened": False}
    del session
    try:
        encoded_url = urllib.parse.quote(url, safe=":/?#[]@!$&'()*+,;=%")
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/json/new?{encoded_url}",
            method="PUT",
        )
        with local_control_urlopen(request, timeout=5.0) as response:
            data = json.loads(response.read().decode("utf-8", errors="replace"))
        return {
            "success": True,
            "opened": True,
            "method": "cdp_json_new",
            "url": data.get("url") or url,
            "target_id": data.get("id"),
        }
    except Exception as exc:
        return {"success": False, "opened": False, "method": "cdp_json_new", "error": str(exc)}


def open_url_with_window_state(
    port: int,
    url: str,
    session: str,
    pid: int | None,
    window_state: str,
    viewport: tuple[int, int] | None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    if window_state == "minimized":
        url_result = open_url(port, url, session)
        window_result = apply_window_state_stable(pid, window_state, viewport)
        return url_result, window_result

    window_result = apply_window_state_stable(pid, window_state, viewport)
    url_result = open_url(port, url, session) if url else {"opened": False}
    return url_result, window_result


def apply_window_state_stable(
    pid: int | None,
    window_state: str,
    viewport: tuple[int, int] | None,
) -> dict[str, Any]:
    attempts = 3 if window_state in {"minimized", "offscreen"} else 1
    result: dict[str, Any] = {"applied": False, "window_state": window_state}
    for index in range(attempts):
        if index:
            time.sleep(0.25)
        result = apply_window_state(pid, window_state, viewport)
    result["attempts"] = attempts
    return result


def resolved_window_state(requested_window_state: str, window_result: dict[str, Any]) -> str:
    if requested_window_state == "offscreen" and window_result.get("fallback_window_state"):
        return str(window_result["fallback_window_state"])
    return requested_window_state


def apply_window_state(
    pid: int | None,
    window_state: str,
    viewport: tuple[int, int] | None,
) -> dict[str, Any]:
    if os.name != "nt":
        return {"applied": False, "reason": "not_windows", "window_state": window_state}
    if not pid:
        return {"applied": False, "reason": "pid_unavailable", "window_state": window_state}

    import ctypes
    from ctypes import wintypes

    class Rect(ctypes.Structure):
        _fields_ = [
            ("left", wintypes.LONG),
            ("top", wintypes.LONG),
            ("right", wintypes.LONG),
            ("bottom", wintypes.LONG),
        ]

    class MonitorInfo(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("rcMonitor", Rect),
            ("rcWork", Rect),
            ("dwFlags", wintypes.DWORD),
        ]

    def rect_to_dict(rect: Rect) -> dict[str, int]:
        return {
            "left": int(rect.left),
            "top": int(rect.top),
            "right": int(rect.right),
            "bottom": int(rect.bottom),
            "width": int(rect.right - rect.left),
            "height": int(rect.bottom - rect.top),
        }

    def rects_intersect(first: dict[str, int], second: dict[str, int]) -> bool:
        return (
            first["left"] < second["right"]
            and first["right"] > second["left"]
            and first["top"] < second["bottom"]
            and first["bottom"] > second["top"]
        )

    show_commands = {
        "minimized": 7,  # SW_SHOWMINNOACTIVE
        "normal": 9,  # SW_RESTORE
        "maximized": 3,  # SW_SHOWMAXIMIZED
        "offscreen": 4,  # SW_SHOWNOACTIVATE
    }
    show_command = show_commands.get(window_state)
    if not show_command:
        return {"applied": False, "reason": "unsupported_window_state", "window_state": window_state}

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    windows: list[int] = []
    set_position_flags = 0x0004 | 0x0010  # SWP_NOZORDER | SWP_NOACTIVATE
    virtual_screen = windows_virtual_screen_rect()
    monitor_rects: list[dict[str, int]] = []

    @ctypes.WINFUNCTYPE(
        wintypes.BOOL,
        wintypes.HANDLE,
        wintypes.HDC,
        ctypes.POINTER(Rect),
        wintypes.LPARAM,
    )
    def monitor_enum_proc(hmonitor: int, _: int, __: Any, ___: int) -> bool:
        info = MonitorInfo()
        info.cbSize = ctypes.sizeof(MonitorInfo)
        if user32.GetMonitorInfoW(hmonitor, ctypes.byref(info)):
            monitor_rects.append(rect_to_dict(info.rcMonitor))
        return True

    user32.EnumDisplayMonitors(0, 0, monitor_enum_proc, 0)
    if not monitor_rects and virtual_screen:
        monitor_rects.append(virtual_screen)

    def window_rect(hwnd: int) -> dict[str, int] | None:
        rect = Rect()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return None
        return rect_to_dict(rect)

    def offscreen_candidates(width: int, height: int) -> list[tuple[int, int]]:
        if not virtual_screen:
            return []
        margin = 96
        return [
            (virtual_screen["left"] - width - margin, virtual_screen["top"] - height - margin),
            (virtual_screen["right"] + margin, virtual_screen["top"] - height - margin),
            (virtual_screen["left"] - width - margin, virtual_screen["bottom"] + margin),
            (virtual_screen["right"] + margin, virtual_screen["bottom"] + margin),
        ]

    def is_fully_offscreen(rect: dict[str, int]) -> bool:
        return not any(rects_intersect(rect, monitor) for monitor in monitor_rects)

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def enum_proc(hwnd: int, _: int) -> bool:
        if not user32.IsWindowVisible(hwnd):
            return True
        window_pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(window_pid))
        if window_pid.value == pid:
            windows.append(hwnd)
        return True

    user32.EnumWindows(enum_proc, 0)
    offscreen_windows = 0
    fallback_to_minimized = False
    window_rects: list[dict[str, int]] = []
    for hwnd in windows:
        if window_state in {"normal", "offscreen"}:
            user32.ShowWindowAsync(hwnd, 9)  # SW_RESTORE
            time.sleep(0.05)
        if window_state == "offscreen":
            rect = window_rect(hwnd)
            width = viewport[0] if viewport else (rect["width"] if rect else 1280)
            height = viewport[1] if viewport else (rect["height"] if rect else 720)
            placed_rect: dict[str, int] | None = None
            for left, top in offscreen_candidates(width, height):
                user32.SetWindowPos(hwnd, 0, left, top, width, height, set_position_flags)
                time.sleep(0.05)
                placed_rect = window_rect(hwnd)
                if placed_rect and is_fully_offscreen(placed_rect):
                    offscreen_windows += 1
                    break
            if placed_rect:
                window_rects.append(placed_rect)
            if not placed_rect or not is_fully_offscreen(placed_rect):
                fallback_to_minimized = True
                user32.ShowWindowAsync(hwnd, 7)  # SW_SHOWMINNOACTIVE
            else:
                user32.ShowWindowAsync(hwnd, show_command)
        elif viewport and window_state != "maximized":
            user32.SetWindowPos(hwnd, 0, 0, 0, viewport[0], viewport[1], set_position_flags)
            rect = window_rect(hwnd)
            if rect:
                window_rects.append(rect)
        else:
            rect = window_rect(hwnd)
            if rect:
                window_rects.append(rect)
        if window_state not in {"normal", "offscreen"}:
            user32.ShowWindowAsync(hwnd, show_command)

    applied = bool(windows)
    if window_state == "offscreen":
        applied = bool(windows) and offscreen_windows == len(windows)
    result = {
        "applied": applied,
        "window_state": window_state,
        "viewport": viewport_text(viewport),
        "matched_windows": len(windows),
        "window_rects": window_rects,
    }
    if window_state == "offscreen":
        result["offscreen_windows"] = offscreen_windows
        result["virtual_screen"] = virtual_screen
        result["monitor_rects"] = monitor_rects
    if fallback_to_minimized:
        result["fallback_window_state"] = "minimized"
    return result


def ensure(args: argparse.Namespace) -> dict[str, Any]:
    previous = read_state()
    preferred_port = args.port
    viewport = parse_viewport(args.viewport)
    window_state = effective_window_state(args)
    if controlled_network_enabled():
        validate_controlled_chrome_args(args.chrome_arg)
    controlled_proxy_args, controlled_state = controlled_proxy_chrome_args()
    stale_runtime_restarted = False

    if controlled_state.get("controlled_network") and previous:
        previous_port = int(previous.get("port") or 0)
        if previous_port and cdp_info(previous_port) and not controlled_runtime_state_matches(previous):
            stale_runtime_restarted = terminate_saved_runtime(previous)
            previous = None

    if args.reuse_state and previous:
        previous_port = int(previous.get("port") or 0)
        if previous_port and cdp_info(previous_port):
            ensure_existing_runtime_matches_controlled_state(previous)
            previous["last_seen_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            previous["session"] = previous.get("session") or session_name(previous_port)
            previous["command_prefix"] = agent_browser_command_prefix(
                previous_port,
                previous["session"],
                bool(previous.get("controlled_network")),
            )
            previous["viewport"] = viewport_text(viewport)
            url_result, window_result = open_url_with_window_state(
                previous_port,
                args.url,
                previous["session"],
                previous.get("pid"),
                window_state,
                viewport,
            )
            actual_window_state = resolved_window_state(window_state, window_result)
            previous["window_state"] = actual_window_state
            write_state(previous)
            result = {
                "success": True,
                "status": "reused_state",
                "port": previous_port,
                "pid": previous.get("pid"),
                "session": previous["session"],
                "command_prefix": previous["command_prefix"],
                "profile_dir": previous.get("profile_dir"),
                "cdp_url": f"http://127.0.0.1:{previous_port}",
                "viewport": previous["viewport"],
                "window_state": actual_window_state,
                "controlled_network": bool(previous.get("controlled_network")),
                "window_result": window_result,
                "open_result": url_result,
            }
            if actual_window_state != window_state:
                result["requested_window_state"] = window_state
            if stale_runtime_restarted:
                result["warning"] = "stale controlled-network browser runtime was stopped before reuse"
            result["opened_url"] = args.url if url_result.get("opened") else None
            return result

    port = choose_port(
        preferred_port,
        args.strict_port,
        allow_existing_cdp=not controlled_state.get("controlled_network") and window_state != "offscreen",
    )
    existing = cdp_info(port)
    if existing:
        ensure_existing_runtime_matches_controlled_state(previous)
        profile_dir = args.profile_dir or (previous.get("profile_dir") if previous else None)
        session = session_name(port)
        url_result, window_result = open_url_with_window_state(
            port,
            args.url,
            session,
            previous.get("pid") if previous else None,
            window_state,
            viewport,
        )
        actual_window_state = resolved_window_state(window_state, window_result)
        state = {
            "port": port,
            "pid": previous.get("pid") if previous else None,
            "session": session,
            "command_prefix": agent_browser_command_prefix(
                port,
                session,
                bool(controlled_state.get("controlled_network")),
            ),
            "profile_dir": profile_dir,
            "chrome_exe": previous.get("chrome_exe") if previous else None,
            "viewport": viewport_text(viewport),
            "window_state": actual_window_state,
            "last_seen_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            **controlled_state,
        }
        write_state(state)
        result = {
            "success": True,
            "status": "reused_cdp",
            "port": port,
            "pid": state["pid"],
            "session": state["session"],
            "command_prefix": state["command_prefix"],
            "profile_dir": profile_dir,
            "cdp_url": f"http://127.0.0.1:{port}",
            "viewport": state["viewport"],
            "window_state": actual_window_state,
            "controlled_network": bool(state.get("controlled_network")),
            "window_result": window_result,
            "opened_url": args.url if url_result.get("opened") else None,
            "open_result": url_result,
        }
        if actual_window_state != window_state:
            result["requested_window_state"] = window_state
        return result

    chrome_exe = find_chrome()
    profile_dir = Path(args.profile_dir) if args.profile_dir else default_profile_dir(args.profile)
    session = session_name(port)
    launch_url = "" if controlled_state.get("controlled_network") else args.url
    pid = launch_chrome(
        chrome_exe,
        port,
        profile_dir,
        window_state,
        viewport,
        args.chrome_arg,
        controlled_proxy_args,
        launch_url,
    )
    info = wait_for_cdp(port, args.timeout)
    if not info:
        terminate_saved_runtime({"pid": pid})
        raise RuntimeError(f"Chrome started but CDP did not become ready on port {port}.")
    if controlled_state.get("controlled_network") and args.url:
        url_result = open_url(port, args.url, session)
        window_result = apply_window_state_stable(pid, window_state, viewport)
    else:
        url_result = {"opened": bool(args.url), "method": "chrome_launch_arg" if args.url else "none"}
        window_result = apply_window_state_stable(pid, window_state, viewport)
    actual_window_state = resolved_window_state(window_state, window_result)

    state = {
        "port": port,
        "pid": pid,
        "session": session,
        "command_prefix": agent_browser_command_prefix(
            port,
            session,
            bool(controlled_state.get("controlled_network")),
        ),
        "profile": args.profile,
        "profile_dir": str(profile_dir),
        "chrome_exe": chrome_exe,
        "viewport": viewport_text(viewport),
        "window_state": actual_window_state,
        "last_seen_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        **controlled_state,
    }
    write_state(state)
    result = {
        "success": True,
        "status": "launched",
        "port": port,
        "pid": pid,
        "session": session,
        "command_prefix": state["command_prefix"],
        "profile": args.profile,
        "profile_dir": str(profile_dir),
        "chrome_exe": chrome_exe,
        "cdp_url": f"http://127.0.0.1:{port}",
        "viewport": state["viewport"],
        "window_state": actual_window_state,
        "controlled_network": bool(state.get("controlled_network")),
        "window_result": window_result,
        "opened_url": args.url if url_result.get("opened") else None,
        "open_result": url_result,
    }
    if actual_window_state != window_state:
        result["requested_window_state"] = window_state
    if stale_runtime_restarted:
        result["warning"] = "stale controlled-network browser runtime was stopped before relaunch"
    return result


def status(_: argparse.Namespace) -> dict[str, Any]:
    state = read_state()
    if not state:
        return {"success": True, "status": "not_started", "state_file": str(STATE_FILE)}
    port = int(state.get("port") or 0)
    live = bool(port and cdp_info(port))
    controlled_mismatch = (
        live and controlled_network_enabled() and not controlled_runtime_state_matches(state)
    )
    usable = live and not controlled_mismatch
    session = state.get("session") or (session_name(port) if port else None)
    result = {
        "success": True,
        "status": "controlled_network_mismatch" if controlled_mismatch else ("running" if live else "stopped"),
        "port": port or None,
        "session": session,
        "command_prefix": agent_browser_command_prefix(
            port,
            session,
            bool(state.get("controlled_network")),
        )
        if usable and session
        else None,
        "profile_dir": state.get("profile_dir"),
        "viewport": state.get("viewport"),
        "window_state": state.get("window_state"),
        "controlled_network": bool(state.get("controlled_network")),
        "pid": state.get("pid"),
        "cdp_url": f"http://127.0.0.1:{port}" if usable else None,
        "state_file": str(STATE_FILE),
    }
    if controlled_mismatch:
        result["warning"] = (
            "Existing browser runtime is not bound to the current controlled-network proxy. Run ensure to relaunch it."
        )
    return result


def stop(_: argparse.Namespace) -> dict[str, Any]:
    state = read_state()
    if not state or not state.get("pid"):
        return {"success": True, "status": "not_started", "state_file": str(STATE_FILE)}
    pid = int(state["pid"])
    port = int(state.get("port") or 0)
    graceful_result = graceful_close_runtime(port, timeout_secs=6.0) if port else {
        "attempted": False,
        "closed": False,
        "reason": "port_unavailable",
    }
    fallback_used = False
    if os.name == "nt":
        if graceful_result.get("closed"):
            result = subprocess.CompletedProcess(["Browser.close"], 0, "", "")
        else:
            fallback_used = True
            gentle = subprocess.run(
                ["taskkill", "/PID", str(pid), "/T"],
                capture_output=True,
                text=True,
            )
            if gentle.returncode == 0:
                time.sleep(1.0)
            if port and not cdp_info(port):
                result = gentle
            else:
                result = subprocess.run(
                    ["taskkill", "/PID", str(pid), "/T", "/F"],
                    capture_output=True,
                    text=True,
                )
    else:
        if graceful_result.get("closed"):
            result = subprocess.CompletedProcess(["Browser.close"], 0, "", "")
        else:
            fallback_used = True
            result = subprocess.run(["kill", str(pid)], capture_output=True, text=True)
    try:
        shutil.rmtree(CONTROLLED_PROXY_EXTENSION_DIR)
    except OSError:
        pass
    profile_dir = state.get("profile_dir")
    if profile_dir:
        mark_profile_clean(Path(profile_dir))
    state["stopped_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    write_state(state)
    return {
        "success": result.returncode == 0,
        "status": "stopped" if result.returncode == 0 else "stop_failed",
        "pid": pid,
        "graceful_close": graceful_result,
        "fallback_used": fallback_used,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }


def normalize_argv(argv: list[str]) -> list[str]:
    commands = {"ensure", "status", "stop"}
    if not argv:
        return ["ensure"]
    if argv[0] in commands:
        return argv
    if argv[0].startswith("-"):
        return ["ensure", *argv]
    return ["ensure", "--url", argv[0], *argv[1:]]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Start or reuse an AgentVis Chrome CDP runtime.")
    sub = parser.add_subparsers(dest="command", required=True)

    ensure_parser = sub.add_parser("ensure", help="Start or reuse Chrome CDP runtime.")
    ensure_parser.add_argument("--url", default="", help="Optional URL to open after CDP is ready.")
    ensure_parser.add_argument("--port", type=int, default=int(os.environ.get("AGENTVIS_BROWSER_CDP_PORT", DEFAULT_PORT)))
    ensure_parser.add_argument("--strict-port", action="store_true", help="Fail if the requested port is busy.")
    ensure_parser.add_argument("--profile", default=os.environ.get("AGENTVIS_BROWSER_PROFILE", "default"))
    ensure_parser.add_argument("--profile-dir", default=os.environ.get("AGENTVIS_BROWSER_PROFILE_DIR", ""))
    ensure_parser.add_argument("--viewport", default=os.environ.get("AGENTVIS_BROWSER_VIEWPORT", DEFAULT_VIEWPORT),
                               help="Stable browser viewport, for example 1600x1000. Use empty string to disable.")
    ensure_parser.add_argument("--window-state", choices=["offscreen", "minimized", "normal", "maximized"],
                               default=os.environ.get("AGENTVIS_BROWSER_WINDOW_STATE", DEFAULT_WINDOW_STATE),
                               help="Initial Chrome window state. Default is offscreen; falls back to minimized if offscreen placement cannot be verified.")
    ensure_parser.add_argument("--visible", action="store_true", help="Backward compatible alias for --window-state normal.")
    ensure_parser.add_argument("--maximized", action="store_true", help="Shortcut for --window-state maximized.")
    ensure_parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_READY_TIMEOUT_SECS,
        help="Seconds to wait for CDP readiness.",
    )
    ensure_parser.add_argument("--no-reuse-state", dest="reuse_state", action="store_false", default=True)
    ensure_parser.add_argument("--chrome-arg", action="append", default=[], help="Extra Chrome launch arg. Repeatable.")
    ensure_parser.add_argument("--json", action="store_true")

    status_parser = sub.add_parser("status", help="Show saved runtime state.")
    status_parser.add_argument("--json", action="store_true")

    stop_parser = sub.add_parser("stop", help="Stop the Chrome process started by this runtime.")
    stop_parser.add_argument("--json", action="store_true")
    return parser


def main() -> int:
    configure_stdio()
    parser = build_parser()
    args = parser.parse_args(normalize_argv(sys.argv[1:]))
    try:
        if args.command == "ensure":
            result = ensure(args)
        elif args.command == "status":
            result = status(args)
        elif args.command == "stop":
            result = stop(args)
        else:
            raise RuntimeError(f"Unsupported command: {args.command}")
        output(result, bool(getattr(args, "json", False)))
        return 0 if result.get("success") else 1
    except Exception as exc:
        result = {"success": False, "error": str(exc)}
        output(result, bool(getattr(args, "json", False)))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
