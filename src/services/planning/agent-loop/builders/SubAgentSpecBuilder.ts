/**
 * SubAgentSpecBuilder - SubAgentSpec JIT 构建器
 *
 * 从 MasterBrain 决策的 nextStep 中提取信息，构建 SubAgentSpec
 * 
 * 【设计原则】MasterBrain 只做决策，所有工具执行都通过 SubAgent
 * 当 SPAWN_SUB_AGENT 决策未提供完整 subAgentSpec 时，此构建器从 nextStep 提取信息 JIT 构建
 */

import type {
    MasterBrainDecision,
    SubAgentSpec,
    ExternalGuideSkillInfo,
    ExternalScriptSkillInfo,
} from '../../brain/types';
import { DEFAULT_LOOP_CONFIG } from '../../sub-agents/types';
import { PLANNING_CONSTANTS } from '../../PlanningConstants';
import { getLogger } from '@services/logger';
import { getCanonicalToolName } from '../../tools/ToolAliases';
import type { OutputLanguageHint } from '@services/language/OutputLanguagePolicy';

const logger = getLogger('SubAgentSpecBuilder');

/**
 * 工具调用信息
 */
export interface ToolCallInfo {
    name: string;
    args: Record<string, unknown>;
}

interface FlexibleDecisionNextStep {
    actionId?: unknown;
    arguments?: unknown;
    behaviorHint?: unknown;
    command?: unknown;
    description?: unknown;
    includeHistory?: unknown;
    parameters?: unknown;
    role?: unknown;
    task?: unknown;
    tool?: unknown;
    toolCall?: unknown;
    toolInput?: unknown;
    tools?: unknown;
}

interface FlexibleDecisionFields {
    nextStep?: FlexibleDecisionNextStep;
    parameters?: unknown;
    tool?: unknown;
    toolCall?: unknown;
}

function asFlexibleDecision(decision: MasterBrainDecision): MasterBrainDecision & FlexibleDecisionFields {
    return decision as MasterBrainDecision & FlexibleDecisionFields;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
        return undefined;
    }

    return value;
}

function asBehaviorHint(value: unknown): 'careful' | 'direct' | undefined {
    return value === 'careful' || value === 'direct' ? value : undefined;
}

/**
 * SubAgentSpec 构建器
 * 
 * 职责：
 * 1. 从 SPAWN_SUB_AGENT 决策中提取任务和工具信息
 * 2. 推断 SubAgent 角色
 * 3. 构建完整的 SubAgentSpec
 */
export class SubAgentSpecBuilder {
    /**
     * 从 SPAWN_SUB_AGENT 决策的 nextStep 构建 SubAgentSpec
     */
    buildFromNextStep(
        decision: MasterBrainDecision,
        guideSkills?: ExternalGuideSkillInfo[],
        scriptSkills?: ExternalScriptSkillInfo[],
        outputLanguageHint?: OutputLanguageHint
    ): SubAgentSpec | null {
        const flexibleDecision = asFlexibleDecision(decision);
        const nextStep = flexibleDecision.nextStep;

        if (!nextStep) {
            return null;
        }

        // 提取任务描述
        const task = asString(nextStep.task)
            ?? asString(nextStep.description)
            ?? decision.rationale;

        // 提取工具列表
        let tools: string[] = [];
        const stepTools = asStringArray(nextStep.tools);
        const directTool = asString(nextStep.tool);
        const toolCall = this.normalizeToolCall(nextStep.toolCall);
        const actionId = asString(nextStep.actionId);

        if (stepTools) {
            tools = [...stepTools];
        } else if (directTool) {
            tools = [directTool];
        } else if (toolCall) {
            tools = [toolCall.name];
        } else if (actionId) {
            // 兼容旧格式：actionId 视为工具名
            tools = [actionId];
        }

        // 如果没有提取到工具，尝试从 toolCall 中获取
        if (tools.length === 0) {
            const toolCall = this.extractToolCall(decision);
            if (toolCall) {
                tools = [toolCall.name];
            }
        }

        // 基础工具无条件补全：只读无风险工具是 SA 执行任何任务的基础能力
        // MB 端不展示这些工具的决策信息，SA 端默认注入 SKILL.md
        // 必须在空检查之前执行：MB 对纯基础工具任务可能返回 tools: []
        for (const baseTool of PLANNING_CONSTANTS.BASE_TOOLS) {
            if (!tools.includes(baseTool)) {
                tools.push(baseTool);
            }
        }

        // 如果补全基础工具后仍然为空（不应发生），无法创建 SubAgent
        if (tools.length === 0) {
            logger.warn('[SubAgentSpecBuilder] 无法从 nextStep 提取工具列表');
            return null;
        }

        // Guide 技能驱动的 exec 自动补全
        // 当已检索到的外部技能包含可执行脚本时，系统层自动补充 exec 工具
        // 解决 MB 自然语言 Decision Hint 不可靠（弱模型不稳定遵守）的问题
        this.ensureGuideSkillTools(tools, guideSkills);
        this.ensureScriptSkillTool(tools, scriptSkills);
        tools = this.normalizeToolNames(tools);

        // 统一使用 DEFAULT_LOOP_CONFIG（高预算、无定期 checkpoint）
        // exec 安全由 ExecSafetyPolicy 事件驱动 checkpoint 保障，无需按工具类型区分 loopConfig
        const loopConfig = { ...DEFAULT_LOOP_CONFIG };

        // 生成增强上下文摘要（包含完整工具清单）
        // SA 在两种情况下都能看到完整 task，只是出现的 Section 不同：
        //   - MB 未提供 role → inferRoleFromTools 已将 task 内嵌在 spec.role（"执行: ${task}"）
        //                      → task 出现在 SA 的 [### 任务角色] Section
        //   - MB 提供了短 role 标签 → spec.role 只是标签，task 需注入 contextSummary 第 0 部分
        //                             → task 出现在 SA 的 [### 背景上下文] Section
        // 避免两者同时成立时 task 在 prompt 里重复出现两次
        const role = asString(nextStep.role);
        const taskForContext = role ? task : undefined;
        const contextSummary = this.buildEnhancedContextSummary(decision, tools, taskForContext);

        // 构建 SubAgentSpec
        // behaviorHint 和 role 优先使用 MB 指定的值，否则系统推断
        const spec: SubAgentSpec = {
            behaviorHint: asBehaviorHint(nextStep.behaviorHint) ?? this.inferBehaviorHint(tools),
            role: role ?? this.inferRoleFromTools(tools, task),
            contextSummary,
            outputLanguageHint,
            allowedTools: tools,
            terminationCondition: 'Task complete or execution failed',
            loopConfig,
            // MB 显式请求时才注入用户对话历史，默认不注入
            // 避免 SA 因看到完整用户需求而越权执行多阶段任务
            // 兼容 LLM 返回布尔值 true 或字符串 "true" 两种情况
            includeHistory: nextStep.includeHistory === true || nextStep.includeHistory === 'true',
        };

        return spec;
    }

    /**
     * 从决策中提取工具调用信息
     * 
     * 支持多种 LLM 返回格式以提高兼容性：
     * - nextStep.toolCall: { tool, parameters }（标准格式）
     * - nextStep.toolCall: { name, parameters/arguments }（变体1）
     * - nextStep.tool + nextStep.parameters（变体2）
     * - nextStep.actionId（作为工具名称）+ nextStep.toolInput/arguments（变体3）
     */
    extractToolCall(decision: MasterBrainDecision): ToolCallInfo | null {
        const flexibleDecision = asFlexibleDecision(decision);
        const nextStep = flexibleDecision.nextStep;

        if (!nextStep) {
            // 尝试从根级别提取
            if (flexibleDecision.toolCall) {
                return this.normalizeToolCall(flexibleDecision.toolCall);
            }
            const rootTool = asString(flexibleDecision.tool);
            if (rootTool && flexibleDecision.parameters) {
                return {
                    name: rootTool,
                    args: asRecord(flexibleDecision.parameters) ?? {},
                };
            }
            return null;
        }

        // 标准格式：nextStep.toolCall
        if (nextStep.toolCall) {
            return this.normalizeToolCall(nextStep.toolCall);
        }

        // 变体2：nextStep.tool + nextStep.parameters
        if (nextStep.tool && typeof nextStep.tool === 'string') {
            return {
                name: nextStep.tool,
                args: asRecord(nextStep.parameters) ?? asRecord(nextStep.arguments) ?? {},
            };
        }

        // 变体3：actionId 作为工具名称
        if (nextStep.actionId && typeof nextStep.actionId === 'string') {
            return {
                name: nextStep.actionId,
                args: asRecord(nextStep.toolInput)
                    ?? asRecord(nextStep.parameters)
                    ?? asRecord(nextStep.arguments)
                    ?? {},
            };
        }

        // 变体4：nextStep.command（exec 工具）
        if (nextStep.command && typeof nextStep.command === 'string') {
            return {
                name: 'exec',
                args: { command: nextStep.command },
            };
        }

        return null;
    }

    /**
     * 标准化工具调用对象
     */
    private normalizeToolCall(tc: unknown): ToolCallInfo | null {
        const obj = asRecord(tc);
        if (!obj) {
            return null;
        }

        // 获取工具名称（支持 tool 或 name 字段）
        const name = asString(obj.tool) ?? asString(obj.name);
        if (!name) {
            return null;
        }

        // 获取参数（支持 parameters 或 arguments 字段）
        const args = asRecord(obj.parameters) ?? asRecord(obj.arguments) ?? {};

        return { name, args };
    }

    private normalizeToolNames(tools: string[]): string[] {
        return Array.from(new Set(tools.map(tool => getCanonicalToolName(tool))));
    }

    /**
     * 根据工具列表和任务推断 SubAgent 角色
     */
    private inferRoleFromTools(tools: string[], task: string): string {
        // 创建型工具（图像生成）
        if (tools.includes('generate_image')) {
            return `Create: ${task}`;
        }
        // 执行型工具（file_write 已整合 write+edit）
        if (tools.some(t => ['file_write', 'exec'].includes(t))) {
            return `Execute: ${task}`;
        }
        // 研究型工具
        if (tools.some(t => ['read', 'web_search'].includes(t))) {
            return `Research: ${task}`;
        }
        // 默认角色
        return `Task: ${task}`;
    }

    // inferLoopConfig 已移除 — 所有 SA 统一使用 DEFAULT_LOOP_CONFIG
    // exec 安全由 ExecSafetyPolicy（白/黑名单）+ 事件驱动 Checkpoint 保障
    // generate_image 也使用统一配置，支持批量配图场景



    /**
     * Guide 技能驱动的工具自动补全
     *
     * 扫描已检索到的外部 Guide 技能，当技能包含可执行脚本时，
     * 自动将 exec 添加到 allowedTools。
     *
     * 判断条件（满足任一即补全）：
     * 1. scriptFiles 非空 — 技能包包含需要 exec 执行的脚本文件
     * 2. fullContent 匹配脚本执行模式 — 技能指南中包含 python/node 等执行步骤
     */
    private ensureGuideSkillTools(
        tools: string[],
        guideSkills?: ExternalGuideSkillInfo[]
    ): void {
        if (!guideSkills || guideSkills.length === 0) {
            return;
        }

        // 已有 exec 则无需补全
        if (tools.includes('exec')) {
            return;
        }

        // 脚本执行模式：匹配技能指南中的常见脚本执行指令
        const scriptExecPattern = /python\s|node\s|bash\s|npm\s|npx\s/i;

        for (const skill of guideSkills) {
            const hasScriptFiles = skill.scriptFiles && skill.scriptFiles.length > 0;
            const hasScriptSteps = scriptExecPattern.test(skill.fullContent);

            if (hasScriptFiles || hasScriptSteps) {
                tools.push('exec');
                logger.trace(
                    `[SubAgentSpecBuilder] 🔧 Guide 技能 "${skill.name}" 需要脚本执行，自动补充 exec 工具`,
                    { hasScriptFiles, hasScriptSteps }
                );
                // 补一次即可，无需重复
                return;
            }
        }
    }

    /**
     * Script 技能驱动的工具自动补全
     *
     * 只要当前任务精确命中了 Script Skill，就补充统一执行入口。
     */
    private ensureScriptSkillTool(
        tools: string[],
        scriptSkills?: ExternalScriptSkillInfo[]
    ): void {
        if (!scriptSkills || scriptSkills.length === 0) {
            return;
        }

        if (tools.includes('external_skill_execute')) {
            return;
        }

        tools.push('external_skill_execute');
        logger.trace(
            '[SubAgentSpecBuilder] 🔧 Script 技能需要契约执行，自动补充 external_skill_execute 工具',
            scriptSkills.map(skill => skill.name)
        );
    }

    /**
     * 根据工具列表推断行为提示（仅作兜底，优先使用 MB 通过 nextStep.behaviorHint 显式指定）
     *
     * 所有 SA 默认拥有 5 个基础工具，工具列表不再是区分行为的主要信号。
     * 此方法仅在 MB 未指定 behaviorHint 时提供兜底推断。
     */
    private inferBehaviorHint(tools: string[]): 'careful' | 'direct' | undefined {
        // MB 未指定时默认不添加行为修饰，由 SA 根据任务自行判断
        // 仅保留 generate_image 的直接模式推断（单纯生成任务无需谨慎确认）
        if (tools.includes('generate_image')) {
            return 'direct';
        }

        if (tools.includes('external_skill_execute')) {
            return 'careful';
        }

        return undefined;
    }



    /**
     * 构建包含工具清单的增强上下文
     * 
     * @param decision - Master Brain 决策
     * @param expandedTools - 扩展后的完整工具列表
     * @param task - 具体任务描述（优先注入，确保 SA 拿到完整任务指令）
     */
    buildEnhancedContextSummary(
        decision: MasterBrainDecision,
        _expandedTools: string[],
        task?: string
    ): string {
        const parts: string[] = [];

        // 0. 具体任务描述（nextStep.task 的详细内容）
        // 当 MB 同时提供了短 role 标签（如"连疯成分研究分析师"）和详细 task 时，
        // task 内容不应丢失，必须在背景上下文中放出，确保 SA 知道具体要做什么
        if (task && task.length >= 10) {
            parts.push(`**Task Instruction**: ${task}`);
        }

        // 1. Master Brain 决策依据
        if (decision.rationale && decision.rationale.length >= 10) {
            parts.push(`**Master Brain Decision Rationale**: ${decision.rationale}`);
        }

        return parts.join('\n\n');
    }
}
