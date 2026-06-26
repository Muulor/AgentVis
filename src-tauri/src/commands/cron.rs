//! 定时任务（CronJob）相关 Tauri Commands
//!
//! 提供定时任务的 CRUD 操作命令

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::models::{CronJobCreate, CronJobUpdate};
use crate::error::CommandResult;
use crate::AppState;

/// CronJob 前端响应项
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronJobItem {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    pub cron_expression: String,
    pub prompt: String,
    pub mode: String,
    pub enabled: bool,
    pub last_run_at: Option<i64>,
    pub next_run_at: Option<i64>,
    pub last_run_status: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<crate::db::models::CronJob> for CronJobItem {
    fn from(job: crate::db::models::CronJob) -> Self {
        Self {
            id: job.id,
            agent_id: job.agent_id,
            name: job.name,
            cron_expression: job.cron_expression,
            prompt: job.prompt,
            mode: job.mode,
            enabled: job.enabled,
            last_run_at: job.last_run_at,
            next_run_at: job.next_run_at,
            last_run_status: job.last_run_status,
            created_at: job.created_at,
            updated_at: job.updated_at,
        }
    }
}

/// 创建定时任务请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCronJobRequest {
    pub agent_id: String,
    pub name: String,
    pub cron_expression: String,
    pub prompt: String,
    pub enabled: Option<bool>,
    pub next_run_at: Option<i64>,
}

/// 更新定时任务请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCronJobRequest {
    pub name: Option<String>,
    pub cron_expression: Option<String>,
    pub prompt: Option<String>,
    pub enabled: Option<bool>,
    pub next_run_at: Option<i64>,
    pub last_run_at: Option<i64>,
    pub last_run_status: Option<String>,
}

/// 创建定时任务
#[tauri::command]
pub async fn cron_create(
    state: State<'_, AppState>,
    request: CreateCronJobRequest,
) -> CommandResult<CronJobItem> {
    let db = state.db.lock().await;
    let params = CronJobCreate {
        agent_id: request.agent_id,
        name: request.name,
        cron_expression: request.cron_expression,
        prompt: request.prompt,
        mode: "planning".to_string(),
        enabled: request.enabled,
        next_run_at: request.next_run_at,
    };
    let job = db.cron_repo().create(params).await?;
    Ok(job.into())
}

/// 列出某 Agent 的所有定时任务
#[tauri::command]
pub async fn cron_list_by_agent(
    state: State<'_, AppState>,
    agent_id: String,
) -> CommandResult<Vec<CronJobItem>> {
    let db = state.db.lock().await;
    let jobs = db.cron_repo().list_by_agent(&agent_id).await?;
    Ok(jobs.into_iter().map(|j| j.into()).collect())
}

/// 列出所有已启用的定时任务（调度器启动时加载）
#[tauri::command]
pub async fn cron_list_all_enabled(
    state: State<'_, AppState>,
) -> CommandResult<Vec<CronJobItem>> {
    let db = state.db.lock().await;
    let jobs = db.cron_repo().list_all_enabled().await?;
    Ok(jobs.into_iter().map(|j| j.into()).collect())
}

/// 更新定时任务
#[tauri::command]
pub async fn cron_update(
    state: State<'_, AppState>,
    id: String,
    request: UpdateCronJobRequest,
) -> CommandResult<CronJobItem> {
    let db = state.db.lock().await;
    let update = CronJobUpdate {
        name: request.name,
        cron_expression: request.cron_expression,
        prompt: request.prompt,
        mode: None,
        enabled: request.enabled,
        next_run_at: request.next_run_at,
        last_run_at: request.last_run_at,
        last_run_status: request.last_run_status,
    };
    let job = db.cron_repo().update(&id, update).await?;
    Ok(job.into())
}

/// 删除定时任务
#[tauri::command]
pub async fn cron_delete(
    state: State<'_, AppState>,
    id: String,
) -> CommandResult<()> {
    let db = state.db.lock().await;
    db.cron_repo().delete(&id).await?;
    Ok(())
}
