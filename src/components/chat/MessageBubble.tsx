/**
 * MessageBubble - 消息气泡组件
 * 
 * 功能：
 * - 三种角色样式：用户、Agent、系统
 * - 时间戳显示
 * - 悬停显示操作栏（延迟隐藏防止误触）
 * - Markdown 内容渲染
 */

import { useState, useCallback, useMemo, memo, useRef } from 'react';
import { ChevronRight, FileText, Folder, Play, Toolbox } from 'lucide-react';
import { MessageActions } from './MessageActions';
import { SelectCheckbox } from './SelectCheckbox';
import { usePreviewStore } from '@stores/previewStore';
import { wrapSvgInHtml } from '@services/preview/templateInference';
import { getLogger } from '@services/logger';
import { cx } from '@utils/classNames';

import { PlanningTraceDetails } from './PlanningTraceDetails';
import { ChatReasoningTrace } from './ChatReasoningTrace';
import { AttachmentCard } from './AttachmentCard';
import { MarkdownRenderer } from '../file/MarkdownRenderer';
import { BubbleReplyBar } from '../widgets/BubbleReplyBar';
import { containsChoicesWidgetBlock, extractFencedCodeBlocks, parseWidgetLanguage, shouldDeferTreeWidgetSubmit } from '../widgets/widgetParsing';
import { InlineGeneratedImages } from './InlineGeneratedImages';
import type { InputDisplayPart, InputContextToken } from './inputContextTokens';
import { formatTimestamp } from '@/types/message';
import { useI18n } from '@/i18n';
import type { UIMessage } from '@/types/message';
import type { ProjectFile } from '@services/preview/types';
import { inferTemplateFromLanguage, inferTemplateFromLanguages } from '@services/preview';
import styles from './MessageBubble.module.css';

const logger = getLogger('MessageBubble');

// ==================== 代码块提取和文件推断 ====================

/** 可项目预览的语言集合 */
const PREVIEWABLE_LANGS = new Set(['jsx', 'tsx', 'javascript', 'typescript', 'css', 'vue']);

/** 从 markdown 中提取的代码块信息 */
interface ExtractedCodeBlock {
    language: string;
    code: string;
    /** 代码块前 3 行上下文（标题/段落），用于文件名推断 */
    contextLines?: string;
}

/**
 * 从 markdown 内容中提取所有 fenced code blocks
 *
 * 同时捕获代码块前 3 行上下文（标题/段落），用于文件名推断。
 * 例如 `## 2. \`TodoItem.jsx\` — ...` 中的文件名。
 */
function extractCodeBlocks(markdown: string): ExtractedCodeBlock[] {
    const blocks: ExtractedCodeBlock[] = [];
    const regex = /```([^\s`]*)[^\n]*\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(markdown)) !== null) {
        const language = (match[1] ?? 'text').toLowerCase();
        const code = match[2] ?? '';

        // 提取代码块前 3 行作为上下文（用于文件名推断）
        const beforeFence = markdown.substring(0, match.index);
        const contextLines = beforeFence.split('\n').slice(-4, -1).join('\n');

        blocks.push({ language, code: code.trimEnd(), contextLines });
    }
    return blocks;
}

/**
 * 从代码块前置上下文（标题/段落）中提取文件名
 *
 * LLM 常见格式：
 * - `## 2. \`TodoItem.jsx\` — 单个待办项组件`
 * - `**index.css** — 全局样式`
 * - `1. \`index.css\` — 全局样式`
 */
function extractFileNameFromContext(contextLines: string): string | null {
    // 匹配 backtick 包裹的文件名：`filename.ext`
    const backtickMatch = contextLines.match(/`([A-Za-z][\w/.-]*\.\w{1,5})`/);
    if (backtickMatch) return backtickMatch[1] ?? null;

    // 匹配 bold 包裹的文件名：**filename.ext**
    const boldMatch = contextLines.match(/\*\*([A-Za-z][\w/.-]*\.\w{1,5})\*\*/);
    if (boldMatch) return boldMatch[1] ?? null;

    return null;
}

/**
 * 从代码块首行注释提取文件名
 *
 * 支持格式：
 * - `// filename.jsx`  /  `// App.jsx`
 * - `/* filename.css *\/`
 * - `// src/App.jsx`
 */
function extractFileNameFromComment(code: string): string | null {
    const firstLine = code.split('\n')[0]?.trim() ?? '';
    const singleLine = firstLine.match(/^\/\/\s*([\w/.-]+\.\w+)/);
    if (singleLine) return singleLine[1] ?? null;
    const multiLine = firstLine.match(/^\/\*\s*([\w/.-]+\.\w+)\s*\*\//);
    if (multiLine) return multiLine[1] ?? null;
    return null;
}

/**
 * 从 export default 语句推断组件/文件名
 *
 * 匹配 `export default function TodoItem` → TodoItem.jsx
 */
function extractNameFromExportDefault(code: string, language: string): string | null {
    const match = code.match(/export\s+default\s+function\s+([A-Z]\w*)/);
    if (!match) return null;
    const name = match[1] ?? '';
    const ext = language === 'tsx' ? '.tsx' : '.jsx';
    return `${name}${ext}`;
}

/** 语言到默认文件名的映射（处理重复时使用序号后缀） */
const LANG_DEFAULT_NAMES: Record<string, { base: string; ext: string }> = {
    'jsx': { base: 'App', ext: '.jsx' },
    'tsx': { base: 'App', ext: '.tsx' },
    'vue': { base: 'App', ext: '.vue' },
    'css': { base: 'index', ext: '.css' },
    'javascript': { base: 'main', ext: '.js' },
    'typescript': { base: 'main', ext: '.ts' },
};

/**
 * 为多个代码块推断文件路径
 *
 * 四层 fallback 策略（优先级从高到低）：
 * 1. markdown 上下文中的文件名（标题/段落中的 backtick 文件名）
 * 2. 代码首行注释中的文件名
 * 3. export default function Name → Name.jsx
 * 4. 语言默认名 + 序号
 *
 * 推断完成后，扫描所有代码块的 import 语句，
 * 修正子目录路径（如 `./components/WeatherCard.vue` → `src/components/WeatherCard.vue`）
 */
function inferFilePathsForBlocks(blocks: ExtractedCodeBlock[]): string[] {
    const usedNames = new Set<string>();
    const langCounters: Record<string, number> = {};

    // 第一遍：基础文件名推断
    const paths = blocks.map(block => {
        let fileName: string | null = null;

        // 层级 1：从 markdown 上下文提取
        if (block.contextLines) {
            fileName = extractFileNameFromContext(block.contextLines);
        }

        // 层级 2：从代码首行注释提取
        fileName ??= extractFileNameFromComment(block.code);

        // 层级 3：从 export default 推断
        fileName ??= extractNameFromExportDefault(block.code, block.language);

        // 如果成功提取到文件名，确保带 src/ 前缀
        if (fileName) {
            const path = fileName.startsWith('src/') ? fileName : `src/${fileName}`;
            usedNames.add(path);
            return path;
        }

        // 层级 4：语言默认名 + 序号
        const defaults = LANG_DEFAULT_NAMES[block.language];
        if (!defaults) return `src/file_${Date.now()}.${block.language}`;

        const count = (langCounters[block.language] ?? 0) + 1;
        langCounters[block.language] = count;

        const baseName = count === 1 ? defaults.base : `${defaults.base}${count}`;
        const path = `src/${baseName}${defaults.ext}`;
        usedNames.add(path);
        return path;
    });

    // 第二遍：根据 import 语句修正子目录路径
    // 扫描所有代码块中的 import 语句，收集「文件基名 → 期望相对路径」映射
    correctPathsFromImports(blocks, paths);

    return paths;
}

/**
 * 根据代码中的 import 语句修正文件路径
 *
 * 扫描所有代码块中的 import 语句，提取相对路径引用：
 *   `import WeatherCard from './components/WeatherCard.vue'`
 * → 推断 WeatherCard.vue 应在 `src/components/WeatherCard.vue`
 *
 * 如果发现某个文件名在 paths 中被放在了错误位置，就地修正。
 */
function correctPathsFromImports(blocks: ExtractedCodeBlock[], paths: string[]): void {
    // 收集所有代码块中 import 语句引用的「基名 → 完整相对路径」映射
    const importMap = new Map<string, string>();
    // 匹配 import ... from './xxx/yyy.ext' 或 import './xxx/yyy.ext'
    const importRegex = /import\s+.*?from\s+['"]\.\/([^'"]+)['"]/g;
    const sideEffectRegex = /import\s+['"]\.\/([^'"]+)['"]/g;

    for (const block of blocks) {
        let match: RegExpExecArray | null;

        importRegex.lastIndex = 0;
        while ((match = importRegex.exec(block.code)) !== null) {
            const relPath = match[1] ?? '';
            if (!relPath) continue;
            const baseName = relPath.split('/').pop() ?? '';
            if (baseName) {
                // 保留完整相对路径（如 components/WeatherCard.vue）
                importMap.set(baseName, `src/${relPath}`);
            }
        }

        sideEffectRegex.lastIndex = 0;
        while ((match = sideEffectRegex.exec(block.code)) !== null) {
            const relPath = match[1] ?? '';
            if (!relPath) continue;
            const baseName = relPath.split('/').pop() ?? '';
            if (baseName) {
                importMap.set(baseName, `src/${relPath}`);
            }
        }
    }

    // 遍历 paths，检查是否有文件需要修正路径
    for (let i = 0; i < paths.length; i++) {
        const currentPath = paths[i] ?? '';
        const currentBaseName = currentPath.split('/').pop() ?? '';

        const expectedPath = importMap.get(currentBaseName);
        if (expectedPath && expectedPath !== currentPath) {
            paths[i] = expectedPath;
        }
    }
}

/** template inference from language (single block) - 使用统一模板推断 */
function inferFilePath(_code: string, language: string): string {
    switch (language) {
        case 'jsx': return 'src/App.jsx';
        case 'tsx': return 'src/App.tsx';
        case 'css': return 'src/index.css';
        case 'typescript': return 'src/main.ts';
        case 'javascript':
        default: return 'src/main.js';
    }
}

// ==================== 类型定义 ====================

interface MessageBubbleProps {
    /** 消息数据 */
    message: UIMessage;
    /** Agent 名称（用于 assistant 消息头像） */
    agentName?: string;
    /** 操作回调 */
    onAction?: (messageId: string, action: 'copy' | 'quote' | 'delete' | 'revoke' | 'multiselect') => void;
    /** 是否处于多选模式 */
    multiSelectMode?: boolean;
    /** 是否被选中（多选模式下有效） */
    selected?: boolean;
    /** 切换选中状态回调 */
    onToggleSelect?: (messageId: string) => void;
    /** 图片保存到交付物回调（图像生成模型的 base64 图片可保存） */
    onImageSave?: (dataUrl: string, fileName: string) => void;
    /** 上下文 ID（Agent/Hub ID，用于 Widget 交互事件） */
    contextId?: string;
}

// ==================== 工具函数 ====================

/**
 * 根据名称生成颜色
 */
const AVATAR_COLORS = [
    '#3F7BD9',
    '#7CB342',
    '#E0A238',
    '#4ba1c9',
    '#E34F53',
    '#7E57C2',
    '#E27A3A',
    '#21804E',
    '#ff9090',
    '#6da7e1',
    '#4a8131',
    '#7D8BF4',
];

function getAvatarColor(name: string): string {
    const colors = AVATAR_COLORS;
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % colors.length;
    return colors[index] ?? '#666';
}

/**
 * 获取头像字母
 */
function getAvatarLetter(name: string): string {
    return name.charAt(0).toUpperCase();
}

const IM_USER_MESSAGE_PREFIXES = [
    '[用户通过 IM 发送的消息]',
    '[用户通过飞书发送的消息]',
    '[用户通过 Slack 发送的消息]',
    '[Message sent through IM]',
    '[Message sent through Feishu]',
    '[Message sent through Slack]',
];

function stripImUserMessagePrefix(content: string): string {
    for (const prefix of IM_USER_MESSAGE_PREFIXES) {
        if (content === prefix) return '';
        if (content.startsWith(`${prefix}\r\n`)) {
            return content.slice(prefix.length).replace(/^\r\n+/, '');
        }
        if (content.startsWith(`${prefix}\n`)) {
            return content.slice(prefix.length).replace(/^\n+/, '');
        }
    }
    return content;
}

function isInputDisplayPartArray(value: unknown): value is InputDisplayPart[] {
    if (!Array.isArray(value)) return false;
    return value.every((part) => {
        if (!part || typeof part !== 'object') return false;
        const candidate = part as { type?: unknown; text?: unknown; token?: unknown };
        if (candidate.type === 'text') {
            return typeof candidate.text === 'string';
        }
        if (candidate.type === 'token') {
            const token = candidate.token as InputContextToken | undefined;
            return Boolean(token && typeof token.id === 'string' && typeof token.label === 'string');
        }
        return false;
    });
}

// ==================== 组件实现 ====================

/**
 * MessageBubble 消息气泡组件
 */
export const MessageBubble = memo(function MessageBubble({
    message,
    agentName = 'Agent',
    onAction,
    multiSelectMode = false,
    selected = false,
    onToggleSelect,
    onImageSave,
    contextId,
}: MessageBubbleProps) {
    const { t } = useI18n();
    const [isHovered, setIsHovered] = useState(false);
    // 使用 ref 存储 timeout ID，避免悬停时闪烁
    const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const { role, content: rawContent, createdAt } = message;

    // 静默处理：剥离跨请求持久化上下文标记（rationale + SA observations）
    // 这些信息仅供 MB 下轮决策用，对用户无意义。数据层保留完整内容，仅渲染层过滤。
    const content = useMemo(() => {
        if (!rawContent) return rawContent;
        if (role === 'user' && message.metadata?.source === 'im') {
            return stripImUserMessagePrefix(rawContent);
        }
        if (role !== 'assistant') return rawContent;
        const marker = '\n\nMB decision progress (system-injected context for the next decision)';
        const idx = rawContent.indexOf(marker);
        return idx !== -1 ? rawContent.slice(0, idx).trim() : rawContent;
    }, [role, rawContent, message.metadata]);

    const displayParts = useMemo(() => {
        if (role !== 'user') return null;
        const parts = message.metadata?.displayParts;
        return isInputDisplayPartArray(parts) ? parts : null;
    }, [message.metadata?.displayParts, role]);

    const displayContent = useMemo(() => {
        if (role !== 'user') return content;
        const metadataDisplayContent = message.metadata?.displayContent;
        return typeof metadataDisplayContent === 'string'
            ? metadataDisplayContent
            : content;
    }, [content, message.metadata?.displayContent, role]);

    const openInlineTokenPath = useCallback(async (token: InputContextToken) => {
        if (!token.path) return;

        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('file_open_system', { filePath: token.path });
        } catch (error) {
            logger.warn('[MessageBubble] 打开上下文路径失败:', error);
        }
    }, []);

    // 头像颜色
    const avatarColor = useMemo(
        () => getAvatarColor(role === 'assistant' ? agentName : 'User'),
        [role, agentName]
    );

    // 时间戳（显示日期和时间）
    const timeString = useMemo(
        () => formatTimestamp(createdAt, { showDate: true, use12Hour: true }),
        [createdAt]
    );

    // 操作处理
    const handleAction = useCallback(
        (action: 'copy' | 'quote' | 'delete' | 'revoke' | 'multiselect') => {
            onAction?.(message.id, action);
        },
        [message.id, onAction]
    );

    // 代码预览回调（点击代码块 ▶ 按钮后在右栏打开 Live Preview）
    const { openPreview, startProjectPreview, setProjectStatus, setProjectUrl } = usePreviewStore();
    const handleCodePreview = useCallback(
        (code: string, language: string) => {
            // SVG 需要包一层 HTML 外壳才能在 iframe 中正确渲染
            const previewCode = language === 'svg'
                ? wrapSvgInHtml(code)
                : code;
            openPreview(previewCode, `${language.toUpperCase()} Preview`);
        },
        [openPreview]
    );

    const handleProjectPreview = useCallback(
        async (code: string, language: string) => {
            try {
                const filePath = inferFilePath(code, language);
                const templateId = inferTemplateFromLanguage(language);
                startProjectPreview(templateId);
                setProjectStatus('installing');

                const { appDataDir, join } = await import('@tauri-apps/api/path');
                const appData = await appDataDir();
                const deliverableDir = await join(appData, 'deliverables', 'preview');

                const { vitePreviewService } = await import('@services/preview');
                const url = await vitePreviewService.startProject(
                    deliverableDir,
                    // 使用固定项目名，复用同一目录
                    'vite_preview',
                    templateId,
                    [{ path: filePath, content: code }],
                );

                setProjectUrl(url, templateId);
                logger.debug('[MessageBubble] Project preview started:', url);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.error('[MessageBubble] Project preview failed:', errorMessage);
                setProjectStatus('error', errorMessage);
            }
        },
        [startProjectPreview, setProjectStatus, setProjectUrl]
    );

    // 多文件项目预览：从消息中收集所有可预览代码块
    const previewableBlocks = useMemo(() => {
        if (role !== 'assistant' || !content) return [];
        const allBlocks = extractCodeBlocks(content);
        return allBlocks.filter(b => PREVIEWABLE_LANGS.has(b.language));
    }, [role, content]);

    // 从 metadata 中提取 SA 生成的图片路径（Planning 模式内联展示）
    const generatedImages = useMemo(() => {
        if (role !== 'assistant') return [];
        const imgs = message.metadata?.generatedImages;
        return Array.isArray(imgs) ? (imgs as string[]) : [];
    }, [role, message.metadata?.generatedImages]);

    const hasMultiFilePreview = previewableBlocks.length >= 2;

    // 检测消息是否包含富内容（mermaid/echarts/widget/表格等），
    // 若是则给 .content 注入 richContent 类名，确保气泡有足够的最小宽度
    const hasRichContent = useMemo(() => {
        if (role !== 'assistant' || !content) return false;
        const hasVisualBlock = extractFencedCodeBlocks(content).some((block) =>
            block.language === 'mermaid'
            || block.language === 'echarts'
            || parseWidgetLanguage(block.language).isWidget
        );
        // 表格标记：至少包含一行 markdown 表格分隔符 |---|
        const hasTable = /\|\s*-{3,}\s*\|/.test(content);
        return hasTable || hasVisualBlock;
    }, [role, content]);

    // 检测消息是否包含 widget-choices（用于决定是否渲染 BubbleReplyBar）
    const hasWidgetChoices = useMemo(() => {
        if (role !== 'assistant' || !content) return false;
        return containsChoicesWidgetBlock(content);
    }, [role, content]);

    const deferWidgetSubmit = useMemo(() => {
        if (role !== 'assistant' || !content) return false;
        return shouldDeferTreeWidgetSubmit(content);
    }, [role, content]);

    /**
     * 多文件项目预览回调
     *
     * 收集消息中所有可预览代码块，推断文件名和模板，
     * 一次性提交给 VitePreviewService。
     */
    const handleMultiFilePreview = useCallback(async () => {
        if (previewableBlocks.length === 0) return;

        try {
            const templateId = inferTemplateFromLanguages(
                previewableBlocks.map(b => b.language)
            );
            startProjectPreview(templateId);
            setProjectStatus('installing');

            const filePaths = inferFilePathsForBlocks(previewableBlocks);
            const files: ProjectFile[] = previewableBlocks.map((block, i) => ({
                path: filePaths[i] ?? `src/file${i}.${block.language}`,
                content: block.code,
            }));

            const { appDataDir, join } = await import('@tauri-apps/api/path');
            const appData = await appDataDir();
            const deliverableDir = await join(appData, 'deliverables', 'preview');

            const { vitePreviewService } = await import('@services/preview');
            const url = await vitePreviewService.startProject(
                deliverableDir,
                // 使用固定项目名，复用同一目录
                'vite_preview',
                templateId,
                files,
            );

            setProjectUrl(url, templateId);
            logger.debug('[MessageBubble] Multi-file preview started:', url, 'files:', files.map(f => f.path));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error('[MessageBubble] Multi-file preview failed:', errorMessage);
            setProjectStatus('error', errorMessage);
        }
    }, [previewableBlocks, startProjectPreview, setProjectStatus, setProjectUrl]);

    // 鼠标进入 - 立即显示操作栏
    const handleMouseEnter = useCallback(() => {
        // 清除隐藏定时器
        if (hideTimeoutRef.current) {
            clearTimeout(hideTimeoutRef.current);
            hideTimeoutRef.current = null;
        }
        setIsHovered(true);
    }, []);

    // 鼠标离开 - 延迟 300ms 后隐藏操作栏，给用户时间移动到操作栏
    const handleMouseLeave = useCallback(() => {
        hideTimeoutRef.current = setTimeout(() => {
            setIsHovered(false);
            hideTimeoutRef.current = null;
        }, 300);
    }, []);

    // 系统消息特殊样式
    if (role === 'system') {
        return (
            <div className={styles.systemMessage}>
                <span className={styles.systemContent}>{content}</span>
            </div>
        );
    }

    // 用户或 Agent 消息
    const isUser = role === 'user';

    // 提取 metadata 类型安全的渲染逻辑（避免 unknown 在 JSX 中导致 ReactNode 类型错误）
    const renderThinkingBlock = (): React.ReactNode => {
        const reasoning = message.metadata?.reasoningContent;
        if (!reasoning) return null;
        return (
            <ChatReasoningTrace
                content={reasoning}
                defaultExpanded={false}
            />
        );
    };

    const renderAttachmentCards = (): React.ReactNode => {
        if (!isUser) return null;
        const attachments = message.metadata?.attachments;
        if (!Array.isArray(attachments) || attachments.length === 0) return null;
        return <AttachmentCard attachments={attachments} />;
    };

    const renderUserContent = (): React.ReactNode => {
        if (!displayParts || displayParts.length === 0) {
            return displayContent;
        }

        return (
            <span className={styles.inlineMessageContent}>
                {displayParts.map((part, index) => {
                    if (part.type === 'text') {
                        return <span key={`text-${index}`}>{part.text}</span>;
                    }

                    const token = part.token;
                    const Icon = token.type === 'skill'
                        ? Toolbox
                        : token.type === 'folder'
                            ? Folder
                            : FileText;
                    const title = token.path
                        ? t(token.type === 'skill'
                            ? 'chat.openSkillPath'
                            : token.type === 'folder'
                                ? 'chat.openFolderPath'
                                : 'chat.openFilePath', { path: token.path })
                        : token.label;

                    return (
                        <button
                            key={`${token.id}-${index}`}
                            type="button"
                            className={styles.inlineTokenChip}
                            data-token-type={token.type}
                            onClick={(event) => {
                                event.stopPropagation();
                                void openInlineTokenPath(token);
                            }}
                            disabled={!token.path}
                            title={title}
                        >
                            <Icon size={13} />
                            <span>{token.label}</span>
                        </button>
                    );
                })}
            </span>
        );
    };

    return (
        <div
            className={cx(styles.bubble, isUser ? styles.userBubble : styles.agentBubble, multiSelectMode && styles.multiSelectBubble, selected && styles.selectedBubble)}
            data-message-id={message.id}
            onClick={multiSelectMode ? () => onToggleSelect?.(message.id) : undefined}
            onMouseEnter={!multiSelectMode ? handleMouseEnter : undefined}
            onMouseLeave={!multiSelectMode ? handleMouseLeave : undefined}
        >
            {/* 多选模式：统一左侧显示选择圆圈 */}
            {multiSelectMode && (
                <SelectCheckbox
                    checked={selected}
                    onChange={() => onToggleSelect?.(message.id)}
                />
            )}
            {/* Agent 消息显示头像 */}
            {!isUser && (
                <div
                    className={styles.avatar}
                    style={{ backgroundColor: avatarColor }}
                >
                    {getAvatarLetter(agentName)}
                </div>
            )}

            <div className={styles.contentWrapper}>
                {/* 消息头部 */}
                <div className={styles.header}>
                    {!isUser && (
                        <span className={styles.senderName}>{agentName}</span>
                    )}
                    <span className={styles.timestamp}>{timeString}</span>
                </div>

                {/* 思考过程（可折叠） */}
                {renderThinkingBlock()}

                {/* 附件卡片（用户消息，如果有附件） */}
                {renderAttachmentCards()}

                {/* 引用溯源卡片（用户消息附带的引用来源，点击展开/收起） */}
                {isUser && message.quotedFrom && message.quotedFrom.length > 0 && (
                    <QuotedFromBlock quotes={message.quotedFrom} />
                )}

                {/* Planning 执行详情（持久化后用轻量分隔线收纳） */}
                {!isUser && message.metadata?.mode === 'planning' && (
                    <PlanningTraceDetails
                        reasoningTrace={message.metadata.reasoningTrace as { content: string; isCompleted?: boolean } | undefined}
                        thinkingChain={message.metadata.thinkingChain as { analyzing: string; planning: string; decided: string } | undefined}
                        thinkingSteps={message.metadata.thinkingSteps as Array<{ stepNumber: number; analyzing: string; planning: string; decided: string }> | undefined}
                        subAgentObservations={message.metadata.subAgentObservations as import('@/services/planning/agent-loop/types').SubAgentObservationEvent[] | undefined}
                        completedAt={createdAt}
                    />
                )}

                {/* 消息内容 */}
                <div className={cx(styles.content, !isUser && hasRichContent && styles.richContent)}>
                    {isUser ? (
                        // 用户消息优先按 metadata 还原内联上下文 chip。
                        renderUserContent()
                    ) : (
                        // Agent 消息使用 Markdown 渲染（支持图像生成模型的图片显示）
                        <MarkdownRenderer
                            content={content}
                            contextId={contextId}
                            messageId={message.id}
                            deferWidgetSubmit={deferWidgetSubmit}
                            onCodePreview={handleCodePreview}
                            onProjectPreview={handleProjectPreview}
                            onImageSave={onImageSave}
                        />
                    )}
                </div>

                {/* 气泡级 Widget 确认回复栏（当消息含 widget-choices 时显示） */}
                {hasWidgetChoices && !isUser && contextId && (
                    <BubbleReplyBar
                        messageId={message.id}
                        contextId={contextId}
                        agentId={message.agentId}
                    />
                )}

                {/* SA 生成的内联图片（Planning 模式，消息内容下方缩略图网格） */}
                {!isUser && generatedImages.length > 0 && (
                    <InlineGeneratedImages imagePaths={generatedImages} />
                )}

                {/* 多文件项目预览按钮：消息含 2+ 个可预览代码块时显示 */}
                {hasMultiFilePreview && (
                    <button
                        className={styles.multiFilePreviewBtn}
                        onClick={handleMultiFilePreview}
                        title={`Preview project (${previewableBlocks.length} files)`}
                    >
                        <Play size={14} />
                        <span>Preview Project ({previewableBlocks.length} files)</span>
                    </button>
                )}

                {/* 操作栏 - 非多选模式下悬停时显示 */}
                {isHovered && !multiSelectMode && (
                    <MessageActions
                        isUser={isUser}
                        onAction={handleAction}
                    />
                )}
            </div>
        </div>
    );
});

// ==================== 引用溯源卡片子组件 ====================

/** 引用溯源卡片的 Props */
interface QuotedFromBlockProps {
    quotes: Array<{
        content: string;
        agentName?: string;
    }>;
}

/** 收起态最大显示字符数 */
const MAX_TRUNCATE_LENGTH = 60;

/**
 * QuotedFromBlock - 引用溯源卡片
 *
 * - 默认收起：截断 60 字符单行显示
 * - 点击展开：显示完整内容，超出 max-height 时可滚动查看
 * - 再次点击：收起
 */
const QuotedFromBlock = memo(function QuotedFromBlock({ quotes }: QuotedFromBlockProps) {
    const { t } = useI18n();
    // 记录已展开的卡片索引集合
    const [expandedIndexes, setExpandedIndexes] = useState<Set<number>>(new Set());

    const handleClick = useCallback((index: number) => {
        setExpandedIndexes(prev => {
            const next = new Set(prev);
            if (next.has(index)) {
                next.delete(index);
            } else {
                next.add(index);
            }
            return next;
        });
    }, []);

    return (
        <div className={styles.quotedFromBlock}>
            {quotes.map((quote, index) => {
                const isExpanded = expandedIndexes.has(index);
                const needsTruncate = quote.content.length > MAX_TRUNCATE_LENGTH;
                // 收起时截断显示；展开时传递完整内容，由 CSS max-height 控制滚动
                const displayContent = isExpanded || !needsTruncate
                    ? quote.content
                    : quote.content.slice(0, MAX_TRUNCATE_LENGTH) + '...';

                return (
                    <div
                        key={index}
                        className={styles.quotedFromItem}
                        onClick={() => needsTruncate && handleClick(index)}
                        title={needsTruncate ? t('chat.clickToggle') : undefined}
                        style={needsTruncate ? { cursor: 'pointer' } : undefined}
                    >
                        <div className={styles.quotedFromHeader}>
                            <span className={styles.quotedFromLabel}>
                                {t('common.quote')} {quote.agentName ?? 'Hub'}:
                            </span>
                            {needsTruncate && (
                                <span
                                    className={cx(
                                        styles.expandIndicator,
                                        isExpanded && styles.expandIndicatorExpanded
                                    )}
                                    aria-hidden="true"
                                >
                                    <ChevronRight size={13} strokeWidth={2.2} />
                                </span>
                            )}
                        </div>
                        {/* 展开态：完整内容 + 滚动条；收起态：单行截断 */}
                        <span className={cx(styles.quotedFromContent, isExpanded && styles.quotedFromContentExpanded)}>
                            {displayContent}
                        </span>
                    </div>
                );
            })}
        </div>
    );
});
