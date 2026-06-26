//! Snapshot 数据访问层
//!
//! 提供文档快照的 CRUD 操作，用于 Fast-Apply Engine 的版本控制

use sqlx::{Pool, Sqlite};

use super::models::Snapshot;
use crate::error::{AppError, AppResult};

/// Snapshot Repository - 管理文档快照访问
pub struct SnapshotRepository {
    pool: Pool<Sqlite>,
}

impl SnapshotRepository {
    /// 创建新的 SnapshotRepository 实例
    pub fn new(pool: Pool<Sqlite>) -> Self {
        Self { pool }
    }

    /// 创建新的快照
    ///
    /// # Arguments
    /// * `document_id` - 关联的文档 ID
    /// * `content` - 快照内容
    /// * `trigger_modification_id` - 触发此快照的修改 ID (optional)
    /// * `description` - 快照描述 (optional)
    /// * `modification_statuses_json` - 快照时各修改块审批状态的 JSON (optional)
    ///
    /// # Returns
    /// 创建成功的 Snapshot 实体
    pub async fn create(
        &self,
        document_id: &str,
        content: &str,
        trigger_modification_id: Option<&str>,
        description: Option<&str>,
        modification_statuses_json: Option<&str>,
    ) -> AppResult<Snapshot> {
        let mut snapshot = match trigger_modification_id {
            Some(mod_id) => Snapshot::with_modification(document_id, content, mod_id, description),
            None => match description {
                Some(desc) => Snapshot::with_description(document_id, content, desc),
                None => Snapshot::new(document_id, content),
            },
        };

        // 将修改状态 JSON 写入快照
        snapshot.modification_statuses_json = modification_statuses_json.map(|s| s.to_string());

        sqlx::query(
            r#"
            INSERT INTO snapshots (id, document_id, content, trigger_modification_id, description, modification_statuses_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&snapshot.id)
        .bind(&snapshot.document_id)
        .bind(&snapshot.content)
        .bind(&snapshot.trigger_modification_id)
        .bind(&snapshot.description)
        .bind(&snapshot.modification_statuses_json)
        .bind(snapshot.created_at)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to create snapshot: {}", e)))?;

        Ok(snapshot)
    }

    /// 根据 ID 获取快照
    pub async fn get(&self, id: &str) -> AppResult<Option<Snapshot>> {
        let snapshot = sqlx::query_as::<_, Snapshot>(
            r#"
            SELECT id, document_id, content, trigger_modification_id, description, modification_statuses_json, created_at
            FROM snapshots
            WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to query snapshot: {}", e)))?;

        Ok(snapshot)
    }

    /// 获取指定文档的所有快照（按时间倒序）
    pub async fn list_by_document(&self, document_id: &str) -> AppResult<Vec<Snapshot>> {
        let snapshots = sqlx::query_as::<_, Snapshot>(
            r#"
            SELECT id, document_id, content, trigger_modification_id, description, modification_statuses_json, created_at
            FROM snapshots
            WHERE document_id = ?
            ORDER BY created_at DESC, id DESC
            "#,
        )
        .bind(document_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to query snapshot list: {}", e)))?;

        Ok(snapshots)
    }

    /// 获取指定文档的最新快照
    pub async fn get_latest(&self, document_id: &str) -> AppResult<Option<Snapshot>> {
        let snapshot = sqlx::query_as::<_, Snapshot>(
            r#"
            SELECT id, document_id, content, trigger_modification_id, description, modification_statuses_json, created_at
            FROM snapshots
            WHERE document_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            "#,
        )
        .bind(document_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to query latest snapshot: {}", e)))?;

        Ok(snapshot)
    }

    /// 获取指定文档的快照数量
    pub async fn count(&self, document_id: &str) -> AppResult<i64> {
        let count: (i64,) = sqlx::query_as(
            r#"
            SELECT COUNT(*) FROM snapshots WHERE document_id = ?
            "#,
        )
        .bind(document_id)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to count snapshots: {}", e)))?;

        Ok(count.0)
    }

    /// 删除单个快照
    pub async fn delete(&self, id: &str) -> AppResult<()> {
        let result = sqlx::query(
            r#"
            DELETE FROM snapshots WHERE id = ?
            "#,
        )
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to delete snapshot: {}", e)))?;

        if result.rows_affected() == 0 {
            return Err(AppError::NotFound(format!("Snapshot {} does not exist", id)));
        }

        Ok(())
    }

    /// 删除指定文档的所有快照
    pub async fn delete_by_document(&self, document_id: &str) -> AppResult<u64> {
        let result = sqlx::query(
            r#"
            DELETE FROM snapshots WHERE document_id = ?
            "#,
        )
        .bind(document_id)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to delete document snapshots: {}", e)))?;

        Ok(result.rows_affected())
    }

    /// 清理旧快照，保留最近的 N 个
    ///
    /// # Arguments
    /// * `document_id` - 文档 ID
    /// * `keep_count` - 保留的快照数量
    ///
    /// # Returns
    /// 删除的快照数量
    pub async fn cleanup(&self, document_id: &str, keep_count: i64) -> AppResult<u64> {
        // 先找出需要保留的快照 ID
        let result = sqlx::query(
            r#"
            DELETE FROM snapshots
            WHERE document_id = ?
            AND id NOT IN (
                SELECT id FROM snapshots
                WHERE document_id = ?
                ORDER BY created_at DESC, id DESC
                LIMIT ?
            )
            "#,
        )
        .bind(document_id)
        .bind(document_id)
        .bind(keep_count)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to clean snapshots: {}", e)))?;

        Ok(result.rows_affected())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::{create_pool, initialize_schema};

    async fn setup_test_db() -> SnapshotRepository {
        let pool = create_pool("sqlite::memory:").await.unwrap();
        initialize_schema(&pool).await.unwrap();
        SnapshotRepository::new(pool)
    }

    #[tokio::test]
    async fn test_create_snapshot() {
        let repo = setup_test_db().await;

        // 创建基本快照
        let snapshot = repo
            .create("doc-1", "Hello World", None, None, None)
            .await
            .unwrap();

        assert_eq!(snapshot.document_id, "doc-1");
        assert_eq!(snapshot.content, "Hello World");
        assert!(snapshot.trigger_modification_id.is_none());
        assert!(snapshot.description.is_none());

        // 创建带描述的快照
        let snapshot2 = repo
            .create("doc-1", "Updated content", None, Some("After edit"), None)
            .await
            .unwrap();

        assert_eq!(snapshot2.description, Some("After edit".to_string()));
    }

    #[tokio::test]
    async fn test_list_snapshots() {
        let repo = setup_test_db().await;

        // 创建多个快照（间隔 2ms 确保时间戳单调递增）
        repo.create("doc-1", "Version 1", None, Some("v1"), None)
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        repo.create("doc-1", "Version 2", None, Some("v2"), None)
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        repo.create("doc-1", "Version 3", None, Some("v3"), None)
            .await
            .unwrap();

        // 创建另一个文档的快照
        repo.create("doc-2", "Other doc", None, None, None)
            .await
            .unwrap();

        // 查询 doc-1 的快照
        let snapshots = repo.list_by_document("doc-1").await.unwrap();
        assert_eq!(snapshots.len(), 3);

        // 验证按时间倒序排列 (最新的在前)
        assert_eq!(snapshots[0].description, Some("v3".to_string()));
        assert_eq!(snapshots[2].description, Some("v1".to_string()));
    }

    #[tokio::test]
    async fn test_cleanup_snapshots() {
        let repo = setup_test_db().await;

        // 创建 5 个快照（每次间隔 2ms 确保 created_at 毫秒时间戳单调递增，
        // 避免内存 SQLite 执行过快导致时间戳相同、UUID 排序不确定的竞态）
        for i in 1..=5 {
            repo.create("doc-1", &format!("Version {}", i), None, Some(&format!("v{}", i)), None)
                .await
                .unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }

        // 验证创建了 5 个
        let count = repo.count("doc-1").await.unwrap();
        assert_eq!(count, 5);

        // 清理，只保留最新的 3 个
        let deleted = repo.cleanup("doc-1", 3).await.unwrap();
        assert_eq!(deleted, 2);

        // 验证剩余 3 个
        let remaining = repo.list_by_document("doc-1").await.unwrap();
        assert_eq!(remaining.len(), 3);

        // 验证保留的是最新的 3 个
        assert_eq!(remaining[0].description, Some("v5".to_string()));
        assert_eq!(remaining[1].description, Some("v4".to_string()));
        assert_eq!(remaining[2].description, Some("v3".to_string()));
    }

    #[tokio::test]
    async fn test_get_latest_snapshot() {
        let repo = setup_test_db().await;

        // 创建多个快照（间隔 2ms 确保时间戳单调递增）
        repo.create("doc-1", "Version 1", None, None, None)
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        repo.create("doc-1", "Version 2", None, None, None)
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        let latest = repo
            .create("doc-1", "Version 3 - Latest", None, None, None)
            .await
            .unwrap();

        // 获取最新快照
        let result = repo.get_latest("doc-1").await.unwrap();
        assert!(result.is_some());
        assert_eq!(result.unwrap().id, latest.id);
    }
}
