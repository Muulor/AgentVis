//! AgentVis 显式网络 Broker 请求 helper。
//!
//! 该二进制运行在沙箱进程内，通过主进程创建的 per-run 文件型 IPC 会话发起 HTTP(S)
//! broker 请求。它不直接联网，只读 stdin JSON 并将 broker 响应写回 stdout JSON。

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

const POLL_INTERVAL_MS: u64 = 25;
const DEFAULT_WAIT_TIMEOUT_MS: u64 = 35_000;
const MAX_WAIT_TIMEOUT_MS: u64 = 125_000;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrokerHeader {
    name: String,
    value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrokerRequest {
    method: String,
    url: String,
    headers: Option<Vec<BrokerHeader>>,
    body_base64: Option<String>,
    save_path: Option<String>,
    timeout_ms: Option<u64>,
    credential_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionRequest {
    token: String,
    method: String,
    url: String,
    headers: Option<Vec<BrokerHeader>>,
    body_base64: Option<String>,
    save_path: Option<String>,
    timeout_ms: Option<u64>,
    credential_ref: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrokerResponse {
    ok: bool,
    status: Option<u16>,
    headers: Vec<BrokerHeader>,
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

fn main() {
    if std::env::args().any(|arg| arg == "-h" || arg == "--help") {
        println!("{}", usage());
        return;
    }

    match run() {
        Ok(response) => {
            emit_response(&response);
            if !response.ok {
                std::process::exit(1);
            }
        }
        Err(error) => {
            emit_response(&error_response(error));
            std::process::exit(2);
        }
    }
}

fn run() -> Result<BrokerResponse, String> {
    let session_dir = std::env::var("AGENTVIS_BROKER_PIPE")
        .map(PathBuf::from)
        .map_err(|_| "AGENTVIS_BROKER_PIPE is not configured".to_string())?;
    let token = std::env::var("AGENTVIS_BROKER_TOKEN")
        .map_err(|_| "AGENTVIS_BROKER_TOKEN is not configured".to_string())?;

    let mut stdin = String::new();
    io::stdin()
        .read_to_string(&mut stdin)
        .map_err(|error| format!("failed to read stdin: {error}"))?;
    if stdin.trim().is_empty() {
        return Err(format!("missing broker request JSON\n{}", usage()));
    }

    let request: BrokerRequest =
        serde_json::from_str(&stdin).map_err(|error| format!("invalid request JSON: {error}"))?;
    let wait_timeout_ms = request
        .timeout_ms
        .and_then(|value| value.checked_add(5_000))
        .unwrap_or(DEFAULT_WAIT_TIMEOUT_MS)
        .min(MAX_WAIT_TIMEOUT_MS);

    let request_id = Uuid::new_v4().to_string();
    let request_path = session_dir.join(format!("{request_id}.request.json"));
    let temp_request_path = session_dir.join(format!("{request_id}.request.json.tmp"));
    let response_path = session_dir.join(format!("{request_id}.response.json"));
    let session_request = SessionRequest {
        token,
        method: request.method,
        url: request.url,
        headers: request.headers,
        body_base64: request.body_base64,
        save_path: request.save_path,
        timeout_ms: request.timeout_ms,
        credential_ref: request.credential_ref,
    };
    let payload = serde_json::to_vec(&session_request)
        .map_err(|error| format!("failed to encode broker request: {error}"))?;

    fs::write(&temp_request_path, payload)
        .map_err(|error| format!("failed to write broker request: {error}"))?;
    fs::rename(&temp_request_path, &request_path)
        .map_err(|error| format!("failed to publish broker request: {error}"))?;

    let response = wait_for_response(&response_path, Duration::from_millis(wait_timeout_ms))?;
    cleanup_file(&request_path);
    cleanup_file(&response_path);
    Ok(response)
}

fn wait_for_response(path: &Path, timeout: Duration) -> Result<BrokerResponse, String> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if path.exists() {
            let content = fs::read_to_string(path)
                .map_err(|error| format!("failed to read broker response: {error}"))?;
            return serde_json::from_str(&content)
                .map_err(|error| format!("invalid broker response JSON: {error}"));
        }
        thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
    }

    Err(format!(
        "timed out waiting for broker response after {}ms",
        timeout.as_millis()
    ))
}

fn cleanup_file(path: &Path) {
    if let Err(error) = fs::remove_file(path) {
        if path.exists() {
            eprintln!("agentvis-broker-fetch cleanup warning: {error}");
        }
    }
}

fn emit_response(response: &BrokerResponse) {
    let mut stdout = io::stdout();
    let _ = serde_json::to_writer(&mut stdout, response);
    let _ = stdout.write_all(b"\n");
}

fn error_response(error: String) -> BrokerResponse {
    let (error_kind, reason_code) = classify_helper_error(&error);
    BrokerResponse {
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
        credential_ref: None,
        credential_applied: None,
        reason_code: Some(reason_code.to_string()),
        error_kind: Some(error_kind.to_string()),
        error: Some(error),
    }
}

fn classify_helper_error(error: &str) -> (&'static str, &'static str) {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("agentvis_broker_pipe is not configured")
        || normalized.contains("agentvis_broker_token is not configured")
    {
        return ("broker_helper_unavailable", "broker_helper_unavailable");
    }
    if normalized.contains("timed out waiting for broker response") {
        return ("broker_response_timeout", "broker_response_timeout");
    }
    if normalized.contains("invalid request json")
        || normalized.contains("missing broker request json")
    {
        return ("invalid_request", "broker_helper_invalid_request");
    }
    if normalized.contains("invalid broker response json") {
        return ("broker_invalid_response", "broker_helper_invalid_response");
    }
    if normalized.contains("broker request") || normalized.contains("broker response") {
        return ("broker_ipc_failed", "broker_helper_ipc_failed");
    }
    ("broker_helper_error", "broker_helper_error")
}

fn usage() -> &'static str {
    "Usage: echo '{\"method\":\"GET\",\"url\":\"https://example.com\"}' | agentvis-broker-fetch"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wait_timeout_is_capped() {
        let request = BrokerRequest {
            method: "GET".to_string(),
            url: "https://example.com".to_string(),
            headers: None,
            body_base64: None,
            save_path: None,
            timeout_ms: Some(u64::MAX),
            credential_ref: None,
        };

        let wait_timeout_ms = request
            .timeout_ms
            .and_then(|value| value.checked_add(5_000))
            .unwrap_or(DEFAULT_WAIT_TIMEOUT_MS)
            .min(MAX_WAIT_TIMEOUT_MS);

        assert_eq!(wait_timeout_ms, DEFAULT_WAIT_TIMEOUT_MS);
    }

    #[test]
    fn error_response_uses_stable_shape() {
        let response = error_response("boom".to_string());

        assert!(!response.ok);
        assert_eq!(response.error.as_deref(), Some("boom"));
        assert_eq!(response.reason_code.as_deref(), Some("broker_helper_error"));
        assert_eq!(response.error_kind.as_deref(), Some("broker_helper_error"));
        assert!(response.headers.is_empty());
    }

    #[test]
    fn error_response_classifies_helper_timeout() {
        let response =
            error_response("timed out waiting for broker response after 35000ms".to_string());

        assert_eq!(
            response.reason_code.as_deref(),
            Some("broker_response_timeout")
        );
        assert_eq!(
            response.error_kind.as_deref(),
            Some("broker_response_timeout")
        );
    }
}
