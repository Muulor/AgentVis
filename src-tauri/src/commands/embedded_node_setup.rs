//! 内嵌 Node.js 环境准备命令
//!
//! 职责：
//! - 将安装包内的 node-v20.18.0-win-x64.zip 解压到 {AppDataDir}/runtime/node-v20/
//! - 幂等：node.exe 已存在则跳过
//! - 返回 node 可执行文件目录路径（用于注入 PATH）
//!
//! 设计说明：
//! - Node.js zip 根目录为 node-v20.18.0-win-x64/，解压时剥离此层，
//!   直接将内容放入 node-v20/，使 node.exe 路径为 {AppDataDir}/runtime/node-v20/node.exe
//! - shell_execute 在每次调用时检查此目录是否存在并注入 PATH，
//!   系统 Node.js 已在 PATH 时自动作为 fallback（追加到 PATH 末端）

use std::io::Read;
use std::path::PathBuf;
use tauri::Manager;
use crate::error::AppError;

type CommandResult<T> = Result<T, AppError>;

/// 内嵌 Node.js 信息
#[derive(Debug, serde::Serialize)]
pub struct EmbeddedNodeInfo {
    /// Node.js 可执行文件目录（包含 node.exe, npm.cmd, npx.cmd）
    pub bin_dir: String,
    /// node.exe 路径
    pub node_exe: String,
    /// true 表示本次执行了解压
    pub just_extracted: bool,
}

/// 准备内嵌 Node.js 运行时（幂等）
///
/// 调用时机：应用启动时通过 invoke 调用一次。
/// 若 {AppDataDir}/runtime/node-v20/node.exe 已存在，直接返回路径，不重复解压。
#[tauri::command]
pub async fn prepare_embedded_node(
    app: tauri::AppHandle,
) -> CommandResult<EmbeddedNodeInfo> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| AppError::FileSystem(format!("Failed to get AppDataDir: {}", e)))?;

    let resource_dir = app.path().resource_dir()
        .map_err(|e| AppError::FileSystem(format!("Failed to get resource_dir: {}", e)))?;

    // 目标目录：{AppDataDir}/runtime/node-v20/
    let node_dir = app_data_dir.join("runtime").join("node-v20");
    let node_exe = node_dir.join("node.exe");

    // 幂等检查：同时验证 node.exe 和 npm.cmd 都存在才算完整
    // 背景：Windows MAX_PATH（260字符）限制可能导致 NSIS 卸载程序无法删除
    // node-v20/node_modules/npm/ 下深层嵌套的文件，使 node-v20 目录在卸载后残留。
    // 若仅检查 node.exe，会误判为"已就绪"，但 npm.cmd 可能因路径过深而缺失，
    // 导致后续 npm install 命令找不到 npm。两者都存在才视为完整安装。
    let npm_cmd = node_dir.join("npm.cmd");
    if node_exe.exists() && npm_cmd.exists() {
        log::debug!("[EmbeddedNode] node.exe + npm.cmd 均已存在，跳过解压: {}", node_dir.display());
        return Ok(EmbeddedNodeInfo {
            bin_dir: node_dir.to_string_lossy().to_string(),
            node_exe: node_exe.to_string_lossy().to_string(),
            just_extracted: false,
        });
    }

    // node.exe 或 npm.cmd 不完整（可能是残留目录），先清理再重新解压
    if node_dir.exists() {
        log::warn!("[EmbeddedNode] node-v20 目录不完整（可能是卸载残留），清理后重新解压");
        std::fs::remove_dir_all(&node_dir)
            .map_err(|e| AppError::FileSystem(format!("Failed to clean up leftover node-v20 directory: {}", e)))?;
    }

    // 获取 zip 资源路径
    let zip_src = resource_dir
        .join("node-bundle")
        .join("node-v20.18.0-win-x64.zip");

    if !zip_src.exists() {
        return Err(AppError::FileSystem(format!(
            "Embedded Node.js resource file does not exist (only included in release builds): {}",
            zip_src.display()
        )));
    }

    // 创建目标目录
    std::fs::create_dir_all(&node_dir)
        .map_err(|e| AppError::FileSystem(format!("Failed to create node-v20 directory: {}", e)))?;

    // 解压（剥离顶层 node-v20.18.0-win-x64/ 文件夹）
    log::info!("[EmbeddedNode] 开始解压 Node.js 20.18.0 到 {}", node_dir.display());
    extract_zip_strip_top(&zip_src, &node_dir)?;
    log::info!("[EmbeddedNode] Node.js 解压完成");

    Ok(EmbeddedNodeInfo {
        bin_dir: node_dir.to_string_lossy().to_string(),
        node_exe: node_exe.to_string_lossy().to_string(),
        just_extracted: true,
    })
}

/// 获取内嵌 Node.js 的 bin 目录路径（不解压，仅检查是否完整）
///
/// 供 shell.rs 的 PATH 注入使用。
/// 返回 None 表示尚未解压或目录不完整（node.exe / npm.cmd 任一缺失）。
pub fn get_embedded_node_bin_dir(app_data_dir: &PathBuf) -> Option<String> {
    let node_dir = app_data_dir.join("runtime").join("node-v20");
    // 同时检查 node.exe 和 npm.cmd，与 prepare_embedded_node 的完整性判断一致
    if node_dir.join("node.exe").exists() && node_dir.join("npm.cmd").exists() {
        Some(node_dir.to_string_lossy().to_string())
    } else {
        None
    }
}

/// 解压 zip 并剥离顶层目录
///
/// Node.js zip 内部结构：node-v20.18.0-win-x64/{所有文件}
/// 解压后剥离 node-v20.18.0-win-x64/ 前缀，直接写入 dest_dir/
fn extract_zip_strip_top(zip_path: &PathBuf, dest_dir: &PathBuf) -> Result<(), AppError> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| AppError::FileSystem(format!("Failed to open zip: {}", e)))?;

    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::FileSystem(format!("Failed to parse zip: {}", e)))?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)
            .map_err(|e| AppError::FileSystem(format!("Failed to read zip entry {}: {}", i, e)))?;

        let raw_name = entry.name().to_string();

        // 剥离顶层目录前缀（如 "node-v20.18.0-win-x64/"）
        let stripped = strip_top_dir(&raw_name);
        if stripped.is_empty() {
            continue; // 跳过顶层目录本身
        }

        let outpath = dest_dir.join(stripped);

        if entry.is_dir() {
            std::fs::create_dir_all(&outpath)
                .map_err(|e| AppError::FileSystem(format!("Failed to create directory {}: {}", outpath.display(), e)))?;
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| AppError::FileSystem(format!("Failed to create parent directory: {}", e)))?;
            }

            let mut buf = Vec::new();
            entry.read_to_end(&mut buf)
                .map_err(|e| AppError::FileSystem(format!("Failed to read zip entry {}: {}", raw_name, e)))?;

            let mut outfile = std::fs::File::create(&outpath)
                .map_err(|e| AppError::FileSystem(format!("Failed to create file {}: {}", outpath.display(), e)))?;

            std::io::Write::write_all(&mut outfile, &buf)
                .map_err(|e| AppError::FileSystem(format!("Failed to write file {}: {}", outpath.display(), e)))?;
        }
    }

    Ok(())
}

/// 剥离路径的第一个段（顶层目录名）
///
/// "node-v20.18.0-win-x64/node.exe" → "node.exe"
/// "node-v20.18.0-win-x64/lib/node_modules/..." → "lib/node_modules/..."
/// "node-v20.18.0-win-x64/" → ""（空字符串，调用方跳过）
fn strip_top_dir(path: &str) -> &str {
    // 找到第一个斜杠
    if let Some(pos) = path.find('/') {
        &path[pos + 1..]
    } else {
        // 没有斜杠的条目（不太可能在 Node.js zip 中出现）
        path
    }
}
