/**
 * AgentSession - 会话管理层
 *
 * 管理 Agent 对话历史、上下文压缩和 Token 预算
 *
 * 核心职责：
 * 1. 维护 AgentMessage[] 对话历史
 * 2. 集成 ContextWindowManager 进行历史压缩
 * 3. 提供统一的上下文准备接口
 */

import type { AgentMessage } from './types';
import { contextWindowManager, type PreparedContext, type ContextLayers } from '../ContextWindowManager';
import { getLogger } from '@services/logger';

const logger = getLogger('AgentSession');

const BINDING_FACT_CATEGORIES = new Set<string>(['identity_role', 'preference_style']);
const CHAT_CONTEXT_EXCLUDED_FACT_CATEGORIES = new Set<string>([
    ...BINDING_FACT_CATEGORIES,
    'task_experience',
]);

/**
 * 生成唯一 ID（使用 Web Crypto API）
 */
function generateId(): string {
    // 优先使用 crypto.randomUUID，回退到 Date.now + random
    const browserCrypto = (globalThis as { crypto?: Crypto }).crypto;
    if (browserCrypto?.randomUUID) {
        return browserCrypto.randomUUID();
    }
    return `session_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}
// ==================== 配置类型 ====================

/**
 * 会话配置
 */
export interface AgentSessionConfig {
    /** Agent ID */
    agentId: string;
    /** 模型 ID（用于计算预算） */
    modelId?: string;
}

/**
 * 运行时上下文（由外部注入）
 */
export interface RuntimeContext {
    /** Agent 自定义规则 */
    agentRules?: string;
    /** 记忆系统事实 */
    facts?: Array<{ id: string; content: string; category?: string }>;
    /** 记忆系统摘要 */
    summaries?: Array<{ id: string; content: string }>;
    /** RAG 检索结果 */
    ragResults?: string;
    /** 引用内容 */
    quotes?: string;
    /** 附件内容 */
    attachments?: string;
}

// ==================== 主类 ====================

/**
 * AgentSession - 会话管理
 *
 * 设计原则：
 * - 单会话单实例，由 AgentService 创建和管理
 * - 会话无状态持久化（重启后重新创建）
 * - Token 预算在会话级别累计
 */
export class AgentSession {
    /** 会话唯一 ID */
    readonly id: string;

    /** 会话配置 */
    private readonly config: AgentSessionConfig;

    /** 对话历史 */
    private messages: AgentMessage[] = [];

    /** 缓存的上下文预处理结果（供 AgentLoop 使用） */
    private lastPreparedContext: PreparedContext | null = null;

    constructor(config: AgentSessionConfig) {
        this.id = generateId();
        this.config = config;
        logger.trace(`[AgentSession] 创建会话: ${this.id}, agentId: ${config.agentId}`);
    }

    /**
     * 获取当前会话使用的模型 ID
     */
    getModelId(): string | undefined {
        return this.config.modelId;
    }

    // ==================== 消息管理 ====================

    /**
     * 添加消息
     */
    addMessage(message: AgentMessage): void {
        this.messages.push(message);
        logger.trace(`[AgentSession] 添加消息: role=${message.role}, length=${message.content.length}`);
    }

    /**
     * 添加用户消息
     */
    addUserMessage(content: string, createdAt?: number): void {
        this.addMessage({ role: 'user', content, createdAt: createdAt ?? Date.now() });
    }

    /**
     * 添加助手消息
     */
    addAssistantMessage(content: string, createdAt?: number): void {
        this.addMessage({ role: 'assistant', content, createdAt: createdAt ?? Date.now() });
    }

    /**
     * 添加工具结果消息
     */
    addToolResultMessage(toolCallId: string, toolName: string, result: string): void {
        this.addMessage({
            role: 'tool',
            content: result,
            toolCallId,
            toolName,
        });
    }

    /**
     * 获取所有消息
     */
    getMessages(): AgentMessage[] {
        return [...this.messages];
    }

    /**
     * 获取消息数量
     */
    getMessageCount(): number {
        return this.messages.length;
    }

    /**
     * 清空消息历史
     */
    clear(): void {
        this.messages = [];
        this.lastPreparedContext = null;
        logger.trace(`[AgentSession] 会话已清空: ${this.id}`);
    }

    /**
     * 清除所有工具消息（轮次隔离）
     *
     * 每轮用户请求开始时调用，清除上一轮的 tool 消息，
     * 只保留 user + assistant 对话历史。
     * 跨轮知识传递由记忆系统（task_experience 等）承担。
     */
    clearToolMessages(): void {
        const before = this.messages.length;
        this.messages = this.messages.filter(msg => msg.role !== 'tool');
        const removed = before - this.messages.length;
        if (removed > 0) {
            logger.trace(
                `[AgentSession] 轮次隔离: 清除 ${removed} 条 tool 消息, 保留 ${this.messages.length} 条`
            );
        }
    }

    // ==================== 上下文准备 ====================

    /**
     * 准备上下文（集成 ContextWindowManager）
     *
     * 核心方法：将会话历史和运行时上下文合并，通过 ContextWindowManager 进行预算管理
     *
     * @param runtimeContext 运行时上下文（记忆、RAG 等）
     * @returns 预处理后的上下文
     */
    async prepareContext(runtimeContext: RuntimeContext = {}): Promise<PreparedContext> {
        // 构建身份层（Layer 1）
        let identityPrompt = runtimeContext.agentRules ?? '';

        // 注入身份/偏好（从记忆系统）
        if (runtimeContext.facts && runtimeContext.facts.length > 0) {
            const bindingFacts = runtimeContext.facts.filter(f =>
                f.category !== undefined && BINDING_FACT_CATEGORIES.has(f.category)
            );
            if (bindingFacts.length > 0) {
                const bindingPrompt = bindingFacts.map(f => `- ${f.content}`).join('\n');
                identityPrompt += `\n\n## User Preferences (must follow)\n${bindingPrompt}`;
            }
        }

        // 构建上下文层（Layer 2）
        const contextLayers: ContextLayers = {};

        // P1: 引用内容
        if (runtimeContext.quotes) {
            contextLayers.quotes = runtimeContext.quotes;
        }

        // P2: RAG 检索结果
        if (runtimeContext.ragResults) {
            contextLayers.ragResults = runtimeContext.ragResults;
        }

        // P3: 附件内容
        if (runtimeContext.attachments) {
            contextLayers.attachments = runtimeContext.attachments;
        }

        // P4: 事实背景（排除已注入 Layer 1 的）
        if (runtimeContext.facts && runtimeContext.facts.length > 0) {
            const contextFacts = runtimeContext.facts.filter(f =>
                f.category === undefined || !CHAT_CONTEXT_EXCLUDED_FACT_CATEGORIES.has(f.category)
            );
            if (contextFacts.length > 0) {
                const factsPrompt = contextFacts.map(f => `- ${f.content}`).join('\n');
                contextLayers.backgroundFacts = `The following facts describe the user:\n${factsPrompt}`;
            }
        }

        // P5: 摘要
        if (runtimeContext.summaries && runtimeContext.summaries.length > 0) {
            const summariesPrompt = runtimeContext.summaries.map(s => s.content).join('\n\n');
            contextLayers.summaries = `The following are summaries of earlier conversation:\n${summariesPrompt}`;
        }

        // 转换消息历史格式
        const chatHistory = this.messages.map(msg => ({
            role: msg.role,
            content: msg.content,
        }));

        // 调用 ContextWindowManager 进行预算管理
        const preparedContext = await contextWindowManager.prepareContext(
            chatHistory,
            identityPrompt,
            this.config.modelId,
            contextLayers,
        );

        // 输出预算报告
        logger.trace('[AgentSession] 上下文准备完成:', {
            messageCount: this.messages.length,
            usedMessageCount: preparedContext.usedMessageCount,
            wasTruncated: preparedContext.wasTruncated,
            totalUsed: preparedContext.budgetReport.totalUsed,
            remaining: preparedContext.budgetReport.remaining,
        });

        // 缓存结果，供 AgentLoop.callLLM() 使用
        this.lastPreparedContext = preparedContext;

        return preparedContext;
    }



    /**
     * 获取最后一次预处理的上下文
     * 
     * AgentLoop.callLLM() 使用此方法获取预处理的上下文块
     */
    getLastPreparedContext(): PreparedContext | null {
        return this.lastPreparedContext;
    }

    // ==================== 子会话（预留） ====================

    /**
     * 创建子会话（预留接口）
     *
     * 用于未来支持 sub-agent 场景
     */
    spawnSubSession(): AgentSession {
        const subSession = new AgentSession({
            ...this.config,
            agentId: `${this.config.agentId}_sub_${Date.now()}`,
        });

        logger.trace(`[AgentSession] 创建子会话: ${subSession.id}, parent: ${this.id}`);
        return subSession;
    }
}

// ==================== 工厂函数 ====================

/**
 * 创建会话实例
 */
export function createAgentSession(config: AgentSessionConfig): AgentSession {
    return new AgentSession(config);
}
