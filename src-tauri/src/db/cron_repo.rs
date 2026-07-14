//! CronJob 数据访问层
//!
//! 提供定时任务实体的 CRUD 操作

use chrono::Utc;
use sqlx::{Pool, Sqlite};
use uuid::Uuid;

use super::models::{CronJob, CronJobCreate, CronJobUpdate};
use crate::error::{AppError, AppResult};

/// CronJob Repository - 管理定时任务数据访问
pub struct CronJobRepository {
    pool: Pool<Sqlite>,
}

impl CronJobRepository {
    /// 创建新的 CronJobRepository 实例
    pub fn new(pool: Pool<Sqlite>) -> Self {
        Self { pool }
    }

    /// 创建新的定时任务
    ///
    /// # Arguments
    /// * `params` - 创建参数
    ///
    /// # Returns
    /// 创建成功的 CronJob 实体
    pub async fn create(&self, params: CronJobCreate) -> AppResult<CronJob> {
        let now = Utc::now().timestamp_millis();
        let id = Uuid::new_v4().to_string();

        sqlx::query(
            r#"
            INSERT INTO cron_jobs (id, agent_id, name, cron_expression, prompt, mode, enabled, next_run_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&params.agent_id)
        .bind(&params.name)
        .bind(&params.cron_expression)
        .bind(&params.prompt)
        .bind(&params.mode)
        .bind(params.enabled.unwrap_or(true))
        .bind(params.next_run_at)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to create cron job: {}", e)))?;

        self.get(&id)
            .await?
            .ok_or_else(|| AppError::Database("Unable to read cron job after creation".to_string()))
    }

    /// 根据 ID 获取定时任务
    pub async fn get(&self, id: &str) -> AppResult<Option<CronJob>> {
        let job = sqlx::query_as::<_, CronJob>("SELECT * FROM cron_jobs WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| AppError::Database(format!("Failed to query cron job: {}", e)))?;

        Ok(job)
    }

    /// 列出某 Agent 的所有定时任务
    ///
    /// # Arguments
    /// * `agent_id` - Agent ID
    ///
    /// # Returns
    /// 定时任务列表，按创建时间降序排列
    pub async fn list_by_agent(&self, agent_id: &str) -> AppResult<Vec<CronJob>> {
        let jobs = sqlx::query_as::<_, CronJob>(
            "SELECT * FROM cron_jobs WHERE agent_id = ? ORDER BY created_at DESC",
        )
        .bind(agent_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to query Agent cron jobs: {}", e)))?;

        Ok(jobs)
    }

    /// 列出所有已启用的定时任务（调度器启动时加载）
    pub async fn list_all_enabled(&self) -> AppResult<Vec<CronJob>> {
        let jobs = sqlx::query_as::<_, CronJob>(
            "SELECT * FROM cron_jobs WHERE enabled = 1 ORDER BY next_run_at ASC",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to query enabled cron jobs: {}", e)))?;

        Ok(jobs)
    }

    /// 更新定时任务
    ///
    /// # Arguments
    /// * `id` - 任务 ID
    /// * `update` - 更新数据（仅非 None 字段会被更新）
    pub async fn update(&self, id: &str, update: CronJobUpdate) -> AppResult<CronJob> {
        let now = Utc::now().timestamp_millis();

        // 先获取当前任务，确认存在
        let existing = self
            .get(id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Cron job does not exist: {}", id)))?;

        // 合并更新字段
        let name = update.name.unwrap_or(existing.name);
        let cron_expression = update.cron_expression.unwrap_or(existing.cron_expression);
        let prompt = update.prompt.unwrap_or(existing.prompt);
        let mode = update.mode.unwrap_or(existing.mode);
        let enabled = update.enabled.unwrap_or(existing.enabled);
        let next_run_at = if update.next_run_at.is_some() {
            update.next_run_at
        } else {
            existing.next_run_at
        };
        let last_run_at = if update.last_run_at.is_some() {
            update.last_run_at
        } else {
            existing.last_run_at
        };
        let last_run_status = if update.last_run_status.is_some() {
            update.last_run_status
        } else {
            existing.last_run_status
        };

        sqlx::query(
            r#"
            UPDATE cron_jobs
            SET name = ?, cron_expression = ?, prompt = ?, mode = ?,
                enabled = ?, next_run_at = ?, last_run_at = ?,
                last_run_status = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(&name)
        .bind(&cron_expression)
        .bind(&prompt)
        .bind(&mode)
        .bind(enabled)
        .bind(next_run_at)
        .bind(last_run_at)
        .bind(&last_run_status)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Database(format!("Failed to update cron job: {}", e)))?;

        self.get(id)
            .await?
            .ok_or_else(|| AppError::Database("Unable to read cron job after update".to_string()))
    }

    /// 删除定时任务
    pub async fn delete(&self, id: &str) -> AppResult<()> {
        let result = sqlx::query("DELETE FROM cron_jobs WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Database(format!("Failed to delete cron job: {}", e)))?;

        if result.rows_affected() == 0 {
            return Err(AppError::NotFound(format!(
                "Cron job does not exist: {}",
                id
            )));
        }

        Ok(())
    }

    /// 删除某 Agent 的所有定时任务（级联删除时使用）
    pub async fn delete_by_agent(&self, agent_id: &str) -> AppResult<u64> {
        let result = sqlx::query("DELETE FROM cron_jobs WHERE agent_id = ?")
            .bind(agent_id)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Database(format!("Failed to delete Agent cron jobs: {}", e)))?;

        Ok(result.rows_affected())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::agent_repo::AgentRepository;
    use crate::db::hub_repo::HubRepository;
    use crate::db::schema::{create_pool, initialize_schema};

    async fn setup_test_db() -> (HubRepository, AgentRepository, CronJobRepository) {
        let pool = create_pool("sqlite::memory:").await.unwrap();
        initialize_schema(&pool).await.unwrap();
        (
            HubRepository::new(pool.clone()),
            AgentRepository::new(pool.clone()),
            CronJobRepository::new(pool),
        )
    }

    #[tokio::test]
    async fn test_create_cron_job() {
        let (hub_repo, agent_repo, cron_repo) = setup_test_db().await;
        let hub = hub_repo.create("测试Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "测试Agent").await.unwrap();

        let job = cron_repo
            .create(CronJobCreate {
                agent_id: agent.id.clone(),
                name: "每日新闻".to_string(),
                cron_expression: "0 9 * * *".to_string(),
                prompt: "帮我搜集AI新闻".to_string(),
                mode: "planning".to_string(),
                enabled: Some(true),
                next_run_at: None,
            })
            .await
            .unwrap();

        assert_eq!(job.name, "每日新闻");
        assert_eq!(job.agent_id, agent.id);
        assert!(job.enabled);
    }

    #[tokio::test]
    async fn test_list_by_agent() {
        let (hub_repo, agent_repo, cron_repo) = setup_test_db().await;
        let hub = hub_repo.create("测试Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "测试Agent").await.unwrap();

        cron_repo
            .create(CronJobCreate {
                agent_id: agent.id.clone(),
                name: "任务1".to_string(),
                cron_expression: "0 9 * * *".to_string(),
                prompt: "提示词1".to_string(),
                mode: "planning".to_string(),
                enabled: Some(true),
                next_run_at: None,
            })
            .await
            .unwrap();

        cron_repo
            .create(CronJobCreate {
                agent_id: agent.id.clone(),
                name: "任务2".to_string(),
                cron_expression: "0 18 * * *".to_string(),
                prompt: "提示词2".to_string(),
                mode: "chat".to_string(),
                enabled: Some(false),
                next_run_at: None,
            })
            .await
            .unwrap();

        let jobs = cron_repo.list_by_agent(&agent.id).await.unwrap();
        assert_eq!(jobs.len(), 2);
    }

    #[tokio::test]
    async fn test_update_cron_job() {
        let (hub_repo, agent_repo, cron_repo) = setup_test_db().await;
        let hub = hub_repo.create("测试Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "测试Agent").await.unwrap();

        let job = cron_repo
            .create(CronJobCreate {
                agent_id: agent.id.clone(),
                name: "原始名称".to_string(),
                cron_expression: "0 9 * * *".to_string(),
                prompt: "原始提示词".to_string(),
                mode: "planning".to_string(),
                enabled: Some(true),
                next_run_at: None,
            })
            .await
            .unwrap();

        let updated = cron_repo
            .update(
                &job.id,
                CronJobUpdate {
                    name: Some("新名称".to_string()),
                    enabled: Some(false),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        assert_eq!(updated.name, "新名称");
        assert!(!updated.enabled);
        // 未更新的字段应保持原值
        assert_eq!(updated.prompt, "原始提示词");
    }

    #[tokio::test]
    async fn test_delete_cron_job() {
        let (hub_repo, agent_repo, cron_repo) = setup_test_db().await;
        let hub = hub_repo.create("测试Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "测试Agent").await.unwrap();

        let job = cron_repo
            .create(CronJobCreate {
                agent_id: agent.id.clone(),
                name: "待删除".to_string(),
                cron_expression: "0 9 * * *".to_string(),
                prompt: "提示词".to_string(),
                mode: "planning".to_string(),
                enabled: Some(true),
                next_run_at: None,
            })
            .await
            .unwrap();

        cron_repo.delete(&job.id).await.unwrap();
        let result = cron_repo.get(&job.id).await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_list_all_enabled() {
        let (hub_repo, agent_repo, cron_repo) = setup_test_db().await;
        let hub = hub_repo.create("测试Hub").await.unwrap();
        let agent = agent_repo.create(&hub.id, "测试Agent").await.unwrap();

        // 创建一个启用的和一个禁用的
        cron_repo
            .create(CronJobCreate {
                agent_id: agent.id.clone(),
                name: "启用任务".to_string(),
                cron_expression: "0 9 * * *".to_string(),
                prompt: "提示词".to_string(),
                mode: "planning".to_string(),
                enabled: Some(true),
                next_run_at: None,
            })
            .await
            .unwrap();

        cron_repo
            .create(CronJobCreate {
                agent_id: agent.id.clone(),
                name: "禁用任务".to_string(),
                cron_expression: "0 18 * * *".to_string(),
                prompt: "提示词".to_string(),
                mode: "chat".to_string(),
                enabled: Some(false),
                next_run_at: None,
            })
            .await
            .unwrap();

        let enabled = cron_repo.list_all_enabled().await.unwrap();
        assert_eq!(enabled.len(), 1);
        assert_eq!(enabled[0].name, "启用任务");
    }
}
