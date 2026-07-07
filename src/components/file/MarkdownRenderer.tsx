/**
 * MarkdownRenderer - Markdown 渲染组件
 *
 * 使用 react-markdown 和 remark-gfm 实现 Markdown 渲染。
 * 支持 GFM（表格、任务列表、删除线等）。
 * 代码块使用 CodeHighlight 组件进行语法高亮。
 * 支持图像生成模型的 base64 图片渲染（缩略图 + Lightbox 放大 + 保存交付物）。
 */

import { useState, useEffect, useCallback, useMemo, useRef, memo, lazy, Suspense, type MouseEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ZoomIn, Download } from 'lucide-react';
import { CodeHighlight } from './CodeHighlight';
import { WidgetRenderer } from '../widgets';
import { extractCodeLanguage, parseWidgetLanguage, resolveWidgetType } from '../widgets/widgetParsing';
import { parseWithFallback } from '@services/memory/utils/JsonParser';
import { ImageLightbox } from '../chat/ImageLightbox';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './MarkdownRenderer.module.css';

const LazyMermaidBlock = lazy(async () => {
    const { MermaidBlock } = await import('./MermaidBlock');
    return { default: MermaidBlock };
});

const LazyEChartsBlock = lazy(async () => {
    const { EChartsBlock } = await import('./EChartsBlock');
    return { default: EChartsBlock };
});

function DiagramBlockFallback() {
    return <div className={styles.diagramBlockFallback} aria-hidden="true" />;
}

interface MarkdownRendererProps {
    /** Markdown 内容 */
    content: string;
    /** 自定义类名 */
    className?: string;
    /** 代码预览回调（透传给 CodeHighlight，仅 html 语言可见预览按钮） */
    onCodePreview?: (code: string, language: string) => void;
    /** 项目预览回调（透传给 CodeHighlight，JSX/TSX/CSS 等语言可见项目预览按钮） */
    onProjectPreview?: (code: string, language: string) => void;
    /** 图片保存到交付物回调（图像生成模型的 base64 图片可保存） */
    onImageSave?: (dataUrl: string, fileName: string) => void;
    /** Markdown 源文件绝对路径（用于解析相对图片路径） */
    markdownFilePath?: string;
    /** 上下文 ID（用于 Widget 组件 dispatch 交互事件） */
    contextId?: string;
    /** 消息 ID（气泡唯一标识），透传至 WidgetRenderer → ChoicesWidget，用于气泡级表单暂存 */
    messageId?: string;
    /** 是否将支持的交互 widget 暂存到气泡级回复栏统一提交 */
    deferWidgetSubmit?: boolean;
}

/**
 * 预处理 Markdown 内容，修正常见格式问题
 */
function preprocessContent(content: string): string {
    return content
        // 将3个及以上连续空行替换为2个空行
        .replace(/\n{3,}/g, '\n\n')
        // 移除行尾多余空格（保留列表缩进）
        .replace(/[ \t]+$/gm, '')
        // 确保列表项之间只有一个换行符（紧凑列表）
        .replace(/(\n-[^\n]+)\n\n(-)/g, '$1\n$2')
        .replace(/(\n\d+\.[^\n]+)\n\n(\d+\.)/g, '$1\n$2');
}

/** 占位符 URL 前缀（短 URL，让 markdown 解析器能正常处理） */
const IMAGE_PLACEHOLDER_PREFIX = '#gen-img-';

const IMAGE_MIME_MAP: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
};

function isHttpLink(href?: string): href is string {
    return /^https?:\/\//i.test(href ?? '');
}

async function openExternalLink(href: string): Promise<void> {
    try {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(href);
    } catch {
        window.open(href, '_blank', 'noopener,noreferrer');
    }
}

const MARKDOWN_LOCAL_IMAGE_DOWNSCALE_BYTES = 5 * 1024 * 1024;
const MARKDOWN_LOCAL_IMAGE_MAX_BYTES = 40 * 1024 * 1024;
const MARKDOWN_LOCAL_IMAGE_MAX_WIDTH = 1800;

/**
 * 从 Markdown 内容中提取 base64 data URL 图片
 *
 * react-markdown 解析器无法处理超长 URL（2.5MB+ 的 base64 data URL 会被截断为空字符串）。
 * 此函数将 `![alt](data:image/xxx;base64,...)` 替换为短占位符 URL，
 * 并返回占位符到原始 data URL 的映射，供 img 组件查找使用。
 *
 * 使用手动字符串搜索而非正则，避免对 2.5MB base64 数据的灾难性回溯。
 */
function extractBase64Images(content: string): { processedContent: string; imageMap: Map<string, string> } {
    const imageMap = new Map<string, string>();
    let counter = 0;
    const marker = '](data:image/';
    let result = '';
    let searchStart = 0;

    for (;;) {
        // 查找 markdown 图片语法中的 data:image 标记
        const markerIdx = content.indexOf(marker, searchStart);
        if (markerIdx === -1) {
            // 没有更多图片，追加剩余内容
            result += content.slice(searchStart);
            break;
        }

        // 回溯找到 ![ 起始位置
        const bangBracketIdx = content.lastIndexOf('![', markerIdx);
        if (bangBracketIdx === -1 || bangBracketIdx < searchStart) {
            // 格式不完整，跳过此 marker
            result += content.slice(searchStart, markerIdx + marker.length);
            searchStart = markerIdx + marker.length;
            continue;
        }

        // 从 ]( 之后向前搜索闭合括号 )
        const openParenIdx = markerIdx + 1; // '](' 中 '(' 的位置
        const closeParenIdx = content.indexOf(')', openParenIdx + 1);
        if (closeParenIdx === -1) {
            // 未找到闭合括号
            result += content.slice(searchStart, markerIdx + marker.length);
            searchStart = markerIdx + marker.length;
            continue;
        }

        // 提取 data URL 和 alt 文本
        const dataUrl = content.slice(openParenIdx + 1, closeParenIdx);
        const altText = content.slice(bangBracketIdx + 2, markerIdx);

        // 创建占位符
        const placeholder = `${IMAGE_PLACEHOLDER_PREFIX}${counter}`;
        imageMap.set(placeholder, dataUrl);
        counter++;

        // 拼接：! [ 之前的内容 + 替换后的图片标记
        result += content.slice(searchStart, bangBracketIdx);
        result += `![${altText}](${placeholder})`;
        searchStart = closeParenIdx + 1;
    }

    return { processedContent: result, imageMap };
}

function isLikelyIncompleteJson(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return true;
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;

    const stack: string[] = [];
    let inString = false;
    let escapeNext = false;

    for (const char of trimmed) {
        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === '\\') {
            if (inString) escapeNext = true;
            continue;
        }

        if (char === '"') {
            inString = !inString;
            continue;
        }

        if (inString) continue;

        if (char === '{') stack.push('}');
        else if (char === '[') stack.push(']');
        else if (char === '}' || char === ']') {
            const expected = stack.pop();
            if (expected !== char) return false;
        }
    }

    return inString || stack.length > 0;
}

function stringifyCodeChildren(children: unknown): string {
    if (children == null) return '';
    if (Array.isArray(children)) return children.map(stringifyCodeChildren).join('');
    if (typeof children === 'string') return children;
    if (typeof children === 'number' || typeof children === 'boolean' || typeof children === 'bigint') {
        return String(children);
    }
    return '';
}

function stripLocalImagePathDecorations(src: string): string {
    const queryIndex = src.indexOf('?');
    const hashIndex = src.indexOf('#');
    const indexes = [queryIndex, hashIndex].filter(index => index >= 0);
    if (indexes.length === 0) return src;
    return src.slice(0, Math.min(...indexes));
}

function decodeLocalImagePath(src: string): string {
    try {
        return decodeURIComponent(src);
    } catch {
        return src;
    }
}

function isPassthroughImageSrc(src: string): boolean {
    return /^(?:https?:|data:|blob:|about:)/i.test(src) || src.startsWith('//') || src.startsWith('#');
}

function isAbsoluteLocalPath(src: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(src) || src.startsWith('\\\\') || src.startsWith('/');
}

function fileUrlToLocalPath(src: string): string | null {
    try {
        const url = new URL(src);
        if (url.protocol !== 'file:') return null;

        const decodedPath = decodeLocalImagePath(url.pathname);
        if (url.host) {
            return `\\\\${url.host}${decodedPath.replace(/\//g, '\\')}`;
        }
        return decodedPath.replace(/^\/([a-zA-Z]:\/)/, '$1');
    } catch {
        return null;
    }
}

function getMimeTypeFromPath(path: string): string {
    const cleanPath = stripLocalImagePathDecorations(path);
    const ext = cleanPath.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? '';
    return IMAGE_MIME_MAP[ext] ?? 'image/png';
}

function canDownscaleLocalImage(path: string): boolean {
    const cleanPath = stripLocalImagePathDecorations(path);
    const ext = cleanPath.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? '';
    return ext === 'jpg' || ext === 'jpeg' || ext === 'png' || ext === 'webp';
}

function shouldUseMarkdownLocalImageLoader(src?: string, markdownFilePath?: string): boolean {
    if (!src || isPassthroughImageSrc(src)) return false;

    const cleanSrc = decodeLocalImagePath(stripLocalImagePathDecorations(src));
    return cleanSrc.startsWith('file:') || isAbsoluteLocalPath(cleanSrc) || Boolean(markdownFilePath);
}

async function resolveMarkdownLocalImagePath(
    src: string,
    markdownFilePath?: string
): Promise<string | null> {
    if (!src || isPassthroughImageSrc(src)) return null;

    const cleanSrc = decodeLocalImagePath(stripLocalImagePathDecorations(src));
    if (cleanSrc.startsWith('file:')) {
        return fileUrlToLocalPath(cleanSrc);
    }
    if (isAbsoluteLocalPath(cleanSrc)) {
        return cleanSrc;
    }
    if (!markdownFilePath) {
        return null;
    }

    const { dirname, join } = await import('@tauri-apps/api/path');
    const markdownDir = await dirname(markdownFilePath);
    return join(markdownDir, cleanSrc);
}

interface MarkdownLocalImageProps {
    src?: string;
    alt?: string;
    markdownFilePath?: string;
}

/**
 * MarkdownLocalImage - Markdown 本地图片渲染组件
 *
 * Markdown 文件中的相对图片路径需要按源文件目录解析，并通过后端读取为 data URL，
 * 避免 WebView 将 `images/foo.png` 错误解析为前端路由下的资源。
 */
function MarkdownLocalImage({ src, alt, markdownFilePath }: MarkdownLocalImageProps) {
    const { t } = useI18n();
    const loadAnchorRef = useRef<HTMLSpanElement>(null);
    const [imageSrc, setImageSrc] = useState<string | null>(null);
    const [hasError, setHasError] = useState(false);
    const [shouldLoadLocalImage, setShouldLoadLocalImage] = useState(false);
    const imageAlt = alt ?? '';
    const useLocalLoader = useMemo(
        () => shouldUseMarkdownLocalImageLoader(src, markdownFilePath),
        [src, markdownFilePath]
    );

    useEffect(() => {
        setShouldLoadLocalImage(false);
        if (!useLocalLoader) return undefined;

        const anchor = loadAnchorRef.current;
        if (!anchor || typeof IntersectionObserver === 'undefined') {
            setShouldLoadLocalImage(true);
            return undefined;
        }

        const observer = new IntersectionObserver((entries) => {
            if (entries.some(entry => entry.isIntersecting)) {
                setShouldLoadLocalImage(true);
                observer.disconnect();
            }
        }, { rootMargin: '800px 0px' });

        observer.observe(anchor);
        return () => observer.disconnect();
    }, [useLocalLoader, src, markdownFilePath]);

    useEffect(() => {
        let disposed = false;
        setImageSrc(null);
        setHasError(false);

        if (!src || !useLocalLoader || !shouldLoadLocalImage) {
            return undefined;
        }
        const currentSrc = src;

        async function loadLocalImage() {
            try {
                const filePath = await resolveMarkdownLocalImagePath(currentSrc, markdownFilePath);
                if (!filePath) {
                    return;
                }

                const { invoke } = await import('@tauri-apps/api/core');
                const fileSize = await invoke<number>('file_get_size', { path: filePath });
                if (fileSize > MARKDOWN_LOCAL_IMAGE_MAX_BYTES) {
                    throw new Error('Markdown local image is too large to preview');
                }

                const shouldDownscale = fileSize > MARKDOWN_LOCAL_IMAGE_DOWNSCALE_BYTES
                    && canDownscaleLocalImage(filePath);
                const [base64, mimeType] = shouldDownscale
                    ? await invoke<[string, string, boolean]>('file_read_image_downscaled_as_base64', {
                        path: filePath,
                        maxWidth: MARKDOWN_LOCAL_IMAGE_MAX_WIDTH,
                    })
                    : [
                        await invoke<string>('file_read_as_base64', { path: filePath }),
                        getMimeTypeFromPath(filePath),
                    ] as const;
                if (!disposed) {
                    setImageSrc(`data:${mimeType};base64,${base64}`);
                }
            } catch {
                if (!disposed) {
                    setHasError(true);
                }
            }
        }

        void loadLocalImage();
        return () => {
            disposed = true;
        };
    }, [src, markdownFilePath, shouldLoadLocalImage, useLocalLoader]);

    if (imageSrc) {
        return (
            <img
                src={imageSrc}
                alt={imageAlt}
                className={styles.image}
                loading="lazy"
            />
        );
    }

    if (hasError) {
        return <span className={styles.imageStatus}>{t('file.imageLoadFailed')}</span>;
    }

    if (useLocalLoader) {
        return (
            <span ref={loadAnchorRef} className={styles.imageStatus}>
                {t('file.loadingImage')}
            </span>
        );
    }

    return (
        <img
            src={src}
            alt={imageAlt}
            className={styles.image}
            referrerPolicy="no-referrer"
            loading="lazy"
            onError={() => setHasError(true)}
        />
    );
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
    content,
    className = '',
    onCodePreview,
    onProjectPreview,
    onImageSave,
    markdownFilePath,
    contextId,
    messageId,
    deferWidgetSubmit,
}: MarkdownRendererProps) {
    const { t } = useI18n();
    // Lightbox 状态（用于点击放大图像生成模型输出的图片）
    const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
    const [lightboxName, setLightboxName] = useState(t('file.generatedImage'));

    const handleImageClick = useCallback((src: string, alt: string) => {
        setLightboxSrc(src);
        setLightboxName(alt.length > 0 ? alt : t('file.generatedImage'));
    }, [t]);

    const closeLightbox = useCallback(() => {
        setLightboxSrc(null);
    }, []);

    const handleLinkClick = useCallback((event: MouseEvent<HTMLAnchorElement>, href?: string) => {
        if (!isHttpLink(href)) return;

        event.preventDefault();
        event.stopPropagation();
        void openExternalLink(href);
    }, []);

    // 预处理：提取 base64 图片数据（避免 react-markdown 解析器截断超长 URL）
    // 使用 useMemo 缓存结果，防止父组件 hover 等无关状态变化导致重新创建 Map
    const { processedContent, imageMap } = useMemo(() => {
        const { processedContent: withPlaceholders, imageMap: map } = extractBase64Images(content);
        const final = preprocessContent(withPlaceholders);
        return { processedContent: final, imageMap: map };
    }, [content]);

    // ─── react-markdown 自定义渲染组件 ────────────────────────────────────────
    //
    // 【关键设计】拆成两个独立 useMemo，避免 EChartsBlock/MermaidBlock/Widget 因
    //   无关状态变化被意外 unmount+remount（dispose → init → setOption 全周期）：
    //
    //   blockComponents: 处理代码块渲染（pre/widget/mermaid/echarts/code/table/a/li 等）
    //     deps: contextId, messageId, onCodePreview, onProjectPreview
    //     → 同一条消息气泡内这些值从不变化，EChartsBlock 保持稳定挂载
    //
    //   imgComponent: 处理 base64 图片渲染（img）
    //     deps: imageMap, handleImageClick, onImageSave
    //     → 仅在 content 更新时刷新，不影响代码块组件的生命周期

    /** 代码块类组件的稳定 memo（不依赖 imageMap，确保图表组件不被图片内容变化触发重建） */
    const blockComponents = useMemo<Partial<Components>>(() => ({
        // 代码块渲染（fenced code block: ```...```）
        // react-markdown v9+ 中 fenced code block 始终被 <pre><code> 包裹
        // 通过 pre 组件接管，避免无语言后缀时被误判为行内代码
        pre({ children }) {
            // children 是 <code> 元素，提取其 props 获取语言和内容
            const codeElement = children as {
                props?: {
                    className?: string;
                    children?: unknown;
                };
            };

            if (codeElement.props) {
                const codeClassName = codeElement.props.className ?? '';
                const language = extractCodeLanguage(codeClassName);
                const codeString = stringifyCodeChildren(codeElement.props.children).replace(/\n$/, '');

                // 拦截 widget 类型的代码块，渲染为交互式 Widget 组件
                // 支持两种格式：
                // 1. widget-choices / widget-chart（精确指定类型）
                // 2. widget（裸标记，从 JSON 结构推断类型，容错 LLM 不精确的输出）
                const widgetLanguage = parseWidgetLanguage(language);
                if (widgetLanguage.isWidget && codeString.trim().length > 0) {
                    // 使用 JsonParser 容错解析 LLM 输出的 JSON
                    // 处理中文引号、缺失引号、尾随逗号等常见格式问题
                    const parseResult = parseWithFallback<Record<string, unknown>>(codeString, {
                        logPrefix: '[MarkdownRenderer:Widget]',
                        suppressWarnings: isLikelyIncompleteJson(codeString),
                    });
                    if (parseResult.success && parseResult.data) {
                        const widgetData = parseResult.data;
                        // 优先使用 language 中显式指定的类型，否则从 JSON 结构推断
                        const widgetType = resolveWidgetType(language, widgetData);
                        if (widgetType) {
                            return (
                                <WidgetRenderer
                                    widgetType={widgetType}
                                    data={widgetData}
                                    contextId={contextId ?? ''}
                                    messageId={messageId}
                                    deferWidgetSubmit={deferWidgetSubmit}
                                />
                            );
                        }
                    }
                    // 解析失败（流式输出中 JSON 尚不完整）：回退到普通代码显示
                }

                // 拦截 mermaid 代码块，渲染为 SVG 图表
                if (language === 'mermaid') {
                    return (
                        <Suspense fallback={<DiagramBlockFallback />}>
                            <LazyMermaidBlock code={codeString} />
                        </Suspense>
                    );
                }

                // 拦截 echarts 代码块，渲染为数据图表
                if (language === 'echarts') {
                    return (
                        <Suspense fallback={<DiagramBlockFallback />}>
                            <LazyEChartsBlock code={codeString} />
                        </Suspense>
                    );
                }

                return (
                    <CodeHighlight
                        code={codeString}
                        language={language}
                        showLineNumbers={true}
                        onPreview={onCodePreview}
                        onProjectPreview={onProjectPreview}
                        collapsible={true}
                    />
                );
            }

            // 安全回退：无法解析时原样渲染
            return <pre>{children}</pre>;
        },

        // 行内代码（`code`）
        code({ children, ...props }) {
            return (
                <code className={styles.inlineCode} {...props}>
                    {children}
                </code>
            );
        },

        // 表格渲染
        table({ children }) {
            return (
                <div className={styles.tableWrapper}>
                    <table className={styles.table}>
                        {children}
                    </table>
                </div>
            );
        },

        // 链接渲染（新窗口打开）
        a({ href, children }) {
            return (
                <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.link}
                    onClick={(event) => handleLinkClick(event, href)}
                >
                    {children}
                </a>
            );
        },

        // 任务列表项
        li({ children, ...props }) {
            // 检查是否为任务列表项（通过检查 className）
            const taskListItemProps = props as { className?: string };
            if (taskListItemProps.className?.includes('task-list-item')) {
                return (
                    <li className={styles.taskListItem} {...props}>
                        {children}
                    </li>
                );
            }
            return <li {...props}>{children}</li>;
        },

        // 复选框
        input({ type, checked, ...props }) {
            if (type === 'checkbox') {
                return (
                    <input
                        type="checkbox"
                        checked={checked}
                        disabled
                        className={styles.checkbox}
                        {...props}
                    />
                );
            }
            return <input type={type} {...props} />;
        },

        // 引用块
        blockquote({ children }) {
            return (
                <blockquote className={styles.blockquote}>
                    {children}
                </blockquote>
            );
        },
    }), [contextId, handleLinkClick, messageId, onCodePreview, onProjectPreview]);

    /** 图片组件的稳定 memo（仅依赖 imageMap，与代码块组件生命周期完全隔离） */
    const imgComponent = useMemo<Partial<Components>>(() => ({
        // 图片渲染（支持图像生成模型的 base64 data URI）
        img({ src, alt }) {
            // 从占位符映射中查找实际 data URL（解决 react-markdown 无法处理超长 URL 的问题）
            const mappedSrc = src ? imageMap.get(src) : undefined;
            const actualSrc = mappedSrc ?? src;
            const imageAlt = alt ?? '';
            const displayAlt = imageAlt.length > 0 ? imageAlt : t('file.generatedImage');
            // 检测是否为 base64 data URI（图像生成模型输出）
            const isDataUrl = actualSrc?.startsWith('data:image/');
            if (isDataUrl && actualSrc) {
                return (
                    <div className={styles.generatedImageWrapper}>
                        <img
                            src={actualSrc}
                            alt={displayAlt}
                            className={styles.generatedImage}
                            loading="lazy"
                            onClick={() => handleImageClick(actualSrc, imageAlt)}
                        />
                        <div className={styles.imageOverlay}>
                            <button
                                className={styles.imageActionBtn}
                                onClick={() => handleImageClick(actualSrc, imageAlt)}
                                title={t('file.viewLargeImage')}
                            >
                                <ZoomIn size={14} /> {t('file.viewLargeImage')}
                            </button>
                            {onImageSave && (
                                <button
                                    className={styles.imageActionBtn}
                                    onClick={() => {
                                        // 生成文件名：generated_YYYYMMDD_HHmmss.png
                                        const now = new Date();
                                        const ts = now.getFullYear().toString()
                                            + (now.getMonth() + 1).toString().padStart(2, '0')
                                            + now.getDate().toString().padStart(2, '0')
                                            + '_'
                                            + now.getHours().toString().padStart(2, '0')
                                            + now.getMinutes().toString().padStart(2, '0')
                                            + now.getSeconds().toString().padStart(2, '0');
                                        const mimeMatch = actualSrc.match(/data:image\/(\w+);/);
                                        const ext = mimeMatch?.[1] ?? 'png';
                                        onImageSave(actualSrc, `generated_${ts}.${ext}`);
                                    }}
                                    title={t('file.saveToDeliverables')}
                                >
                                    <Download size={14} /> {t('file.saveToDeliverables')}
                                </button>
                            )}
                        </div>
                    </div>
                );
            }

            // 普通 URL / Markdown 本地图片
            return (
                <MarkdownLocalImage
                    src={actualSrc}
                    alt={imageAlt}
                    markdownFilePath={markdownFilePath}
                />
            );
        },
    }), [imageMap, handleImageClick, markdownFilePath, onImageSave, t]);

    /** 合并后的最终 components：两个 memo 都稳定时，此对象也稳定 */
    const components = useMemo<Components>(
        () => ({ ...blockComponents, ...imgComponent }) as Components,
        [blockComponents, imgComponent]
    );

    return (
        <div className={cx(styles.markdown, className)}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={components}
            >
                {processedContent}
            </ReactMarkdown>

            {/* Lightbox 全屏预览（图像生成模型输出的图片点击放大） */}
            {lightboxSrc && (
                <ImageLightbox
                    src={lightboxSrc}
                    fileName={lightboxName}
                    onClose={closeLightbox}
                />
            )}
        </div>
    );
});
