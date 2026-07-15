//! Windows task-completion notification command.
//!
//! The stock Tauri desktop notification plugin does not expose activation events or
//! action buttons on Windows, so this command uses the WinRT toast API for the
//! interactive Windows path and lets the frontend fall back to the plugin elsewhere.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::AppHandle;

#[cfg(windows)]
use super::system_tray::restore_main_window;
#[cfg(windows)]
use std::path::Path;
#[cfg(windows)]
use tauri::Emitter;
#[cfg(windows)]
use tauri_winrt_notification::{Duration, Toast};

#[cfg(windows)]
const TASK_COMPLETION_NOTIFICATION_OPEN_EVENT: &str = "task-completion-notification:open";
#[cfg(windows)]
const MAX_ACTION_LABEL_CHARS: usize = 64;
static PENDING_NOTIFICATION_TARGET: Mutex<Option<TaskCompletionNotificationTarget>> =
    Mutex::new(None);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCompletionNotificationTarget {
    pub message_id: String,
    pub context_type: String,
    pub context_id: String,
    pub agent_id: String,
    pub hub_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCompletionNotificationRequest {
    pub title: String,
    pub body: String,
    pub action_label: String,
    pub target: TaskCompletionNotificationTarget,
}

/// Shows an actionable task-completion notification when the platform supports it.
///
/// A `false` result tells the renderer to use the existing non-interactive plugin
/// notification as a cross-platform fallback.
#[tauri::command]
pub fn show_task_completion_notification(
    app: AppHandle,
    request: TaskCompletionNotificationRequest,
) -> Result<bool, String> {
    show_platform_notification(app, request)
}

/// Returns the last unacknowledged notification activation, if one exists.
#[tauri::command]
pub fn get_pending_task_completion_notification_target(
) -> Result<Option<TaskCompletionNotificationTarget>, String> {
    PENDING_NOTIFICATION_TARGET
        .lock()
        .map(|pending| pending.clone())
        .map_err(|_| "Task notification navigation state is unavailable".to_string())
}

/// Clears a pending activation only when it still refers to the acknowledged message.
#[tauri::command]
pub fn clear_pending_task_completion_notification_target(message_id: String) -> Result<(), String> {
    let mut pending = PENDING_NOTIFICATION_TARGET
        .lock()
        .map_err(|_| "Task notification navigation state is unavailable".to_string())?;
    clear_pending_target_if_matches(&mut pending, &message_id);
    Ok(())
}

fn clear_pending_target_if_matches(
    pending: &mut Option<TaskCompletionNotificationTarget>,
    message_id: &str,
) {
    if pending
        .as_ref()
        .is_some_and(|target| target.message_id == message_id)
    {
        *pending = None;
    }
}

#[cfg(windows)]
fn remember_pending_notification_target(target: TaskCompletionNotificationTarget) {
    match PENDING_NOTIFICATION_TARGET.lock() {
        Ok(mut pending) => *pending = Some(target),
        Err(_) => log::warn!("Failed to retain task notification navigation target"),
    }
}

#[cfg(windows)]
fn show_platform_notification(
    app: AppHandle,
    request: TaskCompletionNotificationRequest,
) -> Result<bool, String> {
    let app_id = notification_app_id(&app);
    let activation_app = app.clone();
    let activation_target = request.target.clone();
    let action_label = escape_action_label(&request.action_label)?;

    Toast::new(&app_id)
        .title(&request.title)
        .text1(&request.body)
        .duration(Duration::Short)
        .sound(None)
        .add_button(&action_label, "open")
        .on_activated(move |action| {
            if !is_supported_activation(action.as_deref()) {
                log::warn!("Ignored an unknown task notification action: {action:?}");
                return Ok(());
            }

            let dispatcher = activation_app.clone();
            let app_for_main_thread = activation_app.clone();
            let target = activation_target.clone();
            remember_pending_notification_target(target.clone());

            if let Err(error) = dispatcher.run_on_main_thread(move || {
                if let Err(error) = restore_main_window(&app_for_main_thread) {
                    log::warn!(
                        "Failed to restore the main window after notification activation: {error}"
                    );
                }
                if let Err(error) =
                    app_for_main_thread.emit(TASK_COMPLETION_NOTIFICATION_OPEN_EVENT, target)
                {
                    log::warn!(
                        "Failed to emit task completion notification navigation event: {}",
                        error
                    );
                }
            }) {
                log::warn!(
                    "Failed to dispatch task completion notification activation: {}",
                    error
                );
            }

            Ok(())
        })
        .show()
        .map_err(|error| format!("Failed to show interactive task notification: {error}"))?;

    Ok(true)
}

#[cfg(not(windows))]
fn show_platform_notification(
    _app: AppHandle,
    _request: TaskCompletionNotificationRequest,
) -> Result<bool, String> {
    Ok(false)
}

#[cfg(windows)]
fn is_local_target_output(executable_directory: &Path) -> bool {
    executable_directory.ends_with(Path::new("target").join("debug"))
        || executable_directory.ends_with(Path::new("target").join("release"))
}

#[cfg(windows)]
fn notification_app_id(app: &AppHandle) -> String {
    // Local debug/release outputs do not have an installed AppUserModelID. Mirror
    // the notification plugin's PowerShell fallback so actionable toasts still show.
    let is_local_build = std::env::current_exe()
        .ok()
        .and_then(|executable| executable.parent().map(is_local_target_output))
        .unwrap_or(true);

    if is_local_build {
        Toast::POWERSHELL_APP_ID.to_owned()
    } else {
        app.config().identifier.clone()
    }
}

#[cfg(windows)]
fn is_supported_activation(action: Option<&str>) -> bool {
    action.is_none() || action == Some("open")
}

#[cfg(windows)]
fn escape_action_label(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Task notification action label cannot be empty".to_string());
    }
    let mut escaped = String::with_capacity(trimmed.len());

    // tauri-winrt-notification escapes toast text but not action attributes.
    // Keep this renderer-controlled string bounded and XML-attribute-safe.
    for character in trimmed.chars().take(MAX_ACTION_LABEL_CHARS) {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '\'' => escaped.push_str("&apos;"),
            '"' => escaped.push_str("&quot;"),
            _ => escaped.push(character),
        }
    }

    Ok(escaped)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn escapes_renderer_controlled_action_label_for_toast_xml() {
        assert_eq!(
            escape_action_label("View <Agent> & 'reply' \"now\"").unwrap(),
            "View &lt;Agent&gt; &amp; &apos;reply&apos; &quot;now&quot;"
        );
    }

    #[test]
    fn bounds_action_label_by_unicode_characters() {
        let label = "查".repeat(MAX_ACTION_LABEL_CHARS + 10);
        assert_eq!(
            escape_action_label(&label).unwrap().chars().count(),
            MAX_ACTION_LABEL_CHARS
        );
    }

    #[test]
    fn rejects_an_empty_action_label_instead_of_hardcoding_visible_copy() {
        assert!(escape_action_label("   ").is_err());
    }

    #[test]
    fn accepts_notification_body_and_open_action_activations() {
        assert!(is_supported_activation(None));
        assert!(is_supported_activation(Some("open")));
        assert!(!is_supported_activation(Some("unexpected-action")));
    }

    #[test]
    fn detects_uninstalled_debug_and_release_output_directories() {
        assert!(is_local_target_output(Path::new(
            r"D:\AgentVis\src-tauri\target\debug"
        )));
        assert!(is_local_target_output(Path::new(
            r"D:\AgentVis\src-tauri\target\release"
        )));
        assert!(!is_local_target_output(Path::new(
            r"C:\Program Files\AgentVis"
        )));
    }

    #[test]
    fn only_matching_renderer_acknowledgements_clear_a_pending_target() {
        let mut pending = Some(TaskCompletionNotificationTarget {
            message_id: "message-2".to_string(),
            context_type: "agent".to_string(),
            context_id: "agent-2".to_string(),
            agent_id: "agent-2".to_string(),
            hub_id: Some("hub-2".to_string()),
        });

        clear_pending_target_if_matches(&mut pending, "message-1");
        assert!(pending.is_some());

        clear_pending_target_if_matches(&mut pending, "message-2");
        assert!(pending.is_none());
    }
}
