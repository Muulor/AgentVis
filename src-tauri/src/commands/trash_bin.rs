//! Agent Trash Bin — 删除命令拦截与软删除
//!
//! 将 Agent 的删除操作重写为"移动到回收站"，实现可恢复的删除。
//!
//! 设计原则：
//! - 拦截 del/rmdir/erase/Remove-Item 格式
//! - 复杂命令（通配符、管道链等）回退正常执行流程
//! - 30 天自动清理过期条目
//! - manifest.json 记录完整删除元数据，支持手动恢复

use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

use crate::error::AppError;

// fs2 用于文件排他锁，保证 manifest 并发写入安全
use fs2::FileExt;

// ==================== 常量 ====================

/// Trash Bin 目录名
const TRASH_BIN_DIR: &str = "Agent_Trash_Bin";

/// Manifest 文件名
const MANIFEST_FILE: &str = "trash_manifest.json";

/// 默认保留天数
const DEFAULT_RETENTION_DAYS: u64 = 30;
const DELETE_SUCCESS_OBSERVATION: &str = "Deleted successfully.";
const SANDBOX_DELETE_BLOCK_MESSAGE: &str =
    "Sandbox block: delete target is outside the OfflineIsolated sandbox filesystem scope.";

// ==================== 类型定义 ====================

/// Trash Bin 条目
///
/// 记录每次删除操作的完整元数据，支持手动恢复。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TrashEntry {
    /// 唯一标识（时间戳 + 随机后缀）
    id: String,
    /// 原始文件/目录路径
    original_path: String,
    /// 在回收站中的路径
    trash_path: String,
    /// 删除时间（ISO 8601）
    deleted_at: String,
    /// 原始命令
    command: String,
    /// 是否为目录
    is_directory: bool,
}

// ==================== 路径辅助函数 ====================

/// 获取 Trash Bin 根目录
fn get_trash_bin_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(TRASH_BIN_DIR)
}

/// 获取 manifest 文件路径
fn get_manifest_path(app_data_dir: &Path) -> PathBuf {
    get_trash_bin_dir(app_data_dir).join(MANIFEST_FILE)
}

/// 将原始路径编码为安全的文件名
///
/// 替换路径分隔符和特殊字符，使其可作为文件名使用
fn encode_path_for_filename(path: &str) -> String {
    let encoded = path
        .replace('\\', "_")
        .replace('/', "_")
        .replace(':', "_")
        .replace(' ', "_");
    // 合并连续下划线（例如 C:\ → C_ 而非 C__）
    let mut result = String::with_capacity(encoded.len());
    let mut prev_underscore = false;
    for ch in encoded.chars() {
        if ch == '_' {
            if !prev_underscore {
                result.push('_');
            }
            prev_underscore = true;
        } else {
            result.push(ch);
            prev_underscore = false;
        }
    }
    result
}

/// 生成回收站中的目标路径
///
/// 格式: {trash_bin}/{timestamp}_{encoded_original_path}
fn generate_trash_path(app_data_dir: &Path, original_path: &str) -> PathBuf {
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let encoded = encode_path_for_filename(original_path);

    // 截断过长的路径（Windows 路径限制 260 字符）
    let max_name_len = 200;
    let name = if encoded.len() > max_name_len {
        format!("{}_{}", timestamp, &encoded[..max_name_len])
    } else {
        format!("{}_{}", timestamp, encoded)
    };

    get_trash_bin_dir(app_data_dir).join(name)
}

// ==================== Manifest 管理 ====================

/// 读取 manifest
fn read_manifest(app_data_dir: &Path) -> Vec<TrashEntry> {
    let path = get_manifest_path(app_data_dir);
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            serde_json::from_str(&content).unwrap_or_else(|e| {
                log::warn!("[TrashBin] manifest 解析失败: {}", e);
                Vec::new()
            })
        }
        Err(_) => Vec::new(),
    }
}

/// 写入 manifest
fn write_manifest(app_data_dir: &Path, entries: &[TrashEntry]) -> Result<(), AppError> {
    let path = get_manifest_path(app_data_dir);
    let content = serde_json::to_string_pretty(entries)
        .map_err(|e| AppError::Generic(format!("Failed to serialize manifest: {}", e)))?;
    std::fs::write(&path, content)
        .map_err(|e| AppError::FileSystem(format!("Failed to write manifest: {}", e)))?;
    Ok(())
}

/// 以排他锁方式追加一条记录到 manifest
///
/// 使用文件排他锁（fs2::FileExt）保证并发安全：
/// 多个 shell_execute 同时触发删除拦截时，不会丢失 manifest 数据。
///
/// 关键：Windows 排他锁阻止同进程的其他句柄访问同一文件，
/// 因此必须通过**同一个 file 句柄**进行读写，不能用 std::fs::read_to_string / std::fs::write。
fn append_to_manifest(app_data_dir: &Path, entry: TrashEntry) -> Result<(), AppError> {
    use std::io::{Read, Seek, Write};

    let manifest_path = get_manifest_path(app_data_dir);

    // 确保 manifest 所在目录存在
    if let Some(parent) = manifest_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::FileSystem(format!("Failed to create Trash Bin directory: {}", e)))?;
    }

    // 打开或创建 manifest 文件
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&manifest_path)
        .map_err(|e| AppError::FileSystem(format!("Failed to open manifest: {}", e)))?;

    // 获取排他锁（阻塞等待其他进程/线程释放）
    file.lock_exclusive()
        .map_err(|e| AppError::FileSystem(format!("Failed to acquire exclusive manifest lock: {}", e)))?;

    // 通过同一句柄读取现有数据（不能用 std::fs::read_to_string，会另开句柄触发 os error 33）
    let mut content = String::new();
    file.read_to_string(&mut content).unwrap_or_default();

    let mut entries: Vec<TrashEntry> = if content.trim().is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(&content).unwrap_or_else(|e| {
            log::warn!("[TrashBin] manifest 解析失败: {}", e);
            Vec::new()
        })
    };

    // 追加新条目
    entries.push(entry);
    let new_content = serde_json::to_string_pretty(&entries)
        .map_err(|e| AppError::Generic(format!("Failed to serialize manifest: {}", e)))?;

    // 通过同一句柄写回：先回到文件头，截断，再写入
    file.seek(std::io::SeekFrom::Start(0))
        .map_err(|e| AppError::FileSystem(format!("Failed to seek manifest: {}", e)))?;
    file.set_len(0)
        .map_err(|e| AppError::FileSystem(format!("Failed to truncate manifest: {}", e)))?;
    file.write_all(new_content.as_bytes())
        .map_err(|e| AppError::FileSystem(format!("Failed to write manifest: {}", e)))?;
    file.flush()
        .map_err(|e| AppError::FileSystem(format!("Failed to flush manifest: {}", e)))?;

    // 锁在 file drop 时自动释放
    Ok(())
}

// ==================== 命令解析 ====================

/// 从删除命令中提取目标路径
///
/// 支持的格式:
/// - `del filepath` / `del /f /q filepath` / `del file1.txt file2.txt`
/// - `erase filepath`
/// - `rmdir /s /q dirpath` / `rd /s /q dirpath`
/// - `powershell -Command "Remove-Item 'path'"` (多种引号形式)
/// - `powershell -Command "ri 'path'"` / `rm 'path'` (PS 别名)
/// - `cmd /c "del filepath"` (嵌套命令)
/// - `Get-ChildItem *.log | Remove-Item` (管道删除)
///
/// 返回 None 表示无法解析（复杂格式），应回退正常执行
fn extract_delete_target(command: &str) -> Option<(String, bool)> {
    let trimmed = command.trim();
    let lower = trimmed.to_lowercase();

    // PowerShell Remove-Item 及其别名（ri/rm）优先匹配（在链式检查之前）
    // 原因：PowerShell -Command 内的 ; 是 PS 语句分隔符，不应被视为 CMD 管道链
    if lower.contains("remove-item") || contains_ps_delete_alias(&lower) {
        return extract_powershell_remove_item_target(trimmed);
    }

    // 管道删除模式：Get-ChildItem *.ext | Remove-Item
    // 提取管道前 Get-ChildItem 的路径/模式，作为 glob 展开目标
    if let Some(result) = extract_pipe_delete_target(&lower, trimmed) {
        return Some(result);
    }

    // cmd /c 嵌套：提取内部命令并递归解析
    if let Some(inner) = extract_cmd_c_inner(&lower, trimmed) {
        return extract_delete_target(&inner);
    }

    // CMD 命令的链式操作符检查（&&, ||, |, ;）
    // 仅对 del/rmdir/erase 等 CMD 命令应用
    if trimmed.contains("&&") || trimmed.contains("||") || trimmed.contains('|') || trimmed.contains(';') {
        return None;
    }

    // 尝试匹配 del / erase 命令
    if lower.starts_with("del ") || lower.starts_with("erase ") {
        let target = extract_path_after_flags(trimmed);
        return target.map(|t| (t, false));
    }

    // 尝试匹配 rmdir / rd 命令
    if lower.starts_with("rmdir ") || lower.starts_with("rd ") {
        let target = extract_path_after_flags(trimmed);
        return target.map(|t| (t, true));
    }

    None
}

/// 从 CMD del/erase 命令中提取多个目标路径。
///
/// CMD 原生支持 `del /f "a.png" "b.png"`，但单目标解析只会拿到第一个
/// 引号参数。删除拦截器一旦返回成功，原始 del 命令就不会再执行，因此这里
/// 需要完整提取所有目标，避免后续文件被静默跳过。
fn extract_cmd_delete_targets(command: &str) -> Option<(Vec<String>, bool)> {
    let trimmed = command.trim();
    let lower = trimmed.to_lowercase();

    if !(lower.starts_with("del ") || lower.starts_with("erase ")) {
        return None;
    }

    if trimmed.contains("&&") || trimmed.contains("||") || trimmed.contains('|') || trimmed.contains(';') {
        return None;
    }

    let after_cmd = trimmed.split_once(char::is_whitespace)?.1.trim();
    let mut remaining = after_cmd;
    loop {
        remaining = remaining.trim_start();
        if remaining.starts_with('/') || remaining.starts_with('-') {
            remaining = match remaining.split_once(char::is_whitespace) {
                Some((_, rest)) => rest,
                None => return None,
            };
        } else {
            break;
        }
    }

    let targets = split_shell_like_paths(remaining);
    if targets.is_empty() {
        return None;
    }

    Some((targets, false))
}

fn split_shell_like_paths(input: &str) -> Vec<String> {
    let mut targets = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;

    for ch in input.chars() {
        match quote {
            Some(q) if ch == q => {
                quote = None;
            }
            Some(_) => {
                current.push(ch);
            }
            None if ch == '"' || ch == '\'' => {
                quote = Some(ch);
            }
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    targets.push(std::mem::take(&mut current));
                }
            }
            None => {
                current.push(ch);
            }
        }
    }

    if !current.is_empty() {
        targets.push(current);
    }

    targets
}

/// 检测是否包含 PowerShell 删除别名（ri / rm）
///
/// Agent 偶尔使用 PS 内置别名而非全名。
/// 仅在 powershell -Command 上下文中匹配，避免误判 Unix 的 rm 命令。
fn contains_ps_delete_alias(lower: &str) -> bool {
    // 必须是 PowerShell 上下文
    if !lower.contains("powershell") {
        return false;
    }
    // 检测 PS 别名：ri / rm（作为独立 token）
    // 使用空格边界检测，避免匹配 "trim" 等单词中的 "ri"/"rm"
    lower.contains(" ri ") || lower.contains(" ri '") || lower.contains(" ri \"")
        || lower.contains(" rm ") || lower.contains(" rm '") || lower.contains(" rm \"")
}

/// 提取管道删除目标：`Get-ChildItem *.ext | Remove-Item`
///
/// 将管道前的 Get-ChildItem/gci/ls 的路径参数作为 glob 模式返回。
fn extract_pipe_delete_target(lower: &str, original: &str) -> Option<(String, bool)> {
    // 必须包含管道 + 删除命令
    if !original.contains('|') {
        return None;
    }

    // 检测管道后是否有删除命令
    let pipe_pos = original.find('|')?;
    let after_pipe = lower[pipe_pos + 1..].trim();
    let has_delete_after_pipe = after_pipe.starts_with("remove-item")
        || after_pipe.starts_with("ri ")
        || after_pipe.starts_with("ri'")
        || after_pipe.starts_with("rm ")
        || after_pipe.starts_with("rm'")
        || after_pipe == "ri"
        || after_pipe == "rm"
        || after_pipe.starts_with("del ")
        || after_pipe == "del";

    if !has_delete_after_pipe {
        return None;
    }

    // 提取管道前的路径/模式
    let before_pipe = original[..pipe_pos].trim();
    let before_lower = before_pipe.to_lowercase();

    // Get-ChildItem / gci / ls + 路径
    let path_part = if before_lower.starts_with("get-childitem") {
        &before_pipe["get-childitem".len()..]
    } else if before_lower.starts_with("gci") {
        &before_pipe["gci".len()..]
    } else if before_lower.starts_with("ls") {
        &before_pipe["ls".len()..]
    } else {
        return None;
    };

    // 跳过 -flags，提取路径
    let path = skip_ps_flags(path_part.trim()).trim();
    if path.is_empty() {
        return None;
    }

    // 清理引号
    let clean = path
        .trim_matches('\'')
        .trim_matches('"')
        .trim();

    if clean.is_empty() {
        return None;
    }

    let is_dir = before_lower.contains("-directory");
    Some((clean.to_string(), is_dir))
}

/// 从 cmd /c "..." 中提取内部命令
///
/// 场景：`cmd /c "del C:\path\file.txt"` → 返回 `del C:\path\file.txt`
fn extract_cmd_c_inner(lower: &str, original: &str) -> Option<String> {
    // 匹配 cmd /c 或 cmd /C
    let cmd_prefix_patterns = ["cmd /c ", "cmd /c \"", "cmd /c '", "cmd.exe /c "];
    for pattern in &cmd_prefix_patterns {
        if lower.starts_with(pattern) {
            let inner = &original[pattern.len()..];
            // 去除外层引号
            let inner = inner.trim()
                .trim_end_matches('"')
                .trim_end_matches('\'')
                .trim();
            if !inner.is_empty() {
                return Some(inner.to_string());
            }
        }
    }
    None
}

/// 从命令中提取路径（跳过所有 /开头的参数标志）
fn extract_path_after_flags(command: &str) -> Option<String> {
    let trimmed = command.trim();
    // 跳过命令名（第一个空白分隔 token）
    let after_cmd = trimmed.split_once(char::is_whitespace)?.1.trim();

    // 如果剩余部分以引号开头，提取引号内的完整路径（支持空格）
    // 先跳过所有 /flag 和 -flag
    let mut remaining = after_cmd;
    loop {
        remaining = remaining.trim_start();
        if remaining.starts_with('/') || remaining.starts_with('-') {
            // 跳过当前 flag token
            remaining = match remaining.split_once(char::is_whitespace) {
                Some((_, rest)) => rest,
                None => return None, // 只有 flag 没有路径
            };
        } else {
            break;
        }
    }

    // remaining 现在应该是路径（可能带引号）
    let remaining = remaining.trim();
    if remaining.is_empty() {
        return None;
    }

    let path = if remaining.starts_with('"') {
        // 提取引号对内的完整内容
        let rest = &remaining[1..];
        match rest.find('"') {
            Some(end) => &rest[..end],
            None => rest, // 未闭合引号，使用到末尾
        }
    } else if remaining.starts_with('\'') {
        let rest = &remaining[1..];
        match rest.find('\'') {
            Some(end) => &rest[..end],
            None => rest,
        }
    } else {
        // 无引号，取第一个空白前的 token
        remaining.split_whitespace().next().unwrap_or(remaining)
    };

    if path.is_empty() {
        return None;
    }
    // 通配符路径允许通过，交由 try_intercept_delete 中的 handle_glob_delete 处理
    Some(path.to_string())
}

/// 从 PowerShell Remove-Item（或别名 ri/rm）中提取目标路径
///
/// 支持 Agent 实际生成的多种格式:
/// - `powershell -Command "Remove-Item 'path' -Force"`
/// - `powershell -Command 'Remove-Item \'path\' -Force; if ($?) { ... }'`
/// - `powershell -Command "ri 'path'"` / `rm 'path'` (PS 别名)
/// - `Remove-Item 'path' -Force -Recurse`
///
/// 设计要点：
/// - 先截断分号后的内容（PS 语句分隔符，如 `; if ($?) {...}`）
/// - 支持 `\'path\'` / `'path'` / `"path"` 三种引号模式
fn extract_powershell_remove_item_target(command: &str) -> Option<(String, bool)> {
    let (paths, is_directory) = extract_powershell_remove_item_targets(command)?;
    paths.into_iter().next().map(|path| (path, is_directory))
}

fn extract_powershell_remove_item_targets(command: &str) -> Option<(Vec<String>, bool)> {
    let lower = command.to_lowercase();

    // 查找删除命令位置：优先 remove-item，然后尝试别名 ri/rm
    let (cmd_end_pos, _cmd_name) = find_ps_delete_command(&lower)?;
    let after_ri = &command[cmd_end_pos..];
    let after_ri = after_ri.trim();

    // 先截断分号及之后的内容（如 ; if ($?) { '删除成功' } else { '删除失败' }）
    // 分号在 PowerShell -Command 中是语句分隔符，后面通常是结果检查逻辑
    let effective = match after_ri.find(';') {
        Some(pos) => &after_ri[..pos],
        None => after_ri,
    };
    let effective = effective.trim();

    let is_directory = lower.contains("-recurse");

    // 从 effective 中提取路径（跳过 -Flag 参数）
    // Agent 常用格式: \'C:\Users\Admin\Pictures\log.txt\' -Force
    //                 'C:\path\file' -Force
    //                 "C:\path\file" -Force

    // 策略：找到第一个非 - 开头的 token，作为路径
    // 但需要特殊处理引号包裹的路径（可能含空格）

    let paths = extract_paths_from_ps_args(effective);

    if paths.is_empty() {
        return None;
    }
    Some((paths, is_directory))
}

/// 在命令字符串中查找 PS 删除命令（remove-item / ri / rm）的位置
///
/// 返回 (命令结束位置, 命令名) 或 None
/// 优先匹配 remove-item，然后尝试别名 ri / rm（需要词边界）
fn find_ps_delete_command(lower: &str) -> Option<(usize, &str)> {
    // 优先匹配完整名
    if let Some(pos) = lower.find("remove-item") {
        return Some((pos + "remove-item".len(), "remove-item"));
    }

    // 匹配别名 ri（需要前后边界：空格/引号/行首）
    for (alias, alias_len) in [(" ri ", 4usize), (" ri '", 4), (" ri \"", 4)] {
        if let Some(pos) = lower.find(alias) {
            // +1 跳过前导空格，+ alias_len-1 到 alias 末尾（不含尾随字符）
            return Some((pos + alias_len - 1, "ri"));
        }
    }

    // 匹配别名 rm（同样需要边界）
    for (alias, alias_len) in [(" rm ", 4usize), (" rm '", 4), (" rm \"", 4)] {
        if let Some(pos) = lower.find(alias) {
            return Some((pos + alias_len - 1, "rm"));
        }
    }

    None
}

/// 从 PowerShell Remove-Item 的参数部分提取路径列表
///
/// 处理 Agent 常见的参数格式：
/// - `\'path\' -Force` — 转义单引号（PS -Command 嵌套）
/// - `'path' -Force` — 标准单引号
/// - `"path" -Force` — 标准双引号
/// - `-Path 'path' -Recurse -Force` — 带 -Path 前缀（含空格路径）
/// - `path -Force` — 无引号简单路径
///
/// 核心策略：先跳过所有 -flag，再按引号和逗号解析剩余路径列表
fn extract_paths_from_ps_args(args: &str) -> Vec<String> {
    let trimmed = args.trim();

    // 策略：从原始字符串中找到第一个非 -flag 的位置，
    // 然后在该位置对剩余字符串做引号匹配。
    // 不能用 split_whitespace，因为引号内的空格不应分割。

    let remaining = skip_ps_flags(trimmed);
    let remaining = remaining.trim();

    if remaining.is_empty() {
        return Vec::new();
    }

    split_powershell_path_list(remaining)
}

fn split_powershell_path_list(input: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if quote.is_none() && ch.is_whitespace() {
            if current.is_empty() {
                continue;
            }

            let rest: String = chars.clone().collect();
            if rest.trim_start().starts_with('-') {
                push_clean_path(&mut paths, &mut current);
                break;
            }

            current.push(ch);
            continue;
        }

        if quote.is_none() && ch == ',' {
            push_clean_path(&mut paths, &mut current);
            continue;
        }

        if quote.is_none() && is_quote_char(ch) {
            quote = Some(ch);
            continue;
        }

        if let Some(q) = quote {
            if quotes_match(ch, q) {
                quote = None;
                continue;
            }
        }

        if ch == '\\' && quote == Some('\'') && chars.peek() == Some(&'\'') {
            let _ = chars.next();
            quote = None;
            continue;
        }

        current.push(ch);
    }

    push_clean_path(&mut paths, &mut current);
    paths
}

fn push_clean_path(paths: &mut Vec<String>, current: &mut String) {
    let clean = current
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim_matches('“')
        .trim_matches('”')
        .trim_matches('‘')
        .trim_matches('’')
        .trim_matches('\\')
        .trim();

    if !clean.is_empty() {
        paths.push(clean.to_string());
    }
    current.clear();
}

fn is_quote_char(ch: char) -> bool {
    matches!(ch, '"' | '\'' | '“' | '”' | '‘' | '’')
}

fn quotes_match(ch: char, quote: char) -> bool {
    ch == quote
        || (quote == '“' && ch == '”')
        || (quote == '‘' && ch == '’')
}

/// 跳过 PowerShell 参数字符串中的所有 -flag 前缀
///
/// 逐字符遍历，跳过 `-FlagName` 和跟随的空白，直到遇到非 - 开头的内容。
/// 返回跳过 flags 后的剩余字符串切片。
fn skip_ps_flags(s: &str) -> &str {
    let mut remaining = s.trim();
    loop {
        if !remaining.starts_with('-') {
            break;
        }
        // 当前是 -flag，找到这个 flag 的结束位置（下一个空白或字符串末尾）
        match remaining.find(char::is_whitespace) {
            Some(space_pos) => {
                remaining = remaining[space_pos..].trim_start();
            }
            None => {
                // 只有一个 -flag 没有后续内容
                return "";
            }
        }
    }
    remaining
}

// ==================== 核心操作 ====================

/// 将文件/目录移动到 Trash Bin
///
/// 优先使用 rename（同卷零开销），跨卷时拷贝后删除。
fn move_to_trash(
    source: &Path,
    trash_path: &Path,
    is_directory: bool,
) -> Result<(), AppError> {
    // 确保 Trash Bin 目录存在
    if let Some(parent) = trash_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::FileSystem(format!(
                "Failed to create Trash Bin directory: {}", e
            )))?;
    }

    // 尝试 rename（同卷移动）
    match std::fs::rename(source, trash_path) {
        Ok(()) => {
            log::info!(
                "[TrashBin] 文件已移动: {} → {}",
                source.display(),
                trash_path.display()
            );
            return Ok(());
        }
        Err(e) => {
            log::debug!(
                "[TrashBin] rename 失败 (可能跨卷): {}，尝试 copy+remove",
                e
            );
        }
    }

    // 跨卷: 拷贝后删除源
    if is_directory {
        copy_dir_recursive(source, trash_path)?;
        std::fs::remove_dir_all(source)
            .map_err(|e| AppError::FileSystem(format!(
                "Failed to remove source directory: {}", e
            )))?;
    } else {
        std::fs::copy(source, trash_path)
            .map_err(|e| AppError::FileSystem(format!(
                "Failed to copy file across volumes: {}", e
            )))?;
        std::fs::remove_file(source)
            .map_err(|e| AppError::FileSystem(format!(
                "Failed to remove source file: {}", e
            )))?;
    }

    log::info!(
        "[TrashBin] 跨卷移动完成: {} → {}",
        source.display(),
        trash_path.display()
    );
    Ok(())
}

/// 递归复制目录
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(dst)
        .map_err(|e| AppError::FileSystem(format!("Failed to create target directory: {}", e)))?;

    let entries = std::fs::read_dir(src)
        .map_err(|e| AppError::FileSystem(format!("Failed to read source directory: {}", e)))?;

    for entry in entries {
        let entry = entry
            .map_err(|e| AppError::FileSystem(format!("Failed to read directory entry: {}", e)))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)
                .map_err(|e| AppError::FileSystem(format!(
                    "Failed to copy file {}: {}",
                    src_path.display(),
                    e
                )))?;
        }
    }

    Ok(())
}

// ==================== 公开接口 ====================

/// 判断路径是否包含通配符
fn is_glob_pattern(path: &str) -> bool {
    path.contains('*') || path.contains('?')
}

fn normalize_path_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn path_key(path: &Path) -> String {
    let mut key = normalize_path_lexically(path)
        .to_string_lossy()
        .replace('\\', "/");
    if let Some(stripped) = key.strip_prefix("//?/") {
        key = stripped.to_string();
    }
    key.trim_end_matches('/').to_ascii_lowercase()
}

fn canonical_or_normalized(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| normalize_path_lexically(path))
}

fn path_is_inside_root(root: &Path, path: &Path) -> bool {
    let root_key = path_key(root);
    let path_key = path_key(path);
    path_key == root_key || path_key.starts_with(&format!("{}/", root_key))
}

fn is_path_allowed_by_roots(path: &Path, allowed_roots: &[PathBuf]) -> bool {
    let candidate = canonical_or_normalized(path);
    allowed_roots.iter().any(|root| {
        let root = canonical_or_normalized(root);
        path_is_inside_root(&root, &candidate)
    })
}

fn ensure_delete_path_allowed(
    target_path: &Path,
    allowed_roots: Option<&[PathBuf]>,
) -> Result<(), AppError> {
    let Some(allowed_roots) = allowed_roots else {
        return Ok(());
    };
    if !allowed_roots.is_empty() && is_path_allowed_by_roots(target_path, allowed_roots) {
        return Ok(());
    }

    log::warn!(
        "[TrashBin] sandbox scoped delete blocked outside allowed roots: {}",
        target_path.display()
    );
    Err(AppError::Forbidden(
        SANDBOX_DELETE_BLOCK_MESSAGE.to_string(),
    ))
}

fn resolve_delete_path(target: &str, workdir: Option<&Path>) -> PathBuf {
    let trimmed = target.trim_matches(|c| c == '\'' || c == '"');
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return normalize_path_lexically(path);
    }

    match workdir {
        Some(wd) => normalize_path_lexically(&wd.join(path)),
        None => normalize_path_lexically(path),
    }
}

/// 移动单个文件/目录到 Trash Bin 并记录 manifest
///
/// 返回用户可见的反馈消息
fn trash_single_item(
    target_path: &Path,
    is_directory: bool,
    command: &str,
    app_data_dir: &Path,
) -> Result<String, AppError> {
    let target_path_str = target_path.to_string_lossy().to_string();

    // 校正目录标志
    let is_directory = is_directory || target_path.is_dir();

    // 生成回收站路径
    let trash_path = generate_trash_path(app_data_dir, &target_path_str);

    // 执行移动
    move_to_trash(target_path, &trash_path, is_directory)?;

    // 记录到 manifest
    let entry = TrashEntry {
        id: format!(
            "{}_{}",
            chrono::Local::now().format("%Y%m%d%H%M%S"),
            uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("0000")
        ),
        original_path: target_path_str.to_string(),
        trash_path: trash_path.to_string_lossy().to_string(),
        deleted_at: chrono::Local::now().to_rfc3339(),
        command: command.to_string(),
        is_directory,
    };
    append_to_manifest(app_data_dir, entry)?;

    let type_label = if is_directory { "Directory" } else { "File" };
    Ok(format!(
        "{}: {} → {}",
        type_label,
        target_path_str,
        trash_path.display()
    ))
}

fn opaque_delete_success_observation() -> String {
    DELETE_SUCCESS_OBSERVATION.to_string()
}

fn log_intercepted_delete(details: &[String], failed_count: u32) {
    log::info!(
        "[TrashBin] intercepted delete; moved {} item(s), failed {} item(s)",
        details.len(),
        failed_count
    );
    for detail in details {
        log::debug!("[TrashBin] {}", detail);
    }
}

/// 尝试拦截删除命令并重写为移动到 Trash Bin
///
/// 返回值:
/// - `Ok(Some(message))`: 成功拦截并移动，message 为用户可见的反馈
/// - `Ok(None)`: 非删除命令或无法解析，应继续正常执行流程
/// - `Err`: 拦截后移动失败
///
/// 支持通配符路径（如 `del *.webp`），使用 glob 展开后逐个移动
pub fn try_intercept_delete(
    command: &str,
    app_data_dir: &Path,
    workdir: Option<&Path>,
) -> Result<Option<String>, AppError> {
    try_intercept_delete_scoped(command, app_data_dir, workdir, None)
}

/// 尝试拦截删除命令，并在需要时限制宿主侧软删除只能作用于授权根目录。
///
/// `allowed_roots` 用于隔离 / 联网隔离模式：Trash Bin 的移动发生在 Tauri 主进程，
/// 因此必须在主进程侧复刻 AppContainer 的文件边界，避免软删除绕过沙箱。
pub fn try_intercept_delete_scoped(
    command: &str,
    app_data_dir: &Path,
    workdir: Option<&Path>,
    allowed_roots: Option<&[PathBuf]>,
) -> Result<Option<String>, AppError> {
    if let Some((target_paths, is_directory)) = extract_powershell_remove_item_targets(command) {
        if target_paths.len() > 1 {
            return handle_multi_delete(
                &target_paths,
                is_directory,
                command,
                app_data_dir,
                workdir,
                allowed_roots,
            );
        }
    }

    if let Some((target_paths, is_directory)) = extract_cmd_delete_targets(command) {
        if target_paths.len() > 1 {
            return handle_multi_delete(
                &target_paths,
                is_directory,
                command,
                app_data_dir,
                workdir,
                allowed_roots,
            );
        }
    }

    // 1. 尝试从命令中提取删除目标
    let (target_path_str, is_directory) = match extract_delete_target(command) {
        Some(result) => result,
        None => return Ok(None),
    };

    // 2. 通配符路径 → glob 展开后批量移动
    if is_glob_pattern(&target_path_str) {
        return handle_glob_delete(
            &target_path_str,
            command,
            app_data_dir,
            workdir,
            allowed_roots,
        );
    }

    // 3. 普通路径 → 验证存在性后单个移动
    let target_path = resolve_delete_path(&target_path_str, workdir);
    ensure_delete_path_allowed(&target_path, allowed_roots)?;
    if !target_path.exists() {
        // 目标不存在时不拦截，让原始命令处理错误
        return Ok(None);
    }

    let detail = trash_single_item(&target_path, is_directory, command, app_data_dir)?;
    log_intercepted_delete(&[detail], 0);
    Ok(Some(opaque_delete_success_observation()))
}

/// 处理 CMD del/erase 的多目标删除：`del /f "a" "b" "c"`。
fn handle_multi_delete(
    target_paths: &[String],
    is_directory: bool,
    command: &str,
    app_data_dir: &Path,
    workdir: Option<&Path>,
    allowed_roots: Option<&[PathBuf]>,
) -> Result<Option<String>, AppError> {
    let mut expanded_paths: Vec<PathBuf> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for target in target_paths {
        if is_glob_pattern(target) {
            let pattern_path = resolve_delete_path(target, workdir);
            ensure_delete_path_allowed(&pattern_path, allowed_roots)?;
            let glob_pattern = pattern_path.to_string_lossy().to_string();
            match glob::glob(&glob_pattern) {
                Ok(paths) => {
                    for path in paths.filter_map(|entry| entry.ok()).filter(|p| p.exists()) {
                        ensure_delete_path_allowed(&path, allowed_roots)?;
                        let key = path.to_string_lossy().to_string();
                        if seen.insert(key) {
                            expanded_paths.push(path);
                        }
                    }
                }
                Err(e) => {
                    log::warn!("[TrashBin] glob 解析失败: {}，跳过目标 {}", e, target);
                }
            }
            continue;
        }

        let path = resolve_delete_path(target, workdir);
        ensure_delete_path_allowed(&path, allowed_roots)?;
        if path.exists() {
            let key = path.to_string_lossy().to_string();
            if seen.insert(key) {
                expanded_paths.push(path);
            }
        }
    }

    if expanded_paths.is_empty() {
        log::debug!("[TrashBin] 多目标删除未匹配到任何存在的文件，回退原始执行");
        return Ok(None);
    }

    let mut moved_details: Vec<String> = Vec::new();
    let mut failed_count: u32 = 0;

    for path in &expanded_paths {
        let path_str = path.to_string_lossy().to_string();
        let is_dir = is_directory || path.is_dir();
        match trash_single_item(path, is_dir, command, app_data_dir) {
            Ok(detail) => moved_details.push(detail),
            Err(e) => {
                log::warn!("[TrashBin] 移动失败 {}: {}", path_str, e);
                failed_count += 1;
            }
        }
    }

    if moved_details.is_empty() {
        log::warn!("[TrashBin] 多目标删除全部移动失败，回退原始执行");
        return Ok(None);
    }

    log_intercepted_delete(&moved_details, failed_count);
    Ok(Some(opaque_delete_success_observation()))
}

/// 处理通配符删除：展开 glob 模式后逐个移动到 Trash Bin
///
/// 例如 `del C:\Users\Admin\Pictures\*.webp` 会展开为所有匹配的 .webp 文件，
/// 逐个移动到回收站。如果没有匹配到任何文件，则不拦截（回退原始执行）。
fn handle_glob_delete(
    pattern: &str,
    command: &str,
    app_data_dir: &Path,
    workdir: Option<&Path>,
    allowed_roots: Option<&[PathBuf]>,
) -> Result<Option<String>, AppError> {
    // 使用 glob 展开通配符
    let pattern_path = resolve_delete_path(pattern, workdir);
    ensure_delete_path_allowed(&pattern_path, allowed_roots)?;
    let glob_pattern = pattern_path.to_string_lossy().to_string();
    let matched_paths: Vec<std::path::PathBuf> = match glob::glob(&glob_pattern) {
        Ok(paths) => paths
            .filter_map(|entry| entry.ok())
            .filter(|p| p.exists())
            .map(|path| {
                ensure_delete_path_allowed(&path, allowed_roots)?;
                Ok(path)
            })
            .collect::<Result<Vec<_>, AppError>>()?,
        Err(e) => {
            log::warn!("[TrashBin] glob 解析失败: {}，回退原始执行", e);
            return Ok(None);
        }
    };

    // 无匹配文件 → 不拦截
    if matched_paths.is_empty() {
        log::debug!("[TrashBin] glob 模式 '{}' 未匹配到任何文件，跳过拦截", pattern);
        return Ok(None);
    }

    log::debug!(
        "[TrashBin] glob 模式 '{}' 匹配到 {} 个文件，开始批量移动",
        pattern,
        matched_paths.len()
    );

    // 逐个移动到回收站
    let mut moved_details: Vec<String> = Vec::new();
    let mut failed_count: u32 = 0;

    for matched_path in &matched_paths {
        let path_str = matched_path.to_string_lossy().to_string();
        let is_dir = matched_path.is_dir();
        match trash_single_item(matched_path, is_dir, command, app_data_dir) {
            Ok(detail) => moved_details.push(detail),
            Err(e) => {
                log::warn!("[TrashBin] 移动失败 {}: {}", path_str, e);
                failed_count += 1;
            }
        }
    }

    // 全部失败 → 回退原始执行
    if moved_details.is_empty() {
        log::warn!("[TrashBin] 批量移动全部失败，回退原始执行");
        return Ok(None);
    }

    log_intercepted_delete(&moved_details, failed_count);
    Ok(Some(opaque_delete_success_observation()))
}

/// 清理过期的回收站条目
///
/// 删除超过指定天数的文件/目录和 manifest 记录。
/// 在应用启动时自动调用一次。
pub fn cleanup_expired_items(app_data_dir: &Path) -> Result<u32, AppError> {
    let mut entries = read_manifest(app_data_dir);
    if entries.is_empty() {
        return Ok(0);
    }

    let now = chrono::Local::now();
    let retention = chrono::Duration::days(DEFAULT_RETENTION_DAYS as i64);
    let mut cleaned = 0u32;

    entries.retain(|entry| {
        // 解析删除时间
        let deleted_at = match chrono::DateTime::parse_from_rfc3339(&entry.deleted_at) {
            Ok(dt) => dt.with_timezone(&chrono::Local),
            Err(_) => return true, // 解析失败则保留
        };

        // 未过期则保留
        if now - deleted_at < retention {
            return true;
        }

        // 已过期 — 删除物理文件
        let trash_path = Path::new(&entry.trash_path);
        if trash_path.exists() {
            let result = if entry.is_directory {
                std::fs::remove_dir_all(trash_path)
            } else {
                std::fs::remove_file(trash_path)
            };

            match result {
                Ok(()) => {
                    log::debug!(
                        "[TrashBin] 清理过期条目: {} (已保留 {} 天)",
                        entry.original_path, DEFAULT_RETENTION_DAYS
                    );
                    cleaned += 1;
                }
                Err(e) => {
                    log::warn!(
                        "[TrashBin] 清理失败 {}: {}",
                        entry.trash_path, e
                    );
                    return true; // 删除失败则保留记录
                }
            }
        } else {
            // 物理文件已不存在，清理 manifest 记录
            cleaned += 1;
        }

        false // 从 manifest 中移除
    });

    // 更新 manifest
    if cleaned > 0 {
        write_manifest(app_data_dir, &entries)?;
        log::info!("[TrashBin] 自动清理完成: 清理了 {} 个过期条目", cleaned);
    }

    Ok(cleaned)
}

// ==================== 单元测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

    // ── 命令解析测试 ──

    #[test]
    fn test_extract_simple_del() {
        let result = extract_delete_target("del C:\\data\\file.txt");
        assert_eq!(result, Some(("C:\\data\\file.txt".to_string(), false)));
    }

    #[test]
    fn test_extract_del_with_flags() {
        let result = extract_delete_target("del /f /q C:\\data\\file.txt");
        assert_eq!(result, Some(("C:\\data\\file.txt".to_string(), false)));
    }

    #[test]
    fn test_extract_erase() {
        let result = extract_delete_target("erase C:\\data\\file.txt");
        assert_eq!(result, Some(("C:\\data\\file.txt".to_string(), false)));
    }

    #[test]
    fn test_extract_rmdir() {
        let result = extract_delete_target("rmdir /s /q C:\\data\\old_dir");
        assert_eq!(result, Some(("C:\\data\\old_dir".to_string(), true)));
    }

    #[test]
    fn test_extract_rd() {
        let result = extract_delete_target("rd /s /q C:\\data\\old_dir");
        assert_eq!(result, Some(("C:\\data\\old_dir".to_string(), true)));
    }

    #[test]
    fn test_extract_remove_item_simple() {
        let result = extract_delete_target(
            "powershell -Command \"Remove-Item 'C:\\data\\file.txt'\""
        );
        assert!(result.is_some());
        let (path, _) = result.unwrap();
        assert_eq!(path, "C:\\data\\file.txt");
    }

    #[test]
    fn test_extract_remove_item_recurse() {
        let result = extract_delete_target(
            "powershell -Command \"Remove-Item 'C:\\data\\dir' -Recurse -Force\""
        );
        assert!(result.is_some());
        let (path, is_dir) = result.unwrap();
        assert_eq!(path, "C:\\data\\dir");
        assert!(is_dir);
    }

    #[test]
    fn test_extract_non_delete_returns_none() {
        assert!(extract_delete_target("git status").is_none());
        assert!(extract_delete_target("npm run build").is_none());
        assert!(extract_delete_target("dir C:\\data").is_none());
    }

    #[test]
    fn test_extract_wildcard_returns_some() {
        // 通配符路径由 extract_delete_target 正常提取，
        // 交由 try_intercept_delete → handle_glob_delete 做 glob 展开处理
        let result = extract_delete_target("del *.tmp");
        assert_eq!(result, Some(("*.tmp".to_string(), false)));

        let result2 = extract_delete_target("del C:\\data\\*.log");
        assert_eq!(result2, Some(("C:\\data\\*.log".to_string(), false)));
    }

    #[test]
    fn test_extract_pipe_chain_returns_none() {
        // 管道链命令应该回退正常执行
        assert!(extract_delete_target("dir && del file.txt").is_none());
        assert!(extract_delete_target("echo y | del file.txt").is_none());
    }

    #[test]
    fn test_extract_del_with_quotes() {
        let result = extract_delete_target("del \"C:\\data\\my file.txt\"");
        assert_eq!(result, Some(("C:\\data\\my file.txt".to_string(), false)));
    }

    #[test]
    fn test_extract_del_with_multiple_quoted_targets() {
        let result = extract_cmd_delete_targets(
            "del /f \"C:\\data\\step0.png\" \"C:\\data\\step1.png\" \"C:\\data\\step2.png\""
        );
        assert_eq!(
            result,
            Some((
                vec![
                    "C:\\data\\step0.png".to_string(),
                    "C:\\data\\step1.png".to_string(),
                    "C:\\data\\step2.png".to_string(),
                ],
                false,
            ))
        );
    }

    #[test]
    fn test_extract_remove_item_with_multiple_targets() {
        let result = extract_powershell_remove_item_targets(
            "powershell -Command \"Remove-Item 'C:\\data\\observe.png','C:\\data\\wechat.png','C:\\data\\verify.png' -Force -ErrorAction SilentlyContinue\""
        );
        assert_eq!(
            result,
            Some((
                vec![
                    "C:\\data\\observe.png".to_string(),
                    "C:\\data\\wechat.png".to_string(),
                    "C:\\data\\verify.png".to_string(),
                ],
                false,
            ))
        );
    }

    #[test]
    fn test_extract_remove_item_with_path_flag_and_curly_quotes() {
        let result = extract_powershell_remove_item_targets(
            "powershell -Command “Remove-Item -Path ’C:\\data\\one.png’,’C:\\data\\two.png’ -Force”"
        );
        assert_eq!(
            result,
            Some((
                vec![
                    "C:\\data\\one.png".to_string(),
                    "C:\\data\\two.png".to_string(),
                ],
                false,
            ))
        );
    }

    // ── Manifest 与路径编码 ──

    #[test]
    fn test_encode_path() {
        assert_eq!(
            encode_path_for_filename("C:\\Users\\Admin\\file.txt"),
            "C_Users_Admin_file.txt"
        );
    }

    #[test]
    fn test_manifest_roundtrip() {
        let dir = std::env::temp_dir().join("agentvis_trash_test_manifest");
        let _ = std::fs::create_dir_all(get_trash_bin_dir(&dir));

        let entry = TrashEntry {
            id: "test_001".to_string(),
            original_path: "C:\\data\\file.txt".to_string(),
            trash_path: get_trash_bin_dir(&dir)
                .join("test_file.txt")
                .to_string_lossy()
                .to_string(),
            deleted_at: chrono::Local::now().to_rfc3339(),
            command: "del C:\\data\\file.txt".to_string(),
            is_directory: false,
        };

        append_to_manifest(&dir, entry.clone()).unwrap();
        let loaded = read_manifest(&dir);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].original_path, "C:\\data\\file.txt");

        // 清理
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── 完整拦截流程 ──

    #[test]
    fn test_intercept_nonexistent_file_returns_none() {
        let dir = std::env::temp_dir().join("agentvis_trash_test_nofile");
        // 文件不存在时不拦截
        let result = try_intercept_delete(
            "del C:\\nonexistent\\file_that_does_not_exist.txt",
            &dir,
            None,
        );
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn test_intercept_non_delete_returns_none() {
        let dir = std::env::temp_dir().join("agentvis_trash_test_nodel");
        let result = try_intercept_delete("git status", &dir, None);
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn test_intercept_real_file() {
        let dir = std::env::temp_dir().join("agentvis_trash_test_real");
        let _ = std::fs::create_dir_all(&dir);

        // 创建一个测试文件
        let test_file = dir.join("test_delete_me.txt");
        std::fs::write(&test_file, "test content").unwrap();

        let cmd = format!("del {}", test_file.to_string_lossy());
        let result = try_intercept_delete(&cmd, &dir, None);

        assert!(result.is_ok());
        let msg = result.unwrap();
        assert!(msg.is_some(), "应该成功拦截删除命令");
        let observation = msg.unwrap();
        assert_eq!(observation, DELETE_SUCCESS_OBSERVATION);
        assert!(!observation.to_lowercase().contains("trash"));
        assert!(!observation.contains("Agent_Trash_Bin"));
        assert!(!observation.contains(&dir.to_string_lossy().to_string()));
        assert!(!observation.contains(&test_file.to_string_lossy().to_string()));

        // 原文件应该已经不在原位
        assert!(!test_file.exists(), "原文件应已被移动");

        // Trash Bin 中应该有文件
        let trash_dir = get_trash_bin_dir(&dir);
        assert!(trash_dir.exists(), "Trash Bin 目录应存在");

        // Manifest 应该有记录
        let entries = read_manifest(&dir);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].original_path.contains("test_delete_me.txt"));

        // 清理
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_intercept_relative_file_uses_workdir() {
        let base = std::env::temp_dir().join("agentvis_trash_test_relative_workdir");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&app_dir);
        let _ = std::fs::create_dir_all(&workdir);

        let test_file = workdir.join("relative_delete_me.txt");
        std::fs::write(&test_file, "test content").unwrap();

        let result = try_intercept_delete(
            "del relative_delete_me.txt",
            &app_dir,
            Some(&workdir),
        );

        assert!(result.is_ok());
        let msg = result.unwrap();
        assert!(msg.is_some(), "应按 workdir 拦截相对路径删除");
        let observation = msg.unwrap();
        assert_eq!(observation, DELETE_SUCCESS_OBSERVATION);
        assert!(!observation.to_lowercase().contains("trash"));
        assert!(!observation.contains("Agent_Trash_Bin"));
        assert!(!observation.contains(&app_dir.to_string_lossy().to_string()));
        assert!(!observation.contains(&test_file.to_string_lossy().to_string()));
        assert!(!test_file.exists(), "workdir 下的相对目标应被移动");

        let entries = read_manifest(&app_dir);
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].original_path,
            test_file.to_string_lossy().to_string()
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_scoped_intercept_allows_allowed_root_delete() {
        let base = std::env::temp_dir().join("agentvis_trash_test_scoped_allowed");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&app_dir);
        let _ = std::fs::create_dir_all(&workdir);

        let test_file = workdir.join("delete_me.txt");
        std::fs::write(&test_file, "test content").unwrap();
        let allowed_roots = vec![workdir.clone()];

        let result = try_intercept_delete_scoped(
            "del delete_me.txt",
            &app_dir,
            Some(&workdir),
            Some(&allowed_roots),
        );

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), Some(DELETE_SUCCESS_OBSERVATION.to_string()));
        assert!(!test_file.exists(), "allowed root target should be moved");
        assert_eq!(read_manifest(&app_dir).len(), 1);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_scoped_intercept_blocks_outside_allowed_root() {
        let base = std::env::temp_dir().join("agentvis_trash_test_scoped_blocked");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let outside_dir = base.join("outside");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&app_dir);
        let _ = std::fs::create_dir_all(&workdir);
        let _ = std::fs::create_dir_all(&outside_dir);

        let outside_file = outside_dir.join("do_not_delete.txt");
        std::fs::write(&outside_file, "test content").unwrap();
        let allowed_roots = vec![workdir.clone()];
        let cmd = format!("del {}", outside_file.to_string_lossy());

        let result = try_intercept_delete_scoped(
            &cmd,
            &app_dir,
            Some(&workdir),
            Some(&allowed_roots),
        );

        assert!(matches!(result, Err(AppError::Forbidden(_))));
        assert!(
            outside_file.exists(),
            "outside sandbox target must not be moved by host-side Trash Bin"
        );
        assert!(read_manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_scoped_intercept_blocks_mixed_multi_delete() {
        let base = std::env::temp_dir().join("agentvis_trash_test_scoped_multi_blocked");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let outside_dir = base.join("outside");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&app_dir);
        let _ = std::fs::create_dir_all(&workdir);
        let _ = std::fs::create_dir_all(&outside_dir);

        let inside_file = workdir.join("inside.txt");
        let outside_file = outside_dir.join("outside.txt");
        std::fs::write(&inside_file, "inside").unwrap();
        std::fs::write(&outside_file, "outside").unwrap();
        let allowed_roots = vec![workdir.clone()];
        let cmd = format!(
            "del \"{}\" \"{}\"",
            inside_file.to_string_lossy(),
            outside_file.to_string_lossy()
        );

        let result = try_intercept_delete_scoped(
            &cmd,
            &app_dir,
            Some(&workdir),
            Some(&allowed_roots),
        );

        assert!(matches!(result, Err(AppError::Forbidden(_))));
        assert!(inside_file.exists(), "mixed delete should fail closed");
        assert!(outside_file.exists(), "outside target must remain untouched");
        assert!(read_manifest(&app_dir).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_intercept_multi_delete_observation_hides_trashbin() {
        let base = std::env::temp_dir().join("agentvis_trash_test_multi_observation");
        let app_dir = base.join("app");
        let workdir = base.join("work");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&app_dir);
        let _ = std::fs::create_dir_all(&workdir);

        let first = workdir.join("first.txt");
        let second = workdir.join("second.txt");
        std::fs::write(&first, "first").unwrap();
        std::fs::write(&second, "second").unwrap();

        let result = try_intercept_delete("del first.txt second.txt", &app_dir, Some(&workdir));

        assert!(result.is_ok());
        let observation = result.unwrap().unwrap();
        assert_eq!(observation, DELETE_SUCCESS_OBSERVATION);
        assert!(!observation.to_lowercase().contains("trash"));
        assert!(!observation.contains("Agent_Trash_Bin"));
        assert!(!observation.contains(&app_dir.to_string_lossy().to_string()));
        assert!(!observation.contains(&workdir.to_string_lossy().to_string()));

        assert!(!first.exists());
        assert!(!second.exists());
        assert_eq!(read_manifest(&app_dir).len(), 2);

        let _ = std::fs::remove_dir_all(&base);
    }
}
