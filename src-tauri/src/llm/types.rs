//! LLM 类型定义
//!
//! 定义 LLM 请求和响应的通用类型

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

/// serde 默认值辅助：返回 true（用于 supports_vision 等默认启用的布尔字段）
fn default_true() -> bool { true }

/// 流式工具调用参数接收进度（不包含参数正文）
#[derive(Debug, Clone)]
pub struct ToolCallStreamProgress {
    pub index: usize,
    pub tool_name: String,
    pub arg_bytes: usize,
}

/// LLM Adapter 在流式接收 tool_call arguments 时上报轻量进度
pub type ToolCallProgressCallback = Arc<dyn Fn(ToolCallStreamProgress) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct ReasoningTraceProgress {
    pub delta: String,
    pub done: bool,
}

pub type ReasoningTraceCallback = Arc<dyn Fn(ReasoningTraceProgress) + Send + Sync>;

/// 工具参数进度首次上报阈值
pub const TOOL_CALL_PROGRESS_MIN_BYTES: usize = 4 * 1024;
/// 工具参数进度节流步长
pub const TOOL_CALL_PROGRESS_STEP_BYTES: usize = 8 * 1024;

/// 聊天消息角色
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    System,
    User,
    Assistant,
}

impl ChatRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            ChatRole::System => "system",
            ChatRole::User => "user", 
            ChatRole::Assistant => "assistant",
        }
    }
}

/// 聊天消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
    /// 图片附件（多模态支持）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<ImageAttachment>>,
}

/// 图片附件（多模态支持）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    /// MIME 类型，如 "image/jpeg", "image/png", "image/webp"
    pub mime_type: String,
    /// Base64 编码的图片数据
    pub data: String,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::System,
            content: content.into(),
            images: None,
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::User,
            content: content.into(),
            images: None,
        }
    }

    /// 创建带图片的用户消息
    pub fn user_with_images(content: impl Into<String>, images: Vec<ImageAttachment>) -> Self {
        Self {
            role: ChatRole::User,
            content: content.into(),
            images: if images.is_empty() { None } else { Some(images) },
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::Assistant,
            content: content.into(),
            images: None,
        }
    }
}

/// 图像生成配置
///
/// 用于 Gemini 图像生成模型的专用参数（aspect_ratio、image_size 等）
/// 非图像模型会忽略此配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenerationConfig {
    /// 输出图片宽高比，如 "1:1"、"16:9"、"9:16"、"3:2" 等
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aspect_ratio: Option<String>,
    /// 输出图片分辨率，如 "512"、"1K"、"2K"、"4K"
    /// 仅 gemini-3.1-flash-image-preview 和 gemini-3-pro-image-preview 支持
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_size: Option<String>,
}

/// LLM 请求参数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    /// 聊天消息历史
    pub messages: Vec<ChatMessage>,
    /// 模型名称 (如 "gpt-5.4", "claude-opus-4-6", "gemini-3.1-pro")
    pub model: Option<String>,
    /// 温度参数 (0.0 - 2.0)
    pub temperature: Option<f32>,
    /// 最大生成 token 数
    pub max_tokens: Option<u32>,
    /// 是否使用流式响应
    pub stream: bool,
    /// 响应输出类型（如 ["Text", "Image"] 或 ["Image"]），用于图像生成模型
    pub response_modalities: Option<Vec<String>>,
    /// 图像生成配置（宽高比等）
    pub image_config: Option<ImageGenerationConfig>,
}

impl Default for ChatRequest {
    fn default() -> Self {
        Self {
            messages: Vec::new(),
            model: None,
            temperature: Some(0.7),
            max_tokens: Some(24576),
            stream: false,
            response_modalities: None,
            image_config: None,
        }
    }
}

/// LLM 响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResponse {
    /// 生成的内容
    pub content: String,
    /// 使用的模型
    pub model: String,
    /// 输入 token 数
    pub input_tokens: Option<u32>,
    /// 输出 token 数
    pub output_tokens: Option<u32>,
    /// 完成原因
    pub finish_reason: Option<String>,
}

/// 流式响应的单个块
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamChunk {
    /// 内容增量
    pub delta: String,
    /// 思考过程增量（思考模型专用）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    /// 是否是最后一个块
    pub done: bool,
    /// 完成原因 (仅在最后一个块)
    pub finish_reason: Option<String>,
    /// 输入 token 数（仅在最后一个块，来自 API usage）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u32>,
    /// 输出 token 数（仅在最后一个块，来自 API usage）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u32>,
}

/// LLM 提供商配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    /// API Key
    pub api_key: String,
    /// 基础 URL (可选，用于代理)
    pub base_url: Option<String>,
    /// 默认模型
    pub default_model: Option<String>,
    /// 请求超时 (秒)
    pub timeout_secs: Option<u64>,
    /// 使用原始 base64 格式（不带 data URL 前缀，智谱需要）
    pub use_raw_base64_image: bool,
    /// 是否支持流式 usage 返回（OpenAI stream_options.include_usage）
    /// 原生 OpenAI 支持，智谱/火山等兼容 API 可能不支持
    #[serde(default)]
    pub supports_stream_usage: bool,
    /// 自定义 HTTP 请求头（用于需要特殊头的供应商，如 Kimi Code 需要 User-Agent）
    #[serde(default)]
    pub custom_headers: HashMap<String, String>,
    /// 是否支持视觉/多模态输入（image_url content part）
    /// 默认 true ，DeepSeek 等纯文本模型需关闭，
    /// 避免 image_url 注入导致 API 400 Bad Request。
    #[serde(default = "default_true")]
    pub supports_vision: bool,
}

impl ProviderConfig {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            base_url: None,
            default_model: None,
            timeout_secs: Some(60),
            use_raw_base64_image: false,
            supports_stream_usage: false,
            custom_headers: HashMap::new(),
            supports_vision: true,
        }
    }

    pub fn with_base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = Some(url.into());
        self
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.default_model = Some(model.into());
        self
    }

    /// 设置为使用原始 base64 格式（智谱需要）
    pub fn with_raw_base64_image(mut self) -> Self {
        self.use_raw_base64_image = true;
        self
    }

    /// 启用流式 usage 返回（原生 OpenAI 支持）
    pub fn with_stream_usage(mut self) -> Self {
        self.supports_stream_usage = true;
        self
    }

    /// 添加自定义 HTTP 请求头
    pub fn with_header(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.custom_headers.insert(key.into(), value.into());
        self
    }

    /// 标记此供应商不支持视觉/多模态输入
    /// 调用后请求体中的 image_url content part 将被自动剥离
    pub fn without_vision(mut self) -> Self {
        self.supports_vision = false;
        self
    }
}

// ==================== Function Calling 类型定义 ====================

/// 工具定义（前端传入）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    /// 工具名称
    pub name: String,
    /// 工具描述
    pub description: String,
    /// 参数 Schema（JSON Schema 格式）
    pub parameters: serde_json::Value,
}

/// 工具调用（LLM 返回）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    /// 工具名称
    pub name: String,
    /// 工具参数
    pub args: serde_json::Value,
    /// 工具调用 ID（Anthropic API 必需，用于 tool_result 匹配）
    /// Gemini 不需要此字段，默认为 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Gemini thinking/function calling 返回的 thoughtSignature，下一轮需原样带回
    #[serde(
        skip_serializing_if = "Option::is_none",
        rename = "thoughtSignature",
        alias = "thought_signature"
    )]
    pub thought_signature: Option<String>,
}

/// 带工具的聊天消息角色
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ToolChatRole {
    System,
    User,
    Assistant,
    Tool,
}

/// 带工具的聊天消息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolChatMessage {
    pub role: ToolChatRole,
    pub content: String,
    /// 图片附件（多模态支持，User 消息和 Tool 消息均可携带）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<ImageAttachment>>,
    /// 工具调用列表（assistant 消息可能包含）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    /// 工具调用 ID（tool 消息必须包含）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// 工具名称（tool 消息用于协议适配；前端字段名为 toolName）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// 思考内容（DeepSeek 思考模式专用，工具调用场景需回传 API）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
}

/// 带工具的 LLM 请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolChatRequest {
    /// 聊天消息历史
    pub messages: Vec<ToolChatMessage>,
    /// 模型名称
    pub model_id: Option<String>,
    /// Provider ID
    pub provider_id: Option<String>,
    /// 当前模型是否支持视觉输入。false 时后端会剥离 image_url 负载。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_vision: Option<bool>,
    /// 工具定义列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolDefinition>>,
    /// 温度参数
    pub temperature: Option<f32>,
    /// 最大生成 token 数
    pub max_tokens: Option<u32>,
    /// 自定义 API 基址 URL（用于 Local 代理）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

/// 带工具的 LLM 响应
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolChatResponse {
    /// 响应类型: "text" | "tool_use" | "error"
    #[serde(rename = "type")]
    pub response_type: String,
    /// 文本内容（如果是 text 类型）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// 工具调用列表（如果是 tool_use 类型）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    /// 错误信息（如果是 error 类型）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 输入 token 数（来自 API usage 响应）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u32>,
    /// 输出 token 数（来自 API usage 响应）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u32>,
    /// 思考内容（DeepSeek 思考模式返回的推理链，需在多轮工具调用中回传）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
}
