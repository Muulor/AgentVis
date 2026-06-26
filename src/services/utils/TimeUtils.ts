/**
 * TimeUtils - 时间感知工具模块
 * 
 * 提供统一的时间格式化函数，用于在 Agent 框架各层注入时间信息。
 * 
 * 设计原则：
 * - 使用 ISO 8601 格式作为模型输入（模型解析最稳定）
 * - 人类可读格式用于记忆/历史展示
 * - 相对时间用于辅助模型判断信息时效性
 */

// ============================================================================
// 星期映射
// ============================================================================

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

// ============================================================================
// 核心函数
// ============================================================================

/**
 * 获取当前时间的 ISO 8601 格式字符串（含时区偏移）
 * 
 * 使用本地时区，输出格式如：2026-03-08T16:18:06+08:00
 * 该格式是大模型解析最稳定的时间表示方式。
 */
export function getCurrentTimeISO(): string {
    const now = new Date();
    const tzOffset = -now.getTimezoneOffset();
    const sign = tzOffset >= 0 ? '+' : '-';
    const absOffset = Math.abs(tzOffset);
    const hours = String(Math.floor(absOffset / 60)).padStart(2, '0');
    const minutes = String(absOffset % 60).padStart(2, '0');

    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const sec = String(now.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day}T${hour}:${min}:${sec}${sign}${hours}:${minutes}`;
}

/**
 * 构建当前时间注入 prompt 片段
 * 
 * 输出格式示例：
 * ```
 * 当前时间: 2026-03-08T16:18:06+08:00 (星期日)
 * ```
 * 
 * 包含 ISO 时间和星期，让模型能感知当前时刻和工作日/周末上下文。
 */
export function buildCurrentTimePrompt(): string {
    const isoTime = getCurrentTimeISO();
    const weekday = WEEKDAY_NAMES[new Date().getDay()];
    return `Current time: ${isoTime} (${weekday ?? 'Unknown'})`;
}

/**
 * 格式化 Unix 时间戳为人类可读的日期时间
 * 
 * 输出格式：2026-03-08 16:18
 * 精确到分钟，兼顾可读性和信息密度。
 * 
 * @param timestamp - Unix 时间戳（毫秒）
 * @returns 格式化的日期时间字符串
 */
export function formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);

    // 防御无效时间戳
    if (isNaN(date.getTime())) {
        return 'Unknown time';
    }

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');

    return `${year}-${month}-${day} ${hour}:${min}`;
}

/**
 * 计算时间差描述（相对时间）
 * 
 * 用于事实/记忆条目的时效性标注，让模型能快速判断信息新旧程度。
 * 
 * 输出示例：
 * - "刚刚"（< 1 分钟）
 * - "5分钟前"
 * - "2小时前"
 * - "3天前"
 * - "2周前"
 * - "3个月前"
 * - "1年前"
 * 
 * @param timestamp - Unix 时间戳（毫秒）
 * @returns 相对时间描述
 */
export function formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diffMs = now - timestamp;

    // 防御未来时间或无效时间戳
    if (diffMs < 0 || isNaN(diffMs)) {
        return 'Unknown time';
    }

    const MINUTE = 60 * 1000;
    const HOUR = 60 * MINUTE;
    const DAY = 24 * HOUR;
    const WEEK = 7 * DAY;
    const MONTH = 30 * DAY;
    const YEAR = 365 * DAY;

    if (diffMs < MINUTE) {
        return 'just now';
    }
    if (diffMs < HOUR) {
        const minutes = Math.floor(diffMs / MINUTE);
        return formatUnitAgo(minutes, 'minute');
    }
    if (diffMs < DAY) {
        const hours = Math.floor(diffMs / HOUR);
        return formatUnitAgo(hours, 'hour');
    }
    if (diffMs < WEEK) {
        const days = Math.floor(diffMs / DAY);
        return formatUnitAgo(days, 'day');
    }
    if (diffMs < MONTH) {
        const weeks = Math.floor(diffMs / WEEK);
        return formatUnitAgo(weeks, 'week');
    }
    if (diffMs < YEAR) {
        const months = Math.floor(diffMs / MONTH);
        return formatUnitAgo(months, 'month');
    }

    const years = Math.floor(diffMs / YEAR);
    return formatUnitAgo(years, 'year');
}

function formatUnitAgo(value: number, unit: string): string {
    return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}
