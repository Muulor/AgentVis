//! File 数据访问层
//!
//! 提供文件元数据的 CRUD 操作

use chrono::Utc;
use sqlx::{Pool, Sqlite};

use super::models::FileInfo;
use crate::error::{AppError, AppResult};

/// File Repository - 管理文件元数据访问
pub struct FileRepository {
    pool: Pool<Sqlite>,
}

impl FileRepository {
    /// 创建新的 FileRepository 实例
    pub fn new(pool: Pool<Sqlite>) -> Self {
        Self { pool }
    }

    /// 创建新的文件记录
    ///
    /// # Arguments
    /// * `agent_id` - 所属 Agent ID
    /// * `name` - 文件名
    /// * `path` - 文件路径
    /// * `file_type` - 文件类型
    /// * `size_bytes` - 文件大小（可选）
    ///
    /// # Returns
    /// 创建成功的 FileInfo 实体
    pub async fn create(
        &self,
        agent_id: &str,
        name: &str,
        path: &str,
        file_type: &str,
        size_bytes: Option<i64>,
    ) -> AppResult<FileInfo> {
        let mut file = FileInfo::new(agent_id, name, path, file_type);
        file.size_bytes = size_bytes;

        sqlx::query(
            r#"
            INSERT INTO files (id, agent_id, name, path, file_type, size_bytes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&file.id)
        .bind(&file.agent_id)
        .bind(&file.name)
        .bind(&file.path)
        .bind(&file.file_type)
        .bind(file.size_bytes)
        .bind(file.created_at)
        .bind(file.updated_at)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(file)
    }

    /// 根据 ID 获取文件信息
    pub async fn get(&self, id: &str) -> AppResult<Option<FileInfo>> {
        let file: Option<FileInfo> = sqlx::query_as(
            r#"
            SELECT id, agent_id, name, path, file_type, size_bytes, created_at, updated_at
            FROM files
            WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(file)
    }

    /// 根据路径获取文件信息
    pub async fn get_by_path(&self, path: &str) -> AppResult<Option<FileInfo>> {
        let file: Option<FileInfo> = sqlx::query_as(
            r#"
            SELECT id, agent_id, name, path, file_type, size_bytes, created_at, updated_at
            FROM files
            WHERE path = ?
            "#,
        )
        .bind(path)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(file)
    }

    /// 获取指定 Agent 的所有文件
    pub async fn list_by_agent(&self, agent_id: &str) -> AppResult<Vec<FileInfo>> {
        let files: Vec<FileInfo> = sqlx::query_as(
            r#"
            SELECT id, agent_id, name, path, file_type, size_bytes, created_at, updated_at
            FROM files
            WHERE agent_id = ?
            ORDER BY created_at DESC
            "#,
        )
        .bind(agent_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(files)
    }

    /// 根据文件类型过滤
    pub async fn list_by_type(&self, agent_id: &str, file_type: &str) -> AppResult<Vec<FileInfo>> {
        let files: Vec<FileInfo> = sqlx::query_as(
            r#"
            SELECT id, agent_id, name, path, file_type, size_bytes, created_at, updated_at
            FROM files
            WHERE agent_id = ? AND file_type = ?
            ORDER BY created_at DESC
            "#,
        )
        .bind(agent_id)
        .bind(file_type)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(files)
    }

    /// 更新文件信息
    pub async fn update(
        &self,
        id: &str,
        name: Option<&str>,
        size_bytes: Option<i64>,
    ) -> AppResult<FileInfo> {
        let now = Utc::now().timestamp();

        let existing = self.get(id).await?;
        let file =
            existing.ok_or_else(|| AppError::NotFound(format!("File does not exist: {}", id)))?;

        let new_name = name.unwrap_or(&file.name);
        let new_size = size_bytes.or(file.size_bytes);

        sqlx::query(
            r#"
            UPDATE files 
            SET name = ?, size_bytes = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(new_name)
        .bind(new_size)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(e.to_string()))?;

        self.get(id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("File does not exist: {}", id)))
    }

    /// 删除文件记录
    pub async fn delete(&self, id: &str) -> AppResult<()> {
        let result = sqlx::query("DELETE FROM files WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(AppError::NotFound(format!("File does not exist: {}", id)));
        }

        Ok(())
    }

    /// 删除指定 Agent 的所有文件记录
    pub async fn delete_by_agent(&self, agent_id: &str) -> AppResult<u64> {
        let result = sqlx::query("DELETE FROM files WHERE agent_id = ?")
            .bind(agent_id)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(result.rows_affected())
    }

    /// 检查文件路径是否已存在
    pub async fn exists_by_path(&self, path: &str) -> AppResult<bool> {
        let result: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM files WHERE path = ?")
            .bind(path)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(result.0 > 0)
    }

    /// 获取 Agent 文件总大小
    pub async fn get_total_size(&self, agent_id: &str) -> AppResult<i64> {
        let result: (Option<i64>,) =
            sqlx::query_as("SELECT SUM(size_bytes) FROM files WHERE agent_id = ?")
                .bind(agent_id)
                .fetch_one(&self.pool)
                .await
                .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(result.0.unwrap_or(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::agent_repo::AgentRepository;
    use crate::db::hub_repo::HubRepository;
    use crate::db::schema::{create_pool, initialize_schema};

    async fn setup_test_db() -> (HubRepository, AgentRepository, FileRepository) {
        let pool = create_pool("sqlite::memory:").await.unwrap();
        initialize_schema(&pool).await.unwrap();
        (
            HubRepository::new(pool.clone()),
            AgentRepository::new(pool.clone()),
            FileRepository::new(pool),
        )
    }

    #[tokio::test]
    async fn test_create_file() {
        let (hub_repo, agent_repo, file_repo) = setup_test_db().await;

        let hub = hub_repo.create("测试 Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "测试 Agent").await.unwrap();

        let file = file_repo
            .create(
                &agent.id,
                "readme.md",
                "/path/to/readme.md",
                "markdown",
                Some(1024),
            )
            .await
            .unwrap();

        assert!(!file.id.is_empty());
        assert_eq!(file.name, "readme.md");
        assert_eq!(file.size_bytes, Some(1024));
    }

    #[tokio::test]
    async fn test_list_by_type() {
        let (hub_repo, agent_repo, file_repo) = setup_test_db().await;

        let hub = hub_repo.create("测试 Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "测试 Agent").await.unwrap();

        file_repo
            .create(&agent.id, "file1.md", "/p1", "markdown", None)
            .await
            .unwrap();
        file_repo
            .create(&agent.id, "file2.md", "/p2", "markdown", None)
            .await
            .unwrap();
        file_repo
            .create(&agent.id, "code.rs", "/p3", "code", None)
            .await
            .unwrap();

        let md_files = file_repo.list_by_type(&agent.id, "markdown").await.unwrap();
        let code_files = file_repo.list_by_type(&agent.id, "code").await.unwrap();

        assert_eq!(md_files.len(), 2);
        assert_eq!(code_files.len(), 1);
    }

    #[tokio::test]
    async fn test_get_total_size() {
        let (hub_repo, agent_repo, file_repo) = setup_test_db().await;

        let hub = hub_repo.create("测试 Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "测试 Agent").await.unwrap();

        file_repo
            .create(&agent.id, "f1", "/p1", "md", Some(100))
            .await
            .unwrap();
        file_repo
            .create(&agent.id, "f2", "/p2", "md", Some(200))
            .await
            .unwrap();
        file_repo
            .create(&agent.id, "f3", "/p3", "md", Some(300))
            .await
            .unwrap();

        let total = file_repo.get_total_size(&agent.id).await.unwrap();

        assert_eq!(total, 600);
    }
}
