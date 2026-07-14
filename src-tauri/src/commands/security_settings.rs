//! 安全设置相关 Tauri Commands
//!
//! 提供 Trash Bin 路径查询和用户自定义保护路径管理命令。
//! 保护路径用于 `command_validator` 中的破坏性命令组合阻断。

use crate::commands::command_validator;
use crate::error::CommandResult;
use tauri::Manager;

/// Trash Bin 目录名（与 trash_bin.rs 保持一致）
const TRASH_BIN_DIR: &str = "Agent_Trash_Bin";

/// 获取 Trash Bin 目录路径
///
/// 返回 `{app_data_dir}/Agent_Trash_Bin` 的完整路径。
/// 如果目录尚不存在，自动创建以确保用户可打开。
#[tauri::command]
pub async fn get_trash_bin_path(app_handle: tauri::AppHandle) -> CommandResult<String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    let trash_dir = app_data_dir.join(TRASH_BIN_DIR);

    // 确保目录存在，方便用户通过资源管理器打开
    if !trash_dir.exists() {
        std::fs::create_dir_all(&trash_dir).ok();
    }

    Ok(trash_dir.to_string_lossy().to_string())
}

/// 获取用户自定义保护路径列表
///
/// 从 `{app_data_dir}/protected_paths.json` 读取。
/// 文件不存在时返回空数组。
#[tauri::command]
pub async fn get_protected_paths(app_handle: tauri::AppHandle) -> CommandResult<Vec<String>> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    let paths = command_validator::read_protected_paths_from_disk(&app_data_dir);
    Ok(paths)
}

/// 设置用户自定义保护路径列表
///
/// 将 paths 写入 `{app_data_dir}/protected_paths.json` 并刷新内存缓存，
/// 使后续 `validate_command_safety` 立即使用最新路径列表。
#[tauri::command]
pub async fn set_protected_paths(
    app_handle: tauri::AppHandle,
    paths: Vec<String>,
) -> CommandResult<()> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    let config_path = app_data_dir.join("protected_paths.json");

    // 序列化并写入文件
    let content = serde_json::to_string_pretty(&paths).map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to serialize protected paths: {}", e))
    })?;

    std::fs::write(&config_path, content).map_err(|e| {
        crate::error::AppError::FileSystem(format!("Failed to write protected paths: {}", e))
    })?;

    // 刷新内存缓存，使 validate_command_safety 即时生效
    command_validator::reload_custom_protected_paths(&app_data_dir);

    log::info!("[SecuritySettings] 保护路径已更新: {} 条", paths.len());

    Ok(())
}
