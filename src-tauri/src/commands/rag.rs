//! RAG Commands - 向量检索相关 Tauri 命令
//!
//! 提供文档索引、向量检索等 IPC 接口

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::{ChunkEmbeddingUpdate, IndexStats, VectorSearchResult};
use crate::error::{AppError, CommandResult};
use crate::AppState;

/// 索引块参数
#[derive(Debug, Deserialize)]
pub struct IndexChunkParams {
    pub chunk_id: Option<String>,
    pub agent_id: String,
    pub document_id: String,
    pub chunk_index: i32,
    pub content: String,
    pub embedding: Vec<f32>,
    pub metadata: Option<String>,
    pub source_file_id: Option<String>,
}

/// 搜索参数
#[derive(Debug, Deserialize)]
pub struct SearchParams {
    pub agent_id: String,
    pub query_embedding: Vec<f32>,
    pub top_k: Option<usize>,
    pub threshold: Option<f32>,
    /// 可选的 document_id 前缀过滤，用于隔离不同类型的向量条目
    pub document_id_prefix: Option<String>,
    /// Required vector-space fingerprint. Vectors from other profiles are not comparable.
    pub expected_embedding_profile_id: String,
}

/// One chunk in an atomic embedding/profile migration.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchChunkEmbeddingUpdate {
    pub chunk_id: String,
    pub embedding: Vec<f32>,
    pub metadata: String,
}

/// 索引块响应
#[derive(Debug, Serialize)]
pub struct IndexChunkResponse {
    pub id: String,
    pub success: bool,
}

/// Persisted chunk data returned to the renderer for BM25 rebuild.
#[derive(Debug, Serialize)]
pub struct PersistedChunkResponse {
    pub chunk_id: String,
    pub document_id: String,
    pub chunk_index: i32,
    pub content: String,
    pub metadata: String,
    pub created_at: i64,
}

/// 索引单个文档块
#[tauri::command]
pub async fn rag_index_chunk(
    state: State<'_, AppState>,
    params: IndexChunkParams,
) -> CommandResult<IndexChunkResponse> {
    let db = state.db.lock().await;
    let chunk = db
        .vector_repo()
        .insert_chunk(
            &params.agent_id,
            &params.document_id,
            params.chunk_index,
            &params.content,
            &params.embedding,
            params.metadata.as_deref(),
            params.source_file_id.as_deref(),
            params.chunk_id.as_deref(),
        )
        .await?;

    Ok(IndexChunkResponse {
        id: chunk.id,
        success: true,
    })
}

/// List persisted chunks for an Agent without returning embedding blobs.
#[tauri::command]
pub async fn rag_list_chunks(
    state: State<'_, AppState>,
    agent_id: String,
) -> CommandResult<Vec<PersistedChunkResponse>> {
    let db = state.db.lock().await;
    let chunks = db
        .vector_repo()
        .list_knowledge_chunks_for_bm25(&agent_id)
        .await?;
    Ok(chunks
        .into_iter()
        .map(|chunk| PersistedChunkResponse {
            chunk_id: chunk.id,
            document_id: chunk.document_id,
            chunk_index: chunk.chunk_index,
            content: chunk.content,
            metadata: chunk.metadata_json.unwrap_or_else(|| "{}".to_string()),
            created_at: chunk.created_at,
        })
        .collect())
}

/// 向量相似度搜索
#[tauri::command]
pub async fn rag_search(
    state: State<'_, AppState>,
    params: SearchParams,
) -> CommandResult<Vec<VectorSearchResult>> {
    let top_k = params.top_k.unwrap_or(5);
    let threshold = params.threshold.unwrap_or(0.7);
    if params.expected_embedding_profile_id.trim().is_empty()
        || params.expected_embedding_profile_id.len() > 512
        || params
            .expected_embedding_profile_id
            .chars()
            .any(char::is_control)
    {
        return Err(AppError::Generic(
            "expected_embedding_profile_id is invalid".to_string(),
        ));
    }

    let db = state.db.lock().await;
    let results = db
        .vector_repo()
        .search_similar(
            &params.agent_id,
            &params.query_embedding,
            top_k,
            threshold,
            params.document_id_prefix.as_deref(),
            &params.expected_embedding_profile_id,
        )
        .await?;

    Ok(results)
}

/// 删除指定 Agent 的所有索引
#[tauri::command]
pub async fn rag_delete_by_agent(
    state: State<'_, AppState>,
    agent_id: String,
) -> CommandResult<u64> {
    let db = state.db.lock().await;
    let count = db.vector_repo().delete_by_agent(&agent_id).await?;
    Ok(count)
}

/// 删除指定文档的索引
#[tauri::command]
pub async fn rag_delete_by_document(
    state: State<'_, AppState>,
    agent_id: String,
    document_id: String,
) -> CommandResult<u64> {
    let db = state.db.lock().await;
    let count = db
        .vector_repo()
        .delete_by_document(&agent_id, &document_id)
        .await?;
    Ok(count)
}

/// 获取索引状态
#[tauri::command]
pub async fn rag_get_status(
    state: State<'_, AppState>,
    agent_id: String,
) -> CommandResult<IndexStats> {
    let db = state.db.lock().await;
    let stats = db.vector_repo().get_stats(&agent_id).await?;
    Ok(stats)
}

/// 获取指定 Agent 的所有已索引 document_id 列表
///
/// 用于前端对账：对比 DB 中的摘要记录与已索引的 document_id，发现缺失的补索引
#[tauri::command]
pub async fn rag_list_document_ids(
    state: State<'_, AppState>,
    agent_id: String,
) -> CommandResult<Vec<String>> {
    let db = state.db.lock().await;
    let ids = db.vector_repo().list_document_ids(&agent_id).await?;
    Ok(ids)
}

/// List Agents that currently own persisted vector data.
#[tauri::command]
pub async fn rag_list_vector_agent_ids(state: State<'_, AppState>) -> CommandResult<Vec<String>> {
    let db = state.db.lock().await;
    db.vector_repo().list_vector_agent_ids().await
}

/// Atomically replace chunk vectors and metadata for one Agent.
#[tauri::command]
pub async fn rag_batch_update_chunk_embeddings(
    state: State<'_, AppState>,
    agent_id: String,
    updates: Vec<BatchChunkEmbeddingUpdate>,
) -> CommandResult<u64> {
    let updates = updates
        .into_iter()
        .map(|update| ChunkEmbeddingUpdate {
            chunk_id: update.chunk_id,
            embedding: update.embedding,
            metadata_json: update.metadata,
        })
        .collect::<Vec<_>>();
    let db = state.db.lock().await;
    db.vector_repo()
        .batch_update_chunk_embeddings(&agent_id, &updates)
        .await
}
