//! Agent 相关 Tauri Commands
//!
//! 提供 Agent 的 CRUD 操作命令

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::db::{Agent, AgentUpdate};
use crate::error::{AppError, CommandResult};
use crate::AppState;

/// Agent 列表响应项
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentItem {
    pub id: String,
    pub hub_id: String,
    pub name: String,
    pub sort_order: i64,
    pub avatar_color: Option<String>,
    pub avatar: Option<String>,
    pub model_provider: Option<String>,
    pub model_name: Option<String>,
    pub mb_rules_file_path: Option<String>,
    pub sa_rules_file_path: Option<String>,
    pub mb_rules: Option<String>,
    pub sa_rules: Option<String>,
    pub chat_rules: Option<String>,
    pub knowledge_paths: Option<String>,
    pub auto_index_deliverables: Option<bool>,
    pub pinned_skills: Option<String>,
    pub planning_loop_budget: Option<i32>, // MB 最大决策轮次，NULL 表示使用全局默认
    pub project_path: Option<String>,      // 用户关联的外部项目路径
    pub sandbox_mode: Option<String>,      // 用户可见的三档沙箱权限
    pub sub_agent_safety_footer_enabled: Option<bool>, // Sub-Agent 每步 Safety Footer 实验开关
    pub sub_agent_safety_footer_text: Option<String>,  // Sub-Agent Safety Footer 自定义提示词
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<Agent> for AgentItem {
    fn from(agent: Agent) -> Self {
        Self {
            id: agent.id,
            hub_id: agent.hub_id,
            name: agent.name,
            sort_order: agent.sort_order,
            avatar_color: agent.avatar_color,
            avatar: agent.avatar,
            model_provider: agent.model_provider,
            model_name: agent.model_name,
            mb_rules_file_path: agent.mb_rules_file_path,
            sa_rules_file_path: agent.sa_rules_file_path,
            mb_rules: agent.mb_rules,
            sa_rules: agent.sa_rules,
            chat_rules: agent.chat_rules,
            knowledge_paths: agent.knowledge_paths,
            auto_index_deliverables: agent.auto_index_deliverables,
            pinned_skills: agent.pinned_skills,
            planning_loop_budget: agent.planning_loop_budget,
            project_path: agent.project_path,
            sandbox_mode: agent.sandbox_mode,
            sub_agent_safety_footer_enabled: agent.sub_agent_safety_footer_enabled,
            sub_agent_safety_footer_text: agent.sub_agent_safety_footer_text,
            created_at: agent.created_at,
            updated_at: agent.updated_at,
        }
    }
}

/// 创建 Agent 请求
#[derive(Debug, Deserialize)]
pub struct CreateAgentRequest {
    pub hub_id: String,
    pub name: String,
}

/// 更新 Agent 请求
#[derive(Debug, Deserialize)]
pub struct UpdateAgentRequest {
    pub name: Option<String>,
    pub avatar_color: Option<String>,
    pub avatar: Option<String>,
    pub model_provider: Option<String>,
    pub model_name: Option<String>,
    pub mb_rules_file_path: Option<String>,
    pub sa_rules_file_path: Option<String>,
    pub mb_rules: Option<String>,
    pub sa_rules: Option<String>,
    pub chat_rules: Option<String>,
    pub knowledge_paths: Option<String>,
    pub auto_index_deliverables: Option<bool>,
    pub pinned_skills: Option<String>,
    pub planning_loop_budget: Option<i32>, // 0 为哨兵值（重置为 NULL）
    pub project_path: Option<String>,      // 空字符串 = 清除绑定，None = 保持原值
    pub sandbox_mode: Option<String>,      // LocalAudit / OfflineIsolated / ControlledNetwork
    pub sub_agent_safety_footer_enabled: Option<bool>, // Sub-Agent 每步 Safety Footer 实验开关
    pub sub_agent_safety_footer_text: Option<String>, // Sub-Agent Safety Footer 自定义提示词
}

/// Agent 排序更新请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderAgentsRequest {
    pub hub_id: String,
    pub ordered_ids: Vec<String>,
}

/// 创建新的 Agent
#[tauri::command]
pub async fn agent_create(
    state: State<'_, AppState>,
    request: CreateAgentRequest,
) -> CommandResult<AgentItem> {
    let db = state.db.lock().await;
    let agent = db
        .agent_repo()
        .create(&request.hub_id, &request.name)
        .await?;
    Ok(agent.into())
}

/// 获取指定 Hub 下的所有 Agent
#[tauri::command]
pub async fn agent_list_by_hub(
    state: State<'_, AppState>,
    hub_id: String,
) -> CommandResult<Vec<AgentItem>> {
    let db = state.db.lock().await;
    let agents = db.agent_repo().list_by_hub(&hub_id).await?;
    Ok(agents.into_iter().map(|a| a.into()).collect())
}

/// 获取单个 Agent
#[tauri::command]
pub async fn agent_get(state: State<'_, AppState>, id: String) -> CommandResult<Option<AgentItem>> {
    let db = state.db.lock().await;
    let agent = db.agent_repo().get(&id).await?;
    Ok(agent.map(|a| a.into()))
}

/// 更新 Agent
///
/// 当名称变更时，同步重命名 deliverables 文件夹并更新关联表中的路径
#[tauri::command]
pub async fn agent_update(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    request: UpdateAgentRequest,
) -> CommandResult<AgentItem> {
    let db = state.db.lock().await;

    // 仅在名称变更时才查询旧信息，避免不必要的数据库访问
    let old_folder_info = if request.name.is_some() {
        if let Some(agent) = db.agent_repo().get(&id).await? {
            let hub = db.hub_repo().get(&agent.hub_id).await?;
            hub.map(|h| {
                (
                    sanitize_folder_name(&h.name),
                    sanitize_folder_name(&agent.name),
                )
            })
        } else {
            None
        }
    } else {
        None
    };

    if let Some(mode) = request.sandbox_mode.as_deref() {
        if !matches!(mode, "LocalAudit" | "OfflineIsolated" | "ControlledNetwork") {
            return Err(AppError::Forbidden(format!(
                "Unknown sandbox mode '{}'",
                mode
            )));
        }
    }

    let update = AgentUpdate {
        name: request.name,
        avatar_color: request.avatar_color,
        avatar: request.avatar,
        model_provider: request.model_provider,
        model_name: request.model_name,
        mb_rules_file_path: request.mb_rules_file_path,
        sa_rules_file_path: request.sa_rules_file_path,
        mb_rules: request.mb_rules,
        sa_rules: request.sa_rules,
        chat_rules: request.chat_rules,
        knowledge_paths: request.knowledge_paths,
        auto_index_deliverables: request.auto_index_deliverables,
        pinned_skills: request.pinned_skills,
        planning_loop_budget: request.planning_loop_budget, // 0 = 重置为 NULL，>0 = 设置值，None = 保持原值
        project_path: request.project_path,                 // 空字符串 = 清除绑定，None = 保持原值
        sandbox_mode: request.sandbox_mode,
        sub_agent_safety_footer_enabled: request.sub_agent_safety_footer_enabled,
        sub_agent_safety_footer_text: request.sub_agent_safety_footer_text,
    };
    let agent = db.agent_repo().update(&id, update).await?;

    // 同步 deliverables 文件夹名称和关联路径（best-effort）
    if let Some((hub_folder, old_agent_folder)) = old_folder_info {
        let new_agent_folder = sanitize_folder_name(&agent.name);
        if old_agent_folder != new_agent_folder {
            if let Ok(base_dir) = app_handle.path().app_data_dir() {
                let old_path = base_dir
                    .join("deliverables")
                    .join(&hub_folder)
                    .join(&old_agent_folder);
                let new_path = base_dir
                    .join("deliverables")
                    .join(&hub_folder)
                    .join(&new_agent_folder);

                if super::hub::rename_directory_robust(&old_path, &new_path) {
                    // 重命名成功后批量更新 diff_records 和 snapshots 中的 document_id 路径
                    let old_prefix = old_path.to_string_lossy().to_string();
                    let new_prefix = new_path.to_string_lossy().to_string();
                    super::hub::sync_document_id_paths(db.pool(), &old_prefix, &new_prefix).await;
                }
            }
        }
    }

    Ok(agent.into())
}

/// 更新 Agent 排序
#[tauri::command]
pub async fn agent_reorder(
    state: State<'_, AppState>,
    request: ReorderAgentsRequest,
) -> CommandResult<()> {
    let db = state.db.lock().await;
    db.agent_repo()
        .reorder(&request.hub_id, &request.ordered_ids)
        .await?;
    Ok(())
}

/// 删除 Agent (级联删除所有关联数据 + 清理工作区文件夹)
#[tauri::command]
pub async fn agent_delete(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> CommandResult<()> {
    let db = state.db.lock().await;

    // 在删除前查询 Agent 和 Hub 名称（用于拼接 deliverables 路径）
    let agent = db.agent_repo().get(&id).await?;
    let folder_info = if let Some(ref agent) = agent {
        let hub = db.hub_repo().get(&agent.hub_id).await?;
        hub.map(|h| {
            (
                sanitize_folder_name(&h.name),
                sanitize_folder_name(&agent.name),
            )
        })
    } else {
        None
    };

    // 级联删除数据库数据
    db.agent_repo().cascade_delete(&id).await?;

    // 清理 deliverables 文件夹（best-effort，失败不阻塞）
    if let Some((hub_folder, agent_folder)) = folder_info {
        if let Ok(base_dir) = app_handle.path().app_data_dir() {
            let agent_dir = base_dir
                .join("deliverables")
                .join(&hub_folder)
                .join(&agent_folder);
            if agent_dir.exists() {
                if let Err(e) = std::fs::remove_dir_all(&agent_dir) {
                    log::warn!(
                        "清理 Agent 工作区文件夹失败: {} - {}",
                        agent_dir.display(),
                        e
                    );
                } else {
                    log::info!("已清理 Agent 工作区: {}", agent_dir.display());
                }
            }
        }
    }

    Ok(())
}

/// 清理文件夹名称（与前端 sanitizeFolderName 保持一致）
pub(crate) fn sanitize_folder_name(name: &str) -> String {
    let result: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_whitespace() => '_',
            _ => c,
        })
        .collect();

    // 合并连续下划线，移除首尾下划线
    let collapsed: String = result
        .split('_')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("_");

    if collapsed.is_empty() {
        "unnamed".to_string()
    } else {
        collapsed
    }
}
