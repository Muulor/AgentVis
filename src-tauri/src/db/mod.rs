//! 数据库模块
//!
//! 负责 SQLite 数据库连接和数据访问层。

pub mod agent_repo;
pub mod cron_repo;
pub mod diff_record_repo;
pub mod file_repo;
pub mod hub_repo;
pub mod memory_repo;
pub mod memory_trigger_repo;
pub mod message_repo;
pub mod models;
pub mod schema;
pub mod snapshot_repo;
pub mod vector_repo;

// 重新导出常用类型
pub use agent_repo::AgentRepository;
pub use cron_repo::CronJobRepository;
pub use file_repo::FileRepository;
pub use hub_repo::HubRepository;
pub use memory_repo::{MemoryRepository, MemoryStats};
pub use memory_trigger_repo::MemoryTriggerRepository;
pub use message_repo::MessageRepository;
pub use models::Snapshot;
pub use models::{Agent, FileInfo, Hub, Memory, MemoryLayer, Message, MessageRole};
pub use models::{AgentUpdate, HubUpdate};
pub use models::{CronJob, CronJobCreate, CronJobUpdate};
pub use models::{DiffRecord, DiffRecordCreateRequest, DiffRecordStatus};
pub use models::{MemoryTriggerState, MemoryTriggerStateUpdate};
pub use schema::{create_pool, initialize_schema};
pub use snapshot_repo::SnapshotRepository;
pub use vector_repo::{
    ChunkEmbedding, ChunkEmbeddingUpdate, IndexStats, VectorRepository, VectorSearchResult,
};

use crate::error::{AppError, AppResult};
use sqlx::{Pool, Sqlite};
use std::path::Path;

/// 数据库管理器
///
/// 封装数据库连接池和所有 Repository 实例
pub struct Database {
    pool: Pool<Sqlite>,
}

impl Database {
    /// 创建并初始化数据库
    ///
    /// # Arguments
    /// * `db_path` - 数据库文件路径
    ///
    /// # Returns
    /// 初始化完成的 Database 实例
    pub async fn new(db_path: &Path) -> AppResult<Self> {
        // 确保父目录存在
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AppError::FileSystem(format!("Unable to create database directory: {}", e))
            })?;
        }

        // 构建数据库 URL
        let db_url = format!("sqlite:{}?mode=rwc", db_path.display());

        // 创建连接池
        let pool = create_pool(&db_url)
            .await
            .map_err(|e| AppError::Database(format!("Unable to connect to database: {}", e)))?;

        // 初始化 Schema
        initialize_schema(&pool)
            .await
            .map_err(|e| AppError::Database(format!("Schema initialization failed: {}", e)))?;

        Ok(Self { pool })
    }

    /// 使用内存数据库 (用于测试)
    pub async fn in_memory() -> AppResult<Self> {
        let pool = create_pool("sqlite::memory:").await.map_err(|e| {
            AppError::Database(format!("Unable to create in-memory database: {}", e))
        })?;

        initialize_schema(&pool)
            .await
            .map_err(|e| AppError::Database(format!("Schema initialization failed: {}", e)))?;

        Ok(Self { pool })
    }

    /// 获取 Hub Repository
    pub fn hub_repo(&self) -> HubRepository {
        HubRepository::new(self.pool.clone())
    }

    /// 获取 Agent Repository
    pub fn agent_repo(&self) -> AgentRepository {
        AgentRepository::new(self.pool.clone())
    }

    /// 获取 Message Repository
    pub fn message_repo(&self) -> MessageRepository {
        MessageRepository::new(self.pool.clone())
    }

    /// 获取 Memory Repository
    pub fn memory_repo(&self) -> MemoryRepository {
        MemoryRepository::new(self.pool.clone())
    }

    /// 获取 File Repository
    pub fn file_repo(&self) -> FileRepository {
        FileRepository::new(self.pool.clone())
    }

    /// 获取 Vector Repository
    pub fn vector_repo(&self) -> VectorRepository {
        VectorRepository::new(self.pool.clone())
    }

    /// 获取 Snapshot Repository
    pub fn snapshot_repo(&self) -> SnapshotRepository {
        SnapshotRepository::new(self.pool.clone())
    }

    /// 获取 CronJob Repository
    pub fn cron_repo(&self) -> CronJobRepository {
        CronJobRepository::new(self.pool.clone())
    }

    /// 获取底层连接池 (高级用法)
    pub fn pool(&self) -> &Pool<Sqlite> {
        &self.pool
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_database_initialization() {
        let db = Database::in_memory().await.unwrap();

        // 测试创建 Hub
        let hub = db.hub_repo().create("测试 Hub").await.unwrap();
        assert!(!hub.id.is_empty());

        // 测试创建 Agent
        let agent = db.agent_repo().create(&hub.id, "测试 Agent").await.unwrap();
        assert_eq!(agent.hub_id, hub.id);

        // 测试创建 Message
        let message = db
            .message_repo()
            .create(&agent.id, MessageRole::User, "你好", None)
            .await
            .unwrap();
        assert_eq!(message.role, "user");
    }
}
