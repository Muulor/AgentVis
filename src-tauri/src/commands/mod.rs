//! Tauri Commands 模块
//!
//! 这里定义所有从前端调用的 Tauri 命令。

pub mod agent;
pub mod cloud_embedding;
pub mod command_validator;
pub mod cron;
pub mod data_management;
pub mod diff_record;
pub mod document_parser;
pub mod embedded_node_setup;
pub mod embedded_python_setup;
pub mod feishu;
pub mod file;
pub mod hub;
pub mod llm;
pub mod memory;
pub mod memory_trigger;
pub mod message;
pub mod network_broker;
pub mod preview_staging;
pub mod process_sandbox;
pub mod rag;
pub mod renderer_health;
pub mod search;
pub mod security_settings;
pub mod settings;
pub mod shell;
pub mod skill_install;
pub mod skills_bootstrap;
pub mod slack;
pub mod snapshot;
pub mod text_preview;
pub mod trash_bin;
pub mod web_search;
pub mod workspace_import;

use serde::Serialize;

// 重新导出所有命令
pub use agent::*;
pub use cloud_embedding::*;
pub use cron::*;
pub use data_management::*;
pub use diff_record::*;
pub use document_parser::*;
pub use embedded_node_setup::*;
pub use embedded_python_setup::*;
pub use feishu::*;
pub use file::*;
pub use hub::*;
pub use llm::*;
pub use memory::*;
pub use memory_trigger::*;
pub use message::*;
pub use network_broker::*;
pub use preview_staging::*;
pub use rag::*;
pub use renderer_health::*;
pub use search::*;
pub use security_settings::*;
pub use settings::*;
pub use shell::*;
pub use skill_install::*;
pub use skills_bootstrap::*;
pub use slack::*;
pub use snapshot::*;
pub use text_preview::*;
pub use trash_bin::*;
pub use web_search::*;
pub use workspace_import::*;

/// 应用信息结构
#[derive(Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub tauri_version: String,
}

/// 测试用的 greet 命令
///
/// 用于验证前端与 Rust 后端的 IPC 通信是否正常工作。
#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! Greetings from the AgentVis Rust backend.", name)
}

/// 获取应用信息命令
///
/// 返回应用名称、版本和 Tauri 版本，用于验证 IPC 通信。
#[tauri::command]
pub fn get_app_info() -> AppInfo {
    AppInfo {
        name: "AgentVis".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        tauri_version: "2.x".to_string(),
    }
}
