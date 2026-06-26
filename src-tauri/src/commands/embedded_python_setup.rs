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
use std::io::Read;
use std::path::PathBuf;
use std::process::Command;
use tauri::Manager;

const EMBEDDED_PYTHON_VERSION: &str = "3.13.14";
const EMBEDDED_PYTHON_ABI_TAG: &str = "313";
const EMBEDDED_PYTHON_CACHE_DIR: &str = "python-embed-3.13";

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
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::FileSystem(format!("Failed to get AppDataDir: {}", e)))?;

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| AppError::FileSystem(format!("Failed to get resource_dir: {}", e)))?;

    let runtime_dir = app_data_dir.join("runtime").join("python-v1");
    let venv_path = runtime_dir.join(".venv");
    let python_exe = get_prebuilt_venv_python_exe(&venv_path);
    let signature_src = resource_dir
        .join("python-runtime")
        .join("python-runtime-v1.signature");
    let bundled_signature = read_optional_signature(&signature_src)?;
    let signature_dest = runtime_dir.join(".agentvis-runtime-signature");

    let mut just_extracted = false;

    if python_exe.exists() {
        let signature_matches = bundled_signature
            .as_deref()
            .map(|signature| runtime_signature_matches(&signature_dest, signature))
            .unwrap_or(true);

        if !signature_matches {
            log::warn!(
                "[EmbeddedPython] 预置 Python runtime 签名已变化，将重新解压: {}",
                runtime_dir.display()
            );
            std::fs::remove_dir_all(&runtime_dir).map_err(|e| {
                AppError::FileSystem(format!("Failed to remove stale python-v1 directory: {}", e))
            })?;
        } else if !prebuilt_runtime_healthy(&runtime_dir, &python_exe) {
            log::warn!(
                "[EmbeddedPython] 已存在的预置 Python runtime 不健康，将重新解压: {}",
                runtime_dir.display()
            );
            std::fs::remove_dir_all(&runtime_dir).map_err(|e| {
                AppError::FileSystem(format!(
                    "Failed to remove unhealthy python-v1 directory: {}",
                    e
                ))
            })?;
        }
    }

    if !python_exe.exists() {
        let zip_src = resource_dir
            .join("python-runtime")
            .join("python-runtime-v1.zip");

        if !zip_src.exists() {
            return Err(AppError::FileSystem(format!(
                "Prebuilt Python runtime resource does not exist: {}",
                zip_src.display()
            )));
        }

        if let Some(parent) = runtime_dir.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AppError::FileSystem(format!("Failed to create runtime parent directory: {}", e))
            })?;
        }

        if runtime_dir.exists() {
            std::fs::remove_dir_all(&runtime_dir).map_err(|e| {
                AppError::FileSystem(format!("Failed to reset python-v1 directory: {}", e))
            })?;
        }
        std::fs::create_dir_all(&runtime_dir).map_err(|e| {
            AppError::FileSystem(format!("Failed to create python-v1 directory: {}", e))
        })?;

        extract_zip_stripping_optional_root(&zip_src, &runtime_dir, "python-v1")?;
        just_extracted = true;
        log::info!(
            "[EmbeddedPython] 已解压预置 Python runtime 到 {}",
            runtime_dir.display()
        );
    } else {
        log::debug!("[EmbeddedPython] 预置 Python runtime 已存在，跳过解压");
    }

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
    "bs4",
    "lxml",
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
    zip_path: &PathBuf,
    dest_dir: &PathBuf,
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
fn extract_zip(zip_path: &PathBuf, dest_dir: &PathBuf) -> Result<(), AppError> {
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
