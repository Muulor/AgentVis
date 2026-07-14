//! 命令安全校验器
//!
//! 作为 shell 执行的最后一道防线，在 Rust 层硬阻断危险命令。
//!
//! 设计原则：
//! - 绝对禁止命令黑名单：无条件阻断，不可绕过
//! - 破坏性命令 + 核心目录 = 组合阻断：保护系统关键路径
//! - 自定义保护目录：从配置文件加载用户自定义的受保护路径（带缓存）
//! - 所有匹配大小写不敏感
//!
//! TS/Rust 双层差异说明：
//! - TS 层 (`ExecSafetyPolicy.ts`) 使用正则 `\b` 词边界做精确匹配（第一道防线，快速反馈）
//! - Rust 层使用 `contains()` 子串匹配（最后一道防线，宁误报不漏检）
//! - 两层覆盖范围基本一致，但 icacls 组合阻断仅在 Rust 层实现

use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;

use crate::error::AppError;

// ==================== 绝对禁止命令 ====================

/// 绝对禁止的命令关键字
///
/// 命中任何一个即无条件阻断，不论目标路径或参数。
/// 据企业安全统计 powershell -EncodedCommand 超过 90% 为恶意用途，完全禁止。
const FORBIDDEN_COMMANDS: &[&str] = &[
    // 磁盘/分区操作 — 可导致数据全部丢失
    "diskpart",
    // 注意: format 已从此列表移除，改为 is_format_drive_command() 精确检测
    // 避免误报 Python 的 str.format()、Rust 的 format!() 等编程语言常见模式
    //
    // 启动配置 — 可导致系统无法启动
    "bcdedit",
    // 磁盘覆写 — 不可逆的数据销毁
    "cipher /w",
    // 文件所有权 — 可突破 TrustedInstaller 保护
    "takeown",
    // 系统文件检查 — 需管理员权限的系统级操作
    "sfc /",
    // 用户账户管理 — 可创建/删除用户
    "net user",
    // 服务管理 — 可停止/启动关键服务
    "net stop",
    "net start",
    // 服务删除 — 不可逆
    "sc delete",
    // 注意: wmic 已从此列表移除，改为 wmic + 写入子命令的组合阻断
    // 只读查询（如 wmic os get caption）允许通过
    //
    // 注册表删除 — 可破坏系统配置
    "reg delete",
    // Base64 编码命令 — 无法审查内容，>90% 恶意
    "-encodedcommand",
    // -enc 是 -EncodedCommand 的缩写，PowerShell 支持参数前缀
    // 使用不带尾随空格的形式，确保命令末尾的 -enc 也能匹配
    "-enc ",
    "-enc\"",
    // 系统级环境变量修改 — 永久修改所有用户的环境
    "setx /m",
    "setx  /m",
    // 注册表添加系统级键值 — 可修改系统级环境变量等
    "reg add hklm",
    // PowerShell .NET API — 可永久修改系统/用户级环境变量（绕过 setx 的主要方式）
    "::setenvironmentvariable",
    // 注册表直接访问系统环境变量路径（Session Manager\Environment）
    // 覆盖 Set-ItemProperty / New-ItemProperty / Remove-ItemProperty 等所有 cmdlet
    "session manager\\environment",
];

// ==================== 破坏性动词 ====================

/// 破坏性命令动词
///
/// 当这些动词与核心保护目录组合出现时，触发阻断。
/// 单独出现时不阻断（允许在用户项目目录中正常使用删除命令）。
const DESTRUCTIVE_VERBS: &[&str] = &[
    "del ",
    "del /",
    "rmdir",
    "remove-item",
    // rd 是 rmdir 的简写
    "rd ",
    "rd /",
    "erase ",
    "erase /",
];

// ==================== 核心保护目录 ====================

/// 系统核心保护目录
///
/// 这些路径（及其子目录）在面对破坏性命令时受到保护。
/// 包含环境变量形式以防止通过 %SystemRoot% 等方式绕过。
const PROTECTED_PATHS: &[&str] = &[
    // Windows 系统目录
    "c:\\windows",
    "c:\\program files",
    "c:\\program files (x86)",
    // 系统核心子目录（不带盘符前缀，覆盖更多场景）
    "system32",
    "syswow64",
    // 环境变量形式
    "%systemroot%",
    "%windir%",
    "%programfiles%",
    "%programfiles(x86)%",
    // ACL 修改命令中可能出现的路径关键字
    "\\windows\\system32",
    "\\windows\\syswow64",
];

/// ACL 修改命令的关键字
///
/// icacls/cacls 用于修改文件权限 ACL，当与系统目录组合时阻断。
/// 单独使用 icacls 查看权限（/t /c 等只读参数）不阻断，
/// 但修改权限的参数组合系统路径时阻断。
const ACL_MODIFY_KEYWORDS: &[&str] = &[
    "/grant",
    "/deny",
    "/remove",
    "/setowner",
    "/reset",
    // 移除/禁用权限继承 — 可导致系统目录权限断裂
    "/inheritance:r",
    "/inheritance:e",
];

// ==================== wmic 写入子命令 ====================

/// wmic 写入性子命令关键字
///
/// wmic 本身有不少只读查询场景（如 wmic os get caption），
/// 完全禁止过于激进。仅当 wmic 与写入性子命令组合时阻断。
const WMIC_WRITE_KEYWORDS: &[&str] = &["delete", "create", " set ", "call "];

// ==================== 写入重定向关键字 ====================

/// Shell 输出重定向和文件写入命令关键字
///
/// 当命令包含这些模式且目标路径命中自定义保护目录时触发阻断。
/// 覆盖 cmd 重定向、PowerShell 文件写入 cmdlet 等常见场景。
const WRITE_REDIRECT_PATTERNS: &[&str] = &[
    // cmd 重定向操作符（需放在前面，>> 优先于 > 检测）
    ">>",
    ">",
    // PowerShell 文件写入 cmdlet
    "out-file",
    "set-content",
    "add-content",
    // PowerShell 重定向别名
    "tee-object",
    // copy/move 到保护目录也应阻断
    "copy-item",
    "move-item",
];

// ==================== format 命令精确检测 ====================

/// 检测是否为 format 磁盘命令
///
/// 精确匹配 `format X:` 模式（X 为盘符），避免误报编程语言的 format 函数。
/// 例如 `python -c "'{}'.format('hello')"` 不应被拦截。
fn is_format_drive_command(lower: &str) -> bool {
    // 查找所有 "format" 出现的位置
    let mut search_from = 0;
    while let Some(pos) = lower[search_from..].find("format") {
        let abs_pos = search_from + pos;
        let after = &lower[abs_pos + 6..];
        // format 后应跟空格再跟盘符冒号，如 "format c:" 或 "format d: /fs:ntfs"
        let trimmed = after.trim_start();
        if trimmed.len() >= 2 {
            let bytes = trimmed.as_bytes();
            if bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
                return true;
            }
        }
        search_from = abs_pos + 6;
    }
    false
}

// ==================== 自定义保护目录 ====================

/// 缓存自定义保护路径，使用 RwLock 支持热更新
///
/// 首次调用 `load_custom_protected_paths` 时从磁盘加载并缓存；
/// `set_protected_paths` 命令写入文件后，调用 `reload_custom_protected_paths` 刷新缓存。
/// None 表示尚未加载，Some(vec) 为已缓存的路径列表。
static CUSTOM_PROTECTED_PATHS: RwLock<Option<Vec<String>>> = RwLock::new(None);

/// 从应用数据目录加载用户自定义的保护路径（带全局缓存）
///
/// 配置文件路径: {app_data_dir}/protected_paths.json
/// 格式: JSON 字符串数组 ["D:\\重要备份", "E:\\项目存档"]
/// 文件不存在时返回空列表（不报错）
fn load_custom_protected_paths(app_data_dir: &Path) -> Vec<String> {
    // 快速读取路径：如果缓存已存在，直接返回克隆
    {
        let guard = CUSTOM_PROTECTED_PATHS
            .read()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(ref paths) = *guard {
            return paths.clone();
        }
    }

    // 缓存未初始化，从磁盘加载并写入缓存
    let paths = read_protected_paths_from_disk(app_data_dir);
    {
        let mut guard = CUSTOM_PROTECTED_PATHS
            .write()
            .unwrap_or_else(|e| e.into_inner());
        *guard = Some(paths.clone());
    }
    paths
}

/// 从磁盘读取 protected_paths.json（纯 I/O，不涉及缓存）
pub fn read_protected_paths_from_disk(app_data_dir: &Path) -> Vec<String> {
    let config_path = app_data_dir.join("protected_paths.json");

    match std::fs::read_to_string(&config_path) {
        Ok(content) => match serde_json::from_str::<Vec<String>>(&content) {
            Ok(paths) => {
                if !paths.is_empty() {
                    log::debug!("[CommandValidator] 加载了 {} 个自定义保护路径", paths.len());
                }
                paths
            }
            Err(e) => {
                log::warn!("[CommandValidator] ⚠️ protected_paths.json 解析失败: {}", e);
                Vec::new()
            }
        },
        // 文件不存在是正常情况，静默忽略
        Err(_) => Vec::new(),
    }
}

/// 刷新自定义保护路径缓存
///
/// 在 `set_protected_paths` Tauri 命令写入文件后调用，
/// 使后续 `validate_command_safety` 立即使用最新路径列表。
pub fn reload_custom_protected_paths(app_data_dir: &Path) {
    let paths = read_protected_paths_from_disk(app_data_dir);
    let mut guard = CUSTOM_PROTECTED_PATHS
        .write()
        .unwrap_or_else(|e| e.into_inner());
    *guard = Some(paths);
    log::debug!("[CommandValidator] 自定义保护路径缓存已刷新");
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

fn normalize_path_for_compare(path: &Path) -> String {
    let normalized = normalize_path_lexically(path);
    let mut value = normalized
        .to_string_lossy()
        .to_lowercase()
        .replace('/', "\\");

    while value.len() > 3 && value.ends_with('\\') {
        value.pop();
    }

    value
}

fn path_matches_protected_path(path: &Path, protected: &str) -> bool {
    let file_str = normalize_path_for_compare(path);
    let protected_normalized = normalize_path_for_compare(Path::new(protected));

    if file_str.starts_with(&protected_normalized) {
        let after = &file_str[protected_normalized.len()..];
        return after.is_empty() || after.starts_with('\\') || after.starts_with('/');
    }

    false
}

fn find_matching_custom_protected_path<'a>(
    path: &Path,
    custom_paths: &'a [String],
) -> Option<&'a str> {
    custom_paths
        .iter()
        .find(|protected| path_matches_protected_path(path, protected))
        .map(String::as_str)
}

fn resolve_target_path(target: &str, workdir: Option<&Path>) -> PathBuf {
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

fn quote_closer(ch: char) -> Option<char> {
    match ch {
        '\'' => Some('\''),
        '"' => Some('"'),
        '\u{2018}' => Some('\u{2019}'),
        '\u{201C}' => Some('\u{201D}'),
        _ => None,
    }
}

fn split_shell_tokens(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;

    for ch in input.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => current.push(ch),
            None if quote_closer(ch).is_some() => quote = quote_closer(ch),
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            None => current.push(ch),
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

fn is_script_extension(path: &str, extensions: &[&str]) -> bool {
    let lower = path.to_lowercase();
    extensions.iter().any(|ext| lower.ends_with(ext))
}

fn token_command_name(token: &str) -> String {
    let mut name = Path::new(token)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(token)
        .to_lowercase();

    if name.ends_with(".exe") {
        name.truncate(name.len() - ".exe".len());
    }

    name
}

fn collect_after_shell_command(tokens: &[String], command_names: &[&str]) -> Vec<String> {
    let Some(first) = tokens.first() else {
        return Vec::new();
    };

    if !command_names
        .iter()
        .any(|name| token_command_name(first) == *name)
    {
        return Vec::new();
    }

    tokens
        .iter()
        .skip(1)
        .filter(|token| {
            let lower = token.to_lowercase();
            !(lower.starts_with('/') || lower.starts_with('-'))
        })
        .cloned()
        .collect()
}

fn expand_powershell_command_tokens(tokens: &[String]) -> Vec<String> {
    let mut expanded = Vec::new();
    let mut expect_command = false;

    for token in tokens {
        if expect_command {
            expanded.extend(split_shell_tokens(token));
            expect_command = false;
            continue;
        }

        let lower = token.to_lowercase();
        if matches!(lower.as_str(), "-command" | "-c") {
            expect_command = true;
            continue;
        }

        expanded.push(token.clone());
    }

    expanded
}

fn collect_after_powershell_command(tokens: &[String], command_names: &[&str]) -> Vec<String> {
    let expanded_tokens = expand_powershell_command_tokens(tokens);
    let tokens = expanded_tokens.as_slice();

    let Some((index, _)) = tokens.iter().enumerate().find(|(_, token)| {
        let name = token.to_lowercase();
        command_names.iter().any(|expected| name == *expected)
    }) else {
        return Vec::new();
    };

    let mut targets = Vec::new();
    let mut expect_path_value = false;
    for token in tokens.iter().skip(index + 1) {
        let lower = token.to_lowercase();
        if expect_path_value {
            targets.extend(split_comma_separated_paths(token));
            expect_path_value = false;
            continue;
        }

        if matches!(lower.as_str(), "-path" | "-literalpath" | "-filepath") {
            expect_path_value = true;
            continue;
        }

        if lower.starts_with('-') {
            continue;
        }

        targets.extend(split_comma_separated_paths(token));
    }

    targets
}

fn split_comma_separated_paths(token: &str) -> Vec<String> {
    token
        .split(',')
        .map(|part| {
            part.trim()
                .trim_matches(|c| c == '\'' || c == '"')
                .to_string()
        })
        .filter(|part| !part.is_empty())
        .collect()
}

fn powershell_write_parameter_consumes_value(parameter: &str) -> bool {
    matches!(
        parameter,
        "-value"
            | "-inputobject"
            | "-encoding"
            | "-width"
            | "-stream"
            | "-filter"
            | "-include"
            | "-exclude"
            | "-credential"
            | "-variable"
    )
}

fn destructive_target_tokens(command: &str) -> Vec<String> {
    let tokens = split_shell_tokens(command);
    let mut targets = collect_after_shell_command(&tokens, &["del", "erase", "rmdir", "rd"]);
    if targets.is_empty() {
        targets = collect_after_powershell_command(&tokens, &["remove-item", "ri", "rm"]);
    }
    targets
}

fn collect_powershell_write_targets(tokens: &[String]) -> Vec<String> {
    let expanded_tokens = expand_powershell_command_tokens(tokens);
    let mut targets = Vec::new();

    for (index, token) in expanded_tokens.iter().enumerate() {
        let command_name = token.to_lowercase();
        if !matches!(
            command_name.as_str(),
            "out-file" | "set-content" | "add-content" | "tee-object"
        ) {
            continue;
        }

        let mut expect_path_value = false;
        let mut skip_parameter_value = false;
        let mut consumed_positional_path = false;
        for token in expanded_tokens.iter().skip(index + 1) {
            let lower = token.to_lowercase();
            if matches!(lower.as_str(), "|" | ";" | "&&" | "||") {
                break;
            }

            if expect_path_value {
                targets.extend(split_comma_separated_paths(token));
                expect_path_value = false;
                consumed_positional_path = true;
                continue;
            }

            if skip_parameter_value {
                skip_parameter_value = false;
                continue;
            }

            if matches!(lower.as_str(), "-path" | "-literalpath" | "-filepath") {
                expect_path_value = true;
                continue;
            }

            if lower.starts_with('-') {
                if powershell_write_parameter_consumes_value(lower.as_str()) {
                    skip_parameter_value = true;
                }
                continue;
            }

            if !consumed_positional_path {
                targets.extend(split_comma_separated_paths(token));
                consumed_positional_path = true;
            }
        }
    }

    targets
}

fn write_target_tokens(command: &str) -> Vec<String> {
    let tokens = split_shell_tokens(command);
    let mut targets = Vec::new();

    for (index, token) in tokens.iter().enumerate() {
        let lower = token.to_lowercase();
        if lower == ">" || lower == ">>" {
            if let Some(next) = tokens.get(index + 1) {
                targets.push(next.clone());
            }
        } else if lower.starts_with(">>") && token.len() > 2 {
            targets.push(token[2..].to_string());
        } else if lower.starts_with('>') && token.len() > 1 {
            targets.push(token[1..].to_string());
        }
    }

    targets.extend(collect_powershell_write_targets(&tokens));

    for command_name in ["copy-item", "move-item"] {
        let candidates = collect_after_powershell_command(&tokens, &[command_name]);
        if let Some(last) = candidates.last() {
            targets.push(last.clone());
        }
    }

    targets
}

// ==================== 公开接口 ====================

/// 校验命令安全性
///
/// 在 shell_execute 执行命令前调用，作为最后一道防线。
/// 返回 Ok(()) 表示命令可执行，Err(AppError::Forbidden) 表示阻断。
///
/// 检查顺序：
/// 1. 绝对禁止命令黑名单 — 无条件阻断
/// 2. format 磁盘命令 — 精确检测盘符模式
/// 3. wmic + 写入子命令 — 组合阻断（只读查询放行）
/// 4. icacls + 修改参数 + 核心目录 — 组合阻断
/// 5. 破坏性动词 + 核心/自定义保护目录 — 组合阻断
pub fn validate_command_safety(command: &str, app_data_dir: &Path) -> Result<(), AppError> {
    validate_command_safety_with_workdir(command, app_data_dir, None)
}

/// 校验命令安全性，并使用实际工作目录解析相对目标路径。
///
/// `shell_execute` 应优先调用此入口，确保 `del file.txt`、`echo > file.txt`
/// 这类相对路径操作按真实执行目录判断是否落入自定义保护目录。
pub fn validate_command_safety_with_workdir(
    command: &str,
    app_data_dir: &Path,
    workdir: Option<&Path>,
) -> Result<(), AppError> {
    let lower = command.to_lowercase();

    // 1. 绝对禁止命令 — 无条件阻断
    for forbidden in FORBIDDEN_COMMANDS {
        if lower.contains(forbidden) {
            let reason = format!(
                "Safety block: forbidden command keyword '{}' was detected. This command was blocked by the system safety policy.",
                forbidden.trim()
            );
            log::warn!("[CommandValidator] {}", reason);
            return Err(AppError::Forbidden(reason));
        }
    }

    // 2. format 磁盘命令 — 精确检测 "format X:" 模式
    // 从黑名单列表中分离出来，避免 str.format() 等编程语言模式误报
    if is_format_drive_command(&lower) {
        let reason =
            "Safety block: disk formatting command (format) was detected. This command was blocked by the system safety policy."
                .to_string();
        log::warn!("[CommandValidator] {}", reason);
        return Err(AppError::Forbidden(reason));
    }

    // 3. wmic + 写入子命令 — 组合阻断
    // wmic 只读查询（如 wmic os get caption）放行，写入操作阻断
    if lower.contains("wmic") {
        let has_write_keyword = WMIC_WRITE_KEYWORDS.iter().any(|kw| lower.contains(kw));
        if has_write_keyword {
            let reason = "Safety block: wmic write/modify operations are blocked.".to_string();
            log::warn!("[CommandValidator] {}", reason);
            return Err(AppError::Forbidden(reason));
        }
    }

    // 4. icacls/cacls + ACL 修改参数 + 核心目录 — 组合阻断
    // cacls 是 icacls 的前身，功能类似但参数略有不同，需同等对待
    let is_acl_command = lower.contains("icacls") || lower.contains("cacls");
    if is_acl_command {
        let has_modify_param = ACL_MODIFY_KEYWORDS.iter().any(|kw| lower.contains(kw));
        // cacls 使用 /G（grant）、/R（revoke）、/P（replace）、/D（deny）等参数
        let has_cacls_modify = lower.contains("/g ")
            || lower.contains("/r ")
            || lower.contains("/p ")
            || lower.contains("/d ");
        let targets_protected = PROTECTED_PATHS.iter().any(|path| lower.contains(path));

        if (has_modify_param || has_cacls_modify) && targets_protected {
            let reason =
                "Safety block: changing file permissions on system-protected directories is blocked (icacls/cacls).".to_string();
            log::warn!("[CommandValidator] {}", reason);
            return Err(AppError::Forbidden(reason));
        }
    }

    // 4.5 Set-Acl + 核心目录 — PowerShell ACL 修改阻断
    // Set-Acl 是 PowerShell 原生的 ACL 修改 cmdlet，与 icacls 功能等价
    if lower.contains("set-acl") {
        let targets_protected = PROTECTED_PATHS.iter().any(|path| lower.contains(path));
        if targets_protected {
            let reason =
                "Safety block: changing file permissions on system-protected directories is blocked (Set-Acl).".to_string();
            log::warn!("[CommandValidator] {}", reason);
            return Err(AppError::Forbidden(reason));
        }
    }

    // 5. 破坏性动词 + 保护目录 — 组合阻断
    let has_destructive_verb = DESTRUCTIVE_VERBS.iter().any(|verb| lower.contains(verb));

    if has_destructive_verb {
        // 检查核心保护目录
        let targets_core_protected = PROTECTED_PATHS.iter().any(|path| lower.contains(path));

        if targets_core_protected {
            let reason =
                "Safety block: destructive operations on system core directories are blocked."
                    .to_string();
            log::warn!("[CommandValidator] {}", reason);
            return Err(AppError::Forbidden(reason));
        }

        let custom_paths = load_custom_protected_paths(app_data_dir);
        for custom_path in &custom_paths {
            if lower.contains(&custom_path.to_lowercase()) {
                let reason = format!(
                    "Safety block: destructive operations on custom protected directory '{}' are blocked.",
                    custom_path
                );
                log::warn!("[CommandValidator] {}", reason);
                return Err(AppError::Forbidden(reason));
            }
        }

        for target in destructive_target_tokens(command) {
            let resolved = resolve_target_path(&target, workdir);
            if let Some(custom_path) = find_matching_custom_protected_path(&resolved, &custom_paths)
            {
                let reason = format!(
                    "Safety block: destructive operations on custom protected directory '{}' are blocked.",
                    custom_path
                );
                log::warn!("[CommandValidator] {}", reason);
                return Err(AppError::Forbidden(reason));
            }
        }
    }

    // 6. 写入重定向 + 自定义保护目录 — 组合阻断
    // 检测 echo > file、Out-File、Set-Content 等写入模式是否指向保护路径
    let has_write_redirect = WRITE_REDIRECT_PATTERNS
        .iter()
        .any(|pattern| lower.contains(pattern));

    if has_write_redirect {
        let custom_paths = load_custom_protected_paths(app_data_dir);
        for custom_path in &custom_paths {
            if lower.contains(&custom_path.to_lowercase()) {
                let reason = format!(
                    "Safety block: writing content to custom protected directory '{}' is blocked.",
                    custom_path
                );
                log::warn!("[CommandValidator] {}", reason);
                return Err(AppError::Forbidden(reason));
            }
        }

        for target in write_target_tokens(command) {
            let resolved = resolve_target_path(&target, workdir);
            if let Some(custom_path) = find_matching_custom_protected_path(&resolved, &custom_paths)
            {
                let reason = format!(
                    "Safety block: writing content to custom protected directory '{}' is blocked.",
                    custom_path
                );
                log::warn!("[CommandValidator] {}", reason);
                return Err(AppError::Forbidden(reason));
            }
        }
    }

    Ok(())
}

// ==================== 文件写入路径保护 ====================

/// 校验文件写入路径安全性
///
/// 在 `file_write_to_path` Tauri 命令中调用，
/// 检查目标文件是否位于用户自定义保护目录之下。
/// 使用路径前缀匹配（`starts_with`）确保子目录也受保护。
///
/// # Arguments
/// * `file_path` - 要写入的目标文件路径
/// * `app_data_dir` - 应用数据目录（用于加载 protected_paths.json）
pub fn validate_path_write_safety(file_path: &Path, app_data_dir: &Path) -> Result<(), AppError> {
    let custom_paths = load_custom_protected_paths(app_data_dir);
    if custom_paths.is_empty() {
        return Ok(());
    }

    // 规范化路径分隔符为统一小写格式，确保跨大小写匹配
    let file_str = file_path
        .to_string_lossy()
        .to_lowercase()
        .replace('/', "\\");

    for protected in &custom_paths {
        let protected_normalized = protected.to_lowercase().replace('/', "\\");

        // 路径前缀匹配：文件路径必须以保护目录开头
        // 额外检查分隔符边界，避免 "D:\\important" 误匹配 "D:\\important_other"
        if file_str.starts_with(&protected_normalized) {
            let after = &file_str[protected_normalized.len()..];
            // 完全匹配或紧跟路径分隔符
            if after.is_empty() || after.starts_with('\\') || after.starts_with('/') {
                let reason = format!(
                    "Safety block: writing files to protected directory '{}' is blocked.",
                    protected
                );
                log::warn!("[CommandValidator] {}", reason);
                return Err(AppError::Forbidden(reason));
            }
        }
    }

    Ok(())
}

// ==================== 脚本内容扫描 ====================

/// 可扫描的脚本文件扩展名
const SCANNABLE_EXTENSIONS: &[&str] = &[".ps1", ".bat", ".cmd", ".py", ".cs", ".vbs"];

/// 脚本内容专用黑名单关键字
///
/// 从 FORBIDDEN_COMMANDS 中筛选出适用于脚本内容检查的关键字。
/// 排除了仅在命令行上下文有意义的关键字（如 `-enc`、`setx /m`），
/// 保留在脚本源码中出现时必定危险的 API 调用。
const SCRIPT_CONTENT_FORBIDDEN: &[&str] = &[
    // .NET API — 永久修改系统/用户级环境变量
    // 同时覆盖 PowerShell 语法 (::SetEnvironmentVariable) 和 C# 语法 (.SetEnvironmentVariable)
    "setenvironmentvariable",
    // 注册表系统环境变量路径
    "session manager\\environment",
    // 系统核心命令 — 在脚本内调用同样危险
    "diskpart",
    "bcdedit",
    "cipher /w",
    "takeown",
    "sfc /",
    "net user",
    "sc delete",
    "reg delete",
    "reg add hklm",
];

/// 从命令中提取脚本文件路径
///
/// 识别多种脚本执行模式：
/// - `powershell -File script.ps1` / `pwsh -File script.ps1`
/// - `python script.py` / `python3 script.py`
/// - `csc.exe source.cs`（编译源码，需检查源码内容）
/// - 直接执行：`script.bat`、`./script.ps1` 等
fn extract_script_path(command: &str) -> Option<String> {
    let tokens = split_shell_tokens(command);

    if tokens.is_empty() {
        return None;
    }

    // 模式1: powershell/pwsh -File script.ps1
    let invokes_powershell = tokens.iter().any(|token| {
        let name = token_command_name(token);
        name == "powershell" || name == "pwsh"
    });
    if invokes_powershell {
        for (i, part) in tokens.iter().enumerate() {
            if part.eq_ignore_ascii_case("-file") {
                if let Some(path) = tokens.get(i + 1) {
                    return Some(path.to_string());
                }
            }
        }
    }

    // 模式2: python/python3 script.py
    let first_command = token_command_name(&tokens[0]);
    if first_command == "python"
        || first_command == "python3"
        || first_command == "py"
        || first_command.starts_with("python")
    {
        for part in &tokens[1..] {
            // 跳过 python 选项参数（-c, -m, --version 等）
            if part.starts_with('-') {
                continue;
            }
            if is_script_extension(part, &[".py"]) {
                return Some(part.to_string());
            }
        }
    }

    // 模式3: csc.exe source.cs（C# 编译器，需检查源码）
    let invokes_csc = tokens
        .iter()
        .any(|token| token_command_name(token) == "csc");
    if invokes_csc {
        for part in &tokens {
            if is_script_extension(part, &[".cs"]) {
                return Some(part.to_string());
            }
        }
    }

    // 模式4: 直接执行脚本文件
    let first = tokens[0].trim_start_matches("./").trim_start_matches(".\\");
    if is_script_extension(first, SCANNABLE_EXTENSIONS) {
        return Some(first.to_string());
    }

    None
}

/// 扫描脚本文件内容是否包含危险 API 调用
///
/// 在 exec 执行脚本前调用，读取脚本文件内容并检查是否包含
/// SCRIPT_CONTENT_FORBIDDEN 中的黑名单关键字。
///
/// 设计决策：
/// - 使用独立的 SCRIPT_CONTENT_FORBIDDEN 而非复用 FORBIDDEN_COMMANDS，
///   避免 `-enc`、`setx /m` 等命令行专用关键字在脚本源码中误报
/// - 文件读取失败时静默放行（文件可能尚未创建或路径无效）
/// - 仅扫描文本格式的脚本文件，二进制文件无法扫描
pub fn validate_script_content(command: &str, workdir: Option<&str>) -> Result<(), AppError> {
    // 从命令中提取脚本路径
    let script_path = match extract_script_path(command) {
        Some(p) => p,
        None => return Ok(()), // 非脚本执行命令，跳过
    };

    // 解析完整路径（多方尝试，确保能找到文件）
    let candidates: Vec<std::path::PathBuf> = {
        let mut paths = Vec::new();
        let script = std::path::Path::new(&script_path);

        if script.is_absolute() {
            // 绝对路径直接使用
            paths.push(script.to_path_buf());
        } else {
            // 相对路径：优先 workdir，再尝试当前目录
            if let Some(wd) = workdir {
                paths.push(std::path::Path::new(wd).join(&script_path));
            }
            // 回退：当前进程工作目录
            if let Ok(cwd) = std::env::current_dir() {
                paths.push(cwd.join(&script_path));
            }
            // 最终回退：原始路径
            paths.push(script.to_path_buf());
        }
        paths
    };

    // 读取脚本内容（依次尝试所有候选路径）
    let mut content = None;
    let mut tried_paths = Vec::new();
    for path in &candidates {
        tried_paths.push(path.display().to_string());
        if let Ok(c) = std::fs::read_to_string(path) {
            log::debug!(
                "[CommandValidator] 脚本文件已读取: {} ({} 字符)",
                path.display(),
                c.len()
            );
            content = Some(c);
            break;
        }
    }

    let content = match content {
        Some(c) => c,
        None => {
            log::debug!(
                "[CommandValidator] 脚本文件在所有候选路径均未找到，跳过内容扫描: {:?} (命令: {})",
                tried_paths,
                command,
            );
            return Ok(());
        }
    };

    let lower_content = content.to_lowercase();

    // 对脚本内容跑黑名单检查
    for forbidden in SCRIPT_CONTENT_FORBIDDEN {
        if lower_content.contains(forbidden) {
            let reason = format!(
                "Safety block: dangerous API call '{}' was detected in script file '{}'. Script execution was blocked.",
                forbidden.trim(),
                script_path
            );
            log::warn!("[CommandValidator] {}", reason);
            return Err(AppError::Forbidden(reason));
        }
    }

    log::debug!("[CommandValidator] 脚本内容扫描通过: {}", script_path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::{Mutex, MutexGuard};

    static CUSTOM_PROTECTED_PATHS_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn lock_custom_protected_paths() -> MutexGuard<'static, ()> {
        CUSTOM_PROTECTED_PATHS_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// 测试用临时目录（不含 protected_paths.json）
    fn test_app_dir() -> PathBuf {
        std::env::temp_dir().join("agentvis_cmd_validator_test")
    }

    fn reset_custom_protected_paths() {
        let mut guard = CUSTOM_PROTECTED_PATHS
            .write()
            .unwrap_or_else(|e| e.into_inner());
        *guard = None;
    }

    // ── 绝对禁止命令 ──

    #[test]
    fn test_forbidden_diskpart() {
        let dir = test_app_dir();
        assert!(validate_command_safety("diskpart", &dir).is_err());
    }

    #[test]
    fn test_forbidden_format() {
        let dir = test_app_dir();
        assert!(validate_command_safety("format D:", &dir).is_err());
    }

    #[test]
    fn test_forbidden_bcdedit() {
        let dir = test_app_dir();
        assert!(validate_command_safety("bcdedit /set", &dir).is_err());
    }

    #[test]
    fn test_forbidden_reg_delete() {
        let dir = test_app_dir();
        assert!(validate_command_safety("reg delete HKCU\\Software\\Test", &dir).is_err());
    }

    #[test]
    fn test_forbidden_encoded_command() {
        let dir = test_app_dir();
        assert!(validate_command_safety("powershell -EncodedCommand dABlAHMAdA==", &dir).is_err());
    }

    #[test]
    fn test_forbidden_enc_short_form() {
        let dir = test_app_dir();
        assert!(validate_command_safety("powershell -enc dABlAHMAdA==", &dir).is_err());
    }

    #[test]
    fn test_forbidden_setx_system_level() {
        let dir = test_app_dir();
        assert!(validate_command_safety("setx /M PATH \"C:\\new\"", &dir).is_err());
    }

    #[test]
    fn test_forbidden_reg_add_hklm() {
        let dir = test_app_dir();
        assert!(validate_command_safety(
            "reg add HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
            &dir
        )
        .is_err());
    }

    #[test]
    fn test_forbidden_env_set_via_dotnet_api() {
        let dir = test_app_dir();
        // .NET API 修改系统级环境变量应被阻断
        assert!(validate_command_safety(
            r#"powershell -Command "[Environment]::SetEnvironmentVariable('PATH','C:\new','Machine')""#,
            &dir
        ).is_err());
        // [System.Environment] 前缀的变体
        assert!(validate_command_safety(
            r#"powershell -Command "[System.Environment]::SetEnvironmentVariable('MY_VAR','value','User')""#,
            &dir
        ).is_err());
    }

    #[test]
    fn test_forbidden_env_set_via_registry_path() {
        let dir = test_app_dir();
        // 通过注册表路径修改系统级环境变量应被阻断
        assert!(validate_command_safety(
            r#"powershell -Command "Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name 'PATH' -Value 'C:\new'""#,
            &dir
        ).is_err());
        // New-ItemProperty 变体
        assert!(validate_command_safety(
            r#"powershell -Command "New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name 'MY_VAR'""#,
            &dir
        ).is_err());
    }

    #[test]
    fn test_env_read_operations_pass() {
        let dir = test_app_dir();
        // 只读环境变量查询应放行
        assert!(
            validate_command_safety(r#"powershell -Command "$env:PATH -split ';'""#, &dir).is_ok()
        );
        // GetEnvironmentVariable 只读查询应放行
        assert!(validate_command_safety(
            r#"powershell -Command "[Environment]::GetEnvironmentVariable('PATH','Machine')""#,
            &dir
        )
        .is_ok());
    }

    #[test]
    fn test_forbidden_net_user() {
        let dir = test_app_dir();
        assert!(validate_command_safety("net user hacker P@ss /add", &dir).is_err());
    }

    #[test]
    fn test_forbidden_sc_delete() {
        let dir = test_app_dir();
        assert!(validate_command_safety("sc delete MyService", &dir).is_err());
    }

    #[test]
    fn test_wmic_write_blocked() {
        let dir = test_app_dir();
        // wmic + 写入子命令应被阻断
        assert!(validate_command_safety("wmic process delete", &dir).is_err());
        assert!(validate_command_safety("wmic service call create", &dir).is_err());
    }

    #[test]
    fn test_wmic_readonly_pass() {
        let dir = test_app_dir();
        // wmic 只读查询应放行
        assert!(validate_command_safety("wmic os get caption", &dir).is_ok());
        assert!(validate_command_safety("wmic cpu get name", &dir).is_ok());
    }

    #[test]
    fn test_forbidden_cipher_wipe() {
        let dir = test_app_dir();
        assert!(validate_command_safety("cipher /w:C:\\", &dir).is_err());
    }

    #[test]
    fn test_forbidden_takeown() {
        let dir = test_app_dir();
        assert!(validate_command_safety("takeown /f C:\\Windows\\file.dll", &dir).is_err());
    }

    #[test]
    fn test_forbidden_case_insensitive() {
        let dir = test_app_dir();
        // 大小写混合应同样拦截
        assert!(validate_command_safety("DISKPART", &dir).is_err());
        assert!(validate_command_safety("DiskPart", &dir).is_err());
        assert!(validate_command_safety("REG DELETE HKCU\\test", &dir).is_err());
    }

    // ── 破坏性命令 + 核心目录 ──

    #[test]
    fn test_del_windows_blocked() {
        let dir = test_app_dir();
        assert!(validate_command_safety("del C:\\Windows\\temp.log", &dir).is_err());
    }

    #[test]
    fn test_rmdir_program_files_blocked() {
        let dir = test_app_dir();
        assert!(validate_command_safety("rmdir /s /q \"C:\\Program Files\\App\"", &dir).is_err());
    }

    #[test]
    fn test_remove_item_system32_blocked() {
        let dir = test_app_dir();
        assert!(validate_command_safety(
            "powershell -Command \"Remove-Item C:\\Windows\\System32\\file.dll\"",
            &dir
        )
        .is_err());
    }

    #[test]
    fn test_del_env_var_path_blocked() {
        let dir = test_app_dir();
        assert!(validate_command_safety("del %SystemRoot%\\temp.log", &dir).is_err());
    }

    #[test]
    fn test_erase_syswow64_blocked() {
        let dir = test_app_dir();
        assert!(validate_command_safety("erase C:\\Windows\\SysWOW64\\file", &dir).is_err());
    }

    // ── 正常命令应放行 ──

    #[test]
    fn test_safe_commands_pass() {
        let dir = test_app_dir();
        assert!(validate_command_safety("git status", &dir).is_ok());
        assert!(validate_command_safety("dir C:\\Users\\Admin", &dir).is_ok());
        assert!(validate_command_safety("npm run build", &dir).is_ok());
        assert!(validate_command_safety("cargo test", &dir).is_ok());
        assert!(validate_command_safety("ping 127.0.0.1", &dir).is_ok());
        assert!(validate_command_safety("node -v", &dir).is_ok());
    }

    #[test]
    fn test_format_drive_blocked() {
        let dir = test_app_dir();
        // format + 盘符应被阻断
        assert!(validate_command_safety("format D:", &dir).is_err());
        assert!(validate_command_safety("format C: /fs:ntfs", &dir).is_err());
        assert!(validate_command_safety("FORMAT E:", &dir).is_err());
    }

    #[test]
    fn test_format_non_drive_pass() {
        let dir = test_app_dir();
        // 编程语言中的 format 不应被拦截
        assert!(validate_command_safety("python -c \"'{}'.format('hello')\"", &dir).is_ok());
        assert!(validate_command_safety("echo format string test", &dir).is_ok());
    }

    #[test]
    fn test_del_user_project_dir_pass() {
        // 在非保护目录删除文件应该允许通过（由上层 Checkpoint 管控）
        let dir = test_app_dir();
        assert!(validate_command_safety("del F:\\project\\temp.log", &dir).is_ok());
    }

    #[test]
    fn test_rmdir_user_dir_pass() {
        let dir = test_app_dir();
        assert!(validate_command_safety("rmdir /s /q F:\\project\\dist", &dir).is_ok());
    }

    #[test]
    fn test_setx_user_level_pass() {
        // 用户级 setx（不带 /M）应该允许通过（由上层 Checkpoint 管控）
        let dir = test_app_dir();
        assert!(validate_command_safety("setx MY_VAR value", &dir).is_ok());
    }

    // ── icacls 组合检测 ──

    #[test]
    fn test_icacls_modify_system_dir_blocked() {
        let dir = test_app_dir();
        assert!(
            validate_command_safety("icacls C:\\Windows\\System32 /grant Everyone:F", &dir)
                .is_err()
        );
    }

    #[test]
    fn test_icacls_view_only_pass() {
        // icacls 仅查看权限（不含修改参数）应放行
        let dir = test_app_dir();
        assert!(validate_command_safety("icacls C:\\Windows\\file.dll", &dir).is_ok());
    }

    #[test]
    fn test_icacls_modify_user_dir_pass() {
        // icacls 修改非核心目录应放行
        let dir = test_app_dir();
        assert!(validate_command_safety("icacls F:\\project\\output /grant User:F", &dir).is_ok());
    }

    #[test]
    fn test_cacls_modify_system_dir_blocked() {
        // cacls（icacls 前身）+ 系统目录应被阻断
        let dir = test_app_dir();
        assert!(
            validate_command_safety("cacls C:\\Windows\\System32 /G Everyone:F", &dir).is_err()
        );
    }

    #[test]
    fn test_icacls_inheritance_remove_blocked() {
        // 移除系统目录权限继承应被阻断
        let dir = test_app_dir();
        assert!(
            validate_command_safety("icacls C:\\Windows\\System32 /inheritance:r", &dir).is_err()
        );
    }

    #[test]
    fn test_set_acl_system_dir_blocked() {
        // PowerShell Set-Acl + 系统目录应被阻断
        let dir = test_app_dir();
        assert!(validate_command_safety(
            r#"powershell -Command "$acl = Get-Acl 'C:\Windows\System32'; Set-Acl -Path 'C:\Windows\System32' -AclObject $acl""#,
            &dir
        ).is_err());
    }

    #[test]
    fn test_set_acl_user_dir_pass() {
        // Set-Acl 修改非系统目录应放行
        let dir = test_app_dir();
        assert!(validate_command_safety(
            r#"powershell -Command "Set-Acl -Path 'F:\project\output' -AclObject $acl""#,
            &dir
        )
        .is_ok());
    }

    #[test]
    fn test_get_acl_readonly_pass() {
        // Get-Acl 只读查询应放行（即使目标是系统目录）
        let dir = test_app_dir();
        assert!(validate_command_safety(
            r#"powershell -Command "Get-Acl 'C:\Windows\System32'""#,
            &dir
        )
        .is_ok());
    }

    // ── 自定义保护目录 ──

    #[test]
    fn test_custom_protected_paths() {
        let _guard = lock_custom_protected_paths();
        // 创建临时配置文件
        let dir = std::env::temp_dir().join("agentvis_custom_path_test");
        let _ = std::fs::create_dir_all(&dir);
        let config = dir.join("protected_paths.json");
        std::fs::write(
            &config,
            r#"["D:\\important_backup", "E:\\project_archive"]"#,
        )
        .unwrap();

        // 刷新 RwLock 缓存，使测试数据生效
        reload_custom_protected_paths(&dir);

        // 删除自定义保护目录应被阻断
        assert!(validate_command_safety("del D:\\important_backup\\file.txt", &dir).is_err());
        assert!(validate_command_safety("rmdir E:\\project_archive\\old", &dir).is_err());

        // 删除非保护目录应放行
        assert!(validate_command_safety("del F:\\temp\\file.txt", &dir).is_ok());

        // 清理文件系统 + 重置缓存（避免影响其他测试）
        let _ = std::fs::remove_dir_all(&dir);
        {
            let mut guard = CUSTOM_PROTECTED_PATHS
                .write()
                .unwrap_or_else(|e| e.into_inner());
            *guard = None;
        }
    }

    #[test]
    fn test_custom_protected_relative_delete_with_workdir_blocked() {
        let _guard = lock_custom_protected_paths();
        let base = std::env::temp_dir().join("agentvis_custom_path_workdir_delete_test");
        let app_dir = base.join("app");
        let protected_dir = base.join("Protected Root");
        let outside_dir = base.join("outside");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&app_dir);
        let _ = std::fs::create_dir_all(&protected_dir);
        let _ = std::fs::create_dir_all(&outside_dir);

        let config = app_dir.join("protected_paths.json");
        let protected_paths = vec![protected_dir.to_string_lossy().to_string()];
        std::fs::write(&config, serde_json::to_string(&protected_paths).unwrap()).unwrap();
        reload_custom_protected_paths(&app_dir);

        assert!(validate_command_safety_with_workdir(
            "del secrets.txt",
            &app_dir,
            Some(&protected_dir),
        )
        .is_err());
        assert!(
            validate_command_safety_with_workdir("rmdir old", &app_dir, Some(&protected_dir),)
                .is_err()
        );
        assert!(validate_command_safety_with_workdir(
            r#"powershell -Command "Remove-Item secrets.txt -Force""#,
            &app_dir,
            Some(&protected_dir),
        )
        .is_err());
        assert!(validate_command_safety_with_workdir(
            "del secrets.txt",
            &app_dir,
            Some(&outside_dir),
        )
        .is_ok());
        assert!(validate_command_safety_with_workdir(
            r#"powershell -Command "Remove-Item secrets.txt -Force""#,
            &app_dir,
            Some(&outside_dir),
        )
        .is_ok());

        let _ = std::fs::remove_dir_all(&base);
        reset_custom_protected_paths();
    }

    #[test]
    fn test_custom_protected_relative_redirect_with_workdir_blocked() {
        let _guard = lock_custom_protected_paths();
        let base = std::env::temp_dir().join("agentvis_custom_path_workdir_write_test");
        let app_dir = base.join("app");
        let protected_dir = base.join("Protected Root");
        let outside_dir = base.join("outside");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&app_dir);
        let _ = std::fs::create_dir_all(&protected_dir);
        let _ = std::fs::create_dir_all(&outside_dir);

        let config = app_dir.join("protected_paths.json");
        let protected_paths = vec![protected_dir.to_string_lossy().to_string()];
        std::fs::write(&config, serde_json::to_string(&protected_paths).unwrap()).unwrap();
        reload_custom_protected_paths(&app_dir);

        assert!(validate_command_safety_with_workdir(
            "echo hello > output.txt",
            &app_dir,
            Some(&protected_dir),
        )
        .is_err());
        assert!(validate_command_safety_with_workdir(
            r#"powershell -Command "Set-Content -Path output.txt -Value hello""#,
            &app_dir,
            Some(&protected_dir),
        )
        .is_err());
        assert!(validate_command_safety_with_workdir(
            "echo hello > output.txt",
            &app_dir,
            Some(&outside_dir),
        )
        .is_ok());
        assert!(validate_command_safety_with_workdir(
            r#"powershell -Command "Set-Content -Path output.txt -Value hello""#,
            &app_dir,
            Some(&outside_dir),
        )
        .is_ok());

        let _ = std::fs::remove_dir_all(&base);
        reset_custom_protected_paths();
    }

    // ── 脚本路径提取 ──

    #[test]
    fn test_extract_powershell_file() {
        assert_eq!(
            extract_script_path("powershell -File script.ps1"),
            Some("script.ps1".to_string())
        );
        assert_eq!(
            extract_script_path("pwsh -File 'C:\\scripts\\run.ps1'"),
            Some("C:\\scripts\\run.ps1".to_string())
        );
        assert_eq!(
            extract_script_path(r#"powershell -File "C:\scripts with spaces\run.ps1""#),
            Some("C:\\scripts with spaces\\run.ps1".to_string())
        );
    }

    #[test]
    fn test_extract_python_script() {
        assert_eq!(
            extract_script_path("python script.py"),
            Some("script.py".to_string())
        );
        assert_eq!(
            extract_script_path("python3 -u my_script.py"),
            Some("my_script.py".to_string())
        );
        assert_eq!(
            extract_script_path(r#"python "C:\scripts with spaces\main.py""#),
            Some("C:\\scripts with spaces\\main.py".to_string())
        );
    }

    #[test]
    fn test_extract_csc_source() {
        assert_eq!(
            extract_script_path(
                r"C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe TestEnvVar.cs"
            ),
            Some("TestEnvVar.cs".to_string())
        );
        assert_eq!(
            extract_script_path(
                r#"C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe "C:\src with spaces\TestEnvVar.cs""#
            ),
            Some("C:\\src with spaces\\TestEnvVar.cs".to_string())
        );
    }

    #[test]
    fn test_extract_direct_script() {
        assert_eq!(
            extract_script_path("./setup.bat"),
            Some("setup.bat".to_string())
        );
        assert_eq!(
            extract_script_path("install.cmd"),
            Some("install.cmd".to_string())
        );
    }

    #[test]
    fn test_extract_no_script() {
        // 普通命令不应提取出脚本路径
        assert_eq!(extract_script_path("git status"), None);
        assert_eq!(extract_script_path("npm run build"), None);
        assert_eq!(
            extract_script_path("powershell -Command \"Get-Process\""),
            None
        );
    }

    // ── 脚本内容扫描 ──

    #[test]
    fn test_script_content_with_set_env_var_blocked() {
        // 创建包含 SetEnvironmentVariable 的临时脚本
        let dir = std::env::temp_dir().join("agentvis_script_scan_test");
        let _ = std::fs::create_dir_all(&dir);
        let script = dir.join("evil.ps1");
        std::fs::write(
            &script,
            r#"
            $path = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
            [Environment]::SetEnvironmentVariable('PATH', $path + ';D:\ollama', 'Machine')
        "#,
        )
        .unwrap();

        let result =
            validate_script_content(&format!("powershell -File {}", script.display()), None);
        assert!(result.is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_script_content_quoted_path_with_spaces_blocked() {
        let dir = std::env::temp_dir().join("agentvis script scan spaces test");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        let script = dir.join("evil script.ps1");
        std::fs::write(&script, "diskpart\n").unwrap();

        let result = validate_script_content(
            &format!(r#"powershell -File "{}""#, script.to_string_lossy()),
            None,
        );
        assert!(result.is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_script_content_with_cs_set_env_blocked() {
        // C# 源码包含 SetEnvironmentVariable 应被阻断
        let dir = std::env::temp_dir().join("agentvis_script_scan_cs_test");
        let _ = std::fs::create_dir_all(&dir);
        let script = dir.join("TestEnv.cs");
        std::fs::write(&script, r#"
            using System;
            class Program {
                static void Main() {
                    Environment.SetEnvironmentVariable("PATH", "C:\\new", EnvironmentVariableTarget.Machine);
                }
            }
        "#).unwrap();

        let result = validate_script_content(
            &format!(
                r"C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe {}",
                script.display()
            ),
            None,
        );
        assert!(result.is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_script_content_safe_script_pass() {
        // 安全脚本不应被阻断
        let dir = std::env::temp_dir().join("agentvis_script_scan_safe_test");
        let _ = std::fs::create_dir_all(&dir);
        let script = dir.join("safe.ps1");
        std::fs::write(
            &script,
            r#"
            Write-Host "Hello World"
            Get-Process | Select-Object Name, CPU
        "#,
        )
        .unwrap();

        let result =
            validate_script_content(&format!("powershell -File {}", script.display()), None);
        assert!(result.is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_script_content_relative_path_with_workdir() {
        // 相对路径 + workdir 应能正确解析
        let dir = std::env::temp_dir().join("agentvis_script_scan_rel_test");
        let _ = std::fs::create_dir_all(&dir);
        let script = dir.join("danger.bat");
        std::fs::write(&script, "diskpart /s clean_disk.txt\n").unwrap();

        let result = validate_script_content("danger.bat", Some(dir.to_str().unwrap()));
        assert!(result.is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_script_content_nonexistent_file_pass() {
        // 脚本文件不存在时应静默放行
        let result = validate_script_content("powershell -File nonexistent_script.ps1", None);
        assert!(result.is_ok());
    }

    #[test]
    fn test_non_script_command_skipped() {
        // 非脚本命令不触发内容扫描
        let result = validate_script_content("git status", None);
        assert!(result.is_ok());
    }

    // ── 写入保护 — Shell 重定向 ──

    #[test]
    fn test_shell_redirect_to_protected_dir_blocked() {
        let _guard = lock_custom_protected_paths();
        // Shell 重定向写入保护目录应被阻断
        let dir = std::env::temp_dir().join("agentvis_write_redirect_test");
        let _ = std::fs::create_dir_all(&dir);
        let config = dir.join("protected_paths.json");
        std::fs::write(&config, r#"["D:\\important_data"]"#).unwrap();
        reload_custom_protected_paths(&dir);

        // > 重定向
        assert!(
            validate_command_safety(r#"echo "hack" > D:\important_data\config.txt"#, &dir).is_err()
        );

        // >> 追加重定向
        assert!(
            validate_command_safety(r#"echo "append" >> D:\important_data\log.txt"#, &dir).is_err()
        );

        // PowerShell Out-File
        assert!(validate_command_safety(
            r#"powershell -Command "Get-Process | Out-File D:\important_data\procs.txt""#,
            &dir
        )
        .is_err());

        // PowerShell Set-Content
        assert!(validate_command_safety(
            r#"powershell -Command "Set-Content -Path D:\important_data\file.txt -Value 'test'""#,
            &dir
        )
        .is_err());

        // 非保护目录应放行
        assert!(validate_command_safety(r#"echo "ok" > F:\temp\output.txt"#, &dir).is_ok());

        let _ = std::fs::remove_dir_all(&dir);
        let mut guard = CUSTOM_PROTECTED_PATHS
            .write()
            .unwrap_or_else(|e| e.into_inner());
        *guard = None;
    }

    // ── 写入保护 — validate_path_write_safety ──

    #[test]
    fn test_powershell_write_target_parsing_distinguishes_paths_from_values() {
        assert_eq!(
            write_target_tokens(
                r#"powershell -Command "Set-Content D:\important_data\positional.txt -Value ok""#
            ),
            vec!["D:\\important_data\\positional.txt".to_string()]
        );
        assert_eq!(
            write_target_tokens(
                r#"powershell -Command "Set-Content -LiteralPath D:\important_data\literal.txt -Value ok""#
            ),
            vec!["D:\\important_data\\literal.txt".to_string()]
        );
        assert_eq!(
            write_target_tokens(
                r#"powershell -Command "Add-Content -Path D:\important_data\append.txt -Value ok""#
            ),
            vec!["D:\\important_data\\append.txt".to_string()]
        );
        assert_eq!(
            write_target_tokens(
                r#"powershell -Command "Tee-Object -FilePath D:\important_data\tee.txt -InputObject ok""#
            ),
            vec!["D:\\important_data\\tee.txt".to_string()]
        );
        assert_eq!(
            write_target_tokens(
                r#"powershell -Command "Set-Content -Value hello -Path F:\temp\ok.txt""#
            ),
            vec!["F:\\temp\\ok.txt".to_string()]
        );
        assert_eq!(
            write_target_tokens(
                r#"powershell -Command "Out-File -InputObject hello -FilePath F:\temp\ok.txt""#
            ),
            vec!["F:\\temp\\ok.txt".to_string()]
        );
    }

    #[test]
    fn test_path_write_safety_blocked() {
        let _guard = lock_custom_protected_paths();
        // 保护目录下的文件写入应被阻断
        let dir = std::env::temp_dir().join("agentvis_write_safety_test");
        let _ = std::fs::create_dir_all(&dir);
        let config = dir.join("protected_paths.json");
        std::fs::write(&config, r#"["D:\\important_backup"]"#).unwrap();
        reload_custom_protected_paths(&dir);

        // 子目录文件
        let path = std::path::Path::new("D:\\important_backup\\subdir\\file.txt");
        assert!(validate_path_write_safety(path, &dir).is_err());

        // 根目录自身
        let path = std::path::Path::new("D:\\important_backup");
        assert!(validate_path_write_safety(path, &dir).is_err());

        let _ = std::fs::remove_dir_all(&dir);
        let mut guard = CUSTOM_PROTECTED_PATHS
            .write()
            .unwrap_or_else(|e| e.into_inner());
        *guard = None;
    }

    #[test]
    fn test_path_write_safety_boundary_check() {
        let _guard = lock_custom_protected_paths();
        // 路径前缀边界检查：D:\important_backup 不应误匹配 D:\important_backup_other
        let dir = std::env::temp_dir().join("agentvis_write_boundary_test");
        let _ = std::fs::create_dir_all(&dir);
        let config = dir.join("protected_paths.json");
        std::fs::write(&config, r#"["D:\\important_backup"]"#).unwrap();
        reload_custom_protected_paths(&dir);

        // 名称更长但不同的目录应放行
        let path = std::path::Path::new("D:\\important_backup_other\\file.txt");
        assert!(validate_path_write_safety(path, &dir).is_ok());

        // 完全不同的目录应放行
        let path = std::path::Path::new("F:\\temp\\file.txt");
        assert!(validate_path_write_safety(path, &dir).is_ok());

        let _ = std::fs::remove_dir_all(&dir);
        let mut guard = CUSTOM_PROTECTED_PATHS
            .write()
            .unwrap_or_else(|e| e.into_inner());
        *guard = None;
    }

    #[test]
    fn test_path_write_safety_empty_list_pass() {
        let _guard = lock_custom_protected_paths();
        // 空保护路径列表时所有写入应放行
        let dir = std::env::temp_dir().join("agentvis_write_empty_test");
        let _ = std::fs::create_dir_all(&dir);
        // 不创建 protected_paths.json，缓存也清空
        {
            let mut guard = CUSTOM_PROTECTED_PATHS
                .write()
                .unwrap_or_else(|e| e.into_inner());
            *guard = None;
        }

        let path = std::path::Path::new("D:\\any\\path\\file.txt");
        assert!(validate_path_write_safety(path, &dir).is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
