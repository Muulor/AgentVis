/**
 * cronExpression - Cron 表达式解析器
 *
 * 支持标准五段格式：分 时 日 月 周
 * 格式：minute hour dayOfMonth month dayOfWeek
 *
 * 支持的语法：
 * - 数字：0-59, 0-23, 1-31, 1-12, 0-6
 * - 通配符：*
 * - 列表：1,3,5
 * - 范围：1-5
 * - 步进：星号/2, 1-10/3（每2单位、1到10每3单位）
 */

import { getLogger } from '@services/logger';

const logger = getLogger('cronExpression');

/**
 * 解析单个 cron 字段为匹配值集合
 *
 * @param field - cron 字段字符串（如 "*", "1,3,5", "0-23/2"）
 * @param min - 该字段最小值
 * @param max - 该字段最大值
 * @returns 匹配的值集合
 */
function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const trimmed = part.trim();

    // 处理步进语法：*/2 或 1-10/3
    const stepMatch = trimmed.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const rangePart = stepMatch[1] ?? '*';
      const step = parseInt(stepMatch[2] ?? '1', 10);

      // 确定步进的起始和结束范围
      let rangeMin = min;
      let rangeMax = max;

      if (rangePart !== '*') {
        const dashMatch = rangePart.match(/^(\d+)-(\d+)$/);
        if (dashMatch) {
          rangeMin = parseInt(dashMatch[1] ?? '0', 10);
          rangeMax = parseInt(dashMatch[2] ?? '0', 10);
        } else {
          rangeMin = parseInt(rangePart, 10);
        }
      }

      for (let i = rangeMin; i <= rangeMax; i += step) {
        values.add(i);
      }
      continue;
    }

    // 通配符：匹配所有值
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) {
        values.add(i);
      }
      continue;
    }

    // 范围：1-5
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1] ?? '0', 10);
      const end = parseInt(rangeMatch[2] ?? '0', 10);
      for (let i = start; i <= end; i++) {
        values.add(i);
      }
      continue;
    }

    // 单个数字
    const num = parseInt(trimmed, 10);
    if (!isNaN(num)) {
      values.add(num);
    }
  }

  return values;
}

/** 解析后的 Cron 表达式 */
interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

/**
 * 解析完整的 Cron 表达式
 *
 * @param expression - 五段格式 cron 表达式
 * @returns 解析结果，解析失败返回 null
 */
export function parseCronExpression(expression: string): ParsedCron | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    logger.warn(`Cron 表达式格式错误（应为5段，实际${fields.length}段）: ${expression}`);
    return null;
  }

  const f0 = fields[0] ?? '*';
  const f1 = fields[1] ?? '*';
  const f2 = fields[2] ?? '*';
  const f3 = fields[3] ?? '*';
  const f4 = fields[4] ?? '*';

  try {
    return {
      minutes: parseField(f0, 0, 59),
      hours: parseField(f1, 0, 23),
      daysOfMonth: parseField(f2, 1, 31),
      months: parseField(f3, 1, 12),
      daysOfWeek: parseField(f4, 0, 6),
    };
  } catch (error) {
    logger.warn(`Cron 表达式解析失败: ${expression}`, error);
    return null;
  }
}

/**
 * 检查当前时间是否匹配 Cron 表达式
 *
 * @param expression - cron 表达式
 * @param now - 当前时间（默认使用系统时间）
 * @returns 是否匹配
 */
export function matchesCronExpression(expression: string, now: Date = new Date()): boolean {
  const parsed = parseCronExpression(expression);
  if (!parsed) return false;

  const minute = now.getMinutes();
  const hour = now.getHours();
  const dayOfMonth = now.getDate();
  // Cron 月份从 1 开始，JS Date.getMonth() 从 0 开始
  const month = now.getMonth() + 1;
  const dayOfWeek = now.getDay();

  return (
    parsed.minutes.has(minute) &&
    parsed.hours.has(hour) &&
    parsed.daysOfMonth.has(dayOfMonth) &&
    parsed.months.has(month) &&
    parsed.daysOfWeek.has(dayOfWeek)
  );
}

/**
 * 计算 Cron 表达式的下一次触发时间
 *
 * 从当前时间开始向前搜索，最多搜索 366 天（覆盖一年周期）
 *
 * @param expression - cron 表达式
 * @param from - 起始时间（默认当前时间）
 * @returns 下次触发时间戳（毫秒），找不到返回 null
 */
export function getNextRunTime(expression: string, from: Date = new Date()): number | null {
  const parsed = parseCronExpression(expression);
  if (!parsed) return null;

  // 从下一分钟开始查找（避免重复触发当前分钟）
  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // 最多搜索 366 天 × 24 小时 × 60 分钟 = 527,040 分钟
  const maxIterations = 366 * 24 * 60;

  for (let i = 0; i < maxIterations; i++) {
    const minute = candidate.getMinutes();
    const hour = candidate.getHours();
    const dayOfMonth = candidate.getDate();
    const month = candidate.getMonth() + 1;
    const dayOfWeek = candidate.getDay();

    if (
      parsed.minutes.has(minute) &&
      parsed.hours.has(hour) &&
      parsed.daysOfMonth.has(dayOfMonth) &&
      parsed.months.has(month) &&
      parsed.daysOfWeek.has(dayOfWeek)
    ) {
      return candidate.getTime();
    }

    // 智能跳跃优化：如果月份不匹配，直接跳到下个月
    if (!parsed.months.has(month)) {
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    // 如果日期不匹配且星期不匹配，跳到下一天
    if (!parsed.daysOfMonth.has(dayOfMonth) || !parsed.daysOfWeek.has(dayOfWeek)) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    // 如果小时不匹配，跳到下一个小时
    if (!parsed.hours.has(hour)) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }

    // 分钟不匹配，跳到下一分钟
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}

/**
 * 将 Cron 表达式转为人类可读描述
 *
 * @param expression - cron 表达式
 * @returns 可读描述（如 "每天 09:00"）
 */
export type CronDescriptionLanguage = 'zh-CN' | 'en-US';

export function describeCronExpression(
  expression: string,
  language: CronDescriptionLanguage = 'zh-CN'
): string {
  const isEnglish = language === 'en-US';
  const parsed = parseCronExpression(expression);
  if (!parsed) return isEnglish ? 'Invalid expression' : '\u65e0\u6548\u7684\u8868\u8fbe\u5f0f';

  const fields = expression.trim().split(/\s+/);
  const minField = fields[0] ?? '*';
  const hourField = fields[1] ?? '*';
  const domField = fields[2] ?? '*';
  const monField = fields[3] ?? '*';
  const dowField = fields[4] ?? '*';

  // 每分钟执行
  if (expression.trim() === '* * * * *') {
    return isEnglish ? 'Every minute' : '\u6bcf\u5206\u949f';
  }

  // 每小时执行
  if (
    minField !== '*' &&
    hourField === '*' &&
    domField === '*' &&
    monField === '*' &&
    dowField === '*'
  ) {
    return isEnglish
      ? `At minute ${minField} every hour`
      : `\u6bcf\u5c0f\u65f6\u7684\u7b2c ${minField} \u5206\u949f`;
  }

  // 每天某时某分
  if (
    minField !== '*' &&
    hourField !== '*' &&
    domField === '*' &&
    monField === '*' &&
    dowField === '*'
  ) {
    const minutes = Array.from(parsed.minutes).sort((a, b) => a - b);
    const hours = Array.from(parsed.hours).sort((a, b) => a - b);
    const timeStr = hours
      .map((h) =>
        minutes.map((m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`).join(', ')
      )
      .join(', ');
    return isEnglish ? `Every day at ${timeStr}` : `\u6bcf\u5929 ${timeStr}`;
  }

  // 特定星期几
  if (dowField !== '*' && domField === '*' && monField === '*') {
    const dayNames = isEnglish
      ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      : ['\u65e5', '\u4e00', '\u4e8c', '\u4e09', '\u56db', '\u4e94', '\u516d'];
    const days = Array.from(parsed.daysOfWeek).sort((a, b) => a - b);
    const dayStr = isEnglish
      ? days.map((d) => dayNames[d]).join(', ')
      : days.map((d) => `\u5468${dayNames[d] ?? d}`).join('\u3001');
    const minutes = Array.from(parsed.minutes).sort((a, b) => a - b);
    const hours = Array.from(parsed.hours).sort((a, b) => a - b);
    const timeStr = hours
      .map((h) =>
        minutes.map((m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`).join(', ')
      )
      .join(', ');
    return isEnglish ? `Every ${dayStr} at ${timeStr}` : `\u6bcf${dayStr} ${timeStr}`;
  }

  // 指定月日 + 时间（如 "30 22 13 3 *" → "3月13日 22:30"）
  if (
    monField !== '*' &&
    domField !== '*' &&
    minField !== '*' &&
    hourField !== '*' &&
    dowField === '*'
  ) {
    const minutes = Array.from(parsed.minutes).sort((a, b) => a - b);
    const hours = Array.from(parsed.hours).sort((a, b) => a - b);
    const timeStr = hours
      .map((h) =>
        minutes.map((m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`).join(', ')
      )
      .join(', ');
    return isEnglish
      ? `On ${monField}/${domField} at ${timeStr}`
      : `${monField}\u6708${domField}\u65e5 ${timeStr}`;
  }

  // 每月某日 + 时间（如 "0 9 15 * *" → "每月15日 09:00"）
  if (
    domField !== '*' &&
    monField === '*' &&
    minField !== '*' &&
    hourField !== '*' &&
    dowField === '*'
  ) {
    const minutes = Array.from(parsed.minutes).sort((a, b) => a - b);
    const hours = Array.from(parsed.hours).sort((a, b) => a - b);
    const timeStr = hours
      .map((h) =>
        minutes.map((m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`).join(', ')
      )
      .join(', ');
    return isEnglish
      ? `Every month on day ${domField} at ${timeStr}`
      : `\u6bcf\u6708${domField}\u65e5 ${timeStr}`;
  }

  // 通用 fallback：按人类可读时间顺序（月→日→周→时→分）
  const labelMap: Array<[string, string]> = [
    [monField, isEnglish ? 'month' : '\u6708'],
    [domField, isEnglish ? 'day' : '\u65e5'],
    [dowField, isEnglish ? 'weekday' : '\u5468'],
    [hourField, isEnglish ? 'hour' : '\u65f6'],
    [minField, isEnglish ? 'minute' : '\u5206'],
  ];
  const parts = labelMap.filter(([val]) => val !== '*').map(([val, label]) => `${label}: ${val}`);
  return parts.join(', ') || (isEnglish ? 'Every minute' : '\u6bcf\u5206\u949f');
}

/**
 * 验证 Cron 表达式是否有效
 *
 * @param expression - cron 表达式
 * @returns 是否有效
 */
export function isValidCronExpression(expression: string): boolean {
  return parseCronExpression(expression) !== null;
}

// ==================== 友好调度配置 ====================

/** 调度频率类型 */
export type ScheduleFrequency =
  | 'every_n_minutes' // 每 N 分钟
  | 'hourly' // 每小时
  | 'daily' // 每天
  | 'weekly' // 每周
  | 'monthly' // 每月
  | 'specific'; // 指定时间（一次性）

/** 友好的调度配置（UI 表单 ↔ cron 双向映射） */
export interface ScheduleConfig {
  frequency: ScheduleFrequency;
  /** 分钟（0-59），用于 hourly/daily/weekly/monthly/specific */
  minute: number;
  /** 小时（0-23），用于 daily/weekly/monthly/specific */
  hour: number;
  /** 星期几（0-6, 0=日），用于 weekly */
  dayOfWeek: number;
  /** 日（1-31），用于 monthly/specific */
  dayOfMonth: number;
  /** 月（1-12），用于 specific */
  month: number;
  /** 每 N 分钟的间隔，用于 every_n_minutes */
  intervalMinutes: number;
  /** 执行一次后自动关闭 */
  autoDisable: boolean;
}

/** 默认调度配置 */
export const DEFAULT_SCHEDULE_CONFIG: ScheduleConfig = {
  frequency: 'daily',
  minute: 0,
  hour: 9,
  dayOfWeek: 1,
  dayOfMonth: 1,
  month: 1,
  intervalMinutes: 30,
  autoDisable: false,
};

/**
 * 将友好调度配置转换为 Cron 表达式
 *
 * @param config - 调度配置
 * @returns 有效的 5 段 cron 表达式
 */
export function buildCronExpression(config: ScheduleConfig): string {
  switch (config.frequency) {
    case 'every_n_minutes':
      // */N * * * *
      return `*/${config.intervalMinutes} * * * *`;

    case 'hourly':
      // M * * * *
      return `${config.minute} * * * *`;

    case 'daily':
      // M H * * *
      return `${config.minute} ${config.hour} * * *`;

    case 'weekly':
      // M H * * W
      return `${config.minute} ${config.hour} * * ${config.dayOfWeek}`;

    case 'monthly':
      // M H D * *
      return `${config.minute} ${config.hour} ${config.dayOfMonth} * *`;

    case 'specific':
      // M H D Mo * （指定月日时分）
      return `${config.minute} ${config.hour} ${config.dayOfMonth} ${config.month} *`;

    default:
      return '0 9 * * *';
  }
}

/**
 * 尝试将 Cron 表达式解析回 ScheduleConfig
 *
 * 如果表达式不匹配已知频率模式，返回 null（需使用高级模式）
 *
 * @param expression - cron 表达式
 * @returns 调度配置或 null
 */
export function parseScheduleConfig(expression: string): ScheduleConfig | null {
  const parsed = parseCronExpression(expression);
  if (!parsed) return null;

  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minField, hourField, domField, monField, dowField] = fields;

  // 每 N 分钟: */N * * * *
  const intervalMatch = minField?.match(/^\*\/(\d+)$/);
  if (
    intervalMatch &&
    hourField === '*' &&
    domField === '*' &&
    monField === '*' &&
    dowField === '*'
  ) {
    return {
      ...DEFAULT_SCHEDULE_CONFIG,
      frequency: 'every_n_minutes',
      intervalMinutes: parseInt(intervalMatch[1] ?? '30', 10),
    };
  }

  // 每分钟: * * * * *
  if (
    minField === '*' &&
    hourField === '*' &&
    domField === '*' &&
    monField === '*' &&
    dowField === '*'
  ) {
    return {
      ...DEFAULT_SCHEDULE_CONFIG,
      frequency: 'every_n_minutes',
      intervalMinutes: 1,
    };
  }

  // 解析具体数值
  const min = parseInt(minField ?? '0', 10);
  const hour = parseInt(hourField ?? '0', 10);
  const dom = parseInt(domField ?? '1', 10);
  const mon = parseInt(monField ?? '1', 10);
  const dow = parseInt(dowField ?? '0', 10);

  // 每小时: N * * * *
  if (
    !isNaN(min) &&
    hourField === '*' &&
    domField === '*' &&
    monField === '*' &&
    dowField === '*'
  ) {
    return { ...DEFAULT_SCHEDULE_CONFIG, frequency: 'hourly', minute: min };
  }

  // 每天: N N * * *
  if (!isNaN(min) && !isNaN(hour) && domField === '*' && monField === '*' && dowField === '*') {
    return { ...DEFAULT_SCHEDULE_CONFIG, frequency: 'daily', minute: min, hour };
  }

  // 每周: N N * * N
  if (!isNaN(min) && !isNaN(hour) && domField === '*' && monField === '*' && !isNaN(dow)) {
    return { ...DEFAULT_SCHEDULE_CONFIG, frequency: 'weekly', minute: min, hour, dayOfWeek: dow };
  }

  // 每月: N N N * *
  if (!isNaN(min) && !isNaN(hour) && !isNaN(dom) && monField === '*' && dowField === '*') {
    return { ...DEFAULT_SCHEDULE_CONFIG, frequency: 'monthly', minute: min, hour, dayOfMonth: dom };
  }

  // 指定时间: N N N N *
  if (!isNaN(min) && !isNaN(hour) && !isNaN(dom) && !isNaN(mon) && dowField === '*') {
    return {
      ...DEFAULT_SCHEDULE_CONFIG,
      frequency: 'specific',
      minute: min,
      hour,
      dayOfMonth: dom,
      month: mon,
      autoDisable: true,
    };
  }

  // 无法匹配已知模式
  return null;
}
