//! AgentVis WFP 网络隔离 Spike helper。
//!
//! 为测试 exe path 创建 WFP dynamic
//! session，并按 AppID 安装临时 block filters。它不会接入默认 shell 执行链路。

use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

const DEFAULT_PROBE_TIMEOUT_MS: u64 = 1_000;
const DEFAULT_GUARD_TIMEOUT_MS: u64 = 30_000;
const TEST_PROBE_EXE_NAME: &str = "agentvis_wfp_network_probe.exe";
const AGENTVIS_MANAGED_EGRESS_MARKER: &str = ".agentvis-egress-managed";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Probe,
    Guard,
    Inspect,
    Cleanup,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Probe => "probe",
            Self::Guard => "guard",
            Self::Inspect => "inspect",
            Self::Cleanup => "cleanup",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CliOptions {
    mode: Mode,
    exe: Option<PathBuf>,
    pid: Option<u32>,
    timeout_ms: u64,
    ready_file: Option<PathBuf>,
    allowed_loopback_port: Option<u16>,
    confirm_cleanup: bool,
    json: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HelperOutput {
    ok: bool,
    mode: String,
    backend: &'static str,
    dynamic_session: bool,
    target_exe: Option<String>,
    pid: Option<u32>,
    filters_added: usize,
    layers: Vec<&'static str>,
    probe: Option<ProbeOutput>,
    inspect: Option<InspectOutput>,
    cleanup_action: Option<CleanupActionOutput>,
    error_kind: Option<String>,
    message: Option<String>,
    cleanup: CleanupOutput,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeOutput {
    tcp_loopback_blocked: Option<bool>,
    udp_loopback_blocked: Option<bool>,
    dns_blocked: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectOutput {
    provider_detected: bool,
    sublayer_detected: bool,
    filters_detected: Vec<&'static str>,
    residual_filters_detected: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupActionOutput {
    attempted: bool,
    filters_deleted: usize,
    sublayer_deleted: bool,
    provider_deleted: bool,
    residual_filters_detected: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupOutput {
    engine_closed: bool,
    residual_filters_detected: bool,
}

#[derive(Debug)]
struct HelperError {
    kind: &'static str,
    message: String,
    engine_closed: bool,
}

fn main() {
    let raw_args = std::env::args().skip(1).collect::<Vec<_>>();
    let wants_json = raw_args.iter().any(|arg| arg == "--json");
    let raw_arg_refs = raw_args.iter().map(String::as_str);

    let options = match parse_args(raw_arg_refs) {
        Ok(options) => options,
        Err(message) => {
            let output = error_output("invalid", None, None, "invalidArguments", message, false);
            emit_output(&output, wants_json);
            std::process::exit(2);
        }
    };

    let output = run(options.clone());
    let ok = output.ok;
    emit_output(&output, options.json);

    if !ok {
        std::process::exit(1);
    }
}

fn parse_args<'a, I>(args: I) -> Result<CliOptions, String>
where
    I: IntoIterator<Item = &'a str>,
{
    let mut args = args.into_iter();
    let mode = match args.next() {
        Some("probe") => Mode::Probe,
        Some("guard") => Mode::Guard,
        Some("inspect") => Mode::Inspect,
        Some("cleanup") => Mode::Cleanup,
        Some("-h" | "--help") => return Err(usage()),
        Some(other) => return Err(format!("unsupported mode `{other}`\n{}", usage())),
        None => return Err(usage()),
    };

    let mut exe = None;
    let mut pid = None;
    let mut timeout_ms = None;
    let mut ready_file = None;
    let mut allowed_loopback_port = None;
    let mut confirm_cleanup = false;
    let mut allow_agentvis_managed_exe = false;
    let mut json = false;

    while let Some(arg) = args.next() {
        match arg {
            "--exe" => {
                let value = args
                    .next()
                    .ok_or_else(|| "`--exe` requires a value".to_string())?;
                exe = Some(PathBuf::from(value));
            }
            "--pid" => {
                let value = args
                    .next()
                    .ok_or_else(|| "`--pid` requires a value".to_string())?;
                let parsed_pid = value
                    .parse::<u32>()
                    .map_err(|_| "`--pid` must be a positive integer".to_string())?;
                if parsed_pid == 0 {
                    return Err("`--pid` must be a positive integer".to_string());
                }
                pid = Some(parsed_pid);
            }
            "--timeout-ms" => {
                let value = args
                    .next()
                    .ok_or_else(|| "`--timeout-ms` requires a value".to_string())?;
                timeout_ms =
                    Some(value.parse::<u64>().map_err(|_| {
                        "`--timeout-ms` must be a non-negative integer".to_string()
                    })?);
            }
            "--ready-file" => {
                let value = args
                    .next()
                    .ok_or_else(|| "`--ready-file` requires a value".to_string())?;
                ready_file = Some(PathBuf::from(value));
            }
            "--allow-loopback-port" => {
                let value = args
                    .next()
                    .ok_or_else(|| "`--allow-loopback-port` requires a value".to_string())?;
                let parsed_port = value
                    .parse::<u16>()
                    .map_err(|_| "`--allow-loopback-port` must be a TCP port".to_string())?;
                if parsed_port == 0 {
                    return Err("`--allow-loopback-port` must be a TCP port".to_string());
                }
                allowed_loopback_port = Some(parsed_port);
            }
            "--confirm-agentvis-wfp-cleanup" => confirm_cleanup = true,
            "--allow-agentvis-managed-exe" => allow_agentvis_managed_exe = true,
            "--json" => json = true,
            other => return Err(format!("unsupported argument `{other}`\n{}", usage())),
        }
    }

    if matches!(mode, Mode::Probe | Mode::Guard) {
        let exe_path = exe
            .as_ref()
            .ok_or_else(|| "`--exe` is required".to_string())?;
        if !exe_path.is_absolute() {
            return Err("`--exe` must be an absolute path".to_string());
        }
        validate_guard_target_exe(exe_path, allow_agentvis_managed_exe)?;
    } else if exe.is_some() {
        return Err(format!("`{}` does not accept `--exe`", mode.as_str()));
    }
    if allow_agentvis_managed_exe && !matches!(mode, Mode::Probe | Mode::Guard) {
        return Err(format!(
            "`{}` does not accept `--allow-agentvis-managed-exe`",
            mode.as_str()
        ));
    }

    if let Some(path) = &ready_file {
        if !path.is_absolute() {
            return Err("`--ready-file` must be an absolute path".to_string());
        }
    }

    match (mode, pid) {
        (Mode::Probe, Some(_)) => return Err("`probe` does not accept `--pid`".to_string()),
        (Mode::Guard, None) => return Err("`guard` requires `--pid`".to_string()),
        (Mode::Inspect | Mode::Cleanup, Some(_)) => {
            return Err(format!("`{}` does not accept `--pid`", mode.as_str()))
        }
        _ => {}
    }
    if matches!(mode, Mode::Inspect | Mode::Cleanup) && ready_file.is_some() {
        return Err(format!(
            "`{}` does not accept `--ready-file`",
            mode.as_str()
        ));
    }
    if matches!(mode, Mode::Inspect | Mode::Cleanup) && allowed_loopback_port.is_some() {
        return Err(format!(
            "`{}` does not accept `--allow-loopback-port`",
            mode.as_str()
        ));
    }
    if mode == Mode::Cleanup && !confirm_cleanup {
        return Err("`cleanup` requires `--confirm-agentvis-wfp-cleanup`".to_string());
    }
    if mode != Mode::Cleanup && confirm_cleanup {
        return Err(format!(
            "`{}` does not accept `--confirm-agentvis-wfp-cleanup`",
            mode.as_str()
        ));
    }

    let timeout_ms = timeout_ms.unwrap_or(match mode {
        Mode::Probe => DEFAULT_PROBE_TIMEOUT_MS,
        Mode::Guard => DEFAULT_GUARD_TIMEOUT_MS,
        Mode::Inspect | Mode::Cleanup => 0,
    });
    if matches!(mode, Mode::Inspect | Mode::Cleanup) && timeout_ms != 0 {
        return Err(format!(
            "`{}` does not accept `--timeout-ms`",
            mode.as_str()
        ));
    }

    Ok(CliOptions {
        mode,
        exe,
        pid,
        timeout_ms,
        ready_file,
        allowed_loopback_port,
        confirm_cleanup,
        json,
    })
}

fn validate_guard_target_exe(
    exe: &PathBuf,
    allow_agentvis_managed_exe: bool,
) -> Result<(), String> {
    if validate_test_probe_exe(exe).is_ok() {
        return Ok(());
    }
    if allow_agentvis_managed_exe {
        return validate_agentvis_managed_exe(exe);
    }

    Err(format!(
        "`--exe` must point to {TEST_PROBE_EXE_NAME}; AgentVis-managed per-run executables require `--allow-agentvis-managed-exe` and a sibling {AGENTVIS_MANAGED_EGRESS_MARKER} marker"
    ))
}

fn validate_test_probe_exe(exe: &PathBuf) -> Result<(), String> {
    let file_name = exe
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "`--exe` must point to agentvis_wfp_network_probe.exe".to_string())?;

    if !file_name.eq_ignore_ascii_case(TEST_PROBE_EXE_NAME) {
        return Err(
            "`--exe` must point to agentvis_wfp_network_probe.exe for this WFP spike".to_string(),
        );
    }

    Ok(())
}

fn validate_agentvis_managed_exe(exe: &PathBuf) -> Result<(), String> {
    let file_name = exe
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "`--exe` must point to an executable file".to_string())?;
    if file_name.trim().is_empty() {
        return Err("`--exe` must point to an executable file".to_string());
    }

    let parent = exe
        .parent()
        .ok_or_else(|| "`--exe` must have a parent directory".to_string())?;
    let marker = parent.join(AGENTVIS_MANAGED_EGRESS_MARKER);
    if !marker.is_file() {
        return Err(format!(
            "AgentVis-managed WFP guard targets require sibling marker file {}",
            AGENTVIS_MANAGED_EGRESS_MARKER
        ));
    }

    Ok(())
}

fn usage() -> String {
    "usage: agentvis_wfp_helper probe --exe <absolute-test-exe> [--allow-agentvis-managed-exe] [--allow-loopback-port <port>] [--timeout-ms <n>] [--ready-file <path>] [--json]\n       agentvis_wfp_helper guard --exe <absolute-test-exe> --pid <pid> [--allow-agentvis-managed-exe] [--allow-loopback-port <port>] [--timeout-ms <n>] [--ready-file <path>] [--json]\n       agentvis_wfp_helper inspect [--json]\n       agentvis_wfp_helper cleanup --confirm-agentvis-wfp-cleanup [--json]"
        .to_string()
}

fn run(options: CliOptions) -> HelperOutput {
    match options.mode {
        Mode::Probe | Mode::Guard => run_guarded_wfp(options),
        Mode::Inspect => run_inspect_wfp(options),
        Mode::Cleanup => run_cleanup_wfp(options),
    }
}

fn run_guarded_wfp(options: CliOptions) -> HelperOutput {
    match run_wfp_guarded(&options) {
        Ok(result) => HelperOutput {
            ok: true,
            mode: options.mode.as_str().to_string(),
            backend: "wfp",
            dynamic_session: true,
            target_exe: options.exe.as_ref().map(|exe| exe.display().to_string()),
            pid: options.pid,
            filters_added: result.filters_added,
            layers: result.layers,
            probe: (options.mode == Mode::Probe).then_some(ProbeOutput {
                tcp_loopback_blocked: None,
                udp_loopback_blocked: None,
                dns_blocked: None,
            }),
            inspect: None,
            cleanup_action: None,
            error_kind: None,
            message: None,
            cleanup: CleanupOutput {
                engine_closed: true,
                residual_filters_detected: false,
            },
        },
        Err(error) => error_output(
            options.mode.as_str(),
            options.exe.as_ref().map(|exe| exe.display().to_string()),
            options.pid,
            error.kind,
            error.message,
            error.engine_closed,
        ),
    }
}

fn run_inspect_wfp(options: CliOptions) -> HelperOutput {
    match run_wfp_inspect() {
        Ok(result) => {
            let residual = result.residual_detected();
            HelperOutput {
                ok: true,
                mode: options.mode.as_str().to_string(),
                backend: "wfp",
                dynamic_session: false,
                target_exe: None,
                pid: None,
                filters_added: 0,
                layers: Vec::new(),
                probe: None,
                inspect: Some(InspectOutput {
                    provider_detected: result.provider_detected,
                    sublayer_detected: result.sublayer_detected,
                    filters_detected: result.filters_detected,
                    residual_filters_detected: residual,
                }),
                cleanup_action: None,
                error_kind: None,
                message: None,
                cleanup: CleanupOutput {
                    engine_closed: true,
                    residual_filters_detected: residual,
                },
            }
        }
        Err(error) => error_output(
            options.mode.as_str(),
            None,
            None,
            error.kind,
            error.message,
            error.engine_closed,
        ),
    }
}

fn run_cleanup_wfp(options: CliOptions) -> HelperOutput {
    match run_wfp_cleanup(options.confirm_cleanup) {
        Ok(result) => {
            let residual = result.residual.residual_detected();
            HelperOutput {
                ok: true,
                mode: options.mode.as_str().to_string(),
                backend: "wfp",
                dynamic_session: false,
                target_exe: None,
                pid: None,
                filters_added: 0,
                layers: Vec::new(),
                probe: None,
                inspect: Some(InspectOutput {
                    provider_detected: result.residual.provider_detected,
                    sublayer_detected: result.residual.sublayer_detected,
                    filters_detected: result.residual.filters_detected,
                    residual_filters_detected: residual,
                }),
                cleanup_action: Some(CleanupActionOutput {
                    attempted: true,
                    filters_deleted: result.filters_deleted,
                    sublayer_deleted: result.sublayer_deleted,
                    provider_deleted: result.provider_deleted,
                    residual_filters_detected: residual,
                }),
                error_kind: None,
                message: None,
                cleanup: CleanupOutput {
                    engine_closed: true,
                    residual_filters_detected: residual,
                },
            }
        }
        Err(error) => error_output(
            options.mode.as_str(),
            None,
            None,
            error.kind,
            error.message,
            error.engine_closed,
        ),
    }
}

fn error_output(
    mode: &str,
    target_exe: Option<String>,
    pid: Option<u32>,
    kind: &'static str,
    message: String,
    engine_closed: bool,
) -> HelperOutput {
    HelperOutput {
        ok: false,
        mode: mode.to_string(),
        backend: "wfp",
        dynamic_session: engine_closed,
        target_exe,
        pid,
        filters_added: 0,
        layers: Vec::new(),
        probe: None,
        inspect: None,
        cleanup_action: None,
        error_kind: Some(kind.to_string()),
        message: Some(message),
        cleanup: CleanupOutput {
            engine_closed,
            residual_filters_detected: false,
        },
    }
}

fn emit_output(output: &HelperOutput, json: bool) {
    if json {
        println!(
            "{}",
            serde_json::to_string(output).expect("helper output should be serializable")
        );
        return;
    }

    if output.ok {
        println!(
            "ok: mode={} backend=wfp filtersAdded={} layers={}",
            output.mode,
            output.filters_added,
            output.layers.join(",")
        );
    } else {
        eprintln!(
            "error: kind={} message={}",
            output.error_kind.as_deref().unwrap_or("unknown"),
            output.message.as_deref().unwrap_or("unknown failure")
        );
    }
}

#[derive(Debug)]
struct WfpRunResult {
    filters_added: usize,
    layers: Vec<&'static str>,
}

#[derive(Debug)]
struct WfpInspectResult {
    provider_detected: bool,
    sublayer_detected: bool,
    filters_detected: Vec<&'static str>,
}

impl WfpInspectResult {
    fn residual_detected(&self) -> bool {
        self.provider_detected || self.sublayer_detected || !self.filters_detected.is_empty()
    }
}

#[derive(Debug)]
struct WfpCleanupResult {
    filters_deleted: usize,
    sublayer_deleted: bool,
    provider_deleted: bool,
    residual: WfpInspectResult,
}

#[cfg(windows)]
fn run_wfp_guarded(options: &CliOptions) -> Result<WfpRunResult, HelperError> {
    let exe = options
        .exe
        .as_ref()
        .expect("probe and guard modes validate exe");
    let guard =
        wfp::install_block_filters(exe, options.allowed_loopback_port).map_err(|error| {
            HelperError {
                kind: error.kind,
                message: error.message,
                engine_closed: error.engine_closed,
            }
        })?;

    let result = WfpRunResult {
        filters_added: guard.filters_added(),
        layers: guard.layers().to_vec(),
    };

    if let Some(ready_file) = &options.ready_file {
        signal_ready(ready_file)?;
    }

    match options.mode {
        Mode::Probe => std::thread::sleep(Duration::from_millis(options.timeout_ms)),
        Mode::Guard => wfp::wait_for_process_exit(
            options.pid.expect("guard mode validates pid"),
            options.timeout_ms,
        )
        .map_err(|error| HelperError {
            kind: error.kind,
            message: error.message,
            engine_closed: true,
        })?,
        Mode::Inspect | Mode::Cleanup => unreachable!("mode validated before guarded WFP run"),
    }

    drop(guard);
    Ok(result)
}

#[cfg(windows)]
fn signal_ready(path: &PathBuf) -> Result<(), HelperError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| HelperError {
            kind: "readySignalFailed",
            message: format!("failed to create ready-file directory: {error}"),
            engine_closed: true,
        })?;
    }

    fs::write(path, b"ready\n").map_err(|error| HelperError {
        kind: "readySignalFailed",
        message: format!("failed to write ready-file {}: {error}", path.display()),
        engine_closed: true,
    })
}

#[cfg(not(windows))]
fn run_wfp_guarded(_options: &CliOptions) -> Result<WfpRunResult, HelperError> {
    Err(HelperError {
        kind: "unsupportedPlatform",
        message: "WFP is only available on Windows".to_string(),
        engine_closed: false,
    })
}

#[cfg(windows)]
fn run_wfp_inspect() -> Result<WfpInspectResult, HelperError> {
    wfp::inspect_agentvis_objects().map_err(|error| HelperError {
        kind: error.kind,
        message: error.message,
        engine_closed: error.engine_closed,
    })
}

#[cfg(not(windows))]
fn run_wfp_inspect() -> Result<WfpInspectResult, HelperError> {
    Err(HelperError {
        kind: "unsupportedPlatform",
        message: "WFP is only available on Windows".to_string(),
        engine_closed: false,
    })
}

#[cfg(windows)]
fn run_wfp_cleanup(confirm: bool) -> Result<WfpCleanupResult, HelperError> {
    wfp::cleanup_agentvis_objects(confirm).map_err(|error| HelperError {
        kind: error.kind,
        message: error.message,
        engine_closed: error.engine_closed,
    })
}

#[cfg(not(windows))]
fn run_wfp_cleanup(_confirm: bool) -> Result<WfpCleanupResult, HelperError> {
    Err(HelperError {
        kind: "unsupportedPlatform",
        message: "WFP is only available on Windows".to_string(),
        engine_closed: false,
    })
}

#[cfg(windows)]
mod wfp {
    use super::{WfpCleanupResult, WfpInspectResult};
    use std::ffi::{c_void, OsStr};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::{null, null_mut};
    use windows_sys::core::GUID;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_ACCESS_DENIED, FWP_E_ALREADY_EXISTS,
        FWP_E_FILTER_NOT_FOUND, FWP_E_PROVIDER_NOT_FOUND, FWP_E_SUBLAYER_NOT_FOUND, HANDLE,
        WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::{
        FwpmEngineClose0, FwpmEngineOpen0, FwpmFilterAdd0, FwpmFilterDeleteById0,
        FwpmFilterDeleteByKey0, FwpmFilterGetByKey0, FwpmFreeMemory0, FwpmGetAppIdFromFileName0,
        FwpmProviderAdd0, FwpmProviderDeleteByKey0, FwpmProviderGetByKey0, FwpmSubLayerAdd0,
        FwpmSubLayerDeleteByKey0, FwpmSubLayerGetByKey0, FwpmTransactionAbort0,
        FwpmTransactionBegin0, FwpmTransactionCommit0, FWPM_CONDITION_ALE_APP_ID,
        FWPM_CONDITION_IP_REMOTE_ADDRESS, FWPM_CONDITION_IP_REMOTE_PORT, FWPM_DISPLAY_DATA0,
        FWPM_FILTER0, FWPM_FILTER_CONDITION0, FWPM_FILTER_FLAG_NONE,
        FWPM_LAYER_ALE_AUTH_CONNECT_V4, FWPM_LAYER_ALE_AUTH_CONNECT_V6,
        FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4, FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6, FWPM_PROVIDER0,
        FWPM_SESSION0, FWPM_SESSION_FLAG_DYNAMIC, FWPM_SUBLAYER0, FWP_ACTION_BLOCK,
        FWP_BYTE_ARRAY16, FWP_BYTE_ARRAY16_TYPE, FWP_BYTE_BLOB, FWP_BYTE_BLOB_TYPE, FWP_EMPTY,
        FWP_MATCH_EQUAL, FWP_MATCH_NOT_EQUAL, FWP_UINT16, FWP_UINT32,
    };
    use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
    use windows_sys::Win32::System::Rpc::{RPC_C_AUTHN_WINNT, RPC_S_SERVER_UNAVAILABLE};
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};

    pub(super) struct WfpError {
        pub(super) kind: &'static str,
        pub(super) message: String,
        pub(super) engine_closed: bool,
    }

    pub(super) struct WfpGuard {
        _engine: OwnedWfpEngine,
        _app_id: OwnedWfpAppId,
        filter_ids: Vec<u64>,
        layer_names: Vec<&'static str>,
    }

    impl WfpGuard {
        pub(super) fn filters_added(&self) -> usize {
            self.filter_ids.len()
        }

        pub(super) fn layers(&self) -> &[&'static str] {
            &self.layer_names
        }
    }

    impl Drop for WfpGuard {
        fn drop(&mut self) {
            for filter_id in self.filter_ids.drain(..) {
                unsafe {
                    let _ = FwpmFilterDeleteById0(self._engine.raw(), filter_id);
                }
            }

            unsafe {
                let _ = FwpmSubLayerDeleteByKey0(self._engine.raw(), &AGENTVIS_WFP_SUBLAYER);
                let _ = FwpmProviderDeleteByKey0(self._engine.raw(), &AGENTVIS_WFP_PROVIDER);
            }
        }
    }

    struct OwnedWfpEngine {
        handle: HANDLE,
    }

    impl OwnedWfpEngine {
        fn open() -> Result<Self, WfpError> {
            let mut handle = null_mut();
            let code = unsafe {
                FwpmEngineOpen0(
                    null(),
                    RPC_C_AUTHN_WINNT,
                    null(),
                    null::<FWPM_SESSION0>(),
                    &mut handle,
                )
            };
            ensure_success(code, "FwpmEngineOpen0", false)?;

            Ok(Self { handle })
        }

        fn open_dynamic() -> Result<Self, WfpError> {
            let mut session_name = wide_str("AgentVis WFP dynamic session");
            let mut session_description = wide_str("Temporary AgentVis WFP spike session");
            let mut session = FWPM_SESSION0 {
                displayData: FWPM_DISPLAY_DATA0 {
                    name: session_name.as_mut_ptr(),
                    description: session_description.as_mut_ptr(),
                },
                flags: FWPM_SESSION_FLAG_DYNAMIC,
                ..Default::default()
            };

            let mut handle = null_mut();
            let code = unsafe {
                FwpmEngineOpen0(null(), RPC_C_AUTHN_WINNT, null(), &mut session, &mut handle)
            };
            ensure_success(code, "FwpmEngineOpen0", false)?;

            Ok(Self { handle })
        }

        fn raw(&self) -> HANDLE {
            self.handle
        }
    }

    impl Drop for OwnedWfpEngine {
        fn drop(&mut self) {
            if !self.handle.is_null() {
                unsafe {
                    let _ = FwpmEngineClose0(self.handle);
                }
                self.handle = null_mut();
            }
        }
    }

    struct OwnedWfpAppId {
        blob: *mut FWP_BYTE_BLOB,
    }

    impl OwnedWfpAppId {
        fn from_exe_path(exe: &Path) -> Result<Self, WfpError> {
            let exe_wide = wide_os_str(exe.as_os_str());
            let mut blob = null_mut();
            let code = unsafe { FwpmGetAppIdFromFileName0(exe_wide.as_ptr(), &mut blob) };
            ensure_success(code, "FwpmGetAppIdFromFileName0", true)?;

            if blob.is_null() {
                return Err(WfpError {
                    kind: "wfpError",
                    message: "FwpmGetAppIdFromFileName0 returned a null AppID".to_string(),
                    engine_closed: true,
                });
            }

            Ok(Self { blob })
        }

        fn raw(&self) -> *mut FWP_BYTE_BLOB {
            self.blob
        }
    }

    impl Drop for OwnedWfpAppId {
        fn drop(&mut self) {
            if !self.blob.is_null() {
                let mut ptr = self.blob.cast::<c_void>();
                unsafe {
                    FwpmFreeMemory0(&mut ptr);
                }
                self.blob = null_mut();
            }
        }
    }

    struct WfpTransaction<'a> {
        engine: &'a OwnedWfpEngine,
        committed: bool,
    }

    impl<'a> WfpTransaction<'a> {
        fn begin(engine: &'a OwnedWfpEngine) -> Result<Self, WfpError> {
            let code = unsafe { FwpmTransactionBegin0(engine.raw(), 0) };
            ensure_success(code, "FwpmTransactionBegin0", true)?;

            Ok(Self {
                engine,
                committed: false,
            })
        }

        fn commit(mut self) -> Result<(), WfpError> {
            let code = unsafe { FwpmTransactionCommit0(self.engine.raw()) };
            ensure_success(code, "FwpmTransactionCommit0", true)?;
            self.committed = true;
            Ok(())
        }
    }

    impl Drop for WfpTransaction<'_> {
        fn drop(&mut self) {
            if !self.committed {
                unsafe {
                    let _ = FwpmTransactionAbort0(self.engine.raw());
                }
            }
        }
    }

    #[derive(Clone, Copy)]
    struct BlockFilterSpec {
        name: &'static str,
        key: GUID,
        filter_index: usize,
        kind: FilterKind,
    }

    #[derive(Clone, Copy)]
    enum FilterKind {
        AppOnly,
        ConnectIpv4NonLoopback,
        ConnectIpv4NonProxyPort,
        ConnectIpv6NonLoopback,
        ConnectIpv6NonProxyPort,
    }

    const AGENTVIS_WFP_PROVIDER: GUID = GUID::from_u128(0x5f910d80_292c_4f06_9e29_65a4e4b64201);
    const AGENTVIS_WFP_SUBLAYER: GUID = GUID::from_u128(0xa40b806d_51e2_4a0c_97db_4e1cf3219b0f);

    const LEGACY_BLOCK_FILTERS: [BlockFilterSpec; 4] = [
        BlockFilterSpec {
            name: "ALE_AUTH_CONNECT_V4",
            key: FWPM_LAYER_ALE_AUTH_CONNECT_V4,
            filter_index: 0,
            kind: FilterKind::AppOnly,
        },
        BlockFilterSpec {
            name: "ALE_AUTH_CONNECT_V6",
            key: FWPM_LAYER_ALE_AUTH_CONNECT_V6,
            filter_index: 1,
            kind: FilterKind::AppOnly,
        },
        BlockFilterSpec {
            name: "ALE_AUTH_RECV_ACCEPT_V4",
            key: FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4,
            filter_index: 2,
            kind: FilterKind::AppOnly,
        },
        BlockFilterSpec {
            name: "ALE_AUTH_RECV_ACCEPT_V6",
            key: FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
            filter_index: 3,
            kind: FilterKind::AppOnly,
        },
    ];

    const LOOPBACK_AWARE_BLOCK_FILTERS: [BlockFilterSpec; 6] = [
        BlockFilterSpec {
            name: "ALE_AUTH_RECV_ACCEPT_V4",
            key: FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4,
            filter_index: 2,
            kind: FilterKind::AppOnly,
        },
        BlockFilterSpec {
            name: "ALE_AUTH_RECV_ACCEPT_V6",
            key: FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
            filter_index: 3,
            kind: FilterKind::AppOnly,
        },
        BlockFilterSpec {
            name: "ALE_AUTH_CONNECT_V4_NON_LOOPBACK",
            key: FWPM_LAYER_ALE_AUTH_CONNECT_V4,
            filter_index: 4,
            kind: FilterKind::ConnectIpv4NonLoopback,
        },
        BlockFilterSpec {
            name: "ALE_AUTH_CONNECT_V4_NON_PROXY_PORT",
            key: FWPM_LAYER_ALE_AUTH_CONNECT_V4,
            filter_index: 5,
            kind: FilterKind::ConnectIpv4NonProxyPort,
        },
        BlockFilterSpec {
            name: "ALE_AUTH_CONNECT_V6_NON_LOOPBACK",
            key: FWPM_LAYER_ALE_AUTH_CONNECT_V6,
            filter_index: 6,
            kind: FilterKind::ConnectIpv6NonLoopback,
        },
        BlockFilterSpec {
            name: "ALE_AUTH_CONNECT_V6_NON_PROXY_PORT",
            key: FWPM_LAYER_ALE_AUTH_CONNECT_V6,
            filter_index: 7,
            kind: FilterKind::ConnectIpv6NonProxyPort,
        },
    ];

    const INSPECT_BLOCK_FILTERS: [BlockFilterSpec; 8] = [
        LEGACY_BLOCK_FILTERS[0],
        LEGACY_BLOCK_FILTERS[1],
        LEGACY_BLOCK_FILTERS[2],
        LEGACY_BLOCK_FILTERS[3],
        LOOPBACK_AWARE_BLOCK_FILTERS[2],
        LOOPBACK_AWARE_BLOCK_FILTERS[3],
        LOOPBACK_AWARE_BLOCK_FILTERS[4],
        LOOPBACK_AWARE_BLOCK_FILTERS[5],
    ];

    pub(super) fn install_block_filters(
        exe: &Path,
        allowed_loopback_port: Option<u16>,
    ) -> Result<WfpGuard, WfpError> {
        let engine = OwnedWfpEngine::open_dynamic()?;
        let app_id = OwnedWfpAppId::from_exe_path(exe)?;
        let transaction = WfpTransaction::begin(&engine)?;

        add_provider(&engine)?;
        add_sublayer(&engine)?;

        let filter_specs: &[BlockFilterSpec] = if allowed_loopback_port.is_some() {
            &LOOPBACK_AWARE_BLOCK_FILTERS
        } else {
            &LEGACY_BLOCK_FILTERS
        };
        let mut filter_ids = Vec::with_capacity(filter_specs.len());
        let mut layer_names = Vec::with_capacity(filter_specs.len());

        for spec in filter_specs {
            let filter_id = add_block_filter(&engine, &app_id, *spec, allowed_loopback_port)?;
            filter_ids.push(filter_id);
            layer_names.push(spec.name);
        }

        transaction.commit()?;

        Ok(WfpGuard {
            _engine: engine,
            _app_id: app_id,
            filter_ids,
            layer_names,
        })
    }

    pub(super) fn wait_for_process_exit(pid: u32, timeout_ms: u64) -> Result<(), WfpError> {
        let process = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
        if process.is_null() {
            let code = unsafe { GetLastError() };
            return Err(WfpError {
                kind: "processWaitOpenFailed",
                message: format!("OpenProcess failed for pid {pid}: {code}"),
                engine_closed: true,
            });
        }

        let wait_ms = u32::try_from(timeout_ms).unwrap_or(u32::MAX);
        let wait_result = unsafe { WaitForSingleObject(process, wait_ms) };
        unsafe {
            let _ = CloseHandle(process);
        }

        match wait_result {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err(WfpError {
                kind: "timeout",
                message: format!("target process {pid} did not exit within {timeout_ms}ms"),
                engine_closed: true,
            }),
            other => Err(WfpError {
                kind: "processWaitFailed",
                message: format!("WaitForSingleObject failed for pid {pid}: {other}"),
                engine_closed: true,
            }),
        }
    }

    pub(super) fn inspect_agentvis_objects() -> Result<WfpInspectResult, WfpError> {
        let engine = OwnedWfpEngine::open()?;
        inspect_agentvis_objects_with_engine(&engine)
    }

    pub(super) fn cleanup_agentvis_objects(confirm: bool) -> Result<WfpCleanupResult, WfpError> {
        if !confirm {
            return Err(WfpError {
                kind: "invalidArguments",
                message: "cleanup requires --confirm-agentvis-wfp-cleanup".to_string(),
                engine_closed: false,
            });
        }

        let engine = OwnedWfpEngine::open()?;
        let mut filters_deleted = 0;

        for spec in &INSPECT_BLOCK_FILTERS {
            if delete_filter_by_key(&engine, filter_guid(spec.filter_index))? {
                filters_deleted += 1;
            }
        }

        let sublayer_deleted = delete_sublayer_by_key(&engine, AGENTVIS_WFP_SUBLAYER)?;
        let provider_deleted = delete_provider_by_key(&engine, AGENTVIS_WFP_PROVIDER)?;
        let residual = inspect_agentvis_objects_with_engine(&engine)?;

        Ok(WfpCleanupResult {
            filters_deleted,
            sublayer_deleted,
            provider_deleted,
            residual,
        })
    }

    fn inspect_agentvis_objects_with_engine(
        engine: &OwnedWfpEngine,
    ) -> Result<WfpInspectResult, WfpError> {
        let provider_detected = provider_exists(engine, AGENTVIS_WFP_PROVIDER)?;
        let sublayer_detected = sublayer_exists(engine, AGENTVIS_WFP_SUBLAYER)?;
        let mut filters_detected = Vec::new();

        for spec in &INSPECT_BLOCK_FILTERS {
            if filter_exists(engine, filter_guid(spec.filter_index))? {
                filters_detected.push(spec.name);
            }
        }

        Ok(WfpInspectResult {
            provider_detected,
            sublayer_detected,
            filters_detected,
        })
    }

    fn filter_exists(engine: &OwnedWfpEngine, key: GUID) -> Result<bool, WfpError> {
        let mut filter = null_mut();
        let code = unsafe { FwpmFilterGetByKey0(engine.raw(), &key, &mut filter) };

        if code == 0 {
            free_wfp_memory(filter);
            return Ok(true);
        }
        if code == FWP_E_FILTER_NOT_FOUND as u32 {
            return Ok(false);
        }

        Err(wfp_error("FwpmFilterGetByKey0", code, true))
    }

    fn provider_exists(engine: &OwnedWfpEngine, key: GUID) -> Result<bool, WfpError> {
        let mut provider = null_mut();
        let code = unsafe { FwpmProviderGetByKey0(engine.raw(), &key, &mut provider) };

        if code == 0 {
            free_wfp_memory(provider);
            return Ok(true);
        }
        if code == FWP_E_PROVIDER_NOT_FOUND as u32 {
            return Ok(false);
        }

        Err(wfp_error("FwpmProviderGetByKey0", code, true))
    }

    fn sublayer_exists(engine: &OwnedWfpEngine, key: GUID) -> Result<bool, WfpError> {
        let mut sublayer = null_mut();
        let code = unsafe { FwpmSubLayerGetByKey0(engine.raw(), &key, &mut sublayer) };

        if code == 0 {
            free_wfp_memory(sublayer);
            return Ok(true);
        }
        if code == FWP_E_SUBLAYER_NOT_FOUND as u32 {
            return Ok(false);
        }

        Err(wfp_error("FwpmSubLayerGetByKey0", code, true))
    }

    fn delete_filter_by_key(engine: &OwnedWfpEngine, key: GUID) -> Result<bool, WfpError> {
        let code = unsafe { FwpmFilterDeleteByKey0(engine.raw(), &key) };

        if code == 0 {
            return Ok(true);
        }
        if code == FWP_E_FILTER_NOT_FOUND as u32 {
            return Ok(false);
        }

        Err(wfp_error("FwpmFilterDeleteByKey0", code, true))
    }

    fn delete_sublayer_by_key(engine: &OwnedWfpEngine, key: GUID) -> Result<bool, WfpError> {
        let code = unsafe { FwpmSubLayerDeleteByKey0(engine.raw(), &key) };

        if code == 0 {
            return Ok(true);
        }
        if code == FWP_E_SUBLAYER_NOT_FOUND as u32 {
            return Ok(false);
        }

        Err(wfp_error("FwpmSubLayerDeleteByKey0", code, true))
    }

    fn delete_provider_by_key(engine: &OwnedWfpEngine, key: GUID) -> Result<bool, WfpError> {
        let code = unsafe { FwpmProviderDeleteByKey0(engine.raw(), &key) };

        if code == 0 {
            return Ok(true);
        }
        if code == FWP_E_PROVIDER_NOT_FOUND as u32 {
            return Ok(false);
        }

        Err(wfp_error("FwpmProviderDeleteByKey0", code, true))
    }

    fn add_provider(engine: &OwnedWfpEngine) -> Result<(), WfpError> {
        let mut provider_name = wide_str("AgentVis WFP Spike Provider");
        let mut provider_description = wide_str("Temporary provider for AgentVis WFP spike");
        let mut provider = FWPM_PROVIDER0 {
            providerKey: AGENTVIS_WFP_PROVIDER,
            displayData: FWPM_DISPLAY_DATA0 {
                name: provider_name.as_mut_ptr(),
                description: provider_description.as_mut_ptr(),
            },
            ..Default::default()
        };

        let code = unsafe { FwpmProviderAdd0(engine.raw(), &mut provider, null_mut()) };
        ensure_success_or_exists(code, "FwpmProviderAdd0")
    }

    fn add_sublayer(engine: &OwnedWfpEngine) -> Result<(), WfpError> {
        let mut provider_key = AGENTVIS_WFP_PROVIDER;
        let mut sublayer_name = wide_str("AgentVis WFP Spike Sublayer");
        let mut sublayer_description = wide_str("Temporary sublayer for AgentVis WFP spike");
        let mut sublayer = FWPM_SUBLAYER0 {
            subLayerKey: AGENTVIS_WFP_SUBLAYER,
            displayData: FWPM_DISPLAY_DATA0 {
                name: sublayer_name.as_mut_ptr(),
                description: sublayer_description.as_mut_ptr(),
            },
            providerKey: &mut provider_key,
            weight: 0x8000,
            ..Default::default()
        };

        let code = unsafe { FwpmSubLayerAdd0(engine.raw(), &mut sublayer, null_mut()) };
        ensure_success_or_exists(code, "FwpmSubLayerAdd0")
    }

    fn add_block_filter(
        engine: &OwnedWfpEngine,
        app_id: &OwnedWfpAppId,
        spec: BlockFilterSpec,
        allowed_loopback_port: Option<u16>,
    ) -> Result<u64, WfpError> {
        let mut provider_key = AGENTVIS_WFP_PROVIDER;
        let mut filter_name = wide_str(&format!("AgentVis WFP Block {}", spec.name));
        let mut filter_description =
            wide_str("Temporary AppID block filter for AgentVis WFP spike");

        let mut ipv6_loopback = FWP_BYTE_ARRAY16 {
            byteArray16: [0; 16],
        };
        ipv6_loopback.byteArray16[15] = 1;

        let mut conditions = Vec::with_capacity(2);
        conditions.push(app_id_condition(app_id));
        match spec.kind {
            FilterKind::AppOnly => {}
            FilterKind::ConnectIpv4NonLoopback => {
                conditions.push(ipv4_loopback_not_equal_condition());
            }
            FilterKind::ConnectIpv4NonProxyPort => {
                conditions.push(remote_port_not_equal_condition(required_loopback_port(
                    allowed_loopback_port,
                )?));
            }
            FilterKind::ConnectIpv6NonLoopback => {
                conditions.push(ipv6_loopback_not_equal_condition(&mut ipv6_loopback));
            }
            FilterKind::ConnectIpv6NonProxyPort => {
                conditions.push(remote_port_not_equal_condition(required_loopback_port(
                    allowed_loopback_port,
                )?));
            }
        }

        let mut filter = FWPM_FILTER0::default();
        filter.filterKey = filter_guid(spec.filter_index);
        filter.displayData = FWPM_DISPLAY_DATA0 {
            name: filter_name.as_mut_ptr(),
            description: filter_description.as_mut_ptr(),
        };
        filter.flags = FWPM_FILTER_FLAG_NONE;
        filter.providerKey = &mut provider_key;
        filter.layerKey = spec.key;
        filter.subLayerKey = AGENTVIS_WFP_SUBLAYER;
        filter.weight.r#type = FWP_EMPTY;
        filter.numFilterConditions = conditions.len() as u32;
        filter.filterCondition = conditions.as_mut_ptr();
        filter.action.r#type = FWP_ACTION_BLOCK;

        let mut filter_id = 0;
        let code = unsafe { FwpmFilterAdd0(engine.raw(), &mut filter, null_mut(), &mut filter_id) };
        ensure_success(code, "FwpmFilterAdd0", true)?;
        Ok(filter_id)
    }

    fn required_loopback_port(port: Option<u16>) -> Result<u16, WfpError> {
        port.ok_or_else(|| WfpError {
            kind: "invalidArguments",
            message: "--allow-loopback-port is required for loopback-aware WFP filters".to_string(),
            engine_closed: true,
        })
    }

    fn app_id_condition(app_id: &OwnedWfpAppId) -> FWPM_FILTER_CONDITION0 {
        let mut condition = FWPM_FILTER_CONDITION0::default();
        condition.fieldKey = FWPM_CONDITION_ALE_APP_ID;
        condition.matchType = FWP_MATCH_EQUAL;
        condition.conditionValue.r#type = FWP_BYTE_BLOB_TYPE;
        condition.conditionValue.Anonymous.byteBlob = app_id.raw();
        condition
    }

    fn remote_port_not_equal_condition(port: u16) -> FWPM_FILTER_CONDITION0 {
        let mut condition = FWPM_FILTER_CONDITION0::default();
        condition.fieldKey = FWPM_CONDITION_IP_REMOTE_PORT;
        condition.matchType = FWP_MATCH_NOT_EQUAL;
        condition.conditionValue.r#type = FWP_UINT16;
        condition.conditionValue.Anonymous.uint16 = port;
        condition
    }

    fn ipv4_loopback_not_equal_condition() -> FWPM_FILTER_CONDITION0 {
        let mut condition = FWPM_FILTER_CONDITION0::default();
        condition.fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS;
        condition.matchType = FWP_MATCH_NOT_EQUAL;
        condition.conditionValue.r#type = FWP_UINT32;
        condition.conditionValue.Anonymous.uint32 = u32::from_be_bytes([127, 0, 0, 1]);
        condition
    }

    fn ipv6_loopback_not_equal_condition(
        loopback: &mut FWP_BYTE_ARRAY16,
    ) -> FWPM_FILTER_CONDITION0 {
        let mut condition = FWPM_FILTER_CONDITION0::default();
        condition.fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS;
        condition.matchType = FWP_MATCH_NOT_EQUAL;
        condition.conditionValue.r#type = FWP_BYTE_ARRAY16_TYPE;
        condition.conditionValue.Anonymous.byteArray16 = loopback;
        condition
    }

    fn filter_guid(index: usize) -> GUID {
        GUID::from_u128(0x1a0e12f7_6350_42fd_b029_0f90fd080000 + index as u128)
    }

    fn ensure_success(code: u32, operation: &str, engine_closed: bool) -> Result<(), WfpError> {
        if code == 0 {
            return Ok(());
        }

        Err(wfp_error(operation, code, engine_closed))
    }

    fn ensure_success_or_exists(code: u32, operation: &str) -> Result<(), WfpError> {
        if code == 0 || code == FWP_E_ALREADY_EXISTS as u32 {
            return Ok(());
        }

        Err(wfp_error(operation, code, true))
    }

    fn wfp_error(operation: &str, code: u32, engine_closed: bool) -> WfpError {
        WfpError {
            kind: error_kind(code),
            message: format!("{operation} failed: {code:#010x}"),
            engine_closed,
        }
    }

    fn error_kind(code: u32) -> &'static str {
        if code == ERROR_ACCESS_DENIED {
            "permissionDenied"
        } else if code == RPC_S_SERVER_UNAVAILABLE as u32 {
            "bfeUnavailable"
        } else if code == FWP_E_ALREADY_EXISTS as u32 {
            "alreadyExists"
        } else {
            "wfpError"
        }
    }

    fn free_wfp_memory<T>(ptr: *mut T) {
        if ptr.is_null() {
            return;
        }

        let mut raw = ptr.cast::<c_void>();
        unsafe {
            FwpmFreeMemory0(&mut raw);
        }
    }

    fn wide_str(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(Some(0)).collect()
    }

    fn wide_os_str(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(Some(0)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        parse_args, Mode, AGENTVIS_MANAGED_EGRESS_MARKER, DEFAULT_GUARD_TIMEOUT_MS,
        DEFAULT_PROBE_TIMEOUT_MS,
    };
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn parses_probe_args() {
        let options = parse_args([
            "probe",
            "--exe",
            r"C:\AgentVis\target\debug\agentvis_wfp_network_probe.exe",
            "--json",
        ])
        .expect("probe args should parse");

        assert_eq!(options.mode, Mode::Probe);
        assert_eq!(
            options.exe,
            Some(PathBuf::from(
                r"C:\AgentVis\target\debug\agentvis_wfp_network_probe.exe"
            ))
        );
        assert_eq!(options.pid, None);
        assert_eq!(options.timeout_ms, DEFAULT_PROBE_TIMEOUT_MS);
        assert_eq!(options.ready_file, None);
        assert_eq!(options.allowed_loopback_port, None);
        assert!(options.json);
    }

    #[test]
    fn parses_inspect_args() {
        let options = parse_args(["inspect", "--json"]).expect("inspect args should parse");

        assert_eq!(options.mode, Mode::Inspect);
        assert_eq!(options.exe, None);
        assert_eq!(options.pid, None);
        assert_eq!(options.timeout_ms, 0);
        assert_eq!(options.ready_file, None);
        assert_eq!(options.allowed_loopback_port, None);
        assert!(!options.confirm_cleanup);
        assert!(options.json);
    }

    #[test]
    fn parses_cleanup_args() {
        let options = parse_args(["cleanup", "--confirm-agentvis-wfp-cleanup", "--json"])
            .expect("cleanup args should parse");

        assert_eq!(options.mode, Mode::Cleanup);
        assert_eq!(options.exe, None);
        assert_eq!(options.pid, None);
        assert_eq!(options.timeout_ms, 0);
        assert_eq!(options.ready_file, None);
        assert_eq!(options.allowed_loopback_port, None);
        assert!(options.confirm_cleanup);
        assert!(options.json);
    }

    #[test]
    fn parses_guard_args() {
        let options = parse_args([
            "guard",
            "--exe",
            r"C:\AgentVis\target\debug\agentvis_wfp_network_probe.exe",
            "--pid",
            "1234",
        ])
        .expect("guard args should parse");

        assert_eq!(options.mode, Mode::Guard);
        assert_eq!(options.pid, Some(1234));
        assert_eq!(options.timeout_ms, DEFAULT_GUARD_TIMEOUT_MS);
        assert_eq!(options.ready_file, None);
        assert_eq!(options.allowed_loopback_port, None);
    }

    #[test]
    fn parses_allowed_loopback_port_for_guard() {
        let options = parse_args([
            "guard",
            "--exe",
            r"C:\AgentVis\target\debug\agentvis_wfp_network_probe.exe",
            "--pid",
            "1234",
            "--allow-loopback-port",
            "55148",
        ])
        .expect("guard with loopback proxy port should parse");

        assert_eq!(options.mode, Mode::Guard);
        assert_eq!(options.allowed_loopback_port, Some(55148));
    }

    #[test]
    fn rejects_allowed_loopback_port_for_inspect() {
        let error = parse_args(["inspect", "--allow-loopback-port", "55148"])
            .expect_err("inspect should reject loopback proxy port");

        assert!(error.contains("allow-loopback-port"));
    }

    #[test]
    fn rejects_zero_allowed_loopback_port() {
        let error = parse_args([
            "probe",
            "--exe",
            r"C:\AgentVis\target\debug\agentvis_wfp_network_probe.exe",
            "--allow-loopback-port",
            "0",
        ])
        .expect_err("zero loopback proxy port should fail");

        assert!(error.contains("allow-loopback-port"));
    }

    #[test]
    fn guard_requires_pid() {
        let error = parse_args([
            "guard",
            "--exe",
            r"C:\AgentVis\target\debug\agentvis_wfp_network_probe.exe",
        ])
        .expect_err("guard without pid should fail");

        assert!(error.contains("requires `--pid`"));
    }

    #[test]
    fn rejects_relative_exe_path() {
        let error = parse_args(["probe", "--exe", r"target\debug\probe.exe"])
            .expect_err("relative exe should fail");

        assert!(error.contains("absolute path"));
    }

    #[test]
    fn rejects_non_probe_exe_path() {
        let error = parse_args(["probe", "--exe", r"C:\Windows\System32\python.exe"])
            .expect_err("non-probe exe should fail");

        assert!(error.contains("agentvis_wfp_network_probe.exe"));
    }

    #[test]
    fn parses_agentvis_managed_exe_when_marker_exists() {
        let root =
            std::env::temp_dir().join(format!("agentvis-wfp-managed-exe-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create temp guard dir");
        fs::write(root.join(AGENTVIS_MANAGED_EGRESS_MARKER), b"managed\n")
            .expect("write managed marker");
        let exe = root.join("node.exe");
        let exe_text = exe.to_string_lossy().to_string();

        let options = parse_args([
            "guard",
            "--exe",
            exe_text.as_str(),
            "--pid",
            "1234",
            "--allow-agentvis-managed-exe",
        ])
        .expect("managed exe args should parse");

        assert_eq!(options.mode, Mode::Guard);
        assert_eq!(options.exe, Some(exe));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_agentvis_managed_exe_without_marker() {
        let root = std::env::temp_dir().join(format!(
            "agentvis-wfp-managed-exe-missing-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create temp guard dir");
        let exe = root.join("node.exe");
        let exe_text = exe.to_string_lossy().to_string();

        let error = parse_args([
            "guard",
            "--exe",
            exe_text.as_str(),
            "--pid",
            "1234",
            "--allow-agentvis-managed-exe",
        ])
        .expect_err("managed exe without marker should fail");

        assert!(error.contains(AGENTVIS_MANAGED_EGRESS_MARKER));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn inspect_rejects_agentvis_managed_exe_flag() {
        let error = parse_args(["inspect", "--allow-agentvis-managed-exe"])
            .expect_err("inspect should reject managed exe flag");

        assert!(error.contains("allow-agentvis-managed-exe"));
    }

    #[test]
    fn rejects_invalid_timeout() {
        let error = parse_args([
            "probe",
            "--exe",
            r"C:\AgentVis\target\debug\agentvis_wfp_network_probe.exe",
            "--timeout-ms",
            "soon",
        ])
        .expect_err("invalid timeout should fail");

        assert!(error.contains("timeout-ms"));
    }

    #[test]
    fn rejects_zero_pid() {
        let error = parse_args([
            "guard",
            "--exe",
            r"C:\AgentVis\target\debug\agentvis_wfp_network_probe.exe",
            "--pid",
            "0",
        ])
        .expect_err("zero pid should fail");

        assert!(error.contains("positive integer"));
    }

    #[test]
    fn parses_ready_file() {
        let options = parse_args([
            "probe",
            "--exe",
            r"C:\AgentVis\target\debug\agentvis_wfp_network_probe.exe",
            "--ready-file",
            r"C:\AgentVis\target\wfp-ready.txt",
        ])
        .expect("ready-file args should parse");

        assert_eq!(
            options.ready_file,
            Some(PathBuf::from(r"C:\AgentVis\target\wfp-ready.txt"))
        );
    }

    #[test]
    fn rejects_relative_ready_file() {
        let error = parse_args([
            "probe",
            "--exe",
            r"C:\AgentVis\target\debug\agentvis_wfp_network_probe.exe",
            "--ready-file",
            r"target\wfp-ready.txt",
        ])
        .expect_err("relative ready-file should fail");

        assert!(error.contains("ready-file"));
    }

    #[test]
    fn cleanup_requires_confirmation() {
        let error = parse_args(["cleanup"]).expect_err("cleanup without confirmation should fail");

        assert!(error.contains("confirm-agentvis-wfp-cleanup"));
    }

    #[test]
    fn inspect_rejects_exe_path() {
        let error = parse_args([
            "inspect",
            "--exe",
            r"C:\AgentVis\target\debug\agentvis_wfp_network_probe.exe",
        ])
        .expect_err("inspect should reject exe");

        assert!(error.contains("does not accept `--exe`"));
    }
}
