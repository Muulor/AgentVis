/**
 * ContextWindowManager - 上下文窗口管理器
 *
 * Memory-aware 但 Memory-subordinate 的上下文容量管理器
 *
 * 核心原则（重要）：
 * -  不生成新的语义结论（不调用 LLM 做摘要）
 * -  不决定信息重要性（由 Memory 系统负责）
 * -  只处理"装不装得下"
 * -  所有信息丢失都"显式可见"（TruncationNotice）
 *
 * 核心职责：
 * 1. 根据模型能力动态分配三层 token 预算
 * 2. 按优先级队列组装上下文内容
 * 3. 超限时纯截断 + 显式通知（不做语义压缩）
 *
 */

import { PLANNING_CONSTANTS } from './PlanningConstants';
import { formatTimestamp } from '@services/utils/TimeUtils';
import { getContextWindowMap } from '@/config/modelRegistry';

import { getLogger } from '@services/logger';

const logger = getLogger('ContextWindowManager');

// ==================== Memory 集成类型 ====================

/**
 * Memory 引用（ContextWindowManager 只读，不解析内容）
 */
export interface MemoryRef {
  id: string;
  label: string;
  sourceMessageIds: string[];
}

/**
 * Memory 系统提供的快照（唯一语义来源）
 *
 * ContextWindowManager 只能引用这些内容，不能加工或重新解释
 */
export interface MemorySnapshot {
  /** 已确认的事实（稳定） */
  stableFacts?: MemoryRef[];
  /** 尚未关闭的问题 */
  openQuestions?: MemoryRef[];
  /** Memory 层已生成的官方摘要（权威来源，可直接使用） */
  authoritativeSummary?: {
    text: string;
    tokenEstimate: number;
    sourceRange: [number, number]; // 原始消息范围 [startIdx, endIdx]
  };
}

// ==================== 裁剪通知类型 ====================

/** 被裁剪的内容项 */
export interface TruncatedItem {
  type: 'quotes' | 'rag' | 'attachment' | 'facts' | 'summaries' | 'history';
  droppedCount: number;
  droppedTokens: number;
}

/**
 * 裁剪通知（解决"信息黑洞"问题）
 *
 * 任何信息丢失都会显式记录，便于 debug 和模型感知
 */
export interface TruncationNotice {
  reason: 'CONTEXT_OVERFLOW' | 'HISTORY_OVERFLOW' | 'MODEL_LIMIT';
  /** 被裁剪的内容类型及范围 */
  truncatedItems: TruncatedItem[];
  /** 人类可读说明（可送给模型作为上下文提示） */
  note: string;
}

// ==================== 预算报告类型 ====================

/** 各层预算使用详情 */
export interface LayerBudgetDetail {
  budget: number;
  used: number;
  items: string[];
}

/** 上下文层优先级分解 */
export interface ContextLayerDetail extends LayerBudgetDetail {
  priorityBreakdown: Record<string, number>;
}

/**
 * 预算使用报告（Debug 和监控）
 */
export interface BudgetReport {
  modelContextWindow: number;
  layers: {
    identity: LayerBudgetDetail;
    context: ContextLayerDetail;
    historyAndOutput: {
      budget: number;
      historyUsed: number;
      outputReserve: number;
    };
  };
  totalUsed: number;
  remaining: number;
}

// ==================== 上下文分层输入 ====================

/**
 * 分层上下文内容（按优先级排列）
 *
 * 优先级顺序：quotes > rag > attachment > facts > summaries
 */
export interface ContextLayers {
  /** P1: 引用上下文（Hub @召唤，最高优先级） */
  quotes?: string;
  /** P2: RAG 知识库检索结果 */
  ragResults?: string;
  /** P3: 附件内容（文档解析结果） */
  attachments?: string;
  /** P4: 背景事实（来自 Memory 系统） */
  backgroundFacts?: string;
  /** P5: 摘要（来自 Memory 系统的 authoritativeSummary） */
  summaries?: string;
}

// ==================== 核心类型定义 ====================

/**
 * 消息类型（兼容多种来源）
 */
export interface ChatMessage {
  role: string;
  content: string;
  /** 消息创建时间戳（Unix ms），截断场景下渲染时间标签 */
  createdAt?: number;
  images?: Array<{ mime_type: string; data: string }>;
}

/**
 * 上下文预算配置（三层模型）
 */
export interface ContextBudget {
  /** 模型总上下文窗口 (tokens) */
  totalTokens: number;
  /** Layer 1: 身份层预算（Agent Rules + 偏好事实） */
  identityBudget: number;
  /** Layer 2: 上下文层预算（RAG/附件/引用等） */
  contextBudget: number;
  /** Layer 3: 历史 + 输出预算 */
  historyBudget: number;
  /** 输出预留（从 Layer 3 中划分） */
  outputReserve: number;
}

/** 上下文块（带截断标记） */
export interface ContextBlock {
  type: 'quotes' | 'rag' | 'attachment' | 'facts' | 'summaries';
  content: string;
  tokenEstimate: number;
  wasTruncated: boolean;
}

/**
 * 预处理后的上下文
 */
export interface PreparedContext {
  /** Layer 1: 身份层（Agent Rules + 偏好事实） */
  identityPrompt: string;
  /** Layer 2: 上下文块列表（按优先级排列） */
  contextBlocks: ContextBlock[];
  /** Layer 3: 处理后的对话历史文本 */
  conversationHistory: string;
  /** 历史消耗的 token 估算 */
  historyTokenEstimate: number;
  /** 剩余可用于输出的 token */
  remainingForOutput: number;
  /** 是否触发了任何裁剪 */
  wasTruncated: boolean;
  /** 原始消息数 */
  originalMessageCount: number;
  /** 实际使用的消息数 */
  usedMessageCount: number;
  /** 预算使用报告 */
  budgetReport: BudgetReport;
  /** 裁剪通知（如有） */
  truncationNotice?: TruncationNotice;
}

// ==================== 常量 ====================

/**
 * 模型上下文窗口配置
 *
 * 向后兼容重导出：从 modelRegistry 动态生成。
 * 新代码应直接使用 modelRegistry 的 getContextWindowSize() 函数。
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = getContextWindowMap();

/**
 * 三层预算比例配置
 *
 * Layer 1 (Identity): Agent Rules + 偏好事实 - 不可压缩
 * Layer 2 (Context): RAG/附件/引用等 - 按优先级分配
 * Layer 3 (History + Output): 对话历史 + 输出预留
 */
const BUDGET_RATIOS = {
  /** Layer 1: 身份层 10% */
  IDENTITY: 0.1,
  /** Layer 2: 上下文层 50%（RAG/附件/引用/记忆，Chat 模式下通常使用率 10-30%） */
  CONTEXT: 0.5,
  /** Layer 3: 历史 + 输出 40%（Chat 模式以多轮快速交流为主，需要更多历史预算） */
  HISTORY_AND_OUTPUT: 0.4,
  /** 输出预留（从 Layer 3 中划分）10% */
  OUTPUT_RESERVE: 0.1,
} as const;

/**
 * 上下文层优先级顺序
 *
 * 装不下时从低优先级（末尾）开始截断
 */
export const CONTEXT_PRIORITY = ['quotes', 'rag', 'attachment', 'facts', 'summaries'] as const;

/** 历史消息保留配置 */
export const HISTORY_CONFIG = {
  /** Chat 模式最大历史轮次（1 轮 = 1 对 user + assistant 消息）
   *  15 轮可覆盖约 3 个完整 Widget 交互流程，
   *  超过此轮次的早期对话由 Memory 系统摘要覆盖。
   */
  CHAT_MODE_MAX_HISTORY_ROUNDS: 15,
  /** 单条消息最大字符数 */
  MAX_MESSAGE_CHARS: 3000,
} as const;

// ==================== 主类 ====================

/**
 * 上下文窗口管理器
 *
 * Memory-aware 但 Memory-subordinate：
 * - 接收 Memory 提供的语义内容，但不加工或重新解释
 * - 只负责容量管理和优先级分配
 */
export class ContextWindowManager {
  /**
   * 估算文本的 token 数
   *
   * 简化规则：
   * - 中文：1 token ≈ 1.5 个字符
   * - 英文：1 token ≈ 4 个字符
   * - 混合文本取平均值
   */
  estimateTokens(text: string): number {
    if (!text) return 0;

    // 计算中文字符数
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
    // 计算英文和其他字符数
    const otherChars = text.length - chineseChars;

    // 中文约 1.5 字符/token，英文约 4 字符/token
    const chineseTokens = Math.ceil(chineseChars / 1.5);
    const otherTokens = Math.ceil(otherChars / 4);

    return chineseTokens + otherTokens;
  }

  /**
   * 获取模型的预算配置
   *
   * @param modelId 模型 ID
   */
  getBudget(modelId?: string): ContextBudget {
    // 获取模型的上下文窗口大小
    const modelKey = modelId ?? 'default';
    const totalTokens =
      MODEL_CONTEXT_WINDOWS[modelKey] ??
      MODEL_CONTEXT_WINDOWS['default'] ??
      PLANNING_CONSTANTS.DEFAULT_CONTEXT_WINDOW;

    const identityBudget = Math.floor(totalTokens * BUDGET_RATIOS.IDENTITY);
    const contextBudget = Math.floor(totalTokens * BUDGET_RATIOS.CONTEXT);
    const historyAndOutputBudget = Math.floor(totalTokens * BUDGET_RATIOS.HISTORY_AND_OUTPUT);
    const outputReserve = Math.floor(totalTokens * BUDGET_RATIOS.OUTPUT_RESERVE);

    return {
      totalTokens,
      identityBudget,
      contextBudget,
      historyBudget: historyAndOutputBudget - outputReserve,
      outputReserve,
    };
  }

  /**
   * 预处理对话上下文（核心方法 - 三层预算模型）
   *
   * 设计原则：
   * - 不生成语义摘要（由 Memory 系统负责）
   * - 按优先级队列分配上下文预算
   * - 超限时纯截断 + 显式通知
   *
   * @param chatHistory 对话历史
   * @param identityPrompt 身份层内容（Agent Rules + 偏好事实）
   * @param modelId 模型 ID
   * @param contextLayers 分层上下文内容（可选）
   * @returns 预处理后的上下文
   */
  prepareContext(
    chatHistory: ChatMessage[],
    identityPrompt?: string,
    modelId?: string,
    contextLayers?: ContextLayers,
    maxRounds?: number
  ): Promise<PreparedContext> {
    // 轮次截断：在 token 预算管理之前执行，避免对超长历史做无意义的 token 估算
    if (maxRounds !== undefined && maxRounds > 0) {
      const originalCount = chatHistory.length;
      chatHistory = this.capByRounds(chatHistory, maxRounds);
      if (chatHistory.length < originalCount) {
        logger.trace(
          `[ContextWindowManager] 轮次截断: 原始 ${originalCount} 条 → ${chatHistory.length} 条 (maxRounds=${maxRounds})`
        );
      }
    }

    const budget = this.getBudget(modelId);
    const identity = identityPrompt ?? '';
    const identityTokens = this.estimateTokens(identity);

    logger.trace(
      `[ContextWindowManager] 模型: ${modelId ?? 'default'}, 总预算: ${budget.totalTokens} tokens`
    );
    logger.trace(
      `[ContextWindowManager] 三层预算: Identity=${budget.identityBudget}, Context=${budget.contextBudget}, History=${budget.historyBudget}`
    );
    logger.trace(`[ContextWindowManager] Identity 使用: ${identityTokens} tokens`);

    // 初始化裁剪记录
    const truncatedItems: TruncatedItem[] = [];
    let wasTruncated = false;

    // ==================== Layer 1: 身份层（不可压缩） ====================
    // 如果超出 Identity 预算，从 Context 预算借用
    const identityOverflow = Math.max(0, identityTokens - budget.identityBudget);
    const effectiveContextBudget = budget.contextBudget - identityOverflow;

    if (identityOverflow > 0) {
      logger.trace(
        `[ContextWindowManager]  Identity 超出预算 ${identityOverflow} tokens，从 Context 借用`
      );
    }

    // ==================== Layer 2: 上下文层（优先级分配） ====================
    const contextBlocks: ContextBlock[] = [];
    let contextUsed = 0;
    const priorityBreakdown: Record<string, number> = {};

    // 按优先级顺序分配：quotes > rag > attachment > facts > summaries
    const layerMapping: Array<{ key: keyof ContextLayers; type: ContextBlock['type'] }> = [
      { key: 'quotes', type: 'quotes' },
      { key: 'ragResults', type: 'rag' },
      { key: 'attachments', type: 'attachment' },
      { key: 'backgroundFacts', type: 'facts' },
      { key: 'summaries', type: 'summaries' },
    ];

    for (const { key, type } of layerMapping) {
      const content = contextLayers?.[key];
      if (!content) continue;

      const contentTokens = this.estimateTokens(content);
      const remainingBudget = effectiveContextBudget - contextUsed;

      if (contentTokens <= remainingBudget) {
        // 完整放入
        contextBlocks.push({
          type,
          content,
          tokenEstimate: contentTokens,
          wasTruncated: false,
        });
        contextUsed += contentTokens;
        priorityBreakdown[type] = contentTokens;
        logger.trace(`[ContextWindowManager]  ${type}: ${contentTokens} tokens`);
      } else if (remainingBudget > 200) {
        // 部分放入（截断）
        const truncatedContent = this.truncateContent(content, remainingBudget);
        const truncatedTokens = this.estimateTokens(truncatedContent);
        contextBlocks.push({
          type,
          content: truncatedContent,
          tokenEstimate: truncatedTokens,
          wasTruncated: true,
        });
        contextUsed += truncatedTokens;
        priorityBreakdown[type] = truncatedTokens;
        wasTruncated = true;
        truncatedItems.push({
          type,
          droppedCount: 1,
          droppedTokens: contentTokens - truncatedTokens,
        });
        logger.trace(
          `[ContextWindowManager]  ${type}: 截断 ${contentTokens} → ${truncatedTokens} tokens`
        );
      } else {
        // 完全丢弃
        wasTruncated = true;
        truncatedItems.push({
          type,
          droppedCount: 1,
          droppedTokens: contentTokens,
        });
        logger.trace(`[ContextWindowManager]  ${type}: 完全丢弃 (${contentTokens} tokens)`);
      }
    }

    // ==================== Layer 3: 历史层（使用剩余预算）====================
    const historyText = this.formatHistoryFull(chatHistory);
    const historyTokens = this.estimateTokens(historyText);
    let conversationHistory: string;
    let usedMessageCount = chatHistory.length;

    logger.trace(
      `[ContextWindowManager] 对话历史: ${chatHistory.length} 条, ${historyTokens} tokens`
    );
    logger.trace(`[ContextWindowManager] 历史预算: ${budget.historyBudget} tokens`);

    if (historyTokens <= budget.historyBudget) {
      // 历史完整放入
      conversationHistory = historyText;
      logger.trace('[ContextWindowManager] 历史未超预算，完整保留');
    } else {
      // 历史超限，纯截断（不调用 LLM 生成摘要）
      logger.trace('[ContextWindowManager] 历史超出预算，执行截断（不生成摘要）');
      const truncated = this.truncateHistory(chatHistory, budget.historyBudget);
      conversationHistory = truncated.text;
      usedMessageCount = truncated.usedCount;
      wasTruncated = true;
      truncatedItems.push({
        type: 'history',
        droppedCount: chatHistory.length - truncated.usedCount,
        droppedTokens: historyTokens - this.estimateTokens(truncated.text),
      });
    }

    const finalHistoryTokens = this.estimateTokens(conversationHistory);

    // ==================== 构建预算报告 ====================
    const totalUsed = identityTokens + contextUsed + finalHistoryTokens;
    const budgetReport: BudgetReport = {
      modelContextWindow: budget.totalTokens,
      layers: {
        identity: {
          budget: budget.identityBudget,
          used: identityTokens,
          items: ['agentRules', 'preferencesFacts'],
        },
        context: {
          budget: budget.contextBudget,
          used: contextUsed,
          items: contextBlocks.map((b) => b.type),
          priorityBreakdown,
        },
        historyAndOutput: {
          budget: budget.historyBudget + budget.outputReserve,
          historyUsed: finalHistoryTokens,
          outputReserve: budget.outputReserve,
        },
      },
      totalUsed,
      remaining: budget.totalTokens - totalUsed,
    };

    // ==================== 构建裁剪通知 ====================
    let truncationNotice: TruncationNotice | undefined;
    if (wasTruncated) {
      const droppedTypes = truncatedItems.map((i) => i.type).join(', ');
      truncationNotice = {
        reason: truncatedItems.some((i) => i.type === 'history')
          ? 'HISTORY_OVERFLOW'
          : 'CONTEXT_OVERFLOW',
        truncatedItems,
        note: `Because of the context window limit, the following content was truncated or omitted: ${droppedTypes}. Earlier conversation content has been handled by the Memory system.`,
      };
      logger.trace(`[ContextWindowManager] 裁剪通知: ${truncationNotice.note}`);
    }

    logger.trace(
      `[ContextWindowManager] 预算使用: ${totalUsed}/${budget.totalTokens} (${((totalUsed / budget.totalTokens) * 100).toFixed(1)}%)`
    );

    return Promise.resolve({
      identityPrompt: identity,
      contextBlocks,
      conversationHistory,
      historyTokenEstimate: finalHistoryTokens,
      remainingForOutput: budget.outputReserve,
      wasTruncated,
      originalMessageCount: chatHistory.length,
      usedMessageCount,
      budgetReport,
      truncationNotice,
    });
  }

  /**
   * 截断内容到指定 token 预算
   */
  private truncateContent(content: string, maxTokens: number): string {
    // 粗略估算：平均每个字符约 0.4 token
    const estimatedChars = Math.floor(maxTokens * 2.5);
    if (content.length <= estimatedChars) {
      return content;
    }
    return content.substring(0, estimatedChars) + '\n\n... [Content truncated]';
  }

  /**
   * 截断对话历史（纯截断，不生成摘要）
   *
   * 策略：保留最近 N 条完整消息，丢弃更早的消息
   */
  private truncateHistory(
    messages: ChatMessage[],
    targetTokens: number
  ): { text: string; usedCount: number } {
    // 从最新消息开始，向前保留直到达到预算
    const result: string[] = [];
    let currentTokens = 0;
    let usedCount = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg) continue;

      const role = msg.role === 'assistant' ? 'Agent' : 'User';
      let content = msg.content;

      // 截断过长的单条消息
      if (content.length > HISTORY_CONFIG.MAX_MESSAGE_CHARS) {
        content =
          content.substring(0, HISTORY_CONFIG.MAX_MESSAGE_CHARS) + '\n... [Message truncated]';
      }

      // 仅给 user 消息注入时间标签：assistant 消息如果也带时间戳，
      // LLM 会通过 in-context learning 模仿该格式在输出中附带时间戳
      const timeLabel =
        msg.role === 'user' && msg.createdAt ? `[${formatTimestamp(msg.createdAt)}] ` : '';
      const formatted = `${timeLabel}**${role}**:\n${content}`;
      const msgTokens = this.estimateTokens(formatted);

      if (currentTokens + msgTokens > targetTokens) {
        break;
      }

      result.unshift(formatted);
      currentTokens += msgTokens;
      usedCount++;
    }

    if (result.length === 0) {
      return { text: '(History too long; omitted)', usedCount: 0 };
    }

    // 如果有消息被丢弃，添加提示
    if (usedCount < messages.length) {
      const droppedCount = messages.length - usedCount;
      result.unshift(
        `> ${droppedCount} earlier conversation messages were omitted; their semantics are handled by the Memory system.\n`
      );
    }

    return {
      text: result.join('\n\n---\n\n'),
      usedCount,
    };
  }

  /**
   * 按轮次截断对话历史
   *
   * 从最新消息往前计数，每遇到一条 user 消息即计一轮，
   * 达到 maxRounds 后丢弃更早的消息。
   * 确保截断后的首条消息是 user 角色，避免孤立的 assistant 消息。
   */
  private capByRounds(messages: ChatMessage[], maxRounds: number): ChatMessage[] {
    if (messages.length === 0 || maxRounds <= 0) return messages;

    let roundCount = 0;
    let cutIndex = 0;

    // 从末尾开始反向遍历，每条 user 消息标记一轮
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') {
        roundCount++;
        if (roundCount > maxRounds) {
          cutIndex = i + 1;
          break;
        }
      }
    }

    return messages.slice(cutIndex);
  }

  /**
   * 格式化完整对话历史
   */
  private formatHistoryFull(messages: ChatMessage[]): string {
    if (messages.length === 0) {
      return '(No conversation history)';
    }

    return messages
      .map((msg) => {
        const role = msg.role === 'assistant' ? 'Agent' : 'User';
        // 仅给 user 消息注入时间标签（防止 LLM 模仿 assistant 时间戳格式）
        const timeLabel =
          msg.role === 'user' && msg.createdAt ? `[${formatTimestamp(msg.createdAt)}] ` : '';
        return `${timeLabel}**${role}**:\n${msg.content}`;
      })
      .join('\n\n---\n\n');
  }

  /**
   * 格式化对话历史（带截断）
   */
  formatHistory(messages: ChatMessage[], maxTokens: number): string {
    if (messages.length === 0) {
      return '(No conversation history)';
    }

    const maxChars = PLANNING_CONSTANTS.MAX_DOCUMENT_PREVIEW_LENGTH;
    const result: string[] = [];
    let currentTokens = 0;

    // 从最新消息开始，向前遍历
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg) continue;

      const role = msg.role === 'assistant' ? 'Agent' : 'User';
      let content = msg.content;

      // 截断过长的单条消息
      if (content.length > maxChars) {
        content = content.substring(0, maxChars) + '\n\n... [Content truncated]';
      }

      const timeLabel =
        msg.role === 'user' && msg.createdAt ? `[${formatTimestamp(msg.createdAt)}] ` : '';
      const formatted = `${timeLabel}**${role}**:\n${content}`;
      const msgTokens = this.estimateTokens(formatted);

      if (currentTokens + msgTokens > maxTokens) {
        // 已超过预算，停止添加
        break;
      }

      result.unshift(formatted);
      currentTokens += msgTokens;
    }

    if (result.length === 0) {
      return '(History too long; omitted)';
    }

    return result.join('\n\n---\n\n');
  }
}

// ==================== 单例导出 ====================

/**
 * 单例实例
 */
export const contextWindowManager = new ContextWindowManager();
