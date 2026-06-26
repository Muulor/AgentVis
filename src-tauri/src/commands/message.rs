//! Message 相关 Tauri Commands
//!
//! 提供消息的 CRUD 操作命令，用于聊天历史持久化

use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

use crate::db::models::MessageRole;
use crate::error::CommandResult;
use crate::AppState;

/// 消息响应项
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageItem {
    pub id: String,
    pub agent_id: String,
    pub role: String,
    pub content: String,
    pub metadata: Option<String>,  // JSON 字符串存储元数据
    pub created_at: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ShortTermMemoryChangedEvent {
    agent_id: String,
    deleted_count: u64,
    source_message_ids: Vec<String>,
}

fn emit_short_term_memory_changed(
    app: &tauri::AppHandle,
    agent_id: &str,
    deleted_count: u64,
    source_message_ids: Vec<String>,
) {
    if deleted_count == 0 {
        return;
    }

    let _ = app.emit(
        "memory:short_term_changed",
        ShortTermMemoryChangedEvent {
            agent_id: agent_id.to_string(),
            deleted_count,
            source_message_ids,
        },
    );
}

/// 创建消息请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMessageRequest {
    pub agent_id: String,
    pub role: String,
    pub content: String,
    pub metadata: Option<String>,  // JSON 字符串
}

/// 将字符串转换为 MessageRole
fn parse_role(role: &str) -> MessageRole {
    match role.to_lowercase().as_str() {
        "user" => MessageRole::User,
        "assistant" => MessageRole::Assistant,
        "system" => MessageRole::System,
        _ => MessageRole::User,
    }
}

/// 创建新消息
#[tauri::command]
pub async fn message_create(
    state: State<'_, AppState>,
    request: CreateMessageRequest,
) -> CommandResult<MessageItem> {
    let db = state.db.lock().await;
    let role = parse_role(&request.role);
    let message = db.message_repo().create(
        &request.agent_id, 
        role, 
        &request.content,
        request.metadata,
    ).await?;
    
    Ok(MessageItem {
        id: message.id,
        agent_id: message.agent_id,
        role: message.role,
        content: message.content,
        metadata: message.metadata,
        created_at: message.created_at,
    })
}

/// 获取指定 Agent 的消息列表
#[tauri::command]
pub async fn message_list_by_agent(
    state: State<'_, AppState>,
    agent_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> CommandResult<Vec<MessageItem>> {
    let db = state.db.lock().await;
    let limit = limit.unwrap_or(100);
    let offset = offset.unwrap_or(0);
    let messages = db.message_repo().list_by_agent(&agent_id, limit, offset).await?;
    
    Ok(messages.into_iter().map(|m| MessageItem {
        id: m.id,
        agent_id: m.agent_id,
        role: m.role,
        content: m.content,
        metadata: m.metadata,
        created_at: m.created_at,
    }).collect())
}

/// 获取指定 Agent 最近的 N 条消息
#[tauri::command]
pub async fn message_get_recent(
    state: State<'_, AppState>,
    agent_id: String,
    count: i64,
) -> CommandResult<Vec<MessageItem>> {
    let db = state.db.lock().await;
    let messages = db.message_repo().get_recent(&agent_id, count).await?;
    
    Ok(messages.into_iter().map(|m| MessageItem {
        id: m.id,
        agent_id: m.agent_id,
        role: m.role,
        content: m.content,
        metadata: m.metadata,
        created_at: m.created_at,
    }).collect())
}

/// 根据 ID 列表批量获取消息（用于摘要展开原文功能）
#[tauri::command]
pub async fn message_get_batch(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> CommandResult<Vec<MessageItem>> {
    let db = state.db.lock().await;
    let messages = db.message_repo().get_by_ids(&ids).await?;
    
    Ok(messages.into_iter().map(|m| MessageItem {
        id: m.id,
        agent_id: m.agent_id,
        role: m.role,
        content: m.content,
        metadata: m.metadata,
        created_at: m.created_at,
    }).collect())
}

/// 获取指定消息 ID 之后的消息（增量加载，用于事实提取优化）
#[tauri::command]
pub async fn message_get_after(
    state: State<'_, AppState>,
    agent_id: String,
    after_message_id: String,
    limit: Option<i64>,
) -> CommandResult<Vec<MessageItem>> {
    let db = state.db.lock().await;
    let limit = limit.unwrap_or(20);  // 默认最多 20 条
    let messages = db.message_repo().get_after(&agent_id, &after_message_id, limit).await?;
    
    Ok(messages.into_iter().map(|m| MessageItem {
        id: m.id,
        agent_id: m.agent_id,
        role: m.role,
        content: m.content,
        metadata: m.metadata,
        created_at: m.created_at,
    }).collect())
}

/// 获取指定消息 ID 之前的消息（向前分页，用于"加载更多"）
#[tauri::command]
pub async fn message_get_before(
    state: State<'_, AppState>,
    agent_id: String,
    before_message_id: String,
    count: Option<i64>,
) -> CommandResult<Vec<MessageItem>> {
    let db = state.db.lock().await;
    let count = count.unwrap_or(100);
    let messages = db.message_repo().get_before(&agent_id, &before_message_id, count).await?;

    Ok(messages.into_iter().map(|m| MessageItem {
        id: m.id,
        agent_id: m.agent_id,
        role: m.role,
        content: m.content,
        metadata: m.metadata,
        created_at: m.created_at,
    }).collect())
}

/// 获取指定 Agent 的消息总数（用于判断是否有更多历史可加载）
#[tauri::command]
pub async fn message_count_by_agent(
    state: State<'_, AppState>,
    agent_id: String,
) -> CommandResult<i64> {
    let db = state.db.lock().await;
    let count = db.message_repo().count_by_agent(&agent_id).await?;
    Ok(count)
}

/// 删除消息

#[tauri::command]
pub async fn message_delete(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> CommandResult<()> {
    let db = state.db.lock().await;
    let message = db.message_repo().get(&id).await?;
    db.message_repo().soft_delete(&id).await?;

    if let Some(message) = message {
        let source_message_ids = vec![id];
        let deleted = db
            .memory_repo()
            .delete_by_source_ids(&message.agent_id, &source_message_ids)
            .await?;
        emit_short_term_memory_changed(&app, &message.agent_id, deleted, source_message_ids);
    }

    Ok(())
}

/// 撤回消息及之后所有消息
#[tauri::command]
pub async fn message_retract_from(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    agent_id: String,
) -> CommandResult<u64> {
    let db = state.db.lock().await;
    let source_message_ids = db.message_repo().list_ids_from(&id, &agent_id).await?;
    let count = db.message_repo().retract_from(&id, &agent_id).await?;

    let deleted = db
        .memory_repo()
        .delete_by_source_ids(&agent_id, &source_message_ids)
        .await?;
    emit_short_term_memory_changed(&app, &agent_id, deleted, source_message_ids);

    Ok(count)
}

/// 清空指定 Agent 的所有消息
#[tauri::command]
pub async fn message_clear_by_agent(
    state: State<'_, AppState>,
    agent_id: String,
) -> CommandResult<u64> {
    let db = state.db.lock().await;
    let count = db.message_repo().clear_by_agent(&agent_id).await?;
    Ok(count)
}

/// 获取指定 Hub 的所有消息（包含无 @提及和有 @提及的）
///
/// 合并两类存储路径：
/// 1. 直接以 hub_id 为 agent_id 存储的消息（无 @提及时）
/// 2. metadata.hubId == hub_id 的消息（有 @提及时，存在对应 Agent 下）
#[tauri::command]
pub async fn message_list_by_hub(
    state: State<'_, AppState>,
    hub_id: String,
    limit: Option<i64>,
) -> CommandResult<Vec<MessageItem>> {
    let db = state.db.lock().await;
    let limit = limit.unwrap_or(200);
    let messages = db.message_repo().list_by_hub_id(&hub_id, limit).await?;

    Ok(messages.into_iter().map(|m| MessageItem {
        id: m.id,
        agent_id: m.agent_id,
        role: m.role,
        content: m.content,
        metadata: m.metadata,
        created_at: m.created_at,
    }).collect())
}

/// 获取指定 Hub 最近 N 条消息（初始加载用）
#[tauri::command]
pub async fn message_get_recent_hub(
    state: State<'_, AppState>,
    hub_id: String,
    count: i64,
) -> CommandResult<Vec<MessageItem>> {
    let db = state.db.lock().await;
    let messages = db.message_repo().get_recent_by_hub_id(&hub_id, count).await?;

    Ok(messages.into_iter().map(|m| MessageItem {
        id: m.id,
        agent_id: m.agent_id,
        role: m.role,
        content: m.content,
        metadata: m.metadata,
        created_at: m.created_at,
    }).collect())
}

/// 获取指定 Hub 中某消息之前的消息（向前分页，"加载更多"用）
#[tauri::command]
pub async fn message_get_before_hub(
    state: State<'_, AppState>,
    hub_id: String,
    before_message_id: String,
    count: Option<i64>,
) -> CommandResult<Vec<MessageItem>> {
    let db = state.db.lock().await;
    let count = count.unwrap_or(100);
    let messages = db.message_repo().get_before_by_hub_id(&hub_id, &before_message_id, count).await?;

    Ok(messages.into_iter().map(|m| MessageItem {
        id: m.id,
        agent_id: m.agent_id,
        role: m.role,
        content: m.content,
        metadata: m.metadata,
        created_at: m.created_at,
    }).collect())
}

/// 获取指定 Hub 的消息总数
#[tauri::command]
pub async fn message_count_by_hub(
    state: State<'_, AppState>,
    hub_id: String,
) -> CommandResult<i64> {
    let db = state.db.lock().await;
    let count = db.message_repo().count_by_hub_id(&hub_id).await?;
    Ok(count)
}
