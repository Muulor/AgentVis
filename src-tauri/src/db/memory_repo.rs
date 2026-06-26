//! Memory 数据访问层
//!
//! 提供三层记忆系统的 CRUD 操作

use chrono::Utc;
use sqlx::{Pool, Sqlite};

use super::models::{Memory, MemoryLayer};
use crate::error::{AppError, AppResult};

/// Memory Repository - 管理记忆数据访问
pub struct MemoryRepository {
    pool: Pool<Sqlite>,
}

impl MemoryRepository {
    /// 创建新的 MemoryRepository 实例
    pub fn new(pool: Pool<Sqlite>) -> Self {
        Self { pool }
    }

    /// 创建新的记忆
    /// 
    /// # Arguments
    /// * `agent_id` - 所属 Agent ID
    /// * `layer` - 记忆层级
    /// * `content` - 记忆内容
    /// 
    /// # Returns
    /// 创建成功的 Memory 实体
    pub async fn create(&self, agent_id: &str, layer: MemoryLayer, content: &str) -> AppResult<Memory> {
        let memory = Memory::new(agent_id, layer, content);
        
        sqlx::query(
            r#"
            INSERT INTO memories (id, agent_id, layer, content, category, importance, 
                                 source_message_ids, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&memory.id)
        .bind(&memory.agent_id)
        .bind(&memory.layer)
        .bind(&memory.content)
        .bind(&memory.category)
        .bind(memory.importance)
        .bind(&memory.source_message_ids)
        .bind(memory.created_at)
        .bind(memory.updated_at)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(memory)
    }

    /// 创建带完整属性的记忆 (用于摘要和事实提取)
    pub async fn create_with_details(
        &self,
        agent_id: &str,
        layer: MemoryLayer,
        content: &str,
        category: Option<&str>,
        importance: Option<i32>,
        source_message_ids: Option<&str>,
        metadata_json: Option<&str>,
    ) -> AppResult<Memory> {
        let mut memory = Memory::new(agent_id, layer, content);
        memory.category = category.map(|s| s.to_string());
        memory.importance = importance;
        memory.source_message_ids = source_message_ids.map(|s| s.to_string());
        memory.metadata_json = metadata_json.map(|s| s.to_string());
        
        sqlx::query(
            r#"
            INSERT INTO memories (id, agent_id, layer, content, category, importance, 
                                 source_message_ids, metadata_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&memory.id)
        .bind(&memory.agent_id)
        .bind(&memory.layer)
        .bind(&memory.content)
        .bind(&memory.category)
        .bind(memory.importance)
        .bind(&memory.source_message_ids)
        .bind(&memory.metadata_json)
        .bind(memory.created_at)
        .bind(memory.updated_at)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(memory)
    }

    /// 根据 ID 获取记忆
    pub async fn get(&self, id: &str) -> AppResult<Option<Memory>> {
        let memory: Option<Memory> = sqlx::query_as(
            r#"
            SELECT id, agent_id, layer, content, category, importance, 
                   source_message_ids, metadata_json, created_at, updated_at
            FROM memories
            WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(memory)
    }

    /// 获取指定 Agent 和层级的记忆列表
    /// 
    /// # Arguments
    /// * `agent_id` - Agent ID
    /// * `layer` - 记忆层级
    /// 
    /// # Returns
    /// 记忆列表，按创建时间降序排列
    pub async fn list_by_layer(&self, agent_id: &str, layer: MemoryLayer) -> AppResult<Vec<Memory>> {
        let memories: Vec<Memory> = sqlx::query_as(
            r#"
            SELECT id, agent_id, layer, content, category, importance, 
                   source_message_ids, metadata_json, created_at, updated_at
            FROM memories
            WHERE agent_id = ? AND layer = ?
            ORDER BY created_at DESC
            "#,
        )
        .bind(agent_id)
        .bind(layer.as_str())
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(memories)
    }

    /// 获取指定 Agent 的所有记忆
    pub async fn list_all(&self, agent_id: &str) -> AppResult<Vec<Memory>> {
        let memories: Vec<Memory> = sqlx::query_as(
            r#"
            SELECT id, agent_id, layer, content, category, importance, 
                   source_message_ids, metadata_json, created_at, updated_at
            FROM memories
            WHERE agent_id = ?
            ORDER BY created_at DESC
            "#,
        )
        .bind(agent_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(memories)
    }

    /// 获取指定 Agent 和类别的事实记忆
    pub async fn list_facts_by_category(&self, agent_id: &str, category: &str) -> AppResult<Vec<Memory>> {
        let memories: Vec<Memory> = sqlx::query_as(
            r#"
            SELECT id, agent_id, layer, content, category, importance, 
                   source_message_ids, metadata_json, created_at, updated_at
            FROM memories
            WHERE agent_id = ? AND layer = 'fact' AND category = ?
            ORDER BY importance DESC, created_at DESC
            "#,
        )
        .bind(agent_id)
        .bind(category)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(memories)
    }

    /// 更新记忆内容
    pub async fn update_content(&self, id: &str, content: &str) -> AppResult<Memory> {
        let now = Utc::now().timestamp_millis();
        
        sqlx::query(
            r#"
            UPDATE memories 
            SET content = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(content)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        self.get(id).await?.ok_or_else(|| AppError::NotFound(format!("Memory does not exist: {}", id)))
    }

    /// 更新事实记忆的类别和重要性
    pub async fn update_fact_metadata(
        &self,
        id: &str,
        category: Option<&str>,
        importance: Option<i32>,
    ) -> AppResult<Memory> {
        let now = Utc::now().timestamp_millis();
        
        sqlx::query(
            r#"
            UPDATE memories 
            SET category = COALESCE(?, category), 
                importance = COALESCE(?, importance), 
                updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(category)
        .bind(importance)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        self.get(id).await?.ok_or_else(|| AppError::NotFound(format!("Memory does not exist: {}", id)))
    }

    /// 删除记忆
    pub async fn delete(&self, id: &str) -> AppResult<()> {
        let result = sqlx::query("DELETE FROM memories WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(AppError::NotFound(format!("Memory does not exist: {}", id)));
        }

        Ok(())
    }

    /// 根据源消息 ID 删除 short_term 层级的记忆
    /// 
    /// 用于撤销消息时同步删除关联的短期缓冲记录
    /// 
    /// # Arguments
    /// * `agent_id` - Agent ID
    /// * `source_message_ids` - 源消息 ID 列表
    /// 
    /// # Returns
    /// 删除的记录数量
    pub async fn delete_by_source_ids(&self, agent_id: &str, source_message_ids: &[String]) -> AppResult<u64> {
        let mut total_deleted: u64 = 0;
        
        for source_id in source_message_ids {
            // 使用 LIKE 匹配，因为 source_message_ids 可能包含多个 ID
            // 格式为: "[\"msg-1\", \"msg-2\"]" 或单个 "msg-1"
            let result = sqlx::query(
                r#"
                DELETE FROM memories 
                WHERE agent_id = ? 
                  AND layer = 'short_term' 
                  AND (source_message_ids LIKE ? OR source_message_ids = ?)
                "#,
            )
            .bind(agent_id)
            .bind(format!("%{}%", source_id))
            .bind(source_id)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Database(e.to_string()))?;
            
            total_deleted += result.rows_affected();
        }
        
        Ok(total_deleted)
    }

    /// 清空指定 Agent 指定层级的记忆
    pub async fn clear_layer(&self, agent_id: &str, layer: MemoryLayer) -> AppResult<u64> {
        let result = sqlx::query(
            r#"
            DELETE FROM memories 
            WHERE agent_id = ? AND layer = ?
            "#,
        )
        .bind(agent_id)
        .bind(layer.as_str())
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(result.rows_affected())
    }

    /// 获取指定 Agent 各层级的记忆统计
    pub async fn get_stats(&self, agent_id: &str) -> AppResult<MemoryStats> {
        let short_term: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM memories WHERE agent_id = ? AND layer = 'short_term'"
        )
        .bind(agent_id)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        let summary: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM memories WHERE agent_id = ? AND layer = 'summary'"
        )
        .bind(agent_id)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        let fact: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM memories WHERE agent_id = ? AND layer = 'fact'"
        )
        .bind(agent_id)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(MemoryStats {
            short_term_count: short_term.0,
            summary_count: summary.0,
            fact_count: fact.0,
        })
    }
}

/// 记忆统计信息
#[derive(Debug, Clone, serde::Serialize)]
pub struct MemoryStats {
    pub short_term_count: i64,
    pub summary_count: i64,
    pub fact_count: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::agent_repo::AgentRepository;
    use crate::db::hub_repo::HubRepository;
    use crate::db::schema::{create_pool, initialize_schema};

    async fn setup_test_db() -> (HubRepository, AgentRepository, MemoryRepository) {
        let pool = create_pool("sqlite::memory:").await.unwrap();
        initialize_schema(&pool).await.unwrap();
        (
            HubRepository::new(pool.clone()),
            AgentRepository::new(pool.clone()),
            MemoryRepository::new(pool),
        )
    }

    #[tokio::test]
    async fn test_create_memory() {
        let (hub_repo, agent_repo, mem_repo) = setup_test_db().await;
        
        let hub = hub_repo.create("测试 Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "测试 Agent").await.unwrap();
        
        let memory = mem_repo.create(&agent.id, MemoryLayer::ShortTerm, "短期记忆内容").await.unwrap();
        
        assert!(!memory.id.is_empty());
        assert_eq!(memory.agent_id, agent.id);
        assert_eq!(memory.layer, "short_term");
    }

    #[tokio::test]
    async fn test_list_by_layer() {
        let (hub_repo, agent_repo, mem_repo) = setup_test_db().await;
        
        let hub = hub_repo.create("测试 Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "测试 Agent").await.unwrap();
        
        mem_repo.create(&agent.id, MemoryLayer::ShortTerm, "短期1").await.unwrap();
        mem_repo.create(&agent.id, MemoryLayer::ShortTerm, "短期2").await.unwrap();
        mem_repo.create(&agent.id, MemoryLayer::Fact, "事实1").await.unwrap();
        
        let short_term = mem_repo.list_by_layer(&agent.id, MemoryLayer::ShortTerm).await.unwrap();
        let facts = mem_repo.list_by_layer(&agent.id, MemoryLayer::Fact).await.unwrap();
        
        assert_eq!(short_term.len(), 2);
        assert_eq!(facts.len(), 1);
    }

    #[tokio::test]
    async fn test_create_with_details() {
        let (hub_repo, agent_repo, mem_repo) = setup_test_db().await;
        
        let hub = hub_repo.create("测试 Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "测试 Agent").await.unwrap();
        
        let memory = mem_repo.create_with_details(
            &agent.id,
            MemoryLayer::Fact,
            "用户偏好简洁回复",
            Some("USER_PREFERENCE"),
            Some(5),
            Some(r#"["msg-1", "msg-2"]"#),
            None,
        ).await.unwrap();
        
        assert_eq!(memory.category, Some("USER_PREFERENCE".to_string()));
        assert_eq!(memory.importance, Some(5));
    }

    #[tokio::test]
    async fn test_update_memory_uses_millisecond_timestamp() {
        let (hub_repo, agent_repo, mem_repo) = setup_test_db().await;

        let hub = hub_repo.create("测试 Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "测试 Agent").await.unwrap();
        let memory = mem_repo
            .create_with_details(
                &agent.id,
                MemoryLayer::Fact,
                "用户偏好简洁回复",
                Some("preference_style"),
                Some(4),
                None,
                None,
            )
            .await
            .unwrap();

        let updated_content = mem_repo
            .update_content(&memory.id, "用户偏好清晰回复")
            .await
            .unwrap();
        assert!(updated_content.updated_at > 1_000_000_000_000);

        let updated_metadata = mem_repo
            .update_fact_metadata(&memory.id, Some("knowledge_level"), Some(5))
            .await
            .unwrap();
        assert!(updated_metadata.updated_at > 1_000_000_000_000);
    }

    #[tokio::test]
    async fn test_get_stats() {
        let (hub_repo, agent_repo, mem_repo) = setup_test_db().await;
        
        let hub = hub_repo.create("测试 Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "测试 Agent").await.unwrap();
        
        mem_repo.create(&agent.id, MemoryLayer::ShortTerm, "短期1").await.unwrap();
        mem_repo.create(&agent.id, MemoryLayer::ShortTerm, "短期2").await.unwrap();
        mem_repo.create(&agent.id, MemoryLayer::Summary, "摘要1").await.unwrap();
        mem_repo.create(&agent.id, MemoryLayer::Fact, "事实1").await.unwrap();
        mem_repo.create(&agent.id, MemoryLayer::Fact, "事实2").await.unwrap();
        mem_repo.create(&agent.id, MemoryLayer::Fact, "事实3").await.unwrap();
        
        let stats = mem_repo.get_stats(&agent.id).await.unwrap();
        
        assert_eq!(stats.short_term_count, 2);
        assert_eq!(stats.summary_count, 1);
        assert_eq!(stats.fact_count, 3);
    }
}
