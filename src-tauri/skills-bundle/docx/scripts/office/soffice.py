"""
Helper for running LibreOffice (soffice) across all platforms.

Supports Windows, macOS, and Linux:
- Windows: 直接定位 LibreOffice 安装路径（无需 AF_UNIX shim）
- macOS/Linux: 检测 AF_UNIX socket 限制并在需要时应用 LD_PRELOAD shim

Usage:
    from office.soffice import run_soffice, get_soffice_env, find_soffice_path

    # Option 1 – run soffice directly
    result = run_soffice(["--headless", "--convert-to", "pdf", "input.docx"])

    # Option 2 – get env dict for your own subprocess calls
    env = get_soffice_env()
    subprocess.run([find_soffice_path(), ...], env=env)
"""

import os
import platform
import subprocess
import tempfile
from pathlib import Path


def find_soffice_path() -> str:
    """
    查找 LibreOffice soffice 可执行文件路径

    搜索策略按平台区分：
    - Windows: 搜索 Program Files 下的常见安装路径
    - macOS: 检查 /Applications 下的 .app 包
    - Linux/其他: 使用 PATH 中的 'soffice'

    Returns:
        soffice 可执行文件的完整路径（Windows/macOS）或命令名（Linux）
    """
    system = platform.system()

    if system == "Windows":
        # Windows 上 LibreOffice 通常不在 PATH 中，需要搜索常见安装目录
        search_roots = [
            os.environ.get("PROGRAMFILES", r"C:\Program Files"),
            os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"),
        ]

        for root in search_roots:
            if not root:
                continue
            # 搜索 LibreOffice 安装目录（支持版本号变化）
            libre_dir = Path(root) / "LibreOffice"
            if libre_dir.exists():
                soffice_exe = libre_dir / "program" / "soffice.exe"
                if soffice_exe.exists():
                    return str(soffice_exe)

            # 搜索带版本号的目录（如 LibreOffice 24.8）
            for entry in Path(root).iterdir():
                if entry.is_dir() and entry.name.lower().startswith("libreoffice"):
                    soffice_exe = entry / "program" / "soffice.exe"
                    if soffice_exe.exists():
                        return str(soffice_exe)

        # 最后尝试 PATH（用户可能手动添加过）
        return "soffice"

    elif system == "Darwin":
        # macOS 上检查 .app 包
        app_path = "/Applications/LibreOffice.app/Contents/MacOS/soffice"
        if os.path.exists(app_path):
            return app_path
        return "soffice"

    else:
        # Linux 通常在 PATH 中
        return "soffice"


def get_soffice_env() -> dict:
    """
    获取运行 soffice 所需的环境变量

    Windows 上无需特殊处理（不存在 AF_UNIX socket 限制）。
    Linux/macOS 上检测 AF_UNIX 限制并在需要时应用 LD_PRELOAD shim。
    """
    env = os.environ.copy()

    system = platform.system()

    if system == "Windows":
        # Windows 不使用 VCL plugin 和 LD_PRELOAD，直接返回基础环境
        return env

    # macOS/Linux: 使用无头模式的 VCL 插件
    env["SAL_USE_VCLPLUGIN"] = "svp"

    if _needs_shim():
        shim = _ensure_shim()
        env["LD_PRELOAD"] = str(shim)

    return env


def run_soffice(args: list[str], **kwargs) -> subprocess.CompletedProcess:
    """运行 soffice 命令，自动处理环境变量和可执行文件路径"""
    env = get_soffice_env()
    soffice = find_soffice_path()
    return subprocess.run([soffice] + args, env=env, **kwargs)


# ==================== Linux/macOS AF_UNIX Shim ====================

_SHIM_SO = Path(tempfile.gettempdir()) / "lo_socket_shim.so"


def _needs_shim() -> bool:
    """检测是否需要 AF_UNIX socket shim（仅 Linux/macOS 沙盒环境）"""
    if platform.system() == "Windows":
        return False

    try:
        import socket
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.close()
        return False
    except (OSError, AttributeError):
        # AttributeError: Windows 上 socket 模块没有 AF_UNIX
        return True


def _ensure_shim() -> Path:
    """编译 LD_PRELOAD shim（仅 Linux/macOS）"""
    if _SHIM_SO.exists():
        return _SHIM_SO

    src = Path(tempfile.gettempdir()) / "lo_socket_shim.c"
    src.write_text(_SHIM_SOURCE)
    subprocess.run(
        ["gcc", "-shared", "-fPIC", "-o", str(_SHIM_SO), str(src), "-ldl"],
        check=True,
        capture_output=True,
    )
    src.unlink()
    return _SHIM_SO



_SHIM_SOURCE = r"""
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

static int (*real_socket)(int, int, int);
static int (*real_socketpair)(int, int, int, int[2]);
static int (*real_listen)(int, int);
static int (*real_accept)(int, struct sockaddr *, socklen_t *);
static int (*real_close)(int);
static int (*real_read)(int, void *, size_t);

/* Per-FD bookkeeping (FDs >= 1024 are passed through unshimmed). */
static int is_shimmed[1024];
static int peer_of[1024];
static int wake_r[1024];            /* accept() blocks reading this */
static int wake_w[1024];            /* close()  writes to this      */
static int listener_fd = -1;        /* FD that received listen()    */

__attribute__((constructor))
static void init(void) {
    real_socket     = dlsym(RTLD_NEXT, "socket");
    real_socketpair = dlsym(RTLD_NEXT, "socketpair");
    real_listen     = dlsym(RTLD_NEXT, "listen");
    real_accept     = dlsym(RTLD_NEXT, "accept");
    real_close      = dlsym(RTLD_NEXT, "close");
    real_read       = dlsym(RTLD_NEXT, "read");
    for (int i = 0; i < 1024; i++) {
        peer_of[i] = -1;
        wake_r[i]  = -1;
        wake_w[i]  = -1;
    }
}

/* ---- socket ---------------------------------------------------------- */
int socket(int domain, int type, int protocol) {
    if (domain == AF_UNIX) {
        int fd = real_socket(domain, type, protocol);
        if (fd >= 0) return fd;
        /* socket(AF_UNIX) blocked – fall back to socketpair(). */
        int sv[2];
        if (real_socketpair(domain, type, protocol, sv) == 0) {
            if (sv[0] >= 0 && sv[0] < 1024) {
                is_shimmed[sv[0]] = 1;
                peer_of[sv[0]]    = sv[1];
                int wp[2];
                if (pipe(wp) == 0) {
                    wake_r[sv[0]] = wp[0];
                    wake_w[sv[0]] = wp[1];
                }
            }
            return sv[0];
        }
        errno = EPERM;
        return -1;
    }
    return real_socket(domain, type, protocol);
}

/* ---- listen ---------------------------------------------------------- */
int listen(int sockfd, int backlog) {
    if (sockfd >= 0 && sockfd < 1024 && is_shimmed[sockfd]) {
        listener_fd = sockfd;
        return 0;
    }
    return real_listen(sockfd, backlog);
}

/* ---- accept ---------------------------------------------------------- */
int accept(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
    if (sockfd >= 0 && sockfd < 1024 && is_shimmed[sockfd]) {
        /* Block until close() writes to the wake pipe. */
        if (wake_r[sockfd] >= 0) {
            char buf;
            real_read(wake_r[sockfd], &buf, 1);
        }
        errno = ECONNABORTED;
        return -1;
    }
    return real_accept(sockfd, addr, addrlen);
}

/* ---- close ----------------------------------------------------------- */
int close(int fd) {
    if (fd >= 0 && fd < 1024 && is_shimmed[fd]) {
        int was_listener = (fd == listener_fd);
        is_shimmed[fd] = 0;

        if (wake_w[fd] >= 0) {              /* unblock accept() */
            char c = 0;
            write(wake_w[fd], &c, 1);
            real_close(wake_w[fd]);
            wake_w[fd] = -1;
        }
        if (wake_r[fd] >= 0) { real_close(wake_r[fd]); wake_r[fd]  = -1; }
        if (peer_of[fd] >= 0) { real_close(peer_of[fd]); peer_of[fd] = -1; }

        if (was_listener)
            _exit(0);                        /* conversion done – exit */
    }
    return real_close(fd);
}
"""



if __name__ == "__main__":
    import sys
    result = run_soffice(sys.argv[1:])
    sys.exit(result.returncode)
