//! Memory Trigger Tauri Commands
//!
//! 提供前端调用的触发器状态管理命令 (混合触发模型)

use crate::db::{MemoryTriggerRepository, MemoryTriggerState, MemoryTriggerStateUpdate};
use crate::error::CommandResult;
use crate::AppState;
use tauri::State;

/// 获取触发器状态
#[tauri::command]
pub async fn memory_trigger_get(
    state: State<'_, AppState>,
    agent_id: String,
) -> CommandResult<Option<MemoryTriggerState>> {
    let db = state.db.lock().await;
    let repo = MemoryTriggerRepository::new(db.pool().clone());
    repo.get(&agent_id)
        .await
        .map_err(|e| crate::error::AppError::Database(e.to_string()))
}

/// 获取或创建触发器状态
#[tauri::command]
pub async fn memory_trigger_get_or_create(
    state: State<'_, AppState>,
    agent_id: String,
) -> CommandResult<MemoryTriggerState> {
    let db = state.db.lock().await;
    let repo = MemoryTriggerRepository::new(db.pool().clone());
    repo.get_or_create(&agent_id)
        .await
        .map_err(|e| crate::error::AppError::Database(e.to_string()))
}

/// 更新触发器状态
#[tauri::command]
pub async fn memory_trigger_update(
    state: State<'_, AppState>,
    agent_id: String,
    update: MemoryTriggerStateUpdate,
) -> CommandResult<MemoryTriggerState> {
    let db = state.db.lock().await;
    let repo = MemoryTriggerRepository::new(db.pool().clone());
    repo.update(&agent_id, update)
        .await
        .map_err(|e| crate::error::AppError::Database(e.to_string()))
}

/// 自增轮次计数
#[tauri::command]
pub async fn memory_trigger_increment_turn(
    state: State<'_, AppState>,
    agent_id: String,
) -> CommandResult<MemoryTriggerState> {
    let db = state.db.lock().await;
    let repo = MemoryTriggerRepository::new(db.pool().clone());
    repo.increment_turn(&agent_id)
        .await
        .map_err(|e| crate::error::AppError::Database(e.to_string()))
}

/// 累加信号分数
#[tauri::command]
pub async fn memory_trigger_accumulate_score(
    state: State<'_, AppState>,
    agent_id: String,
    delta: f64,
) -> CommandResult<MemoryTriggerState> {
    let db = state.db.lock().await;
    let repo = MemoryTriggerRepository::new(db.pool().clone());
    repo.accumulate_score(&agent_id, delta)
        .await
        .map_err(|e| crate::error::AppError::Database(e.to_string()))
}

/// 提取后重置状态
#[tauri::command]
pub async fn memory_trigger_reset(
    state: State<'_, AppState>,
    agent_id: String,
    current_turn: i64,
) -> CommandResult<MemoryTriggerState> {
    let db = state.db.lock().await;
    let repo = MemoryTriggerRepository::new(db.pool().clone());
    repo.reset_after_extract(&agent_id, current_turn)
        .await
        .map_err(|e| crate::error::AppError::Database(e.to_string()))
}

/// 更新上次处理的消息 ID（用于生命周期触发内容变化检测）
#[tauri::command]
pub async fn memory_trigger_update_last_message(
    state: State<'_, AppState>,
    agent_id: String,
    last_processed_message_id: String,
) -> CommandResult<()> {
    let db = state.db.lock().await;
    let repo = MemoryTriggerRepository::new(db.pool().clone());
    repo.update_last_processed_message(&agent_id, &last_processed_message_id)
        .await
        .map_err(|e| crate::error::AppError::Database(e.to_string()))
}
