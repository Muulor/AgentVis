//! 技能包安装模块
//!
//! 从 GitHub 下载技能包并安装到 packages/ 目录。
//! 支持两种 URL 格式：
//! - 仓库子目录: `https://github.com/{owner}/{repo}/tree/{branch}/{path}`
//! - 仓库根目录: `https://github.com/{owner}/{repo}`
//!
//! Download strategy:
//! 1. Try the GitHub Contents API first, downloading only the requested files.
//! 2. If the API fails, fall back to GitHub archive ZIP and extract the requested subpath.

use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::{Component, Path, PathBuf};

use crate::crypto::{Keystore, WindowsKeystore};
use crate::error::{AppError, CommandResult};
use crate::text_utils::safe_truncate;

const GITHUB_PROVIDER: &str = "github";
const INVALID_SKILL_PACKAGE_PREFIX: &str = "SKILL_INSTALL_INVALID";

// ==================== 类型定义 ====================

/// GitHub URL 解析结果
#[derive(Debug)]
struct GitHubUrlParts {
    /// 仓库所有者
    owner: String,
    /// 仓库名
    repo: String,
    /// 分支名
    branch: String,
    /// 仓库内子路径（空 = 整个仓库）
    sub_path: String,
    /// 技能包名称（子路径最后一段或仓库名）
    skill_name: String,
}

/// 安装请求参数
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallParams {
    /// GitHub URL
    pub github_url: String,
    /// packages/ 目录绝对路径
    pub packages_dir: String,
}

/// 安装结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallResult {
    /// 技能包名称
    pub skill_name: String,
    /// 写入的文件数量
    pub files_written: usize,
    /// 安装路径
    pub package_path: String,
}

/// GitHub Contents API 返回的条目
#[derive(Debug, Deserialize)]
struct GitHubContentEntry {
    /// 条目名称
    name: String,
    /// 条目类型：file 或 dir
    #[serde(rename = "type")]
    entry_type: String,
    /// 文件下载 URL（仅 file 类型有）
    download_url: Option<String>,
    /// 目录路径（用于递归请求）
    path: String,
}

// ==================== URL 解析 ====================

/// 解析 GitHub URL 为结构化部分
///
/// 支持格式：
/// - `https://github.com/owner/repo/tree/branch/path/to/skill`
/// - `https://github.com/owner/repo`（默认 main 分支，整个仓库）
fn parse_github_url(url: &str) -> Result<GitHubUrlParts, AppError> {
    // 移除尾部斜杠
    let url = url.trim_end_matches('/');

    // 验证是 GitHub URL
    let path = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("github.com/"))
        .ok_or_else(|| AppError::Generic("Invalid GitHub URL".to_string()))?;

    let segments: Vec<&str> = path.split('/').collect();

    if segments.len() < 2 {
        return Err(AppError::Generic(
            "Invalid GitHub URL format. At least owner/repo is required.".to_string(),
        ));
    }

    let owner = segments[0].to_string();
    let repo = segments[1].to_string();

    // 格式 1: owner/repo/tree/branch/path/...
    if segments.len() >= 4 && segments[2] == "tree" {
        let branch = segments[3].to_string();
        let sub_path = if segments.len() > 4 {
            segments[4..].join("/")
        } else {
            String::new()
        };

        // 技能名 = 子路径最后一段，若无子路径则用仓库名
        let skill_name = if sub_path.is_empty() {
            repo.clone()
        } else {
            sub_path.rsplit('/').next().unwrap_or(&repo).to_string()
        };

        return Ok(GitHubUrlParts {
            owner,
            repo,
            branch,
            sub_path,
            skill_name,
        });
    }

    // 格式 2: owner/repo（默认 main 分支）
    Ok(GitHubUrlParts {
        owner,
        repo: repo.clone(),
        branch: "main".to_string(),
        sub_path: String::new(),
        skill_name: repo,
    })
}

// ==================== GitHub Contents API 下载 ====================

/// 构造 GitHub Contents API URL
///
/// API 文档: https://docs.github.com/en/rest/repos/contents
fn build_contents_api_url(parts: &GitHubUrlParts) -> String {
    if parts.sub_path.is_empty() {
        format!(
            "https://api.github.com/repos/{}/{}/contents?ref={}",
            parts.owner, parts.repo, parts.branch
        )
    } else {
        format!(
            "https://api.github.com/repos/{}/{}/contents/{}?ref={}",
            parts.owner, parts.repo, parts.sub_path, parts.branch
        )
    }
}

fn build_archive_zip_url(parts: &GitHubUrlParts) -> String {
    format!(
        "https://codeload.github.com/{}/{}/zip/refs/heads/{}",
        parts.owner, parts.repo, parts.branch
    )
}

fn archive_relative_path(entry_name: &str, sub_path: &str) -> Option<PathBuf> {
    let normalized_entry = entry_name.replace('\\', "/");
    let (_, path_without_root) = normalized_entry.split_once('/')?;
    if path_without_root.is_empty() || path_without_root.ends_with('/') {
        return None;
    }

    let normalized_sub_path = sub_path.trim_matches('/');
    let relative = if normalized_sub_path.is_empty() {
        path_without_root
    } else {
        let prefix = format!("{}/", normalized_sub_path);
        path_without_root.strip_prefix(&prefix)?
    };

    safe_relative_path(relative)
}

fn safe_relative_path(relative_path: &str) -> Option<PathBuf> {
    let mut safe_path = PathBuf::new();

    for component in Path::new(relative_path).components() {
        match component {
            Component::Normal(part) => safe_path.push(part),
            _ => return None,
        }
    }

    if safe_path.as_os_str().is_empty() {
        None
    } else {
        Some(safe_path)
    }
}

fn invalid_skill_package(reason: &str) -> AppError {
    AppError::Generic(format!("{}:{}", INVALID_SKILL_PACKAGE_PREFIX, reason))
}

fn find_root_skill_md(output_dir: &Path) -> Result<PathBuf, AppError> {
    let exact_path = output_dir.join("SKILL.md");
    if exact_path.is_file() {
        return Ok(exact_path);
    }

    let entries = std::fs::read_dir(output_dir).map_err(|e| {
        AppError::Generic(format!(
            "Failed to inspect downloaded skill package root {:?}: {}",
            output_dir, e
        ))
    })?;

    for entry in entries {
        let entry = entry.map_err(|e| {
            AppError::Generic(format!("Failed to inspect downloaded package entry: {}", e))
        })?;
        let file_type = entry.file_type().map_err(|e| {
            AppError::Generic(format!(
                "Failed to inspect downloaded package entry type: {}",
                e
            ))
        })?;
        if !file_type.is_file() {
            continue;
        }

        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.eq_ignore_ascii_case("SKILL.md") {
            return Ok(entry.path());
        }
    }

    Err(invalid_skill_package("missing-root-skill-md"))
}

fn extract_frontmatter(content: &str) -> Option<String> {
    let mut lines = content.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }

    let mut frontmatter = String::new();
    for line in lines {
        if line.trim() == "---" {
            return Some(frontmatter);
        }
        frontmatter.push_str(line);
        frontmatter.push('\n');
    }

    None
}

fn frontmatter_has_top_level_key(frontmatter: &str, key: &str) -> bool {
    frontmatter.lines().any(|line| {
        if line.is_empty() || line.trim_start().len() != line.len() {
            return false;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            return false;
        }

        let Some((candidate, _)) = trimmed.split_once(':') else {
            return false;
        };

        candidate.trim() == key
    })
}

fn validate_downloaded_skill_package(output_dir: &Path) -> Result<(), AppError> {
    let skill_md_path = find_root_skill_md(output_dir)?;
    let content = std::fs::read_to_string(&skill_md_path).map_err(|e| {
        AppError::Generic(format!(
            "Failed to read downloaded SKILL.md {:?}: {}",
            skill_md_path, e
        ))
    })?;

    let frontmatter = extract_frontmatter(&content)
        .ok_or_else(|| invalid_skill_package("missing-frontmatter-name"))?;

    for (key, reason) in [
        ("name", "missing-frontmatter-name"),
        ("description", "missing-frontmatter-description"),
    ] {
        if !frontmatter_has_top_level_key(&frontmatter, key) {
            return Err(invalid_skill_package(reason));
        }
    }

    Ok(())
}

fn get_configured_github_token() -> Option<String> {
    let keystore = WindowsKeystore::new();
    match keystore.get_api_key(GITHUB_PROVIDER) {
        Ok(Some(token)) if !token.trim().is_empty() => Some(token),
        Ok(_) => None,
        Err(error) => {
            log::debug!("[SkillInstall] Failed to read GitHub token: {}", error);
            None
        }
    }
}

fn apply_github_auth(
    request: reqwest::RequestBuilder,
    github_token: Option<&str>,
) -> reqwest::RequestBuilder {
    match github_token {
        Some(token) => request.bearer_auth(token),
        None => request,
    }
}

/// 递归下载 GitHub 目录内容
///
/// 使用 Contents API 获取文件列表，逐个Failed to download file内容。
/// 对于子目录，递归调用自身。
fn download_directory_recursive<'a>(
    client: &'a reqwest::Client,
    parts: &'a GitHubUrlParts,
    api_path: &'a str,
    output_dir: &'a std::path::Path,
    github_token: Option<&'a str>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<usize, AppError>> + Send + 'a>> {
    Box::pin(async move {
        // 构造 API URL
        let api_url = if api_path.is_empty() {
            format!(
                "https://api.github.com/repos/{}/{}/contents?ref={}",
                parts.owner, parts.repo, parts.branch
            )
        } else {
            format!(
                "https://api.github.com/repos/{}/{}/contents/{}?ref={}",
                parts.owner, parts.repo, api_path, parts.branch
            )
        };

        let response = apply_github_auth(
            client
                .get(&api_url)
                .header("User-Agent", "AgentVis-SkillInstaller/1.0")
                .header("Accept", "application/vnd.github.v3+json"),
            github_token,
        )
        .send()
        .await
        .map_err(|e| AppError::Generic(format!("API request failed: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Generic(format!(
                "GitHub API returned HTTP {}. Make sure the URL path is correct.\nDetails: {}",
                status,
                safe_truncate(&body, 200)
            )));
        }

        let entries: Vec<GitHubContentEntry> = response
            .json()
            .await
            .map_err(|e| AppError::Generic(format!("Failed to parse API response: {}", e)))?;

        let mut files_written: usize = 0;

        for entry in &entries {
            if entry.entry_type == "file" {
                // Failed to download file
                if let Some(download_url) = &entry.download_url {
                    let file_response = apply_github_auth(
                        client
                            .get(download_url)
                            .header("User-Agent", "AgentVis-SkillInstaller/1.0"),
                        github_token,
                    )
                    .send()
                    .await
                    .map_err(|e| {
                        AppError::Generic(format!(
                            "Failed to download file '{}': {}",
                            entry.name, e
                        ))
                    })?;

                    if !file_response.status().is_success() {
                        return Err(AppError::Generic(format!(
                            "Failed to download file '{}': HTTP {}",
                            entry.name,
                            file_response.status()
                        )));
                    }

                    let content = file_response.bytes().await.map_err(|e| {
                        AppError::Generic(format!(
                            "Failed to read file '{}' content: {}",
                            entry.name, e
                        ))
                    })?;

                    // 计算文件相对于技能包根目录的路径
                    let relative_path = compute_relative_path(&entry.path, &parts.sub_path);
                    let dest_path = output_dir.join(&relative_path);

                    // 确保父目录存在
                    if let Some(parent) = dest_path.parent() {
                        std::fs::create_dir_all(parent).map_err(|e| {
                            AppError::Generic(format!(
                                "Failed to create directory {:?}: {}",
                                parent, e
                            ))
                        })?;
                    }

                    std::fs::write(&dest_path, &content).map_err(|e| {
                        AppError::Generic(format!("Failed to write file {:?}: {}", dest_path, e))
                    })?;

                    files_written += 1;
                    log::debug!("[SkillInstall]   写入: {}", relative_path);
                }
            } else if entry.entry_type == "dir" {
                // 递归下载子目录
                log::debug!("[SkillInstall]   进入目录: {}", entry.name);
                let sub_count = download_directory_recursive(
                    client,
                    parts,
                    &entry.path,
                    output_dir,
                    github_token,
                )
                .await?;
                files_written += sub_count;
            }
        }

        Ok(files_written)
    }) // Box::pin(async move { ... })
}

async fn download_archive_subpath(
    client: &reqwest::Client,
    parts: &GitHubUrlParts,
    output_dir: &std::path::Path,
    github_token: Option<&str>,
) -> Result<usize, AppError> {
    let archive_url = build_archive_zip_url(parts);
    log::debug!("[SkillInstall] ZIP fallback: {}", archive_url);

    let response = apply_github_auth(
        client
            .get(&archive_url)
            .header("User-Agent", "AgentVis-SkillInstaller/1.0")
            .header(
                reqwest::header::ACCEPT,
                "application/zip, application/octet-stream",
            )
            .header(reqwest::header::ACCEPT_ENCODING, "identity"),
        github_token,
    )
    .send()
    .await
    .map_err(|e| AppError::Generic(format!("Archive download failed: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::Generic(format!(
            "GitHub archive returned HTTP {}. Details: {}",
            status,
            safe_truncate(&body, 200)
        )));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| AppError::Generic(format!("Failed to read archive content: {}", e)))?;

    let reader = Cursor::new(bytes.to_vec());
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| AppError::Generic(format!("Failed to parse GitHub archive: {}", e)))?;

    let mut files_written: usize = 0;

    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|e| AppError::Generic(format!("Failed to read archive entry: {}", e)))?;

        let entry_name = file.name().to_string();
        if file.is_dir() {
            continue;
        }

        let Some(relative_path) = archive_relative_path(&entry_name, &parts.sub_path) else {
            continue;
        };

        let dest_path = output_dir.join(&relative_path);
        if let Some(parent) = dest_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AppError::Generic(format!("Failed to create directory {:?}: {}", parent, e))
            })?;
        }

        let mut dest_file = std::fs::File::create(&dest_path).map_err(|e| {
            AppError::Generic(format!("Failed to create file {:?}: {}", dest_path, e))
        })?;

        std::io::copy(&mut file, &mut dest_file).map_err(|e| {
            AppError::Generic(format!("Failed to extract file {:?}: {}", dest_path, e))
        })?;

        files_written += 1;
        log::debug!("[SkillInstall]   ZIP wrote: {}", relative_path.display());
    }

    if files_written == 0 {
        return Err(AppError::Generic(format!(
            "No files were found under path '{}' in the GitHub archive. Check whether the URL is correct.",
            parts.sub_path
        )));
    }

    Ok(files_written)
}

/// 计算文件相对于技能包根目录的路径
///
/// GitHub API 返回的 path 是相对于仓库根目录的完整路径，
/// 例如 `skills/blackworm/optimize-context/SKILL.md`。
/// 我们需要去除 sub_path 前缀，只保留技能包内的相对路径，
/// 例如 `SKILL.md`。
fn compute_relative_path(full_path: &str, sub_path: &str) -> String {
    if sub_path.is_empty() {
        return full_path.to_string();
    }

    // 去除 sub_path 前缀和斜杠
    let prefix = format!("{}/", sub_path);
    full_path
        .strip_prefix(&prefix)
        .unwrap_or(full_path)
        .to_string()
}

// ==================== Tauri Command ====================

/// 从 GitHub 安装技能包
///
/// 流程：
/// 1. 解析 GitHub URL（提取 owner/repo/branch/path）
/// 2. 使用 GitHub Contents API 递归下载目标子目录
/// 3. 写入 `{packages_dir}/{skill_name}/`
#[tauri::command]
pub async fn skill_install_from_github(
    params: SkillInstallParams,
) -> CommandResult<SkillInstallResult> {
    log::debug!("[SkillInstall] 开始从 GitHub 安装: {}", params.github_url);

    // Step 1: 解析 URL
    let parts = parse_github_url(&params.github_url)?;
    log::debug!(
        "[SkillInstall] 解析结果: owner={}, repo={}, branch={}, sub_path='{}', skill_name={}",
        parts.owner,
        parts.repo,
        parts.branch,
        parts.sub_path,
        parts.skill_name
    );

    // Step 2: 检查目标目录是否已存在
    let output_dir = PathBuf::from(&params.packages_dir).join(&parts.skill_name);
    if output_dir.exists() {
        return Err(AppError::Generic(format!(
            "Skill package '{}' already exists at {:?}. Delete it first if you need to reinstall it.",
            parts.skill_name, output_dir
        )));
    }

    // Step 3: 创建输出目录
    std::fs::create_dir_all(&output_dir)
        .map_err(|e| AppError::Generic(format!("Failed to create packages directory: {}", e)))?;

    // Step 4: 使用 Contents API 递归下载
    let api_url = build_contents_api_url(&parts);
    log::debug!("[SkillInstall] Contents API: {}", api_url);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| AppError::Generic(format!("Failed to create HTTP client: {}", e)))?;

    let github_token = get_configured_github_token();
    let github_token_ref = github_token.as_deref();
    if github_token_ref.is_some() {
        log::debug!("[SkillInstall] Using configured GitHub token");
    }

    let files_written = match download_directory_recursive(
        &client,
        &parts,
        if parts.sub_path.is_empty() {
            ""
        } else {
            &parts.sub_path
        },
        &output_dir,
        github_token_ref,
    )
    .await
    {
        Ok(count) => count,
        Err(api_error) => {
            log::debug!(
                "[SkillInstall] Contents API failed, trying ZIP fallback: {}",
                api_error
            );

            let archive_client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .no_gzip()
                .build()
                .map_err(|e| {
                    AppError::Generic(format!("Failed to create archive HTTP client: {}", e))
                })?;

            match download_archive_subpath(&archive_client, &parts, &output_dir, github_token_ref)
                .await
            {
                Ok(count) => count,
                Err(archive_error) => {
                    // 下载failed时回滚：删除已创建的目录
                    let _ = std::fs::remove_dir_all(&output_dir);
                    return Err(AppError::Generic(format!(
                        "GitHub API download failed: {}\nArchive fallback failed: {}",
                        api_error, archive_error
                    )));
                }
            }
        }
    };

    // 验证是否下载到文件
    if files_written == 0 {
        let _ = std::fs::remove_dir_all(&output_dir);
        return Err(AppError::Generic(format!(
            "No files were found under path '{}'. Check whether the URL is correct.",
            parts.sub_path
        )));
    }

    if let Err(validation_error) = validate_downloaded_skill_package(&output_dir) {
        let _ = std::fs::remove_dir_all(&output_dir);
        return Err(validation_error);
    }

    let package_path = output_dir.to_string_lossy().to_string();
    log::debug!(
        "[SkillInstall] 安装完成: {} 个文件写入 {}",
        files_written,
        package_path
    );

    Ok(SkillInstallResult {
        skill_name: parts.skill_name,
        files_written,
        package_path,
    })
}

// ==================== 单元测试 ====================

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn create_test_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "agentvis_skill_install_{}_{}_{}",
            label,
            std::process::id(),
            nanos
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn remove_test_dir(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn test_parse_github_url_tree_format() {
        let url = "https://github.com/anthropics/skills/tree/main/skills/pptx";
        let parts = parse_github_url(url).unwrap();
        assert_eq!(parts.owner, "anthropics");
        assert_eq!(parts.repo, "skills");
        assert_eq!(parts.branch, "main");
        assert_eq!(parts.sub_path, "skills/pptx");
        assert_eq!(parts.skill_name, "pptx");
    }

    #[test]
    fn test_parse_github_url_without_scheme() {
        let url = "github.com/anthropics/skills/tree/main/skills/pptx";
        let parts = parse_github_url(url).unwrap();
        assert_eq!(parts.owner, "anthropics");
        assert_eq!(parts.repo, "skills");
        assert_eq!(parts.branch, "main");
        assert_eq!(parts.sub_path, "skills/pptx");
        assert_eq!(parts.skill_name, "pptx");
    }

    #[test]
    fn test_parse_github_url_deep_path() {
        // 第三方技能包带作者层级
        let url = "https://github.com/openclaw/skills/tree/main/skills/blackworm/optimize-context";
        let parts = parse_github_url(url).unwrap();
        assert_eq!(parts.owner, "openclaw");
        assert_eq!(parts.repo, "skills");
        assert_eq!(parts.branch, "main");
        assert_eq!(parts.sub_path, "skills/blackworm/optimize-context");
        assert_eq!(parts.skill_name, "optimize-context");
    }

    #[test]
    fn test_parse_github_url_repo_only() {
        let url = "https://github.com/user/my-skill";
        let parts = parse_github_url(url).unwrap();
        assert_eq!(parts.owner, "user");
        assert_eq!(parts.repo, "my-skill");
        assert_eq!(parts.branch, "main");
        assert_eq!(parts.sub_path, "");
        assert_eq!(parts.skill_name, "my-skill");
    }

    #[test]
    fn test_parse_github_url_trailing_slash() {
        let url = "https://github.com/anthropics/skills/tree/main/skills/pdf/";
        let parts = parse_github_url(url).unwrap();
        assert_eq!(parts.sub_path, "skills/pdf");
        assert_eq!(parts.skill_name, "pdf");
    }

    #[test]
    fn test_parse_github_url_invalid() {
        let result = parse_github_url("https://gitlab.com/some/repo");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_github_url_too_short() {
        let result = parse_github_url("https://github.com/only-owner");
        assert!(result.is_err());
    }

    #[test]
    fn test_build_contents_api_url_with_subpath() {
        let parts = GitHubUrlParts {
            owner: "openclaw".to_string(),
            repo: "skills".to_string(),
            branch: "main".to_string(),
            sub_path: "skills/blackworm/optimize-context".to_string(),
            skill_name: "optimize-context".to_string(),
        };
        let url = build_contents_api_url(&parts);
        assert_eq!(
            url,
            "https://api.github.com/repos/openclaw/skills/contents/skills/blackworm/optimize-context?ref=main"
        );
    }

    #[test]
    fn test_build_contents_api_url_repo_root() {
        let parts = GitHubUrlParts {
            owner: "user".to_string(),
            repo: "my-skill".to_string(),
            branch: "main".to_string(),
            sub_path: String::new(),
            skill_name: "my-skill".to_string(),
        };
        let url = build_contents_api_url(&parts);
        assert_eq!(
            url,
            "https://api.github.com/repos/user/my-skill/contents?ref=main"
        );
    }

    #[test]
    fn test_build_archive_zip_url() {
        let parts = GitHubUrlParts {
            owner: "anthropics".to_string(),
            repo: "skills".to_string(),
            branch: "main".to_string(),
            sub_path: "skills/mcp-builder".to_string(),
            skill_name: "mcp-builder".to_string(),
        };

        assert_eq!(
            build_archive_zip_url(&parts),
            "https://codeload.github.com/anthropics/skills/zip/refs/heads/main"
        );
    }

    #[test]
    fn test_archive_relative_path_for_subpath() {
        let relative = archive_relative_path(
            "skills-main/skills/mcp-builder/scripts/run.py",
            "skills/mcp-builder",
        )
        .unwrap();

        assert_eq!(relative, PathBuf::from("scripts").join("run.py"));
    }

    #[test]
    fn test_archive_relative_path_rejects_traversal() {
        let relative = archive_relative_path(
            "skills-main/skills/mcp-builder/../evil.py",
            "skills/mcp-builder",
        );

        assert!(relative.is_none());
    }

    #[test]
    fn test_compute_relative_path() {
        // 有 sub_path 时去除前缀
        assert_eq!(
            compute_relative_path(
                "skills/blackworm/optimize-context/SKILL.md",
                "skills/blackworm/optimize-context"
            ),
            "SKILL.md"
        );
        // 嵌套目录
        assert_eq!(
            compute_relative_path(
                "skills/blackworm/optimize-context/commands/run.md",
                "skills/blackworm/optimize-context"
            ),
            "commands/run.md"
        );
        // 无 sub_path 时保持原样
        assert_eq!(compute_relative_path("SKILL.md", ""), "SKILL.md");
    }

    #[test]
    fn test_validate_downloaded_skill_package_accepts_skill_root() {
        let dir = create_test_dir("valid");
        std::fs::write(
            dir.join("SKILL.md"),
            r#"---
name: ab-testing
description: "A/B testing guide"
triggers: [ab-test, experiment]
---

# A/B Testing
"#,
        )
        .unwrap();

        assert!(validate_downloaded_skill_package(&dir).is_ok());
        remove_test_dir(&dir);
    }

    #[test]
    fn test_validate_downloaded_skill_package_rejects_repo_root_without_skill_md() {
        let dir = create_test_dir("missing_skill_md");
        std::fs::create_dir_all(dir.join("skills").join("ab-testing")).unwrap();
        std::fs::write(dir.join("README.md"), "# Marketing skills").unwrap();

        let error = validate_downloaded_skill_package(&dir)
            .unwrap_err()
            .to_string();

        assert_eq!(error, "SKILL_INSTALL_INVALID:missing-root-skill-md");
        remove_test_dir(&dir);
    }

    #[test]
    fn test_validate_downloaded_skill_package_allows_missing_triggers() {
        let dir = create_test_dir("missing_triggers");
        std::fs::write(
            dir.join("SKILL.md"),
            r#"---
name: no-triggers
description: "Missing triggers"
---

# Missing Triggers
"#,
        )
        .unwrap();

        assert!(validate_downloaded_skill_package(&dir).is_ok());
        remove_test_dir(&dir);
    }
}
