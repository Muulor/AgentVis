//! VectorRepository - 向量数据访问层
//!
//! 提供文档块向量存储和检索的 CRUD 操作

use chrono::Utc;
use sqlx::{Pool, Sqlite};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// Profile assigned to vectors created before profile-aware metadata existed.
pub const LEGACY_EMBEDDING_PROFILE_ID: &str = "rag-embedding:v1:siliconflow:BAAI/bge-m3";

/// One item in an atomic embedding/profile migration.
#[derive(Debug, Clone)]
pub struct ChunkEmbeddingUpdate {
    pub chunk_id: String,
    pub embedding: Vec<f32>,
    pub metadata_json: String,
}

/// 文档块实体
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, sqlx::FromRow)]
pub struct ChunkEmbedding {
    pub id: String,
    pub agent_id: String,
    pub document_id: String,
    pub chunk_index: i32,
    pub content: String,
    /// 向量数据，存储为 BLOB (可选，因为向量化可能异步进行)
    #[sqlx(default)]
    pub embedding: Option<Vec<u8>>,
    /// 元数据 JSON
    pub metadata_json: Option<String>,
    pub source_file_id: Option<String>,
    pub created_at: i64,
}

impl ChunkEmbedding {
    /// 创建新的文档块
    pub fn new(agent_id: &str, document_id: &str, chunk_index: i32, content: &str) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            agent_id: agent_id.to_string(),
            document_id: document_id.to_string(),
            chunk_index,
            content: content.to_string(),
            embedding: None,
            metadata_json: None,
            source_file_id: None,
            created_at: Utc::now().timestamp(),
        }
    }
}

/// 搜索结果
#[derive(Debug, Clone, serde::Serialize)]
pub struct VectorSearchResult {
    pub chunk_id: String,
    pub document_id: String,
    pub content: String,
    pub metadata: String,
    pub score: f32,
    pub distance: f32,
}

/// Lightweight persisted chunk data used to rebuild the renderer BM25 index.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, sqlx::FromRow)]
pub struct PersistedChunkForBm25 {
    pub id: String,
    pub document_id: String,
    pub chunk_index: i32,
    pub content: String,
    pub metadata_json: Option<String>,
    pub created_at: i64,
}

/// 索引状态
#[derive(Debug, Clone, serde::Serialize)]
pub struct IndexStats {
    pub agent_id: String,
    pub document_count: i64,
    pub chunk_count: i64,
    pub last_updated_at: Option<i64>,
}

/// VectorRepository - 管理向量数据访问
pub struct VectorRepository {
    pool: Pool<Sqlite>,
}

impl VectorRepository {
    /// 创建新的 VectorRepository 实例
    pub fn new(pool: Pool<Sqlite>) -> Self {
        Self { pool }
    }

    /// 插入文档块
    ///
    /// # Arguments
    /// * `chunk` - 文档块实体
    /// * `embedding` - 向量数据 (f32 数组)
    pub async fn insert_chunk(
        &self,
        agent_id: &str,
        document_id: &str,
        chunk_index: i32,
        content: &str,
        embedding: &[f32],
        metadata_json: Option<&str>,
        source_file_id: Option<&str>,
        chunk_id: Option<&str>,
    ) -> AppResult<ChunkEmbedding> {
        let id = chunk_id
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.to_string())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let now = Utc::now().timestamp();

        // 将 f32 向量转换为字节数组 (小端序)
        let embedding_bytes: Vec<u8> = embedding.iter().flat_map(|f| f.to_le_bytes()).collect();

        sqlx::query(
            r#"
            INSERT INTO chunk_embeddings (
                id, agent_id, document_id, chunk_index, 
                content, embedding, metadata_json, source_file_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(agent_id)
        .bind(document_id)
        .bind(chunk_index)
        .bind(content)
        .bind(&embedding_bytes)
        .bind(metadata_json)
        .bind(source_file_id)
        .bind(now)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to insert vector: {}", e)))?;

        Ok(ChunkEmbedding {
            id,
            agent_id: agent_id.to_string(),
            document_id: document_id.to_string(),
            chunk_index,
            content: content.to_string(),
            embedding: Some(embedding_bytes),
            metadata_json: metadata_json.map(|s| s.to_string()),
            source_file_id: source_file_id.map(|s| s.to_string()),
            created_at: now,
        })
    }

    /// 根据 ID 获取文档块
    pub async fn get_by_id(&self, id: &str) -> AppResult<Option<ChunkEmbedding>> {
        let chunk = sqlx::query_as::<_, ChunkEmbedding>(
            r#"
            SELECT id, agent_id, document_id, chunk_index, 
                   content, embedding, metadata_json, source_file_id, created_at
            FROM chunk_embeddings 
            WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to query vector: {}", e)))?;

        Ok(chunk)
    }

    /// 获取指定 Agent 的所有文档块
    pub async fn list_by_agent(&self, agent_id: &str) -> AppResult<Vec<ChunkEmbedding>> {
        let chunks = sqlx::query_as::<_, ChunkEmbedding>(
            r#"
            SELECT id, agent_id, document_id, chunk_index, 
                   content, embedding, metadata_json, source_file_id, created_at
            FROM chunk_embeddings 
            WHERE agent_id = ?
            ORDER BY document_id, chunk_index
            "#,
        )
        .bind(agent_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to query vector list: {}", e)))?;

        Ok(chunks)
    }

    /// 获取指定 Agent 的知识库 chunks，用于前端重建 BM25。
    ///
    /// 该查询不读取 embedding BLOB；记忆向量由 TS 侧基于 metadata 过滤。
    pub async fn list_knowledge_chunks_for_bm25(
        &self,
        agent_id: &str,
    ) -> AppResult<Vec<PersistedChunkForBm25>> {
        let chunks = sqlx::query_as::<_, PersistedChunkForBm25>(
            r#"
            SELECT id, document_id, chunk_index, content, metadata_json, created_at
            FROM chunk_embeddings
            WHERE agent_id = ?
            ORDER BY document_id, chunk_index
            "#,
        )
        .bind(agent_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to query BM25 chunk list: {}", e)))?;

        Ok(chunks)
    }

    /// 获取指定文档的所有块
    pub async fn list_by_document(
        &self,
        agent_id: &str,
        document_id: &str,
    ) -> AppResult<Vec<ChunkEmbedding>> {
        let chunks = sqlx::query_as::<_, ChunkEmbedding>(
            r#"
            SELECT id, agent_id, document_id, chunk_index, 
                   content, embedding, metadata_json, source_file_id, created_at
            FROM chunk_embeddings 
            WHERE agent_id = ? AND document_id = ?
            ORDER BY chunk_index
            "#,
        )
        .bind(agent_id)
        .bind(document_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to query document chunk list: {}", e)))?;

        Ok(chunks)
    }

    /// 简单的向量相似度搜索 (使用余弦相似度)
    ///
    /// 注意: 这是一个基于 SQLite 的简单实现，适合小规模数据。
    /// 大规模数据应使用 sqlite-vec 扩展或其他向量数据库。
    ///
    /// # Arguments
    /// * `agent_id` - Agent ID
    /// * `query_embedding` - 查询向量
    /// * `top_k` - 返回的最大结果数
    /// * `threshold` - 相似度阈值 (0-1)
    /// * `document_id_prefix` - 可选的 document_id 前缀过滤（如 "memory_summary_"），
    ///   用于在 SQL 层隔离不同类型的向量条目，避免摘要、事实、知识库互相干扰
    pub async fn search_similar(
        &self,
        agent_id: &str,
        query_embedding: &[f32],
        top_k: usize,
        threshold: f32,
        document_id_prefix: Option<&str>,
        expected_embedding_profile_id: &str,
    ) -> AppResult<Vec<VectorSearchResult>> {
        // 根据是否有前缀过滤，选择不同的查询路径
        let chunks = match document_id_prefix {
            Some(prefix) => {
                let like_pattern = format!("{}%", prefix);
                sqlx::query_as::<_, ChunkEmbedding>(
                    r#"
                    SELECT id, agent_id, document_id, chunk_index,
                           content, embedding, metadata_json, source_file_id, created_at
                    FROM chunk_embeddings
                    WHERE agent_id = ? AND document_id LIKE ?
                    "#,
                )
                .bind(agent_id)
                .bind(&like_pattern)
                .fetch_all(&self.pool)
                .await
                .map_err(|e| AppError::Database(format!("Failed to query vector list: {}", e)))?
            }
            None => self.list_by_agent(agent_id).await?,
        };

        let mut results: Vec<VectorSearchResult> = Vec::new();

        for chunk in chunks {
            if let Some(embedding_bytes) = &chunk.embedding {
                if embedding_bytes.len() % std::mem::size_of::<f32>() != 0 {
                    continue;
                }
                // 将字节数组转回 f32 向量
                let stored_embedding = bytes_to_f32_vec(embedding_bytes);

                if !metadata_matches_embedding(
                    chunk.metadata_json.as_deref(),
                    expected_embedding_profile_id,
                    stored_embedding.len(),
                    query_embedding.len(),
                ) {
                    continue;
                }

                // 计算余弦相似度
                let similarity = cosine_similarity(query_embedding, &stored_embedding);

                if similarity >= threshold {
                    results.push(VectorSearchResult {
                        chunk_id: chunk.id,
                        document_id: chunk.document_id,
                        content: chunk.content,
                        metadata: chunk.metadata_json.unwrap_or_else(|| "{}".to_string()),
                        score: similarity,
                        distance: 1.0 - similarity, // 余弦距离
                    });
                }
            }
        }

        // 按相似度降序排序
        results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        // 截取 top_k
        results.truncate(top_k);

        Ok(results)
    }

    /// 删除指定 Agent 的所有向量
    pub async fn delete_by_agent(&self, agent_id: &str) -> AppResult<u64> {
        let result = sqlx::query("DELETE FROM chunk_embeddings WHERE agent_id = ?")
            .bind(agent_id)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Database(format!("Failed to delete vector: {}", e)))?;

        Ok(result.rows_affected())
    }

    /// 删除指定文档的所有向量
    pub async fn delete_by_document(&self, agent_id: &str, document_id: &str) -> AppResult<u64> {
        let result =
            sqlx::query("DELETE FROM chunk_embeddings WHERE agent_id = ? AND document_id = ?")
                .bind(agent_id)
                .bind(document_id)
                .execute(&self.pool)
                .await
                .map_err(|e| {
                    AppError::Database(format!("Failed to delete document vectors: {}", e))
                })?;

        Ok(result.rows_affected())
    }

    /// 获取索引统计信息
    pub async fn get_stats(&self, agent_id: &str) -> AppResult<IndexStats> {
        let doc_count: (i64,) = sqlx::query_as(
            r#"
            SELECT COUNT(DISTINCT document_id) 
            FROM chunk_embeddings 
            WHERE agent_id = ?
            "#,
        )
        .bind(agent_id)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to query document count: {}", e)))?;

        let chunk_count: (i64,) = sqlx::query_as(
            r#"
            SELECT COUNT(*) 
            FROM chunk_embeddings 
            WHERE agent_id = ?
            "#,
        )
        .bind(agent_id)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to query chunk count: {}", e)))?;

        let last_updated: Option<(i64,)> = sqlx::query_as(
            r#"
            SELECT MAX(created_at) 
            FROM chunk_embeddings 
            WHERE agent_id = ?
            "#,
        )
        .bind(agent_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to query last update time: {}", e)))?;

        Ok(IndexStats {
            agent_id: agent_id.to_string(),
            document_count: doc_count.0,
            chunk_count: chunk_count.0,
            last_updated_at: last_updated.map(|t| t.0),
        })
    }

    /// 获取指定 Agent 的所有已索引 document_id 列表
    ///
    /// 用于前端对账：对比 DB 中的摘要记录与已索引的 document_id，发现缺失的补索引
    pub async fn list_document_ids(&self, agent_id: &str) -> AppResult<Vec<String>> {
        let rows: Vec<(String,)> = sqlx::query_as(
            r#"
            SELECT DISTINCT document_id
            FROM chunk_embeddings
            WHERE agent_id = ?
            "#,
        )
        .bind(agent_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to query document_id list: {}", e)))?;

        Ok(rows.into_iter().map(|r| r.0).collect())
    }

    /// List all Agents that currently own at least one persisted vector.
    pub async fn list_vector_agent_ids(&self) -> AppResult<Vec<String>> {
        let rows: Vec<(String,)> = sqlx::query_as(
            r#"
            SELECT DISTINCT agent_id
            FROM chunk_embeddings
            WHERE embedding IS NOT NULL
            ORDER BY agent_id
            "#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to query vector agent list: {}", e)))?;

        Ok(rows.into_iter().map(|row| row.0).collect())
    }

    /// Atomically replace a batch of chunk embeddings and their metadata.
    ///
    /// Every chunk must belong to `agent_id`. Any missing/duplicate chunk or
    /// invalid vector/metadata aborts the whole transaction.
    pub async fn batch_update_chunk_embeddings(
        &self,
        agent_id: &str,
        updates: &[ChunkEmbeddingUpdate],
    ) -> AppResult<u64> {
        if agent_id.trim().is_empty() {
            return Err(AppError::Database("Agent ID must not be empty".to_string()));
        }
        if updates.is_empty() {
            return Ok(0);
        }

        let mut seen_ids = std::collections::HashSet::with_capacity(updates.len());
        let mut expected_profile_id: Option<String> = None;
        let expected_dimension = updates[0].embedding.len();
        if expected_dimension == 0 {
            return Err(AppError::Database(
                "Embedding update contains an empty vector".to_string(),
            ));
        }

        for update in updates {
            if update.chunk_id.trim().is_empty() || !seen_ids.insert(update.chunk_id.as_str()) {
                return Err(AppError::Database(
                    "Embedding update contains an empty or duplicate chunk ID".to_string(),
                ));
            }
            if update.embedding.len() != expected_dimension
                || update.embedding.iter().any(|value| !value.is_finite())
            {
                return Err(AppError::Database(
                    "Embedding update contains invalid or inconsistent vectors".to_string(),
                ));
            }
            let metadata: serde_json::Value =
                serde_json::from_str(&update.metadata_json).map_err(|_| {
                    AppError::Database("Embedding update metadata is invalid".to_string())
                })?;
            let profile_id = metadata
                .as_object()
                .and_then(|object| object.get("embeddingProfileId"))
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let Some(profile_id) = profile_id else {
                return Err(AppError::Database(
                    "Embedding update metadata must contain embeddingProfileId".to_string(),
                ));
            };
            if profile_id.len() > 512 || profile_id.chars().any(char::is_control) {
                return Err(AppError::Database(
                    "Embedding update metadata contains an invalid embeddingProfileId".to_string(),
                ));
            }
            match &expected_profile_id {
                Some(expected) if expected != profile_id => {
                    return Err(AppError::Database(
                        "Embedding update batch contains multiple embedding profiles".to_string(),
                    ));
                }
                None => expected_profile_id = Some(profile_id.to_string()),
                Some(_) => {}
            }
            let metadata_dimension = metadata
                .as_object()
                .and_then(|object| object.get("embeddingDimension"))
                .and_then(serde_json::Value::as_u64)
                .and_then(|value| usize::try_from(value).ok());
            if metadata_dimension != Some(update.embedding.len()) {
                return Err(AppError::Database(
                    "Embedding update metadata dimension does not match the vector".to_string(),
                ));
            }
        }

        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|e| AppError::Database(format!("Failed to start vector update: {}", e)))?;

        let mut rows_affected = 0_u64;
        for update in updates {
            let embedding_bytes: Vec<u8> = update
                .embedding
                .iter()
                .flat_map(|value| value.to_le_bytes())
                .collect();
            let result = sqlx::query(
                r#"
                UPDATE chunk_embeddings
                SET embedding = ?, metadata_json = ?
                WHERE id = ? AND agent_id = ?
                "#,
            )
            .bind(embedding_bytes)
            .bind(&update.metadata_json)
            .bind(&update.chunk_id)
            .bind(agent_id)
            .execute(&mut *transaction)
            .await
            .map_err(|e| AppError::Database(format!("Failed to update chunk embedding: {}", e)))?;

            if result.rows_affected() != 1 {
                return Err(AppError::Database(format!(
                    "Chunk {} was not found for the selected Agent",
                    update.chunk_id
                )));
            }
            rows_affected += result.rows_affected();
        }

        transaction
            .commit()
            .await
            .map_err(|e| AppError::Database(format!("Failed to commit vector update: {}", e)))?;
        Ok(rows_affected)
    }
}

fn metadata_matches_embedding(
    metadata_json: Option<&str>,
    expected_embedding_profile_id: &str,
    stored_dimension: usize,
    query_dimension: usize,
) -> bool {
    if stored_dimension == 0 || query_dimension == 0 || stored_dimension != query_dimension {
        return false;
    }

    let metadata = match metadata_json {
        Some(raw) => match serde_json::from_str::<serde_json::Value>(raw) {
            Ok(serde_json::Value::Object(object)) => Some(object),
            Ok(_) | Err(_) => return false,
        },
        None => None,
    };

    let profile_value = metadata
        .as_ref()
        .and_then(|object| object.get("embeddingProfileId"));
    let is_legacy_row = match profile_value {
        Some(serde_json::Value::String(profile_id)) => {
            if profile_id != expected_embedding_profile_id {
                return false;
            }
            false
        }
        Some(_) => return false,
        None => {
            if expected_embedding_profile_id != LEGACY_EMBEDDING_PROFILE_ID {
                return false;
            }
            true
        }
    };

    match metadata
        .as_ref()
        .and_then(|object| object.get("embeddingDimension"))
    {
        Some(value) => value
            .as_u64()
            .filter(|dimension| *dimension > 0)
            .and_then(|dimension| usize::try_from(dimension).ok())
            .map(|dimension| dimension == stored_dimension && dimension == query_dimension)
            .unwrap_or(false),
        None => is_legacy_row,
    }
}

/// 将字节数组转换为 f32 向量
fn bytes_to_f32_vec(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|chunk| {
            let arr: [u8; 4] = chunk.try_into().unwrap_or([0; 4]);
            f32::from_le_bytes(arr)
        })
        .collect()
}

/// 计算两个向量的余弦相似度
fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }

    let dot_product: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();

    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }

    dot_product / (norm_a * norm_b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::{create_pool, initialize_schema};
    use crate::db::{AgentRepository, HubRepository};

    /// 设置测试数据库并创建必要的 Hub 和 Agent
    async fn setup_test_db_with_agent() -> (VectorRepository, String) {
        let pool = create_pool("sqlite::memory:").await.unwrap();
        initialize_schema(&pool).await.unwrap();

        // 创建测试 Hub
        let hub_repo = HubRepository::new(pool.clone());
        let hub = hub_repo.create("Test Hub").await.unwrap();

        // 创建测试 Agent
        let agent_repo = AgentRepository::new(pool.clone());
        let agent = agent_repo.create(&hub.id, "Test Agent").await.unwrap();

        let vector_repo = VectorRepository::new(pool);
        (vector_repo, agent.id)
    }

    #[tokio::test]
    async fn test_insert_and_get_chunk() {
        let (repo, agent_id) = setup_test_db_with_agent().await;

        let embedding = vec![0.1, 0.2, 0.3, 0.4];
        let chunk = repo
            .insert_chunk(
                &agent_id,
                "doc-1",
                0,
                "This is test content",
                &embedding,
                Some(r#"{"type": "text"}"#),
                None,
                None,
            )
            .await
            .unwrap();

        assert_eq!(chunk.agent_id, agent_id);
        assert_eq!(chunk.document_id, "doc-1");
        assert_eq!(chunk.content, "This is test content");

        let fetched = repo.get_by_id(&chunk.id).await.unwrap().unwrap();
        assert_eq!(fetched.id, chunk.id);
    }

    #[tokio::test]
    async fn test_search_similar() {
        let (repo, agent_id) = setup_test_db_with_agent().await;

        // 插入几个向量
        let embedding1 = vec![1.0, 0.0, 0.0, 0.0];
        let embedding2 = vec![0.9, 0.1, 0.0, 0.0]; // 与 embedding1 相似
        let embedding3 = vec![0.0, 0.0, 1.0, 0.0]; // 与 embedding1 不相似

        repo.insert_chunk(
            &agent_id,
            "doc-1",
            0,
            "Content 1",
            &embedding1,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        repo.insert_chunk(
            &agent_id,
            "doc-1",
            1,
            "Content 2",
            &embedding2,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        repo.insert_chunk(
            &agent_id,
            "doc-1",
            2,
            "Content 3",
            &embedding3,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        // 搜索与 embedding1 相似的
        let query = vec![1.0, 0.0, 0.0, 0.0];
        let results = repo
            .search_similar(&agent_id, &query, 2, 0.5, None, LEGACY_EMBEDDING_PROFILE_ID)
            .await
            .unwrap();

        assert_eq!(results.len(), 2);
        assert!(results[0].score > results[1].score); // 第一个应该分数更高
    }

    #[tokio::test]
    async fn test_get_stats() {
        let (repo, agent_id) = setup_test_db_with_agent().await;

        let embedding = vec![0.1, 0.2, 0.3];

        repo.insert_chunk(
            &agent_id,
            "doc-1",
            0,
            "Content 1",
            &embedding,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        repo.insert_chunk(
            &agent_id,
            "doc-1",
            1,
            "Content 2",
            &embedding,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        repo.insert_chunk(
            &agent_id,
            "doc-2",
            0,
            "Content 3",
            &embedding,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        let stats = repo.get_stats(&agent_id).await.unwrap();

        assert_eq!(stats.document_count, 2);
        assert_eq!(stats.chunk_count, 3);
    }

    #[tokio::test]
    async fn test_list_knowledge_chunks_for_bm25_keeps_memory_prefixed_knowledge_docs() {
        let (repo, agent_id) = setup_test_db_with_agent().await;

        let embedding = vec![0.1, 0.2, 0.3];
        repo.insert_chunk(
            &agent_id,
            "memory_notes.md",
            0,
            "Knowledge content",
            &embedding,
            Some(r#"{"documentType":"text","fileName":"memory_notes.md"}"#),
            None,
            Some("chunk-knowledge"),
        )
        .await
        .unwrap();
        repo.insert_chunk(
            &agent_id,
            "memory_summary_1",
            0,
            "Memory content",
            &embedding,
            Some(r#"{"memoryType":"summary"}"#),
            None,
            Some("chunk-memory"),
        )
        .await
        .unwrap();

        let chunks = repo
            .list_knowledge_chunks_for_bm25(&agent_id)
            .await
            .unwrap();

        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].id, "chunk-knowledge");
        assert_eq!(chunks[0].document_id, "memory_notes.md");
        assert_eq!(chunks[0].content, "Knowledge content");
        assert_eq!(chunks[1].id, "chunk-memory");
        assert_eq!(chunks[1].document_id, "memory_summary_1");
    }

    #[tokio::test]
    async fn test_search_filters_embedding_profiles_and_preserves_legacy_vectors() {
        let (repo, agent_id) = setup_test_db_with_agent().await;
        let embedding = vec![1.0, 0.0];

        repo.insert_chunk(
            &agent_id,
            "legacy-doc",
            0,
            "Legacy",
            &embedding,
            Some(r#"{"type":"text"}"#),
            None,
            Some("legacy-chunk"),
        )
        .await
        .unwrap();
        repo.insert_chunk(
            &agent_id,
            "custom-doc",
            0,
            "Custom",
            &embedding,
            Some(
                r#"{"embeddingProfileId":"rag-embedding:v1:custom:model-a","embeddingDimension":2}"#,
            ),
            None,
            Some("custom-chunk"),
        )
        .await
        .unwrap();
        repo.insert_chunk(
            &agent_id,
            "invalid-doc",
            0,
            "Invalid profile type",
            &embedding,
            Some(r#"{"embeddingProfileId":42}"#),
            None,
            Some("invalid-chunk"),
        )
        .await
        .unwrap();

        let legacy = repo
            .search_similar(
                &agent_id,
                &embedding,
                10,
                0.0,
                None,
                LEGACY_EMBEDDING_PROFILE_ID,
            )
            .await
            .unwrap();
        assert_eq!(legacy.len(), 1);
        assert_eq!(legacy[0].chunk_id, "legacy-chunk");

        let custom = repo
            .search_similar(
                &agent_id,
                &embedding,
                10,
                0.0,
                None,
                "rag-embedding:v1:custom:model-a",
            )
            .await
            .unwrap();
        assert_eq!(custom.len(), 1);
        assert_eq!(custom[0].chunk_id, "custom-chunk");
    }

    #[tokio::test]
    async fn test_search_rejects_dimension_mismatches_even_with_negative_threshold() {
        let (repo, agent_id) = setup_test_db_with_agent().await;
        let profile_id = "rag-embedding:v1:custom:model-a";

        repo.insert_chunk(
            &agent_id,
            "valid-doc",
            0,
            "Valid",
            &[1.0, 0.0],
            Some(
                r#"{"embeddingProfileId":"rag-embedding:v1:custom:model-a","embeddingDimension":2}"#,
            ),
            None,
            Some("valid-chunk"),
        )
        .await
        .unwrap();
        repo.insert_chunk(
            &agent_id,
            "wrong-vector-dimension",
            0,
            "Wrong vector dimension",
            &[1.0, 0.0, 0.0],
            Some(
                r#"{"embeddingProfileId":"rag-embedding:v1:custom:model-a","embeddingDimension":3}"#,
            ),
            None,
            Some("wrong-vector-dimension"),
        )
        .await
        .unwrap();
        repo.insert_chunk(
            &agent_id,
            "wrong-metadata-dimension",
            0,
            "Wrong metadata dimension",
            &[1.0, 0.0],
            Some(
                r#"{"embeddingProfileId":"rag-embedding:v1:custom:model-a","embeddingDimension":3}"#,
            ),
            None,
            Some("wrong-metadata-dimension"),
        )
        .await
        .unwrap();
        repo.insert_chunk(
            &agent_id,
            "invalid-metadata-dimension",
            0,
            "Invalid metadata dimension",
            &[1.0, 0.0],
            Some(
                r#"{"embeddingProfileId":"rag-embedding:v1:custom:model-a","embeddingDimension":0}"#,
            ),
            None,
            Some("invalid-metadata-dimension"),
        )
        .await
        .unwrap();
        repo.insert_chunk(
            &agent_id,
            "missing-metadata-dimension",
            0,
            "Missing custom metadata dimension",
            &[1.0, 0.0],
            Some(r#"{"embeddingProfileId":"rag-embedding:v1:custom:model-a"}"#),
            None,
            Some("missing-metadata-dimension"),
        )
        .await
        .unwrap();

        let results = repo
            .search_similar(&agent_id, &[1.0, 0.0], 10, -1.0, None, profile_id)
            .await
            .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].chunk_id, "valid-chunk");
    }

    #[tokio::test]
    async fn test_batch_embedding_update_is_atomic_and_lists_vector_agents() {
        let (repo, agent_id) = setup_test_db_with_agent().await;
        let first = repo
            .insert_chunk(
                &agent_id,
                "doc",
                0,
                "First",
                &[1.0, 0.0],
                Some(r#"{"type":"text"}"#),
                None,
                Some("first"),
            )
            .await
            .unwrap();
        repo.insert_chunk(
            &agent_id,
            "doc",
            1,
            "Second",
            &[0.0, 1.0],
            Some(r#"{"type":"text"}"#),
            None,
            Some("second"),
        )
        .await
        .unwrap();

        let metadata =
            r#"{"embeddingProfileId":"rag-embedding:v1:custom:model-b","embeddingDimension":3}"#;
        let failed = repo
            .batch_update_chunk_embeddings(
                &agent_id,
                &[
                    ChunkEmbeddingUpdate {
                        chunk_id: "first".to_string(),
                        embedding: vec![0.5, 0.5, 0.0],
                        metadata_json: metadata.to_string(),
                    },
                    ChunkEmbeddingUpdate {
                        chunk_id: "missing".to_string(),
                        embedding: vec![0.0, 0.5, 0.5],
                        metadata_json: metadata.to_string(),
                    },
                ],
            )
            .await;
        assert!(failed.is_err());

        let unchanged = repo.get_by_id(&first.id).await.unwrap().unwrap();
        assert_eq!(
            bytes_to_f32_vec(unchanged.embedding.as_deref().unwrap()),
            vec![1.0, 0.0]
        );
        assert_eq!(
            unchanged.metadata_json,
            Some(r#"{"type":"text"}"#.to_string())
        );

        let updated = repo
            .batch_update_chunk_embeddings(
                &agent_id,
                &[
                    ChunkEmbeddingUpdate {
                        chunk_id: "first".to_string(),
                        embedding: vec![0.5, 0.5, 0.0],
                        metadata_json: metadata.to_string(),
                    },
                    ChunkEmbeddingUpdate {
                        chunk_id: "second".to_string(),
                        embedding: vec![0.0, 0.5, 0.5],
                        metadata_json: metadata.to_string(),
                    },
                ],
            )
            .await
            .unwrap();
        assert_eq!(updated, 2);

        let first = repo.get_by_id("first").await.unwrap().unwrap();
        assert_eq!(
            bytes_to_f32_vec(first.embedding.as_deref().unwrap()),
            vec![0.5, 0.5, 0.0]
        );
        assert_eq!(first.metadata_json, Some(metadata.to_string()));
        assert_eq!(repo.list_vector_agent_ids().await.unwrap(), vec![agent_id]);
    }

    #[tokio::test]
    async fn test_cosine_similarity_function() {
        // 测试余弦相似度计算函数
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![1.0, 0.0, 0.0];
        assert!((cosine_similarity(&a, &b) - 1.0).abs() < 0.0001);

        let c = vec![1.0, 0.0, 0.0];
        let d = vec![0.0, 1.0, 0.0];
        assert!((cosine_similarity(&c, &d) - 0.0).abs() < 0.0001);

        let e = vec![1.0, 1.0, 0.0];
        let f = vec![1.0, 0.0, 0.0];
        let expected = 1.0 / 2.0_f32.sqrt(); // cos(45°) ≈ 0.707
        assert!((cosine_similarity(&e, &f) - expected).abs() < 0.0001);
    }
}
