//! Hub 相关 Tauri Commands
//!
//! 提供 Hub (项目工作区) 的 CRUD 操作命令

use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{Manager, State};

use crate::db::{Hub, HubUpdate};
use crate::error::CommandResult;
use crate::AppState;

/// 重试次数上限
const RENAME_MAX_RETRIES: u32 = 3;
/// 每次重试之间的等待时间（毫秒）
const RENAME_RETRY_DELAY_MS: u64 = 200;

/// 健壮的目录重命名（重试 + copy fallback）
///
/// Windows 上文件夹内有文件被进程占用（如 Vite/node 子进程残留）时，
/// `std::fs::rename` 会返回 Access Denied (os error 5)。
/// 此函数的策略：
/// 1. 先尝试原子 rename，失败后等待短暂时间重试（最多 3 次）
/// 2. 如果重试全部失败，fallback 到 copy 整个目录 + 删除旧目录
/// 3. 如果 copy 也失败（文件锁极为顽固），仅记日志不阻塞
///
/// 返回 true 表示成功，false 表示失败
pub(crate) fn rename_directory_robust(old_path: &Path, new_path: &Path) -> bool {
    // 安全检查：旧路径不存在或新路径已存在时跳过
    if !old_path.exists() || new_path.exists() {
        return false;
    }

    // 策略 1：原子 rename + 重试
    for attempt in 1..=RENAME_MAX_RETRIES {
        match std::fs::rename(old_path, new_path) {
            Ok(()) => {
                log::info!(
                    "已重命名工作区（第 {} 次尝试）: {} -> {}",
                    attempt,
                    old_path.display(),
                    new_path.display()
                );
                return true;
            }
            Err(e) => {
                log::warn!(
                    "重命名工作区失败（第 {}/{} 次）: {} -> {} - {}",
                    attempt,
                    RENAME_MAX_RETRIES,
                    old_path.display(),
                    new_path.display(),
                    e
                );
                if attempt < RENAME_MAX_RETRIES {
                    std::thread::sleep(std::time::Duration::from_millis(RENAME_RETRY_DELAY_MS));
                }
            }
        }
    }

    // 策略 2：copy + delete fallback
    //
    // 注意：必须同时完成 copy 和 delete 才算成功。
    // 如果 copy 成功但 delete 失败（进程仍在占用旧目录），
    // 必须回滚新副本以避免产生两个重复目录导致 DB 路径不一致。
    log::info!(
        "rename 重试耗尽，尝试 copy + delete fallback: {} -> {}",
        old_path.display(),
        new_path.display()
    );

    match copy_dir_recursive(old_path, new_path) {
        Ok(()) => {
            // 尝试删除旧目录——只有删除成功时整个操作才算完成
            match std::fs::remove_dir_all(old_path) {
                Ok(()) => {
                    log::info!(
                        "copy + delete 成功: {} -> {}",
                        old_path.display(),
                        new_path.display()
                    );
                    true
                }
                Err(e) => {
                    // 旧目录删除失败（进程锁），回滚新副本，保持旧路径为唯一有效路径
                    log::warn!(
                        "删除旧目录失败（进程占用），回滚新副本: {} - {}",
                        old_path.display(),
                        e
                    );
                    let _ = std::fs::remove_dir_all(new_path);
                    log::warn!(
                        "重命名被阻止: 请先关闭 Vite 预览或其他占用工作区的进程，然后重试改名"
                    );
                    false
                }
            }
        }
        Err(e) => {
            // copy 失败时清理可能已部分创建的新目录
            log::warn!(
                "copy fallback 也失败: {} -> {} - {}",
                old_path.display(),
                new_path.display(),
                e
            );
            let _ = std::fs::remove_dir_all(new_path);
            false
        }
    }
}

/// 递归复制目录
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

/// 批量更新 diff_records 和 snapshots 中的 document_id 路径前缀
///
/// 当 Hub 或 Agent 重命名导致 deliverables 文件夹路径变化时，
/// 需要同步更新这两张表中引用旧路径的记录，否则重启恢复 diff 时会找不到文件。
/// 采用 best-effort 策略，失败仅记日志不阻塞。
pub(crate) async fn sync_document_id_paths(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    old_prefix: &str,
    new_prefix: &str,
) {
    let like_pattern = format!("{}%", old_prefix);

    // 更新 diff_records 中的路径
    match sqlx::query(
        "UPDATE diff_records SET document_id = REPLACE(document_id, ?1, ?2) WHERE document_id LIKE ?3"
    )
    .bind(old_prefix)
    .bind(new_prefix)
    .bind(&like_pattern)
    .execute(pool)
    .await
    {
        Ok(result) => {
            if result.rows_affected() > 0 {
                log::info!("已更新 {} 条 diff_records 的路径", result.rows_affected());
            }
        }
        Err(e) => log::warn!("更新 diff_records 路径失败: {}", e),
    }

    // 更新 snapshots 中的路径
    match sqlx::query(
        "UPDATE snapshots SET document_id = REPLACE(document_id, ?1, ?2) WHERE document_id LIKE ?3",
    )
    .bind(old_prefix)
    .bind(new_prefix)
    .bind(&like_pattern)
    .execute(pool)
    .await
    {
        Ok(result) => {
            if result.rows_affected() > 0 {
                log::info!("已更新 {} 条 snapshots 的路径", result.rows_affected());
            }
        }
        Err(e) => log::warn!("更新 snapshots 路径失败: {}", e),
    }
}

/// Hub 列表响应项
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubItem {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<Hub> for HubItem {
    fn from(hub: Hub) -> Self {
        Self {
            id: hub.id,
            name: hub.name,
            sort_order: hub.sort_order,
            created_at: hub.created_at,
            updated_at: hub.updated_at,
        }
    }
}

/// 创建 Hub 请求
#[derive(Debug, Deserialize)]
pub struct CreateHubRequest {
    pub name: String,
}

/// 更新 Hub 请求
#[derive(Debug, Deserialize)]
pub struct UpdateHubRequest {
    pub name: Option<String>,
}

/// Hub 排序更新请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderHubsRequest {
    pub ordered_ids: Vec<String>,
}

/// 创建新的 Hub
#[tauri::command]
pub async fn hub_create(
    state: State<'_, AppState>,
    request: CreateHubRequest,
) -> CommandResult<HubItem> {
    let db = state.db.lock().await;
    let hub = db.hub_repo().create(&request.name).await?;
    Ok(hub.into())
}

/// 获取所有 Hub 列表
#[tauri::command]
pub async fn hub_list(state: State<'_, AppState>) -> CommandResult<Vec<HubItem>> {
    let db = state.db.lock().await;
    let hubs = db.hub_repo().list().await?;
    Ok(hubs.into_iter().map(|h| h.into()).collect())
}

/// 获取单个 Hub
#[tauri::command]
pub async fn hub_get(state: State<'_, AppState>, id: String) -> CommandResult<Option<HubItem>> {
    let db = state.db.lock().await;
    let hub = db.hub_repo().get(&id).await?;
    Ok(hub.map(|h| h.into()))
}

/// 更新 Hub
///
/// 当名称变更时，同步重命名 deliverables 文件夹并更新关联表中的路径
#[tauri::command]
pub async fn hub_update(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    request: UpdateHubRequest,
) -> CommandResult<HubItem> {
    let db = state.db.lock().await;

    // 改名前获取旧名称，用于同步 deliverables 文件夹和关联路径
    let old_hub = db.hub_repo().get(&id).await?;

    let update = HubUpdate { name: request.name };
    let hub = db.hub_repo().update(&id, update).await?;

    // 同步 deliverables 文件夹名称和关联路径（best-effort）
    if let Some(old) = old_hub {
        let old_folder = super::agent::sanitize_folder_name(&old.name);
        let new_folder = super::agent::sanitize_folder_name(&hub.name);
        if old_folder != new_folder {
            if let Ok(base_dir) = app_handle.path().app_data_dir() {
                let old_path = base_dir.join("deliverables").join(&old_folder);
                let new_path = base_dir.join("deliverables").join(&new_folder);

                if rename_directory_robust(&old_path, &new_path) {
                    // 重命名成功后批量更新 diff_records 和 snapshots 中的 document_id 路径
                    let old_prefix = old_path.to_string_lossy().to_string();
                    let new_prefix = new_path.to_string_lossy().to_string();
                    sync_document_id_paths(db.pool(), &old_prefix, &new_prefix).await;
                }
            }
        }
    }

    Ok(hub.into())
}

/// 更新 Hub 排序
#[tauri::command]
pub async fn hub_reorder(
    state: State<'_, AppState>,
    request: ReorderHubsRequest,
) -> CommandResult<()> {
    let db = state.db.lock().await;
    db.hub_repo().reorder(&request.ordered_ids).await?;
    Ok(())
}

/// 删除 Hub (级联删除所有下属 Agent 和关联数据 + 清理工作区文件夹)
#[tauri::command]
pub async fn hub_delete(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> CommandResult<()> {
    let db = state.db.lock().await;

    // 在删除前查询 Hub 名称（用于拼接 deliverables 路径）
    let hub = db.hub_repo().get(&id).await?;
    let hub_folder = hub
        .as_ref()
        .map(|h| super::agent::sanitize_folder_name(&h.name));

    // 级联删除数据库数据（包括所有下属 Agent）
    db.hub_repo().cascade_delete(&id).await?;

    // 清理 deliverables 文件夹（best-effort，失败不阻塞）
    if let Some(folder_name) = hub_folder {
        if let Ok(base_dir) = app_handle.path().app_data_dir() {
            let hub_dir = base_dir.join("deliverables").join(&folder_name);
            if hub_dir.exists() {
                if let Err(e) = std::fs::remove_dir_all(&hub_dir) {
                    log::warn!("清理 Hub 工作区文件夹失败: {} - {}", hub_dir.display(), e);
                } else {
                    log::info!("已清理 Hub 工作区: {}", hub_dir.display());
                }
            }
        }
    }

    Ok(())
}
