//! Shell 沙箱策略构建、运行时映射和审计事件构造。

use chrono::Utc;
use tokio::process::Command;

use crate::error::AppError;

use super::audit::{
    next_sandbox_audit_event_id, stable_command_hash, SandboxAuditEvent,
    SANDBOX_AUDIT_SCHEMA_VERSION,
};
use super::broker_audit::NetworkBrokerAuditSubject;
use super::desktop::{detect_desktop_interaction, looks_like_detached_launch_command};
use super::network::{
    detect_network_command, detect_network_direct_targets, detect_network_intent,
    detect_network_proxy_bypass_signal, detect_network_script, is_metadata_direct_target,
    validate_no_network_command, validate_no_network_script,
};
use super::types::{
    normalize_direct_target_host, AppContainerNetworkCapability, NetworkDirectAllowance,
    NetworkDirectTarget, ControlledNetworkBackend, ProcessLifecycle, ProcessSandboxProfile,
    RestrictedExecutionBackend, SandboxLevel, SandboxMode, SandboxNetworkAccess,
    SandboxNetworkIsolation, SandboxNetworkScope, SandboxSubjectType,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellSandboxPolicy {
    pub(super) level: SandboxLevel,
    pub(super) network: SandboxNetworkAccess,
    pub(super) sandbox_mode: SandboxMode,
    pub(super) network_scope: SandboxNetworkScope,
    pub(super) process_lifecycle: ProcessLifecycle,
    pub(super) subject_type: SandboxSubjectType,
    pub(super) subject_id: Option<String>,
}

const CONTROLLED_NETWORK_BACKEND_ENV: &str = "AGENTVIS_CONTROLLED_NETWORK_BACKEND";
const RESTRICTED_EXECUTION_BACKEND_ENV: &str = "AGENTVIS_RESTRICTED_EXECUTION_BACKEND";

impl ShellSandboxPolicy {
    pub fn from_options(level: Option<&str>, network: Option<&str>) -> Result<Self, AppError> {
        let level = match level.unwrap_or("standard").trim() {
            "" | "standard" => SandboxLevel::Standard,
            "externalSkill" | "external_skill" | "external-skill" => SandboxLevel::ExternalSkill,
            "installer" => SandboxLevel::Installer,
            "preview" => SandboxLevel::Preview,
            "restricted" => SandboxLevel::Restricted,
            other => {
                return Err(AppError::Forbidden(format!(
                    "Unknown sandbox level '{}'",
                    other
                )));
            }
        };

        let default_network = match level {
            SandboxLevel::Standard | SandboxLevel::Installer | SandboxLevel::Preview => {
                SandboxNetworkAccess::Inherit
            }
            SandboxLevel::ExternalSkill => SandboxNetworkAccess::Audit,
            SandboxLevel::Restricted => SandboxNetworkAccess::Blocked,
        };

        let network = match network {
            None => default_network,
            Some(value) => match value.trim() {
                "" | "inherit" => SandboxNetworkAccess::Inherit,
                "audit" | "detect" => SandboxNetworkAccess::Audit,
                "blocked" | "block" | "none" => SandboxNetworkAccess::Blocked,
                other => {
                    return Err(AppError::Forbidden(format!(
                        "Unknown sandbox network policy '{}'",
                        other
                    )));
                }
            },
        };

        Ok(Self {
            level,
            network,
            sandbox_mode: match level {
                SandboxLevel::Restricted => SandboxMode::OfflineIsolated,
                SandboxLevel::Standard
                | SandboxLevel::ExternalSkill
                | SandboxLevel::Installer
                | SandboxLevel::Preview => SandboxMode::LocalAudit,
            },
            network_scope: SandboxNetworkScope::from_network_access(network),
            process_lifecycle: ProcessLifecycle::Managed,
            subject_type: SandboxSubjectType::Command,
            subject_id: None,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn from_execution_options(
        level: Option<&str>,
        network: Option<&str>,
        sandbox_mode: Option<&str>,
        network_scope: Option<&str>,
        process_lifecycle: Option<&str>,
        background: bool,
        command: &str,
        subject_type: Option<&str>,
        subject_id: Option<String>,
    ) -> Result<Self, AppError> {
        let mut policy = Self::from_options(level, network)?;

        if let Some(mode) = sandbox_mode {
            policy.sandbox_mode = SandboxMode::parse(mode)?;
            match policy.sandbox_mode {
                SandboxMode::LocalAudit => {
                    if level.is_none() {
                        policy.level = SandboxLevel::Standard;
                    }
                    if network.is_none() {
                        policy.network = policy.default_network_for_level();
                    }
                }
                SandboxMode::OfflineIsolated => {
                    policy.level = SandboxLevel::Restricted;
                    policy.network = SandboxNetworkAccess::Blocked;
                }
                SandboxMode::ControlledNetwork => {
                    policy.level = SandboxLevel::Restricted;
                    if network.is_none() {
                        policy.network = SandboxNetworkAccess::Audit;
                    }
                }
            }
        }

        if let Some(scope) = network_scope {
            policy.network_scope = SandboxNetworkScope::parse(scope)?;
            policy.network = policy.network_scope.as_network_access();
            if policy.sandbox_mode == SandboxMode::OfflineIsolated {
                policy.network = SandboxNetworkAccess::Blocked;
                policy.network_scope = SandboxNetworkScope::Blocked;
            }
        } else {
            policy.network_scope = SandboxNetworkScope::from_network_access(policy.network);
            if policy.sandbox_mode == SandboxMode::ControlledNetwork
                && policy.network_scope == SandboxNetworkScope::Blocked
                && network.is_none()
            {
                policy.network_scope = SandboxNetworkScope::InternetAudit;
            }
        }

        policy.process_lifecycle = match process_lifecycle {
            Some(value) => ProcessLifecycle::parse(value)?,
            None => ProcessLifecycle::infer(background, command),
        };
        if background && policy.process_lifecycle == ProcessLifecycle::Managed {
            policy.process_lifecycle = ProcessLifecycle::BackgroundManaged;
        }

        policy.subject_type = subject_type
            .map(SandboxSubjectType::parse)
            .transpose()?
            .unwrap_or_else(|| policy.level.default_subject_type());
        policy.subject_id = subject_id.filter(|value| !value.trim().is_empty());

        Ok(policy)
    }

    fn default_network_for_level(&self) -> SandboxNetworkAccess {
        match self.level {
            SandboxLevel::Standard | SandboxLevel::Installer | SandboxLevel::Preview => {
                SandboxNetworkAccess::Inherit
            }
            SandboxLevel::ExternalSkill => SandboxNetworkAccess::Audit,
            SandboxLevel::Restricted => SandboxNetworkAccess::Blocked,
        }
    }

    pub fn validate_pre_spawn(&self, command: &str, workdir: Option<&str>) -> Result<(), AppError> {
        match self.network {
            SandboxNetworkAccess::Inherit => Ok(()),
            SandboxNetworkAccess::Audit => {
                if let Err(error) = validate_no_network_command(command) {
                    log::warn!("[Sandbox] 网络能力审计命中: {}", error);
                }
                if let Err(error) = validate_no_network_script(command, workdir) {
                    log::warn!("[Sandbox] 网络能力审计命中: {}", error);
                }
                Ok(())
            }
            SandboxNetworkAccess::Blocked => {
                validate_no_network_command(command)?;
                validate_no_network_script(command, workdir)?;
                Ok(())
            }
        }
    }

    pub fn pre_spawn_audit_events(
        &self,
        command: &str,
        workdir: Option<&str>,
        execution_id: Option<&str>,
    ) -> Vec<SandboxAuditEvent> {
        let decision = match self.network {
            SandboxNetworkAccess::Inherit => return Vec::new(),
            SandboxNetworkAccess::Audit => "audit",
            SandboxNetworkAccess::Blocked => "block",
        };

        let mut events = Vec::new();
        if let Some(pattern) = detect_network_command(command) {
            events.push(self.audit_event(
                command,
                workdir,
                execution_id,
                decision,
                "network_command_detected",
                Some(pattern),
            ));
        }
        if let Some(pattern) = detect_network_script(command, workdir) {
            events.push(self.audit_event(
                command,
                workdir,
                execution_id,
                decision,
                "network_api_detected",
                Some(pattern),
            ));
        }
        if detect_network_intent(command, workdir).is_some() {
            if let Some(signal) = detect_network_proxy_bypass_signal(command, workdir) {
                let mut event = self.audit_event(
                    command,
                    workdir,
                    execution_id,
                    decision,
                    "proxy_bypass_signal_detected",
                    Some(signal.audit_detail()),
                );
                if self.uses_broker_preferred_network_guard()
                    && self.network == SandboxNetworkAccess::Audit
                {
                    event.guard_mode = Some("wouldBlock".to_string());
                }
                if let Some(target) = detect_network_direct_targets(command, workdir)
                    .into_iter()
                    .next()
                {
                    event.target_host = Some(target.host);
                    event.target_port = Some(target.port);
                    event.network_protocol = Some(target.protocol);
                }
                events.push(event);
            }
        }
        events
    }

    pub(crate) fn matching_network_direct_allowances(
        &self,
        targets: &[NetworkDirectTarget],
        allowances: &[NetworkDirectAllowance],
    ) -> Option<Vec<NetworkDirectAllowance>> {
        if targets.is_empty() {
            return None;
        }

        let matches = targets
            .iter()
            .map(|target| {
                self.matching_network_direct_allowance(target, allowances)
                    .cloned()
            })
            .collect::<Option<Vec<_>>>()?;
        Some(matches)
    }

    fn matching_network_direct_allowance<'a>(
        &self,
        target: &NetworkDirectTarget,
        allowances: &'a [NetworkDirectAllowance],
    ) -> Option<&'a NetworkDirectAllowance> {
        if is_metadata_direct_target(target) {
            return None;
        }
        let now = Utc::now().timestamp_millis();
        allowances.iter().find(|allowance| {
            if !matches!(
                allowance.scope.as_str(),
                "currentExecution" | "current_execution" | "current-execution" | "session"
            ) {
                return false;
            }
            if allowance
                .expires_at
                .is_some_and(|expires_at| expires_at <= now)
            {
                return false;
            }
            if !allowance
                .subject_type
                .eq_ignore_ascii_case(self.subject_type.as_event_value())
            {
                return false;
            }
            if normalize_direct_target_host(&allowance.host).as_deref()
                != Some(target.host.as_str())
            {
                return false;
            }
            allowance.subject_id.as_deref() == self.subject_id.as_deref()
                && allowance.protocol.eq_ignore_ascii_case(&target.protocol)
                && allowance.port == target.port
        })
    }

    fn audit_event(
        &self,
        command: &str,
        workdir: Option<&str>,
        execution_id: Option<&str>,
        decision: &str,
        reason: &str,
        matched_pattern: Option<String>,
    ) -> SandboxAuditEvent {
        let now = Utc::now();
        let timestamp = now.timestamp_millis();
        SandboxAuditEvent {
            schema_version: SANDBOX_AUDIT_SCHEMA_VERSION,
            id: next_sandbox_audit_event_id(timestamp),
            timestamp,
            timestamp_iso: now.to_rfc3339(),
            execution_id: execution_id.map(ToOwned::to_owned),
            source: self.level.as_audit_source().to_string(),
            subject_type: self.subject_type.as_event_value().to_string(),
            subject_id: self.subject_id.clone(),
            command_hash: stable_command_hash(command),
            profile: self.level.as_env_value().to_string(),
            sandbox_mode: self.sandbox_mode.as_event_value().to_string(),
            process_lifecycle: self.process_lifecycle.as_event_value().to_string(),
            network_policy: self.network.as_event_value().to_string(),
            network_scope: self.network_scope.as_event_value().to_string(),
            backend: self.audit_backend().to_string(),
            decision: decision.to_string(),
            reason: reason.to_string(),
            matched_pattern,
            risk_class: None,
            risk_kind: None,
            credential_context: None,
            workdir: workdir.map(ToOwned::to_owned),
            cleanup: None,
            target_host: None,
            target_scheme: None,
            target_port: None,
            network_protocol: None,
            guard_mode: match decision {
                "block" => Some("hardBlock".to_string()),
                "diagnostic" | "audit" | "allow" => Some("auditOnly".to_string()),
                _ => None,
            },
            request_method: None,
            url_hash: None,
            status_code: None,
            bytes_in: None,
            bytes_out: None,
            duration_ms: None,
            blocked_reason: None,
        }
    }

    pub fn diagnostic_audit_event(
        &self,
        command: &str,
        workdir: Option<&str>,
        execution_id: Option<&str>,
        decision: &str,
        reason: &str,
        matched_pattern: Option<String>,
    ) -> SandboxAuditEvent {
        self.audit_event(
            command,
            workdir,
            execution_id,
            decision,
            reason,
            matched_pattern,
        )
    }

    pub fn diagnostic_audit_event_with_backend(
        &self,
        command: &str,
        workdir: Option<&str>,
        execution_id: Option<&str>,
        decision: &str,
        reason: &str,
        matched_pattern: Option<String>,
        backend: &str,
    ) -> SandboxAuditEvent {
        let mut event = self.audit_event(
            command,
            workdir,
            execution_id,
            decision,
            reason,
            matched_pattern,
        );
        event.backend = backend.to_string();
        event
    }

    pub fn wfp_diagnostic_audit_event(
        &self,
        command: &str,
        workdir: Option<&str>,
        execution_id: Option<&str>,
        decision: &str,
        reason: &str,
        matched_pattern: Option<String>,
    ) -> SandboxAuditEvent {
        self.diagnostic_audit_event_with_backend(
            command,
            workdir,
            execution_id,
            decision,
            reason,
            matched_pattern,
            "wfpEnhanced",
        )
    }

    fn audit_backend(&self) -> &'static str {
        if self.process_lifecycle == ProcessLifecycle::DetachedLaunch {
            return "none";
        }
        if !self.uses_restricted_process_backend() {
            return "jobObject";
        }

        match self.restricted_execution_backend() {
            RestrictedExecutionBackend::RestrictedToken => "restrictedToken",
            RestrictedExecutionBackend::AppContainerFilesystem => "appContainer",
        }
    }

    pub fn apply_environment(&self, cmd: &mut Command) {
        for (key, value) in self.environment_overrides() {
            cmd.env(key, value);
        }
    }

    pub fn environment_overrides(&self) -> Vec<(&'static str, &'static str)> {
        self.environment_overrides_for_backend(self.restricted_execution_backend())
    }

    pub(super) fn environment_overrides_for_backend(
        &self,
        backend: RestrictedExecutionBackend,
    ) -> Vec<(&'static str, &'static str)> {
        let mut env = vec![
            ("AGENTVIS_SANDBOX_LEVEL", self.level.as_env_value()),
            ("AGENTVIS_SANDBOX_MODE", self.sandbox_mode.as_event_value()),
            (
                "AGENTVIS_PROCESS_LIFECYCLE",
                self.process_lifecycle.as_event_value(),
            ),
            (
                "AGENTVIS_NETWORK_SCOPE",
                self.network_scope.as_event_value(),
            ),
        ];
        if self.uses_restricted_process_backend_for_backend(backend) {
            env.push(("AGENTVIS_FILESYSTEM_ACCESS", "restricted"));
        } else if self.uses_controlled_network_local_filesystem_backend() {
            env.push(("AGENTVIS_FILESYSTEM_ACCESS", "local"));
            env.push(("AGENTVIS_NETWORK_GUARD", "broker-preferred"));
        }
        if self.network_isolation_from_backend(backend)
            == SandboxNetworkIsolation::AppContainerDenyAll
        {
            env.push(("AGENTVIS_NETWORK_HARD_ISOLATION", "appcontainer-deny-all"));
        }

        match self.network {
            SandboxNetworkAccess::Inherit => {}
            SandboxNetworkAccess::Audit => {
                env.push(("AGENTVIS_NETWORK_ACCESS", "audit"));
            }
            SandboxNetworkAccess::Blocked => {
                env.extend(blocked_network_env_overrides());
            }
        }

        env
    }

    pub fn is_restricted(&self) -> bool {
        self.level == SandboxLevel::Restricted
    }

    pub fn uses_restricted_process_backend(&self) -> bool {
        self.uses_restricted_process_backend_from_switch(
            std::env::var(CONTROLLED_NETWORK_BACKEND_ENV)
                .ok()
                .as_deref(),
        )
    }

    fn uses_restricted_process_backend_for_backend(
        &self,
        _backend: RestrictedExecutionBackend,
    ) -> bool {
        self.uses_restricted_process_backend()
    }

    pub(super) fn uses_restricted_process_backend_from_switch(&self, switch: Option<&str>) -> bool {
        self.is_restricted()
            && !self.uses_controlled_network_local_filesystem_backend_from_switch(switch)
    }

    fn uses_controlled_network_local_filesystem_backend(&self) -> bool {
        self.uses_controlled_network_local_filesystem_backend_from_switch(
            std::env::var(CONTROLLED_NETWORK_BACKEND_ENV)
                .ok()
                .as_deref(),
        )
    }

    fn uses_controlled_network_local_filesystem_backend_from_switch(
        &self,
        switch: Option<&str>,
    ) -> bool {
        self.sandbox_mode == SandboxMode::ControlledNetwork
            && self.network != SandboxNetworkAccess::Blocked
            && self.controlled_network_backend_from_switch(switch)
                == ControlledNetworkBackend::LocalFilesystemBrokerPreferred
    }

    pub(super) fn controlled_network_backend_from_switch(
        &self,
        switch: Option<&str>,
    ) -> ControlledNetworkBackend {
        if self.sandbox_mode != SandboxMode::ControlledNetwork {
            return ControlledNetworkBackend::LegacyAppContainerDirect;
        }
        ControlledNetworkBackend::parse_switch(switch)
    }

    pub fn sandbox_mode(&self) -> SandboxMode {
        self.sandbox_mode
    }

    pub fn uses_broker_preferred_network_guard(&self) -> bool {
        self.uses_controlled_network_local_filesystem_backend()
            && self.network == SandboxNetworkAccess::Audit
            && self.network_scope == SandboxNetworkScope::InternetAudit
    }

    pub fn sandbox_mode_event_value(&self) -> &'static str {
        self.sandbox_mode.as_event_value()
    }

    pub fn process_lifecycle(&self) -> ProcessLifecycle {
        self.process_lifecycle
    }

    pub fn should_prepend_default_venv_path(&self) -> bool {
        !matches!(self.subject_type, SandboxSubjectType::Installer)
    }

    pub fn network_broker_audit_subject(&self) -> NetworkBrokerAuditSubject {
        match self.subject_type {
            SandboxSubjectType::Skill => {
                NetworkBrokerAuditSubject::external_skill(self.subject_id.clone())
            }
            SandboxSubjectType::Tool => NetworkBrokerAuditSubject::native_tool(
                self.subject_id.as_deref().unwrap_or("network_broker"),
            ),
            SandboxSubjectType::Installer => NetworkBrokerAuditSubject::sourced(
                "installer",
                SandboxSubjectType::Installer,
                self.subject_id.clone(),
                SandboxLevel::Installer,
            ),
            SandboxSubjectType::Preview => NetworkBrokerAuditSubject::sourced(
                "preview",
                SandboxSubjectType::Preview,
                self.subject_id.clone(),
                SandboxLevel::Preview,
            ),
            SandboxSubjectType::Command
            | SandboxSubjectType::Process
            | SandboxSubjectType::WfpSession => {
                NetworkBrokerAuditSubject::command(self.subject_id.clone())
            }
        }
    }

    pub fn blocks_detached_launch(&self) -> bool {
        self.process_lifecycle == ProcessLifecycle::DetachedLaunch
            && matches!(
                self.sandbox_mode,
                SandboxMode::OfflineIsolated | SandboxMode::ControlledNetwork
            )
    }

    pub fn blocked_desktop_interaction(
        &self,
        command: &str,
        workdir: Option<&str>,
    ) -> Option<String> {
        if !matches!(
            self.sandbox_mode,
            SandboxMode::OfflineIsolated | SandboxMode::ControlledNetwork
        ) {
            return None;
        }
        detect_desktop_interaction(command, workdir)
    }

    pub fn allows_workdir_fallback(&self) -> bool {
        !self.uses_restricted_process_backend()
    }

    pub fn process_profile(&self) -> ProcessSandboxProfile {
        if self.process_lifecycle == ProcessLifecycle::DetachedLaunch {
            return ProcessSandboxProfile::Detached;
        }
        if self.uses_restricted_process_backend() {
            ProcessSandboxProfile::Restricted
        } else {
            ProcessSandboxProfile::Standard
        }
    }

    pub fn network_isolation(&self) -> SandboxNetworkIsolation {
        self.network_isolation_from_backend(self.restricted_execution_backend())
    }

    pub fn appcontainer_network_capabilities(&self) -> Vec<AppContainerNetworkCapability> {
        if !self.uses_restricted_process_backend() {
            return Vec::new();
        }

        self.appcontainer_network_capabilities_for_restricted_backend()
    }

    pub(super) fn appcontainer_network_capabilities_for_restricted_backend(
        &self,
    ) -> Vec<AppContainerNetworkCapability> {
        // Only restricted backends use AppContainer capabilities. The default
        // ControlledNetwork audit path now stays in the host filesystem and marks
        // network as broker-preferred; blocked/brokerOnly paths still land here.
        match self.network_scope {
            SandboxNetworkScope::Inherit | SandboxNetworkScope::Blocked => Vec::new(),
            SandboxNetworkScope::Lan => {
                vec![AppContainerNetworkCapability::PrivateNetworkClientServer]
            }
            SandboxNetworkScope::InternetAudit => vec![
                AppContainerNetworkCapability::InternetClient,
                AppContainerNetworkCapability::PrivateNetworkClientServer,
            ],
        }
    }

    pub(super) fn network_isolation_from_backend(
        &self,
        backend: RestrictedExecutionBackend,
    ) -> SandboxNetworkIsolation {
        if self.uses_restricted_process_backend_for_backend(backend)
            && backend == RestrictedExecutionBackend::AppContainerFilesystem
        {
            if self.appcontainer_network_capabilities().is_empty() {
                return SandboxNetworkIsolation::AppContainerDenyAll;
            }
            return SandboxNetworkIsolation::AuditOnly;
        }

        match self.network {
            SandboxNetworkAccess::Inherit => SandboxNetworkIsolation::Inherit,
            SandboxNetworkAccess::Audit => SandboxNetworkIsolation::AuditOnly,
            SandboxNetworkAccess::Blocked => SandboxNetworkIsolation::SoftBlocked,
        }
    }

    pub fn restricted_execution_backend(&self) -> RestrictedExecutionBackend {
        let switch = std::env::var(RESTRICTED_EXECUTION_BACKEND_ENV).ok();
        self.restricted_execution_backend_from_switch(switch.as_deref())
    }

    pub(super) fn restricted_execution_backend_from_switch(
        &self,
        switch: Option<&str>,
    ) -> RestrictedExecutionBackend {
        if !self.is_restricted() {
            return RestrictedExecutionBackend::RestrictedToken;
        }

        match switch.map(|value| value.trim().to_ascii_lowercase()) {
            Some(value)
                if matches!(
                    value.as_str(),
                    "appcontainer" | "appcontainer-filesystem" | "filesystem" | "phase2e"
                ) =>
            {
                RestrictedExecutionBackend::AppContainerFilesystem
            }
            Some(value)
                if matches!(
                    value.as_str(),
                    "restricted-token" | "restrictedtoken" | "token" | "phase2c"
                ) =>
            {
                RestrictedExecutionBackend::RestrictedToken
            }
            _ => RestrictedExecutionBackend::AppContainerFilesystem,
        }
    }
}

impl ProcessLifecycle {
    fn infer(background: bool, command: &str) -> Self {
        if background {
            return Self::BackgroundManaged;
        }
        if looks_like_detached_launch_command(command) {
            return Self::DetachedLaunch;
        }
        Self::Managed
    }
}

fn blocked_network_env_overrides() -> Vec<(&'static str, &'static str)> {
    const DEAD_PROXY: &str = "http://127.0.0.1:9";
    vec![
        ("AGENTVIS_NETWORK_ACCESS", "blocked"),
        ("HTTP_PROXY", DEAD_PROXY),
        ("HTTPS_PROXY", DEAD_PROXY),
        ("ALL_PROXY", DEAD_PROXY),
        ("http_proxy", DEAD_PROXY),
        ("https_proxy", DEAD_PROXY),
        ("all_proxy", DEAD_PROXY),
        ("NO_PROXY", ""),
        ("no_proxy", ""),
        ("PIP_NO_INDEX", "1"),
        ("NPM_CONFIG_OFFLINE", "true"),
    ]
}
