/**
 * ExternalToolProvider - 外部工具提供者
 *
 * 实现 ToolProvider 接口，将 Script 模式的 External Skill
 * 桥接到 Tool 系统。每个 Script 模式 Skill 注册为一个独立 Tool。
 *
 * 核心约束：
 * - 一次性执行，不重试（作为 Side-Effect Observation）
 * - 执行前通过 ContractValidator 验证参数
 * - 执行后直接返回 ToolResult，不进入 FSM 循环
 *
 * 架构位置：
 * ToolRegistry → ExternalToolProvider → ContractValidator → ExternalExecutor → Shell
 */

import type {
    ToolSchema,
    ToolPropertySchema,
    ToolResult,
    ToolExecutionContext,
    Tool,
    ToolProvider,
} from '../../tools/types';
import type {
    LoadedExternalSkill,
    ExecutionContract,
    ContractArg,
    SkillAgentVisNetworkEntrypointMode,
} from './types';
import { emit } from '@tauri-apps/api/event';
import { translate } from '@/i18n';
import { normalizeArgsForContract, validateArgs } from './ContractValidator';
import { ExternalExecutor, type ShellExecuteFn } from './ExternalExecutor';
import { getLogger } from '@services/logger';

const logger = getLogger('ExternalToolProvider');

function normalizeEntrypointPath(entry: string): string {
    return entry
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\.?\//, '')
        .replace(/\/+/g, '/');
}

function resolveSkillEntrypointNetworkFallback(
    entryMode: SkillAgentVisNetworkEntrypointMode | undefined,
    skill: LoadedExternalSkill
): 'brokerProxyPreferred' | undefined {
    if (entryMode === 'brokerProxyPreferred') {
        return 'brokerProxyPreferred';
    }
    if (entryMode === 'legacyNonHttp') {
        return undefined;
    }
    return skill.agentvisNetwork;
}

function resolveSkillEntrypointNetworkMode(
    skill: LoadedExternalSkill,
    entry: string
): SkillAgentVisNetworkEntrypointMode | undefined {
    return skill.agentvisNetworkEntrypoints?.[normalizeEntrypointPath(entry)];
}

// ==================== ExternalToolProvider 实现 ====================

export class ExternalToolProvider implements ToolProvider {
    readonly name = 'external';
    readonly source = 'external' as const;

    private readonly tools: Map<string, ExternalTool> = new Map();
    private readonly executor: ExternalExecutor;

    /**
     * @param shellExecute Shell 执行函数（依赖注入）
     * @param venvPath Python venv 路径（供 ExternalExecutor 使用）
     */
    constructor(
        shellExecute: ShellExecuteFn,
        private readonly venvPath?: string
    ) {
        this.executor = new ExternalExecutor(shellExecute);
    }

    /**
     * 注册一个 Script 模式的 External Skill 为 Tool
     *
     * @param skill 已加载的 Script 模式技能
     * @throws 如果技能无 Contract（非 Script 模式）
     */
    registerSkill(skill: LoadedExternalSkill): void {
        if (skill.mode !== 'script' || !skill.contract) {
            throw new Error(
                `[ExternalToolProvider] Only Script-mode skills can be registered; ` +
                `"${skill.name}" is in ${skill.mode} mode`
            );
        }

        const tool = new ExternalTool(
            skill,
            this.executor,
            this.venvPath
        );

        this.tools.set(skill.name, tool);
        logger.trace(`[ExternalToolProvider] 注册外部工具: ${skill.name}`);
    }

    /**
     * 获取所有已注册工具的 Schema（用于传递给 LLM）
     */
    getSchemas(): ToolSchema[] {
        return Array.from(this.tools.values()).map(t => t.schema);
    }

    /**
     * 执行指定工具
     */
    async execute(
        toolName: string,
        params: unknown,
        context: ToolExecutionContext
    ): Promise<ToolResult> {
        const tool = this.tools.get(toolName);
        if (!tool) {
            return {
                success: false,
                content: translate('tools.external.toolNotRegistered', { toolName }),
            };
        }

        return tool.execute(
            params as Record<string, unknown>,
            context
        );
    }

    /**
     * 检查是否支持某工具
     */
    supports(toolName: string): boolean {
        return this.tools.has(toolName);
    }

    /**
     * 获取所有已注册工具（用于注册到 ToolRegistry）
     */
    getAllTools(): Tool[] {
        return Array.from(this.tools.values());
    }

    /**
     * 获取已注册工具数量
     */
    get size(): number {
        return this.tools.size;
    }
}

// ==================== ExternalTool 实现 ====================

/**
 * 单个 External Skill 的 Tool 封装
 *
 * 将 ExecutionContract 转换为 ToolSchema，
 * 并在 execute() 中通过 ExternalExecutor 执行脚本
 */
class ExternalTool implements Tool {
    readonly schema: ToolSchema;

    private readonly skill: LoadedExternalSkill;
    private readonly contract: ExecutionContract;
    private readonly executor: ExternalExecutor;
    private readonly venvPath?: string;

    constructor(
        skill: LoadedExternalSkill,
        executor: ExternalExecutor,
        venvPath?: string
    ) {
        if (!skill.contract) {
            throw new Error(`External skill '${skill.name}' is missing an execution contract`);
        }
        this.skill = skill;
        this.contract = skill.contract;
        this.executor = executor;
        this.venvPath = venvPath;

        // 根据 Contract 的 argsSchema 生成 LLM 可用的 ToolSchema
        this.schema = this.buildSchema();
    }

    /**
     * 执行外部工具（一次性，不重试）
     *
     * 流程：
     * 1. ContractValidator 验证参数
     * 2. ExternalExecutor 执行脚本
     * 3. 格式化 ToolResult
     */
    async execute(
        params: Record<string, unknown>,
        context: ToolExecutionContext
    ): Promise<ToolResult> {
        // Step 1: 参数验证
        const { args: normalizedParams } = normalizeArgsForContract(params, this.contract);
        const argResult = validateArgs(normalizedParams, this.contract);
        if (!argResult.valid) {
            return {
                success: false,
                content:
                    `External tool "${this.skill.name}" parameter validation failed:\n` +
                    argResult.errors.join('\n'),
            };
        }

        // Step 2: 报告进度
        context.onProgress?.(
            `Executing external tool: ${this.skill.name}`
        );

        // Step 3: 执行脚本
        const networkEntrypointMode = resolveSkillEntrypointNetworkMode(
            this.skill,
            this.contract.entry
        );
        const result = await this.executor.execute(
            this.contract,
            normalizedParams,
            this.skill.packagePath,
            this.venvPath,
            {
                sandboxMode: context.sandboxMode,
                networkFallback: resolveSkillEntrypointNetworkFallback(
                    networkEntrypointMode,
                    this.skill
                ),
                networkEntrypointMode,
                enableNetworkDirectAuthorization: context.sandboxMode === 'ControlledNetwork',
                workdir: context.workdir,
                signal: context.signal,
            }
        );

        // Step 4: 格式化结果
        const success = result.exitCode === 0;

        // 外部 skill 成功执行后，发射交付物刷新事件
        // 与 FileWriter.saveToDeliverables() 保持一致的事件契约：
        // FileList 通过 agentId 匹配决定是否刷新，filePath 留空（脚本可能写入多个文件）
        if (success && context.agentId) {
            emit('file:deliverable_created', {
                agentId: context.agentId,
                filePath: '',
                fileName: '',
            }).catch((emitError: unknown) => {
                // 事件发射失败不影响工具执行结果，仅记录警告
                logger.warn(
                    '[ExternalToolProvider] 刷新交付物事件发射失败:',
                    emitError instanceof Error ? emitError.message : String(emitError)
                );
            });
        }

        let content = `[External Tool: ${this.skill.name}]\n`;

        if (result.timedOut) {
            content += `Execution timed out (${this.contract.timeout}s)\n`;
        }

        content += `Exit code: ${result.exitCode}\n`;
        content += `Duration: ${result.durationMs}ms\n`;

        if (result.stdout) {
            content += `\nOutput:\n${result.stdout}`;
        }

        if (result.stderr) {
            content += `\nError:\n${result.stderr}`;
        }

        return {
            success,
            content,
            data: {
                toolName: this.skill.name,
                exitCode: result.exitCode,
                durationMs: result.durationMs,
                timedOut: result.timedOut,
            },
        };
    }

    /**
     * 根据 ExecutionContract.argsSchema 生成 ToolSchema
     *
     * 将 Contract 的参数定义转换为 Gemini Function Calling 格式
     */
    private buildSchema(): ToolSchema {
        const properties: Record<string, ToolPropertySchema> = {};
        const required: string[] = [];

        for (const arg of this.contract.argsSchema) {
            properties[arg.name] = {
                type: this.mapArgType(arg),
                description: arg.description,
            };

            if (arg.required) {
                required.push(arg.name);
            }
        }

        return {
            name: this.skill.name,
            description: this.skill.description,
            parameters: {
                type: 'object',
                properties,
                required: required.length > 0 ? required : undefined,
            },
        };
    }

    /**
     * 将 Contract 参数类型映射为 ToolPropertySchema 类型
     */
    private mapArgType(arg: ContractArg): ToolPropertySchema['type'] {
        switch (arg.type) {
            case 'string': return 'string';
            case 'number': return 'number';
            case 'boolean': return 'boolean';
            default: return 'string';
        }
    }
}
