//! AgentVis WFP 网络隔离测试探针。
//!
//! 该二进制只用于本地验证 WFP helper 的网络拦截效果：等待 helper 写入
//! ready-file 后，对指定 loopback 端口执行 TCP connect 或 UDP send。

use serde::Serialize;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT_MS: u64 = 2_000;
const DEFAULT_WAIT_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_UDP_PAYLOAD: &str = "agentvis-wfp-udp-probe";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Tcp,
    Udp,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Tcp => "tcp",
            Self::Udp => "udp",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CliOptions {
    mode: Mode,
    host: String,
    port: u16,
    timeout_ms: u64,
    wait_file: Option<PathBuf>,
    wait_timeout_ms: u64,
    payload: String,
    json: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeOutput {
    ok: bool,
    mode: String,
    host: String,
    port: u16,
    network_open: bool,
    bytes_sent: Option<usize>,
    error_kind: Option<String>,
    message: Option<String>,
}

fn main() {
    let raw_args = std::env::args().skip(1).collect::<Vec<_>>();
    let wants_json = raw_args.iter().any(|arg| arg == "--json");
    let raw_arg_refs = raw_args.iter().map(String::as_str);

    let options = match parse_args(raw_arg_refs) {
        Ok(options) => options,
        Err(message) => {
            let output = ProbeOutput {
                ok: false,
                mode: "invalid".to_string(),
                host: String::new(),
                port: 0,
                network_open: false,
                bytes_sent: None,
                error_kind: Some("invalidArguments".to_string()),
                message: Some(message),
            };
            emit_output(&output, wants_json);
            std::process::exit(2);
        }
    };

    let output = run(&options);
    let exit_code = if !output.ok {
        2
    } else if output.network_open {
        0
    } else {
        42
    };
    emit_output(&output, options.json);
    std::process::exit(exit_code);
}

fn parse_args<'a, I>(args: I) -> Result<CliOptions, String>
where
    I: IntoIterator<Item = &'a str>,
{
    let mut args = args.into_iter();
    let mode = match args.next() {
        Some("tcp") => Mode::Tcp,
        Some("udp") => Mode::Udp,
        Some("-h" | "--help") => return Err(usage()),
        Some(other) => return Err(format!("unsupported mode `{other}`\n{}", usage())),
        None => return Err(usage()),
    };

    let mut host = None;
    let mut port = None;
    let mut timeout_ms = DEFAULT_TIMEOUT_MS;
    let mut wait_file = None;
    let mut wait_timeout_ms = DEFAULT_WAIT_TIMEOUT_MS;
    let mut payload = DEFAULT_UDP_PAYLOAD.to_string();
    let mut json = false;

    while let Some(arg) = args.next() {
        match arg {
            "--host" => {
                host = Some(
                    args.next()
                        .ok_or_else(|| "`--host` requires a value".to_string())?
                        .to_string(),
                );
            }
            "--port" => {
                let value = args
                    .next()
                    .ok_or_else(|| "`--port` requires a value".to_string())?;
                let parsed_port = value
                    .parse::<u16>()
                    .map_err(|_| "`--port` must be a number between 1 and 65535".to_string())?;
                if parsed_port == 0 {
                    return Err("`--port` must be a number between 1 and 65535".to_string());
                }
                port = Some(parsed_port);
            }
            "--timeout-ms" => {
                let value = args
                    .next()
                    .ok_or_else(|| "`--timeout-ms` requires a value".to_string())?;
                timeout_ms = value
                    .parse::<u64>()
                    .map_err(|_| "`--timeout-ms` must be a non-negative integer".to_string())?;
            }
            "--wait-file" => {
                let value = args
                    .next()
                    .ok_or_else(|| "`--wait-file` requires a value".to_string())?;
                wait_file = Some(PathBuf::from(value));
            }
            "--wait-timeout-ms" => {
                let value = args
                    .next()
                    .ok_or_else(|| "`--wait-timeout-ms` requires a value".to_string())?;
                wait_timeout_ms = value.parse::<u64>().map_err(|_| {
                    "`--wait-timeout-ms` must be a non-negative integer".to_string()
                })?;
            }
            "--payload" => {
                payload = args
                    .next()
                    .ok_or_else(|| "`--payload` requires a value".to_string())?
                    .to_string();
            }
            "--json" => json = true,
            other => return Err(format!("unsupported argument `{other}`\n{}", usage())),
        }
    }

    let host = host.ok_or_else(|| "`--host` is required".to_string())?;
    let port = port.ok_or_else(|| "`--port` is required".to_string())?;

    if let Some(path) = &wait_file {
        if !path.is_absolute() {
            return Err("`--wait-file` must be an absolute path".to_string());
        }
    }

    Ok(CliOptions {
        mode,
        host,
        port,
        timeout_ms,
        wait_file,
        wait_timeout_ms,
        payload,
        json,
    })
}

fn usage() -> String {
    "usage: agentvis_wfp_network_probe tcp --host <host> --port <port> [--timeout-ms <n>] [--wait-file <path>] [--wait-timeout-ms <n>] [--json]\n       agentvis_wfp_network_probe udp --host <host> --port <port> [--payload <text>] [--timeout-ms <n>] [--wait-file <path>] [--wait-timeout-ms <n>] [--json]"
        .to_string()
}

fn run(options: &CliOptions) -> ProbeOutput {
    if let Some(wait_file) = &options.wait_file {
        if let Err(error) = wait_for_file(wait_file, options.wait_timeout_ms) {
            return fatal_output(options, "readyTimeout", error);
        }
    }

    match options.mode {
        Mode::Tcp => run_tcp_probe(options),
        Mode::Udp => run_udp_probe(options),
    }
}

fn run_tcp_probe(options: &CliOptions) -> ProbeOutput {
    let address = match first_socket_addr(&options.host, options.port) {
        Ok(address) => address,
        Err(error) => return error_output(options, "resolveFailed", error),
    };

    match TcpStream::connect_timeout(&address, Duration::from_millis(options.timeout_ms)) {
        Ok(stream) => {
            drop(stream);
            success_output(options, true, None)
        }
        Err(error) => error_output(options, "connectFailed", error.to_string()),
    }
}

fn run_udp_probe(options: &CliOptions) -> ProbeOutput {
    let address = match first_socket_addr(&options.host, options.port) {
        Ok(address) => address,
        Err(error) => return error_output(options, "resolveFailed", error),
    };
    let bind_addr = if address.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    };

    let socket = match UdpSocket::bind(bind_addr) {
        Ok(socket) => socket,
        Err(error) => return error_output(options, "udpBindFailed", error.to_string()),
    };

    if let Err(error) = socket.set_write_timeout(Some(Duration::from_millis(options.timeout_ms))) {
        return error_output(options, "udpConfigureFailed", error.to_string());
    }

    match socket.send_to(options.payload.as_bytes(), address) {
        Ok(bytes_sent) => success_output(options, true, Some(bytes_sent)),
        Err(error) => error_output(options, "udpSendFailed", error.to_string()),
    }
}

fn first_socket_addr(host: &str, port: u16) -> Result<SocketAddr, String> {
    (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("failed to resolve {host}:{port}: {error}"))?
        .next()
        .ok_or_else(|| format!("no socket address resolved for {host}:{port}"))
}

fn wait_for_file(path: &Path, timeout_ms: u64) -> Result<(), String> {
    let started = Instant::now();
    let timeout = Duration::from_millis(timeout_ms);

    while started.elapsed() <= timeout {
        if path.exists() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    Err(format!(
        "ready file {} did not appear within {timeout_ms}ms",
        path.display()
    ))
}

fn success_output(
    options: &CliOptions,
    network_open: bool,
    bytes_sent: Option<usize>,
) -> ProbeOutput {
    ProbeOutput {
        ok: true,
        mode: options.mode.as_str().to_string(),
        host: options.host.clone(),
        port: options.port,
        network_open,
        bytes_sent,
        error_kind: None,
        message: None,
    }
}

fn error_output(options: &CliOptions, kind: &str, message: String) -> ProbeOutput {
    ProbeOutput {
        ok: true,
        mode: options.mode.as_str().to_string(),
        host: options.host.clone(),
        port: options.port,
        network_open: false,
        bytes_sent: None,
        error_kind: Some(kind.to_string()),
        message: Some(message),
    }
}

fn fatal_output(options: &CliOptions, kind: &str, message: String) -> ProbeOutput {
    ProbeOutput {
        ok: false,
        mode: options.mode.as_str().to_string(),
        host: options.host.clone(),
        port: options.port,
        network_open: false,
        bytes_sent: None,
        error_kind: Some(kind.to_string()),
        message: Some(message),
    }
}

fn emit_output(output: &ProbeOutput, json: bool) {
    if json {
        println!(
            "{}",
            serde_json::to_string(output).expect("probe output should be serializable")
        );
        return;
    }

    if output.network_open {
        println!(
            "network-open: mode={} target={}:{}",
            output.mode, output.host, output.port
        );
    } else {
        println!(
            "network-blocked: mode={} target={}:{} kind={}",
            output.mode,
            output.host,
            output.port,
            output.error_kind.as_deref().unwrap_or("unknown")
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{
        parse_args, Mode, DEFAULT_TIMEOUT_MS, DEFAULT_UDP_PAYLOAD, DEFAULT_WAIT_TIMEOUT_MS,
    };
    use std::path::PathBuf;

    #[test]
    fn parses_tcp_args() {
        let options = parse_args(["tcp", "--host", "127.0.0.1", "--port", "8123", "--json"])
            .expect("tcp args should parse");

        assert_eq!(options.mode, Mode::Tcp);
        assert_eq!(options.host, "127.0.0.1");
        assert_eq!(options.port, 8123);
        assert_eq!(options.timeout_ms, DEFAULT_TIMEOUT_MS);
        assert_eq!(options.wait_timeout_ms, DEFAULT_WAIT_TIMEOUT_MS);
        assert_eq!(options.payload, DEFAULT_UDP_PAYLOAD);
        assert!(options.json);
    }

    #[test]
    fn parses_udp_wait_file_args() {
        let options = parse_args([
            "udp",
            "--host",
            "127.0.0.1",
            "--port",
            "8124",
            "--wait-file",
            r"C:\AgentVis\target\wfp-ready.txt",
            "--payload",
            "hello",
        ])
        .expect("udp args should parse");

        assert_eq!(options.mode, Mode::Udp);
        assert_eq!(
            options.wait_file,
            Some(PathBuf::from(r"C:\AgentVis\target\wfp-ready.txt"))
        );
        assert_eq!(options.payload, "hello");
    }

    #[test]
    fn rejects_missing_port() {
        let error =
            parse_args(["tcp", "--host", "127.0.0.1"]).expect_err("missing port should fail");

        assert!(error.contains("port"));
    }

    #[test]
    fn rejects_zero_port() {
        let error = parse_args(["tcp", "--host", "127.0.0.1", "--port", "0"])
            .expect_err("zero port should fail");

        assert!(error.contains("65535"));
    }

    #[test]
    fn rejects_relative_wait_file() {
        let error = parse_args([
            "tcp",
            "--host",
            "127.0.0.1",
            "--port",
            "8123",
            "--wait-file",
            r"target\wfp-ready.txt",
        ])
        .expect_err("relative wait-file should fail");

        assert!(error.contains("wait-file"));
    }
}
