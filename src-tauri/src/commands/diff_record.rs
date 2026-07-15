//! Diff Record 相关的 Tauri 命令
//!
//! 提供 Diff 记录的 CRUD 操作，支持持久化和消息关联

use tauri::State;

use crate::db::{diff_record_repo, DiffRecord, DiffRecordCreateRequest, DiffRecordStatus};
use crate::error::AppResult;
use crate::AppState;

/// 创建 Diff 记录
///
/// 将文件编辑关联到消息，用于后续撤销时回滚
#[tauri::command]
pub async fn diff_record_create(
    state: State<'_, AppState>,
    request: DiffRecordCreateRequest,
) -> AppResult<DiffRecord> {
    let db = state.db.lock().await;

    let record = if let Some(xml) = &request.xml_modification {
        DiffRecord::with_xml(
            &request.context_id,
            &request.message_id,
            &request.document_id,
            &request.original_content,
            &request.modified_content,
            xml,
        )
    } else {
        DiffRecord::new(
            &request.context_id,
            &request.message_id,
            &request.document_id,
            &request.original_content,
            &request.modified_content,
        )
    };

    diff_record_repo::create(db.pool(), &record).await
}

/// 根据消息 ID 获取关联的 Diff 记录
///
/// 用于检查消息撤销时是否需要回滚文件
#[tauri::command]
pub async fn diff_record_get_by_message(
    state: State<'_, AppState>,
    message_id: String,
) -> AppResult<Vec<DiffRecord>> {
    let db = state.db.lock().await;
    diff_record_repo::get_by_message(db.pool(), &message_id).await
}

/// 根据上下文 ID 获取待处理的 Diff 记录
///
/// 用于应用启动时恢复未完成的 Diff
#[tauri::command]
pub async fn diff_record_get_pending(
    state: State<'_, AppState>,
    context_id: String,
) -> AppResult<Vec<DiffRecord>> {
    let db = state.db.lock().await;
    diff_record_repo::get_pending_by_context(db.pool(), &context_id).await
}

/// 更新 Diff 记录状态
#[tauri::command]
pub async fn diff_record_update_status(
    state: State<'_, AppState>,
    id: String,
    status: String,
) -> AppResult<()> {
    let db = state.db.lock().await;
    let status_enum: DiffRecordStatus = status
        .parse()
        .map_err(|e: String| crate::error::AppError::Generic(e))?;
    diff_record_repo::update_status(db.pool(), &id, status_enum).await
}

/// 回滚消息关联的 Diff 记录
///
/// 返回需要回滚的记录列表和原始内容
#[tauri::command]
pub async fn diff_record_revert_by_message(
    state: State<'_, AppState>,
    message_id: String,
) -> AppResult<Vec<DiffRecord>> {
    let db = state.db.lock().await;
    diff_record_repo::revert_by_message(db.pool(), &message_id).await
}

/// 更新 Diff 记录的 active_snapshot_id
///
/// 用于记录当前激活的快照，重启后用于状态恢复
#[tauri::command]
pub async fn diff_record_update_active_snapshot(
    state: State<'_, AppState>,
    context_id: String,
    document_id: String,
    snapshot_id: Option<String>,
) -> AppResult<()> {
    let db = state.db.lock().await;
    diff_record_repo::update_active_snapshot(
        db.pool(),
        &context_id,
        &document_id,
        snapshot_id.as_deref(),
    )
    .await
}

/// 更新 Diff 记录的 message_id
///
/// Planning 模式中，onDiffData 使用临时 ID，消息创建后需更新为真实 ID
#[tauri::command]
pub async fn diff_record_update_message_id(
    state: State<'_, AppState>,
    context_id: String,
    old_message_id: String,
    new_message_id: String,
) -> AppResult<u64> {
    let db = state.db.lock().await;
    diff_record_repo::update_message_id(db.pool(), &context_id, &old_message_id, &new_message_id)
        .await
}

/// 更新 Diff 记录的每个修改块审批状态
///
/// 部分审批后调用，将各块状态（pending/accepted/rejected）
/// 序列化为 JSON 持久化，重启时精确恢复而非启发式推断
#[tauri::command]
pub async fn diff_record_update_modification_statuses(
    state: State<'_, AppState>,
    context_id: String,
    document_id: String,
    statuses_json: String,
) -> AppResult<()> {
    let db = state.db.lock().await;
    diff_record_repo::update_modification_statuses(
        db.pool(),
        &context_id,
        &document_id,
        &statuses_json,
    )
    .await
}
