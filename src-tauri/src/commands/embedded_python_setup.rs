//! 内嵌 Python 环境准备命令
//!
//! 职责：
//! - 将安装包内的 Python 3.13.14 embeddable zip 解压到 AppData/runtime/python-embed-3.13/
//! - 修复 python313._pth 文件（取消注释 import site，使 venv 模块可用）
//! - 将 get-pip.py 复制到 AppData/runtime/get-pip.py
//! - 返回 python.exe 和 get-pip.py 的绝对路径
//!
//! 幂等：若解压目录已存在且 python.exe 可访问，跳过解压直接返回路径。

use crate::error::AppError;
use fs2::FileExt;
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tokio::sync::Mutex as AsyncMutex;

const EMBEDDED_PYTHON_VERSION: &str = "3.13.14";
const EMBEDDED_PYTHON_ABI_TAG: &str = "313";
const EMBEDDED_PYTHON_CACHE_DIR: &str = "python-embed-3.13";
const RUNTIME_IN_USE_ERROR_CODE: &str = "[PYTHON_RUNTIME_IN_USE]";
const RUNTIME_PREPARE_LOCK_ATTEMPTS: usize = 1_200;
const RUNTIME_PREPARE_LOCK_RETRY_MS: u64 = 100;
const RUNTIME_REMOVE_RETRY_DELAYS_MS: &[u64] = &[0, 100, 250, 500, 1_000, 2_000];

static PREBUILT_RUNTIME_PREPARE_LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();

type CommandResult<T> = Result<T, AppError>;

/// 内嵌 Python 环境信息
#[derive(Debug, serde::Serialize)]
pub struct EmbeddedRuntimeInfo {
    /// 内嵌 Python 可执行文件路径
    pub python_exe: String,
    /// get-pip.py 路径（用于引导 pip）
    pub get_pip_path: String,
    /// true 表示本次执行了解压；false 表示已存在，跳过
    pub just_extracted: bool,
}

/// 预置 Python v1 环境信息
#[derive(Debug, serde::Serialize)]
pub struct PrebuiltPythonRuntimeInfo {
    /// runtime 根目录：{AppDataDir}/runtime/python-v1
    pub runtime_dir: String,
    /// venv 目录：{AppDataDir}/runtime/python-v1/.venv
    pub venv_path: String,
    /// 预置 runtime 内的 Python 可执行文件路径
    pub python_exe: String,
    /// true 表示本次执行了解压；false 表示已存在，跳过
    pub just_extracted: bool,
}

/// 准备预置 Python v1 运行时（幂等）
///
/// 正式安装包应携带 resource_dir/python-runtime/python-runtime-v1.zip。
/// 该 zip 已包含 .venv 以及 runtime-requirements-v1.txt 中的基础依赖。
#[tauri::command]
pub async fn prepare_prebuilt_python_runtime(
    app: tauri::AppHandle,
) -> CommandResult<PrebuiltPythonRuntimeInfo> {
    let prepare_lock = PREBUILT_RUNTIME_PREPARE_LOCK.get_or_init(|| AsyncMutex::new(()));
    let _prepare_guard = prepare_lock.lock().await;

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::FileSystem(format!("Failed to get AppDataDir: {}", e)))?;

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| AppError::FileSystem(format!("Failed to get resource_dir: {}", e)))?;

    let runtime_parent = app_data_dir.join("runtime");
    std::fs::create_dir_all(&runtime_parent).map_err(|e| {
        AppError::FileSystem(format!("Failed to create runtime parent directory: {}", e))
    })?;
    let runtime_lock_path = runtime_parent.join("python-v1.prepare.lock");
    let _runtime_file_lock = acquire_runtime_prepare_file_lock(&runtime_lock_path).await?;

    let runtime_dir = runtime_parent.join("python-v1");
    let venv_path = runtime_dir.join(".venv");
    let python_exe = get_prebuilt_venv_python_exe(&venv_path);
    let signature_src = resource_dir
        .join("python-runtime")
        .join("python-runtime-v1.signature");
    let bundled_signature = read_optional_signature(&signature_src)?;
    let signature_dest = runtime_dir.join(".agentvis-runtime-signature");

    let needs_refresh = if python_exe.exists() {
        let signature_matches = bundled_signature
            .as_deref()
            .map(|signature| runtime_signature_matches(&signature_dest, signature))
            .unwrap_or(true);

        if !signature_matches {
            log::warn!(
                "[EmbeddedPython] 预置 Python runtime 签名已变化，将重新解压: {}",
                runtime_dir.display()
            );
            true
        } else if !prebuilt_runtime_healthy(&runtime_dir, &python_exe) {
            log::warn!(
                "[EmbeddedPython] 已存在的预置 Python runtime 不健康，将重新解压: {}",
                runtime_dir.display()
            );
            true
        } else {
            false
        }
    } else {
        true
    };

    let just_extracted = if needs_refresh {
        let zip_src = resource_dir
            .join("python-runtime")
            .join("python-runtime-v1.zip");

        if !zip_src.exists() {
            return Err(AppError::FileSystem(format!(
                "Prebuilt Python runtime resource does not exist: {}",
                zip_src.display()
            )));
        }

        replace_prebuilt_runtime_from_archive(&runtime_dir, &zip_src, bundled_signature.as_deref())
            .await?;
        log::info!(
            "[EmbeddedPython] 已解压预置 Python runtime 到 {}",
            runtime_dir.display()
        );
        true
    } else {
        log::debug!("[EmbeddedPython] 预置 Python runtime 已存在，跳过解压");
        false
    };

    if !prebuilt_runtime_healthy(&runtime_dir, &python_exe) {
        return Err(AppError::FileSystem(format!(
            "Prebuilt Python runtime health check failed: {}",
            python_exe.display()
        )));
    }

    if let Some(signature) = bundled_signature {
        std::fs::write(&signature_dest, signature).map_err(|e| {
            AppError::FileSystem(format!("Failed to write python runtime signature: {}", e))
        })?;
    }

    Ok(PrebuiltPythonRuntimeInfo {
        runtime_dir: runtime_dir.to_string_lossy().to_string(),
        venv_path: venv_path.to_string_lossy().to_string(),
        python_exe: python_exe.to_string_lossy().to_string(),
        just_extracted,
    })
}

async fn acquire_runtime_prepare_file_lock(lock_path: &Path) -> Result<File, AppError> {
    let lock_file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(|error| {
            AppError::FileSystem(format!(
                "Failed to open Python runtime prepare lock {}: {}",
                lock_path.display(),
                error
            ))
        })?;

    for attempt in 0..RUNTIME_PREPARE_LOCK_ATTEMPTS {
        match FileExt::try_lock_exclusive(&lock_file) {
            Ok(()) => return Ok(lock_file),
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                if attempt + 1 < RUNTIME_PREPARE_LOCK_ATTEMPTS {
                    tokio::time::sleep(std::time::Duration::from_millis(
                        RUNTIME_PREPARE_LOCK_RETRY_MS,
                    ))
                    .await;
                }
            }
            Err(error) => {
                return Err(AppError::FileSystem(format!(
                    "Failed to lock Python runtime preparation: {}",
                    error
                )))
            }
        }
    }

    Err(AppError::FileSystem(format!(
        "{} Another AgentVis instance is preparing the Python runtime. Close the other instance or wait for it to finish.",
        RUNTIME_IN_USE_ERROR_CODE
    )))
}

async fn replace_prebuilt_runtime_from_archive(
    runtime_dir: &Path,
    zip_src: &Path,
    bundled_signature: Option<&str>,
) -> Result<(), AppError> {
    let runtime_parent = runtime_dir.parent().ok_or_else(|| {
        AppError::FileSystem(format!(
            "Python runtime directory has no parent: {}",
            runtime_dir.display()
        ))
    })?;
    let unique_suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let staging_dir = runtime_parent.join(format!(
        "python-v1.staging-{}-{}",
        std::process::id(),
        unique_suffix
    ));

    cleanup_stale_runtime_staging_dirs(runtime_parent, &staging_dir);
    if staging_dir.exists() {
        std::fs::remove_dir_all(&staging_dir).map_err(|error| {
            AppError::FileSystem(format!(
                "Failed to reset Python runtime staging directory {}: {}",
                staging_dir.display(),
                error
            ))
        })?;
    }
    std::fs::create_dir_all(&staging_dir).map_err(|error| {
        AppError::FileSystem(format!(
            "Failed to create Python runtime staging directory {}: {}",
            staging_dir.display(),
            error
        ))
    })?;

    let stage_result = (|| -> Result<(), AppError> {
        extract_zip_stripping_optional_root(zip_src, &staging_dir, "python-v1")?;
        let staged_venv = staging_dir.join(".venv");
        let staged_python = get_prebuilt_venv_python_exe(&staged_venv);
        if !prebuilt_runtime_healthy(&staging_dir.to_path_buf(), &staged_python) {
            return Err(AppError::FileSystem(format!(
                "Staged prebuilt Python runtime health check failed: {}",
                staged_python.display()
            )));
        }
        if let Some(signature) = bundled_signature {
            std::fs::write(staging_dir.join(".agentvis-runtime-signature"), signature).map_err(
                |error| {
                    AppError::FileSystem(format!(
                        "Failed to write staged Python runtime signature: {}",
                        error
                    ))
                },
            )?;
        }
        Ok(())
    })();

    if let Err(error) = stage_result {
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err(error);
    }

    if runtime_dir.exists() {
        if let Err(error) = remove_runtime_dir_with_retries(runtime_dir).await {
            let _ = std::fs::remove_dir_all(&staging_dir);
            return Err(error);
        }
    }

    if let Err(error) = std::fs::rename(&staging_dir, runtime_dir) {
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err(AppError::FileSystem(format!(
            "Failed to publish staged Python runtime to {}: {}",
            runtime_dir.display(),
            error
        )));
    }

    Ok(())
}

fn cleanup_stale_runtime_staging_dirs(runtime_parent: &Path, current_staging_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(runtime_parent) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let is_stale_staging = path != current_staging_dir
            && entry
                .file_name()
                .to_string_lossy()
                .starts_with("python-v1.staging-");
        if is_stale_staging {
            if let Err(error) = std::fs::remove_dir_all(&path) {
                log::debug!(
                    "[EmbeddedPython] 清理旧 runtime staging 目录失败（忽略）: {} - {}",
                    path.display(),
                    error
                );
            }
        }
    }
}

async fn remove_runtime_dir_with_retries(runtime_dir: &Path) -> Result<(), AppError> {
    let mut last_error = None;

    for delay_ms in RUNTIME_REMOVE_RETRY_DELAYS_MS {
        if *delay_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(*delay_ms)).await;
        }

        match terminate_processes_from_runtime(runtime_dir) {
            Ok(terminated) if !terminated.is_empty() => {
                log::warn!(
                    "[EmbeddedPython] 已终止占用旧 runtime 的 AgentVis Python 进程: {:?}",
                    terminated
                );
            }
            Ok(_) => {}
            Err(error) => {
                log::warn!(
                    "[EmbeddedPython] 无法枚举占用 Python runtime 的进程，将继续尝试删除: {}",
                    error
                );
            }
        }

        match std::fs::remove_dir_all(runtime_dir) {
            Ok(()) => return Ok(()),
            Err(error) if is_retryable_runtime_remove_error(&error) => {
                last_error = Some(error);
            }
            Err(error) => {
                return Err(AppError::FileSystem(format!(
                    "Failed to replace Python runtime directory {}: {}",
                    runtime_dir.display(),
                    error
                )))
            }
        }
    }

    let error = last_error
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unknown file lock".to_string());
    Err(AppError::FileSystem(format!(
        "{} The AgentVis Python runtime is still in use and could not be replaced. Close running AgentVis tasks and retry. Runtime: {}. Raw error: {}",
        RUNTIME_IN_USE_ERROR_CODE,
        runtime_dir.display(),
        error
    )))
}

fn is_retryable_runtime_remove_error(error: &std::io::Error) -> bool {
    error.kind() == ErrorKind::PermissionDenied
        || matches!(error.raw_os_error(), Some(5 | 32 | 145))
}

#[cfg(windows)]
fn terminate_processes_from_runtime(runtime_dir: &Path) -> std::io::Result<Vec<u32>> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }

    let mut entry = PROCESSENTRY32W::default();
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut terminated = Vec::new();
    let mut has_entry = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;

    while has_entry {
        let pid = entry.th32ProcessID;
        if pid != 0 && pid != std::process::id() {
            let query_handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            if !query_handle.is_null() {
                let mut path_buffer = vec![0_u16; 32_768];
                let mut path_len = path_buffer.len() as u32;
                let query_succeeded = unsafe {
                    QueryFullProcessImageNameW(
                        query_handle,
                        0,
                        path_buffer.as_mut_ptr(),
                        &mut path_len,
                    )
                } != 0;
                unsafe {
                    CloseHandle(query_handle);
                }

                if query_succeeded {
                    let image_path = PathBuf::from(std::ffi::OsString::from_wide(
                        &path_buffer[..path_len as usize],
                    ));
                    if windows_path_is_within_runtime(&image_path, runtime_dir) {
                        let terminate_handle =
                            unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid) };
                        if !terminate_handle.is_null() {
                            let terminate_succeeded =
                                unsafe { TerminateProcess(terminate_handle, 1) } != 0;
                            if terminate_succeeded {
                                unsafe {
                                    WaitForSingleObject(terminate_handle, 5_000);
                                }
                                terminated.push(pid);
                            } else {
                                log::warn!(
                                    "[EmbeddedPython] 无法终止占用 runtime 的进程 PID={}: {}",
                                    pid,
                                    std::io::Error::last_os_error()
                                );
                            }
                            unsafe {
                                CloseHandle(terminate_handle);
                            }
                        } else {
                            log::warn!(
                                "[EmbeddedPython] 无法打开占用 runtime 的进程 PID={} 以终止: {}",
                                pid,
                                std::io::Error::last_os_error()
                            );
                        }
                    }
                }
            }
        }

        has_entry = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }

    unsafe {
        CloseHandle(snapshot);
    }
    Ok(terminated)
}

#[cfg(not(windows))]
fn terminate_processes_from_runtime(_runtime_dir: &Path) -> std::io::Result<Vec<u32>> {
    Ok(Vec::new())
}

fn windows_path_is_within_runtime(image_path: &Path, runtime_dir: &Path) -> bool {
    let normalize = |path: &Path| {
        path.to_string_lossy()
            .replace('/', "\\")
            .trim_start_matches("\\\\?\\")
            .trim_end_matches('\\')
            .to_lowercase()
    };
    let image = normalize(image_path);
    let runtime = normalize(runtime_dir);
    image == runtime || image.starts_with(&format!("{}\\", runtime))
}

/// 准备内嵌 Python 运行时（幂等）
///
/// 调用时机：系统未检测到合适 Python（3.11+）时作为回退。
/// 流程：
/// 1. 检查 {AppDataDir}/runtime/python-embed-3.13/python.exe 是否已存在
/// 2. 若不存在：从 resource_dir/python-embed/ 解压 zip 到目标目录
/// 3. 修复 python313._pth（取消注释 import site）
/// 4. 若 get-pip.py 不存在：从 resource_dir 复制到 AppData/runtime/
/// 5. 返回路径信息
#[tauri::command]
pub async fn prepare_embedded_runtime(app: tauri::AppHandle) -> CommandResult<EmbeddedRuntimeInfo> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::FileSystem(format!("Failed to get AppDataDir: {}", e)))?;

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| AppError::FileSystem(format!("Failed to get resource_dir: {}", e)))?;

    // 目标路径
    let embed_dir = app_data_dir.join("runtime").join(EMBEDDED_PYTHON_CACHE_DIR);
    let python_exe = embed_dir.join("python.exe");
    let get_pip_dest = app_data_dir.join("runtime").join("get-pip.py");

    let mut just_extracted = false;

    // 幂等检查：python.exe 已存在且 SSL 可用才跳过解压。
    // 只检查 python.exe 会误复用不完整解压目录，导致 _ssl.pyd 找不到 OpenSSL DLL。
    if python_exe.exists() && !embedded_runtime_healthy(&embed_dir, &python_exe) {
        log::warn!(
            "[EmbeddedPython] 已存在的 Python runtime 不完整或 SSL 不可用，将重新解压: {}",
            embed_dir.display()
        );
        std::fs::remove_dir_all(&embed_dir).map_err(|e| {
            AppError::FileSystem(format!(
                "Failed to remove unhealthy python-embed directory: {}",
                e
            ))
        })?;
    }

    if !python_exe.exists() {
        let zip_src = resource_dir.join("python-embed").join(format!(
            "python-{}-embed-amd64.zip",
            EMBEDDED_PYTHON_VERSION
        ));

        if !zip_src.exists() {
            return Err(AppError::FileSystem(format!(
                "Embedded Python resource file does not exist (only included in release builds): {}",
                zip_src.display()
            )));
        }

        // 创建目标目录
        std::fs::create_dir_all(&embed_dir).map_err(|e| {
            AppError::FileSystem(format!("Failed to create python-embed directory: {}", e))
        })?;

        // 解压 zip
        extract_zip(&zip_src, &embed_dir)?;
        just_extracted = true;
        log::info!(
            "[EmbeddedPython] 已解压 Python {} 到 {}",
            EMBEDDED_PYTHON_VERSION,
            embed_dir.display()
        );
    } else {
        log::debug!("[EmbeddedPython] python.exe 已存在，跳过解压");
    }

    // 修复 _pth 文件（取消注释 import site）。即使复用已存在目录也执行，兼容旧版本缓存。
    let pth_file = embed_dir.join(format!("python{}._pth", EMBEDDED_PYTHON_ABI_TAG));
    if pth_file.exists() {
        fix_pth_file(&pth_file)?;
        log::debug!(
            "[EmbeddedPython] 已修复 python{}._pth",
            EMBEDDED_PYTHON_ABI_TAG
        );
    }

    // 复制 get-pip.py（若不存在）
    if !get_pip_dest.exists() {
        let get_pip_src = resource_dir.join("python-embed").join("get-pip.py");

        if get_pip_src.exists() {
            if let Some(parent) = get_pip_dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    AppError::FileSystem(format!("Failed to create runtime directory: {}", e))
                })?;
            }
            std::fs::copy(&get_pip_src, &get_pip_dest)
                .map_err(|e| AppError::FileSystem(format!("Failed to copy get-pip.py: {}", e)))?;
            log::debug!(
                "[EmbeddedPython] 已复制 get-pip.py 到 {}",
                get_pip_dest.display()
            );
        } else {
            log::warn!(
                "[EmbeddedPython] get-pip.py 资源文件不存在: {}",
                get_pip_src.display()
            );
        }
    }

    Ok(EmbeddedRuntimeInfo {
        python_exe: python_exe.to_string_lossy().to_string(),
        get_pip_path: get_pip_dest.to_string_lossy().to_string(),
        just_extracted,
    })
}

fn embedded_runtime_healthy(embed_dir: &PathBuf, python_exe: &PathBuf) -> bool {
    for filename in ["_ssl.pyd", "libssl-3.dll", "libcrypto-3.dll"] {
        if !embed_dir.join(filename).exists() {
            log::warn!("[EmbeddedPython] 缺少 SSL 运行时文件: {}", filename);
            return false;
        }
    }

    match run_hidden_python_check(
        python_exe,
        embed_dir,
        "import ssl; print(ssl.OPENSSL_VERSION)",
    ) {
        Ok(output) if output.status.success() => true,
        Ok(output) => {
            log::warn!(
                "[EmbeddedPython] SSL 健康检查失败: stdout={}, stderr={}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            false
        }
        Err(error) => {
            log::warn!("[EmbeddedPython] SSL 健康检查无法执行: {}", error);
            false
        }
    }
}

fn get_prebuilt_venv_python_exe(venv_path: &PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        venv_path.join("Scripts").join("python.exe")
    }
    #[cfg(not(windows))]
    {
        venv_path.join("bin").join("python")
    }
}

fn read_optional_signature(path: &PathBuf) -> Result<Option<String>, AppError> {
    if !path.exists() {
        return Ok(None);
    }

    let signature = std::fs::read_to_string(path)
        .map_err(|e| {
            AppError::FileSystem(format!("Failed to read python runtime signature: {}", e))
        })?
        .trim()
        .to_string();

    Ok((!signature.is_empty()).then_some(signature))
}

fn runtime_signature_matches(path: &PathBuf, expected: &str) -> bool {
    std::fs::read_to_string(path)
        .map(|value| value.trim() == expected)
        .unwrap_or(false)
}

const PREBUILT_RUNTIME_HEALTH_MODULES: &[&str] = &[
    "requests",
    "httpx",
    "curl_cffi",
    "pydantic",
    "ddgs",
    "bs4",
    "lxml",
    "trafilatura",
    "pypdf",
    "pdf2image",
    "docx",
    "pptx",
    "openpyxl",
    "markdown",
    "yaml",
    "chardet",
    "dateutil",
    "tabulate",
    "jinja2",
    "dotenv",
    "matplotlib",
    "PIL",
    "plotly",
    "numpy",
    "pandas",
    "psutil",
    "tqdm",
    "pip_system_certs",
];

fn prebuilt_runtime_healthy(runtime_dir: &PathBuf, python_exe: &PathBuf) -> bool {
    if !python_exe.exists() {
        log::warn!(
            "[EmbeddedPython] 预置 Python 可执行文件不存在: {}",
            python_exe.display()
        );
        return false;
    }

    let module_list = PREBUILT_RUNTIME_HEALTH_MODULES
        .iter()
        .map(|module| format!("{module:?}"))
        .collect::<Vec<_>>()
        .join(",");
    let module_check_script = format!(
        "import importlib.util, sys; modules=[{}]; missing=[m for m in modules if importlib.util.find_spec(m) is None]; sys.exit('missing base packages: ' + ', '.join(missing)) if missing else print('ok')",
        module_list
    );
    let checks = [
        ("ssl", "import ssl; print(ssl.OPENSSL_VERSION)"),
        ("pip", "import pip; print(pip.__version__)"),
        ("base-packages", module_check_script.as_str()),
    ];

    for (label, script) in checks {
        match run_hidden_python_check(python_exe, runtime_dir, script) {
            Ok(output) if output.status.success() => {}
            Ok(output) => {
                log::warn!(
                    "[EmbeddedPython] 预置 Python runtime {} 健康检查失败: stdout={}, stderr={}",
                    label,
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
                return false;
            }
            Err(error) => {
                log::warn!(
                    "[EmbeddedPython] 预置 Python runtime {} 健康检查无法执行: {}",
                    label,
                    error
                );
                return false;
            }
        }
    }

    true
}

fn run_hidden_python_check(
    python_exe: &PathBuf,
    current_dir: &PathBuf,
    script: &str,
) -> std::io::Result<std::process::Output> {
    let mut command = Command::new(python_exe);
    command.arg("-c").arg(script).current_dir(current_dir);
    apply_no_window(&mut command);
    command.output()
}

#[cfg(windows)]
fn apply_no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn apply_no_window(_command: &mut Command) {}

fn extract_zip_stripping_optional_root(
    zip_path: &Path,
    dest_dir: &Path,
    optional_root: &str,
) -> Result<(), AppError> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| AppError::FileSystem(format!("Failed to open zip file: {}", e)))?;

    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::FileSystem(format!("Failed to parse zip: {}", e)))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::FileSystem(format!("Failed to read zip entry {}: {}", i, e)))?;

        let Some(enclosed_name) = entry.enclosed_name() else {
            log::warn!("[EmbeddedPython] 跳过不安全的 zip entry: {}", entry.name());
            continue;
        };

        let relative_path = match enclosed_name.strip_prefix(optional_root) {
            Ok(stripped) => stripped.to_path_buf(),
            Err(_) => enclosed_name,
        };

        if relative_path.as_os_str().is_empty() {
            continue;
        }

        let outpath = dest_dir.join(&relative_path);

        if entry.is_dir() {
            std::fs::create_dir_all(&outpath).map_err(|e| {
                AppError::FileSystem(format!(
                    "Failed to create directory {}: {}",
                    outpath.display(),
                    e
                ))
            })?;
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    AppError::FileSystem(format!("Failed to create parent directory: {}", e))
                })?;
            }
            let mut outfile = std::fs::File::create(&outpath).map_err(|e| {
                AppError::FileSystem(format!(
                    "Failed to create file {}: {}",
                    outpath.display(),
                    e
                ))
            })?;

            std::io::copy(&mut entry, &mut outfile).map_err(|e| {
                AppError::FileSystem(format!("Failed to write file {}: {}", outpath.display(), e))
            })?;
        }
    }

    Ok(())
}

/// 解压 zip 文件到目标目录
fn extract_zip(zip_path: &Path, dest_dir: &Path) -> Result<(), AppError> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| AppError::FileSystem(format!("Failed to open zip file: {}", e)))?;

    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::FileSystem(format!("Failed to parse zip: {}", e)))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::FileSystem(format!("Failed to read zip entry {}: {}", i, e)))?;

        let entry_name = entry.name().to_string();
        let outpath = dest_dir.join(&entry_name);

        if entry.is_dir() {
            std::fs::create_dir_all(&outpath).map_err(|e| {
                AppError::FileSystem(format!(
                    "Failed to create directory {}: {}",
                    outpath.display(),
                    e
                ))
            })?;
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    AppError::FileSystem(format!("Failed to create parent directory: {}", e))
                })?;
            }
            let mut outfile = std::fs::File::create(&outpath).map_err(|e| {
                AppError::FileSystem(format!(
                    "Failed to create file {}: {}",
                    outpath.display(),
                    e
                ))
            })?;

            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(|e| {
                AppError::FileSystem(format!("Failed to read zip entry {}: {}", entry_name, e))
            })?;

            std::io::Write::write_all(&mut outfile, &buf).map_err(|e| {
                AppError::FileSystem(format!("Failed to write file {}: {}", outpath.display(), e))
            })?;
        }
    }

    Ok(())
}

/// 修复 _pth 文件：取消注释 `import site`
///
/// Python embedded zip 的 _pth 文件默认注释掉了 `import site`，
/// 导致 venv 模块无法正常工作。取消注释后，虚拟环境创建和 pip 引导均可正常运行。
fn fix_pth_file(pth_path: &PathBuf) -> Result<(), AppError> {
    let content = std::fs::read_to_string(pth_path)
        .map_err(|e| AppError::FileSystem(format!("Failed to read _pth file: {}", e)))?;

    // 取消注释 `#import site` → `import site`
    let fixed = content.replace("#import site", "import site");

    std::fs::write(pth_path, fixed)
        .map_err(|e| AppError::FileSystem(format!("Failed to write _pth file: {}", e)))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_process_scope_is_case_insensitive_and_path_bounded() {
        let runtime =
            Path::new(r"C:\Users\Test\AppData\Roaming\com.agentvis.app\runtime\python-v1");

        assert!(windows_path_is_within_runtime(
            Path::new(
                r"c:\users\test\appdata\roaming\com.agentvis.app\runtime\python-v1\.venv\Scripts\python.exe"
            ),
            runtime
        ));
        assert!(windows_path_is_within_runtime(
            Path::new(
                r"\\?\C:\Users\Test\AppData\Roaming\com.agentvis.app\runtime\python-v1\.venv\Scripts\python.exe"
            ),
            runtime
        ));
        assert!(!windows_path_is_within_runtime(
            Path::new(
                r"C:\Users\Test\AppData\Roaming\com.agentvis.app\runtime\python-v10\python.exe"
            ),
            runtime
        ));
        assert!(!windows_path_is_within_runtime(
            Path::new(r"C:\Users\Test\miniconda3\python.exe"),
            runtime
        ));
    }

    #[test]
    fn runtime_remove_retries_windows_lock_errors_only() {
        assert!(is_retryable_runtime_remove_error(
            &std::io::Error::from_raw_os_error(5)
        ));
        assert!(is_retryable_runtime_remove_error(
            &std::io::Error::from_raw_os_error(32)
        ));
        assert!(is_retryable_runtime_remove_error(
            &std::io::Error::from_raw_os_error(145)
        ));
        assert!(!is_retryable_runtime_remove_error(
            &std::io::Error::from_raw_os_error(3)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn terminates_a_process_running_from_the_managed_runtime_only() {
        let test_root = std::env::temp_dir().join(format!(
            "agentvis-runtime-process-cleanup-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
        let runtime_dir = test_root.join("python-v1");
        std::fs::create_dir_all(&runtime_dir).unwrap();
        let fixture_exe = runtime_dir.join("python.exe");
        std::fs::copy(std::env::current_exe().unwrap(), &fixture_exe).unwrap();

        let mut child = std::process::Command::new(&fixture_exe)
            .arg("commands::embedded_python_setup::tests::runtime_process_cleanup_child_fixture")
            .arg("--exact")
            .env("AGENTVIS_RUNTIME_PROCESS_FIXTURE", "1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let child_pid = child.id();
        std::thread::sleep(std::time::Duration::from_millis(300));

        let terminated = terminate_processes_from_runtime(&runtime_dir).unwrap();
        if !terminated.contains(&child_pid) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_dir_all(&test_root);
            panic!(
                "managed runtime process PID={} was not terminated; terminated={:?}",
                child_pid, terminated
            );
        }

        let status = child.wait().unwrap();
        assert!(!status.success());
        std::fs::remove_dir_all(&test_root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn runtime_process_cleanup_child_fixture() {
        if std::env::var_os("AGENTVIS_RUNTIME_PROCESS_FIXTURE").is_some() {
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
    }
}
