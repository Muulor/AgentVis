/**
 * ExecTool - Shell 命令执行工具
 *
 * 执行 Shell 命令，支持后台运行和超时控制
 *
 * 技能定义: SKILL.md
 * 工具实现: 本文件
 * 
 * 命令规范化层（在 shell_execute 之前执行）：
 * - normalizeSmartQuotesForWindowsCommand: 修正命令分隔用的中文/排版弯引号，同时保留路径内的 Unicode 标点
 * - normalizeWindowsQuotes: 修正 LLM 生成的 Linux 风格单引号
 * - normalizePythonCommand: 将裸 python/python3 替换为 venv 路径
 * - normalizeWindowsCommandLineBreaks: 将 cmd.exe 外层多行命令规范化为 & 分隔
 * - normalizeInlineEvalCommandQuotes: 兼容旧调用点，不再翻倍 node -e / python -c 外层引号
 *
 * 安全注意事项：
 * - 所有命令执行需要用户授权
 * - 命令输出会被截断以避免 Token 溢出
 */

import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { readDir } from '@tauri-apps/plugin-fs';
import { translate, type TranslationKey } from '@/i18n';
import type { Tool, ToolSchema, ToolResult, ToolExecutionContext } from '../../tools/types';
import { isExecCommandSafe, isExecCommandBlocked } from './ExecSafetyPolicy';
import { getLogger } from '@services/logger';
import { skillLoader } from '../SkillLoader';
import {
    isSupportedImagePath,
    loadImageAttachmentFromPath,
    resolveExternalImagePath,
    type ToolImageAttachment,
} from '../shared/imageAttachment';
import { getSandboxPathViolation } from '../shared/sandboxPath';
import { redactSensitiveObservation } from '../shared/observationRedaction';
import {
    activeNetworkDirectAllowancesForSubject,
    requestNetworkDirectAuthorization,
} from '@stores/networkDirectAuthorizationStore';
import { requestNetworkUploadAuthorization } from '@stores/networkUploadAuthorizationStore';
import type {
    NetworkDirectAllowance,
    NetworkDirectAuthorizationGrant,
    NetworkDirectSubjectType,
    NetworkDirectTarget,
} from '@/types/networkDirectAuthorization';
import type { NetworkRiskAuthorizationKind } from '@/types/networkUploadAuthorization';
import type { SandboxAuditEvent, SandboxAuditSource } from '@/types';
import type { SkillDefinition } from '../types';
import type { SkillAgentVisNetworkEntrypointMode } from '../external/types';

const logger = getLogger('ExecTool');

export const DEFAULT_EXEC_TIMEOUT_SECONDS = 120;
export const MAX_EXEC_TIMEOUT_SECONDS = 1800;

export type ResolvedExecTimeout =
    | { ok: true; timeout: number; explicit: boolean }
    | { ok: false; message: string };

export function resolveExecTimeout(value: unknown): ResolvedExecTimeout {
    const explicit = value !== undefined;
    if (!explicit) {
        return { ok: true, timeout: DEFAULT_EXEC_TIMEOUT_SECONDS, explicit: false };
    }

    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return {
            ok: false,
            message: translate('tools.exec.invalidTimeout', {
                min: 1,
                max: MAX_EXEC_TIMEOUT_SECONDS,
            }),
        };
    }

    const timeout = Math.floor(value);
    if (timeout > MAX_EXEC_TIMEOUT_SECONDS) {
        return {
            ok: false,
            message: translate('tools.exec.invalidTimeout', {
                min: 1,
                max: MAX_EXEC_TIMEOUT_SECONDS,
            }),
        };
    }

    return { ok: true, timeout, explicit: true };
}

export function formatExecProgressMessage(
    command: string,
    timeout: { timeout: number; explicit: boolean }
): string {
    return timeout.explicit
        ? translate('tools.exec.progressWithTimeout', {
            command,
            timeout: timeout.timeout,
        })
        : translate('tools.exec.progress', { command });
}

const NETWORK_RISK_CONFIRMATION_REASON_CODES = new Set([
    'network_upload_confirmation_required',
    'network_sensitive_egress_confirmation_required',
    'network_remote_destructive_confirmation_required',
]);

function networkRiskKindFromReasonCode(reasonCode: string): NetworkRiskAuthorizationKind {
    if (reasonCode === 'network_sensitive_egress_confirmation_required') {
        return 'sensitiveEgress';
    }
    if (reasonCode === 'network_remote_destructive_confirmation_required') {
        return 'remoteDestructive';
    }
    return 'fileUpload';
}

function networkRiskConfirmationFlags(reasonCode: string): Record<string, boolean> {
    if (reasonCode === 'network_sensitive_egress_confirmation_required') {
        return { networkSensitiveEgressConfirmed: true };
    }
    if (reasonCode === 'network_remote_destructive_confirmation_required') {
        return { networkRemoteDestructiveConfirmed: true };
    }
    return { networkUploadConfirmed: true };
}

/**
 * 工具 Schema
 */
const SCHEMA: ToolSchema = {
    name: 'exec',
    description: 'Execute a shell command. Supports working directory, timeout, and background execution. Sensitive operations require user approval.',
    parameters: {
        type: 'object',
        properties: {
            command: {
                type: 'string',
                description: 'Shell command to execute.',
            },
            workdir: {
                type: 'string',
                description: 'Working directory. Defaults to the current workspace directory.',
            },
            timeout: {
                type: 'number',
                description: 'Timeout in seconds. Defaults to 120. Maximum 1800. Use 300-600 for checks/builds, 600-1200 for dependency installs or large builds, and 1200-1800 for model downloads, video renders, or other known long-running work.',
            },
            background: {
                type: 'boolean',
                description: 'Whether to run the command in the background. Defaults to false.',
            },
        },
        required: ['command'],
    },
};

/**
 * 命令执行结果类型
 */
interface ExecResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
    terminated?: boolean;
    durationMs?: number;
    timeoutSecs?: number;
    stdoutTruncatedBytes?: number;
    stderrTruncatedBytes?: number;
}

interface NetworkDirectTargetInspection {
    targets: NetworkDirectTarget[];
    requiredProtocols: string[];
}

/**
 * 最大输出长度（字符）
 */
const MAX_OUTPUT_LENGTH = 10000;

const MAX_AUTO_IMAGE_ATTACHMENTS = 50;
const AUDIT_QUERY_GRACE_MS = 3000;
const AUDIT_PERSISTENCE_DELAY_MS = 150;
const AUDIT_SUMMARY_EVENT_LIMIT = 5;
const AUDIT_SUMMARY_HOST_LIMIT = 5;

const DETAILED_AUDIT_REASONS = new Set([
    'proxy_bypass_signal_blocked',
    'broker_network_block',
    'broker_proxy_required_unavailable',
    'broker_helper_unavailable',
    'broker_proxy_expected_but_unused',
    'network_direct_audit_allowed',
    'network_direct_metadata_target_blocked',
    'network_direct_private_session_scope_blocked',
    'network_upload_confirmation_required',
    'network_upload_risk_confirmed',
    'network_sensitive_egress_confirmation_required',
    'network_sensitive_egress_confirmed',
    'network_remote_destructive_confirmation_required',
    'network_remote_destructive_confirmed',
    'wfp_canary_unavailable',
    'wfp_canary_cleanup',
]);

interface ExecAuditQueryContext {
    sinceTimestamp: number;
    source: SandboxAuditSource;
    executionId?: string;
    subjectId?: string;
}

export interface ExternalSkillCommandReference {
    skillName: string;
    packagePath: string;
    mode?: SkillDefinition['mode'];
}

function createShellExecutionId(): string {
    return `shell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cancelledExecResult(command: string): ToolResult {
    return {
        success: false,
        content: translate('tools.exec.failed', {
            command,
            error: translate('tools.exec.cancelled'),
        }),
    };
}

export interface ExternalImageAttachmentCandidate {
    path: string;
    mimeType?: string;
    source: string;
}

export interface ExternalImageAttachmentExtractionOptions {
    allowPlainTextFallback?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => globalThis.setTimeout(resolve, ms));
}

function getNestedString(value: unknown, path: string[]): string | undefined {
    let current = value;
    for (const key of path) {
        if (!isRecord(current)) return undefined;
        current = current[key];
    }
    return typeof current === 'string' && current.trim() ? current : undefined;
}

function parseJsonObjectsFromOutput(output: string): unknown[] {
    const trimmed = output.trim().replace(/^\uFEFF/, '');
    if (!trimmed) return [];

    try {
        return [JSON.parse(trimmed)];
    } catch {
        // 继续尝试从行级输出中找最后一个 JSON 对象。
    }

    const parsed: unknown[] = [];
    const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line === undefined) continue;
        if (!line.startsWith('{') && !line.startsWith('[')) continue;
        try {
            parsed.push(JSON.parse(line));
            break;
        } catch {
            // 忽略非 JSON 日志行。
        }
    }
    return parsed;
}

function pushImageCandidate(
    candidates: ExternalImageAttachmentCandidate[],
    seenPaths: Set<string>,
    path: string | undefined,
    source: string,
    mimeType?: string
): void {
    if (!path) return;
    const normalizedPath = path.trim();
    if (!normalizedPath || seenPaths.has(normalizedPath)) return;
    seenPaths.add(normalizedPath);
    candidates.push({ path: normalizedPath, source, ...(mimeType && { mimeType }) });
}

function collectDeclaredAttachments(
    root: unknown,
    candidates: ExternalImageAttachmentCandidate[],
    seenPaths: Set<string>
): void {
    const context = isRecord(root)
        ? (root.agentvis_context ?? root.agentvisContext)
        : undefined;
    if (!isRecord(context) || !Array.isArray(context.attachments)) return;

    for (const attachment of context.attachments) {
        if (!isRecord(attachment)) continue;
        const type = typeof attachment.type === 'string' ? attachment.type.toLowerCase() : '';
        const path = attachment.path ?? attachment.filePath ?? attachment.file_path;
        if (type && type !== 'image') continue;
        if (typeof path !== 'string') continue;
        const mimeType = attachment.mimeType ?? attachment.mime_type;
        pushImageCandidate(
            candidates,
            seenPaths,
            path,
            'agentvis_context.attachments',
            typeof mimeType === 'string' ? mimeType : undefined
        );
    }
}

function collectKnownScreenshotPaths(
    root: unknown,
    candidates: ExternalImageAttachmentCandidate[],
    seenPaths: Set<string>
): void {
    const knownPaths: Array<{ path?: string; source: string }> = [
        {
            path: getNestedString(root, ['data', 'analysis', 'vision', 'screenshot_path']),
            source: 'data.analysis.vision.screenshot_path',
        },
        {
            path: getNestedString(root, ['data', 'analysis', 'vision', 'screenshotPath']),
            source: 'data.analysis.vision.screenshotPath',
        },
        {
            path: getNestedString(root, ['data', 'screenshot', 'path']),
            source: 'data.screenshot.path',
        },
        {
            path: getNestedString(root, ['data', 'screenshot_path']),
            source: 'data.screenshot_path',
        },
    ];

    const action = getNestedString(root, ['data', 'action']);
    // desktop-control 的截图/观察命令 + save_browser_image.py 的图片保存命令
    const IMAGE_PRODUCING_ACTIONS = [
        'screenshot', 'observe', 'find_text', 'click_text',
        'save_image', 'move_downloaded',
    ];
    if (action && IMAGE_PRODUCING_ACTIONS.includes(action)) {
        knownPaths.push({
            path: getNestedString(root, ['data', 'path']),
            source: 'data.path',
        });
    }

    for (const item of knownPaths) {
        pushImageCandidate(candidates, seenPaths, item.path, item.source);
    }
}

/**
 * 从纯文本 stdout 中提取图片文件的绝对路径
 *
 * 覆盖 agent-browser screenshot 等非 JSON 格式输出的场景。
 * 仅匹配绝对路径（Windows 盘符 or Unix /），且文件扩展名为常见图片格式，
 * 避免误匹配代码片段或日志中的相对路径。
 */
const IMAGE_PATH_REGEX = /(?:[A-Za-z]:[/\\]|\/)\S+?\.(?:png|jpg|jpeg|webp|gif|bmp)\b/gi;

export function shouldExtractPlainTextImageAttachmentPaths(command: string): boolean {
    const normalizedCommand = command.toLowerCase();

    if (/\bsave_browser_image(?:\.py)?\b/.test(normalizedCommand)) {
        return true;
    }

    const hasAutomationTool = /\b(?:agent-browser|browser-command(?:\.bat)?|desktop-control|desktop_control(?:\.py)?)\b/
        .test(normalizedCommand);
    if (!hasAutomationTool) {
        return false;
    }

    return /\b(?:screenshot|snapshot|observe|find_text|click_text|save_image|move_downloaded|capture)\b/
        .test(normalizedCommand);
}

function collectImagePathsFromPlainText(
    output: string,
    candidates: ExternalImageAttachmentCandidate[],
    seenPaths: Set<string>
): void {
    const matches = output.match(IMAGE_PATH_REGEX);
    if (!matches) return;

    for (const rawPath of matches) {
        // 去除尾部可能附带的标点符号（如引号、逗号、括号）
        const cleanedPath = rawPath.replace(/["',)\]}>]+$/, '');
        pushImageCandidate(candidates, seenPaths, cleanedPath, 'plaintext_path');
    }
}

export function extractExternalImageAttachmentCandidates(
    output: string,
    options: ExternalImageAttachmentExtractionOptions = {}
): ExternalImageAttachmentCandidate[] {
    const candidates: ExternalImageAttachmentCandidate[] = [];
    const seenPaths = new Set<string>();

    // 优先从结构化 JSON 中提取（desktop-control / save_browser_image.py）
    for (const root of parseJsonObjectsFromOutput(output)) {
        collectDeclaredAttachments(root, candidates, seenPaths);
        collectKnownScreenshotPaths(root, candidates, seenPaths);
    }

    // 兜底：从纯文本中提取图片路径（agent-browser screenshot 等）
    // seenPaths 确保 JSON 已提取的路径不会重复
    if (options.allowPlainTextFallback) {
        collectImagePathsFromPlainText(output, candidates, seenPaths);
    }

    return candidates;
}

async function loadAutoImageAttachmentsFromOutput(
    output: string,
    workdir?: string,
    command?: string
): Promise<{
    images: ToolImageAttachment[];
    loadedPaths: string[];
    warnings: string[];
}> {
    const candidates = extractExternalImageAttachmentCandidates(output, {
        allowPlainTextFallback: command
            ? shouldExtractPlainTextImageAttachmentPaths(command)
            : false,
    })
        .slice(0, MAX_AUTO_IMAGE_ATTACHMENTS);
    const images: ToolImageAttachment[] = [];
    const loadedPaths: string[] = [];
    const warnings: string[] = [];

    for (const candidate of candidates) {
        const resolvedPath = resolveExternalImagePath(candidate.path, workdir);
        if (!isSupportedImagePath(resolvedPath)) {
            warnings.push(translate('tools.exec.skipNonImageAttachment', { path: candidate.path }));
            continue;
        }

        try {
            const loaded = await loadImageAttachmentFromPath(
                candidate.path,
                workdir,
                candidate.mimeType,
                {
                    preserveDimensions: true,
                    compressPreservingDimensions: true,
                }
            );
            images.push(loaded.image);
            loadedPaths.push(loaded.path);
            logger.debug(
                `[ExecTool] 📷 自动注入外部工具图片: ${loaded.path}` +
                ` (source=${candidate.source}, compressed=${loaded.compressed})`
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(translate('tools.exec.imageAttachmentLoadFailed', {
                path: candidate.path,
                error: message,
            }));
            logger.warn('[ExecTool] 外部工具图片附件加载失败:', message);
        }
    }

    return { images, loadedPaths, warnings };
}

/**
 * 修正 PowerShell -Command 参数的外层引号
 *
 * LLM 常生成 powershell -Command 'Get-ChildItem ...' 的形式，
 * 用单引号包裹整个 -Command 参数值（Linux 习惯）。
 * 但 Rust 侧用 cmd /S /C "..." 执行命令，cmd.exe 不认单引号作为参数界定符，
 * 导致 PowerShell 接收到的 -Command 参数被截断或错乱。
 *
 * 修正策略：
 * - 精确匹配 -Command 后紧接的最外层单引号对（从首个 ' 到末尾的 '）
 * - 替换为双引号，使 cmd.exe 能正确识别参数边界
 * - 保留内部的 PowerShell 合法单引号不变（如 'C:\Program Files'）
 *
 * 安全约束：
 * - 如果内部已包含双引号，替换会导致 cmd.exe 引号嵌套问题，此时保持原样
 * - 只处理 -Command 后整段被单引号包裹的情况，已用双引号的不干预
 */
export function normalizePowerShellCommandQuotes(command: string): string {
    // 匹配: powershell/pwsh [可选 flags] -Command '整体参数值'
    // (?:\.exe)? — 支持 powershell.exe
    // .*? — 非贪婪匹配 -Command 前的可选 flags（如 -NoProfile）
    // '(.*)' — 贪婪匹配最外层单引号对（首个 ' 到末尾最后一个 '）
    // /s — dotAll 模式，. 匹配换行符（命令可能跨行）
    const match = command.match(
        /^((?:powershell|pwsh)(?:\.exe)?\s+.*?-[Cc]ommand\s+)'(.*)'(\s*)$/s
    );

    if (!match) {
        return command;
    }

    const prefix = match[1] ?? '';
    const body = match[2] ?? '';
    const trailing = match[3] ?? '';

    // 如果内部包含双引号，替换会导致 cmd.exe 引号嵌套问题，保持原样
    // LLM 在单引号外层包裹时，内部几乎不会使用双引号，所以这是极少触发的安全阀
    if (body.includes('"')) {
        return command;
    }

    return `${prefix}"${body}"${trailing}`;
}

/**
 * 规范化富文本/中文输入法常见的弯引号
 *
 * Agent 消息经过富文本复制、中文输入法或模型输出时，容易出现 “ ” ‘ ’。
 * 这些字符对 cmd.exe / python -c / node -e 都不是有效的 shell 引号或代码字符串引号，
 * 需要在其他命令修正之前先转成 ASCII 引号。
 */
export function normalizeSmartQuotes(command: string): string {
    if (!command) return command;

    return command
        .replace(/[\u201C\u201D\u201E\u201F\uFF02]/g, '"')
        .replace(/[\u2018\u2019\u201A\u201B\uFF07]/g, "'");
}

const SMART_DOUBLE_QUOTE_CHARS = /[\u201C\u201D\u201E\u201F\uFF02]/g;
const SMART_SINGLE_QUOTE_CHARS = /[\u2018\u2019\u201A\u201B\uFF07]/;
const SMART_SINGLE_QUOTE_GLOBAL = /[\u2018\u2019\u201A\u201B\uFF07]/g;

function normalizeSmartSingleQuotesOutsideDoubleQuotes(command: string): string {
    let result = '';
    let inDoubleQuotes = false;

    for (const char of command) {
        if (char === '"') {
            inDoubleQuotes = !inDoubleQuotes;
            result += char;
            continue;
        }

        if (!inDoubleQuotes && SMART_SINGLE_QUOTE_CHARS.test(char)) {
            result += "'";
            continue;
        }

        result += char;
    }

    return result;
}

function normalizeInlineEvalSmartSingleQuotes(command: string): string {
    return command.replace(
        /(\b(?:node|python|python3|python\.exe)\b(?:\s+(?!["])\S+)*\s+(?:-e|-c)\s+")([^"]*)(")/gi,
        (_match, prefix: string, code: string, suffix: string) => {
            return `${prefix}${code.replace(SMART_SINGLE_QUOTE_GLOBAL, "'")}${suffix}`;
        }
    );
}

/**
 * 规范化命令语法中的智能引号，但不改写双引号路径内的 Unicode 文件名字符。
 */
export function normalizeSmartQuotesForWindowsCommand(command: string): string {
    if (!command) return command;

    const normalizedDoubleQuotes = command.replace(SMART_DOUBLE_QUOTE_CHARS, '"');
    const normalizedSingleDelimiters = normalizeSmartSingleQuotesOutsideDoubleQuotes(normalizedDoubleQuotes);
    return normalizeInlineEvalSmartSingleQuotes(normalizedSingleDelimiters);
}

function currentCommandSegmentPrefix(command: string, quoteStart: number): string {
    let segmentStart = 0;
    for (let i = quoteStart - 1; i >= 0; i -= 1) {
        const char = command.charAt(i);
        if (char === '|' || char === '&') {
            segmentStart = i + 1;
            break;
        }
    }
    return command.slice(segmentStart, quoteStart).trimStart();
}

function isEchoCommandContext(command: string, quoteStart: number): boolean {
    return /^@?echo(?:\s|$|[.:])/i.test(currentCommandSegmentPrefix(command, quoteStart));
}

function isFindstrCommandContext(command: string, quoteStart: number): boolean {
    return /\bfindstr(?:\.exe)?\b/i.test(currentCommandSegmentPrefix(command, quoteStart));
}

function isForFCommandSubstitutionContext(command: string, quoteStart: number): boolean {
    return /(?:^|\s)@?for\s+\/f\b[\s\S]*\bin\s*\(\s*$/i
        .test(currentCommandSegmentPrefix(command, quoteStart));
}

function isInlineEvalCodeArgumentContext(command: string, quoteStart: number): boolean {
    return /\b(?:node|python3?(?:\.exe)?)\b[\s\S]*\s-(?:e|c)\s*$/i
        .test(currentCommandSegmentPrefix(command, quoteStart));
}

function shouldReplaceSingleQuotedSegment(command: string, quoteStart: number, inner: string): boolean {
    if (isInlineEvalCodeArgumentContext(command, quoteStart)) return true;
    if (isForFCommandSubstitutionContext(command, quoteStart)) return false;
    if (inner.includes('"') || isEchoCommandContext(command, quoteStart)) return false;
    if (isFindstrCommandContext(command, quoteStart)) return true;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(inner)) return true;
    if (/^(?:[a-z]:[\\/]|\\\\|\.{1,2}[\\/])/i.test(inner)) return true;
    if (/[\\/]/.test(inner)) return true;
    if (/[*?]/.test(inner)) return true;
    return /\s/.test(inner);
}

function quoteForWindowsCmdArg(inner: string, escapeInnerDoubleQuotes = false): string {
    const escaped = escapeInnerDoubleQuotes ? inner.replace(/"/g, '\\"') : inner;
    return escaped.endsWith('\\') ? `"${escaped}\\"` : `"${escaped}"`;
}

function replaceSingleQuotedSegmentsOutsideDoubleQuotes(command: string): string {
    let result = '';
    let inDoubleQuotes = false;
    let index = 0;

    while (index < command.length) {
        const char = command.charAt(index);

        if (char === '"') {
            inDoubleQuotes = !inDoubleQuotes;
            result += char;
            index += 1;
            continue;
        }

        if (char === "'" && !inDoubleQuotes) {
            const closingIndex = command.indexOf("'", index + 1);
            if (closingIndex > index) {
                const inner = command.slice(index + 1, closingIndex);
                if (shouldReplaceSingleQuotedSegment(command, index, inner)) {
                    result += quoteForWindowsCmdArg(
                        inner,
                        isInlineEvalCodeArgumentContext(command, index)
                    );
                } else {
                    result += command.slice(index, closingIndex + 1);
                }
                index = closingIndex + 1;
                continue;
            }
        }

        result += char;
        index += 1;
    }

    return result;
}

/**
 * 规范化 Windows 命令中的引号
 *
 * LLM 经常生成 Linux 风格的单引号（如 cmd /c 'path\script.bat' 'arg'），
 * 但 Windows cmd.exe 只认双引号。此函数将单引号包裹的路径/URL 转为双引号。
 *
 * 处理两类场景：
 * 1. PowerShell -Command '...' — 外层单引号转双引号（内部单引号不动）
 * 2. cmd.exe 上下文中的路径/URL 单引号 — 替换为双引号
 *
 * 为什么不能简单全量替换 PowerShell 命令的引号：
 * PowerShell 的 -Command 参数内部经常合法地使用单引号，
 * 例如 powershell -Command "Get-ChildItem 'C:\Program Files'"
 * 全量替换会破坏这类命令。因此 PowerShell 场景只处理最外层包裹引号。
 */
export function normalizeWindowsQuotes(command: string): string {
    if (!command) return command;

    command = normalizeSmartQuotesForWindowsCommand(command);
    const lowerCmd = command.toLowerCase();

    // PowerShell 命令：精确修正 -Command 外层引号，保留内部单引号
    if (lowerCmd.startsWith('powershell') || lowerCmd.startsWith('pwsh')) {
        return normalizePowerShellCommandQuotes(command);
    }

    // cmd.exe 上下文：只替换双引号外的单引号参数。
    // node -e / python -c 经常使用外层双引号包裹代码、内部单引号表示代码字符串；
    // 内部单引号不能替换成双引号，否则会提前闭合 -e/-c 参数。
    return replaceSingleQuotedSegmentsOutsideDoubleQuotes(command);
}

/**
 * 规范化 Python 命令路径
 *
 * 当 venv 就绪时，将裸 python/python3 替换为 venv Python 可执行文件路径。
 * 与 normalizeWindowsQuotes 同级别的命令修正层，解决 SA 偶发性不遵守 prompt 约束的问题。
 *
 * 替换规则（仅匹配命令起始位置的 python 调用）：
 * - `python script.py`        → `"venvPath" script.py`
 * - `python3 -m module`       → `"venvPath" -m module`
 * - `python.exe script.py`    → `"venvPath" script.py`
 * - `"python" script.py`      → `"venvPath" script.py`
 *
 * 不替换（已包含完整路径或非 python 开头）：
 * - `C:\...\python.exe script.py` → 保持不变
 * - `npm run python-xxx`          → 保持不变
 * - `pip install xxx`             → 保持不变（pip 不受影响）
 */
export function normalizePythonCommand(
    command: string,
    venvPythonPath: string
): string {
    if (!command || !venvPythonPath) return command;

    const trimmed = command.trim();

    // 匹配命令开头的裸 python 调用
    // 支持变体：python / python3 / python.exe / python3.exe / "python" / "python3"
    // (?:"?)? 匹配可选的前导引号
    // (?:\.exe)? 匹配可选的 .exe 后缀
    // (?:"?)? 匹配可选的后置引号
    // (\s+.*|$) 匹配后续参数或命令结束
    const pythonMatch = trimmed.match(
        /^("?)(?:python3?(?:\.exe)?)("?)(\s+.*|$)$/i
    );

    if (!pythonMatch) {
        return command;
    }

    const trailingArgs = pythonMatch[3] ?? '';

    // 使用双引号包裹 venv 路径（路径可能含空格）
    const normalizedCommand = `"${venvPythonPath}"${trailingArgs}`;

    return normalizedCommand;
}

/**
 * 兼容旧版本的 node -e / python -c 内联代码规范化入口。
 *
 * 过去这里会把包裹代码的双引号翻倍，但 cmd /S /C + raw_arg 已能保留原始双引号；
 * 翻倍会让 MSVCRT 把含空格的 inline eval 代码拆成多个 argv，导致 Python/Node 只执行片段。
 */
export function normalizeInlineEvalCommandQuotes(command: string): string {
    return command;
}

function hasTrailingLineContinuationCaret(value: string): boolean {
    const trimmed = value.replace(/[ \t]+$/g, '');
    let caretCount = 0;
    for (let index = trimmed.length - 1; index >= 0 && trimmed.charAt(index) === '^'; index -= 1) {
        caretCount += 1;
    }
    return caretCount % 2 === 1;
}

function isCaretEscaped(command: string, index: number): boolean {
    let caretCount = 0;
    for (let i = index - 1; i >= 0 && command.charAt(i) === '^'; i -= 1) {
        caretCount += 1;
    }
    return caretCount % 2 === 1;
}

function isBackslashEscaped(command: string, index: number): boolean {
    let backslashCount = 0;
    for (let i = index - 1; i >= 0 && command.charAt(i) === '\\'; i -= 1) {
        backslashCount += 1;
    }
    return backslashCount % 2 === 1;
}

export function normalizeWindowsCommandLineBreaks(command: string): string {
    if (!/[\r\n]/.test(command)) return command;

    let result = '';
    let quote: '"' | "'" | null = null;
    let pendingSeparator = false;

    for (let index = 0; index < command.length; index += 1) {
        const char = command.charAt(index);

        if (char === '\r' || char === '\n') {
            if (char === '\r' && command.charAt(index + 1) === '\n') {
                index += 1;
            }

            if (quote) {
                result += '\n';
                continue;
            }

            const trimmedEnd = result.replace(/[ \t]+$/g, '');
            if (hasTrailingLineContinuationCaret(trimmedEnd)) {
                result = trimmedEnd.slice(0, -1);
                pendingSeparator = false;
                continue;
            }
            if (trimmedEnd && !/[&|]\s*$/.test(trimmedEnd)) {
                result = trimmedEnd;
                pendingSeparator = true;
            } else {
                result = trimmedEnd;
            }
            continue;
        }

        if (pendingSeparator) {
            if (char === ' ' || char === '\t') {
                continue;
            }
            result += ' & ';
            pendingSeparator = false;
        }

        const escapedQuote = isCaretEscaped(command, index) ||
            (char === '"' && isBackslashEscaped(command, index));
        if ((char === '"' || char === "'") && !escapedQuote) {
            quote = quote === char ? null : (quote ?? char);
        }

        result += char;
    }

    return result;
}

/**
 * 规范化 findstr 命令中的 grep 风格 OR 语法
 *
 * LLM 经常生成 grep 风格的 findstr 命令，使用 \| 作为多模式 OR 分隔符：
 *   findstr /n "mixer\|channel\|vu-meter" file.css
 *
 * 但 findstr 的多模式搜索语法是空格分隔（非正则模式）：
 *   findstr /n "mixer channel vu-meter" file.css
 *
 * 此函数在 normalizeWindowsQuotes 之后执行（引号已修正为双引号），
 * 检测 findstr 命令中被双引号包裹的搜索模式是否包含 \|，
 * 若包含则将 \| 替换为空格。
 *
 * 不处理的场景（保持原样）：
 * - 非 findstr 命令
 * - 搜索模式中不含 \| 的 findstr 命令
 * - findstr /r（正则模式） — 不干预正则语法
 */
export function normalizeFindstrSyntax(command: string): string {
    if (!command) return command;

    const trimmed = command.trim();

    // 仅处理以 findstr 开头的命令
    if (!/^findstr\b/i.test(trimmed)) {
        return command;
    }

    // 如果使用了 /r 正则模式，不干预（\| 可能是合法正则语法，虽然 findstr 不支持 \|）
    if (/\s\/r\b/i.test(trimmed)) {
        return command;
    }

    // 替换双引号包裹的搜索模式中的 \| 为空格
    // 匹配 "pattern1\|pattern2\|pattern3" 中的 \| 分隔符
    return command.replace(
        /"([^"]*\\\|[^"]*)"/g,
        (_match, inner: string) => {
            const normalized = inner.replace(/\\\|/g, ' ');
            return `"${normalized}"`;
        }
    );
}

/**
 * 高频 Linux→Windows 命令提示映射
 *
 * 仅收录 LLM 最常误用的命令，不穷举。
 * key 是 stderr 中 'XXX' is not recognized 的 XXX 部分（小写），
 * value 是 Windows 等价写法的提示。
 */
const LINUX_COMMAND_HINTS: ReadonlyMap<string, TranslationKey> = new Map([
    // 文本处理 — LLM 在 cmd pipe 中最容易误用的
    ['head', 'tools.exec.hintHead'],
    ['tail', 'tools.exec.hintTail'],
    ['grep', 'tools.exec.hintGrep'],
    ['awk', 'tools.exec.hintAwk'],
    ['sed', 'tools.exec.hintSed'],
    ['wc', 'tools.exec.hintWc'],
    ['cut', 'tools.exec.hintCut'],
    ['tr', 'tools.exec.hintTr'],
    ['sort', 'tools.exec.hintSort'],
    ['uniq', 'tools.exec.hintUniq'],
    ['tee', 'tools.exec.hintTee'],
    ['xargs', 'tools.exec.hintXargs'],

    // 文件操作
    ['cat', 'tools.exec.hintCat'],
    ['ls', 'tools.exec.hintLs'],
    ['rm', 'tools.exec.hintRm'],
    ['cp', 'tools.exec.hintCp'],
    ['mv', 'tools.exec.hintMv'],
    ['touch', 'tools.exec.hintTouch'],
    ['ln', 'tools.exec.hintLn'],
    ['chmod', 'tools.exec.hintChmod'],
    ['chown', 'tools.exec.hintChown'],

    // 查找与系统
    ['which', 'tools.exec.hintWhich'],
    ['whoami', 'tools.exec.hintWhoami'],
    ['diff', 'tools.exec.hintDiff'],
    ['wget', 'tools.exec.hintWget'],
    ['basename', 'tools.exec.hintBasename'],
    ['dirname', 'tools.exec.hintDirname'],
    ['realpath', 'tools.exec.hintRealpath'],
]);

const CMD_NOT_RECOGNIZED_PATTERN =
    /'([^']+)'+\s+(?:is not recognized as an internal or external command|不是内部或外部命令)/i;

interface WindowsCommandToken {
    value: string;
    separator: boolean;
}

function tokenizeWindowsCommand(command: string): WindowsCommandToken[] {
    const tokens: WindowsCommandToken[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;

    const pushCurrent = () => {
        if (current.length > 0) {
            tokens.push({ value: current, separator: false });
            current = '';
        }
    };

    for (let index = 0; index < command.length; index += 1) {
        const char = command.charAt(index);
        const escapedQuote = isCaretEscaped(command, index) ||
            (char === '"' && isBackslashEscaped(command, index));

        if (!quote && (char === '|' || char === '&') && !isCaretEscaped(command, index)) {
            pushCurrent();
            tokens.push({ value: char, separator: true });
            continue;
        }

        if (!quote && /\s/.test(char)) {
            pushCurrent();
            continue;
        }

        if ((char === '"' || char === "'") && !escapedQuote) {
            quote = quote === char ? null : (quote ?? char);
            continue;
        }

        current += char;
    }

    pushCurrent();
    return tokens;
}

function inlineEvalFlagForInterpreter(token: string): '-c' | '-e' | null {
    const normalized = token.replace(/\//g, '\\').toLowerCase();
    if (/(?:^|\\)python3?(?:\.exe)?$/.test(normalized)) {
        return '-c';
    }
    if (/(?:^|\\)node(?:\.exe)?$/.test(normalized)) {
        return '-e';
    }
    return null;
}

function containsInlineEvalCodeNewline(command: string): boolean {
    const tokens = tokenizeWindowsCommand(command);

    for (let index = 0; index < tokens.length; index += 1) {
        const expectedFlag = inlineEvalFlagForInterpreter(tokens[index]?.value ?? '');
        if (!expectedFlag) {
            continue;
        }

        for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
            const token = tokens[cursor];
            if (!token || token.separator) {
                break;
            }
            if (token.value.toLowerCase() !== expectedFlag) {
                continue;
            }

            const codeToken = tokens[cursor + 1];
            return Boolean(codeToken && !codeToken.separator && /[\r\n]/.test(codeToken.value));
        }
    }

    return false;
}

function hasUnescapedCmdShellOperator(command: string): boolean {
    let inDoubleQuotes = false;

    for (let index = 0; index < command.length; index += 1) {
        const char = command.charAt(index);
        if (char === '"' && !isCaretEscaped(command, index) && !isBackslashEscaped(command, index)) {
            inDoubleQuotes = !inDoubleQuotes;
            continue;
        }
        if (!inDoubleQuotes && (char === '|' || char === '&') && !isCaretEscaped(command, index)) {
            return true;
        }
    }

    return false;
}

function extractNotRecognizedCommand(stderr: string): string | null {
    const notRecognizedMatch = stderr.match(CMD_NOT_RECOGNIZED_PATTERN);
    const commandName = notRecognizedMatch?.[1]?.toLowerCase().trim();
    return commandName ?? null;
}

/**
 * 分析命令失败的 stderr，生成 Windows 环境下的修正提示
 *
 * 策略分两层：
 * 1. 精准匹配：从高频映射表中查找具体 Linux 命令的 Windows 等价写法
 * 2. 通用兜底：只要 stderr 出现 "is not recognized"，就提示当前是 Windows
 *
 * 设计决策：
 * - 不做命令翻译（翻译无法保证语义正确，尤其是复杂管道场景）
 * - 只给出提示，让 Agent 在下一轮自行生成正确的 Windows 命令
 * - 提示嵌入到 exec 工具的错误输出中，Agent 自然会在上下文中看到
 */
export function generateWindowsCommandHint(stderr: string, _command: string): string | null {
    if (!stderr) return null;

    // 检测 cmd.exe 找不到命令时的标准错误格式
    // 英文 Windows: 'head' is not recognized as an internal or external command
    // 中文 Windows: 'head' 不是内部或外部命令，也不是可运行的程序或批处理文件。
    // 错误信息语言由系统 locale 决定，chcp 65001 只切换代码页而不改变语言，
    // 因此必须同时匹配两种语言，否则中文系统上提示永远不会注入。
    const linuxCmd = extractNotRecognizedCommand(stderr);
    if (!linuxCmd) return null;

    // 第一层：精准匹配高频命令
    const specificHintKey = LINUX_COMMAND_HINTS.get(linuxCmd);
    if (specificHintKey) {
        return translate('tools.exec.windowsSpecificHint', {
            command: linuxCmd,
            hint: translate(specificHintKey),
        });
    }

    // 第二层：通用兜底提示
    return translate('tools.exec.windowsGenericHint', { command: linuxCmd });
}

const WINDOWS_FILE_READ_COMMAND_PATTERN =
    /(^|[|&]\s*)(?:chcp\s+\d+\s*>nul\s*&&\s*)?(?:type\b|(?:powershell|pwsh)(?:\.exe)?\b[\s\S]*\b(?:get-content|gc)\b)/i;

const WINDOWS_FILE_READ_PATH_FAILURE_PATTERN =
    /(?:system cannot find|cannot find path|does not exist|specified path|specified file|resource not found|itemnotfound|filtered by the -include|-exclude parameter|terminator|系统找不到指定的文件|找不到指定|不存在|字符串缺少终止符|缺少字符串终止符)/i;

const MOJIBAKE_PATTERN =
    /(?:鈥|檙|â€™|â€œ|â€�|â€“|â€”|Ã.|锟�|ï»¿)/;

const EXEC_TIMEOUT_PATTERN =
    /(?:timed?\s*out|timeout|deadline exceeded|execution exceeded|超时|逾时)/i;

const CARGO_TEST_COMMAND_PATTERN =
    /\bcargo(?:\.exe)?(?:\s+\+\S+)?\s+test\b/i;

const CMD_SET_VARIABLE_PATTERN =
    /\bset(?:\s+\/a)?\s+"?([A-Za-z_][A-Za-z0-9_]*)=/i;

const CMD_DELAYED_EXPANSION_PATTERN =
    /\bsetlocal\s+enabledelayedexpansion\b/i;

const CMD_EXPLICIT_EXIT_PATTERN =
    /\bsys\.exit\s*\(|\bprocess\.exit\s*\(|\bexit\s+(?:\/b\s*)?\d+\b/i;

const CMD_ECHO_COMMAND_PATTERN =
    /(^|[&|]\s*)(?:chcp\s+\d+\s*>nul\s*(?:&|&&)\s*)?@?echo(?:\s|$|[.:])/i;

const UNICODE_REPLACEMENT_OUTPUT_PATTERN =
    /(?:�|\?{2,})/;

const CMD_LABEL_DRIVE_ERROR_PATTERN =
    /(?:system cannot find the drive specified|系统找不到指定的驱动器)/i;

const CMD_SET_PROMPT_PATTERN =
    /\bset\s+\/p\b/i;

function containsNonAscii(value: string): boolean {
    for (const char of value) {
        if (char.charCodeAt(0) > 0x7F) {
            return true;
        }
    }
    return false;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function singleQuotedSegmentHasUnescapedShellOperator(inner: string): boolean {
    for (let index = 0; index < inner.length; index += 1) {
        const char = inner.charAt(index);
        if ((char === '&' || char === '|') && !isCaretEscaped(inner, index)) {
            return true;
        }
    }
    return false;
}

function hasEchoSingleQuotedShellOperator(command: string): boolean {
    let inDoubleQuotes = false;
    let index = 0;

    while (index < command.length) {
        const char = command.charAt(index);
        if (char === '"' && !isCaretEscaped(command, index) && !isBackslashEscaped(command, index)) {
            inDoubleQuotes = !inDoubleQuotes;
            index += 1;
            continue;
        }

        if (char === "'" && !inDoubleQuotes) {
            const closingIndex = command.indexOf("'", index + 1);
            if (closingIndex > index) {
                const inner = command.slice(index + 1, closingIndex);
                if (
                    isEchoCommandContext(command, index) &&
                    !isForFCommandSubstitutionContext(command, index) &&
                    singleQuotedSegmentHasUnescapedShellOperator(inner)
                ) {
                    return true;
                }
                index = closingIndex + 1;
                continue;
            }
        }

        index += 1;
    }

    return false;
}

function isRemCommentCommandWithOperator(command: string): boolean {
    const trimmed = command.trimStart();
    if (!/^@?rem(?:\s|$)/i.test(trimmed)) {
        return false;
    }
    return hasUnescapedCmdShellOperator(trimmed);
}

function hasCmdDoubleColonLabel(command: string): boolean {
    return /(?:^|[&|]\s*)::/.test(command);
}

export function generateFileReadPathFailureHint(command: string, output: string): string | null {
    if (!WINDOWS_FILE_READ_COMMAND_PATTERN.test(command)) {
        return null;
    }
    if (!WINDOWS_FILE_READ_PATH_FAILURE_PATTERN.test(output)) {
        return null;
    }
    return translate('tools.exec.fileReadPathFailureHint');
}

export function generateMojibakeHint(command: string, output: string): string | null {
    if (!WINDOWS_FILE_READ_COMMAND_PATTERN.test(command)) {
        return null;
    }
    if (!MOJIBAKE_PATTERN.test(output)) {
        return null;
    }
    return translate('tools.exec.mojibakeHint');
}

export function generateInlineEvalNewlineHint(command: string): string | null {
    if (!containsInlineEvalCodeNewline(command)) {
        return null;
    }
    return translate('tools.exec.inlineEvalNewlineHint');
}

export function generateCmdVariableExpansionHint(command: string): string | null {
    const setMatch = command.match(CMD_SET_VARIABLE_PATTERN);
    if (setMatch?.[1]) {
        const variableName = setMatch[1];
        const setIndex = setMatch.index ?? 0;
        const afterSet = command.slice(setIndex + setMatch[0].length);
        const variableExpansionPattern = new RegExp(
            `%{1,2}${escapeRegExp(variableName)}(?:%|[:~])`,
            'i'
        );
        if (
            /[&\r\n]/.test(afterSet) &&
            variableExpansionPattern.test(afterSet)
        ) {
            return translate('tools.exec.cmdVariableExpansionHint');
        }
    }

    if (CMD_DELAYED_EXPANSION_PATTERN.test(command) && /![A-Za-z_][A-Za-z0-9_]*!/.test(command)) {
        return translate('tools.exec.cmdDelayedExpansionHint');
    }

    return null;
}

export function generateShellOperatorHint(command: string, stderr: string): string | null {
    const unknownCommand = extractNotRecognizedCommand(stderr);
    if (!unknownCommand || LINUX_COMMAND_HINTS.has(unknownCommand)) {
        return null;
    }
    if (!hasUnescapedCmdShellOperator(command)) {
        return null;
    }
    return translate('tools.exec.shellOperatorHint', { command: unknownCommand });
}

export function generateCmdSingleQuoteOperatorHint(command: string): string | null {
    if (!hasEchoSingleQuotedShellOperator(command)) {
        return null;
    }
    return translate('tools.exec.cmdSingleQuoteOperatorHint');
}

export function generateRemCommandHint(command: string): string | null {
    if (!isRemCommentCommandWithOperator(command)) {
        return null;
    }
    return translate('tools.exec.remCommandHint');
}

export function generateCmdLabelHint(command: string, output: string): string | null {
    if (!hasCmdDoubleColonLabel(command) || !CMD_LABEL_DRIVE_ERROR_PATTERN.test(output)) {
        return null;
    }
    return translate('tools.exec.cmdLabelHint');
}

export function generateCmdSetPromptHint(
    command: string,
    exitCode: number,
    stderr: string
): string | null {
    if (!CMD_SET_PROMPT_PATTERN.test(command) || exitCode === 0 || stderr.trim()) {
        return null;
    }
    return translate('tools.exec.cmdSetPromptHint');
}

export function generateUnicodeReplacementHint(command: string, output: string): string | null {
    if (!containsNonAscii(command)) {
        return null;
    }
    if (!CMD_ECHO_COMMAND_PATTERN.test(command)) {
        return null;
    }
    if (!UNICODE_REPLACEMENT_OUTPUT_PATTERN.test(output)) {
        return null;
    }
    return translate('tools.exec.unicodeReplacementHint');
}

export function generateSilentNonZeroExitHint(
    command: string,
    exitCode: number,
    stdout: string,
    stderr: string
): string | null {
    if (exitCode === 0 || stderr.trim() || CMD_EXPLICIT_EXIT_PATTERN.test(command)) {
        return null;
    }
    if (/\bfindstr(?:\.exe)?\b/i.test(command)) {
        return translate('tools.exec.findstrSilentExitHint');
    }
    if (!stdout.trim()) {
        return translate('tools.exec.silentNonZeroExitHint', { exitCode });
    }
    return null;
}

function appendExecObservationHint(hints: string[], hint: string | null): void {
    if (hint && !hints.includes(hint)) {
        hints.push(hint);
    }
}

export function collectExecObservationHints(
    command: string,
    exitCode: number,
    stdout: string,
    stderr: string
): string[] {
    const hints: string[] = [];
    appendExecObservationHint(hints, generateInlineEvalNewlineHint(command));
    appendExecObservationHint(hints, generateCmdVariableExpansionHint(command));
    if (exitCode === 0) {
        appendExecObservationHint(hints, generateCmdSingleQuoteOperatorHint(command));
        appendExecObservationHint(hints, generateRemCommandHint(command));
    }
    appendExecObservationHint(hints, generateCmdLabelHint(command, `${stdout}\n${stderr}`));
    appendExecObservationHint(hints, generateCmdSetPromptHint(command, exitCode, stderr));
    appendExecObservationHint(hints, generateUnicodeReplacementHint(command, `${stdout}\n${stderr}`));
    appendExecObservationHint(hints, generateMojibakeHint(command, `${stdout}\n${stderr}`));
    appendExecObservationHint(hints, generateSilentNonZeroExitHint(command, exitCode, stdout, stderr));
    return hints;
}

export function generateExecTimeoutGuidance(command: string, output: string): string | null {
    if (!EXEC_TIMEOUT_PATTERN.test(output)) {
        return null;
    }

    return CARGO_TEST_COMMAND_PATTERN.test(command)
        ? translate('tools.exec.cargoTestTimeoutHint')
        : translate('tools.exec.timeoutHint');
}

/**
 * 判断命令是否可能向 workdir 写入新文件
 *
 * 启发式检测，通过分析命令字符串特征来决定是否需要前后快照。
 * 设计原则：“宁可多扫，不轻易漏检”——假阳性的代价只是多 2 次 IPC，假阴性代价是用户需要手动刷新。
 *
 * 忽略扫描的命令示例（纯读/执行类）：
 *   - dir, echo, type, where, npx tsc, node script.js, pip list
 *   - git status, git log, npm test, tsc --noEmit
 *
 * 触发扫描的命令示例（写文件类）：
 *   - copy, xcopy, robocopy, move, curl -o, wget -O, Invoke-WebRequest
 *   - 重定向运算符 >，包含文件路径的命令， npm run build, python script.py
 */
type OfflineIsolatedExecSandboxMode = 'OfflineIsolated';

function isOfflineIsolatedExecSandboxMode(
    sandboxMode: ToolExecutionContext['sandboxMode']
): sandboxMode is OfflineIsolatedExecSandboxMode {
    return sandboxMode === 'OfflineIsolated';
}

const GLOBAL_INSTALL_OR_LOGIN_COMMAND_PATTERN =
    /\b(?:npm|pnpm|yarn)\s+login\b|\bnpm\s+(?:install|i)\s+-g\b|\bpnpm\s+(?:add|install)\s+-g\b|\byarn\s+global\b|\bpip(?:3)?\s+install\b.*\s--user\b|\b(?:gh|vercel)\s+(?:auth|login)\b/i;

const CREDENTIAL_OR_CONFIG_PATTERN =
    /\.github_token|\.vercel|\.npmrc|\.env|\.aws|\.azure|\.config|credential|credentials|token|api[ _-]?key|apikey|auth|authentication|not logged in|not authenticated|login required|no such file.*(?:token|config|credential)|not found.*(?:token|config|credential)|未登录|凭证|令牌|配置|身份验证|认证/i;

const COMMAND_MISSING_PATTERN =
    /is not recognized as an internal or external command|is not recognized as the name of|command not found|enoent|找不到.*命令|无法将|不是内部或外部命令/i;

const NETWORK_OR_LOCALHOST_PATTERN =
    /localhost|127\.0\.0\.1|loopback|connection refused|econnrefused|network is unreachable|failed to connect|could not resolve host|name resolution|socket access|access permissions|dns|proxy|timeout|timed out|无法连接|连接被拒绝|无法解析|访问权限不允许|网络/i;

const FILESYSTEM_BOUNDARY_PATTERN =
    /eperm|operation not permitted|lstat ['"]?[A-Za-z]:\\?['"]?|access is denied.*(?:lstat|[A-Za-z]:\\)|permission denied.*(?:lstat|[A-Za-z]:\\)|拒绝访问.*(?:lstat|[A-Za-z]:\\)/i;

function detectSandboxHintReasonKey(
    command: string,
    output: string
): TranslationKey | undefined {
    if (GLOBAL_INSTALL_OR_LOGIN_COMMAND_PATTERN.test(command)) {
        return 'tools.exec.sandboxHintReasons.globalInstallOrLogin';
    }
    if (CREDENTIAL_OR_CONFIG_PATTERN.test(`${command}\n${output}`)) {
        return 'tools.exec.sandboxHintReasons.credentialOrConfig';
    }
    if (FILESYSTEM_BOUNDARY_PATTERN.test(output)) {
        return 'tools.exec.sandboxHintReasons.filesystemBoundary';
    }
    if (COMMAND_MISSING_PATTERN.test(output) || isWindowsWhereMiss(command, output)) {
        return 'tools.exec.sandboxHintReasons.commandMissing';
    }
    if (NETWORK_OR_LOCALHOST_PATTERN.test(output)) {
        return 'tools.exec.sandboxHintReasons.networkOrLocalhost';
    }
    return undefined;
}

function isWindowsWhereMiss(command: string, output: string): boolean {
    return /^\s*where(?:\.exe)?\s+/i.test(command) &&
        /could not find files for the given pattern/i.test(output);
}

export function generateSandboxRuntimeCommandHint(
    command: string,
    stdout: string,
    stderr: string,
    sandboxMode: ToolExecutionContext['sandboxMode']
): string | null {
    if (!isOfflineIsolatedExecSandboxMode(sandboxMode)) {
        return null;
    }

    const reasonKey = detectSandboxHintReasonKey(command, `${stdout}\n${stderr}`);
    if (!reasonKey) {
        return null;
    }

    return translate('tools.exec.sandboxRuntimeHint', {
        mode: sandboxMode,
        reason: translate(reasonKey),
    });
}

function extractSandboxReasonCode(errorMessage: string): string | undefined {
    return errorMessage.match(/Sandbox block \[([\w-]+)\]/)?.[1];
}

function isSandboxBlockMessage(message: string): boolean {
    return message.includes('Sandbox block') ||
        message.includes('sandbox block') ||
        message.includes('沙箱') ||
        message.includes('娌欑');
}

function formatSandboxGuardError(errorMessage: string): string | null {
    const reasonCode = extractSandboxReasonCode(errorMessage);
    if (reasonCode === 'proxy_bypass_signal_blocked') {
        return translate('tools.sandboxGuard.proxyBypassSignalBlocked', { error: errorMessage });
    }
    if (reasonCode === 'broker_proxy_required_unavailable') {
        return translate('tools.sandboxGuard.brokerProxyRequiredUnavailable', { error: errorMessage });
    }
    if (reasonCode === 'network_upload_confirmation_required') {
        return translate('tools.sandboxGuard.networkUploadConfirmationRequired', { error: errorMessage });
    }
    if (reasonCode === 'network_sensitive_egress_confirmation_required') {
        return translate('tools.sandboxGuard.networkSensitiveEgressConfirmationRequired', { error: errorMessage });
    }
    if (reasonCode === 'network_remote_destructive_confirmation_required') {
        return translate('tools.sandboxGuard.networkRemoteDestructiveConfirmationRequired', { error: errorMessage });
    }
    if (reasonCode === 'network_direct_metadata_target_blocked') {
        return translate('tools.sandboxGuard.networkDirectMetadataBlocked', { error: errorMessage });
    }
    if (reasonCode === 'network_direct_private_session_scope_blocked') {
        return translate('tools.sandboxGuard.networkDirectPrivateSessionBlocked', { error: errorMessage });
    }
    return null;
}

function auditValue(value: string | null | undefined, maxLength = 140): string {
    if (!value) return '';
    const redacted = redactSensitiveObservation(value).replace(/\s+/g, ' ').trim();
    return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}...` : redacted;
}

function uniqueLimited(values: Array<string | null | undefined>, limit: number): string {
    const unique = [...new Set(values.map(value => auditValue(value, 60)).filter(Boolean))];
    if (unique.length === 0) return 'none';
    const shown = unique.slice(0, limit);
    return unique.length > limit ? `${shown.join(',')}+${unique.length - limit}` : shown.join(',');
}

function auditEventTarget(event: SandboxAuditEvent): string {
    const method = event.requestMethod ? `${event.requestMethod} ` : '';
    const port = event.targetPort ? `:${event.targetPort}` : '';
    const host = auditValue(event.targetHost, 120);
    if (event.targetScheme && host) {
        return `${method}${event.targetScheme}://${host}${port}`;
    }
    if (host) {
        return `${method}${host}${port}`;
    }
    return auditValue(event.matchedPattern, 80);
}

function extractAuditDetailValue(event: SandboxAuditEvent, key: string): string | null {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return event.matchedPattern?.match(new RegExp(`\\b${escapedKey}=([^;]+)`))?.[1]?.trim() ?? null;
}

function extractTaskCategory(event: SandboxAuditEvent): string | null {
    return extractAuditDetailValue(event, 'taskCategory');
}

function extractBrokerUnusedReasonClass(event: SandboxAuditEvent): string | null {
    return extractAuditDetailValue(event, 'reasonClass')
        ?? extractAuditDetailValue(event, 'classification');
}

function auditEventRiskDetail(event: SandboxAuditEvent): string | null {
    const parts: string[] = [];
    if (event.riskClass) {
        parts.push(`riskClass=${auditValue(event.riskClass, 60)}`);
    }
    if (event.riskKind) {
        parts.push(`riskKind=${auditValue(event.riskKind, 60)}`);
    }
    if (event.credentialContext) {
        parts.push(`credentialContext=${auditValue(event.credentialContext, 60)}`);
    }
    return parts.length > 0 ? parts.join('; ') : null;
}

function isDetailedAuditEvent(event: SandboxAuditEvent): boolean {
    return event.decision === 'block' ||
        event.guardMode === 'hardBlock' ||
        event.guardMode === 'directAuditAllowed' ||
        DETAILED_AUDIT_REASONS.has(event.reason) ||
        event.reason.startsWith('wfp_managed_egress_');
}

function formatDetailedAuditEvent(event: SandboxAuditEvent): string {
    const target = auditEventTarget(event);
    const detail = [auditEventRiskDetail(event), event.matchedPattern ? auditValue(event.matchedPattern) : null]
        .filter(Boolean)
        .join('; ');
    return translate('tools.exec.auditSummaryEventLine', {
        backend: event.backend,
        decision: event.decision,
        reason: event.reason,
        guard: event.guardMode ? ` guard=${event.guardMode}` : '',
        target: target ? ` target=${target}` : '',
        status: event.statusCode != null ? ` status=${event.statusCode}` : '',
        blocked: event.blockedReason ? ` blocked=${auditValue(event.blockedReason)}` : '',
        detail: detail ? ` detail=${detail}` : '',
    });
}

export function buildExecSandboxAuditSummary(events: SandboxAuditEvent[]): string | null {
    const brokerEvents = events.filter(event => event.backend === 'broker');
    const brokerRequests = brokerEvents.filter(event => event.reason === 'broker_network_request');
    const brokerBlocks = brokerEvents.filter(event => event.reason === 'broker_network_block' || event.decision === 'block');
    const wfpCanaryEvents = events.filter(event =>
        event.backend === 'wfpEnhanced' && event.reason.startsWith('wfp_canary_')
    );
    const wfpCanarySummaryEvents = wfpCanaryEvents.filter(event =>
        event.reason !== 'wfp_canary_readiness' || event.guardMode === 'wouldBlock'
    );
    const detailedEvents = events.filter(isDetailedAuditEvent).slice(0, AUDIT_SUMMARY_EVENT_LIMIT);
    const lines: string[] = [];

    if (brokerRequests.length > 0 || brokerBlocks.length > 0) {
        lines.push(translate('tools.exec.auditSummaryBrokerLine', {
            requestCount: brokerRequests.length,
            blockedCount: brokerBlocks.length,
            hosts: uniqueLimited(brokerEvents.map(event => event.targetHost), AUDIT_SUMMARY_HOST_LIMIT),
        }));
    }

    if (wfpCanarySummaryEvents.length > 0) {
        lines.push(translate('tools.exec.auditSummaryWfpCanaryLine', {
            count: wfpCanarySummaryEvents.length,
            guardModes: uniqueLimited(wfpCanarySummaryEvents.map(event => event.guardMode), 4),
            reasons: uniqueLimited(wfpCanarySummaryEvents.map(event => event.reason), 4),
            taskCategories: uniqueLimited(wfpCanarySummaryEvents.map(extractTaskCategory), 4),
        }));
    }

    lines.push(...detailedEvents.map(formatDetailedAuditEvent));

    const hiddenCount = events.filter(isDetailedAuditEvent).length - detailedEvents.length;
    if (hiddenCount > 0) {
        lines.push(translate('tools.exec.auditSummaryMoreEvents', { count: hiddenCount }));
    }

    if (events.some(event => event.reason === 'proxy_bypass_signal_blocked')) {
        lines.push(translate('tools.exec.auditSummaryProxyBypassHint'));
    }

    const brokerUnusedEvents = events.filter(event => event.reason === 'broker_proxy_expected_but_unused');
    if (brokerUnusedEvents.length > 0) {
        lines.push(translate('tools.exec.auditSummaryBrokerUnusedHint', {
            reasonClasses: uniqueLimited(brokerUnusedEvents.map(extractBrokerUnusedReasonClass), 4),
        }));
    }

    if (events.some(event => event.reason === 'network_upload_risk_confirmed')) {
        lines.push(translate('tools.exec.auditSummaryUploadHint'));
    }

    if (events.some(event => event.reason === 'network_sensitive_egress_confirmed')) {
        lines.push(translate('tools.exec.auditSummarySensitiveEgressHint'));
    }

    if (events.some(event => event.reason === 'network_remote_destructive_confirmed')) {
        lines.push(translate('tools.exec.auditSummaryRemoteDestructiveHint'));
    }

    if (lines.length === 0) {
        return null;
    }

    return `${translate('tools.exec.auditSummaryHeader')}:\n${lines.join('\n')}`;
}

async function loadExecSandboxAuditEvents(query: ExecAuditQueryContext | null): Promise<SandboxAuditEvent[]> {
    if (!query) return [];
    await delay(AUDIT_PERSISTENCE_DELAY_MS);
    try {
        const sinceTimestamp = query.sinceTimestamp - AUDIT_QUERY_GRACE_MS;
        const events = await invoke<SandboxAuditEvent[]>('sandbox_audit_events', {
            limit: 200,
            offset: 0,
            sinceTimestamp,
            source: query.source,
            subjectId: query.subjectId ?? null,
            reason: null,
            guardMode: null,
        });
        return events
            .filter(event => {
                if (event.timestamp < sinceTimestamp) return false;
                if (query.executionId && event.executionId) {
                    return event.executionId === query.executionId;
                }
                if (query.executionId && event.backend === 'broker') {
                    return !query.subjectId || event.subjectId === query.subjectId;
                }
                return !query.subjectId || event.subjectId === query.subjectId;
            })
            .sort((a, b) => a.timestamp - b.timestamp);
    } catch (error) {
        logger.warn('[ExecTool] failed to load sandbox audit summary:', error);
        return [];
    }
}

async function buildExecSandboxAuditSummaryForQuery(query: ExecAuditQueryContext | null): Promise<string | null> {
    return buildExecSandboxAuditSummary(await loadExecSandboxAuditEvents(query));
}

function isProxyBypassSignalBlock(errorMessage: string): boolean {
    return extractSandboxReasonCode(errorMessage) === 'proxy_bypass_signal_blocked';
}

function isNetworkRiskConfirmationBlock(errorMessage: string): boolean {
    const reasonCode = extractSandboxReasonCode(errorMessage);
    return !!reasonCode && NETWORK_RISK_CONFIRMATION_REASON_CODES.has(reasonCode);
}

function splitCommandTokens(command: string): string[] {
    const tokens: string[] = [];
    const pattern = /"([^"]*)"|'([^']*)'|“([^”]*)”|‘([^’]*)’|(\S+)/g;
    for (const match of command.matchAll(pattern)) {
        tokens.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '');
    }
    return tokens.filter(Boolean);
}

function shellQuoteArg(value: string): string {
    if (!value || /[\s"&|<>^]/.test(value)) {
        return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
}

function commandOptionValue(tokens: string[], option: string): string | undefined {
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === option) {
            return tokens[index + 1];
        }
        const prefix = `${option}=`;
        if (token?.startsWith(prefix)) {
            return token.slice(prefix.length);
        }
    }
    return undefined;
}

function buildEmailHelperNetworkTargetsCommand(command: string): string | null {
    const tokens = splitCommandTokens(command);
    const scriptIndex = tokens.findIndex((token) =>
        token.replace(/\\/g, '/').toLowerCase().endsWith('/email_helper.py') ||
        token.toLowerCase() === 'email_helper.py'
    );
    if (scriptIndex < 0) return null;

    const action = commandOptionValue(tokens, '--action');
    if (action === 'network_targets' || action === 'setup_account') return null;

    const account = commandOptionValue(tokens, '--account') ?? 'default';
    const prefix = tokens.slice(0, scriptIndex + 1).map(shellQuoteArg).join(' ');
    return `${prefix} --action network_targets --account ${shellQuoteArg(account)}`;
}

const GENERIC_NETWORK_TARGETS_PASSTHROUGH_OPTIONS = [
    '--account',
    '--profile',
    '--target',
    '--host',
    '--port',
    '--protocol',
    '--url',
    '--dsn',
];

export function buildGenericNetworkTargetsCommand(command: string): string | null {
    const tokens = splitCommandTokens(command);
    const scriptIndex = tokens.findIndex((token) =>
        /\.(py|js|mjs|cjs|sh|ps1)$/i.test(token.replace(/\\/g, '/'))
    );
    if (scriptIndex < 0) return null;

    const action = commandOptionValue(tokens, '--action');
    if (action === 'network_targets' || action === 'setup_account') return null;

    const preservedOptions = GENERIC_NETWORK_TARGETS_PASSTHROUGH_OPTIONS
        .flatMap((option) => {
            const value = commandOptionValue(tokens, option);
            return value ? [`${option} ${shellQuoteArg(value)}`] : [];
        });
    const prefix = tokens.slice(0, scriptIndex + 1).map(shellQuoteArg).join(' ');
    return [
        `${prefix} --action network_targets`,
        ...preservedOptions,
    ].join(' ');
}

function buildNetworkTargetsCommand(
    command: string,
    allowGenericLegacyEntrypoint: boolean
): string | null {
    return buildEmailHelperNetworkTargetsCommand(command)
        ?? (allowGenericLegacyEntrypoint ? buildGenericNetworkTargetsCommand(command) : null);
}

function normalizeSkillPath(path: string): string {
    return path
        .trim()
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase();
}

function normalizeEntrypointPath(entry: string): string {
    return entry
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\.?\//, '')
        .replace(/\/+/g, '/');
}

function commandScriptCandidates(command: string, workdir?: string): string[] {
    const candidates: string[] = [];
    const normalizedWorkdir = workdir ? normalizeSkillPath(workdir) : undefined;

    for (const token of splitCommandTokens(command)) {
        const normalizedToken = token.replace(/\\/g, '/');
        if (!/\.(py|js|mjs|cjs|sh|ps1)$/i.test(normalizedToken)) {
            continue;
        }
        candidates.push(normalizeSkillPath(normalizedToken));
        if (normalizedWorkdir && !/^[a-z]:\//i.test(normalizedToken) && !normalizedToken.startsWith('/')) {
            candidates.push(normalizeSkillPath(`${normalizedWorkdir}/${normalizedToken}`));
        }
    }

    return [...new Set(candidates)];
}

export interface GuideEntrypointNetworkDeclaration {
    skillName: string;
    packagePath: string;
    entry: string;
    mode: SkillAgentVisNetworkEntrypointMode;
}

export function resolveGuideSkillEntrypointNetworkDeclaration(
    command: string,
    workdir: string | undefined,
    skills: SkillDefinition[]
): GuideEntrypointNetworkDeclaration | undefined {
    const candidates = commandScriptCandidates(command, workdir);
    if (candidates.length === 0) return undefined;

    for (const skill of skills) {
        if (skill.source !== 'external' || !skill.packagePath || !skill.agentvisNetworkEntrypoints) {
            continue;
        }
        const packagePath = normalizeSkillPath(skill.packagePath);
        for (const candidate of candidates) {
            if (candidate !== packagePath && !candidate.startsWith(`${packagePath}/`)) {
                continue;
            }
            const entry = normalizeEntrypointPath(candidate.slice(packagePath.length).replace(/^\/+/, ''));
            const mode = Object.entries(skill.agentvisNetworkEntrypoints)
                .find(([declaredEntry]) => normalizeEntrypointPath(declaredEntry).toLowerCase() === entry)?.[1];
            if (!mode) continue;
            return {
                skillName: skill.name,
                packagePath: skill.packagePath,
                entry,
                mode,
            };
        }
    }

    return undefined;
}

export function resolveExternalSkillCommandReference(
    command: string,
    workdir: string | undefined,
    skills: SkillDefinition[]
): ExternalSkillCommandReference | undefined {
    const candidates = commandScriptCandidates(command, workdir);
    if (candidates.length === 0) return undefined;

    for (const skill of skills) {
        if (skill.source !== 'external' || !skill.packagePath) {
            continue;
        }
        const packagePath = normalizeSkillPath(skill.packagePath);
        if (candidates.some(candidate => candidate === packagePath || candidate.startsWith(`${packagePath}/`))) {
            return {
                skillName: skill.name,
                packagePath: skill.packagePath,
                mode: skill.mode,
            };
        }
    }

    return undefined;
}

function normalizeNetworkDirectTarget(value: unknown): NetworkDirectTarget | null {
    if (!isRecord(value)) return null;
    const protocol = typeof value.protocol === 'string' ? value.protocol.trim().toLowerCase() : '';
    const host = typeof value.host === 'string' ? value.host.trim().toLowerCase() : '';
    const port = typeof value.port === 'number'
        ? value.port
        : typeof value.port === 'string'
            ? Number.parseInt(value.port, 10)
            : NaN;
    if (!protocol || !host || !Number.isInteger(port) || port <= 0 || port > 65535) {
        return null;
    }
    const resolvedRisk = typeof value.resolvedRisk === 'string'
        && ['public', 'private', 'metadata', 'unknown'].includes(value.resolvedRisk)
        ? value.resolvedRisk as NetworkDirectTarget['resolvedRisk']
        : undefined;
    const resolvedIpSamples = Array.isArray(value.resolvedIpSamples)
        ? value.resolvedIpSamples.filter((entry): entry is string => typeof entry === 'string')
        : undefined;
    const resolvedRiskReason = typeof value.resolvedRiskReason === 'string'
        ? value.resolvedRiskReason
        : undefined;
    return {
        protocol,
        host,
        port,
        ...(resolvedRisk ? { resolvedRisk } : {}),
        ...(resolvedIpSamples ? { resolvedIpSamples } : {}),
        ...(resolvedRiskReason ? { resolvedRiskReason } : {}),
    };
}

function parseNetworkTargetsOutput(output: string): NetworkDirectTarget[] {
    const targets: NetworkDirectTarget[] = [];
    for (const entry of parseJsonObjectsFromOutput(output)) {
        const rawTargets = Array.isArray(entry)
            ? entry
            : isRecord(entry) && Array.isArray(entry.targets)
                ? entry.targets
                : [];
        for (const rawTarget of rawTargets) {
            const target = normalizeNetworkDirectTarget(rawTarget);
            if (target && !targets.some((existing) =>
                existing.protocol === target.protocol &&
                existing.host === target.host &&
                existing.port === target.port
            )) {
                targets.push(target);
            }
        }
    }
    return targets;
}

async function annotateNetworkDirectTargetRisks(
    targets: NetworkDirectTarget[]
): Promise<NetworkDirectTarget[]> {
    if (targets.length === 0) return targets;
    try {
        return await invoke<NetworkDirectTarget[]>('sandbox_network_direct_target_risks', { targets });
    } catch (error) {
        logger.warn('[ExecTool] network direct target risk resolution failed:', error);
        return targets;
    }
}

function networkDirectTargetsFromAllowances(
    allowances: NetworkDirectAllowance[]
): NetworkDirectTarget[] {
    return allowances.map((allowance) => ({
        protocol: allowance.protocol,
        host: allowance.host,
        port: allowance.port,
    }));
}

async function inspectNetworkDirectTargets(
    command: string,
    workdir: string | undefined
): Promise<NetworkDirectTargetInspection> {
    return invoke<NetworkDirectTargetInspection>('sandbox_network_direct_targets', {
        command,
        workdir,
    });
}

export function generateSandboxPreflightCommandBlock(
    command: string,
    sandboxMode: ToolExecutionContext['sandboxMode']
): string | null {
    if (!isOfflineIsolatedExecSandboxMode(sandboxMode)) {
        return null;
    }
    if (!GLOBAL_INSTALL_OR_LOGIN_COMMAND_PATTERN.test(command)) {
        return null;
    }

    return translate('tools.exec.sandboxPreflightBlocked', {
        mode: sandboxMode,
        reason: translate('tools.exec.sandboxHintReasons.globalInstallOrLogin'),
    });
}

function mightWriteFilesToWorkdir(command: string): boolean {
    const lower = command.toLowerCase();

    // 明确写文件的 Shell 重定向/管道写入操作符
    // 注意: 不能用 > 判断，它在比较运算符中也会出现。
    // ">" 后括十个字符(文件名开头) 被视为写文件标志。
    if (/\s>\s*\w/.test(command)) return true;          // echo xxx > file.txt
    if (/\s>>\s*\w/.test(command)) return true;         // echo xxx >> file.txt

    // Windows 文件复制/移动命令
    if (/\bcopy\b/.test(lower)) return true;
    if (/\bxcopy\b/.test(lower)) return true;
    if (/\brobocopy\b/.test(lower)) return true;
    if (/\bmove\b/.test(lower)) return true;
    if (/\bren\b/.test(lower)) return true;             // rename

    // 下载类命令
    if (/\bcurl\b.*\s-[oO]\s/.test(lower)) return true; // curl -o file
    if (/\bwget\b/.test(lower)) return true;
    if (/invoke-webrequest\b/.test(lower)) return true;
    if (/\biwr\b/.test(lower)) return true;              // Invoke-WebRequest 别名

    // 构建/编译类：通常会在 workdir 中生成中间产物
    if (/\bnpm\s+run\b/.test(lower)) return true;        // npm run build/bundle…
    if (/\bnpm\s+build\b/.test(lower)) return true;
    if (/\bvite\s+build\b/.test(lower)) return true;
    if (/\bpython\b(?!\s*--version)/.test(lower)) return true;  // python script.py (过滤 --version)
    if (/\bpip\s+(?:install|download)\b/.test(lower)) return true;
    if (/\bunzip\b/.test(lower)) return true;
    if (/\btar\b.*-[xz]/.test(lower)) return true;     // tar -xzf

    // PowerShell cmdlet 写文件
    if (/new-item\b/i.test(command)) return true;
    if (/set-content\b/i.test(command)) return true;
    if (/out-file\b/i.test(command)) return true;
    if (/copy-item\b/i.test(command)) return true;
    if (/move-item\b/i.test(command)) return true;
    if (/expand-archive\b/i.test(command)) return true;
    if (/tee-object\b/i.test(command)) return true;

    // 包含文件路径扩展名的命令（写入文件前通常会指定输出文件名）
    // \w+\.\w{1,6} 匹配常见文件名格式（扩展名 1-6 字符）
    if (/\w+\.(?:md|txt|json|csv|html|pdf|docx?|xlsx?|png|jpg|svg)\b/.test(lower)) return true;

    // 默认不扫描——纯读/验证类命令（dir, echo, where, tsc --noEmit 等）
    return false;
}

/**
 * 对目录进行浅层快照，返回当前所有文件名的 Set。
 *
 * 使用浅层遍历（recursive: false）降低 I/O 开销，同时也符合 agent 通常只在
 * workdir 根目录写入文件的行为模式（子目录级别的变更依赖外部 Skill 机制监控）。
 * 快照失败时返回空 Set，保证主流程不受影响。
 */
async function snapshotWorkdirFiles(dir: string): Promise<Set<string>> {
    try {
        const entries = await readDir(dir);
        const files = new Set<string>();
        for (const entry of entries) {
            // 只收录文件（不含子目录），避免对目录误发事件
            if (!entry.isDirectory) {
                files.add(entry.name);
            }
        }
        return files;
    } catch {
        // 目录不存在或无权限时静默返回空集合，不影响命令执行主流程
        return new Set<string>();
    }
}

/**
 * ExecTool 实现
 */
interface ShellSandboxInvokeOptions {
    sandboxMode: 'LocalAudit' | 'OfflineIsolated' | 'ControlledNetwork';
    sandboxLevel?: 'standard' | 'restricted';
    sandboxNetwork?: 'inherit' | 'audit' | 'blocked';
    networkScope: 'inherit' | 'blocked' | 'internetAudit';
    processLifecycle?: 'backgroundManaged';
}

function resolveShellSandboxOptions(
    sandboxMode: ToolExecutionContext['sandboxMode'],
    background: boolean
): ShellSandboxInvokeOptions {
    const processLifecycle = background ? 'backgroundManaged' as const : undefined;
    switch (sandboxMode ?? 'LocalAudit') {
        case 'OfflineIsolated':
            return {
                sandboxMode: 'OfflineIsolated',
                sandboxLevel: 'restricted',
                sandboxNetwork: 'blocked',
                networkScope: 'blocked',
                processLifecycle,
            };
        case 'ControlledNetwork':
            return {
                sandboxMode: 'ControlledNetwork',
                sandboxLevel: 'restricted',
                sandboxNetwork: 'audit',
                networkScope: 'internetAudit',
                processLifecycle,
            };
        case 'LocalAudit':
        default:
            return {
                sandboxMode: 'LocalAudit',
                sandboxLevel: 'standard',
                sandboxNetwork: 'inherit',
                networkScope: 'inherit',
                processLifecycle,
            };
    }
}

class ExecToolImpl implements Tool {
    readonly schema = SCHEMA;

    private async resolveGuideEntrypointNetworkDeclaration(
        command: string,
        workdir: string | undefined
    ): Promise<GuideEntrypointNetworkDeclaration | undefined> {
        await skillLoader.loadAllSkills();
        return resolveGuideSkillEntrypointNetworkDeclaration(
            command,
            workdir,
            skillLoader.getAllSync()
        );
    }

    private async resolveExternalSkillCommandReference(
        command: string,
        workdir: string | undefined
    ): Promise<ExternalSkillCommandReference | undefined> {
        await skillLoader.loadAllSkills();
        return resolveExternalSkillCommandReference(
            command,
            workdir,
            skillLoader.getAllSync()
        );
    }

    private formatExternalSkillSandboxHint(
        externalSkillCommand: ExternalSkillCommandReference | undefined,
        sandboxMode: ToolExecutionContext['sandboxMode'],
        message: string
    ): string | null {
        if (
            sandboxMode !== 'ControlledNetwork' ||
            !externalSkillCommand ||
            !isSandboxBlockMessage(message)
        ) {
            return null;
        }
        return translate('tools.exec.externalSkillSandboxHint', {
            skillName: externalSkillCommand.skillName,
        });
    }

    private async resolveNetworkDirectTargetsForAuthorization(
        command: string,
        workdir: string | undefined,
        timeoutSecs: number,
        env: Record<string, string>,
        sandboxOptions: ShellSandboxInvokeOptions,
        subjectType: NetworkDirectSubjectType,
        subjectId: string | undefined,
        allowGenericLegacyEntrypoint: boolean
    ): Promise<NetworkDirectTarget[]> {
        const inspection = await inspectNetworkDirectTargets(command, workdir);
        if (inspection.targets.length > 0) {
            return inspection.targets;
        }
        if (inspection.requiredProtocols.length === 0 && !allowGenericLegacyEntrypoint) {
            return [];
        }

        const preflightCommand = buildNetworkTargetsCommand(command, allowGenericLegacyEntrypoint);
        if (!preflightCommand) {
            return [];
        }

        const { processLifecycle: _preflightProcessLifecycle, ...preflightSandboxOptions } = sandboxOptions;
        const preflightResult = await invoke<ExecResult>('shell_execute', {
            command: preflightCommand,
            workdir,
            timeoutSecs: Math.min(timeoutSecs, 30),
            background: false,
            subjectType,
            subjectId,
            ...preflightSandboxOptions,
            ...(Object.keys(env).length > 0 ? { env } : {}),
        });
        if (preflightResult.exitCode !== 0) {
            logger.warn('[ExecTool] network direct preflight failed:', preflightResult.stderr);
            return [];
        }

        return annotateNetworkDirectTargetRisks(parseNetworkTargetsOutput(preflightResult.stdout));
    }

    private async requestNetworkDirectAllowances(
        command: string,
        workdir: string | undefined,
        timeoutSecs: number,
        env: Record<string, string>,
        sandboxOptions: ShellSandboxInvokeOptions,
        subjectType: NetworkDirectSubjectType,
        subjectId: string | undefined,
        errorMessage: string,
        allowGenericLegacyEntrypoint: boolean
    ): Promise<NetworkDirectAuthorizationGrant | null> {
        if (!isProxyBypassSignalBlock(errorMessage)) {
            return null;
        }

        const targets = await this.resolveNetworkDirectTargetsForAuthorization(
            command,
            workdir,
            timeoutSecs,
            env,
            sandboxOptions,
            subjectType,
            subjectId,
            allowGenericLegacyEntrypoint
        );
        if (targets.length === 0) {
            return null;
        }

        const allowances = await requestNetworkDirectAuthorization({
            command,
            workdir,
            subjectType,
            subjectId,
            targets,
            reasonCode: 'proxy_bypass_signal_blocked',
            reason: errorMessage,
        });
        return allowances ? { allowances, targets } : null;
    }

    private async requestNetworkUploadConfirmation(
        command: string,
        workdir: string | undefined,
        subjectType: NetworkDirectSubjectType,
        subjectId: string | undefined,
        errorMessage: string
    ): Promise<string | null> {
        if (!isNetworkRiskConfirmationBlock(errorMessage)) {
            return null;
        }
        const reasonCode = extractSandboxReasonCode(errorMessage);
        if (!reasonCode) {
            return null;
        }

        const confirmed = await requestNetworkUploadAuthorization({
            command,
            workdir,
            subjectType,
            subjectId,
            reasonCode,
            reason: errorMessage,
            riskKind: networkRiskKindFromReasonCode(reasonCode),
        });
        return confirmed ? reasonCode : null;
    }

    async execute(
        params: Record<string, unknown>,
        context: ToolExecutionContext
    ): Promise<ToolResult> {
        const rawCommand = params.command as string;
        const workdir = (params.workdir as string | undefined) ?? context.workdir;
        const timeoutResult = resolveExecTimeout(params.timeout);
        if (!timeoutResult.ok) {
            return {
                success: false,
                content: timeoutResult.message,
            };
        }
        const timeout = timeoutResult.timeout;
        const background = (params.background as boolean | undefined) ?? false;

        // 规范化 Windows 引号：LLM 经常生成 Linux 风格的单引号，cmd.exe 不认
        let command = normalizeWindowsQuotes(rawCommand);

        // 规范化 findstr 语法：LLM 经常混用 grep 的 \| OR 分隔符
        command = normalizeFindstrSyntax(command);

        // 规范化 Windows 多行命令：cmd.exe 通过 /C 接收真实换行时只执行首行
        command = normalizeWindowsCommandLineBreaks(command);

        // 规范化 Python 路径：将裸 python/python3 替换为 venv 路径
        // 解决 SA 偶发性不遵守 prompt 约束使用完整 venv 路径的问题
        if (context.venvPythonPath) {
            command = normalizePythonCommand(command, context.venvPythonPath);
        }
        command = normalizeInlineEvalCommandQuotes(command);
        let sandboxAuditQuery: ExecAuditQueryContext | null = null;
        let externalSkillCommand: ExternalSkillCommandReference | undefined;

        if (!command) {
            return {
                success: false,
                content: translate('tools.exec.missingCommand'),
            };
        }

        const sandboxWorkdirViolation = getSandboxPathViolation(workdir ?? '', context);
        if (sandboxWorkdirViolation) {
            return {
                success: false,
                content: sandboxWorkdirViolation.reason === 'missingWorkdir'
                    ? translate('tools.common.sandboxMissingWorkdir', { path: workdir ?? '' })
                    : translate('tools.common.sandboxPathDenied', {
                        path: workdir ?? '',
                        root: sandboxWorkdirViolation.root,
                        mode: sandboxWorkdirViolation.mode,
                    }),
            };
        }

        try {
            // 黑名单前置检查 — 绝对禁止的命令直接拒绝
            // 与 Rust 层 command_validator 形成双重阻断
            const blockResult = isExecCommandBlocked(command);
            if (blockResult.blocked) {
                return {
                    success: false,
                    content: translate('tools.exec.blockedPolicy', { reason: blockResult.reason }),
                };
            }

            // 授权检查
            // SubAgent 模式下安全命令跳过授权（与 file_write 的 isSubAgentContext 对齐）
            // 高危命令由 SubAgentRunner 的 Checkpoint 机制保护
            const sandboxPreflightBlock = generateSandboxPreflightCommandBlock(command, context.sandboxMode);
            if (sandboxPreflightBlock) {
                return {
                    success: false,
                    content: sandboxPreflightBlock,
                };
            }

            const skipAuth = context.isSubAgentContext && isExecCommandSafe(command);
            if (!skipAuth && context.onRequestAuthorization) {
                const authorized = await context.onRequestAuthorization('exec', command);
                if (!authorized) {
                    return {
                        success: false,
                        content: translate('tools.common.userDeniedCommand', { command }),
                    };
                }
            }

            // 报告进度
            context.onProgress?.(formatExecProgressMessage(command, timeoutResult));

            // ── 执行前快照 ──
            // 仅在命令启发式判断可能向 workdir 写入文件时才拍快照，避免对
            // dir/echo/npx tsc 等纯执行命令产生无谓的 I/O 开销。
            // 两次 readDir IPC 约 1-5ms，对长耗时命令无感，但高频短命令下值得跳过。
            const snapshotDir = workdir;
            const shouldScan = !!(snapshotDir && mightWriteFilesToWorkdir(command));
            const filesBefore = shouldScan ? await snapshotWorkdirFiles(snapshotDir) : new Set<string>();

            // 调用后端执行命令
            // Tauri v2 自动做 camelCase → snake_case 转换：
            // JS 端 timeoutSecs → Rust 端 timeout_secs
            // 构建环境变量（含 venv Scripts 目录，Rust 层据此前置注入 PATH）
            const env: Record<string, string> = {};
            if (context.venvPythonPath) {
                // 提取 Scripts 目录（去掉末尾的 python.exe）
                const lastSep = Math.max(
                    context.venvPythonPath.lastIndexOf('\\'),
                    context.venvPythonPath.lastIndexOf('/')
                );
                if (lastSep > 0) {
                    env['__AGENTVIS_VENV_SCRIPTS_DIR__'] = context.venvPythonPath.substring(0, lastSep);
                }
            }
            // 注入当前 IM 机器人 ID 作为环境变量，供兼容旧外部脚本使用
            // 这样 Skill 脚本在命令行未显式传入 --bot-id 时，也能自动感知正确的 Bot 身份，
            // 使用正确的凭据（keyring 键）和任务文件（im_active_task_{botId}.json）
            if (context.imBotId) {
                env['AGENTVIS_IM_BOT_ID'] = context.imBotId;
            }

            if (context.signal?.aborted) {
                return cancelledExecResult(command);
            }

            const executionId = !background && context.signal ? createShellExecutionId() : undefined;
            const cancelShellExecution = (): void => {
                if (!executionId) return;
                invoke('shell_cancel', { executionId }).catch((cancelError: unknown) => {
                    logger.warn('[ExecTool] 取消 shell 执行失败:', cancelError);
                });
            };
            context.signal?.addEventListener('abort', cancelShellExecution, { once: true });

            const sandboxOptions = resolveShellSandboxOptions(context.sandboxMode, background);
            const guideEntrypoint = await this.resolveGuideEntrypointNetworkDeclaration(command, workdir);
            externalSkillCommand = guideEntrypoint
                ? {
                    skillName: guideEntrypoint.skillName,
                    packagePath: guideEntrypoint.packagePath,
                    mode: 'guide',
                }
                : await this.resolveExternalSkillCommandReference(command, workdir);
            const subjectType: NetworkDirectSubjectType = guideEntrypoint ? 'skill' : 'command';
            const subjectId = guideEntrypoint?.skillName ?? context.agentId;
            const allowGenericLegacyEntrypoint = guideEntrypoint?.mode === 'legacyNonHttp';
            const sessionAllowances = activeNetworkDirectAllowancesForSubject(subjectType, subjectId);
            const shellParams = {
                command,
                workdir,
                timeoutSecs: timeout,
                background,
                executionId,
                subjectType,
                subjectId,
                ...sandboxOptions,
                ...(Object.keys(env).length > 0 ? { env } : {}),
            };
            const invokeShell = (
                allowances: NetworkDirectAllowance[],
                targets: NetworkDirectTarget[] = networkDirectTargetsFromAllowances(allowances),
                networkRiskReasonCode?: string
            ) =>
                invoke<ExecResult>('shell_execute', {
                    ...shellParams,
                    ...(allowances.length > 0 ? { networkDirectAllowances: allowances } : {}),
                    ...(targets.length > 0 ? { networkDirectTargets: targets } : {}),
                    ...(networkRiskReasonCode ? networkRiskConfirmationFlags(networkRiskReasonCode) : {}),
                });

            let result: ExecResult;
            if (context.sandboxMode === 'ControlledNetwork') {
                sandboxAuditQuery = {
                    sinceTimestamp: Date.now(),
                    source: subjectType === 'skill' ? 'externalSkill' : 'exec',
                    executionId,
                    subjectId,
                };
            }
            try {
                result = await invokeShell(sessionAllowances);
            } catch (invokeError) {
                const rawErrorMessage = invokeError instanceof Error ? invokeError.message : String(invokeError);
                const errorMessage = redactSensitiveObservation(rawErrorMessage);
                const confirmedRiskReasonCode = await this.requestNetworkUploadConfirmation(
                    command,
                    workdir,
                    subjectType,
                    subjectId,
                    errorMessage
                );
                if (confirmedRiskReasonCode) {
                    result = await invokeShell(
                        sessionAllowances,
                        networkDirectTargetsFromAllowances(sessionAllowances),
                        confirmedRiskReasonCode
                    );
                } else {
                    const retryGrant = await this.requestNetworkDirectAllowances(
                        command,
                        workdir,
                        timeout,
                        env,
                        sandboxOptions,
                        subjectType,
                        subjectId,
                        errorMessage,
                        allowGenericLegacyEntrypoint
                    );
                    if (!retryGrant || retryGrant.allowances.length === 0) {
                        throw invokeError;
                    }
                    result = await invokeShell([
                        ...sessionAllowances,
                        ...retryGrant.allowances,
                    ], retryGrant.targets);
                }
            } finally {
                context.signal?.removeEventListener('abort', cancelShellExecution);
            }

            if (context.signal?.aborted) {
                return cancelledExecResult(command);
            }

            // 截断过长的输出
            const rawStdout = result.stdout;
            const rawStderr = result.stderr;
            let stdout = redactSensitiveObservation(result.stdout);
            let stderr = redactSensitiveObservation(result.stderr);
            const stdoutBackendTruncatedBytes = result.stdoutTruncatedBytes ?? 0;
            const stderrBackendTruncatedBytes = result.stderrTruncatedBytes ?? 0;
            if (stdoutBackendTruncatedBytes > 0) {
                stdout = translate('tools.exec.stdoutBackendTruncated', {
                    bytes: stdoutBackendTruncatedBytes,
                }) + stdout;
            }
            if (stderrBackendTruncatedBytes > 0) {
                stderr = translate('tools.exec.stderrBackendTruncated', {
                    bytes: stderrBackendTruncatedBytes,
                }) + stderr;
            }

            if (stdout.length > MAX_OUTPUT_LENGTH) {
                stdout = stdout.substring(0, MAX_OUTPUT_LENGTH) + translate('tools.exec.stdoutTruncated');
            }

            if (stderr.length > MAX_OUTPUT_LENGTH) {
                stderr = stderr.substring(0, MAX_OUTPUT_LENGTH) + translate('tools.exec.stderrTruncated');
            }

            // 格式化输出
            const success = result.exitCode === 0;
            let content = `${translate('tools.exec.commandLabel')}: ${command}\n${translate('tools.exec.exitCodeLabel')}: ${result.exitCode}`;

            if (stdout) {
                content += `\n\n${translate('tools.exec.stdoutLabel')}:\n${stdout}`;
            }

            if (stderr) {
                content += `\n\n${translate('tools.exec.stderrLabel')}:\n${stderr}`;
            }

            const observationHints = collectExecObservationHints(
                command,
                result.exitCode,
                rawStdout,
                rawStderr
            );

            // 命令失败时注入修正提示 —— 帮助 Agent 在下一轮自我修正
            // 而非事前翻译（翻译难以保证语义正确性）
            if (!success) {
                const shellOperatorHint = generateShellOperatorHint(command, rawStderr);
                if (shellOperatorHint) {
                    content += `\n\n${shellOperatorHint}`;
                } else {
                    const hint = generateWindowsCommandHint(stderr, command);
                    if (hint) {
                        content += `\n\n${hint}`;
                    }
                }
                const fileReadHint = generateFileReadPathFailureHint(command, `${rawStdout}\n${rawStderr}`);
                if (fileReadHint) {
                    content += `\n\n${fileReadHint}`;
                }
                const timeoutGuidance = generateExecTimeoutGuidance(command, `${rawStdout}\n${rawStderr}`);
                if (timeoutGuidance) {
                    content += `\n\n${timeoutGuidance}`;
                }
                const sandboxHint = generateSandboxRuntimeCommandHint(
                    command,
                    rawStdout,
                    rawStderr,
                    context.sandboxMode
                );
                if (sandboxHint) {
                    content += `\n\n${sandboxHint}`;
                }
                const externalSkillSandboxHint = this.formatExternalSkillSandboxHint(
                    externalSkillCommand,
                    context.sandboxMode,
                    `${rawStdout}\n${rawStderr}`
                );
                if (externalSkillSandboxHint) {
                    content += `\n\n${externalSkillSandboxHint}`;
                }
            }

            for (const observationHint of observationHints) {
                content += `\n\n${observationHint}`;
            }

            const autoImageContext = success
                ? await loadAutoImageAttachmentsFromOutput(rawStdout, workdir, command)
                : { images: [], loadedPaths: [], warnings: [] };
            if (autoImageContext.loadedPaths.length > 0) {
                content += translate('tools.exec.autoImageContext', {
                    count: autoImageContext.loadedPaths.length,
                    paths: autoImageContext.loadedPaths.map(path => `- ${path}`).join('\n'),
                });
            }
            if (autoImageContext.warnings.length > 0) {
                content += translate('tools.exec.autoImageWarningsHeader', {
                    warnings: autoImageContext.warnings.map(warning => `- ${warning}`).join('\n'),
                });
            }
            const auditSummary = await buildExecSandboxAuditSummaryForQuery(sandboxAuditQuery);
            if (auditSummary) {
                content += `\n\n${auditSummary}`;
            }

            // ── 执行后扫描：命令成功时检测 workdir 中的新文件并发射刷新事件 ──
            // 双重过滤：① exitCode=0 ② 启发式判断有写文件意图，任一不满足则跳过
            if (success && shouldScan) {
                try {
                    const filesAfter = await snapshotWorkdirFiles(snapshotDir);
                    const { join } = await import('@tauri-apps/api/path');
                    for (const fileName of filesAfter) {
                        // 执行前不存在的文件 = 本次命令新写入的文件
                        if (!filesBefore.has(fileName)) {
                            const filePath = await join(snapshotDir, fileName);
                            await emit('file:deliverable_created', {
                                agentId: context.agentId,
                                filePath,
                            });
                            logger.debug('[ExecTool] 检测到新文件，已发射刷新事件:', filePath);
                        }
                    }
                } catch (scanError) {
                    // 扫描/发射失败不影响命令结果，仅记录警告
                    logger.warn('[ExecTool] 执行后文件扫描失败（不影响命令结果）:', scanError);
                }
            }

            return {
                success,
                content,
                data: {
                    command,
                    exitCode: result.exitCode,
                    workdir,
                    timedOut: result.timedOut ?? false,
                    terminated: result.terminated ?? false,
                    durationMs: result.durationMs,
                    timeoutSecs: result.timeoutSecs,
                    autoInjectedImagePaths: autoImageContext.loadedPaths,
                },
                ...(autoImageContext.images.length > 0 && { images: autoImageContext.images }),
            };
        } catch (error) {
            if (context.signal?.aborted) {
                return cancelledExecResult(command);
            }

            const rawErrorMessage = error instanceof Error ? error.message : String(error);
            const errorMessage = redactSensitiveObservation(rawErrorMessage);
            const sandboxGuardError = formatSandboxGuardError(errorMessage);
            const sandboxHint = generateSandboxRuntimeCommandHint(command, '', rawErrorMessage, context.sandboxMode);
            const auditSummary = await buildExecSandboxAuditSummaryForQuery(sandboxAuditQuery);
            const externalSkillSandboxHint = this.formatExternalSkillSandboxHint(
                externalSkillCommand,
                context.sandboxMode,
                errorMessage
            );
            const fileReadHint = generateFileReadPathFailureHint(command, errorMessage);
            const timeoutGuidance = generateExecTimeoutGuidance(command, errorMessage);
            return {
                success: false,
                content: translate('tools.exec.failed', {
                    command,
                    error: sandboxGuardError ?? errorMessage,
                })
                    + (fileReadHint ? `\n\n${fileReadHint}` : '')
                    + (timeoutGuidance ? `\n\n${timeoutGuidance}` : '')
                    + (!sandboxGuardError && sandboxHint ? `\n\n${sandboxHint}` : '')
                    + (externalSkillSandboxHint ? `\n\n${externalSkillSandboxHint}` : '')
                    + (auditSummary ? `\n\n${auditSummary}` : ''),
            };
        }
    }
}

/**
 * 导出单例实例
 */
export const execTool = new ExecToolImpl();
