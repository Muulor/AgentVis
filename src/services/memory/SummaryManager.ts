/**
 * SummaryManager - 摘要管理器
 *
 * 调用 LLM 生成交互对摘要，实现 Chain-of-State 状态接力：
 * 每次压缩时注入上一轮摘要的前置状态（已确认结论 + 遗留问题），
 * 使 LLM 能感知历史进展并正确判断新对话是否推翻或解决了旧状态。
 */

import { invoke } from '@tauri-apps/api/core';
import type { Message, SummaryResult, LLMService } from './types';
import { parseWithFallback } from './utils/JsonParser';
import { getMemoryVectorIndex } from './MemoryVectorIndex';
import { getLogger } from '@services/logger';
import { SOURCE_LANGUAGE_PRESERVATION_RULES } from './PromptLanguagePolicy';

const logger = getLogger('SummaryManager');

/**
 * 前置摘要状态（Chain-of-State 接力载体）
 *
 * 仅传递上一轮摘要中提炼的最小状态，作为只读参考：
 * - confirmedDecisions：已成立的结论，供检测当前对话是否构成推翻
 * - openQuestions：遗留问题，供判断当前对话是否已解答
 * - invalidatedPoints 不参与接力（已失效信息无需延续）
 */
export interface PriorSummaryState {
  /** 上一批对话中已确认的结论（只读冲突检测参考，不得原样写入新摘要） */
  confirmedDecisions: string[];
  /** 上一批对话中的遗留问题（只读参考，判断当前对话是否已解答） */
  openQuestions: Array<{
    question: string;
    scope: string;
  }>;
}

/**
 * 构建前置状态注入文本
 *
 * 措辞精准区分"只读历史参考"与"当前批次提取"，
 * 防止 LLM 将旧决策原样继承导致 confirmedDecisions 无限积累。
 */
export function buildPriorStateText(priorState: PriorSummaryState | null): string {
  if (!priorState) {
    return '(No prior state. This is the first conversation summary for this Agent.)';
  }

  const parts: string[] = [];

  if (priorState.confirmedDecisions.length > 0) {
    parts.push(
      '### Historically Confirmed Decisions (read-only conflict reference; do not copy directly into the new summary confirmedDecisions)\n' +
        priorState.confirmedDecisions.map((d) => `- ${d}`).join('\n')
    );
  }

  if (priorState.openQuestions.length > 0) {
    parts.push(
      '### Historical Open Questions (read-only reference; use only to judge whether the current conversation answered them)\n' +
        priorState.openQuestions.map((q) => `- ${q.question} (${q.scope})`).join('\n')
    );
  }

  return parts.join('\n\n');
}

/** 摘要生成 Prompt 模板（状态型，支持可选前置状态注入） */
const SUMMARY_PROMPT_TEMPLATE = `You are a "conversation state summarization assistant". Your goal is not to retell the conversation, but to distill the **currently still-valid conversation state** and provide structured information for later system decisions.

-----
## Prior Conversation State (read-only historical reference; do not copy into output fields)
{prior_state}

-----
## Current Conversation Content (the only information source for this summary)
{conversations}

-----
## Task
Based on the **current conversation content**, distill:
1. Conclusions or decisions that have been reached and have not been overturned later in the conversation.
2. Issues that are still unresolved and **require going back to the original conversation content to continue**.
3. Ideas or plans that have been explicitly rejected, replaced, or made no longer applicable.

## Critical Constraints (strictly follow)
- **confirmedDecisions must only extract conclusions that appear in the current conversation**. Do not copy historically confirmed decisions directly.
- Historical decisions are only for conflict detection: if the current conversation explicitly overturns a historical decision, record the overturned old decision in invalidatedPoints and record the new conclusion produced by the current conversation in confirmedDecisions.
- If the current conversation has no obvious relationship to the historical state, ignore the prior state and focus on extracting information from the current conversation.
- If a historical open question is answered in the current conversation, write the answer into confirmedDecisions and do not keep that question.
- If a question can be answered from the summary alone, do not list it in openQuestions.
- If there are no unresolved questions, openQuestions must be an empty array [].
- All fields must be stable and predictable; avoid free-form invention.

${SOURCE_LANGUAGE_PRESERVATION_RULES}

## Output Format (strict JSON; no extra text)
{
  "summary": "A concise summary of the current conversation state, enough to understand overall progress without reading the original conversation",

  "keyPoints": [
    "Key state point 1",
    "Key state point 2"
  ],

  "topics": [
    "Topic 1",
    "Topic 2"
  ],

  "mentionedFiles": [
    "path/to/file1.ts"
  ],

  "confirmedDecisions": [
    "A clearly confirmed conclusion or decision from the current conversation only"
  ],

  "openQuestions": [
    {
      "question": "The unresolved question itself, in one clear and specific sentence",
      "scope": "The topic or subsystem this question belongs to, such as retrieval_strategy / architecture / implementation / performance / api_design",
      "reason": "Why this question cannot be answered from the summary alone and requires going back to the original conversation",
      "turnHint": [1, 2],
      "keywords": ["keywords or phrases for locating the original conversation"]
    }
  ],

  "invalidatedPoints": [
    "An idea explicitly rejected, replaced, or made no longer applicable in the current conversation, including overturned historical decisions"
  ]
}

Remember: output JSON only, with no other content.`;

export function buildSummaryPrompt(
  conversations: string,
  priorState: PriorSummaryState | null
): string {
  const priorStateText = buildPriorStateText(priorState);

  return SUMMARY_PROMPT_TEMPLATE.replace('{prior_state}', priorStateText).replace(
    '{conversations}',
    conversations
  );
}

/** 待重试的向量索引条目（Embedding API 失败时暫存） */
interface PendingIndexEntry {
  summaryId: string;
  indexText: string;
}

/**
 * 摘要管理器类
 */
export class SummaryManager {
  private llm: LLMService;
  private agentId: string;
  // Embedding API 失败时的待重试队列，在 checkWatermarkOnResume 时补索引
  private _pendingIndexEntries: PendingIndexEntry[] = [];

  constructor(llm: LLMService, agentId: string) {
    this.llm = llm;
    this.agentId = agentId;
  }

  /**
   * 为交互对批次生成摘要（Chain-of-State 版本）
   *
   * @param input - 当前批次的消息列表（唯一的信息提取来源）
   * @param priorState - 上一轮摘要的前置状态（可选，用于冲突检测与遗留问题追踪）
   * @returns 摘要结果
   */
  async generateSummary(
    input: Message[],
    priorState?: PriorSummaryState | null
  ): Promise<SummaryResult> {
    if (input.length === 0) {
      return { summary: '', keyPoints: [] };
    }

    logger.trace('[SummaryManager]  开始生成摘要');
    logger.trace('[SummaryManager] 输入消息数量:', input.length);
    logger.trace(
      '[SummaryManager] 前置状态:',
      priorState
        ? `confirmedDecisions=${priorState.confirmedDecisions.length}, openQuestions=${priorState.openQuestions.length}`
        : '无（首条摘要）'
    );

    // 按时间序标注角色
    const conversations = input
      .map(
        (msg, idx) => `[#${idx + 1} ${msg.role === 'user' ? 'User' : 'Assistant'}] ${msg.content}`
      )
      .join('\n');

    // 构建含前置状态的 Prompt（无前置状态时注入占位文本，保持格式一致）
    const prompt = buildSummaryPrompt(conversations, priorState ?? null);
    logger.trace('[SummaryManager] Prompt 长度:', prompt.length);
    // 打印完整 Prompt，方便观测前置状态（confirmedDecisions/openQuestions）是否准确注入
    logger.trace(
      `[SummaryManager] ===== 完整 Prompt 开始 =====\n${prompt}\n[SummaryManager] ===== 完整 Prompt 结束 =====`
    );

    try {
      logger.trace('[SummaryManager] 调用 LLM...');
      const response = await this.llm.generate(prompt, {
        temperature: 1,
        maxTokens: 24576,
      });

      logger.trace('[SummaryManager]  LLM 响应成功');
      logger.trace('[SummaryManager] 响应内容:', response.substring(0, 300));

      const result = this.parseSummaryResponse(response);
      logger.trace('[SummaryManager] 解析结果:', result.summary.substring(0, 100));
      logger.trace('[SummaryManager]  状态字段:', {
        confirmedDecisions: result.confirmedDecisions?.length ?? 0,
        openQuestions: result.openQuestions?.length ?? 0,
        invalidatedPoints: result.invalidatedPoints?.length ?? 0,
      });
      if (result.confirmedDecisions && result.confirmedDecisions.length > 0) {
        logger.trace('[SummaryManager]  confirmedDecisions:', result.confirmedDecisions);
      }
      if (result.openQuestions && result.openQuestions.length > 0) {
        logger.trace('[SummaryManager]  openQuestions:', result.openQuestions);
      }
      if (result.invalidatedPoints && result.invalidatedPoints.length > 0) {
        logger.trace('[SummaryManager]  invalidatedPoints:', result.invalidatedPoints);
      }
      return result;
    } catch (error) {
      // 不做降级：直接抛出异常让调用方决定是否保留 short_term 记录
      // 降级拼接文本缺少 openQuestions/confirmedDecisions 等结构化字段，
      // 保存后 short_term 记录会被删除，导致原始对话上下文不可逆丢失
      logger.error('[SummaryManager] 摘要生成失败，将保留 short_term 记录等待重试:', error);
      throw error;
    }
  }

  /**
   * 保存摘要到数据库
   *
   * @param summaryResult - 完整的摘要结果（包含状态字段）
   * @param sourceMessageIds - 源消息 ID 列表
   */
  async saveSummary(summaryResult: SummaryResult, sourceMessageIds: string[]): Promise<string> {
    // 构建状态字段 JSON（openQuestions、confirmedDecisions、invalidatedPoints 等）
    const metadata: Record<string, unknown> = {};
    if (summaryResult.keyPoints.length > 0) {
      metadata.keyPoints = summaryResult.keyPoints;
    }
    if (summaryResult.topics && summaryResult.topics.length > 0) {
      metadata.topics = summaryResult.topics;
    }
    if (summaryResult.mentionedFiles && summaryResult.mentionedFiles.length > 0) {
      metadata.mentionedFiles = summaryResult.mentionedFiles;
    }
    if (summaryResult.confirmedDecisions && summaryResult.confirmedDecisions.length > 0) {
      metadata.confirmedDecisions = summaryResult.confirmedDecisions;
    }
    if (summaryResult.openQuestions && summaryResult.openQuestions.length > 0) {
      metadata.openQuestions = summaryResult.openQuestions;
    }
    if (summaryResult.invalidatedPoints && summaryResult.invalidatedPoints.length > 0) {
      metadata.invalidatedPoints = summaryResult.invalidatedPoints;
    }

    const metadataJson = Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : undefined;

    const result = await invoke<{ id: string }>('memory_create', {
      request: {
        agentId: this.agentId,
        layer: 'summary',
        content: summaryResult.summary,
        sourceMessageIds: JSON.stringify(sourceMessageIds),
        metadataJson,
      },
    });

    // 构建增强的索引文本（包含更多语义信息）
    const indexText = this.buildIndexText(summaryResult);

    // 尝试创建向量索引，失败时记录到待重试队列
    const vectorIndex = getMemoryVectorIndex();
    try {
      await vectorIndex.indexSummary(this.agentId, result.id, indexText);
    } catch (indexError) {
      // Embedding API 失败 → 记录到待重试队列，下次 resume 时补索引
      logger.warn(`[SummaryManager] 向量索引失败，加入待重试队列: ${result.id}`, indexError);
      this._pendingIndexEntries.push({
        summaryId: result.id,
        indexText,
      });
    }

    return result.id;
  }

  /**
   * 重试队列中的待索引摘要
   *
   * 当 Embedding API 恢复后（如 Zhipu API Key 修复），
   * 由 MemoryService.checkWatermarkOnResume() 调用此方法补索引。
   *
   * @returns 成功索引的数量
   */
  async retryPendingIndexes(): Promise<number> {
    if (this._pendingIndexEntries.length === 0) return 0;

    logger.trace(`[SummaryManager] 开始重试 ${this._pendingIndexEntries.length} 个待索引摘要`);
    const vectorIndex = getMemoryVectorIndex();
    let successCount = 0;
    const stillPending: PendingIndexEntry[] = [];

    for (const entry of this._pendingIndexEntries) {
      try {
        await vectorIndex.indexSummary(this.agentId, entry.summaryId, entry.indexText);
        successCount++;
        logger.trace(`[SummaryManager] 补索引成功: ${entry.summaryId}`);
      } catch (retryError) {
        // 仍然失败，保留在队列中等待下次重试
        logger.warn(`[SummaryManager] 补索引仍失败: ${entry.summaryId}`, retryError);
        stillPending.push(entry);
      }
    }

    this._pendingIndexEntries = stillPending;
    logger.trace(
      `[SummaryManager] 补索引完成: 成功 ${successCount}, 仍待重试 ${stillPending.length}`
    );
    return successCount;
  }

  /** 是否有待重试的索引条目 */
  get hasPendingIndexes(): boolean {
    return this._pendingIndexEntries.length > 0;
  }

  /**
   * 构建增强的索引文本
   *
   * 将 summary + keyPoints + confirmedDecisions + openQuestions 合并，
   * 提高语义召回的覆盖率
   */
  private buildIndexText(result: SummaryResult): string {
    const parts: string[] = [];

    // 主摘要
    parts.push(result.summary);

    // 主题（添加前缀标签，提高语义匹配权重）
    if (result.topics && result.topics.length > 0) {
      parts.push(`Topics: ${result.topics.join(', ')}`);
    }

    // 关键点
    if (result.keyPoints.length > 0) {
      parts.push(result.keyPoints.join(' '));
    }

    // 已确认决策
    if (result.confirmedDecisions && result.confirmedDecisions.length > 0) {
      parts.push(result.confirmedDecisions.join(' '));
    }

    // 待决问题（取 question + keywords，扩大召回范围）
    if (result.openQuestions && result.openQuestions.length > 0) {
      const questions = result.openQuestions.map((q) => {
        const keywords = q.keywords?.join(' ') ?? '';
        return `${q.question} ${keywords}`.trim();
      });
      parts.push(questions.join(' '));
    }

    // 已失效观点
    if (result.invalidatedPoints && result.invalidatedPoints.length > 0) {
      parts.push(result.invalidatedPoints.join(' '));
    }

    return parts.join(' ');
  }

  /**
   * 获取 Agent 的所有摘要（含状态元数据）
   *
   * 返回 metadataJson 供 Chain-of-State 接力机制读取前置状态。
   * Rust 端 memory_list_by_layer 已返回此字段，IPC 无需变更。
   */
  async getSummaries(): Promise<
    Array<{
      id: string;
      content: string;
      createdAt: number;
      metadataJson?: string | null;
    }>
  > {
    // 注意：Rust MemoryItem 使用 #[serde(rename_all = "camelCase")]，
    // 字段名必须与 Rust 序列化输出保持一致（camelCase），否则字段永远为 undefined
    const result = await invoke<
      Array<{
        id: string;
        content: string;
        createdAt: number;
        metadataJson?: string | null;
      }>
    >('memory_list_by_layer', {
      agentId: this.agentId,
      layer: 'summary',
    });

    return result.map((r) => ({
      id: r.id,
      content: r.content,
      createdAt: r.createdAt,
      metadataJson: r.metadataJson,
    }));
  }

  /**
   * 解析摘要响应（状态型）
   *
   * 使用统一的 JsonParser 处理各种格式问题
   * 支持新版状态字段：confirmedDecisions、openQuestions、invalidatedPoints
   */
  private parseSummaryResponse(response: string): SummaryResult {
    interface OpenQuestionParsed {
      question?: string;
      scope?: string;
      reason?: string;
      turnHint?: number[];
      keywords?: string[];
    }

    interface SummaryParsedResult {
      summary?: string;
      keyPoints?: string[];
      topics?: string[];
      mentionedFiles?: string[];
      confirmedDecisions?: string[];
      openQuestions?: OpenQuestionParsed[];
      invalidatedPoints?: string[];
    }

    const result = parseWithFallback<SummaryParsedResult>(response, {
      verbose: true,
      logPrefix: '[SummaryManager]',
    });

    if (result.success && result.data) {
      const parsed = result.data;

      // 解析 openQuestions（确保结构完整）
      const openQuestions = Array.isArray(parsed.openQuestions)
        ? parsed.openQuestions.flatMap((q) => {
            if (typeof q.question !== 'string') return [];
            return [
              {
                question: q.question,
                scope: q.scope ?? 'general',
                reason: q.reason ?? '',
                turnHint: Array.isArray(q.turnHint) ? q.turnHint : undefined,
                keywords: Array.isArray(q.keywords) ? q.keywords : undefined,
              },
            ];
          })
        : undefined;

      return {
        summary: parsed.summary ?? '',
        keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
        topics: Array.isArray(parsed.topics) ? parsed.topics : undefined,
        mentionedFiles: Array.isArray(parsed.mentionedFiles) ? parsed.mentionedFiles : undefined,
        confirmedDecisions: Array.isArray(parsed.confirmedDecisions)
          ? parsed.confirmedDecisions
          : undefined,
        openQuestions: openQuestions && openQuestions.length > 0 ? openQuestions : undefined,
        invalidatedPoints: Array.isArray(parsed.invalidatedPoints)
          ? parsed.invalidatedPoints
          : undefined,
      };
    }

    // 解析失败，降级为原始文本
    logger.warn('[SummaryManager] JSON 解析失败，使用原始文本');
    return {
      summary: response.trim(),
      keyPoints: [],
    };
  }
}

/**
 * 创建 SummaryManager 实例
 */
export function createSummaryManager(llm: LLMService, agentId: string): SummaryManager {
  return new SummaryManager(llm, agentId);
}
