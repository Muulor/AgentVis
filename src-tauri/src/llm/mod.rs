//! LLM Gateway 模块
//!
//! 负责统一管理云端 LLM API 调用 (OpenAI/Claude/Gemini)。

pub mod types;
pub mod http_client;
pub mod openai;
pub mod anthropic;
pub mod gemini;
pub mod json_repair;

use async_trait::async_trait;
use futures::stream::Stream;
use std::pin::Pin;
use std::sync::Arc;

pub use types::{ChatMessage, ChatRequest, ChatResponse, ChatRole, ProviderConfig, StreamChunk, ImageAttachment};
pub use openai::OpenAIAdapter;
pub use anthropic::AnthropicAdapter;
pub use gemini::GeminiAdapter;

use crate::error::AppResult;

/// LLM 提供商 trait
/// 
/// 所有 LLM API 适配器都需要实现此 trait
#[async_trait]
pub trait LlmProvider: Send + Sync {
    /// 发送聊天请求 (非流式)
    async fn chat(&self, request: ChatRequest) -> AppResult<ChatResponse>;
    
    /// 发送聊天请求 (流式)
    async fn chat_stream(
        &self,
        request: ChatRequest,
    ) -> AppResult<Pin<Box<dyn Stream<Item = AppResult<StreamChunk>> + Send>>>;
    
    /// 测试连接是否有效
    async fn test_connection(&self) -> AppResult<bool>;
}

/// 支持的 LLM 提供商类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProviderType {
    OpenAI,
    Anthropic,
    Gemini,
}

impl ProviderType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderType::OpenAI => "openai",
            ProviderType::Anthropic => "anthropic",
            ProviderType::Gemini => "gemini",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "openai" => Some(ProviderType::OpenAI),
            "anthropic" | "claude" => Some(ProviderType::Anthropic),
            "gemini" | "google" => Some(ProviderType::Gemini),
            _ => None,
        }
    }

    /// 获取默认模型
    pub fn default_model(&self) -> &'static str {
        match self {
            ProviderType::OpenAI => "gpt-5.4-mini",
            ProviderType::Anthropic => "claude-4.6-sonnet",
            ProviderType::Gemini => "gemini-2.5-flash",
        }
    }
}

/// LLM Gateway - 统一的 LLM 调用网关
/// 
/// 管理多个 LLM 提供商,提供统一的调用接口
pub struct LlmGateway {
    providers: std::collections::HashMap<ProviderType, Arc<dyn LlmProvider>>,
    default_provider: Option<ProviderType>,
}

impl LlmGateway {
    /// 创建空的 Gateway
    pub fn new() -> Self {
        Self {
            providers: std::collections::HashMap::new(),
            default_provider: None,
        }
    }

    /// 注册 LLM 提供商
    pub fn register(&mut self, provider_type: ProviderType, provider: Arc<dyn LlmProvider>) {
        if self.default_provider.is_none() {
            self.default_provider = Some(provider_type);
        }
        self.providers.insert(provider_type, provider);
    }

    /// 设置默认提供商
    pub fn set_default(&mut self, provider_type: ProviderType) {
        self.default_provider = Some(provider_type);
    }

    /// 获取指定提供商
    pub fn get(&self, provider_type: ProviderType) -> Option<&Arc<dyn LlmProvider>> {
        self.providers.get(&provider_type)
    }

    /// 获取默认提供商
    pub fn get_default(&self) -> Option<&Arc<dyn LlmProvider>> {
        self.default_provider.and_then(|pt| self.providers.get(&pt))
    }

    /// 使用默认提供商发送聊天请求
    pub async fn chat(&self, request: ChatRequest) -> AppResult<ChatResponse> {
        let provider = self.get_default()
            .ok_or_else(|| crate::error::AppError::LlmApi("LLM provider is not configured".to_string()))?;
        provider.chat(request).await
    }

    /// 使用指定提供商发送聊天请求
    pub async fn chat_with(&self, provider_type: ProviderType, request: ChatRequest) -> AppResult<ChatResponse> {
        let provider = self.get(provider_type)
            .ok_or_else(|| crate::error::AppError::LlmApi(format!("{} provider is not configured", provider_type.as_str())))?;
        provider.chat(request).await
    }

    /// 检查是否已配置任何提供商
    pub fn has_providers(&self) -> bool {
        !self.providers.is_empty()
    }

    /// 获取已配置的提供商列表
    pub fn list_providers(&self) -> Vec<ProviderType> {
        self.providers.keys().copied().collect()
    }
}

impl Default for LlmGateway {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_type_from_str() {
        assert_eq!(ProviderType::from_str("openai"), Some(ProviderType::OpenAI));
        assert_eq!(ProviderType::from_str("claude"), Some(ProviderType::Anthropic));
        assert_eq!(ProviderType::from_str("gemini"), Some(ProviderType::Gemini));
        assert_eq!(ProviderType::from_str("unknown"), None);
    }

    #[test]
    fn test_chat_message_builders() {
        let system = ChatMessage::system("你是一个助手");
        assert_eq!(system.role, ChatRole::System);
        
        let user = ChatMessage::user("你好");
        assert_eq!(user.role, ChatRole::User);
        
        let assistant = ChatMessage::assistant("你好！有什么可以帮助你的？");
        assert_eq!(assistant.role, ChatRole::Assistant);
    }
}
