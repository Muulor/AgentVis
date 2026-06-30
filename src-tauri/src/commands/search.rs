//! 代码搜索相关 Tauri Commands
//!
//! 提供 grep（文本搜索）、find（文件查找）、outline（AST 大纲）、symbol（符号定位）四种搜索能力。
//! outline/symbol 模式使用 tree-sitter 进行真正的 AST 解析。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::fs;

use crate::error::{AppResult, AppError};

// ==================== 常量 ====================

/// find 结果数量上限（防止输出过大）
const MAX_RESULTS: usize = 50;

/// grep 默认结果数量上限。grep 结果包含 snippet 和诊断，需比 find 更注重上下文预算。
const DEFAULT_GREP_MAX_RESULTS: usize = 60;

/// grep 结果数量硬上限。调用方可以调高 maxResults，但不能超过此值。
const HARD_GREP_MAX_RESULTS: usize = 150;

/// grep 单文件默认最多返回的匹配数，避免单个日志/长文档吃满所有结果。
const DEFAULT_GREP_MAX_MATCHES_PER_FILE: usize = 20;

/// grep 单文件匹配数硬上限。
const HARD_GREP_MAX_MATCHES_PER_FILE: usize = 50;

/// grep 默认每条命中片段的字符预算（围绕首个命中点居中截取）。
const DEFAULT_GREP_CONTEXT_CHARS: usize = 220;

/// grep 每条命中片段字符预算硬上限。
const HARD_GREP_CONTEXT_CHARS: usize = 400;

/// grep 默认输出 token 预算，尽量落在 SA 工具输出 L1 压缩阈值内。
const DEFAULT_GREP_OUTPUT_TOKEN_BUDGET: usize = 6000;

/// grep 输出 token 预算硬上限。
const HARD_GREP_OUTPUT_TOKEN_BUDGET: usize = 10000;

/// grep 模式中，需要跳过的目录（不搜索这些目录）
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "__pycache__", ".next", "dist", "build",
    "target", ".svn", ".hg", "vite_preview",
];

/// grep 模式中，需要跳过的二进制/大文件扩展名
const SKIP_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg",
    "mp3", "mp4", "avi", "mov", "wav",
    "zip", "tar", "gz", "rar", "7z",
    "exe", "dll", "so", "dylib",
    "woff", "woff2", "ttf", "eot",
    "sqlite", "db",
];

/// grep 模式中，跳过普通文本大文件的阈值（10MB）
/// 防止 webpack bundle / minified 文件导致内存和正则匹配性能问题
const MAX_TEXT_FILE_SIZE: u64 = 10 * 1024 * 1024;

/// grep 模式中，允许解析搜索的文档大小上限（20MB）
/// Office/PDF 文档通常比源码文件大，使用独立阈值避免被文本文件防御误伤。
const MAX_DOCUMENT_FILE_SIZE: u64 = 20 * 1024 * 1024;

/// grep 模式中，会通过 document_parser 提取文本后再搜索的文档扩展名
const SEARCHABLE_DOCUMENT_EXTENSIONS: &[&str] = &[
    "docx", "xlsx", "xls", "pptx", "pdf",
];

/// 需要跳过的压缩/打包文件后缀模式
const SKIP_MIN_SUFFIXES: &[&str] = &[".min.js", ".min.css", ".bundle.js"];

// ==================== 返回类型 ====================

/// grep 模式的单条匹配结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepMatch {
    /// 文件路径
    pub file: String,
    /// 行号（1-based）
    pub line: u32,
    /// 命中点附近的片段
    pub content: String,
}

/// grep 诊断信息，帮助 SA 区分“确实无结果”和“搜索被限制/跳过”。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepDiagnostics {
    pub scanned_files: u32,
    pub matched_files: u32,
    pub skipped_dirs: Vec<String>,
    pub skipped_binary_files: u32,
    pub skipped_large_files: u32,
    pub skipped_minified_files: u32,
    pub skipped_glob_files: u32,
    pub unreadable_files: u32,
    pub parse_failed_files: u32,
    pub probable_binary_files: u32,
    pub result_limit_reached: bool,
    pub output_limit_reached: bool,
    pub per_file_limit_reached: bool,
    pub max_results: usize,
    pub max_matches_per_file: usize,
    pub context_chars: usize,
    pub max_output_tokens: usize,
    pub case_insensitive: bool,
}

/// grep 返回体：匹配项 + 诊断。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepSearchResult {
    pub matches: Vec<GrepMatch>,
    pub diagnostics: GrepDiagnostics,
}

/// find 模式的单条结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindResult {
    /// 文件/目录路径
    pub path: String,
    /// 类型: "file" | "directory"
    pub file_type: String,
    /// 文件大小（目录为 0）
    pub size: u64,
}

/// outline 模式的单条结果（AST 符号）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineItem {
    /// 符号名称（如 "ClassName.methodName"）
    pub name: String,
    /// 符号类型: "class" | "function" | "interface" | "type" | "method" | "struct" | "enum" | "trait" | "impl"
    pub kind: String,
    /// 签名摘要
    pub signature: String,
    /// 起始行号（1-based）
    pub start_line: u32,
    /// 结束行号（1-based）
    pub end_line: u32,
    /// 子符号（类的方法、impl 的函数等）
    pub children: Vec<OutlineItem>,
}

// ==================== Tauri 命令: code_grep ====================

/// 在目录中搜索文本/正则表达式
///
/// 递归遍历目录，跳过二进制文件和 node_modules 等目录，
/// 返回匹配行及其行号，结果上限 50 条。
///
/// # Arguments
/// * `query` - 搜索文本或正则表达式
/// * `search_path` - 搜索根目录
/// * `is_regex` - 是否使用正则匹配
/// * `includes` - 文件过滤 glob 列表（如 ["*.ts", "*.tsx"]）
#[tauri::command]
pub async fn code_grep(
    query: String,
    search_path: String,
    is_regex: Option<bool>,
    includes: Option<Vec<String>>,
    max_results: Option<usize>,
    context_chars: Option<usize>,
    max_matches_per_file: Option<usize>,
    case_insensitive: Option<bool>,
    max_output_tokens: Option<usize>,
) -> AppResult<GrepSearchResult> {
    let root = PathBuf::from(&search_path);
    if !root.exists() {
        return Err(AppError::NotFound(format!("Search path does not exist: {}", search_path)));
    }

    let use_regex = is_regex.unwrap_or(false);
    let smart_case_insensitive = should_use_case_insensitive(&query, case_insensitive);
    let max_results = clamp_limit(max_results, DEFAULT_GREP_MAX_RESULTS, HARD_GREP_MAX_RESULTS);
    let context_chars = clamp_limit(context_chars, DEFAULT_GREP_CONTEXT_CHARS, HARD_GREP_CONTEXT_CHARS);
    let max_matches_per_file = clamp_limit(
        max_matches_per_file,
        DEFAULT_GREP_MAX_MATCHES_PER_FILE,
        HARD_GREP_MAX_MATCHES_PER_FILE,
    );
    let max_output_tokens = clamp_limit(
        max_output_tokens,
        DEFAULT_GREP_OUTPUT_TOKEN_BUDGET,
        HARD_GREP_OUTPUT_TOKEN_BUDGET,
    );

    // 构建正则或字面量匹配器
    let pattern = if use_regex {
        regex::RegexBuilder::new(&query)
            .case_insensitive(smart_case_insensitive)
            .build()
            .map_err(|e| AppError::Generic(format!("Invalid regular expression: {}", e)))?
    } else {
        // 对字面量文本做转义后构建正则
        regex::RegexBuilder::new(&regex::escape(&query))
            .case_insensitive(smart_case_insensitive)
            .build()
            .map_err(|e| AppError::Generic(format!("Failed to build search pattern: {}", e)))?
    };

    // 构建 glob 过滤集合
    let glob_patterns = build_glob_patterns(&includes);

    let mut results: Vec<GrepMatch> = Vec::new();
    let mut diagnostics = GrepDiagnostics {
        max_results,
        max_matches_per_file,
        context_chars,
        max_output_tokens,
        case_insensitive: smart_case_insensitive,
        ..Default::default()
    };
    let mut matched_files: HashSet<String> = HashSet::new();
    let mut matches_per_file: HashMap<String, usize> = HashMap::new();
    let mut emitted_tokens = 0usize;

    // 使用 walkdir 递归遍历
    let mut walker = walkdir::WalkDir::new(&root).follow_links(false).into_iter();
    'walk: while let Some(entry) = walker.next() {
        if results.len() >= max_results {
            diagnostics.result_limit_reached = true;
            break;
        }

        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                diagnostics.unreadable_files += 1;
                continue;
            }
        };

        if entry.depth() > 0 && entry.file_type().is_dir() && should_skip_dir(&entry) {
            record_skipped_dir(&mut diagnostics, entry.path());
            walker.skip_current_dir();
            continue;
        }

        // 只处理文件
        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();

        // 跳过二进制文件
        if should_skip_file(path) {
            diagnostics.skipped_binary_files += 1;
            continue;
        }

        // glob 过滤
        if !glob_patterns.is_empty() && !matches_any_glob(path, &root, &glob_patterns) {
            diagnostics.skipped_glob_files += 1;
            continue;
        }

        // 大文件防御：普通文本和可解析文档使用不同阈值。
        // 避免 webpack bundle / minified 文件导致内存和正则匹配极度卡顿，
        // 同时允许常见 Office/PDF 文档进入解析搜索流程。
        if let Ok(metadata) = fs::metadata(path) {
            let max_size = if is_searchable_document(path) {
                MAX_DOCUMENT_FILE_SIZE
            } else {
                MAX_TEXT_FILE_SIZE
            };
            if metadata.len() > max_size {
                diagnostics.skipped_large_files += 1;
                continue;
            }
        }

        // 跳过压缩/打包文件（如 .min.js、.bundle.js）
        if let Some(file_name) = path.file_name().and_then(|f| f.to_str()) {
            let file_name_lower = file_name.to_lowercase();
            if SKIP_MIN_SUFFIXES.iter().any(|suffix| file_name_lower.ends_with(suffix)) {
                diagnostics.skipped_minified_files += 1;
                continue;
            }
        }

        // 读取文件内容并搜索。Office/PDF 文档会先提取文本；普通文本支持 UTF-8/UTF-16/GBK 回退。
        let content = match read_searchable_content(path).await {
            Ok(content) => content,
            Err(SearchContentSkip::Unreadable) => {
                diagnostics.unreadable_files += 1;
                continue;
            }
            Err(SearchContentSkip::ParseFailed) => {
                diagnostics.parse_failed_files += 1;
                continue;
            }
            Err(SearchContentSkip::ProbableBinary) => {
                diagnostics.probable_binary_files += 1;
                continue;
            }
        };
        diagnostics.scanned_files += 1;

        let file_key = path.to_string_lossy().to_string();
        for (line_idx, line) in content.lines().enumerate() {
            if results.len() >= max_results {
                diagnostics.result_limit_reached = true;
                break 'walk;
            }

            let current_file_matches = matches_per_file.get(&file_key).copied().unwrap_or(0);
            if current_file_matches >= max_matches_per_file {
                diagnostics.per_file_limit_reached = true;
                break;
            }

            if let Some(first_match) = pattern.find(line) {
                let snippet = build_match_snippet(line, first_match.start(), first_match.end(), context_chars);
                let estimated_tokens = estimate_tokens(&snippet) + estimate_tokens(&file_key) + 16;
                if !results.is_empty() && emitted_tokens + estimated_tokens > max_output_tokens {
                    diagnostics.output_limit_reached = true;
                    break 'walk;
                }

                emitted_tokens += estimated_tokens;
                matched_files.insert(file_key.clone());
                matches_per_file.insert(file_key.clone(), current_file_matches + 1);
                results.push(GrepMatch {
                    file: file_key.clone(),
                    line: (line_idx + 1) as u32,
                    content: snippet,
                });
            }
        }
    }

    diagnostics.matched_files = matched_files.len() as u32;

    Ok(GrepSearchResult {
        matches: results,
        diagnostics,
    })
}

// ==================== Tauri 命令: code_find ====================

/// 按文件名/glob 模式查找文件
///
/// 递归遍历目录，返回匹配的文件或目录列表，结果上限 50 条。
///
/// # Arguments
/// * `pattern` - 文件名 glob 模式（如 "*.module.css"）
/// * `search_path` - 搜索根目录
/// * `max_depth` - 最大搜索深度
/// * `file_type` - 类型过滤: "file" / "directory" / "any"
/// * `includes` - 额外的 glob 过滤（可选）
#[tauri::command]
pub async fn code_find(
    pattern: String,
    search_path: String,
    max_depth: Option<usize>,
    file_type: Option<String>,
    includes: Option<Vec<String>>,
) -> AppResult<Vec<FindResult>> {
    let root = PathBuf::from(&search_path);
    if !root.exists() {
        return Err(AppError::NotFound(format!("Search path does not exist: {}", search_path)));
    }

    // 构建 glob 匹配器
    let glob_pattern = glob::Pattern::new(&pattern)
        .map_err(|e| AppError::Generic(format!("Invalid glob pattern: {}", e)))?;

    let type_filter = file_type.unwrap_or_else(|| "any".to_string());
    let extra_globs = build_glob_patterns(&includes);

    let mut walker = walkdir::WalkDir::new(&root).follow_links(false);
    if let Some(depth) = max_depth {
        walker = walker.max_depth(depth);
    }

    let mut results: Vec<FindResult> = Vec::new();

    for entry in walker.into_iter().filter_entry(|e| !should_skip_dir(e)) {
        if results.len() >= MAX_RESULTS {
            break;
        }

        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        // 跳过根目录本身
        if entry.depth() == 0 {
            continue;
        }

        let is_dir = entry.file_type().is_dir();
        let is_file = entry.file_type().is_file();

        // 类型过滤
        match type_filter.as_str() {
            "file" if !is_file => continue,
            "directory" if !is_dir => continue,
            _ => {}
        }

        let file_name = entry.file_name().to_string_lossy();

        // glob 匹配文件名
        if !glob_pattern.matches(&file_name) {
            continue;
        }

        // 额外 glob 过滤
        if !extra_globs.is_empty() && !matches_any_glob(entry.path(), &root, &extra_globs) {
            continue;
        }

        let size = if is_file {
            entry.metadata().map(|m| m.len()).unwrap_or(0)
        } else {
            0
        };

        results.push(FindResult {
            path: entry.path().to_string_lossy().to_string(),
            file_type: if is_dir { "directory".to_string() } else { "file".to_string() },
            size,
        });
    }

    Ok(results)
}

// ==================== Tauri 命令: code_outline ====================

/// 使用 tree-sitter 解析文件的 AST 大纲
///
/// 返回文件中的顶层符号（类、函数、接口等）及其子符号。
/// 根据文件扩展名自动选择对应的语言语法。
///
/// # Arguments
/// * `path` - 文件路径
#[tauri::command]
pub async fn code_outline(
    path: String,
) -> AppResult<Vec<OutlineItem>> {
    let file_path = PathBuf::from(&path);
    if !file_path.exists() {
        return Err(AppError::NotFound(format!("File does not exist: {}", path)));
    }

    let source = fs::read_to_string(&file_path)
        .map_err(|e| AppError::FileSystem(format!("Failed to read file: {}", e)))?;

    let ext = file_path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    let items = parse_outline(&source, &ext)?;
    Ok(items)
}

// ==================== Tauri 命令: code_symbol ====================

/// 使用 tree-sitter 定位并返回指定符号的完整源码
///
/// 先解析文件大纲，然后按名称查找目标符号，返回其源码内容。
/// 支持点号分隔的完全限定名（如 "ClassName.methodName"）。
///
/// # Arguments
/// * `path` - 文件路径
/// * `symbol_name` - 符号名称（如 "MyClass.handleClick"）
#[tauri::command]
pub async fn code_symbol(
    path: String,
    symbol_name: String,
) -> AppResult<String> {
    let file_path = PathBuf::from(&path);
    if !file_path.exists() {
        return Err(AppError::NotFound(format!("File does not exist: {}", path)));
    }

    let source = fs::read_to_string(&file_path)
        .map_err(|e| AppError::FileSystem(format!("Failed to read file: {}", e)))?;

    let ext = file_path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    let items = parse_outline(&source, &ext)?;

    // 按名称查找符号（DFS 遍历，OutlineItem.name 已存储完整限定名如 "Class.method"）
    let found = find_symbol_in_items(&items, &symbol_name);

    match found {
        Some(item) => {
            // 提取符号对应的源码行
            let lines: Vec<&str> = source.lines().collect();
            let start = (item.start_line as usize).saturating_sub(1);
            let end = (item.end_line as usize).min(lines.len());
            let symbol_source: String = lines[start..end]
                .iter()
                .enumerate()
                .map(|(i, line)| format!("{}: {}", start + i + 1, line))
                .collect::<Vec<_>>()
                .join("\n");

            Ok(format!(
                "📌 {} (L{}-L{})\n\n{}",
                symbol_name, item.start_line, item.end_line, symbol_source
            ))
        }
        None => Err(AppError::NotFound(format!(
            "Symbol \"{}\" was not found (available symbols: {})",
            symbol_name,
            items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>().join(", ")
        ))),
    }
}

// ==================== tree-sitter AST 解析 ====================

/// 根据文件扩展名解析源码大纲
fn parse_outline(source: &str, ext: &str) -> AppResult<Vec<OutlineItem>> {
    let mut parser = tree_sitter::Parser::new();

    // 根据扩展名选择语言语法
    let language = match ext {
        "ts" | "tsx" => {
            if ext == "tsx" {
                tree_sitter_typescript::LANGUAGE_TSX.into()
            } else {
                tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
            }
        }
        "js" | "jsx" | "mjs" | "cjs" => {
            tree_sitter_javascript::LANGUAGE.into()
        }
        "py" => {
            tree_sitter_python::LANGUAGE.into()
        }
        "rs" => {
            tree_sitter_rust::LANGUAGE.into()
        }
        "css" | "scss" => {
            tree_sitter_css::LANGUAGE.into()
        }
        "json" => {
            tree_sitter_json::LANGUAGE.into()
        }
        _ => {
            // 不支持的语言：回退到简易行数统计
            return Ok(vec![]);
        }
    };

    parser.set_language(&language)
        .map_err(|e| AppError::Generic(format!("Failed to set tree-sitter language: {}", e)))?;

    let tree = parser.parse(source, None)
        .ok_or_else(|| AppError::Generic("tree-sitter parsing failed".to_string()))?;

    let source_bytes = source.as_bytes();
    let root = tree.root_node();

    // 根据语言类型提取符号
    let items = match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
            extract_ts_js_symbols(root, source_bytes)
        }
        "py" => {
            extract_python_symbols(root, source_bytes)
        }
        "rs" => {
            extract_rust_symbols(root, source_bytes)
        }
        "css" | "scss" => {
            extract_css_symbols(root, source_bytes)
        }
        _ => vec![],
    };

    Ok(items)
}

/// 提取 TypeScript/JavaScript 的符号
fn extract_ts_js_symbols(node: tree_sitter::Node, source: &[u8]) -> Vec<OutlineItem> {
    let mut items = Vec::new();

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            // 函数声明
            "function_declaration" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    let name = node_text(name_node, source);
                    let sig = extract_signature(child, source);
                    items.push(OutlineItem {
                        name,
                        kind: "function".to_string(),
                        signature: sig,
                        start_line: child.start_position().row as u32 + 1,
                        end_line: child.end_position().row as u32 + 1,
                        children: vec![],
                    });
                }
            }
            // 类声明
            "class_declaration" => {
                let name = child.child_by_field_name("name")
                    .map(|n| node_text(n, source))
                    .unwrap_or_else(|| "<anonymous>".to_string());
                let sig = extract_signature(child, source);
                let methods = extract_class_members(child, source, &name);
                items.push(OutlineItem {
                    name,
                    kind: "class".to_string(),
                    signature: sig,
                    start_line: child.start_position().row as u32 + 1,
                    end_line: child.end_position().row as u32 + 1,
                    children: methods,
                });
            }
            // 接口声明（TypeScript）
            "interface_declaration" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    let name = node_text(name_node, source);
                    let sig = extract_signature(child, source);
                    items.push(OutlineItem {
                        name,
                        kind: "interface".to_string(),
                        signature: sig,
                        start_line: child.start_position().row as u32 + 1,
                        end_line: child.end_position().row as u32 + 1,
                        children: vec![],
                    });
                }
            }
            // 类型别名（TypeScript）
            "type_alias_declaration" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    let name = node_text(name_node, source);
                    let sig = extract_signature(child, source);
                    items.push(OutlineItem {
                        name,
                        kind: "type".to_string(),
                        signature: sig,
                        start_line: child.start_position().row as u32 + 1,
                        end_line: child.end_position().row as u32 + 1,
                        children: vec![],
                    });
                }
            }
            // enum 声明（TypeScript）
            "enum_declaration" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    let name = node_text(name_node, source);
                    let sig = extract_signature(child, source);
                    items.push(OutlineItem {
                        name,
                        kind: "enum".to_string(),
                        signature: sig,
                        start_line: child.start_position().row as u32 + 1,
                        end_line: child.end_position().row as u32 + 1,
                        children: vec![],
                    });
                }
            }
            // export 语句：递归提取其中的声明
            "export_statement" => {
                let inner_items = extract_ts_js_symbols(child, source);
                items.extend(inner_items);
            }
            // 词法声明中的箭头函数/常量 (const foo = () => {})
            "lexical_declaration" => {
                let mut dec_cursor = child.walk();
                for declarator in child.children(&mut dec_cursor) {
                    if declarator.kind() == "variable_declarator" {
                        if let Some(name_node) = declarator.child_by_field_name("name") {
                            if let Some(value_node) = declarator.child_by_field_name("value") {
                                let kind_str = match value_node.kind() {
                                    "arrow_function" | "function" | "function_expression" => "function",
                                    _ => continue, // 跳过非函数常量
                                };
                                let name = node_text(name_node, source);
                                let sig = extract_signature(child, source);
                                items.push(OutlineItem {
                                    name,
                                    kind: kind_str.to_string(),
                                    signature: sig,
                                    start_line: child.start_position().row as u32 + 1,
                                    end_line: child.end_position().row as u32 + 1,
                                    children: vec![],
                                });
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    items
}

/// 提取类的成员方法
fn extract_class_members(class_node: tree_sitter::Node, source: &[u8], class_name: &str) -> Vec<OutlineItem> {
    let mut methods = Vec::new();

    // 查找 class_body 节点
    let mut cursor = class_node.walk();
    for child in class_node.children(&mut cursor) {
        if child.kind() == "class_body" {
            let mut body_cursor = child.walk();
            for member in child.children(&mut body_cursor) {
                match member.kind() {
                    "method_definition" | "public_field_definition" => {
                        if let Some(name_node) = member.child_by_field_name("name") {
                            let method_name = node_text(name_node, source);
                            let sig = extract_signature(member, source);
                            methods.push(OutlineItem {
                                name: format!("{}.{}", class_name, method_name),
                                kind: "method".to_string(),
                                signature: sig,
                                start_line: member.start_position().row as u32 + 1,
                                end_line: member.end_position().row as u32 + 1,
                                children: vec![],
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    methods
}

/// 提取 Python 的符号
fn extract_python_symbols(node: tree_sitter::Node, source: &[u8]) -> Vec<OutlineItem> {
    let mut items = Vec::new();

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "function_definition" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    let name = node_text(name_node, source);
                    let sig = extract_signature(child, source);
                    items.push(OutlineItem {
                        name,
                        kind: "function".to_string(),
                        signature: sig,
                        start_line: child.start_position().row as u32 + 1,
                        end_line: child.end_position().row as u32 + 1,
                        children: vec![],
                    });
                }
            }
            "class_definition" => {
                let class_name = child.child_by_field_name("name")
                    .map(|n| node_text(n, source))
                    .unwrap_or_else(|| "<anonymous>".to_string());
                let sig = extract_signature(child, source);

                // 提取类方法
                let mut methods = Vec::new();
                if let Some(body) = child.child_by_field_name("body") {
                    let mut body_cursor = body.walk();
                    for member in body.children(&mut body_cursor) {
                        if member.kind() == "function_definition" {
                            if let Some(name_node) = member.child_by_field_name("name") {
                                let method_name = node_text(name_node, source);
                                let method_sig = extract_signature(member, source);
                                methods.push(OutlineItem {
                                    name: format!("{}.{}", class_name, method_name),
                                    kind: "method".to_string(),
                                    signature: method_sig,
                                    start_line: member.start_position().row as u32 + 1,
                                    end_line: member.end_position().row as u32 + 1,
                                    children: vec![],
                                });
                            }
                        }
                    }
                }

                items.push(OutlineItem {
                    name: class_name,
                    kind: "class".to_string(),
                    signature: sig,
                    start_line: child.start_position().row as u32 + 1,
                    end_line: child.end_position().row as u32 + 1,
                    children: methods,
                });
            }
            // 装饰后的函数/类也需要递归处理
            "decorated_definition" => {
                let inner = extract_python_symbols(child, source);
                items.extend(inner);
            }
            _ => {}
        }
    }

    items
}

/// 提取 Rust 的符号
fn extract_rust_symbols(node: tree_sitter::Node, source: &[u8]) -> Vec<OutlineItem> {
    let mut items = Vec::new();

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "function_item" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    let name = node_text(name_node, source);
                    let sig = extract_signature(child, source);
                    items.push(OutlineItem {
                        name,
                        kind: "function".to_string(),
                        signature: sig,
                        start_line: child.start_position().row as u32 + 1,
                        end_line: child.end_position().row as u32 + 1,
                        children: vec![],
                    });
                }
            }
            "struct_item" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    let name = node_text(name_node, source);
                    let sig = extract_signature(child, source);
                    items.push(OutlineItem {
                        name,
                        kind: "struct".to_string(),
                        signature: sig,
                        start_line: child.start_position().row as u32 + 1,
                        end_line: child.end_position().row as u32 + 1,
                        children: vec![],
                    });
                }
            }
            "enum_item" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    let name = node_text(name_node, source);
                    let sig = extract_signature(child, source);
                    items.push(OutlineItem {
                        name,
                        kind: "enum".to_string(),
                        signature: sig,
                        start_line: child.start_position().row as u32 + 1,
                        end_line: child.end_position().row as u32 + 1,
                        children: vec![],
                    });
                }
            }
            "trait_item" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    let name = node_text(name_node, source);
                    let sig = extract_signature(child, source);
                    items.push(OutlineItem {
                        name,
                        kind: "trait".to_string(),
                        signature: sig,
                        start_line: child.start_position().row as u32 + 1,
                        end_line: child.end_position().row as u32 + 1,
                        children: vec![],
                    });
                }
            }
            "impl_item" => {
                // impl 块：提取类型名和方法
                let impl_name = extract_impl_name(child, source);
                let sig = extract_signature(child, source);
                let methods = extract_impl_methods(child, source, &impl_name);
                items.push(OutlineItem {
                    name: impl_name,
                    kind: "impl".to_string(),
                    signature: sig,
                    start_line: child.start_position().row as u32 + 1,
                    end_line: child.end_position().row as u32 + 1,
                    children: methods,
                });
            }
            _ => {}
        }
    }

    items
}

/// 提取 CSS 的符号（选择器规则）
fn extract_css_symbols(node: tree_sitter::Node, source: &[u8]) -> Vec<OutlineItem> {
    let mut items = Vec::new();

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "rule_set" {
            // 提取选择器文本
            let mut sel_cursor = child.walk();
            for sel_child in child.children(&mut sel_cursor) {
                if sel_child.kind() == "selectors" {
                    let name = node_text(sel_child, source).trim().to_string();
                    items.push(OutlineItem {
                        name,
                        kind: "rule".to_string(),
                        signature: String::new(),
                        start_line: child.start_position().row as u32 + 1,
                        end_line: child.end_position().row as u32 + 1,
                        children: vec![],
                    });
                    break;
                }
            }
        }
    }

    items
}

// ==================== 辅助函数 ====================

/// 获取节点的文本内容
fn node_text(node: tree_sitter::Node, source: &[u8]) -> String {
    node.utf8_text(source).unwrap_or("").to_string()
}

/// 提取节点的签名（第一行文本，截断到合理长度）
fn extract_signature(node: tree_sitter::Node, source: &[u8]) -> String {
    let text = node.utf8_text(source).unwrap_or("");
    // 取第一行作为签名
    let first_line = text.lines().next().unwrap_or("");
    truncate_line(first_line, 120)
}

/// 提取 Rust impl 块的类型名
fn extract_impl_name(impl_node: tree_sitter::Node, source: &[u8]) -> String {
    // impl 块结构: impl [Trait for] Type { ... }
    // 尝试提取 type 字段
    if let Some(type_node) = impl_node.child_by_field_name("type") {
        let type_name = node_text(type_node, source);
        // 检查是否有 trait
        if let Some(trait_node) = impl_node.child_by_field_name("trait") {
            let trait_name = node_text(trait_node, source);
            return format!("impl {} for {}", trait_name, type_name);
        }
        return format!("impl {}", type_name);
    }
    "impl <unknown>".to_string()
}

/// 提取 Rust impl 块中的方法
fn extract_impl_methods(impl_node: tree_sitter::Node, source: &[u8], impl_name: &str) -> Vec<OutlineItem> {
    let mut methods = Vec::new();

    // 查找 declaration_list（impl 体）
    let mut cursor = impl_node.walk();
    for child in impl_node.children(&mut cursor) {
        if child.kind() == "declaration_list" {
            let mut body_cursor = child.walk();
            for member in child.children(&mut body_cursor) {
                if member.kind() == "function_item" {
                    if let Some(name_node) = member.child_by_field_name("name") {
                        let method_name = node_text(name_node, source);
                        let sig = extract_signature(member, source);
                        // 从 impl_name 中提取简短类型名（去掉 "impl " 前缀）
                        let short_name = impl_name.strip_prefix("impl ").unwrap_or(impl_name);
                        methods.push(OutlineItem {
                            name: format!("{}.{}", short_name, method_name),
                            kind: "method".to_string(),
                            signature: sig,
                            start_line: member.start_position().row as u32 + 1,
                            end_line: member.end_position().row as u32 + 1,
                            children: vec![],
                        });
                    }
                }
            }
        }
    }

    methods
}

/// 在 OutlineItem 列表中递归查找符号（DFS）
///
/// OutlineItem.name 已存储完整限定名（如 "ClassName.methodName"），
/// 因此只需简单的深度优先搜索进行字符串匹配即可。
fn find_symbol_in_items<'a>(
    items: &'a [OutlineItem],
    target_name: &str,
) -> Option<&'a OutlineItem> {
    for item in items {
        if item.name == target_name {
            return Some(item);
        }
        // 递归查找子节点（类方法、impl 方法等）
        if let Some(found) = find_symbol_in_items(&item.children, target_name) {
            return Some(found);
        }
    }
    None
}

/// 截断行文本到指定字符数
///
/// 基于字符（chars）而非字节（bytes）切片，
/// 避免在中文/Emoji 等多字节字符处切断导致 Panic。
fn truncate_line(line: &str, max_len: usize) -> String {
    let char_count = line.chars().count();
    if char_count <= max_len {
        line.to_string()
    } else {
        let truncated: String = line.chars().take(max_len).collect();
        format!("{}...", truncated)
    }
}

/// 判断是否应该跳过某个目录
fn should_skip_dir(entry: &walkdir::DirEntry) -> bool {
    if entry.file_type().is_dir() {
        let name = entry.file_name().to_string_lossy();
        // 跳过隐藏目录和已知无需搜索的目录
        if name.starts_with('.') && name != "." {
            return true;
        }
        return SKIP_DIRS.iter().any(|skip| *skip == name.as_ref());
    }
    false
}

fn record_skipped_dir(diagnostics: &mut GrepDiagnostics, path: &Path) {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    if !diagnostics.skipped_dirs.iter().any(|existing| existing == &name) {
        diagnostics.skipped_dirs.push(name);
    }
}

/// 判断是否应该跳过某个文件（二进制/大文件）
fn should_skip_file(path: &Path) -> bool {
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let ext_lower = ext.to_lowercase();
        return SKIP_EXTENSIONS.iter().any(|skip| *skip == ext_lower.as_str());
    }
    false
}

fn extension_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
}

fn is_searchable_document(path: &Path) -> bool {
    extension_lower(path)
        .map(|ext| {
            SEARCHABLE_DOCUMENT_EXTENSIONS
                .iter()
                .any(|candidate| *candidate == ext.as_str())
        })
        .unwrap_or(false)
}

enum SearchContentSkip {
    Unreadable,
    ParseFailed,
    ProbableBinary,
}

async fn read_searchable_content(path: &Path) -> Result<String, SearchContentSkip> {
    if let Some(ext) = extension_lower(path) {
        let is_document = SEARCHABLE_DOCUMENT_EXTENSIONS
            .iter()
            .any(|candidate| *candidate == ext.as_str());
        if is_document {
            return read_document_content(path, &ext).await;
        }
    }

    read_text_content(path)
}

async fn read_document_content(path: &Path, ext: &str) -> Result<String, SearchContentSkip> {
    let file_path = path.to_string_lossy().to_string();
    let parsed = match ext {
        "docx" => super::document_parser::parse_docx(file_path.clone()).await,
        "xlsx" | "xls" => super::document_parser::parse_xlsx(file_path.clone()).await,
        "pptx" => super::document_parser::parse_pptx(file_path.clone()).await,
        "pdf" => super::document_parser::parse_pdf(file_path.clone()).await,
        _ => return Err(SearchContentSkip::ParseFailed),
    };

    match parsed {
        Ok(content) => Ok(content),
        Err(error) => {
            log::debug!(
                "[search] 文档解析失败，已跳过: {} - {}",
                path.display(),
                error
            );
            Err(SearchContentSkip::ParseFailed)
        }
    }
}

fn read_text_content(path: &Path) -> Result<String, SearchContentSkip> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            log::debug!(
                "[search] 文本文件读取失败，已跳过: {} - {}",
                path.display(),
                error
            );
            return Err(SearchContentSkip::Unreadable);
        }
    };

    decode_text_bytes(&bytes)
}

fn decode_text_bytes(bytes: &[u8]) -> Result<String, SearchContentSkip> {
    if bytes.is_empty() {
        return Ok(String::new());
    }

    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return std::str::from_utf8(&bytes[3..])
            .map(ToString::to_string)
            .map_err(|_| SearchContentSkip::Unreadable);
    }

    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (decoded, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return Ok(decoded.into_owned());
    }

    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (decoded, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return Ok(decoded.into_owned());
    }

    if looks_like_binary(bytes) {
        return Err(SearchContentSkip::ProbableBinary);
    }

    if let Ok(content) = std::str::from_utf8(bytes) {
        return Ok(content.to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let (decoded, _, had_errors) = encoding_rs::GBK.decode(bytes);
        if !had_errors {
            return Ok(decoded.into_owned());
        }
    }

    Ok(String::from_utf8_lossy(bytes).to_string())
}

fn looks_like_binary(bytes: &[u8]) -> bool {
    let sample_len = bytes.len().min(4096);
    if sample_len == 0 {
        return false;
    }

    let nul_count = bytes[..sample_len].iter().filter(|byte| **byte == 0).count();
    nul_count * 100 / sample_len > 5
}

fn clamp_limit(value: Option<usize>, default_value: usize, hard_limit: usize) -> usize {
    value
        .filter(|value| *value > 0)
        .unwrap_or(default_value)
        .min(hard_limit)
}

fn should_use_case_insensitive(query: &str, explicit: Option<bool>) -> bool {
    if let Some(case_insensitive) = explicit {
        return case_insensitive;
    }

    query
        .chars()
        .filter(|ch| ch.is_alphabetic())
        .all(|ch| !ch.is_uppercase())
}

fn build_match_snippet(
    line: &str,
    match_start_byte: usize,
    match_end_byte: usize,
    context_chars: usize,
) -> String {
    let chars: Vec<char> = line.chars().collect();
    if chars.is_empty() {
        return String::new();
    }

    let start_char = line[..match_start_byte].chars().count();
    let end_char = line[..match_end_byte].chars().count();
    let match_len = end_char.saturating_sub(start_char);

    if chars.len() <= context_chars {
        return highlight_char_range(&chars, start_char, end_char);
    }

    if match_len == 0 {
        return centered_plain_snippet(&chars, start_char, context_chars);
    }

    if match_len >= context_chars {
        let end = (start_char + context_chars).min(chars.len());
        let mut snippet = String::new();
        if start_char > 0 {
            snippet.push_str("...");
        }
        snippet.push_str("[[");
        snippet.extend(chars[start_char..end].iter());
        snippet.push_str("]]");
        if end < chars.len() {
            snippet.push_str("...");
        }
        return snippet;
    }

    let context_budget = context_chars.saturating_sub(match_len);
    let mut before = context_budget / 2;
    let mut after = context_budget - before;
    before = before.min(start_char);
    after = after.min(chars.len().saturating_sub(end_char));

    let unused_after = context_budget.saturating_sub(before + after);
    if unused_after > 0 {
        let extra_before = start_char.saturating_sub(before).min(unused_after);
        before += extra_before;
        let remaining = unused_after.saturating_sub(extra_before);
        after += chars.len().saturating_sub(end_char + after).min(remaining);
    }

    let snippet_start = start_char.saturating_sub(before);
    let snippet_end = (end_char + after).min(chars.len());
    let mut snippet = String::new();
    if snippet_start > 0 {
        snippet.push_str("...");
    }
    snippet.extend(chars[snippet_start..start_char].iter());
    snippet.push_str("[[");
    snippet.extend(chars[start_char..end_char].iter());
    snippet.push_str("]]");
    snippet.extend(chars[end_char..snippet_end].iter());
    if snippet_end < chars.len() {
        snippet.push_str("...");
    }
    snippet
}

fn centered_plain_snippet(chars: &[char], anchor: usize, context_chars: usize) -> String {
    let half = context_chars / 2;
    let start = anchor.saturating_sub(half);
    let end = (start + context_chars).min(chars.len());
    let start = end.saturating_sub(context_chars);
    let mut snippet = String::new();
    if start > 0 {
        snippet.push_str("...");
    }
    snippet.extend(chars[start..end].iter());
    if end < chars.len() {
        snippet.push_str("...");
    }
    snippet
}

fn highlight_char_range(chars: &[char], start: usize, end: usize) -> String {
    if start >= end || start >= chars.len() {
        return chars.iter().collect();
    }

    let end = end.min(chars.len());
    let mut output = String::new();
    output.extend(chars[..start].iter());
    output.push_str("[[");
    output.extend(chars[start..end].iter());
    output.push_str("]]");
    output.extend(chars[end..].iter());
    output
}

fn estimate_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }

    let chinese_chars = text
        .chars()
        .filter(|ch| matches!(
            *ch,
            '\u{4E00}'..='\u{9FFF}' |
            '\u{3400}'..='\u{4DBF}' |
            '\u{F900}'..='\u{FAFF}'
        ))
        .count();
    let other_chars = text.chars().count().saturating_sub(chinese_chars);

    chinese_chars.saturating_mul(2).div_ceil(3) + other_chars.div_ceil(4)
}

/// 构建 glob 模式列表
fn build_glob_patterns(includes: &Option<Vec<String>>) -> Vec<glob::Pattern> {
    includes.as_ref()
        .map(|patterns| {
            patterns.iter()
                .filter_map(|p| glob::Pattern::new(p).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// 检查文件名是否匹配任一 glob 模式
fn matches_any_glob(path: &Path, root: &Path, patterns: &[glob::Pattern]) -> bool {
    if let Some(file_name) = path.file_name().and_then(|f| f.to_str()) {
        if patterns.iter().any(|p| p.matches(file_name)) {
            return true;
        }
    }

    let normalized_absolute = path.to_string_lossy().replace('\\', "/");
    if patterns.iter().any(|p| p.matches(&normalized_absolute)) {
        return true;
    }

    path.strip_prefix(root)
        .ok()
        .map(|relative| {
            let normalized_relative = relative.to_string_lossy().replace('\\', "/");
            patterns.iter().any(|p| p.matches(&normalized_relative))
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn searchable_documents_are_not_skipped_as_binary_files() {
        for file_name in ["report.docx", "sheet.xlsx", "legacy.xls", "deck.pptx", "paper.pdf"] {
            let path = Path::new(file_name);
            assert!(is_searchable_document(path));
            assert!(!should_skip_file(path));
        }
    }

    #[tokio::test]
    async fn grep_searches_markdown_inside_attachments_directory() {
        let root = std::env::temp_dir().join(format!(
            "agentvis-local-search-attachments-{}",
            uuid::Uuid::new_v4()
        ));
        let attachments = root.join("attachments");
        fs::create_dir_all(&attachments).expect("create attachments directory");
        let file_path = attachments.join("flight-x.md");
        fs::write(
            &file_path,
            "# 译后记\n\n陶立夏 上海，二〇一年十一月\n",
        )
        .expect("write markdown attachment");

        let results = code_grep(
            "译后记|陶立夏".to_string(),
            root.to_string_lossy().to_string(),
            Some(true),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect("grep attachments markdown");

        let _ = fs::remove_dir_all(&root);

        assert_eq!(results.matches.len(), 2);
        assert_eq!(results.diagnostics.scanned_files, 1);
        assert!(results.matches.iter().any(|item| item.file.ends_with("flight-x.md") && item.line == 1));
        assert!(results.matches.iter().any(|item| item.file.ends_with("flight-x.md") && item.line == 3));
    }

    #[tokio::test]
    async fn grep_uses_smart_case_by_default() {
        let root = std::env::temp_dir().join(format!(
            "agentvis-local-search-smart-case-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create temp directory");
        let file_path = root.join("note.md");
        fs::write(&file_path, "Flight log\n").expect("write markdown");

        let smart_case = code_grep(
            "flight".to_string(),
            root.to_string_lossy().to_string(),
            Some(false),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect("smart-case grep");
        let case_sensitive = code_grep(
            "flight".to_string(),
            root.to_string_lossy().to_string(),
            Some(false),
            None,
            None,
            None,
            None,
            Some(false),
            None,
        )
        .await
        .expect("case-sensitive grep");

        let _ = fs::remove_dir_all(&root);

        assert_eq!(smart_case.matches.len(), 1);
        assert!(smart_case.diagnostics.case_insensitive);
        assert_eq!(case_sensitive.matches.len(), 0);
        assert!(!case_sensitive.diagnostics.case_insensitive);
    }

    #[tokio::test]
    async fn grep_returns_snippet_centered_on_match_and_matches_relative_glob() {
        let root = std::env::temp_dir().join(format!(
            "agentvis-local-search-snippet-{}",
            uuid::Uuid::new_v4()
        ));
        let docs = root.join("docs");
        fs::create_dir_all(&docs).expect("create docs directory");
        let long_prefix = "前".repeat(80);
        let long_suffix = "后".repeat(80);
        let file_path = docs.join("flight.md");
        fs::write(
            &file_path,
            format!("{}译后记{}", long_prefix, long_suffix),
        )
        .expect("write markdown");

        let results = code_grep(
            "译后记".to_string(),
            root.to_string_lossy().to_string(),
            Some(false),
            Some(vec!["docs/*.md".to_string()]),
            None,
            Some(30),
            None,
            None,
            None,
        )
        .await
        .expect("grep centered snippet");

        let _ = fs::remove_dir_all(&root);

        assert_eq!(results.matches.len(), 1);
        let snippet = &results.matches[0].content;
        assert!(snippet.starts_with("..."));
        assert!(snippet.ends_with("..."));
        assert!(snippet.contains("[[译后记]]"));
    }

    #[test]
    fn decode_text_bytes_supports_utf8_and_utf16_bom() {
        assert_eq!(
            decode_text_bytes("AgentVis 搜索".as_bytes()).ok().as_deref(),
            Some("AgentVis 搜索")
        );

        let mut utf16le = vec![0xFF, 0xFE];
        for unit in "中文搜索".encode_utf16() {
            utf16le.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_text_bytes(&utf16le).ok().as_deref(), Some("中文搜索"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn decode_text_bytes_supports_gbk_on_windows() {
        let (encoded, _, had_errors) = encoding_rs::GBK.encode("中文搜索");
        assert!(!had_errors);
        assert_eq!(decode_text_bytes(&encoded).ok().as_deref(), Some("中文搜索"));
    }

    #[test]
    fn decode_text_bytes_skips_probable_binary_content() {
        let bytes = [0, 1, 2, 0, 3, 4, 0, 5, 6, 0, 7, 8, 0, 9, 10, 0];
        assert!(matches!(decode_text_bytes(&bytes), Err(SearchContentSkip::ProbableBinary)));
    }
}
