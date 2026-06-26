/**
 * ExternalToolProvider 单元测试
 *
 * 覆盖场景：
 * - Script 模式 Skill 注册为 Tool
 * - ToolSchema 正确生成
 * - 执行成功/失败
 * - 参数验证拦截
 * - Guide 模式 Skill 注册拒绝
 */

import { describe, it, expect, vi } from 'vitest';
import { ExternalToolProvider } from '../ExternalToolProvider';
import type { LoadedExternalSkill } from '../types';
import type { ShellExecuteFn } from '../ExternalExecutor';
import type { ToolExecutionContext } from '../../../tools/types';

// ==================== 测试数据 ====================

const MOCK_SCRIPT_SKILL: LoadedExternalSkill = {
    name: 'csv-analyzer',
    description: '分析 CSV 文件并生成统计报告',
    mode: 'script',
    packagePath: '/packages/csv-analyzer',
    fullContent: '# CSV Analyzer\n工具文档。',
    contract: {
        runtime: 'python',
        entry: 'scripts/analyze.py',
        timeout: 60,
        maxOutput: 65536,
        argsSchema: [
            { name: 'file_path', type: 'string', required: true, description: 'CSV 文件路径' },
            { name: 'columns', type: 'string', required: false, description: '逗号分隔的列名' },
        ],
    },
    enabled: true,
};

const MOCK_GUIDE_SKILL: LoadedExternalSkill = {
    name: 'pdf',
    description: 'PDF 处理指南',
    mode: 'guide',
    packagePath: '/packages/pdf',
    fullContent: '# PDF Guide\n使用 pypdf 处理 PDF。',
    enabled: true,
};

const MOCK_CONTEXT: ToolExecutionContext = {
    workdir: '/test',
};

function createMockShell(
    response = { exitCode: 0, stdout: '分析完成', stderr: '' }
): ShellExecuteFn {
    return vi.fn().mockResolvedValue(response);
}

// ==================== 测试 ====================

describe('ExternalToolProvider', () => {
    describe('注册', () => {
        it('应该成功注册 Script 模式 Skill', () => {
            const provider = new ExternalToolProvider(createMockShell());
            provider.registerSkill(MOCK_SCRIPT_SKILL);

            expect(provider.size).toBe(1);
            expect(provider.supports('csv-analyzer')).toBe(true);
        });

        it('注册 Guide 模式 Skill 应该抛出错误', () => {
            const provider = new ExternalToolProvider(createMockShell());

            expect(() => {
                provider.registerSkill(MOCK_GUIDE_SKILL);
            }).toThrow('Script-mode');
        });

        it('多个 Skill 可以同时注册', () => {
            const provider = new ExternalToolProvider(createMockShell());

            const skill2: LoadedExternalSkill = {
                ...MOCK_SCRIPT_SKILL,
                name: 'image-processor',
                contract: {
                    ...MOCK_SCRIPT_SKILL.contract!,
                    entry: 'scripts/process.py',
                },
            };

            provider.registerSkill(MOCK_SCRIPT_SKILL);
            provider.registerSkill(skill2);

            expect(provider.size).toBe(2);
            expect(provider.supports('csv-analyzer')).toBe(true);
            expect(provider.supports('image-processor')).toBe(true);
        });
    });

    describe('ToolSchema 生成', () => {
        it('应该从 Contract 正确生成 ToolSchema', () => {
            const provider = new ExternalToolProvider(createMockShell());
            provider.registerSkill(MOCK_SCRIPT_SKILL);

            const schemas = provider.getSchemas();
            expect(schemas).toHaveLength(1);

            const schema = schemas[0]!;
            expect(schema.name).toBe('csv-analyzer');
            expect(schema.description).toBe('分析 CSV 文件并生成统计报告');
            expect(schema.parameters.properties.file_path).toBeDefined();
            expect(schema.parameters.properties.file_path!.type).toBe('string');
            expect(schema.parameters.required).toContain('file_path');
            expect(schema.parameters.required).not.toContain('columns');
        });
    });

    describe('执行', () => {
        it('成功执行应该返回 success ToolResult', async () => {
            const shell = createMockShell({
                exitCode: 0,
                stdout: '总行数: 1000\n平均值: 42.5',
                stderr: '',
            });
            const provider = new ExternalToolProvider(shell, '/runtime/.venv');
            provider.registerSkill(MOCK_SCRIPT_SKILL);

            const result = await provider.execute(
                'csv-analyzer',
                { file_path: '/data/sales.csv' },
                MOCK_CONTEXT
            );

            expect(result.success).toBe(true);
            expect(result.content).toContain('csv-analyzer');
            expect(result.content).toContain('1000');
        });

        it('执行失败应该返回 failure ToolResult', async () => {
            const shell = createMockShell({
                exitCode: 1,
                stdout: '',
                stderr: 'FileNotFoundError: /data/missing.csv',
            });
            const provider = new ExternalToolProvider(shell);
            provider.registerSkill(MOCK_SCRIPT_SKILL);

            const result = await provider.execute(
                'csv-analyzer',
                { file_path: '/data/missing.csv' },
                MOCK_CONTEXT
            );

            expect(result.success).toBe(false);
            expect(result.content).toContain('FileNotFoundError');
        });

        it('参数验证失败应该拦截执行', async () => {
            const shell = createMockShell();
            const provider = new ExternalToolProvider(shell);
            provider.registerSkill(MOCK_SCRIPT_SKILL);

            // 缺少必填参数 file_path
            const result = await provider.execute(
                'csv-analyzer',
                { columns: 'name,age' },
                MOCK_CONTEXT
            );

            expect(result.success).toBe(false);
            expect(result.content).toContain('parameter validation failed');
            expect(result.content).toContain('file_path');
            // Shell 不应该被调用
            expect(shell).not.toHaveBeenCalled();
        });

        it('未注册的工具应该返回错误', async () => {
            const provider = new ExternalToolProvider(createMockShell());

            const result = await provider.execute(
                'nonexistent-tool',
                {},
                MOCK_CONTEXT
            );

            expect(result.success).toBe(false);
            expect(result.content).toContain('未注册');
        });
        it('agentvisNetworkEntrypoints brokerProxyPreferred should inject network fallback for matching entry', async () => {
            const shell = createMockShell();
            const provider = new ExternalToolProvider(shell);
            provider.registerSkill({
                ...MOCK_SCRIPT_SKILL,
                agentvisNetworkEntrypoints: {
                    'scripts/analyze.py': 'brokerProxyPreferred',
                },
            });

            await provider.execute(
                'csv-analyzer',
                { file_path: '/data/sales.csv' },
                { ...MOCK_CONTEXT, sandboxMode: 'ControlledNetwork' }
            );

            expect(shell).toHaveBeenCalledWith(
                expect.objectContaining({
                    workdir: '/test',
                    env: {
                        AGENTVIS_WORKDIR: '/test',
                        AGENTVIS_DELIVERABLE_DIR: '/test',
                        AGENTVIS_SKILL_PACKAGE_DIR: '/packages/csv-analyzer',
                        AGENTVIS_NETWORK_EGRESS_GUARD_FALLBACK: 'brokerProxyPreferred',
                    },
                })
            );
        });

        it('agentvisNetworkEntrypoints legacyNonHttp should override top-level network fallback', async () => {
            const shell = createMockShell();
            const provider = new ExternalToolProvider(shell);
            provider.registerSkill({
                ...MOCK_SCRIPT_SKILL,
                agentvisNetwork: 'brokerProxyPreferred',
                agentvisNetworkEntrypoints: {
                    'scripts/analyze.py': 'legacyNonHttp',
                },
            });

            await provider.execute(
                'csv-analyzer',
                { file_path: '/data/sales.csv' },
                { ...MOCK_CONTEXT, sandboxMode: 'ControlledNetwork' }
            );

            expect(shell).toHaveBeenCalledWith(
                expect.objectContaining({
                    env: expect.not.objectContaining({
                        AGENTVIS_NETWORK_EGRESS_GUARD_FALLBACK: expect.any(String),
                    }),
                })
            );
        });
    });

    describe('getAllTools', () => {
        it('应该返回所有注册的 Tool 实例', () => {
            const provider = new ExternalToolProvider(createMockShell());
            provider.registerSkill(MOCK_SCRIPT_SKILL);

            const tools = provider.getAllTools();
            expect(tools).toHaveLength(1);
            expect(tools[0]!.schema.name).toBe('csv-analyzer');
        });
    });
});
