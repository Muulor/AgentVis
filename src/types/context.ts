/**
 * 对话相关类型定义
 *
 * 包含消息、上下文组装器等类型
 */

/** 消息角色 */
export type MessageRole = 'user' | 'assistant' | 'system';

/** 消息实体 */
export interface Message {
  id: string;
  agentId: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  deletedAt?: number;
  /** 元数据（思考过程、Token 统计等） */
  metadata?: {
    reasoningContent?: string;
    agentName?: string;
    [key: string]: unknown;
  };
  /** 发送此消息时引用的内容（用于溯源显示） */
  quotedFrom?: Array<{
    content: string;
    agentName?: string;
  }>;
}

/** 记忆层级 */
export type MemoryLayer = 'short_term' | 'summary' | 'fact';

/** 记忆类别 - 从 memory/types 统一使用 LongTermFactCategory */
import type { LongTermFactCategory } from '@services/memory/types';

/** 记忆实体 */
export interface Memory {
  id: string;
  agentId: string;
  layer: MemoryLayer;
  content: string;
  category?: LongTermFactCategory;
  importance?: number;
  sourceMessageIds?: string[];
  createdAt: number;
  updatedAt: number;
}

/** Agent 实体 */
export interface Agent {
  id: string;
  hubId: string;
  name: string;
  avatarColor?: string;
  avatar?: string; // base64 编码的自定义头像
  modelProvider?: string;
  modelName?: string;
  mbRulesFilePath?: string;
  saRulesFilePath?: string;
  mbRules?: string;
  saRules?: string;
  chatRules?: string;
  visualEnhancementEnabled?: boolean;
  sandboxMode?: 'LocalAudit' | 'OfflineIsolated' | 'ControlledNetwork';
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

/** 解析后的 @提及 */
export interface Mention {
  type: 'agent' | 'hub';
  name: string;
  id?: string;
  /** 原始文本起始位置 */
  startIndex: number;
  /** 原始文本结束位置 */
  endIndex: number;
}

/** 解析后的引用 */
export interface Quote {
  /** 引用内容 */
  content: string;
  /** 来源消息 ID */
  sourceMessageId?: string;
  /** 来源 Agent ID */
  sourceAgentId?: string;
}

/** 输入解析结果 */
export interface ParsedInput {
  /** 清理后的用户消息（移除 @提及语法） */
  cleanedContent: string;
  /** 原始输入 */
  originalContent: string;
  /** @提及列表 */
  mentions: Mention[];
  /** 引用列表 */
  quotes: Quote[];
  /** 是否为净空调用 (@AgentName 无后续内容) */
  isCleanCall: boolean;
}

/** 组装后的上下文 */
export interface AssembledContext {
  /** 完整的消息列表，准备发送给 LLM */
  messages: Array<{
    role: MessageRole;
    content: string;
  }>;
  /** 上下文元数据 */
  metadata: {
    /** System Prompt 来源 */
    systemPromptSource?: string;
    /** 注入的事实数量 */
    factsCount: number;
    /** 注入的摘要数量 */
    summariesCount: number;
    /** 滑动窗口消息数量 */
    windowMessagesCount: number;
    /** RAG 检索结果数量 */
    ragChunksCount: number;
    /** 引用内容数量 */
    quotesCount: number;
    /** 总 token 数估算 */
    estimatedTokens: number;
  };
}
