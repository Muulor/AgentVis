/**
 * ToolOutputCompressor - 工具输出三级梯度截断器
 *
 * 职责：
 * - 将 Sub-Agent 循环中产生的工具输出按大小分级压缩
 * - 保护 SKILL.md 和 system prompt 的上下文空间
 * - 提供确定性、零成本、零延迟的压缩策略（纯算法，不调用 LLM）
 *
 * 三级策略：
 * - Level 1 (< 8K tokens): 完整保留
 * - Level 2 (8K ~ 12K tokens): 保留首尾 + 省略中间
 * - Level 3 (> 12K tokens): 仅保留结构化元信息
 */

import { PLANNING_CONSTANTS } from '../PlanningConstants';
import { translate } from '@/i18n';

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

/** 压缩级别 */
export type CompressionLevel = 'full' | 'truncated' | 'meta';

/** 压缩后的输出 */
export interface CompressedOutput {
    /** 压缩后内容 */
    content: string;
    /** 原始 token 数 */
    originalTokens: number;
    /** 压缩后 token 数 */
    finalTokens: number;
    /** 压缩级别 */
    level: CompressionLevel;
    /** 是否被压缩 */
    wasCompressed: boolean;
}

/** 工具输出元信息（用于 Level 3 提取） */
interface ToolOutputMeta {
    /** 工具名称 */
    toolName: string;
    /** 来源路径或查询词 */
    source: string;
    /** 是否成功 */
    success: boolean;
    /** 行数（read 工具） */
    lineCount?: number;
    /** 语言类型（read 工具） */
    language?: string;
    /** 搜索结果条目（web_search 工具） */
    searchEntries?: Array<{ title: string; url: string }>;
}

// ═══════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════

/** 省略标记模板 */
const OMISSION_MARKER = (omittedTokens: number, meta: string): string =>
    translate('chat.subAgentToolOutputOmissionMarker', {
        tokens: omittedTokens,
        meta,
    });

// ═══════════════════════════════════════════════════════════════
// Token 估算（复用 ContextWindowManager 的逻辑）
// ═══════════════════════════════════════════════════════════════

/**
 * 估算文本的 token 数
 *
 * 规则：中文 1 token ≈ 1.5 字符，英文 1 token ≈ 4 字符
 */
export function estimateTokens(text: string): number {
    if (!text) return 0;
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
    const otherChars = text.length - chineseChars;
    return Math.ceil(chineseChars / 1.5) + Math.ceil(otherChars / 4);
}

/**
 * 按 token 数截取文本（近似，基于字符比例）
 *
 * 从文本开头截取约 targetTokens 个 token 对应的字符数
 */
function truncateToTokens(text: string, targetTokens: number): string {
    if (!text || targetTokens <= 0) return '';

    // 估算每 token 平均字符数，作为截取依据
    const totalTokens = estimateTokens(text);
    if (totalTokens <= targetTokens) return text;

    const ratio = targetTokens / totalTokens;
    const targetChars = Math.floor(text.length * ratio);
    return text.slice(0, targetChars);
}

/**
 * 从文本末尾截取约 targetTokens 个 token 对应的字符数
 */
function truncateTailTokens(text: string, targetTokens: number): string {
    if (!text || targetTokens <= 0) return '';

    const totalTokens = estimateTokens(text);
    if (totalTokens <= targetTokens) return text;

    const ratio = targetTokens / totalTokens;
    const targetChars = Math.floor(text.length * ratio);
    return text.slice(-targetChars);
}

// ═══════════════════════════════════════════════════════════════
// ToolOutputCompressor 核心实现
// ═══════════════════════════════════════════════════════════════

/**
 * 工具输出压缩器
 *
 * 根据输出大小自动选择压缩策略，确保工具结果
 * 不会无限膨胀挤压 SKILL.md 和 system prompt 的上下文空间。
 */
export class ToolOutputCompressor {
    private readonly thresholdL1: number;
    private readonly thresholdL2: number;
    private readonly headTokens: number;
    private readonly tailTokens: number;

    constructor(config?: {
        thresholdL1?: number;
        thresholdL2?: number;
        headTokens?: number;
        tailTokens?: number;
    }) {
        this.thresholdL1 = config?.thresholdL1 ?? PLANNING_CONSTANTS.SUB_AGENT_COMPRESS_THRESHOLD_L1;
        this.thresholdL2 = config?.thresholdL2 ?? PLANNING_CONSTANTS.SUB_AGENT_COMPRESS_THRESHOLD_L2;
        this.headTokens = config?.headTokens ?? PLANNING_CONSTANTS.SUB_AGENT_COMPRESS_HEAD_TOKENS;
        this.tailTokens = config?.tailTokens ?? PLANNING_CONSTANTS.SUB_AGENT_COMPRESS_TAIL_TOKENS;
    }

    /**
     * 压缩工具输出
     *
     * 根据输出 token 数自动选择压缩级别：
     * - Level 1 (< thresholdL1): 完整保留
     * - Level 2 (thresholdL1 ~ thresholdL2): 首尾截断
     * - Level 3 (> thresholdL2): 元信息摘要
     *
     * @param content - 工具原始输出内容
     * @param toolName - 工具名称（用于元信息提取）
     * @param source - 来源标识（文件路径、URL 等）
     */
    compress(content: string, toolName: string, source: string = ''): CompressedOutput {
        const originalTokens = estimateTokens(content);

        // Level 1：完整保留
        if (originalTokens <= this.thresholdL1) {
            return {
                content,
                originalTokens,
                finalTokens: originalTokens,
                level: 'full',
                wasCompressed: false,
            };
        }

        // Level 2：首尾截断
        if (originalTokens <= this.thresholdL2) {
            return this.applyLevel2Truncation(content, originalTokens, toolName, source);
        }

        // Level 3：元信息摘要
        return this.applyLevel3MetaExtraction(content, originalTokens, toolName, source);
    }

    /**
     * Level 2 截断：保留首尾 + 省略中间
     *
     * 保留前 headTokens + 后 tailTokens 的内容，
     * 中间替换为包含关键信息的省略标记
     */
    private applyLevel2Truncation(
        content: string,
        originalTokens: number,
        toolName: string,
        source: string
    ): CompressedOutput {
        const head = truncateToTokens(content, this.headTokens);
        const tail = truncateTailTokens(content, this.tailTokens);
        const omittedTokens = originalTokens - this.headTokens - this.tailTokens;

        // 构建元信息描述
        const metaInfo = this.buildMetaDescription(content, toolName, source);
        const marker = OMISSION_MARKER(omittedTokens, metaInfo);

        const compressedContent = `${head}${marker}${tail}`;
        const finalTokens = estimateTokens(compressedContent);

        return {
            content: compressedContent,
            originalTokens,
            finalTokens,
            level: 'truncated',
            wasCompressed: true,
        };
    }

    /**
     * Level 3 元信息提取：仅保留结构化摘要
     *
     * 根据工具类型提取不同的元信息：
     * - read: 文件路径、行数、语言类型
     * - web_search: 搜索结果标题和 URL
     * - 其他: 工具名称 + token 数
     */
    private applyLevel3MetaExtraction(
        content: string,
        originalTokens: number,
        toolName: string,
        source: string
    ): CompressedOutput {
        const meta = this.extractToolMeta(content, toolName, source);
        const metaSummary = this.formatMetaSummary(meta, originalTokens);
        const finalTokens = estimateTokens(metaSummary);

        return {
            content: metaSummary,
            originalTokens,
            finalTokens,
            level: 'meta',
            wasCompressed: true,
        };
    }

    /**
     * 构建省略标记中的元信息描述
     */
    private buildMetaDescription(content: string, toolName: string, source: string): string {
        const parts: string[] = [];

        if (source) {
            parts.push(translate('chat.subAgentToolOutputMetaSource', { source }));
        }

        // 文件类型检测
        if (toolName === 'read' || toolName === 'file_read') {
            const lineCount = content.split('\n').length;
            const lang = this.detectLanguage(source);
            parts.push(translate('chat.subAgentToolOutputMetaLines', { count: lineCount }));
            if (lang) parts.push(translate('chat.subAgentToolOutputMetaType', { type: lang }));
        }

        // 搜索结果计数
        if (toolName === 'web_search') {
            const resultCount = (content.match(/^#{1,3}\s/gm) ?? []).length;
            if (resultCount > 0) {
                parts.push(translate('chat.subAgentToolOutputMetaSearchResults', {
                    count: resultCount,
                }));
            }
        }

        return parts.length > 0
            ? parts.join(', ')
            : translate('chat.subAgentToolOutputMetaTool', { tool: toolName });
    }

    /**
     * 提取工具输出的结构化元信息
     *
     * 公开供 SubAgentRunner 混合压缩策略使用（B1）
     */
    extractToolMeta(content: string, toolName: string, source: string): ToolOutputMeta {
        const success = !content.includes('❌') && !content.includes('Error:');

        const meta: ToolOutputMeta = {
            toolName,
            source: source || translate('chat.subAgentUnknownSource'),
            success,
        };

        // read 工具：提取行数和语言
        if (toolName === 'read' || toolName === 'file_read') {
            meta.lineCount = content.split('\n').length;
            meta.language = this.detectLanguage(source);
        }

        // web_search 工具：提取搜索结果的标题和 URL
        if (toolName === 'web_search') {
            meta.searchEntries = this.extractSearchEntries(content);
        }

        return meta;
    }

    /**
     * 将元信息格式化为人类可读的摘要
     */
    private formatMetaSummary(meta: ToolOutputMeta, originalTokens: number): string {
        const status = meta.success ? '✅' : '❌';

        // read 工具摘要
        if (meta.toolName === 'read' || meta.toolName === 'file_read') {
            const langSuffix = meta.language ? ` ${meta.language}` : '';
            const statusText = meta.success
                ? translate('chat.subAgentToolOutputReadStatusSucceeded')
                : translate('chat.subAgentToolOutputReadStatusFailed');
            return translate('chat.subAgentToolOutputReadSummary', {
                status,
                tool: meta.toolName,
                source: meta.source,
                statusText,
                lines: meta.lineCount ?? '?',
                lang: langSuffix,
                tokens: originalTokens,
            });
        }

        // web_search 工具摘要：保留标题和 URL
        if (meta.toolName === 'web_search' && meta.searchEntries && meta.searchEntries.length > 0) {
            const entries = meta.searchEntries
                .slice(0, 10) // 最多保留 10 条
                .map((e, i) => `  ${i + 1}. ${e.title} - ${e.url}`)
                .join('\n');
            return translate('chat.subAgentToolOutputSearchSummary', {
                status,
                tool: meta.toolName,
                source: meta.source,
                count: meta.searchEntries.length,
                tokens: originalTokens,
                entries,
            });
        }

        // 通用工具摘要
        const result = meta.success
            ? translate('chat.subAgentToolOutputExecutionSucceeded')
            : translate('chat.subAgentToolOutputExecutionFailed');
        return translate('chat.subAgentToolOutputGenericSummary', {
            status,
            tool: meta.toolName,
            source: meta.source,
            result,
            tokens: originalTokens,
        });
    }

    /**
     * 从文件路径检测编程语言
     */
    private detectLanguage(filePath: string): string | undefined {
        if (!filePath) return undefined;

        const extensionMap: Record<string, string> = {
            '.ts': 'TypeScript',
            '.tsx': 'TypeScript/React',
            '.js': 'JavaScript',
            '.jsx': 'JavaScript/React',
            '.py': 'Python',
            '.rs': 'Rust',
            '.go': 'Go',
            '.java': 'Java',
            '.css': 'CSS',
            '.scss': 'SCSS',
            '.html': 'HTML',
            '.vue': 'Vue',
            '.svelte': 'Svelte',
            '.json': 'JSON',
            '.yaml': 'YAML',
            '.yml': 'YAML',
            '.md': 'Markdown',
            '.toml': 'TOML',
            '.sql': 'SQL',
            '.sh': 'Shell',
            '.bat': 'Batch',
            '.ps1': 'PowerShell',
        };

        const ext = filePath.match(/\.[^.]+$/)?.[0]?.toLowerCase();
        return ext ? extensionMap[ext] : undefined;
    }

    /**
     * 从搜索结果内容中提取标题和 URL
     *
     * 尝试匹配常见的搜索结果格式（markdown 标题 + URL）
     */
    private extractSearchEntries(content: string): Array<{ title: string; url: string }> {
        const entries: Array<{ title: string; url: string }> = [];
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line === undefined) continue;

            // 匹配 markdown 链接格式: [title](url)
            const linkMatch = line.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
            if (linkMatch?.[1] && linkMatch[2]) {
                entries.push({ title: linkMatch[1], url: linkMatch[2] });
                continue;
            }

            // 匹配标题行 + 下一行 URL
            const headingMatch = line.match(/^#{1,3}\s+(.+)/);
            if (headingMatch && i + 1 < lines.length) {
                const nextLine = lines[i + 1];
                if (nextLine === undefined) continue;
                const urlMatch = nextLine.match(/(https?:\/\/\S+)/);
                if (headingMatch[1] && urlMatch?.[1]) {
                    entries.push({ title: headingMatch[1], url: urlMatch[1] });
                }
            }
        }

        return entries;
    }
}
