//! LLM Gateway 集成测试
//!
//! 测试与 OpenAI 兼容 API 的通信

use crate::llm::{ChatMessage, ChatRequest, LlmProvider, OpenAIAdapter, ProviderConfig};

/// 测试配置（本地 API 代理服务）
const TEST_BASE_URL: &str = "http://127.0.0.1:8050/v1";
const TEST_API_KEY: &str = "sk-b83d696046e74235a87de669a16f9064";
const TEST_MODEL: &str = "gemini-3-flash";

/// 测试基本聊天功能
#[tokio::test]
async fn test_openai_compatible_chat() {
    let config = ProviderConfig::new(TEST_API_KEY)
        .with_base_url(TEST_BASE_URL)
        .with_model(TEST_MODEL);

    let adapter = OpenAIAdapter::new(config);

    let request = ChatRequest {
        messages: vec![
            ChatMessage::system("你是一个友好的助手。"),
            ChatMessage::user("请简单介绍一下自己，用一句话。"),
        ],
        max_tokens: Some(100),
        stream: false,
        ..Default::default()
    };

    let result = adapter.chat(request).await;

    match result {
        Ok(response) => {
            println!(" LLM Gateway 测试成功!");
            println!("模型: {}", response.model);
            println!("响应: {}", response.content);
            if let Some(input_tokens) = response.input_tokens {
                println!("输入 tokens: {}", input_tokens);
            }
            if let Some(output_tokens) = response.output_tokens {
                println!("输出 tokens: {}", output_tokens);
            }
        }
        Err(e) => {
            panic!(" LLM Gateway 测试失败: {:?}", e);
        }
    }
}

/// 测试连接验证
#[tokio::test]
async fn test_connection() {
    let config = ProviderConfig::new(TEST_API_KEY)
        .with_base_url(TEST_BASE_URL)
        .with_model(TEST_MODEL);

    let adapter = OpenAIAdapter::new(config);

    let result = adapter.test_connection().await;

    match result {
        Ok(true) => {
            println!(" 连接测试成功 - API Key 有效");
        }
        Ok(false) => {
            println!(" 连接测试 - API Key 无效");
        }
        Err(e) => {
            panic!(" 连接测试失败: {:?}", e);
        }
    }
}
