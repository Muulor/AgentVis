//! Google Gemini API 适配器
//!
//! 实现 Gemini generateContent API 的调用

use super::http_client::{
    get_client, get_streaming_client, stream_idle_timeout, stream_start_timeout,
};
use async_trait::async_trait;
use futures::stream::Stream;
use serde::{Deserialize, Serialize};
use std::pin::Pin;

use super::types::{
    ChatMessage, ChatRequest, ChatResponse, ChatRole, ProviderConfig, ReasoningTraceCallback,
    ReasoningTraceProgress, StreamChunk, ToolCallProgressCallback, ToolCallStreamProgress,
    TOOL_CALL_PROGRESS_MIN_BYTES,
};
use super::LlmProvider;
use crate::error::{AppError, AppResult};
use crate::text_utils::safe_truncate;

/// Gemini API 基础 URL
const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com";
/// 默认模型
const DEFAULT_MODEL: &str = "gemini-2.5-flash";

/// Gemini 适配器
///
/// 使用全局共享 HTTP Client，复用连接池
pub struct GeminiAdapter {
    config: ProviderConfig,
}

impl GeminiAdapter {
    /// 创建新的 Gemini 适配器
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

    fn model_supports_thought_summaries(model: &str) -> bool {
        let model = model.to_ascii_lowercase();
        model.contains("gemini-2.5") || model.contains("gemini-3")
    }

    fn request_wants_image_output(response_modalities: &Option<Vec<String>>) -> bool {
        response_modalities
            .as_ref()
            .map(|modalities| {
                modalities
                    .iter()
                    .any(|modality| modality.eq_ignore_ascii_case("image"))
            })
            .unwrap_or(false)
    }

    fn thinking_config_for_model(
        model: &str,
        response_modalities: &Option<Vec<String>>,
    ) -> Option<GeminiThinkingConfig> {
        if Self::model_supports_thought_summaries(model)
            && !Self::request_wants_image_output(response_modalities)
        {
            Some(GeminiThinkingConfig {
                include_thoughts: Some(true),
            })
        } else {
            None
        }
    }

    /// 构建Request body
    fn build_request_body(&self, request: &ChatRequest) -> GeminiRequest {
        let model = self.get_model(request.model.as_deref());
        let mut contents: Vec<GeminiContent> = Vec::new();
        let mut system_text: Option<String> = None;

        for msg in &request.messages {
            match msg.role {
                ChatRole::System => {
                    // 暂存 system 消息，后续合并到第一条用户消息（兼容更多代理）
                    system_text = Some(msg.content.clone());
                }
                ChatRole::User => {
                    // 构建 parts 列表
                    let mut parts: Vec<GeminiPart> = Vec::new();

                    // 如果有 system 消息，合并到第一条用户消息前面
                    let text_content = if let Some(sys) = system_text.take() {
                        format!(
                            "[System Instructions]\n{}\n\n[User Message]\n{}",
                            sys, msg.content
                        )
                    } else {
                        msg.content.clone()
                    };

                    // 添加文本 part
                    parts.push(GeminiPart {
                        text: text_content,
                        thought: None,
                        thought_signature: None,
                        inline_data: None,
                        function_call: None,
                        function_response: None,
                    });

                    // 如果有图片附件，添加图片 parts
                    if let Some(ref images) = msg.images {
                        for image in images {
                            parts.push(GeminiPart {
                                text: String::new(),
                                thought: None,
                                thought_signature: None,
                                inline_data: Some(GeminiInlineData {
                                    mime_type: image.mime_type.clone(),
                                    data: image.data.clone(),
                                }),
                                function_call: None,
                                function_response: None,
                            });
                        }
                        log::trace!("[GeminiAdapter] 📷 添加 {} 张图片到请求", images.len());
                    }

                    contents.push(GeminiContent {
                        role: Some("user".to_string()),
                        parts,
                    });
                }
                ChatRole::Assistant => {
                    contents.push(GeminiContent {
                        role: Some("model".to_string()),
                        parts: vec![GeminiPart {
                            text: msg.content.clone(),
                            thought: None,
                            thought_signature: None,
                            inline_data: None,
                            function_call: None,
                            function_response: None,
                        }],
                    });
                }
            }
        }

        // 设置基础生成配置
        let generation_config = GeminiGenerationConfig {
            temperature: request.temperature,
            max_output_tokens: request.max_tokens,
            // 图像生成模型需要指定响应模态（如 ["Image"] 或 ["Text", "Image"]）
            response_modalities: request.response_modalities.clone(),
            // 图像配置（宽高比、分辨率等）嵌套在 generationConfig 内部
            image_config: request.image_config.as_ref().map(|cfg| GeminiImageConfig {
                aspect_ratio: cfg.aspect_ratio.clone(),
                image_size: cfg.image_size.clone(),
            }),
            thinking_config: Self::thinking_config_for_model(&model, &request.response_modalities),
        };

        GeminiRequest {
            contents,
            system_instruction: None,
            generation_config: Some(generation_config),
            tools: None,
        }
    }

    /// 构建 Function Calling Request body（chat_with_tools 和 chat_stream_with_tools 共用）
    ///
    /// 将 ToolChatMessage 转换为 Gemini 格式消息，构建工具定义和函数名映射表。
    /// 返回 (Request body, 模型名, 函数名映射表, Request body大小 KB)
    fn build_tool_request_body(
        &self,
        request: &super::types::ToolChatRequest,
    ) -> (
        GeminiRequest,
        String,
        std::collections::HashMap<String, String>,
        usize,
    ) {
        use super::types::ToolChatRole;

        let model = self.get_model(request.model_id.as_deref());

        // 判断是否为 Gemini 3+ 模型（原生 multimodal functionResponse 支持）
        let is_gemini_3_plus = model.contains("gemini-3") || model.contains("gemini-3.");

        let mut contents: Vec<GeminiContent> = Vec::new();
        let mut system_text: Option<String> = None;

        for msg in &request.messages {
            match msg.role {
                ToolChatRole::System => {
                    system_text = Some(msg.content.clone());
                }
                ToolChatRole::User => {
                    let text_content = if let Some(sys) = system_text.take() {
                        format!(
                            "[System Instructions]\n{}\n\n[User Message]\n{}",
                            sys, msg.content
                        )
                    } else {
                        msg.content.clone()
                    };

                    let mut parts = vec![GeminiPart {
                        text: text_content,
                        thought: None,
                        thought_signature: None,
                        inline_data: None,
                        function_call: None,
                        function_response: None,
                    }];

                    if let Some(ref images) = msg.images {
                        for image in images {
                            parts.push(GeminiPart {
                                text: String::new(),
                                thought: None,
                                thought_signature: None,
                                inline_data: Some(GeminiInlineData {
                                    mime_type: image.mime_type.clone(),
                                    data: image.data.clone(),
                                }),
                                function_call: None,
                                function_response: None,
                            });
                        }
                        log::trace!(
                            "[GeminiAdapter] 📷 chat_with_tools: 添加 {} 张图片",
                            images.len()
                        );
                    }

                    contents.push(GeminiContent {
                        role: Some("user".to_string()),
                        parts,
                    });
                }
                ToolChatRole::Assistant => {
                    if let Some(ref tool_calls) = msg.tool_calls {
                        let parts: Vec<GeminiPart> = tool_calls
                            .iter()
                            .map(|tc| GeminiPart {
                                text: String::new(),
                                thought: None,
                                thought_signature: tc.thought_signature.clone(),
                                inline_data: None,
                                function_call: Some(GeminiFunctionCall {
                                    id: tc.id.clone(),
                                    name: tc.name.clone(),
                                    args: tc.args.clone(),
                                }),
                                function_response: None,
                            })
                            .collect();
                        contents.push(GeminiContent {
                            role: Some("model".to_string()),
                            parts,
                        });
                    } else {
                        // 防御空 content：Gemini API 要求 Part 至少有一个 data 字段被初始化
                        // 空 text + 所有 Option 为 None 时，skip_serializing_if 会跳过所有字段，
                        // 产生空 Part 对象，触发 API 400 错误（"required oneof field 'data'"）
                        let text = if msg.content.is_empty() {
                            "[continue]".to_string()
                        } else {
                            msg.content.clone()
                        };
                        contents.push(GeminiContent {
                            role: Some("model".to_string()),
                            parts: vec![GeminiPart {
                                text,
                                thought: None,
                                thought_signature: None,
                                inline_data: None,
                                function_call: None,
                                function_response: None,
                            }],
                        });
                    }
                }
                ToolChatRole::Tool => {
                    let tool_name = msg
                        .tool_name
                        .clone()
                        .or_else(|| {
                            msg.tool_call_id
                                .as_ref()
                                .and_then(|id| id.split('_').next())
                                .map(|name| name.to_string())
                        })
                        .unwrap_or_else(|| "unknown".to_string());

                    let image_attachments = msg.images.as_deref().filter(|imgs| !imgs.is_empty());
                    log::trace!("[GeminiAdapter] 🔧 Tool msg | name: {} | content_len: {} | images: {:?} | gemini3+: {}",
                        tool_name, msg.content.len(),
                        msg.images.as_ref().map(|imgs| imgs.len()),
                        is_gemini_3_plus);

                    if let Some(images) = image_attachments {
                        if is_gemini_3_plus {
                            let mut fn_response_parts: Vec<GeminiFunctionResponsePart> = Vec::new();
                            let mut image_refs = serde_json::Map::new();

                            for (i, img) in images.iter().enumerate() {
                                let display_name = format!(
                                    "tool_image_{}.{}",
                                    i,
                                    img.mime_type.split('/').last().unwrap_or("png")
                                );
                                fn_response_parts.push(GeminiFunctionResponsePart {
                                    inline_data: Some(GeminiFunctionResponseBlob {
                                        mime_type: img.mime_type.clone(),
                                        display_name: display_name.clone(),
                                        data: img.data.clone(),
                                    }),
                                });
                                image_refs.insert(
                                    format!("image_{}", i),
                                    serde_json::json!({ "$ref": display_name }),
                                );
                            }

                            image_refs.insert(
                                "result".to_string(),
                                serde_json::Value::String(msg.content.clone()),
                            );

                            let parts = vec![GeminiPart {
                                text: String::new(),
                                thought: None,
                                thought_signature: None,
                                inline_data: None,
                                function_call: None,
                                function_response: Some(GeminiFunctionResponse {
                                    id: msg.tool_call_id.clone(),
                                    name: tool_name,
                                    response: serde_json::Value::Object(image_refs),
                                    parts: Some(fn_response_parts),
                                }),
                            }];

                            log::trace!("[GeminiAdapter] 📷 Gemini 3+ 原生: functionResponse.parts 内嵌 {} 张图片",
                                images.len());

                            contents.push(GeminiContent {
                                role: Some("user".to_string()),
                                parts,
                            });
                        } else {
                            let mut parts = vec![GeminiPart {
                                text: String::new(),
                                thought: None,
                                thought_signature: None,
                                inline_data: None,
                                function_call: None,
                                function_response: Some(GeminiFunctionResponse {
                                    id: msg.tool_call_id.clone(),
                                    name: tool_name,
                                    response: serde_json::json!({ "result": msg.content }),
                                    parts: None,
                                }),
                            }];

                            for img in images {
                                parts.push(GeminiPart {
                                    text: String::new(),
                                    thought: None,
                                    thought_signature: None,
                                    inline_data: Some(GeminiInlineData {
                                        mime_type: img.mime_type.clone(),
                                        data: img.data.clone(),
                                    }),
                                    function_call: None,
                                    function_response: None,
                                });
                            }
                            parts.push(GeminiPart {
                                text: "The image above is file content read by a tool. Analyze it directly and describe what is in the image.".to_string(),
                                thought: None,
                                thought_signature: None,
                                inline_data: None,
                                function_call: None,
                                function_response: None,
                            });
                            log::trace!(
                                "[GeminiAdapter] 📷 Gemini 2.x 降级: {} 张 inlineData parts (平级)",
                                images.len()
                            );

                            contents.push(GeminiContent {
                                role: Some("user".to_string()),
                                parts,
                            });
                        }
                    } else {
                        let parts = vec![GeminiPart {
                            text: String::new(),
                            thought: None,
                            thought_signature: None,
                            inline_data: None,
                            function_call: None,
                            function_response: Some(GeminiFunctionResponse {
                                id: msg.tool_call_id.clone(),
                                name: tool_name,
                                response: serde_json::json!({ "result": msg.content }),
                                parts: None,
                            }),
                        }];

                        contents.push(GeminiContent {
                            role: Some("user".to_string()),
                            parts,
                        });
                    }
                }
            }
        }

        // 构建工具定义（函数名保护 + Schema 规范化）
        let mut name_mapping: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        let tools = request.tools.as_ref().and_then(|tool_defs| {
            if tool_defs.is_empty() {
                return None;
            }
            Some(vec![GeminiTool {
                function_declarations: tool_defs
                    .iter()
                    .map(|t| {
                        let normalized_params = normalize_schema_types(&t.parameters);
                        let safe_name = sanitize_function_name(&t.name);
                        if safe_name != t.name {
                            name_mapping.insert(safe_name.clone(), t.name.clone());
                        }
                        GeminiFunctionDeclaration {
                            name: safe_name,
                            description: t.description.clone(),
                            parameters: normalized_params,
                        }
                    })
                    .collect(),
            }])
        });

        let generation_config = GeminiGenerationConfig {
            temperature: request.temperature,
            max_output_tokens: request.max_tokens,
            response_modalities: None, // Function Calling 不需要图像输出模态
            image_config: None,        // Function Calling 不需要图像配置
            thinking_config: Self::thinking_config_for_model(&model, &None),
        };

        let gemini_request = GeminiRequest {
            contents,
            system_instruction: None,
            generation_config: Some(generation_config),
            tools,
        };

        // 诊断日志：记录Request body大小
        let body_size_kb = serde_json::to_string(&gemini_request)
            .map(|s| s.len() / 1024)
            .unwrap_or(0);
        log::trace!("[GeminiAdapter] 📊 Request body大小: {} KB", body_size_kb);

        (gemini_request, model, name_mapping, body_size_kb)
    }

    /// 构建 Gemini API URL（区分自定义 base_url 和默认 API）
    fn build_url(&self, model: &str, is_stream: bool) -> String {
        let action = if is_stream {
            "streamGenerateContent?alt=sse"
        } else {
            "generateContent"
        };

        if let Some(ref base) = self.config.base_url {
            let clean_base = base
                .trim_end_matches("/v1beta")
                .trim_end_matches("/v1")
                .trim_end_matches('/');
            format!("{}/v1beta/models/{}:{}", clean_base, model, action)
        } else {
            format!("{}/v1beta/models/{}:{}", self.base_url(), model, action)
        }
    }

    /// 从响应 parts 中提取 text 和 functionCall，应用函数名反向映射
    fn extract_tool_response_from_parts(
        parts: &[GeminiPart],
        name_mapping: &std::collections::HashMap<String, String>,
        finish_reason: Option<String>,
    ) -> super::types::ToolChatResponse {
        use super::types::{ToolCall as TypesToolCall, ToolChatResponse};

        let function_calls: Vec<TypesToolCall> = parts
            .iter()
            .filter_map(|p| {
                p.function_call.as_ref().map(|fc| {
                    let original_name = name_mapping
                        .get(&fc.name)
                        .cloned()
                        .unwrap_or_else(|| fc.name.clone());
                    TypesToolCall {
                        name: original_name,
                        args: fc.args.clone(),
                        id: fc.id.clone(),
                        thought_signature: p.thought_signature.clone(),
                    }
                })
            })
            .collect();

        if !function_calls.is_empty() {
            let text_content: String = parts
                .iter()
                .filter(|p| {
                    !p.text.is_empty() && p.function_call.is_none() && p.thought != Some(true)
                })
                .map(|p| p.text.clone())
                .collect::<Vec<_>>()
                .join("");
            let content = if text_content.is_empty() {
                None
            } else {
                Some(text_content)
            };

            return ToolChatResponse {
                response_type: "tool_use".to_string(),
                content,
                tool_calls: Some(function_calls),
                error: None,
                finish_reason,
                input_tokens: None,
                output_tokens: None,
                reasoning_content: None,
            };
        }

        let text_content: String = parts
            .iter()
            .filter(|p| !p.text.is_empty() && p.thought != Some(true))
            .map(|p| p.text.clone())
            .collect::<Vec<_>>()
            .join("");

        ToolChatResponse {
            response_type: "text".to_string(),
            content: Some(text_content),
            tool_calls: None,
            error: None,
            finish_reason,
            input_tokens: None,
            output_tokens: None,
            reasoning_content: None,
        }
    }

    fn emit_tool_call_progress_for_parts(
        parts: &[GeminiPart],
        base_index: usize,
        name_mapping: &std::collections::HashMap<String, String>,
        progress_callback: Option<&ToolCallProgressCallback>,
    ) {
        let Some(callback) = progress_callback else {
            return;
        };

        for (offset, part) in parts.iter().enumerate() {
            let Some(function_call) = part.function_call.as_ref() else {
                continue;
            };
            let original_name = name_mapping
                .get(&function_call.name)
                .cloned()
                .unwrap_or_else(|| function_call.name.clone());
            if original_name != "file_write" {
                continue;
            }

            let arg_bytes = serde_json::to_string(&function_call.args)
                .map(|args| args.len())
                .unwrap_or(0);
            if arg_bytes < TOOL_CALL_PROGRESS_MIN_BYTES {
                continue;
            }

            callback(ToolCallStreamProgress {
                index: base_index + offset,
                tool_name: original_name,
                arg_bytes,
            });
        }
    }

    /// 带工具的聊天请求（非流式）
    pub async fn chat_with_tools(
        &self,
        request: super::types::ToolChatRequest,
    ) -> AppResult<super::types::ToolChatResponse> {
        use super::types::ToolChatResponse;

        let (body, model, name_mapping, body_size_kb) = self.build_tool_request_body(&request);
        let url = self.build_url(&model, false);

        log::trace!(
            "[GeminiAdapter] 🔧 chat_with_tools | URL: {} | body: {} KB",
            url,
            body_size_kb
        );
        if let Some(first_tool) = body.tools.as_ref().and_then(|tools| tools.first()) {
            log::trace!(
                "[GeminiAdapter] 🔧 包含 {} 个工具定义",
                first_tool.function_declarations.len()
            );
        }

        let response = get_client()
            .post(&url)
            .header("Content-Type", "application/json")
            .header("x-goog-api-key", &self.config.api_key)
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
            return Ok(ToolChatResponse {
                response_type: "error".to_string(),
                content: None,
                tool_calls: None,
                error: Some(format!(
                    "API returned an error ({}): {}",
                    status, error_text
                )),
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

        let api_response: GeminiResponse = serde_json::from_str(&response_text).map_err(|e| {
            let preview = safe_truncate(&response_text, 500);
            AppError::LlmApi(format!(
                "Failed to parse response: {} | Raw response: {}",
                e, preview
            ))
        })?;

        if let Some(candidate) = api_response.candidates.first() {
            if let Some(reason) = &candidate.finish_reason {
                log::trace!("[GeminiAdapter] ✅ 完成原因: {}", reason);
                if reason == "MAX_TOKENS" {
                    log::warn!("[GeminiAdapter] 响应被截断，请增加 max_tokens 配置");
                }
            }
            return Ok(Self::extract_tool_response_from_parts(
                &candidate.content.parts,
                &name_mapping,
                candidate.finish_reason.clone(),
            ));
        }

        Ok(ToolChatResponse {
            response_type: "text".to_string(),
            content: Some(String::new()),
            tool_calls: None,
            error: None,
            finish_reason: None,
            input_tokens: None,
            output_tokens: None,
            reasoning_content: None,
        })
    }

    /// 流式 Function Calling 请求（内部消费 SSE，外部返回完整响应）
    ///
    /// 行为与 chat_with_tools() 完全一致，但使用 streamGenerateContent?alt=sse
    /// 流式接收，避免长时间 idle 导致链路timeout。返回类型不变，调用方无感知。
    ///
    /// 与 OpenAI/Anthropic 不同，Gemini 的 functionCall 在单个 chunk 中完整返回，
    /// 无需逐片段拼接 arguments——直接收集即可。
    pub async fn chat_stream_with_tools(
        &self,
        request: super::types::ToolChatRequest,
        progress_callback: Option<super::types::ToolCallProgressCallback>,
        reasoning_callback: Option<ReasoningTraceCallback>,
    ) -> AppResult<super::types::ToolChatResponse> {
        use super::types::ToolChatResponse;
        use eventsource_stream::Eventsource;
        use futures::StreamExt;

        let (body, model, name_mapping, body_size_kb) = self.build_tool_request_body(&request);
        let url = self.build_url(&model, true);

        log::trace!(
            "[GeminiAdapter] 🔧 chat_stream_with_tools | URL: {} | body: {} KB",
            url,
            body_size_kb
        );

        let start_timeout = stream_start_timeout();
        let response = tokio::time::timeout(
            start_timeout,
            get_streaming_client()
                .post(&url)
                .header("Content-Type", "application/json")
                .header("x-goog-api-key", &self.config.api_key)
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
            log::warn!("[GeminiAdapter] chat_stream_with_tools 错误: {}", error_msg);
            return Ok(ToolChatResponse {
                response_type: "error".to_string(),
                content: None,
                tool_calls: None,
                error: Some(error_msg),
                finish_reason: None,
                input_tokens: None,
                output_tokens: None,
                reasoning_content: None,
            });
        }

        // SSE 事件流消费循环
        let mut stream = response.bytes_stream().eventsource();

        // 累积状态：Gemini 的 functionCall 不分片，直接收集完整的 GeminiPart
        let mut all_parts: Vec<GeminiPart> = Vec::new();
        let mut reasoning_seen = false;
        let mut chunk_count: u64 = 0;
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
                    return Err(AppError::LlmApi(format!(
                        "Streaming response idle timeout (no data for {} seconds)",
                        idle_timeout.as_secs()
                    )));
                }
            };

            match event {
                Ok(ev) => {
                    let data = ev.data;

                    // 每个 SSE chunk 是一个完整 GeminiStreamChunk
                    match serde_json::from_str::<GeminiStreamChunk>(&data) {
                        Ok(chunk) => {
                            if let Some(candidate) = chunk.candidates.first() {
                                if let Some(reason) = candidate.finish_reason.as_ref() {
                                    final_finish_reason = Some(reason.clone());
                                }
                                if let Some(content) = candidate.content.as_ref() {
                                    let parts = content.parts.clone();
                                    for part in &parts {
                                        if part.thought == Some(true) && !part.text.is_empty() {
                                            reasoning_seen = true;
                                            if let Some(callback) = reasoning_callback.as_ref() {
                                                callback(ReasoningTraceProgress {
                                                    delta: part.text.clone(),
                                                    done: false,
                                                });
                                            }
                                        }
                                    }
                                    Self::emit_tool_call_progress_for_parts(
                                        &parts,
                                        all_parts.len(),
                                        &name_mapping,
                                        progress_callback.as_ref(),
                                    );
                                    all_parts.extend(parts);
                                }
                            }
                            // 提取 usage 数据
                            if let Some(ref usage) = chunk.usage_metadata {
                                if let Some(v) = usage.prompt_token_count {
                                    final_input_tokens = Some(v as u32);
                                }
                                if let Some(v) = usage.candidates_token_count {
                                    final_output_tokens = Some(v as u32);
                                }
                            }
                        }
                        Err(e) => {
                            log::warn!("[GeminiAdapter] 解析流式 chunk 失败: {}", e);
                        }
                    }
                    chunk_count += 1;
                }
                Err(e) => {
                    return Err(AppError::LlmApi(format!(
                        "Streaming error (received {} chunks): {}",
                        chunk_count, e
                    )));
                }
            }
        }

        log::trace!(
            "[GeminiAdapter] 📊 流式接收完成: {} chunks, {} parts",
            chunk_count,
            all_parts.len()
        );

        // 组装响应：复用 extract_tool_response_from_parts
        if reasoning_seen {
            if let Some(callback) = reasoning_callback.as_ref() {
                callback(ReasoningTraceProgress {
                    delta: String::new(),
                    done: true,
                });
            }
        }

        let mut result =
            Self::extract_tool_response_from_parts(&all_parts, &name_mapping, final_finish_reason);
        // 注入 token 用量
        result.input_tokens = final_input_tokens;
        result.output_tokens = final_output_tokens;

        log::trace!(
            "[GeminiAdapter] 📊 流式结果: type={}, content={} 字符, tool_calls={}",
            result.response_type,
            result.content.as_ref().map_or(0, |c| c.len()),
            result.tool_calls.as_ref().map_or(0, |tc| tc.len())
        );

        Ok(result)
    }
}

#[async_trait]
impl LlmProvider for GeminiAdapter {
    async fn chat(&self, request: ChatRequest) -> AppResult<ChatResponse> {
        let model = self.get_model(request.model.as_deref());
        // 复用 build_url 统一 URL 构建逻辑
        let url = self.build_url(&model, false);
        let body = self.build_request_body(&request);

        // 调试日志：输出实际发送的 max_output_tokens
        if let Some(ref gen_config) = body.generation_config {
            log::trace!(
                "[GeminiAdapter]  max_output_tokens: {:?}",
                gen_config.max_output_tokens
            );
        }
        log::trace!("[GeminiAdapter]  请求 URL: {}", url);

        let response = get_client()
            .post(&url)
            .header("Content-Type", "application/json")
            // 使用 x-goog-api-key Header 传递 API Key，兼容更多代理
            .header("x-goog-api-key", &self.config.api_key)
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

        let api_response: GeminiResponse = response
            .json()
            .await
            .map_err(|e| AppError::LlmApi(format!("Failed to parse response: {}", e)))?;

        // 提取文本内容
        let content = api_response
            .candidates
            .first()
            .map(|c| {
                c.content
                    .parts
                    .iter()
                    .filter(|p| p.thought != Some(true))
                    .map(|p| p.text.as_str())
                    .collect::<String>()
            })
            .unwrap_or_default();

        let finish_reason = api_response
            .candidates
            .first()
            .and_then(|c| c.finish_reason.clone());

        let (input_tokens, output_tokens) = api_response
            .usage_metadata
            .map(|u| (u.prompt_token_count, u.candidates_token_count))
            .unwrap_or((None, None));

        // 调试日志：输出响应信息以诊断截断问题
        log::trace!("[GeminiAdapter]  响应内容长度: {} 字符", content.len());
        log::trace!("[GeminiAdapter]  output_tokens: {:?}", output_tokens);
        log::trace!("[GeminiAdapter]  finish_reason: {:?}", finish_reason);

        Ok(ChatResponse {
            content,
            model,
            input_tokens,
            output_tokens,
            finish_reason,
        })
    }

    async fn chat_stream(
        &self,
        request: ChatRequest,
    ) -> AppResult<Pin<Box<dyn Stream<Item = AppResult<StreamChunk>> + Send>>> {
        use futures::StreamExt;

        let model = self.get_model(request.model.as_deref());
        // 复用 build_url 统一 URL 构建逻辑
        let url = self.build_url(&model, true);
        let body = self.build_request_body(&request);

        let start_timeout = stream_start_timeout();
        let response = tokio::time::timeout(
            start_timeout,
            get_streaming_client()
                .post(&url)
                .header("Content-Type", "application/json")
                // 使用 x-goog-api-key Header 传递 API Key，兼容更多代理
                .header("x-goog-api-key", &self.config.api_key)
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

        use eventsource_stream::Eventsource;
        let stream = response.bytes_stream().eventsource();

        let mapped_stream = stream.map(|event| {
            match event {
                Ok(ev) => {
                    let data = ev.data;

                    // 解析 JSON
                    let chunk: GeminiStreamChunk = serde_json::from_str(&data)
                        .map_err(|e| AppError::LlmApi(format!("Failed to parse streaming response: {}", e)))?;

                    // 分离思考内容和正文内容
                    // Gemini 3 思考模型返回 parts 数组，其中 thought: true 的是思考过程
                    let mut text_content = String::new();
                    let mut reasoning_content: Option<String> = None;

                    if let Some(candidate) = chunk.candidates.first() {
                        if let Some(content) = candidate.content.as_ref() {
                            for part in &content.parts {
                                if part.thought == Some(true) {
                                    // 这是思考过程
                                    if let Some(ref mut r) = reasoning_content {
                                        r.push_str(&part.text);
                                    } else {
                                        reasoning_content = Some(part.text.clone());
                                    }
                                } else if let Some(ref inline) = part.inline_data {
                                    // 图像生成模型返回的 inlineData（图片数据）
                                    // 转换为 markdown 格式，与前端 MarkdownRenderer 的处理管线衔接
                                    let md_image = format!(
                                        "![Generated Image](data:{};base64,{})",
                                        inline.mime_type, inline.data
                                    );
                                    text_content.push_str(&md_image);
                                    log::trace!("[GeminiAdapter] 收到 inlineData 图片: mime={}, data_len={}",
                                        inline.mime_type, inline.data.len());
                                } else if !part.text.is_empty() {
                                    // 这是正文内容
                                    text_content.push_str(&part.text);
                                }
                            }
                        }
                    }

                    let finish_reason = chunk
                        .candidates
                        .first()
                        .and_then(|c| c.finish_reason.clone());

                    let done = finish_reason.is_some();

                    // 从 usageMetadata 提取 token 用量（Gemini 在每个 chunk 都可能返回，但最终 chunk 最准确）
                    let (input_tokens, output_tokens) = match &chunk.usage_metadata {
                        Some(usage) => (
                            usage.prompt_token_count.map(|v| v as u32),
                            usage.candidates_token_count.map(|v| v as u32),
                        ),
                        None => (None, None),
                    };

                    Ok(StreamChunk {
                        delta: text_content,
                        reasoning: reasoning_content,  // Gemini 3 思考模型的思考过程
                        done,
                        finish_reason,
                        input_tokens,
                        output_tokens,
                    })
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
            Err(AppError::LlmApi(msg)) if msg.contains("400") || msg.contains("API_KEY") => {
                Ok(false)
            }
            Err(e) => Err(e),
        }
    }
}

// ==================== Gemini 函数名保护 ====================

/// 将可能被 Gemini 代理拦截的函数名替换为安全名称
///
/// 某些本地 API 代理（如 One API、New API 等）会检测 functionDeclarations 中的函数名，
/// 如果名称匹配内置搜索工具（如 web_search、google_search），会尝试将其转换为
/// Gemini 原生的 googleSearch/googleSearchRetrieval 工具，但转换过程可能破坏
/// Tool proto 结构，导致 tool_type oneof 未初始化的验证错误。
fn sanitize_function_name(name: &str) -> String {
    // 已知会被代理拦截的函数名模式
    // 使用前缀 "fn_" 作为安全包装，既保留语义又避免名称冲突
    match name {
        "web_search" => "fn_web_search".to_string(),
        "google_search" => "fn_google_search".to_string(),
        "search" => "fn_search".to_string(),
        _ => name.to_string(),
    }
}

// ==================== Gemini Schema 规范化 ====================

/// 递归规范化 JSON Schema 的 type 值为 Gemini API 的大写枚举
///
/// Gemini API 的 Schema proto 使用大写枚举:
/// STRING, NUMBER, INTEGER, BOOLEAN, ARRAY, OBJECT
/// 而前端传入的 JSON Schema 使用小写: string, number, boolean 等
/// 如果 proto 无法识别小写值，会认为 type 未初始化，导致上层 tool_type 校验失败
fn normalize_schema_types(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut new_map = serde_json::Map::new();
            for (key, val) in map {
                if key == "type" {
                    // 将小写 type 值映射为 Gemini 大写枚举
                    if let Some(type_str) = val.as_str() {
                        let upper = match type_str {
                            "string" => "STRING",
                            "number" => "NUMBER",
                            "integer" => "INTEGER",
                            "boolean" => "BOOLEAN",
                            "array" => "ARRAY",
                            "object" => "OBJECT",
                            "null" => "NULL",
                            // 已经是大写或未知值，保持原样
                            other => other,
                        };
                        new_map.insert(key.clone(), serde_json::Value::String(upper.to_string()));
                    } else {
                        new_map.insert(key.clone(), val.clone());
                    }
                } else {
                    // 递归处理嵌套的 properties、items 等字段
                    new_map.insert(key.clone(), normalize_schema_types(val));
                }
            }
            serde_json::Value::Object(new_map)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(normalize_schema_types).collect())
        }
        // 基本类型值直接返回
        other => other.clone(),
    }
}

// ==================== Gemini API 类型定义 ====================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeminiRequest {
    contents: Vec<GeminiContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system_instruction: Option<GeminiContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation_config: Option<GeminiGenerationConfig>,
    /// Function Calling 工具定义
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<GeminiTool>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct GeminiContent {
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    // 流式场景下部分 SSE chunk 可能不含 parts（如仅含 finishReason 的最终 chunk），
    // 使用 default 保证反序列化不报错（回退为空 Vec），避免 "missing field 'parts'" 解析失败
    #[serde(default)]
    parts: Vec<GeminiPart>,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
struct GeminiPart {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    text: String,
    /// 思考过程标记 - Gemini 3 Thinking Models
    #[serde(skip_serializing_if = "Option::is_none", default)]
    thought: Option<bool>,
    /// Gemini 3/3.5 function calling 的思考签名，必须随原 part 回传
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "thoughtSignature",
        alias = "thought_signature"
    )]
    thought_signature: Option<String>,
    /// 内联数据（用于图片等多模态内容）
    #[serde(skip_serializing_if = "Option::is_none", rename = "inlineData")]
    inline_data: Option<GeminiInlineData>,
    /// Function Call（模型请求调用工具）
    #[serde(skip_serializing_if = "Option::is_none", rename = "functionCall")]
    function_call: Option<GeminiFunctionCall>,
    /// Function Response（工具执行结果）
    #[serde(skip_serializing_if = "Option::is_none", rename = "functionResponse")]
    function_response: Option<GeminiFunctionResponse>,
}

/// Gemini 内联数据（图片等）
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GeminiInlineData {
    /// MIME 类型，如 "image/jpeg", "image/png"
    mime_type: String,
    /// Base64 编码的数据
    data: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeminiGenerationConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking_config: Option<GeminiThinkingConfig>,
    /// 响应输出类型（如 ["Text", "Image"] 或 ["Image"]）
    /// 图像生成模型专用，普通模型不需要设置
    #[serde(skip_serializing_if = "Option::is_none")]
    response_modalities: Option<Vec<String>>,
    /// 图像生成配置（宽高比等），嵌套在 generationConfig 内
    #[serde(skip_serializing_if = "Option::is_none")]
    image_config: Option<GeminiImageConfig>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeminiThinkingConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    include_thoughts: Option<bool>,
}

/// Gemini 图像生成配置（宽高比、分辨率等）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeminiImageConfig {
    /// 宽高比，如 "1:1"、"16:9"、"9:16" 等
    #[serde(skip_serializing_if = "Option::is_none")]
    aspect_ratio: Option<String>,
    /// 输出图片分辨率，如 "512"、"1K"、"2K"、"4K"
    /// 仅 gemini-3.1-flash-image-preview 和 gemini-3-pro-image-preview 支持
    #[serde(skip_serializing_if = "Option::is_none")]
    image_size: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GeminiResponse {
    candidates: Vec<GeminiCandidate>,
    #[serde(rename = "usageMetadata")]
    usage_metadata: Option<GeminiUsageMetadata>,
}

#[derive(Debug, Deserialize)]
struct GeminiCandidate {
    content: GeminiContent,
    #[serde(rename = "finishReason")]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GeminiUsageMetadata {
    #[serde(rename = "promptTokenCount", default)]
    prompt_token_count: Option<u32>,
    #[serde(rename = "candidatesTokenCount", default)]
    candidates_token_count: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct GeminiStreamChunk {
    #[serde(default)]
    candidates: Vec<GeminiStreamCandidate>,
    /// Gemini 在流式响应的最终 chunk 中返回 usage 数据
    #[serde(rename = "usageMetadata")]
    usage_metadata: Option<GeminiUsageMetadata>,
}

#[derive(Debug, Deserialize)]
struct GeminiStreamCandidate {
    content: Option<GeminiContent>,
    #[serde(rename = "finishReason")]
    finish_reason: Option<String>,
}

// ==================== Function Calling 类型定义 ====================

/// Gemini 工具定义
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GeminiTool {
    /// 函数声明列表
    function_declarations: Vec<GeminiFunctionDeclaration>,
}

/// 函数声明
#[derive(Debug, Serialize, Clone)]
struct GeminiFunctionDeclaration {
    /// 函数名称
    name: String,
    /// 函数描述
    description: String,
    /// 参数 Schema（JSON Schema 格式）
    parameters: serde_json::Value,
}

/// 函数调用（模型返回）
#[derive(Debug, Serialize, Deserialize, Clone)]
struct GeminiFunctionCall {
    /// 函数调用 ID，Gemini 3+ 会返回；functionResponse 需带回匹配
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    /// 函数名称
    name: String,
    /// 函数参数
    args: serde_json::Value,
}

/// 函数响应（用户提供）
#[derive(Debug, Serialize, Deserialize, Clone)]
struct GeminiFunctionResponse {
    /// 对应 functionCall 的 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    /// 函数名称
    name: String,
    /// 函数执行结果
    response: serde_json::Value,
    /// Gemini 3+ multimodal: 嵌套的图片数据 parts
    /// 通过 displayName + $ref 与 response 关联
    #[serde(skip_serializing_if = "Option::is_none")]
    parts: Option<Vec<GeminiFunctionResponsePart>>,
}

/// Gemini 3+ functionResponse 内嵌的 multimodal part
/// 用于在 functionResponse 中直接传递图片等多模态数据
#[derive(Debug, Serialize, Deserialize, Clone)]
struct GeminiFunctionResponsePart {
    /// 内联数据（含 displayName 用于 $ref 引用）
    #[serde(skip_serializing_if = "Option::is_none", rename = "inlineData")]
    inline_data: Option<GeminiFunctionResponseBlob>,
}

/// Gemini 3+ functionResponse 内的 inlineData blob
/// 相比普通 GeminiInlineData，额外包含 displayName 用于 $ref 引用
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GeminiFunctionResponseBlob {
    /// MIME 类型
    mime_type: String,
    /// 显示名称，用于 response 中的 $ref 引用
    display_name: String,
    /// Base64 编码数据
    data: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn request_includes_thinking_config_for_thinking_models() {
        let adapter = GeminiAdapter::new(ProviderConfig::new("test-key"));
        let request = ChatRequest {
            messages: vec![ChatMessage::user("hi")],
            model: Some("gemini-3.5-flash".to_string()),
            ..Default::default()
        };

        let value =
            serde_json::to_value(adapter.build_request_body(&request)).expect("serialize request");

        assert_eq!(
            value["generationConfig"]["thinkingConfig"]["includeThoughts"],
            true
        );
    }

    #[test]
    fn request_skips_thinking_config_for_image_output() {
        let adapter = GeminiAdapter::new(ProviderConfig::new("test-key"));
        let request = ChatRequest {
            messages: vec![ChatMessage::user("hi")],
            model: Some("gemini-3.1-flash-image-preview".to_string()),
            response_modalities: Some(vec!["Image".to_string()]),
            ..Default::default()
        };

        let value =
            serde_json::to_value(adapter.build_request_body(&request)).expect("serialize request");

        assert!(value["generationConfig"].get("thinkingConfig").is_none());
    }

    #[test]
    fn serializes_function_call_thought_signature_and_id() {
        let part = GeminiPart {
            text: String::new(),
            thought: None,
            thought_signature: Some("signature-a".to_string()),
            inline_data: None,
            function_call: Some(GeminiFunctionCall {
                id: Some("call-a".to_string()),
                name: "read".to_string(),
                args: serde_json::json!({ "path": "src/main.ts" }),
            }),
            function_response: None,
        };

        let value = serde_json::to_value(part).expect("serialize Gemini part");

        assert_eq!(value["thoughtSignature"], "signature-a");
        assert_eq!(value["functionCall"]["id"], "call-a");
        assert_eq!(value["functionCall"]["name"], "read");
    }

    #[test]
    fn extracts_function_call_thought_signature_and_id() {
        let parts = vec![GeminiPart {
            text: String::new(),
            thought: None,
            thought_signature: Some("signature-a".to_string()),
            inline_data: None,
            function_call: Some(GeminiFunctionCall {
                id: Some("call-a".to_string()),
                name: "read".to_string(),
                args: serde_json::json!({ "path": "src/main.ts" }),
            }),
            function_response: None,
        }];

        let response =
            GeminiAdapter::extract_tool_response_from_parts(&parts, &HashMap::new(), None);
        let tool_call = response
            .tool_calls
            .as_ref()
            .and_then(|calls| calls.first())
            .expect("tool call");

        assert_eq!(tool_call.id.as_deref(), Some("call-a"));
        assert_eq!(tool_call.thought_signature.as_deref(), Some("signature-a"));
    }

    #[test]
    fn extracts_max_tokens_finish_reason_from_tool_response() {
        let api_response: GeminiResponse = serde_json::from_value(serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [{
                        "functionCall": {
                            "name": "file_write",
                            "args": { "path": "index.html", "content": "<html>" }
                        }
                    }]
                },
                "finishReason": "MAX_TOKENS"
            }]
        }))
        .expect("parse Gemini tool response");
        let candidate = api_response.candidates.first().expect("candidate");

        let response = GeminiAdapter::extract_tool_response_from_parts(
            &candidate.content.parts,
            &HashMap::new(),
            candidate.finish_reason.clone(),
        );

        assert_eq!(response.finish_reason.as_deref(), Some("MAX_TOKENS"));
    }

    #[test]
    fn stream_candidate_preserves_max_tokens_finish_reason_without_content() {
        let chunk: GeminiStreamChunk = serde_json::from_value(serde_json::json!({
            "candidates": [{ "finishReason": "MAX_TOKENS" }]
        }))
        .expect("parse final Gemini stream chunk");

        assert_eq!(
            chunk.candidates[0].finish_reason.as_deref(),
            Some("MAX_TOKENS")
        );
        assert!(chunk.candidates[0].content.is_none());
    }
}
