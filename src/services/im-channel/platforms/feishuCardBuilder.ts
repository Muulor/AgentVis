/**
 * feishuCardBuilder - 飞书消息卡片构建器
 *
 * 将平台无关的 ImCardContent 转换为飞书消息卡片 JSON 格式，
 * 并提供预定义的进度/结果/错误卡片模板。
 *
 * 飞书卡片文档参考：
 * - 消息卡片总览：https://open.feishu.cn/document/ukTMukTMukTM/uczM3QjL3MzN04yNzcDN
 * - 交互式卡片：https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-components
 */

import type { ImCardContent, ImCardSection, ImCardAction } from '../types';
import { translate } from '@/i18n';

// ============================================================================
// 颜色映射
// ============================================================================

/** 卡片主题色到飞书 header template 的映射 */
const COLOR_MAP: Record<string, string> = {
  blue: 'blue',
  green: 'green',
  red: 'red',
  orange: 'orange',
  grey: 'grey',
};

// ============================================================================
// Markdown 表格解析与飞书原生 table 元素转换
// ============================================================================

/**
 * 解析单行表格行，返回各列文本（已去除首尾 | 和空白）
 *
 */
function parseTableRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, '') // 去掉首尾的 |
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * 判断是否是表格分隔行（`|---|---|` 格式）
 *
 * 标准 GFM 分隔行：每格只含 `-`、`:` 和空格
 */
function isTableSeparatorRow(line: string): boolean {
  const normalized = line.replace(/^\||\|$/g, '');
  return normalized.split('|').every((cell) => /^[\s:-]+$/.test(cell));
}

/**
 * 判断是否是表格行（以 `|` 开头且包含至少一个后续 `|`）
 */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.includes('|', 1);
}

/**
 * 将 Markdown 表格（表头行 + 分隔行 + 数据行）转换为飞书原生 table 元素
 *
 * 飞书 table element 结构（卡片 JSON v1 官方文档）：
 * ```json
 * {
 *   "tag": "table",
 *   "page_size": 10,
 *   "header_style": { "background_style": "grey", "bold": true, ... },
 *   "columns": [{ "name": "col0", "display_name": "列名", "data_type": "text", "width": "auto" }],
 *   "rows": [{ "col0": "单元格文本" }]
 * }
 * ```
 *
 * 重要约束（验证自飞书官方文档）：
 * - width: String 类型，如 "auto" / "120px"，不能是 number
 * - header_style: Object 类型，不能是字符串
 * - rows 单元格：data_type='text' 时直接是字符串值，不能是对象
 * - page_size: 取值范围 [1,10]
 *
 * @param headerCells - 表头列名列表
 * @param dataRows    - 数据行（每行为列值数组，与 headerCells 等长）
 */
function buildFeishuTableElement(
  headerCells: string[],
  dataRows: string[][]
): Record<string, unknown> {
  // 根据飞书官方文档（表格组件 JSON 1.0）：
  //
  // columns[].width: String 类型，取值为 "auto" 或 "120px" 形式的字符串，
  //   不能传 number（数字类型会导致 code=230099 parse error）。
  //
  // header_style: Object 类型（含 background_style/bold/text_color 等子字段），
  //   不能传简单字符串 'grey'。
  //
  // rows[].colN: data_type 为 text 时，单元格直接是字符串值，
  //   不能包裹成 { tag: 'plain_text', content: '...' } 对象。
  //
  // page_size: Number，取值范围 [1, 10]，不允许超过 10。

  // 根据列数自动选择合适列宽，列多时用 auto 避免溢出
  const colWidth = headerCells.length <= 3 ? '120px' : 'auto';
  const columns = headerCells.map((header, idx) => ({
    name: `col${idx}`,
    display_name: header,
    data_type: 'text', // 明确声明 text 类型，确保兼容性
    width: colWidth,
  }));

  // data_type: 'text' 的行数据直接用字符串，不能包裹为对象
  // 若某行实际列数少于表头，缺失列填空字符串，避免飞书渲染报错
  const rows = dataRows.map((cells) => {
    const row: Record<string, string> = {};
    headerCells.forEach((_, idx) => {
      row[`col${idx}`] = cells[idx] ?? '';
    });
    return row;
  });

  return {
    tag: 'table',
    // header_style 必须是对象，不能是字符串（文档确认的结构）
    header_style: {
      text_align: 'left',
      text_size: 'normal',
      background_style: 'grey',
      text_color: 'grey',
      bold: true,
      lines: 1,
    },
    // page_size 取值范围 [1, 10]，超出范围会导致解析报错
    page_size: 10,
    columns,
    rows,
  };
}

/**
 * 将一段文本内容拆分为飞书卡片 elements 数组
 *
 * 处理逻辑：
 * 1. 逐行扫描，识别连续的 Markdown 表格块（表头 + 分隔行 + 数据行）
 * 2. 表格块 → buildFeishuTableElement 生成飞书原生 table element
 * 3. 非表格文本 → 合并为 lark_md element，保持原有换行结构
 * 4. 保证输出 elements 顺序与原文一致
 *
 * 支持混排场景：
 * ```
 * 普通文本段落
 *
 * | 列1 | 列2 |
 * |-----|-----|
 * | A   | B   |
 *
 * 另一段普通文本
 * ```
 * → [lark_md("普通文本"), table(…), lark_md("另一段普通文本")]
 *
 * @param content - section.content 原始字符串（可能含多段表格与普通文本混排）
 */
function renderContentElements(content: string): Record<string, unknown>[] {
  const lines = content.split('\n');
  const elements: Record<string, unknown>[] = [];

  // 临时缓冲区，积累非表格文本行
  let textBuffer: string[] = [];
  let i = 0;

  /**
   * 将缓冲区中的文本行刷新为一个 lark_md element（空缓冲区时跳过）
   *
   * 使用飞书 card v1 标准的 div + lark_md 嵌套格式：
   * { tag: 'div', text: { tag: 'lark_md', content: '...' } }
   * 而非直接 { tag: 'markdown', content: '...' }。
   * 手机端对 element tag 校验更严格，div+lark_md 是 v1 格式的权威写法，
   * 桌面端两者均可渲染，但手机端 'markdown' tag 可能导致空白显示。
   */
  const flushTextBuffer = () => {
    const text = textBuffer.join('\n').trim();
    if (text) {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: text } });
    }
    textBuffer = [];
  };

  while (i < lines.length) {
    // 边界检查保证 lines[i] 不为 undefined，断言安全
    const line = lines[i];
    if (line === undefined) break;
    const nextLine = lines[i + 1];

    // 识别表格起始：当前行是表格行，且紧接下一行是分隔行（标准 GFM 格式）
    if (
      isTableRow(line) &&
      i + 1 < lines.length &&
      // i + 1 < lines.length 已验证，断言安全
      nextLine !== undefined &&
      isTableSeparatorRow(nextLine)
    ) {
      // 先将之前积累的普通文本刷出
      flushTextBuffer();

      // 解析表头行，跳过分隔行
      const headerCells = parseTableRow(line);
      i += 2;

      // 持续读取后续连续的数据行
      const dataRows: string[][] = [];
      while (i < lines.length) {
        // i < lines.length 已验证，断言安全
        const dataLine = lines[i];
        if (dataLine === undefined || !isTableRow(dataLine)) break;
        dataRows.push(parseTableRow(dataLine));
        i++;
      }

      // 有效表格（表头 + 至少一行数据）→ 生成飞书 table element
      // 否则降级为纯文本（兜底逻辑，正常不触发）
      if (headerCells.length > 0 && dataRows.length > 0) {
        elements.push(buildFeishuTableElement(headerCells, dataRows));
      } else {
        textBuffer.push(line);
      }
    } else {
      // 普通文本行，累积到缓冲区
      textBuffer.push(line);
      i++;
    }
  }

  // 处理末尾残余文本
  flushTextBuffer();

  return elements;
}

// ============================================================================
// 核心转换函数
// ============================================================================

/**
 * 构建卡片 elements 数组（通用骨架）
 *
 * 将 ImCardContent.sections 转换为 elements，header/actions/hr 逻辑统一在此。
 * renderSectionContent 决定 section.content 如何渲染（完整版 vs 纯文本版）。
 *
 * @param card               - 卡片内容
 * @param renderSectionContent - 将 section.content 转为 element 数组的渲染策略
 */
function buildCardElements(
  card: ImCardContent,
  renderSectionContent: (content: string) => Record<string, unknown>[]
): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [];
  const actions = getFeishuVisibleActions(card.actions);

  for (const section of card.sections) {
    if (section.header) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `**${section.header}**` },
      });
    }
    elements.push(...renderSectionContent(section.content));
    elements.push({ tag: 'hr' });
  }

  // 去掉末尾多余分割线
  if (elements.length > 0 && (elements[elements.length - 1] as { tag: string }).tag === 'hr') {
    elements.pop();
  }

  if (actions.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'action',
      actions: actions.map(buildFeishuButton),
    });
  }

  return elements;
}

function getFeishuVisibleActions(actions?: ImCardAction[]): ImCardAction[] {
  return actions?.filter((action) => action.actionId !== 'delete_message') ?? [];
}

/**
 * 构建飞书卡片 header 对象（共用逻辑）
 */
function buildCardHeader(card: ImCardContent): Record<string, unknown> {
  return {
    title: { tag: 'plain_text', content: card.title },
    template: COLOR_MAP[card.color ?? 'blue'] ?? 'blue',
  };
}

/**
 * 将平台无关的 ImCardContent 转换为飞书消息卡片 JSON（完整版，含 table 转换）
 *
 * 当 section.content 中检测到 Markdown 表格时，会将其转换为飞书原生 table element。
 * 若飞书 API 解析此卡片失败（code=230099），上层调用者应改用 buildFeishuCardTextOnly 重试。
 *
 * @param card - 平台无关的卡片内容
 * @returns 飞书卡片 JSON 对象（可直接作为 msg_type=interactive 的 content）
 */
export function buildFeishuCard(card: ImCardContent): Record<string, unknown> {
  return {
    config: { update_multi: true },
    header: buildCardHeader(card),
    elements: buildCardElements(card, renderContentElements),
  };
}

/**
 * 将 ImCardContent 转换为纯文本飞书卡片 JSON（fallback 版，无 table element）
 *
 * 与 buildFeishuCard 使用相同的 header/actions/hr 结构，
 * 但 section.content 全部渲染为 div+lark_md，不做 Markdown 表格转换。
 * 飞书 lark_md 支持部分 markdown 语法，表格会以等宽文本形式展示。
 *
 * 适用场景：buildFeishuCard 发送后飞书 API 返回解析错误（code=230099）时的降级重试。
 *
 * @param card - 平台无关的卡片内容
 * @returns 不含 table element 的飞书卡片 JSON
 */
export function buildFeishuCardTextOnly(card: ImCardContent): Record<string, unknown> {
  // 将 section.content 直接作为 lark_md 渲染，不解析 Markdown 表格
  const renderAsText = (content: string): Record<string, unknown>[] => {
    const text = content.trim();
    if (!text) return [];
    return [{ tag: 'div', text: { tag: 'lark_md', content: text } }];
  };

  return {
    config: { update_multi: true },
    header: buildCardHeader(card),
    elements: buildCardElements(card, renderAsText),
  };
}

/**
 * 构建飞书按钮元素
 */
function buildFeishuButton(action: ImCardAction): Record<string, unknown> {
  const typeMap: Record<string, string> = {
    primary: 'primary',
    danger: 'danger',
    default: 'default',
  };

  return {
    tag: 'button',
    text: {
      tag: 'plain_text',
      content: action.text,
    },
    type: typeMap[action.style] ?? 'default',
    value: {
      action_id: action.actionId,
      ...(action.value ?? {}),
    },
  };
}

// ============================================================================
// 预定义卡片模板
// ============================================================================

/**
 * 构建任务进度卡片
 *
 * 展示 Agent 执行的实时状态：FSM 阶段、思维链、Sub-Agent 状态。
 * 底部有"终止"按钮，用户点击后通过卡片回调终止任务。
 *
 * @param taskId - 任务 ID
 * @param agentName - Agent 名称
 * @param fsmState - 当前 FSM 状态
 * @param thinkingSteps - 思维链步骤列表
 * @param subAgentStatus - Sub-Agent 执行状态文本
 * @param iterationInfo - 迭代信息（当前/总预算）
 */
export function buildProgressCard(params: {
  taskId: string;
  agentName: string;
  fsmState: string;
  thinkingSteps: string[];
  subAgentStatus?: string;
  /** Sub-Agent 执行步骤详情列表 */
  subAgentSteps?: Array<{ step: number; tool: string; target: string; success?: boolean }>;
  iterationInfo?: string;
}): ImCardContent {
  const sections: ImCardSection[] = [];

  // FSM 状态行
  const stateEmoji = getStateEmoji(params.fsmState);
  sections.push({
    header: translate('im.cards.statusHeader'),
    content: `${stateEmoji} **${params.fsmState}**${params.iterationInfo ? `  (${params.iterationInfo})` : ''}`,
  });

  // 思维链
  if (params.thinkingSteps.length > 0) {
    const stepsText = params.thinkingSteps
      .map((step, index) => {
        // 最后一步用动态图标，之前的用完成图标
        const icon = index < params.thinkingSteps.length - 1 ? '✅' : '🔄';
        return `${icon} ${step}`;
      })
      .join('\n');
    sections.push({
      header: translate('im.cards.thinkingHeader'),
      content: stepsText,
    });
  }

  // Sub-Agent 区块：步骤列表 + 状态
  const subAgentSteps = params.subAgentSteps ?? [];
  const subAgentStatus = params.subAgentStatus;
  const hasSteps = subAgentSteps.length > 0;
  const hasStatus = Boolean(subAgentStatus);
  if (hasSteps || hasStatus) {
    const stepCount = subAgentSteps.length;
    const headerText =
      stepCount > 0
        ? translate('im.cards.subAgentStepsHeader', { count: stepCount })
        : translate('im.cards.subAgentHeader');

    // 构建步骤列表文本
    const lines: string[] = [];
    if (hasSteps) {
      for (const s of subAgentSteps) {
        const toolEmoji = getToolEmoji(s.tool);
        lines.push(`${toolEmoji} ${s.tool} ${s.target}`);
      }
    }
    // 在步骤列表末尾追加当前状态
    if (subAgentStatus && !hasSteps) {
      lines.push(subAgentStatus);
    }

    sections.push({
      header: headerText,
      content: lines.join('\n'),
    });
  }

  // 添加停止提示（飞书 WebSocket 模式不支持卡片按钮回调，改用文本指令）
  sections.push({
    content: translate('im.cards.stopHint'),
  });

  return {
    title: translate('im.cards.runningTitle', { agentName: params.agentName }),
    sections,
    color: 'blue',
  };
}

/**
 * 构建任务完成卡片
 */
export function buildCompletionCard(params: {
  agentName: string;
  result: string;
  duration: number;
  iterationCount: number;
}): ImCardContent {
  const durationText = formatDuration(params.duration);

  return {
    title: translate('im.cards.completeTitle', { agentName: params.agentName }),
    sections: [
      {
        header: translate('im.cards.resultHeader'),
        content: params.result,
      },
      {
        content: translate('im.cards.durationMeta', {
          duration: durationText,
          count: params.iterationCount,
        }),
      },
    ],
    color: 'green',
  };
}

/**
 * 构建任务错误卡片
 *
 * 展示任务失败/取消的终态信息。
 * 不包含交互按钮：飞书 WebSocket 模式下卡片按钮点击必须在有效时间内得到回调响应，
 * 否则飞书平台返回 code:200340（无响应错误）。重试的正确方式是用户重新发送消息。
 */
export function buildErrorCard(params: {
  agentName: string;
  error: string;
  taskId: string;
}): ImCardContent {
  return {
    title: translate('im.cards.errorTitle', { agentName: params.agentName }),
    sections: [
      {
        header: translate('im.cards.errorHeader'),
        content: `\`${params.error}\``,
      },
      {
        // 引导用户通过重新发消息来重试，避免用户困惑于无响应的按钮
        content: translate('im.cards.retryHint'),
      },
    ],
    color: 'red',
  };
}

/**
 * 构建初始等待卡片（任务刚创建时）
 */
export function buildPendingCard(agentName: string): ImCardContent {
  return {
    title: translate('im.cards.pendingTitle', { agentName }),
    sections: [
      {
        content: translate('im.cards.pendingContent'),
      },
    ],
    color: 'grey',
  };
}

// ============================================================================
// 工具函数
// ============================================================================

/** 根据 FSM 状态返回对应 emoji */
function getStateEmoji(state: string): string {
  const emojiMap: Record<string, string> = {
    IDLE: '⏸️',
    PREPARE_CONTEXT: '📋',
    MASTER_DECISION: '🤔',
    DISPATCH: '📤',
    OBSERVE: '👁️',
    EVALUATE: '⚖️',
    TERMINATE: '🏁',
  };
  return emojiMap[state] ?? '🔹';
}

/** 根据工具名返回直观的 emoji 前缀 */
function getToolEmoji(tool: string): string {
  const toolEmojiMap: Record<string, string> = {
    web_search: '🔍',
    read: '📖',
    exec: '⚡',
    file_write: '✏️',
    local_search: '🔎',
    cron: '⏰',
    generate_image: '🎨',
  };
  return toolEmojiMap[tool] ?? '🔹';
}

/** 格式化耗时（ms → 可读文本） */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}
