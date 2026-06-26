//! Broker 与主进程网络请求的沙箱审计事件构造。

use chrono::Utc;

use super::audit::{
    next_sandbox_audit_event_id, redacted_network_audit_target, stable_command_hash,
    SandboxAuditEvent, SANDBOX_AUDIT_SCHEMA_VERSION,
};
use super::{
    ProcessLifecycle, SandboxLevel, SandboxMode, SandboxNetworkAccess, SandboxNetworkScope,
    SandboxSubjectType,
};
use crate::error::AppError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkBrokerAuditDetails {
    pub method: String,
    pub url: String,
    pub target_host: Option<String>,
    pub target_scheme: Option<String>,
    pub detail: Option<String>,
    pub status_code: Option<u16>,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub duration_ms: u64,
    pub blocked_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkBrokerAuditSubject {
    pub source: String,
    pub subject_type: SandboxSubjectType,
    pub subject_id: Option<String>,
    pub profile: SandboxLevel,
    pub execution_id: Option<String>,
}

impl NetworkBrokerAuditSubject {
    pub fn native_tool(tool_name: &str) -> Self {
        Self {
            source: "nativeTool".to_string(),
            subject_type: SandboxSubjectType::Tool,
            subject_id: Some(tool_name.to_string()),
            profile: SandboxLevel::Standard,
            execution_id: None,
        }
    }

    pub fn external_skill(skill_id: Option<String>) -> Self {
        Self {
            source: "externalSkill".to_string(),
            subject_type: SandboxSubjectType::Skill,
            subject_id: skill_id,
            profile: SandboxLevel::ExternalSkill,
            execution_id: None,
        }
    }

    pub fn command(command_id: Option<String>) -> Self {
        Self {
            source: "exec".to_string(),
            subject_type: SandboxSubjectType::Command,
            subject_id: command_id,
            profile: SandboxLevel::Standard,
            execution_id: None,
        }
    }

    pub fn sourced(
        source: &str,
        subject_type: SandboxSubjectType,
        subject_id: Option<String>,
        profile: SandboxLevel,
    ) -> Self {
        Self {
            source: source.to_string(),
            subject_type,
            subject_id,
            profile,
            execution_id: None,
        }
    }

    pub fn with_execution_id(mut self, execution_id: Option<&str>) -> Self {
        self.execution_id = execution_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        self
    }

    pub fn from_invocation(
        subject_type: Option<&str>,
        subject_id: Option<String>,
    ) -> Result<Self, AppError> {
        let normalized_subject_id = subject_id.and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        });

        match subject_type
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            None | Some("tool") => Ok(Self::native_tool(
                normalized_subject_id.as_deref().unwrap_or("network_broker"),
            )),
            Some("skill") => Ok(Self::external_skill(normalized_subject_id)),
            Some("command") => Ok(Self::command(normalized_subject_id)),
            Some(other) => Err(AppError::Forbidden(format!(
                "Unknown network broker subject type '{}'",
                other
            ))),
        }
    }
}

pub fn network_broker_audit_event(
    tool_name: &str,
    sandbox_mode: Option<&str>,
    details: NetworkBrokerAuditDetails,
) -> Result<Option<SandboxAuditEvent>, AppError> {
    network_broker_subject_audit_event(
        NetworkBrokerAuditSubject::native_tool(tool_name),
        sandbox_mode,
        details,
    )
}

pub fn network_broker_subject_audit_event(
    subject: NetworkBrokerAuditSubject,
    sandbox_mode: Option<&str>,
    details: NetworkBrokerAuditDetails,
) -> Result<Option<SandboxAuditEvent>, AppError> {
    let mode = sandbox_mode
        .map(SandboxMode::parse)
        .transpose()?
        .unwrap_or(SandboxMode::LocalAudit);

    if mode != SandboxMode::ControlledNetwork {
        return Ok(None);
    }

    let blocked = details.blocked_reason.is_some();
    let redacted_url = redacted_network_audit_target(&details.url);
    let matched_pattern = details
        .detail
        .filter(|detail| !detail.trim().is_empty())
        .unwrap_or_else(|| redacted_url.clone());
    let now = Utc::now();
    let timestamp = now.timestamp_millis();
    Ok(Some(SandboxAuditEvent {
        schema_version: SANDBOX_AUDIT_SCHEMA_VERSION,
        id: next_sandbox_audit_event_id(timestamp),
        timestamp,
        timestamp_iso: now.to_rfc3339(),
        execution_id: subject.execution_id.clone(),
        source: subject.source,
        subject_type: subject.subject_type.as_event_value().to_string(),
        subject_id: subject.subject_id.clone(),
        command_hash: stable_command_hash(&format!(
            "{} {} {}",
            subject.subject_id.as_deref().unwrap_or("network_broker"),
            details.method,
            redacted_url
        )),
        profile: subject.profile.as_env_value().to_string(),
        sandbox_mode: mode.as_event_value().to_string(),
        process_lifecycle: ProcessLifecycle::Managed.as_event_value().to_string(),
        network_policy: SandboxNetworkAccess::Audit.as_event_value().to_string(),
        network_scope: SandboxNetworkScope::InternetAudit
            .as_event_value()
            .to_string(),
        backend: "broker".to_string(),
        decision: if blocked { "block" } else { "audit" }.to_string(),
        reason: if blocked {
            "broker_network_block"
        } else {
            "broker_network_request"
        }
        .to_string(),
        matched_pattern: Some(matched_pattern),
        risk_class: None,
        risk_kind: None,
        credential_context: None,
        workdir: None,
        cleanup: None,
        target_host: details.target_host,
        target_scheme: details.target_scheme.clone(),
        target_port: None,
        network_protocol: details.target_scheme.clone(),
        guard_mode: Some(if blocked { "hardBlock" } else { "auditOnly" }.to_string()),
        request_method: Some(details.method),
        url_hash: Some(stable_command_hash(&redacted_url)),
        status_code: details.status_code,
        bytes_in: Some(details.bytes_in),
        bytes_out: Some(details.bytes_out),
        duration_ms: Some(details.duration_ms),
        blocked_reason: details.blocked_reason,
    }))
}

pub fn main_process_network_audit_event(
    tool_name: &str,
    sandbox_mode: Option<&str>,
    target: &str,
) -> Result<Option<SandboxAuditEvent>, AppError> {
    let mode = sandbox_mode
        .map(SandboxMode::parse)
        .transpose()?
        .unwrap_or(SandboxMode::LocalAudit);

    if mode != SandboxMode::ControlledNetwork {
        return Ok(None);
    }

    let now = Utc::now();
    let timestamp = now.timestamp_millis();
    Ok(Some(SandboxAuditEvent {
        schema_version: SANDBOX_AUDIT_SCHEMA_VERSION,
        id: next_sandbox_audit_event_id(timestamp),
        timestamp,
        timestamp_iso: now.to_rfc3339(),
        execution_id: None,
        source: "nativeTool".to_string(),
        subject_type: SandboxSubjectType::Tool.as_event_value().to_string(),
        subject_id: Some(tool_name.to_string()),
        command_hash: stable_command_hash(&format!("{} {}", tool_name, target)),
        profile: SandboxLevel::Standard.as_env_value().to_string(),
        sandbox_mode: mode.as_event_value().to_string(),
        process_lifecycle: ProcessLifecycle::Managed.as_event_value().to_string(),
        network_policy: SandboxNetworkAccess::Audit.as_event_value().to_string(),
        network_scope: SandboxNetworkScope::InternetAudit
            .as_event_value()
            .to_string(),
        backend: "mainProcess".to_string(),
        decision: "audit".to_string(),
        reason: "main_process_network_request".to_string(),
        matched_pattern: Some(target.to_string()),
        risk_class: None,
        risk_kind: None,
        credential_context: None,
        workdir: None,
        cleanup: None,
        target_host: None,
        target_scheme: None,
        target_port: None,
        network_protocol: None,
        guard_mode: Some("auditOnly".to_string()),
        request_method: None,
        url_hash: Some(stable_command_hash(target)),
        status_code: None,
        bytes_in: None,
        bytes_out: None,
        duration_ms: None,
        blocked_reason: None,
    }))
}
