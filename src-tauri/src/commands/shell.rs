//! Shell 命令执行编排模块。
//!
//! 这一层负责 Tauri `shell_execute` / `shell_cancel` / `shell_kill` /
//! `shell_background_status` 对外命令入口，
//! 并把命令校验、工作目录解析、环境变量注入、后台进程注册、前台超时 / 取消、
//! 进程沙箱策略、broker/proxy 会话、direct-audit 授权参数和 WFP 实验诊断串联起来。
//!
//! 具体的沙箱策略、审计模型、网络目标解析和 Windows 平台后端已经下沉到
//! `process_sandbox` 子模块；这里只保留执行期编排和 shell 运行时 glue。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
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
    RestrictedExecutionBackend, SandboxAuditEvent, SandboxAuditEventQuery, SandboxNetworkIsolation,
    ShellSandboxPolicy,
};
#[cfg(target_os = "windows")]
use super::process_sandbox::{
    spawn_appcontainer_filesystem_process_with_capabilities, spawn_restricted_token_process,
    AppContainerFilesystemAccess, AppContainerFilesystemGrant, RestrictedTokenProbeResult,
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
    /// stdout 前缀被后端丢弃的字节数（为避免长命令输出撑爆内存/IPC）
    pub stdout_truncated_bytes: u64,
    /// stderr 前缀被后端丢弃的字节数（为避免长命令输出撑爆内存/IPC）
    pub stderr_truncated_bytes: u64,
}

const DEFAULT_SHELL_TIMEOUT_SECONDS: u64 = 300;
const MAX_SHELL_TIMEOUT_SECONDS: u64 = 1800;
const MAX_PIPE_CAPTURE_BYTES: usize = 1024 * 1024;
const BACKGROUND_PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(100);
const BACKGROUND_PROCESS_TOMBSTONE_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_BACKGROUND_PROCESS_TOMBSTONES: usize = 128;

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
        stdout_truncated_bytes: 0,
        stderr_truncated_bytes: 0,
    }
}

#[derive(Default)]
struct CapturedPipeOutput {
    bytes: Vec<u8>,
    dropped_prefix_bytes: u64,
}

impl CapturedPipeOutput {
    fn append_tail(&mut self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }

        if self.bytes.len() + chunk.len() <= MAX_PIPE_CAPTURE_BYTES {
            self.bytes.extend_from_slice(chunk);
            return;
        }

        let old_len = self.bytes.len();
        let overflow = old_len + chunk.len() - MAX_PIPE_CAPTURE_BYTES;
        if overflow >= old_len {
            self.dropped_prefix_bytes += old_len as u64;
            self.bytes.clear();
            let chunk_prefix_to_drop = overflow - old_len;
            let start = chunk_prefix_to_drop.min(chunk.len());
            self.dropped_prefix_bytes += start as u64;
            self.bytes.extend_from_slice(&chunk[start..]);
        } else {
            self.bytes.drain(..overflow);
            self.dropped_prefix_bytes += overflow as u64;
            self.bytes.extend_from_slice(chunk);
        }
    }
}

async fn read_limited_pipe_output<R>(reader: Option<R>) -> CapturedPipeOutput
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut output = CapturedPipeOutput::default();
    let Some(mut reader) = reader else {
        return output;
    };

    let mut chunk = [0_u8; 8192];
    loop {
        let read = match tokio::io::AsyncReadExt::read(&mut reader, &mut chunk).await {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) => {
                log::warn!("[Shell] pipe 读取失败: {}", error);
                break;
            }
        };

        output.append_tail(&chunk[..read]);
    }

    output
}

#[derive(Default)]
struct BackgroundPipeTail {
    bytes: VecDeque<u8>,
    dropped_prefix_bytes: u64,
}

impl BackgroundPipeTail {
    fn append_tail(&mut self, chunk: &[u8]) {
        let overflow = self
            .bytes
            .len()
            .saturating_add(chunk.len())
            .saturating_sub(MAX_PIPE_CAPTURE_BYTES);
        let existing_prefix_to_drop = overflow.min(self.bytes.len());
        if existing_prefix_to_drop > 0 {
            self.bytes.drain(..existing_prefix_to_drop);
        }
        let chunk_prefix_to_drop = overflow - existing_prefix_to_drop;
        self.dropped_prefix_bytes = self
            .dropped_prefix_bytes
            .saturating_add(u64::try_from(overflow).unwrap_or(u64::MAX));
        self.bytes.extend(&chunk[chunk_prefix_to_drop..]);
    }

    fn snapshot(&self) -> CapturedPipeOutput {
        CapturedPipeOutput {
            bytes: self.bytes.iter().copied().collect(),
            dropped_prefix_bytes: self.dropped_prefix_bytes,
        }
    }
}

type SharedPipeOutput = Arc<Mutex<BackgroundPipeTail>>;

async fn drain_background_pipe<R>(
    reader: Option<R>,
    output: SharedPipeOutput,
    pid: u32,
    stream_name: &'static str,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let Some(mut reader) = reader else {
        return;
    };

    let mut chunk = [0_u8; 8192];
    loop {
        let read = match tokio::io::AsyncReadExt::read(&mut reader, &mut chunk).await {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) => {
                log::warn!(
                    "[Shell] background {} pipe read failed for PID={}: {}",
                    stream_name,
                    pid,
                    error
                );
                break;
            }
        };

        match output.lock() {
            Ok(mut output) => output.append_tail(&chunk[..read]),
            Err(error) => {
                log::warn!(
                    "[Shell] background {} buffer lock failed for PID={}: {}",
                    stream_name,
                    pid,
                    error
                );
                break;
            }
        }
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
/// 追踪所有后台 spawn 的进程，支持按 PID 查询状态和终止。
/// stdout/stderr 由独立异步任务持续 drain，仅保留固定大小的尾部内容。
struct BackgroundProcess {
    child: AsyncMutex<tokio::process::Child>,
    sandbox: ProcessSandboxGuard,
    _network_session: Option<NetworkRuntimeSession>,
    stdout: SharedPipeOutput,
    stderr: SharedPipeOutput,
}

#[derive(Clone)]
struct BackgroundProcessTombstone {
    exit_code: Option<i32>,
    exited_at: Instant,
    stdout: SharedPipeOutput,
    stderr: SharedPipeOutput,
}

#[derive(Default)]
struct BackgroundProcessRegistryState {
    children: HashMap<u32, Arc<BackgroundProcess>>,
    exited: HashMap<u32, BackgroundProcessTombstone>,
}

/// 后台进程的可观测状态。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundProcessStatus {
    pub pid: u32,
    pub status: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated_bytes: u64,
    pub stderr_truncated_bytes: u64,
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
    state: Arc<Mutex<BackgroundProcessRegistryState>>,
}

impl BackgroundProcessRegistry {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(BackgroundProcessRegistryState::default())),
        }
    }

    /// 注册后台进程，返回 PID
    async fn register(
        &self,
        mut child: tokio::process::Child,
        sandbox: ProcessSandboxGuard,
        network_session: Option<NetworkRuntimeSession>,
    ) -> Result<u32, String> {
        let Some(pid) = child.id() else {
            terminate_child_tree(&mut child, Some(&sandbox)).await;
            return Err("Background process has no PID and cannot be registered".to_string());
        };
        let stdout_reader = child.stdout.take();
        let stderr_reader = child.stderr.take();
        let stdout = Arc::new(Mutex::new(BackgroundPipeTail::default()));
        let stderr = Arc::new(Mutex::new(BackgroundPipeTail::default()));
        let process = Arc::new(BackgroundProcess {
            child: AsyncMutex::new(child),
            sandbox,
            _network_session: network_session,
            stdout: Arc::clone(&stdout),
            stderr: Arc::clone(&stderr),
        });

        let registry_error = match self.state.lock() {
            Ok(mut state) => {
                Self::prune_tombstones_locked(&mut state, Instant::now());
                state.exited.remove(&pid);
                state.children.insert(pid, Arc::clone(&process));
                None
            }
            Err(error) => Some(format!(
                "Failed to acquire background registry lock: {error}"
            )),
        };
        if let Some(error) = registry_error {
            let mut child = process.child.lock().await;
            terminate_child_tree(&mut child, Some(&process.sandbox)).await;
            return Err(error);
        }

        tokio::spawn(drain_background_pipe(stdout_reader, stdout, pid, "stdout"));
        tokio::spawn(drain_background_pipe(stderr_reader, stderr, pid, "stderr"));
        tokio::spawn(Self::monitor_process(Arc::clone(&self.state), pid, process));

        Ok(pid)
    }

    fn prune_tombstones_locked(state: &mut BackgroundProcessRegistryState, now: Instant) {
        state.exited.retain(|_, tombstone| {
            now.saturating_duration_since(tombstone.exited_at) <= BACKGROUND_PROCESS_TOMBSTONE_TTL
        });

        while state.exited.len() > MAX_BACKGROUND_PROCESS_TOMBSTONES {
            let Some(oldest_pid) = state
                .exited
                .iter()
                .min_by_key(|(_, tombstone)| tombstone.exited_at)
                .map(|(pid, _)| *pid)
            else {
                break;
            };
            state.exited.remove(&oldest_pid);
        }
    }

    fn record_exit(
        state: &Arc<Mutex<BackgroundProcessRegistryState>>,
        pid: u32,
        process: &Arc<BackgroundProcess>,
        exit_code: Option<i32>,
    ) -> Result<(), String> {
        let mut state = state
            .lock()
            .map_err(|error| format!("Failed to acquire lock: {}", error))?;
        let is_registered_process = state
            .children
            .get(&pid)
            .map(|registered| Arc::ptr_eq(registered, process))
            .unwrap_or(false);
        if !is_registered_process {
            return Ok(());
        }

        state.children.remove(&pid);
        state.exited.insert(
            pid,
            BackgroundProcessTombstone {
                exit_code,
                exited_at: Instant::now(),
                stdout: Arc::clone(&process.stdout),
                stderr: Arc::clone(&process.stderr),
            },
        );
        Self::prune_tombstones_locked(&mut state, Instant::now());
        Ok(())
    }

    async fn monitor_process(
        state: Arc<Mutex<BackgroundProcessRegistryState>>,
        pid: u32,
        process: Arc<BackgroundProcess>,
    ) {
        loop {
            let wait_result = {
                let mut child = process.child.lock().await;
                child.try_wait()
            };

            match wait_result {
                Ok(Some(status)) => {
                    if let Err(error) = Self::record_exit(&state, pid, &process, status.code()) {
                        log::warn!(
                            "[Shell] failed to retain background exit status PID={}: {}",
                            pid,
                            error
                        );
                    }
                    break;
                }
                Ok(None) => {
                    tokio::time::sleep(BACKGROUND_PROCESS_POLL_INTERVAL).await;
                }
                Err(error) => {
                    log::debug!(
                        "[Shell] failed to inspect background process PID={}: {}",
                        pid,
                        error
                    );
                    tokio::time::sleep(BACKGROUND_PROCESS_POLL_INTERVAL).await;
                }
            }
        }
    }

    fn snapshot_status(
        pid: u32,
        status: &str,
        exit_code: Option<i32>,
        stdout: &SharedPipeOutput,
        stderr: &SharedPipeOutput,
    ) -> Result<BackgroundProcessStatus, String> {
        let stdout = stdout
            .lock()
            .map_err(|error| format!("Failed to acquire stdout buffer lock: {}", error))?
            .snapshot();
        let stderr = stderr
            .lock()
            .map_err(|error| format!("Failed to acquire stderr buffer lock: {}", error))?
            .snapshot();

        Ok(BackgroundProcessStatus {
            pid,
            status: status.to_string(),
            exit_code,
            stdout: decode_output(&stdout.bytes),
            stderr: decode_output(&stderr.bytes),
            stdout_truncated_bytes: stdout.dropped_prefix_bytes,
            stderr_truncated_bytes: stderr.dropped_prefix_bytes,
        })
    }

    async fn status(&self, pid: u32) -> Result<BackgroundProcessStatus, String> {
        let (process, tombstone) = {
            let mut state = self
                .state
                .lock()
                .map_err(|error| format!("Failed to acquire lock: {}", error))?;
            Self::prune_tombstones_locked(&mut state, Instant::now());
            (
                state.children.get(&pid).cloned(),
                state.exited.get(&pid).cloned(),
            )
        };

        if let Some(tombstone) = tombstone {
            return Self::snapshot_status(
                pid,
                "exited",
                tombstone.exit_code,
                &tombstone.stdout,
                &tombstone.stderr,
            );
        }

        let process =
            process.ok_or_else(|| format!("Background process with PID {} was not found", pid))?;
        let exit_status = {
            let mut child = process.child.lock().await;
            child.try_wait().map_err(|error| {
                format!(
                    "Failed to inspect background process with PID {}: {}",
                    pid, error
                )
            })?
        };

        if let Some(exit_status) = exit_status {
            Self::record_exit(&self.state, pid, &process, exit_status.code())?;
            return Self::snapshot_status(
                pid,
                "exited",
                exit_status.code(),
                &process.stdout,
                &process.stderr,
            );
        }

        Self::snapshot_status(pid, "running", None, &process.stdout, &process.stderr)
    }

    /// 按 PID 终止后台进程
    async fn kill(&self, pid: u32) -> Result<(), String> {
        let process = {
            let mut state = self
                .state
                .lock()
                .map_err(|error| format!("Failed to acquire lock: {}", error))?;
            Self::prune_tombstones_locked(&mut state, Instant::now());
            if state.exited.contains_key(&pid) {
                return Ok(());
            }
            state
                .children
                .get(&pid)
                .cloned()
                .ok_or_else(|| format!("Background process with PID {} was not found", pid))?
        };

        if let Err(e) = process.sandbox.terminate(1) {
            log::warn!("[Shell] Job Object terminate failed for PID={}: {}", pid, e);
        }

        let exit_code = {
            let mut child = process.child.lock().await;
            if let Err(e) = child.kill().await {
                log::debug!("[Shell] Background child.kill PID={} returned: {}", pid, e);
            }
            match child.wait().await {
                Ok(status) => status.code(),
                Err(error) => {
                    log::debug!(
                        "[Shell] Background child.wait PID={} returned: {}",
                        pid,
                        error
                    );
                    None
                }
            }
        };
        Self::record_exit(&self.state, pid, &process, exit_code)?;

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
const FOREGROUND_CANCEL_REQUEST_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_PENDING_FOREGROUND_CANCEL_REQUESTS: usize = 256;

#[derive(Default)]
struct PendingForegroundCancelRequests {
    requests: HashMap<String, Instant>,
}

impl PendingForegroundCancelRequests {
    fn prune_expired(&mut self, now: Instant) {
        self.requests.retain(|_, requested_at| {
            now.saturating_duration_since(*requested_at) <= FOREGROUND_CANCEL_REQUEST_TTL
        });
    }

    fn insert(&mut self, execution_id: String, now: Instant) {
        self.prune_expired(now);
        self.requests.insert(execution_id, now);

        while self.requests.len() > MAX_PENDING_FOREGROUND_CANCEL_REQUESTS {
            let Some(oldest_id) = self
                .requests
                .iter()
                .min_by_key(|(_, requested_at)| **requested_at)
                .map(|(execution_id, _)| execution_id.clone())
            else {
                break;
            };
            self.requests.remove(&oldest_id);
        }
    }

    fn take(&mut self, execution_id: &str, now: Instant) -> bool {
        self.prune_expired(now);
        self.requests.remove(execution_id).is_some()
    }

    fn remove(&mut self, execution_id: &str) {
        self.requests.remove(execution_id);
    }
}

#[derive(Default)]
struct ForegroundCancellationRegistry {
    active: HashMap<String, oneshot::Sender<()>>,
    pending: PendingForegroundCancelRequests,
}

impl ForegroundCancellationRegistry {
    fn register(&mut self, execution_id: &str, now: Instant) -> oneshot::Receiver<()> {
        let (sender, receiver) = oneshot::channel();
        self.active.insert(execution_id.to_string(), sender);
        if self.pending.take(execution_id, now) {
            if let Some(sender) = self.active.remove(execution_id) {
                let _ = sender.send(());
            }
        }
        receiver
    }

    fn request_cancel(&mut self, execution_id: &str, now: Instant) -> bool {
        if let Some(sender) = self.active.remove(execution_id) {
            let _ = sender.send(());
            true
        } else {
            self.pending.insert(execution_id.to_string(), now);
            false
        }
    }

    fn clear(&mut self, execution_id: &str) {
        self.active.remove(execution_id);
        self.pending.remove(execution_id);
    }
}

static FOREGROUND_CANCELLATIONS: OnceLock<AsyncMutex<ForegroundCancellationRegistry>> =
    OnceLock::new();
static CONTROLLED_BROWSER_NETWORK_SESSIONS: OnceLock<
    Mutex<HashMap<String, NetworkRuntimeSession>>,
> = OnceLock::new();
const NETWORK_GUARD_BACKEND_ENV: &str = "AGENTVIS_NETWORK_GUARD_BACKEND";
const CONTROLLED_BROWSER_SESSION_KEY: &str = "agent-browser";
const WFP_HELPER_INSPECT_TIMEOUT_SECS: u64 = 5;
const WFP_HELPER_READY_TIMEOUT_SECS: u64 = 5;
const WFP_MANAGED_EGRESS_MARKER: &str = ".agentvis-egress-managed";
const WFP_MANAGED_EGRESS_TIMEOUT_GRACE_MS: u64 = 5_000;

fn foreground_cancellations() -> &'static AsyncMutex<ForegroundCancellationRegistry> {
    FOREGROUND_CANCELLATIONS
        .get_or_init(|| AsyncMutex::new(ForegroundCancellationRegistry::default()))
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
    #[cfg(target_os = "windows")]
    let key = key.to_ascii_uppercase();
    let value = value.into();
    cmd.env(&key, &value);
    restricted_env_overrides.insert(key, value);
}

const DELETE_PATH_ENV_NAMES: [&str; 7] = [
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "HOME",
    "TEMP",
    "TMP",
    "WORKDIR",
];

fn canonical_delete_path_env_name(key: &str) -> Option<&'static str> {
    DELETE_PATH_ENV_NAMES
        .iter()
        .copied()
        .find(|candidate| candidate.eq_ignore_ascii_case(key))
}

fn user_env_contains_delete_path_key(
    user_env: Option<&HashMap<String, String>>,
    expected: &str,
) -> bool {
    user_env.is_some_and(|values| values.keys().any(|key| key.eq_ignore_ascii_case(expected)))
}

/// Build the exact allowlisted path environment used by Trash Bin's PowerShell parser.
///
/// Precedence mirrors child-process construction: inherited process environment, AgentVis's
/// WORKDIR default, request overrides, then the restricted sandbox profile.
fn effective_delete_path_env(
    user_env: Option<&HashMap<String, String>>,
    resolved_workdir: Option<&Path>,
    sandbox_profile_values: Option<&[(&'static str, String)]>,
) -> HashMap<String, String> {
    let mut effective = HashMap::new();
    for name in DELETE_PATH_ENV_NAMES {
        if let Some(value) = std::env::var_os(name) {
            effective.insert(name.to_string(), value.to_string_lossy().to_string());
        }
    }

    if !user_env_contains_delete_path_key(user_env, "WORKDIR") {
        if let Some(workdir) = resolved_workdir {
            effective.insert("WORKDIR".to_string(), workdir.to_string_lossy().to_string());
        }
    }

    if let Some(user_env) = user_env {
        for (key, value) in user_env {
            if let Some(canonical) = canonical_delete_path_env_name(key) {
                effective.insert(canonical.to_string(), value.clone());
            }
        }
    }

    if let Some(sandbox_profile_values) = sandbox_profile_values {
        for (key, value) in sandbox_profile_values {
            if let Some(canonical) = canonical_delete_path_env_name(key) {
                effective.insert(canonical.to_string(), value.clone());
            }
        }
    }

    effective
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

fn apply_sandbox_profile_env_values(
    cmd: &mut Command,
    restricted_env_overrides: &mut HashMap<String, String>,
    values: &[(&'static str, String)],
) {
    for (key, value) in values {
        set_command_env(cmd, restricted_env_overrides, *key, value.clone());
    }
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
    // /D disables per-user/system Command Processor AutoRun hooks. Without it, an AutoRun
    // `cd` or arbitrary side effect can make Trash Bin preflight disagree with the command that
    // cmd.exe ultimately executes.
    format!("/D /S /C \"chcp 65001 >nul && {}\"", command)
}

#[cfg(target_os = "windows")]
fn build_windows_shell_command(command: &str) -> String {
    format!("cmd {}", build_windows_shell_raw_arg(command))
}

#[cfg(test)]
mod tests {
    use super::{
        acquire_preview_template_lock_at_app_data, appcontainer_direct_network_env_overrides,
        appcontainer_writable_grant_roots, broker_fetch_helper_file_name,
        broker_fetch_helper_needs_refresh, broker_fetch_helper_resource_candidates,
        broker_only_requested, broker_proxy_required_for_network_intent,
        broker_unused_diagnostic_detail, cleanup_preview_workspace_at_cache,
        cleanup_stale_preview_workspaces_at_cache, controlled_browser_proxy_env_overrides,
        controlled_browser_runtime_command, create_preview_workspace_at_cache,
        current_unix_time_millis, effective_delete_path_env, first_shell_token,
        first_shell_token_file_stem, is_preview_workspace_run_id,
        network_guard_backend_is_wfp_canary, network_guard_backend_is_wfp_hard,
        network_proxy_env_overrides, parse_wfp_inspect_readiness,
        prepare_wfp_managed_egress_executable, preview_quarantine_receipt_path,
        preview_workspace_has_active_lease, release_preview_template_lock,
        release_preview_workspace_lease, remove_preview_tree_no_follow_with_limits,
        resolve_shell_timeout_duration, restore_renamed_workspace, set_command_env,
        validate_script_content_before_exec, wfp_canary_preflight_detail, wfp_canary_task_category,
        wfp_helper_file_name, wfp_helper_resource_candidates, wfp_managed_egress_command_name,
        wfp_proxy_preferred_fallback_allowed, write_preview_quarantine_receipt,
        AppContainerFilesystemGrantRequest, BackgroundPipeTail, BackgroundProcessRegistry,
        ControlledBrowserRuntimeCommand, ForegroundCancellationRegistry, NetworkProxyEnvValues,
        PreviewCleanupLimits, PreviewQuarantineReceipt, ProcessSandboxGuard,
        RestrictedExecutionBackend, WfpGuardReadiness, FOREGROUND_CANCEL_REQUEST_TTL,
        MAX_PENDING_FOREGROUND_CANCEL_REQUESTS, MAX_PIPE_CAPTURE_BYTES, MAX_SHELL_TIMEOUT_SECONDS,
        WFP_MANAGED_EGRESS_MARKER,
    };
    #[cfg(target_os = "windows")]
    use super::{
        build_windows_shell_command, build_windows_shell_raw_arg, open_preview_owner_lease_file,
        preview_workspace_has_local_lease,
    };
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Stdio;
    use tokio::process::Command;

    fn delete_scope_test_root() -> PathBuf {
        std::env::temp_dir().join(format!("agentvis-delete-scope-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn delete_path_environment_matches_child_override_precedence() {
        let resolved_workdir = PathBuf::from("C:\\resolved-workdir");
        let mut user_env = HashMap::new();
        user_env.insert("temp".to_string(), "C:\\user-temp".to_string());
        user_env.insert("WORKDIR".to_string(), "C:\\user-workdir".to_string());
        let sandbox_profile = vec![
            ("TEMP", "C:\\sandbox-temp".to_string()),
            ("APPDATA", "C:\\sandbox-roaming".to_string()),
        ];

        let effective = effective_delete_path_env(
            Some(&user_env),
            Some(&resolved_workdir),
            Some(&sandbox_profile),
        );

        assert_eq!(
            effective.get("TEMP").map(String::as_str),
            Some("C:\\sandbox-temp")
        );
        assert_eq!(
            effective.get("APPDATA").map(String::as_str),
            Some("C:\\sandbox-roaming")
        );
        assert_eq!(
            effective.get("WORKDIR").map(String::as_str),
            Some("C:\\user-workdir")
        );

        let defaulted = effective_delete_path_env(None, Some(&resolved_workdir), None);
        assert_eq!(
            defaulted.get("WORKDIR").map(String::as_str),
            Some("C:\\resolved-workdir")
        );
    }

    #[test]
    fn supported_powershell_delete_is_deferred_to_trash_instead_of_script_scan() {
        let command = r#"powershell -NoProfile -Command "Remove-Item -LiteralPath 'C:\work\victim.txt' -Force""#;

        assert!(super::command_validator::validate_script_content(command, None).is_err());
        assert!(validate_script_content_before_exec(command, None).is_ok());
    }

    #[test]
    fn dynamic_or_unhardened_powershell_delete_still_uses_script_scan() {
        for command in [
            r#"powershell -Command "Remove-Item -LiteralPath 'C:\work\victim.txt' -Force""#,
            r#"powershell -NoProfile -Command "[System.IO.File]::Delete('C:\work\victim.txt')""#,
            r#"powershell -NoProfile -Command "iex 'Remove-Item -LiteralPath C:\work\victim.txt -Force'""#,
        ] {
            assert!(
                validate_script_content_before_exec(command, None).is_err(),
                "{command}"
            );
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn restricted_environment_overrides_are_case_insensitive_on_windows() {
        let mut command = Command::new("cmd.exe");
        let mut overrides = HashMap::new();

        set_command_env(&mut command, &mut overrides, "TEMP", "C:\\first");
        set_command_env(&mut command, &mut overrides, "temp", "C:\\second");

        assert_eq!(overrides.len(), 1);
        assert_eq!(
            overrides.get("TEMP").map(String::as_str),
            Some("C:\\second")
        );
    }

    #[test]
    fn delete_scope_restricted_token_does_not_include_appcontainer_grants() {
        let root = delete_scope_test_root();
        let writable = root.join("read-write");
        fs::create_dir_all(&writable).expect("create writable grant root");
        let grants = vec![AppContainerFilesystemGrantRequest {
            path: writable.to_string_lossy().into_owned(),
            access: Some("readWrite".to_string()),
        }];

        assert!(appcontainer_writable_grant_roots(
            &grants,
            RestrictedExecutionBackend::RestrictedToken
        )
        .is_empty());

        fs::remove_dir_all(root).expect("remove delete scope test root");
    }

    #[test]
    fn delete_scope_appcontainer_includes_existing_writable_grants() {
        let root = delete_scope_test_root();
        let writable = root.join("read-write");
        let default_writable = root.join("default-write");
        fs::create_dir_all(&writable).expect("create writable grant root");
        fs::create_dir_all(&default_writable).expect("create default writable grant root");
        let grants = vec![
            AppContainerFilesystemGrantRequest {
                path: writable.to_string_lossy().into_owned(),
                access: Some("readWrite".to_string()),
            },
            AppContainerFilesystemGrantRequest {
                path: default_writable.to_string_lossy().into_owned(),
                access: None,
            },
        ];

        assert_eq!(
            appcontainer_writable_grant_roots(
                &grants,
                RestrictedExecutionBackend::AppContainerFilesystem
            ),
            vec![writable, default_writable]
        );

        fs::remove_dir_all(root).expect("remove delete scope test root");
    }

    #[test]
    fn delete_scope_appcontainer_excludes_read_only_and_missing_grants() {
        let root = delete_scope_test_root();
        let read_only = root.join("read-only");
        let missing = root.join("missing");
        fs::create_dir_all(&read_only).expect("create read-only grant root");
        let grants = vec![
            AppContainerFilesystemGrantRequest {
                path: read_only.to_string_lossy().into_owned(),
                access: Some("readOnly".to_string()),
            },
            AppContainerFilesystemGrantRequest {
                path: missing.to_string_lossy().into_owned(),
                access: Some("readWrite".to_string()),
            },
        ];

        assert!(appcontainer_writable_grant_roots(
            &grants,
            RestrictedExecutionBackend::AppContainerFilesystem
        )
        .is_empty());

        fs::remove_dir_all(root).expect("remove delete scope test root");
    }

    #[test]
    fn delete_scope_appcontainer_uses_first_duplicate_grant_access() {
        let root = delete_scope_test_root();
        let duplicate = root.join("duplicate");
        fs::create_dir_all(&duplicate).expect("create duplicate grant root");

        let read_only_first = vec![
            AppContainerFilesystemGrantRequest {
                path: duplicate.to_string_lossy().into_owned(),
                access: Some("readOnly".to_string()),
            },
            AppContainerFilesystemGrantRequest {
                path: duplicate.to_string_lossy().into_owned(),
                access: Some("readWrite".to_string()),
            },
        ];
        assert!(appcontainer_writable_grant_roots(
            &read_only_first,
            RestrictedExecutionBackend::AppContainerFilesystem
        )
        .is_empty());

        let read_write_first = read_only_first.into_iter().rev().collect::<Vec<_>>();
        assert_eq!(
            appcontainer_writable_grant_roots(
                &read_write_first,
                RestrictedExecutionBackend::AppContainerFilesystem
            ),
            vec![duplicate]
        );

        fs::remove_dir_all(root).expect("remove delete scope test root");
    }

    fn spawn_background_test_process(
        _windows_script: &str,
        _unix_script: &str,
    ) -> tokio::process::Child {
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                _windows_script,
            ]);
            command
        };

        #[cfg(not(target_os = "windows"))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", _unix_script]);
            command
        };

        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn background test process")
    }

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

    #[test]
    fn foreground_cancel_registry_preserves_pre_cancel_and_active_cancel() {
        let now = std::time::Instant::now();
        let mut registry = ForegroundCancellationRegistry::default();

        assert!(!registry.request_cancel("pre-cancelled", now));
        let mut pre_cancelled = registry.register("pre-cancelled", now);
        pre_cancelled
            .try_recv()
            .expect("pre-cancel should be consumed on registration");

        let mut active = registry.register("active", now);
        assert!(registry.request_cancel("active", now));
        active
            .try_recv()
            .expect("active cancellation should notify receiver");

        let mut reused = registry.register("pre-cancelled", now);
        assert!(matches!(
            reused.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        registry.clear("pre-cancelled");
    }

    #[test]
    fn foreground_cancel_registry_expires_and_bounds_pending_requests() {
        let now = std::time::Instant::now();
        let mut registry = ForegroundCancellationRegistry::default();

        assert!(!registry.request_cancel("expired", now));
        let mut expired = registry.register(
            "expired",
            now + FOREGROUND_CANCEL_REQUEST_TTL + std::time::Duration::from_millis(1),
        );
        assert!(matches!(
            expired.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        registry.clear("expired");

        for index in 0..=MAX_PENDING_FOREGROUND_CANCEL_REQUESTS {
            let execution_id = format!("pending-{index}");
            assert!(!registry.request_cancel(
                &execution_id,
                now + std::time::Duration::from_millis(index as u64),
            ));
        }

        assert_eq!(
            registry.pending.requests.len(),
            MAX_PENDING_FOREGROUND_CANCEL_REQUESTS
        );
        assert!(!registry.pending.requests.contains_key("pending-0"));
        assert!(registry.pending.requests.contains_key(&format!(
            "pending-{}",
            MAX_PENDING_FOREGROUND_CANCEL_REQUESTS
        )));
    }

    #[test]
    fn background_pipe_output_keeps_only_the_bounded_tail() {
        let mut output = BackgroundPipeTail::default();
        output.append_tail(&vec![b'a'; MAX_PIPE_CAPTURE_BYTES - 4]);
        output.append_tail(b"0123456789");

        assert_eq!(output.bytes.len(), MAX_PIPE_CAPTURE_BYTES);
        assert_eq!(output.dropped_prefix_bytes, 6);
        let snapshot = output.snapshot();
        assert_eq!(&snapshot.bytes[snapshot.bytes.len() - 10..], b"0123456789");

        output.append_tail(&vec![b'b'; MAX_PIPE_CAPTURE_BYTES + 17]);

        assert_eq!(output.bytes.len(), MAX_PIPE_CAPTURE_BYTES);
        assert_eq!(
            output.dropped_prefix_bytes,
            MAX_PIPE_CAPTURE_BYTES as u64 + 23
        );
        assert!(output.bytes.iter().all(|byte| *byte == b'b'));
    }

    #[tokio::test]
    async fn background_registry_retains_exit_code_and_pipe_tails() {
        let child = spawn_background_test_process(
            "[Console]::Out.WriteLine('background-stdout'); [Console]::Error.WriteLine('background-stderr'); exit 7",
            "printf 'background-stdout\\n'; printf 'background-stderr\\n' >&2; exit 7",
        );
        let registry = BackgroundProcessRegistry::new();
        let pid = registry
            .register(child, ProcessSandboxGuard::default(), None)
            .await
            .expect("background PID");
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);

        let status = loop {
            let status = registry.status(pid).await.expect("background status");
            if status.status == "exited"
                && status.stdout.contains("background-stdout")
                && status.stderr.contains("background-stderr")
            {
                break status;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "background process did not exit with captured output: {status:?}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        };

        assert_eq!(status.exit_code, Some(7));
        assert_eq!(status.stdout_truncated_bytes, 0);
        assert_eq!(status.stderr_truncated_bytes, 0);
        registry
            .kill(pid)
            .await
            .expect("killing an exited process should be idempotent");
        assert_eq!(registry.status(pid).await.expect("retained status"), status);
    }

    #[tokio::test]
    async fn background_registry_exposes_running_output_and_kill_tombstone() {
        let child = spawn_background_test_process(
            "[Console]::Out.WriteLine('running-tail'); Start-Sleep -Seconds 10",
            "printf 'running-tail\\n'; sleep 10",
        );
        let registry = BackgroundProcessRegistry::new();
        let pid = registry
            .register(child, ProcessSandboxGuard::default(), None)
            .await
            .expect("background PID");
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);

        loop {
            let status = registry.status(pid).await.expect("running status");
            if status.stdout.contains("running-tail") {
                assert_eq!(status.status, "running");
                assert_eq!(status.exit_code, None);
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "background process did not expose running output: {status:?}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }

        registry.kill(pid).await.expect("kill running process");
        let status = registry.status(pid).await.expect("killed tombstone");
        assert_eq!(status.status, "exited");
        assert!(status.stdout.contains("running-tail"));
        registry.kill(pid).await.expect("repeat kill is idempotent");
    }

    #[tokio::test]
    async fn background_registry_rejects_unknown_pid() {
        let registry = BackgroundProcessRegistry::new();
        let error = registry
            .status(u32::MAX)
            .await
            .expect_err("unknown PID should fail");

        assert!(error.contains("was not found"));
    }

    #[tokio::test]
    async fn background_registry_rejects_pidless_child_instead_of_reporting_success() {
        let mut child = spawn_background_test_process("exit 0", "exit 0");
        child.wait().await.expect("wait for short-lived child");
        assert!(child.id().is_none());
        let registry = BackgroundProcessRegistry::new();

        let error = registry
            .register(child, ProcessSandboxGuard::default(), None)
            .await
            .expect_err("pidless child must not be reported as a registered process");

        assert!(error.contains("no PID"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_shell_raw_arg_preserves_command_quotes() {
        let raw = build_windows_shell_raw_arg("python -c \"print('ok')\"");

        assert_eq!(
            raw,
            "/D /S /C \"chcp 65001 >nul && python -c \"print('ok')\"\""
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_shell_command_preserves_quoted_paths() {
        let shell_command = build_windows_shell_command("dir \"C:\\Program Files\"");

        assert_eq!(
            shell_command,
            "cmd /D /S /C \"chcp 65001 >nul && dir \"C:\\Program Files\"\""
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

    fn preview_test_cache() -> PathBuf {
        std::env::temp_dir().join(format!(
            "agentvis-preview-workspace-test-{}",
            uuid::Uuid::new_v4()
        ))
    }

    fn preview_test_run_id() -> String {
        format!("project-preview-{}", uuid::Uuid::new_v4())
    }

    #[test]
    fn preview_template_lock_serializes_shared_cache_mutation() {
        let app_data = preview_test_cache();
        let first = acquire_preview_template_lock_at_app_data(
            &app_data,
            "vanilla",
            1,
            std::time::Duration::ZERO,
        )
        .expect("acquire first template lease");

        let busy = acquire_preview_template_lock_at_app_data(
            &app_data,
            "vanilla",
            1,
            std::time::Duration::ZERO,
        )
        .expect_err("a second handle must not mutate the shared template concurrently");
        assert!(busy.contains("Timed out waiting"), "busy result: {busy}");

        release_preview_template_lock(&first).expect("release first template lease");
        let second = acquire_preview_template_lock_at_app_data(
            &app_data,
            "vanilla",
            1,
            std::time::Duration::ZERO,
        )
        .expect("acquire template lease after release");
        release_preview_template_lock(&second).expect("release second template lease");
        let _ = fs::remove_dir_all(app_data);
    }

    #[test]
    fn preview_template_lock_rejects_unregistered_template_ids() {
        let app_data = preview_test_cache();
        let error = acquire_preview_template_lock_at_app_data(
            &app_data,
            "../react-tailwind",
            1,
            std::time::Duration::ZERO,
        )
        .expect_err("template lock path must be native-whitelisted");
        assert!(error.contains("Invalid preview template id"));
        assert!(!app_data.exists());
    }

    fn write_preview_test_quarantine_receipt(
        root: &std::path::Path,
        receipt_file_trash_name: &str,
        receipt_trash_name: &str,
        run_id: &str,
        owner_token: &str,
        created_at_ms: i64,
        modified_at: std::time::SystemTime,
    ) -> PathBuf {
        let path = preview_quarantine_receipt_path(root, receipt_file_trash_name);
        let bytes = serde_json::to_vec(&PreviewQuarantineReceipt {
            trash_name: receipt_trash_name.to_string(),
            run_id: run_id.to_string(),
            owner_token: owner_token.to_string(),
            created_at_ms,
        })
        .expect("encode preview quarantine receipt fixture");
        fs::write(&path, bytes).expect("write preview quarantine receipt fixture");
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("open preview quarantine receipt fixture")
            .set_times(std::fs::FileTimes::new().set_modified(modified_at))
            .expect("set preview quarantine receipt fixture mtime");
        path
    }

    #[test]
    fn preview_run_id_requires_exact_uuid_v4_direct_child_shape() {
        assert!(is_preview_workspace_run_id(
            "project-preview-11111111-1111-4111-8111-111111111111"
        ));
        assert!(!is_preview_workspace_run_id(
            "project-preview-11111111-1111-5111-8111-111111111111"
        ));
        assert!(!is_preview_workspace_run_id(
            "../project-preview-11111111-1111-4111-8111-111111111111"
        ));
        assert!(!is_preview_workspace_run_id("project-preview-not-a-uuid"));
    }

    #[test]
    fn preview_workspace_create_and_cleanup_are_owned_and_bounded() {
        let app_cache = preview_test_cache();
        let run_id = preview_test_run_id();
        let created = create_preview_workspace_at_cache(&app_cache, &run_id)
            .expect("create managed preview workspace");
        let workspace = PathBuf::from(&created.workspace);

        assert_eq!(
            workspace.parent(),
            Some(app_cache.join("project-preview").as_path())
        );
        assert_eq!(
            workspace.file_name().and_then(|name| name.to_str()),
            Some(run_id.as_str())
        );
        assert!(workspace.join(".agentvis").join("active").is_file());
        assert!(super::is_uuid_v4_text(&created.owner_token));

        fs::create_dir_all(workspace.join("node_modules").join("package"))
            .expect("create ordinary dependency tree");
        fs::write(
            workspace
                .join("node_modules")
                .join("package")
                .join("index.js"),
            "export {};",
        )
        .expect("write dependency file");
        fs::write(workspace.join("index.html"), "<!doctype html>").expect("write staged file");

        let result = cleanup_preview_workspace_at_cache(
            &app_cache,
            &workspace,
            &run_id,
            &created.owner_token,
            None,
        )
        .expect("cleanup managed preview workspace");
        assert_eq!(result.status, "removed", "cleanup result: {result:?}");
        assert!(!workspace.exists());
        assert!(app_cache.join("project-preview").is_dir());
        let _ = fs::remove_dir_all(app_cache);
    }

    #[test]
    fn preview_cleanup_entry_budget_is_bounded_and_resumable() {
        let root = preview_test_cache();
        fs::create_dir_all(root.join(".agentvis")).expect("create owner marker directory");
        fs::write(root.join(".agentvis").join("active"), "owner").expect("write owner marker");
        for index in 0..10 {
            fs::write(root.join(format!("source-{index}.js")), "export {};")
                .expect("write cleanup fixture");
        }
        let canonical_root = fs::canonicalize(&root).expect("canonicalize cleanup fixture");

        let error = remove_preview_tree_no_follow_with_limits(
            &root,
            &root,
            &canonical_root,
            PreviewCleanupLimits {
                max_entries: 3,
                max_depth: 128,
                max_duration: std::time::Duration::from_secs(5),
            },
        )
        .expect_err("first bounded pass must stop before consuming the whole tree");
        assert!(
            error.contains("entry budget exceeded"),
            "budget result: {error}"
        );
        assert!(root.is_dir());
        assert!(root.join(".agentvis").join("active").is_file());
        let remaining_sources = fs::read_dir(&root)
            .expect("enumerate partially cleaned fixture")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("source-"))
            .count();
        assert!(
            remaining_sources < 10,
            "bounded pass should make deletion progress"
        );

        remove_preview_tree_no_follow_with_limits(
            &root,
            &root,
            &canonical_root,
            PreviewCleanupLimits {
                max_entries: 100,
                max_depth: 128,
                max_duration: std::time::Duration::from_secs(5),
            },
        )
        .expect("a later bounded pass should finish the remaining quarantine");
        assert!(!root.exists());
    }

    #[test]
    fn preview_cleanup_enforces_depth_and_time_budgets_without_recursion() {
        let depth_root = preview_test_cache();
        fs::create_dir_all(depth_root.join("one").join("two").join("three"))
            .expect("create deep cleanup fixture");
        let canonical_depth_root =
            fs::canonicalize(&depth_root).expect("canonicalize deep cleanup fixture");
        let depth_error = remove_preview_tree_no_follow_with_limits(
            &depth_root,
            &depth_root,
            &canonical_depth_root,
            PreviewCleanupLimits {
                max_entries: 100,
                max_depth: 2,
                max_duration: std::time::Duration::from_secs(5),
            },
        )
        .expect_err("deep cleanup fixture must hit the depth budget");
        assert!(depth_error.contains("depth budget exceeded"));
        let _ = fs::remove_dir_all(depth_root);

        let time_root = preview_test_cache();
        fs::create_dir_all(&time_root).expect("create timed cleanup fixture");
        let canonical_time_root =
            fs::canonicalize(&time_root).expect("canonicalize timed cleanup fixture");
        let time_error = remove_preview_tree_no_follow_with_limits(
            &time_root,
            &time_root,
            &canonical_time_root,
            PreviewCleanupLimits {
                max_entries: 100,
                max_depth: 128,
                max_duration: std::time::Duration::ZERO,
            },
        )
        .expect_err("zero cleanup duration must fail before traversal");
        assert!(time_error.contains("time budget exceeded"));
        let _ = fs::remove_dir_all(time_root);
    }

    #[test]
    fn preview_workspace_cleanup_refuses_wrong_owner_and_nested_paths() {
        let app_cache = preview_test_cache();
        let run_id = preview_test_run_id();
        let created = create_preview_workspace_at_cache(&app_cache, &run_id)
            .expect("create managed preview workspace");
        let workspace = PathBuf::from(&created.workspace);

        let wrong_owner = uuid::Uuid::new_v4().to_string();
        let wrong_owner_result =
            cleanup_preview_workspace_at_cache(&app_cache, &workspace, &run_id, &wrong_owner, None)
                .expect("owner mismatch is a refusal result");
        assert_eq!(wrong_owner_result.status, "refused");
        assert!(wrong_owner_result
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("owner token mismatch")));
        assert!(workspace.is_dir());

        let nested_result = cleanup_preview_workspace_at_cache(
            &app_cache,
            &workspace.join("nested"),
            &run_id,
            &created.owner_token,
            None,
        )
        .expect("nested path is a refusal result");
        assert_eq!(nested_result.status, "refused");
        assert!(workspace.is_dir());

        let removed = cleanup_preview_workspace_at_cache(
            &app_cache,
            &workspace,
            &run_id,
            &created.owner_token,
            None,
        )
        .expect("cleanup correct owner");
        assert_eq!(removed.status, "removed");
        let _ = fs::remove_dir_all(app_cache);
    }

    #[test]
    fn preview_stale_cleanup_rechecks_fresh_owner_marker_mtime() {
        let app_cache = preview_test_cache();
        let run_id = preview_test_run_id();
        let created = create_preview_workspace_at_cache(&app_cache, &run_id)
            .expect("create managed preview workspace");
        let workspace = PathBuf::from(&created.workspace);
        let stale_cutoff = current_unix_time_millis().expect("current timestamp")
            - super::MIN_PREVIEW_STALE_AGE_MILLIS;

        let result = cleanup_preview_workspace_at_cache(
            &app_cache,
            &workspace,
            &run_id,
            &created.owner_token,
            Some(stale_cutoff),
        )
        .expect("fresh marker is a refusal result");
        assert_eq!(result.status, "refused");
        assert!(result
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("still active")));
        assert!(workspace.is_dir());

        let removed = cleanup_preview_workspace_at_cache(
            &app_cache,
            &workspace,
            &run_id,
            &created.owner_token,
            None,
        )
        .expect("normal owner cleanup");
        assert_eq!(removed.status, "removed");
        let _ = fs::remove_dir_all(app_cache);
    }

    #[test]
    fn preview_stale_batch_removes_abandoned_workspace_but_preserves_active_lease() {
        let app_cache = preview_test_cache();
        let abandoned_run_id = "project-preview-22222222-2222-4222-8222-222222222222".to_string();
        let abandoned = create_preview_workspace_at_cache(&app_cache, &abandoned_run_id)
            .expect("create abandoned preview workspace");
        assert!(release_preview_workspace_lease(&abandoned.owner_token)
            .expect("release simulated prior-process lease"));
        let foreign_normal_cleanup = cleanup_preview_workspace_at_cache(
            &app_cache,
            PathBuf::from(&abandoned.workspace).as_path(),
            &abandoned_run_id,
            &abandoned.owner_token,
            None,
        )
        .expect("normal cleanup without a local lease is a refusal result");
        assert_eq!(foreign_normal_cleanup.status, "refused");
        assert!(foreign_normal_cleanup
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("held by this app instance")));
        assert!(PathBuf::from(&abandoned.workspace).is_dir());

        let active_run_id = "project-preview-11111111-1111-4111-8111-111111111111".to_string();
        let active = create_preview_workspace_at_cache(&app_cache, &active_run_id)
            .expect("create active preview workspace");
        let old_time = std::time::SystemTime::now() - std::time::Duration::from_secs(25 * 60 * 60);
        for workspace in [&abandoned.workspace, &active.workspace] {
            let marker = PathBuf::from(workspace).join(".agentvis").join("active");
            let file = fs::OpenOptions::new()
                .write(true)
                .open(&marker)
                .expect("open marker to simulate an old heartbeat");
            file.set_times(std::fs::FileTimes::new().set_modified(old_time))
                .expect("age preview heartbeat");
        }
        let cutoff = current_unix_time_millis().expect("current timestamp")
            - super::MIN_PREVIEW_STALE_AGE_MILLIS;

        let result = cleanup_stale_preview_workspaces_at_cache(&app_cache, cutoff, 1)
            .expect("run native stale sweep");
        assert_eq!(result.removed, 1);
        assert_eq!(result.refused, 1);
        assert!(!PathBuf::from(&abandoned.workspace).exists());
        assert!(PathBuf::from(&active.workspace).is_dir());
        assert!(result.results.iter().any(|item| {
            item.run_id == active_run_id
                && item.status == "refused"
                && item
                    .reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("active owner lease"))
        }));

        let removed = cleanup_preview_workspace_at_cache(
            &app_cache,
            PathBuf::from(&active.workspace).as_path(),
            &active_run_id,
            &active.owner_token,
            None,
        )
        .expect("normal owner cleanup remains available");
        assert_eq!(removed.status, "removed");
        let _ = fs::remove_dir_all(app_cache);
    }

    #[test]
    fn preview_restore_after_quarantine_reacquires_normal_owner_lease() {
        let app_cache = preview_test_cache();
        let run_id = preview_test_run_id();
        let created = create_preview_workspace_at_cache(&app_cache, &run_id)
            .expect("create managed preview workspace");
        let workspace = PathBuf::from(&created.workspace);
        assert!(release_preview_workspace_lease(&created.owner_token)
            .expect("release owner lease before simulated quarantine"));
        let trash = app_cache
            .join("project-preview")
            .join(format!(".trash-{}", uuid::Uuid::new_v4()));
        fs::rename(&workspace, &trash).expect("simulate native quarantine rename");

        let result = restore_renamed_workspace(
            &trash,
            &workspace,
            &created.owner_token,
            true,
            "simulated post-rename validation failure".to_string(),
        );
        assert_eq!(result.status, "refused");
        assert!(workspace.is_dir());
        assert!(!trash.exists());
        assert!(
            preview_workspace_has_active_lease(&workspace, &created.owner_token)
                .expect("probe restored owner lease")
        );

        let removed = cleanup_preview_workspace_at_cache(
            &app_cache,
            &workspace,
            &run_id,
            &created.owner_token,
            None,
        )
        .expect("cleanup restored workspace");
        assert_eq!(removed.status, "removed");
        let _ = fs::remove_dir_all(app_cache);
    }

    #[test]
    fn preview_stale_sweep_recovers_owned_partial_quarantine_without_marker() {
        let app_cache = preview_test_cache();
        let run_id = preview_test_run_id();
        let created = create_preview_workspace_at_cache(&app_cache, &run_id)
            .expect("create managed preview workspace");
        assert!(release_preview_workspace_lease(&created.owner_token)
            .expect("release simulated cleanup lease"));
        let root = app_cache.join("project-preview");
        let trash_name = ".trash-33333333-3333-4333-8333-333333333333";
        let trash = root.join(trash_name);
        let receipt =
            write_preview_quarantine_receipt(&root, trash_name, &run_id, &created.owner_token)
                .expect("persist quarantine ownership receipt");
        fs::rename(&created.workspace, &trash).expect("quarantine workspace");
        fs::remove_dir_all(trash.join(".agentvis"))
            .expect("simulate partial cleanup that removed the workspace marker");
        let old_time = std::time::SystemTime::now() - std::time::Duration::from_secs(25 * 60 * 60);
        fs::OpenOptions::new()
            .write(true)
            .open(&receipt)
            .expect("open quarantine receipt")
            .set_times(std::fs::FileTimes::new().set_modified(old_time))
            .expect("age quarantine receipt");
        let cutoff = current_unix_time_millis().expect("current timestamp")
            - super::MIN_PREVIEW_STALE_AGE_MILLIS;

        let result = cleanup_stale_preview_workspaces_at_cache(&app_cache, cutoff, 1)
            .expect("run native stale quarantine recovery");
        assert_eq!(result.removed, 1);
        assert!(!trash.exists());
        assert!(!receipt.exists());
        let _ = fs::remove_dir_all(app_cache);
    }

    #[test]
    fn preview_stale_sweep_refuses_mismatched_quarantine_receipt_without_deleting_workspace() {
        let app_cache = preview_test_cache();
        let run_id = preview_test_run_id();
        let created = create_preview_workspace_at_cache(&app_cache, &run_id)
            .expect("create managed preview workspace");
        assert!(release_preview_workspace_lease(&created.owner_token)
            .expect("release simulated cleanup lease"));
        let root = app_cache.join("project-preview");
        let actual_trash_name = format!(".trash-{}", uuid::Uuid::new_v4());
        let mismatched_trash_name = format!(".trash-{}", uuid::Uuid::new_v4());
        let actual_trash = root.join(&actual_trash_name);
        fs::rename(&created.workspace, &actual_trash).expect("quarantine workspace fixture");

        let mismatched_receipt = write_preview_quarantine_receipt(
            &root,
            &mismatched_trash_name,
            &run_id,
            &created.owner_token,
        )
        .expect("persist mismatched quarantine receipt");
        let actual_receipt = preview_quarantine_receipt_path(&root, &actual_trash_name);
        fs::rename(&mismatched_receipt, &actual_receipt)
            .expect("place mismatched receipt beside quarantine");
        let old_time = std::time::SystemTime::now() - std::time::Duration::from_secs(25 * 60 * 60);
        fs::OpenOptions::new()
            .write(true)
            .open(&actual_receipt)
            .expect("open mismatched receipt")
            .set_times(std::fs::FileTimes::new().set_modified(old_time))
            .expect("age mismatched receipt");
        let cutoff = current_unix_time_millis().expect("current timestamp")
            - super::MIN_PREVIEW_STALE_AGE_MILLIS;

        let result = cleanup_stale_preview_workspaces_at_cache(&app_cache, cutoff, 1)
            .expect("run native stale quarantine recovery");
        assert_eq!(result.removed, 0);
        assert_eq!(result.refused, 1);
        assert!(result.results.iter().any(|item| {
            item.status == "refused"
                && item
                    .reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("receipt does not match"))
        }));
        assert!(actual_trash.is_dir());
        assert!(actual_receipt.is_file());
        let _ = fs::remove_dir_all(app_cache);
    }

    #[test]
    fn preview_stale_sweep_removes_only_old_self_consistent_orphan_receipts() {
        let app_cache = preview_test_cache();
        let root = app_cache.join("project-preview");
        fs::create_dir_all(&root).expect("create preview cache root");
        let run_id = preview_test_run_id();
        let owner_token = uuid::Uuid::new_v4().to_string();
        let cutoff = current_unix_time_millis().expect("current timestamp")
            - super::MIN_PREVIEW_STALE_AGE_MILLIS;
        let old_time = std::time::SystemTime::now() - std::time::Duration::from_secs(25 * 60 * 60);

        let old_trash_name = format!(".trash-{}", uuid::Uuid::new_v4());
        let old_receipt = write_preview_test_quarantine_receipt(
            &root,
            &old_trash_name,
            &old_trash_name,
            &run_id,
            &owner_token,
            cutoff - 1_000,
            old_time,
        );
        let fresh_trash_name = format!(".trash-{}", uuid::Uuid::new_v4());
        let fresh_receipt = write_preview_test_quarantine_receipt(
            &root,
            &fresh_trash_name,
            &fresh_trash_name,
            &run_id,
            &owner_token,
            current_unix_time_millis().expect("fresh receipt timestamp"),
            std::time::SystemTime::now(),
        );
        let mismatched_file_trash_name = format!(".trash-{}", uuid::Uuid::new_v4());
        let mismatched_embedded_trash_name = format!(".trash-{}", uuid::Uuid::new_v4());
        let mismatched_receipt = write_preview_test_quarantine_receipt(
            &root,
            &mismatched_file_trash_name,
            &mismatched_embedded_trash_name,
            &run_id,
            &owner_token,
            cutoff - 1_000,
            old_time,
        );

        let result = cleanup_stale_preview_workspaces_at_cache(&app_cache, cutoff, 8)
            .expect("run orphan receipt stale sweep");
        assert_eq!(result.removed, 1);
        assert_eq!(result.refused, 1);
        assert!(!old_receipt.exists());
        assert!(fresh_receipt.is_file());
        assert!(mismatched_receipt.is_file());
        assert!(result.results.iter().any(|item| {
            item.status == "removed"
                && item.run_id == old_trash_name
                && item
                    .reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("orphan"))
        }));
        assert!(result.results.iter().any(|item| {
            item.status == "refused"
                && item.run_id == mismatched_file_trash_name
                && item
                    .reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("self-consistent"))
        }));
        let _ = fs::remove_dir_all(app_cache);
    }

    #[test]
    fn preview_orphan_receipt_result_does_not_resolve_same_run_workspace() {
        let app_cache = preview_test_cache();
        let run_id = preview_test_run_id();
        let created = create_preview_workspace_at_cache(&app_cache, &run_id)
            .expect("create same-run preview workspace");
        assert!(release_preview_workspace_lease(&created.owner_token)
            .expect("release simulated prior-process lease"));
        let root = app_cache.join("project-preview");
        let cutoff = current_unix_time_millis().expect("current timestamp")
            - super::MIN_PREVIEW_STALE_AGE_MILLIS;
        let old_time = std::time::SystemTime::now() - std::time::Duration::from_secs(25 * 60 * 60);
        fs::OpenOptions::new()
            .write(true)
            .open(
                PathBuf::from(&created.workspace)
                    .join(".agentvis")
                    .join("active"),
            )
            .expect("open same-run workspace marker")
            .set_times(std::fs::FileTimes::new().set_modified(old_time))
            .expect("age same-run workspace marker");
        let orphan_trash_name = format!(".trash-{}", uuid::Uuid::new_v4());
        let orphan_receipt = write_preview_test_quarantine_receipt(
            &root,
            &orphan_trash_name,
            &orphan_trash_name,
            &run_id,
            &created.owner_token,
            cutoff - 1_000,
            old_time,
        );

        let result = cleanup_stale_preview_workspaces_at_cache(&app_cache, cutoff, 1)
            .expect("run same-run orphan receipt sweep");
        assert_eq!(result.removed, 1);
        assert!(result.has_more, "same-run workspace must remain pending");
        assert!(!orphan_receipt.exists());
        assert!(PathBuf::from(&created.workspace).is_dir());
        assert!(result
            .results
            .iter()
            .any(|item| { item.status == "removed" && item.run_id == orphan_trash_name }));
        assert!(!result
            .results
            .iter()
            .any(|item| item.status == "removed" && item.run_id == run_id));
        fs::remove_dir_all(app_cache).expect("remove same-run orphan receipt fixture");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn preview_stale_sweep_refuses_orphan_receipt_junction_without_touching_target() {
        let app_cache = preview_test_cache();
        let root = app_cache.join("project-preview");
        fs::create_dir_all(&root).expect("create preview cache root");
        let trash_name = format!(".trash-{}", uuid::Uuid::new_v4());
        let receipt_path = preview_quarantine_receipt_path(&root, &trash_name);
        let target = std::env::temp_dir().join(format!(
            "agentvis-preview-orphan-receipt-target-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&target).expect("create orphan receipt junction target");
        fs::write(target.join("sentinel.txt"), "keep").expect("write external sentinel");
        let output = std::process::Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                receipt_path.to_string_lossy().as_ref(),
                target.to_string_lossy().as_ref(),
            ])
            .output()
            .expect("invoke Windows mklink receipt fixture");
        assert!(
            output.status.success(),
            "mklink /J fixture failed: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let cutoff = current_unix_time_millis().expect("current timestamp")
            - super::MIN_PREVIEW_STALE_AGE_MILLIS;

        let result = cleanup_stale_preview_workspaces_at_cache(&app_cache, cutoff, 1)
            .expect("run linked orphan receipt stale sweep");
        assert_eq!(result.removed, 0);
        assert_eq!(result.refused, 1);
        assert!(receipt_path.exists());
        assert!(target.join("sentinel.txt").is_file());

        let _ = fs::remove_dir(&receipt_path);
        let _ = fs::remove_dir_all(app_cache);
        let _ = fs::remove_dir_all(target);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn preview_cleanup_retries_a_transient_windows_no_delete_share_handle() {
        let app_cache = preview_test_cache();
        let run_id = preview_test_run_id();
        let created = create_preview_workspace_at_cache(&app_cache, &run_id)
            .expect("create managed preview workspace");
        let workspace = PathBuf::from(&created.workspace);
        let marker = workspace.join(".agentvis").join("active");
        let blocker = open_preview_owner_lease_file(&marker, false)
            .expect("open independent no-delete-share blocker");
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            drop(blocker);
        });

        let result = cleanup_preview_workspace_at_cache(
            &app_cache,
            &workspace,
            &run_id,
            &created.owner_token,
            None,
        )
        .expect("transient Windows sharing violation should be retried");
        release.join().expect("release blocker thread");
        assert_eq!(result.status, "removed", "cleanup result: {result:?}");
        assert!(!workspace.exists());
        let _ = fs::remove_dir_all(app_cache);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn preview_cleanup_bounds_a_persistent_windows_no_delete_share_handle() {
        let app_cache = preview_test_cache();
        let run_id = preview_test_run_id();
        let created = create_preview_workspace_at_cache(&app_cache, &run_id)
            .expect("create managed preview workspace");
        let workspace = PathBuf::from(&created.workspace);
        let marker = workspace.join(".agentvis").join("active");
        let blocker = open_preview_owner_lease_file(&marker, false)
            .expect("open independent no-delete-share blocker");
        let started_at = std::time::Instant::now();

        let error = cleanup_preview_workspace_at_cache(
            &app_cache,
            &workspace,
            &run_id,
            &created.owner_token,
            None,
        )
        .expect_err("persistent Windows sharing violation must remain fail-closed");
        let elapsed = started_at.elapsed();
        assert!(
            elapsed >= std::time::Duration::from_secs(1)
                && elapsed < std::time::Duration::from_secs(4),
            "bounded retry elapsed {elapsed:?}"
        );
        assert!(error.contains("atomically quarantine preview workspace"));
        assert!(workspace.is_dir());
        assert!(preview_workspace_has_local_lease(&created.owner_token)
            .expect("cleanup failure should restore the local owner lease"));

        drop(blocker);
        let result = cleanup_preview_workspace_at_cache(
            &app_cache,
            &workspace,
            &run_id,
            &created.owner_token,
            None,
        )
        .expect("cleanup should succeed after blocker release");
        assert_eq!(result.status, "removed", "cleanup result: {result:?}");
        assert!(!workspace.exists());
        let _ = fs::remove_dir_all(app_cache);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn preview_cleanup_removes_windows_node_modules_junction_without_touching_target() {
        let app_cache = preview_test_cache();
        let target = std::env::temp_dir().join(format!(
            "agentvis-preview-junction-target-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&target).expect("create external junction target");
        fs::write(target.join("sentinel.txt"), "keep").expect("write external sentinel");
        let run_id = preview_test_run_id();
        let created = create_preview_workspace_at_cache(&app_cache, &run_id)
            .expect("create managed preview workspace");
        let workspace = PathBuf::from(&created.workspace);
        let junction = workspace.join("node_modules");
        let output = std::process::Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                junction.to_string_lossy().as_ref(),
                target.to_string_lossy().as_ref(),
            ])
            .output()
            .expect("invoke Windows mklink junction fixture");
        assert!(
            output.status.success(),
            "mklink /J fixture failed: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );

        let result = cleanup_preview_workspace_at_cache(
            &app_cache,
            &workspace,
            &run_id,
            &created.owner_token,
            None,
        )
        .expect("clean workspace containing template junction");
        assert_eq!(result.status, "removed", "cleanup result: {result:?}");
        assert!(!workspace.exists());
        assert!(target.join("sentinel.txt").is_file());
        let _ = fs::remove_dir_all(app_cache);
        let _ = fs::remove_dir_all(target);
    }

    #[cfg(unix)]
    #[test]
    fn preview_cleanup_refuses_links_outside_node_modules_without_touching_target() {
        use std::os::unix::fs::symlink;

        let app_cache = preview_test_cache();
        let target = app_cache.join("outside-target");
        fs::create_dir_all(&target).expect("create external target");
        fs::write(target.join("keep.txt"), "keep").expect("write external target file");
        let run_id = preview_test_run_id();
        let created = create_preview_workspace_at_cache(&app_cache, &run_id)
            .expect("create managed preview workspace");
        let workspace = PathBuf::from(&created.workspace);
        symlink(&target, workspace.join("unexpected-link")).expect("create test symlink");

        let result = cleanup_preview_workspace_at_cache(
            &app_cache,
            &workspace,
            &run_id,
            &created.owner_token,
            None,
        )
        .expect("unexpected link is a refusal result");
        assert_eq!(result.status, "refused");
        assert!(target.join("keep.txt").is_file());
        assert!(!workspace.exists());
        let quarantine = result
            .quarantined_workspace
            .as_deref()
            .map(PathBuf::from)
            .expect("unsafe entry must remain in a receipted quarantine");
        assert!(quarantine.join("unexpected-link").is_symlink());
        assert!(target.join("keep.txt").is_file());
        let _ = fs::remove_dir_all(app_cache);
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
    requested_grants: &[AppContainerFilesystemGrantRequest],
) -> Option<Vec<PathBuf>> {
    if !sandbox_policy.uses_restricted_process_backend() {
        return None;
    }

    let mut roots = Vec::new();
    if let Some(workdir) = workdir {
        roots.push(workdir.to_path_buf());
    }

    #[cfg(target_os = "windows")]
    {
        roots.extend(appcontainer_app_managed_roots(app_data_dir));
        roots.extend(appcontainer_writable_grant_roots(
            requested_grants,
            sandbox_policy.restricted_execution_backend(),
        ));
    }

    #[cfg(not(target_os = "windows"))]
    {
        roots.push(app_data_dir.join("runtime"));
        roots.push(app_data_dir.join("skills"));
    }

    Some(roots)
}

fn appcontainer_writable_grant_roots(
    requested_grants: &[AppContainerFilesystemGrantRequest],
    restricted_backend: RestrictedExecutionBackend,
) -> Vec<PathBuf> {
    effective_appcontainer_requested_grants(requested_grants, restricted_backend)
        .into_iter()
        .filter(|grant| matches!(grant.access.as_deref(), None | Some("readWrite")))
        .map(|grant| PathBuf::from(&grant.path))
        .collect()
}

fn effective_appcontainer_requested_grants(
    requested_grants: &[AppContainerFilesystemGrantRequest],
    restricted_backend: RestrictedExecutionBackend,
) -> Vec<AppContainerFilesystemGrantRequest> {
    if restricted_backend != RestrictedExecutionBackend::AppContainerFilesystem {
        return Vec::new();
    }

    let mut granted_paths = HashSet::new();
    requested_grants
        .iter()
        .filter_map(|grant| {
            let path = PathBuf::from(&grant.path);
            if !path.exists() {
                return None;
            }
            let key = path.to_string_lossy().to_ascii_lowercase();
            granted_paths.insert(key).then(|| grant.clone())
        })
        .collect()
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
        Some(
            foreground_cancellations()
                .lock()
                .await
                .register(id, Instant::now()),
        )
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
        foreground_cancellations().lock().await.clear(id);
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
    for grant in effective_appcontainer_requested_grants(
        &requested_grants,
        RestrictedExecutionBackend::AppContainerFilesystem,
    ) {
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
        Some(
            foreground_cancellations()
                .lock()
                .await
                .register(id, Instant::now()),
        )
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
        foreground_cancellations().lock().await.clear(id);
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

/// 扫描即将执行的脚本内容，同时让 Trash Bin 已完整建模的静态 PowerShell 删除
/// 留到后续删除拦截阶段处理。该分类不移动文件；原命令只有在 Trash Bin 明确返回
/// `NotDelete` 后才可能继续 spawn。
fn validate_script_content_before_exec(
    command: &str,
    workdir: Option<&str>,
) -> Result<(), AppError> {
    if trash_bin::should_defer_powershell_delete_to_trash(command) {
        return Ok(());
    }
    command_validator::validate_script_content(command, workdir)
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
    let app_data_dir = app_handle.path().app_data_dir().map_err(|error| {
        AppError::FileSystem(format!("Failed to resolve app data directory: {}", error))
    })?;

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
    validate_script_content_before_exec(&command, resolved_workdir_string.as_deref())?;

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

    // 2. 删除命令拦截 — 重写为移动到 Agent Trash Bin。PowerShell `$env:*` 路径必须
    // 使用与实际子进程相同的覆盖顺序，否则预检可能软删除错误的宿主文件。
    let prepared_sandbox_profile_env = if sandbox_policy.uses_restricted_process_backend() {
        Some(sandbox_profile_env(&app_data_dir)?)
    } else {
        None
    };
    let effective_delete_env = effective_delete_path_env(
        env.as_ref(),
        resolved_workdir.as_deref(),
        prepared_sandbox_profile_env.as_deref(),
    );
    let default_workdir_env = resolved_workdir.as_ref().and_then(|workdir| {
        (!user_env_contains_delete_path_key(env.as_ref(), "WORKDIR"))
            .then(|| workdir.to_string_lossy().to_string())
    });
    let delete_allowed_roots = sandbox_delete_allowed_roots(
        &app_data_dir,
        resolved_workdir.as_deref(),
        &sandbox_policy,
        &app_container_filesystem_grants,
    );
    match trash_bin::try_intercept_delete_scoped_with_env(
        &command,
        &app_data_dir,
        resolved_workdir.as_deref(),
        delete_allowed_roots.as_deref(),
        Some(&effective_delete_env),
    ) {
        Ok(trash_bin::DeleteInterceptionOutcome::Intercepted(message)) => {
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
        Ok(trash_bin::DeleteInterceptionOutcome::NotDelete) => {
            // 仅已证明不包含本地文件删除意图的命令可以继续执行。
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
    // Windows: 使用 cmd /D /S /C "..." 执行命令（/D 禁用 Command Processor AutoRun）
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

    // `$env:WORKDIR` is a supported delete-path convention. When the caller did not provide
    // it explicitly, bind it to the resolved current directory so Trash parsing and PowerShell
    // execution observe the same value.
    if let Some(workdir) = default_workdir_env {
        set_command_env(&mut cmd, &mut restricted_env_overrides, "WORKDIR", workdir);
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

    if let Some(profile_env) = prepared_sandbox_profile_env.as_deref() {
        apply_sandbox_profile_env_values(&mut cmd, &mut restricted_env_overrides, profile_env);
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
    for (key, value) in sandbox_policy.environment_overrides() {
        set_command_env(&mut cmd, &mut restricted_env_overrides, key, value);
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
                let pid = bg_registry
                    .register(child, sandbox, network_session)
                    .await
                    .map_err(AppError::Generic)?;
                log::debug!("[Shell] Background process started, PID={}", pid);
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
                    Some(pid),
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
        Some(
            foreground_cancellations()
                .lock()
                .await
                .register(id, Instant::now()),
        )
    } else {
        None
    };

    // 使用 spawn 创建独立 IO 读取任务——与 child.wait() 并发运行
    // 必须并发：避免进程写满管道缓冲区时 child.wait() 死锁
    let stdout_task = tokio::spawn(read_limited_pipe_output(child_stdout));
    let stderr_task = tokio::spawn(read_limited_pipe_output(child_stderr));

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
        foreground_cancellations().lock().await.clear(id);
    }

    match outcome {
        ForegroundOutcome::Exited(Ok(status)) => {
            // 进程已退出。正常情况下管道立即关闭，IO 任务瞬间完成。
            // 但 Windows 上 bat 脚本通过 start 启动的孙子进程可能继承管道句柄，
            // 导致 read_to_end 即使在父进程退出后仍不返回。
            // 设置 3 秒宽限期：正常命令不受影响，launcher 类脚本安全退出。
            let pipe_grace = Duration::from_secs(3);
            let stdout_capture = match tokio::time::timeout(pipe_grace, stdout_task).await {
                Ok(Ok(output)) => output,
                Ok(Err(e)) => {
                    log::warn!("[Shell] stdout 读取任务异常: {}", e);
                    CapturedPipeOutput::default()
                }
                Err(_) => {
                    log::debug!(
                        "[Shell] ⚠️ stdout 管道宽限期到达（孙子进程持有句柄），返回已收集的数据"
                    );
                    CapturedPipeOutput::default()
                }
            };
            let stderr_capture = match tokio::time::timeout(pipe_grace, stderr_task).await {
                Ok(Ok(output)) => output,
                Ok(Err(e)) => {
                    log::warn!("[Shell] stderr 读取任务异常: {}", e);
                    CapturedPipeOutput::default()
                }
                Err(_) => {
                    log::debug!(
                        "[Shell] ⚠️ stderr 管道宽限期到达（孙子进程持有句柄），返回已收集的数据"
                    );
                    CapturedPipeOutput::default()
                }
            };

            let exit_code = status.code().unwrap_or(-1);
            let stdout = decode_output(&stdout_capture.bytes);
            let stderr = decode_output(&stderr_capture.bytes);

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

            let mut result = shell_exec_result(
                exit_code,
                stdout,
                stderr,
                None,
                started_at,
                Some(timeout_duration),
                false,
                false,
            );
            result.stdout_truncated_bytes = stdout_capture.dropped_prefix_bytes;
            result.stderr_truncated_bytes = stderr_capture.dropped_prefix_bytes;
            Ok(result)
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
            let stdout_capture = match tokio::time::timeout(pipe_grace, stdout_task).await {
                Ok(Ok(output)) => output,
                Ok(Err(e)) => {
                    log::warn!("[Shell] stdout 读取任务异常: {}", e);
                    CapturedPipeOutput::default()
                }
                Err(_) => {
                    log::debug!("[Shell] ⚠️ timeout 后 stdout 管道宽限期到达，返回已收集的数据");
                    CapturedPipeOutput::default()
                }
            };
            let stderr_capture = match tokio::time::timeout(pipe_grace, stderr_task).await {
                Ok(Ok(output)) => output,
                Ok(Err(e)) => {
                    log::warn!("[Shell] stderr 读取任务异常: {}", e);
                    CapturedPipeOutput::default()
                }
                Err(_) => {
                    log::debug!("[Shell] ⚠️ timeout 后 stderr 管道宽限期到达，返回已收集的数据");
                    CapturedPipeOutput::default()
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
            let stdout = decode_output(&stdout_capture.bytes);
            let raw_stderr = decode_output(&stderr_capture.bytes);
            let stderr = if raw_stderr.trim().is_empty() {
                timeout_message
            } else {
                format!("{}\n{}", raw_stderr, timeout_message)
            };
            let mut result = shell_exec_result(
                -1,
                stdout,
                stderr,
                None,
                started_at,
                Some(timeout_duration),
                true,
                true,
            );
            result.stdout_truncated_bytes = stdout_capture.dropped_prefix_bytes;
            result.stderr_truncated_bytes = stderr_capture.dropped_prefix_bytes;
            Ok(result)
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
const PREVIEW_CACHE_DIRECTORY: &str = "project-preview";
const PREVIEW_WORKSPACE_PREFIX: &str = "project-preview-";
const PREVIEW_OWNER_MARKER_DIRECTORY: &str = ".agentvis";
const PREVIEW_OWNER_MARKER_FILE: &str = "active";
const PREVIEW_TEMPLATE_CACHE_DIRECTORY: &str = "preview-templates";
const PREVIEW_TEMPLATE_LOCK_DIRECTORY: &str = ".locks";
const PREVIEW_QUARANTINE_PREFIX: &str = ".trash-";
const PREVIEW_QUARANTINE_RECEIPT_SUFFIX: &str = ".owner.json";
const MAX_PREVIEW_OWNER_MARKER_BYTES: u64 = 4 * 1024;
const MIN_PREVIEW_STALE_AGE_MILLIS: i64 = 24 * 60 * 60 * 1_000;
const MAX_PREVIEW_STALE_SWEEP_LIMIT: u32 = 128;
const MAX_PREVIEW_STALE_SCAN_ENTRIES: usize = 4_096;
const MAX_PREVIEW_STALE_RESULT_ITEMS: usize = 128;
const MAX_PREVIEW_STALE_SWEEP_DURATION: Duration = Duration::from_secs(5);
const MAX_PREVIEW_CLEANUP_ENTRIES_PER_PASS: usize = 100_000;
const MAX_PREVIEW_CLEANUP_DEPTH: u32 = 128;
const MAX_PREVIEW_CLEANUP_DURATION: Duration = Duration::from_secs(2);
const PREVIEW_TEMPLATE_LOCK_ATTEMPTS: usize = 3_100;
const PREVIEW_TEMPLATE_LOCK_RETRY_MILLIS: u64 = 100;

fn is_preview_template_id(value: &str) -> bool {
    matches!(value, "vanilla" | "react-tailwind" | "vue-tailwind")
}

fn preview_template_leases() -> &'static Mutex<HashMap<String, std::fs::File>> {
    static LEASES: OnceLock<Mutex<HashMap<String, std::fs::File>>> = OnceLock::new();
    LEASES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn open_preview_template_lock_file(path: &Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(any(target_os = "linux", target_os = "android"))]
        const O_NOFOLLOW: i32 = 0x0002_0000;
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        const O_NOFOLLOW: i32 = 0x0000_0100;
        options.custom_flags(O_NOFOLLOW);
    }
    options.open(path).map_err(|error| {
        format!(
            "Failed to open preview template lock {}: {error}",
            path.display()
        )
    })
}

fn is_preview_template_lock_contention(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::WouldBlock {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        // LockFileEx reports ERROR_SHARING_VIOLATION or ERROR_LOCK_VIOLATION rather
        // than mapping both cases to ErrorKind::WouldBlock.
        return matches!(error.raw_os_error(), Some(32) | Some(33));
    }
    #[cfg(not(target_os = "windows"))]
    false
}

fn acquire_preview_template_lock_at_app_data(
    app_data_dir: &Path,
    template_id: &str,
    attempts: usize,
    retry_delay: Duration,
) -> Result<String, String> {
    if !is_preview_template_id(template_id) {
        return Err("Invalid preview template id".to_string());
    }
    if attempts == 0 {
        return Err("Preview template lock attempts must be positive".to_string());
    }

    let template_root = app_data_dir.join(PREVIEW_TEMPLATE_CACHE_DIRECTORY);
    let lock_root = template_root.join(PREVIEW_TEMPLATE_LOCK_DIRECTORY);
    std::fs::create_dir_all(&lock_root).map_err(|error| {
        format!(
            "Failed to create preview template lock directory {}: {error}",
            lock_root.display()
        )
    })?;
    validate_real_directory(&template_root, "preview template cache root")?;
    validate_real_directory(&lock_root, "preview template lock root")?;

    let lock_path = lock_root.join(format!("{template_id}.lock"));
    let lock_file = open_preview_template_lock_file(&lock_path)?;
    for attempt in 0..attempts {
        match fs2::FileExt::try_lock_exclusive(&lock_file) {
            Ok(()) => {
                let lease_token = uuid::Uuid::new_v4().to_string();
                let mut leases = preview_template_leases()
                    .lock()
                    .map_err(|_| "Preview template lease registry is poisoned".to_string())?;
                if leases.contains_key(&lease_token) {
                    return Err("Preview template lease token collision".to_string());
                }
                leases.insert(lease_token.clone(), lock_file);
                return Ok(lease_token);
            }
            Err(error) if is_preview_template_lock_contention(&error) => {
                if attempt + 1 < attempts {
                    std::thread::sleep(retry_delay);
                }
            }
            Err(error) => {
                return Err(format!(
                    "Failed to acquire preview template lock {}: {error}",
                    lock_path.display()
                ));
            }
        }
    }

    Err(format!(
        "Timed out waiting for another AgentVis instance to finish preparing template {template_id}"
    ))
}

fn release_preview_template_lock(lease_token: &str) -> Result<(), String> {
    if !is_uuid_v4_text(lease_token) {
        return Err("Invalid preview template lease token".to_string());
    }
    let lease = preview_template_leases()
        .lock()
        .map_err(|_| "Preview template lease registry is poisoned".to_string())?
        .remove(lease_token)
        .ok_or_else(|| "Preview template lease token is not active".to_string())?;
    let result = fs2::FileExt::unlock(&lease)
        .map_err(|error| format!("Failed to release preview template lock: {error}"));
    drop(lease);
    result
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewWorkspaceOwnerMarker {
    id: String,
    owner_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    updated_at_ms: Option<i64>,
}

#[derive(Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewQuarantineReceipt {
    trash_name: String,
    run_id: String,
    owner_token: String,
    created_at_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewWorkspaceCreateResult {
    pub workspace: String,
    pub run_id: String,
    pub owner_token: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewWorkspaceCleanupResult {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quarantined_workspace: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStaleWorkspaceCleanupItem {
    pub run_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quarantined_workspace: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStaleWorkspacesCleanupResult {
    pub removed: u32,
    pub refused: u32,
    pub not_found: u32,
    pub has_more: bool,
    pub results: Vec<PreviewStaleWorkspaceCleanupItem>,
}

impl PreviewWorkspaceCleanupResult {
    fn removed() -> Self {
        Self {
            status: "removed".to_string(),
            reason: None,
            quarantined_workspace: None,
        }
    }

    fn not_found() -> Self {
        Self {
            status: "not-found".to_string(),
            reason: None,
            quarantined_workspace: None,
        }
    }

    fn refused(reason: impl Into<String>) -> Self {
        Self {
            status: "refused".to_string(),
            reason: Some(reason.into()),
            quarantined_workspace: None,
        }
    }

    fn refused_quarantined(reason: impl Into<String>, workspace: &Path) -> Self {
        Self {
            status: "refused".to_string(),
            reason: Some(reason.into()),
            quarantined_workspace: Some(workspace.to_string_lossy().into_owned()),
        }
    }
}

fn is_uuid_v4_text(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().copied().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    bytes[14] == b'4' && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
}

fn is_preview_workspace_run_id(run_id: &str) -> bool {
    run_id
        .strip_prefix(PREVIEW_WORKSPACE_PREFIX)
        .is_some_and(is_uuid_v4_text)
}

fn is_preview_quarantine_name(name: &str) -> bool {
    name.strip_prefix(PREVIEW_QUARANTINE_PREFIX)
        .is_some_and(is_uuid_v4_text)
}

fn preview_quarantine_name_from_receipt_name(name: &str) -> Option<String> {
    let trash_name = name.strip_suffix(PREVIEW_QUARANTINE_RECEIPT_SUFFIX)?;
    is_preview_quarantine_name(trash_name).then(|| trash_name.to_string())
}

fn preview_quarantine_receipt_path(root: &Path, trash_name: &str) -> PathBuf {
    root.join(format!("{trash_name}{PREVIEW_QUARANTINE_RECEIPT_SUFFIX}"))
}

fn remove_preview_quarantine_receipt(trash: &Path) -> Result<(), String> {
    let root = trash
        .parent()
        .ok_or_else(|| "Quarantine path has no preview cache parent".to_string())?;
    let trash_name = trash
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Quarantine path has a non-Unicode name".to_string())?;
    let receipt = preview_quarantine_receipt_path(root, trash_name);
    match std::fs::remove_file(&receipt) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to remove preview quarantine receipt {}: {error}",
            receipt.display()
        )),
    }
}

fn metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = metadata;
        false
    }
}

fn metadata_is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink() || metadata_is_reparse_point(metadata)
}

fn metadata_is_directory_entry(metadata: &std::fs::Metadata) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;
        metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0
    }
    #[cfg(not(target_os = "windows"))]
    {
        metadata.is_dir()
    }
}

fn validate_real_directory(path: &Path, label: &str) -> Result<std::fs::Metadata, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect {label} {}: {error}", path.display()))?;
    if !metadata.is_dir() || metadata_is_link_or_reparse(&metadata) {
        return Err(format!(
            "Refusing {label} because it is not a real directory: {}",
            path.display()
        ));
    }
    Ok(metadata)
}

fn current_unix_time_millis() -> Result<i64, String> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("System clock predates the Unix epoch: {error}"))?
        .as_millis();
    i64::try_from(millis).map_err(|_| "Current timestamp exceeds i64 range".to_string())
}

fn modified_unix_time_millis(metadata: &std::fs::Metadata) -> Result<i64, String> {
    let modified = metadata
        .modified()
        .map_err(|error| format!("Failed to read owner marker mtime: {error}"))?;
    match modified.duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis())
            .map_err(|_| "Owner marker mtime exceeds i64 range".to_string()),
        Err(error) => {
            let millis = i64::try_from(error.duration().as_millis())
                .map_err(|_| "Owner marker mtime predates i64 range".to_string())?;
            Ok(-millis)
        }
    }
}

fn marker_metadata_matches(first: &std::fs::Metadata, second: &std::fs::Metadata) -> bool {
    first.len() == second.len()
        && first.modified().ok() == second.modified().ok()
        && first.file_type().is_file() == second.file_type().is_file()
        && metadata_is_reparse_point(first) == metadata_is_reparse_point(second)
}

fn open_preview_marker_no_follow(path: &Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(any(target_os = "linux", target_os = "android"))]
        const O_NOFOLLOW: i32 = 0x0002_0000;
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        const O_NOFOLLOW: i32 = 0x0000_0100;
        options.custom_flags(O_NOFOLLOW);
    }
    options.open(path).map_err(|error| {
        format!(
            "Failed to open preview owner marker {}: {error}",
            path.display()
        )
    })
}

fn open_preview_owner_lease_file(path: &Path, create_new: bool) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create_new(create_new);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Keep the marker writable by heartbeat updates, but prevent directory rename/delete
        // while this app instance owns the workspace.
        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_WRITE: u32 = 0x0000_0002;
        options.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(any(target_os = "linux", target_os = "android"))]
        const O_NOFOLLOW: i32 = 0x0002_0000;
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        const O_NOFOLLOW: i32 = 0x0000_0100;
        options.custom_flags(O_NOFOLLOW);
    }
    options.open(path).map_err(|error| {
        format!(
            "Failed to open preview workspace lease {}: {error}",
            path.display()
        )
    })
}

fn preview_workspace_leases() -> &'static Mutex<HashMap<String, std::fs::File>> {
    static LEASES: OnceLock<Mutex<HashMap<String, std::fs::File>>> = OnceLock::new();
    LEASES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_preview_workspace_lease(
    owner_token: &str,
    lease_file: std::fs::File,
) -> Result<(), String> {
    let mut leases = preview_workspace_leases()
        .lock()
        .map_err(|_| "Preview workspace lease registry is poisoned".to_string())?;
    if leases.contains_key(owner_token) {
        return Err("Preview owner token is already registered".to_string());
    }
    leases.insert(owner_token.to_string(), lease_file);
    Ok(())
}

fn lock_preview_workspace_lease(file: &std::fs::File) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Windows ownership is enforced by the handle's FILE_SHARE_READ|FILE_SHARE_WRITE mode,
        // which intentionally omits FILE_SHARE_DELETE without blocking heartbeat reads.
        let _ = file;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        fs2::FileExt::lock_exclusive(file)
            .map_err(|error| format!("Failed to acquire preview workspace lease: {error}"))
    }
}

fn release_preview_workspace_lease(owner_token: &str) -> Result<bool, String> {
    let lease = preview_workspace_leases()
        .lock()
        .map_err(|_| "Preview workspace lease registry is poisoned".to_string())?
        .remove(owner_token);
    let released = lease.is_some();
    drop(lease);
    Ok(released)
}

fn preview_workspace_has_local_lease(owner_token: &str) -> Result<bool, String> {
    Ok(preview_workspace_leases()
        .lock()
        .map_err(|_| "Preview workspace lease registry is poisoned".to_string())?
        .contains_key(owner_token))
}

fn reacquire_preview_workspace_lease(workspace: &Path, owner_token: &str) -> Result<(), String> {
    let marker_path = workspace
        .join(PREVIEW_OWNER_MARKER_DIRECTORY)
        .join(PREVIEW_OWNER_MARKER_FILE);
    let lease_file = open_preview_owner_lease_file(&marker_path, false)?;
    lock_preview_workspace_lease(&lease_file)?;
    register_preview_workspace_lease(owner_token, lease_file)
}

fn preview_workspace_has_active_lease(workspace: &Path, owner_token: &str) -> Result<bool, String> {
    if preview_workspace_has_local_lease(owner_token)? {
        return Ok(true);
    }

    #[cfg(target_os = "windows")]
    {
        let _ = workspace;
        Ok(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let marker_path = workspace
            .join(PREVIEW_OWNER_MARKER_DIRECTORY)
            .join(PREVIEW_OWNER_MARKER_FILE);
        let probe = open_preview_owner_lease_file(&marker_path, false)?;
        match fs2::FileExt::try_lock_exclusive(&probe) {
            Ok(()) => {
                fs2::FileExt::unlock(&probe)
                    .map_err(|error| format!("Failed to release preview lease probe: {error}"))?;
                Ok(false)
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(true),
            Err(error) => Err(format!("Failed to probe preview workspace lease: {error}")),
        }
    }
}

fn read_preview_owner_marker(
    workspace: &Path,
) -> Result<(PreviewWorkspaceOwnerMarker, std::fs::Metadata), String> {
    use std::io::Read;

    let marker_directory = workspace.join(PREVIEW_OWNER_MARKER_DIRECTORY);
    validate_real_directory(&marker_directory, "preview marker directory")?;
    let marker_path = marker_directory.join(PREVIEW_OWNER_MARKER_FILE);
    let before = std::fs::symlink_metadata(&marker_path).map_err(|error| {
        format!(
            "Failed to inspect preview owner marker {}: {error}",
            marker_path.display()
        )
    })?;
    if !before.is_file() || metadata_is_link_or_reparse(&before) {
        return Err(format!(
            "Refusing preview workspace with a non-file owner marker: {}",
            marker_path.display()
        ));
    }
    if before.len() > MAX_PREVIEW_OWNER_MARKER_BYTES {
        return Err(format!(
            "Refusing oversized preview owner marker ({} bytes)",
            before.len()
        ));
    }

    let file = open_preview_marker_no_follow(&marker_path)?;
    let opened = file
        .metadata()
        .map_err(|error| format!("Failed to inspect opened preview owner marker: {error}"))?;
    if !opened.is_file()
        || metadata_is_link_or_reparse(&opened)
        || !marker_metadata_matches(&before, &opened)
    {
        return Err("Preview owner marker changed while it was being opened".to_string());
    }

    let mut bytes = Vec::new();
    file.take(MAX_PREVIEW_OWNER_MARKER_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read preview owner marker: {error}"))?;
    if bytes.len() as u64 > MAX_PREVIEW_OWNER_MARKER_BYTES {
        return Err("Preview owner marker grew beyond the size limit".to_string());
    }

    let after = std::fs::symlink_metadata(&marker_path)
        .map_err(|error| format!("Failed to re-inspect preview owner marker: {error}"))?;
    if !after.is_file()
        || metadata_is_link_or_reparse(&after)
        || !marker_metadata_matches(&opened, &after)
    {
        return Err("Preview owner marker changed while it was being read".to_string());
    }

    let marker = serde_json::from_slice::<PreviewWorkspaceOwnerMarker>(&bytes)
        .map_err(|error| format!("Invalid preview owner marker JSON: {error}"))?;
    Ok((marker, after))
}

fn write_preview_quarantine_receipt(
    root: &Path,
    trash_name: &str,
    run_id: &str,
    owner_token: &str,
) -> Result<PathBuf, String> {
    use std::io::Write;

    let receipt_path = preview_quarantine_receipt_path(root, trash_name);
    let receipt = PreviewQuarantineReceipt {
        trash_name: trash_name.to_string(),
        run_id: run_id.to_string(),
        owner_token: owner_token.to_string(),
        created_at_ms: current_unix_time_millis()?,
    };
    let bytes = serde_json::to_vec(&receipt)
        .map_err(|error| format!("Failed to encode preview quarantine receipt: {error}"))?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&receipt_path)
        .map_err(|error| {
            format!(
                "Failed to create preview quarantine receipt {}: {error}",
                receipt_path.display()
            )
        })?;
    file.write_all(&bytes)
        .map_err(|error| format!("Failed to write preview quarantine receipt: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Failed to flush preview quarantine receipt: {error}"))?;
    Ok(receipt_path)
}

fn read_preview_quarantine_receipt(
    root: &Path,
    trash_name: &str,
) -> Result<(PreviewQuarantineReceipt, std::fs::Metadata), String> {
    use std::io::Read;

    let receipt_path = preview_quarantine_receipt_path(root, trash_name);
    let before = std::fs::symlink_metadata(&receipt_path).map_err(|error| {
        format!(
            "Failed to inspect preview quarantine receipt {}: {error}",
            receipt_path.display()
        )
    })?;
    if !before.is_file()
        || metadata_is_link_or_reparse(&before)
        || before.len() > MAX_PREVIEW_OWNER_MARKER_BYTES
    {
        return Err("Refusing invalid preview quarantine receipt".to_string());
    }
    let file = open_preview_marker_no_follow(&receipt_path)?;
    let opened = file
        .metadata()
        .map_err(|error| format!("Failed to inspect opened quarantine receipt: {error}"))?;
    if !opened.is_file()
        || metadata_is_link_or_reparse(&opened)
        || !marker_metadata_matches(&before, &opened)
    {
        return Err("Preview quarantine receipt changed while being opened".to_string());
    }
    let mut bytes = Vec::new();
    file.take(MAX_PREVIEW_OWNER_MARKER_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read preview quarantine receipt: {error}"))?;
    if bytes.len() as u64 > MAX_PREVIEW_OWNER_MARKER_BYTES {
        return Err("Preview quarantine receipt exceeds the size limit".to_string());
    }
    let after = std::fs::symlink_metadata(&receipt_path)
        .map_err(|error| format!("Failed to re-inspect quarantine receipt: {error}"))?;
    if !after.is_file()
        || metadata_is_link_or_reparse(&after)
        || !marker_metadata_matches(&opened, &after)
    {
        return Err("Preview quarantine receipt changed while being read".to_string());
    }
    let receipt = serde_json::from_slice::<PreviewQuarantineReceipt>(&bytes)
        .map_err(|error| format!("Invalid preview quarantine receipt JSON: {error}"))?;
    Ok((receipt, after))
}

fn cleanup_orphan_preview_quarantine_receipt_at_root(
    root: &Path,
    trash_name: &str,
    stale_before_ms: i64,
) -> Result<bool, String> {
    if !is_preview_quarantine_name(trash_name) {
        return Err("Refusing orphan receipt with an invalid quarantine name".to_string());
    }

    let receipt_path = preview_quarantine_receipt_path(root, trash_name);
    match std::fs::symlink_metadata(&receipt_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Failed to inspect orphan preview quarantine receipt {}: {error}",
                receipt_path.display()
            ));
        }
        Ok(_) => {}
    }
    let (receipt, first_metadata) = read_preview_quarantine_receipt(root, trash_name)?;
    if modified_unix_time_millis(&first_metadata)? > stale_before_ms {
        return Ok(false);
    }
    if receipt.trash_name != trash_name
        || !is_preview_workspace_run_id(&receipt.run_id)
        || !is_uuid_v4_text(&receipt.owner_token)
        || receipt.created_at_ms <= 0
        || receipt.created_at_ms > stale_before_ms
    {
        return Err(
            "Refusing orphan receipt whose ownership fields are not self-consistent".to_string(),
        );
    }

    let trash = root.join(trash_name);
    match std::fs::symlink_metadata(&trash) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Failed to inspect paired preview quarantine {}: {error}",
                trash.display()
            ));
        }
        Ok(_) => return Ok(false),
    }

    // Re-read both ownership evidence and metadata after confirming the paired quarantine is
    // absent. This keeps a refreshed, replaced, linked, or mismatched receipt fail-closed.
    let (confirmed_receipt, confirmed_metadata) =
        read_preview_quarantine_receipt(root, trash_name)?;
    if confirmed_receipt != receipt
        || !marker_metadata_matches(&first_metadata, &confirmed_metadata)
        || modified_unix_time_millis(&confirmed_metadata)? > stale_before_ms
    {
        return Err("Refusing orphan receipt that changed before cleanup".to_string());
    }
    match std::fs::symlink_metadata(&trash) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Failed to re-inspect paired preview quarantine {}: {error}",
                trash.display()
            ));
        }
        Ok(_) => return Ok(false),
    }

    match std::fs::remove_file(&receipt_path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "Failed to remove orphan preview quarantine receipt {}: {error}",
            receipt_path.display()
        )),
    }
}

#[cfg(target_os = "windows")]
const PREVIEW_QUARANTINE_RENAME_RETRY_DELAYS_MS: [u64; 6] = [25, 50, 100, 200, 400, 800];

#[cfg(target_os = "windows")]
fn is_retryable_preview_quarantine_rename_error(error: &std::io::Error) -> bool {
    // A just-terminated Node/Vite process can briefly retain its current-directory or watcher
    // handles. Windows reports those transient close races as access denied, sharing violation,
    // or lock violation. Other failures remain fail-closed and are returned immediately.
    matches!(error.raw_os_error(), Some(5 | 32 | 33))
}

#[cfg(target_os = "windows")]
fn validate_preview_quarantine_rename_retry(
    root: &Path,
    workspace: &Path,
    trash: &Path,
    trash_name: &str,
    expected_run_id: &str,
    expected_owner_token: &str,
    stale_before_ms: Option<i64>,
) -> Result<(), String> {
    validate_real_directory(root, "preview cache root")?;
    validate_preview_workspace_contents(
        workspace,
        expected_run_id,
        expected_owner_token,
        stale_before_ms,
    )?;

    let (receipt, _) = read_preview_quarantine_receipt(root, trash_name)?;
    if receipt.trash_name != trash_name
        || receipt.run_id != expected_run_id
        || receipt.owner_token != expected_owner_token
    {
        return Err("Preview quarantine receipt changed before rename retry".to_string());
    }

    match std::fs::symlink_metadata(trash) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to inspect preview quarantine target {} before retry: {error}",
            trash.display()
        )),
        Ok(_) => Err(format!(
            "Preview quarantine target unexpectedly appeared before retry: {}",
            trash.display()
        )),
    }
}

fn rename_preview_workspace_to_quarantine(
    root: &Path,
    workspace: &Path,
    trash: &Path,
    trash_name: &str,
    expected_run_id: &str,
    expected_owner_token: &str,
    stale_before_ms: Option<i64>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        for retry_delay_ms in PREVIEW_QUARANTINE_RENAME_RETRY_DELAYS_MS
            .iter()
            .copied()
            .map(Some)
            .chain(std::iter::once(None))
        {
            match std::fs::rename(workspace, trash) {
                Ok(()) => return Ok(()),
                Err(error)
                    if retry_delay_ms.is_some()
                        && is_retryable_preview_quarantine_rename_error(&error) =>
                {
                    std::thread::sleep(Duration::from_millis(
                        retry_delay_ms.expect("checked retry delay"),
                    ));
                    validate_preview_quarantine_rename_retry(
                        root,
                        workspace,
                        trash,
                        trash_name,
                        expected_run_id,
                        expected_owner_token,
                        stale_before_ms,
                    )?;
                }
                Err(error) => return Err(error.to_string()),
            }
        }
        unreachable!("preview quarantine rename retry loop always returns");
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (
            root,
            trash_name,
            expected_run_id,
            expected_owner_token,
            stale_before_ms,
        );
        std::fs::rename(workspace, trash).map_err(|error| error.to_string())
    }
}

fn validate_preview_workspace_contents(
    workspace: &Path,
    expected_run_id: &str,
    expected_owner_token: &str,
    stale_before_ms: Option<i64>,
) -> Result<(), String> {
    validate_real_directory(workspace, "preview workspace")?;
    let (marker, marker_metadata) = read_preview_owner_marker(workspace)?;
    if marker.id != expected_run_id {
        return Err(format!(
            "Preview owner marker id mismatch: expected {expected_run_id}"
        ));
    }
    if marker.owner_token != expected_owner_token {
        return Err("Preview owner token mismatch".to_string());
    }
    if let Some(cutoff) = stale_before_ms {
        let latest_allowed_cutoff = current_unix_time_millis()?
            .checked_sub(MIN_PREVIEW_STALE_AGE_MILLIS)
            .ok_or_else(|| "Stale cutoff underflow".to_string())?;
        if cutoff > latest_allowed_cutoff {
            return Err("Stale cleanup cutoff must be at least 24 hours old".to_string());
        }
        let marker_mtime = modified_unix_time_millis(&marker_metadata)?;
        if marker_mtime > cutoff {
            return Err(format!(
                "Preview workspace is still active (marker mtime {marker_mtime} is newer than cutoff {cutoff})"
            ));
        }
    }
    Ok(())
}

fn preview_cache_root(app_cache_dir: &Path) -> PathBuf {
    app_cache_dir.join(PREVIEW_CACHE_DIRECTORY)
}

fn ensure_preview_cache_root(app_cache_dir: &Path) -> Result<PathBuf, String> {
    match std::fs::symlink_metadata(app_cache_dir) {
        Ok(_) => {
            validate_real_directory(app_cache_dir, "app cache directory")?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(app_cache_dir).map_err(|error| {
                format!(
                    "Failed to create app cache directory {}: {error}",
                    app_cache_dir.display()
                )
            })?;
            validate_real_directory(app_cache_dir, "app cache directory")?;
        }
        Err(error) => {
            return Err(format!(
                "Failed to inspect app cache directory {}: {error}",
                app_cache_dir.display()
            ));
        }
    }

    let root = preview_cache_root(app_cache_dir);
    match std::fs::symlink_metadata(&root) {
        Ok(_) => {
            validate_real_directory(&root, "preview cache root")?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::create_dir(&root) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(format!(
                        "Failed to create preview cache root {}: {error}",
                        root.display()
                    ));
                }
            }
            validate_real_directory(&root, "preview cache root")?;
        }
        Err(error) => {
            return Err(format!(
                "Failed to inspect preview cache root {}: {error}",
                root.display()
            ));
        }
    }
    Ok(root)
}

pub(crate) fn create_preview_workspace_at_cache(
    app_cache_dir: &Path,
    run_id: &str,
) -> Result<PreviewWorkspaceCreateResult, String> {
    use std::io::Write;

    if !is_preview_workspace_run_id(run_id) {
        return Err(format!(
            "Invalid preview run id; expected {PREVIEW_WORKSPACE_PREFIX}<UUIDv4>"
        ));
    }
    let root = ensure_preview_cache_root(app_cache_dir)?;
    let workspace = root.join(run_id);
    std::fs::create_dir(&workspace).map_err(|error| {
        format!(
            "Failed to create fresh preview workspace {}: {error}",
            workspace.display()
        )
    })?;

    let creation_result = (|| {
        validate_real_directory(&workspace, "new preview workspace")?;
        let marker_directory = workspace.join(PREVIEW_OWNER_MARKER_DIRECTORY);
        std::fs::create_dir(&marker_directory).map_err(|error| {
            format!(
                "Failed to create preview marker directory {}: {error}",
                marker_directory.display()
            )
        })?;
        validate_real_directory(&marker_directory, "preview marker directory")?;

        let owner_token = uuid::Uuid::new_v4().to_string();
        let marker = PreviewWorkspaceOwnerMarker {
            id: run_id.to_string(),
            owner_token: owner_token.clone(),
            updated_at_ms: Some(current_unix_time_millis()?),
        };
        let marker_bytes = serde_json::to_vec(&marker)
            .map_err(|error| format!("Failed to encode preview owner marker: {error}"))?;
        let marker_path = marker_directory.join(PREVIEW_OWNER_MARKER_FILE);
        let mut marker_file = open_preview_owner_lease_file(&marker_path, true)?;
        marker_file
            .write_all(&marker_bytes)
            .map_err(|error| format!("Failed to write preview owner marker: {error}"))?;
        marker_file
            .sync_all()
            .map_err(|error| format!("Failed to flush preview owner marker: {error}"))?;
        lock_preview_workspace_lease(&marker_file)?;
        register_preview_workspace_lease(&owner_token, marker_file)?;

        Ok(PreviewWorkspaceCreateResult {
            workspace: workspace.to_string_lossy().into_owned(),
            run_id: run_id.to_string(),
            owner_token,
        })
    })();
    if creation_result.is_err() {
        let _ = std::fs::remove_dir_all(&workspace);
    }
    creation_result
}

fn remove_link_itself(path: &Path, metadata: &std::fs::Metadata) -> Result<(), String> {
    let result = if metadata_is_directory_entry(metadata) {
        std::fs::remove_dir(path)
    } else {
        std::fs::remove_file(path)
    };
    result.map_err(|error| format!("Failed to remove link {}: {error}", path.display()))
}

#[derive(Clone, Copy)]
struct PreviewCleanupLimits {
    max_entries: usize,
    max_depth: u32,
    max_duration: Duration,
}

impl PreviewCleanupLimits {
    fn production() -> Self {
        Self {
            max_entries: MAX_PREVIEW_CLEANUP_ENTRIES_PER_PASS,
            max_depth: MAX_PREVIEW_CLEANUP_DEPTH,
            max_duration: MAX_PREVIEW_CLEANUP_DURATION,
        }
    }
}

struct PreviewCleanupBudget {
    limits: PreviewCleanupLimits,
    started_at: Instant,
    visited_entries: usize,
}

impl PreviewCleanupBudget {
    fn new(limits: PreviewCleanupLimits) -> Self {
        Self {
            limits,
            started_at: Instant::now(),
            visited_entries: 0,
        }
    }

    fn check_time(&self) -> Result<(), String> {
        if self.started_at.elapsed() >= self.limits.max_duration {
            return Err(format!(
                "Preview cleanup time budget exceeded after {:?}",
                self.limits.max_duration
            ));
        }
        Ok(())
    }

    fn record_entry(&mut self, depth: u32) -> Result<(), String> {
        self.check_time()?;
        if depth > self.limits.max_depth {
            return Err(format!(
                "Preview cleanup depth budget exceeded: {depth} > {}",
                self.limits.max_depth
            ));
        }
        if self.visited_entries >= self.limits.max_entries {
            return Err(format!(
                "Preview cleanup entry budget exceeded: {} entries per pass",
                self.limits.max_entries
            ));
        }
        self.visited_entries += 1;
        Ok(())
    }
}

enum PreviewCleanupFrame {
    Visit {
        path: PathBuf,
        inside_node_modules: bool,
        depth: u32,
    },
    Directory {
        path: PathBuf,
        child_is_inside_node_modules: bool,
        depth: u32,
        entries: std::fs::ReadDir,
        deferred_owner_entries: Vec<PathBuf>,
    },
}

fn is_deferred_preview_owner_entry(parent: &Path, child: &Path, workspace_root: &Path) -> bool {
    let child_name = child.file_name();
    (parent == workspace_root
        && child_name == Some(std::ffi::OsStr::new(PREVIEW_OWNER_MARKER_DIRECTORY)))
        || (parent == workspace_root.join(PREVIEW_OWNER_MARKER_DIRECTORY)
            && child_name == Some(std::ffi::OsStr::new(PREVIEW_OWNER_MARKER_FILE)))
}

fn remove_preview_tree_no_follow(
    path: &Path,
    workspace_root: &Path,
    canonical_workspace_root: &Path,
) -> Result<(), String> {
    remove_preview_tree_no_follow_with_limits(
        path,
        workspace_root,
        canonical_workspace_root,
        PreviewCleanupLimits::production(),
    )
}

fn remove_preview_tree_no_follow_with_limits(
    path: &Path,
    workspace_root: &Path,
    canonical_workspace_root: &Path,
    limits: PreviewCleanupLimits,
) -> Result<(), String> {
    let mut budget = PreviewCleanupBudget::new(limits);
    let mut frames = vec![PreviewCleanupFrame::Visit {
        path: path.to_path_buf(),
        inside_node_modules: false,
        depth: 0,
    }];

    while let Some(frame) = frames.pop() {
        match frame {
            PreviewCleanupFrame::Visit {
                path,
                inside_node_modules,
                depth,
            } => {
                budget.record_entry(depth)?;
                let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
                    format!(
                        "Failed to inspect cleanup entry {}: {error}",
                        path.display()
                    )
                })?;
                if metadata_is_link_or_reparse(&metadata) {
                    let is_top_level_node_modules = path == workspace_root.join("node_modules");
                    if inside_node_modules || is_top_level_node_modules {
                        remove_link_itself(&path, &metadata)?;
                        continue;
                    }
                    return Err(format!(
                        "Refusing link/reparse point during preview cleanup: {}",
                        path.display()
                    ));
                }
                if metadata.is_file() {
                    std::fs::remove_file(&path).map_err(|error| {
                        format!("Failed to remove file {}: {error}", path.display())
                    })?;
                    continue;
                }
                if !metadata.is_dir() {
                    return Err(format!(
                        "Refusing unsupported filesystem entry during preview cleanup: {}",
                        path.display()
                    ));
                }

                let canonical_path = std::fs::canonicalize(&path).map_err(|error| {
                    format!(
                        "Failed to canonicalize cleanup directory {}: {error}",
                        path.display()
                    )
                })?;
                if !canonical_path.starts_with(canonical_workspace_root) {
                    return Err(format!(
                        "Refusing cleanup directory that escapes the renamed workspace: {}",
                        path.display()
                    ));
                }
                let entries = std::fs::read_dir(&path).map_err(|error| {
                    format!(
                        "Failed to enumerate cleanup entry {}: {error}",
                        path.display()
                    )
                })?;
                frames.push(PreviewCleanupFrame::Directory {
                    child_is_inside_node_modules: inside_node_modules
                        || path == workspace_root.join("node_modules"),
                    path,
                    depth,
                    entries,
                    deferred_owner_entries: Vec::new(),
                });
            }
            PreviewCleanupFrame::Directory {
                path,
                child_is_inside_node_modules,
                depth,
                mut entries,
                mut deferred_owner_entries,
            } => {
                budget.check_time()?;
                if let Some(entry) = entries.next() {
                    let child = entry
                        .map_err(|error| {
                            format!("Failed to enumerate a child of {}: {error}", path.display())
                        })?
                        .path();
                    if is_deferred_preview_owner_entry(&path, &child, workspace_root) {
                        deferred_owner_entries.push(child);
                        frames.push(PreviewCleanupFrame::Directory {
                            path,
                            child_is_inside_node_modules,
                            depth,
                            entries,
                            deferred_owner_entries,
                        });
                    } else {
                        frames.push(PreviewCleanupFrame::Directory {
                            path,
                            child_is_inside_node_modules,
                            depth,
                            entries,
                            deferred_owner_entries,
                        });
                        frames.push(PreviewCleanupFrame::Visit {
                            path: child,
                            inside_node_modules: child_is_inside_node_modules,
                            depth: depth + 1,
                        });
                    }
                } else if let Some(child) = deferred_owner_entries.pop() {
                    frames.push(PreviewCleanupFrame::Directory {
                        path,
                        child_is_inside_node_modules,
                        depth,
                        entries,
                        deferred_owner_entries,
                    });
                    frames.push(PreviewCleanupFrame::Visit {
                        path: child,
                        inside_node_modules: child_is_inside_node_modules,
                        depth: depth + 1,
                    });
                } else {
                    std::fs::remove_dir(&path).map_err(|error| {
                        format!("Failed to remove directory {}: {error}", path.display())
                    })?;
                }
            }
        }
    }
    Ok(())
}

fn restore_renamed_workspace(
    trash: &Path,
    workspace: &Path,
    owner_token: &str,
    reacquire_lease: bool,
    reason: String,
) -> PreviewWorkspaceCleanupResult {
    match std::fs::rename(trash, workspace) {
        Ok(()) => {
            let mut reason = reason;
            if let Err(error) = remove_preview_quarantine_receipt(trash) {
                reason.push_str(&format!("; {error}"));
            }
            let reason = if reacquire_lease {
                match reacquire_preview_workspace_lease(workspace, owner_token) {
                    Ok(()) => reason,
                    Err(error) => {
                        format!("{reason}; workspace was restored but its owner lease could not be reacquired: {error}")
                    }
                }
            } else {
                reason
            };
            PreviewWorkspaceCleanupResult::refused(reason)
        }
        Err(error) => PreviewWorkspaceCleanupResult::refused_quarantined(
            format!(
                "{reason}; failed to restore renamed workspace {} -> {}: {error}",
                trash.display(),
                workspace.display()
            ),
            trash,
        ),
    }
}

pub(crate) fn cleanup_preview_workspace_at_cache(
    app_cache_dir: &Path,
    workspace: &Path,
    expected_run_id: &str,
    expected_owner_token: &str,
    stale_before_ms: Option<i64>,
) -> Result<PreviewWorkspaceCleanupResult, String> {
    if !is_preview_workspace_run_id(expected_run_id) {
        return Ok(PreviewWorkspaceCleanupResult::refused(
            "Invalid preview run id; expected project-preview-<UUIDv4>",
        ));
    }
    if !is_uuid_v4_text(expected_owner_token) {
        return Ok(PreviewWorkspaceCleanupResult::refused(
            "Invalid preview owner token; expected UUIDv4",
        ));
    }

    let root = preview_cache_root(app_cache_dir);
    match std::fs::symlink_metadata(&root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PreviewWorkspaceCleanupResult::not_found());
        }
        Err(error) => {
            return Err(format!(
                "Failed to inspect preview cache root {}: {error}",
                root.display()
            ));
        }
        Ok(_) => {
            if let Err(reason) = validate_real_directory(&root, "preview cache root") {
                return Ok(PreviewWorkspaceCleanupResult::refused(reason));
            }
        }
    }

    let expected_workspace = root.join(expected_run_id);
    if workspace != expected_workspace
        || workspace.parent() != Some(root.as_path())
        || workspace.file_name().and_then(|name| name.to_str()) != Some(expected_run_id)
    {
        return Ok(PreviewWorkspaceCleanupResult::refused(
            "Workspace must be the exact direct child selected by expectedRunId",
        ));
    }

    match std::fs::symlink_metadata(workspace) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PreviewWorkspaceCleanupResult::not_found());
        }
        Err(error) => {
            return Err(format!(
                "Failed to inspect preview workspace {}: {error}",
                workspace.display()
            ));
        }
        Ok(_) => {}
    }

    if let Err(reason) = validate_preview_workspace_contents(
        workspace,
        expected_run_id,
        expected_owner_token,
        stale_before_ms,
    ) {
        return Ok(PreviewWorkspaceCleanupResult::refused(reason));
    }
    if let Err(reason) = validate_preview_workspace_contents(
        workspace,
        expected_run_id,
        expected_owner_token,
        stale_before_ms,
    ) {
        return Ok(PreviewWorkspaceCleanupResult::refused(format!(
            "Workspace changed before cleanup: {reason}"
        )));
    }

    if stale_before_ms.is_some() {
        match preview_workspace_has_active_lease(workspace, expected_owner_token) {
            Ok(true) => {
                return Ok(PreviewWorkspaceCleanupResult::refused(
                    "Preview workspace still has an active owner lease",
                ));
            }
            Ok(false) => {}
            Err(reason) => return Ok(PreviewWorkspaceCleanupResult::refused(reason)),
        }
    }

    let released_local_lease = if stale_before_ms.is_none() {
        if !release_preview_workspace_lease(expected_owner_token)? {
            return Ok(PreviewWorkspaceCleanupResult::refused(
                "Normal cleanup requires an owner lease held by this app instance",
            ));
        }
        true
    } else {
        false
    };

    let trash_name = format!(".trash-{}", uuid::Uuid::new_v4());
    let trash = root.join(&trash_name);
    if let Err(error) =
        write_preview_quarantine_receipt(&root, &trash_name, expected_run_id, expected_owner_token)
    {
        let reacquire_detail = if released_local_lease {
            reacquire_preview_workspace_lease(workspace, expected_owner_token)
                .err()
                .map(|error| format!("; failed to restore owner lease: {error}"))
                .unwrap_or_default()
        } else {
            String::new()
        };
        return Err(format!(
            "Failed to persist preview quarantine ownership: {error}{reacquire_detail}"
        ));
    }
    if let Err(error) = rename_preview_workspace_to_quarantine(
        &root,
        workspace,
        &trash,
        &trash_name,
        expected_run_id,
        expected_owner_token,
        stale_before_ms,
    ) {
        let receipt_detail = remove_preview_quarantine_receipt(&trash)
            .err()
            .map(|error| format!("; {error}"))
            .unwrap_or_default();
        let reacquire_detail = if released_local_lease {
            reacquire_preview_workspace_lease(workspace, expected_owner_token)
                .err()
                .map(|error| format!("; failed to restore owner lease: {error}"))
                .unwrap_or_default()
        } else {
            String::new()
        };
        return Err(format!(
            "Failed to atomically quarantine preview workspace {} -> {}: {error}{receipt_detail}{reacquire_detail}",
            workspace.display(),
            trash.display()
        ));
    }

    if let Err(reason) = validate_real_directory(&trash, "renamed preview workspace") {
        return Ok(restore_renamed_workspace(
            &trash,
            workspace,
            expected_owner_token,
            released_local_lease,
            reason,
        ));
    }
    if let Err(reason) = validate_preview_workspace_contents(
        &trash,
        expected_run_id,
        expected_owner_token,
        stale_before_ms,
    ) {
        return Ok(restore_renamed_workspace(
            &trash,
            workspace,
            expected_owner_token,
            released_local_lease,
            reason,
        ));
    }
    let canonical_trash = match std::fs::canonicalize(&trash) {
        Ok(path) => path,
        Err(error) => {
            return Ok(restore_renamed_workspace(
                &trash,
                workspace,
                expected_owner_token,
                released_local_lease,
                format!(
                    "Failed to canonicalize quarantined preview workspace {}: {error}",
                    trash.display()
                ),
            ));
        }
    };
    if let Err(error) = remove_preview_tree_no_follow(&trash, &trash, &canonical_trash) {
        let reason = format!(
            "Quarantined preview workspace cleanup failed at {}: {error}",
            trash.display()
        );
        return Ok(PreviewWorkspaceCleanupResult::refused_quarantined(
            format!("{reason}; partial cleanup remains receipted for bounded stale recovery"),
            &trash,
        ));
    }
    if let Err(error) = remove_preview_quarantine_receipt(&trash) {
        log::warn!("[Preview] removed workspace but retained orphan quarantine receipt: {error}");
    }
    Ok(PreviewWorkspaceCleanupResult::removed())
}

pub(crate) fn validate_owned_preview_workspace_for_staging(
    app_cache_dir: &Path,
    workspace: &Path,
    expected_run_id: &str,
    expected_owner_token: &str,
) -> Result<(), String> {
    if !is_preview_workspace_run_id(expected_run_id) {
        return Err("Invalid preview staging run id".to_string());
    }
    if !is_uuid_v4_text(expected_owner_token) {
        return Err("Invalid preview staging owner token".to_string());
    }
    let root = preview_cache_root(app_cache_dir);
    validate_real_directory(&root, "preview cache root")?;
    let expected_workspace = root.join(expected_run_id);
    if workspace != expected_workspace || workspace.parent() != Some(root.as_path()) {
        return Err("Preview staging workspace is not the expected direct child".to_string());
    }
    validate_preview_workspace_contents(workspace, expected_run_id, expected_owner_token, None)?;
    if !preview_workspace_has_local_lease(expected_owner_token)? {
        return Err("Preview staging owner lease is not held by this app instance".to_string());
    }
    Ok(())
}

fn cleanup_preview_quarantine_at_root(
    root: &Path,
    trash_name: &str,
    receipt: &PreviewQuarantineReceipt,
) -> PreviewWorkspaceCleanupResult {
    if !is_preview_quarantine_name(trash_name)
        || receipt.trash_name != trash_name
        || !is_preview_workspace_run_id(&receipt.run_id)
        || !is_uuid_v4_text(&receipt.owner_token)
    {
        return PreviewWorkspaceCleanupResult::refused(
            "Quarantine receipt does not match the managed trash entry",
        );
    }
    let trash = root.join(trash_name);
    if let Err(reason) = validate_real_directory(&trash, "preview quarantine") {
        return PreviewWorkspaceCleanupResult::refused(reason);
    }
    match preview_workspace_has_local_lease(&receipt.owner_token) {
        Ok(true) => {
            return PreviewWorkspaceCleanupResult::refused(
                "Preview quarantine still has an active local owner lease",
            );
        }
        Ok(false) => {}
        Err(reason) => return PreviewWorkspaceCleanupResult::refused(reason),
    }
    let canonical_trash = match std::fs::canonicalize(&trash) {
        Ok(path) => path,
        Err(error) => {
            return PreviewWorkspaceCleanupResult::refused_quarantined(
                format!("Failed to canonicalize managed preview quarantine: {error}"),
                &trash,
            );
        }
    };
    if let Err(error) = remove_preview_tree_no_follow(&trash, &trash, &canonical_trash) {
        return PreviewWorkspaceCleanupResult::refused_quarantined(error, &trash);
    }
    if let Err(error) = remove_preview_quarantine_receipt(&trash) {
        log::warn!("[Preview] removed stale quarantine but retained its receipt: {error}");
    }
    PreviewWorkspaceCleanupResult::removed()
}

fn validate_preview_stale_cutoff(stale_before_ms: i64) -> Result<(), String> {
    let latest_allowed_cutoff = current_unix_time_millis()?
        .checked_sub(MIN_PREVIEW_STALE_AGE_MILLIS)
        .ok_or_else(|| "Stale cutoff underflow".to_string())?;
    if stale_before_ms > latest_allowed_cutoff {
        return Err("Stale cleanup cutoff must be at least 24 hours old".to_string());
    }
    Ok(())
}

fn cleanup_stale_preview_workspaces_at_cache(
    app_cache_dir: &Path,
    stale_before_ms: i64,
    limit: u32,
) -> Result<PreviewStaleWorkspacesCleanupResult, String> {
    if limit == 0 {
        return Err("Preview stale cleanup limit must be at least 1".to_string());
    }
    validate_preview_stale_cutoff(stale_before_ms)?;
    let removal_limit = limit.min(MAX_PREVIEW_STALE_SWEEP_LIMIT);
    let root = preview_cache_root(app_cache_dir);
    match std::fs::symlink_metadata(&root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PreviewStaleWorkspacesCleanupResult {
                removed: 0,
                refused: 0,
                not_found: 0,
                has_more: false,
                results: Vec::new(),
            });
        }
        Err(error) => {
            return Err(format!(
                "Failed to inspect preview cache root {}: {error}",
                root.display()
            ));
        }
        Ok(_) => {
            validate_real_directory(&root, "preview cache root")?;
        }
    }

    let mut output = PreviewStaleWorkspacesCleanupResult {
        removed: 0,
        refused: 0,
        not_found: 0,
        has_more: false,
        results: Vec::new(),
    };
    let sweep_started_at = Instant::now();
    let entries = std::fs::read_dir(&root).map_err(|error| {
        format!(
            "Failed to enumerate preview cache root {}: {error}",
            root.display()
        )
    })?;
    let mut run_ids = Vec::new();
    let mut quarantine_names = Vec::new();
    let mut orphan_receipt_trash_names = Vec::new();
    for (scanned, entry) in entries.enumerate() {
        if sweep_started_at.elapsed() >= MAX_PREVIEW_STALE_SWEEP_DURATION {
            output.has_more = true;
            return Ok(output);
        }
        if scanned >= MAX_PREVIEW_STALE_SCAN_ENTRIES {
            output.has_more = true;
            break;
        }
        let entry =
            entry.map_err(|error| format!("Failed to enumerate preview workspace: {error}"))?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if is_preview_workspace_run_id(&name) {
            run_ids.push(name);
        } else if is_preview_quarantine_name(&name) {
            quarantine_names.push(name);
        } else if let Some(trash_name) = preview_quarantine_name_from_receipt_name(&name) {
            orphan_receipt_trash_names.push(trash_name);
        }
    }
    run_ids.sort_unstable();
    quarantine_names.sort_unstable();
    orphan_receipt_trash_names.sort_unstable();
    orphan_receipt_trash_names.dedup();
    let paired_quarantine_names = quarantine_names.iter().cloned().collect::<HashSet<_>>();
    orphan_receipt_trash_names.retain(|trash_name| !paired_quarantine_names.contains(trash_name));

    for trash_name in quarantine_names {
        if sweep_started_at.elapsed() >= MAX_PREVIEW_STALE_SWEEP_DURATION {
            output.has_more = true;
            return Ok(output);
        }
        let (receipt, metadata) = match read_preview_quarantine_receipt(&root, &trash_name) {
            Ok(value) => value,
            Err(reason) => {
                output.refused += 1;
                if output.results.len() < MAX_PREVIEW_STALE_RESULT_ITEMS {
                    output.results.push(PreviewStaleWorkspaceCleanupItem {
                        run_id: trash_name,
                        status: "refused".to_string(),
                        reason: Some(reason),
                        quarantined_workspace: None,
                    });
                }
                continue;
            }
        };
        if modified_unix_time_millis(&metadata)? > stale_before_ms {
            continue;
        }
        if output.removed >= removal_limit {
            output.has_more = true;
            break;
        }
        let run_id = receipt.run_id.clone();
        let cleanup = cleanup_preview_quarantine_at_root(&root, &trash_name, &receipt);
        match cleanup.status.as_str() {
            "removed" => output.removed += 1,
            "not-found" => output.not_found += 1,
            _ => output.refused += 1,
        }
        if output.results.len() < MAX_PREVIEW_STALE_RESULT_ITEMS {
            output.results.push(PreviewStaleWorkspaceCleanupItem {
                run_id,
                status: cleanup.status,
                reason: cleanup.reason,
                quarantined_workspace: cleanup.quarantined_workspace,
            });
        }
    }

    for trash_name in orphan_receipt_trash_names {
        if sweep_started_at.elapsed() >= MAX_PREVIEW_STALE_SWEEP_DURATION {
            output.has_more = true;
            return Ok(output);
        }
        if output.removed >= removal_limit {
            output.has_more = true;
            break;
        }
        match cleanup_orphan_preview_quarantine_receipt_at_root(&root, &trash_name, stale_before_ms)
        {
            Ok(true) => {
                output.removed += 1;
                if output.results.len() < MAX_PREVIEW_STALE_RESULT_ITEMS {
                    output.results.push(PreviewStaleWorkspaceCleanupItem {
                        run_id: trash_name,
                        status: "removed".to_string(),
                        reason: Some("Removed stale orphan preview quarantine receipt".to_string()),
                        quarantined_workspace: None,
                    });
                }
            }
            Ok(false) => {}
            Err(reason) => {
                output.refused += 1;
                if output.results.len() < MAX_PREVIEW_STALE_RESULT_ITEMS {
                    output.results.push(PreviewStaleWorkspaceCleanupItem {
                        run_id: trash_name,
                        status: "refused".to_string(),
                        reason: Some(reason),
                        quarantined_workspace: None,
                    });
                }
            }
        }
    }

    for run_id in run_ids {
        if sweep_started_at.elapsed() >= MAX_PREVIEW_STALE_SWEEP_DURATION {
            output.has_more = true;
            return Ok(output);
        }
        let workspace = root.join(&run_id);

        let candidate = (|| {
            validate_real_directory(&workspace, "stale preview workspace")?;
            let (marker, metadata) = read_preview_owner_marker(&workspace)?;
            if marker.id != run_id {
                return Err("Preview owner marker id does not match its workspace".to_string());
            }
            if !is_uuid_v4_text(&marker.owner_token) {
                return Err("Preview owner marker contains an invalid owner token".to_string());
            }
            if modified_unix_time_millis(&metadata)? > stale_before_ms {
                return Ok(None);
            }
            Ok(Some(marker.owner_token))
        })();

        let owner_token = match candidate {
            Ok(Some(owner_token)) => owner_token,
            Ok(None) => continue,
            Err(reason) => {
                output.refused += 1;
                if output.results.len() < MAX_PREVIEW_STALE_RESULT_ITEMS {
                    output.results.push(PreviewStaleWorkspaceCleanupItem {
                        run_id,
                        status: "refused".to_string(),
                        reason: Some(reason),
                        quarantined_workspace: None,
                    });
                }
                continue;
            }
        };

        // Refused candidates do not consume the removal budget, preventing a stable prefix of
        // leased/malformed workspaces from starving later abandoned workspaces.
        if output.removed >= removal_limit {
            output.has_more = true;
            break;
        }
        let cleanup = cleanup_preview_workspace_at_cache(
            app_cache_dir,
            &workspace,
            &run_id,
            &owner_token,
            Some(stale_before_ms),
        );
        let (status, reason, quarantined_workspace) = match cleanup {
            Ok(result) => (result.status, result.reason, result.quarantined_workspace),
            Err(error) => ("refused".to_string(), Some(error), None),
        };
        match status.as_str() {
            "removed" => output.removed += 1,
            "not-found" => output.not_found += 1,
            _ => output.refused += 1,
        }
        if output.results.len() < MAX_PREVIEW_STALE_RESULT_ITEMS {
            output.results.push(PreviewStaleWorkspaceCleanupItem {
                run_id,
                status,
                reason,
                quarantined_workspace,
            });
        }
    }
    Ok(output)
}

/// Create a fresh, app-cache-owned Project Preview workspace and owner marker.
#[tauri::command]
pub async fn preview_create_workspace(
    app_handle: tauri::AppHandle,
    run_id: String,
) -> CommandResult<PreviewWorkspaceCreateResult> {
    let app_cache_dir = app_handle.path().app_cache_dir().map_err(|error| {
        AppError::Generic(format!("Failed to resolve app cache directory: {error}"))
    })?;
    tokio::task::spawn_blocking(move || create_preview_workspace_at_cache(&app_cache_dir, &run_id))
        .await
        .map_err(|error| {
            AppError::Generic(format!("Preview workspace creation task failed: {error}"))
        })?
        .map_err(AppError::Generic)
}

/// Acquire an OS-backed, cross-process lease before inspecting or mutating a shared template.
#[tauri::command]
pub async fn preview_acquire_template_lock(
    app_handle: tauri::AppHandle,
    template_id: String,
) -> CommandResult<String> {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|error| {
        AppError::Generic(format!("Failed to resolve app data directory: {error}"))
    })?;
    tokio::task::spawn_blocking(move || {
        acquire_preview_template_lock_at_app_data(
            &app_data_dir,
            &template_id,
            PREVIEW_TEMPLATE_LOCK_ATTEMPTS,
            Duration::from_millis(PREVIEW_TEMPLATE_LOCK_RETRY_MILLIS),
        )
    })
    .await
    .map_err(|error| AppError::Generic(format!("Preview template lock task failed: {error}")))?
    .map_err(AppError::Generic)
}

/// Release a previously acquired shared-template lease.
#[tauri::command]
pub async fn preview_release_template_lock(lease_token: String) -> CommandResult<()> {
    release_preview_template_lock(&lease_token).map_err(AppError::Generic)
}

/// Safely remove one exact app-owned Project Preview workspace without following links.
#[tauri::command]
pub async fn preview_cleanup_workspace(
    app_handle: tauri::AppHandle,
    workspace: String,
    expected_run_id: String,
    expected_owner_token: String,
    stale_before_ms: Option<i64>,
) -> CommandResult<PreviewWorkspaceCleanupResult> {
    let app_cache_dir = app_handle.path().app_cache_dir().map_err(|error| {
        AppError::Generic(format!("Failed to resolve app cache directory: {error}"))
    })?;
    tokio::task::spawn_blocking(move || {
        cleanup_preview_workspace_at_cache(
            &app_cache_dir,
            Path::new(&workspace),
            &expected_run_id,
            &expected_owner_token,
            stale_before_ms,
        )
    })
    .await
    .map_err(|error| AppError::Generic(format!("Preview workspace cleanup task failed: {error}")))?
    .map_err(AppError::Generic)
}

/// Remove stale Preview workspaces entirely within the native trust boundary.
#[tauri::command]
pub async fn preview_cleanup_stale_workspaces(
    app_handle: tauri::AppHandle,
    stale_before_ms: i64,
    limit: u32,
) -> CommandResult<PreviewStaleWorkspacesCleanupResult> {
    let app_cache_dir = app_handle.path().app_cache_dir().map_err(|error| {
        AppError::Generic(format!("Failed to resolve app cache directory: {error}"))
    })?;
    tokio::task::spawn_blocking(move || {
        cleanup_stale_preview_workspaces_at_cache(&app_cache_dir, stale_before_ms, limit)
    })
    .await
    .map_err(|error| AppError::Generic(format!("Preview stale cleanup task failed: {error}")))?
    .map_err(AppError::Generic)
}

#[tauri::command]
pub async fn shell_cancel(execution_id: String) -> CommandResult<String> {
    let was_active = foreground_cancellations()
        .lock()
        .await
        .request_cancel(&execution_id, Instant::now());
    if was_active {
        Ok(format!(
            "Shell execution {} cancellation requested",
            execution_id
        ))
    } else {
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

/// 查询之前通过 shell_execute(background=true) 启动的后台进程状态和有界输出。
#[tauri::command]
pub async fn shell_background_status(
    bg_registry: State<'_, BackgroundProcessRegistry>,
    pid: u32,
) -> CommandResult<BackgroundProcessStatus> {
    bg_registry.status(pid).await.map_err(AppError::Generic)
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

/// 清理过期的 Trash Bin 条目
///
/// 提供给应用维护流程显式调用，删除超过 30 天的回收站文件。
/// 当前仅注册为 Tauri command，尚未接入自动启动调度。
/// 使用 async 避免大量过期文件删除时阻塞启动。
#[tauri::command]
pub async fn startup_trash_cleanup(app_handle: tauri::AppHandle) -> CommandResult<u32> {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|error| {
        AppError::FileSystem(format!("Failed to resolve app data directory: {}", error))
    })?;

    // 在阻塞线程中执行文件系统操作，避免占用 tokio 异步运行时
    tokio::task::spawn_blocking(move || trash_bin::cleanup_expired_items(&app_data_dir))
        .await
        .map_err(|e| AppError::Generic(format!("Trash Bin cleanup task failed: {}", e)))?
}
