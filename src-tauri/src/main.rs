//! AgentVis 主入口
//!
//! Tauri 应用程序的入口点，负责初始化应用和注册命令。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(debug_assertions)]
const DEV_SERVER_ADDRESS: std::net::SocketAddr = std::net::SocketAddr::V4(
    std::net::SocketAddrV4::new(std::net::Ipv4Addr::LOCALHOST, 1420),
);

#[cfg(debug_assertions)]
fn wait_for_dev_server() -> bool {
    wait_for_server(&DEV_SERVER_ADDRESS, std::time::Duration::from_secs(2))
}

#[cfg(debug_assertions)]
fn wait_for_server(address: &std::net::SocketAddr, timeout: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;

    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return false;
        }

        let attempt_timeout = remaining.min(std::time::Duration::from_millis(200));
        if std::net::TcpStream::connect_timeout(address, attempt_timeout).is_ok() {
            return true;
        }

        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        std::thread::sleep(remaining.min(std::time::Duration::from_millis(100)));
    }
}

#[cfg(all(debug_assertions, windows))]
fn report_missing_dev_server() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

    let message: Vec<u16> = "AgentVis 调试版无法连接开发服务器 (127.0.0.1:1420)。\n\n这是 debug build，请不要直接启动 target/debug/agentvis.exe。\n请在项目目录运行：npm run tauri dev\n\nAgentVis debug build could not reach the development server (127.0.0.1:1420).\nStart it with: npm run tauri dev\0"
        .encode_utf16()
        .collect();
    let title: Vec<u16> = "AgentVis Debug / 调试版\0".encode_utf16().collect();

    // SAFETY: Both UTF-16 buffers are NUL-terminated and remain alive for the duration
    // of this synchronous Win32 call. A null owner is intentional for startup failure.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(all(debug_assertions, not(windows)))]
fn report_missing_dev_server() {
    eprintln!(
        "AgentVis 调试版无法连接开发服务器 (127.0.0.1:1420)。这是 debug build，请在项目目录运行 `npm run tauri dev`。\n\
         AgentVis debug build could not reach the development server (127.0.0.1:1420). Start it with `npm run tauri dev`."
    );
}

fn main() {
    #[cfg(debug_assertions)]
    if !wait_for_dev_server() {
        report_missing_dev_server();
        return;
    }

    agentvis_lib::run()
}

#[cfg(all(test, debug_assertions))]
mod tests {
    #[test]
    fn detects_a_reachable_local_dev_server() {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .expect("test listener should bind");
        let address = listener
            .local_addr()
            .expect("test listener should have a local address");

        assert!(super::wait_for_server(
            &address,
            std::time::Duration::from_millis(100),
        ));
    }

    #[test]
    fn rejects_a_released_local_dev_server_port() {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .expect("test listener should bind");
        let address = listener
            .local_addr()
            .expect("test listener should have a local address");
        drop(listener);

        assert!(!super::wait_for_server(
            &address,
            std::time::Duration::from_millis(50),
        ));
    }
}
