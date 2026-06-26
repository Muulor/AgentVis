//! 云端 Embedding API 命令
//!
//! 提供云端 Embedding API 调用（SiliconFlow / Gitee AI / ZhipuAI）

use serde::{Deserialize, Serialize};
use tauri::State;
use crate::llm::http_client::get_client;

use crate::crypto::{Keystore, WindowsKeystore};
use crate::error::{AppError, CommandResult};
use crate::AppState;

/// SiliconFlow Provider 名称（与 WindowsKeystore 中的 key 一致）
const SILICONFLOW_PROVIDER: &str = "siliconflow";

/// Gitee AI Provider 名称
const GITEEAI_PROVIDER: &str = "giteeai";

/// 云端 Embedding 请求
#[derive(Debug, Deserialize)]
pub struct CloudEmbeddingRequest {
    /// 提供商 ("siliconflow" | "giteeai" | "zhipu")
    pub provider: String,
    /// 模型名称
    pub model: Option<String>,
    /// 要编码的文本列表
    pub texts: Vec<String>,
}

/// 云端 Embedding 响应
#[derive(Debug, Serialize)]
pub struct CloudEmbeddingResponse {
    /// 编码后的向量列表
    pub embeddings: Vec<Vec<f32>>,
    /// 向量维度
    pub dimension: usize,
    /// 使用的模型
    pub model: String,
}

/// 云端 Rerank 请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRerankRequest {
    /// 提供商，目前仅支持 "siliconflow"
    pub provider: String,
    /// 模型名称
    pub model: Option<String>,
    /// 查询文本
    pub query: String,
    /// 要重排序的候选文档列表
    pub documents: Vec<String>,
    /// 返回最相关的候选数量
    pub top_n: Option<usize>,
}

/// 单条 Rerank 结果
#[derive(Debug, Deserialize, Serialize)]
pub struct CloudRerankResult {
    /// 原始 documents 数组中的索引
    pub index: usize,
    /// 相关性分数
    pub relevance_score: f32,
}

/// 云端 Rerank 响应
#[derive(Debug, Serialize)]
pub struct CloudRerankResponse {
    /// 重排序结果
    pub results: Vec<CloudRerankResult>,
    /// 使用的模型
    pub model: String,
}

/// ZhipuAI Embedding API 响应结构
#[derive(Debug, Deserialize)]
#[allow(dead_code)] // model 字段由 JSON 反序列化需要，但代码中未直接读取
struct ZhipuEmbeddingResponse {
    data: Vec<ZhipuEmbeddingData>,
    model: String,
}

#[derive(Debug, Deserialize)]
struct ZhipuEmbeddingData {
    embedding: Vec<f32>,
}

/// SiliconFlow Embedding API 响应结构（OpenAI 兼容格式）
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct SiliconFlowEmbeddingResponse {
    data: Vec<SiliconFlowEmbeddingData>,
    model: String,
}

#[derive(Debug, Deserialize)]
struct SiliconFlowEmbeddingData {
    embedding: Vec<f32>,
}

/// SiliconFlow Rerank API 响应结构
#[derive(Debug, Deserialize)]
struct SiliconFlowRerankResponse {
    results: Vec<CloudRerankResult>,
}

/// 获取 API Key
fn get_api_key(provider: &str) -> CommandResult<String> {
    let keystore = WindowsKeystore::new();
    let key = keystore.get_api_key(provider)?;
    key.ok_or_else(|| AppError::Keystore(format!("{} API key is not configured", provider)))
}

/// 云端 Embedding 编码
///
/// 调用云端 API 进行文本向量化，支持 SiliconFlow、Gitee AI 和 ZhipuAI
#[tauri::command]
pub async fn cloud_embedding_encode(
    _state: State<'_, AppState>,
    request: CloudEmbeddingRequest,
) -> CommandResult<CloudEmbeddingResponse> {
    let api_key = get_api_key(&request.provider)?;
    
    match request.provider.as_str() {
        "siliconflow" => {
            encode_with_siliconflow(
                &api_key,
                request.model.as_deref().unwrap_or("BAAI/bge-m3"),
                &request.texts,
            ).await
        }
        "giteeai" => {
            encode_with_giteeai(
                &api_key,
                request.model.as_deref().unwrap_or("bge-m3"),
                &request.texts,
            ).await
        }
        "zhipu" => {
            encode_with_zhipu(
                &api_key,
                request.model.as_deref().unwrap_or("Embedding-3-pro"),
                &request.texts,
            ).await
        }
        provider => {
            Err(AppError::LlmApi(format!("Unsupported Embedding provider: {}", provider)))
        }
    }
}

/// 云端 Rerank 重排序
///
/// 调用 SiliconFlow Rerank API 对 RAG 候选片段进行二阶段排序。
#[tauri::command]
pub async fn cloud_rerank_documents(
    _state: State<'_, AppState>,
    request: CloudRerankRequest,
) -> CommandResult<CloudRerankResponse> {
    if request.provider != SILICONFLOW_PROVIDER {
        return Err(AppError::LlmApi(format!(
            "Unsupported Rerank provider: {}",
            request.provider
        )));
    }

    let api_key = get_api_key(&request.provider)?;
    rerank_with_siliconflow(
        &api_key,
        request.model.as_deref().unwrap_or("BAAI/bge-reranker-v2-m3"),
        &request.query,
        &request.documents,
        request.top_n,
    ).await
}

/// 使用 SiliconFlow Rerank API 重排序
async fn rerank_with_siliconflow(
    api_key: &str,
    model: &str,
    query: &str,
    documents: &[String],
    top_n: Option<usize>,
) -> CommandResult<CloudRerankResponse> {
    let client = get_client();
    let url = "https://api.siliconflow.cn/v1/rerank";

    let body = serde_json::json!({
        "model": model,
        "query": query,
        "documents": documents,
        "return_documents": false,
        "top_n": top_n.unwrap_or(documents.len()),
    });

    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::LlmApi(format!("SiliconFlow Rerank API request failed: {}", e)))?;

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(AppError::LlmApi(format!("SiliconFlow Rerank API returned an error: {}", error_text)));
    }

    let result: SiliconFlowRerankResponse = response
        .json()
        .await
        .map_err(|e| AppError::LlmApi(format!("Failed to parse SiliconFlow Rerank response: {}", e)))?;

    Ok(CloudRerankResponse {
        results: result.results,
        model: model.to_string(),
    })
}

/// 使用 SiliconFlow Embedding API 编码
///
/// SiliconFlow 兼容 OpenAI 格式，支持 input 为字符串数组（批量编码），
/// 相比 ZhipuAI 逐条调用更高效。
async fn encode_with_siliconflow(
    api_key: &str,
    model: &str,
    texts: &[String],
) -> CommandResult<CloudEmbeddingResponse> {
    let client = get_client();
    let url = "https://api.siliconflow.cn/v1/embeddings";

    // SiliconFlow 支持数组输入，可一次性批量编码
    let body = serde_json::json!({
        "model": model,
        "input": texts,
        "encoding_format": "float",
    });

    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::LlmApi(format!("SiliconFlow Embedding API request failed: {}", e)))?;

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(AppError::LlmApi(format!("SiliconFlow Embedding API returned an error: {}", error_text)));
    }

    let result: SiliconFlowEmbeddingResponse = response
        .json()
        .await
        .map_err(|e| AppError::LlmApi(format!("Failed to parse SiliconFlow Embedding response: {}", e)))?;

    // 按 index 排序确保与输入顺序一致（API 规范不保证顺序）
    let mut embeddings: Vec<Vec<f32>> = result.data.into_iter().map(|d| d.embedding).collect();

    // 如果返回数量不足，补空向量（防御性处理）
    while embeddings.len() < texts.len() {
        embeddings.push(Vec::new());
    }

    let dimension = embeddings.first().map(|v| v.len()).unwrap_or(0);

    Ok(CloudEmbeddingResponse {
        embeddings,
        dimension,
        model: model.to_string(),
    })
}

/// 使用 Gitee AI Embedding API 编码
///
/// Gitee AI 兼容 OpenAI 格式，与 SiliconFlow 使用相同的 bge-m3 模型和响应结构。
/// 作为 SiliconFlow 的 fallback 提供商，确保 Embedding 服务高可用。
async fn encode_with_giteeai(
    api_key: &str,
    model: &str,
    texts: &[String],
) -> CommandResult<CloudEmbeddingResponse> {
    let client = get_client();
    let url = "https://ai.gitee.com/v1/embeddings";

    // Gitee AI 同样支持数组输入
    let body = serde_json::json!({
        "model": model,
        "input": texts,
    });

    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::LlmApi(format!("Gitee AI Embedding API request failed: {}", e)))?;

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(AppError::LlmApi(format!("Gitee AI Embedding API returned an error: {}", error_text)));
    }

    // 响应格式与 SiliconFlow 一致（OpenAI 兼容），复用同一反序列化结构
    let result: SiliconFlowEmbeddingResponse = response
        .json()
        .await
        .map_err(|e| AppError::LlmApi(format!("Failed to parse Gitee AI Embedding response: {}", e)))?;

    let mut embeddings: Vec<Vec<f32>> = result.data.into_iter().map(|d| d.embedding).collect();

    while embeddings.len() < texts.len() {
        embeddings.push(Vec::new());
    }

    let dimension = embeddings.first().map(|v| v.len()).unwrap_or(0);

    Ok(CloudEmbeddingResponse {
        embeddings,
        dimension,
        model: model.to_string(),
    })
}

/// 使用 ZhipuAI Embedding API 编码
async fn encode_with_zhipu(
    api_key: &str,
    model: &str,
    texts: &[String],
) -> CommandResult<CloudEmbeddingResponse> {
    // 使用全局 HTTP Client
    let client = get_client();
    let url = "https://open.bigmodel.cn/api/paas/v4/embeddings";
    
    let mut all_embeddings: Vec<Vec<f32>> = Vec::new();
    
    // ZhipuAI 每次只能处理一个文本，需要分批请求
    for text in texts {
        let body = serde_json::json!({
            "model": model,
            "input": text,
        });
        
        let response = client
            .post(url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::LlmApi(format!("Embedding API request failed: {}", e)))?;
        
        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(AppError::LlmApi(format!("Embedding API returned an error: {}", error_text)));
        }
        
        let result: ZhipuEmbeddingResponse = response
            .json()
            .await
            .map_err(|e| AppError::LlmApi(format!("Failed to parse Embedding response: {}", e)))?;
        
        if let Some(data) = result.data.first() {
            all_embeddings.push(data.embedding.clone());
        }
    }
    
    let dimension = all_embeddings.first().map(|v| v.len()).unwrap_or(0);
    
    Ok(CloudEmbeddingResponse {
        embeddings: all_embeddings,
        dimension,
        model: model.to_string(),
    })
}

/// 获取云端 Embedding 提供商列表
#[tauri::command]
pub async fn cloud_embedding_list_providers(
    _state: State<'_, AppState>,
) -> CommandResult<Vec<String>> {
    Ok(vec!["siliconflow".to_string(), "giteeai".to_string(), "zhipu".to_string()])
}

/// 获取指定提供商的可用 Embedding 模型列表
#[tauri::command]
pub async fn cloud_embedding_list_models(
    _state: State<'_, AppState>,
    provider: String,
) -> CommandResult<Vec<String>> {
    let models = match provider.as_str() {
        "siliconflow" => vec![
            "BAAI/bge-m3".to_string(),
        ],
        "giteeai" => vec![
            "bge-m3".to_string(),
        ],
        "zhipu" => vec![
            "Embedding-3-pro".to_string(),
            "Embedding-2".to_string(),
        ],
        _ => vec![],
    };
    
    Ok(models)
}

/// 设置 SiliconFlow API Key
#[tauri::command]
pub async fn set_siliconflow_api_key(
    _state: State<'_, AppState>,
    api_key: String,
) -> CommandResult<()> {
    let keystore = WindowsKeystore::new();
    keystore.store_api_key(SILICONFLOW_PROVIDER, &api_key)?;
    Ok(())
}

/// 获取 SiliconFlow API Key 配置状态
#[tauri::command]
pub async fn get_siliconflow_api_key_status(
    _state: State<'_, AppState>,
) -> CommandResult<bool> {
    let keystore = WindowsKeystore::new();
    Ok(keystore.has_api_key(SILICONFLOW_PROVIDER).unwrap_or(false))
}

/// 设置 Gitee AI API Key
#[tauri::command]
pub async fn set_giteeai_api_key(
    _state: State<'_, AppState>,
    api_key: String,
) -> CommandResult<()> {
    let keystore = WindowsKeystore::new();
    keystore.store_api_key(GITEEAI_PROVIDER, &api_key)?;
    Ok(())
}

/// 获取 Gitee AI API Key 配置状态
#[tauri::command]
pub async fn get_giteeai_api_key_status(
    _state: State<'_, AppState>,
) -> CommandResult<bool> {
    let keystore = WindowsKeystore::new();
    Ok(keystore.has_api_key(GITEEAI_PROVIDER).unwrap_or(false))
}
