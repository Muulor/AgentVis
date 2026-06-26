//! AgentVis 库模块
//!
//! 这是 Tauri 应用的核心库，包含所有模块定义和应用初始化逻辑。

pub mod commands;
pub mod crypto;
pub mod db;
pub mod error;
pub mod llm;
pub(crate) mod text_utils;

use std::sync::Arc;
use std::path::Path;
use tokio::sync::Mutex;
use tauri::{Manager, Emitter};

use commands::{
    greet, get_app_info,
    // Hub commands
    hub_create, hub_list, hub_get, hub_update, hub_reorder, hub_delete,
    // Agent commands
    agent_create, agent_list_by_hub, agent_get, agent_update, agent_reorder, agent_delete,
    // Settings commands
    settings_get_api_key_status, settings_set_api_key, settings_delete_api_key, settings_test_api_key,
    set_image_generation_api_key, get_image_generation_api_key_status,
    set_github_token, get_github_token_status, test_github_token,
    set_context7_api_key, get_context7_api_key_status, test_context7_api_key,
    // IM Channel commands
    im_save_credentials, im_get_credentials,
    im_save_bot_credentials, im_get_bot_credentials, im_delete_bot_credentials,
    // Feishu API proxy commands
    feishu_get_token, feishu_send_message, feishu_update_message, feishu_delete_message, feishu_http_proxy,
    feishu_upload_image, feishu_upload_file, feishu_download_resource, feishu_save_attachment,
    feishu_write_app_data_file,
    feishu_delete_app_data_file,
    // Slack API proxy and generic IM file commands
    slack_open_socket_connection, slack_auth_test, slack_post_message, slack_update_message,
    slack_delete_message, slack_delete_file,
    slack_upload_file_external, slack_download_file, im_save_attachment, im_write_app_data_file,
    im_delete_app_data_file,
    // LLM commands
    llm_chat, llm_chat_stream, llm_cancel_stream, llm_list_providers, llm_list_models, llm_chat_with_tools,
    gpt_image_generate, minimax_image_generate, zhipu_image_generate,
    // Cloud Embedding commands
    cloud_embedding_encode, cloud_embedding_list_providers, cloud_embedding_list_models,
    cloud_rerank_documents,
    set_siliconflow_api_key, get_siliconflow_api_key_status,
    set_giteeai_api_key, get_giteeai_api_key_status,
    // RAG commands
    rag_index_chunk, rag_search, rag_delete_by_agent, rag_delete_by_document, rag_get_status, rag_list_document_ids,
    rag_list_chunks,
    // Memory commands
    memory_create, memory_list_by_layer, memory_list_facts, memory_update, memory_delete, memory_get_stats,
    memory_delete_by_source_ids, memory_get_context, memory_delete_summary_with_vector, memory_delete_fact_with_vector, memory_clear_short_term,
    // Memory Candidate commands
    memory_candidate_create, memory_candidate_list, memory_candidate_update, memory_candidate_delete, memory_candidate_delete_batch,
    // Snapshot commands
    snapshot_create, snapshot_get, snapshot_list, snapshot_get_latest, snapshot_rollback, snapshot_delete, snapshot_cleanup, snapshot_count,
    // Message commands
    message_create, message_list_by_agent, message_list_by_hub, message_get_recent, message_get_batch, message_get_after, message_get_before, message_count_by_agent, message_get_recent_hub, message_get_before_hub, message_count_by_hub, message_delete, message_retract_from, message_clear_by_agent,
    // File commands
    file_write_deliverable, file_read_content, file_list_deliverables, file_delete, save_clipboard_image, save_dropped_file,
    file_write_to_path, file_write_staged_tool_arg_to_path, file_create_backup, file_read_as_base64, file_read_image_downscaled_as_base64, file_copy_to_attachments, file_get_size, file_open_system,
    file_reveal_in_explorer, file_list_directory, file_list_project_directory, file_import_to_workspace,
    // Backup Management commands
    backup_get_stats, backup_clean,
    // Web Search commands
    web_search, set_tavily_api_key, get_tavily_api_key_status,
    network_broker_http_request,
    // Document Parser commands
    parse_docx, parse_xlsx, parse_pdf, parse_txt, parse_md, parse_pptx,
    // Diff Record commands (持久化 Diff 记录)
    diff_record_create, diff_record_get_by_message, diff_record_get_pending,
    diff_record_update_status, diff_record_revert_by_message, diff_record_update_active_snapshot,
    diff_record_update_message_id, diff_record_update_modification_statuses,
    // Memory Trigger commands (混合触发模型)
    memory_trigger_get, memory_trigger_get_or_create, memory_trigger_update,
    memory_trigger_increment_turn, memory_trigger_accumulate_score, memory_trigger_reset,
    memory_trigger_update_last_message,
    // Data Management commands (数据管理)
    data_get_stats, data_clear_vectors, data_reset_all, data_export, data_import,
    // Shell commands
    shell_execute, shell_cancel, shell_kill, sandbox_audit_events, sandbox_network_direct_targets,
    sandbox_network_direct_target_risks, check_elevated_privileges, startup_trash_cleanup,
    // Skill Install commands
    skill_install_from_github,
    // Skills Bootstrap commands
    bootstrap_skills_if_needed,
    // Embedded Python commands
    prepare_embedded_runtime, prepare_prebuilt_python_runtime,
    // Embedded Node.js commands
    prepare_embedded_node,
    // Renderer health diagnostics
    renderer_health_heartbeat,
    // Security Settings commands
    get_trash_bin_path, get_protected_paths, set_protected_paths,
    // Cron commands (定时任务)
    cron_create, cron_list_by_agent, cron_list_all_enabled, cron_update, cron_delete,
    // Code Search commands (代码搜索)
    code_grep, code_find, code_outline, code_symbol,
};
use commands::shell::BackgroundProcessRegistry;
use db::Database;

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
            .map(|location| format!("{}:{}:{}", location.file(), location.line(), location.column()))
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
        .setup(|app| {
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

            // 自适应窗口尺寸策略：
            //   大屏（逻辑宽≥1600 且 逻辑高≥900）→ 以 1600×900 居中启动
            //   小屏（任意一边不足）→ 最大化启动，保留任务栏和标题栏，确保小屏最佳呈现
            if let Some(window) = app.get_webview_window("main") {
                match window.primary_monitor() {
                    Ok(Some(monitor)) => {
                        let physical_size = monitor.size();
                        let scale_factor = monitor.scale_factor();
                        // 将物理像素转换为逻辑像素，与 tauri 逻辑尺寸单位统一
                        let logical_width  = physical_size.width  as f64 / scale_factor;
                        let logical_height = physical_size.height as f64 / scale_factor;

                        const TARGET_WIDTH:  f64 = 1600.0;
                        const TARGET_HEIGHT: f64 = 900.0;

                        log::trace!(
                            "Detected primary monitor logical resolution {:.0}x{:.0} (physical {}x{}, scale {:.2})",
                            logical_width, logical_height,
                            physical_size.width, physical_size.height, scale_factor
                        );

                        // 屏幕任意一边小于目标尺寸时，最大化显示以获得最佳小屏体验
                        if logical_width < TARGET_WIDTH || logical_height < TARGET_HEIGHT {
                            log::trace!("屏幕尺寸不足 {TARGET_WIDTH}×{TARGET_HEIGHT}，自动最大化窗口");
                            if let Err(e) = window.maximize() {
                                log::warn!("窗口最大化失败: {}", e);
                            }
                        } else {
                            // 大屏：固定 1600×900 居中启动
                            if let Err(e) = window.set_size(tauri::LogicalSize::new(TARGET_WIDTH, TARGET_HEIGHT)) {
                                log::warn!("设置窗口尺寸失败: {}", e);
                            }
                            if let Err(e) = window.center() {
                                log::warn!("窗口居中失败: {}", e);
                            }
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
            }

            // 拦截窗口关闭事件：阻止默认行为，交由前端判断是否有 Agent 任务进行中
            // 前端收到 close-requested 后检测 chatStore.sendingContexts，
            // 无任务则直接调用 window.close()，有任务则弹出确认弹窗让用户决定
            if let Some(window) = app.get_webview_window("main") {
                let win = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Err(e) = win.emit("close-requested", ()) {
                            log::error!("发送 close-requested 事件失败: {}", e);
                        }
                    }
                });
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
            message_list_by_agent,
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
            file_list_deliverables,
            file_delete,
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
