//! 沙箱审计事件存储、查询和通用审计工具。

use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex, OnceLock,
};

use serde::{Deserialize, Serialize};
use sqlx::{Pool, QueryBuilder, Sqlite};
use tauri::Emitter;

const SANDBOX_AUDIT_EVENT_NAME: &str = "agentvis://sandbox-audit-event";
const SANDBOX_AUDIT_EVENT_LIMIT: usize = 200;
pub(crate) const SANDBOX_AUDIT_SCHEMA_VERSION: u16 = 1;
static SANDBOX_AUDIT_EVENTS: OnceLock<Mutex<VecDeque<SandboxAuditEvent>>> = OnceLock::new();
static SANDBOX_AUDIT_EVENT_COUNTER: AtomicU64 = AtomicU64::new(1);
static SANDBOX_AUDIT_DB_POOL: OnceLock<Pool<Sqlite>> = OnceLock::new();

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SandboxAuditEvent {
    pub schema_version: u16,
    pub id: String,
    pub timestamp: i64,
    pub timestamp_iso: String,
    pub execution_id: Option<String>,
    pub source: String,
    pub subject_type: String,
    pub subject_id: Option<String>,
    pub command_hash: String,
    pub profile: String,
    pub sandbox_mode: String,
    pub process_lifecycle: String,
    pub network_policy: String,
    pub network_scope: String,
    pub backend: String,
    pub decision: String,
    pub reason: String,
    pub matched_pattern: Option<String>,
    pub risk_class: Option<String>,
    pub risk_kind: Option<String>,
    pub credential_context: Option<String>,
    pub workdir: Option<String>,
    pub cleanup: Option<String>,
    pub target_host: Option<String>,
    pub target_scheme: Option<String>,
    pub target_port: Option<u16>,
    pub network_protocol: Option<String>,
    pub guard_mode: Option<String>,
    pub request_method: Option<String>,
    pub url_hash: Option<String>,
    pub status_code: Option<u16>,
    pub bytes_in: Option<u64>,
    pub bytes_out: Option<u64>,
    pub duration_ms: Option<u64>,
    pub blocked_reason: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SandboxAuditEventQuery {
    pub limit: usize,
    pub offset: usize,
    pub since_timestamp: Option<i64>,
    pub decision: Option<String>,
    pub backend: Option<String>,
    pub source: Option<String>,
    pub reason: Option<String>,
    pub guard_mode: Option<String>,
    pub target_host: Option<String>,
    pub subject_id: Option<String>,
}

pub fn set_sandbox_audit_db_pool(pool: Pool<Sqlite>) {
    if SANDBOX_AUDIT_DB_POOL.set(pool).is_err() {
        log::debug!("[Sandbox] sandbox audit database pool was already initialized");
    }
}

fn sandbox_audit_events() -> &'static Mutex<VecDeque<SandboxAuditEvent>> {
    SANDBOX_AUDIT_EVENTS.get_or_init(|| Mutex::new(VecDeque::new()))
}

pub fn record_sandbox_audit_event(app_handle: &tauri::AppHandle, event: SandboxAuditEvent) {
    if let Ok(mut events) = sandbox_audit_events().lock() {
        events.push_back(event.clone());
        while events.len() > SANDBOX_AUDIT_EVENT_LIMIT {
            events.pop_front();
        }
    } else {
        log::warn!("[Sandbox] failed to lock sandbox audit event store");
    }

    persist_sandbox_audit_event(event.clone());

    if let Err(error) = app_handle.emit(SANDBOX_AUDIT_EVENT_NAME, &event) {
        log::debug!("[Sandbox] failed to emit sandbox audit event: {}", error);
    }
}

pub fn list_sandbox_audit_events() -> Vec<SandboxAuditEvent> {
    sandbox_audit_events()
        .lock()
        .map(|events| events.iter().cloned().collect())
        .unwrap_or_default()
}

pub async fn list_persisted_sandbox_audit_events(
    query: SandboxAuditEventQuery,
) -> Vec<SandboxAuditEvent> {
    let Some(pool) = SANDBOX_AUDIT_DB_POOL.get().cloned() else {
        return filter_in_memory_sandbox_audit_events(&query);
    };
    let limit = query.limit.clamp(1, 1_000) as i64;
    let offset = query.offset.min(5_000) as i64;
    if query_requires_event_json_filter(&query) {
        return list_persisted_sandbox_audit_events_with_post_filter(
            pool,
            &query,
            limit as usize,
            offset as usize,
        )
        .await;
    }
    let mut builder = QueryBuilder::<Sqlite>::new(
        r#"
        SELECT event_json
        FROM sandbox_audit_events
        "#,
    );
    push_sandbox_audit_query_filters(&mut builder, &query);
    builder.push(" ORDER BY timestamp DESC LIMIT ");
    builder.push_bind(limit);
    builder.push(" OFFSET ");
    builder.push_bind(offset);
    let rows = builder.build_query_as::<(String,)>().fetch_all(&pool).await;

    match rows {
        Ok(rows) => rows
            .into_iter()
            .filter_map(|(event_json,)| {
                match serde_json::from_str::<SandboxAuditEvent>(&event_json) {
                    Ok(event) => Some(event),
                    Err(error) => {
                        log::debug!("[Sandbox] failed to parse persisted audit event: {}", error);
                        None
                    }
                }
            })
            .collect(),
        Err(error) => {
            log::warn!("[Sandbox] failed to load persisted audit events: {}", error);
            filter_in_memory_sandbox_audit_events(&query)
        }
    }
}

async fn list_persisted_sandbox_audit_events_with_post_filter(
    pool: Pool<Sqlite>,
    query: &SandboxAuditEventQuery,
    limit: usize,
    offset: usize,
) -> Vec<SandboxAuditEvent> {
    let mut builder = QueryBuilder::<Sqlite>::new(
        r#"
        SELECT event_json
        FROM sandbox_audit_events
        "#,
    );
    push_sandbox_audit_query_filters(&mut builder, query);
    builder.push(" ORDER BY timestamp DESC LIMIT ");
    builder.push_bind(5_000_i64);
    let rows = builder.build_query_as::<(String,)>().fetch_all(&pool).await;

    match rows {
        Ok(rows) => rows
            .into_iter()
            .filter_map(|(event_json,)| {
                match serde_json::from_str::<SandboxAuditEvent>(&event_json) {
                    Ok(event) => Some(event),
                    Err(error) => {
                        log::debug!("[Sandbox] failed to parse persisted audit event: {}", error);
                        None
                    }
                }
            })
            .filter(|event| sandbox_audit_event_matches_query(event, query))
            .skip(offset)
            .take(limit)
            .collect(),
        Err(error) => {
            log::warn!("[Sandbox] failed to load persisted audit events: {}", error);
            filter_in_memory_sandbox_audit_events(query)
        }
    }
}

fn query_requires_event_json_filter(query: &SandboxAuditEventQuery) -> bool {
    normalized_filter_value(query.reason.as_deref()).is_some()
        || normalized_filter_value(query.guard_mode.as_deref()).is_some()
}

fn push_sandbox_audit_query_filters(
    builder: &mut QueryBuilder<'_, Sqlite>,
    query: &SandboxAuditEventQuery,
) {
    let mut has_where = false;
    push_optional_exact_filter(
        builder,
        &mut has_where,
        "decision",
        query.decision.as_deref(),
    );
    push_optional_exact_filter(builder, &mut has_where, "backend", query.backend.as_deref());
    push_optional_exact_filter(builder, &mut has_where, "source", query.source.as_deref());
    push_optional_exact_filter(
        builder,
        &mut has_where,
        "subject_id",
        query.subject_id.as_deref(),
    );
    if let Some(since_timestamp) = query.since_timestamp {
        push_where_or_and(builder, &mut has_where);
        builder.push("timestamp >= ");
        builder.push_bind(since_timestamp);
    }
    if let Some(target_host) = normalized_filter_value(query.target_host.as_deref()) {
        push_where_or_and(builder, &mut has_where);
        builder.push("LOWER(target_host) LIKE ");
        builder.push_bind(format!("%{}%", target_host.to_ascii_lowercase()));
    }
}

fn push_optional_exact_filter(
    builder: &mut QueryBuilder<'_, Sqlite>,
    has_where: &mut bool,
    column: &'static str,
    value: Option<&str>,
) {
    if let Some(value) = normalized_filter_value(value) {
        push_where_or_and(builder, has_where);
        builder.push(column);
        builder.push(" = ");
        builder.push_bind(value);
    }
}

fn push_where_or_and(builder: &mut QueryBuilder<'_, Sqlite>, has_where: &mut bool) {
    if *has_where {
        builder.push(" AND ");
    } else {
        builder.push(" WHERE ");
        *has_where = true;
    }
}

fn normalized_filter_value(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("all"))
        .map(ToString::to_string)
}

fn filter_in_memory_sandbox_audit_events(query: &SandboxAuditEventQuery) -> Vec<SandboxAuditEvent> {
    list_sandbox_audit_events()
        .into_iter()
        .filter(|event| sandbox_audit_event_matches_query(event, query))
        .skip(query.offset)
        .take(query.limit.clamp(1, 1_000))
        .collect()
}

fn sandbox_audit_event_matches_query(
    event: &SandboxAuditEvent,
    query: &SandboxAuditEventQuery,
) -> bool {
    if let Some(decision) = normalized_filter_value(query.decision.as_deref()) {
        if event.decision != decision {
            return false;
        }
    }
    if let Some(backend) = normalized_filter_value(query.backend.as_deref()) {
        if event.backend != backend {
            return false;
        }
    }
    if let Some(source) = normalized_filter_value(query.source.as_deref()) {
        if event.source != source {
            return false;
        }
    }
    if let Some(reason) = normalized_filter_value(query.reason.as_deref()) {
        if event.reason != reason {
            return false;
        }
    }
    if let Some(guard_mode) = normalized_filter_value(query.guard_mode.as_deref()) {
        if event.guard_mode.as_deref() != Some(guard_mode.as_str()) {
            return false;
        }
    }
    if let Some(subject_id) = normalized_filter_value(query.subject_id.as_deref()) {
        if event.subject_id.as_deref() != Some(subject_id.as_str()) {
            return false;
        }
    }
    if let Some(since_timestamp) = query.since_timestamp {
        if event.timestamp < since_timestamp {
            return false;
        }
    }
    if let Some(target_host) = normalized_filter_value(query.target_host.as_deref()) {
        let target_host = target_host.to_ascii_lowercase();
        if !event
            .target_host
            .as_deref()
            .is_some_and(|host| host.to_ascii_lowercase().contains(&target_host))
        {
            return false;
        }
    }
    true
}

fn persist_sandbox_audit_event(event: SandboxAuditEvent) {
    let Some(pool) = SANDBOX_AUDIT_DB_POOL.get().cloned() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        if let Err(error) = insert_sandbox_audit_event(pool, event).await {
            log::warn!("[Sandbox] failed to persist sandbox audit event: {}", error);
        }
    });
}

async fn insert_sandbox_audit_event(
    pool: Pool<Sqlite>,
    event: SandboxAuditEvent,
) -> Result<(), sqlx::Error> {
    let event_json = match serde_json::to_string(&event) {
        Ok(event_json) => event_json,
        Err(error) => {
            log::warn!(
                "[Sandbox] failed to serialize sandbox audit event: {}",
                error
            );
            return Ok(());
        }
    };

    sqlx::query(
        r#"
        INSERT OR REPLACE INTO sandbox_audit_events (
            id,
            timestamp,
            timestamp_iso,
            source,
            subject_type,
            subject_id,
            sandbox_mode,
            network_policy,
            network_scope,
            backend,
            decision,
            target_host,
            target_scheme,
            request_method,
            status_code,
            blocked_reason,
            event_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&event.id)
    .bind(event.timestamp)
    .bind(&event.timestamp_iso)
    .bind(&event.source)
    .bind(&event.subject_type)
    .bind(&event.subject_id)
    .bind(&event.sandbox_mode)
    .bind(&event.network_policy)
    .bind(&event.network_scope)
    .bind(&event.backend)
    .bind(&event.decision)
    .bind(&event.target_host)
    .bind(&event.target_scheme)
    .bind(&event.request_method)
    .bind(event.status_code.map(i64::from))
    .bind(&event.blocked_reason)
    .bind(event_json)
    .execute(&pool)
    .await?;

    sqlx::query(
        r#"
        DELETE FROM sandbox_audit_events
        WHERE id IN (
            SELECT id
            FROM sandbox_audit_events
            ORDER BY timestamp DESC
            LIMIT -1 OFFSET 5000
        )
        "#,
    )
    .execute(&pool)
    .await?;

    Ok(())
}

pub(crate) fn stable_command_hash(command: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in command.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", hash)
}

pub(crate) fn next_sandbox_audit_event_id(timestamp: i64) -> String {
    let sequence = SANDBOX_AUDIT_EVENT_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("sandbox-audit-{}-{}", timestamp, sequence)
}

pub(crate) fn redacted_network_audit_target(raw_url: &str) -> String {
    let Ok(url) = reqwest::Url::parse(raw_url) else {
        return raw_url.split('?').next().unwrap_or(raw_url).to_string();
    };
    let Some(host) = url.host_str() else {
        return format!("{}://<no-host>", url.scheme());
    };
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    match url.port() {
        Some(port) => format!("{}://{}:{}", url.scheme(), host, port),
        None => format!("{}://{}", url.scheme(), host),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn audit_event(timestamp: i64) -> SandboxAuditEvent {
        SandboxAuditEvent {
            schema_version: SANDBOX_AUDIT_SCHEMA_VERSION,
            id: format!("sandbox-audit-{timestamp}-1"),
            timestamp,
            timestamp_iso: "2026-05-26T00:00:00Z".to_string(),
            execution_id: Some("exec-1".to_string()),
            source: "exec".to_string(),
            subject_type: "command".to_string(),
            subject_id: Some("agent-1".to_string()),
            command_hash: "hash".to_string(),
            profile: "restricted".to_string(),
            sandbox_mode: "ControlledNetwork".to_string(),
            process_lifecycle: "managed".to_string(),
            network_policy: "audit".to_string(),
            network_scope: "internetAudit".to_string(),
            backend: "broker".to_string(),
            decision: "audit".to_string(),
            reason: "broker_network_request".to_string(),
            matched_pattern: None,
            risk_class: None,
            risk_kind: None,
            credential_context: None,
            workdir: None,
            cleanup: None,
            target_host: Some("example.com".to_string()),
            target_scheme: Some("https".to_string()),
            target_port: None,
            network_protocol: Some("https".to_string()),
            guard_mode: Some("auditOnly".to_string()),
            request_method: Some("CONNECT".to_string()),
            url_hash: Some("hash".to_string()),
            status_code: Some(200),
            bytes_in: Some(10),
            bytes_out: Some(5),
            duration_ms: Some(12),
            blocked_reason: None,
        }
    }

    #[test]
    fn sandbox_audit_query_matches_since_timestamp() {
        let query = SandboxAuditEventQuery {
            limit: 10,
            offset: 0,
            since_timestamp: Some(2000),
            ..Default::default()
        };

        assert!(!sandbox_audit_event_matches_query(
            &audit_event(1999),
            &query
        ));
        assert!(sandbox_audit_event_matches_query(
            &audit_event(2000),
            &query
        ));
    }

    #[test]
    fn sandbox_audit_query_matches_reason_and_guard_mode() {
        let query = SandboxAuditEventQuery {
            limit: 10,
            offset: 0,
            reason: Some("broker_network_request".to_string()),
            guard_mode: Some("auditOnly".to_string()),
            ..Default::default()
        };

        assert!(sandbox_audit_event_matches_query(
            &audit_event(2000),
            &query
        ));

        let mut blocked_event = audit_event(2001);
        blocked_event.reason = "proxy_bypass_signal_blocked".to_string();
        blocked_event.guard_mode = Some("hardBlock".to_string());
        assert!(!sandbox_audit_event_matches_query(
            &blocked_event,
            &query
        ));
    }
}
