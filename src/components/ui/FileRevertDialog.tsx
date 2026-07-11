import { useState } from 'react';
import { useI18n } from '@/i18n';
import styles from './FileRevertDialog.module.css';

/**
 * DiffRecord 类型（与 Rust 端对应）
 */
export interface DiffRecord {
  id: string;
  contextId: string;
  messageId: string;
  documentId: string;
  originalContent: string;
  modifiedContent: string;
  xmlModification: string | null;
  status: 'pending' | 'applied' | 'reverted';
  createdAt: number;
  updatedAt: number;
}

/**
 * FileRevertDialog Props
 */
interface FileRevertDialogProps {
  /** 是否显示弹窗 */
  isOpen: boolean;
  /** 需要回滚的 Diff 记录列表 */
  records: DiffRecord[];
  /** 确认回滚 */
  onConfirm: () => Promise<void>;
  /** 取消操作 */
  onCancel: () => void;
  /** 是否正在处理 */
  isLoading?: boolean;
}

/**
 * FileRevertDialog - 文件回滚确认弹窗
 *
 * 当用户撤销消息时，如果该消息关联了文件编辑，
 * 显示此弹窗让用户确认是否回滚文件到编辑前的状态。
 */
export function FileRevertDialog({
  isOpen,
  records,
  onConfirm,
  onCancel,
  isLoading = false,
}: FileRevertDialogProps) {
  const [confirming, setConfirming] = useState(false);
  const { t } = useI18n();

  if (!isOpen || records.length === 0) {
    return null;
  }

  const handleConfirm = async () => {
    setConfirming(true);
    try {
      await onConfirm();
    } finally {
      setConfirming(false);
    }
  };

  // 提取唯一的文件路径
  const uniqueFiles = [...new Set(records.map((r) => r.documentId))];
  const fileNames = uniqueFiles.map((path) => path.split(/[/\\]/).pop() ?? path);

  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        {/* 头部 */}
        <div className={styles.header}>
          <div className={styles.warningIcon}>
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <h2 className={styles.title}>{t('fileRevert.title')}</h2>
        </div>

        {/* 内容 */}
        <div className={styles.content}>
          <p className={styles.description}>{t('fileRevert.description')}</p>
          <ul className={styles.fileList}>
            {fileNames.map((name, idx) => (
              <li key={idx} className={styles.fileItem}>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M4 2h5l3 3v9H4V2z" />
                  <path d="M9 2v3h3" />
                </svg>
                <span className={styles.fileName}>{name}</span>
              </li>
            ))}
          </ul>
          <p className={styles.warning}>{t('fileRevert.irreversibleWarning')}</p>
        </div>

        {/* 底部按钮 */}
        <div className={styles.footer}>
          <button
            className={styles.cancelBtn}
            onClick={onCancel}
            disabled={confirming || isLoading}
          >
            {t('common.cancel')}
          </button>
          <button
            className={styles.confirmBtn}
            onClick={handleConfirm}
            disabled={confirming || isLoading}
          >
            {confirming ? t('fileRevert.rollingBack') : t('fileRevert.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
