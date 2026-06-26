/**
 * MermaidBlock - Mermaid 图表渲染组件
 *
 * 将 mermaid 语法的代码块渲染为 SVG 图表。
 *
 * 设计要点：
 * - 防抖渲染（500ms）：流式输出中每个 chunk 触发重渲染，防抖避免频繁调用 mermaid.render
 * - 两阶段渲染：
 *     Pass 1 - 基础清洗（替换中文括号/引号/<br/>等）
 *     Pass 2 - 激进清洗（将所有节点标签包裹引号，解决 ?/"" 等特殊字符导致的解析失败）
 * - 错误状态细分：区分"等待内容（流式进行中）"和"语法错误（内容完整但无法解析）"
 * - 唯一 ID：每次渲染使用全局自增 ID 避免并发冲突
 * - 成功保留：一旦渲染成功，保留 SVG 直到下次成功更新
 * - 深色模式适配：根据 data-theme 属性自动切换 mermaid 主题
 */

import { memo, useEffect, useRef, useState, useCallback, useLayoutEffect } from 'react';
import mermaid from 'mermaid';
import {
    applyMermaidVisualDirectives,
    applyMermaidDomTextContrast,
    applyMermaidSvgTextContrast,
    injectMermaidSvgStyles,
    buildMermaidVisualConfig,
    inferMermaidDiagramType,
    type MermaidDiagramType,
} from './MermaidVisualTheme';
import {
    fixFlowchartRedundantPipeLabelLinkTails,
    fixFlowchartReservedNodeIds,
    fixFlowchartUnsafeSubgraphTitles,
    sanitizeFlowchartFallbackLabel,
    sanitizeFlowchartQuotedLabels,
} from './MermaidFlowchartSanitizer';
import { useI18n } from '@/i18n';
import styles from './MermaidBlock.module.css';

// ============================================================================
// 常量
// ============================================================================

/** 在流式输出结束后多长时间仍无成功结果时，判定为语法错误（毫秒） */
const RENDER_ERROR_TIMEOUT_MS = 2000;
const NESTED_SQUARE_CONTENT_PATTERN = new RegExp('\\[([^\\[\\]]*)\\]', 'g');
const VALID_SUBPROCESS_PATTERN = new RegExp('^\\[([^\\[\\]]*)\\]$');

// ============================================================================
// Mermaid 初始化
// ============================================================================

/** 检测当前是否为深色模式 */
function isDarkMode(): boolean {
    return document.documentElement.getAttribute('data-theme') === 'dark';
}

/** 根据当前主题和图表类型重新初始化 mermaid（主题只能在 initialize 时设置） */
let currentMermaidThemeKey = '';
function getMermaidThemeKey(diagramType: MermaidDiagramType): string {
    return `${isDarkMode() ? 'dark' : 'light'}:${diagramType}`;
}

function reinitMermaid(diagramType: MermaidDiagramType): void {
    const themeKey = getMermaidThemeKey(diagramType);
    if (themeKey === currentMermaidThemeKey) return;
    currentMermaidThemeKey = themeKey;
    mermaid.initialize(buildMermaidVisualConfig(isDarkMode(), diagramType));
}

// 全局计数器，确保渲染 ID 唯一
let renderCounter = 0;

// ============================================================================
// LLM 输出清洗 — Pass 0：结构修复（嵌套方括号）
// ============================================================================

/**
 * 修复 LLM 输出中节点标签内的嵌套方括号和花括号（Pass 0，最早执行）
 *
 * 修复策略：
 * - 逐行扫描，对 NodeId[...] 模式做括号平衡匹配定位外层 ]
 * - 若标签内存在嵌套 [xxx] 或 {xxx}，统一替换为 (xxx)，保留文本语义
 * - 跳过 NodeId[[...]] 双括号形式（Mermaid 合法 subprocess 节点）
 */
function fixNestedBracketsInNodeLabels(code: string): string {
    return code
        .split('\n')
        .map(line => fixLineNestedBrackets(line))
        .join('\n');
}

/**
 * 对单行进行嵌套方括号和花括号修复
 *
 * 使用括号平衡扫描而非正则，以正确处理多层嵌套情况。
 */
function fixLineNestedBrackets(line: string): string {
    let result = '';
    let i = 0;

    while (i < line.length) {
        // 尝试在当前位置匹配 NodeId[ 模式（包括双括号 NodeId[[ 情况）
        const nodeIdMatch = /^([A-Za-z0-9_]+)\[/.exec(line.slice(i));
        if (nodeIdMatch) {
            const nodeId = nodeIdMatch[1];
            // nodeId 在正则匹配成功后必然存在，此处防御性检查满足 TypeScript 严格模式
            if (!nodeId) { result += line.charAt(i); i++; continue; }
            const openBracketPos = i + nodeId.length; // 第一个 [ 的位置
            const isDoubleBracket = line.charAt(openBracketPos + 1) === '[';

            // 括号平衡扫描：从第一个 [ 出发，找到最外层匹配的 ]
            let depth = 1;
            let j = openBracketPos + 1;
            while (j < line.length && depth > 0) {
                if (line.charAt(j) === '[') depth++;
                else if (line.charAt(j) === ']') depth--;
                j++;
            }

            if (depth === 0) {
                // outerContent：第一个 [ 与最终匹配 ] 之间的所有内容
                const outerContent = line.slice(openBracketPos + 1, j - 1);

                if (isDoubleBracket) {
                    // NodeId[[ 情况：区分合法 subprocess 与非法双括号
                    //
                    // 合法 subprocess（如 H1[[Store]]）：outerContent = "[Store]"
                    //   格式：以 [ 开头、以 ] 结尾，内部不含 [ 或 ]，原样保留
                    //
                    // 非法双括号（如 H3[[Engine] sync-project]）：outerContent = "[Engine] sync-project"
                    //   不符合上述格式，将内层 [xxx] 替换为 (xxx) 并降级为普通方括号节点
                    const isValidSubprocess = VALID_SUBPROCESS_PATTERN.test(outerContent);
                    if (isValidSubprocess) {
                        // 合法 subprocess，原样保留（H1[[Store]] → H1[[Store]]）
                        result += nodeId + '[' + outerContent + ']';
                    } else {
                        // 非法双括号，修复并降级（H3[[Engine] sync-project] → H3[(Engine) sync-project]）
                        let fixedContent = outerContent.replace(NESTED_SQUARE_CONTENT_PATTERN, '($1)');
                        fixedContent = fixedContent.replace(/[{]([^{}]*)[}]/g, '($1)');
                        result += nodeId + '[' + fixedContent + ']';
                    }
                    i = j;
                    continue;
                }

                // 单括号 NodeId[...] 情况
                if (outerContent.includes('[') || outerContent.includes('{')) {
                    // 标签内含嵌套方括号或花括号：
                    // [xxx] → (xxx)，{xxx} → (xxx)，保留文本语义
                    let fixedContent = outerContent.replace(NESTED_SQUARE_CONTENT_PATTERN, '($1)');
                    fixedContent = fixedContent.replace(/[{]([^{}]*)[}]/g, '($1)');
                    result += nodeId + '[' + fixedContent + ']';
                    i = j;
                    continue;
                } else {
                    // 标签内无嵌套方括号或花括号，按原样追加 nodeId，
                    // 从 [ 位置继续普通字符追加，避免重复处理
                    result += nodeId;
                    i = openBracketPos;
                    continue;
                }
            }
        }

        result += line.charAt(i);
        i++;
    }

    return result;
}

// ============================================================================
// LLM 输出清洗 — Pass 1：基础清洗
// ============================================================================

/**
 * 修复 LLM 输出 Mermaid 代码中的常见语法偏差（保守替换，不改变结构）
 *
 * 覆盖的偏差类型：
 * 1. 中文方括号 【】 → ASCII []
 * 2. 中文引号 "" / '' → ASCII " / '
 * 3. 中文圆括号 （）→ ASCII ()
 * 4. 全角竖线 ｜ → ASCII |（edge label 分隔符）
 * 5. <br/> → <br>（Mermaid 不支持 XHTML 自闭合格式）
 * 6. 数学不等式符号（常见于 edge label，可能导致词法器崩溃）
 */
function sanitizeMermaidCode(code: string): string {
    // Pass 0：先修复节点标签内的嵌套方括号（必须最先执行，
    // 因为后续步骤会将中文括号转 ASCII，转换后同样需要此修复）
    const symbolFixed = fixNestedBracketsInNodeLabels(code)
        // 中文方括号 → ASCII 方括号
        .replace(/【/g, '[')
        .replace(/】/g, ']')
        // 中文引号（全角）→ ASCII 引号（左引号 U+201C 和右引号 U+201D 均须替换）
        .replace(/[\u201c\u201d]/g, '"')
        .replace(/[\u2018\u2019]/g, "'")
        // 中文圆括号 → ASCII 圆括号
        .replace(/（/g, '(')
        .replace(/）/g, ')')
        // 全角竖线 → ASCII 竖线
        .replace(/｜/g, '|')
        // 对齐 Mermaid run() 的换行标签规范化：<br> / <br/> → <br/>
        .replace(/<br\s*\/?>/gi, '<br/>')
        // 数学符号 → ASCII 等价（在 edge label |≠| 中常导致词法器解析失败）
        .replace(/≠/g, '!=')
        .replace(/≤/g, '<=')
        .replace(/≥/g, '>=');

    // Pass 1.5：修复 subgraph ID 与内部节点 ID 冲突（须在符号标准化后执行）
    const quotedLabelFixed = sanitizeFlowchartQuotedLabels(symbolFixed);
    const subgraphTitleFixed = fixFlowchartUnsafeSubgraphTitles(quotedLabelFixed);
    const structFixed = fixSubgraphNodeIdCollision(subgraphTitleFixed);

    // Pass 1.6：修复 Gantt 图表 dateFormat 与实际日期格式不匹配
    const ganttFixed = fixGanttDateFormat(structFixed);
    const reservedIdFixed = fixFlowchartReservedNodeIds(ganttFixed);
    const flowchartLinkFixed = fixFlowchartRedundantPipeLabelLinkTails(reservedIdFixed);

    // Pass 1.7：注释掉 flowchart 中无效的 "NodeId : 描述" 行
    return commentOutFlowchartDescriptions(flowchartLinkFixed);
}


// ============================================================================
// LLM 输出清洗 — Pass 1.5：subgraph / 节点 ID 冲突修复
// ============================================================================

/**
 * 修复 subgraph ID 与内部节点 ID 相同的冲突（LLM 常见错误）
 *
 * 修复策略：
 * - 将冲突的 subgraph ID 重命名为 `{id}_sg`（如 Proxy → Proxy_sg）
 * - 保留节点原始 ID 不变，使所有边引用（Agent1 -.-> Proxy）自然指向节点
 * - subgraph 显示标签（["可选层"]）不受影响，视觉效果不变
 */
function fixSubgraphNodeIdCollision(code: string): string {
    const lines = code.split('\n');

    // Step 1：收集所有 subgraph ID
    const subgraphIds = new Set<string>();
    for (const line of lines) {
        const match = /^\s*subgraph\s+([A-Za-z0-9_]+)/.exec(line);
        if (match?.[1]) {
            subgraphIds.add(match[1]);
        }
    }

    if (subgraphIds.size === 0) return code;

    // Step 2：检测哪些 subgraph ID 在非 subgraph 行中被用作节点定义
    // 节点定义的特征：ID 后紧跟 [（如 Proxy["..."]）
    const collisions = new Set<string>();
    for (const sgId of subgraphIds) {
        const nodeDefPattern = new RegExp('\\b' + sgId + '\\s*\\[');
        for (const line of lines) {
            if (/^\s*subgraph\s+/.test(line)) continue;
            if (nodeDefPattern.test(line)) {
                collisions.add(sgId);
                break;
            }
        }
    }

    if (collisions.size === 0) return code;

    // Step 3：仅重命名 subgraph 定义行中的冲突 ID
    // 节点 ID 和边引用保持不变，避免破坏连接关系
    return lines.map(line => {
        for (const sgId of collisions) {
            const sgDefPattern = new RegExp(
                '^(\\s*subgraph\\s+)' + sgId + '(\\s*\\[|\\s*$)'
            );
            if (sgDefPattern.test(line)) {
                return line.replace(sgDefPattern, '$1' + sgId + '_sg$2');
            }
        }
        return line;
    }).join('\n');
}

// ============================================================================
// LLM 输出清洗 — Pass 1.6：Gantt dateFormat 修复
// ============================================================================

/**
 * 修复 Gantt 图表中 dateFormat 与实际日期格式不匹配的问题（LLM 常见错误）
 *
 * 修复策略：
 * - 从任务行中推断实际使用的日期格式（YYYY-MM-DD vs MM-DD）
 * - 若与声明不一致则自动修正 dateFormat
 * - 仅对 gantt 图表类型生效，对其他图表类型无影响
 */
function fixGanttDateFormat(code: string): string {
    // 仅对 gantt 图表类型生效
    if (!/^\s*gantt\s*$/m.test(code)) return code;

    const lines = code.split('\n');

    // Fix 1：dateFormat 与实际日期格式不匹配
    // 例如声明 dateFormat MM-DD 但任务行使用 2024-04-29（YYYY-MM-DD）
    let dateFormatIdx = -1;
    let declaredFormat = '';
    for (let i = 0; i < lines.length; i++) {
        const lineContent = lines[i];
        if (!lineContent) continue;
        const match = /^\s*dateFormat\s+(.+)/.exec(lineContent);
        if (match?.[1]) {
            dateFormatIdx = i;
            declaredFormat = match[1].trim();
            break;
        }
    }

    if (dateFormatIdx !== -1) {
        const hasYearDates = lines.some((line) =>
            /:\s*(?:done|active|crit|milestone)?\s*,?\s*\d{4}-\d{2}-\d{2}/.test(line)
        );
        if (hasYearDates && !declaredFormat.includes('YYYY')) {
            const fmtLine = lines[dateFormatIdx];
            if (fmtLine) {
                lines[dateFormatIdx] = fmtLine.replace(
                    /dateFormat\s+.+/,
                    'dateFormat YYYY-MM-DD'
                );
            }
        }
    }

    // Fix 2：任务行缺少持续时间/结束日期
    // LLM 常写 `:done, 2024-04-29` 但 Mermaid 要求每个任务都有持续时间或结束日期
    // 检测以日期结尾的任务行，自动补 `, 1d`
    const taskDateOnly = /^(\s*\S.*:\s*(?:done|active|crit|milestone)?\s*,?\s*(?:\d{4}-)?\d{2}-\d{2})\s*$/;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        // 跳过 dateFormat / title / section 等指令行
        if (/^\s*(gantt|title|dateFormat|axisFormat|tickInterval|excludes|includes|todayMarker|section)\b/.test(line)) continue;
        const match = taskDateOnly.exec(line);
        if (match?.[1]) {
            lines[i] = match[1] + ', 1d';
        }
    }

    return lines.join('\n');
}


// ============================================================================
// LLM 输出清洗 — Pass 1.7：flowchart 无效描述行注释
// ============================================================================

/**
 * 将 flowchart 中无效的 "NodeId : 描述文字" 行转为注释
 *
 * 修复策略：
 * - 仅对 flowchart/graph 类型生效
 * - 收集代码中已定义的节点 ID（出现在 NodeId[...] / NodeId(...) 等节点定义中）
 * - 匹配 "已知NodeId : 文字" 模式的独立行，转为 %% 注释
 * - 不影响合法语法（如 edge label、classDef、style 等含冒号的行）
 */
function commentOutFlowchartDescriptions(code: string): string {
    const lines = code.split('\n');

    // 仅对 flowchart/graph 生效
    const firstContentLine = lines.map(l => l.trim()).find(l => l.length > 0 && !l.startsWith('%%'));
    if (!firstContentLine || !/^(flowchart|graph)\b/i.test(firstContentLine)) {
        return code;
    }

    // Step 1：收集所有已定义的节点 ID
    // 匹配 NodeId[...] / NodeId(...) / NodeId{...} / NodeId>...] 等定义形式
    const definedNodeIds = new Set<string>();
    const nodeDefPattern = /\b([A-Za-z][A-Za-z0-9_]*)\s*[([{>]/g;
    for (const line of lines) {
        const trimmed = line.trim();
        // 跳过指令行
        if (/^\s*(flowchart|graph|subgraph|end|classDef|class|style|click|linkStyle)\b/.test(trimmed)) continue;
        let match: RegExpExecArray | null;
        while ((match = nodeDefPattern.exec(trimmed)) !== null) {
            if (match[1]) {
                definedNodeIds.add(match[1]);
            }
        }
    }

    if (definedNodeIds.size === 0) return code;

    // Step 2：检测并注释无效描述行
    // 匹配模式：`NodeId : 任意文字`（整行只有这个结构，没有其他节点引用或箭头）
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i]?.trim();
        if (!trimmed) continue;

        // 匹配 "已知NodeId" + 空格 + ":" + 空格 + "非空文字"
        const descMatch = /^([A-Za-z][A-Za-z0-9_]*)\s+:\s+(\S.*)$/.exec(trimmed);
        if (!descMatch?.[1]) continue;

        const nodeId = descMatch[1];

        // 确认该 ID 是已定义的节点
        if (!definedNodeIds.has(nodeId)) continue;

        // 排除合法语法：含箭头(-->)、含管道(|)、含分号(;)、含方括号定义等
        if (/-->|---|\||\[|;|:::/.test(trimmed)) continue;

        // 该行是无效的描述行，转为注释
        const indent = lines[i]?.match(/^(\s*)/)?.[1] ?? '';
        lines[i] = `${indent}%% ${trimmed}`;
        changed = true;
    }

    return changed ? lines.join('\n') : code;
}


// ============================================================================
// LLM 输出清洗 — Pass 2：激进清洗（仅在 Pass 1 失败时使用）
// ============================================================================

/**
 * 将所有节点标签包裹在双引号中，解决 Pass 1 无法覆盖的边界情况
 *
 * 转换规则：
 * - `[text]`       → `["text"]`（内部 " 转 '，内部 ' 保留）
 * - `NodeId{text}` → `NodeId{"text"}` （仅限菱形节点，需 NodeId 前缀）
 * - 已被引号包裹的标签（如 `["text"]`）不重复处理
 *
 * ⚠️ 花括号包裹约束为 NodeId 前缀的原因：
 * 避免匹配已被引号包裹的 [...] 标签内部的花括号，从而防止
 * F["payload = {task: task}"] → F["payload = {"task: task"}"] 的二次损坏
 *
 * 警告：此函数改变标签的语法形式，仅作为 fallback 使用
 */
function aggressiveSanitizeMermaidCode(code: string): string {
    // Pass 2 仅对 flowchart/graph 生效：
    // 其他图表类型（quadrantChart、gantt、sequence 等）有完全不同的语法，
    // 例如 quadrantChart 的 [0.3, 0.8] 是坐标，不是节点标签。
    // 激进包裹引号会把坐标破坏为 ["0.3, 0.8"]，导致解析崩溃。
    const firstContentLine = code.split('\n').map(l => l.trim()).find(l => l.length > 0 && !l.startsWith('%%'));
    if (firstContentLine && !/^(flowchart|graph)\b/i.test(firstContentLine)) {
        return code;
    }

    // 将方括号标签 [text] 包裹引号（跳过已有 " 开头的标签）
    // 正则说明：匹配 [ 开头不是 " 的内容（不含换行和 [ ] 嵌套）
    const wrapSquare = code.replace(
        /\[([^"[\]\n][^[\]\n]*)]/g,
        (_, label: string) => {
            // 内部双引号转单引号，避免破坏外层引号边界
            const escaped = sanitizeFlowchartFallbackLabel(label);
            return `["${escaped}"]`;
        }
    );

    // 将花括号标签 {text} 包裹引号（仅限菱形节点 NodeId{text} 结构）
    // 约束为 NodeId 前缀：避免匹配已被方括号引号包裹的标签内部的花括号
    // 例如 F["payload = {task: task}"] 中的 {task: task} 不应被二次处理
    const wrapBoth = wrapSquare.replace(
        /([A-Za-z0-9_]+)[{]([^"{}\n][^{}\n]*)[}]/g,
        (_, nodeId: string, label: string) => {
            const escaped = sanitizeFlowchartFallbackLabel(label);
            return `${nodeId}{"${escaped}"}`;
        }
    );

    return wrapBoth;
}

// ============================================================================
// 渲染工具函数
// ============================================================================

/** 清理 Mermaid 在 document.body 残留的临时节点 */
function cleanupTempNode(uniqueId: string): void {
    const tempElement = document.getElementById(`d${uniqueId}`);
    tempElement?.remove();
}

/** 执行单次 mermaid.render 并清理临时节点 */
async function renderMermaid(code: string): Promise<string> {
    renderCounter += 1;
    const uniqueId = `mermaid-block-${String(renderCounter)}`;
    try {
        const { svg } = await mermaid.render(uniqueId, code);
        // 两阶段后处理：先修复文字对比度，再注入视觉增强样式（圆角 + 端点圆滑）
        const contrastFixed = applyMermaidSvgTextContrast(svg);
        return injectMermaidSvgStyles(contrastFixed);
    } finally {
        // 无论成功失败，均清理可能残留在 document.body 的临时节点
        cleanupTempNode(uniqueId);
    }
}

function prepareMermaidCode(rawCode: string): string {
    const sanitized = sanitizeMermaidCode(rawCode);
    const diagramType = inferMermaidDiagramType(sanitized);
    reinitMermaid(diagramType);
    return applyMermaidVisualDirectives(sanitized, diagramType, isDarkMode());
}

// ============================================================================
// 类型定义
// ============================================================================

interface MermaidBlockProps {
    /** Mermaid 语法源码 */
    code: string;
}

// ============================================================================
// 组件实现
// ============================================================================

export const MermaidBlock = memo(function MermaidBlock({ code }: MermaidBlockProps) {
    const { t } = useI18n();
    const containerRef = useRef<HTMLDivElement>(null);
    const lastRenderedCode = useRef<string>('');
    const lastRenderedTheme = useRef<string>('');
    const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // 用 ref 同步 svgContent 状态，在 callback 闭包中访问最新值以避免 stale closure
    const svgContentRef = useRef<string | null>(null);
    // 记录组件挂载状态，防止 unmount 后执行异步 setState
    const isMountedRef = useRef(true);
    const [svgContent, setSvgContent] = useState<string | null>(null);
    const [isRendering, setIsRendering] = useState(false);
    // 语法错误标志：内容完整但 mermaid 两阶段都解析失败
    const [renderError, setRenderError] = useState(false);

    // 保持 svgContentRef 与 svgContent state 同步
    useEffect(() => {
        svgContentRef.current = svgContent;
    }, [svgContent]);

    // 同步标记挂载状态（useLayoutEffect 保证在所有异步回调前设置）
    useLayoutEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    /**
     * 两阶段渲染：
     * Pass 1 - 基础清洗后尝试渲染
     * Pass 2 - 若 Pass 1 失败，激进清洗（包裹标签引号）后重试
     * 两次都失败 → 延迟标记 renderError，避免流式输出中的误判
     */
    const doRender = useCallback(async (rawCode: string) => {
        setIsRendering(true);
        setRenderError(false);

        const pass1Code = prepareMermaidCode(rawCode);
        let renderSuccess = false;

        // Pass 1：基础清洗
        try {
            const svg = await renderMermaid(pass1Code);
            if (!isMountedRef.current) return;
            setSvgContent(svg);
            renderSuccess = true;
            lastRenderedCode.current = rawCode;
            lastRenderedTheme.current = getMermaidThemeKey(inferMermaidDiagramType(pass1Code));
        } catch {
            // Pass 1 失败，尝试 Pass 2
        }

        if (!renderSuccess) {
            // Pass 2：激进清洗（将所有节点标签包裹引号）
            const pass2Code = aggressiveSanitizeMermaidCode(pass1Code);
            try {
                const svg = await renderMermaid(pass2Code);
                if (!isMountedRef.current) return;
                setSvgContent(svg);
                renderSuccess = true;
                lastRenderedCode.current = rawCode;
                lastRenderedTheme.current = getMermaidThemeKey(inferMermaidDiagramType(pass1Code));
            } catch {
                // Pass 2 也失败了：延迟标记错误
                // 延迟 RENDER_ERROR_TIMEOUT_MS 再判定，避免流式输出中的误判
                if (errorTimer.current) clearTimeout(errorTimer.current);
                errorTimer.current = setTimeout(() => {
                    if (isMountedRef.current && !svgContentRef.current) {
                        setRenderError(true);
                    }
                }, RENDER_ERROR_TIMEOUT_MS);
            }
        }

        if (isMountedRef.current) {
            setIsRendering(false);
        }
    }, []);

    // 内容变化时防抖渲染
    useEffect(() => {
        const trimmed = code.trim();
        if (!trimmed || trimmed === lastRenderedCode.current) return;

        if (debounceTimer.current) {
            clearTimeout(debounceTimer.current);
        }

        // 500ms 防抖，避免流式输出中频繁触发
        debounceTimer.current = setTimeout(() => {
            void doRender(trimmed);
        }, 500);

        return () => {
            if (debounceTimer.current) {
                clearTimeout(debounceTimer.current);
            }
        };
    }, [code, doRender]);

    // 监听主题切换（MutationObserver 观察 data-theme 属性变化）
    useEffect(() => {
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.attributeName === 'data-theme' && lastRenderedCode.current) {
                    const sanitized = sanitizeMermaidCode(lastRenderedCode.current);
                    const newTheme = getMermaidThemeKey(inferMermaidDiagramType(sanitized));
                    if (newTheme !== lastRenderedTheme.current) {
                        void doRender(lastRenderedCode.current);
                    }
                }
            }
        });

        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme'],
        });

        return () => observer.disconnect();
    }, [doRender]);

    // 清理计时器
    useEffect(() => {
        return () => {
            if (errorTimer.current) clearTimeout(errorTimer.current);
        };
    }, []);

    // SVG 插入 DOM 后再修正一次文字对比度，以覆盖 Mermaid 内联 <style> 的 classDef 场景
    useLayoutEffect(() => {
        if (!svgContent || !containerRef.current) return;
        applyMermaidDomTextContrast(containerRef.current);
    }, [svgContent]);

    // 已成功渲染 → 显示 SVG
    if (svgContent) {
        return (
            <div
                ref={containerRef}
                className={styles.container}
                dangerouslySetInnerHTML={{ __html: svgContent }}
            />
        );
    }

    // 两阶段都失败（内容完整但语法无法解析）→ 友好错误提示
    if (renderError) {
        return (
            <div className={styles.errorPlaceholder}>
                <span className={styles.errorIcon}>⚠️</span>
                <span className={styles.placeholderText}>{t('file.mermaidSyntaxError')}</span>
            </div>
        );
    }

    // 尚未成功渲染 → 加载占位
    return (
        <div className={styles.placeholder}>
            {isRendering ? (
                <span className={styles.placeholderText}>{t('file.renderingDiagram')}</span>
            ) : (
                <span className={styles.placeholderText}>{t('file.waitingDiagram')}</span>
            )}
        </div>
    );
});
