//! 沙箱策略、网络与平台后端共享的基础类型定义。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxLevel {
    Standard,
    ExternalSkill,
    Installer,
    Preview,
    Restricted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxNetworkAccess {
    Inherit,
    Audit,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxMode {
    LocalAudit,
    OfflineIsolated,
    ControlledNetwork,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxNetworkScope {
    Inherit,
    Blocked,
    Lan,
    InternetAudit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessLifecycle {
    Managed,
    DetachedLaunch,
    BackgroundManaged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessSandboxProfile {
    Detached,
    Standard,
    Restricted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestrictedExecutionBackend {
    RestrictedToken,
    AppContainerFilesystem,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ControlledNetworkBackend {
    LegacyAppContainerDirect,
    LocalFilesystemBrokerPreferred,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxNetworkIsolation {
    Inherit,
    AuditOnly,
    SoftBlocked,
    AppContainerDenyAll,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestrictedTokenProbeResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub output: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppContainerFilesystemAccess {
    ReadExecute,
    ReadWrite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppContainerNetworkCapability {
    InternetClient,
    PrivateNetworkClientServer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppContainerFilesystemGrant {
    pub path: PathBuf,
    pub access: AppContainerFilesystemAccess,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppContainerFilesystemProfileResult {
    pub profile_name: String,
    pub sid_string: String,
    pub created_profile: bool,
    pub granted_paths: Vec<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxSubjectType {
    Command,
    Skill,
    Tool,
    Preview,
    Installer,
    Process,
    WfpSession,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDirectAllowance {
    pub id: String,
    pub subject_type: String,
    pub subject_id: Option<String>,
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub scope: String,
    pub expires_at: Option<i64>,
    pub created_at: i64,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NetworkDirectTarget {
    pub protocol: String,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NetworkProxyBypassSignal {
    pub kind: &'static str,
    pub pattern: String,
}

impl NetworkProxyBypassSignal {
    pub(crate) fn audit_detail(&self) -> String {
        format!("{}={}", self.kind, self.pattern)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NetworkUploadRiskSignal {
    pub kind: &'static str,
    pub pattern: String,
}

impl NetworkUploadRiskSignal {
    pub(crate) fn audit_detail(&self) -> String {
        format!("{}={}", self.kind, self.pattern)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NetworkRiskSignal {
    pub risk_class: &'static str,
    pub kind: &'static str,
    pub pattern: String,
}

impl NetworkRiskSignal {
    pub(crate) fn audit_detail(&self) -> String {
        format!(
            "riskClass={}; riskKind={}; pattern={}",
            self.risk_class, self.kind, self.pattern
        )
    }
}

impl NetworkDirectTarget {
    pub(crate) fn new(
        protocol: impl Into<String>,
        host: impl Into<String>,
        port: u16,
    ) -> Option<Self> {
        let protocol = protocol.into().trim().to_ascii_lowercase();
        let host = normalize_direct_target_host(&host.into())?;
        Some(Self {
            protocol,
            host,
            port,
        })
    }

    pub fn audit_detail(&self) -> String {
        format!("{}://{}:{}", self.protocol, self.host, self.port)
    }
}

pub(crate) fn normalize_direct_target_host(host: &str) -> Option<String> {
    let host = host
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim_matches('[')
        .trim_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

impl ProcessSandboxProfile {
    pub(super) fn requires_job_object(self) -> bool {
        self == ProcessSandboxProfile::Restricted
    }

    pub(super) fn is_restricted(self) -> bool {
        self == ProcessSandboxProfile::Restricted
    }

    pub(super) fn uses_job_object(self) -> bool {
        self != ProcessSandboxProfile::Detached
    }
}

impl SandboxMode {
    pub(super) fn parse(value: &str) -> Result<Self, AppError> {
        match value.trim() {
            "" | "LocalAudit" | "localAudit" | "local" => Ok(Self::LocalAudit),
            "OfflineIsolated" | "offlineIsolated" | "isolated" => Ok(Self::OfflineIsolated),
            "ControlledNetwork" | "controlledNetwork" | "controlled_network"
            | "controlled-network" | "networkedIsolated" | "networked_isolated"
            | "networked-isolated" => Ok(Self::ControlledNetwork),
            other => Err(AppError::Forbidden(format!(
                "Unknown sandbox mode '{}'",
                other
            ))),
        }
    }

    pub(super) fn as_event_value(self) -> &'static str {
        match self {
            Self::LocalAudit => "LocalAudit",
            Self::OfflineIsolated => "OfflineIsolated",
            Self::ControlledNetwork => "ControlledNetwork",
        }
    }
}

impl SandboxNetworkScope {
    pub(super) fn parse(value: &str) -> Result<Self, AppError> {
        match value.trim() {
            "" | "inherit" => Ok(Self::Inherit),
            "blocked" | "block" | "none" => Ok(Self::Blocked),
            "lan" | "localNetwork" | "local-network" => Ok(Self::Lan),
            "internetAudit" | "internet_audit" | "internet-audit" | "audit" => {
                Ok(Self::InternetAudit)
            }
            other => Err(AppError::Forbidden(format!(
                "Unknown sandbox network scope '{}'",
                other
            ))),
        }
    }

    pub(super) fn from_network_access(network: SandboxNetworkAccess) -> Self {
        match network {
            SandboxNetworkAccess::Inherit => Self::Inherit,
            SandboxNetworkAccess::Audit => Self::InternetAudit,
            SandboxNetworkAccess::Blocked => Self::Blocked,
        }
    }

    pub(super) fn as_network_access(self) -> SandboxNetworkAccess {
        match self {
            Self::Inherit => SandboxNetworkAccess::Inherit,
            Self::Blocked => SandboxNetworkAccess::Blocked,
            Self::Lan | Self::InternetAudit => SandboxNetworkAccess::Audit,
        }
    }

    pub(super) fn as_event_value(self) -> &'static str {
        match self {
            Self::Inherit => "inherit",
            Self::Blocked => "blocked",
            Self::Lan => "lan",
            Self::InternetAudit => "internetAudit",
        }
    }
}

impl ProcessLifecycle {
    pub(super) fn parse(value: &str) -> Result<Self, AppError> {
        match value.trim() {
            "" | "managed" => Ok(Self::Managed),
            "detachedLaunch" | "detached_launch" | "detached-launch" | "detached" => {
                Ok(Self::DetachedLaunch)
            }
            "backgroundManaged" | "background_managed" | "background-managed" => {
                Ok(Self::BackgroundManaged)
            }
            other => Err(AppError::Forbidden(format!(
                "Unknown process lifecycle '{}'",
                other
            ))),
        }
    }

    pub fn as_event_value(self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::DetachedLaunch => "detachedLaunch",
            Self::BackgroundManaged => "backgroundManaged",
        }
    }
}

impl SandboxSubjectType {
    pub(super) fn parse(value: &str) -> Result<Self, AppError> {
        match value.trim() {
            "" | "command" => Ok(Self::Command),
            "skill" => Ok(Self::Skill),
            "tool" => Ok(Self::Tool),
            "preview" => Ok(Self::Preview),
            "installer" => Ok(Self::Installer),
            "process" => Ok(Self::Process),
            "wfpSession" | "wfp_session" | "wfp-session" => Ok(Self::WfpSession),
            other => Err(AppError::Forbidden(format!(
                "Unknown sandbox subject type '{}'",
                other
            ))),
        }
    }

    pub(super) fn as_event_value(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Skill => "skill",
            Self::Tool => "tool",
            Self::Preview => "preview",
            Self::Installer => "installer",
            Self::Process => "process",
            Self::WfpSession => "wfpSession",
        }
    }
}

impl ControlledNetworkBackend {
    pub(super) fn parse_switch(value: Option<&str>) -> Self {
        match value.map(|raw| raw.trim().to_ascii_lowercase()) {
            Some(value)
                if matches!(
                    value.as_str(),
                    "local-broker"
                        | "local_broker"
                        | "localbroker"
                        | "broker-preferred"
                        | "broker_preferred"
                        | "brokerpreferred"
                        | "local-filesystem-broker-preferred"
                        | "local_filesystem_broker_preferred"
                ) =>
            {
                Self::LocalFilesystemBrokerPreferred
            }
            Some(value)
                if matches!(
                    value.as_str(),
                    "legacy"
                        | "legacy-appcontainer"
                        | "legacy_appcontainer"
                        | "appcontainer-direct"
                        | "appcontainer_direct"
                ) =>
            {
                Self::LegacyAppContainerDirect
            }
            _ => Self::LocalFilesystemBrokerPreferred,
        }
    }
}

impl SandboxLevel {
    pub(super) fn as_env_value(self) -> &'static str {
        match self {
            SandboxLevel::Standard => "standard",
            SandboxLevel::ExternalSkill => "externalSkill",
            SandboxLevel::Installer => "installer",
            SandboxLevel::Preview => "preview",
            SandboxLevel::Restricted => "restricted",
        }
    }

    pub(super) fn as_audit_source(self) -> &'static str {
        match self {
            SandboxLevel::Standard | SandboxLevel::Restricted => "exec",
            SandboxLevel::ExternalSkill => "externalSkill",
            SandboxLevel::Installer => "installer",
            SandboxLevel::Preview => "preview",
        }
    }

    pub(super) fn default_subject_type(self) -> SandboxSubjectType {
        match self {
            SandboxLevel::ExternalSkill => SandboxSubjectType::Skill,
            SandboxLevel::Installer => SandboxSubjectType::Installer,
            SandboxLevel::Preview => SandboxSubjectType::Preview,
            SandboxLevel::Standard | SandboxLevel::Restricted => SandboxSubjectType::Command,
        }
    }
}

impl SandboxNetworkAccess {
    pub(super) fn as_event_value(self) -> &'static str {
        match self {
            SandboxNetworkAccess::Inherit => "inherit",
            SandboxNetworkAccess::Audit => "audit",
            SandboxNetworkAccess::Blocked => "blocked",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_mode_parses_legacy_aliases() {
        assert_eq!(
            SandboxMode::parse("LocalAudit").unwrap(),
            SandboxMode::LocalAudit
        );
        assert_eq!(
            SandboxMode::parse("local").unwrap(),
            SandboxMode::LocalAudit
        );
        assert_eq!(
            SandboxMode::parse("isolated").unwrap(),
            SandboxMode::OfflineIsolated
        );
        assert_eq!(
            SandboxMode::parse("networkedIsolated").unwrap(),
            SandboxMode::ControlledNetwork
        );
        assert_eq!(
            SandboxMode::parse("controlled-network").unwrap(),
            SandboxMode::ControlledNetwork
        );
        assert_eq!(
            SandboxMode::ControlledNetwork.as_event_value(),
            "ControlledNetwork"
        );
    }

    #[test]
    fn network_scope_maps_to_network_access() {
        assert_eq!(
            SandboxNetworkScope::from_network_access(SandboxNetworkAccess::Audit),
            SandboxNetworkScope::InternetAudit
        );
        assert_eq!(
            SandboxNetworkScope::Lan.as_network_access(),
            SandboxNetworkAccess::Audit
        );
    }

    #[test]
    fn process_profile_job_policy_stays_stable() {
        assert!(!ProcessSandboxProfile::Detached.uses_job_object());
        assert!(ProcessSandboxProfile::Restricted.requires_job_object());
        assert!(ProcessSandboxProfile::Restricted.is_restricted());
    }
}
