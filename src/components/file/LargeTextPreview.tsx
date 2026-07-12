/**
 * LargeTextPreview - 大型文本文件安全预览
 *
 * 通过后端有界读取分页展示文本；Markdown 每页最多渲染一个固定窗口，
 * 超过硬上限时默认只显示外部打开入口，由用户主动开启安全预览。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronLeft, ChevronRight, ExternalLink, Eye, FileText, Loader2 } from 'lucide-react';
import { Tooltip } from '@components/ui/Tooltip';
import { useI18n, type TranslationKey } from '@/i18n';
import {
  reportRendererHealthSnapshot,
  setRendererHealthStage,
} from '@services/diagnostics/rendererHealth';
import { MarkdownRenderer } from './MarkdownRenderer';
import {
  createInlineTextWindow,
  TEXT_PREVIEW_WINDOW_BYTES,
  type TextFileWindow,
  type TextPreviewDecision,
} from './TextPreviewPolicy';
import styles from './FilePreview.module.css';

interface LargeTextPreviewProps {
  fileName: string;
  filePath: string;
  fileSize: number;
  decision: TextPreviewDecision;
  /** 办公文档已提取的内存文本；提供时不读取原始二进制文件。 */
  inlineContent?: string;
  /** 嵌入已有文件卡片时隐藏重复的元信息卡片。 */
  showFileCard?: boolean;
}

const REASON_KEYS: Record<TextPreviewDecision['reason'], TranslationKey> = {
  withinBudget: 'file.textPreviewReasonSize',
  fileSize: 'file.textPreviewReasonSize',
  lineCount: 'file.textPreviewReasonLines',
  longLine: 'file.textPreviewReasonLongLine',
  linkCount: 'file.textPreviewReasonLinks',
  tableComplexity: 'file.textPreviewReasonTable',
  codeBlockSize: 'file.textPreviewReasonCodeBlock',
  hardLimit: 'file.textPreviewReasonHardLimit',
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function LargeTextPreview({
  fileName,
  filePath,
  fileSize,
  decision,
  inlineContent,
  showFileCard = true,
}: LargeTextPreviewProps) {
  const { t } = useI18n();
  const [safePreviewEnabled, setSafePreviewEnabled] = useState(
    decision.mode !== 'external' || !showFileCard
  );
  const [pageStarts, setPageStarts] = useState([0]);
  const [pageIndex, setPageIndex] = useState(0);
  const [windowContent, setWindowContent] = useState<TextFileWindow | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renderMarkdown, setRenderMarkdown] = useState(decision.kind === 'markdown');
  const inlineBytes = useMemo(
    () => (inlineContent === undefined ? null : new TextEncoder().encode(inlineContent)),
    [inlineContent]
  );
  const pageStart = pageStarts[pageIndex] ?? 0;

  useEffect(() => {
    setSafePreviewEnabled(decision.mode !== 'external' || !showFileCard);
    setPageStarts([0]);
    setPageIndex(0);
    setWindowContent(null);
    setError(null);
    setRenderMarkdown(decision.kind === 'markdown');
  }, [decision.kind, decision.mode, filePath, inlineContent, showFileCard]);

  useEffect(() => {
    if (!safePreviewEnabled) return undefined;

    let disposed = false;
    setIsLoading(true);
    setError(null);

    const loadWindow = async () => {
      try {
        const nextWindow = inlineBytes
          ? createInlineTextWindow(inlineBytes, pageStart)
          : await invoke<TextFileWindow>('file_read_text_window', {
              filePath,
              offset: pageStart,
              maxBytes: TEXT_PREVIEW_WINDOW_BYTES,
            });
        if (!disposed) {
          const clearStage = setRendererHealthStage('file-preview:text-window', {
            fileName,
            kind: decision.kind,
            page: pageIndex + 1,
            chars: nextWindow.content.length,
            markdown: renderMarkdown,
          });
          reportRendererHealthSnapshot();
          setWindowContent(nextWindow);
          window.setTimeout(clearStage, 0);
        }
      } catch (loadError) {
        if (!disposed) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!disposed) setIsLoading(false);
      }
    };

    void loadWindow();
    return () => {
      disposed = true;
    };
  }, [
    decision.kind,
    fileName,
    filePath,
    inlineBytes,
    pageIndex,
    pageStart,
    renderMarkdown,
    safePreviewEnabled,
  ]);

  const analysisSummary = useMemo(() => {
    const analysis = decision.analysis;
    if (!analysis) return null;
    if (decision.kind !== 'markdown') {
      return t('file.textPreviewLineAnalysis', {
        lines: analysis.lineCount,
        maxLine: formatFileSize(analysis.maxLineBytes),
      });
    }
    return t('file.textPreviewAnalysis', {
      lines: analysis.lineCount,
      links: analysis.markdownLinkCount,
      tableRows: analysis.markdownTableRowCount,
    });
  }, [decision.analysis, decision.kind, t]);

  const handleOpenSystem = useCallback(async () => {
    setIsOpening(true);
    try {
      await invoke('file_open_system', { filePath });
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    } finally {
      window.setTimeout(() => setIsOpening(false), 1500);
    }
  }, [filePath]);

  const handleNext = useCallback(() => {
    if (!windowContent || windowContent.eof) return;
    const nextIndex = pageIndex + 1;
    setPageStarts((current) => {
      if (current[nextIndex] === windowContent.nextByte) return current;
      return [...current.slice(0, nextIndex), windowContent.nextByte];
    });
    setPageIndex(nextIndex);
  }, [pageIndex, windowContent]);

  return (
    <div className={styles.largeTextPreview}>
      {showFileCard && (
        <div className={styles.binaryDocCard}>
          <div className={styles.binaryDocIcon}>
            <FileText size={32} />
          </div>
          <div className={styles.binaryDocMeta}>
            <span className={styles.binaryDocName}>{fileName}</span>
            <span className={styles.binaryDocInfo}>
              {formatFileSize(fileSize)} · {t(REASON_KEYS[decision.reason])}
              {analysisSummary && (
                <>
                  <br />
                  {analysisSummary}
                </>
              )}
            </span>
          </div>
          {!safePreviewEnabled && (
            <button className={styles.openSystemBtn} onClick={() => setSafePreviewEnabled(true)}>
              <Eye size={14} />
              <span>{t('file.safePreview')}</span>
            </button>
          )}
          <Tooltip content={t('file.openWithSystem')}>
            <button
              className={styles.openSystemBtn}
              onClick={() => void handleOpenSystem()}
              disabled={isOpening}
            >
              <ExternalLink size={14} />
              <span>{isOpening ? t('file.opening') : t('file.systemOpen')}</span>
            </button>
          </Tooltip>
        </div>
      )}

      {safePreviewEnabled && (
        <div className={styles.textWindowPanel}>
          <div className={styles.textWindowToolbar}>
            <span>
              {t('file.previewPage', { page: pageIndex + 1 })}
              {windowContent &&
                ` · ${formatFileSize(windowContent.startByte)}–${formatFileSize(windowContent.nextByte)} / ${formatFileSize(windowContent.totalBytes)}`}
            </span>
            <div className={styles.textWindowActions}>
              {decision.kind === 'markdown' && (
                <button
                  className={styles.textWindowButton}
                  onClick={() => setRenderMarkdown((current) => !current)}
                >
                  {renderMarkdown
                    ? t('file.textPreviewViewSource')
                    : t('file.textPreviewViewFormatted')}
                </button>
              )}
              <button
                className={styles.textWindowButton}
                onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
                disabled={pageIndex === 0 || isLoading}
                aria-label={t('file.previousPreviewPage')}
              >
                <ChevronLeft size={14} />
              </button>
              <button
                className={styles.textWindowButton}
                onClick={handleNext}
                disabled={!windowContent || windowContent.eof || isLoading}
                aria-label={t('file.nextPreviewPage')}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>

          {isLoading ? (
            <div className={styles.textWindowStatus}>
              <Loader2 className={styles.spinner} size={20} />
              <span>{t('common.loading')}</span>
            </div>
          ) : error ? (
            <div className={styles.textWindowStatus}>{t('file.safePreviewFailed')}</div>
          ) : windowContent && renderMarkdown && decision.kind === 'markdown' ? (
            <div className={styles.textWindowMarkdown}>
              <MarkdownRenderer content={windowContent.content} markdownFilePath={filePath} />
            </div>
          ) : (
            <pre className={styles.textWindowSource}>{windowContent?.content ?? ''}</pre>
          )}
        </div>
      )}
    </div>
  );
}
