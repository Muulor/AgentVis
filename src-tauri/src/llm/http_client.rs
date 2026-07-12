//! 全局 HTTP 客户端模块
//!
//! 提供共享的 HTTP Client 实例，支持连接池和 HTTP/2。
//! 
//! ## 设计目标
//! 1. 避免每次请求创建新连接（TCP 握手 + TLS 握手开销）
//! 2. 复用 HTTP/2 多路复用能力
//! 3. 统一管理连接池配置
//! 
//! ## 使用方式
//! ```rust,no_run
//! # async fn run() -> Result<(), reqwest::Error> {
//! use agentvis_lib::llm::http_client::get_client;
//! 
//! let client = get_client();
//! let _response = client.get("https://api.example.com").send().await?;
//! # Ok(())
//! # }
//! ```

use once_cell::sync::Lazy;
use reqwest::Client;
use std::time::Duration;

// ==================== 配置 ====================

/// HTTP 连接池配置常量
mod config {
    /// 每个主机的最大空闲连接数
    pub const POOL_MAX_IDLE_PER_HOST: usize = 10;
    /// 空闲连接超时时间（秒）
    pub const POOL_IDLE_TIMEOUT_SECS: u64 = 60;
    /// 连接超时时间（秒）— 仅 TCP+TLS 握手阶段
    pub const CONNECT_TIMEOUT_SECS: u64 = 90;
    /// 请求超时时间（秒）— 包含等待响应的完整时长
    /// 大上下文请求的 LLM 推理可能超过 2min，
    /// 设为 8min 以覆盖大多数场景
    pub const REQUEST_TIMEOUT_SECS: u64 = 480;
    /// 流式响应空闲超时时间（秒）
    /// 流式请求不设置整请求总超时，只在连续无 SSE chunk 时判定卡死
    pub const STREAM_IDLE_TIMEOUT_SECS: u64 = 180;
    /// 流式建流超时时间（秒）
    /// 请求发出后，需要在该时间内收到响应头并拿到 SSE 响应体
    pub const STREAM_START_TIMEOUT_SECS: u64 = 300;
    /// TCP Keep-Alive 间隔（秒）
    pub const TCP_KEEPALIVE_SECS: u64 = 30;
    /// 是否强制使用 HTTP/2
    /// 注意：本地代理通常不支持 HTTP/2，设为 false 使用自动协商
    /// 云端 API (OpenAI/Anthropic/Gemini) 支持 HTTP/2，会自动协商升级
    pub const HTTP2_ONLY: bool = false;
}

// ==================== 全局 Client ====================

/// 全局共享 HTTP Client（惰性初始化）
/// 
/// 使用 `once_cell::sync::Lazy` 确保 Client 只被创建一次，
/// 且在首次访问时自动初始化。
static HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    build_default_client()
});

/// 全局共享流式 HTTP Client（不设置整请求总超时）
///
/// LLM 长文本输出可能持续超过普通请求的 8 分钟总时限。
/// 流式请求使用该 Client，并由 SSE 消费循环负责空闲超时判断。
static STREAMING_HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    build_streaming_client()
});

/// 构建默认配置的 HTTP Client
fn build_default_client() -> Client {
    build_client(Some(config::REQUEST_TIMEOUT_SECS))
}

/// 构建流式请求专用的 HTTP Client
fn build_streaming_client() -> Client {
    build_client(None)
}

/// 构建共享配置的 HTTP Client
fn build_client(request_timeout_secs: Option<u64>) -> Client {
    let mut builder = Client::builder()
        // 连接池配置
        .pool_max_idle_per_host(config::POOL_MAX_IDLE_PER_HOST)
        .pool_idle_timeout(Duration::from_secs(config::POOL_IDLE_TIMEOUT_SECS))
        // 超时配置：连接超时（仅握手）与请求超时（含等待响应）分离。
        // 流式 Client 不设置整请求超时，避免长输出被总时长切断。
        .connect_timeout(Duration::from_secs(config::CONNECT_TIMEOUT_SECS))
        // TCP 优化
        .tcp_keepalive(Duration::from_secs(config::TCP_KEEPALIVE_SECS))
        .tcp_nodelay(true)
        // 启用 gzip 压缩，减少长对话场景的请求/响应传输体积
        .gzip(true);

    if let Some(timeout_secs) = request_timeout_secs {
        builder = builder.timeout(Duration::from_secs(timeout_secs));
    }
    
    // HTTP/2 配置（阶段2启用）
    if config::HTTP2_ONLY {
        builder = builder.http2_prior_knowledge();
    }
    
    builder.build().expect("Failed to create global HTTP client")
}

/// 获取全局 HTTP Client 引用
/// 
/// 返回静态生命周期的 Client 引用，所有模块共享同一实例。
/// 
/// # 示例
/// ```rust,no_run
/// # async fn run() -> Result<(), reqwest::Error> {
/// use agentvis_lib::llm::http_client::get_client;
///
/// let client = get_client();
/// let _resp = client.get("https://api.openai.com/v1/models").send().await?;
/// # Ok(())
/// # }
/// ```
#[inline]
pub fn get_client() -> &'static Client {
    &HTTP_CLIENT
}

/// 获取流式请求专用 HTTP Client 引用
#[inline]
pub fn get_streaming_client() -> &'static Client {
    &STREAMING_HTTP_CLIENT
}

/// 获取流式响应空闲超时时长
#[inline]
pub fn stream_idle_timeout() -> Duration {
    Duration::from_secs(config::STREAM_IDLE_TIMEOUT_SECS)
}

/// 获取流式请求建流超时时长
#[inline]
pub fn stream_start_timeout() -> Duration {
    Duration::from_secs(config::STREAM_START_TIMEOUT_SECS)
}

/// Non-sensitive counters attached to streaming idle-timeout errors.
///
/// Keep diagnostics limited to protocol state and sizes. Prompt text, reasoning
/// text, tool names, and tool arguments must not be included in the error.
pub(super) struct StreamIdleDiagnostics<'a> {
    pub protocol: &'a str,
    pub events: u64,
    pub last_event: Option<&'a str>,
    pub content_chars: usize,
    pub reasoning_chars: usize,
    pub tool_calls: usize,
    pub tool_arg_bytes: usize,
}

pub(super) fn format_stream_idle_timeout(
    idle_timeout: Duration,
    diagnostics: StreamIdleDiagnostics<'_>,
) -> String {
    let phase = if diagnostics.tool_calls > 0 {
        "tool_arguments"
    } else if diagnostics.reasoning_chars > 0 {
        "reasoning"
    } else if diagnostics.content_chars > 0 {
        "content"
    } else {
        "awaiting_first_output"
    };

    format!(
        "Streaming response idle timeout (no data for {} seconds; protocol={}; events={}; last_event={}; phase={}; content_chars={}; reasoning_chars={}; tool_calls={}; tool_arg_bytes={})",
        idle_timeout.as_secs(),
        diagnostics.protocol,
        diagnostics.events,
        diagnostics.last_event.unwrap_or("none"),
        phase,
        diagnostics.content_chars,
        diagnostics.reasoning_chars,
        diagnostics.tool_calls,
        diagnostics.tool_arg_bytes,
    )
}

// ==================== 预热功能（阶段3） ====================

/// 预热常用 API 端点连接
/// 
/// 在应用启动时调用，提前建立 TCP/TLS 连接，
/// 使首次 API 请求无需等待连接建立。
/// 
/// 注意：预热使用 HEAD 请求，不消耗 API 配额。
pub async fn warmup_connections() {
    use futures::future::join_all;
    
    // 常用 API 端点列表（与 llm.rs 中的供应商 base_url 保持同步）
    let endpoints = [
        "https://api.openai.com/",
        "https://api.anthropic.com/",
        "https://generativelanguage.googleapis.com/",
        "https://open.bigmodel.cn/",
        "https://api.deepseek.com/",
        "https://token-plan-cn.xiaomimimo.com/",
        "https://api.tavily.com/",
        "https://ark.cn-beijing.volces.com/",
        "https://openrouter.ai/",
        "https://api.minimax.chat/",
    ];
    
    let client = get_client();
    
    // 并行预热所有端点
    let tasks: Vec<_> = endpoints
        .iter()
        .map(|url| async move {
            // 发送 HEAD 请求预热连接（忽略错误，预热失败不影响功能）
            let _ = client
                .head(*url)
                .timeout(Duration::from_secs(5))
                .send()
                .await;
        })
        .collect();
    
    join_all(tasks).await;
    
    log::debug!("[INFO] HTTP 连接预热完成");
}

// ==================== 测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_timeout_diagnostics_report_stream_phase_without_payload_content() {
        let message = format_stream_idle_timeout(
            Duration::from_secs(180),
            StreamIdleDiagnostics {
                protocol: "openai",
                events: 42,
                last_event: Some("message"),
                content_chars: 0,
                reasoning_chars: 512,
                tool_calls: 1,
                tool_arg_bytes: 8192,
            },
        );

        assert!(message.starts_with("Streaming response idle timeout (no data for 180 seconds;"));
        assert!(message.contains("protocol=openai"));
        assert!(message.contains("events=42"));
        assert!(message.contains("last_event=message"));
        assert!(message.contains("phase=tool_arguments"));
        assert!(message.contains("reasoning_chars=512"));
        assert!(message.contains("tool_arg_bytes=8192"));
    }

    #[test]
    fn test_get_client_returns_same_instance() {
        // 验证多次调用返回同一实例
        let client1 = get_client();
        let client2 = get_client();
        assert!(std::ptr::eq(client1, client2));
    }

    #[test]
    fn test_client_is_configured() {
        let client = get_client();
        // Client 应该被正确创建（不 panic）
        assert!(std::mem::size_of_val(client) > 0);
    }

    #[test]
    fn test_streaming_client_returns_same_instance() {
        let client1 = get_streaming_client();
        let client2 = get_streaming_client();
        assert!(std::ptr::eq(client1, client2));
    }
}
