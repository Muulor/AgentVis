//! 桌面交互能力检测与 detached launch 推断。

use super::network::{
    agent_browser_runtime_script_hint, command_token_name, extract_first_script_path,
    resolve_script_candidates, split_command_tokens,
};

const DESKTOP_COMMAND_SUBSTRINGS: &[&str] =
    &["app activate", " hotkey ", " sendkeys ", " sendinput "];

const DESKTOP_COMMAND_NAMES: &[&str] = &[
    "agent-browser",
    "agent-browser.cmd",
    "agent-browser.bat",
    "agent-browser.ps1",
    "start-chrome-debug.bat",
    "browser-command.bat",
    "desktop-control",
    "desktop-control.cmd",
    "desktop-control.bat",
    "desktop_control.py",
];

const DESKTOP_SCRIPT_PATTERNS: &[&str] = &[
    "import pyautogui",
    "from pyautogui import",
    "import pywinauto",
    "from pywinauto import",
    "import pynput",
    "from pynput import",
    "import keyboard",
    "import mouse",
    "import win32gui",
    "import win32api",
    "import win32con",
    "from win32gui import",
    "from win32api import",
    "from win32con import",
    "ctypes.windll.user32",
    "sendinput",
    "setforegroundwindow",
    "keybd_event",
    "mouse_event",
    "showwindow",
    "getforegroundwindow",
    "screenshot(",
    "imagegrab.grab",
    "mss.mss",
];

pub(crate) fn detect_desktop_interaction(command: &str, workdir: Option<&str>) -> Option<String> {
    let lower = command.to_lowercase();
    if let Some(pattern) = desktop_entrypoint_signal(command) {
        return Some(pattern);
    }

    if let Some(pattern) = DESKTOP_COMMAND_SUBSTRINGS
        .iter()
        .find(|pattern| lower.contains(**pattern))
    {
        return Some((*pattern).to_string());
    }

    let Some(script_path) = extract_first_script_path(command) else {
        return None;
    };

    let script_path_lower = script_path.replace('\\', "/").to_lowercase();
    if script_path_lower.contains("desktop-control")
        || script_path_lower.ends_with("desktop_control.py")
    {
        return Some(script_path);
    }

    let candidates = resolve_script_candidates(&script_path, workdir);
    for candidate in &candidates {
        let Ok(content) = std::fs::read_to_string(candidate) else {
            continue;
        };
        let lower = content.to_lowercase();
        if let Some(pattern) = DESKTOP_SCRIPT_PATTERNS
            .iter()
            .find(|pattern| lower.contains(**pattern))
        {
            return Some(format!("{}:{}", pattern, candidate.display()));
        }
        return None;
    }

    None
}

fn desktop_entrypoint_signal(command: &str) -> Option<String> {
    if let Some((script_name, _)) = agent_browser_runtime_script_hint(command) {
        return Some(script_name);
    }

    split_command_tokens(command).into_iter().find_map(|token| {
        let name = command_token_name(&token);
        if matches!(
            name.as_str(),
            "desktop-control" | "desktop-control.cmd" | "desktop-control.bat" | "desktop_control.py"
        ) {
            return Some("desktop-control".to_string());
        }
        if matches!(
            name.as_str(),
            "agent-browser" | "agent-browser.cmd" | "agent-browser.bat" | "agent-browser.ps1"
        ) {
            return Some("agent-browser".to_string());
        }
        DESKTOP_COMMAND_NAMES
            .iter()
            .any(|candidate| name == *candidate)
            .then_some(name)
    })
}

pub(crate) fn looks_like_detached_launch_command(command: &str) -> bool {
    let lower = command.trim().to_ascii_lowercase();
    if lower.starts_with("start ")
        || lower.starts_with("start\t")
        || lower.starts_with("cmd /c start ")
        || lower.starts_with("cmd.exe /c start ")
        || lower.contains(" start-process ")
        || lower.contains("start-process ")
    {
        return true;
    }
    if desktop_entrypoint_signal(command).is_some() {
        return true;
    }

    split_command_tokens(command).into_iter().any(|token| {
        matches!(
            command_token_name(&token).as_str(),
            "explorer"
                | "chrome"
                | "msedge"
                | "firefox"
                | "brave"
                | "opera"
                | "code"
                | "devenv"
                | "notepad"
                | "wordpad"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_script_path(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("agentvis_desktop_scan_{}_{}.py", name, nonce))
    }

    #[test]
    fn detects_known_desktop_control_command() {
        let command =
            r#"python "C:/skills/desktop-control/scripts/desktop_control.py" hotkey win d"#;

        assert_eq!(
            detect_desktop_interaction(command, None).as_deref(),
            Some("desktop-control")
        );
        assert!(looks_like_detached_launch_command(command));
    }

    #[test]
    fn detects_desktop_script_api_usage() {
        let script = temp_script_path("pyautogui");
        fs::write(&script, "import pyautogui\npyautogui.hotkey('win', 'd')\n").unwrap();

        let signal = detect_desktop_interaction(&format!("python {}", script.display()), None)
            .expect("desktop API should be detected");

        fs::remove_file(&script).unwrap();
        assert!(signal.contains("import pyautogui"));
    }

    #[test]
    fn detached_launch_detection_covers_common_gui_entrypoints() {
        assert!(looks_like_detached_launch_command(
            "cmd /c start chrome https://example.com"
        ));
        assert!(looks_like_detached_launch_command("code ."));
        assert!(looks_like_detached_launch_command(
            r#"cmd /c "C:\Users\me\AppData\Roaming\com.agentvis.app\skills\external\packages\agent-browser\scripts\browser-command.bat" screenshot"#
        ));
        assert!(!looks_like_detached_launch_command("cargo test"));
    }

    #[test]
    fn malformed_agent_browser_cmd_quotes_still_infer_detached_launch() {
        assert!(looks_like_detached_launch_command(
            r##"cmd /c ""%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" "https://example.com"""##
        ));
        assert!(looks_like_detached_launch_command(
            r##"cmd /c ""%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" https://example.com""##
        ));
        assert!(looks_like_detached_launch_command(
            r##"cmd /c ""C:\AgentVis\src-tauri\skills-bundle\agent-browser\scripts\browser-command.bat" screenshot""##
        ));
    }

    #[test]
    fn malformed_agent_browser_fallback_stays_narrow() {
        assert!(!looks_like_detached_launch_command(
            r##"cmd /c ""C:\tmp\start-chrome-debug.bat" https://example.com""##
        ));
        assert!(!looks_like_detached_launch_command(
            r##"cmd /c ""%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" https://example.com" && echo done"##
        ));
        assert!(!looks_like_detached_launch_command(
            r##"cmd /c echo ""%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" status""##
        ));
    }

    #[test]
    fn agent_browser_temp_paths_are_not_desktop_entrypoints() {
        let command = r#"del /f /q "C:\Users\me\.agent-browser\tmp\screenshots\screenshot-1.png""#;

        assert_eq!(detect_desktop_interaction(command, None), None);
        assert!(!looks_like_detached_launch_command(command));
    }
}
