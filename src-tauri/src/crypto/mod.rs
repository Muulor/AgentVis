//! 加密存储模块
//!
//! 提供 API Key 等敏感信息的安全存储功能。
//! 使用 Windows Credential Manager 进行加密存储。

mod keystore;

pub use keystore::{Keystore, WindowsKeystore};
