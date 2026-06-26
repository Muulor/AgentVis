/**
 * stripVisualCodeBlocks - 可视化代码块剥离工具
 *
 * 将 VisualEnhancer 或 MB 自学产生的可视化代码块
 * （widget-chart / widget-choices / widget-tree / echarts / mermaid）
 * 转换为飞书等纯文本场景可读的 Markdown 格式。
 *
 * 设计原则：
 * - widget 类型：解析 JSON 后转换为可读的纯文本列表，保留信息价值
 * - echarts / mermaid：纯可视化内容无法文本化，替换为占位提示
 * - 解析失败时安全降级：直接移除代码块，避免原始 JSON 泄露
 *
 * 使用场景：
 * 1. 飞书 IM 卡片发送前，确保不出现原始代码块
 * 2. 对话历史加载时，防止 MB 从增强后内容中学习可视化格式
 *
 * @module services/planning/visual-enhancer/stripVisualCodeBlocks
 */

import { getLogger } from '@services/logger';

const logger = getLogger('stripVisualCodeBlocks');

// ============================================================================
// 类型定义（仅用于 JSON 解析后的类型安全，不对外暴露）
// ============================================================================

/** widget-chart JSON 结构 */
interface WidgetChartData {
    title?: string;
    type?: 'info' | 'flow' | 'bar';
    items?: Array<{
        label?: string;
        description?: string;
        value?: string | number;
    }>;
}

/** widget-choices JSON 结构 */
interface WidgetChoicesData {
    title?: string;
    mode?: 'single' | 'multi';
    options?: Array<{
        label?: string;
        description?: string;
    }>;
}

/** widget-tree JSON 结构 */
interface WidgetTreeData {
    title?: string;
    tree?: TreeNode;
}

interface TreeNode {
    question?: string;
    options?: Array<{
        label?: string;
        description?: string;
        children?: TreeNode;
    }>;
}

// ============================================================================
// 代码块匹配正则
// ============================================================================

/**
 * 匹配可视化代码块（贪婪模式，跨行匹配）
 *
 * 捕获组:
 * - group 1: 语言标记（widget-chart / widget-choices / widget-tree / echarts / mermaid）
 * - group 2: 代码块内容
 *
 * 使用非贪婪 (.*?) 避免跨代码块匹配；dotAll flag (s) 使 . 匹配换行
 */
const VISUAL_BLOCK_REGEX = /```(widget-chart|widget-choices|widget-tree|echarts|mermaid)\s*\n(.*?)```/gs;

// ============================================================================
// 公开 API
// ============================================================================

/**
 * 剥离文本中所有可视化代码块，将其降级为纯文本格式
 *
 * @param content - 可能含有可视化代码块的原始文本
 * @returns 剥离后的纯文本（适合飞书等不支持渲染的平台）
 */
export function stripVisualCodeBlocks(content: string): string {
    if (!content) return content;

    return content.replace(VISUAL_BLOCK_REGEX, (_match, language: string, body: string) => {
        switch (language) {
            case 'widget-chart':
                return convertWidgetChart(body);
            case 'widget-choices':
                return convertWidgetChoices(body);
            case 'widget-tree':
                return convertWidgetTree(body);
            case 'echarts':
                return '📊 [Data chart: view in the client]';
            case 'mermaid':
                return '📐 [Diagram: view in the client]';
            default:
                return '';
        }
    });
}

// ============================================================================
// Widget 类型转换器
// ============================================================================

/**
 * widget-chart → 纯文本列表
 *
 * type=info: 标题 + 带标签的列表
 * type=flow: 标题 + 编号步骤
 * type=bar:  标题 + "名称: 数值" 列表
 */
function convertWidgetChart(jsonBody: string): string {
    const data = safeParseJson<WidgetChartData>(jsonBody);
    if (!data?.items || data.items.length === 0) {
        // 解析失败或无数据，返回标题兜底
        return data?.title ? `📋 **${data.title}**` : '';
    }

    const titleLine = data.title ? `📋 **${data.title}**` : '';
    const chartType = data.type ?? 'info';

    let itemLines: string[];

    switch (chartType) {
        case 'flow':
            // 流程步骤：编号列表
            itemLines = data.items.map((item, idx) => {
                const desc = item.description ? ` — ${item.description}` : '';
                return `${idx + 1}. **${item.label ?? 'Step'}**${desc}`;
            });
            break;

        case 'bar':
            // 柱状图数据：名称: 数值
            itemLines = data.items.map(item => {
                const val = item.value != null ? `: ${item.value}` : '';
                return `• ${item.label ?? 'Item'}${val}`;
            });
            break;

        case 'info':
        default:
            // 信息卡片：标签 + 描述 + 值
            itemLines = data.items.map(item => {
                const parts: string[] = [];
                if (item.label) parts.push(`**${item.label}**`);
                if (item.description) parts.push(item.description);
                if (item.value != null) parts.push(`(${item.value})`);
                return `• ${parts.join(': ')}`;
            });
            break;
    }

    return [titleLine, ...itemLines].filter(Boolean).join('\n');
}

/**
 * widget-choices → 纯文本选项列表
 */
function convertWidgetChoices(jsonBody: string): string {
    const data = safeParseJson<WidgetChoicesData>(jsonBody);
    if (!data?.options || data.options.length === 0) {
        return data?.title ? `🔘 **${data.title}**` : '';
    }

    const modeHint = data.mode === 'multi' ? ' (multiple choices allowed)' : '';
    const titleLine = data.title ? `🔘 **${data.title}**${modeHint}` : '';

    const optionLines = data.options.map(opt => {
        const desc = opt.description ? ` — ${opt.description}` : '';
        return `• ${opt.label ?? 'Option'}${desc}`;
    });

    return [titleLine, ...optionLines].filter(Boolean).join('\n');
}

/**
 * widget-tree → 纯文本缩进层级
 *
 * 递归展开树节点，最多展开 3 层（避免过深的嵌套影响可读性）
 */
function convertWidgetTree(jsonBody: string): string {
    const data = safeParseJson<WidgetTreeData>(jsonBody);
    if (!data?.tree) {
        return data?.title ? `🌳 **${data.title}**` : '';
    }

    const titleLine = data.title ? `🌳 **${data.title}**` : '';
    const treeLines = renderTreeNode(data.tree, 0);

    return [titleLine, ...treeLines].filter(Boolean).join('\n');
}

// ============================================================================
// 内部工具函数
// ============================================================================

/**
 * 递归渲染树节点为缩进文本
 *
 * @param node - 当前树节点
 * @param depth - 当前深度（0-based），控制缩进和递归上限
 */
function renderTreeNode(node: TreeNode, depth: number): string[] {
    const MAX_DEPTH = 3;
    const lines: string[] = [];
    const indent = '  '.repeat(depth);

    if (node.question) {
        lines.push(`${indent}❓ ${node.question}`);
    }

    if (node.options) {
        for (const opt of node.options) {
            const desc = opt.description ? ` — ${opt.description}` : '';
            lines.push(`${indent}• ${opt.label ?? 'Option'}${desc}`);

            // 递归展开子节点（深度限制防止无限递归）
            if (opt.children && depth < MAX_DEPTH) {
                lines.push(...renderTreeNode(opt.children, depth + 1));
            }
        }
    }

    return lines;
}

/**
 * 安全解析 JSON（解析失败返回 null，不抛异常）
 *
 * 额外处理 LLM 常见的 JSON 瑕疵：
 * - 尾部逗号（trailing comma）
 * - 单引号代替双引号
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function safeParseJson<T>(raw: string): T | null {
    try {
        return JSON.parse(raw) as T;
    } catch {
        // 尝试修复常见 JSON 瑕疵后再次解析
        try {
            const sanitized = raw
                .replace(/,\s*([}\]])/g, '$1')   // 移除尾部逗号
                .replace(/'/g, '"');              // 单引号 → 双引号
            return JSON.parse(sanitized) as T;
        } catch (retryError) {
            logger.debug('[stripVisualCodeBlocks] JSON 解析失败，跳过转换:', retryError);
            return null;
        }
    }
}
