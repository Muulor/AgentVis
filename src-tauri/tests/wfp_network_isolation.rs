//! AgentVis WFP 网络隔离集成验证。
//!
//! 默认只编译不触发系统 WFP 规则；需要手动设置 AGENTVIS_RUN_WFP_TESTS=1
//! 才会运行真实 helper/probe 链路。

#[cfg(target_os = "windows")]
mod windows_wfp {
    use serde_json::Value;
    use std::env;
    use std::fs;
    use std::io::ErrorKind;
    use std::net::{TcpListener, UdpSocket};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Output, Stdio};
    use std::sync::{Mutex, MutexGuard, OnceLock};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    const ENABLE_WFP_TESTS_ENV: &str = "AGENTVIS_RUN_WFP_TESTS";
    const STRICT_UDP_ENV: &str = "AGENTVIS_WFP_STRICT_UDP";
    static WFP_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn helper_bin() -> &'static Path {
        Path::new(env!("CARGO_BIN_EXE_agentvis_wfp_helper"))
    }

    fn probe_bin() -> &'static Path {
        Path::new(env!("CARGO_BIN_EXE_agentvis_wfp_network_probe"))
    }

    fn wfp_tests_enabled() -> bool {
        env::var(ENABLE_WFP_TESTS_ENV)
            .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    }

    fn strict_udp_enabled() -> bool {
        env::var(STRICT_UDP_ENV)
            .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    }

    fn acquire_wfp_test_lock() -> MutexGuard<'static, ()> {
        WFP_TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("WFP test lock should not be poisoned")
    }

    fn skip_if_disabled() -> bool {
        if wfp_tests_enabled() {
            return false;
        }

        eprintln!("WFP integration tests skipped; set {ENABLE_WFP_TESTS_ENV}=1 to run them.");
        true
    }

    fn temp_directory(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!("agentvis_wfp_{name}_{nonce}"))
    }

    fn parse_json_output(output: &Output) -> Value {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let line = stdout
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or_else(|| panic!("missing JSON stdout; stderr={stderr}"));

        serde_json::from_str(line).unwrap_or_else(|error| {
            panic!("invalid JSON output: {error}; stdout={stdout}; stderr={stderr}")
        })
    }

    fn environment_diagnostic(json: &Value) -> Option<&str> {
        match json.get("errorKind").and_then(Value::as_str) {
            Some("permissionDenied") => Some("permissionDenied"),
            Some("bfeUnavailable") => Some("bfeUnavailable"),
            Some("unsupportedPlatform") => Some("unsupportedPlatform"),
            _ => None,
        }
    }

    fn run_helper_probe(exe: &Path, ready_file: &Path, timeout_ms: &str) -> Output {
        Command::new(helper_bin())
            .arg("probe")
            .arg("--exe")
            .arg(exe)
            .arg("--timeout-ms")
            .arg(timeout_ms)
            .arg("--ready-file")
            .arg(ready_file)
            .arg("--json")
            .output()
            .expect("helper probe should launch")
    }

    fn run_helper_inspect() -> Output {
        Command::new(helper_bin())
            .arg("inspect")
            .arg("--json")
            .output()
            .expect("helper inspect should launch")
    }

    fn assert_no_residual_objects(context: &str) {
        let output = run_helper_inspect();
        let json = parse_json_output(&output);

        assert!(
            output.status.success(),
            "WFP inspect failed after {context}: {json}"
        );
        assert_eq!(
            json.pointer("/cleanup/residualFiltersDetected")
                .and_then(Value::as_bool),
            Some(false),
            "WFP residual objects detected after {context}: {json}"
        );
        assert_eq!(
            json.pointer("/inspect/residualFiltersDetected")
                .and_then(Value::as_bool),
            Some(false),
            "WFP inspect residual summary mismatch after {context}: {json}"
        );
    }

    #[test]
    fn helper_probe_installs_filters_or_reports_environment_diagnostic() {
        if skip_if_disabled() {
            return;
        }
        let _lock = acquire_wfp_test_lock();

        let temp_dir = temp_directory("helper_probe");
        fs::create_dir_all(&temp_dir).unwrap();
        let ready_file = temp_dir.join("ready.txt");

        let output = run_helper_probe(probe_bin(), &ready_file, "25");
        let json = parse_json_output(&output);

        if !output.status.success() {
            if let Some(kind) = environment_diagnostic(&json) {
                eprintln!("WFP helper environment diagnostic: {kind}; json={json}");
                let _ = fs::remove_dir_all(&temp_dir);
                return;
            }
            panic!("WFP helper probe failed unexpectedly: {json}");
        }

        assert_eq!(json.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(json.get("filtersAdded").and_then(Value::as_u64), Some(4));
        assert_eq!(
            json.get("layers").and_then(Value::as_array).unwrap().len(),
            4
        );
        assert!(ready_file.exists(), "helper did not write ready-file");
        assert_no_residual_objects("normal helper probe exit");

        fs::remove_dir_all(&temp_dir).unwrap();
    }

    #[test]
    fn helper_guard_timeout_reports_timeout_or_environment_diagnostic() {
        if skip_if_disabled() {
            return;
        }
        let _lock = acquire_wfp_test_lock();

        let temp_dir = temp_directory("guard_timeout");
        fs::create_dir_all(&temp_dir).unwrap();
        let ready_file = temp_dir.join("ready.txt");
        let output = Command::new(helper_bin())
            .arg("guard")
            .arg("--exe")
            .arg(probe_bin())
            .arg("--pid")
            .arg(std::process::id().to_string())
            .arg("--timeout-ms")
            .arg("25")
            .arg("--ready-file")
            .arg(&ready_file)
            .arg("--json")
            .output()
            .expect("helper guard timeout probe should launch");
        let json = parse_json_output(&output);

        if let Some(kind) = environment_diagnostic(&json) {
            eprintln!("WFP helper environment diagnostic: {kind}; json={json}");
            let _ = fs::remove_dir_all(&temp_dir);
            return;
        }

        assert!(
            !output.status.success(),
            "guard timeout probe should exit with failure: {json}"
        );
        assert_eq!(
            json.get("errorKind").and_then(Value::as_str),
            Some("timeout")
        );
        assert!(ready_file.exists(), "helper did not write ready-file");
        assert_no_residual_objects("guard timeout");

        fs::remove_dir_all(&temp_dir).unwrap();
    }

    #[test]
    fn helper_kill_cleans_dynamic_session_or_reports_environment_diagnostic() {
        if skip_if_disabled() {
            return;
        }
        let _lock = acquire_wfp_test_lock();

        let temp_dir = temp_directory("helper_kill");
        fs::create_dir_all(&temp_dir).unwrap();
        let ready_file = temp_dir.join("ready.txt");
        let mut helper_child = Command::new(helper_bin())
            .arg("probe")
            .arg("--exe")
            .arg(probe_bin())
            .arg("--timeout-ms")
            .arg("30000")
            .arg("--ready-file")
            .arg(&ready_file)
            .arg("--json")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("helper probe should launch");

        let started = Instant::now();
        while !ready_file.exists() {
            if helper_child
                .try_wait()
                .expect("helper probe status should be readable")
                .is_some()
            {
                let output = helper_child
                    .wait_with_output()
                    .expect("helper output should be available");
                let json = parse_json_output(&output);

                if let Some(kind) = environment_diagnostic(&json) {
                    eprintln!("WFP helper environment diagnostic: {kind}; json={json}");
                    let _ = fs::remove_dir_all(&temp_dir);
                    return;
                }
                panic!("helper exited before ready-file unexpectedly: {json}");
            }

            if started.elapsed() > Duration::from_secs(10) {
                let _ = helper_child.kill();
                let _ = helper_child.wait();
                panic!("helper did not write ready-file before kill test timeout");
            }

            std::thread::sleep(Duration::from_millis(25));
        }

        helper_child
            .kill()
            .expect("helper probe should be killable");
        let _ = helper_child
            .wait_with_output()
            .expect("killed helper output should be available");
        std::thread::sleep(Duration::from_millis(300));
        assert_no_residual_objects("killed helper dynamic session");

        fs::remove_dir_all(&temp_dir).unwrap();
    }

    #[test]
    fn helper_cleanup_reports_no_residual_or_environment_diagnostic() {
        if skip_if_disabled() {
            return;
        }
        let _lock = acquire_wfp_test_lock();

        let output = Command::new(helper_bin())
            .arg("cleanup")
            .arg("--confirm-agentvis-wfp-cleanup")
            .arg("--json")
            .output()
            .expect("helper cleanup should launch");
        let json = parse_json_output(&output);

        if !output.status.success() {
            if let Some(kind) = environment_diagnostic(&json) {
                eprintln!("WFP helper environment diagnostic: {kind}; json={json}");
                return;
            }
            panic!("WFP helper cleanup failed unexpectedly: {json}");
        }

        assert_eq!(
            json.pointer("/cleanup/residualFiltersDetected")
                .and_then(Value::as_bool),
            Some(false),
            "cleanup left residual WFP objects: {json}"
        );
    }

    #[test]
    fn helper_blocks_tcp_loopback_for_probe_when_enabled() {
        if skip_if_disabled() {
            return;
        }
        let _lock = acquire_wfp_test_lock();

        let temp_dir = temp_directory("tcp_loopback");
        fs::create_dir_all(&temp_dir).unwrap();
        let ready_file = temp_dir.join("ready.txt");

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port().to_string();

        let mut probe_child = Command::new(probe_bin())
            .arg("tcp")
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(&port)
            .arg("--timeout-ms")
            .arg("2000")
            .arg("--wait-file")
            .arg(&ready_file)
            .arg("--wait-timeout-ms")
            .arg("10000")
            .arg("--json")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("network probe should launch");

        let helper_output = Command::new(helper_bin())
            .arg("guard")
            .arg("--exe")
            .arg(probe_bin())
            .arg("--pid")
            .arg(probe_child.id().to_string())
            .arg("--timeout-ms")
            .arg("12000")
            .arg("--ready-file")
            .arg(&ready_file)
            .arg("--json")
            .output()
            .expect("helper guard should launch");
        let helper_json = parse_json_output(&helper_output);

        if !helper_output.status.success() {
            let _ = probe_child.kill();
            let _ = probe_child.wait();
            if let Some(kind) = environment_diagnostic(&helper_json) {
                eprintln!("WFP helper environment diagnostic: {kind}; json={helper_json}");
                let _ = fs::remove_dir_all(&temp_dir);
                return;
            }
            panic!("WFP helper guard failed unexpectedly: {helper_json}");
        }

        let probe_output = probe_child
            .wait_with_output()
            .expect("network probe output should be available");
        let probe_json = parse_json_output(&probe_output);

        std::thread::sleep(Duration::from_millis(100));
        let accepted = match listener.accept() {
            Ok(_) => true,
            Err(error) if error.kind() == ErrorKind::WouldBlock => false,
            Err(error) => panic!("loopback listener accept failed: {error}"),
        };

        assert_eq!(
            helper_json.get("filtersAdded").and_then(Value::as_u64),
            Some(4)
        );
        assert!(
            !probe_output.status.success(),
            "TCP probe unexpectedly reached listener: {probe_json}"
        );
        assert_eq!(
            probe_json.get("networkOpen").and_then(Value::as_bool),
            Some(false)
        );
        assert!(
            !accepted,
            "WFP target process reached TCP loopback listener"
        );
        assert_no_residual_objects("TCP loopback guard");

        fs::remove_dir_all(&temp_dir).unwrap();
    }

    #[test]
    fn helper_udp_loopback_probe_reports_current_coverage_when_enabled() {
        if skip_if_disabled() {
            return;
        }
        let _lock = acquire_wfp_test_lock();

        let temp_dir = temp_directory("udp_loopback");
        fs::create_dir_all(&temp_dir).unwrap();
        let ready_file = temp_dir.join("ready.txt");

        let socket = UdpSocket::bind(("127.0.0.1", 0)).unwrap();
        socket.set_nonblocking(true).unwrap();
        let port = socket.local_addr().unwrap().port().to_string();
        let payload = "agentvis-wfp-udp-manual-probe";

        let mut probe_child = Command::new(probe_bin())
            .arg("udp")
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(&port)
            .arg("--payload")
            .arg(payload)
            .arg("--timeout-ms")
            .arg("2000")
            .arg("--wait-file")
            .arg(&ready_file)
            .arg("--wait-timeout-ms")
            .arg("10000")
            .arg("--json")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("UDP probe should launch");

        let helper_output = Command::new(helper_bin())
            .arg("guard")
            .arg("--exe")
            .arg(probe_bin())
            .arg("--pid")
            .arg(probe_child.id().to_string())
            .arg("--timeout-ms")
            .arg("12000")
            .arg("--ready-file")
            .arg(&ready_file)
            .arg("--json")
            .output()
            .expect("helper guard should launch");
        let helper_json = parse_json_output(&helper_output);

        if !helper_output.status.success() {
            let _ = probe_child.kill();
            let _ = probe_child.wait();
            if let Some(kind) = environment_diagnostic(&helper_json) {
                eprintln!("WFP helper environment diagnostic: {kind}; json={helper_json}");
                let _ = fs::remove_dir_all(&temp_dir);
                return;
            }
            panic!("WFP helper guard failed unexpectedly: {helper_json}");
        }

        let probe_output = probe_child
            .wait_with_output()
            .expect("UDP probe output should be available");
        let probe_json = parse_json_output(&probe_output);

        std::thread::sleep(Duration::from_millis(150));
        let mut buffer = [0u8; 256];
        let received = match socket.recv_from(&mut buffer) {
            Ok((bytes_read, _)) => Some(String::from_utf8_lossy(&buffer[..bytes_read]).to_string()),
            Err(error) if error.kind() == ErrorKind::WouldBlock => None,
            Err(error) => panic!("loopback UDP listener recv failed: {error}"),
        };

        assert_eq!(
            helper_json.get("filtersAdded").and_then(Value::as_u64),
            Some(4)
        );

        if let Some(payload) = received {
            if strict_udp_enabled() {
                panic!("WFP target process reached UDP loopback listener: {payload}");
            }
            eprintln!(
                "WFP UDP diagnostic: packet reached listener with current ALE-only filters; probe={probe_json}"
            );
        } else {
            eprintln!("WFP UDP diagnostic: listener received no packet; probe={probe_json}");
        }
        assert_no_residual_objects("UDP loopback guard");

        fs::remove_dir_all(&temp_dir).unwrap();
    }
}
