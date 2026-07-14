//! 进程沙箱能力 facade。
//!
//! 当前模块负责稳定 re-export 沙箱策略、审计、网络扫描、桌面能力检测、共享类型和平台后端；
//! `ShellSandboxPolicy` 解析模式 / 生命周期 / 网络范围 / subject，`platform` 子模块承载
//! Windows Job Object、AppContainer、Restricted Token 与非 Windows stub。
//!
//! 这一层不直接执行 shell 命令，也不替代 `command_validator`、Trash Bin 或前端授权；
//! 它为 `shell.rs` 等执行入口提供可组合的策略、审计事件和平台约束能力。

mod audit;
mod broker_audit;
mod desktop;
mod network;
mod platform;
mod policy;
mod types;

pub use self::audit::{
    list_persisted_sandbox_audit_events, list_sandbox_audit_events, record_sandbox_audit_event,
    set_sandbox_audit_db_pool, SandboxAuditEvent, SandboxAuditEventQuery,
};
pub use self::broker_audit::{
    main_process_network_audit_event, network_broker_audit_event,
    network_broker_subject_audit_event, NetworkBrokerAuditDetails, NetworkBrokerAuditSubject,
};
pub(crate) use self::network::NetworkDirectTargetRiskInfo;
pub(crate) use self::network::{
    agent_browser_runtime_script_hint, command_token_name, detect_network_direct_targets,
    detect_network_intent, detect_network_proxy_bypass_signal,
    detect_network_remote_destructive_signal, detect_network_sensitive_egress_signal,
    detect_network_upload_risk_signal, direct_targets_from_allowances_for_protocols,
    encoded_hostname_target_risk, required_network_direct_protocols,
    resolve_network_direct_target_risk, split_command_tokens,
};
pub use self::policy::ShellSandboxPolicy;
#[cfg(test)]
use self::types::ControlledNetworkBackend;
pub use self::types::{
    AppContainerFilesystemAccess, AppContainerFilesystemGrant, AppContainerFilesystemProfileResult,
    AppContainerNetworkCapability, NetworkDirectAllowance, ProcessLifecycle, ProcessSandboxProfile,
    RestrictedExecutionBackend, RestrictedTokenProbeResult, SandboxLevel, SandboxMode,
    SandboxNetworkAccess, SandboxNetworkIsolation, SandboxNetworkScope, SandboxSubjectType,
};
pub(crate) use self::types::{
    NetworkDirectTarget, NetworkProxyBypassSignal, NetworkRiskSignal, NetworkUploadRiskSignal,
};

#[cfg(target_os = "windows")]
pub use self::platform::{
    prepare_appcontainer_filesystem_profile,
    prepare_appcontainer_filesystem_profile_with_capabilities, run_appcontainer_filesystem_probe,
    run_restricted_token_probe, spawn_appcontainer_filesystem_process,
    spawn_appcontainer_filesystem_process_with_capabilities, spawn_restricted_token_process,
    AppContainerChild, AppContainerChildControl, AppContainerFilesystemProfile,
    ProcessSandboxGuard,
};

#[cfg(not(target_os = "windows"))]
pub use self::platform::{run_restricted_token_probe, ProcessSandboxGuard};
#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tokio::process::Command;

    fn temp_script_path(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("agentvis_process_sandbox_{}_{}.py", name, nonce))
    }

    fn bundled_skill_script(relative_path: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("skills-bundle")
            .join(relative_path)
    }

    #[cfg(target_os = "windows")]
    fn temp_directory_path(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("agentvis_process_sandbox_{}_{}", name, nonce))
    }

    #[cfg(target_os = "windows")]
    fn is_restricted_token_launch_privilege_error(error: &str) -> bool {
        error.contains("CreateProcessAsUserW")
            && error.contains("CreateProcessWithTokenW")
            && (error.contains("1314") || error.to_lowercase().contains("required privilege"))
    }

    #[cfg(target_os = "windows")]
    fn is_appcontainer_profile_unavailable_error(error: &str) -> bool {
        error.contains("CreateAppContainerProfile")
            && error.contains("DeriveAppContainerSidFromAppContainerName")
    }

    #[test]
    fn external_skill_defaults_to_network_audit() {
        let policy = ShellSandboxPolicy::from_options(Some("externalSkill"), None).unwrap();

        assert_eq!(policy.level, SandboxLevel::ExternalSkill);
        assert_eq!(policy.network, SandboxNetworkAccess::Audit);
        assert_eq!(policy.sandbox_mode, SandboxMode::LocalAudit);
        assert_eq!(policy.process_lifecycle, ProcessLifecycle::Managed);
        assert!(policy.allows_workdir_fallback());
    }

    #[test]
    fn local_detached_launch_skips_job_object_profile() {
        let policy = ShellSandboxPolicy::from_execution_options(
            None,
            None,
            Some("local"),
            None,
            None,
            false,
            r#"start "" "C:\Program Files\Google\Chrome\Application\chrome.exe""#,
            None,
            None,
        )
        .unwrap();

        assert_eq!(policy.sandbox_mode, SandboxMode::LocalAudit);
        assert_eq!(policy.process_lifecycle, ProcessLifecycle::DetachedLaunch);
        assert_eq!(policy.process_profile(), ProcessSandboxProfile::Detached);
        assert!(!policy.blocks_detached_launch());
    }

    #[test]
    fn offline_isolated_mode_blocks_detached_launch() {
        let policy = ShellSandboxPolicy::from_execution_options(
            None,
            None,
            Some("OfflineIsolated"),
            None,
            Some("detachedLaunch"),
            false,
            "explorer .",
            None,
            None,
        )
        .unwrap();

        assert_eq!(policy.level, SandboxLevel::Restricted);
        assert_eq!(policy.network, SandboxNetworkAccess::Blocked);
        assert_eq!(policy.process_profile(), ProcessSandboxProfile::Detached);
        assert!(policy.blocks_detached_launch());
    }

    #[test]
    fn offline_isolated_mode_blocks_desktop_control_skill() {
        let policy = ShellSandboxPolicy::from_execution_options(
            Some("externalSkill"),
            Some("audit"),
            Some("OfflineIsolated"),
            None,
            Some("managed"),
            false,
            r#"python "C:/Users/Muulo/AppData/Roaming/com.agentvis.app/skills/external/packages/desktop-control/scripts/desktop_control.py" hotkey win d"#,
            Some("skill"),
            Some("desktop-control".to_string()),
        )
        .unwrap();

        assert_eq!(policy.level, SandboxLevel::Restricted);
        assert_eq!(policy.sandbox_mode, SandboxMode::OfflineIsolated);
        assert!(policy
            .blocked_desktop_interaction(
                r#"python "C:/Users/Muulo/AppData/Roaming/com.agentvis.app/skills/external/packages/desktop-control/scripts/desktop_control.py" hotkey win d"#,
                None,
            )
            .is_some());
    }

    #[test]
    fn local_audit_mode_allows_desktop_control_skill() {
        let policy = ShellSandboxPolicy::from_execution_options(
            Some("externalSkill"),
            Some("audit"),
            Some("local"),
            None,
            Some("managed"),
            false,
            r#"python "C:/skills/desktop-control/scripts/desktop_control.py" hotkey win d"#,
            Some("skill"),
            Some("desktop-control".to_string()),
        )
        .unwrap();

        assert_eq!(policy.sandbox_mode, SandboxMode::LocalAudit);
        assert!(policy
            .blocked_desktop_interaction(
                r#"python "C:/skills/desktop-control/scripts/desktop_control.py" hotkey win d"#,
                None,
            )
            .is_none());
    }

    #[test]
    fn local_desktop_control_command_infers_detached_lifecycle() {
        let policy = ShellSandboxPolicy::from_execution_options(
            None,
            None,
            Some("local"),
            None,
            None,
            false,
            r#"python "C:/skills/desktop-control/scripts/desktop_control.py" app activate --name "UU远程""#,
            None,
            None,
        )
        .unwrap();

        assert_eq!(policy.sandbox_mode, SandboxMode::LocalAudit);
        assert_eq!(policy.process_lifecycle, ProcessLifecycle::DetachedLaunch);
        assert_eq!(policy.process_profile(), ProcessSandboxProfile::Detached);
        assert!(!policy.blocks_detached_launch());
    }

    #[test]
    fn local_agent_browser_launcher_infers_detached_lifecycle() {
        let policy = ShellSandboxPolicy::from_execution_options(
            None,
            None,
            Some("local"),
            None,
            None,
            false,
            r#"cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" https://example.com"#,
            None,
            None,
        )
        .unwrap();

        assert_eq!(policy.sandbox_mode, SandboxMode::LocalAudit);
        assert_eq!(policy.process_lifecycle, ProcessLifecycle::DetachedLaunch);
        assert_eq!(policy.process_profile(), ProcessSandboxProfile::Detached);
        assert!(!policy.blocks_detached_launch());
    }

    #[test]
    fn offline_isolated_agent_browser_launcher_is_blocked() {
        let policy = ShellSandboxPolicy::from_execution_options(
            None,
            None,
            Some("OfflineIsolated"),
            None,
            None,
            false,
            r#"cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" https://example.com"#,
            None,
            None,
        )
        .unwrap();

        assert_eq!(policy.sandbox_mode, SandboxMode::OfflineIsolated);
        assert_eq!(policy.process_lifecycle, ProcessLifecycle::DetachedLaunch);
        assert!(policy.blocks_detached_launch());
    }

    #[test]
    fn controlled_network_generic_agent_browser_cli_is_detached_launch() {
        let policy = ShellSandboxPolicy::from_execution_options(
            None,
            None,
            Some("ControlledNetwork"),
            Some("internetAudit"),
            None,
            false,
            "agent-browser --headed open https://example.com",
            None,
            None,
        )
        .unwrap();

        assert_eq!(policy.sandbox_mode, SandboxMode::ControlledNetwork);
        assert_eq!(policy.process_lifecycle, ProcessLifecycle::DetachedLaunch);
        assert!(policy.blocks_detached_launch());
    }

    #[test]
    fn audit_event_carries_subject_and_lifecycle() {
        let policy = ShellSandboxPolicy::from_execution_options(
            Some("externalSkill"),
            Some("audit"),
            Some("local"),
            None,
            Some("managed"),
            false,
            "curl https://example.com",
            Some("skill"),
            Some("csv-analyzer".to_string()),
        )
        .unwrap();

        let events =
            policy.pre_spawn_audit_events("curl https://example.com", None, Some("exec-1"));

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].subject_type, "skill");
        assert_eq!(events[0].subject_id.as_deref(), Some("csv-analyzer"));
        assert_eq!(events[0].sandbox_mode, "LocalAudit");
        assert_eq!(events[0].process_lifecycle, "managed");
        assert_eq!(events[0].network_scope, "internetAudit");
    }

    #[test]
    fn wfp_diagnostic_audit_event_uses_wfp_backend() {
        let policy = ShellSandboxPolicy::from_execution_options(
            None,
            Some("audit"),
            Some("ControlledNetwork"),
            Some("internetAudit"),
            Some("managed"),
            false,
            "curl https://example.com",
            None,
            None,
        )
        .unwrap();

        let event = policy.wfp_diagnostic_audit_event(
            "curl https://example.com",
            None,
            Some("exec-1"),
            "block",
            "wfp_app_id_guard_requires_per_run_identity",
            Some("cmd.exe shared shell launcher".to_string()),
        );

        assert_eq!(event.backend, "wfpEnhanced");
        assert_eq!(event.decision, "block");
        assert_eq!(event.reason, "wfp_app_id_guard_requires_per_run_identity");
        assert_eq!(event.execution_id.as_deref(), Some("exec-1"));
    }

    #[test]
    fn controlled_network_main_process_tool_reports_audit_event() {
        let event = main_process_network_audit_event(
            "web_search",
            Some("ControlledNetwork"),
            "https://api.tavily.com/search",
        )
        .unwrap()
        .unwrap();

        assert_eq!(event.source, "nativeTool");
        assert_eq!(event.subject_type, "tool");
        assert_eq!(event.subject_id.as_deref(), Some("web_search"));
        assert_eq!(event.profile, "standard");
        assert_eq!(event.sandbox_mode, "ControlledNetwork");
        assert_eq!(event.network_policy, "audit");
        assert_eq!(event.network_scope, "internetAudit");
        assert_eq!(event.backend, "mainProcess");
        assert_eq!(event.decision, "audit");
        assert_eq!(event.reason, "main_process_network_request");
        assert_eq!(
            event.matched_pattern.as_deref(),
            Some("https://api.tavily.com/search")
        );
    }

    #[test]
    fn local_main_process_tool_skips_network_audit_event() {
        let event = main_process_network_audit_event(
            "web_search",
            Some("local"),
            "https://api.tavily.com/search",
        )
        .unwrap();

        assert!(event.is_none());
    }

    #[test]
    fn controlled_network_broker_tool_reports_request_metadata() {
        let event = network_broker_audit_event(
            "web_search",
            Some("ControlledNetwork"),
            NetworkBrokerAuditDetails {
                method: "POST".to_string(),
                url: "https://api.tavily.com/search".to_string(),
                target_host: Some("api.tavily.com".to_string()),
                target_scheme: Some("https".to_string()),
                detail: None,
                status_code: Some(200),
                bytes_in: 512,
                bytes_out: 128,
                duration_ms: 42,
                blocked_reason: None,
            },
        )
        .unwrap()
        .unwrap();

        assert_eq!(event.source, "nativeTool");
        assert_eq!(event.subject_type, "tool");
        assert_eq!(event.backend, "broker");
        assert_eq!(event.decision, "audit");
        assert_eq!(event.reason, "broker_network_request");
        assert_eq!(event.target_host.as_deref(), Some("api.tavily.com"));
        assert_eq!(event.target_scheme.as_deref(), Some("https"));
        assert_eq!(event.request_method.as_deref(), Some("POST"));
        assert_eq!(event.status_code, Some(200));
        assert_eq!(event.bytes_in, Some(512));
        assert_eq!(event.bytes_out, Some(128));
        assert_eq!(event.duration_ms, Some(42));
        assert!(event.url_hash.is_some());
    }

    #[test]
    fn controlled_network_broker_audit_redacts_url_details() {
        let event = network_broker_audit_event(
            "web_search",
            Some("ControlledNetwork"),
            NetworkBrokerAuditDetails {
                method: "GET".to_string(),
                url: "https://user:secret@example.com:8443/path/to/resource?token=secret"
                    .to_string(),
                target_host: Some("example.com".to_string()),
                target_scheme: Some("https".to_string()),
                detail: None,
                status_code: Some(200),
                bytes_in: 64,
                bytes_out: 0,
                duration_ms: 5,
                blocked_reason: None,
            },
        )
        .unwrap()
        .unwrap();

        assert_eq!(
            event.matched_pattern.as_deref(),
            Some("https://example.com:8443")
        );
        assert!(event.url_hash.is_some());
        assert_ne!(
            event.matched_pattern.as_deref(),
            Some("https://user:secret@example.com:8443/path/to/resource?token=secret")
        );
    }

    #[test]
    fn controlled_network_broker_tool_reports_block_metadata() {
        let event = network_broker_audit_event(
            "web_search",
            Some("ControlledNetwork"),
            NetworkBrokerAuditDetails {
                method: "POST".to_string(),
                url: "https://api.tavily.com/search".to_string(),
                target_host: Some("api.tavily.com".to_string()),
                target_scheme: Some("https".to_string()),
                detail: Some(
                    "targetHost=127.0.0.1.sslip.io; resolvedRisk=private; resolvedRiskReason=hostnameEncodedPrivateOrLocalIp; resolvedIpSamples=127.0.0.1"
                        .to_string(),
                ),
                status_code: None,
                bytes_in: 0,
                bytes_out: 128,
                duration_ms: 7,
                blocked_reason: Some("Network broker rejected localhost target".to_string()),
            },
        )
        .unwrap()
        .unwrap();

        assert_eq!(event.backend, "broker");
        assert_eq!(event.decision, "block");
        assert_eq!(event.reason, "broker_network_block");
        assert_eq!(
            event.blocked_reason.as_deref(),
            Some("Network broker rejected localhost target")
        );
        assert_eq!(
            event.matched_pattern.as_deref(),
            Some(
                "targetHost=127.0.0.1.sslip.io; resolvedRisk=private; resolvedRiskReason=hostnameEncodedPrivateOrLocalIp; resolvedIpSamples=127.0.0.1"
            )
        );
        assert_eq!(event.status_code, None);
        assert_eq!(event.bytes_in, Some(0));
    }

    #[test]
    fn controlled_network_broker_skill_reports_subject_metadata() {
        let event = network_broker_subject_audit_event(
            NetworkBrokerAuditSubject::external_skill(Some("rss-reader".to_string())),
            Some("ControlledNetwork"),
            NetworkBrokerAuditDetails {
                method: "GET".to_string(),
                url: "https://example.com/feed.xml".to_string(),
                target_host: Some("example.com".to_string()),
                target_scheme: Some("https".to_string()),
                detail: None,
                status_code: Some(200),
                bytes_in: 1024,
                bytes_out: 0,
                duration_ms: 31,
                blocked_reason: None,
            },
        )
        .unwrap()
        .unwrap();

        assert_eq!(event.source, "externalSkill");
        assert_eq!(event.subject_type, "skill");
        assert_eq!(event.subject_id.as_deref(), Some("rss-reader"));
        assert_eq!(event.profile, "externalSkill");
        assert_eq!(event.backend, "broker");
        assert_eq!(event.decision, "audit");
    }

    #[test]
    fn controlled_network_broker_subject_reports_execution_id() {
        let event = network_broker_subject_audit_event(
            NetworkBrokerAuditSubject::command(Some("agent-1".to_string()))
                .with_execution_id(Some("exec-1")),
            Some("ControlledNetwork"),
            NetworkBrokerAuditDetails {
                method: "GET".to_string(),
                url: "https://example.com/".to_string(),
                target_host: Some("example.com".to_string()),
                target_scheme: Some("https".to_string()),
                detail: None,
                status_code: Some(200),
                bytes_in: 128,
                bytes_out: 0,
                duration_ms: 9,
                blocked_reason: None,
            },
        )
        .unwrap()
        .unwrap();

        assert_eq!(event.source, "exec");
        assert_eq!(event.subject_type, "command");
        assert_eq!(event.subject_id.as_deref(), Some("agent-1"));
        assert_eq!(event.execution_id.as_deref(), Some("exec-1"));
        assert_eq!(event.reason, "broker_network_request");
    }

    #[test]
    fn controlled_network_legacy_backend_adds_appcontainer_network_capabilities() {
        let policy = ShellSandboxPolicy::from_execution_options(
            None,
            None,
            Some("ControlledNetwork"),
            None,
            None,
            false,
            "curl https://example.com",
            None,
            None,
        )
        .unwrap();

        assert_eq!(policy.level, SandboxLevel::Restricted);
        assert_eq!(policy.network, SandboxNetworkAccess::Audit);
        assert_eq!(policy.network_scope, SandboxNetworkScope::InternetAudit);
        assert_eq!(
            policy.controlled_network_backend_from_switch(Some("legacy")),
            ControlledNetworkBackend::LegacyAppContainerDirect
        );
        assert!(policy.uses_restricted_process_backend_from_switch(Some("legacy")));
        assert_eq!(
            policy.appcontainer_network_capabilities_for_restricted_backend(),
            vec![
                AppContainerNetworkCapability::InternetClient,
                AppContainerNetworkCapability::PrivateNetworkClientServer,
            ]
        );
        assert_eq!(
            policy
                .network_isolation_from_backend(RestrictedExecutionBackend::AppContainerFilesystem),
            SandboxNetworkIsolation::AuditOnly
        );
    }

    #[test]
    fn controlled_network_defaults_to_local_broker_backend_for_audit_network() {
        let policy = ShellSandboxPolicy::from_execution_options(
            None,
            None,
            Some("ControlledNetwork"),
            None,
            None,
            false,
            "curl https://example.com",
            None,
            None,
        )
        .unwrap();

        assert_eq!(
            policy.controlled_network_backend_from_switch(None),
            ControlledNetworkBackend::LocalFilesystemBrokerPreferred
        );
        assert!(
            policy.uses_broker_preferred_network_guard(),
            "default ControlledNetwork audit path should expose broker-preferred guard markers"
        );
        let env = policy.environment_overrides();
        assert!(env.contains(&("AGENTVIS_FILESYSTEM_ACCESS", "local")));
        assert!(env.contains(&("AGENTVIS_NETWORK_GUARD", "broker-preferred")));
        assert!(
            !policy.uses_restricted_process_backend_from_switch(None),
            "default ControlledNetwork audit path should not enter AppContainer FS"
        );
        assert!(
            !policy.uses_restricted_process_backend_from_switch(Some("local-broker")),
            "broker-preferred ControlledNetwork should not enter AppContainer FS for audit network"
        );
    }

    #[test]
    fn controlled_network_local_broker_backend_preserves_blocked_network_hard_isolation() {
        let policy = ShellSandboxPolicy::from_execution_options(
            Some("restricted"),
            Some("blocked"),
            Some("ControlledNetwork"),
            Some("blocked"),
            None,
            false,
            "agentvis-broker-fetch",
            Some("skill"),
            Some("broker-only-skill".to_string()),
        )
        .unwrap();

        assert!(policy.uses_restricted_process_backend_from_switch(Some("local-broker")));
    }

    #[test]
    fn controlled_network_blocked_network_uses_appcontainer_deny_all() {
        let policy = ShellSandboxPolicy::from_execution_options(
            Some("restricted"),
            Some("blocked"),
            Some("ControlledNetwork"),
            Some("blocked"),
            None,
            false,
            "agentvis-broker-fetch",
            Some("skill"),
            Some("broker-only-skill".to_string()),
        )
        .unwrap();

        assert_eq!(policy.network, SandboxNetworkAccess::Blocked);
        assert_eq!(policy.network_scope, SandboxNetworkScope::Blocked);
        assert!(policy.appcontainer_network_capabilities().is_empty());
        assert_eq!(
            policy.network_isolation(),
            SandboxNetworkIsolation::AppContainerDenyAll
        );
    }

    #[test]
    fn restricted_defaults_to_blocked_network_and_no_workdir_fallback() {
        let policy = ShellSandboxPolicy::from_options(Some("restricted"), None).unwrap();

        assert_eq!(policy.level, SandboxLevel::Restricted);
        assert_eq!(policy.network, SandboxNetworkAccess::Blocked);
        assert!(!policy.allows_workdir_fallback());
        assert_eq!(policy.process_profile(), ProcessSandboxProfile::Restricted);
        assert!(policy.process_profile().requires_job_object());
    }

    #[test]
    fn installer_and_preview_keep_network_inherited() {
        for level in ["installer", "preview"] {
            let policy = ShellSandboxPolicy::from_options(Some(level), None).unwrap();

            assert_eq!(policy.network, SandboxNetworkAccess::Inherit);
            assert!(policy.allows_workdir_fallback());
            assert_eq!(policy.process_profile(), ProcessSandboxProfile::Standard);
            assert!(!policy.process_profile().requires_job_object());
        }
    }

    #[test]
    fn installer_subject_does_not_auto_prepend_default_venv_path() {
        let installer = ShellSandboxPolicy::from_execution_options(
            Some("installer"),
            None,
            None,
            None,
            None,
            false,
            "python -m pip --version",
            Some("installer"),
            Some("python-runtime".to_string()),
        )
        .unwrap();
        let command = ShellSandboxPolicy::from_execution_options(
            Some("standard"),
            None,
            None,
            None,
            None,
            false,
            "python --version",
            Some("command"),
            None,
        )
        .unwrap();

        assert!(!installer.should_prepend_default_venv_path());
        assert!(command.should_prepend_default_venv_path());
    }

    #[test]
    fn restricted_execution_backend_defaults_to_appcontainer() {
        let policy = ShellSandboxPolicy::from_options(Some("restricted"), None).unwrap();

        assert_eq!(
            policy.restricted_execution_backend_from_switch(None),
            RestrictedExecutionBackend::AppContainerFilesystem
        );
        assert_eq!(
            policy.restricted_execution_backend_from_switch(Some("")),
            RestrictedExecutionBackend::AppContainerFilesystem
        );
    }

    #[test]
    fn restricted_execution_backend_switch_keeps_token_escape_hatch() {
        let restricted = ShellSandboxPolicy::from_options(Some("restricted"), None).unwrap();

        assert_eq!(
            restricted.restricted_execution_backend_from_switch(Some("restricted-token")),
            RestrictedExecutionBackend::RestrictedToken
        );
        assert_eq!(
            restricted.restricted_execution_backend_from_switch(Some("phase2c")),
            RestrictedExecutionBackend::RestrictedToken
        );
    }

    #[test]
    fn restricted_execution_backend_switch_enables_appcontainer_for_restricted_only() {
        let restricted = ShellSandboxPolicy::from_options(Some("restricted"), None).unwrap();
        let standard = ShellSandboxPolicy::from_options(Some("standard"), None).unwrap();

        assert_eq!(
            restricted.restricted_execution_backend_from_switch(Some("appcontainer")),
            RestrictedExecutionBackend::AppContainerFilesystem
        );
        assert_eq!(
            restricted.restricted_execution_backend_from_switch(Some("APPContainer-Filesystem")),
            RestrictedExecutionBackend::AppContainerFilesystem
        );
        assert_eq!(
            standard.restricted_execution_backend_from_switch(Some("appcontainer")),
            RestrictedExecutionBackend::RestrictedToken
        );
    }

    #[test]
    fn restricted_token_backend_remains_soft_blocked() {
        let policy = ShellSandboxPolicy::from_options(Some("restricted"), None).unwrap();

        assert_eq!(
            policy.network_isolation_from_backend(RestrictedExecutionBackend::RestrictedToken),
            SandboxNetworkIsolation::SoftBlocked
        );
        assert!(!policy
            .environment_overrides_for_backend(RestrictedExecutionBackend::RestrictedToken)
            .iter()
            .any(|(key, _)| *key == "AGENTVIS_NETWORK_HARD_ISOLATION"));
    }

    #[test]
    fn restricted_defaults_to_appcontainer_hard_isolation() {
        let policy = ShellSandboxPolicy::from_options(Some("restricted"), None).unwrap();
        let env = policy
            .environment_overrides_for_backend(RestrictedExecutionBackend::AppContainerFilesystem);

        assert_eq!(
            policy.restricted_execution_backend_from_switch(None),
            RestrictedExecutionBackend::AppContainerFilesystem
        );
        assert_eq!(
            policy
                .network_isolation_from_backend(RestrictedExecutionBackend::AppContainerFilesystem),
            SandboxNetworkIsolation::AppContainerDenyAll
        );
        assert!(env.contains(&("AGENTVIS_NETWORK_HARD_ISOLATION", "appcontainer-deny-all")));
        assert!(env.contains(&("AGENTVIS_NETWORK_ACCESS", "blocked")));
    }

    #[test]
    fn appcontainer_backend_marks_restricted_network_hard_isolation() {
        let policy = ShellSandboxPolicy::from_options(Some("restricted"), None).unwrap();
        let env = policy
            .environment_overrides_for_backend(RestrictedExecutionBackend::AppContainerFilesystem);

        assert_eq!(
            policy.network_isolation_from_backend(
                RestrictedExecutionBackend::AppContainerFilesystem,
            ),
            SandboxNetworkIsolation::AppContainerDenyAll
        );
        assert!(env.contains(&("AGENTVIS_NETWORK_HARD_ISOLATION", "appcontainer-deny-all")));
        assert!(env.contains(&("AGENTVIS_NETWORK_ACCESS", "blocked")));
    }

    #[test]
    fn blocked_network_rejects_direct_network_command() {
        let policy =
            ShellSandboxPolicy::from_options(Some("externalSkill"), Some("blocked")).unwrap();

        let error = policy
            .validate_pre_spawn("curl https://example.com", None)
            .unwrap_err();

        assert!(error.to_string().contains("network command"));
    }

    #[test]
    fn audit_network_does_not_reject_direct_network_command() {
        let policy =
            ShellSandboxPolicy::from_options(Some("externalSkill"), Some("audit")).unwrap();

        assert!(policy
            .validate_pre_spawn("curl https://example.com", None)
            .is_ok());
    }

    #[test]
    fn audit_network_reports_structured_command_event() {
        let policy =
            ShellSandboxPolicy::from_options(Some("externalSkill"), Some("audit")).unwrap();

        let events =
            policy.pre_spawn_audit_events("curl https://example.com", None, Some("exec-1"));

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].schema_version, 1);
        assert!(events[0].id.starts_with("sandbox-audit-"));
        assert!(events[0].timestamp > 0);
        assert!(!events[0].timestamp_iso.is_empty());
        assert_eq!(events[0].execution_id.as_deref(), Some("exec-1"));
        assert_eq!(events[0].source, "externalSkill");
        assert_eq!(events[0].subject_type, "command");
        assert!(!events[0].command_hash.is_empty());
        assert_eq!(events[0].profile, "externalSkill");
        assert_eq!(events[0].network_policy, "audit");
        assert_eq!(events[0].backend, "jobObject");
        assert_eq!(events[0].decision, "audit");
        assert_eq!(events[0].reason, "network_command_detected");
        assert_eq!(events[0].matched_pattern.as_deref(), Some("curl"));
        assert_eq!(events[0].workdir, None);
        assert_eq!(events[0].cleanup, None);
    }

    #[test]
    fn blocked_network_rejects_script_network_api() {
        let script = temp_script_path("network_api");
        fs::write(
            &script,
            "import requests\nrequests.get('https://example.com')\n",
        )
        .unwrap();

        let policy =
            ShellSandboxPolicy::from_options(Some("externalSkill"), Some("blocked")).unwrap();
        let error = policy
            .validate_pre_spawn(&format!("python {}", script.display()), None)
            .unwrap_err();

        fs::remove_file(&script).unwrap();
        assert!(error.to_string().contains("network API"));
    }

    #[test]
    fn proxy_bypass_detector_flags_non_http_commands_with_targets() {
        let signal = detect_network_proxy_bypass_signal("ssh -p 2222 user@example.com", None)
            .expect("ssh should be a non-http direct signal");
        assert_eq!(signal.kind, "nonHttpOrRawSocket");

        let targets = detect_network_direct_targets("ssh -p 2222 user@example.com", None);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].protocol, "ssh");
        assert_eq!(targets[0].host, "example.com");
        assert_eq!(targets[0].port, 2222);
    }

    #[test]
    fn proxy_bypass_detector_extracts_common_direct_protocol_targets() {
        let cases = [
            (
                "scp -P 2200 ./a.txt user@ssh.example.com:/tmp/a.txt",
                "ssh",
                "ssh.example.com",
                2200,
            ),
            (
                "nc -vz raw.example.com 9000",
                "tcp",
                "raw.example.com",
                9000,
            ),
            (
                "telnet telnet.example.com 2323",
                "telnet",
                "telnet.example.com",
                2323,
            ),
            (
                "psql postgresql://user:pass@db.example.com:5433/app",
                "postgres",
                "db.example.com",
                5433,
            ),
            (
                "mysql --host mysql.example.com --port 3307",
                "mysql",
                "mysql.example.com",
                3307,
            ),
            (
                "redis-cli -h cache.example.com -p 6380",
                "redis",
                "cache.example.com",
                6380,
            ),
            (
                "mongosh mongodb://mongo.example.com:27018/app",
                "mongodb",
                "mongo.example.com",
                27018,
            ),
            (
                "sqlcmd -S tcp:mssql.example.com,14330",
                "mssql",
                "mssql.example.com",
                14330,
            ),
        ];

        for (command, protocol, host, port) in cases {
            let signal = detect_network_proxy_bypass_signal(command, None)
                .expect("command should be a non-http direct signal");
            assert_eq!(signal.kind, "nonHttpOrRawSocket");

            let targets = detect_network_direct_targets(command, None);
            assert_eq!(targets.len(), 1, "command: {command}");
            assert_eq!(targets[0].protocol, protocol, "command: {command}");
            assert_eq!(targets[0].host, host, "command: {command}");
            assert_eq!(targets[0].port, port, "command: {command}");
        }
    }

    #[test]
    fn proxy_bypass_detector_flags_powershell_tcpclient_raw_socket() {
        let command = r#"powershell -NoProfile -Command "$tcp = New-Object Net.Sockets.TcpClient; $tcp.Connect('example.com',80)""#;
        assert_eq!(
            detect_network_intent(command, None).as_deref(),
            Some("net.sockets.tcpclient")
        );
        let signal = detect_network_proxy_bypass_signal(command, None)
            .expect("PowerShell TcpClient should be a non-http direct signal");
        assert_eq!(signal.kind, "nonHttpOrRawSocket");
        assert_eq!(signal.pattern, "powershell:net.sockets.tcpclient");

        let targets = detect_network_direct_targets(command, None);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].protocol, "tcp");
        assert_eq!(targets[0].host, "example.com");
        assert_eq!(targets[0].port, 80);
    }

    #[test]
    fn proxy_bypass_detector_extracts_powershell_test_netconnection_targets() {
        let cases = [
            (
                r#"powershell -NoProfile -Command "Test-NetConnection -ComputerName 127.0.0.1 -Port 5432""#,
                "127.0.0.1",
                5432,
            ),
            (
                r#"pwsh -NoProfile -Command "tnc imap.gmail.com -Port 993""#,
                "imap.gmail.com",
                993,
            ),
            (
                r#"powershell -NoProfile -Command "Test-NetConnection -ComputerName:169.254.169.254 -Port:80""#,
                "169.254.169.254",
                80,
            ),
        ];

        for (command, host, port) in cases {
            assert!(detect_network_intent(command, None).is_some());
            let signal = detect_network_proxy_bypass_signal(command, None)
                .expect("Test-NetConnection should be a non-http direct signal");
            assert_eq!(signal.kind, "nonHttpOrRawSocket", "command: {command}");

            let targets = detect_network_direct_targets(command, None);
            assert_eq!(targets.len(), 1, "command: {command}");
            assert_eq!(targets[0].protocol, "tcp", "command: {command}");
            assert_eq!(targets[0].host, host, "command: {command}");
            assert_eq!(targets[0].port, port, "command: {command}");
        }
    }

    #[test]
    fn proxy_bypass_detector_blocks_targetless_powershell_socket() {
        let command = r#"powershell -NoProfile -Command "$socket = [System.Net.Sockets.Socket]::new([System.Net.Sockets.AddressFamily]::InterNetwork, [System.Net.Sockets.SocketType]::Stream, [System.Net.Sockets.ProtocolType]::Tcp)""#;
        assert_eq!(
            detect_network_intent(command, None).as_deref(),
            Some("system.net.sockets.socket")
        );
        let signal = detect_network_proxy_bypass_signal(command, None)
            .expect("PowerShell raw socket should be a non-http direct signal");
        assert_eq!(signal.kind, "nonHttpOrRawSocket");
        assert!(detect_network_direct_targets(command, None).is_empty());
    }

    #[test]
    fn network_direct_allowance_matches_exact_subject_and_target() {
        let policy = ShellSandboxPolicy::from_execution_options(
            Some("standard"),
            Some("audit"),
            Some("ControlledNetwork"),
            Some("internetAudit"),
            Some("managed"),
            false,
            "ssh user@example.com",
            Some("command"),
            Some("agent-1".to_string()),
        )
        .unwrap();
        let target = NetworkDirectTarget::new("ssh", "example.com", 22).unwrap();
        let allowance = NetworkDirectAllowance {
            id: "allow-1".to_string(),
            subject_type: "command".to_string(),
            subject_id: Some("agent-1".to_string()),
            protocol: "ssh".to_string(),
            host: "example.com".to_string(),
            port: 22,
            scope: "currentExecution".to_string(),
            expires_at: Some(Utc::now().timestamp_millis() + 60_000),
            created_at: Utc::now().timestamp_millis(),
            reason: "test".to_string(),
        };

        assert!(policy
            .matching_network_direct_allowances(&[target], &[allowance])
            .is_some());
    }

    #[test]
    fn network_direct_allowance_rejects_expired_or_wrong_subject() {
        let policy = ShellSandboxPolicy::from_execution_options(
            Some("standard"),
            Some("audit"),
            Some("ControlledNetwork"),
            Some("internetAudit"),
            Some("managed"),
            false,
            "ssh user@example.com",
            Some("command"),
            Some("agent-1".to_string()),
        )
        .unwrap();
        let target = NetworkDirectTarget::new("ssh", "example.com", 22).unwrap();
        let expired = NetworkDirectAllowance {
            id: "allow-expired".to_string(),
            subject_type: "command".to_string(),
            subject_id: Some("agent-1".to_string()),
            protocol: "ssh".to_string(),
            host: "example.com".to_string(),
            port: 22,
            scope: "currentExecution".to_string(),
            expires_at: Some(Utc::now().timestamp_millis() - 1),
            created_at: Utc::now().timestamp_millis(),
            reason: "test".to_string(),
        };
        let wrong_subject = NetworkDirectAllowance {
            id: "allow-wrong-subject".to_string(),
            subject_type: "command".to_string(),
            subject_id: Some("agent-2".to_string()),
            expires_at: Some(Utc::now().timestamp_millis() + 60_000),
            ..expired.clone()
        };

        assert!(policy
            .matching_network_direct_allowances(std::slice::from_ref(&target), &[expired])
            .is_none());
        assert!(policy
            .matching_network_direct_allowances(&[target], &[wrong_subject])
            .is_none());
    }

    #[test]
    fn network_direct_allowance_rejects_metadata_target() {
        let policy = ShellSandboxPolicy::from_execution_options(
            Some("standard"),
            Some("audit"),
            Some("ControlledNetwork"),
            Some("internetAudit"),
            Some("managed"),
            false,
            "ssh 169.254.169.254",
            Some("command"),
            Some("agent-1".to_string()),
        )
        .unwrap();
        let target = NetworkDirectTarget::new("ssh", "169.254.169.254", 22).unwrap();
        let allowance = NetworkDirectAllowance {
            id: "allow-metadata".to_string(),
            subject_type: "command".to_string(),
            subject_id: Some("agent-1".to_string()),
            protocol: "ssh".to_string(),
            host: "169.254.169.254".to_string(),
            port: 22,
            scope: "currentExecution".to_string(),
            expires_at: Some(Utc::now().timestamp_millis() + 60_000),
            created_at: Utc::now().timestamp_millis(),
            reason: "test".to_string(),
        };

        assert!(policy
            .matching_network_direct_allowances(&[target], &[allowance])
            .is_none());
    }

    #[test]
    fn direct_targets_from_allowances_require_all_requested_protocols() {
        let now = Utc::now().timestamp_millis();
        let imap_allowance = NetworkDirectAllowance {
            id: "allow-imap".to_string(),
            subject_type: "skill".to_string(),
            subject_id: Some("email-helper".to_string()),
            protocol: "imap".to_string(),
            host: "imap.example.com".to_string(),
            port: 993,
            scope: "currentExecution".to_string(),
            expires_at: Some(now + 60_000),
            created_at: now,
            reason: "test".to_string(),
        };
        let smtp_allowance = NetworkDirectAllowance {
            id: "allow-smtp".to_string(),
            protocol: "smtp".to_string(),
            host: "smtp.example.com".to_string(),
            port: 587,
            ..imap_allowance.clone()
        };
        let protocols = vec!["imap".to_string(), "smtp".to_string()];

        assert!(direct_targets_from_allowances_for_protocols(
            &protocols,
            &[imap_allowance.clone()]
        )
        .is_empty());

        let targets = direct_targets_from_allowances_for_protocols(
            &protocols,
            &[imap_allowance, smtp_allowance],
        );
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0].protocol, "imap");
        assert_eq!(targets[1].protocol, "smtp");
    }

    #[test]
    fn email_helper_metadata_actions_are_not_network_intent() {
        let command = r#"python C:\skills\email-helper\scripts\email_helper.py --action network_targets --account work"#;
        assert!(detect_network_intent(command, None).is_none());
        assert!(detect_network_proxy_bypass_signal(command, None).is_none());
    }

    #[test]
    fn legacy_non_http_guide_network_targets_action_is_metadata_only() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir()
            .join("skills")
            .join("external")
            .join("packages")
            .join(format!("guide-legacy-{nonce}"));
        let scripts_dir = root.join("scripts");
        fs::create_dir_all(&scripts_dir).unwrap();
        fs::write(
            root.join("SKILL.md"),
            "---\nname: guide-legacy\nagentvisNetworkEntrypoints:\n  scripts/probe.py: legacyNonHttp\n---\n",
        )
        .unwrap();
        let script = scripts_dir.join("probe.py");
        fs::write(
            &script,
            "import socket\nsocket.create_connection(('example.com', 1234))\n",
        )
        .unwrap();

        let preflight = format!(
            "python \"{}\" --action network_targets --profile redis",
            script.display()
        );
        assert!(detect_network_intent(&preflight, None).is_none());
        assert!(detect_network_proxy_bypass_signal(&preflight, None).is_none());

        let normal = format!(
            "python \"{}\" --action probe --profile redis",
            script.display()
        );
        assert!(detect_network_intent(&normal, None).is_some());
        assert_eq!(
            detect_network_proxy_bypass_signal(&normal, None)
                .expect("normal action should still be a proxy bypass signal")
                .kind,
            "nonHttpOrRawSocket"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn networked_audit_reports_proxy_bypass_signal() {
        let policy = ShellSandboxPolicy::from_execution_options(
            Some("externalSkill"),
            Some("audit"),
            Some("ControlledNetwork"),
            Some("internetAudit"),
            Some("managed"),
            false,
            "curl --noproxy '*' https://example.com",
            Some("command"),
            Some("exec-1".to_string()),
        )
        .unwrap();

        let events = policy.pre_spawn_audit_events(
            "curl --noproxy '*' https://example.com",
            None,
            Some("exec-1"),
        );
        assert!(events
            .iter()
            .any(|event| event.reason == "proxy_bypass_signal_detected"));
    }

    #[test]
    fn blocked_network_rejects_httpx_script_network_api() {
        let script = temp_script_path("network_api_httpx");
        fs::write(&script, "import httpx\nhttpx.get('https://example.com')\n").unwrap();

        let policy =
            ShellSandboxPolicy::from_options(Some("externalSkill"), Some("blocked")).unwrap();
        let error = policy
            .validate_pre_spawn(&format!("python {}", script.display()), None)
            .unwrap_err();

        fs::remove_file(&script).unwrap();
        assert!(error.to_string().contains("httpx"));
    }

    #[test]
    fn blocked_network_allows_broker_only_skill_entry_script() {
        let script = temp_script_path("broker_only_entry");
        fs::write(&script, "print('broker-only entry uses managed broker')\n").unwrap();
        let command = format!("python \"{}\"", script.display());
        let policy = ShellSandboxPolicy::from_execution_options(
            Some("externalSkill"),
            Some("blocked"),
            Some("ControlledNetwork"),
            Some("blocked"),
            Some("managed"),
            false,
            &command,
            Some("skill"),
            Some("broker-e2e".to_string()),
        )
        .unwrap();

        let result = policy.validate_pre_spawn(&command, None);
        fs::remove_file(&script).unwrap();
        assert!(result.is_ok());
    }

    #[test]
    fn blocked_network_rejects_direct_probe_script_network_api() {
        let script = temp_script_path("direct_network_probe");
        fs::write(
            &script,
            "import urllib.request\nurllib.request.urlopen('https://example.com')\n",
        )
        .unwrap();
        let command = format!("python \"{}\"", script.display());
        let policy =
            ShellSandboxPolicy::from_options(Some("externalSkill"), Some("blocked")).unwrap();
        let error = policy.validate_pre_spawn(&command, None).unwrap_err();

        fs::remove_file(&script).unwrap();
        assert!(error.to_string().contains("network API"));
        assert!(error.to_string().contains("urllib.request"));
    }

    #[test]
    fn blocked_network_allows_bundled_github_lookup_entry_wrapper() {
        let script = bundled_skill_script("github-lookup/scripts/github_lookup_entry.py");
        assert!(
            script.exists(),
            "missing bundled github-lookup entry script"
        );
        let command = format!(
            "python \"{}\" --action search --query hermes",
            script.display()
        );
        let policy = ShellSandboxPolicy::from_execution_options(
            Some("externalSkill"),
            Some("blocked"),
            Some("ControlledNetwork"),
            Some("blocked"),
            Some("managed"),
            false,
            &command,
            Some("skill"),
            Some("github-lookup".to_string()),
        )
        .unwrap();

        assert!(policy.validate_pre_spawn(&command, None).is_ok());
    }

    #[test]
    fn blocked_network_reports_structured_script_event() {
        let script = temp_script_path("network_api_event");
        fs::write(
            &script,
            "import requests\nrequests.get('https://example.com')\n",
        )
        .unwrap();

        let policy =
            ShellSandboxPolicy::from_options(Some("externalSkill"), Some("blocked")).unwrap();
        let events =
            policy.pre_spawn_audit_events(&format!("python {}", script.display()), None, None);

        fs::remove_file(&script).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].schema_version, 1);
        assert_eq!(events[0].network_policy, "blocked");
        assert_eq!(events[0].decision, "block");
        assert_eq!(events[0].reason, "network_api_detected");
        assert!(events[0]
            .matched_pattern
            .as_deref()
            .unwrap_or_default()
            .contains("import requests"));
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn restricted_job_attach_succeeds_for_simple_process() {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut child = Command::new("cmd")
            .args(["/S", "/C", "ping -n 2 127.0.0.1 >nul"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .unwrap();

        let sandbox = ProcessSandboxGuard::attach_child(
            &child,
            "restricted-job-test",
            ProcessSandboxProfile::Restricted,
        )
        .unwrap();
        let status = child.wait().await.unwrap();

        drop(sandbox);
        assert!(status.success());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn appcontainer_filesystem_profile_rejects_missing_grant_path() {
        let missing_path = temp_directory_path("appcontainer_missing_grant");
        let error = prepare_appcontainer_filesystem_profile(
            "agentvis-sandbox-missing-grant-test",
            &[AppContainerFilesystemGrant {
                path: missing_path,
                access: AppContainerFilesystemAccess::ReadExecute,
            }],
        )
        .unwrap_err();

        assert!(error.contains("does not exist"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn appcontainer_filesystem_profile_grants_temp_directory_when_supported() {
        let workdir = temp_directory_path("appcontainer_grant");
        fs::create_dir_all(&workdir).unwrap();
        let profile_name = format!(
            "agentvis-sandbox-fs-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        let result = prepare_appcontainer_filesystem_profile(
            &profile_name,
            &[AppContainerFilesystemGrant {
                path: workdir.clone(),
                access: AppContainerFilesystemAccess::ReadWrite,
            }],
        );

        match result {
            Ok(profile) => {
                let snapshot = profile.result();

                assert_eq!(snapshot.profile_name, profile_name);
                assert!(snapshot.sid_string.starts_with("S-1-15-2-"));
                assert_eq!(snapshot.granted_paths, vec![workdir.clone()]);
                assert!(!profile.sid().is_null());

                drop(profile);
            }
            Err(error) if is_appcontainer_profile_unavailable_error(&error) => {
                eprintln!(
                    "AppContainer profile APIs are not available in this environment: {}",
                    error
                );
            }
            Err(error) => panic!("AppContainer filesystem profile probe failed: {}", error),
        }

        fs::remove_dir_all(&workdir).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn appcontainer_filesystem_probe_writes_inside_granted_workdir_when_supported() {
        let workdir = temp_directory_path("appcontainer_probe");
        fs::create_dir_all(&workdir).unwrap();
        let profile_name = format!(
            "agentvis-sandbox-probe-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let grants = vec![AppContainerFilesystemGrant {
            path: workdir.clone(),
            access: AppContainerFilesystemAccess::ReadWrite,
        }];

        let result = run_appcontainer_filesystem_probe(
            &profile_name,
            &grants,
            "cmd /S /C \"echo appcontainer-file-ok>probe.txt & type probe.txt\"",
            Some(&workdir),
            5000,
        );

        match result {
            Ok(probe) => {
                assert_eq!(probe.exit_code, 0);
                assert!(probe.stdout.contains("appcontainer-file-ok"));
                assert!(fs::read_to_string(workdir.join("probe.txt"))
                    .unwrap()
                    .contains("appcontainer-file-ok"));
            }
            Err(error) if is_appcontainer_profile_unavailable_error(&error) => {
                eprintln!(
                    "AppContainer profile APIs are not available in this environment: {}",
                    error
                );
            }
            Err(error) => panic!("AppContainer filesystem process probe failed: {}", error),
        }

        fs::remove_dir_all(&workdir).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn appcontainer_filesystem_probe_renames_inside_granted_workdir_when_supported() {
        let workdir = temp_directory_path("appcontainer_rename_probe");
        fs::create_dir_all(&workdir).unwrap();
        let profile_name = format!(
            "agentvis-sandbox-rename-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let grants = vec![AppContainerFilesystemGrant {
            path: workdir.clone(),
            access: AppContainerFilesystemAccess::ReadWrite,
        }];

        let result = run_appcontainer_filesystem_probe(
            &profile_name,
            &grants,
            "cmd /S /C \"echo appcontainer-rename-ok>probe.tmp && ren probe.tmp probe.txt && type probe.txt\"",
            Some(&workdir),
            5000,
        );

        match result {
            Ok(probe) => {
                assert_eq!(probe.exit_code, 0);
                assert!(probe.stdout.contains("appcontainer-rename-ok"));
                assert!(fs::read_to_string(workdir.join("probe.txt"))
                    .unwrap()
                    .contains("appcontainer-rename-ok"));
            }
            Err(error) if is_appcontainer_profile_unavailable_error(&error) => {
                eprintln!(
                    "AppContainer profile APIs are not available in this environment: {}",
                    error
                );
            }
            Err(error) => panic!("AppContainer filesystem rename probe failed: {}", error),
        }

        fs::remove_dir_all(&workdir).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn appcontainer_process_observes_hard_isolation_env_marker_when_enabled() {
        let workdir = temp_directory_path("appcontainer_env_marker");
        fs::create_dir_all(&workdir).unwrap();
        let profile_name = format!(
            "agentvis-sandbox-env-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let policy = ShellSandboxPolicy::from_options(Some("restricted"), None).unwrap();
        let env_overrides = policy
            .environment_overrides_for_backend(RestrictedExecutionBackend::AppContainerFilesystem)
            .into_iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect::<Vec<_>>();
        let grants = vec![AppContainerFilesystemGrant {
            path: workdir.clone(),
            access: AppContainerFilesystemAccess::ReadWrite,
        }];

        let result = spawn_appcontainer_filesystem_process(
            &profile_name,
            &grants,
            "cmd /S /C echo %AGENTVIS_NETWORK_HARD_ISOLATION%",
            Some(&workdir),
            &env_overrides,
        )
        .and_then(|child| child.wait_with_output());

        match result {
            Ok(probe) => {
                assert_eq!(probe.exit_code, 0);
                assert!(probe.stdout.contains("appcontainer-deny-all"));
            }
            Err(error) if is_appcontainer_profile_unavailable_error(&error) => {
                eprintln!(
                    "AppContainer profile APIs are not available in this environment: {}",
                    error
                );
            }
            Err(error) => panic!(
                "AppContainer hard isolation env marker probe failed: {}",
                error
            ),
        }

        fs::remove_dir_all(&workdir).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn appcontainer_network_probe_blocks_loopback_without_capabilities_when_supported() {
        use std::io::ErrorKind;
        use std::net::TcpListener;

        let workdir = temp_directory_path("appcontainer_network_probe");
        fs::create_dir_all(&workdir).unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let script = workdir.join("network-probe.ps1");
        fs::write(
            &script,
            format!(
                r#"
$client = New-Object System.Net.Sockets.TcpClient
try {{
    $connect = $client.BeginConnect('127.0.0.1', {port}, $null, $null)
    if ($connect.AsyncWaitHandle.WaitOne(1000)) {{
        $client.EndConnect($connect)
        Write-Output 'network-open'
        exit 0
    }} else {{
        Write-Output 'network-blocked'
        exit 42
    }}
}} catch {{
    Write-Output 'network-blocked'
    exit 42
}} finally {{
    if ($client) {{
        $client.Close()
    }}
}}
"#
            ),
        )
        .unwrap();
        let profile_name = format!(
            "agentvis-sandbox-network-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let grants = vec![AppContainerFilesystemGrant {
            path: workdir.clone(),
            access: AppContainerFilesystemAccess::ReadWrite,
        }];

        let result = run_appcontainer_filesystem_probe(
            &profile_name,
            &grants,
            "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File network-probe.ps1",
            Some(&workdir),
            7000,
        );

        match result {
            Ok(probe) => {
                std::thread::sleep(Duration::from_millis(100));
                let accepted = match listener.accept() {
                    Ok(_) => true,
                    Err(error) if error.kind() == ErrorKind::WouldBlock => false,
                    Err(error) => panic!("loopback listener accept failed: {}", error),
                };

                assert_ne!(probe.exit_code, 0, "unexpected network success: {probe:?}");
                assert!(
                    probe.output.contains("network-blocked"),
                    "network probe did not run as expected: {probe:?}"
                );
                assert!(!probe.output.contains("network-open"));
                assert!(!accepted, "AppContainer process reached loopback listener");
            }
            Err(error) if is_appcontainer_profile_unavailable_error(&error) => {
                eprintln!(
                    "AppContainer profile APIs are not available in this environment: {}",
                    error
                );
            }
            Err(error) => panic!(
                "AppContainer network hard isolation probe failed: {}",
                error
            ),
        }

        fs::remove_dir_all(&workdir).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn appcontainer_network_probe_blocks_udp_loopback_without_capabilities_when_supported() {
        use std::io::ErrorKind;
        use std::net::UdpSocket;

        let workdir = temp_directory_path("appcontainer_udp_network_probe");
        fs::create_dir_all(&workdir).unwrap();
        let socket = UdpSocket::bind(("127.0.0.1", 0)).unwrap();
        socket.set_nonblocking(true).unwrap();
        let port = socket.local_addr().unwrap().port();
        let script = workdir.join("udp-network-probe.ps1");
        fs::write(
            &script,
            format!(
                r#"
$client = New-Object System.Net.Sockets.UdpClient
try {{
    $payload = [System.Text.Encoding]::ASCII.GetBytes('agentvis-udp-probe')
    $sent = $client.Send($payload, $payload.Length, '127.0.0.1', {port})
    Write-Output "udp-send-returned:$sent"
    exit 0
}} catch {{
    Write-Output 'udp-blocked'
    exit 42
}} finally {{
    if ($client) {{
        $client.Close()
    }}
}}
"#
            ),
        )
        .unwrap();
        let profile_name = format!(
            "agentvis-sandbox-udp-network-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let grants = vec![AppContainerFilesystemGrant {
            path: workdir.clone(),
            access: AppContainerFilesystemAccess::ReadWrite,
        }];

        let result = run_appcontainer_filesystem_probe(
            &profile_name,
            &grants,
            "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File udp-network-probe.ps1",
            Some(&workdir),
            7000,
        );

        match result {
            Ok(probe) => {
                std::thread::sleep(Duration::from_millis(100));
                let mut buffer = [0u8; 128];
                let received = match socket.recv_from(&mut buffer) {
                    Ok((bytes_read, _)) => {
                        Some(String::from_utf8_lossy(&buffer[..bytes_read]).to_string())
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => None,
                    Err(error) => panic!("loopback UDP listener recv failed: {}", error),
                };

                assert!(
                    probe.output.contains("udp-blocked")
                        || probe.output.contains("udp-send-returned"),
                    "UDP network probe did not run as expected: {probe:?}"
                );
                assert!(
                    received.is_none(),
                    "AppContainer process reached UDP loopback listener: {:?}",
                    received
                );
            }
            Err(error) if is_appcontainer_profile_unavailable_error(&error) => {
                eprintln!(
                    "AppContainer profile APIs are not available in this environment: {}",
                    error
                );
            }
            Err(error) => panic!(
                "AppContainer UDP network hard isolation probe failed: {}",
                error
            ),
        }

        fs::remove_dir_all(&workdir).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn restricted_token_probe_runs_cmd_echo_when_supported() {
        let result = run_restricted_token_probe("cmd /S /C echo restricted-token-ok", 5000);

        match result {
            Ok(probe) => {
                assert_eq!(probe.exit_code, 0);
                assert!(probe.stdout.contains("restricted-token-ok"));
                assert!(probe.output.contains("restricted-token-ok"));
            }
            Err(error) if is_restricted_token_launch_privilege_error(&error) => {
                eprintln!(
                    "restricted token process launch is not available in this environment: {}",
                    error
                );
            }
            Err(error) => panic!("restricted token probe failed: {}", error),
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn restricted_token_probe_captures_stdout_and_stderr_when_supported() {
        let result = run_restricted_token_probe(
            "cmd /S /C \"echo restricted-out & echo restricted-err 1>&2\"",
            5000,
        );

        match result {
            Ok(probe) => {
                assert_eq!(probe.exit_code, 0);
                assert!(probe.stdout.contains("restricted-out"));
                assert!(probe.stderr.contains("restricted-err"));
            }
            Err(error) if is_restricted_token_launch_privilege_error(&error) => {
                eprintln!(
                    "restricted token process launch is not available in this environment: {}",
                    error
                );
            }
            Err(error) => panic!("restricted token stdout/stderr probe failed: {}", error),
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn restricted_token_process_uses_workdir_and_env_when_supported() {
        let workdir = std::env::temp_dir().join(format!(
            "agentvis_restricted_workdir_{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&workdir).unwrap();
        let env_overrides = vec![(
            "AGENTVIS_RESTRICTED_TEST_VALUE".to_string(),
            "restricted-env-ok".to_string(),
        )];

        let result = spawn_restricted_token_process(
            "cmd /S /C \"echo %CD% & echo %AGENTVIS_RESTRICTED_TEST_VALUE%\"",
            Some(&workdir),
            &env_overrides,
        )
        .and_then(|child| child.wait_with_output());

        fs::remove_dir_all(&workdir).unwrap();
        match result {
            Ok(probe) => {
                assert_eq!(probe.exit_code, 0);
                assert!(probe
                    .stdout
                    .to_lowercase()
                    .contains(&workdir.display().to_string().to_lowercase()));
                assert!(probe.stdout.contains("restricted-env-ok"));
            }
            Err(error) if is_restricted_token_launch_privilege_error(&error) => {
                eprintln!(
                    "restricted token process launch is not available in this environment: {}",
                    error
                );
            }
            Err(error) => panic!("restricted token workdir/env probe failed: {}", error),
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn restricted_token_probe_times_out_and_terminates_job_when_supported() {
        let result = run_restricted_token_probe("cmd /S /C ping -n 6 127.0.0.1 >nul", 200);

        match result {
            Ok(probe) => panic!(
                "restricted token timeout probe unexpectedly succeeded: {:?}",
                probe
            ),
            Err(error) if is_restricted_token_launch_privilege_error(&error) => {
                eprintln!(
                    "restricted token process launch is not available in this environment: {}",
                    error
                );
            }
            Err(error) => assert!(error.contains("timed out")),
        }
    }
}
