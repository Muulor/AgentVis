/**
 * FilePreview - 文件预览组件
 *
 * 根据文件类型选择合适的渲染器：
 * - 图片文件: 内嵌 <img> 渲染（通过 Tauri asset 协议）
 * - 视频文件: 内嵌 <video> 播放器（通过 convertFileSrc 流式加载）
 * - 音频文件: 内嵌 <audio> 播放器
 * - Markdown: 使用 MarkdownRenderer
 * - 代码文件: 使用 CodeHighlight
 * - 大型 HTML 文件 (>500KB): LargeHtmlCard（跳过语法高亮，直接预览）
 * - 二进制文档 (docx/xlsx/pptx/pdf): 信息卡片 + 提取内容预览 + 系统打开按钮
 * - 其他: 纯文本显示
 */

import { useRef, useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
    FileText, Loader2, ExternalLink, ImageOff,
    FileSpreadsheet, FileType, Presentation, FileDown,
    Music, VideoOff, Play,
} from 'lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { CodeHighlight } from './CodeHighlight';
import { TextContextMenu, Tooltip, useTextContextMenu } from '@components/ui';
import { usePreviewStore } from '@stores/previewStore';
import { getLogger } from '@services/logger';
import { isPreviewableFile, inferTemplateFromFileName } from '@services/preview';
import { useI18n } from '@/i18n';
import {
    getAudioMimeType,
    getCodeLanguage,
    getFileExtension,
    getImageMimeType,
    getVideoMimeType,
    isAudioFile as isRegistryAudioFile,
    isBinaryDocumentFile,
    isCodeFile as isRegistryCodeFile,
    isHtmlFile as isRegistryHtmlFile,
    isImageFile as isRegistryImageFile,
    isInlineVideoFile as isRegistryInlineVideoFile,
    isMarkdownFile as isRegistryMarkdownFile,
    isSystemVideoFile as isRegistrySystemVideoFile,
} from '@services/file-types';
import styles from './FilePreview.module.css';

const logger = getLogger('FilePreview');

interface FilePreviewProps {
    /** 文件名 */
    fileName: string | null;
    /** 文件内容（文本文件原文；二进制文件为后端提取的文本） */
    content: string;
    /** 文件绝对路径（用于图片渲染和系统打开） */
    filePath: string | null;
    /** 是否正在加载 */
    isLoading: boolean;
}

/** 获取文件扩展名（小写） */
function getExt(fileName: string): string {
    return getFileExtension(fileName);
}

/** 获取文件扩展名对应的语言 */
function getLanguageFromFileName(fileName: string): string {
    return getCodeLanguage(fileName);
}

/** 判断是否为 Markdown 文件 */
function isMarkdownFile(fileName: string): boolean {
    return isRegistryMarkdownFile(fileName);
}

/** 判断是否为代码文件 */
function isCodeFile(fileName: string): boolean {
    return isRegistryCodeFile(fileName);
}

/** 判断是否为图片文件 */
function isImageFile(fileName: string): boolean {
    return isRegistryImageFile(fileName);
}

/** 判断是否为二进制办公文档 */
function isBinaryDocFile(fileName: string): boolean {
    return isBinaryDocumentFile(fileName);
}

/** 判断是否为 HTML 文件（可预览） */
function isHtmlFile(fileName: string): boolean {
    return isRegistryHtmlFile(fileName);
}

/**
 * HTML 大文件阈值（字符数，近似等于字节数）
 *
 * Plotly Python 默认会将完整的 Plotly.js bundle（约 3.2MB）内联到 HTML 中，
 * 生成的文件通常在 4~5MB。对这类超大 HTML 文件跳过 CodeHighlight 语法高亮，
 * 避免 prism-react-renderer 在主线程上处理数万行 token 导致 UI 冻结。
 */
const LARGE_HTML_THRESHOLD_CHARS = 500 * 1024; // 500KB


/** 判断是否为可内嵌播放的视频文件 */
function isInlineVideoFile(fileName: string): boolean {
    // WebView2 (Chromium) 和 WebKit 都支持的常见格式
    return isRegistryInlineVideoFile(fileName);
}

/** 判断是否为需要系统打开的视频文件（浏览器不支持的格式） */
function isSystemVideoFile(fileName: string): boolean {
    return isRegistrySystemVideoFile(fileName);
}

/** 判断是否为音频文件 */
function isAudioFile(fileName: string): boolean {
    return isRegistryAudioFile(fileName);
}

/** 根据扩展名获取文档类型图标和标签 */
function getDocTypeInfo(fileName: string, t: ReturnType<typeof useI18n>['t']): { icon: React.ReactElement; label: string } {
    const ext = getExt(fileName);
    switch (ext) {
        case 'xlsx':
        case 'xls':
            return { icon: <FileSpreadsheet size={32} />, label: t('file.docExcel') };
        case 'docx':
            return { icon: <FileText size={32} />, label: t('file.docWord') };
        case 'pptx':
            return { icon: <Presentation size={32} />, label: t('file.docPowerPoint') };
        case 'pdf':
            return { icon: <FileDown size={32} />, label: t('file.docPdf') };
        default:
            return { icon: <FileType size={32} />, label: t('file.docBinary') };
    }
}

/** 格式化文件大小 */
function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ==================== 图片预览子组件 ====================

/** 图片预览：读取为 base64 data URL 内嵌渲染 */
function ImagePreview({ filePath, fileName }: { filePath: string; fileName: string }) {
    const { t } = useI18n();
    const [imageSrc, setImageSrc] = useState<string | null>(null);
    const [hasError, setHasError] = useState(false);

    // 通过 Rust 命令读取图片为 base64，构建 data URL
    useEffect(() => {
        setHasError(false);
        setImageSrc(null);

        const mimeType = getImageMimeType(fileName);

        invoke<string>('file_read_as_base64', { path: filePath })
            .then((base64) => {
                setImageSrc(`data:${mimeType};base64,${base64}`);
            })
            .catch(() => {
                setHasError(true);
            });
    }, [filePath, fileName]);

    if (hasError) {
        return (
            <div className={styles.imageError}>
                <ImageOff size={32} />
                <p>{t('file.imageLoadFailed')}</p>
                <p className={styles.imageErrorHint}>{fileName}</p>
            </div>
        );
    }

    if (!imageSrc) {
        return (
            <div className={styles.loading}>
                <Loader2 className={styles.spinner} size={24} />
                <span>{t('file.loadingImage')}</span>
            </div>
        );
    }

    return (
        <div className={styles.imageContainer}>
            <img
                src={imageSrc}
                alt={fileName}
                className={styles.imagePreview}
                onError={() => setHasError(true)}
            />
        </div>
    );
}

// ==================== 媒体文件大小阈值 ====================

/** 内嵌播放的文件大小上限（100MB），超过此阈值降级为系统打开 */
const INLINE_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

/** 大文件降级卡片：显示文件类型图标、大小信息和系统打开按钮 */
function MediaFallbackCard({
    fileName,
    filePath,
    fileSize,
    icon,
    label,
}: {
    fileName: string;
    filePath: string;
    fileSize: number;
    icon: React.ReactElement;
    label: string;
}) {
    const { t } = useI18n();
    const [isOpening, setIsOpening] = useState(false);

    const handleOpenSystem = useCallback(async () => {
        setIsOpening(true);
        try {
            await invoke('file_open_system', { filePath });
        } catch (error) {
            console.error('[FilePreview] 系统打开失败:', error);
        } finally {
            setTimeout(() => setIsOpening(false), 1500);
        }
    }, [filePath]);

    return (
        <div className={styles.binaryDocWrapper}>
            <div className={styles.binaryDocCard}>
                <div className={styles.binaryDocIcon}>{icon}</div>
                <div className={styles.binaryDocMeta}>
                    <span className={styles.binaryDocName}>{fileName}</span>
                    <span className={styles.binaryDocInfo}>
                        {label} · {formatFileSize(fileSize)}
                        <br />
                        {t('file.tooLargeUseSystem')}
                    </span>
                </div>
                <Tooltip content={t('file.openWithSystem')}>
                    <button
                        className={styles.openSystemBtn}
                        onClick={() => { void handleOpenSystem(); }}
                        disabled={isOpening}
                    >
                        <ExternalLink size={14} />
                        <span>{isOpening ? t('file.opening') : t('file.systemOpen')}</span>
                    </button>
                </Tooltip>
            </div>
        </div>
    );
}


/**
 * 视频预览：通过后端读取文件为 base64 → 构建 Blob URL → 流式播放。
 *
 * 不使用 convertFileSrc 的原因：Tauri asset 协议不支持 HTTP Range 请求，
 * 而 <video> 标签需要 Range 请求实现拖拽进度条和流式加载。
 * Blob URL 在桌面端对 20MB 级别文件开销可接受。
 */
function VideoPreview({ filePath, fileName }: { filePath: string; fileName: string }) {
    const { t } = useI18n();
    const [videoUrl, setVideoUrl] = useState<string | null>(null);
    const [hasError, setHasError] = useState(false);
    const [fileSize, setFileSize] = useState<number | null>(null);
    const [isTooLarge, setIsTooLarge] = useState(false);

    const mimeType = getVideoMimeType(fileName);

    useEffect(() => {
        setHasError(false);
        setVideoUrl(null);
        setIsTooLarge(false);

        // 先检查文件大小，超过阈值则降级
        invoke<number>('file_get_size', { path: filePath })
            .then((size) => {
                setFileSize(size);
                if (size > INLINE_MEDIA_MAX_BYTES) {
                    setIsTooLarge(true);
                    return;
                }
                return invoke<string>('file_read_as_base64', { path: filePath });
            })
            .then((base64) => {
                if (!base64) return;
                const binaryStr = atob(base64);
                const bytes = new Uint8Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) {
                    bytes[i] = binaryStr.charCodeAt(i);
                }
                const blob = new Blob([bytes], { type: mimeType });
                const url = URL.createObjectURL(blob);
                setVideoUrl(url);
            })
            .catch(() => {
                setHasError(true);
            });

        // 清理 Blob URL 防止内存泄漏
        return () => {
            if (videoUrl) {
                URL.revokeObjectURL(videoUrl);
            }
        };
    }, [filePath]); // eslint-disable-line react-hooks/exhaustive-deps

    if (hasError) {
        return (
            <div className={styles.imageError}>
                <VideoOff size={32} />
                <p>{t('file.videoLoadFailed')}</p>
                <p className={styles.imageErrorHint}>{fileName}</p>
            </div>
        );
    }

    // 文件过大，降级为系统打开
    if (isTooLarge && fileSize !== null) {
        return (
            <MediaFallbackCard
                fileName={fileName}
                filePath={filePath}
                fileSize={fileSize}
                icon={<VideoOff size={32} />}
                label={t('file.videoFile')}
            />
        );
    }

    if (!videoUrl) {
        return (
            <div className={styles.loading}>
                <Loader2 className={styles.spinner} size={24} />
                <span>{t('file.loadingVideo')}</span>
            </div>
        );
    }

    return (
        <div className={styles.videoContainer}>
            <video
                controls
                className={styles.videoPlayer}
                onError={() => setHasError(true)}
                preload="metadata"
                src={videoUrl}
            />
        </div>
    );
}

// ==================== 音频预览子组件 ====================

/** 音频预览：同样使用 Blob URL 方式加载，超过 100MB 降级 */
function AudioPreview({ filePath, fileName }: { filePath: string; fileName: string }) {
    const { t } = useI18n();
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const [hasError, setHasError] = useState(false);
    const [fileSize, setFileSize] = useState<number | null>(null);
    const [isTooLarge, setIsTooLarge] = useState(false);

    useEffect(() => {
        setHasError(false);
        setAudioUrl(null);
        setIsTooLarge(false);

        const mimeType = getAudioMimeType(fileName);

        invoke<number>('file_get_size', { path: filePath })
            .then((size) => {
                setFileSize(size);
                if (size > INLINE_MEDIA_MAX_BYTES) {
                    setIsTooLarge(true);
                    return;
                }
                return invoke<string>('file_read_as_base64', { path: filePath });
            })
            .then((base64) => {
                if (!base64) return;
                const binaryStr = atob(base64);
                const bytes = new Uint8Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) {
                    bytes[i] = binaryStr.charCodeAt(i);
                }
                const blob = new Blob([bytes], { type: mimeType });
                const url = URL.createObjectURL(blob);
                setAudioUrl(url);
            })
            .catch(() => {
                setHasError(true);
            });

        return () => {
            if (audioUrl) {
                URL.revokeObjectURL(audioUrl);
            }
        };
    }, [filePath]); // eslint-disable-line react-hooks/exhaustive-deps

    if (hasError) {
        return (
            <div className={styles.imageError}>
                <Music size={32} />
                <p>{t('file.audioLoadFailed')}</p>
                <p className={styles.imageErrorHint}>{fileName}</p>
            </div>
        );
    }

    // 文件过大，降级为系统打开
    if (isTooLarge && fileSize !== null) {
        return (
            <MediaFallbackCard
                fileName={fileName}
                filePath={filePath}
                fileSize={fileSize}
                icon={<Music size={32} />}
                label={t('file.audioFile')}
            />
        );
    }

    if (!audioUrl) {
        return (
            <div className={styles.loading}>
                <Loader2 className={styles.spinner} size={24} />
                <span>{t('file.loadingAudio')}</span>
            </div>
        );
    }

    return (
        <div className={styles.audioContainer}>
            <div className={styles.audioIcon}>
                <Music size={32} />
            </div>
            <span className={styles.audioFileName}>{fileName}</span>
            <audio
                controls
                className={styles.audioPlayer}
                preload="metadata"
                src={audioUrl}
            />
        </div>
    );
}

// ==================== 大文件 HTML 卡片子组件 ====================

/**
 * LargeHtmlCard - 大型 HTML 文件预览卡片
 *
 * 当 HTML 文件内容超过阈值时（如 Plotly 生成的自包含图表 HTML），
 * 跳过 CodeHighlight 的语法高亮处理（会阻塞主线程），改为显示：
 * - 文件名 + 大小信息
 * - 「直接预览」按钮（触发 iframe 渲染）
 */
function LargeHtmlCard({
    fileName,
    content,
    onPreview,
}: {
    fileName: string;
    content: string;
    onPreview: () => void;
}) {
    const { t } = useI18n();
    const sizeKb = (content.length / 1024).toFixed(1);

    return (
        <div className={styles.binaryDocWrapper}>
            {/* 文件信息卡片 */}
            <div className={styles.binaryDocCard}>
                <div className={styles.binaryDocIcon}>
                    <FileText size={32} />
                </div>
                <div className={styles.binaryDocMeta}>
                    <span className={styles.binaryDocName}>{fileName}</span>
                    <span className={styles.binaryDocInfo}>
                        {t('file.htmlFile')} · {sizeKb} KB
                        <br />
                        {/* 说明为何跳过语法高亮 */}
                        {t('file.largeHtmlHint')}
                    </span>
                </div>
                {/* 直接预览：触发 iframe 渲染 */}
                <Tooltip content={t('file.renderHtmlTitle')}>
                    <button
                        className={styles.openSystemBtn}
                        onClick={onPreview}
                    >
                        <Play size={14} />
                        <span>{t('layout.panelPreview')}</span>
                    </button>
                </Tooltip>
            </div>
        </div>
    );
}

// ==================== 二进制文档卡片子组件 ====================

/** 二进制文档信息卡片：类型图标 + 元信息 + 系统打开按钮 + 提取内容预览 */
function BinaryDocCard({
    fileName,
    filePath,
    content,
}: {
    fileName: string;
    filePath: string;
    content: string;
}) {
    const { t } = useI18n();
    const [fileSize, setFileSize] = useState<number | null>(null);
    const [isOpening, setIsOpening] = useState(false);
    const { icon, label } = getDocTypeInfo(fileName, t);

    // 获取文件大小
    useEffect(() => {
        invoke<number>('file_get_size', { path: filePath })
            .then(setFileSize)
            .catch(() => setFileSize(null));
    }, [filePath]);

    // 用系统默认应用打开文件
    const handleOpenSystem = useCallback(async () => {
        setIsOpening(true);
        try {
            await invoke('file_open_system', { filePath });
        } catch (error) {
            console.error('[FilePreview] 系统打开失败:', error);
        } finally {
            // 短暂延迟后恢复按钮，避免连续点击
            setTimeout(() => setIsOpening(false), 1500);
        }
    }, [filePath]);

    // 分离提取内容：移除自动解析头部说明行
    const extractedContent = content.replace(/^\[(?:Auto parsed from|Parsed from|\u81ea\u52a8\u89e3\u6790\u81ea).*?\]\n\n/i, '');

    return (
        <div className={styles.binaryDocWrapper}>
            {/* 文件信息卡片 */}
            <div className={styles.binaryDocCard}>
                <div className={styles.binaryDocIcon}>{icon}</div>
                <div className={styles.binaryDocMeta}>
                    <span className={styles.binaryDocName}>{fileName}</span>
                    <span className={styles.binaryDocInfo}>
                        {label}
                        {fileSize !== null && ` · ${formatFileSize(fileSize)}`}
                    </span>
                </div>
                <Tooltip content={t('file.openWithSystem')}>
                    <button
                        className={styles.openSystemBtn}
                        onClick={() => { void handleOpenSystem(); }}
                        disabled={isOpening}
                    >
                        <ExternalLink size={14} />
                        <span>{isOpening ? t('file.opening') : t('file.systemOpen')}</span>
                    </button>
                </Tooltip>
            </div>

            {/* 提取内容预览区域 */}
            {extractedContent.trim() && (
                <div className={styles.extractedContent}>
                    <div className={styles.extractedHeader}>{t('file.extractedPreview')}</div>
                    <MarkdownRenderer content={extractedContent} />
                </div>
            )}
        </div>
    );
}

// ==================== 主组件 ====================

export function FilePreview({ fileName, content, filePath, isLoading }: FilePreviewProps) {
    const { t } = useI18n();
    // 滚动容器引用，用于在切换文件时重置滚动位置
    const scrollRef = useRef<HTMLDivElement>(null);
    const {
        menu: textContextMenu,
        closeMenu: closeTextContextMenu,
        openSelectionMenu,
        handleMenuAction,
    } = useTextContextMenu();
    const { openPreview, startProjectPreview, setProjectStatus, setProjectUrl } = usePreviewStore();

    // HTML 文件预览回调
    // 提取文件所在目录作为 baseDir，用于解析 HTML 中的相对路径资源（图片等）
    const handleHtmlPreview = useCallback(
        async (code: string) => {
            let baseDir: string | undefined;
            if (filePath) {
                try {
                    const { dirname } = await import('@tauri-apps/api/path');
                    baseDir = await dirname(filePath);
                } catch (error) {
                    logger.warn('[FilePreview] 获取 baseDir 失败:', error);
                }
            }
            openPreview(code, fileName ?? 'HTML Preview', baseDir);
        },
        [openPreview, fileName, filePath]
    );
    const handleCodePreview = useCallback(
        (code: string) => {
            void handleHtmlPreview(code);
        },
        [handleHtmlPreview]
    );

    /**
     * 项目预览回调（交付物文件）
     *
     * 从文件路径推断 deliverables 目录，用文件名作为 src/ 下的源文件。
     */
    const handleProjectPreview = useCallback(
        async (code: string, _language: string) => {
            if (!fileName || !filePath) return;
            try {
                const templateId = inferTemplateFromFileName(fileName);
                startProjectPreview(templateId);
                setProjectStatus('installing');

                // 从 filePath 推断 deliverableDir：文件的父目录即为 Agent 工作目录
                const { dirname } = await import('@tauri-apps/api/path');
                const deliverableDir = await dirname(filePath);

                // 文件名作为相对路径（例如 App.jsx -> src/App.jsx）
                const srcPath = `src/${fileName}`;

                const { vitePreviewService } = await import('@services/preview');
                const url = await vitePreviewService.startProject(
                    deliverableDir,
                    // 使用固定项目名，复用同一目录
                    'vite_preview',
                    templateId,
                    [{ path: srcPath, content: code }],
                );

                setProjectUrl(url, templateId);
                logger.debug('[FilePreview] Project preview started:', url);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.error('[FilePreview] Project preview failed:', errorMessage);
                setProjectStatus('error', errorMessage);
            }
        },
        [fileName, filePath, startProjectPreview, setProjectStatus, setProjectUrl]
    );
    const handleProjectPreviewAction = useCallback(
        (code: string, language: string) => {
            void handleProjectPreview(code, language);
        },
        [handleProjectPreview]
    );

    // 当文件名变化时，重置滚动位置到顶部
    useEffect(() => {
        if (scrollRef.current && fileName) {
            scrollRef.current.scrollTop = 0;
        }
    }, [fileName]);

    const handleContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        openSelectionMenu(event, scrollRef.current);
    }, [openSelectionMenu]);

    // 加载状态
    if (isLoading) {
        return (
            <div className={styles.loading}>
                <Loader2 className={styles.spinner} size={24} />
                <span>{t('common.loading')}</span>
            </div>
        );
    }

    // 空状态
    if (!fileName) {
        return (
            <div className={styles.empty}>
                <FileText size={32} className={styles.emptyIcon} />
                <p className={styles.emptyText}>{t('file.selectFilePreview')}</p>
                <p className={styles.emptyHint}>{t('file.selectFileHint')}</p>
            </div>
        );
    }

    // 渲染内容
    return (
        <div className={styles.preview}>
            <div
                className={styles.content}
                ref={scrollRef}
                data-custom-context-menu
                onContextMenu={handleContextMenu}
            >
                {isImageFile(fileName) && filePath ? (
                    <ImagePreview filePath={filePath} fileName={fileName} />
                ) : isInlineVideoFile(fileName) && filePath ? (
                    <VideoPreview filePath={filePath} fileName={fileName} />
                ) : (isSystemVideoFile(fileName) || isAudioFile(fileName)) && filePath ? (
                    isAudioFile(fileName) ? (
                        <AudioPreview filePath={filePath} fileName={fileName} />
                    ) : (
                        <BinaryDocCard
                            fileName={fileName}
                            filePath={filePath}
                            content={content}
                        />
                    )
                ) : isBinaryDocFile(fileName) && filePath ? (
                    <BinaryDocCard fileName={fileName} filePath={filePath} content={content} />
                ) : isHtmlFile(fileName) ? (
                    // 超大 HTML（如 Plotly 图表）跳过语法高亮，避免主线程冻结
                    content.length > LARGE_HTML_THRESHOLD_CHARS ? (
                        <LargeHtmlCard
                            fileName={fileName}
                            content={content}
                            onPreview={() => { void handleHtmlPreview(content); }}
                        />
                    ) : (
                        <CodeHighlight
                            code={content}
                            language="html"
                            showLineNumbers={true}
                            onPreview={handleCodePreview}
                        />
                    )
                ) : isMarkdownFile(fileName) ? (
                    <MarkdownRenderer content={content} markdownFilePath={filePath ?? undefined} />
                ) : isCodeFile(fileName) ? (
                    <CodeHighlight
                        code={content}
                        language={getLanguageFromFileName(fileName)}
                        showLineNumbers={true}
                        onProjectPreview={isPreviewableFile(fileName) ? handleProjectPreviewAction : undefined}
                    />
                ) : (
                    <pre className={styles.plainText}>{content}</pre>
                )}
            </div>
            <TextContextMenu
                menu={textContextMenu}
                onAction={handleMenuAction}
                onClose={closeTextContextMenu}
            />
        </div>
    );
}
