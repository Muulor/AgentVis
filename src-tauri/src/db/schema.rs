//! 数据库 Schema 定义和迁移
//!
//! 包含 SQLite 表创建语句和迁移逻辑

use sqlx::{Pool, Sqlite, SqlitePool};

/// 初始化数据库表结构
///
/// 创建所有必要的表，如果表已存在则跳过
pub async fn initialize_schema(pool: &Pool<Sqlite>) -> Result<(), sqlx::Error> {
    // Hub 表
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS hubs (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER
        )
        "#,
    )
    .execute(pool)
    .await?;

    // Agent 表
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS agents (
            id TEXT PRIMARY KEY NOT NULL,
            hub_id TEXT NOT NULL,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            avatar_color TEXT,
            model_provider TEXT,
            model_name TEXT,
            mb_rules_file_path TEXT,
            sa_rules_file_path TEXT,
            mb_rules TEXT,
            sa_rules TEXT,
            chat_rules TEXT,
            knowledge_paths TEXT,
            visual_enhancement_enabled INTEGER DEFAULT 1,
            sandbox_mode TEXT DEFAULT 'LocalAudit',
            sub_agent_safety_footer_enabled INTEGER DEFAULT 0,
            sub_agent_safety_footer_text TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER,
            FOREIGN KEY (hub_id) REFERENCES hubs(id)
        )
        "#,
    )
    .execute(pool)
    .await?;

    // 为 Agent 创建 hub_id 索引
    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_agents_hub_id ON agents(hub_id)
        "#,
    )
    .execute(pool)
    .await?;

    // 数据库迁移：为现有 agents 表添加 knowledge_paths 列
    // 使用 PRAGMA 检查列是否存在，如不存在则添加
    let hub_sort_columns: Vec<(String,)> =
        sqlx::query_as("SELECT name FROM pragma_table_info('hubs') WHERE name = 'sort_order'")
            .fetch_all(pool)
            .await?;

    if hub_sort_columns.is_empty() {
        sqlx::query("ALTER TABLE hubs ADD COLUMN sort_order INTEGER")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 hubs.sort_order 列");
    }

    sqlx::query(
        r#"
        UPDATE hubs
        SET sort_order = (
            SELECT COUNT(*)
            FROM hubs h2
            WHERE h2.deleted_at IS NULL
              AND (
                h2.created_at > hubs.created_at
                OR (h2.created_at = hubs.created_at AND h2.id < hubs.id)
              )
        )
        WHERE sort_order IS NULL
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_hubs_sort_order ON hubs(sort_order)
        "#,
    )
    .execute(pool)
    .await?;

    let agent_sort_columns: Vec<(String,)> =
        sqlx::query_as("SELECT name FROM pragma_table_info('agents') WHERE name = 'sort_order'")
            .fetch_all(pool)
            .await?;

    if agent_sort_columns.is_empty() {
        sqlx::query("ALTER TABLE agents ADD COLUMN sort_order INTEGER")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 agents.sort_order 列");
    }

    sqlx::query(
        r#"
        UPDATE agents
        SET sort_order = (
            SELECT COUNT(*)
            FROM agents a2
            WHERE a2.hub_id = agents.hub_id
              AND a2.deleted_at IS NULL
              AND (
                a2.created_at > agents.created_at
                OR (a2.created_at = agents.created_at AND a2.id < agents.id)
              )
        )
        WHERE sort_order IS NULL
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_agents_hub_sort_order ON agents(hub_id, sort_order)
        "#,
    )
    .execute(pool)
    .await?;

    let columns: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM pragma_table_info('agents') WHERE name = 'knowledge_paths'",
    )
    .fetch_all(pool)
    .await?;

    if columns.is_empty() {
        // knowledge_paths 列不存在，添加它
        sqlx::query("ALTER TABLE agents ADD COLUMN knowledge_paths TEXT")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 agents.knowledge_paths 列");
    }

    // 数据库迁移：为现有 agents 表添加 avatar 列（存储 base64 头像）
    let avatar_columns: Vec<(String,)> =
        sqlx::query_as("SELECT name FROM pragma_table_info('agents') WHERE name = 'avatar'")
            .fetch_all(pool)
            .await?;

    if avatar_columns.is_empty() {
        sqlx::query("ALTER TABLE agents ADD COLUMN avatar TEXT")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 agents.avatar 列");
    }

    // 数据库迁移：为现有 agents 表添加 auto_index_deliverables 列
    // 控制交付物是否自动索引到知识库，默认开启（DEFAULT 1）
    let auto_idx_columns: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM pragma_table_info('agents') WHERE name = 'auto_index_deliverables'",
    )
    .fetch_all(pool)
    .await?;

    if auto_idx_columns.is_empty() {
        sqlx::query("ALTER TABLE agents ADD COLUMN auto_index_deliverables INTEGER DEFAULT 1")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 agents.auto_index_deliverables 列");
    }

    // 数据库迁移：为现有 agents 表添加 Planning 最终回复可视化增强开关
    // 默认开启，保持旧版本 Agent 的既有体验；用户可在 Agent 设置中关闭以节省后处理 token。
    let visual_enhancement_columns: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM pragma_table_info('agents') WHERE name = 'visual_enhancement_enabled'",
    )
    .fetch_all(pool)
    .await?;

    if visual_enhancement_columns.is_empty() {
        sqlx::query("ALTER TABLE agents ADD COLUMN visual_enhancement_enabled INTEGER DEFAULT 1")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 agents.visual_enhancement_enabled 列");
    }

    // 数据库迁移：为现有 agents 表添加 mb_rules_file_path 列
    // MB (Master Brain) 专属的 rules 文件路径
    let mb_rules_columns: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM pragma_table_info('agents') WHERE name = 'mb_rules_file_path'",
    )
    .fetch_all(pool)
    .await?;

    if mb_rules_columns.is_empty() {
        sqlx::query("ALTER TABLE agents ADD COLUMN mb_rules_file_path TEXT")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 agents.mb_rules_file_path 列");
    }

    // 数据库迁移：为现有 agents 表添加 sa_rules_file_path 列
    // SA (Sub-Agent) 专属的 rules 文件路径
    let sa_rules_columns: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM pragma_table_info('agents') WHERE name = 'sa_rules_file_path'",
    )
    .fetch_all(pool)
    .await?;

    if sa_rules_columns.is_empty() {
        sqlx::query("ALTER TABLE agents ADD COLUMN sa_rules_file_path TEXT")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 agents.sa_rules_file_path 列");
    }

    // 数据库迁移：为现有 agents 表添加直接粘贴的 Rules 文本列
    let mb_rules_text_columns: Vec<(String,)> =
        sqlx::query_as("SELECT name FROM pragma_table_info('agents') WHERE name = 'mb_rules'")
            .fetch_all(pool)
            .await?;

    if mb_rules_text_columns.is_empty() {
        sqlx::query("ALTER TABLE agents ADD COLUMN mb_rules TEXT")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 agents.mb_rules 列");
    }

    let sa_rules_text_columns: Vec<(String,)> =
        sqlx::query_as("SELECT name FROM pragma_table_info('agents') WHERE name = 'sa_rules'")
            .fetch_all(pool)
            .await?;

    if sa_rules_text_columns.is_empty() {
        sqlx::query("ALTER TABLE agents ADD COLUMN sa_rules TEXT")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 agents.sa_rules 列");
    }

    let chat_rules_text_columns: Vec<(String,)> =
        sqlx::query_as("SELECT name FROM pragma_table_info('agents') WHERE name = 'chat_rules'")
            .fetch_all(pool)
            .await?;

    if chat_rules_text_columns.is_empty() {
        sqlx::query("ALTER TABLE agents ADD COLUMN chat_rules TEXT")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 agents.chat_rules 列");
    }

    // 数据库迁移：为现有 agents 表添加 pinned_skills 列
    // 精准命中技能列表（JSON 数组），绑定到特定 Agent 的技能
    let pinned_skills_columns: Vec<(String,)> =
        sqlx::query_as("SELECT name FROM pragma_table_info('agents') WHERE name = 'pinned_skills'")
            .fetch_all(pool)
            .await?;

    if pinned_skills_columns.is_empty() {
        sqlx::query("ALTER TABLE agents ADD COLUMN pinned_skills TEXT")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 agents.pinned_skills 列");
    }

    // 数据库迁移：为现有 agents 表添加 planning_loop_budget 列
    // MB 最大决策轮次（per-agent 覆盖），NULL 表示使用全局默认值（LOOP_GOVERNOR_INITIAL_BUDGET）
    // 无 DEFAULT 约束保持 NULL 语义清晰：NULL ≠ 0，NULL = "继承全局默认"
    let planning_budget_columns: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM pragma_table_info('agents') WHERE name = 'planning_loop_budget'",
    )
    .fetch_all(pool)
    .await?;

    if planning_budget_columns.is_empty() {
        sqlx::query("ALTER TABLE agents ADD COLUMN planning_loop_budget INTEGER")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 agents.planning_loop_budget 列");
    }

    // 数据库迁移：为现有 agents 表添加 project_path 列
    // 用于持久化用户关联的外部项目路径（用户在授权弹窗确认后 Agent 具有全权限）
    // NULL 表示未关联任何外部项目（默认行为）
    let project_path_columns: Vec<(String,)> =
        sqlx::query_as("SELECT name FROM pragma_table_info('agents') WHERE name = 'project_path'")
            .fetch_all(pool)
            .await?;

    if project_path_columns.is_empty() {
        sqlx::query("ALTER TABLE agents ADD COLUMN project_path TEXT")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 agents.project_path 列");
    }

    // 数据库迁移：为现有 agents 表添加 sandbox_mode 列
    // 仅存储用户可见的三档权限，不暴露底层技术 profile。
    let sandbox_mode_columns: Vec<(String,)> =
        sqlx::query_as("SELECT name FROM pragma_table_info('agents') WHERE name = 'sandbox_mode'")
            .fetch_all(pool)
            .await?;

    if sandbox_mode_columns.is_empty() {
        sqlx::query("ALTER TABLE agents ADD COLUMN sandbox_mode TEXT DEFAULT 'LocalAudit'")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 agents.sandbox_mode 列");
    }

    // 数据库迁移：为现有 agents 表添加 Sub-Agent Safety Footer 实验开关
    // 默认关闭，避免改变既有 Agent 的执行偏好。
    let safety_footer_enabled_columns: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM pragma_table_info('agents') WHERE name = 'sub_agent_safety_footer_enabled'",
    )
    .fetch_all(pool)
    .await?;

    if safety_footer_enabled_columns.is_empty() {
        sqlx::query(
            "ALTER TABLE agents ADD COLUMN sub_agent_safety_footer_enabled INTEGER DEFAULT 0",
        )
        .execute(pool)
        .await?;
        log::info!("数据库迁移: 已添加 agents.sub_agent_safety_footer_enabled 列");
    }

    // 数据库迁移：为现有 agents 表添加 Sub-Agent Safety Footer 自定义提示词
    let safety_footer_text_columns: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM pragma_table_info('agents') WHERE name = 'sub_agent_safety_footer_text'",
    )
    .fetch_all(pool)
    .await?;

    if safety_footer_text_columns.is_empty() {
        sqlx::query("ALTER TABLE agents ADD COLUMN sub_agent_safety_footer_text TEXT")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 agents.sub_agent_safety_footer_text 列");
    }

    // Message 表
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY NOT NULL,
            agent_id TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
            content TEXT NOT NULL,
            metadata TEXT,
            created_at INTEGER NOT NULL,
            deleted_at INTEGER,
            FOREIGN KEY (agent_id) REFERENCES agents(id)
        )
        "#,
    )
    .execute(pool)
    .await?;

    // 为 Message 创建索引
    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_messages_agent_id ON messages(agent_id)
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)
        "#,
    )
    .execute(pool)
    .await?;

    // 数据库迁移：为现有 messages 表添加 metadata 列
    let msg_columns: Vec<(String,)> =
        sqlx::query_as("SELECT name FROM pragma_table_info('messages') WHERE name = 'metadata'")
            .fetch_all(pool)
            .await?;

    if msg_columns.is_empty() {
        // metadata 列不存在，添加它
        sqlx::query("ALTER TABLE messages ADD COLUMN metadata TEXT")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 messages.metadata 列");
    }

    // Memory 表 (三层记忆)
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY NOT NULL,
            agent_id TEXT NOT NULL,
            layer TEXT NOT NULL CHECK(layer IN ('short_term', 'summary', 'fact')),
            content TEXT NOT NULL,
            category TEXT,
            importance INTEGER,
            source_message_ids TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (agent_id) REFERENCES agents(id)
        )
        "#,
    )
    .execute(pool)
    .await?;

    // 为 Memory 创建索引
    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_memories_agent_id ON memories(agent_id)
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer)
        "#,
    )
    .execute(pool)
    .await?;

    // 数据库迁移：为现有 memories 表添加 metadata_json 列
    // 用于存储状态字段（openQuestions、confirmedDecisions、invalidatedPoints 等）
    let memory_columns: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM pragma_table_info('memories') WHERE name = 'metadata_json'",
    )
    .fetch_all(pool)
    .await?;

    if memory_columns.is_empty() {
        // metadata_json 列不存在，添加它
        sqlx::query("ALTER TABLE memories ADD COLUMN metadata_json TEXT")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 memories.metadata_json 列");
    }

    // Migration: normalize historical memories timestamps that were written in seconds.
    // The frontend formats memory timestamps as milliseconds; positive values below 1e12 are seconds.
    sqlx::query(
        r#"
        UPDATE memories
        SET created_at = created_at * 1000
        WHERE created_at > 0 AND created_at < 1000000000000
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        UPDATE memories
        SET updated_at = updated_at * 1000
        WHERE updated_at > 0 AND updated_at < 1000000000000
        "#,
    )
    .execute(pool)
    .await?;

    // File table (file metadata)
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS files (
            id TEXT PRIMARY KEY NOT NULL,
            agent_id TEXT NOT NULL,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            file_type TEXT NOT NULL,
            size_bytes INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (agent_id) REFERENCES agents(id)
        )
        "#,
    )
    .execute(pool)
    .await?;

    // 为 File 创建索引
    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_files_agent_id ON files(agent_id)
        "#,
    )
    .execute(pool)
    .await?;

    // Chunk Embeddings 表 (用于 RAG，完整的向量存储)
    // 存储文档块、向量和元数据信息
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS chunk_embeddings (
            id TEXT PRIMARY KEY NOT NULL,
            agent_id TEXT NOT NULL,
            document_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            content TEXT NOT NULL,
            embedding BLOB,
            metadata_json TEXT,
            source_file_id TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (agent_id) REFERENCES agents(id),
            FOREIGN KEY (source_file_id) REFERENCES files(id)
        )
        "#,
    )
    .execute(pool)
    .await?;

    // 为 chunk_embeddings 创建索引
    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_agent_id ON chunk_embeddings(agent_id)
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_document_id ON chunk_embeddings(document_id)
        "#,
    )
    .execute(pool)
    .await?;

    // Vector 元数据表 (保留兼容旧表结构)
    // 注意: sqlite-vec 虚拟表需要在运行时通过扩展加载后创建
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS vector_metadata (
            rowid INTEGER PRIMARY KEY,
            agent_id TEXT NOT NULL,
            chunk_id TEXT NOT NULL,
            content TEXT NOT NULL,
            source_file_id TEXT,
            FOREIGN KEY (agent_id) REFERENCES agents(id),
            FOREIGN KEY (source_file_id) REFERENCES files(id)
        )
        "#,
    )
    .execute(pool)
    .await?;

    // 为 vector_metadata 创建索引
    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_vector_metadata_agent_id ON vector_metadata(agent_id)
        "#,
    )
    .execute(pool)
    .await?;

    // Snapshot 表 (用于 Fast-Apply 版本控制)
    // 注意: document_id 不使用外键约束，因为快照可以关联任意文档标识符
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS snapshots (
            id TEXT PRIMARY KEY NOT NULL,
            document_id TEXT NOT NULL,
            content TEXT NOT NULL,
            trigger_modification_id TEXT,
            description TEXT,
            created_at INTEGER NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;

    // 为 snapshots 创建索引
    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_snapshots_document_id ON snapshots(document_id)
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_snapshots_created_at ON snapshots(created_at)
        "#,
    )
    .execute(pool)
    .await?;

    // 数据库迁移：为现有 snapshots 表添加 modification_statuses_json 列
    // 存储快照创建时各修改块的审批状态（JSON 格式），用于回滚时精确还原 diff 面板状态
    // 解决"回滚到版本B后 diff 仍显示旧状态"的问题
    let snap_mod_statuses_cols: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM pragma_table_info('snapshots') WHERE name = 'modification_statuses_json'",
    )
    .fetch_all(pool)
    .await?;

    if snap_mod_statuses_cols.is_empty() {
        sqlx::query("ALTER TABLE snapshots ADD COLUMN modification_statuses_json TEXT")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 snapshots.modification_statuses_json 列");
    }

    // Diff Records 表 (用于 Diff 持久化和消息关联)
    // 存储文件编辑记录，支持消息撤销时回滚文件
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS diff_records (
            id TEXT PRIMARY KEY NOT NULL,
            context_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            document_id TEXT NOT NULL,
            original_content TEXT NOT NULL,
            modified_content TEXT NOT NULL,
            xml_modification TEXT,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'applied', 'reverted')),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;

    // 为 diff_records 创建索引
    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_diff_records_context_id ON diff_records(context_id)
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_diff_records_message_id ON diff_records(message_id)
        "#,
    )
    .execute(pool)
    .await?;

    // 数据库迁移：为现有 diff_records 表添加 active_snapshot_id 列
    let diff_columns: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM pragma_table_info('diff_records') WHERE name = 'active_snapshot_id'",
    )
    .fetch_all(pool)
    .await?;

    if diff_columns.is_empty() {
        // active_snapshot_id 列不存在，添加它
        sqlx::query("ALTER TABLE diff_records ADD COLUMN active_snapshot_id TEXT")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 diff_records.active_snapshot_id 列");
    }

    // 数据库迁移：为现有 diff_records 表添加 modification_statuses 列
    // 存储每个修改块的审批状态（JSON 格式），用于部分审批后重启时精确恢复
    let mod_statuses_columns: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM pragma_table_info('diff_records') WHERE name = 'modification_statuses'",
    )
    .fetch_all(pool)
    .await?;

    if mod_statuses_columns.is_empty() {
        sqlx::query("ALTER TABLE diff_records ADD COLUMN modification_statuses TEXT")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 diff_records.modification_statuses 列");
    }

    // Memory Candidates 表 (三层事实提取架构)
    // 存储待验证的候选事实，经过稳定性验证后才写入 memories 表
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS memory_candidates (
            id TEXT PRIMARY KEY NOT NULL,
            agent_id TEXT NOT NULL,
            content TEXT NOT NULL,
            category TEXT NOT NULL,
            occurrence_count INTEGER NOT NULL DEFAULT 1,
            first_seen_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            user_confirmed INTEGER NOT NULL DEFAULT 0,
            score INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
        )
        "#,
    )
    .execute(pool)
    .await?;

    // 为 memory_candidates 创建索引
    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_memory_candidates_agent_id ON memory_candidates(agent_id)
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_memory_candidates_category ON memory_candidates(category)
        "#,
    )
    .execute(pool)
    .await?;

    // Memory Trigger State 表 (混合触发模型)
    // 存储持久化的触发器状态，解决每次新实例计数器失效问题
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS memory_trigger_state (
            agent_id TEXT PRIMARY KEY NOT NULL,
            turns_since_last_extract INTEGER NOT NULL DEFAULT 0,
            candidate_signal_score REAL NOT NULL DEFAULT 0.0,
            last_extract_turn INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
        )
        "#,
    )
    .execute(pool)
    .await?;

    // 数据库迁移：为现有 memory_trigger_state 表添加 last_processed_message_id 列
    // 用于生命周期触发时检测内容是否变化，避免重复处理相同内容
    let trigger_columns: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM pragma_table_info('memory_trigger_state') WHERE name = 'last_processed_message_id'"
    )
    .fetch_all(pool)
    .await?;

    if trigger_columns.is_empty() {
        // last_processed_message_id 列不存在，添加它
        sqlx::query("ALTER TABLE memory_trigger_state ADD COLUMN last_processed_message_id TEXT")
            .execute(pool)
            .await?;
        log::info!("数据库迁移: 已添加 memory_trigger_state.last_processed_message_id 列");
    }

    // 数据库迁移：将旧 category 值 'stable_context' 重命名为 'interaction_signals'
    // 背景：FactExtractor 重构时将 stable_context 更名为 interaction_signals，
    // 但存量数据库数据未同步更新，导致 UI 的 CATEGORY_DISPLAY_MAP 找不到对应条目而崩溃（黑屏）。
    // 同时处理 memories 和 memory_candidates 两张表，确保全量覆盖。
    sqlx::query(
        "UPDATE memories SET category = 'interaction_signals' WHERE category = 'stable_context'",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "UPDATE memory_candidates SET category = 'interaction_signals' WHERE category = 'stable_context'"
    )
    .execute(pool)
    .await?;

    log::info!("数据库迁移: 已将 stable_context 类别迁移为 interaction_signals");

    // Sandbox Audit Events 表 (沙箱审计事件持久化)
    // event_json 保存完整兼容载荷，旁路字段用于诊断列表和后续筛选索引。
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS sandbox_audit_events (
            id TEXT PRIMARY KEY NOT NULL,
            timestamp INTEGER NOT NULL,
            timestamp_iso TEXT NOT NULL,
            source TEXT NOT NULL,
            subject_type TEXT NOT NULL,
            subject_id TEXT,
            sandbox_mode TEXT NOT NULL,
            network_policy TEXT NOT NULL,
            network_scope TEXT NOT NULL,
            backend TEXT NOT NULL,
            decision TEXT NOT NULL,
            target_host TEXT,
            target_scheme TEXT,
            request_method TEXT,
            status_code INTEGER,
            blocked_reason TEXT,
            event_json TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_sandbox_audit_events_timestamp
        ON sandbox_audit_events(timestamp DESC)
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_sandbox_audit_events_decision
        ON sandbox_audit_events(decision)
        "#,
    )
    .execute(pool)
    .await?;

    // CronJob 表 (定时任务)
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS cron_jobs (
            id TEXT PRIMARY KEY NOT NULL,
            agent_id TEXT NOT NULL,
            name TEXT NOT NULL,
            cron_expression TEXT NOT NULL,
            prompt TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'planning' CHECK(mode IN ('chat', 'planning')),
            enabled INTEGER NOT NULL DEFAULT 1,
            last_run_at INTEGER,
            next_run_at INTEGER,
            last_run_status TEXT CHECK(last_run_status IN ('success', 'failed', 'running')),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
        )
        "#,
    )
    .execute(pool)
    .await?;

    // 为 cron_jobs 创建索引
    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_cron_jobs_agent_id ON cron_jobs(agent_id)
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled)
        "#,
    )
    .execute(pool)
    .await?;

    Ok(())
}

/// 创建数据库连接池
///
/// # Arguments
/// * `database_url` - SQLite 数据库路径，如 "sqlite:./agentvis.db?mode=rwc"
pub async fn create_pool(database_url: &str) -> Result<SqlitePool, sqlx::Error> {
    SqlitePool::connect(database_url).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_schema_initialization() {
        // 使用内存数据库进行测试
        let pool = create_pool("sqlite::memory:").await.unwrap();

        // 初始化 schema
        let result = initialize_schema(&pool).await;
        assert!(
            result.is_ok(),
            "Schema initialization failed: {:?}",
            result.err()
        );

        // 验证表已创建 - 查询 sqlite_master
        let tables: Vec<(String,)> =
            sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .fetch_all(&pool)
                .await
                .unwrap();

        let table_names: Vec<&str> = tables.iter().map(|(n,)| n.as_str()).collect();

        assert!(table_names.contains(&"hubs"), "hubs 表未创建");
        assert!(table_names.contains(&"agents"), "agents 表未创建");
        assert!(table_names.contains(&"messages"), "messages 表未创建");
        assert!(table_names.contains(&"memories"), "memories 表未创建");
        assert!(table_names.contains(&"files"), "files 表未创建");
        assert!(
            table_names.contains(&"vector_metadata"),
            "vector_metadata 表未创建"
        );
        assert!(
            table_names.contains(&"sandbox_audit_events"),
            "sandbox_audit_events 表未创建"
        );
    }

    #[tokio::test]
    async fn test_memory_timestamp_migration_from_seconds_to_millis() {
        let pool = create_pool("sqlite::memory:").await.unwrap();
        initialize_schema(&pool).await.unwrap();

        sqlx::query(
            r#"
            INSERT INTO hubs (id, name, created_at, updated_at)
            VALUES ('hub-1', 'test hub', 1750000000000, 1750000000000)
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            r#"
            INSERT INTO agents (id, hub_id, name, created_at, updated_at)
            VALUES ('agent-1', 'hub-1', 'test agent', 1750000000000, 1750000000000)
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            r#"
            INSERT INTO memories (id, agent_id, layer, content, created_at, updated_at)
            VALUES ('mem-seconds', 'agent-1', 'fact', 'test fact', 1750000000, 1750000001)
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        initialize_schema(&pool).await.unwrap();

        let timestamps: (i64, i64) =
            sqlx::query_as("SELECT created_at, updated_at FROM memories WHERE id = 'mem-seconds'")
                .fetch_one(&pool)
                .await
                .unwrap();

        assert_eq!(timestamps.0, 1_750_000_000_000);
        assert_eq!(timestamps.1, 1_750_000_001_000);
    }
}
