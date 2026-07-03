//! Tauri Commands 模块
//!
//! 这里定义所有从前端调用的 Tauri 命令。

pub mod hub;
pub mod agent;
pub mod settings;
pub mod llm;
pub mod cloud_embedding;
pub mod rag;
pub mod memory;
pub mod snapshot;
pub mod message;
pub mod file;
pub mod web_search;
pub mod document_parser;
pub mod diff_record;
pub mod memory_trigger;
pub mod data_management;
pub mod shell;
pub mod command_validator;
pub mod network_broker;
pub mod process_sandbox;
pub mod trash_bin;
pub mod skill_install;
pub mod security_settings;
pub mod cron;
pub mod search;
pub mod feishu;
pub mod slack;
pub mod skills_bootstrap;
pub mod embedded_python_setup;
pub mod embedded_node_setup;
pub mod renderer_health;

use serde::Serialize;

// 重新导出所有命令
pub use hub::*;
pub use agent::*;
pub use settings::*;
pub use llm::*;
pub use cloud_embedding::*;
pub use rag::*;
pub use memory::*;
pub use snapshot::*;
pub use message::*;
pub use file::*;
pub use web_search::*;
pub use document_parser::*;
pub use diff_record::*;
pub use memory_trigger::*;
pub use network_broker::*;
pub use data_management::*;
pub use shell::*;
pub use trash_bin::*;
pub use skill_install::*;
pub use security_settings::*;
pub use cron::*;
pub use search::*;
pub use feishu::*;
pub use slack::*;
pub use skills_bootstrap::*;
pub use embedded_python_setup::*;
pub use embedded_node_setup::*;
pub use renderer_health::*;

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
