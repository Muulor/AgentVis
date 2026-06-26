"""Run agent-browser against the active AgentVis browser runtime."""

from __future__ import annotations

import base64
import json
import os
import secrets
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
STATE_FILE = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "AgentVis" / "browser-runtime" / "state.json"
LOCAL_CONTROL_NO_PROXY = "127.0.0.1,localhost,::1"


def env_float(name: str, default: float) -> float:
    try:
        return max(1.0, float(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


DEFAULT_COMMAND_TIMEOUT_SECS = env_float("AGENTVIS_BROWSER_COMMAND_TIMEOUT", 60.0)
SCREENSHOT_COMMAND_TIMEOUT_SECS = env_float("AGENTVIS_BROWSER_SCREENSHOT_TIMEOUT", 90.0)
SUCCESS_EXIT_GRACE_SECS = env_float("AGENTVIS_BROWSER_SUCCESS_EXIT_GRACE", 2.0)
SCREENCAST_FALLBACK_TIMEOUT_SECS = env_float("AGENTVIS_BROWSER_SCREENCAST_TIMEOUT", 8.0)


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def local_control_env() -> dict[str, str]:
    env = os.environ.copy()
    for key in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "PIP_PROXY",
        "npm_config_proxy",
        "npm_config_https_proxy",
        "NPM_CONFIG_PROXY",
        "NPM_CONFIG_HTTPS_PROXY",
    ):
        env.pop(key, None)
    env["NO_PROXY"] = LOCAL_CONTROL_NO_PROXY
    env["no_proxy"] = LOCAL_CONTROL_NO_PROXY
    env["npm_config_noproxy"] = LOCAL_CONTROL_NO_PROXY
    env["NPM_CONFIG_NOPROXY"] = LOCAL_CONTROL_NO_PROXY
    return env


def local_control_urlopen(request: urllib.request.Request | str, timeout: float):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return opener.open(request, timeout=timeout)


def get_json(url: str, timeout: float = 1.0) -> dict[str, Any] | None:
    try:
        with local_control_urlopen(url, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8", errors="replace"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError):
        return None


def read_exact(sock: socket.socket, size: int) -> bytes:
    data = bytearray()
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise RuntimeError("CDP WebSocket closed unexpectedly.")
        data.extend(chunk)
    return bytes(data)


class CdpConnection:
    def __init__(self, url: str, timeout: float) -> None:
        self.url = url
        self.timeout = timeout
        self.next_id = 0
        self.sock: socket.socket | ssl.SSLSocket | None = None

    def __enter__(self) -> "CdpConnection":
        parsed = urllib.parse.urlparse(self.url)
        if parsed.scheme not in {"ws", "wss"} or not parsed.hostname:
            raise RuntimeError(f"Unsupported CDP WebSocket URL: {self.url}")

        port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        host_header = parsed.hostname if parsed.port is None else f"{parsed.hostname}:{port}"

        raw_sock = socket.create_connection((parsed.hostname, port), timeout=self.timeout)
        sock: socket.socket | ssl.SSLSocket = raw_sock
        if parsed.scheme == "wss":
            sock = ssl.create_default_context().wrap_socket(raw_sock, server_hostname=parsed.hostname)
        sock.settimeout(self.timeout)
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
            response += read_exact(sock, 1)
        if b" 101 " not in response.split(b"\r\n", 1)[0]:
            raise RuntimeError("CDP WebSocket upgrade was rejected.")
        self.sock = sock
        return self

    def __exit__(self, *_: object) -> None:
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass

    def send_raw(self, payload: dict[str, Any]) -> None:
        if not self.sock:
            raise RuntimeError("CDP WebSocket is not connected.")

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
        self.sock.sendall(bytes(header) + masked)

    def recv_raw(self) -> dict[str, Any]:
        if not self.sock:
            raise RuntimeError("CDP WebSocket is not connected.")

        while True:
            first, second = read_exact(self.sock, 2)
            opcode = first & 0x0F
            masked = bool(second & 0x80)
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", read_exact(self.sock, 2))[0]
            elif length == 127:
                length = struct.unpack("!Q", read_exact(self.sock, 8))[0]
            mask = read_exact(self.sock, 4) if masked else b""
            payload = read_exact(self.sock, length) if length else b""
            if masked:
                payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
            if opcode == 8:
                raise RuntimeError("CDP WebSocket was closed.")
            if opcode not in {1, 2}:
                continue
            return json.loads(payload.decode("utf-8", errors="replace"))

    def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self.next_id += 1
        message_id = self.next_id
        self.send_raw({"id": message_id, "method": method, "params": params or {}})
        while True:
            message = self.recv_raw()
            if message.get("id") != message_id:
                continue
            if message.get("error"):
                raise RuntimeError(f"CDP {method} failed: {message['error']}")
            result = message.get("result")
            return result if isinstance(result, dict) else {}


def page_targets(port: int) -> list[dict[str, Any]]:
    data = get_json(f"http://127.0.0.1:{port}/json/list", timeout=2.0)
    if not isinstance(data, list):
        return []
    return [target for target in data if target.get("type") == "page" and target.get("webSocketDebuggerUrl")]


def active_page_websocket_url(port: int) -> str | None:
    targets = page_targets(port)
    if not targets:
        return None
    return str(targets[0]["webSocketDebuggerUrl"])


def current_window_state(port: int) -> str | None:
    ws_url = active_page_websocket_url(port)
    if not ws_url:
        return None
    try:
        with CdpConnection(ws_url, SCREENCAST_FALLBACK_TIMEOUT_SECS) as cdp:
            window = cdp.call("Browser.getWindowForTarget")
            window_id = window.get("windowId")
            if window_id is None:
                return None
            bounds = cdp.call("Browser.getWindowBounds", {"windowId": window_id}).get("bounds")
            if isinstance(bounds, dict):
                state = bounds.get("windowState")
                return str(state) if state else None
    except Exception:
        return None
    return None


def load_state() -> dict[str, Any]:
    if not STATE_FILE.exists():
        raise RuntimeError(f"Browser runtime is not started. Missing state file: {STATE_FILE}")
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Cannot read browser runtime state: {exc}") from exc


def session_name(port: int) -> str:
    return f"agentvis-cdp-{port}"


def is_screenshot_command(argv: list[str]) -> bool:
    return "screenshot" in argv


def screenshot_command_index(argv: list[str]) -> int | None:
    try:
        return argv.index("screenshot")
    except ValueError:
        return None


def screenshot_arg_value(argv: list[str], option: str) -> str | None:
    for index, value in enumerate(argv):
        if value == option and index + 1 < len(argv):
            return argv[index + 1]
        if value.startswith(f"{option}="):
            return value.split("=", 1)[1]
    return None


def screenshot_format(argv: list[str], output_path: Path) -> str:
    requested = screenshot_arg_value(argv, "--screenshot-format")
    if requested:
        normalized = requested.lower()
        return "jpeg" if normalized in {"jpg", "jpeg"} else "png"
    return "jpeg" if output_path.suffix.lower() in {".jpg", ".jpeg"} else "png"


def screenshot_output_path(argv: list[str]) -> Path:
    screenshot_index = screenshot_command_index(argv)
    if screenshot_index is None:
        raise RuntimeError("Not a screenshot command.")

    options_with_values = {
        "--screenshot-dir",
        "--screenshot-format",
        "--screenshot-quality",
        "--quality",
    }
    index = screenshot_index + 1
    while index < len(argv):
        value = argv[index]
        if value in options_with_values:
            index += 2
            continue
        if any(value.startswith(f"{option}=") for option in options_with_values):
            index += 1
            continue
        if value.startswith("-"):
            index += 1
            continue
        return Path(value).expanduser().resolve()

    screenshot_dir = screenshot_arg_value(argv, "--screenshot-dir")
    output_dir = Path(screenshot_dir).expanduser().resolve() if screenshot_dir else Path(tempfile.gettempdir())
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    suffix = ".jpg" if (screenshot_arg_value(argv, "--screenshot-format") or "").lower() in {"jpg", "jpeg"} else ".png"
    return output_dir / f"agentvis-screencast-{timestamp}-{os.getpid()}{suffix}"


def write_screenshot_result(argv: list[str], path: Path, fallback: str, warnings: list[str]) -> None:
    if "--json" in argv:
        payload: dict[str, Any] = {
            "success": True,
            "data": {
                "path": str(path),
                "fallback": fallback,
            },
            "error": None,
        }
        if warnings:
            payload["data"]["warnings"] = warnings
        print(json.dumps(payload, ensure_ascii=False))
        return
    print(f"Screenshot saved to {path}")
    for warning in warnings:
        print(f"[AgentVis Browser Runtime] warning: {warning}", file=sys.stderr)


def capture_screencast_screenshot(port: int, argv: list[str], reason: str) -> int | None:
    ws_url = active_page_websocket_url(port)
    if not ws_url:
        return None

    output_path = screenshot_output_path(argv)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image_format = screenshot_format(argv, output_path)
    warnings = [f"used Page.startScreencast fallback because {reason}"]
    if "--annotate" in argv:
        warnings.append("screencast fallback captures the viewport image without annotation overlays or annotation refs")
    if "--full" in argv or "-f" in argv:
        warnings.append("screencast fallback captures the current viewport, not a full-page screenshot")

    try:
        with CdpConnection(ws_url, SCREENCAST_FALLBACK_TIMEOUT_SECS) as cdp:
            cdp.call("Page.enable")
            cdp.call("Page.startScreencast", {"format": image_format, "quality": 100, "everyNthFrame": 1})
            deadline = time.monotonic() + SCREENCAST_FALLBACK_TIMEOUT_SECS
            frame: dict[str, Any] | None = None
            while time.monotonic() < deadline:
                message = cdp.recv_raw()
                if message.get("method") == "Page.screencastFrame":
                    params = message.get("params")
                    if isinstance(params, dict):
                        frame = params
                        break
            if not frame or not frame.get("data"):
                return None
            session_id = frame.get("sessionId")
            if session_id is not None:
                try:
                    cdp.call("Page.screencastFrameAck", {"sessionId": session_id})
                except Exception:
                    pass
            try:
                cdp.call("Page.stopScreencast")
            except Exception:
                pass
            output_path.write_bytes(base64.b64decode(str(frame["data"])))
    except Exception as exc:
        print(f"[AgentVis Browser Runtime] warning: screencast fallback failed: {exc}", file=sys.stderr)
        return None

    write_screenshot_result(argv, output_path, "Page.startScreencast", warnings)
    return 0


def command_timeout(argv: list[str]) -> float:
    if is_screenshot_command(argv):
        return SCREENSHOT_COMMAND_TIMEOUT_SECS
    return DEFAULT_COMMAND_TIMEOUT_SECS


def is_runtime_close_command(argv: list[str]) -> bool:
    return bool(argv) and argv[0].lower() in {"close", "quit", "exit"}


def run_runtime_stop() -> int:
    runtime_script = SCRIPT_DIR / "browser_runtime.py"
    result = subprocess.run(
        [sys.executable, str(runtime_script), "stop"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=15,
        env=local_control_env(),
    )
    if result.stdout:
        sys.stdout.write(result.stdout)
    if result.stderr:
        sys.stderr.write(result.stderr)
    return result.returncode


def ensure_window_state(port: int, viewport: str | None, window_state: str) -> None:
    runtime_script = SCRIPT_DIR / "browser_runtime.py"
    command = [
        sys.executable,
        str(runtime_script),
        "ensure",
        "--port",
        str(port),
        "--window-state",
        window_state,
        "--json",
    ]
    if viewport:
        command.extend(["--viewport", viewport])
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=8,
        env=local_control_env(),
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"Cannot set browser window state to {window_state}: {detail or result.returncode}")


def kill_process_tree(pid: int) -> None:
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        try:
            os.kill(pid, 15)
        except OSError:
            pass


def read_output(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def output_has_success_json(output: str) -> bool:
    for line in reversed([value.strip() for value in output.splitlines() if value.strip()]):
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and data.get("success") is True and not data.get("error"):
            return True
    return False


def command_output_path() -> Path:
    token = secrets.token_hex(8)
    return STATE_FILE.with_name(f"browser-command-output-{os.getpid()}-{token}.txt")


def run_agent_browser_command(command: list[str], timeout: float) -> int:
    output_path = command_output_path()
    try:
        with output_path.open("w", encoding="utf-8", errors="replace") as output_file:
            proc = subprocess.Popen(
                command,
                stdout=output_file,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=local_control_env(),
            )

            deadline = time.monotonic() + timeout
            success_seen_at: float | None = None
            while proc.poll() is None:
                now = time.monotonic()
                output = read_output(output_path)
                if output_has_success_json(output):
                    if success_seen_at is None:
                        success_seen_at = now
                    elif now - success_seen_at >= SUCCESS_EXIT_GRACE_SECS:
                        kill_process_tree(proc.pid)
                        try:
                            proc.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            pass
                        output = read_output(output_path)
                        if output:
                            sys.stdout.write(output)
                        print(
                            "[AgentVis Browser Runtime] warning: agent-browser reported success but did not exit; cleaned up the leftover process.",
                            file=sys.stderr,
                        )
                        return 0

                if now >= deadline:
                    kill_process_tree(proc.pid)
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
                    output = read_output(output_path)
                    if output:
                        sys.stdout.write(output)
                    if output_has_success_json(output):
                        print(
                            "[AgentVis Browser Runtime] warning: agent-browser timed out after reporting success; cleaned up the leftover process.",
                            file=sys.stderr,
                        )
                        return 0
                    print(
                        f"[AgentVis Browser Runtime] error: agent-browser timed out after {timeout:.0f} seconds.",
                        file=sys.stderr,
                    )
                    return 124
                time.sleep(0.25)

        output = read_output(output_path)
        if output:
            sys.stdout.write(output)
        return proc.returncode or 0
    finally:
        try:
            output_path.unlink()
        except OSError:
            pass


def main(argv: list[str]) -> int:
    configure_stdio()
    if not argv:
        print("Usage: browser-command.bat <agent-browser command args>", file=sys.stderr)
        return 2
    if is_runtime_close_command(argv):
        return run_runtime_stop()

    try:
        state = load_state()
        port = int(state.get("port") or 0)
        if not port:
            raise RuntimeError("Browser runtime state has no CDP port.")
        if not get_json(f"http://127.0.0.1:{port}/json/version", timeout=2.0):
            raise RuntimeError(f"Browser runtime CDP is not reachable at 127.0.0.1:{port}. Run start-chrome-debug.bat first.")
        session = str(state.get("session") or session_name(port))
        viewport = str(state.get("viewport") or "")
        previous_window_state = str(state.get("window_state") or "")
        screenshot_command = is_screenshot_command(argv)
        should_restore_minimized = screenshot_command and previous_window_state == "minimized"
        should_keep_offscreen = previous_window_state == "offscreen"
        actual_window_state = current_window_state(port) if screenshot_command else None
        if should_restore_minimized:
            ensure_window_state(port, viewport, "normal")
        elif should_keep_offscreen:
            ensure_window_state(port, viewport, "offscreen")
    except Exception as exc:
        print(f"[AgentVis Browser Runtime] error: {exc}", file=sys.stderr)
        return 1

    command = ["agent-browser", "--session", session, "--cdp", str(port), *argv]
    if os.name == "nt":
        command = ["cmd", "/c", "agent-browser", "--session", session, "--cdp", str(port), *argv]

    try:
        if screenshot_command and previous_window_state == "normal" and actual_window_state == "minimized":
            fallback_exit = capture_screencast_screenshot(port, argv, "the visible browser window is minimized")
            if fallback_exit is not None:
                return fallback_exit

        exit_code = run_agent_browser_command(command, command_timeout(argv))
        if exit_code != 0 and screenshot_command:
            fallback_exit = capture_screencast_screenshot(port, argv, "the normal screenshot command failed")
            if fallback_exit is not None:
                return fallback_exit

        if exit_code != 0 and screenshot_command and previous_window_state == "offscreen":
            print(
                "[AgentVis Browser Runtime] warning: offscreen screenshot failed; retrying once with a visible normal window.",
                file=sys.stderr,
            )
            ensure_window_state(port, viewport, "normal")
            exit_code = run_agent_browser_command(command, command_timeout(argv))
        return exit_code
    finally:
        if should_restore_minimized:
            try:
                ensure_window_state(port, viewport, "minimized")
            except Exception as exc:
                print(f"[AgentVis Browser Runtime] warning: {exc}", file=sys.stderr)
        elif should_keep_offscreen:
            try:
                ensure_window_state(port, viewport, "offscreen")
            except Exception as exc:
                print(f"[AgentVis Browser Runtime] warning: {exc}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
