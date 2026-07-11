/**
 * EvidenceRetriever - 证据精准回溯器
 *
 * 根据 OpenQuestion 和当前 query 精准提取原文证据轮次，
 * 避免只召回问题或回答造成语义断裂。
 *
 * 设计原则：
 * - 返回最小必要原文
 * - 有明确的"为什么返回"
 * - 不让 LLM 在长文本里找重点
 */

import { invoke } from '@tauri-apps/api/core';
import type { OpenQuestion, Message } from './types';
import { getMemorySafeMessageContent } from './utils/SafeMessageContent';
import { getLogger } from '@services/logger';

const logger = getLogger('EvidenceRetriever');

// ==================== 类型定义 ====================

/**
 * 证据片段
 */
export interface EvidenceSlice {
  /** 轮次 ID（对话索引） */
  turnId: number;
  /** 发言者 */
  speaker: 'user' | 'assistant';
  /** 截取后的内容 */
  content: string;
  /** token 估算（简单按字符数 / 2 估算） */
  tokenCount: number;
  /** 相关性得分 */
  relevanceScore: number;
}

/**
 * 检索选项
 */
export interface RetrieveOptions {
  /** 最多返回片段数；兼容旧参数，未设置 maxEvidenceTurns 时按轮次数使用 */
  maxSlices?: number;
  /** 最多返回证据轮次数，默认 2 */
  maxEvidenceTurns?: number;
  /** 当前用户查询，用于 Evidence 相关性加权 */
  userQuery?: string;
  /** 单条 User 证据最大字符数 */
  maxUserChars?: number;
  /** 单条 Assistant 证据最大字符数 */
  maxAssistantChars?: number;
}

/**
 * 消息索引项（用于检索）
 */
interface MessageIndex {
  turnId: number;
  speaker: 'user' | 'assistant';
  content: string;
  keywords: string[];
  tokenCount: number;
}

/** 对话轮次索引项 */
interface TurnIndex {
  turnId: number;
  user?: MessageIndex;
  assistant?: MessageIndex;
  keywords: string[];
  content: string;
}

// ==================== 常量 ====================

const DEFAULT_MAX_EVIDENCE_TURNS = 2;
const DEFAULT_MAX_USER_CHARS = 500;
const DEFAULT_MAX_ASSISTANT_CHARS = 900;

// ==================== 主类 ====================

/**
 * 证据精准回溯器
 *
 * 核心流程：
 * 1. 将原文消息整理为 user/assistant 对话轮次
 * 2. 用 openQuestion + 当前 query 共同给 turn 打分
 * 3. 选中 turn 后成对返回 user 与 assistant
 * 4. 长 assistant 按相关段落裁剪
 */
export class EvidenceRetriever {
  /**
   * 根据 OpenQuestion 检索证据片段
   *
   * @param question - 开放性问题
   * @param messages - 原始消息列表
   * @param options - 检索选项
   * @returns 证据片段列表
   */
  retrieve(
    question: OpenQuestion,
    messages: Message[],
    options?: RetrieveOptions
  ): Promise<EvidenceSlice[]> {
    const maxEvidenceTurns =
      options?.maxEvidenceTurns ?? options?.maxSlices ?? DEFAULT_MAX_EVIDENCE_TURNS;
    const maxUserChars = options?.maxUserChars ?? DEFAULT_MAX_USER_CHARS;
    const maxAssistantChars = options?.maxAssistantChars ?? DEFAULT_MAX_ASSISTANT_CHARS;

    if (messages.length === 0) {
      return Promise.resolve([]);
    }

    const turns = this.buildTurnIndex(messages);
    if (turns.length === 0) {
      return Promise.resolve([]);
    }

    const relevanceKeywords = this.buildRelevanceKeywords(question, options?.userQuery);

    const topTurns = this.scoreTurns(turns, question, relevanceKeywords)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, maxEvidenceTurns);

    const slices = topTurns.flatMap((turn) =>
      this.buildEvidenceSlicesFromTurn(turn, relevanceKeywords, turn.relevanceScore, {
        maxUserChars,
        maxAssistantChars,
      })
    );

    logger.trace(
      `[EvidenceRetriever] 检索到 ${slices.length} 个证据片段，覆盖 ${topTurns.length} 个轮次，问题: "${question.question.substring(0, 30)}..."`
    );

    return Promise.resolve(slices);
  }

  /**
   * 根据 sourceMessageIds 加载消息并检索证据
   *
   * @param question - 开放性问题
   * @param sourceMessageIds - 源消息 ID 列表
   * @param options - 检索选项
   */
  async retrieveByIds(
    question: OpenQuestion,
    sourceMessageIds: string[],
    options?: RetrieveOptions
  ): Promise<EvidenceSlice[]> {
    if (sourceMessageIds.length === 0) {
      return [];
    }

    try {
      interface BackendMessage {
        id: string;
        role: string;
        content: string;
        metadata?: string | null;
        createdAt: number;
      }

      const messages = await invoke<BackendMessage[]>('message_get_batch', {
        ids: sourceMessageIds,
      });

      // 转换为 Message 格式
      const converted: Message[] = messages.map((m) => ({
        id: m.id,
        agentId: '',
        role: m.role as 'user' | 'assistant',
        content: getMemorySafeMessageContent(m),
        createdAt: m.createdAt,
      }));

      return await this.retrieve(question, converted, options);
    } catch (error) {
      logger.warn('[EvidenceRetriever] 批量查询消息失败:', error);
      return [];
    }
  }

  /**
   * 格式化为 Prompt 注入格式
   *
   * 格式：
   * 【待解决问题】
   * {question}
   *
   * 【相关对话证据（仅供参考）】
   * [Turn N - User/Assistant]
   * "content..."
   */
  formatForPrompt(question: OpenQuestion, slices: EvidenceSlice[]): string {
    if (slices.length === 0) {
      return '';
    }

    const evidenceLines = slices.map((slice) => {
      const speaker = slice.speaker === 'user' ? 'User' : 'Assistant';
      return `[Turn ${slice.turnId} - ${speaker}]\n"${slice.content}"`;
    });

    return `[Unresolved Question]
${question.question}

[Relevant Conversation Evidence - reference only]
${evidenceLines.join('\n\n')}`;
  }

  // ==================== 私有方法 ====================

  /**
   * 构建消息索引
   */
  private buildMessageIndex(messages: Message[]): MessageIndex[] {
    return messages.map((msg, idx) => {
      const keywords = this.extractKeywords(msg.content);
      // 简单 token 估算（中文按字符数，英文按单词数）
      const tokenCount = Math.ceil(msg.content.length / 2);

      return {
        turnId: Math.floor(idx / 2) + 1, // 每两条消息为一轮
        speaker: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
        keywords,
        tokenCount,
      };
    });
  }

  /**
   * 构建对话轮次索引
   */
  private buildTurnIndex(messages: Message[]): TurnIndex[] {
    const messageIndexes = this.buildMessageIndex(messages);
    const turns: TurnIndex[] = [];

    for (const message of messageIndexes) {
      if (message.speaker === 'user') {
        turns.push(this.createTurn(turns.length + 1, message));
        continue;
      }

      const lastTurn = turns.at(-1);
      if (lastTurn?.user && !lastTurn.assistant) {
        lastTurn.assistant = { ...message, turnId: lastTurn.turnId };
        this.refreshTurn(lastTurn);
      } else {
        turns.push(this.createTurn(turns.length + 1, undefined, message));
      }
    }

    return turns;
  }

  private createTurn(turnId: number, user?: MessageIndex, assistant?: MessageIndex): TurnIndex {
    const turn: TurnIndex = {
      turnId,
      user: user ? { ...user, turnId } : undefined,
      assistant: assistant ? { ...assistant, turnId } : undefined,
      keywords: [],
      content: '',
    };
    this.refreshTurn(turn);
    return turn;
  }

  private refreshTurn(turn: TurnIndex): void {
    const parts = [turn.user?.content, turn.assistant?.content].filter(Boolean);
    turn.content = parts.join('\n');
    turn.keywords = [
      ...new Set([...(turn.user?.keywords ?? []), ...(turn.assistant?.keywords ?? [])]),
    ];
  }

  /**
   * 计算轮次相关性得分
   *
   * 得分规则：
   * - turnHint 命中: +0.5
   * - openQuestion keywords 覆盖 >= 2: +0.3
   * - 当前 query keywords 覆盖 >= 2: +0.4
   * - 最近消息: +0.2
   */
  private scoreTurns(
    turns: TurnIndex[],
    question: OpenQuestion,
    relevanceKeywords: Set<string>
  ): Array<TurnIndex & { relevanceScore: number }> {
    const maxTurn = Math.max(...turns.map((turn) => turn.turnId));
    const questionKeywords = new Set([
      ...this.extractKeywords(question.question),
      ...this.extractKeywords(question.scope),
      ...(question.keywords ?? []).flatMap((keyword) => this.extractKeywords(keyword)),
    ]);
    const queryKeywords = new Set(
      [...relevanceKeywords].filter((keyword) => !questionKeywords.has(keyword))
    );
    const turnHints = new Set(question.turnHint ?? []);

    return turns.map((turn) => {
      let score = 0;

      // turnHint 加权
      if (
        turnHints.has(turn.turnId) ||
        turnHints.has(turn.turnId - 1) ||
        turnHints.has(turn.turnId + 1)
      ) {
        score += 0.5;
      }

      const matchedQuestionKeywords = this.countKeywordMatches(turn.keywords, questionKeywords);
      if (matchedQuestionKeywords >= 2) {
        score += 0.3;
      } else if (matchedQuestionKeywords >= 1) {
        score += 0.15;
      }

      const matchedQueryKeywords = this.countKeywordMatches(turn.keywords, queryKeywords);
      if (matchedQueryKeywords >= 2) {
        score += 0.4;
      } else if (matchedQueryKeywords >= 1) {
        score += 0.2;
      }

      // 完整问答轮比单边消息更适合作为可读证据
      if (turn.user && turn.assistant) {
        score += 0.1;
      }

      // 时间优先（越近越好）
      score += (turn.turnId / maxTurn) * 0.2;

      return { ...turn, relevanceScore: score };
    });
  }

  private countKeywordMatches(messageKeywords: string[], targetKeywords: Set<string>): number {
    if (targetKeywords.size === 0) {
      return 0;
    }

    return messageKeywords.filter((keyword) => targetKeywords.has(keyword)).length;
  }

  private buildEvidenceSlicesFromTurn(
    turn: TurnIndex,
    relevanceKeywords: Set<string>,
    relevanceScore: number,
    limits: { maxUserChars: number; maxAssistantChars: number }
  ): EvidenceSlice[] {
    const slices: EvidenceSlice[] = [];

    if (turn.user) {
      const content = this.clipContent(turn.user.content, relevanceKeywords, limits.maxUserChars);
      slices.push({
        turnId: turn.turnId,
        speaker: 'user',
        content,
        tokenCount: Math.ceil(content.length / 2),
        relevanceScore,
      });
    }

    if (turn.assistant) {
      const content = this.clipContent(
        turn.assistant.content,
        relevanceKeywords,
        limits.maxAssistantChars
      );
      slices.push({
        turnId: turn.turnId,
        speaker: 'assistant',
        content,
        tokenCount: Math.ceil(content.length / 2),
        relevanceScore,
      });
    }

    return slices;
  }

  private clipContent(content: string, relevanceKeywords: Set<string>, maxChars: number): string {
    if (content.length <= maxChars) {
      return content;
    }

    const paragraphs = content
      .split(/\n{2,}|\r?\n(?=#{1,6}\s|[-*]\s|\d+[.)]\s|[|])/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);

    if (paragraphs.length === 0) {
      return `${content.substring(0, maxChars)}...`;
    }

    const scored = paragraphs
      .map((paragraph, index) => ({
        paragraph,
        index,
        score: this.countKeywordMatches(this.extractKeywords(paragraph), relevanceKeywords),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);

    if (scored.length === 0) {
      return `${content.substring(0, maxChars)}...`;
    }

    const selected: Array<{ paragraph: string; index: number }> = [];
    let totalLength = 0;

    for (const item of scored) {
      const nextLength = totalLength + item.paragraph.length + (selected.length > 0 ? 2 : 0);
      if (nextLength > maxChars && selected.length > 0) {
        continue;
      }

      selected.push({ paragraph: item.paragraph, index: item.index });
      totalLength = nextLength;
      if (totalLength >= maxChars) {
        break;
      }
    }

    const clipped = selected
      .sort((a, b) => a.index - b.index)
      .map((item) => item.paragraph)
      .join('\n\n');

    return clipped.length > maxChars ? `${clipped.substring(0, maxChars)}...` : clipped;
  }

  private buildRelevanceKeywords(question: OpenQuestion, userQuery?: string): Set<string> {
    return new Set([
      ...this.extractKeywords(question.question),
      ...this.extractKeywords(question.scope),
      ...this.extractKeywords(question.reason),
      ...(question.keywords ?? []).flatMap((keyword) => this.extractKeywords(keyword)),
      ...this.extractKeywords(userQuery ?? ''),
    ]);
  }

  /**
   * 提取关键词
   */
  private extractKeywords(content: string): string[] {
    const lowerContent = content.toLowerCase();
    const words: string[] = [];

    const englishMatches = lowerContent.match(/[a-z][a-z0-9_$.-]*/g);
    if (englishMatches) {
      words.push(...englishMatches.filter((word) => word.length >= 2));
    }

    const chineseMatches = lowerContent.match(/[\u4e00-\u9fff]+/g);
    if (chineseMatches) {
      for (const segment of chineseMatches) {
        if (segment.length >= 2 && segment.length <= 8) {
          words.push(segment);
        }

        for (let i = 0; i < segment.length - 1; i++) {
          words.push(segment.substring(i, i + 2));
        }
      }
    }

    return [...new Set(words)];
  }
}

// ==================== 导出 ====================

/** 单例实例 */
let evidenceRetrieverInstance: EvidenceRetriever | null = null;

/**
 * 获取 EvidenceRetriever 单例
 */
export function getEvidenceRetriever(): EvidenceRetriever {
  evidenceRetrieverInstance ??= new EvidenceRetriever();
  return evidenceRetrieverInstance;
}

/**
 * 创建 EvidenceRetriever 实例
 */
export function createEvidenceRetriever(): EvidenceRetriever {
  return new EvidenceRetriever();
}
