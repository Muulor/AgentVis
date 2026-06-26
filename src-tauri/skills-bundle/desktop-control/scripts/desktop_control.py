"""
Desktop Control CLI — 桌面自动化工具

提供鼠标、键盘、截屏、窗口管理、剪贴板操作的 CLI 子命令。
所有命令以 JSON 格式输出结果，供 Agent 可靠解析。

使用方式:
    python <skill-path>/scripts/desktop_control.py <command> [args]

子命令:
    info         获取屏幕信息（尺寸、DPI、多显示器、鼠标位置、光标状态）
    click        鼠标点击
    click_relative 基于 region 的局部坐标点击
    move         移动鼠标
    type         键入文本（自动处理 Unicode）
    press        按下单个按键
    hotkey       执行快捷键组合
    drag         鼠标拖拽
    scroll       滚动鼠标滚轮
    screenshot   截取屏幕（可附带 OCR 文字识别）
    observe      获取屏幕信息 + 截图 + 可选 OCR
    find_text    OCR 查找文本并返回候选坐标
    click_text   OCR 查找文本并点击
    ensure_window 激活窗口并验证前台
    paste_and_verify 粘贴剪贴板或指定文本并做基础验证
    locate_image 图像模板定位
    click_image  图像模板定位并点击
    app          应用级查找与激活（list / check / activate）
    window       窗口管理（list / activate / active）
    clipboard    剪贴板操作（get / set）
    process      进程检测与激活（check / activate，可唤醒托盘隐藏窗口）
    wait_window  等待指定窗口出现
    wait_stable  等待 GUI 界面稳定
"""

import argparse
import json
import sys
import time
import platform
import subprocess
from typing import Any
import os
import math
import tempfile
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

if platform.system() == "Windows":
    try:
        import ctypes
        # 必须在所有 GUI 模块（包括 pyautogui）导入前声明 DPI 感知
        # 这样能让 Python 进程始终在真实的物理像素分辨率下运行
        # screenshot 和 click 都会变成绝对 1:1 精准的物理坐标
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


# ==================== JSON 输出 ====================

def output_success(data: dict[str, Any] | None = None) -> None:
    """输出成功结果"""
    result: dict[str, Any] = {"success": True}
    if data:
        result["data"] = data
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0)


def output_error(message: str, code: str = "UNKNOWN_ERROR") -> None:
    """输出错误结果"""
    result = {
        "success": False,
        "error": message,
        "code": code,
    }
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(1)


# ==================== 依赖检查 ====================

def check_pyautogui() -> Any:
    """检查并导入 pyautogui，失败时给出安装提示"""
    try:
        import pyautogui
        return pyautogui
    except ImportError:
        output_error(
            "pyautogui is not installed. Please run: pip install pyautogui",
            "DEPENDENCY_MISSING"
        )


def check_pyperclip() -> Any:
    """检查并导入 pyperclip"""
    try:
        import pyperclip
        return pyperclip
    except ImportError:
        output_error(
            "pyperclip is not installed. Please run: pip install pyperclip",
            "DEPENDENCY_MISSING"
        )


# ==================== 进程/窗口底层工具 ====================

# 系统/IME 辅助窗口类名黑名单 — 这些窗口不是应用主窗口，激活它们没有意义
_SYSTEM_WINDOW_CLASSES = frozenset({
    "MSCTFIME UI", "IME", "Default IME", "ConsoleWindowClass",
    "tooltips_class32", "OleMainThreadWndClass",
})

# 常见应用的 URI 协议映射 — 用于 Chromium 等新架构应用无法通过 ShowWindow 恢复时的 fallback
# 键为进程名小写子串，值为对应的 URI 协议
_APP_URI_PROTOCOLS: dict[str, str] = {
    "wechat": "weixin://",
    "wechatappex": "weixin://",
    "weixin": "weixin://",
    "微信": "weixin://",
    "settings": "ms-settings:",
    "设置": "ms-settings:",
}


_APP_PROCESS_ALIASES: dict[str, tuple[str, ...]] = {
    "微信": ("WeChat", "WeChatAppEx", "Weixin"),
    "wechat": ("WeChat", "WeChatAppEx"),
    "weixin": ("WeChat", "WeChatAppEx", "Weixin"),
    "visual studio code": ("Code.exe",),
    "vs code": ("Code.exe",),
    "vscode": ("Code.exe",),
    "网易云音乐": ("cloudmusic",),
    "netease cloud music": ("cloudmusic",),
    "cloudmusic": ("cloudmusic",),
    "notepad": ("Notepad", "notepad"),
    "记事本": ("Notepad", "notepad"),
    "calculator": ("CalculatorApp", "Calculator", "calc"),
    "calc": ("CalculatorApp", "Calculator", "calc"),
    "计算器": ("CalculatorApp", "Calculator", "calc"),
    "settings": ("SystemSettings",),
    "设置": ("SystemSettings",),
}


_APP_DISPLAY_ALIASES: dict[str, tuple[str, ...]] = {
    "visual studio code": ("Visual Studio Code", "VS Code", "Code.exe"),
    "vs code": ("Visual Studio Code", "VS Code", "Code.exe"),
    "vscode": ("Visual Studio Code", "VS Code", "Code.exe"),
    "网易云音乐": ("网易云音乐", "NetEase Cloud Music", "cloudmusic"),
    "netease cloud music": ("网易云音乐", "NetEase Cloud Music", "cloudmusic"),
    "cloudmusic": ("网易云音乐", "NetEase Cloud Music", "cloudmusic"),
    "notepad": ("Notepad", "记事本", "无标题 - 记事本"),
    "记事本": ("Notepad", "记事本", "无标题 - 记事本"),
    "calculator": ("Calculator", "calc", "计算器"),
    "calc": ("Calculator", "calc", "计算器"),
    "计算器": ("Calculator", "calc", "计算器"),
    "settings": ("Settings", "设置"),
    "设置": ("Settings", "设置"),
}


_APP_EXECUTION_ALIASES: dict[str, tuple[str, ...]] = {
    "notepad": ("notepad.exe",),
    "记事本": ("notepad.exe",),
    "calculator": ("calc.exe",),
    "calc": ("calc.exe",),
    "计算器": ("calc.exe",),
}


# 标题可能来自网页、文档、图片文件名的通用内容宿主应用。
# 对这些窗口只做“进程/快捷方式身份匹配”激活，不做纯标题兜底，避免误把内容标题当成应用本身。
_TITLE_ONLY_HOST_PROCESS_NAMES = frozenset({
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "brave.exe",
    "opera.exe",
    "vivaldi.exe",
    "iexplore.exe",
    "code.exe",
    "code - insiders.exe",
    "cursor.exe",
    "windsurf.exe",
    "devenv.exe",
    "notepad++.exe",
    "notepad.exe",
    "sublime_text.exe",
    "webstorm64.exe",
    "idea64.exe",
    "pycharm64.exe",
    "photoshop.exe",
    "krita.exe",
    "gimp.exe",
    "gimp-3.0.exe",
    "gimp-3.2.exe",
    "blender.exe",
    "mspaint.exe",
})


_TITLE_ONLY_HOST_TITLE_MARKERS = frozenset({
    "Google Chrome",
    "Microsoft Edge",
    "Mozilla Firefox",
    "Brave",
    "Opera",
    "Vivaldi",
    "Visual Studio Code",
    "Cursor",
    "Windsurf",
    "Notepad",
    "记事本",
    "Adobe Photoshop",
    "Photoshop",
    "Krita",
    "GIMP",
    "Blender",
    "Paint",
    "画图",
})


def expand_process_name_queries(name: str) -> list[str]:
    """把窗口标题或应用名扩展成可用于进程名匹配的关键词。"""
    query_lower = name.lower()
    queries = [name]
    for alias_key, alias_values in _APP_PROCESS_ALIASES.items():
        if alias_key in query_lower or query_lower in alias_key:
            queries.extend(alias_values)

    deduped: list[str] = []
    seen: set[str] = set()
    for query in queries:
        normalized = query.lower()
        if normalized and normalized not in seen:
            seen.add(normalized)
            deduped.append(query)
    return deduped


def get_uri_protocol(name: str) -> str | None:
    """返回应用名/进程名对应的 URI 协议，没有映射时返回 None。"""
    name_lower = name.lower()
    for keyword, protocol in _APP_URI_PROTOCOLS.items():
        if keyword in name_lower:
            return protocol
    return None


def has_uri_protocol(name: str) -> bool:
    """判断应用名/窗口标题是否有 URI 唤醒方式。"""
    if get_uri_protocol(name):
        return True
    return any(get_uri_protocol(query) for query in expand_process_name_queries(name))


def find_processes_by_name(name: str, required: bool = True) -> list[dict[str, Any]]:
    """
    通过进程名查找正在运行的进程（不区分大小写，子串匹配）。
    使用 psutil 枚举，能发现所有进程（包括没有可见窗口的托盘常驻程序）。
    """
    try:
        import psutil
    except ImportError:
        if required:
            output_error("psutil is not installed. Please run: pip install psutil", "DEPENDENCY_MISSING")
        return []

    matched: list[dict[str, Any]] = []
    seen_pids: set[int] = set()
    for query_name in expand_process_name_queries(name):
        query = query_name.lower()
        for proc in psutil.process_iter(["pid", "name"]):
            try:
                proc_name = proc.info.get("name", "") or ""
                pid = proc.info["pid"]
                if pid not in seen_pids and query in proc_name.lower():
                    seen_pids.add(pid)
                    matched.append({"pid": pid, "name": proc_name})
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                # 进程在枚举过程中可能已退出或无权限访问
                pass
    return matched


def find_processes_by_exe_path(exe_path: str, required: bool = True) -> list[dict[str, Any]]:
    """通过可执行文件路径查找进程；拿不到 exe 权限时退化到进程名匹配。"""
    try:
        import psutil
    except ImportError:
        if required:
            output_error("psutil is not installed. Please run: pip install psutil", "DEPENDENCY_MISSING")
        return []

    target_path = os.path.normcase(os.path.abspath(exe_path))
    target_name = os.path.basename(exe_path).lower()
    matched: list[dict[str, Any]] = []
    seen_pids: set[int] = set()
    for proc in psutil.process_iter(["pid", "name", "exe"]):
        try:
            proc_name = proc.info.get("name", "") or ""
            proc_exe = proc.info.get("exe", "") or ""
            pid = proc.info["pid"]
            exe_matched = proc_exe and os.path.normcase(os.path.abspath(proc_exe)) == target_path
            name_matched = target_name and proc_name.lower() == target_name
            if pid not in seen_pids and (exe_matched or name_matched):
                seen_pids.add(pid)
                matched.append({"pid": pid, "name": proc_name, "exe": proc_exe})
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, OSError):
            pass
    return matched


def dedupe_processes(processes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按 PID 去重，保留首次发现的信息。"""
    deduped: list[dict[str, Any]] = []
    seen: set[int] = set()
    for proc in processes:
        pid = proc.get("pid")
        if isinstance(pid, int) and pid not in seen:
            seen.add(pid)
            deduped.append(proc)
    return deduped


def collect_windows_for_processes(processes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """收集一组进程的顶层窗口，并把进程信息挂到窗口对象上。"""
    all_windows: list[dict[str, Any]] = []
    for proc in processes:
        windows = find_windows_by_pid(proc["pid"])
        for win in windows:
            win["process_name"] = proc.get("name", "")
            win["process_exe"] = proc.get("exe", "")
            win["pid"] = proc["pid"]
        all_windows.extend(windows)
    return all_windows


def get_process_info_by_pid(pid: int, required: bool = False) -> dict[str, str]:
    """按 PID 获取进程名称和路径；依赖不可用或无权限时返回空信息。"""
    if not pid:
        return {}
    try:
        import psutil
    except ImportError:
        if required:
            output_error("psutil is not installed. Please run: pip install psutil", "DEPENDENCY_MISSING")
        return get_process_info_by_pid_win32(pid)

    try:
        proc = psutil.Process(pid)
        return {
            "process_name": proc.name() or "",
            "process_exe": proc.exe() or "",
        }
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, OSError):
        return {}


def get_process_info_by_pid_win32(pid: int) -> dict[str, str]:
    """不依赖 psutil 的 Windows PID 到 exe 查询兜底。"""
    if platform.system() != "Windows":
        return {}
    try:
        import ctypes
        from ctypes import wintypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return {}
        try:
            size = wintypes.DWORD(32768)
            buffer = ctypes.create_unicode_buffer(size.value)
            query = kernel32.QueryFullProcessImageNameW
            query.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
            query.restype = wintypes.BOOL
            if not query(handle, 0, buffer, ctypes.byref(size)):
                return {}
            exe = buffer.value
            return {
                "process_name": Path(exe).name,
                "process_exe": exe,
            }
        finally:
            kernel32.CloseHandle(handle)
    except Exception:
        return {}


def attach_process_info_to_windows(windows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """给窗口列表补充进程名和 exe 路径，便于区分真实应用窗口与网页/编辑器标题。"""
    cache: dict[int, dict[str, str]] = {}
    for win in windows:
        pid = win.get("pid")
        if not isinstance(pid, int) or pid <= 0:
            continue
        if pid not in cache:
            cache[pid] = get_process_info_by_pid(pid, required=False)
        win.update(cache[pid])
    return windows


def get_active_window_info() -> dict[str, Any] | None:
    """返回当前前台窗口信息。"""
    info: dict[str, Any] = {}
    try:
        import pygetwindow as gw
        active = gw.getActiveWindow()
        if active:
            info.update({
                "title": active.title,
                "x": active.left,
                "y": active.top,
                "width": active.width,
                "height": active.height,
            })
    except (ImportError, Exception):
        pass

    if platform.system() == "Windows":
        try:
            import ctypes
            from ctypes import wintypes

            user32 = ctypes.windll.user32
            hwnd = user32.GetForegroundWindow()
            if hwnd:
                info["hwnd"] = hwnd

                length = user32.GetWindowTextLengthW(hwnd)
                if length > 0 and not info.get("title"):
                    buf = ctypes.create_unicode_buffer(length + 1)
                    user32.GetWindowTextW(hwnd, buf, length + 1)
                    info["title"] = buf.value

                rect = wintypes.RECT()
                user32.GetWindowRect(hwnd, ctypes.byref(rect))
                info.setdefault("x", rect.left)
                info.setdefault("y", rect.top)
                info.setdefault("width", rect.right - rect.left)
                info.setdefault("height", rect.bottom - rect.top)

                window_pid = wintypes.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(window_pid))
                if window_pid.value:
                    info["pid"] = window_pid.value
                    info.update(get_process_info_by_pid(window_pid.value, required=False))
        except Exception:
            pass

    return info or None


def window_snapshot_key(window: dict[str, Any]) -> tuple[Any, ...]:
    """生成窗口快照键，用于判断启动前后是否出现了新的顶层窗口。"""
    hwnd = window.get("hwnd")
    if hwnd:
        return ("hwnd", int(hwnd))
    return (
        "window",
        window.get("pid"),
        str(window.get("class_name", "")),
        str(window.get("title", "")),
    )


def append_app_query_variants(queries: list[str], value: Any) -> None:
    """加入显示名、原始路径和路径 stem 等匹配变体。"""
    text = str(value or "").strip().strip('"')
    if not text:
        return
    queries.append(text)
    normalized_path_text = text.replace("\\", "/")
    stem = Path(normalized_path_text).stem
    if stem and stem != text:
        queries.append(stem)


def build_app_match_queries(
    name: str,
    shortcut: dict[str, Any] | None = None,
    extra_queries: list[str] | None = None,
) -> list[str]:
    """汇总应用显示名、别名、快捷方式目标和启动器信息，作为窗口匹配候选。"""
    queries = expand_app_display_queries(name)
    if shortcut:
        append_app_query_variants(queries, shortcut.get("name", ""))
        append_app_query_variants(queries, shortcut.get("target", ""))
        append_app_query_variants(queries, shortcut.get("description", ""))
    if extra_queries:
        for query in extra_queries:
            append_app_query_variants(queries, query)

    deduped: list[str] = []
    seen: set[str] = set()
    for query in queries:
        normalized = normalize_app_query(query)
        if normalized and normalized not in seen:
            seen.add(normalized)
            deduped.append(query)
    return deduped


def window_identity_matches_app_query(
    window: dict[str, Any],
    name: str,
    shortcut: dict[str, Any] | None = None,
    extra_queries: list[str] | None = None,
) -> bool:
    """判断窗口进程身份是否与目标应用匹配，避免只靠网页/文档标题误判。"""
    queries = build_app_match_queries(name, shortcut, extra_queries)
    identity_values: list[str] = []
    for key in ("process_name", "process_exe", "class_name"):
        append_app_query_variants(identity_values, window.get(key, ""))

    for identity in identity_values:
        identity_norm = normalize_app_query(identity)
        if not identity_norm:
            continue
        for query in queries:
            query_norm = normalize_app_query(query)
            if query_norm and (
                identity_norm == query_norm
                or query_norm in identity_norm
                or identity_norm in query_norm
            ):
                return True
    return False


def app_query_matches_host_marker(
    name: str,
    marker: str,
    shortcut: dict[str, Any] | None = None,
    extra_queries: list[str] | None = None,
) -> bool:
    """判断用户目标是否就是浏览器/编辑器宿主本身。"""
    marker_norm = normalize_app_query(marker)
    for query in build_app_match_queries(name, shortcut, extra_queries):
        query_norm = normalize_app_query(query)
        if query_norm and (query_norm in marker_norm or marker_norm in query_norm):
            return True
    return False


def is_generic_title_host_window(
    window: dict[str, Any],
    name: str,
    shortcut: dict[str, Any] | None = None,
    extra_queries: list[str] | None = None,
) -> bool:
    """判断是否为浏览器/编辑器这类标题易误命中的承载窗口。"""
    if window_identity_matches_app_query(window, name, shortcut, extra_queries):
        return False

    process_candidates: list[str] = []
    append_app_query_variants(process_candidates, window.get("process_name", ""))
    append_app_query_variants(process_candidates, window.get("process_exe", ""))
    normalized_candidates = {normalize_app_query(item) for item in process_candidates if item}
    normalized_hosts = {normalize_app_query(item) for item in _TITLE_ONLY_HOST_PROCESS_NAMES}
    if normalized_candidates & normalized_hosts:
        return True

    title_norm = normalize_app_query(str(window.get("title", "")))
    for marker in _TITLE_ONLY_HOST_TITLE_MARKERS:
        marker_norm = normalize_app_query(marker)
        if marker_norm in title_norm and not app_query_matches_host_marker(name, marker, shortcut, extra_queries):
            return True
    return False


def should_trust_title_window(
    window: dict[str, Any],
    name: str,
    shortcut: dict[str, Any] | None = None,
    extra_queries: list[str] | None = None,
) -> bool:
    """判断一个标题匹配窗口是否可以作为 app activate 成功证据。"""
    if not window_matches_app_query(window, name, shortcut, extra_queries):
        return False
    return not is_generic_title_host_window(window, name, shortcut, extra_queries)


def should_accept_title_fallback_window(
    window: dict[str, Any],
    name: str,
    shortcut: dict[str, Any] | None = None,
    extra_queries: list[str] | None = None,
    before_keys: set[tuple[Any, ...]] | None = None,
) -> bool:
    """判断标题匹配窗口能否作为激活成功兜底证据。"""
    if not should_trust_title_window(window, name, shortcut, extra_queries):
        return False
    if window_identity_matches_app_query(window, name, shortcut, extra_queries):
        return True
    if not before_keys:
        return True
    return window_snapshot_key(window) not in before_keys


def window_title_matches_query(title: str, query: str, exact: bool = False) -> bool:
    """判断窗口标题是否匹配查询字符串。"""
    title_norm = normalize_app_query(title)
    query_norm = normalize_app_query(query)
    if not title_norm or not query_norm:
        return False
    if exact:
        return title_norm == query_norm
    return query_norm in title_norm


def window_title_match_score(title: str, query: str) -> int:
    """给窗口标题匹配结果打分，用于多候选排序。"""
    title_norm = normalize_app_query(title)
    query_norm = normalize_app_query(query)
    if title_norm == query_norm:
        return 1000
    if title_norm.startswith(query_norm):
        return 900
    if title_norm.endswith(query_norm):
        return 850
    if query_norm in title_norm:
        return 700
    return 0


def window_matches_process_filter(window: dict[str, Any], process_filter: str | None) -> bool:
    """按进程名或 exe 路径过滤窗口候选。"""
    if not process_filter:
        return True
    filter_norm = normalize_app_query(process_filter)
    if not filter_norm:
        return True

    values: list[str] = []
    append_app_query_variants(values, window.get("process_name", ""))
    append_app_query_variants(values, window.get("process_exe", ""))
    for value in values:
        value_norm = normalize_app_query(value)
        if value_norm and (filter_norm in value_norm or value_norm in filter_norm):
            return True
    return False


def select_window_title_candidates(
    title: str,
    *,
    exact: bool = False,
    process_filter: str | None = None,
    allow_content_title: bool = False,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """选择可安全激活的标题候选，并返回被内容宿主过滤掉的窗口。"""
    scored: list[tuple[int, int, dict[str, Any]]] = []
    ignored_content_hosts: list[dict[str, Any]] = []

    for win in list_top_level_windows():
        win_title = str(win.get("title", "") or "")
        if not window_title_matches_query(win_title, title, exact=exact):
            continue
        if not window_matches_process_filter(win, process_filter):
            continue
        if not allow_content_title and is_generic_title_host_window(win, title):
            ignored_content_hosts.append(win)
            continue

        score = window_title_match_score(win_title, title)
        scored.append((score, len(normalize_app_query(win_title)), win))

    scored.sort(key=lambda item: (-item[0], item[1], str(item[2].get("title", ""))))
    return [item[2] for item in scored], ignored_content_hosts


def list_top_level_windows() -> list[dict[str, Any]]:
    """枚举所有顶层窗口，用于应用激活后的宽松验证。"""
    if platform.system() != "Windows":
        return []

    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    results: list[dict[str, Any]] = []
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def enum_callback(hwnd: int, _lparam: int) -> bool:
        cls_buf = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls_buf, 256)
        class_name = cls_buf.value
        if class_name in _SYSTEM_WINDOW_CLASSES:
            return True

        length = user32.GetWindowTextLengthW(hwnd)
        title = ""
        if length > 0:
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buf, length + 1)
            title = buf.value

        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        width = rect.right - rect.left
        height = rect.bottom - rect.top
        if width <= 10 or height <= 10:
            return True

        window_pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(window_pid))
        results.append({
            "hwnd": hwnd,
            "pid": window_pid.value,
            "title": title,
            "class_name": class_name,
            "visible": bool(user32.IsWindowVisible(hwnd)),
            "minimized": bool(user32.IsIconic(hwnd)),
            "x": rect.left,
            "y": rect.top,
            "width": width,
            "height": height,
        })
        return True

    try:
        user32.EnumWindows(WNDENUMPROC(enum_callback), 0)
    except Exception:
        return []
    return attach_process_info_to_windows(results)


def window_matches_app_query(
    window: dict[str, Any],
    name: str,
    shortcut: dict[str, Any] | None = None,
    extra_queries: list[str] | None = None,
) -> bool:
    """判断窗口标题是否可视为应用激活成功的证据。"""
    title = normalize_app_query(str(window.get("title", "")))
    if not title:
        return False

    queries = build_app_match_queries(name, shortcut, extra_queries)

    for query in queries:
        query_norm = normalize_app_query(query)
        if query_norm and (query_norm in title or title in query_norm):
            return True
    return False


def detect_app_window_after_launch(
    name: str,
    shortcut: dict[str, Any] | None,
    before_active: dict[str, Any] | None,
    extra_queries: list[str] | None = None,
    before_windows: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """快捷方式启动后，用前台/可见窗口宽松确认应用是否已恢复。"""
    before_keys = {window_snapshot_key(win) for win in before_windows or []}
    active = get_active_window_info()
    before_title = (before_active or {}).get("title")
    if active and active.get("title") and active.get("title") != before_title:
        if should_accept_title_fallback_window(active, name, shortcut, extra_queries, before_keys):
            return {
                "activated": True,
                "method": "shortcut_foreground_title",
                "target_window": active,
                "active_window": active,
                "all_windows_found": None,
                "warning": "The foreground window title was confirmed successfully after launching via shortcut; the process name may not match the app display name.",
            }

    visible_windows = [
        win for win in list_top_level_windows()
        if win.get("visible") and should_accept_title_fallback_window(win, name, shortcut, extra_queries, before_keys)
    ]
    if visible_windows:
        target = visible_windows[0]
        activate_window_by_hwnd(int(target["hwnd"]))
        time.sleep(0.2)
        return {
            "activated": True,
            "method": "shortcut_visible_title",
            "target_window": target,
            "active_window": get_active_window_info(),
            "all_windows_found": len(visible_windows),
            "warning": "Confirmed success through visible window title; the process name may not match the application display name.",
        }
    return None


def activate_processes(
    name: str,
    processes: list[dict[str, Any]],
    settle: float,
    allow_hidden_fallback: bool = True,
) -> dict[str, Any] | None:
    """
    激活一组进程对应的应用窗口。
    优先可见主窗口，其次 URI 唤醒；隐藏 hwnd 只作为最后兜底。
    """
    all_windows = collect_windows_for_processes(processes)
    activated = False
    activated_window = None
    activation_method = "unknown"

    visible_titled_windows = [
        w for w in all_windows
        if w.get("visible") and w.get("title", "").strip()
    ]
    for win in visible_titled_windows:
        if activate_window_by_hwnd(win["hwnd"]):
            activated = True
            activated_window = win
            activation_method = "win32_visible_titled"
            break

    if not activated:
        visible_sized_windows = [
            w for w in all_windows
            if w.get("visible") and w.get("width", 0) > 10 and w.get("height", 0) > 10
        ]
        for win in visible_sized_windows:
            if activate_window_by_hwnd(win["hwnd"]):
                activated = True
                activated_window = win
                activation_method = "win32_visible_sized"
                break

    if not activated:
        representative_proc_name = processes[0]["name"] if processes else name
        if activate_by_uri_protocol(name) or activate_by_uri_protocol(representative_proc_name):
            activated = True
            activation_method = "uri_protocol"

    if not activated and allow_hidden_fallback:
        titled_windows = [w for w in all_windows if w.get("title", "").strip()]
        sized_windows = [
            w for w in all_windows
            if w.get("width", 0) > 10 and w.get("height", 0) > 10
        ]
        for win in titled_windows + [w for w in sized_windows if w not in titled_windows]:
            if activate_window_by_hwnd(win["hwnd"]):
                activated = True
                activated_window = win
                activation_method = "win32_hidden_or_sized"
                break

    if not activated:
        return None

    time.sleep(settle)
    return {
        "activated": True,
        "method": activation_method,
        "target_window": {
            "title": activated_window.get("title", "") if activated_window else "",
            "pid": activated_window.get("pid") if activated_window else (processes[0]["pid"] if processes else None),
            "was_visible": activated_window.get("visible", False) if activated_window else False,
            "was_minimized": activated_window.get("minimized", False) if activated_window else False,
        },
        "active_window": get_active_window_info(),
        "all_windows_found": len(all_windows),
    }


def normalize_app_query(value: str) -> str:
    """应用名匹配用的宽松规范化。"""
    return " ".join(value.casefold().replace(".lnk", "").split())


def expand_app_display_queries(name: str) -> list[str]:
    """扩展应用名的显示标题匹配关键词，覆盖系统应用的中英文标题差异。"""
    queries = [name]
    query_norm = normalize_app_query(name)
    for alias_key, alias_values in _APP_DISPLAY_ALIASES.items():
        key_norm = normalize_app_query(alias_key)
        if key_norm and query_norm and (key_norm in query_norm or query_norm in key_norm):
            queries.extend(alias_values)

    queries.extend(expand_process_name_queries(name))

    deduped: list[str] = []
    seen: set[str] = set()
    for query in queries:
        normalized = normalize_app_query(query)
        if normalized and normalized not in seen:
            seen.add(normalized)
            deduped.append(query)
    return deduped


def get_execution_alias_commands(name: str) -> list[str]:
    """返回 Windows App Execution Alias / 系统命令兜底，例如 notepad.exe、calc.exe。"""
    query_norm = normalize_app_query(name)
    commands: list[str] = []
    for alias_key, alias_values in _APP_EXECUTION_ALIASES.items():
        key_norm = normalize_app_query(alias_key)
        if key_norm and query_norm and (key_norm in query_norm or query_norm in key_norm):
            commands.extend(alias_values)

    deduped: list[str] = []
    seen: set[str] = set()
    for command in commands:
        normalized = command.casefold()
        if normalized not in seen:
            seen.add(normalized)
            deduped.append(command)
    return deduped


def start_app_match_score(app: dict[str, Any], queries: list[str]) -> int:
    """根据 Get-StartApps 的 Name/AppID 与应用关键词计算相关性。"""
    name_norm = normalize_app_query(str(app.get("name", "")))
    app_id_norm = normalize_app_query(str(app.get("app_id", "")))
    best_score = 0
    for query in queries:
        query_norm = normalize_app_query(query)
        if not query_norm:
            continue
        if name_norm == query_norm:
            best_score = max(best_score, 100)
        elif name_norm.startswith(query_norm):
            best_score = max(best_score, 92)
        elif query_norm in name_norm:
            best_score = max(best_score, 85)
        elif query_norm in app_id_norm:
            best_score = max(best_score, 72)
    return best_score


def list_windows_start_apps() -> list[dict[str, str]]:
    """枚举 Windows Start Apps（含 UWP/打包应用），失败时返回空列表。"""
    if platform.system() != "Windows":
        return []

    script = (
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); "
        "Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress"
    )
    for shell in ("powershell.exe", "pwsh.exe"):
        try:
            completed = subprocess.run(
                [shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=5,
                check=False,
            )
        except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
            continue

        if completed.returncode != 0:
            continue

        raw = completed.stdout.strip()
        if not raw:
            return []

        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return []

        items = parsed if isinstance(parsed, list) else [parsed]
        apps: list[dict[str, str]] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            app_name = str(item.get("Name", "") or "")
            app_id = str(item.get("AppID", "") or "")
            if app_name and app_id:
                apps.append({"name": app_name, "app_id": app_id})
        return apps
    return []


def find_start_apps(name: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    """查找 Start Apps 入口；可发现没有传统 .lnk 的系统/UWP 应用。"""
    apps = list_windows_start_apps()
    if not name:
        return apps[:limit]

    queries = expand_app_display_queries(name)
    matches: list[dict[str, Any]] = []
    for app in apps:
        score = start_app_match_score(app, queries)
        if score > 0:
            matches.append({**app, "score": score})

    matches.sort(key=lambda item: (-int(item.get("score", 0)), item.get("name", "")))
    return matches[:limit]


def find_app_launchers(name: str, start_apps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """生成 app activate 的非快捷方式启动兜底。"""
    launchers: list[dict[str, Any]] = []
    for command in get_execution_alias_commands(name):
        launchers.append({
            "type": "execution_alias",
            "name": command,
            "command": command,
            "score": 95,
            "queries": expand_app_display_queries(name),
        })

    for app in start_apps:
        launchers.append({
            "type": "start_app",
            "name": app.get("name", ""),
            "app_id": app.get("app_id", ""),
            "score": app.get("score", 0),
            "queries": [str(app.get("name", "")), str(app.get("app_id", ""))],
        })

    launchers.sort(key=lambda item: (-int(item.get("score", 0)), item.get("type", ""), item.get("name", "")))
    return launchers


def launcher_match_queries(launcher: dict[str, Any] | None) -> list[str]:
    """提取 launcher 中可用于窗口标题确认的关键词。"""
    if not launcher:
        return []
    queries = list(launcher.get("queries", []) or [])
    for key in ("name", "command", "app_id"):
        value = str(launcher.get(key, "") or "")
        if value:
            queries.append(value)
    return queries


def launch_app_launcher(launcher: dict[str, Any]) -> bool:
    """运行 Start App 或 App Execution Alias 兜底入口。"""
    try:
        launcher_type = launcher.get("type")
        if launcher_type == "execution_alias":
            command = str(launcher.get("command", "") or "")
            if not command:
                return False
            subprocess.Popen(
                [command],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
            return True

        if launcher_type == "start_app":
            app_id = str(launcher.get("app_id", "") or "")
            if not app_id:
                return False
            subprocess.Popen(
                ["explorer.exe", f"shell:AppsFolder\\{app_id}"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
            return True
    except Exception:
        return False
    return False


def shortcut_search_dirs() -> list[Path]:
    """返回桌面和开始菜单快捷方式目录。"""
    candidates: list[Path] = []
    user_profile = os.environ.get("USERPROFILE")
    appdata = os.environ.get("APPDATA")
    programdata = os.environ.get("PROGRAMDATA")
    public = os.environ.get("PUBLIC")

    if user_profile:
        candidates.append(Path(user_profile) / "Desktop")
    if public:
        candidates.append(Path(public) / "Desktop")
    if appdata:
        candidates.append(Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs")
    if programdata:
        candidates.append(Path(programdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs")

    seen: set[str] = set()
    result: list[Path] = []
    for path in candidates:
        key = os.path.normcase(str(path))
        if key not in seen and path.exists():
            seen.add(key)
            result.append(path)
    return result


def resolve_shortcut(path: Path) -> dict[str, Any]:
    """解析 Windows .lnk，失败时仍返回路径和显示名。"""
    info: dict[str, Any] = {
        "name": path.stem,
        "path": str(path),
        "target": "",
        "arguments": "",
        "working_directory": "",
        "description": "",
    }
    if platform.system() != "Windows":
        return info
    try:
        import win32com.client  # type: ignore[import-untyped]
        shell = win32com.client.Dispatch("WScript.Shell")
        shortcut = shell.CreateShortcut(str(path))
        info.update({
            "target": shortcut.TargetPath or "",
            "arguments": shortcut.Arguments or "",
            "working_directory": shortcut.WorkingDirectory or "",
            "description": shortcut.Description or "",
        })
    except Exception:
        pass
    return info


def shortcut_match_score(shortcut: dict[str, Any], query: str) -> int:
    """根据显示名、目标 exe 名和描述为快捷方式打分。"""
    query_norm = normalize_app_query(query)
    name_norm = normalize_app_query(shortcut.get("name", ""))
    target_norm = normalize_app_query(Path(shortcut.get("target", "")).stem if shortcut.get("target") else "")
    desc_norm = normalize_app_query(shortcut.get("description", ""))
    uninstall_words = ("卸载", "uninstall")
    if any(word in name_norm or word in target_norm for word in uninstall_words):
        if not any(word in query_norm for word in uninstall_words):
            return 0

    if name_norm == query_norm:
        return 100
    if name_norm.startswith(query_norm):
        return 92
    if query_norm in name_norm:
        return 85
    if target_norm and target_norm == query_norm:
        return 78
    if target_norm and query_norm in target_norm:
        return 70
    if desc_norm and query_norm in desc_norm:
        return 55
    return 0


def find_app_shortcuts(name: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    """查找桌面/开始菜单快捷方式；提供 name 时按相关性排序。"""
    matches: list[dict[str, Any]] = []
    for root in shortcut_search_dirs():
        try:
            shortcuts = root.rglob("*.lnk")
            for path in shortcuts:
                info = resolve_shortcut(path)
                score = shortcut_match_score(info, name) if name else 1
                if score > 0:
                    info["score"] = score
                    matches.append(info)
        except OSError:
            continue

    matches.sort(key=lambda item: (-int(item.get("score", 0)), item.get("name", "")))
    return matches[:limit]


def find_app_processes(name: str, shortcuts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """通过应用名别名和快捷方式目标 exe 查找运行中的进程。"""
    processes = find_processes_by_name(name, required=False)
    for shortcut in shortcuts:
        target = shortcut.get("target", "")
        if target and target.lower().endswith(".exe"):
            processes.extend(find_processes_by_exe_path(target, required=False))
    return dedupe_processes(processes)


def launch_shortcut(shortcut: dict[str, Any]) -> bool:
    """运行快捷方式，让应用自行启动或恢复单实例窗口。"""
    try:
        os.startfile(shortcut["path"])  # type: ignore[attr-defined]
        return True
    except Exception:
        return False


def find_windows_by_pid(target_pid: int) -> list[dict[str, Any]]:
    """
    通过 EnumWindows + GetWindowThreadProcessId 查找属于指定 PID 的所有顶层窗口。
    自动过滤 IME 等系统辅助窗口，返回包含窗口类名和尺寸信息的详细列表。
    仅 Windows 可用。
    """
    if platform.system() != "Windows":
        return []

    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    results: list[dict[str, Any]] = []

    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def enum_callback(hwnd: int, _lparam: int) -> bool:
        window_pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(window_pid))
        if window_pid.value != target_pid:
            return True

        # 获取窗口类名
        cls_buf = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls_buf, 256)
        class_name = cls_buf.value

        # 跳过系统辅助窗口（IME、tooltip 等），这些不是应用主窗口
        if class_name in _SYSTEM_WINDOW_CLASSES:
            return True

        # 获取窗口标题
        length = user32.GetWindowTextLengthW(hwnd)
        title = ""
        if length > 0:
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buf, length + 1)
            title = buf.value

        is_visible = bool(user32.IsWindowVisible(hwnd))
        is_minimized = bool(user32.IsIconic(hwnd))

        # 获取窗口尺寸，用于判断是否为有效的可显示窗口
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        width = rect.right - rect.left
        height = rect.bottom - rect.top

        results.append({
            "hwnd": hwnd,
            "title": title,
            "class_name": class_name,
            "visible": is_visible,
            "minimized": is_minimized,
            "width": width,
            "height": height,
        })
        return True

    user32.EnumWindows(WNDENUMPROC(enum_callback), 0)
    return results


def activate_window_by_hwnd(hwnd: int) -> bool:
    """
    通过 Win32 API 强制激活窗口（包括从 SW_HIDE 托盘状态恢复）。
    使用 keybd_event(Alt) 技巧绕过 Windows 焦点保护。
    返回 True 表示激活成功（窗口可见且在前台）。
    """
    if platform.system() != "Windows":
        return False

    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    SW_RESTORE = 9
    SW_SHOW = 5

    try:
        is_iconic = bool(user32.IsIconic(hwnd))
        is_visible = bool(user32.IsWindowVisible(hwnd))

        if is_iconic or not is_visible:
            user32.ShowWindow(hwnd, SW_RESTORE)
        else:
            user32.ShowWindow(hwnd, SW_SHOW)

        time.sleep(0.15)

        # 绕过 Windows 焦点保护：先模拟 Alt 按键释放当前前台锁
        VK_MENU = 0x12
        KEYEVENTF_EXTENDEDKEY = 0x0001
        KEYEVENTF_KEYUP = 0x0002
        user32.keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY, 0)
        user32.keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, 0)

        user32.SetForegroundWindow(hwnd)
        time.sleep(0.15)

        # 验证：窗口是否真的在前台且有合理尺寸
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        width = rect.right - rect.left
        height = rect.bottom - rect.top
        fg_hwnd = user32.GetForegroundWindow()

        # 窗口尺寸 > 10 像素且是前台窗口才算成功
        return fg_hwnd == hwnd and width > 10 and height > 10
    except Exception:
        return False


def activate_by_uri_protocol(process_name: str) -> bool:
    """
    通过 URI 协议唤醒应用（如 weixin:// 唤醒微信）。
    新版 Chromium 架构应用（微信 WeChatAppEx 等）在托盘隐藏时窗口句柄无效，
    标准 ShowWindow 无法恢复，但通过 URI 协议可以让应用自行恢复主窗口。
    返回 True 表示成功唤醒。
    """
    uri = get_uri_protocol(process_name)
    if not uri:
        return False

    try:
        os.startfile(uri)
        time.sleep(0.8)

        # 验证前台窗口是否已切换
        if platform.system() == "Windows":
            import ctypes
            user32 = ctypes.windll.user32
            fg = user32.GetForegroundWindow()
            tlen = user32.GetWindowTextLengthW(fg)
            if tlen > 0:
                buf = ctypes.create_unicode_buffer(tlen + 1)
                user32.GetWindowTextW(fg, buf, tlen + 1)
                # 前台窗口有标题说明唤醒成功
                return bool(buf.value.strip())
        return True
    except Exception:
        return False


# ==================== 工具函数 ====================

def get_dpi_scale() -> float:
    """
    获取 Windows DPI 缩放比例。
    非 Windows 系统或检测失败时返回 1.0。
    """
    if platform.system() != "Windows":
        return 1.0
    try:
        import ctypes
        # 设置进程 DPI 感知，确保获取真实坐标
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)  # type: ignore[attr-defined]
        except (AttributeError, OSError):
            # Windows 8.1 以下可能不支持
            try:
                ctypes.windll.user32.SetProcessDPIAware()  # type: ignore[attr-defined]
            except (AttributeError, OSError):
                pass
        # 获取主显示器 DPI
        hdc = ctypes.windll.user32.GetDC(0)  # type: ignore[attr-defined]
        dpi = ctypes.windll.gdi32.GetDeviceCaps(hdc, 88)  # LOGPIXELSX = 88  # type: ignore[attr-defined]
        ctypes.windll.user32.ReleaseDC(0, hdc)  # type: ignore[attr-defined]
        return dpi / 96.0
    except Exception:
        return 1.0


def get_monitors() -> list[dict[str, int]]:
    """
    获取所有显示器的边界范围。
    返回 [{x, y, width, height}, ...] 列表。
    非 Windows 系统或失败时返回空列表。
    """
    if platform.system() != "Windows":
        return []
    try:
        import ctypes
        monitors: list[dict[str, int]] = []
        # 枚举显示器的回调函数
        MONITOR_ENUM_PROC = ctypes.WINFUNCTYPE(
            ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong,
            ctypes.POINTER(ctypes.wintypes.RECT), ctypes.c_double
        )

        def callback(hMonitor: int, hdcMonitor: int, lprcMonitor: Any, dwData: float) -> int:
            rect = lprcMonitor.contents
            monitors.append({
                "x": rect.left,
                "y": rect.top,
                "width": rect.right - rect.left,
                "height": rect.bottom - rect.top,
            })
            return 1  # 继续枚举

        ctypes.windll.user32.EnumDisplayMonitors(  # type: ignore[attr-defined]
            None, None, MONITOR_ENUM_PROC(callback), 0
        )
        return monitors
    except Exception:
        return []


def get_cursor_type() -> str:
    """
    获取当前鼠标光标类型。
    返回 'normal'、'busy'、'text' 等，检测失败返回 'unknown'。
    用于判断系统是否处于忙碌状态（沙漏/转圈光标）。
    """
    if platform.system() != "Windows":
        return "unknown"
    try:
        import ctypes
        import ctypes.wintypes

        class CURSORINFO(ctypes.Structure):
            _fields_ = [
                ("cbSize", ctypes.wintypes.DWORD),
                ("flags", ctypes.wintypes.DWORD),
                ("hCursor", ctypes.c_void_p),
                ("ptScreenPos", ctypes.wintypes.POINT),
            ]

        ci = CURSORINFO()
        ci.cbSize = ctypes.sizeof(CURSORINFO)
        ctypes.windll.user32.GetCursorInfo(ctypes.byref(ci))  # type: ignore[attr-defined]

        # 系统标准光标句柄映射
        # OCR_NORMAL=32512, OCR_IBEAM=32513, OCR_WAIT=32514,
        # OCR_APPSTARTING=32650 等
        cursor_handle = ci.hCursor
        standard_cursors = {
            ctypes.windll.user32.LoadCursorW(0, 32512): "normal",   # type: ignore[attr-defined]
            ctypes.windll.user32.LoadCursorW(0, 32513): "text",     # type: ignore[attr-defined]
            ctypes.windll.user32.LoadCursorW(0, 32514): "busy",     # type: ignore[attr-defined]
            ctypes.windll.user32.LoadCursorW(0, 32515): "cross",    # type: ignore[attr-defined]
            ctypes.windll.user32.LoadCursorW(0, 32650): "busy",     # type: ignore[attr-defined]  # app starting
        }
        return standard_cursors.get(cursor_handle, "other")
    except Exception:
        return "unknown"


def run_ocr_on_image(img: Any, lang: str = "zh-Hans") -> list[dict[str, Any]]:
    """
    使用 Windows 原生 OCR (winocr) 识别图片中的文字。
    返回 [{"text": str, "x": int, "y": int, "width": int, "height": int}, ...] 列表。
    x,y 是元素中心坐标，width/height 是文字区域尺寸。
    """
    try:
        from winocr import recognize_pil_sync
    except ImportError:
        output_error(
            "winocr is not installed. Please run: pip install winocr",
            "DEPENDENCY_MISSING"
        )
        return []  # 不会执行到这里

    try:
        result = recognize_pil_sync(img, lang)
        elements: list[dict[str, Any]] = []
        for line_index, line in enumerate(result.get("lines", [])):
            words = line.get("words", [])
            if not words:
                continue

            line_text = line.get("text", "").strip()
            if not line_text:
                line_text = "".join(w.get("text", "") for w in words)

            def element_from_words(selected_words: list[dict[str, Any]], text: str, kind: str) -> dict[str, Any]:
                min_x = min(w.get("bounding_rect", {}).get("x", 0) for w in selected_words)
                min_y = min(w.get("bounding_rect", {}).get("y", 0) for w in selected_words)
                max_r = max(w.get("bounding_rect", {}).get("x", 0) + w.get("bounding_rect", {}).get("width", 0) for w in selected_words)
                max_b = max(w.get("bounding_rect", {}).get("y", 0) + w.get("bounding_rect", {}).get("height", 0) for w in selected_words)
                ww = max_r - min_x
                wh = max_b - min_y
                return {
                    "text": text,
                    "x": int(round(min_x + ww / 2)),
                    "y": int(round(min_y + wh / 2)),
                    "width": int(round(ww)),
                    "height": int(round(wh)),
                    "kind": kind,
                    "line_index": line_index,
                }

            elements.append({
                **element_from_words(words, line_text, "line"),
                "word_count": len(words),
            })

            # 额外输出 word/phrase 级候选，避免一行多个按钮时点击到整行中心。
            clean_words = [
                w for w in words
                if str(w.get("text", "")).strip()
            ]
            for word_index, word in enumerate(clean_words):
                word_text = str(word.get("text", "")).strip()
                item = element_from_words([word], word_text, "word")
                item["word_index"] = word_index
                elements.append(item)

            max_phrase_words = min(6, len(clean_words))
            for start in range(len(clean_words)):
                for end in range(start + 2, min(len(clean_words), start + max_phrase_words) + 1):
                    phrase_words = clean_words[start:end]
                    phrase_text = "".join(str(w.get("text", "")).strip() for w in phrase_words)
                    if len(phrase_text) < 2 or len(phrase_text) > 20:
                        continue
                    item = element_from_words(phrase_words, phrase_text, "phrase")
                    item["word_start"] = start
                    item["word_end"] = end - 1
                    elements.append(item)

        return elements
    except Exception as e:
        # OCR 失败不应阻断截屏，降级为无 OCR 结果
        return [{"error": f"OCR recognition failed: {e}"}]


def select_ocr_output_detail(
    ocr_elements: list[dict[str, Any]],
    detail: str | None,
    has_filter: bool = False,
) -> list[dict[str, Any]]:
    """收敛 observe/screenshot 的 OCR 输出粒度，避免默认 JSON 过长。"""
    effective_detail = detail or ("full" if has_filter else "line")
    if effective_detail == "full":
        return ocr_elements
    if effective_detail == "line_word":
        return [
            el for el in ocr_elements
            if el.get("kind") in {"line", "word"} or "error" in el
        ]
    return [
        el for el in ocr_elements
        if el.get("kind") == "line" or "error" in el
    ]


def compute_ssim_simple(img1: Any, img2: Any, target_size: tuple[int, int] = (256, 144)) -> float:
    """
    计算两张图片的结构相似度（简化版 SSIM）。
    将图片缩放到低分辨率后逐像素对比，天然过滤光标闪烁等微小噪声。
    返回 0.0-1.0，1.0 表示完全相同。
    仅依赖 PIL，无需 numpy/opencv。
    """
    # 缩放到低分辨率灰度图
    from PIL import Image
    g1 = img1.resize(target_size, Image.Resampling.LANCZOS).convert("L")
    g2 = img2.resize(target_size, Image.Resampling.LANCZOS).convert("L")

    pixels1 = g1.tobytes()
    pixels2 = g2.tobytes()
    n = len(pixels1)

    if n == 0:
        return 0.0

    # 均值
    mean1 = sum(pixels1) / n
    mean2 = sum(pixels2) / n

    # 方差和协方差
    var1 = sum((p - mean1) ** 2 for p in pixels1) / n
    var2 = sum((p - mean2) ** 2 for p in pixels2) / n
    covar = sum((p1 - mean1) * (p2 - mean2) for p1, p2 in zip(pixels1, pixels2)) / n

    # SSIM 公式中的稳定常数
    c1 = (0.01 * 255) ** 2
    c2 = (0.03 * 255) ** 2

    numerator = (2 * mean1 * mean2 + c1) * (2 * covar + c2)
    denominator = (mean1 ** 2 + mean2 ** 2 + c1) * (var1 + var2 + c2)

    if denominator == 0:
        return 1.0 if numerator == 0 else 0.0

    return max(0.0, min(1.0, numerator / denominator))


def get_coordinate_bounds(screen_width: int, screen_height: int) -> tuple[int, int, int, int]:
    """返回可用桌面坐标范围，优先使用多显示器真实边界。"""
    monitors = get_monitors()
    if not monitors:
        return 0, 0, screen_width - 1, screen_height - 1

    min_x = min(m["x"] for m in monitors)
    min_y = min(m["y"] for m in monitors)
    max_x = max(m["x"] + m["width"] - 1 for m in monitors)
    max_y = max(m["y"] + m["height"] - 1 for m in monitors)
    return min_x, min_y, max_x, max_y


def parse_coordinate(value: Any, label: str) -> int:
    """接受 int 或 1726.0 这类 OCR 浮点坐标，并转换为整数像素。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        output_error(f"{label} coordinate must be a number: {value}", "INVALID_ARGS")

    if not math.isfinite(number):
        output_error(f"{label} coordinate must be a finite number: {value}", "INVALID_ARGS")

    return int(round(number))


def validate_coordinates(
    x: int, y: int,
    screen_width: int, screen_height: int,
    label: str = "target"
) -> None:
    """
    校验坐标是否在屏幕范围内。
    越界时输出结构化错误并退出。
    """
    min_x, min_y, max_x, max_y = get_coordinate_bounds(screen_width, screen_height)
    if x < min_x or x > max_x or y < min_y or y > max_y:
        output_error(
            f"{label} coordinate ({x}, {y}) is outside screen bounds "
            f"({min_x}-{max_x}, {min_y}-{max_y})",
            "COORDINATES_OUT_OF_BOUNDS"
        )


def parse_region(
    region_text: str | None,
    screen_width: int,
    screen_height: int,
    clip_to_bounds: bool = False,
) -> tuple[int, int, int, int] | None:
    """解析并校验 x,y,width,height 截图区域。"""
    if not region_text:
        return None

    parts = region_text.split(",")
    if len(parts) != 4:
        output_error(
            "Invalid region format; expected: x,y,width,height (for example 100,100,800,600)",
            "INVALID_ARGS"
        )
    try:
        x, y, width, height = (parse_coordinate(p.strip(), "region") for p in parts)
    except ValueError:
        output_error("region parameters must be numbers", "INVALID_ARGS")

    if width <= 0 or height <= 0:
        output_error("region width and height must be greater than 0", "INVALID_ARGS")

    if clip_to_bounds:
        min_x, min_y, max_x, max_y = get_coordinate_bounds(screen_width, screen_height)
        end_x = x + width - 1
        end_y = y + height - 1
        clipped_x = max(x, min_x)
        clipped_y = max(y, min_y)
        clipped_end_x = min(end_x, max_x)
        clipped_end_y = min(end_y, max_y)
        if clipped_x > clipped_end_x or clipped_y > clipped_end_y:
            output_error(
                f"region ({x}, {y}, {width}, {height}) does not overlap screen bounds "
                f"({min_x}-{max_x}, {min_y}-{max_y})",
                "COORDINATES_OUT_OF_BOUNDS",
            )
        return clipped_x, clipped_y, clipped_end_x - clipped_x + 1, clipped_end_y - clipped_y + 1

    validate_coordinates(x, y, screen_width, screen_height, "region start")
    validate_coordinates(x + width - 1, y + height - 1, screen_width, screen_height, "region end")
    return x, y, width, height


def get_observation_profile(args: argparse.Namespace) -> str:
    """读取观察策略，兼容未提供 profile 的旧命令。"""
    profile = getattr(args, "profile", "vision")
    if profile == "vision" and getattr(args, "ocr", False):
        return "hybrid"
    return profile


def should_run_ocr(args: argparse.Namespace) -> bool:
    """显式 --ocr 或 OCR/hybrid profile 都启用 OCR。"""
    return bool(getattr(args, "ocr", False)) or get_observation_profile(args) in ("ocr", "hybrid")


def build_analysis_routes(
    profile: str,
    output_path: str,
    width: int,
    height: int,
    region: tuple[int, int, int, int] | None,
    ocr_enabled: bool,
) -> dict[str, Any]:
    """返回给 agent 的双通道观察提示：多模态看图，非多模态读 OCR。"""
    return {
        "profile": profile,
        "coordinate_system": "screen_absolute",
        "vision": {
            "available": True,
            "screenshot_path": output_path,
            "width": width,
            "height": height,
            "region": region,
            "primary_for": [
                "layout",
                "icons",
                "buttons_without_text",
                "disabled_or_selected_state",
                "occlusion_or_popup_detection",
            ],
        },
        "ocr": {
            "enabled": ocr_enabled,
            "primary_for": [
                "visible_text",
                "text_center_coordinates",
                "keyword_filtering",
                "non_multimodal_fallback",
            ],
            "note": "ocr_elements x/y are screen absolute coordinates; image_x/image_y are present for region captures.",
        },
        "recommended_loop": [
            "observe",
            "decide using vision first when available, otherwise OCR",
            "act",
            "wait_stable",
            "observe again to verify",
        ],
    }


POPUP_KEYWORDS = [
    "确定", "取消", "允许", "关闭", "更新", "权限", "继续", "同意", "拒绝",
    "确认", "稍后", "立即", "安装", "管理员",
    "ok", "cancel", "allow", "deny", "close", "update", "permission",
    "continue", "confirm", "later", "install", "administrator",
]
POPUP_STRONG_KEYWORDS = [
    "确定", "取消", "允许", "关闭", "继续", "同意", "拒绝", "确认", "稍后", "立即", "安装", "管理员",
    "ok", "cancel", "allow", "deny", "close", "continue", "confirm", "later", "install", "administrator",
]


def normalize_text_for_match(text: str, case_sensitive: bool = False) -> str:
    """弱化 OCR 空格噪声，方便匹配中文和按钮文案。"""
    normalized = "".join(str(text).split())
    if not case_sensitive:
        normalized = normalized.lower()
    return normalized


def detect_possible_popup(ocr_elements: list[dict[str, Any]]) -> dict[str, Any]:
    """基于常见弹窗按钮/权限词做轻量提示，不直接代替视觉判断。"""
    candidates: list[dict[str, Any]] = []
    normalized_keywords = [normalize_text_for_match(k) for k in POPUP_KEYWORDS]
    strong_keywords = [normalize_text_for_match(k) for k in POPUP_STRONG_KEYWORDS]

    for el in ocr_elements:
        text = el.get("text", "")
        normalized = normalize_text_for_match(text)
        hits = [kw for kw in normalized_keywords if kw and kw in normalized]
        if hits:
            strong_hits = [kw for kw in strong_keywords if kw and kw in normalized]
            confidence = 0.35
            if strong_hits and len(normalized) <= 12 and "/" not in normalized:
                confidence = 0.85
            elif strong_hits and "/" not in normalized:
                confidence = 0.6
            elif len(hits) >= 2 and "/" not in normalized:
                confidence = 0.55

            candidates.append({
                "text": text,
                "x": el.get("x"),
                "y": el.get("y"),
                "width": el.get("width"),
                "height": el.get("height"),
                "keywords": hits,
                "confidence": confidence,
            })

    return {
        "possible_popup": any(c.get("confidence", 0) >= 0.7 for c in candidates),
        "popup_candidates": sorted(candidates, key=lambda c: c.get("confidence", 0), reverse=True)[:10],
    }


def match_ocr_elements(
    ocr_elements: list[dict[str, Any]],
    query: str,
    match_mode: str = "contains",
    case_sensitive: bool = False,
    min_score: float = 0.6,
) -> list[dict[str, Any]]:
    """从 OCR 元素中查找文本，返回按 score 排序的候选。"""
    import difflib
    import re

    query_raw = query if case_sensitive else query.lower()
    query_norm = normalize_text_for_match(query, case_sensitive)
    matches: list[dict[str, Any]] = []

    for el in ocr_elements:
        if "error" in el:
            continue

        text = str(el.get("text", ""))
        cmp_raw = text if case_sensitive else text.lower()
        cmp_norm = normalize_text_for_match(text, case_sensitive)
        score = 0.0
        matched = False

        if match_mode == "exact":
            matched = cmp_norm == query_norm
            score = 1.0 if matched else 0.0
        elif match_mode == "regex":
            try:
                flags = 0 if case_sensitive else re.IGNORECASE
                matched = bool(re.search(query, text, flags))
                score = 1.0 if matched else 0.0
            except re.error as e:
                output_error(f"Invalid regex format: {e}", "INVALID_ARGS")
        elif match_mode == "fuzzy":
            score = difflib.SequenceMatcher(None, query_norm, cmp_norm).ratio()
            matched = score >= min_score
        else:
            matched = query_norm in cmp_norm or query_raw in cmp_raw
            if matched:
                score = len(query_norm) / max(len(cmp_norm), 1)
                score = max(score, 0.75)

        if matched:
            item = dict(el)
            item["score"] = round(score, 4)
            item["match_mode"] = match_mode
            matches.append(item)

    kind_priority = {"phrase": 3, "word": 2, "line": 1}
    matches.sort(
        key=lambda item: (item.get("score", 0), kind_priority.get(item.get("kind"), 0)),
        reverse=True,
    )
    return matches


def compute_anchor_click_point(
    element: dict[str, Any],
    anchor: str,
    offset_x: int = 0,
    offset_y: int = 0,
) -> dict[str, Any]:
    """Compute a click point from an OCR element bbox anchor plus offset."""
    center_x = float(element.get("x", 0))
    center_y = float(element.get("y", 0))
    width = float(element.get("width", 0) or 0)
    height = float(element.get("height", 0) or 0)

    left = center_x - width / 2
    right = center_x + width / 2
    top = center_y - height / 2
    bottom = center_y + height / 2

    anchor_points = {
        "center": (center_x, center_y),
        "left": (left, center_y),
        "right": (right, center_y),
        "top": (center_x, top),
        "bottom": (center_x, bottom),
        "top-left": (left, top),
        "top-right": (right, top),
        "bottom-left": (left, bottom),
        "bottom-right": (right, bottom),
    }
    if anchor not in anchor_points:
        output_error(f"Unknown anchor: {anchor}", "INVALID_ARGS")

    anchor_x, anchor_y = anchor_points[anchor]
    click_x = int(round(anchor_x + offset_x))
    click_y = int(round(anchor_y + offset_y))

    return {
        "anchor": anchor,
        "anchor_x": int(round(anchor_x)),
        "anchor_y": int(round(anchor_y)),
        "offset_x": offset_x,
        "offset_y": offset_y,
        "x": click_x,
        "y": click_y,
    }


def add_region_offset_to_ocr(
    ocr_elements: list[dict[str, Any]],
    region: tuple[int, int, int, int] | None,
) -> None:
    """region 截图时，将 OCR 局部坐标转换为屏幕绝对坐标。"""
    if not region:
        return
    for el in ocr_elements:
        if "x" in el and "y" in el:
            el["image_x"] = el["x"]
            el["image_y"] = el["y"]
            el["x"] = el["x"] + region[0]
            el["y"] = el["y"] + region[1]


def should_mark_ocr_element(el: dict[str, Any], mark_level: str) -> bool:
    """决定 OCR 标注粒度，避免把一行多个可点击项画成一个误导性长框。"""
    kind = el.get("kind", "line")
    if mark_level == "all":
        return kind in ("line", "word", "phrase")
    if mark_level == "line":
        return kind == "line"
    if mark_level == "word":
        return kind == "word"
    if mark_level == "phrase":
        return kind == "phrase"

    # smart: 短行画整行；长行画 word，避免“切换账号 | 仅传输文件”被框成一个中心点。
    if kind == "line":
        return el.get("word_count", 1) <= 3
    if kind == "word":
        return True
    return False


def draw_ocr_marks(img: Any, ocr_elements: list[dict[str, Any]], mark_level: str = "smart") -> None:
    """在截图上绘制 OCR 标注。"""
    from PIL import ImageDraw

    draw = ImageDraw.Draw(img)
    for i, el in enumerate(ocr_elements):
        if not should_mark_ocr_element(el, mark_level):
            continue
        el["id"] = i
        cx = el.get("image_x", el.get("x", 0))
        cy = el.get("image_y", el.get("y", 0))
        w = el.get("width", 0)
        h = el.get("height", 0)
        left = cx - w // 2
        top = cy - h // 2
        draw.rectangle([left, top, left + w, top + h], outline="red", width=2)
        text_bg = [left, max(0, top - 12), left + 14, max(0, top)]
        draw.rectangle(text_bg, fill="red")
        draw.text((left + 2, max(0, top - 12)), str(i), fill="white")


def validate_grid_step(step: int | None) -> int | None:
    """Validate optional visual coordinate grid step."""
    if step is None:
        return None
    if step < 20:
        output_error("--grid must be an integer pixel interval no smaller than 20 to avoid an overly dense grid affecting recognition", "INVALID_ARGS")
    return step


def validate_grid_label_size(size: int | None) -> int | None:
    """Validate optional grid label font size."""
    if size is None:
        return None
    if size < 10 or size > 96:
        output_error("--grid-label-size must be between 10 and 96", "INVALID_ARGS")
    return size


def resolve_grid_label_size(img: Any, requested_size: int | None) -> int:
    """Choose a readable grid label size for full-screen and region captures."""
    if requested_size is not None:
        return requested_size
    width, height = img.size
    return max(18, min(34, int(round(max(width, height) / 120))))


def build_grid_metadata(
    step: int | None,
    region: tuple[int, int, int, int] | None,
    label_size: int | None = None,
) -> dict[str, Any] | None:
    """Return compact metadata for a visual grid overlay."""
    if step is None:
        return None
    origin_x = region[0] if region else 0
    origin_y = region[1] if region else 0
    return {
        "enabled": True,
        "step": step,
        "coordinate_system": "screen_absolute",
        "origin_x": origin_x,
        "origin_y": origin_y,
        "label_mode": "screen_absolute",
        "label_size": label_size,
        "label_strategy": "adaptive_orientation_and_density",
        "json_detail": "metadata_only",
    }


def load_grid_font(size: int) -> Any:
    """Load a scalable font for grid labels, with safe fallbacks."""
    from PIL import ImageFont

    font_candidates = [
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/consola.ttf",
        "arial.ttf",
    ]
    for font_path in font_candidates:
        try:
            return ImageFont.truetype(font_path, size=size)
        except Exception:
            continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def draw_coordinate_grid(
    img: Any,
    step: int | None,
    region: tuple[int, int, int, int] | None = None,
    label_size: int | None = None,
) -> None:
    """Draw a lightweight screen-absolute coordinate grid on the screenshot."""
    if step is None:
        return

    from PIL import Image, ImageDraw

    width, height = img.size
    origin_x = region[0] if region else 0
    origin_y = region[1] if region else 0
    resolved_label_size = resolve_grid_label_size(img, label_size)
    font = load_grid_font(resolved_label_size)

    overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    line_width = 2 if max(width, height) >= 2500 else 1
    line_color = (56, 189, 248, 95)
    axis_color = (14, 165, 233, 140)
    label_fill = (255, 255, 255, 245)
    label_bg = (0, 0, 0, 175)
    label_pad = max(3, resolved_label_size // 7)
    label_gap = max(4, resolved_label_size // 5)

    def first_tick(origin: int) -> int:
        return ((origin + step - 1) // step) * step

    def text_size_for(text: str) -> tuple[int, int]:
        bbox = draw.textbbox((0, 0), text, font=font)
        return bbox[2] - bbox[0], bbox[3] - bbox[1]

    def label_size_for(text: str) -> tuple[int, int]:
        text_w, text_h = text_size_for(text)
        return text_w + label_pad * 2, text_h + label_pad * 2

    def rotated_label_size_for(text: str) -> tuple[int, int]:
        label_w, label_h = label_size_for(text)
        return label_h, label_w

    def label_stride(label_extent: int, tick_step: int) -> int:
        """Return how many grid ticks to skip between labels to avoid overlap."""
        return max(1, math.ceil((label_extent + label_gap) / max(1, tick_step)))

    sample_x_label = f"x={origin_x + width - 1}"
    sample_y_label = f"y={origin_y + height - 1}"
    sample_x_horizontal_w, _sample_x_horizontal_h = label_size_for(sample_x_label)
    sample_x_vertical_w, _sample_x_vertical_h = rotated_label_size_for(sample_x_label)
    x_labels_vertical = step < sample_x_horizontal_w + label_gap
    x_label_stride = label_stride(sample_x_vertical_w if x_labels_vertical else sample_x_horizontal_w, step)
    sample_y_w, sample_y_h = label_size_for(sample_y_label)
    y_label_gutter = sample_y_w + label_gap
    y_label_stride = label_stride(sample_y_h, step)

    def draw_label(position: tuple[int, int], text: str) -> tuple[int, int, int, int]:
        x, y = position
        bbox = draw.textbbox((x, y), text, font=font)
        bg = [
            bbox[0] - label_pad,
            bbox[1] - label_pad,
            bbox[2] + label_pad,
            bbox[3] + label_pad,
        ]
        draw.rectangle(bg, fill=label_bg)
        draw.text((x, y), text, fill=label_fill, font=font)
        return bg

    def draw_vertical_label(position: tuple[int, int], text: str) -> tuple[int, int, int, int]:
        x, y = position
        text_w, text_h = text_size_for(text)
        label_w = text_w + label_pad * 2
        label_h = text_h + label_pad * 2
        label_img = Image.new("RGBA", (label_w, label_h), (0, 0, 0, 0))
        label_draw = ImageDraw.Draw(label_img)
        label_draw.rectangle([0, 0, label_w, label_h], fill=label_bg)
        label_draw.text((label_pad, label_pad), text, fill=label_fill, font=font)
        rotated = label_img.rotate(90, expand=True)
        overlay.alpha_composite(rotated, dest=(x, y))
        return [x, y, x + rotated.width, y + rotated.height]

    tick_index = 0
    tick_x = first_tick(origin_x)
    while tick_x <= origin_x + width - 1:
        local_x = tick_x - origin_x
        color = axis_color if tick_x == 0 else line_color
        draw.line([(local_x, 0), (local_x, height)], fill=color, width=line_width)
        if tick_index % x_label_stride == 0:
            label_text = f"x={tick_x}"
            if x_labels_vertical:
                label_w, label_h = rotated_label_size_for(label_text)
                if local_x < y_label_gutter:
                    tick_x += step
                    tick_index += 1
                    continue
                label_x = min(max(local_x + 2, label_pad), max(label_pad, width - label_w - label_pad))
                draw_vertical_label((label_x, label_pad), label_text)
            else:
                label_w, _label_h = label_size_for(label_text)
                if local_x < y_label_gutter:
                    tick_x += step
                    tick_index += 1
                    continue
                label_x = min(max(local_x + 6, label_pad), max(label_pad, width - label_w - label_pad))
                draw_label((label_x, label_pad), label_text)
        tick_x += step
        tick_index += 1

    tick_index = 0
    tick_y = first_tick(origin_y)
    while tick_y <= origin_y + height - 1:
        local_y = tick_y - origin_y
        color = axis_color if tick_y == 0 else line_color
        draw.line([(0, local_y), (width, local_y)], fill=color, width=line_width)
        if tick_index % y_label_stride == 0:
            label_text = f"y={tick_y}"
            _label_w, label_h = label_size_for(label_text)
            label_y = min(max(local_y + 6, label_pad), max(label_pad, height - label_h - label_pad))
            draw_label((label_pad, label_y), label_text)
        tick_y += step
        tick_index += 1

    if img.mode == "RGBA":
        img.alpha_composite(overlay)
    else:
        composed = Image.alpha_composite(img.convert("RGBA"), overlay).convert(img.mode)
        img.paste(composed)


def save_observation_image(args: argparse.Namespace, prefix: str) -> str:
    """生成观察类命令的默认输出路径。"""
    output_path = getattr(args, "output", None)
    if output_path:
        return output_path
    temp_dir = tempfile.gettempdir()
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    return os.path.join(temp_dir, f"{prefix}_{timestamp}.png")


def has_non_ascii(text: str) -> bool:
    """检测文本是否包含非 ASCII 字符（中文、日文、emoji 等）"""
    return any(ord(c) > 127 for c in text)


def configure_pyautogui(pag: Any) -> None:
    """
    配置 pyautogui 全局参数。
    设置合理的操作间延迟，防止 GUI 竞态。
    """
    pag.FAILSAFE = True
    # 操作间 50ms 延迟，平衡速度与 GUI 响应
    pag.PAUSE = 0.05
    pag.MINIMUM_DURATION = 0
    pag.MINIMUM_SLEEP = 0


# ==================== 子命令实现 ====================

def cmd_info(_args: argparse.Namespace) -> None:
    """获取屏幕和环境信息（含多显示器边界、鼠标光标状态）"""
    pag = check_pyautogui()
    configure_pyautogui(pag)

    screen_w, screen_h = pag.size()
    mouse_x, mouse_y = pag.position()
    dpi_scale = get_dpi_scale()
    cursor_type = get_cursor_type()
    monitors = get_monitors()
    min_x, min_y, max_x, max_y = get_coordinate_bounds(screen_w, screen_h)

    # 尝试获取活动窗口信息
    active_window = None
    try:
        import pygetwindow as gw
        win = gw.getActiveWindow()
        if win:
            active_window = {
                "title": win.title,
                "x": win.left,
                "y": win.top,
                "width": win.width,
                "height": win.height,
            }
    except (ImportError, Exception):
        pass

    data: dict[str, Any] = {
        "screen_width": screen_w,
        "screen_height": screen_h,
        "mouse_x": mouse_x,
        "mouse_y": mouse_y,
        "dpi_scale": dpi_scale,
        "coordinate_system": "physical_screen_pixels",
        "dpi_note": (
            "Screenshot, OCR, click, and region coordinates use physical screen pixels. "
            "If coordinates come from logical/UI-scaled sources, multiply them by dpi_scale."
        ),
        "cursor_type": cursor_type,
        "platform": platform.system(),
        "coordinate_bounds": {
            "min_x": min_x,
            "min_y": min_y,
            "max_x": max_x,
            "max_y": max_y,
        },
        "active_window": active_window,
    }
    if monitors:
        data["monitors"] = monitors

    output_success(data)


def cmd_click(args: argparse.Namespace) -> None:
    """鼠标点击"""
    pag = check_pyautogui()
    configure_pyautogui(pag)

    screen_w, screen_h = pag.size()

    if (args.x is None) != (args.y is None):
        output_error("click coordinates must provide x and y together, or omit both to click the current position", "INVALID_ARGS")

    click_x = None
    click_y = None
    if args.x is not None and args.y is not None:
        click_x = parse_coordinate(args.x, "click x")
        click_y = parse_coordinate(args.y, "click y")
        validate_coordinates(click_x, click_y, screen_w, screen_h, "click")

    # --verify：点击前校验活动窗口标题是否匹配预期
    # 防止焦点被弹窗/通知抢夺后盲目点击到错误窗口
    verify_title = getattr(args, "verify", None)
    if verify_title:
        try:
            import pygetwindow as gw
            active_win = gw.getActiveWindow()
            actual_title = active_win.title if active_win else "<no active window>"
            if verify_title.lower() not in actual_title.lower():
                output_error(
                    f"Focus verification failed: expected window to contain '{verify_title}', "
                    f"but the current active window is '{actual_title}'. "
                    f"Use window activate to switch to the target window first, or clear the blocking popup.",
                    "FOCUS_MISMATCH"
                )
        except ImportError:
            # pygetwindow 未安装时降级为不校验，不阻断操作
            pass
        except Exception:
            pass

    button = args.button
    clicks = args.clicks

    try:
        pag.click(x=click_x, y=click_y, clicks=clicks, interval=0.1, button=button)
        # 获取点击后的实际位置
        final_x, final_y = pag.position()
        output_success({
            "action": "click",
            "x": final_x,
            "y": final_y,
            "button": button,
            "clicks": clicks,
        })
    except Exception as e:
        output_error(f"Click failed: {e}", "CLICK_FAILED")


def cmd_click_relative(args: argparse.Namespace) -> None:
    """基于 region 的局部坐标点击，避免 agent 手动换算绝对坐标。"""
    pag = check_pyautogui()
    configure_pyautogui(pag)

    screen_w, screen_h = pag.size()
    region = parse_region(args.region, screen_w, screen_h)
    if not region:
        output_error("click_relative requires --region x,y,width,height", "INVALID_ARGS")

    local_x = parse_coordinate(args.x, "click_relative x")
    local_y = parse_coordinate(args.y, "click_relative y")
    if local_x < 0 or local_y < 0 or local_x >= region[2] or local_y >= region[3]:
        output_error(
            f"Local coordinate ({local_x}, {local_y}) is outside region size ({region[2]}x{region[3]})",
            "COORDINATES_OUT_OF_BOUNDS",
        )

    click_x = region[0] + local_x
    click_y = region[1] + local_y
    validate_coordinates(click_x, click_y, screen_w, screen_h, "click_relative")

    try:
        if not args.dry_run:
            pag.click(x=click_x, y=click_y, clicks=args.clicks, interval=0.1, button=args.button)
        output_success({
            "action": "click_relative",
            "clicked": not args.dry_run,
            "region": region,
            "local_x": local_x,
            "local_y": local_y,
            "x": click_x,
            "y": click_y,
            "button": args.button,
            "clicks": args.clicks,
        })
    except Exception as e:
        output_error(f"Relative click failed: {e}", "CLICK_RELATIVE_FAILED")


def cmd_move(args: argparse.Namespace) -> None:
    """移动鼠标"""
    pag = check_pyautogui()
    configure_pyautogui(pag)

    screen_w, screen_h = pag.size()
    move_x = parse_coordinate(args.x, "move x")
    move_y = parse_coordinate(args.y, "move y")
    validate_coordinates(move_x, move_y, screen_w, screen_h, "move")

    duration = max(0, args.duration)

    try:
        if args.smooth and duration > 0:
            pag.moveTo(move_x, move_y, duration=duration, tween=pag.easeInOutQuad)
        else:
            pag.moveTo(move_x, move_y, duration=duration)

        final_x, final_y = pag.position()
        output_success({
            "action": "move",
            "x": final_x,
            "y": final_y,
        })
    except Exception as e:
        output_error(f"Mouse move failed: {e}", "MOVE_FAILED")


def cmd_type(args: argparse.Namespace) -> None:
    """
    键入文本。
    默认始终使用 clipboard 粘贴方案，以彻底绕开中文输入法（IME）拦截。
    只有在未包含非 ASCII 字符且明确指定了 --wpm 时，才使用逐字击键模拟。
    """
    pag = check_pyautogui()
    configure_pyautogui(pag)

    text = args.text
    method_used = "keyboard"

    try:
        # 只要没有强制要求模拟打字速度 (wpm)，或者包含中文，一律走剪贴板
        if has_non_ascii(text) or not (args.wpm and args.wpm > 0):
            pyperclip = check_pyperclip()
            original_clipboard = None
            try:
                original_clipboard = pyperclip.paste()
            except Exception:
                pass

            pyperclip.copy(text)
            time.sleep(0.05)
            pag.hotkey("ctrl", "v")
            time.sleep(0.1)
            method_used = "clipboard_paste"

            if original_clipboard is not None:
                try:
                    time.sleep(0.1)
                    pyperclip.copy(original_clipboard)
                except Exception:
                    pass
        else:
            # 只有明确指定了 --wpm 且全是 ASCII 时，才老老实实逐字打字
            interval = 0.0
            chars_per_second = (args.wpm * 5) / 60.0
            interval = 1.0 / chars_per_second
            pag.write(text, interval=interval)

        output_success({
            "action": "type",
            "length": len(text),
            "method": method_used,
        })
    except Exception as e:
        output_error(f"Text input failed: {e}", "TYPE_FAILED")


def cmd_press(args: argparse.Namespace) -> None:
    """按下单个按键"""
    pag = check_pyautogui()
    configure_pyautogui(pag)

    try:
        pag.press(args.key, presses=args.presses, interval=0.1)
        output_success({
            "action": "press",
            "key": args.key,
            "presses": args.presses,
        })
    except Exception as e:
        output_error(f"Key press failed: {e}", "PRESS_FAILED")


def cmd_hotkey(args: argparse.Namespace) -> None:
    """执行快捷键组合"""
    pag = check_pyautogui()
    configure_pyautogui(pag)

    keys = args.keys
    if not keys:
        output_error("At least one key must be specified", "INVALID_ARGS")

    try:
        pag.hotkey(*keys, interval=0.05)
        output_success({
            "action": "hotkey",
            "keys": keys,
            "combo": "+".join(keys),
        })
    except Exception as e:
        output_error(f"Hotkey execution failed: {e}", "HOTKEY_FAILED")


def cmd_drag(args: argparse.Namespace) -> None:
    """鼠标拖拽"""
    pag = check_pyautogui()
    configure_pyautogui(pag)

    screen_w, screen_h = pag.size()
    x1 = parse_coordinate(args.x1, "drag x1")
    y1 = parse_coordinate(args.y1, "drag y1")
    x2 = parse_coordinate(args.x2, "drag x2")
    y2 = parse_coordinate(args.y2, "drag y2")
    validate_coordinates(x1, y1, screen_w, screen_h, "drag start")
    validate_coordinates(x2, y2, screen_w, screen_h, "drag end")

    duration = max(0.1, args.duration)

    try:
        pag.moveTo(x1, y1)
        time.sleep(0.05)
        pag.drag(
            x2 - x1,
            y2 - y1,
            duration=duration,
            button=args.button,
        )
        final_x, final_y = pag.position()
        output_success({
            "action": "drag",
            "from": {"x": x1, "y": y1},
            "to": {"x": final_x, "y": final_y},
            "button": args.button,
        })
    except Exception as e:
        output_error(f"Drag failed: {e}", "DRAG_FAILED")


def cmd_scroll(args: argparse.Namespace) -> None:
    """滚动鼠标滚轮"""
    pag = check_pyautogui()
    configure_pyautogui(pag)

    try:
        if (args.x is None) != (args.y is None):
            output_error("scroll position coordinates must provide x and y together, or omit both", "INVALID_ARGS")

        # 如果指定了位置，先移动到该位置
        if args.x is not None and args.y is not None:
            screen_w, screen_h = pag.size()
            scroll_x = parse_coordinate(args.x, "scroll x")
            scroll_y = parse_coordinate(args.y, "scroll y")
            validate_coordinates(scroll_x, scroll_y, screen_w, screen_h, "scroll")
            pag.moveTo(scroll_x, scroll_y)

        if args.direction == "horizontal":
            pag.hscroll(args.amount)
        else:
            pag.scroll(args.amount)

        output_success({
            "action": "scroll",
            "amount": args.amount,
            "direction": args.direction,
        })
    except Exception as e:
        output_error(f"Scroll failed: {e}", "SCROLL_FAILED")


def cmd_screenshot(args: argparse.Namespace) -> None:
    """截取屏幕，可附带 OCR 文字识别"""
    pag = check_pyautogui()
    configure_pyautogui(pag)

    screen_w, screen_h = pag.size()
    region = parse_region(args.region, screen_w, screen_h, clip_to_bounds=True)
    profile = get_observation_profile(args)
    ocr_enabled = should_run_ocr(args)
    grid_step = validate_grid_step(getattr(args, "grid", None))
    grid_label_size = validate_grid_label_size(getattr(args, "grid_label_size", None))

    try:
        img = pag.screenshot(region=region)
        resolved_grid_label_size = resolve_grid_label_size(img, grid_label_size) if grid_step else None

        # 确定输出路径
        output_path = save_observation_image(args, "screenshot")

        result_data: dict[str, Any] = {
            "action": "screenshot",
            "path": output_path,
            "width": img.width,
            "height": img.height,
            "analysis": build_analysis_routes(profile, output_path, img.width, img.height, region, ocr_enabled),
        }
        grid_metadata = build_grid_metadata(grid_step, region, resolved_grid_label_size)
        if grid_metadata:
            result_data["grid"] = grid_metadata

        # OCR 文字识别（可选）
        if ocr_enabled:
            lang = args.lang or "zh-Hans"
            ocr_elements = run_ocr_on_image(img, lang)
            raw_ocr_count = len(ocr_elements)
            popup_detection = detect_possible_popup(ocr_elements)

            # 如果指定了 filter 关键词，只返回匹配的元素
            if args.filter and ocr_elements:
                keywords = [kw.strip().lower() for kw in args.filter.split(",")]
                ocr_elements = [
                    el for el in ocr_elements
                    if any(kw in el.get("text", "").lower() for kw in keywords)
                ]

            # 在原图上画红色标注框（Set of Marks）
            draw_coordinate_grid(img, grid_step, region, resolved_grid_label_size)
            if getattr(args, "mark", False) and ocr_elements:
                draw_ocr_marks(img, ocr_elements, args.mark_level)

            ocr_elements = select_ocr_output_detail(
                ocr_elements,
                getattr(args, "ocr_detail", None),
                has_filter=bool(args.filter),
            )
            add_region_offset_to_ocr(ocr_elements, region)

            result_data["ocr_elements"] = ocr_elements
            result_data["ocr_count"] = len(ocr_elements)
            result_data["ocr_raw_count"] = raw_ocr_count
            result_data["ocr_detail"] = getattr(args, "ocr_detail", None) or ("full" if args.filter else "line")
            result_data["popup_detection"] = popup_detection
        else:
            draw_coordinate_grid(img, grid_step, region, resolved_grid_label_size)

        # 最后保存图（此时可能已经划上了红框）
        img.save(output_path)

        output_success(result_data)
    except Exception as e:
        output_error(f"Screenshot failed: {e}", "SCREENSHOT_FAILED")


def cmd_observe(args: argparse.Namespace) -> None:
    """
    一次性获取屏幕信息、活动窗口、截图和可选 OCR。
    用于 agent 的“先看再做”循环，减少多命令之间的状态漂移。
    """
    pag = check_pyautogui()
    configure_pyautogui(pag)

    screen_w, screen_h = pag.size()
    mouse_x, mouse_y = pag.position()
    min_x, min_y, max_x, max_y = get_coordinate_bounds(screen_w, screen_h)
    region = parse_region(args.region, screen_w, screen_h, clip_to_bounds=True)
    profile = get_observation_profile(args)
    ocr_enabled = should_run_ocr(args)
    grid_step = validate_grid_step(getattr(args, "grid", None))
    grid_label_size = validate_grid_label_size(getattr(args, "grid_label_size", None))

    active_window = None
    try:
        import pygetwindow as gw
        win = gw.getActiveWindow()
        if win:
            active_window = {
                "title": win.title,
                "x": win.left,
                "y": win.top,
                "width": win.width,
                "height": win.height,
            }
    except (ImportError, Exception):
        pass

    try:
        img = pag.screenshot(region=region)
        resolved_grid_label_size = resolve_grid_label_size(img, grid_label_size) if grid_step else None

        output_path = save_observation_image(args, "observe")

        result_data: dict[str, Any] = {
            "action": "observe",
            "screen_width": screen_w,
            "screen_height": screen_h,
            "mouse_x": mouse_x,
            "mouse_y": mouse_y,
            "dpi_scale": get_dpi_scale(),
            "coordinate_system": "physical_screen_pixels",
            "dpi_note": (
                "Screenshot, OCR, click, and region coordinates use physical screen pixels. "
                "If coordinates come from logical/UI-scaled sources, multiply them by dpi_scale."
            ),
            "cursor_type": get_cursor_type(),
            "platform": platform.system(),
            "coordinate_bounds": {
                "min_x": min_x,
                "min_y": min_y,
                "max_x": max_x,
                "max_y": max_y,
            },
            "active_window": active_window,
            "screenshot": {
                "path": output_path,
                "width": img.width,
                "height": img.height,
                "region": region,
            },
            "analysis": build_analysis_routes(profile, output_path, img.width, img.height, region, ocr_enabled),
        }
        grid_metadata = build_grid_metadata(grid_step, region, resolved_grid_label_size)
        if grid_metadata:
            result_data["grid"] = grid_metadata

        if ocr_enabled:
            lang = args.lang or "zh-Hans"
            ocr_elements = run_ocr_on_image(img, lang)
            raw_ocr_count = len(ocr_elements)
            popup_detection = detect_possible_popup(ocr_elements)
            if args.filter and ocr_elements:
                keywords = [kw.strip().lower() for kw in args.filter.split(",")]
                ocr_elements = [
                    el for el in ocr_elements
                    if any(kw in el.get("text", "").lower() for kw in keywords)
                ]

            draw_coordinate_grid(img, grid_step, region, resolved_grid_label_size)
            if args.mark and ocr_elements:
                draw_ocr_marks(img, ocr_elements, args.mark_level)

            ocr_elements = select_ocr_output_detail(
                ocr_elements,
                getattr(args, "ocr_detail", None),
                has_filter=bool(args.filter),
            )
            add_region_offset_to_ocr(ocr_elements, region)

            result_data["ocr_elements"] = ocr_elements
            result_data["ocr_count"] = len(ocr_elements)
            result_data["ocr_raw_count"] = raw_ocr_count
            result_data["ocr_detail"] = getattr(args, "ocr_detail", None) or ("full" if args.filter else "line")
            result_data["popup_detection"] = popup_detection
        else:
            draw_coordinate_grid(img, grid_step, region, resolved_grid_label_size)

        img.save(output_path)
        output_success(result_data)
    except Exception as e:
        output_error(f"Screen observation failed: {e}", "OBSERVE_FAILED")


def cmd_find_text(args: argparse.Namespace) -> None:
    """OCR 查找文本并返回候选坐标。"""
    if args.index < 0:
        output_error("--index must be greater than or equal to 0", "INVALID_ARGS")

    pag = check_pyautogui()
    configure_pyautogui(pag)

    screen_w, screen_h = pag.size()
    region = parse_region(args.region, screen_w, screen_h, clip_to_bounds=True)

    try:
        img = pag.screenshot(region=region)
        output_path = save_observation_image(args, "find_text")
        lang = args.lang or "zh-Hans"
        ocr_elements = run_ocr_on_image(img, lang)

        if args.mark and ocr_elements:
            draw_ocr_marks(img, ocr_elements, args.mark_level)
        add_region_offset_to_ocr(ocr_elements, region)
        img.save(output_path)

        matches = match_ocr_elements(
            ocr_elements,
            args.text,
            args.match,
            args.case_sensitive,
            args.min_score,
        )
        fallback_used = False
        if not matches and args.match == "contains":
            matches = match_ocr_elements(
                ocr_elements,
                args.text,
                "fuzzy",
                args.case_sensitive,
                args.min_score,
            )
            fallback_used = bool(matches)
        selected = None
        if matches and args.index < len(matches):
            selected = matches[args.index]

        result_data = {
            "action": "find_text",
            "query": args.text,
            "match_mode": args.match,
            "fallback_used": fallback_used,
            "found": selected is not None,
            "selected": selected,
            "matches": matches[:args.limit],
            "match_count": len(matches),
            "screenshot": {
                "path": output_path,
                "width": img.width,
                "height": img.height,
                "region": region,
            },
            "popup_detection": detect_possible_popup(ocr_elements),
        }

        if selected is None:
            result_data["hint"] = "Text not found; try --match fuzzy, adjust --region, or have a multimodal model directly inspect screenshot.path."

        output_success(result_data)
    except Exception as e:
        output_error(f"Text search failed: {e}", "FIND_TEXT_FAILED")


def cmd_click_text(args: argparse.Namespace) -> None:
    """OCR 查找文本并点击候选中心坐标。"""
    if args.index < 0:
        output_error("--index must be greater than or equal to 0", "INVALID_ARGS")

    pag = check_pyautogui()
    configure_pyautogui(pag)

    screen_w, screen_h = pag.size()
    region = parse_region(args.region, screen_w, screen_h, clip_to_bounds=True)

    try:
        img = pag.screenshot(region=region)
        output_path = save_observation_image(args, "click_text")
        lang = args.lang or "zh-Hans"
        ocr_elements = run_ocr_on_image(img, lang)

        if args.mark and ocr_elements:
            draw_ocr_marks(img, ocr_elements, args.mark_level)
        add_region_offset_to_ocr(ocr_elements, region)
        img.save(output_path)

        popup_detection = detect_possible_popup(ocr_elements)
        if args.stop_on_popup and popup_detection["possible_popup"]:
            output_error(
                f"Possible popup detected; refusing blind click: {popup_detection['popup_candidates'][:3]}",
                "POSSIBLE_POPUP"
            )

        matches = match_ocr_elements(
            ocr_elements,
            args.text,
            args.match,
            args.case_sensitive,
            args.min_score,
        )
        fallback_used = False
        if not matches and args.match == "contains":
            matches = match_ocr_elements(
                ocr_elements,
                args.text,
                "fuzzy",
                args.case_sensitive,
                args.min_score,
            )
            fallback_used = bool(matches)
        if not matches or args.index >= len(matches):
            output_error(f"No clickable text found: {args.text}", "TEXT_NOT_FOUND")

        selected = matches[args.index]
        offset_x = 0
        offset_y = 0
        if getattr(args, "offset", None):
            offset_x = parse_coordinate(args.offset[0], "click_text offset x")
            offset_y = parse_coordinate(args.offset[1], "click_text offset y")
        click_target = compute_anchor_click_point(selected, args.anchor, offset_x, offset_y)
        click_x = parse_coordinate(click_target.get("x"), "click_text x")
        click_y = parse_coordinate(click_target.get("y"), "click_text y")
        validate_coordinates(click_x, click_y, screen_w, screen_h, "click_text")

        verify_title = getattr(args, "verify", None)
        if verify_title:
            try:
                import pygetwindow as gw
                active_win = gw.getActiveWindow()
                actual_title = active_win.title if active_win else "<no active window>"
                if verify_title.lower() not in actual_title.lower():
                    output_error(
                        f"Focus verification failed: expected window to contain '{verify_title}', current active window is '{actual_title}'.",
                        "FOCUS_MISMATCH"
                    )
            except Exception:
                pass

        if not args.dry_run:
            pag.click(x=click_x, y=click_y, clicks=args.clicks, interval=0.1, button=args.button)

        output_success({
            "action": "click_text",
            "query": args.text,
            "clicked": not args.dry_run,
            "fallback_used": fallback_used,
            "selected": selected,
            "click_target": click_target,
            "x": click_x,
            "y": click_y,
            "button": args.button,
            "clicks": args.clicks,
            "match_count": len(matches),
            "screenshot": {"path": output_path, "width": img.width, "height": img.height, "region": region},
            "popup_detection": popup_detection,
        })
    except SystemExit:
        raise
    except Exception as e:
        output_error(f"Text click failed: {e}", "CLICK_TEXT_FAILED")


def cmd_ensure_window(args: argparse.Namespace) -> None:
    """激活窗口并验证它确实位于前台。pygetwindow 找不到时自动 fallback 到进程级查找。"""
    try:
        import pygetwindow as gw
    except ImportError:
        output_error("pygetwindow is not installed. Please run: pip install pygetwindow", "DEPENDENCY_MISSING")
        return

    title = args.title
    start_time = time.time()
    attempts = 0
    last_error = None
    # 标记是否已尝试过进程级 fallback，避免每轮都重复
    process_fallback_tried = False

    while True:
        attempts += 1
        try:
            # 微信等托盘/Chromium 应用优先走进程级路径，避免 pygetwindow 只摸到白屏壳窗口。
            if not process_fallback_tried and platform.system() == "Windows" and has_uri_protocol(title):
                process_fallback_tried = True
                fallback_activated = _try_process_fallback(title, args.settle)
                if fallback_activated:
                    active = gw.getActiveWindow()
                    active_title = active.title if active else ""
                    matched = active_title == title if args.exact else title.lower() in active_title.lower()
                    if matched:
                        output_success({
                            "action": "ensure_window",
                            "ensured": True,
                            "title": active_title,
                            "method": "process_fallback",
                            "attempts": attempts,
                            "waited_seconds": round(time.time() - start_time, 2),
                            "active_window": {
                                "title": active_title,
                                "x": active.left if active else None,
                                "y": active.top if active else None,
                                "width": active.width if active else None,
                                "height": active.height if active else None,
                            },
                        })
                    last_error = f"After process-level fallback activation, foreground window is '{active_title}'"

            windows = gw.getWindowsWithTitle(title)
            if windows:
                target = windows[0]
                activation_error = None
                activated_by_hwnd = False
                try:
                    if target.isMinimized:
                        target.restore()
                        time.sleep(0.2)
                except Exception:
                    pass
                try:
                    target.activate()
                except Exception as e:
                    activation_error = str(e)

                if platform.system() == "Windows":
                    hwnd = getattr(target, "_hWnd", None)
                    if hwnd:
                        activated_by_hwnd = activate_window_by_hwnd(int(hwnd))
                time.sleep(args.settle)

                active = gw.getActiveWindow()
                active_title = active.title if active else ""
                matched = active_title == title if args.exact else title.lower() in active_title.lower()
                if matched:
                    output_success({
                        "action": "ensure_window",
                        "ensured": True,
                        "title": active_title,
                        "attempts": attempts,
                        "method": "win32_hwnd" if activated_by_hwnd else "pygetwindow",
                        "waited_seconds": round(time.time() - start_time, 2),
                        "active_window": {
                            "title": active_title,
                            "x": active.left if active else None,
                            "y": active.top if active else None,
                            "width": active.width if active else None,
                            "height": active.height if active else None,
                        },
                    })
                last_error = f"After activation, foreground window is '{active_title}'"
                if activation_error:
                    last_error += f", pygetwindow error: {activation_error}"

                if not matched and not process_fallback_tried and platform.system() == "Windows":
                    process_fallback_tried = True
                    fallback_activated = _try_process_fallback(title, args.settle)
                    if fallback_activated:
                        active = gw.getActiveWindow()
                        active_title = active.title if active else ""
                        matched = active_title == title if args.exact else title.lower() in active_title.lower()
                        if matched:
                            output_success({
                                "action": "ensure_window",
                                "ensured": True,
                                "title": active_title,
                                "method": "process_fallback",
                                "attempts": attempts,
                                "waited_seconds": round(time.time() - start_time, 2),
                                "active_window": {
                                    "title": active_title,
                                    "x": active.left if active else None,
                                    "y": active.top if active else None,
                                    "width": active.width if active else None,
                                    "height": active.height if active else None,
                                },
                            })
                        last_error = f"After process-level fallback activation, foreground window is '{active_title}'"
            else:
                # pygetwindow 找不到窗口 → 尝试进程级 fallback
                # 应用可能隐藏到托盘，pygetwindow 无法枚举 SW_HIDE 的窗口
                if not process_fallback_tried and platform.system() == "Windows":
                    process_fallback_tried = True
                    fallback_activated = _try_process_fallback(title, args.settle)
                    if fallback_activated:
                        # fallback 成功后重新验证前台窗口
                        active = gw.getActiveWindow()
                        active_title = active.title if active else ""
                        matched = active_title == title if args.exact else title.lower() in active_title.lower()
                        if matched:
                            output_success({
                                "action": "ensure_window",
                                "ensured": True,
                                "title": active_title,
                                "method": "process_fallback",
                                "attempts": attempts,
                                "waited_seconds": round(time.time() - start_time, 2),
                                "active_window": {
                                    "title": active_title,
                                    "x": active.left if active else None,
                                    "y": active.top if active else None,
                                    "width": active.width if active else None,
                                    "height": active.height if active else None,
                                },
                            })
                        last_error = f"After process-level fallback activation, foreground window is '{active_title}'"
                    else:
                        last_error = f"No window with a title containing '{title}' was found (process-level fallback also did not succeed)"
                else:
                    last_error = f"No window with a title containing '{title}' was found"
        except Exception as e:
            last_error = str(e)

        if time.time() - start_time >= args.timeout:
            output_error(
                f"Could not ensure window is in the foreground: {last_error} ({attempts} attempts)",
                "ENSURE_WINDOW_FAILED"
            )
        time.sleep(args.interval)


def _try_process_fallback(title_keyword: str, settle: float) -> bool:
    """
    进程级 fallback：通过进程名/窗口标题搜索托盘隐藏的窗口并激活。
    pygetwindow 只能找到可见窗口，此方法通过 EnumWindows 能找到 SW_HIDE 的窗口。
    返回 True 表示成功激活了某个窗口。
    """
    processes = find_processes_by_name(title_keyword)
    if not processes:
        if activate_by_uri_protocol(title_keyword):
            time.sleep(settle)
            return True
        return False

    query_lower = title_keyword.lower()
    all_windows: list[dict[str, Any]] = []
    for proc in processes:
        windows = find_windows_by_pid(proc["pid"])
        for win in windows:
            win["process_name"] = proc["name"]
            all_windows.append(win)

    # 只把可见窗口作为 Win32 首选。隐藏的 Chromium/微信窗口被强行 ShowWindow 后容易白屏。
    visible_matching = [
        w for w in all_windows
        if w.get("visible") and w.get("title", "").strip() and query_lower in w.get("title", "").lower()
    ]
    visible_titled = [
        w for w in all_windows
        if w.get("visible") and w.get("title", "").strip()
    ]
    for win in visible_matching + [w for w in visible_titled if w not in visible_matching]:
        if activate_window_by_hwnd(win["hwnd"]):
            time.sleep(settle)
            return True

    # 新版 Chromium 架构应用（如微信 WeChatAppEx）托盘隐藏时窗口句柄无效。
    # 可见窗口激活失败后，先走应用自身 URI 恢复主窗口，避免激活出白屏壳窗口。
    for proc in processes:
        if activate_by_uri_protocol(proc["name"]):
            time.sleep(settle)
            return True

    if activate_by_uri_protocol(title_keyword):
        time.sleep(settle)
        return True

    # 没有 URI fallback 的普通应用，最后再尝试隐藏/无标题窗口。
    hidden_matching = [
        w for w in all_windows
        if w.get("title", "").strip() and query_lower in w.get("title", "").lower()
    ]
    titled_windows = [w for w in all_windows if w.get("title", "").strip()]
    sized_windows = [
        w for w in all_windows
        if w.get("width", 0) > 10 and w.get("height", 0) > 10
    ]
    for win in hidden_matching + [w for w in titled_windows + sized_windows if w not in hidden_matching]:
        if activate_window_by_hwnd(win["hwnd"]):
            time.sleep(settle)
            return True

    return False



def cmd_paste_and_verify(args: argparse.Namespace) -> None:
    """粘贴剪贴板或指定文本，并用剪贴板/OCR 做基础验证。"""
    pag = check_pyautogui()
    configure_pyautogui(pag)
    pyperclip = check_pyperclip()

    try:
        original_clipboard = None
        try:
            original_clipboard = pyperclip.paste()
        except Exception:
            pass

        text = args.text if args.text is not None else (original_clipboard or "")
        if args.text is not None:
            pyperclip.copy(args.text)
            time.sleep(0.05)

        pag.hotkey("ctrl", "v")
        time.sleep(args.delay)

        clipboard_after = ""
        try:
            clipboard_after = pyperclip.paste()
        except Exception:
            pass

        verify_text = args.verify_text or text
        screen_verified = None
        ocr_count = 0
        popup_detection: dict[str, Any] | None = None
        screenshot_data = None

        if args.ocr_verify and verify_text:
            screen_w, screen_h = pag.size()
            region = parse_region(args.region, screen_w, screen_h, clip_to_bounds=True)
            img = pag.screenshot(region=region)
            output_path = save_observation_image(args, "paste_verify")
            ocr_elements = run_ocr_on_image(img, args.lang or "zh-Hans")
            add_region_offset_to_ocr(ocr_elements, region)
            matches = match_ocr_elements(ocr_elements, verify_text, "contains", False, 0.6)
            screen_verified = bool(matches)
            ocr_count = len(ocr_elements)
            popup_detection = detect_possible_popup(ocr_elements)
            img.save(output_path)
            screenshot_data = {"path": output_path, "width": img.width, "height": img.height, "region": region}

        if args.restore_clipboard and args.text is not None and original_clipboard is not None:
            try:
                pyperclip.copy(original_clipboard)
            except Exception:
                pass

        clipboard_verified = clipboard_after == text if args.text is not None else len(clipboard_after) > 0
        output_success({
            "action": "paste_and_verify",
            "pasted_length": len(text),
            "clipboard_verified": clipboard_verified,
            "screen_verified": screen_verified,
            "cursor_type": get_cursor_type(),
            "ocr_count": ocr_count,
            "screenshot": screenshot_data,
            "popup_detection": popup_detection,
        })
    except Exception as e:
        output_error(f"Paste verification failed: {e}", "PASTE_VERIFY_FAILED")


def locate_image_once(pag: Any, args: argparse.Namespace, region: tuple[int, int, int, int] | None) -> Any:
    """执行一次模板定位，confidence 不可用时降级为精确匹配。"""
    kwargs: dict[str, Any] = {"region": region, "grayscale": args.grayscale}
    if args.confidence is not None:
        kwargs["confidence"] = args.confidence
    try:
        return pag.locateOnScreen(args.template, **kwargs)
    except (TypeError, NotImplementedError):
        kwargs.pop("confidence", None)
        try:
            return pag.locateOnScreen(args.template, **kwargs)
        except Exception:
            return None
    except Exception:
        return None


def cmd_locate_image(args: argparse.Namespace) -> None:
    """图像模板定位，返回中心坐标。"""
    pag = check_pyautogui()
    configure_pyautogui(pag)

    if not os.path.exists(args.template):
        output_error(f"Template image does not exist: {args.template}", "TEMPLATE_NOT_FOUND")

    screen_w, screen_h = pag.size()
    region = parse_region(args.region, screen_w, screen_h, clip_to_bounds=True)
    start_time = time.time()
    attempts = 0
    box = None

    while True:
        attempts += 1
        box = locate_image_once(pag, args, region)
        if box:
            center_x = int(box.left + box.width / 2)
            center_y = int(box.top + box.height / 2)
            output_success({
                "action": "locate_image",
                "found": True,
                "template": args.template,
                "x": center_x,
                "y": center_y,
                "region": region,
                "box": {"left": box.left, "top": box.top, "width": box.width, "height": box.height},
                "attempts": attempts,
                "waited_seconds": round(time.time() - start_time, 2),
            })

        if time.time() - start_time >= args.timeout:
            output_error(f"Template image not found: {args.template}", "IMAGE_NOT_FOUND")
        time.sleep(args.interval)


def cmd_click_image(args: argparse.Namespace) -> None:
    """图像模板定位并点击中心坐标。"""
    pag = check_pyautogui()
    configure_pyautogui(pag)

    if not os.path.exists(args.template):
        output_error(f"Template image does not exist: {args.template}", "TEMPLATE_NOT_FOUND")

    screen_w, screen_h = pag.size()
    region = parse_region(args.region, screen_w, screen_h, clip_to_bounds=True)
    start_time = time.time()
    attempts = 0

    while True:
        attempts += 1
        box = locate_image_once(pag, args, region)
        if box:
            center_x = int(box.left + box.width / 2)
            center_y = int(box.top + box.height / 2)
            validate_coordinates(center_x, center_y, screen_w, screen_h, "click_image")
            if not args.dry_run:
                pag.click(x=center_x, y=center_y, clicks=args.clicks, interval=0.1, button=args.button)
            output_success({
                "action": "click_image",
                "clicked": not args.dry_run,
                "template": args.template,
                "x": center_x,
                "y": center_y,
                "button": args.button,
                "clicks": args.clicks,
                "region": region,
                "box": {"left": box.left, "top": box.top, "width": box.width, "height": box.height},
                "attempts": attempts,
                "waited_seconds": round(time.time() - start_time, 2),
            })

        if time.time() - start_time >= args.timeout:
            output_error(f"Template image not found: {args.template}", "IMAGE_NOT_FOUND")
        time.sleep(args.interval)


def cmd_window(args: argparse.Namespace) -> None:
    """窗口管理"""
    try:
        import pygetwindow as gw
    except ImportError:
        output_error(
            "pygetwindow is not installed. Please run: pip install pygetwindow",
            "DEPENDENCY_MISSING"
        )
        return  # output_error 已 sys.exit，此处为类型安全

    sub = args.window_action

    if sub == "list":
        try:
            if platform.system() == "Windows":
                details = [
                    win for win in list_top_level_windows()
                    if str(win.get("title", "")).strip()
                ]
                titles = [str(win.get("title", "")) for win in details]
            else:
                details = []
                titles = gw.getAllTitles()
                # 过滤空标题
                titles = [t for t in titles if t.strip()]
            output_success({
                "action": "window_list",
                "count": len(titles),
                "windows": titles,
                "window_details": details,
            })
        except Exception as e:
            output_error(f"Failed to get window list: {e}", "WINDOW_LIST_FAILED")

    elif sub == "activate":
        title = args.title
        if not title:
            output_error("activate requires the --title argument", "INVALID_ARGS")

        exact = bool(getattr(args, "exact", False))
        process_filter = getattr(args, "process", None)
        allow_content_title = bool(getattr(args, "allow_content_title", False))
        index = max(0, int(getattr(args, "index", 0)))

        # 带重试的窗口激活（最多 3 次）
        max_retries = 3
        for attempt in range(1, max_retries + 1):
            try:
                if platform.system() == "Windows":
                    candidates, ignored_content_hosts = select_window_title_candidates(
                        title,
                        exact=exact,
                        process_filter=process_filter,
                        allow_content_title=allow_content_title,
                    )
                    if not candidates:
                        if attempt == max_retries:
                            if ignored_content_hosts:
                                output_error(
                                    f"Only content-title host windows matched '{title}'. "
                                    "Use app activate for applications, add --process to filter a known process, "
                                    "or pass --allow-content-title when the page/file title itself is the target.",
                                    "WINDOW_TITLE_HOST_ONLY"
                                )
                            output_error(
                                f"No window with a title containing '{title}' was found",
                                "WINDOW_NOT_FOUND"
                            )
                        time.sleep(0.3)
                        continue

                    if index >= len(candidates):
                        output_error(
                            f"Window index {index} is out of range for {len(candidates)} matching candidates",
                            "WINDOW_INDEX_OUT_OF_RANGE"
                        )

                    target_info = candidates[index]
                    if not activate_window_by_hwnd(int(target_info["hwnd"])):
                        raise RuntimeError(f"failed to activate hwnd {target_info['hwnd']}")

                    time.sleep(0.3)
                    output_success({
                        "action": "window_activate",
                        "title": target_info.get("title", ""),
                        "attempt": attempt,
                        "selected_index": index,
                        "match_count": len(candidates),
                        "ignored_content_host_count": len(ignored_content_hosts),
                        "target_window": target_info,
                        "candidates": candidates[:10],
                    })

                windows = gw.getWindowsWithTitle(title)
                if exact:
                    title_norm = normalize_app_query(title)
                    windows = [win for win in windows if normalize_app_query(win.title) == title_norm]
                if not windows:
                    if attempt == max_retries:
                        output_error(
                            f"No window with a title containing '{title}' was found",
                            "WINDOW_NOT_FOUND"
                        )
                    time.sleep(0.3)
                    continue

                windows.sort(key=lambda win: (-window_title_match_score(win.title, title), len(normalize_app_query(win.title))))
                if index >= len(windows):
                    output_error(
                        f"Window index {index} is out of range for {len(windows)} matching candidates",
                        "WINDOW_INDEX_OUT_OF_RANGE"
                    )

                target = windows[index]
                # Windows 上有时需要先 minimize 再 restore 才能正确激活
                if platform.system() == "Windows":
                    try:
                        if target.isMinimized:
                            target.restore()
                            time.sleep(0.2)
                    except Exception:
                        pass
                target.activate()
                time.sleep(0.3)
                output_success({
                    "action": "window_activate",
                    "title": target.title,
                    "attempt": attempt,
                    "selected_index": index,
                    "match_count": len(windows),
                })
            except Exception as e:
                if attempt == max_retries:
                    output_error(
                        f"Window activation failed (retried {max_retries} times): {e}",
                        "WINDOW_ACTIVATE_FAILED"
                    )
                time.sleep(0.3)

    elif sub == "active":
        try:
            win = gw.getActiveWindow()
            if win:
                output_success({
                    "action": "window_active",
                    "title": win.title,
                    "x": win.left,
                    "y": win.top,
                    "width": win.width,
                    "height": win.height,
                })
            else:
                output_success({
                    "action": "window_active",
                    "title": None,
                })
        except Exception as e:
            output_error(f"Failed to get active window: {e}", "WINDOW_ACTIVE_FAILED")
    else:
        output_error(
            f"Unknown window subcommand: '{sub}'. Options: list, activate, active",
            "INVALID_ARGS"
        )


def cmd_clipboard(args: argparse.Namespace) -> None:
    """剪贴板操作"""
    pyperclip = check_pyperclip()

    sub = args.clipboard_action

    if sub == "get":
        try:
            text = pyperclip.paste()
            output_success({
                "action": "clipboard_get",
                "text": text,
                "length": len(text) if text else 0,
            })
        except Exception as e:
            output_error(f"Failed to read clipboard: {e}", "CLIPBOARD_READ_FAILED")

    elif sub == "set":
        text = args.text
        if text is None:
            output_error("set requires the --text argument", "INVALID_ARGS")
        try:
            pyperclip.copy(text)
            output_success({
                "action": "clipboard_set",
                "length": len(text),
            })
        except Exception as e:
            output_error(f"Failed to write clipboard: {e}", "CLIPBOARD_WRITE_FAILED")
    else:
        output_error(
            f"Unknown clipboard subcommand: '{sub}'. Options: get, set",
            "INVALID_ARGS"
        )


def cmd_wait_window(args: argparse.Namespace) -> None:
    """
    等待指定标题的窗口出现。
    轮询 window list，直到匹配的窗口出现或超时。
    比截屏对比更轻量，适合等待应用启动。
    """
    try:
        import pygetwindow as gw
    except ImportError:
        output_error(
            "pygetwindow is not installed. Please run: pip install pygetwindow",
            "DEPENDENCY_MISSING"
        )
        return

    title = args.title
    if not title:
        output_error("wait_window requires the --title argument", "INVALID_ARGS")

    timeout = args.timeout
    interval = args.interval
    start_time = time.time()
    attempts = 0

    while True:
        attempts += 1
        elapsed = time.time() - start_time

        try:
            windows = gw.getWindowsWithTitle(title)
            if windows:
                target = windows[0]
                output_success({
                    "action": "wait_window",
                    "found": True,
                    "title": target.title,
                    "waited_seconds": round(elapsed, 2),
                    "attempts": attempts,
                })
        except Exception:
            pass

        if elapsed >= timeout:
            output_error(
                f"Timed out waiting for window '{title}' ({timeout} seconds, {attempts} attempts)",
                "WAIT_WINDOW_TIMEOUT"
            )

        time.sleep(interval)


def cmd_wait_stable(args: argparse.Namespace) -> None:
    """
    等待 GUI 界面稳定。
    通过低分辨率 SSIM 对比连续截屏判断界面是否停止变化。
    天然过滤光标闪烁等微小噪声。
    """
    pag = check_pyautogui()
    configure_pyautogui(pag)

    timeout = args.timeout
    interval = args.interval
    threshold = args.threshold
    consecutive_required = max(1, args.consecutive)
    screen_w, screen_h = pag.size()
    region = parse_region(args.region, screen_w, screen_h, clip_to_bounds=True)
    start_time = time.time()
    comparisons = 0
    stable_streak = 0

    # 第一张截屏作为基准
    prev_img = pag.screenshot(region=region)
    time.sleep(interval)

    while True:
        elapsed = time.time() - start_time
        curr_img = pag.screenshot(region=region)
        comparisons += 1

        ssim_score = compute_ssim_simple(prev_img, curr_img)

        if ssim_score >= threshold:
            stable_streak += 1
            if stable_streak >= consecutive_required:
                output_success({
                    "action": "wait_stable",
                    "stable": True,
                    "ssim": round(ssim_score, 4),
                    "waited_seconds": round(elapsed, 2),
                    "comparisons": comparisons,
                    "stable_streak": stable_streak,
                    "consecutive_required": consecutive_required,
                    "region": region,
                })
        else:
            stable_streak = 0

        if elapsed >= timeout:
            output_success({
                "action": "wait_stable",
                "stable": False,
                "ssim": round(ssim_score, 4),
                "waited_seconds": round(elapsed, 2),
                "comparisons": comparisons,
                "stable_streak": stable_streak,
                "consecutive_required": consecutive_required,
                "region": region,
            })

        prev_img = curr_img
        time.sleep(interval)


def cmd_app(args: argparse.Namespace) -> None:
    """应用级查找与激活：基于快捷方式、进程、可见窗口和 URI 组合判断。"""
    sub = args.app_action
    name = getattr(args, "name", None)

    if sub == "list":
        shortcuts = find_app_shortcuts(name, limit=args.limit)
        start_apps = find_start_apps(name, limit=args.limit)
        output_success({
            "action": "app_list",
            "name": name,
            "count": len(shortcuts) + len(start_apps),
            "shortcut_count": len(shortcuts),
            "start_app_count": len(start_apps),
            "shortcuts": shortcuts,
            "start_apps": start_apps,
        })

    if not name:
        output_error(f"{sub} requires the --name argument", "INVALID_ARGS")

    shortcuts = find_app_shortcuts(name, limit=args.limit)
    start_apps = find_start_apps(name, limit=args.limit)
    launchers = find_app_launchers(name, start_apps)
    processes = find_app_processes(name, shortcuts)

    if sub == "check":
        output_success({
            "action": "app_check",
            "name": name,
            "running": len(processes) > 0,
            "process_count": len(processes),
            "shortcut_count": len(shortcuts),
            "start_app_count": len(start_apps),
            "launcher_count": len(launchers),
            "processes": processes,
            "shortcuts": shortcuts,
            "start_apps": start_apps,
            "launchers": launchers,
        })

    if sub != "activate":
        output_error(
            f"Unknown app subcommand: '{sub}'. Options: list, check, activate",
            "INVALID_ARGS"
        )

    start_time = time.time()
    launched = False
    shortcut_launch_attempted = False
    launcher_launch_attempted = False
    best_shortcut = shortcuts[0] if shortcuts else None
    best_launcher = launchers[0] if launchers else None
    active_launcher: dict[str, Any] | None = None
    last_error = ""
    before_active = get_active_window_info()
    before_windows = list_top_level_windows()

    while True:
        extra_queries = launcher_match_queries(active_launcher or best_launcher)
        processes = find_app_processes(name, shortcuts)
        if processes:
            activation = activate_processes(
                name,
                processes,
                args.settle,
                allow_hidden_fallback=args.hidden_fallback,
            )
            if activation:
                activation.update({
                    "action": "app_activate",
                    "name": name,
                    "shortcut": best_shortcut,
                    "launcher": active_launcher or best_launcher,
                    "process_count": len(processes),
                    "waited_seconds": round(time.time() - start_time, 2),
                })
                output_success(activation)
            last_error = f"Found {len(processes)} processes, but no visible window was activated"

        if not best_shortcut and not best_launcher and not launched:
            visible_activation = detect_app_window_after_launch(name, None, before_active, extra_queries, before_windows)
            if visible_activation:
                visible_activation.update({
                    "action": "app_activate",
                    "name": name,
                    "shortcut": None,
                    "launcher": None,
                    "process_count": len(processes),
                    "waited_seconds": round(time.time() - start_time, 2),
                })
                output_success(visible_activation)

        if best_shortcut and not launched and not shortcut_launch_attempted:
            shortcut_launch_attempted = True
            launched = launch_shortcut(best_shortcut)
            if launched:
                last_error = f"Ran shortcut '{best_shortcut['name']}', waiting for the app to restore its window"
                time.sleep(max(args.settle, 1.0))
                shortcut_activation = detect_app_window_after_launch(
                    name,
                    best_shortcut,
                    before_active,
                    extra_queries,
                    before_windows,
                )
                if shortcut_activation:
                    shortcut_activation.update({
                        "action": "app_activate",
                        "name": name,
                        "shortcut": best_shortcut,
                        "launcher": active_launcher or best_launcher,
                        "process_count": len(processes),
                        "waited_seconds": round(time.time() - start_time, 2),
                    })
                    output_success(shortcut_activation)
            else:
                last_error = f"Shortcut launch failed: {best_shortcut['path']}"

        if best_launcher and not launched and not launcher_launch_attempted:
            launcher_launch_attempted = True
            launched = launch_app_launcher(best_launcher)
            if launched:
                active_launcher = best_launcher
                extra_queries = launcher_match_queries(active_launcher)
                last_error = (
                    f"Started {best_launcher['type']} '{best_launcher['name']}', "
                    "waiting for the app to restore its window"
                )
                time.sleep(max(args.settle, 1.0))
                launcher_activation = detect_app_window_after_launch(
                    name,
                    best_shortcut,
                    before_active,
                    extra_queries,
                    before_windows,
                )
                if launcher_activation:
                    launcher_activation.update({
                        "action": "app_activate",
                        "name": name,
                        "shortcut": best_shortcut,
                        "launcher": active_launcher,
                        "process_count": len(processes),
                        "waited_seconds": round(time.time() - start_time, 2),
                    })
                    output_success(launcher_activation)
            else:
                last_error = f"Launcher failed: {best_launcher}"

        if launched:
            extra_queries = launcher_match_queries(active_launcher or best_launcher)
            shortcut_activation = detect_app_window_after_launch(
                name,
                best_shortcut,
                before_active,
                extra_queries,
                before_windows,
            )
            if shortcut_activation:
                shortcut_activation.update({
                    "action": "app_activate",
                    "name": name,
                    "shortcut": best_shortcut,
                    "launcher": active_launcher or best_launcher,
                    "process_count": len(processes),
                    "waited_seconds": round(time.time() - start_time, 2),
                })
                output_success(shortcut_activation)

        if time.time() - start_time >= args.timeout:
            output_error(
                f"Could not activate app '{name}': "
                f"{last_error or 'No running process, matching shortcut, Start App, or execution alias found'}",
                "APP_ACTIVATE_FAILED"
            )

        time.sleep(args.interval)


def cmd_process(args: argparse.Namespace) -> None:
    """进程检测与激活：检查程序是否在运行，激活托盘隐藏的窗口。"""
    sub = args.process_action

    if sub == "check":
        name = args.name
        if not name:
            output_error("check requires the --name argument", "INVALID_ARGS")

        processes = find_processes_by_name(name)
        output_success({
            "action": "process_check",
            "name": name,
            "running": len(processes) > 0,
            "count": len(processes),
            "processes": processes,
        })

    elif sub == "activate":
        name = args.name
        if not name:
            output_error("activate requires the --name argument", "INVALID_ARGS")

        processes = find_processes_by_name(name)
        if not processes:
            output_error(
                f"No process named '{name}' was found; the program may not have been started",
                "PROCESS_NOT_FOUND"
            )

        # 收集所有匹配进程的窗口（已自动过滤 IME 等系统辅助窗口）
        all_windows: list[dict[str, Any]] = []
        for proc in processes:
            windows = find_windows_by_pid(proc["pid"])
            for win in windows:
                win["process_name"] = proc["name"]
                win["pid"] = proc["pid"]
            all_windows.extend(windows)

        # === 激活策略 ===
        activated = False
        activated_window = None
        activation_method = "unknown"

        # 第一层：只优先激活可见窗口。隐藏 Chromium/微信窗口被强行 ShowWindow 后可能白屏。
        visible_titled_windows = [
            w for w in all_windows
            if w.get("visible") and w.get("title", "").strip()
        ]
        for win in visible_titled_windows:
            if activate_window_by_hwnd(win["hwnd"]):
                activated = True
                activated_window = win
                activation_method = "win32_visible_titled"
                break

        # 第二层：可见但无标题的合理尺寸窗口。
        if not activated:
            visible_sized_windows = [
                w for w in all_windows
                if w.get("visible") and w.get("width", 0) > 10 and w.get("height", 0) > 10
            ]
            for win in visible_sized_windows:
                if activate_window_by_hwnd(win["hwnd"]):
                    activated = True
                    activated_window = win
                    activation_method = "win32_visible_sized"
                    break

        # 第三层：URI 协议 fallback。微信隐藏到托盘时，必须让应用自己恢复主窗口。
        if not activated:
            representative_proc_name = processes[0]["name"]
            if activate_by_uri_protocol(name) or activate_by_uri_protocol(representative_proc_name):
                activated = True
                activation_method = "uri_protocol"

        # 第四层：普通应用没有 URI fallback 时，最后再尝试隐藏窗口。
        if not activated:
            titled_windows = [w for w in all_windows if w.get("title", "").strip()]
            sized_windows = [
                w for w in all_windows
                if w.get("width", 0) > 10 and w.get("height", 0) > 10
            ]
            for win in titled_windows + [w for w in sized_windows if w not in titled_windows]:
                if activate_window_by_hwnd(win["hwnd"]):
                    activated = True
                    activated_window = win
                    activation_method = "win32_hidden_or_sized"
                    break

        if not activated:
            output_error(
                f"Process '{name}' is running (PID: {[p['pid'] for p in processes]}), "
                f"but all activation methods failed. Window count: {len(all_windows)}",
                "ACTIVATE_FAILED"
            )

        time.sleep(args.settle)

        # 验证激活结果
        active_window = None
        try:
            import pygetwindow as gw
            active = gw.getActiveWindow()
            if active:
                active_window = {
                    "title": active.title,
                    "x": active.left,
                    "y": active.top,
                    "width": active.width,
                    "height": active.height,
                }
        except (ImportError, Exception):
            pass

        output_success({
            "action": "process_activate",
            "name": name,
            "activated": True,
            "method": activation_method,
            "target_window": {
                "title": activated_window.get("title", "") if activated_window else "",
                "pid": activated_window.get("pid") if activated_window else processes[0]["pid"],
                "was_visible": activated_window.get("visible", False) if activated_window else False,
                "was_minimized": activated_window.get("minimized", False) if activated_window else False,
            },
            "active_window": active_window,
            "all_windows_found": len(all_windows),
        })

    else:
        output_error(
            f"Unknown process subcommand: '{sub}'. Options: check, activate",
            "INVALID_ARGS"
        )


# ==================== CLI 解析 ====================

def build_parser() -> argparse.ArgumentParser:
    """构建 CLI 参数解析器"""
    parser = argparse.ArgumentParser(
        prog="desktop_control",
        description="Desktop automation CLI tool - mouse/keyboard/screenshots/windows/clipboard",
    )
    subparsers = parser.add_subparsers(dest="command", help="Subcommands")

    # --- info ---
    subparsers.add_parser("info", help="Get screen and environment information")

    # --- click ---
    p_click = subparsers.add_parser("click", help="Mouse click")
    p_click.add_argument("x", nargs="?", type=float, default=None, help="X coordinate (omit to click current position; supports OCR-returned 1726.0)")
    p_click.add_argument("y", nargs="?", type=float, default=None, help="Y coordinate")
    p_click.add_argument("--button", choices=["left", "right", "middle"], default="left", help="Button")
    p_click.add_argument("--clicks", type=int, default=1, help="Number of clicks (2=double-click)")
    p_click.add_argument("--verify", default=None, help="Verify active window title before clicking (contains match); returns FOCUS_MISMATCH when not matched")

    # --- click_relative ---
    p_click_rel = subparsers.add_parser("click_relative", help="Click local coordinates based on region")
    p_click_rel.add_argument("x", type=float, help="Local X coordinate inside region")
    p_click_rel.add_argument("y", type=float, help="Local Y coordinate inside region")
    p_click_rel.add_argument("--region", required=True, help="Region that local coordinates belong to: x,y,width,height")
    p_click_rel.add_argument("--button", choices=["left", "right", "middle"], default="left", help="Button")
    p_click_rel.add_argument("--clicks", type=int, default=1, help="Number of clicks")
    p_click_rel.add_argument("--dry-run", action="store_true", help="Only return converted absolute coordinates; do not actually click")

    # --- move ---
    p_move = subparsers.add_parser("move", help="Move mouse")
    p_move.add_argument("x", type=float, help="X coordinate")
    p_move.add_argument("y", type=float, help="Y coordinate")
    p_move.add_argument("--duration", type=float, default=0, help="Movement duration (seconds, 0=instant jump)")
    p_move.add_argument("--smooth", action="store_true", help="Use Bezier curve for smooth movement")

    # --- type ---
    p_type = subparsers.add_parser("type", help="Type text (automatically handles Unicode)")
    p_type.add_argument("text", help="Text to type")
    p_type.add_argument("--wpm", type=int, default=None, help="Typing speed (words per minute, ASCII only)")

    # --- press ---
    p_press = subparsers.add_parser("press", help="Press key")
    p_press.add_argument("key", help="Key name (for example enter, tab, f5, space)")
    p_press.add_argument("--presses", type=int, default=1, help="Number of presses")

    # --- hotkey ---
    p_hotkey = subparsers.add_parser("hotkey", help="Execute hotkey combination")
    p_hotkey.add_argument("keys", nargs="+", help="Key combination (for example ctrl c or alt tab)")

    # --- drag ---
    p_drag = subparsers.add_parser("drag", help="Mouse drag")
    p_drag.add_argument("x1", type=float, help="Start X")
    p_drag.add_argument("y1", type=float, help="Start Y")
    p_drag.add_argument("x2", type=float, help="End X")
    p_drag.add_argument("y2", type=float, help="End Y")
    p_drag.add_argument("--duration", type=float, default=0.5, help="Drag duration (seconds)")
    p_drag.add_argument("--button", choices=["left", "right", "middle"], default="left", help="Button")

    # --- scroll ---
    p_scroll = subparsers.add_parser("scroll", help="Scroll mouse wheel")
    p_scroll.add_argument("amount", type=int, help="Scroll amount (positive=up/left, negative=down/right)")
    p_scroll.add_argument("--direction", choices=["vertical", "horizontal"], default="vertical", help="Direction")
    p_scroll.add_argument("--x", type=float, default=None, help="Scroll position X")
    p_scroll.add_argument("--y", type=float, default=None, help="Scroll position Y")

    # --- screenshot ---
    p_ss = subparsers.add_parser("screenshot", help="Capture screen (can include OCR)")
    p_ss.add_argument("--region", default=None, help="Capture region: x,y,width,height")
    p_ss.add_argument("--output", "-o", default=None, help="Output file path (default temp directory)")
    p_ss.add_argument("--ocr", action="store_true", help="Enable OCR text recognition (Windows native OCR)")
    p_ss.add_argument("--profile", choices=["vision", "ocr", "hybrid"], default="vision", help="Observation strategy: vision=screenshot only for multimodal viewing, ocr=force OCR, hybrid=screenshot+OCR")
    p_ss.add_argument("--lang", default=None, help="OCR language (default zh-Hans; optional en-US, ja-JP, etc.)")
    p_ss.add_argument("--filter", default=None, help="OCR result filter keywords (comma-separated, for example 'Play,Pause')")
    p_ss.add_argument("--mark", action="store_true", help="Mark OCR-recognized element positions on the screenshot with red boxes and numbers (failsafe visual aid)")
    p_ss.add_argument("--mark-level", choices=["smart", "line", "word", "phrase", "all"], default="smart", help="OCR annotation granularity; smart avoids misleading full boxes around long lines")
    p_ss.add_argument("--grid", type=int, default=None, help="Draw coordinate grid on screenshot; labels auto-rotate/skip when dense; value is a pixel interval no smaller than 20")
    p_ss.add_argument("--grid-label-size", type=int, default=None, help="Grid coordinate label font size (10-96); default adapts to screenshot size, about 32 for 4K full screen")
    p_ss.add_argument("--ocr-detail", choices=["line", "line_word", "full"], default=None, help="OCR JSON output granularity: default line; default full when --filter is used")

    # --- observe ---
    p_obs = subparsers.add_parser("observe", help="Get screen information + screenshot + optional OCR")
    p_obs.add_argument("--region", default=None, help="Capture region: x,y,width,height")
    p_obs.add_argument("--output", "-o", default=None, help="Output file path (default temp directory)")
    p_obs.add_argument("--ocr", action="store_true", help="Enable OCR text recognition (Windows native OCR)")
    p_obs.add_argument("--profile", choices=["vision", "ocr", "hybrid"], default="vision", help="Observation strategy: vision=screenshot only for multimodal viewing, ocr=force OCR, hybrid=screenshot+OCR")
    p_obs.add_argument("--lang", default=None, help="OCR language (default zh-Hans; optional en-US, ja-JP, etc.)")
    p_obs.add_argument("--filter", default=None, help="OCR result filter keywords (comma-separated, for example 'Play,Pause')")
    p_obs.add_argument("--mark", action="store_true", help="Mark OCR-recognized element positions on the screenshot with red boxes and numbers")
    p_obs.add_argument("--mark-level", choices=["smart", "line", "word", "phrase", "all"], default="smart", help="OCR annotation granularity; smart avoids misleading full boxes around long lines")
    p_obs.add_argument("--grid", type=int, default=None, help="Draw coordinate grid on screenshot; labels auto-rotate/skip when dense; value is a pixel interval no smaller than 20")
    p_obs.add_argument("--grid-label-size", type=int, default=None, help="Grid coordinate label font size (10-96); default adapts to screenshot size, about 32 for 4K full screen")
    p_obs.add_argument("--ocr-detail", choices=["line", "line_word", "full"], default=None, help="OCR JSON output granularity: default line; default full when --filter is used")

    # --- find_text ---
    p_find = subparsers.add_parser("find_text", help="Find text with OCR and return candidate coordinates")
    p_find.add_argument("text", help="Text to find")
    p_find.add_argument("--match", choices=["contains", "exact", "regex", "fuzzy"], default="contains", help="Match mode")
    p_find.add_argument("--case-sensitive", action="store_true", help="Case-sensitive")
    p_find.add_argument("--min-score", type=float, default=0.6, help="Minimum fuzzy match score")
    p_find.add_argument("--index", type=int, default=0, help="Select which matching candidate")
    p_find.add_argument("--limit", type=int, default=10, help="Maximum number of candidates to return")
    p_find.add_argument("--region", default=None, help="Search region: x,y,width,height")
    p_find.add_argument("--output", "-o", default=None, help="Save screenshot path")
    p_find.add_argument("--lang", default=None, help="OCR language")
    p_find.add_argument("--mark", action="store_true", help="Annotate OCR elements on the screenshot")
    p_find.add_argument("--mark-level", choices=["smart", "line", "word", "phrase", "all"], default="smart", help="OCR annotation granularity")

    # --- click_text ---
    p_ct = subparsers.add_parser("click_text", help="Find text with OCR and click it")
    p_ct.add_argument("text", help="Text to click")
    p_ct.add_argument("--match", choices=["contains", "exact", "regex", "fuzzy"], default="contains", help="Match mode")
    p_ct.add_argument("--case-sensitive", action="store_true", help="Case-sensitive")
    p_ct.add_argument("--min-score", type=float, default=0.6, help="Minimum fuzzy match score")
    p_ct.add_argument("--index", type=int, default=0, help="Click which matching candidate")
    p_ct.add_argument("--region", default=None, help="Search region: x,y,width,height")
    p_ct.add_argument("--output", "-o", default=None, help="Save screenshot path")
    p_ct.add_argument("--lang", default=None, help="OCR language")
    p_ct.add_argument("--mark", action="store_true", help="Annotate OCR elements on the screenshot")
    p_ct.add_argument("--mark-level", choices=["smart", "line", "word", "phrase", "all"], default="smart", help="OCR annotation granularity")
    p_ct.add_argument("--anchor", choices=["center", "left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"], default="center", help="Which direction from the OCR text box to compute the click point")
    p_ct.add_argument("--offset", nargs=2, type=float, metavar=("DX", "DY"), default=None, help="Relative pixel offset based on anchor, for example --offset -220 -45")
    p_ct.add_argument("--button", choices=["left", "right", "middle"], default="left", help="Button")
    p_ct.add_argument("--clicks", type=int, default=1, help="Number of clicks")
    p_ct.add_argument("--verify", default=None, help="Verify active window title before clicking")
    p_ct.add_argument("--dry-run", action="store_true", help="Only return the position that would be clicked; do not actually click")
    p_ct.add_argument("--stop-on-popup", action="store_true", help="Refuse to click when a possible popup is detected")

    # --- ensure_window ---
    p_ensure = subparsers.add_parser("ensure_window", help="Activate window and verify foreground")
    p_ensure.add_argument("--title", required=True, help="Window title keyword")
    p_ensure.add_argument("--timeout", type=float, default=8, help="Timeout")
    p_ensure.add_argument("--interval", type=float, default=0.5, help="Retry interval")
    p_ensure.add_argument("--settle", type=float, default=0.3, help="Wait time after activation")
    p_ensure.add_argument("--exact", action="store_true", help="Title must match exactly")

    # --- paste_and_verify ---
    p_paste = subparsers.add_parser("paste_and_verify", help="Paste clipboard or specified text and do basic verification")
    p_paste.add_argument("--text", default=None, help="Text to write to clipboard before pasting; omit to paste current clipboard")
    p_paste.add_argument("--verify-text", default=None, help="Text used for OCR verification; omit to use --text or current clipboard")
    p_paste.add_argument("--delay", type=float, default=0.2, help="Wait time after paste")
    p_paste.add_argument("--ocr-verify", action="store_true", help="After pasting, screenshot and OCR verify whether text is visible")
    p_paste.add_argument("--region", default=None, help="OCR verification region: x,y,width,height")
    p_paste.add_argument("--output", "-o", default=None, help="OCR verification screenshot path")
    p_paste.add_argument("--lang", default=None, help="OCR language")
    p_paste.add_argument("--restore-clipboard", action="store_true", help="Restore original clipboard after pasting (only in --text mode)")

    # --- locate_image ---
    p_li = subparsers.add_parser("locate_image", help="Image template localization")
    p_li.add_argument("template", help="Template image path")
    p_li.add_argument("--region", default=None, help="Localization region: x,y,width,height")
    p_li.add_argument("--confidence", type=float, default=0.85, help="Match confidence; automatically falls back to exact matching when OpenCV is unavailable")
    p_li.add_argument("--grayscale", action="store_true", help="Grayscale matching")
    p_li.add_argument("--timeout", type=float, default=3, help="Timeout")
    p_li.add_argument("--interval", type=float, default=0.3, help="Retry interval")

    # --- click_image ---
    p_ci = subparsers.add_parser("click_image", help="Locate image template and click")
    p_ci.add_argument("template", help="Template image path")
    p_ci.add_argument("--region", default=None, help="Localization region: x,y,width,height")
    p_ci.add_argument("--confidence", type=float, default=0.85, help="Match confidence; automatically falls back to exact matching when OpenCV is unavailable")
    p_ci.add_argument("--grayscale", action="store_true", help="Grayscale matching")
    p_ci.add_argument("--timeout", type=float, default=3, help="Timeout")
    p_ci.add_argument("--interval", type=float, default=0.3, help="Retry interval")
    p_ci.add_argument("--button", choices=["left", "right", "middle"], default="left", help="Button")
    p_ci.add_argument("--clicks", type=int, default=1, help="Number of clicks")
    p_ci.add_argument("--dry-run", action="store_true", help="Only return the position that would be clicked; do not actually click")

    # --- app ---
    p_app = subparsers.add_parser("app", help="Application-level find and activate (shortcut/process/window/URI combined judgment)")
    p_app.add_argument("app_action", choices=["list", "check", "activate"], help="Operation type: list=list shortcuts, check=check app, activate=activate app")
    p_app.add_argument("--name", default=None, help="Application display name or keyword (for example WeChat, Visual Studio Code, OBS Studio)")
    p_app.add_argument("--timeout", type=float, default=8, help="activate timeout (seconds)")
    p_app.add_argument("--interval", type=float, default=0.5, help="activate retry interval (seconds)")
    p_app.add_argument("--settle", type=float, default=0.5, help="Wait time after activation/startup (seconds)")
    p_app.add_argument("--limit", type=int, default=20, help="Maximum number of shortcuts returned by list/check")
    p_app.add_argument("--hidden-fallback", action="store_true", help="Allow final forced activation of hidden hwnd (may cause blank screens in Chromium/WeChat-like apps)")

    # --- process ---
    p_proc = subparsers.add_parser("process", help="Process detection and activation (can wake tray-hidden windows)")
    p_proc.add_argument("process_action", choices=["check", "activate"], help="Operation type: check=check process, activate=activate window")
    p_proc.add_argument("--name", required=True, help="Process-name keyword (for example WeChat.exe, chrome.exe), case-insensitive")
    p_proc.add_argument("--settle", type=float, default=0.3, help="Wait time after activate (seconds)")

    # --- window ---
    p_win = subparsers.add_parser("window", help="Window management")
    p_win.add_argument("window_action", choices=["list", "activate", "active"], help="Operation type")
    p_win.add_argument("--title", default=None, help="Window title keyword (used for activate)")
    p_win.add_argument("--exact", action="store_true", help="Title must match exactly")
    p_win.add_argument("--index", type=int, default=0, help="Activate which matching candidate after sorting")
    p_win.add_argument("--process", default=None, help="Filter by process name or exe path, for example cloudmusic.exe")
    p_win.add_argument("--allow-content-title", action="store_true", help="Allow browser/editor/document page or file-title matches")

    # --- clipboard ---
    p_clip = subparsers.add_parser("clipboard", help="Clipboard operations")
    p_clip.add_argument("clipboard_action", choices=["get", "set"], help="Operation type")
    p_clip.add_argument("--text", default=None, help="Text to write to clipboard (used for set)")

    # --- wait_window ---
    p_ww = subparsers.add_parser("wait_window", help="Wait for specified window to appear")
    p_ww.add_argument("--title", required=True, help="Window title keyword to wait for")
    p_ww.add_argument("--timeout", type=float, default=15, help="Timeout (seconds, default 15)")
    p_ww.add_argument("--interval", type=float, default=0.5, help="Polling interval (seconds, default 0.5)")

    # --- wait_stable ---
    p_ws = subparsers.add_parser("wait_stable", help="Wait for GUI interface to stabilize")
    p_ws.add_argument("--timeout", type=float, default=10, help="Timeout (seconds, default 10)")
    p_ws.add_argument("--interval", type=float, default=1.0, help="Screenshot interval (seconds, default 1.0)")
    p_ws.add_argument("--threshold", type=float, default=0.98, help="SSIM stability threshold (default 0.98)")
    p_ws.add_argument("--consecutive", type=int, default=2, help="Consecutive stable frame requirement (default 2; use 1 for lightweight apps, 2-3 for complex animations)")
    p_ws.add_argument("--region", default=None, help="Only wait for specified region to stabilize: x,y,width,height")

    return parser


# ==================== 命令路由 ====================

COMMAND_MAP = {
    "info": cmd_info,
    "click": cmd_click,
    "click_relative": cmd_click_relative,
    "move": cmd_move,
    "type": cmd_type,
    "press": cmd_press,
    "hotkey": cmd_hotkey,
    "drag": cmd_drag,
    "scroll": cmd_scroll,
    "screenshot": cmd_screenshot,
    "observe": cmd_observe,
    "find_text": cmd_find_text,
    "click_text": cmd_click_text,
    "ensure_window": cmd_ensure_window,
    "paste_and_verify": cmd_paste_and_verify,
    "locate_image": cmd_locate_image,
    "click_image": cmd_click_image,
    "app": cmd_app,
    "window": cmd_window,
    "clipboard": cmd_clipboard,
    "wait_window": cmd_wait_window,
    "wait_stable": cmd_wait_stable,
    "process": cmd_process,
}


def main() -> None:
    """CLI 入口"""
    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        output_error("Please specify a subcommand", "NO_COMMAND")

    handler = COMMAND_MAP.get(args.command)
    if handler:
        handler(args)
    else:
        output_error(f"Unknown command: {args.command}", "UNKNOWN_COMMAND")


if __name__ == "__main__":
    main()
