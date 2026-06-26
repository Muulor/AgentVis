//! 数据管理命令模块
//!
//! 提供数据导出、导入、统计、清理和重置功能

use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Write};
use tauri::{AppHandle, Manager, State};
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

use crate::AppState;

/// 数据统计信息
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataStats {
    pub hub_count: i64,
    pub agent_count: i64,
    pub message_count: i64,
    pub memory_count: i64,
    pub vector_chunk_count: i64,
    pub snapshot_count: i64,
    pub db_size_bytes: u64,
}

/// 导出清单文件
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifest {
    pub version: String,
    pub app_version: String,
    pub exported_at: i64,
    pub stats: ManifestStats,
}

/// 清单中的统计信息
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestStats {
    pub hub_count: i64,
    pub agent_count: i64,
    pub message_count: i64,
    pub memory_count: i64,
    pub file_count: i64,
    pub vector_count: i64,
    pub snapshot_count: i64,
    pub diff_record_count: i64,
}

/// 导入结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub success: bool,
    pub imported_hubs: i64,
    pub imported_agents: i64,
    pub imported_messages: i64,
    pub imported_memories: i64,
    pub imported_files: i64,
    pub imported_vectors: i64,
    pub imported_snapshots: i64,
    pub imported_diff_records: i64,
    pub warnings: Vec<String>,
}

// ============================================================================
// 导入数据结构定义
// 由于 ZipArchive 不是 Send，需要先读取所有数据再进行异步数据库操作
// ============================================================================

/// Hub 元组类型
type HubTuple = (String, String, i64, i64, Option<i64>);

/// 旧版 Agent 元组类型（导出版本 1.0/1.1）
type AgentTupleV1 = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    i64,
    Option<i64>,
);

/// Agent 元组类型（导出版本 1.2）
type AgentTupleV2 = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    i64,
    Option<i64>,
);

/// Agent 备份行，兼容旧版不含 Rules 文本列的导出数据
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum AgentBackupRow {
    V2(AgentTupleV2),
    V1(AgentTupleV1),
}

/// Message 元组类型
type MessageTuple = (String, String, String, String, Option<String>, i64, Option<i64>);

/// Memory 元组类型
type MemoryTuple = (
    String,
    String,
    String,
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
    i64,
    i64,
    Option<String>,
);

/// Memory Candidate 元组类型
type CandidateTuple = (String, String, String, String, i64, i64, i64, i64, i64);

/// File 元组类型
type FileTuple = (String, String, String, String, String, Option<i64>, i64, i64);

/// Chunk Embedding 元组类型 (embedding 作为 Base64 字符串存储)
type ChunkEmbeddingTuple = (
    String,
    String,
    String,
    i64,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
);

/// Vector Metadata 元组类型
type VectorMetadataTuple = (i64, String, String, String, Option<String>);

/// Snapshot 元组类型
type SnapshotTuple = (String, String, String, Option<String>, Option<String>, i64);

/// Diff Record 元组类型
type DiffRecordTuple = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    i64,
    i64,
    Option<String>,
);

/// 从 ZIP 中提取的导入数据
#[allow(dead_code)] // manifest 字段用于未来扩展（如版本兼容性检查），当前仅在构造时赋值
struct ImportData {
    manifest: ExportManifest,
    hubs: Option<Vec<HubTuple>>,
    agents: Option<Vec<AgentBackupRow>>,
    messages: Option<Vec<MessageTuple>>,
    memories: Option<Vec<MemoryTuple>>,
    candidates: Option<Vec<CandidateTuple>>,
    files: Option<Vec<FileTuple>>,
    chunk_embeddings: Option<Vec<ChunkEmbeddingTuple>>,
    vector_metadata: Option<Vec<VectorMetadataTuple>>,
    snapshots: Option<Vec<SnapshotTuple>>,
    diff_records: Option<Vec<DiffRecordTuple>>,
}

/// 获取数据统计信息
///
/// 返回各类数据的数量统计
#[tauri::command]
pub async fn data_get_stats(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<DataStats, String> {
    let db = state.db.lock().await;

    // 查询各表的记录数
    let hub_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM hubs WHERE deleted_at IS NULL")
        .fetch_one(db.pool())
        .await
        .map_err(|e| format!("Failed to query Hub count: {}", e))?;

    let agent_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM agents WHERE deleted_at IS NULL")
            .fetch_one(db.pool())
            .await
            .map_err(|e| format!("Failed to query Agent count: {}", e))?;

    let message_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL")
            .fetch_one(db.pool())
            .await
            .map_err(|e| format!("Failed to query message count: {}", e))?;

    let memory_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM memories")
        .fetch_one(db.pool())
        .await
        .map_err(|e| format!("Failed to query memory count: {}", e))?;

    let vector_chunk_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM chunk_embeddings")
        .fetch_one(db.pool())
        .await
        .map_err(|e| format!("Failed to query vector chunk count: {}", e))?;

    let snapshot_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM snapshots")
        .fetch_one(db.pool())
        .await
        .map_err(|e| format!("Failed to query snapshot count: {}", e))?;

    // 获取数据库文件大小
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    let db_path = app_data_dir.join("agentvis.db");
    let db_size_bytes = fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);

    Ok(DataStats {
        hub_count: hub_count.0,
        agent_count: agent_count.0,
        message_count: message_count.0,
        memory_count: memory_count.0,
        vector_chunk_count: vector_chunk_count.0,
        snapshot_count: snapshot_count.0,
        db_size_bytes,
    })
}

/// 清除向量缓存
///
/// 删除所有向量索引数据，释放存储空间
#[tauri::command]
pub async fn data_clear_vectors(state: State<'_, AppState>) -> Result<i64, String> {
    let db = state.db.lock().await;

    // 获取当前向量数量
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM chunk_embeddings")
        .fetch_one(db.pool())
        .await
        .map_err(|e| format!("Failed to query vector count: {}", e))?;

    // 删除所有向量
    sqlx::query("DELETE FROM chunk_embeddings")
        .execute(db.pool())
        .await
        .map_err(|e| format!("Failed to clear vectors: {}", e))?;

    // 同时清理 vector_metadata 表
    sqlx::query("DELETE FROM vector_metadata")
        .execute(db.pool())
        .await
        .map_err(|e| format!("Failed to clear vector metadata: {}", e))?;

    log::info!("[data_management] 已清除 {} 条向量记录", count.0);
    Ok(count.0)
}

/// 重置所有数据
///
/// 危险操作：删除所有用户数据，需要输入确认短语
#[tauri::command]
pub async fn data_reset_all(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    confirm_phrase: String,
) -> Result<(), String> {
    // 验证确认短语
    const EXPECTED_PHRASES: [&str; 2] = ["DELETE ALL DATA", "\u{5220}\u{9664}\u{6240}\u{6709}\u{6570}\u{636e}"];
    if !EXPECTED_PHRASES.contains(&confirm_phrase.as_str()) {
        return Err(format!(
            "Confirmation phrase is incorrect. Enter \"{}\" to confirm this operation.",
            EXPECTED_PHRASES[0]
        ));
    }

    let db = state.db.lock().await;

    // 按顺序删除所有表数据（注意外键约束顺序）
    let tables = [
        "diff_records",
        "snapshots",
        "chunk_embeddings",
        "vector_metadata",
        "memory_candidates",
        "memory_trigger_state",
        "memories",
        "files",
        "messages",
        "agents",
        "hubs",
    ];

    for table in tables.iter() {
        sqlx::query(&format!("DELETE FROM {}", table))
            .execute(db.pool())
            .await
            .map_err(|e| format!("Failed to clear {} table: {}", table, e))?;
        log::debug!("[data_management] 已清空表: {}", table);
    }

    // 释放锁再操作文件
    drop(db);

    // 清理应用数据目录下的文件
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    // 清理 deliverables 目录
    let deliverables_dir = app_data_dir.join("deliverables");
    if deliverables_dir.exists() {
        fs::remove_dir_all(&deliverables_dir)
            .map_err(|e| format!("Failed to clean deliverables directory: {}", e))?;
        log::debug!("[data_management] 已清理 deliverables 目录");
    }

    // 清理 attachments 目录
    let attachments_dir = app_data_dir.join("attachments");
    if attachments_dir.exists() {
        fs::remove_dir_all(&attachments_dir)
            .map_err(|e| format!("Failed to clean attachments directory: {}", e))?;
        log::debug!("[data_management] 已清理 attachments 目录");
    }

    // 保留 backups 目录（用户可能需要恢复）
    log::info!("[data_management] 数据重置完成");
    Ok(())
}

/// 导出数据到 ZIP 文件
///
/// 将所有用户数据导出为 ZIP 压缩包，包含完整备份
#[tauri::command]
pub async fn data_export(
    state: State<'_, AppState>,
    export_path: String,
) -> Result<String, String> {
    let db = state.db.lock().await;

    // ========================================================================
    // 从数据库读取所有数据
    // ========================================================================

    // 核心数据表
    let hubs: Vec<HubTuple> =
        sqlx::query_as("SELECT id, name, created_at, updated_at, deleted_at FROM hubs")
            .fetch_all(db.pool())
            .await
            .map_err(|e| format!("Failed to query Hubs: {}", e))?;

    let agent_rows: Vec<AgentTupleV2> = sqlx::query_as(
        "SELECT id, hub_id, name, avatar_color, avatar, model_provider, model_name, mb_rules_file_path, sa_rules_file_path, mb_rules, sa_rules, chat_rules, knowledge_paths, created_at, updated_at, deleted_at FROM agents",
    )
    .fetch_all(db.pool())
    .await
    .map_err(|e| format!("Failed to query Agents: {}", e))?;
    let agents: Vec<AgentBackupRow> =
        agent_rows.into_iter().map(AgentBackupRow::V2).collect();

    let messages: Vec<MessageTuple> = sqlx::query_as(
        "SELECT id, agent_id, role, content, metadata, created_at, deleted_at FROM messages",
    )
    .fetch_all(db.pool())
    .await
    .map_err(|e| format!("Failed to query Messages: {}", e))?;

    let memories: Vec<MemoryTuple> = sqlx::query_as(
        "SELECT id, agent_id, layer, content, category, importance, source_message_ids, created_at, updated_at, metadata_json FROM memories",
    )
    .fetch_all(db.pool())
    .await
    .map_err(|e| format!("Failed to query Memories: {}", e))?;

    let candidates: Vec<CandidateTuple> = sqlx::query_as(
        "SELECT id, agent_id, content, category, occurrence_count, first_seen_at, last_seen_at, user_confirmed, score FROM memory_candidates",
    )
    .fetch_all(db.pool())
    .await
    .map_err(|e| format!("Failed to query Memory Candidates: {}", e))?;

    // 文件元数据表
    let files: Vec<FileTuple> = sqlx::query_as(
        "SELECT id, agent_id, name, path, file_type, size_bytes, created_at, updated_at FROM files",
    )
    .fetch_all(db.pool())
    .await
    .map_err(|e| format!("Failed to query Files: {}", e))?;

    // 向量数据 - 需要将 BLOB 转换为 Base64 进行 JSON 序列化
    let chunk_embeddings_raw: Vec<(
        String,
        String,
        String,
        i64,
        String,
        Option<Vec<u8>>,
        Option<String>,
        Option<String>,
        i64,
    )> = sqlx::query_as(
        "SELECT id, agent_id, document_id, chunk_index, content, embedding, metadata_json, source_file_id, created_at FROM chunk_embeddings",
    )
    .fetch_all(db.pool())
    .await
    .map_err(|e| format!("Failed to query Chunk Embeddings: {}", e))?;

    // 将 BLOB 转换为 Base64 字符串
    use base64::Engine;
    let chunk_embeddings: Vec<ChunkEmbeddingTuple> = chunk_embeddings_raw
        .into_iter()
        .map(|row| {
            let embedding_base64 = row.5.map(|bytes| {
                base64::engine::general_purpose::STANDARD.encode(&bytes)
            });
            (
                row.0, row.1, row.2, row.3, row.4, embedding_base64, row.6, row.7, row.8,
            )
        })
        .collect();

    let vector_metadata: Vec<VectorMetadataTuple> = sqlx::query_as(
        "SELECT rowid, agent_id, chunk_id, content, source_file_id FROM vector_metadata",
    )
    .fetch_all(db.pool())
    .await
    .map_err(|e| format!("Failed to query Vector Metadata: {}", e))?;

    // 版本控制数据
    let snapshots: Vec<SnapshotTuple> = sqlx::query_as(
        "SELECT id, document_id, content, trigger_modification_id, description, created_at FROM snapshots",
    )
    .fetch_all(db.pool())
    .await
    .map_err(|e| format!("Failed to query Snapshots: {}", e))?;

    let diff_records: Vec<DiffRecordTuple> = sqlx::query_as(
        "SELECT id, context_id, message_id, document_id, original_content, modified_content, xml_modification, status, created_at, updated_at, active_snapshot_id FROM diff_records",
    )
    .fetch_all(db.pool())
    .await
    .map_err(|e| format!("Failed to query Diff Records: {}", e))?;

    // 释放数据库锁
    drop(db);

    // ========================================================================
    // 创建 ZIP 文件
    // ========================================================================

    let file =
        File::create(&export_path).map_err(|e| format!("Failed to create export file: {}", e))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    // 写入各个 JSON 文件
    write_json_to_zip(&mut zip, "hubs.json", &hubs, options)?;
    write_json_to_zip(&mut zip, "agents.json", &agents, options)?;
    write_json_to_zip(&mut zip, "messages.json", &messages, options)?;
    write_json_to_zip(&mut zip, "memories.json", &memories, options)?;
    write_json_to_zip(&mut zip, "memory_candidates.json", &candidates, options)?;
    write_json_to_zip(&mut zip, "files.json", &files, options)?;
    write_json_to_zip(&mut zip, "chunk_embeddings.json", &chunk_embeddings, options)?;
    write_json_to_zip(&mut zip, "vector_metadata.json", &vector_metadata, options)?;
    write_json_to_zip(&mut zip, "snapshots.json", &snapshots, options)?;
    write_json_to_zip(&mut zip, "diff_records.json", &diff_records, options)?;

    // 创建 manifest.json
    let manifest = ExportManifest {
        version: "1.2".to_string(), // 版本升级以包含直接粘贴的 Agent Rules 文本
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        exported_at: chrono::Utc::now().timestamp_millis(),
        stats: ManifestStats {
            hub_count: hubs.len() as i64,
            agent_count: agents.len() as i64,
            message_count: messages.len() as i64,
            memory_count: memories.len() as i64,
            file_count: files.len() as i64,
            vector_count: chunk_embeddings.len() as i64,
            snapshot_count: snapshots.len() as i64,
            diff_record_count: diff_records.len() as i64,
        },
    };

    write_json_to_zip(&mut zip, "manifest.json", &manifest, options)?;

    zip.finish()
        .map_err(|e| format!("Failed to finish ZIP file: {}", e))?;

    log::info!("[data_management] 数据导出完成: {}", export_path);
    Ok(export_path)
}

/// 辅助函数：写入 JSON 到 ZIP
fn write_json_to_zip<T: Serialize>(
    zip: &mut ZipWriter<File>,
    filename: &str,
    data: &T,
    options: SimpleFileOptions,
) -> Result<(), String> {
    let json = serde_json::to_string_pretty(data)
        .map_err(|e| format!("Failed to serialize {}: {}", filename, e))?;
    zip.start_file(filename, options)
        .map_err(|e| format!("Failed to write {}: {}", filename, e))?;
    zip.write_all(json.as_bytes())
        .map_err(|e| format!("Failed to write {} content: {}", filename, e))?;
    Ok(())
}

/// 从 ZIP 文件读取导入数据（同步函数）
fn read_import_data(import_path: &str) -> Result<ImportData, String> {
    let file = File::open(import_path).map_err(|e| format!("Failed to open import file: {}", e))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Failed to parse ZIP file: {}", e))?;

    // 读取 manifest.json
    let manifest: ExportManifest = {
        let mut manifest_file = archive
            .by_name("manifest.json")
            .map_err(|_| "The ZIP file is missing manifest.json".to_string())?;
        let mut content = String::new();
        manifest_file
            .read_to_string(&mut content)
            .map_err(|e| format!("Failed to read manifest.json: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse manifest.json: {}", e))?
    };

    // 验证版本兼容性（支持 1.0、1.1 和 1.2）
    if manifest.version != "1.0" && manifest.version != "1.1" && manifest.version != "1.2" {
        return Err(format!(
            "Unsupported export version: {}. Supported versions are 1.0, 1.1 and 1.2.",
            manifest.version
        ));
    }

    // 读取各个 JSON 文件
    let hubs = read_json_from_zip(&mut archive, "hubs.json")?;
    let agents = read_json_from_zip(&mut archive, "agents.json")?;
    let messages = read_json_from_zip(&mut archive, "messages.json")?;
    let memories = read_json_from_zip(&mut archive, "memories.json")?;
    let candidates = read_json_from_zip(&mut archive, "memory_candidates.json")?;
    let files = read_json_from_zip(&mut archive, "files.json")?;
    let chunk_embeddings = read_json_from_zip(&mut archive, "chunk_embeddings.json")?;
    let vector_metadata = read_json_from_zip(&mut archive, "vector_metadata.json")?;
    let snapshots = read_json_from_zip(&mut archive, "snapshots.json")?;
    let diff_records = read_json_from_zip(&mut archive, "diff_records.json")?;

    Ok(ImportData {
        manifest,
        hubs,
        agents,
        messages,
        memories,
        candidates,
        files,
        chunk_embeddings,
        vector_metadata,
        snapshots,
        diff_records,
    })
}

/// 辅助函数：从 ZIP 读取 JSON
fn read_json_from_zip<T: for<'de> Deserialize<'de>>(
    archive: &mut ZipArchive<File>,
    filename: &str,
) -> Result<Option<T>, String> {
    if let Ok(mut f) = archive.by_name(filename) {
        let mut content = String::new();
        f.read_to_string(&mut content)
            .map_err(|e| format!("Failed to read {}: {}", filename, e))?;
        let data = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse {}: {}", filename, e))?;
        Ok(Some(data))
    } else {
        // 文件不存在是允许的（向后兼容 1.0 版本）
        Ok(None)
    }
}

/// 导入数据从 ZIP 文件
///
/// 从 ZIP 压缩包恢复用户数据
#[tauri::command]
pub async fn data_import(
    state: State<'_, AppState>,
    import_path: String,
    mode: String,
) -> Result<ImportResult, String> {
    use base64::Engine;

    // 先同步读取 ZIP 文件内容（避免跨越 await 边界）
    let import_data = read_import_data(&import_path)?;

    let db = state.db.lock().await;
    let mut warnings: Vec<String> = Vec::new();

    // 如果是覆盖模式，先清空现有数据
    if mode == "replace" {
        let tables = [
            "diff_records",
            "snapshots",
            "chunk_embeddings",
            "vector_metadata",
            "memory_candidates",
            "memory_trigger_state",
            "memories",
            "files",
            "messages",
            "agents",
            "hubs",
        ];

        for table in tables.iter() {
            sqlx::query(&format!("DELETE FROM {}", table))
                .execute(db.pool())
                .await
                .map_err(|e| format!("Failed to clear {} table: {}", table, e))?;
        }
    }

    let mut imported_hubs = 0i64;
    let mut imported_agents = 0i64;
    let mut imported_messages = 0i64;
    let mut imported_memories = 0i64;
    let mut imported_files = 0i64;
    let mut imported_vectors = 0i64;
    let mut imported_snapshots = 0i64;
    let mut imported_diff_records = 0i64;

    // ========================================================================
    // 按依赖顺序导入数据
    // ========================================================================

    // 导入 Hubs
    if let Some(hubs) = import_data.hubs {
        for (idx, hub) in hubs.iter().enumerate() {
            let result = sqlx::query(
                "INSERT OR IGNORE INTO hubs (id, name, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(&hub.0)
            .bind(&hub.1)
            .bind(hub.2)
            .bind(hub.3)
            .bind(hub.4)
            .execute(db.pool())
            .await;

            match result {
                Ok(r) if r.rows_affected() > 0 => imported_hubs += 1,
                Ok(_) => {} // 已存在，跳过
                Err(e) => warnings.push(format!("Hub #{} import failed: {}", idx, e)),
            }
        }
    }

    // 导入 Agents
    if let Some(agents) = import_data.agents {
        for (idx, agent) in agents.iter().enumerate() {
            let no_mb_rules: Option<String> = None;
            let no_sa_rules: Option<String> = None;
            let no_chat_rules: Option<String> = None;
            let (
                id,
                hub_id,
                name,
                avatar_color,
                avatar,
                model_provider,
                model_name,
                mb_rules_file_path,
                sa_rules_file_path,
                mb_rules,
                sa_rules,
                chat_rules,
                knowledge_paths,
                created_at,
                updated_at,
                deleted_at,
            ) = match agent {
                AgentBackupRow::V2(row) => (
                    &row.0,
                    &row.1,
                    &row.2,
                    &row.3,
                    &row.4,
                    &row.5,
                    &row.6,
                    &row.7,
                    &row.8,
                    &row.9,
                    &row.10,
                    &row.11,
                    &row.12,
                    row.13,
                    row.14,
                    row.15,
                ),
                AgentBackupRow::V1(row) => (
                    &row.0,
                    &row.1,
                    &row.2,
                    &row.3,
                    &row.4,
                    &row.5,
                    &row.6,
                    &row.7,
                    &row.8,
                    &no_mb_rules,
                    &no_sa_rules,
                    &no_chat_rules,
                    &row.9,
                    row.10,
                    row.11,
                    row.12,
                ),
            };

            let result = sqlx::query(
                "INSERT OR IGNORE INTO agents (id, hub_id, name, avatar_color, avatar, model_provider, model_name, mb_rules_file_path, sa_rules_file_path, mb_rules, sa_rules, chat_rules, knowledge_paths, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(id)
            .bind(hub_id)
            .bind(name)
            .bind(avatar_color)
            .bind(avatar)
            .bind(model_provider)
            .bind(model_name)
            .bind(mb_rules_file_path)
            .bind(sa_rules_file_path)
            .bind(mb_rules)
            .bind(sa_rules)
            .bind(chat_rules)
            .bind(knowledge_paths)
            .bind(created_at)
            .bind(updated_at)
            .bind(deleted_at)
            .execute(db.pool())
            .await;

            match result {
                Ok(r) if r.rows_affected() > 0 => imported_agents += 1,
                Ok(_) => {}
                Err(e) => warnings.push(format!("Agent #{} import failed: {}", idx, e)),
            }
        }
    }

    // 导入 Messages
    if let Some(messages) = import_data.messages {
        for (idx, msg) in messages.iter().enumerate() {
            let result = sqlx::query(
                "INSERT OR IGNORE INTO messages (id, agent_id, role, content, metadata, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&msg.0)
            .bind(&msg.1)
            .bind(&msg.2)
            .bind(&msg.3)
            .bind(&msg.4)
            .bind(msg.5)
            .bind(msg.6)
            .execute(db.pool())
            .await;

            match result {
                Ok(r) if r.rows_affected() > 0 => imported_messages += 1,
                Ok(_) => {}
                Err(e) => warnings.push(format!("Message #{} import failed: {}", idx, e)),
            }
        }
    }

    // 导入 Memories
    if let Some(memories) = import_data.memories {
        for (idx, mem) in memories.iter().enumerate() {
            let result = sqlx::query(
                "INSERT OR IGNORE INTO memories (id, agent_id, layer, content, category, importance, source_message_ids, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&mem.0)
            .bind(&mem.1)
            .bind(&mem.2)
            .bind(&mem.3)
            .bind(&mem.4)
            .bind(mem.5)
            .bind(&mem.6)
            .bind(mem.7)
            .bind(mem.8)
            .bind(&mem.9)
            .execute(db.pool())
            .await;

            match result {
                Ok(r) if r.rows_affected() > 0 => imported_memories += 1,
                Ok(_) => {}
                Err(e) => warnings.push(format!("Memory #{} import failed: {}", idx, e)),
            }
        }
    }

    // 导入 Memory Candidates
    if let Some(candidates) = import_data.candidates {
        for (idx, cand) in candidates.iter().enumerate() {
            let result = sqlx::query(
                "INSERT OR IGNORE INTO memory_candidates (id, agent_id, content, category, occurrence_count, first_seen_at, last_seen_at, user_confirmed, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&cand.0)
            .bind(&cand.1)
            .bind(&cand.2)
            .bind(&cand.3)
            .bind(cand.4)
            .bind(cand.5)
            .bind(cand.6)
            .bind(cand.7)
            .bind(cand.8)
            .execute(db.pool())
            .await;

            if let Err(e) = result {
                warnings.push(format!("Memory Candidate #{} import failed: {}", idx, e));
            }
        }
    }

    // 导入 Files
    if let Some(files) = import_data.files {
        for (idx, file) in files.iter().enumerate() {
            let result = sqlx::query(
                "INSERT OR IGNORE INTO files (id, agent_id, name, path, file_type, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&file.0)
            .bind(&file.1)
            .bind(&file.2)
            .bind(&file.3)
            .bind(&file.4)
            .bind(file.5)
            .bind(file.6)
            .bind(file.7)
            .execute(db.pool())
            .await;

            match result {
                Ok(r) if r.rows_affected() > 0 => imported_files += 1,
                Ok(_) => {}
                Err(e) => warnings.push(format!("File #{} import failed: {}", idx, e)),
            }
        }
    }

    // 导入 Chunk Embeddings (需要将 Base64 转回 BLOB)
    if let Some(embeddings) = import_data.chunk_embeddings {
        for (idx, emb) in embeddings.iter().enumerate() {
            // 将 Base64 字符串转换回 BLOB
            let embedding_blob: Option<Vec<u8>> = emb.5.as_ref().and_then(|b64| {
                base64::engine::general_purpose::STANDARD.decode(b64).ok()
            });

            let result = sqlx::query(
                "INSERT OR IGNORE INTO chunk_embeddings (id, agent_id, document_id, chunk_index, content, embedding, metadata_json, source_file_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&emb.0)
            .bind(&emb.1)
            .bind(&emb.2)
            .bind(emb.3)
            .bind(&emb.4)
            .bind(&embedding_blob)
            .bind(&emb.6)
            .bind(&emb.7)
            .bind(emb.8)
            .execute(db.pool())
            .await;

            match result {
                Ok(r) if r.rows_affected() > 0 => imported_vectors += 1,
                Ok(_) => {}
                Err(e) => warnings.push(format!("Chunk Embedding #{} import failed: {}", idx, e)),
            }
        }
    }

    // 导入 Vector Metadata
    if let Some(metadata) = import_data.vector_metadata {
        for (idx, meta) in metadata.iter().enumerate() {
            let result = sqlx::query(
                "INSERT OR IGNORE INTO vector_metadata (rowid, agent_id, chunk_id, content, source_file_id) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(meta.0)
            .bind(&meta.1)
            .bind(&meta.2)
            .bind(&meta.3)
            .bind(&meta.4)
            .execute(db.pool())
            .await;

            if let Err(e) = result {
                warnings.push(format!("Vector Metadata #{} import failed: {}", idx, e));
            }
        }
    }

    // 导入 Snapshots
    if let Some(snapshots) = import_data.snapshots {
        for (idx, snap) in snapshots.iter().enumerate() {
            let result = sqlx::query(
                "INSERT OR IGNORE INTO snapshots (id, document_id, content, trigger_modification_id, description, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(&snap.0)
            .bind(&snap.1)
            .bind(&snap.2)
            .bind(&snap.3)
            .bind(&snap.4)
            .bind(snap.5)
            .execute(db.pool())
            .await;

            match result {
                Ok(r) if r.rows_affected() > 0 => imported_snapshots += 1,
                Ok(_) => {}
                Err(e) => warnings.push(format!("Snapshot #{} import failed: {}", idx, e)),
            }
        }
    }

    // 导入 Diff Records
    if let Some(diff_records) = import_data.diff_records {
        for (idx, diff) in diff_records.iter().enumerate() {
            let result = sqlx::query(
                "INSERT OR IGNORE INTO diff_records (id, context_id, message_id, document_id, original_content, modified_content, xml_modification, status, created_at, updated_at, active_snapshot_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&diff.0)
            .bind(&diff.1)
            .bind(&diff.2)
            .bind(&diff.3)
            .bind(&diff.4)
            .bind(&diff.5)
            .bind(&diff.6)
            .bind(&diff.7)
            .bind(diff.8)
            .bind(diff.9)
            .bind(&diff.10)
            .execute(db.pool())
            .await;

            match result {
                Ok(r) if r.rows_affected() > 0 => imported_diff_records += 1,
                Ok(_) => {}
                Err(e) => warnings.push(format!("Diff Record #{} import failed: {}", idx, e)),
            }
        }
    }

    log::info!(
        "[data_management] 数据导入完成: {} hubs, {} agents, {} messages, {} memories, {} files, {} vectors, {} snapshots, {} diff_records",
        imported_hubs, imported_agents, imported_messages, imported_memories,
        imported_files, imported_vectors, imported_snapshots, imported_diff_records
    );

    if !warnings.is_empty() {
        log::warn!("[data_management] 导入警告: {} 条", warnings.len());
    }

    Ok(ImportResult {
        success: true,
        imported_hubs,
        imported_agents,
        imported_messages,
        imported_memories,
        imported_files,
        imported_vectors,
        imported_snapshots,
        imported_diff_records,
        warnings,
    })
}
