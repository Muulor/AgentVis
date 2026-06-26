//! 统一错误处理模块
//!
//! 定义应用程序级别的错误类型，用于跨模块的错误传播。

use thiserror::Error;

/// 应用程序错误类型
#[derive(Error, Debug)]
pub enum AppError {
    /// 数据库错误
    #[error("Database operation failed: {0}")]
    Database(String),

    /// 资源未找到
    #[error("Resource not found: {0}")]
    NotFound(String),

    /// 权限禁止
    #[error("Operation forbidden: {0}")]
    Forbidden(String),

    /// 文件系统错误
    #[error("File operation failed: {0}")]
    FileSystem(String),

    /// LLM API 错误
    #[error("LLM API call failed: {0}")]
    LlmApi(String),

    /// 加密存储错误
    #[error("Keystore error: {0}")]
    Keystore(String),

    /// 序列化错误
    #[error("Serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),

    /// 通用错误
    #[error("{0}")]
    Generic(String),
}

/// 应用程序结果类型
pub type AppResult<T> = Result<T, AppError>;

/// Tauri 命令结果类型
pub type CommandResult<T> = Result<T, AppError>;

// 实现 Tauri 的错误序列化
impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
