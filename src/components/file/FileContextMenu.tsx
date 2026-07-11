/**
 * FileContextMenu - 文件右键菜单组件
 *
 * 提供文件的操作菜单：导出、删除
 */

import { useEffect, useRef } from 'react';
import { Download, Trash2, FolderOpen } from 'lucide-react';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './FileContextMenu.module.css';

interface FileContextMenuProps {
  /** 菜单位置 X */
  x: number;
  /** 菜单位置 Y */
  y: number;
  /** 文件名 */
  fileName: string;
  /** 是否为目录 */
  isDirectory?: boolean;
  /** 导出回调 */
  onExport: () => void;
  /** 在资源管理器中显示回调 */
  onRevealInExplorer: () => void;
  /** 删除回调 */
  onDelete: () => void;
  /** 关闭菜单回调 */
  onClose: () => void;
}

export function FileContextMenu({
  x,
  y,
  fileName,
  isDirectory,
  onExport,
  onRevealInExplorer,
  onDelete,
  onClose,
}: FileContextMenuProps) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    // 按 Escape 关闭
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // 调整菜单位置以确保不超出视口
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      if (rect.right > viewportWidth) {
        menuRef.current.style.left = `${viewportWidth - rect.width - 8}px`;
      }
      if (rect.bottom > viewportHeight) {
        menuRef.current.style.top = `${viewportHeight - rect.height - 8}px`;
      }
    }
  }, [x, y]);

  const handleExport = () => {
    onExport();
    onClose();
  };

  const handleRevealInExplorer = () => {
    onRevealInExplorer();
    onClose();
  };

  const handleDelete = () => {
    onDelete();
    onClose();
  };

  return (
    <div ref={menuRef} className={styles.menu} style={{ left: x, top: y }}>
      <div className={styles.header}>
        <span className={styles.fileName}>{fileName}</span>
      </div>
      <div className={styles.divider} />
      {/* 文件夹不显示导出（导出是逐文件内容操作） */}
      {!isDirectory && (
        <button className={styles.menuItem} onClick={handleExport}>
          <Download size={14} />
          <span>{t('file.exportLocal')}</span>
        </button>
      )}
      <button className={styles.menuItem} onClick={handleRevealInExplorer}>
        <FolderOpen size={14} />
        <span>{t('file.revealPath')}</span>
      </button>
      <button className={cx(styles.menuItem, styles.danger)} onClick={handleDelete}>
        <Trash2 size={14} />
        <span>{isDirectory ? t('file.deleteFolder') : t('file.deleteFile')}</span>
      </button>
    </div>
  );
}
