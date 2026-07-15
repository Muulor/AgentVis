//! AgentVis 库模块
//!
//! 这是 Tauri 应用的核心库，包含所有模块定义和应用初始化逻辑。

pub mod commands;
pub mod crypto;
pub mod db;
pub mod error;
pub mod llm;
pub(crate) mod text_utils;
#[cfg(windows)]
mod webview_diagnostics;

use std::path::Path;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

use commands::shell::BackgroundProcessRegistry;
use commands::{
    acknowledge_main_window_hidden_event,
    acknowledge_system_tray_exit_request,
    // Agent commands
    agent_create,
    agent_delete,
    agent_get,
    agent_list_by_hub,
    agent_reorder,
    agent_update,
    backup_clean,
    // Backup Management commands
    backup_get_stats,
    // Skills Bootstrap commands
    bootstrap_skills_if_needed,
    cancel_system_tray_exit_request,
    check_elevated_privileges,
    clear_pending_task_completion_notification_target,
    // Cloud Embedding commands
    cloud_embedding_encode,
    cloud_embedding_list_models,
    cloud_embedding_list_providers,
    cloud_rerank_documents,
    code_find,
    // Code Search commands (代码搜索)
    code_grep,
    code_outline,
    code_symbol,
    // Cron commands (定时任务)
    cron_create,
    cron_delete,
    cron_list_all_enabled,
    cron_list_by_agent,
    cron_update,
    data_clear_vectors,
    data_export,
    // Data Management commands (数据管理)
    data_get_stats,
    data_import,
    data_reset_all,
    // Diff Record commands (持久化 Diff 记录)
    diff_record_create,
    diff_record_get_by_message,
    diff_record_get_pending,
    diff_record_revert_by_message,
    diff_record_update_active_snapshot,
    diff_record_update_message_id,
    diff_record_update_modification_statuses,
    diff_record_update_status,
    exit_application,
    exit_application_from_system_tray,
    feishu_delete_app_data_file,
    feishu_delete_message,
    feishu_download_resource,
    // Feishu API proxy commands
    feishu_get_token,
    feishu_http_proxy,
    feishu_save_attachment,
    feishu_send_message,
    feishu_update_message,
    feishu_upload_file,
    feishu_upload_image,
    feishu_write_app_data_file,
    file_analyze_text_preview,
    file_copy_to_attachments,
    file_create_backup,
    file_get_size,
    file_import_to_workspace,
    file_list_deliverables,
    file_list_directory,
    file_list_project_directory,
    file_move_to_system_trash,
    file_open_system,
    file_read_as_base64,
    file_read_content,
    file_read_image_downscaled_as_base64,
    file_read_text_window,
    file_reveal_in_explorer,
    // File commands
    file_write_deliverable,
    file_write_staged_tool_arg_to_path,
    file_write_to_path,
    get_active_system_tray_exit_request,
    get_app_info,
    get_context7_api_key_status,
    get_giteeai_api_key_status,
    get_github_token_status,
    get_image_generation_api_key_status,
    get_pending_main_window_hidden_event,
    get_pending_task_completion_notification_target,
    get_protected_paths,
    get_siliconflow_api_key_status,
    get_tavily_api_key_status,
    // Security Settings commands
    get_trash_bin_path,
    gpt_image_generate,
    greet,
    // Hub commands
    hub_create,
    hub_delete,
    hub_get,
    hub_list,
    hub_reorder,
    hub_update,
    im_delete_app_data_file,
    im_delete_bot_credentials,
    im_get_bot_credentials,
    im_get_credentials,
    im_save_attachment,
    im_save_bot_credentials,
    // IM Channel commands
    im_save_credentials,
    im_write_app_data_file,
    llm_cancel_stream,
    // LLM commands
    llm_chat,
    llm_chat_stream,
    llm_chat_with_tools,
    llm_list_models,
    llm_list_providers,
    // Memory Candidate commands
    memory_candidate_create,
    memory_candidate_delete,
    memory_candidate_delete_batch,
    memory_candidate_list,
    memory_candidate_update,
    memory_clear_short_term,
    // Memory commands
    memory_create,
    memory_delete,
    memory_delete_by_source_ids,
    memory_delete_fact_with_vector,
    memory_delete_summary_with_vector,
    memory_get_context,
    memory_get_stats,
    memory_list_by_layer,
    memory_list_facts,
    memory_trigger_accumulate_score,
    // Memory Trigger commands (混合触发模型)
    memory_trigger_get,
    memory_trigger_get_or_create,
    memory_trigger_increment_turn,
    memory_trigger_reset,
    memory_trigger_update,
    memory_trigger_update_last_message,
    memory_update,
    message_clear_by_agent,
    message_count_by_agent,
    message_count_by_hub,
    // Message commands
    message_create,
    message_delete,
    message_get_after,
    message_get_agent_history_messages,
    message_get_batch,
    message_get_before,
    message_get_before_hub,
    message_get_recent,
    message_get_recent_hub,
    message_list_by_agent,
    message_list_by_hub,
    message_retract_from,
    message_search_agent_history,
    message_timeline_agent_history,
    message_update,
    minimax_image_generate,
    network_broker_http_request,
    // Document Parser commands
    parse_docx,
    parse_md,
    parse_pdf,
    parse_pptx,
    parse_txt,
    parse_xlsx,
    // Embedded Node.js commands
    prepare_embedded_node,
    // Embedded Python commands
    prepare_embedded_runtime,
    prepare_prebuilt_python_runtime,
    preview_acquire_template_lock,
    preview_cleanup_stale_workspaces,
    preview_cleanup_workspace,
    preview_copy_assets,
    preview_create_workspace,
    preview_list_source_tree,
    preview_read_text_file,
    preview_release_template_lock,
    rag_delete_by_agent,
    rag_delete_by_document,
    rag_get_status,
    // RAG commands
    rag_index_chunk,
    rag_list_chunks,
    rag_list_document_ids,
    rag_search,
    // Renderer health diagnostics
    renderer_health_heartbeat,
    sandbox_audit_events,
    sandbox_network_direct_target_risks,
    sandbox_network_direct_targets,
    save_clipboard_image,
    save_dropped_file,
    set_context7_api_key,
    set_giteeai_api_key,
    set_github_token,
    set_image_generation_api_key,
    set_protected_paths,
    set_siliconflow_api_key,
    set_system_tray_labels,
    set_tavily_api_key,
    settings_delete_api_key,
    // Settings commands
    settings_get_api_key_status,
    settings_set_api_key,
    settings_test_api_key,
    shell_background_status,
    shell_cancel,
    // Shell commands
    shell_execute,
    shell_kill,
    show_task_completion_notification,
    // Skill Install commands
    skill_install_from_github,
    slack_auth_test,
    slack_delete_file,
    slack_delete_message,
    slack_download_file,
    // Slack API proxy and generic IM file commands
    slack_open_socket_connection,
    slack_post_message,
    slack_update_message,
    slack_upload_file_external,
    snapshot_cleanup,
    snapshot_count,
    // Snapshot commands
    snapshot_create,
    snapshot_delete,
    snapshot_get,
    snapshot_get_latest,
    snapshot_list,
    snapshot_rollback,
    startup_trash_cleanup,
    test_context7_api_key,
    test_github_token,
    trash_bin_delete_batch,
    trash_bin_delete_entries,
    trash_bin_list_entries,
    trash_bin_restore_batch,
    trash_bin_restore_entries,
    // Web Search commands
    web_search,
    workspace_import_append_chunk,
    workspace_import_begin,
    workspace_import_cancel,
    workspace_import_commit,
    zhipu_image_generate,
};
use db::Database;

const TARGET_WINDOW_WIDTH: f64 = 1600.0;
const TARGET_WINDOW_HEIGHT: f64 = 900.0;
const MIN_WINDOW_WIDTH: f64 = 1024.0;
const MIN_WINDOW_HEIGHT: f64 = 600.0;
const RESTORED_WINDOW_MARGIN: f64 = 48.0;
#[cfg(windows)]
const WINDOW_EVENT_SETTLE_DELAY_MS: u64 = 120;

#[derive(Debug, PartialEq)]
struct StartupWindowLayout {
    width: f64,
    height: f64,
    should_maximize: bool,
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq)]
struct WindowBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq)]
struct WindowSize {
    width: u32,
    height: u32,
}

#[cfg(any(windows, test))]
#[derive(Debug)]
struct WindowRestoreTracker {
    last_normal_bounds: WindowBounds,
    was_maximized: bool,
    observation_generation: u64,
}

#[cfg(any(windows, test))]
impl WindowRestoreTracker {
    fn schedule_observation(&mut self) -> u64 {
        self.observation_generation = self.observation_generation.wrapping_add(1);
        self.observation_generation
    }

    fn observe_stable(
        &mut self,
        generation: u64,
        is_maximized: bool,
        current_bounds: WindowBounds,
    ) -> Option<WindowSize> {
        if generation != self.observation_generation {
            return None;
        }

        if is_maximized {
            self.was_maximized = true;
            return None;
        }

        if self.was_maximized {
            self.was_maximized = false;
            let restore_size = (current_bounds.width != self.last_normal_bounds.width
                || current_bounds.height != self.last_normal_bounds.height)
                .then_some(WindowSize {
                    width: self.last_normal_bounds.width,
                    height: self.last_normal_bounds.height,
                });

            // Windows chooses the restored position while the user drags a maximized window.
            // Preserve that native x/y and only retain the previously tracked normal size.
            self.last_normal_bounds = WindowBounds {
                x: current_bounds.x,
                y: current_bounds.y,
                width: self.last_normal_bounds.width,
                height: self.last_normal_bounds.height,
            };
            return restore_size;
        }

        self.last_normal_bounds = current_bounds;
        None
    }
}

fn calculate_startup_window_layout(
    work_area_width: f64,
    work_area_height: f64,
) -> StartupWindowLayout {
    let available_width = (work_area_width - RESTORED_WINDOW_MARGIN).max(MIN_WINDOW_WIDTH);
    let available_height = (work_area_height - RESTORED_WINDOW_MARGIN).max(MIN_WINDOW_HEIGHT);
    let width = TARGET_WINDOW_WIDTH.min(available_width);
    let height = TARGET_WINDOW_HEIGHT.min(available_height);

    StartupWindowLayout {
        width,
        height,
        should_maximize: width < TARGET_WINDOW_WIDTH || height < TARGET_WINDOW_HEIGHT,
    }
}

#[cfg(windows)]
fn capture_window_bounds(window: &tauri::WebviewWindow) -> tauri::Result<WindowBounds> {
    let position = window.outer_position()?;
    let size = window.inner_size()?;
    Ok(WindowBounds {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

#[cfg(windows)]
fn install_window_restore_tracking(
    window: &tauri::WebviewWindow,
    should_maximize_on_startup: bool,
) {
    let initial_bounds = match capture_window_bounds(window) {
        Ok(bounds) => bounds,
        Err(error) => {
            log::warn!("初始化窗口还原跟踪失败: {}", error);
            return;
        }
    };
    let initially_maximized = window.is_maximized().unwrap_or(false) || should_maximize_on_startup;
    let tracker = Arc::new(std::sync::Mutex::new(WindowRestoreTracker {
        last_normal_bounds: initial_bounds,
        was_maximized: initially_maximized,
        observation_generation: 0,
    }));
    let tracked_window = window.clone();

    window.on_window_event(move |event| {
        if !matches!(
            event,
            tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_)
        ) {
            return;
        }

        let generation = {
            let mut tracker = match tracker.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            tracker.schedule_observation()
        };
        let observation_window = tracked_window.clone();
        let observation_tracker = Arc::clone(&tracker);
        tauri::async_runtime::spawn(async move {
            // Maximize/restore emits intermediate move events before Windows updates IsZoomed.
            // Only the final stable event may update the tracked normal bounds.
            tokio::time::sleep(std::time::Duration::from_millis(
                WINDOW_EVENT_SETTLE_DELAY_MS,
            ))
            .await;
            let is_maximized = match observation_window.is_maximized() {
                Ok(value) => value,
                Err(error) => {
                    log::warn!("读取窗口最大化状态失败: {}", error);
                    return;
                }
            };
            let current_bounds = match capture_window_bounds(&observation_window) {
                Ok(bounds) => bounds,
                Err(error) => {
                    log::warn!("读取窗口位置和尺寸失败: {}", error);
                    return;
                }
            };
            let restore_bounds = {
                let mut tracker = match observation_tracker.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                tracker.observe_stable(generation, is_maximized, current_bounds)
            };

            if let Some(size) = restore_bounds {
                if let Err(error) =
                    observation_window.set_size(tauri::PhysicalSize::new(size.width, size.height))
                {
                    log::warn!("恢复最大化前窗口尺寸失败: {}", error);
                }
            }
        });
    });
}

/// 应用程序全局状态
pub struct AppState {
    /// 数据库连接
    pub db: Arc<Mutex<Database>>,
}

impl AppState {
    /// 创建新的应用状态
    pub async fn new(db_path: &Path) -> error::AppResult<Self> {
        let db = Database::new(db_path).await?;
        commands::process_sandbox::set_sandbox_audit_db_pool(db.pool().clone());
        Ok(Self {
            db: Arc::new(Mutex::new(db)),
        })
    }
}

fn default_log_level() -> log::LevelFilter {
    std::env::var("AGENTVIS_LOG")
        .ok()
        .and_then(|value| match value.trim().to_ascii_lowercase().as_str() {
            "off" => Some(log::LevelFilter::Off),
            "error" => Some(log::LevelFilter::Error),
            "warn" | "warning" => Some(log::LevelFilter::Warn),
            "info" => Some(log::LevelFilter::Info),
            "debug" => Some(log::LevelFilter::Debug),
            "trace" => Some(log::LevelFilter::Trace),
            _ => None,
        })
        .unwrap_or(log::LevelFilter::Info)
}

fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let location = panic_info
            .location()
            .map(|location| {
                format!(
                    "{}:{}:{}",
                    location.file(),
                    location.line(),
                    location.column()
                )
            })
            .unwrap_or_else(|| "unknown location".to_string());
        let payload = panic_info
            .payload()
            .downcast_ref::<&str>()
            .map(|value| (*value).to_string())
            .or_else(|| panic_info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "non-string panic payload".to_string());

        log::error!("Rust panic at {}: {}", location, payload);
        eprintln!("Rust panic at {}: {}", location, payload);
        default_hook(panic_info);
    }));
}

/// 运行 Tauri 应用
#[allow(dependency_on_unit_never_type_fallback)]
pub fn run() {
    install_panic_hook();

    tauri::Builder::default()
        // The single-instance plugin must be registered first so a second launch
        // cannot initialize duplicate schedulers, IM channels, or tray icons.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Err(error) = commands::system_tray::restore_main_window(app) {
                log::warn!("Failed to restore AgentVis after a second launch: {error}");
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    // 终端输出（开发时可见）
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    // 日志文件持久化（AppData/logs/agentvis.log）
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("agentvis".to_string()),
                    }),
                    // Webview 控制台（DevTools 可见）
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .max_file_size(5_000_000) // 5MB 日志文件大小上限
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                // 使用本地时区而非 UTC，避免日志时间与用户本地时间偏差
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .level(default_log_level())
                // sqlx 的 SQL 语句日志过于冗长，仅在 Warn 及以上输出
                .level_for("sqlx::query", log::LevelFilter::Warn)
                // tao 窗口管理器的事件循环警告属于正常行为，抑制到 Error
                .level_for("tao::platform_impl", log::LevelFilter::Error)
                // hyper 连接池心跳日志（pooling/reuse idle connection）在等待 API 响应时每秒刷出数十条
                .level_for("hyper_util", log::LevelFilter::Warn)
                .level_for("reqwest::connect", log::LevelFilter::Warn)
                .build(),
        )
        .on_window_event(|window, event| {
            commands::system_tray::handle_window_event(window, event);
        })
        .setup(|app| {
            commands::system_tray::install_system_tray(app)?;

            // 获取应用数据目录
            let app_data_dir = app.path().app_data_dir()
                .expect("Failed to resolve application data directory");

            // 确保目录存在
            std::fs::create_dir_all(&app_data_dir).ok();

            let db_path = app_data_dir.join("agentvis.db");
            let db_path_str = db_path.to_string_lossy().to_string();

            // 初始化应用状态
            let runtime = tokio::runtime::Runtime::new()
                .expect("Failed to create Tokio runtime");

            let state = runtime.block_on(async {
                AppState::new(&db_path).await
                    .expect("Failed to initialize database")
            });

            app.manage(state);
            app.manage(BackgroundProcessRegistry::new());
            commands::renderer_health::start_renderer_health_watchdog();

            log::info!("AgentVis 应用已初始化");
            log::trace!("数据库路径: {}", db_path_str);

            // 自适应窗口尺寸策略：先建立一个位于工作区内的普通窗口矩形，
            // 小屏再最大化，确保点击“还原”时能回到正确的尺寸和位置。
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(windows)]
                {
                    webview_diagnostics::install_process_failed_logger(&window);
                    webview_diagnostics::install_navigation_guard(&window);
                }

                let mut should_maximize_on_startup = false;
                match window.primary_monitor() {
                    Ok(Some(monitor)) => {
                        let physical_size = monitor.size();
                        let physical_work_area = monitor.work_area();
                        let scale_factor = monitor.scale_factor();
                        // 使用工作区而非完整屏幕，避免普通窗口被任务栏遮挡。
                        let logical_work_width =
                            physical_work_area.size.width as f64 / scale_factor;
                        let logical_work_height =
                            physical_work_area.size.height as f64 / scale_factor;
                        let layout = calculate_startup_window_layout(
                            logical_work_width,
                            logical_work_height,
                        );

                        log::trace!(
                            "Detected primary monitor physical {}x{}, logical work area {:.0}x{:.0} (scale {:.2})",
                            physical_size.width,
                            physical_size.height,
                            logical_work_width,
                            logical_work_height,
                            scale_factor
                        );

                        if let Err(e) = window.set_size(tauri::LogicalSize::new(
                            layout.width,
                            layout.height,
                        )) {
                            log::warn!("设置启动窗口尺寸失败: {}", e);
                        }
                        if let Err(e) = window.center() {
                            log::warn!("启动窗口居中失败: {}", e);
                        }

                        if layout.should_maximize {
                            log::trace!(
                                "工作区小于目标尺寸，使用 {:.0}×{:.0} 作为还原尺寸后自动最大化",
                                layout.width,
                                layout.height
                            );
                            should_maximize_on_startup = true;
                        }
                    }
                    Ok(None) => {
                        // 无法检测到主显示器，保持 tauri.conf.json 中的默认尺寸
                        log::warn!("未能检测到主显示器，使用默认窗口尺寸");
                    }
                    Err(e) => {
                        log::warn!("获取显示器信息失败: {}，使用默认窗口尺寸", e);
                    }
                }

                // Must be installed before startup maximization so the normal bounds are captured.
                #[cfg(windows)]
                install_window_restore_tracking(&window, should_maximize_on_startup);
                if should_maximize_on_startup {
                    if let Err(e) = window.maximize() {
                        log::warn!("窗口最大化失败: {}", e);
                    }
                }
            }

            // 异步预热 HTTP 连接（不阻塞启动）
            tauri::async_runtime::spawn(async {
                llm::http_client::warmup_connections().await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 基础命令
            greet,
            get_app_info,
            get_pending_task_completion_notification_target,
            clear_pending_task_completion_notification_target,
            show_task_completion_notification,
            set_system_tray_labels,
            get_active_system_tray_exit_request,
            acknowledge_system_tray_exit_request,
            cancel_system_tray_exit_request,
            get_pending_main_window_hidden_event,
            acknowledge_main_window_hidden_event,
            exit_application_from_system_tray,
            exit_application,
            // Hub 命令
            hub_create,
            hub_list,
            hub_get,
            hub_update,
            hub_reorder,
            hub_delete,
            // Agent 命令
            agent_create,
            agent_list_by_hub,
            agent_get,
            agent_update,
            agent_reorder,
            agent_delete,
            // Settings 命令
            settings_get_api_key_status,
            settings_set_api_key,
            settings_delete_api_key,
            settings_test_api_key,
            set_image_generation_api_key,
            get_image_generation_api_key_status,
            set_github_token,
            get_github_token_status,
            test_github_token,
            set_context7_api_key,
            get_context7_api_key_status,
            test_context7_api_key,
            // LLM 命令
            llm_chat,
            llm_chat_stream,
            llm_cancel_stream,
            llm_list_providers,
            llm_list_models,
            llm_chat_with_tools,
            gpt_image_generate,
            minimax_image_generate,
            zhipu_image_generate,
            // Cloud Embedding 命令
            cloud_embedding_encode,
            cloud_embedding_list_providers,
            cloud_embedding_list_models,
            cloud_rerank_documents,
            set_siliconflow_api_key,
            get_siliconflow_api_key_status,
            set_giteeai_api_key,
            get_giteeai_api_key_status,
            // RAG 命令
            rag_index_chunk,
            rag_search,
            rag_delete_by_agent,
            rag_delete_by_document,
            rag_get_status,
            rag_list_document_ids,
            rag_list_chunks,
            // Memory 命令
            memory_create,
            memory_list_by_layer,
            memory_list_facts,
            memory_update,
            memory_delete,
            memory_get_stats,
            memory_delete_by_source_ids,
            memory_get_context,
            memory_delete_summary_with_vector,
            memory_delete_fact_with_vector,
            memory_clear_short_term,
            // Memory Candidate 命令
            memory_candidate_create,
            memory_candidate_list,
            memory_candidate_update,
            memory_candidate_delete,
            memory_candidate_delete_batch,
            // Snapshot 命令
            snapshot_create,
            snapshot_get,
            snapshot_list,
            snapshot_get_latest,
            snapshot_rollback,
            snapshot_delete,
            snapshot_cleanup,
            snapshot_count,
            // Message 命令
            message_create,
            message_update,
            message_list_by_agent,
            message_search_agent_history,
            message_timeline_agent_history,
            message_get_agent_history_messages,
            message_list_by_hub,
            message_get_recent,
            message_get_batch,
            message_get_after,
            message_get_before,
            message_count_by_agent,
            message_delete,
            message_retract_from,
            message_clear_by_agent,
            message_get_recent_hub,
            message_get_before_hub,
            message_count_by_hub,
            // File 命令
            file_write_deliverable,
            file_read_content,
            file_read_text_window,
            file_analyze_text_preview,
            file_list_deliverables,
            file_move_to_system_trash,
            save_clipboard_image,
            save_dropped_file,
            file_write_to_path,
            file_write_staged_tool_arg_to_path,
            file_create_backup,
            file_read_as_base64,
            file_read_image_downscaled_as_base64,
            file_copy_to_attachments,
            file_get_size,
            file_open_system,
            file_reveal_in_explorer,
            file_list_directory,
            file_list_project_directory,
            file_import_to_workspace,
            workspace_import_begin,
            workspace_import_append_chunk,
            workspace_import_commit,
            workspace_import_cancel,
            // Backup Management 命令 (备份文件管理)
            backup_get_stats,
            backup_clean,
            // Web Search 命令
            web_search,
            set_tavily_api_key,
            get_tavily_api_key_status,
            network_broker_http_request,
            // Document Parser 命令
            parse_docx,
            parse_xlsx,
            parse_pdf,
            parse_txt,
            parse_md,
            parse_pptx,
            // Diff Record 命令 (持久化 Diff 记录)
            diff_record_create,
            diff_record_get_by_message,
            diff_record_get_pending,
            diff_record_update_status,
            diff_record_revert_by_message,
            diff_record_update_active_snapshot,
            diff_record_update_message_id,
            diff_record_update_modification_statuses,
            // Memory Trigger 命令 (混合触发模型)
            memory_trigger_get,
            memory_trigger_get_or_create,
            memory_trigger_update,
            memory_trigger_increment_turn,
            memory_trigger_accumulate_score,
            memory_trigger_reset,
            memory_trigger_update_last_message,
            // Data Management 命令 (数据管理)
            data_get_stats,
            data_clear_vectors,
            data_reset_all,
            data_export,
            data_import,
            // Shell 命令
            shell_execute,
            shell_cancel,
            shell_kill,
            shell_background_status,
            preview_create_workspace,
            preview_acquire_template_lock,
            preview_release_template_lock,
            preview_cleanup_workspace,
            preview_cleanup_stale_workspaces,
            preview_list_source_tree,
            preview_read_text_file,
            preview_copy_assets,
            sandbox_audit_events,
            sandbox_network_direct_targets,
            sandbox_network_direct_target_risks,
            check_elevated_privileges,
            startup_trash_cleanup,
            // Skill Install 命令
            skill_install_from_github,
            // Skills Bootstrap 命令
            bootstrap_skills_if_needed,
            // Embedded Python 命令
            prepare_embedded_runtime,
            prepare_prebuilt_python_runtime,
            // Embedded Node.js 命令
            prepare_embedded_node,
            renderer_health_heartbeat,
            // Security Settings 命令
            get_trash_bin_path,
            get_protected_paths,
            set_protected_paths,
            trash_bin_list_entries,
            trash_bin_restore_entries,
            trash_bin_restore_batch,
            trash_bin_delete_entries,
            trash_bin_delete_batch,
            // Cron 命令 (定时任务)
            cron_create,
            cron_list_by_agent,
            cron_list_all_enabled,
            cron_update,
            cron_delete,
            // Code Search 命令 (代码搜索)
            code_grep,
            code_find,
            code_outline,
            code_symbol,
            // IM Channel 命令 (凭据存储)
            im_save_credentials,
            im_get_credentials,
            // 多 Bot 独立凭据命令
            im_save_bot_credentials,
            im_get_bot_credentials,
            im_delete_bot_credentials,
            feishu_get_token,
            feishu_send_message,
            feishu_update_message,
            feishu_delete_message,
            feishu_http_proxy,
            feishu_upload_image,
            feishu_upload_file,
            feishu_download_resource,
            feishu_save_attachment,
            feishu_write_app_data_file,
            feishu_delete_app_data_file,
            slack_open_socket_connection,
            slack_auth_test,
            slack_post_message,
            slack_update_message,
            slack_delete_message,
            slack_delete_file,
            slack_upload_file_external,
            slack_download_file,
            im_save_attachment,
            im_write_app_data_file,
            im_delete_app_data_file,
        ])
        .run(tauri::generate_context!())
        .expect("An error occurred while running the Tauri application");
}

#[cfg(test)]
mod startup_window_tests {
    use super::*;

    #[test]
    fn keeps_target_size_on_a_large_work_area() {
        assert_eq!(
            calculate_startup_window_layout(1920.0, 1040.0),
            StartupWindowLayout {
                width: 1600.0,
                height: 900.0,
                should_maximize: false,
            }
        );
    }

    #[test]
    fn creates_a_fitting_restore_size_before_maximizing() {
        assert_eq!(
            calculate_startup_window_layout(1440.0, 852.0),
            StartupWindowLayout {
                width: 1392.0,
                height: 804.0,
                should_maximize: true,
            }
        );
    }

    #[test]
    fn respects_the_configured_minimum_window_size() {
        assert_eq!(
            calculate_startup_window_layout(1000.0, 580.0),
            StartupWindowLayout {
                width: 1024.0,
                height: 600.0,
                should_maximize: true,
            }
        );
    }

    #[test]
    fn restores_the_last_visible_bounds_after_maximizing() {
        let startup_bounds = WindowBounds {
            x: 420,
            y: 36,
            width: 1280,
            height: 720,
        };
        let vertically_resized_bounds = WindowBounds {
            x: 420,
            y: 0,
            width: 1280,
            height: 1080,
        };
        let maximized_bounds = WindowBounds {
            x: 0,
            y: 0,
            width: 2048,
            height: 1112,
        };
        let mut tracker = WindowRestoreTracker {
            last_normal_bounds: startup_bounds,
            was_maximized: false,
            observation_generation: 0,
        };

        let resized_generation = tracker.schedule_observation();
        assert_eq!(
            tracker.observe_stable(resized_generation, false, vertically_resized_bounds),
            None
        );
        let maximized_generation = tracker.schedule_observation();
        assert_eq!(
            tracker.observe_stable(maximized_generation, true, maximized_bounds),
            None
        );
        let restored_generation = tracker.schedule_observation();
        assert_eq!(
            tracker.observe_stable(restored_generation, false, startup_bounds),
            Some(WindowSize {
                width: vertically_resized_bounds.width,
                height: vertically_resized_bounds.height,
            })
        );
    }

    #[test]
    fn preserves_windows_drag_restore_position_while_restoring_size() {
        let normal_bounds = WindowBounds {
            x: 420,
            y: 36,
            width: 1280,
            height: 720,
        };
        let maximized_bounds = WindowBounds {
            x: 0,
            y: 0,
            width: 2048,
            height: 1112,
        };
        let dragged_restore_bounds = WindowBounds {
            x: 880,
            y: 72,
            width: 1600,
            height: 900,
        };
        let mut tracker = WindowRestoreTracker {
            last_normal_bounds: normal_bounds,
            was_maximized: false,
            observation_generation: 0,
        };

        let maximized_generation = tracker.schedule_observation();
        assert_eq!(
            tracker.observe_stable(maximized_generation, true, maximized_bounds),
            None
        );
        let restored_generation = tracker.schedule_observation();
        assert_eq!(
            tracker.observe_stable(restored_generation, false, dragged_restore_bounds),
            Some(WindowSize {
                width: normal_bounds.width,
                height: normal_bounds.height,
            })
        );
        assert_eq!(
            tracker.last_normal_bounds,
            WindowBounds {
                x: dragged_restore_bounds.x,
                y: dragged_restore_bounds.y,
                width: normal_bounds.width,
                height: normal_bounds.height,
            }
        );
    }

    #[test]
    fn accepts_windows_drag_restore_when_only_the_position_changed() {
        let normal_bounds = WindowBounds {
            x: 420,
            y: 36,
            width: 1280,
            height: 720,
        };
        let dragged_restore_bounds = WindowBounds {
            x: 880,
            y: 72,
            ..normal_bounds
        };
        let mut tracker = WindowRestoreTracker {
            last_normal_bounds: normal_bounds,
            was_maximized: true,
            observation_generation: 0,
        };

        let restored_generation = tracker.schedule_observation();
        assert_eq!(
            tracker.observe_stable(restored_generation, false, dragged_restore_bounds),
            None
        );
        assert_eq!(tracker.last_normal_bounds, dragged_restore_bounds);
    }

    #[test]
    fn leaves_native_restore_untouched_when_bounds_are_already_correct() {
        let normal_bounds = WindowBounds {
            x: 320,
            y: 180,
            width: 1200,
            height: 760,
        };
        let mut tracker = WindowRestoreTracker {
            last_normal_bounds: normal_bounds,
            was_maximized: false,
            observation_generation: 0,
        };

        let maximized_generation = tracker.schedule_observation();
        assert_eq!(
            tracker.observe_stable(maximized_generation, true, normal_bounds),
            None
        );
        let restored_generation = tracker.schedule_observation();
        assert_eq!(
            tracker.observe_stable(restored_generation, false, normal_bounds),
            None
        );
    }

    #[test]
    fn ignores_intermediate_window_events() {
        let normal_bounds = WindowBounds {
            x: 420,
            y: 0,
            width: 1280,
            height: 1080,
        };
        let intermediate_bounds = WindowBounds {
            x: 0,
            y: 0,
            width: 1600,
            height: 900,
        };
        let mut tracker = WindowRestoreTracker {
            last_normal_bounds: normal_bounds,
            was_maximized: false,
            observation_generation: 0,
        };

        let intermediate_generation = tracker.schedule_observation();
        let stable_generation = tracker.schedule_observation();
        assert_eq!(
            tracker.observe_stable(intermediate_generation, false, intermediate_bounds),
            None
        );
        assert_eq!(tracker.last_normal_bounds, normal_bounds);
        assert_eq!(
            tracker.observe_stable(stable_generation, true, intermediate_bounds),
            None
        );
        assert_eq!(tracker.last_normal_bounds, normal_bounds);
    }
}
