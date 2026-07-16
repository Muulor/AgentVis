//! OpenAI API 适配器
//!
//! 实现 OpenAI Chat Completion API 的调用

use super::http_client::{
    format_stream_idle_timeout, get_client, get_streaming_client, stream_idle_timeout,
    stream_start_timeout, StreamIdleDiagnostics,
};
use async_trait::async_trait;
use futures::stream::Stream;
use serde::{Deserialize, Deserializer, Serialize};
use std::pin::Pin;
use std::time::{Duration, Instant};

use super::reasoning::{resolve_reasoning, ReasoningRoute, ResolvedReasoning};
use super::schema_compat::sanitize_tool_schema_for_compatible_gateway;
use super::types::{
    ChatMessage, ChatRequest, ChatResponse, ChatRole, ProviderConfig, ReasoningTraceCallback,
    ReasoningTraceProgress, StreamChunk, ToolCallProgressCallback, ToolCallStreamProgress,
    TOOL_CALL_PROGRESS_MIN_BYTES, TOOL_CALL_PROGRESS_STEP_BYTES,
};
use super::LlmProvider;
use crate::error::{AppError, AppResult};
use crate::text_utils::safe_truncate;

/// OpenAI API 基础 URL
const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
/// 默认模型
const DEFAULT_MODEL: &str = "gpt-5.4-mini";
const VOLCENGINE_STREAM_NO_USEFUL_PROGRESS_TIMEOUT_SECS: u64 = 120;

fn json_value_to_argument_string<E>(value: serde_json::Value) -> Result<String, E>
where
    E: serde::de::Error,
{
    match value {
        serde_json::Value::String(s) => Ok(s),
        serde_json::Value::Null => Ok(String::new()),
        other => serde_json::to_string(&other).map_err(E::custom),
    }
}

/// OpenAI-compatible providers normally return function.arguments as a JSON string.
/// Some providers return a JSON object directly. Normalize both forms to the
/// string buffer expected by the downstream tool-call parser.
fn deserialize_arguments_to_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    json_value_to_argument_string(value)
}

fn deserialize_optional_arguments_to_string<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    value.map(json_value_to_argument_string).transpose()
}

fn build_openai_tool_parameters_schema(
    _tool_name: &str,
    parameters: &serde_json::Value,
) -> serde_json::Value {
    let mut schema = sanitize_tool_schema_for_compatible_gateway(parameters);
    if let Some(schema_object) = schema.as_object_mut() {
        // Some OpenAI-compatible gateways only accept a plain object schema.
        // Rich validation stays in local tool execution.
        schema_object
            .entry("type".to_string())
            .or_insert_with(|| serde_json::json!("object"));
    }
    schema
}

fn is_native_openai_base_url(base_url: &str) -> bool {
    base_url
        .trim_end_matches('/')
        .eq_ignore_ascii_case(DEFAULT_BASE_URL)
}

fn model_requires_max_completion_tokens(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    model.starts_with("gpt-5")
        || model.starts_with("o1")
        || model.starts_with("o3")
        || model.starts_with("o4")
}

fn model_uses_openai_responses_reasoning(model: &str) -> bool {
    model.to_ascii_lowercase().starts_with("gpt-5")
}

fn openai_chat_reasoning_fields(
    reasoning: ResolvedReasoning,
    preset: Option<super::reasoning::ReasoningPreset>,
) -> (Option<OpenAIThinkingConfig>, Option<String>) {
    match reasoning {
        ResolvedReasoning::OpenAiResponses { effort } if matches!(preset, Some(value) if value != super::reasoning::ReasoningPreset::Recommended) => {
            (None, Some(effort.to_string()))
        }
        ResolvedReasoning::OpenAiCompatibleEffort { effort } => (None, Some(effort.to_string())),
        ResolvedReasoning::CompatibleThinking { enabled, effort } => (
            Some(OpenAIThinkingConfig::new(enabled)),
            effort.map(str::to_string),
        ),
        ResolvedReasoning::ThinkingToggle { enabled } => {
            (Some(OpenAIThinkingConfig::new(enabled)), None)
        }
        _ => (None, None),
    }
}

fn apply_openai_chat_reasoning(
    body: &mut serde_json::Value,
    reasoning: ResolvedReasoning,
    preset: Option<super::reasoning::ReasoningPreset>,
) {
    let (thinking, effort) = openai_chat_reasoning_fields(reasoning, preset);
    if let Some(thinking) = thinking {
        body["thinking"] = serde_json::to_value(thinking)
            .unwrap_or_else(|_| serde_json::json!({ "type": "enabled" }));
    }
    if let Some(effort) = effort {
        body["reasoning_effort"] = serde_json::Value::String(effort);
    }
}

/// OpenAI 适配器
///
/// 使用全局共享 HTTP Client，复用连接池
pub struct OpenAIAdapter {
    config: ProviderConfig,
}

impl OpenAIAdapter {
    /// 创建新的 OpenAI 适配器
    pub fn new(config: ProviderConfig) -> Self {
        Self { config }
    }

    /// 获取基础 URL
    fn base_url(&self) -> &str {
        self.config.base_url.as_deref().unwrap_or(DEFAULT_BASE_URL)
    }

    fn no_useful_stream_progress_timeout(&self) -> Option<Duration> {
        if self.base_url().contains("ark.cn-beijing.volces.com") {
            Some(Duration::from_secs(
                VOLCENGINE_STREAM_NO_USEFUL_PROGRESS_TIMEOUT_SECS,
            ))
        } else {
            None
        }
    }

    /// 将通用 HTTP 头（Authorization、Content-Type）和自定义头注入到请求中
    fn apply_headers(&self, mut builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        builder = builder
            .header("Authorization", format!("Bearer {}", self.config.api_key))
            .header("Content-Type", "application/json");
        // 注入供应商级别的自定义请求头
        for (key, value) in &self.config.custom_headers {
            builder = builder.header(key.as_str(), value.as_str());
        }
        builder
    }

    /// 获取使用的模型
    fn get_model(&self, request_model: Option<&str>) -> String {
        request_model
            .or(self.config.default_model.as_deref())
            .unwrap_or(DEFAULT_MODEL)
            .to_string()
    }

    fn max_tokens_request_field(&self, model: &str) -> &'static str {
        if is_native_openai_base_url(self.base_url()) && model_requires_max_completion_tokens(model)
        {
            "max_completion_tokens"
        } else {
            "max_tokens"
        }
    }

    fn should_use_responses_reasoning(&self, model: &str) -> bool {
        self.reasoning_route() == ReasoningRoute::NativeOpenAiResponses
            && model_uses_openai_responses_reasoning(model)
    }

    fn reasoning_route(&self) -> ReasoningRoute {
        let fallback = if is_native_openai_base_url(self.base_url()) {
            ReasoningRoute::NativeOpenAiResponses
        } else {
            ReasoningRoute::Unknown
        };
        self.config.reasoning_route.resolve_auto(fallback)
    }

    fn responses_message_value(
        &self,
        role: &str,
        content: &str,
        images: Option<&Vec<super::types::ImageAttachment>>,
    ) -> serde_json::Value {
        let should_include_images = self.config.supports_vision
            && role == "user"
            && images.map_or(false, |imgs| !imgs.is_empty());

        if !should_include_images {
            return serde_json::json!({
                "type": "message",
                "role": role,
                "content": content
            });
        }

        let use_raw_base64 = self.config.use_raw_base64_image;
        let mut content_parts = vec![serde_json::json!({
            "type": "input_text",
            "text": content
        })];

        if let Some(images) = images {
            for img in images {
                let image_url = if use_raw_base64 {
                    img.data.clone()
                } else {
                    format!("data:{};base64,{}", img.mime_type, img.data)
                };
                content_parts.push(serde_json::json!({
                    "type": "input_image",
                    "image_url": image_url,
                    "detail": "high"
                }));
            }
        }

        serde_json::json!({
            "type": "message",
            "role": role,
            "content": content_parts
        })
    }

    fn build_responses_chat_request_body(&self, request: &ChatRequest) -> serde_json::Value {
        let model = self.get_model(request.model.as_deref());
        let reasoning = resolve_reasoning(self.reasoning_route(), &model, request.reasoning_preset);
        let effort = match reasoning {
            ResolvedReasoning::OpenAiResponses { effort } => effort,
            _ => "medium",
        };
        let input: Vec<serde_json::Value> = request
            .messages
            .iter()
            .map(|message| {
                self.responses_message_value(
                    message.role.as_str(),
                    &message.content,
                    message.images.as_ref(),
                )
            })
            .collect();

        let mut body = serde_json::json!({
            "model": model,
            "input": input,
            "stream": request.stream,
            "store": false,
            "reasoning": {
                "effort": effort,
                "summary": "auto"
            }
        });

        if let Some(max_tokens) = request.max_tokens {
            body["max_output_tokens"] = serde_json::json!(max_tokens);
        }
        if let Some(temp) = request.temperature {
            body["temperature"] = serde_json::json!(temp);
        }

        body
    }

    /// 构建请求体
    fn build_request_body(&self, request: &ChatRequest) -> OpenAIRequest {
        let use_raw_base64 = self.config.use_raw_base64_image;
        let supports_vision = self.config.supports_vision;

        let messages: Vec<OpenAIRequestMessage> = request
            .messages
            .iter()
            .map(|m| {
                // 检查是否有图片附件（仅当供应商支持视觉输入时才注入 image_url）
                if supports_vision {
                    if let Some(ref images) = m.images {
                        if !images.is_empty() && m.role == ChatRole::User {
                            // 多模态消息：使用 content 数组格式
                            let mut content_parts: Vec<OpenAIContentPart> = Vec::new();

                            // 添加文本内容
                            content_parts.push(OpenAIContentPart::Text {
                                text: m.content.clone(),
                            });

                            // 添加图片
                            for img in images {
                                // 智谱需要纯 base64，OpenAI 需要 data URL
                                let image_url = if use_raw_base64 {
                                    img.data.clone()
                                } else {
                                    format!("data:{};base64,{}", img.mime_type, img.data)
                                };
                                content_parts.push(OpenAIContentPart::ImageUrl {
                                    image_url: OpenAIImageUrl {
                                        url: image_url,
                                        detail: "high".to_string(),
                                    },
                                });
                            }

                            log::trace!(
                                "[OpenAIAdapter] 📷 添加 {} 张图片到请求 (raw_base64={})",
                                images.len(),
                                use_raw_base64
                            );

                            return OpenAIRequestMessage {
                                role: m.role.as_str().to_string(),
                                content: OpenAIMessageContent::Parts(content_parts),
                            };
                        }
                    }
                }

                // 普通文本消息
                OpenAIRequestMessage {
                    role: m.role.as_str().to_string(),
                    content: OpenAIMessageContent::Text(m.content.clone()),
                }
            })
            .collect();

        // OpenRouter 图像生成支持：
        // 前端统一使用 Gemini 格式 ["Text", "Image"]，此处转为 OpenRouter 需要的小写
        let modalities = request
            .response_modalities
            .as_ref()
            .map(|mods| mods.iter().map(|m| m.to_lowercase()).collect());
        let image_config = request.image_config.as_ref().map(|cfg| OpenAIImageConfig {
            aspect_ratio: cfg.aspect_ratio.clone(),
            image_size: cfg.image_size.clone(),
        });
        let model = self.get_model(request.model.as_deref());
        let reasoning = resolve_reasoning(self.reasoning_route(), &model, request.reasoning_preset);
        let (thinking, reasoning_effort) =
            openai_chat_reasoning_fields(reasoning, request.reasoning_preset);
        let (max_tokens, max_completion_tokens) =
            if self.max_tokens_request_field(&model) == "max_completion_tokens" {
                (None, request.max_tokens)
            } else {
                (request.max_tokens, None)
            };

        OpenAIRequest {
            model,
            messages,
            temperature: request.temperature,
            max_tokens,
            max_completion_tokens,
            stream: request.stream,
            stream_options: None,
            modalities,
            image_config,
            thinking,
            reasoning_effort,
        }
    }

    // ==================== Function Calling 支持 ====================

    /// 构建 Function Calling 请求体（chat_with_tools 和 chat_stream_with_tools 共用）
    ///
    /// 将 ToolChatMessage 转换为 OpenAI 格式消息，构建工具定义，
    /// 返回 (请求体 JSON, 模型名称, 请求体大小 KB)
    fn build_tool_request_body(
        &self,
        request: &super::types::ToolChatRequest,
    ) -> (serde_json::Value, String, usize) {
        use super::types::ToolChatRole;

        let model = self.get_model(request.model_id.as_deref());
        let mut messages: Vec<serde_json::Value> = Vec::new();

        // 🛡️ 预扫描：收集合法 tool_call id，用于后续过滤幻觉工具调用和孤立 tool_result。
        // 此预扫描配合下方净化逻辑，在消息到达 API 之前彻底移除违规条目。
        let mut valid_call_ids: std::collections::HashSet<String> =
            std::collections::HashSet::new();

        let mut hallucination_call_ids: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        for prescan_msg in &request.messages {
            if prescan_msg.role == ToolChatRole::Assistant {
                if let Some(ref tool_calls) = prescan_msg.tool_calls {
                    for (i, tc) in tool_calls.iter().enumerate() {
                        // 仅将 name 合法（非空、非幻觉占位符）的工具调用 id 纳入合法集合
                        let is_hallucination = tc.name.is_empty() || tc.name == "unknown_tool";
                        let call_id = tc
                            .id
                            .clone()
                            .unwrap_or_else(|| format!("call_{}_{}", tc.name, i));
                        if is_hallucination {
                            hallucination_call_ids.insert(call_id);
                        } else {
                            valid_call_ids.insert(call_id);
                        }
                    }
                }
            }
        }
        log::trace!(
            "[OpenAIAdapter] 🛡️ 预扫描完成: {} 个合法 id, {} 个幻觉 id",
            valid_call_ids.len(),
            hallucination_call_ids.len()
        );

        for msg in &request.messages {
            match msg.role {
                ToolChatRole::System => {
                    messages.push(serde_json::json!({
                        "role": "system",
                        "content": msg.content
                    }));
                }
                ToolChatRole::User => {
                    // 仅当供应商支持视觉输入时才注入 image_url content part
                    if self.config.supports_vision {
                        if let Some(ref images) = msg.images {
                            if !images.is_empty() {
                                let mut content_parts = vec![serde_json::json!({
                                    "type": "text",
                                    "text": msg.content
                                })];
                                let use_raw_base64 = self.config.use_raw_base64_image;
                                for img in images {
                                    let image_url = if use_raw_base64 {
                                        img.data.clone()
                                    } else {
                                        format!("data:{};base64,{}", img.mime_type, img.data)
                                    };
                                    content_parts.push(serde_json::json!({
                                        "type": "image_url",
                                        "image_url": { "url": image_url, "detail": "high" }
                                    }));
                                }
                                log::trace!(
                                    "[OpenAIAdapter] 📷 chat_with_tools: 添加 {} 张图片",
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
                    } else {
                        // 不支持视觉的供应商：剥离图片，仅发送纯文本
                        messages.push(serde_json::json!({
                            "role": "user",
                            "content": msg.content
                        }));
                    }
                }
                ToolChatRole::Assistant => {
                    if let Some(ref tool_calls) = msg.tool_calls {
                        // 🛡️ 过滤幻觉工具调用（name 为空或为占位符 "unknown_tool"）
                        // "unknown_tool" 不在已提交的 tools[] 定义中，Responses API 严格校验会拒绝
                        let valid_tc_json: Vec<serde_json::Value> = tool_calls.iter().enumerate()
                            .filter(|(_, tc)| !tc.name.is_empty() && tc.name != "unknown_tool")
                            .map(|(i, tc)| {
                                // 优先使用前端传回的原始 id，无则生成
                                let call_id = tc.id.clone()
                                    .unwrap_or_else(|| format!("call_{}_{}", tc.name, i));
                                serde_json::json!({
                                    "id": call_id,
                                    "type": "function",
                                    "function": {
                                        "name": tc.name,
                                        "arguments": serde_json::to_string(&tc.args).unwrap_or_default()
                                    }
                                })
                            }).collect();

                        if valid_tc_json.is_empty() {
                            // 所有工具调用均为幻觉：退化为纯文本 assistant 消息
                            // 若 content 也为空则跳过整条消息，避免 push 空 content 消息
                            if !msg.content.is_empty() {
                                log::debug!("[OpenAIAdapter] 🛡️ 全幻觉 assistant 消息退化为纯文本 (过滤工具数: {})",
                                    tool_calls.len());
                                messages.push(serde_json::json!({
                                    "role": "assistant",
                                    "content": msg.content
                                }));
                            } else {
                                log::debug!("[OpenAIAdapter] 🛡️ 跳过: 全幻觉且 content 为空的 assistant 消息 (工具数: {})",
                                    tool_calls.len());
                            }
                        } else {
                            // 部分或全部工具合法：只发送过滤后的合法工具调用
                            let hallucination_count = tool_calls.len() - valid_tc_json.len();
                            if hallucination_count > 0 {
                                log::debug!("[OpenAIAdapter] 🛡️ 过滤 {} 个幻觉工具调用 (保留 {} 个合法调用)",
                                    hallucination_count, valid_tc_json.len());
                            }
                            let mut msg_json = serde_json::json!({
                                "role": "assistant",
                                "tool_calls": valid_tc_json
                            });
                            if !msg.content.is_empty() {
                                msg_json["content"] =
                                    serde_json::Value::String(msg.content.clone());
                            }
                            // DeepSeek 思考模式：工具调用场景下 reasoning_content 必须回传 API
                            if let Some(ref rc) = msg.reasoning_content {
                                msg_json["reasoning_content"] =
                                    serde_json::Value::String(rc.clone());
                            }
                            messages.push(msg_json);
                        }
                    } else {
                        messages.push(serde_json::json!({
                            "role": "assistant",
                            "content": msg.content
                        }));
                    }
                }
                ToolChatRole::Tool => {
                    let tool_call_id = msg
                        .tool_call_id
                        .clone()
                        .unwrap_or_else(|| "unknown".to_string());

                    // 🛡️ 过滤孤立 tool_result：tool_call_id 对应不到任何合法 tool_call 时跳过
                    // 场景：JS 层幻觉拦截注入的 unknown_tool 消息，其 tool_call_id 为 "unknown_tool_{timestamp}"，
                    // 与任何合法 assistant function_call 的 id 均不匹配。
                    // 只有在存在合法工具调用时才执行过滤（valid_call_ids 为空说明纯文本对话，不过滤）。
                    // 过滤条件（任一满足即跳过）：
                    //   1. call_id 在幻觉集合中（GPT 为 name="" 分配的真实 id，对应的 assistant
                    //      消息已被过滤掉，tool_result 无对应 function_call → Responses API 报 400）
                    //   2. 存在合法工具调用但此 call_id 不在合法集合中（真正的孤立 tool_result）
                    // 注意：两个集合均为空时（纯文本对话）条件均为 false → 不过滤（正确行为）
                    if hallucination_call_ids.contains(&tool_call_id)
                        || (!valid_call_ids.is_empty() && !valid_call_ids.contains(&tool_call_id))
                    {
                        log::debug!(
                            "[OpenAIAdapter] 🛡️ 过滤孤立 tool_result: call_id={} (已跳过)",
                            tool_call_id
                        );
                        continue;
                    }

                    log::trace!(
                        "[OpenAIAdapter] 🔧 Tool msg | id: {} | content_len: {} | images: {:?}",
                        tool_call_id,
                        msg.content.len(),
                        msg.images.as_ref().map(|imgs| imgs.len())
                    );

                    // 正常的 tool result（纯文本，OpenAI tool 角色只接受纯文本 content）
                    messages.push(serde_json::json!({
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": msg.content
                    }));

                    // 如果有图片附件且供应商支持视觉，追加一条 user 消息注入图片
                    // OpenAI tool role 不支持 image content part，
                    // 因此将图片提升到独立的 user 消息中
                    if self.config.supports_vision {
                        if let Some(ref images) = msg.images {
                            if !images.is_empty() {
                                let use_raw_base64 = self.config.use_raw_base64_image;
                                let mut content_parts: Vec<serde_json::Value> = Vec::new();
                                for img in images {
                                    // 智谱需要纯 base64，OpenAI 需要 data URL
                                    let image_url = if use_raw_base64 {
                                        img.data.clone()
                                    } else {
                                        format!("data:{};base64,{}", img.mime_type, img.data)
                                    };
                                    content_parts.push(serde_json::json!({
                                        "type": "image_url",
                                        "image_url": { "url": image_url, "detail": "high" }
                                    }));
                                }
                                // 文字提示引导模型分析图片
                                content_parts.push(serde_json::json!({
                                "type": "text",
                                "text": "The image above is file content read by a tool. Analyze it directly and describe what is in the image."
                            }));
                                log::trace!(
                                    "[OpenAIAdapter] 📷 Tool 图片注入: {} 张, 追加 user 消息",
                                    images.len()
                                );
                                messages.push(serde_json::json!({
                                    "role": "user",
                                    "content": content_parts
                                }));
                            }
                        }
                    }
                }
            }
        }

        // 构建工具定义（OpenAI 格式）
        let tools: Option<Vec<serde_json::Value>> = request.tools.as_ref().map(|tool_defs| {
            tool_defs
                .iter()
                .map(|t| {
                    let parameters = build_openai_tool_parameters_schema(&t.name, &t.parameters);
                    serde_json::json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": parameters
                        }
                    })
                })
                .collect()
        });

        // 构建请求体（不含 stream 字段，由调用方设置）
        let mut body = serde_json::json!({
            "model": model,
            "messages": messages
        });
        if let Some(ref tools_val) = tools {
            // 某些 OpenAI 兼容 API 不接受空的 tools 数组
            if !tools_val.is_empty() {
                body["tools"] = serde_json::Value::Array(tools_val.clone());
            }
        }
        if let Some(temp) = request.temperature {
            body["temperature"] = serde_json::json!(temp);
        }
        if let Some(max_tokens) = request.max_tokens {
            body[self.max_tokens_request_field(&model)] = serde_json::json!(max_tokens);
        }
        apply_openai_chat_reasoning(
            &mut body,
            resolve_reasoning(self.reasoning_route(), &model, request.reasoning_preset),
            request.reasoning_preset,
        );

        // 诊断日志：记录请求体大小
        let body_str = serde_json::to_string(&body).unwrap_or_default();
        let body_size_kb = body_str.len() / 1024;
        log::trace!(
            "[OpenAIAdapter] 📊 请求体大小: {} KB ({} bytes), messages: {}",
            body_size_kb,
            body_str.len(),
            messages.len()
        );

        (body, model, body_size_kb)
    }

    fn responses_tool_definition(&self, tool: &super::types::ToolDefinition) -> serde_json::Value {
        let parameters = build_openai_tool_parameters_schema(&tool.name, &tool.parameters);
        serde_json::json!({
            "type": "function",
            "name": tool.name,
            "description": tool.description,
            "parameters": parameters,
            "strict": false
        })
    }

    fn build_responses_tool_request_body(
        &self,
        request: &super::types::ToolChatRequest,
    ) -> (serde_json::Value, String, usize) {
        use super::types::ToolChatRole;

        let model = self.get_model(request.model_id.as_deref());
        let reasoning = resolve_reasoning(self.reasoning_route(), &model, request.reasoning_preset);
        let effort = match reasoning {
            ResolvedReasoning::OpenAiResponses { effort } => effort,
            _ => "medium",
        };
        let mut input: Vec<serde_json::Value> = Vec::new();

        let mut valid_call_ids: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        let mut hallucination_call_ids: std::collections::HashSet<String> =
            std::collections::HashSet::new();

        for prescan_msg in &request.messages {
            if prescan_msg.role == ToolChatRole::Assistant {
                if let Some(ref tool_calls) = prescan_msg.tool_calls {
                    for (i, tc) in tool_calls.iter().enumerate() {
                        let is_hallucination = tc.name.is_empty() || tc.name == "unknown_tool";
                        let call_id = tc
                            .id
                            .clone()
                            .unwrap_or_else(|| format!("call_{}_{}", tc.name, i));
                        if is_hallucination {
                            hallucination_call_ids.insert(call_id);
                        } else {
                            valid_call_ids.insert(call_id);
                        }
                    }
                }
            }
        }

        for msg in &request.messages {
            match msg.role {
                ToolChatRole::System => {
                    input.push(self.responses_message_value("system", &msg.content, None));
                }
                ToolChatRole::User => {
                    input.push(self.responses_message_value(
                        "user",
                        &msg.content,
                        msg.images.as_ref(),
                    ));
                }
                ToolChatRole::Assistant => {
                    if let Some(ref tool_calls) = msg.tool_calls {
                        let valid_tool_calls: Vec<_> = tool_calls
                            .iter()
                            .enumerate()
                            .filter(|(_, tc)| !tc.name.is_empty() && tc.name != "unknown_tool")
                            .collect();

                        if valid_tool_calls.is_empty() {
                            if !msg.content.is_empty() {
                                input.push(self.responses_message_value(
                                    "assistant",
                                    &msg.content,
                                    None,
                                ));
                            }
                            continue;
                        }

                        if !msg.content.is_empty() {
                            input.push(self.responses_message_value(
                                "assistant",
                                &msg.content,
                                None,
                            ));
                        }

                        for (i, tc) in valid_tool_calls {
                            let call_id = tc
                                .id
                                .clone()
                                .unwrap_or_else(|| format!("call_{}_{}", tc.name, i));
                            input.push(serde_json::json!({
                                "type": "function_call",
                                "call_id": call_id,
                                "name": tc.name,
                                "arguments": serde_json::to_string(&tc.args).unwrap_or_default(),
                                "status": "completed"
                            }));
                        }
                    } else {
                        input.push(self.responses_message_value("assistant", &msg.content, None));
                    }
                }
                ToolChatRole::Tool => {
                    let tool_call_id = msg
                        .tool_call_id
                        .clone()
                        .unwrap_or_else(|| "unknown".to_string());

                    if hallucination_call_ids.contains(&tool_call_id)
                        || (!valid_call_ids.is_empty() && !valid_call_ids.contains(&tool_call_id))
                    {
                        log::debug!(
                            "[OpenAIAdapter] skipping orphan Responses function_call_output: call_id={}",
                            tool_call_id
                        );
                        continue;
                    }

                    input.push(serde_json::json!({
                        "type": "function_call_output",
                        "call_id": tool_call_id,
                        "output": msg.content
                    }));

                    if self.config.supports_vision {
                        if let Some(ref images) = msg.images {
                            if !images.is_empty() {
                                input.push(self.responses_message_value(
                                    "user",
                                    "The image above is file content read by a tool. Analyze it directly and describe what is in the image.",
                                    Some(images),
                                ));
                            }
                        }
                    }
                }
            }
        }

        let tools: Option<Vec<serde_json::Value>> = request.tools.as_ref().map(|tool_defs| {
            tool_defs
                .iter()
                .map(|tool| self.responses_tool_definition(tool))
                .collect()
        });

        let mut body = serde_json::json!({
            "model": model,
            "input": input,
            "stream": true,
            "store": false,
            "reasoning": {
                "effort": effort,
                "summary": "auto"
            }
        });

        if let Some(tools_val) = tools {
            if !tools_val.is_empty() {
                body["tools"] = serde_json::Value::Array(tools_val);
                body["tool_choice"] = serde_json::json!("auto");
            }
        }
        if let Some(temp) = request.temperature {
            body["temperature"] = serde_json::json!(temp);
        }
        if let Some(max_tokens) = request.max_tokens {
            body["max_output_tokens"] = serde_json::json!(max_tokens);
        }

        let body_str = serde_json::to_string(&body).unwrap_or_default();
        let body_size_kb = body_str.len() / 1024;

        (body, model, body_size_kb)
    }

    /// 带工具的聊天请求（OpenAI Function Calling，非流式）
    ///
    /// 将统一的 ToolChatMessage 转换为 OpenAI Chat Completion API 格式，
    /// 解析响应中的 tool_calls 和 content（思考文字），返回 ToolChatResponse。
    pub async fn chat_with_tools(
        &self,
        request: super::types::ToolChatRequest,
    ) -> AppResult<super::types::ToolChatResponse> {
        use super::types::ToolChatResponse;

        let url = format!("{}/chat/completions", self.base_url());
        let (body, model, body_size_kb) = self.build_tool_request_body(&request);

        log::trace!("[OpenAIAdapter] 🔧 chat_with_tools 请求 URL: {}", url);
        log::trace!("[OpenAIAdapter] 🔧 model: {}", model);

        // 发送非流式请求
        let response = self
            .apply_headers(get_client().post(&url))
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
            log::warn!("[OpenAIAdapter] chat_with_tools 错误: {}", error_msg);
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

        let api_response: OpenAIToolResponse =
            serde_json::from_str(&response_text).map_err(|e| {
                AppError::LlmApi(format!(
                    "Failed to parse response: {} | Raw response: {}",
                    e,
                    safe_truncate(&response_text, 500)
                ))
            })?;

        let choice = api_response
            .choices
            .first()
            .ok_or_else(|| AppError::LlmApi("Response does not contain choices".to_string()))?;

        // 提取工具调用或文本响应
        Self::extract_tool_response(choice)
    }

    /// 流式 Function Calling 请求（内部消费 SSE，外部返回完整响应）
    ///
    /// 行为与 chat_with_tools() 完全一致，但使用 SSE 流式接收，
    /// 避免长时间 idle 导致链路超时。返回类型不变，调用方无感知。
    async fn chat_stream_with_tools_responses(
        &self,
        request: super::types::ToolChatRequest,
        progress_callback: Option<ToolCallProgressCallback>,
        reasoning_callback: Option<ReasoningTraceCallback>,
    ) -> AppResult<super::types::ToolChatResponse> {
        use super::types::ToolChatResponse;
        use eventsource_stream::Eventsource;
        use futures::StreamExt;

        let url = format!("{}/responses", self.base_url());
        let (body, model, body_size_kb) = self.build_responses_tool_request_body(&request);

        log::trace!(
            "[OpenAIAdapter] Responses chat_stream_with_tools URL: {}, model: {}",
            url,
            model
        );

        let start_timeout = stream_start_timeout();
        let response = tokio::time::timeout(
            start_timeout,
            self.apply_headers(get_streaming_client().post(&url))
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
                "Responses streaming request failed ({}): {} | Request body: {} KB",
                error_type, e, body_size_kb
            ))
        })?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            let error_msg = format!(
                "Responses API returned an error ({}): {}",
                status, error_text
            );
            log::warn!(
                "[OpenAIAdapter] Responses chat_stream_with_tools error: {}",
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

        let mut stream = response.bytes_stream().eventsource();
        let mut content_buffer = String::new();
        let mut reasoning_buffer = String::new();
        let mut tool_acc = ResponsesToolCallAccumulator::with_progress(progress_callback);
        let mut chunk_count: u64 = 0;
        let mut last_event_type: Option<String> = None;
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
                            protocol: "openai-responses",
                            events: chunk_count,
                            last_event: last_event_type.as_deref(),
                            content_chars: content_buffer.chars().count(),
                            reasoning_chars: reasoning_buffer.chars().count(),
                            tool_calls: tool_acc.calls.len(),
                            tool_arg_bytes: tool_acc
                                .calls
                                .values()
                                .map(|call| call.arguments.len())
                                .sum(),
                        },
                    )));
                }
            };

            match event {
                Ok(ev) => {
                    let data = ev.data;
                    if data == "[DONE]" {
                        break;
                    }

                    let value: serde_json::Value = match serde_json::from_str(&data) {
                        Ok(value) => value,
                        Err(e) => {
                            log::warn!(
                                "[OpenAIAdapter] skipping unparsable Responses stream event: {}",
                                e
                            );
                            chunk_count += 1;
                            continue;
                        }
                    };
                    last_event_type = responses_event_type(&value).map(str::to_string);

                    match responses_event_type(&value) {
                        Some("response.output_text.delta") | Some("response.refusal.delta") => {
                            if let Some(delta) = responses_event_string(&value, "delta") {
                                content_buffer.push_str(delta);
                            }
                        }
                        Some("response.output_text.done") => {
                            if content_buffer.is_empty() {
                                if let Some(text) = responses_event_string(&value, "text") {
                                    content_buffer.push_str(text);
                                }
                            }
                        }
                        Some("response.reasoning_summary_text.delta")
                        | Some("response.reasoning_text.delta") => {
                            if let Some(delta) = responses_event_string(&value, "delta") {
                                if !delta.is_empty() {
                                    reasoning_buffer.push_str(delta);
                                    if let Some(callback) = reasoning_callback.as_ref() {
                                        callback(ReasoningTraceProgress {
                                            delta: delta.to_string(),
                                            done: false,
                                        });
                                    }
                                }
                            }
                        }
                        Some("response.reasoning_summary_text.done")
                        | Some("response.reasoning_text.done") => {
                            if reasoning_buffer.is_empty() {
                                let text =
                                    responses_event_string(&value, "text").unwrap_or_default();
                                if !text.is_empty() {
                                    reasoning_buffer.push_str(text);
                                    if let Some(callback) = reasoning_callback.as_ref() {
                                        callback(ReasoningTraceProgress {
                                            delta: text.to_string(),
                                            done: false,
                                        });
                                    }
                                }
                            }
                        }
                        Some("response.reasoning_summary_part.done") => {
                            if reasoning_buffer.is_empty() {
                                let text = value
                                    .get("part")
                                    .and_then(|part| part.get("text"))
                                    .and_then(|text| text.as_str())
                                    .unwrap_or_default();
                                if !text.is_empty() {
                                    reasoning_buffer.push_str(text);
                                    if let Some(callback) = reasoning_callback.as_ref() {
                                        callback(ReasoningTraceProgress {
                                            delta: text.to_string(),
                                            done: false,
                                        });
                                    }
                                }
                            }
                        }
                        Some("response.output_item.added") | Some("response.output_item.done") => {
                            let output_index =
                                responses_event_u32(&value, "output_index").unwrap_or(0) as usize;
                            if let Some(item) = value.get("item") {
                                tool_acc.update_from_item(output_index, item);
                            }
                        }
                        Some("response.function_call_arguments.delta") => {
                            let output_index =
                                responses_event_u32(&value, "output_index").unwrap_or(0) as usize;
                            let item_id =
                                responses_event_string(&value, "item_id").unwrap_or_default();
                            let delta = responses_event_string(&value, "delta").unwrap_or_default();
                            tool_acc.accumulate_arguments_delta(output_index, item_id, delta);
                        }
                        Some("response.function_call_arguments.done") => {
                            let output_index =
                                responses_event_u32(&value, "output_index").unwrap_or(0) as usize;
                            let item_id =
                                responses_event_string(&value, "item_id").unwrap_or_default();
                            let name = responses_event_string(&value, "name").unwrap_or_default();
                            let arguments =
                                responses_event_string(&value, "arguments").unwrap_or_default();
                            tool_acc.finish_arguments(output_index, item_id, name, arguments);
                        }
                        Some("response.completed") | Some("response.incomplete") => {
                            let (input_tokens, output_tokens) = responses_usage_tokens(&value);
                            final_input_tokens = input_tokens;
                            final_output_tokens = output_tokens;
                            final_finish_reason = responses_tool_finish_reason(&value);

                            if let Some(output) = value
                                .get("response")
                                .and_then(|response| response.get("output"))
                            {
                                if content_buffer.is_empty() {
                                    content_buffer.push_str(&responses_collect_output_text(output));
                                }
                                if reasoning_buffer.is_empty() {
                                    let summary = responses_collect_reasoning_summary(output);
                                    if !summary.is_empty() {
                                        reasoning_buffer.push_str(&summary);
                                        if let Some(callback) = reasoning_callback.as_ref() {
                                            callback(ReasoningTraceProgress {
                                                delta: summary,
                                                done: false,
                                            });
                                        }
                                    }
                                }
                                tool_acc.update_from_output_array(output);
                            }
                            break;
                        }
                        Some("response.failed") | Some("error") => {
                            return Err(AppError::LlmApi(
                                responses_error_message(&value)
                                    .unwrap_or_else(|| "Responses API stream failed".to_string()),
                            ));
                        }
                        _ => {}
                    }

                    chunk_count += 1;
                }
                Err(e) => {
                    return Err(AppError::LlmApi(format!(
                        "Responses streaming error (received {} events): {}",
                        chunk_count, e
                    )));
                }
            }
        }

        if !reasoning_buffer.is_empty() {
            if let Some(callback) = reasoning_callback.as_ref() {
                callback(ReasoningTraceProgress {
                    delta: String::new(),
                    done: true,
                });
            }
        }

        log::trace!(
            "[OpenAIAdapter] Responses stream completed: {} events, content: {} chars, tool_calls: {}",
            chunk_count,
            content_buffer.len(),
            tool_acc.calls.len()
        );

        if !tool_acc.is_empty() {
            let parsed_calls = tool_acc.finalize();
            Ok(ToolChatResponse {
                response_type: "tool_use".to_string(),
                content: if content_buffer.is_empty() {
                    None
                } else {
                    Some(content_buffer)
                },
                tool_calls: Some(parsed_calls),
                error: None,
                finish_reason: final_finish_reason,
                input_tokens: final_input_tokens,
                output_tokens: final_output_tokens,
                reasoning_content: if reasoning_buffer.is_empty() {
                    None
                } else {
                    Some(reasoning_buffer)
                },
            })
        } else {
            Ok(ToolChatResponse {
                response_type: "text".to_string(),
                content: if content_buffer.is_empty() {
                    None
                } else {
                    Some(content_buffer)
                },
                tool_calls: None,
                error: None,
                finish_reason: final_finish_reason,
                input_tokens: final_input_tokens,
                output_tokens: final_output_tokens,
                reasoning_content: if reasoning_buffer.is_empty() {
                    None
                } else {
                    Some(reasoning_buffer)
                },
            })
        }
    }

    pub async fn chat_stream_with_tools(
        &self,
        request: super::types::ToolChatRequest,
        progress_callback: Option<ToolCallProgressCallback>,
        reasoning_callback: Option<ReasoningTraceCallback>,
    ) -> AppResult<super::types::ToolChatResponse> {
        use super::types::ToolChatResponse;
        use eventsource_stream::Eventsource;
        use futures::StreamExt;

        let selected_model = self.get_model(request.model_id.as_deref());
        if self.should_use_responses_reasoning(&selected_model) {
            return self
                .chat_stream_with_tools_responses(request, progress_callback, reasoning_callback)
                .await;
        }

        let url = format!("{}/chat/completions", self.base_url());
        let (mut body, model, body_size_kb) = self.build_tool_request_body(&request);

        // 关键：启用流式模式以保持连接活跃
        body["stream"] = serde_json::json!(true);
        // 仅对支持 stream_options 的供应商开启 usage 返回
        if self.config.supports_stream_usage {
            body["stream_options"] = serde_json::json!({"include_usage": true});
        }

        log::trace!(
            "[OpenAIAdapter] 🔧 chat_stream_with_tools 请求 URL: {}",
            url
        );
        log::trace!("[OpenAIAdapter] 🔧 model: {}, 流式模式已启用", model);

        let start_timeout = stream_start_timeout();
        let response = tokio::time::timeout(
            start_timeout,
            self.apply_headers(get_streaming_client().post(&url))
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
            log::warn!("[OpenAIAdapter] chat_stream_with_tools 错误: {}", error_msg);
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
        let mut stream = response.bytes_stream().eventsource();
        let mut content_buffer = String::new();
        let mut reasoning_buffer = String::new();
        let mut tool_acc = ToolCallAccumulator::with_progress(progress_callback);
        let mut chunk_count: u64 = 0;
        let mut last_event_type: Option<String> = None;
        // 累积 usage 数据（从包含 usage 的 chunk 中提取）
        let mut final_input_tokens: Option<u32> = None;
        let mut final_output_tokens: Option<u32> = None;
        let mut final_finish_reason: Option<String> = None;
        let no_useful_progress_timeout = self.no_useful_stream_progress_timeout();
        let mut last_useful_progress_at = Instant::now();

        let idle_timeout = stream_idle_timeout();
        loop {
            let event = match tokio::time::timeout(idle_timeout, stream.next()).await {
                Ok(Some(event)) => event,
                Ok(None) => break,
                Err(_) => {
                    return Err(AppError::LlmApi(format_stream_idle_timeout(
                        idle_timeout,
                        StreamIdleDiagnostics {
                            protocol: "openai-chat-completions",
                            events: chunk_count,
                            last_event: last_event_type.as_deref(),
                            content_chars: content_buffer.chars().count(),
                            reasoning_chars: reasoning_buffer.chars().count(),
                            tool_calls: tool_acc.calls.len(),
                            tool_arg_bytes: tool_acc
                                .calls
                                .values()
                                .map(|(_, _, arguments)| arguments.len())
                                .sum(),
                        },
                    )));
                }
            };

            match event {
                Ok(ev) => {
                    last_event_type = Some(if ev.event.is_empty() {
                        "message".to_string()
                    } else {
                        ev.event
                    });
                    let data = ev.data;

                    // [DONE] 标记：流结束
                    if data == "[DONE]" {
                        break;
                    }

                    // 解析为带 tool_calls 的扩展 chunk 结构
                    let chunk: OpenAIStreamChunkWithTools = match serde_json::from_str(&data) {
                        Ok(c) => c,
                        Err(e) => {
                            // 容错：跳过无法解析的 chunk（某些 API 会发送非标准事件）
                            log::warn!("[OpenAIAdapter] 跳过无法解析的流式 chunk: {}", e);
                            if let Some(timeout) = no_useful_progress_timeout {
                                if last_useful_progress_at.elapsed() >= timeout {
                                    return Err(AppError::LlmApi(format!(
                                        "Volcengine streaming no useful tool-call progress timeout ({} seconds without non-empty content, reasoning, or tool-call delta)",
                                        timeout.as_secs()
                                    )));
                                }
                            }
                            continue;
                        }
                    };

                    let mut has_useful_progress = false;

                    if let Some(choice) = chunk.choices.first() {
                        // 累积文本内容
                        if let Some(ref delta_content) = choice.delta.content {
                            if !delta_content.is_empty() {
                                has_useful_progress = true;
                            }
                            content_buffer.push_str(delta_content);
                        }

                        // 累积 reasoning_content（DeepSeek 思考模式专用）
                        if let Some(ref delta_reasoning) = choice.delta.reasoning_content {
                            if !delta_reasoning.is_empty() {
                                has_useful_progress = true;
                                if let Some(callback) = reasoning_callback.as_ref() {
                                    callback(ReasoningTraceProgress {
                                        delta: delta_reasoning.clone(),
                                        done: false,
                                    });
                                }
                            }
                            reasoning_buffer.push_str(delta_reasoning);
                        }

                        // 累积 tool_call 片段
                        if let Some(ref tool_deltas) = choice.delta.tool_calls {
                            for tc_delta in tool_deltas {
                                if tool_call_delta_has_useful_progress(tc_delta) {
                                    has_useful_progress = true;
                                }
                                tool_acc.accumulate(OpenAIStreamToolCallDelta {
                                    index: tc_delta.index,
                                    id: tc_delta.id.clone(),
                                    function: tc_delta.function.as_ref().map(|f| {
                                        OpenAIStreamFunctionDelta {
                                            name: f.name.clone(),
                                            arguments: f.arguments.clone(),
                                        }
                                    }),
                                });
                            }
                        }

                        // finish_reason 出现时保留 provider 原值并结束消费
                        if let Some(reason) = choice.finish_reason.as_ref() {
                            final_finish_reason = Some(reason.clone());
                            chunk_count += 1;
                            break;
                        }
                    }

                    // 提取 usage 数据（通常在 finish_reason 后的特殊 chunk 中）
                    if let Some(ref usage) = chunk.usage {
                        final_input_tokens = Some(usage.prompt_tokens as u32);
                        final_output_tokens = Some(usage.completion_tokens as u32);
                    }

                    if has_useful_progress {
                        last_useful_progress_at = Instant::now();
                    } else {
                        if let Some(timeout) = no_useful_progress_timeout {
                            if last_useful_progress_at.elapsed() >= timeout {
                                return Err(AppError::LlmApi(format!(
                                    "Volcengine streaming no useful tool-call progress timeout ({} seconds without non-empty content, reasoning, or tool-call delta)",
                                    timeout.as_secs()
                                )));
                            }
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

        if !reasoning_buffer.is_empty() {
            if let Some(callback) = reasoning_callback.as_ref() {
                callback(ReasoningTraceProgress {
                    delta: String::new(),
                    done: true,
                });
            }
        }

        log::trace!(
            "[OpenAIAdapter] 📊 流式接收完成: {} chunks, content: {} 字符, tool_calls: {}",
            chunk_count,
            content_buffer.len(),
            tool_acc.calls.len()
        );

        // 组装响应：根据是否有 tool_calls 决定响应类型
        if !tool_acc.is_empty() {
            let parsed_calls = tool_acc.finalize();
            log::trace!(
                "[OpenAIAdapter] 🔧 流式收到 {} 个工具调用, 伴随文字: {} 字符",
                parsed_calls.len(),
                content_buffer.len()
            );

            Ok(ToolChatResponse {
                response_type: "tool_use".to_string(),
                content: if content_buffer.is_empty() {
                    None
                } else {
                    Some(content_buffer)
                },
                tool_calls: Some(parsed_calls),
                error: None,
                finish_reason: final_finish_reason,
                input_tokens: final_input_tokens,
                output_tokens: final_output_tokens,
                reasoning_content: if reasoning_buffer.is_empty() {
                    None
                } else {
                    Some(reasoning_buffer)
                },
            })
        } else {
            log::trace!(
                "[OpenAIAdapter] 📝 流式文本响应: {} 字符",
                content_buffer.len()
            );

            Ok(ToolChatResponse {
                response_type: "text".to_string(),
                content: if content_buffer.is_empty() {
                    None
                } else {
                    Some(content_buffer)
                },
                tool_calls: None,
                error: None,
                finish_reason: final_finish_reason,
                input_tokens: final_input_tokens,
                output_tokens: final_output_tokens,
                reasoning_content: if reasoning_buffer.is_empty() {
                    None
                } else {
                    Some(reasoning_buffer)
                },
            })
        }
    }

    /// 从非流式响应中提取工具调用或文本响应
    async fn chat_stream_responses(
        &self,
        request: ChatRequest,
    ) -> AppResult<Pin<Box<dyn Stream<Item = AppResult<StreamChunk>> + Send>>> {
        use eventsource_stream::Eventsource;
        use futures::StreamExt;

        let url = format!("{}/responses", self.base_url());
        let mut body = self.build_responses_chat_request_body(&request);
        body["stream"] = serde_json::json!(true);
        let body_size_kb = serde_json::to_string(&body).unwrap_or_default().len() / 1024;

        let start_timeout = stream_start_timeout();
        let response = tokio::time::timeout(
            start_timeout,
            self.apply_headers(get_streaming_client().post(&url))
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
                "Responses streaming request failed ({}): {} | Request body: {} KB",
                error_type, e, body_size_kb
            ))
        })?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unable to read error message".to_string());
            return Err(AppError::LlmApi(format!(
                "Responses API returned an error ({}): {}",
                status, error_text
            )));
        }

        let stream = response.bytes_stream().eventsource();
        let mapped_stream = stream.filter_map(|event| async move {
            match event {
                Ok(ev) => match map_responses_stream_event(&ev.data) {
                    Ok(Some(chunk)) => Some(Ok(chunk)),
                    Ok(None) => None,
                    Err(e) => Some(Err(e)),
                },
                Err(e) => Some(Err(AppError::LlmApi(format!(
                    "Responses streaming error: {}",
                    e
                )))),
            }
        });

        Ok(Box::pin(mapped_stream))
    }

    fn extract_tool_response(
        choice: &OpenAIToolChoice,
    ) -> AppResult<super::types::ToolChatResponse> {
        use super::types::{ToolCall as TypesToolCall, ToolChatResponse};

        if let Some(ref tool_calls) = choice.message.tool_calls {
            if !tool_calls.is_empty() {
                let parsed_calls: Vec<TypesToolCall> = tool_calls.iter().filter_map(|tc| {
                    let args: serde_json::Value = serde_json::from_str(&tc.function.arguments)
                        .unwrap_or_else(|e| {
                            log::warn!(
                                "[OpenAIAdapter] ⚠️ tool_call args 解析失败 (tool: {}): {} | args_len: {} | 前200字符: {}",
                                tc.function.name, e, tc.function.arguments.len(),
                                safe_truncate(&tc.function.arguments, 200)
                            );
                            super::json_repair::repair_tool_call_json(&tc.function.arguments)
                                .unwrap_or_else(|| {
                                    log::warn!("[OpenAIAdapter] JSON 修复也失败，回退为空对象");
                                    serde_json::json!({})
                                })
                        });
                    Some(TypesToolCall {
                        name: tc.function.name.clone(),
                        args,
                        id: Some(tc.id.clone()),
                        thought_signature: None,
                    })
                }).collect();

                let content = choice.message.content.clone();
                log::trace!(
                    "[OpenAIAdapter] 🔧 收到 {} 个工具调用, 伴随文字: {} 字符",
                    parsed_calls.len(),
                    content.as_ref().map_or(0, |c| c.len())
                );

                return Ok(ToolChatResponse {
                    response_type: "tool_use".to_string(),
                    content,
                    tool_calls: Some(parsed_calls),
                    error: None,
                    finish_reason: choice.finish_reason.clone(),
                    input_tokens: None,
                    output_tokens: None,
                    reasoning_content: None,
                });
            }
        }

        let content = choice.message.content.clone();
        log::trace!(
            "[OpenAIAdapter] 📝 文本响应: {} 字符",
            content.as_ref().map_or(0, |c| c.len())
        );

        Ok(ToolChatResponse {
            response_type: "text".to_string(),
            content,
            tool_calls: None,
            error: None,
            finish_reason: choice.finish_reason.clone(),
            input_tokens: None,
            output_tokens: None,
            reasoning_content: None,
        })
    }
}

#[async_trait]
impl LlmProvider for OpenAIAdapter {
    async fn chat(&self, request: ChatRequest) -> AppResult<ChatResponse> {
        let url = format!("{}/chat/completions", self.base_url());
        let body = self.build_request_body(&request);

        let response = self
            .apply_headers(get_client().post(&url))
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

        // 获取原始响应文本用于调试
        let response_text = response
            .text()
            .await
            .map_err(|e| AppError::LlmApi(format!("Failed to read response: {}", e)))?;

        // 调试日志：打印原始响应（安全截取前 500 字节，避免在多字节字符中间切割导致 panic）
        let preview = safe_truncate(&response_text, 500);
        log::trace!(
            "[OpenAI] 原始响应 ({} bytes): {}",
            response_text.len(),
            preview
        );

        // 解析 JSON
        let api_response: OpenAIResponse = serde_json::from_str(&response_text).map_err(|e| {
            AppError::LlmApi(format!(
                "Failed to parse response: {} | Raw response: {}",
                e,
                safe_truncate(&response_text, 500)
            ))
        })?;

        let choice = api_response.choices.first().ok_or_else(|| {
            AppError::LlmApi(format!(
                "Response does not contain choices | Raw response: {}",
                safe_truncate(&response_text, 500)
            ))
        })?;

        // 获取 content，处理可能的 None 情况
        let mut content = choice.message.content.clone().unwrap_or_default();

        // OpenRouter 图像生成：将 images 转为 markdown 拼入 content，
        // 与 Gemini adapter 的 inlineData → markdown 处理统一
        if let Some(ref images) = choice.message.images {
            let image_md = openrouter_images_to_markdown(images);
            if !image_md.is_empty() {
                content.push_str(&image_md);
                log::trace!(
                    "[OpenAIAdapter] 非流式响应: 提取 {} 张图片转为 markdown",
                    images.len()
                );
            }
        }

        // 如果 content 为空，记录警告
        if content.is_empty() {
            log::warn!(
                "[OpenAI] API 返回空 content | finish_reason: {:?} | 原始响应: {}",
                choice.finish_reason,
                safe_truncate(&response_text, 500)
            );
        }

        Ok(ChatResponse {
            content,
            model: api_response.model,
            input_tokens: api_response.usage.as_ref().map(|u| u.prompt_tokens),
            output_tokens: api_response.usage.as_ref().map(|u| u.completion_tokens),
            finish_reason: choice.finish_reason.clone(),
        })
    }

    async fn chat_stream(
        &self,
        request: ChatRequest,
    ) -> AppResult<Pin<Box<dyn Stream<Item = AppResult<StreamChunk>> + Send>>> {
        use eventsource_stream::Eventsource;
        use futures::StreamExt;

        let selected_model = self.get_model(request.model.as_deref());
        if self.should_use_responses_reasoning(&selected_model) {
            return self.chat_stream_responses(request).await;
        }

        let url = format!("{}/chat/completions", self.base_url());
        let mut body = self.build_request_body(&request);
        body.stream = true;
        // 仅对支持 stream_options 的供应商开启 usage 返回
        if self.config.supports_stream_usage {
            body.stream_options = Some(StreamOptions {
                include_usage: true,
            });
        }

        let start_timeout = stream_start_timeout();
        let response = tokio::time::timeout(
            start_timeout,
            self.apply_headers(get_streaming_client().post(&url))
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

        let mapped_stream = stream.map(|event| {
            match event {
                Ok(ev) => {
                    let data = ev.data;

                    // 检查是否是结束标记
                    if data == "[DONE]" {
                        return Ok(StreamChunk {
                            delta: String::new(),
                            reasoning: None,
                            done: true,
                            finish_reason: Some("stop".to_string()),
                            input_tokens: None,
                            output_tokens: None,
                        });
                    }

                    // 解析 JSON
                    let chunk: OpenAIStreamChunk = serde_json::from_str(&data).map_err(|e| {
                        AppError::LlmApi(format!("Failed to parse streaming response: {}", e))
                    })?;

                    let choice = chunk.choices.first();
                    let text_delta = choice
                        .and_then(|c| c.delta.content.as_ref())
                        .cloned()
                        .unwrap_or_default();
                    let reasoning_delta = choice
                        .and_then(|c| c.delta.reasoning_content.as_ref())
                        .filter(|reasoning| !reasoning.is_empty())
                        .cloned();

                    // OpenRouter 图像生成：将 delta.images 转为 markdown 格式，
                    // 与 Gemini adapter 的 inlineData → markdown 处理统一，
                    // 前端 extractBase64Images() 使用同一套正则提取
                    let image_md = choice
                        .and_then(|c| c.delta.images.as_ref())
                        .map(|imgs| openrouter_images_to_markdown(imgs))
                        .unwrap_or_default();
                    let delta = format!("{}{}", text_delta, image_md);

                    let finish_reason = choice.and_then(|c| c.finish_reason.clone());
                    let done = finish_reason.is_some();

                    // 从最终 chunk 的 usage 字段提取 token 用量
                    let (input_tokens, output_tokens) = match &chunk.usage {
                        Some(usage) => (
                            Some(usage.prompt_tokens as u32),
                            Some(usage.completion_tokens as u32),
                        ),
                        None => (None, None),
                    };

                    Ok(StreamChunk {
                        delta,
                        reasoning: reasoning_delta,
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
        // 发送一个简单的请求来验证 API Key
        let request = ChatRequest {
            messages: vec![ChatMessage::user("Hi")],
            max_tokens: Some(5),
            stream: false,
            ..Default::default()
        };

        match self.chat(request).await {
            Ok(_) => Ok(true),
            Err(AppError::LlmApi(msg)) if msg.contains("401") => Ok(false),
            Err(e) => Err(e),
        }
    }
}

// ==================== OpenAI API 类型定义 ====================

#[derive(Debug, Serialize)]
struct OpenAIRequest {
    model: String,
    messages: Vec<OpenAIRequestMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_completion_tokens: Option<u32>,
    stream: bool,
    /// 流式请求时开启 usage 返回
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_options: Option<StreamOptions>,
    /// OpenRouter 图像生成模态（如 ["image", "text"]）
    /// 前端传入 Gemini 格式 ["Text", "Image"]，build_request_body 中转为小写
    #[serde(skip_serializing_if = "Option::is_none")]
    modalities: Option<Vec<String>>,
    /// OpenRouter 图像生成配置（宽高比、分辨率等）
    #[serde(skip_serializing_if = "Option::is_none")]
    image_config: Option<OpenAIImageConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<OpenAIThinkingConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
}

#[derive(Debug, Serialize)]
struct OpenAIThinkingConfig {
    #[serde(rename = "type")]
    thinking_type: &'static str,
}

impl OpenAIThinkingConfig {
    fn new(enabled: bool) -> Self {
        Self {
            thinking_type: if enabled { "enabled" } else { "disabled" },
        }
    }
}

/// 流式请求选项
#[derive(Debug, Serialize)]
struct StreamOptions {
    include_usage: bool,
}

/// OpenRouter 图像生成配置（宽高比、分辨率等）
/// 前端使用 Gemini 通用的 ImageGenerationConfig，此结构体仅用于序列化为 OpenRouter 格式
#[derive(Debug, Serialize)]
struct OpenAIImageConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    aspect_ratio: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_size: Option<String>,
}

/// 请求中的消息（支持文本和多模态内容）
#[derive(Debug, Serialize)]
struct OpenAIRequestMessage {
    role: String,
    content: OpenAIMessageContent,
}

/// 消息内容类型（支持纯文本和多模态数组）
#[derive(Debug, Serialize)]
#[serde(untagged)]
enum OpenAIMessageContent {
    /// 纯文本内容
    Text(String),
    /// 多模态内容数组
    Parts(Vec<OpenAIContentPart>),
}

/// 多模态内容部分
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum OpenAIContentPart {
    /// 文本内容
    #[serde(rename = "text")]
    Text { text: String },
    /// 图片 URL（支持 base64 data URL）
    #[serde(rename = "image_url")]
    ImageUrl { image_url: OpenAIImageUrl },
}

/// 图片 URL 结构
#[derive(Debug, Serialize)]
struct OpenAIImageUrl {
    /// 图片 URL 或 data:image/xxx;base64,... 格式
    url: String,
    /// 图片处理精度："high" 保持原始分辨率分析，"low" 缩放到 512×512
    /// 桌面自动化截图等需要精确坐标的场景必须使用 "high"，
    /// 否则高 DPI 环境下模型只看到缩略图，坐标估算误差倍增
    detail: String,
}

/// 响应中的消息（content 可能为 null，例如 ZhipuAI 某些情况）
#[derive(Debug, Deserialize)]
struct OpenAIResponseMessage {
    #[allow(dead_code)]
    role: String,
    /// 某些 API（如 ZhipuAI）可能返回 null content
    content: Option<String>,
    /// OpenRouter 图像生成模型返回的图片数据
    #[serde(default)]
    images: Option<Vec<OpenRouterImageEntry>>,
}

#[derive(Debug, Deserialize)]
struct OpenAIResponse {
    model: String,
    choices: Vec<OpenAIChoice>,
    usage: Option<OpenAIUsage>,
}

#[derive(Debug, Deserialize)]
struct OpenAIChoice {
    message: OpenAIResponseMessage,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAIUsage {
    prompt_tokens: u32,
    completion_tokens: u32,
}

#[derive(Debug, Deserialize)]
struct OpenAIStreamChunk {
    choices: Vec<OpenAIStreamChoice>,
    /// 流式请求开启 include_usage 后，最终 chunk 包含 usage
    usage: Option<OpenAIUsage>,
}

#[derive(Debug, Deserialize)]
struct OpenAIStreamChoice {
    delta: OpenAIDelta,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAIDelta {
    #[serde(default)]
    content: Option<String>,
    /// OpenAI-compatible reasoning models such as DeepSeek return thought deltas here.
    #[serde(default)]
    reasoning_content: Option<String>,
    /// OpenRouter 图像生成模型返回的图片数据
    #[serde(default)]
    images: Option<Vec<OpenRouterImageEntry>>,
}

// ==================== OpenRouter 图像生成响应类型 ====================

/// OpenRouter 图像响应条目
/// 对应 OpenRouter API 文档中的 `images[].image_url.url` 结构
#[derive(Debug, Deserialize)]
struct OpenRouterImageEntry {
    image_url: OpenRouterImageUrl,
}

/// OpenRouter 图像 URL（包含 base64 data URL）
#[derive(Debug, Deserialize)]
struct OpenRouterImageUrl {
    url: String,
}

/// 将 OpenRouter 返回的图片条目转换为 markdown 图片语法
///
/// 与 Gemini adapter 的 inlineData → markdown 处理逻辑统一，
/// 前端 `extractBase64Images()` 使用同一套正则 `![...](data:...;base64,...)` 提取
fn openrouter_images_to_markdown(images: &[OpenRouterImageEntry]) -> String {
    images
        .iter()
        .map(|img| format!("![Generated Image]({})", img.image_url.url))
        .collect::<Vec<_>>()
        .join("")
}

// ==================== Function Calling 响应类型 ====================

/// Function Calling 响应中的 tool_call
#[derive(Debug, Deserialize)]
struct OpenAIToolCallInfo {
    /// 工具调用 ID（用于后续 tool 角色消息的关联）
    id: String,
    /// 调用的函数信息
    function: OpenAIFunctionInfo,
}

/// 函数调用信息
#[derive(Debug, Deserialize)]
struct OpenAIFunctionInfo {
    /// 函数名称
    name: String,
    /// 参数 JSON 字符串（需要二次解析）
    #[serde(default, deserialize_with = "deserialize_arguments_to_string")]
    arguments: String,
}

/// 带 tool_calls 的响应消息
#[derive(Debug, Deserialize)]
struct OpenAIToolResponseMessage {
    /// 文本内容（思考过程，tool_use 时可能存在）
    content: Option<String>,
    /// 工具调用列表
    tool_calls: Option<Vec<OpenAIToolCallInfo>>,
}

/// 带 tool_calls 的响应 choice
#[derive(Debug, Deserialize)]
struct OpenAIToolChoice {
    message: OpenAIToolResponseMessage,
    finish_reason: Option<String>,
}

/// 带 tool_calls 的 API 响应
#[derive(Debug, Deserialize)]
struct OpenAIToolResponse {
    choices: Vec<OpenAIToolChoice>,
}

// ==================== 流式 Function Calling 类型 ====================

/// 流式 SSE delta 中的 tool_call 增量
#[derive(Debug, Deserialize)]
struct OpenAIStreamToolCallDelta {
    index: usize,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<OpenAIStreamFunctionDelta>,
}

/// 流式函数调用增量（name 和 arguments 分片传输）
#[derive(Debug, Deserialize)]
struct OpenAIStreamFunctionDelta {
    #[serde(default)]
    name: Option<String>,
    /// arguments 增量片段，需逐 chunk 拼接成完整 JSON 字符串
    #[serde(default, deserialize_with = "deserialize_optional_arguments_to_string")]
    arguments: Option<String>,
}

/// 扩展的流式 delta（兼容 content + tool_calls 两种场景）
#[derive(Debug, Deserialize)]
struct OpenAIStreamDeltaWithTools {
    #[serde(default)]
    content: Option<String>,
    /// 思考内容增量（DeepSeek 思考模式专用，其他 API 不返回此字段，默认 None）
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<OpenAIStreamToolCallDelta>>,
}

/// 扩展的流式 choice（用于 tool_calls 场景）
#[derive(Debug, Deserialize)]
struct OpenAIStreamChoiceWithTools {
    delta: OpenAIStreamDeltaWithTools,
    finish_reason: Option<String>,
}

/// 扩展的流式 chunk（用于 tool_calls 场景）
#[derive(Debug, Deserialize)]
struct OpenAIStreamChunkWithTools {
    choices: Vec<OpenAIStreamChoiceWithTools>,
    /// 流式请求开启 include_usage 后，最终 chunk 包含 usage
    usage: Option<OpenAIUsage>,
}

fn responses_event_type(value: &serde_json::Value) -> Option<&str> {
    value.get("type").and_then(|v| v.as_str())
}

fn responses_event_string<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(|v| v.as_str())
}

fn responses_event_u32(value: &serde_json::Value, key: &str) -> Option<u32> {
    value
        .get(key)
        .and_then(|v| v.as_u64())
        .and_then(|v| u32::try_from(v).ok())
}

/// 提取 Responses API 工具调用流的结束原因。
///
/// `response.incomplete` 的具体原因位于 `response.incomplete_details.reason`；
/// 当兼容网关省略详情时回退为明确的 `incomplete`，避免截断信号丢失。
fn responses_tool_finish_reason(value: &serde_json::Value) -> Option<String> {
    let response = value.get("response");

    if responses_event_type(value) == Some("response.incomplete") {
        return response
            .and_then(|response| response.get("incomplete_details"))
            .and_then(|details| details.get("reason"))
            .and_then(|reason| reason.as_str())
            .map(str::to_string)
            .or_else(|| Some("incomplete".to_string()));
    }

    response
        .and_then(|response| response.get("status"))
        .and_then(|status| status.as_str())
        .map(str::to_string)
        .or_else(|| {
            (responses_event_type(value) == Some("response.completed"))
                .then(|| "completed".to_string())
        })
}

fn responses_usage_tokens(value: &serde_json::Value) -> (Option<u32>, Option<u32>) {
    let usage = value
        .get("response")
        .and_then(|response| response.get("usage"))
        .or_else(|| value.get("usage"));

    let input_tokens = usage
        .and_then(|u| u.get("input_tokens"))
        .and_then(|v| v.as_u64())
        .and_then(|v| u32::try_from(v).ok());
    let output_tokens = usage
        .and_then(|u| u.get("output_tokens"))
        .and_then(|v| v.as_u64())
        .and_then(|v| u32::try_from(v).ok());

    (input_tokens, output_tokens)
}

fn responses_error_message(value: &serde_json::Value) -> Option<String> {
    value
        .get("error")
        .and_then(|error| {
            error
                .get("message")
                .and_then(|message| message.as_str())
                .or_else(|| error.as_str())
        })
        .map(ToString::to_string)
        .or_else(|| {
            value
                .get("response")
                .and_then(|response| response.get("error"))
                .and_then(|error| error.get("message").and_then(|message| message.as_str()))
                .map(ToString::to_string)
        })
}

fn responses_collect_output_text(output: &serde_json::Value) -> String {
    let Some(items) = output.as_array() else {
        return String::new();
    };

    let mut text = String::new();
    for item in items {
        if item.get("type").and_then(|v| v.as_str()) != Some("message") {
            continue;
        }
        if let Some(content_items) = item.get("content").and_then(|v| v.as_array()) {
            for content_item in content_items {
                match content_item.get("type").and_then(|v| v.as_str()) {
                    Some("output_text") => {
                        if let Some(part) = content_item.get("text").and_then(|v| v.as_str()) {
                            text.push_str(part);
                        }
                    }
                    Some("refusal") => {
                        if let Some(part) = content_item.get("refusal").and_then(|v| v.as_str()) {
                            text.push_str(part);
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    text
}

fn responses_collect_reasoning_summary(output: &serde_json::Value) -> String {
    let Some(items) = output.as_array() else {
        return String::new();
    };

    let mut summary = String::new();
    for item in items {
        if item.get("type").and_then(|v| v.as_str()) != Some("reasoning") {
            continue;
        }
        if let Some(summary_items) = item.get("summary").and_then(|v| v.as_array()) {
            for summary_item in summary_items {
                if let Some(text) = summary_item.get("text").and_then(|v| v.as_str()) {
                    summary.push_str(text);
                }
            }
        }
    }

    summary
}

fn map_responses_stream_event(data: &str) -> AppResult<Option<StreamChunk>> {
    if data == "[DONE]" {
        return Ok(Some(StreamChunk {
            delta: String::new(),
            reasoning: None,
            done: true,
            finish_reason: Some("stop".to_string()),
            input_tokens: None,
            output_tokens: None,
        }));
    }

    let value: serde_json::Value = serde_json::from_str(data)
        .map_err(|e| AppError::LlmApi(format!("Failed to parse Responses stream event: {}", e)))?;

    match responses_event_type(&value) {
        Some("response.output_text.delta") | Some("response.refusal.delta") => {
            Ok(Some(StreamChunk {
                delta: responses_event_string(&value, "delta")
                    .unwrap_or_default()
                    .to_string(),
                reasoning: None,
                done: false,
                finish_reason: None,
                input_tokens: None,
                output_tokens: None,
            }))
        }
        Some("response.reasoning_summary_text.delta") | Some("response.reasoning_text.delta") => {
            Ok(Some(StreamChunk {
                delta: String::new(),
                reasoning: Some(
                    responses_event_string(&value, "delta")
                        .unwrap_or_default()
                        .to_string(),
                )
                .filter(|delta| !delta.is_empty()),
                done: false,
                finish_reason: None,
                input_tokens: None,
                output_tokens: None,
            }))
        }
        Some("response.completed") => {
            let (input_tokens, output_tokens) = responses_usage_tokens(&value);
            Ok(Some(StreamChunk {
                delta: String::new(),
                reasoning: None,
                done: true,
                finish_reason: Some("stop".to_string()),
                input_tokens,
                output_tokens,
            }))
        }
        Some("response.incomplete") => {
            let (input_tokens, output_tokens) = responses_usage_tokens(&value);
            Ok(Some(StreamChunk {
                delta: String::new(),
                reasoning: None,
                done: true,
                finish_reason: Some("incomplete".to_string()),
                input_tokens,
                output_tokens,
            }))
        }
        Some("response.failed") | Some("error") => Err(AppError::LlmApi(
            responses_error_message(&value)
                .unwrap_or_else(|| "Responses API stream failed".to_string()),
        )),
        _ => Ok(None),
    }
}

fn tool_call_delta_has_useful_progress(delta: &OpenAIStreamToolCallDelta) -> bool {
    delta.id.as_deref().map_or(false, |id| !id.is_empty())
        || delta.function.as_ref().map_or(false, |function| {
            function
                .name
                .as_deref()
                .map_or(false, |name| !name.is_empty())
                || function
                    .arguments
                    .as_deref()
                    .map_or(false, |arguments| !arguments.is_empty())
        })
}

// ==================== 流式 Tool Call 累积器 ====================

use std::collections::BTreeMap;

/// 流式 tool_call 累积器
///
/// 逐 SSE chunk 累积 tool_call 的 id / name / arguments 片段，
/// 流结束后一次性组装为完整的 ToolCall 列表。
/// 使用 BTreeMap 保证按 index 自然有序，无需额外排序依赖。
struct ToolCallAccumulator {
    /// 按 tool_call index 存储: (id, name, arguments_buffer)
    calls: BTreeMap<usize, (String, String, String)>,
    /// 按 tool_call index 存储上一次已上报的 arguments 字节数
    last_progress_bytes: BTreeMap<usize, usize>,
    /// 流式接收 tool_call arguments 时的轻量进度回调
    progress_callback: Option<ToolCallProgressCallback>,
}

impl ToolCallAccumulator {
    #[cfg(test)]
    fn new() -> Self {
        Self::with_progress(None)
    }

    fn with_progress(progress_callback: Option<ToolCallProgressCallback>) -> Self {
        Self {
            calls: BTreeMap::new(),
            last_progress_bytes: BTreeMap::new(),
            progress_callback,
        }
    }

    /// 累积一个 tool_call delta 片段
    fn accumulate(&mut self, delta: OpenAIStreamToolCallDelta) {
        let index = delta.index;
        let entry = self
            .calls
            .entry(delta.index)
            .or_insert_with(|| (String::new(), String::new(), String::new()));
        if let Some(id) = delta.id {
            entry.0 = id;
        }
        if let Some(ref func) = delta.function {
            // 只在 name 非空时才更新：
            // GPT（通过 sub2api Responses API 路径）会在第 2 个 chunk 里把 name 设为空字符串 ""，
            // 若不跳过，会把第 1 个 chunk 写入的正确工具名（如 "exec"）覆盖为 ""。
            if let Some(ref name) = func.name {
                if !name.is_empty() {
                    entry.1 = name.clone();
                }
            }
            if let Some(ref args) = func.arguments {
                entry.2.push_str(args);
            }
        }
        self.emit_progress_if_needed(index);
    }

    fn emit_progress_if_needed(&mut self, index: usize) {
        let Some(callback) = &self.progress_callback else {
            return;
        };

        let Some((_, name, args)) = self.calls.get(&index) else {
            return;
        };
        if name != "file_write" {
            return;
        }

        let arg_bytes = args.len();
        if arg_bytes < TOOL_CALL_PROGRESS_MIN_BYTES {
            return;
        }

        let last_reported = self.last_progress_bytes.get(&index).copied().unwrap_or(0);
        if last_reported > 0
            && arg_bytes.saturating_sub(last_reported) < TOOL_CALL_PROGRESS_STEP_BYTES
        {
            return;
        }

        self.last_progress_bytes.insert(index, arg_bytes);
        callback(ToolCallStreamProgress {
            index,
            tool_name: name.clone(),
            arg_bytes,
        });
    }

    /// 流结束后，将累积的 arguments 字符串解析为 JSON，组装完整 ToolCall
    fn finalize(self) -> Vec<super::types::ToolCall> {
        self.calls.into_iter()
            .map(|(_, (id, name, args_str))| {
                // 容错：arguments 解析失败时尝试修复，不可恢复时回退为空对象
                let args = serde_json::from_str(&args_str)
                    .unwrap_or_else(|e: serde_json::Error| {
                        log::warn!(
                            "[OpenAIAdapter] ⚠️ 流式 tool_call args 解析失败 (tool: {}): {} | args_len: {} | 前200字符: {}",
                            name, e, args_str.len(),
                            safe_truncate(&args_str, 200)
                        );
                        super::json_repair::repair_tool_call_json(&args_str)
                            .unwrap_or_else(|| {
                                log::warn!("[OpenAIAdapter] 流式 JSON 修复也失败，回退为空对象");
                                serde_json::json!({})
                            })
                    });
                super::types::ToolCall {
                    name,
                    args,
                    id: if id.is_empty() { None } else { Some(id) },
                    thought_signature: None,
                }
            })
            .collect()
    }

    fn is_empty(&self) -> bool {
        self.calls.is_empty()
    }
}

// ==================== Responses Tool Call Accumulator ====================

#[derive(Default)]
struct ResponsesFunctionCallAccum {
    item_id: String,
    call_id: String,
    name: String,
    arguments: String,
}

struct ResponsesToolCallAccumulator {
    calls: BTreeMap<usize, ResponsesFunctionCallAccum>,
    last_progress_bytes: BTreeMap<usize, usize>,
    progress_callback: Option<ToolCallProgressCallback>,
}

impl ResponsesToolCallAccumulator {
    #[cfg(test)]
    fn new() -> Self {
        Self::with_progress(None)
    }

    fn with_progress(progress_callback: Option<ToolCallProgressCallback>) -> Self {
        Self {
            calls: BTreeMap::new(),
            last_progress_bytes: BTreeMap::new(),
            progress_callback,
        }
    }

    fn is_empty(&self) -> bool {
        self.calls.is_empty()
    }

    fn update_from_item(&mut self, output_index: usize, item: &serde_json::Value) {
        if item.get("type").and_then(|v| v.as_str()) != Some("function_call") {
            return;
        }

        let entry = self.calls.entry(output_index).or_default();
        if let Some(item_id) = item.get("id").and_then(|v| v.as_str()) {
            if !item_id.is_empty() {
                entry.item_id = item_id.to_string();
            }
        }
        if let Some(call_id) = item.get("call_id").and_then(|v| v.as_str()) {
            if !call_id.is_empty() {
                entry.call_id = call_id.to_string();
            }
        }
        if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
            if !name.is_empty() {
                entry.name = name.to_string();
            }
        }
        if let Some(arguments) = item.get("arguments").and_then(|v| v.as_str()) {
            if !arguments.is_empty() {
                entry.arguments = arguments.to_string();
            }
        }
        self.emit_progress_if_needed(output_index);
    }

    fn accumulate_arguments_delta(&mut self, output_index: usize, item_id: &str, delta: &str) {
        let entry = self.calls.entry(output_index).or_default();
        if !item_id.is_empty() {
            entry.item_id = item_id.to_string();
        }
        entry.arguments.push_str(delta);
        self.emit_progress_if_needed(output_index);
    }

    fn finish_arguments(
        &mut self,
        output_index: usize,
        item_id: &str,
        name: &str,
        arguments: &str,
    ) {
        let entry = self.calls.entry(output_index).or_default();
        if !item_id.is_empty() {
            entry.item_id = item_id.to_string();
        }
        if !name.is_empty() {
            entry.name = name.to_string();
        }
        if !arguments.is_empty() {
            entry.arguments = arguments.to_string();
        }
        self.emit_progress_if_needed(output_index);
    }

    fn update_from_output_array(&mut self, output: &serde_json::Value) {
        if let Some(items) = output.as_array() {
            for (index, item) in items.iter().enumerate() {
                self.update_from_item(index, item);
            }
        }
    }

    fn emit_progress_if_needed(&mut self, index: usize) {
        let Some(callback) = &self.progress_callback else {
            return;
        };

        let Some(call) = self.calls.get(&index) else {
            return;
        };
        if call.name != "file_write" {
            return;
        }

        let arg_bytes = call.arguments.len();
        if arg_bytes < TOOL_CALL_PROGRESS_MIN_BYTES {
            return;
        }

        let last_reported = self.last_progress_bytes.get(&index).copied().unwrap_or(0);
        if last_reported > 0
            && arg_bytes.saturating_sub(last_reported) < TOOL_CALL_PROGRESS_STEP_BYTES
        {
            return;
        }

        self.last_progress_bytes.insert(index, arg_bytes);
        callback(ToolCallStreamProgress {
            index,
            tool_name: call.name.clone(),
            arg_bytes,
        });
    }

    fn finalize(self) -> Vec<super::types::ToolCall> {
        self.calls
            .into_iter()
            .filter_map(|(_, call)| {
                if call.name.is_empty() {
                    return None;
                }

                let args = serde_json::from_str(&call.arguments).unwrap_or_else(|e| {
                    log::warn!(
                        "[OpenAIAdapter] Responses function_call args parse failed (tool: {}): {} | args_len: {} | preview: {}",
                        call.name,
                        e,
                        call.arguments.len(),
                        safe_truncate(&call.arguments, 200)
                    );
                    super::json_repair::repair_tool_call_json(&call.arguments).unwrap_or_else(|| {
                        log::warn!(
                            "[OpenAIAdapter] Responses function_call JSON repair failed; using empty object"
                        );
                        serde_json::json!({})
                    })
                });

                let id = if !call.call_id.is_empty() {
                    Some(call.call_id)
                } else if !call.item_id.is_empty() {
                    Some(call.item_id)
                } else {
                    None
                };

                Some(super::types::ToolCall {
                    name: call.name,
                    args,
                    id,
                    thought_signature: None,
                })
            })
            .collect()
    }
}

// ==================== 单元测试 ====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::types::{ToolChatMessage, ToolChatRequest, ToolChatRole};
    use crate::llm::{ReasoningPreset, ReasoningRoute};

    fn tool_request(model: &str, preset: Option<ReasoningPreset>) -> ToolChatRequest {
        ToolChatRequest {
            messages: vec![ToolChatMessage {
                role: ToolChatRole::User,
                content: "Hi".to_string(),
                images: None,
                tool_calls: None,
                tool_call_id: None,
                tool_name: None,
                reasoning_content: None,
            }],
            model_id: Some(model.to_string()),
            provider_id: None,
            supports_vision: None,
            tools: None,
            temperature: Some(0.7),
            max_tokens: Some(456),
            reasoning_preset: preset,
            base_url: None,
        }
    }

    #[test]
    fn test_tool_parameters_schema_removes_top_level_composition_keywords() {
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

        let normalized = build_openai_tool_parameters_schema("file_write", &schema);

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
    fn test_native_openai_gpt5_uses_max_completion_tokens() {
        let adapter = OpenAIAdapter::new(ProviderConfig::new("test-key").with_model("gpt-5.4"));
        let request = ChatRequest {
            messages: vec![ChatMessage::user("Hi")],
            max_tokens: Some(123),
            ..Default::default()
        };

        let body = serde_json::to_value(adapter.build_request_body(&request)).unwrap();

        assert_eq!(body["max_completion_tokens"], serde_json::json!(123));
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn test_custom_openai_compatible_endpoint_keeps_max_tokens() {
        let adapter = OpenAIAdapter::new(
            ProviderConfig::new("test-key")
                .with_base_url("http://127.0.0.1:8050/v1")
                .with_model("gpt-5.4"),
        );
        let request = ChatRequest {
            messages: vec![ChatMessage::user("Hi")],
            max_tokens: Some(123),
            ..Default::default()
        };

        let body = serde_json::to_value(adapter.build_request_body(&request)).unwrap();

        assert_eq!(body["max_tokens"], serde_json::json!(123));
        assert!(body.get("max_completion_tokens").is_none());
    }

    #[test]
    fn test_native_openai_gpt5_responses_request_enables_reasoning_summary() {
        let adapter = OpenAIAdapter::new(ProviderConfig::new("test-key").with_model("gpt-5.4"));
        let request = ChatRequest {
            messages: vec![ChatMessage::user("Hi")],
            max_tokens: Some(123),
            stream: true,
            ..Default::default()
        };

        assert!(adapter.should_use_responses_reasoning("gpt-5.4"));

        let body = adapter.build_responses_chat_request_body(&request);

        assert_eq!(body["model"], serde_json::json!("gpt-5.4"));
        assert_eq!(body["max_output_tokens"], serde_json::json!(123));
        assert_eq!(body["reasoning"]["effort"], serde_json::json!("medium"));
        assert_eq!(body["reasoning"]["summary"], serde_json::json!("auto"));
    }

    #[test]
    fn native_openai_responses_uses_verified_requested_effort() {
        let adapter = OpenAIAdapter::new(ProviderConfig::new("test-key"));
        let gpt_55 = ChatRequest {
            messages: vec![ChatMessage::user("Hi")],
            model: Some("gpt-5.5".to_string()),
            reasoning_preset: Some(ReasoningPreset::Max),
            ..Default::default()
        };
        let gpt_54_minimal = ChatRequest {
            model: Some("gpt-5.4".to_string()),
            reasoning_preset: Some(ReasoningPreset::Minimal),
            ..gpt_55.clone()
        };
        let gpt_54_xhigh = ChatRequest {
            reasoning_preset: Some(ReasoningPreset::Xhigh),
            ..gpt_54_minimal.clone()
        };
        let gpt_56_max = ChatRequest {
            model: Some("gpt-5.6-sol".to_string()),
            reasoning_preset: Some(ReasoningPreset::Max),
            ..gpt_55.clone()
        };

        let gpt_55_body = adapter.build_responses_chat_request_body(&gpt_55);
        let gpt_54_minimal_body = adapter.build_responses_chat_request_body(&gpt_54_minimal);
        let gpt_54_xhigh_body = adapter.build_responses_chat_request_body(&gpt_54_xhigh);
        let gpt_56_max_body = adapter.build_responses_chat_request_body(&gpt_56_max);

        assert_eq!(gpt_55_body["reasoning"]["effort"], "xhigh");
        assert_eq!(gpt_54_minimal_body["reasoning"]["effort"], "low");
        assert_eq!(gpt_54_xhigh_body["reasoning"]["effort"], "xhigh");
        assert_eq!(gpt_56_max_body["reasoning"]["effort"], "max");
    }

    #[test]
    fn native_openai_chat_builders_only_emit_explicit_requested_effort() {
        let adapter = OpenAIAdapter::new(ProviderConfig::new("test-key"));
        let explicit = ChatRequest {
            messages: vec![ChatMessage::user("Hi")],
            model: Some("gpt-5.4-mini".to_string()),
            reasoning_preset: Some(ReasoningPreset::High),
            ..Default::default()
        };
        let recommended = ChatRequest {
            reasoning_preset: Some(ReasoningPreset::Recommended),
            ..explicit.clone()
        };
        let gpt_56 = ChatRequest {
            model: Some("gpt-5.6-luna".to_string()),
            reasoning_preset: Some(ReasoningPreset::High),
            ..explicit.clone()
        };
        let unverified = ChatRequest {
            model: Some("gpt-5.7".to_string()),
            ..gpt_56.clone()
        };

        let explicit_body = serde_json::to_value(adapter.build_request_body(&explicit)).unwrap();
        let recommended_body =
            serde_json::to_value(adapter.build_request_body(&recommended)).unwrap();
        let gpt_56_body = serde_json::to_value(adapter.build_request_body(&gpt_56)).unwrap();
        let unverified_body =
            serde_json::to_value(adapter.build_request_body(&unverified)).unwrap();
        let unverified_responses_body = adapter.build_responses_chat_request_body(&unverified);
        let (tool_body, _, _) =
            adapter.build_tool_request_body(&tool_request("gpt-5.5", Some(ReasoningPreset::Xhigh)));

        assert_eq!(explicit_body["reasoning_effort"], "high");
        assert!(recommended_body.get("reasoning_effort").is_none());
        assert_eq!(gpt_56_body["reasoning_effort"], "high");
        assert!(unverified_body.get("reasoning_effort").is_none());
        assert_eq!(unverified_responses_body["reasoning"]["effort"], "medium");
        assert_eq!(tool_body["reasoning_effort"], "xhigh");
        assert!(tool_body.get("thinking").is_none());
    }

    #[test]
    fn compatible_reasoning_profiles_apply_to_plain_and_tool_bodies() {
        let adapter = OpenAIAdapter::new(
            ProviderConfig::new("test-key")
                .with_base_url("https://api.deepseek.com")
                .with_reasoning_route(ReasoningRoute::DeepSeekChat),
        );
        let plain_request = ChatRequest {
            messages: vec![ChatMessage::user("Hi")],
            model: Some("deepseek-v4-pro".to_string()),
            reasoning_preset: Some(ReasoningPreset::Max),
            ..Default::default()
        };

        let plain_body = serde_json::to_value(adapter.build_request_body(&plain_request)).unwrap();
        let disabled_request = ChatRequest {
            reasoning_preset: Some(ReasoningPreset::None),
            ..plain_request.clone()
        };
        let disabled_body =
            serde_json::to_value(adapter.build_request_body(&disabled_request)).unwrap();
        let (tool_body, _, _) = adapter.build_tool_request_body(&tool_request(
            "deepseek-v4-flash",
            Some(ReasoningPreset::High),
        ));
        let (disabled_tool_body, _, _) = adapter.build_tool_request_body(&tool_request(
            "deepseek-v4-flash",
            Some(ReasoningPreset::None),
        ));

        assert_eq!(plain_body["thinking"]["type"], "enabled");
        assert_eq!(plain_body["reasoning_effort"], "max");
        assert_eq!(disabled_body["thinking"]["type"], "disabled");
        assert!(disabled_body.get("reasoning_effort").is_none());
        assert_eq!(tool_body["thinking"]["type"], "enabled");
        assert_eq!(tool_body["reasoning_effort"], "high");
        assert_eq!(disabled_tool_body["thinking"]["type"], "disabled");
        assert!(disabled_tool_body.get("reasoning_effort").is_none());
    }

    #[test]
    fn stepfun_chat_emits_only_its_three_verified_effort_levels() {
        let adapter = OpenAIAdapter::new(
            ProviderConfig::new("test-key")
                .with_base_url("https://api.stepfun.com/step_plan/v1")
                .with_reasoning_route(ReasoningRoute::StepFunChat),
        );
        let plain_request = ChatRequest {
            messages: vec![ChatMessage::user("Hi")],
            model: Some("step-3.7-flash".to_string()),
            reasoning_preset: Some(ReasoningPreset::Medium),
            ..Default::default()
        };

        let plain_body = serde_json::to_value(adapter.build_request_body(&plain_request)).unwrap();
        let (tool_body, _, _) = adapter
            .build_tool_request_body(&tool_request("step-3.7-flash", Some(ReasoningPreset::Max)));

        assert_eq!(plain_body["reasoning_effort"], "medium");
        assert!(plain_body.get("thinking").is_none());
        assert_eq!(tool_body["reasoning_effort"], "high");
        assert!(tool_body.get("thinking").is_none());
    }

    #[test]
    fn zhipu_effort_and_toggle_models_emit_only_verified_fields() {
        let adapter = OpenAIAdapter::new(
            ProviderConfig::new("test-key")
                .with_base_url("https://open.bigmodel.cn/api/paas/v4")
                .with_reasoning_route(ReasoningRoute::ZhipuChat),
        );
        let glm_51 = ChatRequest {
            messages: vec![ChatMessage::user("Hi")],
            model: Some("GLM-5.1".to_string()),
            reasoning_preset: Some(ReasoningPreset::None),
            ..Default::default()
        };
        let glm_52 = ChatRequest {
            messages: vec![ChatMessage::user("Hi")],
            model: Some("glm-5.2".to_string()),
            reasoning_preset: Some(ReasoningPreset::Xhigh),
            ..Default::default()
        };

        let glm_51_body = serde_json::to_value(adapter.build_request_body(&glm_51)).unwrap();
        let glm_52_body = serde_json::to_value(adapter.build_request_body(&glm_52)).unwrap();

        assert_eq!(glm_51_body["thinking"]["type"], "disabled");
        assert!(glm_51_body.get("reasoning_effort").is_none());
        assert_eq!(glm_52_body["thinking"]["type"], "enabled");
        assert_eq!(glm_52_body["reasoning_effort"], "max");
    }

    #[test]
    fn mimo_chat_maps_semantic_effort_to_a_thinking_toggle() {
        let adapter = OpenAIAdapter::new(
            ProviderConfig::new("test-key")
                .with_base_url("https://token-plan-cn.xiaomimimo.com/v1")
                .with_reasoning_route(ReasoningRoute::MimoChat),
        );
        let enabled = ChatRequest {
            messages: vec![ChatMessage::user("Hi")],
            model: Some("mimo-v2.5-pro".to_string()),
            reasoning_preset: Some(ReasoningPreset::High),
            ..Default::default()
        };
        let disabled = ChatRequest {
            reasoning_preset: Some(ReasoningPreset::None),
            ..enabled.clone()
        };

        let enabled_body = serde_json::to_value(adapter.build_request_body(&enabled)).unwrap();
        let disabled_body = serde_json::to_value(adapter.build_request_body(&disabled)).unwrap();

        assert_eq!(enabled_body["thinking"]["type"], "enabled");
        assert_eq!(disabled_body["thinking"]["type"], "disabled");
        assert!(enabled_body.get("reasoning_effort").is_none());
    }

    #[test]
    fn unknown_compatible_routes_never_leak_reasoning_parameters() {
        for (base_url, model) in [
            ("https://openrouter.ai/api/v1", "openai/gpt-5.5"),
            ("http://127.0.0.1:8050/v1", "glm-5.2"),
            (
                "https://ark.cn-beijing.volces.com/api/coding/v3",
                "deepseek-v4-pro",
            ),
            ("https://api.stepfun.com/step_plan/v1", "step-3.7-flash"),
            ("https://apihub.agnes-ai.com/v1", "agnes-2.0-flash"),
            ("https://open.bigmodel.cn/api/coding/paas/v4", "GLM-5.2"),
        ] {
            let adapter = OpenAIAdapter::new(
                ProviderConfig::new("test-key")
                    .with_base_url(base_url)
                    .with_reasoning_route(ReasoningRoute::Unknown),
            );
            let request = ChatRequest {
                messages: vec![ChatMessage::user("Hi")],
                model: Some(model.to_string()),
                reasoning_preset: Some(ReasoningPreset::Max),
                ..Default::default()
            };

            let body = serde_json::to_value(adapter.build_request_body(&request)).unwrap();

            assert!(body.get("thinking").is_none(), "base_url={base_url}");
            assert!(
                body.get("reasoning_effort").is_none(),
                "base_url={base_url}"
            );
        }
    }

    #[test]
    fn test_custom_gpt5_endpoint_does_not_use_responses_reasoning_path() {
        let adapter = OpenAIAdapter::new(
            ProviderConfig::new("test-key")
                .with_base_url("http://127.0.0.1:8050/v1")
                .with_model("gpt-5.4"),
        );

        assert!(!adapter.should_use_responses_reasoning("gpt-5.4"));
    }

    #[test]
    fn test_responses_stream_reasoning_summary_delta_maps_to_stream_reasoning() {
        let data = r#"{
            "type": "response.reasoning_summary_text.delta",
            "delta": "Thinking through the task"
        }"#;

        let chunk = map_responses_stream_event(data).unwrap().unwrap();

        assert_eq!(chunk.delta, "");
        assert_eq!(
            chunk.reasoning.as_deref(),
            Some("Thinking through the task")
        );
        assert!(!chunk.done);
    }

    #[test]
    fn test_responses_tool_finish_reason_preserves_incomplete_detail() {
        let event = serde_json::json!({
            "type": "response.incomplete",
            "response": {
                "status": "incomplete",
                "incomplete_details": {
                    "reason": "max_output_tokens"
                }
            }
        });

        assert_eq!(
            responses_tool_finish_reason(&event).as_deref(),
            Some("max_output_tokens")
        );
    }

    #[test]
    fn test_responses_tool_finish_reason_falls_back_to_incomplete() {
        let event = serde_json::json!({
            "type": "response.incomplete",
            "response": { "status": "incomplete" }
        });

        assert_eq!(
            responses_tool_finish_reason(&event).as_deref(),
            Some("incomplete")
        );
    }

    #[test]
    fn test_non_stream_tool_response_preserves_length_finish_reason() {
        let choice: OpenAIToolChoice = serde_json::from_value(serde_json::json!({
            "message": {
                "content": null,
                "tool_calls": [{
                    "id": "call_123",
                    "function": {
                        "name": "file_write",
                        "arguments": { "path": "index.html", "content": "<html>" }
                    }
                }]
            },
            "finish_reason": "length"
        }))
        .expect("parse tool response choice");

        let response =
            OpenAIAdapter::extract_tool_response(&choice).expect("extract tool response");

        assert_eq!(response.finish_reason.as_deref(), Some("length"));
    }

    #[test]
    fn test_responses_tool_accumulator_preserves_call_id() {
        let mut acc = ResponsesToolCallAccumulator::new();
        acc.update_from_item(
            0,
            &serde_json::json!({
                "type": "function_call",
                "id": "fc_123",
                "call_id": "call_123",
                "name": "file_write",
                "arguments": ""
            }),
        );
        acc.accumulate_arguments_delta(0, "fc_123", "{\"path\":\"test.md\"");
        acc.finish_arguments(
            0,
            "fc_123",
            "file_write",
            "{\"path\":\"test.md\",\"content\":\"hello\"}",
        );

        let calls = acc.finalize();

        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "file_write");
        assert_eq!(calls[0].id.as_deref(), Some("call_123"));
        assert_eq!(calls[0].args["path"], "test.md");
        assert_eq!(calls[0].args["content"], "hello");
    }

    #[test]
    fn test_native_openai_tool_request_uses_max_completion_tokens() {
        let adapter = OpenAIAdapter::new(ProviderConfig::new("test-key"));
        let request = ToolChatRequest {
            messages: vec![ToolChatMessage {
                role: ToolChatRole::User,
                content: "Hi".to_string(),
                images: None,
                tool_calls: None,
                tool_call_id: None,
                tool_name: None,
                reasoning_content: None,
            }],
            model_id: Some("gpt-5.4".to_string()),
            provider_id: Some("openai".to_string()),
            supports_vision: None,
            tools: None,
            temperature: None,
            max_tokens: Some(456),
            reasoning_preset: None,
            base_url: None,
        };

        let (body, _, _) = adapter.build_tool_request_body(&request);

        assert_eq!(body["max_completion_tokens"], serde_json::json!(456));
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn test_accumulator_malformed_unicode_args_do_not_panic() {
        let mut acc = ToolCallAccumulator::new();
        let mut args = "x".repeat(198);
        args.push('的');
        args.push_str(" malformed");

        acc.accumulate(OpenAIStreamToolCallDelta {
            index: 0,
            id: Some("call_unicode".to_string()),
            function: Some(OpenAIStreamFunctionDelta {
                name: Some("agnes-video".to_string()),
                arguments: Some(args),
            }),
        });

        let calls = acc.finalize();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "agnes-video");
        assert_eq!(calls[0].id, Some("call_unicode".to_string()));
    }

    /// 单工具调用：多个 chunk 拼接成完整 arguments
    #[test]
    fn test_accumulator_single_tool_call() {
        let mut acc = ToolCallAccumulator::new();

        // chunk 1: 声明 tool_call 开始
        acc.accumulate(OpenAIStreamToolCallDelta {
            index: 0,
            id: Some("call_abc".to_string()),
            function: Some(OpenAIStreamFunctionDelta {
                name: Some("file_write".to_string()),
                arguments: Some(String::new()),
            }),
        });

        // chunk 2-3: arguments 增量
        acc.accumulate(OpenAIStreamToolCallDelta {
            index: 0,
            id: None,
            function: Some(OpenAIStreamFunctionDelta {
                name: None,
                arguments: Some("{\"path\": \"test.js\"".to_string()),
            }),
        });
        acc.accumulate(OpenAIStreamToolCallDelta {
            index: 0,
            id: None,
            function: Some(OpenAIStreamFunctionDelta {
                name: None,
                arguments: Some(", \"content\": \"hello\"}".to_string()),
            }),
        });

        let calls = acc.finalize();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "file_write");
        assert_eq!(calls[0].id, Some("call_abc".to_string()));
        assert_eq!(calls[0].args["path"], "test.js");
        assert_eq!(calls[0].args["content"], "hello");
    }

    /// Some OpenAI-compatible providers return function.arguments as a JSON object
    /// instead of the OpenAI-standard JSON string. Keep those chunks parseable.
    #[test]
    fn test_stream_chunk_accepts_object_arguments() {
        let data = r#"{
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_obj",
                        "function": {
                            "name": "file_write",
                            "arguments": {
                                "path": "test.md",
                                "content": "hello"
                            }
                        }
                    }]
                },
                "finish_reason": null
            }],
            "usage": null
        }"#;

        let chunk: OpenAIStreamChunkWithTools = serde_json::from_str(data).unwrap();
        let mut acc = ToolCallAccumulator::new();
        let tool_delta = &chunk.choices[0].delta.tool_calls.as_ref().unwrap()[0];
        acc.accumulate(OpenAIStreamToolCallDelta {
            index: tool_delta.index,
            id: tool_delta.id.clone(),
            function: tool_delta
                .function
                .as_ref()
                .map(|f| OpenAIStreamFunctionDelta {
                    name: f.name.clone(),
                    arguments: f.arguments.clone(),
                }),
        });

        let calls = acc.finalize();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "file_write");
        assert_eq!(calls[0].args["path"], "test.md");
        assert_eq!(calls[0].args["content"], "hello");
    }

    #[test]
    fn test_stream_tool_chunk_preserves_length_finish_reason() {
        let data = r#"{
            "choices": [{
                "delta": {},
                "finish_reason": "length"
            }],
            "usage": null
        }"#;

        let chunk: OpenAIStreamChunkWithTools = serde_json::from_str(data).unwrap();

        assert_eq!(chunk.choices[0].finish_reason.as_deref(), Some("length"));
    }

    #[test]
    fn test_plain_stream_chunk_accepts_reasoning_content() {
        let data = r#"{
            "choices": [{
                "delta": {
                    "content": null,
                    "reasoning_content": "Thinking through the task"
                },
                "finish_reason": null
            }],
            "usage": null
        }"#;

        let chunk: OpenAIStreamChunk = serde_json::from_str(data).unwrap();
        assert_eq!(
            chunk.choices[0].delta.reasoning_content.as_deref(),
            Some("Thinking through the task")
        );
    }

    #[test]
    fn test_non_stream_tool_call_accepts_object_arguments() {
        let data = r#"{
            "id": "call_obj",
            "function": {
                "name": "file_write",
                "arguments": {
                    "path": "test.md",
                    "content": "hello"
                }
            }
        }"#;

        let tool_call: OpenAIToolCallInfo = serde_json::from_str(data).unwrap();
        let args: serde_json::Value = serde_json::from_str(&tool_call.function.arguments).unwrap();
        assert_eq!(args["path"], "test.md");
        assert_eq!(args["content"], "hello");
    }

    /// 多工具并行调用（不同 index 交错到达）
    #[test]
    fn test_accumulator_parallel_tool_calls() {
        let mut acc = ToolCallAccumulator::new();

        // tool 0 开始
        acc.accumulate(OpenAIStreamToolCallDelta {
            index: 0,
            id: Some("call_1".to_string()),
            function: Some(OpenAIStreamFunctionDelta {
                name: Some("exec".to_string()),
                arguments: Some(String::new()),
            }),
        });
        // tool 1 开始
        acc.accumulate(OpenAIStreamToolCallDelta {
            index: 1,
            id: Some("call_2".to_string()),
            function: Some(OpenAIStreamFunctionDelta {
                name: Some("read".to_string()),
                arguments: Some(String::new()),
            }),
        });
        // tool 0 arguments
        acc.accumulate(OpenAIStreamToolCallDelta {
            index: 0,
            id: None,
            function: Some(OpenAIStreamFunctionDelta {
                name: None,
                arguments: Some("{\"command\": \"ls\"}".to_string()),
            }),
        });
        // tool 1 arguments
        acc.accumulate(OpenAIStreamToolCallDelta {
            index: 1,
            id: None,
            function: Some(OpenAIStreamFunctionDelta {
                name: None,
                arguments: Some("{\"path\": \"/tmp\"}".to_string()),
            }),
        });

        let calls = acc.finalize();
        assert_eq!(calls.len(), 2);
        // BTreeMap 保证 index 顺序
        assert_eq!(calls[0].name, "exec");
        assert_eq!(calls[1].name, "read");
    }

    /// arguments 含 JSON 嵌套和转义引号
    #[test]
    fn test_accumulator_special_characters() {
        let mut acc = ToolCallAccumulator::new();

        acc.accumulate(OpenAIStreamToolCallDelta {
            index: 0,
            id: Some("call_x".to_string()),
            function: Some(OpenAIStreamFunctionDelta {
                name: Some("file_write".to_string()),
                arguments: Some(String::new()),
            }),
        });
        // 含转义引号和换行的 JS 代码
        let content = r#"{"path":"app.js","content":"const x = \"hello\";\nconsole.log(x);"}"#;
        acc.accumulate(OpenAIStreamToolCallDelta {
            index: 0,
            id: None,
            function: Some(OpenAIStreamFunctionDelta {
                name: None,
                arguments: Some(content.to_string()),
            }),
        });

        let calls = acc.finalize();
        assert_eq!(calls[0].args["path"], "app.js");
        assert!(calls[0].args["content"].as_str().unwrap().contains("hello"));
    }

    /// 空 arguments 应回退为空 JSON 对象
    #[test]
    fn test_accumulator_empty_arguments() {
        let mut acc = ToolCallAccumulator::new();

        acc.accumulate(OpenAIStreamToolCallDelta {
            index: 0,
            id: Some("call_empty".to_string()),
            function: Some(OpenAIStreamFunctionDelta {
                name: Some("noop".to_string()),
                arguments: None,
            }),
        });

        let calls = acc.finalize();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].args, serde_json::json!({}));
    }

    /// 超大 arguments（模拟 800 行 JS 代码的 file_write）
    #[test]
    fn test_accumulator_large_arguments() {
        let mut acc = ToolCallAccumulator::new();

        acc.accumulate(OpenAIStreamToolCallDelta {
            index: 0,
            id: Some("call_large".to_string()),
            function: Some(OpenAIStreamFunctionDelta {
                name: Some("file_write".to_string()),
                arguments: Some("{\"path\":\"big.js\",\"content\":\"".to_string()),
            }),
        });

        // 模拟 800 行代码分 100 个 chunk 到达
        let line = "const x = 1; // line\\n";
        for _ in 0..100 {
            let chunk: String = (0..8).map(|_| line).collect();
            acc.accumulate(OpenAIStreamToolCallDelta {
                index: 0,
                id: None,
                function: Some(OpenAIStreamFunctionDelta {
                    name: None,
                    arguments: Some(chunk),
                }),
            });
        }

        acc.accumulate(OpenAIStreamToolCallDelta {
            index: 0,
            id: None,
            function: Some(OpenAIStreamFunctionDelta {
                name: None,
                arguments: Some("\"}".to_string()),
            }),
        });

        let calls = acc.finalize();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "file_write");
        // 验证大内容完整性：800 行 × 21 字符
        let content = calls[0].args["content"].as_str().unwrap();
        assert!(
            content.len() > 16000,
            "内容应超过 16KB，实际: {}",
            content.len()
        );
    }
}
