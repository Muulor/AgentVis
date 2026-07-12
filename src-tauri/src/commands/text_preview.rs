//! 大型文本文件安全预览命令。
//!
//! 提供有界 UTF-8 窗口读取和限量结构分析，避免超大文本全文经由 IPC
//! 进入 WebView 并触发 Markdown、代码高亮或 DOM 渲染放大。

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::path::PathBuf;

use crate::error::{AppError, AppResult};

const TEXT_PREVIEW_WINDOW_DEFAULT_BYTES: usize = 64 * 1024;
const TEXT_PREVIEW_WINDOW_MAX_BYTES: usize = 256 * 1024;
const TEXT_PREVIEW_ANALYSIS_MAX_BYTES: usize = 4 * 1024 * 1024;

/// 有界文本窗口响应。所有 offset 都是 UTF-8 字节偏移。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFileWindow {
    pub content: String,
    pub start_byte: u64,
    pub next_byte: u64,
    pub total_bytes: u64,
    pub eof: bool,
}

/// 文本预览复杂度摘要。扫描在后端限量完成，不把全文传入 WebView。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPreviewAnalysis {
    pub total_bytes: u64,
    pub scanned_bytes: u64,
    pub line_count: u64,
    pub max_line_bytes: u64,
    pub markdown_link_count: u64,
    pub markdown_image_count: u64,
    pub markdown_table_row_count: u64,
    pub markdown_table_cell_count: u64,
    pub max_code_block_bytes: u64,
    pub scan_truncated: bool,
}

fn count_occurrences(haystack: &str, needle: &str) -> u64 {
    haystack.match_indices(needle).count() as u64
}

fn analyze_text_preview_content(
    content: &str,
    total_bytes: u64,
    scanned_bytes: u64,
) -> TextPreviewAnalysis {
    let mut line_count = 0_u64;
    let mut max_line_bytes = 0_u64;
    let mut markdown_table_row_count = 0_u64;
    let mut markdown_table_cell_count = 0_u64;
    let mut max_code_block_bytes = 0_u64;
    let mut current_code_block_bytes: Option<u64> = None;

    for line in content.lines() {
        line_count += 1;
        max_line_bytes = max_line_bytes.max(line.len() as u64);

        let trimmed = line.trim_start();
        if trimmed.starts_with('|') {
            markdown_table_row_count += 1;
            markdown_table_cell_count += (trimmed
                .as_bytes()
                .iter()
                .filter(|byte| **byte == b'|')
                .count() as u64)
                .saturating_sub(1);
        }

        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            if let Some(code_block_bytes) = current_code_block_bytes.take() {
                max_code_block_bytes = max_code_block_bytes.max(code_block_bytes);
            } else {
                current_code_block_bytes = Some(0);
            }
        } else if let Some(code_block_bytes) = current_code_block_bytes.as_mut() {
            *code_block_bytes += line.len() as u64 + 1;
        }
    }

    if let Some(code_block_bytes) = current_code_block_bytes {
        max_code_block_bytes = max_code_block_bytes.max(code_block_bytes);
    }

    TextPreviewAnalysis {
        total_bytes,
        scanned_bytes,
        line_count,
        max_line_bytes,
        markdown_link_count: count_occurrences(content, "]("),
        markdown_image_count: count_occurrences(content, "!["),
        markdown_table_row_count,
        markdown_table_cell_count,
        max_code_block_bytes,
        scan_truncated: scanned_bytes < total_bytes,
    }
}

fn read_text_file_window_internal(
    path: &Path,
    offset: u64,
    max_bytes: usize,
) -> AppResult<TextFileWindow> {
    let mut file = fs::File::open(path)
        .map_err(|e| AppError::FileSystem(format!("Failed to open text preview file: {}", e)))?;
    let total_bytes = file
        .metadata()
        .map_err(|e| AppError::FileSystem(format!("Failed to get text preview metadata: {}", e)))?
        .len();
    let start_byte = offset.min(total_bytes);
    let bounded_max_bytes = max_bytes.clamp(1024, TEXT_PREVIEW_WINDOW_MAX_BYTES);

    file.seek(SeekFrom::Start(start_byte))
        .map_err(|e| AppError::FileSystem(format!("Failed to seek text preview file: {}", e)))?;

    let mut bytes = vec![0_u8; bounded_max_bytes];
    let bytes_read = file
        .read(&mut bytes)
        .map_err(|e| AppError::FileSystem(format!("Failed to read text preview window: {}", e)))?;
    bytes.truncate(bytes_read);

    let valid_len = match std::str::from_utf8(&bytes) {
        Ok(_) => bytes.len(),
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        Err(error) => {
            return Err(AppError::FileSystem(format!(
                "Text preview is not valid UTF-8 near byte {}",
                start_byte + error.valid_up_to() as u64
            )))
        }
    };
    bytes.truncate(valid_len);
    let content = String::from_utf8(bytes).map_err(|e| {
        AppError::FileSystem(format!("Failed to decode text preview window: {}", e))
    })?;
    let next_byte = start_byte + valid_len as u64;

    Ok(TextFileWindow {
        content,
        start_byte,
        next_byte,
        total_bytes,
        eof: next_byte >= total_bytes,
    })
}

/// 有界读取文本文件，避免大文件全文经由 IPC 进入 WebView。
#[tauri::command]
pub async fn file_read_text_window(
    file_path: String,
    offset: Option<u64>,
    max_bytes: Option<usize>,
) -> AppResult<TextFileWindow> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(AppError::NotFound(format!(
            "File does not exist: {}",
            file_path
        )));
    }
    if !path.is_file() {
        return Err(AppError::FileSystem(format!("Not a file: {}", file_path)));
    }

    read_text_file_window_internal(
        &path,
        offset.unwrap_or(0),
        max_bytes.unwrap_or(TEXT_PREVIEW_WINDOW_DEFAULT_BYTES),
    )
}

/// 限量扫描文本结构，为预览策略提供复杂度指标。
#[tauri::command]
pub async fn file_analyze_text_preview(file_path: String) -> AppResult<TextPreviewAnalysis> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(AppError::NotFound(format!(
            "File does not exist: {}",
            file_path
        )));
    }
    if !path.is_file() {
        return Err(AppError::FileSystem(format!("Not a file: {}", file_path)));
    }

    let file = fs::File::open(&path)
        .map_err(|e| AppError::FileSystem(format!("Failed to open text preview file: {}", e)))?;
    let total_bytes = file
        .metadata()
        .map_err(|e| AppError::FileSystem(format!("Failed to get text preview metadata: {}", e)))?
        .len();
    let mut bytes = Vec::with_capacity((total_bytes as usize).min(TEXT_PREVIEW_ANALYSIS_MAX_BYTES));
    file.take(TEXT_PREVIEW_ANALYSIS_MAX_BYTES as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| AppError::FileSystem(format!("Failed to analyze text preview file: {}", e)))?;
    let scanned_bytes = bytes.len() as u64;
    let content = String::from_utf8_lossy(&bytes);

    Ok(analyze_text_preview_content(
        &content,
        total_bytes,
        scanned_bytes,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analysis_counts_markdown_complexity_without_building_an_ast() {
        let content = "# Report\n\n| A | B |\n|---|---|\n| [one](https://example.com) | ![image](x.png) |\n\n```ts\nconst value = 1;\n```\n";
        let analysis =
            analyze_text_preview_content(content, content.len() as u64, content.len() as u64);

        assert_eq!(analysis.markdown_table_row_count, 3);
        assert_eq!(analysis.markdown_table_cell_count, 6);
        assert_eq!(analysis.markdown_link_count, 2);
        assert_eq!(analysis.markdown_image_count, 1);
        assert!(analysis.max_code_block_bytes >= 17);
        assert!(!analysis.scan_truncated);
    }

    #[test]
    fn bounded_window_keeps_utf8_offsets_valid() {
        let path =
            std::env::temp_dir().join(format!("agentvis-text-preview-{}.md", uuid::Uuid::new_v4()));
        let content = "你".repeat(500);
        fs::write(&path, content.as_bytes()).expect("write preview fixture");

        let first = read_text_file_window_internal(&path, 0, 1024).expect("read first window");
        let second = read_text_file_window_internal(&path, first.next_byte, 1024)
            .expect("read second window");
        fs::remove_file(&path).expect("remove preview fixture");

        assert!(!first.content.contains('\u{fffd}'));
        assert_eq!(format!("{}{}", first.content, second.content), content);
        assert!(second.eof);
    }

    #[test]
    fn bounded_window_enforces_the_backend_hard_cap() {
        let path = std::env::temp_dir().join(format!(
            "agentvis-text-preview-cap-{}.txt",
            uuid::Uuid::new_v4()
        ));
        fs::write(&path, vec![b'a'; TEXT_PREVIEW_WINDOW_MAX_BYTES * 2])
            .expect("write preview cap fixture");

        let window = read_text_file_window_internal(&path, 0, usize::MAX)
            .expect("read capped preview window");
        fs::remove_file(&path).expect("remove preview cap fixture");

        assert_eq!(window.content.len(), TEXT_PREVIEW_WINDOW_MAX_BYTES);
        assert!(!window.eof);
    }
}
