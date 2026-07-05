/**
 * CodeHighlight - 代码语法高亮组件
 * 
 * 使用 prism-react-renderer 实现代码高亮。
 * 支持常用编程语言，行号显示，代码复制。
 */

import { useState, useCallback, useMemo, memo } from 'react';
import { Highlight, themes } from 'prism-react-renderer';
import { Copy, Check, Play, Layers, ChevronDown, ChevronUp } from 'lucide-react';
import styles from './CodeHighlight.module.css';
import { getLogger } from '@services/logger';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import { Tooltip } from '@components/ui/Tooltip';

const logger = getLogger('CodeHighlight');

/** 可 HTML 单文件预览的语言集合 */
const PREVIEWABLE_LANGUAGES = new Set(['html', 'svg']);

/** 可作为 Vite 项目预览的语言集合（多文件项目预览） */
const PROJECT_PREVIEWABLE_LANGUAGES = new Set(['jsx', 'tsx', 'javascript', 'typescript', 'css', 'vue']);

interface CodeHighlightProps {
    /** 代码内容 */
    code: string;
    /** 语言类型 */
    language?: string;
    /** 是否显示行号 */
    showLineNumbers?: boolean;
    /** 自定义类名 */
    className?: string;
    /** HTML 预览回调（仅当语言为可预览类型时生效） */
    onPreview?: (code: string, language: string) => void;
    /** 项目预览回调（JSX/TSX/CSS 等语言，将代码作为文件加入 Vite 项目） */
    onProjectPreview?: (code: string, language: string) => void;
    /** 是否启用超长代码块折叠（默认 false，聊天场景下建议开启） */
    collapsible?: boolean;
    /** 折叠触发阈值（行数），超过此行数时默认折叠。默认 25 */
    collapsedMaxLines?: number;
}

// 语言别名映射
const LANGUAGE_ALIASES: Record<string, string> = {
    'js': 'javascript',
    'ts': 'typescript',
    'tsx': 'tsx',
    'jsx': 'jsx',
    'py': 'python',
    'rs': 'rust',
    'md': 'markdown',
    'yml': 'yaml',
    'sh': 'bash',
    'shell': 'bash',
};

/**
 * 规范化语言名称
 */
function normalizeLanguage(lang: string): string {
    const lower = lang.toLowerCase();
    return LANGUAGE_ALIASES[lower] ?? lower;
}

export const CodeHighlight = memo(function CodeHighlight({
    code,
    language = 'text',
    showLineNumbers = true,
    className = '',
    onPreview,
    onProjectPreview,
    collapsible = false,
    collapsedMaxLines = 25,
}: CodeHighlightProps) {
    const normalizedLang = normalizeLanguage(language);
    const [copied, setCopied] = useState(false);
    // HTML 单文件预览按钮
    const canPreview = onPreview && PREVIEWABLE_LANGUAGES.has(normalizedLang);
    // 项目预览按钮（JSX/TSX/CSS 等语言）
    const canProjectPreview = onProjectPreview && PROJECT_PREVIEWABLE_LANGUAGES.has(normalizedLang);

    // 折叠状态：统计行数判断是否需要折叠
    const lineCount = useMemo(() => code.trim().split('\n').length, [code]);
    const shouldCollapse = collapsible && lineCount > collapsedMaxLines;
    const [isExpanded, setIsExpanded] = useState(false);
    const { t } = useI18n();
    const isCollapsed = shouldCollapse && !isExpanded;

    // 复制代码到剪贴板
    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(code.trim());
            setCopied(true);
            // 2 秒后恢复图标
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            logger.error('复制失败:', err);
        }
    }, [code]);

    return (
        <div className={styles.container}>
            {/* 头部：语言标签 + 行数标签 + 操作按钮 */}
            <div className={styles.header}>
                <span className={styles.language}>
                    {normalizedLang}
                    {shouldCollapse && (
                        <span className={styles.lineCountBadge}>{lineCount} lines</span>
                    )}
                </span>
                {canPreview && (
                    <Tooltip content={t('file.livePreview')}>
                        <button
                            className={styles.previewBtn}
                            onClick={() => onPreview(code.trim(), normalizedLang)}
                            aria-label={t('file.livePreview')}
                        >
                            <Play size={14} />
                        </button>
                    </Tooltip>
                )}
                {canProjectPreview && (
                    <Tooltip content={t('file.projectPreview')}>
                        <button
                            className={styles.projectPreviewBtn}
                            onClick={() => onProjectPreview(code.trim(), normalizedLang)}
                            aria-label={t('file.projectPreview')}
                        >
                            <Layers size={14} />
                        </button>
                    </Tooltip>
                )}
                <Tooltip content={copied ? t('file.copied') : t('file.copyCode')}>
                    <button
                        className={styles.copyBtn}
                        onClick={handleCopy}
                        aria-label={t('file.copyCode')}
                    >
                        {copied ? (
                            <Check size={14} className={styles.copyIconSuccess} />
                        ) : (
                            <Copy size={14} />
                        )}
                    </button>
                </Tooltip>
            </div>

            {/* 代码区域（可折叠） */}
            <div
                className={cx(styles.codeWrapper, isCollapsed && styles.codeCollapsed)}
                style={isCollapsed ? { maxHeight: `${collapsedMaxLines * 1.5}em` } : undefined}
            >
                <Highlight
                    theme={themes.vsDark}
                    code={code.trim()}
                    language={normalizedLang}
                >
                    {({ className: highlightClassName, style, tokens, getLineProps, getTokenProps }) => (
                        <pre
                            className={cx(styles.pre, highlightClassName, className)}
                            style={style}
                        >
                            <code className={styles.code}>
                                {tokens.map((line, lineIndex) => {
                                    // 解构 key 避免重复传递到 props 中
                                    const lineProps = getLineProps({ line });
                                    const { key: _lineKey, ...lineRestProps } = lineProps as { key?: React.Key } & Record<string, unknown>;
                                    return (
                                        <div
                                            key={lineIndex}
                                            {...lineRestProps}
                                            className={cx(styles.line, lineRestProps.className as string | undefined)}
                                        >
                                            {showLineNumbers && (
                                                <span className={styles.lineNumber}>
                                                    {lineIndex + 1}
                                                </span>
                                            )}
                                            <span className={styles.lineContent}>
                                                {line.map((token, tokenIndex) => {
                                                    // 解构 key 避免重复传递
                                                    const tokenProps = getTokenProps({ token });
                                                    const { key: _tokenKey, ...tokenRestProps } = tokenProps as { key?: React.Key } & Record<string, unknown>;
                                                    return (
                                                        <span key={tokenIndex} {...tokenRestProps} />
                                                    );
                                                })}
                                            </span>
                                        </div>
                                    );
                                })}
                            </code>
                        </pre>
                    )}
                </Highlight>

                {/* 折叠时底部渐变遮罩 */}
                {isCollapsed && <div className={styles.collapseGradient} />}
            </div>

            {/* 展开/收起按钮 */}
            {shouldCollapse && (
                <button
                    className={styles.collapseToggle}
                    onClick={() => setIsExpanded((prev) => !prev)}
                >
                    {isCollapsed ? (
                        <>
                            <ChevronDown size={14} />
                            <span>{t('file.expandAllLines', { count: lineCount })}</span>
                        </>
                    ) : (
                        <>
                            <ChevronUp size={14} />
                            <span>{t('file.collapse')}</span>
                        </>
                    )}
                </button>
            )}
        </div>
    );
});
