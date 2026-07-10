/**
 * MasterBrainPrompt 单元测试
 *
 * 测试 Prompt 构建器的格式化功能
 */

import { describe, it, expect } from 'vitest';
import { MasterBrainPrompt } from '../MasterBrainPrompt';
import type { MasterBrainInput, MemoryItem, ExternalGuideSkillInfo } from '../types';
import {
    createEmptyMemorySnapshot,
} from '../types';
import { resolveOutputLanguage } from '@services/language/OutputLanguagePolicy';

// ═══════════════════════════════════════════════════════════════
// 测试辅助函数
// ═══════════════════════════════════════════════════════════════

const createTestInput = (overrides: Partial<MasterBrainInput> = {}): MasterBrainInput => ({
    userIntent: overrides.userIntent ?? {
        explicit: 'Test user intent',
    },
    outputLanguageHint: overrides.outputLanguageHint,
    memory: overrides.memory ?? createEmptyMemorySnapshot(),
    ragEvidence: overrides.ragEvidence ?? [],
    toolCatalog: overrides.toolCatalog ?? [],
    externalGuideSkills: overrides.externalGuideSkills,
    installedSkillCatalog: overrides.installedSkillCatalog,
    installedScriptSkillCatalog: overrides.installedScriptSkillCatalog,
    sandboxMode: overrides.sandboxMode,
});

const createTestMemoryItem = (content: string, layer: 'fact' | 'summary' = 'fact'): MemoryItem => ({
    id: 'mem-1',
    agentId: 'agent-1',
    layer,
    content,
    category: 'knowledge_level',
    importance: 0.8,
    sourceMessageIds: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
});

// ═══════════════════════════════════════════════════════════════
// 测试用例
// ═══════════════════════════════════════════════════════════════

describe('MasterBrainPrompt', () => {
    const builder = new MasterBrainPrompt();

    describe('Prompt 结构', () => {
        it('应该包含 Prime Directive Section', () => {
            const input = createTestInput();
            const prompt = builder.build(input);

            expect(prompt).toContain('Prime Directive');
            expect(prompt).toContain('Master Brain');
        });

        it('应该包含用户意图 Section', () => {
            const input = createTestInput();
            const prompt = builder.build(input);

            expect(prompt).toContain('[USER_INTENT]');
            expect(prompt).toContain('Test user intent');
        });

        it('should anchor English output language for English user requests', () => {
            const input = createTestInput({
                userIntent: {
                    explicit: 'Using the Agent SDK, quickly build a browser-based agent application.',
                },
            });
            const prompt = builder.build(input);

            expect(prompt).toContain('[OUTPUT_LANGUAGE]');
            expect(prompt).toContain('Resolved output language: English');
            expect(prompt).toContain('Use English for natural-language output');
        });

        it('should distinguish Japanese output language from Chinese when kana is present', () => {
            const input = createTestInput({
                userIntent: {
                    explicit: '最新のmacOSに触発されたブラウザベースのOSを作成してください。',
                },
            });
            const prompt = builder.build(input);

            expect(prompt).toContain('Resolved output language: Japanese');
            expect(prompt).toContain('Use Japanese for natural-language output');
        });

        it('should anchor Korean output language for Hangul user requests', () => {
            const input = createTestInput({
                userIntent: {
                    explicit: '브라우저 기반 에이전트 애플리케이션을 빠르게 만들어 주세요.',
                },
            });
            const prompt = builder.build(input);

            expect(prompt).toContain('Resolved output language: Korean');
            expect(prompt).toContain('Use Korean for natural-language output');
        });

        it('should let an explicit Chinese translation target override Japanese quoted text', () => {
            const input = createTestInput({
                userIntent: {
                    explicit: '请翻译“最新のmacOSに触発されたブラウザベースのOSを作成する。”这一段为中文',
                },
            });
            const prompt = builder.build(input);

            expect(prompt).toContain('Resolved output language: Simplified Chinese');
            expect(prompt).toContain('explicitly requires Simplified Chinese');
        });

        it('should preserve Traditional Chinese as a distinct output variant', () => {
            const input = createTestInput({
                userIntent: {
                    explicit: '請分析這份檔案，並說明系統狀態、訊息傳送與任務執行風險。',
                },
            });
            const prompt = builder.build(input);

            expect(prompt).toContain('Resolved output language: Traditional Chinese');
            expect(prompt).toContain('Use Traditional Chinese for natural-language output');
        });

        it('should prefer a pre-resolved language hint from the original request', () => {
            const input = createTestInput({
                userIntent: {
                    explicit: 'Delegated text was rewritten in English.',
                },
                outputLanguageHint: resolveOutputLanguage(
                    'Please provide the final answer in French.',
                    { useRuntimePreference: false }
                ),
            });
            const prompt = builder.build(input);

            expect(prompt).toContain('Resolved output language: French');
            expect(prompt).toContain('explicitly requires French');
        });

        it('应该不包含系统状态 Section（已移除，预算由后台管理）', () => {
            const input = createTestInput();
            const prompt = builder.build(input);

            expect(prompt).not.toContain('[SYSTEM_STATE]');
            expect(prompt).not.toContain('loopBudget');
        });

        it('应该包含决策原则 Section', () => {
            const input = createTestInput();
            const prompt = builder.build(input);

            expect(prompt).toContain('Decision Principles');
            expect(prompt).toContain('safety');
        });

        it('local sandbox mode should not inject MB sandbox awareness', () => {
            const input = createTestInput({ sandboxMode: 'LocalAudit' });
            const prompt = builder.build(input);

            expect(prompt).not.toContain('[MB_SANDBOX_AWARENESS]');
            expect(prompt).not.toContain('--proxy-server=direct://');
        });

        it('ControlledNetwork sandbox mode should inject controlled-network awareness', () => {
            const input = createTestInput({ sandboxMode: 'ControlledNetwork' });
            const prompt = builder.build(input);

            expect(prompt).toContain('[MB_SANDBOX_AWARENESS]');
            expect(prompt).toContain('ControlledNetwork');
            expect(prompt).toContain('curl --noproxy');
            expect(prompt).toContain('--proxy-server=direct://');
            expect(prompt).toContain('HTTP_PROXY');
            expect(prompt).toContain('careful');
        });

        it('OfflineIsolated sandbox mode should inject concise offline sandbox awareness', () => {
            const input = createTestInput({ sandboxMode: 'OfflineIsolated' });
            const prompt = builder.build(input);

            expect(prompt).toContain('[MB_SANDBOX_AWARENESS]');
            expect(prompt).toContain('OfflineIsolated');
            expect(prompt).not.toContain('curl --noproxy');
        });

        it('应该包含可选决策 Section', () => {
            const input = createTestInput();
            const prompt = builder.build(input);

            expect(prompt).toContain('SPAWN_SUB_AGENT');
            expect(prompt).toContain('REQUEST_MORE_INPUT');
            expect(prompt).toContain('RESPOND_TO_USER');
        });

        it('应该包含输出格式 Section', () => {
            const input = createTestInput();
            const prompt = builder.build(input);

            expect(prompt).toContain('Output Format');
            expect(prompt).toContain('riskAssessment');
            const removedField = 'loop' + 'State';
            expect(prompt).not.toContain(`"${removedField}"`);
        });
    });

    describe('记忆格式化', () => {
        it('应该正确格式化事实', () => {
            const memory = createEmptyMemorySnapshot();
            memory.facts.push(createTestMemoryItem('User knows TypeScript'));

            const input = createTestInput({ memory });
            const prompt = builder.build(input);

            expect(prompt).toContain('[MEMORY]');
            expect(prompt).toContain('User knows TypeScript');
        });

        it('空记忆应该显示提示信息', () => {
            const input = createTestInput();
            const prompt = builder.build(input);

            expect(prompt).toContain('[MEMORY]');
            expect(prompt).toMatch(/无可用记忆|No memories available/);
        });
    });

    describe('RAG 证据格式化', () => {
        it('应该正确格式化 RAG 证据（正 relevance 渲染相关度）', () => {
            const input = createTestInput({
                ragEvidence: [
                    { source: 'attachment', content: 'User uploaded content', relevance: 1.0 },
                ],
            });
            const prompt = builder.build(input);

            expect(prompt).toContain('[RAG_EVIDENCE]');
            expect(prompt).toContain('attachment');
            expect(prompt).toContain('User uploaded content');
            expect(prompt).toContain('relevance: 100%');
        });

        it('relevance 为负值时不应渲染相关度标签', () => {
            const input = createTestInput({
                ragEvidence: [
                    { source: 'knowledge_base', content: 'RAG chunk content', relevance: -1 },
                ],
            });
            const prompt = builder.build(input);

            expect(prompt).toContain('[RAG_EVIDENCE]');
            expect(prompt).toContain('knowledge_base');
            expect(prompt).toContain('RAG chunk content');
            // 不应出现相关度百分比
            expect(prompt).not.toContain('relevance:');
        });

        it('空 RAG 应该显示提示信息', () => {
            const input = createTestInput();
            const prompt = builder.build(input);

            expect(prompt).toContain('[RAG_EVIDENCE]');
            expect(prompt).toMatch(/无相关证据|No evidence available/);
        });
    });

    describe('工具目录格式化', () => {
        it('应该正确格式化工具目录', () => {
            const input = createTestInput({
                toolCatalog: [
                    { name: 'read', description: 'Read file contents' },
                    { name: 'file_write', description: 'Write file contents', riskLevel: 'high' },
                ],
            });
            const prompt = builder.build(input);

            expect(prompt).toContain('[TOOL_CATALOG]');
            expect(prompt).toContain('read');
            expect(prompt).toContain('file_write');
        });

        it('应该正确格式化 whenNotToUse（❌ 前缀）', () => {
            const input = createTestInput({
                toolCatalog: [
                    {
                        name: 'file_write',
                        description: '创建或编辑文件',
                        whenNotToUse: [
                            '纯粹读取文件内容（应使用 read）',
                            '操作二进制文件',
                        ],
                        riskLevel: 'high',
                    },
                ],
            });
            const prompt = builder.build(input);

            expect(prompt).toContain('**When Not To Use**:');
            expect(prompt).toContain('❌ 纯粹读取文件内容（应使用 read）');
            expect(prompt).toContain('❌ 操作二进制文件');
        });

        it('应该正确格式化 decisionHint', () => {
            const input = createTestInput({
                toolCatalog: [
                    {
                        name: 'exec',
                        description: '执行 Shell 命令',
                        decisionHint: [
                            "安全命令（Git 只读/文件浏览）：可 behaviorHint='direct'",
                            '禁止用 exec 执行脚本来修改文件内容',
                        ],
                        riskLevel: 'high',
                    },
                ],
            });
            const prompt = builder.build(input);

            expect(prompt).toContain('**Decision Hint**:');
            expect(prompt).toContain("安全命令（Git 只读/文件浏览）：可 behaviorHint='direct'");
            expect(prompt).toContain('禁止用 exec 执行脚本来修改文件内容');
        });

        it('whenNotToUse 和 decisionHint 为空时不应渲染对应章节', () => {
            const input = createTestInput({
                toolCatalog: [
                    {
                        name: 'read',
                        description: 'Read file',
                        whenToUse: ['查看文件内容'],
                    },
                ],
            });
            const prompt = builder.build(input);

            expect(prompt).not.toContain('**When Not To Use**:');
            expect(prompt).not.toContain('**Decision Hint**:');
            // 适用场景仍应存在
            expect(prompt).toContain('**When To Use**:');
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // External Guides 注入
    // ═══════════════════════════════════════════════════════════════

    describe('External Guides 注入', () => {
        const createGuideSkill = (
            name: string,
            description: string,
            fullContent: string = `# ${name}\n\n${description} 详细内容。`
        ): ExternalGuideSkillInfo => ({
            name,
            description,
            fullContent,
        });

        it('技能应注入完整内容和指引', () => {
            const input = createTestInput({
                externalGuideSkills: [
                    createGuideSkill('pdf-guide', 'PDF 处理指南',
                        '# PDF 处理\n\n使用 pdf-parser 库解析 PDF 文件。'),
                ],
            });
            const prompt = builder.build(input);

            // 应包含 section 标记
            expect(prompt).toContain('EXTERNAL_SKILL_GUIDES');
            // 应注入完整内容
            expect(prompt).toContain('pdf-guide');
            expect(prompt).toContain('PDF 处理指南');
            expect(prompt).toContain('pdf-parser 库解析 PDF 文件');
            // 应包含委派指引
            expect(prompt).toContain('Do not instruct the Sub-Agent to write scripts from scratch');
        });

        it('含脚本的技能应注入全文和脚本列表', () => {
            const input = createTestInput({
                externalGuideSkills: [
                    {
                        ...createGuideSkill('agent-only', '仅 Agent 使用'),
                        scriptFiles: ['scripts/helper.py'],
                    },
                ],
            });
            const prompt = builder.build(input);

            // 应注入 fullContent 和脚本列表
            expect(prompt).toContain('EXTERNAL_SKILL_GUIDES');
            expect(prompt).toContain('agent-only');
            expect(prompt).toContain('仅 Agent 使用');
            expect(prompt).toContain('scripts/helper.py');
            expect(prompt).toContain('仅 Agent 使用 详细内容。');
        });

        it('无 externalGuideSkills 时不应注入 Guide Section', () => {
            const input = createTestInput();
            const prompt = builder.build(input);

            expect(prompt).not.toContain('EXTERNAL_SKILL_GUIDES');
        });

        it('混合技能应全部注入全文', () => {
            const input = createTestInput({
                externalGuideSkills: [
                    createGuideSkill('kb-guide', '知识库指南',
                        '# 知识库详细内容'),
                    createGuideSkill('tool-guide', '工具指南'),
                    createGuideSkill('sa-guide', 'Sub-Agent 专属'),
                ],
            });
            const prompt = builder.build(input);

            expect(prompt).toContain('EXTERNAL_SKILL_GUIDES');
            // 所有技能都应全文注入
            expect(prompt).toContain('知识库详细内容');
            expect(prompt).toContain('tool-guide');
            expect(prompt).toContain('工具指南');
            expect(prompt).toContain('sa-guide');
            expect(prompt).toContain('Sub-Agent 专属');
            expect(prompt).toContain('Sub-Agent 专属 详细内容。');
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 已安装技能目录（静态全量注入）
    // ═══════════════════════════════════════════════════════════════

    describe('已安装技能目录注入', () => {
        it('有已安装技能时应注入 INSTALLED_GUIDE_SKILLS 区块', () => {
            const input = createTestInput({
                installedSkillCatalog: [
                    { name: 'agent-browser', description: 'Browser automation CLI for AI agents' },
                    { name: 'xlsx-tool', description: 'Excel 文件处理工具' },
                ],
            });
            const prompt = builder.build(input);

            expect(prompt).toContain('INSTALLED_GUIDE_SKILLS');
            expect(prompt).toContain('agent-browser');
            expect(prompt).toContain('Browser automation CLI for AI agents');
            expect(prompt).toContain('xlsx-tool');
            expect(prompt).toContain('Excel 文件处理工具');
            // 应包含行动指引
            expect(prompt).toContain('nextStep.task');
        });

        it('无已安装技能时不应注入 INSTALLED_GUIDE_SKILLS 区块', () => {
            const input = createTestInput();
            const prompt = builder.build(input);

            expect(prompt).not.toContain('INSTALLED_GUIDE_SKILLS');
        });

        it('有 Script 技能时应注入 INSTALLED_SCRIPT_SKILLS 区块并提示 external_skill_execute', () => {
            const input = createTestInput({
                installedScriptSkillCatalog: [
                    {
                        name: 'broker-e2e',
                        description: 'Validate broker-only sandbox networking',
                        networkMode: 'brokerOnly',
                    },
                ],
            });
            const prompt = builder.build(input);

            expect(prompt).toContain('INSTALLED_SCRIPT_SKILLS');
            expect(prompt).toContain('broker-e2e');
            expect(prompt).toContain('networkMode=brokerOnly');
            expect(prompt).toContain('external_skill_execute');
            expect(prompt).toContain('exact `skillName`');
        });

        it('已安装技能目录和检索命中技能应独立共存', () => {
            const input = createTestInput({
                installedSkillCatalog: [
                    { name: 'agent-browser', description: 'Browser automation' },
                    { name: 'xlsx-tool', description: 'Excel 处理' },
                ],
                externalGuideSkills: [
                    {
                        name: 'xlsx-tool',
                        description: 'Excel 处理',
                        fullContent: '# xlsx-tool\n\nExcel 处理详细内容。',
                    },
                ],
            });
            const prompt = builder.build(input);

            // 两个区块应独立存在
            expect(prompt).toContain('INSTALLED_GUIDE_SKILLS');
            expect(prompt).toContain('EXTERNAL_SKILL_GUIDES');
            // 已安装目录中应有 agent-browser
            expect(prompt).toContain('agent-browser');
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // Checkpoint 评估 Prompt
    // ═══════════════════════════════════════════════════════════════

    describe('Checkpoint 评估 Prompt', () => {
        const createMockReport = (overrides = {}) => ({
            subAgentId: 'sa-test-1',
            completedIterations: 5,
            remainingBudget: 2,
            confidenceLevel: 0.4,
            needsMoreIterations: true,
            collectedObservations: '执行了 soffice 命令，返回 command not found',
            blockers: undefined,
            ...overrides,
        });

        const createMockSpec = () => ({
            role: '创建 PPTX 文件',
            allowedTools: ['exec', 'read', 'file_write'],
            terminationCondition: 'PPTX 文件创建完成',
            behaviorHint: 'direct' as const,
            loopConfig: {
                initialBudget: 7,
                checkpointInterval: 5,
                maxSteps: 3,
                terminationPatterns: ['TASK_COMPLETE'],
            },
        });

        it('TERMINATE_SUB_AGENT 条件应包含环境/工具缺失判断', () => {
            const prompt = builder.buildCheckpointEvaluationPrompt(
                createMockReport(),
                createMockSpec()
            );

            // 应包含环境缺失相关的终止规则
            expect(prompt).toContain('missing environment');
            expect(prompt).toContain('command not found');
        });

        it('CRITICAL EVALUATION GUIDELINES 应包含环境依赖失败处理', () => {
            const prompt = builder.buildCheckpointEvaluationPrompt(
                createMockReport(),
                createMockSpec()
            );

            // 应包含环境依赖失败的处理指南
            expect(prompt).toContain('Environment dependency failures');
            expect(prompt).toContain('missing installation');
            // 应明确禁止对工具缺失使用 EXTEND_BUDGET
            expect(prompt).toContain('Do NOT use **EXTEND_BUDGET**');
        });

        it('传入 artifactSnapshot 时应注入 Task Artifacts Section', () => {
            const mockSnapshot = {
                index: [{
                    key: 'search_0',
                    dataType: 'search_results' as const,
                    toolName: 'web_search',
                    sourceHint: 'yt-dlp 安装方法',
                    estimatedTokens: 200,
                }],
                artifacts: [{
                    key: 'search_0',
                    dataType: 'search_results' as const,
                    content: '搜索结果：pip install yt-dlp',
                    createdBy: 'sa-1',
                    createdAt: Date.now(),
                    estimatedTokens: 200,
                    toolName: 'web_search',
                    sourceHint: 'yt-dlp 安装方法',
                }],
                totalTokens: 200,
            };

            const prompt = builder.buildCheckpointEvaluationPrompt(
                createMockReport(),
                createMockSpec(),
                mockSnapshot
            );

            expect(prompt).toContain('Task Artifacts');
            expect(prompt).toContain('web_search');
            expect(prompt).toContain('yt-dlp 安装方法');
            // 现在只注入轻量索引（工具名 + 来源 + token估算），不注入原始内容
            expect(prompt).toContain('~200 tokens');
            // 原始 artifact 内容不应出现（避免 Checkpoint 上下文膨胀）
            expect(prompt).not.toContain('pip install yt-dlp');
        });

        it('不传入 artifactSnapshot 时不应渲染 Artifacts Section', () => {
            const prompt = builder.buildCheckpointEvaluationPrompt(
                createMockReport(),
                createMockSpec()
            );

            // 不应渲染实际的 Artifacts Section（指令文本中的引用不算）
            expect(prompt).not.toContain('## Task Artifacts');
        });

        it('预算临界 Checkpoint 应提示可追加最多 20 步', () => {
            const prompt = builder.buildCheckpointEvaluationPrompt(
                createMockReport({
                    checkpointTrigger: 'budget_near_exhaustion',
                    remainingBudget: 5,
                    requestedAdditionalBudget: 20,
                    collectedObservations: '已完成多个文件修改，下一步需要继续验证。',
                }),
                createMockSpec()
            );

            expect(prompt).toContain('BUDGET NEAR-EXHAUSTION CHECKPOINT');
            expect(prompt).toContain('Requested Additional Budget');
            expect(prompt).toContain('1-20');
            expect(prompt).toContain('budget_near_exhaustion');
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 输出格式 Footer（Lost in the Middle 对策）
    // ═══════════════════════════════════════════════════════════════

    describe('输出格式 Footer', () => {
        it('Prompt 应包含 OUTPUT_FORMAT_FOOTER 标记', () => {
            const input = createTestInput();
            const prompt = builder.build(input);

            expect(prompt).toContain('---OUTPUT_FORMAT_FOOTER---');
            expect(prompt).toContain('---END_OUTPUT_FORMAT_FOOTER---');
        });

        it('Footer 应包含核心输出格式约束', () => {
            const input = createTestInput();
            const prompt = builder.build(input);

            // Footer 区域应包含 JSON 决策格式关键要素
            const footerStart = prompt.indexOf('---OUTPUT_FORMAT_FOOTER---');
            const footerEnd = prompt.indexOf('---END_OUTPUT_FORMAT_FOOTER---');
            const footer = prompt.slice(footerStart, footerEnd);

            expect(footer).toContain('"decision"');
            expect(footer).toContain('SPAWN_SUB_AGENT');
            expect(footer).toContain('RESPOND_TO_USER');
            // 应明确禁止非 JSON 格式
            expect(footer).toContain('TOOL_CALL');
        });

        it('Footer 应在 Prompt 最末尾（在所有可变内容之后）', () => {
            const input = createTestInput({
                toolCatalog: [
                    { name: 'exec', description: 'Shell execution' },
                ],
                externalGuideSkills: [{
                    name: 'test-guide',
                    description: 'Test guide',
                    fullContent: '# Test\\n\\nTest content.',
                }],
            });
            const prompt = builder.build(input);

            const footerPos = prompt.indexOf('---OUTPUT_FORMAT_FOOTER---');
            const toolCatalogPos = prompt.indexOf('[TOOL_CATALOG]');
            const guidesPos = prompt.indexOf('EXTERNAL_SKILL_GUIDES');

            // Footer 应在所有内容区块之后
            expect(footerPos).toBeGreaterThan(toolCatalogPos);
            expect(footerPos).toBeGreaterThan(guidesPos);
        });

        it('精简后 buildFixedTemplate 中应只有一个 JSON Schema 块', () => {
            const input = createTestInput();
            const prompt = builder.build(input);

            // 在输出格式 Section（Section 5）中应有 JSON Schema
            expect(prompt).toContain('Output Format');
            // nextStep 字段应在 JSON Schema 中内联说明（而非独立的 Section 4 JSON 块）
            expect(prompt).toContain('"nextStep"');
            expect(prompt).toContain('"behaviorHint"');
            // 旧的 FINAL REMINDER 应已移除（由 Footer 替代）
            expect(prompt).not.toContain('FINAL REMINDER');
        });
    });
});
