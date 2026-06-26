/**
 * external_skill_execute 工具测试
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillDefinition } from '../../types';
import type { ExecutionContract } from '../../external/types';

const invokeMock = vi.hoisted(() => vi.fn());
const emitMock = vi.hoisted(() => vi.fn());
const runtimeStoreState = vi.hoisted(() => ({
    skillEnabledOverrides: {} as Record<string, boolean>,
}));
const skillLoaderMock = vi.hoisted(() => {
    const skills = new Map<string, SkillDefinition>();
    return {
        skills,
        loader: {
            loadAllSkills: vi.fn(async () => Array.from(skills.values())),
            getExternalScriptSkill: vi.fn((name: string) => {
                const skill = skills.get(name);
                return skill?.mode === 'script' && skill.contract ? skill : undefined;
            }),
            getAllSync: vi.fn(() => Array.from(skills.values())),
        },
    };
});

vi.mock('@tauri-apps/api/core', () => ({
    invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
    emit: emitMock,
}));

vi.mock('@stores/runtimeStore', () => ({
    useRuntimeStore: {
        getState: () => runtimeStoreState,
    },
}));

vi.mock('../../SkillLoader', () => ({
    skillLoader: skillLoaderMock.loader,
}));

const { externalSkillExecuteTool } = await import('../tool');

const BROKER_CONTRACT: ExecutionContract = {
    runtime: 'python',
    entry: 'scripts/broker_e2e.py',
    timeout: 45,
    maxOutput: 65536,
    argsSchema: [
        {
            name: 'url',
            type: 'string',
            required: true,
            description: 'Public URL to fetch',
        },
    ],
    permissions: { networkMode: 'brokerOnly' },
};

function registerSkill(skill: SkillDefinition): void {
    skillLoaderMock.skills.set(skill.name, skill);
}

describe('externalSkillExecuteTool', () => {
    beforeEach(() => {
        skillLoaderMock.skills.clear();
        runtimeStoreState.skillEnabledOverrides = {};
        vi.clearAllMocks();
        invokeMock.mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' });
        emitMock.mockResolvedValue(undefined);
    });

    it('缺少 skillName 时应返回参数错误', async () => {
        const result = await externalSkillExecuteTool.execute({}, {});

        expect(result.success).toBe(false);
        expect(result.content).toContain('skillName');
        expect(invokeMock).not.toHaveBeenCalled();
    });

    it('找不到 skill 时应返回明确错误', async () => {
        const result = await externalSkillExecuteTool.execute(
            { skillName: 'missing-script', args: {} },
            {}
        );

        expect(result.success).toBe(false);
        expect(result.content).toContain('missing-script');
        expect(invokeMock).not.toHaveBeenCalled();
    });

    it('禁用的 Script Skill 不应执行', async () => {
        registerSkill({
            name: 'broker-e2e',
            description: 'Broker E2E',
            fullContent: '# Broker E2E',
            source: 'external',
            mode: 'script',
            packagePath: 'C:/skills/external/packages/broker-e2e',
            contract: BROKER_CONTRACT,
        });
        runtimeStoreState.skillEnabledOverrides = { 'broker-e2e': false };

        const result = await externalSkillExecuteTool.execute(
            { skillName: 'broker-e2e', args: { url: 'https://example.com' } },
            {}
        );

        expect(result.success).toBe(false);
        expect(result.content).toContain('broker-e2e');
        expect(invokeMock).not.toHaveBeenCalled();
    });

    it('应拒绝 Guide 模式技能', async () => {
        registerSkill({
            name: 'guide-only',
            description: 'Guide skill',
            fullContent: '# Guide',
            source: 'external',
            mode: 'guide',
        });

        const result = await externalSkillExecuteTool.execute(
            { skillName: 'guide-only', args: {} },
            {}
        );

        expect(result.success).toBe(false);
        expect(result.content).toContain('guide-only');
        expect(result.content).toContain('guide');
        expect(result.content).toContain('skill-creator');
        expect(invokeMock).not.toHaveBeenCalled();
    });

    it('应校验 Script Skill argsSchema', async () => {
        registerSkill({
            name: 'broker-e2e',
            description: 'Broker E2E',
            fullContent: '# Broker E2E',
            source: 'external',
            mode: 'script',
            packagePath: 'C:/skills/external/packages/broker-e2e',
            contract: BROKER_CONTRACT,
        });

        const result = await externalSkillExecuteTool.execute(
            { skillName: 'broker-e2e', args: {} },
            {}
        );

        expect(result.success).toBe(false);
        expect(result.content).toContain('Missing required argument: url');
        expect(invokeMock).not.toHaveBeenCalled();
    });

    it('ControlledNetwork + brokerOnly 应通过 ExternalExecutor 注入 broker-only shell 参数', async () => {
        registerSkill({
            name: 'broker-e2e',
            description: 'Broker E2E',
            fullContent: '# Broker E2E',
            source: 'external',
            mode: 'script',
            packagePath: 'C:/skills/external/packages/broker-e2e',
            contract: BROKER_CONTRACT,
        });

        const result = await externalSkillExecuteTool.execute(
            { skillName: 'broker-e2e', args: { url: 'https://example.com' } },
            {
                sandboxMode: 'ControlledNetwork',
                workdir: 'C:/Users/Muulo/Desktop/test wordir',
                venvPythonPath: 'C:/runtime/.venv/Scripts/python.exe',
                agentId: 'agent-1',
            }
        );

        expect(result.success).toBe(true);
        expect(result.data).toMatchObject({
            skillName: 'broker-e2e',
            exitCode: 0,
            stdout: 'ok',
            stderr: '',
            timedOut: false,
        });
        expect(invokeMock).toHaveBeenCalledTimes(1);
        const shellParams = invokeMock.mock.calls[0]?.[1] as Record<string, unknown>;
        expect(String(shellParams.command)).toContain('scripts/broker_e2e.py');
        expect(String(shellParams.command)).not.toMatch(/python\.exe[\\/]?(?:Scripts|bin)[\\/]python/i);
        expect(invokeMock).toHaveBeenCalledWith('shell_execute', expect.objectContaining({
            timeoutSecs: 45,
            workdir: 'C:/Users/Muulo/Desktop/test wordir',
            sandboxMode: 'ControlledNetwork',
            sandboxLevel: 'restricted',
            sandboxNetwork: 'blocked',
            networkScope: 'blocked',
            subjectType: 'skill',
            subjectId: 'broker-e2e',
            env: expect.objectContaining({
                AGENTVIS_BROKER_MODE: 'explicit',
                AGENTVIS_DELIVERABLE_DIR: 'C:/Users/Muulo/Desktop/test wordir',
                AGENTVIS_NETWORK_BROKER_MODE: 'required',
                AGENTVIS_NETWORK_DIRECT_ACCESS: 'blocked',
                AGENTVIS_SKILL_PACKAGE_DIR: 'C:/skills/external/packages/broker-e2e',
                AGENTVIS_WORKDIR: 'C:/Users/Muulo/Desktop/test wordir',
            }),
        }));
        expect(emitMock).toHaveBeenCalledWith('file:deliverable_created', {
            agentId: 'agent-1',
            filePath: '',
            fileName: '',
        });
    });

    it('abort signal 应向 shell_cancel 传递 Script Skill executionId', async () => {
        registerSkill({
            name: 'broker-e2e',
            description: 'Broker E2E',
            fullContent: '# Broker E2E',
            source: 'external',
            mode: 'script',
            packagePath: 'C:/skills/external/packages/broker-e2e',
            contract: BROKER_CONTRACT,
        });
        const controller = new AbortController();
        let resolveShell!: (value: { exitCode: number; stdout: string; stderr: string }) => void;
        invokeMock.mockImplementation((command: string) => {
            if (command === 'shell_cancel') {
                return Promise.resolve('cancelled');
            }
            return new Promise<{ exitCode: number; stdout: string; stderr: string }>(resolve => {
                resolveShell = resolve;
            });
        });

        const execution = externalSkillExecuteTool.execute(
            { skillName: 'broker-e2e', args: { url: 'https://example.com' } },
            {
                sandboxMode: 'ControlledNetwork',
                signal: controller.signal,
            }
        );

        await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
            'shell_execute',
            expect.objectContaining({
                executionId: expect.stringMatching(/^external-skill-broker-e2e-/),
            })
        ));
        const shellParams = invokeMock.mock.calls.find(call => call[0] === 'shell_execute')?.[1] as Record<string, unknown>;

        controller.abort();

        await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('shell_cancel', {
            executionId: shellParams.executionId,
        }));

        resolveShell({ exitCode: 1, stdout: '', stderr: 'cancelled' });
        const result = await execution;

        expect(result.success).toBe(false);
        expect(emitMock).not.toHaveBeenCalled();
    });
});
