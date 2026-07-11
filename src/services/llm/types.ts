/**
 * LLM Service 类型定义
 */

/** 聊天消息 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** 聊天选项 */
export interface ChatOptions {
  /** LLM 提供商 */
  provider?: string;
  /** 模型名称 */
  model?: string;
  /** 温度参数 */
  temperature?: number;
  /** 最大 token 数 */
  maxTokens?: number;
  /** 是否启用流式输出 */
  stream?: boolean;
}

/** 流式回调 */
export interface StreamCallbacks {
  /** 收到数据块 */
  onChunk?: (chunk: string) => void;
  /** 完成 */
  onComplete?: (fullContent: string) => void;
  /** 错误 */
  onError?: (error: Error) => void;
}

/** LLM Provider 信息 */
export interface ProviderInfo {
  id: string;
  name: string;
  models: string[];
  isConfigured: boolean;
}

/** 连接测试结果 */
export interface ConnectionTestResult {
  success: boolean;
  message?: string;
  latencyMs?: number;
}
