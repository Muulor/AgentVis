/**
 * Memory UI 组件类型定义
 * 
 * 提供记忆系统 UI 组件所需的类型定义，与 services/memory/types.ts 区分，
 * 这里的类型主要用于 UI 展示层。
 */

import type { LongTermFactCategory } from '@services/memory/types';

// ==================== 组件 Props ====================

/** MemoryPanel 组件 Props */
export interface MemoryPanelProps {
    /** Agent ID */
    agentId: string;
    /** Hub ID（用于隔离提示） */
    hubId?: string;
}

/** ShortTermView 组件 Props */
export interface ShortTermViewProps {
    /** Agent ID */
    agentId: string;
    /** 跳转到消息的回调 */
    onJumpToMessage?: (messageId: string) => void;
}

/** SummaryView 组件 Props */
export interface SummaryViewProps {
    /** Agent ID */
    agentId: string;
}

/** FactsView 组件 Props */
export interface FactsViewProps {
    /** Agent ID */
    agentId: string;
}

/** FactCard 组件 Props */
export interface FactCardProps {
    /** 事实 ID */
    id: string;
    /** 事实内容 */
    content: string;
    /** 事实类别 */
    category: LongTermFactCategory;
    /** 来源消息 ID */
    sourceMessageId?: string;
    /** 来源轮次描述 */
    sourceDescription?: string;
    /** 创建时间 */
    createdAt: number;
    /** 编辑回调 */
    onEdit?: (id: string) => void;
    /** 删除回调 */
    onDelete?: (id: string) => void;
    /** 跳转回调 */
    onJump?: (messageId: string) => void;
}

/** FactEditModal 组件 Props */
export interface FactEditModalProps {
    /** 是否显示 */
    isOpen: boolean;
    /** 弹窗模式 */
    mode?: 'create' | 'edit';
    /** 事实 ID */
    factId: string | null;
    /** 初始内容 */
    initialContent?: string;
    /** 初始类别 */
    initialCategory?: LongTermFactCategory;
    /** 来源描述 */
    sourceDescription?: string;
    /** 关闭回调 */
    onClose: () => void;
    /** 保存回调 */
    onSave: (id: string | null, content: string, category: LongTermFactCategory) => Promise<void>;
    /** 跳转回调 */
    onJump?: (messageId: string) => void;
}

/** WatermarkIndicator 组件 Props */
export interface WatermarkIndicatorProps {
    /** 当前轮次 */
    current: number;
    /** 总容量（轮次） */
    total: number;
    /** 水位线阈值（0-1） */
    threshold?: number;
    /** 是否正在整理 */
    isOrganizing?: boolean;
}

// ==================== 数据类型 ====================

/** 短期缓冲消息项（用于 UI 展示） */
export interface ShortTermMessageItem {
    /** 消息 ID（memory 表的 ID） */
    id: string;
    /** 原始消息 ID（message 表的 ID，用于跳转） */
    sourceMessageId?: string;
    /** 角色 */
    role: 'user' | 'assistant';
    /** 内容摘要（截断显示） */
    contentPreview: string;
    /** 完整内容 */
    content: string;
    /** 轮次编号 */
    turnNumber: number;
    /** 时间戳 */
    timestamp: number;
}

/** 摘要项（用于 UI 展示） */
export interface SummaryItem {
    /** 摘要 ID */
    id: string;
    /** 摘要内容 */
    content: string;
    /** 覆盖范围起始轮 */
    turnStart: number;
    /** 覆盖范围结束轮 */
    turnEnd: number;
    /** 重要性（高/中/低） */
    importance: 'high' | 'medium' | 'low';
    /** 来源消息 ID 列表（逗号分隔，用于展开原文） */
    sourceMessageIds?: string;
    /** 原始消息内容（展开时显示） */
    originalMessages?: Array<{
        turnNumber: number;
        role: 'user' | 'assistant';
        content: string;
    }>;
    /** 创建时间 */
    createdAt: number;

    // ==================== 状态字段（LLM 生成，从 metadataJson 解析） ====================

    /** 已确认的结论或决策 */
    confirmedDecisions?: string[];
    /** 待决问题（简化版，仅用于 UI 展示） */
    openQuestions?: Array<{ question: string; scope?: string }>;
    /** 已失效的观点 */
    invalidatedPoints?: string[];
}

/** 事实项（用于 UI 展示） */
export interface FactItem {
    /** 事实 ID */
    id: string;
    /** 事实内容 */
    content: string;
    /** 事实类别 */
    category: LongTermFactCategory;
    /** 来源消息 ID */
    sourceMessageId?: string;
    /** 来源轮次描述（如「第 5 轮对话」） */
    sourceDescription?: string;
    /** 创建时间 */
    createdAt: number;
    /** 更新时间 */
    updatedAt: number;
}

// ==================== 类别样式映射 ====================

/** 类别显示配置 */
export interface CategoryDisplayConfig {
    /** 标签颜色（文字） */
    color: string;
    /** 背景色（15% 透明度） */
    bgColor: string;
}

/**
 * 类别样式映射表
 * 
 * 通用用户事实（前四类）+ 交互信号 + 任务经验
 */
export const CATEGORY_DISPLAY_MAP: Record<LongTermFactCategory, CategoryDisplayConfig> = {
    identity_role: {
        color: '#16A34A',
        bgColor: 'rgba(22, 163, 74, 0.15)',
    },
    preference_style: {
        color: '#2563EB',
        bgColor: 'rgba(37, 99, 235, 0.15)',
    },
    long_term_goal: {
        color: '#EA580C',
        bgColor: 'rgba(234, 88, 12, 0.15)',
    },
    knowledge_level: {
        color: '#0891B2',
        bgColor: 'rgba(8, 145, 178, 0.15)',
    },
    interaction_signals: {
        color: '#6B7280',
        bgColor: 'rgba(107, 114, 128, 0.15)',
    },
    task_experience: {
        color: '#7C3AED',
        bgColor: 'rgba(124, 58, 237, 0.15)',
    },
};

/** 所有类别选项（用于下拉选择） */
export const CATEGORY_OPTIONS: Array<{ value: LongTermFactCategory }> = [
    { value: 'identity_role' },
    { value: 'preference_style' },
    { value: 'long_term_goal' },
    { value: 'knowledge_level' },
    { value: 'interaction_signals' },
    { value: 'task_experience' },
];

// ==================== 记忆标签类型 ====================

/** 记忆面板标签类型 */
export type MemoryTabId = 'short_term' | 'summary' | 'facts';

/** 标签配置 */
export const MEMORY_TABS: Array<{ id: MemoryTabId }> = [
    { id: 'short_term' },
    { id: 'summary' },
    { id: 'facts' },
];
