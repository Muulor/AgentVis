//! Agent 数据访问层
//!
//! 提供 Agent 实体的 CRUD 操作

use chrono::Utc;
use sqlx::{Pool, Sqlite};

use super::models::{Agent, AgentUpdate};
use crate::error::{AppError, AppResult};

pub(crate) fn is_valid_reasoning_preset(value: &str) -> bool {
    matches!(
        value,
        "recommended" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    )
}

/// Agent Repository - 管理 Agent 数据访问
pub struct AgentRepository {
    pool: Pool<Sqlite>,
}

impl AgentRepository {
    /// 创建新的 AgentRepository 实例
    pub fn new(pool: Pool<Sqlite>) -> Self {
        Self { pool }
    }

    async fn next_sort_order(&self, hub_id: &str) -> AppResult<i64> {
        let (next_order,): (i64,) = sqlx::query_as(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM agents WHERE hub_id = ? AND deleted_at IS NULL",
        )
        .bind(hub_id)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(next_order)
    }

    /// 创建新的 Agent
    ///
    /// # Arguments
    /// * `hub_id` - 所属 Hub ID
    /// * `name` - Agent 名称
    ///
    /// # Returns
    /// 创建成功的 Agent 实体
    pub async fn create(&self, hub_id: &str, name: &str) -> AppResult<Agent> {
        let mut agent = Agent::new(hub_id, name);
        agent.sort_order = self.next_sort_order(hub_id).await?;

        sqlx::query(
            r#"
            INSERT INTO agents (id, hub_id, name, sort_order, avatar_color, avatar, model_provider, model_name, reasoning_preset,
                               mb_rules_file_path, sa_rules_file_path, mb_rules, sa_rules, chat_rules, knowledge_paths, auto_index_deliverables, visual_enhancement_enabled, pinned_skills, planning_loop_budget, project_path, sandbox_mode, sub_agent_safety_footer_enabled, sub_agent_safety_footer_text, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&agent.id)
        .bind(&agent.hub_id)
        .bind(&agent.name)
        .bind(agent.sort_order)
        .bind(&agent.avatar_color)
        .bind(&agent.avatar)
        .bind(&agent.model_provider)
        .bind(&agent.model_name)
        .bind(&agent.reasoning_preset)
        .bind(&agent.mb_rules_file_path)
        .bind(&agent.sa_rules_file_path)
        .bind(&agent.mb_rules)
        .bind(&agent.sa_rules)
        .bind(&agent.chat_rules)
        .bind(&agent.knowledge_paths)
        .bind(agent.auto_index_deliverables)
        .bind(agent.visual_enhancement_enabled)
        .bind(&agent.pinned_skills)
        .bind(agent.planning_loop_budget)
        .bind(&agent.project_path)
        .bind(&agent.sandbox_mode)
        .bind(agent.sub_agent_safety_footer_enabled)
        .bind(&agent.sub_agent_safety_footer_text)
        .bind(agent.created_at)
        .bind(agent.updated_at)
        .bind(agent.deleted_at)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(agent)
    }

    /// 根据 ID 获取 Agent
    ///
    /// # Arguments
    /// * `id` - Agent ID
    ///
    /// # Returns
    /// Agent 实体，如果不存在或已删除返回 None
    pub async fn get(&self, id: &str) -> AppResult<Option<Agent>> {
        let agent: Option<Agent> = sqlx::query_as(
            r#"
            SELECT id, hub_id, name, COALESCE(sort_order, 0) AS sort_order, avatar_color, avatar, model_provider, model_name, reasoning_preset,
                   mb_rules_file_path, sa_rules_file_path, mb_rules, sa_rules, chat_rules, knowledge_paths, auto_index_deliverables, visual_enhancement_enabled, pinned_skills, planning_loop_budget, project_path, sandbox_mode, sub_agent_safety_footer_enabled, sub_agent_safety_footer_text, created_at, updated_at, deleted_at
            FROM agents
            WHERE id = ? AND deleted_at IS NULL
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(agent)
    }

    /// 获取指定 Hub 下的所有 Agent
    ///
    /// # Arguments
    /// * `hub_id` - Hub ID
    ///
    /// # Returns
    /// Agent 列表，按创建时间降序排列
    pub async fn list_by_hub(&self, hub_id: &str) -> AppResult<Vec<Agent>> {
        let agents: Vec<Agent> = sqlx::query_as(
            r#"
            SELECT id, hub_id, name, COALESCE(sort_order, 0) AS sort_order, avatar_color, avatar, model_provider, model_name, reasoning_preset,
                   mb_rules_file_path, sa_rules_file_path, mb_rules, sa_rules, chat_rules, knowledge_paths, auto_index_deliverables, visual_enhancement_enabled, pinned_skills, planning_loop_budget, project_path, sandbox_mode, sub_agent_safety_footer_enabled, sub_agent_safety_footer_text, created_at, updated_at, deleted_at
            FROM agents
            WHERE hub_id = ? AND deleted_at IS NULL
            ORDER BY sort_order ASC, created_at DESC
            "#,
        )
        .bind(hub_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(agents)
    }

    /// 获取所有未删除的 Agent
    ///
    /// # Returns
    /// Agent 列表
    pub async fn list_all(&self) -> AppResult<Vec<Agent>> {
        let agents: Vec<Agent> = sqlx::query_as(
            r#"
            SELECT id, hub_id, name, COALESCE(sort_order, 0) AS sort_order, avatar_color, avatar, model_provider, model_name, reasoning_preset,
                   mb_rules_file_path, sa_rules_file_path, mb_rules, sa_rules, chat_rules, knowledge_paths, auto_index_deliverables, visual_enhancement_enabled, pinned_skills, planning_loop_budget, project_path, sandbox_mode, sub_agent_safety_footer_enabled, sub_agent_safety_footer_text, created_at, updated_at, deleted_at
            FROM agents
            WHERE deleted_at IS NULL
            ORDER BY hub_id ASC, sort_order ASC, created_at DESC
            "#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(agents)
    }

    /// 更新 Agent
    ///
    /// # Arguments
    /// * `id` - Agent ID
    /// * `update` - 更新数据
    ///
    /// # Returns
    /// 更新后的 Agent 实体
    pub async fn update(&self, id: &str, update: AgentUpdate) -> AppResult<Agent> {
        let now = Utc::now().timestamp();

        // 先获取现有 Agent
        let existing = self.get(id).await?;
        let agent =
            existing.ok_or_else(|| AppError::NotFound(format!("Agent does not exist: {}", id)))?;

        // 合并更新 - 空字符串表示清除字段
        let new_name = update.name.unwrap_or(agent.name);
        // 对于可选字段，空字符串表示"清除"，Some非空值表示"设置"，None表示"保持原值"
        let new_avatar_color = match &update.avatar_color {
            Some(s) if s.is_empty() => None,
            Some(s) => Some(s.clone()),
            None => agent.avatar_color,
        };
        let new_avatar = match &update.avatar {
            Some(s) if s.is_empty() => None, // 空字符串清除头像
            Some(s) => Some(s.clone()),
            None => agent.avatar,
        };
        let new_model_provider = match &update.model_provider {
            Some(s) if s.is_empty() => None,
            Some(s) => Some(s.clone()),
            None => agent.model_provider,
        };
        let new_model_name = match &update.model_name {
            Some(s) if s.is_empty() => None,
            Some(s) => Some(s.clone()),
            None => agent.model_name,
        };
        let new_reasoning_preset = match &update.reasoning_preset {
            Some(s) if s.is_empty() => None,
            Some(s) if is_valid_reasoning_preset(s) => Some(s.clone()),
            Some(_) => agent.reasoning_preset,
            None => agent.reasoning_preset,
        };
        let new_mb_rules_file_path = match &update.mb_rules_file_path {
            Some(s) if s.is_empty() => None, // 空字符串清除 MB rules
            Some(s) => Some(s.clone()),
            None => agent.mb_rules_file_path,
        };
        let new_sa_rules_file_path = match &update.sa_rules_file_path {
            Some(s) if s.is_empty() => None, // 空字符串清除 SA rules
            Some(s) => Some(s.clone()),
            None => agent.sa_rules_file_path,
        };
        let new_mb_rules = match &update.mb_rules {
            Some(s) if s.trim().is_empty() => None, // 空白字符串清除 MB rules 文本
            Some(s) => Some(s.clone()),
            None => agent.mb_rules,
        };
        let new_sa_rules = match &update.sa_rules {
            Some(s) if s.trim().is_empty() => None, // 空白字符串清除 SA rules 文本
            Some(s) => Some(s.clone()),
            None => agent.sa_rules,
        };
        let new_chat_rules = match &update.chat_rules {
            Some(s) if s.trim().is_empty() => None, // 空白字符串清除 Chat rules 文本
            Some(s) => Some(s.clone()),
            None => agent.chat_rules,
        };
        let new_knowledge_paths = match &update.knowledge_paths {
            Some(s) if s.is_empty() => None, // 空字符串清除知识库路径
            Some(s) => Some(s.clone()),
            None => agent.knowledge_paths,
        };
        // auto_index_deliverables: Some(val) 设置, None 保持原值
        let new_auto_index = update
            .auto_index_deliverables
            .or(agent.auto_index_deliverables);
        let new_visual_enhancement_enabled = update
            .visual_enhancement_enabled
            .or(agent.visual_enhancement_enabled);
        // pinned_skills: 空字符串清除，Some 非空设置，None 保持原值
        let new_pinned_skills = match &update.pinned_skills {
            Some(s) if s.is_empty() => None, // 空字符串清除绑定技能
            Some(s) => Some(s.clone()),
            None => agent.pinned_skills,
        };
        // planning_loop_budget: 0 为哨兵值（重置为 NULL／全局默认），正整数设置值，None 保持原值
        let new_planning_loop_budget = match update.planning_loop_budget {
            Some(0) => None,                    // 0 是哨兵值，语义是“重置为全局默认”，存 NULL
            Some(v) => Some(v),                 // 正数直接存储
            None => agent.planning_loop_budget, // 未传则保持原值
        };
        // project_path: 空字符串清除（解除项目绑定），Some 非空设置新路径，None 保持原值
        let new_project_path = match &update.project_path {
            Some(s) if s.is_empty() => None,
            Some(s) => Some(s.clone()),
            None => agent.project_path,
        };
        let new_sandbox_mode = match &update.sandbox_mode {
            Some(s)
                if matches!(
                    s.as_str(),
                    "LocalAudit" | "OfflineIsolated" | "ControlledNetwork"
                ) =>
            {
                Some(s.clone())
            }
            Some(_) => agent.sandbox_mode,
            None => agent.sandbox_mode,
        };
        let new_sub_agent_safety_footer_enabled = update
            .sub_agent_safety_footer_enabled
            .or(agent.sub_agent_safety_footer_enabled);
        let new_sub_agent_safety_footer_text = match &update.sub_agent_safety_footer_text {
            Some(s) if s.is_empty() => None,
            Some(s) => Some(s.clone()),
            None => agent.sub_agent_safety_footer_text,
        };

        sqlx::query(
            r#"
            UPDATE agents 
            SET name = ?, avatar_color = ?, avatar = ?, model_provider = ?, model_name = ?, reasoning_preset = ?,
                mb_rules_file_path = ?, sa_rules_file_path = ?, mb_rules = ?, sa_rules = ?, chat_rules = ?, knowledge_paths = ?, auto_index_deliverables = ?, visual_enhancement_enabled = ?, pinned_skills = ?, planning_loop_budget = ?, project_path = ?, sandbox_mode = ?, sub_agent_safety_footer_enabled = ?, sub_agent_safety_footer_text = ?, updated_at = ?
            WHERE id = ? AND deleted_at IS NULL
            "#,
        )
        .bind(&new_name)
        .bind(&new_avatar_color)
        .bind(&new_avatar)
        .bind(&new_model_provider)
        .bind(&new_model_name)
        .bind(&new_reasoning_preset)
        .bind(&new_mb_rules_file_path)
        .bind(&new_sa_rules_file_path)
        .bind(&new_mb_rules)
        .bind(&new_sa_rules)
        .bind(&new_chat_rules)
        .bind(&new_knowledge_paths)
        .bind(new_auto_index)
        .bind(new_visual_enhancement_enabled)
        .bind(&new_pinned_skills)
        .bind(new_planning_loop_budget)
        .bind(&new_project_path)
        .bind(&new_sandbox_mode)
        .bind(new_sub_agent_safety_footer_enabled)
        .bind(&new_sub_agent_safety_footer_text)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        self.get(id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Agent does not exist: {}", id)))
    }

    /// 更新同一 Hub 下 Agent 的用户排序
    pub async fn reorder(&self, hub_id: &str, ordered_ids: &[String]) -> AppResult<()> {
        let now = Utc::now().timestamp_millis();
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| AppError::Database(format!("Failed to begin transaction: {}", e)))?;

        for (index, id) in ordered_ids.iter().enumerate() {
            let result = sqlx::query(
                r#"
                UPDATE agents
                SET sort_order = ?, updated_at = ?
                WHERE id = ? AND hub_id = ? AND deleted_at IS NULL
                "#,
            )
            .bind(index as i64)
            .bind(now)
            .bind(id)
            .bind(hub_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Database(format!("Failed to reorder agent: {}", e)))?;

            if result.rows_affected() == 0 {
                return Err(AppError::NotFound(format!(
                    "Agent does not exist in hub: {}",
                    id
                )));
            }
        }

        tx.commit()
            .await
            .map_err(|e| AppError::Database(format!("Failed to commit transaction: {}", e)))?;

        Ok(())
    }

    /// 级联删除 Agent 及其所有关联数据
    pub async fn cascade_delete(&self, id: &str) -> AppResult<()> {
        // 先验证 Agent 存在
        let existing: Option<Agent> = sqlx::query_as(
            "SELECT id, hub_id, name, COALESCE(sort_order, 0) AS sort_order, avatar_color, avatar, model_provider, model_name, reasoning_preset, \
                    mb_rules_file_path, sa_rules_file_path, mb_rules, sa_rules, chat_rules, knowledge_paths, auto_index_deliverables, visual_enhancement_enabled, pinned_skills, planning_loop_budget, project_path, sandbox_mode, sub_agent_safety_footer_enabled, sub_agent_safety_footer_text, created_at, updated_at, deleted_at \
             FROM agents WHERE id = ?"
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        if existing.is_none() {
            return Err(AppError::NotFound(format!("Agent does not exist: {}", id)));
        }

        // 使用事务确保所有关联数据原子性删除
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| AppError::Database(format!("Failed to begin transaction: {}", e)))?;

        // 1. 删除 diff_records（context_id 可能是 agent_id）
        sqlx::query("DELETE FROM diff_records WHERE context_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Database(format!("Failed to delete diff_records: {}", e)))?;

        // 2. 删除 chunk_embeddings（知识库向量）
        sqlx::query("DELETE FROM chunk_embeddings WHERE agent_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Database(format!("Failed to delete chunk_embeddings: {}", e)))?;

        // 3. 删除 vector_metadata（旧向量表）
        sqlx::query("DELETE FROM vector_metadata WHERE agent_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Database(format!("Failed to delete vector_metadata: {}", e)))?;

        // 4. 删除 memory_candidates（候选事实）
        sqlx::query("DELETE FROM memory_candidates WHERE agent_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| {
                AppError::Database(format!("Failed to delete memory_candidates: {}", e))
            })?;

        // 5. 删除 memory_trigger_state（触发器状态）
        sqlx::query("DELETE FROM memory_trigger_state WHERE agent_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| {
                AppError::Database(format!("Failed to delete memory_trigger_state: {}", e))
            })?;

        // 6. 删除 memories（三层记忆：短期/摘要/事实）
        sqlx::query("DELETE FROM memories WHERE agent_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Database(format!("Failed to delete memories: {}", e)))?;

        // 7. 删除 messages（聊天消息）
        sqlx::query("DELETE FROM messages WHERE agent_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Database(format!("Failed to delete messages: {}", e)))?;

        // 8. 删除 files（文件元数据）
        sqlx::query("DELETE FROM files WHERE agent_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Database(format!("Failed to delete files: {}", e)))?;

        // 9. 删除 cron_jobs（定时任务）
        sqlx::query("DELETE FROM cron_jobs WHERE agent_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Database(format!("Failed to delete cron_jobs: {}", e)))?;

        // 10. 删除 Agent 自身
        sqlx::query("DELETE FROM agents WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Database(format!("Failed to delete agent: {}", e)))?;

        // 提交事务
        tx.commit()
            .await
            .map_err(|e| AppError::Database(format!("Failed to commit transaction: {}", e)))?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::hub_repo::HubRepository;
    use crate::db::schema::{create_pool, initialize_schema};

    async fn setup_test_db() -> (HubRepository, AgentRepository) {
        let pool = create_pool("sqlite::memory:").await.unwrap();
        initialize_schema(&pool).await.unwrap();
        (HubRepository::new(pool.clone()), AgentRepository::new(pool))
    }

    #[tokio::test]
    async fn test_create_agent() {
        let (hub_repo, agent_repo) = setup_test_db().await;

        let hub = hub_repo.create("测试 Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "测试 Agent").await.unwrap();

        assert!(!agent.id.is_empty());
        assert_eq!(agent.hub_id, hub.id);
        assert_eq!(agent.name, "测试 Agent");
    }

    #[tokio::test]
    async fn test_list_by_hub() {
        let (hub_repo, agent_repo) = setup_test_db().await;

        let hub1 = hub_repo.create("Hub 1").await.unwrap();
        let hub2 = hub_repo.create("Hub 2").await.unwrap();

        agent_repo.create(&hub1.id, "Agent 1-1").await.unwrap();
        agent_repo.create(&hub1.id, "Agent 1-2").await.unwrap();
        agent_repo.create(&hub2.id, "Agent 2-1").await.unwrap();

        let agents_hub1 = agent_repo.list_by_hub(&hub1.id).await.unwrap();
        let agents_hub2 = agent_repo.list_by_hub(&hub2.id).await.unwrap();

        assert_eq!(agents_hub1.len(), 2);
        assert_eq!(agents_hub2.len(), 1);
    }

    #[tokio::test]
    async fn test_update_agent() {
        let (hub_repo, agent_repo) = setup_test_db().await;

        let hub = hub_repo.create("测试 Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "原名称").await.unwrap();

        let updated = agent_repo
            .update(
                &agent.id,
                AgentUpdate {
                    name: Some("新名称".to_string()),
                    model_provider: Some("openai".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        assert_eq!(updated.name, "新名称");
        assert_eq!(updated.model_provider, Some("openai".to_string()));
    }

    #[tokio::test]
    async fn test_update_agent_reasoning_preset() {
        let (hub_repo, agent_repo) = setup_test_db().await;

        let hub = hub_repo.create("测试 Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "推理 Agent").await.unwrap();
        assert_eq!(agent.reasoning_preset, None);

        let updated = agent_repo
            .update(
                &agent.id,
                AgentUpdate {
                    reasoning_preset: Some("high".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.reasoning_preset.as_deref(), Some("high"));

        let unchanged = agent_repo
            .update(
                &agent.id,
                AgentUpdate {
                    reasoning_preset: Some("invalid".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(unchanged.reasoning_preset.as_deref(), Some("high"));

        let cleared = agent_repo
            .update(
                &agent.id,
                AgentUpdate {
                    reasoning_preset: Some(String::new()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(cleared.reasoning_preset, None);
    }

    #[tokio::test]
    async fn test_cascade_delete_agent() {
        let (hub_repo, agent_repo) = setup_test_db().await;

        let hub = hub_repo.create("测试 Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "待删除").await.unwrap();

        agent_repo.cascade_delete(&agent.id).await.unwrap();

        // Agent 应已被彻底删除（get 也查不到）
        let agents = agent_repo.list_by_hub(&hub.id).await.unwrap();
        assert!(agents.is_empty());

        let fetched = agent_repo.get(&agent.id).await.unwrap();
        assert!(fetched.is_none(), "级联删除后 Agent 不应存在");
    }

    #[tokio::test]
    async fn test_cascade_delete_cleans_related_data() {
        // 构建完整测试环境：Agent + 消息 + 记忆 + 向量
        let pool = create_pool("sqlite::memory:").await.unwrap();
        initialize_schema(&pool).await.unwrap();

        let hub_repo = HubRepository::new(pool.clone());
        let agent_repo = AgentRepository::new(pool.clone());

        let hub = hub_repo.create("测试 Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "关联数据 Agent").await.unwrap();

        // 插入消息
        sqlx::query(
            "INSERT INTO messages (id, agent_id, role, content, created_at) VALUES ('msg-1', ?, 'user', '你好', 1000)"
        )
        .bind(&agent.id)
        .execute(&pool)
        .await
        .unwrap();

        // 插入记忆
        sqlx::query(
            "INSERT INTO memories (id, agent_id, layer, content, created_at, updated_at) VALUES ('mem-1', ?, 'fact', '事实', 1000, 1000)"
        )
        .bind(&agent.id)
        .execute(&pool)
        .await
        .unwrap();

        // 插入候选事实
        sqlx::query(
            "INSERT INTO memory_candidates (id, agent_id, content, category, first_seen_at, last_seen_at) VALUES ('mc-1', ?, '候选', 'TEST', 1000, 1000)"
        )
        .bind(&agent.id)
        .execute(&pool)
        .await
        .unwrap();

        // 插入触发器状态
        sqlx::query(
            "INSERT INTO memory_trigger_state (agent_id, turns_since_last_extract, candidate_signal_score, last_extract_turn, updated_at) VALUES (?, 5, 1.0, 3, 1000)"
        )
        .bind(&agent.id)
        .execute(&pool)
        .await
        .unwrap();

        // 执行级联删除
        agent_repo.cascade_delete(&agent.id).await.unwrap();

        // 验证所有关联数据已清空
        let msg_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM messages WHERE agent_id = ?")
            .bind(&agent.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(msg_count.0, 0, "消息应已被删除");

        let mem_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM memories WHERE agent_id = ?")
            .bind(&agent.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(mem_count.0, 0, "记忆应已被删除");

        let mc_count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM memory_candidates WHERE agent_id = ?")
                .bind(&agent.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(mc_count.0, 0, "候选事实应已被删除");

        let ts_count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM memory_trigger_state WHERE agent_id = ?")
                .bind(&agent.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(ts_count.0, 0, "触发器状态应已被删除");
    }
}
