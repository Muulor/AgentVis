//! Memory Trigger State Repository
//!
//! 持久化触发器状态的数据访问层 (混合触发模型)

use chrono::Utc;
use sqlx::{Pool, Sqlite};
use crate::db::models::{MemoryTriggerState, MemoryTriggerStateUpdate};

/// Memory Trigger State Repository
pub struct MemoryTriggerRepository {
    pool: Pool<Sqlite>,
}

impl MemoryTriggerRepository {
    /// 创建新的 Repository 实例
    pub fn new(pool: Pool<Sqlite>) -> Self {
        Self { pool }
    }

    /// 获取指定 Agent 的触发器状态
    /// 
    /// 如果不存在则返回 None
    pub async fn get(&self, agent_id: &str) -> Result<Option<MemoryTriggerState>, sqlx::Error> {
        sqlx::query_as::<_, MemoryTriggerState>(
            "SELECT agent_id, turns_since_last_extract, candidate_signal_score, last_extract_turn, last_processed_message_id, updated_at 
             FROM memory_trigger_state WHERE agent_id = ?"
        )
        .bind(agent_id)
        .fetch_optional(&self.pool)
        .await
    }

    /// 获取或创建触发器状态
    /// 
    /// 如果不存在则创建初始状态
    pub async fn get_or_create(&self, agent_id: &str) -> Result<MemoryTriggerState, sqlx::Error> {
        // 先尝试获取
        if let Some(state) = self.get(agent_id).await? {
            return Ok(state);
        }

        // 不存在则创建
        let state = MemoryTriggerState::new(agent_id);
        sqlx::query(
            "INSERT INTO memory_trigger_state (agent_id, turns_since_last_extract, candidate_signal_score, last_extract_turn, last_processed_message_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind(&state.agent_id)
        .bind(state.turns_since_last_extract)
        .bind(state.candidate_signal_score)
        .bind(state.last_extract_turn)
        .bind(&state.last_processed_message_id)
        .bind(state.updated_at)
        .execute(&self.pool)
        .await?;

        Ok(state)
    }

    /// 更新触发器状态（增量更新，仅更新非 None 字段）
    pub async fn update(&self, agent_id: &str, update: MemoryTriggerStateUpdate) -> Result<MemoryTriggerState, sqlx::Error> {
        // 确保存在
        let current = self.get_or_create(agent_id).await?;
        let now = Utc::now().timestamp_millis();

        // 合并更新
        let new_turns = update.turns_since_last_extract.unwrap_or(current.turns_since_last_extract);
        let new_score = update.candidate_signal_score.unwrap_or(current.candidate_signal_score);
        let new_last_turn = update.last_extract_turn.unwrap_or(current.last_extract_turn);

        sqlx::query(
            "UPDATE memory_trigger_state 
             SET turns_since_last_extract = ?, candidate_signal_score = ?, last_extract_turn = ?, updated_at = ?
             WHERE agent_id = ?"
        )
        .bind(new_turns)
        .bind(new_score)
        .bind(new_last_turn)
        .bind(now)
        .bind(agent_id)
        .execute(&self.pool)
        .await?;

        Ok(MemoryTriggerState {
            agent_id: agent_id.to_string(),
            turns_since_last_extract: new_turns,
            candidate_signal_score: new_score,
            last_extract_turn: new_last_turn,
            last_processed_message_id: current.last_processed_message_id.clone(),
            updated_at: now,
        })
    }

    /// 更新上次处理的消息 ID（用于生命周期触发内容变化检测）
    pub async fn update_last_processed_message(&self, agent_id: &str, message_id: &str) -> Result<(), sqlx::Error> {
        let now = Utc::now().timestamp_millis();
        
        // 确保状态存在
        self.get_or_create(agent_id).await?;
        
        sqlx::query(
            "UPDATE memory_trigger_state 
             SET last_processed_message_id = ?, updated_at = ?
             WHERE agent_id = ?"
        )
        .bind(message_id)
        .bind(now)
        .bind(agent_id)
        .execute(&self.pool)
        .await?;
        
        Ok(())
    }

    /// 自增轮次计数（常用操作）
    pub async fn increment_turn(&self, agent_id: &str) -> Result<MemoryTriggerState, sqlx::Error> {
        let current = self.get_or_create(agent_id).await?;
        self.update(agent_id, MemoryTriggerStateUpdate {
            turns_since_last_extract: Some(current.turns_since_last_extract + 1),
            candidate_signal_score: None,
            last_extract_turn: None,
        }).await
    }

    /// 累加信号分数（常用操作）
    pub async fn accumulate_score(&self, agent_id: &str, delta: f64) -> Result<MemoryTriggerState, sqlx::Error> {
        let current = self.get_or_create(agent_id).await?;
        self.update(agent_id, MemoryTriggerStateUpdate {
            turns_since_last_extract: None,
            candidate_signal_score: Some(current.candidate_signal_score + delta),
            last_extract_turn: None,
        }).await
    }

    /// 提取后重置状态
    /// 
    /// 重置 turns_since_last_extract 和 candidate_signal_score，更新 last_extract_turn
    pub async fn reset_after_extract(&self, agent_id: &str, current_turn: i64) -> Result<MemoryTriggerState, sqlx::Error> {
        self.update(agent_id, MemoryTriggerStateUpdate {
            turns_since_last_extract: Some(0),
            candidate_signal_score: Some(0.0),
            last_extract_turn: Some(current_turn),
        }).await
    }

    /// 删除触发器状态（用于 Agent 删除时清理）
    pub async fn delete(&self, agent_id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM memory_trigger_state WHERE agent_id = ?")
            .bind(agent_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}
