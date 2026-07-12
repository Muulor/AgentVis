//! 工作区事务式导入命令。
//!
//! HTML5 拖拽无法稳定提供源文件绝对路径，因此前端按固定小块传输，
//! Rust 负责 staging、路径校验、完整性检查、提交和取消回滚。

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

use crate::error::{AppError, AppResult};

use super::command_validator;

const IMPORT_STAGING_DIR_NAME: &str = ".agentvis-importing";
const IMPORT_ROOT_MARKER_NAME: &str = ".agentvis-import-root-v1";
const IMPORT_ROOT_MARKER_CONTENT: &[u8] = b"AgentVis workspace import root v1\n";
const IMPORT_SESSION_MARKER_NAME: &str = ".agentvis-import-session-v1";
const IMPORT_PAYLOAD_DIR_NAME: &str = "payload";
const IMPORT_COMMIT_GUARD_NAME: &str = ".agentvis-import-commit-v1";
const IMPORT_COMMIT_GUARD_CONTENT: &[u8] = b"AgentVis workspace import commit v1\n";
const IMPORT_RECOVERY_FILE_NAME: &str = ".agentvis-import-recovery.json";
const MAX_IMPORT_ENTRIES: usize = 100_000;
const MAX_IMPORT_RELATIVE_PATH_CHARS: usize = 2_048;
const MAX_IMPORT_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const MAX_IMPORT_CHUNK_BASE64_CHARS: usize = ((MAX_IMPORT_CHUNK_BYTES + 2) / 3) * 4;
const STALE_IMPORT_SESSION_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const SLOW_IMPORT_STAGING_DELETE_WARN_THRESHOLD: Duration = Duration::from_secs(1);

static IMPORT_SESSIONS: Lazy<Mutex<HashMap<String, WorkspaceImportSession>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportManifestEntry {
    pub relative_path: String,
    pub is_directory: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportBeginResult {
    pub session_id: String,
    pub total_bytes: u64,
    pub total_files: u64,
    pub total_entries: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportChunkResult {
    pub file_bytes_received: u64,
    pub bytes_received: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceImportCommitStatus {
    Committed,
    RolledBack,
    Partial,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportCommitResult {
    pub status: WorkspaceImportCommitStatus,
    pub imported_files: u64,
    pub imported_entries: u64,
    pub total_bytes: u64,
    pub top_level_paths: Vec<String>,
    pub error_message: Option<String>,
    pub rollback_errors: Vec<String>,
    pub recovery_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportCancelResult {
    pub cancelled: bool,
}

#[derive(Debug, Clone)]
struct ImportFileState {
    relative_path: PathBuf,
    expected_size: u64,
    received_size: u64,
}

#[derive(Debug, Clone)]
struct WorkspaceImportSession {
    id: String,
    current_dir: PathBuf,
    staging_dir: PathBuf,
    payload_dir: PathBuf,
    files: HashMap<String, ImportFileState>,
    top_levels: BTreeSet<PathBuf>,
    total_bytes: u64,
    bytes_received: u64,
    total_entries: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceImportRecoveryRecord {
    session_id: String,
    forward_error: String,
    paths_requiring_review: Vec<String>,
    rollback_errors: Vec<String>,
    created_at: String,
}

fn marker_matches(directory: &Path, marker_name: &str, expected_content: &[u8]) -> bool {
    let marker_path = directory.join(marker_name);
    let marker_is_regular_file = fs::symlink_metadata(&marker_path)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false);
    marker_is_regular_file
        && fs::read(marker_path)
            .map(|content| content == expected_content)
            .unwrap_or(false)
}

fn is_real_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_dir())
        .unwrap_or(false)
}

pub(crate) fn is_workspace_import_staging_dir(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name == IMPORT_STAGING_DIR_NAME)
        && is_real_directory(path)
        && marker_matches(path, IMPORT_ROOT_MARKER_NAME, IMPORT_ROOT_MARKER_CONTENT)
}

fn is_owned_import_session_dir(path: &Path) -> bool {
    let Some(session_id) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    is_real_directory(path)
        && uuid::Uuid::parse_str(session_id)
            .map(|id| id.hyphenated().to_string() == session_id)
            .unwrap_or(false)
        && marker_matches(
            path,
            IMPORT_SESSION_MARKER_NAME,
            session_marker_content(session_id).as_bytes(),
        )
}

fn session_marker_content(session_id: &str) -> String {
    format!("AgentVis workspace import session v1\n{session_id}\n")
}

fn write_new_marker(path: &Path, content: &[u8]) -> AppResult<()> {
    let mut marker = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| {
            AppError::FileSystem(format!(
                "Failed to create workspace import ownership marker: {error}"
            ))
        })?;
    marker.write_all(content).map_err(|error| {
        AppError::FileSystem(format!(
            "Failed to write workspace import ownership marker: {error}"
        ))
    })?;
    marker.sync_all().map_err(|error| {
        AppError::FileSystem(format!(
            "Failed to persist workspace import ownership marker: {error}"
        ))
    })
}

fn prepare_staging_parent(current_dir: &Path) -> AppResult<PathBuf> {
    let staging_parent = current_dir.join(IMPORT_STAGING_DIR_NAME);
    match fs::create_dir(&staging_parent) {
        Ok(()) => {
            if let Err(error) = write_new_marker(
                &staging_parent.join(IMPORT_ROOT_MARKER_NAME),
                IMPORT_ROOT_MARKER_CONTENT,
            ) {
                let _ = fs::remove_dir(&staging_parent);
                return Err(error);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if !is_workspace_import_staging_dir(&staging_parent) {
                return Err(AppError::Generic(format!(
                    "Reserved import staging path already exists and is not owned by AgentVis: {}",
                    staging_parent.display()
                )));
            }
        }
        Err(error) => {
            return Err(AppError::FileSystem(format!(
                "Failed to create import staging root: {error}"
            )));
        }
    }
    Ok(staging_parent)
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => character,
        })
        .collect()
}

fn sanitize_relative_path(path: &str, allow_empty: bool) -> AppResult<PathBuf> {
    if path.chars().count() > MAX_IMPORT_RELATIVE_PATH_CHARS {
        return Err(AppError::Generic("Import path is too long".to_string()));
    }

    let normalized = path.replace('\\', "/");
    let mut cleaned = PathBuf::new();
    for segment in normalized.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err(AppError::Generic(
                "Invalid path: parent traversal is not allowed".to_string(),
            ));
        }

        let safe_segment = sanitize_filename(segment);
        if safe_segment.is_empty() {
            return Err(AppError::Generic("Invalid empty path segment".to_string()));
        }
        cleaned.push(safe_segment);
    }

    if !allow_empty && cleaned.as_os_str().is_empty() {
        return Err(AppError::Generic("Invalid empty import path".to_string()));
    }
    Ok(cleaned)
}

fn normalized_path_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn resolve_workspace_current_dir(
    app_handle: &tauri::AppHandle,
    hub_name: &str,
    agent_name: &str,
    root_dir: Option<&str>,
    current_relative_path: &str,
) -> AppResult<PathBuf> {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|error| {
        AppError::FileSystem(format!("Failed to get app data directory: {error}"))
    })?;
    let workspace_root = match root_dir.filter(|path| !path.trim().is_empty()) {
        Some(project_root) => {
            let root = PathBuf::from(project_root);
            if !root.exists() || !root.is_dir() {
                return Err(AppError::NotFound(format!(
                    "Project directory does not exist: {project_root}"
                )));
            }
            root
        }
        None => {
            let root = app_data_dir
                .join("deliverables")
                .join(hub_name)
                .join(agent_name);
            fs::create_dir_all(&root).map_err(|error| {
                AppError::FileSystem(format!("Failed to create workspace root: {error}"))
            })?;
            root
        }
    };

    let canonical_root = workspace_root.canonicalize().map_err(|error| {
        AppError::FileSystem(format!("Failed to canonicalize workspace root: {error}"))
    })?;
    let current_relative = sanitize_relative_path(current_relative_path, true)?;
    let current_dir = canonical_root.join(current_relative);
    command_validator::validate_path_write_safety(&current_dir, &app_data_dir)?;
    fs::create_dir_all(&current_dir).map_err(|error| {
        AppError::FileSystem(format!("Failed to create import target directory: {error}"))
    })?;
    let canonical_current = current_dir.canonicalize().map_err(|error| {
        AppError::FileSystem(format!("Failed to canonicalize import target: {error}"))
    })?;
    if !canonical_current.starts_with(&canonical_root) {
        return Err(AppError::Generic(
            "Invalid path: import target is outside the workspace root".to_string(),
        ));
    }
    Ok(canonical_current)
}

fn build_import_session(
    current_dir: PathBuf,
    entries: Vec<WorkspaceImportManifestEntry>,
) -> AppResult<WorkspaceImportSession> {
    if entries.is_empty() {
        return Err(AppError::Generic("Import manifest is empty".to_string()));
    }
    if entries.len() > MAX_IMPORT_ENTRIES {
        return Err(AppError::Generic(format!(
            "Import manifest exceeds {MAX_IMPORT_ENTRIES} entries"
        )));
    }

    let total_entries = entries.len() as u64;
    let id = uuid::Uuid::new_v4().to_string();
    let staging_parent = prepare_staging_parent(&current_dir)?;
    let staging_dir = staging_parent.join(&id);
    fs::create_dir(&staging_dir).map_err(|error| {
        AppError::FileSystem(format!(
            "Failed to create import staging directory: {error}"
        ))
    })?;
    let session_marker = session_marker_content(&id);
    if let Err(error) = write_new_marker(
        &staging_dir.join(IMPORT_SESSION_MARKER_NAME),
        session_marker.as_bytes(),
    ) {
        let _ = fs::remove_dir(&staging_dir);
        return Err(error);
    }
    let payload_dir = staging_dir.join(IMPORT_PAYLOAD_DIR_NAME);
    if let Err(error) = fs::create_dir(&payload_dir) {
        let _ = remove_owned_import_session_dir(&staging_dir, "payload_setup_failed");
        return Err(AppError::FileSystem(format!(
            "Failed to create import payload directory: {error}"
        )));
    }

    let build_result = (|| {
        let mut seen_paths = HashSet::new();
        let mut files = HashMap::new();
        let mut directories = Vec::new();
        let mut top_levels = BTreeSet::new();
        let mut total_bytes = 0_u64;

        for entry in entries {
            let relative_path = sanitize_relative_path(&entry.relative_path, false)?;
            let path_key = normalized_path_key(&relative_path);
            if !seen_paths.insert(path_key.clone()) {
                return Err(AppError::Generic(format!(
                    "Duplicate import manifest path: {path_key}"
                )));
            }

            let top_level = relative_path
                .components()
                .next()
                .map(|component| PathBuf::from(component.as_os_str()))
                .ok_or_else(|| {
                    AppError::Generic("Import path has no top-level entry".to_string())
                })?;
            top_levels.insert(top_level);

            if entry.is_directory {
                directories.push(relative_path);
            } else {
                total_bytes = total_bytes.checked_add(entry.size).ok_or_else(|| {
                    AppError::Generic("Import manifest byte count overflow".to_string())
                })?;
                files.insert(
                    path_key,
                    ImportFileState {
                        relative_path,
                        expected_size: entry.size,
                        received_size: 0,
                    },
                );
            }
        }

        directories.sort_by_key(|path| path.components().count());
        for directory in directories {
            fs::create_dir_all(payload_dir.join(directory)).map_err(|error| {
                AppError::FileSystem(format!("Failed to create staged import directory: {error}"))
            })?;
        }
        for file in files.values() {
            let staged_path = payload_dir.join(&file.relative_path);
            if let Some(parent) = staged_path.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    AppError::FileSystem(format!("Failed to create staged file parent: {error}"))
                })?;
            }
            OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&staged_path)
                .map_err(|error| {
                    AppError::FileSystem(format!("Failed to create staged import file: {error}"))
                })?;
        }

        Ok(WorkspaceImportSession {
            id,
            current_dir,
            staging_dir: staging_dir.clone(),
            payload_dir,
            files,
            top_levels,
            total_bytes,
            bytes_received: 0,
            total_entries,
        })
    })();

    if build_result.is_err() {
        let _ = remove_owned_import_session_dir(&staging_dir, "manifest_build_failed");
    }
    build_result
}

fn append_import_chunk(
    session: &mut WorkspaceImportSession,
    relative_path: &str,
    offset: u64,
    chunk: &[u8],
) -> AppResult<WorkspaceImportChunkResult> {
    if chunk.len() > MAX_IMPORT_CHUNK_BYTES {
        return Err(AppError::Generic(format!(
            "Import chunk exceeds {MAX_IMPORT_CHUNK_BYTES} bytes"
        )));
    }
    let sanitized_path = sanitize_relative_path(relative_path, false)?;
    let path_key = normalized_path_key(&sanitized_path);
    let file = session.files.get_mut(&path_key).ok_or_else(|| {
        AppError::Generic(format!("Import file is not in the manifest: {path_key}"))
    })?;
    if file.relative_path != sanitized_path {
        return Err(AppError::Generic(
            "Import path normalization mismatch".to_string(),
        ));
    }
    if file.received_size != offset {
        return Err(AppError::Generic(format!(
            "Import chunk offset mismatch for {path_key}: expected {}, received {offset}",
            file.received_size
        )));
    }
    let next_size = file
        .received_size
        .checked_add(chunk.len() as u64)
        .ok_or_else(|| AppError::Generic("Import file size overflow".to_string()))?;
    if next_size > file.expected_size {
        return Err(AppError::Generic(format!(
            "Import data exceeds declared size for {path_key}"
        )));
    }

    let staged_path = session.payload_dir.join(&file.relative_path);
    let mut output = OpenOptions::new()
        .append(true)
        .open(&staged_path)
        .map_err(|error| {
            AppError::FileSystem(format!("Failed to open staged import file: {error}"))
        })?;
    output.write_all(chunk).map_err(|error| {
        AppError::FileSystem(format!("Failed to write staged import chunk: {error}"))
    })?;

    file.received_size = next_size;
    session.bytes_received = session
        .bytes_received
        .checked_add(chunk.len() as u64)
        .ok_or_else(|| AppError::Generic("Import session size overflow".to_string()))?;

    Ok(WorkspaceImportChunkResult {
        file_bytes_received: file.received_size,
        bytes_received: session.bytes_received,
        total_bytes: session.total_bytes,
    })
}

fn import_session_is_complete(session: &WorkspaceImportSession) -> bool {
    session
        .files
        .values()
        .all(|file| file.received_size == file.expected_size)
        && session.bytes_received == session.total_bytes
}

fn unique_destination_path(current_dir: &Path, top_level: &Path, is_directory: bool) -> PathBuf {
    let original_name = top_level
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "imported".to_string());
    let original_path = current_dir.join(&original_name);
    if !original_path.exists() {
        return original_path;
    }

    let (stem, extension) = if !is_directory {
        match original_name.rfind('.') {
            Some(index) if index > 0 => (&original_name[..index], &original_name[index..]),
            _ => (original_name.as_str(), ""),
        }
    } else {
        (original_name.as_str(), "")
    };
    for counter in 1..=10_000 {
        let candidate = current_dir.join(format!("{stem} ({counter}){extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    current_dir.join(format!("{stem}-{}{extension}", uuid::Uuid::new_v4()))
}

fn remove_owned_import_session_dir(staging_dir: &Path, reason: &'static str) -> AppResult<()> {
    if !staging_dir.exists() {
        return Ok(());
    }
    if !is_owned_import_session_dir(staging_dir) {
        return Err(AppError::Generic(format!(
            "Refusing to delete import staging without a valid ownership marker: {}",
            staging_dir.display()
        )));
    }
    let session_id = staging_dir
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let started_at = Instant::now();
    let delete_result = fs::remove_dir_all(staging_dir);
    let elapsed = started_at.elapsed();
    let duration_ms = elapsed.as_millis();

    match delete_result {
        Ok(()) => {
            if elapsed >= SLOW_IMPORT_STAGING_DELETE_WARN_THRESHOLD {
                log::warn!(
                    "[workspace_import] slow staging delete: session_id={}, reason={}, duration_ms={}, outcome=success",
                    session_id,
                    reason,
                    duration_ms
                );
            } else {
                log::debug!(
                    "[workspace_import] staging delete: session_id={}, reason={}, duration_ms={}, outcome=success",
                    session_id,
                    reason,
                    duration_ms
                );
            }
            Ok(())
        }
        Err(error) => {
            log::warn!(
                "[workspace_import] staging delete: session_id={}, reason={}, duration_ms={}, outcome=failed, error={}",
                session_id,
                reason,
                duration_ms,
                error
            );
            Err(AppError::FileSystem(format!(
                "Failed to remove owned workspace import staging: {error}"
            )))
        }
    }
}

fn cleanup_session_staging(
    session: &WorkspaceImportSession,
    reason: &'static str,
) -> AppResult<()> {
    remove_owned_import_session_dir(&session.staging_dir, reason)?;
    Ok(())
}

fn is_import_session_directory_name(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    uuid::Uuid::parse_str(name)
        .map(|id| id.hyphenated().to_string() == name)
        .unwrap_or(false)
}

fn cleanup_stale_import_staging(current_dir: &Path) {
    let staging_parent = current_dir.join(IMPORT_STAGING_DIR_NAME);
    if !is_workspace_import_staging_dir(&staging_parent) {
        return;
    }
    let active_staging_dirs: HashSet<PathBuf> = match IMPORT_SESSIONS.lock() {
        Ok(sessions) => sessions
            .values()
            .map(|session| session.staging_dir.clone())
            .collect(),
        Err(_) => {
            log::error!(
                "[workspace_import] session lock poisoned; stale cleanup stopped fail-closed"
            );
            return;
        }
    };
    let Ok(entries) = fs::read_dir(&staging_parent) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if active_staging_dirs.contains(&path)
            || !is_import_session_directory_name(&path)
            || !is_owned_import_session_dir(&path)
            || path.join(IMPORT_COMMIT_GUARD_NAME).exists()
            || path.join(IMPORT_RECOVERY_FILE_NAME).exists()
        {
            continue;
        }
        let is_stale = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age >= STALE_IMPORT_SESSION_AGE);
        if is_stale {
            let _ = remove_owned_import_session_dir(&path, "stale");
        }
    }
}

fn write_import_recovery_record(
    session: &WorkspaceImportSession,
    forward_error: &str,
    paths_requiring_review: &[String],
    rollback_errors: &[String],
) -> AppResult<PathBuf> {
    let record = WorkspaceImportRecoveryRecord {
        session_id: session.id.clone(),
        forward_error: forward_error.to_string(),
        paths_requiring_review: paths_requiring_review.to_vec(),
        rollback_errors: rollback_errors.to_vec(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    let recovery_path = session.staging_dir.join(IMPORT_RECOVERY_FILE_NAME);
    let encoded = serde_json::to_vec_pretty(&record)?;
    fs::write(&recovery_path, encoded).map_err(|error| {
        AppError::FileSystem(format!(
            "Failed to preserve workspace import recovery record: {error}"
        ))
    })?;
    Ok(recovery_path)
}

fn create_import_commit_guard(session: &WorkspaceImportSession) -> AppResult<()> {
    write_new_marker(
        &session.staging_dir.join(IMPORT_COMMIT_GUARD_NAME),
        IMPORT_COMMIT_GUARD_CONTENT,
    )
}

fn commit_import_session_with_rename<F>(
    session: WorkspaceImportSession,
    mut rename_path: F,
) -> AppResult<WorkspaceImportCommitResult>
where
    F: FnMut(&Path, &Path) -> std::io::Result<()>,
{
    if !import_session_is_complete(&session) {
        return Err(AppError::Generic(
            "Import session is incomplete and cannot be committed".to_string(),
        ));
    }
    if let Err(error) = create_import_commit_guard(&session) {
        if let Err(cleanup_error) = cleanup_session_staging(&session, "commit_guard_failed") {
            log::warn!(
                "[workspace_import] failed to clean session after commit guard error: id={}, error={}",
                session.id,
                cleanup_error
            );
        }
        return Err(error);
    }

    let mut moved_paths: Vec<(PathBuf, PathBuf)> = Vec::new();
    for top_level in &session.top_levels {
        let staged_path = session.payload_dir.join(top_level);
        let is_directory = staged_path.is_dir();
        let destination = unique_destination_path(&session.current_dir, top_level, is_directory);
        if let Err(error) = rename_path(&staged_path, &destination) {
            let forward_error = format!(
                "Failed to move {} to {}: {error}",
                staged_path.display(),
                destination.display()
            );
            let mut rollback_errors = Vec::new();
            let mut paths_requiring_review = Vec::new();
            for (committed_path, original_staged_path) in moved_paths.iter().rev() {
                if let Err(rollback_error) = rename_path(committed_path, original_staged_path) {
                    paths_requiring_review.push(committed_path.to_string_lossy().to_string());
                    rollback_errors.push(format!(
                        "Failed to restore {} to {}: {rollback_error}",
                        committed_path.display(),
                        original_staged_path.display()
                    ));
                }
            }

            if rollback_errors.is_empty() {
                if let Err(cleanup_error) = cleanup_session_staging(&session, "rolled_back") {
                    log::warn!(
                        "[workspace_import] rolled-back session cleanup failed: id={}, error={}",
                        session.id,
                        cleanup_error
                    );
                }
                return Ok(WorkspaceImportCommitResult {
                    status: WorkspaceImportCommitStatus::RolledBack,
                    imported_files: 0,
                    imported_entries: 0,
                    total_bytes: session.total_bytes,
                    top_level_paths: Vec::new(),
                    error_message: Some(forward_error),
                    rollback_errors,
                    recovery_path: None,
                });
            }

            let recovery_path = session.staging_dir.to_string_lossy().to_string();
            if let Err(recovery_error) = write_import_recovery_record(
                &session,
                &forward_error,
                &paths_requiring_review,
                &rollback_errors,
            ) {
                rollback_errors.push(recovery_error.to_string());
            }
            return Ok(WorkspaceImportCommitResult {
                status: WorkspaceImportCommitStatus::Partial,
                imported_files: 0,
                imported_entries: 0,
                total_bytes: session.total_bytes,
                top_level_paths: paths_requiring_review,
                error_message: Some(forward_error),
                rollback_errors,
                recovery_path: Some(recovery_path),
            });
        }
        moved_paths.push((destination, staged_path));
    }

    if let Err(cleanup_error) = cleanup_session_staging(&session, "committed") {
        log::warn!(
            "[workspace_import] committed session cleanup failed: id={}, error={}",
            session.id,
            cleanup_error
        );
    }
    Ok(WorkspaceImportCommitResult {
        status: WorkspaceImportCommitStatus::Committed,
        imported_files: session.files.len() as u64,
        imported_entries: session.total_entries,
        total_bytes: session.total_bytes,
        top_level_paths: moved_paths
            .into_iter()
            .map(|(destination, _)| destination.to_string_lossy().to_string())
            .collect(),
        error_message: None,
        rollback_errors: Vec::new(),
        recovery_path: None,
    })
}

fn commit_import_session(
    session: WorkspaceImportSession,
) -> AppResult<WorkspaceImportCommitResult> {
    commit_import_session_with_rename(session, |from, to| fs::rename(from, to))
}

#[tauri::command]
pub async fn workspace_import_begin(
    app_handle: tauri::AppHandle,
    hub_name: String,
    agent_name: String,
    root_dir: Option<String>,
    current_relative_path: String,
    entries: Vec<WorkspaceImportManifestEntry>,
) -> AppResult<WorkspaceImportBeginResult> {
    let current_dir = resolve_workspace_current_dir(
        &app_handle,
        &hub_name,
        &agent_name,
        root_dir.as_deref(),
        &current_relative_path,
    )?;
    cleanup_stale_import_staging(&current_dir);
    let session = build_import_session(current_dir, entries)?;
    let result = WorkspaceImportBeginResult {
        session_id: session.id.clone(),
        total_bytes: session.total_bytes,
        total_files: session.files.len() as u64,
        total_entries: session.total_entries,
    };
    log::info!(
        "[workspace_import] session started: id={}, entries={}, files={}, bytes={}",
        result.session_id,
        result.total_entries,
        result.total_files,
        result.total_bytes
    );
    IMPORT_SESSIONS
        .lock()
        .map_err(|_| AppError::Generic("Workspace import session lock poisoned".to_string()))?
        .insert(session.id.clone(), session);
    Ok(result)
}

#[tauri::command]
pub async fn workspace_import_append_chunk(
    session_id: String,
    relative_path: String,
    offset: u64,
    base64_data: String,
) -> AppResult<WorkspaceImportChunkResult> {
    if base64_data.len() > MAX_IMPORT_CHUNK_BASE64_CHARS {
        return Err(AppError::Generic(
            "Encoded import chunk exceeds the backend hard limit".to_string(),
        ));
    }
    let chunk = STANDARD
        .decode(base64_data.as_bytes())
        .map_err(|error| AppError::Generic(format!("Invalid import chunk encoding: {error}")))?;
    let mut sessions = IMPORT_SESSIONS
        .lock()
        .map_err(|_| AppError::Generic("Workspace import session lock poisoned".to_string()))?;
    let session = sessions.get_mut(&session_id).ok_or_else(|| {
        AppError::NotFound(format!("Workspace import session not found: {session_id}"))
    })?;
    append_import_chunk(session, &relative_path, offset, &chunk)
}

#[tauri::command]
pub async fn workspace_import_commit(session_id: String) -> AppResult<WorkspaceImportCommitResult> {
    let session = {
        let mut sessions = IMPORT_SESSIONS
            .lock()
            .map_err(|_| AppError::Generic("Workspace import session lock poisoned".to_string()))?;
        let session = sessions.get(&session_id).ok_or_else(|| {
            AppError::NotFound(format!("Workspace import session not found: {session_id}"))
        })?;
        if !import_session_is_complete(session) {
            return Err(AppError::Generic(
                "Workspace import session is incomplete".to_string(),
            ));
        }
        sessions.remove(&session_id).expect("session checked above")
    };

    let result = commit_import_session(session)?;
    log::info!(
        "[workspace_import] session finalized: id={}, status={:?}, entries={}, files={}, bytes={}",
        session_id,
        result.status,
        result.imported_entries,
        result.imported_files,
        result.total_bytes
    );
    Ok(result)
}

#[tauri::command]
pub async fn workspace_import_cancel(session_id: String) -> AppResult<WorkspaceImportCancelResult> {
    let session = IMPORT_SESSIONS
        .lock()
        .map_err(|_| AppError::Generic("Workspace import session lock poisoned".to_string()))?
        .remove(&session_id);
    if let Some(session) = session {
        cleanup_session_staging(&session, "cancelled")?;
        log::info!("[workspace_import] session cancelled: id={session_id}");
        return Ok(WorkspaceImportCancelResult { cancelled: true });
    }
    Ok(WorkspaceImportCancelResult { cancelled: false })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "agentvis-workspace-import-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).expect("create import test workspace");
        path
    }

    fn assert_no_staged_sessions(workspace: &Path) {
        let staging_root = workspace.join(IMPORT_STAGING_DIR_NAME);
        assert!(is_workspace_import_staging_dir(&staging_root));
        let session_count = fs::read_dir(staging_root)
            .expect("read staging root")
            .flatten()
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .count();
        assert_eq!(session_count, 0);
    }

    #[test]
    fn rejects_parent_traversal_in_manifest_paths() {
        let error = sanitize_relative_path("folder/../escape.txt", false)
            .expect_err("parent traversal must fail");
        assert!(error.to_string().contains("parent traversal"));
    }

    #[test]
    fn incomplete_folder_import_never_reaches_the_workspace() {
        let workspace = temp_workspace();
        let entries = vec![
            WorkspaceImportManifestEntry {
                relative_path: "folder".to_string(),
                is_directory: true,
                size: 0,
            },
            WorkspaceImportManifestEntry {
                relative_path: "folder/small.txt".to_string(),
                is_directory: false,
                size: 5,
            },
            WorkspaceImportManifestEntry {
                relative_path: "folder/large.bin".to_string(),
                is_directory: false,
                size: 8,
            },
        ];
        let mut session = build_import_session(workspace.clone(), entries).expect("begin import");
        append_import_chunk(&mut session, "folder/small.txt", 0, b"small")
            .expect("write small file");

        assert!(!workspace.join("folder").exists());
        assert!(!import_session_is_complete(&session));
        cleanup_session_staging(&session, "test_cleanup").expect("clean staged import");
        assert!(!workspace.join("folder").exists());
        fs::remove_dir_all(&workspace).expect("remove import test workspace");
    }

    #[test]
    fn complete_folder_import_commits_as_one_top_level_directory() {
        let workspace = temp_workspace();
        let entries = vec![
            WorkspaceImportManifestEntry {
                relative_path: "folder".to_string(),
                is_directory: true,
                size: 0,
            },
            WorkspaceImportManifestEntry {
                relative_path: "folder/a.txt".to_string(),
                is_directory: false,
                size: 3,
            },
            WorkspaceImportManifestEntry {
                relative_path: "folder/nested/b.txt".to_string(),
                is_directory: false,
                size: 4,
            },
        ];
        let mut session = build_import_session(workspace.clone(), entries).expect("begin import");
        append_import_chunk(&mut session, "folder/a.txt", 0, b"one").expect("write first file");
        append_import_chunk(&mut session, "folder/nested/b.txt", 0, b"four")
            .expect("write nested file");

        let result = commit_import_session(session).expect("commit import");
        assert_eq!(result.status, WorkspaceImportCommitStatus::Committed);
        assert_eq!(result.imported_files, 2);
        assert_eq!(result.imported_entries, 3);
        assert_eq!(fs::read(workspace.join("folder/a.txt")).unwrap(), b"one");
        assert_eq!(
            fs::read(workspace.join("folder/nested/b.txt")).unwrap(),
            b"four"
        );
        assert_no_staged_sessions(&workspace);
        fs::remove_dir_all(&workspace).expect("remove import test workspace");
    }

    #[test]
    fn rejects_chunks_that_exceed_the_declared_file_size() {
        let workspace = temp_workspace();
        let entries = vec![WorkspaceImportManifestEntry {
            relative_path: "file.txt".to_string(),
            is_directory: false,
            size: 2,
        }];
        let mut session = build_import_session(workspace.clone(), entries).expect("begin import");
        let error = append_import_chunk(&mut session, "file.txt", 0, b"three")
            .expect_err("oversized data must fail");
        assert!(error.to_string().contains("declared size"));
        cleanup_session_staging(&session, "test_cleanup").expect("clean staged import");
        fs::remove_dir_all(&workspace).expect("remove import test workspace");
    }

    #[test]
    fn preserves_unowned_staging_name_collision() {
        let workspace = temp_workspace();
        let user_directory = workspace.join(IMPORT_STAGING_DIR_NAME);
        fs::create_dir_all(user_directory.join("user-data")).expect("create user directory");
        fs::write(user_directory.join("user-data/keep.txt"), b"keep").expect("write user file");

        cleanup_stale_import_staging(&workspace);
        let error = build_import_session(
            workspace.clone(),
            vec![WorkspaceImportManifestEntry {
                relative_path: "incoming.txt".to_string(),
                is_directory: false,
                size: 0,
            }],
        )
        .expect_err("an unowned reserved directory must not be reused");

        assert!(error.to_string().contains("not owned by AgentVis"));
        assert_eq!(
            fs::read(user_directory.join("user-data/keep.txt")).unwrap(),
            b"keep"
        );
        fs::remove_dir_all(&workspace).expect("remove import test workspace");
    }

    #[test]
    fn empty_folder_commit_counts_the_directory_entry() {
        let workspace = temp_workspace();
        let session = build_import_session(
            workspace.clone(),
            vec![WorkspaceImportManifestEntry {
                relative_path: "empty-folder".to_string(),
                is_directory: true,
                size: 0,
            }],
        )
        .expect("begin empty folder import");

        let result = commit_import_session(session).expect("commit empty folder import");

        assert_eq!(result.status, WorkspaceImportCommitStatus::Committed);
        assert_eq!(result.imported_files, 0);
        assert_eq!(result.imported_entries, 1);
        assert!(workspace.join("empty-folder").is_dir());
        fs::remove_dir_all(&workspace).expect("remove import test workspace");
    }

    fn two_empty_file_session(workspace: &Path) -> WorkspaceImportSession {
        build_import_session(
            workspace.to_path_buf(),
            vec![
                WorkspaceImportManifestEntry {
                    relative_path: "a.txt".to_string(),
                    is_directory: false,
                    size: 0,
                },
                WorkspaceImportManifestEntry {
                    relative_path: "b.txt".to_string(),
                    is_directory: false,
                    size: 0,
                },
            ],
        )
        .expect("begin two-file import")
    }

    #[test]
    fn forward_commit_failure_with_successful_rollback_leaves_workspace_unchanged() {
        let workspace = temp_workspace();
        let session = two_empty_file_session(&workspace);
        let mut rename_count = 0;

        let result = commit_import_session_with_rename(session, |from, to| {
            rename_count += 1;
            if rename_count == 2 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "injected forward failure",
                ));
            }
            fs::rename(from, to)
        })
        .expect("commit should return a structured rollback result");

        assert_eq!(result.status, WorkspaceImportCommitStatus::RolledBack);
        assert!(result.top_level_paths.is_empty());
        assert!(!workspace.join("a.txt").exists());
        assert!(!workspace.join("b.txt").exists());
        assert_no_staged_sessions(&workspace);
        fs::remove_dir_all(&workspace).expect("remove import test workspace");
    }

    #[test]
    fn rollback_failure_reports_partial_state_and_preserves_recovery_staging() {
        let workspace = temp_workspace();
        let session = two_empty_file_session(&workspace);
        let staging_dir = session.staging_dir.clone();
        let mut rename_count = 0;

        let result = commit_import_session_with_rename(session, |from, to| {
            rename_count += 1;
            match rename_count {
                2 => Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "injected forward failure",
                )),
                3 => Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "injected rollback failure",
                )),
                _ => fs::rename(from, to),
            }
        })
        .expect("commit should return a structured partial result");

        assert_eq!(result.status, WorkspaceImportCommitStatus::Partial);
        assert_eq!(result.top_level_paths.len(), 1);
        assert_eq!(
            result.recovery_path.as_deref(),
            Some(staging_dir.to_string_lossy().as_ref())
        );
        assert!(workspace.join("a.txt").exists());
        assert!(staging_dir
            .join(IMPORT_PAYLOAD_DIR_NAME)
            .join("b.txt")
            .exists());
        assert!(staging_dir.join(IMPORT_RECOVERY_FILE_NAME).is_file());

        fs::remove_file(workspace.join("a.txt")).expect("remove partially committed file");
        remove_owned_import_session_dir(&staging_dir, "test_recovery_cleanup")
            .expect("remove recovery staging");
        fs::remove_dir_all(&workspace).expect("remove import test workspace");
    }
}
