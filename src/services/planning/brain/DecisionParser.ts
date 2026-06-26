/**
 * DecisionParser - 决策解析器
 *
 * 职责：从 LLM 响应中提取并验证结构化决策
 *
 * 验证规则：
 * 1. 响应必须包含 JSON 代码块
 * 2. JSON 必须符合 Decision Schema
 */

import type {
    MasterBrainDecision,
} from './types';

// 复用项目统一的 JSON 解析工具
import { extractJsonFromText, sanitizeJson, parseWithFallback } from '../../memory/utils/JsonParser';
import { getLogger } from '@services/logger';

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
const VALID_DECISION_TYPES = [
    'SPAWN_SUB_AGENT',
    'REQUEST_MORE_INPUT',
    'RESPOND_TO_USER',
] as const;

/** 有效的风险等级 */
const VALID_RISK_LEVELS = ['low', 'medium', 'high'] as const;

/**
 * riskAssessment.level 字段语义别名映射表
 *
 * 覆盖 LLM 输出的非标准风险等级词汇。
 */
const RISK_LEVEL_ALIASES: Record<string, typeof VALID_RISK_LEVELS[number]> = {
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
                return this.processDecision(decision);
            } catch {
                const recoveredDecision = this.tryRecoverNestedEscapedDecision(rawResponse);
                if (recoveredDecision) {
                    logger.warn('[DecisionParser] 从嵌套转义 JSON 中恢复决策');
                    return this.processDecision(recoveredDecision);
                }

                // 兜底：LLM 返回了纯文本（无 JSON），自动包装为 RESPOND_TO_USER
                // 常见于 Sub-Agent 完成后 MasterBrain 直接用自然语言总结
                logger.warn('[DecisionParser] JSON 解析全部失败，启用纯文本兜底 → RESPOND_TO_USER');
                return this.buildFallbackDecision(rawResponse);
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
                logger.warn(
                    `[DecisionParser] Schema 验证/修复均失败，降级为纯文本兜底: ${err.message}`
                );
                return this.buildFallbackDecision(rawResponse);
            }
            throw err;
        }

        // 4. 处理决策（包括 SPAWN_SUB_AGENT 特殊处理）
        return this.processDecision(decision);
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
    private tryRecoverNestedEscapedDecision(rawResponse: string): Record<string, unknown> | null {
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
                return parseResult.data;
            } catch {
                continue;
            }
        }

        return null;
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
                candidate.startsWith('{') ||
                /^```(?:json)?\s*\n?\s*\{/.test(candidate);
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
            const normalized = encoded
                .replace(/\r/g, '\\r')
                .replace(/\n/g, '\\n');
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
    private buildFallbackDecision(rawText: string): MasterBrainDecision {
        const trimmed = rawText.trim();

        // 检测是否为 JSON 解析失败（而非真正的纯文本回复）
        // 覆盖两种情况：
        // 1. 纯 JSON 开头：{ "decision": ... }
        // 2. 围栏包裹：```json\n{ "decision": ... }\n```
        const looksLikeJson = trimmed.includes('"decision"') && (
            trimmed.startsWith('{') ||
            /^```(?:json)?\s*\n?\s*\{/.test(trimmed)
        );

        if (looksLikeJson) {
            // JSON 解析失败场景：给用户明确的错误提示
            logger.warn('[DecisionParser] 检测到 JSON 碎片，返回错误提示而非原始文本');
            return this.buildMalformedDecisionFallback('JSON parse failure fallback');
        }

        if (this.looksLikeDecisionMetaGarbage(trimmed)) {
            logger.warn('[DecisionParser] 检测到决策元输出或重复坍缩，返回错误提示而非原始文本');
            return this.buildMalformedDecisionFallback('Decision meta-output fallback');
        }

        // 纯文本回复：LLM 直接用自然语言总结，保留原文
        return {
            decision: 'RESPOND_TO_USER',
            rationale: '(The LLM did not return a JSON decision, so the response was downgraded to a user reply)',
            riskAssessment: { level: 'low', notes: 'Fallback from plain text response' },
            response: trimmed,
        };
    }

    private buildMalformedDecisionFallback(notes: string): MasterBrainDecision {
        return {
            decision: 'RESPOND_TO_USER',
            rationale: '(The LLM returned a malformed JSON decision and parsing failed)',
            riskAssessment: { level: 'low', notes },
            response: '⚠️ The AI returned a malformed decision, so the task cannot be executed. Please retry or switch models.',
        };
    }

    private looksLikeDecisionMetaGarbage(text: string): boolean {
        const normalized = text.toLowerCase();
        const schemaTermHits = DECISION_META_TERMS.filter((term) => normalized.includes(term)).length;
        const hasSelfTalk = DECISION_META_SELF_TALK_PATTERNS.some((pattern) => pattern.test(text));
        const hasRepetitionCollapse = this.hasRepetitionCollapse(normalized);

        if (schemaTermHits >= 4 && hasSelfTalk && hasRepetitionCollapse) {
            return true;
        }

        return text.length >= DECISION_META_GARBAGE_LONG_TEXT_CHARS &&
            schemaTermHits >= 6 &&
            hasSelfTalk;
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
        return maxCount >= REPETITION_COLLAPSE_DOMINANT_COUNT &&
            maxCount / tokens.length >= REPETITION_COLLAPSE_DOMINANT_RATIO;
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
        if (!d.decision || !VALID_DECISION_TYPES.includes(d.decision as typeof VALID_DECISION_TYPES[number])) {
            throw new DecisionParseError(
                `Schema validation failed: invalid decision type "${String(d.decision)}"`
            );
        }

        // ── rationale 字段 ──────────────────────────────────────────────
        if (!d.rationale || typeof d.rationale !== 'string' || d.rationale.length === 0) {
            throw new DecisionParseError(
                'Schema validation failed: rationale is required'
            );
        }

        // ── riskAssessment 字段 ─────────────────────────────────────────
        // 非操作型决策不涉及工具执行，riskAssessment 可选；缺失时填充默认值
        const NON_ACTION_DECISIONS = ['RESPOND_TO_USER', 'REQUEST_MORE_INPUT'];
        if (!d.riskAssessment || typeof d.riskAssessment !== 'object') {
            if (NON_ACTION_DECISIONS.includes(d.decision as string)) {
                d.riskAssessment = { level: 'low', notes: '' };
            } else {
                throw new DecisionParseError(
                    'Schema validation failed: riskAssessment is required'
                );
            }
        }

        const ra = d.riskAssessment as Record<string, unknown>;
        if (!VALID_RISK_LEVELS.includes(ra.level as typeof VALID_RISK_LEVELS[number])) {
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

        // 进展和预算由 LoopGovernor 后台维护，MB 输出中不再要求循环状态字段。
    }

}
