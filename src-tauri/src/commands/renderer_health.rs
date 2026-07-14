//! Renderer health diagnostics.
//!
//! The renderer can freeze or be terminated before JavaScript crash handlers run.
//! This command records lightweight heartbeats so the Rust side can log missing
//! heartbeats and long main-thread stalls without touching app state.

use once_cell::sync::Lazy;
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const WATCHDOG_INTERVAL: Duration = Duration::from_secs(10);
const STALE_HEARTBEAT_THRESHOLD: Duration = Duration::from_secs(30);
const HEARTBEAT_GAP_WARN_THRESHOLD: Duration = Duration::from_secs(15);
const MAIN_THREAD_DRIFT_WARN_MS: u64 = 3_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererHeartbeatPayload {
    sequence: u64,
    url: Option<String>,
    visibility_state: Option<String>,
    stage: Option<String>,
    stage_age_ms: Option<u64>,
    stage_details: Option<String>,
    max_main_thread_drift_ms: Option<u64>,
    used_js_heap_size: Option<u64>,
    total_js_heap_size: Option<u64>,
    js_heap_size_limit: Option<u64>,
    timestamp_ms: Option<u64>,
}

#[derive(Debug, Default, Clone)]
struct RendererHealthSnapshot {
    sequence: u64,
    url: Option<String>,
    visibility_state: Option<String>,
    stage: Option<String>,
    stage_age_ms: Option<u64>,
    stage_details: Option<String>,
    max_main_thread_drift_ms: Option<u64>,
    used_js_heap_size: Option<u64>,
    total_js_heap_size: Option<u64>,
    js_heap_size_limit: Option<u64>,
    timestamp_ms: Option<u64>,
}

#[derive(Debug, Default)]
struct RendererHealthState {
    last_heartbeat_at: Option<Instant>,
    last_snapshot: Option<RendererHealthSnapshot>,
    last_stale_log_at: Option<Instant>,
}

static WATCHDOG_STARTED: AtomicBool = AtomicBool::new(false);
static RENDERER_HEALTH_STATE: Lazy<Mutex<RendererHealthState>> =
    Lazy::new(|| Mutex::new(RendererHealthState::default()));

fn snapshot_from_payload(payload: RendererHeartbeatPayload) -> RendererHealthSnapshot {
    RendererHealthSnapshot {
        sequence: payload.sequence,
        url: payload.url,
        visibility_state: payload.visibility_state,
        stage: payload.stage,
        stage_age_ms: payload.stage_age_ms,
        stage_details: payload.stage_details,
        max_main_thread_drift_ms: payload.max_main_thread_drift_ms,
        used_js_heap_size: payload.used_js_heap_size,
        total_js_heap_size: payload.total_js_heap_size,
        js_heap_size_limit: payload.js_heap_size_limit,
        timestamp_ms: payload.timestamp_ms,
    }
}

fn should_log_stale(now: Instant, last_log_at: Option<Instant>) -> bool {
    last_log_at
        .map(|logged_at| now.duration_since(logged_at) >= STALE_HEARTBEAT_THRESHOLD)
        .unwrap_or(true)
}

fn describe_snapshot(snapshot: Option<&RendererHealthSnapshot>) -> String {
    let Some(snapshot) = snapshot else {
        return "none".to_string();
    };

    format!(
        "seq={}, url={:?}, visibility={:?}, stage={:?}, stage_age_ms={:?}, stage_details={:?}, drift_ms={:?}, heap={:?}/{:?}/{:?}, timestamp_ms={:?}",
        snapshot.sequence,
        snapshot.url,
        snapshot.visibility_state,
        snapshot.stage,
        snapshot.stage_age_ms,
        snapshot.stage_details,
        snapshot.max_main_thread_drift_ms,
        snapshot.used_js_heap_size,
        snapshot.total_js_heap_size,
        snapshot.js_heap_size_limit,
        snapshot.timestamp_ms
    )
}

fn log_stale_heartbeat(elapsed: Duration, snapshot: Option<&RendererHealthSnapshot>) {
    log::error!(
        "[renderer_health] renderer heartbeat stale: elapsed_ms={}, last={}",
        elapsed.as_millis(),
        describe_snapshot(snapshot)
    );
}

pub fn start_renderer_health_watchdog() {
    if WATCHDOG_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    if let Err(error) = std::thread::Builder::new()
        .name("renderer-health-watchdog".to_string())
        .spawn(|| loop {
            std::thread::sleep(WATCHDOG_INTERVAL);

            let now = Instant::now();
            let Ok(mut state) = RENDERER_HEALTH_STATE.lock() else {
                continue;
            };

            let Some(last_heartbeat_at) = state.last_heartbeat_at else {
                continue;
            };

            let elapsed = now.duration_since(last_heartbeat_at);
            if elapsed < STALE_HEARTBEAT_THRESHOLD
                || !should_log_stale(now, state.last_stale_log_at)
            {
                continue;
            }

            log_stale_heartbeat(elapsed, state.last_snapshot.as_ref());
            state.last_stale_log_at = Some(now);
        })
    {
        log::error!("failed to start renderer health watchdog: {}", error);
    }
}

#[tauri::command]
pub fn renderer_health_heartbeat(payload: RendererHeartbeatPayload) -> Result<(), String> {
    let now = Instant::now();
    let mut state = RENDERER_HEALTH_STATE
        .lock()
        .map_err(|_| "renderer health state lock poisoned".to_string())?;

    if let Some(last_heartbeat_at) = state.last_heartbeat_at {
        let gap = now.duration_since(last_heartbeat_at);
        if gap >= HEARTBEAT_GAP_WARN_THRESHOLD {
            log::warn!(
                "[renderer_health] renderer heartbeat gap: gap_ms={}, last={}",
                gap.as_millis(),
                describe_snapshot(state.last_snapshot.as_ref())
            );
        }
    }

    let snapshot = snapshot_from_payload(payload);
    if snapshot
        .max_main_thread_drift_ms
        .is_some_and(|drift| drift >= MAIN_THREAD_DRIFT_WARN_MS)
    {
        log::warn!(
            "[renderer_health] renderer main thread stall reported: {}",
            describe_snapshot(Some(&snapshot))
        );
    }

    state.last_heartbeat_at = Some(now);
    state.last_snapshot = Some(snapshot);
    Ok(())
}
