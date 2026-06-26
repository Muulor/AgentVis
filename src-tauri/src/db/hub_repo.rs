//! Hub 数据访问层
//!
//! 提供 Hub 实体的 CRUD 操作

use chrono::Utc;
use sqlx::{Pool, Sqlite};

use super::models::{Hub, HubUpdate};
use crate::error::{AppError, AppResult};

/// Hub Repository - 管理 Hub 数据访问
pub struct HubRepository {
    pool: Pool<Sqlite>,
}

impl HubRepository {
    /// 创建新的 HubRepository 实例
    pub fn new(pool: Pool<Sqlite>) -> Self {
        Self { pool }
    }

    async fn next_sort_order(&self) -> AppResult<i64> {
        let (next_order,): (i64,) = sqlx::query_as(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM hubs WHERE deleted_at IS NULL",
        )
        .fetch_one(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(next_order)
    }

    /// 创建新的 Hub
    /// 
    /// # Arguments
    /// * `name` - Hub 名称
    /// 
    /// # Returns
    /// 创建成功的 Hub 实体
    pub async fn create(&self, name: &str) -> AppResult<Hub> {
        let mut hub = Hub::new(name);
        hub.sort_order = self.next_sort_order().await?;
        
        sqlx::query(
            r#"
            INSERT INTO hubs (id, name, sort_order, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&hub.id)
        .bind(&hub.name)
        .bind(hub.sort_order)
        .bind(hub.created_at)
        .bind(hub.updated_at)
        .bind(hub.deleted_at)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(hub)
    }

    /// 根据 ID 获取 Hub
    /// 
    /// # Arguments
    /// * `id` - Hub ID
    /// 
    /// # Returns
    /// Hub 实体，如果不存在或已删除返回 None
    pub async fn get(&self, id: &str) -> AppResult<Option<Hub>> {
        let hub: Option<Hub> = sqlx::query_as(
            r#"
            SELECT id, name, COALESCE(sort_order, 0) AS sort_order, created_at, updated_at, deleted_at
            FROM hubs
            WHERE id = ? AND deleted_at IS NULL
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(hub)
    }

    /// 获取所有未删除的 Hub
    /// 
    /// # Returns
    /// Hub 列表，按用户排序排列
    pub async fn list(&self) -> AppResult<Vec<Hub>> {
        let hubs: Vec<Hub> = sqlx::query_as(
            r#"
            SELECT id, name, COALESCE(sort_order, 0) AS sort_order, created_at, updated_at, deleted_at
            FROM hubs
            WHERE deleted_at IS NULL
            ORDER BY sort_order ASC, created_at DESC
            "#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(hubs)
    }

    /// 更新 Hub
    /// 
    /// # Arguments
    /// * `id` - Hub ID  
    /// * `update` - 更新数据
    /// 
    /// # Returns
    /// 更新后的 Hub 实体
    pub async fn update(&self, id: &str, update: HubUpdate) -> AppResult<Hub> {
        let now = Utc::now().timestamp();
        
        // 先获取现有 Hub
        let existing = self.get(id).await?;
        let hub = existing.ok_or_else(|| AppError::NotFound(format!("Hub does not exist: {}", id)))?;
        
        // 合并更新
        let new_name = update.name.unwrap_or(hub.name);
        
        sqlx::query(
            r#"
            UPDATE hubs 
            SET name = ?, updated_at = ?
            WHERE id = ? AND deleted_at IS NULL
            "#,
        )
        .bind(&new_name)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        // 返回更新后的 Hub
        self.get(id).await?.ok_or_else(|| AppError::NotFound(format!("Hub does not exist: {}", id)))
    }

    /// 更新 Hub 的用户排序
    pub async fn reorder(&self, ordered_ids: &[String]) -> AppResult<()> {
        let now = Utc::now().timestamp_millis();
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| AppError::Database(format!("Failed to begin transaction: {}", e)))?;

        for (index, id) in ordered_ids.iter().enumerate() {
            let result = sqlx::query(
                r#"
                UPDATE hubs
                SET sort_order = ?, updated_at = ?
                WHERE id = ? AND deleted_at IS NULL
                "#,
            )
            .bind(index as i64)
            .bind(now)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Database(format!("Failed to reorder hub: {}", e)))?;

            if result.rows_affected() == 0 {
                return Err(AppError::NotFound(format!("Hub does not exist: {}", id)));
            }
        }

        tx.commit()
            .await
            .map_err(|e| AppError::Database(format!("Failed to commit transaction: {}", e)))?;

        Ok(())
    }

    /// 级联删除 Hub 及其所有下属 Agent 和关联数据
    /// 
    /// 使用事务确保原子性：
    /// 1. 查询该 Hub 下所有 Agent（包括已软删除的）
    /// 2. 对每个 Agent 执行级联删除（9 张关联表）
    /// 3. 删除 Hub 自身的 diff_records
    /// 4. 删除 Hub 记录
    /// 
    /// # Arguments
    /// * `id` - Hub ID
    pub async fn cascade_delete(&self, id: &str) -> AppResult<()> {
        // 先验证 Hub 存在
        let existing: Option<Hub> = sqlx::query_as(
            "SELECT id, name, COALESCE(sort_order, 0) AS sort_order, created_at, updated_at, deleted_at FROM hubs WHERE id = ?"
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        if existing.is_none() {
            return Err(AppError::NotFound(format!("Hub does not exist: {}", id)));
        }

        // 查询该 Hub 下所有 Agent ID（包括已软删除的，确保彻底清理）
        let agent_ids: Vec<(String,)> = sqlx::query_as(
            "SELECT id FROM agents WHERE hub_id = ?"
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        // 使用事务确保原子性
        let mut tx = self.pool.begin().await
            .map_err(|e| AppError::Database(format!("Failed to begin transaction: {}", e)))?;

        // 对每个 Agent 执行级联删除
        for (agent_id,) in &agent_ids {
            // 按依赖顺序删除 Agent 的所有关联数据
            sqlx::query("DELETE FROM diff_records WHERE context_id = ?")
                .bind(agent_id).execute(&mut *tx).await
                .map_err(|e| AppError::Database(format!("Failed to delete Agent({}) diff_records: {}", agent_id, e)))?;

            sqlx::query("DELETE FROM chunk_embeddings WHERE agent_id = ?")
                .bind(agent_id).execute(&mut *tx).await
                .map_err(|e| AppError::Database(format!("Failed to delete Agent({}) chunk_embeddings: {}", agent_id, e)))?;

            sqlx::query("DELETE FROM vector_metadata WHERE agent_id = ?")
                .bind(agent_id).execute(&mut *tx).await
                .map_err(|e| AppError::Database(format!("Failed to delete Agent({}) vector_metadata: {}", agent_id, e)))?;

            sqlx::query("DELETE FROM memory_candidates WHERE agent_id = ?")
                .bind(agent_id).execute(&mut *tx).await
                .map_err(|e| AppError::Database(format!("Failed to delete Agent({}) memory_candidates: {}", agent_id, e)))?;

            sqlx::query("DELETE FROM memory_trigger_state WHERE agent_id = ?")
                .bind(agent_id).execute(&mut *tx).await
                .map_err(|e| AppError::Database(format!("Failed to delete Agent({}) memory_trigger_state: {}", agent_id, e)))?;

            sqlx::query("DELETE FROM memories WHERE agent_id = ?")
                .bind(agent_id).execute(&mut *tx).await
                .map_err(|e| AppError::Database(format!("Failed to delete Agent({}) memories: {}", agent_id, e)))?;

            sqlx::query("DELETE FROM messages WHERE agent_id = ?")
                .bind(agent_id).execute(&mut *tx).await
                .map_err(|e| AppError::Database(format!("Failed to delete Agent({}) messages: {}", agent_id, e)))?;

            sqlx::query("DELETE FROM files WHERE agent_id = ?")
                .bind(agent_id).execute(&mut *tx).await
                .map_err(|e| AppError::Database(format!("Failed to delete Agent({}) files: {}", agent_id, e)))?;

            sqlx::query("DELETE FROM agents WHERE id = ?")
                .bind(agent_id).execute(&mut *tx).await
                .map_err(|e| AppError::Database(format!("Failed to delete Agent({}): {}", agent_id, e)))?;
        }

        // 删除 Hub 自身的 diff_records（context_id 可能是 hub_id）
        sqlx::query("DELETE FROM diff_records WHERE context_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Database(format!("Failed to delete Hub diff_records: {}", e)))?;

        // 删除 Hub 自身
        sqlx::query("DELETE FROM hubs WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Database(format!("Failed to delete Hub: {}", e)))?;

        // 提交事务
        tx.commit().await
            .map_err(|e| AppError::Database(format!("Failed to commit transaction: {}", e)))?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::{create_pool, initialize_schema};

    async fn setup_test_db() -> HubRepository {
        let pool = create_pool("sqlite::memory:").await.unwrap();
        initialize_schema(&pool).await.unwrap();
        HubRepository::new(pool)
    }

    #[tokio::test]
    async fn test_create_hub() {
        let repo = setup_test_db().await;
        
        let hub = repo.create("测试 Hub").await.unwrap();
        
        assert!(!hub.id.is_empty());
        assert_eq!(hub.name, "测试 Hub");
        assert!(hub.deleted_at.is_none());
    }

    #[tokio::test]
    async fn test_get_hub() {
        let repo = setup_test_db().await;
        
        let created = repo.create("测试 Hub").await.unwrap();
        let fetched = repo.get(&created.id).await.unwrap();
        
        assert!(fetched.is_some());
        assert_eq!(fetched.unwrap().name, "测试 Hub");
    }

    #[tokio::test]
    async fn test_list_hubs() {
        let repo = setup_test_db().await;
        
        repo.create("Hub 1").await.unwrap();
        repo.create("Hub 2").await.unwrap();
        
        let hubs = repo.list().await.unwrap();
        
        assert_eq!(hubs.len(), 2);
    }

    #[tokio::test]
    async fn test_update_hub() {
        let repo = setup_test_db().await;
        
        let created = repo.create("原名称").await.unwrap();
        let updated = repo.update(&created.id, HubUpdate {
            name: Some("新名称".to_string()),
        }).await.unwrap();
        
        assert_eq!(updated.name, "新名称");
    }

    #[tokio::test]
    async fn test_cascade_delete_hub() {
        let repo = setup_test_db().await;
        
        let created = repo.create("待删除").await.unwrap();
        repo.cascade_delete(&created.id).await.unwrap();
        
        // Hub 应已被彻底删除
        let hubs = repo.list().await.unwrap();
        assert!(hubs.is_empty());
    }

    #[tokio::test]
    async fn test_cascade_delete_hub_with_agents() {
        // 测试 Hub 级联删除会同时删除下属 Agent 和数据
        let pool = create_pool("sqlite::memory:").await.unwrap();
        initialize_schema(&pool).await.unwrap();

        let hub_repo = HubRepository::new(pool.clone());

        let hub = hub_repo.create("有 Agent 的 Hub").await.unwrap();

        // 创建 2 个 Agent
        sqlx::query(
            "INSERT INTO agents (id, hub_id, name, created_at, updated_at) VALUES ('a1', ?, 'Agent1', 1000, 1000)"
        ).bind(&hub.id).execute(&pool).await.unwrap();

        sqlx::query(
            "INSERT INTO agents (id, hub_id, name, created_at, updated_at) VALUES ('a2', ?, 'Agent2', 1000, 1000)"
        ).bind(&hub.id).execute(&pool).await.unwrap();

        // 为每个 Agent 插入消息
        sqlx::query(
            "INSERT INTO messages (id, agent_id, role, content, created_at) VALUES ('m1', 'a1', 'user', '你好', 1000)"
        ).execute(&pool).await.unwrap();

        sqlx::query(
            "INSERT INTO messages (id, agent_id, role, content, created_at) VALUES ('m2', 'a2', 'user', '你好', 1000)"
        ).execute(&pool).await.unwrap();

        // 级联删除 Hub
        hub_repo.cascade_delete(&hub.id).await.unwrap();

        // 验证 Hub 已删除
        let hub_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM hubs WHERE id = ?")
            .bind(&hub.id).fetch_one(&pool).await.unwrap();
        assert_eq!(hub_count.0, 0, "Hub 应已被删除");

        // 验证 Agent 已删除
        let agent_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM agents WHERE hub_id = ?")
            .bind(&hub.id).fetch_one(&pool).await.unwrap();
        assert_eq!(agent_count.0, 0, "所有 Agent 应已被删除");

        // 验证消息已删除
        let msg_count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM messages WHERE agent_id IN ('a1', 'a2')"
        ).fetch_one(&pool).await.unwrap();
        assert_eq!(msg_count.0, 0, "所有消息应已被删除");
    }
}
