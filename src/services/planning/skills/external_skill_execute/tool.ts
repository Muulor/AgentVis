/**
 * ExternalScriptSkillExecuteTool - Script Skill 统一执行入口
 *
 * 通过 skillName 精确查找已安装的 Script Skill，校验 Execution Contract 参数，
 * 再交给 ExternalExecutor 执行，使 brokerOnly 等沙箱策略走统一执行链。
 */

import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { translate } from '@/i18n';
import { getLogger } from '@services/logger';
import { useRuntimeStore } from '@stores/runtimeStore';
import type { Tool, ToolSchema, ToolResult, ToolExecutionContext } from '../../tools/types';
import { skillLoader } from '../SkillLoader';
import { normalizeArgsForContract, validateArgs } from '../external/ContractValidator';
import { ExternalExecutor, type ShellExecuteFn } from '../external/ExternalExecutor';
import type { SkillAgentVisNetworkEntrypointMode } from '../external/types';
import type { SkillDefinition } from '../types';

const logger = getLogger('ExternalScriptSkillExecuteTool');

interface ShellExecuteResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
    terminated?: boolean;
    durationMs?: number;
    timeoutSecs?: number;
}

const SCHEMA: ToolSchema = {
    name: 'external_skill_execute',
    description: 'Execute an installed external Script Skill by exact skillName using its declared Execution Contract.',
    parameters: {
        type: 'object',
        properties: {
            skillName: {
                type: 'string',
                description: 'Exact installed Script Skill name, for example "broker-e2e".',
            },
            args: {
                type: 'object',
                description: 'Arguments for the Script Skill. Must match the skill contract argsSchema.',
            },
        },
        required: ['skillName'],
    },
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    return value as Record<string, unknown>;
}

function resolveSkillName(params: Record<string, unknown>): string {
    const value = params.skillName ?? params.skill_name;
    return typeof value === 'string' ? value.trim() : '';
}

function createShellExecute(): ShellExecuteFn {
    return ({ timeout, ...params }) =>
        invoke<ShellExecuteResult>('shell_execute', {
            ...params,
            timeoutSecs: timeout,
        });
}

function findExternalSkillByName(name: string): SkillDefinition | undefined {
    return skillLoader.getAllSync().find(
        skill => skill.source === 'external' && skill.name === name
    );
}

function resolveVenvRoot(venvPythonPath?: string): string | undefined {
    if (!venvPythonPath) {
        return undefined;
    }

    const normalized = venvPythonPath.replace(/\\/g, '/');
    const windowsMatch = normalized.match(/^(.*)\/Scripts\/python(?:\.exe)?$/i);
    if (windowsMatch?.[1]) {
        return windowsMatch[1];
    }

    const posixMatch = normalized.match(/^(.*)\/bin\/python(?:\d+(?:\.\d+)?)?$/i);
    if (posixMatch?.[1]) {
        return posixMatch[1];
    }

    return venvPythonPath;
}

function isSkillEnabled(name: string): boolean {
    const { skillEnabledOverrides } = useRuntimeStore.getState();
    return skillEnabledOverrides[name] ?? true;
}

function normalizeEntrypointPath(entry: string): string {
    return entry
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\.?\//, '')
        .replace(/\/+/g, '/');
}

function resolveSkillEntrypointNetworkMode(
    skill: SkillDefinition,
    entry: string
): SkillAgentVisNetworkEntrypointMode | undefined {
    return skill.agentvisNetworkEntrypoints?.[normalizeEntrypointPath(entry)];
}

function resolveSkillEntrypointNetworkFallback(
    entryMode: SkillAgentVisNetworkEntrypointMode | undefined,
    skill: SkillDefinition
): 'brokerProxyPreferred' | undefined {
    if (entryMode === 'brokerProxyPreferred') {
        return 'brokerProxyPreferred';
    }
    if (entryMode === 'legacyNonHttp') {
        return undefined;
    }
    return skill.agentvisNetwork;
}

class ExternalScriptSkillExecuteToolImpl implements Tool {
    readonly schema = SCHEMA;

    private readonly executor = new ExternalExecutor(createShellExecute());

    async execute(
        params: Record<string, unknown>,
        context: ToolExecutionContext
    ): Promise<ToolResult> {
        const skillName = resolveSkillName(params);
        if (!skillName) {
            return {
                success: false,
                content: translate('tools.common.errorMissingParam', { param: 'skillName' }),
            };
        }

        if (!isSkillEnabled(skillName)) {
            return {
                success: false,
                content: translate('tools.external.skillDisabled', { skillName }),
            };
        }

        await skillLoader.loadAllSkills();

        const skill = skillLoader.getExternalScriptSkill(skillName);
        if (!skill?.contract || !skill.packagePath) {
            const externalSkill = findExternalSkillByName(skillName);
            if (externalSkill) {
                return {
                    success: false,
                    content: translate('tools.external.skillNotScript', {
                        skillName,
                        mode: externalSkill.mode ?? 'unknown',
                    }),
                };
            }

            return {
                success: false,
                content: translate('tools.external.skillNotFound', { skillName }),
            };
        }

        const rawArgs = params.args ?? {};
        const args = asRecord(rawArgs);
        if (!args) {
            return {
                success: false,
                content: translate('tools.external.invalidArgsObject', { skillName }),
            };
        }

        const { args: normalizedArgs } = normalizeArgsForContract(args, skill.contract);
        const argResult = validateArgs(normalizedArgs, skill.contract);
        if (!argResult.valid) {
            logger.debug('[ExternalScriptSkillExecuteTool] Script Skill args validation failed', {
                skillName,
                argKeys: Object.keys(normalizedArgs).sort(),
                errors: argResult.errors,
            });
            return {
                success: false,
                content: translate('tools.external.argValidationFailed', {
                    skillName,
                    errors: argResult.errors.join('\n'),
                }),
            };
        }

        if (context.signal?.aborted) {
            return {
                success: false,
                content: translate('tools.common.toolExecutionCancelled'),
            };
        }

        context.onProgress?.(translate('tools.external.executingScriptSkill', { skillName }));

        logger.trace('[ExternalScriptSkillExecuteTool] Executing Script Skill', {
            skillName,
            runtime: skill.contract.runtime,
            entry: skill.contract.entry,
            packagePath: skill.packagePath,
            network: skill.contract.permissions?.network,
            networkMode: skill.contract.permissions?.networkMode,
            sandboxMode: context.sandboxMode ?? 'LocalAudit',
            argKeys: Object.keys(normalizedArgs).sort(),
            hasVenvPythonPath: Boolean(context.venvPythonPath),
            agentId: context.agentId,
        });

        const networkEntrypointMode = resolveSkillEntrypointNetworkMode(
            skill,
            skill.contract.entry
        );
        const result = await this.executor.execute(
            skill.contract,
            normalizedArgs,
            skill.packagePath,
            resolveVenvRoot(context.venvPythonPath),
            {
                sandboxMode: context.sandboxMode,
                networkFallback: resolveSkillEntrypointNetworkFallback(
                    networkEntrypointMode,
                    skill
                ),
                networkEntrypointMode,
                enableNetworkDirectAuthorization: context.sandboxMode === 'ControlledNetwork',
                workdir: context.workdir,
                signal: context.signal,
            }
        );

        if (context.signal?.aborted) {
            return {
                success: false,
                content: translate('tools.common.toolExecutionCancelled'),
            };
        }

        const success = result.exitCode === 0;
        logger.trace('[ExternalScriptSkillExecuteTool] Script Skill execution finished', {
            skillName,
            success,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            timedOut: result.timedOut,
            stdoutChars: result.stdout.length,
            stderrChars: result.stderr.length,
        });

        if (success && context.agentId) {
            emit('file:deliverable_created', {
                agentId: context.agentId,
                filePath: '',
                fileName: '',
            }).catch((emitError: unknown) => {
                logger.warn(
                    '[ExternalScriptSkillExecuteTool] 刷新交付物事件发射失败:',
                    emitError instanceof Error ? emitError.message : String(emitError)
                );
            });
        }

        return {
            success,
            content: this.formatResult(skillName, result),
            data: {
                skillName,
                exitCode: result.exitCode,
                durationMs: result.durationMs,
                stdout: result.stdout,
                stderr: result.stderr,
                timedOut: result.timedOut,
            },
        };
    }

    private formatResult(
        skillName: string,
        result: {
            exitCode: number;
            stdout: string;
            stderr: string;
            durationMs: number;
            timedOut: boolean;
        }
    ): string {
        let content = translate('tools.external.executionResultHeader', { skillName });

        if (result.timedOut) {
            content += `\n${translate('tools.external.executionTimedOut')}`;
        }

        content += `\n${translate('tools.external.exitCodeLabel')}: ${result.exitCode}`;
        content += `\n${translate('tools.external.durationLabel')}: ${result.durationMs}ms`;

        if (result.stdout) {
            content += `\n\n${translate('tools.external.stdoutLabel')}:\n${result.stdout}`;
        }

        if (result.stderr) {
            content += `\n\n${translate('tools.external.stderrLabel')}:\n${result.stderr}`;
        }

        return content;
    }
}

export const externalSkillExecuteTool = new ExternalScriptSkillExecuteToolImpl();
