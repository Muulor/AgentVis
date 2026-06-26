//! Tavily 网络搜索模块
//!
//! 提供基于 Tavily API 的网络搜索功能
//! 支持基础搜索和深度搜索模式，可选获取页面完整内容

use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::State;

use super::network_broker::{execute_broker_http_request, BrokerHttpMethod, BrokerHttpRequest};
use super::process_sandbox::{
    network_broker_audit_event, record_sandbox_audit_event, NetworkBrokerAuditDetails,
};
use crate::crypto::{Keystore, WindowsKeystore};
use crate::error::{AppError, CommandResult};
use crate::AppState;

/// Tavily 搜索 Provider 名称
const TAVILY_PROVIDER: &str = "tavily";
const TAVILY_SEARCH_ENDPOINT: &str = "https://api.tavily.com/search";

/// Tavily API 响应中的搜索结果
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct TavilySearchResult {
    /// 结果标题
    pub title: String,
    /// 结果 URL
    pub url: String,
    /// 结果内容摘要（basic 模式为 NLP 摘要，advanced 模式为多段语义片段）
    pub content: String,
    /// 相关性分数 (0-1)
    pub score: f64,
    /// 页面清洁后的完整内容（仅当 include_raw_content 开启时返回）
    /// 格式由请求参数决定：Markdown 或纯文本
    #[serde(default)]
    pub raw_content: Option<String>,
}

/// Tavily API 响应
#[derive(Debug, Deserialize)]
struct TavilyApiResponse {
    /// 搜索结果列表
    results: Vec<TavilySearchResult>,
    /// 可选的回答（Tavily 可以生成摘要答案）
    answer: Option<String>,
}

/// Tavily 搜索请求
#[derive(Debug, Serialize)]
struct TavilyApiRequest {
    /// API Key
    api_key: String,
    /// 搜索查询
    query: String,
    /// 搜索深度 ("basic" | "advanced")
    /// - basic: 快速搜索，每个 URL 返回一段 NLP 摘要（1 API Credit）
    /// - advanced: 深度搜索，每个 URL 返回多段语义片段（2 API Credits）
    search_depth: String,
    /// 是否包含 LLM 生成的答案
    include_answer: bool,
    /// 返回结果数量
    max_results: i32,
    /// 是否获取页面清洁后的完整内容
    /// 值为 "markdown" 时返回 Markdown 格式，"text" 返回纯文本
    /// 未设置时不返回 raw_content
    #[serde(skip_serializing_if = "Option::is_none")]
    include_raw_content: Option<String>,
}

/// 网络搜索结果
#[derive(Debug, Serialize)]
pub struct WebSearchResponse {
    /// 搜索结果列表
    pub results: Vec<TavilySearchResult>,
    /// AI 生成的答案摘要（可选）
    pub answer: Option<String>,
    /// 搜索查询
    pub query: String,
}

/// 网络搜索命令
///
/// 使用 Tavily API 进行网络搜索
///
/// # 参数
/// - `query`: 搜索查询语句
/// - `max_results`: 最大结果数（默认 5）
/// - `search_depth`: 搜索深度，"basic"（默认）或 "advanced"
/// - `include_raw_content`: 是否获取页面完整内容（默认 false）
#[tauri::command]
pub async fn web_search(
    app_handle: tauri::AppHandle,
    _state: State<'_, AppState>,
    query: String,
    max_results: Option<i32>,
    search_depth: Option<String>,
    include_raw_content: Option<bool>,
    sandbox_mode: Option<String>,
) -> CommandResult<WebSearchResponse> {
    // 1. 获取 Tavily API Key
    let keystore = WindowsKeystore::new();
    let api_key = keystore.get_api_key(TAVILY_PROVIDER)?.ok_or_else(|| {
        AppError::Generic("Tavily API key is not configured. Configure it in Settings.".to_string())
    })?;

    // 2. 解析搜索深度参数，仅允许 "basic" 和 "advanced"，防止非法值
    let depth = match search_depth.as_deref() {
        Some("advanced") => "advanced",
        _ => "basic",
    };

    // 3. 解析 include_raw_content 参数
    // 开启时使用 Markdown 格式，便于 LLM 理解和引用
    let raw_content_format = if include_raw_content.unwrap_or(false) {
        Some("markdown".to_string())
    } else {
        None
    };

    // 4. 构建请求
    let request = TavilyApiRequest {
        api_key,
        query: query.clone(),
        search_depth: depth.to_string(),
        include_answer: true,
        max_results: max_results.unwrap_or(5),
        include_raw_content: raw_content_format,
    };

    let request_body = serde_json::to_vec(&request)?;
    let request_bytes_out = request_body.len() as u64;
    let broker_started = Instant::now();

    // 5. 通过主进程网络 Broker 调用 Tavily API
    let broker_response = match execute_broker_http_request(BrokerHttpRequest {
        method: BrokerHttpMethod::Post,
        url: TAVILY_SEARCH_ENDPOINT.to_string(),
        headers: vec![("content-type".to_string(), "application/json".to_string())],
        body: request_body,
        timeout_ms: Some(30_000),
        credential: None,
    })
    .await
    {
        Ok(response) => response,
        Err(error @ AppError::Forbidden(_)) => {
            if let Some(event) = network_broker_audit_event(
                "web_search",
                sandbox_mode.as_deref(),
                NetworkBrokerAuditDetails {
                    method: BrokerHttpMethod::Post.as_str().to_string(),
                    url: TAVILY_SEARCH_ENDPOINT.to_string(),
                    target_host: Some("api.tavily.com".to_string()),
                    target_scheme: Some("https".to_string()),
                    detail: None,
                    status_code: None,
                    bytes_in: 0,
                    bytes_out: request_bytes_out,
                    duration_ms: broker_started
                        .elapsed()
                        .as_millis()
                        .min(u128::from(u64::MAX)) as u64,
                    blocked_reason: Some(error.to_string()),
                },
            )? {
                record_sandbox_audit_event(&app_handle, event);
            }
            return Err(error);
        }
        Err(error) => return Err(error),
    };

    if let Some(event) = network_broker_audit_event(
        "web_search",
        sandbox_mode.as_deref(),
        NetworkBrokerAuditDetails {
            method: BrokerHttpMethod::Post.as_str().to_string(),
            url: broker_response.final_url.clone(),
            target_host: broker_response.target_host.clone(),
            target_scheme: Some(broker_response.target_scheme.clone()),
            detail: None,
            status_code: Some(broker_response.status),
            bytes_in: broker_response.body.len() as u64,
            bytes_out: request_bytes_out,
            duration_ms: broker_response.duration_ms,
            blocked_reason: None,
        },
    )? {
        record_sandbox_audit_event(&app_handle, event);
    }

    // 6. 检查响应状态
    if !(200..300).contains(&broker_response.status) {
        let status = broker_response.status;
        let error_text = String::from_utf8_lossy(&broker_response.body);
        return Err(AppError::LlmApi(format!(
            "Tavily API returned error {}: {}",
            status, error_text
        )));
    }

    // 7. 解析响应
    let api_response: TavilyApiResponse = serde_json::from_slice(&broker_response.body)
        .map_err(|e| AppError::LlmApi(format!("Failed to parse Tavily response: {}", e)))?;

    Ok(WebSearchResponse {
        results: api_response.results,
        answer: api_response.answer,
        query,
    })
}

/// 设置 Tavily API Key 命令
#[tauri::command]
pub async fn set_tavily_api_key(_state: State<'_, AppState>, api_key: String) -> CommandResult<()> {
    let keystore = WindowsKeystore::new();
    keystore.store_api_key(TAVILY_PROVIDER, &api_key)?;
    Ok(())
}

/// 获取 Tavily API Key 配置状态
#[tauri::command]
pub async fn get_tavily_api_key_status(_state: State<'_, AppState>) -> CommandResult<bool> {
    let keystore = WindowsKeystore::new();
    Ok(keystore.has_api_key(TAVILY_PROVIDER).unwrap_or(false))
}
