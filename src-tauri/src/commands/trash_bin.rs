//! Agent Trash Bin — 删除命令拦截与软删除
//!
//! 将 Agent 的删除操作重写为"移动到回收站"，实现可恢复的删除。
//!
//! 设计原则：
//! - 拦截 del/rmdir/erase/Remove-Item 格式
//! - 复杂命令（通配符、管道链等）回退正常执行流程
//! - 30 天自动清理过期条目
//! - manifest.json 记录完整删除元数据，支持手动恢复

use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use tauri::Manager;

use crate::error::{AppError, CommandResult};

// fs2 用于文件排他锁，保证 manifest 并发写入安全
use fs2::FileExt;

// ==================== 常量 ====================

/// Trash Bin 目录名
const TRASH_BIN_DIR: &str = "Agent_Trash_Bin";

/// Manifest 文件名
const MANIFEST_FILE: &str = "trash_manifest.json";

/// 默认保留天数
const DEFAULT_RETENTION_DAYS: u64 = 30;
const DELETE_SUCCESS_OBSERVATION: &str = "Deleted successfully.";
const DELETE_UNSAFE_BLOCK_MESSAGE: &str =
    "Safety block: delete-like command could not be safely moved to Agent Trash Bin. Use a direct supported delete command with explicit paths, such as Remove-Item, del, or rmdir.";
const SANDBOX_DELETE_BLOCK_MESSAGE: &str =
    "Sandbox block: delete target is outside the OfflineIsolated sandbox filesystem scope.";

// ==================== 类型定义 ====================

/// Trash Bin 条目
///
/// 记录每次删除操作的完整元数据，支持手动恢复。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TrashEntry {
    /// 唯一标识（时间戳 + 随机后缀）
    id: String,
    /// 原始文件/目录路径
    original_path: String,
    /// 在回收站中的路径
    trash_path: String,
    /// 删除时间（ISO 8601）
    deleted_at: String,
    /// 原始命令
    command: String,
    /// 同一次删除命令对应的批次 ID
    #[serde(default, skip_serializing_if = "Option::is_none")]
    batch_id: Option<String>,
    /// 是否为目录
    is_directory: bool,
}

/// Trash Bin 条目列表项
///
/// 提供给设置页「文件保护」Tab 展示最近可恢复删除记录。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntryInfo {
    pub id: String,
    pub original_path: String,
    pub trash_path: String,
    pub deleted_at: String,
    pub command: String,
    pub batch_id: String,
    pub is_directory: bool,
    pub original_exists: bool,
    pub trash_exists: bool,
}

/// Trash Bin 恢复问题
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrashRestoreIssue {
    pub id: String,
    pub original_path: String,
    pub trash_path: String,
    pub reason: String,
}

/// Trash Bin 恢复结果
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrashRestoreResult {
    pub restored_count: usize,
    pub restored: Vec<String>,
    pub conflicts: Vec<TrashRestoreIssue>,
    pub missing: Vec<TrashRestoreIssue>,
}

/// Trash Bin 永久清理结果
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrashDeleteResult {
    pub deleted_count: usize,
    pub deleted: Vec<String>,
    pub missing: Vec<TrashRestoreIssue>,
    pub failed: Vec<TrashRestoreIssue>,
}

// ==================== 路径辅助函数 ====================

/// 获取 Trash Bin 根目录
fn get_trash_bin_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(TRASH_BIN_DIR)
}

/// 获取 manifest 文件路径
fn get_manifest_path(app_data_dir: &Path) -> PathBuf {
    get_trash_bin_dir(app_data_dir).join(MANIFEST_FILE)
}

/// 将原始路径编码为安全的文件名
///
/// 替换路径分隔符和特殊字符，使其可作为文件名使用
fn encode_path_for_filename(path: &str) -> String {
    let encoded = path
        .replace('\\', "_")
        .replace('/', "_")
        .replace(':', "_")
        .replace(' ', "_");
    // 合并连续下划线（例如 C:\ → C_ 而非 C__）
    let mut result = String::with_capacity(encoded.len());
    let mut prev_underscore = false;
    for ch in encoded.chars() {
        if ch == '_' {
            if !prev_underscore {
                result.push('_');
            }
            prev_underscore = true;
        } else {
            result.push(ch);
            prev_underscore = false;
        }
    }
    result
}

/// 生成回收站中的目标路径
///
/// 格式: {trash_bin}/{timestamp}_{encoded_original_path}
fn generate_trash_path(app_data_dir: &Path, original_path: &str) -> PathBuf {
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let encoded = encode_path_for_filename(original_path);

    // 截断过长的路径（Windows 路径限制 260 字符）
    let max_name_len = 200;
    let name = if encoded.len() > max_name_len {
        format!("{}_{}", timestamp, &encoded[..max_name_len])
    } else {
        format!("{}_{}", timestamp, encoded)
    };

    get_trash_bin_dir(app_data_dir).join(name)
}

fn generate_batch_id() -> String {
    format!(
        "{}_{}",
        chrono::Local::now().format("%Y%m%d%H%M%S"),
        uuid::Uuid::new_v4()
            .to_string()
            .split('-')
            .next()
            .unwrap_or("0000")
    )
}

fn app_data_dir_from_handle(app_handle: &tauri::AppHandle) -> PathBuf {
    app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

fn trash_entry_info(entry: &TrashEntry) -> TrashEntryInfo {
    let original_path = Path::new(&entry.original_path);
    let trash_path = Path::new(&entry.trash_path);

    TrashEntryInfo {
        id: entry.id.clone(),
        original_path: entry.original_path.clone(),
        trash_path: entry.trash_path.clone(),
        deleted_at: entry.deleted_at.clone(),
        command: entry.command.clone(),
        batch_id: entry.batch_id.clone().unwrap_or_else(|| entry.id.clone()),
        is_directory: entry.is_directory,
        original_exists: original_path.exists(),
        trash_exists: trash_path.exists(),
    }
}

// ==================== Manifest 管理 ====================

/// 读取 manifest
fn read_manifest(app_data_dir: &Path) -> Vec<TrashEntry> {
    let path = get_manifest_path(app_data_dir);
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|e| {
            log::warn!("[TrashBin] manifest 解析失败: {}", e);
            Vec::new()
        }),
        Err(_) => Vec::new(),
    }
}

/// 写入 manifest
fn write_manifest(app_data_dir: &Path, entries: &[TrashEntry]) -> Result<(), AppError> {
    let path = get_manifest_path(app_data_dir);
    let content = serde_json::to_string_pretty(entries)
        .map_err(|e| AppError::Generic(format!("Failed to serialize manifest: {}", e)))?;
    std::fs::write(&path, content)
        .map_err(|e| AppError::FileSystem(format!("Failed to write manifest: {}", e)))?;
    Ok(())
}

/// 以排他锁方式追加一条记录到 manifest
///
/// 使用文件排他锁（fs2::FileExt）保证并发安全：
/// 多个 shell_execute 同时触发删除拦截时，不会丢失 manifest 数据。
///
/// 关键：Windows 排他锁阻止同进程的其他句柄访问同一文件，
/// 因此必须通过**同一个 file 句柄**进行读写，不能用 std::fs::read_to_string / std::fs::write。
fn append_to_manifest(app_data_dir: &Path, entry: TrashEntry) -> Result<(), AppError> {
    use std::io::{Read, Seek, Write};

    let manifest_path = get_manifest_path(app_data_dir);

    // 确保 manifest 所在目录存在
    if let Some(parent) = manifest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            AppError::FileSystem(format!("Failed to create Trash Bin directory: {}", e))
        })?;
    }

    // 打开或创建 manifest 文件
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&manifest_path)
        .map_err(|e| AppError::FileSystem(format!("Failed to open manifest: {}", e)))?;

    // 获取排他锁（阻塞等待其他进程/线程释放）
    file.lock_exclusive().map_err(|e| {
        AppError::FileSystem(format!("Failed to acquire exclusive manifest lock: {}", e))
    })?;

    // 通过同一句柄读取现有数据（不能用 std::fs::read_to_string，会另开句柄触发 os error 33）
    let mut content = String::new();
    file.read_to_string(&mut content).unwrap_or_default();

    let mut entries: Vec<TrashEntry> = if content.trim().is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(&content).unwrap_or_else(|e| {
            log::warn!("[TrashBin] manifest 解析失败: {}", e);
            Vec::new()
        })
    };

    // 追加新条目
    entries.push(entry);
    let new_content = serde_json::to_string_pretty(&entries)
        .map_err(|e| AppError::Generic(format!("Failed to serialize manifest: {}", e)))?;

    // 通过同一句柄写回：先回到文件头，截断，再写入
    file.seek(std::io::SeekFrom::Start(0))
        .map_err(|e| AppError::FileSystem(format!("Failed to seek manifest: {}", e)))?;
    file.set_len(0)
        .map_err(|e| AppError::FileSystem(format!("Failed to truncate manifest: {}", e)))?;
    file.write_all(new_content.as_bytes())
        .map_err(|e| AppError::FileSystem(format!("Failed to write manifest: {}", e)))?;
    file.flush()
        .map_err(|e| AppError::FileSystem(format!("Failed to flush manifest: {}", e)))?;

    // 锁在 file drop 时自动释放
    Ok(())
}

fn with_locked_manifest<R, F>(app_data_dir: &Path, mutate: F) -> Result<R, AppError>
where
    F: FnOnce(&mut Vec<TrashEntry>) -> Result<R, AppError>,
{
    use std::io::{Read, Seek, Write};

    let manifest_path = get_manifest_path(app_data_dir);
    if let Some(parent) = manifest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            AppError::FileSystem(format!("Failed to create Trash Bin directory: {}", e))
        })?;
    }

    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&manifest_path)
        .map_err(|e| AppError::FileSystem(format!("Failed to open manifest: {}", e)))?;

    file.lock_exclusive().map_err(|e| {
        AppError::FileSystem(format!("Failed to acquire exclusive manifest lock: {}", e))
    })?;

    let mut content = String::new();
    file.read_to_string(&mut content).unwrap_or_default();

    let mut entries: Vec<TrashEntry> = if content.trim().is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(&content).unwrap_or_else(|e| {
            log::warn!("[TrashBin] manifest 解析失败: {}", e);
            Vec::new()
        })
    };

    let result = mutate(&mut entries)?;

    let new_content = serde_json::to_string_pretty(&entries)
        .map_err(|e| AppError::Generic(format!("Failed to serialize manifest: {}", e)))?;
    file.seek(std::io::SeekFrom::Start(0))
        .map_err(|e| AppError::FileSystem(format!("Failed to seek manifest: {}", e)))?;
    file.set_len(0)
        .map_err(|e| AppError::FileSystem(format!("Failed to truncate manifest: {}", e)))?;
    file.write_all(new_content.as_bytes())
        .map_err(|e| AppError::FileSystem(format!("Failed to write manifest: {}", e)))?;
    file.flush()
        .map_err(|e| AppError::FileSystem(format!("Failed to flush manifest: {}", e)))?;

    Ok(result)
}

fn restore_issue(entry: &TrashEntry, reason: impl Into<String>) -> TrashRestoreIssue {
    TrashRestoreIssue {
        id: entry.id.clone(),
        original_path: entry.original_path.clone(),
        trash_path: entry.trash_path.clone(),
        reason: reason.into(),
    }
}

fn restore_from_trash(source: &Path, destination: &Path) -> Result<(), AppError> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            AppError::FileSystem(format!("Failed to create restore parent directory: {}", e))
        })?;
    }

    if std::fs::rename(source, destination).is_ok() {
        return Ok(());
    }

    if source.is_dir() {
        copy_dir_recursive(source, destination)?;
        std::fs::remove_dir_all(source).map_err(|e| {
            AppError::FileSystem(format!(
                "Failed to remove restored Trash Bin directory: {}",
                e
            ))
        })?;
    } else {
        std::fs::copy(source, destination)
            .map_err(|e| AppError::FileSystem(format!("Failed to restore file: {}", e)))?;
        std::fs::remove_file(source).map_err(|e| {
            AppError::FileSystem(format!("Failed to remove restored Trash Bin file: {}", e))
        })?;
    }

    Ok(())
}

fn restore_entries_matching<F>(
    app_data_dir: &Path,
    predicate: F,
) -> Result<TrashRestoreResult, AppError>
where
    F: Fn(&TrashEntry) -> bool,
{
    with_locked_manifest(app_data_dir, |entries| {
        let mut result = TrashRestoreResult {
            restored_count: 0,
            restored: Vec::new(),
            conflicts: Vec::new(),
            missing: Vec::new(),
        };
        let mut completed_ids = std::collections::HashSet::new();

        for entry in entries.iter() {
            if !predicate(entry) {
                continue;
            }

            let trash_path = Path::new(&entry.trash_path);
            let original_path = Path::new(&entry.original_path);

            if !trash_path.exists() {
                result.missing.push(restore_issue(entry, "trash_missing"));
                completed_ids.insert(entry.id.clone());
                continue;
            }

            if original_path.exists() {
                result
                    .conflicts
                    .push(restore_issue(entry, "original_exists"));
                continue;
            }

            match restore_from_trash(trash_path, original_path) {
                Ok(()) => {
                    result.restored_count += 1;
                    result.restored.push(entry.original_path.clone());
                    completed_ids.insert(entry.id.clone());
                }
                Err(error) => {
                    result
                        .conflicts
                        .push(restore_issue(entry, format!("restore_failed: {}", error)));
                }
            }
        }

        if !completed_ids.is_empty() {
            entries.retain(|entry| !completed_ids.contains(&entry.id));
        }

        Ok(result)
    })
}

fn delete_trash_path(app_data_dir: &Path, entry: &TrashEntry) -> Result<(), AppError> {
    let trash_path = Path::new(&entry.trash_path);
    let trash_root = normalize_path_lexically(&get_trash_bin_dir(app_data_dir));
    let normalized_trash_path = normalize_path_lexically(trash_path);
    if !normalized_trash_path.starts_with(&trash_root) {
        return Err(AppError::Forbidden(
            "Trash Bin clean rejected a path outside Agent_Trash_Bin.".to_string(),
        ));
    }

    if !trash_path.exists() {
        return Ok(());
    }

    if trash_path.is_dir() {
        std::fs::remove_dir_all(trash_path).map_err(|e| {
            AppError::FileSystem(format!("Failed to delete Trash Bin directory: {}", e))
        })?;
    } else {
        std::fs::remove_file(trash_path)
            .map_err(|e| AppError::FileSystem(format!("Failed to delete Trash Bin file: {}", e)))?;
    }

    Ok(())
}

fn delete_entries_matching<F>(
    app_data_dir: &Path,
    predicate: F,
) -> Result<TrashDeleteResult, AppError>
where
    F: Fn(&TrashEntry) -> bool,
{
    with_locked_manifest(app_data_dir, |entries| {
        let mut result = TrashDeleteResult {
            deleted_count: 0,
            deleted: Vec::new(),
            missing: Vec::new(),
            failed: Vec::new(),
        };
        let mut completed_ids = std::collections::HashSet::new();

        for entry in entries.iter() {
            if !predicate(entry) {
                continue;
            }

            let trash_path = Path::new(&entry.trash_path);
            if !trash_path.exists() {
                result.missing.push(restore_issue(entry, "trash_missing"));
                completed_ids.insert(entry.id.clone());
                continue;
            }

            match delete_trash_path(app_data_dir, entry) {
                Ok(()) => {
                    result.deleted_count += 1;
                    result.deleted.push(entry.original_path.clone());
                    completed_ids.insert(entry.id.clone());
                }
                Err(error) => {
                    result
                        .failed
                        .push(restore_issue(entry, format!("delete_failed: {}", error)));
                }
            }
        }

        if !completed_ids.is_empty() {
            entries.retain(|entry| !completed_ids.contains(&entry.id));
        }

        Ok(result)
    })
}

/// 列出当前可追踪的 Agent Trash Bin 条目
#[tauri::command]
pub async fn trash_bin_list_entries(
    app_handle: tauri::AppHandle,
) -> CommandResult<Vec<TrashEntryInfo>> {
    let app_data_dir = app_data_dir_from_handle(&app_handle);
    let trash_dir = get_trash_bin_dir(&app_data_dir);
    if !trash_dir.exists() {
        std::fs::create_dir_all(&trash_dir).map_err(|e| {
            AppError::FileSystem(format!("Failed to create Trash Bin directory: {}", e))
        })?;
    }

    let mut entries: Vec<TrashEntryInfo> = read_manifest(&app_data_dir)
        .iter()
        .map(trash_entry_info)
        .collect();
    entries.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(entries)
}

/// 按条目 ID 恢复 Trash Bin 文件，并同步更新 manifest
#[tauri::command]
pub async fn trash_bin_restore_entries(
    app_handle: tauri::AppHandle,
    ids: Vec<String>,
) -> CommandResult<TrashRestoreResult> {
    let app_data_dir = app_data_dir_from_handle(&app_handle);
    let id_set: std::collections::HashSet<String> = ids.into_iter().collect();

    restore_entries_matching(&app_data_dir, |entry| id_set.contains(&entry.id))
}

/// 按批次恢复同一次删除命令产生的 Trash Bin 条目
#[tauri::command]
pub async fn trash_bin_restore_batch(
    app_handle: tauri::AppHandle,
    batch_id: String,
) -> CommandResult<TrashRestoreResult> {
    let app_data_dir = app_data_dir_from_handle(&app_handle);

    restore_entries_matching(&app_data_dir, |entry| {
        entry.batch_id.as_deref().unwrap_or(&entry.id) == batch_id
    })
}

/// 按条目 ID 永久清理 Trash Bin 文件，并同步更新 manifest
#[tauri::command]
pub async fn trash_bin_delete_entries(
    app_handle: tauri::AppHandle,
    ids: Vec<String>,
) -> CommandResult<TrashDeleteResult> {
    let app_data_dir = app_data_dir_from_handle(&app_handle);
    let id_set: std::collections::HashSet<String> = ids.into_iter().collect();

    delete_entries_matching(&app_data_dir, |entry| id_set.contains(&entry.id))
}

/// 按批次永久清理同一次删除命令产生的 Trash Bin 条目
#[tauri::command]
pub async fn trash_bin_delete_batch(
    app_handle: tauri::AppHandle,
    batch_id: String,
) -> CommandResult<TrashDeleteResult> {
    let app_data_dir = app_data_dir_from_handle(&app_handle);

    delete_entries_matching(&app_data_dir, |entry| {
        entry.batch_id.as_deref().unwrap_or(&entry.id) == batch_id
    })
}

// ==================== 命令解析 ====================

/// 从删除命令中提取目标路径
///
/// 支持的格式:
/// - `del filepath` / `del /f /q filepath` / `del file1.txt file2.txt`
/// - `erase filepath`
/// - `rmdir /s /q dirpath` / `rd /s /q dirpath`
/// - `powershell -Command "Remove-Item 'path'"` (多种引号形式)
/// - `powershell -Command "ri 'path'"` / `rm 'path'` (PS 别名)
/// - `cmd /c "del filepath"` (嵌套命令)
/// - `Get-ChildItem *.log | Remove-Item` (管道删除)
///
/// 返回 None 表示无法解析（复杂格式），应回退正常执行
#[cfg(test)]
fn extract_delete_target(command: &str) -> Option<(String, bool)> {
    extract_delete_target_with_workdir(command, None)
}

fn extract_delete_target_with_workdir(
    command: &str,
    workdir: Option<&Path>,
) -> Option<(String, bool)> {
    let trimmed = command.trim();
    let lower = trimmed.to_lowercase();

    // PowerShell Remove-Item 及其别名（ri/rm）优先匹配（在链式检查之前）
    // 原因：PowerShell -Command 内的 ; 是 PS 语句分隔符，不应被视为 CMD 管道链
    if contains_powershell_delete_command(&lower) {
        return extract_powershell_remove_item_target(trimmed, workdir);
    }

    // 管道删除模式：Get-ChildItem *.ext | Remove-Item
    // 提取管道前 Get-ChildItem 的路径/模式，作为 glob 展开目标
    if let Some(result) = extract_pipe_delete_target(&lower, trimmed) {
        return Some(result);
    }

    // cmd /c 嵌套：提取内部命令并递归解析
    if let Some(inner) = extract_cmd_c_inner(&lower, trimmed) {
        return extract_delete_target_with_workdir(&inner, workdir);
    }

    // CMD 命令的链式操作符检查（&&, ||, |, ;）
    // 仅对 del/rmdir/erase 等 CMD 命令应用
    if trimmed.contains("&&")
        || trimmed.contains("||")
        || trimmed.contains('|')
        || trimmed.contains(';')
    {
        return None;
    }

    // 尝试匹配 del / erase 命令
    if lower.starts_with("del ") || lower.starts_with("erase ") {
        let target = extract_path_after_flags(trimmed);
        return target.map(|t| (t, false));
    }

    // 尝试匹配 rmdir / rd 命令
    if lower.starts_with("rmdir ") || lower.starts_with("rd ") {
        let target = extract_path_after_flags(trimmed);
        return target.map(|t| (t, true));
    }

    None
}

/// 从 CMD del/erase 命令中提取多个目标路径。
///
/// CMD 原生支持 `del /f "a.png" "b.png"`，但单目标解析只会拿到第一个
/// 引号参数。删除拦截器一旦返回成功，原始 del 命令就不会再执行，因此这里
/// 需要完整提取所有目标，避免后续文件被静默跳过。
fn extract_cmd_delete_targets(command: &str) -> Option<(Vec<String>, bool)> {
    let trimmed = command.trim();
    let lower = trimmed.to_lowercase();

    if !(lower.starts_with("del ") || lower.starts_with("erase ")) {
        return None;
    }

    if trimmed.contains("&&")
        || trimmed.contains("||")
        || trimmed.contains('|')
        || trimmed.contains(';')
    {
        return None;
    }

    let after_cmd = trimmed.split_once(char::is_whitespace)?.1.trim();
    let mut remaining = after_cmd;
    loop {
        remaining = remaining.trim_start();
        if remaining.starts_with('/') || remaining.starts_with('-') {
            remaining = match remaining.split_once(char::is_whitespace) {
                Some((_, rest)) => rest,
                None => return None,
            };
        } else {
            break;
        }
    }

    let targets = split_shell_like_paths(remaining);
    if targets.is_empty() {
        return None;
    }

    Some((targets, false))
}

fn split_shell_like_paths(input: &str) -> Vec<String> {
    let mut targets = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;

    for ch in input.chars() {
        match quote {
            Some(q) if ch == q => {
                quote = None;
            }
            Some(_) => {
                current.push(ch);
            }
            None if ch == '"' || ch == '\'' => {
                quote = Some(ch);
            }
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    targets.push(std::mem::take(&mut current));
                }
            }
            None => {
                current.push(ch);
            }
        }
    }

    if !current.is_empty() {
        targets.push(current);
    }

    targets
}

/// 检测是否包含 PowerShell 删除别名（ri / rm）
///
/// Agent 偶尔使用 PS 内置别名而非全名。
/// 仅在 powershell -Command 上下文中匹配，避免误判 Unix 的 rm 命令。
fn contains_powershell_delete_command(lower: &str) -> bool {
    if !(lower.contains("powershell") || lower.contains("pwsh")) {
        return false;
    }

    find_ps_delete_command(lower).is_some()
}

/// 提取管道删除目标：`Get-ChildItem *.ext | Remove-Item`
///
/// 将管道前的 Get-ChildItem/gci/ls 的路径参数作为 glob 模式返回。
fn extract_pipe_delete_target(lower: &str, original: &str) -> Option<(String, bool)> {
    // 必须包含管道 + 删除命令
    if !original.contains('|') {
        return None;
    }

    // 检测管道后是否有删除命令
    let pipe_pos = original.find('|')?;
    let after_pipe = lower[pipe_pos + 1..].trim();
    let has_delete_after_pipe = after_pipe.starts_with("remove-item")
        || after_pipe.starts_with("ri ")
        || after_pipe.starts_with("ri'")
        || after_pipe.starts_with("rm ")
        || after_pipe.starts_with("rm'")
        || after_pipe == "ri"
        || after_pipe == "rm"
        || after_pipe.starts_with("del ")
        || after_pipe == "del"
        || after_pipe.starts_with("erase ")
        || after_pipe == "erase"
        || after_pipe.starts_with("rd ")
        || after_pipe == "rd"
        || after_pipe.starts_with("rmdir ")
        || after_pipe == "rmdir";

    if !has_delete_after_pipe {
        return None;
    }

    // 提取管道前的路径/模式
    let before_pipe = original[..pipe_pos].trim();
    let before_lower = before_pipe.to_lowercase();

    // Get-ChildItem / gci / ls + 路径
    let path_part = if before_lower.starts_with("get-childitem") {
        &before_pipe["get-childitem".len()..]
    } else if before_lower.starts_with("gci") {
        &before_pipe["gci".len()..]
    } else if before_lower.starts_with("ls") {
        &before_pipe["ls".len()..]
    } else {
        return None;
    };

    // 跳过 -flags，提取路径
    let path = skip_ps_flags(path_part.trim()).trim();
    if path.is_empty() {
        return None;
    }

    // 清理引号
    let clean = path.trim_matches('\'').trim_matches('"').trim();

    if clean.is_empty() {
        return None;
    }

    let is_dir = before_lower.contains("-directory");
    Some((clean.to_string(), is_dir))
}

/// 从 cmd /c "..." 中提取内部命令
///
/// 场景：`cmd /c "del C:\path\file.txt"` → 返回 `del C:\path\file.txt`
fn extract_cmd_c_inner(lower: &str, original: &str) -> Option<String> {
    // 匹配 cmd /c 或 cmd /C
    let cmd_prefix_patterns = ["cmd /c ", "cmd /c \"", "cmd /c '", "cmd.exe /c "];
    for pattern in &cmd_prefix_patterns {
        if lower.starts_with(pattern) {
            let inner = &original[pattern.len()..];
            // 去除外层引号
            let inner = inner
                .trim()
                .trim_end_matches('"')
                .trim_end_matches('\'')
                .trim();
            if !inner.is_empty() {
                return Some(inner.to_string());
            }
        }
    }
    None
}

/// 从命令中提取路径（跳过所有 /开头的参数标志）
fn extract_path_after_flags(command: &str) -> Option<String> {
    let trimmed = command.trim();
    // 跳过命令名（第一个空白分隔 token）
    let after_cmd = trimmed.split_once(char::is_whitespace)?.1.trim();

    // 如果剩余部分以引号开头，提取引号内的完整路径（支持空格）
    // 先跳过所有 /flag 和 -flag
    let mut remaining = after_cmd;
    loop {
        remaining = remaining.trim_start();
        if remaining.starts_with('/') || remaining.starts_with('-') {
            // 跳过当前 flag token
            remaining = match remaining.split_once(char::is_whitespace) {
                Some((_, rest)) => rest,
                None => return None, // 只有 flag 没有路径
            };
        } else {
            break;
        }
    }

    // remaining 现在应该是路径（可能带引号）
    let remaining = remaining.trim();
    if remaining.is_empty() {
        return None;
    }

    let path = if remaining.starts_with('"') {
        // 提取引号对内的完整内容
        let rest = &remaining[1..];
        match rest.find('"') {
            Some(end) => &rest[..end],
            None => rest, // 未闭合引号，使用到末尾
        }
    } else if remaining.starts_with('\'') {
        let rest = &remaining[1..];
        match rest.find('\'') {
            Some(end) => &rest[..end],
            None => rest,
        }
    } else {
        // 无引号，取第一个空白前的 token
        remaining.split_whitespace().next().unwrap_or(remaining)
    };

    if path.is_empty() {
        return None;
    }
    // 通配符路径允许通过，交由 try_intercept_delete 中的 handle_glob_delete 处理
    Some(path.to_string())
}

/// 从 PowerShell Remove-Item（或别名 ri/rm）中提取目标路径
///
/// 支持 Agent 实际生成的多种格式:
/// - `powershell -Command "Remove-Item 'path' -Force"`
/// - `powershell -Command 'Remove-Item \'path\' -Force; if ($?) { ... }'`
/// - `powershell -Command "ri 'path'"` / `rm 'path'` (PS 别名)
/// - `Remove-Item 'path' -Force -Recurse`
///
/// 设计要点：
/// - 先截断分号后的内容（PS 语句分隔符，如 `; if ($?) {...}`）
/// - 支持 `\'path\'` / `'path'` / `"path"` 三种引号模式
fn extract_powershell_remove_item_target(
    command: &str,
    workdir: Option<&Path>,
) -> Option<(String, bool)> {
    let (paths, is_directory) = extract_powershell_remove_item_targets(command, workdir)?;
    paths.into_iter().next().map(|path| (path, is_directory))
}

fn extract_powershell_remove_item_targets(
    command: &str,
    workdir: Option<&Path>,
) -> Option<(Vec<String>, bool)> {
    extract_powershell_remove_item_targets_with_app_data_dir(command, workdir, None)
}

fn extract_powershell_remove_item_targets_with_app_data_dir(
    command: &str,
    workdir: Option<&Path>,
    app_data_dir: Option<&Path>,
) -> Option<(Vec<String>, bool)> {
    let lower = command.to_lowercase();
    if !is_powershell_delete_parse_context(&lower) {
        return None;
    }

    let variables = extract_powershell_variable_assignments(command, workdir, app_data_dir);

    // 查找删除命令位置：优先 remove-item，然后尝试别名 ri/rm/del/erase/rd/rmdir
    let (cmd_end_pos, cmd_name) = find_ps_delete_command(&lower)?;
    let after_ri = &command[cmd_end_pos..];
    let after_ri = after_ri.trim();

    // 先截断分号及之后的内容（如 ; if ($?) { '删除成功' } else { '删除失败' }）
    // 分号在 PowerShell -Command 中是语句分隔符，后面通常是结果检查逻辑
    let effective = match after_ri.find(';') {
        Some(pos) => &after_ri[..pos],
        None => after_ri,
    };
    let effective = effective.trim();

    let is_directory = lower.contains("-recurse") || matches!(cmd_name, "rmdir" | "rd");

    // 从 effective 中提取路径（跳过 -Flag 参数）
    // Agent 常用格式: \'C:\Users\Admin\Pictures\log.txt\' -Force
    //                 'C:\path\file' -Force
    //                 "C:\path\file" -Force

    // 策略：找到第一个非 - 开头的 token，作为路径
    // 但需要特殊处理引号包裹的路径（可能含空格）

    let paths = extract_paths_from_ps_args(effective);
    let paths = resolve_powershell_path_expressions(paths, &variables);
    let paths = if paths
        .iter()
        .any(|path| is_powershell_pipeline_item_path(path))
    {
        extract_powershell_foreach_fullname_patterns(command, &variables).unwrap_or(paths)
    } else {
        paths
    };

    if paths.is_empty() {
        return None;
    }
    Some((paths, is_directory))
}

fn is_powershell_delete_parse_context(lower: &str) -> bool {
    let trimmed = lower.trim_start();
    lower.contains("powershell")
        || lower.contains("pwsh")
        || starts_with_command(trimmed, "remove-item")
        || starts_with_command(trimmed, "ri")
}

fn is_powershell_pipeline_item_path(path: &str) -> bool {
    let normalized = path.trim().to_ascii_lowercase();
    normalized == "$_.fullname"
        || normalized == "$psitem.fullname"
        || (normalized.starts_with('$') && normalized.ends_with(".fullname"))
}

fn infer_appdata_parent_dir(app_data_dir: &Path) -> Option<PathBuf> {
    app_data_dir.parent().map(|parent| parent.to_path_buf())
}

fn extract_powershell_variable_assignments(
    command: &str,
    workdir: Option<&Path>,
    app_data_dir: Option<&Path>,
) -> std::collections::HashMap<String, String> {
    let chars: Vec<char> = command.chars().collect();
    let mut assignments = std::collections::HashMap::new();
    if let Some(workdir) = workdir {
        assignments.insert(
            "env:workdir".to_string(),
            workdir.to_string_lossy().to_string(),
        );
    }
    if let Some(app_data_dir) = app_data_dir.and_then(infer_appdata_parent_dir) {
        assignments.insert(
            "env:appdata".to_string(),
            app_data_dir.to_string_lossy().to_string(),
        );
    }
    for name in [
        "APPDATA",
        "LOCALAPPDATA",
        "USERPROFILE",
        "HOME",
        "TEMP",
        "TMP",
    ] {
        if let Some(value) = std::env::var_os(name) {
            assignments
                .entry(format!("env:{}", name.to_ascii_lowercase()))
                .or_insert_with(|| value.to_string_lossy().to_string());
        }
    }
    let mut index = 0usize;

    while index < chars.len() {
        if chars[index] != '$' {
            index += 1;
            continue;
        }

        let name_start = index + 1;
        let mut name_end = name_start;
        while name_end < chars.len()
            && (chars[name_end].is_ascii_alphanumeric() || chars[name_end] == '_')
        {
            name_end += 1;
        }

        if name_end == name_start {
            index += 1;
            continue;
        }

        let mut cursor = name_end;
        while cursor < chars.len() && chars[cursor].is_whitespace() {
            cursor += 1;
        }
        if cursor >= chars.len() || chars[cursor] != '=' {
            index = name_end;
            continue;
        }
        cursor += 1;
        while cursor < chars.len() && chars[cursor].is_whitespace() {
            cursor += 1;
        }
        let name: String = chars[name_start..name_end]
            .iter()
            .collect::<String>()
            .to_ascii_lowercase();

        if is_quote_char(chars[cursor]) {
            let quote = chars[cursor];
            cursor += 1;
            let value_start = cursor;
            while cursor < chars.len() && !quotes_match(chars[cursor], quote) {
                cursor += 1;
            }
            if cursor >= chars.len() {
                break;
            }

            let raw_value: String = chars[value_start..cursor].iter().collect();
            let value = resolve_powershell_path_expression(&raw_value, &assignments);
            assignments.insert(name, value);
            index = cursor + 1;
            continue;
        }

        let value_start = cursor;
        while cursor < chars.len()
            && !chars[cursor].is_whitespace()
            && chars[cursor] != ';'
            && chars[cursor] != '}'
        {
            cursor += 1;
        }

        if value_start == cursor {
            index = cursor + 1;
            continue;
        }

        let raw_value: String = chars[value_start..cursor].iter().collect();
        let value = resolve_powershell_path_expression(&raw_value, &assignments);
        if value != raw_value
            || raw_value.contains('\\')
            || raw_value.contains('/')
            || raw_value.contains(':')
            || raw_value.starts_with('.')
        {
            assignments.insert(name, value);
        }
        index = cursor + 1;
    }

    assignments
}

fn resolve_powershell_path_expressions(
    paths: Vec<String>,
    variables: &std::collections::HashMap<String, String>,
) -> Vec<String> {
    paths
        .into_iter()
        .map(|path| resolve_powershell_path_expression(&path, variables))
        .collect()
}

fn resolve_powershell_path_expression(
    path: &str,
    variables: &std::collections::HashMap<String, String>,
) -> String {
    let mut resolved = path.trim().to_string();

    for (name, value) in variables {
        let bare = format!("${}", name);
        let braced = format!("${{{}}}", name);
        resolved = replace_case_insensitive(&resolved, &braced, value);
        resolved = replace_case_insensitive(&resolved, &bare, value);
    }

    resolved
}

fn contains_unresolved_powershell_variable(path: &str) -> bool {
    let trimmed = path.trim();
    let lower = trimmed.to_ascii_lowercase();
    lower.contains("$env:")
        || lower.contains("${env:")
        || trimmed.starts_with('$')
        || trimmed.starts_with("${")
}

fn replace_case_insensitive(input: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        return input.to_string();
    }

    let lower_input = input.to_ascii_lowercase();
    let lower_needle = needle.to_ascii_lowercase();
    let mut output = String::new();
    let mut search_start = 0usize;

    while let Some(relative_pos) = lower_input[search_start..].find(&lower_needle) {
        let pos = search_start + relative_pos;
        output.push_str(&input[search_start..pos]);
        output.push_str(replacement);
        search_start = pos + needle.len();
    }

    output.push_str(&input[search_start..]);
    output
}

fn extract_powershell_foreach_fullname_patterns(
    command: &str,
    variables: &std::collections::HashMap<String, String>,
) -> Option<Vec<String>> {
    let lower = command.to_ascii_lowercase();
    let has_foreach = lower.contains("foreach-object")
        || lower.contains("foreach ")
        || lower.contains("foreach(");
    if !has_foreach || !lower.contains(".fullname") || !lower.contains("remove-item") {
        return None;
    }

    let mut patterns = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut search_start = 0usize;

    while let Some(relative_pos) = lower[search_start..].find("get-childitem") {
        let pos = search_start + relative_pos;
        let args_start = pos + "get-childitem".len();
        let rest = &command[args_start..];
        let segment_end = rest
            .find('|')
            .or_else(|| rest.find(';'))
            .unwrap_or(rest.len());
        let segment = &rest[..segment_end];
        let paths =
            resolve_powershell_path_expressions(extract_paths_from_ps_args(segment), variables);

        for path in paths {
            if path.contains('$') {
                continue;
            }
            let pattern = join_glob_child_pattern(&path);
            if seen.insert(pattern.clone()) {
                patterns.push(pattern);
            }
        }

        search_start = args_start;
    }

    if patterns.is_empty() {
        None
    } else {
        Some(patterns)
    }
}

fn join_glob_child_pattern(path: &str) -> String {
    let trimmed = path.trim_end_matches(['\\', '/']);
    if trimmed.is_empty() {
        "*".to_string()
    } else if trimmed.contains('/') && !trimmed.contains('\\') {
        format!("{}/*", trimmed)
    } else {
        format!("{}\\*", trimmed)
    }
}

/// 在命令字符串中查找 PS 删除命令（remove-item / ri / rm）的位置
///
/// 返回 (命令结束位置, 命令名) 或 None
/// 优先匹配 remove-item，然后尝试别名 ri / rm（需要词边界）
fn find_ps_delete_command(lower: &str) -> Option<(usize, &str)> {
    for command_name in ["remove-item", "rmdir", "erase", "del", "rd", "ri", "rm"] {
        if let Some(pos) = find_command_token(lower, command_name) {
            return Some((pos + command_name.len(), command_name));
        }
    }

    None
}

fn find_command_token(input: &str, command_name: &str) -> Option<usize> {
    for (pos, _) in input.match_indices(command_name) {
        if is_command_token_boundary_before(input, pos)
            && is_command_token_boundary_after(input, pos + command_name.len())
        {
            return Some(pos);
        }
    }

    None
}

fn is_command_token_boundary_before(input: &str, pos: usize) -> bool {
    if pos == 0 {
        return true;
    }

    input[..pos]
        .chars()
        .next_back()
        .map(|ch| {
            ch.is_whitespace()
                || matches!(
                    ch,
                    '"' | '\'' | '“' | '”' | '‘' | '’' | ';' | '|' | '&' | '{' | '('
                )
        })
        .unwrap_or(true)
}

fn is_command_token_boundary_after(input: &str, pos: usize) -> bool {
    if pos >= input.len() {
        return true;
    }

    input[pos..]
        .chars()
        .next()
        .map(|ch| {
            ch.is_whitespace()
                || matches!(
                    ch,
                    '"' | '\'' | '“' | '”' | '‘' | '’' | ';' | '|' | '&' | '}' | ')'
                )
        })
        .unwrap_or(true)
}

fn has_unhandled_delete_intent(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    let lower = lower.replace('`', "");

    contains_unhandled_powershell_delete_api(&lower)
        || contains_runtime_delete_api(&lower)
        || contains_unix_delete_command(&lower)
        || contains_git_cleanup_delete(&lower)
        || contains_robocopy_mirror_delete(&lower)
        || contains_cmd_loop_delete(&lower)
}

fn contains_unhandled_powershell_delete_api(lower: &str) -> bool {
    if !(lower.contains("powershell") || lower.contains("pwsh")) {
        return false;
    }

    [
        "[system.io.file]::delete",
        "[io.file]::delete",
        "[system.io.directory]::delete",
        "[io.directory]::delete",
        ".delete(",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
}

fn contains_runtime_delete_api(lower: &str) -> bool {
    let python_delete = (lower.contains("python") || lower.contains("py -"))
        && [
            "shutil.rmtree",
            "os.remove(",
            "os.unlink(",
            ".unlink(",
            ".rmdir(",
        ]
        .iter()
        .any(|pattern| lower.contains(pattern));
    if python_delete {
        return true;
    }

    (lower.contains("node") || lower.contains("bun ") || lower.contains("deno "))
        && [
            "rmsync(",
            "rmdirsync(",
            "unlinksync(",
            "fs.promises.rm",
            "fs.promises.rmdir",
            "fs.promises.unlink",
            ".rm(",
            ".rmdir(",
            ".unlink(",
        ]
        .iter()
        .any(|pattern| lower.contains(pattern))
}

fn contains_unix_delete_command(lower: &str) -> bool {
    let trimmed = lower.trim_start();
    trimmed.starts_with("rm ")
        || trimmed == "rm"
        || trimmed.starts_with("unlink ")
        || trimmed == "unlink"
        || starts_with_command(trimmed, "rm")
        || starts_with_command(trimmed, "unlink")
        || starts_with_command(trimmed, "shred")
        || command_chain_contains(lower, "rm")
        || command_chain_contains(lower, "unlink")
        || lower.contains("find ") && (lower.contains(" -delete") || lower.contains(" -exec rm"))
        || (lower.contains("bash") || lower.contains("wsl") || lower.contains("sh -c"))
            && (lower.contains("rm -") || lower.contains(" rm ") || lower.contains("unlink "))
}

fn contains_git_cleanup_delete(lower: &str) -> bool {
    if lower.contains("git reset") && lower.contains("--hard") {
        return true;
    }

    lower.contains("git clean")
        && !(lower.contains(" --dry-run")
            || lower.contains(" -n")
            || lower.contains(" -nd")
            || lower.contains(" -dn"))
}

fn contains_robocopy_mirror_delete(lower: &str) -> bool {
    lower.contains("robocopy") && (has_slash_flag(lower, "mir") || has_slash_flag(lower, "purge"))
}

fn contains_cmd_loop_delete(lower: &str) -> bool {
    (starts_with_command(lower.trim_start(), "for") || lower.contains(" for "))
        && (find_command_token(lower, "del").is_some()
            || find_command_token(lower, "erase").is_some()
            || find_command_token(lower, "rmdir").is_some()
            || find_command_token(lower, "rd").is_some())
        || lower.contains("forfiles")
            && (find_command_token(lower, "del").is_some()
                || find_command_token(lower, "erase").is_some()
                || find_command_token(lower, "rmdir").is_some()
                || find_command_token(lower, "rd").is_some())
}

fn starts_with_command(input: &str, command_name: &str) -> bool {
    input.starts_with(command_name) && is_command_token_boundary_after(input, command_name.len())
}

fn command_chain_contains(input: &str, command_name: &str) -> bool {
    for separator in ["&&", "||", ";", "|"] {
        let needle = format!("{} {}", separator, command_name);
        if let Some(pos) = input.find(&needle) {
            let command_pos = pos + separator.len() + 1;
            if is_command_token_boundary_after(input, command_pos + command_name.len()) {
                return true;
            }
        }
    }

    false
}

fn has_slash_flag(input: &str, flag: &str) -> bool {
    let needle = format!("/{}", flag);
    input.match_indices(&needle).any(|(pos, _)| {
        is_command_token_boundary_before(input, pos)
            && is_command_token_boundary_after(input, pos + needle.len())
    })
}

/// 从 PowerShell Remove-Item 的参数部分提取路径列表
///
/// 处理 Agent 常见的参数格式：
/// - `\'path\' -Force` — 转义单引号（PS -Command 嵌套）
/// - `'path' -Force` — 标准单引号
/// - `"path" -Force` — 标准双引号
/// - `-Path 'path' -Recurse -Force` — 带 -Path 前缀（含空格路径）
/// - `path -Force` — 无引号简单路径
///
/// 核心策略：先跳过所有 -flag，再按引号和逗号解析剩余路径列表
fn extract_paths_from_ps_args(args: &str) -> Vec<String> {
    let trimmed = args.trim();

    // 策略：从原始字符串中找到第一个非 -flag 的位置，
    // 然后在该位置对剩余字符串做引号匹配。
    // 不能用 split_whitespace，因为引号内的空格不应分割。

    let remaining = skip_ps_flags(trimmed);
    let remaining = remaining.trim();

    if remaining.is_empty() {
        return Vec::new();
    }

    split_powershell_path_list(remaining)
}

fn split_powershell_path_list(input: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if quote.is_none() && ch.is_whitespace() {
            if current.is_empty() {
                continue;
            }

            let rest: String = chars.clone().collect();
            if rest.trim_start().starts_with('-') {
                push_clean_path(&mut paths, &mut current);
                break;
            }

            current.push(ch);
            continue;
        }

        if quote.is_none() && ch == ',' {
            push_clean_path(&mut paths, &mut current);
            continue;
        }

        if quote.is_none() && is_quote_char(ch) {
            quote = Some(ch);
            continue;
        }

        if let Some(q) = quote {
            if quotes_match(ch, q) {
                quote = None;
                continue;
            }
        }

        if ch == '\\' && quote == Some('\'') && chars.peek() == Some(&'\'') {
            let _ = chars.next();
            quote = None;
            continue;
        }

        current.push(ch);
    }

    push_clean_path(&mut paths, &mut current);
    paths
}

fn push_clean_path(paths: &mut Vec<String>, current: &mut String) {
    let clean = current
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim_matches('“')
        .trim_matches('”')
        .trim_matches('‘')
        .trim_matches('’')
        .trim_matches('\\')
        .trim();

    if !clean.is_empty() {
        paths.push(clean.to_string());
    }
    current.clear();
}

fn is_quote_char(ch: char) -> bool {
    matches!(ch, '"' | '\'' | '“' | '”' | '‘' | '’')
}

fn quotes_match(ch: char, quote: char) -> bool {
    ch == quote || (quote == '“' && ch == '”') || (quote == '‘' && ch == '’')
}

/// 跳过 PowerShell 参数字符串中的所有 -flag 前缀
///
/// 逐字符遍历，跳过 `-FlagName` 和跟随的空白，直到遇到非 - 开头的内容。
/// 返回跳过 flags 后的剩余字符串切片。
fn skip_ps_flags(s: &str) -> &str {
    let mut remaining = s.trim();
    loop {
        if !remaining.starts_with('-') {
            break;
        }
        // 当前是 -flag，找到这个 flag 的结束位置（下一个空白或字符串末尾）
        match remaining.find(char::is_whitespace) {
            Some(space_pos) => {
                remaining = remaining[space_pos..].trim_start();
            }
            None => {
                // 只有一个 -flag 没有后续内容
                return "";
            }
        }
    }
    remaining
}

// ==================== 核心操作 ====================

/// 将文件/目录移动到 Trash Bin
///
/// 优先使用 rename（同卷零开销），跨卷时拷贝后删除。
fn move_to_trash(source: &Path, trash_path: &Path, is_directory: bool) -> Result<(), AppError> {
    // 确保 Trash Bin 目录存在
    if let Some(parent) = trash_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            AppError::FileSystem(format!("Failed to create Trash Bin directory: {}", e))
        })?;
    }

    // 尝试 rename（同卷移动）
    match std::fs::rename(source, trash_path) {
        Ok(()) => {
            log::info!(
                "[TrashBin] 文件已移动: {} → {}",
                source.display(),
                trash_path.display()
            );
            return Ok(());
        }
        Err(e) => {
            log::debug!("[TrashBin] rename 失败 (可能跨卷): {}，尝试 copy+remove", e);
        }
    }

    // 跨卷: 拷贝后删除源
    if is_directory {
        copy_dir_recursive(source, trash_path)?;
        std::fs::remove_dir_all(source).map_err(|e| {
            AppError::FileSystem(format!("Failed to remove source directory: {}", e))
        })?;
    } else {
        std::fs::copy(source, trash_path).map_err(|e| {
            AppError::FileSystem(format!("Failed to copy file across volumes: {}", e))
        })?;
        std::fs::remove_file(source)
            .map_err(|e| AppError::FileSystem(format!("Failed to remove source file: {}", e)))?;
    }

    log::info!(
        "[TrashBin] 跨卷移动完成: {} → {}",
        source.display(),
        trash_path.display()
    );
    Ok(())
}

/// 递归复制目录
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(dst)
        .map_err(|e| AppError::FileSystem(format!("Failed to create target directory: {}", e)))?;

    let entries = std::fs::read_dir(src)
        .map_err(|e| AppError::FileSystem(format!("Failed to read source directory: {}", e)))?;

    for entry in entries {
        let entry = entry
            .map_err(|e| AppError::FileSystem(format!("Failed to read directory entry: {}", e)))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path).map_err(|e| {
                AppError::FileSystem(format!("Failed to copy file {}: {}", src_path.display(), e))
            })?;
        }
    }

    Ok(())
}

// ==================== 公开接口 ====================

/// 判断路径是否包含通配符
fn is_glob_pattern(path: &str) -> bool {
    path.contains('*') || path.contains('?')
}

fn normalize_path_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn path_key(path: &Path) -> String {
    let mut key = normalize_path_lexically(path)
        .to_string_lossy()
        .replace('\\', "/");
    if let Some(stripped) = key.strip_prefix("//?/") {
        key = stripped.to_string();
    }
    key.trim_end_matches('/').to_ascii_lowercase()
}

fn canonical_or_normalized(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| normalize_path_lexically(path))
}

fn path_is_inside_root(root: &Path, path: &Path) -> bool {
    let root_key = path_key(root);
    let path_key = path_key(path);
    path_key == root_key || path_key.starts_with(&format!("{}/", root_key))
}

fn is_path_allowed_by_roots(path: &Path, allowed_roots: &[PathBuf]) -> bool {
    let candidate = canonical_or_normalized(path);
    allowed_roots.iter().any(|root| {
        let root = canonical_or_normalized(root);
        path_is_inside_root(&root, &candidate)
    })
}

fn ensure_delete_path_allowed(
    target_path: &Path,
    allowed_roots: Option<&[PathBuf]>,
) -> Result<(), AppError> {
    let Some(allowed_roots) = allowed_roots else {
        return Ok(());
    };
    if !allowed_roots.is_empty() && is_path_allowed_by_roots(target_path, allowed_roots) {
        return Ok(());
    }

    log::warn!(
        "[TrashBin] sandbox scoped delete blocked outside allowed roots: {}",
        target_path.display()
    );
    Err(AppError::Forbidden(
        SANDBOX_DELETE_BLOCK_MESSAGE.to_string(),
    ))
}

fn resolve_delete_path(target: &str, workdir: Option<&Path>) -> PathBuf {
    let trimmed = target.trim_matches(|c| c == '\'' || c == '"');
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return normalize_path_lexically(path);
    }

    match workdir {
        Some(wd) => normalize_path_lexically(&wd.join(path)),
        None => normalize_path_lexically(path),
    }
}

/// 移动单个文件/目录到 Trash Bin 并记录 manifest
///
/// 返回用户可见的反馈消息
fn trash_single_item(
    target_path: &Path,
    _is_directory: bool,
    command: &str,
    app_data_dir: &Path,
    batch_id: &str,
) -> Result<String, AppError> {
    let target_path_str = target_path.to_string_lossy().to_string();

    // 以真实文件系统类型为准，避免 `Remove-Item file -Recurse` 被误记为目录。
    let is_directory = target_path.is_dir();

    // 生成回收站路径
    let trash_path = generate_trash_path(app_data_dir, &target_path_str);

    // 执行移动
    move_to_trash(target_path, &trash_path, is_directory)?;

    // 记录到 manifest
    let entry = TrashEntry {
        id: format!(
            "{}_{}",
            chrono::Local::now().format("%Y%m%d%H%M%S"),
            uuid::Uuid::new_v4()
                .to_string()
                .split('-')
                .next()
                .unwrap_or("0000")
        ),
        original_path: target_path_str.to_string(),
        trash_path: trash_path.to_string_lossy().to_string(),
        deleted_at: chrono::Local::now().to_rfc3339(),
        command: command.to_string(),
        batch_id: Some(batch_id.to_string()),
        is_directory,
    };
    append_to_manifest(app_data_dir, entry)?;

    let type_label = if is_directory { "Directory" } else { "File" };
    Ok(format!(
        "{}: {} → {}",
        type_label,
        target_path_str,
        trash_path.display()
    ))
}

fn opaque_delete_success_observation() -> String {
    DELETE_SUCCESS_OBSERVATION.to_string()
}

fn log_intercepted_delete(details: &[String], failed_count: u32) {
    log::info!(
        "[TrashBin] intercepted delete; moved {} item(s), failed {} item(s)",
        details.len(),
        failed_count
    );
    for detail in details {
        log::debug!("[TrashBin] {}", detail);
    }
}

/// 尝试拦截删除命令并重写为移动到 Trash Bin
///
/// 返回值:
/// - `Ok(Some(message))`: 成功拦截并移动，message 为用户可见的反馈
/// - `Ok(None)`: 非删除命令或无法解析，应继续正常执行流程
/// - `Err`: 拦截后移动失败
///
/// 支持通配符路径（如 `del *.webp`），使用 glob 展开后逐个移动
pub fn try_intercept_delete(
    command: &str,
    app_data_dir: &Path,
    workdir: Option<&Path>,
) -> Result<Option<String>, AppError> {
    try_intercept_delete_scoped(command, app_data_dir, workdir, None)
}

/// 尝试拦截删除命令，并在需要时限制宿主侧软删除只能作用于授权根目录。
///
/// `allowed_roots` 用于隔离 / 联网隔离模式：Trash Bin 的移动发生在 Tauri 主进程，
/// 因此必须在主进程侧复刻 AppContainer 的文件边界，避免软删除绕过沙箱。
pub fn try_intercept_delete_scoped(
    command: &str,
    app_data_dir: &Path,
    workdir: Option<&Path>,
    allowed_roots: Option<&[PathBuf]>,
) -> Result<Option<String>, AppError> {
    let extracted_powershell_targets = extract_powershell_remove_item_targets_with_app_data_dir(
        command,
        workdir,
        Some(app_data_dir),
    );

    let powershell_single_target =
        if let Some((target_paths, is_directory)) = extracted_powershell_targets {
            if target_paths
                .iter()
                .any(|path| contains_unresolved_powershell_variable(path))
            {
                log::warn!(
                    "[TrashBin] blocked delete command with unresolved PowerShell variable: {}",
                    command
                );
                return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
            }

            if target_paths.len() > 1 {
                return handle_multi_delete(
                    &target_paths,
                    is_directory,
                    command,
                    app_data_dir,
                    workdir,
                    allowed_roots,
                );
            }

            match target_paths.into_iter().next() {
                Some(target_path) => Some((target_path, is_directory)),
                None => None,
            }
        } else {
            None
        };

    if let Some((target_paths, is_directory)) = extract_cmd_delete_targets(command) {
        if target_paths.len() > 1 {
            return handle_multi_delete(
                &target_paths,
                is_directory,
                command,
                app_data_dir,
                workdir,
                allowed_roots,
            );
        }
    }

    if powershell_single_target.is_none() && has_unhandled_delete_intent(command) {
        log::warn!(
            "[TrashBin] blocked unhandled delete-like command: {}",
            command
        );
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }

    let (target_path_str, is_directory) = match powershell_single_target {
        Some(result) => result,
        None => {
            // 1. 尝试从命令中提取删除目标
            match extract_delete_target_with_workdir(command, workdir) {
                Some(result) => result,
                None => return Ok(None),
            }
        }
    };

    if contains_unresolved_powershell_variable(&target_path_str) {
        log::warn!(
            "[TrashBin] blocked delete command with unresolved target variable: {}",
            command
        );
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }

    // 2. 通配符路径 → glob 展开后批量移动
    if is_glob_pattern(&target_path_str) {
        return handle_glob_delete(
            &target_path_str,
            command,
            app_data_dir,
            workdir,
            allowed_roots,
        );
    }

    // 3. 普通路径 → 验证存在性后单个移动
    let target_path = resolve_delete_path(&target_path_str, workdir);
    ensure_delete_path_allowed(&target_path, allowed_roots)?;
    if !target_path.exists() {
        // 目标不存在时不拦截，让原始命令处理错误
        return Ok(None);
    }

    let batch_id = generate_batch_id();
    let detail = trash_single_item(&target_path, is_directory, command, app_data_dir, &batch_id)?;
    log_intercepted_delete(&[detail], 0);
    Ok(Some(opaque_delete_success_observation()))
}

/// 处理 CMD del/erase 的多目标删除：`del /f "a" "b" "c"`。
fn handle_multi_delete(
    target_paths: &[String],
    is_directory: bool,
    command: &str,
    app_data_dir: &Path,
    workdir: Option<&Path>,
    allowed_roots: Option<&[PathBuf]>,
) -> Result<Option<String>, AppError> {
    let mut expanded_paths: Vec<PathBuf> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for target in target_paths {
        if is_glob_pattern(target) {
            let pattern_path = resolve_delete_path(target, workdir);
            ensure_delete_path_allowed(&pattern_path, allowed_roots)?;
            let glob_pattern = pattern_path.to_string_lossy().to_string();
            match glob::glob(&glob_pattern) {
                Ok(paths) => {
                    for path in paths.filter_map(|entry| entry.ok()).filter(|p| p.exists()) {
                        ensure_delete_path_allowed(&path, allowed_roots)?;
                        let key = path.to_string_lossy().to_string();
                        if seen.insert(key) {
                            expanded_paths.push(path);
                        }
                    }
                }
                Err(e) => {
                    log::warn!("[TrashBin] glob 解析失败: {}，跳过目标 {}", e, target);
                }
            }
            continue;
        }

        let path = resolve_delete_path(target, workdir);
        ensure_delete_path_allowed(&path, allowed_roots)?;
        if path.exists() {
            let key = path.to_string_lossy().to_string();
            if seen.insert(key) {
                expanded_paths.push(path);
            }
        }
    }

    if expanded_paths.is_empty() {
        log::debug!("[TrashBin] 多目标删除未匹配到任何存在的文件，回退原始执行");
        return Ok(None);
    }

    let mut moved_details: Vec<String> = Vec::new();
    let mut failed_count: u32 = 0;

    let batch_id = generate_batch_id();
    for path in &expanded_paths {
        let path_str = path.to_string_lossy().to_string();
        let is_dir = is_directory || path.is_dir();
        match trash_single_item(path, is_dir, command, app_data_dir, &batch_id) {
            Ok(detail) => moved_details.push(detail),
            Err(e) => {
                log::warn!("[TrashBin] 移动失败 {}: {}", path_str, e);
                failed_count += 1;
            }
        }
    }

    if moved_details.is_empty() {
        log::warn!("[TrashBin] 多目标删除全部移动失败，回退原始执行");
        return Ok(None);
    }

    log_intercepted_delete(&moved_details, failed_count);
    Ok(Some(opaque_delete_success_observation()))
}

/// 处理通配符删除：展开 glob 模式后逐个移动到 Trash Bin
///
/// 例如 `del C:\Users\Admin\Pictures\*.webp` 会展开为所有匹配的 .webp 文件，
/// 逐个移动到回收站。如果没有匹配到任何文件，则不拦截（回退原始执行）。
fn handle_glob_delete(
    pattern: &str,
    command: &str,
    app_data_dir: &Path,
    workdir: Option<&Path>,
    allowed_roots: Option<&[PathBuf]>,
) -> Result<Option<String>, AppError> {
    // 使用 glob 展开通配符
    let pattern_path = resolve_delete_path(pattern, workdir);
    ensure_delete_path_allowed(&pattern_path, allowed_roots)?;
    let glob_pattern = pattern_path.to_string_lossy().to_string();
    let matched_paths: Vec<std::path::PathBuf> = match glob::glob(&glob_pattern) {
        Ok(paths) => paths
            .filter_map(|entry| entry.ok())
            .filter(|p| p.exists())
            .map(|path| {
                ensure_delete_path_allowed(&path, allowed_roots)?;
                Ok(path)
            })
            .collect::<Result<Vec<_>, AppError>>()?,
        Err(e) => {
            log::warn!("[TrashBin] glob 解析失败: {}，回退原始执行", e);
            return Ok(None);
        }
    };

    // 无匹配文件 → 不拦截
    if matched_paths.is_empty() {
        log::debug!(
            "[TrashBin] glob 模式 '{}' 未匹配到任何文件，跳过拦截",
            pattern
        );
        return Ok(None);
    }

    log::debug!(
        "[TrashBin] glob 模式 '{}' 匹配到 {} 个文件，开始批量移动",
        pattern,
        matched_paths.len()
    );

    // 逐个移动到回收站
    let mut moved_details: Vec<String> = Vec::new();
    let mut failed_count: u32 = 0;

    let batch_id = generate_batch_id();
    for matched_path in &matched_paths {
        let path_str = matched_path.to_string_lossy().to_string();
        let is_dir = matched_path.is_dir();
        match trash_single_item(matched_path, is_dir, command, app_data_dir, &batch_id) {
            Ok(detail) => moved_details.push(detail),
            Err(e) => {
                log::warn!("[TrashBin] 移动失败 {}: {}", path_str, e);
                failed_count += 1;
            }
        }
    }

    // 全部失败 → 回退原始执行
    if moved_details.is_empty() {
        log::warn!("[TrashBin] 批量移动全部失败，回退原始执行");
        return Ok(None);
    }

    log_intercepted_delete(&moved_details, failed_count);
    Ok(Some(opaque_delete_success_observation()))
}

/// 清理过期的回收站条目
///
/// 删除超过指定天数的文件/目录和 manifest 记录。
/// 在应用启动时自动调用一次。
pub fn cleanup_expired_items(app_data_dir: &Path) -> Result<u32, AppError> {
    let mut entries = read_manifest(app_data_dir);
    if entries.is_empty() {
        return Ok(0);
    }

    let now = chrono::Local::now();
    let retention = chrono::Duration::days(DEFAULT_RETENTION_DAYS as i64);
    let mut cleaned = 0u32;

    entries.retain(|entry| {
        // 解析删除时间
        let deleted_at = match chrono::DateTime::parse_from_rfc3339(&entry.deleted_at) {
            Ok(dt) => dt.with_timezone(&chrono::Local),
            Err(_) => return true, // 解析失败则保留
        };

        // 未过期则保留
        if now - deleted_at < retention {
            return true;
        }

        // 已过期 — 删除物理文件
        let trash_path = Path::new(&entry.trash_path);
        if trash_path.exists() {
            let result = if entry.is_directory {
                std::fs::remove_dir_all(trash_path)
            } else {
                std::fs::remove_file(trash_path)
            };

            match result {
                Ok(()) => {
                    log::debug!(
                        "[TrashBin] 清理过期条目: {} (已保留 {} 天)",
                        entry.original_path,
                        DEFAULT_RETENTION_DAYS
                    );
                    cleaned += 1;
                }
                Err(e) => {
                    log::warn!("[TrashBin] 清理失败 {}: {}", entry.trash_path, e);
                    return true; // 删除失败则保留记录
                }
            }
        } else {
            // 物理文件已不存在，清理 manifest 记录
            cleaned += 1;
        }

        false // 从 manifest 中移除
    });

    // 更新 manifest
    if cleaned > 0 {
        write_manifest(app_data_dir, &entries)?;
        log::info!("[TrashBin] 自动清理完成: 清理了 {} 个过期条目", cleaned);
    }

    Ok(cleaned)
}

// ==================== 单元测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

    // ── 命令解析测试 ──

    #[test]
    fn test_extract_simple_del() {
        let result = extract_delete_target("del C:\\data\\file.txt");
        assert_eq!(result, Some(("C:\\data\\file.txt".to_string(), false)));
    }

    #[test]
    fn test_extract_del_with_flags() {
        let result = extract_delete_target("del /f /q C:\\data\\file.txt");
        assert_eq!(result, Some(("C:\\data\\file.txt".to_string(), false)));
    }

    #[test]
    fn test_extract_erase() {
        let result = extract_delete_target("erase C:\\data\\file.txt");
        assert_eq!(result, Some(("C:\\data\\file.txt".to_string(), false)));
    }

    #[test]
    fn test_extract_rmdir() {
        let result = extract_delete_target("rmdir /s /q C:\\data\\old_dir");
        assert_eq!(result, Some(("C:\\data\\old_dir".to_string(), true)));
    }

    #[test]
    fn test_extract_rd() {
        let result = extract_delete_target("rd /s /q C:\\data\\old_dir");
        assert_eq!(result, Some(("C:\\data\\old_dir".to_string(), true)));
    }

    #[test]
    fn test_extract_remove_item_simple() {
        let result =
            extract_delete_target("powershell -Command \"Remove-Item 'C:\\data\\file.txt'\"");
        assert!(result.is_some());
        let (path, _) = result.unwrap();
        assert_eq!(path, "C:\\data\\file.txt");
    }

    #[test]
    fn test_extract_remove_item_recurse() {
        let result = extract_delete_target(
            "powershell -Command \"Remove-Item 'C:\\data\\dir' -Recurse -Force\"",
        );
        assert!(result.is_some());
        let (path, is_dir) = result.unwrap();
        assert_eq!(path, "C:\\data\\dir");
        assert!(is_dir);
    }

    #[test]
    fn test_extract_powershell_delete_aliases() {
        let result = extract_delete_target(r#"powershell -Command "del 'C:\data\file.txt'""#);
        assert_eq!(result, Some(("C:\\data\\file.txt".to_string(), false)));

        let result = extract_delete_target(r#"powershell -Command "rmdir 'C:\data\old_dir'""#);
        assert_eq!(result, Some(("C:\\data\\old_dir".to_string(), true)));
    }

    #[test]
    fn test_extract_remove_itemproperty_is_not_file_delete() {
        let result = extract_delete_target(
            r#"powershell -Command "Remove-ItemProperty -Path HKCU:\Software\Test -Name Foo""#,
        );
        assert!(result.is_none());
        assert!(!has_unhandled_delete_intent(
            r#"powershell -Command "Remove-ItemProperty -Path HKCU:\Software\Test -Name Foo""#
        ));
    }

    #[test]
    fn test_detects_unix_rm_delete_intent() {
        assert!(has_unhandled_delete_intent("rm -rf build"));
    }

    #[test]
    fn test_extract_non_delete_returns_none() {
        assert!(extract_delete_target("git status").is_none());
        assert!(extract_delete_target("npm run build").is_none());
        assert!(extract_delete_target("dir C:\\data").is_none());
    }

    #[test]
    fn test_extract_wildcard_returns_some() {
        // 通配符路径由 extract_delete_target 正常提取，
        // 交由 try_intercept_delete → handle_glob_delete 做 glob 展开处理
        let result = extract_delete_target("del *.tmp");
        assert_eq!(result, Some(("*.tmp".to_string(), false)));

        let result2 = extract_delete_target("del C:\\data\\*.log");
        assert_eq!(result2, Some(("C:\\data\\*.log".to_string(), false)));
    }

    #[test]
    fn test_extract_pipe_chain_returns_none() {
        // 管道链命令应该回退正常执行
        assert!(extract_delete_target("dir && del file.txt").is_none());
        assert!(extract_delete_target("echo y | del file.txt").is_none());
    }

    #[test]
    fn test_extract_del_with_quotes() {
        let result = extract_delete_target("del \"C:\\data\\my file.txt\"");
        assert_eq!(result, Some(("C:\\data\\my file.txt".to_string(), false)));
    }

    #[test]
    fn test_extract_del_with_multiple_quoted_targets() {
        let result = extract_cmd_delete_targets(
            "del /f \"C:\\data\\step0.png\" \"C:\\data\\step1.png\" \"C:\\data\\step2.png\"",
        );
        assert_eq!(
            result,
            Some((
                vec![
                    "C:\\data\\step0.png".to_string(),
                    "C:\\data\\step1.png".to_string(),
                    "C:\\data\\step2.png".to_string(),
                ],
                false,
            ))
        );
    }

    #[test]
    fn test_extract_remove_item_with_multiple_targets() {
        let result = extract_powershell_remove_item_targets(
            "powershell -Command \"Remove-Item 'C:\\data\\observe.png','C:\\data\\wechat.png','C:\\data\\verify.png' -Force -ErrorAction SilentlyContinue\"",
            None,
        );
        assert_eq!(
            result,
            Some((
                vec![
                    "C:\\data\\observe.png".to_string(),
                    "C:\\data\\wechat.png".to_string(),
                    "C:\\data\\verify.png".to_string(),
                ],
                false,
            ))
        );
    }

    #[test]
    fn test_extract_remove_item_with_path_flag_and_curly_quotes() {
        let result = extract_powershell_remove_item_targets(
            "powershell -Command “Remove-Item -Path ’C:\\data\\one.png’,’C:\\data\\two.png’ -Force”",
            None,
        );
        assert_eq!(
            result,
            Some((
                vec![
                    "C:\\data\\one.png".to_string(),
                    "C:\\data\\two.png".to_string(),
                ],
                false,
            ))
        );
    }

    // ── Manifest 与路径编码 ──

    #[test]
    fn test_extract_remove_item_with_variable_wildcard() {
        let result = extract_powershell_remove_item_targets(
            "powershell -NoProfile -Command \"$target = 'C:\\data\\project'; Remove-Item -LiteralPath $target\\* -Recurse -Force\"",
            None,
        );
        assert_eq!(
            result,
            Some((vec!["C:\\data\\project\\*".to_string()], true))
        );
    }

    #[test]
    fn test_extract_foreach_fullname_delete_with_variable_target() {
        let result = extract_powershell_remove_item_targets(
            "powershell -NoProfile -Command \"$target = 'C:\\data\\project'; Get-ChildItem -LiteralPath $target -Force | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }\"",
            None,
        );
        assert_eq!(
            result,
            Some((vec!["C:\\data\\project\\*".to_string()], true))
        );
    }

    #[test]
    fn test_extract_remove_item_with_env_workdir_wildcard() {
        let workdir = PathBuf::from("C:\\data\\project");
        let result = extract_powershell_remove_item_targets(
            r#"powershell -NoProfile -Command "$dir = $env:WORKDIR; Remove-Item -Path "$dir\*" -Recurse -Force""#,
            Some(&workdir),
        );
        assert_eq!(
            result,
            Some((vec!["C:\\data\\project\\*".to_string()], true))
        );
    }

    #[test]
    fn test_extract_remove_item_with_env_appdata_wildcard() {
        let app_data_dir = PathBuf::from("C:\\Users\\Tester\\AppData\\Roaming\\com.agentvis.app");
        let result = extract_powershell_remove_item_targets_with_app_data_dir(
            r#"powershell -NoProfile -Command "Remove-Item -Path "$env:APPDATA\com.agentvis.app\deliverables\Test_Team\Tester7\*" -Recurse -Force""#,
            None,
            Some(&app_data_dir),
        );
        assert_eq!(
            result,
            Some((
                vec!["C:\\Users\\Tester\\AppData\\Roaming\\com.agentvis.app\\deliverables\\Test_Team\\Tester7\\*".to_string()],
                true,
            ))
        );
    }

    #[test]
    fn test_extract_foreach_named_item_fullname_with_env_workdir() {
        let workdir = PathBuf::from("C:\\data\\project");
        let result = extract_powershell_remove_item_targets(
            "powershell -NoProfile -Command \"$dir = $env:WORKDIR; $items = Get-ChildItem -Path $dir; foreach ($item in $items) { if ($item.PSIsContainer) { Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction SilentlyContinue } else { Remove-Item -LiteralPath $item.FullName -Force -ErrorAction SilentlyContinue } }\"",
            Some(&workdir),
        );
        assert_eq!(
            result,
            Some((vec!["C:\\data\\project\\*".to_string()], true))
        );
    }

    #[test]
    fn test_encode_path() {
        assert_eq!(
            encode_path_for_filename("C:\\Users\\Admin\\file.txt"),
            "C_Users_Admin_file.txt"
        );
    }

    #[test]
    fn test_manifest_roundtrip() {
        let dir = std::env::temp_dir().join("agentvis_trash_test_manifest");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(get_trash_bin_dir(&dir));

        let entry = TrashEntry {
            id: "test_001".to_string(),
            original_path: "C:\\data\\file.txt".to_string(),
            trash_path: get_trash_bin_dir(&dir)
                .join("test_file.txt")
                .to_string_lossy()
                .to_string(),
            deleted_at: chrono::Local::now().to_rfc3339(),
            command: "del C:\\data\\file.txt".to_string(),
            batch_id: Some("batch_001".to_string()),
            is_directory: false,
        };

        append_to_manifest(&dir, entry.clone()).unwrap();
        let loaded = read_manifest(&dir);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].original_path, "C:\\data\\file.txt");

        // 清理
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── 完整拦截流程 ──

    #[test]
    fn test_intercept_nonexistent_file_returns_none() {
        let dir = std::env::temp_dir().join("agentvis_trash_test_nofile");
        // 文件不存在时不拦截
        let result = try_intercept_delete(
            "del C:\\nonexistent\\file_that_does_not_exist.txt",
            &dir,
            None,
        );
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn test_intercept_non_delete_returns_none() {
        let dir = std::env::temp_dir().join("agentvis_trash_test_nodel");
        let result = try_intercept_delete("git status", &dir, None);
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn test_intercept_powershell_alias_delete_moves_file() {
        let base = std::env::temp_dir().join("agentvis_trash_test_ps_alias_del");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&app_dir);
        let _ = std::fs::create_dir_all(&workdir);

        let test_file = workdir.join("alias_delete_me.txt");
        std::fs::write(&test_file, "test content").unwrap();

        let cmd = format!(
            "powershell -Command \"del '{}'\"",
            test_file.to_string_lossy()
        );
        let result = try_intercept_delete(&cmd, &app_dir, Some(&workdir));

        assert!(result.is_ok());
        assert_eq!(
            result.unwrap(),
            Some(DELETE_SUCCESS_OBSERVATION.to_string())
        );
        assert!(!test_file.exists());
        assert_eq!(read_manifest(&app_dir).len(), 1);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_unhandled_dotnet_delete_fails_closed() {
        let base = std::env::temp_dir().join("agentvis_trash_test_dotnet_delete_block");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&app_dir);
        let _ = std::fs::create_dir_all(&workdir);

        let test_file = workdir.join("dotnet_delete_me.txt");
        std::fs::write(&test_file, "test content").unwrap();
        let cmd = format!(
            "powershell -Command \"[System.IO.File]::Delete('{}')\"",
            test_file.to_string_lossy()
        );

        let result = try_intercept_delete(&cmd, &app_dir, Some(&workdir));

        assert!(matches!(result, Err(AppError::Forbidden(_))));
        assert!(test_file.exists(), "blocked delete API must not touch file");
        assert!(read_manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_unhandled_cleanup_commands_fail_closed() {
        let app_dir = std::env::temp_dir().join("agentvis_trash_test_cleanup_blocks");
        let _ = std::fs::remove_dir_all(&app_dir);
        let _ = std::fs::create_dir_all(&app_dir);

        for command in [
            "git clean -fdx",
            "git reset --hard HEAD",
            "python -c \"import shutil; shutil.rmtree('build')\"",
            "node -e \"require('fs').rmSync('build', { recursive: true, force: true })\"",
            "rm -rf build",
            "robocopy empty target /MIR",
        ] {
            let result = try_intercept_delete(command, &app_dir, Some(&app_dir));
            assert!(
                matches!(result, Err(AppError::Forbidden(_))),
                "expected fail-closed block for {command}"
            );
        }

        assert!(
            try_intercept_delete("git clean -ndx", &app_dir, Some(&app_dir))
                .unwrap()
                .is_none()
        );
        assert!(read_manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&app_dir);
    }

    #[test]
    fn test_intercept_real_file() {
        let dir = std::env::temp_dir().join("agentvis_trash_test_real");
        let _ = std::fs::create_dir_all(&dir);

        // 创建一个测试文件
        let test_file = dir.join("test_delete_me.txt");
        std::fs::write(&test_file, "test content").unwrap();

        let cmd = format!("del {}", test_file.to_string_lossy());
        let result = try_intercept_delete(&cmd, &dir, None);

        assert!(result.is_ok());
        let msg = result.unwrap();
        assert!(msg.is_some(), "应该成功拦截删除命令");
        let observation = msg.unwrap();
        assert_eq!(observation, DELETE_SUCCESS_OBSERVATION);
        assert!(!observation.to_lowercase().contains("trash"));
        assert!(!observation.contains("Agent_Trash_Bin"));
        assert!(!observation.contains(&dir.to_string_lossy().to_string()));
        assert!(!observation.contains(&test_file.to_string_lossy().to_string()));

        // 原文件应该已经不在原位
        assert!(!test_file.exists(), "原文件应已被移动");

        // Trash Bin 中应该有文件
        let trash_dir = get_trash_bin_dir(&dir);
        assert!(trash_dir.exists(), "Trash Bin 目录应存在");

        // Manifest 应该有记录
        let entries = read_manifest(&dir);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].original_path.contains("test_delete_me.txt"));

        // 清理
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_restore_entry_moves_file_back_and_updates_manifest() {
        let base = std::env::temp_dir().join("agentvis_trash_test_restore_entry");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&app_dir);
        let _ = std::fs::create_dir_all(&workdir);

        let test_file = workdir.join("restore_me.txt");
        std::fs::write(&test_file, "restore content").unwrap();

        let result = try_intercept_delete("del restore_me.txt", &app_dir, Some(&workdir));
        assert!(result.is_ok());
        assert_eq!(
            result.unwrap(),
            Some(DELETE_SUCCESS_OBSERVATION.to_string())
        );
        assert!(!test_file.exists());

        let entries = read_manifest(&app_dir);
        assert_eq!(entries.len(), 1);
        let entry_id = entries[0].id.clone();
        let trash_path = PathBuf::from(&entries[0].trash_path);
        assert!(trash_path.exists());

        let restore = restore_entries_matching(&app_dir, |entry| entry.id == entry_id).unwrap();
        assert_eq!(restore.restored_count, 1);
        assert!(restore.conflicts.is_empty());
        assert!(restore.missing.is_empty());
        assert!(test_file.exists());
        assert_eq!(
            std::fs::read_to_string(&test_file).unwrap(),
            "restore content"
        );
        assert!(!trash_path.exists());
        assert!(read_manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_delete_entry_removes_trash_file_and_updates_manifest() {
        let base = std::env::temp_dir().join("agentvis_trash_test_delete_entry");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&app_dir);
        let _ = std::fs::create_dir_all(&workdir);

        let test_file = workdir.join("discard_me.txt");
        std::fs::write(&test_file, "discard content").unwrap();

        let result = try_intercept_delete("del discard_me.txt", &app_dir, Some(&workdir));
        assert!(result.is_ok());
        assert!(!test_file.exists());

        let entries = read_manifest(&app_dir);
        assert_eq!(entries.len(), 1);
        let entry_id = entries[0].id.clone();
        let trash_path = PathBuf::from(&entries[0].trash_path);
        assert!(trash_path.exists());

        let delete = delete_entries_matching(&app_dir, |entry| entry.id == entry_id).unwrap();
        assert_eq!(delete.deleted_count, 1);
        assert!(delete.missing.is_empty());
        assert!(delete.failed.is_empty());
        assert!(!trash_path.exists());
        assert!(read_manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_intercept_powershell_variable_wildcard_moves_children() {
        let base = std::env::temp_dir().join("agentvis_trash_test_ps_var_wildcard");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let nested = workdir.join("nested");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&app_dir);
        let _ = std::fs::create_dir_all(&nested);

        let first = workdir.join("first.txt");
        let second = nested.join("second.txt");
        std::fs::write(&first, "first").unwrap();
        std::fs::write(&second, "second").unwrap();

        let cmd = format!(
            "powershell -NoProfile -Command \"$target = '{}'; Remove-Item -LiteralPath $target\\* -Recurse -Force -ErrorAction SilentlyContinue\"",
            workdir.to_string_lossy()
        );
        let result = try_intercept_delete(&cmd, &app_dir, Some(&workdir));

        assert!(result.is_ok());
        assert_eq!(
            result.unwrap(),
            Some(DELETE_SUCCESS_OBSERVATION.to_string())
        );
        assert!(
            workdir.exists(),
            "wildcard delete should preserve the parent directory"
        );
        assert!(!first.exists());
        assert!(!nested.exists());
        assert_eq!(read_manifest(&app_dir).len(), 2);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_intercept_powershell_foreach_fullname_moves_children() {
        let base = std::env::temp_dir().join("agentvis_trash_test_ps_foreach_fullname");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&app_dir);
        let _ = std::fs::create_dir_all(&workdir);

        let first = workdir.join("first.txt");
        let second = workdir.join("second.txt");
        std::fs::write(&first, "first").unwrap();
        std::fs::write(&second, "second").unwrap();

        let cmd = format!(
            "powershell -NoProfile -Command \"$target = '{}'; Get-ChildItem -LiteralPath $target -Force | ForEach-Object {{ Remove-Item -LiteralPath $_.FullName -Recurse -Force }}\"",
            workdir.to_string_lossy()
        );
        let result = try_intercept_delete(&cmd, &app_dir, Some(&workdir));

        assert!(result.is_ok());
        assert_eq!(
            result.unwrap(),
            Some(DELETE_SUCCESS_OBSERVATION.to_string())
        );
        assert!(
            workdir.exists(),
            "foreach child delete should preserve the parent directory"
        );
        assert!(!first.exists());
        assert!(!second.exists());
        assert_eq!(read_manifest(&app_dir).len(), 2);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_intercept_powershell_env_workdir_wildcard_moves_children() {
        let base = std::env::temp_dir().join("agentvis_trash_test_ps_env_workdir_wildcard");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let nested = workdir.join("nested");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&app_dir);
        let _ = std::fs::create_dir_all(&nested);

        let first = workdir.join("first.txt");
        let second = nested.join("second.txt");
        std::fs::write(&first, "first").unwrap();
        std::fs::write(&second, "second").unwrap();

        let cmd = r#"powershell -NoProfile -Command "$dir = $env:WORKDIR; Remove-Item -Path "$dir\*" -Recurse -Force -ErrorAction SilentlyContinue""#;
        let result = try_intercept_delete(cmd, &app_dir, Some(&workdir));

        assert!(result.is_ok());
        assert_eq!(
            result.unwrap(),
            Some(DELETE_SUCCESS_OBSERVATION.to_string())
        );
        assert!(
            workdir.exists(),
            "env workdir wildcard delete should preserve the parent directory"
        );
        assert!(!first.exists());
        assert!(!nested.exists());
        assert_eq!(read_manifest(&app_dir).len(), 2);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_intercept_powershell_env_appdata_wildcard_moves_children() {
        let base = std::env::temp_dir().join("agentvis_trash_test_ps_env_appdata_wildcard");
        let roaming = base.join("roaming");
        let app_dir = roaming.join("com.agentvis.app");
        let workdir = app_dir
            .join("deliverables")
            .join("Test_Team")
            .join("Tester7");
        let nested = workdir.join("nested");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&nested);

        let first = workdir.join("first.txt");
        let second = nested.join("second.txt");
        std::fs::write(&first, "first").unwrap();
        std::fs::write(&second, "second").unwrap();

        let cmd = r#"powershell -NoProfile -Command "Remove-Item -Path "$env:APPDATA\com.agentvis.app\deliverables\Test_Team\Tester7\*" -Recurse -Force""#;
        let result = try_intercept_delete(cmd, &app_dir, Some(&workdir));

        assert!(result.is_ok());
        assert_eq!(
            result.unwrap(),
            Some(DELETE_SUCCESS_OBSERVATION.to_string())
        );
        assert!(
            workdir.exists(),
            "env APPDATA wildcard delete should preserve the parent directory"
        );
        assert!(!first.exists());
        assert!(!nested.exists());
        assert_eq!(read_manifest(&app_dir).len(), 2);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_unresolved_powershell_delete_variable_fails_closed() {
        let base = std::env::temp_dir().join("agentvis_trash_test_unresolved_ps_env");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&workdir);

        let test_file = workdir.join("keep_me.txt");
        std::fs::write(&test_file, "test content").unwrap();

        let cmd = r#"powershell -NoProfile -Command "Remove-Item -Path "$env:AGENTVIS_UNKNOWN_DELETE_ROOT\*" -Recurse -Force""#;
        let result = try_intercept_delete(cmd, &app_dir, Some(&workdir));

        assert!(matches!(result, Err(AppError::Forbidden(_))));
        assert!(test_file.exists());
        assert!(read_manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_intercept_powershell_env_workdir_foreach_moves_children() {
        let base = std::env::temp_dir().join("agentvis_trash_test_ps_env_workdir_foreach");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let nested = workdir.join("nested");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&app_dir);
        let _ = std::fs::create_dir_all(&nested);

        let first = workdir.join("first.txt");
        let second = nested.join("second.txt");
        std::fs::write(&first, "first").unwrap();
        std::fs::write(&second, "second").unwrap();

        let cmd = r#"powershell -NoProfile -Command "$dir = $env:WORKDIR; $items = Get-ChildItem -Path $dir; $fileCount = 0; $dirCount = 0; foreach ($item in $items) { if ($item.PSIsContainer) { $subFiles = (Get-ChildItem -LiteralPath $item.FullName -Recurse -File).Count; $subDirs = (Get-ChildItem -LiteralPath $item.FullName -Recurse -Directory).Count; $fileCount += $subFiles; $dirCount += ($subDirs + 1); Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction SilentlyContinue } else { $fileCount += 1; Remove-Item -LiteralPath $item.FullName -Force -ErrorAction SilentlyContinue } }; Write-Host ('Deleted files: ' + $fileCount); Write-Host ('Deleted directories (incl. subdirs): ' + $dirCount)""#;
        let result = try_intercept_delete(cmd, &app_dir, Some(&workdir));

        assert!(result.is_ok());
        assert_eq!(
            result.unwrap(),
            Some(DELETE_SUCCESS_OBSERVATION.to_string())
        );
        assert!(
            workdir.exists(),
            "env workdir foreach delete should preserve the parent directory"
        );
        assert!(!first.exists());
        assert!(!nested.exists());
        assert_eq!(read_manifest(&app_dir).len(), 2);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_intercept_relative_file_uses_workdir() {
        let base = std::env::temp_dir().join("agentvis_trash_test_relative_workdir");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&app_dir);
        let _ = std::fs::create_dir_all(&workdir);

        let test_file = workdir.join("relative_delete_me.txt");
        std::fs::write(&test_file, "test content").unwrap();

        let result = try_intercept_delete("del relative_delete_me.txt", &app_dir, Some(&workdir));

        assert!(result.is_ok());
        let msg = result.unwrap();
        assert!(msg.is_some(), "应按 workdir 拦截相对路径删除");
        let observation = msg.unwrap();
        assert_eq!(observation, DELETE_SUCCESS_OBSERVATION);
        assert!(!observation.to_lowercase().contains("trash"));
        assert!(!observation.contains("Agent_Trash_Bin"));
        assert!(!observation.contains(&app_dir.to_string_lossy().to_string()));
        assert!(!observation.contains(&test_file.to_string_lossy().to_string()));
        assert!(!test_file.exists(), "workdir 下的相对目标应被移动");

        let entries = read_manifest(&app_dir);
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].original_path,
            test_file.to_string_lossy().to_string()
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_scoped_intercept_allows_allowed_root_delete() {
        let base = std::env::temp_dir().join("agentvis_trash_test_scoped_allowed");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&app_dir);
        let _ = std::fs::create_dir_all(&workdir);

        let test_file = workdir.join("delete_me.txt");
        std::fs::write(&test_file, "test content").unwrap();
        let allowed_roots = vec![workdir.clone()];

        let result = try_intercept_delete_scoped(
            "del delete_me.txt",
            &app_dir,
            Some(&workdir),
            Some(&allowed_roots),
        );

        assert!(result.is_ok());
        assert_eq!(
            result.unwrap(),
            Some(DELETE_SUCCESS_OBSERVATION.to_string())
        );
        assert!(!test_file.exists(), "allowed root target should be moved");
        assert_eq!(read_manifest(&app_dir).len(), 1);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_scoped_intercept_blocks_outside_allowed_root() {
        let base = std::env::temp_dir().join("agentvis_trash_test_scoped_blocked");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let outside_dir = base.join("outside");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&app_dir);
        let _ = std::fs::create_dir_all(&workdir);
        let _ = std::fs::create_dir_all(&outside_dir);

        let outside_file = outside_dir.join("do_not_delete.txt");
        std::fs::write(&outside_file, "test content").unwrap();
        let allowed_roots = vec![workdir.clone()];
        let cmd = format!("del {}", outside_file.to_string_lossy());

        let result =
            try_intercept_delete_scoped(&cmd, &app_dir, Some(&workdir), Some(&allowed_roots));

        assert!(matches!(result, Err(AppError::Forbidden(_))));
        assert!(
            outside_file.exists(),
            "outside sandbox target must not be moved by host-side Trash Bin"
        );
        assert!(read_manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_scoped_intercept_blocks_mixed_multi_delete() {
        let base = std::env::temp_dir().join("agentvis_trash_test_scoped_multi_blocked");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let outside_dir = base.join("outside");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&app_dir);
        let _ = std::fs::create_dir_all(&workdir);
        let _ = std::fs::create_dir_all(&outside_dir);

        let inside_file = workdir.join("inside.txt");
        let outside_file = outside_dir.join("outside.txt");
        std::fs::write(&inside_file, "inside").unwrap();
        std::fs::write(&outside_file, "outside").unwrap();
        let allowed_roots = vec![workdir.clone()];
        let cmd = format!(
            "del \"{}\" \"{}\"",
            inside_file.to_string_lossy(),
            outside_file.to_string_lossy()
        );

        let result =
            try_intercept_delete_scoped(&cmd, &app_dir, Some(&workdir), Some(&allowed_roots));

        assert!(matches!(result, Err(AppError::Forbidden(_))));
        assert!(inside_file.exists(), "mixed delete should fail closed");
        assert!(
            outside_file.exists(),
            "outside target must remain untouched"
        );
        assert!(read_manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_intercept_multi_delete_observation_hides_trashbin() {
        let base = std::env::temp_dir().join("agentvis_trash_test_multi_observation");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&app_dir);
        let _ = std::fs::create_dir_all(&workdir);

        let first = workdir.join("first.txt");
        let second = workdir.join("second.txt");
        std::fs::write(&first, "first").unwrap();
        std::fs::write(&second, "second").unwrap();

        let result = try_intercept_delete("del first.txt second.txt", &app_dir, Some(&workdir));

        assert!(result.is_ok());
        let observation = result.unwrap().unwrap();
        assert_eq!(observation, DELETE_SUCCESS_OBSERVATION);
        assert!(!observation.to_lowercase().contains("trash"));
        assert!(!observation.contains("Agent_Trash_Bin"));
        assert!(!observation.contains(&app_dir.to_string_lossy().to_string()));
        assert!(!observation.contains(&workdir.to_string_lossy().to_string()));

        assert!(!first.exists());
        assert!(!second.exists());
        assert_eq!(read_manifest(&app_dir).len(), 2);

        let _ = std::fs::remove_dir_all(&base);
    }
}
