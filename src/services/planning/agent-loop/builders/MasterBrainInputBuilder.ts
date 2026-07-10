/**
 * MasterBrainInputBuilder - MasterBrain 输入契约构建器
 *
 * 整合用户意图、系统状态、记忆、RAG证据、工具目录，
 * 构建符合 MasterBrain 输入契约的数据结构
 */

import type { AgentSession } from '../AgentSession';
import { PLANNING_CONSTANTS } from '../../PlanningConstants';
import type { FSMEngine } from '../../fsm/FSMEngine';
import type { AgentServiceState, FSMEvent } from '../../fsm/types';
import type {
    MasterBrainInput,
    MemorySnapshot,
    RAGEvidence,
    ToolCatalogEntry,
    UserIntent,
    ExternalGuideSkillInfo,
    ExternalScriptSkillCatalogEntry,
    ExternalScriptSkillInfo,
    WorkdirSnapshot,
    MbDecisionLogEntry,
} from '../../brain/types';
import type { WorkdirFileInfo } from '../../sub-agents/types';

import type { TaskArtifactStore } from '../../artifact/TaskArtifactStore';
import { getLogger } from '@services/logger';
import { resolveOutputLanguage } from '@services/language/OutputLanguagePolicy';

const logger = getLogger('MasterBrainInputBuilder');

/**
 * MasterBrain 输入构建器依赖
 */
export interface MasterBrainInputBuilderDeps {
    /** 获取记忆快照（支持 userQuery 进行摘要语义召回） */
    getMemorySnapshot?: (agentId: string, userQuery?: string) => Promise<MemorySnapshot>;
    /** 获取 RAG 证据 */
    getRAGEvidence?: (query: string) => Promise<RAGEvidence[]>;
    /** 获取工具目录 */
    getToolCatalog?: () => ToolCatalogEntry[];
    /**
     * 按用户意图语义检索需要注入 Master Brain 的 Guide 模式技能
     *
     * 由 SkillRetriever 提供实现，返回 Top-K 最相关的技能
     */
    getExternalGuideSkills?: (query: string) => Promise<ExternalGuideSkillInfo[]>;
    /**
     * 按查询文本精确匹配 Script 模式技能（可选）
     *
     * 用于把用户/MB 明确提到的 Script Skill 传递到 DISPATCH 阶段。
     */
    getExternalScriptSkills?: (query: string) => Promise<ExternalScriptSkillInfo[]>;
    /**
     * 获取所有已安装外部 Guide 技能的轻量目录（静态全量，仅 name + description）
     *
     * 确保 MB 始终知道所有已安装技能的存在，即使语义检索未命中
     */
    getInstalledSkillCatalog?: () => Array<{ name: string; description: string }>;
    /**
     * 获取所有已安装外部 Script 技能的轻量目录（静态全量）
     */
    getInstalledScriptSkillCatalog?: () => ExternalScriptSkillCatalogEntry[];
    /**
     * 扫描工作目录文件列表（复用 SubAgentDispatcher.scanWorkdirFiles）
     *
     * 返回 WORKDIR 下的文件清单（递归，含名称/大小/修改时间）和过滤后的文件数。
     * 由 MasterBrainInputBuilder 聚合为轻量统计摘要注入 MB Prompt。
     * 失败时返回空结果，不阻塞 MB 决策流程。
     */
    getWorkdirFiles?: () => Promise<{ files: WorkdirFileInfo[]; totalFileCount: number; scanTruncated?: boolean }>;
}

/**
 * MasterBrain 输入构建器
 */
export class MasterBrainInputBuilder {
    /** 跨 SA 的 Artifact Store（用于注入索引到 MB 输入） */
    private artifactStore?: TaskArtifactStore;
    /** 各次 SA 执行的推理结论摘要（由 SharedState 同步） */
    private saObservationsSummaries: Array<{ role: string; summary: string }> = [];
    /** 上一轮 MB 返回的决策摘要（只保留最近一轮 SPAWN_SUB_AGENT 的） */
    private lastMBDecision?: { rationale: string; task: string };
    /** MB 决策历史日志（滑动窗口，由 SharedState 同步） */
    private mbDecisionLog: MbDecisionLogEntry[] = [];
    /** Agent 是否拥有自定义头像（用于 Character Grounding 形象感知） */
    private hasAvatar = false;
    /**
     * MB 当前剩余决策预算（由 syncSharedState 每轮同步）
     *
     * 仅在临近预算耗尽时有值（<= MB_BUDGET_WARNING_THRESHOLD），
     * 注入 MasterBrainInput 后由 AgentLoop 侧生成 messages 尾部警告。
     */
    private mbBudgetRemaining?: number;

    constructor(
        private session: AgentSession,
        private dependencies: MasterBrainInputBuilderDeps,
        private agentId: string,
        // 保留 FSMEngine 参数以备未来扩展（如注入 FSM 阶段信息）
        _fsmEngine: FSMEngine<AgentServiceState, FSMEvent>,
        private agentName?: string
    ) { }

    /**
     * 设置 Task Artifact Store
     */
    setArtifactStore(store: TaskArtifactStore): void {
        this.artifactStore = store;
    }

    /**
     * 设置 Agent 是否拥有自定义头像
     *
     * 用于 MasterBrainPrompt 的 Character Grounding 条件注入形象感知引导。
     * 图片本身通过 AgentLoop 在 messages 中以合成 user 消息注入。
     */
    setHasAvatar(hasAvatar: boolean): void {
        this.hasAvatar = hasAvatar;
    }

    /**
     * 同步 MB 决策历史日志（由 AgentLoopFSMIntegration.syncSharedState 每轮调用）
     *
     * 数据来源：SharedState.mbDecisionLog
     * 注入目标：MasterBrainInput.mbDecisionLog
     */
    setMbDecisionLog(log: MbDecisionLogEntry[]): void {
        this.mbDecisionLog = log;
    }

    /**
     * 同步上一轮 MB 决策摘要（由 AgentLoopFSMIntegration.syncSharedState 每轮决策前调用）
     *
     * 数据来源：SharedState.lastMBRationale + lastMBTask
     * 注入目标：MasterBrainInput.lastMBDecision
     */
    setLastMBDecision(rationale: string | undefined, task: string | undefined): void {
        if (rationale && task) {
            this.lastMBDecision = { rationale, task };
        } else {
            // 当任一为空时清除（新 run 开始时 reset 过）
            this.lastMBDecision = undefined;
        }
    }

    /**
     * 同步 SA 推理结论摘要（由 Orchestrator 每轮决策前调用）
     *
     * 数据来源：SharedState.saObservationsSummaries
     * 注入目标：MasterBrainInput.taskArtifactObservations
     */
    setSaObservationsSummaries(summaries: Array<{ role: string; summary: string }>): void {
        this.saObservationsSummaries = summaries;
    }

    /**
     * 同步 MB 剩余决策预算（由 AgentLoopFSMIntegration.syncSharedState 每轮调用）
     *
     * 数据来源：LoopGovernor.getSnapshot().budgetRemaining
     * 注入目标：MasterBrainInput.mbBudgetRemaining
     * 由 AgentLoop.buildMbBudgetWarningMessage() 读取后生成 messages 尾部警告。
     */
    setMbBudget(remaining: number): void {
        this.mbBudgetRemaining = remaining;
    }

    /**
     * 构建 MasterBrain 输入契约
     */
    async build(
        agentRules?: string,
        workdir?: string,
        projectPath?: string,
        deliverableWorkdir?: string,
        sandboxMode?: MasterBrainInput['sandboxMode'],
    ): Promise<MasterBrainInput> {
        // 用户意图：从会话历史提取
        const messages = this.session.getMessages();
        const lastUserMessage = messages
            .filter((m: { role: string; content: string; createdAt?: number }) => m.role === 'user')
            .pop();

        const userIntent: UserIntent = {
            explicit: lastUserMessage?.content ?? '',
            // 记录用户消息原始时间，让 MB 能与 CURRENT_TIME 对比推算 SA 执行耗时
            sentAt: lastUserMessage?.createdAt,
        };

        // 记忆快照（可选，如无则使用空快照）
        let memory: MemorySnapshot;
        if (this.dependencies.getMemorySnapshot) {
            try {
                // 传入用户查询，使摘要走语义召回而非全量返回
                memory = await this.dependencies.getMemorySnapshot(this.agentId, userIntent.explicit);
            } catch (err) {
                logger.warn('[MasterBrainInputBuilder] 获取记忆快照失败，使用空快照:', err);
                memory = this.createEmptyMemorySnapshot();
            }
        } else {
            memory = this.createEmptyMemorySnapshot();
        }

        // RAG 证据（可选）
        let ragEvidence: RAGEvidence[] = [];
        if (this.dependencies.getRAGEvidence) {
            try {
                ragEvidence = await this.dependencies.getRAGEvidence(userIntent.explicit);
            } catch (err) {
                logger.warn('[MasterBrainInputBuilder] 获取 RAG 证据失败:', err);
            }
        }

        // 工具目录
        const toolCatalog: ToolCatalogEntry[] = this.dependencies.getToolCatalog?.() ?? [];

        // 外部 Guide 模式技能（通过 SkillRetriever 语义检索 Top-K）
        let externalGuideSkills: ExternalGuideSkillInfo[] = [];
        if (this.dependencies.getExternalGuideSkills) {
            try {
                externalGuideSkills = await this.dependencies.getExternalGuideSkills(
                    userIntent.explicit
                );
                logger.trace('[MasterBrainInputBuilder] MB Guide 技能检索注入:', {
                    count: externalGuideSkills.length,
                    names: externalGuideSkills.map(skill => skill.name),
                });
            } catch (err) {
                logger.warn('[MasterBrainInputBuilder] 检索 Guide 技能失败:', err);
            }
        }

        // 外部 Script 模式技能（按用户意图中的精确技能名匹配）
        let externalScriptSkills: ExternalScriptSkillInfo[] = [];
        if (this.dependencies.getExternalScriptSkills) {
            try {
                externalScriptSkills = await this.dependencies.getExternalScriptSkills(
                    userIntent.explicit
                );
                logger.trace('[MasterBrainInputBuilder] MB Script 技能精确命中:', {
                    count: externalScriptSkills.length,
                    names: externalScriptSkills.map(skill => skill.name),
                });
            } catch (err) {
                logger.warn('[MasterBrainInputBuilder] 匹配 Script 技能失败:', err);
            }
        }

        // 提取最近 N 轮 user-assistant 对话（摘要水位线之间的短期上下文补充）
        // 记忆系统的 summaries 由水位线触发生成，最近几轮对话可能未被摘要
        const keepRounds = PLANNING_CONSTANTS.MASTER_BRAIN_HISTORY_KEEP_ROUNDS;
        const conversationHistory = messages
            .filter((m: { role: string }) => m.role === 'user' || m.role === 'assistant')
            .slice(-(keepRounds * 2))
            .map((m: { role: string; content: string; createdAt?: number }) => ({
                role: m.role as 'user' | 'assistant',
                content: m.content,
                // 传递消息时间戳，让 MB 感知对话间隔
                timestamp: m.createdAt,
            }));

        // Task Artifact 索引（前序 SA 的中间成果概览，帮助 MB 避免重复派遣）
        const taskArtifactIndex = this.artifactStore && !this.artifactStore.isEmpty()
            ? this.artifactStore.getIndex()
            : undefined;

        // 已安装技能目录（静态全量，仅 name + description）
        const installedSkillCatalog = this.dependencies.getInstalledSkillCatalog?.()
            ?? undefined;
        const installedScriptSkillCatalog = this.dependencies.getInstalledScriptSkillCatalog?.()
            ?? undefined;

        // WORKDIR 文件系统摘要（轻量统计，帮助 MB 感知 SA 执行进度）
        let workdirSnapshot: WorkdirSnapshot | undefined;
        if (this.dependencies.getWorkdirFiles) {
            try {
                const { files, totalFileCount, scanTruncated } = await this.dependencies.getWorkdirFiles();
                if (files.length > 0) {
                    // 使用 totalFileCount 作为总文件数，而非 files.length（最多 50），
                    // 修复 WORKDIR_SNAPSHOT 总数被截断到 MAX_FILES 的历史问题
                    workdirSnapshot = this.buildWorkdirSnapshot(files, totalFileCount, scanTruncated);
                    logger.trace(
                        `[MasterBrainInputBuilder] 📂 WORKDIR 摘要: ` +
                        `${workdirSnapshot.totalFiles} 个文件(全量), ` +
                        `${Object.keys(workdirSnapshot.byExtension).length} 种类型`
                    );
                }
            } catch (err) {
                // 扫描失败静默降级，不阻塞 MB 决策
                logger.trace('[MasterBrainInputBuilder] 📂 WORKDIR 扫描失败（降级为空）:', err);
            }
        }

        // SA 推理结论摘要（由 SharedState 同步，帮助 MB 了解前序 SA 的推理结果）
        const taskArtifactObservations = this.saObservationsSummaries.length > 0
            ? this.saObservationsSummaries
            : undefined;

        // 检测当前 run 内是否已有 SA 完成报告（[USER_INTENT] 脱敏判断依据）
        // tool 消息以 sub_agent_ 开头代表 SA 完成报告，clearToolMessages() 在每次 runWithFSM
        // 开始时清除，因此此处读到的 tool 消息均属于当前 run，无跨会话污染风险。
        const hasExecutedSA = messages.some(
            (m: { role: string; toolName?: string }) =>
                m.role === 'tool' && (m.toolName ?? '').startsWith('sub_agent_')
        );
        if (hasExecutedSA) {
            logger.trace('[MasterBrainInputBuilder] 🔄 检测到 SA 已完成，[USER_INTENT] 将在 Round 2+ 脱敏渲染');
        }

        return {
            userIntent,
            outputLanguageHint: resolveOutputLanguage(userIntent.explicit),
            agentName: this.agentName,
            hasAvatar: this.hasAvatar,
            memory,
            ragEvidence,
            toolCatalog,
            agentRules,
            workdir,
            sandboxMode: sandboxMode ?? 'LocalAudit',
            modelId: this.session.getModelId(),
            conversationHistory,
            installedSkillCatalog,
            installedScriptSkillCatalog,
            externalGuideSkills,
            externalScriptSkills,
            taskArtifactIndex,
            taskArtifactObservations,
            workdirSnapshot,
            // 项目路径上下文（cwd 切换时注入 [PROJECT_CONTEXT] 区块）
            projectPath,
            deliverableWorkdir,
            lastMBDecision: this.lastMBDecision,
            // mbDecisionLog 优先使用多轮历史（同 run 内），lastMBDecision 作为工践保持向后兼容
            mbDecisionLog: this.mbDecisionLog.length > 0 ? this.mbDecisionLog : undefined,
            hasExecutedSA,
            mbBudgetRemaining: this.mbBudgetRemaining,
        };
    }

    /**
     * 将平铺文件列表聚合为轻量统计摘要
     *
     * MB 作为决策者只需知道规模和关键文件，不需逐文件细节。
     * 聚合策略：
     * - 总文件数（全量，含被截断的）
     * - 按扩展名分类统计（降序排列）
     * - 最近修改 Top-5（按修改时间降序）
     *
     * @param files - 过滤后按时间降序的文件列表（最新 50 个）
     * @param totalFileCount - 过滤后的文件数（扫描截断时为已知下限，不受 MAX_FILES 截断）
     * @param scanTruncated - 扫描是否因预算限制提前停止
     */
    private buildWorkdirSnapshot(
        files: WorkdirFileInfo[],
        totalFileCount: number,
        scanTruncated = false
    ): WorkdirSnapshot {
        // 按扩展名统计
        const byExtension: Record<string, number> = {};
        for (const file of files) {
            const lastDot = file.name.lastIndexOf('.');
            const ext = lastDot >= 0 ? file.name.slice(lastDot) : '(no ext)';
            byExtension[ext] = (byExtension[ext] ?? 0) + 1;
        }

        // 最近修改的 Top-5 文件（files 已按 mtime 降序排列，直接取前 5 个即可）
        // 注意：旧实现需要字符串公山排序，现在 scanWorkdirFiles 已保证排序，可直接截取
        const RECENT_FILE_COUNT = 5;
        const recentFiles = files
            .filter(f => f.modified !== 'unknown')
            .slice(0, RECENT_FILE_COUNT)
            .map(f => ({
                name: f.name,
                size: f.size,
                modified: f.modified,
            }));

        return {
            // 使用扫描得到的文件数，而非 files.length（截断后最多 50）
            // scanTruncated=true 时该值为已知下限，避免 MB 误判为完整目录规模
            totalFiles: totalFileCount,
            scanTruncated,
            byExtension,
            recentFiles,
        };
    }

    /**
     * 创建空的记忆快照
     */
    private createEmptyMemorySnapshot(): MemorySnapshot {
        return {
            facts: [],
            summaries: [],
            factsByCategory: {
                identity_role: [],
                preference_style: [],
                long_term_goal: [],
                knowledge_level: [],
                interaction_signals: [],
                task_experience: [],
            },
            taskExperiences: [],
        };
    }
}
