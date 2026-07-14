//! 主进程网络 Broker 核心。
//!
//! v1 只提供后端内部 HTTP(S) 出口，不暴露通用前端 IPC。沙箱进程后续通过
//! 显式 broker helper / IPC 调用这里，由主进程完成目标校验、代理继承和审计。

#[cfg(test)]
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
#[cfg(test)]
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, LOCATION};
use reqwest::redirect::Policy;
use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use uuid::Uuid;

use super::process_sandbox::{
    encoded_hostname_target_risk, network_broker_subject_audit_event, record_sandbox_audit_event,
    NetworkBrokerAuditDetails, NetworkBrokerAuditSubject, NetworkDirectTargetRiskInfo,
};
use crate::crypto::{Keystore, WindowsKeystore};
use crate::error::{AppError, CommandResult};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
const MAX_REDIRECTS: usize = 5;
const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES: usize = 5 * 1024 * 1024;
const MAX_PROXY_HEADER_BYTES: usize = 64 * 1024;
const MAX_NETWORK_SEND_RETRIES: usize = 1;
const NETWORK_SEND_RETRY_DELAY_MS: u64 = 350;
const FILE_SESSION_POLL_MS: u64 = 25;
const FILE_SESSION_IDLE_GRACE_MS: u64 = 2_000;
const PROXY_AUTH_USERNAME: &str = "agentvis";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrokerHttpMethod {
    Get,
    Post,
    Head,
}

#[derive(Debug, Clone)]
pub struct BrokerHttpRequest {
    pub method: BrokerHttpMethod,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub timeout_ms: Option<u64>,
    pub(crate) credential: Option<NetworkBrokerCredentialInjection>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokerHttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub truncated: bool,
    pub duration_ms: u64,
    pub final_url: String,
    pub target_host: Option<String>,
    pub target_scheme: String,
    pub bytes_out: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BrokerHttpSavedResponse {
    status: u16,
    headers: Vec<(String, String)>,
    saved_path: PathBuf,
    bytes_in: u64,
    duration_ms: u64,
    final_url: String,
    target_host: Option<String>,
    target_scheme: String,
    bytes_out: u64,
}

impl BrokerHttpMethod {
    pub fn parse(value: &str) -> Result<Self, AppError> {
        match value.trim().to_ascii_uppercase().as_str() {
            "GET" => Ok(Self::Get),
            "POST" => Ok(Self::Post),
            "HEAD" => Ok(Self::Head),
            other => Err(AppError::Forbidden(format!(
                "Network broker rejected unsupported HTTP method '{}'",
                other
            ))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Head => "HEAD",
        }
    }

    fn as_reqwest_method(self) -> Method {
        match self {
            Self::Get => Method::GET,
            Self::Post => Method::POST,
            Self::Head => Method::HEAD,
        }
    }

    fn allows_body(self) -> bool {
        self == Self::Post
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkBrokerHttpHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkBrokerHttpResponseBody {
    pub status: u16,
    pub headers: Vec<NetworkBrokerHttpHeader>,
    pub body_base64: String,
    pub truncated: bool,
    pub duration_ms: u64,
    pub final_url: String,
    pub target_host: Option<String>,
    pub target_scheme: String,
    pub bytes_out: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkBrokerCredentialPolicy {
    pub id: String,
    pub provider: String,
    pub mode: String,
    pub hosts: Vec<String>,
    pub header_name: String,
    pub header_value_prefix: String,
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NetworkBrokerCredentialInjection {
    ref_id: String,
    hosts: Vec<String>,
    header_name: String,
    header_value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NetworkBrokerFileRequest {
    token: String,
    method: String,
    url: String,
    headers: Option<Vec<NetworkBrokerHttpHeader>>,
    body_base64: Option<String>,
    save_path: Option<String>,
    timeout_ms: Option<u64>,
    credential_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkBrokerFileResponse {
    ok: bool,
    status: Option<u16>,
    headers: Vec<NetworkBrokerHttpHeader>,
    body_base64: Option<String>,
    truncated: Option<bool>,
    saved_path: Option<String>,
    bytes_in: Option<u64>,
    duration_ms: Option<u64>,
    final_url: Option<String>,
    target_host: Option<String>,
    target_scheme: Option<String>,
    bytes_out: Option<u64>,
    credential_ref: Option<String>,
    credential_applied: Option<bool>,
    reason_code: Option<String>,
    error_kind: Option<String>,
    error: Option<String>,
}

pub struct NetworkBrokerFileSession {
    pub session_dir: PathBuf,
    pub token: String,
    request_count: Arc<AtomicU64>,
    shutdown_tx: Option<oneshot::Sender<()>>,
}

pub struct NetworkBrokerProxySession {
    pub local_addr: SocketAddr,
    pub token: String,
    auth_required: bool,
    request_count: Arc<AtomicU64>,
    shutdown_tx: Option<oneshot::Sender<()>>,
}

impl NetworkBrokerFileSession {
    pub fn request_count(&self) -> u64 {
        self.request_count.load(Ordering::Relaxed)
    }
}

impl NetworkBrokerProxySession {
    pub fn request_count(&self) -> u64 {
        self.request_count.load(Ordering::Relaxed)
    }

    pub fn proxy_url(&self) -> String {
        format!("http://{}", self.local_addr)
    }

    pub fn proxy_url_with_credentials(&self) -> String {
        if !self.auth_required {
            return self.proxy_url();
        }
        format!(
            "http://{}:{}@{}",
            PROXY_AUTH_USERNAME, self.token, self.local_addr
        )
    }

    pub fn proxy_username(&self) -> &'static str {
        if self.auth_required {
            PROXY_AUTH_USERNAME
        } else {
            ""
        }
    }

    pub fn proxy_password(&self) -> &str {
        if self.auth_required {
            &self.token
        } else {
            ""
        }
    }

    pub fn proxy_auth_required(&self) -> bool {
        self.auth_required
    }
}

impl Drop for NetworkBrokerProxySession {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

impl Drop for NetworkBrokerFileSession {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Err(error) = std::fs::remove_dir_all(&self.session_dir) {
            log::debug!(
                "[NetworkBroker] failed to cleanup broker session {}: {}",
                self.session_dir.display(),
                error
            );
        }
    }
}

pub fn start_network_broker_file_session(
    app_handle: tauri::AppHandle,
    app_data_dir: &Path,
    sandbox_mode: Option<String>,
    subject: NetworkBrokerAuditSubject,
    credential_policies: Vec<NetworkBrokerCredentialPolicy>,
    writable_roots: Vec<PathBuf>,
) -> Result<NetworkBrokerFileSession, AppError> {
    validate_broker_credential_policies(&credential_policies)?;

    let session_root = app_data_dir
        .join("runtime")
        .join("network-broker")
        .join("sessions");
    std::fs::create_dir_all(&session_root).map_err(|error| {
        AppError::FileSystem(format!(
            "Failed to prepare network broker session root {}: {}",
            session_root.display(),
            error
        ))
    })?;

    let session_dir = session_root.join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(&session_dir).map_err(|error| {
        AppError::FileSystem(format!(
            "Failed to prepare network broker session {}: {}",
            session_dir.display(),
            error
        ))
    })?;

    let token = Uuid::new_v4().to_string();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let request_count = Arc::new(AtomicU64::new(0));
    log::debug!(
        "[NetworkBroker] starting file session: session_dir={}, sandbox_mode={:?}, subject={:?}",
        session_dir.display(),
        sandbox_mode,
        subject
    );
    tokio::spawn(run_file_session_loop(
        app_handle,
        session_dir.clone(),
        token.clone(),
        sandbox_mode,
        subject,
        credential_policies,
        writable_roots.clone(),
        request_count.clone(),
        shutdown_rx,
    ));

    Ok(NetworkBrokerFileSession {
        session_dir,
        token,
        request_count,
        shutdown_tx: Some(shutdown_tx),
    })
}

pub async fn start_network_broker_proxy_session(
    app_handle: tauri::AppHandle,
    sandbox_mode: Option<String>,
    subject: NetworkBrokerAuditSubject,
) -> Result<NetworkBrokerProxySession, AppError> {
    start_network_broker_proxy_session_with_auth(app_handle, sandbox_mode, subject, true).await
}

pub async fn start_network_broker_proxy_session_with_auth(
    app_handle: tauri::AppHandle,
    sandbox_mode: Option<String>,
    subject: NetworkBrokerAuditSubject,
    auth_required: bool,
) -> Result<NetworkBrokerProxySession, AppError> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|error| {
        AppError::Generic(format!(
            "Failed to start network broker proxy listener: {}",
            error
        ))
    })?;
    let local_addr = listener.local_addr().map_err(|error| {
        AppError::Generic(format!(
            "Failed to resolve network broker proxy address: {}",
            error
        ))
    })?;
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let token = Uuid::new_v4().to_string();
    let request_count = Arc::new(AtomicU64::new(0));
    tokio::spawn(run_proxy_session_loop(
        app_handle,
        listener,
        sandbox_mode.clone(),
        subject,
        token.clone(),
        auth_required,
        request_count.clone(),
        shutdown_rx,
    ));
    log::debug!(
        "[NetworkBroker] proxy session started: local_addr={}, sandbox_mode={:?}, auth_required={}",
        local_addr,
        sandbox_mode,
        auth_required
    );

    Ok(NetworkBrokerProxySession {
        local_addr,
        token,
        auth_required,
        request_count,
        shutdown_tx: Some(shutdown_tx),
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn network_broker_http_request(
    app_handle: tauri::AppHandle,
    method: String,
    url: String,
    headers: Option<Vec<NetworkBrokerHttpHeader>>,
    body_base64: Option<String>,
    timeout_ms: Option<u64>,
    sandbox_mode: Option<String>,
    subject_type: Option<String>,
    subject_id: Option<String>,
    execution_id: Option<String>,
) -> CommandResult<NetworkBrokerHttpResponseBody> {
    let method = BrokerHttpMethod::parse(&method)?;
    let body = decode_request_body(body_base64.as_deref())?;
    let request_bytes_out = body.len() as u64;
    let headers = headers
        .unwrap_or_default()
        .into_iter()
        .map(|header| (header.name, header.value))
        .collect();
    let subject = NetworkBrokerAuditSubject::from_invocation(subject_type.as_deref(), subject_id)?
        .with_execution_id(execution_id.as_deref());
    let started = Instant::now();

    let broker_response = match execute_broker_http_request(BrokerHttpRequest {
        method,
        url: url.clone(),
        headers,
        body,
        timeout_ms,
        credential: None,
    })
    .await
    {
        Ok(response) => response,
        Err(error @ AppError::Forbidden(_)) => {
            let (target_host, target_scheme) = request_target_parts(&url);
            if let Some(event) = network_broker_subject_audit_event(
                subject,
                sandbox_mode.as_deref(),
                NetworkBrokerAuditDetails {
                    method: method.as_str().to_string(),
                    url,
                    target_host,
                    target_scheme,
                    detail: broker_block_detail(&error.to_string()),
                    status_code: None,
                    bytes_in: 0,
                    bytes_out: request_bytes_out,
                    duration_ms: elapsed_ms(started),
                    blocked_reason: Some(error.to_string()),
                },
            )? {
                record_sandbox_audit_event(&app_handle, event);
            }
            return Err(error);
        }
        Err(error) => return Err(error),
    };

    if let Some(event) = network_broker_subject_audit_event(
        subject,
        sandbox_mode.as_deref(),
        NetworkBrokerAuditDetails {
            method: method.as_str().to_string(),
            url: broker_response.final_url.clone(),
            target_host: broker_response.target_host.clone(),
            target_scheme: Some(broker_response.target_scheme.clone()),
            detail: None,
            status_code: Some(broker_response.status),
            bytes_in: broker_response.body.len() as u64,
            bytes_out: broker_response.bytes_out,
            duration_ms: broker_response.duration_ms,
            blocked_reason: None,
        },
    )? {
        record_sandbox_audit_event(&app_handle, event);
    }

    Ok(NetworkBrokerHttpResponseBody {
        status: broker_response.status,
        headers: broker_response
            .headers
            .into_iter()
            .map(|(name, value)| NetworkBrokerHttpHeader { name, value })
            .collect(),
        body_base64: BASE64_STANDARD.encode(&broker_response.body),
        truncated: broker_response.truncated,
        duration_ms: broker_response.duration_ms,
        final_url: broker_response.final_url,
        target_host: broker_response.target_host,
        target_scheme: broker_response.target_scheme,
        bytes_out: broker_response.bytes_out,
    })
}

async fn run_file_session_loop(
    app_handle: tauri::AppHandle,
    session_dir: PathBuf,
    token: String,
    sandbox_mode: Option<String>,
    subject: NetworkBrokerAuditSubject,
    credential_policies: Vec<NetworkBrokerCredentialPolicy>,
    writable_roots: Vec<PathBuf>,
    request_count: Arc<AtomicU64>,
    mut shutdown_rx: oneshot::Receiver<()>,
) {
    log::debug!(
        "[NetworkBroker] file session loop started: session_dir={}, sandbox_mode={:?}, subject={:?}",
        session_dir.display(),
        sandbox_mode,
        subject
    );
    let mut interval = tokio::time::interval(Duration::from_millis(FILE_SESSION_POLL_MS));
    let mut shutdown_seen_at: Option<Instant> = None;

    loop {
        tokio::select! {
            _ = interval.tick() => {
                if let Err(error) = process_file_session_requests(
                    &app_handle,
                    &session_dir,
                    &token,
                    sandbox_mode.as_deref(),
                    subject.clone(),
                    &credential_policies,
                    &writable_roots,
                    &request_count,
                ).await {
                    log::debug!("[NetworkBroker] file session poll failed: {}", error);
                }
                if let Some(started) = shutdown_seen_at {
                    if started.elapsed() >= Duration::from_millis(FILE_SESSION_IDLE_GRACE_MS) {
                        break;
                    }
                }
            }
            _ = &mut shutdown_rx, if shutdown_seen_at.is_none() => {
                log::debug!(
                    "[NetworkBroker] file session shutdown requested: session_dir={}",
                    session_dir.display()
                );
                shutdown_seen_at = Some(Instant::now());
            }
        }
    }
    log::debug!(
        "[NetworkBroker] file session loop stopped: session_dir={}",
        session_dir.display()
    );
}

async fn process_file_session_requests(
    app_handle: &tauri::AppHandle,
    session_dir: &Path,
    token: &str,
    sandbox_mode: Option<&str>,
    subject: NetworkBrokerAuditSubject,
    credential_policies: &[NetworkBrokerCredentialPolicy],
    writable_roots: &[PathBuf],
    request_count: &Arc<AtomicU64>,
) -> Result<(), AppError> {
    let mut entries = tokio::fs::read_dir(session_dir).await.map_err(|error| {
        AppError::FileSystem(format!(
            "Failed to read network broker session {}: {}",
            session_dir.display(),
            error
        ))
    })?;

    while let Some(entry) = entries.next_entry().await.map_err(|error| {
        AppError::FileSystem(format!(
            "Failed to read network broker session entry: {}",
            error
        ))
    })? {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !file_name.ends_with(".request.json") {
            continue;
        }
        let processing_path = path.with_file_name(format!("{}.processing", file_name));
        if tokio::fs::rename(&path, &processing_path).await.is_err() {
            continue;
        }
        let response_path =
            path.with_file_name(file_name.replace(".request.json", ".response.json"));
        log::debug!(
            "[NetworkBroker] claimed file session request: request_path={}, response_path={}, subject={:?}",
            processing_path.display(),
            response_path.display(),
            subject
        );
        let response = handle_file_session_request(
            app_handle,
            &processing_path,
            token,
            sandbox_mode,
            subject.clone(),
            credential_policies,
            writable_roots,
            request_count,
        )
        .await;
        write_file_session_response(&response_path, &response).await;
        if let Err(error) = tokio::fs::remove_file(&processing_path).await {
            log::debug!(
                "[NetworkBroker] failed to remove processed request {}: {}",
                processing_path.display(),
                error
            );
        }
    }

    Ok(())
}

#[derive(Debug)]
struct FileRequestCredentialState {
    credential_ref: Option<String>,
    credential_applied: Option<bool>,
    injection: Option<NetworkBrokerCredentialInjection>,
}

fn resolve_file_request_credential(
    credential_ref: Option<&str>,
    policies: &[NetworkBrokerCredentialPolicy],
    raw_url: &str,
    request_headers: &[(String, String)],
) -> Result<FileRequestCredentialState, AppError> {
    let Some(ref_id) = credential_ref
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(FileRequestCredentialState {
            credential_ref: None,
            credential_applied: None,
            injection: None,
        });
    };
    let policy = policies
        .iter()
        .find(|policy| policy.id == ref_id)
        .ok_or_else(|| {
            AppError::Forbidden(format!(
                "Network broker rejected undeclared credentialRef '{}'",
                ref_id
            ))
        })?;
    validate_broker_credential_policy(policy)?;
    if request_headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case(&policy.header_name))
    {
        return Err(AppError::Forbidden(format!(
            "Network broker rejected credentialRef '{}' because request already set '{}'",
            ref_id, policy.header_name
        )));
    }

    let url = Url::parse(raw_url).map_err(|error| {
        AppError::Forbidden(format!(
            "Network broker rejected credentialRef '{}' for invalid URL: {}",
            ref_id, error
        ))
    })?;
    ensure_credential_url_allowed(&url, policy, ref_id)?;

    let secret = read_broker_credential_secret(&policy.provider)?;
    let Some(secret) = secret else {
        if policy.required {
            return Err(AppError::Forbidden(format!(
                "Network broker credentialRef '{}' is required but no credential is configured",
                ref_id
            )));
        }
        return Ok(FileRequestCredentialState {
            credential_ref: Some(ref_id.to_string()),
            credential_applied: Some(false),
            injection: None,
        });
    };

    Ok(FileRequestCredentialState {
        credential_ref: Some(ref_id.to_string()),
        credential_applied: Some(true),
        injection: Some(NetworkBrokerCredentialInjection {
            ref_id: ref_id.to_string(),
            hosts: policy.hosts.clone(),
            header_name: policy.header_name.clone(),
            header_value: format!("{}{}", policy.header_value_prefix, secret),
        }),
    })
}

async fn handle_file_session_request(
    app_handle: &tauri::AppHandle,
    request_path: &Path,
    token: &str,
    sandbox_mode: Option<&str>,
    subject: NetworkBrokerAuditSubject,
    credential_policies: &[NetworkBrokerCredentialPolicy],
    writable_roots: &[PathBuf],
    request_count: &Arc<AtomicU64>,
) -> NetworkBrokerFileResponse {
    let content = match tokio::fs::read_to_string(request_path).await {
        Ok(content) => content,
        Err(error) => {
            return broker_file_error(format!("Network broker failed to read request: {}", error))
        }
    };
    let request = match serde_json::from_str::<NetworkBrokerFileRequest>(&content) {
        Ok(request) => request,
        Err(error) => {
            return broker_file_error(format!(
                "Network broker rejected invalid request JSON: {}",
                error
            ))
        }
    };
    if request.token != token {
        return broker_file_error("Network broker rejected invalid broker token".to_string());
    }
    request_count.fetch_add(1, Ordering::Relaxed);

    let method = match BrokerHttpMethod::parse(&request.method) {
        Ok(method) => method,
        Err(error) => return broker_file_error(error.to_string()),
    };
    let body = match decode_request_body(request.body_base64.as_deref()) {
        Ok(body) => body,
        Err(error) => return broker_file_error(error.to_string()),
    };
    let request_bytes_out = body.len() as u64;
    let headers: Vec<(String, String)> = request
        .headers
        .unwrap_or_default()
        .into_iter()
        .map(|header| (header.name, header.value))
        .collect();
    let credential_state = match resolve_file_request_credential(
        request.credential_ref.as_deref(),
        credential_policies,
        &request.url,
        &headers,
    ) {
        Ok(state) => state,
        Err(error) => {
            return broker_file_error_with_credential(
                error.to_string(),
                request.credential_ref.clone(),
                Some(false),
            )
        }
    };
    let started = Instant::now();
    let (target_host, target_scheme) = request_target_parts(&request.url);

    log::debug!(
        "[NetworkBroker] handling file request: method={}, target_scheme={:?}, target_host={:?}, timeout_ms={:?}, body_bytes={}, subject={:?}",
        method.as_str(),
        target_scheme,
        target_host,
        request.timeout_ms,
        request_bytes_out,
        subject
    );

    let broker_request = BrokerHttpRequest {
        method,
        url: request.url.clone(),
        headers,
        body,
        timeout_ms: request.timeout_ms,
        credential: credential_state.injection.clone(),
    };

    if let Some(save_path_raw) = request
        .save_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let save_path = match resolve_broker_save_path(save_path_raw, writable_roots) {
            Ok(path) => path,
            Err(error) => {
                return broker_file_error_with_credential(
                    error.to_string(),
                    credential_state.credential_ref,
                    credential_state.credential_applied,
                )
            }
        };
        return match execute_broker_http_request_to_file(broker_request, &save_path).await {
            Ok(response) => {
                log::debug!(
                    "[NetworkBroker] file request saved response: method={}, target_scheme={}, target_host={:?}, status={}, duration_ms={}, bytes_in={}, saved_path={}",
                    method.as_str(),
                    response.target_scheme,
                    response.target_host,
                    response.status,
                    response.duration_ms,
                    response.bytes_in,
                    response.saved_path.display()
                );
                if let Some(event) =
                    broker_saved_success_audit_event(subject, sandbox_mode, method, &response)
                        .unwrap_or_else(|error| {
                            log::debug!(
                                "[NetworkBroker] failed to create broker save audit event: {}",
                                error
                            );
                            None
                        })
                {
                    record_sandbox_audit_event(app_handle, event);
                }
                NetworkBrokerFileResponse {
                    ok: true,
                    status: Some(response.status),
                    headers: response
                        .headers
                        .into_iter()
                        .map(|(name, value)| NetworkBrokerHttpHeader { name, value })
                        .collect(),
                    body_base64: None,
                    truncated: Some(false),
                    saved_path: Some(response.saved_path.to_string_lossy().to_string()),
                    bytes_in: Some(response.bytes_in),
                    duration_ms: Some(response.duration_ms),
                    final_url: Some(response.final_url),
                    target_host: response.target_host,
                    target_scheme: Some(response.target_scheme),
                    bytes_out: Some(response.bytes_out),
                    credential_ref: credential_state.credential_ref,
                    credential_applied: credential_state.credential_applied,
                    reason_code: None,
                    error_kind: None,
                    error: None,
                }
            }
            Err(error @ AppError::Forbidden(_)) => {
                log::debug!(
                    "[NetworkBroker] file save request blocked: method={}, target_scheme={:?}, target_host={:?}, error={}",
                    method.as_str(),
                    target_scheme,
                    target_host,
                    error
                );
                if let Some(event) = network_broker_subject_audit_event(
                    subject,
                    sandbox_mode,
                    NetworkBrokerAuditDetails {
                        method: method.as_str().to_string(),
                        url: request.url,
                        target_host,
                        target_scheme,
                        detail: broker_block_detail(&error.to_string()),
                        status_code: None,
                        bytes_in: 0,
                        bytes_out: request_bytes_out,
                        duration_ms: elapsed_ms(started),
                        blocked_reason: Some(error.to_string()),
                    },
                )
                .unwrap_or_else(|audit_error| {
                    log::debug!(
                        "[NetworkBroker] failed to create broker save block audit event: {}",
                        audit_error
                    );
                    None
                }) {
                    record_sandbox_audit_event(app_handle, event);
                }
                broker_file_error_with_credential(
                    error.to_string(),
                    credential_state.credential_ref,
                    credential_state.credential_applied,
                )
            }
            Err(error) => {
                log::debug!(
                    "[NetworkBroker] file save request failed: method={}, target_scheme={:?}, target_host={:?}, error={}",
                    method.as_str(),
                    target_scheme,
                    target_host,
                    error
                );
                broker_file_error_with_credential(
                    error.to_string(),
                    credential_state.credential_ref,
                    credential_state.credential_applied,
                )
            }
        };
    }

    match execute_broker_http_request(broker_request).await {
        Ok(response) => {
            log::debug!(
                "[NetworkBroker] file request succeeded: method={}, target_scheme={}, target_host={:?}, status={}, duration_ms={}, bytes_in={}, truncated={}",
                method.as_str(),
                response.target_scheme,
                response.target_host,
                response.status,
                response.duration_ms,
                response.body.len(),
                response.truncated
            );
            if let Some(event) =
                broker_success_audit_event(subject, sandbox_mode, method, &response).unwrap_or_else(
                    |error| {
                        log::debug!(
                            "[NetworkBroker] failed to create broker audit event: {}",
                            error
                        );
                        None
                    },
                )
            {
                record_sandbox_audit_event(app_handle, event);
            }
            NetworkBrokerFileResponse {
                ok: true,
                status: Some(response.status),
                headers: response
                    .headers
                    .into_iter()
                    .map(|(name, value)| NetworkBrokerHttpHeader { name, value })
                    .collect(),
                body_base64: Some(BASE64_STANDARD.encode(&response.body)),
                truncated: Some(response.truncated),
                saved_path: None,
                bytes_in: Some(response.body.len() as u64),
                duration_ms: Some(response.duration_ms),
                final_url: Some(response.final_url),
                target_host: response.target_host,
                target_scheme: Some(response.target_scheme),
                bytes_out: Some(response.bytes_out),
                credential_ref: credential_state.credential_ref,
                credential_applied: credential_state.credential_applied,
                reason_code: None,
                error_kind: None,
                error: None,
            }
        }
        Err(error @ AppError::Forbidden(_)) => {
            log::debug!(
                "[NetworkBroker] file request blocked: method={}, target_scheme={:?}, target_host={:?}, error={}",
                method.as_str(),
                target_scheme,
                target_host,
                error
            );
            if let Some(event) = network_broker_subject_audit_event(
                subject,
                sandbox_mode,
                NetworkBrokerAuditDetails {
                    method: method.as_str().to_string(),
                    url: request.url,
                    target_host,
                    target_scheme,
                    detail: broker_block_detail(&error.to_string()),
                    status_code: None,
                    bytes_in: 0,
                    bytes_out: request_bytes_out,
                    duration_ms: elapsed_ms(started),
                    blocked_reason: Some(error.to_string()),
                },
            )
            .unwrap_or_else(|audit_error| {
                log::debug!(
                    "[NetworkBroker] failed to create broker block audit event: {}",
                    audit_error
                );
                None
            }) {
                record_sandbox_audit_event(app_handle, event);
            }
            broker_file_error_with_credential(
                error.to_string(),
                credential_state.credential_ref,
                credential_state.credential_applied,
            )
        }
        Err(error) => {
            log::debug!(
                "[NetworkBroker] file request failed: method={}, target_scheme={:?}, target_host={:?}, error={}",
                method.as_str(),
                target_scheme,
                target_host,
                error
            );
            broker_file_error_with_credential(
                error.to_string(),
                credential_state.credential_ref,
                credential_state.credential_applied,
            )
        }
    }
}

async fn write_file_session_response(response_path: &Path, response: &NetworkBrokerFileResponse) {
    let temp_path = response_path.with_extension("response.json.tmp");
    let payload = match serde_json::to_vec(response) {
        Ok(payload) => payload,
        Err(error) => {
            log::debug!(
                "[NetworkBroker] failed to serialize broker response: {}",
                error
            );
            return;
        }
    };
    if let Err(error) = tokio::fs::write(&temp_path, payload).await {
        log::debug!(
            "[NetworkBroker] failed to write broker response {}: {}",
            temp_path.display(),
            error
        );
        return;
    }
    if let Err(error) = tokio::fs::rename(&temp_path, response_path).await {
        log::debug!(
            "[NetworkBroker] failed to publish broker response {}: {}",
            response_path.display(),
            error
        );
        return;
    }
    log::debug!(
        "[NetworkBroker] published file session response: response_path={}, ok={}, status={:?}, error_present={}",
        response_path.display(),
        response.ok,
        response.status,
        response.error.is_some()
    );
}

async fn run_proxy_session_loop(
    app_handle: tauri::AppHandle,
    listener: TcpListener,
    sandbox_mode: Option<String>,
    subject: NetworkBrokerAuditSubject,
    token: String,
    auth_required: bool,
    request_count: Arc<AtomicU64>,
    mut shutdown_rx: oneshot::Receiver<()>,
) {
    loop {
        tokio::select! {
            accept_result = listener.accept() => {
                match accept_result {
                    Ok((stream, peer_addr)) => {
                        log::debug!(
                            "[NetworkBroker] proxy accepted connection: peer_addr={}, subject={:?}",
                            peer_addr,
                            subject
                        );
                        tokio::spawn(handle_proxy_connection(
                            app_handle.clone(),
                            stream,
                            sandbox_mode.clone(),
                            subject.clone(),
                            token.clone(),
                            auth_required,
                            request_count.clone(),
                        ));
                    }
                    Err(error) => {
                        log::debug!("[NetworkBroker] proxy accept failed: {}", error);
                        break;
                    }
                }
            }
            _ = &mut shutdown_rx => {
                log::debug!("[NetworkBroker] proxy session shutdown requested");
                break;
            }
        }
    }
}

#[derive(Debug)]
enum ProxyRequest {
    Http {
        method: BrokerHttpMethod,
        url: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    },
    Connect {
        host: String,
        port: u16,
        url: String,
    },
}

async fn handle_proxy_connection(
    app_handle: tauri::AppHandle,
    mut client: TcpStream,
    sandbox_mode: Option<String>,
    subject: NetworkBrokerAuditSubject,
    token: String,
    auth_required: bool,
    request_count: Arc<AtomicU64>,
) {
    let request = match read_proxy_request(&mut client, &token, auth_required).await {
        Ok(request) => request,
        Err(error) => {
            if is_proxy_auth_error(&error) {
                let _ = write_proxy_auth_required(&mut client, &error.to_string()).await;
            } else {
                let _ = write_proxy_error(&mut client, 400, &error.to_string()).await;
            }
            log::debug!(
                "[NetworkBroker] proxy rejected malformed request: {}",
                error
            );
            return;
        }
    };
    request_count.fetch_add(1, Ordering::Relaxed);

    match request {
        ProxyRequest::Http {
            method,
            url,
            headers,
            body,
        } => {
            handle_proxy_http_request(
                &app_handle,
                &mut client,
                sandbox_mode.as_deref(),
                subject,
                method,
                url,
                headers,
                body,
            )
            .await;
        }
        ProxyRequest::Connect { host, port, url } => {
            handle_proxy_connect_request(
                &app_handle,
                &mut client,
                sandbox_mode.as_deref(),
                subject,
                host,
                port,
                url,
            )
            .await;
        }
    }
}

async fn handle_proxy_http_request(
    app_handle: &tauri::AppHandle,
    client: &mut TcpStream,
    sandbox_mode: Option<&str>,
    subject: NetworkBrokerAuditSubject,
    method: BrokerHttpMethod,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
) {
    let started = Instant::now();
    let request_bytes_out = body.len() as u64;
    let (target_host, target_scheme) = request_target_parts(&url);

    match execute_broker_http_request(BrokerHttpRequest {
        method,
        url: url.clone(),
        headers,
        body,
        timeout_ms: None,
        credential: None,
    })
    .await
    {
        Ok(response) => {
            if let Some(event) =
                broker_success_audit_event(subject, sandbox_mode, method, &response).unwrap_or_else(
                    |error| {
                        log::debug!(
                            "[NetworkBroker] failed to create proxy HTTP audit event: {}",
                            error
                        );
                        None
                    },
                )
            {
                record_sandbox_audit_event(app_handle, event);
            }
            if let Err(error) = write_proxy_http_response(client, response).await {
                log::debug!("[NetworkBroker] proxy response write failed: {}", error);
            }
        }
        Err(error @ AppError::Forbidden(_)) => {
            record_proxy_block_event(
                app_handle,
                sandbox_mode,
                subject,
                method.as_str(),
                &url,
                target_host,
                target_scheme,
                request_bytes_out,
                elapsed_ms(started),
                error.to_string(),
            );
            let _ = write_proxy_error(client, 403, &error.to_string()).await;
        }
        Err(error) => {
            log::debug!("[NetworkBroker] proxy HTTP request failed: {}", error);
            let _ = write_proxy_error(client, 502, "Network broker proxy request failed").await;
        }
    }
}

async fn handle_proxy_connect_request(
    app_handle: &tauri::AppHandle,
    client: &mut TcpStream,
    sandbox_mode: Option<&str>,
    subject: NetworkBrokerAuditSubject,
    host: String,
    port: u16,
    url: String,
) {
    let started = Instant::now();
    let (target_host, target_scheme) = request_target_parts(&url);
    let validation_result = async {
        let url = parse_and_validate_url(&url).await?;
        if url.port_or_known_default() != Some(443) {
            return Err(AppError::Forbidden(
                "Network broker proxy rejected HTTPS CONNECT to non-default port".to_string(),
            ));
        }
        resolve_and_validate_url_target(&url).await
    }
    .await;

    let validated_target = match validation_result {
        Ok(target) => target,
        Err(error @ AppError::Forbidden(_)) => {
            record_proxy_block_event(
                app_handle,
                sandbox_mode,
                subject,
                "CONNECT",
                &url,
                target_host,
                target_scheme,
                0,
                elapsed_ms(started),
                error.to_string(),
            );
            let _ = write_proxy_error(client, 403, &error.to_string()).await;
            return;
        }
        Err(error) => {
            log::debug!("[NetworkBroker] proxy CONNECT validation failed: {}", error);
            let _ = write_proxy_error(client, 502, "Network broker proxy validation failed").await;
            return;
        }
    };

    let mut remote = match connect_to_validated_target(&validated_target).await {
        Ok(remote) => remote,
        Err(error) => {
            log::debug!(
                "[NetworkBroker] proxy CONNECT upstream failed: host={}, port={}, error={}",
                host,
                port,
                error
            );
            let _ = write_proxy_error(client, 502, "Network broker proxy CONNECT failed").await;
            return;
        }
    };

    if let Err(error) = client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
    {
        log::debug!("[NetworkBroker] proxy CONNECT handshake failed: {}", error);
        return;
    }

    let (bytes_out, bytes_in) = match tokio::io::copy_bidirectional(client, &mut remote).await {
        Ok((from_client, from_remote)) => (from_client, from_remote),
        Err(error) => {
            log::debug!(
                "[NetworkBroker] proxy CONNECT tunnel ended with error: {}",
                error
            );
            (0, 0)
        }
    };

    if let Some(event) = network_broker_subject_audit_event(
        subject,
        sandbox_mode,
        NetworkBrokerAuditDetails {
            method: "CONNECT".to_string(),
            url,
            target_host,
            target_scheme,
            detail: None,
            status_code: Some(200),
            bytes_in,
            bytes_out,
            duration_ms: elapsed_ms(started),
            blocked_reason: None,
        },
    )
    .unwrap_or_else(|error| {
        log::debug!(
            "[NetworkBroker] failed to create proxy CONNECT audit event: {}",
            error
        );
        None
    }) {
        record_sandbox_audit_event(app_handle, event);
    }
}

fn record_proxy_block_event(
    app_handle: &tauri::AppHandle,
    sandbox_mode: Option<&str>,
    subject: NetworkBrokerAuditSubject,
    method: &str,
    url: &str,
    target_host: Option<String>,
    target_scheme: Option<String>,
    bytes_out: u64,
    duration_ms: u64,
    blocked_reason: String,
) {
    if let Some(event) = network_broker_subject_audit_event(
        subject,
        sandbox_mode,
        NetworkBrokerAuditDetails {
            method: method.to_string(),
            url: url.to_string(),
            target_host,
            target_scheme,
            detail: broker_block_detail(&blocked_reason),
            status_code: None,
            bytes_in: 0,
            bytes_out,
            duration_ms,
            blocked_reason: Some(blocked_reason),
        },
    )
    .unwrap_or_else(|error| {
        log::debug!(
            "[NetworkBroker] failed to create proxy block audit event: {}",
            error
        );
        None
    }) {
        record_sandbox_audit_event(app_handle, event);
    }
}

async fn read_proxy_request(
    client: &mut TcpStream,
    expected_token: &str,
    auth_required: bool,
) -> Result<ProxyRequest, AppError> {
    let mut buffer = Vec::new();
    let (header_end, header_delimiter_len) = loop {
        if buffer.len() > MAX_PROXY_HEADER_BYTES {
            return Err(AppError::Forbidden(
                "Network broker proxy rejected oversized request headers".to_string(),
            ));
        }
        if let Some(index) = find_header_end(&buffer) {
            break index;
        }
        let mut chunk = [0u8; 1024];
        let read = client.read(&mut chunk).await.map_err(|error| {
            AppError::Generic(format!("Network broker proxy read failed: {}", error))
        })?;
        if read == 0 {
            return Err(AppError::Forbidden(
                "Network broker proxy rejected empty request".to_string(),
            ));
        }
        buffer.extend_from_slice(&chunk[..read]);
    };

    let header_bytes = &buffer[..header_end];
    let header_text = std::str::from_utf8(header_bytes).map_err(|error| {
        AppError::Forbidden(format!(
            "Network broker proxy rejected non-UTF8 request headers: {}",
            error
        ))
    })?;
    let (request_line, headers) = parse_proxy_headers(header_text)?;
    if auth_required {
        validate_proxy_authorization(&headers, expected_token)?;
    }
    let mut parts = request_line.split_whitespace();
    let raw_method = parts.next().ok_or_else(|| {
        AppError::Forbidden("Network broker proxy rejected missing method".to_string())
    })?;
    let target = parts.next().ok_or_else(|| {
        AppError::Forbidden("Network broker proxy rejected missing target".to_string())
    })?;
    let version = parts.next().ok_or_else(|| {
        AppError::Forbidden("Network broker proxy rejected missing HTTP version".to_string())
    })?;
    if !version.starts_with("HTTP/") {
        return Err(AppError::Forbidden(
            "Network broker proxy rejected invalid HTTP version".to_string(),
        ));
    }

    if raw_method.eq_ignore_ascii_case("CONNECT") {
        let (host, port) = parse_connect_authority(target)?;
        let url = connect_audit_url(&host, port);
        return Ok(ProxyRequest::Connect { host, port, url });
    }

    let method = BrokerHttpMethod::parse(raw_method)?;
    let url = target.to_string();
    let parsed_url = parse_and_validate_url(&url).await?;
    if parsed_url.scheme() != "http" || parsed_url.port_or_known_default() != Some(80) {
        return Err(AppError::Forbidden(
            "Network broker proxy rejected non-default HTTP proxy target".to_string(),
        ));
    }

    let content_length = proxy_content_length(&headers)?;
    let body_start = header_end + header_delimiter_len;
    let mut body = buffer[body_start..].to_vec();
    if content_length > MAX_REQUEST_BODY_BYTES {
        return Err(AppError::Forbidden(format!(
            "Network broker proxy rejected request body larger than {} bytes",
            MAX_REQUEST_BODY_BYTES
        )));
    }
    while body.len() < content_length {
        let remaining = content_length - body.len();
        let mut chunk = vec![0u8; remaining.min(8192)];
        let read = client.read(&mut chunk).await.map_err(|error| {
            AppError::Generic(format!("Network broker proxy body read failed: {}", error))
        })?;
        if read == 0 {
            return Err(AppError::Forbidden(
                "Network broker proxy rejected truncated request body".to_string(),
            ));
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);

    Ok(ProxyRequest::Http {
        method,
        url,
        headers: filter_proxy_forward_headers(headers),
        body,
    })
}

fn find_header_end(buffer: &[u8]) -> Option<(usize, usize)> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| (index, 4))
        .or_else(|| {
            buffer
                .windows(2)
                .position(|window| window == b"\n\n")
                .map(|index| (index, 2))
        })
}

fn parse_proxy_headers(header_text: &str) -> Result<(String, Vec<(String, String)>), AppError> {
    let mut lines = header_text.lines();
    let request_line = lines
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .ok_or_else(|| {
            AppError::Forbidden("Network broker proxy rejected missing request line".to_string())
        })?
        .to_string();
    let mut headers = Vec::new();
    for line in lines {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(AppError::Forbidden(
                "Network broker proxy rejected invalid header line".to_string(),
            ));
        };
        headers.push((name.trim().to_string(), value.trim().to_string()));
    }
    Ok((request_line, headers))
}

fn validate_proxy_authorization(
    headers: &[(String, String)],
    expected_token: &str,
) -> Result<(), AppError> {
    let Some((_, value)) = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("proxy-authorization"))
    else {
        return Err(proxy_auth_error());
    };
    let Some(encoded) = value.trim().strip_prefix("Basic ") else {
        return Err(proxy_auth_error());
    };
    let decoded = BASE64_STANDARD
        .decode(encoded.trim())
        .map_err(|_| proxy_auth_error())?;
    let decoded = String::from_utf8(decoded).map_err(|_| proxy_auth_error())?;
    let expected = format!("{PROXY_AUTH_USERNAME}:{expected_token}");
    if decoded != expected {
        return Err(proxy_auth_error());
    }
    Ok(())
}

fn proxy_auth_error() -> AppError {
    AppError::Forbidden(
        "Network broker proxy rejected missing or invalid proxy authentication".to_string(),
    )
}

fn is_proxy_auth_error(error: &AppError) -> bool {
    error
        .to_string()
        .contains("missing or invalid proxy authentication")
}

fn parse_connect_authority(target: &str) -> Result<(String, u16), AppError> {
    if target.contains('@') {
        return Err(AppError::Forbidden(
            "Network broker proxy rejected CONNECT credentials".to_string(),
        ));
    }
    let (host, port_text) = if let Some(rest) = target.strip_prefix('[') {
        let Some(host_end) = rest.find(']') else {
            return Err(AppError::Forbidden(
                "Network broker proxy rejected invalid CONNECT target".to_string(),
            ));
        };
        let host = &rest[..host_end];
        let port_text = rest[host_end + 1..].strip_prefix(':').ok_or_else(|| {
            AppError::Forbidden("Network broker proxy rejected CONNECT without port".to_string())
        })?;
        (host, port_text)
    } else {
        let (host, port_text) = target.rsplit_once(':').ok_or_else(|| {
            AppError::Forbidden("Network broker proxy rejected CONNECT without port".to_string())
        })?;
        if host.contains(':') {
            return Err(AppError::Forbidden(
                "Network broker proxy rejected invalid CONNECT target".to_string(),
            ));
        }
        (host, port_text)
    };
    if host.is_empty() {
        return Err(AppError::Forbidden(
            "Network broker proxy rejected CONNECT without host".to_string(),
        ));
    }
    let port = port_text.parse::<u16>().map_err(|error| {
        AppError::Forbidden(format!(
            "Network broker proxy rejected invalid CONNECT port: {}",
            error
        ))
    })?;
    Ok((host.to_string(), port))
}

fn connect_audit_url(host: &str, port: u16) -> String {
    let bracketed_host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    if port == 443 {
        format!("https://{bracketed_host}/")
    } else {
        format!("https://{bracketed_host}:{port}/")
    }
}

fn proxy_content_length(headers: &[(String, String)]) -> Result<usize, AppError> {
    if headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("transfer-encoding")
            && value.to_ascii_lowercase().contains("chunked")
    }) {
        return Err(AppError::Forbidden(
            "Network broker proxy rejected chunked request bodies".to_string(),
        ));
    }
    let Some((_, value)) = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
    else {
        return Ok(0);
    };
    value.parse::<usize>().map_err(|_| {
        AppError::Forbidden("Network broker proxy rejected invalid Content-Length".to_string())
    })
}

fn filter_proxy_forward_headers(headers: Vec<(String, String)>) -> Vec<(String, String)> {
    headers
        .into_iter()
        .filter(|(name, _)| {
            let lower_name = name.to_ascii_lowercase();
            !is_blocked_header(&lower_name) && lower_name != "proxy-authorization"
        })
        .collect()
}

async fn write_proxy_http_response(
    client: &mut TcpStream,
    response: BrokerHttpResponse,
) -> Result<(), std::io::Error> {
    let status_text = status_reason_phrase(response.status);
    let mut head = format!("HTTP/1.1 {} {}\r\n", response.status, status_text);
    for (name, value) in response.headers {
        let lower_name = name.to_ascii_lowercase();
        if is_blocked_header(&lower_name)
            || matches!(lower_name.as_str(), "content-encoding" | "content-length")
        {
            continue;
        }
        head.push_str(&format!("{}: {}\r\n", name, value));
    }
    head.push_str(&format!("Content-Length: {}\r\n", response.body.len()));
    head.push_str("Connection: close\r\n\r\n");
    client.write_all(head.as_bytes()).await?;
    client.write_all(&response.body).await?;
    client.shutdown().await
}

async fn write_proxy_error(
    client: &mut TcpStream,
    status: u16,
    message: &str,
) -> Result<(), std::io::Error> {
    let body = format!("{}\n", message);
    let response = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        status_reason_phrase(status),
        body.as_bytes().len(),
        body
    );
    client.write_all(response.as_bytes()).await?;
    client.shutdown().await
}

async fn write_proxy_auth_required(
    client: &mut TcpStream,
    message: &str,
) -> Result<(), std::io::Error> {
    let body = format!("{}\n", message);
    let response = format!(
        "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"AgentVis Network Broker\"\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    client.write_all(response.as_bytes()).await?;
    client.shutdown().await
}

fn status_reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        407 => "Proxy Authentication Required",
        408 => "Request Timeout",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "OK",
    }
}

fn broker_file_error(error: String) -> NetworkBrokerFileResponse {
    broker_file_error_with_credential(error, None, None)
}

fn broker_file_error_with_credential(
    error: String,
    credential_ref: Option<String>,
    credential_applied: Option<bool>,
) -> NetworkBrokerFileResponse {
    let (error_kind, reason_code) = classify_broker_file_error(&error);
    NetworkBrokerFileResponse {
        ok: false,
        status: None,
        headers: Vec::new(),
        body_base64: None,
        truncated: None,
        saved_path: None,
        bytes_in: None,
        duration_ms: None,
        final_url: None,
        target_host: None,
        target_scheme: None,
        bytes_out: None,
        credential_ref,
        credential_applied,
        reason_code: Some(reason_code.to_string()),
        error_kind: Some(error_kind.to_string()),
        error: Some(error),
    }
}

fn classify_broker_file_error(error: &str) -> (&'static str, &'static str) {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("dns lookup failed") {
        return ("network_dns_failed", "broker_dns_lookup_failed");
    }
    if normalized.contains("network broker request failed") {
        return ("network_send_failed", "broker_network_request_failed");
    }
    if normalized.contains("credentialref") && normalized.contains("no credential is configured") {
        return ("credential_missing", "broker_credential_missing");
    }
    if normalized.contains("credentialref") {
        return ("credential_rejected", "broker_credential_rejected");
    }
    if normalized.contains("local or metadata target")
        || normalized.contains("private, local, or metadata")
        || normalized.contains("encoded hostname target")
    {
        return ("policy_blocked", "broker_network_block");
    }
    if normalized.contains("invalid request json")
        || normalized.contains("invalid broker token")
        || normalized.contains("unsupported http method")
        || normalized.contains("request body")
    {
        return ("invalid_request", "broker_invalid_request");
    }
    ("broker_error", "broker_error")
}

fn broker_success_audit_event(
    subject: NetworkBrokerAuditSubject,
    sandbox_mode: Option<&str>,
    method: BrokerHttpMethod,
    response: &BrokerHttpResponse,
) -> Result<Option<super::process_sandbox::SandboxAuditEvent>, AppError> {
    network_broker_subject_audit_event(
        subject,
        sandbox_mode,
        NetworkBrokerAuditDetails {
            method: method.as_str().to_string(),
            url: response.final_url.clone(),
            target_host: response.target_host.clone(),
            target_scheme: Some(response.target_scheme.clone()),
            detail: None,
            status_code: Some(response.status),
            bytes_in: response.body.len() as u64,
            bytes_out: response.bytes_out,
            duration_ms: response.duration_ms,
            blocked_reason: None,
        },
    )
}

fn broker_saved_success_audit_event(
    subject: NetworkBrokerAuditSubject,
    sandbox_mode: Option<&str>,
    method: BrokerHttpMethod,
    response: &BrokerHttpSavedResponse,
) -> Result<Option<super::process_sandbox::SandboxAuditEvent>, AppError> {
    network_broker_subject_audit_event(
        subject,
        sandbox_mode,
        NetworkBrokerAuditDetails {
            method: method.as_str().to_string(),
            url: response.final_url.clone(),
            target_host: response.target_host.clone(),
            target_scheme: Some(response.target_scheme.clone()),
            detail: Some(format!("savedPath={}", response.saved_path.display())),
            status_code: Some(response.status),
            bytes_in: response.bytes_in,
            bytes_out: response.bytes_out,
            duration_ms: response.duration_ms,
            blocked_reason: None,
        },
    )
}

fn normalize_path_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(value) => normalized.push(value),
            Component::RootDir | Component::Prefix(_) => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn resolve_broker_save_path(
    raw_save_path: &str,
    writable_roots: &[PathBuf],
) -> Result<PathBuf, AppError> {
    if writable_roots.is_empty() {
        return Err(AppError::Forbidden(
            "Network broker rejected savePath because no writable workdir is available".to_string(),
        ));
    }

    let raw_path = PathBuf::from(raw_save_path);
    let base_root = normalize_path_lexically(&writable_roots[0]);
    let candidate = if raw_path.is_absolute() {
        normalize_path_lexically(&raw_path)
    } else {
        normalize_path_lexically(&base_root.join(raw_path))
    };

    if candidate.file_name().is_none() {
        return Err(AppError::Forbidden(
            "Network broker rejected savePath without a file name".to_string(),
        ));
    }

    let within_root = writable_roots.iter().any(|root| {
        let normalized_root = normalize_path_lexically(root);
        candidate.starts_with(&normalized_root)
    });
    if !within_root {
        return Err(AppError::Forbidden(
            "Network broker rejected savePath outside the command workdir".to_string(),
        ));
    }

    Ok(candidate)
}

pub async fn execute_broker_http_request(
    request: BrokerHttpRequest,
) -> Result<BrokerHttpResponse, AppError> {
    if request.body.len() > MAX_REQUEST_BODY_BYTES {
        return Err(AppError::Forbidden(format!(
            "Network broker rejected request body larger than {} bytes",
            MAX_REQUEST_BODY_BYTES
        )));
    }
    if !request.method.allows_body() && !request.body.is_empty() {
        return Err(AppError::Forbidden(
            "Network broker rejected request body for GET/HEAD".to_string(),
        ));
    }

    let timeout = Duration::from_millis(
        request
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .min(MAX_TIMEOUT_MS),
    );
    let mut method = request.method;
    let mut url = parse_and_validate_url(&request.url).await?;
    let headers = build_header_map_with_credential(&request.headers, request.credential.as_ref())?;
    let started = Instant::now();

    for redirect_count in 0..=MAX_REDIRECTS {
        if let Some(credential) = request.credential.as_ref() {
            ensure_credential_injection_url_allowed(&url, credential)?;
        }
        let response =
            send_broker_http_request_with_retry(method, &url, &headers, &request.body, timeout)
                .await?;

        let status = response.status();
        if status.is_redirection() {
            if method == BrokerHttpMethod::Post {
                return Err(AppError::Forbidden(
                    "Network broker rejected redirect for POST request".to_string(),
                ));
            }
            if redirect_count >= MAX_REDIRECTS {
                return Err(AppError::Forbidden(format!(
                    "Network broker rejected more than {} redirects",
                    MAX_REDIRECTS
                )));
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| {
                    AppError::Forbidden(
                        "Network broker rejected redirect without Location".to_string(),
                    )
                })?;
            url = url.join(location).map_err(|error| {
                AppError::Forbidden(format!(
                    "Network broker rejected invalid redirect URL: {}",
                    error
                ))
            })?;
            url = parse_and_validate_url(url.as_str()).await?;
            method = BrokerHttpMethod::Get;
            continue;
        }

        let status_code = status.as_u16();
        let final_url = url.to_string();
        let target_host = url.host_str().map(ToOwned::to_owned);
        let target_scheme = url.scheme().to_string();
        let response_headers = response_headers_to_vec(response.headers());
        let (body, truncated) = read_response_limited(response).await?;

        return Ok(BrokerHttpResponse {
            status: status_code,
            headers: response_headers,
            body,
            truncated,
            duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
            final_url,
            target_host,
            target_scheme,
            bytes_out: request.body.len() as u64,
        });
    }

    Err(AppError::Forbidden(
        "Network broker redirect handling failed".to_string(),
    ))
}

async fn execute_broker_http_request_to_file(
    request: BrokerHttpRequest,
    save_path: &Path,
) -> Result<BrokerHttpSavedResponse, AppError> {
    if request.body.len() > MAX_REQUEST_BODY_BYTES {
        return Err(AppError::Forbidden(format!(
            "Network broker rejected request body larger than {} bytes",
            MAX_REQUEST_BODY_BYTES
        )));
    }
    if !request.method.allows_body() && !request.body.is_empty() {
        return Err(AppError::Forbidden(
            "Network broker rejected request body for GET/HEAD".to_string(),
        ));
    }

    let timeout = Duration::from_millis(
        request
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .min(MAX_TIMEOUT_MS),
    );
    let mut method = request.method;
    let mut url = parse_and_validate_url(&request.url).await?;
    let headers = build_header_map_with_credential(&request.headers, request.credential.as_ref())?;
    let started = Instant::now();

    for redirect_count in 0..=MAX_REDIRECTS {
        if let Some(credential) = request.credential.as_ref() {
            ensure_credential_injection_url_allowed(&url, credential)?;
        }
        let response =
            send_broker_http_request_with_retry(method, &url, &headers, &request.body, timeout)
                .await?;

        let status = response.status();
        if status.is_redirection() {
            if method == BrokerHttpMethod::Post {
                return Err(AppError::Forbidden(
                    "Network broker rejected redirect for POST request".to_string(),
                ));
            }
            if redirect_count >= MAX_REDIRECTS {
                return Err(AppError::Forbidden(format!(
                    "Network broker rejected more than {} redirects",
                    MAX_REDIRECTS
                )));
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| {
                    AppError::Forbidden(
                        "Network broker rejected redirect without Location".to_string(),
                    )
                })?;
            url = url.join(location).map_err(|error| {
                AppError::Forbidden(format!(
                    "Network broker rejected invalid redirect URL: {}",
                    error
                ))
            })?;
            url = parse_and_validate_url(url.as_str()).await?;
            method = BrokerHttpMethod::Get;
            continue;
        }

        let status_code = status.as_u16();
        let final_url = url.to_string();
        let target_host = url.host_str().map(ToOwned::to_owned);
        let target_scheme = url.scheme().to_string();
        let response_headers = response_headers_to_vec(response.headers());
        let parent = save_path.parent().ok_or_else(|| {
            AppError::Forbidden(
                "Network broker rejected savePath without a parent directory".to_string(),
            )
        })?;
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            AppError::FileSystem(format!(
                "Network broker failed to create savePath directory {}: {}",
                parent.display(),
                error
            ))
        })?;

        let temp_path = parent.join(format!(
            ".{}.{}.download",
            save_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("broker-response"),
            Uuid::new_v4()
        ));
        let mut file = tokio::fs::File::create(&temp_path).await.map_err(|error| {
            AppError::FileSystem(format!(
                "Network broker failed to create savePath temp file {}: {}",
                temp_path.display(),
                error
            ))
        })?;
        let mut bytes_in = 0_u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| {
                AppError::LlmApi(format!(
                    "Network broker failed reading response body: {}",
                    error
                ))
            })?;
            file.write_all(&chunk).await.map_err(|error| {
                AppError::FileSystem(format!(
                    "Network broker failed writing savePath temp file {}: {}",
                    temp_path.display(),
                    error
                ))
            })?;
            bytes_in = bytes_in.saturating_add(chunk.len() as u64);
        }
        file.flush().await.map_err(|error| {
            AppError::FileSystem(format!(
                "Network broker failed flushing savePath temp file {}: {}",
                temp_path.display(),
                error
            ))
        })?;
        drop(file);
        tokio::fs::rename(&temp_path, save_path)
            .await
            .map_err(|error| {
                AppError::FileSystem(format!(
                    "Network broker failed to move savePath temp file {} to {}: {}",
                    temp_path.display(),
                    save_path.display(),
                    error
                ))
            })?;

        return Ok(BrokerHttpSavedResponse {
            status: status_code,
            headers: response_headers,
            saved_path: save_path.to_path_buf(),
            bytes_in,
            duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
            final_url,
            target_host,
            target_scheme,
            bytes_out: request.body.len() as u64,
        });
    }

    Err(AppError::Forbidden(
        "Network broker redirect handling failed".to_string(),
    ))
}

fn decode_request_body(body_base64: Option<&str>) -> Result<Vec<u8>, AppError> {
    match body_base64 {
        None | Some("") => Ok(Vec::new()),
        Some(value) => BASE64_STANDARD.decode(value).map_err(|error| {
            AppError::Forbidden(format!(
                "Network broker rejected invalid base64 request body: {}",
                error
            ))
        }),
    }
}

fn request_target_parts(raw_url: &str) -> (Option<String>, Option<String>) {
    Url::parse(raw_url)
        .map(|url| {
            (
                url.host_str().map(ToOwned::to_owned),
                Some(url.scheme().to_string()),
            )
        })
        .unwrap_or((None, None))
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

async fn parse_and_validate_url(raw_url: &str) -> Result<Url, AppError> {
    let url = Url::parse(raw_url).map_err(|error| {
        AppError::Forbidden(format!("Network broker rejected invalid URL: {}", error))
    })?;
    match url.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(AppError::Forbidden(format!(
                "Network broker rejected unsupported URL scheme '{}'",
                scheme
            )));
        }
    }
    if url.host_str().is_none() {
        return Err(AppError::Forbidden(
            "Network broker rejected URL without host".to_string(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::Forbidden(
            "Network broker rejected URL credentials".to_string(),
        ));
    }
    Ok(url)
}

#[cfg(test)]
async fn validate_url_target(url: &Url) -> Result<(), AppError> {
    resolve_and_validate_url_target(url).await.map(|_| ())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ValidatedNetworkTarget {
    host: String,
    resolved_addresses: Vec<SocketAddr>,
    uses_dns_override: bool,
}

#[cfg(test)]
#[derive(Debug, Clone)]
struct TestBrokerDnsResolution {
    validation_addresses: Vec<SocketAddr>,
    connect_addresses: Vec<SocketAddr>,
}

#[cfg(test)]
fn broker_test_dns_overrides() -> &'static Mutex<HashMap<String, VecDeque<TestBrokerDnsResolution>>>
{
    static OVERRIDES: OnceLock<Mutex<HashMap<String, VecDeque<TestBrokerDnsResolution>>>> =
        OnceLock::new();
    OVERRIDES.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(test)]
fn push_broker_test_dns_resolution(
    host: &str,
    validation_addresses: Vec<SocketAddr>,
    connect_addresses: Vec<SocketAddr>,
) {
    let key = host.trim_end_matches('.').to_ascii_lowercase();
    broker_test_dns_overrides()
        .lock()
        .expect("broker test DNS override lock")
        .entry(key)
        .or_default()
        .push_back(TestBrokerDnsResolution {
            validation_addresses,
            connect_addresses,
        });
}

#[cfg(test)]
fn take_broker_test_dns_resolution(host: &str) -> Option<TestBrokerDnsResolution> {
    let key = host.trim_end_matches('.').to_ascii_lowercase();
    let mut overrides = broker_test_dns_overrides()
        .lock()
        .expect("broker test DNS override lock");
    let queue = overrides.get_mut(&key)?;
    let resolution = queue.pop_front();
    if queue.is_empty() {
        overrides.remove(&key);
    }
    resolution
}

async fn resolve_and_validate_url_target(url: &Url) -> Result<ValidatedNetworkTarget, AppError> {
    let host = url.host_str().ok_or_else(|| {
        AppError::Forbidden("Network broker rejected URL without host".to_string())
    })?;
    let host_lower = host.trim_end_matches('.').to_ascii_lowercase();
    if is_forbidden_host_name(&host_lower) {
        return Err(AppError::Forbidden(
            "Network broker rejected local or metadata target".to_string(),
        ));
    }
    if let Some(risk) = encoded_hostname_target_risk(&host_lower) {
        if matches!(risk.risk, "private" | "metadata") {
            return Err(AppError::Forbidden(format!(
                "Network broker rejected encoded hostname target; {}",
                broker_target_risk_detail(host, &risk)
            )));
        }
    }
    let port = url.port_or_known_default().ok_or_else(|| {
        AppError::Forbidden("Network broker rejected URL without known port".to_string())
    })?;

    if let Ok(ip) = host.parse::<IpAddr>() {
        validate_ip_target(ip)?;
        return Ok(ValidatedNetworkTarget {
            host: host.to_string(),
            resolved_addresses: vec![SocketAddr::new(ip, port)],
            uses_dns_override: false,
        });
    }

    #[cfg(test)]
    if let Some(test_resolution) = take_broker_test_dns_resolution(&host_lower) {
        let validation_target = validated_target_from_resolved_addresses(
            host,
            test_resolution.validation_addresses,
            true,
        )?;
        return Ok(ValidatedNetworkTarget {
            host: validation_target.host,
            resolved_addresses: if test_resolution.connect_addresses.is_empty() {
                validation_target.resolved_addresses
            } else {
                dedupe_socket_addrs(test_resolution.connect_addresses)
            },
            uses_dns_override: validation_target.uses_dns_override,
        });
    }

    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| AppError::LlmApi(format!("Network broker DNS lookup failed: {}", error)))?
        .collect::<Vec<_>>();
    validated_target_from_resolved_addresses(host, addresses, true)
}

fn validated_target_from_resolved_addresses(
    host: &str,
    addresses: Vec<SocketAddr>,
    uses_dns_override: bool,
) -> Result<ValidatedNetworkTarget, AppError> {
    if addresses.is_empty() {
        return Err(AppError::Forbidden(
            "Network broker rejected host with no DNS records".to_string(),
        ));
    }
    for address in &addresses {
        validate_ip_target(address.ip())?;
    }

    Ok(ValidatedNetworkTarget {
        host: host.to_string(),
        resolved_addresses: dedupe_socket_addrs(addresses),
        uses_dns_override,
    })
}

fn broker_http_client_for_target(target: &ValidatedNetworkTarget) -> Result<Client, AppError> {
    let mut builder = Client::builder().redirect(Policy::none()).gzip(true);
    #[cfg(test)]
    if target.host.ends_with(".agentvis-canary.test") {
        builder = builder.no_proxy();
    }
    if target.uses_dns_override {
        builder = builder.resolve_to_addrs(&target.host, &target.resolved_addresses);
    }
    builder.build().map_err(|error| {
        AppError::Generic(format!("Failed to create pinned broker client: {error}"))
    })
}

async fn send_broker_http_request_with_retry(
    method: BrokerHttpMethod,
    url: &Url,
    headers: &HeaderMap,
    body: &[u8],
    timeout: Duration,
) -> Result<reqwest::Response, AppError> {
    for attempt in 0..=MAX_NETWORK_SEND_RETRIES {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(NETWORK_SEND_RETRY_DELAY_MS)).await;
        }

        let target = resolve_and_validate_url_target(url).await?;
        let client = broker_http_client_for_target(&target)?;

        let mut builder = client
            .request(method.as_reqwest_method(), url.clone())
            .headers(headers.clone())
            .timeout(timeout);

        if method.allows_body() {
            builder = builder.body(body.to_vec());
        }

        match builder.send().await {
            Ok(response) => return Ok(response),
            Err(error) => {
                if attempt < MAX_NETWORK_SEND_RETRIES
                    && should_retry_broker_send_error(method, &error)
                {
                    log::debug!(
                        "[NetworkBroker] retrying broker request after send failure: method={}, host={}, attempt={}, error={}",
                        method.as_str(),
                        target.host,
                        attempt + 1,
                        error
                    );
                    continue;
                }
                return Err(AppError::LlmApi(format!(
                    "Network broker request failed: {}",
                    error
                )));
            }
        }
    }

    Err(AppError::LlmApi(
        "Network broker request failed after retry".to_string(),
    ))
}

fn should_retry_broker_send_error(method: BrokerHttpMethod, error: &reqwest::Error) -> bool {
    if error.is_connect() {
        return true;
    }

    matches!(method, BrokerHttpMethod::Get | BrokerHttpMethod::Head)
        && (error.is_timeout() || error.is_request())
}

async fn connect_to_validated_target(
    target: &ValidatedNetworkTarget,
) -> Result<TcpStream, AppError> {
    let mut last_error = None;
    for address in &target.resolved_addresses {
        match TcpStream::connect(address).await {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
    }
    Err(AppError::LlmApi(format!(
        "Network broker proxy CONNECT failed for pinned target: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "no resolved addresses".to_string())
    )))
}

fn dedupe_socket_addrs(addresses: Vec<SocketAddr>) -> Vec<SocketAddr> {
    let mut deduped = Vec::new();
    for address in addresses {
        if !deduped.contains(&address) {
            deduped.push(address);
        }
    }
    deduped
}

fn is_forbidden_host_name(host_lower: &str) -> bool {
    host_lower == "localhost"
        || host_lower.ends_with(".localhost")
        || matches!(
            host_lower,
            "metadata"
                | "metadata.google.internal"
                | "metadata.azure.internal"
                | "metadata.aliyuncs.com"
        )
}

fn validate_ip_target(ip: IpAddr) -> Result<(), AppError> {
    if is_forbidden_ip(ip) {
        return Err(AppError::Forbidden(format!(
            "Network broker rejected private, local, or metadata target {}",
            ip
        )));
    }
    Ok(())
}

fn broker_target_risk_detail(host: &str, risk: &NetworkDirectTargetRiskInfo) -> String {
    let samples = if risk.resolved_ip_samples.is_empty() {
        "none".to_string()
    } else {
        risk.resolved_ip_samples.join(",")
    };
    format!(
        "targetHost={}; resolvedRisk={}; resolvedRiskReason={}; resolvedIpSamples={}",
        host, risk.risk, risk.reason, samples
    )
}

fn broker_block_detail(blocked_reason: &str) -> Option<String> {
    blocked_reason
        .find("targetHost=")
        .map(|index| blocked_reason[index..].to_string())
}

fn is_forbidden_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_forbidden_ipv4(ip),
        IpAddr::V6(ip) => is_forbidden_ipv6(ip),
    }
}

fn is_forbidden_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || is_carrier_grade_nat(ip)
}

fn is_carrier_grade_nat(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && (octets[1] & 0b1100_0000) == 64
}

fn is_forbidden_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped_ipv4) = ip.to_ipv4_mapped() {
        return is_forbidden_ipv4(mapped_ipv4);
    }

    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || is_unique_local_ipv6(ip)
        || is_unicast_link_local_ipv6(ip)
}

fn is_unique_local_ipv6(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xfe00) == 0xfc00
}

fn is_unicast_link_local_ipv6(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

fn validate_broker_credential_policies(
    policies: &[NetworkBrokerCredentialPolicy],
) -> Result<(), AppError> {
    let mut seen_ids: Vec<&str> = Vec::new();
    for policy in policies {
        validate_broker_credential_policy(policy)?;
        if seen_ids.iter().any(|id| *id == policy.id.as_str()) {
            return Err(AppError::Forbidden(format!(
                "Network broker rejected duplicate credentialRef '{}'",
                policy.id
            )));
        }
        seen_ids.push(&policy.id);
    }
    Ok(())
}

fn validate_broker_credential_policy(
    policy: &NetworkBrokerCredentialPolicy,
) -> Result<(), AppError> {
    if policy.id.trim().is_empty() || !is_safe_credential_identifier(&policy.id) {
        return Err(AppError::Forbidden(
            "Network broker rejected invalid credential policy id".to_string(),
        ));
    }
    if policy.provider.trim().is_empty() || !is_safe_credential_identifier(&policy.provider) {
        return Err(AppError::Forbidden(format!(
            "Network broker rejected credentialRef '{}' with invalid provider",
            policy.id
        )));
    }
    if policy.mode != "brokerAuth" {
        return Err(AppError::Forbidden(format!(
            "Network broker rejected credentialRef '{}' with unsupported mode",
            policy.id
        )));
    }
    if policy.hosts.is_empty()
        || policy
            .hosts
            .iter()
            .any(|host| !is_exact_credential_host(host))
    {
        return Err(AppError::Forbidden(format!(
            "Network broker rejected credentialRef '{}' with invalid hosts",
            policy.id
        )));
    }
    if !is_safe_credential_header_name(&policy.header_name) {
        return Err(AppError::Forbidden(format!(
            "Network broker rejected credentialRef '{}' with invalid header name",
            policy.id
        )));
    }
    if policy.header_value_prefix.contains('\r') || policy.header_value_prefix.contains('\n') {
        return Err(AppError::Forbidden(format!(
            "Network broker rejected credentialRef '{}' with invalid header prefix",
            policy.id
        )));
    }
    Ok(())
}

fn read_broker_credential_secret(provider: &str) -> Result<Option<String>, AppError> {
    let keystore = WindowsKeystore::new();
    Ok(keystore
        .get_api_key(provider)?
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

fn ensure_credential_url_allowed(
    url: &Url,
    policy: &NetworkBrokerCredentialPolicy,
    ref_id: &str,
) -> Result<(), AppError> {
    if url.scheme() != "https" {
        return Err(AppError::Forbidden(format!(
            "Network broker rejected credentialRef '{}' for non-HTTPS URL",
            ref_id
        )));
    }
    let Some(host) = url.host_str() else {
        return Err(AppError::Forbidden(format!(
            "Network broker rejected credentialRef '{}' for URL without host",
            ref_id
        )));
    };
    if !policy
        .hosts
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(host))
    {
        return Err(AppError::Forbidden(format!(
            "Network broker rejected credentialRef '{}' for host '{}'",
            ref_id, host
        )));
    }
    Ok(())
}

fn ensure_credential_injection_url_allowed(
    url: &Url,
    credential: &NetworkBrokerCredentialInjection,
) -> Result<(), AppError> {
    if url.scheme() != "https" {
        return Err(AppError::Forbidden(format!(
            "Network broker rejected credentialRef '{}' redirect to non-HTTPS URL",
            credential.ref_id
        )));
    }
    let Some(host) = url.host_str() else {
        return Err(AppError::Forbidden(format!(
            "Network broker rejected credentialRef '{}' redirect without host",
            credential.ref_id
        )));
    };
    if !credential
        .hosts
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(host))
    {
        return Err(AppError::Forbidden(format!(
            "Network broker rejected credentialRef '{}' redirect to host '{}'",
            credential.ref_id, host
        )));
    }
    Ok(())
}

fn is_safe_credential_identifier(value: &str) -> bool {
    value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

fn is_exact_credential_host(value: &str) -> bool {
    !value.is_empty()
        && !value.eq_ignore_ascii_case("localhost")
        && !value.starts_with('.')
        && !value.ends_with('.')
        && !value.contains("..")
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-'))
}

fn is_safe_credential_header_name(value: &str) -> bool {
    let lower_name = value.to_ascii_lowercase();
    !value.is_empty()
        && value.chars().all(|ch| {
            ch.is_ascii_alphanumeric()
                || matches!(
                    ch,
                    '!' | '#'
                        | '$'
                        | '%'
                        | '&'
                        | '\''
                        | '*'
                        | '+'
                        | '-'
                        | '.'
                        | '^'
                        | '_'
                        | '`'
                        | '|'
                        | '~'
                )
        })
        && !is_blocked_header(&lower_name)
}

fn build_header_map_with_credential(
    headers: &[(String, String)],
    credential: Option<&NetworkBrokerCredentialInjection>,
) -> Result<HeaderMap, AppError> {
    if let Some(credential) = credential {
        if headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case(&credential.header_name))
        {
            return Err(AppError::Forbidden(format!(
                "Network broker rejected credentialRef '{}' because request already set '{}'",
                credential.ref_id, credential.header_name
            )));
        }
    }

    let mut map = build_header_map(headers)?;
    if let Some(credential) = credential {
        let header_name =
            HeaderName::from_bytes(credential.header_name.as_bytes()).map_err(|error| {
                AppError::Forbidden(format!(
                    "Network broker rejected credentialRef '{}' header name: {}",
                    credential.ref_id, error
                ))
            })?;
        let header_value = HeaderValue::from_str(&credential.header_value).map_err(|error| {
            AppError::Forbidden(format!(
                "Network broker rejected credentialRef '{}' header value: {}",
                credential.ref_id, error
            ))
        })?;
        map.insert(header_name, header_value);
    }
    Ok(map)
}

fn build_header_map(headers: &[(String, String)]) -> Result<HeaderMap, AppError> {
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        let lower_name = name.to_ascii_lowercase();
        if is_blocked_header(&lower_name) {
            return Err(AppError::Forbidden(format!(
                "Network broker rejected header '{}'",
                name
            )));
        }
        let header_name = HeaderName::from_bytes(name.as_bytes()).map_err(|error| {
            AppError::Forbidden(format!(
                "Network broker rejected invalid header name: {}",
                error
            ))
        })?;
        let header_value = HeaderValue::from_str(value).map_err(|error| {
            AppError::Forbidden(format!(
                "Network broker rejected invalid header value: {}",
                error
            ))
        })?;
        map.insert(header_name, header_value);
    }
    Ok(map)
}

fn is_blocked_header(lower_name: &str) -> bool {
    matches!(
        lower_name,
        "host"
            | "connection"
            | "proxy-connection"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "content-length"
    )
}

async fn read_response_limited(response: reqwest::Response) -> Result<(Vec<u8>, bool), AppError> {
    let mut body = Vec::new();
    let mut truncated = false;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            AppError::LlmApi(format!("Network broker response read failed: {}", error))
        })?;
        let remaining = MAX_RESPONSE_BODY_BYTES.saturating_sub(body.len());
        if chunk.len() > remaining {
            body.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }
        body.extend_from_slice(&chunk);
    }

    Ok((body, truncated))
}

fn response_headers_to_vec(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_PROXY_TOKEN: &str = "test-proxy-token";

    fn proxy_auth_header(token: &str) -> String {
        format!(
            "Proxy-Authorization: Basic {}\r\n",
            BASE64_STANDARD.encode(format!("{PROXY_AUTH_USERNAME}:{token}"))
        )
    }

    fn github_credential_policy() -> NetworkBrokerCredentialPolicy {
        NetworkBrokerCredentialPolicy {
            id: "github".to_string(),
            provider: "github".to_string(),
            mode: "brokerAuth".to_string(),
            hosts: vec!["api.github.com".to_string()],
            header_name: "Authorization".to_string(),
            header_value_prefix: "Bearer ".to_string(),
            required: false,
        }
    }

    #[test]
    fn broker_credential_policy_accepts_github_shape() {
        validate_broker_credential_policy(&github_credential_policy()).unwrap();
    }

    #[test]
    fn broker_credential_policy_rejects_wildcard_hosts() {
        let mut policy = github_credential_policy();
        policy.hosts = vec!["*.github.com".to_string()];

        let error = validate_broker_credential_policy(&policy).unwrap_err();

        assert!(error.to_string().contains("invalid hosts"));
    }

    #[test]
    fn broker_credential_policy_rejects_duplicate_refs() {
        let policies = vec![github_credential_policy(), github_credential_policy()];

        let error = validate_broker_credential_policies(&policies).unwrap_err();

        assert!(error.to_string().contains("duplicate credentialRef"));
    }

    #[test]
    fn broker_credential_ref_rejects_preexisting_auth_header() {
        let policies = vec![github_credential_policy()];
        let error = resolve_file_request_credential(
            Some("github"),
            &policies,
            "https://api.github.com/repos/owner/repo",
            &[(
                "Authorization".to_string(),
                "Bearer caller-token".to_string(),
            )],
        )
        .unwrap_err();

        assert!(error.to_string().contains("already set"));
    }

    #[test]
    fn broker_credential_optional_missing_continues_anonymous() {
        let mut policy = github_credential_policy();
        policy.provider = "agentvis-test-missing-github".to_string();
        policy.required = false;
        let policies = vec![policy];

        let state = resolve_file_request_credential(
            Some("github"),
            &policies,
            "https://api.github.com/repos/owner/repo",
            &[],
        )
        .unwrap();

        assert_eq!(state.credential_ref.as_deref(), Some("github"));
        assert_eq!(state.credential_applied, Some(false));
        assert!(state.injection.is_none());
    }

    #[test]
    fn broker_credential_required_missing_fails_closed() {
        let mut policy = github_credential_policy();
        policy.provider = "agentvis-test-missing-required-github".to_string();
        policy.required = true;
        let policies = vec![policy];

        let error = resolve_file_request_credential(
            Some("github"),
            &policies,
            "https://api.github.com/repos/owner/repo",
            &[],
        )
        .unwrap_err();

        assert!(error.to_string().contains("is required"));
    }

    #[test]
    fn broker_credential_ref_rejects_unmatched_host_and_http_url() {
        let policies = vec![github_credential_policy()];

        let host_error = resolve_file_request_credential(
            Some("github"),
            &policies,
            "https://example.com/repos/owner/repo",
            &[],
        )
        .unwrap_err();
        let scheme_error = resolve_file_request_credential(
            Some("github"),
            &policies,
            "http://api.github.com/repos/owner/repo",
            &[],
        )
        .unwrap_err();

        assert!(host_error.to_string().contains("for host"));
        assert!(scheme_error.to_string().contains("non-HTTPS"));
    }

    #[test]
    fn broker_credential_header_is_injected_by_broker() {
        let headers = build_header_map_with_credential(
            &[("Accept".to_string(), "application/json".to_string())],
            Some(&NetworkBrokerCredentialInjection {
                ref_id: "github".to_string(),
                hosts: vec!["api.github.com".to_string()],
                header_name: "Authorization".to_string(),
                header_value: "Bearer secret-test-token".to_string(),
            }),
        )
        .unwrap();

        assert_eq!(
            headers
                .get("authorization")
                .and_then(|value| value.to_str().ok()),
            Some("Bearer secret-test-token")
        );
    }

    #[test]
    fn broker_credential_redirect_must_stay_on_allowed_https_host() {
        let credential = NetworkBrokerCredentialInjection {
            ref_id: "github".to_string(),
            hosts: vec!["api.github.com".to_string()],
            header_name: "Authorization".to_string(),
            header_value: "Bearer secret-test-token".to_string(),
        };

        ensure_credential_injection_url_allowed(
            &Url::parse("https://api.github.com/repos/owner/repo").unwrap(),
            &credential,
        )
        .unwrap();
        assert!(ensure_credential_injection_url_allowed(
            &Url::parse("http://api.github.com/repos/owner/repo").unwrap(),
            &credential,
        )
        .is_err());
        assert!(ensure_credential_injection_url_allowed(
            &Url::parse("https://example.com/repos/owner/repo").unwrap(),
            &credential,
        )
        .is_err());
    }

    #[derive(Clone)]
    enum BrokerCanaryResponse {
        Body(&'static str),
        UploadBody {
            expected_body: &'static [u8],
            response_body: &'static str,
        },
        Redirect {
            status: u16,
            location: String,
        },
    }

    fn http_header_end(request: &[u8]) -> Option<usize> {
        request.windows(4).position(|window| window == b"\r\n\r\n")
    }

    fn http_content_length(header: &str) -> usize {
        header
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0)
    }

    async fn read_broker_canary_request(stream: &mut TcpStream) -> Vec<u8> {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];
        loop {
            let bytes = stream.read(&mut buffer).await.unwrap();
            if bytes == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..bytes]);
            if let Some(header_end) = http_header_end(&request) {
                let header = String::from_utf8_lossy(&request[..header_end]);
                let content_length = http_content_length(&header);
                let body_start = header_end + 4;
                if request.len() >= body_start + content_length {
                    break;
                }
            }
        }
        request
    }

    async fn spawn_broker_canary_server(
        routes: Vec<(&'static str, BrokerCanaryResponse)>,
        expected_requests: usize,
    ) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let routes = Arc::new(
            routes
                .into_iter()
                .map(|(path, response)| (path.to_string(), response))
                .collect::<HashMap<_, _>>(),
        );
        let handle = tokio::spawn(async move {
            for _ in 0..expected_requests {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request_bytes = read_broker_canary_request(&mut stream).await;
                let request = String::from_utf8_lossy(&request_bytes);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");
                let body = http_header_end(&request_bytes)
                    .map(|header_end| {
                        let header = String::from_utf8_lossy(&request_bytes[..header_end]);
                        let body_start = header_end + 4;
                        let body_end = body_start
                            + http_content_length(&header)
                                .min(request_bytes.len().saturating_sub(body_start));
                        &request_bytes[body_start..body_end]
                    })
                    .unwrap_or(&[]);
                let response = routes
                    .get(path)
                    .cloned()
                    .unwrap_or(BrokerCanaryResponse::Body("missing"));
                match response {
                    BrokerCanaryResponse::Body(body) => {
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        );
                        stream.write_all(response.as_bytes()).await.unwrap();
                    }
                    BrokerCanaryResponse::UploadBody {
                        expected_body,
                        response_body,
                    } => {
                        assert_eq!(body, expected_body);
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            response_body.len(),
                            response_body
                        );
                        stream.write_all(response.as_bytes()).await.unwrap();
                    }
                    BrokerCanaryResponse::Redirect { status, location } => {
                        let reason = if status == 307 {
                            "Temporary Redirect"
                        } else {
                            "Found"
                        };
                        let response = format!(
                            "HTTP/1.1 {} {}\r\nLocation: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            status, reason, location
                        );
                        stream.write_all(response.as_bytes()).await.unwrap();
                    }
                }
            }
        });
        (addr, handle)
    }

    fn push_public_canary_resolution(host: &str, connect_addr: SocketAddr) {
        push_broker_test_dns_resolution(
            host,
            vec!["93.184.216.34:80".parse::<SocketAddr>().unwrap()],
            vec![connect_addr],
        );
    }

    async fn unused_loopback_addr() -> SocketAddr {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        addr
    }

    #[tokio::test]
    async fn broker_accepts_public_https_ip_url() {
        let url = parse_and_validate_url("https://93.184.216.34/search")
            .await
            .unwrap();
        validate_url_target(&url).await.unwrap();
    }

    #[tokio::test]
    async fn broker_rejects_unsupported_scheme() {
        let error = parse_and_validate_url("file:///C:/Windows/win.ini")
            .await
            .unwrap_err();

        assert!(error.to_string().contains("unsupported URL scheme"));
    }

    #[test]
    fn broker_file_error_classifies_network_send_failures() {
        let response = broker_file_error(
            "Network broker request failed: error sending request for url (https://apihub.agnes-ai.com/v1/videos)".to_string(),
        );

        assert_eq!(response.error_kind.as_deref(), Some("network_send_failed"));
        assert_eq!(
            response.reason_code.as_deref(),
            Some("broker_network_request_failed")
        );
    }

    #[tokio::test]
    async fn broker_rejects_localhost_name() {
        let url = parse_and_validate_url("https://localhost/search")
            .await
            .unwrap();
        let error = validate_url_target(&url).await.unwrap_err();

        assert!(error.to_string().contains("local or metadata"));
    }

    #[tokio::test]
    async fn broker_rejects_private_ip() {
        let url = parse_and_validate_url("https://192.168.1.10/search")
            .await
            .unwrap();
        let error = validate_url_target(&url).await.unwrap_err();

        assert!(error.to_string().contains("private, local"));
    }

    #[tokio::test]
    async fn broker_rejects_link_local_metadata_and_cgnat_targets() {
        for raw_url in [
            "https://169.254.169.254/latest/meta-data/",
            "https://100.64.1.10/resource",
            "https://metadata.google.internal/computeMetadata/v1/",
        ] {
            let url = parse_and_validate_url(raw_url).await.unwrap();
            let error = validate_url_target(&url).await.unwrap_err();

            assert!(
                error.to_string().contains("local")
                    || error.to_string().contains("metadata")
                    || error.to_string().contains("private")
            );
        }
    }

    #[tokio::test]
    async fn broker_rejects_redirect_locations_to_private_targets() {
        let base = parse_and_validate_url("https://93.184.216.34/start")
            .await
            .unwrap();

        for location in [
            "http://127.0.0.1/admin",
            "http://192.168.1.10/admin",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.64.1.10/resource",
            "http://[::1]/admin",
            "http://[fc00::1]/admin",
            "http://[fe80::1]/admin",
        ] {
            let redirected = base.join(location).unwrap();
            let redirected = parse_and_validate_url(redirected.as_str()).await.unwrap();
            let error = validate_url_target(&redirected).await.unwrap_err();

            assert!(
                error.to_string().contains("local")
                    || error.to_string().contains("metadata")
                    || error.to_string().contains("private")
            );
        }
    }

    #[tokio::test]
    async fn broker_canary_allows_public_redirect_chain() {
        let host = format!("public-{}.agentvis-canary.test", Uuid::new_v4());
        let (addr, handle) = spawn_broker_canary_server(
            vec![
                (
                    "/start",
                    BrokerCanaryResponse::Redirect {
                        status: 302,
                        location: "/ok".to_string(),
                    },
                ),
                ("/ok", BrokerCanaryResponse::Body("canary-ok")),
            ],
            2,
        )
        .await;
        push_public_canary_resolution(&host, addr);
        push_public_canary_resolution(&host, addr);

        let response = execute_broker_http_request(BrokerHttpRequest {
            method: BrokerHttpMethod::Get,
            url: format!("http://{host}/start"),
            headers: Vec::new(),
            body: Vec::new(),
            timeout_ms: Some(5_000),
            credential: None,
        })
        .await
        .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(String::from_utf8(response.body).unwrap(), "canary-ok");
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn broker_retries_get_connect_failure_with_fresh_resolution() {
        let host = format!("retry-get-{}.agentvis-canary.test", Uuid::new_v4());
        let closed_addr = unused_loopback_addr().await;
        let (addr, handle) = spawn_broker_canary_server(
            vec![("/ok", BrokerCanaryResponse::Body("retry-get-ok"))],
            1,
        )
        .await;
        push_public_canary_resolution(&host, closed_addr);
        push_public_canary_resolution(&host, addr);

        let response = execute_broker_http_request(BrokerHttpRequest {
            method: BrokerHttpMethod::Get,
            url: format!("http://{host}/ok"),
            headers: Vec::new(),
            body: Vec::new(),
            timeout_ms: Some(5_000),
            credential: None,
        })
        .await
        .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(String::from_utf8(response.body).unwrap(), "retry-get-ok");
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn broker_retries_post_connect_failure_with_fresh_resolution() {
        let host = format!("retry-post-{}.agentvis-canary.test", Uuid::new_v4());
        let closed_addr = unused_loopback_addr().await;
        let upload_body = br#"{"probe":"agentvis-post-retry-canary"}"#;
        let (addr, handle) = spawn_broker_canary_server(
            vec![(
                "/upload",
                BrokerCanaryResponse::UploadBody {
                    expected_body: upload_body,
                    response_body: "retry-post-ok",
                },
            )],
            1,
        )
        .await;
        push_public_canary_resolution(&host, closed_addr);
        push_public_canary_resolution(&host, addr);

        let response = execute_broker_http_request(BrokerHttpRequest {
            method: BrokerHttpMethod::Post,
            url: format!("http://{host}/upload"),
            headers: Vec::new(),
            body: upload_body.to_vec(),
            timeout_ms: Some(5_000),
            credential: None,
        })
        .await
        .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(String::from_utf8(response.body).unwrap(), "retry-post-ok");
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn broker_canary_accepts_public_upload_body_and_bytes_out() {
        let host = format!("upload-{}.agentvis-canary.test", Uuid::new_v4());
        let upload_body = br#"{"probe":"agentvis-upload-canary"}"#;
        let (addr, handle) = spawn_broker_canary_server(
            vec![(
                "/upload",
                BrokerCanaryResponse::UploadBody {
                    expected_body: upload_body,
                    response_body: "upload-canary-ok",
                },
            )],
            1,
        )
        .await;
        push_public_canary_resolution(&host, addr);

        let response = execute_broker_http_request(BrokerHttpRequest {
            method: BrokerHttpMethod::Post,
            url: format!("http://{host}/upload"),
            headers: Vec::new(),
            body: upload_body.to_vec(),
            timeout_ms: Some(5_000),
            credential: None,
        })
        .await
        .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.bytes_out, upload_body.len() as u64);
        assert_eq!(
            String::from_utf8(response.body).unwrap(),
            "upload-canary-ok"
        );
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn broker_canary_rejects_post_redirect() {
        let host = format!("post-redirect-{}.agentvis-canary.test", Uuid::new_v4());
        let upload_body = br#"{"probe":"agentvis-upload-canary"}"#;
        let (addr, handle) = spawn_broker_canary_server(
            vec![(
                "/upload",
                BrokerCanaryResponse::Redirect {
                    status: 302,
                    location: "/ok".to_string(),
                },
            )],
            1,
        )
        .await;
        push_public_canary_resolution(&host, addr);

        let error = execute_broker_http_request(BrokerHttpRequest {
            method: BrokerHttpMethod::Post,
            url: format!("http://{host}/upload"),
            headers: Vec::new(),
            body: upload_body.to_vec(),
            timeout_ms: Some(5_000),
            credential: None,
        })
        .await
        .unwrap_err();

        assert!(error.to_string().contains("redirect for POST request"));
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn broker_canary_rejects_encoded_hostname_private_and_metadata_before_dns() {
        for (raw_url, expected_risk, expected_reason, expected_sample) in [
            (
                "http://127.0.0.1.sslip.io/",
                "resolvedRisk=private",
                "resolvedRiskReason=hostnameEncodedPrivateOrLocalIp",
                "resolvedIpSamples=127.0.0.1",
            ),
            (
                "http://169-254-169-254.sslip.io/",
                "resolvedRisk=metadata",
                "resolvedRiskReason=hostnameEncodedMetadataIp",
                "resolvedIpSamples=169.254.169.254",
            ),
        ] {
            let url = Url::parse(raw_url).unwrap();
            let error = resolve_and_validate_url_target(&url).await.unwrap_err();
            let message = error.to_string();

            assert!(message.contains("encoded hostname target"));
            assert!(message.contains(expected_risk));
            assert!(message.contains(expected_reason));
            assert!(message.contains(expected_sample));
        }
    }

    #[tokio::test]
    async fn broker_canary_rejects_redirect_to_private_targets() {
        for location in [
            "http://127.0.0.1/admin",
            "http://192.168.1.10/admin",
            "http://100.64.1.10/resource",
            "http://[::1]/admin",
            "http://[fc00::1]/admin",
            "http://[fe80::1]/admin",
        ] {
            let host = format!("private-{}.agentvis-canary.test", Uuid::new_v4());
            let (addr, handle) = spawn_broker_canary_server(
                vec![(
                    "/start",
                    BrokerCanaryResponse::Redirect {
                        status: 307,
                        location: location.to_string(),
                    },
                )],
                1,
            )
            .await;
            push_public_canary_resolution(&host, addr);

            let error = execute_broker_http_request(BrokerHttpRequest {
                method: BrokerHttpMethod::Get,
                url: format!("http://{host}/start"),
                headers: Vec::new(),
                body: Vec::new(),
                timeout_ms: Some(5_000),
                credential: None,
            })
            .await
            .unwrap_err();

            assert!(error.to_string().contains("private") || error.to_string().contains("local"));
            handle.await.unwrap();
        }
    }

    #[tokio::test]
    async fn broker_canary_rejects_redirect_to_metadata_targets() {
        for location in [
            "http://169.254.169.254/latest/meta-data/",
            "http://metadata.google.internal/computeMetadata/v1/",
        ] {
            let host = format!("metadata-{}.agentvis-canary.test", Uuid::new_v4());
            let (addr, handle) = spawn_broker_canary_server(
                vec![(
                    "/start",
                    BrokerCanaryResponse::Redirect {
                        status: 307,
                        location: location.to_string(),
                    },
                )],
                1,
            )
            .await;
            push_public_canary_resolution(&host, addr);

            let error = execute_broker_http_request(BrokerHttpRequest {
                method: BrokerHttpMethod::Get,
                url: format!("http://{host}/start"),
                headers: Vec::new(),
                body: Vec::new(),
                timeout_ms: Some(5_000),
                credential: None,
            })
            .await
            .unwrap_err();

            assert!(error.to_string().contains("metadata"));
            handle.await.unwrap();
        }
    }

    #[tokio::test]
    async fn broker_canary_rejects_dns_rebinding_after_redirect() {
        let host = format!("rebind-{}.agentvis-canary.test", Uuid::new_v4());
        let (addr, handle) = spawn_broker_canary_server(
            vec![(
                "/start",
                BrokerCanaryResponse::Redirect {
                    status: 302,
                    location: format!("http://{host}/ok"),
                },
            )],
            1,
        )
        .await;
        push_public_canary_resolution(&host, addr);
        push_broker_test_dns_resolution(
            &host,
            vec!["192.168.1.10:80".parse::<SocketAddr>().unwrap()],
            vec![addr],
        );

        let error = execute_broker_http_request(BrokerHttpRequest {
            method: BrokerHttpMethod::Get,
            url: format!("http://{host}/start"),
            headers: Vec::new(),
            body: Vec::new(),
            timeout_ms: Some(5_000),
            credential: None,
        })
        .await
        .unwrap_err();

        assert!(error.to_string().contains("private"));
        handle.await.unwrap();
    }

    #[test]
    fn broker_rejects_dns_rebinding_to_private_addresses() {
        let public = validated_target_from_resolved_addresses(
            "rebind.example",
            vec!["93.184.216.34:443".parse::<SocketAddr>().unwrap()],
            true,
        )
        .unwrap();
        assert!(public.uses_dns_override);

        for address in [
            "127.0.0.1:443",
            "192.168.1.10:443",
            "169.254.169.254:443",
            "100.64.1.10:443",
            "[::1]:443",
            "[fc00::1]:443",
            "[fe80::1]:443",
        ] {
            let error = validated_target_from_resolved_addresses(
                "rebind.example",
                vec![address.parse::<SocketAddr>().unwrap()],
                true,
            )
            .unwrap_err();
            assert!(
                error.to_string().contains("private")
                    || error.to_string().contains("local")
                    || error.to_string().contains("metadata")
            );
        }
    }

    #[tokio::test]
    async fn broker_rejects_url_credentials() {
        let error = parse_and_validate_url("https://user:pass@example.com/")
            .await
            .unwrap_err();

        assert!(error.to_string().contains("URL credentials"));
    }

    #[tokio::test]
    async fn broker_rejects_ipv4_mapped_loopback_ip() {
        let url = parse_and_validate_url("https://[::ffff:127.0.0.1]/search")
            .await
            .unwrap();
        let error = validate_url_target(&url).await.unwrap_err();

        assert!(error.to_string().contains("private, local"));
    }

    #[tokio::test]
    async fn broker_rejects_request_body_for_get() {
        let error = execute_broker_http_request(BrokerHttpRequest {
            method: BrokerHttpMethod::Get,
            url: "https://93.184.216.34/search".to_string(),
            headers: Vec::new(),
            body: b"unexpected".to_vec(),
            timeout_ms: Some(1),
            credential: None,
        })
        .await
        .unwrap_err();

        assert!(error.to_string().contains("GET/HEAD"));
    }

    #[test]
    fn broker_parses_supported_http_methods() {
        assert_eq!(
            BrokerHttpMethod::parse("get").unwrap(),
            BrokerHttpMethod::Get
        );
        assert_eq!(
            BrokerHttpMethod::parse("POST").unwrap(),
            BrokerHttpMethod::Post
        );
        assert_eq!(
            BrokerHttpMethod::parse(" head ").unwrap(),
            BrokerHttpMethod::Head
        );
    }

    #[test]
    fn broker_rejects_invalid_base64_request_body() {
        let error = decode_request_body(Some("not-base64!")).unwrap_err();

        assert!(error.to_string().contains("invalid base64"));
    }

    #[test]
    fn broker_rejects_hop_by_hop_headers() {
        let error =
            build_header_map(&[("Host".to_string(), "example.com".to_string())]).unwrap_err();

        assert!(error.to_string().contains("rejected header"));
    }

    #[tokio::test]
    async fn proxy_parses_http_absolute_form_request() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let auth = proxy_auth_header(TEST_PROXY_TOKEN);
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(addr).await.unwrap();
            stream
                .write_all(format!(
                    "GET http://example.com/search?q=1 HTTP/1.1\r\nHost: example.com\r\nProxy-Connection: keep-alive\r\n{}\r\n",
                    auth
                ).as_bytes())
                .await
                .unwrap();
        });
        let (mut server, _) = listener.accept().await.unwrap();
        let request = read_proxy_request(&mut server, TEST_PROXY_TOKEN, true)
            .await
            .unwrap();
        client.await.unwrap();

        match request {
            ProxyRequest::Http {
                method,
                url,
                headers,
                body,
            } => {
                assert_eq!(method, BrokerHttpMethod::Get);
                assert_eq!(url, "http://example.com/search?q=1");
                assert!(headers
                    .iter()
                    .all(|(name, _)| !name.eq_ignore_ascii_case("Host")));
                assert!(body.is_empty());
            }
            other => panic!("expected HTTP proxy request, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn proxy_parses_https_connect_request() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let auth = proxy_auth_header(TEST_PROXY_TOKEN);
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(addr).await.unwrap();
            stream
                .write_all(
                    format!(
                        "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n{}\r\n",
                        auth
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let (mut server, _) = listener.accept().await.unwrap();
        let request = read_proxy_request(&mut server, TEST_PROXY_TOKEN, true)
            .await
            .unwrap();
        client.await.unwrap();

        match request {
            ProxyRequest::Connect { host, port, url } => {
                assert_eq!(host, "example.com");
                assert_eq!(port, 443);
                assert_eq!(url, "https://example.com/");
            }
            other => panic!("expected CONNECT proxy request, got {other:?}"),
        }
    }

    #[test]
    fn proxy_requires_explicit_connect_port() {
        let error = parse_connect_authority("example.com").unwrap_err();

        assert!(error.to_string().contains("without port"));
    }

    #[tokio::test]
    async fn proxy_rejects_unsupported_method_and_scheme() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let auth = proxy_auth_header(TEST_PROXY_TOKEN);
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(addr).await.unwrap();
            stream
                .write_all(
                    format!(
                        "PUT http://example.com/ HTTP/1.1\r\nHost: example.com\r\n{}\r\n",
                        auth
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let (mut server, _) = listener.accept().await.unwrap();
        let error = read_proxy_request(&mut server, TEST_PROXY_TOKEN, true)
            .await
            .unwrap_err();
        client.await.unwrap();
        assert!(error.to_string().contains("unsupported HTTP method"));

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let auth = proxy_auth_header(TEST_PROXY_TOKEN);
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(addr).await.unwrap();
            stream
                .write_all(
                    format!(
                        "GET ftp://example.com/ HTTP/1.1\r\nHost: example.com\r\n{}\r\n",
                        auth
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let (mut server, _) = listener.accept().await.unwrap();
        let error = read_proxy_request(&mut server, TEST_PROXY_TOKEN, true)
            .await
            .unwrap_err();
        client.await.unwrap();
        assert!(error.to_string().contains("unsupported URL scheme"));
    }

    #[tokio::test]
    async fn proxy_rejects_missing_or_invalid_proxy_auth() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(addr).await.unwrap();
            stream
                .write_all(b"GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n")
                .await
                .unwrap();
        });
        let (mut server, _) = listener.accept().await.unwrap();
        let error = read_proxy_request(&mut server, TEST_PROXY_TOKEN, true)
            .await
            .unwrap_err();
        client.await.unwrap();
        assert!(is_proxy_auth_error(&error));

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let auth = proxy_auth_header("wrong-token");
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(addr).await.unwrap();
            stream
                .write_all(
                    format!(
                        "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n{}\r\n",
                        auth
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let (mut server, _) = listener.accept().await.unwrap();
        let error = read_proxy_request(&mut server, TEST_PROXY_TOKEN, true)
            .await
            .unwrap_err();
        client.await.unwrap();
        assert!(is_proxy_auth_error(&error));
    }

    #[tokio::test]
    async fn proxy_allows_browser_session_without_auth_when_disabled() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(addr).await.unwrap();
            stream
                .write_all(b"GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n")
                .await
                .unwrap();
        });
        let (mut server, _) = listener.accept().await.unwrap();
        let request = read_proxy_request(&mut server, TEST_PROXY_TOKEN, false)
            .await
            .unwrap();
        client.await.unwrap();

        match request {
            ProxyRequest::Http { method, url, .. } => {
                assert_eq!(method, BrokerHttpMethod::Get);
                assert_eq!(url, "http://example.com/");
            }
            other => panic!("expected HTTP proxy request, got {other:?}"),
        }
    }

    #[test]
    fn proxy_rejects_chunked_request_bodies() {
        let error =
            proxy_content_length(&[("Transfer-Encoding".to_string(), "chunked".to_string())])
                .unwrap_err();

        assert!(error.to_string().contains("chunked"));
    }
}
