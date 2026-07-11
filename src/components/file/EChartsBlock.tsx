/**
 * EChartsBlock - ECharts 数据图表渲染组件
 *
 * 将 echarts 语言代码块中的 JSON option 渲染为交互式图表。
 * LLM 输出标准 ECharts option JSON → 前端解析并调用 setOption()。
 *
 * 设计要点：
 * - 防抖渲染（500ms）：流式输出中避免频繁重建图表
 * - 静默错误：JSON 不完整时不显示错误，等待完整内容
 * - 自适应尺寸：使用 ResizeObserver 响应容器宽度变化
 * - 深色模式适配：根据 data-theme 属性自动切换 ECharts 主题 + 透明背景
 */

import { memo, useEffect, useRef, useState, useCallback, type CSSProperties } from 'react';
import * as echarts from 'echarts/core';
import {
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  RadarChart,
  GaugeChart,
  FunnelChart,
  HeatmapChart,
} from 'echarts/charts';
import {
  TitleComponent,
  TooltipComponent,
  GridComponent,
  LegendComponent,
  DatasetComponent,
  MarkLineComponent,
  MarkPointComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
// 兼容新版 ECharts 对 grid.containLabel 的迁移警告：
// LLM 常用 containLabel: true 缩进坐标轴标签，需注册此 legacy 扩展保持向后兼容
// 使用 echarts/features 路径导入（有对应的 .d.ts，无 TS 类型错误）
import { LegacyGridContainLabel } from 'echarts/features';
import type { EChartsOption } from 'echarts';
import { buildSafeEChartsOption } from './EchartsVisualTheme';
import { useI18n } from '@/i18n';
import styles from './EChartsBlock.module.css';

// 按需注册组件（仅注册一次）
// 包含 LLM 可视化增强常用的所有图表类型和辅助组件
echarts.use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  RadarChart,
  GaugeChart,
  FunnelChart,
  HeatmapChart,
  TitleComponent,
  TooltipComponent,
  GridComponent,
  LegendComponent,
  DatasetComponent,
  MarkLineComponent,
  MarkPointComponent,
  VisualMapComponent,
  CanvasRenderer,
]);
// 注册 legacy containLabel 支持，消除 ECharts 5.6+ 的迁移警告
// LLM 输出的 option 中频繁使用 grid.containLabel: true，此处选择兼容而非强制迁移所有 LLM prompt
echarts.use(LegacyGridContainLabel);

interface EChartsBlockProps {
  /** ECharts option JSON 字符串 */
  code: string;
}

interface EChartsTableFallback {
  title: string;
  headers: string[];
  rows: string[][];
  headerBold: boolean;
  rowHeight: number;
}

/** 检测当前是否为深色模式 */
function isDarkMode(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

/**
 * 清理 LLM 输出中常见的非法 JSON 语法
 *
 * LLM 是否遵守"禁止 function/callback"的 Prompt 约束取决于模型能力，
 * 因此前端必须做防御性清理。
 *
 * 处理的非法语法：
 * - `function(params) { ... }` → 替换为 null
 * - `(params) => { ... }` 箭头函数 → 替换为 null
 * - 尾随逗号 `,}` / `,]` → 删除多余逗号
 * - 单引号字符串 `'text'` → 转为双引号 `"text"`（仅在非字符串上下文中）
 * - 颜色值 emoji 前缀 `"🟩#5C7A5C"` → `"#5C7A5C"`
 *
 * 使用 replaceFunctionExpressions 做逐字符扫描，能可靠处理嵌套花括号。
 */
// eslint-disable-next-line react-refresh/only-export-components
export function sanitizeEChartsJson(json: string): string {
  // Step 1：移除尾随逗号（LLM 最高频的 JSON 格式错误）
  // ,] 和 ,} 之间可能有空白字符（空格、换行、缩进）
  const noTrailingComma = json.replace(/,(\s*[}\]])/g, '$1');

  // Step 2：替换 JS function / 箭头函数表达式为 null
  const noFunctions = replaceFunctionExpressions(noTrailingComma);

  // Step 3：清理颜色值中的 emoji 前缀（如 "🟩#5C7A5C" → "#5C7A5C"）
  // LLM 常在 hex 色值前添加色块 emoji 作为视觉修饰，ECharts 无法识别
  const noEmojiColors = noFunctions.replace(
    /"color"\s*:\s*"([^"]*?)#([0-9A-Fa-f]{3,8})"/g,
    (match, prefix: string, hex: string) => {
      // 仅当 # 前有非法字符时才清理（保留合法的纯 #hex）
      if (prefix.length > 0) {
        return `"color": "#${hex}"`;
      }
      return match;
    }
  );

  // Step 4：移除数值后的游离引号（如 60" → 60）
  const noStrayQuotes = noEmojiColors.replace(/:\s*(-?\d+(?:\.\d+)?)"(\s*[,}\]])/g, ': $1$2');

  // Step 5：修复字符串值缺失左引号（如 "type":value" → "type":"value"）
  const noMissingQuotes = noStrayQuotes.replace(
    /:\s*([a-zA-Z_][a-zA-Z0-9_ ]*)"(\s*[,}\]])/g,
    (match, word: string, after: string) => {
      // true/false/null 是 JSON 合法裸值，不应被引号包裹
      if (/^(true|false|null)$/.test(word.trim())) return match;
      return `:"${word}"${after}`;
    }
  );

  // Step 6: 引用裸数组值 (例如数据: [100, 无限, 750]).
  return quoteBareArrayValues(noMissingQuotes);
}

function quoteBareArrayValues(json: string): string {
  let result = '';
  let i = 0;
  const stack: Array<'array' | 'object'> = [];
  let expectingArrayValue = false;

  while (i < json.length) {
    const char = json.charAt(i);

    if (char === '"') {
      const copied = copyQuotedString(json, i);
      result += copied.value;
      i = copied.nextIndex;
      expectingArrayValue = false;
      continue;
    }

    if (char === '[') {
      stack.push('array');
      result += char;
      i++;
      expectingArrayValue = true;
      continue;
    }

    if (char === '{') {
      stack.push('object');
      result += char;
      i++;
      expectingArrayValue = false;
      continue;
    }

    if (char === ']' || char === '}') {
      stack.pop();
      result += char;
      i++;
      expectingArrayValue = false;
      continue;
    }

    if (char === ',') {
      result += char;
      i++;
      expectingArrayValue = stack[stack.length - 1] === 'array';
      continue;
    }

    if (expectingArrayValue && stack[stack.length - 1] === 'array') {
      while (i < json.length && /\s/.test(json.charAt(i))) {
        result += json.charAt(i);
        i++;
      }

      const valueStart = i;
      const firstValueChar = json.charAt(valueStart);
      if (firstValueChar === '"' || firstValueChar === '{' || firstValueChar === '[') {
        expectingArrayValue = false;
        continue;
      }

      while (i < json.length && json.charAt(i) !== ',' && json.charAt(i) !== ']') {
        i++;
      }

      const rawValue = json.slice(valueStart, i);
      const trimmedValue = rawValue.trim();
      if (!trimmedValue || isJsonBareLiteral(trimmedValue)) {
        result += rawValue;
      } else {
        const trailingWhitespace = rawValue.slice(
          rawValue.lastIndexOf(trimmedValue) + trimmedValue.length
        );
        result += JSON.stringify(trimmedValue) + trailingWhitespace;
      }
      expectingArrayValue = false;
      continue;
    }

    result += char;
    i++;
  }

  return result;
}

function copyQuotedString(text: string, startIndex: number): { value: string; nextIndex: number } {
  let result = text.charAt(startIndex);
  let i = startIndex + 1;

  while (i < text.length) {
    const char = text.charAt(i);
    result += char;
    i++;

    if (char === '\\' && i < text.length) {
      result += text.charAt(i);
      i++;
      continue;
    }

    if (char === '"') break;
  }

  return { value: result, nextIndex: i };
}

function isJsonBareLiteral(value: string): boolean {
  return /^(?:true|false|null)$/.test(value) || /^-?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(value);
}

/**
 * 逐字符扫描并替换 JavaScript function 表达式为 null
 *
 * 支持：
 * - function(params) { ... }（含嵌套花括号）
 * - (params) => { ... } 箭头函数
 */
function replaceFunctionExpressions(json: string): string {
  const FUNC_KEYWORD = 'function';
  let result = '';
  let i = 0;

  while (i < json.length) {
    // 检测是否在 JSON 字符串值内部
    if (json.charAt(i) === '"') {
      // 复制整个字符串值（不在字符串内搜索 function）
      result += json.charAt(i);
      i++;
      while (i < json.length) {
        if (json.charAt(i) === '\\') {
          result += json.charAt(i);
          i++;
          if (i < json.length) {
            result += json.charAt(i);
            i++;
          }
          continue;
        }
        if (json.charAt(i) === '"') {
          result += json.charAt(i);
          i++;
          break;
        }
        result += json.charAt(i);
        i++;
      }
      continue;
    }

    // 检测 function 关键字
    if (json.slice(i, i + FUNC_KEYWORD.length) === FUNC_KEYWORD) {
      // 确认后面跟的是空格或左括号（排除 "functionality" 等单词）
      const afterKeyword = json.charAt(i + FUNC_KEYWORD.length);
      if (afterKeyword === '(' || afterKeyword === ' ') {
        // 找到左花括号
        let j = i + FUNC_KEYWORD.length;
        while (j < json.length && json.charAt(j) !== '{') j++;
        if (j < json.length) {
          // 匹配花括号对
          let depth = 1;
          j++;
          while (j < json.length && depth > 0) {
            if (json.charAt(j) === '{') depth++;
            else if (json.charAt(j) === '}') depth--;
            j++;
          }
          // 用 null 替换整个 function 表达式
          result += 'null';
          i = j;
          continue;
        }
      }
    }

    // 检测箭头函数 (params) => { ... }
    if (json.charAt(i) === '(' && i > 0) {
      // 回溯检查前面是否是 JSON 值位置（冒号后面）
      const prevNonSpace = findPrevNonSpace(json, i - 1);
      if (prevNonSpace === ':' || prevNonSpace === ',') {
        // 可能是箭头函数，尝试匹配
        let j = i + 1;
        // 跳过参数列表
        while (j < json.length && json.charAt(j) !== ')') j++;
        if (j < json.length) {
          j++; // 跳过 ')'
          // 跳过空白
          while (j < json.length && /\s/.test(json.charAt(j))) j++;
          // 检查 =>
          if (json.charAt(j) === '=' && json.charAt(j + 1) === '>') {
            j += 2;
            // 跳过空白
            while (j < json.length && /\s/.test(json.charAt(j))) j++;
            if (json.charAt(j) === '{') {
              // 花括号体箭头函数：(params) => { ... }
              let depth = 1;
              j++;
              while (j < json.length && depth > 0) {
                if (json.charAt(j) === '{') depth++;
                else if (json.charAt(j) === '}') depth--;
                j++;
              }
              result += 'null';
              i = j;
              continue;
            } else {
              // 表达式体箭头函数：(v) => v.value.toLocaleString()
              // 扫描到当前 JSON 值的结束位置（同层 , 或上层 } / ]）
              let depth = 0;
              while (j < json.length) {
                const ch = json.charAt(j);
                if (ch === '(' || ch === '[') depth++;
                else if (ch === ')' || ch === ']') {
                  if (depth === 0) break;
                  depth--;
                }
                // 同层逗号或外层右花括号 → 表达式结束
                else if (depth === 0 && (ch === ',' || ch === '}')) break;
                j++;
              }
              result += 'null';
              i = j;
              continue;
            }
          }
        }
      }
    }

    result += json.charAt(i);
    i++;
  }

  return result;
}

/** 查找前一个非空白字符 */
function findPrevNonSpace(str: string, fromIndex: number): string | null {
  for (let i = fromIndex; i >= 0; i--) {
    const char = str.charAt(i);
    if (!/\s/.test(char)) return char;
  }
  return null;
}

/**
 * 后处理 ECharts option，修复 LLM 常见的配置缺陷
 *
 */
// eslint-disable-next-line react-refresh/only-export-components
export function postProcessEChartsOption(option: EChartsOption): void {
  if (!Array.isArray(option.series)) return;

  for (const series of option.series) {
    const s = series as Record<string, unknown>;
    const seriesType = s.type as string | undefined;

    normalizeTextualSeriesData(s);

    // Fix 1: 柱状图 — 隐藏 0 值透明占位条的标签
    if (seriesType === 'bar' && Array.isArray(s.data)) {
      for (const item of s.data) {
        if (typeof item !== 'object' || item === null) continue;
        const d = item as Record<string, unknown>;
        const value = d.value;
        const itemStyle = d.itemStyle as Record<string, unknown> | undefined;
        const color = itemStyle?.color;
        // 仅处理 value=0 且颜色为 transparent 的占位数据项
        if (value === 0 && color === 'transparent') {
          d.label = { show: false };
        }
      }
    }

    // Fix 2: 仪表盘 — 限制 axisLabel 字号避免窄容器重叠
    if (seriesType === 'gauge') {
      const axisLabel = s.axisLabel as Record<string, unknown> | undefined;
      if (axisLabel) {
        const fontSize = axisLabel.fontSize;
        if (typeof fontSize === 'number' && fontSize > 10) {
          axisLabel.fontSize = 10;
        }
      }
    }
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export function buildEChartsTableFallback(option: EChartsOption): EChartsTableFallback | null {
  const series = getEChartsSeriesList(option).find((item) => item.type === 'table');
  if (!series) return null;

  const source = getEChartsDatasetSource(option);
  const rows = normalizeTableSourceRows(source);
  if (!rows || rows.length < 2) return null;

  const headers = rows[0];
  if (!headers || headers.length === 0) return null;

  return {
    title: getEChartsTitleText(option),
    headers,
    rows: rows.slice(1),
    headerBold: series.headerBold !== false,
    rowHeight: normalizeTableRowHeight(series.rowHeight),
  };
}

function getEChartsSeriesList(option: EChartsOption): Array<Record<string, unknown>> {
  const series = (option as Record<string, unknown>).series;
  const list = Array.isArray(series) ? series : series ? [series] : [];
  return list.filter(isPlainRecord);
}

function getEChartsDatasetSource(option: EChartsOption): unknown {
  const dataset = (option as Record<string, unknown>).dataset;
  const datasetList = Array.isArray(dataset) ? dataset : dataset ? [dataset] : [];
  const firstDataset = datasetList.find(isPlainRecord);
  return firstDataset?.source;
}

function normalizeTableSourceRows(source: unknown): string[][] | null {
  if (!Array.isArray(source)) return null;

  const rawRows = source.filter(Array.isArray);
  if (rawRows.length === 0) return null;

  const width = Math.max(...rawRows.map((row) => row.length));
  if (width === 0) return null;

  return rawRows.map((row) => {
    const normalized = row.map(formatTableCellValue);
    while (normalized.length < width) normalized.push('');
    return normalized;
  });
}

function formatTableCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function getEChartsTitleText(option: EChartsOption): string {
  const title = (option as Record<string, unknown>).title;
  const titleRecord = Array.isArray(title) ? title.find(isPlainRecord) : title;
  if (!isPlainRecord(titleRecord)) return '';

  const text = titleRecord.text;
  return typeof text === 'string' ? text : '';
}

function normalizeTableRowHeight(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(56, Math.max(24, value))
    : 30;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeTextualSeriesData(series: Record<string, unknown>): void {
  if (!Array.isArray(series.data)) return;

  const data: unknown[] = series.data;
  const finiteValues = data
    .map(extractFiniteDataValue)
    .filter((value): value is number => typeof value === 'number');
  const maxFiniteValue = finiteValues.length > 0 ? Math.max(...finiteValues) : 1;
  const unlimitedDisplayValue = Math.max(1, Math.ceil(maxFiniteValue * 1.12));

  const normalizedData = data.map((item): unknown => {
    if (typeof item !== 'string') return item;

    const label = item.trim();
    if (!label) return null;

    if (isUnlimitedDataLabel(label)) {
      return {
        value: unlimitedDisplayValue,
        label: {
          show: true,
          position: 'top',
          formatter: label,
        },
      };
    }

    return null;
  });

  series.data = normalizedData;
}

function extractFiniteDataValue(item: unknown): number | null {
  if (typeof item === 'number' && Number.isFinite(item)) return item;

  if (Array.isArray(item)) {
    const values: unknown[] = item;
    const firstNumber = values.find((value) => typeof value === 'number' && Number.isFinite(value));
    return typeof firstNumber === 'number' ? firstNumber : null;
  }

  if (typeof item === 'object' && item !== null) {
    const value = (item as Record<string, unknown>).value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      const values: unknown[] = value;
      const firstNumber = values.find(
        (entry) => typeof entry === 'number' && Number.isFinite(entry)
      );
      return typeof firstNumber === 'number' ? firstNumber : null;
    }
  }

  return null;
}

function isUnlimitedDataLabel(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === '无限' ||
    normalized === '不限' ||
    normalized === '不限制' ||
    normalized === '∞' ||
    normalized === 'unlimited' ||
    normalized === 'infinite' ||
    normalized === 'infinity'
  );
}

/** 每类别的高度基准（横向柱状图：yAxis 为 category） */
const HEIGHT_PER_CATEGORY = 36;
/** 横向柱状图的基础上下留白 */
const HORIZONTAL_BAR_PADDING = 80;

/**
 * 根据图表类型和数据维度计算最佳容器高度
 *
 * 设计原则：
 * - 饼图/仪表盘/雷达图：接近正方形（宽高比 ≈ 1:1），视觉平衡
 * - 横向柱状图：高度随类别数线性增长，避免条形过于拥挤
 * - 其他图表：使用 5:3 宽高比，与当前 320px 默认值在 ~530px 宽度时等价
 */
function calculateOptimalHeight(option: EChartsOption, containerWidth: number): number {
  const series = Array.isArray(option.series) ? option.series : [];
  const chartTypes = new Set<string>();
  for (const s of series) {
    const t = (s as Record<string, unknown>).type;
    if (typeof t === 'string') chartTypes.add(t);
  }

  // 正方形类图表：饼图 / 仪表盘 / 雷达图
  // 高度 = min(容器宽度, 400px)，避免在宽屏下过高
  if (chartTypes.has('pie') || chartTypes.has('gauge') || chartTypes.has('radar')) {
    return Math.min(containerWidth, 400);
  }

  // 横向柱状图：yAxis.type === 'category' → 高度按类别数缩放
  if (chartTypes.has('bar')) {
    const yAxis = option.yAxis;
    // yAxis 可能是对象或数组
    const yAxes = Array.isArray(yAxis) ? yAxis : yAxis ? [yAxis] : [];
    for (const axis of yAxes) {
      const a = axis as Record<string, unknown>;
      if (a.type === 'category' && Array.isArray(a.data)) {
        const categoryCount = a.data.length;
        return Math.max(200, categoryCount * HEIGHT_PER_CATEGORY + HORIZONTAL_BAR_PADDING);
      }
    }
  }

  // 默认：5:3 宽高比（在 ~530px 宽度时约为 320px，与旧版一致）
  return Math.max(240, Math.round(containerWidth * 0.6));
}

/** 安全解析 JSON（流式输出中可能不完整，静默失败） */
// eslint-disable-next-line react-refresh/only-export-components
export function safeParseEChartsOption(json: string): EChartsOption | null {
  // 第一次尝试：直接解析
  let directError: unknown;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as EChartsOption;
    }
  } catch (error) {
    directError = error;
  }

  // 第二次尝试：清理 JavaScript 语法后解析
  let sanitized = '';
  try {
    sanitized = sanitizeEChartsJson(json);
    const parsed: unknown = JSON.parse(sanitized);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as EChartsOption;
    }
  } catch (sanitizedError) {
    // 输出诊断日志帮助定位 LLM 输出中的非法语法
    // 仅在 JSON 长度 > 20（非流式片段）时输出，避免流式输出阶段刷屏
    if (json.length > 20) {
      // 从错误消息中提取失败位置，输出附近的字符帮助精确定位
      const posMatch = /position (\d+)/.exec(
        sanitizedError instanceof Error ? sanitizedError.message : ''
      );
      const errorPos = posMatch?.[1] ? Number(posMatch[1]) : -1;
      const aroundError =
        errorPos >= 0
          ? sanitized.slice(Math.max(0, errorPos - 40), errorPos + 40)
          : '(unknown position)';

      console.warn('[EChartsBlock] JSON 解析失败（两次尝试均失败）', {
        rawLength: json.length,
        rawTail: json.slice(-200),
        aroundError,
        errorPos,
        directError: directError instanceof Error ? directError.message : String(directError),
        sanitizedError:
          sanitizedError instanceof Error ? sanitizedError.message : String(sanitizedError),
      });
    }
  }

  return null;
}

export const EChartsBlock = memo(function EChartsBlock({ code }: EChartsBlockProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<echarts.ECharts | null>(null);
  const lastRenderedCode = useRef<string>('');
  const lastTheme = useRef<string>('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hasRendered, setHasRendered] = useState(false);
  const [tableFallback, setTableFallback] = useState<EChartsTableFallback | null>(null);

  // 创建图表实例（根据主题选择 echart theme）
  const createInstance = useCallback(() => {
    if (!containerRef.current) return null;

    // 销毁旧实例
    if (chartInstanceRef.current) {
      chartInstanceRef.current.dispose();
      chartInstanceRef.current = null;
    }

    const dark = isDarkMode();
    const theme = dark ? 'dark' : undefined;
    lastTheme.current = dark ? 'dark' : 'light';

    const instance = echarts.init(containerRef.current, theme, {
      renderer: 'canvas',
    });

    chartInstanceRef.current = instance;
    return instance;
  }, []);

  // 初始化或更新图表
  const renderChart = useCallback(
    (option: EChartsOption) => {
      const nextTableFallback = buildEChartsTableFallback(option);
      if (nextTableFallback) {
        chartInstanceRef.current?.dispose();
        chartInstanceRef.current = null;
        setTableFallback(nextTableFallback);
        setHasRendered(true);
        return;
      }

      setTableFallback(null);

      const dark = isDarkMode();
      const currentTheme = dark ? 'dark' : 'light';

      // 主题变化时需要重建实例（ECharts 主题只能在 init 时设置）
      if (!chartInstanceRef.current || currentTheme !== lastTheme.current) {
        createInstance();
      }

      if (!chartInstanceRef.current) return;

      const safeOption = buildSafeEChartsOption(option, {
        dark,
        enableVisualTheme: true,
      });
      postProcessEChartsOption(safeOption);

      const applyOptionSize = (nextOption: EChartsOption) => {
        if (!containerRef.current) return;

        const containerWidth = containerRef.current.offsetWidth;
        if (containerWidth > 0) {
          const optimalHeight = calculateOptimalHeight(nextOption, containerWidth);
          containerRef.current.style.setProperty('--chart-height', `${String(optimalHeight)}px`);
        }
      };

      applyOptionSize(safeOption);

      try {
        // 容器高度变化后需要通知 ECharts 重新计算布局
        chartInstanceRef.current.resize();
        chartInstanceRef.current.setOption(safeOption, true);
        setHasRendered(true);
      } catch (error) {
        const fallbackOption = buildSafeEChartsOption(option, {
          dark,
          enableVisualTheme: false,
        });
        postProcessEChartsOption(fallbackOption);
        applyOptionSize(fallbackOption);

        try {
          chartInstanceRef.current.resize();
          chartInstanceRef.current.setOption(fallbackOption, true);
          setHasRendered(true);
        } catch (fallbackError) {
          console.warn('[EChartsBlock] 图表渲染失败，已跳过本次 option', {
            error,
            fallbackError,
          });
        }
      }
    },
    [createInstance]
  );

  // 防抖渲染
  useEffect(() => {
    const trimmed = code.trim();
    if (!trimmed || trimmed === lastRenderedCode.current) return;

    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    // 500ms 防抖：流式输出稳定后再渲染
    debounceTimer.current = setTimeout(() => {
      const option = safeParseEChartsOption(trimmed);
      if (option) {
        renderChart(option);
        lastRenderedCode.current = trimmed;
      }
    }, 500);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [code, renderChart]);

  // 监听主题切换（MutationObserver 观察 data-theme 属性变化）
  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'data-theme' && lastRenderedCode.current) {
          // 主题变化时用上次成功的内容重新渲染
          const option = safeParseEChartsOption(lastRenderedCode.current);
          if (option) {
            renderChart(option);
          }
        }
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => observer.disconnect();
  }, [renderChart]);

  // 容器大小变化时自适应
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver(() => {
      chartInstanceRef.current?.resize();
    });
    observer.observe(containerRef.current);

    return () => observer.disconnect();
  }, [tableFallback]);

  // 组件卸载时销毁图表实例
  useEffect(() => {
    return () => {
      chartInstanceRef.current?.dispose();
      chartInstanceRef.current = null;
    };
  }, []);

  const tableRowStyle = tableFallback
    ? ({
        '--echarts-table-row-height': `${String(tableFallback.rowHeight)}px`,
      } as CSSProperties)
    : undefined;

  return (
    <div className={styles.wrapper}>
      {tableFallback ? (
        <div className={styles.tableFallback} style={tableRowStyle}>
          {tableFallback.title && <div className={styles.tableTitle}>{tableFallback.title}</div>}
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {tableFallback.headers.map((header, index) => (
                    <th
                      key={`${header}-${String(index)}`}
                      className={tableFallback.headerBold ? styles.tableHeaderBold : undefined}
                      scope="col"
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableFallback.rows.map((row, rowIndex) => (
                  <tr key={String(rowIndex)}>
                    {tableFallback.headers.map((_, cellIndex) => (
                      <td key={String(cellIndex)}>{row[cellIndex] ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div ref={containerRef} className={styles.container} />
      )}
      {!hasRendered && (
        <div className={styles.placeholder}>
          <span className={styles.placeholderText}>{t('file.chartWaiting')}</span>
        </div>
      )}
    </div>
  );
});
