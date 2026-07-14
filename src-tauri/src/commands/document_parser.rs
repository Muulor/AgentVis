//! 文档解析相关 Tauri Commands
//!
//! 提供 Office 文档和 PDF 的文本提取功能
//!
//! 支持格式：
//! - Word: .docx
//! - Excel: .xlsx, .xls
//! - PDF: .pdf

use calamine::{open_workbook, Reader, Xls, Xlsx};
use std::path::Path;
#[cfg(target_os = "windows")]
use std::path::PathBuf;

use crate::error::{AppError, AppResult};

#[cfg(target_os = "windows")]
const PDF_OCR_MAX_PAGES: u32 = 12;

#[cfg(target_os = "windows")]
const PDF_OCR_RENDER_MAX_DIMENSION: u32 = 2200;

// ==================== Tauri Commands ====================

/// 解析 Word 文档 (.docx)
///
/// 提取 Word 文档中的纯文本内容
///
/// # Arguments
/// * `file_path` - 文件路径
///
/// # Returns
/// 文档文本内容
#[tauri::command]
pub async fn parse_docx(file_path: String) -> AppResult<String> {
    let path = Path::new(&file_path);

    if !path.exists() {
        return Err(AppError::NotFound(format!(
            "File does not exist: {}",
            file_path
        )));
    }

    // 检查文件扩展名
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());

    if ext.as_deref() != Some("docx") {
        return Err(AppError::Generic(
            "Unsupported file format. This command only supports .docx files. If this is a .doc file, save it as .docx with Microsoft Word first.".to_string()
        ));
    }

    // 读取文件内容
    let file_bytes = std::fs::read(path)
        .map_err(|e| AppError::FileSystem(format!("Failed to read file: {}", e)))?;

    // 使用 docx-rs 解析
    let docx = docx_rs::read_docx(&file_bytes)
        .map_err(|e| AppError::FileSystem(format!("Failed to parse Word document: {}", e)))?;

    // 提取文本
    let mut text_content = String::new();

    for child in docx.document.children {
        if let docx_rs::DocumentChild::Paragraph(para) = child {
            let mut para_text = String::new();
            for run_child in para.children {
                if let docx_rs::ParagraphChild::Run(run) = run_child {
                    for run_item in run.children {
                        if let docx_rs::RunChild::Text(text) = run_item {
                            para_text.push_str(&text.text);
                        }
                    }
                }
            }
            if !para_text.is_empty() {
                text_content.push_str(&para_text);
                text_content.push('\n');
            }
        }
    }

    if text_content.is_empty() {
        return Err(AppError::Generic(
            "Word document is empty or text content could not be extracted".to_string(),
        ));
    }

    log::trace!(
        "[document_parser] 成功解析 Word 文档: {} ({} 字符)",
        file_path,
        text_content.len()
    );

    Ok(text_content)
}

/// 解析 PowerPoint 文档 (.pptx)
///
/// 提取 PowerPoint 文档中的文本内容，转换为 Markdown 格式
///
/// # Arguments
/// * `file_path` - 文件路径
///
/// # Returns
/// Markdown 格式的幻灯片内容
#[tauri::command]
pub async fn parse_pptx(file_path: String) -> AppResult<String> {
    let path = Path::new(&file_path);

    if !path.exists() {
        return Err(AppError::NotFound(format!(
            "File does not exist: {}",
            file_path
        )));
    }

    // 检查文件扩展名
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());

    if ext.as_deref() != Some("pptx") {
        return Err(AppError::Generic(
            "Unsupported file format. This command only supports .pptx files. If this is a .ppt file, save it as .pptx with Microsoft PowerPoint first.".to_string()
        ));
    }

    // 尝试使用 pptx-to-md 解析
    let mut output = String::new();
    let mut slide_count = 0;
    let mut pptx_to_md_failed = false;

    match pptx_to_md::PptxContainer::open(path, pptx_to_md::ParserConfig::default()) {
        Ok(mut pptx) => {
            for (i, slide_result) in pptx.iter_slides().enumerate() {
                let slide = match slide_result {
                    Ok(s) => s,
                    Err(e) => {
                        log::warn!("[document_parser] 解析幻灯片 {} 失败: {}", i + 1, e);
                        continue;
                    }
                };

                output.push_str(&format!("## Slide {}\n\n", i + 1));
                if let Some(slide_md) = slide.convert_to_md() {
                    output.push_str(&slide_md);
                }
                output.push_str("\n\n---\n\n");
                slide_count += 1;
            }

            if output.is_empty() {
                // pptx_to_md 打开成功但所有幻灯片解析失败，切换到降级方案
                pptx_to_md_failed = true;
                log::warn!(
                    "[document_parser] pptx-to-md 所有幻灯片解析失败，尝试 ZIP/XML 降级提取"
                );
            }
        }
        Err(e) => {
            log::warn!(
                "[document_parser] pptx-to-md 打开失败: {}，尝试 ZIP/XML 降级提取",
                e
            );
            pptx_to_md_failed = true;
        }
    }

    // 降级方案：直接从 .pptx ZIP 中提取 <a:t> 文本标签
    // pptx 本质是 ZIP 包，幻灯片内容在 ppt/slides/slideN.xml 中
    if pptx_to_md_failed {
        output = extract_text_from_pptx_zip(path)?;
        slide_count = output.matches("## 幻灯片").count();
    }

    if output.is_empty() {
        return Err(AppError::Generic(
            "PowerPoint document is empty or content could not be extracted".to_string(),
        ));
    }

    log::trace!(
        "[document_parser] 成功解析 PowerPoint 文档: {} ({} 字符, {} 张幻灯片)",
        file_path,
        output.len(),
        slide_count
    );

    Ok(output)
}

/// 降级方案：从 .pptx ZIP 包中直接提取幻灯片文本
///
/// .pptx 文件是 ZIP 格式，幻灯片内容存储在 ppt/slides/slide1.xml 等文件中。
/// 通过正则匹配 `<a:t>` 标签提取纯文本，不依赖第三方 PPTX 解析库。
/// 这是 pptx-to-md 解析失败时的兜底方案（如 pptxgenjs 生成的文件不兼容）。
fn extract_text_from_pptx_zip(path: &Path) -> AppResult<String> {
    use std::io::Read;

    let file = std::fs::File::open(path)
        .map_err(|e| AppError::FileSystem(format!("Failed to open file: {}", e)))?;

    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::FileSystem(format!("Failed to read ZIP structure: {}", e)))?;

    // 收集所有 slide 文件名并排序（确保 slide1 < slide2 < slide10）
    let mut slide_names: Vec<String> = (0..archive.len())
        .filter_map(|i| {
            let name = archive.by_index(i).ok()?.name().to_string();
            if name.starts_with("ppt/slides/slide") && name.ends_with(".xml") {
                Some(name)
            } else {
                None
            }
        })
        .collect();

    // 按幻灯片编号排序（从文件名中提取数字）
    slide_names.sort_by_key(|name| {
        name.trim_start_matches("ppt/slides/slide")
            .trim_end_matches(".xml")
            .parse::<u32>()
            .unwrap_or(0)
    });

    let mut output = String::new();

    for (idx, slide_name) in slide_names.iter().enumerate() {
        let mut slide_file = archive
            .by_name(slide_name)
            .map_err(|e| AppError::FileSystem(format!("Failed to read slide: {}", e)))?;

        let mut xml_content = String::new();
        slide_file
            .read_to_string(&mut xml_content)
            .map_err(|e| AppError::FileSystem(format!("Failed to read XML content: {}", e)))?;

        // 从 XML 中提取 <a:t>...</a:t> 标签内的文本
        let texts: Vec<&str> = xml_content
            .split("<a:t>")
            .skip(1) // 第一个分割结果是 <a:t> 之前的内容
            .filter_map(|segment| segment.split("</a:t>").next())
            .filter(|text| !text.trim().is_empty())
            .collect();

        if !texts.is_empty() {
            output.push_str(&format!("## Slide {}\n\n", idx + 1));
            output.push_str(&texts.join("\n"));
            output.push_str("\n\n---\n\n");
        }
    }

    Ok(output)
}

/// 解析 Excel 文档 (.xlsx, .xls)
///
/// 提取 Excel 文档中所有工作表的内容，转换为 Markdown 表格格式
///
/// # Arguments
/// * `file_path` - 文件路径
///
/// # Returns
/// Markdown 格式的表格内容
#[tauri::command]
pub async fn parse_xlsx(file_path: String) -> AppResult<String> {
    let path = Path::new(&file_path);

    if !path.exists() {
        return Err(AppError::NotFound(format!(
            "File does not exist: {}",
            file_path
        )));
    }

    // 检查文件扩展名
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());

    let mut output = String::new();

    match ext.as_deref() {
        Some("xlsx") => {
            let mut workbook: Xlsx<_> = open_workbook(path)
                .map_err(|e| AppError::FileSystem(format!("Failed to open Excel file: {}", e)))?;

            let sheet_names = workbook.sheet_names().to_vec();

            for sheet_name in sheet_names {
                if let Ok(range) = workbook.worksheet_range(&sheet_name) {
                    output.push_str(&format!("## Worksheet: {}\n\n", sheet_name));
                    output.push_str(&range_to_markdown(&range));
                    output.push_str("\n\n");
                }
            }
        }
        Some("xls") => {
            let mut workbook: Xls<_> = open_workbook(path)
                .map_err(|e| AppError::FileSystem(format!("Failed to open Excel file: {}", e)))?;

            let sheet_names = workbook.sheet_names().to_vec();

            for sheet_name in sheet_names {
                if let Ok(range) = workbook.worksheet_range(&sheet_name) {
                    output.push_str(&format!("## Worksheet: {}\n\n", sheet_name));
                    output.push_str(&range_to_markdown(&range));
                    output.push_str("\n\n");
                }
            }
        }
        _ => {
            return Err(AppError::Generic(
                "Unsupported file format. This command only supports .xlsx and .xls files."
                    .to_string(),
            ));
        }
    }

    if output.is_empty() {
        return Err(AppError::Generic(
            "Excel document is empty or content could not be extracted".to_string(),
        ));
    }

    log::trace!(
        "[document_parser] 成功解析 Excel 文档: {} ({} 字符)",
        file_path,
        output.len()
    );

    Ok(output)
}

/// 解析 PDF 文档
///
/// 提取 PDF 中的文本内容
///
/// # Arguments
/// * `file_path` - 文件路径
///
/// # Returns
/// PDF 文本内容
#[tauri::command]
pub async fn parse_pdf(file_path: String) -> AppResult<String> {
    let path = Path::new(&file_path);

    if !path.exists() {
        return Err(AppError::NotFound(format!(
            "File does not exist: {}",
            file_path
        )));
    }

    // 检查文件扩展名
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());

    if ext.as_deref() != Some("pdf") {
        return Err(AppError::Generic(
            "Unsupported file format. This command only supports .pdf files.".to_string(),
        ));
    }

    // 读取文件
    let file_bytes = std::fs::read(path)
        .map_err(|e| AppError::FileSystem(format!("Failed to read file: {}", e)))?;

    // 优先使用轻量文本层提取；仅在文本层为空/解析失败时尝试 Windows 原生 OCR。
    match pdf_extract::extract_text_from_mem(&file_bytes) {
        Ok(text) if has_pdf_text_content(&text) => {
            log::trace!(
                "[document_parser] 成功解析 PDF 文档: {} ({} 字符)",
                file_path,
                text.len()
            );
            Ok(text)
        }
        Ok(_) => {
            log::warn!(
                "[document_parser] PDF 文本层为空，尝试 Windows OCR fallback: {}",
                file_path
            );
            parse_pdf_with_native_ocr_or_error(path, "PDF text layer is empty").await
        }
        Err(e) => {
            let reason = format!("Failed to parse PDF: {}", e);
            log::warn!(
                "[document_parser] {}，尝试 Windows OCR fallback: {}",
                reason,
                file_path
            );
            parse_pdf_with_native_ocr_or_error(path, &reason).await
        }
    }
}

/// 解析纯文本文件 (.txt)
///
/// 读取纯文本文件内容
///
/// # Arguments
/// * `file_path` - 文件路径
///
/// # Returns
/// 文件文本内容
#[tauri::command]
pub async fn parse_txt(file_path: String) -> AppResult<String> {
    let path = Path::new(&file_path);

    if !path.exists() {
        return Err(AppError::NotFound(format!(
            "File does not exist: {}",
            file_path
        )));
    }

    // 检查文件扩展名
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());

    if ext.as_deref() != Some("txt") {
        return Err(AppError::Generic(
            "Unsupported file format. This command only supports .txt files.".to_string(),
        ));
    }

    // 读取文件内容
    let content = std::fs::read_to_string(path)
        .map_err(|e| AppError::FileSystem(format!("Failed to read file: {}", e)))?;

    if content.trim().is_empty() {
        return Err(AppError::Generic("Text file is empty".to_string()));
    }

    log::trace!(
        "[document_parser] 成功读取文本文件: {} ({} 字符)",
        file_path,
        content.len()
    );

    Ok(content)
}

/// 解析 Markdown 文件 (.md)
///
/// 读取 Markdown 文件内容（原样返回，不做额外处理）
///
/// # Arguments
/// * `file_path` - 文件路径
///
/// # Returns
/// Markdown 文本内容
#[tauri::command]
pub async fn parse_md(file_path: String) -> AppResult<String> {
    let path = Path::new(&file_path);

    if !path.exists() {
        return Err(AppError::NotFound(format!(
            "File does not exist: {}",
            file_path
        )));
    }

    // 检查文件扩展名
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());

    if ext.as_deref() != Some("md") && ext.as_deref() != Some("markdown") {
        return Err(AppError::Generic(
            "Unsupported file format. This command only supports .md and .markdown files."
                .to_string(),
        ));
    }

    // 读取文件内容
    let content = std::fs::read_to_string(path)
        .map_err(|e| AppError::FileSystem(format!("Failed to read file: {}", e)))?;

    if content.trim().is_empty() {
        return Err(AppError::Generic("Markdown file is empty".to_string()));
    }

    log::trace!(
        "[document_parser] 成功读取 Markdown 文件: {} ({} 字符)",
        file_path,
        content.len()
    );

    Ok(content)
}

// ==================== 工具函数 ====================

/// 将 Excel Range 转换为 Markdown 表格
fn range_to_markdown(range: &calamine::Range<calamine::Data>) -> String {
    let mut output = String::new();
    let mut rows: Vec<Vec<String>> = Vec::new();

    // 收集所有行的数据
    for row in range.rows() {
        let cells: Vec<String> = row
            .iter()
            .map(|cell| match cell {
                calamine::Data::Int(i) => i.to_string(),
                calamine::Data::Float(f) => format!("{:.2}", f),
                calamine::Data::String(s) => s.clone(),
                calamine::Data::Bool(b) => b.to_string(),
                calamine::Data::DateTime(dt) => format!("{}", dt),
                calamine::Data::DateTimeIso(s) => s.clone(),
                calamine::Data::DurationIso(s) => s.clone(),
                calamine::Data::Error(e) => format!("ERROR: {:?}", e),
                calamine::Data::Empty => String::new(),
            })
            .collect();
        rows.push(cells);
    }

    if rows.is_empty() {
        return "(empty table)".to_string();
    }

    // 限制显示行数（避免过长）
    let max_rows = 100;
    let truncated = rows.len() > max_rows;
    let display_rows = if truncated {
        &rows[..max_rows]
    } else {
        &rows[..]
    };

    // 生成 Markdown 表格
    for (i, row) in display_rows.iter().enumerate() {
        output.push_str("| ");
        output.push_str(&row.join(" | "));
        output.push_str(" |\n");

        // 在第一行后添加分隔符
        if i == 0 {
            output.push_str("|");
            for _ in 0..row.len() {
                output.push_str(" --- |");
            }
            output.push('\n');
        }
    }

    if truncated {
        output.push_str(&format!(
            "\n*(Table is too long and was truncated. Showing the first {} of {} rows.)*\n",
            max_rows,
            rows.len()
        ));
    }

    output
}

fn has_pdf_text_content(text: &str) -> bool {
    text.chars().any(|ch| !ch.is_whitespace())
}

async fn parse_pdf_with_native_ocr_or_error(path: &Path, reason: &str) -> AppResult<String> {
    match extract_pdf_text_with_native_ocr(path).await {
        Ok(text) if has_pdf_text_content(&text) => {
            log::trace!(
                "[document_parser] Windows OCR fallback 成功解析 PDF: {} ({} 字符)",
                path.display(),
                text.len()
            );
            Ok(text)
        }
        Ok(_) => Err(AppError::Generic(format!(
            "Could not extract text from the PDF. Native OCR returned no text. Original reason: {}",
            reason
        ))),
        Err(ocr_error) => Err(AppError::Generic(format!(
            "Could not extract text from the PDF. It may be a scanned image-only PDF, but Windows OCR fallback failed: {}. Original reason: {}",
            ocr_error,
            reason
        ))),
    }
}

#[cfg(not(target_os = "windows"))]
async fn extract_pdf_text_with_native_ocr(_path: &Path) -> AppResult<String> {
    Err(AppError::Generic(
        "Native OCR fallback is only available on Windows".to_string(),
    ))
}

#[cfg(target_os = "windows")]
async fn extract_pdf_text_with_native_ocr(path: &Path) -> AppResult<String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let _winrt = WinrtApartmentGuard::initialize()?;
        extract_pdf_text_with_native_ocr_inner(&path)
    })
    .await
    .map_err(|e| AppError::Generic(format!("Windows OCR worker failed: {}", e)))?
}

#[cfg(target_os = "windows")]
struct WinrtApartmentGuard;

#[cfg(target_os = "windows")]
impl WinrtApartmentGuard {
    fn initialize() -> AppResult<Self> {
        use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
            .map_err(|e| AppError::Generic(format!("Failed to initialize WinRT: {}", e)))?;
        Ok(Self)
    }
}

#[cfg(target_os = "windows")]
impl Drop for WinrtApartmentGuard {
    fn drop(&mut self) {
        unsafe {
            windows::Win32::System::WinRT::RoUninitialize();
        }
    }
}

#[cfg(target_os = "windows")]
fn extract_pdf_text_with_native_ocr_inner(path: &PathBuf) -> AppResult<String> {
    use windows::core::HSTRING;
    use windows::Data::Pdf::PdfDocument;
    use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::StorageFile;
    use windows::Storage::Streams::InMemoryRandomAccessStream;

    let path_str = path
        .to_str()
        .ok_or_else(|| AppError::Generic("PDF path contains invalid Unicode".to_string()))?;
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path_str))
        .map_err(|e| AppError::Generic(format!("Failed to open PDF for OCR: {}", e)))?
        .get()
        .map_err(|e| AppError::Generic(format!("Failed to open PDF for OCR: {}", e)))?;

    let document = PdfDocument::LoadFromFileAsync(&file)
        .map_err(|e| AppError::Generic(format!("Failed to load PDF for OCR: {}", e)))?
        .get()
        .map_err(|e| AppError::Generic(format!("Failed to load PDF for OCR: {}", e)))?;

    let page_count = document
        .PageCount()
        .map_err(|e| AppError::Generic(format!("Failed to read PDF page count for OCR: {}", e)))?;
    if page_count == 0 {
        return Ok(String::new());
    }

    let engines = build_windows_ocr_engines()
        .map_err(|e| AppError::Generic(format!("Windows OCR engine is unavailable: {}", e)))?;
    let max_image_dimension = OcrEngine::MaxImageDimension()
        .unwrap_or(PDF_OCR_RENDER_MAX_DIMENSION)
        .max(512)
        .min(PDF_OCR_RENDER_MAX_DIMENSION);

    let pages_to_process = page_count.min(PDF_OCR_MAX_PAGES);
    let has_more_pages = page_count > pages_to_process;
    let mut output = format!(
        "[PDF_OCR_META] engine=windows-native pageCount={} processedPages={} hasMorePages={}\n",
        page_count, pages_to_process, has_more_pages
    );
    let mut recognized_pages = 0_u32;
    let mut last_page_error: Option<String> = None;

    for page_index in 0..pages_to_process {
        let page = document.GetPage(page_index).map_err(|e| {
            AppError::Generic(format!(
                "Failed to load PDF page {} for OCR: {}",
                page_index + 1,
                e
            ))
        })?;

        let stream = InMemoryRandomAccessStream::new()
            .map_err(|e| AppError::Generic(format!("Failed to create OCR render stream: {}", e)))?;
        let render_options = build_pdf_ocr_render_options(&page, max_image_dimension)?;

        let page_result: AppResult<String> = (|| {
            page.RenderWithOptionsToStreamAsync(&stream, &render_options)
                .map_err(|e| {
                    AppError::Generic(format!(
                        "Failed to render PDF page {} for OCR: {}",
                        page_index + 1,
                        e
                    ))
                })?
                .get()
                .map_err(|e| {
                    AppError::Generic(format!(
                        "Failed to render PDF page {} for OCR: {}",
                        page_index + 1,
                        e
                    ))
                })?;
            stream.Seek(0).map_err(|e| {
                AppError::Generic(format!("Failed to rewind OCR image stream: {}", e))
            })?;

            let decoder = BitmapDecoder::CreateAsync(&stream)
                .map_err(|e| {
                    AppError::Generic(format!(
                        "Failed to decode rendered PDF page {}: {}",
                        page_index + 1,
                        e
                    ))
                })?
                .get()
                .map_err(|e| {
                    AppError::Generic(format!(
                        "Failed to decode rendered PDF page {}: {}",
                        page_index + 1,
                        e
                    ))
                })?;
            let bitmap = decoder
                .GetSoftwareBitmapConvertedAsync(
                    BitmapPixelFormat::Bgra8,
                    BitmapAlphaMode::Premultiplied,
                )
                .map_err(|e| {
                    AppError::Generic(format!(
                        "Failed to convert rendered PDF page {} for OCR: {}",
                        page_index + 1,
                        e
                    ))
                })?
                .get()
                .map_err(|e| {
                    AppError::Generic(format!(
                        "Failed to convert rendered PDF page {} for OCR: {}",
                        page_index + 1,
                        e
                    ))
                })?;

            recognize_pdf_page_text(&engines, &bitmap, page_index + 1)
        })();

        if let Err(e) = page.Close() {
            log::warn!("[document_parser] 关闭 PDF OCR 页面失败: {}", e);
        }

        match page_result {
            Ok(page_text) if has_pdf_text_content(&page_text) => {
                recognized_pages += 1;
                output.push_str(&format!(
                    "\n[PDF_OCR_PAGE {}]\n{}\n",
                    page_index + 1,
                    page_text.trim()
                ));
            }
            Ok(_) => {
                log::trace!(
                    "[document_parser] Windows OCR 页面 {} 未识别到文字",
                    page_index + 1
                );
            }
            Err(e) => {
                let message = e.to_string();
                log::warn!(
                    "[document_parser] Windows OCR 页面 {} 失败: {}",
                    page_index + 1,
                    message
                );
                last_page_error = Some(message);
            }
        }
    }

    if recognized_pages == 0 {
        return Err(AppError::Generic(match last_page_error {
            Some(error) => format!(
                "Windows OCR found no readable text. Last page error: {}",
                error
            ),
            None => "Windows OCR found no readable text".to_string(),
        }));
    }

    Ok(output)
}

#[cfg(target_os = "windows")]
fn build_windows_ocr_engines(
) -> windows::core::Result<Vec<(String, windows::Media::Ocr::OcrEngine)>> {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Media::Ocr::OcrEngine;

    let mut engines = Vec::new();
    if let Ok(engine) = OcrEngine::TryCreateFromUserProfileLanguages() {
        let label = engine
            .RecognizerLanguage()
            .ok()
            .and_then(|language| language.LanguageTag().ok())
            .map(|tag| format!("user:{}", tag))
            .unwrap_or_else(|| "user".to_string());
        engines.push((label, engine));
    }

    for tag in ["en-US", "zh-Hans", "zh-Hant"] {
        let language = Language::CreateLanguage(&HSTRING::from(tag))?;
        if !OcrEngine::IsLanguageSupported(&language).unwrap_or(false) {
            continue;
        }
        if engines.iter().any(|(label, _)| label.ends_with(tag)) {
            continue;
        }
        if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&language) {
            engines.push((tag.to_string(), engine));
        }
    }

    if engines.is_empty() {
        OcrEngine::TryCreateFromUserProfileLanguages()
            .map(|engine| vec![("user".to_string(), engine)])
    } else {
        Ok(engines)
    }
}

#[cfg(target_os = "windows")]
fn recognize_pdf_page_text(
    engines: &[(String, windows::Media::Ocr::OcrEngine)],
    bitmap: &windows::Graphics::Imaging::SoftwareBitmap,
    page_number: u32,
) -> AppResult<String> {
    let mut last_error: Option<String> = None;

    for (label, engine) in engines {
        match engine
            .RecognizeAsync(bitmap)
            .and_then(|operation| operation.get())
            .and_then(|result| result.Text())
        {
            Ok(text) => {
                let text = text.to_string();
                if has_pdf_text_content(&text) {
                    log::trace!(
                        "[document_parser] Windows OCR 页面 {} 使用语言 {} 识别成功",
                        page_number,
                        label
                    );
                    return Ok(text);
                }
            }
            Err(e) => {
                last_error = Some(format!("{}: {}", label, e));
            }
        }
    }

    match last_error {
        Some(error) => Err(AppError::Generic(format!(
            "Windows OCR failed on page {}: {}",
            page_number, error
        ))),
        None => Ok(String::new()),
    }
}

#[cfg(target_os = "windows")]
fn build_pdf_ocr_render_options(
    page: &windows::Data::Pdf::PdfPage,
    max_image_dimension: u32,
) -> AppResult<windows::Data::Pdf::PdfPageRenderOptions> {
    let options = windows::Data::Pdf::PdfPageRenderOptions::new().map_err(|e| {
        AppError::Generic(format!("Failed to create PDF OCR render options: {}", e))
    })?;
    let page_size = page
        .Size()
        .map_err(|e| AppError::Generic(format!("Failed to read PDF page size for OCR: {}", e)))?;

    let width = page_size.Width.max(1.0);
    let height = page_size.Height.max(1.0);
    let long_side = width.max(height);
    if long_side.is_finite() && long_side > 0.0 {
        let scale = max_image_dimension as f32 / long_side;
        let destination_width = (width * scale).round().max(1.0) as u32;
        let destination_height = (height * scale).round().max(1.0) as u32;
        options
            .SetDestinationWidth(destination_width)
            .map_err(|e| AppError::Generic(format!("Failed to set PDF OCR render width: {}", e)))?;
        options
            .SetDestinationHeight(destination_height)
            .map_err(|e| {
                AppError::Generic(format!("Failed to set PDF OCR render height: {}", e))
            })?;
    }

    Ok(options)
}
