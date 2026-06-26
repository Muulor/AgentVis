/**
 * SubAgentFactory - 子智能体工厂
 *
 * 根据 Master Brain 的 SubAgentSpec 创建可执行的 Sub-Agent 实例
 *
 * 职责：
 * - 验证 spec 完整性
 * - 准备执行配置
 * - 构建 System Prompt
 *
 * 设计原则：
 * - 不推断 Agent 类型，由 MasterBrain 动态决定工具授权
 * - 工具安全由 ToolRiskGuard 基于风险等级兜底
 */

import type { SubAgentSpec } from '../brain/types';
import type { ExternalGuideSkillInfo, ExternalScriptSkillInfo } from '../brain/types';
import type { TaskContext } from './types';
import { SubAgentPromptBuilder } from './SubAgentPromptBuilder';
import { ToolRiskGuard } from '../tools/ToolPolicyManager';
import type { SkillDefinition } from '../skills/types';
import { PLANNING_CONSTANTS } from '../PlanningConstants';
import { useRuntimeStore } from '@stores/runtimeStore';
import { getLogger } from '@services/logger';

const logger = getLogger('SubAgentFactory');

// ═══════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// 工厂产物
// ═══════════════════════════════════════════════════════════════

/**
 * 子智能体实例
 *
 * 工厂产物，包含执行所需的全部配置
 */
export interface SubAgentInstance {
    /** 实例 ID */
    id: string;
    /** 原始规格 */
    spec: SubAgentSpec;
    /** 构建好的 System Prompt */
    systemPrompt: string;
    /** 允许的工具列表 */
    allowedTools: string[];
    /** 步数上限（主预算） */
    maxSteps: number;
    /** 创建时间 */
    createdAt: Date;
}

/**
 * 工厂创建结果
 */
export type FactoryResult =
    | { success: true; instance: SubAgentInstance }
    | { success: false; error: string };

// ═══════════════════════════════════════════════════════════════
// 工厂类
// ═══════════════════════════════════════════════════════════════

/**
 * 子智能体工厂
 */
export class SubAgentFactory {
    private promptBuilder: SubAgentPromptBuilder;
    private riskGuard: ToolRiskGuard;
    private counter: number = 0;

    constructor(
        promptBuilder?: SubAgentPromptBuilder,
        riskGuard?: ToolRiskGuard
    ) {
        this.promptBuilder = promptBuilder ?? new SubAgentPromptBuilder();
        this.riskGuard = riskGuard ?? new ToolRiskGuard();
    }

    /**
     * 创建子智能体实例
     *
     * @param spec - 子智能体规格（由 MasterBrain 生成）
     * @param context - 任务上下文
     * @param skills - 技能定义列表
     * @param externalGuideSkills - 当次命中的 External Guide 技能（含 fullContent）
     * @param externalScriptSkills - 当次命中的 External Script 技能（含 contract）
     * @param allInstalledSkillNames - 所有已安装外部技能的名称列表（全量目录，仅名称）
     */
    create(
        spec: SubAgentSpec,
        context: TaskContext,
        skills: SkillDefinition[],
        externalGuideSkills?: ExternalGuideSkillInfo[],
        externalScriptSkills?: ExternalScriptSkillInfo[],
        allInstalledSkillNames?: string[]
    ): FactoryResult {
        // 1. 验证 spec 完整性
        const validation = this.validateSpec(spec);
        if (!validation.valid) {
            return { success: false, error: validation.error ?? 'Invalid sub-agent spec' };
        }

        // 2. 工具风险检查（仅警告，不阻止）
        const toolValidation = this.riskGuard.validateToolList(spec.allowedTools);
        if (toolValidation.unknownTools.length > 0) {
            // 未注册工具仅输出警告日志，不阻止创建
            logger.warn(
                `[SubAgentFactory] 未注册工具: ${toolValidation.unknownTools.join(', ')}`
            );
        }
        if (toolValidation.highRiskTools.length > 0) {
            logger.trace(
                `[SubAgentFactory] 高风险工具: ${toolValidation.highRiskTools.join(', ')}`
            );
        }

        // 3. 构建 System Prompt（传递 externalGuideSkills + 全量技能目录 + venv 路径约束）
        // 从 RuntimeStore 获取 venv Python 路径，注入 Sub-Agent 防护约束
        const venvPythonPath = this.resolveVenvPythonPath();

        const systemPrompt = this.promptBuilder.build(
            spec, context, skills,
            { venvPythonPath },
            externalGuideSkills,
            externalScriptSkills,
            allInstalledSkillNames
        );

        // 打印完整 System Prompt 便于调试
        logger.trace(`[SubAgentFactory] System Prompt:\n${systemPrompt}`);

        // 4. 确定最大工具调用数（优先使用 loopConfig，否则用默认值）
        const maxSteps = spec.loopConfig?.maxSteps ?? PLANNING_CONSTANTS.SUB_AGENT_DEFAULT_MAX_STEPS;

        // 5. 创建实例
        const instance: SubAgentInstance = {
            id: this.generateId(),
            spec,
            systemPrompt,
            allowedTools: spec.allowedTools,
            maxSteps,
            createdAt: new Date(),
        };

        return { success: true, instance };
    }

    /**
     * 验证 spec 完整性
     */
    private validateSpec(spec: SubAgentSpec): { valid: boolean; error?: string } {
        if (!spec.role || spec.role.trim() === '') {
            return { valid: false, error: 'Missing role field' };
        }

        if (!Array.isArray(spec.allowedTools) || spec.allowedTools.length === 0) {
            return { valid: false, error: 'allowedTools must be a non-empty array' };
        }

        return { valid: true };
    }

    /**
     * 生成唯一 ID（不再包含 agent 类型前缀）
     */
    private generateId(): string {
        this.counter++;
        const timestamp = Date.now().toString(36);
        return `agent-${timestamp}-${this.counter}`;
    }

    /**
     * 从 RuntimeStore 解析 venv Python 可执行文件路径
     *
     * 仅在环境就绪（ready）时返回路径，否则返回 undefined。
     * 路径规则：Windows → venv/Scripts/python.exe, Unix → venv/bin/python
     */
    private resolveVenvPythonPath(): string | undefined {
        try {
            const { envStatus, venvPath } = useRuntimeStore.getState();

            if ((envStatus !== 'ready' && envStatus !== 'skipped') || !venvPath) {
                return undefined;
            }

            // Windows 下 venv 的 Python 在 Scripts/ 目录，Unix 在 bin/
            const isWindows = navigator.userAgent.includes('Windows') ||
                venvPath.includes('\\');
            const pythonExe = isWindows
                ? `${venvPath}\\Scripts\\python.exe`
                : `${venvPath}/bin/python`;

            return pythonExe;
        } catch {
            // RuntimeStore 不可用时（如测试环境），不注入
            return undefined;
        }
    }

    /**
     * 重置计数器（仅用于测试）
     */
    resetCounter(): void {
        this.counter = 0;
    }
}

/**
 * 工厂单例
 */
export const subAgentFactory = new SubAgentFactory();
