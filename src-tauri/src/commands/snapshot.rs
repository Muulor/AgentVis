//! 快照相关 Tauri Commands
//!
//! 提供文档快照的 IPC 命令，用于 Fast-Apply Engine 的版本控制

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::AppResult;
use crate::AppState;

// ==================== 响应类型 ====================

/// 快照响应类型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotResponse {
    pub id: String,
    pub document_id: String,
    pub content: String,
    pub trigger_modification_id: Option<String>,
    pub description: Option<String>,
    /// 快照创建时的修改块状态（JSON）—— 回滚时精确还原 diff 面板状态
    pub modification_statuses_json: Option<String>,
    pub created_at: i64,
}

impl From<crate::db::Snapshot> for SnapshotResponse {
    fn from(s: crate::db::Snapshot) -> Self {
        Self {
            id: s.id,
            document_id: s.document_id,
            content: s.content,
            trigger_modification_id: s.trigger_modification_id,
            description: s.description,
            modification_statuses_json: s.modification_statuses_json,
            created_at: s.created_at,
        }
    }
}

// ==================== Tauri Commands ====================

/// 创建文档快照
///
/// # Arguments
/// * `document_id` - 文档 ID
/// * `content` - 快照内容
/// * `trigger_modification_id` - 触发修改 ID (可选)
/// * `description` - 快照描述 (可选)
/// * `modification_statuses_json` - 快照时各修改块状态 JSON (可选)
#[tauri::command]
pub async fn snapshot_create(
    state: State<'_, AppState>,
    document_id: String,
    content: String,
    trigger_modification_id: Option<String>,
    description: Option<String>,
    modification_statuses_json: Option<String>,
) -> AppResult<SnapshotResponse> {
    let db = state.db.lock().await;
    let snapshot = db
        .snapshot_repo()
        .create(
            &document_id,
            &content,
            trigger_modification_id.as_deref(),
            description.as_deref(),
            modification_statuses_json.as_deref(),
        )
        .await?;

    Ok(SnapshotResponse::from(snapshot))
}

/// 获取单个快照
#[tauri::command]
pub async fn snapshot_get(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Option<SnapshotResponse>> {
    let db = state.db.lock().await;
    let snapshot = db.snapshot_repo().get(&id).await?;
    Ok(snapshot.map(SnapshotResponse::from))
}

/// 获取文档的所有快照（按时间倒序）
#[tauri::command]
pub async fn snapshot_list(
    state: State<'_, AppState>,
    document_id: String,
) -> AppResult<Vec<SnapshotResponse>> {
    let db = state.db.lock().await;
    let snapshots = db.snapshot_repo().list_by_document(&document_id).await?;
    Ok(snapshots.into_iter().map(SnapshotResponse::from).collect())
}

/// 获取文档的最新快照
#[tauri::command]
pub async fn snapshot_get_latest(
    state: State<'_, AppState>,
    document_id: String,
) -> AppResult<Option<SnapshotResponse>> {
    let db = state.db.lock().await;
    let snapshot = db.snapshot_repo().get_latest(&document_id).await?;
    Ok(snapshot.map(SnapshotResponse::from))
}

/// 回滚到指定快照
///
/// 返回快照内容供前端使用
#[tauri::command]
pub async fn snapshot_rollback(
    state: State<'_, AppState>,
    snapshot_id: String,
) -> AppResult<SnapshotResponse> {
    let db = state.db.lock().await;
    // 获取快照内容
    let snapshot = db.snapshot_repo().get(&snapshot_id).await?.ok_or_else(|| {
        crate::error::AppError::NotFound(format!("Snapshot {} does not exist", snapshot_id))
    })?;

    // 注意：实际文件回滚需要前端配合写入文件
    // 这里只返回快照内容，前端负责将内容写入文件
    Ok(SnapshotResponse::from(snapshot))
}

/// 删除单个快照
#[tauri::command]
pub async fn snapshot_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let db = state.db.lock().await;
    db.snapshot_repo().delete(&id).await
}

/// 清理旧快照，保留最近 N 个
///
/// # Arguments
/// * `document_id` - 文档 ID
/// * `keep_count` - 保留的快照数量
///
/// # Returns
/// 删除的快照数量
#[tauri::command]
pub async fn snapshot_cleanup(
    state: State<'_, AppState>,
    document_id: String,
    keep_count: i64,
) -> AppResult<u64> {
    let db = state.db.lock().await;
    db.snapshot_repo().cleanup(&document_id, keep_count).await
}

/// 获取文档快照数量
#[tauri::command]
pub async fn snapshot_count(state: State<'_, AppState>, document_id: String) -> AppResult<i64> {
    let db = state.db.lock().await;
    db.snapshot_repo().count(&document_id).await
}
