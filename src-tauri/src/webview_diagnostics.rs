//! Windows WebView2 进程级诊断。
//!
//! WebView2 renderer 崩溃通常不会稳定落到 Windows Application/WER 日志。
//! 这里直接监听 CoreWebView2.ProcessFailed，把 kind/reason/exit code 等
//! 原始现场写入 AgentVis 日志，便于定位长任务期间的 native renderer failure。

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2NavigationStartingEventArgs, ICoreWebView2NewWindowRequestedEventArgs,
    ICoreWebView2ProcessFailedEventArgs2, ICoreWebView2ProcessFailedEventArgs3,
    COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
    COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED, COREWEBVIEW2_PROCESS_FAILED_REASON,
    COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED, COREWEBVIEW2_PROCESS_FAILED_REASON_LAUNCH_FAILED,
    COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY,
    COREWEBVIEW2_PROCESS_FAILED_REASON_PROFILE_DELETED,
    COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED, COREWEBVIEW2_PROCESS_FAILED_REASON_UNEXPECTED,
    COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE,
};
use webview2_com::{
    take_pwstr, NavigationStartingEventHandler, NewWindowRequestedEventHandler,
    ProcessFailedEventHandler,
};
use windows::core::{Interface, PWSTR};
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

fn process_failed_kind_label(kind: COREWEBVIEW2_PROCESS_FAILED_KIND) -> &'static str {
    match kind {
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => "browser_process_exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => "render_process_exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => {
            "render_process_unresponsive"
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED => {
            "frame_render_process_exited"
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED => "utility_process_exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED => {
            "sandbox_helper_process_exited"
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED => "gpu_process_exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED => {
            "ppapi_plugin_process_exited"
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED => {
            "ppapi_broker_process_exited"
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED => "unknown_process_exited",
        _ => "unknown_kind",
    }
}

fn process_failed_reason_label(reason: COREWEBVIEW2_PROCESS_FAILED_REASON) -> &'static str {
    match reason {
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNEXPECTED => "unexpected",
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE => "unresponsive",
        COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED => "terminated",
        COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED => "crashed",
        COREWEBVIEW2_PROCESS_FAILED_REASON_LAUNCH_FAILED => "launch_failed",
        COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY => "out_of_memory",
        COREWEBVIEW2_PROCESS_FAILED_REASON_PROFILE_DELETED => "profile_deleted",
        _ => "unknown_reason",
    }
}

fn is_http_url(uri: &str) -> bool {
    let normalized = uri.trim_start().to_ascii_lowercase();
    normalized.starts_with("http://") || normalized.starts_with("https://")
}

fn origin_match_with_boundary(uri: &str, origin: &str) -> bool {
    if uri == origin {
        return true;
    }

    let Some(rest) = uri.strip_prefix(origin) else {
        return false;
    };

    rest.starts_with('/') || rest.starts_with('?') || rest.starts_with('#')
}

fn is_allowed_main_window_url(uri: &str) -> bool {
    let normalized = uri.trim().to_ascii_lowercase();

    if normalized == "about:blank" || normalized.starts_with("about:blank#") {
        return true;
    }

    [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "http://localhost:1420",
        "http://127.0.0.1:1420",
    ]
    .iter()
    .any(|origin| origin_match_with_boundary(&normalized, origin))
}

fn truncate_uri_for_log(uri: &str) -> String {
    const MAX_LOG_URI_CHARS: usize = 512;
    let mut truncated: String = uri.chars().take(MAX_LOG_URI_CHARS).collect();
    if uri.chars().count() > MAX_LOG_URI_CHARS {
        truncated.push_str("...");
    }
    truncated
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn open_url_in_system_browser(uri: &str) -> bool {
    if !is_http_url(uri) || is_allowed_main_window_url(uri) {
        return false;
    }

    let operation = wide_null("open");
    let file = wide_null(uri);
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };

    let code = result as isize;
    if code <= 32 {
        log::warn!(
            "[webview_navigation_guard] failed to open external URL in system browser, code={}, uri={}",
            code,
            truncate_uri_for_log(uri)
        );
        return false;
    }

    true
}

fn navigation_starting_uri(args: &ICoreWebView2NavigationStartingEventArgs) -> Option<String> {
    let mut raw_uri = PWSTR::null();
    if unsafe { args.Uri(&mut raw_uri) }.is_ok() {
        Some(take_pwstr(raw_uri))
    } else {
        None
    }
}

fn new_window_uri(args: &ICoreWebView2NewWindowRequestedEventArgs) -> Option<String> {
    let mut raw_uri = PWSTR::null();
    if unsafe { args.Uri(&mut raw_uri) }.is_ok() {
        Some(take_pwstr(raw_uri))
    } else {
        None
    }
}

fn process_failed_details(
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ProcessFailedEventArgs,
) -> String {
    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
    let kind_result = unsafe { args.ProcessFailedKind(&mut kind) };

    let mut reason = None;
    let mut exit_code = None;
    let mut process_description = None;
    let mut failure_source_module_path = None;

    if let Ok(args2) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
        let mut raw_reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
        if unsafe { args2.Reason(&mut raw_reason) }.is_ok() {
            reason = Some(raw_reason);
        }

        let mut raw_exit_code = 0;
        if unsafe { args2.ExitCode(&mut raw_exit_code) }.is_ok() {
            exit_code = Some(raw_exit_code);
        }

        let mut raw_description = PWSTR::null();
        if unsafe { args2.ProcessDescription(&mut raw_description) }.is_ok() {
            process_description = Some(take_pwstr(raw_description));
        }

        if let Ok(args3) = args2.cast::<ICoreWebView2ProcessFailedEventArgs3>() {
            let mut raw_module_path = PWSTR::null();
            if unsafe { args3.FailureSourceModulePath(&mut raw_module_path) }.is_ok() {
                failure_source_module_path = Some(take_pwstr(raw_module_path));
            }
        }
    }

    let kind_value = kind.0;
    let kind_label = if kind_result.is_ok() {
        process_failed_kind_label(kind)
    } else {
        "kind_unavailable"
    };
    let reason_value = reason.map(|value| value.0);
    let reason_label = reason
        .map(process_failed_reason_label)
        .unwrap_or("reason_unavailable");

    format!(
        "kind={}({}), reason={}({:?}), exit_code={:?}, process_description={:?}, failure_source_module_path={:?}",
        kind_label,
        kind_value,
        reason_label,
        reason_value,
        exit_code,
        process_description,
        failure_source_module_path
    )
}

pub fn install_process_failed_logger(window: &tauri::WebviewWindow) {
    let label = window.label().to_string();
    let result = window.with_webview(move |platform_webview| {
        let controller = platform_webview.controller();
        let webview = match unsafe { controller.CoreWebView2() } {
            Ok(webview) => webview,
            Err(error) => {
                log::warn!(
                    "[webview_process_failed] failed to get CoreWebView2 for window={}: {}",
                    label,
                    error
                );
                return;
            }
        };

        let event_label = label.clone();
        let mut token = 0;
        let handler = ProcessFailedEventHandler::create(Box::new(move |_sender, args| {
            if let Some(args) = args {
                log::error!(
                    "[webview_process_failed] window={}, {}",
                    event_label,
                    process_failed_details(&args)
                );
            } else {
                log::error!(
                    "[webview_process_failed] window={}, ProcessFailed fired without args",
                    event_label
                );
            }
            Ok(())
        }));

        if let Err(error) = unsafe { webview.add_ProcessFailed(&handler, &mut token) } {
            log::warn!(
                "[webview_process_failed] failed to register ProcessFailed handler for window={}: {}",
                label,
                error
            );
        } else {
            log::info!(
                "[webview_process_failed] ProcessFailed handler registered for window={}, token={}",
                label,
                token
            );
        }
    });

    if let Err(error) = result {
        log::warn!(
            "[webview_process_failed] failed to access platform webview for window={}: {}",
            window.label(),
            error
        );
    }
}

pub fn install_navigation_guard(window: &tauri::WebviewWindow) {
    let label = window.label().to_string();
    let result = window.with_webview(move |platform_webview| {
        let controller = platform_webview.controller();
        let webview = match unsafe { controller.CoreWebView2() } {
            Ok(webview) => webview,
            Err(error) => {
                log::warn!(
                    "[webview_navigation_guard] failed to get CoreWebView2 for window={}: {}",
                    label,
                    error
                );
                return;
            }
        };

        let navigation_label = label.clone();
        let mut navigation_token = 0;
        let navigation_handler =
            NavigationStartingEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else {
                    return Ok(());
                };

                let Some(uri) = navigation_starting_uri(&args) else {
                    return Ok(());
                };

                if !is_allowed_main_window_url(&uri) {
                    unsafe { args.SetCancel(true) }?;
                    log::warn!(
                        "[webview_navigation_guard] blocked main window navigation, window={}, uri={}",
                        navigation_label,
                        truncate_uri_for_log(&uri)
                    );
                }

                Ok(())
            }));

        if let Err(error) =
            unsafe { webview.add_NavigationStarting(&navigation_handler, &mut navigation_token) }
        {
            log::warn!(
                "[webview_navigation_guard] failed to register NavigationStarting handler for window={}: {}",
                label,
                error
            );
        } else {
            log::info!(
                "[webview_navigation_guard] NavigationStarting handler registered for window={}, token={}",
                label,
                navigation_token
            );
        }

        let new_window_label = label.clone();
        let mut new_window_token = 0;
        let new_window_handler =
            NewWindowRequestedEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else {
                    return Ok(());
                };

                let uri = new_window_uri(&args);
                unsafe { args.SetHandled(true) }?;

                if let Some(uri) = uri {
                    let opened = open_url_in_system_browser(&uri);
                    if opened {
                        log::info!(
                            "[webview_navigation_guard] opened new-window URL externally, window={}, uri={}",
                            new_window_label,
                            truncate_uri_for_log(&uri)
                        );
                    } else {
                        log::warn!(
                            "[webview_navigation_guard] blocked new-window request, window={}, uri={}",
                            new_window_label,
                            truncate_uri_for_log(&uri)
                        );
                    }
                } else {
                    log::warn!(
                        "[webview_navigation_guard] blocked new-window request without URI, window={}",
                        new_window_label
                    );
                }

                Ok(())
            }));

        if let Err(error) =
            unsafe { webview.add_NewWindowRequested(&new_window_handler, &mut new_window_token) }
        {
            log::warn!(
                "[webview_navigation_guard] failed to register NewWindowRequested handler for window={}: {}",
                label,
                error
            );
        } else {
            log::info!(
                "[webview_navigation_guard] NewWindowRequested handler registered for window={}, token={}",
                label,
                new_window_token
            );
        }
    });

    if let Err(error) = result {
        log::warn!(
            "[webview_navigation_guard] failed to access platform webview for window={}: {}",
            window.label(),
            error
        );
    }
}
