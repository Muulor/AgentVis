/**
 * SubAgentRunner - 子智能体执行器
 *
 * 执行单个 Sub-Agent 任务
 *
 * 职责：
 * - 执行 LLM 调用
 * - 强制工具白名单
 * - 验证输出 Schema
 * - 检测策略违规
 * - 动态决策 Loop 执行（v2）
 */

import type {
  SubAgentSpec,
  CheckpointCallback,
  ExternalGuideSkillInfo,
  ExternalScriptSkillInfo,
} from '../brain/types';
import type { SubAgentObservationEvent } from '../agent-loop/types';
import { isExecCommandSafe } from '../skills/exec/ExecSafetyPolicy';
import type {
  SubAgentOutput,
  TaskContext,
  SubAgentLoopConfig,
  ProgressReport,
  AccumulatedMessage,
  FileWriteDiffRecord,
} from './types';
import { createFailedOutput } from './types';
import { useHitlStore } from '@stores/hitlStore';
import { SubAgentFactory } from './SubAgentFactory';
import type { SkillDefinition } from '../skills/types';
import { ToolOutputCompressor } from './ToolOutputCompressor';
import { PLANNING_CONSTANTS } from '../PlanningConstants';
import type { TaskArtifactStore } from '../artifact/TaskArtifactStore';
import type { ArtifactDataType } from '../artifact/types';
import { getLogger } from '@services/logger';
import { translate } from '@/i18n';
import {
  getAgentLoopErrorKindForTerminationReason,
  getAgentLoopErrorSummary,
} from '../agent-loop/ErrorObservationFormatter';
import {
  classifyLlmRetry,
  getLlmRetryDelayMs,
  SUB_AGENT_LLM_RETRY_DELAYS_MS,
} from '../utils/LlmRetryPolicy';
import { getExplicitExecTimeoutSeconds } from '../utils/ExecTimeoutObservation';
import {
  getCanonicalToolName,
  isAllowedToolName,
  normalizeToolCallForExecution,
} from '../tools/ToolAliases';

const logger = getLogger('SubAgentRunner');
const FILE_WRITE_ARGS_COMPRESS_TOKEN_THRESHOLD = 8000;

const TEXT_ONLY_DECISION_RETRY_AFTER = 2;
const TEXT_ONLY_DECISION_TERMINATE_AFTER = 3;

const OUTPUT_TOKEN_LIMIT_FINISH_REASONS = new Set([
  'length',
  'max_token',
  'max_tokens',
  'max_completion_tokens',
  'max_output_tokens',
  'maximum_tokens',
  'token_limit',
  'output_token_limit',
  'incomplete',
]);

function stringifyToolArg(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : '';
  } catch {
    return '';
  }
}

function getFirstToolArg(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = stringifyToolArg(args[key]);
    if (value) return value;
  }
  return '';
}

function isMissingFullFileWriteContent(args: Record<string, unknown>): boolean {
  const mode = getFirstToolArg(args, 'mode', 'write_mode') || 'full';
  if (mode === 'patch') return false;
  if (typeof args.content === 'string') return false;
  return !getFirstToolArg(args, 'contentRef', 'content_ref');
}

function normalizeExecWorkdirForRepeat(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[a-z]:/i.test(normalized) || normalized.startsWith('//')) {
    return normalized.toLowerCase();
  }
  return normalized;
}

function buildExecRepeatSignature(args: Record<string, unknown>, defaultWorkdir?: string): string {
  const command = getFirstToolArg(args, 'command').trim();
  if (!command) return '';

  const explicitWorkdir = getFirstToolArg(args, 'workdir', 'cwd');
  const workdir = normalizeExecWorkdirForRepeat(
    explicitWorkdir ? explicitWorkdir : (defaultWorkdir ?? '')
  );
  const background = args.background === true ? 'background' : 'foreground';
  return JSON.stringify({ command, workdir, background });
}

const TOOL_TARGET_MAX_LENGTH = 160;

interface ObservationToolTarget {
  target: string;
  fullTarget?: string;
  workdir?: string;
}

function compactToolTarget(value: string): string {
  const normalized = normalizeToolTarget(value);
  if (normalized.length <= TOOL_TARGET_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, TOOL_TARGET_MAX_LENGTH - 3)}...`;
}

function normalizeToolTarget(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function buildObservationToolTarget(value: string): ObservationToolTarget {
  const fullTarget = value.trim();
  const target = compactToolTarget(value);

  return fullTarget && fullTarget !== target ? { target, fullTarget } : { target };
}

function quoteToolTargetValue(value: string, compact = true): string {
  const compacted = compact ? compactToolTarget(value) : normalizeToolTarget(value);
  return compacted ? `"${compacted.replace(/"/g, '\\"')}"` : '';
}

function formatLocalSearchTarget(args: Record<string, unknown>, compact = true): string {
  const mode = getFirstToolArg(args, 'mode', 'search_mode');
  const searchPath = getFirstToolArg(args, 'searchPath', 'search_path');
  const includes = getFirstToolArg(args, 'includes');
  const searchScope = searchPath || includes;
  const formatValue = compact ? compactToolTarget : normalizeToolTarget;
  const searchScopeSuffix = searchScope ? ` @ ${formatValue(searchScope)}` : '';

  switch (mode) {
    case 'grep': {
      const query = quoteToolTargetValue(getFirstToolArg(args, 'query'), compact);
      return formatValue(`grep${query ? ` ${query}` : ''}${searchScopeSuffix}`);
    }
    case 'find': {
      const pattern = quoteToolTargetValue(getFirstToolArg(args, 'pattern', 'query'), compact);
      return formatValue(`find${pattern ? ` ${pattern}` : ''}${searchScopeSuffix}`);
    }
    case 'outline': {
      const path = getFirstToolArg(args, 'path', 'filePath', 'file_path');
      return formatValue(`outline${path ? ` ${path}` : ''}`);
    }
    case 'symbol': {
      const symbolName = getFirstToolArg(args, 'symbolName', 'symbol_name');
      const path = getFirstToolArg(args, 'path', 'filePath', 'file_path');
      return formatValue(`symbol${symbolName ? ` ${symbolName}` : ''}${path ? ` @ ${path}` : ''}`);
    }
    default: {
      const fallback = getFirstToolArg(
        args,
        'query',
        'pattern',
        'path',
        'searchPath',
        'symbolName'
      );
      return formatValue(`${mode || 'local_search'}${fallback ? ` ${fallback}` : ''}`);
    }
  }
}

function formatConversationSearchTarget(args: Record<string, unknown>): string {
  const mode = getFirstToolArg(args, 'mode') || 'search';
  if (mode === 'get') {
    const messageTarget = getFirstToolArg(
      args,
      'messageId',
      'message_id',
      'messageIds',
      'message_ids'
    );
    return `get${messageTarget ? ` ${messageTarget}` : ''}`;
  }
  if (mode === 'timeline') {
    const order = getFirstToolArg(args, 'order');
    const offset = getFirstToolArg(args, 'offset');
    const startAt = getFirstToolArg(args, 'startAt', 'start_at');
    const endAt = getFirstToolArg(args, 'endAt', 'end_at');
    return [
      'timeline',
      order ? `order=${order}` : '',
      startAt ? `startAt=${startAt}` : '',
      endAt ? `endAt=${endAt}` : '',
      offset ? `offset=${offset}` : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  const query = quoteToolTargetValue(getFirstToolArg(args, 'query'), false);
  const offset = getFirstToolArg(args, 'offset');
  const startAt = getFirstToolArg(args, 'startAt', 'start_at');
  const endAt = getFirstToolArg(args, 'endAt', 'end_at');
  return [
    'search',
    query || '',
    startAt ? `startAt=${startAt}` : '',
    endAt ? `endAt=${endAt}` : '',
    offset ? `offset=${offset}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function sanitizeToolCallIdPart(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return sanitized || 'unknown_tool';
}

function createSyntheticToolCallId(
  toolName: string,
  runSequence: number,
  step: number,
  index: number
): string {
  return `call_run${runSequence}_${sanitizeToolCallIdPart(toolName || 'unknown_tool')}_${step}_${index}`;
}

function getPositiveTokenCount(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isOutputTokenLimitFinishReason(finishReason: string | undefined): boolean {
  if (!finishReason) return false;
  const normalized = finishReason
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return OUTPUT_TOKEN_LIMIT_FINISH_REASONS.has(normalized);
}

// ═══════════════════════════════════════════════════════════════
// 上下文重置指令
// ═══════════════════════════════════════════════════════════════

/**
 * 上下文重置指令模板
 *
 * 当 Token 占比超过 SUB_AGENT_CONTEXT_RESET_RATIO（默认 45%）时，
 * 通过 additionalInstructions 注入此指令。
 * SA 收到后输出结构化摘要（以 ---CONTEXT_SUMMARY--- 标记开头），
 * Runner 拦截摘要并清空历史，让 SA 从摘要继续执行。
 * 如果 SA 未在 2 步内响应，Runner 会自动构建机械摘要兜底执行重置。
 */
/** 上下文摘要标记（Runner 用于检测 SA 是否输出了摘要） */
const CONTEXT_SUMMARY_MARKER = '---CONTEXT_SUMMARY---';

/** 重置指令发出后等待 SA 响应的最大步数（超过则 Runner 机械摘要兜底） */
const CONTEXT_RESET_FALLBACK_STEPS = 2;

// TOOL_CALLS_HARD_LIMIT 和 MAX_TOOLS_PER_STEP 已迁移至 PLANNING_CONSTANTS，在此直接引用

/**
 * LLM 调用接口
 *
 * 支持多轮会话的 LLM 调用器，由 SubAgentLLMCallerFactory 实现。
 * 原子事件循环中所有 LLM 调用都通过 callWithContext 进行。
 */
export interface LLMCaller {
  callWithContext(
    systemPrompt: string,
    tools: string[],
    accumulatedContext: AccumulatedMessage[],
    additionalInstructions?: string,
    /** AbortSignal：SA 循环被终止时，通过此信号通知 Rust 立即中断正在进行的 LLM HTTP 请求 */
    signal?: AbortSignal,
    /**
     * 用户介入消息持久化字段（贯穿 SA 当次生命周期所有剩余步骤）
     *
     * 每步 LLM 调用都会把用户介入消息注入到 SAFETY_FOOTER 之后的尾部热区，
     * 确保介入消息始终占据最高注意力优先级，不被执行惯性冲淡。
     * stepsSinceIntervention 表示介入发生到当前步已经历经多少步，
     * SA 需要结合自身当前进度判断是否继续或终止。
     */
    persistedIntervention?: { message: string; stepsSinceIntervention: number },
    /** 流式工具调用参数接收进度（不包含参数正文） */
    onToolCallProgress?: (progress: ToolCallProgress) => void,
    onReasoningTrace?: (progress: ReasoningTraceProgress) => void
  ): Promise<LLMResponse>;
}

export interface ToolCallProgress {
  toolName: string;
  argBytes: number;
}

export interface ReasoningTraceProgress {
  content: string;
  done: boolean;
}

/**
 * LLM 响应
 */
export interface LLMResponse {
  /** 文本内容 */
  content: string;
  /** 结构化输出（解析后） */
  output?: unknown;
  /** 工具调用名称记录 */
  toolCalls?: string[];
  /** 完整工具调用信息（包含参数，供 Runner 执行） */
  rawToolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
    id?: string;
    thoughtSignature?: string;
  }>;
  /** 是否需要用户交互（如 Diff 确认） */
  requiresInteraction?: boolean;
  /** API 错误信息（如 429 限速、500 服务器错误等） */
  error?: string;
  /** API 返回的输入 token 数（来自 LLM usage） */
  inputTokens?: number;
  /** API 返回的输出 token 数（来自 LLM usage） */
  outputTokens?: number;
  /** Provider 返回的完成原因（如 stop、length、max_tokens、MAX_TOKENS） */
  finishReason?: string;
  /** 思考内容（DeepSeek 思考模式返回的推理链，需在多轮工具调用中回传 API） */
  reasoningContent?: string;
}

// ═══════════════════════════════════════════════════════════════
// 执行器类
// ═══════════════════════════════════════════════════════════════

/**
 * 工具执行器接口（从外部注入）
 */
export type ToolExecutor = (
  toolCall: { name: string; args: Record<string, unknown> },
  options?: { signal?: AbortSignal }
) => Promise<{
  success: boolean;
  content: string;
  requiresInteraction?: boolean;
  /** 工具返回的结构化数据（如 file_write 的 Diff 数据） */
  data?: Record<string, unknown>;
  /** 图片附件（多模态，read 工具读取图片时填充） */
  images?: Array<{ mimeType: string; data: string }>;
}>;

/**
 * 消息格式（用于原子事件循环）
 */
export interface LoopMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
  /** Function Calling: assistant 消息的工具调用列表 */
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
    id?: string;
    thoughtSignature?: string;
  }>;
  /** Function Calling: tool 消息对应的工具调用 ID */
  toolCallId?: string;
  /** 图片附件（tool 角色时可填充，用于多模态 tool_result） */
  images?: Array<{ mimeType: string; data: string }>;
  /** 视觉 fallback 时优先保留此消息上的图片（例如当前轮用户附件） */
  preserveImagesOnVisionFallback?: boolean;
  /** 思考内容（DeepSeek 思考模式专用，工具调用场景需回传 API） */
  reasoningContent?: string;
}

type LoopToolCall = NonNullable<LoopMessage['toolCalls']>[number];

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 从工具调用参数中提取人类可读的目标描述
 *
 * 用于 UI 观测面板展示工具行为：如 "Read config.ts"、"Exec dir /s"
 */
function extractToolTarget(
  toolName: string,
  args: Record<string, unknown>,
  defaultWorkdir?: string
): ObservationToolTarget {
  switch (toolName) {
    case 'read':
    case 'file_write':
    case 'file_write_patch':
      return buildObservationToolTarget(getFirstToolArg(args, 'path', 'file_path', 'filePath'));
    case 'exec': {
      const command = getFirstToolArg(args, 'command');
      const explicitWorkdir = getFirstToolArg(args, 'workdir', 'cwd');
      const workdir = explicitWorkdir ? explicitWorkdir : (defaultWorkdir ?? '');
      const toolTarget = buildObservationToolTarget(command);
      return workdir ? { ...toolTarget, workdir } : toolTarget;
    }
    case 'web_search':
      return buildObservationToolTarget(getFirstToolArg(args, 'query'));
    case 'conversation_search':
      return buildObservationToolTarget(formatConversationSearchTarget(args));
    case 'local_search':
      return buildObservationToolTarget(formatLocalSearchTarget(args, false));
    case 'generate_image':
      return buildObservationToolTarget(getFirstToolArg(args, 'prompt'));
    case 'im_send': {
      const platform = getFirstToolArg(args, 'platform') || 'im';
      const target = getFirstToolArg(
        args,
        'channelId',
        'channel_id',
        'receiveId',
        'receive_id',
        'chatId',
        'chat_id',
        'filePath',
        'file_path',
        'path',
        'text',
        'message'
      );
      return buildObservationToolTarget(target ? `${platform} ${target}` : platform);
    }
    case 'external_skill_execute':
      return buildObservationToolTarget(
        getFirstToolArg(args, 'skillName', 'skill_name') || toolName
      );
    default:
      return buildObservationToolTarget(toolName);
  }
}

/**
 * 子智能体执行器
 */
export class SubAgentRunner {
  private factory: SubAgentFactory;
  private llmCaller?: LLMCaller;
  private toolExecutor?: ToolExecutor;
  /** 当前任务的模型上下文窗口大小（由 runAtomicEventLoop 根据 contextBudget 设置） */
  private contextWindowSize: number = PLANNING_CONSTANTS.DEFAULT_CONTEXT_WINDOW;
  /** 实时观测回调（UI 层订阅） */
  private observationCallback?: (event: SubAgentObservationEvent) => void;
  /** 实时 Diff 数据回调（file_write 执行后立即触发，使 UI 无需等待 SA 完成即可预览改动） */
  private diffDataCallback?: (record: FileWriteDiffRecord) => void;
  /** 跨 SA 生命周期的中间成果存储（由 AgentLoopFSMIntegration 注入） */
  private artifactStore?: TaskArtifactStore;
  /** 当次 SA 执行中收集的详细观测事件（每步的 thinking + 工具动作） */
  private collectedObservationEvents: NonNullable<SubAgentOutput['observationEvents']> = [];
  /** Synthetic tool call IDs need a per-run namespace because each SA loop restarts at step 1. */
  private syntheticToolCallRunSequence = 0;
  /** 当前 SA run 的观测命名空间，保证 UI 可保留多轮 SA 而不跨轮合并。 */
  private currentObservationRunId?: string;
  /**
   * HITL：当前 SA 绑定的 UI 上下文 ID（agentId）
   *
   * 由 SubAgentDispatcher 在 dispatch 前注入，用于在 hitlStore 中
   * 查询当前 contextId 是否处于用户暂停状态。
   * undefined 时跳过暂停检查（测试环境或未注入 contextId 的场景）。
   */
  private contextId?: string;

  constructor(llmCaller?: LLMCaller) {
    this.factory = new SubAgentFactory();
    this.llmCaller = llmCaller;
  }

  /**
   * 估算消息列表的 token 总量
   *
   * 使用与 MasterBrainPrompt 相同的启发式算法：
   * 中文约 1.5 字符/token，英文约 4 字符/token
   *
   * 重要：同时统计 toolCalls.args 中的参数文本——
   * 这些参数在 callWithContext 中会被序列化发送给 API，
   * 必须计入 token 总量以确保压缩和预算阈值准确。
   * 典型场景：file_write 的 content 参数可能包含数百行代码。
   */
  private estimateMessageTokens(messages: LoopMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      // 统计 content 文本
      if (msg.content) {
        total += this.estimateTextTokens(msg.content);
      }
      // 统计 toolCalls 中的参数文本（如 file_write 的 content 参数）
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          const argsText = JSON.stringify(tc.args);
          total += Math.ceil(argsText.length / 4);
          if (tc.thoughtSignature) {
            total += Math.ceil(tc.thoughtSignature.length / 4);
          }
        }
      }
      // 每条消息额外固定开销（role 标记、结构化 token）
      total += 4;
    }
    return total;
  }

  /**
   * 估算文本的 token 量（中英文混合启发式算法）
   */
  private estimateTextTokens(text: string): number {
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
    const otherChars = text.length - chineseChars;
    return Math.ceil(chineseChars / 1.5) + Math.ceil(otherChars / 4);
  }

  private isCompressedFileWriteContent(content: string): boolean {
    return content.startsWith('[Written ') && content.includes('content compressed');
  }

  private compactFileWriteToolCallArgs(tc: LoopToolCall): {
    toolCall: LoopToolCall;
    compressed: boolean;
    savedTokens: number;
  } {
    if (tc.name !== 'file_write') {
      return { toolCall: tc, compressed: false, savedTokens: 0 };
    }

    const contentArg = tc.args.content;
    if (typeof contentArg !== 'string' || this.isCompressedFileWriteContent(contentArg)) {
      return { toolCall: tc, compressed: false, savedTokens: 0 };
    }

    const originalTokens = this.estimateTextTokens(contentArg);
    if (originalTokens < FILE_WRITE_ARGS_COMPRESS_TOKEN_THRESHOLD) {
      return { toolCall: tc, compressed: false, savedTokens: 0 };
    }

    const lineCount = contentArg.split(/\r?\n/).length;
    const charCount = contentArg.length;
    const compressedContent = `[Written ${lineCount} lines, ${charCount} characters - content compressed]`;
    const toolCall = {
      ...tc,
      args: {
        ...tc.args,
        content: compressedContent,
      },
    };

    return {
      toolCall,
      compressed: true,
      savedTokens: originalTokens - this.estimateTextTokens(compressedContent),
    };
  }

  /**
   * 压缩已执行的大 file_write 入参，避免完整文件内容长期留在循环历史中。
   */
  private compactExecutedFileWriteToolCallArgs(
    messages: LoopMessage[],
    toolCallId: string | undefined
  ): void {
    if (!toolCallId) return;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role !== 'assistant' || !msg.toolCalls) continue;

      const toolCallIndex = msg.toolCalls.findIndex(
        (tc) => tc.name === 'file_write' && tc.id === toolCallId
      );
      if (toolCallIndex < 0) continue;

      const currentToolCall = msg.toolCalls[toolCallIndex];
      if (!currentToolCall) return;

      const compacted = this.compactFileWriteToolCallArgs(currentToolCall);
      if (!compacted.compressed) return;

      const updatedToolCalls = [...msg.toolCalls];
      updatedToolCalls[toolCallIndex] = compacted.toolCall;
      msg.toolCalls = updatedToolCalls;

      logger.info('[SubAgentRunner] Compacted large file_write tool args after execution', {
        toolCallId,
        savedTokens: compacted.savedTokens,
      });
      return;
    }
  }

  /**
   * 设置工具执行器（用于原子事件循环）
   */
  setToolExecutor(executor: ToolExecutor): void {
    this.toolExecutor = executor;
  }

  /**
   * 设置 HITL 上下文 ID
   *
   * 由 SubAgentDispatcher 在 dispatch 前调用，绑定当前 SA 对应的 UI contextId。
   * 绑定后，runAtomicEventLoop 每步开头会检查 hitlStore.isPaused(contextId)，
   * 需要时阻塞直到用户继续或介入。
   */
  setContextId(contextId: string): void {
    this.contextId = contextId;
  }

  /**
   * 设置实时观测回调（UI 层通过此回调实时监控 Sub-Agent 行为）
   */
  setObservationCallback(callback: (event: SubAgentObservationEvent) => void): void {
    this.observationCallback = callback;
  }

  /**
   * 设置实时 Diff 数据回调
   *
   * file_write 工具执行后立即通过此回调发射 diff 数据，
   * 使 UI 无需等待 SA 完成即可实时预览文件改动。
   * 同一文件多次修改时由调用方（Dispatcher）负责增量合并。
   */
  setDiffDataCallback(callback: (record: FileWriteDiffRecord) => void): void {
    this.diffDataCallback = callback;
  }

  /**
   * 设置 Task Artifact Store（用于跨 SA 生命周期保留中间成果）
   */
  setArtifactStore(store: TaskArtifactStore): void {
    this.artifactStore = store;
  }

  /**
   * 发射观测事件（安全调用，callback 不存在时静默忽略）
   *
   * 同时收集到内部数组，用于构建 SubAgentOutput.observationEvents。
   * thinking 截取前 150 字符避免 token 膨胀，同时保留足够的推理上下文。
   */
  private emitObservation(
    event: SubAgentObservationEvent,
    options: { collect?: boolean } = {}
  ): void {
    const shouldCollect = options.collect ?? true;
    const eventWithRunId: SubAgentObservationEvent =
      this.currentObservationRunId && !event.runId
        ? { ...event, runId: this.currentObservationRunId }
        : event;

    if (shouldCollect) {
      // 收集详细事件（清理换行 + 截取，避免 MB prompt 中出现多余空行）
      const MAX_THINKING_CHARS = 150;
      const cleanThinking = eventWithRunId.thinking.replace(/\n+/g, ' ').trim();
      const trimmedThinking =
        cleanThinking.length > MAX_THINKING_CHARS
          ? cleanThinking.slice(0, MAX_THINKING_CHARS) + '...'
          : cleanThinking;
      const collectedEvent: NonNullable<SubAgentOutput['observationEvents']>[number] = {
        runId: eventWithRunId.runId,
        thinking: trimmedThinking,
        toolAction: eventWithRunId.toolAction
          ? {
              toolCallId: eventWithRunId.toolAction.toolCallId,
              tool: eventWithRunId.toolAction.tool,
              target: eventWithRunId.toolAction.target,
              workdir: eventWithRunId.toolAction.workdir,
              success: eventWithRunId.toolAction.success,
            }
          : undefined,
        step: eventWithRunId.step,
      };

      const toolCallId = collectedEvent.toolAction?.toolCallId;
      if (toolCallId) {
        const existingIndex = this.collectedObservationEvents.findIndex(
          (item) =>
            item.toolAction?.toolCallId === toolCallId && item.runId === collectedEvent.runId
        );
        if (existingIndex >= 0) {
          const previous = this.collectedObservationEvents[existingIndex];
          if (previous) {
            this.collectedObservationEvents[existingIndex] = {
              ...previous,
              thinking: collectedEvent.thinking || previous.thinking,
              toolAction:
                previous.toolAction && collectedEvent.toolAction
                  ? {
                      ...previous.toolAction,
                      ...collectedEvent.toolAction,
                      success: collectedEvent.toolAction.success ?? previous.toolAction.success,
                    }
                  : (collectedEvent.toolAction ?? previous.toolAction),
              step: collectedEvent.step ?? previous.step,
            };
          }
        } else {
          this.collectedObservationEvents.push(collectedEvent);
        }
      } else {
        this.collectedObservationEvents.push(collectedEvent);
      }
    }

    // 同时发射到 UI 回调（传递原始完整事件，不截取）
    try {
      this.observationCallback?.(eventWithRunId);
    } catch (error) {
      // 观测回调失败不应影响 Sub-Agent 执行
      logger.warn('[SubAgentRunner] 观测回调异常:', error);
    }
  }

  /**
   * 发射 Diff 数据到 UI（安全调用，callback 不存在时静默忽略）
   *
   * 每次 file_write 工具执行后立即调用，使 UI 能实时预览文件改动。
   * 同一文件多次修改时每次都发射，由 Dispatcher 层负责增量合并。
   */
  private emitDiffData(record: FileWriteDiffRecord): void {
    try {
      this.diffDataCallback?.(record);
    } catch (error) {
      // diff 回调失败不影响 SA 执行
      logger.warn('[SubAgentRunner] Diff 回调异常:', error);
    }
  }

  /**
   * 设置 LLM Caller
   */
  setLLMCaller(caller: LLMCaller): void {
    this.llmCaller = caller;
  }

  // ═══════════════════════════════════════════════════════════════
  // 动态决策 Loop 执行（阶段 2）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 执行 Sub-Agent 任务（ReAct 原子事件循环）
   *
   * Runner 拥有每一步的绝对控制权：LLM 调用 → 工具执行 → 结果入栈。
   */
  async runWithDynamicLoop(
    spec: SubAgentSpec,
    context: TaskContext,
    onCheckpoint: CheckpointCallback,
    skills: SkillDefinition[],
    signal?: AbortSignal,
    externalGuideSkills?: ExternalGuideSkillInfo[],
    externalScriptSkills?: ExternalScriptSkillInfo[],
    overrideSystemPrompt?: string,
    /** 用户上传的图片附件（注入到 SA 首条 user 消息，使 SA 能"看到"图片） */
    imageAttachments?: Array<{ mimeType: string; data: string }>,
    /** 图片附件持久化后的路径（SA 可用于 generate_image 的 ref_image_path） */
    savedAttachmentPaths?: string[],
    /** 所有已安装的 External 技能名称（全量目录，用于 SA prompt 末尾的可参考技能列表） */
    allInstalledSkillNames?: string[],
    /**
     * 配对好的历史对话消息（含图片）
     *
     * 插入到 messages[] 中首条任务指令（initialUserMessage）之前，
     * 使 SA 先看到历史背景再看到当前任务。
     * 与 imageAttachments 互斥：历史图片走此字段（配对模式），当轮新上传图片走 imageAttachments。
     */
    pairedHistoryMessages?: Array<{
      role: 'user' | 'assistant';
      content: string;
      images?: Array<{ mimeType: string; data: string }>;
    }>
  ): Promise<SubAgentOutput> {
    // overrideSystemPrompt 模式：调用方自行构建精简 Prompt
    // 适用于审查 SA 等场景，避免完整 PromptBuilder 管线引入过多模板
    let systemPrompt: string;
    if (overrideSystemPrompt) {
      logger.debug('[SubAgentRunner] 使用自定义 systemPrompt (跳过 PromptBuilder)');
      systemPrompt = overrideSystemPrompt;
    } else {
      const factoryResult = this.factory.create(
        spec,
        context,
        skills,
        externalGuideSkills,
        externalScriptSkills,
        allInstalledSkillNames
      );
      if (!factoryResult.success) {
        return createFailedOutput(factoryResult.error);
      }
      systemPrompt = factoryResult.instance.systemPrompt;
    }
    const config = spec.loopConfig;
    if (!config) {
      return createFailedOutput('Sub-Agent loopConfig is missing');
    }

    // 校验执行所需的必要组件
    if (!this.toolExecutor || !this.llmCaller) {
      throw new Error(
        `[SubAgentRunner] Missing components required for the atomic event loop. ` +
          `Required: toolExecutor=${!!this.toolExecutor}, ` +
          `llmCaller=${!!this.llmCaller}`
      );
    }

    return this.runAtomicEventLoop(
      spec,
      systemPrompt,
      config,
      onCheckpoint,
      context.cwd,
      signal,
      context.contextWindowSize,
      imageAttachments,
      savedAttachmentPaths,
      pairedHistoryMessages
    );
  }

  /**
   * 原子事件循环（ReAct 模式核心实现）
   *
   * 每一步 Runner 都拥有完全控制权：
   * 1. 调用 LLM
   * 2. 如果返回工具调用 → 执行工具 → 结果加入消息 → 继续循环
   * 3. 如果返回文本 → 检测终止信号 → 决定是否结束
   */
  private async runAtomicEventLoop(
    spec: SubAgentSpec,
    systemPrompt: string,
    config: SubAgentLoopConfig,
    onCheckpoint: CheckpointCallback,
    defaultWorkdir?: string,
    signal?: AbortSignal,
    contextWindowSize?: number,
    /** 用户上传的图片附件（仅首轮注入到 user 消息） */
    imageAttachments?: Array<{ mimeType: string; data: string }>,
    /** 图片附件持久化后的路径（注入到 user 消息文本，便于 SA 使用 ref_image_path） */
    savedAttachmentPaths?: string[],
    /**
     * 配对好的历史对话消息（含图片）
     *
     * 厂入到 messages[] 中首条任务指令（initialUserMessage）之前，
     * SA 先看到历史背景（图片 + 文字配对）再看到当前任务指令，语义顺序与真实对话一致。
     * 与 imageAttachments 互斥：历史图片走此字段（配对模式），当轮新上传图片走 imageAttachments。
     */
    pairedHistoryMessages?: Array<{
      role: 'user' | 'assistant';
      content: string;
      images?: Array<{ mimeType: string; data: string }>;
    }>
  ): Promise<SubAgentOutput> {
    logger.debug('[SubAgentRunner] 🔄 启动原子事件循环 (ReAct 模式)');

    // 重置每次执行的观测事件收集器
    this.collectedObservationEvents = [];
    const syntheticToolCallRunSequence = ++this.syntheticToolCallRunSequence;
    this.currentObservationRunId = `sa-run-${syntheticToolCallRunSequence}`;
    const caller = this.llmCaller;
    const toolExecutor = this.toolExecutor;
    if (!caller || !toolExecutor) {
      throw new Error('[SubAgentRunner] Missing components required for the atomic event loop');
    }

    // 使用调用方传入的模型上下文窗口大小（由 ContextWindowManager 根据 modelId 计算）
    if (contextWindowSize) {
      this.contextWindowSize = contextWindowSize;
      logger.debug(`[SubAgentRunner] 📐 使用真实模型窗口: ${this.contextWindowSize} tokens`);
    }

    // 构建初始 user 消息，注入图片附件使 SA 能"看到"用户上传的图片
    let userContent = translate('planning.subAgent.initialUserMessage');
    // 注入图片文件路径，便于 SA 使用 generate_image 的 ref_image_path 参数
    if (savedAttachmentPaths?.length) {
      const pathsInfo = savedAttachmentPaths.map((p) => `- ${p}`).join('\n');
      userContent += `\n\n${translate('planning.subAgent.attachmentPathsForReference', {
        paths: pathsInfo,
      })}`;
    }
    const initialUserMessage: LoopMessage = {
      role: 'user',
      content: userContent,
      // 图片注入：SA 的 LLM 可通过多模态理解图片内容
      images: imageAttachments?.length ? imageAttachments : undefined,
      preserveImagesOnVisionFallback: imageAttachments?.length ? true : undefined,
    };
    if (imageAttachments?.length) {
      logger.trace(
        `[SubAgentRunner] 📷 已注入 ${imageAttachments.length} 张图片到 SA 首条 user 消息`
      );
    }

    // 单一消息历史（Single Source of Truth）
    // 结构：[system] + [pairedHistoryMessages?] + [initialUserMessage]
    // pairedHistoryMessages 在 initialUserMessage 之前插入，SA 先看历史背景再看任务指令
    const messages: LoopMessage[] = [
      { role: 'system', content: systemPrompt },
      // 配对历史消息（历史图片 + 文字配对），与 MB convertedMessages 对齐
      ...(pairedHistoryMessages?.map(
        (m) =>
          ({
            role: m.role,
            content: m.content,
            images: m.images,
          }) as LoopMessage
      ) ?? []),
      // 本次 SA 的任务指令消息（当轮新图片仍挂在这里）
      initialUserMessage,
    ];
    if (pairedHistoryMessages?.length) {
      logger.trace(
        `[SubAgentRunner] 🔗 已插入 ${pairedHistoryMessages.length} 条配对历史消息到 SA messages[]（initialUserMessage 之前）`
      );
      logger.trace(
        '[SubAgentRunner] SA messages[] history prefix:',
        pairedHistoryMessages.map((message, index) => ({
          index,
          role: message.role,
          imageCount: message.images?.length ?? 0,
          contentPreview: message.content.replace(/\s+/g, ' ').slice(0, 80),
        }))
      );
    }

    // 循环状态
    let stepCount = 0;
    let totalToolCalls = 0;
    let toolCallSteps = 0; // 执行了工具调用的步数（用于计算平均并行度）
    let terminated = false;
    let terminationReason: string | undefined;
    // 连续失败检测：按工具调用步计数。一整步没有任何工具成功才算 1 次失败，
    // 避免同一轮并发工具全部失败时把 N 个并发结果误算成 N 步。
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;
    // 连续无变化写入检测：file_write 反复返回"无变化"时自动终止
    let consecutiveNoChangeWrites = 0;
    const MAX_CONSECUTIVE_NO_CHANGE = 3;
    let consecutiveMissingFileWriteContent = 0;
    // 连续相同 exec 命令检测：同一命令反复执行时自动终止
    // 防止 SA 在验证阶段用相同的 exec 命令无限循环（如反复 pd.read_excel）
    let consecutiveIdenticalExecs = 0;
    let lastExecSignature = '';
    const MAX_CONSECUTIVE_IDENTICAL_EXECS = 3;
    let lastContent = '';
    let requiresInteraction = false;
    const allToolCallNames: string[] = [];
    const collectedDiffData: FileWriteDiffRecord[] = []; // 收集 file_write 产生的 Diff 数据
    let additionalInstructions: string | undefined; // 用于 ADJUST_STRATEGY 决策
    let maxSteps = config.maxSteps; // 可变步数预算，用于 EXTEND_BUDGET 决策
    let consecutiveApiErrors = 0; // 连续 API 错误计数（用于重试上限控制）
    let outputTruncationRetryUsed = false; // Provider 输出上限截断只允许一次安全重试
    let consecutiveEmptyResponses = 0; // Consecutive text responses with no content and no tool calls.
    let consecutiveTextOnlyResponses = 0; // 连续有文本但无工具调用、无终止信号的响应计数。
    // 用户介入消息持久化字段：介入发生后始终注入到每步 LLM 调用的尾部热区，
    // 不随 additionalInstructions 清空，直到 SA 杯命周期结束。
    // interventionAtStep 记录介入发生时的 stepCount，用于计算“前 N 步”对话标签。
    let persistedUserIntervention: string | undefined;
    let interventionAtStep = 0;
    let contextResetCount = 0; // 已触发的上下文重置次数（无上限，每次重置后可再次触发）
    let contextResetInProgress = false; // 当前轮次是否已发出重置指令（等待 SA 响应中）
    let contextResetPendingSteps = 0; // 重置指令发出后的步数计数器（机械兜底用）
    // 已批准的高风险工具集合：首次 Checkpoint 批准后，同类工具后续调用静默放行
    // 解决 agent-browser 等场景中每步 exec 都触发 MB LLM 调用（10-24s/次）的频率问题
    const approvedHighRiskTools = new Set<string>();
    // L1 预算警告防重复布尔标志——替代 includes() 检查，避免 additionalInstructions 被清空后失效
    let budgetWarningInjected = false;
    let budgetCriticalInjected = false;
    let budgetExtensionCount = 0;
    let lastBudgetNearExhaustionCheckpointMaxSteps: number | undefined;

    const applyBudgetExtension = (
      requestedIterations: number | undefined,
      source: string
    ): number => {
      if (!requestedIterations || requestedIterations <= 0) {
        return 0;
      }

      if (budgetExtensionCount >= PLANNING_CONSTANTS.SUB_AGENT_BUDGET_EXTENSION_MAX_COUNT) {
        logger.debug(
          `[SubAgentRunner] ⏱️ ${source} 请求追加预算，但已达上限 ` +
            `(${budgetExtensionCount}/${PLANNING_CONSTANTS.SUB_AGENT_BUDGET_EXTENSION_MAX_COUNT})`
        );
        return 0;
      }

      const additionalIterations = Math.min(
        Math.floor(requestedIterations),
        PLANNING_CONSTANTS.SUB_AGENT_BUDGET_EXTENSION_MAX_ITERATIONS
      );
      if (additionalIterations <= 0) {
        return 0;
      }

      maxSteps += additionalIterations;
      budgetExtensionCount++;
      budgetWarningInjected = false;
      budgetCriticalInjected = false;
      lastBudgetNearExhaustionCheckpointMaxSteps = undefined;
      logger.debug(
        `[SubAgentRunner] ⏱️ ${source} 延长预算 +${additionalIterations} 步 ` +
          `(新上限: ${maxSteps}, 扩展次数: ${budgetExtensionCount}/` +
          `${PLANNING_CONSTANTS.SUB_AGENT_BUDGET_EXTENSION_MAX_COUNT})`
      );
      return additionalIterations;
    };

    // 📦 上下文压缩器（对历史工具输出执行梯度截断）
    // 单条工具输出事前截断已由 L1 梯度压缩（compressHistoricalToolOutputs）覆盖，无需独立截断
    const compressor = new ToolOutputCompressor();

    // 原子事件循环
    // 主预算：步数（toolCallSteps）；安全阀：工具调用总数硬上限（引自 PLANNING_CONSTANTS）
    while (
      !terminated &&
      toolCallSteps < maxSteps &&
      totalToolCalls < PLANNING_CONSTANTS.TOOL_CALLS_HARD_LIMIT
    ) {
      // 检查外部中断信号（用户点击终止按钮时触发）
      if (signal?.aborted) {
        logger.debug('[SubAgentRunner] ⛔ 收到外部中断信号，立即停止');
        terminationReason = 'cancelled';
        break;
      }

      // ─── HITL 步间暂停检查 ───
      // 用户在 FSM 可视化面板点击「⏸ 暂停」后，hitlStore.pause(contextId) 被调用。
      // 当前步执行完毕后，下一步开始前在此处检测暂停状态并等待用户决策。
      // 使用步间暂停（而非 LLM 调用中止），保证消息历史始终完整可回溯。
      if (this.contextId && useHitlStore.getState().isPaused(this.contextId)) {
        logger.debug(
          `[SubAgentRunner] ⏸ 检测到 HITL 暂停请求 (contextId: ${this.contextId})，等待用户介入...`
        );
        try {
          const userMessage = await useHitlStore
            .getState()
            .waitForResume(this.contextId, signal ?? new AbortController().signal);
          if (userMessage) {
            // 将用户介入消息注入到下一步 LLM 调用的 additionalInstructions
            // 与 ADJUST_STRATEGY Checkpoint 机制相同，SA 可在下一步感知此指令
            const interventionInstruction = translate('chat.subAgentUserInterventionInline', {
              message: userMessage,
            });
            additionalInstructions = additionalInstructions
              ? `${additionalInstructions}\n\n${interventionInstruction}`
              : interventionInstruction;
            logger.debug(`[SubAgentRunner] 📩 用户介入消息已注入 additionalInstructions`);

            // 将介入消息持久化到 persistedUserIntervention
            // additionalInstructions 仅影响紧接的下一步，而 persistedUserIntervention
            // 向后每步 LLM 调用都会在 SAFETY_FOOTER 之后热区封顶注入，
            // 防止 SA 因执行悯性回归旧执行路径。
            persistedUserIntervention = userMessage;
            interventionAtStep = stepCount;
            logger.debug(`[SubAgentRunner] 🔒 用户介入消息已持久化 (第 ${stepCount} 步)`);

            // 将介入消息永久追加到 messages[]
            // additionalInstructions 在每次 LLM 调用后立即清空，只影响紧接的一步。
            // 通过追加 user 角色消息，确保后续所有步骤的上下文中始终可见此约束，
            // 防止 SA 在"服从一步"后因悯性回归旧路径。
            messages.push({
              role: 'user',
              content: translate('chat.subAgentForcedUserInterventionMessage', {
                step: stepCount,
                message: userMessage,
              }),
            });
            logger.debug(
              `[SubAgentRunner] 📌 用户介入消息已永久追加到 messages[] (第 ${stepCount} 步)`
            );

            // 将介入消息写入 Artifact Store，使 MB 和后续 SA 能在 TASK_ARTIFACTS 中感知
            // artifactStore 生命周期与本轮用户消息绑定，可跨 SA 持久化
            // sourceHint 故意携带介入内容摘要（≤100字符），让 MB 通过轻量索引即可直接读到原文
            if (this.artifactStore) {
              const sourceHint = translate('chat.subAgentUserInterventionArtifactSource', {
                step: stepCount,
                message: `${userMessage.slice(0, 100)}${userMessage.length > 100 ? '...' : ''}`,
              });
              this.artifactStore.write(
                'user_intervention',
                translate('chat.subAgentUserInterventionArtifactContent', {
                  step: stepCount,
                  message: userMessage,
                }),
                'user_intervention',
                sourceHint,
                'user'
              );
              logger.debug(
                `[SubAgentRunner] 📝 用户介入消息已写入 Artifact Store (Step ${stepCount})`
              );
            }

            // 将介入消息作为观测事件注入 SA 时间线
            // 这样介入记录会精准出现在对应步数位置（如 Step 8 之后），
            // 而不是浮在 TASK_ARTIFACTS 顶部，便于 MB 理解执行上下文
            this.emitObservation({
              thinking: translate('chat.subAgentUserInterventionObservation', {
                message: userMessage,
              }),
              step: stepCount,
              timestamp: Date.now(),
            });
          } else {
            logger.debug('[SubAgentRunner] ▶ 用户选择直接继续（无介入消息）');
          }
        } catch (pauseError) {
          // AbortError：用户在暂停状态下点击了终止任务
          if (pauseError instanceof DOMException && pauseError.name === 'AbortError') {
            logger.debug('[SubAgentRunner] ⛔ HITL 暂停期间收到终止信号，退出循环');
            terminationReason = 'cancelled';
            break;
          }
          // 其他错误：打印警告，继续执行（容错优先）
          logger.warn('[SubAgentRunner] HITL waitForResume 异常，继续执行:', pauseError);
        }
      }

      const remainingStepsBeforeDecision = maxSteps - toolCallSteps;
      const budgetRatioBeforeDecision = maxSteps > 0 ? toolCallSteps / maxSteps : 0;
      const shouldTriggerBudgetCheckpoint =
        toolCallSteps > 0 &&
        remainingStepsBeforeDecision <=
          PLANNING_CONSTANTS.SUB_AGENT_BUDGET_CHECKPOINT_REMAINING_STEPS &&
        budgetRatioBeforeDecision >= PLANNING_CONSTANTS.SUB_AGENT_BUDGET_WARNING_RATIO &&
        budgetExtensionCount < PLANNING_CONSTANTS.SUB_AGENT_BUDGET_EXTENSION_MAX_COUNT &&
        lastBudgetNearExhaustionCheckpointMaxSteps !== maxSteps;

      if (shouldTriggerBudgetCheckpoint) {
        lastBudgetNearExhaustionCheckpointMaxSteps = maxSteps;
        logger.debug(
          `[SubAgentRunner] ⏱️ 预算临近耗尽，触发 Checkpoint ` +
            `(剩余 ${remainingStepsBeforeDecision} 步, 已用 ${(budgetRatioBeforeDecision * 100).toFixed(0)}%)`
        );
        try {
          const report = this.buildProgressReportFromMessages(
            spec.role,
            messages,
            totalToolCalls,
            config,
            stepCount,
            undefined,
            'budget_near_exhaustion',
            undefined,
            toolCallSteps,
            maxSteps
          );
          const decision = await onCheckpoint(report, spec);

          if (signal?.aborted) {
            logger.debug('[SubAgentRunner] ⛔ 预算 Checkpoint 后检测到中断信号，立即停止');
            terminated = true;
            terminationReason = 'cancelled';
            break;
          }

          switch (decision.type) {
            case 'TERMINATE_SUB_AGENT':
              terminated = true;
              terminationReason = 'budget_checkpoint_terminate';
              logger.debug(`[SubAgentRunner] 🛑 预算 Checkpoint 决策终止: ${decision.reason}`);
              break;

            case 'EXTEND_BUDGET':
              applyBudgetExtension(decision.additionalIterations, '预算 Checkpoint');
              if (decision.refinedInstructions) {
                additionalInstructions = decision.refinedInstructions;
              }
              break;

            case 'ADJUST_STRATEGY': {
              const progressSummary = this.buildProgressSummaryForSA(messages);
              additionalInstructions = progressSummary + '\n\n' + decision.refinedInstructions;
              applyBudgetExtension(decision.additionalIterations, '预算 Checkpoint 策略调整');
              logger.debug(
                `[SubAgentRunner] 🎯 预算 Checkpoint 调整策略（含进度摘要） - ` +
                  `${decision.refinedInstructions.slice(0, 50)}...`
              );
              break;
            }
          }
        } catch (e) {
          logger.warn('[SubAgentRunner] 预算 Checkpoint 异常，继续执行:', e);
        }

        if (terminated) {
          break;
        }
      }

      stepCount++;
      // 估算本轮发送给 LLM 的 token 量（压缩后的消息）
      const preCallTokens = this.estimateMessageTokens(messages);
      logger.debug(
        `[SubAgentRunner] 📍 Step ${stepCount}: 调用 LLM (消息数: ${messages.length}, 预估tokens: ${preCallTokens})`
      );

      // 预算阈值信号注入（85% 和 95%）
      // 使用离散信号而非连续数值
      // 直接用步数比例计算——步数即主预算，无需折算
      const budgetRatio = maxSteps > 0 ? toolCallSteps / maxSteps : 0;
      if (
        budgetRatio >= PLANNING_CONSTANTS.SUB_AGENT_BUDGET_CRITICAL_RATIO &&
        !budgetCriticalInjected
      ) {
        const budgetWarning = translate('chat.subAgentBudgetFinalWarning');
        additionalInstructions = additionalInstructions
          ? `${additionalInstructions}\n\n${budgetWarning}`
          : budgetWarning;
        budgetCriticalInjected = true;
        logger.debug('[SubAgentRunner] 🛑 预算 95%，注入最终警告');
      } else if (
        budgetRatio >= PLANNING_CONSTANTS.SUB_AGENT_BUDGET_WARNING_RATIO &&
        !budgetWarningInjected
      ) {
        const budgetWarning = translate('chat.subAgentBudgetNearExhaustionWarning');
        additionalInstructions = additionalInstructions
          ? `${additionalInstructions}\n\n${budgetWarning}`
          : budgetWarning;
        budgetWarningInjected = true;
        logger.debug('[SubAgentRunner] ⚠️ 预算 85%，注入警告');
      }

      // 上下文重置检测：Token 占比超过阈值时，让 SA 自我总结后清空历史
      // 与梯度压缩（L1=85%）协同：L1 作为高阈值安全兜底，L2 优先做主动信息结晶重置
      // 基于原始 rawTokens 触发——重置是"主动信息浓缩"而非"紧急逃生"，
      // 让 SA 在上下文膨胀时产出高质量结构化摘要，比 L1 元信息压缩保留更多细节
      // 允许多次触发：每次重置后上下文回落，后续步骤仍可再次触发（如 deep research 场景）
      if (!contextResetInProgress) {
        const rawTokens = this.estimateMessageTokens(messages);
        const resetThreshold =
          this.getContextWindowSize() * PLANNING_CONSTANTS.SUB_AGENT_CONTEXT_RESET_RATIO;
        const remainingSteps = maxSteps - toolCallSteps;

        if (
          rawTokens > resetThreshold &&
          remainingSteps >= PLANNING_CONSTANTS.SUB_AGENT_CONTEXT_RESET_MIN_REMAINING_STEPS
        ) {
          const resetInstruction = translate('chat.subAgentContextResetInstruction');
          additionalInstructions = additionalInstructions
            ? `${additionalInstructions}\n\n${resetInstruction}`
            : resetInstruction;
          contextResetInProgress = true;
          contextResetPendingSteps = 0;
          contextResetCount++;
          logger.debug(
            `[SubAgentRunner] 🔄 上下文重置触发 (第 ${contextResetCount} 次): ` +
              `${rawTokens} tokens > ${Math.floor(resetThreshold)} 阈值, ` +
              `剩余 ${remainingSteps} 步`
          );
        }
      }

      // 重置指令已发出但 SA 未响应时递增计数器
      if (contextResetInProgress) {
        contextResetPendingSteps++;

        // 超过等待步数上限：Runner 侧机械摘要兜底
        // 利用 buildExecutionSummary 提取工具调用历史 + 最后 2 条 assistant 分析
        if (contextResetPendingSteps > CONTEXT_RESET_FALLBACK_STEPS) {
          logger.debug(
            `[SubAgentRunner] 🔄 SA 未在 ${CONTEXT_RESET_FALLBACK_STEPS} 步内输出摘要，` +
              `执行 Runner 侧机械摘要兜底 (第 ${contextResetCount} 次重置)`
          );
          const mechanicalSummary = this.buildMechanicalSummary(messages);
          this.executeContextReset(messages, mechanicalSummary, 'mechanical_fallback');
          // 重置完成后解锁，允许后续步骤再次触发重置
          contextResetInProgress = false;
          consecutiveFailures = 0;
          consecutiveNoChangeWrites = 0;
          consecutiveMissingFileWriteContent = 0;
          consecutiveIdenticalExecs = 0;
          lastExecSignature = '';

          additionalInstructions = undefined;
          continue;
        }
      }

      // 调用 LLM（对历史工具输出执行梯度压缩）
      const { messages: managedMessages } = this.compressHistoricalToolOutputs(
        messages,
        compressor,
        stepCount
      );
      const llmCallStartedAt = Date.now();
      let slowDecisionTimer: ReturnType<typeof setTimeout> | undefined;
      if (this.observationCallback) {
        slowDecisionTimer = setTimeout(() => {
          this.emitObservation(
            {
              thinking: translate('chat.subAgentSlowDecisionNotice', {
                seconds: Math.round(PLANNING_CONSTANTS.SUB_AGENT_SLOW_DECISION_NOTICE_MS / 1000),
              }),
              transient: true,
              step: stepCount,
              timestamp: Date.now(),
            },
            { collect: false }
          );
        }, PLANNING_CONSTANTS.SUB_AGENT_SLOW_DECISION_NOTICE_MS);
      }

      let response: LLMResponse;
      const onToolCallProgress = this.observationCallback
        ? (progress: ToolCallProgress) => {
            if (progress.toolName !== 'file_write') return;

            if (slowDecisionTimer) {
              clearTimeout(slowDecisionTimer);
              slowDecisionTimer = undefined;
            }

            this.emitObservation(
              {
                thinking: translate('chat.subAgentToolCallProgress', {
                  tool: progress.toolName,
                  kb: Math.max(1, Math.round(progress.argBytes / 1024)),
                }),
                transient: true,
                step: stepCount,
                timestamp: Date.now(),
              },
              { collect: false }
            );
          }
        : undefined;
      const onReasoningTrace = this.observationCallback
        ? (progress: ReasoningTraceProgress) => {
            if (progress.content.trim().length === 0) return;

            if (slowDecisionTimer) {
              clearTimeout(slowDecisionTimer);
              slowDecisionTimer = undefined;
            }

            this.emitObservation(
              {
                thinking: '',
                reasoningTrace: {
                  content: progress.content,
                  isStreaming: !progress.done,
                  completed: progress.done,
                },
                step: stepCount,
                timestamp: Date.now(),
              },
              { collect: false }
            );
          }
        : undefined;
      try {
        response = await caller.callWithContext(
          systemPrompt,
          spec.allowedTools,
          managedMessages.slice(1).map((m) => ({
            role: m.role as 'assistant' | 'tool',
            content: m.content,
            toolName: m.toolName,
            toolCalls: m.toolCalls,
            toolCallId: m.toolCallId,
            images: m.images,
            preserveImagesOnVisionFallback: m.preserveImagesOnVisionFallback,
            reasoningContent: m.reasoningContent,
            timestamp: Date.now(),
          })),
          additionalInstructions, // 传递 Master Brain 的策略调整指令
          signal, // 传递 AbortSignal，终止时立即中断 LLM HTTP 请求
          // 持久化的用户介入消息：每步 LLM 调用都会将其注入到尾部热区。
          // 若 Safety Footer 已启用，则用户介入消息会位于 Footer 之后。
          // stepsSinceIntervention = 0 表示介入就在本步之前（首次生效）。
          persistedUserIntervention
            ? {
                message: persistedUserIntervention,
                stepsSinceIntervention: stepCount - interventionAtStep,
              }
            : undefined,
          onToolCallProgress,
          onReasoningTrace
        );
      } finally {
        if (slowDecisionTimer) {
          clearTimeout(slowDecisionTimer);
        }
      }
      const llmElapsedMs = Date.now() - llmCallStartedAt;

      // LLM 返回后立即检测中断信号——防止在 LLM 流式传输结束后还继续处理响应
      // 场景：Rust 端收到 llm_cancel_stream 后停止流并返回截断内容，
      // 此处在推入消息历史之前提前退出，避免继续执行工具调用。
      if (signal?.aborted) {
        logger.debug('[SubAgentRunner] ⛔ LLM 返回后检测到中断信号，立即停止');
        terminationReason = 'cancelled';
        break;
      }

      // 上报 API 返回的 token 用量到 statusStore
      try {
        const { useStatusStore } = await import('@stores/statusStore');
        const statusState = useStatusStore.getState();
        const tokenContextId =
          this.contextId ??
          (await import('@stores/agentStore')).useAgentStore.getState().currentAgentId;
        if (tokenContextId) {
          const estimatedOutput = this.estimateMessageTokens([
            {
              role: 'assistant',
              content: response.content || '',
              toolCalls: response.rawToolCalls,
            },
          ]);
          const inputTokens = getPositiveTokenCount(response.inputTokens) ?? preCallTokens;
          const outputTokens = getPositiveTokenCount(response.outputTokens) ?? estimatedOutput;
          statusState.addTokenUsage(tokenContextId, inputTokens, outputTokens);
          statusState.setContextPressure(tokenContextId, inputTokens, this.contextWindowSize);
        }
      } catch {
        // statusStore 访问失败不影响主流程
      }

      // 应用后清空，避免重复
      if (additionalInstructions) {
        logger.debug('[SubAgentRunner] 📝 已应用策略调整指令');
        additionalInstructions = undefined;
      }

      // 📊 LLM 响应日志（含 token 用量统计）
      const responseType = response.error
        ? 'error'
        : response.rawToolCalls?.length
          ? 'tool_use'
          : 'text';
      const responseTokens = this.estimateMessageTokens([
        { role: 'assistant', content: response.content || '' },
      ]);
      const postCallTokens = preCallTokens + responseTokens;
      logger.debug(
        `[SubAgentRunner] 📨 LLM 响应 - type: ${responseType} | tools: ${response.rawToolCalls?.length ?? 0} | content:`,
        response.content.length > 0 ? `\n${response.content}` : '(empty)'
      );
      logger.debug(
        `[SubAgentRunner] 📊 Token 用量 - 本轮发送: ${preCallTokens}, 响应: ${responseTokens}, 累计: ${postCallTokens} (Step ${stepCount}, 工具步: ${toolCallSteps}/${maxSteps})`
      );

      // API 错误处理（429 限速、网络中断、500 服务器错误等）
      // 区分可重试错误和不可重试错误，避免将空回复推入消息历史
      if (response.error) {
        const errorMsg = response.error;
        const retryClassification = classifyLlmRetry(errorMsg);

        if (retryClassification.shouldRetry) {
          consecutiveApiErrors++;
          const maxRetries = SUB_AGENT_LLM_RETRY_DELAYS_MS.length;

          if (consecutiveApiErrors <= maxRetries) {
            const waitMs = getLlmRetryDelayMs(consecutiveApiErrors, SUB_AGENT_LLM_RETRY_DELAYS_MS);
            logger.debug(
              `[SubAgentRunner] ⏳ 可重试 API 错误 (${retryClassification.reason})，` +
                `等待 ${waitMs}ms 后重试 (${consecutiveApiErrors}/${maxRetries})`
            );
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            // 回退 stepCount：重试不算作一次新的 LLM 决策步骤。
            // continue 会跳回循环顶部再执行 stepCount++，若不回退
            // 每次重试都会占用一个步骤编号（导致最终步数虚高。
            stepCount--;
            // 不推入消息历史，直接下一轮循环重试
            continue;
          }

          // 超过重试上限：终止
          logger.debug(`[SubAgentRunner] ❌ 可重试错误已达上限 (${maxRetries}次)，终止循环`);
        } else {
          logger.debug(
            `[SubAgentRunner] ❌ 不可重试 API 错误 (${retryClassification.reason})，` +
              `终止循环: ${errorMsg.slice(0, 200)}`
          );
        }

        // 设置错误信息为最终输出，确保 UI 显示错误而非上一轮内容
        lastContent = translate('chat.subAgentApiErrorShort', { error: errorMsg });
        terminated = true;
        terminationReason = 'api_error';
        break;
      }

      // 成功响应时重置连续 API 错误计数
      consecutiveApiErrors = 0;

      // Provider 明确报告输出 token 上限时，响应中的 tool-call 参数可能只有半截。
      // 必须在任何 assistant/tool 消息入栈、Checkpoint 或工具执行之前拦截，
      // 避免 Rust JSON repair 将残缺的 file_write 参数修成可执行的半文件写入。
      if (isOutputTokenLimitFinishReason(response.finishReason)) {
        const finishReason = response.finishReason?.trim() ?? 'unknown';
        if (!outputTruncationRetryUsed) {
          outputTruncationRetryUsed = true;
          additionalInstructions = translate('chat.subAgentOutputTruncatedRetryInstruction', {
            reason: finishReason,
          });
          this.emitObservation({
            thinking: translate('chat.subAgentOutputTruncatedRetryObservation', {
              reason: finishReason,
            }),
            step: stepCount,
            timestamp: Date.now(),
          });
          logger.warn(
            `[SubAgentRunner] Provider 输出被截断 (${finishReason})，已丢弃 ` +
              `${response.rawToolCalls?.length ?? 0} 个工具调用并安全重试一次`
          );
          continue;
        }

        lastContent = translate('chat.subAgentOutputTruncatedFailure', {
          reason: finishReason,
        });
        this.emitObservation({
          thinking: lastContent,
          step: stepCount,
          timestamp: Date.now(),
        });
        logger.warn(
          `[SubAgentRunner] Provider 输出再次被截断 (${finishReason})，` +
            `已丢弃 ${response.rawToolCalls?.length ?? 0} 个工具调用并终止`
        );
        terminated = true;
        terminationReason = 'output_token_limit';
        break;
      }

      const hasToolCalls = (response.rawToolCalls?.length ?? 0) > 0;
      const isEmptyTextDecision = !hasToolCalls && response.content.trim().length === 0;
      if (isEmptyTextDecision) {
        consecutiveEmptyResponses++;
        consecutiveTextOnlyResponses = 0;
        const elapsedSeconds = Math.max(0, Math.round(llmElapsedMs / 1000));
        logger.debug(
          `[SubAgentRunner] Empty LLM decision after ${elapsedSeconds}s ` +
            `(${consecutiveEmptyResponses}/${PLANNING_CONSTANTS.SUB_AGENT_EMPTY_RESPONSE_RETRY_LIMIT})`
        );
        this.emitObservation({
          thinking: translate('chat.subAgentEmptyDecisionRetry', { seconds: elapsedSeconds }),
          step: stepCount,
          timestamp: Date.now(),
        });

        if (consecutiveEmptyResponses <= PLANNING_CONSTANTS.SUB_AGENT_EMPTY_RESPONSE_RETRY_LIMIT) {
          const emptyResponseRetryInstruction = translate(
            'chat.subAgentEmptyDecisionRetryInstruction'
          );
          additionalInstructions = additionalInstructions
            ? `${additionalInstructions}\n\n${emptyResponseRetryInstruction}`
            : emptyResponseRetryInstruction;
          continue;
        }
      } else {
        consecutiveEmptyResponses = 0;
      }

      // Step B: 处理响应
      if (response.rawToolCalls && response.rawToolCalls.length > 0) {
        // 有工具调用：执行工具
        logger.debug(
          `[SubAgentRunner] 🔧 工具调用: ${response.rawToolCalls.map((t) => t.name).join(', ')}`
        );
        consecutiveTextOnlyResponses = 0;

        // 单步工具调用数截断：必须在推入 assistant 消息之前计算
        // 这样 assistant 消息中的 toolCalls 数量 与 后续 tool 结果消息数量 完全一致，
        // 避免部分严格 API（如 MiniMax）在下一步调用时因数量不匹配返回 400 错误。
        const maxToolsPerStep = PLANNING_CONSTANTS.MAX_TOOLS_PER_STEP;
        const toolCallsThisStep =
          response.rawToolCalls.length > maxToolsPerStep
            ? response.rawToolCalls.slice(0, maxToolsPerStep)
            : response.rawToolCalls;
        if (response.rawToolCalls.length > maxToolsPerStep) {
          logger.debug(
            `[SubAgentRunner] ⚠️ 单步工具调用截断: ${response.rawToolCalls.length} → ${maxToolsPerStep} ` +
              `(丢弃: ${response.rawToolCalls
                .slice(maxToolsPerStep)
                .map((tc) => tc.name)
                .join(', ')})`
          );
        }
        const toolCallsWithIds = toolCallsThisStep.map((tc, index) => ({
          ...tc,
          id: tc.id?.trim()
            ? tc.id
            : createSyntheticToolCallId(tc.name, syntheticToolCallRunSequence, stepCount, index),
        }));

        // 记录 Assistant 响应：保留截断后的工具调用信息和 thinking 文字
        // 注意：此处使用 toolCallsThisStep（非完整列表），确保与后续 tool 结果消息数匹配
        const assistantContent = response.content || '';
        messages.push({
          role: 'assistant',
          content: assistantContent,
          // 保留截断后的工具调用信息，包括 id（Anthropic/OpenAI 需要精确匹配）
          // GPT 系模型在特定 Prompt 条件下可能产生 name="" 的幻觉工具调用（如将
          // Prompt 中的语言规范误解为工具调用意图），需在此处对空 name 做安全占位，
          // 确保 assistant 消息与后续幻觉拦截写入的 tool_result name 保持一致，
          // 避免部分 API（如 OpenAI 兼容接口）因 name 字段缺失返回 400 Bad Request。
          toolCalls: toolCallsWithIds.map((tc) => ({
            name: tc.name || 'unknown_tool',
            args: tc.args,
            id: tc.id,
            ...(tc.thoughtSignature && { thoughtSignature: tc.thoughtSignature }),
          })),
          // DeepSeek 思考模式：将 reasoning_content 存入 assistant 消息历史，下轮回传 API
          reasoningContent: response.reasoningContent,
        });

        // 更新 lastContent：确保非终止信号的文字响应也被记录
        // 这样即使因 no_progress 终止，也能保留最后的 thinking 内容
        if (assistantContent) {
          lastContent = assistantContent;
        }

        // 高风险操作前的 Checkpoint（file_write + 非安全 exec）
        // file_write 白名单机制：如果 MB 在 allowedTools 中明确授权了 file_write，
        // 则 file_write 不算"意外高风险操作"，跳过即时 checkpoint。
        // 仅 exec（非安全命令）或未授权的 file_write 才触发高风险 checkpoint。
        const isFileWriteAuthorized = spec.allowedTools.includes('file_write');
        const hasHighRiskTool = response.rawToolCalls.some((tc) => {
          // file_write 已被 MB 授权时，不视为高风险
          if (tc.name === 'file_write') return !isFileWriteAuthorized;
          if (tc.name === 'exec') {
            // 命令级分流：安全命令跳过 Checkpoint
            const command = (tc.args.command as string | undefined) ?? '';
            return !isExecCommandSafe(command);
          }
          return false;
        });
        // 跳过已被 MB 批准过的高风险工具（方案 B：首次批准后静默放行）
        const pendingToolNamesForCheck = response.rawToolCalls.map((tc) => tc.name);
        const allApproved = pendingToolNamesForCheck.every((name) =>
          approvedHighRiskTools.has(name)
        );
        if (hasHighRiskTool && totalToolCalls > 0 && !allApproved) {
          logger.debug('[SubAgentRunner] ⚠️ 高风险操作，触发 Checkpoint');
          try {
            const pendingToolNames = response.rawToolCalls.map((tc) => tc.name);
            // 构建高风险操作的详细描述，帮助 MB 理解待执行操作的具体内容
            const pendingActionDetails = response.rawToolCalls
              .map((tc) => {
                const argsPreview =
                  tc.name === 'exec'
                    ? ((tc.args.command as string | undefined) ?? '').slice(0, 200)
                    : JSON.stringify(tc.args).slice(0, 200);
                return `${tc.name}: ${argsPreview}`;
              })
              .join('; ');
            const report = this.buildProgressReportFromMessages(
              spec.role,
              messages,
              totalToolCalls,
              config,
              stepCount,
              pendingToolNames,
              'high_risk_pre_execution',
              pendingActionDetails,
              toolCallSteps,
              maxSteps
            );
            const decision = await onCheckpoint(report, spec);

            // Checkpoint LLM 返回后检测中断信号
            // Checkpoint 内部会调用 MB LLM，期间用户可能已点击终止
            if (signal?.aborted) {
              logger.debug('[SubAgentRunner] ⛔ Checkpoint 后检测到中断信号，立即停止');
              terminated = true;
              terminationReason = 'cancelled';
              break;
            }

            if (decision.type === 'TERMINATE_SUB_AGENT') {
              terminated = true;
              // 根据 reason 内容区分"任务已完成"和"拒绝操作"两种语义
              const reasonLower = decision.reason.toLowerCase();
              const isTaskComplete =
                reasonLower.includes('complete') ||
                reasonLower.includes('fulfill') ||
                reasonLower.includes('success') ||
                reasonLower.includes('accomplish');
              terminationReason = isTaskComplete
                ? 'task_completed_by_master'
                : 'high_risk_rejected';
              logger.debug(
                `[SubAgentRunner] 🛑 Master Brain 终止: ${terminationReason} - ${decision.reason}`
              );
              break;
            }

            if (decision.type === 'ADJUST_STRATEGY') {
              // 注入进度摘要，防止上下文截断后 SA 重复操作
              const progressSummary = this.buildProgressSummaryForSA(messages);
              additionalInstructions = progressSummary + '\n\n' + decision.refinedInstructions;
              logger.debug('[SubAgentRunner] 🎯 Master Brain 调整策略（高风险前，含进度摘要）');
              applyBudgetExtension(decision.additionalIterations, '高风险 Checkpoint 策略调整');
            }

            // 高风险 Checkpoint 也可能返回 EXTEND_BUDGET（MB 批准操作并追加预算）
            if (decision.type === 'EXTEND_BUDGET') {
              applyBudgetExtension(decision.additionalIterations, '高风险 Checkpoint');
              if (decision.refinedInstructions) {
                additionalInstructions = decision.refinedInstructions;
              }
            }

            // MB 批准后，将本次涉及的工具加入已批准集合
            // 后续同类工具调用将跳过 Checkpoint，避免频繁触发
            for (const tc of response.rawToolCalls) {
              approvedHighRiskTools.add(tc.name);
            }
            logger.debug(
              `[SubAgentRunner] ✅ Master Brain 批准高风险操作，继续执行 (已批准工具: ${Array.from(approvedHighRiskTools).join(', ')})`
            );
          } catch (e) {
            // 高风险操作前 Checkpoint 解析失败 → 保守策略：终止执行
            // 如果 MB 无法给出明确 JSON 决策（如返回自然语言分析），
            // 不应放行高风险命令（可能导致 SA 执行注定超时的安装命令）
            logger.warn('[SubAgentRunner] 高风险 Checkpoint 解析失败，安全起见终止执行:', e);
            terminated = true;
            terminationReason = 'high_risk_checkpoint_failed';
            break;
          }
        }

        // toolCallsThisStep 已在推入 assistant 消息之前计算完毕（上方），此处直接使用

        // 执行每个工具
        let stepHadToolSuccess = false;
        let stepHadToolFailure = false;
        for (let tcIndex = 0; tcIndex < toolCallsWithIds.length; tcIndex++) {
          const tc = toolCallsWithIds[tcIndex];
          if (!tc) continue;
          // 每个工具执行前检查中断信号
          if (signal?.aborted) {
            logger.debug('[SubAgentRunner] ⛔ 工具执行前收到中断信号，停止执行');
            terminated = true;
            terminationReason = 'cancelled';
            break;
          }
          // 🛡️ 工具白名单校验：拦截工具幻觉
          // LLM 可能在注意力退化时编造不存在的工具名（如从路径字符串中提取）
          // GPT 系模型在特定 Prompt 条件下还可能产生 name="" 的幻觉调用
          if (!isAllowedToolName(tc.name, spec.allowedTools)) {
            logger.debug(
              `[SubAgentRunner] ⚠️ 工具幻觉拦截: "${tc.name}" 不在白名单中, ` +
                `允许的工具: [${spec.allowedTools.join(', ')}]`
            );
            const correctionContent = translate('chat.subAgentInvalidToolCorrection', {
              tool: tc.name || translate('chat.subAgentEmptyToolName'),
              tools: spec.allowedTools.join(', '),
            });
            // 使用安全占位符替代空 name，避免写入 name="" 的 tool_result。
            // 部分 OpenAI 兼容 API 对 name 字段有非空校验，空字符串会导致 400 Bad Request，
            // 而该 tool_result 对应的 assistant 消息中也已同步使用占位符（见上方），
            // 确保两侧 name 保持一致以满足 API 协议的 tool_use ↔ tool_result 对称性要求。
            const safeToolName = tc.name || 'unknown_tool';
            messages.push({
              role: 'tool',
              content: correctionContent,
              toolName: safeToolName,
              toolCallId: tc.id,
            });
            allToolCallNames.push(tc.name);
            totalToolCalls++;
            stepHadToolFailure = true;
            continue;
          }
          // 🛡️ 空参数防御：拦截 JSON args 解析失败导致的空对象
          // 当 LLM 返回的 tool_call JSON args 因 content 字段含未转义引号等问题导致
          // Rust 侧 serde_json 解析失败时，args 可能回退为空对象 {}。
          // 此时跳过实际执行，引导 LLM 重新生成参数。
          const WRITE_TOOLS = ['file_write', 'file_write_patch'];
          if (WRITE_TOOLS.includes(tc.name) && Object.keys(tc.args).length === 0) {
            logger.debug(
              `[SubAgentRunner] ⚠️ ${tc.name} 空参数拦截: args 为空对象（可能是 JSON 解析失败）`
            );
            const emptyArgsContent = translate('chat.subAgentEmptyWriteArgsCorrection', {
              tool: tc.name,
            });
            messages.push({
              role: 'tool',
              content: emptyArgsContent,
              toolName: tc.name,
              toolCallId: tc.id,
            });
            allToolCallNames.push(tc.name);
            totalToolCalls++;
            stepHadToolFailure = true;
            continue;
          }

          if (tc.name === 'file_write' && isMissingFullFileWriteContent(tc.args)) {
            const path =
              getFirstToolArg(tc.args, 'path', 'file_path', 'filePath') || '(missing path)';
            consecutiveMissingFileWriteContent++;
            logger.debug(
              `[SubAgentRunner] ⚠️ file_write 缺少 full content 参数拦截 (${consecutiveMissingFileWriteContent}): ${path}`
            );
            const missingContent = translate('chat.subAgentFileWriteMissingContentCorrection', {
              path,
            });
            messages.push({
              role: 'tool',
              content: missingContent,
              toolName: tc.name,
              toolCallId: tc.id,
            });
            allToolCallNames.push(tc.name);
            totalToolCalls++;
            stepHadToolFailure = true;
            if (consecutiveMissingFileWriteContent >= 2) {
              const repeatedInstruction = translate(
                'chat.subAgentFileWriteRepeatedMissingContentInstruction',
                { path, count: consecutiveMissingFileWriteContent }
              );
              additionalInstructions = additionalInstructions
                ? `${additionalInstructions}\n\n${repeatedInstruction}`
                : repeatedInstruction;
            }
            continue;
          }

          const executionToolCall = normalizeToolCallForExecution({ name: tc.name, args: tc.args });
          const observationToolName = getCanonicalToolName(tc.name);
          const observationToolCallId = tc.id;
          const observationToolTarget = extractToolTarget(
            observationToolName,
            executionToolCall.args,
            defaultWorkdir
          );
          const timeoutSeconds = getExplicitExecTimeoutSeconds(
            observationToolName,
            executionToolCall.args
          );
          this.emitObservation({
            thinking: tcIndex === 0 ? response.content || '' : '',
            toolAction: {
              toolCallId: observationToolCallId,
              tool: observationToolName,
              target: observationToolTarget.target,
              fullTarget: observationToolTarget.fullTarget,
              workdir: observationToolTarget.workdir,
              timeoutSeconds,
            },
            step: stepCount,
            timestamp: Date.now(),
          });

          const result = await toolExecutor(executionToolCall, { signal });
          allToolCallNames.push(tc.name);
          totalToolCalls++;

          if (result.requiresInteraction) {
            requiresInteraction = true;
          }

          // 收集 file_write 返回的 Diff 数据（用于传递给 UI 层）
          if (
            result.data &&
            typeof result.data.type === 'string' &&
            result.data.type.startsWith('file_write_')
          ) {
            collectedDiffData.push({
              type: result.data.type as FileWriteDiffRecord['type'],
              filePath: result.data.filePath as string,
              originalContent: result.data.originalContent as string | undefined,
              newContent: result.data.newContent as string | undefined,
              diff: result.data.diff,
              xml: result.data.xml as string | undefined,
              changeRatio: result.data.changeRatio as number | undefined,
              bytesWritten: result.data.bytesWritten as number | undefined,
              modificationCount: result.data.modificationCount as number | undefined,
            });
            logger.trace(
              `[SubAgentRunner]   📄 收集到 Diff 数据: ${result.data.type} → ${String(result.data.filePath)}`
            );

            // 实时发射：让 UI 立即显示本次 file_write 的 diff，无需等待 SA 完成
            const latestDiff = collectedDiffData[collectedDiffData.length - 1];
            if (latestDiff) {
              this.emitDiffData(latestDiff);
            }
          }

          // 工具输出直接使用原始内容，由 compressHistoricalToolOutputs 负责历史压缩
          const toolContent = result.content;

          // 将工具结果加入消息历史（带 toolCallId 以匹配 Gemini functionResponse）
          const resultPrefix = result.success ? '✅' : '❌';
          const toolResultContent = `[${tc.name}] ${resultPrefix}\n${toolContent}`;
          messages.push({
            role: 'tool',
            content: toolResultContent,
            toolName: tc.name,
            // 使用 API 返回的原始 tool_use id（Anthropic 要求精确匹配）
            // 回退到 `name_timestamp` 格式（用于不需要 id 匹配的 provider）
            toolCallId: observationToolCallId,
            // 透传图片附件（多模态 tool_result，Anthropic 协议支持）
            ...(result.images && result.images.length > 0 && { images: result.images }),
          });
          if (tc.name === 'file_write' && result.success) {
            consecutiveMissingFileWriteContent = 0;
            this.compactExecutedFileWriteToolCallArgs(messages, observationToolCallId);
          }

          // 调试：确认 images 透传
          if (result.images && result.images.length > 0) {
            logger.trace(
              '[SubAgentRunner] 📷 images 透传到消息:',
              result.images.length,
              '张, 首张 MIME:',
              result.images[0]?.mimeType,
              'data 长度:',
              result.images[0]?.data.length
            );
          }

          // 更新观测事件：工具完成态复用 pending 事件的 ID，避免 UI 出现重复行。
          this.emitObservation({
            thinking: '',
            toolAction: {
              toolCallId: observationToolCallId,
              tool: tc.name,
              target: observationToolTarget.target,
              fullTarget: observationToolTarget.fullTarget,
              workdir: observationToolTarget.workdir,
              timeoutSeconds,
              success: result.success,
            },
            step: stepCount,
            timestamp: Date.now(),
          });

          // ━━ Task Artifact 自动提取 ━━
          // 工具只要返回了结果就写入 Artifact Store（成功和失败都保留），
          // 避免授权弹窗、长命令或终止信号之间的竞态导致已完成工具结果丢失。
          this.storeToolResultAsArtifact(tc.name, tc.args, toolResultContent, spec.role);

          // 工具执行完毕后检测中断信号
          // exec 等长耗时工具运行时 JS 被阻塞，signal 触发后只能在此处感知；
          // 注意必须在结果入栈和 artifact 写入后再停止，避免丢失最后一条工具结果。
          if (signal?.aborted) {
            logger.debug(
              '[SubAgentRunner] ⛔ 工具执行完毕后检测到中断信号，已保留工具结果并停止执行'
            );
            terminated = true;
            terminationReason = 'cancelled';
            break;
          }

          // 日志增强：失败时输出具体内容以便调试
          if (result.success) {
            logger.trace(`[SubAgentRunner]   - ${tc.name}: 成功`);
            stepHadToolSuccess = true;

            // 检测 file_write 无变化写入（"File content is unchanged"关键字）
            // 注意：只有 file_write 工具才影响此计数器，read 等其他工具不应重置它
            if (tc.name === 'file_write') {
              if (result.content.includes('File content is unchanged')) {
                consecutiveNoChangeWrites++;
                logger.debug(
                  `[SubAgentRunner]   ⚠️ file_write 无变化 (${consecutiveNoChangeWrites}/${MAX_CONSECUTIVE_NO_CHANGE})`
                );
              } else {
                // 只有 file_write 实际产生了变化时才重置计数
                consecutiveNoChangeWrites = 0;
              }
            }

            // 检测 exec 相同命令重复执行（精确命令匹配）
            // 防止 SA 用同一验证命令反复循环；签名包含 workdir，避免不同目录下的 dir/ls 误判。
            if (tc.name === 'exec') {
              const execSignature = buildExecRepeatSignature(tc.args, defaultWorkdir);
              if (execSignature && execSignature === lastExecSignature) {
                consecutiveIdenticalExecs++;
                logger.debug(
                  `[SubAgentRunner]   ⚠️ exec 相同命令 (${consecutiveIdenticalExecs}/${MAX_CONSECUTIVE_IDENTICAL_EXECS})`
                );
                if (consecutiveIdenticalExecs >= MAX_CONSECUTIVE_IDENTICAL_EXECS) {
                  logger.debug(
                    `[SubAgentRunner] ⚠️ 连续 ${consecutiveIdenticalExecs} 次相同 exec 命令，强制终止`
                  );
                  terminated = true;
                  terminationReason = 'consecutive_identical_execs';
                  break;
                }
              } else {
                consecutiveIdenticalExecs = execSignature ? 1 : 0;
                lastExecSignature = execSignature;
              }
            } else {
              consecutiveIdenticalExecs = 0;
              lastExecSignature = '';
            }
          } else {
            const contentPreview = result.content.substring(0, 200) || '(empty)';
            logger.debug(`[SubAgentRunner]   - ${tc.name}: 失败 | ${contentPreview}`);
            stepHadToolFailure = true;
            consecutiveIdenticalExecs = 0;
            lastExecSignature = '';
          }
        }

        // 记录本轮为一个"工具调用步"（用于计算平均并行度）
        toolCallSteps++;
        if (terminated) {
          break;
        }

        if (stepHadToolSuccess) {
          consecutiveFailures = 0;
        } else if (stepHadToolFailure) {
          consecutiveFailures++;
        }

        // 连续失败检测：连续多个工具调用步都没有任何成功结果时强制触发 Checkpoint
        // 防止安全命令（如 dir）因搜索不到文件而死循环，同时避免并发失败被误算成多步失败。
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logger.debug(
            `[SubAgentRunner] ⚠️ 连续失败 ${consecutiveFailures} 步，强制触发 Checkpoint`
          );
          try {
            const pendingToolNames = response.rawToolCalls.map((tc) => tc.name);
            const report = this.buildProgressReportFromMessages(
              spec.role,
              messages,
              totalToolCalls,
              config,
              stepCount,
              pendingToolNames,
              'consecutive_failures',
              undefined,
              toolCallSteps,
              maxSteps
            );
            const decision = await onCheckpoint(report, spec);

            if (decision.type === 'TERMINATE_SUB_AGENT') {
              terminated = true;
              terminationReason = 'consecutive_failures';
              logger.debug(`[SubAgentRunner] 🛑 连续失败终止: ${decision.reason}`);
              break;
            }

            if (decision.type === 'ADJUST_STRATEGY') {
              // 注入进度摘要，防止上下文截断后 SA 重复操作
              const progressSummary = this.buildProgressSummaryForSA(messages);
              additionalInstructions = progressSummary + '\n\n' + decision.refinedInstructions;
              consecutiveFailures = 0; // 策略调整后重置计数
              logger.debug(
                `[SubAgentRunner] 🎯 策略调整（含进度摘要）: ${decision.refinedInstructions.slice(0, 80)}...`
              );
              applyBudgetExtension(decision.additionalIterations, '连续失败 Checkpoint 策略调整');
            }

            if (decision.type === 'EXTEND_BUDGET') {
              applyBudgetExtension(decision.additionalIterations, '连续失败 Checkpoint');
              consecutiveFailures = 0; // 延长预算后重置计数
            }
          } catch (e) {
            logger.warn('[SubAgentRunner] 连续失败 Checkpoint 异常，继续执行:', e);
          }
        }

        // 连续无变化写入检测：file_write 反复返回无变化时自动终止
        // 防止模型用已失效的 search 反复尝试同一个 patch
        if (consecutiveNoChangeWrites >= MAX_CONSECUTIVE_NO_CHANGE && !terminated) {
          logger.debug(
            `[SubAgentRunner] ⚠️ 连续 ${consecutiveNoChangeWrites} 次 file_write 无变化，强制终止`
          );
          terminated = true;
          terminationReason = 'consecutive_no_change_writes';
          break;
        }

        // 定期 Checkpoint（每 N 次工具调用）
        if (toolCallSteps > 0 && toolCallSteps % config.checkpointInterval === 0) {
          logger.debug('[SubAgentRunner] 📊 定期 Checkpoint');
          try {
            const report = this.buildProgressReportFromMessages(
              spec.role,
              messages,
              totalToolCalls,
              config,
              stepCount,
              undefined,
              'periodic',
              undefined,
              toolCallSteps,
              maxSteps
            );
            const decision = await onCheckpoint(report, spec);

            switch (decision.type) {
              case 'TERMINATE_SUB_AGENT':
                terminated = true;
                terminationReason = 'checkpoint_terminate';
                logger.debug(
                  `[SubAgentRunner] 🛑 Master Brain 决策：终止执行 - ${decision.reason}`
                );
                break;

              case 'EXTEND_BUDGET':
                applyBudgetExtension(decision.additionalIterations, '定期 Checkpoint');
                if (decision.refinedInstructions) {
                  additionalInstructions = decision.refinedInstructions;
                }
                break;

              case 'ADJUST_STRATEGY': {
                // 注入进度摘要，防止上下文截断后 SA 重复操作
                const cpProgressSummary = this.buildProgressSummaryForSA(messages);
                additionalInstructions = cpProgressSummary + '\n\n' + decision.refinedInstructions;
                logger.debug(
                  `[SubAgentRunner] 🎯 Master Brain 决策：调整策略（含进度摘要） - ${decision.refinedInstructions.slice(0, 50)}...`
                );
                applyBudgetExtension(decision.additionalIterations, '定期 Checkpoint 策略调整');
                break;
              }
            }
          } catch {
            logger.warn('[SubAgentRunner] Checkpoint 失败，继续执行');
          }
        }
      } else {
        // 文本响应：检测上下文重置摘要 / 终止信号
        lastContent = response.content;

        // 上下文重置拦截：SA 输出了上下文摘要，执行历史清空 + 摘要注入
        // 必须在 push 到 messages 和终止检测之前拦截
        if (contextResetInProgress && response.content.includes(CONTEXT_SUMMARY_MARKER)) {
          // 提取摘要内容（标记之后的全部文字）
          const summaryContent =
            response.content.split(CONTEXT_SUMMARY_MARKER)[1]?.trim() ?? response.content;

          this.executeContextReset(messages, summaryContent, 'sa_summary');
          // 重置完成后解锁，允许后续步骤再次触发重置（支持多次重置）
          contextResetInProgress = false;

          // 重置相关计数器（token 自然归零，工具调用数不重置——保持总预算控制）
          consecutiveFailures = 0;
          consecutiveNoChangeWrites = 0;
          consecutiveMissingFileWriteContent = 0;
          consecutiveTextOnlyResponses = 0;
          consecutiveIdenticalExecs = 0;
          lastExecSignature = '';

          // 跳过终止检测和 no_progress 检测——这不是真正的无进展文本响应
          continue;
        }

        messages.push({
          role: 'assistant',
          content: response.content,
        });

        logger.debug(`[SubAgentRunner] 💬 文本响应 (${response.content.length} 字符)`);

        // 发射观测事件：LLM 思考文字（无工具调用的纯文本步骤）
        this.emitObservation({
          thinking: response.content,
          step: stepCount,
          timestamp: Date.now(),
        });

        // 检测终止信号
        if (this.checkTerminationSignal(response.content, config)) {
          terminated = true;
          terminationReason = 'termination_signal_detected';
          logger.debug('[SubAgentRunner] ✅ 检测到终止信号，任务完成');
          break;
        }

        // 有文本但无工具调用、无终止信号：先动态纠偏，再终止。
        // 这能处理部分模型反复输出 observation/结论但不调用工具的模式。
        consecutiveTextOnlyResponses++;
        if (consecutiveTextOnlyResponses >= TEXT_ONLY_DECISION_TERMINATE_AFTER) {
          logger.debug('[SubAgentRunner] ⚠️ 连续文本响应但无工具调用，终止循环');
          terminated = true;
          terminationReason = 'no_progress';
          break;
        }

        if (consecutiveTextOnlyResponses >= TEXT_ONLY_DECISION_RETRY_AFTER) {
          const retryInstruction = translate('chat.subAgentTextOnlyDecisionRetryInstruction', {
            count: consecutiveTextOnlyResponses,
          });
          additionalInstructions = additionalInstructions
            ? `${additionalInstructions}\n\n${retryInstruction}`
            : retryInstruction;

          this.emitObservation({
            thinking: translate('chat.subAgentTextOnlyDecisionRetry', {
              count: consecutiveTextOnlyResponses,
            }),
            step: stepCount,
            timestamp: Date.now(),
          });
          continue;
        }
      }
    }

    // 检查是否因上限终止
    if (!terminated) {
      if (toolCallSteps >= maxSteps) {
        terminationReason = 'max_steps_reached';
      } else if (totalToolCalls >= PLANNING_CONSTANTS.TOOL_CALLS_HARD_LIMIT) {
        terminationReason = 'tool_calls_hard_limit';
      }
    }

    // 最终 token 用量统计
    const finalTokens = this.estimateMessageTokens(messages);
    logger.debug(
      `[SubAgentRunner] 🏁 原子循环结束: ${terminationReason ?? 'unknown'} (步骤: ${stepCount}, 工具步: ${toolCallSteps}/${maxSteps}, 工具调用总计: ${totalToolCalls}, 最终消息Tokens: ${finalTokens})`
    );

    // SA 退出循环后清理 HITL 残留状态。
    // 需要清理的场景：
    // 1. SA 在最后一步被暂停后执行完毕，但用户尚未点击「继续」（resolver 或 preResolvedMap 残留）
    // 2. SA 因步数耗尽/abort 退出，pausedContexts 中仍有暂停标记
    // 如果 cleanup 时 resolversMap 中有残留（意味着 waitForResume 正在阻塞），
    // 下次任务调用 cleanup 时会删除 resolver 导致旧 Promise 永远挂起——
    // 但这不影响正确性：旧 SA 已退出循环，没有调用方在 await 这个 Promise。
    if (this.contextId) {
      useHitlStore.getState().cleanup(this.contextId);
      logger.debug(`[SubAgentRunner] 🧹 SA 退出循环，已清理 HITL 残留状态: ${this.contextId}`);
    }

    // 构建输出（包含收集到的 Diff 数据、结构化执行摘要和详细观测事件）
    return this.buildAtomicLoopOutput(
      lastContent,
      allToolCallNames,
      terminationReason,
      requiresInteraction,
      collectedDiffData,
      messages,
      this.collectedObservationEvents
    );
  }

  /**
   * 压缩历史工具输出，保护 SKILL.md 注意力窗口
   *
   * 策略：
   * - 最近 KEEP_RECENT_ROUNDS 轮的工具输出完整保留（保证 LLM 能回溯最新上下文）
   * - 更早的 tool 消息按三级梯度压缩（full/truncated/meta）
   * - system 和 user 消息永远不压缩
   * - assistant 的正文不压缩，只压缩已执行的大 file_write 入参
   *
   * 一轮 = 一次 assistant 消息 + 其对应的 N 条 tool 响应
   *
   * @param messages - 原始消息列表（不修改原数组）
   * @param compressor - 工具输出压缩器实例
   * @param currentStep - 当前步骤数（用于日志）
   * @returns 压缩后的消息列表和本轮节省的 token 量
   */
  private compressHistoricalToolOutputs(
    messages: LoopMessage[],
    compressor: ToolOutputCompressor,
    currentStep: number
  ): { messages: LoopMessage[]; savedTokens: number } {
    // Token 压力触发——当总 tokens 超过上下文窗口的阈值时，动态缩小保护区
    const totalTokens = this.estimateMessageTokens(messages);
    const pressureThreshold =
      this.getContextWindowSize() * PLANNING_CONSTANTS.SUB_AGENT_TOKEN_PRESSURE_RATIO;
    const isUnderPressure = totalTokens > pressureThreshold;

    // 可变保护轮数：正常为常量值，Token 压力下缩减为 1
    const keepRecentRounds: number = isUnderPressure
      ? 1
      : PLANNING_CONSTANTS.SUB_AGENT_HISTORY_KEEP_RECENT_ROUNDS;

    if (isUnderPressure) {
      logger.debug(
        `[SubAgentRunner] ⚡ Token 压力触发: ${totalTokens} tokens > ` +
          `${Math.floor(pressureThreshold)} 阈值, 保护区缩减为 1 轮`
      );
    }

    // 计算轮次边界：每条 assistant 消息标记一轮的开始
    // 从后往前找到最近 N 轮的起始索引
    let roundCount = 0;
    let protectedStartIndex = messages.length; // 默认保护到末尾
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role === 'assistant') {
        roundCount++;
        if (roundCount >= keepRecentRounds) {
          protectedStartIndex = i;
          break;
        }
      }
    }

    // 如果历史轮数不够，无需压缩
    if (roundCount < keepRecentRounds) {
      return { messages, savedTokens: 0 };
    }

    let totalCompressed = 0;
    let totalSavedTokens = 0;

    // 构建压缩后的消息列表
    const compressedMessages: LoopMessage[] = messages.map((msg, index) => {
      // 保护区域内的消息完整保留
      if (index >= protectedStartIndex) {
        return msg;
      }

      // assistant 消息中已成功执行的 file_write 的 toolCalls.args.content 压缩。
      // 大文件写入参数会在下一轮 LLM 请求、Tauri IPC 和 WebView 内存中被重复复制，
      // 因此即使未达到全局 Token 压力，也要对超过阈值的已执行写入做摘要化。
      // 阈值：使用 estimateTextTokens 对齐 SA 上下文管理的 token 换算方式，
      // 3000 tokens 以下的小文件保留完整内容（防止 SA 反复 read 自己写的文件验证）
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const mappedToolCalls = msg.toolCalls.map((tc) => {
          if (tc.name !== 'file_write') return { toolCall: tc, compressed: false };
          const contentArg = tc.args.content;
          if (typeof contentArg !== 'string') return { toolCall: tc, compressed: false };

          // 使用 estimateTextTokens 对齐 SA 上下文管理的 token 换算方式
          const contentTokens = this.estimateTextTokens(contentArg);
          if (!isUnderPressure && contentTokens < FILE_WRITE_ARGS_COMPRESS_TOKEN_THRESHOLD)
            return { toolCall: tc, compressed: false };

          // 确认后续 tool 结果为成功（已执行的 file_write）
          const followingToolMsg = messages
            .slice(index + 1)
            .find(
              (m) =>
                m.role === 'tool' &&
                m.toolName === 'file_write' &&
                (!tc.id || m.toolCallId === tc.id)
            );
          if (!followingToolMsg || followingToolMsg.content.includes('❌')) {
            return { toolCall: tc, compressed: false };
          }

          return this.compactFileWriteToolCallArgs(tc);
        });
        const argsCompressed = mappedToolCalls.some((item) => item.compressed);
        const compressedToolCalls = mappedToolCalls.map((item) => item.toolCall);

        if (argsCompressed) {
          // 计算节省的 token 量（使用中英文混合算法，与全局保持一致）
          const originalTcTokens = msg.toolCalls.reduce(
            (sum, tc) => sum + this.estimateTextTokens(JSON.stringify(tc.args)),
            0
          );
          const newTcTokens = compressedToolCalls.reduce(
            (sum, tc) => sum + this.estimateTextTokens(JSON.stringify(tc.args)),
            0
          );
          totalCompressed++;
          totalSavedTokens += originalTcTokens - newTcTokens;
          return { ...msg, toolCalls: compressedToolCalls };
        }
        return msg;
      }

      // 非 tool / 非 assistant 消息完整保留（system、user 等）
      if (msg.role !== 'tool') {
        return msg;
      }

      // 提取工具名和来源（从 content 中解析）
      const toolName = msg.toolName ?? 'unknown';
      const source = this.extractSourceFromToolContent(msg.content, toolName);
      const originalTokens = this.estimateMessageTokens([msg]);

      // read/web_search 混合压缩——利用 SA 已产出的 assistant 分析结论
      // 压力驱动策略：仅在 Token 压力下才启用激进压缩
      // 无压力时走标准梯度（< 5K 完整保留），避免指引/规范类文档被过早丢弃
      // 导致 SA 在长链路任务中因丢失上下文而被迫重读文档浪费步数
      if (
        isUnderPressure &&
        (toolName === 'read' || toolName === 'file_read' || toolName === 'web_search')
      ) {
        // 检查紧邻的 3 条消息内是否有 assistant 分析（防止远距离误匹配）
        // 限制搜索范围：距离太远的 assistant 分析可能并非对当前 tool 输出的分析
        const nearbyMessages = messages.slice(index + 1, index + 4);
        const nextAssistant = nearbyMessages.find(
          (m) => m.role === 'assistant' && m.content.length > 20
        );
        const hasAnalysis = !!nextAssistant;

        if (hasAnalysis) {
          // 有压力 + 有后续分析 → 激进压缩为元信息 + 引用提示
          const meta = compressor.extractToolMeta(msg.content, toolName, source);
          let metaLine: string;
          if (toolName === 'web_search') {
            const entryCount = meta.searchEntries?.length ?? '?';
            metaLine = `🔍 Searched "${meta.source}" (${entryCount} results) — see the assistant message above for the analysis conclusion`;
          } else {
            const lineCount = meta.lineCount ?? '?';
            const lang = meta.language ?? 'unknown';
            metaLine = `📄 Read ${meta.source || 'file'} (${lineCount} lines, ${lang} type) — see the assistant message above for the analysis conclusion`;
          }

          const newContent = `[${toolName}] ✅\n${metaLine}`;
          const savedTokens =
            originalTokens - this.estimateMessageTokens([{ ...msg, content: newContent }]);
          if (savedTokens > 0) {
            totalCompressed++;
            totalSavedTokens += savedTokens;
          }
          return { ...msg, content: newContent };
        }

        // 有压力但无后续分析 → 使用标准梯度压缩（保留更多原始内容供 SA 参考）
      }

      // 标准梯度压缩（其他工具 + 无后续分析的 read/web_search）
      const result = compressor.compress(msg.content, toolName, source);

      if (result.wasCompressed) {
        totalCompressed++;
        totalSavedTokens += result.originalTokens - result.finalTokens;
        return {
          ...msg,
          content: result.content,
        };
      }

      return msg;
    });

    if (totalCompressed > 0) {
      logger.debug(
        `[SubAgentRunner] 📦 上下文压缩: Step ${currentStep}, ` +
          `压缩 ${totalCompressed} 条历史工具输出, ` +
          `节省 ~${totalSavedTokens} tokens, ` +
          `保护最近 ${keepRecentRounds} 轮完整` +
          (isUnderPressure ? ' (token pressure mode)' : '')
      );
    }

    return { messages: compressedMessages, savedTokens: totalSavedTokens };
  }

  /**
   * 从工具输出内容中提取来源标识
   *
   * 用于压缩器的元信息提取（如文件路径、URL 等）
   */
  private extractSourceFromToolContent(content: string, toolName: string): string {
    // read/file_write 工具：提取文件路径
    if (toolName === 'read' || toolName === 'file_read' || toolName === 'file_write') {
      // 常见格式: "[read] ✅\n文件路径: xxx" 或 content 第一行包含路径
      const pathMatch =
        content.match(/(?:文件路径|path|file)[:：]\s*(.+)/i) ??
        content.match(/(?:\/|\\|[A-Z]:).+\.\w+/);
      return pathMatch ? (pathMatch[1]?.trim() ?? pathMatch[0]) : '';
    }

    // web_search 工具：提取查询词
    if (toolName === 'web_search') {
      const queryMatch = content.match(/(?:查询|query|搜索)[:：]\s*(.+)/i);
      return queryMatch ? (queryMatch[1] ?? '').trim() : '';
    }

    // exec 工具：提取命令
    if (toolName === 'exec' || toolName === 'shell_execute') {
      const cmdMatch = content.match(/(?:命令|command|cmd)[:：]\s*(.+)/i);
      return cmdMatch ? (cmdMatch[1] ?? '').trim() : '';
    }

    return '';
  }

  /**
   * 从消息历史构建进度报告
   *
   * @param currentStep - 当前 LLM 调用轮次（step 数），用于准确反映迭代进度
   * @param pendingToolNames - 即将执行的工具名称（用于高风险 Checkpoint 上下文）
   * @param checkpointTrigger - Checkpoint 触发类型，传递给 MB 以理解评估场景
   * @param pendingActionDetails - 待执行高风险操作的详细描述（工具名 + 参数预览）
   */
  private buildProgressReportFromMessages(
    subAgentId: string,
    messages: LoopMessage[],
    // totalToolCalls 在 remainingBudget 改为步数计费后已无消费点，保留签名以维持调用兼容性
    _totalToolCalls: number,
    config: SubAgentLoopConfig,
    currentStep: number,
    pendingToolNames?: string[],
    checkpointTrigger?: ProgressReport['checkpointTrigger'],
    pendingActionDetails?: string,
    /** 当前已执行的工具步数（步数计费） */
    toolCallSteps?: number,
    /** 当前步数上限（可变，受 EXTEND_BUDGET 调整） */
    maxSteps?: number
  ): ProgressReport {
    const toolMessages = messages.filter((m) => m.role === 'tool');

    // ━━ 三段式结构化报告 ━━
    // 旧逻辑仅 slice(-5) 取最近 5 条 tool 消息，对长链任务丢失前序进度。
    // 新逻辑：全量进度列表 + 最近详情 + SA 推理，总 token 开销相近但信息量大幅提升。
    const observationParts: string[] = [];

    // ▸ Part 1: 全量执行进度（每步一行：状态 + 工具名 + 首行摘要）
    if (toolMessages.length > 0) {
      observationParts.push(`## Execution Progress (${toolMessages.length} tool calls completed)`);
      for (const msg of toolMessages) {
        const toolName = msg.toolName ?? 'unknown';
        const isSuccess = msg.content.includes('✅');
        const status = isSuccess ? '✅' : '❌';
        // 首行摘要截断，避免进度列表膨胀
        const firstLine = (msg.content.split('\n')[0] ?? '').slice(0, 120);
        observationParts.push(`- ${status} \`${toolName}\`: ${firstLine}`);
      }
      observationParts.push('');
    }

    // ▸ Part 2: 最近执行详情（最近 3 条 tool 消息的内容，每条限制字符数）
    // 限制原因：exec 产生的大输出（HTML、长日志）若全量注入会使 Checkpoint prompt 暴涨。
    // Checkpoint MB 只需判断批准/拒绝，不需要完整工具输出——关键摘要 + 错误信息已足够。
    const MAX_RECENT_DETAIL_CHARS = 3000; // 单条工具消息的字符上限（~750 tokens）
    const recentCount = 3;
    const recentToolMessages = toolMessages.slice(-recentCount);
    if (recentToolMessages.length > 0) {
      observationParts.push('## Recent Details');
      const recentDetails = recentToolMessages
        .map((m) => {
          if (m.content.length <= MAX_RECENT_DETAIL_CHARS) {
            return m.content;
          }
          // 截断时保留首尾，便于看到错误信息（通常在末尾）
          const half = Math.floor(MAX_RECENT_DETAIL_CHARS / 2);
          const head = m.content.slice(0, half);
          const tail = m.content.slice(-half);
          return `${head}\n... (truncated ${m.content.length - MAX_RECENT_DETAIL_CHARS} characters) ...\n${tail}`;
        })
        .join('\n---\n');
      observationParts.push(recentDetails);
      observationParts.push('');
    }

    // ▸ Part 3: SA 最新推理（最近 1 条 assistant 消息的摘要）
    // 让 MB 了解 SA 的当前思路和计划，避免因看不到推理过程而误判 scope_violation
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant?.content) {
      const maxReasoningChars = 300;
      const reasoning =
        lastAssistant.content.length > maxReasoningChars
          ? lastAssistant.content.slice(0, maxReasoningChars) + '...'
          : lastAssistant.content;
      observationParts.push('## SA Reasoning');
      observationParts.push(reasoning);
      observationParts.push('');
    }

    let observations = observationParts.join('\n');

    // 高风险前置 Checkpoint：明确标注操作尚未执行，避免 MB 误判任务已完成
    if (checkpointTrigger === 'high_risk_pre_execution' && pendingToolNames?.length) {
      observations += '\n---\n';
      observations += '⚠️ CRITICAL: The following high-risk operation has NOT been executed yet.\n';
      observations += 'This checkpoint was triggered BEFORE execution to request approval.\n';
      observations += `⏳ PENDING OPERATION (awaiting approval): ${pendingToolNames.join(', ')}\n`;
      if (pendingActionDetails) {
        observations += `📋 Operation details: ${pendingActionDetails}\n`;
      }
      observations +=
        '⛔ The task objective CANNOT be considered complete until this operation is actually executed and verified.';
    } else if (pendingToolNames && pendingToolNames.length > 0) {
      // 非高风险触发的 PENDING 信息（兼容旧逻辑）
      observations += `\n---\n⏳ PENDING (about to execute): ${pendingToolNames.join(', ')}`;
    }

    // 动态计算剩余预算：基于步数计费（toolCallSteps/maxSteps），与循环主预算语义一致
    // 旧逻辑用 totalToolCalls/checkpointInterval 折算，与 toolCallSteps < maxSteps 终止条件不一致
    const effectiveMaxSteps = maxSteps ?? config.maxSteps;
    const effectiveToolCallSteps = toolCallSteps ?? 0;
    const remainingBudget = Math.max(0, effectiveMaxSteps - effectiveToolCallSteps);

    // 动态计算置信度：基于成功的工具调用比例
    // 高风险前置 Checkpoint 时降低置信度——核心操作未执行不应有高置信度
    const successfulCalls = toolMessages.filter((m) => m.content.includes('✅')).length;
    let confidenceLevel =
      toolMessages.length > 0
        ? Math.min(0.9, 0.5 + (successfulCalls / toolMessages.length) * 0.4)
        : 0.5;
    if (checkpointTrigger === 'high_risk_pre_execution') {
      // 核心操作尚未执行，置信度上限为 0.5（防止高成功率的前序操作误导 MB）
      confidenceLevel = Math.min(confidenceLevel, 0.5);
    }

    // 动态判断是否需要更多迭代
    // 高风险前置 Checkpoint 时强制标记为需要更多迭代（操作还没执行）
    // 使用步数计费：toolCallSteps < maxSteps 表示还有执行空间
    const needsMoreIterations =
      checkpointTrigger === 'high_risk_pre_execution' ||
      checkpointTrigger === 'budget_near_exhaustion' ||
      (remainingBudget <= PLANNING_CONSTANTS.SUB_AGENT_BUDGET_CHECKPOINT_REMAINING_STEPS &&
        effectiveToolCallSteps > 0);

    return {
      subAgentId,
      // 使用实际 step 数（LLM 调用轮次），而非 ceil(totalToolCalls/2)
      // 一轮 LLM 可能并行调用多个工具（如 5 个 web_search），
      // 用工具数的一半会严重虚高迭代计数
      completedIterations: currentStep,
      remainingBudget,
      collectedObservations: observations,
      confidenceLevel,
      needsMoreIterations,
      requestedAdditionalBudget: needsMoreIterations
        ? PLANNING_CONSTANTS.SUB_AGENT_BUDGET_EXTENSION_MAX_ITERATIONS
        : undefined,
      checkpointTrigger,
      pendingHighRiskAction:
        checkpointTrigger === 'high_risk_pre_execution' ? pendingActionDetails : undefined,
    };
  }

  /**
   * 构建原子循环输出（统一格式，不区分 Agent 类型）
   *
   * 当 LLM 没有产生文本终止信号时（如被 Checkpoint 截断），
   * 从消息历史中自动构建结构化执行摘要作为 observations
   */
  private buildAtomicLoopOutput(
    content: string,
    toolCalls: string[],
    terminationReason: string | undefined,
    requiresInteraction: boolean,
    diffDataList?: FileWriteDiffRecord[],
    messages?: LoopMessage[],
    observationEvents?: SubAgentOutput['observationEvents']
  ): SubAgentOutput {
    // LLM 有文本响应就用它；否则从消息历史构建结构化摘要
    const observations =
      content ||
      (messages
        ? this.buildExecutionSummary(messages, terminationReason)
        : translate('chat.subAgentTaskExecutionCompleted'));

    // API 错误或重复输出截断导致的终止：标记为失败状态
    const isFailure =
      terminationReason === 'api_error' || terminationReason === 'output_token_limit';

    const output: SubAgentOutput = {
      status: isFailure ? 'failed' : 'completed',
      outputValid: !isFailure,
      observations,
      uncertaintyDelta: -0.2,
      executionStatus: isFailure ? 'failure' : 'success',
      observedEffects: translate('chat.subAgentObservedEffects', {
        count: toolCalls.length,
        tools: toolCalls.join(', '),
      }),
      requiresInteraction,
      toolCalls,
      ...(isFailure && { error: content }),
    };

    // 附加 Diff 数据（非空时才添加，避免污染输出）
    if (diffDataList && diffDataList.length > 0) {
      output.diffDataList = diffDataList;
      logger.trace(`[SubAgentRunner] 📦 输出包含 ${diffDataList.length} 个 Diff 数据`);
    }

    // 附加详细观测事件（供 MB 感知 SA 的完整推理链和行动轨迹）
    if (observationEvents && observationEvents.length > 0) {
      output.observationEvents = observationEvents;
      logger.trace(`[SubAgentRunner] 📊 输出包含 ${observationEvents.length} 个观测事件`);
    }

    return output;
  }

  /**
   * 从消息历史构建结构化执行摘要
   *
   * 当 LLM 未返回文本终止信号时（如被 Checkpoint TERMINATE 截断或 API 错误中断），
   * 从工具执行历史中提取关键事实，生成可供 Master Brain 评估的报告。
   *
   * 关键：对 web_search/read 结果保留足够多的原始数据，
   * 确保 MB 重新派遣 SA 时能传递前序 SA 的中间成果，避免重复搜索。
   */
  private buildExecutionSummary(messages: LoopMessage[], terminationReason?: string): string {
    const toolResults = messages.filter((m) => m.role === 'tool');
    if (toolResults.length === 0) {
      // 无工具调用记录时，根据终止原因提供有意义的摘要
      // API 错误导致的单步中断需明确告知 MB，以便 MB 决策是否重试
      if (terminationReason === 'api_error') {
        // 尝试从 messages 中提取错误详情（通常在最后一条 assistant 或 system 消息中）
        const errorMsg =
          messages.filter((m) => m.role === 'assistant' || m.role === 'system').pop()?.content ??
          '';
        return translate('chat.subAgentApiErrorFirstCallSummary', {
          errorDetails: errorMsg
            ? translate('chat.subAgentApiErrorDetailsLine', {
                error: errorMsg.slice(0, 300),
              })
            : '',
        });
      }
      return translate('chat.subAgentNoToolRecordsSummary');
    }

    const lines: string[] = [];
    lines.push(translate('chat.subAgentExecutionSummaryTitle'));
    lines.push(
      translate('chat.subAgentTerminationReasonLine', {
        reason: this.formatTerminationReason(terminationReason),
      })
    );
    lines.push(
      translate('chat.subAgentToolCallCountLine', {
        count: toolResults.length,
      })
    );
    lines.push('');
    lines.push(translate('chat.subAgentExecutionStepsTitle'));

    // 逐步提取关键事实，按工具类型差异化保留数据量
    for (const msg of toolResults) {
      const toolName = msg.toolName ?? 'unknown';
      const isSuccess = msg.content.includes('✅');
      const status = isSuccess ? '✅' : '❌';
      const summary = this.extractToolResultForSummary(toolName, msg.content, isSuccess);
      lines.push(`- ${status} \`${toolName}\`: ${summary}`);
    }

    // 提取所有 assistant 的分析结论（SA 的思考过程包含关键洞察）
    const assistantAnalyses = messages
      .filter((m) => m.role === 'assistant' && m.content.length > 20)
      .map((m) => m.content);
    if (assistantAnalyses.length > 0) {
      lines.push('');
      lines.push(translate('chat.subAgentAnalysisConclusionsTitle'));
      // 保留最后 2 条 assistant 分析，每条限制 800 字符
      const recentAnalyses = assistantAnalyses.slice(-2);
      for (const analysis of recentAnalyses) {
        const truncated = analysis.length > 800 ? analysis.slice(0, 800) + '...' : analysis;
        lines.push(truncated);
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * 按工具类型差异化提取结果摘要
   *
   * web_search: 保留搜索结果关键数据（最多 1500 字符），这是最常被重复的操作
   * read: 保留文件路径 + 关键内容片段（最多 800 字符）
   * file_write/exec: 保留操作描述首行（200 字符）
   */
  private extractToolResultForSummary(
    toolName: string,
    content: string,
    isSuccess: boolean
  ): string {
    // 移除工具前缀标记（如 "[web_search] ✅\n"）
    const cleanContent = content.replace(/^\[\w+\]\s*[✅❌]\s*\n?/m, '').trim();

    if (toolName === 'web_search' && isSuccess) {
      // 搜索结果是最需要保留的中间成果——重新搜索浪费 API 调用和时间
      return cleanContent.length > 1500 ? cleanContent.slice(0, 1500) + '...' : cleanContent;
    }

    if ((toolName === 'read' || toolName === 'file_read') && isSuccess) {
      // 文件内容保留路径和关键片段
      return cleanContent.length > 800 ? cleanContent.slice(0, 800) + '...' : cleanContent;
    }

    // 其他工具（file_write, exec 等）：仅保留首行摘要
    return (cleanContent.split('\n')[0] ?? '').slice(0, 200);
  }

  /**
   * 将工具执行结果自动存入 Artifact Store
   *
   * 系统层自动提取，不依赖 LLM 的自觉性。
   * 按工具类型差异化保留数据量：
   * - web_search: 最多 3000 字符（搜索结果是最常被重复的操作）
   * - read: 最多 1500 字符（文件关键内容）
   * - exec: 最多 500 字符（命令输出摘要；成功和失败结果都会保留）
   * - file_write: 仅记录操作摘要（200 字符，已有 DiffData 持久化）
   */
  private storeToolResultAsArtifact(
    toolName: string,
    toolArgs: Record<string, unknown>,
    resultContent: string,
    saRole: string
  ): void {
    if (!this.artifactStore) return;

    // 按工具类型决定是否存储及存储量
    const config = this.getArtifactExtractionConfig(toolName);
    if (!config) return;

    // 截断内容到配置的最大长度
    const content =
      resultContent.length > config.maxChars
        ? resultContent.slice(0, config.maxChars) + '...'
        : resultContent;

    const sourceHint = this.extractSourceHint(toolName, toolArgs);

    this.artifactStore.write(toolName, content, config.dataType, sourceHint, saRole);
  }

  /**
   * 获取工具的 Artifact 提取配置
   *
   * 返回 null 表示该工具的结果不需要存入 Artifact
   */
  private getArtifactExtractionConfig(
    toolName: string
  ): { dataType: ArtifactDataType; maxChars: number } | null {
    switch (toolName) {
      case 'web_search':
        return { dataType: 'search_results', maxChars: 3000 };
      case 'read':
      case 'file_read':
        return { dataType: 'file_content', maxChars: 1500 };
      case 'exec':
      case 'shell_execute':
        return { dataType: 'execution_output', maxChars: 500 };
      case 'file_write':
        // file_write 已有 DiffData 持久化机制，仅记录操作摘要
        return { dataType: 'file_operation', maxChars: 200 };
      default:
        // 其他工具暂不存储
        return null;
    }
  }

  /**
   * 从工具参数中提取语义标识（用于 Artifact 的 sourceHint）
   */
  private extractSourceHint(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
      case 'web_search':
        return getFirstToolArg(args, 'query').slice(0, 100);
      case 'read':
      case 'file_read':
      case 'file_write':
        return getFirstToolArg(args, 'path', 'file_path').slice(0, 150);
      case 'exec':
      case 'shell_execute':
        return getFirstToolArg(args, 'command').slice(0, 80);
      default:
        return toolName;
    }
  }

  /**
   * 格式化终止原因为人类可读文本
   */
  private formatTerminationReason(reason?: string): string {
    const classifiedKind = getAgentLoopErrorKindForTerminationReason(reason);
    if (classifiedKind) {
      return getAgentLoopErrorSummary(classifiedKind);
    }

    const reasonMap: Record<string, string> = {
      task_completed_by_master: translate('chat.subAgentTerminationTaskCompletedByMaster'),
      high_risk_rejected: translate('chat.subAgentTerminationHighRiskRejected'),
      checkpoint_terminate: translate('chat.subAgentTerminationCheckpoint'),
      budget_checkpoint_terminate: translate('chat.subAgentTerminationBudgetCheckpoint'),
      termination_signal_detected: translate('chat.subAgentTerminationSignalDetected'),
      max_tool_calls_reached: translate('chat.subAgentTerminationToolLimit'),
      max_steps_reached: translate('chat.subAgentTerminationStepLimit'),
      no_progress: translate('chat.subAgentTerminationNoProgress'),
      consecutive_no_change_writes: translate('chat.subAgentTerminationNoChangeWrites'),
      consecutive_identical_execs: translate('chat.subAgentRepeatedExecsTermination'),
      api_error: translate('chat.subAgentTerminationApiError'),
      output_token_limit: translate('chat.subAgentTerminationOutputTokenLimit'),
      cancelled: translate('chat.subAgentTerminationCancelled'),
    };
    return (
      reasonMap[reason ?? ''] ?? reason ?? translate('chat.subAgentTerminationCompletedNormally')
    );
  }

  private checkTerminationSignal(content: string, config: SubAgentLoopConfig): boolean {
    return config.terminationPatterns.some((pattern) => content.includes(pattern));
  }

  /**
   * 构建注入给 SA 的进度摘要
   *
   * 从消息历史中提取已完成的工具调用，格式化为结构化列表。
   * 用于 ADJUST_STRATEGY 时防止 SA 因上下文压缩遗忘已执行的步骤。
   */
  private buildProgressSummaryForSA(messages: LoopMessage[]): string {
    const toolResults = messages.filter((m) => m.role === 'tool');
    if (toolResults.length === 0) return '';

    const lines: string[] = [translate('chat.subAgentProgressCompletedStepsTitle'), ''];
    for (const msg of toolResults) {
      const toolName = msg.toolName ?? 'unknown';
      const isSuccess = msg.content.includes('\u2705');
      const status = isSuccess ? '\u2705' : '\u274c';
      // 提取第一行作为摘要（限制长度避免膨胀 additionalInstructions）
      const firstLine = (msg.content.split('\n')[0] ?? '').slice(0, 120);
      lines.push(`- ${status} \`${toolName}\`: ${firstLine}`);
    }
    return lines.join('\n');
  }

  /**
   * 执行上下文重置（统一入口）
   *
   * 清空消息历史保留 system prompt，注入摘要为新的 user 消息。
   * 同时发射观测事件让 UI 能看到重置操作。
   *
   * @param messages - 消息数组（会被直接修改）
   * @param summaryContent - 摘要内容（来自 SA 或 Runner 机械提取）
   * @param source - 摘要来源标识（'sa_summary' 或 'mechanical_fallback'）
   */
  private executeContextReset(
    messages: LoopMessage[],
    summaryContent: string,
    source: 'sa_summary' | 'mechanical_fallback'
  ): void {
    const sourceLabel =
      source === 'sa_summary'
        ? translate('chat.subAgentContextResetSourceSa')
        : translate('chat.subAgentContextResetSourceMechanical');
    logger.debug(`[SubAgentRunner] 🔄 执行${sourceLabel}`);

    // 发射观测事件（让 UI 能看到摘要）
    this.emitObservation({
      thinking: translate('chat.subAgentContextResetObservation', {
        source: sourceLabel,
        summary: summaryContent.slice(0, 200),
      }),
      timestamp: Date.now(),
    });

    // 清空历史，保留 system prompt
    messages.length = 1;

    // 注入摘要为新的 user 消息，引导 SA 继续
    messages.push({
      role: 'user',
      content: translate('chat.subAgentContextResetResumeInstruction', {
        summary: summaryContent,
      }),
    });

    logger.debug(
      `[SubAgentRunner] ✅ ${sourceLabel}完成: 摘要 ${summaryContent.length} 字符, ` +
        `新消息数: ${messages.length}`
    );
  }

  /**
   * 构建 Runner 侧机械摘要（兜底用）
   *
   * 当 SA 未在指定步数内输出 ---CONTEXT_SUMMARY--- 摘要时，
   * Runner 自己从消息历史中机械提取关键信息作为退化摘要。
   * 复用 buildExecutionSummary 的工具结果提取 + 最后 2 条 assistant 分析。
   *
   * 虽然质量不如 LLM 自主总结，但远好于无摘要清空（会丢失全部上下文）。
   */
  private buildMechanicalSummary(messages: LoopMessage[]): string {
    const lines: string[] = [];
    lines.push(translate('chat.subAgentMechanicalSummaryTitle'));
    lines.push('');

    // 提取工具调用历史（复用 buildProgressSummaryForSA 的逻辑）
    const toolResults = messages.filter((m) => m.role === 'tool');
    if (toolResults.length > 0) {
      lines.push(translate('chat.subAgentCompletedStepsTitle'));
      for (const msg of toolResults) {
        const toolName = msg.toolName ?? 'unknown';
        const isSuccess = msg.content.includes('✅');
        const status = isSuccess ? '✅' : '❌';
        // 提取首行作为摘要，限制长度
        const firstLine = (msg.content.split('\n')[0] ?? '').slice(0, 120);
        lines.push(`- ${status} \`${toolName}\`: ${firstLine}`);
      }
      lines.push('');
    }

    // 提取最后 2 条 assistant 分析结论（SA 的思考过程包含关键洞察）
    const assistantAnalyses = messages
      .filter((m) => m.role === 'assistant' && m.content.length > 20)
      .map((m) => m.content);
    if (assistantAnalyses.length > 0) {
      lines.push(translate('chat.subAgentAnalysisConclusionsShortTitle'));
      const recentAnalyses = assistantAnalyses.slice(-2);
      for (const analysis of recentAnalyses) {
        // 每条限制 500 字符，避免摘要过长
        const truncated = analysis.length > 500 ? analysis.slice(0, 500) + '...' : analysis;
        lines.push(truncated);
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * 获取当前任务的模型上下文窗口大小（总窗口）
   *
   * 回退到默认值以确保在无模型信息时仍能工作。
   */
  private getContextWindowSize(): number {
    return this.contextWindowSize;
  }
}
/**
 * 执行器单例
 */
export const subAgentRunner = new SubAgentRunner();
