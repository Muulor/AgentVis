//! Message 数据访问层
//!
//! 提供消息实体的 CRUD 操作

use chrono::Utc;
use sqlx::{Pool, QueryBuilder, Sqlite};

use super::models::{Message, MessageRole};
use crate::error::{AppError, AppResult};

/// Message Repository - 管理消息数据访问
pub struct MessageRepository {
    pool: Pool<Sqlite>,
}

fn escape_like_pattern(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());

    for ch in value.chars() {
        match ch {
            '%' | '_' | '\\' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            _ => escaped.push(ch),
        }
    }

    escaped
}

impl MessageRepository {
    /// 创建新的 MessageRepository 实例
    pub fn new(pool: Pool<Sqlite>) -> Self {
        Self { pool }
    }

    /// 创建新的消息
    /// 
    /// # Arguments
    /// * `agent_id` - 所属 Agent ID
    /// * `role` - 消息角色
    /// * `content` - 消息内容
    /// * `metadata` - 元数据（JSON 字符串，可选）
    /// 
    /// # Returns
    /// 创建成功的 Message 实体
    pub async fn create(
        &self, 
        agent_id: &str, 
        role: MessageRole, 
        content: &str,
        metadata: Option<String>,
    ) -> AppResult<Message> {
        let message = Message::with_metadata(agent_id, role, content, metadata);
        
        sqlx::query(
            r#"
            INSERT INTO messages (id, agent_id, role, content, metadata, created_at, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&message.id)
        .bind(&message.agent_id)
        .bind(&message.role)
        .bind(&message.content)
        .bind(&message.metadata)
        .bind(message.created_at)
        .bind(message.deleted_at)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(message)
    }

    /// 更新消息内容和元数据。
    ///
    /// 用于长任务运行中的 checkpoint 草稿消息：任务开始时先创建 assistant
    /// 占位记录，过程中持续更新 metadata，完成时覆盖为最终 assistant 回复。
    pub async fn update_content_metadata(
        &self,
        id: &str,
        content: &str,
        metadata: Option<String>,
        created_at: Option<i64>,
    ) -> AppResult<Message> {
        let result = sqlx::query(
            r#"
            UPDATE messages
            SET content = ?, metadata = ?, created_at = COALESCE(?, created_at)
            WHERE id = ? AND deleted_at IS NULL
            "#,
        )
        .bind(content)
        .bind(metadata)
        .bind(created_at)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(AppError::NotFound(format!("message {}", id)));
        }

        self.get(id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("message {}", id)))
    }

    /// 根据 ID 获取消息
    pub async fn get(&self, id: &str) -> AppResult<Option<Message>> {
        let message: Option<Message> = sqlx::query_as(
            r#"
            SELECT id, agent_id, role, content, metadata, created_at, deleted_at
            FROM messages
            WHERE id = ? AND deleted_at IS NULL
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(message)
    }

    /// 获取指定 Agent 的消息列表
    /// 
    /// # Arguments
    /// * `agent_id` - Agent ID
    /// * `limit` - 最多返回条数
    /// * `offset` - 偏移量
    /// 
    /// # Returns
    /// 消息列表，按创建时间升序排列 (最早的在前)
    pub async fn list_by_agent(
        &self, 
        agent_id: &str, 
        limit: i64, 
        offset: i64
    ) -> AppResult<Vec<Message>> {
        let messages: Vec<Message> = sqlx::query_as(
            r#"
            SELECT id, agent_id, role, content, metadata, created_at, deleted_at
            FROM messages
            WHERE agent_id = ? AND deleted_at IS NULL
            ORDER BY created_at ASC, id ASC
            LIMIT ? OFFSET ?
            "#,
        )
        .bind(agent_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(messages)
    }

    /// Search messages for a single Agent only.
    pub async fn search_by_agent(
        &self,
        agent_id: &str,
        query: &str,
        roles: &[String],
        limit: i64,
        offset: i64,
        start_ts: Option<i64>,
        end_ts: Option<i64>,
    ) -> AppResult<Vec<Message>> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(vec![]);
        }

        let mut normalized_roles: Vec<&str> = roles
            .iter()
            .map(|role| role.as_str())
            .filter(|role| matches!(*role, "user" | "assistant"))
            .collect();

        if normalized_roles.is_empty() {
            normalized_roles.push("user");
            normalized_roles.push("assistant");
        }

        let pattern = format!("%{}%", escape_like_pattern(query));
        let limit = limit.clamp(1, 100);
        let offset = offset.max(0);

        let mut builder = QueryBuilder::<Sqlite>::new(
            "SELECT id, agent_id, role, content, metadata, created_at, deleted_at \
             FROM messages \
             WHERE agent_id = ",
        );
        builder.push_bind(agent_id);
        builder.push(
            " AND deleted_at IS NULL AND LOWER(\
             CASE \
             WHEN role = 'assistant' AND metadata IS NOT NULL AND json_valid(metadata) \
             THEN COALESCE(json_extract(metadata, '$.persistContent'), content) \
             ELSE content \
             END\
             ) LIKE LOWER(",
        );
        builder.push_bind(pattern);
        builder.push(") ESCAPE '\\'");
        if let Some(start_ts) = start_ts {
            builder.push(" AND created_at >= ");
            builder.push_bind(start_ts);
        }
        if let Some(end_ts) = end_ts {
            builder.push(" AND created_at < ");
            builder.push_bind(end_ts);
        }
        builder.push(" AND role IN (");
        {
            let mut separated = builder.separated(", ");
            for role in normalized_roles {
                separated.push_bind(role);
            }
        }
        builder.push(") ORDER BY created_at DESC, id DESC LIMIT ");
        builder.push_bind(limit);
        builder.push(" OFFSET ");
        builder.push_bind(offset);

        let messages = builder
            .build_query_as::<Message>()
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(messages)
    }

    /// List messages for a single Agent by timeline.
    pub async fn timeline_by_agent(
        &self,
        agent_id: &str,
        roles: &[String],
        limit: i64,
        offset: i64,
        start_ts: Option<i64>,
        end_ts: Option<i64>,
        ascending: bool,
    ) -> AppResult<Vec<Message>> {
        let mut normalized_roles: Vec<&str> = roles
            .iter()
            .map(|role| role.as_str())
            .filter(|role| matches!(*role, "user" | "assistant"))
            .collect();

        if normalized_roles.is_empty() {
            normalized_roles.push("user");
            normalized_roles.push("assistant");
        }

        let limit = limit.clamp(1, 100);
        let offset = offset.max(0);

        let mut builder = QueryBuilder::<Sqlite>::new(
            "SELECT id, agent_id, role, content, metadata, created_at, deleted_at \
             FROM messages \
             WHERE agent_id = ",
        );
        builder.push_bind(agent_id);
        builder.push(" AND deleted_at IS NULL");
        if let Some(start_ts) = start_ts {
            builder.push(" AND created_at >= ");
            builder.push_bind(start_ts);
        }
        if let Some(end_ts) = end_ts {
            builder.push(" AND created_at < ");
            builder.push_bind(end_ts);
        }
        builder.push(" AND role IN (");
        {
            let mut separated = builder.separated(", ");
            for role in normalized_roles {
                separated.push_bind(role);
            }
        }
        if ascending {
            builder.push(") ORDER BY created_at ASC, id ASC LIMIT ");
        } else {
            builder.push(") ORDER BY created_at DESC, id DESC LIMIT ");
        }
        builder.push_bind(limit);
        builder.push(" OFFSET ");
        builder.push_bind(offset);

        let messages = builder
            .build_query_as::<Message>()
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(messages)
    }

    /// 获取指定 Agent 最近的 N 条消息
    /// 
    /// # Arguments
    /// * `agent_id` - Agent ID
    /// * `count` - 返回条数
    /// 
    /// # Returns
    /// 消息列表，按创建时间升序排列
    pub async fn get_recent(&self, agent_id: &str, count: i64) -> AppResult<Vec<Message>> {
        // 使用子查询获取最近的 N 条，然后按时间正序排列
        let messages: Vec<Message> = sqlx::query_as(
            r#"
            SELECT id, agent_id, role, content, metadata, created_at, deleted_at
            FROM (
                SELECT id, agent_id, role, content, metadata, created_at, deleted_at
                FROM messages
                WHERE agent_id = ? AND deleted_at IS NULL
                ORDER BY created_at DESC, id DESC
                LIMIT ?
            )
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .bind(agent_id)
        .bind(count)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(messages)
    }

    /// 获取指定消息 ID 之后的所有消息（增量加载）
    /// 
    /// # Arguments
    /// * `agent_id` - Agent ID
    /// * `after_message_id` - 起始消息 ID（不包含）
    /// * `limit` - 最大返回数量
    /// 
    /// # Returns
    /// 消息列表，按创建时间升序排列
    pub async fn get_after(&self, agent_id: &str, after_message_id: &str, limit: i64) -> AppResult<Vec<Message>> {
        // 先获取起始消息的创建时间
        let after_message = self.get(after_message_id).await?;
        
        let messages: Vec<Message> = if let Some(msg) = after_message {
            sqlx::query_as(
                r#"
                SELECT id, agent_id, role, content, metadata, created_at, deleted_at
                FROM messages
                WHERE agent_id = ? 
                  AND deleted_at IS NULL
                  AND (created_at > ? OR (created_at = ? AND id > ?))
                ORDER BY created_at ASC, id ASC
                LIMIT ?
                "#,
            )
            .bind(agent_id)
            .bind(msg.created_at)
            .bind(msg.created_at)
            .bind(after_message_id)
            .bind(limit)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AppError::Database(e.to_string()))?
        } else {
            // 如果起始Message does not exist（可能已被删除），返回空列表
            vec![]
        };

        Ok(messages)
    }

    /// 获取指定消息 ID 之前的 N 条消息（向前分页，用于"加载更多"）
    ///
    /// # Arguments
    /// * `agent_id` - Agent ID
    /// * `before_message_id` - 边界消息 ID（不包含）
    /// * `count` - 最大返回数量
    ///
    /// # Returns
    /// 消息列表，按创建时间升序排列（最早在前）
    pub async fn get_before(&self, agent_id: &str, before_message_id: &str, count: i64) -> AppResult<Vec<Message>> {
        // 先获取边界消息的创建时间
        let before_message = self.get(before_message_id).await?;

        let messages: Vec<Message> = if let Some(msg) = before_message {
            // 子查询获取 before 消息之前的最近 N 条，再翻转为正序
            sqlx::query_as(
                r#"
                SELECT id, agent_id, role, content, metadata, created_at, deleted_at
                FROM (
                    SELECT id, agent_id, role, content, metadata, created_at, deleted_at
                    FROM messages
                    WHERE agent_id = ?
                      AND deleted_at IS NULL
                      AND (created_at < ? OR (created_at = ? AND id < ?))
                    ORDER BY created_at DESC, id DESC
                    LIMIT ?
                )
                ORDER BY created_at ASC, id ASC
                "#,
            )
            .bind(agent_id)
            .bind(msg.created_at)
            .bind(msg.created_at)
            .bind(before_message_id)
            .bind(count)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AppError::Database(e.to_string()))?
        } else {
            // 边界Message does not exist（可能已被删除），返回空列表
            vec![]
        };

        Ok(messages)
    }

    /// 获取指定 Agent 的消息总数

    pub async fn count_by_agent(&self, agent_id: &str) -> AppResult<i64> {
        let count: (i64,) = sqlx::query_as(
            r#"
            SELECT COUNT(*) FROM messages
            WHERE agent_id = ? AND deleted_at IS NULL
            "#,
        )
        .bind(agent_id)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(count.0)
    }

    /// 根据 ID 列表批量获取消息
    /// 
    /// # Arguments
    /// * `ids` - 消息 ID 列表
    /// 
    /// # Returns
    /// 消息列表（顺序可能与输入不同）
    pub async fn get_by_ids(&self, ids: &[String]) -> AppResult<Vec<Message>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        
        // 构建占位符 (?, ?, ...)
        let placeholders: Vec<&str> = ids.iter().map(|_| "?").collect();
        let placeholders_str = placeholders.join(", ");
        
        let query = format!(
            r#"
            SELECT id, agent_id, role, content, metadata, created_at, deleted_at
            FROM messages
            WHERE id IN ({}) AND deleted_at IS NULL
            ORDER BY created_at ASC
            "#,
            placeholders_str
        );
        
        let mut query_builder = sqlx::query_as::<_, Message>(&query);
        for id in ids {
            query_builder = query_builder.bind(id);
        }
        
        let messages = query_builder
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AppError::Database(e.to_string()))?;
        
        Ok(messages)
    }

    /// Get messages by IDs, scoped to one Agent only.
    pub async fn get_by_ids_for_agent(
        &self,
        agent_id: &str,
        ids: &[String],
    ) -> AppResult<Vec<Message>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }

        let mut builder = QueryBuilder::<Sqlite>::new(
            "SELECT id, agent_id, role, content, metadata, created_at, deleted_at \
             FROM messages \
             WHERE agent_id = ",
        );
        builder.push_bind(agent_id);
        builder.push(" AND deleted_at IS NULL AND id IN (");
        {
            let mut separated = builder.separated(", ");
            for id in ids {
                separated.push_bind(id);
            }
        }
        builder.push(")");

        let mut messages = builder
            .build_query_as::<Message>()
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AppError::Database(e.to_string()))?;

        messages.sort_by_key(|message| {
            ids.iter()
                .position(|id| id == &message.id)
                .unwrap_or(usize::MAX)
        });

        Ok(messages)
    }

    /// 软删除消息
    pub async fn soft_delete(&self, id: &str) -> AppResult<()> {
        let now = Utc::now().timestamp_millis();
        
        let result = sqlx::query(
            r#"
            UPDATE messages 
            SET deleted_at = ?
            WHERE id = ? AND deleted_at IS NULL
            "#,
        )
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(AppError::NotFound(format!("Message does not exist or has been deleted: {}", id)));
        }

        Ok(())
    }

    /// List message ids from the given message onward for an agent.
    pub async fn list_ids_from(&self, id: &str, agent_id: &str) -> AppResult<Vec<String>> {
        let message = self.get(id).await?;
        let message = message.ok_or_else(|| AppError::NotFound(format!("Message not found: {}", id)))?;

        if message.agent_id != agent_id {
            return Err(AppError::Forbidden("Message does not belong to the specified agent".to_string()));
        }

        let rows: Vec<(String,)> = sqlx::query_as(
            r#"
            SELECT id
            FROM messages
            WHERE agent_id = ? AND created_at >= ? AND deleted_at IS NULL
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .bind(agent_id)
        .bind(message.created_at)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(rows.into_iter().map(|row| row.0).collect())
    }

    /// 删除指定消息及其之后的所有消息 (撤回功能)
    ///
    /// # Arguments
    /// * `id` - 起始消息 ID (包含)
    /// * `agent_id` - Agent ID (用于安全验证)
    ///
    /// # Returns
    /// 删除的消息数量
    pub async fn retract_from(&self, id: &str, agent_id: &str) -> AppResult<u64> {
        let now = Utc::now().timestamp_millis();
        
        // 获取起始消息的创建时间
        let message = self.get(id).await?;
        let message = message.ok_or_else(|| AppError::NotFound(format!("Message does not exist: {}", id)))?;
        
        if message.agent_id != agent_id {
            return Err(AppError::Forbidden("Message does not belong to the specified Agent".to_string()));
        }
        
        let result = sqlx::query(
            r#"
            UPDATE messages 
            SET deleted_at = ?
            WHERE agent_id = ? AND created_at >= ? AND deleted_at IS NULL
            "#,
        )
        .bind(now)
        .bind(agent_id)
        .bind(message.created_at)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(result.rows_affected())
    }

    /// 获取指定 Hub 的所有消息（从 metadata.hubId 过滤）
    ///
    /// Hub 消息分两类存储：
    /// 1. 无 @提及时：agent_id = hub_id
    /// 2. 有 @提及时：agent_id = mentioned_agent_id，metadata.hubId = hub_id
    ///
    /// 此方法合并两类查询，并按时间升序排列。
    ///
    /// # Arguments
    /// * `hub_id` - Hub ID
    /// * `limit` - 最多返回条数
    ///
    /// # Returns
    /// 按创建时间升序排列的消息列表
    pub async fn list_by_hub_id(
        &self,
        hub_id: &str,
        limit: i64,
    ) -> AppResult<Vec<Message>> {
        // 使用 UNION ALL 合并两类 Hub 消息：
        // - 类型1：直接以 hub_id 为 agent_id 存储（无 @提及）
        // - 类型2：metadata 中 hubId 字段等于 hub_id（有 @提及，存在对应 Agent 下）
        // 使用 json_extract 读取 JSON metadata 中的 hubId 字段，效率高于 LIKE 模糊匹配
        let messages: Vec<Message> = sqlx::query_as(
            r#"
            SELECT id, agent_id, role, content, metadata, created_at, deleted_at
            FROM (
                SELECT id, agent_id, role, content, metadata, created_at, deleted_at
                FROM messages
                WHERE agent_id = ? AND deleted_at IS NULL

                UNION ALL

                SELECT id, agent_id, role, content, metadata, created_at, deleted_at
                FROM messages
                WHERE json_extract(metadata, '$.hubId') = ?
                  AND agent_id != ?
                  AND deleted_at IS NULL
            )
            ORDER BY created_at ASC, id ASC
            LIMIT ?
            "#,
        )
        .bind(hub_id)
        .bind(hub_id)
        .bind(hub_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(messages)
    }

    /// 获取指定 Hub 最近 N 条消息（合并双源，用于初始加载）
    ///
    /// 与 get_recent 类似，使用 DESC 子查询取最新的 N 条再翻转为 ASC
    pub async fn get_recent_by_hub_id(&self, hub_id: &str, count: i64) -> AppResult<Vec<Message>> {
        let messages: Vec<Message> = sqlx::query_as(
            r#"
            SELECT id, agent_id, role, content, metadata, created_at, deleted_at
            FROM (
                SELECT id, agent_id, role, content, metadata, created_at, deleted_at
                FROM (
                    SELECT id, agent_id, role, content, metadata, created_at, deleted_at
                    FROM messages
                    WHERE agent_id = ? AND deleted_at IS NULL

                    UNION ALL

                    SELECT id, agent_id, role, content, metadata, created_at, deleted_at
                    FROM messages
                    WHERE json_extract(metadata, '$.hubId') = ?
                      AND agent_id != ?
                      AND deleted_at IS NULL
                )
                ORDER BY created_at DESC, id DESC
                LIMIT ?
            )
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .bind(hub_id)
        .bind(hub_id)
        .bind(hub_id)
        .bind(count)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(messages)
    }

    /// 获取指定 Hub 中某消息之前的 N 条消息（向前分页，"加载更多"用）
    pub async fn get_before_by_hub_id(
        &self,
        hub_id: &str,
        before_message_id: &str,
        count: i64,
    ) -> AppResult<Vec<Message>> {
        let before_message = self.get(before_message_id).await?;

        let messages: Vec<Message> = if let Some(msg) = before_message {
            sqlx::query_as(
                r#"
                SELECT id, agent_id, role, content, metadata, created_at, deleted_at
                FROM (
                    SELECT id, agent_id, role, content, metadata, created_at, deleted_at
                    FROM (
                        SELECT id, agent_id, role, content, metadata, created_at, deleted_at
                        FROM messages
                        WHERE agent_id = ? AND deleted_at IS NULL

                        UNION ALL

                        SELECT id, agent_id, role, content, metadata, created_at, deleted_at
                        FROM messages
                        WHERE json_extract(metadata, '$.hubId') = ?
                          AND agent_id != ?
                          AND deleted_at IS NULL
                    )
                    WHERE (created_at < ? OR (created_at = ? AND id < ?))
                    ORDER BY created_at DESC, id DESC
                    LIMIT ?
                )
                ORDER BY created_at ASC, id ASC
                "#,
            )
            .bind(hub_id)
            .bind(hub_id)
            .bind(hub_id)
            .bind(msg.created_at)
            .bind(msg.created_at)
            .bind(before_message_id)
            .bind(count)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AppError::Database(e.to_string()))?
        } else {
            vec![]
        };

        Ok(messages)
    }

    /// 获取指定 Hub 的消息总数（合并双源）
    pub async fn count_by_hub_id(&self, hub_id: &str) -> AppResult<i64> {
        let row: (i64,) = sqlx::query_as(
            r#"
            SELECT COUNT(*) FROM (
                SELECT id FROM messages
                WHERE agent_id = ? AND deleted_at IS NULL

                UNION ALL

                SELECT id FROM messages
                WHERE json_extract(metadata, '$.hubId') = ?
                  AND agent_id != ?
                  AND deleted_at IS NULL
            )
            "#,
        )
        .bind(hub_id)
        .bind(hub_id)
        .bind(hub_id)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(row.0)
    }

    /// 清空指定 Agent 的所有消息
    pub async fn clear_by_agent(&self, agent_id: &str) -> AppResult<u64> {
        let now = Utc::now().timestamp_millis();
        
        let result = sqlx::query(
            r#"
            UPDATE messages 
            SET deleted_at = ?
            WHERE agent_id = ? AND deleted_at IS NULL
            "#,
        )
        .bind(now)
        .bind(agent_id)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(result.rows_affected())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::agent_repo::AgentRepository;
    use crate::db::hub_repo::HubRepository;
    use crate::db::schema::{create_pool, initialize_schema};

    async fn setup_test_db() -> (HubRepository, AgentRepository, MessageRepository) {
        let pool = create_pool("sqlite::memory:").await.unwrap();
        initialize_schema(&pool).await.unwrap();
        (
            HubRepository::new(pool.clone()),
            AgentRepository::new(pool.clone()),
            MessageRepository::new(pool),
        )
    }

    #[tokio::test]
    async fn test_create_message() {
        let (hub_repo, agent_repo, msg_repo) = setup_test_db().await;
        
        let hub = hub_repo.create("测试 Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "测试 Agent").await.unwrap();
        
        let message = msg_repo.create(&agent.id, MessageRole::User, "你好", None).await.unwrap();
        
        assert!(!message.id.is_empty());
        assert_eq!(message.agent_id, agent.id);
        assert_eq!(message.role, "user");
        assert_eq!(message.content, "你好");
    }

    #[tokio::test]
    async fn test_list_messages() {
        let (hub_repo, agent_repo, msg_repo) = setup_test_db().await;
        
        let hub = hub_repo.create("测试 Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "测试 Agent").await.unwrap();
        
        msg_repo.create(&agent.id, MessageRole::User, "消息1", None).await.unwrap();
        msg_repo.create(&agent.id, MessageRole::Assistant, "消息2", None).await.unwrap();
        msg_repo.create(&agent.id, MessageRole::User, "消息3", None).await.unwrap();
        
        let messages = msg_repo.list_by_agent(&agent.id, 10, 0).await.unwrap();
        
        // 验证返回了 3 条消息
        assert_eq!(messages.len(), 3);
        
        // 验证所有消息内容都存在
        let contents: Vec<&str> = messages.iter().map(|m| m.content.as_str()).collect();
        assert!(contents.contains(&"消息1"));
        assert!(contents.contains(&"消息2"));
        assert!(contents.contains(&"消息3"));
    }

    #[tokio::test]
    async fn test_search_by_agent_scopes_to_agent_and_escapes_like() {
        let (hub_repo, agent_repo, msg_repo) = setup_test_db().await;

        let hub = hub_repo.create("测试 Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "测试 Agent").await.unwrap();
        let other_agent = agent_repo.create(&hub.id, "其他 Agent").await.unwrap();

        msg_repo
            .create(&agent.id, MessageRole::User, "Automation Lane 用户反馈", None)
            .await
            .unwrap();
        msg_repo
            .create(&agent.id, MessageRole::Assistant, "automation lane 修复记录", None)
            .await
            .unwrap();
        msg_repo
            .create(&agent.id, MessageRole::User, "100% literal marker", None)
            .await
            .unwrap();
        msg_repo
            .create(&agent.id, MessageRole::User, "100x wildcard decoy", None)
            .await
            .unwrap();
        let other_agent_message = msg_repo
            .create(&other_agent.id, MessageRole::User, "Automation Lane other agent", None)
            .await
            .unwrap();
        msg_repo
            .create(
                &agent.id,
                MessageRole::Assistant,
                "UI-only keyword from enhanced display",
                Some(r#"{"persistContent":"Persistent-only evidence from rationale"}"#.to_string()),
            )
            .await
            .unwrap();

        let all_matches = msg_repo
            .search_by_agent(&agent.id, "Automation Lane", &[], 10, 0, None, None)
            .await
            .unwrap();

        assert_eq!(all_matches.len(), 2);
        assert!(all_matches.iter().all(|message| message.agent_id == agent.id));

        let second_page = msg_repo
            .search_by_agent(&agent.id, "Automation Lane", &[], 1, 1, None, None)
            .await
            .unwrap();

        assert_eq!(second_page.len(), 1);
        assert_eq!(second_page[0].agent_id, agent.id);

        let user_matches = msg_repo
            .search_by_agent(&agent.id, "Automation Lane", &[String::from("user")], 10, 0, None, None)
            .await
            .unwrap();

        assert_eq!(user_matches.len(), 1);
        assert_eq!(user_matches[0].role, "user");

        let literal_percent_matches = msg_repo
            .search_by_agent(&agent.id, "100%", &[], 10, 0, None, None)
            .await
            .unwrap();

        assert_eq!(literal_percent_matches.len(), 1);
        assert_eq!(literal_percent_matches[0].content, "100% literal marker");

        let persisted_content_matches = msg_repo
            .search_by_agent(&agent.id, "Persistent-only", &[], 10, 0, None, None)
            .await
            .unwrap();

        assert_eq!(persisted_content_matches.len(), 1);
        assert_eq!(persisted_content_matches[0].role, "assistant");

        let ui_only_matches = msg_repo
            .search_by_agent(&agent.id, "UI-only", &[], 10, 0, None, None)
            .await
            .unwrap();

        assert!(ui_only_matches.is_empty());

        let scoped_full_messages = msg_repo
            .get_by_ids_for_agent(
                &agent.id,
                &[other_agent_message.id.clone(), all_matches[0].id.clone()],
            )
            .await
            .unwrap();

        assert_eq!(scoped_full_messages.len(), 1);
        assert_eq!(scoped_full_messages[0].agent_id, agent.id);
    }

    #[tokio::test]
    async fn test_timeline_by_agent_filters_roles_time_and_order() {
        let (hub_repo, agent_repo, msg_repo) = setup_test_db().await;

        let hub = hub_repo.create("测试 Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "测试 Agent").await.unwrap();
        let other_agent = agent_repo.create(&hub.id, "其他 Agent").await.unwrap();

        let first_user = msg_repo
            .create(&agent.id, MessageRole::User, "first user", None)
            .await
            .unwrap();
        let assistant = msg_repo
            .create(&agent.id, MessageRole::Assistant, "assistant", None)
            .await
            .unwrap();
        let second_user = msg_repo
            .create(&agent.id, MessageRole::User, "second user", None)
            .await
            .unwrap();
        let other_user = msg_repo
            .create(&other_agent.id, MessageRole::User, "other user", None)
            .await
            .unwrap();

        msg_repo
            .update_content_metadata(&first_user.id, &first_user.content, None, Some(1_000))
            .await
            .unwrap();
        msg_repo
            .update_content_metadata(&assistant.id, &assistant.content, None, Some(2_000))
            .await
            .unwrap();
        msg_repo
            .update_content_metadata(&second_user.id, &second_user.content, None, Some(3_000))
            .await
            .unwrap();
        msg_repo
            .update_content_metadata(&other_user.id, &other_user.content, None, Some(1_500))
            .await
            .unwrap();

        let asc_user_timeline = msg_repo
            .timeline_by_agent(
                &agent.id,
                &[String::from("user")],
                10,
                0,
                Some(1_000),
                Some(3_001),
                true,
            )
            .await
            .unwrap();

        assert_eq!(asc_user_timeline.len(), 2);
        assert_eq!(asc_user_timeline[0].id, first_user.id);
        assert_eq!(asc_user_timeline[1].id, second_user.id);
        assert!(asc_user_timeline.iter().all(|message| message.agent_id == agent.id));

        let desc_second_page = msg_repo
            .timeline_by_agent(
                &agent.id,
                &[String::from("user")],
                1,
                1,
                Some(1_000),
                Some(3_001),
                false,
            )
            .await
            .unwrap();

        assert_eq!(desc_second_page.len(), 1);
        assert_eq!(desc_second_page[0].id, first_user.id);

        let narrow_timeline = msg_repo
            .timeline_by_agent(&agent.id, &[], 10, 0, Some(1_500), Some(2_500), true)
            .await
            .unwrap();

        assert_eq!(narrow_timeline.len(), 1);
        assert_eq!(narrow_timeline[0].id, assistant.id);
    }


    #[tokio::test]
    async fn test_get_recent_messages() {
        let (hub_repo, agent_repo, msg_repo) = setup_test_db().await;
        
        let hub = hub_repo.create("测试 Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "测试 Agent").await.unwrap();
        
        for i in 1..=5 {
            msg_repo.create(&agent.id, MessageRole::User, &format!("消息{}", i), None).await.unwrap();
        }
        
        let recent = msg_repo.get_recent(&agent.id, 3).await.unwrap();
        
        // 验证返回了 3 条消息
        assert_eq!(recent.len(), 3);
        
        // 验证返回的消息确实是创建的消息之一
        let all_msgs = msg_repo.list_by_agent(&agent.id, 10, 0).await.unwrap();
        assert_eq!(all_msgs.len(), 5);
        
        // 验证 recent 中的消息都在 all_msgs 中
        for r in &recent {
            assert!(all_msgs.iter().any(|m| m.id == r.id));
        }
    }


    #[tokio::test]
    async fn test_retract_messages() {
        let (hub_repo, agent_repo, msg_repo) = setup_test_db().await;
        
        let hub = hub_repo.create("测试 Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "测试 Agent").await.unwrap();
        
        let msg1 = msg_repo.create(&agent.id, MessageRole::User, "消息1", None).await.unwrap();
        msg_repo.create(&agent.id, MessageRole::Assistant, "消息2", None).await.unwrap();
        msg_repo.create(&agent.id, MessageRole::User, "消息3", None).await.unwrap();
        
        // 验证创建了 3 条消息
        let all = msg_repo.list_by_agent(&agent.id, 10, 0).await.unwrap();
        assert_eq!(all.len(), 3);
        
        // 软删除第一条消息（单条删除验证）
        msg_repo.soft_delete(&msg1.id).await.unwrap();
        
        let remaining = msg_repo.list_by_agent(&agent.id, 10, 0).await.unwrap();
        assert_eq!(remaining.len(), 2);
        
        // 清空剩余消息
        let count = msg_repo.clear_by_agent(&agent.id).await.unwrap();
        assert_eq!(count, 2);
        
        let final_count = msg_repo.list_by_agent(&agent.id, 10, 0).await.unwrap();
        assert!(final_count.is_empty());
    }

}
