//! Phase 1 通讯测试工具
//!
//! 用于验证 LLM Gateway 与 OpenAI 兼容 API 的通信
//!
//! 使用方法:
//!   cd src-tauri
//!   cargo run --bin test_llm

use std::env;

// 导入项目模块
use agentvis_lib::llm::{ChatMessage, ChatRequest, LlmProvider, OpenAIAdapter, ProviderConfig};

/// 测试配置
const DEFAULT_BASE_URL: &str = "http://127.0.0.1:8050/v1";
const DEFAULT_API_KEY: &str = "sk-b83d696046e74235a87de669a16f9064";
const DEFAULT_MODEL: &str = "gemini-3-flash";

#[tokio::main]
async fn main() {
    println!("========================================");
    println!("   AgentVis Phase 1 LLM Gateway 测试");
    println!("========================================\n");

    // 从环境变量或使用默认值
    let base_url = env::var("LLM_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string());
    let api_key = env::var("LLM_API_KEY").unwrap_or_else(|_| DEFAULT_API_KEY.to_string());
    let model = env::var("LLM_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string());

    println!("配置信息:");
    println!("  - Base URL: {}", base_url);
    println!("  - API Key: {}...", &api_key[..api_key.len().min(10)]);
    println!("  - Model: {}", model);
    println!();

    // 创建适配器
    let config = ProviderConfig::new(&api_key)
        .with_base_url(&base_url)
        .with_model(&model);

    let adapter = OpenAIAdapter::new(config);

    // 测试 1: 基本连接测试
    println!("[1/3] 测试连接...");
    match adapter.test_connection().await {
        Ok(true) => println!("   连接成功 - API Key 有效\n"),
        Ok(false) => {
            println!("   连接失败 - API Key 无效\n");
            return;
        }
        Err(e) => {
            println!("   连接失败: {:?}\n", e);
            return;
        }
    }

    // 测试 2: 基本对话
    println!("[2/3] 测试基本对话...");
    let request = ChatRequest {
        messages: vec![ChatMessage::user("请用一句话回答：1 + 1 等于几？")],
        max_tokens: Some(50),
        stream: false,
        ..Default::default()
    };

    match adapter.chat(request).await {
        Ok(response) => {
            println!("   对话成功!");
            println!("  模型: {}", response.model);
            println!("  响应: {}", response.content.trim());
            if let Some(tokens) = response.input_tokens {
                println!("  输入 tokens: {}", tokens);
            }
            if let Some(tokens) = response.output_tokens {
                println!("  输出 tokens: {}", tokens);
            }
            println!();
        }
        Err(e) => {
            println!("   对话失败: {:?}\n", e);
            return;
        }
    }

    // 测试 3: 多轮对话
    println!("[3/3] 测试多轮对话...");
    let request = ChatRequest {
        messages: vec![
            ChatMessage::system("你是一个数学助手。请简洁回答。"),
            ChatMessage::user("2 + 2 等于多少？"),
            ChatMessage::assistant("2 + 2 等于 4。"),
            ChatMessage::user("那再乘以 3 呢？"),
        ],
        max_tokens: Some(50),
        stream: false,
        ..Default::default()
    };

    match adapter.chat(request).await {
        Ok(response) => {
            println!("   多轮对话成功!");
            println!("  响应: {}", response.content.trim());
            println!();
        }
        Err(e) => {
            println!("   多轮对话失败: {:?}\n", e);
            return;
        }
    }

    println!("========================================");
    println!("      LLM Gateway 测试全部通过! 🎉");
    println!("========================================");
}
