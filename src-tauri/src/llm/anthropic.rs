//! Anthropic Claude API 适配器
//!
//! 实现 Claude Messages API 的调用

use super::http_client::{
    format_stream_idle_timeout, get_client, get_streaming_client, stream_idle_timeout,
    stream_start_timeout, StreamIdleDiagnostics,
};
use super::schema_compat::sanitize_tool_schema_for_compatible_gateway;
use async_trait::async_trait;
use futures::stream::Stream;
use serde::{Deserialize, Serialize};
use std::pin::Pin;

use super::types::{
    ChatMessage, ChatRequest, ChatResponse, ChatRole, ProviderConfig, ReasoningTraceCallback,
    ReasoningTraceProgress, StreamChunk, ToolCallProgressCallback, ToolCallStreamProgress,
    TOOL_CALL_PROGRESS_MIN_BYTES, TOOL_CALL_PROGRESS_STEP_BYTES,
};
use super::LlmProvider;
use crate::error::{AppError, AppResult};
use crate::text_utils::safe_truncate;

/// Anthropic API 基础 URL
const DEFAULT_BASE_URL: &str = "https://api.anthropic.com/v1";
/// 默认模型
const DEFAULT_MODEL: &str = "claude-sonnet-4-6";
/// API 版本
const API_VERSION: &str = "2023-06-01";

fn build_anthropic_tool_input_schema(
    _tool_name: &str,
    parameters: &serde_json::Value,
) -> serde_json::Value {
    let mut schema = sanitize_tool_schema_for_compatible_gateway(parameters);
    if let Some(schema_object) = schema.as_object_mut() {
        // Some Anthropic-compatible gateways only accept a plain object schema.
        // Rich validation stays in local tool execution.
        schema_object
            .entry("type".to_string())
            .or_insert_with(|| serde_json::json!("object"));
    }
    schema
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tool_input_schema_removes_top_level_composition_keywords() {
        let schema = serde_json::json!({
            "type": "object",
            "anyOf": [{ "required": ["content"] }],
            "oneOf": [{ "required": ["patches"] }],
            "allOf": [{ "required": ["path"] }],
            "not": { "required": ["forbidden"] },
            "enum": [],
            "properties": {
                "mode": {
                    "type": "string",
                    "anyOf": [{ "minLength": 1 }],
                    "enum": ["full", "patch"]
                },
                "badMode": {
                    "type": "string",
                    "enum": [1, 2]
                }
            },
            "required": ["path"]
        });

        let normalized = build_anthropic_tool_input_schema("file_write", &schema);

        assert_eq!(normalized["type"], "object");
        assert!(normalized.get("anyOf").is_none());
        assert!(normalized.get("oneOf").is_none());
        assert!(normalized.get("allOf").is_none());
        assert!(normalized.get("not").is_none());
        assert!(normalized.get("enum").is_none());
        assert_eq!(
            normalized["properties"]["mode"]["enum"],
            serde_json::json!(["full", "patch"])
        );
        assert!(normalized["properties"]["mode"].get("anyOf").is_none());
        assert!(normalized["properties"]["badMode"].get("enum").is_none());
    }

    #[test]
    fn test_stream_delta_accepts_thinking_delta() {
        let data = r#"{
            "type": "content_block_delta",
            "index": 0,
            "delta": {
                "type": "thinking_delta",
                "thinking": "Considering the next step"
            }
        }"#;

        let chunk: AnthropicStreamDelta = serde_json::from_str(data).unwrap();
        let payload = chunk.delta.unwrap();
        assert_eq!(payload.delta_type, "thinking_delta");
        assert_eq!(
            payload.thinking.as_deref(),
            Some("Considering the next step")
        );
    }

    #[test]
    fn message_delta_preserves_max_tokens_stop_reason() {
        let data = r#"{
            "type": "message_delta",
            "delta": {
                "stop_reason": "max_tokens",
                "stop_sequence": null
            },
            "usage": {
                "output_tokens": 8192
            }
        }"#;

        let message: AnthropicStreamMessageDelta = serde_json::from_str(data).unwrap();

        assert_eq!(
            message.delta.and_then(|delta| delta.stop_reason),
            Some("max_tokens".to_string())
        );
        assert_eq!(message.usage.map(|usage| usage.output_tokens), Some(8192));
    }

    #[test]
    fn non_stream_tool_response_preserves_max_tokens_stop_reason() {
        let api_response: AnthropicToolResponse = serde_json::from_value(serde_json::json!({
            "model": "claude-test",
            "content": [{
                "type": "tool_use",
                "id": "toolu_123",
                "name": "file_write",
                "input": { "path": "index.html", "content": "<html>" }
            }],
            "stop_reason": "max_tokens"
        }))
        .expect("parse Anthropic tool response");

        let response = AnthropicAdapter::extract_tool_response_from_blocks(
            &api_response.content,
            api_response.stop_reason.clone(),
        )
        .expect("extract tool response");

        assert_eq!(response.finish_reason.as_deref(), Some("max_tokens"));
    }

    #[test]
    fn native_adaptive_thinking_request_omits_temperature() {
        let adapter = AnthropicAdapter::new(ProviderConfig::new("test-key"));
        let request = ChatRequest {
            messages: vec![ChatMessage::user("think carefully")],
            model: Some("claude-opus-4-8".to_string()),
            ..Default::default()
        };

        let value =
            serde_json::to_value(adapter.build_request_body(&request)).expect("serialize request");

        assert_eq!(value["thinking"]["type"], "adaptive");
        assert_eq!(value["thinking"]["display"], "summarized");
        assert_eq!(value["output_config"]["effort"], "high");
        assert!(value.get("temperature").is_none());
    }

    #[test]
    fn compatible_gateway_request_does_not_enable_native_thinking() {
        let adapter = AnthropicAdapter::new(
            ProviderConfig::new("test-key").with_base_url("https://example.com/v1"),
        );
        let request = ChatRequest {
            messages: vec![ChatMessage::user("think carefully")],
            model: Some("claude-opus-4-8".to_string()),
            ..Default::default()
        };

        let value =
            serde_json::to_value(adapter.build_request_body(&request)).expect("serialize request");

        assert!(value.get("thinking").is_none());
        assert!(value.get("output_config").is_none());
        let temperature = value["temperature"].as_f64().expect("temperature number");
        assert!((temperature - 0.7).abs() < 0.0001);
    }

    #[test]
    fn adaptive_thinking_model_matcher_covers_supported_families() {
        let enabled_models = [
            "claude-opus-4-5",
            "claude-opus-4.6",
            "claude-opus-4-7",
            "claude-4-8-opus",
            "claude-sonnet-4-5",
            "claude-4.6-sonnet",
            "claude-sonnet-5",
            "claude-5-sonnet",
            "claude-fable-5",
        ];

        for model in enabled_models {
            assert!(
                AnthropicAdapter::model_uses_adaptive_thinking(model),
                "{model} should enable adaptive thinking"
            );
        }

        let disabled_models = ["claude-haiku-4-5", "claude-sonnet-4-4", "gpt-5"];
        for model in disabled_models {
            assert!(
                !AnthropicAdapter::model_uses_adaptive_thinking(model),
                "{model} should not enable adaptive thinking"
            );
        }
    }
}

/// Anthropic 适配器
///
/// 使用全局共享 HTTP Client，复用连接池
pub struct AnthropicAdapter {
    config: ProviderConfig,
}

impl AnthropicAdapter {
    /// 创建新的 Anthropic 适配器
    pub fn new(config: ProviderConfig) -> Self {
        Self { config }
    }

    /// 获取基础 URL
    fn base_url(&self) -> &str {
        self.config.base_url.as_deref().unwrap_or(DEFAULT_BASE_URL)
    }

    /// 获取使用的模型
    fn get_model(&self, request_model: Option<&str>) -> String {
        request_model
            .or(self.config.default_model.as_deref())
            .unwrap_or(DEFAULT_MODEL)
            .to_string()
    }

    fn is_native_api(&self) -> bool {
        match &self.config.base_url {
            None => true,
            Some(url) => url.contains("api.anthropic.com"),
        }
    }

    fn model_uses_adaptive_thinking(model: &str) -> bool {
        let model = model.to_ascii_lowercase().replace('.', "-");
        if !model.contains("claude") {
            return false;
        }

        const OPUS_VERSIONS: &[&str] = &["4-5", "4-6", "4-7", "4-8"];
        const SONNET_VERSIONS: &[&str] = &["4-5", "4-6", "5"];

        OPUS_VERSIONS
            .iter()
            .any(|version| Self::model_matches_family_version(&model, "opus", version))
            || SONNET_VERSIONS
                .iter()
                .any(|version| Self::model_matches_family_version(&model, "sonnet", version))
            || Self::model_matches_family_version(&model, "fable", "5")
    }

    fn model_matches_family_version(model: &str, family: &str, version: &str) -> bool {
        model.contains(&format!("{family}-{version}"))
            || model.contains(&format!("{version}-{family}"))
    }

    fn thinking_config_for_model(
        &self,
        model: &str,
        max_tokens: u32,
    ) -> Option<AnthropicThinkingConfig> {
        if self.is_native_api() && max_tokens >= 1024 && Self::model_uses_adaptive_thinking(model) {
            Some(AnthropicThinkingConfig {
                thinking_type: "adaptive".to_string(),
                display: Some("summarized".to_string()),
            })
        } else {
            None
        }
    }

    fn output_config_for_thinking(
        thinking: &Option<AnthropicThinkingConfig>,
    ) -> Option<AnthropicOutputConfig> {
        thinking.as_ref().map(|_| AnthropicOutputConfig {
            effort: "high".to_string(),
        })
    }

    /// 构建Request body
    fn build_request_body(&self, request: &ChatRequest) -> AnthropicRequest {
        let model = self.get_model(request.model.as_deref());
        let max_tokens = request
            .max_tokens
            .unwrap_or(super::types::DEFAULT_LLM_MAX_TOKENS);
        let thinking = self.thinking_config_for_model(&model, max_tokens);
        let output_config = Self::output_config_for_thinking(&thinking);
        let temperature = if thinking.is_some() {
            None
        } else {
            request.temperature
        };

        // 分离 system 消息和其他消息
        let mut system_content: Option<String> = None;
        let mut messages: Vec<AnthropicMessage> = Vec::new();

        for msg in &request.messages {
            match msg.role {
                ChatRole::System => {
                    // Anthropic 使用单独的 system 字段
                    system_content = Some(msg.content.clone());
                }
                ChatRole::User => {
                    // 检查是否有图片附件
                    if let Some(ref images) = msg.images {
                        if !images.is_empty() {
                            // 多模态消息：使用 content 数组格式
                            let mut content_parts: Vec<AnthropicContentPart> = Vec::new();

                            // 添加文本内容
                            content_parts.push(AnthropicContentPart::Text {
                                text: msg.content.clone(),
                            });

                            // 添加图片
                            for img in images {
                                content_parts.push(AnthropicContentPart::Image {
                                    source: AnthropicImageSource {
                                        source_type: "base64".to_string(),
                                        media_type: img.mime_type.clone(),
                                        data: img.data.clone(),
                                    },
                                });
                            }

                            log::trace!("[AnthropicAdapter] 📷 添加 {} 张图片到请求", images.len());

                            messages.push(AnthropicMessage {
                                role: "user".to_string(),
                                content: AnthropicMessageContent::Parts(content_parts),
                            });
                            continue;
                        }
                    }

                    // 普通文本消息
                    messages.push(AnthropicMessage {
                        role: "user".to_string(),
                        content: AnthropicMessageContent::Text(msg.content.clone()),
                    });
                }
                ChatRole::Assistant => {
                    messages.push(AnthropicMessage {
                        role: "assistant".to_string(),
                        content: AnthropicMessageContent::Text(msg.content.clone()),
                    });
                }
            }
        }

        AnthropicRequest {
            model,
            messages,
            system: system_content,
            max_tokens,
            temperature,
            thinking,
            output_config,
            stream: request.stream,
        }
    }

    // ==================== Function Calling 支持 ====================

    /// 构建 Function Calling Request body（chat_with_tools 和 chat_stream_with_tools 共用）
    ///
    /// 将 ToolChatMessage 转换为 Anthropic 格式消息，构建工具定义，
    /// 返回 (Request body JSON, 模型名称, Request body大小 KB)
    fn build_tool_request_body(
        &self,
        request: &super::types::ToolChatRequest,
    ) -> (serde_json::Value, String, usize) {
        use super::types::ToolChatRole;

        let model = self.get_model(request.model_id.as_deref());

        // 判断是否为原生 Anthropic API（非代理）
        // 原生 API 支持 tool_result.content 内嵌 image block，代理平台不支持
        let is_native_api = self.is_native_api();

        // 分离 system 消息和其他消息
        let mut system_content: Option<String> = None;
        let mut messages: Vec<serde_json::Value> = Vec::new();

        for msg in &request.messages {
            match msg.role {
                ToolChatRole::System => {
                    system_content = Some(msg.content.clone());
                }
                ToolChatRole::User => {
                    if let Some(ref images) = msg.images {
                        if !images.is_empty() {
                            let mut content_parts = vec![serde_json::json!({
                                "type": "text",
                                "text": msg.content
                            })];
                            for img in images {
                                content_parts.push(serde_json::json!({
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": img.mime_type,
                                        "data": img.data
                                    }
                                }));
                            }
                            log::trace!(
                                "[AnthropicAdapter] 📷 chat_with_tools: 添加 {} 张图片",
                                images.len()
                            );
                            messages.push(serde_json::json!({
                                "role": "user",
                                "content": content_parts
                            }));
                        } else {
                            messages.push(serde_json::json!({
                                "role": "user",
                                "content": msg.content
                            }));
                        }
                    } else {
                        messages.push(serde_json::json!({
                            "role": "user",
                            "content": msg.content
                        }));
                    }
                }
                ToolChatRole::Assistant => {
                    if let Some(ref tool_calls) = msg.tool_calls {
                        let mut content_blocks: Vec<serde_json::Value> = Vec::new();
                        if !msg.content.is_empty() {
                            content_blocks.push(serde_json::json!({
                                "type": "text",
                                "text": msg.content
                            }));
                        }
                        for tc in tool_calls {
                            let tool_id = tc
                                .id
                                .clone()
                                .unwrap_or_else(|| format!("toolu_{}", tc.name));
                            content_blocks.push(serde_json::json!({
                                "type": "tool_use",
                                "id": tool_id,
                                "name": tc.name,
                                "input": tc.args
                            }));
                        }
                        messages.push(serde_json::json!({
                            "role": "assistant",
                            "content": content_blocks
                        }));
                    } else {
                        messages.push(serde_json::json!({
                            "role": "assistant",
                            "content": msg.content
                        }));
                    }
                }
                ToolChatRole::Tool => {
                    let tool_use_id = msg
                        .tool_call_id
                        .clone()
                        .unwrap_or_else(|| "unknown".to_string());
                    log::trace!("[AnthropicAdapter] 🔧 Tool msg | id: {} | content_len: {} | images: {:?} | native: {}",
                        tool_use_id, msg.content.len(),
                        msg.images.as_ref().map(|imgs| imgs.len()),
                        is_native_api);

                    let image_attachments = msg.images.as_deref().filter(|imgs| !imgs.is_empty());
                    let mut new_blocks: Vec<serde_json::Value> = Vec::new();

                    if let Some(images) = image_attachments {
                        if is_native_api {
                            let mut tool_result_content = vec![serde_json::json!({
                                "type": "text",
                                "text": msg.content
                            })];
                            for img in images {
                                tool_result_content.push(serde_json::json!({
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": img.mime_type,
                                        "data": img.data
                                    }
                                }));
                            }
                            log::trace!("[AnthropicAdapter] 📷 原生 API: tool_result.content 内嵌 {} 张图片",
                                images.len());
                            new_blocks.push(serde_json::json!({
                                "type": "tool_result",
                                "tool_use_id": tool_use_id,
                                "content": tool_result_content
                            }));
                        } else {
                            new_blocks.push(serde_json::json!({
                                "type": "tool_result",
                                "tool_use_id": tool_use_id,
                                "content": msg.content
                            }));
                            for img in images {
                                new_blocks.push(serde_json::json!({
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": img.mime_type,
                                        "data": img.data
                                    }
                                }));
                            }
                            new_blocks.push(serde_json::json!({
                                "type": "text",
                                "text": "The image above is file content read by a tool. Analyze it directly and describe what is in the image."
                            }));
                            log::trace!("[AnthropicAdapter] 📷 代理模式: user content 注入 {} 张图片(tool_result 同级)",
                                images.len());
                        }
                    } else {
                        new_blocks.push(serde_json::json!({
                            "type": "tool_result",
                            "tool_use_id": tool_use_id,
                            "content": msg.content
                        }));
                    }

                    // 合并策略：Anthropic 要求同一 assistant 的所有 tool_result 在同一条 user 消息中
                    let last_role = messages
                        .last()
                        .and_then(|m| m.get("role"))
                        .and_then(|r| r.as_str())
                        .unwrap_or("none");
                    log::trace!("[AnthropicAdapter] 🔍 V2 合并检测: messages.len={}, last_role={}, tool_use_id={}",
                        messages.len(), last_role, tool_use_id);
                    let should_merge = last_role == "user";

                    if should_merge {
                        if let Some(last_msg) = messages.last_mut() {
                            if let Some(content_arr) =
                                last_msg.get_mut("content").and_then(|c| c.as_array_mut())
                            {
                                content_arr.extend(new_blocks);
                                // 重排确保 tool_result 在前，image/text 在后
                                content_arr.sort_by_key(|block| {
                                    if block.get("type").and_then(|t| t.as_str())
                                        == Some("tool_result")
                                    {
                                        0
                                    } else {
                                        1
                                    }
                                });
                                log::trace!("[AnthropicAdapter] 🔗 合并 tool_result 到已有 user 消息 (content blocks: {}, 已重排)",
                                    content_arr.len());
                            }
                        }
                    } else {
                        messages.push(serde_json::json!({
                            "role": "user",
                            "content": new_blocks
                        }));
                    }
                }
            }
        }

        // 构建工具定义（Anthropic 格式）
        let tools: Option<Vec<serde_json::Value>> = request.tools.as_ref().map(|tool_defs| {
            tool_defs
                .iter()
                .map(|t| {
                    let input_schema = build_anthropic_tool_input_schema(&t.name, &t.parameters);
                    serde_json::json!({
                        "name": t.name,
                        "description": t.description,
                        "input_schema": input_schema
                    })
                })
                .collect()
        });

        // 构建Request body（不含 stream 字段，由调用方设置）
        let max_tokens = request
            .max_tokens
            .unwrap_or(super::types::DEFAULT_LLM_MAX_TOKENS);
        let mut body = serde_json::json!({
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens
        });
        if let Some(sys) = system_content {
            body["system"] = serde_json::Value::String(sys);
        }
        if let Some(tools_val) = tools {
            body["tools"] = serde_json::Value::Array(tools_val);
            body["tool_choice"] = serde_json::json!({"type": "auto"});
        }
        let thinking = self.thinking_config_for_model(&model, max_tokens);
        if let Some(thinking_config) = thinking {
            body["thinking"] = serde_json::to_value(thinking_config).unwrap_or_else(
                |_| serde_json::json!({"type": "adaptive", "display": "summarized"}),
            );
            body["output_config"] = serde_json::json!({"effort": "high"});
        } else if let Some(temp) = request.temperature {
            body["temperature"] = serde_json::json!(temp);
        }

        // 诊断日志：记录Request body大小
        let body_str = serde_json::to_string(&body).unwrap_or_default();
        let body_size_kb = body_str.len() / 1024;
        log::trace!(
            "[AnthropicAdapter] 📊 Request body大小: {} KB ({} bytes), messages: {}",
            body_size_kb,
            body_str.len(),
            messages.len()
        );

        (body, model, body_size_kb)
    }

    /// 带工具的聊天请求（Anthropic Tools API，非流式）
    ///
    /// Claude 天然支持在工具调用时同时输出思考文字（text content block），
    /// 这是相比 Gemini 的核心优势。
    pub async fn chat_with_tools(
        &self,
        request: super::types::ToolChatRequest,
    ) -> AppResult<super::types::ToolChatResponse> {
        use super::types::ToolChatResponse;

        let url = format!("{}/messages", self.base_url());
        let (body, model, body_size_kb) = self.build_tool_request_body(&request);

        log::trace!(
            "[AnthropicAdapter] 🔧 chat_with_tools | URL: {} | model: {} | body: {} KB",
            url,
            model,
            body_size_kb
        );

        // 发送非流式请求
        let response = get_client()
            .post(&url)
            .header("x-api-key", &self.config.api_key)
            .header("anthropic-version", API_VERSION)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                let error_type = if e.is_timeout() {
                    "timeout"
                } else if e.is_connect() {
                    "connection failed"
                } else {
                    "network error"
                };
                AppError::LlmApi(format!(
                    "Request failed ({}): {} | Request body: {} KB",
                    error_type, e, body_size_kb
                ))
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            let error_msg = format!("API returned an error ({}): {}", status, error_text);
            log::warn!("[AnthropicAdapter] chat_with_tools 错误: {}", error_msg);
            return Ok(ToolChatResponse {
                response_type: "error".to_string(),
                content: Some(error_msg.clone()),
                tool_calls: None,
                error: Some(error_msg),
                finish_reason: None,
                input_tokens: None,
                output_tokens: None,
                reasoning_content: None,
            });
        }

        let response_text = response
            .text()
            .await
            .map_err(|e| AppError::LlmApi(format!("Failed to read response: {}", e)))?;

        // 预处理：修复 MiniMax 等供应商响应 JSON 中的残缺 \uXX Unicode 转义
        let response_text = super::json_repair::sanitize_sse_data(&response_text);

        let api_response: AnthropicToolResponse =
            serde_json::from_str(&response_text).map_err(|e| {
                AppError::LlmApi(format!(
                    "Failed to parse response: {} | Raw response: {}",
                    e,
                    safe_truncate(&response_text, 500)
                ))
            })?;

        // 从 content blocks 中分离 text 和 tool_use，并保留 provider 的结束原因。
        Self::extract_tool_response_from_blocks(&api_response.content, api_response.stop_reason)
    }

    /// 流式 Function Calling 请求（内部消费 SSE，外部返回完整响应）
    ///
    /// 行为与 chat_with_tools() 完全一致，但使用 SSE 流式接收，
    /// 避免长时间 idle 导致链路timeout。返回类型不变，调用方无感知。
    pub async fn chat_stream_with_tools(
        &self,
        request: super::types::ToolChatRequest,
        progress_callback: Option<ToolCallProgressCallback>,
        reasoning_callback: Option<ReasoningTraceCallback>,
    ) -> AppResult<super::types::ToolChatResponse> {
        use super::types::ToolChatResponse;
        use eventsource_stream::Eventsource;
        use futures::StreamExt;

        let url = format!("{}/messages", self.base_url());
        let (mut body, model, body_size_kb) = self.build_tool_request_body(&request);

        // 关键：启用流式模式以保持连接活跃
        body["stream"] = serde_json::json!(true);

        log::trace!(
            "[AnthropicAdapter] 🔧 chat_stream_with_tools | URL: {} | model: {} | body: {} KB",
            url,
            model,
            body_size_kb
        );

        let start_timeout = stream_start_timeout();
        let response = tokio::time::timeout(
            start_timeout,
            get_streaming_client()
                .post(&url)
                .header("x-api-key", &self.config.api_key)
                .header("anthropic-version", API_VERSION)
                .header("Content-Type", "application/json")
                .json(&body)
                .send(),
        )
        .await
        .map_err(|_| {
            AppError::LlmApi(format!(
                "Streaming connection timed out (no response headers within {} seconds)",
                start_timeout.as_secs()
            ))
        })?
        .map_err(|e| {
            let error_type = if e.is_timeout() {
                "timeout"
            } else if e.is_connect() {
                "connection failed"
            } else {
                "network error"
            };
            AppError::LlmApi(format!(
                "Streaming request failed ({}): {} | Request body: {} KB",
                error_type, e, body_size_kb
            ))
        })?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            let error_msg = format!("API returned an error ({}): {}", status, error_text);
            log::warn!(
                "[AnthropicAdapter] chat_stream_with_tools 错误: {}",
                error_msg
            );
            return Ok(ToolChatResponse {
                response_type: "error".to_string(),
                content: Some(error_msg.clone()),
                tool_calls: None,
                error: Some(error_msg),
                finish_reason: None,
                input_tokens: None,
                output_tokens: None,
                reasoning_content: None,
            });
        }

        // SSE 事件流消费循环
        // Anthropic SSE 使用命名事件：content_block_start / content_block_delta / message_stop
        let mut stream = response.bytes_stream().eventsource();

        // content block 累积状态：按 index 存储 (type, id, name, text_buffer, json_buffer)
        let mut block_states: Vec<ContentBlockState> = Vec::new();
        let mut reasoning_buffer = String::new();
        let mut chunk_count: u64 = 0;
        let mut last_event_type: Option<String> = None;
        // 累积 usage 数据
        let mut final_input_tokens: Option<u32> = None;
        let mut final_output_tokens: Option<u32> = None;
        let mut final_finish_reason: Option<String> = None;

        let idle_timeout = stream_idle_timeout();
        loop {
            let event = match tokio::time::timeout(idle_timeout, stream.next()).await {
                Ok(Some(event)) => event,
                Ok(None) => break,
                Err(_) => {
                    return Err(AppError::LlmApi(format_stream_idle_timeout(
                        idle_timeout,
                        StreamIdleDiagnostics {
                            protocol: "anthropic-messages",
                            events: chunk_count,
                            last_event: last_event_type.as_deref(),
                            content_chars: block_states
                                .iter()
                                .map(|state| state.text_buffer.chars().count())
                                .sum(),
                            reasoning_chars: reasoning_buffer.chars().count(),
                            tool_calls: block_states
                                .iter()
                                .filter(|state| state.block_type == "tool_use")
                                .count(),
                            tool_arg_bytes: block_states
                                .iter()
                                .filter(|state| state.block_type == "tool_use")
                                .map(|state| state.json_buffer.len())
                                .sum(),
                        },
                    )));
                }
            };

            match event {
                Ok(ev) => {
                    // 预处理：修复 MiniMax 等供应商 SSE JSON 中的残缺 \uXX Unicode 转义
                    // MiniMax 服务器 bug：长响应中偶尔生成 \uXX（2位）而非合法 \uXXXX（4位），
                    // serde_json 严格遵循规范会直接报 unexpected end of hex escape 导致 500
                    let data = super::json_repair::sanitize_sse_data(&ev.data);
                    let event_type = if ev.event.is_empty() {
                        "message".to_string()
                    } else {
                        ev.event
                    };
                    last_event_type = Some(event_type.clone());

                    match event_type.as_str() {
                        "message_start" => {
                            // 提取 input_tokens
                            if let Ok(msg) =
                                serde_json::from_str::<AnthropicStreamMessageStart>(&data)
                            {
                                if let Some(usage) = msg.message.usage {
                                    final_input_tokens = Some(usage.input_tokens as u32);
                                }
                            }
                        }
                        "content_block_start" => {
                            if let Ok(block_start) =
                                serde_json::from_str::<AnthropicStreamBlockStart>(&data)
                            {
                                let cb = &block_start.content_block;
                                while block_states.len() <= block_start.index {
                                    block_states.push(ContentBlockState::default());
                                }
                                block_states[block_start.index] = ContentBlockState {
                                    block_type: cb.block_type.clone(),
                                    id: cb.id.clone(),
                                    name: cb.name.clone(),
                                    text_buffer: String::new(),
                                    json_buffer: String::new(),
                                    last_progress_bytes: 0,
                                };
                            }
                        }
                        "content_block_delta" => {
                            if let Ok(block_delta) =
                                serde_json::from_str::<AnthropicStreamBlockDelta>(&data)
                            {
                                let idx = block_delta.index;
                                if idx < block_states.len() {
                                    let state = &mut block_states[idx];
                                    match block_delta.delta.delta_type.as_str() {
                                        "text_delta" => {
                                            if let Some(ref text) = block_delta.delta.text {
                                                state.text_buffer.push_str(text);
                                            }
                                        }
                                        "input_json_delta" => {
                                            if let Some(ref json) = block_delta.delta.partial_json {
                                                state.json_buffer.push_str(json);
                                                if let Some(ref callback) = progress_callback {
                                                    state.emit_progress_if_needed(idx, callback);
                                                }
                                            }
                                        }
                                        "thinking_delta" => {
                                            if let Some(ref thinking) = block_delta.delta.thinking {
                                                if !thinking.is_empty() {
                                                    reasoning_buffer.push_str(thinking);
                                                    if let Some(callback) =
                                                        reasoning_callback.as_ref()
                                                    {
                                                        callback(ReasoningTraceProgress {
                                                            delta: thinking.clone(),
                                                            done: false,
                                                        });
                                                    }
                                                }
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }
                        "message_delta" => {
                            // 提取 output_tokens
                            if let Ok(msg) =
                                serde_json::from_str::<AnthropicStreamMessageDelta>(&data)
                            {
                                if let Some(usage) = msg.usage {
                                    final_output_tokens = Some(usage.output_tokens as u32);
                                }
                                if let Some(stop_reason) =
                                    msg.delta.and_then(|delta| delta.stop_reason)
                                {
                                    final_finish_reason = Some(stop_reason);
                                }
                            }
                        }
                        "message_stop" => {
                            break;
                        }
                        _ => {
                            // 忽略 ping 等其他事件
                        }
                    }
                    chunk_count += 1;
                }
                Err(e) => {
                    return Err(AppError::LlmApi(format!(
                        "Streaming error (received {} events): {}",
                        chunk_count, e
                    )));
                }
            }
        }

        // 组装响应：从累积的 block_states 中提取 text 和 tool_use
        if !reasoning_buffer.is_empty() {
            if let Some(callback) = reasoning_callback.as_ref() {
                callback(ReasoningTraceProgress {
                    delta: String::new(),
                    done: true,
                });
            }
        }

        let mut text_parts: Vec<String> = Vec::new();
        let mut tool_calls: Vec<super::types::ToolCall> = Vec::new();

        for state in &block_states {
            match state.block_type.as_str() {
                "text" => {
                    if !state.text_buffer.is_empty() {
                        text_parts.push(state.text_buffer.clone());
                    }
                }
                "tool_use" => {
                    if let Some(ref name) = state.name {
                        // 将累积的 JSON 字符串解析为参数对象，解析失败时尝试修复而非静默回退为空对象
                        // 背景：file_write 的 content 参数含大量代码时，LLM 可能产出格式轻微损坏的 JSON（未转义引号/控制字符/截断），导致所有参数丢失
                        let args: serde_json::Value = match serde_json::from_str(&state.json_buffer)
                        {
                            Ok(v) => v,
                            Err(e) => {
                                let preview = safe_truncate(&state.json_buffer, 200);
                                log::warn!(
                                    "[AnthropicAdapter] ⚠️ tool_call args 解析失败 (tool: {}): {} | buffer_len: {} | 前{}字符: {}",
                                    name, e, state.json_buffer.len(), preview.len(),
                                    preview
                                );
                                super::json_repair::repair_tool_call_json(&state.json_buffer)
                                    .unwrap_or_else(|| {
                                        log::warn!(
                                            "[AnthropicAdapter] JSON 修复也失败，回退为空对象"
                                        );
                                        serde_json::json!({})
                                    })
                            }
                        };

                        tool_calls.push(super::types::ToolCall {
                            name: name.clone(),
                            args,
                            id: state.id.clone(),
                            thought_signature: None,
                        });
                    }
                }
                _ => {} // 忽略 thinking 等
            }
        }

        let content = if text_parts.is_empty() {
            None
        } else {
            Some(text_parts.join(""))
        };

        log::trace!(
            "[AnthropicAdapter] 📊 流式接收完成: {} events, content: {} 字符, tool_calls: {}",
            chunk_count,
            content.as_ref().map_or(0, |c| c.len()),
            tool_calls.len()
        );

        if !tool_calls.is_empty() {
            log::trace!(
                "[AnthropicAdapter] 🔧 流式收到 {} 个工具调用, 伴随文字: {} 字符",
                tool_calls.len(),
                content.as_ref().map_or(0, |c| c.len())
            );

            return Ok(ToolChatResponse {
                response_type: "tool_use".to_string(),
                content,
                tool_calls: Some(tool_calls),
                error: None,
                finish_reason: final_finish_reason,
                input_tokens: final_input_tokens,
                output_tokens: final_output_tokens,
                reasoning_content: None,
            });
        }

        // 检查 XML 格式工具调用 fallback
        if let Some(ref text_content) = content {
            if let Some(xml_tool_calls) = Self::try_parse_xml_tool_calls(text_content) {
                log::trace!(
                    "[AnthropicAdapter] 🔄 流式: 从文本中解析到 XML 格式工具调用: {} 个",
                    xml_tool_calls.len()
                );
                return Ok(ToolChatResponse {
                    response_type: "tool_use".to_string(),
                    content,
                    tool_calls: Some(xml_tool_calls),
                    error: None,
                    finish_reason: final_finish_reason,
                    input_tokens: final_input_tokens,
                    output_tokens: final_output_tokens,
                    reasoning_content: None,
                });
            }
        }

        log::trace!(
            "[AnthropicAdapter] 📝 流式文本响应: {} 字符",
            content.as_ref().map_or(0, |c| c.len())
        );

        Ok(ToolChatResponse {
            response_type: "text".to_string(),
            content,
            tool_calls: None,
            error: None,
            finish_reason: final_finish_reason,
            input_tokens: final_input_tokens,
            output_tokens: final_output_tokens,
            reasoning_content: None,
        })
    }

    /// 从非流式响应的 content blocks 中提取 text 和 tool_use
    fn extract_tool_response_from_blocks(
        blocks: &[AnthropicToolContentBlock],
        finish_reason: Option<String>,
    ) -> AppResult<super::types::ToolChatResponse> {
        use super::types::{ToolCall as TypesToolCall, ToolChatResponse};

        let mut text_parts: Vec<String> = Vec::new();
        let mut tool_calls: Vec<TypesToolCall> = Vec::new();

        for block in blocks {
            match block.content_type.as_str() {
                "text" => {
                    if let Some(ref text) = block.text {
                        text_parts.push(text.clone());
                    }
                }
                "tool_use" => {
                    if let (Some(name), Some(input)) = (&block.name, &block.input) {
                        tool_calls.push(TypesToolCall {
                            name: name.clone(),
                            args: input.clone(),
                            id: block.id.clone(),
                            thought_signature: None,
                        });
                    }
                }
                _ => {}
            }
        }

        let content = if text_parts.is_empty() {
            None
        } else {
            Some(text_parts.join(""))
        };

        if !tool_calls.is_empty() {
            log::trace!(
                "[AnthropicAdapter] 🔧 收到 {} 个工具调用, 伴随文字: {} 字符",
                tool_calls.len(),
                content.as_ref().map_or(0, |c| c.len())
            );

            return Ok(ToolChatResponse {
                response_type: "tool_use".to_string(),
                content,
                tool_calls: Some(tool_calls),
                error: None,
                finish_reason,
                input_tokens: None,
                output_tokens: None,
                reasoning_content: None,
            });
        }

        // 检查 XML 格式工具调用 fallback
        if let Some(ref text_content) = content {
            if let Some(xml_tool_calls) = Self::try_parse_xml_tool_calls(text_content) {
                log::trace!(
                    "[AnthropicAdapter] 🔄 从文本中解析到 XML 格式工具调用: {} 个",
                    xml_tool_calls.len()
                );
                return Ok(ToolChatResponse {
                    response_type: "tool_use".to_string(),
                    content,
                    tool_calls: Some(xml_tool_calls),
                    error: None,
                    finish_reason,
                    input_tokens: None,
                    output_tokens: None,
                    reasoning_content: None,
                });
            }
        }

        log::trace!(
            "[AnthropicAdapter] 📝 文本响应: {} 字符",
            content.as_ref().map_or(0, |c| c.len())
        );

        Ok(ToolChatResponse {
            response_type: "text".to_string(),
            content,
            tool_calls: None,
            error: None,
            finish_reason,
            input_tokens: None,
            output_tokens: None,
            reasoning_content: None,
        })
    }

    /// 从文本内容中尝试解析 XML 格式的工具调用（防御性回退）
    ///
    /// 某些 Claude 模型可能返回 `<function_calls><invoke name="...">` 格式而非原生 tool_use，
    /// 此方法使用正则表达式提取工具名和参数，将其转换为结构化 ToolCall。
    /// 仅在 API 未返回原生 tool_use content blocks 时调用。
    fn try_parse_xml_tool_calls(text: &str) -> Option<Vec<super::types::ToolCall>> {
        use super::types::ToolCall as TypesToolCall;

        // 快速检查：文本中是否包含 XML 工具调用标记
        if !text.contains("<function_calls>") || !text.contains("<invoke") {
            return None;
        }

        let mut tool_calls: Vec<TypesToolCall> = Vec::new();

        // 提取每个 <invoke> 块
        // 格式: <invoke name="tool_name"><parameter name="param_name">value</parameter></invoke>
        let text_str = text;
        let mut search_pos = 0;

        while search_pos < text_str.len() {
            // 查找 <invoke name="..."> 开始标记
            let invoke_start = match text_str[search_pos..].find("<invoke name=\"") {
                Some(pos) => search_pos + pos,
                None => break,
            };

            // 提取工具名
            let name_start = invoke_start + "<invoke name=\"".len();
            let name_end = match text_str[name_start..].find('"') {
                Some(pos) => name_start + pos,
                None => break,
            };
            let tool_name = &text_str[name_start..name_end];

            // 查找对应的 </invoke> 结束标记
            let invoke_end = match text_str[name_end..].find("</invoke>") {
                Some(pos) => name_end + pos + "</invoke>".len(),
                None => break,
            };

            // 从 invoke 块中提取所有 <parameter> 参数
            let invoke_body = &text_str[name_end..invoke_end];
            let mut args = serde_json::Map::new();
            let mut param_pos = 0;

            while param_pos < invoke_body.len() {
                // 查找 <parameter name="..."> 标记
                let param_start = match invoke_body[param_pos..].find("<parameter name=\"") {
                    Some(pos) => param_pos + pos,
                    None => break,
                };
                let pname_start = param_start + "<parameter name=\"".len();
                let pname_end = match invoke_body[pname_start..].find('"') {
                    Some(pos) => pname_start + pos,
                    None => break,
                };
                let param_name = &invoke_body[pname_start..pname_end];

                // 查找参数值（> 之后到 </parameter> 之前）
                let value_start = match invoke_body[pname_end..].find('>') {
                    Some(pos) => pname_end + pos + 1,
                    None => break,
                };
                let value_end = match invoke_body[value_start..].find("</parameter>") {
                    Some(pos) => value_start + pos,
                    None => break,
                };
                let param_value = invoke_body[value_start..value_end].trim();

                args.insert(
                    param_name.to_string(),
                    serde_json::Value::String(param_value.to_string()),
                );

                param_pos = value_end + "</parameter>".len();
            }

            // 生成唯一 id（XML 格式不包含 id，需要自行生成）
            let tool_id = format!("toolu_xml_{}", tool_calls.len());

            tool_calls.push(TypesToolCall {
                name: tool_name.to_string(),
                args: serde_json::Value::Object(args),
                id: Some(tool_id),
                thought_signature: None,
            });

            search_pos = invoke_end;
        }

        if tool_calls.is_empty() {
            None
        } else {
            Some(tool_calls)
        }
    }
}

#[async_trait]
impl LlmProvider for AnthropicAdapter {
    async fn chat(&self, request: ChatRequest) -> AppResult<ChatResponse> {
        let url = format!("{}/messages", self.base_url());
        let body = self.build_request_body(&request);

        let response = get_client()
            .post(&url)
            .header("x-api-key", &self.config.api_key)
            .header("anthropic-version", API_VERSION)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::LlmApi(format!("Request failed: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unable to read error message".to_string());
            return Err(AppError::LlmApi(format!(
                "API returned an error ({}): {}",
                status, error_text
            )));
        }

        let api_response: AnthropicResponse = response
            .json()
            .await
            .map_err(|e| AppError::LlmApi(format!("Failed to parse response: {}", e)))?;

        // 提取文本内容
        let content = api_response
            .content
            .iter()
            .filter_map(|block| {
                if block.content_type == "text" {
                    block.text.clone()
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("");

        Ok(ChatResponse {
            content,
            model: api_response.model,
            input_tokens: Some(api_response.usage.input_tokens),
            output_tokens: Some(api_response.usage.output_tokens),
            finish_reason: Some(api_response.stop_reason.unwrap_or_default()),
        })
    }

    async fn chat_stream(
        &self,
        request: ChatRequest,
    ) -> AppResult<Pin<Box<dyn Stream<Item = AppResult<StreamChunk>> + Send>>> {
        use eventsource_stream::Eventsource;
        use futures::StreamExt;
        use std::sync::{Arc, Mutex};

        let url = format!("{}/messages", self.base_url());
        let mut body = self.build_request_body(&request);
        body.stream = true;

        let start_timeout = stream_start_timeout();
        let response = tokio::time::timeout(
            start_timeout,
            get_streaming_client()
                .post(&url)
                .header("x-api-key", &self.config.api_key)
                .header("anthropic-version", API_VERSION)
                .header("Content-Type", "application/json")
                .json(&body)
                .send(),
        )
        .await
        .map_err(|_| {
            AppError::LlmApi(format!(
                "Streaming connection timed out (no response headers within {} seconds)",
                start_timeout.as_secs()
            ))
        })?
        .map_err(|e| AppError::LlmApi(format!("Request failed: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unable to read error message".to_string());
            return Err(AppError::LlmApi(format!(
                "API returned an error ({}): {}",
                status, error_text
            )));
        }

        let stream = response.bytes_stream().eventsource();

        // 跨 SSE 事件累积 usage 与 stop_reason。
        // Anthropic 将真实结束原因放在 message_delta.delta.stop_reason，
        // message_stop 本身不再携带该字段。
        let usage_state: Arc<Mutex<(Option<u32>, Option<u32>)>> =
            Arc::new(Mutex::new((None, None)));
        let usage_clone = usage_state.clone();
        let finish_reason_state: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let finish_reason_clone = finish_reason_state.clone();

        let mapped_stream = stream.map(move |event| {
            match event {
                Ok(ev) => {
                    let data = ev.data;
                    let event_type = ev.event;

                    match event_type.as_str() {
                        "message_start" => {
                            // 提取 input_tokens
                            if let Ok(msg) =
                                serde_json::from_str::<AnthropicStreamMessageStart>(&data)
                            {
                                if let Some(usage) = msg.message.usage {
                                    if let Ok(mut state) = usage_clone.lock() {
                                        state.0 = Some(usage.input_tokens as u32);
                                    }
                                }
                            }
                            Ok(StreamChunk {
                                delta: String::new(),
                                reasoning: None,
                                done: false,
                                finish_reason: None,
                                input_tokens: None,
                                output_tokens: None,
                            })
                        }
                        "message_delta" => {
                            // 提取 output_tokens 与真实 stop_reason
                            if let Ok(msg) =
                                serde_json::from_str::<AnthropicStreamMessageDelta>(&data)
                            {
                                if let Some(usage) = msg.usage {
                                    if let Ok(mut state) = usage_clone.lock() {
                                        state.1 = Some(usage.output_tokens as u32);
                                    }
                                }
                                if let Some(stop_reason) =
                                    msg.delta.and_then(|delta| delta.stop_reason)
                                {
                                    if let Ok(mut state) = finish_reason_clone.lock() {
                                        *state = Some(stop_reason);
                                    }
                                }
                            }
                            Ok(StreamChunk {
                                delta: String::new(),
                                reasoning: None,
                                done: false,
                                finish_reason: None,
                                input_tokens: None,
                                output_tokens: None,
                            })
                        }
                        "message_stop" => {
                            // 流结束，将累积的 usage 数据填入最终 chunk
                            let (input_tokens, output_tokens) = usage_clone
                                .lock()
                                .map(|s| (s.0, s.1))
                                .unwrap_or((None, None));
                            let finish_reason = finish_reason_clone
                                .lock()
                                .ok()
                                .and_then(|state| state.as_ref().cloned())
                                .unwrap_or_else(|| "end_turn".to_string());
                            Ok(StreamChunk {
                                delta: String::new(),
                                reasoning: None,
                                done: true,
                                finish_reason: Some(finish_reason),
                                input_tokens,
                                output_tokens,
                            })
                        }
                        "content_block_delta" => {
                            let delta: AnthropicStreamDelta =
                                serde_json::from_str(&data).map_err(|e| {
                                    AppError::LlmApi(format!(
                                        "Failed to parse streaming response: {}",
                                        e
                                    ))
                                })?;

                            let (text, reasoning) = match delta.delta {
                                Some(delta) if delta.delta_type == "thinking_delta" => (
                                    String::new(),
                                    delta.thinking.filter(|thinking| !thinking.is_empty()),
                                ),
                                Some(delta) => (delta.text.unwrap_or_default(), None),
                                None => (String::new(), None),
                            };

                            Ok(StreamChunk {
                                delta: text,
                                reasoning,
                                done: false,
                                finish_reason: None,
                                input_tokens: None,
                                output_tokens: None,
                            })
                        }
                        _ => Ok(StreamChunk {
                            delta: String::new(),
                            reasoning: None,
                            done: false,
                            finish_reason: None,
                            input_tokens: None,
                            output_tokens: None,
                        }),
                    }
                }
                Err(e) => Err(AppError::LlmApi(format!("Streaming error: {}", e))),
            }
        });

        Ok(Box::pin(mapped_stream))
    }

    async fn test_connection(&self) -> AppResult<bool> {
        let request = ChatRequest {
            messages: vec![ChatMessage::user("Hi")],
            max_tokens: Some(5),
            stream: false,
            ..Default::default()
        };

        match self.chat(request).await {
            Ok(_) => Ok(true),
            Err(AppError::LlmApi(msg)) if msg.contains("401") || msg.contains("invalid") => {
                Ok(false)
            }
            Err(e) => Err(e),
        }
    }
}

// ==================== Anthropic API 类型定义 ====================

#[derive(Debug, Serialize)]
struct AnthropicRequest {
    model: String,
    messages: Vec<AnthropicMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<AnthropicThinkingConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_config: Option<AnthropicOutputConfig>,
    stream: bool,
}

#[derive(Debug, Serialize)]
struct AnthropicThinkingConfig {
    #[serde(rename = "type")]
    thinking_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    display: Option<String>,
}

#[derive(Debug, Serialize)]
struct AnthropicOutputConfig {
    effort: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct AnthropicMessage {
    role: String,
    content: AnthropicMessageContent,
}

/// Anthropic 消息内容类型（支持纯文本和多模态数组）
#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
enum AnthropicMessageContent {
    /// 纯文本内容
    Text(String),
    /// 多模态内容数组
    Parts(Vec<AnthropicContentPart>),
}

/// Anthropic 多模态内容部分
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AnthropicContentPart {
    /// 文本内容
    #[serde(rename = "text")]
    Text { text: String },
    /// 图片内容
    #[serde(rename = "image")]
    Image { source: AnthropicImageSource },
}

/// Anthropic 图片数据源
#[derive(Debug, Serialize, Deserialize)]
struct AnthropicImageSource {
    /// 来源类型：固定为 "base64"
    #[serde(rename = "type")]
    source_type: String,
    /// MIME 类型，如 "image/jpeg", "image/png"
    media_type: String,
    /// Base64 编码的图片数据
    data: String,
}

#[derive(Debug, Deserialize)]
struct AnthropicResponse {
    model: String,
    content: Vec<AnthropicContentBlock>,
    stop_reason: Option<String>,
    usage: AnthropicUsage,
}

#[derive(Debug, Deserialize)]
struct AnthropicContentBlock {
    #[serde(rename = "type")]
    content_type: String,
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AnthropicUsage {
    input_tokens: u32,
    output_tokens: u32,
}

#[derive(Debug, Deserialize)]
struct AnthropicStreamDelta {
    delta: Option<AnthropicStreamDeltaPayload>,
}

// ==================== Function Calling 响应类型 ====================

/// Anthropic Tools API 响应的 content block（支持 text 和 tool_use）
#[derive(Debug, Deserialize)]
struct AnthropicToolContentBlock {
    /// block 类型: "text" | "tool_use"
    #[serde(rename = "type")]
    content_type: String,
    /// 文本内容（text block）
    text: Option<String>,
    /// 工具调用 ID（tool_use block，必须传回 tool_result 匹配）
    id: Option<String>,
    /// 工具名称（tool_use block）
    name: Option<String>,
    /// 工具参数（tool_use block）
    input: Option<serde_json::Value>,
}

/// Anthropic Tools API 响应
#[derive(Debug, Deserialize)]
struct AnthropicToolResponse {
    #[allow(dead_code)]
    model: String,
    content: Vec<AnthropicToolContentBlock>,
    stop_reason: Option<String>,
}

// ==================== 流式 Function Calling 类型 ====================

/// content block 累积状态
/// 在流式消费过程中按 index 存储每个 content block 的类型和累积数据
#[derive(Default)]
struct ContentBlockState {
    /// block 类型: "text" | "tool_use"
    block_type: String,
    /// tool_use block 的 ID（后续 tool_result 匹配需要）
    id: Option<String>,
    /// tool_use block 的工具名称
    name: Option<String>,
    /// text block 的文本累积 buffer
    text_buffer: String,
    /// tool_use block 的 input JSON 累积 buffer（partial_json 增量拼接）
    json_buffer: String,
    /// 上一次已上报的 input JSON 字节数
    last_progress_bytes: usize,
}

impl ContentBlockState {
    fn emit_progress_if_needed(&mut self, index: usize, callback: &ToolCallProgressCallback) {
        let Some(name) = self.name.as_ref() else {
            return;
        };
        if name != "file_write" {
            return;
        }

        let arg_bytes = self.json_buffer.len();
        if arg_bytes < TOOL_CALL_PROGRESS_MIN_BYTES {
            return;
        }
        if self.last_progress_bytes > 0
            && arg_bytes.saturating_sub(self.last_progress_bytes) < TOOL_CALL_PROGRESS_STEP_BYTES
        {
            return;
        }

        self.last_progress_bytes = arg_bytes;
        callback(ToolCallStreamProgress {
            index,
            tool_name: name.clone(),
            arg_bytes,
        });
    }
}

/// content_block_start 事件的数据结构
#[derive(Debug, Deserialize)]
struct AnthropicStreamBlockStart {
    index: usize,
    content_block: AnthropicStreamBlockInfo,
}

/// content_block_start 中的 content_block 详情
#[derive(Debug, Deserialize)]
struct AnthropicStreamBlockInfo {
    /// block 类型: "text" | "tool_use"
    #[serde(rename = "type")]
    block_type: String,
    /// tool_use block 的 ID
    #[serde(default)]
    id: Option<String>,
    /// tool_use block 的工具名称
    #[serde(default)]
    name: Option<String>,
}

/// content_block_delta 事件的数据结构
#[derive(Debug, Deserialize)]
struct AnthropicStreamBlockDelta {
    index: usize,
    delta: AnthropicStreamDeltaPayload,
}

/// content_block_delta 中的 delta 详情
#[derive(Debug, Deserialize)]
struct AnthropicStreamDeltaPayload {
    /// delta 类型: "text_delta" | "input_json_delta"
    #[serde(rename = "type")]
    delta_type: String,
    /// text_delta 时的文本增量
    #[serde(default)]
    text: Option<String>,
    /// input_json_delta 时的 JSON 增量片段
    #[serde(default)]
    partial_json: Option<String>,
    /// thinking_delta reasoning content.
    #[serde(default)]
    thinking: Option<String>,
}

// ==================== SSE Usage 事件类型 ====================

/// message_start 事件数据（包含 input_tokens）
#[derive(Debug, Deserialize)]
struct AnthropicStreamMessageStart {
    message: AnthropicStreamMessageInfo,
}

/// message_start 中的 message 详情
#[derive(Debug, Deserialize)]
struct AnthropicStreamMessageInfo {
    /// usage 信息（包含 input_tokens）
    usage: Option<AnthropicStreamUsage>,
}

/// message_delta 事件数据（包含 output_tokens 与真实结束原因）
#[derive(Debug, Deserialize)]
struct AnthropicStreamMessageDelta {
    /// 结束原因位于 delta.stop_reason；message_stop 事件本身不携带该值。
    delta: Option<AnthropicStreamMessageDeltaPayload>,
    /// usage 信息（包含 output_tokens）
    usage: Option<AnthropicStreamUsage>,
}

#[derive(Debug, Deserialize)]
struct AnthropicStreamMessageDeltaPayload {
    stop_reason: Option<String>,
}

/// SSE 事件中的 usage 数据
#[derive(Debug, Deserialize)]
struct AnthropicStreamUsage {
    #[serde(default)]
    input_tokens: u32,
    #[serde(default)]
    output_tokens: u32,
}
