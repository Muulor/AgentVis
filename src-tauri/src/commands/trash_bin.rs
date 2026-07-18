//! Agent Trash Bin — 删除命令拦截与软删除
//!
//! 将 Agent 的删除操作重写为"移动到回收站"，实现可恢复的删除。
//!
//! 设计原则：
//! - 拦截 del/rmdir/erase/Remove-Item 格式
//! - 删除意图无法安全转换时 fail closed，绝不回退原始删除命令
//! - 卷不参与删除授权；同卷使用原子移动，跨卷使用复制校验与短期源端 claim
//! - 提供 30 天过期清理能力；是否调度由应用启动流程显式决定
//! - manifest.json 记录完整删除元数据，支持手动恢复

use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use tauri::Manager;

use super::{command_validator, trash_transfer};
use crate::error::{AppError, CommandResult};

// fs2 用于文件排他锁，保证 manifest 并发写入安全
use fs2::FileExt;

// ==================== 常量 ====================

/// Trash Bin 目录名
const TRASH_BIN_DIR: &str = "Agent_Trash_Bin";

/// Manifest 文件名
const MANIFEST_FILE: &str = "trash_manifest.json";

/// Manifest 使用独立锁文件，避免锁住 manifest 本体后无法原子替换。
const MANIFEST_LOCK_FILE: &str = "trash_manifest.lock";

/// 新版条目使用不可预测的目录保存 payload，manifest 中的 trashPath 仅用于展示兼容。
const TRASH_ITEMS_DIR: &str = "items";
const MAX_MANIFEST_BYTES: u64 = 32 * 1024 * 1024;
const MAX_DELETE_TARGETS: usize = 256;
const DELETE_ENUMERATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
const MANIFEST_LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
const MANIFEST_LOCK_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(10);
const MANIFEST_LOCK_TIMEOUT_MESSAGE: &str = "Timed out waiting for the Trash Bin manifest lock.";
const TRASH_LIST_BUSY_RETRY_AFTER_MS: u64 = 750;

/// 默认保留天数
const DEFAULT_RETENTION_DAYS: u64 = 30;
const DELETE_SUCCESS_OBSERVATION: &str = "Deleted successfully.";
const DELETE_UNSAFE_BLOCK_MESSAGE: &str =
    "Safety block [recoverable_delete_required]: delete-like command could not be safely moved to Agent Trash Bin. Retry once with one direct supported literal-path delete command; if that is also blocked, stop and report it without bypassing soft deletion.";
const DELETE_UNAVAILABLE_BLOCK_MESSAGE: &str =
    "Safety block [recoverable_delete_unavailable]: deletion did not complete safely. Preserve the current target and report that the operation was not completed.";
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
    /// 新版条目的存储目录 UUID。旧 manifest 没有该字段，继续校验并使用 legacy trashPath。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    storage_id: Option<String>,
    /// 可协调移动状态；跨卷事务会持久化 candidate、短期源端 claim 与最终 payload
    /// 已验证、可独立恢复的边界。
    #[serde(default)]
    state: TrashEntryState,
    /// 恢复事务 journal。目标卷 staging 使用可重建 UUID，避免提交后崩溃形成永久冲突。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    restore: Option<TrashRestoreTransaction>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
enum TrashEntryState {
    Pending,
    PayloadReady,
    Claimed,
    PayloadVerified,
    #[default]
    Ready,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TrashRestoreTransaction {
    id: String,
    owner_token: String,
    state: TrashRestoreState,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum TrashRestoreState {
    Preparing,
    Committed,
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

/// Agent Trash 列表的可观察加载状态。
#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TrashBinListStatus {
    Ready,
    Busy,
}

/// Agent Trash 列表结果。
///
/// manifest 正由恢复或删除事务占用时返回 `busy`，而不是把暂时不可读误报为加载失败
/// 或真实空列表。前端可根据 `retryAfterMs` 进行有界重试。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashBinListResult {
    pub status: TrashBinListStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<TrashEntryInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
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

fn get_trash_items_dir(app_data_dir: &Path) -> PathBuf {
    get_trash_bin_dir(app_data_dir).join(TRASH_ITEMS_DIR)
}

fn ensure_trash_root_safe(app_data_dir: &Path) -> Result<PathBuf, AppError> {
    std::fs::create_dir_all(app_data_dir).map_err(|error| {
        AppError::FileSystem(format!("Failed to create app data directory: {}", error))
    })?;
    let trash_root = get_trash_bin_dir(app_data_dir);
    match std::fs::symlink_metadata(&trash_root) {
        Ok(metadata)
            if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) =>
        {
            return Err(AppError::Forbidden(
                "Trash Bin root cannot be a symbolic link, junction, or reparse point.".to_string(),
            ));
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err(AppError::Forbidden(
                "Trash Bin root is not a directory owned by AgentVis.".to_string(),
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(&trash_root).map_err(|error| {
                AppError::FileSystem(format!("Failed to create Trash Bin root: {}", error))
            })?;
        }
        Err(error) => {
            return Err(AppError::FileSystem(format!(
                "Failed to inspect Trash Bin root: {}",
                error
            )));
        }
    }

    let canonical_app_data = std::fs::canonicalize(app_data_dir).map_err(|error| {
        AppError::FileSystem(format!("Failed to resolve app data directory: {}", error))
    })?;
    let canonical_trash_root = std::fs::canonicalize(&trash_root).map_err(|error| {
        AppError::FileSystem(format!("Failed to resolve Trash Bin root: {}", error))
    })?;
    if !path_is_inside_root(&canonical_app_data, &canonical_trash_root) {
        return Err(AppError::Forbidden(
            "Trash Bin root resolved outside the AgentVis app data directory.".to_string(),
        ));
    }
    Ok(canonical_trash_root)
}

/// 生成回收站中的目标路径。
///
/// 新条目不再把原路径编码进文件名：完整 UUID 同时消除秒级碰撞、Unicode 字节截断
/// panic 和超长路径问题。manifest 仍保留 originalPath 供用户恢复与审计。
fn generate_trash_path(app_data_dir: &Path, storage_id: &str) -> PathBuf {
    get_trash_items_dir(app_data_dir)
        .join(storage_id)
        .join("payload")
}

fn generate_entry_id() -> String {
    format!(
        "{}_{}",
        chrono::Local::now().format("%Y%m%d%H%M%S"),
        uuid::Uuid::new_v4()
    )
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

fn app_data_dir_from_handle(app_handle: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app_handle
        .path()
        .app_data_dir()
        .map_err(|error| AppError::FileSystem(format!("Failed to resolve app data dir: {}", error)))
}

fn trash_entry_info(app_data_dir: &Path, entry: &TrashEntry) -> TrashEntryInfo {
    let original_path = Path::new(&entry.original_path);
    let effective_trash_path = effective_trash_path(app_data_dir, entry).ok();
    let display_trash_path = effective_trash_path
        .as_ref()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    let entry_is_valid = effective_trash_path.is_some();

    TrashEntryInfo {
        id: entry.id.clone(),
        original_path: entry.original_path.clone(),
        trash_path: display_trash_path,
        deleted_at: entry.deleted_at.clone(),
        command: entry.command.clone(),
        batch_id: entry.batch_id.clone().unwrap_or_else(|| entry.id.clone()),
        is_directory: entry.is_directory,
        original_exists: entry_is_valid && std::fs::symlink_metadata(original_path).is_ok(),
        trash_exists: effective_trash_path
            .as_ref()
            .is_some_and(|path| std::fs::symlink_metadata(path).is_ok()),
    }
}

// ==================== Manifest 管理 ====================

fn open_manifest_lock(app_data_dir: &Path) -> Result<std::fs::File, AppError> {
    let trash_dir = ensure_trash_root_safe(app_data_dir)?;

    let lock_path = trash_dir.join(MANIFEST_LOCK_FILE);
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|e| AppError::FileSystem(format!("Failed to open manifest lock: {}", e)))?;
    acquire_manifest_lock(&file, MANIFEST_LOCK_TIMEOUT)?;
    Ok(file)
}

fn acquire_manifest_lock(
    file: &std::fs::File,
    timeout: std::time::Duration,
) -> Result<(), AppError> {
    let deadline = std::time::Instant::now()
        .checked_add(timeout)
        .unwrap_or_else(std::time::Instant::now);

    loop {
        match FileExt::try_lock_exclusive(file) {
            Ok(()) => return Ok(()),
            Err(error) if manifest_lock_is_contended(&error) => {
                let now = std::time::Instant::now();
                if now >= deadline {
                    return Err(AppError::FileSystem(
                        MANIFEST_LOCK_TIMEOUT_MESSAGE.to_string(),
                    ));
                }
                std::thread::sleep(
                    MANIFEST_LOCK_RETRY_DELAY.min(deadline.saturating_duration_since(now)),
                );
            }
            Err(error) => {
                return Err(AppError::FileSystem(format!(
                    "Failed to acquire exclusive manifest lock: {}",
                    error
                )));
            }
        }
    }
}

fn is_manifest_lock_timeout(error: &AppError) -> bool {
    matches!(
        error,
        AppError::FileSystem(message) if message == MANIFEST_LOCK_TIMEOUT_MESSAGE
    )
}

fn manifest_lock_is_contended(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::WouldBlock {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        // LockFileEx reports sharing/lock violations as raw Win32 errors rather than WouldBlock.
        matches!(error.raw_os_error(), Some(32 | 33))
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

fn read_manifest_unlocked(app_data_dir: &Path) -> Result<Vec<TrashEntry>, AppError> {
    use std::io::Read;

    let path = get_manifest_path(app_data_dir);
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(AppError::FileSystem(format!(
                "Failed to open Trash Bin manifest: {}",
                error
            )));
        }
    };
    if file
        .metadata()
        .map_err(|error| {
            AppError::FileSystem(format!("Failed to inspect Trash Bin manifest: {}", error))
        })?
        .len()
        > MAX_MANIFEST_BYTES
    {
        return Err(AppError::FileSystem(format!(
            "Trash Bin manifest exceeds the {} byte safety limit.",
            MAX_MANIFEST_BYTES
        )));
    }
    let mut bytes = Vec::new();
    file.take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            AppError::FileSystem(format!("Failed to read Trash Bin manifest: {}", error))
        })?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(AppError::FileSystem(format!(
            "Trash Bin manifest exceeds the {} byte safety limit.",
            MAX_MANIFEST_BYTES
        )));
    }
    let content = String::from_utf8(bytes).map_err(|error| {
        AppError::FileSystem(format!("Trash Bin manifest is not valid UTF-8: {}", error))
    })?;

    if content.trim().is_empty() {
        return Ok(Vec::new());
    }

    let entries: Vec<TrashEntry> = serde_json::from_str(&content).map_err(|error| {
        log::error!("[TrashBin] manifest 解析失败，拒绝覆盖现有索引: {}", error);
        AppError::FileSystem(format!(
            "Trash Bin manifest is corrupted; recovery index was left untouched: {}",
            error
        ))
    })?;
    validate_manifest_invariants(&entries)?;
    Ok(entries)
}

fn validate_manifest_invariants(entries: &[TrashEntry]) -> Result<(), AppError> {
    let mut ids = std::collections::HashSet::new();
    let mut storage_ids = std::collections::HashSet::new();
    let mut restore_ids = std::collections::HashSet::new();
    let mut restore_owner_tokens = std::collections::HashSet::new();

    for entry in entries {
        if entry.id.trim().is_empty()
            || entry.original_path.trim().is_empty()
            || entry.trash_path.trim().is_empty()
        {
            return Err(AppError::FileSystem(
                "Trash Bin manifest contains an incomplete entry.".to_string(),
            ));
        }
        if !ids.insert(entry.id.as_str()) {
            return Err(AppError::FileSystem(format!(
                "Trash Bin manifest contains duplicate entry id: {}",
                entry.id
            )));
        }
        chrono::DateTime::parse_from_rfc3339(&entry.deleted_at).map_err(|error| {
            AppError::FileSystem(format!(
                "Trash Bin manifest contains an invalid deletion timestamp: {}",
                error
            ))
        })?;
        if let Some(storage_id) = entry.storage_id.as_deref() {
            let parsed = uuid::Uuid::parse_str(storage_id).map_err(|_| {
                AppError::FileSystem(
                    "Trash Bin manifest contains an invalid storage identifier.".to_string(),
                )
            })?;
            if parsed.to_string() != storage_id {
                return Err(AppError::FileSystem(
                    "Trash Bin manifest contains a non-canonical storage identifier.".to_string(),
                ));
            }
            if !storage_ids.insert(storage_id) {
                return Err(AppError::FileSystem(format!(
                    "Trash Bin manifest contains duplicate storage id: {}",
                    storage_id
                )));
            }
        } else if entry.state != TrashEntryState::Ready {
            return Err(AppError::FileSystem(
                "Trash Bin manifest contains an incomplete transactional entry without a storage identifier."
                    .to_string(),
            ));
        }
        if let Some(restore) = entry.restore.as_ref() {
            let parsed = uuid::Uuid::parse_str(&restore.id).map_err(|_| {
                AppError::FileSystem(
                    "Trash Bin manifest contains an invalid restore identifier.".to_string(),
                )
            })?;
            if parsed.to_string() != restore.id {
                return Err(AppError::FileSystem(
                    "Trash Bin manifest contains a non-canonical restore identifier.".to_string(),
                ));
            }
            if !restore_ids.insert(restore.id.as_str()) {
                return Err(AppError::FileSystem(format!(
                    "Trash Bin manifest contains duplicate restore id: {}",
                    restore.id
                )));
            }
            let owner_token = uuid::Uuid::parse_str(&restore.owner_token).map_err(|_| {
                AppError::FileSystem(
                    "Trash Bin manifest contains an invalid restore owner token.".to_string(),
                )
            })?;
            if owner_token.to_string() != restore.owner_token {
                return Err(AppError::FileSystem(
                    "Trash Bin manifest contains a non-canonical restore owner token.".to_string(),
                ));
            }
            if !restore_owner_tokens.insert(restore.owner_token.as_str()) {
                return Err(AppError::FileSystem(
                    "Trash Bin manifest contains a duplicate restore owner token.".to_string(),
                ));
            }
            if entry.state != TrashEntryState::Ready {
                return Err(AppError::FileSystem(
                    "Trash Bin manifest overlaps delete and restore transactions.".to_string(),
                ));
            }
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn replace_manifest_file(temp_path: &Path, manifest_path: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let temp: Vec<u16> = temp_path.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = manifest_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let moved = unsafe {
        MoveFileExW(
            temp.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn replace_manifest_file(temp_path: &Path, manifest_path: &Path) -> std::io::Result<()> {
    std::fs::rename(temp_path, manifest_path)
}

fn write_manifest_atomic_unlocked(
    app_data_dir: &Path,
    entries: &[TrashEntry],
) -> Result<(), AppError> {
    use std::io::Write;

    validate_manifest_invariants(entries)?;
    let trash_dir = get_trash_bin_dir(app_data_dir);
    std::fs::create_dir_all(&trash_dir).map_err(|e| {
        AppError::FileSystem(format!("Failed to create Trash Bin directory: {}", e))
    })?;
    let manifest_path = get_manifest_path(app_data_dir);
    let temp_path = trash_dir.join(format!(".{}.{}.tmp", MANIFEST_FILE, uuid::Uuid::new_v4()));
    let content = serde_json::to_vec_pretty(entries)
        .map_err(|e| AppError::Generic(format!("Failed to serialize manifest: {}", e)))?;
    if content.len() > MAX_MANIFEST_BYTES as usize {
        return Err(AppError::FileSystem(format!(
            "Trash Bin manifest exceeds the {} byte safety limit.",
            MAX_MANIFEST_BYTES
        )));
    }

    let write_result = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        file.write_all(&content)?;
        file.sync_all()?;
        replace_manifest_file(&temp_path, &manifest_path)?;
        sync_manifest_parent(&trash_dir)
    })();

    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&temp_path);
        return Err(AppError::FileSystem(format!(
            "Failed to atomically write Trash Bin manifest: {}",
            error
        )));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn sync_manifest_parent(_path: &Path) -> std::io::Result<()> {
    // MOVEFILE_WRITE_THROUGH above provides the Windows durability barrier.
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn sync_manifest_parent(path: &Path) -> std::io::Result<()> {
    std::fs::File::open(path)?.sync_all()
}

/// 在 sidecar 排他锁下读取 manifest。解析失败时 fail closed，绝不降级为空索引。
fn read_manifest(app_data_dir: &Path) -> Result<Vec<TrashEntry>, AppError> {
    let _lock = open_manifest_lock(app_data_dir)?;
    read_manifest_unlocked(app_data_dir)
}

/// 以排他锁方式追加一条记录到 manifest。
#[cfg(test)]
fn append_to_manifest(app_data_dir: &Path, entry: TrashEntry) -> Result<(), AppError> {
    with_locked_manifest(app_data_dir, |entries| {
        entries.push(entry);
        Ok(())
    })
}

fn with_locked_manifest<R, F>(app_data_dir: &Path, mutate: F) -> Result<R, AppError>
where
    F: FnOnce(&mut Vec<TrashEntry>) -> Result<R, AppError>,
{
    let _lock = open_manifest_lock(app_data_dir)?;
    let mut entries = read_manifest_unlocked(app_data_dir)?;
    let result = mutate(&mut entries)?;
    write_manifest_atomic_unlocked(app_data_dir, &entries)?;
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

fn validate_trash_payload_path(
    app_data_dir: &Path,
    trash_path: &Path,
) -> Result<PathBuf, AppError> {
    let trash_root = normalize_path_lexically(&get_trash_bin_dir(app_data_dir));
    let normalized = normalize_path_lexically(trash_path);
    if normalized == trash_root || !path_is_inside_root(&trash_root, &normalized) {
        return Err(AppError::Forbidden(
            "Trash Bin entry rejected a payload path outside Agent_Trash_Bin.".to_string(),
        ));
    }

    let canonical_root = ensure_trash_root_safe(app_data_dir)?;
    let parent = normalized.parent().ok_or_else(|| {
        AppError::Forbidden("Trash Bin payload has no safe parent directory.".to_string())
    })?;
    let resolved_parent = canonicalize_for_boundary(parent)?;
    if !path_is_inside_root(&canonical_root, &resolved_parent) {
        return Err(AppError::Forbidden(
            "Trash Bin entry rejected a linked payload parent outside Agent_Trash_Bin.".to_string(),
        ));
    }
    match std::fs::symlink_metadata(&normalized) {
        Ok(metadata) => {
            if !metadata.file_type().is_symlink() && !metadata_is_reparse_point(&metadata) {
                let canonical_payload = std::fs::canonicalize(&normalized).map_err(|error| {
                    AppError::FileSystem(format!(
                        "Failed to resolve Trash Bin payload path: {}",
                        error
                    ))
                })?;
                if !path_is_inside_root(&canonical_root, &canonical_payload) {
                    return Err(AppError::Forbidden(
                        "Trash Bin entry rejected a linked payload outside Agent_Trash_Bin."
                            .to_string(),
                    ));
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(AppError::FileSystem(format!(
                "Failed to inspect Trash Bin payload path: {}",
                error
            )));
        }
    }

    Ok(normalized)
}

#[cfg(target_os = "windows")]
fn metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(target_os = "windows"))]
fn metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn effective_trash_path(app_data_dir: &Path, entry: &TrashEntry) -> Result<PathBuf, AppError> {
    let path = match entry.storage_id.as_deref() {
        Some(storage_id) => {
            uuid::Uuid::parse_str(storage_id).map_err(|_| {
                AppError::Forbidden(
                    "Trash Bin entry has an invalid storage identifier.".to_string(),
                )
            })?;
            generate_trash_path(app_data_dir, storage_id)
        }
        None => {
            let legacy_path = normalize_path_lexically(Path::new(&entry.trash_path));
            let legacy_parent = legacy_path.parent().map(normalize_path_lexically);
            let trash_root = normalize_path_lexically(&get_trash_bin_dir(app_data_dir));
            if legacy_parent.as_ref() != Some(&trash_root) {
                return Err(AppError::Forbidden(
                    "Legacy Trash Bin entry rejected a payload outside the Trash Bin root."
                        .to_string(),
                ));
            }
            let file_name = legacy_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            if file_name.eq_ignore_ascii_case(MANIFEST_FILE)
                || file_name.eq_ignore_ascii_case(MANIFEST_LOCK_FILE)
                || file_name.eq_ignore_ascii_case(TRASH_ITEMS_DIR)
            {
                return Err(AppError::Forbidden(
                    "Legacy Trash Bin entry points to reserved Trash Bin metadata.".to_string(),
                ));
            }
            legacy_path
        }
    };
    validate_trash_payload_path(app_data_dir, &path)
}

fn path_presence(path: &Path) -> std::io::Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn reconcile_verified_claim_cleanup(
    app_data_dir: &Path,
    entries: &mut [TrashEntry],
    manifest_index: usize,
    claim_path: &Path,
    payload_path: &Path,
    candidate_path: &Path,
    verify_before_cleanup: bool,
) -> Result<(), String> {
    if verify_before_cleanup {
        trash_transfer::verify_claim_payload(claim_path, payload_path)
            .map_err(|error| format!("final claim/payload verification failed: {error}"))?;
        entries[manifest_index].state = TrashEntryState::PayloadVerified;
        write_manifest_atomic_unlocked(app_data_dir, entries)
            .map_err(|error| format!("PayloadVerified manifest state commit failed: {error}"))?;
    }

    trash_transfer::finish_verified_claim_cleanup(claim_path)
        .map_err(|error| format!("verified claim cleanup failed: {error}"))?;
    trash_transfer::remove_candidate_if_present(candidate_path)
        .map_err(|error| format!("candidate cleanup failed: {error}"))?;
    entries[manifest_index].state = TrashEntryState::Ready;
    Ok(())
}

fn reconcile_incomplete_entries(app_data_dir: &Path) -> Result<(), AppError> {
    with_locked_manifest(app_data_dir, |entries| {
        let mut remove_ids = std::collections::HashSet::new();

        for index in 0..entries.len() {
            if let Some(restore) = entries[index].restore.clone() {
                let Ok(trash_path) = effective_trash_path(app_data_dir, &entries[index]) else {
                    continue;
                };
                let entry_id = entries[index].id.clone();
                let original_path = PathBuf::from(&entries[index].original_path);
                let trash_exists = match path_presence(&trash_path) {
                    Ok(exists) => exists,
                    Err(error) => {
                        log::warn!(
                            "[TrashBin] retained restore {} after payload inspection failed: {}",
                            entry_id,
                            error
                        );
                        continue;
                    }
                };
                let original_exists = match path_presence(&original_path) {
                    Ok(exists) => exists,
                    Err(error) => {
                        log::warn!(
                            "[TrashBin] retained restore {} after destination inspection failed: {}",
                            entry_id,
                            error
                        );
                        continue;
                    }
                };

                match (original_exists, trash_exists) {
                    (true, true) => {
                        if restore.state == TrashRestoreState::Preparing {
                            if let Err(error) =
                                trash_transfer::verify_restore_commit(&trash_path, &original_path)
                            {
                                log::warn!(
                                    "[TrashBin] retained preparing restore {} after commit verification failed: {}",
                                    entry_id,
                                    error
                                );
                                continue;
                            }
                            if let Some(transaction) = entries[index].restore.as_mut() {
                                transaction.state = TrashRestoreState::Committed;
                            }
                            if let Err(error) =
                                write_manifest_atomic_unlocked(app_data_dir, entries)
                            {
                                log::warn!(
                                    "[TrashBin] retained verified restore {} after Committed journal write failed: {}",
                                    entry_id,
                                    error
                                );
                                continue;
                            }
                        }
                        match trash_transfer::finish_committed_restore(
                            &trash_path,
                            &original_path,
                            &restore.id,
                            &restore.owner_token,
                        ) {
                            Ok(()) => {
                                remove_ids.insert(entry_id);
                            }
                            Err(error) => log::warn!(
                                "[TrashBin] retained committed restore {} after cleanup failed: {}",
                                entry_id,
                                error
                            ),
                        }
                    }
                    (true, false) => {
                        // 同卷 rename 已提交，或跨卷中央副本已清除但 manifest 删除中断。
                        if restore.state == TrashRestoreState::Preparing {
                            if let Err(error) =
                                trash_transfer::verify_restore_commit(&trash_path, &original_path)
                            {
                                log::warn!(
                                    "[TrashBin] retained preparing same-volume restore {} after verification failed: {}",
                                    entry_id,
                                    error
                                );
                                continue;
                            }
                            if let Some(transaction) = entries[index].restore.as_mut() {
                                transaction.state = TrashRestoreState::Committed;
                            }
                            if let Err(error) =
                                write_manifest_atomic_unlocked(app_data_dir, entries)
                            {
                                log::warn!(
                                    "[TrashBin] retained same-volume restore {} after Committed journal write failed: {}",
                                    entry_id,
                                    error
                                );
                                continue;
                            }
                        }
                        match trash_transfer::restore_staging_is_owned(
                            &original_path,
                            &restore.id,
                            &restore.owner_token,
                        ) {
                            Ok(true) => match trash_transfer::discard_restore_staging(
                                &original_path,
                                &restore.id,
                                &restore.owner_token,
                            ) {
                                Ok(()) => {
                                    remove_ids.insert(entry_id);
                                }
                                Err(error) => log::warn!(
                                    "[TrashBin] retained restored entry {} after owned staging cleanup failed: {}",
                                    entry_id,
                                    error
                                ),
                            },
                            Ok(false) => {
                                // 同卷恢复没有 staging；碰撞路径也绝不由本事务接管。
                                remove_ids.insert(entry_id);
                            }
                            Err(error) => log::warn!(
                                "[TrashBin] retained restored entry {} after staging ownership inspection failed: {}",
                                entry_id,
                                error
                            ),
                        }
                    }
                    (false, true) => {
                        if restore.state == TrashRestoreState::Committed {
                            // 目标曾完整提交但后来不可见，而中央 payload 可能已部分清理；
                            // 保留 journal，不能把它重新声明为完整 Ready 副本。
                            log::warn!(
                                "[TrashBin] retained committed restore {} because its destination disappeared",
                                entry_id
                            );
                            continue;
                        }
                        // Preparing 尚未开始中央清理；清理确定性 staging 后可安全重试。
                        match trash_transfer::restore_staging_is_owned(
                            &original_path,
                            &restore.id,
                            &restore.owner_token,
                        ) {
                            Ok(true) => match trash_transfer::discard_restore_staging(
                                &original_path,
                                &restore.id,
                                &restore.owner_token,
                            ) {
                                Ok(()) => entries[index].restore = None,
                                Err(error) => log::warn!(
                                    "[TrashBin] retained interrupted restore {} after owned staging cleanup failed: {}",
                                    entry_id,
                                    error
                                ),
                            },
                            Ok(false) => {
                                // 没有匹配 owner marker 的路径不属于本事务；绝不删除，
                                // 只清除尚未提交的 journal 以允许使用新 UUID 重试。
                                entries[index].restore = None;
                            }
                            Err(error) => log::warn!(
                                "[TrashBin] retained interrupted restore {} after staging ownership inspection failed: {}",
                                entry_id,
                                error
                            ),
                        }
                    }
                    (false, false) => {
                        // 两份数据都不可见时保留 journal，不自动丢弃恢复证据。
                    }
                }
                continue;
            }

            let entry = &mut entries[index];
            if entry.state == TrashEntryState::Ready {
                continue;
            }
            let Ok(trash_path) = effective_trash_path(app_data_dir, entry) else {
                continue;
            };
            let Some(storage_id) = entry.storage_id.as_deref() else {
                continue;
            };
            let source_path = Path::new(&entry.original_path);
            let Ok(candidate_path) = trash_transfer::candidate_path(&trash_path) else {
                continue;
            };
            let Ok(claim_path) = trash_transfer::claim_path(source_path, storage_id) else {
                continue;
            };
            let payload_exists = match path_presence(&trash_path) {
                Ok(exists) => exists,
                Err(error) => {
                    log::warn!(
                        "[TrashBin] retained incomplete entry {} after payload inspection failed: {}",
                        entry.id,
                        error
                    );
                    continue;
                }
            };
            let source_exists = match path_presence(source_path) {
                Ok(exists) => exists,
                Err(error) => {
                    log::warn!(
                        "[TrashBin] retained incomplete entry {} after source inspection failed: {}",
                        entry.id,
                        error
                    );
                    continue;
                }
            };
            let claim_exists = match path_presence(&claim_path) {
                Ok(exists) => exists,
                Err(error) => {
                    log::warn!(
                        "[TrashBin] retained incomplete entry {} after claim inspection failed: {}",
                        entry.id,
                        error
                    );
                    continue;
                }
            };

            if entry.state == TrashEntryState::PayloadVerified {
                if !payload_exists {
                    log::warn!(
                        "[TrashBin] retained payload-verified entry {} because its final payload is missing",
                        entry.id
                    );
                    continue;
                }
                let entry_id = entry.id.clone();
                match reconcile_verified_claim_cleanup(
                    app_data_dir,
                    entries,
                    index,
                    &claim_path,
                    &trash_path,
                    &candidate_path,
                    false,
                ) {
                    Ok(()) => {}
                    Err(error) => log::warn!(
                        "[TrashBin] retained payload-verified entry {} after cleanup failed: {}",
                        entry_id,
                        error
                    ),
                }
                continue;
            }

            if payload_exists
                && !claim_exists
                && (entry.state == TrashEntryState::Claimed || !source_exists)
            {
                // 同卷 rename 已完成，或 claim 已清除但 Ready 写入中断。新跨卷事务会先
                // 持久化 PayloadVerified；这里还兼容此前已经发布且不再有 claim 的现场。
                match trash_transfer::remove_candidate_if_present(&candidate_path) {
                    Ok(()) => entry.state = TrashEntryState::Ready,
                    Err(error) => log::warn!(
                        "[TrashBin] retained incomplete entry {} after candidate cleanup failed: {}",
                        entry.id,
                        error
                    ),
                }
                continue;
            }

            if claim_exists && (entry.state == TrashEntryState::Claimed || !source_exists) {
                entry.state = TrashEntryState::Claimed;
                if payload_exists {
                    // payload 可能是已发布结果，也可能来自碰撞/外部变化；必须再次逐字节
                    // 核对并先持久化 PayloadVerified，之后才能幂等清理该精确 claim。
                    let entry_id = entry.id.clone();
                    match reconcile_verified_claim_cleanup(
                        app_data_dir,
                        entries,
                        index,
                        &claim_path,
                        &trash_path,
                        &candidate_path,
                        true,
                    ) {
                        Ok(()) => {}
                        Err(error) => log::warn!(
                            "[TrashBin] retained claimed entry {} after cleanup failed: {}",
                            entry_id,
                            error
                        ),
                    }
                    continue;
                }

                let candidate_exists = match path_presence(&candidate_path) {
                    Ok(exists) => exists,
                    Err(error) => {
                        log::warn!(
                            "[TrashBin] retained claimed entry {} after candidate inspection failed: {}",
                            entry.id,
                            error
                        );
                        continue;
                    }
                };
                let candidate_matches = if candidate_exists {
                    match trash_transfer::items_match(&claim_path, &candidate_path) {
                        Ok(matches) => matches,
                        Err(error) => {
                            log::warn!(
                                "[TrashBin] retained claimed entry {} after candidate comparison failed: {}",
                                entry.id,
                                error
                            );
                            continue;
                        }
                    }
                } else {
                    false
                };
                let candidate_ready = if candidate_matches {
                    true
                } else {
                    match trash_transfer::refresh_candidate_from_source(
                        &claim_path,
                        &candidate_path,
                    ) {
                        Ok(()) => true,
                        Err(error) => {
                            log::warn!(
                                "[TrashBin] retained claimed entry {} after candidate recovery failed: {}",
                                entry.id,
                                error
                            );
                            false
                        }
                    }
                };
                if !candidate_ready {
                    continue;
                }
                if let Err(error) = trash_transfer::publish_candidate(&candidate_path, &trash_path)
                {
                    log::warn!(
                        "[TrashBin] retained claimed entry {} after payload publish failed: {}",
                        entry.id,
                        error
                    );
                    continue;
                }
                let entry_id = entry.id.clone();
                match reconcile_verified_claim_cleanup(
                    app_data_dir,
                    entries,
                    index,
                    &claim_path,
                    &trash_path,
                    &candidate_path,
                    true,
                ) {
                    Ok(()) => {}
                    Err(error) => log::warn!(
                        "[TrashBin] retained claimed entry {} after final cleanup failed: {}",
                        entry_id,
                        error
                    ),
                }
                continue;
            }

            match entry.state {
                TrashEntryState::Pending | TrashEntryState::PayloadReady
                    if source_exists && !payload_exists =>
                {
                    // 事务尚未改变源命名空间；清除 candidate 后即可丢弃未完成记录。
                    match trash_transfer::remove_candidate_if_present(&candidate_path) {
                        Ok(()) => {
                            remove_ids.insert(entry.id.clone());
                        }
                        Err(error) => log::warn!(
                            "[TrashBin] retained uncommitted entry {} after candidate cleanup failed: {}",
                            entry.id,
                            error
                        ),
                    }
                }
                _ => {
                    // source / claim / payload 都不可见，或现场与状态冲突时不自动删除证据。
                }
            }
        }

        if !remove_ids.is_empty() {
            entries.retain(|entry| !remove_ids.contains(&entry.id));
        }
        Ok(())
    })
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

        for index in 0..entries.len() {
            if !predicate(&entries[index]) {
                continue;
            }
            let entry = entries[index].clone();
            if entry.restore.is_some() {
                result
                    .conflicts
                    .push(restore_issue(&entry, "restore_recovery_required"));
                continue;
            }
            if entry.state != TrashEntryState::Ready {
                result
                    .conflicts
                    .push(restore_issue(&entry, "entry_not_ready"));
                continue;
            }

            let trash_path = match effective_trash_path(app_data_dir, &entry) {
                Ok(path) => path,
                Err(error) => {
                    result.conflicts.push(restore_issue(
                        &entry,
                        format!("invalid_trash_path: {}", error),
                    ));
                    continue;
                }
            };
            let original_path = Path::new(&entry.original_path);

            match std::fs::symlink_metadata(&trash_path) {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    result.missing.push(restore_issue(&entry, "trash_missing"));
                    completed_ids.insert(entry.id.clone());
                    continue;
                }
                Err(error) => {
                    result.conflicts.push(restore_issue(
                        &entry,
                        format!("trash_inspection_failed: {}", error),
                    ));
                    continue;
                }
            }

            match path_presence(original_path) {
                Ok(true) => {
                    result
                        .conflicts
                        .push(restore_issue(&entry, "original_exists"));
                    continue;
                }
                Ok(false) => {}
                Err(error) => {
                    result.conflicts.push(restore_issue(
                        &entry,
                        format!("original_inspection_failed: {}", error),
                    ));
                    continue;
                }
            }

            let restore_id = uuid::Uuid::new_v4().to_string();
            let restore_owner_token = uuid::Uuid::new_v4().to_string();
            entries[index].restore = Some(TrashRestoreTransaction {
                id: restore_id.clone(),
                owner_token: restore_owner_token.clone(),
                state: TrashRestoreState::Preparing,
            });
            if let Err(error) = write_manifest_atomic_unlocked(app_data_dir, entries) {
                entries[index].restore = None;
                result.conflicts.push(restore_issue(
                    &entry,
                    format!("restore_journal_failed: {}", error),
                ));
                continue;
            }

            if let Err(error) = trash_transfer::commit_restore(
                &trash_path,
                original_path,
                &restore_id,
                &restore_owner_token,
            ) {
                if !error.is_destination_collision() {
                    if let Err(cleanup_error) = trash_transfer::discard_restore_staging(
                        original_path,
                        &restore_id,
                        &restore_owner_token,
                    ) {
                        result.conflicts.push(restore_issue(
                            &entries[index],
                            format!(
                                "restore_failed: {}; restore_staging_cleanup_failed: {}",
                                error, cleanup_error
                            ),
                        ));
                        continue;
                    }
                }
                entries[index].restore = None;
                if let Err(journal_error) = write_manifest_atomic_unlocked(app_data_dir, entries) {
                    result.conflicts.push(restore_issue(
                        &entry,
                        format!(
                            "restore_failed: {}; restore_journal_cleanup_failed: {}",
                            error, journal_error
                        ),
                    ));
                } else {
                    result
                        .conflicts
                        .push(restore_issue(&entry, format!("restore_failed: {}", error)));
                }
                continue;
            }

            if let Err(error) = trash_transfer::verify_restore_commit(&trash_path, original_path) {
                result.conflicts.push(restore_issue(
                    &entries[index],
                    format!("restore_commit_verification_failed: {}", error),
                ));
                continue;
            }

            if let Some(transaction) = entries[index].restore.as_mut() {
                transaction.state = TrashRestoreState::Committed;
            }
            if let Err(error) = write_manifest_atomic_unlocked(app_data_dir, entries) {
                result.conflicts.push(restore_issue(
                    &entries[index],
                    format!("restore_commit_journal_failed: {}", error),
                ));
                continue;
            }

            match trash_transfer::finish_committed_restore(
                &trash_path,
                original_path,
                &restore_id,
                &restore_owner_token,
            ) {
                Ok(()) => {
                    result.restored_count += 1;
                    result.restored.push(entry.original_path.clone());
                    completed_ids.insert(entry.id.clone());
                }
                Err(error) => result.conflicts.push(restore_issue(
                    &entries[index],
                    format!("restore_cleanup_failed: {}", error),
                )),
            }
        }

        if !completed_ids.is_empty() {
            entries.retain(|entry| !completed_ids.contains(&entry.id));
        }

        Ok(result)
    })
}

fn delete_trash_path(app_data_dir: &Path, entry: &TrashEntry) -> Result<(), AppError> {
    let trash_path = effective_trash_path(app_data_dir, entry)?;

    let metadata = match std::fs::symlink_metadata(&trash_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if entry.storage_id.is_some() {
                if let Some(storage_dir) = trash_path.parent() {
                    let _ = std::fs::remove_dir(storage_dir);
                }
            }
            return Ok(());
        }
        Err(error) => {
            return Err(AppError::FileSystem(format!(
                "Failed to inspect Trash Bin payload before deletion: {}",
                error
            )));
        }
    };

    if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
        let result = if metadata.is_dir() {
            std::fs::remove_dir(&trash_path)
        } else {
            std::fs::remove_file(&trash_path)
        };
        result.map_err(|e| {
            AppError::FileSystem(format!("Failed to delete Trash Bin link safely: {}", e))
        })?;
    } else if metadata.is_dir() {
        std::fs::remove_dir_all(&trash_path).map_err(|e| {
            AppError::FileSystem(format!("Failed to delete Trash Bin directory: {}", e))
        })?;
    } else {
        std::fs::remove_file(&trash_path)
            .map_err(|e| AppError::FileSystem(format!("Failed to delete Trash Bin file: {}", e)))?;
    }

    if entry.storage_id.is_some() {
        if let Some(storage_dir) = trash_path.parent() {
            let _ = std::fs::remove_dir(storage_dir);
        }
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
            if entry.state != TrashEntryState::Ready || entry.restore.is_some() {
                result.failed.push(restore_issue(entry, "entry_not_ready"));
                continue;
            }

            let trash_path = match effective_trash_path(app_data_dir, entry) {
                Ok(path) => path,
                Err(error) => {
                    result.failed.push(restore_issue(
                        entry,
                        format!("invalid_trash_path: {}", error),
                    ));
                    continue;
                }
            };
            match std::fs::symlink_metadata(&trash_path) {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    result.missing.push(restore_issue(entry, "trash_missing"));
                    completed_ids.insert(entry.id.clone());
                    continue;
                }
                Err(error) => {
                    result.failed.push(restore_issue(
                        entry,
                        format!("trash_inspection_failed: {}", error),
                    ));
                    continue;
                }
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
) -> CommandResult<TrashBinListResult> {
    let app_data_dir = app_data_dir_from_handle(&app_handle)?;
    let trash_dir = get_trash_bin_dir(&app_data_dir);
    if !trash_dir.exists() {
        std::fs::create_dir_all(&trash_dir).map_err(|e| {
            AppError::FileSystem(format!("Failed to create Trash Bin directory: {}", e))
        })?;
    }

    if let Err(error) = reconcile_incomplete_entries(&app_data_dir) {
        if is_manifest_lock_timeout(&error) {
            return Ok(TrashBinListResult {
                status: TrashBinListStatus::Busy,
                entries: None,
                retry_after_ms: Some(TRASH_LIST_BUSY_RETRY_AFTER_MS),
            });
        }
        return Err(error);
    }
    let manifest = match read_manifest(&app_data_dir) {
        Ok(manifest) => manifest,
        Err(error) if is_manifest_lock_timeout(&error) => {
            return Ok(TrashBinListResult {
                status: TrashBinListStatus::Busy,
                entries: None,
                retry_after_ms: Some(TRASH_LIST_BUSY_RETRY_AFTER_MS),
            });
        }
        Err(error) => return Err(error),
    };
    let mut entries: Vec<TrashEntryInfo> = manifest
        .iter()
        .filter(|entry| entry.state == TrashEntryState::Ready)
        .map(|entry| trash_entry_info(&app_data_dir, entry))
        .collect();
    entries.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(TrashBinListResult {
        status: TrashBinListStatus::Ready,
        entries: Some(entries),
        retry_after_ms: None,
    })
}

/// 按条目 ID 恢复 Trash Bin 文件，并同步更新 manifest
#[tauri::command]
pub async fn trash_bin_restore_entries(
    app_handle: tauri::AppHandle,
    ids: Vec<String>,
) -> CommandResult<TrashRestoreResult> {
    let app_data_dir = app_data_dir_from_handle(&app_handle)?;
    reconcile_incomplete_entries(&app_data_dir)?;
    let id_set: std::collections::HashSet<String> = ids.into_iter().collect();

    restore_entries_matching(&app_data_dir, |entry| id_set.contains(&entry.id))
}

/// 按批次恢复同一次删除命令产生的 Trash Bin 条目
#[tauri::command]
pub async fn trash_bin_restore_batch(
    app_handle: tauri::AppHandle,
    batch_id: String,
) -> CommandResult<TrashRestoreResult> {
    let app_data_dir = app_data_dir_from_handle(&app_handle)?;
    reconcile_incomplete_entries(&app_data_dir)?;

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
    let app_data_dir = app_data_dir_from_handle(&app_handle)?;
    reconcile_incomplete_entries(&app_data_dir)?;
    let id_set: std::collections::HashSet<String> = ids.into_iter().collect();

    delete_entries_matching(&app_data_dir, |entry| id_set.contains(&entry.id))
}

/// 按批次永久清理同一次删除命令产生的 Trash Bin 条目
#[tauri::command]
pub async fn trash_bin_delete_batch(
    app_handle: tauri::AppHandle,
    batch_id: String,
) -> CommandResult<TrashDeleteResult> {
    let app_data_dir = app_data_dir_from_handle(&app_handle)?;
    reconcile_incomplete_entries(&app_data_dir)?;

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
/// - `powershell -Command "Get-ChildItem -Force *.log | Remove-Item -Force"` (管道删除)
///
/// 返回 None 只表示直接目标解析器不支持该格式；调用方仍须识别删除意图并 fail closed。
#[cfg(test)]
fn extract_delete_target(command: &str) -> Option<(String, bool)> {
    extract_delete_target_with_workdir(command, None)
}

fn extract_delete_target_with_workdir(
    command: &str,
    workdir: Option<&Path>,
) -> Option<(String, bool)> {
    let trimmed = command.trim();

    // PowerShell Remove-Item 及其别名（ri/rm）优先匹配（在链式检查之前）
    // 原因：PowerShell -Command 内的 ; 是 PS 语句分隔符，不应被视为 CMD 管道链
    if contains_powershell_delete_command(trimmed) {
        if let Some(target) = extract_powershell_remove_item_target(trimmed, workdir) {
            return Some(target);
        }
    }

    // 管道删除模式：Get-ChildItem *.ext | Remove-Item
    // 提取管道前 Get-ChildItem 的路径/模式，作为 glob 展开目标
    if let Some(script) = powershell_script(trimmed) {
        let script_lower = script.to_ascii_lowercase();
        if let Some(result) = extract_pipe_delete_target(&script_lower, script) {
            return Some(result);
        }
    }

    // cmd /c 嵌套：提取内部命令并递归解析
    if let Some(inner) = extract_cmd_c_inner(trimmed) {
        return extract_delete_target_with_workdir(&inner, workdir);
    }

    // CMD 命令的链式操作符检查（&&, ||, |, ;）
    // 仅对 del/rmdir/erase 等 CMD 命令应用
    if contains_top_level_cmd_control(trimmed) {
        return None;
    }

    // CMD 只把双引号作为分组符；单引号属于文件名本身。统一复用 token 解析，
    // 同时覆盖 `del/f/q target` / `rmdir/s/q target` 这类内建命令紧凑写法。
    if let Some((command_name, tokens)) = direct_cmd_delete_tokens(trimmed) {
        let target = tokens
            .into_iter()
            .find(|token| !token.starts_with('/') && !token.starts_with('-'));
        let is_directory = matches!(command_name.as_str(), "rmdir" | "rd");
        return target.map(|target| (target, is_directory));
    }

    None
}

/// 从 CMD del/erase 命令中提取多个目标路径。
///
/// CMD 原生支持 `del /f "a.png" "b.png"`，但单目标解析只会拿到第一个
/// 引号参数。删除拦截器一旦返回成功，原始 del 命令就不会再执行，因此这里
/// 需要完整提取所有目标，避免后续文件被静默跳过。
fn extract_cmd_delete_targets(command: &str) -> Option<(Vec<String>, bool)> {
    let (command_name, tokens) = direct_cmd_delete_tokens(command)?;
    if !matches!(command_name.as_str(), "del" | "erase") {
        return None;
    }
    let targets: Vec<String> = tokens
        .into_iter()
        .filter(|token| !token.starts_with('/') && !token.starts_with('-'))
        .collect();
    if targets.is_empty() {
        return None;
    }

    Some((targets, false))
}

fn direct_cmd_delete_tokens(command: &str) -> Option<(String, Vec<String>)> {
    let effective = extract_cmd_c_inner(command).unwrap_or_else(|| command.trim().to_string());
    if contains_top_level_cmd_control(&effective) {
        return None;
    }
    let mut tokens = split_shell_like_paths(&effective);
    let (command_name, mut attached_switches) = parse_cmd_delete_command_token(tokens.first()?)?;
    tokens.remove(0);
    attached_switches.append(&mut tokens);
    let tokens = attached_switches;
    Some((command_name, tokens))
}

/// Parse CMD builtins both in their ordinary form (`del /f`) and in CMD's compact
/// command/switch form (`del/f`). Unknown attached switches are retained so semantic validation
/// can fail closed instead of losing the delete intent.
fn parse_cmd_delete_command_token(token: &str) -> Option<(String, Vec<String>)> {
    let lower = token.trim_start_matches('@').to_ascii_lowercase();
    for command_name in ["rmdir", "erase", "del", "rd"] {
        let Some(suffix) = lower.strip_prefix(command_name) else {
            continue;
        };
        if suffix.is_empty() {
            return Some((command_name.to_string(), Vec::new()));
        }
        if !suffix.starts_with('/') {
            continue;
        }
        let switches = suffix
            .split('/')
            .skip(1)
            .map(|switch| format!("/{switch}"))
            .collect();
        return Some((command_name.to_string(), switches));
    }
    None
}

fn cmd_delete_semantics_supported(command: &str) -> bool {
    let Some((command_name, tokens)) = direct_cmd_delete_tokens(command) else {
        return true;
    };
    let mut targets = Vec::new();
    for token in tokens {
        let lower = token.to_ascii_lowercase();
        if lower.starts_with('/') || lower.starts_with('-') {
            let supported = if matches!(command_name.as_str(), "del" | "erase") {
                matches!(lower.as_str(), "/f" | "/q")
            } else {
                matches!(lower.as_str(), "/s" | "/q")
            };
            if !supported {
                return false;
            }
        } else {
            targets.push(token);
        }
    }

    if matches!(command_name.as_str(), "rmdir" | "rd") {
        return targets.len() == 1 && !targets.iter().any(|target| is_glob_pattern(target));
    }

    !targets
        .iter()
        .any(|target| is_glob_pattern(target) && (target.contains('[') || target.contains(']')))
}

fn cmd_delete_forces_readonly(command: &str) -> bool {
    direct_cmd_delete_tokens(command).is_some_and(|(command_name, tokens)| {
        matches!(command_name.as_str(), "del" | "erase")
            && tokens.iter().any(|token| token.eq_ignore_ascii_case("/f"))
    })
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
            None if ch == '"' => {
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
fn contains_powershell_delete_command(command: &str) -> bool {
    powershell_script(command)
        .and_then(find_ps_delete_command)
        .is_some()
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
    if !powershell_gci_args_have_exact_child_semantics(path_part) {
        return None;
    }

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

fn powershell_gci_args_have_exact_child_semantics(args: &str) -> bool {
    let parameters: Vec<String> = powershell_code_tokens(args)
        .into_iter()
        .filter(|(start, _, _)| powershell_token_is_parameter(args, *start))
        .map(|(_, _, token)| token)
        .collect();
    parameters.iter().any(|parameter| parameter == "force")
        && parameters
            .iter()
            .all(|parameter| matches!(parameter.as_str(), "path" | "literalpath" | "force"))
}

/// 从 cmd /c "..." 中提取内部命令
///
/// 场景：`cmd /c "del C:\path\file.txt"` → 返回 `del C:\path\file.txt`
fn extract_cmd_c_inner(command: &str) -> Option<String> {
    extract_cmd_c_inner_with_autorun_state(command).map(|(inner, _)| inner)
}

fn extract_cmd_c_inner_with_autorun_state(command: &str) -> Option<(String, bool)> {
    let (executable, mut remaining) = shell_executable_and_rest(command)?;
    let executable_segment = executable.rsplit('\\').next().unwrap_or(executable);
    let mut executable_parts = executable_segment.split('/');
    let executable_name = executable_parts.next()?.to_ascii_lowercase();
    if !matches!(
        executable_name.as_str(),
        "cmd" | "cmd.exe" | "%comspec%" | "!comspec!"
    ) {
        return None;
    }
    let mut autorun_disabled = false;
    for option in executable_parts {
        match option.to_ascii_lowercase().as_str() {
            "d" => autorun_disabled = true,
            "c" | "k" => {
                let inner = strip_cmd_outer_double_quotes(remaining);
                return (!inner.is_empty()).then(|| (inner.to_string(), autorun_disabled));
            }
            "q" | "s" | "a" | "u" => {}
            _ => return None,
        }
    }

    while !remaining.is_empty() {
        if remaining.get(..2).is_some_and(|prefix| {
            prefix.eq_ignore_ascii_case("/c") || prefix.eq_ignore_ascii_case("/k")
        }) {
            let inner = strip_cmd_outer_double_quotes(remaining[2..].trim_start());
            return (!inner.is_empty()).then(|| (inner.to_string(), autorun_disabled));
        }
        let Some(option_len) = [
            "/e:off", "/f:off", "/v:off", "/e:on", "/f:on", "/v:on", "/d", "/s", "/q", "/a", "/u",
        ]
        .iter()
        .find_map(|option| {
            remaining
                .get(..option.len())
                .filter(|prefix| prefix.eq_ignore_ascii_case(option))
                .map(|_| option.len())
        }) else {
            return None;
        };
        if remaining[..option_len].eq_ignore_ascii_case("/d") {
            autorun_disabled = true;
        }
        remaining = &remaining[option_len..];
        if !remaining.is_empty()
            && !remaining.starts_with('/')
            && !remaining.chars().next().is_some_and(char::is_whitespace)
        {
            return None;
        }
        remaining = remaining.trim_start();
    }

    None
}

fn shell_executable_and_rest(command: &str) -> Option<(&str, &str)> {
    let trimmed = command.trim();
    let trimmed = trimmed.strip_prefix('@').unwrap_or(trimmed).trim_start();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(after_quote) = trimmed.strip_prefix('"') {
        let closing_quote = after_quote.find('"')?;
        let executable = &after_quote[..closing_quote];
        let rest = &after_quote[closing_quote + 1..];
        return Some((executable, rest.trim_start()));
    }

    let executable_end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
    Some((
        &trimmed[..executable_end],
        trimmed[executable_end..].trim_start(),
    ))
}

fn shell_executable_basename(executable: &str) -> String {
    executable
        .replace('/', "\\")
        .rsplit('\\')
        .next()
        .unwrap_or(executable)
        .to_ascii_lowercase()
}

fn strip_cmd_outer_double_quotes(input: &str) -> &str {
    let trimmed = input.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    }
}

fn strip_matching_outer_quotes(input: &str) -> &str {
    let trimmed = input.trim();
    let Some(first) = trimmed.chars().next() else {
        return trimmed;
    };
    let Some(last) = trimmed.chars().next_back() else {
        return trimmed;
    };
    if trimmed.len() > first.len_utf8() + last.len_utf8() && quotes_match(last, first) {
        &trimmed[first.len_utf8()..trimmed.len() - last.len_utf8()]
    } else {
        trimmed
    }
}

fn contains_top_level_cmd_control(command: &str) -> bool {
    let mut in_double_quote = false;
    let mut escaped = false;

    for ch in command.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '^' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            in_double_quote = !in_double_quote;
            continue;
        }
        if !in_double_quote && matches!(ch, '&' | '|' | ';' | '<' | '>' | '\r' | '\n') {
            return true;
        }
    }

    false
}

/// 从 PowerShell Remove-Item（或别名 ri/rm）中提取目标路径
///
/// 支持 Agent 实际生成的多种格式:
/// - `powershell -Command "Remove-Item 'path' -Force"`
/// - `powershell -Command 'Remove-Item \'path\' -Force; if ($?) { ... }'`
/// - `powershell -Command "ri 'path'"` / `rm 'path'` (PS 别名)
/// - `powershell -Command "Remove-Item 'path' -Force -Recurse"`
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
    extract_powershell_remove_item_targets_with_app_data_dir(command, workdir, None, None)
}

fn extract_powershell_remove_item_targets_with_app_data_dir(
    command: &str,
    workdir: Option<&Path>,
    app_data_dir: Option<&Path>,
    effective_env: Option<&std::collections::HashMap<String, String>>,
) -> Option<(Vec<String>, bool)> {
    let script = powershell_script(command)?;

    // 查找删除命令位置：优先 remove-item，然后尝试别名 ri/rm/del/erase/rd/rmdir
    let (cmd_end_pos, cmd_name) = find_ps_delete_command(script)?;
    let cmd_start_pos = cmd_end_pos.saturating_sub(cmd_name.len());
    // 只使用删除语句之前已经执行的字面量赋值；后续重新赋值不得反向改变目标。
    let variables = extract_powershell_variable_assignments(
        &script[..cmd_start_pos],
        workdir,
        app_data_dir,
        effective_env,
    );
    let after_ri = &script[cmd_end_pos..];
    let after_ri = after_ri.trim();

    // 只解析当前删除语句；引号中的分号属于路径，不是语句边界。
    let effective = take_powershell_statement(after_ri).trim();
    if powershell_single_quoted_segment_contains_variable(effective) {
        // PowerShell 单引号不展开变量；当前路径解析器不能把它安全等价地改写。
        return None;
    }

    let is_directory =
        effective.to_ascii_lowercase().contains("-recurse") || matches!(cmd_name, "rmdir" | "rd");

    // 从 effective 中提取路径（跳过 -Flag 参数）
    // Agent 常用格式: \'C:\Users\Admin\Pictures\log.txt\' -Force
    //                 'C:\path\file' -Force
    //                 "C:\path\file" -Force

    // 策略：找到第一个非 - 开头的 token，作为路径
    // 但需要特殊处理引号包裹的路径（可能含空格）

    let paths = extract_paths_from_ps_args(effective);
    if paths.iter().any(|path| {
        let trimmed = path.trim();
        trimmed == "~" || trimmed.starts_with("~\\") || trimmed.starts_with("~/")
    }) {
        // PowerShell expands ~ against its own HOME/provider state. Do not reinterpret it as a
        // workdir-relative literal path in the host-side preflight.
        return None;
    }
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

fn powershell_single_quoted_segment_contains_variable(input: &str) -> bool {
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in input.chars() {
        if let Some(open) = quote {
            if escaped {
                escaped = false;
            } else if ch == '`' {
                escaped = true;
            } else if quotes_match(ch, open) {
                quote = None;
            } else if ch == '$' {
                return true;
            }
        } else if matches!(ch, '\'' | '‘') {
            quote = Some(ch);
        }
    }
    false
}

fn powershell_script(command: &str) -> Option<&str> {
    powershell_launcher_and_script(command).map(|(_, script)| script)
}

fn powershell_launcher_and_script(command: &str) -> Option<(&str, &str)> {
    let (executable, launcher_args) = shell_executable_and_rest(command)?;
    if !matches!(
        shell_executable_basename(executable).as_str(),
        "powershell" | "powershell.exe" | "pwsh" | "pwsh.exe"
    ) {
        return None;
    }

    let lower_args = launcher_args.to_ascii_lowercase();
    let mut command_option = None;
    for option in [
        "-command", "-comman", "-comma", "-comm", "-com", "-co", "-c", "/command", "/comman",
        "/comma", "/comm", "/com", "/co", "/c",
    ] {
        for (pos, _) in lower_args.match_indices(option) {
            if is_command_token_boundary_before(launcher_args, pos)
                && is_command_token_boundary_after(launcher_args, pos + option.len())
            {
                let candidate = (pos, option.len());
                if command_option.is_none_or(|current: (usize, usize)| candidate.0 < current.0) {
                    command_option = Some(candidate);
                }
            }
        }
    }

    let (command_pos, option_len) = command_option?;
    let launcher_prefix = launcher_args[..command_pos].trim();
    let script = launcher_args[command_pos + option_len..].trim();
    Some((launcher_prefix, strip_matching_outer_quotes(script)))
}

fn powershell_launcher_disables_profiles(command: &str) -> bool {
    let Some((launcher_prefix, _)) = powershell_launcher_and_script(command) else {
        return false;
    };
    split_shell_like_paths(launcher_prefix).iter().any(|token| {
        matches!(
            token.to_ascii_lowercase().as_str(),
            "-noprofile"
                | "-noprofil"
                | "-noprofi"
                | "-noprof"
                | "-nopro"
                | "-nop"
                | "/noprofile"
                | "/noprofil"
                | "/noprofi"
                | "/noprof"
                | "/nopro"
                | "/nop"
        )
    })
}

fn powershell_has_static_delete(command: &str) -> bool {
    powershell_script(command)
        .and_then(find_ps_delete_command)
        .is_some()
}

/// 返回当前 PowerShell 删除命令是否应由 Trash Bin 接管，而不是作为普通内联脚本阻断。
///
/// 这里只进行无副作用的语法分类。目标解析、保护路径、沙箱 allowed-roots 与实际转移
/// 仍由 [`try_intercept_delete_scoped_with_env`] 完整校验。只有 Trash Bin 已建模的静态
/// `-Command` 删除形态才会跳过通用脚本删除扫描；动态 API、脚本文件和未建模包装仍按
/// 普通脚本 fail closed。
pub fn should_defer_powershell_delete_to_trash(command: &str) -> bool {
    if powershell_delete_is_what_if(command) {
        return true;
    }

    powershell_has_static_delete(command)
        && powershell_launcher_disables_profiles(command)
        && !powershell_launcher_changes_working_directory(command)
        && !extract_cmd_c_inner(command)
            .is_some_and(|inner| contains_executable_powershell_delete(&inner))
        && !powershell_delete_has_unsupported_parameters(command)
        && powershell_delete_target_syntax_is_supported(command)
        && !powershell_delete_has_unsupported_control_flow(command)
        && !powershell_delete_has_unsafe_prefix(command)
        && !powershell_delete_mutates_environment_before_target(command)
}

fn powershell_launcher_changes_working_directory(command: &str) -> bool {
    let Some((launcher_prefix, _)) = powershell_launcher_and_script(command) else {
        return false;
    };
    split_shell_like_paths(launcher_prefix).iter().any(|token| {
        let lower = token.to_ascii_lowercase();
        lower == "-workingdirectory"
            || lower.starts_with("-workingdirectory:")
            || lower == "-wd"
            || lower.starts_with("-wd:")
    })
}

fn powershell_delete_target_syntax_is_supported(command: &str) -> bool {
    let Some(script) = powershell_script(command) else {
        return true;
    };
    let Some((command_end, _)) = find_ps_delete_command(script) else {
        return true;
    };
    let statement = take_powershell_statement(&script[command_end..]);
    let mut quote = None;
    let mut chars = statement.chars().peekable();
    while let Some(ch) = chars.next() {
        if let Some(open_quote) = quote {
            if quotes_match(ch, open_quote) {
                if chars
                    .peek()
                    .is_some_and(|next| quotes_match(*next, open_quote))
                {
                    return false;
                }
                quote = None;
            }
            continue;
        }
        if is_quote_char(ch) {
            quote = Some(ch);
            continue;
        }
        if matches!(
            ch,
            '`' | '&' | '|' | '(' | ')' | '[' | ']' | '{' | '}' | '+'
        ) {
            return false;
        }
    }
    quote.is_none()
}

fn take_powershell_statement(input: &str) -> &str {
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut block_comment = false;
    let mut chars = input.char_indices().peekable();

    while let Some((index, ch)) = chars.next() {
        if block_comment {
            if ch == '#' && chars.peek().map(|(_, next)| *next) == Some('>') {
                chars.next();
                block_comment = false;
            }
            continue;
        }
        if let Some(open_quote) = quote {
            if escaped {
                escaped = false;
            } else if ch == '`' {
                escaped = true;
            } else if quotes_match(ch, open_quote) {
                quote = None;
            }
            continue;
        }
        if ch == '<' && chars.peek().map(|(_, next)| *next) == Some('#') {
            chars.next();
            block_comment = true;
            continue;
        }
        if ch == '#' {
            return &input[..index];
        }
        if is_quote_char(ch) {
            quote = Some(ch);
            continue;
        }
        if matches!(ch, ';' | '\r' | '\n' | '}') {
            return &input[..index];
        }
    }

    input
}

fn powershell_delete_has_parameter(command: &str, parameter: &str) -> bool {
    let Some(script) = powershell_script(command) else {
        return false;
    };
    let Some((command_end, _)) = find_ps_delete_command(script) else {
        return false;
    };
    let statement = take_powershell_statement(&script[command_end..]);
    let lower = statement.to_ascii_lowercase();
    powershell_code_tokens(statement)
        .into_iter()
        .any(|(start, end, token)| {
            token == parameter
                && powershell_token_is_parameter(statement, start)
                && !lower[end..].trim_start().starts_with(":$false")
        })
}

fn powershell_delete_is_what_if(command: &str) -> bool {
    let Some(script) = powershell_script(command) else {
        return false;
    };
    let Some((command_end, _)) = find_ps_delete_command(script) else {
        return false;
    };
    let statement = take_powershell_statement(&script[command_end..]);
    let lower = statement.to_ascii_lowercase();

    powershell_code_tokens(statement)
        .into_iter()
        .filter(|(start, _, token)| {
            token == "whatif" && powershell_token_is_parameter(statement, *start)
        })
        .any(|(_, end, _)| !lower[end..].trim_start().starts_with(":$false"))
}

fn powershell_delete_has_unsupported_parameters(command: &str) -> bool {
    let Some(script) = powershell_script(command) else {
        return false;
    };
    let Some((command_end, _)) = find_ps_delete_command(script) else {
        return false;
    };
    let statement = take_powershell_statement(&script[command_end..]);
    let lower = statement.to_ascii_lowercase();

    powershell_code_tokens(statement)
        .into_iter()
        .filter(|(start, _, _)| powershell_token_is_parameter(statement, *start))
        .any(|(_, end, token)| match token.as_str() {
            "path" | "literalpath" | "force" | "recurse" | "verbose" | "debug" | "erroraction" => {
                false
            }
            "whatif" => !lower[end..].trim_start().starts_with(":$false"),
            "confirm" => !lower[end..].trim_start().starts_with(":$false"),
            _ => true,
        })
}

fn powershell_token_is_parameter(input: &str, token_start: usize) -> bool {
    let Some((dash_pos, dash)) = input[..token_start].char_indices().next_back() else {
        return false;
    };
    dash == '-'
        && input[..dash_pos]
            .chars()
            .next_back()
            .is_none_or(|ch| ch.is_whitespace() || matches!(ch, ';' | '|' | '{' | '(' | ','))
}

fn powershell_delete_has_unsupported_control_flow(command: &str) -> bool {
    let Some(script) = powershell_script(command) else {
        return false;
    };
    let Some((command_end, command_name)) = find_ps_delete_command(script) else {
        return false;
    };
    let command_start = command_end.saturating_sub(command_name.len());
    let prefix = &script[..command_start];
    let controls: Vec<String> = powershell_code_tokens(prefix)
        .into_iter()
        .map(|(_, _, token)| token)
        .filter(|token| {
            matches!(
                token.as_str(),
                "if" | "switch"
                    | "while"
                    | "do"
                    | "foreach"
                    | "foreach-object"
                    | "for"
                    | "try"
                    | "catch"
                    | "trap"
                    | "function"
                    | "filter"
                    | "invoke-expression"
                    | "iex"
            )
        })
        .collect();

    if controls.is_empty() {
        let before_brace = prefix.trim_end();
        if !before_brace.ends_with('{') {
            return false;
        }
        let invocation_prefix = before_brace[..before_brace.len() - 1].trim_end();
        return !invocation_prefix.ends_with('&');
    }

    if controls
        .iter()
        .any(|control| !matches!(control.as_str(), "foreach" | "foreach-object"))
    {
        return true;
    }

    let lower = script.to_ascii_lowercase();
    !(lower.contains("get-childitem") && lower.contains(".fullname"))
}

fn powershell_prefix_has_call_operator(prefix: &str) -> bool {
    let sanitized = powershell_without_comments(prefix);
    let chars: Vec<char> = sanitized.chars().collect();
    let mut quote = None;
    let mut escaped = false;

    for (index, ch) in chars.iter().copied().enumerate() {
        if let Some(open_quote) = quote {
            if escaped {
                escaped = false;
            } else if ch == '`' {
                escaped = true;
            } else if quotes_match(ch, open_quote) {
                quote = None;
            }
            continue;
        }
        if is_quote_char(ch) {
            quote = Some(ch);
            continue;
        }
        if ch == '&'
            && chars.get(index.wrapping_sub(1)) != Some(&'&')
            && chars.get(index + 1) != Some(&'&')
        {
            return true;
        }
    }

    false
}

fn is_powershell_prefix_command_position(input: &str, pos: usize) -> bool {
    input[..pos]
        .chars()
        .rev()
        .find(|ch| !ch.is_whitespace())
        .map(|ch| matches!(ch, ';' | '|' | '&' | '{' | '(' | '=' | '\r' | '\n'))
        .unwrap_or(true)
}

fn split_powershell_prefix_statements(input: &str) -> Vec<String> {
    let sanitized = powershell_without_comments(input);
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut quote = None;

    for ch in sanitized.chars() {
        if let Some(open_quote) = quote {
            current.push(ch);
            if quotes_match(ch, open_quote) {
                quote = None;
            }
            continue;
        }
        if is_quote_char(ch) {
            quote = Some(ch);
            current.push(ch);
            continue;
        }
        if matches!(ch, ';' | '\r' | '\n') {
            if !current.trim().is_empty() {
                statements.push(std::mem::take(&mut current));
            } else {
                current.clear();
            }
            continue;
        }
        current.push(ch);
    }
    if !current.trim().is_empty() {
        statements.push(current);
    }
    statements
}

fn powershell_exact_quoted_literal(input: &str) -> bool {
    let trimmed = input.trim();
    let Some(open_quote) = trimmed.chars().next() else {
        return false;
    };
    if !is_quote_char(open_quote) {
        return false;
    }
    let mut cursor = open_quote.len_utf8();
    while cursor < trimmed.len() {
        let ch = trimmed[cursor..].chars().next().unwrap_or_default();
        if quotes_match(ch, open_quote) {
            return cursor + ch.len_utf8() == trimmed.len();
        }
        cursor += ch.len_utf8();
    }
    false
}

fn powershell_supported_variable_reference(input: &str) -> bool {
    let trimmed = input.trim();
    let Some(rest) = trimmed.strip_prefix('$') else {
        return false;
    };
    if let Some(braced) = rest.strip_prefix('{') {
        return braced
            .strip_suffix('}')
            .is_some_and(|name| !name.is_empty() && name.chars().all(is_powershell_variable_char));
    }
    !rest.is_empty() && rest.chars().all(is_powershell_variable_char)
}

fn is_powershell_variable_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | ':')
}

fn powershell_statement_is_supported_assignment(statement: &str) -> bool {
    let statement = statement.trim();
    let Some(rest) = statement.strip_prefix('$') else {
        return false;
    };
    let name_len = rest
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
        .map(char::len_utf8)
        .sum::<usize>();
    if name_len == 0 {
        return false;
    }
    let after_name = rest[name_len..].trim_start();
    let Some(rhs) = after_name.strip_prefix('=') else {
        return false;
    };
    if rhs.starts_with('=') {
        return false;
    }
    let rhs = rhs.trim();
    !rhs.is_empty()
        && (powershell_exact_quoted_literal(rhs) || powershell_supported_variable_reference(rhs))
}

fn powershell_prefix_is_only_supported_assignments(prefix: &str) -> bool {
    split_powershell_prefix_statements(prefix)
        .iter()
        .all(|statement| powershell_statement_is_supported_assignment(statement))
}

fn powershell_enumeration_prefix_is_supported(prefix: &str, enumeration_start: usize) -> bool {
    if !powershell_prefix_is_only_supported_assignments(&prefix[..enumeration_start]) {
        return false;
    }
    let enumeration = &prefix[enumeration_start..];
    let command_tokens = powershell_code_tokens(enumeration)
        .into_iter()
        .filter(|(start, _, _)| is_powershell_prefix_command_position(enumeration, *start))
        .map(|(_, _, token)| token)
        .collect::<Vec<_>>();
    let only_modeled_commands = command_tokens.iter().all(|token| {
        matches!(
            token.as_str(),
            "get-childitem" | "gci" | "ls" | "foreach-object"
        )
    }) && command_tokens
        .first()
        .is_some_and(|token| matches!(token.as_str(), "get-childitem" | "gci" | "ls"));
    if !only_modeled_commands {
        return false;
    }

    let sanitized = powershell_without_comments(enumeration);
    let mut quote = None;
    let mut pipe_count = 0usize;
    let mut open_braces = 0usize;
    for ch in sanitized.chars() {
        if let Some(open_quote) = quote {
            if quotes_match(ch, open_quote) {
                quote = None;
            }
            continue;
        }
        if is_quote_char(ch) {
            quote = Some(ch);
            continue;
        }
        match ch {
            '|' => pipe_count += 1,
            '{' => open_braces += 1,
            ';' | '&' | '(' | ')' | '[' | ']' | '}' | '+' | '`' | '\r' | '\n' => return false,
            _ => {}
        }
    }
    if pipe_count != 1 || open_braces > 1 {
        return false;
    }
    let has_foreach = command_tokens.iter().any(|token| token == "foreach-object");
    if has_foreach != (open_braces == 1) {
        return false;
    }
    !has_foreach || powershell_pipelines_feed_foreach_directly(prefix)
}

/// Only literal/local variable assignments and the narrowly modeled Get-ChildItem pipeline may
/// precede a statically intercepted Remove-Item. Unknown commands can mutate aliases, providers,
/// profiles, or process environment in ways the target resolver cannot reproduce.
fn powershell_delete_has_unsafe_prefix(command: &str) -> bool {
    let Some(script) = powershell_script(command) else {
        return false;
    };
    let Some((command_end, command_name)) = find_ps_delete_command(script) else {
        return false;
    };
    let command_start = command_end.saturating_sub(command_name.len());
    let prefix = &script[..command_start];
    if prefix.contains('`') || powershell_prefix_has_call_operator(prefix) {
        return true;
    }

    let enumeration_start = powershell_code_tokens(prefix)
        .into_iter()
        .find(|(start, _, token)| {
            is_powershell_prefix_command_position(prefix, *start)
                && matches!(token.as_str(), "get-childitem" | "gci" | "ls")
        })
        .map(|(start, _, _)| start);
    if let Some(enumeration_start) = enumeration_start {
        return !powershell_enumeration_prefix_is_supported(prefix, enumeration_start);
    }

    !powershell_prefix_is_only_supported_assignments(prefix)
}

fn powershell_prefix_has_direct_env_assignment(prefix: &str) -> bool {
    let chars: Vec<char> = powershell_without_comments(prefix).chars().collect();
    let mut index = 0usize;
    let mut quote: Option<char> = None;
    let mut escaped = false;

    while index < chars.len() {
        let ch = chars[index];
        if let Some(open_quote) = quote {
            if escaped {
                escaped = false;
            } else if ch == '`' {
                escaped = true;
            } else if quotes_match(ch, open_quote) {
                quote = None;
            }
            index += 1;
            continue;
        }
        if is_quote_char(ch) {
            quote = Some(ch);
            index += 1;
            continue;
        }
        if ch != '$' {
            index += 1;
            continue;
        }

        let mut cursor = index + 1;
        let braced = chars.get(cursor) == Some(&'{');
        if braced {
            cursor += 1;
        }
        let provider: String = chars
            .get(cursor..cursor.saturating_add(4))
            .unwrap_or_default()
            .iter()
            .collect();
        if !provider.eq_ignore_ascii_case("env:") {
            index += 1;
            continue;
        }
        cursor += 4;
        while cursor < chars.len()
            && (chars[cursor].is_ascii_alphanumeric() || chars[cursor] == '_')
        {
            cursor += 1;
        }
        if braced {
            if chars.get(cursor) != Some(&'}') {
                index += 1;
                continue;
            }
            cursor += 1;
        }
        while cursor < chars.len() && (chars[cursor].is_whitespace() || chars[cursor] == ')') {
            cursor += 1;
        }
        let assignment_tail: String = chars[cursor..].iter().take(3).collect();
        let postfix_assignment = ["=", "+=", "-=", "*=", "/=", "%=", "++", "--", "??="]
            .iter()
            .any(|operator| assignment_tail.starts_with(operator));
        let prefix_operators: Vec<char> = chars[..index]
            .iter()
            .rev()
            .filter(|character| !character.is_whitespace())
            .take(2)
            .copied()
            .collect();
        let prefix_assignment = matches!(prefix_operators.as_slice(), ['+', '+'] | ['-', '-']);
        if postfix_assignment || prefix_assignment {
            return true;
        }
        index += 1;
    }

    false
}

fn powershell_delete_mutates_environment_before_target(command: &str) -> bool {
    let Some(script) = powershell_script(command) else {
        return false;
    };
    let Some((command_end, command_name)) = find_ps_delete_command(script) else {
        return false;
    };
    let command_start = command_end.saturating_sub(command_name.len());
    let prefix = &script[..command_start];
    if powershell_prefix_has_direct_env_assignment(prefix) {
        return true;
    }

    let tokens = powershell_code_tokens(prefix);
    if tokens
        .iter()
        .any(|(_, _, token)| token == "setenvironmentvariable")
    {
        return true;
    }
    tokens.iter().any(|(_, _, token)| {
        matches!(
            token.as_str(),
            "set-item"
                | "si"
                | "set-content"
                | "sc"
                | "add-content"
                | "ac"
                | "new-item"
                | "ni"
                | "clear-item"
                | "cli"
                | "copy-item"
                | "copy"
                | "cp"
                | "cpi"
                | "move-item"
                | "move"
                | "mi"
                | "mv"
                | "rename-item"
                | "ren"
                | "rni"
                | "out-file"
        )
    })
}

fn contains_unresolved_cmd_variable(path: &str) -> bool {
    let bytes = path.as_bytes();
    let has_percent_pair = bytes
        .iter()
        .enumerate()
        .any(|(index, byte)| *byte == b'%' && bytes[index + 1..].contains(&b'%'));
    let has_delayed_pair = bytes
        .iter()
        .enumerate()
        .any(|(index, byte)| *byte == b'!' && bytes[index + 1..].contains(&b'!'));
    has_percent_pair || has_delayed_pair
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

fn powershell_without_comments(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut line_comment = false;
    let mut block_comment = false;

    while let Some(ch) = chars.next() {
        if line_comment {
            if matches!(ch, '\r' | '\n') {
                line_comment = false;
                output.push(ch);
            } else {
                output.push(' ');
            }
            continue;
        }
        if block_comment {
            if ch == '#' && chars.peek() == Some(&'>') {
                output.push(' ');
                output.push(' ');
                chars.next();
                block_comment = false;
            } else if matches!(ch, '\r' | '\n') {
                output.push(ch);
            } else {
                output.push(' ');
            }
            continue;
        }
        if let Some(open) = quote {
            output.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '`' {
                escaped = true;
            } else if quotes_match(ch, open) {
                quote = None;
            }
            continue;
        }
        if ch == '<' && chars.peek() == Some(&'#') {
            output.push(' ');
            output.push(' ');
            chars.next();
            block_comment = true;
            continue;
        }
        if ch == '#' {
            output.push(' ');
            line_comment = true;
            continue;
        }
        if is_quote_char(ch) {
            quote = Some(ch);
        }
        output.push(ch);
    }

    output
}

fn extract_powershell_variable_assignments(
    command: &str,
    workdir: Option<&Path>,
    app_data_dir: Option<&Path>,
    effective_env: Option<&std::collections::HashMap<String, String>>,
) -> std::collections::HashMap<String, String> {
    let sanitized = powershell_without_comments(command);
    let chars: Vec<char> = sanitized.chars().collect();
    let mut assignments = std::collections::HashMap::new();
    if effective_env.is_none() {
        // Direct unit/library callers retain the historical inferred defaults. shell_execute
        // always supplies an effective environment and must never invent a value the child does
        // not actually receive.
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
    }
    const SUPPORTED_ENV_NAMES: [&str; 7] = [
        "APPDATA",
        "LOCALAPPDATA",
        "USERPROFILE",
        "HOME",
        "TEMP",
        "TMP",
        "WORKDIR",
    ];
    if let Some(effective_env) = effective_env {
        // shell_execute supplies the effective child-process values after applying user and
        // sandbox-profile overrides. Never re-read the parent process for this path: doing so
        // could move one file to Trash while the spawned command deletes a different file.
        for (name, value) in effective_env {
            if SUPPORTED_ENV_NAMES
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(name))
            {
                assignments.insert(format!("env:{}", name.to_ascii_lowercase()), value.clone());
            }
        }
    } else {
        for name in SUPPORTED_ENV_NAMES {
            if let Some(value) = std::env::var_os(name) {
                assignments
                    .entry(format!("env:{}", name.to_ascii_lowercase()))
                    .or_insert_with(|| value.to_string_lossy().to_string());
            }
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
        if cursor >= chars.len() {
            break;
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
            if matches!(quote, '\'' | '‘') && raw_value.contains('$') {
                // 单引号赋值中的变量标记是字面量；保留为未解析并阻断。
                index = cursor + 1;
                continue;
            }
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
    trimmed.contains('$') || trimmed.contains("${")
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
        let end = pos + needle.len();
        let is_braced_variable = needle.starts_with("${");
        let continues_variable_name = !is_braced_variable
            && input[end..]
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == ':');
        if continues_variable_name {
            let next = pos + input[pos..].chars().next().map(char::len_utf8).unwrap_or(1);
            output.push_str(&input[search_start..next]);
            search_start = next;
            continue;
        }
        output.push_str(&input[search_start..pos]);
        output.push_str(replacement);
        search_start = end;
    }

    output.push_str(&input[search_start..]);
    output
}

fn extract_powershell_foreach_fullname_patterns(
    command: &str,
    variables: &std::collections::HashMap<String, String>,
) -> Option<Vec<String>> {
    let script = powershell_script(command)?;
    let lower = script.to_ascii_lowercase();
    let has_foreach = lower.contains("foreach-object")
        || lower.contains("foreach ")
        || lower.contains("foreach(");
    if !has_foreach || !lower.contains(".fullname") || !lower.contains("remove-item") {
        return None;
    }
    if powershell_code_tokens(script).iter().any(|(_, _, token)| {
        matches!(
            token.as_str(),
            "where-object" | "select-object" | "sort-object" | "group-object" | "measure-object"
        )
    }) || !powershell_pipelines_feed_foreach_directly(script)
    {
        return None;
    }

    let mut patterns = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut search_start = 0usize;

    while let Some(relative_pos) = lower[search_start..].find("get-childitem") {
        let pos = search_start + relative_pos;
        let args_start = pos + "get-childitem".len();
        let rest = &script[args_start..];
        let segment_end = rest
            .find('|')
            .or_else(|| rest.find(';'))
            .unwrap_or(rest.len());
        let segment = &rest[..segment_end];
        if !powershell_gci_args_have_exact_child_semantics(segment) {
            search_start = args_start;
            continue;
        }
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

fn powershell_pipelines_feed_foreach_directly(script: &str) -> bool {
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut block_comment = false;
    let mut chars = script.char_indices().peekable();

    while let Some((index, ch)) = chars.next() {
        if block_comment {
            if ch == '#' && chars.peek().map(|(_, next)| *next) == Some('>') {
                chars.next();
                block_comment = false;
            }
            continue;
        }
        if let Some(open) = quote {
            if escaped {
                escaped = false;
            } else if ch == '`' {
                escaped = true;
            } else if quotes_match(ch, open) {
                quote = None;
            }
            continue;
        }
        if ch == '<' && chars.peek().map(|(_, next)| *next) == Some('#') {
            chars.next();
            block_comment = true;
            continue;
        }
        if ch == '#' {
            while let Some((_, next)) = chars.peek() {
                if matches!(*next, '\r' | '\n') {
                    break;
                }
                chars.next();
            }
            continue;
        }
        if is_quote_char(ch) {
            quote = Some(ch);
            continue;
        }
        if ch == '|' {
            let next_command = powershell_code_tokens(&script[index + ch.len_utf8()..])
                .into_iter()
                .next()
                .map(|(_, _, token)| token);
            if next_command.as_deref() != Some("foreach-object") {
                return false;
            }
        }
    }
    true
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
fn find_ps_delete_command(script: &str) -> Option<(usize, &'static str)> {
    for (start, end, token) in powershell_code_tokens(script) {
        let command_name = match token.as_str() {
            "remove-item" => "remove-item",
            "rmdir" => "rmdir",
            "erase" => "erase",
            "del" => "del",
            "rd" => "rd",
            "ri" => "ri",
            "rm" => "rm",
            _ => continue,
        };
        if is_powershell_command_position(script, start)
            || is_module_qualified_powershell_command_position(script, start)
        {
            return Some((end, command_name));
        }
    }

    None
}

fn powershell_code_tokens(input: &str) -> Vec<(usize, usize, String)> {
    let chars: Vec<(usize, char)> = input.char_indices().collect();
    let mut tokens = Vec::new();
    let mut index = 0usize;
    let mut quote: Option<char> = None;
    let mut block_comment = false;
    let mut line_comment = false;

    while index < chars.len() {
        let (byte_pos, ch) = chars[index];
        let next = chars.get(index + 1).map(|(_, next)| *next);

        if line_comment {
            if matches!(ch, '\r' | '\n') {
                line_comment = false;
            }
            index += 1;
            continue;
        }
        if block_comment {
            if ch == '#' && next == Some('>') {
                block_comment = false;
                index += 2;
            } else {
                index += 1;
            }
            continue;
        }
        if let Some(open_quote) = quote {
            if ch == '`' {
                index += 2;
            } else {
                if quotes_match(ch, open_quote) {
                    quote = None;
                }
                index += 1;
            }
            continue;
        }
        if ch == '`' {
            index += 2;
            continue;
        }
        if ch == '<' && next == Some('#') {
            block_comment = true;
            index += 2;
            continue;
        }
        if ch == '#' {
            line_comment = true;
            index += 1;
            continue;
        }
        if is_quote_char(ch) {
            quote = Some(ch);
            index += 1;
            continue;
        }
        if ch.is_ascii_alphabetic() || ch == '_' {
            let start = byte_pos;
            index += 1;
            while index < chars.len()
                && (chars[index].1.is_ascii_alphanumeric() || matches!(chars[index].1, '_' | '-'))
            {
                index += 1;
            }
            let end = chars.get(index).map(|(pos, _)| *pos).unwrap_or(input.len());
            tokens.push((start, end, input[start..end].to_ascii_lowercase()));
            continue;
        }

        index += 1;
    }

    tokens
}

fn is_powershell_command_position(input: &str, pos: usize) -> bool {
    input[..pos]
        .chars()
        .rev()
        .find(|ch| !ch.is_whitespace())
        .map(|ch| matches!(ch, ';' | '|' | '&' | '{' | '(' | '\r' | '\n'))
        .unwrap_or(true)
}

fn is_module_qualified_powershell_command_position(input: &str, pos: usize) -> bool {
    let before = &input[..pos];
    let Some(module_and_separator) = before.strip_suffix('\\') else {
        return false;
    };
    let module_start = module_and_separator
        .char_indices()
        .rev()
        .find(|(_, ch)| ch.is_whitespace() || matches!(ch, ';' | '|' | '&' | '{' | '('))
        .map(|(index, ch)| index + ch.len_utf8())
        .unwrap_or(0);
    let module = &module_and_separator[module_start..];
    !module.is_empty()
        && module
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        && is_powershell_command_position(input, module_start)
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

    contains_cmd_delete_intent(command)
        || contains_powershell_delete_intent(command)
        || contains_nested_cmd_delete_intent(command)
        || contains_wrapped_powershell_delete_intent(command)
        || contains_redirection_prefixed_delete_intent(command)
        || contains_obfuscated_powershell_delete(command)
        || contains_dynamic_powershell_delete(command)
        || contains_unhandled_powershell_delete_api(&lower)
        || contains_runtime_delete_api(&lower)
        || contains_unix_delete_command(&lower)
        || contains_git_cleanup_delete(&lower)
        || contains_robocopy_mirror_delete(&lower)
        || contains_cmd_loop_delete(&lower)
        || contains_package_cleanup_delete(&lower)
}

fn contains_wrapped_powershell_delete_intent(command: &str) -> bool {
    let tokens = split_shell_like_paths(command);
    let Some(wrapper) = tokens
        .first()
        .map(|token| token.trim_start_matches('@').to_ascii_lowercase())
    else {
        return false;
    };
    if !matches!(
        wrapper.as_str(),
        "call" | "if" | "start" | "for" | "forfiles"
    ) {
        return false;
    }

    contains_powershell_launcher_delete_anywhere(command)
}

fn contains_redirection_prefixed_delete_intent(command: &str) -> bool {
    let trimmed = command.trim_start().trim_start_matches('@').trim_start();
    let Some(first_token) = trimmed.split_whitespace().next() else {
        return false;
    };
    if !first_token.contains('>') && !first_token.contains('<') {
        return false;
    }

    let command_before_redirection = first_token
        .split(['>', '<'])
        .next()
        .unwrap_or_default()
        .trim_start_matches('@');
    parse_cmd_delete_command_token(command_before_redirection).is_some()
        || contains_cmd_delete_builtin_token(&command.to_ascii_lowercase())
        || contains_powershell_launcher_delete_anywhere(command)
}

fn contains_powershell_launcher_delete_anywhere(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    for launcher in ["powershell.exe", "powershell", "pwsh.exe", "pwsh"] {
        for (position, _) in lower.match_indices(launcher) {
            if !is_command_token_boundary_before(&lower, position)
                || !is_command_token_boundary_after(&lower, position + launcher.len())
            {
                continue;
            }
            let nested = &command[position..];
            if contains_executable_powershell_delete(nested)
                || contains_dynamic_powershell_delete(nested)
            {
                return true;
            }
        }
    }
    false
}

fn contains_executable_powershell_delete(command: &str) -> bool {
    if let Some(inner) = extract_cmd_c_inner(command) {
        return contains_executable_powershell_delete(&inner);
    }

    let segments = top_level_command_segments(command);
    if segments.len() > 1 {
        return segments
            .into_iter()
            .any(contains_executable_powershell_delete);
    }

    if let Some(script) = powershell_script(command) {
        return find_ps_delete_command(script).is_some() || contains_cmd_delete_intent(script);
    }
    false
}

fn contains_powershell_delete_intent(command: &str) -> bool {
    contains_executable_powershell_delete(command) || find_ps_delete_command(command).is_some()
}

fn contains_nested_cmd_delete_intent(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    for command_name in ["cmd", "cmd.exe"] {
        for (position, _) in lower.match_indices(command_name) {
            if is_command_token_boundary_before(&lower, position)
                && is_command_token_boundary_after(&lower, position + command_name.len())
                && extract_cmd_c_inner(&command[position..])
                    .is_some_and(|payload| contains_cmd_delete_intent(&payload))
            {
                return true;
            }
        }
    }
    false
}

fn contains_cmd_delete_intent(command: &str) -> bool {
    if let Some(inner) = extract_cmd_c_inner(command) {
        return contains_cmd_delete_intent(&inner);
    }

    let normalized = command.replace('^', "").to_ascii_lowercase();
    let chars: Vec<(usize, char)> = normalized.char_indices().collect();
    let mut index = 0usize;
    let mut in_double_quote = false;
    let mut command_position = true;
    let mut first_command = String::new();

    while index < chars.len() {
        let (_, ch) = chars[index];
        if ch == '"' {
            in_double_quote = !in_double_quote;
            index += 1;
            continue;
        }
        if in_double_quote {
            index += 1;
            continue;
        }
        if matches!(ch, '&' | '|' | ';' | '(' | '\r' | '\n') {
            command_position = true;
            index += 1;
            continue;
        }
        if !command_position || ch.is_whitespace() || ch == '@' {
            index += 1;
            continue;
        }

        let start = chars[index].0;
        while index < chars.len()
            && !chars[index].1.is_whitespace()
            && !matches!(
                chars[index].1,
                '"' | '&' | '|' | ';' | '(' | ')' | '\r' | '\n'
            )
        {
            index += 1;
        }
        let end = chars
            .get(index)
            .map(|(pos, _)| *pos)
            .unwrap_or(normalized.len());
        let token = normalized[start..end].trim_matches('@');
        if parse_cmd_delete_command_token(token).is_some() {
            return true;
        }
        if first_command.is_empty() {
            first_command = token.to_string();
        }
        command_position = false;
    }

    if matches!(
        first_command.as_str(),
        "if" | "for" | "forfiles" | "call" | "start"
    ) {
        return contains_cmd_delete_builtin_token(&normalized);
    }

    (normalized.contains("%comspec%") || normalized.contains("!comspec!"))
        && contains_cmd_delete_builtin_token(&normalized)
}

fn contains_cmd_delete_builtin_token(input: &str) -> bool {
    input
        .split(|ch: char| {
            ch.is_whitespace() || matches!(ch, '"' | '&' | '|' | ';' | '(' | ')' | '\r' | '\n')
        })
        .filter(|token| !token.is_empty())
        .any(|token| parse_cmd_delete_command_token(token).is_some())
}

fn contains_obfuscated_powershell_delete(command: &str) -> bool {
    let Some(script) = powershell_script(command) else {
        return false;
    };
    if !script.contains('`') {
        return false;
    }
    let normalized = script.replace('`', "").to_ascii_lowercase();
    ["remove-item", "rmdir", "erase", "del", "rd", "ri", "rm"]
        .iter()
        .any(|name| find_command_token(&normalized, name).is_some())
}

fn contains_dynamic_powershell_delete(command: &str) -> bool {
    if let Some(inner) = extract_cmd_c_inner(command) {
        return contains_dynamic_powershell_delete(&inner);
    }
    if let Some(script) = powershell_script(command) {
        return powershell_script_has_dynamic_delete(script);
    }
    top_level_command_segments(command)
        .into_iter()
        .any(|segment| segment != command && contains_dynamic_powershell_delete(segment))
}

fn powershell_script_has_dynamic_delete(script: &str) -> bool {
    let code_tokens = powershell_code_tokens(script);
    let unconditionally_unsafe = code_tokens
        .iter()
        .any(|(_, _, token)| matches!(token.as_str(), "invoke-expression" | "iex"))
        || (code_tokens
            .iter()
            .any(|(_, _, token)| token == "scriptblock")
            && code_tokens.iter().any(|(_, _, token)| token == "create")
            && (code_tokens.iter().any(|(_, _, token)| token == "invoke")
                || powershell_has_dot_source_operator(script)));
    if unconditionally_unsafe {
        return true;
    }

    let has_dynamic_execution = code_tokens.iter().any(|(start, _, token)| {
        is_powershell_command_position(script, *start)
            && matches!(
                token.as_str(),
                "start-process"
                    | "start"
                    | "saps"
                    | "invoke-command"
                    | "icm"
                    | "set-alias"
                    | "new-alias"
                    | "sal"
                    | "nal"
                    | "powershell"
                    | "powershell.exe"
                    | "pwsh"
                    | "pwsh.exe"
            )
    }) || powershell_prefix_has_call_operator(script)
        || powershell_has_dot_source_operator(script);
    if !has_dynamic_execution {
        return false;
    }

    let normalized = script.replace('`', "").to_ascii_lowercase();
    [
        "remove-item",
        "rimraf",
        "del",
        "erase",
        "rmdir",
        "rd",
        "ri",
        "rm",
    ]
    .iter()
    .any(|name| find_command_token(&normalized, name).is_some())
        || normalized.contains("rimraf@")
        || normalized.contains(".delete(")
        || normalized.contains("::delete(")
        || normalized.contains("git clean")
        || normalized.contains("robocopy") && normalized.contains("/purge")
}

fn powershell_has_dot_source_operator(script: &str) -> bool {
    let sanitized = powershell_without_comments(script);
    let chars: Vec<char> = sanitized.chars().collect();
    let mut quote = None;
    for (index, ch) in chars.iter().copied().enumerate() {
        if let Some(open_quote) = quote {
            if quotes_match(ch, open_quote) {
                quote = None;
            }
            continue;
        }
        if is_quote_char(ch) {
            quote = Some(ch);
            continue;
        }
        if ch != '.' {
            continue;
        }
        let previous = chars[..index]
            .iter()
            .rev()
            .find(|character| !character.is_whitespace())
            .copied();
        let next = chars.get(index + 1).copied();
        let at_command_start = previous
            .is_none_or(|character| matches!(character, ';' | '|' | '&' | '{' | '(' | '\r' | '\n'));
        if at_command_start
            && next.is_some_and(|character| {
                character.is_whitespace() || matches!(character, '\\' | '/' | '(')
            })
        {
            return true;
        }
    }
    false
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
            "from os import remove",
            "from os import unlink",
            "from shutil import rmtree",
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
            "deno.remove(",
            "deno.removesync(",
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

fn top_level_command_segments(input: &str) -> Vec<&str> {
    let mut segments = Vec::new();
    let mut start = 0usize;
    let mut in_double_quote = false;
    let mut escaped = false;

    for (index, ch) in input.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '^' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            in_double_quote = !in_double_quote;
            continue;
        }
        if !in_double_quote && matches!(ch, '&' | '|' | ';' | '\r' | '\n') {
            let segment = input[start..index].trim();
            if !segment.is_empty() {
                segments.push(segment);
            }
            start = index + ch.len_utf8();
        }
    }
    let tail = input[start..].trim();
    if !tail.is_empty() {
        segments.push(tail);
    }
    segments
}

fn git_segment_has_cleanup_delete(segment: &str) -> bool {
    let tokens = split_shell_like_paths(segment);
    let Some(git_index) = tokens
        .iter()
        .position(|token| command_token_basename(token) == "git")
    else {
        return false;
    };
    let git_args = &tokens[git_index + 1..];
    if let Some(rm_index) = git_args
        .iter()
        .position(|token| token.eq_ignore_ascii_case("rm"))
    {
        return !git_args[rm_index + 1..]
            .iter()
            .take_while(|token| token.as_str() != "--")
            .any(|token| token.eq_ignore_ascii_case("--cached"));
    }
    if let Some(reset_index) = git_args
        .iter()
        .position(|token| token.eq_ignore_ascii_case("reset"))
    {
        if git_args[reset_index + 1..]
            .iter()
            .any(|token| token.eq_ignore_ascii_case("--hard"))
        {
            return true;
        }
    }
    let Some(clean_index) = git_args
        .iter()
        .position(|token| token.eq_ignore_ascii_case("clean"))
    else {
        return false;
    };

    let mut dry_run = false;
    let mut index = clean_index + 1;
    while index < git_args.len() {
        let token = &git_args[index];
        if token == "--" {
            break;
        }
        if token.eq_ignore_ascii_case("-e") || token.eq_ignore_ascii_case("--exclude") {
            index += 2;
            continue;
        }
        if !token.to_ascii_lowercase().starts_with("--exclude=") {
            let lower = token.to_ascii_lowercase();
            if lower == "--dry-run"
                || (lower.starts_with('-') && !lower.starts_with("--") && lower[1..].contains('n'))
            {
                dry_run = true;
            }
        }
        index += 1;
    }
    !dry_run
}

fn contains_git_cleanup_delete(lower: &str) -> bool {
    top_level_command_segments(lower)
        .into_iter()
        .any(git_segment_has_cleanup_delete)
}

fn command_token_basename(token: &str) -> String {
    let normalized = token.replace('/', "\\");
    let basename = normalized.rsplit('\\').next().unwrap_or(&normalized);
    basename
        .strip_suffix(".exe")
        .unwrap_or(basename)
        .to_ascii_lowercase()
}

fn contains_robocopy_mirror_delete(lower: &str) -> bool {
    lower.contains("robocopy") && (has_slash_flag(lower, "mir") || has_slash_flag(lower, "purge"))
}

fn contains_cmd_loop_delete(lower: &str) -> bool {
    (starts_with_command(lower.trim_start(), "for") || lower.contains(" for "))
        && contains_cmd_delete_builtin_token(lower)
        || lower.contains("forfiles") && contains_cmd_delete_builtin_token(lower)
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

    let named_path_parameters: Vec<(usize, usize)> = powershell_code_tokens(trimmed)
        .into_iter()
        .filter(|(start, _, token)| {
            matches!(token.as_str(), "path" | "literalpath")
                && powershell_token_is_parameter(trimmed, *start)
        })
        .map(|(start, end, _)| (start, end))
        .collect();
    if named_path_parameters.len() > 1 {
        return Vec::new();
    }
    if let Some((_, parameter_end)) = named_path_parameters.first().copied() {
        return split_powershell_path_list(trimmed[parameter_end..].trim_start());
    }

    // 策略：从原始字符串中找到第一个非 -flag 的位置，
    // 然后在该位置对剩余字符串做引号匹配。
    // 不能用 split_whitespace，因为引号内的空格不应分割。

    let Some(remaining) = skip_supported_ps_delete_switches(trimmed) else {
        return Vec::new();
    };
    let remaining = remaining.trim();

    if remaining.is_empty() {
        return Vec::new();
    }

    split_powershell_path_list(remaining)
}

fn skip_supported_ps_delete_switches(s: &str) -> Option<&str> {
    let mut remaining = s.trim();
    loop {
        if !remaining.starts_with('-') {
            return Some(remaining);
        }
        let token_end = remaining
            .find(char::is_whitespace)
            .unwrap_or(remaining.len());
        let token = remaining[..token_end].to_ascii_lowercase();
        let (name, explicit_value) = token.split_once(':').unwrap_or((&token, ""));
        let supported_switch = matches!(name, "-force" | "-recurse" | "-verbose" | "-debug")
            && (explicit_value.is_empty() || matches!(explicit_value, "$true" | "$false"));
        let supported_disabled_control =
            matches!(name, "-whatif" | "-confirm") && explicit_value == "$false";
        if !supported_switch && !supported_disabled_control {
            return None;
        }
        if token_end == remaining.len() {
            return Some("");
        }
        remaining = remaining[token_end..].trim_start();
    }
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

#[derive(Debug)]
struct TrashMoveFailure {
    error: AppError,
    recovery_required: bool,
}

fn package_cleanup_segment_has_delete(segment: &str, depth: usize) -> bool {
    if let Some(inner) = extract_cmd_c_inner(segment) {
        return contains_package_cleanup_delete_inner(&inner, depth + 1);
    }

    let tokens = split_shell_like_paths(segment);
    package_cleanup_tokens_have_delete(&tokens)
}

fn package_cleanup_tokens_have_delete(tokens: &[String]) -> bool {
    let mut tokens = tokens;
    while tokens
        .first()
        .is_some_and(|token| package_cleanup_command_name(token) == "call")
    {
        tokens = &tokens[1..];
    }
    let joined = tokens.join(" ");
    if let Some(inner) = extract_cmd_c_inner(&joined) {
        return contains_package_cleanup_delete_inner(&inner, 1);
    }
    if let Some(script) = powershell_script(&joined) {
        return contains_package_cleanup_delete_inner(script, 1);
    }
    let Some(first) = tokens
        .first()
        .map(|token| package_cleanup_command_name(token))
    else {
        return false;
    };
    if is_rimraf_spec(&first) {
        return true;
    }
    if matches!(
        first.as_str(),
        "start" | "if" | "for" | "forfiles" | "foreach"
    ) {
        if tokens[1..]
            .iter()
            .any(|token| token.to_ascii_lowercase().contains("rimraf"))
        {
            return true;
        }
        return tokens[1..].iter().enumerate().any(|(index, token)| {
            let name = package_cleanup_command_name(token);
            (is_rimraf_spec(&name)
                || matches!(
                    name.as_str(),
                    "npx"
                        | "pnpx"
                        | "bunx"
                        | "npm"
                        | "pnpm"
                        | "yarn"
                        | "corepack"
                        | "cmd"
                        | "cmd.exe"
                        | "%comspec%"
                        | "!comspec!"
                        | "powershell"
                        | "powershell.exe"
                        | "pwsh"
                        | "pwsh.exe"
                ))
                && package_cleanup_tokens_have_delete(&tokens[index + 1..])
        });
    }
    if matches!(
        first.as_str(),
        "cmd"
            | "cmd.exe"
            | "%comspec%"
            | "!comspec!"
            | "powershell"
            | "powershell.exe"
            | "pwsh"
            | "pwsh.exe"
    ) {
        let joined = tokens.join(" ");
        if let Some(inner) = extract_cmd_c_inner(&joined) {
            return contains_package_cleanup_delete_inner(&inner, 1);
        }
        if let Some(script) = powershell_script(&joined) {
            return contains_package_cleanup_delete_inner(script, 1);
        }
        return tokens[1..]
            .iter()
            .any(|token| token.to_ascii_lowercase().contains("rimraf"));
    }
    if first == "corepack" {
        return tokens[1..].iter().enumerate().any(|(index, token)| {
            matches!(
                package_cleanup_command_name(token).as_str(),
                "npm" | "pnpm" | "yarn"
            ) && package_cleanup_tokens_have_delete(&tokens[index + 1..])
        });
    }

    package_manager_invokes_rimraf(&first, &tokens[1..])
}

fn package_manager_invokes_rimraf(manager: &str, arguments: &[String]) -> bool {
    if matches!(manager, "npx" | "pnpx" | "bunx") {
        if package_call_payload_has_delete(arguments) {
            return true;
        }
        return package_executable_token(arguments).is_some_and(|token| is_rimraf_spec(&token));
    }

    let Some((subcommand_index, subcommand)) = package_manager_subcommand(arguments) else {
        return false;
    };
    let remaining = &arguments[subcommand_index + 1..];
    match manager {
        "npm" => {
            matches!(subcommand.as_str(), "exec" | "x")
                && (package_call_payload_has_delete(remaining)
                    || package_executable_token(remaining)
                        .is_some_and(|token| is_rimraf_spec(&token)))
        }
        "pnpm" => {
            matches!(subcommand.as_str(), "exec" | "x" | "dlx" | "run")
                && package_executable_token(remaining).is_some_and(|token| is_rimraf_spec(&token))
        }
        "yarn" => {
            if is_rimraf_spec(&subcommand) {
                true
            } else {
                matches!(subcommand.as_str(), "exec" | "dlx" | "run")
                    && package_executable_token(remaining)
                        .is_some_and(|token| is_rimraf_spec(&token))
            }
        }
        _ => false,
    }
}

fn package_call_payload_has_delete(arguments: &[String]) -> bool {
    for (index, token) in arguments.iter().enumerate() {
        let lower = token.to_ascii_lowercase();
        let name = package_cleanup_command_name(token);
        if matches!(name.as_str(), "-c" | "--call")
            && arguments
                .get(index + 1)
                .is_some_and(|payload| contains_package_cleanup_delete_inner(payload, 1))
        {
            return true;
        }
        for prefix in ["-c=", "--call="] {
            if let Some(payload) = lower.strip_prefix(prefix) {
                if contains_package_cleanup_delete_inner(payload, 1) {
                    return true;
                }
            }
        }
    }
    false
}

fn package_manager_subcommand(arguments: &[String]) -> Option<(usize, String)> {
    const KNOWN_SUBCOMMANDS: &[&str] = &[
        "exec",
        "x",
        "dlx",
        "run",
        "list",
        "ls",
        "why",
        "view",
        "info",
        "show",
        "search",
        "outdated",
        "config",
        "install",
        "add",
        "remove",
        "uninstall",
        "update",
        "publish",
        "pack",
        "audit",
        "help",
    ];
    let mut skip_next = false;
    arguments.iter().enumerate().find_map(|(index, token)| {
        if skip_next {
            skip_next = false;
            return None;
        }
        let lower = token.to_ascii_lowercase();
        let name = package_cleanup_command_name(token);
        if lower.starts_with('-') {
            if !lower.contains('=') && package_manager_global_option_consumes_value(&name) {
                skip_next = true;
            }
            return None;
        }
        if is_rimraf_spec(&name) || KNOWN_SUBCOMMANDS.contains(&name.as_str()) {
            Some((index, name))
        } else {
            None
        }
    })
}

fn package_manager_global_option_consumes_value(option: &str) -> bool {
    matches!(
        option,
        "-w" | "--workspace"
            | "--prefix"
            | "--cwd"
            | "-c"
            | "--dir"
            | "--filter"
            | "-f"
            | "--registry"
            | "--cache"
            | "--userconfig"
            | "--globalconfig"
            | "--config"
            | "--location"
    )
}

fn package_executable_token(arguments: &[String]) -> Option<String> {
    let mut skip_next = false;
    for token in arguments {
        if skip_next {
            skip_next = false;
            continue;
        }
        let lower = token.to_ascii_lowercase();
        let name = package_cleanup_command_name(token);
        if name == "--" {
            continue;
        }
        if lower.starts_with('-') {
            if !lower.contains('=')
                && matches!(
                    name.as_str(),
                    "-p" | "--package"
                        | "--cwd"
                        | "-c"
                        | "--dir"
                        | "--filter"
                        | "-f"
                        | "--registry"
                        | "--cache"
                        | "--userconfig"
                )
            {
                skip_next = true;
            }
            continue;
        }
        return Some(name);
    }
    None
}

fn is_rimraf_spec(token: &str) -> bool {
    token == "rimraf" || token.starts_with("rimraf@")
}

fn package_cleanup_command_name(token: &str) -> String {
    let token = token.trim_matches(|character| {
        matches!(
            character,
            '@' | '(' | ')' | '\'' | '"' | '‘' | '’' | '“' | '”'
        )
    });
    let normalized = token.replace('/', "\\");
    let basename = normalized.rsplit('\\').next().unwrap_or(&normalized);
    let lower = basename.to_ascii_lowercase();
    [".exe", ".cmd", ".bat", ".ps1"]
        .iter()
        .find_map(|suffix| lower.strip_suffix(suffix))
        .unwrap_or(&lower)
        .to_string()
}

fn contains_package_cleanup_delete(command: &str) -> bool {
    contains_package_cleanup_delete_inner(command, 0)
}

fn contains_package_cleanup_delete_inner(command: &str, depth: usize) -> bool {
    if depth >= 16 {
        return split_shell_like_paths(command)
            .iter()
            .map(|token| package_cleanup_command_name(token))
            .any(|token| is_rimraf_spec(&token));
    }
    if let Some(inner) = extract_cmd_c_inner(command) {
        return contains_package_cleanup_delete_inner(&inner, depth + 1);
    }
    if let Some(script) = powershell_script(command) {
        return contains_package_cleanup_delete_inner(script, depth + 1);
    }

    top_level_command_segments(command)
        .into_iter()
        .any(|segment| package_cleanup_segment_has_delete(segment, depth + 1))
}

fn transfer_failure(
    stage: &'static str,
    source: &Path,
    payload: &Path,
    _storage_id: &str,
    error: impl std::fmt::Display,
    recovery_required: bool,
) -> TrashMoveFailure {
    let source_visible = std::fs::symlink_metadata(source).is_ok();
    let payload_visible = std::fs::symlink_metadata(payload).is_ok();
    let recovery_required = recovery_required || !source_visible || payload_visible;
    log::error!(
        "[TrashBin] {} failed for {} (payload {}, recovery_required={}): {}",
        stage,
        source.display(),
        payload.display(),
        recovery_required,
        error
    );
    TrashMoveFailure {
        error: AppError::Forbidden(DELETE_UNAVAILABLE_BLOCK_MESSAGE.to_string()),
        recovery_required,
    }
}

fn persist_transfer_state(
    app_data_dir: &Path,
    entries: &mut [TrashEntry],
    manifest_index: usize,
    state: TrashEntryState,
    source: &Path,
    payload: &Path,
    storage_id: &str,
    recovery_required: bool,
) -> Result<(), TrashMoveFailure> {
    entries[manifest_index].state = state;
    write_manifest_atomic_unlocked(app_data_dir, entries).map_err(|error| {
        transfer_failure(
            "manifest state commit",
            source,
            payload,
            storage_id,
            error,
            recovery_required,
        )
    })
}

/// 将一个已写入 Pending 的目标推进到 Ready。
///
/// 同卷只执行 no-replace rename。跨卷先复制并验证 candidate，再把源原子改名为同父目录
/// claim；只有 claim 与 candidate 最终一致时才发布中央 payload，随后删除 claim。
fn move_to_trash_transaction(
    source: &Path,
    payload: &Path,
    storage_id: &str,
    app_data_dir: &Path,
    entries: &mut [TrashEntry],
    manifest_index: usize,
    force_copy: bool,
) -> Result<(), TrashMoveFailure> {
    if !force_copy {
        match trash_transfer::try_direct_move(source, payload) {
            Ok(trash_transfer::DirectMoveOutcome::Renamed) => {
                persist_transfer_state(
                    app_data_dir,
                    entries,
                    manifest_index,
                    TrashEntryState::Ready,
                    source,
                    payload,
                    storage_id,
                    true,
                )?;
                log::info!(
                    "[TrashBin] payload moved by same-volume rename: {} → {}",
                    source.display(),
                    payload.display()
                );
                return Ok(());
            }
            Ok(trash_transfer::DirectMoveOutcome::CrossVolume) => {}
            Err(error) => {
                return Err(transfer_failure(
                    "same-volume move",
                    source,
                    payload,
                    storage_id,
                    error,
                    false,
                ));
            }
        }
    }

    let candidate = trash_transfer::copy_source_to_candidate(source, payload).map_err(|error| {
        transfer_failure(
            "cross-volume candidate copy",
            source,
            payload,
            storage_id,
            error,
            false,
        )
    })?;
    persist_transfer_state(
        app_data_dir,
        entries,
        manifest_index,
        TrashEntryState::PayloadReady,
        source,
        payload,
        storage_id,
        false,
    )?;

    let claim = trash_transfer::claim_source(source, storage_id).map_err(|error| {
        transfer_failure(
            "cross-volume source claim",
            source,
            payload,
            storage_id,
            error,
            false,
        )
    })?;
    persist_transfer_state(
        app_data_dir,
        entries,
        manifest_index,
        TrashEntryState::Claimed,
        source,
        payload,
        storage_id,
        true,
    )?;

    let candidate_matches = trash_transfer::items_match(&claim, &candidate).map_err(|error| {
        transfer_failure(
            "cross-volume final comparison",
            source,
            payload,
            storage_id,
            error,
            true,
        )
    })?;
    if !candidate_matches {
        trash_transfer::refresh_candidate_from_source(&claim, &candidate).map_err(|error| {
            transfer_failure(
                "cross-volume candidate refresh",
                source,
                payload,
                storage_id,
                error,
                true,
            )
        })?;
    }

    trash_transfer::publish_candidate(&candidate, payload).map_err(|error| {
        transfer_failure(
            "cross-volume payload publish",
            source,
            payload,
            storage_id,
            error,
            true,
        )
    })?;
    trash_transfer::verify_claim_payload(&claim, payload).map_err(|error| {
        transfer_failure(
            "cross-volume published payload verification",
            source,
            payload,
            storage_id,
            error,
            true,
        )
    })?;
    persist_transfer_state(
        app_data_dir,
        entries,
        manifest_index,
        TrashEntryState::PayloadVerified,
        source,
        payload,
        storage_id,
        true,
    )?;
    trash_transfer::finish_verified_claim_cleanup(&claim).map_err(|error| {
        transfer_failure(
            "cross-volume verified claim cleanup",
            source,
            payload,
            storage_id,
            error,
            true,
        )
    })?;
    persist_transfer_state(
        app_data_dir,
        entries,
        manifest_index,
        TrashEntryState::Ready,
        source,
        payload,
        storage_id,
        true,
    )?;
    log::info!(
        "[TrashBin] payload committed by verified cross-volume transfer: {} → {}",
        source.display(),
        payload.display()
    );
    Ok(())
}

// ==================== 公开接口 ====================

/// 判断路径是否包含通配符
fn is_glob_pattern(path: &str) -> bool {
    path.contains('*') || path.contains('?')
}

fn simple_glob_pattern_supported(path: &str) -> bool {
    is_glob_pattern(path) && !path.contains("**") && !path.contains('[') && !path.contains(']')
}

struct DeletePreflightBudget {
    deadline: std::time::Instant,
    observed_targets: usize,
    max_targets: usize,
}

impl DeletePreflightBudget {
    fn new() -> Self {
        Self::with_limits(MAX_DELETE_TARGETS, DELETE_ENUMERATION_TIMEOUT)
    }

    fn with_limits(max_targets: usize, timeout: std::time::Duration) -> Self {
        Self {
            deadline: std::time::Instant::now()
                .checked_add(timeout)
                .unwrap_or_else(std::time::Instant::now),
            observed_targets: 0,
            max_targets,
        }
    }

    fn check_deadline(&self) -> Result<(), AppError> {
        if std::time::Instant::now() >= self.deadline {
            return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
        }
        Ok(())
    }

    fn observe_target(&mut self) -> Result<(), AppError> {
        self.check_deadline()?;
        self.observed_targets = self
            .observed_targets
            .checked_add(1)
            .ok_or_else(|| AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()))?;
        if self.observed_targets > self.max_targets {
            return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
        }
        Ok(())
    }
}

fn ensure_delete_target_count(count: usize) -> Result<(), AppError> {
    if count > MAX_DELETE_TARGETS {
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }
    Ok(())
}

fn normalize_path_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match normalized.components().next_back() {
                Some(Component::Normal(_)) => {
                    normalized.pop();
                }
                Some(Component::ParentDir) | None if !path.has_root() => {
                    normalized.push(Component::ParentDir.as_os_str());
                }
                _ => {}
            },
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
    let key = key.trim_end_matches('/').to_string();
    #[cfg(target_os = "windows")]
    {
        key.to_ascii_lowercase()
    }
    #[cfg(not(target_os = "windows"))]
    {
        key
    }
}

fn path_is_inside_root(root: &Path, path: &Path) -> bool {
    let root_key = path_key(root);
    let path_key = path_key(path);
    path_key == root_key || path_key.starts_with(&format!("{}/", root_key))
}

fn canonicalize_for_boundary(path: &Path) -> Result<PathBuf, AppError> {
    let absolute = if path.is_absolute() {
        normalize_path_lexically(path)
    } else {
        normalize_path_lexically(
            &std::env::current_dir()
                .map_err(|error| {
                    AppError::FileSystem(format!(
                        "Failed to resolve current directory for path boundary: {}",
                        error
                    ))
                })?
                .join(path),
        )
    };

    if let Ok(metadata) = std::fs::symlink_metadata(&absolute) {
        if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
            let parent = absolute.parent().ok_or_else(|| {
                AppError::Forbidden("Delete target link has no safe parent path.".to_string())
            })?;
            let parent = std::fs::canonicalize(parent).map_err(|error| {
                AppError::FileSystem(format!(
                    "Failed to resolve delete target parent boundary: {}",
                    error
                ))
            })?;
            return Ok(parent.join(absolute.file_name().unwrap_or_default()));
        }
    }

    let mut cursor = absolute.as_path();
    let mut missing = Vec::new();
    loop {
        match std::fs::canonicalize(cursor) {
            Ok(mut resolved) => {
                for component in missing.iter().rev() {
                    resolved.push(component);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = cursor.file_name().ok_or_else(|| {
                    AppError::FileSystem(format!(
                        "Unable to resolve an existing ancestor for delete target: {}",
                        absolute.display()
                    ))
                })?;
                missing.push(name.to_os_string());
                cursor = cursor.parent().ok_or_else(|| {
                    AppError::FileSystem(format!(
                        "Unable to resolve delete target boundary: {}",
                        absolute.display()
                    ))
                })?;
            }
            Err(error) => {
                return Err(AppError::FileSystem(format!(
                    "Failed to resolve delete target boundary: {}",
                    error
                )));
            }
        }
    }
}

fn is_path_allowed_by_roots(path: &Path, allowed_roots: &[PathBuf]) -> Result<bool, AppError> {
    let candidate = canonicalize_for_boundary(path)?;
    for root in allowed_roots {
        let root = std::fs::canonicalize(root).map_err(|error| {
            AppError::FileSystem(format!(
                "Failed to resolve sandbox filesystem root {}: {}",
                root.display(),
                error
            ))
        })?;
        if path_is_inside_root(&root, &candidate) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn ensure_delete_path_allowed(
    target_path: &Path,
    allowed_roots: Option<&[PathBuf]>,
) -> Result<(), AppError> {
    if trash_transfer::is_internal_transfer_path(target_path) {
        log::warn!(
            "[TrashBin] refused direct deletion of an internal transaction path: {}",
            target_path.display()
        );
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }
    let Some(allowed_roots) = allowed_roots else {
        return Ok(());
    };
    if !allowed_roots.is_empty() && is_path_allowed_by_roots(target_path, allowed_roots)? {
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

fn ensure_delete_targets_non_overlapping(targets: &[PathBuf]) -> Result<(), AppError> {
    let normalized: Vec<PathBuf> = targets
        .iter()
        .map(|path| normalize_path_lexically(path))
        .collect();
    for (index, left) in normalized.iter().enumerate() {
        for right in normalized.iter().skip(index + 1) {
            if path_is_inside_root(left, right) || path_is_inside_root(right, left) {
                log::warn!(
                    "[TrashBin] refused an overlapping multi-target deletion: {} <> {}",
                    left.display(),
                    right.display()
                );
                return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
            }
        }
    }
    Ok(())
}

fn ensure_target_does_not_capture_active_transfer(
    target: &Path,
    entries: &[TrashEntry],
) -> Result<(), AppError> {
    let target = normalize_path_lexically(target);
    for entry in entries {
        if let Some(restore) = entry.restore.as_ref() {
            let original = normalize_path_lexically(Path::new(&entry.original_path));
            let staging = trash_transfer::restore_staging_path(&original, &restore.id)
                .map(|path| normalize_path_lexically(&path));
            let overlaps_original =
                path_is_inside_root(&target, &original) || path_is_inside_root(&original, &target);
            let overlaps_staging = staging.is_ok_and(|staging| {
                path_is_inside_root(&target, &staging) || path_is_inside_root(&staging, &target)
            });
            if overlaps_original || overlaps_staging {
                log::warn!(
                    "[TrashBin] refused a target that intersects an active restore transaction: {}",
                    target.display()
                );
                return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
            }
        }
        if entry.state == TrashEntryState::Ready {
            continue;
        }
        let Some(storage_id) = entry.storage_id.as_deref() else {
            continue;
        };
        let Ok(claim) = trash_transfer::claim_path(Path::new(&entry.original_path), storage_id)
        else {
            continue;
        };
        let claim = normalize_path_lexically(&claim);
        if path_is_inside_root(&target, &claim) || path_is_inside_root(&claim, &target) {
            log::warn!(
                "[TrashBin] refused a target that contains an active transaction claim: {}",
                target.display()
            );
            return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
        }
    }
    Ok(())
}

fn resolve_delete_path(target: &str, workdir: Option<&Path>) -> Result<PathBuf, AppError> {
    let trimmed = target.trim();
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Ok(normalize_path_lexically(path));
    }

    if matches!(path.components().next(), Some(Component::Prefix(_))) {
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }

    let current_dir = std::env::current_dir().map_err(|error| {
        AppError::FileSystem(format!(
            "Failed to resolve current directory for delete target: {}",
            error
        ))
    })?;
    if workdir.is_some_and(|wd| {
        !wd.is_absolute() && matches!(wd.components().next(), Some(Component::Prefix(_)))
    }) {
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }
    let base = match workdir {
        Some(wd) if wd.is_absolute() => normalize_path_lexically(wd),
        Some(wd) => normalize_path_lexically(&current_dir.join(wd)),
        None => normalize_path_lexically(&current_dir),
    };
    let resolved = normalize_path_lexically(&base.join(path));
    if !resolved.is_absolute() {
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }
    Ok(resolved)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeleteTargetPolicy {
    FilesOnly,
    DirectItems { recursive_directories: bool },
    DirectoriesOnly { recursive_directories: bool },
}

fn delete_target_policy(command: &str) -> DeleteTargetPolicy {
    if powershell_script(command).is_some() {
        return DeleteTargetPolicy::DirectItems {
            recursive_directories: powershell_delete_has_parameter(command, "recurse"),
        };
    }

    if let Some((command_name, tokens)) = direct_cmd_delete_tokens(command) {
        if matches!(command_name.as_str(), "rmdir" | "rd") {
            return DeleteTargetPolicy::DirectoriesOnly {
                recursive_directories: tokens.iter().any(|token| token.eq_ignore_ascii_case("/s")),
            };
        }
    }
    DeleteTargetPolicy::FilesOnly
}

fn delete_semantics_allow_target(target: &Path, command: &str) -> Result<bool, AppError> {
    let metadata = std::fs::symlink_metadata(target).map_err(|error| {
        AppError::FileSystem(format!(
            "Unable to inspect delete target semantics safely: {}",
            error
        ))
    })?;
    let is_directory = metadata.is_dir();
    let is_link_item = metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata);

    #[cfg(target_os = "windows")]
    if !is_directory
        && metadata.permissions().readonly()
        && !powershell_delete_has_parameter(command, "force")
        && !cmd_delete_forces_readonly(command)
    {
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }

    let recursive_directories = match delete_target_policy(command) {
        DeleteTargetPolicy::FilesOnly => return Ok(!is_directory),
        DeleteTargetPolicy::DirectoriesOnly {
            recursive_directories,
        } => {
            if !is_directory {
                return Ok(false);
            }
            recursive_directories
        }
        DeleteTargetPolicy::DirectItems {
            recursive_directories,
        } => recursive_directories,
    };

    if is_directory && !is_link_item && !recursive_directories {
        let mut entries = std::fs::read_dir(target).map_err(|error| {
            AppError::FileSystem(format!(
                "Unable to inspect non-recursive directory deletion safely: {}",
                error
            ))
        })?;
        if entries
            .next()
            .transpose()
            .map_err(|error| {
                AppError::FileSystem(format!(
                    "Unable to inspect non-recursive directory contents safely: {}",
                    error
                ))
            })?
            .is_some()
        {
            return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
        }
    }

    Ok(true)
}

fn delete_target_item_is_directory(target: &Path) -> Result<bool, AppError> {
    std::fs::symlink_metadata(target)
        .map(|metadata| metadata.is_dir())
        .map_err(|error| {
            AppError::FileSystem(format!(
                "Unable to inspect delete target type safely: {}",
                error
            ))
        })
}

/// 移动单个文件/目录到 Trash Bin 并记录 manifest
///
/// 返回用户可见的反馈消息
fn trash_single_item(
    target_path: &Path,
    _is_directory: bool,
    command: &str,
    app_data_dir: &Path,
    allowed_roots: Option<&[PathBuf]>,
    batch_id: &str,
) -> Result<String, AppError> {
    if !delete_semantics_allow_target(target_path, command)? {
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }
    ensure_delete_path_allowed(target_path, allowed_roots)?;
    command_validator::validate_delete_target_safety(target_path, app_data_dir)?;
    let target_path_str = target_path.to_string_lossy().to_string();

    // 以真实文件系统类型为准，避免 `Remove-Item file -Recurse` 被误记为目录。
    let is_directory = delete_target_item_is_directory(target_path)?;
    let storage_id = uuid::Uuid::new_v4().to_string();
    let entry_id = generate_entry_id();

    // 先持久化 Pending，确保从这一刻起任何成功移动都有可发现的恢复记录。
    let trash_path = generate_trash_path(app_data_dir, &storage_id);
    let entry = TrashEntry {
        id: entry_id.clone(),
        original_path: target_path_str.to_string(),
        trash_path: trash_path.to_string_lossy().to_string(),
        deleted_at: chrono::Local::now().to_rfc3339(),
        command: command.to_string(),
        batch_id: Some(batch_id.to_string()),
        is_directory,
        storage_id: Some(storage_id.clone()),
        state: TrashEntryState::Pending,
        restore: None,
    };
    let storage_dir = trash_path.parent().ok_or_else(|| {
        AppError::FileSystem("Trash Bin payload path has no storage directory.".to_string())
    })?;
    if let Err(error) = std::fs::create_dir_all(storage_dir) {
        return Err(AppError::FileSystem(format!(
            "Failed to create Trash Bin storage directory: {}",
            error
        )));
    }
    if let Err(error) = validate_trash_payload_path(app_data_dir, &trash_path) {
        let _ = std::fs::remove_dir(storage_dir);
        return Err(error);
    }

    // Pending 持久化、rename 和 Ready 提交必须在同一 sidecar 锁生命周期内完成。
    // 否则并发 list/reconcile 可能把仍在执行的 Pending 当作崩溃残留删除，
    // 造成 payload 已移动但 manifest 记录丢失。
    let _manifest_lock = match open_manifest_lock(app_data_dir) {
        Ok(lock) => lock,
        Err(error) => {
            let _ = std::fs::remove_dir(storage_dir);
            return Err(error);
        }
    };
    let mut entries = match read_manifest_unlocked(app_data_dir) {
        Ok(entries) => entries,
        Err(error) => {
            let _ = std::fs::remove_dir(storage_dir);
            return Err(error);
        }
    };
    entries.push(entry);
    if let Err(error) = write_manifest_atomic_unlocked(app_data_dir, &entries) {
        let _ = std::fs::remove_dir(storage_dir);
        return Err(error);
    }

    // Close as much of the path-swap window as possible before rename. The earlier batch preflight
    // prevents partial moves for known policy errors; this second check catches late link/junction
    // replacement while the manifest transaction lock is held.
    let final_validation = (|| -> Result<(), AppError> {
        if !delete_semantics_allow_target(target_path, command)?
            || delete_target_item_is_directory(target_path)? != is_directory
        {
            return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
        }
        ensure_delete_path_allowed(target_path, allowed_roots)?;
        command_validator::validate_delete_target_safety(target_path, app_data_dir)?;
        ensure_target_does_not_capture_active_transfer(target_path, &entries)?;
        Ok(())
    })();
    if let Err(error) = final_validation {
        entries.retain(|entry| entry.id != entry_id || entry.state != TrashEntryState::Pending);
        if let Err(cleanup_error) = write_manifest_atomic_unlocked(app_data_dir, &entries) {
            log::error!(
                "[TrashBin] failed to remove rejected Pending entry {}: {}",
                entry_id,
                cleanup_error
            );
        }
        let _ = std::fs::remove_dir(storage_dir);
        return Err(error);
    }

    let manifest_index = entries.len() - 1;
    if let Err(failure) = move_to_trash_transaction(
        target_path,
        &trash_path,
        &storage_id,
        app_data_dir,
        &mut entries,
        manifest_index,
        false,
    ) {
        if failure.recovery_required {
            if let Err(commit_error) = write_manifest_atomic_unlocked(app_data_dir, &entries) {
                log::error!(
                    "[TrashBin] failed to persist recoverable transaction state {}: {}",
                    entry_id,
                    commit_error
                );
            }
        } else {
            if let Ok(candidate) = trash_transfer::candidate_path(&trash_path) {
                let _ = trash_transfer::remove_candidate_if_present(&candidate);
            }
            entries.retain(|entry| entry.id != entry_id);
            if let Err(cleanup_error) = write_manifest_atomic_unlocked(app_data_dir, &entries) {
                log::error!(
                    "[TrashBin] failed to remove unused transaction entry {}: {}",
                    entry_id,
                    cleanup_error
                );
            }
            let _ = std::fs::remove_dir(storage_dir);
        }
        return Err(failure.error);
    }

    let type_label = if is_directory { "Directory" } else { "File" };
    Ok(format!(
        "{}: {} → {}",
        type_label,
        target_path_str,
        trash_path.display()
    ))
}

struct PreparedTrashItem {
    target_path: PathBuf,
    trash_path: PathBuf,
    storage_dir: PathBuf,
    storage_id: String,
    entry_id: String,
    manifest_index: usize,
    is_directory: bool,
}

struct BatchTrashMoveResult {
    moved_details: Vec<String>,
    failed_count: u32,
    first_error: Option<AppError>,
}

fn cleanup_prepared_storage(items: &[PreparedTrashItem]) {
    for item in items {
        let _ = std::fs::remove_dir(&item.storage_dir);
    }
}

/// Move a fully preflighted target set under one manifest lock.
///
/// The whole batch is persisted as Pending before the first transfer. Each item then persists its
/// own same-volume Ready commit or cross-volume
/// PayloadReady/Claimed/PayloadVerified/Ready transitions while the shared manifest lock remains
/// held, so reconciliation can resume any interrupted item.
fn trash_multiple_items(
    target_paths: &[PathBuf],
    command: &str,
    app_data_dir: &Path,
    allowed_roots: Option<&[PathBuf]>,
    batch_id: &str,
) -> Result<BatchTrashMoveResult, AppError> {
    ensure_delete_target_count(target_paths.len())?;
    ensure_delete_targets_non_overlapping(target_paths)?;
    let _manifest_lock = open_manifest_lock(app_data_dir)?;

    let mut target_types = Vec::with_capacity(target_paths.len());
    for target_path in target_paths {
        if !delete_semantics_allow_target(target_path, command)? {
            return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
        }
        ensure_delete_path_allowed(target_path, allowed_roots)?;
        target_types.push(delete_target_item_is_directory(target_path)?);
    }
    command_validator::validate_delete_targets_safety(target_paths, app_data_dir)?;

    let mut entries = read_manifest_unlocked(app_data_dir)?;
    let mut prepared = Vec::with_capacity(target_paths.len());
    for (target_path, is_directory) in target_paths.iter().zip(target_types) {
        let storage_id = uuid::Uuid::new_v4().to_string();
        let entry_id = generate_entry_id();
        let trash_path = generate_trash_path(app_data_dir, &storage_id);
        let storage_dir = trash_path
            .parent()
            .ok_or_else(|| {
                AppError::FileSystem("Trash Bin payload path has no storage directory.".to_string())
            })?
            .to_path_buf();

        if let Err(error) = std::fs::create_dir_all(&storage_dir) {
            cleanup_prepared_storage(&prepared);
            return Err(AppError::FileSystem(format!(
                "Failed to create Trash Bin storage directory: {}",
                error
            )));
        }
        if let Err(error) = validate_trash_payload_path(app_data_dir, &trash_path) {
            let _ = std::fs::remove_dir(&storage_dir);
            cleanup_prepared_storage(&prepared);
            return Err(error);
        }

        let manifest_index = entries.len();
        entries.push(TrashEntry {
            id: entry_id.clone(),
            original_path: target_path.to_string_lossy().to_string(),
            trash_path: trash_path.to_string_lossy().to_string(),
            deleted_at: chrono::Local::now().to_rfc3339(),
            command: command.to_string(),
            batch_id: Some(batch_id.to_string()),
            is_directory,
            storage_id: Some(storage_id.clone()),
            state: TrashEntryState::Pending,
            restore: None,
        });
        prepared.push(PreparedTrashItem {
            target_path: target_path.clone(),
            trash_path,
            storage_dir,
            storage_id,
            entry_id,
            manifest_index,
            is_directory,
        });
    }

    if let Err(error) = write_manifest_atomic_unlocked(app_data_dir, &entries) {
        cleanup_prepared_storage(&prepared);
        return Err(error);
    }

    let mut result = BatchTrashMoveResult {
        moved_details: Vec::with_capacity(prepared.len()),
        failed_count: 0,
        first_error: None,
    };
    let mut failed_ids = std::collections::HashSet::new();

    for item in &prepared {
        let final_validation = (|| -> Result<(), AppError> {
            if !delete_semantics_allow_target(&item.target_path, command)?
                || delete_target_item_is_directory(&item.target_path)? != item.is_directory
            {
                return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
            }
            ensure_delete_path_allowed(&item.target_path, allowed_roots)?;
            command_validator::validate_delete_target_safety(&item.target_path, app_data_dir)?;
            ensure_target_does_not_capture_active_transfer(&item.target_path, &entries)
        })();

        let move_result = match final_validation {
            Ok(()) => move_to_trash_transaction(
                &item.target_path,
                &item.trash_path,
                &item.storage_id,
                app_data_dir,
                &mut entries,
                item.manifest_index,
                false,
            ),
            Err(error) => Err(TrashMoveFailure {
                error,
                recovery_required: false,
            }),
        };
        match move_result {
            Ok(()) => {
                let type_label = if item.is_directory {
                    "Directory"
                } else {
                    "File"
                };
                result.moved_details.push(format!(
                    "{}: {} → {}",
                    type_label,
                    item.target_path.display(),
                    item.trash_path.display()
                ));
            }
            Err(failure) => {
                if !failure.recovery_required {
                    if let Ok(candidate) = trash_transfer::candidate_path(&item.trash_path) {
                        let _ = trash_transfer::remove_candidate_if_present(&candidate);
                    }
                    failed_ids.insert(item.entry_id.clone());
                    let _ = std::fs::remove_dir(&item.storage_dir);
                }
                result.failed_count = result.failed_count.saturating_add(1);
                if result.first_error.is_none() {
                    result.first_error = Some(failure.error);
                }
            }
        }
    }

    if !failed_ids.is_empty() {
        entries.retain(|entry| !failed_ids.contains(&entry.id));
    }
    write_manifest_atomic_unlocked(app_data_dir, &entries)?;
    Ok(result)
}

fn opaque_delete_success_observation() -> String {
    DELETE_SUCCESS_OBSERVATION.to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeleteInterceptionOutcome {
    /// 已证明命令不包含受支持或可疑的本地文件删除意图，唯一允许继续 spawn 的结果。
    NotDelete,
    /// 删除已安全软删除，或目标已不存在而被安全地按幂等删除处理。
    Intercepted(String),
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
/// - `Ok(Intercepted(message))`: 成功拦截/安全幂等处理，绝不再执行原命令
/// - `Ok(NotDelete)`: 已证明不是本地文件删除，允许继续正常执行流程
/// - `Err`: 检测到删除但无法安全处理，fail closed
///
/// 支持通配符路径（如 `del *.webp`），使用 glob 展开后逐个移动
pub fn try_intercept_delete(
    command: &str,
    app_data_dir: &Path,
    workdir: Option<&Path>,
) -> Result<DeleteInterceptionOutcome, AppError> {
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
) -> Result<DeleteInterceptionOutcome, AppError> {
    try_intercept_delete_scoped_with_env(command, app_data_dir, workdir, allowed_roots, None)
}

/// 与 [`try_intercept_delete_scoped`] 相同，但使用即将传给子进程的有效环境变量解析
/// PowerShell `$env:*` 路径，避免预检和实际 shell 语义分叉。
pub fn try_intercept_delete_scoped_with_env(
    command: &str,
    app_data_dir: &Path,
    workdir: Option<&Path>,
    allowed_roots: Option<&[PathBuf]>,
    effective_env: Option<&std::collections::HashMap<String, String>>,
) -> Result<DeleteInterceptionOutcome, AppError> {
    if powershell_delete_is_what_if(command) {
        return Ok(DeleteInterceptionOutcome::Intercepted(
            opaque_delete_success_observation(),
        ));
    }
    if extract_cmd_c_inner_with_autorun_state(command).is_some_and(|(inner, autorun_disabled)| {
        !autorun_disabled
            && (contains_cmd_delete_intent(&inner) || contains_executable_powershell_delete(&inner))
    }) {
        log::warn!(
            "[TrashBin] blocked nested CMD delete without /D AutoRun suppression: {}",
            command
        );
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }
    if powershell_has_static_delete(command) && !powershell_launcher_disables_profiles(command) {
        log::warn!(
            "[TrashBin] blocked PowerShell delete without -NoProfile: {}",
            command
        );
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }
    if powershell_has_static_delete(command)
        && powershell_launcher_changes_working_directory(command)
    {
        log::warn!(
            "[TrashBin] blocked PowerShell delete with launcher working-directory override: {}",
            command
        );
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }
    if extract_cmd_c_inner(command)
        .is_some_and(|inner| contains_executable_powershell_delete(&inner))
    {
        log::warn!(
            "[TrashBin] blocked nested CMD/PowerShell delete with ambiguous wrapper semantics: {}",
            command
        );
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }
    if !cmd_delete_semantics_supported(command) {
        log::warn!(
            "[TrashBin] blocked CMD delete with unsupported target semantics: {}",
            command
        );
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }
    if powershell_delete_has_unsupported_parameters(command) {
        log::warn!(
            "[TrashBin] blocked PowerShell delete with unsupported target semantics: {}",
            command
        );
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }
    if !powershell_delete_target_syntax_is_supported(command) {
        log::warn!(
            "[TrashBin] blocked PowerShell delete with an unmodeled target expression: {}",
            command
        );
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }
    if powershell_delete_has_unsupported_control_flow(command) {
        log::warn!(
            "[TrashBin] blocked PowerShell delete with unsupported control flow: {}",
            command
        );
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }
    if powershell_delete_has_unsafe_prefix(command) {
        log::warn!(
            "[TrashBin] blocked PowerShell delete with an unmodeled executable prefix: {}",
            command
        );
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }
    if powershell_delete_mutates_environment_before_target(command) {
        log::warn!(
            "[TrashBin] blocked PowerShell delete after an environment mutation: {}",
            command
        );
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }

    let powershell_expands_enumeration = {
        let lower = command.to_ascii_lowercase();
        lower.contains("get-childitem")
            && (lower.contains("foreach-object") || lower.contains("foreach "))
            && lower.contains(".fullname")
    };
    let powershell_glob_allowed =
        !powershell_delete_has_parameter(command, "literalpath") || powershell_expands_enumeration;
    let extracted_powershell_targets = extract_powershell_remove_item_targets_with_app_data_dir(
        command,
        workdir,
        Some(app_data_dir),
        effective_env,
    );

    let powershell_single_target = if let Some((target_paths, is_directory)) =
        extracted_powershell_targets
    {
        if target_paths.iter().any(|path| {
            contains_unresolved_powershell_variable(path) || contains_unresolved_cmd_variable(path)
        }) {
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
                powershell_glob_allowed,
            );
        }

        match target_paths.into_iter().next() {
            Some(target_path) => Some((target_path, is_directory)),
            None => None,
        }
    } else {
        None
    };

    let mut cmd_single_target = None;
    if let Some((target_paths, is_directory)) = extract_cmd_delete_targets(command) {
        if target_paths
            .iter()
            .any(|path| contains_unresolved_cmd_variable(path))
        {
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
                true,
            );
        }
        cmd_single_target = target_paths
            .into_iter()
            .next()
            .map(|target| (target, is_directory));
    }

    let parsed_target = powershell_single_target
        .or(cmd_single_target)
        .or_else(|| extract_delete_target_with_workdir(command, workdir));

    if parsed_target.is_none() && has_unhandled_delete_intent(command) {
        log::warn!(
            "[TrashBin] blocked unhandled delete-like command: {}",
            command
        );
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }

    let (target_path_str, is_directory) = match parsed_target {
        Some(result) => result,
        None => return Ok(DeleteInterceptionOutcome::NotDelete),
    };

    if contains_unresolved_powershell_variable(&target_path_str)
        || contains_unresolved_cmd_variable(&target_path_str)
        || (contains_cmd_delete_intent(command) && command.contains('^'))
    {
        log::warn!(
            "[TrashBin] blocked delete command with unresolved target variable: {}",
            command
        );
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }

    // 2. 通配符路径 → glob 展开后批量移动
    if is_glob_pattern(&target_path_str) {
        if powershell_glob_allowed {
            if !simple_glob_pattern_supported(&target_path_str) {
                return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
            }
            return handle_glob_delete(
                &target_path_str,
                command,
                app_data_dir,
                workdir,
                allowed_roots,
            );
        }
        // PowerShell -LiteralPath 不展开通配符；Windows 上这些字符也不是合法文件名。
        // 消费命令但绝不把它误当成 glob 批量删除。
        return Ok(DeleteInterceptionOutcome::Intercepted(
            opaque_delete_success_observation(),
        ));
    }

    // 3. 普通路径 → 验证存在性后单个移动
    let target_path = resolve_delete_path(&target_path_str, workdir)?;
    match std::fs::symlink_metadata(&target_path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // 已识别的删除绝不回退 OS；不存在目标按幂等删除成功处理，避免 TOCTOU 窗口。
            return Ok(DeleteInterceptionOutcome::Intercepted(
                opaque_delete_success_observation(),
            ));
        }
        Err(error) => {
            return Err(AppError::FileSystem(format!(
                "Unable to inspect delete target safely: {}",
                error
            )));
        }
    }
    if !delete_semantics_allow_target(&target_path, command)? {
        return Ok(DeleteInterceptionOutcome::Intercepted(
            opaque_delete_success_observation(),
        ));
    }
    ensure_delete_path_allowed(&target_path, allowed_roots)?;
    command_validator::validate_delete_target_safety(&target_path, app_data_dir)?;

    let batch_id = generate_batch_id();
    let detail = trash_single_item(
        &target_path,
        is_directory,
        command,
        app_data_dir,
        allowed_roots,
        &batch_id,
    )?;
    log_intercepted_delete(&[detail], 0);
    Ok(DeleteInterceptionOutcome::Intercepted(
        opaque_delete_success_observation(),
    ))
}

/// 处理 CMD del/erase 的多目标删除：`del /f "a" "b" "c"`。
fn handle_multi_delete(
    target_paths: &[String],
    _is_directory: bool,
    command: &str,
    app_data_dir: &Path,
    workdir: Option<&Path>,
    allowed_roots: Option<&[PathBuf]>,
    expand_globs: bool,
) -> Result<DeleteInterceptionOutcome, AppError> {
    ensure_delete_target_count(target_paths.len())?;
    let mut budget = DeletePreflightBudget::new();
    let mut expanded_paths: Vec<PathBuf> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for target in target_paths {
        budget.check_deadline()?;
        if expand_globs && is_glob_pattern(target) {
            if !simple_glob_pattern_supported(target) {
                return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
            }
            let pattern_path = resolve_delete_path(target, workdir)?;
            ensure_delete_path_allowed(&pattern_path, allowed_roots)?;
            let glob_pattern = pattern_path.to_string_lossy().to_string();
            match glob::glob(&glob_pattern) {
                Ok(paths) => {
                    for entry in paths {
                        budget.observe_target()?;
                        let path = entry.map_err(|error| {
                            AppError::FileSystem(format!(
                                "Failed to enumerate delete glob safely: {}",
                                error
                            ))
                        })?;
                        match std::fs::symlink_metadata(&path) {
                            Ok(_) => {}
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                            Err(error) => {
                                return Err(AppError::FileSystem(format!(
                                    "Unable to inspect expanded delete target safely: {}",
                                    error
                                )));
                            }
                        }
                        let key = path_key(&path);
                        if seen.insert(key) {
                            expanded_paths.push(path);
                        }
                    }
                }
                Err(e) => {
                    return Err(AppError::Forbidden(format!(
                        "{} Invalid glob target: {}",
                        DELETE_UNSAFE_BLOCK_MESSAGE, e
                    )));
                }
            }
            continue;
        }

        budget.observe_target()?;
        let path = resolve_delete_path(target, workdir)?;
        match std::fs::symlink_metadata(&path) {
            Ok(_) => {
                let key = path_key(&path);
                if seen.insert(key) {
                    expanded_paths.push(path);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(AppError::FileSystem(format!(
                    "Unable to inspect delete target safely: {}",
                    error
                )));
            }
        }
    }
    budget.check_deadline()?;

    let mut semantically_deletable = Vec::new();
    for path in expanded_paths {
        budget.check_deadline()?;
        if delete_semantics_allow_target(&path, command)? {
            semantically_deletable.push(path);
        }
    }

    if semantically_deletable.is_empty() {
        return Ok(DeleteInterceptionOutcome::Intercepted(
            opaque_delete_success_observation(),
        ));
    }
    for path in &semantically_deletable {
        budget.check_deadline()?;
        ensure_delete_path_allowed(path, allowed_roots)?;
    }
    command_validator::validate_delete_targets_safety(&semantically_deletable, app_data_dir)?;
    budget.check_deadline()?;

    let batch_id = generate_batch_id();
    let result = trash_multiple_items(
        &semantically_deletable,
        command,
        app_data_dir,
        allowed_roots,
        &batch_id,
    )?;
    log_intercepted_delete(&result.moved_details, result.failed_count);
    if let Some(error) = result.first_error {
        return Err(error);
    }
    Ok(DeleteInterceptionOutcome::Intercepted(
        opaque_delete_success_observation(),
    ))
}

/// 处理通配符删除：展开 glob 模式后逐个移动到 Trash Bin
///
/// 例如 `del C:\Users\Admin\Pictures\*.webp` 会展开为所有匹配的 .webp 文件，
/// 逐个移动到回收站。零匹配按幂等删除成功消费，避免检查后回退产生 TOCTOU 窗口。
fn handle_glob_delete(
    pattern: &str,
    command: &str,
    app_data_dir: &Path,
    workdir: Option<&Path>,
    allowed_roots: Option<&[PathBuf]>,
) -> Result<DeleteInterceptionOutcome, AppError> {
    if !simple_glob_pattern_supported(pattern) {
        return Err(AppError::Forbidden(DELETE_UNSAFE_BLOCK_MESSAGE.to_string()));
    }
    let mut budget = DeletePreflightBudget::new();
    // 使用 glob 展开通配符
    let pattern_path = resolve_delete_path(pattern, workdir)?;
    ensure_delete_path_allowed(&pattern_path, allowed_roots)?;
    let glob_pattern = pattern_path.to_string_lossy().to_string();
    let matched_paths: Vec<std::path::PathBuf> = match glob::glob(&glob_pattern) {
        Ok(paths) => {
            let mut matched_paths = Vec::new();
            let mut seen = std::collections::HashSet::new();
            for entry in paths {
                budget.observe_target()?;
                let path = entry.map_err(|error| {
                    AppError::FileSystem(format!(
                        "Failed to enumerate delete glob safely: {}",
                        error
                    ))
                })?;
                match std::fs::symlink_metadata(&path) {
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => {
                        return Err(AppError::FileSystem(format!(
                            "Unable to inspect expanded delete target safely: {}",
                            error
                        )));
                    }
                }
                if seen.insert(path_key(&path)) {
                    matched_paths.push(path);
                }
            }
            matched_paths
        }
        Err(e) => {
            return Err(AppError::Forbidden(format!(
                "{} Invalid glob target: {}",
                DELETE_UNSAFE_BLOCK_MESSAGE, e
            )));
        }
    };
    budget.check_deadline()?;

    // 已识别的 glob 即使零匹配也不能回退 OS，避免检查与 spawn 之间的 TOCTOU 删除。
    let mut semantically_deletable = Vec::new();
    for path in matched_paths {
        budget.check_deadline()?;
        if delete_semantics_allow_target(&path, command)? {
            semantically_deletable.push(path);
        }
    }

    if semantically_deletable.is_empty() {
        return Ok(DeleteInterceptionOutcome::Intercepted(
            opaque_delete_success_observation(),
        ));
    }
    for path in &semantically_deletable {
        budget.check_deadline()?;
        ensure_delete_path_allowed(path, allowed_roots)?;
    }
    command_validator::validate_delete_targets_safety(&semantically_deletable, app_data_dir)?;
    budget.check_deadline()?;

    log::debug!(
        "[TrashBin] glob 模式 '{}' 匹配到 {} 个文件，开始批量移动",
        pattern,
        semantically_deletable.len()
    );

    let batch_id = generate_batch_id();
    let result = trash_multiple_items(
        &semantically_deletable,
        command,
        app_data_dir,
        allowed_roots,
        &batch_id,
    )?;
    log_intercepted_delete(&result.moved_details, result.failed_count);
    if let Some(error) = result.first_error {
        return Err(error);
    }
    Ok(DeleteInterceptionOutcome::Intercepted(
        opaque_delete_success_observation(),
    ))
}

/// 清理过期的回收站条目
///
/// 删除超过指定天数的文件/目录和 manifest 记录。
/// 由显式维护命令调用；当前应用启动流程尚未自动调度。
pub fn cleanup_expired_items(app_data_dir: &Path) -> Result<u32, AppError> {
    reconcile_incomplete_entries(app_data_dir)?;
    let now = chrono::Local::now();
    let retention = chrono::Duration::days(DEFAULT_RETENTION_DAYS as i64);
    let cleaned = with_locked_manifest(app_data_dir, |entries| {
        let mut completed_ids = std::collections::HashSet::new();

        for entry in entries.iter() {
            // Pending / PayloadReady / Claimed / PayloadVerified 是崩溃恢复现场，自动清理
            // 永远不能销毁。
            if entry.state != TrashEntryState::Ready || entry.restore.is_some() {
                continue;
            }
            let deleted_at = match chrono::DateTime::parse_from_rfc3339(&entry.deleted_at) {
                Ok(dt) => dt.with_timezone(&chrono::Local),
                Err(_) => continue,
            };
            if now - deleted_at < retention {
                continue;
            }

            let trash_path = match effective_trash_path(app_data_dir, entry) {
                Ok(path) => path,
                Err(error) => {
                    log::warn!(
                        "[TrashBin] 拒绝清理非法 manifest 条目 {}: {}",
                        entry.id,
                        error
                    );
                    continue;
                }
            };

            match delete_trash_path(app_data_dir, entry) {
                Ok(()) => {
                    log::debug!(
                        "[TrashBin] 清理过期条目: {} (已保留 {} 天)",
                        entry.original_path,
                        DEFAULT_RETENTION_DAYS
                    );
                    completed_ids.insert(entry.id.clone());
                }
                Err(error) => {
                    log::warn!("[TrashBin] 清理失败 {}: {}", trash_path.display(), error);
                    continue;
                }
            }
        }

        let cleaned = completed_ids.len() as u32;
        if !completed_ids.is_empty() {
            entries.retain(|entry| !completed_ids.contains(&entry.id));
        }
        Ok(cleaned)
    })?;

    if cleaned > 0 {
        log::info!("[TrashBin] 自动清理完成: 清理了 {} 个过期条目", cleaned);
    }

    Ok(cleaned)
}

// ==================== 单元测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(app_data_dir: &Path) -> Vec<TrashEntry> {
        read_manifest(app_data_dir).expect("manifest should be readable")
    }

    fn intercepted(result: Result<DeleteInterceptionOutcome, AppError>) -> String {
        match result.expect("delete interception should succeed") {
            DeleteInterceptionOutcome::Intercepted(observation) => observation,
            DeleteInterceptionOutcome::NotDelete => panic!("delete command was not intercepted"),
        }
    }

    fn transactional_entry(
        app_data_dir: &Path,
        original: &Path,
        state: TrashEntryState,
    ) -> (TrashEntry, PathBuf, String) {
        let storage_id = uuid::Uuid::new_v4().to_string();
        let payload = generate_trash_path(app_data_dir, &storage_id);
        let entry = TrashEntry {
            id: generate_entry_id(),
            original_path: original.to_string_lossy().to_string(),
            trash_path: payload.to_string_lossy().to_string(),
            deleted_at: chrono::Local::now().to_rfc3339(),
            command: format!("del /f /q \"{}\"", original.display()),
            batch_id: Some(generate_batch_id()),
            is_directory: original.is_dir(),
            storage_id: Some(storage_id.clone()),
            state,
            restore: None,
        };
        (entry, payload, storage_id)
    }

    #[test]
    fn reconciliation_presence_distinguishes_missing_from_inspection_error() {
        let base = std::env::temp_dir().join(format!(
            "agentvis_trash_test_presence_{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let present = base.join("present.txt");
        std::fs::write(&present, b"present").unwrap();

        assert_eq!(path_presence(&present).unwrap(), true);
        assert_eq!(path_presence(&base.join("missing.txt")).unwrap(), false);
        assert!(path_presence(Path::new("invalid\0path")).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn relative_delete_paths_are_absolutized_before_parent_normalization() {
        let current_dir = std::env::current_dir().unwrap();

        let without_workdir = resolve_delete_path("../victim.txt", None).unwrap();
        assert!(without_workdir.is_absolute());
        assert_eq!(
            without_workdir,
            normalize_path_lexically(&current_dir.join("../victim.txt"))
        );

        let relative_workdir = Path::new("nested").join("work");
        let with_relative_workdir =
            resolve_delete_path("../../victim.txt", Some(&relative_workdir)).unwrap();
        assert!(with_relative_workdir.is_absolute());
        assert_eq!(
            with_relative_workdir,
            normalize_path_lexically(&current_dir.join(relative_workdir).join("../../victim.txt"))
        );
    }

    #[test]
    fn delete_preflight_budget_enforces_count_and_deadline() {
        let mut count_budget =
            DeletePreflightBudget::with_limits(2, std::time::Duration::from_secs(60));
        assert!(count_budget.observe_target().is_ok());
        assert!(count_budget.observe_target().is_ok());
        assert!(matches!(
            count_budget.observe_target(),
            Err(AppError::Forbidden(_))
        ));

        let expired_budget = DeletePreflightBudget::with_limits(1, std::time::Duration::ZERO);
        assert!(matches!(
            expired_budget.check_deadline(),
            Err(AppError::Forbidden(_))
        ));
    }

    #[test]
    fn manifest_lock_contention_has_a_bounded_failure() {
        let base = std::env::temp_dir().join(format!(
            "agentvis_trash_test_manifest_lock_{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let lock_path = base.join("lock");
        let first = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .unwrap();
        let second = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock_path)
            .unwrap();
        FileExt::lock_exclusive(&first).unwrap();

        let contention = acquire_manifest_lock(&second, std::time::Duration::ZERO);
        assert!(
            matches!(
                contention,
                Err(AppError::FileSystem(ref message)) if message.contains("Timed out")
            ),
            "unexpected lock result: {contention:?}"
        );

        FileExt::unlock(&first).unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn manifest_lock_timeout_classification_does_not_swallow_other_filesystem_errors() {
        let timeout = AppError::FileSystem(MANIFEST_LOCK_TIMEOUT_MESSAGE.to_string());
        assert!(is_manifest_lock_timeout(&timeout));

        let other_filesystem_error = AppError::FileSystem(
            "Failed to acquire exclusive manifest lock: access denied".to_string(),
        );
        assert!(!is_manifest_lock_timeout(&other_filesystem_error));

        let decorated_timeout = AppError::FileSystem(format!(
            "{} while reconciling an entry",
            MANIFEST_LOCK_TIMEOUT_MESSAGE
        ));
        assert!(!is_manifest_lock_timeout(&decorated_timeout));
    }

    #[test]
    fn recursive_or_extended_glob_syntax_is_not_supported() {
        assert!(!simple_glob_pattern_supported("**/*.txt"));
        assert!(!simple_glob_pattern_supported("*[ab].txt"));
        assert!(simple_glob_pattern_supported("file-?.txt"));

        let base = std::env::temp_dir().join("agentvis_trash_test_recursive_glob_blocked");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let nested = workdir.join("nested");
        let victim = nested.join("keep.txt");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(&victim, "keep").unwrap();

        assert!(matches!(
            try_intercept_delete("del **/*.txt", &app_dir, Some(&workdir)),
            Err(AppError::Forbidden(_))
        ));
        assert!(victim.exists());
        assert!(manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn oversized_multi_target_delete_fails_before_any_move() {
        let base = std::env::temp_dir().join("agentvis_trash_test_multi_target_limit");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&workdir).unwrap();
        let first = workdir.join("target-0.txt");
        std::fs::write(&first, "keep").unwrap();
        let targets = (0..=MAX_DELETE_TARGETS)
            .map(|index| format!("target-{index}.txt"))
            .collect::<Vec<_>>()
            .join(" ");

        assert!(matches!(
            try_intercept_delete(&format!("del {targets}"), &app_dir, Some(&workdir)),
            Err(AppError::Forbidden(_))
        ));
        assert!(
            first.exists(),
            "limit validation must run before the first move"
        );
        assert!(manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

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
        // 直接目标解析器拒绝管道链；上层删除意图分类器负责 fail closed。
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
            "powershell -NoProfile -Command \"$target = 'C:\\data\\project'; Remove-Item -Path $target\\* -Recurse -Force\"",
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
            None,
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
    fn test_filtered_foreach_without_force_is_not_broadly_expanded() {
        let workdir = PathBuf::from("C:\\data\\project");
        let result = extract_powershell_remove_item_targets(
            "powershell -NoProfile -Command \"$dir = $env:WORKDIR; $items = Get-ChildItem -Path $dir; foreach ($item in $items) { if ($item.PSIsContainer) { Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction SilentlyContinue } else { Remove-Item -LiteralPath $item.FullName -Force -ErrorAction SilentlyContinue } }\"",
            Some(&workdir),
        );
        assert_eq!(result, Some((vec!["$item.FullName".to_string()], true)));
    }

    #[test]
    fn test_uuid_storage_path_does_not_embed_original_path() {
        let app_dir = PathBuf::from("C:\\app");
        let storage_id = uuid::Uuid::new_v4().to_string();
        let path = generate_trash_path(&app_dir, &storage_id);
        assert_eq!(
            path,
            app_dir
                .join(TRASH_BIN_DIR)
                .join(TRASH_ITEMS_DIR)
                .join(storage_id)
                .join("payload")
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
            storage_id: None,
            state: TrashEntryState::Ready,
            restore: None,
        };

        append_to_manifest(&dir, entry.clone()).unwrap();
        let loaded = manifest(&dir);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].original_path, "C:\\data\\file.txt");

        // 清理
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── 完整拦截流程 ──

    #[test]
    fn test_intercept_nonexistent_file_is_consumed() {
        let dir = std::env::temp_dir().join("agentvis_trash_test_nofile");
        // 已识别删除即使目标不存在也必须消费，不能回退到 OS 执行。
        let result = try_intercept_delete(
            "del C:\\nonexistent\\file_that_does_not_exist.txt",
            &dir,
            None,
        );
        assert_eq!(intercepted(result), DELETE_SUCCESS_OBSERVATION);
    }

    #[test]
    fn test_intercept_non_delete_returns_none() {
        let dir = std::env::temp_dir().join("agentvis_trash_test_nodel");
        let result = try_intercept_delete("git status", &dir, None);
        assert!(matches!(
            result.unwrap(),
            DeleteInterceptionOutcome::NotDelete
        ));
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
            "powershell -NoProfile -Command \"del '{}'\"",
            test_file.to_string_lossy()
        );
        let result = try_intercept_delete(&cmd, &app_dir, Some(&workdir));

        assert_eq!(intercepted(result), DELETE_SUCCESS_OBSERVATION);
        assert!(!test_file.exists());
        assert_eq!(manifest(&app_dir).len(), 1);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_recommended_powershell_literal_delete_reaches_trash_interception() {
        let base = std::env::temp_dir().join(format!(
            "agentvis_trash_test_ps_literal_{}",
            uuid::Uuid::new_v4()
        ));
        let app_dir = base.join("app");
        let workdir = base.join("work");
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::create_dir_all(&workdir).unwrap();

        let test_file = workdir.join("literal_delete_me.txt");
        std::fs::write(&test_file, "test content").unwrap();
        let command = format!(
            "powershell -NoProfile -Command \"Remove-Item -LiteralPath '{}' -Force\"",
            test_file.to_string_lossy()
        );

        assert!(should_defer_powershell_delete_to_trash(&command));
        assert_eq!(
            intercepted(try_intercept_delete(&command, &app_dir, Some(&workdir))),
            DELETE_SUCCESS_OBSERVATION
        );
        assert!(!test_file.exists());
        let entries = manifest(&app_dir);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].state, TrashEntryState::Ready);
        assert!(Path::new(&entries[0].trash_path).exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn only_modeled_powershell_delete_envelopes_defer_script_scanning() {
        assert!(!should_defer_powershell_delete_to_trash(
            r#"powershell -Command "Remove-Item -LiteralPath 'victim.txt' -Force""#
        ));
        assert!(!should_defer_powershell_delete_to_trash(
            r#"powershell -NoProfile -Command "[System.IO.File]::Delete('victim.txt')""#
        ));
        assert!(!should_defer_powershell_delete_to_trash(
            r#"powershell -NoProfile -Command "iex 'Remove-Item victim.txt -Force'""#
        ));
        assert!(!should_defer_powershell_delete_to_trash(
            r#"powershell -NoProfile -WorkingDirectory C:\work -Command "Remove-Item -LiteralPath 'victim.txt' -Force""#
        ));
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
        assert!(manifest(&app_dir).is_empty());

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

        assert!(matches!(
            try_intercept_delete("git clean -ndx", &app_dir, Some(&app_dir)).unwrap(),
            DeleteInterceptionOutcome::NotDelete
        ));
        assert!(manifest(&app_dir).is_empty());

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

        let observation = intercepted(result);
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
        let entries = manifest(&dir);
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
        assert_eq!(intercepted(result), DELETE_SUCCESS_OBSERVATION);
        assert!(!test_file.exists());

        let entries = manifest(&app_dir);
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
        assert!(manifest(&app_dir).is_empty());

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

        let entries = manifest(&app_dir);
        assert_eq!(entries.len(), 1);
        let entry_id = entries[0].id.clone();
        let trash_path = PathBuf::from(&entries[0].trash_path);
        assert!(trash_path.exists());

        let delete = delete_entries_matching(&app_dir, |entry| entry.id == entry_id).unwrap();
        assert_eq!(delete.deleted_count, 1);
        assert!(delete.missing.is_empty());
        assert!(delete.failed.is_empty());
        assert!(!trash_path.exists());
        assert!(manifest(&app_dir).is_empty());

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
            "powershell -NoProfile -Command \"$target = '{}'; Remove-Item -Path $target\\* -Recurse -Force -ErrorAction SilentlyContinue\"",
            workdir.to_string_lossy()
        );
        let result = try_intercept_delete(&cmd, &app_dir, Some(&workdir));

        assert_eq!(intercepted(result), DELETE_SUCCESS_OBSERVATION);
        assert!(
            workdir.exists(),
            "wildcard delete should preserve the parent directory"
        );
        assert!(!first.exists());
        assert!(!nested.exists());
        assert_eq!(manifest(&app_dir).len(), 2);

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

        assert_eq!(intercepted(result), DELETE_SUCCESS_OBSERVATION);
        assert!(
            workdir.exists(),
            "foreach child delete should preserve the parent directory"
        );
        assert!(!first.exists());
        assert!(!second.exists());
        let entries = manifest(&app_dir);
        assert_eq!(entries.len(), 2);
        assert!(entries
            .iter()
            .all(|entry| entry.state == TrashEntryState::Ready));
        assert_eq!(entries[0].batch_id, entries[1].batch_id);

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

        assert_eq!(intercepted(result), DELETE_SUCCESS_OBSERVATION);
        assert!(
            workdir.exists(),
            "env workdir wildcard delete should preserve the parent directory"
        );
        assert!(!first.exists());
        assert!(!nested.exists());
        assert_eq!(manifest(&app_dir).len(), 2);

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

        assert_eq!(intercepted(result), DELETE_SUCCESS_OBSERVATION);
        assert!(
            workdir.exists(),
            "env APPDATA wildcard delete should preserve the parent directory"
        );
        assert!(!first.exists());
        assert!(!nested.exists());
        assert_eq!(manifest(&app_dir).len(), 2);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn powershell_delete_uses_effective_child_environment_override() {
        let base =
            std::env::temp_dir().join("agentvis_trash_test_effective_child_environment_override");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let requested_temp = base.join("requested-temp");
        let unrelated_temp = base.join("unrelated-temp");
        let requested_victim = requested_temp.join("victim.txt");
        let unrelated_victim = unrelated_temp.join("victim.txt");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::create_dir_all(&workdir).unwrap();
        std::fs::create_dir_all(&requested_temp).unwrap();
        std::fs::create_dir_all(&unrelated_temp).unwrap();
        std::fs::write(&requested_victim, "move me").unwrap();
        std::fs::write(&unrelated_victim, "keep me").unwrap();

        let effective_env = std::collections::HashMap::from([(
            "TEMP".to_string(),
            requested_temp.to_string_lossy().to_string(),
        )]);
        let command = r#"powershell -NoProfile -Command "Remove-Item -LiteralPath "$env:TEMP\victim.txt" -Force""#;
        let result = try_intercept_delete_scoped_with_env(
            command,
            &app_dir,
            Some(&workdir),
            None,
            Some(&effective_env),
        );

        assert_eq!(intercepted(result), DELETE_SUCCESS_OBSERVATION);
        assert!(!requested_victim.exists());
        assert!(unrelated_victim.exists());
        assert_eq!(manifest(&app_dir).len(), 1);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn supplied_effective_environment_does_not_invent_missing_appdata() {
        let base = std::env::temp_dir().join("agentvis_trash_test_missing_effective_appdata");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let inferred_victim = base.join("victim.txt");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::create_dir_all(&workdir).unwrap();
        std::fs::write(&inferred_victim, "keep me").unwrap();

        let effective_env = std::collections::HashMap::new();
        let command = r#"powershell -NoProfile -Command "Remove-Item -LiteralPath "$env:APPDATA\victim.txt" -Force""#;
        let result = try_intercept_delete_scoped_with_env(
            command,
            &app_dir,
            Some(&workdir),
            None,
            Some(&effective_env),
        );

        assert!(matches!(result, Err(AppError::Forbidden(_))));
        assert!(inferred_victim.exists());
        assert!(manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn powershell_environment_mutation_before_delete_fails_closed() {
        let base = std::env::temp_dir().join("agentvis_trash_test_environment_mutation_block");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let initial_temp = base.join("initial-temp");
        let reassigned_temp = base.join("reassigned-temp");
        let initial_victim = initial_temp.join("victim.txt");
        let reassigned_victim = reassigned_temp.join("victim.txt");
        let _ = std::fs::remove_dir_all(&base);
        for directory in [&app_dir, &workdir, &initial_temp, &reassigned_temp] {
            std::fs::create_dir_all(directory).unwrap();
        }
        std::fs::write(&initial_victim, "keep initial").unwrap();
        std::fs::write(&reassigned_victim, "keep reassigned").unwrap();

        let effective_env = std::collections::HashMap::from([(
            "TEMP".to_string(),
            initial_temp.to_string_lossy().to_string(),
        )]);
        let commands = [
            format!(
                r#"powershell -NoProfile -Command "$env:TEMP = '{}'; Remove-Item -LiteralPath "$env:TEMP\victim.txt" -Force""#,
                reassigned_temp.to_string_lossy()
            ),
            r#"powershell -NoProfile -Command "$env:TEMP += '\sub'; Remove-Item -LiteralPath "$env:TEMP\victim.txt" -Force""#
                .to_string(),
            format!(
                r#"powershell -NoProfile -Command "Set-Item -LiteralPath Env:TEMP -Value '{}'; Remove-Item -LiteralPath "$env:TEMP\victim.txt" -Force""#,
                reassigned_temp.to_string_lossy()
            ),
            format!(
                r#"powershell -NoProfile -Command "si Env:TEMP '{}'; Remove-Item -LiteralPath "$env:TEMP\victim.txt" -Force""#,
                reassigned_temp.to_string_lossy()
            ),
            r#"powershell -NoProfile -Command "Copy-Item Env:USERPROFILE Env:TEMP -Force; Remove-Item -LiteralPath "$env:TEMP\victim.txt" -Force""#
                .to_string(),
            r#"powershell -NoProfile -Command "cp Env:USERPROFILE Env:TEMP -Force; Remove-Item -LiteralPath "$env:TEMP\victim.txt" -Force""#
                .to_string(),
            r#"powershell -NoProfile -Command "iex 'Set-Item Env:TEMP C:\other'; Remove-Item -LiteralPath "$env:TEMP\victim.txt" -Force""#
                .to_string(),
            format!(
                r#"powershell -NoProfile -Command "($env:TEMP) = '{}'; Remove-Item -LiteralPath "$env:TEMP\victim.txt" -Force""#,
                reassigned_temp.to_string_lossy()
            ),
            format!(
                "powershell -NoProfile -Command \"$env:TEMP `\n= '{}'; Remove-Item -LiteralPath \"$env:TEMP\\victim.txt\" -Force\"",
                reassigned_temp.to_string_lossy()
            ),
            format!(
                r#"powershell -NoProfile -Command "Microsoft.PowerShell.Management\Set-Item Env:TEMP '{}'; Remove-Item -LiteralPath "$env:TEMP\victim.txt" -Force""#,
                reassigned_temp.to_string_lossy()
            ),
            format!(
                r#"powershell -NoProfile -Command "$p='Env:TEMP'; Set-Item $p '{}'; Remove-Item -LiteralPath "$env:TEMP\victim.txt" -Force""#,
                reassigned_temp.to_string_lossy()
            ),
            format!(
                r#"powershell -NoProfile -Command "Set-Location Env:; Set-Item TEMP '{}'; Remove-Item -LiteralPath "$env:TEMP\victim.txt" -Force""#,
                reassigned_temp.to_string_lossy()
            ),
            format!(
                r#"powershell -NoProfile -Command "& 'Set-Item' Env:TEMP '{}'; Remove-Item -LiteralPath "$env:TEMP\victim.txt" -Force""#,
                reassigned_temp.to_string_lossy()
            ),
        ];

        for command in commands {
            let result = try_intercept_delete_scoped_with_env(
                &command,
                &app_dir,
                Some(&workdir),
                None,
                Some(&effective_env),
            );
            assert!(matches!(result, Err(AppError::Forbidden(_))));
            assert!(initial_victim.exists());
            assert!(reassigned_victim.exists());
            assert!(manifest(&app_dir).is_empty());
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn environment_derived_powershell_delete_requires_no_profile() {
        let base = std::env::temp_dir().join("agentvis_trash_test_environment_profile_block");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let temp_dir = base.join("temp");
        let victim = temp_dir.join("victim.txt");
        let _ = std::fs::remove_dir_all(&base);
        for directory in [&app_dir, &workdir, &temp_dir] {
            std::fs::create_dir_all(directory).unwrap();
        }
        std::fs::write(&victim, "keep me").unwrap();
        let effective_env = std::collections::HashMap::from([(
            "TEMP".to_string(),
            temp_dir.to_string_lossy().to_string(),
        )]);

        let command =
            r#"powershell -Command "Remove-Item -LiteralPath "$env:TEMP\victim.txt" -Force""#;
        let result = try_intercept_delete_scoped_with_env(
            command,
            &app_dir,
            Some(&workdir),
            None,
            Some(&effective_env),
        );

        assert!(matches!(result, Err(AppError::Forbidden(_))));
        assert!(victim.exists());
        assert!(manifest(&app_dir).is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn chained_and_cmd_wrapped_rimraf_fail_closed() {
        let base = std::env::temp_dir().join("agentvis_trash_test_wrapped_rimraf");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let victim = workdir.join("dist").join("keep.txt");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(victim.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::write(&victim, "keep me").unwrap();

        for command in [
            "cd /d . && npx rimraf dist",
            "echo ready & rimraf dist",
            r#"cmd /c "npx rimraf dist""#,
            r#"echo ready && cmd /c "pnpm exec rimraf dist""#,
            "npm exec rimraf -- dist",
            "call npx rimraf dist",
            r#"powershell -Command "npx rimraf dist""#,
            "cmd.exe /q/d/c npx rimraf dist",
            r#"cmd.exe /q/d/c "call npx rimraf dist""#,
            r#""C:\Windows\System32\cmd.exe" /c npx rimraf dist"#,
            "%ComSpec% /c npx rimraf dist",
            "cmd /c start /wait npx rimraf dist",
            r#"powershell -Command "Start-Process npx -ArgumentList 'rimraf','dist'""#,
            r#"powershell -Command "Invoke-Expression 'npx rimraf dist'""#,
            "if exist dist npx rimraf dist",
            "npx rimraf@latest dist",
            "pnpm dlx rimraf@6 dist",
            "corepack pnpm exec rimraf dist",
            "npm -w workspace exec rimraf -- dist",
            "pnpm --filter workspace exec rimraf dist",
            "yarn --cwd . exec rimraf dist",
            "cmd.exe/c npx rimraf dist",
            "call cmd.exe/d/c npx rimraf dist",
            r#"powershell -NoProfile -Command 'npx rimraf dist'"#,
            r#"npm exec --call="npx rimraf dist""#,
            "for %F in (dist) do npx rimraf %F",
            r#"forfiles /c "cmd /d /c npx rimraf @path""#,
        ] {
            let result = try_intercept_delete(command, &app_dir, Some(&workdir));
            assert!(
                matches!(result, Err(AppError::Forbidden(_))),
                "{command} must fail closed"
            );
            assert!(victim.exists(), "{command} must not touch the target");
            assert!(manifest(&app_dir).is_empty());
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn package_queries_that_only_mention_rimraf_are_not_delete_intent() {
        let app_dir = std::env::temp_dir().join("agentvis_trash_test_rimraf_query_negative");
        for command in [
            "pnpm list rimraf",
            "yarn why rimraf",
            "npx echo rimraf",
            "npm exec echo -- rimraf",
            r#"powershell -Command "Write-Output 'rimraf'""#,
        ] {
            assert!(
                matches!(
                    try_intercept_delete(command, &app_dir, None),
                    Ok(DeleteInterceptionOutcome::NotDelete)
                ),
                "read-only package query must not be treated as delete: {command}"
            );
        }
    }

    #[test]
    fn dynamic_powershell_delete_forms_fail_closed() {
        let base = std::env::temp_dir().join("agentvis_trash_test_dynamic_powershell_delete");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let victim = workdir.join("keep.txt");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::create_dir_all(&workdir).unwrap();
        std::fs::write(&victim, "keep me").unwrap();

        for command in [
            r#"powershell -NoProfile -Command "iex 'Remove-Item -LiteralPath keep.txt -Force'""#,
            r#"powershell -NoProfile -Command "& 'Remove-Item' -LiteralPath keep.txt -Force""#,
            r#"powershell -NoProfile -Command "$c='Remove-Item'; & $c -LiteralPath keep.txt -Force""#,
            r#"powershell -NoProfile -Command "[scriptblock]::Create('Remove-Item -LiteralPath keep.txt -Force').Invoke()""#,
        ] {
            let result = try_intercept_delete(command, &app_dir, Some(&workdir));
            assert!(
                matches!(result, Err(AppError::Forbidden(_))),
                "dynamic delete must fail closed: {command}"
            );
            assert!(victim.exists());
            assert!(manifest(&app_dir).is_empty());
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn unmodeled_powershell_launch_and_target_semantics_fail_closed() {
        let base = std::env::temp_dir().join("agentvis_trash_test_strict_powershell_delete");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let victim = workdir.join("keep.txt");
        let safe = workdir.join("safe.txt");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&workdir).unwrap();
        std::fs::write(&victim, "keep").unwrap();
        std::fs::write(&safe, "safe").unwrap();

        let commands = [
            r#"powershell -Command "Remove-Item -LiteralPath keep.txt -Force""#.to_string(),
            format!(
                r#"pwsh -NoProfile -WorkingDirectory "{}" -Command "Remove-Item -LiteralPath keep.txt -Force""#,
                workdir.to_string_lossy()
            ),
            r#"powershell -NoProfile -Command "Microsoft.PowerShell.Management\Remove-Item -LiteralPath keep.txt -Force""#.to_string(),
            r#"powershell -NoProfile -Command "$target='keep' + '.txt'; Remove-Item -LiteralPath $target -Force""#.to_string(),
            r#"powershell -NoProfile -Command "$target='safe.txt'; $target += '.bak'; Remove-Item -LiteralPath $target -Force""#.to_string(),
            r#"powershell -NoProfile -Command "Remove-Item -LiteralPath ('keep' + '.txt') -Force""#.to_string(),
            r#"powershell -NoProfile -Command "Remove-Item -LiteralPath ~\keep.txt -Force""#.to_string(),
            r#"powershell -NoProfile -Command "iex ('Remove-' + 'Item -LiteralPath keep.txt -Force')""#.to_string(),
            r#"powershell -NoProfile -Command ". ([scriptblock]::Create('Remove-Item -LiteralPath keep.txt -Force'))""#.to_string(),
            r#"powershell -NoProfile -Command "powershell -NoProfile -Command 'Remove-Item -LiteralPath keep.txt -Force'""#.to_string(),
            r#"powershell -NoProfile -Command "Set-Alias x Remove-Item; x -LiteralPath keep.txt -Force""#.to_string(),
            r#"powershell -NoProfile -Command $x='Remove-Item -LiteralPath keep.txt -Force'; iex $x"#.to_string(),
        ];

        for command in commands {
            assert!(
                matches!(
                    try_intercept_delete(&command, &app_dir, Some(&workdir)),
                    Err(AppError::Forbidden(_))
                ),
                "unmodeled PowerShell semantics must fail closed: {command}"
            );
            assert!(victim.exists());
            assert!(safe.exists());
            assert!(manifest(&app_dir).is_empty());
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cmd_control_wrapped_powershell_deletes_fail_closed() {
        let base = std::env::temp_dir().join("agentvis_trash_test_cmd_wrapped_powershell");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let victim = workdir.join("keep.txt");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&workdir).unwrap();
        std::fs::write(&victim, "keep").unwrap();

        for command in [
            r#"call powershell.exe -NoProfile -Command "Remove-Item -LiteralPath keep.txt -Force""#,
            r#"if exist keep.txt powershell -NoProfile -Command "Remove-Item -LiteralPath keep.txt -Force""#,
            r#"start "" /wait powershell -NoProfile -Command "Remove-Item -LiteralPath keep.txt -Force""#,
            r#"@call powershell.exe -NoProfile -Command "Remove-Item -LiteralPath keep.txt -Force""#,
            r#"@if exist keep.txt powershell -NoProfile -Command "Remove-Item -LiteralPath keep.txt -Force""#,
            r#"1>nul 2>&1 powershell -NoProfile -Command "Remove-Item -LiteralPath keep.txt -Force""#,
        ] {
            assert!(
                matches!(
                    try_intercept_delete(command, &app_dir, Some(&workdir)),
                    Err(AppError::Forbidden(_))
                ),
                "wrapped PowerShell delete must fail closed: {command}"
            );
            assert!(victim.exists());
            assert!(manifest(&app_dir).is_empty());
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cmd_redirection_prefixed_delete_fails_closed() {
        let base = std::env::temp_dir().join("agentvis_trash_test_redirected_cmd_delete");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let victim = workdir.join("keep.txt");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&workdir).unwrap();
        std::fs::write(&victim, "keep").unwrap();

        assert!(matches!(
            try_intercept_delete("2>nul del /f /q keep.txt", &app_dir, Some(&workdir)),
            Err(AppError::Forbidden(_))
        ));
        for command in ["del>nul /f /q keep.txt", "rmdir>nul /s /q keep-directory"] {
            assert!(matches!(
                try_intercept_delete(command, &app_dir, Some(&workdir)),
                Err(AppError::Forbidden(_))
            ));
        }
        assert!(victim.exists());
        assert!(manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn chained_and_cmd_wrapped_powershell_delete_fails_closed() {
        let base = std::env::temp_dir().join("agentvis_trash_test_wrapped_powershell_delete");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let victim = workdir.join("keep.txt");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::create_dir_all(&workdir).unwrap();
        std::fs::write(&victim, "keep me").unwrap();

        let quoted_victim = victim.to_string_lossy();
        let commands = [
            format!(
                r#"cmd /c "powershell -Command "Remove-Item -LiteralPath '{}' -Force"""#,
                quoted_victim
            ),
            format!(
                r#"echo ready && powershell -Command "Remove-Item -LiteralPath '{}' -Force""#,
                quoted_victim
            ),
            format!(
                r#"set TEMP={} && powershell -Command "Remove-Item -LiteralPath "$env:TEMP\keep.txt" -Force""#,
                workdir.to_string_lossy()
            ),
        ];

        for command in commands {
            let result = try_intercept_delete(&command, &app_dir, Some(&workdir));
            assert!(
                matches!(result, Err(AppError::Forbidden(_))),
                "{command} must fail closed"
            );
            assert!(victim.exists());
            assert!(manifest(&app_dir).is_empty());
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn powershell_get_childitem_pipeline_moves_only_matching_files() {
        let base = std::env::temp_dir().join("agentvis_trash_test_powershell_pipeline");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let first = workdir.join("first.log");
        let second = workdir.join("second.log");
        let keep = workdir.join("keep.txt");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::create_dir_all(&workdir).unwrap();
        std::fs::write(&first, "first").unwrap();
        std::fs::write(&second, "second").unwrap();
        std::fs::write(&keep, "keep").unwrap();

        let result = try_intercept_delete(
            "powershell -NoProfile -Command \"Get-ChildItem -Force '*.log' | Remove-Item -Force\"",
            &app_dir,
            Some(&workdir),
        );

        assert_eq!(intercepted(result), DELETE_SUCCESS_OBSERVATION);
        assert!(!first.exists());
        assert!(!second.exists());
        assert!(keep.exists());
        assert_eq!(manifest(&app_dir).len(), 2);

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
        assert!(manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_complex_powershell_foreach_fails_closed_without_touching_children() {
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

        assert!(matches!(result, Err(AppError::Forbidden(_))));
        assert!(workdir.exists());
        assert!(first.exists());
        assert!(nested.exists());
        assert!(manifest(&app_dir).is_empty());

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

        let observation = intercepted(result);
        assert_eq!(observation, DELETE_SUCCESS_OBSERVATION);
        assert!(!observation.to_lowercase().contains("trash"));
        assert!(!observation.contains("Agent_Trash_Bin"));
        assert!(!observation.contains(&app_dir.to_string_lossy().to_string()));
        assert!(!observation.contains(&test_file.to_string_lossy().to_string()));
        assert!(!test_file.exists(), "workdir 下的相对目标应被移动");

        let entries = manifest(&app_dir);
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

        assert_eq!(intercepted(result), DELETE_SUCCESS_OBSERVATION);
        assert!(!test_file.exists(), "allowed root target should be moved");
        assert_eq!(manifest(&app_dir).len(), 1);

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
        assert!(manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn expanded_powershell_target_is_rechecked_against_custom_protection() {
        let base = std::env::temp_dir().join("agentvis_trash_test_expanded_protected_target");
        let roaming_dir = base.join("roaming");
        let app_dir = roaming_dir.join("com.agentvis.app");
        let protected_dir = roaming_dir.join("protected");
        let victim = protected_dir.join("victim.txt");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::create_dir_all(&protected_dir).unwrap();
        std::fs::create_dir_all(&workdir).unwrap();
        std::fs::write(&victim, "keep").unwrap();
        std::fs::write(
            app_dir.join("protected_paths.json"),
            serde_json::to_vec(&vec![protected_dir.to_string_lossy().to_string()]).unwrap(),
        )
        .unwrap();

        let command = r#"powershell -Command "Remove-Item -LiteralPath "$env:APPDATA/protected/victim.txt" -Force""#;
        let result = try_intercept_delete(command, &app_dir, Some(&workdir));

        assert!(matches!(
            result,
            Err(AppError::Forbidden(ref message))
                if message.contains("[recoverable_delete_required]")
        ));
        assert!(victim.exists(), "protected target must not be moved");
        assert!(manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn glob_matches_are_protection_checked_before_any_target_moves() {
        let base = std::env::temp_dir().join("agentvis_trash_test_glob_protected_preflight");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let safe_dir = workdir.join("safe");
        let protected_dir = workdir.join("protected");
        let safe_file = safe_dir.join("keep.txt");
        let protected_file = protected_dir.join("keep.txt");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::create_dir_all(&safe_dir).unwrap();
        std::fs::create_dir_all(&protected_dir).unwrap();
        std::fs::write(&safe_file, "safe").unwrap();
        std::fs::write(&protected_file, "protected").unwrap();
        std::fs::write(
            app_dir.join("protected_paths.json"),
            serde_json::to_vec(&vec![protected_dir.to_string_lossy().to_string()]).unwrap(),
        )
        .unwrap();

        let pattern = workdir.join("*").join("*.txt");
        let result = try_intercept_delete(
            &format!("del /q \"{}\"", pattern.to_string_lossy()),
            &app_dir,
            Some(&workdir),
        );

        assert!(matches!(result, Err(AppError::Forbidden(_))));
        assert!(
            safe_file.exists(),
            "preflight must happen before the first move"
        );
        assert!(protected_file.exists());
        assert!(manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn files_only_glob_filters_directories_before_protection_checks() {
        let base = std::env::temp_dir().join("agentvis_trash_test_glob_semantics_first");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let protected_directory = workdir.join("protected.tmp");
        let deletable_file = workdir.join("delete.tmp");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::create_dir_all(&protected_directory).unwrap();
        std::fs::write(protected_directory.join("keep.txt"), "keep").unwrap();
        std::fs::write(&deletable_file, "delete").unwrap();
        std::fs::write(
            app_dir.join("protected_paths.json"),
            serde_json::to_vec(&vec![protected_directory.to_string_lossy().to_string()]).unwrap(),
        )
        .unwrap();

        assert_eq!(
            intercepted(try_intercept_delete("del *.tmp", &app_dir, Some(&workdir))),
            DELETE_SUCCESS_OBSERVATION
        );
        assert!(protected_directory.exists());
        assert!(protected_directory.join("keep.txt").exists());
        assert!(!deletable_file.exists());
        assert_eq!(manifest(&app_dir).len(), 1);

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
        assert!(manifest(&app_dir).is_empty());

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

        let observation = intercepted(result);
        assert_eq!(observation, DELETE_SUCCESS_OBSERVATION);
        assert!(!observation.to_lowercase().contains("trash"));
        assert!(!observation.contains("Agent_Trash_Bin"));
        assert!(!observation.contains(&app_dir.to_string_lossy().to_string()));
        assert!(!observation.contains(&workdir.to_string_lossy().to_string()));

        assert!(!first.exists());
        assert!(!second.exists());
        assert_eq!(manifest(&app_dir).len(), 2);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn powershell_non_executable_delete_text_is_not_intercepted() {
        let base = std::env::temp_dir().join("agentvis_trash_test_ps_non_executable_text");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::create_dir_all(&workdir).unwrap();
        let victim = workdir.join("keep.txt");
        std::fs::write(&victim, "keep").unwrap();
        let victim = victim.to_string_lossy();

        for command in [
            format!(
                "powershell -Command \"Write-Output 'Remove-Item -LiteralPath {}'\"",
                victim
            ),
            format!(
                "powershell -Command \"# Remove-Item -LiteralPath {}\nWrite-Output ok\"",
                victim
            ),
            format!(
                "powershell -Command \"<# Remove-Item -LiteralPath {} #> Write-Output ok\"",
                victim
            ),
        ] {
            assert!(matches!(
                try_intercept_delete(&command, &app_dir, Some(&workdir)).unwrap(),
                DeleteInterceptionOutcome::NotDelete
            ));
            assert!(Path::new(victim.as_ref()).exists());
            assert!(manifest(&app_dir).is_empty());
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn powershell_whatif_never_moves_payload() {
        let base = std::env::temp_dir().join("agentvis_trash_test_ps_whatif");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::create_dir_all(&workdir).unwrap();
        let victim = workdir.join("whatif.txt");
        std::fs::write(&victim, "keep").unwrap();

        let command = format!(
            "powershell -NoProfile -Command \"Remove-Item -LiteralPath '{}' -WhatIf\"",
            victim.to_string_lossy()
        );
        assert_eq!(
            intercepted(try_intercept_delete(&command, &app_dir, Some(&workdir))),
            DELETE_SUCCESS_OBSERVATION
        );
        assert!(victim.exists());
        assert!(manifest(&app_dir).is_empty());

        let command = format!(
            "powershell -NoProfile -Command \"Remove-Item -LiteralPath '{}' -WhatIf:$false\"",
            victim.to_string_lossy()
        );
        assert_eq!(
            intercepted(try_intercept_delete(&command, &app_dir, Some(&workdir))),
            DELETE_SUCCESS_OBSERVATION
        );
        assert!(!victim.exists());
        assert_eq!(manifest(&app_dir).len(), 1);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn powershell_literalpath_wildcard_is_not_expanded() {
        let base = std::env::temp_dir().join("agentvis_trash_test_ps_literal_wildcard");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::create_dir_all(&workdir).unwrap();
        let first = workdir.join("first.txt");
        let second = workdir.join("second.txt");
        std::fs::write(&first, "first").unwrap();
        std::fs::write(&second, "second").unwrap();
        let pattern = workdir.join("*.txt");

        let literal = format!(
            "powershell -NoProfile -Command \"Remove-Item -LiteralPath '{}' -Force\"",
            pattern.to_string_lossy()
        );
        assert_eq!(
            intercepted(try_intercept_delete(&literal, &app_dir, Some(&workdir))),
            DELETE_SUCCESS_OBSERVATION
        );
        assert!(first.exists() && second.exists());
        assert!(manifest(&app_dir).is_empty());

        let wildcard = format!(
            "powershell -NoProfile -Command \"Remove-Item -Path '{}' -Force\"",
            pattern.to_string_lossy()
        );
        assert_eq!(
            intercepted(try_intercept_delete(&wildcard, &app_dir, Some(&workdir))),
            DELETE_SUCCESS_OBSERVATION
        );
        assert!(!first.exists() && !second.exists());
        assert_eq!(manifest(&app_dir).len(), 2);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn unsupported_powershell_control_flow_fails_closed() {
        let base = std::env::temp_dir().join("agentvis_trash_test_ps_control_flow");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&workdir).unwrap();
        let victim = workdir.join("keep.txt");
        std::fs::write(&victim, "keep").unwrap();
        let command = format!(
            "powershell -Command \"if ($false) {{ Remove-Item -LiteralPath '{}' }}\"",
            victim.to_string_lossy()
        );

        assert!(matches!(
            try_intercept_delete(&command, &app_dir, Some(&workdir)),
            Err(AppError::Forbidden(_))
        ));
        assert!(victim.exists());
        assert!(manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cmd_delete_chains_and_variables_fail_closed() {
        let base = std::env::temp_dir().join("agentvis_trash_test_cmd_fail_closed");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&workdir).unwrap();
        let victim = workdir.join("keep.txt");
        std::fs::write(&victim, "keep").unwrap();
        let quoted = format!("\"{}\"", victim.to_string_lossy());

        for command in [
            format!("echo ok && del {}", quoted),
            format!("del {} || echo failed", quoted),
            format!("if exist {} del {}", quoted, quoted),
            format!("cmd /d /s /c \"set TARGET={}&&del %TARGET%\"", quoted),
            "del %TARGET%".to_string(),
            "del !TARGET!".to_string(),
        ] {
            assert!(
                matches!(
                    try_intercept_delete(&command, &app_dir, Some(&workdir)),
                    Err(AppError::Forbidden(_))
                ),
                "expected fail-closed block for {command}"
            );
            assert!(victim.exists());
            assert!(manifest(&app_dir).is_empty());
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cmd_wrapper_options_and_quoted_control_characters_are_supported() {
        let base = std::env::temp_dir().join("agentvis_trash_test_cmd_wrapper");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::create_dir_all(&workdir).unwrap();
        let wrapped = workdir.join("wrapped.txt");
        let quoted_control = workdir.join("victim&&copy.txt");
        std::fs::write(&wrapped, "wrapped").unwrap();
        std::fs::write(&quoted_control, "quoted").unwrap();

        let command = format!("cmd.exe /d /s /c del \"{}\"", wrapped.to_string_lossy());
        assert_eq!(
            intercepted(try_intercept_delete(&command, &app_dir, Some(&workdir))),
            DELETE_SUCCESS_OBSERVATION
        );
        let command = format!("del \"{}\"", quoted_control.to_string_lossy());
        assert_eq!(
            intercepted(try_intercept_delete(&command, &app_dir, Some(&workdir))),
            DELETE_SUCCESS_OBSERVATION
        );
        assert!(!wrapped.exists() && !quoted_control.exists());
        assert_eq!(manifest(&app_dir).len(), 2);

        assert!(matches!(
            try_intercept_delete("cmd /c \"echo del keep.txt\"", &app_dir, Some(&workdir)).unwrap(),
            DeleteInterceptionOutcome::NotDelete
        ));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn incomplete_entries_are_reconciled_without_deleting_data() {
        let base = std::env::temp_dir().join("agentvis_trash_test_reconcile");
        let app_dir = base.join("app");
        let original = base.join("work").join("original.txt");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(original.parent().unwrap()).unwrap();
        let storage_id = uuid::Uuid::new_v4().to_string();
        let payload = generate_trash_path(&app_dir, &storage_id);
        std::fs::create_dir_all(payload.parent().unwrap()).unwrap();
        std::fs::write(&payload, "recoverable").unwrap();
        let entry = TrashEntry {
            id: generate_entry_id(),
            original_path: original.to_string_lossy().to_string(),
            trash_path: payload.to_string_lossy().to_string(),
            deleted_at: chrono::Local::now().to_rfc3339(),
            command: "del original.txt".to_string(),
            batch_id: Some(generate_batch_id()),
            is_directory: false,
            storage_id: Some(storage_id),
            state: TrashEntryState::Pending,
            restore: None,
        };
        append_to_manifest(&app_dir, entry.clone()).unwrap();

        let blocked_delete =
            delete_entries_matching(&app_dir, |candidate| candidate.id == entry.id).unwrap();
        assert_eq!(blocked_delete.deleted_count, 0);
        assert_eq!(blocked_delete.failed.len(), 1);
        assert!(payload.exists());

        reconcile_incomplete_entries(&app_dir).unwrap();
        assert_eq!(manifest(&app_dir)[0].state, TrashEntryState::Ready);
        let restored =
            restore_entries_matching(&app_dir, |candidate| candidate.id == entry.id).unwrap();
        assert_eq!(restored.restored_count, 1);
        assert_eq!(std::fs::read_to_string(&original).unwrap(), "recoverable");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn forced_cross_volume_transaction_and_restore_preserve_nested_content() {
        let base = std::env::temp_dir().join(format!(
            "agentvis_trash_test_forced_cross_volume_{}",
            uuid::Uuid::new_v4()
        ));
        let app_dir = base.join("app");
        let original = base.join("work").join("unicode-测试");
        std::fs::create_dir_all(original.join("empty")).unwrap();
        std::fs::write(original.join("script.ps1"), b"Write-Host ok").unwrap();
        let (entry, payload, storage_id) =
            transactional_entry(&app_dir, &original, TrashEntryState::Pending);
        std::fs::create_dir_all(payload.parent().unwrap()).unwrap();
        let mut entries = vec![entry];
        write_manifest_atomic_unlocked(&app_dir, &entries).unwrap();

        move_to_trash_transaction(
            &original,
            &payload,
            &storage_id,
            &app_dir,
            &mut entries,
            0,
            true,
        )
        .unwrap();
        assert_eq!(entries[0].state, TrashEntryState::Ready);
        assert!(!original.exists());
        assert_eq!(
            std::fs::read(payload.join("script.ps1")).unwrap(),
            b"Write-Host ok"
        );
        let claim = trash_transfer::claim_path(&original, &storage_id).unwrap();
        assert!(!claim.exists());

        let entry_id = entries[0].id.clone();
        let restored = restore_entries_matching(&app_dir, |entry| entry.id == entry_id).unwrap();
        assert_eq!(restored.restored_count, 1);
        assert_eq!(
            std::fs::read(original.join("script.ps1")).unwrap(),
            b"Write-Host ok"
        );
        assert!(original.join("empty").is_dir());
        assert!(!payload.exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn payload_ready_claim_is_reconciled_and_stale_candidate_is_refreshed() {
        let base = std::env::temp_dir().join(format!(
            "agentvis_trash_test_claim_reconcile_{}",
            uuid::Uuid::new_v4()
        ));
        let app_dir = base.join("app");
        let original = base.join("work").join("changing.txt");
        std::fs::create_dir_all(original.parent().unwrap()).unwrap();
        std::fs::write(&original, b"first version").unwrap();
        let (mut entry, payload, storage_id) =
            transactional_entry(&app_dir, &original, TrashEntryState::PayloadReady);
        std::fs::create_dir_all(payload.parent().unwrap()).unwrap();
        let candidate = trash_transfer::copy_source_to_candidate(&original, &payload).unwrap();
        std::fs::write(&original, b"second version after initial copy").unwrap();
        let claim = trash_transfer::claim_source(&original, &storage_id).unwrap();
        entry.state = TrashEntryState::PayloadReady;
        append_to_manifest(&app_dir, entry).unwrap();

        reconcile_incomplete_entries(&app_dir).unwrap();
        let reconciled = manifest(&app_dir);
        assert_eq!(reconciled[0].state, TrashEntryState::Ready);
        assert!(!original.exists());
        assert!(!claim.exists());
        assert!(!candidate.exists());
        assert_eq!(
            std::fs::read(&payload).unwrap(),
            b"second version after initial copy"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn payload_ready_preexisting_claim_collision_is_never_adopted() {
        let base = std::env::temp_dir().join(format!(
            "agentvis_trash_test_claim_collision_{}",
            uuid::Uuid::new_v4()
        ));
        let app_dir = base.join("app");
        let original = base.join("work").join("source.txt");
        std::fs::create_dir_all(original.parent().unwrap()).unwrap();
        std::fs::write(&original, b"original remains").unwrap();
        let (entry, payload, storage_id) =
            transactional_entry(&app_dir, &original, TrashEntryState::PayloadReady);
        std::fs::create_dir_all(payload.parent().unwrap()).unwrap();
        let candidate = trash_transfer::copy_source_to_candidate(&original, &payload).unwrap();
        let claim = trash_transfer::claim_path(&original, &storage_id).unwrap();
        std::fs::write(&claim, b"unrelated collision").unwrap();
        append_to_manifest(&app_dir, entry).unwrap();

        reconcile_incomplete_entries(&app_dir).unwrap();
        assert!(manifest(&app_dir).is_empty());
        assert_eq!(std::fs::read(&original).unwrap(), b"original remains");
        assert_eq!(std::fs::read(&claim).unwrap(), b"unrelated collision");
        assert!(!candidate.exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn mismatched_published_payload_never_destroys_claim() {
        let base = std::env::temp_dir().join(format!(
            "agentvis_trash_test_claim_payload_mismatch_{}",
            uuid::Uuid::new_v4()
        ));
        let app_dir = base.join("app");
        let original = base.join("work").join("source.txt");
        std::fs::create_dir_all(original.parent().unwrap()).unwrap();
        std::fs::write(&original, b"correct claimed data").unwrap();
        let (entry, payload, storage_id) =
            transactional_entry(&app_dir, &original, TrashEntryState::Claimed);
        std::fs::create_dir_all(payload.parent().unwrap()).unwrap();
        let claim = trash_transfer::claim_source(&original, &storage_id).unwrap();
        std::fs::write(&payload, b"wrong preexisting payload").unwrap();
        append_to_manifest(&app_dir, entry).unwrap();

        reconcile_incomplete_entries(&app_dir).unwrap();
        let retained = manifest(&app_dir);
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].state, TrashEntryState::Claimed);
        assert_eq!(std::fs::read(&claim).unwrap(), b"correct claimed data");
        assert_eq!(
            std::fs::read(&payload).unwrap(),
            b"wrong preexisting payload"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn claimed_published_payload_finishes_cleanup_idempotently() {
        let base = std::env::temp_dir().join(format!(
            "agentvis_trash_test_published_claim_{}",
            uuid::Uuid::new_v4()
        ));
        let app_dir = base.join("app");
        let original = base.join("work").join("claimed.txt");
        std::fs::create_dir_all(original.parent().unwrap()).unwrap();
        std::fs::write(&original, b"claimed payload").unwrap();
        let (entry, payload, storage_id) =
            transactional_entry(&app_dir, &original, TrashEntryState::Claimed);
        std::fs::create_dir_all(payload.parent().unwrap()).unwrap();
        let candidate = trash_transfer::copy_source_to_candidate(&original, &payload).unwrap();
        let claim = trash_transfer::claim_source(&original, &storage_id).unwrap();
        assert!(trash_transfer::items_match(&claim, &candidate).unwrap());
        trash_transfer::publish_candidate(&candidate, &payload).unwrap();
        append_to_manifest(&app_dir, entry).unwrap();

        reconcile_incomplete_entries(&app_dir).unwrap();
        reconcile_incomplete_entries(&app_dir).unwrap();
        assert_eq!(manifest(&app_dir)[0].state, TrashEntryState::Ready);
        assert!(!claim.exists());
        assert_eq!(std::fs::read(&payload).unwrap(), b"claimed payload");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn payload_verified_partial_claim_cleanup_replays_without_requiring_exact_match() {
        let base = std::env::temp_dir().join(format!(
            "agentvis_trash_test_partial_claim_cleanup_{}",
            uuid::Uuid::new_v4()
        ));
        let app_dir = base.join("app");
        let original = base.join("work").join("claimed-directory");
        std::fs::create_dir_all(&original).unwrap();
        std::fs::write(original.join("already-removed.txt"), b"first").unwrap();
        std::fs::write(original.join("remaining.txt"), b"second").unwrap();
        let (entry, payload, storage_id) =
            transactional_entry(&app_dir, &original, TrashEntryState::PayloadVerified);
        std::fs::create_dir_all(payload.parent().unwrap()).unwrap();
        let candidate = trash_transfer::copy_source_to_candidate(&original, &payload).unwrap();
        let claim = trash_transfer::claim_source(&original, &storage_id).unwrap();
        trash_transfer::publish_candidate(&candidate, &payload).unwrap();
        trash_transfer::verify_claim_payload(&claim, &payload).unwrap();

        // Simulate a process exit after persisted verification and a partially completed recursive
        // claim cleanup. The central payload is still complete, while the remaining claim is not.
        std::fs::remove_file(claim.join("already-removed.txt")).unwrap();
        append_to_manifest(&app_dir, entry).unwrap();

        reconcile_incomplete_entries(&app_dir).unwrap();
        let reconciled = manifest(&app_dir);
        assert_eq!(reconciled.len(), 1);
        assert_eq!(reconciled[0].state, TrashEntryState::Ready);
        assert!(!claim.exists());
        assert_eq!(
            std::fs::read(payload.join("already-removed.txt")).unwrap(),
            b"first"
        );
        assert_eq!(
            std::fs::read(payload.join("remaining.txt")).unwrap(),
            b"second"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn preparing_restore_journal_preserves_unowned_collision_and_allows_retry() {
        let base = std::env::temp_dir().join(format!(
            "agentvis_trash_test_restore_preparing_{}",
            uuid::Uuid::new_v4()
        ));
        let app_dir = base.join("app");
        let original = base.join("work").join("restored.txt");
        std::fs::create_dir_all(original.parent().unwrap()).unwrap();
        let (mut entry, payload, _) =
            transactional_entry(&app_dir, &original, TrashEntryState::Ready);
        std::fs::create_dir_all(payload.parent().unwrap()).unwrap();
        std::fs::write(&payload, b"recoverable").unwrap();
        let restore_id = uuid::Uuid::new_v4().to_string();
        entry.restore = Some(TrashRestoreTransaction {
            id: restore_id.clone(),
            owner_token: uuid::Uuid::new_v4().to_string(),
            state: TrashRestoreState::Preparing,
        });
        let staged = trash_transfer::restore_staging_path(&original, &restore_id).unwrap();
        std::fs::write(&staged, b"partial").unwrap();
        let entry_id = entry.id.clone();
        append_to_manifest(&app_dir, entry).unwrap();

        reconcile_incomplete_entries(&app_dir).unwrap();
        let reconciled = manifest(&app_dir);
        assert_eq!(reconciled.len(), 1);
        assert!(reconciled[0].restore.is_none());
        assert_eq!(std::fs::read(&staged).unwrap(), b"partial");
        assert!(payload.exists());

        let restored =
            restore_entries_matching(&app_dir, |candidate| candidate.id == entry_id).unwrap();
        assert_eq!(restored.restored_count, 1);
        assert_eq!(std::fs::read(&original).unwrap(), b"recoverable");
        assert!(manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn preparing_restore_with_committed_destination_is_finished_idempotently() {
        let base = std::env::temp_dir().join(format!(
            "agentvis_trash_test_restore_committed_{}",
            uuid::Uuid::new_v4()
        ));
        let app_dir = base.join("app");
        let original = base.join("work").join("restored.txt");
        std::fs::create_dir_all(original.parent().unwrap()).unwrap();
        let (mut entry, payload, _) =
            transactional_entry(&app_dir, &original, TrashEntryState::Ready);
        std::fs::create_dir_all(payload.parent().unwrap()).unwrap();
        std::fs::write(&payload, b"same data").unwrap();
        std::fs::write(&original, b"same data").unwrap();
        entry.restore = Some(TrashRestoreTransaction {
            id: uuid::Uuid::new_v4().to_string(),
            owner_token: uuid::Uuid::new_v4().to_string(),
            state: TrashRestoreState::Preparing,
        });
        append_to_manifest(&app_dir, entry).unwrap();

        reconcile_incomplete_entries(&app_dir).unwrap();
        assert!(manifest(&app_dir).is_empty());
        assert_eq!(std::fs::read(&original).unwrap(), b"same data");
        assert!(!payload.exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn committed_restore_resumes_cleanup_from_a_partial_central_payload() {
        let base = std::env::temp_dir().join(format!(
            "agentvis_trash_test_restore_partial_cleanup_{}",
            uuid::Uuid::new_v4()
        ));
        let app_dir = base.join("app");
        let original = base.join("work").join("restored");
        std::fs::create_dir_all(&original).unwrap();
        std::fs::write(original.join("complete.txt"), b"complete destination").unwrap();
        std::fs::write(original.join("second.txt"), b"still present").unwrap();
        let (mut entry, payload, _) =
            transactional_entry(&app_dir, &original, TrashEntryState::Ready);
        std::fs::create_dir_all(&payload).unwrap();
        std::fs::write(payload.join("complete.txt"), b"partially removed payload").unwrap();
        entry.restore = Some(TrashRestoreTransaction {
            id: uuid::Uuid::new_v4().to_string(),
            owner_token: uuid::Uuid::new_v4().to_string(),
            state: TrashRestoreState::Committed,
        });
        append_to_manifest(&app_dir, entry).unwrap();

        reconcile_incomplete_entries(&app_dir).unwrap();
        assert!(manifest(&app_dir).is_empty());
        assert_eq!(
            std::fs::read(original.join("complete.txt")).unwrap(),
            b"complete destination"
        );
        assert_eq!(
            std::fs::read(original.join("second.txt")).unwrap(),
            b"still present"
        );
        assert!(!payload.exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn transaction_paths_and_overlapping_batches_fail_closed() {
        let base = std::env::temp_dir().join(format!(
            "agentvis_trash_test_transaction_boundaries_{}",
            uuid::Uuid::new_v4()
        ));
        let parent = base.join("parent");
        let child = parent.join("child.txt");
        let claim = parent.join(format!(".agentvis-trash-claim-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&parent).unwrap();
        std::fs::write(&child, b"child").unwrap();
        std::fs::write(&claim, b"claim").unwrap();

        assert!(matches!(
            ensure_delete_path_allowed(&claim, None),
            Err(AppError::Forbidden(_))
        ));
        assert!(matches!(
            ensure_delete_path_allowed(&claim.join("nested.txt"), None),
            Err(AppError::Forbidden(_))
        ));
        assert!(matches!(
            ensure_delete_targets_non_overlapping(&[parent.clone(), child.clone()]),
            Err(AppError::Forbidden(_))
        ));
        assert!(claim.exists());
        assert!(child.exists());

        let (mut active_entry, _, _) =
            transactional_entry(&base.join("app"), &child, TrashEntryState::Claimed);
        active_entry.original_path = parent.join("source.txt").to_string_lossy().to_string();
        let active_claim = trash_transfer::claim_path(
            Path::new(&active_entry.original_path),
            active_entry.storage_id.as_deref().unwrap(),
        )
        .unwrap();
        assert!(matches!(
            ensure_target_does_not_capture_active_transfer(
                &active_claim.join("nested.txt"),
                &[active_entry]
            ),
            Err(AppError::Forbidden(_))
        ));

        #[cfg(windows)]
        assert!(trash_transfer::is_internal_transfer_path(Path::new(
            r"C:\work\.AGENTVIS-TRASH-CLAIM-00000000-0000-0000-0000-000000000000\child"
        )));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn real_cross_volume_delete_and_restore_when_two_test_volumes_are_available() {
        let current_dir = std::env::current_dir().unwrap();
        let temp_dir = std::env::temp_dir();
        if current_dir.components().next() == temp_dir.components().next() {
            return;
        }

        let test_id = uuid::Uuid::new_v4();
        let source_root = current_dir
            .join("target")
            .join(format!("agentvis_cross_volume_source_{test_id}"));
        let app_dir = temp_dir.join(format!("agentvis_cross_volume_app_{test_id}"));
        let original = source_root.join("victim.txt");
        std::fs::create_dir_all(&source_root).unwrap();
        std::fs::write(&original, b"two-volume recovery").unwrap();
        let command = format!("del /f /q \"{}\"", original.display());

        assert_eq!(
            intercepted(try_intercept_delete(&command, &app_dir, Some(&source_root))),
            DELETE_SUCCESS_OBSERVATION
        );
        assert!(!original.exists());
        let entries = manifest(&app_dir);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].state, TrashEntryState::Ready);
        let restored = restore_entries_matching(&app_dir, |_| true).unwrap();
        assert_eq!(restored.restored_count, 1);
        assert_eq!(std::fs::read(&original).unwrap(), b"two-volume recovery");

        let _ = std::fs::remove_dir_all(&source_root);
        let _ = std::fs::remove_dir_all(&app_dir);
    }

    #[test]
    fn powershell_filter_and_include_fail_closed_without_moving_target() {
        let base = std::env::temp_dir().join("agentvis_trash_test_ps_unsupported_parameters");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&workdir).unwrap();
        let victim = workdir.join("keep.txt");
        std::fs::write(&victim, "keep").unwrap();

        for parameter in ["Filter", "Include"] {
            let command = format!(
                "powershell -Command \"Remove-Item -{} '*.txt' -Path '{}' -Force\"",
                parameter,
                victim.to_string_lossy()
            );
            assert!(
                matches!(
                    try_intercept_delete(&command, &app_dir, Some(&workdir)),
                    Err(AppError::Forbidden(_))
                ),
                "expected fail-closed block for {parameter}"
            );
            assert!(victim.exists(), "{parameter} must not move the target");
            assert!(manifest(&app_dir).is_empty());
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn powershell_variable_resolution_uses_assignments_before_delete_only() {
        let base = std::env::temp_dir().join("agentvis_trash_test_ps_assignment_order");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&workdir).unwrap();
        let first = workdir.join("first.txt");
        let second = workdir.join("second.txt");
        std::fs::write(&first, "first").unwrap();
        std::fs::write(&second, "second").unwrap();

        let command = "powershell -NoProfile -Command \"$target = 'first.txt'; Remove-Item -LiteralPath $target -Force; $target = 'second.txt'\"";
        assert_eq!(
            intercepted(try_intercept_delete(command, &app_dir, Some(&workdir))),
            DELETE_SUCCESS_OBSERVATION
        );
        assert!(!first.exists(), "the assignment preceding delete must win");
        assert!(
            second.exists(),
            "a later assignment must not change the intercepted target"
        );
        let entries = manifest(&app_dir);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].original_path, first.to_string_lossy());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn powershell_single_quoted_variable_fails_closed_without_expansion() {
        let base = std::env::temp_dir().join("agentvis_trash_test_ps_single_quoted_variable");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&workdir).unwrap();
        let expanded = workdir.join("expanded.txt");
        let literal = workdir.join("$target");
        std::fs::write(&expanded, "expanded").unwrap();
        std::fs::write(&literal, "literal").unwrap();

        let command = "powershell -Command \"$target = 'expanded.txt'; Remove-Item -LiteralPath '$target' -Force\"";
        assert!(matches!(
            try_intercept_delete(command, &app_dir, Some(&workdir)),
            Err(AppError::Forbidden(_))
        ));
        assert!(expanded.exists(), "single quotes must not expand $target");
        assert!(
            literal.exists(),
            "fail-closed handling must not move the literal path"
        );
        assert!(manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn powershell_variable_prefixes_resolve_at_token_boundaries() {
        let base = std::env::temp_dir().join("agentvis_trash_test_ps_variable_prefix");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&workdir).unwrap();
        let short_name = workdir.join("short.txt");
        let long_name = workdir.join("long.txt");
        std::fs::write(&short_name, "short").unwrap();
        std::fs::write(&long_name, "long").unwrap();

        let command = "powershell -NoProfile -Command \"$p = 'short.txt'; $path = 'long.txt'; Remove-Item -LiteralPath $path -Force\"";
        assert_eq!(
            intercepted(try_intercept_delete(command, &app_dir, Some(&workdir))),
            DELETE_SUCCESS_OBSERVATION
        );
        assert!(
            short_name.exists(),
            "$p must not be substituted into the $path token"
        );
        assert!(!long_name.exists());
        assert_eq!(manifest(&app_dir).len(), 1);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cmd_del_glob_moves_files_but_ignores_matching_directories() {
        let base = std::env::temp_dir().join("agentvis_trash_test_cmd_del_glob_files_only");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let matching_directory = workdir.join("directory.tmp");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&matching_directory).unwrap();
        let matching_file = workdir.join("file.tmp");
        let nested_file = matching_directory.join("nested.txt");
        std::fs::write(&matching_file, "file").unwrap();
        std::fs::write(&nested_file, "nested").unwrap();

        assert_eq!(
            intercepted(try_intercept_delete("del *.tmp", &app_dir, Some(&workdir))),
            DELETE_SUCCESS_OBSERVATION
        );
        assert!(!matching_file.exists());
        assert!(matching_directory.exists(), "del must ignore directories");
        assert!(nested_file.exists());
        let entries = manifest(&app_dir);
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].is_directory);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn powershell_nonrecursive_nonempty_directory_batch_is_atomic() {
        let base = std::env::temp_dir().join("agentvis_trash_test_ps_nonrecursive_batch");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let nonempty = workdir.join("nonempty");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&nonempty).unwrap();
        let file = workdir.join("keep.txt");
        let child = nonempty.join("child.txt");
        std::fs::write(&file, "keep").unwrap();
        std::fs::write(&child, "child").unwrap();
        let command = format!(
            "powershell -Command \"Remove-Item -LiteralPath '{}','{}' -Force\"",
            file.to_string_lossy(),
            nonempty.to_string_lossy()
        );

        assert!(matches!(
            try_intercept_delete(&command, &app_dir, Some(&workdir)),
            Err(AppError::Forbidden(_))
        ));
        assert!(
            file.exists(),
            "batch preflight must prevent partial movement"
        );
        assert!(nonempty.exists());
        assert!(child.exists());
        assert!(manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cmd_rmdir_nonempty_directory_without_s_fails_closed() {
        let base = std::env::temp_dir().join("agentvis_trash_test_cmd_rmdir_nonrecursive");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let nonempty = workdir.join("nonempty");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&nonempty).unwrap();
        let child = nonempty.join("child.txt");
        std::fs::write(&child, "child").unwrap();
        let command = format!("rmdir \"{}\"", nonempty.to_string_lossy());

        assert!(matches!(
            try_intercept_delete(&command, &app_dir, Some(&workdir)),
            Err(AppError::Forbidden(_))
        ));
        assert!(nonempty.exists());
        assert!(child.exists());
        assert!(manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cmd_single_quotes_are_literal_filename_characters() {
        let base = std::env::temp_dir().join("agentvis_trash_test_cmd_literal_single_quotes");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&workdir).unwrap();
        let literal = workdir.join("'quoted.txt'");
        let unquoted = workdir.join("quoted.txt");
        let literal_dir = workdir.join("'quoted-dir'");
        let unquoted_dir = workdir.join("quoted-dir");
        std::fs::write(&literal, "literal").unwrap();
        std::fs::write(&unquoted, "unquoted").unwrap();
        std::fs::create_dir_all(&literal_dir).unwrap();
        std::fs::create_dir_all(&unquoted_dir).unwrap();

        assert_eq!(
            intercepted(try_intercept_delete(
                "del 'quoted.txt'",
                &app_dir,
                Some(&workdir)
            )),
            DELETE_SUCCESS_OBSERVATION
        );
        assert!(!literal.exists());
        assert!(
            unquoted.exists(),
            "CMD does not use single quotes for grouping"
        );
        assert_eq!(
            intercepted(try_intercept_delete(
                "rmdir /s /q 'quoted-dir'",
                &app_dir,
                Some(&workdir)
            )),
            DELETE_SUCCESS_OBSERVATION
        );
        assert!(!literal_dir.exists());
        assert!(
            unquoted_dir.exists(),
            "rmdir must preserve CMD's literal single quotes too"
        );
        let entries = manifest(&app_dir);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].original_path, literal.to_string_lossy());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn indirect_cleanup_and_nested_cmd_delete_forms_fail_closed() {
        let base = std::env::temp_dir().join("agentvis_trash_test_indirect_delete_forms");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&workdir).unwrap();
        let victim = workdir.join("keep.txt");
        std::fs::write(&victim, "keep").unwrap();
        let nested_cmd = format!(
            "start \"\" /wait cmd /c del \"{}\"",
            victim.to_string_lossy()
        );

        for command in [
            "git.exe clean -fd".to_string(),
            "git -C . clean -fd".to_string(),
            "python -c \"from os import remove; remove('keep.txt')\"".to_string(),
            nested_cmd,
        ] {
            assert!(
                matches!(
                    try_intercept_delete(&command, &app_dir, Some(&workdir)),
                    Err(AppError::Forbidden(_))
                ),
                "expected fail-closed block for {command}"
            );
            assert!(victim.exists());
            assert!(manifest(&app_dir).is_empty());
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn oversized_manifest_is_rejected_before_source_is_moved() {
        let base = std::env::temp_dir().join("agentvis_trash_test_manifest_write_limit");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&workdir).unwrap();

        let mut entries = vec![TrashEntry {
            id: "near_limit".to_string(),
            original_path: workdir.join("old.txt").to_string_lossy().to_string(),
            trash_path: get_trash_bin_dir(&app_dir)
                .join("legacy_payload")
                .to_string_lossy()
                .to_string(),
            deleted_at: chrono::Local::now().to_rfc3339(),
            command: String::new(),
            batch_id: Some("near_limit_batch".to_string()),
            is_directory: false,
            storage_id: None,
            state: TrashEntryState::Ready,
            restore: None,
        }];
        let base_len = serde_json::to_vec_pretty(&entries).unwrap().len();
        let target_len = MAX_MANIFEST_BYTES as usize - 64;
        assert!(base_len < target_len);
        entries[0].command = "x".repeat(target_len - base_len);
        assert_eq!(
            serde_json::to_vec_pretty(&entries).unwrap().len(),
            target_len
        );
        write_manifest_atomic_unlocked(&app_dir, &entries).unwrap();

        let victim = workdir.join("keep.txt");
        std::fs::write(&victim, "keep").unwrap();
        let command = format!("del \"{}\"", victim.to_string_lossy());
        assert!(matches!(
            try_intercept_delete(&command, &app_dir, Some(&workdir)),
            Err(AppError::FileSystem(_))
        ));
        assert!(victim.exists(), "manifest overflow must fail before rename");
        let loaded = manifest(&app_dir);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "near_limit");
        let items_dir = get_trash_items_dir(&app_dir);
        if items_dir.exists() {
            assert_eq!(std::fs::read_dir(items_dir).unwrap().count(), 0);
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn powershell_command_option_variants_are_intercepted() {
        let base = std::env::temp_dir().join("agentvis_trash_test_ps_command_variants");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&workdir).unwrap();

        for (index, option) in ["/Command", "/C", "-Co"].into_iter().enumerate() {
            let victim = workdir.join(format!("victim-{index}.txt"));
            std::fs::write(&victim, "keep").unwrap();
            let command = format!(
                "powershell.exe /NoProfile {option} \"Remove-Item -LiteralPath '{}' -Force\"",
                victim.to_string_lossy()
            );
            assert_eq!(
                intercepted(try_intercept_delete(&command, &app_dir, Some(&workdir))),
                DELETE_SUCCESS_OBSERVATION
            );
            assert!(!victim.exists(), "launcher option must be parsed: {option}");
        }
        let at_prefixed = workdir.join("at-prefixed.txt");
        std::fs::write(&at_prefixed, "keep").unwrap();
        assert_eq!(
            intercepted(try_intercept_delete(
                "@powershell.exe -NoProfile -Command \"Remove-Item -LiteralPath 'at-prefixed.txt' -Force\"",
                &app_dir,
                Some(&workdir)
            )),
            DELETE_SUCCESS_OBSERVATION
        );
        assert!(!at_prefixed.exists());
        assert_eq!(manifest(&app_dir).len(), 4);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cmd_k_and_attached_c_wrappers_are_intercepted() {
        let base = std::env::temp_dir().join("agentvis_trash_test_cmd_wrapper_variants");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&workdir).unwrap();

        for (index, command) in [
            "cmd.exe /D /K \"del /f /q victim-0.txt\"",
            "cmd.exe /D /C\"del /f /q victim-1.txt\"",
        ]
        .into_iter()
        .enumerate()
        {
            let victim = workdir.join(format!("victim-{index}.txt"));
            std::fs::write(&victim, "keep").unwrap();
            assert_eq!(
                intercepted(try_intercept_delete(command, &app_dir, Some(&workdir))),
                DELETE_SUCCESS_OBSERVATION
            );
            assert!(!victim.exists(), "CMD wrapper must be parsed: {command}");
        }

        let no_autorun_suppression = workdir.join("no-autorun-suppression.txt");
        std::fs::write(&no_autorun_suppression, "keep").unwrap();
        assert!(matches!(
            try_intercept_delete(
                "cmd.exe /C \"del /f /q no-autorun-suppression.txt\"",
                &app_dir,
                Some(&workdir)
            ),
            Err(AppError::Forbidden(_))
        ));
        assert!(no_autorun_suppression.exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cmd_compact_builtin_switches_are_intercepted_without_wrong_target_moves() {
        let base = std::env::temp_dir().join("agentvis_trash_test_cmd_compact_switches");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&workdir).unwrap();

        let commands = [
            ("del/f/q victim-0.txt", "victim-0.txt", false),
            ("erase/f/q victim-1.txt", "victim-1.txt", false),
            ("rd/s/q victim-2", "victim-2", true),
            ("rmdir/s/q victim-3", "victim-3", true),
            ("cmd.exe /d /c del/f/q victim-4.txt", "victim-4.txt", false),
        ];
        for (command, target_name, is_directory) in commands {
            let target = workdir.join(target_name);
            if is_directory {
                std::fs::create_dir_all(&target).unwrap();
                std::fs::write(target.join("child.txt"), "keep").unwrap();
            } else {
                std::fs::write(&target, "keep").unwrap();
            }
            assert_eq!(
                intercepted(try_intercept_delete(command, &app_dir, Some(&workdir))),
                DELETE_SUCCESS_OBSERVATION,
                "compact CMD builtin must be intercepted: {command}"
            );
            assert!(!target.exists(), "expected soft move for {command}");
        }
        assert_eq!(manifest(&app_dir).len(), commands.len());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn git_rm_fails_closed_unless_it_is_index_only() {
        let base = std::env::temp_dir().join("agentvis_trash_test_git_rm");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let victim = workdir.join("keep.txt");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&workdir).unwrap();
        std::fs::write(&victim, "keep").unwrap();

        for command in ["git rm keep.txt", "git rm -f keep.txt"] {
            assert!(matches!(
                try_intercept_delete(command, &app_dir, Some(&workdir)),
                Err(AppError::Forbidden(_))
            ));
            assert!(victim.exists(), "git rm must not reach the child process");
        }
        assert!(matches!(
            try_intercept_delete("git rm --cached keep.txt", &app_dir, Some(&workdir)),
            Ok(DeleteInterceptionOutcome::NotDelete)
        ));
        assert!(victim.exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn git_clean_dry_run_is_scoped_to_each_command_and_option_position() {
        let app_dir = std::env::temp_dir().join("agentvis_trash_test_git_clean_dry_run");
        for command in [
            "git clean -n && git clean -fd",
            "git clean -fd -e -n",
            "git clean -fd -- -n",
        ] {
            assert!(
                matches!(
                    try_intercept_delete(command, &app_dir, None),
                    Err(AppError::Forbidden(_))
                ),
                "real git clean must not be hidden by a dry-run-looking token: {command}"
            );
        }
        assert!(matches!(
            try_intercept_delete("git clean -n", &app_dir, None).unwrap(),
            DeleteInterceptionOutcome::NotDelete
        ));
    }

    #[test]
    fn unsupported_cmd_delete_semantics_fail_closed_without_moving_targets() {
        let base = std::env::temp_dir().join("agentvis_trash_test_cmd_semantic_flags");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let directory = workdir.join("directory-one");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&directory).unwrap();
        for name in ["one.txt", "file1.txt", "file2.txt"] {
            std::fs::write(workdir.join(name), "keep").unwrap();
        }

        for command in [
            "del /A:H *.txt",
            "del /P one.txt",
            "del /S one.txt",
            "del file[12]*.txt",
            "rmdir /S /Q directory*",
        ] {
            assert!(
                matches!(
                    try_intercept_delete(command, &app_dir, Some(&workdir)),
                    Err(AppError::Forbidden(_))
                ),
                "unsupported CMD semantics must fail closed: {command}"
            );
        }
        assert!(workdir.join("one.txt").exists());
        assert!(workdir.join("file1.txt").exists());
        assert!(workdir.join("file2.txt").exists());
        assert!(directory.exists());
        assert!(manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn cmd_readonly_file_requires_force_before_soft_delete() {
        let base = std::env::temp_dir().join("agentvis_trash_test_cmd_readonly_force");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&workdir).unwrap();
        let victim = workdir.join("readonly.txt");
        std::fs::write(&victim, "keep").unwrap();
        let mut permissions = std::fs::metadata(&victim).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&victim, permissions).unwrap();

        assert!(matches!(
            try_intercept_delete("del readonly.txt", &app_dir, Some(&workdir)),
            Err(AppError::Forbidden(_))
        ));
        assert!(victim.exists());
        assert_eq!(
            intercepted(try_intercept_delete(
                "del /F readonly.txt",
                &app_dir,
                Some(&workdir)
            )),
            DELETE_SUCCESS_OBSERVATION
        );
        assert!(!victim.exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn powershell_explicit_false_unknown_parameters_and_comments_preserve_semantics() {
        let base = std::env::temp_dir().join("agentvis_trash_test_ps_semantic_edges");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let nonempty = workdir.join("nonempty");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&nonempty).unwrap();
        std::fs::write(nonempty.join("child.txt"), "child").unwrap();
        std::fs::write(workdir.join("unknown.txt"), "keep").unwrap();
        std::fs::write(workdir.join("safe.txt"), "safe").unwrap();
        std::fs::write(workdir.join("victim.txt"), "victim").unwrap();

        assert!(matches!(
            try_intercept_delete(
                "powershell -Command \"Remove-Item -LiteralPath 'nonempty' -Recurse:$false -Force\"",
                &app_dir,
                Some(&workdir)
            ),
            Err(AppError::Forbidden(_))
        ));
        assert!(matches!(
            try_intercept_delete(
                "powershell -Command \"Remove-Item -LiteralPath 'unknown.txt' -Bogus\"",
                &app_dir,
                Some(&workdir)
            ),
            Err(AppError::Forbidden(_))
        ));
        assert_eq!(
            intercepted(try_intercept_delete(
                "powershell -NoProfile -Command \"$target='safe.txt'; <# $target='victim.txt' #>; Remove-Item -LiteralPath $target -Force\"",
                &app_dir,
                Some(&workdir)
            )),
            DELETE_SUCCESS_OBSERVATION
        );
        assert!(!workdir.join("safe.txt").exists());
        assert!(workdir.join("victim.txt").exists());
        assert!(nonempty.exists());
        assert!(workdir.join("unknown.txt").exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn get_childitem_without_force_fails_closed_before_rust_glob_expansion() {
        let base = std::env::temp_dir().join("agentvis_trash_test_gci_force_semantics");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&workdir).unwrap();
        let victim = workdir.join("keep.txt");
        std::fs::write(&victim, "keep").unwrap();
        let command = format!(
            "powershell -Command \"Get-ChildItem -LiteralPath '{}' | Remove-Item -Force\"",
            workdir.to_string_lossy()
        );

        assert!(matches!(
            try_intercept_delete(&command, &app_dir, Some(&workdir)),
            Err(AppError::Forbidden(_))
        ));
        assert!(victim.exists());
        assert!(manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn duplicate_manifest_identifiers_fail_closed() {
        let base = std::env::temp_dir().join("agentvis_trash_test_duplicate_manifest");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(get_trash_bin_dir(&base)).unwrap();
        let entry = serde_json::json!({
            "id": "duplicate",
            "originalPath": base.join("one.txt").to_string_lossy(),
            "trashPath": get_trash_bin_dir(&base).join("one").to_string_lossy(),
            "deletedAt": chrono::Local::now().to_rfc3339(),
            "command": "del one.txt",
            "isDirectory": false
        });
        std::fs::write(
            get_manifest_path(&base),
            serde_json::to_vec(&vec![entry.clone(), entry]).unwrap(),
        )
        .unwrap();

        assert!(matches!(read_manifest(&base), Err(AppError::FileSystem(_))));

        let _ = std::fs::remove_dir_all(&base);
    }
}
