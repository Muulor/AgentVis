//! API Key 加密存储
//!
//! 使用 Windows Credential Manager 安全存储 API Key。

use crate::error::{AppError, AppResult};
use keyring::Entry;

/// 应用标识符，用于在 Credential Manager 中区分不同应用
const SERVICE_NAME: &str = "AgentVis";

/// 支持的 LLM 提供商
#[allow(dead_code)] // 当前仅在测试中使用，保留作为公共接口扩展
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlmProvider {
    OpenAI,
    Anthropic,
    Gemini,
}

#[allow(dead_code)]
impl LlmProvider {
    /// 获取提供商的字符串标识
    pub fn as_str(&self) -> &'static str {
        match self {
            LlmProvider::OpenAI => "openai",
            LlmProvider::Anthropic => "anthropic",
            LlmProvider::Gemini => "gemini",
        }
    }

    /// 从字符串解析提供商
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "openai" => Some(LlmProvider::OpenAI),
            "anthropic" | "claude" => Some(LlmProvider::Anthropic),
            "gemini" | "google" => Some(LlmProvider::Gemini),
            _ => None,
        }
    }

    /// 获取所有支持的提供商
    pub fn all() -> &'static [LlmProvider] {
        &[
            LlmProvider::OpenAI,
            LlmProvider::Anthropic,
            LlmProvider::Gemini,
        ]
    }
}

/// Keystore trait - 定义加密存储接口
pub trait Keystore: Send + Sync {
    /// 存储 API Key
    fn store_api_key(&self, provider: &str, key: &str) -> AppResult<()>;

    /// 获取 API Key
    fn get_api_key(&self, provider: &str) -> AppResult<Option<String>>;

    /// 删除 API Key
    fn delete_api_key(&self, provider: &str) -> AppResult<()>;

    /// 检查是否已配置 API Key
    fn has_api_key(&self, provider: &str) -> AppResult<bool>;
}

/// Windows Keystore 实现
///
/// 使用 keyring crate 与 Windows Credential Manager 交互
pub struct WindowsKeystore {
    service: String,
}

impl WindowsKeystore {
    /// 创建新的 WindowsKeystore 实例
    pub fn new() -> Self {
        Self {
            service: SERVICE_NAME.to_string(),
        }
    }

    /// 使用自定义服务名创建
    pub fn with_service(service: &str) -> Self {
        Self {
            service: service.to_string(),
        }
    }

    /// 获取 keyring Entry
    fn get_entry(&self, provider: &str) -> Result<Entry, keyring::Error> {
        Entry::new(&self.service, provider)
    }
}

impl Default for WindowsKeystore {
    fn default() -> Self {
        Self::new()
    }
}

impl Keystore for WindowsKeystore {
    fn store_api_key(&self, provider: &str, key: &str) -> AppResult<()> {
        let entry = self
            .get_entry(provider)
            .map_err(|e| AppError::Keystore(format!("Unable to access key storage: {}", e)))?;

        entry
            .set_password(key)
            .map_err(|e| AppError::Keystore(format!("Unable to store API key: {}", e)))?;

        Ok(())
    }

    fn get_api_key(&self, provider: &str) -> AppResult<Option<String>> {
        let entry = self
            .get_entry(provider)
            .map_err(|e| AppError::Keystore(format!("Unable to access key storage: {}", e)))?;

        match entry.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::Keystore(format!("Unable to read API key: {}", e))),
        }
    }

    fn delete_api_key(&self, provider: &str) -> AppResult<()> {
        let entry = self
            .get_entry(provider)
            .map_err(|e| AppError::Keystore(format!("Unable to access key storage: {}", e)))?;

        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()), // 不存在也视为成功
            Err(e) => Err(AppError::Keystore(format!(
                "Unable to delete API key: {}",
                e
            ))),
        }
    }

    fn has_api_key(&self, provider: &str) -> AppResult<bool> {
        let entry = self
            .get_entry(provider)
            .map_err(|e| AppError::Keystore(format!("Unable to access key storage: {}", e)))?;

        match entry.get_password() {
            Ok(_) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(e) => Err(AppError::Keystore(format!(
                "Unable to check API key: {}",
                e
            ))),
        }
    }
}

/// 获取 API Key 的脱敏显示
///
/// 例如: "sk-abc...xyz" 显示为 "sk-abc...xyz" (前6后3)
#[allow(dead_code)] // 当前仅在测试中使用，保留作为 UI 展示 API Key 时的脱敏工具
pub fn mask_api_key(key: &str) -> String {
    if key.len() <= 12 {
        return "*".repeat(key.len());
    }

    let prefix_len = 6.min(key.len() / 3);
    let suffix_len = 3.min(key.len() / 4);
    let mask_len = key.len() - prefix_len - suffix_len;

    format!(
        "{}{}{}",
        &key[..prefix_len],
        "*".repeat(mask_len.min(10)), // 最多10个星号
        &key[key.len() - suffix_len..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_llm_provider_from_str() {
        assert_eq!(LlmProvider::from_str("openai"), Some(LlmProvider::OpenAI));
        assert_eq!(LlmProvider::from_str("OpenAI"), Some(LlmProvider::OpenAI));
        assert_eq!(
            LlmProvider::from_str("claude"),
            Some(LlmProvider::Anthropic)
        );
        assert_eq!(
            LlmProvider::from_str("anthropic"),
            Some(LlmProvider::Anthropic)
        );
        assert_eq!(LlmProvider::from_str("gemini"), Some(LlmProvider::Gemini));
        assert_eq!(LlmProvider::from_str("google"), Some(LlmProvider::Gemini));
        assert_eq!(LlmProvider::from_str("unknown"), None);
    }

    #[test]
    fn test_mask_api_key() {
        // 短密钥
        assert_eq!(mask_api_key("abc"), "***");
        assert_eq!(mask_api_key("abcdefgh"), "********");

        // 长密钥
        let key = "sk-abcdef1234567890xyz";
        let masked = mask_api_key(key);
        assert!(masked.starts_with("sk-abc"));
        assert!(masked.ends_with("xyz"));
        assert!(masked.contains("*"));
    }

    // 注意: WindowsKeystore 的集成测试需要在 Windows 环境运行
    // 并且会实际写入 Credential Manager，因此不包含在自动测试中
}
