//! Native system-tray and application window lifecycle.
//!
//! The title-bar close request hides the main window, while the tray Exit item
//! asks the renderer to perform active-task confirmation and bounded cleanup.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::menu::{MenuBuilder, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, Runtime, State, Window, WindowEvent, Wry};

const MAIN_WINDOW_LABEL: &str = "main";
const SYSTEM_TRAY_ID: &str = "agentvis-main-tray";
const OPEN_MENU_ITEM_ID: &str = "tray-open-agentvis";
const EXIT_MENU_ITEM_ID: &str = "tray-exit-agentvis";
const SYSTEM_TRAY_EXIT_REQUESTED_EVENT: &str = "system-tray:exit-requested";
const MAIN_WINDOW_HIDDEN_EVENT: &str = "system-tray:main-window-hidden";
const MAX_MENU_LABEL_CHARS: usize = 64;
const EXIT_REQUEST_ACK_TIMEOUT: Duration = Duration::from_secs(5);

static SYSTEM_TRAY_LIFECYCLE: Mutex<SystemTrayLifecycle> = Mutex::new(SystemTrayLifecycle {
    next_exit_request_id: 1,
    active_exit_request: None,
    main_window_hidden_pending: false,
});

#[derive(Clone, Copy, Debug, PartialEq)]
struct ExitRequest {
    id: u64,
    acknowledged: bool,
}

#[derive(Debug)]
struct SystemTrayLifecycle {
    next_exit_request_id: u64,
    active_exit_request: Option<ExitRequest>,
    main_window_hidden_pending: bool,
}

impl SystemTrayLifecycle {
    fn request_exit(&mut self) -> u64 {
        let request_id = self.next_exit_request_id.max(1);
        self.next_exit_request_id = request_id.wrapping_add(1).max(1);
        self.active_exit_request = Some(ExitRequest {
            id: request_id,
            acknowledged: false,
        });
        self.main_window_hidden_pending = false;
        request_id
    }

    fn active_exit_request_id(&self) -> Option<u64> {
        self.active_exit_request.map(|request| request.id)
    }

    fn acknowledge_exit(&mut self, request_id: u64) -> bool {
        let Some(request) = self.active_exit_request.as_mut() else {
            return false;
        };
        if request.id != request_id {
            return false;
        }
        request.acknowledged = true;
        true
    }

    fn cancel_exit(&mut self, request_id: Option<u64>) -> bool {
        let Some(request) = self.active_exit_request else {
            return false;
        };
        if request_id.is_some_and(|expected| expected != request.id) {
            return false;
        }
        self.active_exit_request = None;
        true
    }

    fn authorize_exit(&mut self, request_id: u64) -> bool {
        let is_authorized = self
            .active_exit_request
            .is_some_and(|request| request.id == request_id && request.acknowledged);
        if is_authorized {
            self.active_exit_request = None;
            self.main_window_hidden_pending = false;
        }
        is_authorized
    }

    fn expire_unacknowledged_exit(&mut self, request_id: u64) -> bool {
        let should_exit = self
            .active_exit_request
            .is_some_and(|request| request.id == request_id && !request.acknowledged);
        if should_exit {
            self.active_exit_request = None;
        }
        should_exit
    }

    fn mark_main_window_hidden(&mut self) {
        self.active_exit_request = None;
        self.main_window_hidden_pending = true;
    }

    fn acknowledge_main_window_hidden(&mut self) -> bool {
        std::mem::replace(&mut self.main_window_hidden_pending, false)
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemTrayExitRequestPayload {
    request_id: u64,
}

/// Menu handles retained so renderer-provided localized labels can be updated.
pub struct SystemTrayMenuState {
    open_item: MenuItem<Wry>,
    exit_item: MenuItem<Wry>,
}

/// Restores and focuses the existing main window without creating another one.
pub(crate) fn restore_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "AgentVis main window is unavailable".to_string())?;

    let mut failures = Vec::new();
    if let Err(error) = window.unminimize() {
        failures.push(format!("unminimize failed: {error}"));
    }
    if let Err(error) = window.show() {
        failures.push(format!("show failed: {error}"));
    }
    if let Err(error) = window.set_focus() {
        failures.push(format!("focus failed: {error}"));
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

fn request_application_exit(app: &AppHandle) {
    let request_id = match SYSTEM_TRAY_LIFECYCLE.lock() {
        Ok(mut lifecycle) => lifecycle.request_exit(),
        Err(_) => {
            log::error!("System-tray lifecycle state is unavailable; exiting immediately");
            app.exit(0);
            return;
        }
    };

    // A hidden WebView can be suspended by the platform. Restore it before emit,
    // while retaining an identified request so startup/focus can recover it.
    if let Err(error) = restore_main_window(app) {
        log::warn!("Failed to restore AgentVis for tray Exit confirmation: {error}");
    }
    if let Err(error) = app.emit(
        SYSTEM_TRAY_EXIT_REQUESTED_EVENT,
        SystemTrayExitRequestPayload { request_id },
    ) {
        log::warn!("Failed to emit system-tray Exit request: {error}");
    }

    // Every explicit Exit click is a fresh attempt. If the renderer became
    // unresponsive after acknowledging an older attempt, clicking Exit again
    // supersedes it and arms a new watchdog instead of reusing a dead request.
    let watchdog_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(EXIT_REQUEST_ACK_TIMEOUT).await;
        let should_force_exit = match SYSTEM_TRAY_LIFECYCLE.lock() {
            Ok(mut lifecycle) => lifecycle.expire_unacknowledged_exit(request_id),
            Err(_) => true,
        };
        if should_force_exit {
            log::warn!(
                "Renderer did not acknowledge tray Exit request {request_id}; exiting natively"
            );
            watchdog_app.exit(0);
        }
    });
}

fn is_left_click_release(button: MouseButton, button_state: MouseButtonState) -> bool {
    button == MouseButton::Left && button_state == MouseButtonState::Up
}

fn normalize_menu_label(value: String, field_name: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field_name} cannot be empty"));
    }
    if trimmed.chars().count() > MAX_MENU_LABEL_CHARS {
        return Err(format!(
            "{field_name} cannot exceed {MAX_MENU_LABEL_CHARS} characters"
        ));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(format!("{field_name} cannot contain control characters"));
    }
    Ok(trimmed.to_string())
}

/// Creates the tray icon and its deliberately small Open/Exit context menu.
pub fn install_system_tray(app: &mut App) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, OPEN_MENU_ITEM_ID, "Open AgentVis", true, None::<&str>)?;
    let exit_item = MenuItem::with_id(app, EXIT_MENU_ITEM_ID, "Exit", true, None::<&str>)?;
    let menu = MenuBuilder::new(app)
        .item(&open_item)
        .separator()
        .item(&exit_item)
        .build()?;

    let mut tray_builder = TrayIconBuilder::with_id(SYSTEM_TRAY_ID)
        .tooltip("AgentVis")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_MENU_ITEM_ID => {
                if let Err(error) = restore_main_window(app) {
                    log::warn!("Failed to restore AgentVis from the tray menu: {error}");
                }
            }
            EXIT_MENU_ITEM_ID => request_application_exit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            let should_restore = match event {
                TrayIconEvent::Click {
                    button,
                    button_state,
                    ..
                } => is_left_click_release(button, button_state),
                TrayIconEvent::DoubleClick { button, .. } => button == MouseButton::Left,
                _ => false,
            };

            if should_restore {
                if let Err(error) = restore_main_window(tray.app_handle()) {
                    log::warn!("Failed to restore AgentVis from the tray icon: {error}");
                }
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
    }
    tray_builder.build(app)?;
    app.manage(SystemTrayMenuState {
        open_item,
        exit_item,
    });
    Ok(())
}

/// Intercepts the main title-bar close action and converts it to tray hiding.
pub fn handle_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }

    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        match SYSTEM_TRAY_LIFECYCLE.lock() {
            Ok(mut lifecycle) => lifecycle.mark_main_window_hidden(),
            Err(_) => log::warn!("Failed to retain the main-window hidden state"),
        }
        // Emit while the WebView is still visible, then retain the state for a
        // focus/visibility recovery in case JavaScript still misses the event.
        if let Err(error) = window.app_handle().emit(MAIN_WINDOW_HIDDEN_EVENT, ()) {
            log::warn!("Failed to emit the main-window hidden event: {error}");
        }
        if let Err(error) = window.hide() {
            log::warn!("Failed to hide AgentVis in the system tray: {error}");
        }
    }
}

/// Applies renderer-localized labels to the two native tray menu items.
#[tauri::command]
pub fn set_system_tray_labels(
    state: State<'_, SystemTrayMenuState>,
    open_label: String,
    exit_label: String,
) -> Result<(), String> {
    let open_label = normalize_menu_label(open_label, "Tray Open label")?;
    let exit_label = normalize_menu_label(exit_label, "Tray Exit label")?;

    state
        .open_item
        .set_text(open_label)
        .map_err(|error| format!("Failed to update Tray Open label: {error}"))?;
    state
        .exit_item
        .set_text(exit_label)
        .map_err(|error| format!("Failed to update Tray Exit label: {error}"))?;
    Ok(())
}

/// Returns the active tray Exit request without consuming it.
#[tauri::command]
pub fn get_active_system_tray_exit_request() -> Result<Option<u64>, String> {
    SYSTEM_TRAY_LIFECYCLE
        .lock()
        .map(|lifecycle| lifecycle.active_exit_request_id())
        .map_err(|_| "System-tray lifecycle state is unavailable".to_string())
}

/// Acknowledges an Exit request only after the renderer has accepted responsibility.
#[tauri::command]
pub fn acknowledge_system_tray_exit_request(request_id: u64) -> Result<bool, String> {
    SYSTEM_TRAY_LIFECYCLE
        .lock()
        .map(|mut lifecycle| lifecycle.acknowledge_exit(request_id))
        .map_err(|_| "System-tray lifecycle state is unavailable".to_string())
}

/// Cancels the renderer's current Exit confirmation or cleanup authorization.
#[tauri::command]
pub fn cancel_system_tray_exit_request(request_id: u64) -> Result<bool, String> {
    SYSTEM_TRAY_LIFECYCLE
        .lock()
        .map(|mut lifecycle| lifecycle.cancel_exit(Some(request_id)))
        .map_err(|_| "System-tray lifecycle state is unavailable".to_string())
}

/// Returns whether a title-bar close event still needs renderer reconciliation.
#[tauri::command]
pub fn get_pending_main_window_hidden_event() -> Result<bool, String> {
    SYSTEM_TRAY_LIFECYCLE
        .lock()
        .map(|lifecycle| lifecycle.main_window_hidden_pending)
        .map_err(|_| "System-tray lifecycle state is unavailable".to_string())
}

/// Clears the retained hidden event after the renderer has closed stale UI.
#[tauri::command]
pub fn acknowledge_main_window_hidden_event() -> Result<bool, String> {
    SYSTEM_TRAY_LIFECYCLE
        .lock()
        .map(|mut lifecycle| lifecycle.acknowledge_main_window_hidden())
        .map_err(|_| "System-tray lifecycle state is unavailable".to_string())
}

/// Exits only while the acknowledged tray request has not been cancelled by X.
#[tauri::command]
pub fn exit_application_from_system_tray(app: AppHandle, request_id: u64) -> Result<(), String> {
    let is_authorized = SYSTEM_TRAY_LIFECYCLE
        .lock()
        .map(|mut lifecycle| lifecycle.authorize_exit(request_id))
        .map_err(|_| "System-tray lifecycle state is unavailable".to_string())?;
    if !is_authorized {
        return Err("The system-tray Exit request was cancelled or superseded".to_string());
    }
    app.exit(0);
    Ok(())
}

/// Emergency full-process exit retained for the renderer crash recovery screen.
#[tauri::command]
pub fn exit_application(app: AppHandle) {
    if let Ok(mut lifecycle) = SYSTEM_TRAY_LIFECYCLE.lock() {
        lifecycle.active_exit_request = None;
        lifecycle.main_window_hidden_pending = false;
    }
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_left_button_release_opens_from_a_single_click() {
        assert!(is_left_click_release(
            MouseButton::Left,
            MouseButtonState::Up
        ));
        assert!(!is_left_click_release(
            MouseButton::Left,
            MouseButtonState::Down
        ));
        assert!(!is_left_click_release(
            MouseButton::Right,
            MouseButtonState::Up
        ));
    }

    #[test]
    fn validates_renderer_controlled_menu_labels() {
        assert_eq!(
            normalize_menu_label("  Open AgentVis  ".to_string(), "Open").unwrap(),
            "Open AgentVis"
        );
        assert!(normalize_menu_label("   ".to_string(), "Open").is_err());
        assert!(normalize_menu_label("界".repeat(MAX_MENU_LABEL_CHARS + 1), "Open").is_err());
        assert!(normalize_menu_label("Open\nAgentVis".to_string(), "Open").is_err());
    }

    #[test]
    fn exit_requests_require_matching_acknowledgement_and_authorization() {
        let mut lifecycle = SystemTrayLifecycle {
            next_exit_request_id: 1,
            active_exit_request: None,
            main_window_hidden_pending: false,
        };
        let request_id = lifecycle.request_exit();
        assert_eq!(lifecycle.active_exit_request_id(), Some(request_id));
        assert!(!lifecycle.acknowledge_exit(request_id + 1));
        assert!(!lifecycle.authorize_exit(request_id));
        assert!(lifecycle.acknowledge_exit(request_id));
        assert!(lifecycle.authorize_exit(request_id));
        assert_eq!(lifecycle.active_exit_request_id(), None);
    }

    #[test]
    fn close_cancels_exit_and_retains_hidden_state_until_acknowledged() {
        let mut lifecycle = SystemTrayLifecycle {
            next_exit_request_id: 7,
            active_exit_request: None,
            main_window_hidden_pending: false,
        };
        let request_id = lifecycle.request_exit();
        lifecycle.mark_main_window_hidden();

        assert_eq!(lifecycle.active_exit_request_id(), None);
        assert!(!lifecycle.acknowledge_exit(request_id));
        assert!(lifecycle.main_window_hidden_pending);
        assert!(lifecycle.acknowledge_main_window_hidden());
        assert!(!lifecycle.acknowledge_main_window_hidden());
    }

    #[test]
    fn watchdog_only_expires_the_matching_unacknowledged_request() {
        let mut lifecycle = SystemTrayLifecycle {
            next_exit_request_id: 11,
            active_exit_request: None,
            main_window_hidden_pending: false,
        };
        let request_id = lifecycle.request_exit();
        assert!(!lifecycle.expire_unacknowledged_exit(request_id + 1));
        assert!(lifecycle.acknowledge_exit(request_id));
        assert!(!lifecycle.expire_unacknowledged_exit(request_id));

        assert!(lifecycle.cancel_exit(Some(request_id)));
        let next_request_id = lifecycle.request_exit();
        assert!(lifecycle.expire_unacknowledged_exit(next_request_id));
    }

    #[test]
    fn repeated_exit_supersedes_an_acknowledged_attempt_and_rearms_watchdog() {
        let mut lifecycle = SystemTrayLifecycle {
            next_exit_request_id: 31,
            active_exit_request: None,
            main_window_hidden_pending: true,
        };
        let first_request_id = lifecycle.request_exit();
        assert!(lifecycle.acknowledge_exit(first_request_id));

        let second_request_id = lifecycle.request_exit();
        assert_ne!(second_request_id, first_request_id);
        assert_eq!(lifecycle.active_exit_request_id(), Some(second_request_id));
        assert!(!lifecycle.expire_unacknowledged_exit(first_request_id));
        assert!(lifecycle.expire_unacknowledged_exit(second_request_id));
        assert!(!lifecycle.main_window_hidden_pending);
    }
}
