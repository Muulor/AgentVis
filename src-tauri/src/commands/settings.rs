//! 设置相关 Tauri Commands
//!
//! 提供 API Key 管理和应用设置命令

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::crypto::{Keystore, WindowsKeystore};
use crate::error::{AppError, CommandResult};
use crate::AppState;

const IMAGE_GENERATION_PROVIDER: &str = "image-generation";
const GITHUB_PROVIDER: &str = "github";
const CONTEXT7_PROVIDER: &str = "context7";

/// API Key 状态（不返回实际的 key）
#[derive(Debug, Serialize)]
pub struct ApiKeyStatus {
    pub provider: String,
    pub configured: bool,
}

/// 设置 API Key 请求
#[derive(Debug, Deserialize)]
pub struct SetApiKeyRequest {
    pub provider: String,
    pub api_key: String,
}

/// 获取所有提供商的 API Key 配置状态
#[tauri::command]
pub async fn settings_get_api_key_status(
    _state: State<'_, AppState>,
) -> CommandResult<Vec<ApiKeyStatus>> {
    let keystore = WindowsKeystore::new();

    let providers = [
        "openai",
        "anthropic",
        "gemini",
        "zhipu",
        "deepseek",
        "agnes",
        "stepfun",
        "xiaomi-mimo",
        "zhipu-coding",
        "volcengine",
        "minimax",
        "openrouter",
        "local",
        "context7",
    ];
    let mut status = Vec::new();

    for provider in providers {
        let configured = keystore.has_api_key(provider).unwrap_or(false);
        status.push(ApiKeyStatus {
            provider: provider.to_string(),
            configured,
        });
    }

    Ok(status)
}

/// 设置 API Key
#[tauri::command]
pub async fn settings_set_api_key(
    _state: State<'_, AppState>,
    request: SetApiKeyRequest,
) -> CommandResult<()> {
    let keystore = WindowsKeystore::new();
    keystore.store_api_key(&request.provider, &request.api_key)?;
    Ok(())
}

/// 删除 API Key
#[tauri::command]
pub async fn settings_delete_api_key(
    _state: State<'_, AppState>,
    provider: String,
) -> CommandResult<()> {
    let keystore = WindowsKeystore::new();
    keystore.delete_api_key(&provider)?;
    Ok(())
}

/// 保存图像生成服务 API Key（仅供 generate_image 工具使用）
#[tauri::command]
pub async fn set_image_generation_api_key(
    _state: State<'_, AppState>,
    api_key: String,
) -> CommandResult<()> {
    let keystore = WindowsKeystore::new();
    keystore.store_api_key(IMAGE_GENERATION_PROVIDER, &api_key)?;
    Ok(())
}

/// 获取图像生成服务 API Key 配置状态
#[tauri::command]
pub async fn get_image_generation_api_key_status(
    _state: State<'_, AppState>,
) -> CommandResult<bool> {
    let keystore = WindowsKeystore::new();
    Ok(keystore
        .has_api_key(IMAGE_GENERATION_PROVIDER)
        .unwrap_or(false))
}

/// Save a GitHub Personal Access Token for GitHub API operations.
#[tauri::command]
pub async fn set_github_token(_state: State<'_, AppState>, api_key: String) -> CommandResult<()> {
    let keystore = WindowsKeystore::new();
    keystore.store_api_key(GITHUB_PROVIDER, &api_key)?;
    Ok(())
}

/// Return whether a GitHub token is configured.
#[tauri::command]
pub async fn get_github_token_status(_state: State<'_, AppState>) -> CommandResult<bool> {
    let keystore = WindowsKeystore::new();
    Ok(keystore.has_api_key(GITHUB_PROVIDER).unwrap_or(false))
}

/// Validate the configured GitHub token with a lightweight rate-limit request.
#[tauri::command]
pub async fn test_github_token(_state: State<'_, AppState>) -> CommandResult<bool> {
    let keystore = WindowsKeystore::new();
    let Some(api_key) = keystore.get_api_key(GITHUB_PROVIDER)? else {
        return Ok(false);
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| AppError::Generic(format!("Failed to create HTTP client: {}", e)))?;

    let response = client
        .get("https://api.github.com/rate_limit")
        .header("User-Agent", "AgentVis-GitHubTokenTest/1.0")
        .header("Accept", "application/vnd.github.v3+json")
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| AppError::Generic(format!("GitHub token test failed: {}", e)))?;

    Ok(response.status().is_success())
}

/// Save a Context7 API key for Context7 documentation lookups.
#[tauri::command]
pub async fn set_context7_api_key(
    _state: State<'_, AppState>,
    api_key: String,
) -> CommandResult<()> {
    let keystore = WindowsKeystore::new();
    keystore.store_api_key(CONTEXT7_PROVIDER, &api_key)?;
    Ok(())
}

/// Return whether a Context7 API key is configured.
#[tauri::command]
pub async fn get_context7_api_key_status(_state: State<'_, AppState>) -> CommandResult<bool> {
    let keystore = WindowsKeystore::new();
    Ok(keystore.has_api_key(CONTEXT7_PROVIDER).unwrap_or(false))
}

/// Validate the configured Context7 API key with a lightweight library search.
#[tauri::command]
pub async fn test_context7_api_key(_state: State<'_, AppState>) -> CommandResult<bool> {
    let keystore = WindowsKeystore::new();
    let Some(api_key) = keystore.get_api_key(CONTEXT7_PROVIDER)? else {
        return Ok(false);
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| AppError::Generic(format!("Failed to create HTTP client: {}", e)))?;

    let response = client
        .get("https://context7.com/api/v2/libs/search")
        .query(&[("libraryName", "react"), ("query", "hooks")])
        .header("User-Agent", "AgentVis-Context7TokenTest/1.0")
        .header("Accept", "application/json")
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| AppError::Generic(format!("Context7 API key test failed: {}", e)))?;

    Ok(response.status().is_success())
}

/// 测试 API Key 是否有效（通过发送测试请求）
#[tauri::command]
pub async fn settings_test_api_key(
    _state: State<'_, AppState>,
    provider: String,
) -> CommandResult<bool> {
    use crate::llm::{AnthropicAdapter, GeminiAdapter, LlmProvider, OpenAIAdapter, ProviderConfig};

    let keystore = WindowsKeystore::new();
    let api_key = keystore.get_api_key(&provider)?;

    let api_key = match api_key {
        Some(key) => key,
        None => return Ok(false),
    };

    let config = ProviderConfig::new(api_key);

    let result = match provider.as_str() {
        "openai" => {
            let adapter = OpenAIAdapter::new(config);
            adapter.test_connection().await
        }
        "anthropic" => {
            let adapter = AnthropicAdapter::new(config);
            adapter.test_connection().await
        }
        "gemini" => {
            let adapter = GeminiAdapter::new(config);
            adapter.test_connection().await
        }
        "zhipu" => {
            // ZhipuAI 使用 OpenAI 兼容 API，需指定免费或存在的模型进行连通性测试
            let zhipu_config = config
                .with_base_url("https://open.bigmodel.cn/api/paas/v4")
                .with_model("glm-4-flash");
            let adapter = OpenAIAdapter::new(zhipu_config);
            adapter.test_connection().await
        }
        "deepseek" => {
            // DeepSeek 使用 OpenAI 兼容协议，用 flash 模型测试（更快速轻量）
            let deepseek_config = config
                .with_base_url("https://api.deepseek.com")
                .with_model("deepseek-v4-flash");
            let adapter = OpenAIAdapter::new(deepseek_config);
            adapter.test_connection().await
        }
        "agnes" => {
            // Agnes AI 使用 OpenAI 兼容协议，用 Agnes-2.0-Flash 进行连通性测试
            let agnes_config = config
                .with_base_url("https://apihub.agnes-ai.com/v1")
                .with_model("agnes-2.0-flash");
            let adapter = OpenAIAdapter::new(agnes_config);
            adapter.test_connection().await
        }
        "stepfun" => {
            // StepFun Step Plan 使用 OpenAI 兼容协议，用 Step 3.7 Flash 进行连通性测试
            let stepfun_config = config
                .with_base_url("https://api.stepfun.com/step_plan/v1")
                .with_model("step-3.7-flash");
            let adapter = OpenAIAdapter::new(stepfun_config);
            adapter.test_connection().await
        }
        "xiaomi-mimo" => {
            // Xiaomi MiMo Token Plan 使用 OpenAI 兼容协议
            let mimo_config = config
                .with_base_url("https://token-plan-cn.xiaomimimo.com/v1")
                .with_model("mimo-v2.5");
            let adapter = OpenAIAdapter::new(mimo_config);
            adapter.test_connection().await
        }
        "zhipu-coding" => {
            // ZhipuAI Coding Plan 专属 endpoint，用于订阅了编码套餐的用户
            // 与普通 zhipu 共享 API Key，但走独立的 /coding/paas/v4 路径享受套餐配额
            // 使用 GLM-4.7 做连通性测试（GLM-5.1 需要更高级别套餐权限）
            let zhipu_coding_config = config
                .with_base_url("https://open.bigmodel.cn/api/coding/paas/v4")
                .with_model("GLM-4.7");
            let adapter = OpenAIAdapter::new(zhipu_coding_config);
            adapter.test_connection().await
        }
        "volcengine" => {
            // 火山引擎 Coding Plan 使用 OpenAI 兼容协议
            let bailian_config = config
                .with_base_url("https://ark.cn-beijing.volces.com/api/coding/v3")
                .with_model("doubao-seed-2.0-pro");
            let adapter = OpenAIAdapter::new(bailian_config);
            adapter.test_connection().await
        }
        "minimax" => {
            // Minimax Anthropic 兼容协议（使用 highspeed 模型测试，响应快且节省额度）
            let minimax_config = config
                .with_base_url("https://api.minimaxi.com/anthropic/v1")
                .with_model("MiniMax-M2.7-highspeed");
            let adapter = AnthropicAdapter::new(minimax_config);
            adapter.test_connection().await
        }
        "openrouter" => {
            // OpenRouter 使用 OpenAI 兼容协议，指定免费模型进行连通性测试
            let openrouter_config = config
                .with_base_url("https://openrouter.ai/api/v1")
                .with_model("openai/gpt-oss-120b:free");
            let adapter = OpenAIAdapter::new(openrouter_config);
            adapter.test_connection().await
        }
        "local" => {
            // 本地 OpenAI 兼容代理，需指定本地支持的模型
            // 注：URL 使用默认值，如需自定义需从前端传入
            let local_config = config
                .with_base_url("http://127.0.0.1:8050/v1")
                .with_model("gemini-3-flash");
            let adapter = OpenAIAdapter::new(local_config);
            adapter.test_connection().await
        }
        _ => return Ok(false),
    };

    result
}

// ═══════════════════════════════════════════════════════════════
// IM 通道凭据管理
// ═══════════════════════════════════════════════════════════════

/// IM 凭据结构（返回给前端）
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImCredentials {
    pub app_id: String,
    pub app_secret: String,
    pub bot_token: String,
    pub app_token: String,
}

/// 保存 IM 平台凭据
///
/// 将 app_id 和 app_secret 合并为 JSON 存储在单个 Keystore 条目中
/// 避免 Windows Credential Manager 的条目长度限制
#[tauri::command]
pub async fn im_save_credentials(
    _state: State<'_, AppState>,
    platform: String,
    app_id: String,
    app_secret: String,
) -> CommandResult<()> {
    let keystore = WindowsKeystore::new();

    let key = format!("im_{}_credentials", platform);
    // 合并为紧凑 JSON，减少存储大小
    let value = serde_json::json!({
        "id": app_id,
        "secret": app_secret,
    })
    .to_string();

    keystore.store_api_key(&key, &value)?;

    Ok(())
}

/// 获取 IM 平台凭据
#[tauri::command]
pub async fn im_get_credentials(
    _state: State<'_, AppState>,
    platform: String,
) -> CommandResult<ImCredentials> {
    let keystore = WindowsKeystore::new();

    let key = format!("im_{}_credentials", platform);

    let stored = keystore.get_api_key(&key)?;

    match stored {
        Some(json_str) => {
            // 解析 JSON 格式的凭据
            let parsed: serde_json::Value = serde_json::from_str(&json_str).map_err(|e| {
                crate::error::AppError::Generic(format!("Failed to parse credentials: {}", e))
            })?;

            Ok(ImCredentials {
                app_id: parsed["id"].as_str().unwrap_or_default().to_string(),
                app_secret: parsed["secret"].as_str().unwrap_or_default().to_string(),
                bot_token: parsed["botToken"].as_str().unwrap_or_default().to_string(),
                app_token: parsed["appToken"].as_str().unwrap_or_default().to_string(),
            })
        }
        None => Ok(ImCredentials {
            app_id: String::new(),
            app_secret: String::new(),
            bot_token: String::new(),
            app_token: String::new(),
        }),
    }
}

// ═══════════════════════════════════════════════════════════════
// 多 Bot 凭据管理（per-botId 独立存储）
// ═══════════════════════════════════════════════════════════════
//
// 存储键格式：im_{platform}_{botId}_credentials
// 保证每个 Bot 的凭据独立，互不干扰。
// 旧全局键 im_{platform}_credentials 保留用于前端迁移检测。

/// 保存单个 Bot 的凭据
///
/// 以 botId 为索引，允许同一平台存储多套凭据（最多 MAX_BOT_COUNT 套）。
/// 凭据以紧凑 JSON 格式存储在 Windows Credential Manager 中。
#[tauri::command]
pub async fn im_save_bot_credentials(
    _state: State<'_, AppState>,
    platform: String,
    bot_id: String,
    app_id: Option<String>,
    app_secret: Option<String>,
    bot_token: Option<String>,
    app_token: Option<String>,
) -> CommandResult<()> {
    let keystore = WindowsKeystore::new();

    // 键格式：im_feishu_<botId>_credentials
    let key = format!("im_{}_{}_credentials", platform, bot_id);
    let value = if platform == "slack" {
        serde_json::json!({
            "botToken": bot_token.unwrap_or_default(),
            "appToken": app_token.unwrap_or_default(),
        })
        .to_string()
    } else {
        serde_json::json!({
            "id": app_id.unwrap_or_default(),
            "secret": app_secret.unwrap_or_default(),
        })
        .to_string()
    };

    keystore.store_api_key(&key, &value)?;

    Ok(())
}

/// 获取单个 Bot 的凭据
///
/// 若对应 botId 尚未存储凭据，返回空字符串（而非错误），前端可据此判断是否已配置。
#[tauri::command]
pub async fn im_get_bot_credentials(
    _state: State<'_, AppState>,
    platform: String,
    bot_id: String,
) -> CommandResult<ImCredentials> {
    let keystore = WindowsKeystore::new();

    let key = format!("im_{}_{}_credentials", platform, bot_id);
    let stored = keystore.get_api_key(&key)?;

    match stored {
        Some(json_str) => {
            let parsed: serde_json::Value = serde_json::from_str(&json_str).map_err(|e| {
                crate::error::AppError::Generic(format!("Failed to parse bot credentials: {}", e))
            })?;

            Ok(ImCredentials {
                app_id: parsed["id"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_default(),
                app_secret: parsed["secret"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_default(),
                bot_token: parsed["botToken"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_default(),
                app_token: parsed["appToken"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_default(),
            })
        }
        None => Ok(ImCredentials {
            app_id: String::new(),
            app_secret: String::new(),
            bot_token: String::new(),
            app_token: String::new(),
        }),
    }
}

/// 删除单个 Bot 的凭据
///
/// 在 UI 删除 Bot 配置时调用，同时清理 Keystore 中的凭据条目，防止残留。
#[tauri::command]
pub async fn im_delete_bot_credentials(
    _state: State<'_, AppState>,
    platform: String,
    bot_id: String,
) -> CommandResult<()> {
    let keystore = WindowsKeystore::new();

    let key = format!("im_{}_{}_credentials", platform, bot_id);
    // delete_api_key 不存在时不报错，幂等删除
    keystore.delete_api_key(&key)?;

    Ok(())
}
