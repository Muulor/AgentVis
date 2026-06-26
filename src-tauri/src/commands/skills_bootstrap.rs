//! Skills Bootstrap 命令
//!
//! 职责：在首次启动（或 skills 版本更新）时，
//! 将安装包内嵌的 skills-bundle/ 目录自动复制到 AppData 下的运行时目录。
//!
//! 设计说明：
//! - 首次安装：packages 目录不存在或为空 → 全量部署
//! - 版本更新：通过 .bundle_version 文件比较应用版本 → 逐 skill 清理后替换
//!   仅覆盖 bundle 中存在的 skill，保留用户手动安装的 skill
//! - resources 目录在开发模式下由 Tauri 解析到 src-tauri/ 下；
//!   Release 模式下解析到安装包内嵌路径
//! - 目标路径：{AppDataDir}/skills/external/packages/

use crate::error::AppError;
use std::fs::DirEntry;
use std::path::{Path, PathBuf};
use tauri::Manager;

type CommandResult<T> = Result<T, AppError>;

/// 版本戳文件名，存放在 packages 目录根部，记录上次部署时的应用版本
const BUNDLE_VERSION_FILE: &str = ".bundle_version";
const BUNDLE_REVISION_FILE: &str = ".bundle_revision";

/// Skills 部署结果
#[derive(Debug, serde::Serialize)]
pub struct SkillsBootstrapResult {
    /// true 表示本次执行了复制；false 表示目录已存在，跳过
    pub deployed: bool,
    /// 目标 packages 目录的绝对路径
    pub packages_dir: String,
    /// 部署的 skill 包数量（仅 deployed=true 时有意义）
    pub skill_count: usize,
}

/// 检查并部署内置 skills（支持版本更新覆盖）
///
/// 调用时机：前端应用启动时通过 invoke 调用一次。
///
/// 部署策略：
/// 1. 首次安装（packages 目录不存在或为空）→ 全量部署所有 bundle skill
/// 2. 版本更新（.bundle_version 文件中记录的版本与当前应用版本不同）
///    → 逐 skill 删除旧目录后复制 bundle 中存在的 skill，保留用户额外安装的 skill
/// 3. 版本一致 → 跳过，无额外开销
#[tauri::command]
pub async fn bootstrap_skills_if_needed(
    app: tauri::AppHandle,
) -> CommandResult<SkillsBootstrapResult> {
    // 目标目录：AppData/skills/external/packages/
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::FileSystem(format!("Failed to get AppDataDir: {}", e)))?;

    let packages_dir = app_data_dir
        .join("skills")
        .join("external")
        .join("packages");

    // 获取 resource_dir（开发模式 → src-tauri/，Release → 安装包 resources）
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| AppError::FileSystem(format!("Failed to get resource_dir: {}", e)))?;

    let bundle_dir = resource_dir.join("skills-bundle");

    if !bundle_dir.exists() {
        // 开发模式下 resource_dir 可能未包含 skills-bundle，不报错仅记录
        log::warn!(
            "[SkillsBootstrap] skills-bundle 目录不存在（仅 Release 包含此目录）: {}",
            bundle_dir.display()
        );
        return Ok(SkillsBootstrapResult {
            deployed: false,
            packages_dir: packages_dir.to_string_lossy().to_string(),
            skill_count: 0,
        });
    }

    // 获取当前应用版本（来自 tauri.conf.json 的 version 字段）
    let current_version = app.config().version.clone().unwrap_or_default();

    // 判断部署模式：首次安装 vs 版本更新 vs 跳过。
    // 版本号一致但 bundle 新增 skill 时，只补齐缺失包，方便开发阶段验证临时内置 skill。
    let mut deploy_mode = determine_deploy_mode(&packages_dir, &current_version);
    if matches!(&deploy_mode, DeployMode::Skip)
        && bundle_needs_same_version_sync(&bundle_dir, &packages_dir)
    {
        deploy_mode = DeployMode::SyncMissing;
    }

    match &deploy_mode {
        DeployMode::Skip => {
            log::debug!(
                "[SkillsBootstrap] 版本一致（{}），跳过部署",
                current_version
            );
            return Ok(SkillsBootstrapResult {
                deployed: false,
                packages_dir: packages_dir.to_string_lossy().to_string(),
                skill_count: 0,
            });
        }
        DeployMode::Fresh => {
            log::info!("[SkillsBootstrap] 首次安装，执行全量部署");
        }
        DeployMode::Upgrade { from_version } => {
            log::info!(
                "[SkillsBootstrap] 版本更新（{} → {}），执行清理后替换",
                from_version,
                current_version
            );
        }
        DeployMode::SyncMissing => {
            log::info!("[SkillsBootstrap] 版本一致但内置 skill 需要增量同步");
        }
    }

    // 确保目标目录存在
    std::fs::create_dir_all(&packages_dir)
        .map_err(|e| AppError::FileSystem(format!("Failed to create packages directory: {}", e)))?;

    // 遍历 skills-bundle/ 下每个子目录（即每个 skill 包），逐个部署
    let entries = std::fs::read_dir(&bundle_dir).map_err(|e| {
        AppError::FileSystem(format!("Failed to read skills-bundle directory: {}", e))
    })?;

    let mut skill_count = 0usize;

    for entry_result in entries {
        let entry: DirEntry = match entry_result {
            Ok(e) => e,
            Err(_) => continue,
        };
        let src: PathBuf = entry.path();
        if !src.is_dir() {
            continue; // skills-bundle 顶层只有目录，跳过文件
        }

        let dir_name = entry.file_name();
        let dest = packages_dir.join(&dir_name);
        let needs_same_version_sync = bundle_skill_needs_same_version_sync(&src, &dest);

        if dest.exists()
            && matches!(&deploy_mode, DeployMode::SyncMissing)
            && !needs_same_version_sync
        {
            continue;
        }

        // 清理后替换，确保 bundle 新包与目标目录完全一致，避免旧文件残留被静态扫描命中。
        match replace_dir_all(&src, &dest) {
            Ok(_) => {
                skill_count += 1;
                log::info!(
                    "[SkillsBootstrap] 已部署 skill: {}",
                    dir_name.to_string_lossy()
                );
            }
            Err(e) => {
                // 单个 skill 复制failed不阻断其他
                log::warn!(
                    "[SkillsBootstrap] skill {} 替换failed: {}",
                    dir_name.to_string_lossy(),
                    e
                );
            }
        }
    }

    // 写入版本戳文件，标记当前部署版本
    write_version_stamp(&packages_dir, &current_version);

    log::info!(
        "[SkillsBootstrap] 部署完成，共 {} 个 skill 包已部署到 {}",
        skill_count,
        packages_dir.display()
    );

    Ok(SkillsBootstrapResult {
        deployed: skill_count > 0,
        packages_dir: packages_dir.to_string_lossy().to_string(),
        skill_count,
    })
}

// ─── 内部类型与辅助函数 ────────────────────────────────────────────

/// 部署模式
enum DeployMode {
    /// packages 目录已存在且版本一致，无需操作
    Skip,
    /// 首次安装（目录不存在或为空）
    Fresh,
    /// 版本更新（旧版本 → 当前版本），需覆盖 bundle 中的 skill
    Upgrade { from_version: String },
    /// 版本一致但 bundle 中有缺失或标记过 revision 的 skill，需要增量同步
    SyncMissing,
}

/// 根据本地版本戳判断部署模式
///
/// 判断逻辑：
/// 1. packages 目录不存在或为空 → Fresh
/// 2. 版本戳文件不存在（旧版应用升级到新版） → Upgrade（from "unknown"）
/// 3. 版本戳内容与当前版本一致 → Skip
/// 4. 版本戳内容与当前版本不同 → Upgrade
fn determine_deploy_mode(packages_dir: &Path, current_version: &str) -> DeployMode {
    // 目录不存在 → 首次安装
    if !packages_dir.exists() {
        return DeployMode::Fresh;
    }

    // 目录存在但为空 → 首次安装
    let is_empty = std::fs::read_dir(packages_dir)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(true);
    if is_empty {
        return DeployMode::Fresh;
    }

    // 读取版本戳文件
    let version_file = packages_dir.join(BUNDLE_VERSION_FILE);
    match std::fs::read_to_string(&version_file) {
        Ok(stored_version) => {
            let stored = stored_version.trim();
            if stored == current_version {
                DeployMode::Skip
            } else {
                DeployMode::Upgrade {
                    from_version: stored.to_string(),
                }
            }
        }
        Err(_) => {
            // 版本戳文件不存在 → 旧版应用（没有版本追踪机制）升级到新版
            DeployMode::Upgrade {
                from_version: "unknown".to_string(),
            }
        }
    }
}

/// 检查同版本下是否需要补齐或刷新内置 skill。
fn bundle_needs_same_version_sync(bundle_dir: &Path, packages_dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(bundle_dir) else {
        return false;
    };

    entries.filter_map(Result::ok).any(|entry| {
        let src = entry.path();
        src.is_dir()
            && bundle_skill_needs_same_version_sync(&src, &packages_dir.join(entry.file_name()))
    })
}

fn bundle_skill_needs_same_version_sync(src: &Path, dest: &Path) -> bool {
    if !dest.exists() {
        return true;
    }

    let src_revision = src.join(BUNDLE_REVISION_FILE);
    if !src_revision.exists() {
        return false;
    }

    let dest_revision = dest.join(BUNDLE_REVISION_FILE);
    match (
        std::fs::read_to_string(&src_revision),
        std::fs::read_to_string(&dest_revision),
    ) {
        (Ok(src_value), Ok(dest_value)) => src_value.trim() != dest_value.trim(),
        (Ok(_), Err(_)) => true,
        _ => false,
    }
}

/// 写入版本戳文件到 packages 目录
fn write_version_stamp(packages_dir: &Path, version: &str) {
    let version_file = packages_dir.join(BUNDLE_VERSION_FILE);
    if let Err(e) = std::fs::write(&version_file, version) {
        // 写入failed不阻断部署流程，仅记录警告
        // 下次启动会因缺少版本戳再次触发部署（安全但有冗余开销）
        log::warn!("[SkillsBootstrap] 写入版本戳文件failed: {}", e);
    }
}

/// 清理后递归复制目录（src → dest）。
///
/// 目标路径存在时会先删除旧目录/文件，确保更新后的 bundled skill 不残留旧文件。
fn replace_dir_all(src: &Path, dest: &Path) -> Result<(), String> {
    remove_existing_path(dest)?;
    copy_dir_all(src, dest)
}

fn remove_existing_path(path: &Path) -> Result<(), String> {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return Ok(());
    };

    if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
        std::fs::remove_dir_all(path)
            .map_err(|e| format!("Failed to remove directory {}: {}", path.display(), e))?;
    } else {
        std::fs::remove_file(path)
            .map_err(|e| format!("Failed to remove file {}: {}", path.display(), e))?;
    }

    Ok(())
}

/// 递归复制目录（src → dest）。
fn copy_dir_all(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest)
        .map_err(|e| format!("Failed to create directory {}: {}", dest.display(), e))?;

    let entries = std::fs::read_dir(src)
        .map_err(|e| format!("Failed to read directory {}: {}", src.display(), e))?;

    for entry_result in entries {
        let entry: DirEntry = match entry_result {
            Ok(e) => e,
            Err(_) => continue,
        };
        let src_path: PathBuf = entry.path();
        let dest_path = dest.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_all(&src_path, &dest_path)?;
        } else {
            std::fs::copy(&src_path, &dest_path).map_err(|e| {
                format!(
                    "Failed to copy file {} -> {}: {}",
                    src_path.display(),
                    dest_path.display(),
                    e
                )
            })?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be valid")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "agentvis-skills-bootstrap-{}-{}-{}",
            name,
            std::process::id(),
            nanos
        ))
    }

    #[test]
    fn replace_dir_all_removes_stale_files_from_previous_bundle() {
        let root = temp_root("replace");
        let src = root.join("bundle").join("desktop-control");
        let dest = root.join("packages").join("desktop-control");
        std::fs::create_dir_all(src.join("scripts")).expect("create bundle scripts");
        std::fs::create_dir_all(dest.join("scripts")).expect("create installed scripts");
        std::fs::create_dir_all(dest.join("legacy")).expect("create legacy dir");
        std::fs::write(src.join("SKILL.md"), "# Desktop Control\n").expect("write bundled skill");
        std::fs::write(src.join("scripts").join("new_entry.py"), "print('new')\n")
            .expect("write new script");
        std::fs::write(dest.join("scripts").join("old_entry.py"), "print('old')\n")
            .expect("write stale script");
        std::fs::write(
            dest.join("legacy").join("old_helper.py"),
            "print('legacy')\n",
        )
        .expect("write stale helper");

        replace_dir_all(&src, &dest).expect("replace skill directory");

        assert!(dest.join("SKILL.md").exists());
        assert!(dest.join("scripts").join("new_entry.py").exists());
        assert!(!dest.join("scripts").join("old_entry.py").exists());
        assert!(!dest.join("legacy").exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn replace_dir_all_handles_file_at_destination_path() {
        let root = temp_root("replace-file");
        let src = root.join("bundle").join("github-lookup");
        let dest = root.join("packages").join("github-lookup");
        std::fs::create_dir_all(&src).expect("create bundled skill");
        std::fs::create_dir_all(dest.parent().expect("dest should have parent"))
            .expect("create packages dir");
        std::fs::write(src.join("SKILL.md"), "# GitHub Lookup\n").expect("write bundled skill");
        std::fs::write(&dest, "stale file").expect("write stale file at dest");

        replace_dir_all(&src, &dest).expect("replace stale file with skill directory");

        assert!(dest.is_dir());
        assert!(dest.join("SKILL.md").exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn same_version_sync_detects_missing_bundle_skill() {
        let root = temp_root("missing");
        let bundle_skill = root.join("bundle").join("broker-e2e");
        let packages = root.join("packages");
        std::fs::create_dir_all(&bundle_skill).expect("create bundled skill");
        std::fs::create_dir_all(&packages).expect("create packages dir");

        assert!(bundle_needs_same_version_sync(
            &root.join("bundle"),
            &packages
        ));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn same_version_sync_uses_bundle_revision_marker() {
        let root = temp_root("revision");
        let bundle_skill = root.join("bundle").join("github-lookup");
        let package_skill = root.join("packages").join("github-lookup");
        std::fs::create_dir_all(&bundle_skill).expect("create bundled skill");
        std::fs::create_dir_all(&package_skill).expect("create package skill");

        assert!(!bundle_needs_same_version_sync(
            &root.join("bundle"),
            &root.join("packages")
        ));

        std::fs::write(bundle_skill.join(BUNDLE_REVISION_FILE), "v2\n")
            .expect("write bundled revision");
        std::fs::write(package_skill.join(BUNDLE_REVISION_FILE), "v1\n")
            .expect("write package revision");

        assert!(bundle_needs_same_version_sync(
            &root.join("bundle"),
            &root.join("packages")
        ));

        std::fs::write(package_skill.join(BUNDLE_REVISION_FILE), "v2\n")
            .expect("write matching package revision");

        assert!(!bundle_needs_same_version_sync(
            &root.join("bundle"),
            &root.join("packages")
        ));

        let _ = std::fs::remove_dir_all(root);
    }
}
