/**
 * StateHandlers - 集中式状态处理器
 *
 * 职责：
 * 1. 处理 FSM 的 5 个业务状态（PREPARE_CONTEXT, MASTER_DECISION, DISPATCH, OBSERVE, EVALUATE）
 * 2. 返回下一个 FSM 事件
 * 3. 更新共享状态（sharedState）供 Orchestrator 同步
 */

import type { FSMEvent, FSMContext, PreparedContextPayload } from '../../fsm/types';
import type {
    HandlerContext,
    StateHandlerMap,
} from './types';
import type { TerminationReason } from '../types';
import type { Observation, GovernorDecision } from '../LoopGovernor';
import { extractExperienceFeedback } from '../ExperienceExtractor';
import type { ExternalGuideSkillInfo, ExternalScriptSkillInfo, MbDecisionLogEntry } from '../../brain/types';
import type { SubAgentSpec } from '../../brain/types';

import { PLANNING_CONSTANTS } from '../../PlanningConstants';
import { getLogger } from '@services/logger';
import { formatAgentLoopFailureMessage } from '../ErrorObservationFormatter';
import { translate } from '@/i18n';

const logger = getLogger('StateHandlers');

function formatLastMbTaskContext(task?: string): string {
    return task
        ? `\n\n${translate('chat.agentLastMbDispatchedTaskContext', { task })}`
        : '';
}

function formatLastSaProgressContext(observations?: string): string {
    if (!observations) return '';

    const maxChars = PLANNING_CONSTANTS.SA_OBSERVATIONS_MAX_CHARS;
    const content = observations.length > maxChars
        ? translate('chat.agentEarlierStepsOmitted') + observations.slice(-maxChars)
        : observations;

    return `\n\n${translate('chat.agentLastSaExecutionProgressContext', {
        observations: content,
    })}`;
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * DISPATCH 阶段兜底补全 Guide 技能所需的 exec 工具
 *
 * 与 SubAgentSpecBuilder.ensureGuideSkillTools() 逻辑一致，
 * 但在 DISPATCH 阶段执行，确保二次检索命中的技能也能触发补全。
 *
 * 时序背景：
 * - spec 在 decisionMapper.map()（MASTER_DECISION 阶段）构建，
 *   此时若一次检索为空，ensureGuideSkillTools 拿到 guideSkills=[] 直接 return，不补全
 * - 二次检索在 spec 构建完成后发生，将新命中的技能合并到 sharedState.externalGuideSkills
 * - 因此需要在 DISPATCH 阶段对已建好的 spec 重新应用兜底补全
 */
function applyGuideSkillExec(
    spec: SubAgentSpec,
    guideSkills: ExternalGuideSkillInfo[]
): void {
    if (guideSkills.length === 0) return;
    if (spec.allowedTools.includes('exec')) return;

    // 脚本执行模式：匹配技能指南中的常见脚本执行指令
    const scriptExecPattern = /python\s|node\s|bash\s|npm\s|npx\s/i;

    for (const skill of guideSkills) {
        const hasScriptFiles = skill.scriptFiles && skill.scriptFiles.length > 0;
        const hasScriptSteps = scriptExecPattern.test(skill.fullContent);

        if (hasScriptFiles || hasScriptSteps) {
            spec.allowedTools.push('exec');
            // exec 补全后同步 behaviorHint → careful（exec 属于高风险操作）
            spec.behaviorHint ??= 'careful';
            logger.trace(
                `[StateHandlers] 🔧 DISPATCH 兜底补全 exec（来自 Guide 技能 "${skill.name}"）`,
                { hasScriptFiles, hasScriptSteps }
            );
            return;
        }
    }
}

/**
 * DISPATCH 阶段兜底补全 Script Skill 的统一执行工具。
 */
function applyScriptSkillExecute(
    spec: SubAgentSpec,
    scriptSkills?: ExternalScriptSkillInfo[]
): void {
    if (!scriptSkills || scriptSkills.length === 0) return;
    if (!spec.allowedTools.includes('external_skill_execute')) {
        spec.allowedTools.push('external_skill_execute');
        spec.behaviorHint ??= 'careful';
        logger.trace(
            '[StateHandlers] 🔧 DISPATCH 兜底补全 external_skill_execute（来自 Script 技能）',
            scriptSkills.map(skill => skill.name)
        );
    }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    return value as Record<string, unknown>;
}

function formatQuestionContent(value: unknown): string {
    if (value == null) {
        return '';
    }

    if (typeof value === 'string') {
        return value;
    }

    if (Array.isArray(value)) {
        const items = value as unknown[];
        return items.map(formatQuestionContent).filter(Boolean).join('\n');
    }

    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
    }

    try {
        const serialized = JSON.stringify(value);
        return typeof serialized === 'string' ? serialized : '';
    } catch {
        return '';
    }
}

function extractRequestMoreInputContent(decision: unknown): string {
    const decisionRecord = asRecord(decision);
    const nextStep = asRecord(decisionRecord?.nextStep);
    const details = asRecord(decisionRecord?.details);

    return formatQuestionContent(
        nextStep?.questionsForUser
        ?? details?.questionsForUser
        ?? decisionRecord?.questionsForUser
        ?? decisionRecord?.response
        ?? '',
    );
}

/**
 * MB 流式输出的 JSON 字段增量提取器
 *
 * 从正在累积的 LLM 原始输出中提取 rationale / notes / task 字段值，
 * 剥离 JSON 结构（键名、花括号、代码围栏等），只展示有意义的文本内容。
 * 支持不完整的 JSON（流式输出中间态，字段值可能尚未闭合）。
 *
 * 场景举例：
 * - 纯 JSON 输出（大多数模型）：```json\n{ "rationale": "..." } → 提取 rationale 值
 * - 思考模型（DeepSeek/Claude）：reasoning 文本在 JSON 之前 → 先展示 reasoning，后提取字段
 * - 流式中间态："rationale": "用户需要 → 提取不完整的值 "用户需要"
 */
function extractStreamingDisplayContent(rawContent: string): string {
    const parts: string[] = [];

    // 定位 JSON 块起始位置（跳过 ```json 代码围栏）
    const jsonFenceMatch = rawContent.match(/```json\s*\n?\s*\{/);
    const plainJsonStart = rawContent.indexOf('{');
    const jsonStartIndex = jsonFenceMatch
        ? rawContent.indexOf('{', jsonFenceMatch.index)
        : plainJsonStart;

    // JSON 前面的内容视为 reasoning（思考模型的推理过程）
    if (jsonStartIndex > 0) {
        const preJsonText = rawContent.substring(0, jsonFenceMatch?.index ?? jsonStartIndex);
        // 剥离 <thinking> 标签
        const reasoning = preJsonText.replace(/<\/?thinking>/g, '').trim();
        if (reasoning) parts.push(reasoning);
    }

    // 从 JSON 部分增量提取字段值（顺序与 Thought 卡片三阶段一致）
    const jsonPart = jsonStartIndex >= 0 ? rawContent.substring(jsonStartIndex) : '';

    const rationale = extractJsonStringValue(jsonPart, 'rationale');
    if (rationale) parts.push(rationale);

    const notes = extractJsonStringValue(jsonPart, 'notes');
    if (notes) parts.push(notes);

    const task = extractJsonStringValue(jsonPart, 'task');
    if (task) parts.push(task);

    if (parts.length > 0) return parts.join('\n\n');

    // 无可提取内容时：剥离代码围栏和不完整的 JSON 骨架，避免展示 ```json\n{ 等噪音
    const cleaned = rawContent
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '')
        .replace(/<\/?thinking>/g, '')
        .replace(/^\s*\{[\s\S]*$/, '') // 移除仅含不完整 JSON 的文本
        .trim();
    return cleaned;
}

/**
 * 从不完整的 JSON 文本中提取指定字段的字符串值
 *
 * 支持流式输出中间态：字段值可能尚未闭合（缺少右引号）。
 * 处理 JSON 转义字符（\n, \", \\\\ 等）。
 *
 * @param jsonContent - JSON 文本片段（可能不完整）
 * @param fieldName - 要提取的字段名
 * @returns 提取的字段值（已反转义），未找到时返回 undefined
 */
function extractJsonStringValue(jsonContent: string, fieldName: string): string | undefined {
    // 匹配 "fieldName": "value"，其中 value 可包含转义字符
    // 末尾的 "? 是可选的——流式输出时字段值可能尚未闭合
    const pattern = new RegExp(
        `"${fieldName}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"?`,
        's'
    );
    const match = jsonContent.match(pattern);
    if (!match) return undefined;

    const rawValue = match[1];
    if (!rawValue) return undefined;

    // 反转义常见 JSON 转义序列
    const unescaped = rawValue
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\//g, '/')
        .replace(/\\\\/g, '\\');

    return unescaped.trim() || undefined;
}

// ═══════════════════════════════════════════════════════════════
// 状态处理器映射工厂
// ═══════════════════════════════════════════════════════════════

/**
 * 创建状态处理器映射
 *
 * 返回一个包含所有 5 个业务状态处理器的映射表
 */
export function createStateHandlerMap(): StateHandlerMap {
    return {
        PREPARE_CONTEXT: handlePrepareContext,
        MASTER_DECISION: handleMasterDecision,
        DISPATCH: handleDispatch,
        OBSERVE: handleObserve,
        EVALUATE: handleEvaluate,
    };
}

// ═══════════════════════════════════════════════════════════════
// PREPARE_CONTEXT 状态处理器
// ═══════════════════════════════════════════════════════════════

/**
 * PREPARE_CONTEXT 状态处理器
 *
 * 准备上下文（记忆、RAG 等）
 * 会话上下文已由 AgentService 在外部准备，这里直接返回上下文就绪事件
 */
export function handlePrepareContext(
    _fsmContext: FSMContext,
    _handlerContext: HandlerContext
): Promise<FSMEvent> {
    try {
        // 会话上下文已由 AgentService 在外部准备
        // 这里直接返回上下文就绪事件
        const payload: PreparedContextPayload = {
            memorySnapshot: {},
            ragEvidence: [],
            toolCatalog: [],
        };

        return Promise.resolve({ type: 'CONTEXT_READY', payload });
    } catch (error) {
        return Promise.resolve({ type: 'CONTEXT_ERROR', error: String(error) });
    }
}

// ═══════════════════════════════════════════════════════════════
// MASTER_DECISION 状态处理器
// ═══════════════════════════════════════════════════════════════

/**
 * MASTER_DECISION 状态处理器
 *
 * 调用 MasterBrain.decide() 获取结构化决策
 * 包含 3 阶段思维 UI 回调
 */
export async function handleMasterDecision(
    _fsmContext: FSMContext,
    handlerContext: HandlerContext
): Promise<FSMEvent> {
    const { dependencies, config, sharedState } = handlerContext;
    const {
        masterBrain,
        decisionMapper,
        masterBrainInputBuilder,
        loopGovernor,
        callbacks,
    } = dependencies;

    if (!masterBrain) {
        return {
            type: 'DECISION_INVALID',
            reason: 'MasterBrain not initialized',
        };
    }

    try {
        // ═══ 阶段 1: ANALYZING - 分析用户意图 ═══
        callbacks.onThinkingPhase?.({
            type: 'START',
            phase: 'ANALYZING',
        });

        // projectPath 设置时 config.workdir 仍保持原始交付物目录，
        // 但 SA 的 effectiveWorkdir 已在 FSMIntegration 中切换为 projectPath。
        // MB 需要看到 effectiveWorkdir（即 SA 的实际 cwd）以及 projectPath 标记。
        const effectiveWorkdir = config.projectPath ?? config.workdir;
        const deliverableWorkdir = config.projectPath ? config.workdir : undefined;
        const input = await masterBrainInputBuilder.build(
            config.mbAgentRules,
            effectiveWorkdir,
            config.projectPath,
            deliverableWorkdir,
            config.sandboxMode,
        );

        // 将动态检索的外部 Guide 技能存入 sharedState
        // 关键：这些技能需要在 DISPATCH 阶段传递给 SubAgentDispatcher，
        // 使 SA 也能获得技能指南（fullContent + 脚本路径）
        sharedState.externalGuideSkills = input.externalGuideSkills;
        sharedState.externalScriptSkills = input.externalScriptSkills;

        // 缓存记忆系统中已有的任务经验到 SharedState
        // DISPATCH 阶段将其传递给 SA，用于避免重复报告同类经验
        if (input.memory.taskExperiences.length > 0) {
            sharedState.taskExperiences = input.memory.taskExperiences.map(exp => ({
                content: exp.content,
            }));
        }

        // 2. 调用 MasterBrain 获取决策
        // 传入流式回调：LLM 输出过程中，原始内容实时推送到 ANALYZING 阶段的 Thought 卡片
        // 流式结束 JSON 解析完成后，三阶段内容（rationale/notes/task）依次覆盖更新为解析结果
        const decision = await masterBrain.decide(input, {
            onStreamDelta: (accumulatedContent) => {
                // 从累积的 LLM 原始输出中增量提取 JSON 字段值，
                // 剥离 JSON 结构（键名、花括号、代码围栏等），只展示有意义的文本
                const displayContent = extractStreamingDisplayContent(accumulatedContent);
                callbacks.onThinkingPhase?.({
                    type: 'CONTENT',
                    phase: 'ANALYZING',
                    content: displayContent,
                });
            },
        });

        // 缓存 MB 的决策 rationale（跨请求持久化用）
        // 当系统因 SA 连续失败等原因非正常终止时，此 rationale 将嵌入终止消息，
        // 使下一轮用户请求的 conversationHistory 包含 MB 的阶段进展认知
        //
        // 降级决策（JSON 解析失败/纯文本兜底）的 rationale 是占位符，不应覆盖之前有价值的真实 rationale
        const decisionNextStepForLog = decision.nextStep as
            | { includeHistory?: boolean | string; role?: string; tools?: string[]; task?: string }
            | undefined;
        logger.debug('[StateHandlers] MB decision summary:', {
            decision: decision.decision,
            includeHistory: decisionNextStepForLog?.includeHistory,
            role: decisionNextStepForLog?.role,
            tools: decisionNextStepForLog?.tools,
            taskPreview: decisionNextStepForLog?.task?.slice(0, 2000),
        });

        const isParserFallback = decision.rationale.startsWith('(');
        if (!isParserFallback) {
            sharedState.lastMBRationale = decision.rationale;
            // 仅在真实 SPAWN_SUB_AGENT 决策时记录 task，供下一轮 MB 感知战略连续性
            if (decision.decision === 'SPAWN_SUB_AGENT') {
                const task = (decision.nextStep as { task?: string } | undefined)?.task;
                if (task) {
                    sharedState.lastMBTask = task;
                }
            }
        }

        // 降级决策（RESPOND_TO_USER 由 DecisionParser 兜底生成）时，
        // 将已有的 rationale、task 和 SA observations 追加到 response，确保跨请求持久化
        if (isParserFallback && decision.decision === 'RESPOND_TO_USER' && sharedState.lastMBRationale) {
            const rationaleBlock = `\n\nMB decision progress (system-injected context for the next decision):\n${sharedState.lastMBRationale}`;
            // 追加上次派遣任务，使下一轮 MB 知道"上次具体做了什么"，提升恢复精准度
            const taskBlock = formatLastMbTaskContext(sharedState.lastMBTask);
            // 倒序截取：保留最后 N 字符（最新步骤），MB 关心的是中断时刻的进展
            const saBlock = formatLastSaProgressContext(sharedState.lastSAObservations);
            decision.response = (decision.response || '') + rationaleBlock + taskBlock + saBlock;
        }

        // 上报 MB 调用的 token 估算到 statusStore
        // MB 的 generate() 返回纯 string（无 API usage），使用字符数估算
        try {
            const { useStatusStore } = await import('@stores/statusStore');
            const CHARS_PER_TOKEN = 2.5;
            // 估算输入 tokens：system prompt 由 MasterBrainPrompt.build(input) 构建
            const promptText = JSON.stringify(input);
            const estimatedInput = Math.ceil(promptText.length / CHARS_PER_TOKEN);
            // 估算输出 tokens：决策 JSON 序列化
            const estimatedOutput = Math.ceil(JSON.stringify(decision).length / CHARS_PER_TOKEN);
            // 使用任务启动时绑定的 tokenContextId，避免前台切换污染后台任务归属。
            const tokenContextId = config.tokenContextId ?? config.agentId;
            useStatusStore.getState().addTokenUsage(
                tokenContextId,
                estimatedInput,
                estimatedOutput
            );
            // 设置上下文压力指示器（MB 的输入约占模型上下文窗口）
            const { getContextWindowSize } = await import('@/config/modelRegistry');
            const modelContextWindow = getContextWindowSize(config.modelId ?? '');
            useStatusStore.getState().setContextPressure(
                tokenContextId,
                estimatedInput,
                modelContextWindow
            );
        } catch {
            // statusStore 访问失败不影响主流程
        }

        // ═══ 流式结束后：用解析后的结构化内容覆盖更新三阶段 ═══
        // 流式过程中 ANALYZING 阶段显示的是原始 LLM 输出（reasoning + JSON），
        // 解析完成后用 rationale 字段覆盖，使最终展示为干净的决策理由

        // 分析阶段内容：rationale（决策理由）——覆盖流式中间态
        callbacks.onThinkingPhase?.({
            type: 'CONTENT',
            phase: 'ANALYZING',
            content: decision.rationale,
        });

        callbacks.onThinkingPhase?.({
            type: 'COMPLETE',
            phase: 'ANALYZING',
        });

        // ═══ 阶段 2: PLANNING - 规划执行策略 ═══
        callbacks.onThinkingPhase?.({
            type: 'START',
            phase: 'PLANNING',
        });

        // 规划阶段内容：riskAssessment.notes
        callbacks.onThinkingPhase?.({
            type: 'CONTENT',
            phase: 'PLANNING',
            content: decision.riskAssessment.notes || 'No risk assessment notes',
        });

        callbacks.onThinkingPhase?.({
            type: 'COMPLETE',
            phase: 'PLANNING',
        });

        // ═══ 阶段 3: DECIDED - 输出决策结果 ═══
        callbacks.onThinkingPhase?.({
            type: 'START',
            phase: 'DECIDED',
        });

        // 决策阶段内容：nextStep.task 或 decision 类型描述
        const taskContent = (decision.nextStep as { task?: string } | undefined)?.task
            ?? `Decision type: ${decision.decision}`;
        callbacks.onThinkingPhase?.({
            type: 'CONTENT',
            phase: 'DECIDED',
            content: taskContent,
        });

        // 3. 发送思维链可视化事件（兼容旧 onThought 回调）
        callbacks.onThought?.({
            phase: 'decide',
            content: `[${decision.decision}] ${decision.rationale}`,
            timestamp: new Date(),
        });

        callbacks.onThinkingPhase?.({
            type: 'COMPLETE',
            phase: 'DECIDED',
        });

        // ═══ 发送 Metrics 更新 ═══
        const snapshot = loopGovernor.getSnapshot();
        callbacks.onMetricsUpdate?.(snapshot);

        // 4. 【委托】映射决策到 FSM 事件
        const mappingResult = decisionMapper.map(
            decision,
            sharedState.externalGuideSkills,
            sharedState.externalScriptSkills
        );

        // 同步副作用到共享状态
        if (mappingResult.terminationReason !== undefined) {
            sharedState.terminationReason = mappingResult.terminationReason;
        }
        if (mappingResult.lastLLMContent !== undefined) {
            sharedState.lastLLMContent = mappingResult.lastLLMContent;
        }
        if (mappingResult.pendingSubAgentSpec !== undefined) {
            sharedState.pendingSubAgentSpec = mappingResult.pendingSubAgentSpec;
        }
        if (mappingResult.madeProgress !== undefined) {
            sharedState.lastActionMadeProgress = mappingResult.madeProgress;
        }

        // 二次技能检索：使用 MB 决策中的 task 文本再次检索，
        // 补充一次检索可能遗漏的技能（MB 可能在 task 中提到用户查询未直接包含的技能名）。
        // 关键：spec.role 可能只是 MB 指定的角色名（如 "BrowserAutomationAgent"），
        // 包含技能名关键词的是 nextStep.task，它被映射到 spec.terminationCondition
        // 合并两者确保 L1 keyword match 能命中技能名（如 "agent-browser"）
        if (
            sharedState.pendingSubAgentSpec &&
            dependencies.getExternalGuideSkills
        ) {
            const spec = sharedState.pendingSubAgentSpec;
            // 合并 role + contextSummary + terminationCondition 作为二次检索 query
            // contextSummary 包含 MB 下发的完整任务指令（如 "参考技能: docx, xlsx"），
            // 单独使用 role 或 terminationCondition 可能不含技能关键词，导致 L1 匹配失败
            const taskText = [spec.role, spec.contextSummary, spec.terminationCondition]
                .filter(Boolean)
                .join(' ');
            try {
                const secondarySkills = await dependencies.getExternalGuideSkills(taskText);
                if (secondarySkills.length > 0) {
                    // 合并去重：一次检索 + 二次检索，按 name 去重（优先保留一次检索的结果）
                    const existingNames = new Set(
                        (sharedState.externalGuideSkills ?? []).map(s => s.name)
                    );
                    const newSkills = secondarySkills.filter(s => !existingNames.has(s.name));
                    if (newSkills.length > 0) {
                        sharedState.externalGuideSkills = [
                            ...(sharedState.externalGuideSkills ?? []),
                            ...newSkills,
                        ];
                        logger.debug(
                            '[StateHandlers] 🔄 二次技能检索补充命中:',
                            newSkills.map(s => s.name),
                            '（合并后总计:',
                            sharedState.externalGuideSkills.map(s => s.name),
                            '）',
                        );
                    }
                }
            } catch (err) {
                logger.warn('[StateHandlers] 二次技能检索失败，降级为空:', err);
            }
        }

        // Script Skill 二次精确匹配：MB 可能只在 nextStep.task 中引用技能名。
        if (
            sharedState.pendingSubAgentSpec &&
            dependencies.getExternalScriptSkills
        ) {
            const spec = sharedState.pendingSubAgentSpec;
            const taskText = [spec.role, spec.contextSummary, spec.terminationCondition]
                .filter(Boolean)
                .join(' ');
            try {
                const secondaryScriptSkills = await dependencies.getExternalScriptSkills(taskText);
                if (secondaryScriptSkills.length > 0) {
                    const existingNames = new Set(
                        (sharedState.externalScriptSkills ?? []).map(s => s.name)
                    );
                    const newSkills = secondaryScriptSkills.filter(s => !existingNames.has(s.name));
                    if (newSkills.length > 0) {
                        sharedState.externalScriptSkills = [
                            ...(sharedState.externalScriptSkills ?? []),
                            ...newSkills,
                        ];
                        logger.debug(
                            '[StateHandlers] 🔄 二次 Script 技能匹配补充命中:',
                            newSkills.map(s => s.name),
                            '（合并后总计:',
                            sharedState.externalScriptSkills.map(s => s.name),
                            '）',
                        );
                    }
                }
            } catch (err) {
                logger.warn('[StateHandlers] 二次 Script 技能匹配失败，降级为空:', err);
            }
        }

        return mappingResult.event;
    } catch (error) {
        // MasterBrain 决策失败
        logger.error('[StateHandlers] MasterBrain 决策失败:', error);

        // 将错误信息写入 lastLLMContent，确保 UI 显示错误而非上一轮内容
        const errorMessage = error instanceof Error ? error.message : String(error);

        // 嵌入前一轮缓存的 rationale（如有），为下次交互保留任务进展上下文
        const rationaleContext = sharedState.lastMBRationale
            ? `\n\nMB decision progress (system-injected context for the next decision):\n${sharedState.lastMBRationale}`
            : '';

        // 嵌入最后一次 SA 的执行进展（如有），使 MB 精确了解断点前 SA 的具体产出
        // 倒序截取：保留最后 N 字符（最新步骤），MB 关心的是中断时刻的进展
        const saContext = formatLastSaProgressContext(sharedState.lastSAObservations);
        sharedState.lastLLMContent = formatAgentLoopFailureMessage(error) + rationaleContext + saContext;

        return {
            type: 'DECISION_INVALID',
            reason: `MasterBrain decision failed: ${errorMessage}`,
        };
    }
}

// ═══════════════════════════════════════════════════════════════
// DISPATCH 状态处理器
// ═══════════════════════════════════════════════════════════════

/**
 * DISPATCH 状态处理器
 *
 * 分发执行（工具调用或子 Agent 创建）
 */
export async function handleDispatch(
    fsmContext: FSMContext,
    handlerContext: HandlerContext
): Promise<FSMEvent> {
    const { dependencies, sharedState } = handlerContext;
    const { subAgentDispatcher } = dependencies;

    // 检查决策类型
    const decision = fsmContext.currentDecision;

    // ======= 【优先处理】SubAgent 派遣 =======
    if (sharedState.pendingSubAgentSpec) {
        const spec = sharedState.pendingSubAgentSpec;

        // 系统层重试限制：检查 spawnCount 是否已超限
        // 安全阀硬切断：完全绕过 MB 决策，由系统直接生成用户可见消息
        if (sharedState.spawnCount > PLANNING_CONSTANTS.MAX_SPAWN_RETRIES) {
            logger.debug(`[StateHandlers] ❗ spawnCount(${sharedState.spawnCount}) > MAX_SPAWN_RETRIES(${PLANNING_CONSTANTS.MAX_SPAWN_RETRIES})，系统强制终止`);

            // 嵌入 MB 最后一轮的 rationale，为下次用户交互保留任务阶段进展上下文
            // UI 中此消息静默处理，但写入 session 后将自然流入下一轮 conversationHistory
            const rationaleContext = sharedState.lastMBRationale
                ? `\n\nMB decision progress (system-injected context for the next decision):\n${sharedState.lastMBRationale}`
                : '';

            // 嵌入最后一次 SA 的执行进展，使 MB 精确了解断点前 SA 的具体产出
            // 倒序截取保留最后 N 字符（MB 关心中断时刻而非最早步骤）
            const saProgressContext = formatLastSaProgressContext(sharedState.lastSAObservations);

            const systemMessage = formatAgentLoopFailureMessage('sub_agent_failure_circuit_breaker', {
                kind: 'sub_agent_failure_circuit_breaker',
                details: translate('chat.agentError.subAgentCircuitBreakerDetails', {
                    count: sharedState.spawnCount,
                    role: spec.role,
                }),
            }) + rationaleContext + saProgressContext;

            // 写入 session 确保消息在对话历史中可见
            dependencies.session.addMessage({
                role: 'assistant',
                content: systemMessage,
            });

            // 通知 UI 层显示进度提示
            dependencies.callbacks.onProgress?.('Sub-Agent failed repeatedly, so the task was stopped.');

            sharedState.terminationReason = 'text_response';
            sharedState.lastLLMContent = systemMessage;
            // 锁定终止消息：FSM 循环不会因 spawnCount 终止而立即退出，
            // 后续 handler（如 MB LLM 调用失败）可能覆盖 lastLLMContent。
            // 此标志在统一收口点优先恢复，确保含 rationale 的终止消息不丢失。
            sharedState.forceTerminationContent = systemMessage;
            sharedState.pendingSubAgentSpec = null;
            return { type: 'ACTION_COMPLETED', result: { response: systemMessage } };
        }

        // 注入当次 MB 决策检索到的外部 Guide 技能
        subAgentDispatcher.setExternalGuideSkills(sharedState.externalGuideSkills);
        subAgentDispatcher.setExternalScriptSkills(sharedState.externalScriptSkills);

        // DISPATCH 兜底补全：确保二次检索命中的 Guide 技能也能触发 exec 授权
        // spec 在 MASTER_DECISION 阶段由 decisionMapper.map() 构建，
        // 若当时 externalGuideSkills 为空（一次检索 0 命中），ensureGuideSkillTools 不生效；
        // 二次检索成功后只更新了 sharedState，未重建 spec，需要在此补全。
        if (sharedState.externalGuideSkills && sharedState.externalGuideSkills.length > 0) {
            applyGuideSkillExec(spec, sharedState.externalGuideSkills);
        }
        applyScriptSkillExecute(spec, sharedState.externalScriptSkills);

        // 注入全量已安装 Guide 技能名称列表（静态目录，仅名称）
        // 使 SA 能感知复合技能中引用的其他相关技能的存在，按需自行读取 SKILL.md
        // 数据由 getInstalledSkillCatalog 提供，已过滤禁用技能，与 MB 的 installedSkillCatalog 同源
        const installedGuideSkillNames = dependencies.getInstalledSkillCatalog?.().map(s => s.name) ?? [];
        const installedScriptSkillNames = dependencies.getInstalledScriptSkillCatalog?.().map(s => s.name) ?? [];
        const installedSkillNames = Array.from(new Set([
            ...installedGuideSkillNames,
            ...installedScriptSkillNames,
        ]));
        subAgentDispatcher.setAllInstalledSkillNames(installedSkillNames);

        // 注入记忆系统中已有的任务经验，使 SA 能避免重复报告同类经验
        subAgentDispatcher.setTaskExperiences(sharedState.taskExperiences);

        // 历史配对消息注入：SA 将在 messages[] 前段看到配对好的历史上下文（图片+文字）
        // 与 pendingImageAttachments（当轮新图片，扁平模式）互斥，两条路径不会同时触发
        logger.debug('[StateHandlers] Dispatching SA spec:', {
            role: spec.role,
            includeHistory: spec.includeHistory === true,
            pendingPairedHistoryCount: sharedState.pendingPairedHistoryMessages?.length ?? 0,
        });

        subAgentDispatcher.setPairedHistoryMessages(
            spec.includeHistory === true ? sharedState.pendingPairedHistoryMessages : undefined
        );

        // 所有 SA 都走动态循环模式，始终创建 checkpointCallback
        let checkpointCallback = undefined;
        if (dependencies.createCheckpointHandler) {
            checkpointCallback = dependencies.createCheckpointHandler(spec);
        }

        // 【委托】派遣 SubAgent（附带用户上传的图片附件，仅首次 SA 注入）
        const dispatchResult = await subAgentDispatcher.dispatch(
            spec,
            checkpointCallback,
            sharedState.abortSignal,
            sharedState.pendingImageAttachments,
            sharedState.savedAttachmentPaths
        );
        // 图片已注入 SA，清除引用避免后续 SA 重复接收
        sharedState.pendingImageAttachments = undefined;
        sharedState.savedAttachmentPaths = undefined;
        // 配对历史消息已注入 SA，清除引用（同样防止后续 SA 重复接收）
        sharedState.pendingPairedHistoryMessages = undefined;


        // 同步副作用到共享状态
        sharedState.lastActionMadeProgress = dispatchResult.madeProgress;
        sharedState.lastActionSpawnedSubAgent = dispatchResult.spawnedSubAgent;
        sharedState.pendingSubAgentSpec = null;

        // 缓存 SA 的执行观察摘要（跨请求持久化用）
        // 非正常终止时将与 lastMBRationale 一起嵌入终止消息，
        // 使下一轮 MB 精确了解失败 SA 在断点前的具体工作
        if (dispatchResult.output?.observations) {
            // 累积 SA observations 详细摘要，供 MB 在 TASK_ARTIFACTS 中感知前序 SA 推理过程
            // 优先使用详细的 observationEvents（每步 thinking + 工具动作），
            // 让 MB 看到完整的推理链而非仅最终结论（尤其是 SA 因网络中断时）
            const events = dispatchResult.output.observationEvents;
            let summary: string;
            if (events && events.length > 0) {
                // 序列化为紧凑的推理链格式（与 UI SubAgentObservationDisplay 相呼应）
                // 行级截断——保留所有步骤，每步 thinking 单独限长（200字符）。
                // 工具调用路径完整保留，MB 始终可见完整步骤链。
                // 不使用总字符上限，避免中途丢弃后续步骤导致 MB 失去对 SA 全局进度的感知。
                const MAX_THINKING_CHARS_PER_STEP = 200;
                const lines: string[] = [];
                for (const evt of events) {
                    let line = '';
                    if (evt.step) {
                        line += `${translate('chat.subAgentStepLabel', { step: evt.step })} `;
                    }
                    if (evt.thinking) {
                        // 每步 thinking 单独限长，超出则截断并标注省略
                        const thinking = evt.thinking.length > MAX_THINKING_CHARS_PER_STEP
                            ? evt.thinking.slice(0, MAX_THINKING_CHARS_PER_STEP) + '…'
                            : evt.thinking;
                        line += thinking;
                    }
                    if (evt.toolAction) {
                        const status = evt.toolAction.success === undefined
                            ? '⏳'
                            : evt.toolAction.success
                                ? '✅'
                                : '❌';
                        const workdirSuffix = evt.toolAction.workdir
                            ? ` ${translate('chat.subAgentToolWorkdirSuffix', {
                                workdir: evt.toolAction.workdir,
                            })}`
                            : '';
                        line += ` → ${evt.toolAction.tool} ${evt.toolAction.target}${workdirSuffix} ${status}`;
                    }
                    lines.push(line);
                }
                summary = lines.join('\n');
            } else {
                // 回退：无详细事件时截取最终 observations 文本
                const MAX_OBS_SUMMARY_CHARS = 300;
                const obs = dispatchResult.output.observations;
                summary = obs.length > MAX_OBS_SUMMARY_CHARS
                    ? obs.slice(0, MAX_OBS_SUMMARY_CHARS) + '...'
                    : obs;
            }
            sharedState.saObservationsSummaries.push({
                role: spec.role,
                summary,
            });

            // 只要 SA 积累了 observationEvents，就优先用步骤摘要注入 lastSAObservations
            if (events && events.length > 0) {
                // 有步骤记录——按终止原因生成不同标题
                const isApiError = dispatchResult.output.executionStatus === 'failure'
                    && dispatchResult.output.error !== undefined;
                const header = isApiError
                    ? translate('chat.subAgentInterruptedByApiErrorHeader', {
                        count: events.length,
                    })
                    : translate('chat.subAgentAbortedHeader', {
                        count: events.length,
                    });
                sharedState.lastSAObservations = `${header}\n${summary}`;
                logger.debug(
                    `[StateHandlers] 📋 SA 中断（${isApiError ? 'api_error' : 'cancelled/其他'}），lastSAObservations 替换为步骤摘要 (${events.length} 步)`
                );
            } else {
                // 无步骤记录（首步中断 / 正常 TASK_COMPLETE 完成）：保持原行为
                sharedState.lastSAObservations = dispatchResult.output.observations;
            }
        }

        // 系统层重试计数：SA 失败/被终止时递增，成功时重置
        // 仅统计连续失败，确保多阶段复合任务中成功的 SA 不会累积计数
        const result = dispatchResult.event;
        if (result.type === 'ACTION_FAILED' ||
            (result.type === 'ACTION_COMPLETED' && !dispatchResult.madeProgress)) {
            sharedState.spawnCount++;
            logger.debug(`[StateHandlers] SA 失败/无进展，spawnCount: ${sharedState.spawnCount}`);
        } else if (dispatchResult.madeProgress) {
            // SA 正常完成且有进展 → 重置连续失败计数器
            if (sharedState.spawnCount > 0) {
                logger.debug(`[StateHandlers] SA 成功完成，重置 spawnCount: ${sharedState.spawnCount} → 0`);
            }
            sharedState.spawnCount = 0;
        }

        // 记录本轮 MB 决策历史日志（在 dispatch 完成后一次性写入终态，无中间状态）
        // spawnCount 超限短路路径已提前 return，不会执行到此处，无需额外判断
        // 利用 MASTER_DECISION 阶段已写入的 lastMBRationale / lastMBTask
        if (sharedState.lastMBRationale) {
            const entry: MbDecisionLogEntry = {
                round: sharedState.mbDecisionLog.length + 1,
                rationale: sharedState.lastMBRationale,
                task: sharedState.lastMBTask,
                // madeProgress=true → completed；API中断/取消/Checkpoint终止 → failed
                status: dispatchResult.madeProgress ? 'completed' : 'failed',
            };
            const maxRounds = PLANNING_CONSTANTS.MB_DECISION_LOG_MAX_ROUNDS;
            sharedState.mbDecisionLog = [
                ...sharedState.mbDecisionLog.slice(-(maxRounds - 1)),
                entry,
            ];
            logger.debug(
                `[StateHandlers] 📋 MB 决策日志写入第 ${entry.round} 轮`,
                `status=${entry.status}`,
                `log 总计 ${sharedState.mbDecisionLog.length} 条`
            );
        }

        // SA 执行完毕后，从 observations 中提取执行经验
        if (dispatchResult.output?.observations && dispatchResult.madeProgress) {
            const experiences = extractExperienceFeedback(dispatchResult.output.observations);
            if (experiences.length > 0) {
                sharedState.pendingExperiences.push(...experiences);
                logger.debug(`[StateHandlers] 📝 提取到 ${experiences.length} 条 SA 执行经验`);
            }
        }

        return result;
    }

    // ======= RESPOND_TO_USER 决策处理 =======
    if (decision?.decision === 'RESPOND_TO_USER') {
        const details = decision.details as { response?: string; rationale?: string };
        const responseContent = details.response ?? '';

        if (responseContent) {
            sharedState.lastLLMContent = responseContent;
        }
        sharedState.terminationReason = 'text_response';
        sharedState.lastActionMadeProgress = true;

        // 写入本轮累积的 SA 执行经验到记忆系统（非阻塞，失败不影响主流程）
        if (sharedState.pendingExperiences.length > 0 && dependencies.saveTaskExperience) {
            // 去重：多次 SA 派遣可能各自提取到相同的经验内容
            const uniqueExperiences = [...new Set(sharedState.pendingExperiences)];
            sharedState.pendingExperiences = []; // 清空避免重复写入

            // 异步写入，不等待完成
            for (const experience of uniqueExperiences) {
                dependencies.saveTaskExperience(experience).catch((err: unknown) => {
                    logger.warn('[StateHandlers] 任务经验写入失败:', err);
                });
            }
            logger.debug(`[StateHandlers] 💾 异步写入 ${uniqueExperiences.length} 条任务经验`);
        }

        return { type: 'ACTION_COMPLETED', result: { response: sharedState.lastLLMContent } };
    }

    // ======= REQUEST_MORE_INPUT 决策处理 =======
    if (decision?.decision === 'REQUEST_MORE_INPUT') {
        const questions = extractRequestMoreInputContent(decision);

        logger.debug('[StateHandlers] DISPATCH → REQUEST_MORE_INPUT, 消息:', questions.substring(0, 100));

        if (questions.length > 0) {
            sharedState.lastLLMContent = questions;
        }

        sharedState.terminationReason = 'awaiting_interaction';
        sharedState.lastActionMadeProgress = true;

        return { type: 'ACTION_COMPLETED', result: { response: sharedState.lastLLMContent, requiresInteraction: true } };
    }

    // 没有有效的执行任务
    logger.warn('[StateHandlers] DISPATCH 状态但没有待执行的任务, decision:', decision?.decision);
    return { type: 'ACTION_COMPLETED', result: { noAction: true } };
}

// ═══════════════════════════════════════════════════════════════
// OBSERVE 状态处理器
// ═══════════════════════════════════════════════════════════════

/**
 * OBSERVE 状态处理器
 *
 * 观察执行结果
 */
export function handleObserve(
    _fsmContext: FSMContext,
    handlerContext: HandlerContext
): Promise<FSMEvent> {
    const { sharedState } = handlerContext;

    // 检查是否需要终止（由 DISPATCH 设置）
    if (
        sharedState.terminationReason === 'awaiting_interaction' ||
        sharedState.terminationReason === 'text_response'
    ) {
        return Promise.resolve({ type: 'TIMEOUT' });
    }

    // 继续到 EVALUATE 状态
    return Promise.resolve({ type: 'CONTINUE' });
}

// ═══════════════════════════════════════════════════════════════
// EVALUATE 状态处理器
// ═══════════════════════════════════════════════════════════════

/**
 * EVALUATE 状态处理器
 *
 * 使用 LoopGovernor 评估是否继续
 */
export function handleEvaluate(
    _fsmContext: FSMContext,
    handlerContext: HandlerContext
): Promise<FSMEvent> {
    const { dependencies, sharedState } = handlerContext;
    const { loopGovernor, callbacks } = dependencies;

    // 检查是否需要终止（由 DISPATCH 设置）
    if (
        sharedState.terminationReason === 'awaiting_interaction' ||
        sharedState.terminationReason === 'text_response'
    ) {
        return Promise.resolve({ type: 'TIMEOUT' });
    }

    // 使用 LoopGovernor 评估
    const observation: Observation = {
        madeProgress: sharedState.lastActionMadeProgress,
        // 全局风险评分预留扩展位：当前稳定性由工具级安全策略、Checkpoint 和 SA 内部保护承担。
        // 暂不把 MB riskAssessment 直接映射为 riskDelta，避免计划风险误伤实际执行流程。
        riskDelta: 0,
        toolCalled: sharedState.currentToolCalls.length > 0
            ? sharedState.currentToolCalls[0]?.name
            : undefined,
        subAgentSpawned: sharedState.lastActionSpawnedSubAgent,
    };

    // 重置进度标志（下一轮默认无进展，由实际操作设置）
    sharedState.lastActionMadeProgress = false;
    sharedState.lastActionSpawnedSubAgent = false;

    const decision: GovernorDecision = loopGovernor.evaluate(observation);

    // 通知 UI 回调：使用 LoopGovernor 的决策预算（非 FSM 步进上限）
    const snapshot = loopGovernor.getSnapshot();
    callbacks.onBudgetUpdate?.(
        snapshot.budgetRemaining,
        snapshot.initialBudget
    );

    if (decision.action === 'TERMINATE') {
        // 映射终止原因
        sharedState.terminationReason = mapGovernorReason(decision.reason);
        return Promise.resolve({ type: 'TIMEOUT' });
    }

    // 继续循环
    return Promise.resolve({ type: 'CONTINUE' });
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 映射 Governor 终止原因到 TerminationReason
 */
function mapGovernorReason(reason: string): TerminationReason {
    switch (reason) {
        case 'budget_exhausted':
            return 'budget_exhausted';
        case 'consecutive_no_progress':
        case 'tool_thrashing_detected':
        case 'over_delegation':
        case 'risk_exceeded':
            return 'max_iterations';
        default:
            return 'error';
    }
}
