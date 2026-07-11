/**
 * WebSearchTool - 网络搜索工具
 *
 * 执行网络搜索并返回结果摘要，支持获取页面完整内容
 *
 * 技能定义: SKILL.md
 * 工具实现: 本文件
 */

import { invoke } from '@tauri-apps/api/core';
import { translate } from '@/i18n';
import type { Tool, ToolSchema, ToolResult, ToolExecutionContext } from '../../tools/types';

// ==================== 常量 ====================

/**
 * 单条搜索结果的 raw_content 最大字符数
 *
 * 防止单条页面内容过大导致 token 爆炸。
 */
const MAX_RAW_CONTENT_PER_RESULT = 3000;

// ==================== Schema ====================

/**
 * 工具 Schema
 */
const SCHEMA: ToolSchema = {
  name: 'web_search',
  description:
    'Search the web for information. Returns summaries, page snippets, and links. Supports basic and advanced search depth.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query.',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return. Defaults to 5.',
      },
      searchDepth: {
        type: 'string',
        description:
          'Search depth: "basic" (default, faster) or "advanced" (queries more backends, may be slower, useful for low-confidence or complex searches).',
      },
      includeContent: {
        type: 'boolean',
        description:
          'Whether to fetch full page content in Markdown format. Defaults to false; best used with 2-3 results when page-level analysis is needed.',
      },
    },
    required: ['query'],
  },
};

// ==================== 类型定义 ====================

/**
 * 搜索结果类型
 */
interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  /** 页面清洁后的完整内容（仅 includeContent=true 时返回） */
  raw_content?: string | null;
  provider?: string | null;
  source?: string | null;
}

/**
 * 后端 WebSearchResponse 结构
 */
interface WebSearchResponse {
  results: SearchResult[];
  answer: string | null;
  query: string;
  provider?: string;
  fallback_used?: boolean;
  diagnostics?: Array<{ level: string; message: string }>;
}

type WebSearchErrorKind =
  | 'sandbox_blocked'
  | 'api_key_missing'
  | 'dns_failed'
  | 'timeout'
  | 'connection_failed'
  | 'rate_limited'
  | 'provider_unauthorized'
  | 'provider_error'
  | 'bad_request'
  | 'response_parse_failed'
  | 'runtime_unavailable'
  | 'unknown';

interface WebSearchErrorMeta {
  kind: WebSearchErrorKind;
  retryable: boolean;
  status: number | null;
}

// ==================== 格式化工具函数 ====================

function buildFailureContent(
  query: string,
  errorMessage: string,
  meta: WebSearchErrorMeta
): string {
  const status = meta.status == null ? 'none' : String(meta.status);
  return `${translate('tools.webSearch.errorMeta', {
    kind: meta.kind,
    retryable: String(meta.retryable),
    status,
  })}\n${translate('tools.webSearch.failed', { query, error: errorMessage })}`;
}

function classifyWebSearchError(errorMessage: string): WebSearchErrorMeta {
  const normalized = errorMessage.toLowerCase();
  const status = parseProviderStatus(errorMessage);

  if (status != null) {
    if (status === 408) return { kind: 'timeout', retryable: true, status };
    if (status === 429) return { kind: 'rate_limited', retryable: true, status };
    if (status === 401 || status === 403) {
      return { kind: 'provider_unauthorized', retryable: false, status };
    }
    if (status === 400 || status === 404 || status === 422) {
      return { kind: 'bad_request', retryable: false, status };
    }
    if (status >= 500) return { kind: 'provider_error', retryable: true, status };
  }

  if (normalized.includes('tavily api key is not configured')) {
    return { kind: 'api_key_missing', retryable: false, status: null };
  }
  if (
    normalized.includes('network broker dns lookup failed') ||
    normalized.includes('dns error') ||
    normalized.includes('failed to lookup address') ||
    normalized.includes('could not resolve host') ||
    normalized.includes('no such host')
  ) {
    return { kind: 'dns_failed', retryable: true, status: null };
  }
  if (
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('deadline has elapsed')
  ) {
    return { kind: 'timeout', retryable: true, status: null };
  }
  if (
    normalized.includes('failed to parse tavily response') ||
    normalized.includes('failed to parse ddgs fallback response')
  ) {
    return { kind: 'response_parse_failed', retryable: false, status: null };
  }
  if (
    normalized.includes('runtime_unavailable') ||
    normalized.includes('ddgs is not available') ||
    normalized.includes('no module named')
  ) {
    return { kind: 'runtime_unavailable', retryable: false, status: null };
  }
  if (normalized.includes('ddgs fallback returned error rate_limited')) {
    return { kind: 'rate_limited', retryable: true, status: null };
  }
  if (
    normalized.includes('ddgs fallback returned error timeout') ||
    normalized.includes('ddgs fallback timed out')
  ) {
    return { kind: 'timeout', retryable: true, status: null };
  }
  if (normalized.includes('ddgs fallback returned error bad_request')) {
    return { kind: 'bad_request', retryable: false, status: null };
  }
  if (
    normalized.includes('network broker rejected') ||
    normalized.includes('operation forbidden') ||
    normalized.includes('sandbox block')
  ) {
    return { kind: 'sandbox_blocked', retryable: false, status: null };
  }
  if (
    normalized.includes('network broker request failed') ||
    normalized.includes('error sending request') ||
    normalized.includes('connection refused') ||
    normalized.includes('connection reset') ||
    normalized.includes('tcp connect error') ||
    normalized.includes('ddgs fallback returned error provider_error')
  ) {
    return { kind: 'connection_failed', retryable: true, status: null };
  }

  return { kind: 'unknown', retryable: false, status: null };
}

function parseProviderStatus(errorMessage: string): number | null {
  const match = errorMessage.match(/(?:Tavily API|DDGS fallback) returned error\s+(\d{3})/i);
  if (!match?.[1]) return null;

  const status = Number(match[1]);
  return Number.isInteger(status) ? status : null;
}

/**
 * 截断 raw_content 到指定字符数上限
 *
 * 保留内容开头部分，因为页面核心信息通常在前方。
 * 超长时追加截断提示，帮助 LLM 了解内容被裁剪。
 */
function truncateRawContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;

  const truncated = content.slice(0, maxChars);
  // 尝试在最后一个完整段落或句子处截断，避免切断语义
  const lastNewline = truncated.lastIndexOf('\n');
  const cutPoint = lastNewline > maxChars * 0.7 ? lastNewline : maxChars;

  return truncated.slice(0, cutPoint) + translate('tools.webSearch.truncatedContent');
}

/**
 * 格式化单条搜索结果（仅摘要模式）
 */
function formatResultSummaryOnly(result: SearchResult, index: number): string {
  return `### ${index + 1}. **${result.title}**\n${result.url}\n${result.content}`;
}

/**
 * 格式化单条搜索结果（含页面内容模式）
 *
 * 结构化展示：标题 + URL + 摘要 + 页面内容
 * raw_content 会被截断以控制 token 消耗
 */
function formatResultWithContent(result: SearchResult, index: number): string {
  const header = `### ${index + 1}. **${result.title}**\n🔗 ${result.url}`;
  const summary = `${translate('tools.webSearch.summaryLabel')}: ${result.content}`;

  if (result.raw_content) {
    const truncatedContent = truncateRawContent(result.raw_content, MAX_RAW_CONTENT_PER_RESULT);
    return `${header}\n${summary}\n${translate('tools.webSearch.pageContentLabel')}\n${truncatedContent}`;
  }

  // Tavily 未返回 raw_content 时（部分页面可能无法解析），仅展示摘要
  return `${header}\n${summary}`;
}

// ==================== 工具实现 ====================

/**
 * WebSearchTool 实现
 */
class WebSearchToolImpl implements Tool {
  readonly schema = SCHEMA;

  async execute(
    params: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const query = params.query as string;
    const maxResults = (params.maxResults as number | undefined) ?? 5;
    // 参数别名容错：LLM 可能使用 search_depth 而非 searchDepth
    const searchDepth = (params.searchDepth ?? params.search_depth) as string | undefined;
    const includeContent = (params.includeContent ?? params.include_content) as boolean | undefined;

    if (!query) {
      return {
        success: false,
        content: translate('tools.common.errorMissingParam', { param: 'query' }),
      };
    }
    if (context.sandboxMode === 'OfflineIsolated') {
      const errorMessage = translate('tools.webSearch.sandboxBlocked', { query });
      const meta: WebSearchErrorMeta = {
        kind: 'sandbox_blocked',
        retryable: false,
        status: null,
      };
      return {
        success: false,
        content: `${translate('tools.webSearch.errorMeta', {
          kind: meta.kind,
          retryable: String(meta.retryable),
          status: 'none',
        })}\n${errorMessage}`,
        data: { query, error: meta },
      };
    }

    try {
      // 报告进度（含模式提示，方便调试）
      const modeLabel =
        searchDepth === 'advanced'
          ? translate('tools.webSearch.modeAdvanced')
          : translate('tools.webSearch.modeBasic');
      const contentLabel = includeContent ? translate('tools.webSearch.includeContentLabel') : '';
      context.onProgress?.(
        translate('tools.webSearch.searching', {
          mode: modeLabel,
          content: contentLabel,
          query,
        })
      );

      // 调用后端搜索 API，透传新参数
      const response = await invoke<WebSearchResponse>('web_search', {
        query,
        maxResults,
        searchDepth: searchDepth ?? 'basic',
        includeRawContent: includeContent ?? false,
        sandboxMode: context.sandboxMode ?? 'LocalAudit',
      });

      const results = response.results;
      const provider = response.provider ?? 'unknown';
      const fallbackUsed = response.fallback_used ?? false;
      const providerMeta = translate('tools.webSearch.providerMeta', {
        provider,
        fallback: String(fallbackUsed),
      });

      if (results.length === 0) {
        return {
          success: true,
          content: `${providerMeta}\n${translate('tools.webSearch.noResults', { query })}`,
          data: {
            query,
            resultCount: 0,
            provider,
            fallbackUsed,
            diagnostics: response.diagnostics ?? [],
          },
        };
      }

      // 根据是否请求页面内容选择格式化策略
      const hasRawContent = includeContent && results.some((r) => r.raw_content);
      const formattedResults = hasRawContent
        ? results.map((r, i) => formatResultWithContent(r, i)).join('\n\n---\n\n')
        : results.map((r, i) => formatResultSummaryOnly(r, i)).join('\n\n');

      // 组装完整输出
      const answerSection = response.answer
        ? translate('tools.webSearch.aiSummary', { answer: response.answer })
        : '';
      const content = `${providerMeta}\n${translate('tools.webSearch.resultsHeader', {
        query,
        mode: modeLabel,
        count: results.length,
        answerSection,
        results: formattedResults,
      })}`;

      return {
        success: true,
        content: content,
        data: {
          query,
          resultCount: results.length,
          searchDepth: searchDepth ?? 'basic',
          includeContent: includeContent ?? false,
          provider,
          fallbackUsed,
          diagnostics: response.diagnostics ?? [],
          results: results.map((r) => ({
            title: r.title,
            url: r.url,
            hasRawContent: !!r.raw_content,
            provider: r.provider ?? provider,
            source: r.source ?? null,
          })),
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const meta = classifyWebSearchError(errorMessage);
      return {
        success: false,
        content: buildFailureContent(query, errorMessage, meta),
        data: { query, error: { ...meta, message: errorMessage } },
      };
    }
  }
}

/**
 * 导出单例实例
 */
export const webSearchTool = new WebSearchToolImpl();
