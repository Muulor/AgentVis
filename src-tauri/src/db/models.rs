//! 数据库模型定义
//!
//! 定义所有数据库实体的结构体和相关类型

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// Hub 实体 - 代表一个项目工作区
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Hub {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
    pub created_at: i64, // Unix timestamp
    pub updated_at: i64,
    pub deleted_at: Option<i64>, // 软删除时间戳
}

impl Hub {
    /// 创建新的 Hub
    pub fn new(name: &str) -> Self {
        let now = Utc::now().timestamp_millis();
        Self {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            sort_order: 0,
            created_at: now,
            updated_at: now,
            deleted_at: None,
        }
    }
}

/// Agent 实体 - 代表一个 AI Agent
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Agent {
    pub id: String,
    pub hub_id: String,
    pub name: String,
    pub sort_order: i64,
    pub avatar_color: Option<String>,
    pub avatar: Option<String>, // base64 编码的自定义头像
    pub model_provider: Option<String>,
    pub model_name: Option<String>,
    pub mb_rules_file_path: Option<String>, // Master Brain 专属 rules 文件路径
    pub sa_rules_file_path: Option<String>, // Sub-Agent 专属 rules 文件路径
    pub mb_rules: Option<String>,           // Master Brain 专属 rules 文本
    pub sa_rules: Option<String>,           // Sub-Agent 专属 rules 文本
    pub chat_rules: Option<String>,         // Chat 模式专属 rules 文本
    pub knowledge_paths: Option<String>,    // JSON 数组存储多个文件路径
    pub auto_index_deliverables: Option<bool>, // 交付物是否自动索引到知识库，默认 true
    pub visual_enhancement_enabled: Option<bool>, // Planning 最终回复是否启用可视化增强，默认 true
    pub pinned_skills: Option<String>,      // 精准命中技能列表（JSON 数组）
    pub planning_loop_budget: Option<i32>,  // MB 最大决策轮次，NULL 时使用全局默认值
    pub project_path: Option<String>,       // 用户关联的外部项目路径（用户授权后 Agent 具有全权限）
    pub sandbox_mode: Option<String>, // 用户可见的三档沙箱权限：LocalAudit / OfflineIsolated / ControlledNetwork
    pub sub_agent_safety_footer_enabled: Option<bool>, // Sub-Agent 每步 Safety Footer 实验开关
    pub sub_agent_safety_footer_text: Option<String>, // Sub-Agent Safety Footer 自定义提示词
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

impl Agent {
    /// 创建新的 Agent
    pub fn new(hub_id: &str, name: &str) -> Self {
        let now = Utc::now().timestamp_millis();
        Self {
            id: Uuid::new_v4().to_string(),
            hub_id: hub_id.to_string(),
            name: name.to_string(),
            sort_order: 0,
            avatar_color: None,
            avatar: None,
            model_provider: None,
            model_name: None,
            mb_rules_file_path: None,
            sa_rules_file_path: None,
            mb_rules: None,
            sa_rules: None,
            chat_rules: None,
            knowledge_paths: None,
            auto_index_deliverables: None, // 默认由数据库 DEFAULT 1 控制
            visual_enhancement_enabled: Some(true),
            pinned_skills: None,
            planning_loop_budget: None, // NULL 表示使用全局默认值
            project_path: None,         // NULL 表示未关联外部项目
            sandbox_mode: Some("LocalAudit".to_string()),
            sub_agent_safety_footer_enabled: Some(false),
            sub_agent_safety_footer_text: None,
            created_at: now,
            updated_at: now,
            deleted_at: None,
        }
    }
}

/// 消息角色枚举
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    User,
    Assistant,
    System,
}

impl MessageRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::System => "system",
        }
    }
}

impl std::str::FromStr for MessageRole {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "user" => Ok(MessageRole::User),
            "assistant" => Ok(MessageRole::Assistant),
            "system" => Ok(MessageRole::System),
            _ => Err(format!("Unknown message role: {}", s)),
        }
    }
}

/// Message 实体 - 对话消息
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Message {
    pub id: String,
    pub agent_id: String,
    pub role: String, // SQLite 存储为字符串
    pub content: String,
    pub metadata: Option<String>, // JSON 字符串存储元数据（progressItems 等）
    pub created_at: i64,
    pub deleted_at: Option<i64>,
}

impl Message {
    /// 创建新的消息
    pub fn new(agent_id: &str, role: MessageRole, content: &str) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            agent_id: agent_id.to_string(),
            role: role.as_str().to_string(),
            content: content.to_string(),
            metadata: None,
            created_at: Utc::now().timestamp_millis(),
            deleted_at: None,
        }
    }

    /// 创建带元数据的消息
    pub fn with_metadata(
        agent_id: &str,
        role: MessageRole,
        content: &str,
        metadata: Option<String>,
    ) -> Self {
        let mut msg = Self::new(agent_id, role, content);
        msg.metadata = metadata;
        msg
    }

    /// 获取消息角色枚举
    pub fn get_role(&self) -> Result<MessageRole, String> {
        self.role.parse()
    }
}

/// 记忆层级枚举
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryLayer {
    ShortTerm, // 短期缓冲区
    Summary,   // 摘要层
    Fact,      // 事实库
}

impl MemoryLayer {
    pub fn as_str(&self) -> &'static str {
        match self {
            MemoryLayer::ShortTerm => "short_term",
            MemoryLayer::Summary => "summary",
            MemoryLayer::Fact => "fact",
        }
    }
}

impl std::str::FromStr for MemoryLayer {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "short_term" => Ok(MemoryLayer::ShortTerm),
            "summary" => Ok(MemoryLayer::Summary),
            "fact" => Ok(MemoryLayer::Fact),
            _ => Err(format!("Unknown memory layer: {}", s)),
        }
    }
}

/// Memory 实体 - 三层记忆
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Memory {
    pub id: String,
    pub agent_id: String,
    pub layer: String,
    pub content: String,
    pub category: Option<String>,           // 仅 fact 层使用
    pub importance: Option<i32>,            // 重要性评分
    pub source_message_ids: Option<String>, // JSON 数组
    pub metadata_json: Option<String>, // JSON 存储状态字段（openQuestions、confirmedDecisions 等）
    pub created_at: i64,
    pub updated_at: i64,
}

impl Memory {
    /// 创建新的记忆
    pub fn new(agent_id: &str, layer: MemoryLayer, content: &str) -> Self {
        let now = Utc::now().timestamp_millis();
        Self {
            id: Uuid::new_v4().to_string(),
            agent_id: agent_id.to_string(),
            layer: layer.as_str().to_string(),
            content: content.to_string(),
            category: None,
            importance: None,
            source_message_ids: None,
            metadata_json: None,
            created_at: now,
            updated_at: now,
        }
    }
}

/// File 实体 - 文件元数据
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct FileInfo {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    pub path: String,
    pub file_type: String,
    pub size_bytes: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl FileInfo {
    /// 创建新的文件信息
    pub fn new(agent_id: &str, name: &str, path: &str, file_type: &str) -> Self {
        let now = Utc::now().timestamp_millis();
        Self {
            id: Uuid::new_v4().to_string(),
            agent_id: agent_id.to_string(),
            name: name.to_string(),
            path: path.to_string(),
            file_type: file_type.to_string(),
            size_bytes: None,
            created_at: now,
            updated_at: now,
        }
    }
}

/// 向量元数据 - 用于 RAG
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorMetadata {
    pub rowid: i64,
    pub agent_id: String,
    pub chunk_id: String,
    pub content: String,
    pub source_file_id: Option<String>,
}

// ==================== 更新用数据结构 ====================

/// Hub 更新请求
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HubUpdate {
    pub name: Option<String>,
}

/// Agent 更新请求  
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentUpdate {
    pub name: Option<String>,
    pub avatar_color: Option<String>,
    pub avatar: Option<String>, // base64 编码的自定义头像
    pub model_provider: Option<String>,
    pub model_name: Option<String>,
    pub mb_rules_file_path: Option<String>,
    pub sa_rules_file_path: Option<String>,
    pub mb_rules: Option<String>,
    pub sa_rules: Option<String>,
    pub chat_rules: Option<String>,
    pub knowledge_paths: Option<String>,          // JSON 数组
    pub auto_index_deliverables: Option<bool>,    // 交付物自动索引开关
    pub visual_enhancement_enabled: Option<bool>, // Planning 最终回复可视化增强开关
    pub pinned_skills: Option<String>,            // 精准命中技能列表（JSON 数组）
    pub planning_loop_budget: Option<i32>,        // MB 最大决策轮次，None 表示保持原值
    pub project_path: Option<String>, // 外部项目路径，空字符串表示清除，None 表示保持原值
    pub sandbox_mode: Option<String>, // 三档沙箱权限，None 表示保持原值
    pub sub_agent_safety_footer_enabled: Option<bool>, // Sub-Agent 每步 Safety Footer 实验开关
    pub sub_agent_safety_footer_text: Option<String>, // Sub-Agent Safety Footer 自定义提示词
}

// ==================== Fast-Apply 数据结构 ====================

/// Snapshot 实体 - 文档快照，用于版本控制和回滚
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Snapshot {
    pub id: String,
    pub document_id: String,                     // 关联的文档/文件 ID
    pub content: String,                         // 快照内容
    pub trigger_modification_id: Option<String>, // 触发此快照的修改 ID
    pub description: Option<String>,             // 快照描述
    /// 快照创建时的修改块审批状态（JSON 格式）
    /// 例如: {"0":"pending","1":"rejected","2":"applied"}
    /// 用于回滚到历史版本时精确还原 diff 面板的各块状态
    pub modification_statuses_json: Option<String>,
    pub created_at: i64,
}

impl Snapshot {
    /// 创建新的快照
    pub fn new(document_id: &str, content: &str) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            document_id: document_id.to_string(),
            content: content.to_string(),
            trigger_modification_id: None,
            description: None,
            modification_statuses_json: None,
            created_at: Utc::now().timestamp_millis(),
        }
    }

    /// 创建带描述的快照
    pub fn with_description(document_id: &str, content: &str, description: &str) -> Self {
        let mut snapshot = Self::new(document_id, content);
        snapshot.description = Some(description.to_string());
        snapshot
    }

    /// 创建因修改触发的快照
    pub fn with_modification(
        document_id: &str,
        content: &str,
        modification_id: &str,
        description: Option<&str>,
    ) -> Self {
        let mut snapshot = Self::new(document_id, content);
        snapshot.trigger_modification_id = Some(modification_id.to_string());
        snapshot.description = description.map(|s| s.to_string());
        snapshot
    }
}

// ==================== Diff 持久化数据结构 ====================

/// Diff 记录状态枚举
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DiffRecordStatus {
    Pending,  // 待审批
    Applied,  // 已应用
    Reverted, // 已回滚
}

impl DiffRecordStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            DiffRecordStatus::Pending => "pending",
            DiffRecordStatus::Applied => "applied",
            DiffRecordStatus::Reverted => "reverted",
        }
    }
}

impl std::str::FromStr for DiffRecordStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "pending" => Ok(DiffRecordStatus::Pending),
            "applied" => Ok(DiffRecordStatus::Applied),
            "reverted" => Ok(DiffRecordStatus::Reverted),
            _ => Err(format!("Unknown diff record status: {}", s)),
        }
    }
}

/// DiffRecord 实体 - 文件编辑记录，关联消息以支持撤销回滚
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct DiffRecord {
    pub id: String,
    pub context_id: String,                 // Agent ID 或 Hub ID
    pub message_id: String,                 // 关联的消息 ID
    pub document_id: String,                // 文件路径
    pub original_content: String,           // 编辑前内容
    pub modified_content: String,           // 编辑后内容
    pub xml_modification: Option<String>,   // XML 修改协议
    pub status: String,                     // pending/applied/reverted
    pub active_snapshot_id: Option<String>, // 当前激活的快照 ID（用于重启恢复状态）
    /// 每个修改块的审批状态（JSON 格式）
    /// 例如: {"mod_1":"rejected","mod_2":"pending","mod_3":"applied"}
    /// 部分审批后持久化，重启时精确恢复各块状态而非启发式推断
    pub modification_statuses: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl DiffRecord {
    /// 创建新的 Diff 记录
    pub fn new(
        context_id: &str,
        message_id: &str,
        document_id: &str,
        original_content: &str,
        modified_content: &str,
    ) -> Self {
        let now = Utc::now().timestamp_millis();
        Self {
            id: Uuid::new_v4().to_string(),
            context_id: context_id.to_string(),
            message_id: message_id.to_string(),
            document_id: document_id.to_string(),
            original_content: original_content.to_string(),
            modified_content: modified_content.to_string(),
            xml_modification: None,
            status: DiffRecordStatus::Pending.as_str().to_string(),
            active_snapshot_id: None,
            modification_statuses: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// 创建带 XML 修改协议的 Diff 记录
    pub fn with_xml(
        context_id: &str,
        message_id: &str,
        document_id: &str,
        original_content: &str,
        modified_content: &str,
        xml_modification: &str,
    ) -> Self {
        let mut record = Self::new(
            context_id,
            message_id,
            document_id,
            original_content,
            modified_content,
        );
        record.xml_modification = Some(xml_modification.to_string());
        record
    }

    /// 获取状态枚举
    pub fn get_status(&self) -> Result<DiffRecordStatus, String> {
        self.status.parse()
    }
}

/// Diff 记录创建请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRecordCreateRequest {
    pub context_id: String,
    pub message_id: String,
    pub document_id: String,
    pub original_content: String,
    pub modified_content: String,
    pub xml_modification: Option<String>,
}

// ==================== Memory Trigger State ====================

/// 记忆触发器状态 - 持久化的触发条件计数器
///
/// 用于混合触发模型：
/// - 计数型（兜底）：turns_since_last_extract
/// - 语义型（主力）：candidate_signal_score
/// - 生命周期事件另行处理
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MemoryTriggerState {
    pub agent_id: String,
    /// 自上次提取以来的轮次数
    pub turns_since_last_extract: i64,
    /// 累积的候选信号分数（语义型信号）
    pub candidate_signal_score: f64,
    /// 上次提取时的轮次号
    pub last_extract_turn: i64,
    /// 上次处理的消息 ID（用于生命周期触发时检测内容变化）
    pub last_processed_message_id: Option<String>,
    /// 更新时间戳
    pub updated_at: i64,
}

impl MemoryTriggerState {
    /// 创建新的触发器状态（初始状态）
    pub fn new(agent_id: &str) -> Self {
        Self {
            agent_id: agent_id.to_string(),
            turns_since_last_extract: 0,
            candidate_signal_score: 0.0,
            last_extract_turn: 0,
            last_processed_message_id: None,
            updated_at: Utc::now().timestamp_millis(),
        }
    }
}

/// 触发器状态更新请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryTriggerStateUpdate {
    pub turns_since_last_extract: Option<i64>,
    pub candidate_signal_score: Option<f64>,
    pub last_extract_turn: Option<i64>,
}

// ==================== CronJob 定时任务数据结构 ====================

/// CronJob 实体 - 定时任务
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct CronJob {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    pub cron_expression: String,
    pub prompt: String,
    pub mode: String, // 'chat' | 'planning'
    pub enabled: bool,
    pub last_run_at: Option<i64>,
    pub next_run_at: Option<i64>,
    pub last_run_status: Option<String>, // 'success' | 'failed' | 'running'
    pub created_at: i64,
    pub updated_at: i64,
}

/// CronJob 创建请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CronJobCreate {
    pub agent_id: String,
    pub name: String,
    pub cron_expression: String,
    pub prompt: String,
    pub mode: String,
    pub enabled: Option<bool>,
    pub next_run_at: Option<i64>,
}

/// CronJob 更新请求
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CronJobUpdate {
    pub name: Option<String>,
    pub cron_expression: Option<String>,
    pub prompt: Option<String>,
    pub mode: Option<String>,
    pub enabled: Option<bool>,
    pub next_run_at: Option<i64>,
    pub last_run_at: Option<i64>,
    pub last_run_status: Option<String>,
}
