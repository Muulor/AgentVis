/**
 * TaskArtifactStore - 跨 SA 生命周期的中间成果持久化
 *
 * 核心职责：
 * 在 SA 因外部错误终止时保留已完成工具调用的结果数据，
 * 使 MB 重新派遣的新 SA 能复用这些中间成果。
 *
 * 生命周期：
 * - 由 AgentLoopFSMIntegration 在 FSM 初始化时创建
 * - 所有 SA 共享读写（通过 SubAgentRunner 写入，SubAgentDispatcher 读取注入）
 * - 单次用户消息处理结束后可选清空
 *
 * 设计约束：
 * - 纯内存实现，不持久化到磁盘
 * - Token 预算控制，总量超限时按 FIFO 淘汰旧条目
 * - 同 key 覆盖写入（最新版本生效）
 */

import type {
    TaskArtifact,
    TaskArtifactSnapshot,
    ArtifactDataType,
    ArtifactIndexEntry,
} from './types';
import { getLogger } from '@services/logger';

const logger = getLogger('TaskArtifactStore');

// ═══════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════

/** 默认最大存储预算（tokens），防止 Artifact 无限膨胀 */
const DEFAULT_MAX_TOTAL_TOKENS = 30000;



// ═══════════════════════════════════════════════════════════════
// Store 实现
// ═══════════════════════════════════════════════════════════════

export class TaskArtifactStore {
    /** 有序 Artifact 存储（Map 保持插入顺序） */
    private artifacts: Map<string, TaskArtifact> = new Map();
    /** 自增计数器，用于生成唯一 key */
    private counter = 0;

    constructor(
        private readonly maxTotalTokens: number = DEFAULT_MAX_TOTAL_TOKENS
    ) { }

    // ─────────────────────────────────────────────────────────
    // 写入
    // ─────────────────────────────────────────────────────────

    /**
     * 写入 Artifact（SA 执行过程中由 SubAgentRunner 自动调用）
     *
     * 同 key 覆盖写入（最新版本生效）。
     * 写入时自动估算 token 数，总量超限时按 FIFO 淘汰最旧的条目。
     *
     * @param toolName - 来源工具名
     * @param content - 工具调用结果文本
     * @param dataType - 数据类型分类
     * @param sourceHint - 来源参数摘要（如搜索 query、文件路径）
     * @param createdBy - SA 标识（role 名）
     */
    write(
        toolName: string,
        content: string,
        dataType: ArtifactDataType,
        sourceHint: string,
        createdBy: string
    ): void {
        const key = `${toolName}_${this.counter++}`;
        const estimatedTokens = this.estimateTokens(content);

        const artifact: TaskArtifact = {
            key,
            dataType,
            content,
            createdBy,
            createdAt: Date.now(),
            estimatedTokens,
            toolName,
            sourceHint,
        };

        this.artifacts.set(key, artifact);

        // 超出总预算时淘汰最旧条目
        this.evictIfOverBudget();
    }

    // ─────────────────────────────────────────────────────────
    // 读取
    // ─────────────────────────────────────────────────────────

    /**
     * 读取单个 Artifact
     */
    read(key: string): TaskArtifact | undefined {
        return this.artifacts.get(key);
    }

    /**
     * 获取所有 Artifact 列表（按写入顺序）
     */
    getAll(): TaskArtifact[] {
        return Array.from(this.artifacts.values());
    }

    /**
     * 按数据类型筛选 Artifact（按写入顺序）
     *
     * 用于提取特定类型的 Artifact，如 user_intervention。
     */
    getByType(dataType: ArtifactDataType): TaskArtifact[] {
        return Array.from(this.artifacts.values()).filter(a => a.dataType === dataType);
    }

    /**
     * 生成索引（轻量视图，不含完整 content）
     */
    getIndex(): ArtifactIndexEntry[] {
        return Array.from(this.artifacts.values()).map(a => ({
            key: a.key,
            dataType: a.dataType,
            toolName: a.toolName,
            sourceHint: a.sourceHint,
            estimatedTokens: a.estimatedTokens,
        }));
    }

    /**
     * 生成注入快照（用于 SA Prompt 或 MB 输入）
     *
     * 按预算限制选择注入哪些 Artifact 的完整内容。
     * 不够预算时优先保留最新的（LIFO 选择）。
     *
     * @param budgetTokens - 可用 token 预算
     * @returns 适合注入 Prompt 的快照
     */
    getSnapshot(budgetTokens: number): TaskArtifactSnapshot {
        const allArtifacts = Array.from(this.artifacts.values());
        const totalTokens = allArtifacts.reduce((sum, a) => sum + a.estimatedTokens, 0);

        if (totalTokens <= budgetTokens) {
            // 全部放得下，直接返回
            return {
                index: this.getIndex(),
                artifacts: allArtifacts,
                totalTokens,
            };
        }

        // 预算不足：从最新的开始选择，优先保留最近写入的
        const selected: TaskArtifact[] = [];
        let usedTokens = 0;
        const reversedArtifacts = [...allArtifacts].reverse();

        for (const artifact of reversedArtifacts) {
            if (usedTokens + artifact.estimatedTokens <= budgetTokens) {
                selected.unshift(artifact); // 恢复原始顺序
                usedTokens += artifact.estimatedTokens;
            }
        }

        return {
            index: this.getIndex(), // 索引始终包含全部（轻量）
            artifacts: selected,
            totalTokens: usedTokens,
        };
    }

    // ─────────────────────────────────────────────────────────
    // 生命周期管理
    // ─────────────────────────────────────────────────────────

    /**
     * 清空所有 Artifacts（新任务开始时调用）
     */
    clear(): void {
        this.artifacts.clear();
        this.counter = 0;
    }

    /**
     * 是否有任何 Artifacts
     */
    isEmpty(): boolean {
        return this.artifacts.size === 0;
    }

    /**
     * 当前 Artifact 数量
     */
    size(): number {
        return this.artifacts.size;
    }

    /**
     * 当前总 token 数
     */
    getTotalTokens(): number {
        return Array.from(this.artifacts.values())
            .reduce((sum, a) => sum + a.estimatedTokens, 0);
    }

    // ─────────────────────────────────────────────────────────
    // 内部工具
    // ─────────────────────────────────────────────────────────

    /**
     * 估算文本的 token 量（中英文混合启发式算法）
     *
     * 与 SubAgentRunner.estimateTextTokens 保持一致：
     * 中文约 1.5 字符/token，英文约 4 字符/token
     * 确保 Dispatcher 日志和 Runner 预估 tokens 数值口径统一
     */
    private estimateTokens(text: string): number {
        const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
        const otherChars = text.length - chineseChars;
        return Math.ceil(chineseChars / 1.5) + Math.ceil(otherChars / 4);
    }

    /**
     * 超出总预算时按 FIFO 淘汰最旧条目
     */
    private evictIfOverBudget(): void {
        let totalTokens = this.getTotalTokens();
        const keys = Array.from(this.artifacts.keys());

        // 从最旧的开始淘汰，直到总量降到预算内
        let evictIndex = 0;
        while (totalTokens > this.maxTotalTokens && evictIndex < keys.length) {
            const oldestKey = keys[evictIndex];
            if (oldestKey === undefined) break;
            const evicted = this.artifacts.get(oldestKey);
            if (evicted) {
                totalTokens -= evicted.estimatedTokens;
                this.artifacts.delete(oldestKey);
                logger.debug(
                    `[TaskArtifactStore] 📦 淘汰旧 Artifact: ${oldestKey} ` +
                    `(${evicted.estimatedTokens} tokens, 当前总量: ${totalTokens})`
                );
            }
            evictIndex++;
        }
    }
}
