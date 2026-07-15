//! DiffRecord Repository
//!
//! 文件编辑记录的数据库操作，支持 Diff 持久化和消息关联

use chrono::Utc;
use sqlx::{Pool, Sqlite};

use super::models::{DiffRecord, DiffRecordStatus};
use crate::error::{AppError, AppResult};

/// 创建 DiffRecord
pub async fn create(pool: &Pool<Sqlite>, record: &DiffRecord) -> AppResult<DiffRecord> {
    sqlx::query_as::<_, DiffRecord>(
        r#"
        INSERT INTO diff_records (id, context_id, message_id, document_id, original_content, modified_content, xml_modification, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
        "#,
    )
    .bind(&record.id)
    .bind(&record.context_id)
    .bind(&record.message_id)
    .bind(&record.document_id)
    .bind(&record.original_content)
    .bind(&record.modified_content)
    .bind(&record.xml_modification)
    .bind(&record.status)
    .bind(record.created_at)
    .bind(record.updated_at)
    .fetch_one(pool)
    .await
    .map_err(|e| AppError::Database(e.to_string()))
}

/// 根据 ID 获取 DiffRecord
pub async fn get_by_id(pool: &Pool<Sqlite>, id: &str) -> AppResult<Option<DiffRecord>> {
    sqlx::query_as::<_, DiffRecord>("SELECT * FROM diff_records WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))
}

/// 根据 message_id 获取关联的 DiffRecord 列表
pub async fn get_by_message(pool: &Pool<Sqlite>, message_id: &str) -> AppResult<Vec<DiffRecord>> {
    sqlx::query_as::<_, DiffRecord>(
        "SELECT * FROM diff_records WHERE message_id = ? ORDER BY created_at DESC",
    )
    .bind(message_id)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::Database(e.to_string()))
}

/// 根据 context_id 获取所有 DiffRecord（包括未完成的）
pub async fn get_by_context(pool: &Pool<Sqlite>, context_id: &str) -> AppResult<Vec<DiffRecord>> {
    sqlx::query_as::<_, DiffRecord>(
        "SELECT * FROM diff_records WHERE context_id = ? ORDER BY created_at DESC",
    )
    .bind(context_id)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::Database(e.to_string()))
}

/// 根据 context_id 获取待处理的 DiffRecord
pub async fn get_pending_by_context(
    pool: &Pool<Sqlite>,
    context_id: &str,
) -> AppResult<Vec<DiffRecord>> {
    sqlx::query_as::<_, DiffRecord>(
        "SELECT * FROM diff_records WHERE context_id = ? AND status = 'pending' ORDER BY created_at DESC"
    )
    .bind(context_id)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::Database(e.to_string()))
}

/// 更新 DiffRecord 状态
pub async fn update_status(
    pool: &Pool<Sqlite>,
    id: &str,
    status: DiffRecordStatus,
) -> AppResult<()> {
    let now = Utc::now().timestamp_millis();
    sqlx::query("UPDATE diff_records SET status = ?, updated_at = ? WHERE id = ?")
        .bind(status.as_str())
        .bind(now)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;
    Ok(())
}

/// 更新 DiffRecord 的修改后内容
pub async fn update_modified_content(
    pool: &Pool<Sqlite>,
    id: &str,
    modified_content: &str,
    status: DiffRecordStatus,
) -> AppResult<()> {
    let now = Utc::now().timestamp_millis();
    sqlx::query(
        "UPDATE diff_records SET modified_content = ?, status = ?, updated_at = ? WHERE id = ?",
    )
    .bind(modified_content)
    .bind(status.as_str())
    .bind(now)
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| AppError::Database(e.to_string()))?;
    Ok(())
}

/// 批量将消息关联的 DiffRecord 状态更新为 reverted
pub async fn revert_by_message(
    pool: &Pool<Sqlite>,
    message_id: &str,
) -> AppResult<Vec<DiffRecord>> {
    // 先获取要回滚的记录
    let records = get_by_message(pool, message_id).await?;

    // 批量更新状态
    let now = Utc::now().timestamp_millis();
    sqlx::query("UPDATE diff_records SET status = 'reverted', updated_at = ? WHERE message_id = ?")
        .bind(now)
        .bind(message_id)
        .execute(pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

    Ok(records)
}

/// 删除 DiffRecord
pub async fn delete(pool: &Pool<Sqlite>, id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM diff_records WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;
    Ok(())
}

/// 清理指定 context 的所有 DiffRecord
pub async fn clear_by_context(pool: &Pool<Sqlite>, context_id: &str) -> AppResult<u64> {
    let result = sqlx::query("DELETE FROM diff_records WHERE context_id = ?")
        .bind(context_id)
        .execute(pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;
    Ok(result.rows_affected())
}

/// 更新 DiffRecord 的每个修改块审批状态（JSON 格式）
///
/// 部分审批（如拒绝 block1 但保留 block2 pending）后调用，
/// 将各块精确状态持久化到 DB，重启时无需启发式推断。
pub async fn update_modification_statuses(
    pool: &Pool<Sqlite>,
    context_id: &str,
    document_id: &str,
    statuses_json: &str,
) -> AppResult<()> {
    let now = Utc::now().timestamp_millis();
    sqlx::query(
        "UPDATE diff_records SET modification_statuses = ?, updated_at = ? WHERE context_id = ? AND document_id = ? AND status = 'pending'"
    )
    .bind(statuses_json)
    .bind(now)
    .bind(context_id)
    .bind(document_id)
    .execute(pool)
    .await
    .map_err(|e| AppError::Database(e.to_string()))?;
    Ok(())
}

/// 更新 DiffRecord 的 active_snapshot_id（用于记录当前激活的快照）
pub async fn update_active_snapshot(
    pool: &Pool<Sqlite>,
    context_id: &str,
    document_id: &str,
    snapshot_id: Option<&str>,
) -> AppResult<()> {
    let now = Utc::now().timestamp_millis();
    sqlx::query(
        "UPDATE diff_records SET active_snapshot_id = ?, updated_at = ? WHERE context_id = ? AND document_id = ? AND status = 'pending'"
    )
    .bind(snapshot_id)
    .bind(now)
    .bind(context_id)
    .bind(document_id)
    .execute(pool)
    .await
    .map_err(|e| AppError::Database(e.to_string()))?;
    Ok(())
}

/// 更新 DiffRecord 的 message_id（Planning 模式临时 ID 替换为真实 ID）
///
/// 在 Planning 模式中，onDiffData 回调在消息创建前触发，使用临时 ID 持久化 Diff 记录。
/// 消息创建后调用此方法更新为真实 ID，确保后续查询（如撤回时的关联查询）正常工作。
pub async fn update_message_id(
    pool: &Pool<Sqlite>,
    context_id: &str,
    old_message_id: &str,
    new_message_id: &str,
) -> AppResult<u64> {
    let now = Utc::now().timestamp_millis();
    let result = sqlx::query(
        "UPDATE diff_records SET message_id = ?, updated_at = ? WHERE context_id = ? AND message_id = ?"
    )
    .bind(new_message_id)
    .bind(now)
    .bind(context_id)
    .bind(old_message_id)
    .execute(pool)
    .await
    .map_err(|e| AppError::Database(e.to_string()))?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::{create_pool, initialize_schema};

    #[tokio::test]
    async fn update_active_snapshot_only_updates_pending_records_for_target_document() {
        let pool = create_pool("sqlite::memory:").await.unwrap();
        initialize_schema(&pool).await.unwrap();

        let target_pending = create(
            &pool,
            &DiffRecord::new("context-a", "message-1", "document-a", "before", "after"),
        )
        .await
        .unwrap();
        let other_document_pending = create(
            &pool,
            &DiffRecord::new("context-a", "message-2", "document-b", "before", "after"),
        )
        .await
        .unwrap();
        let other_context_pending = create(
            &pool,
            &DiffRecord::new("context-b", "message-3", "document-a", "before", "after"),
        )
        .await
        .unwrap();
        let target_applied = create(
            &pool,
            &DiffRecord::new("context-a", "message-4", "document-a", "before", "after"),
        )
        .await
        .unwrap();
        update_status(&pool, &target_applied.id, DiffRecordStatus::Applied)
            .await
            .unwrap();

        update_active_snapshot(&pool, "context-a", "document-a", Some("snapshot-a"))
            .await
            .unwrap();

        assert_eq!(
            get_by_id(&pool, &target_pending.id)
                .await
                .unwrap()
                .unwrap()
                .active_snapshot_id
                .as_deref(),
            Some("snapshot-a")
        );
        assert_eq!(
            get_by_id(&pool, &other_document_pending.id)
                .await
                .unwrap()
                .unwrap()
                .active_snapshot_id,
            None
        );
        assert_eq!(
            get_by_id(&pool, &other_context_pending.id)
                .await
                .unwrap()
                .unwrap()
                .active_snapshot_id,
            None
        );
        assert_eq!(
            get_by_id(&pool, &target_applied.id)
                .await
                .unwrap()
                .unwrap()
                .active_snapshot_id,
            None
        );
    }
}
