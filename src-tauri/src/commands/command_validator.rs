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

use std::io::{Read, Write};
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
    "del/",
    "rmdir",
    "remove-item",
    // rd 是 rmdir 的简写
    "rd ",
    "rd /",
    "rd/",
    "erase ",
    "erase /",
    "erase/",
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

const CORE_PROTECTED_ROOTS: &[&str] = &[
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
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
    for segment in split_top_level_script_commands(lower) {
        let tokens = split_shell_tokens(&segment);
        for window in tokens.windows(2) {
            if token_command_name(&window[0]) != "format" {
                continue;
            }
            let target = window[1].trim_matches('"');
            let bytes = target.as_bytes();
            if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
                return true;
            }
        }
    }
    false
}

fn contains_powershell_encoded_command(command: &str) -> bool {
    for segment in split_top_level_script_commands(command) {
        let tokens = split_shell_tokens(&segment);
        for (index, token) in tokens.iter().enumerate() {
            let executable = token.replace('^', "");
            if !matches!(
                token_command_name(&executable).as_str(),
                "powershell" | "pwsh"
            ) {
                continue;
            }
            for (option_index, option) in tokens.iter().enumerate().skip(index + 1) {
                let deobfuscated = option.replace('^', "");
                if !deobfuscated.starts_with(['-', '/']) {
                    continue;
                }
                let normalized = deobfuscated
                    .trim_start_matches(['-', '/'])
                    .to_ascii_lowercase();
                if !normalized.is_empty() && "encodedcommand".starts_with(&normalized) {
                    return true;
                }
                if !normalized.is_empty() && "command".starts_with(&normalized) {
                    if let Some(payload) = tokens.get(option_index + 1) {
                        if contains_powershell_encoded_command(payload) {
                            return true;
                        }
                    }
                    break;
                }
                if !normalized.is_empty() && "file".starts_with(&normalized) {
                    break;
                }
            }
        }
        if let Some(payload) = cmd_command_payload(&segment) {
            if contains_powershell_encoded_command(&payload) {
                return true;
            }
        }
    }
    false
}

fn contains_tool_subcommand(command: &str, tool: &str, subcommand: &str) -> bool {
    split_top_level_script_commands(command)
        .into_iter()
        .flat_map(|segment| split_shell_tokens(&segment))
        .collect::<Vec<_>>()
        .windows(2)
        .any(|window| {
            token_command_name(&window[0]) == tool && window[1].eq_ignore_ascii_case(subcommand)
        })
}

// ==================== 自定义保护目录 ====================

/// 缓存自定义保护路径，使用 RwLock 支持热更新
///
/// 首次调用 `load_custom_protected_paths` 时从磁盘加载并缓存；
/// `set_protected_paths` 命令写入文件后，调用 `reload_custom_protected_paths` 刷新缓存。
/// 缓存项绑定 app-data 根，避免测试、多实例或配置迁移时串用。
#[derive(Clone)]
struct CustomProtectedPathsCache {
    app_data_dir: PathBuf,
    paths: Vec<String>,
}

static CUSTOM_PROTECTED_PATHS: RwLock<Vec<CustomProtectedPathsCache>> = RwLock::new(Vec::new());

const MAX_PROTECTED_PATHS_FILE_BYTES: u64 = 1024 * 1024;
const MAX_PROTECTED_PATHS_ENTRIES: usize = 4096;
const MAX_PROTECTED_PATH_BYTES: usize = 32 * 1024;

enum ProtectedPathsDiskState {
    Missing,
    Loaded(Vec<String>),
}

struct ProtectedPathsSizeWriter {
    bytes_written: u64,
    exceeded: bool,
}

impl Write for ProtectedPathsSizeWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let next_size = self.bytes_written.saturating_add(buffer.len() as u64);
        if next_size > MAX_PROTECTED_PATHS_FILE_BYTES {
            self.exceeded = true;
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "protected paths serialization exceeded its safety limit",
            ));
        }
        self.bytes_written = next_size;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Validate protected-path settings before persisting them.
///
/// The disk reader repeats the same checks so callers cannot bypass the limits by editing the
/// configuration directly. Keeping this helper public lets the settings command reject oversized
/// input before replacing the last-known-good file.
pub fn validate_protected_paths_config(paths: &[String]) -> Result<(), AppError> {
    if paths.len() > MAX_PROTECTED_PATHS_ENTRIES {
        return Err(AppError::FileSystem(format!(
            "protected_paths.json exceeds the {} entry safety limit; last-known-good custom protection remains active.",
            MAX_PROTECTED_PATHS_ENTRIES
        )));
    }
    if paths
        .iter()
        .any(|path| path.len() > MAX_PROTECTED_PATH_BYTES)
    {
        return Err(AppError::FileSystem(format!(
            "protected_paths.json contains a path exceeding the {} byte safety limit; last-known-good custom protection remains active.",
            MAX_PROTECTED_PATH_BYTES
        )));
    }

    let mut size_writer = ProtectedPathsSizeWriter {
        bytes_written: 0,
        exceeded: false,
    };
    if let Err(error) = serde_json::to_writer(&mut size_writer, paths) {
        if size_writer.exceeded {
            return Err(AppError::FileSystem(format!(
                "protected_paths.json exceeds the {} byte safety limit after JSON encoding; last-known-good custom protection remains active.",
                MAX_PROTECTED_PATHS_FILE_BYTES
            )));
        }
        return Err(AppError::FileSystem(format!(
            "Failed to validate protected_paths.json serialization safely: {}",
            error
        )));
    }
    Ok(())
}

/// 从应用数据目录加载用户自定义的保护路径（带全局缓存）
///
/// 配置文件路径: {app_data_dir}/protected_paths.json
/// 格式: JSON 字符串数组 ["D:\\重要备份", "E:\\项目存档"]
/// 文件不存在时返回空列表（不报错）
fn load_custom_protected_paths(app_data_dir: &Path) -> Result<Vec<String>, AppError> {
    let cache_key = normalize_path_lexically(app_data_dir);
    // 快速读取路径：如果缓存已存在，直接返回克隆
    {
        let guard = CUSTOM_PROTECTED_PATHS
            .read()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = guard.iter().find(|cached| cached.app_data_dir == cache_key) {
            return Ok(cached.paths.clone());
        }
    }

    // 缓存未初始化，从磁盘加载并写入缓存
    let paths = read_protected_paths_from_disk(app_data_dir)?;
    {
        let mut guard = CUSTOM_PROTECTED_PATHS
            .write()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = guard.iter().find(|cached| cached.app_data_dir == cache_key) {
            return Ok(cached.paths.clone());
        }
        guard.push(CustomProtectedPathsCache {
            app_data_dir: cache_key,
            paths: paths.clone(),
        });
    }
    Ok(paths)
}

fn read_protected_paths_state(app_data_dir: &Path) -> Result<ProtectedPathsDiskState, AppError> {
    let config_path = app_data_dir.join("protected_paths.json");

    let file = match std::fs::File::open(&config_path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProtectedPathsDiskState::Missing);
        }
        Err(error) => {
            return Err(AppError::FileSystem(format!(
                "Failed to open protected_paths.json safely: {}",
                error
            )));
        }
    };
    let metadata = file.metadata().map_err(|error| {
        AppError::FileSystem(format!(
            "Failed to inspect protected_paths.json safely: {}",
            error
        ))
    })?;
    if metadata.len() > MAX_PROTECTED_PATHS_FILE_BYTES {
        return Err(AppError::FileSystem(format!(
            "protected_paths.json exceeds the {} byte safety limit; last-known-good custom protection remains active.",
            MAX_PROTECTED_PATHS_FILE_BYTES
        )));
    }

    let mut content = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_PROTECTED_PATHS_FILE_BYTES + 1)
        .read_to_end(&mut content)
        .map_err(|error| {
            AppError::FileSystem(format!(
                "Failed to read protected_paths.json safely: {}",
                error
            ))
        })?;
    if content.len() as u64 > MAX_PROTECTED_PATHS_FILE_BYTES {
        return Err(AppError::FileSystem(format!(
            "protected_paths.json grew beyond the {} byte safety limit; last-known-good custom protection remains active.",
            MAX_PROTECTED_PATHS_FILE_BYTES
        )));
    }

    let paths = serde_json::from_slice::<Vec<String>>(&content).map_err(|error| {
        log::warn!(
            "[CommandValidator] ⚠️ protected_paths.json 解析失败: {}",
            error
        );
        AppError::FileSystem(
            "protected_paths.json is invalid; last-known-good custom protection remains active."
                .to_string(),
        )
    })?;
    validate_protected_paths_config(&paths)?;
    if !paths.is_empty() {
        log::debug!("[CommandValidator] 加载了 {} 个自定义保护路径", paths.len());
    }
    Ok(ProtectedPathsDiskState::Loaded(paths))
}

/// 从磁盘读取 protected_paths.json（纯 I/O，不涉及缓存）。
///
/// 首次加载时文件缺失代表尚未配置，因此返回空列表；格式、资源上限或其他 I/O
/// 错误一律 fail closed。显式刷新使用内部状态区分“缺失”和“空数组”。
pub fn read_protected_paths_from_disk(app_data_dir: &Path) -> Result<Vec<String>, AppError> {
    match read_protected_paths_state(app_data_dir)? {
        ProtectedPathsDiskState::Missing => Ok(Vec::new()),
        ProtectedPathsDiskState::Loaded(paths) => Ok(paths),
    }
}

/// 刷新自定义保护路径缓存
///
/// 在 `set_protected_paths` Tauri 命令写入文件后调用，
/// 使后续 `validate_command_safety` 立即使用最新路径列表。
pub fn reload_custom_protected_paths(app_data_dir: &Path) -> Result<(), AppError> {
    let paths = match read_protected_paths_state(app_data_dir)? {
        ProtectedPathsDiskState::Loaded(paths) => paths,
        ProtectedPathsDiskState::Missing => {
            return Err(AppError::FileSystem(
                "protected_paths.json disappeared during explicit reload; last-known-good custom protection remains active."
                    .to_string(),
            ));
        }
    };
    let mut guard = CUSTOM_PROTECTED_PATHS
        .write()
        .unwrap_or_else(|e| e.into_inner());
    let cache_key = normalize_path_lexically(app_data_dir);
    if let Some(cached) = guard
        .iter_mut()
        .find(|cached| cached.app_data_dir == cache_key)
    {
        cached.paths = paths;
    } else {
        guard.push(CustomProtectedPathsCache {
            app_data_dir: cache_key,
            paths,
        });
    }
    log::debug!("[CommandValidator] 自定义保护路径缓存已刷新");
    Ok(())
}

fn normalize_path_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    let anchored = path.has_root();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                ) {
                    normalized.pop();
                } else if !anchored {
                    // Relative paths may legitimately begin with one or more `..` components.
                    // Dropping an unconsumed parent silently retargets the command.
                    normalized.push(component.as_os_str());
                }
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

    if let Some(rest) = value.strip_prefix(r"\\?\unc\") {
        value = format!(r"\\{}", rest);
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        value = rest.to_string();
    }

    while value.len() > 3 && value.ends_with('\\') {
        value.pop();
    }

    value
}

fn canonicalize_with_missing_tail(path: &Path) -> Result<PathBuf, AppError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| {
                AppError::Forbidden(format!(
                    "Safety block: failed to resolve write path working directory: {}",
                    error
                ))
            })?
            .join(path)
    };
    let lexical = normalize_path_lexically(&absolute);
    let mut cursor = lexical.clone();
    let mut tail = Vec::new();

    loop {
        match std::fs::symlink_metadata(&cursor) {
            Ok(_) => {
                let mut resolved = std::fs::canonicalize(&cursor).map_err(|error| {
                    AppError::Forbidden(format!(
                        "Safety block: failed to resolve write path boundary: {}",
                        error
                    ))
                })?;
                for component in tail.iter().rev() {
                    resolved.push(component);
                }
                return Ok(normalize_path_lexically(&resolved));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let Some(name) = cursor.file_name() else {
                    return Ok(lexical);
                };
                tail.push(name.to_os_string());
                cursor = cursor
                    .parent()
                    .ok_or_else(|| {
                        AppError::Forbidden(
                            "Safety block: write path escaped its filesystem root.".to_string(),
                        )
                    })?
                    .to_path_buf();
            }
            Err(error) => {
                return Err(AppError::Forbidden(format!(
                    "Safety block: failed to inspect write path boundary: {}",
                    error
                )));
            }
        }
    }
}

fn path_matches_protected_path(path: &Path, protected: &str) -> bool {
    let file_str = normalize_path_for_compare(path);
    let protected_normalized = normalize_path_for_compare(Path::new(protected));

    if file_str.starts_with(&protected_normalized) {
        let after = &file_str[protected_normalized.len()..];
        return after.is_empty()
            || protected_normalized.ends_with('\\')
            || after.starts_with('\\')
            || after.starts_with('/');
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

fn core_protected_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = CORE_PROTECTED_ROOTS.iter().map(PathBuf::from).collect();
    for variable in [
        "SystemRoot",
        "WINDIR",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
    ] {
        let Some(value) = std::env::var_os(variable) else {
            continue;
        };
        let path = PathBuf::from(value);
        if path.is_absolute()
            && !roots
                .iter()
                .any(|root| normalize_path_for_compare(root) == normalize_path_for_compare(&path))
        {
            roots.push(path);
        }
    }
    roots
}

fn find_matching_core_protected_path(path: &Path) -> Option<PathBuf> {
    core_protected_roots()
        .into_iter()
        .find(|protected| path_matches_protected_path(path, &protected.to_string_lossy()))
}

fn resolve_target_path(target: &str, workdir: Option<&Path>) -> Result<PathBuf, AppError> {
    // shell_execute 通过 cmd /S /C 启动；CMD 只把双引号作为分组符，
    // 单引号是合法文件名字符，不能在安全校验中静默剥离。
    let trimmed = target.trim_matches('"');
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Ok(normalize_path_lexically(path));
    }

    let current_dir = std::env::current_dir().map_err(|error| {
        AppError::Forbidden(format!(
            "Safety block: failed to resolve command working directory: {}",
            error
        ))
    })?;
    let effective_workdir = match workdir {
        Some(wd) if wd.is_absolute() => wd.to_path_buf(),
        Some(wd) => current_dir.join(wd),
        None => current_dir,
    };
    Ok(normalize_path_lexically(&effective_workdir.join(path)))
}

fn quote_closer(ch: char) -> Option<char> {
    match ch {
        '"' => Some('"'),
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

fn script_path_prefix(value: &str, extensions: &[&str]) -> Option<String> {
    let end = extensions
        .iter()
        .flat_map(|extension| {
            value.char_indices().filter_map(move |(index, _)| {
                let candidate_end = index + extension.len();
                let candidate = value[index..]
                    .get(..extension.len())
                    .filter(|candidate| candidate.eq_ignore_ascii_case(extension))?;
                let boundary = value[candidate_end..].chars().next();
                (candidate.eq_ignore_ascii_case(extension)
                    && boundary.is_none_or(|ch| {
                        ch.is_whitespace() || matches!(ch, '\'' | '"' | '&' | '|' | ';')
                    }))
                .then_some(candidate_end)
            })
        })
        .min()?;
    let prefix = value[..end].trim();
    let prefix = prefix
        .get(..5)
        .filter(|start| start.eq_ignore_ascii_case("call "))
        .map_or(prefix, |_| &prefix[5..])
        .trim_matches('"');

    (!prefix.is_empty()).then(|| prefix.to_string())
}

fn token_command_name(token: &str) -> String {
    let mut name = Path::new(token)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(token)
        .to_lowercase();

    for suffix in [".exe", ".com"] {
        if name.ends_with(suffix) {
            name.truncate(name.len() - suffix.len());
            break;
        }
    }

    name
}

fn is_cmd_launcher_token(token: &str) -> bool {
    let trimmed = token.trim_matches('"');
    token_command_name(trimmed) == "cmd"
        || trimmed.eq_ignore_ascii_case("%comspec%")
        || trimmed.eq_ignore_ascii_case("!comspec!")
}

fn cmd_delete_builtin_name(token: &str) -> Option<&'static str> {
    let normalized = token
        .trim_start_matches('@')
        .trim_matches('"')
        .to_ascii_lowercase();

    for (name, allowed_flags) in [
        ("del", &["p", "f", "s", "q", "a"][..]),
        ("erase", &["p", "f", "s", "q", "a"][..]),
        ("rd", &["s", "q"][..]),
        ("rmdir", &["s", "q"][..]),
    ] {
        if normalized == name {
            return Some(name);
        }
        let Some(flags) = normalized.strip_prefix(&format!("{name}/")) else {
            continue;
        };
        if !flags.is_empty()
            && flags.split('/').all(|flag| {
                allowed_flags.contains(&flag)
                    || (name == "del" || name == "erase")
                        && flag
                            .strip_prefix("a:")
                            .is_some_and(|attributes| !attributes.is_empty())
            })
        {
            return Some(name);
        }
    }

    None
}

fn is_combined_cmd_switch_prefix(command: &str, command_switch_position: usize) -> bool {
    let token_start = command[..command_switch_position]
        .rfind(char::is_whitespace)
        .map_or(0, |index| index + 1);
    let prefix = &command[token_start..command_switch_position];
    let Some(flags) = prefix.strip_prefix('/') else {
        return false;
    };
    !flags.is_empty()
        && flags.split('/').all(|flag| {
            matches!(
                flag.to_ascii_lowercase().as_str(),
                "a" | "u"
                    | "q"
                    | "d"
                    | "s"
                    | "e:on"
                    | "e:off"
                    | "f:on"
                    | "f:off"
                    | "v:on"
                    | "v:off"
            )
        })
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
    if let Some(payload) = cmd_command_payload(command) {
        return destructive_target_tokens(&payload);
    }

    let tokens = split_shell_tokens(command);
    let mut targets = if tokens
        .first()
        .and_then(|token| cmd_delete_builtin_name(token))
        .is_some()
    {
        tokens
            .iter()
            .skip(1)
            .filter(|token| !token.starts_with('/') && !token.starts_with('-'))
            .cloned()
            .collect()
    } else {
        collect_after_shell_command(&tokens, &["del", "erase", "rmdir", "rd"])
    };
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

    if contains_powershell_encoded_command(command) {
        return Err(AppError::Forbidden(
            "Safety block: PowerShell encoded commands are blocked.".to_string(),
        ));
    }
    if contains_tool_subcommand(command, "reg", "delete") {
        return Err(AppError::Forbidden(
            "Safety block: registry deletion commands are blocked.".to_string(),
        ));
    }
    if contains_tool_subcommand(command, "net", "user")
        || contains_tool_subcommand(command, "sc", "delete")
    {
        return Err(AppError::Forbidden(
            "Safety block: account or service modification commands are blocked.".to_string(),
        ));
    }

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
    let destructive_targets = destructive_target_tokens(command);
    let has_destructive_verb = DESTRUCTIVE_VERBS.iter().any(|verb| lower.contains(verb))
        || !destructive_targets.is_empty();

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

        let custom_paths = load_custom_protected_paths(app_data_dir)?;
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

        for target in destructive_targets {
            let resolved = resolve_target_path(&target, workdir)?;
            if let Some(core_path) = find_matching_core_protected_path(&resolved) {
                let reason = format!(
                    "Safety block: destructive operations on system-protected directory '{}' are blocked.",
                    core_path.display()
                );
                log::warn!("[CommandValidator] {}", reason);
                return Err(AppError::Forbidden(reason));
            }
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
        let custom_paths = load_custom_protected_paths(app_data_dir)?;
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
            let resolved = resolve_target_path(&target, workdir)?;
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
    let custom_paths = load_custom_protected_paths(app_data_dir)?;
    if custom_paths.is_empty() {
        return Ok(());
    }

    let lexical_file = normalize_path_lexically(file_path);
    let resolved_file = canonicalize_with_missing_tail(file_path)?;

    for protected in &custom_paths {
        let protected_path = Path::new(protected);
        let lexical_match = path_matches_protected_path(&lexical_file, protected);
        let resolved_match = canonicalize_with_missing_tail(protected_path)
            .map(|resolved| {
                path_matches_protected_path(&resolved_file, &resolved.to_string_lossy())
            })
            .unwrap_or(false);
        if lexical_match || resolved_match {
            let reason = format!(
                "Safety block: writing files to protected directory '{}' is blocked.",
                protected
            );
            log::warn!("[CommandValidator] {}", reason);
            return Err(AppError::Forbidden(reason));
        }
    }

    Ok(())
}

/// Re-check fully resolved Trash Bin targets before the host process moves them.
///
/// Command-text validation runs before the Trash Bin parser expands its small environment-variable
/// allow-list. This target-level check closes that gap and also resolves existing ancestors so a
/// path routed through a junction or symlink cannot reach a protected directory unnoticed.
pub fn validate_delete_target_safety(
    target_path: &Path,
    app_data_dir: &Path,
) -> Result<(), AppError> {
    validate_delete_targets_safety(&[target_path.to_path_buf()], app_data_dir)
}

fn path_has_glob_component(path: &Path) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_string_lossy()
            .chars()
            .any(|character| matches!(character, '*' | '?'))
    })
}

#[cfg(target_os = "windows")]
fn metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(target_os = "windows"))]
fn metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn canonicalize_delete_target_for_compare(path: &Path) -> Result<PathBuf, AppError> {
    if !path_has_glob_component(path) {
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|error| {
                    AppError::Forbidden(format!(
                        "Safety block: failed to resolve delete target working directory: {}",
                        error
                    ))
                })?
                .join(path)
        };
        let lexical = normalize_path_lexically(&absolute);

        match std::fs::symlink_metadata(&lexical) {
            Ok(metadata)
                if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) =>
            {
                // Removing a terminal symlink/junction removes the link item, not its destination.
                // Resolve its parent (including intermediate links) and append only the leaf name.
                let name = lexical.file_name().ok_or_else(|| {
                    AppError::Forbidden(
                        "Safety block: delete target link has no safe parent.".to_string(),
                    )
                })?;
                let parent = lexical.parent().ok_or_else(|| {
                    AppError::Forbidden(
                        "Safety block: delete target escaped its filesystem root.".to_string(),
                    )
                })?;
                let mut resolved = canonicalize_with_missing_tail(parent)?;
                resolved.push(name);
                return Ok(normalize_path_lexically(&resolved));
            }
            Ok(_) => {
                // Existing ordinary objects must be canonicalized in full. On Windows this also
                // collapses trailing-dot/space and 8.3 aliases before protected-root comparison.
                return std::fs::canonicalize(&lexical)
                    .map(|resolved| normalize_path_lexically(&resolved))
                    .map_err(|error| {
                        AppError::Forbidden(format!(
                            "Safety block: failed to resolve delete target boundary: {}",
                            error
                        ))
                    });
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Some Windows aliases (notably a trailing dot/space) may miss a metadata probe
                // yet still resolve through the API used by the eventual rename. Give the full
                // canonicalization path one chance before treating the leaf as genuinely absent.
                return match std::fs::canonicalize(&lexical) {
                    Ok(resolved) => Ok(normalize_path_lexically(&resolved)),
                    Err(canonical_error)
                        if canonical_error.kind() == std::io::ErrorKind::NotFound =>
                    {
                        canonicalize_with_missing_tail(&lexical)
                    }
                    Err(canonical_error) => Err(AppError::Forbidden(format!(
                        "Safety block: failed to resolve delete target boundary: {}",
                        canonical_error
                    ))),
                };
            }
            Err(error) => {
                return Err(AppError::Forbidden(format!(
                    "Safety block: failed to inspect delete target boundary: {}",
                    error
                )));
            }
        }
    }

    let mut prefix = PathBuf::new();
    let mut suffix = Vec::new();
    let mut in_glob_suffix = false;
    for component in path.components() {
        let has_glob = component
            .as_os_str()
            .to_string_lossy()
            .chars()
            .any(|character| matches!(character, '*' | '?'));
        if in_glob_suffix || has_glob {
            in_glob_suffix = true;
            suffix.push(component.as_os_str().to_os_string());
        } else {
            prefix.push(component.as_os_str());
        }
    }

    let mut resolved = if prefix.as_os_str().is_empty() {
        std::env::current_dir().map_err(|error| {
            AppError::Forbidden(format!(
                "Safety block: failed to resolve delete glob working directory: {}",
                error
            ))
        })?
    } else {
        canonicalize_with_missing_tail(&prefix)?
    };
    for component in suffix {
        resolved.push(component);
    }
    Ok(normalize_path_lexically(&resolved))
}

fn protected_paths_intersect(first: &Path, second: &Path) -> bool {
    path_matches_protected_path(first, &second.to_string_lossy())
        || path_matches_protected_path(second, &first.to_string_lossy())
}

struct ProtectedRootBoundary {
    lexical: PathBuf,
    resolved: PathBuf,
}

fn protected_root_boundary(protected_root: &Path) -> Result<ProtectedRootBoundary, AppError> {
    Ok(ProtectedRootBoundary {
        lexical: normalize_path_lexically(protected_root),
        resolved: canonicalize_with_missing_tail(protected_root)?,
    })
}

fn target_intersects_protected_root(
    lexical_target: &Path,
    resolved_target: &Path,
    protected_root: &ProtectedRootBoundary,
) -> bool {
    protected_paths_intersect(lexical_target, &protected_root.lexical)
        || protected_paths_intersect(lexical_target, &protected_root.resolved)
        || protected_paths_intersect(resolved_target, &protected_root.lexical)
        || protected_paths_intersect(resolved_target, &protected_root.resolved)
}

/// Validate every resolved target before a multi-target delete starts moving data.
/// The check is bidirectional: deleting a protected path or any of its ancestors is blocked.
pub fn validate_delete_targets_safety(
    target_paths: &[PathBuf],
    app_data_dir: &Path,
) -> Result<(), AppError> {
    let custom_paths = load_custom_protected_paths(app_data_dir)?;
    let core_roots = core_protected_roots()
        .iter()
        .map(|root| protected_root_boundary(root))
        .collect::<Result<Vec<_>, AppError>>()?;
    let custom_roots = custom_paths
        .iter()
        .map(PathBuf::from)
        .map(|root| protected_root_boundary(&root))
        .collect::<Result<Vec<_>, AppError>>()?;
    let reserved_paths = [
        app_data_dir.join("protected_paths.json"),
        app_data_dir.join("Agent_Trash_Bin"),
    ]
    .iter()
    .map(|root| protected_root_boundary(root))
    .collect::<Result<Vec<_>, AppError>>()?;

    for target_path in target_paths {
        let lexical_target = normalize_path_lexically(target_path);
        let resolved_target = canonicalize_delete_target_for_compare(target_path)?;

        for protected_root in &core_roots {
            if target_intersects_protected_root(&lexical_target, &resolved_target, protected_root) {
                return Err(AppError::Forbidden(
                    "Safety block [recoverable_delete_required]: delete target intersects a system-protected directory."
                        .to_string(),
                ));
            }
        }

        for protected_root in &custom_roots {
            if target_intersects_protected_root(&lexical_target, &resolved_target, protected_root) {
                return Err(AppError::Forbidden(
                    "Safety block [recoverable_delete_required]: delete target intersects a user-protected directory."
                        .to_string(),
                ));
            }
        }

        for reserved_path in &reserved_paths {
            if target_intersects_protected_root(&lexical_target, &resolved_target, reserved_path) {
                return Err(AppError::Forbidden(
                    "Safety block [recoverable_delete_required]: delete target intersects AgentVis recovery metadata."
                        .to_string(),
                ));
            }
        }
    }

    Ok(())
}

// ==================== 脚本内容扫描 ====================

/// 可扫描的脚本文件扩展名
const SCANNABLE_EXTENSIONS: &[&str] = &[
    ".ps1", ".bat", ".cmd", ".py", ".pyw", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts",
    ".tsx", ".cs", ".vbs",
];

const RECOVERABLE_DELETE_BLOCK_PREFIX: &str = "Safety block [recoverable_delete_required]";

fn powershell_launcher_option_consumes_value(option: &str) -> bool {
    let normalized = option.trim_start_matches('-').split_once(':').map_or_else(
        || option.trim_start_matches('-').to_ascii_lowercase(),
        |(name, _)| name.to_ascii_lowercase(),
    );
    matches!(
        normalized.as_str(),
        "psconsolefile"
            | "version"
            | "inputformat"
            | "outputformat"
            | "windowstyle"
            | "encodedcommand"
            | "configurationname"
            | "executionpolicy"
            | "workingdirectory"
            | "wd"
            | "settingsfile"
            | "configurationfile"
    ) && !option.contains(':')
}

fn split_powershell_literal_tokens(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for ch in input.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if quote == Some('"') && ch == '`' {
            escaped = true;
            continue;
        }
        match quote {
            Some(close) if ch == close => quote = None,
            Some(_) => current.push(ch),
            None if matches!(ch, '\'' | '"') => quote = Some(ch),
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

fn literal_powershell_script_path(payload: &str) -> Option<String> {
    let tokens = split_powershell_literal_tokens(payload);
    let mut index = 0;
    if tokens
        .get(index)
        .is_some_and(|token| matches!(token.as_str(), "." | "&"))
    {
        index += 1;
    }
    let candidate = tokens
        .get(index)?
        .trim_matches(|ch| matches!(ch, '\'' | '"'));
    is_script_extension(candidate, &[".ps1"]).then(|| candidate.to_string())
}

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

const JAVASCRIPT_SCRIPT_EXTENSIONS: &[&str] =
    &[".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"];

const PYTHON_VALUE_OPTIONS: &[&str] = &["-W", "-X", "-Q", "--check-hash-based-pycs"];
const PYTHON_ATTACHED_VALUE_OPTIONS: &[&str] = &["-W", "-X", "-Q"];

const NODE_VALUE_OPTIONS: &[&str] = &[
    "-r",
    "--require",
    "--import",
    "--loader",
    "--experimental-loader",
    "-C",
    "--conditions",
    "--build-snapshot-config",
    "--diagnostic-dir",
    "--dns-result-order",
    "--env-file",
    "--env-file-if-exists",
    "--experimental-config-file",
    "--experimental-sea-config",
    "--icu-data-dir",
    "--input-type",
    "--inspect-port",
    "--inspect-publish-uid",
    "--max-http-header-size",
    "--openssl-config",
    "--redirect-warnings",
    "--report-directory",
    "--report-filename",
    "--secure-heap",
    "--secure-heap-min",
    "--snapshot-blob",
    "--test-global-setup",
    "--test-name-pattern",
    "--test-reporter",
    "--test-reporter-destination",
    "--title",
    "--trace-event-categories",
    "--trace-event-file-pattern",
    "--unhandled-rejections",
    "--use-largepages",
    "--watch-path",
];
const NODE_ATTACHED_VALUE_OPTIONS: &[&str] = &["-r", "-C"];
const NODE_EXECUTABLE_MODULE_OPTIONS: &[&str] = &[
    "-r",
    "--require",
    "--import",
    "--loader",
    "--experimental-loader",
    "--test-global-setup",
    "--test-reporter",
];
const NODE_AMBIGUOUS_CONFIG_OPTIONS: &[&str] = &[
    "--build-snapshot",
    "--build-snapshot-config",
    "--experimental-config-file",
    "--experimental-default-config-file",
    "--experimental-sea-config",
    "--snapshot-blob",
];

const DENO_VALUE_OPTIONS: &[&str] = &[
    "-c",
    "--config",
    "--import-map",
    "--cert",
    "--conditions",
    "--cwd",
    "--ext",
    "--host",
    "--key",
    "--location",
    "--port",
    "--seed",
    "--inspect-port",
    "-L",
    "--log-level",
    "--preload",
    "--require",
    "--watch-exclude",
];
const DENO_ATTACHED_VALUE_OPTIONS: &[&str] = &["-c", "-L"];
const DENO_ATTACHED_ONLY_VALUE_OPTIONS: &[&str] = &["--lock", "--v8-flags"];
const DENO_PRELOAD_OPTIONS: &[&str] = &["--preload", "--require"];
const DENO_EXECUTION_MODES: &[&str] = &["run", "compile", "test", "bench", "serve", "watch"];
const DENO_TEST_BENCH_VALUE_OPTIONS: &[&str] = &[
    "--coverage-threshold",
    "--filter",
    "--junit-path",
    "--related",
    "--repeats",
    "--reporter",
    "--retry",
    "--shard",
];

const BUN_VALUE_OPTIONS: &[&str] = &[
    "-r",
    "-c",
    "--require",
    "--preload",
    "--import",
    "--config",
    "--cwd",
    "--tsconfig",
    "--loader",
    "--conditions",
    "--define",
    "--external",
    "--env-file",
    "--origin",
    "--port",
    "--target",
    "--format",
    "--outdir",
    "--outfile",
];
const BUN_ATTACHED_VALUE_OPTIONS: &[&str] = &["-r", "-c"];
const BUN_PRELOAD_OPTIONS: &[&str] = &["-r", "--require", "--preload", "--import"];
const BUN_EXECUTION_MODES: &[&str] = &["run", "test"];
const BUN_RUN_VALUE_OPTIONS: &[&str] = &["--elide-lines", "--filter", "--shell"];
const BUN_TEST_VALUE_OPTIONS: &[&str] = &[
    "-t",
    "--coverage-dir",
    "--coverage-reporter",
    "--max-concurrency",
    "--reporter",
    "--reporter-outfile",
    "--test-name-pattern",
    "--timeout",
];
const BUN_TEST_ATTACHED_VALUE_OPTIONS: &[&str] = &["-t"];

fn is_path_like_script_specifier(value: &str) -> bool {
    value.starts_with("./")
        || value.starts_with(".\\")
        || value.starts_with("../")
        || value.starts_with("..\\")
        || value.starts_with('/')
        || value.starts_with('\\')
        || value.as_bytes().get(1) == Some(&b':')
}

fn has_script_uri_scheme(value: &str) -> bool {
    let Some((scheme, _)) = value.split_once(':') else {
        return false;
    };
    !(scheme.len() == 1 && scheme.as_bytes()[0].is_ascii_alphabetic())
        && !scheme.is_empty()
        && scheme
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
}

fn option_value_at(
    tokens: &[String],
    index: usize,
    options: &[&str],
    attached_short_options: &[&str],
) -> Option<(Option<String>, usize)> {
    let token = tokens.get(index)?;
    let lower = token.to_ascii_lowercase();
    let comparable = if token.starts_with("--") {
        lower.replace('_', "-")
    } else {
        lower.clone()
    };

    for option in options {
        let matches = if option.starts_with("--") {
            comparable == *option
        } else {
            token == *option
        };
        if matches {
            return Some((
                tokens.get(index + 1).cloned(),
                usize::from(index + 1 < tokens.len()) + 1,
            ));
        }
        if option.starts_with("--") {
            let prefix = format!("{}=", option);
            if comparable.starts_with(&prefix) {
                return Some((Some(token[prefix.len()..].to_string()), 1));
            }
        }
    }

    for option in attached_short_options {
        if token.starts_with(option) && token.len() > option.len() {
            return Some((Some(token[option.len()..].to_string()), 1));
        }
    }

    None
}

fn option_name_at<'a>(
    tokens: &[String],
    index: usize,
    options: &'a [&str],
    attached_short_options: &[&str],
) -> Option<&'a str> {
    let token = tokens.get(index)?;
    let comparable = if token.starts_with("--") {
        token.to_ascii_lowercase().replace('_', "-")
    } else {
        token.to_string()
    };
    options.iter().copied().find(|option| {
        comparable == *option
            || (option.starts_with("--") && comparable.starts_with(&format!("{}=", option)))
            || (attached_short_options.contains(option)
                && token.starts_with(option)
                && token.len() > option.len())
    })
}

fn runtime_value_options(runtime: &str) -> (&'static [&'static str], &'static [&'static str]) {
    match runtime {
        "node" | "nodejs" => (NODE_VALUE_OPTIONS, NODE_ATTACHED_VALUE_OPTIONS),
        "deno" => (DENO_VALUE_OPTIONS, DENO_ATTACHED_VALUE_OPTIONS),
        "bun" => (BUN_VALUE_OPTIONS, BUN_ATTACHED_VALUE_OPTIONS),
        _ => (&[], &[]),
    }
}

fn runtime_mode_value_options(
    runtime: &str,
    mode: Option<&str>,
) -> (&'static [&'static str], &'static [&'static str]) {
    match (runtime, mode) {
        ("deno", Some("test" | "bench")) => (DENO_TEST_BENCH_VALUE_OPTIONS, &[]),
        ("bun", Some("run")) => (BUN_RUN_VALUE_OPTIONS, &[]),
        ("bun", Some("test")) => (BUN_TEST_VALUE_OPTIONS, BUN_TEST_ATTACHED_VALUE_OPTIONS),
        _ => (&[], &[]),
    }
}

fn runtime_terminal_option(token: &str, runtime: &str) -> bool {
    let lower = token.to_ascii_lowercase().replace('_', "-");
    match runtime {
        "node" | "nodejs" => {
            lower == "--run"
                || lower.starts_with("--run=")
                || matches!(lower.as_str(), "-e" | "-pe" | "--eval" | "-p" | "--print")
                || (lower.starts_with("-e") && lower.len() > 2)
                || (lower.starts_with("-p") && lower.len() > 2)
                || lower.starts_with("--eval=")
                || lower.starts_with("--print=")
        }
        "bun" => {
            matches!(lower.as_str(), "-e" | "-p" | "--eval" | "--print")
                || (lower.starts_with("-e") && lower.len() > 2)
                || (lower.starts_with("-p") && lower.len() > 2)
                || lower.starts_with("--eval=")
                || lower.starts_with("--print=")
        }
        _ => false,
    }
}

/// Returns the option token indexes that the runtime consumes before its real entrypoint.
/// Options after the entrypoint or `--` are application arguments and must not affect guarding.
fn runtime_launcher_option_indices(tokens: &[String], runtime: &str) -> Vec<usize> {
    let (value_options, attached_options) = runtime_value_options(runtime);
    let execution_modes = match runtime {
        "deno" => DENO_EXECUTION_MODES,
        "bun" => BUN_EXECUTION_MODES,
        _ => &[],
    };
    let mut indexes = Vec::new();
    let mut index = 1usize;
    let mut mode = None;
    while index < tokens.len() {
        let token = &tokens[index];
        let lower = token.to_ascii_lowercase();
        if token == "--" || runtime_terminal_option(token, runtime) {
            break;
        }
        if mode.is_none() && execution_modes.contains(&lower.as_str()) {
            mode = Some(lower);
            index += 1;
            continue;
        }
        let (mode_value_options, mode_attached_options) =
            runtime_mode_value_options(runtime, mode.as_deref());
        if let Some((_, consumed)) = option_value_at(tokens, index, value_options, attached_options)
            .or_else(|| option_value_at(tokens, index, mode_value_options, mode_attached_options))
        {
            indexes.push(index);
            index += consumed;
        } else if token.starts_with('-') {
            indexes.push(index);
            index += 1;
        } else if matches!(mode.as_deref(), Some("test" | "bench")) {
            index += 1;
        } else {
            break;
        }
    }
    indexes
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PythonExecutionOption {
    Inline(String),
    Module(String),
}

fn python_execution_option_at(tokens: &[String], index: usize) -> Option<PythonExecutionOption> {
    let token = tokens.get(index)?;
    let execution = |mode: char, attached: &str| {
        let value = if attached.is_empty() {
            tokens.get(index + 1)?.to_string()
        } else {
            attached.to_string()
        };
        Some(if mode == 'c' {
            PythonExecutionOption::Inline(value)
        } else {
            PythonExecutionOption::Module(value)
        })
    };

    if let Some(attached) = token.strip_prefix("-c") {
        return execution('c', attached);
    }
    if let Some(attached) = token.strip_prefix("-m") {
        return execution('m', attached);
    }
    if !token.starts_with('-') || token.starts_with("--") || token.len() < 3 {
        return None;
    }

    let body = &token[1..];
    let mut chars = body.char_indices();
    while let Some((offset, flag)) = chars.next() {
        if matches!(flag, 'W' | 'X' | 'Q') {
            return None;
        }
        if matches!(flag, 'c' | 'm') {
            let attached = &body[offset + flag.len_utf8()..];
            return execution(flag, attached);
        }
        if !matches!(
            flag,
            'b' | 'B' | 'd' | 'E' | 'i' | 'I' | 'O' | 'P' | 'q' | 's' | 'S' | 'u' | 'v' | 'x'
        ) {
            return None;
        }
    }
    None
}

fn python_runtime_script_paths(tokens: &[String]) -> Vec<String> {
    let mut index = 1;
    let mut parse_options = true;
    while index < tokens.len() {
        let token = &tokens[index];
        if parse_options && token == "--" {
            parse_options = false;
            index += 1;
            continue;
        }
        if parse_options {
            if python_execution_option_at(tokens, index).is_some() {
                return Vec::new();
            }
            if let Some((_, consumed)) = option_value_at(
                tokens,
                index,
                PYTHON_VALUE_OPTIONS,
                PYTHON_ATTACHED_VALUE_OPTIONS,
            ) {
                index += consumed;
                continue;
            }
            if token.starts_with('-') {
                index += 1;
                continue;
            }
        }
        return vec![token.to_string()];
    }
    Vec::new()
}

fn python_module_name(tokens: &[String]) -> Option<String> {
    let mut index = 1usize;
    while index < tokens.len() {
        let token = &tokens[index];
        if token == "--" {
            return None;
        }
        if let Some(execution) = python_execution_option_at(tokens, index) {
            return match execution {
                PythonExecutionOption::Module(module) => Some(module),
                PythonExecutionOption::Inline(_) => None,
            };
        }
        if let Some((_, consumed)) = option_value_at(
            tokens,
            index,
            PYTHON_VALUE_OPTIONS,
            PYTHON_ATTACHED_VALUE_OPTIONS,
        ) {
            index += consumed;
        } else if token.starts_with('-') {
            index += 1;
        } else {
            return None;
        }
    }
    None
}

fn local_python_module_candidates(root: &Path, module: &str) -> Vec<String> {
    let components: Vec<&str> = module.split('.').collect();
    if components.is_empty()
        || components.iter().any(|component| {
            component.is_empty()
                || !component
                    .chars()
                    .all(|ch| ch == '_' || ch.is_alphanumeric())
        })
    {
        return Vec::new();
    }

    let mut paths = Vec::new();
    let mut module_path = root.to_path_buf();
    for (index, component) in components.iter().enumerate() {
        module_path.push(component);
        if index + 1 < components.len() {
            let init = module_path.join("__init__.py");
            if init.is_file() {
                paths.push(init.to_string_lossy().to_string());
            }
        }
    }

    let module_file = module_path.with_extension("py");
    if module_file.is_file() {
        paths.push(module_file.to_string_lossy().to_string());
    }
    for package_file in [
        module_path.join("__init__.py"),
        module_path.join("__main__.py"),
    ] {
        if package_file.is_file() {
            paths.push(package_file.to_string_lossy().to_string());
        }
    }
    paths
}

fn python_local_module_paths(command: &str, workdir: Option<&str>) -> Vec<String> {
    fn collect(command: &str, root: &Path, powershell_payload: bool, paths: &mut Vec<String>) {
        for segment in runtime_command_segments(command, powershell_payload) {
            let tokens = runtime_command_tokens(&segment, powershell_payload);
            let first = tokens.first().map(|token| token_command_name(token));
            if first.as_deref().is_some_and(|name| {
                name == "python" || name == "python3" || name == "py" || name.starts_with("python")
            }) {
                if let Some(module) = python_module_name(&tokens) {
                    paths.extend(local_python_module_candidates(root, &module));
                }
            }
            if let Some(payload) = cmd_command_payload(&segment) {
                collect(&payload, root, false, paths);
            }
            if let Some(payload) = powershell_command_payload(&tokens) {
                collect(&payload, root, true, paths);
            }
        }
    }

    let root = match workdir {
        Some(workdir) if Path::new(workdir).is_absolute() => PathBuf::from(workdir),
        Some(workdir) => {
            let Ok(current_dir) = std::env::current_dir() else {
                return Vec::new();
            };
            current_dir.join(workdir)
        }
        None => {
            let Ok(current_dir) = std::env::current_dir() else {
                return Vec::new();
            };
            current_dir
        }
    };
    let mut paths = Vec::new();
    collect(command, &root, false, &mut paths);
    paths.sort_by_key(|path| script_path_dedup_key(path));
    paths.dedup_by(|left, right| script_paths_equal(left, right));
    paths
}

fn node_inspect_endpoint(candidate: &str) -> bool {
    if has_script_uri_scheme(candidate) {
        return true;
    }
    if is_path_like_script_specifier(candidate) {
        return false;
    }
    let Some((host, port)) = candidate.rsplit_once(':') else {
        return false;
    };
    !host.is_empty() && !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit())
}

fn node_runtime_script_paths(tokens: &[String]) -> Vec<String> {
    let mut paths = Vec::new();
    let mut index = 1;
    let mut parse_options = true;
    while index < tokens.len() {
        let token = &tokens[index];
        let lower = if token.starts_with("--") {
            token.to_ascii_lowercase().replace('_', "-")
        } else {
            token.to_ascii_lowercase()
        };
        if parse_options && lower == "--" {
            parse_options = false;
            index += 1;
            continue;
        }
        if parse_options {
            if lower == "--run" || lower.starts_with("--run=") {
                return paths;
            }
            if matches!(lower.as_str(), "-e" | "--eval" | "-p" | "--print")
                || (lower.starts_with("-e") && lower.len() > 2)
                || (lower.starts_with("-p") && lower.len() > 2)
                || lower.starts_with("--eval=")
                || lower.starts_with("--print=")
            {
                return paths;
            }
            if let Some((value, consumed)) = option_value_at(
                tokens,
                index,
                NODE_VALUE_OPTIONS,
                NODE_ATTACHED_VALUE_OPTIONS,
            ) {
                let option_name = option_name_at(
                    tokens,
                    index,
                    NODE_VALUE_OPTIONS,
                    NODE_ATTACHED_VALUE_OPTIONS,
                );
                if option_name
                    .is_some_and(|option| NODE_EXECUTABLE_MODULE_OPTIONS.contains(&option))
                {
                    if let Some(value) = value {
                        if is_path_like_script_specifier(&value)
                            && is_script_extension(&value, JAVASCRIPT_SCRIPT_EXTENSIONS)
                        {
                            paths.push(value);
                        }
                    }
                }
                index += consumed;
                continue;
            }
            if token.starts_with('-') {
                index += 1;
                continue;
            }
            if lower == "inspect" {
                let mut inspect_index = index + 1;
                while inspect_index < tokens.len() {
                    let candidate = &tokens[inspect_index];
                    if matches!(candidate.as_str(), "-p" | "--port" | "--host") {
                        inspect_index += 2;
                        continue;
                    }
                    if candidate.starts_with('-') {
                        inspect_index += 1;
                        continue;
                    }
                    if node_inspect_endpoint(candidate) {
                        return paths;
                    }
                    paths.push(candidate.to_string());
                    break;
                }
                return paths;
            }
        }
        paths.push(token.to_string());
        break;
    }
    paths
}

fn deno_runtime_script_paths(tokens: &[String]) -> Vec<String> {
    const NON_ENTRY_COMMANDS: &[&str] = &[
        "add",
        "cache",
        "check",
        "clean",
        "completions",
        "coverage",
        "doc",
        "eval",
        "fmt",
        "help",
        "info",
        "init",
        "install",
        "jupyter",
        "lint",
        "lsp",
        "outdated",
        "publish",
        "remove",
        "repl",
        "task",
        "types",
        "uninstall",
        "upgrade",
        "vendor",
    ];

    let mut paths = Vec::new();
    let mut index = 1;
    while index < tokens.len() {
        let token = &tokens[index];
        if token == "--" {
            index += 1;
            break;
        }
        let lower = token.to_ascii_lowercase();
        if DENO_ATTACHED_ONLY_VALUE_OPTIONS
            .iter()
            .any(|option| lower == *option || lower.starts_with(&format!("{}=", option)))
        {
            index += 1;
            continue;
        }
        if let Some((value, consumed)) = option_value_at(
            tokens,
            index,
            DENO_VALUE_OPTIONS,
            DENO_ATTACHED_VALUE_OPTIONS,
        ) {
            if DENO_PRELOAD_OPTIONS
                .iter()
                .any(|option| lower == *option || lower.starts_with(&format!("{}=", option)))
            {
                if let Some(value) = value {
                    if is_path_like_script_specifier(&value)
                        && is_script_extension(&value, JAVASCRIPT_SCRIPT_EXTENSIONS)
                    {
                        paths.push(value);
                    }
                }
            }
            index += consumed;
            continue;
        }
        if token.starts_with('-') {
            index += 1;
            continue;
        }
        break;
    }
    let Some(command_or_entry) = tokens.get(index) else {
        return paths;
    };
    let command = command_or_entry.to_ascii_lowercase();
    if NON_ENTRY_COMMANDS.contains(&command.as_str()) {
        return paths;
    }

    let mode = if matches!(
        command.as_str(),
        "run" | "compile" | "test" | "bench" | "serve" | "watch"
    ) {
        index += 1;
        command
    } else {
        "run".to_string()
    };
    let (mode_value_options, mode_attached_options) =
        runtime_mode_value_options("deno", Some(&mode));
    let mut parse_options = true;
    while index < tokens.len() {
        let token = &tokens[index];
        if parse_options && token == "--" {
            parse_options = false;
            index += 1;
            continue;
        }
        if parse_options {
            let lower = token.to_ascii_lowercase();
            if DENO_ATTACHED_ONLY_VALUE_OPTIONS
                .iter()
                .any(|option| lower == *option || lower.starts_with(&format!("{}=", option)))
            {
                index += 1;
                continue;
            }
            if let Some((value, consumed)) = option_value_at(
                tokens,
                index,
                DENO_VALUE_OPTIONS,
                DENO_ATTACHED_VALUE_OPTIONS,
            ) {
                if DENO_PRELOAD_OPTIONS
                    .iter()
                    .any(|option| lower == *option || lower.starts_with(&format!("{}=", option)))
                {
                    if let Some(value) = value {
                        if is_path_like_script_specifier(&value)
                            && is_script_extension(&value, JAVASCRIPT_SCRIPT_EXTENSIONS)
                        {
                            paths.push(value);
                        }
                    }
                }
                index += consumed;
                continue;
            }
            if let Some((_, consumed)) =
                option_value_at(tokens, index, mode_value_options, mode_attached_options)
            {
                index += consumed;
                continue;
            }
            if token.starts_with('-') {
                index += 1;
                continue;
            }
        }
        if token.contains("://") {
            return paths;
        }
        if matches!(mode.as_str(), "test" | "bench") {
            if !parse_options {
                break;
            }
            if is_script_extension(token, JAVASCRIPT_SCRIPT_EXTENSIONS) {
                paths.push(token.to_string());
            }
            index += 1;
            continue;
        }
        paths.push(token.to_string());
        break;
    }
    paths
}

fn bun_runtime_script_paths(tokens: &[String]) -> Vec<String> {
    const NON_ENTRY_COMMANDS: &[&str] = &[
        "add", "audit", "build", "create", "help", "info", "init", "install", "link", "outdated",
        "patch", "pm", "publish", "remove", "repl", "unlink", "update", "upgrade", "why", "x",
    ];

    let mut paths = Vec::new();
    let mut index = 1;
    let mut parse_options = true;
    while index < tokens.len() {
        let token = &tokens[index];
        let lower = token.to_ascii_lowercase();
        if parse_options && token == "--" {
            parse_options = false;
            index += 1;
            continue;
        }
        if parse_options {
            if matches!(lower.as_str(), "-e" | "--eval" | "-p" | "--print")
                || lower.starts_with("--eval=")
                || lower.starts_with("--print=")
            {
                return paths;
            }
            if let Some((value, consumed)) =
                option_value_at(tokens, index, BUN_VALUE_OPTIONS, BUN_ATTACHED_VALUE_OPTIONS)
            {
                if option_name_at(tokens, index, BUN_VALUE_OPTIONS, BUN_ATTACHED_VALUE_OPTIONS)
                    .is_some_and(|option| BUN_PRELOAD_OPTIONS.contains(&option))
                {
                    if let Some(value) = value {
                        if is_path_like_script_specifier(&value)
                            && is_script_extension(&value, JAVASCRIPT_SCRIPT_EXTENSIONS)
                        {
                            paths.push(value);
                        }
                    }
                }
                index += consumed;
                continue;
            }
            if token.starts_with('-') {
                index += 1;
                continue;
            }
        }
        break;
    }

    let Some(command_or_entry) = tokens.get(index) else {
        return paths;
    };
    let command = command_or_entry.to_ascii_lowercase();
    if NON_ENTRY_COMMANDS.contains(&command.as_str()) {
        return paths;
    }
    if command == "run" {
        index += 1;
        while index < tokens.len() {
            let token = &tokens[index];
            if token == "--" {
                index += 1;
                break;
            }
            if let Some((value, consumed)) =
                option_value_at(tokens, index, BUN_VALUE_OPTIONS, BUN_ATTACHED_VALUE_OPTIONS)
            {
                if option_name_at(tokens, index, BUN_VALUE_OPTIONS, BUN_ATTACHED_VALUE_OPTIONS)
                    .is_some_and(|option| BUN_PRELOAD_OPTIONS.contains(&option))
                {
                    if let Some(value) = value {
                        if is_path_like_script_specifier(&value)
                            && is_script_extension(&value, JAVASCRIPT_SCRIPT_EXTENSIONS)
                        {
                            paths.push(value);
                        }
                    }
                }
                index += consumed;
                continue;
            }
            if let Some((_, consumed)) = option_value_at(tokens, index, BUN_RUN_VALUE_OPTIONS, &[])
            {
                index += consumed;
                continue;
            }
            if token.starts_with('-') {
                index += 1;
                continue;
            }
            break;
        }
        if let Some(candidate) = tokens.get(index) {
            if is_script_extension(candidate, JAVASCRIPT_SCRIPT_EXTENSIONS)
                || is_path_like_script_specifier(candidate)
            {
                paths.push(candidate.to_string());
            }
        }
        return paths;
    }
    if command == "test" {
        index += 1;
        while index < tokens.len() {
            let candidate = &tokens[index];
            if candidate == "--" {
                break;
            }
            if let Some((value, consumed)) =
                option_value_at(tokens, index, BUN_VALUE_OPTIONS, BUN_ATTACHED_VALUE_OPTIONS)
            {
                if option_name_at(tokens, index, BUN_VALUE_OPTIONS, BUN_ATTACHED_VALUE_OPTIONS)
                    .is_some_and(|option| BUN_PRELOAD_OPTIONS.contains(&option))
                {
                    if let Some(value) = value {
                        if is_path_like_script_specifier(&value)
                            && is_script_extension(&value, JAVASCRIPT_SCRIPT_EXTENSIONS)
                        {
                            paths.push(value);
                        }
                    }
                }
                index += consumed;
                continue;
            }
            if let Some((_, consumed)) = option_value_at(
                tokens,
                index,
                BUN_TEST_VALUE_OPTIONS,
                BUN_TEST_ATTACHED_VALUE_OPTIONS,
            ) {
                index += consumed;
                continue;
            }
            if candidate.starts_with('-') {
                index += 1;
                continue;
            }
            if is_path_like_script_specifier(candidate)
                && is_script_extension(candidate, JAVASCRIPT_SCRIPT_EXTENSIONS)
            {
                paths.push(candidate.to_string());
            }
            index += 1;
        }
        return paths;
    }

    paths.push(command_or_entry.to_string());
    paths
}

fn known_runtime_script_paths(tokens: &[String]) -> Option<Vec<String>> {
    let first = token_command_name(tokens.first()?);
    if first == "python" || first == "python3" || first == "py" || first.starts_with("python") {
        return Some(python_runtime_script_paths(tokens));
    }
    if matches!(first.as_str(), "node" | "nodejs") {
        return Some(node_runtime_script_paths(tokens));
    }
    if first == "deno" {
        return Some(deno_runtime_script_paths(tokens));
    }
    if first == "bun" {
        return Some(bun_runtime_script_paths(tokens));
    }
    None
}

fn runtime_preload_is_ambiguous(tokens: &[String], runtime: &str) -> bool {
    let preload_options = match runtime {
        "node" | "nodejs" => NODE_EXECUTABLE_MODULE_OPTIONS,
        "deno" => DENO_PRELOAD_OPTIONS,
        "bun" => BUN_PRELOAD_OPTIONS,
        _ => &[],
    };
    let (value_options, attached_options) = runtime_value_options(runtime);
    for index in runtime_launcher_option_indices(tokens, runtime) {
        if matches!(runtime, "node" | "nodejs")
            && option_name_at(tokens, index, NODE_AMBIGUOUS_CONFIG_OPTIONS, &[]).is_some()
        {
            return true;
        }
        let Some(option) = option_name_at(tokens, index, value_options, attached_options) else {
            continue;
        };
        if !preload_options.contains(&option) {
            continue;
        }
        let Some((value, _)) = option_value_at(tokens, index, value_options, attached_options)
        else {
            return true;
        };
        let Some(value) = value else {
            return true;
        };
        if has_script_uri_scheme(&value)
            || (is_path_like_script_specifier(&value)
                && !is_script_extension(&value, JAVASCRIPT_SCRIPT_EXTENSIONS))
        {
            return true;
        }
    }
    false
}

fn deno_remote_entry_is_ambiguous(tokens: &[String]) -> bool {
    let mut mode = None;
    let mut parse_options = true;
    let mut index = 1usize;
    while index < tokens.len() {
        let token = &tokens[index];
        let lower = token.to_ascii_lowercase();
        if mode.is_none() && DENO_EXECUTION_MODES.contains(&lower.as_str()) {
            mode = Some(lower);
            index += 1;
            continue;
        }
        if parse_options && token == "--" {
            if matches!(mode.as_deref(), Some("test" | "bench")) {
                return false;
            }
            parse_options = false;
            index += 1;
            continue;
        }
        if parse_options {
            if DENO_ATTACHED_ONLY_VALUE_OPTIONS
                .iter()
                .any(|option| lower == *option || lower.starts_with(&format!("{}=", option)))
            {
                index += 1;
                continue;
            }
            if let Some((_, consumed)) = option_value_at(
                tokens,
                index,
                DENO_VALUE_OPTIONS,
                DENO_ATTACHED_VALUE_OPTIONS,
            ) {
                index += consumed;
                continue;
            }
            let (mode_value_options, mode_attached_options) =
                runtime_mode_value_options("deno", mode.as_deref());
            if let Some((_, consumed)) =
                option_value_at(tokens, index, mode_value_options, mode_attached_options)
            {
                index += consumed;
                continue;
            }
            if token.starts_with('-') {
                index += 1;
                continue;
            }
        }
        if has_script_uri_scheme(token) {
            return true;
        }
        if matches!(mode.as_deref(), Some("test" | "bench")) {
            index += 1;
            continue;
        }
        return false;
    }
    false
}

fn runtime_cwd_option_precedes_entry(tokens: &[String], runtime: &str) -> bool {
    !matches!(runtime, "node" | "nodejs")
        && runtime_launcher_option_indices(tokens, runtime)
            .into_iter()
            .any(|index| {
                let lower = tokens[index].to_ascii_lowercase().replace('_', "-");
                lower == "--cwd" || lower.starts_with("--cwd=")
            })
}

fn powershell_workdir_option_precedes_entry(tokens: &[String]) -> bool {
    let mut index = 1usize;
    while index < tokens.len() {
        let token = &tokens[index];
        let lower = token.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "-file" | "-f" | "-command" | "-c" | "-commandwithargs"
        ) {
            return false;
        }
        let normalized = token
            .trim_start_matches(['-', '/'])
            .split([':', '='])
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(normalized.as_str(), "workingdirectory" | "wd") {
            return true;
        }
        if powershell_launcher_option_consumes_value(token) {
            index += 2;
        } else if token.starts_with(['-', '/']) {
            index += 1;
        } else {
            return false;
        }
    }
    false
}

fn ambiguous_script_invocation(command: &str) -> Option<String> {
    ambiguous_script_invocation_with_dialect(command, false)
}

fn ambiguous_script_invocation_with_dialect(
    command: &str,
    powershell_payload: bool,
) -> Option<String> {
    let mut changed_workdir = false;
    for segment in runtime_command_segments(command, powershell_payload) {
        let tokens = runtime_command_tokens(&segment, powershell_payload);
        let Some(first) = tokens.first().map(|token| token_command_name(token)) else {
            continue;
        };
        if matches!(
            first.as_str(),
            "cd" | "chdir" | "pushd" | "set-location" | "sl"
        ) {
            changed_workdir = true;
            continue;
        }

        let cmd_payload = cmd_command_payload(&segment);
        let powershell_payload = powershell_command_payload(&tokens);
        let has_script_entry = extract_script_path(&segment).is_some()
            || known_runtime_script_paths(&tokens).is_some_and(|paths| !paths.is_empty())
            || (first == "call"
                && tokens
                    .iter()
                    .skip(1)
                    .any(|token| is_script_extension(token, &[".bat", ".cmd"])))
            || cmd_payload.as_deref().is_some_and(|payload| {
                !extract_script_paths_with_dialect(payload, false).is_empty()
            })
            || powershell_payload.as_deref().is_some_and(|payload| {
                !extract_script_paths_with_dialect(payload, true).is_empty()
            });
        if changed_workdir && has_script_entry {
            return Some(
                "the command changes directory before launching a script; pass that directory as the exec workdir and use an explicit local entrypoint"
                    .to_string(),
            );
        }

        if matches!(first.as_str(), "node" | "nodejs" | "deno" | "bun") {
            if runtime_cwd_option_precedes_entry(&tokens, &first) {
                return Some(
                    "the runtime changes its script working directory; pass that directory as the exec workdir instead"
                        .to_string(),
                );
            }
            if runtime_preload_is_ambiguous(&tokens, &first) {
                return Some(
                    "a preload, loader, or runtime configuration cannot be mapped to one explicit local source file; use an explicit local file with a supported extension"
                        .to_string(),
                );
            }
            if first == "deno" && deno_remote_entry_is_ambiguous(&tokens) {
                return Some(
                    "the Deno entrypoint is remote; use an explicit local file so it can be scanned"
                        .to_string(),
                );
            }
        }
        if matches!(first.as_str(), "powershell" | "pwsh")
            && powershell_workdir_option_precedes_entry(&tokens)
        {
            return Some(
                "PowerShell changes its script working directory; pass that directory as the exec workdir instead"
                    .to_string(),
            );
        }
        if let Some(payload) = cmd_payload {
            if let Some(detail) = ambiguous_script_invocation_with_dialect(&payload, false) {
                return Some(detail);
            }
        }
        if let Some(payload) = powershell_payload {
            if let Some(detail) = ambiguous_script_invocation_with_dialect(&payload, true) {
                return Some(detail);
            }
        }
    }
    None
}

fn inline_option_source(
    tokens: &[String],
    index: usize,
    short_options: &[&str],
    long_options: &[&str],
) -> Option<(String, usize)> {
    let token = tokens.get(index)?;
    if short_options.contains(&token.as_str()) || long_options.contains(&token.as_str()) {
        return tokens.get(index + 1).cloned().map(|source| (source, 2));
    }
    for option in short_options {
        if token.starts_with(option) && token.len() > option.len() {
            return Some((token[option.len()..].to_string(), 1));
        }
    }
    let lower = token.to_ascii_lowercase().replace('_', "-");
    for option in long_options {
        let prefix = format!("{}=", option);
        if lower.starts_with(&prefix) {
            return Some((token[prefix.len()..].to_string(), 1));
        }
    }
    None
}

fn inline_script_sources(command: &str) -> Vec<(String, &'static str, String)> {
    inline_script_sources_with_dialect(command, false)
}

fn inline_script_sources_with_dialect(
    command: &str,
    powershell_payload: bool,
) -> Vec<(String, &'static str, String)> {
    let mut sources = Vec::new();
    for segment in runtime_command_segments(command, powershell_payload) {
        let tokens = runtime_command_tokens(&segment, powershell_payload);
        let Some(first) = tokens.first().map(|token| token_command_name(token)) else {
            continue;
        };

        if matches!(first.as_str(), "powershell" | "pwsh") {
            if let Some(payload) = powershell_command_payload(&tokens) {
                sources.push((format!("<{} -Command>", first), "ps1", payload.clone()));
                sources.extend(inline_script_sources_with_dialect(&payload, true));
            }
            continue;
        }

        if first == "python" || first == "python3" || first == "py" || first.starts_with("python") {
            let mut index = 1usize;
            while index < tokens.len() {
                let token = &tokens[index];
                if let Some(execution) = python_execution_option_at(&tokens, index) {
                    if let PythonExecutionOption::Inline(source) = execution {
                        sources.push((format!("<{} -c>", first), "py", source));
                    }
                    break;
                }
                if token == "--" {
                    break;
                }
                if let Some((_, consumed)) = option_value_at(
                    &tokens,
                    index,
                    PYTHON_VALUE_OPTIONS,
                    PYTHON_ATTACHED_VALUE_OPTIONS,
                ) {
                    index += consumed;
                } else if token.starts_with('-') {
                    index += 1;
                } else {
                    break;
                }
            }
            continue;
        }

        if matches!(first.as_str(), "node" | "nodejs" | "bun") {
            let mut index = 1usize;
            while index < tokens.len() {
                let token = &tokens[index];
                if token == "-pe" {
                    if let Some(source) = tokens.get(index + 1) {
                        sources.push((format!("<{} inline>", first), "js", source.to_string()));
                    }
                    break;
                }
                if let Some((source, _)) =
                    inline_option_source(&tokens, index, &["-e", "-p"], &["--eval", "--print"])
                {
                    sources.push((format!("<{} inline>", first), "js", source));
                    break;
                }
                let (value_options, attached_options) = if first == "bun" {
                    (BUN_VALUE_OPTIONS, BUN_ATTACHED_VALUE_OPTIONS)
                } else {
                    (NODE_VALUE_OPTIONS, NODE_ATTACHED_VALUE_OPTIONS)
                };
                if let Some((_, consumed)) =
                    option_value_at(&tokens, index, value_options, attached_options)
                {
                    index += consumed;
                } else if token.starts_with('-') {
                    index += 1;
                } else {
                    break;
                }
            }
            continue;
        }

        if first == "deno" {
            let mut eval_index = 1usize;
            while eval_index < tokens.len() {
                let token = &tokens[eval_index];
                if let Some((_, consumed)) = option_value_at(
                    &tokens,
                    eval_index,
                    DENO_VALUE_OPTIONS,
                    DENO_ATTACHED_VALUE_OPTIONS,
                ) {
                    eval_index += consumed;
                } else if token.starts_with('-') {
                    eval_index += 1;
                } else {
                    break;
                }
            }
            if tokens
                .get(eval_index)
                .is_none_or(|token| !token.eq_ignore_ascii_case("eval"))
            {
                continue;
            }
            let mut index = eval_index + 1;
            let mut parse_options = true;
            while index < tokens.len() {
                let token = &tokens[index];
                if parse_options && token == "--" {
                    parse_options = false;
                    index += 1;
                    continue;
                }
                if parse_options {
                    if DENO_ATTACHED_ONLY_VALUE_OPTIONS.iter().any(|option| {
                        let lower = token.to_ascii_lowercase();
                        lower == *option || lower.starts_with(&format!("{}=", option))
                    }) {
                        index += 1;
                        continue;
                    }
                    if let Some((_, consumed)) = option_value_at(
                        &tokens,
                        index,
                        DENO_VALUE_OPTIONS,
                        DENO_ATTACHED_VALUE_OPTIONS,
                    ) {
                        index += consumed;
                        continue;
                    }
                    if token.starts_with('-') {
                        index += 1;
                        continue;
                    }
                }
                sources.push(("<deno eval>".to_string(), "js", token.to_string()));
                break;
            }
        }

        if let Some(payload) = cmd_command_payload(&segment) {
            sources.extend(inline_script_sources_with_dialect(&payload, false));
        }
    }
    sources
}

/// 从命令中提取脚本文件路径
///
/// 识别多种脚本执行模式：
/// - `powershell -File script.ps1` / `pwsh -File script.ps1`
/// - `python script.py` / `python3 script.pyw`
/// - `node script.js` / `bun script.mjs` / `deno run script.ts`
/// - `cmd /d /s /c script.cmd`
/// - `csc.exe source.cs`（编译源码，需检查源码内容）
/// - 直接执行：`script.bat`、`./script.ps1` 等
fn powershell_script_path_from_tokens(tokens: &[String]) -> Option<String> {
    let launcher_index = tokens
        .iter()
        .position(|token| matches!(token_command_name(token).as_str(), "powershell" | "pwsh"))?;
    let mut index = launcher_index + 1;
    while let Some(part) = tokens.get(index) {
        let lower = part.to_ascii_lowercase();
        if matches!(lower.as_str(), "-file" | "-f") {
            return tokens
                .get(index + 1)
                .map(|path| path.trim_matches(|ch| matches!(ch, '\'' | '"')).to_string());
        }
        if matches!(lower.as_str(), "-command" | "-c" | "-commandwithargs") {
            let payload = tokens[index + 1..].join(" ");
            return literal_powershell_script_path(&payload);
        }
        if powershell_launcher_option_consumes_value(part) {
            index += 2;
            continue;
        }
        if part.starts_with('-') {
            index += 1;
            continue;
        }

        let candidate = part.trim_matches(|ch| matches!(ch, '\'' | '"'));
        return is_script_extension(candidate, &[".ps1"]).then(|| candidate.to_string());
    }
    None
}

fn extract_script_path(command: &str) -> Option<String> {
    let tokens = split_shell_tokens(command);

    if tokens.is_empty() {
        return None;
    }

    // 模式1: powershell/pwsh -File/-f script.ps1，或直接字面量脚本入口。
    if let Some(path) = powershell_script_path_from_tokens(&tokens) {
        return Some(path);
    }

    let first_command = token_command_name(&tokens[0]);

    // 模式2/3: Python 与 JavaScript runtimes。显式理解常见 consume-next 选项、
    // inline/eval 模式和 `--`，避免把 option value 或任务名误识别成脚本。
    if let Some(paths) = known_runtime_script_paths(&tokens) {
        return paths.into_iter().next();
    }

    // 模式3.5: Windows Script Host
    if matches!(first_command.as_str(), "cscript" | "wscript") {
        for part in &tokens[1..] {
            if part.starts_with('/') || part.starts_with('-') {
                continue;
            }
            return Some(part.to_string());
        }
    }

    // 模式3.6: 常见 TypeScript 文件启动器
    if matches!(first_command.as_str(), "npx" | "pnpm" | "yarn") {
        let invokes_ts_runner = tokens.iter().skip(1).any(|token| {
            matches!(
                token_command_name(token).as_str(),
                "tsx" | "ts-node" | "ts-node-esm"
            )
        });
        if invokes_ts_runner {
            if let Some(path) = tokens
                .iter()
                .skip(1)
                .find(|token| is_script_extension(token, &[".ts", ".mts", ".cts", ".tsx"]))
            {
                return Some(path.to_string());
            }
        }
    }

    // 模式4: cmd /d /s /c script.bat；支持组合开关与 ComSpec wrapper。
    if is_cmd_launcher_token(&tokens[0]) {
        if let Some(payload) = cmd_command_payload(command) {
            if let Some(path) = script_path_prefix(&payload, &[".bat", ".cmd"]) {
                return Some(path);
            }
            return extract_script_path(&payload);
        }
    }

    // 模式5: csc.exe source.cs（C# 编译器，需检查源码）
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

    // 模式6: 直接执行脚本文件
    let first = tokens[0].trim_start_matches("./").trim_start_matches(".\\");
    if is_script_extension(first, SCANNABLE_EXTENSIONS) {
        return Some(first.to_string());
    }

    None
}

fn split_top_level_script_commands(command: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut chars = command.chars().peekable();

    while let Some(ch) = chars.next() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '^' {
            current.push(ch);
            escaped = true;
            continue;
        }
        if let Some(close) = quote {
            current.push(ch);
            if ch == close {
                quote = None;
            }
            continue;
        }
        if let Some(close) = quote_closer(ch) {
            current.push(ch);
            quote = Some(close);
            continue;
        }
        if matches!(ch, '&' | '|' | ';' | '\r' | '\n') {
            if !current.trim().is_empty() {
                segments.push(current.trim().to_string());
            }
            current.clear();
            if chars.peek() == Some(&ch) {
                chars.next();
            }
            continue;
        }
        current.push(ch);
    }
    if !current.trim().is_empty() {
        segments.push(current.trim().to_string());
    }
    segments
}

fn split_powershell_top_level_script_commands(command: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut chars = command.chars().peekable();

    while let Some(ch) = chars.next() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '`' && quote != Some('\'') {
            current.push(ch);
            escaped = true;
            continue;
        }
        if let Some(close) = quote {
            current.push(ch);
            if ch == close {
                quote = None;
            }
            continue;
        }
        if matches!(ch, '\'' | '"') {
            current.push(ch);
            quote = Some(ch);
            continue;
        }
        let doubled_separator = matches!(ch, '&' | '|') && chars.peek() == Some(&ch);
        if doubled_separator || matches!(ch, '|' | ';' | '\r' | '\n') {
            if !current.trim().is_empty() {
                segments.push(current.trim().to_string());
            }
            current.clear();
            if doubled_separator {
                chars.next();
            }
            continue;
        }
        current.push(ch);
    }
    if !current.trim().is_empty() {
        segments.push(current.trim().to_string());
    }
    segments
}

fn runtime_command_segments(command: &str, powershell_payload: bool) -> Vec<String> {
    if powershell_payload {
        split_powershell_top_level_script_commands(command)
    } else {
        split_top_level_script_commands(command)
    }
}

fn runtime_command_tokens(command: &str, powershell_payload: bool) -> Vec<String> {
    if powershell_payload {
        let mut tokens = split_powershell_literal_tokens(command);
        if tokens
            .first()
            .is_some_and(|token| matches!(token.as_str(), "." | "&"))
        {
            tokens.remove(0);
        }
        tokens
    } else {
        split_shell_tokens(command)
    }
}

fn cmd_command_payload(command: &str) -> Option<String> {
    let tokens = split_shell_tokens(command);
    if !is_cmd_launcher_token(tokens.first()?) {
        return None;
    }
    let lower = command.to_ascii_lowercase();
    for (position, _) in lower.match_indices("/c") {
        let before = lower[..position].chars().next_back();
        let after = lower[position + 2..].chars().next();
        if (before.is_none_or(char::is_whitespace)
            || is_combined_cmd_switch_prefix(command, position))
            && after.is_none_or(|ch| ch.is_whitespace() || matches!(ch, '\'' | '"'))
        {
            let payload = command[position + 2..].trim();
            let payload = if payload.len() >= 2 {
                let first = payload.chars().next().unwrap_or_default();
                let last = payload.chars().next_back().unwrap_or_default();
                if quote_closer(first) == Some(last) {
                    &payload[first.len_utf8()..payload.len() - last.len_utf8()]
                } else {
                    payload
                }
            } else {
                payload
            };
            return (!payload.trim().is_empty()).then(|| payload.trim().to_string());
        }
    }
    None
}

fn powershell_command_payload(tokens: &[String]) -> Option<String> {
    let first = token_command_name(tokens.first()?);
    if !matches!(first.as_str(), "powershell" | "pwsh") {
        return None;
    }
    let mut index = 1usize;
    while index < tokens.len() {
        let token = &tokens[index];
        let lower = token.to_ascii_lowercase();
        if matches!(lower.as_str(), "-file" | "-f") {
            return None;
        }
        if matches!(lower.as_str(), "-command" | "-c" | "-commandwithargs") {
            let payload = tokens[index + 1..].join(" ");
            return (!payload.trim().is_empty()).then_some(payload);
        }
        if powershell_launcher_option_consumes_value(token) {
            index += 2;
        } else if token.starts_with(['-', '/']) {
            index += 1;
        } else {
            return None;
        }
    }
    None
}

fn leading_quoted_literal(input: &str) -> Option<String> {
    let input = input.trim_start();
    let quote = input.chars().next()?;
    if !matches!(quote, '\'' | '"' | '`') {
        return None;
    }

    let mut value = String::new();
    let mut escaped = false;
    for ch in input[quote.len_utf8()..].chars() {
        if escaped {
            value.push(ch);
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
            value.push(ch);
        } else if ch == quote {
            return Some(value);
        } else {
            value.push(ch);
        }
    }
    None
}

/// Parse one literal argv/list expression without evaluating source code. This intentionally
/// accepts only quoted scalar elements so a dynamic value cannot be mistaken for a statically
/// known launcher argument.
fn leading_literal_argv(input: &str) -> Option<Vec<String>> {
    let input = input.trim_start();
    let (mut index, close) = if input.starts_with("@(") {
        (2usize, ')')
    } else if input.starts_with('[') {
        (1usize, ']')
    } else if input.starts_with('(') {
        (1usize, ')')
    } else {
        return None;
    };
    let chars: Vec<char> = input.chars().collect();
    let mut values = Vec::new();

    loop {
        while chars
            .get(index)
            .is_some_and(|ch| ch.is_whitespace() || *ch == ',')
        {
            index += 1;
        }
        if chars.get(index) == Some(&close) {
            return (!values.is_empty()).then_some(values);
        }

        let quote = *chars.get(index)?;
        if !matches!(quote, '\'' | '"') {
            return None;
        }
        index += 1;
        let mut value = String::new();
        let mut escaped = false;
        let mut closed = false;
        while let Some(ch) = chars.get(index).copied() {
            index += 1;
            if escaped {
                value.push(ch);
                escaped = false;
            } else if matches!(ch, '\\' | '`') {
                escaped = true;
                value.push(ch);
            } else if ch == quote {
                if chars.get(index) == Some(&quote) {
                    value.push(quote);
                    index += 1;
                } else {
                    closed = true;
                    break;
                }
            } else {
                value.push(ch);
            }
        }
        if !closed {
            return None;
        }
        values.push(value);

        while chars.get(index).is_some_and(|ch| ch.is_whitespace()) {
            index += 1;
        }
        match chars.get(index) {
            Some(ch) if *ch == ',' => index += 1,
            Some(ch) if *ch == close => return Some(values),
            _ => return None,
        }
    }
}

#[cfg(windows)]
fn script_path_dedup_key(path: &str) -> String {
    path.to_ascii_lowercase()
}

#[cfg(not(windows))]
fn script_path_dedup_key(path: &str) -> String {
    path.to_string()
}

fn script_paths_equal(left: &str, right: &str) -> bool {
    script_path_dedup_key(left) == script_path_dedup_key(right)
}

fn extract_script_paths(command: &str) -> Vec<String> {
    extract_script_paths_with_dialect(command, false)
}

fn extract_script_paths_with_dialect(command: &str, powershell_payload: bool) -> Vec<String> {
    fn push_unique(
        paths: &mut Vec<String>,
        seen: &mut std::collections::HashSet<String>,
        path: String,
    ) {
        let key = script_path_dedup_key(&path);
        if seen.insert(key) {
            paths.push(path);
        }
    }

    let mut paths = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for segment in runtime_command_segments(command, powershell_payload) {
        let directly_extracted = if powershell_payload {
            powershell_script_path_from_tokens(&runtime_command_tokens(&segment, true))
        } else {
            extract_script_path(&segment)
        };
        if let Some(path) = directly_extracted {
            if !path.contains("&&")
                && !path.contains("||")
                && !path.contains('|')
                && !path.contains(';')
            {
                push_unique(&mut paths, &mut seen, path);
            }
        }

        let tokens = runtime_command_tokens(&segment, powershell_payload);
        let first = tokens.first().map(|token| token_command_name(token));
        if first.as_deref() == Some("call") {
            if let Some(path) = tokens
                .iter()
                .skip(1)
                .find(|token| is_script_extension(token, &[".bat", ".cmd"]))
            {
                push_unique(&mut paths, &mut seen, path.to_string());
            }
        }
        if let Some(runtime_paths) = known_runtime_script_paths(&tokens) {
            for path in runtime_paths {
                push_unique(&mut paths, &mut seen, path);
            }
        } else if first
            .as_deref()
            .is_some_and(|name| matches!(name, "cscript" | "wscript"))
        {
            if let Some(path) = tokens
                .iter()
                .skip(1)
                .find(|token| !token.starts_with('/') && !token.starts_with('-'))
            {
                push_unique(&mut paths, &mut seen, path.to_string());
            }
        } else if first.as_deref() == Some("csc") {
            for token in tokens.iter().skip(1) {
                if is_script_extension(token, &[".cs"]) {
                    push_unique(&mut paths, &mut seen, token.to_string());
                }
            }
        }

        if let Some(path) = tokens.first().filter(|token| {
            is_script_extension(
                token.trim_start_matches("./").trim_start_matches(".\\"),
                SCANNABLE_EXTENSIONS,
            )
        }) {
            push_unique(
                &mut paths,
                &mut seen,
                path.trim_start_matches("./")
                    .trim_start_matches(".\\")
                    .to_string(),
            );
        }

        let expanded_tokens = expand_powershell_command_tokens(&tokens);
        for window in expanded_tokens.windows(2) {
            let candidate = window[1].trim_matches(|ch| matches!(ch, '\'' | '"'));
            if matches!(window[0].as_str(), "." | "&")
                && is_script_extension(candidate, SCANNABLE_EXTENSIONS)
            {
                push_unique(&mut paths, &mut seen, candidate.to_string());
            }
        }

        if let Some(payload) = cmd_command_payload(&segment) {
            for path in extract_script_paths_with_dialect(&payload, false) {
                push_unique(&mut paths, &mut seen, path);
            }
        }
        if let Some(payload) = powershell_command_payload(&tokens) {
            for path in extract_script_paths_with_dialect(&payload, true) {
                push_unique(&mut paths, &mut seen, path);
            }
        }
    }
    paths
}

fn runtime_language_extension(command: &str, script_path: &str) -> Option<&'static str> {
    runtime_language_extension_with_dialect(command, script_path, false)
}

fn runtime_language_extension_with_dialect(
    command: &str,
    script_path: &str,
    powershell_payload: bool,
) -> Option<&'static str> {
    let normalized_script = script_path
        .trim_start_matches("./")
        .trim_start_matches(".\\");

    for segment in runtime_command_segments(command, powershell_payload) {
        let tokens = runtime_command_tokens(&segment, powershell_payload);
        let Some(first) = tokens.first().map(|token| token_command_name(token)) else {
            continue;
        };
        let mentions_script = tokens.iter().any(|token| {
            let token = token.trim_start_matches("./").trim_start_matches(".\\");
            script_paths_equal(token, normalized_script)
        });
        if mentions_script {
            if first == "python"
                || first == "python3"
                || first == "py"
                || first.starts_with("python")
            {
                return Some("py");
            }
            if matches!(first.as_str(), "node" | "nodejs" | "bun" | "deno") {
                return Some("js");
            }
            if matches!(first.as_str(), "cscript" | "wscript") {
                let explicit_engine = tokens.iter().find_map(|token| {
                    let normalized = token.trim_start_matches(['/', '-']).to_ascii_lowercase();
                    match normalized.as_str() {
                        "e:vbscript" | "engine:vbscript" => Some("vbs"),
                        "e:jscript" | "engine:jscript" => Some("js"),
                        _ => None,
                    }
                });
                if explicit_engine.is_some() {
                    return explicit_engine;
                }

                let lower_script_path = script_path.to_ascii_lowercase();
                return if lower_script_path.ends_with(".vbs") {
                    Some("vbs")
                } else if lower_script_path.ends_with(".js") {
                    Some("js")
                } else {
                    None
                };
            }
            if first == "csc" {
                return Some("cs");
            }
            if matches!(first.as_str(), "powershell" | "pwsh") {
                return Some("ps1");
            }
            if matches!(first.as_str(), "npx" | "pnpm" | "yarn")
                && tokens.iter().any(|token| {
                    matches!(
                        token_command_name(token).as_str(),
                        "tsx" | "ts-node" | "ts-node-esm"
                    )
                })
            {
                return Some("js");
            }
        }

        if let Some(payload) = cmd_command_payload(&segment) {
            if let Some(language) =
                runtime_language_extension_with_dialect(&payload, script_path, false)
            {
                return Some(language);
            }
        }
        if let Some(payload) = powershell_command_payload(&tokens) {
            if let Some(language) =
                runtime_language_extension_with_dialect(&payload, script_path, true)
            {
                return Some(language);
            }
        }
    }
    None
}

fn strip_script_strings_and_comments(content: &str, hash_comments: bool) -> String {
    if hash_comments {
        sanitize_python_text(content, true)
    } else {
        sanitize_script_text(content, true)
    }
}

fn strip_script_comments(content: &str, hash_comments: bool) -> String {
    if hash_comments {
        sanitize_python_text(content, false)
    } else {
        sanitize_script_text(content, false)
    }
}

fn strip_javascript_strings_and_comments(content: &str) -> String {
    sanitize_script_text_with_javascript_regex(content, true)
}

fn strip_javascript_comments(content: &str) -> String {
    sanitize_script_text_with_javascript_regex(content, false)
}

fn push_masked_char(output: &mut String, ch: char) {
    if matches!(ch, '\r' | '\n') {
        output.push(ch);
    } else {
        output.extend(std::iter::repeat_n(' ', ch.len_utf8()));
    }
}

fn sanitize_script_text(content: &str, strip_strings: bool) -> String {
    sanitize_script_text_internal(content, strip_strings, false)
}

fn sanitize_script_text_with_javascript_regex(content: &str, strip_strings: bool) -> String {
    sanitize_script_text_internal(content, strip_strings, true)
}

fn sanitize_script_text_internal(
    content: &str,
    strip_strings: bool,
    recognize_javascript_regex: bool,
) -> String {
    #[derive(Clone, Copy)]
    enum ScanState {
        Code,
        SingleQuoted,
        DoubleQuoted,
        TemplateQuoted,
        RegexLiteral,
        LineComment,
        BlockComment,
    }

    let mut output = String::with_capacity(content.len());
    let mut chars = content.chars().peekable();
    let mut state = ScanState::Code;
    let mut escaped = false;
    let mut regex_in_character_class = false;
    let mut javascript_regex_allowed = true;
    let mut javascript_identifier = String::new();

    fn finish_javascript_identifier(identifier: &mut String, regex_allowed: &mut bool) {
        if identifier.is_empty() {
            return;
        }
        *regex_allowed = matches!(
            identifier.as_str(),
            "await"
                | "case"
                | "delete"
                | "do"
                | "else"
                | "in"
                | "instanceof"
                | "new"
                | "of"
                | "return"
                | "throw"
                | "typeof"
                | "void"
                | "yield"
        );
        identifier.clear();
    }

    while let Some(ch) = chars.next() {
        match state {
            ScanState::Code => {
                if recognize_javascript_regex
                    && (ch.is_ascii_alphanumeric() || matches!(ch, '_' | '$'))
                {
                    output.push(ch);
                    javascript_identifier.push(ch.to_ascii_lowercase());
                } else {
                    if recognize_javascript_regex {
                        finish_javascript_identifier(
                            &mut javascript_identifier,
                            &mut javascript_regex_allowed,
                        );
                    }
                    if ch == '/' && chars.peek() == Some(&'/') {
                        chars.next();
                        output.push_str("  ");
                        state = ScanState::LineComment;
                    } else if ch == '/' && chars.peek() == Some(&'*') {
                        chars.next();
                        output.push_str("  ");
                        state = ScanState::BlockComment;
                    } else if ch == '\'' {
                        output.push(if strip_strings { ' ' } else { ch });
                        state = ScanState::SingleQuoted;
                    } else if ch == '"' {
                        output.push(if strip_strings { ' ' } else { ch });
                        state = ScanState::DoubleQuoted;
                    } else if ch == '`' {
                        output.push(if strip_strings { ' ' } else { ch });
                        state = ScanState::TemplateQuoted;
                        javascript_regex_allowed = false;
                    } else if recognize_javascript_regex && ch == '/' && javascript_regex_allowed {
                        output.push(if strip_strings { ' ' } else { ch });
                        state = ScanState::RegexLiteral;
                        escaped = false;
                        regex_in_character_class = false;
                    } else {
                        output.push(ch);
                        if recognize_javascript_regex && !ch.is_whitespace() {
                            javascript_regex_allowed = matches!(
                                ch,
                                '(' | '['
                                    | '{'
                                    | ','
                                    | ';'
                                    | ':'
                                    | '?'
                                    | '='
                                    | '!'
                                    | '&'
                                    | '|'
                                    | '+'
                                    | '-'
                                    | '*'
                                    | '%'
                                    | '^'
                                    | '~'
                                    | '<'
                                    | '>'
                            );
                        }
                    }
                }
            }
            ScanState::SingleQuoted => {
                if strip_strings {
                    push_masked_char(&mut output, ch);
                } else {
                    output.push(ch);
                }
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == '\'' {
                    state = ScanState::Code;
                    javascript_regex_allowed = false;
                }
            }
            ScanState::DoubleQuoted => {
                if strip_strings {
                    push_masked_char(&mut output, ch);
                } else {
                    output.push(ch);
                }
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == '"' {
                    state = ScanState::Code;
                    javascript_regex_allowed = false;
                }
            }
            ScanState::TemplateQuoted => {
                if strip_strings {
                    push_masked_char(&mut output, ch);
                } else {
                    output.push(ch);
                }
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == '`' {
                    state = ScanState::Code;
                    javascript_regex_allowed = false;
                }
            }
            ScanState::RegexLiteral => {
                if strip_strings {
                    push_masked_char(&mut output, ch);
                } else {
                    output.push(ch);
                }
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == '[' {
                    regex_in_character_class = true;
                } else if ch == ']' {
                    regex_in_character_class = false;
                } else if ch == '/' && !regex_in_character_class {
                    state = ScanState::Code;
                    javascript_regex_allowed = false;
                }
            }
            ScanState::LineComment => {
                if ch == '\n' {
                    output.push('\n');
                    state = ScanState::Code;
                } else {
                    push_masked_char(&mut output, ch);
                }
            }
            ScanState::BlockComment => {
                if ch == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    output.push_str("  ");
                    state = ScanState::Code;
                } else {
                    push_masked_char(&mut output, ch);
                }
            }
        }
    }

    output
}

fn sanitize_python_text(content: &str, strip_strings: bool) -> String {
    #[derive(Clone, Copy)]
    enum ScanState {
        Code,
        SingleQuoted,
        DoubleQuoted,
        TripleSingleQuoted,
        TripleDoubleQuoted,
        LineComment,
    }

    let chars: Vec<char> = content.chars().collect();
    let mut output = String::with_capacity(content.len());
    let mut state = ScanState::Code;
    let mut escaped = false;
    let mut index = 0usize;

    while index < chars.len() {
        let ch = chars[index];
        let triple_single = ch == '\''
            && chars.get(index + 1) == Some(&'\'')
            && chars.get(index + 2) == Some(&'\'');
        let triple_double =
            ch == '"' && chars.get(index + 1) == Some(&'"') && chars.get(index + 2) == Some(&'"');

        match state {
            ScanState::Code => {
                if ch == '#' {
                    push_masked_char(&mut output, ch);
                    state = ScanState::LineComment;
                } else if triple_single || triple_double {
                    for quote in &chars[index..index + 3] {
                        if strip_strings {
                            push_masked_char(&mut output, *quote);
                        } else {
                            output.push(*quote);
                        }
                    }
                    state = if triple_single {
                        ScanState::TripleSingleQuoted
                    } else {
                        ScanState::TripleDoubleQuoted
                    };
                    index += 2;
                } else if matches!(ch, '\'' | '"') {
                    if strip_strings {
                        push_masked_char(&mut output, ch);
                    } else {
                        output.push(ch);
                    }
                    state = if ch == '\'' {
                        ScanState::SingleQuoted
                    } else {
                        ScanState::DoubleQuoted
                    };
                } else {
                    output.push(ch);
                }
            }
            ScanState::SingleQuoted | ScanState::DoubleQuoted => {
                if strip_strings {
                    push_masked_char(&mut output, ch);
                } else {
                    output.push(ch);
                }
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if matches!(state, ScanState::SingleQuoted) && ch == '\''
                    || matches!(state, ScanState::DoubleQuoted) && ch == '"'
                {
                    state = ScanState::Code;
                }
            }
            ScanState::TripleSingleQuoted | ScanState::TripleDoubleQuoted => {
                let closes = matches!(state, ScanState::TripleSingleQuoted) && triple_single
                    || matches!(state, ScanState::TripleDoubleQuoted) && triple_double;
                if closes {
                    for quote in &chars[index..index + 3] {
                        if strip_strings {
                            push_masked_char(&mut output, *quote);
                        } else {
                            output.push(*quote);
                        }
                    }
                    state = ScanState::Code;
                    index += 2;
                } else if strip_strings {
                    push_masked_char(&mut output, ch);
                } else {
                    output.push(ch);
                }
            }
            ScanState::LineComment => {
                push_masked_char(&mut output, ch);
                if ch == '\n' {
                    state = ScanState::Code;
                }
            }
        }
        index += 1;
    }

    output
}

fn strip_powershell_strings_and_comments(content: &str) -> String {
    sanitize_powershell_text(content, true)
}

fn strip_powershell_comments(content: &str) -> String {
    sanitize_powershell_text(content, false)
}

fn sanitize_powershell_text(content: &str, strip_strings: bool) -> String {
    #[derive(Clone, Copy)]
    enum ScanState {
        Code,
        SingleQuoted,
        DoubleQuoted,
        SingleHereQuoted,
        DoubleHereQuoted,
        LineComment,
        BlockComment,
    }

    let mut output = String::with_capacity(content.len());
    let mut chars = content.chars().peekable();
    let mut state = ScanState::Code;
    let mut escaped = false;
    let mut line_only_whitespace = true;

    while let Some(ch) = chars.next() {
        match state {
            ScanState::Code => {
                if ch == '@' && chars.peek() == Some(&'\'') {
                    chars.next();
                    if strip_strings {
                        output.push_str("  ");
                    } else {
                        output.push_str("@'");
                    }
                    state = ScanState::SingleHereQuoted;
                } else if ch == '@' && chars.peek() == Some(&'"') {
                    chars.next();
                    if strip_strings {
                        output.push_str("  ");
                    } else {
                        output.push_str("@\"");
                    }
                    state = ScanState::DoubleHereQuoted;
                } else if ch == '<' && chars.peek() == Some(&'#') {
                    chars.next();
                    output.push_str("  ");
                    state = ScanState::BlockComment;
                } else if ch == '#' {
                    push_masked_char(&mut output, ch);
                    state = ScanState::LineComment;
                } else if ch == '\'' {
                    if strip_strings {
                        push_masked_char(&mut output, ch);
                    } else {
                        output.push(ch);
                    }
                    state = ScanState::SingleQuoted;
                } else if ch == '"' {
                    if strip_strings {
                        push_masked_char(&mut output, ch);
                    } else {
                        output.push(ch);
                    }
                    state = ScanState::DoubleQuoted;
                } else {
                    output.push(ch);
                }
            }
            ScanState::SingleQuoted => {
                if strip_strings {
                    push_masked_char(&mut output, ch);
                } else {
                    output.push(ch);
                }
                if ch == '\'' {
                    if chars.peek() == Some(&'\'') {
                        chars.next();
                        if strip_strings {
                            output.push(' ');
                        } else {
                            output.push('\'');
                        }
                    } else {
                        state = ScanState::Code;
                    }
                }
            }
            ScanState::DoubleQuoted => {
                if strip_strings {
                    push_masked_char(&mut output, ch);
                } else {
                    output.push(ch);
                }
                if escaped {
                    escaped = false;
                } else if ch == '`' {
                    escaped = true;
                } else if ch == '"' {
                    state = ScanState::Code;
                }
            }
            ScanState::SingleHereQuoted => {
                if line_only_whitespace && ch == '\'' && chars.peek() == Some(&'@') {
                    chars.next();
                    if strip_strings {
                        output.push_str("  ");
                    } else {
                        output.push_str("'@");
                    }
                    state = ScanState::Code;
                } else if strip_strings {
                    push_masked_char(&mut output, ch);
                } else {
                    output.push(ch);
                }
            }
            ScanState::DoubleHereQuoted => {
                if line_only_whitespace && ch == '"' && chars.peek() == Some(&'@') {
                    chars.next();
                    if strip_strings {
                        output.push_str("  ");
                    } else {
                        output.push_str("\"@");
                    }
                    state = ScanState::Code;
                } else if strip_strings {
                    push_masked_char(&mut output, ch);
                } else {
                    output.push(ch);
                }
            }
            ScanState::LineComment => {
                if ch == '\n' {
                    output.push('\n');
                    state = ScanState::Code;
                } else {
                    push_masked_char(&mut output, ch);
                }
            }
            ScanState::BlockComment => {
                if ch == '#' && chars.peek() == Some(&'>') {
                    chars.next();
                    output.push_str("  ");
                    state = ScanState::Code;
                } else {
                    push_masked_char(&mut output, ch);
                }
            }
        }
        if ch == '\n' {
            line_only_whitespace = true;
        } else if !ch.is_whitespace() {
            line_only_whitespace = false;
        }
    }

    output
}

fn split_batch_control_segments(line: &str) -> Vec<String> {
    let mut quoted = false;
    let mut escaped = false;
    let mut segment = String::new();
    let mut segments = Vec::new();

    for ch in line.chars() {
        if escaped {
            segment.push(ch);
            escaped = false;
        } else if ch == '^' {
            escaped = true;
            segment.push(ch);
        } else if ch == '"' {
            quoted = !quoted;
            segment.push(ch);
        } else if !quoted && matches!(ch, '&' | '|') {
            if !segment.is_empty() {
                segments.push(std::mem::take(&mut segment));
            }
        } else {
            segment.push(ch);
        }
    }
    if !segment.is_empty() {
        segments.push(segment);
    }
    segments
}

fn batch_segment_is_inert(segment: &str) -> bool {
    let trimmed = segment
        .trim_start()
        .trim_start_matches(['@', '('])
        .trim_start();
    let lower = trimmed.to_ascii_lowercase();
    lower.is_empty()
        || lower == "rem"
        || lower.starts_with("rem ")
        || lower.starts_with("::")
        || lower == "echo"
        || lower.starts_with("echo ")
        || lower.starts_with("echo.")
        || lower.starts_with("echo(")
        || lower == "set"
        || lower.starts_with("set ")
}

fn strip_batch_inert_lines(content: &str) -> String {
    let mut output = String::with_capacity(content.len());
    for line in content.lines() {
        for segment in split_batch_control_segments(line) {
            if !batch_segment_is_inert(&segment) {
                output.push_str(&segment);
                output.push(' ');
            }
        }
        output.push('\n');
    }
    output
}

fn sanitize_vbs_text(content: &str, strip_strings: bool) -> String {
    let mut output = String::with_capacity(content.len());
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed
            .get(..3)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("rem"))
            && trimmed.chars().nth(3).is_none_or(|ch| ch.is_whitespace())
        {
            for ch in line.chars() {
                push_masked_char(&mut output, ch);
            }
            output.push('\n');
            continue;
        }

        let mut chars = line.chars().peekable();
        let mut in_string = false;
        while let Some(ch) = chars.next() {
            if in_string {
                if strip_strings {
                    push_masked_char(&mut output, ch);
                } else {
                    output.push(ch);
                }
                if ch == '"' {
                    if chars.peek() == Some(&'"') {
                        chars.next();
                        if strip_strings {
                            output.push(' ');
                        } else {
                            output.push('"');
                        }
                    } else {
                        in_string = false;
                    }
                }
                continue;
            }
            if ch == '\'' {
                output.push(' ');
                for comment_ch in chars {
                    push_masked_char(&mut output, comment_ch);
                }
                break;
            }
            if ch == '"' {
                if strip_strings {
                    output.push(' ');
                } else {
                    output.push(ch);
                }
                in_string = true;
            } else {
                output.push(ch);
            }
        }
        output.push('\n');
    }
    output
}

fn balanced_code_fragment(
    chars: &[char],
    open_index: usize,
    open: char,
    close: char,
) -> Option<(String, usize)> {
    let mut depth = 0usize;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for index in open_index..chars.len() {
        let ch = chars[index];
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' || (ch == '`' && active_quote != '`') {
                escaped = true;
            } else if ch == active_quote {
                quote = None;
            }
            continue;
        }
        if matches!(ch, '\'' | '"' | '`') {
            quote = Some(ch);
        } else if ch == open {
            depth += 1;
        } else if ch == close {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return Some((chars[open_index + 1..index].iter().collect(), index));
            }
        }
    }
    None
}

fn javascript_interpolation_fragments(content: &str) -> Vec<String> {
    #[derive(Clone, Copy)]
    enum State {
        Code,
        SingleQuoted,
        DoubleQuoted,
        Template,
    }

    let comment_free = strip_javascript_comments(content);
    let chars: Vec<char> = comment_free.chars().collect();
    let mut fragments = Vec::new();
    let mut state = State::Code;
    let mut escaped = false;
    let mut index = 0usize;
    while index < chars.len() {
        let ch = chars[index];
        match state {
            State::Code => {
                state = match ch {
                    '\'' => State::SingleQuoted,
                    '"' => State::DoubleQuoted,
                    '`' => State::Template,
                    _ => State::Code,
                };
            }
            State::SingleQuoted | State::DoubleQuoted => {
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if matches!(state, State::SingleQuoted) && ch == '\''
                    || matches!(state, State::DoubleQuoted) && ch == '"'
                {
                    state = State::Code;
                }
            }
            State::Template => {
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == '`' {
                    state = State::Code;
                } else if ch == '$' && chars.get(index + 1) == Some(&'{') {
                    if let Some((fragment, close_index)) =
                        balanced_code_fragment(&chars, index + 1, '{', '}')
                    {
                        fragments.push(fragment);
                        index = close_index;
                    }
                }
            }
        }
        index += 1;
    }
    fragments
}

fn powershell_interpolation_fragments(content: &str) -> Vec<String> {
    #[derive(Clone, Copy)]
    enum State {
        Code,
        SingleQuoted,
        DoubleQuoted,
        SingleHereQuoted,
        DoubleHereQuoted,
    }

    let comment_free = strip_powershell_comments(content);
    let chars: Vec<char> = comment_free.chars().collect();
    let mut fragments = Vec::new();
    let mut state = State::Code;
    let mut escaped = false;
    let mut line_only_whitespace = true;
    let mut index = 0usize;
    while index < chars.len() {
        let ch = chars[index];
        match state {
            State::Code => {
                if ch == '@' && chars.get(index + 1) == Some(&'\'') {
                    state = State::SingleHereQuoted;
                    index += 1;
                } else if ch == '@' && chars.get(index + 1) == Some(&'"') {
                    state = State::DoubleHereQuoted;
                    index += 1;
                } else {
                    state = match ch {
                        '\'' => State::SingleQuoted,
                        '"' => State::DoubleQuoted,
                        _ => State::Code,
                    };
                }
            }
            State::SingleQuoted => {
                if ch == '\'' {
                    if chars.get(index + 1) == Some(&'\'') {
                        index += 1;
                    } else {
                        state = State::Code;
                    }
                }
            }
            State::DoubleQuoted => {
                if escaped {
                    escaped = false;
                } else if ch == '`' {
                    escaped = true;
                } else if ch == '"' {
                    state = State::Code;
                } else if ch == '$' && chars.get(index + 1) == Some(&'(') {
                    if let Some((fragment, close_index)) =
                        balanced_code_fragment(&chars, index + 1, '(', ')')
                    {
                        fragments.push(fragment);
                        index = close_index;
                    }
                }
            }
            State::SingleHereQuoted => {
                if line_only_whitespace && ch == '\'' && chars.get(index + 1) == Some(&'@') {
                    state = State::Code;
                    index += 1;
                }
            }
            State::DoubleHereQuoted => {
                if line_only_whitespace && ch == '"' && chars.get(index + 1) == Some(&'@') {
                    state = State::Code;
                    index += 1;
                } else if escaped {
                    escaped = false;
                } else if ch == '`' {
                    escaped = true;
                } else if ch == '$' && chars.get(index + 1) == Some(&'(') {
                    if let Some((fragment, close_index)) =
                        balanced_code_fragment(&chars, index + 1, '(', ')')
                    {
                        fragments.push(fragment);
                        index = close_index;
                    }
                }
            }
        }
        if ch == '\n' {
            line_only_whitespace = true;
        } else if !ch.is_whitespace() {
            line_only_whitespace = false;
        }
        index += 1;
    }
    fragments
}

fn csharp_interpolation_fragments(content: &str) -> Vec<String> {
    #[derive(Clone, Copy)]
    enum State {
        Code,
        Character,
        String,
        Interpolated { verbatim: bool },
    }

    let comment_free = strip_script_comments(content, false);
    let chars: Vec<char> = comment_free.chars().collect();
    let mut fragments = Vec::new();
    let mut state = State::Code;
    let mut escaped = false;
    let mut index = 0usize;
    while index < chars.len() {
        let ch = chars[index];
        match state {
            State::Code => {
                if ch == '\'' {
                    state = State::Character;
                } else if ch == '"' {
                    state = State::String;
                } else if ch == '$' && chars.get(index + 1) == Some(&'"') {
                    state = State::Interpolated { verbatim: false };
                    index += 1;
                } else if ((ch == '$' && chars.get(index + 1) == Some(&'@'))
                    || (ch == '@' && chars.get(index + 1) == Some(&'$')))
                    && chars.get(index + 2) == Some(&'"')
                {
                    state = State::Interpolated { verbatim: true };
                    index += 2;
                }
            }
            State::Character | State::String => {
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if matches!(state, State::Character) && ch == '\''
                    || matches!(state, State::String) && ch == '"'
                {
                    state = State::Code;
                }
            }
            State::Interpolated { verbatim } => {
                if !verbatim && escaped {
                    escaped = false;
                } else if !verbatim && ch == '\\' {
                    escaped = true;
                } else if ch == '"' {
                    if verbatim && chars.get(index + 1) == Some(&'"') {
                        index += 1;
                    } else {
                        state = State::Code;
                    }
                } else if ch == '{' && chars.get(index + 1) != Some(&'{') {
                    if let Some((fragment, close_index)) =
                        balanced_code_fragment(&chars, index, '{', '}')
                    {
                        fragments.push(fragment);
                        index = close_index;
                    }
                } else if ch == '{' {
                    index += 1;
                }
            }
        }
        index += 1;
    }
    fragments
}

fn python_interpolation_fragments(content: &str) -> Vec<String> {
    #[derive(Clone, Copy)]
    struct QuoteState {
        delimiter: char,
        triple: bool,
        interpolated: bool,
    }

    let comment_free = strip_script_comments(content, true);
    let chars: Vec<char> = comment_free.chars().collect();
    let mut fragments = Vec::new();
    let mut quote: Option<QuoteState> = None;
    let mut escaped = false;
    let mut index = 0usize;
    while index < chars.len() {
        let ch = chars[index];
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if active_quote.triple
                && ch == active_quote.delimiter
                && chars.get(index + 1) == Some(&active_quote.delimiter)
                && chars.get(index + 2) == Some(&active_quote.delimiter)
            {
                quote = None;
                index += 2;
            } else if !active_quote.triple && ch == active_quote.delimiter {
                quote = None;
            } else if active_quote.interpolated && ch == '{' && chars.get(index + 1) != Some(&'{') {
                if let Some((fragment, close_index)) =
                    balanced_code_fragment(&chars, index, '{', '}')
                {
                    fragments.push(fragment);
                    index = close_index;
                }
            } else if active_quote.interpolated && ch == '{' {
                index += 1;
            }
        } else if matches!(ch, '\'' | '"') {
            let prefix = chars[..index]
                .iter()
                .rev()
                .take_while(|value| value.is_ascii_alphabetic())
                .take(3)
                .copied()
                .collect::<String>();
            let triple = chars.get(index + 1) == Some(&ch) && chars.get(index + 2) == Some(&ch);
            quote = Some(QuoteState {
                delimiter: ch,
                triple,
                interpolated: prefix.chars().any(|value| matches!(value, 'f' | 'F')),
            });
            if triple {
                index += 2;
            }
        }
        index += 1;
    }
    fragments
}

const MAX_EXECUTABLE_INTERPOLATION_DEPTH: usize = 8;
const MAX_EXECUTABLE_INTERPOLATION_ANALYSIS_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExecutableInterpolationLimit {
    Depth,
    TooLarge,
}

fn executable_interpolation_fragments(extension: &str, content: &str) -> Vec<String> {
    match extension {
        "py" | "pyw" => python_interpolation_fragments(content),
        "ps1" => powershell_interpolation_fragments(content),
        "js" | "mjs" | "cjs" | "jsx" | "ts" | "mts" | "cts" | "tsx" => {
            javascript_interpolation_fragments(content)
        }
        "cs" => csharp_interpolation_fragments(content),
        _ => Vec::new(),
    }
}

fn content_with_executable_interpolations_checked(
    extension: &str,
    content: &str,
) -> Result<String, ExecutableInterpolationLimit> {
    if content.len() > MAX_EXECUTABLE_INTERPOLATION_ANALYSIS_BYTES {
        return Err(ExecutableInterpolationLimit::TooLarge);
    }
    let mut analysis = content.to_string();
    let mut frontier = vec![content.to_string()];
    let mut seen = std::collections::HashSet::new();

    for _ in 0..MAX_EXECUTABLE_INTERPOLATION_DEPTH {
        let mut next_frontier = Vec::new();
        for source in frontier {
            for fragment in executable_interpolation_fragments(extension, &source) {
                if !seen.insert(fragment.clone()) {
                    continue;
                }
                let next_size = analysis
                    .len()
                    .saturating_add(1)
                    .saturating_add(fragment.len());
                if next_size > MAX_EXECUTABLE_INTERPOLATION_ANALYSIS_BYTES {
                    return Err(ExecutableInterpolationLimit::TooLarge);
                }
                analysis.push('\n');
                analysis.push_str(&fragment);
                next_frontier.push(fragment);
            }
        }
        if next_frontier.is_empty() {
            return Ok(analysis);
        }
        frontier = next_frontier;
    }

    let has_unprocessed_fragment = frontier.iter().any(|source| {
        executable_interpolation_fragments(extension, source)
            .into_iter()
            .any(|fragment| !seen.contains(&fragment))
    });
    if has_unprocessed_fragment {
        Err(ExecutableInterpolationLimit::Depth)
    } else {
        Ok(analysis)
    }
}

fn content_with_executable_interpolations(extension: &str, content: &str) -> String {
    content_with_executable_interpolations_checked(extension, content)
        .unwrap_or_else(|_| content.to_string())
}

fn script_code_without_inert_text(extension: &str, content: &str) -> String {
    match extension {
        "py" | "pyw" => strip_script_strings_and_comments(content, true),
        "ps1" => strip_powershell_strings_and_comments(content),
        "bat" | "cmd" => strip_batch_inert_lines(content),
        "vbs" => sanitize_vbs_text(content, true),
        "js" | "mjs" | "cjs" | "jsx" | "ts" | "mts" | "cts" | "tsx" => {
            strip_javascript_strings_and_comments(content)
        }
        _ => strip_script_strings_and_comments(content, false),
    }
}

fn script_without_comments(extension: &str, content: &str) -> String {
    match extension {
        "py" | "pyw" => strip_script_comments(content, true),
        "ps1" => strip_powershell_comments(content),
        "bat" | "cmd" => strip_batch_inert_lines(content),
        "vbs" => sanitize_vbs_text(content, false),
        "js" | "mjs" | "cjs" | "jsx" | "ts" | "mts" | "cts" | "tsx" => {
            strip_javascript_comments(content)
        }
        _ => strip_script_comments(content, false),
    }
}

fn normalize_execution_text(input: &str) -> String {
    let mut normalized = String::with_capacity(input.len());
    let mut previous_was_space = true;
    for ch in input.chars() {
        let keep = ch.is_ascii_alphanumeric()
            || matches!(
                ch,
                '_' | '.' | '/' | '\\' | ':' | '-' | '$' | '@' | '(' | ')'
            );
        if keep {
            normalized.push(ch.to_ascii_lowercase());
            previous_was_space = false;
        } else if !previous_was_space {
            normalized.push(' ');
            previous_was_space = true;
        }
    }
    let normalized = normalized.trim().to_string();
    [
        ("reg.exe ", "reg "),
        ("sc.exe ", "sc "),
        ("cmd.exe ", "cmd "),
        ("powershell.exe ", "powershell "),
        ("pwsh.exe ", "pwsh "),
        ("start-process ", ""),
        ("-argumentlist ", ""),
    ]
    .into_iter()
    .fold(normalized, |text, (from, to)| text.replace(from, to))
}

fn simple_literal_bindings(code_mask: &str, content: &str) -> Vec<(String, String)> {
    let mut bindings = Vec::new();
    for (code_line, content_line) in code_mask.lines().zip(content.lines()) {
        if code_line.len() != content_line.len() {
            continue;
        }
        for (equals_index, _) in code_line.match_indices('=') {
            let before = code_line[..equals_index].chars().next_back();
            let after = code_line[equals_index + 1..].chars().next();
            if matches!(before, Some('=' | '!' | '<' | '>')) || matches!(after, Some('=' | '>')) {
                continue;
            }

            let lhs = code_line[..equals_index].trim_end();
            let identifier_reversed: String = lhs
                .chars()
                .rev()
                .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '$'))
                .collect();
            if identifier_reversed.is_empty() {
                continue;
            }
            let identifier: String = identifier_reversed.chars().rev().collect();
            let rhs = content_line[equals_index + 1..].trim_start();
            let value = if let Some(value) = leading_quoted_literal(rhs) {
                if rhs.starts_with('`') && value.contains("${") {
                    continue;
                }
                normalize_execution_text(&value)
            } else if let Some(values) = leading_literal_argv(rhs) {
                values
                    .iter()
                    .map(|value| normalize_execution_text(value))
                    .collect::<Vec<_>>()
                    .join(" ")
            } else {
                continue;
            };
            bindings.push((identifier.to_ascii_lowercase(), value));
            break;
        }
    }
    bindings
}

fn simple_literal_bindings_raw(code_mask: &str, content: &str) -> Vec<(String, Vec<String>)> {
    let mut bindings = Vec::new();
    for (code_line, content_line) in code_mask.lines().zip(content.lines()) {
        if code_line.len() != content_line.len() {
            continue;
        }
        for (equals_index, _) in code_line.match_indices('=') {
            let before = code_line[..equals_index].chars().next_back();
            let after = code_line[equals_index + 1..].chars().next();
            if matches!(before, Some('=' | '!' | '<' | '>')) || matches!(after, Some('=' | '>')) {
                continue;
            }

            let lhs = code_line[..equals_index].trim_end();
            let identifier_reversed: String = lhs
                .chars()
                .rev()
                .take_while(|ch| ch.is_alphanumeric() || matches!(ch, '_' | '$'))
                .collect();
            if identifier_reversed.is_empty() {
                continue;
            }
            let identifier: String = identifier_reversed.chars().rev().collect();
            let rhs = content_line[equals_index + 1..].trim_start();
            let values = if let Some(value) = leading_quoted_literal(rhs) {
                if rhs.starts_with('`') && value.contains("${") {
                    continue;
                }
                vec![value]
            } else if let Some(values) = leading_literal_argv(rhs) {
                values
            } else {
                continue;
            };
            bindings.push((identifier.to_lowercase(), values));
            break;
        }
    }
    bindings
}

/// Convert a source-language argument list to an argv-like view without changing path case or
/// breaking quoted values containing spaces. This view is only used for nested path resolution;
/// dangerous-keyword matching continues to use `normalize_execution_text`.
fn execution_argv_tokens(input: &str, bindings: &[(String, Vec<String>)]) -> Vec<String> {
    let mut argv_text = String::with_capacity(input.len());
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut previous_was_space = true;
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if let Some(active_quote) = quote {
            argv_text.push(ch);
            if escaped {
                escaped = false;
            } else if matches!(ch, '\\' | '`') {
                escaped = true;
            } else if ch == active_quote {
                quote = None;
            }
            previous_was_space = false;
            continue;
        }

        if previous_was_space
            && matches!(ch, '&' | '.')
            && chars
                .peek()
                .is_some_and(|next| matches!(next, '\'' | '"' | '$'))
        {
            argv_text.push(ch);
            argv_text.push(' ');
            previous_was_space = true;
        } else if matches!(ch, '\'' | '"') {
            quote = Some(ch);
            argv_text.push(ch);
            previous_was_space = false;
        } else if ch.is_alphanumeric()
            || matches!(ch, '_' | '.' | '/' | '\\' | ':' | '-' | '$' | '@' | '&')
        {
            argv_text.push(ch);
            previous_was_space = false;
        } else if !previous_was_space {
            argv_text.push(' ');
            previous_was_space = true;
        }
    }

    let mut tokens = Vec::new();
    for token in split_powershell_literal_tokens(argv_text.trim()) {
        if let Some((_, values)) = bindings
            .iter()
            .find(|(identifier, _)| token.to_lowercase() == *identifier)
        {
            tokens.extend(values.iter().cloned());
        } else {
            tokens.push(token);
        }
    }
    tokens
}

fn append_bound_literals(mut context: String, code: &str, bindings: &[(String, String)]) -> String {
    let normalized_code = normalize_execution_text(code);
    for (identifier, value) in bindings {
        if !value.is_empty() && contains_word_token(&normalized_code, identifier) {
            if !context.is_empty() {
                context.push(' ');
            }
            context.push_str(value);
        }
    }
    context
}

fn marker_occurs_in_code(input: &str, marker: &str) -> bool {
    if matches!(marker, "&" | ".") {
        return input.match_indices(marker).any(|(index, _)| {
            let before = input[..index].chars().rev().find(|ch| !ch.is_whitespace());
            let after = input[index + marker.len()..].chars().next();
            let at_command_boundary = before.is_none_or(|ch| matches!(ch, ';' | '{' | '(' | '|'));
            at_command_boundary && after.is_none_or(|ch| ch.is_whitespace() || ch == '$')
        });
    }
    input.match_indices(marker).any(|(index, _)| {
        let before = input[..index].chars().next_back();
        let after = input[index + marker.len()..].chars().next();
        let first = marker.chars().next().unwrap_or_default();
        let last = marker.chars().next_back().unwrap_or_default();
        (!first.is_ascii_alphanumeric()
            || before.is_none_or(|ch| !ch.is_ascii_alphanumeric() && ch != '_'))
            && (!last.is_ascii_alphanumeric()
                || after.is_none_or(|ch| !ch.is_ascii_alphanumeric() && ch != '_'))
    })
}

fn call_argument_contexts(
    code_mask: &str,
    content: &str,
    marker: &str,
    bindings: &[(String, String)],
) -> Vec<String> {
    if code_mask.len() != content.len() {
        return Vec::new();
    }

    let mut contexts = Vec::new();
    let mut search_from = 0;
    while let Some(relative) = code_mask[search_from..].find(marker) {
        let marker_index = search_from + relative;
        let marker_end = marker_index + marker.len();
        let before = code_mask[..marker_index].chars().next_back();
        let after_marker = code_mask[marker_end..].chars().next();
        let marker_boundary = before.is_none_or(|ch| !ch.is_ascii_alphanumeric() && ch != '_')
            && after_marker.is_none_or(|ch| !ch.is_ascii_alphanumeric() && ch != '_');
        if !marker_boundary {
            search_from = marker_end;
            continue;
        }

        let whitespace = code_mask[marker_end..]
            .char_indices()
            .find(|(_, ch)| !ch.is_whitespace())
            .map(|(index, _)| index)
            .unwrap_or(code_mask.len() - marker_end);
        let open_index = marker_end + whitespace;
        if code_mask.as_bytes().get(open_index) != Some(&b'(') {
            search_from = marker_end;
            continue;
        }

        let mut depth = 0usize;
        for (relative_index, ch) in code_mask[open_index..].char_indices() {
            let absolute_index = open_index + relative_index;
            if ch == '(' {
                depth += 1;
            } else if ch == ')' {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let arguments = &content[open_index + 1..absolute_index];
                    let argument_code = &code_mask[open_index + 1..absolute_index];
                    contexts.push(append_bound_literals(
                        normalize_execution_text(arguments),
                        argument_code,
                        bindings,
                    ));
                    break;
                }
            }
        }
        search_from = marker_end;
    }
    contexts
}

fn call_argument_argv_contexts(
    code_mask: &str,
    content: &str,
    marker: &str,
    bindings: &[(String, Vec<String>)],
) -> Vec<Vec<String>> {
    if code_mask.len() != content.len() {
        return Vec::new();
    }

    let mut contexts = Vec::new();
    let mut search_from = 0;
    while let Some(relative) = code_mask[search_from..].find(marker) {
        let marker_index = search_from + relative;
        let marker_end = marker_index + marker.len();
        let before = code_mask[..marker_index].chars().next_back();
        let after_marker = code_mask[marker_end..].chars().next();
        let marker_boundary = before.is_none_or(|ch| !ch.is_alphanumeric() && ch != '_')
            && after_marker.is_none_or(|ch| !ch.is_alphanumeric() && ch != '_');
        if !marker_boundary {
            search_from = marker_end;
            continue;
        }

        let whitespace = code_mask[marker_end..]
            .char_indices()
            .find(|(_, ch)| !ch.is_whitespace())
            .map(|(index, _)| index)
            .unwrap_or(code_mask.len() - marker_end);
        let open_index = marker_end + whitespace;
        if code_mask.as_bytes().get(open_index) != Some(&b'(') {
            search_from = marker_end;
            continue;
        }

        let mut depth = 0usize;
        for (relative_index, ch) in code_mask[open_index..].char_indices() {
            let absolute_index = open_index + relative_index;
            if ch == '(' {
                depth += 1;
            } else if ch == ')' {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    contexts.push(execution_argv_tokens(
                        &content[open_index + 1..absolute_index],
                        bindings,
                    ));
                    break;
                }
            }
        }
        search_from = marker_end;
    }
    contexts
}

fn execution_call_markers(extension: &str) -> &'static [&'static str] {
    match extension {
        "py" | "pyw" => &[
            "os.system",
            "os.popen",
            "subprocess.run",
            "subprocess.call",
            "subprocess.check_call",
            "subprocess.check_output",
            "subprocess.popen",
            "runpy.run_path",
            // Covers `from subprocess import run` and aliases such as `sp.run`.
            "run",
            "call",
            "check_call",
            "check_output",
            "popen",
        ],
        "js" | "mjs" | "cjs" | "jsx" | "ts" | "mts" | "cts" | "tsx" => &[
            "child_process.exec",
            "child_process.execsync",
            "child_process.execfile",
            "child_process.execfilesync",
            "child_process.fork",
            "child_process.spawn",
            "child_process.spawnsync",
            "exec",
            "execsync",
            "execfile",
            "execfilesync",
            "fork",
            "import",
            "require",
            "spawn",
            "spawnsync",
            "deno.command",
            "bun.spawn",
        ],
        "cs" => &[
            "process.start",
            "diagnostics.process.start",
            "registry.open",
            "opensubkey",
            "createsubkey",
            "setvalue",
        ],
        "ps1" => &["invoke-expression", "iex", "start-process", "process.start"],
        _ => &[],
    }
}

fn push_unique_marker(markers: &mut Vec<String>, marker: String) {
    if !marker.is_empty() && !markers.iter().any(|existing| existing == &marker) {
        markers.push(marker);
    }
}

fn python_imported_execution_markers(code_mask: &str) -> Vec<String> {
    const SUBPROCESS_OPERATIONS: &[&str] = &["run", "call", "check_call", "check_output", "popen"];
    const OS_OPERATIONS: &[&str] = &["system", "popen"];
    const RUNPY_OPERATIONS: &[&str] = &["run_path"];

    let mut markers = Vec::new();
    for statement in code_mask.split(['\n', ';']).map(str::trim) {
        if let Some(imports) = statement.strip_prefix("import ") {
            for binding in imports.split(',') {
                let words: Vec<&str> = binding.split_whitespace().collect();
                let Some(module) = words.first().copied() else {
                    continue;
                };
                let alias = if words.get(1) == Some(&"as") {
                    words.get(2).copied().unwrap_or(module)
                } else {
                    module
                };
                let operations = match module {
                    "subprocess" => SUBPROCESS_OPERATIONS,
                    "os" => OS_OPERATIONS,
                    "runpy" => RUNPY_OPERATIONS,
                    _ => &[],
                };
                for operation in operations {
                    push_unique_marker(&mut markers, format!("{alias}.{operation}"));
                }
            }
        }

        let Some(from_import) = statement.strip_prefix("from ") else {
            continue;
        };
        let Some((module, imports)) = from_import.split_once(" import ") else {
            continue;
        };
        let operations = match module.trim() {
            "subprocess" => SUBPROCESS_OPERATIONS,
            "os" => OS_OPERATIONS,
            "runpy" => RUNPY_OPERATIONS,
            _ => &[],
        };
        for binding in imports
            .trim_matches(|ch| matches!(ch, '(' | ')'))
            .split(',')
        {
            let words: Vec<&str> = binding.split_whitespace().collect();
            let Some(imported) = words.first().copied() else {
                continue;
            };
            if !operations.contains(&imported) {
                continue;
            }
            let alias = if words.get(1) == Some(&"as") {
                words.get(2).copied().unwrap_or(imported)
            } else {
                imported
            };
            push_unique_marker(&mut markers, alias.to_string());
        }
    }
    markers
}

fn javascript_imported_execution_markers(code_mask: &str, content: &str) -> Vec<String> {
    const OPERATIONS: &[&str] = &[
        "exec",
        "execsync",
        "execfile",
        "execfilesync",
        "fork",
        "spawn",
        "spawnsync",
    ];

    fn add_named_bindings(markers: &mut Vec<String>, bindings: &str, esm: bool) {
        for binding in bindings.split(',') {
            let binding = binding.trim();
            let (imported, local) = if esm {
                let words: Vec<&str> = binding.split_whitespace().collect();
                let Some(imported) = words.first().copied() else {
                    continue;
                };
                let local = if words.get(1) == Some(&"as") {
                    words.get(2).copied().unwrap_or(imported)
                } else {
                    imported
                };
                (imported, local)
            } else {
                let mut parts = binding.split(':').map(str::trim);
                let imported = parts.next().unwrap_or_default();
                let local = parts.next().unwrap_or(imported);
                (imported, local)
            };
            if OPERATIONS.contains(&imported) {
                push_unique_marker(markers, local.to_string());
            }
        }
    }

    let mut markers = Vec::new();
    for (code_line, content_line) in code_mask.lines().zip(content.lines()) {
        let code_line = code_line.trim();
        let content_lower = content_line.to_ascii_lowercase();
        let imports_child_process = content_lower.contains("'node:child_process'")
            || content_lower.contains("\"node:child_process\"")
            || content_lower.contains("'child_process'")
            || content_lower.contains("\"child_process\"");
        if !imports_child_process {
            continue;
        }

        if code_line.starts_with("import ") {
            if let (Some(open), Some(close)) = (code_line.find('{'), code_line.find('}')) {
                if close > open {
                    add_named_bindings(&mut markers, &code_line[open + 1..close], true);
                }
            }
            if let Some(relative) = code_line.find("* as ") {
                let alias = code_line[relative + 5..]
                    .split(|ch: char| !ch.is_alphanumeric() && ch != '_' && ch != '$')
                    .next()
                    .unwrap_or_default();
                for operation in OPERATIONS {
                    push_unique_marker(&mut markers, format!("{alias}.{operation}"));
                }
            }
        }

        if code_line.contains("require(") || code_line.contains("import(") {
            if let (Some(open), Some(close)) = (code_line.find('{'), code_line.find('}')) {
                if close > open {
                    add_named_bindings(&mut markers, &code_line[open + 1..close], false);
                    continue;
                }
            }
            if let Some(equals) = code_line.find('=') {
                let lhs = code_line[..equals].trim_end();
                let alias_reversed: String = lhs
                    .chars()
                    .rev()
                    .take_while(|ch| ch.is_alphanumeric() || matches!(ch, '_' | '$'))
                    .collect();
                let alias: String = alias_reversed.chars().rev().collect();
                for operation in OPERATIONS {
                    push_unique_marker(&mut markers, format!("{alias}.{operation}"));
                }
            }
        }
    }
    markers
}

fn imported_execution_call_markers(extension: &str, code_mask: &str, content: &str) -> Vec<String> {
    match extension {
        "py" | "pyw" => python_imported_execution_markers(code_mask),
        "js" | "mjs" | "cjs" | "jsx" | "ts" | "mts" | "cts" | "tsx" => {
            javascript_imported_execution_markers(code_mask, content)
        }
        _ => Vec::new(),
    }
}

fn execution_line_markers(extension: &str) -> &'static [&'static str] {
    match extension {
        "ps1" => &[
            "invoke-expression",
            "iex",
            "start-process",
            "cmd /c",
            "cmd /d /c",
            "cmd.exe /c",
            "cmd.exe /d /c",
            "powershell -command",
            "pwsh -command",
            "set-itemproperty",
            "new-itemproperty",
            "saps",
            "start",
            "&",
            ".",
        ],
        "vbs" => &[
            ".run",
            ".exec",
            "shellexecute",
            "regwrite",
            "execute",
            "executeglobal",
            "eval",
        ],
        _ => &[],
    }
}

fn execution_contexts(extension: &str, code_mask: &str, content: &str) -> Vec<String> {
    let normalized_code_mask = code_mask.to_ascii_lowercase();
    let bindings = simple_literal_bindings(&normalized_code_mask, content);
    let mut contexts = Vec::new();
    for marker in execution_call_markers(extension) {
        contexts.extend(call_argument_contexts(
            &normalized_code_mask,
            content,
            marker,
            &bindings,
        ));
    }
    for marker in imported_execution_call_markers(extension, &normalized_code_mask, content) {
        contexts.extend(call_argument_contexts(
            &normalized_code_mask,
            content,
            &marker,
            &bindings,
        ));
    }

    for (code_line, content_line) in normalized_code_mask.lines().zip(content.lines()) {
        if execution_line_markers(extension)
            .iter()
            .any(|marker| marker_occurs_in_code(code_line, marker))
        {
            contexts.push(append_bound_literals(
                normalize_execution_text(content_line),
                code_line,
                &bindings,
            ));
        }
    }
    contexts
}

fn execution_argv_contexts(extension: &str, code_mask: &str, content: &str) -> Vec<Vec<String>> {
    let normalized_code_mask = code_mask.to_ascii_lowercase();
    let bindings = simple_literal_bindings_raw(&normalized_code_mask, content);
    let mut contexts = Vec::new();
    for marker in execution_call_markers(extension) {
        contexts.extend(call_argument_argv_contexts(
            &normalized_code_mask,
            content,
            marker,
            &bindings,
        ));
    }
    for marker in imported_execution_call_markers(extension, &normalized_code_mask, content) {
        contexts.extend(call_argument_argv_contexts(
            &normalized_code_mask,
            content,
            &marker,
            &bindings,
        ));
    }
    for (code_line, content_line) in normalized_code_mask.lines().zip(content.lines()) {
        if execution_line_markers(extension)
            .iter()
            .any(|marker| marker_occurs_in_code(code_line, marker))
        {
            contexts.push(execution_argv_tokens(content_line, &bindings));
        }
    }
    contexts
}

fn nested_runtime_inline_source(
    tokens: &[String],
    runtime: &str,
) -> Option<(&'static str, String)> {
    if runtime == "python" || runtime == "python3" || runtime == "py" {
        let mut index = 1usize;
        while index < tokens.len() {
            let token = &tokens[index];
            if let Some(execution) = python_execution_option_at(tokens, index) {
                return match execution {
                    PythonExecutionOption::Inline(source) => Some(("py", source)),
                    PythonExecutionOption::Module(_) => None,
                };
            }
            if token == "--" {
                return None;
            }
            if let Some((_, consumed)) = option_value_at(
                tokens,
                index,
                PYTHON_VALUE_OPTIONS,
                PYTHON_ATTACHED_VALUE_OPTIONS,
            ) {
                index += consumed;
            } else if token.starts_with('-') {
                index += 1;
            } else {
                return None;
            }
        }
        return None;
    }

    if matches!(runtime, "node" | "nodejs" | "bun") {
        let (value_options, attached_options) = if runtime == "bun" {
            (BUN_VALUE_OPTIONS, BUN_ATTACHED_VALUE_OPTIONS)
        } else {
            (NODE_VALUE_OPTIONS, NODE_ATTACHED_VALUE_OPTIONS)
        };
        let mut index = 1usize;
        while index < tokens.len() {
            let token = &tokens[index];
            if token == "-pe" {
                return tokens.get(index + 1).cloned().map(|source| ("js", source));
            }
            if let Some((source, _)) =
                inline_option_source(tokens, index, &["-e", "-p"], &["--eval", "--print"])
            {
                return Some(("js", source));
            }
            if let Some((_, consumed)) =
                option_value_at(tokens, index, value_options, attached_options)
            {
                index += consumed;
            } else if token.starts_with('-') {
                index += 1;
            } else {
                return None;
            }
        }
        return None;
    }

    if runtime == "deno" {
        let mut index = 1usize;
        while index < tokens.len() {
            let token = &tokens[index];
            if let Some((_, consumed)) = option_value_at(
                tokens,
                index,
                DENO_VALUE_OPTIONS,
                DENO_ATTACHED_VALUE_OPTIONS,
            ) {
                index += consumed;
            } else if token.starts_with('-') {
                index += 1;
            } else {
                break;
            }
        }
        if tokens
            .get(index)
            .is_none_or(|token| !token.eq_ignore_ascii_case("eval"))
        {
            return None;
        }
        index += 1;
        let mut parse_options = true;
        while index < tokens.len() {
            let token = &tokens[index];
            if parse_options && token == "--" {
                parse_options = false;
                index += 1;
                continue;
            }
            if parse_options {
                if let Some((_, consumed)) = option_value_at(
                    tokens,
                    index,
                    DENO_VALUE_OPTIONS,
                    DENO_ATTACHED_VALUE_OPTIONS,
                ) {
                    index += consumed;
                    continue;
                }
                if token.starts_with('-') {
                    index += 1;
                    continue;
                }
            }
            return Some(("js", token.to_string()));
        }
        return None;
    }

    if matches!(runtime, "powershell" | "pwsh") {
        return powershell_command_payload(tokens).map(|source| ("ps1", source));
    }

    None
}

fn nested_path_is_static(path: &str) -> bool {
    Path::new(path).extension().is_some() || is_path_like_script_specifier(path)
}

fn forbidden_in_execution_context(contexts: &[String], forbidden: &str) -> bool {
    contexts.iter().any(|context| context.contains(forbidden))
}

fn detect_script_forbidden_keyword(extension: &str, content: &str) -> Option<&'static str> {
    let analysis = content_with_executable_interpolations(extension, content);
    let code_mask = script_code_without_inert_text(extension, &analysis);
    let code = code_mask.to_ascii_lowercase();
    let comments_removed = script_without_comments(extension, &analysis);
    let contexts = execution_contexts(extension, &code_mask, &comments_removed);
    SCRIPT_CONTENT_FORBIDDEN.iter().find_map(|forbidden| {
        let code_contains_forbidden = if forbidden.chars().all(|ch| ch.is_ascii_alphanumeric()) {
            contains_word_token(&code, forbidden)
        } else {
            code.contains(forbidden)
        };
        (code_contains_forbidden || forbidden_in_execution_context(&contexts, forbidden))
            .then_some(*forbidden)
    })
}

fn compact_script_code(content: &str) -> String {
    content.chars().filter(|ch| !ch.is_whitespace()).collect()
}

fn has_call_token(content: &str, name: &str) -> bool {
    let mut start = 0;

    while let Some(relative) = content[start..].find(name) {
        let index = start + relative;
        let before_is_ident = content[..index]
            .chars()
            .next_back()
            .is_some_and(|ch| ch.is_alphanumeric() || matches!(ch, '_' | '$'));
        let after = index + name.len();
        let after_is_ident = content[after..]
            .chars()
            .next()
            .is_some_and(|ch| ch.is_alphanumeric() || matches!(ch, '_' | '$'));

        if !before_is_ident && !after_is_ident && content[after..].trim_start().starts_with('(') {
            return true;
        }
        start = after;
    }

    false
}

fn detect_python_delete(content: &str) -> Option<&'static str> {
    let code = strip_script_strings_and_comments(content, true).to_lowercase();
    let compact = compact_script_code(&code);
    if let Some(operation) = [
        ("os.remove(", "os.remove"),
        ("os.unlink(", "os.unlink"),
        ("os.rmdir(", "os.rmdir"),
        ("os.removedirs(", "os.removedirs"),
        ("shutil.rmtree(", "shutil.rmtree"),
        (".unlink(", "pathlib.Path.unlink"),
        (".rmdir(", "pathlib.Path.rmdir"),
    ]
    .iter()
    .find_map(|(pattern, operation)| compact.contains(pattern).then_some(*operation))
    {
        return Some(operation);
    }

    for statement in code.split(['\n', ';']) {
        let statement = statement.trim();
        if let Some(imports) = statement.strip_prefix("import ") {
            for binding in imports.split(',') {
                let words: Vec<&str> = binding.split_whitespace().collect();
                if words.len() >= 3 && words[1] == "as" {
                    let operations: &[&str] = match words[0] {
                        "os" => &["remove", "unlink", "rmdir", "removedirs"],
                        "shutil" => &["rmtree"],
                        _ => &[],
                    };
                    if operations
                        .iter()
                        .any(|operation| compact.contains(&format!("{}.{}(", words[2], operation)))
                    {
                        return Some("aliased Python delete");
                    }
                }
            }
        }

        let module_operations: &[(&str, &[&str])] = &[
            ("os", &["remove", "unlink", "rmdir", "removedirs"]),
            ("shutil", &["rmtree"]),
        ];
        for &(module, operations) in module_operations {
            let prefix = format!("from {} import ", module);
            let Some(imports) = statement.strip_prefix(&prefix) else {
                continue;
            };
            for binding in imports
                .trim_matches(|ch| matches!(ch, '(' | ')'))
                .split(',')
            {
                let words: Vec<&str> = binding.split_whitespace().collect();
                let Some(imported) = words.first().copied() else {
                    continue;
                };
                if !operations.contains(&imported) {
                    continue;
                }
                let call_name = if words.get(1) == Some(&"as") {
                    words.get(2).copied().unwrap_or(imported)
                } else {
                    imported
                };
                if has_call_token(&code, call_name) {
                    return Some("imported Python delete");
                }
            }
        }
    }

    None
}

fn is_powershell_command_boundary(ch: Option<char>) -> bool {
    ch.map_or(true, |value| {
        matches!(value, ';' | '{' | '}' | '|' | '&' | '=' | '(' | '\n' | '\r')
    })
}

fn detect_powershell_delete(content: &str) -> Option<&'static str> {
    let code = strip_powershell_strings_and_comments(content).to_lowercase();
    for (operation, name) in [
        ("Remove-Item", "remove-item"),
        ("Remove-Item (ri alias)", "ri"),
        ("Remove-Item (rm alias)", "rm"),
        ("Remove-Item (del alias)", "del"),
        ("Remove-Item (erase alias)", "erase"),
        ("Remove-Item (rd alias)", "rd"),
        ("Remove-Item (rmdir alias)", "rmdir"),
    ] {
        let mut search_from = 0;
        while let Some(relative) = code[search_from..].find(name) {
            let index = search_from + relative;
            let end = index + name.len();
            let before = code[..index].chars().next_back();
            let after = code[end..].chars().next();
            let word_boundary = before.map_or(true, |ch| !ch.is_ascii_alphanumeric() && ch != '_')
                && after.map_or(true, |ch| !ch.is_ascii_alphanumeric() && ch != '_');
            let previous_non_space = code[..index].chars().rev().find(|ch| !ch.is_whitespace());

            if word_boundary
                && (is_powershell_command_boundary(previous_non_space)
                    || code[..index]
                        .rsplit_once('\n')
                        .map_or(true, |(_, line)| line.trim().is_empty()))
            {
                return Some(operation);
            }
            search_from = end;
        }
    }

    None
}

fn detect_batch_delete(content: &str) -> Option<&'static str> {
    for line in content.lines() {
        let trimmed = line.trim_start().trim_start_matches('@').trim_start();
        let lower = trimmed.to_lowercase();
        if lower.is_empty()
            || lower.starts_with("rem ")
            || lower == "rem"
            || lower.starts_with("::")
        {
            continue;
        }

        if let Some(payload) = cmd_command_payload(trimmed) {
            if let Some(operation) = detect_batch_delete(&payload) {
                return Some(operation);
            }
        }

        let mut quoted = false;
        let mut escaped = false;
        let mut segment = String::new();
        let mut segments = Vec::new();
        for ch in lower.chars() {
            if escaped {
                segment.push(ch);
                escaped = false;
            } else if ch == '^' {
                escaped = true;
                segment.push(' ');
            } else if ch == '"' {
                quoted = !quoted;
                segment.push(ch);
            } else if !quoted && matches!(ch, '&' | '|') {
                segments.push(std::mem::take(&mut segment));
            } else {
                segment.push(ch);
            }
        }
        segments.push(segment);

        for segment in segments {
            let tokens = split_shell_tokens(
                segment.trim_matches(|ch: char| ch.is_whitespace() || matches!(ch, '(' | ')')),
            );
            let Some(first) = tokens.first() else {
                continue;
            };
            if matches!(first.as_str(), "echo" | "echo(" | "set" | "rem")
                || first.starts_with("echo(")
            {
                continue;
            }
            if let Some(operation) = tokens
                .iter()
                .find_map(|token| cmd_delete_builtin_name(token))
            {
                return Some(operation);
            }
        }
    }

    None
}

fn javascript_imports_fs_api(content: &str, code_mask: &str) -> bool {
    let comments_removed = strip_javascript_comments(content).to_ascii_lowercase();
    let no_bindings = Vec::new();
    let call_import = ["require", "import"].iter().any(|marker| {
        call_argument_argv_contexts(code_mask, &comments_removed, marker, &no_bindings)
            .into_iter()
            .flatten()
            .any(|token| {
                matches!(
                    token.trim().to_ascii_lowercase().as_str(),
                    "fs" | "node:fs" | "fs/promises" | "node:fs/promises"
                )
            })
    });
    if call_import {
        return true;
    }

    code_mask
        .lines()
        .zip(comments_removed.lines())
        .any(|(code_line, source_line)| {
            let active_module_statement = contains_word_token(code_line, "import")
                || contains_word_token(code_line, "export");
            if !active_module_statement {
                return false;
            }
            let compact = compact_script_code(source_line);
            [
                "'fs'",
                "\"fs\"",
                "'node:fs'",
                "\"node:fs\"",
                "'fs/promises'",
                "\"fs/promises\"",
                "'node:fs/promises'",
                "\"node:fs/promises\"",
            ]
            .iter()
            .any(|module| compact.contains(module))
        })
}

fn detect_javascript_delete(content: &str) -> Option<&'static str> {
    let lower = strip_javascript_comments(content).to_lowercase();
    let code = strip_javascript_strings_and_comments(content).to_lowercase();
    let compact = compact_script_code(&code);
    let patterns = [
        ("deno.removesync(", "Deno.removeSync"),
        ("deno.remove(", "Deno.remove"),
        ("fs.promises.rmsync(", "fs.rmSync"),
        ("fs.promises.unlinksync(", "fs.unlinkSync"),
        ("fs.promises.rmdir(", "fs.promises.rmdir"),
        ("fs.promises.unlink(", "fs.promises.unlink"),
        ("fs.promises.rm(", "fs.promises.rm"),
        ("promises.rmdir(", "fs.promises.rmdir"),
        ("promises.unlink(", "fs.promises.unlink"),
        ("promises.rm(", "fs.promises.rm"),
        ("fsp.rmdir(", "fs.promises.rmdir"),
        ("fsp.unlink(", "fs.promises.unlink"),
        ("fsp.rm(", "fs.promises.rm"),
        ("fs.rmdirsync(", "fs.rmdirSync"),
        ("fs.unlinksync(", "fs.unlinkSync"),
        ("fs.rmsync(", "fs.rmSync"),
        ("fs.rmdir(", "fs.rmdir"),
        ("fs.unlink(", "fs.unlink"),
        ("fs.rm(", "fs.rm"),
        (".deletefile(", "WSH DeleteFile"),
        (".deletefolder(", "WSH DeleteFolder"),
    ];

    if let Some((_, operation)) = patterns
        .iter()
        .find(|(pattern, _)| compact.contains(pattern))
    {
        return Some(*operation);
    }

    let imports_fs_api = javascript_imports_fs_api(content, &code);
    if imports_fs_api {
        for (name, operation) in [
            ("rmsync", "fs.rmSync"),
            ("unlinksync", "fs.unlinkSync"),
            ("rmdirsync", "fs.rmdirSync"),
            ("rm", "fs.rm"),
            ("unlink", "fs.unlink"),
            ("rmdir", "fs.rmdir"),
        ] {
            if has_call_token(&code, name) {
                return Some(operation);
            }
        }

        for statement in lower.split(['\n', ';']) {
            let Some(open) = statement.find('{') else {
                continue;
            };
            let Some(relative_close) = statement[open + 1..].find('}') else {
                continue;
            };
            let bindings = &statement[open + 1..open + 1 + relative_close];
            for binding in bindings.split(',') {
                let mut parts = binding.split(':').map(str::trim);
                let imported = parts.next().unwrap_or_default();
                let local = parts.next().unwrap_or(imported);
                let operation = match imported {
                    "rmsync" => Some("fs.rmSync"),
                    "unlinksync" => Some("fs.unlinkSync"),
                    "rmdirsync" => Some("fs.rmdirSync"),
                    "rm" => Some("fs.rm"),
                    "unlink" => Some("fs.unlink"),
                    "rmdir" => Some("fs.rmdir"),
                    _ => None,
                };
                if let Some(operation) = operation {
                    if has_call_token(&code, local) {
                        return Some(operation);
                    }
                }
            }
        }
    }

    None
}

fn contains_word_token(input: &str, name: &str) -> bool {
    input.match_indices(name).any(|(index, _)| {
        let before = input[..index].chars().next_back();
        let after = input[index + name.len()..].chars().next();
        before.is_none_or(|ch| !ch.is_ascii_alphanumeric() && ch != '_')
            && after.is_none_or(|ch| !ch.is_ascii_alphanumeric() && ch != '_')
    })
}

fn execution_context_contains_delete(contexts: &[String]) -> bool {
    contexts.iter().any(|context| {
        detect_batch_delete(context).is_some()
            || ["remove-item", "rimraf", "rm", "erase", "unlink", "rmdir"]
                .iter()
                .any(|name| contains_word_token(context, name))
    })
}

fn detect_csharp_delete(content: &str) -> Option<&'static str> {
    let code = strip_script_strings_and_comments(content, false).to_ascii_lowercase();
    let compact = compact_script_code(&code);

    if [
        "microsoft.visualbasic.fileio.filesystem.deletefile(",
        "microsoft.visualbasic.fileio.filesystem.deletedirectory(",
    ]
    .iter()
    .any(|pattern| compact.contains(pattern))
    {
        return Some("Visual Basic FileSystem delete");
    }

    if (compact.contains("usingstaticsystem.io.file;")
        || compact.contains("usingstaticglobal::system.io.file;"))
        && has_call_token(&code, "delete")
    {
        return Some("C# static-imported File.Delete");
    }

    for statement in code.split(['\n', ';']) {
        let Some(equals) = statement.find('=') else {
            continue;
        };
        let before = statement[..equals].chars().next_back();
        let after = statement[equals + 1..].chars().next();
        if matches!(before, Some('=' | '!' | '<' | '>')) || matches!(after, Some('=' | '>')) {
            continue;
        }
        let rhs: String = statement[equals + 1..]
            .chars()
            .filter(|ch| !ch.is_whitespace())
            .collect();
        if !matches!(
            rhs.as_str(),
            "system.io.file.delete" | "global::system.io.file.delete"
        ) {
            continue;
        }
        let lhs = statement[..equals].trim_end();
        let alias_reversed: String = lhs
            .chars()
            .rev()
            .take_while(|ch| ch.is_alphanumeric() || *ch == '_')
            .collect();
        let alias: String = alias_reversed.chars().rev().collect();
        if !alias.is_empty() && has_call_token(&code, &alias) {
            return Some("C# File.Delete method-group alias");
        }
    }

    None
}

fn detect_conservative_script_delete(extension: &str, content: &str) -> Option<&'static str> {
    let analysis = content_with_executable_interpolations(extension, content);
    let code_mask = script_code_without_inert_text(extension, &analysis);
    let lower = code_mask.to_ascii_lowercase();
    let compact: String = lower
        .chars()
        .filter(|ch| !ch.is_whitespace() && *ch != '`' && *ch != '^')
        .collect();
    let comments_removed = script_without_comments(extension, &analysis);
    let contexts = execution_contexts(extension, &code_mask, &comments_removed);
    let context_delete = execution_context_contains_delete(&contexts);

    let matched = |patterns: &[&str]| patterns.iter().any(|pattern| compact.contains(pattern));
    match extension {
        "py" | "pyw" => {
            if matched(&[
                "os.remove(",
                "os.unlink(",
                "os.rmdir(",
                "os.removedirs(",
                "shutil.rmtree(",
                ".unlink(",
                ".rmdir(",
                "fromosimportremove",
                "fromosimportunlink",
                "fromosimportremovedirs",
                "fromshutilimportrmtree",
            ]) || context_delete
            {
                Some("indirect Python delete")
            } else {
                None
            }
        }
        "ps1" => (matched(&[
            "remove-item",
            "[io.file]::delete(",
            "[system.io.file]::delete(",
            "[io.directory]::delete(",
            "[system.io.directory]::delete(",
            ".delete(",
            "cmd/cdel",
            "cmd.exe/cdel",
        ]) || context_delete)
            .then_some("indirect PowerShell delete"),
        "bat" | "cmd" => {
            let normalized = lower.replace('^', "");
            detect_batch_delete(&normalized).or_else(|| {
                ((normalized.contains("forfiles")
                    || normalized.contains("cmd /c")
                    || normalized.contains("powershell"))
                    && ["del", "erase", "rmdir", "rd", "remove-item"]
                        .iter()
                        .any(|name| contains_word_token(&normalized, name)))
                .then_some("indirect batch delete")
            })
        }
        "js" | "mjs" | "cjs" | "jsx" | "ts" | "mts" | "cts" | "tsx" => {
            if matched(&[
                "fs.rm(",
                "fs.rmsync(",
                "fs.unlink(",
                "fs.unlinksync(",
                "fs.rmdir(",
                "fs.rmdirsync(",
                "fs.promises.rm(",
                "fs.promises.unlink(",
                "fs.promises.rmdir(",
                "fs['rm'](",
                "fs[\"rm\"](",
                "fs['rmsync'](",
                "fs[\"rmsync\"](",
                "deno.remove(",
                "deno.removesync(",
                ".deletefile(",
                ".deletefolder(",
            ]) || context_delete
            {
                Some("indirect JavaScript delete")
            } else {
                None
            }
        }
        "cs" => (matched(&[
            "file.delete(",
            "directory.delete(",
            "system.io.file.delete(",
            "system.io.directory.delete(",
        ]) || ((compact.contains("fileinfo(") || compact.contains("directoryinfo("))
            && compact.contains(".delete("))
            || context_delete)
            .then_some("C# filesystem delete"),
        "vbs" => (matched(&["deletefile", "deletefolder", "filesystemobject.delete"])
            || ((compact.contains("getfile(") || compact.contains("getfolder("))
                && compact.contains(".delete"))
            || context_delete)
            .then_some("VBScript filesystem delete"),
        _ => None,
    }
}

fn detect_script_delete_for_extension(extension: &str, content: &str) -> Option<&'static str> {
    if detect_rimraf_script_delete(extension, content) {
        return Some("rimraf cleanup");
    }
    let detected = match extension {
        "py" | "pyw" => detect_python_delete(content),
        "ps1" => detect_powershell_delete(content),
        "bat" | "cmd" => detect_batch_delete(content),
        "js" | "mjs" | "cjs" | "jsx" | "ts" | "mts" | "cts" | "tsx" => {
            detect_javascript_delete(content)
        }
        "cs" => detect_csharp_delete(content),
        _ => None,
    };
    detected.or_else(|| detect_conservative_script_delete(extension, content))
}

fn detect_rimraf_script_delete(extension: &str, content: &str) -> bool {
    let analysis = content_with_executable_interpolations(extension, content);
    let code_mask = script_code_without_inert_text(extension, &analysis);
    let code = code_mask.to_ascii_lowercase();
    let comments_removed = script_without_comments(extension, &analysis);
    let contexts = execution_contexts(extension, &code_mask, &comments_removed);
    has_call_token(&code, "rimraf")
        || contexts
            .iter()
            .any(|context| contains_word_token(context, "rimraf"))
        || (matches!(extension, "bat" | "cmd" | "ps1")
            && code.lines().any(|line| contains_word_token(line, "rimraf")))
}

fn script_path_extension(script_path: &str) -> String {
    Path::new(script_path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

#[cfg(test)]
fn detect_script_delete_intent(script_path: &str, content: &str) -> Option<&'static str> {
    detect_script_delete_for_extension(&script_path_extension(script_path), content)
}

#[derive(Default)]
struct ScriptScanState {
    visited_files: std::collections::HashSet<String>,
    file_count: usize,
    total_bytes: u64,
}

/// 扫描脚本文件内容是否包含危险 API 调用
///
/// 在 exec 执行脚本前调用，读取脚本文件内容并检查是否包含
/// SCRIPT_CONTENT_FORBIDDEN 中的黑名单关键字。
///
/// 设计决策：
/// - 使用独立的 SCRIPT_CONTENT_FORBIDDEN 而非复用 FORBIDDEN_COMMANDS，
///   避免 `-enc`、`setx /m` 等命令行专用关键字在脚本源码中误报
/// - 已识别的脚本无法读取时 fail closed，避免检查与执行之间通过缺失/替换脚本绕过
/// - 脚本中的删除 API 不直接执行；要求 Agent 改用可被 Trash Bin 拦截的直接删除命令
/// - 仅扫描文本格式的脚本文件，二进制文件无法扫描
fn validate_script_source(
    script_label: &str,
    effective_extension: &str,
    content: &str,
    workdir: Option<&str>,
    depth: u8,
    scan_state: &mut ScriptScanState,
) -> Result<(), AppError> {
    let analysis = content_with_executable_interpolations_checked(effective_extension, content)
        .map_err(|limit| match limit {
            ExecutableInterpolationLimit::Depth => AppError::Forbidden(format!(
                "Safety block [script_scan_depth_exceeded]: executable interpolation in script source '{}' exceeds {} levels. Flatten the interpolation chain and retry; do not bypass the scan.",
                script_label, MAX_EXECUTABLE_INTERPOLATION_DEPTH
            )),
            ExecutableInterpolationLimit::TooLarge => AppError::Forbidden(format!(
                "Safety block [script_scan_too_large]: executable interpolation analysis for script source '{}' exceeds the scan budget. Split or reduce the script and retry; do not bypass the scan.",
                script_label
            )),
        })?;
    let code_mask = script_code_without_inert_text(effective_extension, &analysis);
    let active_code = code_mask.to_ascii_lowercase();
    let comments_removed = script_without_comments(effective_extension, &analysis);
    let execution_texts = execution_contexts(effective_extension, &code_mask, &comments_removed);

    if is_format_drive_command(&active_code)
        || contains_powershell_encoded_command(&active_code)
        || contains_tool_subcommand(&active_code, "reg", "delete")
        || contains_tool_subcommand(&active_code, "sc", "delete")
        || contains_tool_subcommand(&active_code, "net", "user")
        || execution_texts.iter().any(|context| {
            is_format_drive_command(context)
                || contains_powershell_encoded_command(context)
                || contains_tool_subcommand(context, "reg", "delete")
                || contains_tool_subcommand(context, "sc", "delete")
                || contains_tool_subcommand(context, "net", "user")
        })
    {
        return Err(AppError::Forbidden(format!(
            "Safety block: a destructive system command was detected in script source '{}'. Script execution was blocked.",
            script_label
        )));
    }

    if let Some(operation) = detect_script_delete_for_extension(effective_extension, content) {
        let reason = format!(
            "{}: delete operation '{}' was detected in script source '{}'. Retry with one direct supported delete command and explicit literal paths so Agent Trash Bin can preserve recovery.",
            RECOVERABLE_DELETE_BLOCK_PREFIX, operation, script_label
        );
        log::warn!("[CommandValidator] {}", reason);
        return Err(AppError::Forbidden(reason));
    }

    if let Some(forbidden) = detect_script_forbidden_keyword(effective_extension, content) {
        let reason = format!(
            "Safety block: dangerous API call '{}' was detected in script source '{}'. Script execution was blocked.",
            forbidden.trim(),
            script_label
        );
        log::warn!("[CommandValidator] {}", reason);
        return Err(AppError::Forbidden(reason));
    }

    fn push_unique(paths: &mut Vec<String>, path: String) {
        if !paths
            .iter()
            .any(|existing| script_paths_equal(existing, &path))
        {
            paths.push(path);
        }
    }

    let mut nested_scripts = if matches!(effective_extension, "bat" | "cmd") {
        extract_script_paths(&code_mask)
    } else {
        Vec::new()
    };
    let mut python_nested_scripts = Vec::new();
    let mut javascript_nested_scripts = Vec::new();
    let execution_argvs =
        execution_argv_contexts(effective_extension, &code_mask, &comments_removed);
    let mut has_dynamic_runtime_entry = false;
    for context_tokens in &execution_argvs {
        let runtime_index = context_tokens.iter().position(|token| {
            let lower = token.to_ascii_lowercase();
            matches!(
                lower.as_str(),
                "sys.executable"
                    | "process.execpath"
                    | "python"
                    | "python3"
                    | "py"
                    | "node"
                    | "nodejs"
                    | "bun"
                    | "deno"
                    | "powershell"
                    | "pwsh"
                    | "cscript"
                    | "wscript"
            ) || token_command_name(token).starts_with("python")
        });
        if let Some(runtime_index) = runtime_index {
            let original_runtime = context_tokens[runtime_index].to_ascii_lowercase();
            let runtime = if original_runtime == "sys.executable"
                || token_command_name(&original_runtime).starts_with("python")
            {
                "python".to_string()
            } else if original_runtime == "process.execpath" {
                "node".to_string()
            } else {
                token_command_name(&original_runtime)
            };
            let mut launcher_tokens = Vec::with_capacity(context_tokens.len() - runtime_index);
            launcher_tokens.push(runtime.clone());
            launcher_tokens.extend(context_tokens.iter().skip(runtime_index + 1).cloned());

            if matches!(runtime.as_str(), "node" | "nodejs" | "deno" | "bun")
                && (runtime_cwd_option_precedes_entry(&launcher_tokens, &runtime)
                    || runtime_preload_is_ambiguous(&launcher_tokens, &runtime)
                    || (runtime == "deno" && deno_remote_entry_is_ambiguous(&launcher_tokens)))
            {
                has_dynamic_runtime_entry = true;
                continue;
            }
            if matches!(runtime.as_str(), "powershell" | "pwsh")
                && powershell_workdir_option_precedes_entry(&launcher_tokens)
            {
                has_dynamic_runtime_entry = true;
                continue;
            }

            if let Some((inline_extension, inline_source)) =
                nested_runtime_inline_source(&launcher_tokens, &runtime)
            {
                if depth >= 8 {
                    return Err(AppError::Forbidden(
                        "Safety block [script_scan_depth_exceeded]: nested inline script scan exceeded the depth limit. Flatten the script chain and retry; do not bypass the scan."
                            .to_string(),
                    ));
                }
                if inline_source.trim_start().starts_with('$')
                    && !inline_source.trim().contains(char::is_whitespace)
                {
                    has_dynamic_runtime_entry = true;
                    continue;
                }
                validate_script_source(
                    "<nested inline source>",
                    inline_extension,
                    &inline_source,
                    workdir,
                    depth.saturating_add(1),
                    scan_state,
                )?;
            }

            if let Some(paths) = known_runtime_script_paths(&launcher_tokens) {
                for candidate in paths {
                    if !nested_path_is_static(&candidate) {
                        has_dynamic_runtime_entry = true;
                        break;
                    }
                    push_unique(&mut nested_scripts, candidate.clone());
                    if runtime == "python" || runtime == "py" {
                        push_unique(&mut python_nested_scripts, candidate);
                    } else {
                        push_unique(&mut javascript_nested_scripts, candidate);
                    }
                }
                if runtime == "python" {
                    if let Some(module) = python_module_name(&launcher_tokens) {
                        let root = match workdir {
                            Some(workdir) if Path::new(workdir).is_absolute() => {
                                PathBuf::from(workdir)
                            }
                            Some(workdir) => std::env::current_dir()
                                .map(|current| current.join(workdir))
                                .unwrap_or_else(|_| PathBuf::from(workdir)),
                            None => std::env::current_dir().unwrap_or_default(),
                        };
                        for candidate in local_python_module_candidates(&root, &module) {
                            push_unique(&mut nested_scripts, candidate.clone());
                            push_unique(&mut python_nested_scripts, candidate);
                        }
                    }
                }
            } else if matches!(runtime.as_str(), "powershell" | "pwsh") {
                if let Some(candidate) = powershell_script_path_from_tokens(&launcher_tokens) {
                    if nested_path_is_static(&candidate) {
                        push_unique(&mut nested_scripts, candidate);
                    } else {
                        has_dynamic_runtime_entry = true;
                    }
                } else if launcher_tokens
                    .iter()
                    .skip(1)
                    .find(|token| !token.starts_with('-'))
                    .is_some_and(|candidate| candidate.starts_with('$'))
                {
                    has_dynamic_runtime_entry = true;
                }
            } else if matches!(runtime.as_str(), "cscript" | "wscript") {
                if let Some(candidate) = launcher_tokens
                    .iter()
                    .skip(1)
                    .find(|token| !token.starts_with(['/', '-']))
                {
                    if nested_path_is_static(candidate) {
                        push_unique(&mut nested_scripts, candidate.to_string());
                    } else if candidate.starts_with('$') {
                        has_dynamic_runtime_entry = true;
                    }
                }
            }
            continue;
        }

        for window in context_tokens.windows(2) {
            if matches!(window[0].as_str(), "&" | ".") && window[1].starts_with('$') {
                has_dynamic_runtime_entry = true;
            }
        }
        for token in context_tokens {
            if is_script_extension(&token, SCANNABLE_EXTENSIONS) {
                push_unique(&mut nested_scripts, token.clone());
                if is_script_extension(token, &[".py", ".pyw"]) {
                    push_unique(&mut python_nested_scripts, token.clone());
                } else if is_script_extension(token, JAVASCRIPT_SCRIPT_EXTENSIONS) {
                    push_unique(&mut javascript_nested_scripts, token.clone());
                }
            }
        }
    }

    if has_dynamic_runtime_entry {
        return Err(AppError::Forbidden(format!(
            "Safety block [script_scan_ambiguous_launcher]: nested script source '{}' uses a dynamic entrypoint that cannot be resolved safely. Use an explicit local file entrypoint and retry; do not bypass script scanning.",
            script_label
        )));
    }

    let changes_nested_workdir = active_code.contains("os.chdir(")
        || active_code.contains("process.chdir(")
        || active_code.contains("deno.chdir(")
        || active_code.contains("set_current_dir(")
        || active_code.contains("set-location ")
        || active_code.contains("workingdirectory")
        || execution_texts.iter().any(|context| {
            contains_word_token(context, "cwd") || contains_word_token(context, "workingdirectory")
        })
        || (matches!(effective_extension, "bat" | "cmd")
            && active_code.lines().any(|line| {
                let first = split_shell_tokens(line).into_iter().next();
                first.is_some_and(|token| matches!(token.as_str(), "cd" | "chdir" | "pushd"))
            }));
    if changes_nested_workdir && !nested_scripts.is_empty() {
        return Err(AppError::Forbidden(format!(
            "Safety block [script_scan_ambiguous_launcher]: nested script source '{}' changes the script working directory. Use an explicit entrypoint resolved from the exec workdir and retry; do not bypass script scanning.",
            script_label
        )));
    }

    if !nested_scripts.is_empty() {
        if depth >= 8 {
            return Err(AppError::Forbidden(
                "Safety block [script_scan_depth_exceeded]: nested script scan exceeded the depth limit. Flatten the script chain and retry; do not bypass the scan."
                    .to_string(),
            ));
        }
        for nested_script in nested_scripts {
            if script_paths_equal(&nested_script, script_label) {
                continue;
            }
            let nested_command = if python_nested_scripts
                .iter()
                .any(|path| script_paths_equal(path, &nested_script))
            {
                format!(r#"python "{}""#, nested_script.replace('"', "\\\""))
            } else if javascript_nested_scripts
                .iter()
                .any(|path| script_paths_equal(path, &nested_script))
            {
                format!(r#"node "{}""#, nested_script.replace('"', "\\\""))
            } else {
                nested_script.clone()
            };
            validate_single_script_content(
                &nested_script,
                &nested_command,
                workdir,
                depth + 1,
                scan_state,
            )?;
        }
    }

    log::debug!("[CommandValidator] 脚本内容扫描通过: {}", script_label);
    Ok(())
}

fn validate_single_script_content(
    script_path: &str,
    command: &str,
    workdir: Option<&str>,
    depth: u8,
    scan_state: &mut ScriptScanState,
) -> Result<(), AppError> {
    let runtime_extension = runtime_language_extension(command, script_path);
    let path_extension = script_path_extension(script_path);
    let known_path_extension = SCANNABLE_EXTENSIONS.iter().any(|extension| {
        extension
            .trim_start_matches('.')
            .eq_ignore_ascii_case(&path_extension)
    });
    if runtime_extension.is_none() && !known_path_extension {
        return Err(AppError::Forbidden(format!(
            "Safety block [script_scan_ambiguous_launcher]: script file '{}' uses an unsupported or ambiguous launcher/extension. Use an explicit supported launcher/extension and retry; do not bypass script scanning.",
            script_path
        )));
    }

    // 解析完整路径（多方尝试，确保能找到文件）
    let script = std::path::Path::new(&script_path);
    let resolved_script_path = if script.is_absolute() {
        script.to_path_buf()
    } else if let Some(wd) = workdir {
        std::path::Path::new(wd).join(script)
    } else {
        std::env::current_dir()
            .map_err(|error| {
                AppError::Forbidden(format!(
                    "Safety block [script_scan_unreadable]: failed to resolve the script working directory: {}. Make the script path readable and retry; do not bypass script scanning.",
                    error
                ))
            })?
            .join(script)
    };

    // 只读取解释器实际将从 workdir 解析出的唯一脚本路径，禁止用 cwd 下同名文件代检。
    // 先识别 UTF-32 BOM，再识别 UTF-16 BOM；其余文本使用有损 UTF-8 解码保留
    // ASCII API 标记。NUL 比例异常的无 BOM 文本 fail closed，避免编码绕过。
    const MAX_SCRIPT_SCAN_BYTES: u64 = 8 * 1024 * 1024;
    let metadata = std::fs::metadata(&resolved_script_path).map_err(|_| {
        AppError::Forbidden(format!(
            "Safety block [script_scan_unreadable]: script file '{}' could not be read. Make it readable and retry; do not bypass script scanning.",
            script_path
        ))
    })?;
    if metadata.len() > MAX_SCRIPT_SCAN_BYTES {
        return Err(AppError::Forbidden(format!(
            "Safety block [script_scan_too_large]: script file '{}' exceeds the scan budget. Make it smaller and retry; do not bypass script scanning.",
            script_path
        )));
    }
    const MAX_SCRIPT_GRAPH_FILES: usize = 256;
    const MAX_SCRIPT_GRAPH_BYTES: u64 = 64 * 1024 * 1024;
    let effective_extension = runtime_language_extension(command, script_path)
        .map(str::to_string)
        .unwrap_or_else(|| script_path_extension(script_path));
    let identity_path = std::fs::canonicalize(&resolved_script_path)
        .unwrap_or_else(|_| normalize_path_lexically(&resolved_script_path));
    let identity = format!(
        "{}|{}",
        script_path_dedup_key(&identity_path.to_string_lossy()),
        effective_extension
    );
    if !scan_state.visited_files.insert(identity) {
        return Ok(());
    }
    if scan_state.file_count >= MAX_SCRIPT_GRAPH_FILES
        || scan_state.total_bytes.saturating_add(metadata.len()) > MAX_SCRIPT_GRAPH_BYTES
    {
        return Err(AppError::Forbidden(format!(
            "Safety block [script_scan_too_large]: nested script graph containing '{}' exceeds the scan budget. Split the call graph and retry; do not bypass script scanning.",
            script_path
        )));
    }
    scan_state.file_count += 1;
    scan_state.total_bytes = scan_state.total_bytes.saturating_add(metadata.len());
    let mut file = std::fs::File::open(&resolved_script_path).map_err(|_| {
        AppError::Forbidden(format!(
            "Safety block [script_scan_unreadable]: script file '{}' could not be read. Make it readable and retry; do not bypass script scanning.",
            script_path
        ))
    })?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    std::io::Read::take(&mut file, MAX_SCRIPT_SCAN_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            AppError::Forbidden(format!(
                "Safety block [script_scan_unreadable]: script file '{}' could not be read within the scan budget. Make it readable and retry; do not bypass script scanning.",
                script_path
            ))
        })?;
    if bytes.len() as u64 > MAX_SCRIPT_SCAN_BYTES {
        return Err(AppError::Forbidden(format!(
            "Safety block [script_scan_too_large]: script file '{}' changed beyond the scan budget. Make it smaller and retry; do not bypass script scanning.",
            script_path
        )));
    }
    let content = if bytes.starts_with(&[0xff, 0xfe, 0x00, 0x00]) {
        bytes[4..]
            .chunks_exact(4)
            .map(|quad| u32::from_le_bytes([quad[0], quad[1], quad[2], quad[3]]))
            .map(|value| char::from_u32(value).unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect()
    } else if bytes.starts_with(&[0x00, 0x00, 0xfe, 0xff]) {
        bytes[4..]
            .chunks_exact(4)
            .map(|quad| u32::from_be_bytes([quad[0], quad[1], quad[2], quad[3]]))
            .map(|value| char::from_u32(value).unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect()
    } else if bytes.starts_with(&[0xff, 0xfe]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else if !bytes.is_empty()
        && bytes
            .iter()
            .filter(|byte| **byte == 0)
            .count()
            .saturating_mul(8)
            > bytes.len()
    {
        return Err(AppError::Forbidden(format!(
            "Safety block [script_scan_unreadable]: script file '{}' uses an unsupported or ambiguous text encoding. Save it as UTF-8, UTF-16, or BOM-marked UTF-32 and retry; do not bypass script scanning.",
            script_path
        )));
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    log::debug!(
        "[CommandValidator] 脚本文件已读取: {} ({} 字符)",
        resolved_script_path.display(),
        content.len()
    );

    validate_script_source(
        script_path,
        &effective_extension,
        &content,
        workdir,
        depth,
        scan_state,
    )
}

pub fn validate_script_content(command: &str, workdir: Option<&str>) -> Result<(), AppError> {
    if let Some(detail) = ambiguous_script_invocation(command) {
        return Err(AppError::Forbidden(format!(
            "Safety block [script_scan_ambiguous_launcher]: {}. Retry with an explicit supported local entrypoint; do not bypass script scanning.",
            detail
        )));
    }
    let mut scan_state = ScriptScanState::default();
    for (label, extension, source) in inline_script_sources(command) {
        validate_script_source(&label, extension, &source, workdir, 0, &mut scan_state)?;
    }
    let mut script_paths = extract_script_paths(command);
    for module_path in python_local_module_paths(command, workdir) {
        if !script_paths
            .iter()
            .any(|path| script_paths_equal(path, &module_path))
        {
            script_paths.push(module_path);
        }
    }
    if script_paths.is_empty() {
        return Ok(());
    }

    for script_path in script_paths {
        validate_single_script_content(&script_path, command, workdir, 0, &mut scan_state)?;
    }
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
        guard.clear();
    }

    #[cfg(unix)]
    fn create_test_directory_link(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(target_os = "windows")]
    fn create_test_directory_link(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    #[cfg(not(any(unix, target_os = "windows")))]
    fn create_test_directory_link(_target: &Path, _link: &Path) -> std::io::Result<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "directory links are unsupported on this platform",
        ))
    }

    #[cfg(unix)]
    fn remove_test_directory_link(link: &Path) {
        let _ = std::fs::remove_file(link);
    }

    #[cfg(target_os = "windows")]
    fn remove_test_directory_link(link: &Path) {
        let _ = std::fs::remove_dir(link);
    }

    #[cfg(not(any(unix, target_os = "windows")))]
    fn remove_test_directory_link(_link: &Path) {}

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
    fn test_powershell_encoded_command_prefixes_require_option_syntax() {
        let dir = test_app_dir();
        for command in [
            "powershell -enco dABlAHMAdA==",
            "pwsh -e dABlAHMAdA==",
            "powershell /encodedcommand dABlAHMAdA==",
            r#"cmd /d /s /c "power^shell.exe -e^nc dABlAHMAdA==""#,
        ] {
            assert!(
                validate_command_safety(command, &dir).is_err(),
                "encoded option must be blocked: {command}"
            );
        }

        for command in [
            "powershell enco",
            "pwsh encodedcommand",
            r#"powershell -Command "Write-Output enco""#,
            r#"powershell -ExecutionPolicy Bypass -Command "Write-Output -e""#,
        ] {
            assert!(
                validate_command_safety(command, &dir).is_ok(),
                "ordinary argument must not be treated as an encoded option: {command}"
            );
        }
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
    fn test_executable_tool_names_and_semantic_whitespace_are_blocked() {
        let dir = test_app_dir();
        for command in [
            "reg.exe\tdelete HKCU\\Software\\Test",
            "sc.exe  \t delete MyService",
            "net.exe\tuser hacker P@ss /add",
        ] {
            assert!(
                validate_command_safety(command, &dir).is_err(),
                "destructive executable subcommand must be blocked: {command:?}"
            );
        }
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

    #[test]
    fn test_compact_cmd_delete_flags_on_core_paths_are_blocked() {
        let dir = test_app_dir();
        for command in [
            r"del/f/q C:\Windows\temp.log",
            r"erase/f/q C:\Windows\temp.log",
            r"rd/s/q C:\Windows\Temp",
            r"rmdir/s/q C:\Windows\Temp",
        ] {
            assert!(
                validate_command_safety(command, &dir).is_err(),
                "compact CMD delete form must remain destructive: {command}"
            );
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_relative_core_path_uses_windows_workdir_and_normalizes_parent_segments() {
        let dir = test_app_dir();
        assert!(validate_command_safety_with_workdir(
            r#"del "..\win.ini""#,
            &dir,
            Some(Path::new(r"C:\Windows\Temp")),
        )
        .is_err());
        assert!(validate_command_safety_with_workdir(
            r#"powershell -Command "Remove-Item ..\kernel32.dll -Force""#,
            &dir,
            Some(Path::new(r"C:\Windows\System32\drivers")),
        )
        .is_err());
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
        assert!(validate_command_safety("format.com F:", &dir).is_err());
        assert!(
            validate_command_safety(r#""C:\Windows\System32\format.com" G: /q"#, &dir,).is_err()
        );
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
    fn test_lexical_normalization_preserves_unconsumed_parent_components() {
        assert_eq!(
            normalize_path_lexically(Path::new("../../target")),
            PathBuf::from("../../target")
        );
        assert_eq!(
            normalize_path_lexically(Path::new("base/../../target")),
            PathBuf::from("../target")
        );
    }

    #[test]
    fn test_relative_targets_use_actual_cwd_and_relative_workdir() {
        let _guard = lock_custom_protected_paths();
        reset_custom_protected_paths();
        let app_dir = std::env::temp_dir().join("agentvis_relative_target_resolution_test");
        let _ = std::fs::remove_dir_all(&app_dir);
        std::fs::create_dir_all(&app_dir).unwrap();

        let cwd = std::env::current_dir().unwrap();
        let cwd_protected = cwd.join("agentvis-cwd-protected-target");
        let relative_workdir = Path::new("agentvis-relative-workdir/protected");
        let workdir_protected = cwd.join(relative_workdir);
        let paths = vec![
            cwd_protected.to_string_lossy().to_string(),
            workdir_protected.to_string_lossy().to_string(),
        ];
        std::fs::write(
            app_dir.join("protected_paths.json"),
            serde_json::to_vec(&paths).unwrap(),
        )
        .unwrap();
        reload_custom_protected_paths(&app_dir).unwrap();

        assert!(validate_command_safety_with_workdir(
            "del agentvis-cwd-protected-target/secret.txt",
            &app_dir,
            None,
        )
        .is_err());
        assert!(validate_command_safety_with_workdir(
            "del secret.txt",
            &app_dir,
            Some(relative_workdir),
        )
        .is_err());

        let _ = std::fs::remove_dir_all(&app_dir);
        reset_custom_protected_paths();
    }

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
        reload_custom_protected_paths(&dir).unwrap();

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
            guard.clear();
        }
    }

    #[test]
    fn test_invalid_protected_paths_reload_preserves_last_known_good_cache() {
        let _guard = lock_custom_protected_paths();
        let base = std::env::temp_dir().join("agentvis_protected_paths_lkg_test");
        let app_dir = base.join("app");
        let protected_parent = base.join("data");
        let protected_dir = protected_parent.join("protected");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::create_dir_all(&protected_dir).unwrap();

        let config = app_dir.join("protected_paths.json");
        std::fs::write(
            &config,
            serde_json::to_string(&vec![protected_dir.to_string_lossy().to_string()]).unwrap(),
        )
        .unwrap();
        reload_custom_protected_paths(&app_dir).unwrap();
        assert!(validate_command_safety_with_workdir(
            "del secret.txt",
            &app_dir,
            Some(&protected_dir),
        )
        .is_err());
        assert!(validate_delete_target_safety(&protected_parent, &app_dir).is_err());

        std::fs::write(&config, "{ definitely-not-json").unwrap();
        assert!(reload_custom_protected_paths(&app_dir).is_err());
        assert!(validate_command_safety_with_workdir(
            "del secret.txt",
            &app_dir,
            Some(&protected_dir),
        )
        .is_err());

        std::fs::remove_file(&config).unwrap();
        let missing_reload_error = reload_custom_protected_paths(&app_dir).unwrap_err();
        assert!(
            missing_reload_error.to_string().contains("disappeared"),
            "explicit reload must distinguish a missing file from an intentional empty array"
        );
        assert!(
            validate_delete_target_safety(&protected_dir.join("secret.txt"), &app_dir).is_err(),
            "a missing config file must not erase the last-known-good target guard"
        );
        assert!(
            validate_delete_target_safety(&app_dir.join("protected_paths.json"), &app_dir).is_err()
        );
        assert!(validate_delete_target_safety(&app_dir.join("Agent_Trash_Bin"), &app_dir).is_err());

        let _ = std::fs::remove_dir_all(&base);
        reset_custom_protected_paths();
    }

    #[test]
    fn test_protected_paths_resource_limits_preserve_last_known_good_cache() {
        let _guard = lock_custom_protected_paths();
        reset_custom_protected_paths();
        let base = std::env::temp_dir().join("agentvis_protected_paths_limits_test");
        let app_dir = base.join("app");
        let protected_dir = base.join("protected");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::create_dir_all(&protected_dir).unwrap();
        let config = app_dir.join("protected_paths.json");
        let last_known_good = vec![protected_dir.to_string_lossy().to_string()];
        std::fs::write(&config, serde_json::to_vec(&last_known_good).unwrap()).unwrap();
        reload_custom_protected_paths(&app_dir).unwrap();

        std::fs::write(
            &config,
            vec![b' '; MAX_PROTECTED_PATHS_FILE_BYTES as usize + 1],
        )
        .unwrap();
        let file_limit_error = reload_custom_protected_paths(&app_dir).unwrap_err();
        assert!(file_limit_error.to_string().contains("byte safety limit"));
        assert_eq!(
            load_custom_protected_paths(&app_dir).unwrap(),
            last_known_good
        );

        let too_many_paths = vec!["x".to_string(); MAX_PROTECTED_PATHS_ENTRIES + 1];
        std::fs::write(&config, serde_json::to_vec(&too_many_paths).unwrap()).unwrap();
        let entry_limit_error = reload_custom_protected_paths(&app_dir).unwrap_err();
        assert!(entry_limit_error.to_string().contains("entry safety limit"));
        assert_eq!(
            load_custom_protected_paths(&app_dir).unwrap(),
            last_known_good
        );

        let too_long_path = vec!["x".repeat(MAX_PROTECTED_PATH_BYTES + 1)];
        std::fs::write(&config, serde_json::to_vec(&too_long_path).unwrap()).unwrap();
        let path_limit_error = reload_custom_protected_paths(&app_dir).unwrap_err();
        assert!(path_limit_error.to_string().contains("path exceeding"));
        assert_eq!(
            load_custom_protected_paths(&app_dir).unwrap(),
            last_known_good
        );

        let encoded_too_large = vec!["\\".repeat(MAX_PROTECTED_PATH_BYTES); 17];
        let encoded_limit_error = validate_protected_paths_config(&encoded_too_large).unwrap_err();
        assert!(
            encoded_limit_error
                .to_string()
                .contains("after JSON encoding"),
            "the pre-write helper must include JSON escaping in its byte budget"
        );

        let _ = std::fs::remove_dir_all(&base);
        reset_custom_protected_paths();
    }

    #[test]
    fn test_delete_target_does_not_follow_terminal_directory_link() {
        let _guard = lock_custom_protected_paths();
        reset_custom_protected_paths();
        let base = std::env::temp_dir().join("agentvis_terminal_delete_link_test");
        let app_dir = base.join("app");
        let safe_dir = base.join("safe");
        let protected_dir = base.join("protected");
        let terminal_link = safe_dir.join("protected-link");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::create_dir_all(&safe_dir).unwrap();
        std::fs::create_dir_all(&protected_dir).unwrap();
        std::fs::write(protected_dir.join("secret.txt"), b"secret").unwrap();
        std::fs::write(
            app_dir.join("protected_paths.json"),
            serde_json::to_vec(&vec![protected_dir.to_string_lossy().to_string()]).unwrap(),
        )
        .unwrap();
        reload_custom_protected_paths(&app_dir).unwrap();

        if let Err(error) = create_test_directory_link(&protected_dir, &terminal_link) {
            eprintln!("skipping directory-link assertions: {error}");
            let _ = std::fs::remove_dir_all(&base);
            reset_custom_protected_paths();
            return;
        }

        assert!(
            validate_delete_target_safety(&terminal_link, &app_dir).is_ok(),
            "deleting the terminal link item must not be confused with deleting its destination"
        );
        assert!(
            validate_delete_target_safety(&terminal_link.join("secret.txt"), &app_dir).is_err(),
            "an intermediate link must still resolve into the protected destination"
        );
        assert!(
            validate_delete_target_safety(&protected_dir.join("terminal-link"), &app_dir).is_err(),
            "a terminal link lexically inside a protected root must remain blocked"
        );

        remove_test_directory_link(&terminal_link);
        let _ = std::fs::remove_dir_all(&base);
        reset_custom_protected_paths();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_delete_target_canonicalizes_windows_terminal_aliases() {
        let _guard = lock_custom_protected_paths();
        reset_custom_protected_paths();
        let base = std::env::temp_dir().join(format!(
            "agentvis_terminal_delete_alias_test_{}",
            uuid::Uuid::new_v4()
        ));
        let app_dir = base.join("app");
        let protected_dir = base.join("protected");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::create_dir_all(&protected_dir).unwrap();
        std::fs::write(
            app_dir.join("protected_paths.json"),
            serde_json::to_vec(&vec![protected_dir.to_string_lossy().to_string()]).unwrap(),
        )
        .unwrap();
        reload_custom_protected_paths(&app_dir).unwrap();

        let trailing_dot_alias = PathBuf::from(format!("{}.", protected_dir.display()));
        assert!(
            validate_delete_target_safety(&trailing_dot_alias, &app_dir).is_err(),
            "a trailing-dot alias must resolve to the protected terminal object"
        );

        let _ = std::fs::remove_dir_all(&base);
        reset_custom_protected_paths();
    }

    #[test]
    fn test_protected_volume_root_matches_descendants() {
        assert!(path_matches_protected_path(
            Path::new(r"C:\Users\example\file.txt"),
            r"C:\"
        ));
        assert!(!path_matches_protected_path(
            Path::new(r"D:\Users\example\file.txt"),
            r"C:\"
        ));
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
        reload_custom_protected_paths(&app_dir).unwrap();

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
        for command in [
            "del/f/q secrets.txt",
            "erase/f/q secrets.txt",
            "rd/s/q old",
            "rmdir/s/q old",
            "cmd.exe /q/d/c del/f/q secrets.txt",
        ] {
            assert!(
                validate_command_safety_with_workdir(command, &app_dir, Some(&protected_dir),)
                    .is_err(),
                "compact CMD delete must honor relative protected paths: {command}"
            );
        }
        assert!(validate_command_safety_with_workdir(
            r#"powershell -Command "Remove-Item secrets.txt -Force""#,
            &app_dir,
            Some(&protected_dir),
        )
        .is_err());
        for alias in ["ri", "rm"] {
            let command = format!(r#"powershell -Command "{alias} secrets.txt -Force""#);
            assert!(
                validate_command_safety_with_workdir(&command, &app_dir, Some(&protected_dir),)
                    .is_err(),
                "PowerShell alias must honor relative protected paths: {alias}"
            );
        }
        assert!(validate_command_safety_with_workdir(
            r#"del "../Protected Root/secrets.txt""#,
            &app_dir,
            Some(&outside_dir),
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
        reload_custom_protected_paths(&app_dir).unwrap();

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
        assert_eq!(
            extract_script_path(r"powershell.exe -NoProfile .\cleanup.ps1"),
            Some(r".\cleanup.ps1".to_string())
        );
        assert_eq!(
            extract_script_path(r"powershell.exe -NoProfile -ExecutionPolicy Bypass .\cleanup.ps1"),
            Some(r".\cleanup.ps1".to_string())
        );
        assert_eq!(
            extract_script_path(r#"powershell -NoProfile -Command ".\cleanup.ps1""#),
            Some(r".\cleanup.ps1".to_string())
        );
        assert_eq!(
            extract_script_path(r#"pwsh -NoProfile -Command "& '.\cleanup.ps1'""#),
            Some(r".\cleanup.ps1".to_string())
        );
        assert_eq!(
            extract_script_path(
                r#"powershell -NoProfile -Command "& 'C:\scripts with spaces\cleanup.ps1'""#
            ),
            Some(r"C:\scripts with spaces\cleanup.ps1".to_string())
        );
        assert_eq!(
            extract_script_path(r#"powershell -Command "Write-Output cleanup.ps1""#),
            None
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
    fn test_extract_javascript_runtimes() {
        assert_eq!(
            extract_script_path("node --trace-warnings cleanup.js"),
            Some("cleanup.js".to_string())
        );
        assert_eq!(
            extract_script_path("bun run cleanup.mjs"),
            Some("cleanup.mjs".to_string())
        );
        assert_eq!(
            extract_script_path(r#"deno run --allow-write "C:\scripts with spaces\cleanup.ts""#),
            Some("C:\\scripts with spaces\\cleanup.ts".to_string())
        );
    }

    #[test]
    fn test_extract_cmd_wrapped_script() {
        assert_eq!(
            extract_script_path("cmd /d /s /c cleanup.cmd --all"),
            Some("cleanup.cmd".to_string())
        );
        assert_eq!(
            extract_script_path(r#"cmd.exe /s /c "C:\scripts with spaces\cleanup.bat""#),
            Some("C:\\scripts with spaces\\cleanup.bat".to_string())
        );
        assert_eq!(
            extract_script_path(r#"cmd /d /s /c "cleanup.cmd --all""#),
            Some("cleanup.cmd".to_string())
        );
        assert_eq!(
            extract_script_path("cmd.exe /q/d/c cleanup.cmd --all"),
            Some("cleanup.cmd".to_string())
        );
        assert_eq!(
            extract_script_path(r#"%ComSpec% /d /s /c "C:\scripts with spaces\cleanup.cmd""#),
            Some("C:\\scripts with spaces\\cleanup.cmd".to_string())
        );
    }

    #[test]
    fn test_extracts_every_chained_or_runtime_loaded_script() {
        assert_eq!(
            extract_script_paths("python safe.py && python destructive.py"),
            vec!["safe.py".to_string(), "destructive.py".to_string()]
        );
        assert_eq!(
            extract_script_paths("node -r ./safe-hook.js destructive.js"),
            vec!["./safe-hook.js".to_string(), "destructive.js".to_string()]
        );
        assert_eq!(
            extract_script_paths(r#"cmd /d /s /c "safe.cmd && destructive.cmd""#),
            vec!["safe.cmd".to_string(), "destructive.cmd".to_string()]
        );
        assert_eq!(
            extract_script_path(r#"cmd /c "C:\safe.cmd.dir\destructive.cmd --all""#),
            Some("C:\\safe.cmd.dir\\destructive.cmd".to_string())
        );
    }

    #[test]
    fn runtime_script_extraction_consumes_option_values_and_honors_double_dash() {
        for (command, expected) in [
            ("python -W ignore safe.py", vec!["safe.py"]),
            ("python -Wignore -X dev safe.py", vec!["safe.py"]),
            ("python -q safe.py", vec!["safe.py"]),
            ("python -x safe.py", vec!["safe.py"]),
            (
                "python --check-hash-based-pycs always safe.py",
                vec!["safe.py"],
            ),
            ("python -- -leading.py", vec!["-leading.py"]),
            (
                "node --require ts-node/register --inspect-port 9230 app.js",
                vec!["app.js"],
            ),
            (
                "node --require ./safe-hook.js app.js",
                vec!["./safe-hook.js", "app.js"],
            ),
            (
                "node --require=./Safe-Hook.JS App.JS",
                vec!["./Safe-Hook.JS", "App.JS"],
            ),
            (
                "node --experimental_loader=./Loader.MJS App.JS",
                vec!["./Loader.MJS", "App.JS"],
            ),
            ("node -c app.js", vec!["app.js"]),
            ("node -C development app.js", vec!["app.js"]),
            ("node inspect app.js", vec!["app.js"]),
            ("node inspect cleanup.txt", vec!["cleanup.txt"]),
            ("node inspect localhost:9229", vec![]),
            ("node inspect ws://127.0.0.1:9229/session", vec![]),
            (
                "node --experimental-config-file config.json app.js",
                vec!["app.js"],
            ),
            (
                "node --test-global-setup ./setup.js app.js",
                vec!["./setup.js", "app.js"],
            ),
            (
                "node --test-reporter ./reporter.js app.js",
                vec!["./reporter.js", "app.js"],
            ),
            ("node -- payload.js", vec!["payload.js"]),
            ("deno run --config deno.json -- app.ts", vec!["app.ts"]),
            (
                "deno run --preload ./hook.ts app.ts",
                vec!["./hook.ts", "app.ts"],
            ),
            ("deno serve app.ts", vec!["app.ts"]),
            (
                "deno test --config deno.json app_test.ts",
                vec!["app_test.ts"],
            ),
            ("deno test --filter cleanup.ts", vec![]),
            (
                "deno test --filter cleanup app_test.ts",
                vec!["app_test.ts"],
            ),
            ("deno bench --filter cleanup.ts", vec![]),
            ("deno test app_test.ts -- payload.ts", vec!["app_test.ts"]),
            (
                "bun --preload ./hook.ts app.ts",
                vec!["./hook.ts", "app.ts"],
            ),
            ("bun --import ./hook.ts app.ts", vec!["./hook.ts", "app.ts"]),
            ("bun -c bunfig.toml app.ts", vec!["app.ts"]),
            ("bun run app.ts", vec!["app.ts"]),
            ("bun run --filter cleanup.ts build", vec![]),
            ("bun run ./extensionless", vec!["./extensionless"]),
            ("bun test app.test.ts", vec![]),
            ("bun test ./app.test.ts", vec!["./app.test.ts"]),
            ("bun test --test-name-pattern cleanup.ts", vec![]),
            ("bun test -tcleanup.ts", vec![]),
        ] {
            assert_eq!(
                extract_script_paths(command),
                expected.into_iter().map(str::to_string).collect::<Vec<_>>(),
                "{command}"
            );
        }
    }

    #[test]
    fn runtime_inline_module_and_task_modes_do_not_misclassify_data_as_scripts() {
        for command in [
            r#"python -c "print('safe')" payload.py"#,
            r#"python -Bc "print('safe')" payload.py"#,
            r#"python -qc "print('safe')" payload.py"#,
            "python -m http.server payload.py",
            r#"node --eval "console.log('safe')" payload.js"#,
            r#"node -p "process.version" payload.js"#,
            r#"node -pe "process.version" payload.js"#,
            r#"node --diagnostic-dir logs -e "console.log('safe')" payload.js"#,
            "node --run test",
            r#"deno eval "console.log('safe')" payload.ts"#,
            r#"deno eval -- "-console.log('safe')" payload.ts"#,
            "deno task build",
            "deno test",
            "bun run build",
            r#"bun --eval "console.log('safe')" payload.ts"#,
        ] {
            assert!(
                extract_script_paths(command).is_empty(),
                "{command} should not expose a file entrypoint"
            );
        }
    }

    #[test]
    fn inline_runtime_sources_are_scanned_without_treating_arguments_as_files() {
        for command in [
            r#"python -c "import os; os.remove('important.txt')""#,
            r#"python -Bc "import os; os.remove('important.txt')""#,
            r#"python -qc "import os; os.remove('important.txt')""#,
            r#"node -e "require('fs').unlinkSync('important.txt')""#,
            r#"node -pe "require('fs').unlinkSync('important.txt')""#,
            r#"node --diagnostic-dir logs -e "require('fs').unlinkSync('important.txt')""#,
            r#"bun --eval "require('fs').rmSync('important.txt')""#,
            r#"deno eval "Deno.removeSync('important.txt')""#,
            r#"deno eval -- "-Deno.removeSync('important.txt')""#,
            r#"powershell -Command "Remove-Item important.txt""#,
            r#"powershell -Command "python -c '__import__(chr(111)+chr(115)).unlink(chr(120))'""#,
        ] {
            let error = validate_script_content(command, None)
                .expect_err("inline deletion source must be scanned");
            assert!(
                error.to_string().contains(RECOVERABLE_DELETE_BLOCK_PREFIX),
                "{command}: {error}"
            );
        }

        for command in [
            r#"python -c "print('os.remove(important.txt)')""#,
            r#"node -e "console.log('fs.rmSync(important.txt)')""#,
            r#"powershell -Command "Write-Output 'Remove-Item important.txt'""#,
        ] {
            assert!(validate_script_content(command, None).is_ok(), "{command}");
        }
    }

    #[test]
    fn ambiguous_runtime_resolution_fails_with_specific_recovery_reason() {
        for command in [
            "node -r ./extensionless app.js",
            "bun --preload ./extensionless app.ts",
            "deno run https://example.invalid/remote.ts",
            "bun --cwd sub app.ts",
            "cd sub && node app.js",
        ] {
            let error = validate_script_content(command, None)
                .expect_err("unscannable runtime resolution must fail closed");
            assert!(
                error
                    .to_string()
                    .contains("[script_scan_ambiguous_launcher]"),
                "{command}: {error}"
            );
        }
    }

    #[test]
    fn launcher_only_options_stop_at_the_real_entrypoint() {
        for command in [
            "node app.js --import data:text/javascript,ignored",
            "bun app.ts --preload ./extensionless",
            "deno run app.ts --preload ./extensionless",
        ] {
            let tokens = split_shell_tokens(command);
            let runtime = token_command_name(tokens.first().unwrap());
            assert!(
                !runtime_preload_is_ambiguous(&tokens, &runtime),
                "application argv must not be parsed as a runtime preload: {command}"
            );
        }
        for command in [
            "node app.js --cwd output",
            "bun app.ts --cwd output",
            "deno run app.ts --cwd output",
        ] {
            let tokens = split_shell_tokens(command);
            let runtime = token_command_name(tokens.first().unwrap());
            assert!(
                !runtime_cwd_option_precedes_entry(&tokens, &runtime),
                "application argv must not be parsed as runtime cwd: {command}"
            );
        }

        for command in [
            "bun --cwd output app.ts",
            "deno --cwd output run app.ts",
            "bun test --test-name-pattern cleanup.ts --cwd output",
            "deno test --filter cleanup.ts --cwd output",
        ] {
            let tokens = split_shell_tokens(command);
            let runtime = token_command_name(tokens.first().unwrap());
            assert!(runtime_cwd_option_precedes_entry(&tokens, &runtime));
        }
    }

    #[test]
    fn dangerous_node_runtime_configuration_fails_ambiguous() {
        for command in [
            "node --experimental-config-file config.json app.js",
            "node --experimental-default-config-file app.js",
            "node --build-snapshot-config snapshot.json app.js",
            "node --snapshot-blob snapshot.blob app.js",
        ] {
            let detail = ambiguous_script_invocation(command)
                .expect("indirect Node configuration must fail closed");
            assert!(
                detail.contains("runtime configuration"),
                "{command}: {detail}"
            );
        }
        assert!(
            ambiguous_script_invocation("node --test-global-setup ./setup.js app.js").is_none()
        );
    }

    #[test]
    fn powershell_launcher_options_stop_at_file_or_command_boundary() {
        let file_tokens = split_shell_tokens(
            r#"pwsh -File safe.ps1 -Command "Remove-Item important.txt" -wd ignored"#,
        );
        assert!(powershell_command_payload(&file_tokens).is_none());
        assert!(!powershell_workdir_option_precedes_entry(&file_tokens));
        assert_eq!(
            extract_script_paths(
                r#"pwsh -File safe.ps1 -Command "Remove-Item important.txt" -wd ignored"#
            ),
            vec!["safe.ps1".to_string()]
        );
        assert!(
            extract_script_paths(r#"pwsh -Command "Write-Output -File cleanup.ps1""#).is_empty()
        );

        for command in [
            "pwsh -wd sub -File safe.ps1",
            "pwsh -WorkingDirectory:sub -File safe.ps1",
            "pwsh -WorkingDirectory=sub -File safe.ps1",
        ] {
            assert!(powershell_workdir_option_precedes_entry(
                &split_shell_tokens(command)
            ));
        }
    }

    #[test]
    fn python_m_scans_only_statically_local_modules() {
        let dir = std::env::temp_dir().join("agentvis_python_local_module_scan_test");
        let package = dir.join("cleanup_package");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            dir.join("cleanup.py"),
            "import os\nos.remove('important.txt')\n",
        )
        .unwrap();
        std::fs::write(dir.join("safe.py"), "print('safe')\n").unwrap();
        std::fs::write(package.join("__init__.py"), "print('package')\n").unwrap();
        std::fs::write(
            package.join("__main__.py"),
            "from pathlib import Path\nPath('important.txt').unlink()\n",
        )
        .unwrap();
        let workdir = dir.to_str().unwrap();

        for command in [
            "python -m cleanup",
            "python -Bm cleanup",
            "python -m cleanup_package",
        ] {
            let error = validate_script_content(command, Some(workdir))
                .expect_err("local Python module deletion must be scanned");
            assert!(
                error.to_string().contains(RECOVERABLE_DELETE_BLOCK_PREFIX),
                "{command}: {error}"
            );
        }
        assert!(validate_script_content("python -m safe", Some(workdir)).is_ok());
        assert!(validate_script_content(
            "python -m agentvis_nonlocal_dependency_boundary",
            Some(workdir)
        )
        .is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn powershell_command_wrapper_recursively_scans_runtime_entrypoint() {
        let dir = std::env::temp_dir().join("agentvis_powershell_runtime_wrapper_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("cleanup.js"),
            "require('fs').rmSync('important.txt');\n",
        )
        .unwrap();

        let error = validate_script_content(
            r#"powershell -Command "node cleanup.js""#,
            Some(dir.to_str().unwrap()),
        )
        .expect_err("PowerShell command payload runtime must be scanned");
        assert!(error.to_string().contains(RECOVERABLE_DELETE_BLOCK_PREFIX));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nested_dynamic_entry_and_workdir_fail_ambiguous_instead_of_scanning_a_decoy() {
        let dir = std::env::temp_dir().join("agentvis_dynamic_nested_script_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("dynamic.py"),
            "import subprocess, sys\nsubprocess.run([sys.executable, script_var])\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("cwd.py"),
            "import subprocess, sys\nsubprocess.run([sys.executable, 'nested.py'], cwd='wrappers')\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("safe.py"),
            "note = \"subprocess.run(['python', 'missing.py'])\"\nprint(note)\n",
        )
        .unwrap();

        for script in ["dynamic.py", "cwd.py"] {
            let error =
                validate_script_content(&format!("python {script}"), Some(dir.to_str().unwrap()))
                    .expect_err("ambiguous nested launch must fail closed");
            assert!(
                error
                    .to_string()
                    .contains("[script_scan_ambiguous_launcher]"),
                "{script}: {error}"
            );
        }
        assert!(validate_script_content("python safe.py", Some(dir.to_str().unwrap())).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
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
    fn test_python_arbitrary_extension_is_scanned_and_safe_script_passes() {
        let dir = std::env::temp_dir().join("agentvis_python_arbitrary_extension_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("cleanup.txt"),
            "import os as io\nio.remove('important.txt')\n",
        )
        .unwrap();
        std::fs::write(dir.join("safe.data"), "print('safe')\n").unwrap();

        let error = validate_script_content("python cleanup.txt", Some(dir.to_str().unwrap()))
            .expect_err("arbitrary-extension Python deletion must be scanned");
        assert!(error.to_string().contains(RECOVERABLE_DELETE_BLOCK_PREFIX));
        assert!(
            validate_script_content("python safe.data", Some(dir.to_str().unwrap())).is_ok(),
            "safe arbitrary-extension Python script must remain executable"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_cscript_engine_controls_scanning_and_unknown_extension_fails_closed() {
        let dir = std::env::temp_dir().join("agentvis_cscript_engine_scan_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let destructive_vbs = concat!(
            "Set fso = CreateObject(\"Scripting.FileSystemObject\")\n",
            "target = \"important.txt\"\n",
            "fso.DeleteFile target\n"
        );
        std::fs::write(dir.join("cleanup.txt"), destructive_vbs).unwrap();
        std::fs::write(dir.join("cleanup.vbs"), destructive_vbs).unwrap();

        for command in [
            "cscript //E:VBScript //nologo cleanup.txt",
            "cscript //nologo cleanup.vbs",
        ] {
            let error = validate_script_content(command, Some(dir.to_str().unwrap()))
                .expect_err("VBScript deletion must be scanned");
            assert!(
                error.to_string().contains(RECOVERABLE_DELETE_BLOCK_PREFIX),
                "expected recoverable block for {command}: {error}"
            );
        }

        let error =
            validate_script_content("cscript //nologo cleanup.txt", Some(dir.to_str().unwrap()))
                .expect_err("ambiguous WSH script extension must fail closed");
        assert!(error
            .to_string()
            .contains("[script_scan_ambiguous_launcher]"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_deno_and_csharp_object_delete_apis_are_blocked() {
        let dir = std::env::temp_dir().join("agentvis_additional_runtime_delete_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("cleanup.ts"),
            "await Deno.remove('important', { recursive: true });\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("cleanup.cs"),
            "new System.IO.FileInfo(\"important.txt\").Delete();\n",
        )
        .unwrap();

        for command in ["deno run cleanup.ts", "csc cleanup.cs"] {
            let error = validate_script_content(command, Some(dir.to_str().unwrap()))
                .expect_err("runtime deletion API must be scanned");
            assert!(
                error.to_string().contains(RECOVERABLE_DELETE_BLOCK_PREFIX),
                "expected recoverable block for {command}: {error}"
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_python_delete_apis_detected() {
        for (source, expected) in [
            ("os.remove(target)", "os.remove"),
            ("os . unlink (target)", "os.unlink"),
            ("shutil.rmtree(root)", "shutil.rmtree"),
            ("Path(target).unlink()", "pathlib.Path.unlink"),
            ("target_path.rmdir()", "pathlib.Path.rmdir"),
        ] {
            assert_eq!(detect_python_delete(source), Some(expected));
        }
        assert_eq!(
            detect_python_delete("# os.remove(target)\nprint('safe')"),
            None
        );
    }

    #[test]
    fn test_powershell_delete_commands_detected_outside_comments_and_strings() {
        for source in [
            "Remove-Item -LiteralPath $target",
            "Get-ChildItem | ri -Force",
            "if ($ok) { del $target }",
            "erase $target",
            "rd $target -Recurse",
            "& rmdir $target",
        ] {
            assert!(detect_powershell_delete(source).is_some(), "{source}");
        }
        assert_eq!(
            detect_powershell_delete("# Remove-Item target\nWrite-Host 'ri target'"),
            None
        );
    }

    #[test]
    fn forbidden_script_scan_ignores_comments_and_ordinary_strings() {
        let inert_warning = concat!(
            "diskpart bcdedit cipher /w takeown sfc / net user sc delete ",
            "reg delete reg add hklm session manager\\environment setenvironmentvariable"
        );
        for (extension, content) in [
            (
                "py",
                format!("# {inert_warning}\nnote = \"{inert_warning}\"\nprint(note)\n"),
            ),
            (
                "js",
                format!("// {inert_warning}\nconst note = \"{inert_warning}\";\nconsole.log(note);\n"),
            ),
            (
                "ps1",
                format!("# {inert_warning}\n$note = '{inert_warning}'\nWrite-Output $note\n"),
            ),
            (
                "cs",
                format!("// {inert_warning}\nvar note = \"{inert_warning}\";\nConsole.WriteLine(note);\n"),
            ),
            (
                "vbs",
                format!("' {inert_warning}\nnote = \"{inert_warning}\"\nWScript.Echo note\n"),
            ),
            (
                "bat",
                format!("rem {inert_warning}\necho {inert_warning}\nset note={inert_warning}\n"),
            ),
        ] {
            assert_eq!(
                detect_script_forbidden_keyword(extension, &content),
                None,
                "{extension}"
            );
        }
    }

    #[test]
    fn forbidden_script_scan_ignores_sink_examples_stored_as_data() {
        for (extension, content) in [
            ("py", "note = \"subprocess.run('diskpart')\"\nprint(note)\n"),
            (
                "js",
                "const note = \"exec('reg delete HKCU\\\\Demo')\";\nconsole.log(note);\n",
            ),
            (
                "ps1",
                "$note = \"Start-Process 'bcdedit'\"\nWrite-Output $note\n",
            ),
            (
                "cs",
                "var note = \"Process.Start(\\\"diskpart\\\")\";\nConsole.WriteLine(note);\n",
            ),
            ("vbs", "note = \"shell.Run diskpart\"\nWScript.Echo note\n"),
            (
                "bat",
                "echo subprocess.run('diskpart')\nset note=reg delete HKCU\\Demo\n",
            ),
        ] {
            assert_eq!(
                detect_script_forbidden_keyword(extension, content),
                None,
                "{extension}"
            );
        }
    }

    #[test]
    fn forbidden_script_scan_keeps_explicit_execution_strings_blocked() {
        for (extension, content, expected) in [
            (
                "py",
                "import subprocess\nsubprocess.run('diskpart')\n",
                "diskpart",
            ),
            (
                "js",
                "const { exec } = require('node:child_process');\nexec('reg delete HKCU\\\\Demo');\n",
                "reg delete",
            ),
            ("ps1", "Start-Process 'bcdedit'\n", "bcdedit"),
            ("cs", "Process.Start(\"diskpart\");\n", "diskpart"),
            ("vbs", "shell.Run \"diskpart\"\n", "diskpart"),
            ("bat", "diskpart\n", "diskpart"),
        ] {
            assert_eq!(
                detect_script_forbidden_keyword(extension, content),
                Some(expected),
                "{extension}"
            );
        }
    }

    #[test]
    fn forbidden_script_scan_tracks_literal_bindings_and_argv() {
        for (extension, content, expected) in [
            (
                "py",
                "cmd = 'diskpart'\nvalue = 4 // 2\nsubprocess.run(cmd)\n",
                "diskpart",
            ),
            (
                "py",
                "subprocess.run(['reg', 'delete', 'HKCU\\\\Demo'])\n",
                "reg delete",
            ),
            ("js", "const cmd = 'diskpart';\nexec(cmd);\n", "diskpart"),
            (
                "js",
                "spawn('reg', ['delete', 'HKCU\\\\Demo']);\n",
                "reg delete",
            ),
            ("ps1", "$cmd = 'diskpart'\niex $cmd\n", "diskpart"),
            (
                "ps1",
                "Start-Process reg -ArgumentList 'delete','HKCU\\Demo'\n",
                "reg delete",
            ),
            (
                "cs",
                "var cmd = \"diskpart\";\nProcess.Start(cmd);\n",
                "diskpart",
            ),
            (
                "cs",
                "Process.Start(\"reg\", \"delete HKCU\\\\Demo\");\n",
                "reg delete",
            ),
            ("vbs", "cmd = \"diskpart\"\nshell.Run cmd\n", "diskpart"),
            ("bat", "echo ready & diskpart\n", "diskpart"),
            ("bat", "set X=1 & reg delete HKCU\\Demo /f\n", "reg delete"),
        ] {
            assert_eq!(
                detect_script_forbidden_keyword(extension, content),
                Some(expected),
                "{extension}: {content}"
            );
        }
    }

    #[test]
    fn complete_delete_scan_ignores_comments_and_warning_strings() {
        for (script, content) in [
            ("safe.py", "# os.remove(x)\nprint(\"os.remove(x)\")\n"),
            (
                "safe.js",
                "// fs.rm(x)\nconsole.log(\"npx rimraf cache\");\n",
            ),
            (
                "safe.ps1",
                "# Remove-Item x\nWrite-Output 'Remove-Item x'\n",
            ),
            (
                "safe.cs",
                "// File.Delete(x)\nConsole.WriteLine(\"File.Delete(x)\");\n",
            ),
            (
                "safe.vbs",
                "' fso.DeleteFile x\nWScript.Echo \"fso.DeleteFile x\"\n",
            ),
            ("safe.cmd", "rem del x\necho npx rimraf cache\n"),
        ] {
            assert_eq!(
                detect_script_delete_intent(script, content),
                None,
                "{script}"
            );
        }
    }

    #[test]
    fn complete_delete_scan_keeps_explicit_command_sinks_blocked() {
        for (script, content) in [
            (
                "cleanup.py",
                "cmd = 'del /q important.txt'\nsubprocess.run(cmd)\n",
            ),
            (
                "cleanup.js",
                "spawn('cmd', ['/c', 'del', '/q', 'important.txt']);\n",
            ),
            (
                "cleanup.ps1",
                "$cmd = 'Remove-Item important.txt'\niex $cmd\n",
            ),
            (
                "cleanup.cs",
                "Process.Start(\"cmd\", \"/c del /q important.txt\");\n",
            ),
            (
                "cleanup.vbs",
                "cmd = \"cmd /c del /q important.txt\"\nshell.Run cmd\n",
            ),
        ] {
            assert!(
                detect_script_delete_intent(script, content).is_some(),
                "{script}"
            );
        }
    }

    #[test]
    fn normal_script_with_warning_text_passes_full_scan() {
        let dir = std::env::temp_dir().join("agentvis_inert_warning_script_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("safe.py"),
            concat!(
                "# format C: -EncodedCommand reg delete sc delete net user\n",
                "note = \"diskpart bcdedit reg add hklm session manager\\\\environment\"\n",
                "print(note)\n"
            ),
        )
        .unwrap();

        assert!(validate_script_content("python safe.py", Some(dir.to_str().unwrap())).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normal_source_assignments_are_not_parsed_as_nested_shell_commands() {
        let dir = std::env::temp_dir().join("agentvis_normal_source_assignment_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("safe.py"),
            "python = '3.12'\ndiskpartition = []\nprint(python, diskpartition)\n",
        )
        .unwrap();

        assert!(validate_script_content("python safe.py", Some(dir.to_str().unwrap())).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn aliased_execution_sinks_and_powershell_call_operator_detect_deletes() {
        for (script, content) in [
            (
                "cleanup.py",
                "from subprocess import run\nrun(['cmd', '/c', 'del /q important.txt'])\n",
            ),
            (
                "cleanup.py",
                "import subprocess as sp\nsp.run(['cmd', '/c', 'del /q important.txt'])\n",
            ),
            (
                "cleanup.ps1",
                "if ($true) { & 'cmd.exe' /c 'del /q important.txt' }\n",
            ),
            ("cleanup.vbs", "Execute \"cmd /c del /q important.txt\"\n"),
        ] {
            assert!(
                detect_script_delete_intent(script, content).is_some(),
                "{script}: {content}"
            );
        }
    }

    #[test]
    fn no_space_powershell_operators_and_start_process_aliases_are_scanned() {
        for source in [
            "&'cmd.exe' /c 'del /q important.txt'\n",
            "saps cmd.exe -ArgumentList '/d','/c','del /q important.txt' -Wait\n",
            "start cmd.exe -ArgumentList '/d','/c','del /q important.txt' -Wait\n",
            "$args = @('/d','/c','del /q important.txt')\nsaps cmd.exe -ArgumentList $args -Wait\n",
        ] {
            assert!(
                detect_script_delete_intent("cleanup.ps1", source).is_some(),
                "{source}"
            );
        }

        assert_eq!(
            detect_script_delete_intent(
                "safe.ps1",
                "$mask = 3 -band 1\n$note = \"&'cmd.exe' /c 'del /q important.txt'\"\nWrite-Output $note\n"
            ),
            None
        );
    }

    #[test]
    fn no_space_powershell_dot_operator_recursively_scans_local_script() {
        let dir = std::env::temp_dir().join("agentvis_no_space_dot_source_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("nested.ps1"), "Remove-Item important.txt\n").unwrap();
        std::fs::write(dir.join("wrapper.ps1"), ".'./nested.ps1'\n").unwrap();

        let error =
            validate_script_content("powershell -File wrapper.ps1", Some(dir.to_str().unwrap()))
                .expect_err("a no-space dot-sourced local script must be scanned");
        assert!(error.to_string().contains(RECOVERABLE_DELETE_BLOCK_PREFIX));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn python_execution_aliases_and_static_argv_bindings_are_scanned() {
        assert!(detect_script_delete_intent(
            "cleanup.py",
            "import subprocess\ncmd = ['cmd', '/c', 'del /q important.txt']\nsubprocess.run(cmd)\n"
        )
        .is_some());

        let dir = std::env::temp_dir().join("agentvis_python_execution_alias_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("wipe.py"),
            "import os\nos.unlink('important.txt')\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("wrapper.py"),
            "from subprocess import run as launch\nimport sys\nlaunch([sys.executable, 'wipe.py'])\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("dynamic.py"),
            "from subprocess import run as launch\nimport sys\nlaunch([sys.executable, target])\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("ordinary.py"),
            "import sys\ndef launch(args):\n    print(args)\nlaunch([sys.executable, 'wipe.py'])\n",
        )
        .unwrap();

        let error = validate_script_content("python wrapper.py", Some(dir.to_str().unwrap()))
            .expect_err("an imported subprocess alias must expose its literal nested script");
        assert!(error.to_string().contains(RECOVERABLE_DELETE_BLOCK_PREFIX));
        let error = validate_script_content("python dynamic.py", Some(dir.to_str().unwrap()))
            .expect_err("a dynamic entry through an imported subprocess alias must fail closed");
        assert!(error
            .to_string()
            .contains("[script_scan_ambiguous_launcher]"));
        assert!(
            validate_script_content("python ordinary.py", Some(dir.to_str().unwrap())).is_ok(),
            "an unrelated ordinary function must not become an execution sink"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn javascript_child_process_aliases_and_runtime_chdir_are_scanned() {
        let dir = std::env::temp_dir().join("agentvis_javascript_execution_alias_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("other")).unwrap();
        std::fs::write(
            dir.join("wipe.js"),
            "require('node:fs').unlinkSync('important.txt');\n",
        )
        .unwrap();
        std::fs::write(dir.join("safe.js"), "console.log('safe');\n").unwrap();
        std::fs::write(
            dir.join("wrapper.mjs"),
            "import { spawn as launch } from 'node:child_process';\nlaunch(process.execPath, ['wipe.js']);\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("dynamic.mjs"),
            "import { spawn as launch } from 'node:child_process';\nlaunch(process.execPath, target);\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("process-cwd.mjs"),
            "import { spawn } from 'node:child_process';\nprocess.chdir('other');\nspawn(process.execPath, ['safe.js']);\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("deno-cwd.ts"),
            "Deno.chdir('other');\nBun.spawn(['node', 'safe.js']);\n",
        )
        .unwrap();

        let error = validate_script_content("node wrapper.mjs", Some(dir.to_str().unwrap()))
            .expect_err("an ESM child_process alias must expose its literal nested script");
        assert!(error.to_string().contains(RECOVERABLE_DELETE_BLOCK_PREFIX));
        let error = validate_script_content("node dynamic.mjs", Some(dir.to_str().unwrap()))
            .expect_err("a dynamic entry through a child_process alias must fail closed");
        assert!(error
            .to_string()
            .contains("[script_scan_ambiguous_launcher]"));
        for command in ["node process-cwd.mjs", "deno run deno-cwd.ts"] {
            let error = validate_script_content(command, Some(dir.to_str().unwrap()))
                .expect_err("a runtime cwd change before a nested script must fail closed");
            assert!(
                error
                    .to_string()
                    .contains("[script_scan_ambiguous_launcher]"),
                "{command}: {error}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn additional_direct_delete_apis_are_detected() {
        assert_eq!(
            detect_script_delete_intent("cleanup.py", "import os\nos.removedirs(target)\n"),
            Some("os.removedirs")
        );
        assert_eq!(
            detect_script_delete_intent(
                "cleanup.js",
                "const { rmSync: wipe } = require('fs'); wipe(target);\n"
            ),
            Some("fs.rmSync")
        );
    }

    #[test]
    fn csharp_static_import_method_group_and_visual_basic_deletes_are_detected() {
        for source in [
            "using static System.IO.File;\nDelete(target);\n",
            "System.Action<string> wipe = System.IO.File.Delete;\nwipe(target);\n",
            "Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(target);\n",
            "Microsoft.VisualBasic.FileIO.FileSystem.DeleteDirectory(target);\n",
        ] {
            assert!(
                detect_script_delete_intent("cleanup.cs", source).is_some(),
                "{source}"
            );
        }

        assert_eq!(
            detect_script_delete_intent(
                "safe.cs",
                "// using static System.IO.File; Delete(target);\nvar note = \"System.IO.File.Delete; wipe(target); Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(target);\";\nConsole.WriteLine(note);\n"
            ),
            None
        );
    }

    #[test]
    fn test_batch_delete_commands_detected_outside_comments_and_echo() {
        for source in [
            "del /q target.txt",
            "del/f/q target.txt",
            "erase/f/q target.txt",
            "rd/s/q target",
            "rmdir/s/q target",
            "if exist target.txt erase target.txt",
            "echo preparing && rd /s /q target",
            "for %%F in (*) do del \"%%F\"",
            "cmd.exe /d /s /c \"del/f/q target.txt\"",
        ] {
            assert!(detect_batch_delete(source).is_some(), "{source}");
        }
        assert_eq!(detect_batch_delete("rem del target\necho del target"), None);
    }

    #[test]
    fn test_javascript_delete_apis_detected() {
        for (source, expected) in [
            ("fs.rm(target, callback)", "fs.rm"),
            ("fs.unlinkSync(target)", "fs.unlinkSync"),
            ("await fs.promises.rm(target)", "fs.promises.rm"),
            ("await fsp.unlink(target)", "fs.promises.unlink"),
            (
                "const { rm } = require('node:fs/promises'); await rm(target)",
                "fs.rm",
            ),
            (
                "import { rmSync } from 'fs'; rmSync(target, { recursive: true })",
                "fs.rmSync",
            ),
            (
                "import { unlinkSync } from \"fs\"; unlinkSync(target)",
                "fs.unlinkSync",
            ),
        ] {
            assert_eq!(detect_javascript_delete(source), Some(expected));
        }
        assert_eq!(
            detect_javascript_delete("// fs.rm(target)\nconsole.log('safe')"),
            None
        );
        for source in [
            "// require('fs')\nfunction rm() { console.log('safe'); }\nrm();\n",
            "const note = \"require('fs')\";\nfunction unlink() { return true; }\nunlink();\n",
            "/* import { rmdir } from 'node:fs' */\nfunction rmdir() {}\nrmdir();\n",
        ] {
            assert_eq!(
                detect_javascript_delete(source),
                None,
                "inert fs-import text must not turn an ordinary call into a delete: {source}"
            );
        }
    }

    #[test]
    fn test_script_delete_is_blocked_with_recoverable_reason() {
        let dir = std::env::temp_dir().join("agentvis_script_delete_guard_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("cleanup.py");
        std::fs::write(&script, "import os\nos.remove('important.txt')\n").unwrap();

        let error = validate_script_content("python cleanup.py", Some(dir.to_str().unwrap()))
            .expect_err("script deletion must be blocked");
        assert!(error.to_string().contains(RECOVERABLE_DELETE_BLOCK_PREFIX));
        assert!(error
            .to_string()
            .contains("direct supported delete command"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_literal_and_wrapped_script_delete_regressions_are_blocked() {
        let dir = std::env::temp_dir().join("agentvis_script_delete_wrapper_regression_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("cleanup.ps1"), "erase important.txt\n").unwrap();
        std::fs::write(
            dir.join("cleanup.cmd"),
            "cmd.exe /d /s /c \"del/f/q important.txt\"\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("cleanup.mjs"),
            "import { rmSync } from 'fs';\nrmSync('important', { recursive: true, force: true });\n",
        )
        .unwrap();

        for command in [
            r"powershell.exe -NoProfile .\cleanup.ps1",
            r#"powershell -NoProfile -Command ".\cleanup.ps1""#,
            "cmd.exe /q/d/c cleanup.cmd",
            "%ComSpec% /d /s /c cleanup.cmd",
            "node cleanup.mjs",
        ] {
            let error = validate_script_content(command, Some(dir.to_str().unwrap()))
                .expect_err("literal or wrapped script deletion must be blocked");
            assert!(
                error.to_string().contains(RECOVERABLE_DELETE_BLOCK_PREFIX),
                "expected recoverable delete block for {command}: {error}"
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_typescript_delete_is_scanned_for_javascript_runtimes() {
        let dir = std::env::temp_dir().join("agentvis_typescript_delete_guard_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("cleanup.ts");
        std::fs::write(
            &script,
            "import { rm } from 'node:fs/promises';\nawait rm('important', { recursive: true });\n",
        )
        .unwrap();

        let error = validate_script_content(
            "deno run --allow-write cleanup.ts",
            Some(dir.to_str().unwrap()),
        )
        .expect_err("TypeScript deletion must be blocked");
        assert!(error.to_string().contains(RECOVERABLE_DELETE_BLOCK_PREFIX));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_interpolated_and_additional_language_deletes_are_detected() {
        assert_eq!(
            detect_script_delete_intent(
                "cleanup.ps1",
                r#"Write-Output "$(Remove-Item -LiteralPath $target)""#
            ),
            Some("indirect PowerShell delete")
        );
        assert_eq!(
            detect_script_delete_intent("cleanup.js", "const result = `${fs.rmSync(target)}`;"),
            Some("indirect JavaScript delete")
        );
        assert_eq!(
            detect_script_delete_intent("cleanup.ts", "await fs.promises.rm(target);"),
            Some("fs.promises.rm")
        );
        assert_eq!(
            detect_script_delete_intent("cleanup.cs", "System.IO.File.Delete(target);"),
            Some("C# filesystem delete")
        );
        assert_eq!(
            detect_script_delete_intent("cleanup.vbs", "fso.DeleteFolder target"),
            Some("VBScript filesystem delete")
        );
    }

    #[test]
    fn javascript_regex_literals_do_not_hide_following_delete_calls() {
        for script in ["cleanup.js", "cleanup.ts"] {
            assert!(
                detect_script_delete_intent(
                    script,
                    "const token = /[/*]/;\nrequire('fs').rmSync(target);\n"
                )
                .is_some(),
                "{script}"
            );
        }
        assert_eq!(
            detect_script_forbidden_keyword(
                "js",
                "const warningPattern = /[/*]diskpart/;\nconsole.log('safe');\n"
            ),
            None
        );
    }

    #[test]
    fn powershell_here_strings_preserve_inert_text_and_scan_double_quoted_interpolation() {
        assert_eq!(
            detect_script_delete_intent(
                "safe.ps1",
                r#"$note = @'
it's documentation about Remove-Item important.txt
'@
Write-Output 'safe'
"#
            ),
            None
        );
        assert_eq!(
            detect_script_delete_intent(
                "safe.ps1",
                r#"$note = @"
quoted "Remove-Item important.txt" documentation
"@
Write-Output 'safe'
"#
            ),
            None
        );
        assert_eq!(
            detect_script_delete_intent(
                "cleanup.ps1",
                r#"$note = @"
$(Remove-Item important.txt)
"@
"#
            ),
            Some("indirect PowerShell delete")
        );
    }

    #[test]
    fn executable_interpolation_recurses_and_supports_python_triple_f_strings() {
        assert_eq!(
            detect_script_delete_intent(
                "cleanup.py",
                "result = f\"\"\"status: {os.remove(target)}\"\"\"\n"
            ),
            Some("indirect Python delete")
        );
        assert_eq!(
            detect_script_delete_intent(
                "cleanup.js",
                r#"const result = `${`value ${fs.rmSync(target)}`}`;"#
            ),
            Some("fs.rmSync")
        );
    }

    #[test]
    fn executable_interpolation_limits_fail_closed() {
        let mut expression = "fs.rmSync(target)".to_string();
        for depth in 0..=(MAX_EXECUTABLE_INTERPOLATION_DEPTH * 4) {
            expression = format!("`level{depth} ${{{expression}}}`");
        }
        let source = format!("const result = {expression};\n");
        let error = validate_script_source(
            "<deep inline source>",
            "js",
            &source,
            None,
            0,
            &mut ScriptScanState::default(),
        )
        .expect_err("unresolved interpolation beyond the depth budget must fail closed");
        assert!(
            error.to_string().contains("[script_scan_depth_exceeded]"),
            "deep interpolation must hit the bounded-depth reason before execution: {error}"
        );

        let oversized = "x".repeat(MAX_EXECUTABLE_INTERPOLATION_ANALYSIS_BYTES + 1);
        assert_eq!(
            content_with_executable_interpolations_checked("js", &oversized),
            Err(ExecutableInterpolationLimit::TooLarge)
        );
    }

    #[test]
    fn call_token_boundaries_respect_unicode_identifiers() {
        assert!(!has_call_token("πrm(target)", "rm"));
        assert!(has_call_token("π; rm(target)", "rm"));
    }

    #[test]
    fn test_chained_and_nested_destructive_scripts_are_scanned() {
        let dir = std::env::temp_dir().join("agentvis_chained_script_delete_guard_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("safe.py"), "print('safe')\n").unwrap();
        std::fs::write(dir.join("destructive.py"), "import os\nos.unlink('data')\n").unwrap();
        std::fs::write(dir.join("wrapper.cmd"), "call destructive.cmd\n").unwrap();
        std::fs::write(dir.join("destructive.cmd"), "del /q data.txt\n").unwrap();

        let chained = validate_script_content(
            "python safe.py && python destructive.py",
            Some(dir.to_str().unwrap()),
        );
        assert!(chained
            .expect_err("second script in a chain must be scanned")
            .to_string()
            .contains(RECOVERABLE_DELETE_BLOCK_PREFIX));

        let cmd_single_quote_chain = validate_script_content(
            "python safe.py ' && python destructive.py --arg",
            Some(dir.to_str().unwrap()),
        );
        assert!(cmd_single_quote_chain
            .expect_err("CMD single quote must not hide a chained script")
            .to_string()
            .contains(RECOVERABLE_DELETE_BLOCK_PREFIX));

        let nested = validate_script_content("wrapper.cmd", Some(dir.to_str().unwrap()));
        assert!(nested
            .expect_err("literal nested script must be scanned")
            .to_string()
            .contains(RECOVERABLE_DELETE_BLOCK_PREFIX));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_nested_scripts_resolve_from_process_workdir() {
        let dir = std::env::temp_dir().join("agentvis_nested_script_workdir_test");
        let wrappers = dir.join("wrappers");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&wrappers).unwrap();

        std::fs::write(
            dir.join("nested.py"),
            "import os\nos.remove('important.txt')\n",
        )
        .unwrap();
        std::fs::write(wrappers.join("nested.py"), "print('safe decoy')\n").unwrap();
        std::fs::write(
            wrappers.join("wrapper.py"),
            "import subprocess\nsubprocess.run(['python', 'nested.py'])\n",
        )
        .unwrap();

        std::fs::write(dir.join("nested.ps1"), "Remove-Item important.txt\n").unwrap();
        std::fs::write(wrappers.join("nested.ps1"), "Write-Output 'safe decoy'\n").unwrap();
        std::fs::write(wrappers.join("wrapper.ps1"), ". .\\nested.ps1\n").unwrap();

        for command in [
            "python wrappers/wrapper.py",
            "powershell -File wrappers/wrapper.ps1",
        ] {
            let error = validate_script_content(command, Some(dir.to_str().unwrap()))
                .expect_err("nested script must resolve from the process workdir");
            assert!(
                error.to_string().contains(RECOVERABLE_DELETE_BLOCK_PREFIX),
                "expected the destructive workdir script to be scanned for {command}: {error}"
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_nested_sys_executable_preserves_python_language_hint() {
        let dir = std::env::temp_dir().join("agentvis_nested_python_hint_test");
        let wrappers = dir.join("wrappers");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&wrappers).unwrap();
        std::fs::write(
            dir.join("destructive.txt"),
            "import os as io\nio.unlink('important.txt')\n",
        )
        .unwrap();
        std::fs::write(wrappers.join("destructive.txt"), "print('safe decoy')\n").unwrap();
        std::fs::write(
            wrappers.join("wrapper.py"),
            concat!(
                "import subprocess, sys\n",
                "subprocess.run([sys.executable, 'destructive.txt'])\n"
            ),
        )
        .unwrap();
        std::fs::write(
            wrappers.join("safe_wrapper.py"),
            concat!(
                "import subprocess, sys\n",
                "subprocess.run([sys.executable, '-c', \"print('safe')\", 'payload.txt'])\n"
            ),
        )
        .unwrap();

        let error =
            validate_script_content("python wrappers/wrapper.py", Some(dir.to_str().unwrap()))
                .expect_err("sys.executable nested Python file must retain its language hint");
        assert!(error.to_string().contains(RECOVERABLE_DELETE_BLOCK_PREFIX));
        assert!(
            validate_script_content(
                "python wrappers/safe_wrapper.py",
                Some(dir.to_str().unwrap()),
            )
            .is_ok(),
            "ordinary data arguments after Python -c must not be treated as scripts"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nested_literal_paths_preserve_spaces_and_case_and_dynamic_entry_fails_closed() {
        let dir = std::env::temp_dir().join("agentvis_nested_literal_argv_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("Danger Script.py"),
            "import os\nos.unlink('important.txt')\n",
        )
        .unwrap();
        std::fs::write(dir.join("script.py"), "print('safe decoy')\n").unwrap();
        std::fs::write(
            dir.join("wrapper.py"),
            concat!(
                "import subprocess, sys\n",
                "subprocess.run([sys.executable, 'Danger Script.py'])\n"
            ),
        )
        .unwrap();
        std::fs::write(dir.join("safe.py"), "print('ordinary argv')\n").unwrap();
        std::fs::write(
            dir.join("dynamic.py"),
            concat!(
                "import subprocess, sys\n",
                "subprocess.run([sys.executable, script_var, 'safe.py'])\n"
            ),
        )
        .unwrap();

        let error = validate_script_content("python wrapper.py", Some(dir.to_str().unwrap()))
            .expect_err("the exact mixed-case path containing spaces must be scanned");
        assert!(error.to_string().contains(RECOVERABLE_DELETE_BLOCK_PREFIX));

        let error = validate_script_content("python dynamic.py", Some(dir.to_str().unwrap()))
            .expect_err("a later literal argv must not disguise a dynamic entrypoint");
        assert!(error
            .to_string()
            .contains("[script_scan_ambiguous_launcher]"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nested_script_depth_uses_specific_recovery_reason() {
        let dir = std::env::temp_dir().join("agentvis_nested_script_depth_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for index in 0..10 {
            let content = if index == 9 {
                "print('leaf')\n".to_string()
            } else {
                format!(
                    "import subprocess, sys\nsubprocess.run([sys.executable, 'script{}.py'])\n",
                    index + 1
                )
            };
            std::fs::write(dir.join(format!("script{index}.py")), content).unwrap();
        }

        let error = validate_script_content("python script0.py", Some(dir.to_str().unwrap()))
            .expect_err("nested script depth limit must fail closed");
        assert!(error.to_string().contains("[script_scan_depth_exceeded]"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cyclic_literal_script_dependencies_are_scanned_once() {
        let dir = std::env::temp_dir().join("agentvis_cyclic_script_scan_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.js"), "require('./b.js');\nconsole.log('a');\n").unwrap();
        std::fs::write(dir.join("b.js"), "require('./a.js');\nconsole.log('b');\n").unwrap();

        assert!(validate_script_content("node a.js", Some(dir.to_str().unwrap())).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_oversized_script_fails_closed() {
        let dir = std::env::temp_dir().join("agentvis_oversized_script_scan_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = std::fs::File::create(dir.join("oversized.py")).unwrap();
        script.set_len(8 * 1024 * 1024 + 1).unwrap();

        let error = validate_script_content("python oversized.py", Some(dir.to_str().unwrap()))
            .expect_err("script larger than the scan budget must fail closed");
        assert!(error.to_string().contains("[script_scan_too_large]"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn utf32_scripts_are_decoded_before_scanning() {
        let dir = std::env::temp_dir().join("agentvis_utf32_script_scan_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut encoded = vec![0xff, 0xfe, 0x00, 0x00];
        for character in "Remove-Item important.txt\n".chars() {
            encoded.extend_from_slice(&(character as u32).to_le_bytes());
        }
        std::fs::write(dir.join("cleanup.ps1"), encoded).unwrap();

        let error =
            validate_script_content("powershell -File cleanup.ps1", Some(dir.to_str().unwrap()))
                .expect_err("UTF-32LE deletion must not bypass scanning");
        assert!(error.to_string().contains(RECOVERABLE_DELETE_BLOCK_PREFIX));
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
    fn test_script_content_nonexistent_file_is_fail_closed() {
        let result = validate_script_content("powershell -File nonexistent_script.ps1", None);
        let error = result.expect_err("unreadable script must not bypass delete scanning");
        assert!(error.to_string().contains("[script_scan_unreadable]"));
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
        reload_custom_protected_paths(&dir).unwrap();

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
        guard.clear();
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
        reload_custom_protected_paths(&dir).unwrap();

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
        guard.clear();
    }

    #[test]
    fn test_path_write_safety_boundary_check() {
        let _guard = lock_custom_protected_paths();
        // 路径前缀边界检查：D:\important_backup 不应误匹配 D:\important_backup_other
        let dir = std::env::temp_dir().join("agentvis_write_boundary_test");
        let _ = std::fs::create_dir_all(&dir);
        let config = dir.join("protected_paths.json");
        std::fs::write(&config, r#"["D:\\important_backup"]"#).unwrap();
        reload_custom_protected_paths(&dir).unwrap();

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
        guard.clear();
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
            guard.clear();
        }

        let path = std::path::Path::new("D:\\any\\path\\file.txt");
        assert!(validate_path_write_safety(path, &dir).is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
