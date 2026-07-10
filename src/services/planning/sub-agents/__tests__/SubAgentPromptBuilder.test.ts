/**
 * SubAgentPromptBuilder 单元测试
 *
 * 测试 Prompt 构建和上下文隔离
 *
 * 设计说明：
 * 移除固定分类后，不再有 type 属性和 getTypeTemplate。
 * behaviorHint（careful/direct）替代旧的 research/execution/verification 模板。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SAFETY_FOOTER_TEXT, SubAgentPromptBuilder, subAgentPromptBuilder } from '../SubAgentPromptBuilder';
import type { SubAgentSpec, ExternalGuideSkillInfo, ExternalScriptSkillInfo } from '../../brain/types';
import type { TaskContext } from '../types';
import { resolveOutputLanguage } from '@services/language/OutputLanguagePolicy';

describe('SubAgentPromptBuilder', () => {
    let builder: SubAgentPromptBuilder;

    beforeEach(() => {
        builder = new SubAgentPromptBuilder();
    });

    const createMockSpec = (overrides: Partial<SubAgentSpec> = {}): SubAgentSpec => ({
        role: '测试角色',
        allowedTools: ['read'],
        terminationCondition: '完成后返回',
        ...overrides,
    });

    const createMockContext = (overrides: Partial<TaskContext> = {}): TaskContext => ({
        files: [{ name: 'src/test.ts', size: '2.0KB', modified: '2026-03-08 12:00' }],
        cwd: '/project',
        ...overrides,
    });

    // ───────────────────────────────────────────────────────
    // build - Prompt 构建
    // ───────────────────────────────────────────────────────

    describe('build', () => {
        it('应构建完整的 Prompt', () => {
            const spec = createMockSpec();
            const context = createMockContext();

            const prompt = builder.build(spec, context, []);

            // 应包含基础模板内容
            expect(prompt).toContain('Sub-Agent');
            expect(prompt).toContain('Prime Directive');
            // 应包含任务信息
            expect(prompt).toContain('测试角色');
            expect(prompt).toContain('read');
        });

        it('should resolve the delegated task output language independently from MB', () => {
            const spec = createMockSpec({
                role: 'Translation agent',
                contextSummary: '请翻译“新しい製品を作る”这一段为中文。',
            });

            const prompt = builder.build(spec, createMockContext(), []);

            expect(prompt).toContain('[OUTPUT_LANGUAGE]');
            expect(prompt).toContain('Resolved output language: Simplified Chinese');
            expect(prompt).toContain('explicitly requires Simplified Chinese');
        });

        it('should preserve the language hint resolved from the original user request', () => {
            const spec = createMockSpec({
                role: 'English implementation agent',
                contextSummary: 'Implement the delegated task.',
                outputLanguageHint: resolveOutputLanguage(
                    'Please provide the deliverable in French.',
                    { useRuntimePreference: false }
                ),
            });

            const prompt = builder.build(spec, createMockContext(), []);

            expect(prompt).toContain('Resolved output language: French');
            expect(prompt).toContain('explicitly requires French');
        });

        it('应根据 behaviorHint=careful 注入谨慎模式模板', () => {
            const spec = createMockSpec({ behaviorHint: 'careful' });
            const prompt = builder.build(spec, createMockContext(), []);

            // careful 模板关键词
            expect(prompt).toContain('Careful Mode');
            expect(prompt).toContain('Inspect before modifying');
        });

        it('应根据 behaviorHint=direct 注入直接模式模板', () => {
            const spec = createMockSpec({ behaviorHint: 'direct' });
            const prompt = builder.build(spec, createMockContext(), []);

            // direct 模板关键词
            expect(prompt).toContain('Direct Mode');
            expect(prompt).toContain('Execute task steps in order');
        });

        it('无 behaviorHint 时不应注入行为模板', () => {
            const spec = createMockSpec();
            const prompt = builder.build(spec, createMockContext(), []);

            expect(prompt).not.toContain('Careful Mode');
            expect(prompt).not.toContain('Direct Mode');
        });

        it('应包含允许的工具列表', () => {
            const spec = createMockSpec({ allowedTools: ['read', 'web_search'] });
            const prompt = builder.build(spec, createMockContext(), []);

            expect(prompt).toContain('`read`');
            expect(prompt).toContain('`web_search`');
        });

        it('LocalAudit sandbox mode should not inject sandbox runtime context', () => {
            const spec = createMockSpec();
            const prompt = builder.build(spec, createMockContext({ sandboxMode: 'LocalAudit' }), []);

            expect(prompt).not.toContain('[SANDBOX_RUNTIME_CONTEXT]');
        });

        it('ControlledNetwork sandbox mode should inject sandbox runtime context', () => {
            const spec = createMockSpec();
            const prompt = builder.build(spec, createMockContext({ sandboxMode: 'ControlledNetwork' }), []);

            expect(prompt).toContain('[SANDBOX_RUNTIME_CONTEXT]');
            expect(prompt).toContain('ControlledNetwork');
            expect(prompt).toContain('127.0.0.1');
        });

        it('OfflineIsolated sandbox mode should inject sandbox runtime context', () => {
            const spec = createMockSpec();
            const prompt = builder.build(spec, createMockContext({ sandboxMode: 'OfflineIsolated' }), []);

            expect(prompt).toContain('[SANDBOX_RUNTIME_CONTEXT]');
            expect(prompt).toContain('OfflineIsolated');
        });



        it('应在 includeConstraints=false 时跳过基础模板', () => {
            const spec = createMockSpec({ behaviorHint: 'careful' });
            const prompt = builder.build(spec, createMockContext(), [], {
                includeConstraints: false,
            });

            // 不应包含基础约束的详细内容
            expect(prompt).not.toContain('Absolutely forbidden');
            // 但应包含行为修饰符
            expect(prompt).toContain('Careful Mode');
        });

        it('loopConfig 存在时 system prompt 不应包含 SAFETY_FOOTER（已迁移到 LLMCaller 末尾 user 消息）', () => {
            // SAFETY_FOOTER_TEXT 已从 build() 移出，改由 SubAgentLLMCaller.buildMessagesWithContext 每步注入
            // 此测试确保 build() 不再将其注入 system prompt，防止误回退
            const spec = createMockSpec({
                loopConfig: {
                    maxSteps: 10,
                    initialBudget: 3,
                    checkpointInterval: 999,
                    terminationPatterns: ['TASK_COMPLETE'],
                },
            });
            const prompt = builder.build(spec, createMockContext(), []);

            // SAFETY_FOOTER_TEXT 不应作为完整尾部约束出现在 system prompt 中
            expect(prompt).not.toContain(SAFETY_FOOTER_TEXT);
        });

        it('无 loopConfig 时同样不应包含 SAFETY_FOOTER', () => {
            const spec = createMockSpec();
            const prompt = builder.build(spec, createMockContext(), []);

            expect(prompt).not.toContain(SAFETY_FOOTER_TEXT);
        });

    });

    // ───────────────────────────────────────────────────────
    // 上下文隔离
    // ───────────────────────────────────────────────────────

    describe('上下文隔离', () => {
        it('应过滤敏感字段 userId', () => {
            const spec = createMockSpec();
            const context = createMockContext({
                data: { userId: 'secret-user-123', normalData: 'visible' },
            });

            const prompt = builder.build(spec, context, []);

            expect(prompt).not.toContain('secret-user-123');
            expect(prompt).toContain('normalData');
            expect(prompt).toContain('visible');
        });

        it('应过滤敏感字段 apiKey', () => {
            const spec = createMockSpec();
            const context = createMockContext({
                data: { apiKey: 'sk-secret-key' },
            });

            const prompt = builder.build(spec, context, []);
            expect(prompt).not.toContain('sk-secret-key');
        });

        it('应过滤敏感字段 globalGoal', () => {
            const spec = createMockSpec();
            const context = createMockContext({
                data: { globalGoal: '用户的完整目标' },
            });

            const prompt = builder.build(spec, context, []);
            expect(prompt).not.toContain('用户的完整目标');
        });

        it('应保留正常的 files 和 cwd', () => {
            const spec = createMockSpec();
            const context = createMockContext({
                files: [
                    { name: 'src/app.ts', size: '3.5KB', modified: '2026-03-08 10:00' },
                    { name: 'src/utils.ts', size: '1.8KB', modified: '2026-03-08 11:00' },
                ],
                cwd: '/home/project',
            });

            const prompt = builder.build(spec, context, []);
            expect(prompt).toContain('src/app.ts');
            expect(prompt).toContain('/home/project');
        });

        it('preserves attachment references in the task context', () => {
            const spec = createMockSpec();
            const context = createMockContext({
                attachments: [{
                    fileName: 'spec.md',
                    path: '/project/attachments/spec.md',
                    type: 'document',
                    extension: 'md',
                    sizeBytes: 512,
                }],
                attachmentInstruction: 'Read full attachment paths when needed.',
            });

            const prompt = builder.build(spec, context, []);
            const jsonMatch = prompt.match(/```json\n([\s\S]*?)```/);
            expect(jsonMatch).toBeTruthy();
            const jsonBlock = jsonMatch![1]!;
            expect(jsonBlock).toContain('"attachments"');
            expect(jsonBlock).toContain('/project/attachments/spec.md');
            expect(jsonBlock).toContain('"attachmentInstruction"');
            expect(jsonBlock).toContain('Read full attachment paths when needed.');
        });

        it('应排除 artifactSnapshot 避免 JSON 二次序列化', () => {
            const spec = createMockSpec();
            const context = createMockContext({
                data: {
                    artifactSnapshot: {
                        index: [{ key: 'read_0', toolName: 'read', sourceHint: 'test.txt', estimatedTokens: 10 }],
                        artifacts: [{ key: 'read_0', content: '不应出现在JSON上下文中的内容', toolName: 'read', sourceHint: 'test.txt' }],
                        totalTokens: 10,
                    },
                    normalData: '正常数据',
                },
            });

            const prompt = builder.build(spec, context, []);

            // artifactSection（格式化版）应存在
            expect(prompt).toContain('Previous Task Artifacts');
            // 但 sanitizedContext JSON 块中不应再包含 artifactSnapshot
            // 通过检查 JSON 块中不含 artifact 的 content 来验证
            const jsonMatch = prompt.match(/```json\n([\s\S]*?)```/);
            expect(jsonMatch).toBeTruthy();
            const jsonBlock = jsonMatch![1]!;
            expect(jsonBlock).not.toContain('artifactSnapshot');
            expect(jsonBlock).not.toContain('不应出现在JSON上下文中的内容');
            // normalData 应保留
            expect(jsonBlock).toContain('normalData');
        });

        it('应排除 recentToolResults 和 agentRules 避免 JSON 二次序列化', () => {
            const spec = createMockSpec();
            const context = createMockContext({
                data: {
                    recentToolResults: [{ name: 'sub_agent', content: '前序SA的完整输出' }],
                    agentRules: '用户规则',
                    customField: '保留字段',
                },
            });

            const prompt = builder.build(spec, context, []);

            const jsonMatch = prompt.match(/```json\n([\s\S]*?)```/);
            expect(jsonMatch).toBeTruthy();
            const jsonBlock = jsonMatch![1]!;
            // recentToolResults 和 agentRules 均不应出现在 JSON 块中
            expect(jsonBlock).not.toContain('recentToolResults');
            expect(jsonBlock).not.toContain('前序SA的完整输出');
            expect(jsonBlock).not.toContain('agentRules');
            // 其他普通字段应保留
            expect(jsonBlock).toContain('customField');
        });
    });


    // ───────────────────────────────────────────────────────
    // getBehaviorTemplate (替代旧 getTypeTemplate)
    // ───────────────────────────────────────────────────────

    describe('getBehaviorTemplate', () => {
        it('should 返回 careful 模板', () => {
            const template = builder.getBehaviorTemplate('careful');
            expect(template).toBeDefined();
            expect(template).toContain('Careful Mode');
        });

        it('应返回 direct 模板', () => {
            const template = builder.getBehaviorTemplate('direct');
            expect(template).toBeDefined();
            expect(template).toContain('Direct Mode');
        });

        it('未知 hint 应返回 undefined', () => {
            expect(builder.getBehaviorTemplate('unknown')).toBeUndefined();
        });
    });

    // ───────────────────────────────────────────────────────
    // getBaseTemplate
    // ───────────────────────────────────────────────────────

    describe('getBaseTemplate', () => {
        it('应返回基础模板', () => {
            const base = builder.getBaseTemplate();
            expect(base).toContain('Sub-Agent');
            expect(base).toContain('Prime Directive');
        });
    });

    // ───────────────────────────────────────────────────────
    // External Guide Section
    // ───────────────────────────────────────────────────────

    describe('External Guide Section', () => {
        const createGuideSkill = (
            name: string,
            description: string,
            fullContent: string = `# ${name}\n\n${description} 详细指南内容。`
        ): ExternalGuideSkillInfo => ({
            name,
            description,
            fullContent,
        });

        it('技能应注入全文到 Sub-Agent', () => {
            const spec = createMockSpec();
            const guides = [
                createGuideSkill('agent-guide', 'Agent 专属指南',
                    '# Agent Guide\n\n使用 Python 脚本处理数据。'),
            ];

            const prompt = builder.build(spec, createMockContext(), [], {}, guides);

            expect(prompt).toContain('External Skill Guides');
            expect(prompt).toContain('agent-guide');
            expect(prompt).toContain('Agent 专属指南');
            // 应注入 fullContent
            expect(prompt).toContain('Python 脚本处理数据');
        });

        it('共享技能应注入全文到 Sub-Agent', () => {
            const spec = createMockSpec();
            const guides = [
                createGuideSkill('shared-guide', '共享指南',
                    '# Shared Guide\n\nAgent 和 MB 共享的内容。'),
            ];

            const prompt = builder.build(spec, createMockContext(), [], {}, guides);

            expect(prompt).toContain('External Skill Guides');
            expect(prompt).toContain('shared-guide');
            expect(prompt).toContain('Agent 和 MB 共享的内容');
        });

        it('所有技能都应注入 Sub-Agent（不再过滤）', () => {
            const spec = createMockSpec();
            const guides = [
                createGuideSkill('master-only', '仅 MB 使用'),
            ];

            const prompt = builder.build(spec, createMockContext(), [], {}, guides);

            // 所有 MB 委派的技能都应注入 SA
            expect(prompt).toContain('master-only');
            expect(prompt).toContain('仅 MB 使用');
            expect(prompt).toContain('External Skill Guides');
        });

        it('无 externalGuideSkills 时不应注入 Guide Section', () => {
            const spec = createMockSpec();
            const prompt = builder.build(spec, createMockContext(), []);

            expect(prompt).not.toContain('External Skill Guides');
        });

        it('空数组时不应注入 Guide Section', () => {
            const spec = createMockSpec();
            const prompt = builder.build(spec, createMockContext(), [], {}, []);

            expect(prompt).not.toContain('External Skill Guides');
        });

        it('混合技能应注入所有 MB 委派的技能', () => {
            const spec = createMockSpec();
            const guides = [
                createGuideSkill('guide-a', 'Agent 用', '# Agent Content'),
                createGuideSkill('guide-m', 'Master 用', '# Master Content'),
                createGuideSkill('guide-b', '共享', '# Both Content'),
            ];

            const prompt = builder.build(spec, createMockContext(), [], {}, guides);

            // 所有技能都应注入
            expect(prompt).toContain('guide-a');
            expect(prompt).toContain('Agent Content');
            expect(prompt).toContain('guide-b');
            expect(prompt).toContain('Both Content');
            expect(prompt).toContain('guide-m');
            expect(prompt).toContain('Master Content');
        });

        it('resourceFiles 应以 <skill> 路径别名列出在 Prompt 中', () => {
            const spec = createMockSpec();
            const guides: ExternalGuideSkillInfo[] = [{
                name: 'theme-factory',
                description: '主题工厂',
                fullContent: '# Theme Factory\n\n主题指南。',
                packagePath: '/path/to/theme-factory',
                resourceFiles: ['themes/arctic-frost.md', 'themes/ocean-depths.md', 'theme-showcase.pdf'],
            }];

            const prompt = builder.build(spec, createMockContext(), [], {}, guides);

            // 应列出资源文件（缩写路径）
            expect(prompt).toContain('Available Resource Files');
            expect(prompt).toContain('Skill Package Path**: `/path/to/theme-factory`');
            expect(prompt).toContain('<skill>/themes/arctic-frost.md');
            expect(prompt).toContain('<skill>/themes/ocean-depths.md');
            expect(prompt).toContain('<skill>/theme-showcase.pdf');
            expect(prompt).not.toContain('/path/to/theme-factory/themes/arctic-frost.md');
            // 无脚本时不应显示脚本使用提示
            expect(prompt).not.toContain('Prefer using the existing scripts');
        });

        it('同时含脚本和资源文件的技能应两者都列出', () => {
            const spec = createMockSpec();
            const guides: ExternalGuideSkillInfo[] = [{
                name: 'full-skill',
                description: '完整技能',
                fullContent: '# Full Skill',
                packagePath: '/pkg',
                scriptFiles: ['scripts/run.py'],
                resourceFiles: ['docs/guide.md'],
            }];

            const prompt = builder.build(spec, createMockContext(), [], {}, guides);

            expect(prompt).toContain('Skill Package Path**: `/pkg`');
            expect(prompt).toContain('Available Scripts');
            expect(prompt).toContain('<skill>/scripts/run.py');
            expect(prompt).toContain('Available Resource Files');
            expect(prompt).toContain('<skill>/docs/guide.md');
            expect(prompt).toContain('Prefer using the existing scripts');
        });

        it('should include uninjected guide and script skills in the installed external skill catalog', () => {
            const spec = createMockSpec({ allowedTools: ['read', 'external_skill_execute'] });
            const guides: ExternalGuideSkillInfo[] = [
                createGuideSkill('selected-guide', 'Selected guide', '# Selected Guide'),
            ];
            const scriptSkills: ExternalScriptSkillInfo[] = [{
                name: 'selected-script',
                description: 'Selected script skill',
                packagePath: 'C:/skills/external/packages/selected-script',
                contract: {
                    runtime: 'python',
                    entry: 'scripts/run.py',
                    timeout: 30,
                    maxOutput: 4096,
                    argsSchema: [],
                },
            }];

            const prompt = builder.build(
                spec,
                createMockContext(),
                [],
                {},
                guides,
                scriptSkills,
                ['selected-guide', 'guide-only', 'script-only', 'selected-script']
            );

            const otherCatalog = prompt
                .split('## Other Available External Skill Packages')[1]
                ?.split('## External Script Skills')[0] ?? '';

            expect(otherCatalog).toContain('- guide-only');
            expect(otherCatalog).toContain('- script-only');
            expect(otherCatalog).not.toContain('- selected-guide');
            expect(otherCatalog).not.toContain('- selected-script');
        });
    });

    describe('External Script Skill Section', () => {
        it('应注入 Script Skill compact contract card', () => {
            const spec = createMockSpec({ allowedTools: ['read', 'external_skill_execute'] });
            const scriptSkills: ExternalScriptSkillInfo[] = [{
                name: 'broker-e2e',
                description: 'Validate broker-only sandbox networking',
                packagePath: 'C:/skills/external/packages/broker-e2e',
                contract: {
                    runtime: 'python',
                    entry: 'scripts/broker_e2e.py',
                    timeout: 45,
                    maxOutput: 65536,
                    argsSchema: [
                        {
                            name: 'url',
                            type: 'string',
                            required: true,
                            description: 'Public URL to fetch through the broker',
                        },
                        {
                            name: 'mode',
                            type: 'string',
                            required: false,
                            description: 'Fetch mode',
                            allowedValues: ['summary', 'full'],
                            default: 'summary',
                        },
                        {
                            name: 'limit',
                            type: 'number',
                            required: false,
                            description: 'Result limit',
                            min: 1,
                            max: 20,
                            default: 10,
                            examples: [5, 10],
                        },
                    ],
                    permissions: { networkMode: 'brokerOnly' },
                },
            }];

            const prompt = builder.build(
                spec,
                createMockContext(),
                [],
                {},
                undefined,
                scriptSkills
            );

            expect(prompt).toContain('External Script Skills');
            expect(prompt).toContain('broker-e2e');
            expect(prompt).toContain('external_skill_execute');
            expect(prompt).toContain('networkMode=brokerOnly');
            expect(prompt).toContain('scripts/broker_e2e.py');
            expect(prompt).toContain('allowed="summary"|"full"');
            expect(prompt).toContain('default="summary"');
            expect(prompt).toContain('range=1..20');
            expect(prompt).toContain('examples=5|10');
            expect(prompt).toContain('"skillName": "broker-e2e"');
            expect(prompt).toContain('"url": "<url>"');
            expect(prompt).toContain('"mode": "summary"');
            expect(prompt).toContain('"limit": 10');
        });
    });

    // ───────────────────────────────────────────────────────
    // Venv 环境约束注入
    // ───────────────────────────────────────────────────────

    describe('Venv 环境约束注入', () => {
        it('提供 venvPythonPath 时应注入 Python 环境约束段', () => {
            const spec = createMockSpec();
            const venvPath = 'C:\\AppData\\runtime\\.venv\\Scripts\\python.exe';

            const prompt = builder.build(
                spec, createMockContext(), [],
                { venvPythonPath: venvPath }
            );

            // 应包含简化后的约束标题
            expect(prompt).toContain('Python Environment');
            // 代码层已保障路径替换，prompt 不再包含完整路径
            expect(prompt).toContain('python');
            // 应包含禁止指令
            expect(prompt).toContain('Do not');
            expect(prompt).toContain('pip install');
        });

        it('不提供 venvPythonPath 时不应注入约束段', () => {
            const spec = createMockSpec();

            const prompt = builder.build(spec, createMockContext(), [], {});

            expect(prompt).not.toContain('Python Environment');
        });

        it('venvPythonPath 为 undefined 时不应注入约束段', () => {
            const spec = createMockSpec();

            const prompt = builder.build(
                spec, createMockContext(), [],
                { venvPythonPath: undefined }
            );

            expect(prompt).not.toContain('Python Environment');
        });

        it('约束段应包含虚拟环境说明和禁止规则', () => {
            const spec = createMockSpec();
            const venvPath = '/appdata/runtime/.venv/bin/python';

            const prompt = builder.build(
                spec, createMockContext(), [],
                { venvPythonPath: venvPath }
            );

            // 应告知 SA 直接使用 python 即可
            expect(prompt).toContain('`python`');
            // 应包含禁止创建新环境的约束
            expect(prompt).toContain('python -m venv');
            expect(prompt).toContain('virtualenv');
        });
    });

    // ───────────────────────────────────────────────────────
    // 运行环境信息注入
    // ───────────────────────────────────────────────────────

    describe('运行环境信息注入', () => {
        // 与生产代码 detectWindowsPlatform() 保持一致：
        // 优先使用 navigator.userAgent（Tauri/浏览器环境），
        // 回退到 process.platform（Node.js 测试环境）
        // 若 jsdom 的 navigator.userAgent 不含 'Windows'，把控 'win32' 才生效
        const isWindows = (() => {
            if (typeof navigator !== 'undefined' && navigator.userAgent) {
                return /Windows/i.test(navigator.userAgent);
            }
            const nodeProcess = (globalThis as { process?: { platform?: string } }).process;
            if (nodeProcess?.platform) {
                return nodeProcess.platform === 'win32';
            }
            return false;
        })();

        it.skipIf(!isWindows)('Windows 环境应注入操作系统信息', () => {
            const spec = createMockSpec();
            const prompt = builder.build(spec, createMockContext(), []);

            expect(prompt).toContain('Runtime Environment');
            expect(prompt).toContain('Windows');
        });

        it.skipIf(!isWindows)('Windows 环境应包含正确命令约束', () => {
            const spec = createMockSpec();
            const prompt = builder.build(spec, createMockContext(), []);

            // 应禁止 Unix 命令
            expect(prompt).toMatch(/Do not.*ls/);
            // 应推荐 Windows 命令
            expect(prompt).toContain('dir');
        });
    });

    // ───────────────────────────────────────────────────────
    // 历史任务经验 Section
    // ───────────────────────────────────────────────────────

    describe('历史任务经验注入', () => {
        it('task_experience 数据存在时应注入经验 Section 含去重提示', () => {
            const spec = createMockSpec();
            const context = createMockContext({
                data: {
                    taskExperiences: [
                        { content: '在 Windows 上使用 dir 代替 ls 命令' },
                        { content: '使用 utf-8 编码读取中文文件避免乱码' },
                    ],
                },
            });

            const prompt = builder.build(spec, context, []);

            // 应包含经验 Section 标题
            expect(prompt).toContain('Historical Task Experience');
            // 应包含经验内容
            expect(prompt).toContain('在 Windows 上使用 dir 代替 ls 命令');
            expect(prompt).toContain('使用 utf-8 编码读取中文文件避免乱码');
            // 应包含去重提示
            expect(prompt).toContain('do not report it again');
        });

        it('task_experience 为空数组时不应注入经验 Section', () => {
            const spec = createMockSpec();
            const context = createMockContext({
                data: { taskExperiences: [] },
            });

            const prompt = builder.build(spec, context, []);

            expect(prompt).not.toContain('Historical Task Experience');
        });

        it('task_experience 为 undefined 时不应注入经验 Section', () => {
            const spec = createMockSpec();
            const context = createMockContext();

            const prompt = builder.build(spec, context, []);

            expect(prompt).not.toContain('Historical Task Experience');
        });

        it('taskExperiences 不应出现在 sanitizedContext JSON 块中', () => {
            const spec = createMockSpec();
            const context = createMockContext({
                data: {
                    taskExperiences: [
                        { content: '不应出现在JSON中的经验' },
                    ],
                    normalData: '正常数据',
                },
            });

            const prompt = builder.build(spec, context, []);

            // 经验 Section（格式化版）应存在
            expect(prompt).toContain('Historical Task Experience');
            expect(prompt).toContain('不应出现在JSON中的经验');

            // sanitizedContext JSON 块中不应包含 taskExperiences
            const jsonMatch = prompt.match(/```json\n([\s\S]*?)```/);
            expect(jsonMatch).toBeTruthy();
            const jsonBlock = jsonMatch![1]!;
            expect(jsonBlock).not.toContain('taskExperiences');
            expect(jsonBlock).not.toContain('不应出现在JSON中的经验');
            // 其他普通字段应保留
            expect(jsonBlock).toContain('normalData');
        });
    });
});

describe('subAgentPromptBuilder 单例', () => {
    it('应导出单例实例', () => {
        expect(subAgentPromptBuilder).toBeInstanceOf(SubAgentPromptBuilder);
    });
});

