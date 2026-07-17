//! LLM 相关 Tauri Commands
//!
//! 提供 LLM 聊天功能命令

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::error::Error as StdError;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

use crate::crypto::{Keystore, WindowsKeystore};
use crate::error::{AppError, AppResult, CommandResult};
use crate::llm::http_client::{
    get_client, get_streaming_client, stream_idle_timeout, stream_start_timeout,
};
use crate::llm::{AnthropicAdapter, GeminiAdapter, OpenAIAdapter};
use crate::llm::{
    ChatMessage, ChatRequest, ChatRole, LlmProvider, ProviderConfig, ReasoningPreset,
    ReasoningRoute,
};
use crate::AppState;

// ==================== 取消信号存储 ====================

/// 全局取消信号发送器存储
/// 键: session_id, 值: 当前活跃的取消通道列表
struct CancelRegistration {
    id: u64,
    attempt_id: Option<String>,
    sender: oneshot::Sender<()>,
}

static CANCEL_SENDERS: Lazy<Mutex<HashMap<String, Vec<CancelRegistration>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT_CANCEL_REGISTRATION_ID: AtomicU64 = AtomicU64::new(1);
const VOLCENGINE_STREAM_NO_USEFUL_PROGRESS_TIMEOUT_SECS: u64 = 120;

fn lock_cancel_senders() -> MutexGuard<'static, HashMap<String, Vec<CancelRegistration>>> {
    match CANCEL_SENDERS.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            log::error!("[LLM] cancel sender registry mutex was poisoned; recovering inner state");
            poisoned.into_inner()
        }
    }
}

fn stream_no_useful_progress_timeout(provider: &str) -> Option<Duration> {
    if provider == "volcengine" {
        Some(Duration::from_secs(
            VOLCENGINE_STREAM_NO_USEFUL_PROGRESS_TIMEOUT_SECS,
        ))
    } else {
        None
    }
}

fn apply_model_vision_support(
    config: ProviderConfig,
    supports_vision: Option<bool>,
) -> ProviderConfig {
    if matches!(supports_vision, Some(false)) {
        config.without_vision()
    } else {
        config
    }
}

fn apply_reasoning_route(config: ProviderConfig, provider_id: &str) -> ProviderConfig {
    config.with_reasoning_route(ReasoningRoute::for_provider_id(provider_id))
}

fn provider_config(
    api_key: String,
    supports_vision: Option<bool>,
    provider_id: &str,
) -> ProviderConfig {
    apply_reasoning_route(
        apply_model_vision_support(ProviderConfig::new(api_key), supports_vision),
        provider_id,
    )
}

fn register_cancel_sender(
    session_id: &str,
    attempt_id: Option<String>,
    sender: oneshot::Sender<()>,
) -> u64 {
    let registration_id = NEXT_CANCEL_REGISTRATION_ID.fetch_add(1, Ordering::Relaxed);
    let mut senders = lock_cancel_senders();
    let entry = senders.entry(session_id.to_string()).or_default();

    if !entry.is_empty() {
        log::warn!(
            "[LLM] duplicate cancel channel for session {} (existing: {}, new_registration: {})",
            session_id,
            entry.len(),
            registration_id
        );
    }

    entry.push(CancelRegistration {
        id: registration_id,
        attempt_id,
        sender,
    });

    registration_id
}

fn remove_cancel_sender(session_id: &str, registration_id: u64) {
    let mut senders = lock_cancel_senders();
    let mut removed = 0usize;
    let should_remove_session = if let Some(entries) = senders.get_mut(session_id) {
        let before = entries.len();
        entries.retain(|entry| entry.id != registration_id);
        removed = before.saturating_sub(entries.len());
        entries.is_empty()
    } else {
        false
    };

    if should_remove_session {
        senders.remove(session_id);
    }

    if removed > 0 {
        log::debug!(
            "[LLM] removed cancel channel for session {} (registration: {})",
            session_id,
            registration_id
        );
    }
}

fn cleanup_optional_cancel_sender(session_id: &Option<String>, registration_id: Option<u64>) {
    if let (Some(sid), Some(registration_id)) = (session_id.as_ref(), registration_id) {
        remove_cancel_sender(sid, registration_id);
    }
}

fn cancel_session(session_id: &str) -> usize {
    let entries = lock_cancel_senders().remove(session_id);
    match entries {
        Some(entries) => {
            let count = entries.len();
            for entry in entries {
                let _ = entry.sender.send(());
            }
            count
        }
        None => 0,
    }
}

fn cancel_attempt(session_id: &str, attempt_id: &str) -> usize {
    let matching_entries = {
        let mut senders = lock_cancel_senders();
        let Some(entries) = senders.remove(session_id) else {
            return 0;
        };
        let (matching, remaining): (Vec<_>, Vec<_>) = entries
            .into_iter()
            .partition(|entry| entry.attempt_id.as_deref() == Some(attempt_id));

        if !remaining.is_empty() {
            senders.insert(session_id.to_string(), remaining);
        }

        matching
    };

    let count = matching_entries.len();
    for entry in matching_entries {
        let _ = entry.sender.send(());
    }
    count
}

/// 聊天消息
#[derive(Debug, Serialize, Deserialize)]
pub struct ChatMessageDto {
    pub role: String,
    pub content: String,
    /// 图片附件（多模态支持）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<ImageAttachmentDto>>,
}

/// 图片附件 DTO
#[derive(Debug, Serialize, Deserialize)]
pub struct ImageAttachmentDto {
    /// MIME 类型，如 "image/jpeg", "image/png"
    pub mime_type: String,
    /// Base64 编码的图片数据
    pub data: String,
}

/// 图像生成配置 DTO
///
/// 注意：前端和 ChatRequestDto 均使用 snake_case，此处不做 camelCase 重命名
#[derive(Debug, Serialize, Deserialize)]
pub struct ImageConfigDto {
    /// 输出图片宽高比，如 "1:1"、"16:9"、"9:16" 等
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aspect_ratio: Option<String>,
    /// 输出图片分辨率，如 "512"、"1K"、"2K"、"4K"
    /// 仅 gemini-3.1-flash-image-preview 和 gemini-3-pro-image-preview 支持
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_size: Option<String>,
}

/// 聊天请求
#[derive(Debug, Deserialize)]
pub struct ChatRequestDto {
    pub provider: String,
    pub messages: Vec<ChatMessageDto>,
    pub model: Option<String>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    /// 推理强度语义档位；snake_case 与前端普通聊天请求保持一致。
    #[serde(default)]
    pub reasoning_preset: Option<ReasoningPreset>,
    /// 自定义 API 基址 URL（用于 Local 代理）
    pub base_url: Option<String>,
    /// 当前模型是否支持视觉输入。false 时后端会剥离 image_url 负载。
    pub supports_vision: Option<bool>,
    /// 响应输出类型（如 ["Text", "Image"] 或 ["Image"]），用于图像生成模型
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_modalities: Option<Vec<String>>,
    /// 图像生成配置（宽高比等）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_config: Option<ImageConfigDto>,
}

/// 聊天响应
#[derive(Debug, Serialize)]
pub struct ChatResponseDto {
    pub content: String,
    pub model: String,
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
}

/// 将 DTO 消息转换为内部格式
fn convert_messages(messages: Vec<ChatMessageDto>) -> Vec<ChatMessage> {
    use crate::llm::ImageAttachment;

    messages
        .into_iter()
        .map(|m| {
            let role = match m.role.as_str() {
                "system" => ChatRole::System,
                "user" => ChatRole::User,
                "assistant" => ChatRole::Assistant,
                _ => ChatRole::User,
            };

            // 转换图片附件
            let images = m.images.map(|imgs| {
                imgs.into_iter()
                    .map(|img| ImageAttachment {
                        mime_type: img.mime_type,
                        data: img.data,
                    })
                    .collect()
            });

            ChatMessage {
                role,
                content: m.content,
                images,
            }
        })
        .collect()
}

/// 获取 API Key
fn get_api_key(provider: &str) -> CommandResult<String> {
    let keystore = WindowsKeystore::new();
    let key = keystore.get_api_key(provider)?;
    key.ok_or_else(|| AppError::Keystore(format!("{} API key is not configured", provider)))
}

// ==================== GPT Image 2 generation via local OpenAI-compatible relay ====================

#[derive(Debug, Deserialize)]
pub struct GptImageGenerateRequest {
    pub prompt: String,
    pub model: Option<String>,
    pub session_id: Option<String>,
    pub aspect_ratio: Option<String>,
    pub image_size: Option<String>,
    pub quality: Option<String>,
    pub output_format: Option<String>,
    pub output_compression: Option<u8>,
    pub background: Option<String>,
    pub base_url: Option<String>,
    pub reference_images: Option<Vec<ImageAttachmentDto>>,
    pub stream: Option<bool>,
    pub partial_images: Option<u8>,
}

#[derive(Debug, Serialize)]
pub struct GptImageGenerateResponse {
    pub images_base64: Vec<String>,
    pub mime_type: String,
}

#[derive(Debug, serde::Deserialize)]
struct OpenAiImagesResponse {
    data: Option<Vec<OpenAiImageItem>>,
}

#[derive(Debug, serde::Deserialize)]
struct OpenAiImageItem {
    b64_json: Option<String>,
    url: Option<String>,
}

fn format_reqwest_error(error: &reqwest::Error) -> String {
    let mut details = vec![error.to_string()];
    let mut kinds = Vec::new();

    if error.is_timeout() {
        kinds.push("timeout");
    }
    if error.is_connect() {
        kinds.push("connect");
    }
    if error.is_request() {
        kinds.push("request");
    }
    if error.is_body() {
        kinds.push("body");
    }
    if error.is_decode() {
        kinds.push("decode");
    }

    if !kinds.is_empty() {
        details.push(format!("kind={}", kinds.join(",")));
    }

    if let Some(status) = error.status() {
        details.push(format!("status={}", status));
    }

    let mut source = StdError::source(error);
    while let Some(cause) = source {
        let cause_message = cause.to_string();
        if !details.iter().any(|detail| detail.contains(&cause_message)) {
            details.push(format!("caused by: {}", cause_message));
        }
        source = StdError::source(cause);
    }

    details.join("; ")
}

async fn collect_openai_image_stream(response: reqwest::Response) -> AppResult<Vec<String>> {
    use eventsource_stream::Eventsource;
    use futures::StreamExt;

    let idle_timeout = stream_idle_timeout();
    let mut stream = response.bytes_stream().eventsource();
    let mut images_base64 = Vec::new();
    let mut event_count: u64 = 0;

    loop {
        let event = match tokio::time::timeout(idle_timeout, stream.next()).await {
            Ok(Some(event)) => event,
            Ok(None) => break,
            Err(_) => {
                return Err(AppError::LlmApi(format!(
                    "GPT Image stream idle timeout ({} seconds without data)",
                    idle_timeout.as_secs()
                )));
            }
        };

        match event {
            Ok(ev) => {
                event_count += 1;
                if ev.data == "[DONE]" {
                    break;
                }

                let Ok(value) = serde_json::from_str::<serde_json::Value>(&ev.data) else {
                    log::debug!(
                        "[GPT Image] Skipping non-JSON stream event: {}",
                        ev.data.chars().take(120).collect::<String>()
                    );
                    continue;
                };

                if let Some(b64) = value.get("b64_json").and_then(|v| v.as_str()) {
                    if !b64.is_empty() {
                        images_base64.push(b64.to_string());
                    }
                }

                if let Some(b64) = value
                    .get("data")
                    .and_then(|v| v.as_array())
                    .and_then(|items| items.first())
                    .and_then(|item| item.get("b64_json"))
                    .and_then(|v| v.as_str())
                {
                    if !b64.is_empty() {
                        images_base64.push(b64.to_string());
                    }
                }
            }
            Err(e) => {
                return Err(AppError::LlmApi(format!(
                    "GPT Image stream read failed after {} events: {}",
                    event_count, e
                )));
            }
        }
    }

    log::debug!(
        "[GPT Image] Stream completed: {} events, {} image payloads",
        event_count,
        images_base64.len()
    );

    Ok(images_base64)
}

fn normalize_openai_image_base_url(base_url: Option<&str>) -> String {
    let mut raw = base_url
        .filter(|url| !url.trim().is_empty())
        .unwrap_or("http://127.0.0.1:8050/v1")
        .trim()
        .trim_end_matches('/')
        .to_string();

    for suffix in ["/images/generations", "/images/edits", "/images"] {
        if raw.ends_with(suffix) {
            raw.truncate(raw.len() - suffix.len());
            raw = raw.trim_end_matches('/').to_string();
            break;
        }
    }

    if raw.ends_with("/v1") {
        raw
    } else {
        format!("{}/v1", raw)
    }
}

fn map_gpt_image_size(aspect_ratio: Option<&str>, image_size: Option<&str>) -> Option<String> {
    let ratio = aspect_ratio.unwrap_or("1:1");
    let tier = image_size.unwrap_or("1K");

    if tier.eq_ignore_ascii_case("auto") {
        return Some("auto".to_string());
    }

    if let Some((width, height)) = tier.split_once('x') {
        if width.parse::<u32>().is_ok() && height.parse::<u32>().is_ok() {
            return Some(tier.to_string());
        }
    }

    let normalized_ratio = match ratio {
        "1:4" | "1:8" => "9:16",
        "4:1" | "8:1" => "16:9",
        other => other,
    };

    let size = match tier {
        "2K" => match normalized_ratio {
            "1:1" => "2048x2048",
            "16:9" => "2048x1152",
            "9:16" => "1152x2048",
            "4:3" => "2048x1536",
            "3:4" => "1536x2048",
            "3:2" => "2048x1360",
            "2:3" => "1360x2048",
            "4:5" => "1632x2048",
            "5:4" => "2048x1632",
            "21:9" => "2560x1088",
            _ => "2048x2048",
        },
        "4K" => match normalized_ratio {
            "1:1" => "2880x2880",
            "16:9" => "3840x2160",
            "9:16" => "2160x3840",
            "4:3" => "3072x2304",
            "3:4" => "2304x3072",
            "3:2" => "3520x2352",
            "2:3" => "2352x3520",
            "4:5" => "2576x3216",
            "5:4" => "3216x2576",
            "21:9" => "3840x1648",
            _ => "2880x2880",
        },
        _ => match normalized_ratio {
            "1:1" => "1024x1024",
            "16:9" => "1536x864",
            "9:16" => "864x1536",
            "4:3" => "1280x960",
            "3:4" => "960x1280",
            "3:2" => "1536x1024",
            "2:3" => "1024x1536",
            "4:5" => "1024x1280",
            "5:4" => "1280x1024",
            "21:9" => "1792x768",
            _ => "1024x1024",
        },
    };

    Some(size.to_string())
}

fn gpt_image_endpoint(base_url: &str, has_references: bool) -> String {
    if has_references {
        format!("{}/images/edits", base_url)
    } else {
        format!("{}/images/generations", base_url)
    }
}

#[tauri::command]
pub async fn gpt_image_generate(
    request: GptImageGenerateRequest,
) -> CommandResult<GptImageGenerateResponse> {
    let api_key = get_api_key("image-generation")?;
    let base_url = request
        .base_url
        .as_deref()
        .filter(|url| !url.trim().is_empty())
        .map(|url| normalize_openai_image_base_url(Some(url)))
        .ok_or_else(|| AppError::LlmApi(
            "Image generation API endpoint URL is not configured. Add the image generation service URL in Cloud Services.".to_string()
        ))?;
    let reference_images = request.reference_images.unwrap_or_default();
    let has_references = !reference_images.is_empty();
    let endpoint = gpt_image_endpoint(&base_url, has_references);
    let model_id = request
        .model
        .as_deref()
        .unwrap_or("gpt-image-2")
        .to_string();
    let output_format = request
        .output_format
        .as_deref()
        .unwrap_or("png")
        .to_ascii_lowercase();

    if !matches!(output_format.as_str(), "png" | "jpeg" | "webp") {
        return Err(AppError::LlmApi(format!(
            "Unsupported gpt-image-2 output_format: {}",
            output_format
        )));
    }

    let background = request
        .background
        .as_deref()
        .unwrap_or("auto")
        .to_ascii_lowercase();

    if background == "transparent" {
        return Err(AppError::LlmApi(
            "gpt-image-2 does not support transparent backgrounds; use auto or opaque".to_string(),
        ));
    }

    if !matches!(background.as_str(), "auto" | "opaque") {
        return Err(AppError::LlmApi(format!(
            "Unsupported gpt-image-2 background: {}",
            background
        )));
    }

    let quality = request
        .quality
        .as_deref()
        .unwrap_or("auto")
        .to_ascii_lowercase();

    if !matches!(quality.as_str(), "low" | "medium" | "high" | "auto") {
        return Err(AppError::LlmApi(format!(
            "Unsupported gpt-image-2 quality: {}",
            quality
        )));
    }

    let size = map_gpt_image_size(
        request.aspect_ratio.as_deref(),
        request.image_size.as_deref(),
    );
    let use_stream = request.stream.unwrap_or(false);
    let partial_images = request.partial_images.unwrap_or(2).min(3);

    let mut payload = serde_json::json!({
        "model": model_id.clone(),
        "prompt": request.prompt.clone(),
        "n": 1,
        "quality": quality.clone(),
        "output_format": output_format.clone(),
        "background": background.clone(),
    });

    if let Some(ref size) = size {
        payload["size"] = serde_json::Value::String(size.clone());
    }

    if use_stream {
        payload["stream"] = serde_json::Value::Bool(true);
        payload["partial_images"] = serde_json::json!(partial_images);
    }

    if matches!(output_format.as_str(), "jpeg" | "webp") {
        if let Some(compression) = request.output_compression {
            payload["output_compression"] = serde_json::json!(compression.min(100));
        }
    }

    log::debug!(
        "[GPT Image] Requesting local gpt-image-2: endpoint={}, references={}, size={:?}, stream={}",
        endpoint,
        reference_images.len(),
        payload.get("size"),
        use_stream
    );

    let http_client = if use_stream {
        get_streaming_client()
    } else {
        get_client()
    };
    let mut request_builder = http_client.post(&endpoint).bearer_auth(&api_key);

    if has_references {
        let mut form = reqwest::multipart::Form::new()
            .text("model", model_id)
            .text("prompt", request.prompt)
            .text("n", "1")
            .text("quality", quality)
            .text("output_format", output_format.clone())
            .text("background", background);

        if use_stream {
            form = form
                .text("stream", "true")
                .text("partial_images", partial_images.to_string());
        }

        if let Some(size) = size {
            form = form.text("size", size);
        }

        if matches!(output_format.as_str(), "jpeg" | "webp") {
            if let Some(compression) = request.output_compression {
                form = form.text("output_compression", compression.min(100).to_string());
            }
        }

        use base64::Engine as _;
        let image_field_name = if reference_images.len() == 1 {
            "image"
        } else {
            "image[]"
        };
        for (index, image) in reference_images.iter().enumerate() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&image.data)
                .map_err(|e| {
                    AppError::LlmApi(format!("GPT Image reference image decode failed: {}", e))
                })?;

            let part = reqwest::multipart::Part::bytes(bytes)
                .file_name(format!("reference_{}.png", index))
                .mime_str(&image.mime_type)
                .map_err(|e| {
                    AppError::LlmApi(format!("GPT Image reference image MIME invalid: {}", e))
                })?;

            form = form.part(image_field_name, part);
        }

        request_builder = request_builder.multipart(form);
    } else {
        request_builder = request_builder.json(&payload);
    }

    let session_id = request.session_id.clone();
    let (mut cancel_rx, cancel_registration_id) = if let Some(ref sid) = session_id {
        let (tx, rx) = oneshot::channel::<()>();
        let registration_id = register_cancel_sender(sid, None, tx);
        log::debug!("[GPT Image] registered cancel channel: {}", sid);
        (Some(rx), Some(registration_id))
    } else {
        (None, None)
    };

    let start_timeout = stream_start_timeout();
    let send_request = tokio::time::timeout(start_timeout, request_builder.send());
    let timeout_label = if use_stream {
        "stream start"
    } else {
        "response header"
    };
    let response_result: CommandResult<reqwest::Response> = if let Some(rx) = cancel_rx.as_mut() {
        tokio::select! {
            result = send_request => result
                .map_err(|_| {
                    AppError::LlmApi(format!(
                        "GPT Image {} timeout ({} seconds without response headers)",
                        timeout_label,
                        start_timeout.as_secs()
                    ))
                })?
                .map_err(|e| AppError::LlmApi(format!(
                    "GPT Image API request failed: {}",
                    format_reqwest_error(&e)
                ))),
            _ = rx => {
                cleanup_optional_cancel_sender(&session_id, cancel_registration_id);
                return Err(AppError::LlmApi("Request cancelled".to_string()));
            }
        }
    } else {
        send_request
            .await
            .map_err(|_| {
                AppError::LlmApi(format!(
                    "GPT Image {} timeout ({} seconds without response headers)",
                    timeout_label,
                    start_timeout.as_secs()
                ))
            })?
            .map_err(|e| {
                AppError::LlmApi(format!(
                    "GPT Image API request failed: {}",
                    format_reqwest_error(&e)
                ))
            })
    };

    let response = match response_result {
        Ok(response) => response,
        Err(error) => {
            cleanup_optional_cancel_sender(&session_id, cancel_registration_id);
            return Err(error);
        }
    };

    let http_status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if http_status.is_success() && content_type.contains("text/event-stream") {
        let collect_result: AppResult<Vec<String>> = if let Some(rx) = cancel_rx.as_mut() {
            tokio::select! {
                result = collect_openai_image_stream(response) => result,
                _ = rx => {
                    cleanup_optional_cancel_sender(&session_id, cancel_registration_id);
                    return Err(AppError::LlmApi("Request cancelled".to_string()));
                }
            }
        } else {
            collect_openai_image_stream(response).await
        };
        let mut images_base64 = match collect_result {
            Ok(images_base64) => images_base64,
            Err(error) => {
                cleanup_optional_cancel_sender(&session_id, cancel_registration_id);
                return Err(error);
            }
        };
        cleanup_optional_cancel_sender(&session_id, cancel_registration_id);
        images_base64.dedup();

        if images_base64.is_empty() {
            return Err(AppError::LlmApi(
                "GPT Image stream returned no b64_json payload".to_string(),
            ));
        }

        let final_image = images_base64.pop().ok_or_else(|| {
            AppError::LlmApi("GPT Image stream returned no final image".to_string())
        })?;

        return Ok(GptImageGenerateResponse {
            images_base64: vec![final_image],
            mime_type: format!("image/{}", output_format),
        });
    }

    cleanup_optional_cancel_sender(&session_id, cancel_registration_id);
    let body_text = response.text().await.map_err(|e| {
        AppError::LlmApi(format!(
            "GPT Image API response read failed: {}",
            format_reqwest_error(&e)
        ))
    })?;

    log::debug!(
        "[GPT Image] HTTP {}: {}",
        http_status,
        &body_text.chars().take(300).collect::<String>()
    );

    if !http_status.is_success() {
        return Err(AppError::LlmApi(format!(
            "GPT Image API returned HTTP {}: {}",
            http_status, body_text
        )));
    }

    let api_resp: OpenAiImagesResponse = serde_json::from_str(&body_text).map_err(|e| {
        AppError::LlmApi(format!(
            "GPT Image API response parse failed: {}\nRaw response: {}",
            e,
            &body_text.chars().take(500).collect::<String>()
        ))
    })?;

    let data = api_resp
        .data
        .filter(|items| !items.is_empty())
        .ok_or_else(|| {
            AppError::LlmApi("GPT Image API response did not include image data".to_string())
        })?;

    let mut images_base64 = Vec::new();
    for item in data {
        if let Some(b64) = item.b64_json {
            images_base64.push(b64);
            continue;
        }

        if let Some(url) = item.url {
            let img_response = http_client.get(&url).send().await.map_err(|e| {
                AppError::LlmApi(format!(
                    "GPT Image URL download failed: {}",
                    format_reqwest_error(&e)
                ))
            })?;

            let img_bytes = img_response.bytes().await.map_err(|e| {
                AppError::LlmApi(format!(
                    "GPT Image URL content read failed: {}",
                    format_reqwest_error(&e)
                ))
            })?;

            use base64::Engine as _;
            images_base64.push(base64::engine::general_purpose::STANDARD.encode(&img_bytes));
        }
    }

    if images_base64.is_empty() {
        return Err(AppError::LlmApi(
            "GPT Image API returned no b64_json or downloadable URL".to_string(),
        ));
    }

    Ok(GptImageGenerateResponse {
        images_base64,
        mime_type: format!("image/{}", output_format),
    })
}

/// 发送聊天请求 (非流式)
#[tauri::command]
pub async fn llm_chat(
    _state: State<'_, AppState>,
    request: ChatRequestDto,
) -> CommandResult<ChatResponseDto> {
    let api_key = get_api_key(&request.provider)?;
    let config = provider_config(api_key, request.supports_vision, &request.provider);

    let chat_request = ChatRequest {
        messages: convert_messages(request.messages),
        model: request.model,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        reasoning_preset: request.reasoning_preset,
        stream: false,
        response_modalities: request.response_modalities,
        image_config: request
            .image_config
            .map(|c| crate::llm::types::ImageGenerationConfig {
                aspect_ratio: c.aspect_ratio,
                image_size: c.image_size,
            }),
    };

    let response = match request.provider.as_str() {
        "openai" => {
            let adapter = OpenAIAdapter::new(config);
            adapter.chat(chat_request).await?
        }
        "anthropic" => {
            let adapter = AnthropicAdapter::new(config);
            adapter.chat(chat_request).await?
        }
        "gemini" => {
            let adapter = GeminiAdapter::new(config);
            adapter.chat(chat_request).await?
        }
        "zhipu" => {
            // ZhipuAI 使用 OpenAI 兼容 API，图片需要纯 base64 格式
            let zhipu_config = config
                .with_base_url("https://open.bigmodel.cn/api/paas/v4")
                .with_raw_base64_image();
            let adapter = OpenAIAdapter::new(zhipu_config);
            adapter.chat(chat_request).await?
        }
        "zhipu-coding" => {
            // ZhipuAI Coding Plan 专属 endpoint，与普通 zhipu 共享 API Key
            // 但走 /coding/paas/v4 路径，享受编码套餐独立配额
            let zhipu_coding_config = config
                .with_base_url("https://open.bigmodel.cn/api/coding/paas/v4")
                .with_raw_base64_image();
            let adapter = OpenAIAdapter::new(zhipu_coding_config);
            adapter.chat(chat_request).await?
        }
        "deepseek" => {
            // DeepSeek 使用 OpenAI 兼容协议
            let deepseek_config = config.with_base_url("https://api.deepseek.com");
            let adapter = OpenAIAdapter::new(deepseek_config);
            adapter.chat(chat_request).await?
        }
        "agnes" => {
            // Agnes AI 使用 OpenAI 兼容协议；Agnes-2.0-Flash 是 text/agentic 模型
            let agnes_config = config
                .with_base_url("https://apihub.agnes-ai.com/v1")
                .with_model("agnes-2.0-flash");
            let adapter = OpenAIAdapter::new(agnes_config);
            adapter.chat(chat_request).await?
        }
        "stepfun" => {
            // StepFun Step Plan 使用 OpenAI 兼容协议，专属路径为 /step_plan/v1
            let stepfun_config = config
                .with_base_url("https://api.stepfun.com/step_plan/v1")
                .with_model("step-3.7-flash");
            let adapter = OpenAIAdapter::new(stepfun_config);
            adapter.chat(chat_request).await?
        }
        "xiaomi-mimo" => {
            // Xiaomi MiMo Token Plan 使用 OpenAI 兼容协议
            let mimo_config = config.with_base_url("https://token-plan-cn.xiaomimimo.com/v1");
            let adapter = OpenAIAdapter::new(mimo_config);
            adapter.chat(chat_request).await?
        }
        "local" => {
            // Local Router：根据模型名智能推断协议（与 llm_chat_with_tools 一致）
            let protocol = infer_protocol_from_model(chat_request.model.as_deref());
            let base_url = request
                .base_url
                .as_deref()
                .unwrap_or("http://127.0.0.1:8050");
            log::debug!(
                "[LLM] local chat: 模型={}, 推断协议={}",
                chat_request.model.as_deref().unwrap_or("unknown"),
                protocol
            );
            match protocol {
                "anthropic" => {
                    let local_config = config.with_base_url(base_url);
                    let adapter = AnthropicAdapter::new(local_config);
                    adapter.chat(chat_request).await?
                }
                "openai" => {
                    let local_config =
                        config.with_base_url(format!("{}/v1", base_url.trim_end_matches("/v1")));
                    let adapter = OpenAIAdapter::new(local_config);
                    adapter.chat(chat_request).await?
                }
                _ => {
                    let local_config = config.with_base_url(base_url);
                    let adapter = GeminiAdapter::new(local_config);
                    adapter.chat(chat_request).await?
                }
            }
        }
        "volcengine" => {
            // 火山引擎 Coding Plan 使用 OpenAI 兼容协议
            let bailian_config =
                config.with_base_url("https://ark.cn-beijing.volces.com/api/coding/v3");
            let adapter = OpenAIAdapter::new(bailian_config);
            adapter.chat(chat_request).await?
        }
        "minimax" => {
            // Minimax Anthropic 兼容协议
            let minimax_config = config.with_base_url("https://api.minimaxi.com/anthropic/v1");
            let adapter = AnthropicAdapter::new(minimax_config);
            adapter.chat(chat_request).await?
        }
        "openrouter" => {
            // OpenRouter 使用 OpenAI 兼容协议，支持路由到多个厂商模型
            let openrouter_config = config
                .with_base_url("https://openrouter.ai/api/v1")
                .with_stream_usage();
            let adapter = OpenAIAdapter::new(openrouter_config);
            adapter.chat(chat_request).await?
        }
        provider => {
            return Err(AppError::LlmApi(format!(
                "Unsupported provider: {}",
                provider
            )));
        }
    };

    Ok(ChatResponseDto {
        content: response.content,
        model: response.model,
        input_tokens: response.input_tokens,
        output_tokens: response.output_tokens,
    })
}

/// 流式聊天事件数据
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamChunkEvent {
    /// 会话 ID，用于区分不同的流式请求
    pub session_id: String,
    /// 单次流式请求 ID，用于隔离同一会话内的重试事件
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    /// 内容增量
    pub delta: String,
    /// 思考过程增量（思考模型专用）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    /// 是否完成
    pub done: bool,
    /// 完成原因（仅最终 chunk 携带，例如 stop / length / MAX_TOKENS）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    /// 错误信息（如有）
    pub error: Option<String>,
    /// 输入 token 数（仅最终 chunk 携带，来自 API usage）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u32>,
    /// 输出 token 数（仅最终 chunk 携带，来自 API usage）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u32>,
}

/// 流式工具调用参数接收进度事件（不包含参数正文）
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallProgressEvent {
    /// 会话 ID，用于区分不同的 llm_chat_with_tools 请求
    pub session_id: String,
    /// 工具名称
    pub tool_name: String,
    /// 已接收的 arguments 字节数
    pub arg_bytes: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningProgressEvent {
    pub session_id: String,
    pub delta: String,
    pub done: bool,
}

/// 发送流式聊天请求
///
/// 通过 Tauri 事件系统发送流式响应 chunk
/// 前端需要监听 "llm-stream-chunk" 事件
/// 支持通过 llm_cancel_stream 命令取消
#[tauri::command]
pub async fn llm_chat_stream(
    _state: State<'_, AppState>,
    app: tauri::AppHandle,
    request: ChatRequestDto,
    session_id: String,
    attempt_id: Option<String>,
) -> CommandResult<()> {
    use futures::StreamExt;

    let api_key = get_api_key(&request.provider)?;
    let no_useful_progress_timeout = stream_no_useful_progress_timeout(&request.provider);
    // 原生 OpenAI / OpenRouter / DeepSeek 支持 stream_options.include_usage
    let supports_stream_usage = matches!(
        request.provider.as_str(),
        "openai" | "openrouter" | "deepseek"
    );
    let mut config = provider_config(api_key, request.supports_vision, &request.provider);
    config.supports_stream_usage = supports_stream_usage;

    let chat_request = ChatRequest {
        messages: convert_messages(request.messages),
        model: request.model,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        reasoning_preset: request.reasoning_preset,
        stream: true,
        // 图像生成参数透传
        response_modalities: request.response_modalities,
        image_config: request
            .image_config
            .map(|c| crate::llm::types::ImageGenerationConfig {
                aspect_ratio: c.aspect_ratio,
                image_size: c.image_size,
            }),
    };

    // 在流创建之前注册取消通道，确保模型"思考"期间（chat_stream 尚未返回）
    // 用户点击取消时信号不会丢失。流创建完成后进入 select! 循环会立即捕获已到达的取消信号。
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    let cancel_registration_id = register_cancel_sender(&session_id, attempt_id.clone(), cancel_tx);

    // 在流创建阶段以及分块读取阶段都要保持取消机制处于激活状态。
    // 部分提供商在响应头到达之前不会产出流，因此直接 await chat_stream()
    // 可能导致“停止”操作长时间无响应。
    let stream_future = async {
        match request.provider.as_str() {
            "openai" => {
                let adapter = OpenAIAdapter::new(config);
                adapter.chat_stream(chat_request).await
            }
            "anthropic" => {
                let adapter = AnthropicAdapter::new(config);
                adapter.chat_stream(chat_request).await
            }
            "gemini" => {
                let adapter = GeminiAdapter::new(config);
                adapter.chat_stream(chat_request).await
            }
            "zhipu" => {
                // ZhipuAI 使用 OpenAI 兼容 API，图片需要纯 base64 格式
                let zhipu_config = config
                    .with_base_url("https://open.bigmodel.cn/api/paas/v4")
                    .with_raw_base64_image();
                let adapter = OpenAIAdapter::new(zhipu_config);
                adapter.chat_stream(chat_request).await
            }
            "deepseek" => {
                // DeepSeek 使用 OpenAI 兼容协议
                let deepseek_config = config.with_base_url("https://api.deepseek.com");
                let adapter = OpenAIAdapter::new(deepseek_config);
                adapter.chat_stream(chat_request).await
            }
            "agnes" => {
                // Agnes AI 使用 OpenAI 兼容协议；Agnes-2.0-Flash 是 text/agentic 模型
                let agnes_config = config
                    .with_base_url("https://apihub.agnes-ai.com/v1")
                    .with_model("agnes-2.0-flash");
                let adapter = OpenAIAdapter::new(agnes_config);
                adapter.chat_stream(chat_request).await
            }
            "stepfun" => {
                // StepFun Step Plan 使用 OpenAI 兼容协议，专属路径为 /step_plan/v1
                let stepfun_config = config
                    .with_base_url("https://api.stepfun.com/step_plan/v1")
                    .with_model("step-3.7-flash");
                let adapter = OpenAIAdapter::new(stepfun_config);
                adapter.chat_stream(chat_request).await
            }
            "xiaomi-mimo" => {
                // Xiaomi MiMo Token Plan 使用 OpenAI 兼容协议
                let mimo_config = config.with_base_url("https://token-plan-cn.xiaomimimo.com/v1");
                let adapter = OpenAIAdapter::new(mimo_config);
                adapter.chat_stream(chat_request).await
            }
            "zhipu-coding" => {
                // ZhipuAI Coding Plan 专属 endpoint，与普通 zhipu 共享 API Key
                // 但走 /coding/paas/v4 路径，享受编码套餐独立配额
                let zhipu_coding_config = config
                    .with_base_url("https://open.bigmodel.cn/api/coding/paas/v4")
                    .with_raw_base64_image();
                let adapter = OpenAIAdapter::new(zhipu_coding_config);
                adapter.chat_stream(chat_request).await
            }
            "local" => {
                // Local Router：根据模型名智能推断协议（与 llm_chat_with_tools 一致）
                let protocol = infer_protocol_from_model(chat_request.model.as_deref());
                let base_url = request
                    .base_url
                    .as_deref()
                    .unwrap_or("http://127.0.0.1:8050");
                log::debug!(
                    "[LLM] local chat_stream: 模型={}, 推断协议={}",
                    chat_request.model.as_deref().unwrap_or("unknown"),
                    protocol
                );
                match protocol {
                    "anthropic" => {
                        let local_config = config.with_base_url(base_url);
                        let adapter = AnthropicAdapter::new(local_config);
                        adapter.chat_stream(chat_request).await
                    }
                    "openai" => {
                        let local_config = config
                            .with_base_url(format!("{}/v1", base_url.trim_end_matches("/v1")));
                        let adapter = OpenAIAdapter::new(local_config);
                        adapter.chat_stream(chat_request).await
                    }
                    _ => {
                        let local_config = config.with_base_url(base_url);
                        let adapter = GeminiAdapter::new(local_config);
                        adapter.chat_stream(chat_request).await
                    }
                }
            }
            "volcengine" => {
                // 火山引擎 Coding Plan 使用 OpenAI 兼容协议
                let bailian_config =
                    config.with_base_url("https://ark.cn-beijing.volces.com/api/coding/v3");
                let adapter = OpenAIAdapter::new(bailian_config);
                adapter.chat_stream(chat_request).await
            }
            "minimax" => {
                // Minimax Anthropic 兼容协议
                let minimax_config = config.with_base_url("https://api.minimaxi.com/anthropic/v1");
                let adapter = AnthropicAdapter::new(minimax_config);
                adapter.chat_stream(chat_request).await
            }
            "openrouter" => {
                // OpenRouter 使用 OpenAI 兼容协议，支持路由到多个厂商模型
                let openrouter_config = config
                    .with_base_url("https://openrouter.ai/api/v1")
                    .with_stream_usage();
                let adapter = OpenAIAdapter::new(openrouter_config);
                adapter.chat_stream(chat_request).await
            }
            provider => {
                // 发送错误事件
                let _ = app.emit(
                    "llm-stream-chunk",
                    StreamChunkEvent {
                        session_id: session_id.clone(),
                        attempt_id: attempt_id.clone(),
                        delta: String::new(),
                        reasoning: None,
                        done: true,
                        finish_reason: None,
                        error: Some(format!("Unsupported provider: {}", provider)),
                        input_tokens: None,
                        output_tokens: None,
                    },
                );
                return Err(AppError::LlmApi(format!(
                    "Unsupported provider: {}",
                    provider
                )));
            }
        }
    };

    tokio::pin!(stream_future);
    let stream_result = tokio::select! {
        result = &mut stream_future => result,
        _ = &mut cancel_rx => {
            log::info!("[LLM] 流式请求在建流阶段被取消: {}", session_id);
            remove_cancel_sender(&session_id, cancel_registration_id);
            let _ = app.emit("llm-stream-chunk", StreamChunkEvent {
                session_id: session_id.clone(),
                attempt_id: attempt_id.clone(),
                delta: String::new(),
                reasoning: None,
                done: true,
                finish_reason: None,
                error: Some("User cancelled".to_string()),
                input_tokens: None,
                output_tokens: None,
            });
            return Ok(());
        }
    };

    match stream_result {
        Ok(mut stream) => {
            let mut last_useful_progress_at = Instant::now();

            // 使用 tokio::select! 在流循环中检测取消信号
            let result = loop {
                tokio::select! {
                    // 取消信号分支
                    _ = &mut cancel_rx => {
                        log::info!("[LLM] 流式请求被取消: {}", session_id);
                        // 发送取消事件
                        let _ = app.emit("llm-stream-chunk", StreamChunkEvent {
                            session_id: session_id.clone(),
                            attempt_id: attempt_id.clone(),
                            delta: String::new(),
                            reasoning: None,
                            done: true,
                            finish_reason: None,
                            error: Some("User cancelled".to_string()),
                            input_tokens: None,
                            output_tokens: None,
                        });
                        break Ok(());
                    }
                    // 流数据分支
                    chunk_result = tokio::time::timeout(stream_idle_timeout(), stream.next()) => {
                        match chunk_result {
                            Ok(Some(Ok(chunk))) => {
                                let has_useful_progress =
                                    !chunk.delta.is_empty() ||
                                    chunk.reasoning.as_deref().map_or(false, |reasoning| !reasoning.is_empty());

                                if has_useful_progress {
                                    last_useful_progress_at = Instant::now();
                                } else if !chunk.done {
                                    if let Some(timeout) = no_useful_progress_timeout {
                                        if last_useful_progress_at.elapsed() >= timeout {
                                            let error = AppError::LlmApi(format!(
                                                "Volcengine streaming no useful content timeout ({} seconds without non-empty delta or reasoning)",
                                                timeout.as_secs()
                                            ));
                                            let _ = app.emit("llm-stream-chunk", StreamChunkEvent {
                                                session_id: session_id.clone(),
                                                attempt_id: attempt_id.clone(),
                                                delta: String::new(),
                                                reasoning: None,
                                                done: true,
                                                finish_reason: None,
                                                error: Some(error.to_string()),
                                                input_tokens: None,
                                                output_tokens: None,
                                            });
                                            break Err(error);
                                        }
                                    }
                                }

                                let _ = app.emit("llm-stream-chunk", StreamChunkEvent {
                                    session_id: session_id.clone(),
                                    attempt_id: attempt_id.clone(),
                                    delta: chunk.delta,
                                    reasoning: chunk.reasoning,
                                    done: chunk.done,
                                    finish_reason: chunk.finish_reason,
                                    error: None,
                                    input_tokens: chunk.input_tokens,
                                    output_tokens: chunk.output_tokens,
                                });

                                // 如果已完成，退出循环
                                if chunk.done {
                                    break Ok(());
                                }
                            }
                            Ok(Some(Err(e))) => {
                                // 发送错误事件
                                let _ = app.emit("llm-stream-chunk", StreamChunkEvent {
                                    session_id: session_id.clone(),
                                    attempt_id: attempt_id.clone(),
                                    delta: String::new(),
                                    reasoning: None,
                                    done: true,
                                    finish_reason: None,
                                    error: Some(e.to_string()),
                                    input_tokens: None,
                                    output_tokens: None,
                                });
                                break Err(e);
                            }
                            Ok(None) => {
                                // 流结束
                                break Ok(());
                            }
                            Err(_) => {
                                let idle_secs = stream_idle_timeout().as_secs();
                                let error = AppError::LlmApi(format!(
                                    "Streaming response idle timeout (no data for {} seconds)",
                                    idle_secs
                                ));
                                let _ = app.emit("llm-stream-chunk", StreamChunkEvent {
                                    session_id: session_id.clone(),
                                    attempt_id: attempt_id.clone(),
                                    delta: String::new(),
                                    reasoning: None,
                                    done: true,
                                    finish_reason: None,
                                    error: Some(error.to_string()),
                                    input_tokens: None,
                                    output_tokens: None,
                                });
                                break Err(error);
                            }
                        }
                    }
                }
            };

            // 清理：从全局存储中移除取消通道（如果还存在）
            remove_cancel_sender(&session_id, cancel_registration_id);

            result?;
        }
        Err(e) => {
            // 清理取消通道
            remove_cancel_sender(&session_id, cancel_registration_id);
            // 发送错误事件
            let _ = app.emit(
                "llm-stream-chunk",
                StreamChunkEvent {
                    session_id: session_id.clone(),
                    attempt_id: attempt_id.clone(),
                    delta: String::new(),
                    reasoning: None,
                    done: true,
                    finish_reason: None,
                    error: Some(e.to_string()),
                    input_tokens: None,
                    output_tokens: None,
                },
            );
            return Err(e);
        }
    }

    Ok(())
}

/// 取消流式聊天请求
///
/// 发送取消信号给指定 session_id 的流式请求。
/// 提供 attempt_id 时只取消匹配的单次流；省略时保留原有的整会话取消语义。
#[tauri::command]
pub async fn llm_cancel_stream(
    session_id: String,
    attempt_id: Option<String>,
) -> CommandResult<()> {
    let cancelled_count = match attempt_id.as_deref() {
        Some(attempt_id) => cancel_attempt(&session_id, attempt_id),
        None => cancel_session(&session_id),
    };

    if cancelled_count > 0 {
        // 发送取消信号（忽略发送失败，可能接收端已关闭）
        log::info!(
            "[LLM] sent cancel signal: {} (attempt: {:?}, channels: {})",
            session_id,
            attempt_id,
            cancelled_count
        );
    } else {
        log::warn!(
            "[LLM] 未找到匹配的取消通道: {} (attempt: {:?})",
            session_id,
            attempt_id
        );
    }

    Ok(())
}

/// 获取可用的 LLM 提供商列表
#[tauri::command]
pub async fn llm_list_providers(_state: State<'_, AppState>) -> CommandResult<Vec<String>> {
    Ok(vec![
        "openai".to_string(),
        "anthropic".to_string(),
        "gemini".to_string(),
        "zhipu".to_string(),
        "zhipu-coding".to_string(),
        "volcengine".to_string(),
        "minimax".to_string(),
        "openrouter".to_string(),
        "deepseek".to_string(),
        "agnes".to_string(),
        "stepfun".to_string(),
        "xiaomi-mimo".to_string(),
        "local".to_string(),
    ])
}

/// 获取指定提供商的可用模型列表
#[tauri::command]
pub async fn llm_list_models(
    _state: State<'_, AppState>,
    provider: String,
) -> CommandResult<Vec<String>> {
    let models = match provider.as_str() {
        "openai" => vec![
            "gpt-5.4".to_string(),
            "gpt-5.4-mini".to_string(),
            "gpt-5.4-nano".to_string(),
            "gpt-5.5".to_string(),
            "gpt-5.6-luna".to_string(),
            "gpt-5.6-terra".to_string(),
            "gpt-5.6-sol".to_string(),
        ],
        "anthropic" => vec![
            "claude-sonnet-4-6".to_string(),
            "claude-sonnet-5".to_string(),
            "claude-opus-4-7".to_string(),
            "claude-opus-4-8".to_string(),
            "claude-fable-5".to_string(),
        ],
        "gemini" => vec![
            "gemini-3-flash-preview".to_string(),
            "gemini-3.1-pro-preview".to_string(),
            "gemini-3.1-flash-image-preview".to_string(),
            "gemini-3.5-flash".to_string(),
        ],
        "zhipu" => vec![
            "glm-4-flash".to_string(),
            "glm-4.6v-flash".to_string(),
            "glm-5.1".to_string(),
            "glm-5.2".to_string(),
        ],
        "deepseek" => vec![
            "deepseek-v4-pro".to_string(),
            "deepseek-v4-flash".to_string(),
        ],
        "agnes" => vec!["agnes-2.0-flash".to_string()],
        "stepfun" => vec!["step-3.7-flash".to_string()],
        "xiaomi-mimo" => vec!["mimo-v2.5".to_string(), "mimo-v2.5-pro".to_string()],
        "zhipu-coding" => vec![
            "GLM-4.7".to_string(),
            "GLM-5-Turbo".to_string(),
            "GLM-5.1".to_string(),
            "GLM-5.2".to_string(),
        ],
        "volcengine" => vec![
            "doubao-seed-2.0-pro".to_string(),
            "doubao-seed-2.0-code".to_string(),
            "deepseek-v4-flash".to_string(),
            "deepseek-v4-pro".to_string(),
            "kimi-k2.6".to_string(),
            "Kimi-K2.7-Code".to_string(),
            "MiniMax-M3".to_string(),
            "glm-5.2".to_string(),
        ],
        "minimax" => vec![
            "MiniMax-M2.7".to_string(),
            "MiniMax-M2.7-highspeed".to_string(),
            "MiniMax-M3".to_string(),
            "image-01".to_string(),
        ],
        "openrouter" => vec![
            "xiaomi/mimo-v2.5".to_string(),
            "minimax/minimax-m3".to_string(),
            "stepfun/step-3.7-flash".to_string(),
            "google/gemini-3.1-flash-image-preview".to_string(),
        ],
        "local" => vec![
            "gpt-5.4".to_string(),
            "gpt-5.5".to_string(),
            "gemini-3.5-flash".to_string(),
        ],
        _ => vec![],
    };

    Ok(models)
}

// ==================== Function Calling 支持 ====================

use crate::llm::types::{
    ReasoningTraceCallback, ReasoningTraceProgress, ToolCallProgressCallback,
    ToolCallStreamProgress, ToolChatRequest, ToolChatResponse,
};

const FILE_WRITE_IPC_INLINE_CONTENT_LIMIT_BYTES: usize = 32 * 1024;

/// 根据模型名推断应使用的 API 协议
///
/// Local Router 支持三种协议，通过模型名自动选择：
/// - claude-* → Anthropic 协议
/// - gpt-* / o1-* / o3-* / o4-* → OpenAI 协议
/// - gemini-* / nanobanana → Gemini 官方协议
/// - 其余未识别（kimi、qwen、doubao、glm、minimax 等国内厂商）→ OpenAI 兼容协议
///   （国内主流厂商均已兼容 OpenAI 协议，故以 OpenAI 作为安全 fallback）
fn infer_protocol_from_model(model_id: Option<&str>) -> &'static str {
    let model = model_id.unwrap_or("");
    let model_lower = model.to_lowercase();

    if model_lower.starts_with("claude") {
        "anthropic"
    } else if model_lower.starts_with("gemini") || model_lower == "nanobanana" {
        // Gemini 官方模型及 Google 专属模型走 Gemini 协议
        "gemini"
    } else {
        // OpenAI 兼容协议作为默认 fallback：
        // 覆盖 gpt-* / o1/o3/o4-* / kimi-* / qwen-* / doubao-* / glm-* / minimax-* 等
        "openai"
    }
}

fn stage_large_file_write_args(
    app_handle: &AppHandle,
    response: &mut ToolChatResponse,
) -> AppResult<()> {
    if response.response_type != "tool_use" {
        return Ok(());
    }

    let Some(tool_calls) = response.tool_calls.as_mut() else {
        return Ok(());
    };

    for tool_call in tool_calls.iter_mut() {
        if tool_call.name != "file_write" {
            continue;
        }

        let Some(content) = tool_call
            .args
            .get("content")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
        else {
            continue;
        };

        let content_bytes = content.as_bytes().len();
        if content_bytes <= FILE_WRITE_IPC_INLINE_CONTENT_LIMIT_BYTES {
            continue;
        }

        let content_chars = content.chars().count();
        let ref_id = super::file::stage_large_tool_arg_content(app_handle, &content)?;
        let Some(args) = tool_call.args.as_object_mut() else {
            continue;
        };

        args.insert(
            "content".to_string(),
            serde_json::Value::String(format!(
                "[Large file_write content staged before WebView IPC: ref={}, {} bytes, {} chars]",
                ref_id, content_bytes, content_chars
            )),
        );
        args.insert(
            "contentRef".to_string(),
            serde_json::Value::String(ref_id.clone()),
        );
        args.insert("contentStaged".to_string(), serde_json::Value::Bool(true));
        args.insert(
            "contentBytes".to_string(),
            serde_json::Value::Number(serde_json::Number::from(content_bytes as u64)),
        );
        args.insert(
            "contentChars".to_string(),
            serde_json::Value::Number(serde_json::Number::from(content_chars as u64)),
        );

        log::warn!(
            "[LLM] staged large file_write content before IPC: tool_id={:?}, ref={}, bytes={}, chars={}",
            tool_call.id,
            ref_id,
            content_bytes,
            content_chars
        );
    }

    Ok(())
}

fn is_output_token_limit_finish_reason(finish_reason: Option<&str>) -> bool {
    let Some(finish_reason) = finish_reason else {
        return false;
    };
    let normalized = finish_reason
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|character| match character {
            ' ' | '-' => '_',
            other => other,
        })
        .collect::<String>();

    matches!(
        normalized.as_str(),
        "length" | "max_tokens" | "max_completion_tokens" | "max_output_tokens" | "incomplete"
    )
}

/// 截断响应中的工具参数可能已被 JSON repair 补成可解析但不完整的值。
/// 在大参数暂存和 WebView IPC 之前丢弃全部工具调用，避免执行或遗留临时文件。
fn discard_truncated_tool_calls(response: &mut ToolChatResponse) -> usize {
    if !is_output_token_limit_finish_reason(response.finish_reason.as_deref()) {
        return 0;
    }

    response
        .tool_calls
        .take()
        .map_or(0, |tool_calls| tool_calls.len())
}

fn make_tool_call_progress_callback(
    app_handle: AppHandle,
    session_id: Option<String>,
) -> Option<ToolCallProgressCallback> {
    let session_id = session_id?;

    Some(Arc::new(move |progress: ToolCallStreamProgress| {
        if progress.tool_name != "file_write" {
            return;
        }

        let _ = app_handle.emit(
            "llm-tool-call-progress",
            ToolCallProgressEvent {
                session_id: session_id.clone(),
                tool_name: progress.tool_name,
                arg_bytes: progress.arg_bytes,
            },
        );
    }))
}

fn make_reasoning_trace_callback(
    app_handle: AppHandle,
    session_id: Option<String>,
) -> Option<ReasoningTraceCallback> {
    let session_id = session_id?;

    Some(Arc::new(move |progress: ReasoningTraceProgress| {
        let _ = app_handle.emit(
            "llm-reasoning-progress",
            ReasoningProgressEvent {
                session_id: session_id.clone(),
                delta: progress.delta,
                done: progress.done,
            },
        );
    }))
}

/// 带工具的聊天请求（支持 Function Calling）
///
/// 支持 Gemini / OpenAI / Anthropic 三种提供商协议。
/// `local` 提供商根据模型名自动推断协议。
/// 支持通过 llm_cancel_stream 命令取消（复用同一取消机制）
#[tauri::command]
pub async fn llm_chat_with_tools(
    app_handle: AppHandle,
    _state: State<'_, AppState>,
    request: ToolChatRequest,
    session_id: Option<String>,
) -> CommandResult<ToolChatResponse> {
    // 获取 provider（优先使用请求中的 provider_id，默认使用 gemini）
    let provider_id = request.provider_id.clone();
    let provider = provider_id.as_deref().unwrap_or("gemini");

    let supports_vision = request.supports_vision;

    // 如果提供了 session_id，注册取消通道
    let (cancel_rx, cancel_registration_id) = if let Some(ref sid) = session_id {
        let (tx, rx) = oneshot::channel::<()>();
        let registration_id = register_cancel_sender(sid, None, tx);
        log::debug!("[LLM] 已注册 chat_with_tools 取消通道: {}", sid);
        (Some(rx), Some(registration_id))
    } else {
        (None, None)
    };
    let tool_call_progress =
        make_tool_call_progress_callback(app_handle.clone(), session_id.clone());
    let reasoning_trace = make_reasoning_trace_callback(app_handle.clone(), session_id.clone());

    // 根据 provider 类型分发请求
    let result: CommandResult<ToolChatResponse> = match provider {
        "gemini" => {
            let api_key = get_api_key("gemini")?;
            let config = provider_config(api_key, supports_vision, provider);
            let adapter = GeminiAdapter::new(config);
            dispatch_with_cancel(
                adapter.chat_stream_with_tools(
                    request,
                    tool_call_progress.clone(),
                    reasoning_trace.clone(),
                ),
                cancel_rx,
                &session_id,
                cancel_registration_id,
            )
            .await
        }
        "openai" => {
            let api_key = get_api_key("openai")?;
            let config = provider_config(api_key, supports_vision, provider).with_stream_usage();
            let adapter = OpenAIAdapter::new(config);
            // 使用流式模式避免大 payload 超时
            dispatch_with_cancel(
                adapter.chat_stream_with_tools(
                    request,
                    tool_call_progress.clone(),
                    reasoning_trace.clone(),
                ),
                cancel_rx,
                &session_id,
                cancel_registration_id,
            )
            .await
        }
        "anthropic" => {
            let api_key = get_api_key("anthropic")?;
            let config = provider_config(api_key, supports_vision, provider);
            let adapter = AnthropicAdapter::new(config);
            dispatch_with_cancel(
                adapter.chat_stream_with_tools(
                    request,
                    tool_call_progress.clone(),
                    reasoning_trace.clone(),
                ),
                cancel_rx,
                &session_id,
                cancel_registration_id,
            )
            .await
        }
        "local" => {
            // Local Router：根据模型名智能推断协议
            let protocol = infer_protocol_from_model(request.model_id.as_deref());
            let api_key = get_api_key("local")?;
            let base_url = request
                .base_url
                .as_deref()
                .unwrap_or("http://127.0.0.1:8050");

            log::debug!(
                "[LLM] local 提供商: 模型={}, 推断协议={}",
                request.model_id.as_deref().unwrap_or("unknown"),
                protocol
            );

            match protocol {
                "anthropic" => {
                    let config =
                        provider_config(api_key, supports_vision, provider).with_base_url(base_url);
                    let adapter = AnthropicAdapter::new(config);
                    dispatch_with_cancel(
                        adapter.chat_stream_with_tools(
                            request,
                            tool_call_progress.clone(),
                            reasoning_trace.clone(),
                        ),
                        cancel_rx,
                        &session_id,
                        cancel_registration_id,
                    )
                    .await
                }
                "openai" => {
                    let config = provider_config(api_key, supports_vision, provider)
                        .with_base_url(format!("{}/v1", base_url.trim_end_matches("/v1")));
                    let adapter = OpenAIAdapter::new(config);
                    dispatch_with_cancel(
                        adapter.chat_stream_with_tools(
                            request,
                            tool_call_progress.clone(),
                            reasoning_trace.clone(),
                        ),
                        cancel_rx,
                        &session_id,
                        cancel_registration_id,
                    )
                    .await
                }
                _ => {
                    // 默认 Gemini 协议
                    let config =
                        provider_config(api_key, supports_vision, provider).with_base_url(base_url);
                    let adapter = GeminiAdapter::new(config);
                    dispatch_with_cancel(
                        adapter.chat_stream_with_tools(
                            request,
                            tool_call_progress.clone(),
                            reasoning_trace.clone(),
                        ),
                        cancel_rx,
                        &session_id,
                        cancel_registration_id,
                    )
                    .await
                }
            }
        }
        "zhipu" => {
            // 智谱使用 OpenAI 兼容协议（流式模式）
            let api_key = get_api_key("zhipu")?;
            let config = provider_config(api_key, supports_vision, provider)
                .with_base_url("https://open.bigmodel.cn/api/paas/v4");
            let adapter = OpenAIAdapter::new(config);
            dispatch_with_cancel(
                adapter.chat_stream_with_tools(
                    request,
                    tool_call_progress.clone(),
                    reasoning_trace.clone(),
                ),
                cancel_rx,
                &session_id,
                cancel_registration_id,
            )
            .await
        }
        "deepseek" => {
            // DeepSeek 使用 OpenAI 兼容协议
            let api_key = get_api_key("deepseek")?;
            let config = provider_config(api_key, supports_vision, provider)
                .with_base_url("https://api.deepseek.com");
            let adapter = OpenAIAdapter::new(config);
            dispatch_with_cancel(
                adapter.chat_stream_with_tools(
                    request,
                    tool_call_progress.clone(),
                    reasoning_trace.clone(),
                ),
                cancel_rx,
                &session_id,
                cancel_registration_id,
            )
            .await
        }
        "agnes" => {
            // Agnes AI 使用 OpenAI 兼容协议；Agnes-2.0-Flash 是 text/agentic 模型
            let api_key = get_api_key("agnes")?;
            let config = provider_config(api_key, supports_vision, provider)
                .with_base_url("https://apihub.agnes-ai.com/v1")
                .with_model("agnes-2.0-flash");
            let adapter = OpenAIAdapter::new(config);
            dispatch_with_cancel(
                adapter.chat_stream_with_tools(
                    request,
                    tool_call_progress.clone(),
                    reasoning_trace.clone(),
                ),
                cancel_rx,
                &session_id,
                cancel_registration_id,
            )
            .await
        }
        "stepfun" => {
            // StepFun Step Plan 使用 OpenAI 兼容协议，专属路径为 /step_plan/v1
            let api_key = get_api_key("stepfun")?;
            let config = provider_config(api_key, supports_vision, provider)
                .with_base_url("https://api.stepfun.com/step_plan/v1")
                .with_model("step-3.7-flash");
            let adapter = OpenAIAdapter::new(config);
            dispatch_with_cancel(
                adapter.chat_stream_with_tools(
                    request,
                    tool_call_progress.clone(),
                    reasoning_trace.clone(),
                ),
                cancel_rx,
                &session_id,
                cancel_registration_id,
            )
            .await
        }
        "xiaomi-mimo" => {
            // Xiaomi MiMo Token Plan 使用 OpenAI 兼容协议
            let api_key = get_api_key("xiaomi-mimo")?;
            let config = provider_config(api_key, supports_vision, provider)
                .with_base_url("https://token-plan-cn.xiaomimimo.com/v1");
            let adapter = OpenAIAdapter::new(config);
            dispatch_with_cancel(
                adapter.chat_stream_with_tools(
                    request,
                    tool_call_progress.clone(),
                    reasoning_trace.clone(),
                ),
                cancel_rx,
                &session_id,
                cancel_registration_id,
            )
            .await
        }
        "zhipu-coding" => {
            // ZhipuAI Coding Plan 专属 endpoint，与普通 zhipu 共享 API Key
            // 但走 /coding/paas/v4 路径，享受编码套餐独立配额
            let api_key = get_api_key("zhipu-coding")?;
            let config = provider_config(api_key, supports_vision, provider)
                .with_base_url("https://open.bigmodel.cn/api/coding/paas/v4");
            let adapter = OpenAIAdapter::new(config);
            dispatch_with_cancel(
                adapter.chat_stream_with_tools(
                    request,
                    tool_call_progress.clone(),
                    reasoning_trace.clone(),
                ),
                cancel_rx,
                &session_id,
                cancel_registration_id,
            )
            .await
        }
        "volcengine" => {
            // 火山引擎 Coding Plan 使用 OpenAI 兼容协议（流式模式，解决大 payload 超时）
            let api_key = get_api_key("volcengine")?;
            let config = provider_config(api_key, supports_vision, provider)
                .with_base_url("https://ark.cn-beijing.volces.com/api/coding/v3");
            let adapter = OpenAIAdapter::new(config);
            dispatch_with_cancel(
                adapter.chat_stream_with_tools(
                    request,
                    tool_call_progress.clone(),
                    reasoning_trace.clone(),
                ),
                cancel_rx,
                &session_id,
                cancel_registration_id,
            )
            .await
        }
        "minimax" => {
            // Minimax Anthropic 兼容协议
            let api_key = get_api_key("minimax")?;
            let config = provider_config(api_key, supports_vision, provider)
                .with_base_url("https://api.minimaxi.com/anthropic/v1");
            let adapter = AnthropicAdapter::new(config);
            dispatch_with_cancel(
                adapter.chat_stream_with_tools(
                    request,
                    tool_call_progress.clone(),
                    reasoning_trace.clone(),
                ),
                cancel_rx,
                &session_id,
                cancel_registration_id,
            )
            .await
        }
        "openrouter" => {
            // OpenRouter 使用 OpenAI 兼容协议，支持路由到多个厂商模型
            let api_key = get_api_key("openrouter")?;
            let config = provider_config(api_key, supports_vision, provider)
                .with_base_url("https://openrouter.ai/api/v1")
                .with_stream_usage();
            let adapter = OpenAIAdapter::new(config);
            dispatch_with_cancel(
                adapter.chat_stream_with_tools(
                    request,
                    tool_call_progress.clone(),
                    reasoning_trace.clone(),
                ),
                cancel_rx,
                &session_id,
                cancel_registration_id,
            )
            .await
        }
        _ => {
            // 清理取消通道
            if let (Some(sid), Some(registration_id)) =
                (session_id.as_ref(), cancel_registration_id)
            {
                remove_cancel_sender(sid, registration_id);
            }
            return Ok(ToolChatResponse {
                response_type: "error".to_string(),
                content: None,
                tool_calls: None,
                error: Some(format!("Unsupported provider: {}", provider)),
                finish_reason: None,
                input_tokens: None,
                output_tokens: None,
                reasoning_content: None,
                reasoning_details: None,
            });
        }
    };

    match result {
        Ok(mut response) => {
            let discarded_tool_calls = discard_truncated_tool_calls(&mut response);
            if discarded_tool_calls > 0 {
                log::warn!(
                    "[LLM] discarded {} tool calls before staging because provider output was truncated: finish_reason={:?}",
                    discarded_tool_calls,
                    response.finish_reason
                );
            }
            if let Err(e) = stage_large_file_write_args(&app_handle, &mut response) {
                log::error!("[LLM] failed to stage large file_write args: {}", e);
                return Ok(ToolChatResponse {
                    response_type: "error".to_string(),
                    content: None,
                    tool_calls: None,
                    error: Some(format!("Failed to stage large file_write content: {}", e)),
                    finish_reason: None,
                    input_tokens: None,
                    output_tokens: None,
                    reasoning_content: None,
                    reasoning_details: None,
                });
            }
            Ok(response)
        }
        Err(e) => Ok(ToolChatResponse {
            response_type: "error".to_string(),
            content: None,
            tool_calls: None,
            error: Some(e.to_string()),
            finish_reason: None,
            input_tokens: None,
            output_tokens: None,
            reasoning_content: None,
            reasoning_details: None,
        }),
    }
}

/// 辅助函数：执行 LLM 请求并支持取消
///
/// 使用 tokio::select! 在请求执行和取消信号之间竞争
async fn dispatch_with_cancel(
    future: impl std::future::Future<Output = crate::error::AppResult<ToolChatResponse>>,
    cancel_rx: Option<oneshot::Receiver<()>>,
    session_id: &Option<String>,
    cancel_registration_id: Option<u64>,
) -> crate::error::AppResult<ToolChatResponse> {
    if let Some(rx) = cancel_rx {
        tokio::select! {
            response = future => {
                // 正常完成，清理取消通道
                if let (Some(sid), Some(registration_id)) = (session_id.as_ref(), cancel_registration_id) {
                    remove_cancel_sender(sid, registration_id);
                }
                response
            }
            _ = rx => {
                log::info!("[LLM] chat_with_tools 收到取消信号");
                if let (Some(sid), Some(registration_id)) = (session_id.as_ref(), cancel_registration_id) {
                    remove_cancel_sender(sid, registration_id);
                }
                Ok(ToolChatResponse {
                    response_type: "cancelled".to_string(),
                    content: Some("Request cancelled".to_string()),
                    tool_calls: None,
                    error: None,
                    finish_reason: None,
                    input_tokens: None,
                    output_tokens: None,
                    reasoning_content: None,
                    reasoning_details: None,
                })
            }
        }
    } else {
        future.await
    }
}

// ==================== MiniMax 图像生成 ====================

/// MiniMax 图像生成请求 DTO
#[derive(Debug, Deserialize)]
pub struct MinimaxImageGenerateRequest {
    /// 图片描述提示词（最大 1500 字符）
    pub prompt: String,
    /// 输出宽高比（MiniMax 支持：1:1 16:9 4:3 3:2 2:3 3:4 9:16 21:9）
    /// 传入不支持的比例时自动映射到最接近的支持值
    pub aspect_ratio: Option<String>,
}

/// MiniMax 图像生成响应 DTO
#[derive(Debug, Serialize)]
pub struct MinimaxImageGenerateResponse {
    /// JPEG 图片的 base64 编码数组（每次请求生成 1 张）
    pub images_base64: Vec<String>,
}

/// MiniMax API 响应结构（内部解析用）
#[derive(Debug, serde::Deserialize)]
struct MinimaxApiResponse {
    data: Option<MinimaxApiData>,
    base_resp: Option<MinimaxBaseResp>,
}

#[derive(Debug, serde::Deserialize)]
struct MinimaxApiData {
    image_base64: Option<Vec<String>>,
}

#[derive(Debug, serde::Deserialize)]
struct MinimaxBaseResp {
    status_code: i32,
    status_msg: String,
}

/// 将通用 aspect_ratio 字符串映射到 MiniMax image-01 支持的比例
///
/// MiniMax 支持：1:1 16:9 4:3 3:2 2:3 3:4 9:16 21:9
/// Gemini 专有比例（MiniMax 不支持）按最接近原则降级：
///   1:4 → 9:16，4:1 → 16:9
///   1:8 → 9:16，8:1 → 16:9
///   4:5 → 3:4，5:4 → 4:3
/// 未识别比例返回 None（MiniMax 默认 1:1）
fn map_aspect_ratio_to_minimax(ratio: &str) -> Option<&'static str> {
    match ratio {
        // MiniMax 原生支持
        "1:1" => Some("1:1"),
        "16:9" => Some("16:9"),
        "4:3" => Some("4:3"),
        "3:2" => Some("3:2"),
        "2:3" => Some("2:3"),
        "3:4" => Some("3:4"),
        "9:16" => Some("9:16"),
        "21:9" => Some("21:9"),
        // Gemini 专有 → 降级到最近比例
        "4:5" => Some("3:4"),
        "5:4" => Some("4:3"),
        "1:4" | "1:8" => Some("9:16"),
        "4:1" | "8:1" => Some("16:9"),
        // 未知比例，使用默认
        _ => None,
    }
}

/// 调用 MiniMax image-01 模型生成图片（文生图，T2I）
///
/// 设计说明：
/// - MiniMax 图像 API 与文本 API 完全不同，不经过现有的 LLM 适配器
/// - 直接调用 https://api.minimaxi.com/v1/image_generation REST API
/// - 固定使用 response_format: "base64" 避免 URL 24h 过期问题
/// - 仅支持 T2I；I2I 需要 subject_reference.image_file 为 URL，
///   本地图片不支持，由前端决策跳过
#[tauri::command]
pub async fn minimax_image_generate(
    request: MinimaxImageGenerateRequest,
) -> CommandResult<MinimaxImageGenerateResponse> {
    // 从 Keystore 读取 minimax API Key
    let api_key = get_api_key("minimax")?;

    // 映射宽高比到 MiniMax 支持格式
    let mapped_ratio = request
        .aspect_ratio
        .as_deref()
        .and_then(map_aspect_ratio_to_minimax);

    // 构建请求体（serde_json::Value 方便处理可选字段）
    let mut payload = serde_json::json!({
        "model": "image-01",
        "prompt": request.prompt,
        "response_format": "base64",
        "n": 1,
    });

    if let Some(ratio) = mapped_ratio {
        payload["aspect_ratio"] = serde_json::Value::String(ratio.to_string());
    }

    log::debug!(
        "[MiniMax] 发起图像生成请求: prompt=\"{}\", aspect_ratio={:?}",
        &request.prompt.chars().take(80).collect::<String>(),
        mapped_ratio
    );

    // 调用 MiniMax 图像 API
    let http_client = reqwest::Client::new();
    let response = http_client
        .post("https://api.minimaxi.com/v1/image_generation")
        .bearer_auth(&api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            AppError::LlmApi(format!("MiniMax image API network request failed: {}", e))
        })?;

    let http_status = response.status();
    let body_text = response.text().await.map_err(|e| {
        AppError::LlmApi(format!("Failed to read MiniMax image API response: {}", e))
    })?;

    log::debug!(
        "[MiniMax] HTTP {}: {}",
        http_status,
        &body_text.chars().take(300).collect::<String>()
    );

    if !http_status.is_success() {
        return Err(AppError::LlmApi(format!(
            "MiniMax image API returned HTTP error {}: {}",
            http_status, body_text
        )));
    }

    // 解析响应 JSON
    let api_resp: MinimaxApiResponse = serde_json::from_str(&body_text).map_err(|e| {
        AppError::LlmApi(format!(
            "Failed to parse MiniMax image API response: {}\nRaw response: {}",
            e,
            &body_text.chars().take(500).collect::<String>()
        ))
    })?;

    // 检查业务层状态码
    if let Some(ref base_resp) = api_resp.base_resp {
        if base_resp.status_code != 0 {
            return Err(AppError::LlmApi(format!(
                "MiniMax image API business error code={}: {}",
                base_resp.status_code, base_resp.status_msg
            )));
        }
    }

    // 提取 base64 图片数据
    let images_base64 = api_resp
        .data
        .and_then(|d| d.image_base64)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| AppError::LlmApi(
            "MiniMax image API response did not include image data (data.image_base64 is empty)".to_string()
        ))?;

    log::info!("[MiniMax] 图像生成成功，共 {} 张", images_base64.len());

    Ok(MinimaxImageGenerateResponse { images_base64 })
}

// ==================== 智谱 GLM-Image 图像生成 ====================

/// 智谱图像生成请求 DTO
#[derive(Debug, Deserialize)]
pub struct ZhipuImageGenerateRequest {
    /// 图片描述提示词
    pub prompt: String,
    /// 输出宽高比（映射到 glm-image size 参数）
    pub aspect_ratio: Option<String>,
}

/// 智谱图像生成响应 DTO
#[derive(Debug, Serialize)]
pub struct ZhipuImageGenerateResponse {
    /// PNG 图片的 base64 编码（从响应 URL 下载后转换）
    pub images_base64: Vec<String>,
    /// 原始图片 MIME 类型（通常 image/png）
    pub mime_type: String,
}

/// 智谱 API 图像生成响应（内部解析）
#[derive(Debug, serde::Deserialize)]
struct ZhipuImageApiResponse {
    data: Vec<ZhipuImageItem>,
}

#[derive(Debug, serde::Deserialize)]
struct ZhipuImageItem {
    url: String,
}

/// 将通用 aspect_ratio 字符串映射到 glm-image 支持的 size（WxH 格式）
///
/// glm-image 推荐枚举值（1024px~2048px 范围，32 的倍数）：
///   1280x1280（默认，1:1）
///   1568x1056（约 3:2 横屏）
///   1056x1568（约 2:3 竖屏）
///   1472x1088（约 4:3 横屏）
///   1088x1472（约 3:4 竖屏）
///   1728x960（约 16:9 横屏）
///   960x1728（约 9:16 竖屏）
/// 未识别比例返回 None（使用 API 默认 1280x1280）
fn map_aspect_ratio_to_zhipu_size(ratio: &str) -> Option<&'static str> {
    match ratio {
        "1:1" => Some("1280x1280"),
        "16:9" => Some("1728x960"),
        "9:16" => Some("960x1728"),
        "4:3" => Some("1472x1088"),
        "3:4" => Some("1088x1472"),
        "3:2" => Some("1568x1056"),
        "2:3" => Some("1056x1568"),
        // 宽幅近似：21:9 → 16:9 最接近
        "21:9" => Some("1728x960"),
        // Gemini 专有比例降级
        "4:5" => Some("1088x1472"),
        "5:4" => Some("1472x1088"),
        "1:4" | "1:8" => Some("960x1728"),
        "4:1" | "8:1" => Some("1728x960"),
        _ => None,
    }
}

/// 调用智谱 GLM-Image 模型生成图片
///
/// 设计说明：
/// - 智谱图像 API 采用 OpenAI /images/generations 风格
/// - 端点：https://open.bigmodel.cn/api/paas/v4/images/generations
/// - 响应返回临时 URL（有效期 30 天），Rust 端下载后转为 base64 返回
/// - 尺寸通过 size 参数（WxH 字符串）控制，aspect_ratio 在此处映射
#[tauri::command]
pub async fn zhipu_image_generate(
    request: ZhipuImageGenerateRequest,
) -> CommandResult<ZhipuImageGenerateResponse> {
    // 从 Keystore 读取 zhipu API Key
    let api_key = get_api_key("zhipu")?;

    // 映射宽高比到 glm-image size 格式
    let size = request
        .aspect_ratio
        .as_deref()
        .and_then(map_aspect_ratio_to_zhipu_size)
        .unwrap_or("1280x1280"); // 默认 1:1

    // 构建请求体
    let payload = serde_json::json!({
        "model": "glm-image",
        "prompt": request.prompt,
        "size": size,
    });

    log::debug!(
        "[Zhipu] 发起图像生成请求: prompt=\"{}\", size={}",
        &request.prompt.chars().take(80).collect::<String>(),
        size
    );

    let http_client = reqwest::Client::new();

    // 调用智谱图像 API
    let response = http_client
        .post("https://open.bigmodel.cn/api/paas/v4/images/generations")
        .bearer_auth(&api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| AppError::LlmApi(format!("Zhipu image API network request failed: {}", e)))?;

    let http_status = response.status();
    let body_text = response
        .text()
        .await
        .map_err(|e| AppError::LlmApi(format!("Failed to read Zhipu image API response: {}", e)))?;

    log::debug!(
        "[Zhipu] HTTP {}: {}",
        http_status,
        &body_text.chars().take(300).collect::<String>()
    );

    if !http_status.is_success() {
        return Err(AppError::LlmApi(format!(
            "Zhipu image API returned HTTP error {}: {}",
            http_status, body_text
        )));
    }

    // 解析响应 JSON
    let api_resp: ZhipuImageApiResponse = serde_json::from_str(&body_text).map_err(|e| {
        AppError::LlmApi(format!(
            "Failed to parse Zhipu image API response: {}\nRaw response: {}",
            e,
            &body_text.chars().take(500).collect::<String>()
        ))
    })?;

    if api_resp.data.is_empty() {
        return Err(AppError::LlmApi(
            "Zhipu image API response did not include image data (data array is empty)".to_string(),
        ));
    }

    // 下载图片 URL 并转换为 base64
    // 智谱返回临时 URL（有效期 30 天），在此处立即下载持久化
    let mut images_base64 = Vec::new();
    let mut mime_type = "image/png".to_string();

    for item in &api_resp.data {
        log::debug!(
            "[Zhipu] 下载图片 URL: {}",
            &item.url.chars().take(80).collect::<String>()
        );

        let img_response =
            http_client.get(&item.url).send().await.map_err(|e| {
                AppError::LlmApi(format!("Failed to download Zhipu image URL: {}", e))
            })?;

        // 从响应头推断 MIME 类型
        if let Some(content_type) = img_response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
        {
            // 取第一个图片的 content-type，统一返回
            if images_base64.is_empty() {
                mime_type = content_type
                    .split(';')
                    .next()
                    .unwrap_or("image/png")
                    .trim()
                    .to_string();
            }
        }

        let img_bytes = img_response
            .bytes()
            .await
            .map_err(|e| AppError::LlmApi(format!("Failed to read Zhipu image content: {}", e)))?;

        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&img_bytes);
        images_base64.push(b64);
    }

    log::info!(
        "[Zhipu] 图像生成成功，共 {} 张，MIME: {}",
        images_base64.len(),
        mime_type
    );

    Ok(ZhipuImageGenerateResponse {
        images_base64,
        mime_type,
    })
}

#[cfg(test)]
mod command_tests {
    use super::*;
    use crate::llm::types::ToolCall;

    #[test]
    fn chat_request_dto_deserializes_snake_case_reasoning_preset() {
        let request: ChatRequestDto = serde_json::from_value(serde_json::json!({
            "provider": "openai",
            "messages": [],
            "reasoning_preset": "high"
        }))
        .expect("deserialize chat request DTO");

        assert_eq!(request.reasoning_preset, Some(ReasoningPreset::High));
    }

    #[test]
    fn attempt_scoped_cancel_keeps_other_session_registrations_alive() {
        let session_id = "test-attempt-scoped-cancel";
        cancel_session(session_id);

        let (first_sender, mut first_receiver) = oneshot::channel();
        let (second_sender, mut second_receiver) = oneshot::channel();
        register_cancel_sender(session_id, Some("attempt-a".to_string()), first_sender);
        register_cancel_sender(session_id, Some("attempt-b".to_string()), second_sender);

        assert_eq!(cancel_attempt(session_id, "attempt-a"), 1);
        assert_eq!(first_receiver.try_recv(), Ok(()));
        assert!(second_receiver.try_recv().is_err());

        assert_eq!(cancel_session(session_id), 1);
        assert_eq!(second_receiver.try_recv(), Ok(()));
    }

    #[test]
    fn truncated_tool_calls_are_discarded_before_large_argument_staging() {
        let mut response = ToolChatResponse {
            response_type: "tool_use".to_string(),
            content: Some("Writing a generated page".to_string()),
            tool_calls: Some(vec![ToolCall {
                name: "file_write".to_string(),
                args: serde_json::json!({
                    "path": "index.html",
                    "content": "x".repeat(FILE_WRITE_IPC_INLINE_CONTENT_LIMIT_BYTES + 1)
                }),
                id: Some("call-truncated".to_string()),
                thought_signature: None,
            }]),
            error: None,
            finish_reason: Some("MAX-TOKENS".to_string()),
            input_tokens: None,
            output_tokens: Some(32_768),
            reasoning_content: None,
            reasoning_details: None,
        };

        assert_eq!(discard_truncated_tool_calls(&mut response), 1);
        assert!(response.tool_calls.is_none());
        assert_eq!(response.finish_reason.as_deref(), Some("MAX-TOKENS"));
    }

    #[test]
    fn completed_tool_calls_remain_available_for_staging() {
        let mut response = ToolChatResponse {
            response_type: "tool_use".to_string(),
            content: None,
            tool_calls: Some(vec![ToolCall {
                name: "file_write".to_string(),
                args: serde_json::json!({ "path": "index.html", "content": "complete" }),
                id: Some("call-complete".to_string()),
                thought_signature: None,
            }]),
            error: None,
            finish_reason: Some("stop".to_string()),
            input_tokens: None,
            output_tokens: Some(8),
            reasoning_content: None,
            reasoning_details: None,
        };

        assert_eq!(discard_truncated_tool_calls(&mut response), 0);
        assert_eq!(response.tool_calls.as_ref().map(Vec::len), Some(1));
    }
}
