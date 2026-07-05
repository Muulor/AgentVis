/**
 * SnapshotHistory - 快照历史面板组件
 * 
 * 显示文档快照列表，支持预览和回滚操作
 * 预览方向为「前一版本 → 本版本」（显示本快照做了什么）
 */

import { useState, useMemo } from 'react';
import { useI18n, type Language } from '@/i18n';
import styles from './SnapshotHistory.module.css';
import { DiffViewer } from './DiffViewer';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Tooltip } from '@components/ui/Tooltip';
import { RotateCcw } from 'lucide-react';
import { cx } from '@utils/classNames';
import type { DocumentSnapshot } from '../../services/fast-apply/types';
import { fastApplyEngine } from '../../services/fast-apply';

// ==================== 类型定义 ====================

export interface SnapshotHistoryProps {
    /** 快照列表 */
    snapshots: DocumentSnapshot[];
    /** 当前文档内容 */
    currentContent: string;
    /** 文件名 */
    fileName?: string;
    /** 当前激活的快照 ID（用于在顶部显示版本号，回滚后也能告知用户当前所在版本） */
    activeSnapshotId?: string | null;
    /** 回滚回调 */
    onRollback: (snapshotId: string) => Promise<void>;
    /** 关闭回调 */
    onClose: () => void;
    /** 是否显示加载状态 */
    isLoading?: boolean;
    /** 删除回调 */
    onDelete?: (snapshotId: string) => Promise<void>;
}

/** 快照条目的增删行数摘要 */
interface DiffSummary {
    added: number;
    removed: number;
}

interface SnapshotItemProps {
    snapshot: DocumentSnapshot;
    index: number;
    isCurrentVersion: boolean;
    /** 当前所在版本号（用于顶部标题显示，例如"当前版本（版本 3）"） */
    currentVersionNumber?: number | null;
    diffSummary?: DiffSummary;
    onPreview: (snapshot: DocumentSnapshot) => void;
    onRollback: (snapshot: DocumentSnapshot) => void;
    onDelete?: (snapshot: DocumentSnapshot) => void;
}

// ==================== 辅助函数 ====================

const ORIGINAL_FILE_VERSION_DESCRIPTION = 'Original file version';
const ACCEPT_SNAPSHOT_PREFIX = 'Accept changes: ';
const REJECT_SNAPSHOT_PREFIX = 'Reject changes: ';
const ROLLBACK_SNAPSHOT_PREFIX = 'Rollback to version ';
const REJECT_ALL_SNAPSHOT_DESCRIPTION = 'Reject all';
type I18nT = ReturnType<typeof useI18n>['t'];

/**
 * 格式化精确时间，例如 \"Mar 26 5:05:32 PM\"
 *
 * 精确到秒，避免同分钟内连续创建的快照显示相同时间戳带来的混淆。
 * 相对时间（刚刚/X分钟前）作为 tooltip 辅助提示。
 */
function formatExactTime(date: Date, language: Language): string {
    return date.toLocaleString(language, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
    });
}

/**
 * 格式化相对时间（用作 tooltip）
 */
function formatRelativeTime(date: Date, t: I18nT): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMinutes = Math.floor(diffMs / (1000 * 60));

    if (diffMinutes < 1) return t('diff.justNow');
    if (diffMinutes < 60) return t('diff.minutesAgo', { count: diffMinutes });

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return t('diff.hoursAgo', { count: diffHours });

    const diffDays = Math.floor(diffHours / 24);
    return t('diff.daysAgo', { count: diffDays });
}

function getSnapshotDescription(snapshot: DocumentSnapshot, t: I18nT, language: Language): string {
    const description = snapshot.description;

    if (!description) {
        return formatExactTime(snapshot.timestamp, language);
    }

    if (description === ORIGINAL_FILE_VERSION_DESCRIPTION) {
        return t('diff.originalFileVersion');
    }

    if (
        description === REJECT_ALL_SNAPSHOT_DESCRIPTION ||
        description === 'Reject all (restore original content)'
    ) {
        return t('diff.rejectAllSnapshotDescription');
    }

    if (description.startsWith(ACCEPT_SNAPSHOT_PREFIX)) {
        return t('diff.acceptSnapshotDescription', {
            description: description.slice(ACCEPT_SNAPSHOT_PREFIX.length),
        });
    }

    if (description.startsWith(REJECT_SNAPSHOT_PREFIX)) {
        return t('diff.rejectSnapshotDescription', {
            description: description.slice(REJECT_SNAPSHOT_PREFIX.length),
        });
    }

    if (description.startsWith(ROLLBACK_SNAPSHOT_PREFIX)) {
        return t('diff.rollbackSnapshotDescription', {
            version: description.slice(ROLLBACK_SNAPSHOT_PREFIX.length),
        });
    }

    return description;
}

// ==================== 子组件 ====================

/**
 * 快照项
 */
function SnapshotItem({
    snapshot,
    index,
    isCurrentVersion,
    currentVersionNumber,
    diffSummary,
    onPreview,
    onRollback,
    onDelete,
}: SnapshotItemProps) {
    const { language, t } = useI18n();

    // 顶部标题：若能确定当前所在版本号，显示「当前版本（版本 N）」，方便回滚后定位
    const currentVersionLabel = isCurrentVersion
        ? (currentVersionNumber != null
            ? t('diff.currentVersionNumber', { number: currentVersionNumber })
            : t('diff.currentVersion'))
        : t('diff.version', { number: index });

    return (
        <div className={cx(styles.item, isCurrentVersion && styles.currentItem)}>
            <div className={styles.itemHeader}>
                <span className={styles.itemIndicator}>
                    {isCurrentVersion ? '●' : '○'}
                </span>
                <span className={styles.itemTitle}>
                    {currentVersionLabel}
                </span>
                {/* +N -M 压缩摘要：让用户扫一眼就能判断每个版本的变动规模 */}
                {diffSummary && !isCurrentVersion && (diffSummary.added > 0 || diffSummary.removed > 0) && (
                    <span className={styles.diffSummary}>
                        {diffSummary.added > 0 && (
                            <span className={styles.diffAdded}>+{diffSummary.added}</span>
                        )}
                        {diffSummary.removed > 0 && (
                            <span className={styles.diffRemoved}>-{diffSummary.removed}</span>
                        )}
                    </span>
                )}
                <Tooltip content={formatRelativeTime(snapshot.timestamp, t)}>
                    <span className={styles.itemTime}>
                        {formatExactTime(snapshot.timestamp, language)}
                    </span>
                </Tooltip>
            </div>

            {snapshot.description && (
                <div className={styles.itemDescription}>
                    {getSnapshotDescription(snapshot, t, language)}
                </div>
            )}

            {!isCurrentVersion && (
                <div className={styles.itemActions}>
                    <button
                        className={styles.previewBtn}
                        onClick={() => onPreview(snapshot)}
                    >
                        {t('diff.preview')}
                    </button>
                    <Tooltip content={t('diff.rollback')}>
                        <button
                            className={styles.rollbackBtn}
                            onClick={() => onRollback(snapshot)}
                        >
                            {t('diff.rollback')}
                        </button>
                    </Tooltip>
                    {onDelete && (
                        <Tooltip content={t('diff.deleteVersionTitle')}>
                            <button
                                className={styles.deleteBtn}
                                onClick={() => onDelete(snapshot)}
                            >
                                {t('common.delete')}
                            </button>
                        </Tooltip>
                    )}
                </div>
            )}
        </div>
    );
}

// RollbackConfirmDialog 已替换为 ConfirmDialog（variant='warning' + RotateCcw 图标）

/**
 * 预览弹窗
 *
 * 对比方向：前一版本 → 本版本（展示“这个版本做了什么”）
 * 解决原预览方向是「快照→当前」而非「前一版本→本版本」的错误
 */
function PreviewDialog({
    snapshot,
    previousContent,
    previousDescription,
    fileName,
    onClose,
}: {
    snapshot: DocumentSnapshot;
    previousContent: string; // 前一个快照的内容（或空字符串如果是最旧版本）
    previousDescription: string; // 前一个快照的描述
    fileName: string;
    onClose: () => void;
}) {
    const { language, t } = useI18n();
    // 对比方向：previousContent → snapshot.content（本版本相对于前一版本做了什么）
    const diffGenerator = fastApplyEngine.getDiffGenerator();
    const diff = diffGenerator.generateDiff(previousContent, snapshot.content);

    return (
        <div className={styles.container}>
            <div className={styles.previewHeader}>
                <h3>{t('diff.versionCompare')}</h3>
                <span className={styles.previewSubtitle}>
                    {previousDescription} → {getSnapshotDescription(snapshot, t, language)}
                </span>
                <button className={styles.closeBtn} onClick={onClose}>×</button>
            </div>
            <div className={styles.previewContent}>
                <DiffViewer
                    diff={diff}
                    fileName={fileName}
                />
            </div>
        </div>
    );
}

// ==================== 主组件 ====================

export function SnapshotHistory({
    snapshots,
    currentContent,
    fileName = 'document',
    activeSnapshotId,
    onRollback,
    onClose,
    isLoading: _isLoading = false,
    onDelete,
}: SnapshotHistoryProps) {
    const { language, t } = useI18n();
    const [previewSnapshot, setPreviewSnapshot] = useState<DocumentSnapshot | null>(null);
    const [previewPreviousContent, setPreviewPreviousContent] = useState<string>('');
    const [previewPreviousDescription, setPreviewPreviousDescription] = useState<string>('');
    const [rollbackSnapshot, setRollbackSnapshot] = useState<DocumentSnapshot | null>(null);
    // 是否为"原始文件版本"回滚（需要显示更强的警告弹窗）
    const [isOriginalVersionRollback, setIsOriginalVersionRollback] = useState(false);
    const [isRollingBack, setIsRollingBack] = useState(false);
    const [deleteSnapshot, setDeleteSnapshot] = useState<DocumentSnapshot | null>(null);
    const [_deletingId, setDeletingId] = useState<string | null>(null);

    /**
     * 计算每个快照相对于前一版本的增删行数
     * snapshots 按时间倒序（最新在最上），所以 index+1 就是更早的快照
     */
    const diffSummaries = useMemo((): DiffSummary[] => {
        const diffGenerator = fastApplyEngine.getDiffGenerator();
        return snapshots.map((snapshot, index) => {
            const previousContent = snapshots[index + 1]?.content ?? '';
            const diff = diffGenerator.generateDiff(previousContent, snapshot.content);
            const added = diff.hunks.reduce(
                (sum, hunk) => sum + hunk.lines.filter(l => l.type === 'add').length,
                0
            );
            const removed = diff.hunks.reduce(
                (sum, hunk) => sum + hunk.lines.filter(l => l.type === 'remove').length,
                0
            );
            return { added, removed };
        });
    }, [snapshots]);

    // 处理预览：确定前一版本的内容和描述
    const handlePreview = (snapshot: DocumentSnapshot, index: number) => {
        const previousSnapshot = snapshots[index + 1];
        setPreviewPreviousContent(previousSnapshot?.content ?? '');
        setPreviewPreviousDescription(
            previousSnapshot
                ? getSnapshotDescription(previousSnapshot, t, language)
                : t('diff.initialState')
        );
        setPreviewSnapshot(snapshot);
    };


    // 处理回滚点击：区分"原始文件版本"和普通版本，显示不同强度的确认弹窗
    const handleRollbackClick = (snapshot: DocumentSnapshot) => {
        const isOriginal = snapshot.description === ORIGINAL_FILE_VERSION_DESCRIPTION;
        setIsOriginalVersionRollback(isOriginal);
        setRollbackSnapshot(snapshot);
    };

    // 确认回滚
    const handleConfirmRollback = async () => {
        if (!rollbackSnapshot) return;

        setIsRollingBack(true);
        try {
            await onRollback(rollbackSnapshot.id);
            setRollbackSnapshot(null);
        } finally {
            setIsRollingBack(false);
        }
    };

    // 处理删除点击
    const handleDeleteClick = (snapshot: DocumentSnapshot) => {
        setDeleteSnapshot(snapshot);
    };

    // 确认删除
    const handleConfirmDelete = async () => {
        if (!onDelete || !deleteSnapshot) return;

        setDeletingId(deleteSnapshot.id);
        try {
            await onDelete(deleteSnapshot.id);
            setDeleteSnapshot(null);
        } finally {
            setDeletingId(null);
        }
    };

    // 取消删除
    const handleCancelDelete = () => {
        setDeleteSnapshot(null);
    };

    // 当前所在版本号：snapshots 倒序，index=0 是最新版（版本N），index=N-1 是最旧版（版本1）
    // activeSnapshotId 标记用户上次回滚停留的版本，计算其版本号便于顶部展示
    const currentVersionNumber = useMemo(() => {
        if (!activeSnapshotId || snapshots.length === 0) return null;
        const activeIndex = snapshots.findIndex(s => s.id === activeSnapshotId);
        if (activeIndex === -1) return null;
        return snapshots.length - activeIndex; // 倒序转换：index 0 = 版本N，index N-1 = 版本1
    }, [snapshots, activeSnapshotId]);

    // 创建当前版本的虚拟快照
    const currentVersionSnapshot: DocumentSnapshot = {
        id: 'current',
        documentId: snapshots[0]?.documentId ?? '',
        content: currentContent,
        timestamp: new Date(),
        description: '',
    };

    // 预览模式：整面板替换为预览页，彻底不透明，关闭后回到历史列表
    if (previewSnapshot) {
        return (
            <PreviewDialog
                snapshot={previewSnapshot}
                previousContent={previewPreviousContent}
                previousDescription={previewPreviousDescription}
                fileName={fileName}
                onClose={() => setPreviewSnapshot(null)}
            />
        );
    }

    return (
        <div className={styles.container}>
            {/* 头部 */}
            <div className={styles.header}>
                <h2 className={styles.title}>{t('diff.historyTitle', { fileName })}</h2>
                <button className={styles.closeBtn} onClick={onClose}>×</button>
            </div>

            {/* 快照列表 */}
            <div className={styles.list}>
                {/* 当前版本 */}
                <SnapshotItem
                    snapshot={currentVersionSnapshot}
                    index={0}
                    isCurrentVersion={true}
                    currentVersionNumber={currentVersionNumber}
                onPreview={() => undefined}
                onRollback={() => undefined}
                />

                <div className={styles.divider} />

                {/* 历史快照 */}
                {snapshots.map((snapshot, index) => (
                    <SnapshotItem
                        key={snapshot.id}
                        snapshot={snapshot}
                        index={snapshots.length - index}
                        isCurrentVersion={false}
                        diffSummary={diffSummaries[index]}
                        onPreview={() => handlePreview(snapshot, index)}
                        onRollback={handleRollbackClick}
                        onDelete={onDelete ? handleDeleteClick : undefined}
                    />
                ))}

                {snapshots.length === 0 && (
                    <div className={styles.empty}>
                        {t('diff.emptyHistory')}
                    </div>
                )}
            </div>

            {/* 普通版本回滚确认弹窗 */}
            <ConfirmDialog
                open={rollbackSnapshot !== null && !isOriginalVersionRollback}
                onClose={() => setRollbackSnapshot(null)}
                onConfirm={handleConfirmRollback}
                title={t('diff.confirmRollbackTitle')}
                description={t('diff.confirmRollbackDescription', {
                    version: rollbackSnapshot
                        ? getSnapshotDescription(rollbackSnapshot, t, language)
                        : formatExactTime(new Date(), language),
                })}
                confirmText={t('diff.confirmRollback')}
                cancelText={t('common.cancel')}
                variant="warning"
                isLoading={isRollingBack}
                icon={<RotateCcw size={24} />}
            />

            {/* 原始文件版本回滚强确认弹窗：警告将关闭审批面板 */}
            <ConfirmDialog
                open={rollbackSnapshot !== null && isOriginalVersionRollback}
                onClose={() => setRollbackSnapshot(null)}
                onConfirm={handleConfirmRollback}
                title={t('diff.restoreOriginalTitle')}
                description={t('diff.restoreOriginalDescription')}
                confirmText={t('diff.restoreOriginalConfirm')}
                cancelText={t('common.cancel')}
                variant="danger"
                isLoading={isRollingBack}
                icon={<RotateCcw size={24} />}
            />

            {/* 删除确认对话框 */}
            <ConfirmDialog
                open={deleteSnapshot !== null}
                onClose={handleCancelDelete}
                onConfirm={handleConfirmDelete}
                title={t('diff.confirmDeleteTitle')}
                description={t('diff.deleteVersionDescription', {
                    version: deleteSnapshot?.description
                        ? getSnapshotDescription(deleteSnapshot, t, language)
                        : t('diff.unnamed'),
                })}
                confirmText={t('common.delete')}
                cancelText={t('common.cancel')}
                variant="danger"
            />
        </div>
    );
}
