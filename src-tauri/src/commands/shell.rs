//! Shell 命令执行编排模块。
//!
//! 这一层负责 Tauri `shell_execute` / `shell_cancel` / `shell_kill` 对外命令入口，
//! 并把命令校验、工作目录解析、环境变量注入、后台进程注册、前台超时 / 取消、
//! 进程沙箱策略、broker/proxy 会话、direct-audit 授权参数和 WFP 实验诊断串联起来。
//!
//! 具体的沙箱策略、审计模型、网络目标解析和 Windows 平台后端已经下沉到
//! `process_sandbox` 子模块；这里只保留执行期编排和 shell 运行时 glue。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
#[cfg(target_os = "windows")]
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex as AsyncMutex};
use tokio::time::{timeout, Duration};

use crate::error::{AppError, CommandResult};
use crate::AppState;

use super::command_validator;
use super::network_broker::{
    start_network_broker_file_session, start_network_broker_proxy_session_with_auth,
    NetworkBrokerCredentialPolicy, NetworkBrokerFileSession, NetworkBrokerProxySession,
};
use super::process_sandbox::{
    agent_browser_runtime_script_hint, command_token_name, detect_network_direct_targets,
    detect_network_intent, detect_network_proxy_bypass_signal,
    detect_network_remote_destructive_signal, detect_network_sensitive_egress_signal,
    detect_network_upload_risk_signal, direct_targets_from_allowances_for_protocols,
    list_persisted_sandbox_audit_events, record_sandbox_audit_event,
    required_network_direct_protocols, resolve_network_direct_target_risk, split_command_tokens,
    NetworkDirectAllowance, NetworkDirectTarget, NetworkDirectTargetRiskInfo, ProcessSandboxGuard,
    SandboxAuditEvent, SandboxAuditEventQuery, SandboxNetworkIsolation, ShellSandboxPolicy,
};
#[cfg(target_os = "windows")]
use super::process_sandbox::{
    spawn_appcontainer_filesystem_process_with_capabilities, spawn_restricted_token_process,
    AppContainerFilesystemAccess, AppContainerFilesystemGrant, RestrictedExecutionBackend,
    RestrictedTokenProbeResult,
};
use super::trash_bin;

// ==================== 类型定义 ====================

/// Shell 执行结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellExecResult {
    /// 退出码
    pub exit_code: i32,
    /// 标准输出
    pub stdout: String,
    /// 错误输出
    pub stderr: String,
    /// 是否因为超时终止
    pub timed_out: bool,
    /// 是否由 AgentVis 主动终止进程
    pub terminated: bool,
    /// 执行耗时（毫秒）
    pub duration_ms: Option<u64>,
    /// 本次执行使用的超时上限（秒）
    pub timeout_secs: Option<u64>,
    /// 后台进程 PID（仅后台模式有值）
    pub pid: Option<u32>,
}

const DEFAULT_SHELL_TIMEOUT_SECONDS: u64 = 300;
const MAX_SHELL_TIMEOUT_SECONDS: u64 = 1800;

fn duration_millis_u64(started_at: Instant) -> u64 {
    let millis = started_at.elapsed().as_millis();
    u64::try_from(millis).unwrap_or(u64::MAX)
}

fn resolve_shell_timeout_duration(timeout_secs: Option<u64>) -> CommandResult<Duration> {
    let seconds = timeout_secs.unwrap_or(DEFAULT_SHELL_TIMEOUT_SECONDS);
    if seconds == 0 || seconds > MAX_SHELL_TIMEOUT_SECONDS {
        return Err(AppError::Generic(format!(
            "timeout_secs must be between 1 and {} seconds",
            MAX_SHELL_TIMEOUT_SECONDS
        )));
    }
    Ok(Duration::from_secs(seconds))
}

fn shell_exec_result(
    exit_code: i32,
    stdout: String,
    stderr: String,
    pid: Option<u32>,
    started_at: Instant,
    timeout_duration: Option<Duration>,
    timed_out: bool,
    terminated: bool,
) -> ShellExecResult {
    ShellExecResult {
        exit_code,
        stdout,
        stderr,
        timed_out,
        terminated,
        duration_ms: Some(duration_millis_u64(started_at)),
        timeout_secs: timeout_duration.map(|duration| duration.as_secs()),
        pid,
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDirectTargetInfo {
    pub protocol: String,
    pub host: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_risk: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_ip_samples: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_risk_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppContainerFilesystemGrantRequest {
    pub path: String,
    pub access: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDirectTargetInspection {
    pub targets: Vec<NetworkDirectTargetInfo>,
    pub required_protocols: Vec<String>,
}

fn direct_targets_from_explicit_infos(
    target_infos: Option<&[NetworkDirectTargetInfo]>,
) -> Vec<NetworkDirectTarget> {
    target_infos
        .unwrap_or(&[])
        .iter()
        .filter_map(|target| {
            NetworkDirectTarget::new(target.protocol.clone(), target.host.clone(), target.port)
        })
        .collect()
}

async fn network_direct_target_info_from_target(
    target: NetworkDirectTarget,
) -> NetworkDirectTargetInfo {
    let risk = resolve_network_direct_target_risk(&target).await;
    NetworkDirectTargetInfo {
        protocol: target.protocol,
        host: target.host,
        port: target.port,
        resolved_risk: Some(risk.risk.to_string()),
        resolved_ip_samples: Some(risk.resolved_ip_samples),
        resolved_risk_reason: Some(risk.reason.to_string()),
    }
}

async fn resolve_network_direct_target_risks(
    targets: &[NetworkDirectTarget],
) -> Vec<NetworkDirectTargetRiskInfo> {
    let mut risks = Vec::with_capacity(targets.len());
    for target in targets {
        risks.push(resolve_network_direct_target_risk(target).await);
    }
    risks
}

fn network_direct_allowance_is_session(allowance: &NetworkDirectAllowance) -> bool {
    allowance.scope.eq_ignore_ascii_case("session")
}

/// 后台进程注册表
///
/// 追踪所有后台 spawn 的进程，支持按 PID 终止。
/// 使用 Mutex 保证线程安全，进程数量少无需 RwLock。
struct BackgroundProcess {
    child: tokio::process::Child,
    sandbox: ProcessSandboxGuard,
    _network_session: Option<NetworkRuntimeSession>,
}

struct NetworkRuntimeSession {
    _file_session: Option<NetworkBrokerFileSession>,
    _proxy_session: Option<NetworkBrokerProxySession>,
}

impl NetworkRuntimeSession {
    fn proxy_port(&self) -> Option<u16> {
        self._proxy_session
            .as_ref()
            .map(|session| session.local_addr.port())
    }

    fn broker_request_count(&self) -> u64 {
        let file_requests = self
            ._file_session
            .as_ref()
            .map(NetworkBrokerFileSession::request_count)
            .unwrap_or(0);
        let proxy_requests = self
            ._proxy_session
            .as_ref()
            .map(NetworkBrokerProxySession::request_count)
            .unwrap_or(0);
        file_requests + proxy_requests
    }

    fn proxy_env_values(&self) -> Option<NetworkProxyEnvValues> {
        let proxy_session = self._proxy_session.as_ref()?;
        Some(NetworkProxyEnvValues {
            proxy_url_with_credentials: proxy_session.proxy_url_with_credentials(),
            browser_proxy_server: proxy_session.proxy_url(),
            proxy_username: proxy_session.proxy_username().to_string(),
            proxy_password: proxy_session.proxy_password().to_string(),
        })
    }
}

struct NetworkProxyEnvValues {
    proxy_url_with_credentials: String,
    browser_proxy_server: String,
    proxy_username: String,
    proxy_password: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ControlledBrowserRuntimeCommand {
    StartOrEnsure,
    Status,
    Stop,
    Control,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WfpGuardReadiness {
    ready: bool,
    reason: &'static str,
    detail: Option<String>,
}

#[derive(Debug, Clone)]
struct WfpCanaryObservation {
    network_intent: String,
    eligible_command: Option<String>,
    task_category: String,
}

#[derive(Debug, Clone)]
struct WfpManagedEgressExecutable {
    command_name: String,
    source_exe: PathBuf,
    managed_dir: PathBuf,
    managed_exe: PathBuf,
}

struct WfpManagedEgressGuardSession {
    child: tokio::process::Child,
    managed_dir: PathBuf,
    managed_exe: PathBuf,
    allowed_loopback_port: Option<u16>,
}

pub struct BackgroundProcessRegistry {
    children: Mutex<HashMap<u32, BackgroundProcess>>,
}

impl BackgroundProcessRegistry {
    pub fn new() -> Self {
        Self {
            children: Mutex::new(HashMap::new()),
        }
    }

    /// 注册后台进程，返回 PID
    fn register(
        &self,
        child: tokio::process::Child,
        sandbox: ProcessSandboxGuard,
        network_session: Option<NetworkRuntimeSession>,
    ) -> Option<u32> {
        let pid = child.id();
        if let (Some(pid), Ok(mut map)) = (pid, self.children.lock()) {
            Self::reap_exited_locked(&mut map);
            map.insert(
                pid,
                BackgroundProcess {
                    child,
                    sandbox,
                    _network_session: network_session,
                },
            );
            Some(pid)
        } else {
            None
        }
    }

    fn reap_exited_locked(map: &mut HashMap<u32, BackgroundProcess>) {
        let exited: Vec<u32> = map
            .iter_mut()
            .filter_map(|(pid, process)| match process.child.try_wait() {
                Ok(Some(_)) => Some(*pid),
                Ok(None) => None,
                Err(error) => {
                    log::debug!(
                        "[Shell] failed to inspect background process PID={}: {}",
                        pid,
                        error
                    );
                    Some(*pid)
                }
            })
            .collect();
        for pid in exited {
            map.remove(&pid);
        }
    }

    /// 按 PID 终止后台进程
    async fn kill(&self, pid: u32) -> Result<(), String> {
        let mut process = {
            let mut map = self
                .children
                .lock()
                .map_err(|e| format!("Failed to acquire lock: {}", e))?;
            Self::reap_exited_locked(&mut map);
            map.remove(&pid)
                .ok_or_else(|| format!("Background process with PID {} was not found", pid))?
        };

        if let Err(e) = process.sandbox.terminate(1) {
            log::warn!("[Shell] Job Object terminate failed for PID={}: {}", pid, e);
        }

        if let Err(e) = process.child.kill().await {
            log::debug!("[Shell] Background child.kill PID={} returned: {}", pid, e);
        }
        let _ = process.child.wait().await;

        log::debug!("[Shell] Background process PID={} terminated", pid);
        Ok(())
    }
}

// ==================== 环境变量增强 ====================

/// 缓存全局 npm modules 路径
///
/// 使用 OnceLock 确保只执行一次 `npm root -g`，避免重复 spawn 子进程。
/// 返回 Some(路径) 表示检测成功，None 表示 npm 不可用。
static GLOBAL_NPM_PATH: OnceLock<Option<String>> = OnceLock::new();
static FOREGROUND_CANCEL_REGISTRY: OnceLock<AsyncMutex<HashMap<String, oneshot::Sender<()>>>> =
    OnceLock::new();
static FOREGROUND_CANCEL_REQUESTS: OnceLock<AsyncMutex<HashSet<String>>> = OnceLock::new();
static CONTROLLED_BROWSER_NETWORK_SESSIONS: OnceLock<
    Mutex<HashMap<String, NetworkRuntimeSession>>,
> = OnceLock::new();
const NETWORK_GUARD_BACKEND_ENV: &str = "AGENTVIS_NETWORK_GUARD_BACKEND";
const CONTROLLED_BROWSER_SESSION_KEY: &str = "agent-browser";
const WFP_HELPER_INSPECT_TIMEOUT_SECS: u64 = 5;
const WFP_HELPER_READY_TIMEOUT_SECS: u64 = 5;
const WFP_MANAGED_EGRESS_MARKER: &str = ".agentvis-egress-managed";
const WFP_MANAGED_EGRESS_TIMEOUT_GRACE_MS: u64 = 5_000;

fn foreground_cancel_registry() -> &'static AsyncMutex<HashMap<String, oneshot::Sender<()>>> {
    FOREGROUND_CANCEL_REGISTRY.get_or_init(|| AsyncMutex::new(HashMap::new()))
}

fn foreground_cancel_requests() -> &'static AsyncMutex<HashSet<String>> {
    FOREGROUND_CANCEL_REQUESTS.get_or_init(|| AsyncMutex::new(HashSet::new()))
}

fn controlled_browser_network_sessions() -> &'static Mutex<HashMap<String, NetworkRuntimeSession>> {
    CONTROLLED_BROWSER_NETWORK_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn terminate_child_tree(
    child: &mut tokio::process::Child,
    sandbox: Option<&ProcessSandboxGuard>,
) {
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        if let Some(sandbox) = sandbox {
            if let Err(e) = sandbox.terminate(1) {
                log::warn!("[Shell] Job Object terminate failed: {}", e);
            }
        }

        if let Some(pid) = child.id() {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
        } else {
            let _ = child.kill().await;
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = sandbox;
        let _ = child.kill().await;
    }

    let _ = child.wait().await;
}

async fn attach_process_sandbox(
    child: &mut tokio::process::Child,
    command: &str,
    sandbox_policy: &ShellSandboxPolicy,
) -> Result<ProcessSandboxGuard, AppError> {
    match ProcessSandboxGuard::attach_child(child, command, sandbox_policy.process_profile()) {
        Ok(sandbox) => Ok(sandbox),
        Err(error) => {
            if let Err(kill_error) = child.kill().await {
                log::warn!(
                    "[Shell] failed to kill process after sandbox attach failure: {}",
                    kill_error
                );
            }
            let _ = child.wait().await;
            Err(AppError::Forbidden(format!("Sandbox block: {}", error)))
        }
    }
}

/// 获取全局 npm modules 路径（带缓存）
///
/// 首次调用时执行 `npm root -g`，后续直接返回缓存结果。
/// Node.js `require()` 默认不搜索全局 node_modules，
/// 需要通过 NODE_PATH 显式指定才能找到 `npm install -g` 安装的包。
fn get_npm_global_modules_path() -> Option<String> {
    GLOBAL_NPM_PATH
        .get_or_init(|| {
            // Windows 上 npm 是 npm.cmd 批处理文件，
            // std::process::Command::new("npm") 不经过 shell 无法解析 .cmd 扩展名，
            // 必须通过 cmd /C 执行才能找到 npm
            #[cfg(target_os = "windows")]
            let output = {
                // CREATE_NO_WINDOW: 禁止 cmd.exe 创建可见控制台窗口
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                std::process::Command::new("cmd")
                    .args(["/C", "npm", "root", "-g"])
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::null())
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
            };

            #[cfg(not(target_os = "windows"))]
            let output = std::process::Command::new("npm")
                .args(["root", "-g"])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .output();

            match output {
                Ok(out) if out.status.success() => {
                    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !path.is_empty() && std::path::Path::new(&path).exists() {
                        log::debug!("[Shell] 检测到全局 npm modules 路径: {}", path);
                        Some(path)
                    } else {
                        log::debug!("[Shell] npm root -g 返回无效路径: '{}'", path);
                        None
                    }
                }
                Ok(out) => {
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    log::debug!(
                        "[Shell] npm root -g 执行失败 (退出码: {:?}): {}",
                        out.status.code(),
                        stderr.trim()
                    );
                    None
                }
                Err(e) => {
                    log::debug!("[Shell] 未检测到 npm 命令: {}", e);
                    None
                }
            }
        })
        .clone()
}

/// 发现系统中已安装但未加入 PATH 的常用工具目录
///
/// 检测通过 winget/scoop 等包管理器安装的程序，
/// 这些安装器通常不会自动将程序目录加入 PATH。
/// 仅返回实际存在且尚未在 PATH 中的路径。
#[cfg(target_os = "windows")]
fn discover_extra_tool_paths() -> Vec<String> {
    let current_path = std::env::var("PATH").unwrap_or_default();
    let current_path_lower = current_path.to_lowercase();

    // 已知工具的常见安装路径
    let candidates = [
        "C:\\Program Files\\LibreOffice\\program",
        "C:\\Program Files (x86)\\LibreOffice\\program",
    ];

    candidates
        .iter()
        .filter(|p| {
            let path = std::path::Path::new(p);
            // 目录存在 且 尚未在 PATH 中
            path.exists() && !current_path_lower.contains(&p.to_lowercase())
        })
        .map(|p| p.to_string())
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn discover_extra_tool_paths() -> Vec<String> {
    Vec::new()
}

fn default_venv_scripts_dir(app_data_dir: &Path) -> Option<String> {
    let venv_dir = app_data_dir.join("runtime").join("python-v1").join(".venv");
    let scripts_dir = if cfg!(target_os = "windows") {
        venv_dir.join("Scripts")
    } else {
        venv_dir.join("bin")
    };
    let python_exe = if cfg!(target_os = "windows") {
        scripts_dir.join("python.exe")
    } else {
        scripts_dir.join("python")
    };

    if python_exe.exists() && venv_external_base_roots(app_data_dir).is_empty() {
        Some(scripts_dir.to_string_lossy().to_string())
    } else {
        None
    }
}

/// 增强子进程非 PATH 环境变量
///
/// 仅负责 PYTHONUTF8 和 NODE_PATH 注入。
/// PATH 的全部处理（VENV 前置 / 内嵌 Node / 额外工具）已统一移至
/// shell_execute 内的「PATH 累积构建块」，避免多次 cmd.env("PATH", ...)
/// 相互覆盖导致之前注入的目录丢失。
fn set_command_env(
    cmd: &mut Command,
    restricted_env_overrides: &mut HashMap<String, String>,
    key: impl Into<String>,
    value: impl Into<String>,
) {
    let key = key.into();
    let value = value.into();
    cmd.env(&key, &value);
    restricted_env_overrides.insert(key, value);
}

fn push_venv_path_prefixes(path_prefix: &mut Vec<String>, venv_dir: &str) {
    path_prefix.push(venv_dir.to_string());

    let nested_scripts_dir = Path::new(venv_dir).join("Scripts");
    if nested_scripts_dir.exists() {
        path_prefix.push(nested_scripts_dir.to_string_lossy().to_string());
    }
}

fn enrich_process_env(
    cmd: &mut Command,
    user_env: Option<&HashMap<String, String>>,
    restricted_env_overrides: &mut HashMap<String, String>,
) {
    // PYTHONUTF8: 强制 Python 使用 UTF-8 模式（Python 3.7+）
    //   解决 Windows 默认 GBK 编码导致含中文的 Python 脚本执行失败的问题
    let user_has_pythonutf8 = user_env
        .map(|e| e.contains_key("PYTHONUTF8"))
        .unwrap_or(false);
    if !user_has_pythonutf8 {
        set_command_env(cmd, restricted_env_overrides, "PYTHONUTF8", "1");
    }
    let user_has_dont_write_bytecode = user_env
        .map(|e| e.contains_key("PYTHONDONTWRITEBYTECODE"))
        .unwrap_or(false);
    if !user_has_dont_write_bytecode {
        set_command_env(
            cmd,
            restricted_env_overrides,
            "PYTHONDONTWRITEBYTECODE",
            "1",
        );
    }

    // NODE_PATH: 注入全局 npm modules 路径，使 require() 能找到全局安装的包
    //   仅当用户未显式设置 NODE_PATH 时注入
    let user_has_node_path = user_env
        .map(|e| e.contains_key("NODE_PATH"))
        .unwrap_or(false);
    if !user_has_node_path {
        if let Some(ref global_path) = get_npm_global_modules_path() {
            let existing = std::env::var("NODE_PATH").unwrap_or_default();
            let new_node_path = if existing.is_empty() {
                global_path.clone()
            } else {
                format!("{};{}", existing, global_path)
            };
            log::debug!("[Shell] NODE_PATH 已注入: {}", new_node_path);
            set_command_env(cmd, restricted_env_overrides, "NODE_PATH", new_node_path);
        } else {
            log::debug!("[Shell] ⚠️ 未获取到全局 npm 路径，跳过 NODE_PATH 注入");
        }
    }
}

fn sandbox_profile_env(app_data_dir: &Path) -> CommandResult<Vec<(&'static str, String)>> {
    let profile_root = app_data_dir.join("runtime").join("sandbox-profile");
    let home_dir = profile_root.join("home");
    let roaming_dir = profile_root.join("roaming");
    let local_dir = profile_root.join("local");
    let temp_dir = profile_root.join("temp");

    for dir in [&home_dir, &roaming_dir, &local_dir, &temp_dir] {
        std::fs::create_dir_all(dir).map_err(|error| {
            AppError::FileSystem(format!(
                "Failed to prepare sandbox profile directory {}: {}",
                dir.display(),
                error
            ))
        })?;
    }

    let profile_root = profile_root.to_string_lossy().to_string();
    let home = home_dir.to_string_lossy().to_string();
    let roaming = roaming_dir.to_string_lossy().to_string();
    let local = local_dir.to_string_lossy().to_string();
    let temp = temp_dir.to_string_lossy().to_string();

    let mut envs = vec![
        ("AGENTVIS_SANDBOX_PROFILE", profile_root),
        ("HOME", home.clone()),
        ("USERPROFILE", home.clone()),
        ("APPDATA", roaming.clone()),
        ("LOCALAPPDATA", local.clone()),
        ("TEMP", temp.clone()),
        ("TMP", temp.clone()),
        ("XDG_CONFIG_HOME", roaming),
        ("XDG_CACHE_HOME", local),
        ("XDG_DATA_HOME", home.clone()),
    ];

    #[cfg(target_os = "windows")]
    if let Some((drive, path)) = split_windows_home_path(&home) {
        envs.push(("HOMEDRIVE", drive));
        envs.push(("HOMEPATH", path));
    }

    Ok(envs)
}

#[cfg(target_os = "windows")]
fn split_windows_home_path(home: &str) -> Option<(String, String)> {
    let bytes = home.as_bytes();
    if bytes.len() < 2 || bytes[1] != b':' {
        return None;
    }
    let drive = home[..2].to_string();
    let path = if home.len() > 2 {
        home[2..].to_string()
    } else {
        "\\".to_string()
    };
    Some((drive, path))
}

fn apply_sandbox_profile_env(
    cmd: &mut Command,
    restricted_env_overrides: &mut HashMap<String, String>,
    app_data_dir: &Path,
) -> CommandResult<()> {
    for (key, value) in sandbox_profile_env(app_data_dir)? {
        set_command_env(cmd, restricted_env_overrides, key, value);
    }
    Ok(())
}

fn appcontainer_direct_network_env_overrides() -> Vec<(&'static str, &'static str)> {
    vec![
        ("HTTP_PROXY", ""),
        ("HTTPS_PROXY", ""),
        ("ALL_PROXY", ""),
        ("http_proxy", ""),
        ("https_proxy", ""),
        ("all_proxy", ""),
        ("NO_PROXY", "*"),
        ("no_proxy", "*"),
        ("npm_config_proxy", ""),
        ("npm_config_https_proxy", ""),
        ("npm_config_noproxy", "*"),
        ("NPM_CONFIG_PROXY", ""),
        ("NPM_CONFIG_HTTPS_PROXY", ""),
        ("NPM_CONFIG_NOPROXY", "*"),
        ("PIP_PROXY", ""),
        ("GIT_CONFIG_COUNT", "0"),
        ("AGENTVIS_BROWSER_PROXY_SERVER", ""),
        ("AGENTVIS_BROWSER_PROXY_USERNAME", ""),
        ("AGENTVIS_BROWSER_PROXY_PASSWORD", ""),
        ("AGENTVIS_NETWORK_PROXY_MODE", "direct"),
        ("AGENTVIS_NETWORK_PROXY_URL", ""),
        ("AGENTVIS_NETWORK_PROXY_USERNAME", ""),
        ("AGENTVIS_NETWORK_PROXY_PASSWORD", ""),
    ]
}

fn network_guard_backend_is_wfp_hard(value: Option<&str>) -> bool {
    value
        .map(|value| {
            matches!(
                value.trim(),
                "wfpAppIdBlock"
                    | "wfp-app-id-block"
                    | "wfp_app_id_block"
                    | "wfpPerRunAppIdBlock"
                    | "wfp-per-run-app-id-block"
                    | "wfp_per_run_app_id_block"
            )
        })
        .unwrap_or(false)
}

fn network_guard_backend_is_wfp_canary(value: Option<&str>) -> bool {
    value
        .map(|value| matches!(value.trim(), "wfpCanary" | "wfp-canary" | "wfp_canary"))
        .unwrap_or(false)
}

fn network_risk_credential_context(
    credential_policies: Option<&[NetworkBrokerCredentialPolicy]>,
) -> &'static str {
    if credential_policies.is_some_and(|policies| !policies.is_empty()) {
        "brokerCredentialRef"
    } else {
        "ambient"
    }
}

fn apply_network_risk_audit_fields(
    event: &mut SandboxAuditEvent,
    risk_class: &str,
    risk_kind: &str,
    credential_context: &str,
) {
    event.risk_class = Some(risk_class.to_string());
    event.risk_kind = Some(risk_kind.to_string());
    event.credential_context = Some(credential_context.to_string());
}

fn wfp_app_id_guard_requested(sandbox_policy: &ShellSandboxPolicy) -> bool {
    sandbox_policy.uses_broker_preferred_network_guard()
        && network_guard_backend_is_wfp_hard(
            std::env::var(NETWORK_GUARD_BACKEND_ENV).ok().as_deref(),
        )
}

fn wfp_canary_requested(sandbox_policy: &ShellSandboxPolicy) -> bool {
    sandbox_policy.uses_broker_preferred_network_guard()
        && network_guard_backend_is_wfp_canary(
            std::env::var(NETWORK_GUARD_BACKEND_ENV).ok().as_deref(),
        )
}

fn apply_appcontainer_direct_network_env(
    cmd: &mut Command,
    restricted_env_overrides: &mut HashMap<String, String>,
) {
    // Windows AppContainer 不能在普通权限下访问 127.0.0.1 本机代理。
    // 这里只服务 legacy AppContainer direct / hard-isolated 分支；默认受控联网
    // audit 路径已经走本机文件空间 + broker-preferred 会话。
    for (key, value) in appcontainer_direct_network_env_overrides() {
        set_command_env(cmd, restricted_env_overrides, key, value);
    }
}

fn broker_only_requested(user_env: Option<&HashMap<String, String>>) -> bool {
    user_env
        .and_then(|env| {
            env.get("AGENTVIS_BROKER_MODE")
                .or_else(|| env.get("AGENTVIS_NETWORK_BROKER_MODE"))
        })
        .map(|value| matches!(value.as_str(), "explicit" | "required"))
        .unwrap_or(false)
}

fn network_proxy_env_overrides(
    proxy_url_with_credentials: &str,
    browser_proxy_server: &str,
    proxy_username: &str,
    proxy_password: &str,
) -> Vec<(&'static str, String)> {
    vec![
        ("HTTP_PROXY", proxy_url_with_credentials.to_string()),
        ("HTTPS_PROXY", proxy_url_with_credentials.to_string()),
        ("ALL_PROXY", proxy_url_with_credentials.to_string()),
        ("http_proxy", proxy_url_with_credentials.to_string()),
        ("https_proxy", proxy_url_with_credentials.to_string()),
        ("all_proxy", proxy_url_with_credentials.to_string()),
        ("NO_PROXY", String::new()),
        ("no_proxy", String::new()),
        ("npm_config_proxy", proxy_url_with_credentials.to_string()),
        (
            "npm_config_https_proxy",
            proxy_url_with_credentials.to_string(),
        ),
        ("npm_config_noproxy", String::new()),
        ("NPM_CONFIG_PROXY", proxy_url_with_credentials.to_string()),
        (
            "NPM_CONFIG_HTTPS_PROXY",
            proxy_url_with_credentials.to_string(),
        ),
        ("NPM_CONFIG_NOPROXY", String::new()),
        ("PIP_PROXY", proxy_url_with_credentials.to_string()),
        ("GIT_CONFIG_COUNT", "2".to_string()),
        ("GIT_CONFIG_KEY_0", "http.proxy".to_string()),
        ("GIT_CONFIG_VALUE_0", proxy_url_with_credentials.to_string()),
        ("GIT_CONFIG_KEY_1", "https.proxy".to_string()),
        ("GIT_CONFIG_VALUE_1", proxy_url_with_credentials.to_string()),
        (
            "AGENTVIS_BROWSER_PROXY_SERVER",
            browser_proxy_server.to_string(),
        ),
        (
            "AGENTVIS_BROWSER_PROXY_USERNAME",
            proxy_username.to_string(),
        ),
        (
            "AGENTVIS_BROWSER_PROXY_PASSWORD",
            proxy_password.to_string(),
        ),
        ("AGENTVIS_NETWORK_PROXY_MODE", "broker".to_string()),
        (
            "AGENTVIS_NETWORK_PROXY_URL",
            proxy_url_with_credentials.to_string(),
        ),
        (
            "AGENTVIS_NETWORK_PROXY_USERNAME",
            proxy_username.to_string(),
        ),
        (
            "AGENTVIS_NETWORK_PROXY_PASSWORD",
            proxy_password.to_string(),
        ),
    ]
}

fn apply_network_proxy_env(
    cmd: &mut Command,
    restricted_env_overrides: &mut HashMap<String, String>,
    proxy_url_with_credentials: &str,
    browser_proxy_server: &str,
    proxy_username: &str,
    proxy_password: &str,
) {
    for (key, value) in network_proxy_env_overrides(
        proxy_url_with_credentials,
        browser_proxy_server,
        proxy_username,
        proxy_password,
    ) {
        set_command_env(cmd, restricted_env_overrides, key, value);
    }
}

fn controlled_browser_proxy_env_overrides(
    values: &NetworkProxyEnvValues,
) -> Vec<(&'static str, String)> {
    vec![
        ("HTTP_PROXY", String::new()),
        ("HTTPS_PROXY", String::new()),
        ("ALL_PROXY", String::new()),
        ("http_proxy", String::new()),
        ("https_proxy", String::new()),
        ("all_proxy", String::new()),
        ("NO_PROXY", "127.0.0.1,localhost,::1".to_string()),
        ("no_proxy", "127.0.0.1,localhost,::1".to_string()),
        ("npm_config_proxy", String::new()),
        ("npm_config_https_proxy", String::new()),
        ("npm_config_noproxy", "127.0.0.1,localhost,::1".to_string()),
        ("NPM_CONFIG_PROXY", String::new()),
        ("NPM_CONFIG_HTTPS_PROXY", String::new()),
        ("NPM_CONFIG_NOPROXY", "127.0.0.1,localhost,::1".to_string()),
        ("PIP_PROXY", String::new()),
        ("GIT_CONFIG_COUNT", "0".to_string()),
        (
            "AGENTVIS_BROWSER_PROXY_SERVER",
            values.browser_proxy_server.clone(),
        ),
        (
            "AGENTVIS_BROWSER_PROXY_USERNAME",
            values.proxy_username.clone(),
        ),
        (
            "AGENTVIS_BROWSER_PROXY_PASSWORD",
            values.proxy_password.clone(),
        ),
        ("AGENTVIS_NETWORK_PROXY_MODE", "broker".to_string()),
        (
            "AGENTVIS_NETWORK_PROXY_URL",
            values.proxy_url_with_credentials.clone(),
        ),
        (
            "AGENTVIS_NETWORK_PROXY_USERNAME",
            values.proxy_username.clone(),
        ),
        (
            "AGENTVIS_NETWORK_PROXY_PASSWORD",
            values.proxy_password.clone(),
        ),
    ]
}

fn apply_controlled_browser_proxy_env_values(
    cmd: &mut Command,
    restricted_env_overrides: &mut HashMap<String, String>,
    values: &NetworkProxyEnvValues,
) {
    for (key, value) in controlled_browser_proxy_env_overrides(values) {
        set_command_env(cmd, restricted_env_overrides, key, value);
    }
}

fn broker_proxy_required_for_network_intent(command: &str, workdir: Option<&str>) -> bool {
    detect_network_intent(command, workdir).is_some()
        && detect_network_proxy_bypass_signal(command, workdir).is_none()
}

fn normalized_shell_token_name(token: &str) -> String {
    let mut name = command_token_name(token);
    for suffix in [".bat", ".cmd"] {
        if let Some(stripped) = name.strip_suffix(suffix) {
            name = stripped.to_string();
        }
    }
    name
}

fn controlled_browser_runtime_command(command: &str) -> Option<ControlledBrowserRuntimeCommand> {
    let tokens = split_command_tokens(command);
    let normalized = tokens
        .iter()
        .map(|token| normalized_shell_token_name(token))
        .collect::<Vec<_>>();

    for (index, name) in normalized.iter().enumerate() {
        if name == "start-chrome-debug" {
            let next = normalized.get(index + 1).map(String::as_str);
            return match next {
                Some("status") => Some(ControlledBrowserRuntimeCommand::Status),
                Some("stop") => Some(ControlledBrowserRuntimeCommand::Stop),
                _ => Some(ControlledBrowserRuntimeCommand::StartOrEnsure),
            };
        }
        if name == "browser-command" {
            let next = normalized.get(index + 1).map(String::as_str);
            if matches!(next, Some("close" | "quit" | "exit")) {
                return Some(ControlledBrowserRuntimeCommand::Stop);
            }
            return Some(ControlledBrowserRuntimeCommand::Control);
        }
    }

    if normalized.iter().any(|name| name == "agent-browser")
        && tokens
            .iter()
            .any(|token| token.eq_ignore_ascii_case("--cdp"))
        && tokens
            .iter()
            .any(|token| token.to_ascii_lowercase().starts_with("agentvis-cdp-"))
    {
        return Some(ControlledBrowserRuntimeCommand::Control);
    }

    if let Some((script_name, next_arg)) = agent_browser_runtime_script_hint(command) {
        let name = normalized_shell_token_name(&script_name);
        let next = next_arg.as_deref().map(normalized_shell_token_name);
        if name == "start-chrome-debug" {
            return match next.as_deref() {
                Some("status") => Some(ControlledBrowserRuntimeCommand::Status),
                Some("stop") => Some(ControlledBrowserRuntimeCommand::Stop),
                _ => Some(ControlledBrowserRuntimeCommand::StartOrEnsure),
            };
        }
        if name == "browser-command" {
            if matches!(next.as_deref(), Some("close" | "quit" | "exit")) {
                return Some(ControlledBrowserRuntimeCommand::Stop);
            }
            return Some(ControlledBrowserRuntimeCommand::Control);
        }
    }

    None
}

fn browser_runtime_exception_allowed(
    sandbox_policy: &ShellSandboxPolicy,
    browser_command: Option<ControlledBrowserRuntimeCommand>,
) -> bool {
    browser_command.is_some() && sandbox_policy.uses_broker_preferred_network_guard()
}

fn persistent_controlled_browser_proxy_env() -> Option<NetworkProxyEnvValues> {
    controlled_browser_network_sessions()
        .lock()
        .ok()
        .and_then(|sessions| {
            sessions
                .get(CONTROLLED_BROWSER_SESSION_KEY)
                .and_then(NetworkRuntimeSession::proxy_env_values)
        })
}

fn store_controlled_browser_network_session(session: NetworkRuntimeSession) {
    if let Ok(mut sessions) = controlled_browser_network_sessions().lock() {
        sessions.insert(CONTROLLED_BROWSER_SESSION_KEY.to_string(), session);
    }
}

fn clear_controlled_browser_network_session() {
    if let Ok(mut sessions) = controlled_browser_network_sessions().lock() {
        sessions.remove(CONTROLLED_BROWSER_SESSION_KEY);
    }
}

fn broker_unused_diagnostic_detail(
    command: &str,
    workdir: Option<&str>,
    stdout: &str,
    stderr: &str,
) -> String {
    let network_intent =
        detect_network_intent(command, workdir).unwrap_or_else(|| "unknown".to_string());
    let first_token = first_shell_token_file_stem(command).unwrap_or_else(|| "unknown".to_string());
    let reason_class = broker_unused_reason_class(
        command,
        workdir,
        &network_intent,
        &first_token,
        stdout,
        stderr,
    );

    format!(
        "reasonCode=broker_proxy_expected_but_unused; reasonClass={}; networkIntent={}; firstToken={}; brokerRequests=0; exitCode=0; stdoutBytes={}; stderrBytes={}",
        reason_class,
        audit_token_value(&network_intent),
        audit_token_value(&first_token),
        stdout.len(),
        stderr.len()
    )
}

fn broker_unused_reason_class(
    command: &str,
    _workdir: Option<&str>,
    network_intent: &str,
    first_token: &str,
    stdout: &str,
    stderr: &str,
) -> &'static str {
    let command_lower = command.to_ascii_lowercase();
    if network_intent == "url_literal"
        && !is_likely_proxy_aware_network_executor(first_token, &command_lower)
    {
        return "tool_misclassification";
    }

    if output_suggests_package_cache_hit(stdout, stderr) {
        return "cache_hit_likely";
    }

    if is_likely_proxy_aware_network_executor(first_token, &command_lower) {
        return "potential_direct_egress";
    }

    "tool_misclassification"
}

fn is_likely_proxy_aware_network_executor(first_token: &str, command_lower: &str) -> bool {
    matches!(
        first_token,
        "curl"
            | "wget"
            | "git"
            | "npm"
            | "npx"
            | "pnpm"
            | "yarn"
            | "bun"
            | "pip"
            | "pip3"
            | "uv"
            | "python"
            | "py"
            | "node"
            | "playwright"
    ) || command_lower.contains("invoke-webrequest")
        || command_lower.contains("invoke-restmethod")
        || command_lower.contains(" iwr ")
        || command_lower.starts_with("iwr ")
        || command_lower.contains(" irm ")
        || command_lower.starts_with("irm ")
}

fn output_suggests_package_cache_hit(stdout: &str, stderr: &str) -> bool {
    let combined = format!("{}\n{}", stdout, stderr).to_ascii_lowercase();
    [
        "cache",
        "cached",
        "already satisfied",
        "already installed",
        "already up to date",
        "already up-to-date",
        "up to date",
    ]
    .iter()
    .any(|pattern| combined.contains(pattern))
}

fn audit_token_value(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | ':' | '/') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn broker_fetch_helper_file_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "agentvis-broker-fetch.exe"
    } else {
        "agentvis-broker-fetch"
    }
}

fn wfp_helper_file_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "agentvis_wfp_helper.exe"
    } else {
        "agentvis_wfp_helper"
    }
}

fn broker_fetch_helper_source_path() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|path| {
        path.parent()
            .map(|parent| parent.join(broker_fetch_helper_file_name()))
    })
}

fn broker_fetch_helper_resource_candidates(resource_dir: &Path) -> Vec<PathBuf> {
    vec![
        resource_dir
            .join("bin")
            .join(broker_fetch_helper_file_name()),
        resource_dir
            .join("broker-bin")
            .join(broker_fetch_helper_file_name()),
        resource_dir
            .join("target")
            .join("release")
            .join(broker_fetch_helper_file_name()),
        resource_dir
            .join("target")
            .join("debug")
            .join(broker_fetch_helper_file_name()),
    ]
}

fn wfp_helper_resource_candidates(resource_dir: &Path) -> Vec<PathBuf> {
    vec![
        resource_dir.join("bin").join(wfp_helper_file_name()),
        resource_dir.join("broker-bin").join(wfp_helper_file_name()),
        resource_dir
            .join("target")
            .join("release")
            .join(wfp_helper_file_name()),
        resource_dir
            .join("target")
            .join("debug")
            .join(wfp_helper_file_name()),
    ]
}

fn broker_fetch_helper_source_paths(app_handle: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(path) = broker_fetch_helper_source_path() {
        paths.push(path);
    }
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        paths.extend(broker_fetch_helper_resource_candidates(&resource_dir));
    }
    paths
}

fn wfp_helper_source_path() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|path| {
        path.parent()
            .map(|parent| parent.join(wfp_helper_file_name()))
    })
}

fn wfp_helper_source_paths(app_handle: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(path) = wfp_helper_source_path() {
        paths.push(path);
    }
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        paths.extend(wfp_helper_resource_candidates(&resource_dir));
    }
    paths
}

fn broker_fetch_helper_needs_refresh(source: &Path, managed_helper: &Path) -> bool {
    if !managed_helper.exists() {
        return true;
    }

    let Ok(source_meta) = std::fs::metadata(source) else {
        return false;
    };
    let Ok(managed_meta) = std::fs::metadata(managed_helper) else {
        return true;
    };

    if source_meta.len() != managed_meta.len() {
        return true;
    }

    match (source_meta.modified(), managed_meta.modified()) {
        (Ok(source_modified), Ok(managed_modified)) => source_modified > managed_modified,
        _ => false,
    }
}

fn prepare_broker_fetch_helper(
    app_handle: &tauri::AppHandle,
    app_data_dir: &Path,
) -> CommandResult<PathBuf> {
    let helper_dir = app_data_dir.join("runtime").join("bin");
    std::fs::create_dir_all(&helper_dir).map_err(|error| {
        AppError::FileSystem(format!(
            "Failed to prepare broker helper directory {}: {}",
            helper_dir.display(),
            error
        ))
    })?;
    let managed_helper = helper_dir.join(broker_fetch_helper_file_name());

    if let Some(source) = broker_fetch_helper_source_paths(app_handle)
        .into_iter()
        .find(|path| path.exists())
    {
        if broker_fetch_helper_needs_refresh(&source, &managed_helper) {
            std::fs::copy(&source, &managed_helper).map_err(|error| {
                AppError::FileSystem(format!(
                    "Failed to copy broker helper {} -> {}: {}",
                    source.display(),
                    managed_helper.display(),
                    error
                ))
            })?;
        }
        return Ok(managed_helper);
    }

    if managed_helper.exists() {
        return Ok(managed_helper);
    }

    Err(AppError::NotFound(format!(
        "Broker helper executable '{}' was not found next to the AgentVis executable or in bundled resources.",
        broker_fetch_helper_file_name()
    )))
}

fn prepare_wfp_helper(
    app_handle: &tauri::AppHandle,
    app_data_dir: &Path,
) -> CommandResult<PathBuf> {
    let helper_dir = app_data_dir.join("runtime").join("bin");
    std::fs::create_dir_all(&helper_dir).map_err(|error| {
        AppError::FileSystem(format!(
            "Failed to prepare WFP helper directory {}: {}",
            helper_dir.display(),
            error
        ))
    })?;
    let managed_helper = helper_dir.join(wfp_helper_file_name());

    if let Some(source) = wfp_helper_source_paths(app_handle)
        .into_iter()
        .find(|path| path.exists())
    {
        if broker_fetch_helper_needs_refresh(&source, &managed_helper) {
            std::fs::copy(&source, &managed_helper).map_err(|error| {
                AppError::FileSystem(format!(
                    "Failed to copy WFP helper {} -> {}: {}",
                    source.display(),
                    managed_helper.display(),
                    error
                ))
            })?;
        }
        return Ok(managed_helper);
    }

    if managed_helper.exists() {
        return Ok(managed_helper);
    }

    Err(AppError::NotFound(format!(
        "WFP helper executable '{}' was not found next to the AgentVis executable or in bundled resources.",
        wfp_helper_file_name()
    )))
}

fn truncate_audit_detail(value: impl AsRef<str>) -> String {
    const MAX_DETAIL_CHARS: usize = 280;
    let value = value.as_ref().trim();
    if value.chars().count() <= MAX_DETAIL_CHARS {
        return value.to_string();
    }

    let mut truncated = value.chars().take(MAX_DETAIL_CHARS).collect::<String>();
    truncated.push_str("...");
    truncated
}

fn parse_wfp_inspect_readiness(stdout: &str) -> WfpGuardReadiness {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(stdout) else {
        return WfpGuardReadiness {
            ready: false,
            reason: "wfp_helper_inspect_parse_failed",
            detail: Some(truncate_audit_detail(stdout)),
        };
    };

    let ok = value
        .get("ok")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if !ok {
        let error_kind = value
            .get("errorKind")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        let message = value
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown WFP helper inspect failure");
        return WfpGuardReadiness {
            ready: false,
            reason: "wfp_helper_inspect_failed",
            detail: Some(truncate_audit_detail(format!(
                "errorKind={}; message={}",
                error_kind, message
            ))),
        };
    }

    let residual = value
        .pointer("/cleanup/residualFiltersDetected")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
        || value
            .pointer("/inspect/residualFiltersDetected")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
    let filters_detected = value
        .pointer("/inspect/filtersDetected")
        .and_then(|value| value.as_array())
        .map(|values| values.len())
        .unwrap_or(0);
    let detail = Some(format!(
        "inspect=ok; residualFiltersDetected={}; filtersDetected={}",
        residual, filters_detected
    ));

    if residual {
        return WfpGuardReadiness {
            ready: false,
            reason: "wfp_helper_inspect_residual_detected",
            detail,
        };
    }

    WfpGuardReadiness {
        ready: true,
        reason: "wfp_helper_inspect_ready",
        detail,
    }
}

async fn inspect_wfp_guard_readiness(
    app_handle: &tauri::AppHandle,
    app_data_dir: &Path,
) -> WfpGuardReadiness {
    let helper_path = match prepare_wfp_helper(app_handle, app_data_dir) {
        Ok(path) => path,
        Err(error) => {
            return WfpGuardReadiness {
                ready: false,
                reason: "wfp_helper_unavailable",
                detail: Some(truncate_audit_detail(error.to_string())),
            };
        }
    };

    let mut command = Command::new(helper_path);
    command
        .arg("inspect")
        .arg("--json")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    match timeout(
        Duration::from_secs(WFP_HELPER_INSPECT_TIMEOUT_SECS),
        command.output(),
    )
    .await
    {
        Ok(Ok(output)) if output.status.success() => {
            parse_wfp_inspect_readiness(&String::from_utf8_lossy(&output.stdout))
        }
        Ok(Ok(output)) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            WfpGuardReadiness {
                ready: false,
                reason: "wfp_helper_inspect_process_failed",
                detail: Some(truncate_audit_detail(format!(
                    "status={:?}; stderr={}",
                    output.status.code(),
                    stderr
                ))),
            }
        }
        Ok(Err(error)) => WfpGuardReadiness {
            ready: false,
            reason: "wfp_helper_inspect_spawn_failed",
            detail: Some(truncate_audit_detail(error.to_string())),
        },
        Err(_) => WfpGuardReadiness {
            ready: false,
            reason: "wfp_helper_inspect_timeout",
            detail: Some(format!(
                "timeoutSeconds={}",
                WFP_HELPER_INSPECT_TIMEOUT_SECS
            )),
        },
    }
}

async fn cleanup_wfp_guard_residual(
    app_handle: &tauri::AppHandle,
    app_data_dir: &Path,
) -> WfpGuardReadiness {
    let helper_path = match prepare_wfp_helper(app_handle, app_data_dir) {
        Ok(path) => path,
        Err(error) => {
            return WfpGuardReadiness {
                ready: false,
                reason: "wfp_helper_cleanup_unavailable",
                detail: Some(truncate_audit_detail(error.to_string())),
            };
        }
    };

    let mut command = Command::new(helper_path);
    command
        .arg("cleanup")
        .arg("--confirm-agentvis-wfp-cleanup")
        .arg("--json")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    match timeout(
        Duration::from_secs(WFP_HELPER_INSPECT_TIMEOUT_SECS),
        command.output(),
    )
    .await
    {
        Ok(Ok(output)) if output.status.success() => WfpGuardReadiness {
            ready: true,
            reason: "wfp_helper_residual_cleanup_completed",
            detail: Some(truncate_audit_detail(String::from_utf8_lossy(
                &output.stdout,
            ))),
        },
        Ok(Ok(output)) => WfpGuardReadiness {
            ready: false,
            reason: "wfp_helper_residual_cleanup_failed",
            detail: Some(truncate_audit_detail(format!(
                "status={:?}; stderr={}",
                output.status.code(),
                String::from_utf8_lossy(&output.stderr)
            ))),
        },
        Ok(Err(error)) => WfpGuardReadiness {
            ready: false,
            reason: "wfp_helper_residual_cleanup_spawn_failed",
            detail: Some(truncate_audit_detail(error.to_string())),
        },
        Err(_) => WfpGuardReadiness {
            ready: false,
            reason: "wfp_helper_residual_cleanup_timeout",
            detail: Some(format!(
                "timeoutSeconds={}",
                WFP_HELPER_INSPECT_TIMEOUT_SECS
            )),
        },
    }
}

fn record_wfp_canary_event(
    app_handle: &tauri::AppHandle,
    sandbox_policy: &ShellSandboxPolicy,
    command: &str,
    workdir: Option<&str>,
    execution_id: Option<&str>,
    decision: &str,
    reason: &str,
    detail: Option<String>,
    guard_mode: &str,
) {
    let mut event = sandbox_policy.wfp_diagnostic_audit_event(
        command,
        workdir,
        execution_id,
        decision,
        reason,
        detail,
    );
    event.guard_mode = Some(guard_mode.to_string());
    record_sandbox_audit_event(app_handle, event);
}

fn wfp_canary_task_category(
    command: &str,
    workdir: Option<&str>,
    user_env: Option<&HashMap<String, String>>,
    effective_background: bool,
    network_intent: &str,
) -> String {
    if effective_background {
        return "background".to_string();
    }
    if let Some(signal) = detect_network_proxy_bypass_signal(command, workdir) {
        return format!("proxyBypass:{}", signal.kind);
    }
    let command_lower = command.to_ascii_lowercase();
    let browser_task = wfp_canary_is_browser_task(&command_lower, network_intent);
    let first_token = first_shell_token_file_stem(command).unwrap_or_else(|| "unknown".to_string());
    match first_token.as_str() {
        "curl" => "curl".to_string(),
        "git" => "git".to_string(),
        "npx" if browser_task => "browser".to_string(),
        "npm" | "npx" => "npm".to_string(),
        "pip" | "pip3" | "uv" => "pythonPackage".to_string(),
        "node" => {
            if browser_task {
                "browser".to_string()
            } else {
                "node".to_string()
            }
        }
        "python" | "python3" | "py" => {
            if wfp_proxy_preferred_fallback_allowed(command, workdir, user_env) {
                "pythonBrokerProxyPreferred".to_string()
            } else {
                "pythonUnknown".to_string()
            }
        }
        _ => {
            if browser_task {
                "browser".to_string()
            } else {
                "other".to_string()
            }
        }
    }
}

fn wfp_canary_is_browser_task(command_lower: &str, network_intent: &str) -> bool {
    let intent_lower = network_intent.to_ascii_lowercase();
    [
        "playwright",
        "chromium",
        "chrome",
        "browser",
        "agentvis-cdp",
        "start-chrome-debug",
        "browser-command",
    ]
    .iter()
    .any(|pattern| command_lower.contains(pattern) || intent_lower.contains(pattern))
}

fn wfp_canary_preflight_detail(
    command: &str,
    workdir: Option<&str>,
    user_env: Option<&HashMap<String, String>>,
    effective_background: bool,
    network_intent: &str,
    readiness: &WfpGuardReadiness,
    eligible_command: Option<&str>,
) -> String {
    format!(
        "networkIntent={}; ready={}; readyReason={}; eligibleFirstToken={}; fallbackAllowed={}; background={}; taskCategory={}; source=staticIntent",
        network_intent,
        readiness.ready,
        readiness.reason,
        eligible_command.unwrap_or("none"),
        wfp_proxy_preferred_fallback_allowed(command, workdir, user_env),
        effective_background,
        wfp_canary_task_category(
            command,
            workdir,
            user_env,
            effective_background,
            network_intent
        )
    )
}

async fn record_wfp_canary_preflight(
    app_handle: &tauri::AppHandle,
    app_data_dir: &Path,
    sandbox_policy: &ShellSandboxPolicy,
    command: &str,
    workdir: Option<&str>,
    execution_id: Option<&str>,
    effective_background: bool,
    user_env: Option<&HashMap<String, String>>,
) -> Option<WfpCanaryObservation> {
    let network_intent = detect_network_intent(command, workdir)?;

    let mut readiness = inspect_wfp_guard_readiness(app_handle, app_data_dir).await;
    record_wfp_canary_event(
        app_handle,
        sandbox_policy,
        command,
        workdir,
        execution_id,
        "diagnostic",
        "wfp_canary_readiness",
        readiness.detail.clone().or_else(|| {
            Some(format!(
                "ready={}; reason={}",
                readiness.ready, readiness.reason
            ))
        }),
        "auditOnly",
    );
    if !readiness.ready && readiness.reason == "wfp_helper_inspect_residual_detected" {
        let cleanup = cleanup_wfp_guard_residual(app_handle, app_data_dir).await;
        let cleanup_detail = cleanup
            .detail
            .clone()
            .unwrap_or_else(|| format!("ready={}; reason={}", cleanup.ready, cleanup.reason));
        record_wfp_canary_event(
            app_handle,
            sandbox_policy,
            command,
            workdir,
            execution_id,
            "diagnostic",
            "wfp_canary_cleanup",
            Some(format!(
                "{}; taskCategory=cleanup; source=wfpInspect",
                cleanup_detail
            )),
            "auditOnly",
        );
        if cleanup.ready {
            readiness = inspect_wfp_guard_readiness(app_handle, app_data_dir).await;
        }
    }

    let eligible_command = wfp_managed_egress_command_name(command);
    let task_category = wfp_canary_task_category(
        command,
        workdir,
        user_env,
        effective_background,
        &network_intent,
    );
    let detail = wfp_canary_preflight_detail(
        command,
        workdir,
        user_env,
        effective_background,
        &network_intent,
        &readiness,
        eligible_command.as_deref(),
    );
    let (reason, guard_mode) = if !readiness.ready {
        ("wfp_canary_unavailable", "auditOnly")
    } else if eligible_command.is_some() && !effective_background {
        ("wfp_canary_direct_egress_observed", "wouldBlock")
    } else {
        ("wfp_canary_no_direct_egress", "auditOnly")
    };
    record_wfp_canary_event(
        app_handle,
        sandbox_policy,
        command,
        workdir,
        execution_id,
        "audit",
        reason,
        Some(detail),
        guard_mode,
    );

    Some(WfpCanaryObservation {
        network_intent,
        eligible_command,
        task_category,
    })
}

fn record_wfp_canary_actual_result(
    app_handle: &tauri::AppHandle,
    sandbox_policy: &ShellSandboxPolicy,
    command: &str,
    workdir: Option<&str>,
    execution_id: Option<&str>,
    observation: Option<&WfpCanaryObservation>,
    outcome: &str,
    exit_code: Option<i32>,
) {
    let Some(observation) = observation else {
        return;
    };
    if observation.eligible_command.is_some() {
        record_wfp_canary_event(
            app_handle,
            sandbox_policy,
            command,
            workdir,
            execution_id,
            "audit",
            "wfp_canary_session_stop_would_block",
            Some(format!(
                "networkIntent={}; eligibleFirstToken={}; taskCategory={}; outcome={}",
                observation.network_intent,
                observation.eligible_command.as_deref().unwrap_or("none"),
                observation.task_category,
                outcome
            )),
            "wouldBlock",
        );
    }
    record_wfp_canary_event(
        app_handle,
        sandbox_policy,
        command,
        workdir,
        execution_id,
        "diagnostic",
        "wfp_canary_actual_result",
        Some(format!(
            "networkIntent={}; eligibleFirstToken={}; taskCategory={}; outcome={}; exitCode={}",
            observation.network_intent,
            observation.eligible_command.as_deref().unwrap_or("none"),
            observation.task_category,
            outcome,
            exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "none".to_string())
        )),
        "auditOnly",
    );
}

fn wfp_managed_egress_command_name(command: &str) -> Option<String> {
    let token = first_shell_token(command)?;
    let token_path = Path::new(&token);
    if token_path.components().count() != 1 {
        return None;
    }

    let file_stem = token_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(token.as_str())
        .to_ascii_lowercase();
    match file_stem.as_str() {
        "curl" | "node" | "git" | "npm" | "npx" | "pip" | "pip3" | "uv" => Some(file_stem),
        _ => None,
    }
}

fn first_shell_token_file_stem(command: &str) -> Option<String> {
    let token = first_shell_token(command)?;
    let normalized = token.replace('\\', "/");
    let file_name = normalized.rsplit('/').next().unwrap_or(normalized.as_str());
    let without_exe = file_name
        .strip_suffix(".exe")
        .or_else(|| file_name.strip_suffix(".EXE"))
        .unwrap_or(file_name);
    let stem = without_exe
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(without_exe);
    (!stem.is_empty()).then(|| stem.to_ascii_lowercase())
}

fn proxy_preferred_fallback_env_requested(user_env: Option<&HashMap<String, String>>) -> bool {
    user_env
        .and_then(|env| {
            env.get("AGENTVIS_NETWORK_EGRESS_GUARD_FALLBACK")
                .or_else(|| env.get("AGENTVIS_NETWORK_PROXY_FALLBACK"))
        })
        .map(|value| {
            matches!(
                value.trim(),
                "brokerProxyPreferred" | "broker-proxy-preferred" | "broker_proxy_preferred"
            )
        })
        .unwrap_or(false)
}

fn frontmatter_network_value_is_proxy_preferred(value: &str) -> bool {
    let value = value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_ascii_lowercase();
    matches!(
        value.as_str(),
        "brokerproxypreferred"
            | "broker-proxy-preferred"
            | "broker_proxy_preferred"
            | "httpproxy"
            | "http-proxy"
            | "http_proxy"
    )
}

fn normalize_skill_entry_path(entry: &str) -> String {
    entry
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .replace('\\', "/")
        .trim_start_matches("./")
        .replace("//", "/")
}

fn skill_frontmatter_allows_proxy_preferred(content: &str, entry: Option<&str>) -> bool {
    let normalized = content.replace("\r\n", "\n");
    let mut lines = normalized.lines();
    if !matches!(lines.next().map(str::trim), Some("---")) {
        return false;
    }

    let requested_entry = entry.map(normalize_skill_entry_path);
    let mut in_entrypoints = false;
    for line in lines {
        let indent = line.len() - line.trim_start().len();
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if in_entrypoints && indent > 0 {
            if requested_entry.as_deref() == Some(normalize_skill_entry_path(key).as_str())
                && frontmatter_network_value_is_proxy_preferred(value)
            {
                return true;
            }
            continue;
        }
        in_entrypoints = false;
        if !matches!(
            key,
            "agentvisNetwork"
                | "agentvis_network"
                | "networkTransport"
                | "network_transport"
                | "agentvisNetworkEntrypoints"
                | "agentvis_network_entrypoints"
        ) {
            continue;
        }
        if matches!(
            key,
            "agentvisNetworkEntrypoints" | "agentvis_network_entrypoints"
        ) && value.trim().is_empty()
        {
            in_entrypoints = true;
            continue;
        }
        if key != "agentvisNetworkEntrypoints"
            && key != "agentvis_network_entrypoints"
            && frontmatter_network_value_is_proxy_preferred(value)
        {
            return true;
        }
    }

    false
}

fn external_skill_root_from_normalized_path(path: &str) -> Option<PathBuf> {
    let lower = path.to_ascii_lowercase();
    for marker in ["/skills/external/packages/", "/skills-bundle/"] {
        let Some(marker_index) = lower.find(marker) else {
            continue;
        };
        let skill_start = marker_index + marker.len();
        let rest = &path[skill_start..];
        let skill_end = rest.find('/').unwrap_or(rest.len());
        if skill_end == 0 {
            continue;
        }
        return Some(PathBuf::from(&path[..skill_start + skill_end]));
    }

    None
}

fn split_shell_tokens_for_manifest(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;

    for ch in command.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => current.push(ch),
            None if ch == '"' || ch == '\'' => quote = Some(ch),
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

fn proxy_preferred_script_candidates(command: &str, workdir: Option<&str>) -> Vec<PathBuf> {
    let normalized_workdir = workdir.map(|value| value.replace('\\', "/"));
    let mut candidates = Vec::new();

    for token in split_shell_tokens_for_manifest(command) {
        let normalized_token = token.replace('\\', "/");
        let lower = normalized_token.to_ascii_lowercase();
        if ![".py", ".js", ".mjs", ".cjs", ".ps1"]
            .iter()
            .any(|extension| lower.ends_with(extension))
        {
            continue;
        }
        candidates.push(PathBuf::from(&normalized_token));
        if let Some(workdir) = normalized_workdir.as_deref() {
            candidates.push(PathBuf::from(format!(
                "{}/{}",
                workdir.trim_end_matches('/'),
                normalized_token.trim_start_matches('/')
            )));
        }
    }

    candidates
}

fn proxy_preferred_script_is_http_compatible(command: &str, workdir: Option<&str>) -> bool {
    const NON_HTTP_NETWORK_PATTERNS: &[&str] = &[
        "import imaplib",
        "from imaplib import",
        "imaplib.",
        "import smtplib",
        "from smtplib import",
        "smtplib.",
        "import ftplib",
        "from ftplib import",
        "ftplib.",
        "import paramiko",
        "from paramiko import",
        "import socket",
        "from socket import",
        "socket.socket",
        "socket.create_connection",
    ];

    let mut inspected_script = false;
    for candidate in proxy_preferred_script_candidates(command, workdir) {
        let Ok(content) = std::fs::read_to_string(&candidate) else {
            continue;
        };
        inspected_script = true;
        let lower = content.to_ascii_lowercase();
        if NON_HTTP_NETWORK_PATTERNS
            .iter()
            .any(|pattern| lower.contains(pattern))
        {
            return false;
        }
    }

    inspected_script
}

fn proxy_preferred_skill_manifest_requested(command: &str, workdir: Option<&str>) -> bool {
    let mut candidates = Vec::new();
    let normalized_workdir = workdir.map(|value| value.replace('\\', "/"));
    if let Some(workdir) = normalized_workdir.as_deref() {
        candidates.push(workdir.to_string());
    }

    for token in split_shell_tokens_for_manifest(command) {
        let normalized_token = token.replace('\\', "/");
        candidates.push(normalized_token.clone());
        if let Some(workdir) = normalized_workdir.as_deref() {
            candidates.push(format!(
                "{}/{}",
                workdir.trim_end_matches('/'),
                normalized_token.trim_start_matches('/')
            ));
        }
    }

    let manifest_requested = candidates.iter().any(|candidate| {
        let Some(root) = external_skill_root_from_normalized_path(candidate) else {
            return false;
        };
        let root_normalized = root.to_string_lossy().replace('\\', "/");
        let entry = candidate
            .strip_prefix(root_normalized.trim_end_matches('/'))
            .map(|value| value.trim_start_matches('/'))
            .filter(|value| !value.is_empty());
        std::fs::read_to_string(root.join("SKILL.md"))
            .map(|content| skill_frontmatter_allows_proxy_preferred(&content, entry))
            .unwrap_or(false)
    });

    manifest_requested && proxy_preferred_script_is_http_compatible(command, workdir)
}

fn wfp_proxy_preferred_fallback_allowed(
    command: &str,
    workdir: Option<&str>,
    user_env: Option<&HashMap<String, String>>,
) -> bool {
    let Some(file_stem) = first_shell_token_file_stem(command) else {
        return false;
    };
    if !matches!(file_stem.as_str(), "python" | "python3" | "py") {
        return false;
    }

    (proxy_preferred_fallback_env_requested(user_env)
        || proxy_preferred_skill_manifest_requested(command, workdir))
        && proxy_preferred_script_is_http_compatible(command, workdir)
}

fn first_shell_token(command: &str) -> Option<String> {
    let command = command.trim_start();
    if command.is_empty() {
        return None;
    }

    let mut chars = command.chars();
    if matches!(chars.next(), Some('"')) {
        let mut token = String::new();
        let mut escaped = false;
        for ch in chars {
            if escaped {
                if ch == '"' || ch == '\\' {
                    token.push(ch);
                } else {
                    token.push('\\');
                    token.push(ch);
                }
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            if ch == '"' {
                return (!token.trim().is_empty()).then_some(token);
            }
            token.push(ch);
        }
        if escaped {
            token.push('\\');
        }
        return None;
    }

    command
        .split_whitespace()
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(target_os = "windows")]
fn resolve_wfp_managed_egress_source_exe(
    command_name: &str,
    app_data_dir: &Path,
    user_env: Option<&HashMap<String, String>>,
) -> Option<PathBuf> {
    let path_value = user_env
        .and_then(|env| env.get("PATH").cloned())
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&path_value).collect();

    let app_data_path = app_data_dir.to_path_buf();
    if let Some(node_dir) = super::embedded_node_setup::get_embedded_node_bin_dir(&app_data_path) {
        dirs.push(PathBuf::from(node_dir));
    }
    dirs.extend(discover_extra_tool_paths().into_iter().map(PathBuf::from));

    let candidates = [format!("{command_name}.exe"), command_name.to_string()];
    dirs.into_iter()
        .flat_map(|dir| candidates.iter().map(move |name| dir.join(name)))
        .find(|path| path.is_file())
}

#[cfg(not(target_os = "windows"))]
fn resolve_wfp_managed_egress_source_exe(
    _command_name: &str,
    _app_data_dir: &Path,
    _user_env: Option<&HashMap<String, String>>,
) -> Option<PathBuf> {
    None
}

fn prepare_wfp_managed_egress_executable(
    app_data_dir: &Path,
    command: &str,
    user_env: Option<&HashMap<String, String>>,
) -> CommandResult<Option<WfpManagedEgressExecutable>> {
    let Some(command_name) = wfp_managed_egress_command_name(command) else {
        return Ok(None);
    };
    let Some(source_exe) =
        resolve_wfp_managed_egress_source_exe(&command_name, app_data_dir, user_env)
    else {
        return Ok(None);
    };

    let managed_root = app_data_dir.join("runtime").join("egress-guard");
    let managed_dir = managed_root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&managed_dir).map_err(|error| {
        AppError::FileSystem(format!(
            "Failed to prepare WFP managed egress directory {}: {}",
            managed_dir.display(),
            error
        ))
    })?;
    std::fs::write(managed_dir.join(WFP_MANAGED_EGRESS_MARKER), b"managed\n").map_err(|error| {
        let _ = std::fs::remove_dir_all(&managed_dir);
        AppError::FileSystem(format!(
            "Failed to write WFP managed egress marker in {}: {}",
            managed_dir.display(),
            error
        ))
    })?;

    let managed_exe = managed_dir.join(
        source_exe
            .file_name()
            .unwrap_or_else(|| std::ffi::OsStr::new("managed-egress.exe")),
    );
    std::fs::copy(&source_exe, &managed_exe).map_err(|error| {
        let _ = std::fs::remove_dir_all(&managed_dir);
        AppError::FileSystem(format!(
            "Failed to copy WFP managed egress executable {} -> {}: {}",
            source_exe.display(),
            managed_exe.display(),
            error
        ))
    })?;

    Ok(Some(WfpManagedEgressExecutable {
        command_name,
        source_exe,
        managed_dir,
        managed_exe,
    }))
}

fn wfp_managed_egress_audit_detail(plan: &WfpManagedEgressExecutable) -> String {
    format!(
        "command={}; sourceExe={}; managedExe={}",
        plan.command_name,
        plan.source_exe.display(),
        plan.managed_exe.display()
    )
}

async fn start_wfp_managed_egress_guard_session(
    app_handle: &tauri::AppHandle,
    app_data_dir: &Path,
    plan: &WfpManagedEgressExecutable,
    timeout_duration: Duration,
    allowed_loopback_port: Option<u16>,
) -> Result<WfpManagedEgressGuardSession, AppError> {
    let helper_path = match prepare_wfp_helper(app_handle, app_data_dir) {
        Ok(path) => path,
        Err(error) => {
            cleanup_wfp_managed_egress_dir(plan);
            return Err(error);
        }
    };
    let ready_file = plan.managed_dir.join("wfp-ready.txt");
    let _ = std::fs::remove_file(&ready_file);
    let timeout_ms = timeout_duration
        .as_millis()
        .saturating_add(u128::from(WFP_MANAGED_EGRESS_TIMEOUT_GRACE_MS))
        .min(u128::from(u64::MAX)) as u64;

    let mut command = Command::new(helper_path);
    command
        .arg("probe")
        .arg("--exe")
        .arg(&plan.managed_exe)
        .arg("--allow-agentvis-managed-exe")
        .arg("--timeout-ms")
        .arg(timeout_ms.to_string())
        .arg("--ready-file")
        .arg(&ready_file);
    if let Some(port) = allowed_loopback_port {
        command.arg("--allow-loopback-port").arg(port.to_string());
    }
    command
        .arg("--json")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            cleanup_wfp_managed_egress_dir(plan);
            return Err(AppError::Generic(format!(
                "Failed to start WFP managed egress guard helper: {}",
                error
            )));
        }
    };
    let ready_deadline =
        tokio::time::Instant::now() + Duration::from_secs(WFP_HELPER_READY_TIMEOUT_SECS);
    loop {
        if ready_file.is_file() {
            return Ok(WfpManagedEgressGuardSession {
                child,
                managed_dir: plan.managed_dir.clone(),
                managed_exe: plan.managed_exe.clone(),
                allowed_loopback_port,
            });
        }
        if let Ok(Some(status)) = child.try_wait() {
            cleanup_wfp_managed_egress_dir(plan);
            return Err(AppError::Forbidden(format!(
                "Sandbox block: WFP managed egress guard helper exited before ready signal: {:?}",
                status.code()
            )));
        }
        if tokio::time::Instant::now() >= ready_deadline {
            let _ = child.kill().await;
            let _ = child.wait().await;
            cleanup_wfp_managed_egress_dir(plan);
            return Err(AppError::Forbidden(format!(
                "Sandbox block: WFP managed egress guard helper did not become ready within {}s.",
                WFP_HELPER_READY_TIMEOUT_SECS
            )));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

impl WfpManagedEgressGuardSession {
    fn audit_detail(&self) -> String {
        format!(
            "managedExe={}; allowedLoopbackPort={}",
            self.managed_exe.display(),
            self.allowed_loopback_port
                .map(|port| port.to_string())
                .unwrap_or_else(|| "none".to_string())
        )
    }

    async fn stop(mut self) -> String {
        let process_state = if let Ok(Some(_)) = self.child.try_wait() {
            "exited"
        } else {
            let _ = self.child.kill().await;
            let _ = self.child.wait().await;
            "killed"
        };
        let cleanup = match std::fs::remove_dir_all(&self.managed_dir) {
            Ok(()) => "clean".to_string(),
            Err(error) => {
                log::debug!(
                    "[Shell] failed to cleanup WFP managed egress dir {}: {}",
                    self.managed_dir.display(),
                    error
                );
                format!("failed: {}", truncate_audit_detail(error.to_string()))
            }
        };
        format!(
            "process={}; cleanup={}; managedExe={}; allowedLoopbackPort={}",
            process_state,
            cleanup,
            self.managed_exe.display(),
            self.allowed_loopback_port
                .map(|port| port.to_string())
                .unwrap_or_else(|| "none".to_string())
        )
    }
}

fn cleanup_wfp_managed_egress_dir(plan: &WfpManagedEgressExecutable) {
    if let Err(error) = std::fs::remove_dir_all(&plan.managed_dir) {
        log::debug!(
            "[Shell] failed to cleanup WFP managed egress dir {}: {}",
            plan.managed_dir.display(),
            error
        );
    }
}

async fn stop_wfp_managed_guard_session(
    session: &mut Option<WfpManagedEgressGuardSession>,
    app_handle: &tauri::AppHandle,
    sandbox_policy: &ShellSandboxPolicy,
    command: &str,
    workdir: Option<&str>,
    execution_id: Option<&str>,
    outcome: &str,
) {
    if let Some(session) = session.take() {
        let detail = session.stop().await;
        record_sandbox_audit_event(
            app_handle,
            sandbox_policy.wfp_diagnostic_audit_event(
                command,
                workdir,
                execution_id,
                "diagnostic",
                "wfp_managed_egress_session_stopped",
                Some(format!("outcome={}; {}", outcome, detail)),
            ),
        );
    }
}

fn prepend_env_path(
    cmd: &mut Command,
    restricted_env_overrides: &mut HashMap<String, String>,
    path: &Path,
) {
    let existing_path = restricted_env_overrides
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    let separator = if cfg!(target_os = "windows") {
        ";"
    } else {
        ":"
    };
    let path = path.to_string_lossy();
    let value = if existing_path.is_empty() {
        path.to_string()
    } else {
        format!("{}{}{}", path, separator, existing_path)
    };
    set_command_env(cmd, restricted_env_overrides, "PATH", value);
}

async fn prepare_network_broker_session_env(
    cmd: &mut Command,
    restricted_env_overrides: &mut HashMap<String, String>,
    app_handle: &tauri::AppHandle,
    app_data_dir: &Path,
    sandbox_policy: &ShellSandboxPolicy,
    user_env: Option<&HashMap<String, String>>,
    command: &str,
    workdir: Option<&str>,
    execution_id: Option<&str>,
    proxy_required: bool,
    proxy_auth_required: bool,
    credential_policies: Option<&[NetworkBrokerCredentialPolicy]>,
) -> CommandResult<Option<NetworkRuntimeSession>> {
    let broker_only = broker_only_requested(user_env);
    let broker_preferred = sandbox_policy.uses_broker_preferred_network_guard();
    let credential_policies = credential_policies.unwrap_or(&[]);
    if !credential_policies.is_empty() && !broker_only {
        return Err(AppError::Forbidden(
            "Broker credential policies require brokerOnly network mode.".to_string(),
        ));
    }
    if !broker_only && !broker_preferred {
        return Ok(None);
    }

    let sandbox_mode = sandbox_policy.sandbox_mode_event_value().to_string();
    let subject = sandbox_policy
        .network_broker_audit_subject()
        .with_execution_id(execution_id);
    log::debug!(
        "[Shell] preparing network broker session: sandbox_mode={}, mode={}, subject={:?}",
        sandbox_mode,
        if broker_only { "required" } else { "preferred" },
        subject
    );

    let mut file_session = None;
    let mut proxy_session = None;
    let mut broker_helper_unavailable_detail: Option<String> = None;

    if broker_only || broker_preferred {
        let maybe_file_session = start_network_broker_file_session(
            app_handle.clone(),
            app_data_dir,
            Some(sandbox_mode.clone()),
            subject.clone(),
            if broker_only {
                credential_policies.to_vec()
            } else {
                Vec::new()
            },
            workdir.map(PathBuf::from).into_iter().collect(),
        );
        match maybe_file_session {
            Ok(session) => {
                let helper_path = match prepare_broker_fetch_helper(app_handle, app_data_dir) {
                    Ok(helper_path) => Some(helper_path),
                    Err(error) if !broker_only => {
                        log::warn!(
                            "[Shell] broker-preferred helper unavailable; continuing without helper: {}",
                            error
                        );
                        broker_helper_unavailable_detail = Some(format!(
                            "helperUnavailable={}",
                            truncate_audit_detail(error.to_string())
                        ));
                        None
                    }
                    Err(error) => return Err(error),
                };
                if let Some(helper_path) = helper_path {
                    if let Some(helper_dir) = helper_path.parent() {
                        prepend_env_path(cmd, restricted_env_overrides, helper_dir);
                        log::debug!(
                            "[Shell] broker helper directory prepended to PATH: {}",
                            helper_dir.display()
                        );
                    }
                    set_command_env(
                        cmd,
                        restricted_env_overrides,
                        "AGENTVIS_BROKER_PIPE",
                        session.session_dir.to_string_lossy().to_string(),
                    );
                    set_command_env(
                        cmd,
                        restricted_env_overrides,
                        "AGENTVIS_BROKER_TOKEN",
                        session.token.clone(),
                    );
                    set_command_env(
                        cmd,
                        restricted_env_overrides,
                        "AGENTVIS_BROKER_FETCH",
                        helper_path.to_string_lossy().to_string(),
                    );
                    file_session = Some(session);
                } else if broker_only {
                    return Err(AppError::NotFound(
                        "Broker helper executable is required for brokerOnly network mode."
                            .to_string(),
                    ));
                }
            }
            Err(error) if !broker_only => {
                log::warn!(
                    "[Shell] broker-preferred file session unavailable; continuing without helper: {}",
                    error
                );
                broker_helper_unavailable_detail = Some(format!(
                    "fileSessionUnavailable={}",
                    truncate_audit_detail(error.to_string())
                ));
            }
            Err(error) => return Err(error),
        }
    }

    if broker_preferred {
        match start_network_broker_proxy_session_with_auth(
            app_handle.clone(),
            Some(sandbox_mode.clone()),
            subject.clone(),
            proxy_auth_required,
        )
        .await
        {
            Ok(session) => {
                let browser_proxy_server = session.proxy_url();
                let proxy_url = session.proxy_url_with_credentials();
                let proxy_username = session.proxy_username().to_string();
                let proxy_password = session.proxy_password().to_string();
                apply_network_proxy_env(
                    cmd,
                    restricted_env_overrides,
                    &proxy_url,
                    &browser_proxy_server,
                    &proxy_username,
                    &proxy_password,
                );
                log::debug!(
                    "[Shell] network broker proxy env prepared: sandbox_mode={}, proxy_server={}",
                    sandbox_mode,
                    browser_proxy_server
                );
                let mut event = sandbox_policy.diagnostic_audit_event_with_backend(
                    command,
                    workdir,
                    execution_id,
                    "diagnostic",
                    "broker_proxy_session_started",
                    Some(format!("proxyServer={browser_proxy_server}")),
                    "broker",
                );
                event.guard_mode = Some("auditOnly".to_string());
                record_sandbox_audit_event(app_handle, event);
                proxy_session = Some(session);
            }
            Err(error) => {
                log::warn!(
                    "[Shell] broker-preferred proxy unavailable; continuing with direct/audit network: {}",
                    error
                );
                if proxy_required {
                    let mut event = sandbox_policy.diagnostic_audit_event_with_backend(
                        command,
                        workdir,
                        execution_id,
                        "block",
                        "broker_proxy_required_unavailable",
                        Some(truncate_audit_detail(error.to_string())),
                        "broker",
                    );
                    event.guard_mode = Some("hardBlock".to_string());
                    record_sandbox_audit_event(app_handle, event);
                    return Err(AppError::Forbidden(
                        "Sandbox block [broker_proxy_required_unavailable]: controlled-network mode could not start the broker proxy, so the network command was not executed. Retry, check broker components, or switch to LocalAudit mode if direct networking is intended."
                            .to_string(),
                    ));
                }
            }
        }
    }

    if let Some(detail) = broker_helper_unavailable_detail {
        let mut event = sandbox_policy.diagnostic_audit_event_with_backend(
            command,
            workdir,
            execution_id,
            "diagnostic",
            "broker_helper_unavailable",
            Some(detail),
            "broker",
        );
        event.guard_mode = Some("auditOnly".to_string());
        record_sandbox_audit_event(app_handle, event);
    }

    if broker_only && file_session.is_none() {
        return Err(AppError::NotFound(
            "Broker helper session is required for brokerOnly network mode.".to_string(),
        ));
    }
    if !broker_only && !broker_preferred {
        return Ok(None);
    }
    if !broker_only && file_session.is_none() && proxy_session.is_none() {
        return Ok(None);
    }

    set_command_env(
        cmd,
        restricted_env_overrides,
        "AGENTVIS_BROKER_MODE",
        if broker_only { "explicit" } else { "preferred" },
    );
    set_command_env(
        cmd,
        restricted_env_overrides,
        "AGENTVIS_NETWORK_BROKER_MODE",
        if broker_only { "required" } else { "available" },
    );
    set_command_env(
        cmd,
        restricted_env_overrides,
        "AGENTVIS_NETWORK_DIRECT_ACCESS",
        if broker_only { "blocked" } else { "audit" },
    );

    log::debug!(
        "[Shell] network broker session env prepared: sandbox_mode={}, file_session={}, proxy_session={}",
        sandbox_mode,
        file_session.is_some(),
        proxy_session.is_some()
    );

    Ok(Some(NetworkRuntimeSession {
        _file_session: file_session,
        _proxy_session: proxy_session,
    }))
}

#[cfg(target_os = "windows")]
fn build_windows_shell_raw_arg(command: &str) -> String {
    format!("/S /C \"chcp 65001 >nul && {}\"", command)
}

#[cfg(target_os = "windows")]
fn build_windows_shell_command(command: &str) -> String {
    format!("cmd {}", build_windows_shell_raw_arg(command))
}

#[cfg(test)]
mod tests {
    use super::{
        appcontainer_direct_network_env_overrides, broker_fetch_helper_file_name,
        broker_fetch_helper_needs_refresh, broker_fetch_helper_resource_candidates,
        broker_only_requested, broker_proxy_required_for_network_intent,
        broker_unused_diagnostic_detail, controlled_browser_proxy_env_overrides,
        controlled_browser_runtime_command, first_shell_token, first_shell_token_file_stem,
        network_guard_backend_is_wfp_canary, network_guard_backend_is_wfp_hard,
        network_proxy_env_overrides, parse_wfp_inspect_readiness,
        prepare_wfp_managed_egress_executable, resolve_shell_timeout_duration,
        wfp_canary_preflight_detail, wfp_canary_task_category, wfp_helper_file_name,
        wfp_helper_resource_candidates, wfp_managed_egress_command_name,
        wfp_proxy_preferred_fallback_allowed, ControlledBrowserRuntimeCommand,
        NetworkProxyEnvValues, WfpGuardReadiness, MAX_SHELL_TIMEOUT_SECONDS,
        WFP_MANAGED_EGRESS_MARKER,
    };
    #[cfg(target_os = "windows")]
    use super::{build_windows_shell_command, build_windows_shell_raw_arg};
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn shell_timeout_defaults_to_backend_default_when_omitted() {
        let timeout = resolve_shell_timeout_duration(None).expect("default timeout");

        assert_eq!(timeout.as_secs(), 300);
    }

    #[test]
    fn shell_timeout_accepts_global_maximum() {
        let timeout =
            resolve_shell_timeout_duration(Some(MAX_SHELL_TIMEOUT_SECONDS)).expect("max timeout");

        assert_eq!(timeout.as_secs(), MAX_SHELL_TIMEOUT_SECONDS);
    }

    #[test]
    fn shell_timeout_rejects_values_above_global_maximum() {
        let error = resolve_shell_timeout_duration(Some(MAX_SHELL_TIMEOUT_SECONDS + 1))
            .expect_err("timeout should be rejected");

        assert!(error.to_string().contains("1800"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_shell_raw_arg_preserves_command_quotes() {
        let raw = build_windows_shell_raw_arg("python -c \"print('ok')\"");

        assert_eq!(
            raw,
            "/S /C \"chcp 65001 >nul && python -c \"print('ok')\"\""
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_shell_command_preserves_quoted_paths() {
        let shell_command = build_windows_shell_command("dir \"C:\\Program Files\"");

        assert_eq!(
            shell_command,
            "cmd /S /C \"chcp 65001 >nul && dir \"C:\\Program Files\"\""
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn appcontainer_app_managed_roots_include_deliverables() {
        let app_data_dir = std::env::temp_dir().join(format!(
            "agentvis_appcontainer_roots_{}",
            uuid::Uuid::new_v4()
        ));

        let roots = super::appcontainer_app_managed_roots(&app_data_dir);

        assert!(roots.contains(&app_data_dir.join("runtime")));
        assert!(roots.contains(&app_data_dir.join("skills")));
        assert!(roots.contains(&app_data_dir.join("deliverables")));
        let _ = fs::remove_dir_all(app_data_dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn agent_browser_transient_artifact_roots_are_user_scoped() {
        let roots =
            super::agent_browser_transient_artifact_roots_from_home(PathBuf::from(r"C:\Users\me"));

        assert_eq!(
            roots,
            vec![PathBuf::from(r"C:\Users\me\.agent-browser\tmp\screenshots")]
        );
    }

    #[test]
    fn appcontainer_direct_network_env_clears_proxy_and_forces_direct_mode() {
        let overrides = appcontainer_direct_network_env_overrides();

        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            assert!(overrides.contains(&(key, "")));
        }
        assert!(overrides.contains(&("NO_PROXY", "*")));
        assert!(overrides.contains(&("no_proxy", "*")));
        assert!(overrides.contains(&("npm_config_proxy", "")));
        assert!(overrides.contains(&("npm_config_https_proxy", "")));
        assert!(overrides.contains(&("npm_config_noproxy", "*")));
        assert!(overrides.contains(&("PIP_PROXY", "")));
        assert!(overrides.contains(&("GIT_CONFIG_COUNT", "0")));
        assert!(overrides.contains(&("AGENTVIS_BROWSER_PROXY_SERVER", "")));
        assert!(overrides.contains(&("AGENTVIS_BROWSER_PROXY_USERNAME", "")));
        assert!(overrides.contains(&("AGENTVIS_BROWSER_PROXY_PASSWORD", "")));
        assert!(overrides.contains(&("AGENTVIS_NETWORK_PROXY_MODE", "direct")));
        assert!(overrides.contains(&("AGENTVIS_NETWORK_PROXY_URL", "")));
        assert!(overrides.contains(&("AGENTVIS_NETWORK_PROXY_USERNAME", "")));
        assert!(overrides.contains(&("AGENTVIS_NETWORK_PROXY_PASSWORD", "")));
    }

    #[test]
    fn network_proxy_env_points_common_proxy_vars_to_broker() {
        let overrides = network_proxy_env_overrides(
            "http://agentvis:secret-token@127.0.0.1:49152",
            "http://127.0.0.1:49152",
            "agentvis",
            "secret-token",
        );

        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            assert!(overrides.contains(&(
                key,
                "http://agentvis:secret-token@127.0.0.1:49152".to_string()
            )));
        }
        assert!(overrides.contains(&("NO_PROXY", String::new())));
        assert!(overrides.contains(&("no_proxy", String::new())));
        assert!(overrides.contains(&(
            "npm_config_proxy",
            "http://agentvis:secret-token@127.0.0.1:49152".to_string()
        )));
        assert!(overrides.contains(&(
            "npm_config_https_proxy",
            "http://agentvis:secret-token@127.0.0.1:49152".to_string()
        )));
        assert!(overrides.contains(&(
            "PIP_PROXY",
            "http://agentvis:secret-token@127.0.0.1:49152".to_string()
        )));
        assert!(overrides.contains(&("GIT_CONFIG_COUNT", "2".to_string())));
        assert!(overrides.contains(&("GIT_CONFIG_KEY_0", "http.proxy".to_string())));
        assert!(overrides.contains(&(
            "GIT_CONFIG_VALUE_0",
            "http://agentvis:secret-token@127.0.0.1:49152".to_string()
        )));
        assert!(overrides.contains(&("GIT_CONFIG_KEY_1", "https.proxy".to_string())));
        assert!(overrides.contains(&(
            "GIT_CONFIG_VALUE_1",
            "http://agentvis:secret-token@127.0.0.1:49152".to_string()
        )));
        assert!(overrides.contains(&(
            "AGENTVIS_BROWSER_PROXY_SERVER",
            "http://127.0.0.1:49152".to_string()
        )));
        assert!(overrides.contains(&("AGENTVIS_BROWSER_PROXY_USERNAME", "agentvis".to_string())));
        assert!(overrides.contains(&(
            "AGENTVIS_BROWSER_PROXY_PASSWORD",
            "secret-token".to_string()
        )));
        assert!(overrides.contains(&("AGENTVIS_NETWORK_PROXY_MODE", "broker".to_string())));
        assert!(overrides.contains(&(
            "AGENTVIS_NETWORK_PROXY_URL",
            "http://agentvis:secret-token@127.0.0.1:49152".to_string()
        )));
        assert!(overrides.contains(&("AGENTVIS_NETWORK_PROXY_USERNAME", "agentvis".to_string())));
        assert!(overrides.contains(&(
            "AGENTVIS_NETWORK_PROXY_PASSWORD",
            "secret-token".to_string()
        )));
    }

    #[test]
    fn controlled_browser_proxy_env_keeps_cdp_control_plane_local() {
        let values = NetworkProxyEnvValues {
            proxy_url_with_credentials: "http://agentvis:secret-token@127.0.0.1:49152".to_string(),
            browser_proxy_server: "http://127.0.0.1:49152".to_string(),
            proxy_username: "agentvis".to_string(),
            proxy_password: "secret-token".to_string(),
        };
        let overrides = controlled_browser_proxy_env_overrides(&values);

        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            assert!(overrides.contains(&(key, String::new())));
        }
        assert!(overrides.contains(&("NO_PROXY", "127.0.0.1,localhost,::1".to_string())));
        assert!(overrides.contains(&(
            "AGENTVIS_BROWSER_PROXY_SERVER",
            "http://127.0.0.1:49152".to_string()
        )));
        assert!(overrides.contains(&("AGENTVIS_NETWORK_PROXY_MODE", "broker".to_string())));
    }

    #[test]
    fn controlled_browser_runtime_command_classifier_is_narrow() {
        assert_eq!(
            controlled_browser_runtime_command(
                r#"cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" https://example.com"#
            ),
            Some(ControlledBrowserRuntimeCommand::StartOrEnsure)
        );
        assert_eq!(
            controlled_browser_runtime_command(
                r#"cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" status"#
            ),
            Some(ControlledBrowserRuntimeCommand::Status)
        );
        assert_eq!(
            controlled_browser_runtime_command(
                r#"cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" stop"#
            ),
            Some(ControlledBrowserRuntimeCommand::Stop)
        );
        assert_eq!(
            controlled_browser_runtime_command(
                r#"cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\browser-command.bat" close"#
            ),
            Some(ControlledBrowserRuntimeCommand::Stop)
        );
        assert_eq!(
            controlled_browser_runtime_command(
                r#"cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\browser-command.bat" screenshot"#
            ),
            Some(ControlledBrowserRuntimeCommand::Control)
        );
        assert_eq!(
            controlled_browser_runtime_command(
                "agent-browser --session agentvis-cdp-49200 --cdp 49200 snapshot -i"
            ),
            Some(ControlledBrowserRuntimeCommand::Control)
        );
        assert_eq!(
            controlled_browser_runtime_command("agent-browser --headed open https://example.com"),
            None
        );
    }

    #[test]
    fn controlled_browser_runtime_command_accepts_agent_browser_nested_quotes() {
        assert_eq!(
            controlled_browser_runtime_command(
                r##"cmd /c ""%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" "https://example.com"""##
            ),
            Some(ControlledBrowserRuntimeCommand::StartOrEnsure)
        );
        assert_eq!(
            controlled_browser_runtime_command(
                r##"cmd /c ""%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" status""##
            ),
            Some(ControlledBrowserRuntimeCommand::Status)
        );
        assert_eq!(
            controlled_browser_runtime_command(
                r##"cmd /c ""%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" stop""##
            ),
            Some(ControlledBrowserRuntimeCommand::Stop)
        );
        assert_eq!(
            controlled_browser_runtime_command(
                r##"cmd /c ""%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\browser-command.bat" close""##
            ),
            Some(ControlledBrowserRuntimeCommand::Stop)
        );
    }

    #[test]
    fn controlled_browser_runtime_command_nested_quote_fallback_stays_narrow() {
        assert_eq!(
            controlled_browser_runtime_command(
                r##"cmd /c ""C:\tmp\start-chrome-debug.bat" https://example.com""##
            ),
            None
        );
        assert_eq!(
            controlled_browser_runtime_command(
                r##"cmd /c ""%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" https://example.com" && curl https://example.net"##
            ),
            None
        );
        assert_eq!(
            controlled_browser_runtime_command(
                r##"cmd /c echo ""%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" status""##
            ),
            None
        );
    }

    #[test]
    fn network_guard_backend_accepts_wfp_aliases_only() {
        assert!(network_guard_backend_is_wfp_hard(Some("wfpAppIdBlock")));
        assert!(network_guard_backend_is_wfp_hard(Some("wfp-app-id-block")));
        assert!(network_guard_backend_is_wfp_hard(Some("wfp_app_id_block")));
        assert!(network_guard_backend_is_wfp_hard(Some(
            "wfpPerRunAppIdBlock"
        )));
        assert!(network_guard_backend_is_wfp_hard(Some(
            "wfp-per-run-app-id-block"
        )));
        assert!(network_guard_backend_is_wfp_hard(Some(
            "wfp_per_run_app_id_block"
        )));
        assert!(network_guard_backend_is_wfp_canary(Some("wfpCanary")));
        assert!(network_guard_backend_is_wfp_canary(Some("wfp-canary")));
        assert!(network_guard_backend_is_wfp_canary(Some("wfp_canary")));
        assert!(!network_guard_backend_is_wfp_hard(Some("wfpCanary")));
        assert!(!network_guard_backend_is_wfp_canary(Some("wfpAppIdBlock")));
        assert!(!network_guard_backend_is_wfp_hard(Some("proxy")));
        assert!(!network_guard_backend_is_wfp_hard(None));
    }

    #[test]
    fn wfp_helper_resource_candidates_include_packaged_bin_first() {
        let resource_dir = PathBuf::from(r"C:\AgentVis\resources");
        let candidates = wfp_helper_resource_candidates(&resource_dir);

        assert_eq!(
            candidates.first(),
            Some(&resource_dir.join("bin").join(wfp_helper_file_name()))
        );
        assert!(candidates.contains(
            &resource_dir
                .join("target")
                .join("debug")
                .join(wfp_helper_file_name())
        ));
    }

    #[test]
    fn wfp_inspect_readiness_accepts_clean_inspect() {
        let readiness = parse_wfp_inspect_readiness(
            r#"{"ok":true,"inspect":{"filtersDetected":[],"residualFiltersDetected":false},"cleanup":{"residualFiltersDetected":false}}"#,
        );

        assert!(readiness.ready);
        assert_eq!(readiness.reason, "wfp_helper_inspect_ready");
    }

    #[test]
    fn wfp_inspect_readiness_blocks_residual_filters() {
        let readiness = parse_wfp_inspect_readiness(
            r#"{"ok":true,"inspect":{"filtersDetected":["ALE_AUTH_CONNECT_V4"],"residualFiltersDetected":true},"cleanup":{"residualFiltersDetected":true}}"#,
        );

        assert!(!readiness.ready);
        assert_eq!(readiness.reason, "wfp_helper_inspect_residual_detected");
    }

    #[test]
    fn first_shell_token_parses_plain_and_quoted_tokens() {
        assert_eq!(
            first_shell_token("curl https://example.com").as_deref(),
            Some("curl")
        );
        assert_eq!(
            first_shell_token(r#""node" script.js"#).as_deref(),
            Some("node")
        );
        assert_eq!(
            first_shell_token(r#""C:\Tools\curl.exe" https://example.com"#).as_deref(),
            Some(r"C:\Tools\curl.exe")
        );
        assert!(first_shell_token("   ").is_none());
    }

    #[test]
    fn first_shell_token_file_stem_handles_python_paths() {
        assert_eq!(
            first_shell_token_file_stem(r#""C:\Runtime\.venv\Scripts\python.exe" script.py"#)
                .as_deref(),
            Some("python")
        );
        assert_eq!(
            first_shell_token_file_stem("py -3 script.py").as_deref(),
            Some("py")
        );
    }

    #[test]
    fn wfp_managed_egress_command_name_allows_initial_bare_http_tools() {
        assert_eq!(
            wfp_managed_egress_command_name("curl https://example.com").as_deref(),
            Some("curl")
        );
        assert_eq!(
            wfp_managed_egress_command_name("curl.exe https://example.com").as_deref(),
            Some("curl")
        );
        assert_eq!(
            wfp_managed_egress_command_name("node fetch.js").as_deref(),
            Some("node")
        );
        assert_eq!(
            wfp_managed_egress_command_name("git ls-remote https://github.com/a/b").as_deref(),
            Some("git")
        );
        assert_eq!(
            wfp_managed_egress_command_name("npm view axios version").as_deref(),
            Some("npm")
        );
        assert_eq!(
            wfp_managed_egress_command_name("npx playwright --version").as_deref(),
            Some("npx")
        );
        assert_eq!(
            wfp_managed_egress_command_name("pip install requests").as_deref(),
            Some("pip")
        );
        assert_eq!(
            wfp_managed_egress_command_name("pip3 install requests").as_deref(),
            Some("pip3")
        );
        assert_eq!(
            wfp_managed_egress_command_name("uv pip install requests").as_deref(),
            Some("uv")
        );
        assert!(wfp_managed_egress_command_name("python script.py").is_none());
        assert!(
            wfp_managed_egress_command_name(r#""C:\Tools\curl.exe" https://example.com"#).is_none()
        );
    }

    #[test]
    fn wfp_canary_task_category_covers_real_task_matrix() {
        assert_eq!(
            wfp_canary_task_category("curl.exe https://example.com", None, None, false, "curl"),
            "curl"
        );
        assert_eq!(
            wfp_canary_task_category(
                "git ls-remote https://github.com/a/b",
                None,
                None,
                false,
                "git"
            ),
            "git"
        );
        assert_eq!(
            wfp_canary_task_category("npm view axios version", None, None, false, "npm view"),
            "npm"
        );
        assert_eq!(
            wfp_canary_task_category("pip install requests", None, None, false, "pip install"),
            "pythonPackage"
        );
        assert_eq!(
            wfp_canary_task_category("node fetch.js", None, None, false, "fetch"),
            "node"
        );
        assert_eq!(
            wfp_canary_task_category("node playwright_probe.js", None, None, false, "url_literal"),
            "browser"
        );
        assert_eq!(
            wfp_canary_task_category("npx playwright test", None, None, false, "playwright"),
            "browser"
        );
        assert_eq!(
            wfp_canary_task_category(
                "chromium https://example.com",
                None,
                None,
                false,
                "url_literal"
            ),
            "browser"
        );
        assert_eq!(
            wfp_canary_task_category(
                "chromium --proxy-server=direct:// https://example.com",
                None,
                None,
                false,
                "proxy_bypass:browserDirectProxyOption"
            ),
            "proxyBypass:browserDirectProxyOption"
        );
        assert_eq!(
            wfp_canary_task_category("npm view axios version", None, None, true, "npm view"),
            "background"
        );
    }

    #[test]
    fn wfp_canary_preflight_detail_includes_matrix_fields() {
        let readiness = WfpGuardReadiness {
            ready: true,
            reason: "wfp_helper_inspect_ready",
            detail: None,
        };
        let detail = wfp_canary_preflight_detail(
            "curl https://example.com",
            None,
            None,
            false,
            "curl",
            &readiness,
            Some("curl"),
        );

        assert!(detail.contains("networkIntent=curl"));
        assert!(detail.contains("eligibleFirstToken=curl"));
        assert!(detail.contains("taskCategory=curl"));
        assert!(detail.contains("source=staticIntent"));
    }

    #[test]
    fn wfp_proxy_preferred_fallback_allows_declared_skill_manifest_and_env() {
        let skill_root = std::env::temp_dir()
            .join(format!("agentvis-proxy-skill-{}", uuid::Uuid::new_v4()))
            .join("skills")
            .join("external")
            .join("packages")
            .join("proxy-skill");
        fs::create_dir_all(skill_root.join("scripts")).expect("create skill root");
        fs::write(
            skill_root.join("SKILL.md"),
            "---\nname: proxy-skill\nagentvisNetwork: brokerProxyPreferred\n---\n",
        )
        .expect("write skill manifest");
        fs::write(
            skill_root.join("scripts").join("scrape.py"),
            "print('ok')\n",
        )
        .expect("write skill script");
        let custom_fetch_script = skill_root.join("scripts").join("custom_fetch.py");
        fs::write(&custom_fetch_script, "import requests\nprint('fetch')\n")
            .expect("write custom fetch script");

        assert!(wfp_proxy_preferred_fallback_allowed(
            &format!(
                r#""C:\Runtime\.venv\Scripts\python.exe" "{}" "https://example.com""#,
                skill_root.join("scripts").join("scrape.py").display()
            ),
            None,
            None
        ));
        assert!(wfp_proxy_preferred_fallback_allowed(
            r#"python scripts\scrape.py "https://example.com""#,
            skill_root.to_str(),
            None
        ));

        let mut env = HashMap::new();
        env.insert(
            "AGENTVIS_NETWORK_EGRESS_GUARD_FALLBACK".to_string(),
            "brokerProxyPreferred".to_string(),
        );
        assert!(wfp_proxy_preferred_fallback_allowed(
            &format!(
                r#"python "{}" "https://example.com""#,
                custom_fetch_script.display()
            ),
            None,
            Some(&env)
        ));

        let _ = fs::remove_dir_all(skill_root);
    }

    #[test]
    fn wfp_proxy_preferred_fallback_respects_entrypoint_declarations() {
        let skill_root = std::env::temp_dir()
            .join(format!(
                "agentvis-entrypoint-skill-{}",
                uuid::Uuid::new_v4()
            ))
            .join("skills")
            .join("external")
            .join("packages")
            .join("entrypoint-skill");
        fs::create_dir_all(skill_root.join("scripts")).expect("create skill root");
        fs::write(
            skill_root.join("SKILL.md"),
            "---\nname: entrypoint-skill\nagentvisNetworkEntrypoints:\n  scripts/http.py: brokerProxyPreferred\n  scripts/mail.py: legacyNonHttp\n---\n",
        )
        .expect("write skill manifest");
        fs::write(
            skill_root.join("scripts").join("http.py"),
            "import requests\nprint('http')\n",
        )
        .expect("write http script");
        fs::write(
            skill_root.join("scripts").join("mail.py"),
            "import smtplib\nprint('mail')\n",
        )
        .expect("write mail script");

        assert!(wfp_proxy_preferred_fallback_allowed(
            &format!(
                r#"python "{}" https://example.com"#,
                skill_root.join("scripts").join("http.py").display()
            ),
            None,
            None
        ));
        assert!(!wfp_proxy_preferred_fallback_allowed(
            &format!(
                r#"python "{}" --action list_emails"#,
                skill_root.join("scripts").join("mail.py").display()
            ),
            None,
            None
        ));

        let _ = fs::remove_dir_all(skill_root);
    }

    #[test]
    fn wfp_proxy_preferred_fallback_blocks_non_http_and_unknown_python() {
        let skill_root = std::env::temp_dir()
            .join(format!("agentvis-mail-skill-{}", uuid::Uuid::new_v4()))
            .join("skills")
            .join("external")
            .join("packages")
            .join("mail-skill");
        fs::create_dir_all(skill_root.join("scripts")).expect("create mail skill root");
        fs::write(
            skill_root.join("SKILL.md"),
            "---\nname: mail-skill\nagentvisNetwork: brokerProxyPreferred\n---\n",
        )
        .expect("write mail skill manifest");
        fs::write(
            skill_root.join("scripts").join("email.py"),
            "import smtplib\nprint('mail')\n",
        )
        .expect("write mail skill script");

        assert!(!wfp_proxy_preferred_fallback_allowed(
            &format!(
                r#"python "{}" --action list_emails"#,
                skill_root.join("scripts").join("email.py").display()
            ),
            None,
            None
        ));

        let mut env = HashMap::new();
        env.insert(
            "AGENTVIS_NETWORK_EGRESS_GUARD_FALLBACK".to_string(),
            "brokerProxyPreferred".to_string(),
        );
        assert!(!wfp_proxy_preferred_fallback_allowed(
            &format!(
                r#"python "{}" --action list_emails"#,
                skill_root.join("scripts").join("email.py").display()
            ),
            None,
            Some(&env)
        ));
        assert!(!wfp_proxy_preferred_fallback_allowed(
            r#"python "C:\Temp\unknown_fetch.py" https://example.com"#,
            None,
            None
        ));

        let _ = fs::remove_dir_all(skill_root);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn prepare_wfp_managed_egress_executable_copies_eligible_tool() {
        let root = std::env::temp_dir().join(format!(
            "agentvis-wfp-managed-egress-test-{}",
            uuid::Uuid::new_v4()
        ));
        let tools_dir = root.join("tools");
        let app_data_dir = root.join("appdata");
        fs::create_dir_all(&tools_dir).expect("create tools dir");
        fs::create_dir_all(&app_data_dir).expect("create app data dir");

        let exe_name = if cfg!(target_os = "windows") {
            "curl.exe"
        } else {
            "curl"
        };
        let source_exe = tools_dir.join(exe_name);
        fs::write(&source_exe, b"fake curl").expect("write fake tool");

        let mut env = HashMap::new();
        env.insert(
            "PATH".to_string(),
            std::env::join_paths([tools_dir.as_path()])
                .expect("join test PATH")
                .to_string_lossy()
                .to_string(),
        );

        let plan = prepare_wfp_managed_egress_executable(
            &app_data_dir,
            "curl https://example.com",
            Some(&env),
        )
        .expect("prepare managed executable")
        .expect("eligible command should produce a plan");

        assert_eq!(plan.command_name, "curl");
        assert_eq!(plan.source_exe, source_exe);
        assert!(plan.managed_exe.is_file());
        assert!(plan.managed_dir.join(WFP_MANAGED_EGRESS_MARKER).is_file());
        assert_eq!(
            fs::read(&plan.managed_exe).expect("read managed copy"),
            b"fake curl"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prepare_wfp_managed_egress_executable_skips_ineligible_command() {
        let app_data_dir = std::env::temp_dir().join(format!(
            "agentvis-wfp-managed-egress-skip-test-{}",
            uuid::Uuid::new_v4()
        ));
        let plan = prepare_wfp_managed_egress_executable(
            &app_data_dir,
            "python script.py",
            Some(&HashMap::new()),
        )
        .expect("skip ineligible command without error");

        assert!(plan.is_none());
        let _ = fs::remove_dir_all(&app_data_dir);
    }

    #[test]
    fn broker_only_request_accepts_explicit_or_required_marker() {
        let mut env = HashMap::new();
        assert!(!broker_only_requested(Some(&env)));

        env.insert("AGENTVIS_BROKER_MODE".to_string(), "explicit".to_string());
        assert!(broker_only_requested(Some(&env)));

        env.clear();
        env.insert(
            "AGENTVIS_NETWORK_BROKER_MODE".to_string(),
            "required".to_string(),
        );
        assert!(broker_only_requested(Some(&env)));
    }

    #[test]
    fn broker_proxy_required_only_for_proxyable_network_intent() {
        assert!(broker_proxy_required_for_network_intent(
            "curl https://example.com",
            None,
        ));
        assert!(broker_proxy_required_for_network_intent(
            "npm view axios version",
            None,
        ));
        assert!(!broker_proxy_required_for_network_intent(
            "dir C:\\Users",
            None,
        ));
        assert!(!broker_proxy_required_for_network_intent(
            "curl --noproxy \"*\" https://example.com",
            None,
        ));
        assert!(!broker_proxy_required_for_network_intent(
            "ssh -p 2222 user@example.com",
            None,
        ));
    }

    #[test]
    fn broker_unused_diagnostic_detail_exposes_reason_class() {
        let direct = broker_unused_diagnostic_detail(
            "curl https://example.com",
            None,
            "HTTP/1.1 200 OK",
            "",
        );
        assert!(direct.contains("reasonCode=broker_proxy_expected_but_unused"));
        assert!(direct.contains("reasonClass=potential_direct_egress"));
        assert!(direct.contains("firstToken=curl"));

        let cache = broker_unused_diagnostic_detail(
            "npm install axios",
            None,
            "up to date, audited 10 packages",
            "",
        );
        assert!(cache.contains("reasonClass=cache_hit_likely"));

        let misclassified =
            broker_unused_diagnostic_detail("echo https://example.com", None, "", "");
        assert!(misclassified.contains("reasonClass=tool_misclassification"));
    }

    #[test]
    fn broker_fetch_helper_name_matches_platform() {
        let name = broker_fetch_helper_file_name();

        if cfg!(target_os = "windows") {
            assert_eq!(name, "agentvis-broker-fetch.exe");
        } else {
            assert_eq!(name, "agentvis-broker-fetch");
        }
    }

    #[test]
    fn broker_fetch_helper_resource_candidates_include_packaged_bin_first() {
        let resource_dir = std::path::PathBuf::from("resource-root");
        let candidates = broker_fetch_helper_resource_candidates(&resource_dir);

        assert_eq!(
            candidates[0],
            resource_dir
                .join("bin")
                .join(broker_fetch_helper_file_name())
        );
        let release_helper = std::path::PathBuf::from("target")
            .join("release")
            .join(broker_fetch_helper_file_name());
        assert!(candidates
            .iter()
            .any(|path| path.ends_with(&release_helper)));
    }

    #[test]
    fn broker_fetch_helper_refreshes_missing_or_stale_managed_copy() {
        let root = std::env::temp_dir().join(format!(
            "agentvis-broker-helper-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create temp dir");
        let source = root.join("source-helper");
        let managed = root.join("managed-helper");

        fs::write(&source, b"new-helper").expect("write source helper");
        assert!(broker_fetch_helper_needs_refresh(&source, &managed));

        fs::write(&managed, b"old").expect("write stale managed helper");
        assert!(broker_fetch_helper_needs_refresh(&source, &managed));

        fs::write(&managed, b"new-helper").expect("write current managed helper");
        assert!(!broker_fetch_helper_needs_refresh(&source, &managed));

        let _ = fs::remove_dir_all(&root);
    }
}

// ==================== 编码处理 ====================

/// 解码命令输出
///
/// 策略：先尝试 UTF-8，失败时在 Windows 上回退到 GBK（代码页 936）。
/// 非 Windows 平台始终使用 lossy UTF-8。
fn decode_output(bytes: &[u8]) -> String {
    // 尝试 UTF-8
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }

    // Windows: 回退到 GBK
    #[cfg(target_os = "windows")]
    {
        let (decoded, _, had_errors) = encoding_rs::GBK.decode(bytes);
        if !had_errors {
            return decoded.into_owned();
        }
    }

    // 最终回退：lossy UTF-8
    String::from_utf8_lossy(bytes).to_string()
}

#[cfg(target_os = "windows")]
fn sandbox_output_to_shell_result(
    output: RestrictedTokenProbeResult,
    started_at: Instant,
    timeout_duration: Duration,
) -> ShellExecResult {
    shell_exec_result(
        output.exit_code,
        output.stdout,
        output.stderr,
        None,
        started_at,
        Some(timeout_duration),
        false,
        false,
    )
}

#[cfg(target_os = "windows")]
fn map_sandbox_wait_result(
    label: &str,
    result: Result<Result<RestrictedTokenProbeResult, String>, tokio::task::JoinError>,
    started_at: Instant,
    timeout_duration: Duration,
) -> CommandResult<ShellExecResult> {
    match result {
        Ok(Ok(output)) => Ok(sandbox_output_to_shell_result(
            output,
            started_at,
            timeout_duration,
        )),
        Ok(Err(error)) => Err(AppError::Generic(format!(
            "{} command execution failed: {}",
            label, error
        ))),
        Err(error) => Err(AppError::Generic(format!(
            "{} command wait task failed: {}",
            label, error
        ))),
    }
}

#[cfg(target_os = "windows")]
fn appcontainer_profile_name(execution_id: Option<&str>) -> String {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let mut suffix = execution_id
        .unwrap_or("shell")
        .chars()
        .filter_map(|ch| {
            if ch.is_ascii_alphanumeric() {
                Some(ch.to_ascii_lowercase())
            } else if ch == '-' || ch == '_' {
                Some('-')
            } else {
                None
            }
        })
        .take(24)
        .collect::<String>();
    if suffix.is_empty() {
        suffix = "shell".to_string();
    }
    format!("agentvis-shell-{}-{}", suffix, nonce)
}

#[cfg(target_os = "windows")]
fn appcontainer_app_managed_roots(app_data_dir: &Path) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut roots = vec![
        app_data_dir.join("runtime"),
        app_data_dir.join("skills"),
        app_data_dir.join("deliverables"),
    ];
    roots.extend(agent_browser_transient_artifact_roots());

    roots
        .into_iter()
        .filter(|path| {
            if let Err(error) = std::fs::create_dir_all(path) {
                log::warn!(
                    "[Shell] failed to prepare AppContainer app-managed root {}: {}",
                    path.display(),
                    error
                );
                return false;
            }
            true
        })
        .filter(|path| {
            let key = path.to_string_lossy().to_ascii_lowercase();
            seen.insert(key)
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn agent_browser_transient_artifact_roots() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return Vec::new();
    };
    agent_browser_transient_artifact_roots_from_home(PathBuf::from(home))
}

#[cfg(target_os = "windows")]
fn agent_browser_transient_artifact_roots_from_home(home: PathBuf) -> Vec<PathBuf> {
    if home.as_os_str().is_empty() {
        return Vec::new();
    }
    vec![home.join(".agent-browser").join("tmp").join("screenshots")]
}

#[cfg(target_os = "windows")]
fn pyvenv_cfg_value(content: &str, key: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let (candidate, value) = line.split_once('=')?;
        if !candidate.trim().eq_ignore_ascii_case(key) {
            return None;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    })
}

#[cfg(target_os = "windows")]
fn path_is_inside(parent: &Path, child: &Path) -> bool {
    let parent_key = parent
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase();
    let child_key = child
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase();
    child_key == parent_key || child_key.starts_with(&format!("{}/", parent_key))
}

#[cfg(target_os = "windows")]
fn venv_external_base_roots(app_data_dir: &Path) -> Vec<String> {
    let cfg_path = app_data_dir
        .join("runtime")
        .join("python-v1")
        .join(".venv")
        .join("pyvenv.cfg");
    let Ok(content) = std::fs::read_to_string(&cfg_path) else {
        return Vec::new();
    };
    let managed_runtime_root = app_data_dir.join("runtime");

    let mut seen = HashSet::new();
    ["home", "executable", "base-executable", "base_executable"]
        .into_iter()
        .filter_map(|key| pyvenv_cfg_value(&content, key))
        .map(PathBuf::from)
        .filter(|path| !path_is_inside(&managed_runtime_root, path))
        .filter(|path| {
            let key = path.to_string_lossy().to_ascii_lowercase();
            seen.insert(key)
        })
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn venv_external_base_roots(_app_data_dir: &Path) -> Vec<String> {
    Vec::new()
}

fn command_uses_python_runtime(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    lower.contains(".py")
        || lower.contains("python ")
        || lower.contains("python.exe")
        || lower.contains("\"python\"")
        || lower.contains("'python'")
        || lower.contains("\\python")
        || lower.contains("/python")
}

fn sandbox_delete_allowed_roots(
    app_data_dir: &Path,
    workdir: Option<&Path>,
    sandbox_policy: &ShellSandboxPolicy,
) -> Option<Vec<PathBuf>> {
    if !sandbox_policy.uses_restricted_process_backend() {
        return None;
    }

    let mut roots = Vec::new();
    if let Some(workdir) = workdir {
        roots.push(workdir.to_path_buf());
    }

    #[cfg(target_os = "windows")]
    roots.extend(appcontainer_app_managed_roots(app_data_dir));

    #[cfg(not(target_os = "windows"))]
    {
        roots.push(app_data_dir.join("runtime"));
        roots.push(app_data_dir.join("skills"));
    }

    Some(roots)
}

#[cfg(target_os = "windows")]
async fn run_restricted_foreground_shell(
    command: &str,
    shell_command: String,
    workdir: Option<PathBuf>,
    env_overrides: HashMap<String, String>,
    timeout_duration: Duration,
    execution_id: Option<String>,
) -> CommandResult<ShellExecResult> {
    let started_at = Instant::now();
    let env_overrides: Vec<(String, String)> = env_overrides.into_iter().collect();
    let child = spawn_restricted_token_process(&shell_command, workdir.as_deref(), &env_overrides)
        .map_err(|error| AppError::Forbidden(format!("Sandbox block: {}", error)))?;
    let control = child.control();
    let mut wait_task = tokio::task::spawn_blocking(move || child.wait_with_output());

    let cancel_rx = if let Some(ref id) = execution_id {
        let (tx, rx) = oneshot::channel();
        foreground_cancel_registry()
            .lock()
            .await
            .insert(id.clone(), tx);
        if foreground_cancel_requests().lock().await.remove(id) {
            if let Some(tx) = foreground_cancel_registry().lock().await.remove(id) {
                let _ = tx.send(());
            }
        }
        Some(rx)
    } else {
        None
    };

    enum RestrictedForegroundOutcome {
        Completed(Result<Result<RestrictedTokenProbeResult, String>, tokio::task::JoinError>),
        TimedOut,
        Cancelled,
    }

    let outcome = if let Some(mut rx) = cancel_rx {
        tokio::select! {
            result = &mut wait_task => RestrictedForegroundOutcome::Completed(result),
            _ = tokio::time::sleep(timeout_duration) => {
                if let Err(error) = control.terminate(1) {
                    log::warn!("[Shell] restricted command terminate after timeout failed: {}", error);
                }
                RestrictedForegroundOutcome::TimedOut
            },
            _ = &mut rx => {
                if let Err(error) = control.terminate(1) {
                    log::warn!("[Shell] restricted command terminate after cancellation failed: {}", error);
                }
                RestrictedForegroundOutcome::Cancelled
            },
        }
    } else {
        tokio::select! {
            result = &mut wait_task => RestrictedForegroundOutcome::Completed(result),
            _ = tokio::time::sleep(timeout_duration) => {
                if let Err(error) = control.terminate(1) {
                    log::warn!("[Shell] restricted command terminate after timeout failed: {}", error);
                }
                RestrictedForegroundOutcome::TimedOut
            },
        }
    };

    if let Some(ref id) = execution_id {
        foreground_cancel_registry().lock().await.remove(id);
        foreground_cancel_requests().lock().await.remove(id);
    }

    match outcome {
        RestrictedForegroundOutcome::Completed(result) => {
            map_sandbox_wait_result("Restricted", result, started_at, timeout_duration)
        }
        RestrictedForegroundOutcome::TimedOut => {
            let _ = tokio::time::timeout(Duration::from_secs(3), wait_task).await;
            log::warn!(
                "[Shell] restricted command timed out ({}s), terminated: {}",
                timeout_duration.as_secs(),
                command
            );
            Ok(shell_exec_result(
                -1,
                String::new(),
                format!(
                    "Command execution timed out ({}s): {}",
                    timeout_duration.as_secs(),
                    command
                ),
                None,
                started_at,
                Some(timeout_duration),
                true,
                true,
            ))
        }
        RestrictedForegroundOutcome::Cancelled => {
            let _ = tokio::time::timeout(Duration::from_secs(3), wait_task).await;
            log::info!(
                "[Shell] restricted command cancelled and terminated: {}",
                command
            );
            Err(AppError::Generic(format!(
                "Command execution cancelled: {}",
                command
            )))
        }
    }
}

#[cfg(target_os = "windows")]
fn appcontainer_filesystem_access_from_request(
    request: &AppContainerFilesystemGrantRequest,
) -> AppContainerFilesystemAccess {
    match request.access.as_deref() {
        Some("readOnly") => AppContainerFilesystemAccess::ReadExecute,
        _ => AppContainerFilesystemAccess::ReadWrite,
    }
}

#[cfg(target_os = "windows")]
async fn run_appcontainer_foreground_shell(
    command: &str,
    shell_command: String,
    workdir: PathBuf,
    app_managed_roots: Vec<PathBuf>,
    requested_grants: Vec<AppContainerFilesystemGrantRequest>,
    env_overrides: HashMap<String, String>,
    sandbox_policy: &ShellSandboxPolicy,
    timeout_duration: Duration,
    execution_id: Option<String>,
) -> CommandResult<ShellExecResult> {
    let started_at = Instant::now();
    let env_overrides: Vec<(String, String)> = env_overrides.into_iter().collect();
    let mut grants = Vec::new();
    let mut granted_paths = HashSet::new();
    let mut push_grant = |path: PathBuf, access: AppContainerFilesystemAccess| {
        if path.exists() {
            let key = path.to_string_lossy().to_ascii_lowercase();
            if granted_paths.insert(key) {
                grants.push(AppContainerFilesystemGrant { path, access });
            }
        }
    };
    push_grant(workdir.clone(), AppContainerFilesystemAccess::ReadWrite);
    for root in app_managed_roots {
        push_grant(root, AppContainerFilesystemAccess::ReadWrite);
    }
    for grant in requested_grants {
        push_grant(
            PathBuf::from(&grant.path),
            appcontainer_filesystem_access_from_request(&grant),
        );
    }
    let profile_name = appcontainer_profile_name(execution_id.as_deref());
    let network_capabilities = sandbox_policy.appcontainer_network_capabilities();
    let child = spawn_appcontainer_filesystem_process_with_capabilities(
        &profile_name,
        &grants,
        &network_capabilities,
        &shell_command,
        Some(&workdir),
        &env_overrides,
    )
    .map_err(|error| AppError::Forbidden(format!("Sandbox block: {}", error)))?;
    let control = child.control();
    let mut wait_task = tokio::task::spawn_blocking(move || child.wait_with_output());

    let cancel_rx = if let Some(ref id) = execution_id {
        let (tx, rx) = oneshot::channel();
        foreground_cancel_registry()
            .lock()
            .await
            .insert(id.clone(), tx);
        if foreground_cancel_requests().lock().await.remove(id) {
            if let Some(tx) = foreground_cancel_registry().lock().await.remove(id) {
                let _ = tx.send(());
            }
        }
        Some(rx)
    } else {
        None
    };

    enum AppContainerForegroundOutcome {
        Completed(Result<Result<RestrictedTokenProbeResult, String>, tokio::task::JoinError>),
        TimedOut,
        Cancelled,
    }

    let outcome = if let Some(mut rx) = cancel_rx {
        tokio::select! {
            result = &mut wait_task => AppContainerForegroundOutcome::Completed(result),
            _ = tokio::time::sleep(timeout_duration) => {
                if let Err(error) = control.terminate(1) {
                    log::warn!("[Shell] AppContainer command terminate after timeout failed: {}", error);
                }
                AppContainerForegroundOutcome::TimedOut
            },
            _ = &mut rx => {
                if let Err(error) = control.terminate(1) {
                    log::warn!("[Shell] AppContainer command terminate after cancellation failed: {}", error);
                }
                AppContainerForegroundOutcome::Cancelled
            },
        }
    } else {
        tokio::select! {
            result = &mut wait_task => AppContainerForegroundOutcome::Completed(result),
            _ = tokio::time::sleep(timeout_duration) => {
                if let Err(error) = control.terminate(1) {
                    log::warn!("[Shell] AppContainer command terminate after timeout failed: {}", error);
                }
                AppContainerForegroundOutcome::TimedOut
            },
        }
    };

    if let Some(ref id) = execution_id {
        foreground_cancel_registry().lock().await.remove(id);
        foreground_cancel_requests().lock().await.remove(id);
    }

    match outcome {
        AppContainerForegroundOutcome::Completed(result) => {
            map_sandbox_wait_result("AppContainer", result, started_at, timeout_duration)
        }
        AppContainerForegroundOutcome::TimedOut => {
            let _ = tokio::time::timeout(Duration::from_secs(3), wait_task).await;
            log::warn!(
                "[Shell] AppContainer command timed out ({}s), terminated: {}",
                timeout_duration.as_secs(),
                command
            );
            Ok(shell_exec_result(
                -1,
                String::new(),
                format!(
                    "Command execution timed out ({}s): {}",
                    timeout_duration.as_secs(),
                    command
                ),
                None,
                started_at,
                Some(timeout_duration),
                true,
                true,
            ))
        }
        AppContainerForegroundOutcome::Cancelled => {
            let _ = tokio::time::timeout(Duration::from_secs(3), wait_task).await;
            log::info!(
                "[Shell] AppContainer command cancelled and terminated: {}",
                command
            );
            Err(AppError::Generic(format!(
                "Command execution cancelled: {}",
                command
            )))
        }
    }
}

// ==================== Tauri Commands ====================

fn resolve_shell_workdir(
    workdir: Option<&str>,
    sandbox_policy: &ShellSandboxPolicy,
) -> Result<Option<PathBuf>, AppError> {
    let Some(wd) = workdir else {
        return Ok(None);
    };

    let wd_path = PathBuf::from(wd);
    if wd_path.exists() && wd_path.is_dir() {
        return Ok(Some(wd_path));
    }

    if !sandbox_policy.allows_workdir_fallback() {
        return Err(AppError::Forbidden(format!(
            "Sandbox block: restricted shell execution requires an existing workdir; '{}' was not found.",
            wd
        )));
    }

    let fallback = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    log::debug!(
        "[Shell] 工作目录不存在: {}，回退到 {}",
        wd,
        fallback.display()
    );
    Ok(Some(fallback))
}

/// 执行 Shell 命令
///
/// 支持设置工作目录、超时时间、环境变量注入和后台执行。
/// 超时时会主动 kill 子进程，防止孤儿进程。
#[tauri::command]
pub async fn shell_execute(
    _state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    bg_registry: State<'_, BackgroundProcessRegistry>,
    command: String,
    workdir: Option<String>,
    timeout_secs: Option<u64>,
    background: Option<bool>,
    execution_id: Option<String>,
    sandbox_level: Option<String>,
    sandbox_network: Option<String>,
    sandbox_mode: Option<String>,
    process_lifecycle: Option<String>,
    network_scope: Option<String>,
    subject_type: Option<String>,
    subject_id: Option<String>,
    env: Option<HashMap<String, String>>,
    network_direct_allowances: Option<Vec<NetworkDirectAllowance>>,
    network_direct_targets: Option<Vec<NetworkDirectTargetInfo>>,
    network_upload_confirmed: Option<bool>,
    network_sensitive_egress_confirmed: Option<bool>,
    network_remote_destructive_confirmed: Option<bool>,
    network_broker_credentials: Option<Vec<NetworkBrokerCredentialPolicy>>,
    app_container_filesystem_grants: Option<Vec<AppContainerFilesystemGrantRequest>>,
) -> CommandResult<ShellExecResult> {
    let started_at = Instant::now();
    let timeout_duration = resolve_shell_timeout_duration(timeout_secs)?;
    let is_background = background.unwrap_or(false);
    let app_container_filesystem_grants = app_container_filesystem_grants.unwrap_or_default();

    log::debug!("[Shell] 执行命令: {}", command);

    // ═══════════════════════════════════════════════════════════
    // 安全校验层 — 在命令 spawn 之前执行
    // ═══════════════════════════════════════════════════════════

    // 获取应用数据目录（用于加载自定义保护路径和 Trash Bin）
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    // 0. 先确定进程沙箱策略与最终工作目录，保证相对路径按真实执行位置判定。
    let sandbox_policy = ShellSandboxPolicy::from_execution_options(
        sandbox_level.as_deref(),
        sandbox_network.as_deref(),
        sandbox_mode.as_deref(),
        network_scope.as_deref(),
        process_lifecycle.as_deref(),
        is_background,
        &command,
        subject_type.as_deref(),
        subject_id,
    )?;
    let resolved_workdir = resolve_shell_workdir(workdir.as_deref(), &sandbox_policy)?;
    let resolved_workdir_string = resolved_workdir
        .as_ref()
        .map(|path| path.to_string_lossy().to_string());
    let effective_background =
        is_background && sandbox_policy.process_lifecycle().as_event_value() != "detachedLaunch";
    let controlled_browser_command = controlled_browser_runtime_command(&command);
    let allow_controlled_browser_runtime =
        browser_runtime_exception_allowed(&sandbox_policy, controlled_browser_command);
    let mut wfp_managed_egress_plan: Option<WfpManagedEgressExecutable> = None;
    let mut wfp_canary_observation: Option<WfpCanaryObservation> = None;

    // 1. 命令安全校验 — 绝对禁止命令 + 核心目录保护
    command_validator::validate_command_safety_with_workdir(
        &command,
        &app_data_dir,
        resolved_workdir.as_deref(),
    )?;

    // 1.5 脚本内容扫描 — 检测间接攻击（file_write 危险脚本 → exec 执行）
    command_validator::validate_script_content(&command, resolved_workdir_string.as_deref())?;

    // 1.6 进程沙箱策略 — 当前用于外部 Script Skill 的禁网预检与环境收口
    for event in sandbox_policy.pre_spawn_audit_events(
        &command,
        resolved_workdir_string.as_deref(),
        execution_id.as_deref(),
    ) {
        record_sandbox_audit_event(&app_handle, event);
    }
    if sandbox_policy.blocks_detached_launch() && !allow_controlled_browser_runtime {
        record_sandbox_audit_event(
            &app_handle,
            sandbox_policy.diagnostic_audit_event(
                &command,
                resolved_workdir_string.as_deref(),
                execution_id.as_deref(),
                "block",
                "detached_launch_blocked_in_sandbox_mode",
                Some(
                    sandbox_policy
                        .process_lifecycle()
                        .as_event_value()
                        .to_string(),
                ),
            ),
        );
        return Err(AppError::Forbidden(
            format!(
                "Sandbox block [detached_launch_blocked_in_sandbox_mode]: {} mode does not allow launching detached GUI applications.",
                sandbox_policy.sandbox_mode_event_value()
            ),
        ));
    }
    if sandbox_policy.process_lifecycle().as_event_value() == "detachedLaunch" {
        record_sandbox_audit_event(
            &app_handle,
            sandbox_policy.diagnostic_audit_event(
                &command,
                resolved_workdir_string.as_deref(),
                execution_id.as_deref(),
                "allow",
                "detached_launch_allowed",
                Some("detachedLaunch".to_string()),
            ),
        );
    }
    if let Some(matched_pattern) = (!allow_controlled_browser_runtime)
        .then(|| {
            sandbox_policy.blocked_desktop_interaction(&command, resolved_workdir_string.as_deref())
        })
        .flatten()
    {
        record_sandbox_audit_event(
            &app_handle,
            sandbox_policy.diagnostic_audit_event(
                &command,
                resolved_workdir_string.as_deref(),
                execution_id.as_deref(),
                "block",
                "desktop_interaction_blocked_in_sandbox_mode",
                Some(matched_pattern),
            ),
        );
        return Err(AppError::Forbidden(
            format!(
                "Sandbox block [desktop_interaction_blocked_in_sandbox_mode]: {} mode does not allow general desktop GUI control, hotkeys, screenshots, or window activation. Use the controlled agent-browser runtime in ControlledNetwork, or switch to LocalAudit mode for general desktop automation.",
                sandbox_policy.sandbox_mode_event_value()
            ),
        ));
    }
    sandbox_policy.validate_pre_spawn(&command, resolved_workdir_string.as_deref())?;
    if sandbox_policy.uses_broker_preferred_network_guard() {
        if let Some(network_intent) =
            detect_network_intent(&command, resolved_workdir_string.as_deref())
        {
            let credential_context =
                network_risk_credential_context(network_broker_credentials.as_deref());
            if let Some(destructive_signal) = detect_network_remote_destructive_signal(
                &command,
                resolved_workdir_string.as_deref(),
            ) {
                if network_remote_destructive_confirmed.unwrap_or(false) {
                    let mut event = sandbox_policy.diagnostic_audit_event_with_backend(
                        &command,
                        resolved_workdir_string.as_deref(),
                        execution_id.as_deref(),
                        "audit",
                        "network_remote_destructive_confirmed",
                        Some(format!(
                            "{}; networkIntent={}; confirmation=currentExecution",
                            destructive_signal.audit_detail(),
                            network_intent
                        )),
                        "broker",
                    );
                    event.guard_mode = Some("auditOnly".to_string());
                    apply_network_risk_audit_fields(
                        &mut event,
                        destructive_signal.risk_class,
                        destructive_signal.kind,
                        credential_context,
                    );
                    record_sandbox_audit_event(&app_handle, event);
                } else {
                    let mut event = sandbox_policy.diagnostic_audit_event_with_backend(
                        &command,
                        resolved_workdir_string.as_deref(),
                        execution_id.as_deref(),
                        "block",
                        "network_remote_destructive_confirmation_required",
                        Some(format!(
                            "{}; networkIntent={}",
                            destructive_signal.audit_detail(),
                            network_intent
                        )),
                        "broker",
                    );
                    event.guard_mode = Some("hardBlock".to_string());
                    apply_network_risk_audit_fields(
                        &mut event,
                        destructive_signal.risk_class,
                        destructive_signal.kind,
                        credential_context,
                    );
                    record_sandbox_audit_event(&app_handle, event);
                    return Err(AppError::Forbidden(format!(
                        "Sandbox block [network_remote_destructive_confirmation_required]: high-confidence remote destructive operation signal detected in controlled-network mode ({}). Confirm this one execution before retrying.",
                        destructive_signal.kind
                    )));
                }
            }
            if let Some(signal) =
                detect_network_proxy_bypass_signal(&command, resolved_workdir_string.as_deref())
            {
                let direct_allowances = network_direct_allowances.as_deref().unwrap_or(&[]);
                let mut direct_audit_allowed = false;
                if signal.kind == "nonHttpOrRawSocket" {
                    let mut direct_targets =
                        detect_network_direct_targets(&command, resolved_workdir_string.as_deref());
                    if direct_targets.is_empty() {
                        direct_targets =
                            direct_targets_from_explicit_infos(network_direct_targets.as_deref());
                    }
                    if direct_targets.is_empty() {
                        let required_protocols = required_network_direct_protocols(
                            &command,
                            resolved_workdir_string.as_deref(),
                        );
                        direct_targets = direct_targets_from_allowances_for_protocols(
                            &required_protocols,
                            direct_allowances,
                        );
                    }

                    if let Some(matched_allowances) = sandbox_policy
                        .matching_network_direct_allowances(&direct_targets, direct_allowances)
                    {
                        let direct_target_risks =
                            resolve_network_direct_target_risks(&direct_targets).await;
                        for ((target, allowance), risk) in direct_targets
                            .iter()
                            .zip(matched_allowances.iter())
                            .zip(direct_target_risks.iter())
                        {
                            if risk.risk == "metadata" {
                                let mut event = sandbox_policy.diagnostic_audit_event(
                                    &command,
                                    resolved_workdir_string.as_deref(),
                                    execution_id.as_deref(),
                                    "block",
                                    "network_direct_metadata_target_blocked",
                                    Some(format!(
                                        "{}; allowanceId={}; target={}; {}",
                                        signal.audit_detail(),
                                        allowance.id,
                                        target.audit_detail(),
                                        risk.audit_detail()
                                    )),
                                );
                                event.target_host = Some(target.host.clone());
                                event.target_port = Some(target.port);
                                event.network_protocol = Some(target.protocol.clone());
                                event.guard_mode = Some("hardBlock".to_string());
                                record_sandbox_audit_event(&app_handle, event);
                                return Err(AppError::Forbidden(format!(
                                    "Sandbox block [network_direct_metadata_target_blocked]: ControlledNetwork does not allow direct-audit for metadata targets ({}).",
                                    target.audit_detail()
                                )));
                            }
                            if risk.risk == "private"
                                && network_direct_allowance_is_session(allowance)
                            {
                                let mut event = sandbox_policy.diagnostic_audit_event(
                                    &command,
                                    resolved_workdir_string.as_deref(),
                                    execution_id.as_deref(),
                                    "block",
                                    "network_direct_private_session_scope_blocked",
                                    Some(format!(
                                        "{}; allowanceId={}; target={}; {}",
                                        signal.audit_detail(),
                                        allowance.id,
                                        target.audit_detail(),
                                        risk.audit_detail()
                                    )),
                                );
                                event.target_host = Some(target.host.clone());
                                event.target_port = Some(target.port);
                                event.network_protocol = Some(target.protocol.clone());
                                event.guard_mode = Some("hardBlock".to_string());
                                record_sandbox_audit_event(&app_handle, event);
                                return Err(AppError::Forbidden(format!(
                                    "Sandbox block [network_direct_private_session_scope_blocked]: private or local direct-audit targets only allow currentExecution scope ({}).",
                                    target.audit_detail()
                                )));
                            }
                        }
                        for ((target, allowance), risk) in direct_targets
                            .iter()
                            .zip(matched_allowances.iter())
                            .zip(direct_target_risks.iter())
                        {
                            let mut event = sandbox_policy.diagnostic_audit_event(
                                &command,
                                resolved_workdir_string.as_deref(),
                                execution_id.as_deref(),
                                "audit",
                                "network_direct_audit_allowed",
                                Some(format!(
                                    "{}; allowanceId={}; target={}; {}",
                                    signal.audit_detail(),
                                    allowance.id,
                                    target.audit_detail(),
                                    risk.audit_detail()
                                )),
                            );
                            event.target_host = Some(target.host.clone());
                            event.target_port = Some(target.port);
                            event.network_protocol = Some(target.protocol.clone());
                            event.guard_mode = Some("directAuditAllowed".to_string());
                            record_sandbox_audit_event(&app_handle, event);
                        }
                        log::info!(
                            "[Shell] ControlledNetwork direct-audit allowance matched for {} target(s)",
                            direct_targets.len()
                        );
                        // Direct-audit allowances intentionally do not claim broker coverage.
                        // Continue into normal shell execution with the command fully audited.
                        direct_audit_allowed = true;
                    }
                }

                if !direct_audit_allowed {
                    let backend = if wfp_app_id_guard_requested(&sandbox_policy) {
                        "wfpEnhanced"
                    } else {
                        "broker"
                    };
                    let mut event = sandbox_policy.diagnostic_audit_event_with_backend(
                        &command,
                        resolved_workdir_string.as_deref(),
                        execution_id.as_deref(),
                        "block",
                        "proxy_bypass_signal_blocked",
                        Some(format!(
                            "{}; networkIntent={}",
                            signal.audit_detail(),
                            network_intent
                        )),
                        backend,
                    );
                    event.guard_mode = Some("hardBlock".to_string());
                    if let Some(target) =
                        detect_network_direct_targets(&command, resolved_workdir_string.as_deref())
                            .into_iter()
                            .next()
                    {
                        event.target_host = Some(target.host);
                        event.target_port = Some(target.port);
                        event.network_protocol = Some(target.protocol);
                    }
                    record_sandbox_audit_event(&app_handle, event);
                    return Err(AppError::Forbidden(format!(
                        "Sandbox block [proxy_bypass_signal_blocked]: ControlledNetwork requires HTTP(S) traffic to use the broker proxy, or an explicit direct-audit allowance for non-HTTP protocols; proxy bypass signal detected ({}).",
                        signal.kind
                    )));
                }
            }
            if let Some(upload_signal) =
                detect_network_upload_risk_signal(&command, resolved_workdir_string.as_deref())
            {
                if network_upload_confirmed.unwrap_or(false) {
                    let mut event = sandbox_policy.diagnostic_audit_event_with_backend(
                        &command,
                        resolved_workdir_string.as_deref(),
                        execution_id.as_deref(),
                        "audit",
                        "network_upload_risk_confirmed",
                        Some(format!(
                            "{}; networkIntent={}; confirmation=currentExecution",
                            upload_signal.audit_detail(),
                            network_intent
                        )),
                        "broker",
                    );
                    event.guard_mode = Some("auditOnly".to_string());
                    apply_network_risk_audit_fields(
                        &mut event,
                        "fileUpload",
                        upload_signal.kind,
                        credential_context,
                    );
                    record_sandbox_audit_event(&app_handle, event);
                } else {
                    let mut event = sandbox_policy.diagnostic_audit_event_with_backend(
                        &command,
                        resolved_workdir_string.as_deref(),
                        execution_id.as_deref(),
                        "block",
                        "network_upload_confirmation_required",
                        Some(format!(
                            "{}; networkIntent={}",
                            upload_signal.audit_detail(),
                            network_intent
                        )),
                        "broker",
                    );
                    event.guard_mode = Some("hardBlock".to_string());
                    apply_network_risk_audit_fields(
                        &mut event,
                        "fileUpload",
                        upload_signal.kind,
                        credential_context,
                    );
                    record_sandbox_audit_event(&app_handle, event);
                    return Err(AppError::Forbidden(format!(
                        "Sandbox block [network_upload_confirmation_required]: high-confidence file upload signal detected in controlled-network mode ({}). Confirm this one execution before retrying.",
                        upload_signal.kind
                    )));
                }
            }
            if let Some(sensitive_signal) =
                detect_network_sensitive_egress_signal(&command, resolved_workdir_string.as_deref())
            {
                if network_sensitive_egress_confirmed.unwrap_or(false) {
                    let mut event = sandbox_policy.diagnostic_audit_event_with_backend(
                        &command,
                        resolved_workdir_string.as_deref(),
                        execution_id.as_deref(),
                        "audit",
                        "network_sensitive_egress_confirmed",
                        Some(format!(
                            "{}; networkIntent={}; confirmation=currentExecution",
                            sensitive_signal.audit_detail(),
                            network_intent
                        )),
                        "broker",
                    );
                    event.guard_mode = Some("auditOnly".to_string());
                    apply_network_risk_audit_fields(
                        &mut event,
                        sensitive_signal.risk_class,
                        sensitive_signal.kind,
                        credential_context,
                    );
                    record_sandbox_audit_event(&app_handle, event);
                } else {
                    let mut event = sandbox_policy.diagnostic_audit_event_with_backend(
                        &command,
                        resolved_workdir_string.as_deref(),
                        execution_id.as_deref(),
                        "block",
                        "network_sensitive_egress_confirmation_required",
                        Some(format!(
                            "{}; networkIntent={}",
                            sensitive_signal.audit_detail(),
                            network_intent
                        )),
                        "broker",
                    );
                    event.guard_mode = Some("hardBlock".to_string());
                    apply_network_risk_audit_fields(
                        &mut event,
                        sensitive_signal.risk_class,
                        sensitive_signal.kind,
                        credential_context,
                    );
                    record_sandbox_audit_event(&app_handle, event);
                    return Err(AppError::Forbidden(format!(
                        "Sandbox block [network_sensitive_egress_confirmation_required]: high-confidence sensitive data egress signal detected in controlled-network mode ({}). Confirm this one execution before retrying.",
                        sensitive_signal.kind
                    )));
                }
            }
        }
    }
    if sandbox_policy.uses_restricted_process_backend() && command_uses_python_runtime(&command) {
        let external_roots = venv_external_base_roots(&app_data_dir);
        if !external_roots.is_empty() {
            record_sandbox_audit_event(
                &app_handle,
                sandbox_policy.diagnostic_audit_event(
                    &command,
                    resolved_workdir_string.as_deref(),
                    execution_id.as_deref(),
                    "block",
                    "python_runtime_not_sandbox_compatible",
                    Some(external_roots.join(";")),
                ),
            );
            return Err(AppError::Forbidden(
                "Sandbox block: the Python runtime is not sandbox-compatible because its venv depends on host Python outside the AgentVis runtime. Rebuild the AgentVis Python runtime before running Python in OfflineIsolated modes."
                    .to_string(),
            ));
        }
    }

    // 2. 删除命令拦截 — 重写为移动到 Agent Trash Bin
    let delete_allowed_roots =
        sandbox_delete_allowed_roots(&app_data_dir, resolved_workdir.as_deref(), &sandbox_policy);
    match trash_bin::try_intercept_delete_scoped(
        &command,
        &app_data_dir,
        resolved_workdir.as_deref(),
        delete_allowed_roots.as_deref(),
    ) {
        Ok(Some(message)) => {
            // 删除命令已被拦截并移动到回收站，返回成功结果
            return Ok(shell_exec_result(
                0,
                message,
                String::new(),
                None,
                started_at,
                Some(timeout_duration),
                false,
                false,
            ));
        }
        Ok(None) => {
            // 非删除命令或无法解析，继续正常执行
        }
        Err(e) => {
            // 拦截过程出错，报告错误但不继续执行原始删除命令
            return Err(e);
        }
    }
    if let Some(ref wd) = workdir {
        log::debug!("[Shell] 工作目录: {}", wd);
    }
    if wfp_canary_requested(&sandbox_policy) && !wfp_app_id_guard_requested(&sandbox_policy) {
        wfp_canary_observation = record_wfp_canary_preflight(
            &app_handle,
            &app_data_dir,
            &sandbox_policy,
            &command,
            resolved_workdir_string.as_deref(),
            execution_id.as_deref(),
            effective_background,
            env.as_ref(),
        )
        .await;
    }

    if wfp_app_id_guard_requested(&sandbox_policy) {
        if let Some(network_intent) =
            detect_network_intent(&command, resolved_workdir_string.as_deref())
        {
            if effective_background {
                record_sandbox_audit_event(
                &app_handle,
                sandbox_policy.wfp_diagnostic_audit_event(
                    &command,
                    resolved_workdir_string.as_deref(),
                    execution_id.as_deref(),
                    "block",
                    "wfp_managed_egress_background_unsupported",
                    Some(
                        "per-run WFP managed executable guard currently supports foreground commands only"
                            .to_string(),
                    ),
                ),
            );
                return Err(AppError::Forbidden(
                "Sandbox block: WFP per-run egress guard currently supports foreground commands only."
                    .to_string(),
            ));
            }

            let mut readiness = inspect_wfp_guard_readiness(&app_handle, &app_data_dir).await;
            record_sandbox_audit_event(
                &app_handle,
                sandbox_policy.wfp_diagnostic_audit_event(
                    &command,
                    resolved_workdir_string.as_deref(),
                    execution_id.as_deref(),
                    if readiness.ready {
                        "diagnostic"
                    } else {
                        "block"
                    },
                    readiness.reason,
                    readiness.detail.clone(),
                ),
            );
            if !readiness.ready && readiness.reason == "wfp_helper_inspect_residual_detected" {
                let cleanup = cleanup_wfp_guard_residual(&app_handle, &app_data_dir).await;
                record_sandbox_audit_event(
                    &app_handle,
                    sandbox_policy.wfp_diagnostic_audit_event(
                        &command,
                        resolved_workdir_string.as_deref(),
                        execution_id.as_deref(),
                        if cleanup.ready { "diagnostic" } else { "block" },
                        cleanup.reason,
                        cleanup.detail.clone(),
                    ),
                );

                if cleanup.ready {
                    readiness = inspect_wfp_guard_readiness(&app_handle, &app_data_dir).await;
                    record_sandbox_audit_event(
                        &app_handle,
                        sandbox_policy.wfp_diagnostic_audit_event(
                            &command,
                            resolved_workdir_string.as_deref(),
                            execution_id.as_deref(),
                            if readiness.ready {
                                "diagnostic"
                            } else {
                                "block"
                            },
                            readiness.reason,
                            readiness.detail.clone(),
                        ),
                    );
                }
            }
            if !readiness.ready {
                return Err(AppError::Forbidden(format!(
                    "Sandbox block: WFP per-run egress guard is not ready: {}.",
                    readiness.reason
                )));
            }

            match prepare_wfp_managed_egress_executable(&app_data_dir, &command, env.as_ref()) {
                Ok(Some(plan)) => {
                    record_sandbox_audit_event(
                        &app_handle,
                        sandbox_policy.wfp_diagnostic_audit_event(
                            &command,
                            resolved_workdir_string.as_deref(),
                            execution_id.as_deref(),
                            "diagnostic",
                            "wfp_managed_egress_executable_prepared",
                            Some(wfp_managed_egress_audit_detail(&plan)),
                        ),
                    );
                    wfp_managed_egress_plan = Some(plan);
                }
                Ok(None) => {
                    if wfp_proxy_preferred_fallback_allowed(
                        &command,
                        resolved_workdir_string.as_deref(),
                        env.as_ref(),
                    ) {
                        record_sandbox_audit_event(
                            &app_handle,
                            sandbox_policy.wfp_diagnostic_audit_event(
                                &command,
                                resolved_workdir_string.as_deref(),
                                execution_id.as_deref(),
                                "diagnostic",
                                "wfp_proxy_preferred_fallback_allowed",
                                Some(format!(
                                    "networkIntent={}; fallback=brokerProxyPreferred; eligibleFirstTokens=curl,node,git,npm,npx,pip,pip3,uv",
                                    network_intent
                                )),
                            ),
                        );
                    } else {
                        record_sandbox_audit_event(
                            &app_handle,
                            sandbox_policy.wfp_diagnostic_audit_event(
                                &command,
                                resolved_workdir_string.as_deref(),
                                execution_id.as_deref(),
                                "block",
                                "wfp_managed_egress_no_eligible_command",
                                Some(format!(
                                    "networkIntent={}; eligibleFirstTokens=curl,node,git,npm,npx,pip,pip3,uv",
                                    network_intent
                                )),
                            ),
                        );
                        return Err(AppError::Forbidden(
                            "Sandbox block: WFP per-run egress guard requires an eligible managed executable first token (curl, node, git, npm, npx, pip, pip3, or uv), or a known broker-proxy-aware HTTP(S) Python skill, for network-intent commands."
                                .to_string(),
                        ));
                    }
                }
                Err(error) => {
                    record_sandbox_audit_event(
                        &app_handle,
                        sandbox_policy.wfp_diagnostic_audit_event(
                            &command,
                            resolved_workdir_string.as_deref(),
                            execution_id.as_deref(),
                            "block",
                            "wfp_managed_egress_prepare_failed",
                            Some(truncate_audit_detail(error.to_string())),
                        ),
                    );
                    return Err(error);
                }
            }
        } else {
            log::debug!(
                "[Shell] WFP per-run egress guard skipped for local-only command: {}",
                command
            );
        }
    }

    if let Some(ref wd) = resolved_workdir {
        log::debug!("[Shell] resolved workdir: {}", wd.display());
    }

    // 构建命令
    // Windows: 使用 cmd /S /C "..." 执行命令
    // /S 标志强制 cmd.exe 严格剥离最外层引号对，保留内部引号语义
    // raw_arg 避免 Rust 自动对含引号的参数添加额外引号层
    // chcp 65001: 切换 cmd 到 UTF-8 代码页，解决中文文件名被损坏为 ???????? 的问题
    // CREATE_NO_WINDOW (0x08000000): 禁止 cmd.exe 创建可见控制台窗口
    #[cfg(target_os = "windows")]
    let mut cmd = {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut c = Command::new("cmd");
        c.raw_arg(build_windows_shell_raw_arg(&command));
        c.creation_flags(CREATE_NO_WINDOW);
        c
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.arg("-c").arg(&command);
        c
    };

    let mut restricted_env_overrides = HashMap::new();

    // 设置工作目录（已在安全校验前完成存在性验证和回退解析）
    if let Some(ref wd) = resolved_workdir {
        cmd.current_dir(wd);
    }

    // 注入用户指定的环境变量（非 PATH 部分，PATH 在下方统一处理）
    if let Some(ref env_map) = env {
        for (key, value) in env_map {
            // PATH 留给下方累积构建块处理，其余直接注入
            if key != "PATH" && key != "__AGENTVIS_VENV_SCRIPTS_DIR__" {
                set_command_env(
                    &mut cmd,
                    &mut restricted_env_overrides,
                    key.clone(),
                    value.clone(),
                );
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // PATH 累积构建块
    //
    // 历史问题：PATH 曾在多处独立调用 cmd.env("PATH", ...)，
    // 每次调用都会覆盖上一次的结果，导致内嵌 Node.js 目录
    // 被 LibreOffice 等后续注入抹除，进而使 npm 命令找不到。
    //
    // 修复：在此处一次性完成所有 PATH 变更，按优先级顺序：
    //   [VENV Scripts（最高）] ; [系统 PATH] ; [内嵌 Node] ; [额外工具]
    // ═══════════════════════════════════════════════════════════
    {
        let system_path = std::env::var("PATH").unwrap_or_default();
        // 前置项（优先级高于系统 PATH）
        let mut path_prefix: Vec<String> = Vec::new();
        // 后置项（作为 fallback，低于系统 PATH）
        let mut path_suffix: Vec<String> = Vec::new();
        let mut has_venv_prefix = false;

        if let Some(plan) = &wfp_managed_egress_plan {
            path_prefix.push(plan.managed_dir.to_string_lossy().to_string());
            log::debug!(
                "[Shell] WFP managed egress directory prepended to PATH: {}",
                plan.managed_dir.display()
            );
        }

        // 1. VENV Scripts 前置：确保裸 python 命令解析到 venv Python
        if let Some(ref env_map) = env {
            if let Some(venv_dir) = env_map.get("__AGENTVIS_VENV_SCRIPTS_DIR__") {
                if !venv_dir.is_empty() && std::path::Path::new(venv_dir).exists() {
                    push_venv_path_prefixes(&mut path_prefix, venv_dir);
                    has_venv_prefix = true;
                    log::debug!("[Shell] venv Scripts 目录已前置注入 PATH: {}", venv_dir);
                }
            }
        }
        if !has_venv_prefix && sandbox_policy.should_prepend_default_venv_path() {
            if let Some(venv_dir) = default_venv_scripts_dir(&app_data_dir) {
                push_venv_path_prefixes(&mut path_prefix, &venv_dir);
                log::debug!(
                    "[Shell] default venv Scripts directory prepended to PATH: {}",
                    venv_dir
                );
            }
        }

        // 2. 内嵌 Node.js 后置：系统 Node.js 的 fallback（新电脑开箱即用）
        #[cfg(target_os = "windows")]
        if let Some(node_dir) = super::embedded_node_setup::get_embedded_node_bin_dir(&app_data_dir)
        {
            // 使用系统 PATH 做去重检查（大小写不敏感）
            if !system_path
                .to_lowercase()
                .contains(&node_dir.to_lowercase())
            {
                path_suffix.push(node_dir.clone());
                log::debug!("[Shell] 内嵌 Node.js 将追加到 PATH: {}", node_dir);
            }
        }

        // 3. 额外工具后置（LibreOffice 等）
        for extra in discover_extra_tool_paths() {
            path_suffix.push(extra);
        }

        // 仅在有变更时才设置 PATH（避免不必要的 env 污染）
        if !path_prefix.is_empty() || !path_suffix.is_empty() {
            let mut parts: Vec<&str> = Vec::new();
            for p in &path_prefix {
                parts.push(p.as_str());
            }
            parts.push(system_path.as_str());
            for p in &path_suffix {
                parts.push(p.as_str());
            }
            let final_path = parts.join(";");
            set_command_env(&mut cmd, &mut restricted_env_overrides, "PATH", final_path);
            log::debug!(
                "[Shell] PATH 已更新（prefix={}, suffix={}）",
                path_prefix.len(),
                path_suffix.len()
            );
        }
    }

    // 注入 PYTHONUTF8 / NODE_PATH（不涉及 PATH，安全）
    enrich_process_env(&mut cmd, env.as_ref(), &mut restricted_env_overrides);

    if sandbox_policy.uses_restricted_process_backend() {
        apply_sandbox_profile_env(&mut cmd, &mut restricted_env_overrides, &app_data_dir)?;
        if sandbox_policy.network_isolation() == SandboxNetworkIsolation::AuditOnly {
            apply_appcontainer_direct_network_env(&mut cmd, &mut restricted_env_overrides);
        }
    }

    let controlled_browser_needs_new_proxy = allow_controlled_browser_runtime
        && controlled_browser_command == Some(ControlledBrowserRuntimeCommand::StartOrEnsure)
        && persistent_controlled_browser_proxy_env().is_none();
    let broker_proxy_required = sandbox_policy.uses_broker_preferred_network_guard()
        && (broker_proxy_required_for_network_intent(&command, resolved_workdir_string.as_deref())
            || controlled_browser_needs_new_proxy);
    let mut pending_controlled_browser_network_session: Option<NetworkRuntimeSession> = None;
    let network_session = if allow_controlled_browser_runtime {
        match controlled_browser_command {
            Some(ControlledBrowserRuntimeCommand::StartOrEnsure)
            | Some(ControlledBrowserRuntimeCommand::Control) => {
                if let Some(values) = persistent_controlled_browser_proxy_env() {
                    apply_controlled_browser_proxy_env_values(
                        &mut cmd,
                        &mut restricted_env_overrides,
                        &values,
                    );
                    let mut event = sandbox_policy.diagnostic_audit_event_with_backend(
                        &command,
                        resolved_workdir_string.as_deref(),
                        execution_id.as_deref(),
                        "diagnostic",
                        "controlled_browser_proxy_session_reused",
                        Some(format!("proxyServer={}", values.browser_proxy_server)),
                        "broker",
                    );
                    event.guard_mode = Some("auditOnly".to_string());
                    record_sandbox_audit_event(&app_handle, event);
                    None
                } else if controlled_browser_command
                    == Some(ControlledBrowserRuntimeCommand::Control)
                {
                    let mut event = sandbox_policy.diagnostic_audit_event_with_backend(
                        &command,
                        resolved_workdir_string.as_deref(),
                        execution_id.as_deref(),
                        "block",
                        "controlled_browser_proxy_session_missing",
                        Some("agent-browser CDP commands in ControlledNetwork require an AgentVis controlled browser runtime started in this app session".to_string()),
                        "broker",
                    );
                    event.guard_mode = Some("hardBlock".to_string());
                    record_sandbox_audit_event(&app_handle, event);
                    return Err(AppError::Forbidden(
                        "Sandbox block [controlled_browser_proxy_session_missing]: controlled-network browser commands require starting the AgentVis browser runtime in this app session before using CDP commands."
                            .to_string(),
                    ));
                } else {
                    let prepared = prepare_network_broker_session_env(
                        &mut cmd,
                        &mut restricted_env_overrides,
                        &app_handle,
                        &app_data_dir,
                        &sandbox_policy,
                        env.as_ref(),
                        &command,
                        resolved_workdir_string.as_deref(),
                        execution_id.as_deref(),
                        true,
                        false,
                        network_broker_credentials.as_deref(),
                    )
                    .await?;
                    if let Some(values) = prepared
                        .as_ref()
                        .and_then(NetworkRuntimeSession::proxy_env_values)
                    {
                        apply_controlled_browser_proxy_env_values(
                            &mut cmd,
                            &mut restricted_env_overrides,
                            &values,
                        );
                    }
                    pending_controlled_browser_network_session = prepared;
                    None
                }
            }
            Some(ControlledBrowserRuntimeCommand::Stop)
            | Some(ControlledBrowserRuntimeCommand::Status)
            | None => None,
        }
    } else {
        prepare_network_broker_session_env(
            &mut cmd,
            &mut restricted_env_overrides,
            &app_handle,
            &app_data_dir,
            &sandbox_policy,
            env.as_ref(),
            &command,
            resolved_workdir_string.as_deref(),
            execution_id.as_deref(),
            broker_proxy_required,
            true,
            network_broker_credentials.as_deref(),
        )
        .await?
    };
    let wfp_allowed_loopback_port = if wfp_managed_egress_plan.is_some() {
        network_session
            .as_ref()
            .and_then(NetworkRuntimeSession::proxy_port)
    } else {
        None
    };

    // 沙箱环境变量必须最后注入，避免被外部调用参数覆盖。
    sandbox_policy.apply_environment(&mut cmd);
    for (key, value) in sandbox_policy.environment_overrides() {
        restricted_env_overrides.insert(key.to_string(), value.to_string());
    }
    if let Some(plan) = &wfp_managed_egress_plan {
        set_command_env(
            &mut cmd,
            &mut restricted_env_overrides,
            NETWORK_GUARD_BACKEND_ENV,
            "wfpPerRunAppIdBlock",
        );
        set_command_env(
            &mut cmd,
            &mut restricted_env_overrides,
            "AGENTVIS_NETWORK_EGRESS_GUARD_MODE",
            "wfpAppIdBlock",
        );
        set_command_env(
            &mut cmd,
            &mut restricted_env_overrides,
            "AGENTVIS_NETWORK_EGRESS_GUARD_TARGET",
            plan.command_name.clone(),
        );
        set_command_env(
            &mut cmd,
            &mut restricted_env_overrides,
            "AGENTVIS_NETWORK_EGRESS_GUARD_IDENTITY",
            "managedExe",
        );
        set_command_env(
            &mut cmd,
            &mut restricted_env_overrides,
            "AGENTVIS_NETWORK_DIRECT_ACCESS",
            "blocked",
        );
        if let Some(port) = wfp_allowed_loopback_port {
            set_command_env(
                &mut cmd,
                &mut restricted_env_overrides,
                "AGENTVIS_NETWORK_EGRESS_GUARD_LOOPBACK_PORT",
                port.to_string(),
            );
        }
    }

    if sandbox_policy.uses_restricted_process_backend() {
        if effective_background {
            return Err(AppError::Forbidden(
                "Sandbox block: restricted shell execution currently supports foreground commands only."
                    .to_string(),
            ));
        }

        #[cfg(target_os = "windows")]
        {
            let shell_command = build_windows_shell_command(&command);
            match sandbox_policy.restricted_execution_backend() {
                RestrictedExecutionBackend::RestrictedToken => {
                    return run_restricted_foreground_shell(
                        &command,
                        shell_command,
                        resolved_workdir,
                        restricted_env_overrides,
                        timeout_duration,
                        execution_id.clone(),
                    )
                    .await;
                }
                RestrictedExecutionBackend::AppContainerFilesystem => {
                    let Some(workdir) = resolved_workdir else {
                        return Err(AppError::Forbidden(
                            "Sandbox block: AppContainer restricted shell execution requires an existing workdir."
                                .to_string(),
                        ));
                    };
                    return run_appcontainer_foreground_shell(
                        &command,
                        shell_command,
                        workdir,
                        appcontainer_app_managed_roots(&app_data_dir),
                        app_container_filesystem_grants,
                        restricted_env_overrides,
                        &sandbox_policy,
                        timeout_duration,
                        execution_id.clone(),
                    )
                    .await;
                }
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            return Err(AppError::Forbidden(
                "Sandbox block: restricted shell execution is only available on Windows."
                    .to_string(),
            ));
        }
    }

    // 设置标准 I/O
    // stdin 显式设为 null（而非继承 GUI 进程的关闭句柄）：
    // Tauri 作为 GUI 应用，父进程的 stdin 是无效/关闭的。若子进程继承该无效句柄，
    // 某些交互式命令（如 `npm create vite@latest` 的 "Ok to proceed? (y)"、
    // `winget install` 的确认提示）会无限期挂起等待输入，直到命令超时。
    // 显式 null 后，子进程读取 stdin 会立即收到 EOF，从而快速报错退出，
    // Agent 可在下一轮看到错误信息并自动修正（如补充 -y / --yes 参数）。
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // 后台执行模式：启动进程后立即返回，保存 PID 用于后续 kill
    if effective_background {
        match cmd.spawn() {
            Ok(mut child) => {
                let sandbox = attach_process_sandbox(&mut child, &command, &sandbox_policy).await?;
                let pid = bg_registry.register(child, sandbox, network_session);
                log::debug!("[Shell] Background process started, PID={:?}", pid);
                record_wfp_canary_actual_result(
                    &app_handle,
                    &sandbox_policy,
                    &command,
                    resolved_workdir_string.as_deref(),
                    execution_id.as_deref(),
                    wfp_canary_observation.as_ref(),
                    "background_started",
                    None,
                );
                return Ok(shell_exec_result(
                    0,
                    "Background process started".to_string(),
                    String::new(),
                    pid,
                    started_at,
                    Some(timeout_duration),
                    false,
                    false,
                ));
            }
            Err(e) => {
                record_wfp_canary_actual_result(
                    &app_handle,
                    &sandbox_policy,
                    &command,
                    resolved_workdir_string.as_deref(),
                    execution_id.as_deref(),
                    wfp_canary_observation.as_ref(),
                    "background_spawn_failed",
                    None,
                );
                return Err(AppError::Generic(format!(
                    "Failed to start background process: {}",
                    e
                )));
            }
        }
    }

    // 前台执行：spawn 后取出 stdout/stderr handle，再用 child.wait() 等待退出。
    // 不使用 wait_with_output()（会消费 self 所有权），
    // 这样超时时仍能调用 child.kill() 终止进程。
    let network_session = network_session;
    let mut wfp_managed_guard_session = if let Some(plan) = &wfp_managed_egress_plan {
        match start_wfp_managed_egress_guard_session(
            &app_handle,
            &app_data_dir,
            plan,
            timeout_duration,
            wfp_allowed_loopback_port,
        )
        .await
        {
            Ok(session) => {
                record_sandbox_audit_event(
                    &app_handle,
                    sandbox_policy.wfp_diagnostic_audit_event(
                        &command,
                        resolved_workdir_string.as_deref(),
                        execution_id.as_deref(),
                        "diagnostic",
                        "wfp_managed_egress_session_started",
                        Some(session.audit_detail()),
                    ),
                );
                Some(session)
            }
            Err(error) => {
                record_sandbox_audit_event(
                    &app_handle,
                    sandbox_policy.wfp_diagnostic_audit_event(
                        &command,
                        resolved_workdir_string.as_deref(),
                        execution_id.as_deref(),
                        "block",
                        "wfp_managed_egress_session_start_failed",
                        Some(truncate_audit_detail(error.to_string())),
                    ),
                );
                return Err(error);
            }
        }
    } else {
        None
    };

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            stop_wfp_managed_guard_session(
                &mut wfp_managed_guard_session,
                &app_handle,
                &sandbox_policy,
                &command,
                resolved_workdir_string.as_deref(),
                execution_id.as_deref(),
                "spawn_failed",
            )
            .await;
            record_wfp_canary_actual_result(
                &app_handle,
                &sandbox_policy,
                &command,
                resolved_workdir_string.as_deref(),
                execution_id.as_deref(),
                wfp_canary_observation.as_ref(),
                "spawn_failed",
                None,
            );
            return Err(AppError::Generic(format!("Failed to start command: {}", e)));
        }
    };
    let sandbox = match attach_process_sandbox(&mut child, &command, &sandbox_policy).await {
        Ok(sandbox) => sandbox,
        Err(error) => {
            terminate_child_tree(&mut child, None).await;
            stop_wfp_managed_guard_session(
                &mut wfp_managed_guard_session,
                &app_handle,
                &sandbox_policy,
                &command,
                resolved_workdir_string.as_deref(),
                execution_id.as_deref(),
                "sandbox_attach_failed",
            )
            .await;
            record_wfp_canary_actual_result(
                &app_handle,
                &sandbox_policy,
                &command,
                resolved_workdir_string.as_deref(),
                execution_id.as_deref(),
                wfp_canary_observation.as_ref(),
                "sandbox_attach_failed",
                None,
            );
            return Err(error);
        }
    };

    // 先取出 pipe handle，child.wait() 不需要它们
    let child_stdout = child.stdout.take();
    let child_stderr = child.stderr.take();

    let cancel_rx = if let Some(ref id) = execution_id {
        let (tx, rx) = oneshot::channel();
        foreground_cancel_registry()
            .lock()
            .await
            .insert(id.clone(), tx);
        if foreground_cancel_requests().lock().await.remove(id) {
            if let Some(tx) = foreground_cancel_registry().lock().await.remove(id) {
                let _ = tx.send(());
            }
        }
        Some(rx)
    } else {
        None
    };

    // 使用 spawn 创建独立 IO 读取任务——与 child.wait() 并发运行
    // 必须并发：避免进程写满管道缓冲区时 child.wait() 死锁
    let stdout_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut r) = child_stdout {
            let _ = tokio::io::AsyncReadExt::read_to_end(&mut r, &mut buf).await;
        }
        buf
    });
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut r) = child_stderr {
            let _ = tokio::io::AsyncReadExt::read_to_end(&mut r, &mut buf).await;
        }
        buf
    });

    enum ForegroundOutcome {
        Exited(std::io::Result<std::process::ExitStatus>),
        TimedOut,
        Cancelled,
    }

    let outcome = if let Some(mut rx) = cancel_rx {
        tokio::select! {
            status = child.wait() => ForegroundOutcome::Exited(status),
            _ = tokio::time::sleep(timeout_duration) => {
                terminate_child_tree(&mut child, Some(&sandbox)).await;
                ForegroundOutcome::TimedOut
            },
            _ = &mut rx => {
                terminate_child_tree(&mut child, Some(&sandbox)).await;
                ForegroundOutcome::Cancelled
            },
        }
    } else {
        match timeout(timeout_duration, child.wait()).await {
            Ok(status) => ForegroundOutcome::Exited(status),
            Err(_) => {
                terminate_child_tree(&mut child, Some(&sandbox)).await;
                ForegroundOutcome::TimedOut
            }
        }
    };

    if let Some(ref id) = execution_id {
        foreground_cancel_registry().lock().await.remove(id);
        foreground_cancel_requests().lock().await.remove(id);
    }

    match outcome {
        ForegroundOutcome::Exited(Ok(status)) => {
            // 进程已退出。正常情况下管道立即关闭，IO 任务瞬间完成。
            // 但 Windows 上 bat 脚本通过 start 启动的孙子进程可能继承管道句柄，
            // 导致 read_to_end 即使在父进程退出后仍不返回。
            // 设置 3 秒宽限期：正常命令不受影响，launcher 类脚本安全退出。
            let pipe_grace = Duration::from_secs(3);
            let stdout_bytes = match tokio::time::timeout(pipe_grace, stdout_task).await {
                Ok(Ok(bytes)) => bytes,
                Ok(Err(e)) => {
                    log::warn!("[Shell] stdout 读取任务异常: {}", e);
                    Vec::new()
                }
                Err(_) => {
                    log::debug!(
                        "[Shell] ⚠️ stdout 管道宽限期到达（孙子进程持有句柄），返回已收集的数据"
                    );
                    Vec::new()
                }
            };
            let stderr_bytes = match tokio::time::timeout(pipe_grace, stderr_task).await {
                Ok(Ok(bytes)) => bytes,
                Ok(Err(e)) => {
                    log::warn!("[Shell] stderr 读取任务异常: {}", e);
                    Vec::new()
                }
                Err(_) => {
                    log::debug!(
                        "[Shell] ⚠️ stderr 管道宽限期到达（孙子进程持有句柄），返回已收集的数据"
                    );
                    Vec::new()
                }
            };

            let exit_code = status.code().unwrap_or(-1);
            let stdout = decode_output(&stdout_bytes);
            let stderr = decode_output(&stderr_bytes);

            log::debug!("[Shell] 退出码: {}", exit_code);
            if !stdout.is_empty() {
                log::debug!("[Shell] stdout: {} 字符", stdout.len());
            }
            if !stderr.is_empty() {
                log::debug!("[Shell] stderr: {} 字符", stderr.len());
            }

            stop_wfp_managed_guard_session(
                &mut wfp_managed_guard_session,
                &app_handle,
                &sandbox_policy,
                &command,
                resolved_workdir_string.as_deref(),
                execution_id.as_deref(),
                "exited",
            )
            .await;
            record_wfp_canary_actual_result(
                &app_handle,
                &sandbox_policy,
                &command,
                resolved_workdir_string.as_deref(),
                execution_id.as_deref(),
                wfp_canary_observation.as_ref(),
                "exited",
                Some(exit_code),
            );
            if exit_code == 0 {
                match controlled_browser_command {
                    Some(ControlledBrowserRuntimeCommand::StartOrEnsure) => {
                        if let Some(session) = pending_controlled_browser_network_session.take() {
                            store_controlled_browser_network_session(session);
                            let mut event = sandbox_policy.diagnostic_audit_event_with_backend(
                                &command,
                                resolved_workdir_string.as_deref(),
                                execution_id.as_deref(),
                                "diagnostic",
                                "controlled_browser_proxy_session_persisted",
                                Some(
                                    "agent-browser controlled browser proxy session persisted"
                                        .to_string(),
                                ),
                                "broker",
                            );
                            event.guard_mode = Some("auditOnly".to_string());
                            record_sandbox_audit_event(&app_handle, event);
                        }
                    }
                    Some(ControlledBrowserRuntimeCommand::Stop) => {
                        clear_controlled_browser_network_session();
                        let mut event = sandbox_policy.diagnostic_audit_event_with_backend(
                            &command,
                            resolved_workdir_string.as_deref(),
                            execution_id.as_deref(),
                            "diagnostic",
                            "controlled_browser_proxy_session_cleared",
                            Some(
                                "agent-browser controlled browser proxy session cleared"
                                    .to_string(),
                            ),
                            "broker",
                        );
                        event.guard_mode = Some("auditOnly".to_string());
                        record_sandbox_audit_event(&app_handle, event);
                    }
                    _ => {}
                }
            }
            let broker_requests = network_session
                .as_ref()
                .map(NetworkRuntimeSession::broker_request_count)
                .unwrap_or(0);
            if exit_code == 0
                && broker_proxy_required
                && broker_requests == 0
                && !allow_controlled_browser_runtime
            {
                let mut event = sandbox_policy.diagnostic_audit_event_with_backend(
                    &command,
                    resolved_workdir_string.as_deref(),
                    execution_id.as_deref(),
                    "diagnostic",
                    "broker_proxy_expected_but_unused",
                    Some(broker_unused_diagnostic_detail(
                        &command,
                        resolved_workdir_string.as_deref(),
                        &stdout,
                        &stderr,
                    )),
                    "broker",
                );
                event.guard_mode = Some("auditOnly".to_string());
                record_sandbox_audit_event(&app_handle, event);
            }

            Ok(shell_exec_result(
                exit_code,
                stdout,
                stderr,
                None,
                started_at,
                Some(timeout_duration),
                false,
                false,
            ))
        }
        ForegroundOutcome::Exited(Err(e)) => {
            stdout_task.abort();
            stderr_task.abort();
            stop_wfp_managed_guard_session(
                &mut wfp_managed_guard_session,
                &app_handle,
                &sandbox_policy,
                &command,
                resolved_workdir_string.as_deref(),
                execution_id.as_deref(),
                "wait_failed",
            )
            .await;
            record_wfp_canary_actual_result(
                &app_handle,
                &sandbox_policy,
                &command,
                resolved_workdir_string.as_deref(),
                execution_id.as_deref(),
                wfp_canary_observation.as_ref(),
                "wait_failed",
                None,
            );
            Err(AppError::Generic(format!(
                "Command execution failed: {}",
                e
            )))
        }
        ForegroundOutcome::TimedOut => {
            let pipe_grace = Duration::from_secs(3);
            let stdout_bytes = match tokio::time::timeout(pipe_grace, stdout_task).await {
                Ok(Ok(bytes)) => bytes,
                Ok(Err(e)) => {
                    log::warn!("[Shell] stdout 读取任务异常: {}", e);
                    Vec::new()
                }
                Err(_) => {
                    log::debug!(
                        "[Shell] ⚠️ timeout 后 stdout 管道宽限期到达，返回已收集的数据"
                    );
                    Vec::new()
                }
            };
            let stderr_bytes = match tokio::time::timeout(pipe_grace, stderr_task).await {
                Ok(Ok(bytes)) => bytes,
                Ok(Err(e)) => {
                    log::warn!("[Shell] stderr 读取任务异常: {}", e);
                    Vec::new()
                }
                Err(_) => {
                    log::debug!(
                        "[Shell] ⚠️ timeout 后 stderr 管道宽限期到达，返回已收集的数据"
                    );
                    Vec::new()
                }
            };
            stop_wfp_managed_guard_session(
                &mut wfp_managed_guard_session,
                &app_handle,
                &sandbox_policy,
                &command,
                resolved_workdir_string.as_deref(),
                execution_id.as_deref(),
                "timed_out",
            )
            .await;
            record_wfp_canary_actual_result(
                &app_handle,
                &sandbox_policy,
                &command,
                resolved_workdir_string.as_deref(),
                execution_id.as_deref(),
                wfp_canary_observation.as_ref(),
                "timed_out",
                None,
            );
            log::warn!(
                "[Shell] 命令执行超时（{}秒），已终止进程: {}",
                timeout_duration.as_secs(),
                command
            );
            let timeout_message = format!(
                "Command execution timed out ({}s): {}",
                timeout_duration.as_secs(),
                command
            );
            let stdout = decode_output(&stdout_bytes);
            let raw_stderr = decode_output(&stderr_bytes);
            let stderr = if raw_stderr.trim().is_empty() {
                timeout_message
            } else {
                format!("{}\n{}", raw_stderr, timeout_message)
            };
            Ok(shell_exec_result(
                -1,
                stdout,
                stderr,
                None,
                started_at,
                Some(timeout_duration),
                true,
                true,
            ))
        }
        ForegroundOutcome::Cancelled => {
            stdout_task.abort();
            stderr_task.abort();
            stop_wfp_managed_guard_session(
                &mut wfp_managed_guard_session,
                &app_handle,
                &sandbox_policy,
                &command,
                resolved_workdir_string.as_deref(),
                execution_id.as_deref(),
                "cancelled",
            )
            .await;
            record_wfp_canary_actual_result(
                &app_handle,
                &sandbox_policy,
                &command,
                resolved_workdir_string.as_deref(),
                execution_id.as_deref(),
                wfp_canary_observation.as_ref(),
                "cancelled",
                None,
            );
            log::info!("[Shell] 命令执行已取消，已终止进程: {}", command);
            Err(AppError::Generic(format!(
                "Command execution cancelled: {}",
                command
            )))
        }
    }
}

/// 获取最近的沙箱审计事件
#[tauri::command]
pub async fn sandbox_audit_events(
    limit: Option<u32>,
    offset: Option<u32>,
    since_timestamp: Option<i64>,
    decision: Option<String>,
    backend: Option<String>,
    source: Option<String>,
    reason: Option<String>,
    guard_mode: Option<String>,
    target_host: Option<String>,
    subject_id: Option<String>,
) -> CommandResult<Vec<SandboxAuditEvent>> {
    Ok(list_persisted_sandbox_audit_events(SandboxAuditEventQuery {
        limit: limit.unwrap_or(200) as usize,
        offset: offset.unwrap_or(0) as usize,
        since_timestamp,
        decision,
        backend,
        source,
        reason,
        guard_mode,
        target_host,
        subject_id,
    })
    .await)
}

/// Inspect non-HTTP direct network targets without executing the command.
#[tauri::command]
pub async fn sandbox_network_direct_targets(
    command: String,
    workdir: Option<String>,
) -> CommandResult<NetworkDirectTargetInspection> {
    let workdir = workdir.as_deref();
    let mut targets = Vec::new();
    for target in detect_network_direct_targets(&command, workdir) {
        targets.push(network_direct_target_info_from_target(target).await);
    }
    let required_protocols = required_network_direct_protocols(&command, workdir);

    Ok(NetworkDirectTargetInspection {
        targets,
        required_protocols,
    })
}

/// Resolve DNS risk metadata for explicit non-HTTP direct targets without executing them.
#[tauri::command]
pub async fn sandbox_network_direct_target_risks(
    targets: Vec<NetworkDirectTargetInfo>,
) -> CommandResult<Vec<NetworkDirectTargetInfo>> {
    let mut annotated = Vec::new();
    for target in direct_targets_from_explicit_infos(Some(&targets)) {
        annotated.push(network_direct_target_info_from_target(target).await);
    }
    Ok(annotated)
}

/// 取消前台 Shell 命令
#[tauri::command]
pub async fn shell_cancel(execution_id: String) -> CommandResult<String> {
    let sender = foreground_cancel_registry()
        .lock()
        .await
        .remove(&execution_id);
    if let Some(sender) = sender {
        let _ = sender.send(());
        Ok(format!(
            "Shell execution {} cancellation requested",
            execution_id
        ))
    } else {
        foreground_cancel_requests()
            .lock()
            .await
            .insert(execution_id.clone());
        Ok(format!("Shell execution {} is not active", execution_id))
    }
}

/// 终止后台进程
///
/// 按 PID 查找并终止之前通过 shell_execute(background=true) 启动的后台进程。
#[tauri::command]
pub async fn shell_kill(
    bg_registry: State<'_, BackgroundProcessRegistry>,
    pid: u32,
) -> CommandResult<String> {
    bg_registry.kill(pid).await.map_err(AppError::Generic)?;
    Ok(format!("Process {} terminated", pid))
}

/// 检测当前应用是否以提升权限（管理员）运行
///
/// 前端启动时调用，若检测到提升权限则显示安全警告（仅提示，不阻断）。
/// Agent 不应以 SYSTEM/TrustedInstaller 权限运行，最高 Administrator。
#[tauri::command]
pub fn check_elevated_privileges() -> bool {
    #[cfg(target_os = "windows")]
    {
        // Windows: 通过 shell 命令检测管理员权限
        // net session 仅管理员可执行成功
        // CREATE_NO_WINDOW: 禁止创建可见控制台窗口
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let output = std::process::Command::new("cmd")
            .args(["/C", "net", "session"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();

        match output {
            Ok(status) => {
                let elevated = status.success();
                if elevated {
                    log::warn!("[Shell] 检测到应用以管理员权限运行");
                }
                elevated
            }
            Err(_) => false,
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Unix: 当前仅面向 Windows，暂不支持 Unix 权限检测
        // 未来如需支持，可添加 libc 依赖后使用 libc::geteuid() == 0
        false
    }
}

/// 启动时清理过期的 Trash Bin 条目
///
/// 在应用启动时调用一次，删除超过 30 天的回收站文件。
/// 使用 async 避免大量过期文件删除时阻塞启动。
#[tauri::command]
pub async fn startup_trash_cleanup(app_handle: tauri::AppHandle) -> CommandResult<u32> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    // 在阻塞线程中执行文件系统操作，避免占用 tokio 异步运行时
    tokio::task::spawn_blocking(move || trash_bin::cleanup_expired_items(&app_data_dir))
        .await
        .map_err(|e| AppError::Generic(format!("Trash Bin cleanup task failed: {}", e)))?
}
