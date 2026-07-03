//! 网络搜索命令模块
//!
//! Tavily 是首选搜索提供方；当未配置 Tavily Key、Tavily 限流/超时/服务异常或返回空结果时，
//! 自动降级到本地 Python runtime 中的 DDGS helper。DDGS 子进程通过 Network Broker 代理出网，
//! 保持与原生工具一致的网络审计和沙箱策略。

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Instant;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio::time::{timeout, Duration};

use super::embedded_python_setup::prepare_prebuilt_python_runtime;
use super::network_broker::{
    execute_broker_http_request, start_network_broker_proxy_session_with_auth, BrokerHttpMethod,
    BrokerHttpRequest,
};
use super::process_sandbox::{
    network_broker_audit_event, record_sandbox_audit_event, NetworkBrokerAuditDetails,
    NetworkBrokerAuditSubject,
};
use crate::crypto::{Keystore, WindowsKeystore};
use crate::error::{AppError, CommandResult};
use crate::AppState;

const TAVILY_PROVIDER: &str = "tavily";
const DDGS_PROVIDER: &str = "ddgs";
const TAVILY_SEARCH_ENDPOINT: &str = "https://api.tavily.com/search";
const DEFAULT_MAX_RESULTS: i32 = 5;
const MAX_RESULTS_LIMIT: i32 = 10;
const TAVILY_TIMEOUT_MS: u64 = 30_000;
const DDGS_TIMEOUT_BASIC_MS: u64 = 45_000;
const DDGS_TIMEOUT_ADVANCED_MS: u64 = 90_000;
const DDGS_TIMEOUT_WITH_CONTENT_MS: u64 = 75_000;
const DDGS_TIMEOUT_ADVANCED_WITH_CONTENT_MS: u64 = 120_000;
const DEFAULT_DDGS_MAX_CONCURRENT_FALLBACKS: usize = 2;

static DDGS_FALLBACK_SEMAPHORE: Lazy<Semaphore> = Lazy::new(|| {
    let limit = std::env::var("AGENTVIS_DDGS_MAX_CONCURRENT_FALLBACKS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(DEFAULT_DDGS_MAX_CONCURRENT_FALLBACKS)
        .clamp(1, 4);
    Semaphore::new(limit)
});

#[derive(Debug, Clone)]
struct SearchOptions {
    query: String,
    max_results: i32,
    search_depth: String,
    include_raw_content: bool,
}

/// 网络搜索结果
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct WebSearchResult {
    /// 结果标题
    pub title: String,
    /// 结果 URL
    pub url: String,
    /// 结果摘要
    pub content: String,
    /// 相关性分数 (0-1)
    pub score: f64,
    /// 页面清洗后的完整内容，仅 include_raw_content 开启时返回
    #[serde(default)]
    pub raw_content: Option<String>,
    /// 搜索提供方
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// DDGS 聚合后的底层来源，Tavily 结果为空
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// 后端搜索诊断信息
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct WebSearchDiagnostic {
    pub level: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct TavilyApiResponse {
    results: Vec<WebSearchResult>,
    answer: Option<String>,
}

#[derive(Debug, Serialize)]
struct TavilyApiRequest {
    api_key: String,
    query: String,
    search_depth: String,
    include_answer: bool,
    max_results: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    include_raw_content: Option<String>,
}

#[derive(Debug, Serialize)]
struct DdgsHelperRequest {
    query: String,
    max_results: i32,
    search_depth: String,
    include_raw_content: bool,
}

#[derive(Debug, Deserialize)]
struct DdgsHelperResponse {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    results: Vec<WebSearchResult>,
    #[serde(default)]
    answer: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    diagnostics: Vec<WebSearchDiagnostic>,
    #[serde(default, rename = "errorKind")]
    error_kind: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

/// 网络搜索响应
#[derive(Debug, Serialize)]
pub struct WebSearchResponse {
    /// 搜索结果列表
    pub results: Vec<WebSearchResult>,
    /// AI 生成的答案摘要（可选）
    pub answer: Option<String>,
    /// 搜索查询
    pub query: String,
    /// 本次最终使用的 provider
    pub provider: String,
    /// 是否发生了 provider fallback
    pub fallback_used: bool,
    /// 后端诊断信息，供前端 data 使用
    pub diagnostics: Vec<WebSearchDiagnostic>,
}

#[tauri::command]
pub async fn web_search(
    app_handle: tauri::AppHandle,
    _state: State<'_, AppState>,
    query: String,
    max_results: Option<i32>,
    search_depth: Option<String>,
    include_raw_content: Option<bool>,
    sandbox_mode: Option<String>,
    allow_fallback: Option<bool>,
) -> CommandResult<WebSearchResponse> {
    let options = SearchOptions {
        query: query.clone(),
        max_results: normalize_max_results(max_results),
        search_depth: normalize_search_depth(search_depth.as_deref()),
        include_raw_content: include_raw_content.unwrap_or(false),
    };
    let fallback_allowed = allow_fallback.unwrap_or(true);
    let mut diagnostics = Vec::new();

    let keystore = WindowsKeystore::new();
    let api_key = keystore.get_api_key(TAVILY_PROVIDER)?;

    let Some(api_key) = api_key else {
        if !fallback_allowed {
            return Err(AppError::Generic(
                "Tavily API key is not configured. Configure it in Settings.".to_string(),
            ));
        }
        diagnostics.push(WebSearchDiagnostic {
            level: "info".to_string(),
            message: "Tavily API key is not configured; using DDGS fallback.".to_string(),
        });
        return run_ddgs_search(&app_handle, &options, sandbox_mode, true, diagnostics).await;
    };

    match call_tavily_search(&app_handle, api_key, &options, sandbox_mode.as_deref()).await {
        Ok(api_response) if !api_response.results.is_empty() => Ok(build_response(
            TAVILY_PROVIDER,
            options.query,
            api_response.results,
            api_response.answer,
            false,
            diagnostics,
        )),
        Ok(api_response) => {
            if !fallback_allowed {
                return Ok(build_response(
                    TAVILY_PROVIDER,
                    options.query,
                    api_response.results,
                    api_response.answer,
                    false,
                    diagnostics,
                ));
            }
            diagnostics.push(WebSearchDiagnostic {
                level: "info".to_string(),
                message: "Tavily returned no results; trying DDGS fallback.".to_string(),
            });
            match run_ddgs_search(
                &app_handle,
                &options,
                sandbox_mode,
                true,
                diagnostics.clone(),
            )
            .await
            {
                Ok(response) if !response.results.is_empty() => Ok(response),
                Ok(response) => Ok(response),
                Err(error) => {
                    let mut combined_diagnostics = diagnostics;
                    combined_diagnostics.push(WebSearchDiagnostic {
                        level: "warn".to_string(),
                        message: format!("DDGS fallback failed after empty Tavily response: {}", error),
                    });
                    Ok(build_response(
                        TAVILY_PROVIDER,
                        options.query,
                        api_response.results,
                        api_response.answer,
                        false,
                        combined_diagnostics,
                    ))
                }
            }
        }
        Err(error @ AppError::Forbidden(_)) => Err(error),
        Err(error) if fallback_allowed && should_use_ddgs_fallback_for_tavily_error(&error) => {
            diagnostics.push(WebSearchDiagnostic {
                level: "warn".to_string(),
                message: format!("Tavily failed; trying DDGS fallback: {}", error),
            });
            match run_ddgs_search(&app_handle, &options, sandbox_mode, true, diagnostics).await {
                Ok(response) => Ok(response),
                Err(ddgs_error) => Err(AppError::LlmApi(format!(
                    "Tavily failed and DDGS fallback failed. Tavily: {}; DDGS: {}",
                    error, ddgs_error
                ))),
            }
        }
        Err(error) => Err(error),
    }
}

async fn call_tavily_search(
    app_handle: &tauri::AppHandle,
    api_key: String,
    options: &SearchOptions,
    sandbox_mode: Option<&str>,
) -> CommandResult<TavilyApiResponse> {
    let request = TavilyApiRequest {
        api_key,
        query: options.query.clone(),
        search_depth: options.search_depth.clone(),
        include_answer: true,
        max_results: options.max_results,
        include_raw_content: if options.include_raw_content {
            Some("markdown".to_string())
        } else {
            None
        },
    };

    let request_body = serde_json::to_vec(&request)?;
    let request_bytes_out = request_body.len() as u64;
    let broker_started = Instant::now();

    let broker_response = match execute_broker_http_request(BrokerHttpRequest {
        method: BrokerHttpMethod::Post,
        url: TAVILY_SEARCH_ENDPOINT.to_string(),
        headers: vec![("content-type".to_string(), "application/json".to_string())],
        body: request_body,
        timeout_ms: Some(TAVILY_TIMEOUT_MS),
        credential: None,
    })
    .await
    {
        Ok(response) => response,
        Err(error @ AppError::Forbidden(_)) => {
            if let Some(event) = network_broker_audit_event(
                "web_search",
                sandbox_mode,
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
                record_sandbox_audit_event(app_handle, event);
            }
            return Err(error);
        }
        Err(error) => return Err(error),
    };

    if let Some(event) = network_broker_audit_event(
        "web_search",
        sandbox_mode,
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
        record_sandbox_audit_event(app_handle, event);
    }

    if !(200..300).contains(&broker_response.status) {
        let status = broker_response.status;
        let error_text = String::from_utf8_lossy(&broker_response.body);
        return Err(AppError::LlmApi(format!(
            "Tavily API returned error {}: {}",
            status, error_text
        )));
    }

    let mut api_response: TavilyApiResponse = serde_json::from_slice(&broker_response.body)
        .map_err(|error| AppError::LlmApi(format!("Failed to parse Tavily response: {}", error)))?;
    for result in &mut api_response.results {
        result.provider = Some(TAVILY_PROVIDER.to_string());
    }
    Ok(api_response)
}

async fn run_ddgs_search(
    app_handle: &tauri::AppHandle,
    options: &SearchOptions,
    sandbox_mode: Option<String>,
    fallback_used: bool,
    mut diagnostics: Vec<WebSearchDiagnostic>,
) -> CommandResult<WebSearchResponse> {
    let runtime = prepare_prebuilt_python_runtime(app_handle.clone()).await?;
    let script_path = resolve_ddgs_helper_script(app_handle)?;
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|error| AppError::FileSystem(format!("Failed to get resource_dir: {}", error)))?;

    let _ddgs_fallback_permit = DDGS_FALLBACK_SEMAPHORE
        .acquire()
        .await
        .map_err(|_| AppError::Generic("DDGS fallback concurrency gate was closed.".to_string()))?;

    let proxy_session = start_network_broker_proxy_session_with_auth(
        app_handle.clone(),
        sandbox_mode,
        NetworkBrokerAuditSubject::native_tool("web_search"),
        true,
    )
    .await?;
    let proxy_url = proxy_session.proxy_url_with_credentials();
    let browser_proxy_server = proxy_session.proxy_url();
    let proxy_username = proxy_session.proxy_username().to_string();
    let proxy_password = proxy_session.proxy_password().to_string();

    let request = DdgsHelperRequest {
        query: options.query.clone(),
        max_results: options.max_results,
        search_depth: options.search_depth.clone(),
        include_raw_content: options.include_raw_content,
    };
    let request_body = serde_json::to_vec(&request)?;

    let mut command = Command::new(runtime.python_exe);
    command
        .arg(script_path)
        .env("PYTHONUTF8", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("AGENTVIS_RESOURCE_DIR", resource_dir)
        .env("AGENTVIS_NETWORK_PROXY_URL", &proxy_url)
        .env("AGENTVIS_NETWORK_PROXY_MODE", "broker")
        .env("AGENTVIS_NETWORK_PROXY_USERNAME", &proxy_username)
        .env("AGENTVIS_NETWORK_PROXY_PASSWORD", &proxy_password)
        .env("AGENTVIS_BROWSER_PROXY_SERVER", &browser_proxy_server)
        .env("AGENTVIS_BROWSER_PROXY_USERNAME", &proxy_username)
        .env("AGENTVIS_BROWSER_PROXY_PASSWORD", &proxy_password)
        .env("HTTP_PROXY", &proxy_url)
        .env("HTTPS_PROXY", &proxy_url)
        .env("ALL_PROXY", &proxy_url)
        .env("http_proxy", &proxy_url)
        .env("https_proxy", &proxy_url)
        .env("all_proxy", &proxy_url)
        .env("NO_PROXY", "")
        .env("no_proxy", "")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.kill_on_drop(true);
    apply_no_window(&mut command);

    let mut child = command.spawn().map_err(|error| {
        AppError::Generic(format!("Failed to start DDGS fallback helper: {}", error))
    })?;

    let Some(mut stdin) = child.stdin.take() else {
        return Err(AppError::Generic(
            "Failed to open DDGS fallback helper stdin.".to_string(),
        ));
    };
    stdin.write_all(&request_body).await.map_err(|error| {
        AppError::Generic(format!("Failed to send DDGS fallback request: {}", error))
    })?;
    drop(stdin);

    let run_timeout = match (
        options.search_depth.as_str(),
        options.include_raw_content,
    ) {
        ("advanced", true) => DDGS_TIMEOUT_ADVANCED_WITH_CONTENT_MS,
        ("advanced", false) => DDGS_TIMEOUT_ADVANCED_MS,
        (_, true) => DDGS_TIMEOUT_WITH_CONTENT_MS,
        _ => DDGS_TIMEOUT_BASIC_MS,
    };
    let output = timeout(Duration::from_millis(run_timeout), child.wait_with_output())
        .await
        .map_err(|_| AppError::LlmApi("DDGS fallback timed out.".to_string()))?
        .map_err(|error| AppError::Generic(format!("DDGS fallback helper failed: {}", error)))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let helper_response: DdgsHelperResponse = serde_json::from_str(&stdout).map_err(|error| {
        AppError::LlmApi(format!(
            "Failed to parse DDGS fallback response: {}. stdout='{}' stderr='{}'",
            error,
            truncate_for_error(&stdout),
            truncate_for_error(&stderr)
        ))
    })?;

    diagnostics.extend(helper_response.diagnostics);
    if !stderr.is_empty() {
        diagnostics.push(WebSearchDiagnostic {
            level: "warn".to_string(),
            message: format!("DDGS helper stderr: {}", truncate_for_error(&stderr)),
        });
    }

    if !output.status.success() || !helper_response.ok {
        let kind = helper_response
            .error_kind
            .unwrap_or_else(|| "provider_error".to_string());
        let detail = helper_response
            .error
            .unwrap_or_else(|| format!("process exited with status {}", output.status));
        return Err(AppError::LlmApi(format!(
            "DDGS fallback returned error {}: {}",
            kind, detail
        )));
    }

    let provider = helper_response
        .provider
        .unwrap_or_else(|| DDGS_PROVIDER.to_string());
    Ok(build_response(
        &provider,
        options.query.clone(),
        helper_response.results,
        helper_response.answer,
        fallback_used,
        diagnostics,
    ))
}

fn build_response(
    provider: &str,
    query: String,
    mut results: Vec<WebSearchResult>,
    answer: Option<String>,
    fallback_used: bool,
    diagnostics: Vec<WebSearchDiagnostic>,
) -> WebSearchResponse {
    for result in &mut results {
        if result.provider.is_none() {
            result.provider = Some(provider.to_string());
        }
    }
    WebSearchResponse {
        results,
        answer,
        query,
        provider: provider.to_string(),
        fallback_used,
        diagnostics,
    }
}

fn resolve_ddgs_helper_script(app_handle: &tauri::AppHandle) -> CommandResult<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        candidates.push(
            resource_dir
                .join("native-scripts")
                .join("web-search")
                .join("ddgs_search.py"),
        );
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("native-scripts")
            .join("web-search")
            .join("ddgs_search.py"),
    );

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| AppError::NotFound("DDGS fallback helper was not found.".to_string()))
}

fn normalize_search_depth(value: Option<&str>) -> String {
    match value {
        Some("advanced") => "advanced".to_string(),
        _ => "basic".to_string(),
    }
}

fn normalize_max_results(value: Option<i32>) -> i32 {
    value
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, MAX_RESULTS_LIMIT)
}

fn should_use_ddgs_fallback_for_tavily_error(error: &AppError) -> bool {
    match error {
        AppError::Forbidden(_) => false,
        AppError::LlmApi(message) => {
            if let Some(status) = parse_tavily_status(message) {
                return matches!(status, 401 | 403 | 408 | 429 | 500..=599);
            }
            is_retryable_tavily_message(message)
                || message
                    .to_ascii_lowercase()
                    .contains("failed to parse tavily response")
        }
        AppError::Generic(message) => is_retryable_tavily_message(message),
        _ => false,
    }
}

fn is_retryable_tavily_message(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("network broker request failed")
        || normalized.contains("network broker dns lookup failed")
        || normalized.contains("dns error")
        || normalized.contains("failed to lookup address")
        || normalized.contains("could not resolve host")
        || normalized.contains("no such host")
        || normalized.contains("timed out")
        || normalized.contains("timeout")
        || normalized.contains("deadline has elapsed")
        || normalized.contains("error sending request")
        || normalized.contains("connection refused")
        || normalized.contains("connection reset")
        || normalized.contains("tcp connect error")
}

fn parse_tavily_status(message: &str) -> Option<u16> {
    let marker = "Tavily API returned error ";
    let marker_start = message.find(marker)? + marker.len();
    let digits: String = message[marker_start..]
        .chars()
        .take_while(|char| char.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

fn truncate_for_error(value: &str) -> String {
    const LIMIT: usize = 800;
    if value.chars().count() <= LIMIT {
        return value.to_string();
    }
    format!("{}...", value.chars().take(LIMIT).collect::<String>())
}

#[cfg(windows)]
fn apply_no_window(command: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn apply_no_window(_command: &mut Command) {}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tavily_status_from_provider_error() {
        assert_eq!(
            parse_tavily_status("Tavily API returned error 429: too many requests"),
            Some(429)
        );
        assert_eq!(parse_tavily_status("unrelated"), None);
    }

    #[test]
    fn falls_back_for_retryable_tavily_errors() {
        assert!(should_use_ddgs_fallback_for_tavily_error(&AppError::LlmApi(
            "Tavily API returned error 429: too many requests".to_string()
        )));
        assert!(should_use_ddgs_fallback_for_tavily_error(&AppError::LlmApi(
            "Failed to parse Tavily response: expected value".to_string()
        )));
        assert!(!should_use_ddgs_fallback_for_tavily_error(&AppError::LlmApi(
            "Tavily API returned error 422: invalid query".to_string()
        )));
        assert!(!should_use_ddgs_fallback_for_tavily_error(&AppError::Forbidden(
            "sandbox blocked".to_string()
        )));
    }

    #[test]
    fn clamps_max_results_for_all_providers() {
        assert_eq!(normalize_max_results(None), 5);
        assert_eq!(normalize_max_results(Some(-2)), 1);
        assert_eq!(normalize_max_results(Some(50)), 10);
    }
}
