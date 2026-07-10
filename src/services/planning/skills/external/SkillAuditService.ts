/**
 * SkillAuditService - 技能包安全审查服务
 *
 * 独立于 Agent Loop，使用 Sub-Agent 执行栈（SubAgentRunner + read 工具）
 * 对外部技能包进行 ReAct 循环式深度安全扫描。
 *
 * 核心设计：
 * - 复用 SubAgentRunner + SubAgentLLMCallerFactory，不创建新基础设施
 * - 沙箱化 ToolExecutor：仅允许 read 工具，且路径限定在 packagePath 内
 * - Noop Checkpoint：审查 SA 无需 Master Brain 介入，全程自主执行
 * - 结构化 JSON 裁决输出：APPROVED / REJECTED / MANUAL_REVIEW_REQUIRED
 */

import { SubAgentRunner } from '../../sub-agents/SubAgentRunner';
import { SubAgentLLMCallerFactory } from '../../agent-loop/callers/SubAgentLLMCaller';
import { readTool } from '../read/tool';
// 确保审计 SA 运行前 toolRegistry 已就绪
// 审计流程在技能安装后立即触发，可能先于 AgentLoop 的初始化执行
import { initializeTools } from '../../tools';
import type { SubAgentSpec, TaskContext, SubAgentLoopConfig } from '../../sub-agents/types';
import type { ToolExecutionContext } from '../../tools/types';
import type { CheckpointCallback } from '../../brain/types';
import { useSettingsStore } from '@stores/settingsStore';
import { useRuntimeStore } from '@stores/runtimeStore';
import { getLogger } from '@services/logger';
import { getCurrentLanguage, translate, type Language } from '@/i18n';
import {
    buildOutputLanguageContract,
    resolveOutputLanguage,
} from '@services/language/OutputLanguagePolicy';
import { getDefaultModelIdForProvider } from '@/config/modelRegistry';

// 构建时嵌入审查 Prompt（避免运行时读取文件）
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — Vite ?raw 查询返回 string
import auditPromptContent from './Skill Audit Prompt.md?raw';
import { parseWithFallback } from '@services/memory/utils/JsonParser';

const logger = getLogger('SkillAuditService');

// ==================== 类型定义 ====================

/** 审查裁决结果 */
export type AuditVerdict = 'APPROVED' | 'REJECTED' | 'MANUAL_REVIEW_REQUIRED';

/** 审查置信度 */
export type AuditConfidence = 'LOW' | 'MEDIUM' | 'HIGH';

/** 风险等级 */
export type FindingRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** 单个审查发现项 */
export interface SkillAuditFinding {
    /** 涉及的文件 */
    file: string;
    /** 行号或位置描述 */
    lineOrLocation: string;
    /** 风险等级 */
    riskLevel: FindingRiskLevel;
    /** 风险类型（如 RCE、Data Exfiltration 等） */
    riskType: string;
    /** 详细描述 */
    description: string;
    /** 攻击场景说明 */
    attackScenario: string;
    /** 修复建议 */
    recommendation: string;
}

/** 完整审查结果 */
export interface SkillAuditResult {
    /** 审查裁决 */
    auditResult: AuditVerdict;
    /** 风险评分 (1-10) */
    riskScore: number;
    /** 置信度 */
    confidence: AuditConfidence;
    /** 安全结论摘要 */
    summary: string;
    /** 意图与行为是否不一致 */
    intentMismatch: boolean;
    /** 检测到的能力列表 */
    detectedCapabilities: string[];
    /** 具体发现项 */
    findings: SkillAuditFinding[];
}

/** 审查进度信息（推送到 Store 供 UI 消费） */
export interface AuditProgress {
    /** 当前正在读取的文件 */
    currentFile: string;
    /** 已扫描文件数 */
    filesScanned: number;
}

/** 审查配置 */
interface AuditConfig {
    /** LLM Provider ID */
    providerId: string;
    /** 模型 ID */
    modelId: string;
    /** 自定义 base URL */
    baseUrl?: string;
}

// ==================== 常量 ====================

/** 审查 SA 最大步数上限 — 足够扫描完整技能包 */
const AUDIT_MAX_STEPS = 30;

/** 审查 SA 初始预算 */
const AUDIT_INITIAL_BUDGET = 25;

/** Checkpoint 间隔（审查场景无需频繁 Checkpoint） */
const AUDIT_CHECKPOINT_INTERVAL = 20;

const AUDIT_ROOT_FILES = new Set(['skill.md']);
const AUDIT_DISCLOSURE_DIRS = new Set([
    'reference',
    'references',
    'script',
    'scripts',
    'asset',
    'assets',
]);
const AUDIT_SKIP_DIRS = new Set(['node_modules', '__pycache__']);



// ==================== 工具函数 ====================

/**
 * 路径沙箱检查
 *
 * 验证目标路径是否在技能包目录内，防止审查 SA 被 Prompt 注入劫持后读取系统敏感文件。
 * 使用 case-insensitive 比较（Windows 文件系统不区分大小写）。
 */
function isWithinPackagePath(targetPath: string, packagePath: string): boolean {
    const normalizedTarget = targetPath.replace(/\\/g, '/').toLowerCase();
    const normalizedPackage = packagePath.replace(/\\/g, '/').toLowerCase();

    // 确保 packagePath 以 / 结尾，避免前缀误匹配
    // 例如 /packages/malicious-skill 不应匹配 /packages/malicious
    const packagePrefix = normalizedPackage.endsWith('/')
        ? normalizedPackage
        : `${normalizedPackage}/`;

    return normalizedTarget.startsWith(packagePrefix)
        || normalizedTarget === normalizedPackage;
}

function normalizeAuditPath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
}

function resolveAuditReadPath(inputPath: string, packagePath: string): string {
    if (/^[a-zA-Z]:[/\\]/.test(inputPath) || inputPath.startsWith('/')) {
        return inputPath;
    }

    const sep = packagePath.includes('\\') ? '\\' : '/';
    const normalizedInput = inputPath
        .replace(/\\/g, sep)
        .replace(/^\.?[\\/]+/, '');
    return `${packagePath}${sep}${normalizedInput}`;
}

function getRelativePathWithinPackage(targetPath: string, packagePath: string): string | null {
    const normalizedTarget = targetPath.replace(/\\/g, '/').toLowerCase();
    const normalizedPackage = packagePath.replace(/\\/g, '/').toLowerCase();
    const packagePrefix = normalizedPackage.endsWith('/')
        ? normalizedPackage
        : `${normalizedPackage}/`;

    if (!normalizedTarget.startsWith(packagePrefix)) {
        return null;
    }

    return normalizedTarget.slice(packagePrefix.length);
}

function isEntrySkipped(entry: string): boolean {
    return entry.startsWith('.') || AUDIT_SKIP_DIRS.has(entry.toLowerCase());
}

function joinPackagePath(basePath: string, relativePath: string): string {
    const sep = basePath.includes('\\') ? '\\' : '/';
    return relativePath ? `${basePath}${sep}${relativePath}` : basePath;
}

/**
 * 从 SA 输出中解析 JSON 审查裁决
 *
 * 委托 JsonParser.parseWithFallback 处理 LLM 输出中常见的 JSON 格式问题：
 * - Markdown 代码块包裹
 * - 中文引号/全角符号
 * - 截断修复
 * - 嵌套引号逃逸
 *
 * 解析失败时降级为 MANUAL_REVIEW_REQUIRED。
 */
export function parseAuditResultFromOutput(
    rawOutput: string,
    language: Language = getCurrentLanguage()
): SkillAuditResult {
    const parseResult = parseWithFallback<Record<string, unknown>>(rawOutput, {
        verbose: true,
        logPrefix: '[SkillAuditService]',
    });

    if (parseResult.success && parseResult.data) {
        logger.debug(
                `[SkillAuditService] JSON 裁决解析成功 (策略: ${parseResult.strategy ?? 'unknown'}, 质量: ${parseResult.quality ?? 'unknown'})`
        );
        return normalizeAuditResult(parseResult.data, language);
    }

    logger.warn(
                `[SkillAuditService] JSON 裁决解析失败，降级为 MANUAL_REVIEW_REQUIRED: ${parseResult.error ?? 'unknown'}`
    );
    return createFallbackResult(rawOutput, language);
}

/**
 * 规范化 JSON 解析结果为 SkillAuditResult
 *
 * 处理 snake_case（Prompt 定义的字段名）到 camelCase 的映射
 */
function normalizeAuditResult(
    raw: Record<string, unknown>,
    language: Language
): SkillAuditResult {
    const auditResult = normalizeVerdict(
        (raw.audit_result ?? raw.auditResult) as string | undefined
    );

    const riskScore = clampNumber(raw.risk_score ?? raw.riskScore, 1, 10, 5);
    const confidence = normalizeConfidence(
        (raw.confidence) as string | undefined
    );

    return {
        auditResult,
        riskScore,
        confidence,
        summary: normalizeString(
            raw.summary,
            translate('settings.skills.auditResultDefaultSummary', undefined, language)
        ),
        intentMismatch: Boolean(raw.intent_mismatch ?? raw.intentMismatch ?? false),
        detectedCapabilities: normalizeStringArray(
            raw.detected_capabilities ?? raw.detectedCapabilities
        ),
        findings: normalizeFindings(raw.findings),
    };
}

/** 规范化裁决值 */
function normalizeVerdict(value: string | undefined): AuditVerdict {
    const upper = (value ?? '').toUpperCase();
    if (upper === 'APPROVED') return 'APPROVED';
    if (upper === 'REJECTED') return 'REJECTED';
    return 'MANUAL_REVIEW_REQUIRED';
}

/** 规范化置信度 */
function normalizeConfidence(value: string | undefined): AuditConfidence {
    const upper = (value ?? '').toUpperCase();
    if (upper === 'LOW') return 'LOW';
    if (upper === 'HIGH') return 'HIGH';
    return 'MEDIUM';
}

/** 数值钳制 */
function clampNumber(
    value: unknown, min: number, max: number, fallback: number
): number {
    const num = Number(value);
    if (Number.isNaN(num)) return fallback;
    return Math.max(min, Math.min(max, num));
}

/** 规范化字符串数组 */
function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === 'string');
}

function normalizeString(value: unknown, fallback = ''): string {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
    }

    try {
        const serialized = JSON.stringify(value);
        return typeof serialized === 'string' ? serialized : fallback;
    } catch {
        return fallback;
    }
}

/** 规范化 findings 数组 */
function normalizeFindings(value: unknown): SkillAuditFinding[] {
    if (!Array.isArray(value)) return [];
    return value.map((item) => {
        const obj = item as Record<string, unknown>;
        return {
            file: normalizeString(obj.file),
            lineOrLocation: normalizeString(obj.line_or_location ?? obj.lineOrLocation),
            riskLevel: normalizeFindingRiskLevel(obj.risk_level ?? obj.riskLevel),
            riskType: normalizeString(obj.risk_type ?? obj.riskType),
            description: normalizeString(obj.description),
            attackScenario: normalizeString(obj.attack_scenario ?? obj.attackScenario),
            recommendation: normalizeString(obj.recommendation),
        };
    });
}

/** 规范化风险等级 */
function normalizeFindingRiskLevel(value: unknown): FindingRiskLevel {
    const upper = normalizeString(value).toUpperCase();
    if (upper === 'CRITICAL') return 'CRITICAL';
    if (upper === 'HIGH') return 'HIGH';
    if (upper === 'MEDIUM') return 'MEDIUM';
    return 'LOW';
}

/** 生成解析失败时的降级结果 */
function createFallbackResult(rawOutput: string, language: Language): SkillAuditResult {
    const outputPreview = `${rawOutput.slice(0, 200)}...`;

    return {
        auditResult: 'MANUAL_REVIEW_REQUIRED',
        riskScore: 5,
        confidence: 'LOW',
        summary: translate('settings.skills.auditParseFailureSummary', undefined, language),
        intentMismatch: false,
        detectedCapabilities: [],
        findings: [{
            file: 'N/A',
            lineOrLocation: 'N/A',
            riskLevel: 'MEDIUM',
            riskType: 'parse_failure',
            description: translate(
                'settings.skills.auditParseFailureDescription',
                { output: outputPreview },
                language
            ),
            attackScenario: '',
            recommendation: translate(
                'settings.skills.auditParseFailureRecommendation',
                undefined,
                language
            ),
        }],
    };
}

// ==================== 核心审查逻辑 ====================

/**
 * 构建精简的审计 System Prompt（用于 overrideSystemPrompt 直传，不走 PromptBuilder 管线）
 *
 * 结构：审计评估规则 + MasterBrain 风格分步指令 + Tool 使用规范
 * 比完整 PromptBuilder 管线（BASE_TEMPLATE + BEHAVIOR + LOOP_GUIDANCE + SAFETY_FOOTER）轻量得多，
 * 减少不必要的 prompt 噪音对审查 SA 的干扰。
 */
export function buildAuditSystemPrompt(
    packagePath: string,
    fileList: string[],
    language: Language = getCurrentLanguage(),
): string {
    const taskDescription = buildAuditTaskDescription(packagePath, fileList);

    return [
        // ① 审查角色 + 评估维度 + 裁决逻辑 + 输出格式
        auditPromptContent,
        '',
        '---',
        '',
        '## Output Language',
        '',
        buildAuditOutputLanguageInstruction(language),
        '',
        '---',
        '',
        // ② MasterBrain 风格分步任务指令
        '## Task',
        '',
        taskDescription,
        '',
        '---',
        '',
        // ③ 工具使用规范（精简版，不引入完整 SKILL.md）
        '## Available Tools',
        '',
        '### read',
        'Read file contents. Parameters: `path` (absolute file path, required).',
        '',
        '---',
        '',
        // ④ 终止信号
        'After reviewing all files, output a JSON verdict that follows the Output Schema and include `TASK_COMPLETE`.',
    ].join('\n');
}

export function buildAuditOutputLanguageInstruction(language: Language): string {
    const readableLanguage = language === 'zh-CN'
        ? 'Simplified Chinese (zh-CN)'
        : 'English (en-US)';
    const languageHint = resolveOutputLanguage('', {
        preferredLanguageTags: [language],
    });

    return [
        `Current UI language: ${readableLanguage}.`,
        '',
        `Write these human-readable natural-language fields in ${readableLanguage}:`,
        '- `summary`',
        '- `findings[].description`',
        '- `findings[].attack_scenario`',
        '- `findings[].recommendation`',
        '',
        buildOutputLanguageContract(languageHint, {
            fields: [
                'summary',
                'findings[].description',
                'findings[].attack_scenario',
                'findings[].recommendation',
            ],
        }),
        '',
        'Keep JSON keys, enum values, risk levels, file paths, code symbols, environment variable names, function names, package names, and other technical identifiers unchanged.',
        'Keep `detected_capabilities` and `findings[].risk_type` as concise technical identifiers, preferably stable English snake_case or common security terms.',
    ].join('\n');
}

/**
 * 构建 MasterBrain 风格的分步任务描述（写入 spec.role → system prompt 的 ### 任务角色）
 *
 * 关键设计：模拟 MasterBrain 的 SPAWN_SUB_AGENT 输出格式——
 * 给 SA 一个具体的、分步的行动计划，而非抽象的角色描述。
 * 实测证明：部分代理上的第三方模型在收到详细分步指令时才会正确激活 Function Calling。
 */
export function buildAuditTaskDescription(packagePath: string, fileList: string[]): string {
    // 按优先级分组文件：脚本/代码 > 配置 > 文档 > 其他
    const rootSkillFiles = fileList.filter(f => AUDIT_ROOT_FILES.has(normalizeAuditPath(f)));
    const scriptFiles = fileList.filter(f => /\.(py|sh|js|ts|tsx|jsx|mjs|cjs|bat|cmd|ps1|rb|go|java|php|lua|pl|r)$/i.test(f));
    const configFiles = fileList.filter(f => /\.(json|yaml|yml|toml|ini|env|xml|cfg|conf|properties|csv)$/i.test(f));
    const docFiles = fileList.filter(f =>
        /\.(md|txt|rst|html|htm)$/i.test(f) && !rootSkillFiles.includes(f)
    );
    const assetFiles = fileList.filter(f => {
        const normalized = normalizeAuditPath(f);
        const isAssetPath = normalized.startsWith('asset/') || normalized.startsWith('assets/');
        return isAssetPath &&
            !scriptFiles.includes(f) &&
            !configFiles.includes(f) &&
            !docFiles.includes(f);
    });
    const otherFiles = fileList.filter(f =>
        !rootSkillFiles.includes(f) &&
        !scriptFiles.includes(f) &&
        !configFiles.includes(f) &&
        !docFiles.includes(f) &&
        !assetFiles.includes(f)
    );

    const allFilePaths = fileList.map(f => {
        const sep = packagePath.includes('\\') ? '\\' : '/';
        return `${packagePath}${sep}${f}`;
    });

    if (fileList.length === 0) {
        return [
            `The skill package at '${packagePath}' has no scoped audit files.`,
            '',
            'Audit scope is intentionally limited to root SKILL.md plus files under references/, reference/, scripts/, script/, assets/, and asset/.',
            'Output a MANUAL_REVIEW_REQUIRED JSON verdict because there is no SKILL.md or progressive-disclosure content to inspect.',
        ].join('\n');
    }

    const lines = [
        `Perform a focused security audit of the skill package at '${packagePath}'.`,
        '',
        'Audit scope is intentionally limited to root SKILL.md plus files under references/, reference/, scripts/, script/, assets/, and asset/. Ignore repository files outside this scoped list even if they exist in the package.',
        '',
    ];

    let step = 1;

    if (rootSkillFiles.length > 0) {
        lines.push(`${step}. First read the root skill definition: ${rootSkillFiles.join(', ')}`);
        step++;
    }

    // 优先读取脚本文件（高风险）
    if (scriptFiles.length > 0) {
        lines.push(`${step}. First use the read tool to inspect all script/code files (high priority): ${scriptFiles.join(', ')}`);
        step++;
    }

    // 读取配置文件
    if (configFiles.length > 0) {
        lines.push(`${step}. Read all configuration files: ${configFiles.join(', ')}`);
        step++;
    }

    // 读取文档文件
    if (docFiles.length > 0) {
        lines.push(`${step}. Read documentation files: ${docFiles.join(', ')}`);
        step++;
    }

    // 读取其他文件
    if (assetFiles.length > 0) {
        lines.push(`${step}. Inspect assets by path/name and read only text-like or security-relevant assets when needed: ${assetFiles.join(', ')}`);
        step++;
    }

    if (otherFiles.length > 0) {
        lines.push(`${step}. Inspect remaining scoped files when security-relevant: ${otherFiles.join(', ')}`);
        step++;
    }

    lines.push(
        '',
        `${step}. Analyze the collected file contents using the seven evaluation dimensions in the audit rules`,
        `${step + 1}. Output the final JSON audit verdict using the Output Schema in the audit rules`,
        '',
        `The focused audit scope contains ${fileList.length} files. Full scoped path list:`,
        ...allFilePaths.map(p => `  - ${p}`),
        '',
        'Important: do not read or cite package files outside this scoped path list. Use the read tool for scoped text/code/config files. For obvious binary media assets, evaluate by path/name and by references from code or docs unless the asset itself is security-relevant.',
    );

    return lines.join('\n');
}



/**
 * 获取审查使用的 LLM 配置
 *
 * 优先使用设置中的默认 Provider/Model
 */
function resolveAuditConfig(): AuditConfig {
    const settings = useSettingsStore.getState();
    const providerId = settings.defaultProvider || 'local';
    return {
        providerId,
        modelId: settings.defaultModel || getDefaultModelIdForProvider(providerId),
    };
}

/**
 * Noop Checkpoint 回调
 *
 * 审查 SA 无需 Master Brain 介入评估，始终延长预算让 SA 自主完成
 */
const noopCheckpoint: CheckpointCallback = () => Promise.resolve({
    type: 'EXTEND_BUDGET' as const,
    additionalIterations: 5,
    reason: translate('tools.external.auditNoopReason'),
});

/**
 * 执行技能包安全审查
 *
 * 核心入口方法。构建独立的 SA 执行栈，使用 ReAct 循环逐文件扫描技能包。
 *
 * @param packagePath 技能包的绝对路径（已复制到 packages/ 目录）
 * @param fileList 技能包内的文件列表（相对于 packagePath）
 * @returns 结构化审查结果
 */
export async function auditSkillPackage(
    packagePath: string,
    fileList: string[],
    language: Language = getCurrentLanguage(),
): Promise<SkillAuditResult> {
    logger.info(`[SkillAuditService] 开始审查技能包: ${packagePath}, 文件数: ${fileList.length}`);

    // 更新 Store 状态为审查中
    const store = useRuntimeStore.getState();
    store.startSkillAudit(packagePath);

    try {
        // 0. 确保全局工具注册表已初始化
        //    审计在技能安装后立即触发，此时 AgentLoop 可能还未调用 initializeTools()
        //    导致 toolRegistry.getSchemas() 返回空数组 → API 请求中无 tools 字段 → FC 失效
        initializeTools();

        // 1. 解析 LLM 配置
        const config = resolveAuditConfig();
        logger.debug(
            `[SkillAuditService] 使用模型: ${config.providerId}/${config.modelId}`
        );

        // 3. 构建 LLM Caller
        const callerFactory = new SubAgentLLMCallerFactory({
            providerId: config.providerId,
            modelId: config.modelId,
            baseUrl: config.baseUrl,
        });
        const llmCaller = callerFactory.create();

        // 3. 构建沙箱化 ToolExecutor — 仅允许 read，路径限定在 packagePath 内
        const allowedAuditFiles = new Set(fileList.map(normalizeAuditPath));
        let filesScanned = 0;
        const toolExecutor = async (
            toolCall: { name: string; args: Record<string, unknown> }
        ): Promise<{ success: boolean; content: string; requiresInteraction?: boolean }> => {
            // 仅允许 read 工具
            if (toolCall.name !== 'read') {
                logger.warn(
                    `[SkillAuditService] 拒绝非 read 工具调用: ${toolCall.name}`
                );
                return {
                    success: false,
                    content: translate('tools.external.auditReadOnly', { toolName: toolCall.name }),
                };
            }

            // 路径沙箱校验
            const rawTargetPath = normalizeString(toolCall.args.path);
            if (!rawTargetPath) {
                return { success: false, content: translate('tools.external.auditMissingPath') };
            }
            const targetPath = resolveAuditReadPath(rawTargetPath, packagePath);
            if (!isWithinPackagePath(targetPath, packagePath)) {
                logger.warn(
                    `[SkillAuditService] 路径越权被拦截: ${targetPath} (包范围: ${packagePath})`
                );
                return {
                    success: false,
                    content: translate('tools.external.auditPathDenied', { packagePath, targetPath }),
                };
            }

            // 更新审查进度
            const relativeTargetPath = getRelativePathWithinPackage(targetPath, packagePath);
            if (!relativeTargetPath || !allowedAuditFiles.has(normalizeAuditPath(relativeTargetPath))) {
                logger.warn(
                    `[SkillAuditService] Path outside audit allowlist, refused: ${targetPath}`
                );
                return {
                    success: false,
                    content: translate('tools.external.auditScopeDenied', { targetPath }),
                };
            }

            filesScanned++;
            const fileName = targetPath.split(/[\\/]/).pop() ?? targetPath;
            useRuntimeStore.getState().updateAuditProgress({
                currentFile: fileName,
                filesScanned,
            });

            // 执行 read 工具（构建最小化上下文，审查不需要 workdir 等）
            const readContext: ToolExecutionContext = {
                workdir: packagePath,
                isSubAgentContext: true,
            };
            const result = await readTool.execute({ ...toolCall.args, path: targetPath }, readContext);
            return {
                success: result.success,
                content: result.content,
            };
        };

        // 4. 构建审查 SubAgentSpec
        const loopConfig: SubAgentLoopConfig = {
            initialBudget: AUDIT_INITIAL_BUDGET,
            maxSteps: AUDIT_MAX_STEPS,
            checkpointInterval: AUDIT_CHECKPOINT_INTERVAL,
            terminationPatterns: ['TASK_COMPLETE', '"audit_result"'],
        };

        const auditSpec: SubAgentSpec = {
            role: 'Security audit agent',
            allowedTools: ['read'],
            behaviorHint: 'careful',
            loopConfig,
            terminationCondition: 'After reviewing all files, output a JSON audit verdict that follows the Output Schema',
        };

        // 5. 构建精简 System Prompt（不走 PromptBuilder 管线，减少噪音）
        const systemPrompt = buildAuditSystemPrompt(packagePath, fileList, language);

        // 6. 构建任务上下文（精简，仅需 cwd）
        const taskContext: TaskContext = {
            cwd: packagePath,
        };

        // 7. 实例化 Runner 并注入依赖
        const runner = new SubAgentRunner();
        runner.setLLMCaller(llmCaller);
        runner.setToolExecutor(toolExecutor);


        // 8. 执行 ReAct 循环
        //    使用 overrideSystemPrompt 直传精简 prompt，不走 PromptBuilder 完整管线
        logger.info('[SkillAuditService] 开始执行审查 SA 循环...');
        const output = await runner.runWithDynamicLoop(
            auditSpec,
            taskContext,
            noopCheckpoint,
            [],
            undefined,
            undefined,
            undefined,
            systemPrompt,
        );

        logger.info(
            `[SkillAuditService] 审查 SA 执行完成: status=${output.status}, ` +
            `toolCalls=${output.toolCalls?.length ?? 0}`
        );

        // 9. 解析 SA 输出为结构化审查结果
        const auditResult = parseAuditResultFromOutput(output.observations, language);

        // 10. 更新 Store
        store.setSkillAuditResult(auditResult);
        logger.info(
            `[SkillAuditService] 审查裁决: ${auditResult.auditResult}, ` +
            `风险评分: ${auditResult.riskScore}/10, ` +
            `发现项: ${auditResult.findings.length}`
        );

        return auditResult;
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(`[SkillAuditService] 审查执行失败: ${errorMsg}`);

        // 更新 Store 为错误状态
        useRuntimeStore.getState().setSkillAuditError(errorMsg);

        // 审查服务不可用时返回错误结果（前端可提供跳过选项）
        return {
            auditResult: 'MANUAL_REVIEW_REQUIRED',
            riskScore: 5,
            confidence: 'LOW',
            summary: translate(
                'settings.skills.auditExecutionFailed',
                { error: errorMsg },
                language
            ),
            intentMismatch: false,
            detectedCapabilities: [],
            findings: [],
        };
    }
}

/**
 * 列举技能包内所有文件（递归，相对路径）
 *
 * 供调用方在审查前获取文件列表，用于构建目录树和全路径提供给 SA。
 * 文件/目录区分策略：尝试 listFiles() → 成功=目录，失败=文件。
 * 这比 exists() 更可靠（exists 对文件/目录都返回 true）。
 *
 * @param packagePath 技能包根目录
 * @param listFiles 列举目录文件函数（依赖注入）
 * @returns 文件相对路径列表
 */
export async function collectPackageFiles(
    packagePath: string,
    listFiles: (dir: string) => Promise<string[]>,
): Promise<string[]> {
    const result: string[] = [];
    const rootEntries = await listFiles(packagePath);

    for (const entry of rootEntries) {
        if (isEntrySkipped(entry)) {
            continue;
        }

        const lowerEntry = entry.toLowerCase();
        const fullPath = joinPackagePath(packagePath, entry);

        if (AUDIT_ROOT_FILES.has(lowerEntry)) {
            try {
                await listFiles(fullPath);
            } catch {
                result.push(entry);
            }
            continue;
        }

        if (!AUDIT_DISCLOSURE_DIRS.has(lowerEntry)) {
            continue;
        }

        try {
            await listFiles(fullPath);
            await scanDirRecursive(packagePath, entry, result, listFiles);
        } catch {
            // 同名文件不是渐进披露目录，不纳入审查范围
        }
    }

    return Array.from(new Set(result)).sort((a, b) => a.localeCompare(b));
}

/**
 * 递归扫描目录收集文件列表
 *
 * 文件/目录区分：尝试对路径执行 listFiles()，
 * 如果成功（返回 entries）则为目录，如果失败（OS 错误）则为文件。
 * 这比 exists() + readDir() 更可靠且只需一次 IPC 调用。
 */
async function scanDirRecursive(
    basePath: string,
    relativePath: string,
    result: string[],
    listFiles: (dir: string) => Promise<string[]>,
): Promise<void> {
    const sep = basePath.includes('\\') ? '\\' : '/';
    const currentDir = relativePath
        ? `${basePath}${sep}${relativePath}`
        : basePath;

    try {
        const entries = await listFiles(currentDir);
        for (const entry of entries) {
            if (isEntrySkipped(entry)) {
                continue;
            }

            const entryRelative = relativePath
                ? `${relativePath}${sep}${entry}`
                : entry;
            const fullPath = `${basePath}${sep}${entryRelative}`;

            // 跳过隐藏目录和常见无关目录
            if (entry.startsWith('.') || entry === 'node_modules' || entry === '__pycache__') {
                continue;
            }

            // 尝试作为目录处理：listFiles 成功=目录，失败=文件
            try {
                const subEntries = await listFiles(fullPath);
                // 成功 → 是目录，递归扫描（如果有子条目）
                if (subEntries.length > 0) {
                    await scanDirRecursive(basePath, entryRelative, result, listFiles);
                }
                // 空目录跳过
            } catch {
                // readDir 失败 → 是文件，加入结果
                result.push(entryRelative);
            }
        }
    } catch (error) {
        logger.warn(`[SkillAuditService] 扫描目录失败 ${currentDir}:`, error);
    }
}
