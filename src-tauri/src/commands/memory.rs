//! Memory Commands - 记忆相关 Tauri 命令
//!
//! 提供记忆系统的 IPC 接口

use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

use crate::db::{Memory, MemoryLayer, MemoryStats};
use crate::error::CommandResult;
use crate::AppState;

/// 创建记忆请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCreateRequest {
    pub agent_id: String,
    pub layer: String,
    pub content: String,
    pub category: Option<String>,
    pub importance: Option<i32>,
    pub source_message_ids: Option<String>,
    pub metadata_json: Option<String>,
}

/// 更新记忆请求
#[derive(Debug, Deserialize)]
pub struct MemoryUpdateRequest {
    pub content: Option<String>,
    pub importance: Option<i32>,
}

/// 记忆响应项
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItem {
    pub id: String,
    pub agent_id: String,
    pub layer: String,
    pub content: String,
    pub category: Option<String>,
    pub importance: Option<i32>,
    pub source_message_ids: Option<String>,
    pub metadata_json: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
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

impl From<Memory> for MemoryItem {
    fn from(m: Memory) -> Self {
        Self {
            id: m.id,
            agent_id: m.agent_id,
            layer: m.layer,
            content: m.content,
            category: m.category,
            importance: m.importance,
            source_message_ids: m.source_message_ids,
            metadata_json: m.metadata_json,
            created_at: m.created_at,
            updated_at: m.updated_at,
        }
    }
}

/// 解析记忆层级
fn parse_layer(layer: &str) -> Result<MemoryLayer, String> {
    match layer {
        "short_term" => Ok(MemoryLayer::ShortTerm),
        "summary" => Ok(MemoryLayer::Summary),
        "fact" => Ok(MemoryLayer::Fact),
        _ => Err(format!("Unknown memory layer: {}", layer)),
    }
}

/// 创建记忆
#[tauri::command]
pub async fn memory_create(
    state: State<'_, AppState>,
    request: MemoryCreateRequest,
) -> CommandResult<MemoryItem> {
    let db = state.db.lock().await;
    let layer = parse_layer(&request.layer).map_err(|e| crate::error::AppError::Generic(e))?;

    let memory = db
        .memory_repo()
        .create_with_details(
            &request.agent_id,
            layer,
            &request.content,
            request.category.as_deref(),
            request.importance,
            request.source_message_ids.as_deref(),
            request.metadata_json.as_deref(),
        )
        .await?;

    Ok(memory.into())
}

/// 获取指定层级的记忆列表
#[tauri::command]
pub async fn memory_list_by_layer(
    state: State<'_, AppState>,
    agent_id: String,
    layer: String,
) -> CommandResult<Vec<MemoryItem>> {
    let db = state.db.lock().await;
    let memory_layer = parse_layer(&layer).map_err(|e| crate::error::AppError::Generic(e))?;

    let memories = db
        .memory_repo()
        .list_by_layer(&agent_id, memory_layer)
        .await?;

    Ok(memories.into_iter().map(|m| m.into()).collect())
}

/// 获取指定类别的事实记忆
#[tauri::command]
pub async fn memory_list_facts(
    state: State<'_, AppState>,
    agent_id: String,
    category: String,
) -> CommandResult<Vec<MemoryItem>> {
    let db = state.db.lock().await;

    let memories = db
        .memory_repo()
        .list_facts_by_category(&agent_id, &category)
        .await?;

    Ok(memories.into_iter().map(|m| m.into()).collect())
}

/// 更新记忆内容
#[tauri::command]
pub async fn memory_update(
    state: State<'_, AppState>,
    id: String,
    content: Option<String>,
    importance: Option<i32>,
    category: Option<String>, // 支持事实类别更新
) -> CommandResult<MemoryItem> {
    let db = state.db.lock().await;

    // 如果有 category 或 importance 更新（事实元数据更新）
    if category.is_some() || importance.is_some() {
        let memory = db
            .memory_repo()
            .update_fact_metadata(&id, category.as_deref(), importance)
            .await?;

        // 如果同时有内容更新，再更新内容
        if let Some(new_content) = content {
            let memory = db.memory_repo().update_content(&id, &new_content).await?;
            return Ok(memory.into());
        }

        return Ok(memory.into());
    }

    // 如果只有内容更新
    if let Some(new_content) = content {
        let memory = db.memory_repo().update_content(&id, &new_content).await?;
        return Ok(memory.into());
    }

    // 没有更新，返回原记录
    let memory = db.memory_repo().get(&id).await?.ok_or_else(|| {
        crate::error::AppError::NotFound(format!("Memory does not exist: {}", id))
    })?;

    Ok(memory.into())
}

/// 删除记忆
#[tauri::command]
pub async fn memory_delete(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    let db = state.db.lock().await;
    db.memory_repo().delete(&id).await?;
    Ok(())
}

/// 删除摘要（包含向量索引）
///
/// 同时删除记忆记录和对应的向量索引，保证数据一致性
#[tauri::command]
pub async fn memory_delete_summary_with_vector(
    state: State<'_, AppState>,
    id: String,
    agent_id: String,
) -> CommandResult<()> {
    let db = state.db.lock().await;

    // 1. 删除记忆记录
    db.memory_repo().delete(&id).await?;

    // 2. 删除向量索引（documentId 格式与 MemoryVectorIndex 一致）
    let document_id = format!("memory_summary_{}", id);
    // 忽略向量删除失败（可能不存在索引）
    let _ = db
        .vector_repo()
        .delete_by_document(&agent_id, &document_id)
        .await;

    Ok(())
}

/// 删除事实（包含向量索引）
///
/// 同时删除记忆记录和对应的向量索引，保证数据一致性
#[tauri::command]
pub async fn memory_delete_fact_with_vector(
    state: State<'_, AppState>,
    id: String,
    agent_id: String,
) -> CommandResult<()> {
    let db = state.db.lock().await;

    // 1. 删除记忆记录
    db.memory_repo().delete(&id).await?;

    // 2. 删除向量索引（documentId 格式与 MemoryVectorIndex 一致）
    let document_id = format!("memory_fact_{}", id);
    // 忽略向量删除失败（可能不存在索引）
    let _ = db
        .vector_repo()
        .delete_by_document(&agent_id, &document_id)
        .await;

    Ok(())
}

/// 获取记忆统计
#[tauri::command]
pub async fn memory_get_stats(
    state: State<'_, AppState>,
    agent_id: String,
) -> CommandResult<MemoryStats> {
    let db = state.db.lock().await;
    let stats = db.memory_repo().get_stats(&agent_id).await?;
    Ok(stats)
}

/// 根据源消息 ID 批量删除短期缓冲记录
///
/// 用于消息撤销时同步删除关联的 short_term 记忆
#[tauri::command]
pub async fn memory_delete_by_source_ids(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    source_message_ids: Vec<String>,
) -> CommandResult<u64> {
    let db = state.db.lock().await;
    let deleted = db
        .memory_repo()
        .delete_by_source_ids(&agent_id, &source_message_ids)
        .await?;
    emit_short_term_memory_changed(&app, &agent_id, deleted, source_message_ids);
    Ok(deleted)
}

/// 清空指定 Agent 的短期缓冲记录
///
/// 用于 Planning 模式取消时清理短期缓冲，解决 ShortTermView 不同步问题
#[tauri::command]
pub async fn memory_clear_short_term(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
) -> CommandResult<u64> {
    let db = state.db.lock().await;
    let deleted = db
        .memory_repo()
        .clear_layer(&agent_id, MemoryLayer::ShortTerm)
        .await?;
    emit_short_term_memory_changed(&app, &agent_id, deleted, Vec::new());
    Ok(deleted)
}

/// 记忆上下文响应（用于上下文注入）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryContextResponse {
    /// 事实列表（USER_PREFERENCE, CORE_REQUIREMENT 等）
    pub facts: Vec<MemoryItem>,
    /// 对话摘要列表
    pub summaries: Vec<MemoryItem>,
}

/// 获取记忆上下文（用于 LLM 上下文注入）
///
/// 一次性返回指定 Agent 的 facts 和 summaries 层记忆
/// 供前端 ContextAssembler 使用
#[tauri::command]
pub async fn memory_get_context(
    state: State<'_, AppState>,
    agent_id: String,
) -> CommandResult<MemoryContextResponse> {
    let db = state.db.lock().await;

    // 并行查询事实层和摘要层
    let facts = db
        .memory_repo()
        .list_by_layer(&agent_id, MemoryLayer::Fact)
        .await?;
    let summaries = db
        .memory_repo()
        .list_by_layer(&agent_id, MemoryLayer::Summary)
        .await?;

    Ok(MemoryContextResponse {
        facts: facts.into_iter().map(|m| m.into()).collect(),
        summaries: summaries.into_iter().map(|m| m.into()).collect(),
    })
}

// ============================================================================
// Memory Candidate Commands (三层事实提取架构)
// ============================================================================

/// 候选事实记录
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCandidateItem {
    pub id: String,
    pub agent_id: String,
    pub content: String,
    pub category: String,
    pub occurrence_count: i32,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
    pub user_confirmed: bool,
    pub score: i32,
}

/// 创建候选事实请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateCreateRequest {
    pub agent_id: String,
    pub content: String,
    pub category: String,
    pub occurrence_count: Option<i32>,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
    pub user_confirmed: Option<bool>,
    pub score: Option<i32>,
}

/// 创建候选事实
#[tauri::command]
pub async fn memory_candidate_create(
    state: State<'_, AppState>,
    request: CandidateCreateRequest,
) -> CommandResult<MemoryCandidateItem> {
    let db = state.db.lock().await;
    let pool = db.pool();

    let id = uuid::Uuid::new_v4().to_string();
    let occurrence_count = request.occurrence_count.unwrap_or(1);
    let user_confirmed = request.user_confirmed.unwrap_or(false);
    let score = request.score.unwrap_or(0);

    sqlx::query(
        r#"
        INSERT INTO memory_candidates (id, agent_id, content, category, occurrence_count, first_seen_at, last_seen_at, user_confirmed, score)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(&request.agent_id)
    .bind(&request.content)
    .bind(&request.category)
    .bind(occurrence_count)
    .bind(request.first_seen_at)
    .bind(request.last_seen_at)
    .bind(if user_confirmed { 1 } else { 0 })
    .bind(score)
    .execute(pool)
    .await
    .map_err(|e| crate::error::AppError::Database(e.to_string()))?;

    Ok(MemoryCandidateItem {
        id,
        agent_id: request.agent_id,
        content: request.content,
        category: request.category,
        occurrence_count,
        first_seen_at: request.first_seen_at,
        last_seen_at: request.last_seen_at,
        user_confirmed,
        score,
    })
}

/// 获取指定 Agent 的所有候选事实
#[tauri::command]
pub async fn memory_candidate_list(
    state: State<'_, AppState>,
    agent_id: String,
) -> CommandResult<Vec<MemoryCandidateItem>> {
    let db = state.db.lock().await;
    let pool = db.pool();

    let rows: Vec<(String, String, String, String, i32, i64, i64, i32, i32)> = sqlx::query_as(
        r#"
        SELECT id, agent_id, content, category, occurrence_count, first_seen_at, last_seen_at, user_confirmed, score
        FROM memory_candidates
        WHERE agent_id = ?
        ORDER BY last_seen_at DESC
        "#,
    )
    .bind(&agent_id)
    .fetch_all(pool)
    .await
    .map_err(|e| crate::error::AppError::Database(e.to_string()))?;

    Ok(rows
        .into_iter()
        .map(|r| MemoryCandidateItem {
            id: r.0,
            agent_id: r.1,
            content: r.2,
            category: r.3,
            occurrence_count: r.4,
            first_seen_at: r.5,
            last_seen_at: r.6,
            user_confirmed: r.7 == 1,
            score: r.8,
        })
        .collect())
}

/// 更新候选事实
#[tauri::command]
pub async fn memory_candidate_update(
    state: State<'_, AppState>,
    id: String,
    occurrence_count: Option<i32>,
    last_seen_at: Option<i64>,
    user_confirmed: Option<bool>,
    score: Option<i32>,
) -> CommandResult<()> {
    let db = state.db.lock().await;
    let pool = db.pool();

    // 构建动态 SQL（简化版：更新所有提供的字段）
    if let Some(count) = occurrence_count {
        sqlx::query("UPDATE memory_candidates SET occurrence_count = ? WHERE id = ?")
            .bind(count)
            .bind(&id)
            .execute(pool)
            .await
            .map_err(|e| crate::error::AppError::Database(e.to_string()))?;
    }

    if let Some(ts) = last_seen_at {
        sqlx::query("UPDATE memory_candidates SET last_seen_at = ? WHERE id = ?")
            .bind(ts)
            .bind(&id)
            .execute(pool)
            .await
            .map_err(|e| crate::error::AppError::Database(e.to_string()))?;
    }

    if let Some(confirmed) = user_confirmed {
        sqlx::query("UPDATE memory_candidates SET user_confirmed = ? WHERE id = ?")
            .bind(if confirmed { 1 } else { 0 })
            .bind(&id)
            .execute(pool)
            .await
            .map_err(|e| crate::error::AppError::Database(e.to_string()))?;
    }

    if let Some(s) = score {
        sqlx::query("UPDATE memory_candidates SET score = ? WHERE id = ?")
            .bind(s)
            .bind(&id)
            .execute(pool)
            .await
            .map_err(|e| crate::error::AppError::Database(e.to_string()))?;
    }

    Ok(())
}

/// 删除候选事实
#[tauri::command]
pub async fn memory_candidate_delete(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    let db = state.db.lock().await;
    let pool = db.pool();

    sqlx::query("DELETE FROM memory_candidates WHERE id = ?")
        .bind(&id)
        .execute(pool)
        .await
        .map_err(|e| crate::error::AppError::Database(e.to_string()))?;

    Ok(())
}

/// 批量删除候选事实（当候选被提升为正式 fact 后）
#[tauri::command]
pub async fn memory_candidate_delete_batch(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> CommandResult<u64> {
    let db = state.db.lock().await;
    let pool = db.pool();

    let mut deleted = 0u64;
    for id in ids {
        let result = sqlx::query("DELETE FROM memory_candidates WHERE id = ?")
            .bind(&id)
            .execute(pool)
            .await
            .map_err(|e| crate::error::AppError::Database(e.to_string()))?;
        deleted += result.rows_affected();
    }

    Ok(deleted)
}
