//! 文件操作相关 Tauri Commands
//!
//! 提供交付物保存、文档管理等 IPC 命令

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::fs;
use tauri::Manager;

use crate::error::{AppResult, AppError};

use super::command_validator;

// ==================== 请求/响应类型 ====================

/// 文件信息响应
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfoResponse {
    pub id: String,
    pub file_name: String,
    pub file_path: String,
    pub size: u64,
    pub created_at: i64,
}

const LARGE_TOOL_ARG_DIR_NAME: &str = "agentvis_large_tool_args";
const LARGE_TOOL_ARG_REF_PREFIX: &str = "agentvis-large-tool-";

fn large_tool_arg_dir(app_handle: &tauri::AppHandle) -> AppResult<PathBuf> {
    let temp_dir = app_handle
        .path()
        .temp_dir()
        .map_err(|e| AppError::FileSystem(format!("Failed to get temp directory: {}", e)))?;
    Ok(temp_dir.join(LARGE_TOOL_ARG_DIR_NAME))
}

fn validate_large_tool_arg_ref(ref_id: &str) -> AppResult<()> {
    let is_valid = ref_id.starts_with(LARGE_TOOL_ARG_REF_PREFIX)
        && ref_id.len() <= 128
        && ref_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.');

    if is_valid {
        Ok(())
    } else {
        Err(AppError::Generic(format!("Invalid large tool arg ref: {}", ref_id)))
    }
}

fn resolve_large_tool_arg_path(app_handle: &tauri::AppHandle, ref_id: &str) -> AppResult<PathBuf> {
    validate_large_tool_arg_ref(ref_id)?;
    Ok(large_tool_arg_dir(app_handle)?.join(ref_id))
}

pub(crate) fn stage_large_tool_arg_content(
    app_handle: &tauri::AppHandle,
    content: &str,
) -> AppResult<String> {
    let dir = large_tool_arg_dir(app_handle)?;
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::FileSystem(format!("Failed to create large tool arg directory: {}", e)))?;

    let ref_id = format!("{}{}.txt", LARGE_TOOL_ARG_REF_PREFIX, uuid::Uuid::new_v4());
    let path = dir.join(&ref_id);
    fs::write(&path, content.as_bytes())
        .map_err(|e| AppError::FileSystem(format!("Failed to stage large tool arg content: {}", e)))?;

    log::info!(
        "[file] staged large tool arg content: ref={}, bytes={}",
        ref_id,
        content.as_bytes().len()
    );

    Ok(ref_id)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedWriteResult {
    pub success: bool,
    pub file_path: String,
    pub backup_path: Option<String>,
    pub bytes_written: u64,
    pub existed_before: bool,
}

// ==================== Tauri Commands ====================

/// 保存交付物到文件系统
///
/// 交付物保存在 Agent 对应的目录下：
/// `<app_data>/deliverables/<agent_id>/<filename>`
///
/// # Arguments
/// * `agent_id` - Agent ID
/// * `file_name` - 文件名
/// * `content` - 文件内容
///
/// # Returns
/// 文件完整路径
#[tauri::command]
pub async fn file_write_deliverable(
    app_handle: tauri::AppHandle,
    agent_id: String,
    file_name: String,
    content: String,
) -> AppResult<String> {
    // 使用 app_data_dir 获取应用数据目录（更可靠）
    // 路径：C:\Users\<User>\AppData\Roaming\com.agentvis.app\deliverables\<agent_id>\
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| AppError::FileSystem(format!("Failed to get app data directory: {}", e)))?;
    
    // 创建交付物目录: <app_data>/deliverables/<agent_id>/
    let deliverables_dir = base_dir.join("deliverables").join(&agent_id);
    fs::create_dir_all(&deliverables_dir)
        .map_err(|e| AppError::FileSystem(format!("Failed to create directory: {}", e)))?;
    
    // 处理文件名冲突（如果文件已存在，添加时间戳后缀）
    let final_file_name = get_unique_filename(&deliverables_dir, &file_name);
    let file_path = deliverables_dir.join(&final_file_name);
    
    // 写入文件
    fs::write(&file_path, &content)
        .map_err(|e| AppError::FileSystem(format!("Failed to write file: {}", e)))?;
    
    let path_str = file_path.to_string_lossy().to_string();
    
    log::debug!("[file] 交付物已保存: {}", path_str);
    
    Ok(path_str)
}

/// 读取文件内容
///
/// 智能读取：对文本文件直接返回内容，对办公文档（.docx/.xlsx/.pptx/.pdf）
/// 自动调用 document_parser 提取文本内容。
/// 解决 SA 使用 read 工具读取二进制办公文件导致失败的问题。
///
/// # Arguments
/// * `file_path` - 文件路径
///
/// # Returns
/// 文件内容（文本文件原样返回，二进制文件返回提取的文本）
#[tauri::command]
pub async fn file_read_content(
    file_path: String,
) -> AppResult<String> {
    let path = PathBuf::from(&file_path);
    
    if !path.exists() {
        return Err(AppError::NotFound(format!("File does not exist: {}", file_path)));
    }
    
    // 检测文件扩展名，对办公文档自动路由到 document_parser
    let ext = path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());
    
    match ext.as_deref() {
        Some("docx") => {
            log::debug!("[file] 检测到 .docx 文件，自动解析为文本: {}", file_path);
            let text = super::document_parser::parse_docx(file_path.clone()).await?;
            Ok(format!("[Automatically parsed from {} - extracted text content follows]\n\n{}", 
                path.file_name().unwrap_or_default().to_string_lossy(), text))
        }
        Some("xlsx") | Some("xls") => {
            log::debug!("[file] 检测到 Excel 文件，自动解析为文本: {}", file_path);
            let text = super::document_parser::parse_xlsx(file_path.clone()).await?;
            Ok(format!("[Automatically parsed from {} - extracted Markdown table follows]\n\n{}", 
                path.file_name().unwrap_or_default().to_string_lossy(), text))
        }
        Some("pptx") => {
            log::debug!("[file] 检测到 .pptx 文件，自动解析为文本: {}", file_path);
            let text = super::document_parser::parse_pptx(file_path.clone()).await?;
            Ok(format!("[Automatically parsed from {} - extracted Markdown content follows]\n\n{}", 
                path.file_name().unwrap_or_default().to_string_lossy(), text))
        }
        Some("pdf") => {
            log::debug!("[file] 检测到 .pdf 文件，自动解析为文本: {}", file_path);
            let text = super::document_parser::parse_pdf(file_path.clone()).await?;
            Ok(format!("[Automatically parsed from {} - extracted text content follows]\n\n{}", 
                path.file_name().unwrap_or_default().to_string_lossy(), text))
        }
        _ => {
            // 文本文件：直接读取
            let content = fs::read_to_string(&path)
                .map_err(|e| AppError::FileSystem(format!("Failed to read file: {}", e)))?;
            Ok(content)
        }
    }
}

/// 列出 Agent 的所有交付物
///
/// 交付物目录结构: `<app_data>/deliverables/<hub_name>/<agent_name>/`
///
/// # Arguments
/// * `hub_name` - Hub 名称（已清理的安全文件名）
/// * `agent_name` - Agent 名称（已清理的安全文件名）
///
/// # Returns
/// 文件列表
#[tauri::command]
pub async fn file_list_deliverables(
    app_handle: tauri::AppHandle,
    hub_name: String,
    agent_name: String,
) -> AppResult<Vec<FileInfoResponse>> {
    // 使用 app_data_dir 获取应用数据目录
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| AppError::FileSystem(format!("Failed to get app data directory: {}", e)))?;
    
    // 目录结构: deliverables/<hub_name>/<agent_name>/
    let deliverables_dir = base_dir.join("deliverables").join(&hub_name).join(&agent_name);
    
    if !deliverables_dir.exists() {
        return Ok(vec![]);
    }
    
    let mut files = Vec::new();
    
    // 递归读取目录下的所有文件（包括子目录）
    collect_files_recursively(&deliverables_dir, &deliverables_dir, &mut files, &hub_name, &agent_name)?;
    
    // 按创建时间倒序
    files.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    
    Ok(files)
}

/// 递归收集目录下的所有文件
fn collect_files_recursively(
    base_dir: &std::path::Path,
    current_dir: &std::path::Path,
    files: &mut Vec<FileInfoResponse>,
    hub_name: &str,
    agent_name: &str,
) -> AppResult<()> {
    if let Ok(entries) = fs::read_dir(current_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Ok(metadata) = entry.metadata() {
                    let file_name = path.file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    
                    let created_at = metadata.created()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    
                    // 使用相对路径生成唯一 id，
                    // 避免不同子目录下同名文件（如 README.md）产生相同 id
                    let relative_path = path.strip_prefix(base_dir)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|_| file_name.clone());
                    let safe_relative = relative_path
                        .replace(['/', '\\'], "_");

                    files.push(FileInfoResponse {
                        id: format!("{}_{}_{}", hub_name, agent_name, safe_relative),
                        file_name,
                        file_path: path.to_string_lossy().to_string(),
                        size: metadata.len(),
                        created_at,
                    });
                }
            } else if path.is_dir() {
                // 递归处理子目录
                collect_files_recursively(base_dir, &path, files, hub_name, agent_name)?;
            }
        }
    }
    Ok(())
}

/// 删除交付物（支持文件和文件夹）
///
/// # Arguments
/// * `file_path` - 文件或文件夹路径
#[tauri::command]
pub async fn file_delete(
    file_path: String,
) -> AppResult<()> {
    let path = PathBuf::from(&file_path);
    
    if !path.exists() {
        return Err(AppError::NotFound(format!("File does not exist: {}", file_path)));
    }
    
    // 根据路径类型选择不同的删除方式
    if path.is_dir() {
        fs::remove_dir_all(&path)
            .map_err(|e| AppError::FileSystem(format!("Failed to delete folder: {}", e)))?;
        log::debug!("[file] 文件夹已删除: {}", file_path);
    } else {
        fs::remove_file(&path)
            .map_err(|e| AppError::FileSystem(format!("Failed to delete file: {}", e)))?;
        log::debug!("[file] 文件已删除: {}", file_path);
    }
    
    Ok(())
}

/// 保存剪贴板图片数据到临时文件
///
/// 用于粘贴上传功能，将 base64 编码的图片数据保存为临时文件，
/// 返回文件路径供附件上传流程使用。
///
/// # Arguments
/// * `base64_data` - base64 编码的图片数据（不含 data:xxx;base64, 前缀）
/// * `mime_type` - MIME 类型（如 "image/png"）
///
/// # Returns
/// 保存的临时文件路径
#[tauri::command]
pub async fn save_clipboard_image(
    app_handle: tauri::AppHandle,
    base64_data: String,
    mime_type: String,
    target_dir: Option<String>,
) -> AppResult<String> {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    
    // 根据 MIME 类型确定文件扩展名
    let extension = match mime_type.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "png",  // 默认使用 png
    };
    
    // 获取保存目录：优先写入调用方指定目录，未指定时保持旧的临时目录行为
    let clipboard_dir = if let Some(dir) = normalize_optional_dir(target_dir) {
        PathBuf::from(dir)
    } else {
        let temp_dir = app_handle
            .path()
            .temp_dir()
            .map_err(|e| AppError::FileSystem(format!("Failed to get temporary directory: {}", e)))?;
        temp_dir.join("clipboard_images")
    };

    fs::create_dir_all(&clipboard_dir)
        .map_err(|e| AppError::FileSystem(format!("Failed to create image attachment directory: {}", e)))?;
    
    // 生成唯一文件名
    let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S_%3f");
    let file_name = format!("clipboard_{}.{}", timestamp, extension);
    let file_path = clipboard_dir.join(&file_name);
    
    // 解码 base64 数据
    let image_data = STANDARD.decode(&base64_data)
        .map_err(|e| AppError::Generic(format!("Invalid base64 data: {}", e)))?;
    
    // 写入文件
    fs::write(&file_path, &image_data)
        .map_err(|e| AppError::FileSystem(format!("Failed to write image: {}", e)))?;
    
    let path_str = file_path.to_string_lossy().to_string();
    
    log::debug!("[file] 剪贴板图片已保存: {} ({} bytes)", path_str, image_data.len());
    
    Ok(path_str)
}

/// 保存拖放文件到附件目录
///
/// 用于 HTML5 Drag API 拖放上传功能，将 base64 编码的文件数据保存为本地文件，
/// 返回文件路径供附件上传流程使用。未指定目标目录时回退到临时目录。
///
/// # Arguments
/// * `base64_data` - base64 编码的文件数据
/// * `file_name` - 原文件名
/// * `mime_type` - MIME 类型
///
/// # Returns
/// 保存的本地文件路径
#[tauri::command]
pub async fn save_dropped_file(
    app_handle: tauri::AppHandle,
    base64_data: String,
    file_name: String,
    mime_type: String,
    target_dir: Option<String>,
) -> AppResult<String> {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    
    // 获取保存目录：优先写入调用方指定目录，未指定时保持旧的临时目录行为
    let dropped_dir = if let Some(dir) = normalize_optional_dir(target_dir) {
        PathBuf::from(dir)
    } else {
        let temp_dir = app_handle
            .path()
            .temp_dir()
            .map_err(|e| AppError::FileSystem(format!("Failed to get temporary directory: {}", e)))?;
        temp_dir.join("dropped_files")
    };

    fs::create_dir_all(&dropped_dir)
        .map_err(|e| AppError::FileSystem(format!("Failed to create dropped file directory: {}", e)))?;

    // 保留原文件名；仅在同名文件已存在时追加序号避免覆盖
    let safe_file_name = get_unique_filename_with_counter(&dropped_dir, &sanitize_filename(&file_name));
    let file_path = dropped_dir.join(&safe_file_name);
    
    // 解码 base64 数据
    let file_data = STANDARD.decode(&base64_data)
        .map_err(|e| AppError::Generic(format!("Invalid base64 data: {}", e)))?;
    
    // 写入文件
    fs::write(&file_path, &file_data)
        .map_err(|e| AppError::FileSystem(format!("Failed to write file: {}", e)))?;
    
    let path_str = file_path.to_string_lossy().to_string();
    
    log::debug!("[file] 拖放文件已保存: {} ({} bytes, {})", path_str, file_data.len(), mime_type);
    
    Ok(path_str)
}

/// 清理文件名，移除不安全字符
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect()
}

fn normalize_optional_dir(dir: Option<String>) -> Option<String> {
    dir.map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// 清洗允许为空的相对路径（例如当前浏览目录）
fn sanitize_optional_relative_path(path: &str) -> AppResult<PathBuf> {
    sanitize_relative_path(path, true)
}

/// 清洗必须非空的相对路径（例如拖入项目自身路径）
fn sanitize_required_relative_path(path: &str) -> AppResult<PathBuf> {
    sanitize_relative_path(path, false)
}

/// 清洗前端传入的相对路径片段，避免绝对路径和 `..` 越界
fn sanitize_relative_path(path: &str, allow_empty: bool) -> AppResult<PathBuf> {
    let normalized = path.replace('\\', "/");
    let mut cleaned = PathBuf::new();

    for segment in normalized.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }

        if segment == ".." {
            return Err(AppError::Generic(
                "Invalid path: parent traversal is not allowed".to_string(),
            ));
        }

        let safe_segment = sanitize_filename(segment);
        if safe_segment.is_empty() {
            return Err(AppError::Generic("Invalid empty path segment".to_string()));
        }
        cleaned.push(safe_segment);
    }

    if !allow_empty && cleaned.as_os_str().is_empty() {
        return Err(AppError::Generic("Invalid empty import path".to_string()));
    }

    Ok(cleaned)
}

/// 确保目标路径位于工作区根目录内
fn ensure_path_within_root(root: &Path, path: &Path) -> AppResult<()> {
    let canonical_path = path
        .canonicalize()
        .map_err(|e| AppError::FileSystem(format!("Failed to canonicalize target path: {}", e)))?;

    if !canonical_path.starts_with(root) {
        return Err(AppError::Generic(
            "Invalid path: access outside the workspace root is not allowed".to_string(),
        ));
    }

    Ok(())
}

// ==================== 工具函数 ====================

/// 获取唯一文件名（避免冲突）
fn get_unique_filename(dir: &Path, file_name: &str) -> String {
    let path = dir.join(file_name);
    
    if !path.exists() {
        return file_name.to_string();
    }
    
    // 分离文件名和扩展名
    let (base_name, extension) = if let Some(dot_idx) = file_name.rfind('.') {
        (&file_name[..dot_idx], &file_name[dot_idx..])
    } else {
        (file_name, "")
    };
    
    // 添加时间戳
    let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
    format!("{}_{}{}", base_name, timestamp, extension)
}

/// 获取不冲突文件名：首选原文件名，仅冲突时追加 (1)、(2) 这类最小后缀
fn get_unique_filename_with_counter(dir: &Path, file_name: &str) -> String {
    let normalized_file_name = if file_name.trim().is_empty() {
        "attachment".to_string()
    } else {
        file_name.to_string()
    };

    if !dir.join(&normalized_file_name).exists() {
        return normalized_file_name;
    }

    let (base_name, extension) = if let Some(dot_idx) = normalized_file_name.rfind('.') {
        (&normalized_file_name[..dot_idx], &normalized_file_name[dot_idx..])
    } else {
        (normalized_file_name.as_str(), "")
    };

    for index in 1..10_000 {
        let candidate = format!("{} ({}){}", base_name, index, extension);
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }

    let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S_%3f");
    format!("{}_{}{}", base_name, timestamp, extension)
}

// ==================== 通用命令 ====================

/// 写入结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    /// 写入是否成功
    pub success: bool,
    /// 写入的文件路径
    pub file_path: String,
    /// 备份文件路径（如果创建了备份）
    pub backup_path: Option<String>,
    /// 写入的字节数
    pub bytes_written: u64,
}

/// 写入文件到指定路径
///
/// 支持任意路径写入，可选创建备份。
///
/// # Arguments
/// * `path` - 文件路径
/// * `content` - 文件内容
/// * `create_backup` - 是否创建备份
///
/// # Returns
/// 写入结果
#[tauri::command]
pub async fn file_write_to_path(
    app_handle: tauri::AppHandle,
    path: String,
    content: String,
    create_backup: bool,
) -> AppResult<WriteResult> {
    let file_path = PathBuf::from(&path);

    // 写入保护校验：检查目标文件是否位于用户自定义保护目录下
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    command_validator::validate_path_write_safety(&file_path, &app_data_dir)?;
    
    // 确保父目录存在
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::FileSystem(format!("Failed to create directory: {}", e)))?;
    }
    
    // 如果文件存在且需要备份
    let backup_path = if create_backup && file_path.exists() {
        let backup = file_create_backup_internal(&app_handle, &path)?;
        Some(backup)
    } else {
        None
    };
    
    // 写入文件
    let bytes = content.as_bytes();
    fs::write(&file_path, bytes)
        .map_err(|e| AppError::FileSystem(format!("Failed to write file: {}", e)))?;
    
    log::debug!("[file] 已写入文件: {} ({} bytes)", path, bytes.len());
    
    Ok(WriteResult {
        success: true,
        file_path: path,
        backup_path,
        bytes_written: bytes.len() as u64,
    })
}

/// 读取文件为 base64
///
/// 用于图片预览等场景
///
/// # Arguments
/// * `path` - 文件路径
///
/// # Returns
/// base64 编码的文件内容
#[tauri::command]
pub async fn file_read_as_base64(path: String) -> AppResult<String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    
    let file_path = PathBuf::from(&path);
    
    if !file_path.exists() {
        return Err(AppError::NotFound(format!("File does not exist: {}", path)));
    }
    
    // 读取文件
    let bytes = fs::read(&file_path)
        .map_err(|e| AppError::FileSystem(format!("Failed to read file: {}", e)))?;
    
    // 编码为 base64
    let encoded = STANDARD.encode(&bytes);
    
    log::debug!("[file] 已读取文件为 base64: {} ({} bytes -> {} chars)", 
             path, bytes.len(), encoded.len());
    
    Ok(encoded)
}

/// 读取图片文件，超过最大宽度时按比例缩放后返回 base64
///
/// 用于桌面自动化截图注入 LLM 视觉上下文前的降分辨率处理。
/// 高 DPI 屏幕（如 200% 缩放 2880×1800）的原始截图远超多模态模型的训练分布（~1080p），
/// 缩放到合理尺寸后模型的视觉空间定位精度显著提升。
///
/// 缩放使用 Lanczos3 算法保证视觉质量，输出 PNG 格式保持无损。
/// 宽度未超过 max_width 时原样返回，不做任何处理。
///
/// # Arguments
/// * `path` - 图片文件路径
/// * `max_width` - 最大宽度（像素），超过时按比例缩放
///
/// # Returns
/// (base64 编码的图片数据, MIME 类型, 是否发生了缩放)
#[tauri::command]
pub async fn file_read_image_downscaled_as_base64(
    path: String,
    max_width: u32,
) -> AppResult<(String, String, bool)> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    let file_path = PathBuf::from(&path);

    if !file_path.exists() {
        return Err(AppError::NotFound(format!("File does not exist: {}", path)));
    }

    let bytes = fs::read(&file_path)
        .map_err(|e| AppError::FileSystem(format!("Failed to read file: {}", e)))?;

    // 尝试解码为图片
    let img = image::load_from_memory(&bytes)
        .map_err(|e| AppError::Generic(format!("Failed to decode image: {}", e)))?;

    let original_width = img.width();
    let original_height = img.height();

    if original_width <= max_width {
        // 未超过阈值，返回原始文件（保留原格式，避免不必要的重编码）
        let encoded = STANDARD.encode(&bytes);
        let ext = file_path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png")
            .to_lowercase();
        let mime = match ext.as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            "bmp" => "image/bmp",
            _ => "image/png",
        };
        log::debug!(
            "[file] 图片未超过最大宽度，原样返回: {} ({}×{}, max={})",
            path, original_width, original_height, max_width
        );
        return Ok((encoded, mime.to_string(), false));
    }

    // 按比例缩放：保持宽高比，宽度缩到 max_width
    let scale = max_width as f64 / original_width as f64;
    let new_height = (original_height as f64 * scale).round() as u32;

    let resized = img.resize_exact(
        max_width,
        new_height,
        image::imageops::FilterType::Lanczos3,
    );

    // 编码为 PNG 并返回 base64
    let mut png_buffer = std::io::Cursor::new(Vec::new());
    resized
        .write_to(&mut png_buffer, image::ImageFormat::Png)
        .map_err(|e| AppError::Generic(format!("Failed to encode image: {}", e)))?;

    let encoded = STANDARD.encode(png_buffer.get_ref());

    log::debug!(
        "[file] 📐 图片已缩放: {} ({}×{} → {}×{}, scale={:.2})",
        path, original_width, original_height, max_width, new_height, scale
    );

    Ok((encoded, "image/png".to_string(), true))
}

/// 复制文件到附件目录
///
/// 将文件复制到应用数据目录的 attachments/<agent_id>/ 下
///
/// # Arguments
/// * `source_path` - 源文件路径
/// * `agent_id` - Agent ID
///
/// # Returns
/// 目标文件路径
#[tauri::command]
pub async fn file_copy_to_attachments(
    app_handle: tauri::AppHandle,
    source_path: String,
    agent_id: String,
    target_dir: Option<String>,
) -> AppResult<String> {
    let source = PathBuf::from(&source_path);
    
    if !source.exists() {
        return Err(AppError::NotFound(format!("File does not exist: {}", source_path)));
    }
    
    // 获取附件目录：优先写入调用方指定的 workdir/attachments，未指定时保持旧目录
    let attachments_dir = if let Some(dir) = normalize_optional_dir(target_dir) {
        PathBuf::from(dir)
    } else {
        let app_data_dir = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| AppError::FileSystem(format!("Failed to get app data directory: {}", e)))?;
        app_data_dir.join("attachments").join(&agent_id)
    };
    fs::create_dir_all(&attachments_dir)
        .map_err(|e| AppError::FileSystem(format!("Failed to create attachments directory: {}", e)))?;

    // 默认保留原文件名；仅在目标目录已有不同文件同名时追加序号避免覆盖
    let file_name = source.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let safe_file_name = sanitize_filename(&file_name);
    let preferred_target_path = attachments_dir.join(&safe_file_name);

    if preferred_target_path.exists() {
        let source_canonical = source
            .canonicalize()
            .map_err(|e| AppError::FileSystem(format!("Failed to canonicalize source file: {}", e)))?;
        let target_canonical = preferred_target_path
            .canonicalize()
            .map_err(|e| AppError::FileSystem(format!("Failed to canonicalize target file: {}", e)))?;

        if source_canonical == target_canonical {
            let target_path_str = preferred_target_path.to_string_lossy().to_string();
            log::debug!("[file] 附件已在目标目录，无需复制: {}", target_path_str);
            return Ok(target_path_str);
        }
    }

    let target_file_name = get_unique_filename_with_counter(&attachments_dir, &safe_file_name);
    let target_path = attachments_dir.join(&target_file_name);

    // 复制文件
    fs::copy(&source, &target_path)
        .map_err(|e| AppError::FileSystem(format!("Failed to copy file: {}", e)))?;
    
    let target_path_str = target_path.to_string_lossy().to_string();
    log::debug!("[file] 已复制附件: {} -> {}", source_path, target_path_str);
    
    Ok(target_path_str)
}

/// 获取文件大小
///
/// # Arguments
/// * `path` - 文件路径
///
/// # Returns
/// 文件大小（字节）
#[tauri::command]
pub async fn file_get_size(path: String) -> AppResult<u64> {
    let file_path = PathBuf::from(&path);
    
    if !file_path.exists() {
        return Err(AppError::NotFound(format!("File does not exist: {}", path)));
    }
    
    let metadata = fs::metadata(&file_path)
        .map_err(|e| AppError::FileSystem(format!("Failed to get file metadata: {}", e)))?;
    
    Ok(metadata.len())
}

/// 创建文件备份
///
/// 备份文件保存在应用数据目录的 backups/ 下
///
/// # Arguments
/// * `path` - 要备份的文件路径
///
/// # Returns
/// 备份文件路径
#[tauri::command]
pub async fn file_create_backup(
    app_handle: tauri::AppHandle,
    path: String,
) -> AppResult<String> {
    file_create_backup_internal(&app_handle, &path)
}

/// 内部备份函数
fn file_create_backup_internal(
    app_handle: &tauri::AppHandle,
    path: &str,
) -> AppResult<String> {
    let source_path = PathBuf::from(path);
    
    if !source_path.exists() {
        return Err(AppError::NotFound(format!("File does not exist: {}", path)));
    }
    
    // 获取备份目录
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| AppError::FileSystem(format!("Failed to get app data directory: {}", e)))?;
    
    let backups_dir = app_data_dir.join("backups");
    fs::create_dir_all(&backups_dir)
        .map_err(|e| AppError::FileSystem(format!("Failed to create backup directory: {}", e)))?;
    
    // 生成备份文件名：原文件名_时间戳.扩展名
    let file_name = source_path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    
    let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
    
    let (base_name, extension) = if let Some(dot_idx) = file_name.rfind('.') {
        (&file_name[..dot_idx], &file_name[dot_idx..])
    } else {
        (file_name.as_str(), "")
    };
    
    let backup_file_name = format!("{}_{}{}", base_name, timestamp, extension);
    let backup_path = backups_dir.join(&backup_file_name);
    
    // 复制文件
    fs::copy(&source_path, &backup_path)
        .map_err(|e| AppError::FileSystem(format!("Failed to create backup: {}", e)))?;
    
    let backup_path_str = backup_path.to_string_lossy().to_string();
    log::debug!("[file] 已创建备份: {} -> {}", path, backup_path_str);
    
    Ok(backup_path_str)
}

/// 使用系统默认应用打开文件
///
/// 跨平台实现：Windows 使用 cmd /C start，macOS 使用 open，Linux 使用 xdg-open。
/// 用于在右栏交付物预览中打开二进制文档（docx/xlsx/pptx/pdf）。
///
/// # Arguments
/// * `file_path` - 文件路径
#[tauri::command]
pub async fn file_open_system(
    file_path: String,
) -> AppResult<()> {
    let path = PathBuf::from(&file_path);

    if !path.exists() {
        return Err(AppError::NotFound(format!("File does not exist: {}", file_path)));
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &file_path])
            .spawn()
            .map_err(|e| AppError::Generic(format!("Failed to open file: {}", e)))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| AppError::Generic(format!("Failed to open file: {}", e)))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| AppError::Generic(format!("Failed to open file: {}", e)))?;
    }

    log::debug!("[file] 已使用系统默认应用打开: {}", file_path);

    Ok(())
}

#[cfg(any(target_os = "windows", test))]
fn explorer_compatible_path(file_path: &str) -> String {
    if let Some(rest) = file_path.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{}", rest)
    } else if let Some(rest) = file_path.strip_prefix("\\\\?\\") {
        rest.to_string()
    } else {
        file_path.to_string()
    }
}

#[cfg(target_os = "windows")]
struct ComApartmentGuard {
    should_uninitialize: bool,
}

#[cfg(target_os = "windows")]
impl Drop for ComApartmentGuard {
    fn drop(&mut self) {
        if self.should_uninitialize {
            unsafe {
                windows_sys::Win32::System::Com::CoUninitialize();
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn format_hresult(hr: windows_sys::core::HRESULT) -> String {
    format!("0x{:08X}", hr as u32)
}

#[cfg(target_os = "windows")]
fn hresult_succeeded(hr: windows_sys::core::HRESULT) -> bool {
    hr >= 0
}

#[cfg(target_os = "windows")]
fn initialize_shell_com() -> AppResult<ComApartmentGuard> {
    use windows_sys::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows_sys::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};

    let hr = unsafe {
        CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32)
    };

    if hresult_succeeded(hr) {
        Ok(ComApartmentGuard { should_uninitialize: true })
    } else if hr == RPC_E_CHANGED_MODE {
        // The thread is already initialized with a different COM apartment.
        // Shell APIs can still run; this branch must not call CoUninitialize.
        Ok(ComApartmentGuard { should_uninitialize: false })
    } else {
        Err(AppError::Generic(format!(
            "Failed to initialize COM for File Explorer: {}",
            format_hresult(hr)
        )))
    }
}

#[cfg(target_os = "windows")]
fn path_to_shell_wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    let display_path = explorer_compatible_path(&path.to_string_lossy());
    std::ffi::OsStr::new(&display_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(target_os = "windows")]
fn open_folder_fallback_in_explorer(path: &Path) -> AppResult<()> {
    let folder_path = if path.is_dir() {
        path
    } else {
        path.parent().unwrap_or(path)
    };
    let folder_path = explorer_compatible_path(&folder_path.to_string_lossy());

    std::process::Command::new("explorer")
        .arg(folder_path)
        .spawn()
        .map_err(|e| AppError::Generic(format!("Failed to open File Explorer: {}", e)))?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn reveal_path_in_file_explorer(path: &Path) -> AppResult<()> {
    let path = path.to_path_buf();
    let handle = std::thread::Builder::new()
        .name("agentvis-shell-reveal".to_string())
        .spawn(move || reveal_path_in_file_explorer_on_sta_thread(&path))
        .map_err(|e| AppError::Generic(format!("Failed to start File Explorer reveal thread: {}", e)))?;

    handle
        .join()
        .map_err(|_| AppError::Generic("File Explorer reveal thread panicked".to_string()))?
}

#[cfg(target_os = "windows")]
fn reveal_path_in_file_explorer_on_sta_thread(path: &Path) -> AppResult<()> {
    use windows_sys::Win32::UI::Shell::{
        Common::ITEMIDLIST,
        ILFree,
        SHOpenFolderAndSelectItems,
        SHParseDisplayName,
    };

    let _com = initialize_shell_com()?;
    let wide_path = path_to_shell_wide(path);
    let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
    let mut attributes = 0u32;

    let parse_hr = unsafe {
        SHParseDisplayName(
            wide_path.as_ptr(),
            std::ptr::null_mut(),
            &mut pidl,
            0,
            &mut attributes,
        )
    };

    if !hresult_succeeded(parse_hr) || pidl.is_null() {
        return Err(AppError::Generic(format!(
            "Failed to parse path for File Explorer: {}",
            format_hresult(parse_hr)
        )));
    }

    let open_hr = unsafe {
        let hr = SHOpenFolderAndSelectItems(pidl, 0, std::ptr::null(), 0);
        ILFree(pidl);
        hr
    };

    if hresult_succeeded(open_hr) {
        Ok(())
    } else {
        Err(AppError::Generic(format!(
            "Failed to reveal path in File Explorer: {}",
            format_hresult(open_hr)
        )))
    }
}

/// 在系统文件管理器中显示并选中文件
///
/// 跨平台实现：
/// - Windows: `explorer.exe /select,"<path>"`
/// - macOS: `open -R "<path>"`
/// - Linux: `xdg-open` 打开文件所在的父目录
///
/// # Arguments
/// * `file_path` - 文件或目录路径
#[tauri::command]
pub async fn file_reveal_in_explorer(
    file_path: String,
) -> AppResult<()> {
    let path = PathBuf::from(&file_path);

    if !path.exists() {
        return Err(AppError::NotFound(format!("Path does not exist: {}", file_path)));
    }

    let canonical_path = path
        .canonicalize()
        .map_err(|e| AppError::FileSystem(format!("Failed to canonicalize path: {}", e)))?;

    #[cfg(target_os = "windows")]
    {
        if let Err(e) = reveal_path_in_file_explorer(&canonical_path) {
            log::warn!(
                "[file] Shell API reveal failed, opening parent folder fallback: {}",
                e
            );
            open_folder_fallback_in_explorer(&canonical_path)?;
        }
    }

    #[cfg(target_os = "macos")]
    {
        let canonical_file_path = canonical_path.to_string_lossy().to_string();
        std::process::Command::new("open")
            .args(["-R", &canonical_file_path])
            .spawn()
            .map_err(|e| AppError::Generic(format!("Failed to open Finder: {}", e)))?;
    }

    #[cfg(target_os = "linux")]
    {
        let canonical_file_path = canonical_path.to_string_lossy().to_string();
        // Linux 无统一的"选中文件"能力，fallback 为打开父目录
        let parent = canonical_path.parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| canonical_file_path.clone());
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| AppError::Generic(format!("Failed to open file manager: {}", e)))?;
    }

    log::debug!("[file] 已在文件管理器中显示: {}", file_path);

    Ok(())
}

#[cfg(test)]
mod reveal_in_explorer_tests {
    use super::*;

    #[test]
    fn explorer_compatible_path_keeps_normal_paths() {
        let path = r"C:\Users\Muulo\Documents\Videos\Agent Harness explained in 8min.. [1a1VXDdIyrk].mp4";

        assert_eq!(explorer_compatible_path(path), path);
    }

    #[test]
    fn explorer_compatible_path_removes_verbatim_prefix() {
        let path = r"\\?\C:\Users\Muulo\Documents\Videos\Agent Harness explained in 8min.. [1a1VXDdIyrk].mp4";

        assert_eq!(
            explorer_compatible_path(path),
            r"C:\Users\Muulo\Documents\Videos\Agent Harness explained in 8min.. [1a1VXDdIyrk].mp4"
        );
    }

    #[test]
    fn explorer_compatible_path_converts_verbatim_unc_prefix() {
        let path = r"\\?\UNC\server\share\Agent Harness explained in 8min.. [1a1VXDdIyrk].mp4";

        assert_eq!(
            explorer_compatible_path(path),
            r"\\server\share\Agent Harness explained in 8min.. [1a1VXDdIyrk].mp4"
        );
    }
}

// ==================== 目录浏览 ====================

/// 目录条目响应
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    /// 条目名称（文件名或文件夹名）
    pub name: String,
    /// 是否为目录
    pub is_directory: bool,
    /// 文件大小（目录为 0）
    pub size: u64,
    /// 创建时间（Unix 秒）
    pub created_at: i64,
    /// 相对于交付物根目录的路径
    pub relative_path: String,
    /// 绝对路径（用于预览和操作）
    pub absolute_path: String,
}

/// 工作区导入结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportResult {
    /// 导入后的绝对路径
    pub file_path: String,
    /// 相对工作区根目录的路径
    pub relative_path: String,
    /// 是否为目录
    pub is_directory: bool,
}

/// 将拖入的文件或目录导入当前工作区目录
///
/// 支持两种目标：
/// - 普通 Agent 交付物目录：`deliverables/<hub_name>/<agent_name>/`
/// - 关联项目目录：`root_dir`
///
/// 前端负责读取拖拽内容并传入相对路径；后端负责路径清洗、越界校验和重名避让。
#[tauri::command]
pub async fn file_import_to_workspace(
    app_handle: tauri::AppHandle,
    hub_name: String,
    agent_name: String,
    root_dir: Option<String>,
    current_relative_path: String,
    item_relative_path: String,
    is_directory: bool,
    base64_data: Option<String>,
) -> AppResult<WorkspaceImportResult> {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;

    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| AppError::FileSystem(format!("Failed to get app data directory: {}", e)))?;

    let workspace_root = match root_dir.as_deref().filter(|path| !path.trim().is_empty()) {
        Some(project_root) => {
            let root = PathBuf::from(project_root);
            if !root.exists() || !root.is_dir() {
                return Err(AppError::NotFound(format!(
                    "Project directory does not exist: {}",
                    project_root
                )));
            }
            root
        }
        None => {
            let root = app_data_dir
                .join("deliverables")
                .join(&hub_name)
                .join(&agent_name);
            fs::create_dir_all(&root)
                .map_err(|e| AppError::FileSystem(format!("Failed to create workspace directory: {}", e)))?;
            root
        }
    };

    let canonical_root = workspace_root
        .canonicalize()
        .map_err(|e| AppError::FileSystem(format!("Failed to canonicalize workspace root: {}", e)))?;

    let current_relative = sanitize_optional_relative_path(&current_relative_path)?;
    let current_dir = canonical_root.join(current_relative);
    command_validator::validate_path_write_safety(&current_dir, &app_data_dir)?;
    fs::create_dir_all(&current_dir)
        .map_err(|e| AppError::FileSystem(format!("Failed to create target directory: {}", e)))?;
    ensure_path_within_root(&canonical_root, &current_dir)?;

    let item_relative = sanitize_required_relative_path(&item_relative_path)?;
    let target_path = current_dir.join(item_relative);

    if is_directory {
        command_validator::validate_path_write_safety(&target_path, &app_data_dir)?;
        fs::create_dir_all(&target_path)
            .map_err(|e| AppError::FileSystem(format!("Failed to create imported folder: {}", e)))?;
        ensure_path_within_root(&canonical_root, &target_path)?;

        let relative_path = target_path
            .strip_prefix(&canonical_root)
            .map(|p| p.to_string_lossy().to_string().replace('\\', "/"))
            .unwrap_or_else(|_| item_relative_path.clone());

        log::debug!(
            "[file] 已导入文件夹到工作区: {}",
            target_path.display()
        );

        return Ok(WorkspaceImportResult {
            file_path: target_path.to_string_lossy().to_string(),
            relative_path,
            is_directory: true,
        });
    }

    let parent_dir = target_path
        .parent()
        .ok_or_else(|| AppError::Generic("Invalid import target path".to_string()))?;
    command_validator::validate_path_write_safety(&target_path, &app_data_dir)?;
    fs::create_dir_all(parent_dir)
        .map_err(|e| AppError::FileSystem(format!("Failed to create imported file directory: {}", e)))?;
    ensure_path_within_root(&canonical_root, parent_dir)?;

    let file_name = target_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Generic("Invalid import file name".to_string()))?;
    let final_file_name = get_unique_filename(parent_dir, file_name);
    let final_path = parent_dir.join(final_file_name);
    command_validator::validate_path_write_safety(&final_path, &app_data_dir)?;

    let encoded = base64_data
        .ok_or_else(|| AppError::Generic("Missing file data for workspace import".to_string()))?;
    let file_data = STANDARD
        .decode(&encoded)
        .map_err(|e| AppError::Generic(format!("Invalid base64 data: {}", e)))?;

    fs::write(&final_path, &file_data)
        .map_err(|e| AppError::FileSystem(format!("Failed to write imported file: {}", e)))?;
    ensure_path_within_root(&canonical_root, &final_path)?;

    let relative_path = final_path
        .strip_prefix(&canonical_root)
        .map(|p| p.to_string_lossy().to_string().replace('\\', "/"))
        .unwrap_or_else(|_| item_relative_path.clone());

    log::debug!(
        "[file] 已导入文件到工作区: {} ({} bytes)",
        final_path.display(),
        file_data.len()
    );

    Ok(WorkspaceImportResult {
        file_path: final_path.to_string_lossy().to_string(),
        relative_path,
        is_directory: false,
    })
}

/// 将后端暂存的大工具参数直接写入指定路径，避免大 content 经由 WebView IPC 往返。
#[tauri::command]
pub async fn file_write_staged_tool_arg_to_path(
    app_handle: tauri::AppHandle,
    path: String,
    ref_id: String,
    create_backup: bool,
) -> AppResult<StagedWriteResult> {
    let file_path = PathBuf::from(&path);

    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    command_validator::validate_path_write_safety(&file_path, &app_data_dir)?;

    let staged_path = resolve_large_tool_arg_path(&app_handle, &ref_id)?;
    if !staged_path.exists() {
        return Err(AppError::NotFound(format!("Large tool arg ref does not exist: {}", ref_id)));
    }

    let bytes = fs::read(&staged_path)
        .map_err(|e| AppError::FileSystem(format!("Failed to read staged tool arg content: {}", e)))?;

    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::FileSystem(format!("Failed to create directory: {}", e)))?;
    }

    let existed_before = file_path.exists();
    let backup_path = if create_backup && existed_before {
        Some(file_create_backup_internal(&app_handle, &path)?)
    } else {
        None
    };

    fs::write(&file_path, &bytes)
        .map_err(|e| AppError::FileSystem(format!("Failed to write staged content: {}", e)))?;

    if let Err(e) = fs::remove_file(&staged_path) {
        log::warn!("[file] failed to remove staged tool arg ref {}: {}", ref_id, e);
    }

    log::info!(
        "[file] wrote staged tool arg content: ref={}, target={}, bytes={}",
        ref_id,
        path,
        bytes.len()
    );

    Ok(StagedWriteResult {
        success: true,
        file_path: path,
        backup_path,
        bytes_written: bytes.len() as u64,
        existed_before,
    })
}

/// 列出交付物目录的直接子项
///
/// 用于文件夹导航模式，只返回指定目录的直接子项（不递归）。
/// 结果按"文件夹优先，文件在后"排序，同类按名称排序。
///
/// # Arguments
/// * `hub_name` - Hub 名称（已清理的安全文件名）
/// * `agent_name` - Agent 名称（已清理的安全文件名）
/// * `relative_path` - 相对于交付物根目录的路径（空字符串表示根目录）
///
/// # Returns
/// 目录条目列表
#[tauri::command]
pub async fn file_list_directory(
    app_handle: tauri::AppHandle,
    hub_name: String,
    agent_name: String,
    relative_path: String,
) -> AppResult<Vec<DirectoryEntry>> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| AppError::FileSystem(format!("Failed to get app data directory: {}", e)))?;

    // 交付物根目录: deliverables/<hub_name>/<agent_name>/
    let root_dir = base_dir.join("deliverables").join(&hub_name).join(&agent_name);

    if !root_dir.exists() {
        return Ok(vec![]);
    }

    // 计算目标目录
    let target_dir = if relative_path.is_empty() {
        root_dir.clone()
    } else {
        let target = root_dir.join(&relative_path);
        // 安全检查：防止路径遍历攻击
        let canonical_root = root_dir.canonicalize()
            .map_err(|e| AppError::FileSystem(format!("Failed to canonicalize root path: {}", e)))?;
        let canonical_target = target.canonicalize()
            .map_err(|e| AppError::FileSystem(format!("Path does not exist: {}", e)))?;
        if !canonical_target.starts_with(&canonical_root) {
            return Err(AppError::Generic("Invalid path: access outside the deliverables root is not allowed".to_string()));
        }
        target
    };

    if !target_dir.is_dir() {
        return Err(AppError::Generic(format!("Not a directory: {}", target_dir.display())));
    }

    let mut entries = Vec::new();

    if let Ok(dir_entries) = fs::read_dir(&target_dir) {
        for entry in dir_entries.flatten() {
            let path = entry.path();
            let name = path.file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();

            let is_directory = path.is_dir();

            let (size, created_at) = if let Ok(metadata) = entry.metadata() {
                let size = if is_directory { 0 } else { metadata.len() };
                let created_at = metadata.created()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                (size, created_at)
            } else {
                (0, 0)
            };

            // 相对于交付物根目录的路径
            let entry_relative_path = path.strip_prefix(&root_dir)
                .map(|p| p.to_string_lossy().to_string().replace('\\', "/"))
                .unwrap_or_else(|_| name.clone());

            entries.push(DirectoryEntry {
                name,
                is_directory,
                size,
                created_at,
                relative_path: entry_relative_path,
                absolute_path: path.to_string_lossy().to_string(),
            });
        }
    }

    // 排序：目录优先，同类按名称排序
    entries.sort_by(|a, b| {
        match (a.is_directory, b.is_directory) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

/// 列出任意绝对目录的直接子项（项目路径模式）
///
/// 与 `file_list_directory` 功能一致，但接受绝对路径作为根目录，
/// 而非基于 deliverables/{hub}/{agent} 拼接。用于 agent 关联外部项目时
/// 在右栏文件面板中浏览项目目录。
///
/// 安全约束：`relative_path` 不允许 `..` 遍历到 `root_dir` 之外。
///
/// # Arguments
/// * `root_dir` - 项目根目录绝对路径
/// * `relative_path` - 相对于 root_dir 的子路径（空字符串表示根目录）
///
/// # Returns
/// 目录条目列表
#[tauri::command]
pub async fn file_list_project_directory(
    root_dir: String,
    relative_path: String,
) -> AppResult<Vec<DirectoryEntry>> {
    let root = PathBuf::from(&root_dir);

    if !root.exists() || !root.is_dir() {
        return Err(AppError::NotFound(format!("Project directory does not exist: {}", root_dir)));
    }

    // 计算目标目录
    let target_dir = if relative_path.is_empty() {
        root.clone()
    } else {
        let target = root.join(&relative_path);
        // 安全检查：防止路径遍历攻击（.. 逃逸到 root_dir 之外）
        let canonical_root = root.canonicalize()
            .map_err(|e| AppError::FileSystem(format!("Failed to canonicalize root path: {}", e)))?;
        let canonical_target = target.canonicalize()
            .map_err(|e| AppError::FileSystem(format!("Path does not exist: {}", e)))?;
        if !canonical_target.starts_with(&canonical_root) {
            return Err(AppError::Generic("Invalid path: access outside the project root is not allowed".to_string()));
        }
        target
    };

    if !target_dir.is_dir() {
        return Err(AppError::Generic(format!("Not a directory: {}", target_dir.display())));
    }

    let mut entries = Vec::new();

    if let Ok(dir_entries) = fs::read_dir(&target_dir) {
        for entry in dir_entries.flatten() {
            let path = entry.path();
            let name = path.file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();

            let is_directory = path.is_dir();

            let (size, created_at) = if let Ok(metadata) = entry.metadata() {
                let size = if is_directory { 0 } else { metadata.len() };
                let created_at = metadata.created()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                (size, created_at)
            } else {
                (0, 0)
            };

            // 相对路径：相对于项目根目录
            let entry_relative_path = path.strip_prefix(&root)
                .map(|p| p.to_string_lossy().to_string().replace('\\', "/"))
                .unwrap_or_else(|_| name.clone());

            entries.push(DirectoryEntry {
                name,
                is_directory,
                size,
                created_at,
                relative_path: entry_relative_path,
                absolute_path: path.to_string_lossy().to_string(),
            });
        }
    }

    // 排序：目录优先，同类按名称排序
    entries.sort_by(|a, b| {
        match (a.is_directory, b.is_directory) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

// ==================== 备份管理 ====================

/// 备份目录统计信息
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStats {
    /// backups/ 目录绝对路径
    pub dir_path: String,
    /// 备份文件总数
    pub file_count: u32,
    /// 备份总大小（字节）
    pub total_bytes: u64,
}

/// 批量清理策略
///
/// 使用 `#[serde(tag = "type")]` 实现 TS 侧的联合类型映射：
/// `{ type: 'olderThanDays', days: 7 }` 等
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CleanPolicy {
    /// 删除 N 天前的备份
    OlderThanDays { days: u32 },
    /// 每个原文件保留最近 N 个版本
    KeepLatestPerFile { count: u32 },
    /// 清空全部
    DeleteAll,
}

/// 批量清理结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanResult {
    /// 实际删除的文件数
    pub deleted_count: u32,
    /// 释放的字节数
    pub freed_bytes: u64,
}

/// 获取备份目录统计信息
///
/// 扫描 `<app_data>/backups/` 目录，返回备份文件数和总大小。
/// 如果目录尚不存在，返回零值统计（不报错）。
#[tauri::command]
pub async fn backup_get_stats(app_handle: tauri::AppHandle) -> AppResult<BackupStats> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| AppError::FileSystem(format!("Failed to get app data directory: {}", e)))?;

    let backups_dir = app_data_dir.join("backups");
    let dir_path = backups_dir.to_string_lossy().to_string();

    // 目录不存在时返回零值统计
    if !backups_dir.exists() {
        return Ok(BackupStats {
            dir_path,
            file_count: 0,
            total_bytes: 0,
        });
    }

    let mut file_count: u32 = 0;
    let mut total_bytes: u64 = 0;

    if let Ok(entries) = fs::read_dir(&backups_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            // 只统计文件，跳过子目录
            if path.is_file() {
                if let Ok(metadata) = entry.metadata() {
                    file_count += 1;
                    total_bytes += metadata.len();
                }
            }
        }
    }

    Ok(BackupStats {
        dir_path,
        file_count,
        total_bytes,
    })
}

/// 批量清理备份文件
///
/// 支持三种清理策略：
/// - `OlderThanDays { days }` — 删除创建时间超过 N 天的备份
/// - `KeepLatestPerFile { count }` — 每个原文件只保留最新 N 个版本
/// - `DeleteAll` — 清空全部备份文件
#[tauri::command]
pub async fn backup_clean(
    app_handle: tauri::AppHandle,
    policy: CleanPolicy,
) -> AppResult<CleanResult> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| AppError::FileSystem(format!("Failed to get app data directory: {}", e)))?;

    let backups_dir = app_data_dir.join("backups");

    // 目录不存在时直接返回零结果
    if !backups_dir.exists() {
        return Ok(CleanResult {
            deleted_count: 0,
            freed_bytes: 0,
        });
    }

    // 收集所有备份文件的元信息
    let mut backup_files: Vec<(PathBuf, u64, i64)> = Vec::new(); // (path, size_bytes, created_secs)

    if let Ok(entries) = fs::read_dir(&backups_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Ok(metadata) = entry.metadata() {
                    let size = metadata.len();
                    // 优先使用 created()，fallback 到 modified() 再 fallback 到 0
                    let created_secs = metadata
                        .created()
                        .or_else(|_| metadata.modified())
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    backup_files.push((path, size, created_secs));
                }
            }
        }
    }

    // 确定需要删除的文件集合
    let files_to_delete: Vec<(PathBuf, u64)> = match policy {
        CleanPolicy::DeleteAll => {
            // 删除全部
            backup_files
                .into_iter()
                .map(|(path, size, _)| (path, size))
                .collect()
        }

        CleanPolicy::OlderThanDays { days } => {
            // 删除创建时间超过 N 天的文件
            let now_secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let threshold_secs = now_secs - (days as i64) * 86400;

            backup_files
                .into_iter()
                .filter(|(_, _, created)| *created < threshold_secs)
                .map(|(path, size, _)| (path, size))
                .collect()
        }

        CleanPolicy::KeepLatestPerFile { count } => {
            // 按"原文件名（不含时间戳后缀）"分组，每组仅保留最新 N 个版本
            // 文件名格式: {base}_{YYYYMMDD_HHMMSS}{ext}，用 8+1+6=15 位时间戳识别
            use std::collections::HashMap;

            // group_key -> Vec<(path, size, created_secs)>
            let mut groups: HashMap<String, Vec<(PathBuf, u64, i64)>> = HashMap::new();

            for (path, size, created) in backup_files {
                let group_key = extract_original_name(&path);
                groups.entry(group_key).or_default().push((path, size, created));
            }

            let mut to_delete = Vec::new();
            for (_, mut versions) in groups {
                // 按创建时间降序排列，保留最新的 count 个
                versions.sort_by(|a, b| b.2.cmp(&a.2));
                let keep = count as usize;
                if versions.len() > keep {
                    for (path, size, _) in versions.into_iter().skip(keep) {
                        to_delete.push((path, size));
                    }
                }
            }
            to_delete
        }
    };

    // 执行删除
    let mut deleted_count: u32 = 0;
    let mut freed_bytes: u64 = 0;

    for (path, size) in files_to_delete {
        match fs::remove_file(&path) {
            Ok(()) => {
                deleted_count += 1;
                freed_bytes += size;
                log::debug!("[backup] 已删除备份: {}", path.display());
            }
            Err(e) => {
                // 单个文件删除失败不中断整体流程，仅记录
                log::warn!("[backup] 删除备份失败: {} — {}", path.display(), e);
            }
        }
    }

    log::debug!(
        "[backup] 清理完成: 删除 {} 个文件，释放 {} 字节",
        deleted_count, freed_bytes
    );

    Ok(CleanResult {
        deleted_count,
        freed_bytes,
    })
}

/// 从备份文件路径中提取原始文件名（作为分组 key）
///
/// 文件名格式：`{base}_{YYYYMMDD_HHMMSS}{ext}`
/// 例如：`Timeline_20260410_110518.tsx` → `Timeline.tsx`
///
/// 如果无法识别时间戳后缀，直接使用完整文件名作为分组 key。
fn extract_original_name(path: &PathBuf) -> String {
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    // 从扩展名处分割
    let (stem, ext_with_dot) = if let Some(dot_idx) = file_name.rfind('.') {
        (&file_name[..dot_idx], &file_name[dot_idx..])
    } else {
        (file_name.as_str(), "")
    };

    // 时间戳后缀格式: _YYYYMMDD_HHMMSS（共 16 个字符）
    // 例: "_20260410_110518"
    const TIMESTAMP_SUFFIX_LEN: usize = 16; // "_" + 8 + "_" + 6
    if stem.len() > TIMESTAMP_SUFFIX_LEN {
        let possible_suffix = &stem[stem.len() - TIMESTAMP_SUFFIX_LEN..];
        // 验证格式：_XXXXXXXX_XXXXXX（首字符 '_'，位置 9 也是 '_'，其余全为数字）
        let is_valid_timestamp = possible_suffix.starts_with('_')
            && possible_suffix.chars().nth(9) == Some('_')
            && possible_suffix[1..9].chars().all(|c| c.is_ascii_digit())
            && possible_suffix[10..].chars().all(|c| c.is_ascii_digit());

        if is_valid_timestamp {
            let base = &stem[..stem.len() - TIMESTAMP_SUFFIX_LEN];
            return format!("{}{}", base, ext_with_dot);
        }
    }

    // 无法识别时间戳后缀，使用完整文件名
    file_name
}
