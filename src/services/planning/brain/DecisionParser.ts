/**
 * DecisionParser - 决策解析器
 *
 * 职责：从 LLM 响应中提取并验证结构化决策
 *
 * 验证规则：
 * 1. 响应必须包含 JSON 代码块
 * 2. JSON 必须符合 Decision Schema
 */

import type { MasterBrainDecision } from './types';
import type { MbDecisionRetryCorrection } from './MasterBrainDecisionGuard';

// 复用项目统一的 JSON 解析工具
import {
  extractJsonFromText,
  sanitizeJson,
  parseWithFallback,
} from '../../memory/utils/JsonParser';
import { getLogger } from '@services/logger';
import { translate } from '@/i18n';

const logger = getLogger('DecisionParser');

// ═══════════════════════════════════════════════════════════════
// 错误类型
// ═══════════════════════════════════════════════════════════════

/**
 * 决策解析错误
 */
export class DecisionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionParseError';
  }
}

// ═══════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════

/** 有效的决策类型 */
const VALID_DECISION_TYPES = ['SPAWN_SUB_AGENT', 'REQUEST_MORE_INPUT', 'RESPOND_TO_USER'] as const;

/** 有效的风险等级 */
const VALID_RISK_LEVELS = ['low', 'medium', 'high'] as const;

/**
 * riskAssessment.level 字段语义别名映射表
 *
 * 覆盖 LLM 输出的非标准风险等级词汇。
 */
const RISK_LEVEL_ALIASES: Record<string, (typeof VALID_RISK_LEVELS)[number]> = {
  none: 'low',
  minimal: 'low',
  safe: 'low',
  moderate: 'medium',
  elevated: 'medium',
  critical: 'high',
  severe: 'high',
  danger: 'high',
};

const NESTED_DECISION_CANDIDATE_LIMIT = 3;

const DECISION_META_GARBAGE_LONG_TEXT_CHARS = 16000;
const REPETITION_COLLAPSE_MIN_REPEATS = 20;
const REPETITION_COLLAPSE_DOMINANT_COUNT = 40;
const REPETITION_COLLAPSE_DOMINANT_RATIO = 0.25;

const DECISION_META_TERMS = [
  'decision',
  'rationale',
  'riskassessment',
  'risk assessment',
  'nextstep',
  'next step',
  'respond_to_user',
  'spawn_sub_agent',
  'request_more_input',
  'json',
] as const;

const DECISION_META_SELF_TALK_PATTERNS = [
  /field should contain the reply/i,
  /i(?:'ll| will)\s+(?:set|include|produce|construct|write)/i,
  /final json/i,
  /output only json/i,
  /must ensure .*json/i,
  /the spec says/i,
] as const;

const TOOL_CALL_ENVELOPE_PATTERN =
  /<\s*\/?\s*(?:tool_call|function(?:_call)?)\b[^>]*>|\[\s*tool_call\s*\]/i;

export interface DecisionParseOutcome {
  decision: MasterBrainDecision;
  safeFallback?: MasterBrainDecision;
  quality?: 'perfect' | 'sanitized' | 'aggressive' | 'structural' | 'repaired';
  retryCorrection?: MbDecisionRetryCorrection;
}

interface NestedDecisionRecovery {
  decision: Record<string, unknown>;
  quality: NonNullable<DecisionParseOutcome['quality']>;
}

/** 有效的记忆访问权限 */

// ═══════════════════════════════════════════════════════════════
// DecisionParser 实现
// ═══════════════════════════════════════════════════════════════

/**
 * 决策解析器
 *
 * 从 LLM 响应中提取 JSON 决策并进行 Schema 验证
 */
export class DecisionParser {
  /**
   * 解析 LLM 响应为结构化决策
   *
   * @param rawResponse - LLM 原始响应文本
   * @returns 解析后的决策对象
   * @throws DecisionParseError - 解析或验证失败时抛出
   */
  parse(rawResponse: string): MasterBrainDecision {
    return this.parseDetailed(rawResponse).decision;
  }

  /**
   * 解析决策并保留修复质量与可重试失败原因，供 MasterBrain 统一消费
   * 一次语义纠错额度。
   */
  parseDetailed(rawResponse: string): DecisionParseOutcome {
    // 在提取 JSON 前先检查根对象之前的伪工具协议。否则非流式响应或单个
    // 大 chunk 中的 "<function...> + valid JSON" 会被 JSON 提取器静默接受。
    if (this.looksLikeToolCallEnvelope(rawResponse.trim())) {
      return this.buildFallbackOutcome(rawResponse);
    }

    // 1. 使用增强的 parseWithFallback 解析，支持截断 JSON 修复
    const parseResult = parseWithFallback<Record<string, unknown>>(rawResponse, {
      verbose: false,
      logPrefix: '[DecisionParser]',
    });

    if (!parseResult.success || !parseResult.data) {
      // 回退：尝试手动提取和清理
      try {
        const jsonString = this.extractJsonBlock(rawResponse);
        const cleanedJson = sanitizeJson(jsonString);
        const decision = JSON.parse(cleanedJson) as Record<string, unknown>;
        this.validateAndRepairSchema(decision);
        return this.buildSuccessfulOutcome(decision, 'sanitized');
      } catch {
        const recovery = this.tryRecoverNestedEscapedDecision(rawResponse);
        if (recovery) {
          logger.warn('[DecisionParser] 从嵌套转义 JSON 中恢复决策');
          return this.buildSuccessfulOutcome(recovery.decision, recovery.quality);
        }

        // 兜底：LLM 返回了纯文本（无 JSON），自动包装为 RESPOND_TO_USER
        // 常见于 Sub-Agent 完成后 MasterBrain 直接用自然语言总结
        logger.warn('[DecisionParser] JSON 解析全部失败，启用纯文本兜底 → RESPOND_TO_USER');
        return this.buildFallbackOutcome(rawResponse);
      }
    }

    // 2. 如果使用了修复策略，记录警告
    if (parseResult.quality === 'repaired') {
      logger.warn('[DecisionParser] JSON 被截断并已修复，某些字段可能不完整');
    } else if (parseResult.quality === 'structural') {
      logger.warn('[DecisionParser] JSON 存在轻微结构错误并已修复');
    } else if (parseResult.quality === 'aggressive') {
      logger.warn('[DecisionParser] 使用激进修复策略解析 JSON');
    }

    const decision = parseResult.data;

    // 3. Schema 验证与自动修复
    // 独立 catch：Schema 验证失败时降级兜底，而不是向上抛出崩溃 MasterBrain
    try {
      this.validateAndRepairSchema(decision);
    } catch (err) {
      if (err instanceof DecisionParseError) {
        logger.warn(`[DecisionParser] Schema 验证/修复均失败，降级为纯文本兜底: ${err.message}`);
        return {
          decision: this.buildMalformedDecisionFallback('Schema validation failure fallback'),
          quality: parseResult.quality,
          retryCorrection: {
            reason: 'schema_invalid',
            detail: err.message,
          },
        };
      }
      throw err;
    }

    // 4. 处理决策（包括 SPAWN_SUB_AGENT 特殊处理）
    return this.buildSuccessfulOutcome(decision, parseResult.quality);
  }

  /**
   * 处理解析后的决策
   *
   * 职责：基本决策类型检查（SpecBuilder 负责工程性字段构建）
   */
  private processDecision(decision: Record<string, unknown>): MasterBrainDecision {
    return decision as unknown as MasterBrainDecision;
  }

  /**
   * 恢复模型偶发的“坏外层 JSON + 内层转义决策 JSON”输出。
   *
   * 典型形态：
   * {
   *   "decision": "SPAWN_SUB_AGENT": "{\n  \"decision\": \"SPAWN_SUB_AGENT\", ... }"
   * }
   *
   * 这里不尝试猜测坏外层的语义，只接受内层字符串中能被解析且通过
   * MasterBrainDecision schema 校验的对象，避免把普通文本误判为决策。
   */
  private tryRecoverNestedEscapedDecision(rawResponse: string): NestedDecisionRecovery | null {
    const candidates = this.extractNestedJsonStringCandidates(rawResponse);

    for (const candidate of candidates) {
      const parseResult = parseWithFallback<Record<string, unknown>>(candidate, {
        verbose: false,
        logPrefix: '[DecisionParser:nested]',
        suppressWarnings: true,
      });

      if (!parseResult.success || !parseResult.data) {
        continue;
      }

      try {
        this.validateAndRepairSchema(parseResult.data);
        const quality =
          parseResult.quality === 'aggressive' || parseResult.quality === 'repaired'
            ? parseResult.quality
            : 'structural';
        return {
          decision: parseResult.data,
          quality,
        };
      } catch {
        continue;
      }
    }

    return null;
  }

  private buildSuccessfulOutcome(
    decision: Record<string, unknown>,
    quality: DecisionParseOutcome['quality']
  ): DecisionParseOutcome {
    const outcome: DecisionParseOutcome = {
      decision: this.processDecision(decision),
      quality,
    };

    if (quality === 'repaired') {
      outcome.retryCorrection = {
        reason: 'truncated_output',
        detail: 'JSON required truncated-input repair',
      };
      outcome.safeFallback = this.buildMalformedDecisionFallback('Truncated JSON repair fallback');
    } else if (quality === 'aggressive') {
      outcome.retryCorrection = {
        reason: 'aggressive_repair',
        detail: 'JSON required aggressive sanitization',
      };
      outcome.safeFallback = this.buildMalformedDecisionFallback('Aggressive JSON repair fallback');
    }

    return outcome;
  }

  private extractNestedJsonStringCandidates(rawResponse: string): string[] {
    const candidates: string[] = [];
    const seen = new Set<string>();
    const stringLiteralPattern = /"((?:\\[\s\S]|[^"\\])*)"/g;

    for (const match of rawResponse.matchAll(stringLiteralPattern)) {
      const encoded = match[1];
      if (!encoded?.includes('{')) {
        continue;
      }

      const decoded = this.decodeJsonStringFragment(encoded);
      if (!decoded) {
        continue;
      }

      const candidate = decoded.trim();
      if (!candidate.includes('"decision"')) {
        continue;
      }

      const startsLikeDecisionJson =
        candidate.startsWith('{') || /^```(?:json)?\s*\n?\s*\{/.test(candidate);
      if (!startsLikeDecisionJson || seen.has(candidate)) {
        continue;
      }

      candidates.push(candidate);
      seen.add(candidate);

      if (candidates.length >= NESTED_DECISION_CANDIDATE_LIMIT) {
        break;
      }
    }

    return candidates;
  }

  private decodeJsonStringFragment(encoded: string): string | null {
    try {
      const normalized = encoded.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
      return JSON.parse(`"${normalized}"`) as string;
    } catch {
      return null;
    }
  }

  /**
   * 从响应中提取 JSON 代码块
   *
   * 复用项目统一的 JsonParser 工具，支持：
   * - Markdown 代码块 (```json ... ```)
   * - 纯 JSON 对象/数组
   * - 混合文本中的 JSON
   */
  private extractJsonBlock(response: string): string {
    const extracted = extractJsonFromText(response);
    if (!extracted) {
      throw new DecisionParseError('No JSON block found in response');
    }
    return extracted;
  }

  /**
   * 构建纯文本兜底决策
   *
   * 两种场景：
   * 1. LLM 返回了纯文本（无 JSON） → 包装为用户回复（保留原文）
   * 2. LLM 返回了格式异常的 JSON → 解析失败,给用户明确错误提示
   *    而非把原始 JSON 碎片搬给用户造成误导
   */
  private buildFallbackOutcome(rawText: string): DecisionParseOutcome {
    const trimmed = rawText.trim();

    if (!trimmed) {
      logger.warn('[DecisionParser] MB 返回空正文，返回安全兜底并请求纠错重试');
      return {
        decision: this.buildMalformedDecisionFallback('Empty decision content fallback'),
        retryCorrection: {
          reason: 'empty_content',
          detail: 'Master Brain returned empty decision content',
        },
      };
    }

    if (this.looksLikeToolCallEnvelope(trimmed)) {
      logger.warn('[DecisionParser] 检测到 MB 伪工具调用协议，返回安全兜底');
      return {
        decision: this.buildMalformedDecisionFallback(
          'Tool-call envelope fallback',
          translate('chat.mbToolCallDecisionFallback')
        ),
        retryCorrection: {
          reason: 'tool_call_envelope',
          detail: 'Master Brain emitted a tool-call/function-call envelope instead of JSON',
        },
      };
    }

    // 检测是否为 JSON 解析失败（而非真正的纯文本回复）
    // 覆盖两种情况：
    // 1. 纯 JSON 开头：{ "decision": ... }
    // 2. 围栏包裹：```json\n{ "decision": ... }\n```
    const looksLikeJson =
      trimmed.includes('"decision"') &&
      (trimmed.startsWith('{') || /^```(?:json)?\s*\n?\s*\{/.test(trimmed));

    if (looksLikeJson) {
      // JSON 解析失败场景：给用户明确的错误提示
      logger.warn('[DecisionParser] 检测到 JSON 碎片，返回错误提示而非原始文本');
      return {
        decision: this.buildMalformedDecisionFallback('JSON parse failure fallback'),
        retryCorrection: {
          reason: 'malformed_json',
          detail: 'The decision JSON could not be parsed',
        },
      };
    }

    if (this.looksLikeDecisionMetaGarbage(trimmed)) {
      logger.warn('[DecisionParser] 检测到决策元输出或重复坍缩，返回错误提示而非原始文本');
      return {
        decision: this.buildMalformedDecisionFallback('Decision meta-output fallback'),
        retryCorrection: {
          reason: 'meta_output',
          detail: 'The response contained decision meta-analysis instead of a JSON decision',
        },
      };
    }

    // 纯文本回复：保留原文作为安全兜底，同时请求一次结构化纠错重试，
    // 避免把模型夹杂过程描述的杂乱文本直接展示给用户。
    return {
      decision: {
        decision: 'RESPOND_TO_USER',
        rationale:
          '(The LLM did not return a JSON decision, so the response was downgraded to a user reply)',
        riskAssessment: { level: 'low', notes: 'Fallback from plain text response' },
        response: trimmed,
      },
      retryCorrection: {
        reason: 'plain_text',
        detail: 'Master Brain returned plain text instead of the required JSON decision',
      },
    };
  }

  private buildMalformedDecisionFallback(
    notes: string,
    response = translate('chat.mbMalformedDecisionFallback')
  ): MasterBrainDecision {
    return {
      decision: 'RESPOND_TO_USER',
      rationale: '(The LLM returned a malformed JSON decision and parsing failed)',
      riskAssessment: { level: 'low', notes },
      response,
    };
  }

  private looksLikeToolCallEnvelope(text: string): boolean {
    const jsonStart = text.indexOf('{');
    const scanEnd = jsonStart >= 0 ? jsonStart : text.length;
    return TOOL_CALL_ENVELOPE_PATTERN.test(text.slice(0, scanEnd));
  }

  private looksLikeDecisionMetaGarbage(text: string): boolean {
    const normalized = text.toLowerCase();
    const schemaTermHits = DECISION_META_TERMS.filter((term) => normalized.includes(term)).length;
    const hasSelfTalk = DECISION_META_SELF_TALK_PATTERNS.some((pattern) => pattern.test(text));
    const hasRepetitionCollapse = this.hasRepetitionCollapse(normalized);

    if (schemaTermHits >= 4 && hasSelfTalk && hasRepetitionCollapse) {
      return true;
    }

    return (
      text.length >= DECISION_META_GARBAGE_LONG_TEXT_CHARS && schemaTermHits >= 6 && hasSelfTalk
    );
  }

  private hasRepetitionCollapse(normalizedText: string): boolean {
    const repeatedWordPattern = new RegExp(
      `\\b([a-z][a-z0-9_-]{2,})(?:[.!?,;:]?\\s+\\1\\b){${REPETITION_COLLAPSE_MIN_REPEATS - 1},}`,
      'i'
    );
    if (repeatedWordPattern.test(normalizedText)) {
      return true;
    }

    const tokens = normalizedText.match(/[a-z][a-z0-9_-]{2,}/g);
    if (!tokens || tokens.length < REPETITION_COLLAPSE_DOMINANT_COUNT) {
      return false;
    }

    const counts = new Map<string, number>();
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }

    const maxCount = Math.max(...counts.values());
    return (
      maxCount >= REPETITION_COLLAPSE_DOMINANT_COUNT &&
      maxCount / tokens.length >= REPETITION_COLLAPSE_DOMINANT_RATIO
    );
  }

  /**
   * 验证并原地修复决策 Schema
   *
   * 修复策略优先于报错：
   * 1. 枚举字段先走别名映射表，映射成功则静默修正
   * 2. 可选字段缺失时填充合理默认值
   * 3. 无法修复的情况才抛出 DecisionParseError
   *
   * 相比原 validateSchema，此版本将 risk level 的非标准同义词
   * 自动转换为合法值，消除 LLM 输出语义相近词汇（如 "critical"）时的崩溃。
   */
  private validateAndRepairSchema(decision: unknown): void {
    if (!decision || typeof decision !== 'object') {
      throw new DecisionParseError('Schema validation failed: not an object');
    }

    const d = decision as Record<string, unknown>;

    // ── decision 字段 ───────────────────────────────────────────────
    if (
      !d.decision ||
      !VALID_DECISION_TYPES.includes(d.decision as (typeof VALID_DECISION_TYPES)[number])
    ) {
      throw new DecisionParseError(
        `Schema validation failed: invalid decision type "${String(d.decision)}"`
      );
    }

    // ── rationale 字段 ──────────────────────────────────────────────
    if (!d.rationale || typeof d.rationale !== 'string' || d.rationale.length === 0) {
      throw new DecisionParseError('Schema validation failed: rationale is required');
    }

    // ── riskAssessment 字段 ─────────────────────────────────────────
    // 非操作型决策不涉及工具执行，riskAssessment 可选；缺失时填充默认值
    const NON_ACTION_DECISIONS = ['RESPOND_TO_USER', 'REQUEST_MORE_INPUT'];
    if (!d.riskAssessment || typeof d.riskAssessment !== 'object') {
      if (NON_ACTION_DECISIONS.includes(d.decision as string)) {
        d.riskAssessment = { level: 'low', notes: '' };
      } else {
        throw new DecisionParseError('Schema validation failed: riskAssessment is required');
      }
    }

    const ra = d.riskAssessment as Record<string, unknown>;
    if (!VALID_RISK_LEVELS.includes(ra.level as (typeof VALID_RISK_LEVELS)[number])) {
      // 先尝试别名映射修复（如 "moderate" → "medium"）
      const rawLevel = typeof ra.level === 'string' ? ra.level.toLowerCase() : '';
      const mappedLevel = RISK_LEVEL_ALIASES[rawLevel];
      if (mappedLevel) {
        logger.warn(
          `[DecisionParser] riskAssessment.level 非标准值 "${String(ra.level)}" → 自动修正为 "${mappedLevel}"`
        );
        ra.level = mappedLevel;
      } else {
        // 映射失败：填充默认值 low，不抛错（level 非核心字段，不应崩溃全链路）
        logger.warn(
          `[DecisionParser] riskAssessment.level 无法识别 "${String(ra.level)}"，填充默认值 "low"`
        );
        ra.level = 'low';
      }
    }

    // ── decision 专属必需字段 ───────────────────────────────────────
    // MB wire protocol 将所选决策的 payload 统一放在 nextStep 下；解析边界
    // 同时兼容旧顶层字段，并规范化为应用内部既有的判别联合结构。
    if (d.decision === 'SPAWN_SUB_AGENT') {
      const nextStep = this.asRecord(d.nextStep);
      if (!nextStep) {
        throw new DecisionParseError(
          'Schema validation failed: nextStep.task is required for SPAWN_SUB_AGENT'
        );
      }

      const task = [nextStep.task, nextStep.description].find(
        (value) => typeof value === 'string' && value.trim().length > 0
      );
      if (typeof task !== 'string') {
        throw new DecisionParseError(
          'Schema validation failed: nextStep.task is required for SPAWN_SUB_AGENT'
        );
      }

      // 统一成标准字段，避免日志、连续性上下文等只读取 task 的下游丢失信息。
      nextStep.task = task;
    } else if (d.decision === 'REQUEST_MORE_INPUT') {
      const nextStep = this.asRecord(d.nextStep);
      const hasNestedQuestions = this.hasOwn(nextStep, 'questionsForUser');
      const hasLegacyQuestions = this.hasOwn(d, 'questionsForUser');
      const nestedQuestions = this.normalizeQuestionsForUser(nextStep?.questionsForUser);
      const legacyQuestions = this.normalizeQuestionsForUser(d.questionsForUser);

      // canonical key 一旦出现就必须独立合法，不能由旧顶层字段掩盖协议错误。
      if (hasNestedQuestions) {
        if (!nestedQuestions) {
          throw new DecisionParseError(
            'Schema validation failed: nextStep.questionsForUser is required for REQUEST_MORE_INPUT'
          );
        }

        if (
          hasLegacyQuestions &&
          (!legacyQuestions || !this.areEquivalentQuestions(nestedQuestions, legacyQuestions))
        ) {
          throw new DecisionParseError(
            'Schema validation failed: conflicting nextStep.questionsForUser and legacy root questionsForUser'
          );
        }
      }

      const questions = hasNestedQuestions ? nestedQuestions : legacyQuestions;
      if (!questions) {
        throw new DecisionParseError(
          'Schema validation failed: nextStep.questionsForUser is required for REQUEST_MORE_INPUT'
        );
      }

      if (!hasNestedQuestions) {
        logger.debug(
          '[DecisionParser] REQUEST_MORE_INPUT 使用兼容顶层 questionsForUser，已规范化为内部决策'
        );
      }

      d.questionsForUser = questions;
      if (nextStep && Object.prototype.hasOwnProperty.call(nextStep, 'questionsForUser')) {
        delete nextStep.questionsForUser;
        this.removeEmptyNextStep(d, nextStep);
      }
    } else if (d.decision === 'RESPOND_TO_USER') {
      const nextStep = this.asRecord(d.nextStep);
      const hasNestedResponse = this.hasOwn(nextStep, 'response');
      const hasLegacyResponse = this.hasOwn(d, 'response');
      const nestedResponse = this.readNonEmptyString(nextStep?.response);
      const legacyResponse = this.readNonEmptyString(d.response);

      // canonical key 一旦出现就必须独立合法，不能由旧顶层字段掩盖协议错误。
      if (hasNestedResponse) {
        if (!nestedResponse) {
          throw new DecisionParseError(
            'Schema validation failed: nextStep.response is required for RESPOND_TO_USER'
          );
        }

        if (hasLegacyResponse && nestedResponse.trim() !== legacyResponse?.trim()) {
          throw new DecisionParseError(
            'Schema validation failed: conflicting nextStep.response and legacy root response'
          );
        }
      }

      const response = hasNestedResponse ? nestedResponse : legacyResponse;
      if (!response) {
        throw new DecisionParseError(
          'Schema validation failed: nextStep.response is required for RESPOND_TO_USER'
        );
      }

      if (!hasNestedResponse) {
        logger.debug('[DecisionParser] RESPOND_TO_USER 使用兼容顶层 response，已规范化为内部决策');
      }

      d.response = response;
      if (nextStep && Object.prototype.hasOwnProperty.call(nextStep, 'response')) {
        delete nextStep.response;
        this.removeEmptyNextStep(d, nextStep);
      }
    }

    // 进展和预算由 LoopGovernor 后台维护，MB 输出中不再要求循环状态字段。
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  }

  private hasOwn(record: Record<string, unknown> | undefined, key: string): boolean {
    return record !== undefined && Object.prototype.hasOwnProperty.call(record, key);
  }

  private readNonEmptyString(value: unknown): string | undefined {
    if (typeof value === 'string') {
      return value.trim().length > 0 ? value : undefined;
    }

    return undefined;
  }

  private normalizeQuestionsForUser(value: unknown): string[] | undefined {
    const singleQuestion = this.readNonEmptyString(value);
    if (singleQuestion) {
      return [singleQuestion];
    }

    if (Array.isArray(value)) {
      if (
        value.length === 0 ||
        !value.every((item): item is string => typeof item === 'string' && item.trim().length > 0)
      ) {
        return undefined;
      }
      return value;
    }

    return undefined;
  }

  private areEquivalentQuestions(left: string[], right: string[]): boolean {
    return (
      left.length === right.length &&
      left.every((question, index) => question.trim() === right[index]?.trim())
    );
  }

  private removeEmptyNextStep(
    decision: Record<string, unknown>,
    nextStep: Record<string, unknown>
  ): void {
    if (Object.keys(nextStep).length === 0) {
      delete decision.nextStep;
    }
  }
}
