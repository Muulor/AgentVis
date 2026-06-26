/**
 * ExternalExecutor 单元测试
 *
 * 覆盖场景：
 * - 命令构造（Python/Bash/Node runtime，参数映射）
 * - 脚本执行（成功/失败/超时）
 * - 输出截取（超长输出）
 */

import { invoke } from '@tauri-apps/api/core';
import {
    activeNetworkDirectAllowancesForSubject,
    requestNetworkDirectAuthorization,
} from '@stores/networkDirectAuthorizationStore';
import { requestNetworkUploadAuthorization } from '@stores/networkUploadAuthorizationStore';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExternalExecutor, type ShellExecuteFn } from '../ExternalExecutor';
import type { ExecutionContract } from '../types';

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
}));

vi.mock('@stores/networkDirectAuthorizationStore', () => ({
    activeNetworkDirectAllowancesForSubject: vi.fn(() => []),
    requestNetworkDirectAuthorization: vi.fn(),
}));

vi.mock('@stores/networkUploadAuthorizationStore', () => ({
    requestNetworkUploadAuthorization: vi.fn(),
}));

// ==================== 测试用 Mock ====================

function createMockShellExecute(
    response: Awaited<ReturnType<ShellExecuteFn>> = {
        exitCode: 0,
        stdout: 'success output',
        stderr: '',
    }
): ShellExecuteFn {
    return vi.fn().mockResolvedValue(response);
}

const BASE_CONTRACT: ExecutionContract = {
    runtime: 'python',
    entry: 'scripts/analyze.py',
    timeout: 30,
    maxOutput: 65536,
    argsSchema: [
        { name: 'file_path', type: 'string', required: true, description: '文件路径' },
        { name: 'count', type: 'number', required: false, description: '数量' },
        { name: 'verbose', type: 'boolean', required: false, description: '详细模式' },
    ],
};

beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    vi.mocked(activeNetworkDirectAllowancesForSubject).mockReset();
    vi.mocked(activeNetworkDirectAllowancesForSubject).mockReturnValue([]);
    vi.mocked(requestNetworkDirectAuthorization).mockReset();
    vi.mocked(requestNetworkUploadAuthorization).mockReset();
});

// ==================== buildCommand 测试 ====================

describe('ExternalExecutor.buildCommand', () => {
    it('应该构造正确的 Python 命令（带 venv）', () => {
        const shell = createMockShellExecute();
        const executor = new ExternalExecutor(shell);

        const cmd = executor.buildCommand(
            BASE_CONTRACT,
            { file_path: '/data/test.csv' },
            '/packages/csv-analyzer',
            '/runtime/python-v1/.venv'
        );

        // 应包含 venv python 路径（platform-specific，测试中可能是 bin 或 Scripts）
        expect(cmd).toContain('python');
        expect(cmd).toContain('/packages/csv-analyzer/scripts/analyze.py');
        expect(cmd).toContain('--file_path');
        expect(cmd).toContain('/data/test.csv');
    });

    it('应该构造无 venv 的 Python 命令', () => {
        const shell = createMockShellExecute();
        const executor = new ExternalExecutor(shell);

        const cmd = executor.buildCommand(
            BASE_CONTRACT,
            { file_path: '/data/test.csv' },
            '/packages/csv-analyzer'
        );

        // 无 venv 时直接使用系统 python
        expect(cmd).toMatch(/^python\s/);
        expect(cmd).toContain('/packages/csv-analyzer/scripts/analyze.py');
    });

    it('布尔参数为 true 时只追加 flag', () => {
        const shell = createMockShellExecute();
        const executor = new ExternalExecutor(shell);

        const cmd = executor.buildCommand(
            BASE_CONTRACT,
            { file_path: '/data/test.csv', verbose: true },
            '/packages/csv-analyzer'
        );

        expect(cmd).toContain('--verbose');
        expect(cmd).not.toContain('true');
    });

    it('布尔参数为 false 时不追加', () => {
        const shell = createMockShellExecute();
        const executor = new ExternalExecutor(shell);

        const cmd = executor.buildCommand(
            BASE_CONTRACT,
            { file_path: '/data/test.csv', verbose: false },
            '/packages/csv-analyzer'
        );

        expect(cmd).not.toContain('--verbose');
    });

    it('数字参数应该正确映射', () => {
        const shell = createMockShellExecute();
        const executor = new ExternalExecutor(shell);

        const cmd = executor.buildCommand(
            BASE_CONTRACT,
            { file_path: '/data/test.csv', count: 42 },
            '/packages/csv-analyzer'
        );

        expect(cmd).toContain('--count');
        expect(cmd).toContain('42');
    });

    it('不应包含未在 Contract 中声明的参数', () => {
        const shell = createMockShellExecute();
        const executor = new ExternalExecutor(shell);

        const cmd = executor.buildCommand(
            BASE_CONTRACT,
            { file_path: '/data/test.csv', unknown: 'value' },
            '/packages/csv-analyzer'
        );

        expect(cmd).not.toContain('--unknown');
    });

    it('Bash runtime 应该使用 bash 解释器', () => {
        const shell = createMockShellExecute();
        const executor = new ExternalExecutor(shell);

        const bashContract: ExecutionContract = {
            ...BASE_CONTRACT,
            runtime: 'bash',
            entry: 'run.sh',
        };

        const cmd = executor.buildCommand(
            bashContract,
            {},
            '/packages/my-tool'
        );

        // Bash runtime 使用 bash 解释器
        expect(cmd).toMatch(/^bash\s/);
    });

    it('Node runtime 应该使用 node 解释器', () => {
        const shell = createMockShellExecute();
        const executor = new ExternalExecutor(shell);

        const nodeContract: ExecutionContract = {
            ...BASE_CONTRACT,
            runtime: 'node',
            entry: 'run.js',
        };

        const cmd = executor.buildCommand(
            nodeContract,
            {},
            '/packages/my-tool'
        );

        expect(cmd).toMatch(/^node\s/);
    });
});

// ==================== execute 测试 ====================

describe('ExternalExecutor.execute', () => {
    it('成功执行应该返回正确结果', async () => {
        const shell = createMockShellExecute({
            exitCode: 0,
            stdout: '分析完成: 100 行数据',
            stderr: '',
        });
        const executor = new ExternalExecutor(shell);

        const result = await executor.execute(
            BASE_CONTRACT,
            { file_path: '/data/test.csv' },
            '/packages/csv-analyzer',
            '/runtime/.venv'
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('100 行数据');
        expect(result.stderr).toBe('');
        expect(result.timedOut).toBe(false);
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('应在返回 Script Skill observation 前脱敏 broker 与凭据内容', async () => {
        const shell = createMockShellExecute({
            exitCode: 0,
            stdout: [
                'AGENTVIS_BROKER_TOKEN=secret-token',
                'HTTP_PROXY=http://127.0.0.1:49152',
                'Authorization: Bearer abc123',
                'api_key=sk-test',
            ].join('\n'),
            stderr: 'Cookie: sid=secret',
        });
        const executor = new ExternalExecutor(shell);

        const result = await executor.execute(
            BASE_CONTRACT,
            { file_path: '/data/test.csv' },
            '/packages/csv-analyzer'
        );

        expect(result.stdout).not.toContain('secret-token');
        expect(result.stdout).not.toContain('49152');
        expect(result.stdout).not.toContain('abc123');
        expect(result.stdout).not.toContain('sk-test');
        expect(result.stderr).not.toContain('sid=secret');
        expect(result.stdout).toContain('AGENTVIS_BROKER_TOKEN=');
    });

    it('执行失败应该返回非零退出码', async () => {
        const shell = createMockShellExecute({
            exitCode: 1,
            stdout: '',
            stderr: 'FileNotFoundError: /data/missing.csv',
        });
        const executor = new ExternalExecutor(shell);

        const result = await executor.execute(
            BASE_CONTRACT,
            { file_path: '/data/missing.csv' },
            '/packages/csv-analyzer'
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('FileNotFoundError');
        expect(result.timedOut).toBe(false);
    });

    it('shell 抛出异常应该捕获并返回错误结果', async () => {
        const shell = vi.fn().mockRejectedValue(new Error('Connection refused'));
        const executor = new ExternalExecutor(shell);

        const result = await executor.execute(
            BASE_CONTRACT,
            { file_path: '/data/test.csv' },
            '/packages/csv-analyzer'
        );

        expect(result.exitCode).toBe(-1);
        expect(result.stderr).toContain('Connection refused');
        expect(result.timedOut).toBe(false);
    });

    it('shell 沙箱阻断应该返回明确的 sandbox 错误', async () => {
        const shell = vi.fn().mockRejectedValue(new Error('Sandbox block: network API was detected in script.'));
        const executor = new ExternalExecutor(shell);

        const result = await executor.execute(
            BASE_CONTRACT,
            { file_path: '/data/test.csv' },
            '/packages/csv-analyzer'
        );

        expect(result.exitCode).toBe(-1);
        expect(result.stderr).toMatch(/Sandbox blocked|沙箱/);
        expect(result.stderr).toContain('network API');
        expect(result.stderr).toContain('SCRIPT_SKILL_SANDBOX_HINT');
        expect(result.timedOut).toBe(false);
    });

    it('隔离模式应该在调用 Shell 前阻断声明桌面控制权限的 Skill', async () => {
        const shell = createMockShellExecute();
        const executor = new ExternalExecutor(shell);

        const result = await executor.execute(
            {
                ...BASE_CONTRACT,
                permissions: { desktopControl: true },
            },
            { file_path: '/test.csv' },
            '/packages/desktop-control',
            undefined,
            { sandboxMode: 'OfflineIsolated' }
        );

        expect(shell).not.toHaveBeenCalled();
        expect(result.exitCode).toBe(-1);
        expect(result.stderr).toMatch(/Sandbox blocked|沙箱/);
        expect(result.timedOut).toBe(false);
    });

    it('超时异常应该正确标记', async () => {
        const shell = vi.fn().mockRejectedValue(new Error('command timed out'));
        const executor = new ExternalExecutor(shell);

        const result = await executor.execute(
            BASE_CONTRACT,
            { file_path: '/data/test.csv' },
            '/packages/csv-analyzer'
        );

        expect(result.exitCode).toBe(-1);
        expect(result.timedOut).toBe(true);
    });

    it('结构化超时结果应该正确标记', async () => {
        const shell = createMockShellExecute({
            exitCode: -1,
            stdout: 'downloaded 80%',
            stderr: 'Command execution timed out (1200s): download-model',
            timedOut: true,
            terminated: true,
            durationMs: 1200000,
            timeoutSecs: 1200,
        });
        const executor = new ExternalExecutor(shell);

        const result = await executor.execute(
            BASE_CONTRACT,
            { file_path: '/data/test.csv' },
            '/packages/csv-analyzer'
        );

        expect(result.exitCode).toBe(-1);
        expect(result.stdout).toContain('downloaded 80%');
        expect(result.timedOut).toBe(true);
    });

    it('超长输出应该被截取', async () => {
        // 构造一个超出 maxOutput 的输出
        const longOutput = 'x'.repeat(100);
        const contractWithSmallLimit: ExecutionContract = {
            ...BASE_CONTRACT,
            maxOutput: 50,
        };

        const shell = createMockShellExecute({
            exitCode: 0,
            stdout: longOutput,
            stderr: '',
        });
        const executor = new ExternalExecutor(shell);

        const result = await executor.execute(
            contractWithSmallLimit,
            { file_path: '/data/test.csv' },
            '/packages/csv-analyzer'
        );

        expect(result.stdout.length).toBeLessThanOrEqual(contractWithSmallLimit.maxOutput);
        expect(result.stdout).toContain('output truncated');
    });

    it('应该将正确的 timeout 传递给 Shell', async () => {
        const shell = createMockShellExecute();
        const executor = new ExternalExecutor(shell);

        const customContract: ExecutionContract = {
            ...BASE_CONTRACT,
            timeout: 120,
        };

        await executor.execute(
            customContract,
            { file_path: '/test.csv' },
            '/packages/csv-analyzer'
        );

        expect(shell).toHaveBeenCalledWith(
            expect.objectContaining({ timeout: 120 })
        );
    });

    it('默认应该以外部 Skill 网络审计沙箱执行', async () => {
        const shell = createMockShellExecute();
        const executor = new ExternalExecutor(shell);

        await executor.execute(
            BASE_CONTRACT,
            { file_path: '/test.csv' },
            '/packages/csv-analyzer'
        );

        expect(shell).toHaveBeenCalledWith(
            expect.objectContaining({
                sandboxLevel: 'externalSkill',
                sandboxNetwork: 'audit',
                sandboxMode: 'LocalAudit',
                processLifecycle: 'managed',
                subjectType: 'skill',
                subjectId: 'csv-analyzer',
            })
        );
    });

    it('显式拒绝网络权限时应该禁网执行', async () => {
        const shell = createMockShellExecute();
        const executor = new ExternalExecutor(shell);

        await executor.execute(
            {
                ...BASE_CONTRACT,
                permissions: { network: false },
            },
            { file_path: '/test.csv' },
            '/packages/csv-analyzer'
        );

        expect(shell).toHaveBeenCalledWith(
            expect.objectContaining({
                sandboxLevel: 'externalSkill',
                sandboxNetwork: 'blocked',
                processLifecycle: 'managed',
            })
        );
    });

    it('联网隔离模式下显式拒绝网络权限时应保持禁网执行', async () => {
        const shell = createMockShellExecute();
        const executor = new ExternalExecutor(shell);

        await executor.execute(
            {
                ...BASE_CONTRACT,
                permissions: { network: false },
            },
            { file_path: '/test.csv' },
            '/packages/csv-analyzer',
            undefined,
            { sandboxMode: 'ControlledNetwork' }
        );

        expect(shell).toHaveBeenCalledWith(
            expect.objectContaining({
                sandboxMode: 'ControlledNetwork',
                sandboxLevel: 'restricted',
                sandboxNetwork: 'blocked',
                networkScope: 'blocked',
                processLifecycle: 'managed',
            })
        );
    });

    it('maps filesystem fromArg permissions to AppContainer grants', async () => {
        const shell = createMockShellExecute();
        const executor = new ExternalExecutor(shell);

        await executor.execute(
            {
                ...BASE_CONTRACT,
                permissions: {
                    network: false,
                    filesystem: [{ fromArg: 'file_path', access: 'readWrite' }],
                },
            },
            { file_path: 'C:/Users/Muulo/Downloads' },
            '/packages/file-organizer',
            undefined,
            { sandboxMode: 'ControlledNetwork' }
        );

        expect(shell).toHaveBeenCalledWith(
            expect.objectContaining({
                sandboxMode: 'ControlledNetwork',
                sandboxLevel: 'restricted',
                sandboxNetwork: 'blocked',
                appContainerFilesystemGrants: [
                    {
                        path: 'C:/Users/Muulo/Downloads',
                        access: 'readWrite',
                    },
                ],
            })
        );
    });

    it('brokerOnly 网络模式应阻断直连并注入 broker 环境标记', async () => {
        const shell = createMockShellExecute();
        const executor = new ExternalExecutor(shell);

        await executor.execute(
            {
                ...BASE_CONTRACT,
                permissions: { networkMode: 'brokerOnly' },
            },
            { file_path: '/test.csv' },
            '/packages/csv-analyzer',
            undefined,
            { sandboxMode: 'ControlledNetwork' }
        );

        expect(shell).toHaveBeenCalledWith(
            expect.objectContaining({
                sandboxMode: 'ControlledNetwork',
                sandboxLevel: 'restricted',
                sandboxNetwork: 'blocked',
                networkScope: 'blocked',
                env: {
                    AGENTVIS_BROKER_MODE: 'explicit',
                    AGENTVIS_NETWORK_BROKER_MODE: 'required',
                    AGENTVIS_NETWORK_DIRECT_ACCESS: 'blocked',
                },
            })
        );
    });

    it('passes broker credential policies to shell without putting secrets in env', async () => {
        const shell = createMockShellExecute();
        const executor = new ExternalExecutor(shell);
        const credentials = [
            {
                id: 'github',
                provider: 'github',
                mode: 'brokerAuth' as const,
                hosts: ['api.github.com'],
                headerName: 'Authorization',
                headerValuePrefix: 'Bearer ',
                required: false,
            },
        ];

        await executor.execute(
            {
                ...BASE_CONTRACT,
                permissions: { network: true, networkMode: 'brokerOnly' },
                credentials,
            },
            { file_path: '/test.csv' },
            '/packages/github-lookup',
            undefined,
            { sandboxMode: 'ControlledNetwork' }
        );

        expect(shell).toHaveBeenCalledWith(
            expect.objectContaining({
                networkBrokerCredentials: credentials,
                env: {
                    AGENTVIS_BROKER_MODE: 'explicit',
                    AGENTVIS_NETWORK_BROKER_MODE: 'required',
                    AGENTVIS_NETWORK_DIRECT_ACCESS: 'blocked',
                },
            })
        );
        expect(shell).toHaveBeenCalledWith(
            expect.not.objectContaining({
                env: expect.objectContaining({
                    GITHUB_TOKEN: expect.any(String),
                    GH_TOKEN: expect.any(String),
                    Authorization: expect.any(String),
                }),
            })
        );
    });

    it('brokerProxyPreferred 声明应注入 WFP fallback 环境标记', async () => {
        const shell = createMockShellExecute();
        const executor = new ExternalExecutor(shell);

        await executor.execute(
            BASE_CONTRACT,
            { file_path: '/test.csv' },
            '/packages/csv-analyzer',
            undefined,
            {
                sandboxMode: 'ControlledNetwork',
                networkFallback: 'brokerProxyPreferred',
            }
        );

        expect(shell).toHaveBeenCalledWith(
            expect.objectContaining({
                sandboxMode: 'ControlledNetwork',
                sandboxNetwork: 'audit',
                networkScope: 'internetAudit',
                env: {
                    AGENTVIS_NETWORK_EGRESS_GUARD_FALLBACK: 'brokerProxyPreferred',
                },
            })
        );
    });

    it('有调用方 workdir 时应作为执行目录并注入输出目录环境变量', async () => {
        const shell = createMockShellExecute();
        const executor = new ExternalExecutor(shell);

        await executor.execute(
            BASE_CONTRACT,
            { file_path: '/test.csv' },
            '/packages/csv-analyzer',
            undefined,
            {
                workdir: '/agent/workdir',
            }
        );

        expect(shell).toHaveBeenCalledWith(
            expect.objectContaining({
                workdir: '/agent/workdir',
                env: {
                    AGENTVIS_WORKDIR: '/agent/workdir',
                    AGENTVIS_DELIVERABLE_DIR: '/agent/workdir',
                    AGENTVIS_SKILL_PACKAGE_DIR: '/packages/csv-analyzer',
                },
            })
        );
    });

    it('aborting signal should request shell cancellation', async () => {
        const controller = new AbortController();
        let resolveShell!: (value: { exitCode: number; stdout: string; stderr: string }) => void;
        const shell = vi.fn((params: Parameters<ShellExecuteFn>[0]) => {
            expect(params.command).toContain('scripts/analyze.py');
            return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
                resolveShell = resolve;
            });
        });
        const executor = new ExternalExecutor(shell as ShellExecuteFn);

        const execution = executor.execute(
            BASE_CONTRACT,
            { file_path: '/test.csv' },
            '/packages/csv-analyzer',
            undefined,
            { signal: controller.signal }
        );

        await vi.waitFor(() => expect(shell).toHaveBeenCalledTimes(1));
        const shellParams = shell.mock.calls[0]?.[0];
        expect(shellParams?.executionId).toMatch(/^external-skill-csv-analyzer-/);

        controller.abort();

        await vi.waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('shell_cancel', {
                executionId: shellParams?.executionId,
            })
        );

        resolveShell({ exitCode: 1, stdout: 'late output', stderr: 'cancelled' });
        const result = await execution;

        expect(result).toMatchObject({
            exitCode: -1,
            stdout: '',
            timedOut: false,
        });
        expect(result.stderr).toBeTruthy();
    });

    it('声明网络权限时应该继承网络访问', async () => {
        const shell = createMockShellExecute();
        const executor = new ExternalExecutor(shell);

        await executor.execute(
            {
                ...BASE_CONTRACT,
                permissions: { network: true },
            },
            { file_path: '/test.csv' },
            '/packages/csv-analyzer'
        );

        expect(shell).toHaveBeenCalledWith(
            expect.objectContaining({
                sandboxLevel: 'externalSkill',
                sandboxNetwork: 'inherit',
                processLifecycle: 'managed',
            })
        );
    });

    it('本机审计模式下声明桌面控制权限时应该使用 detached lifecycle', async () => {
        const shell = createMockShellExecute();
        const executor = new ExternalExecutor(shell);

        await executor.execute(
            {
                ...BASE_CONTRACT,
                permissions: { desktopControl: true },
            },
            { file_path: '/test.csv' },
            '/packages/desktop-control',
            undefined,
            { sandboxMode: 'LocalAudit' }
        );

        expect(shell).toHaveBeenCalledWith(
            expect.objectContaining({
                sandboxMode: 'LocalAudit',
                processLifecycle: 'detachedLaunch',
                subjectType: 'skill',
                subjectId: 'desktop-control',
            })
        );
    });

    it('声明桌面启动权限时应该使用 detached lifecycle', async () => {
        const shell = createMockShellExecute();
        const executor = new ExternalExecutor(shell);

        await executor.execute(
            {
                ...BASE_CONTRACT,
                permissions: { desktopLaunch: true },
            },
            { file_path: '/test.csv' },
            '/packages/gui-launcher'
        );

        expect(shell).toHaveBeenCalledWith(
            expect.objectContaining({
                processLifecycle: 'detachedLaunch',
                subjectType: 'skill',
                subjectId: 'gui-launcher',
            })
        );
    });

    it('sandbox reason code should map proxy bypass blocks to recovery guidance', async () => {
        const shell = vi.fn().mockRejectedValue(
            new Error('Sandbox block [proxy_bypass_signal_blocked]: proxy bypass signal detected.')
        );
        const executor = new ExternalExecutor(shell);

        const result = await executor.execute(
            BASE_CONTRACT,
            { file_path: '/data/test.csv' },
            '/packages/csv-analyzer'
        );

        expect(result.exitCode).toBe(-1);
        expect(result.stderr).toContain('direct-audit');
        expect(result.stderr).toContain('proxy_bypass_signal_blocked');
    });

    it('network upload checkpoint should request confirmation and retry once', async () => {
        vi.mocked(requestNetworkUploadAuthorization).mockResolvedValueOnce(true);
        const shell = vi.fn()
            .mockRejectedValueOnce(
                new Error('Sandbox block [network_upload_confirmation_required]: upload detected.')
            )
            .mockResolvedValueOnce({
                exitCode: 0,
                stdout: 'ok',
                stderr: '',
            });
        const executor = new ExternalExecutor(shell);

        const result = await executor.execute(
            BASE_CONTRACT,
            { file_path: '/data/test.csv' },
            '/packages/csv-analyzer',
            undefined,
            { sandboxMode: 'ControlledNetwork' }
        );

        expect(result.exitCode).toBe(0);
        expect(requestNetworkUploadAuthorization).toHaveBeenCalledWith(
            expect.objectContaining({
                subjectType: 'skill',
                subjectId: 'csv-analyzer',
                reasonCode: 'network_upload_confirmation_required',
            })
        );
        expect(shell).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                networkUploadConfirmed: true,
            })
        );
    });

    it('remote destructive checkpoint should request confirmation and retry once', async () => {
        vi.mocked(requestNetworkUploadAuthorization).mockResolvedValueOnce(true);
        const shell = vi.fn()
            .mockRejectedValueOnce(
                new Error('Sandbox block [network_remote_destructive_confirmation_required]: delete detected.')
            )
            .mockResolvedValueOnce({
                exitCode: 0,
                stdout: 'ok',
                stderr: '',
            });
        const executor = new ExternalExecutor(shell);

        const result = await executor.execute(
            BASE_CONTRACT,
            { file_path: '/data/test.csv' },
            '/packages/csv-analyzer',
            undefined,
            { sandboxMode: 'ControlledNetwork' }
        );

        expect(result.exitCode).toBe(0);
        expect(requestNetworkUploadAuthorization).toHaveBeenCalledWith(
            expect.objectContaining({
                subjectType: 'skill',
                subjectId: 'csv-analyzer',
                reasonCode: 'network_remote_destructive_confirmation_required',
                riskKind: 'remoteDestructive',
            })
        );
        expect(shell).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                networkRemoteDestructiveConfirmed: true,
            })
        );
    });

    it('legacyNonHttp entrypoint should preflight targets, request authorization, and retry', async () => {
        vi.mocked(invoke).mockResolvedValueOnce({
            targets: [],
            requiredProtocols: [],
        }).mockResolvedValueOnce([
            { protocol: 'imap', host: 'imap.qq.com', port: 993 },
        ]);
        vi.mocked(requestNetworkDirectAuthorization).mockResolvedValueOnce([
            {
                id: 'allow-imap-qq',
                subjectType: 'skill',
                subjectId: 'mail-helper',
                protocol: 'imap',
                host: 'imap.qq.com',
                port: 993,
                scope: 'currentExecution',
                createdAt: 1,
                reason: 'test',
            },
        ]);

        const shell = vi.fn()
            .mockRejectedValueOnce(
                new Error('Sandbox block [proxy_bypass_signal_blocked]: proxy bypass signal detected.')
            )
            .mockResolvedValueOnce({
                exitCode: 0,
                stdout: JSON.stringify({
                    targets: [
                        { protocol: 'imap', host: 'imap.qq.com', port: 993 },
                    ],
                }),
                stderr: '',
            })
            .mockResolvedValueOnce({
                exitCode: 0,
                stdout: 'ok',
                stderr: '',
            });
        const executor = new ExternalExecutor(shell);

        const result = await executor.execute(
            {
                ...BASE_CONTRACT,
                entry: 'scripts/mail.py',
                argsSchema: [
                    { name: 'account', type: 'string', required: true, description: 'account' },
                    { name: 'profile', type: 'string', required: false, description: 'profile' },
                    { name: 'host', type: 'string', required: false, description: 'host' },
                    { name: 'port', type: 'number', required: false, description: 'port' },
                ],
            },
            { account: 'qq', profile: 'redis', host: 'cache.example.com', port: 6380 },
            '/packages/mail-helper',
            undefined,
            {
                sandboxMode: 'ControlledNetwork',
                networkEntrypointMode: 'legacyNonHttp',
                enableNetworkDirectAuthorization: true,
            }
        );

        expect(result.exitCode).toBe(0);
        expect(requestNetworkDirectAuthorization).toHaveBeenCalledWith(
            expect.objectContaining({
                subjectType: 'skill',
                subjectId: 'mail-helper',
                targets: [
                    { protocol: 'imap', host: 'imap.qq.com', port: 993 },
                ],
            })
        );
        expect(shell).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                command: expect.stringContaining('--action network_targets'),
            })
        );
        expect(shell).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                command: expect.stringContaining('--account qq'),
            })
        );
        expect(shell).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                command: expect.stringContaining('--profile redis'),
            })
        );
        expect(shell).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                command: expect.stringContaining('--host cache.example.com'),
            })
        );
        expect(shell).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                command: expect.stringContaining('--port 6380'),
            })
        );
        expect(shell).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({
                networkDirectAllowances: [
                    expect.objectContaining({
                        protocol: 'imap',
                        host: 'imap.qq.com',
                        port: 993,
                    }),
                ],
                networkDirectTargets: [
                    { protocol: 'imap', host: 'imap.qq.com', port: 993 },
                ],
            })
        );
    });
});
