import { useCallback, useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useHubStore } from '@stores/hubStore';
import { ConfirmDialog } from '@components/ui/ConfirmDialog';
import { useI18n } from '@/i18n';
import styles from './HubContextMenu.module.css';
import { getLogger } from '@services/logger';
import { visualEnhancementJobManager } from '@services/planning/visual-enhancer/VisualEnhancementJobManager';

const logger = getLogger('HubContextMenu');

interface HubContextMenuProps {
    hubId: string;
    position: { x: number; y: number };
    onClose: () => void;
}

/**
 * HubContextMenu 组件
 *
 * Hub右键上下文菜单，支持：
 * - 重命名（内联编辑）
 * - 删除/移到回收站
 * - 点击外部区域关闭
 */
export function HubContextMenu({ hubId, position, onClose }: HubContextMenuProps) {
    const { t } = useI18n();
    const hubs = useHubStore((state) => state.hubs);
    const updateHub = useHubStore((state) => state.updateHub);
    const removeHub = useHubStore((state) => state.removeHub);

    const hub = hubs.find((h) => h.id === hubId);

    const [isRenaming, setIsRenaming] = useState(false);
    const [newName, setNewName] = useState(hub?.name ?? '');
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);

    const menuRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // 点击外部关闭（排除删除确认对话框）
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (showDeleteConfirm) return; // 显示确认对话框时不关闭菜单
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                onClose();
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [onClose, showDeleteConfirm]);

    // Escape关闭
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                if (showDeleteConfirm) {
                    setShowDeleteConfirm(false);
                } else if (isRenaming) {
                    setIsRenaming(false);
                    setNewName(hub?.name ?? '');
                } else {
                    onClose();
                }
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isRenaming, hub?.name, onClose, showDeleteConfirm]);

    // 聚焦重命名输入框
    useEffect(() => {
        if (isRenaming && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isRenaming]);

    // 计算菜单位置，防止超出屏幕
    const menuStyle = {
        left: Math.min(position.x, window.innerWidth - 180),
        top: Math.min(position.y, window.innerHeight - 150),
    };

    // 重命名操作
    const handleRename = useCallback(() => {
        setIsRenaming(true);
    }, []);

    // 提交重命名
    const handleRenameSubmit = useCallback(async () => {
        const trimmedName = newName.trim();
        if (!trimmedName || trimmedName === hub?.name) {
            setIsRenaming(false);
            setNewName(hub?.name ?? '');
            return;
        }

        try {
            // 调用Tauri命令更新Hub
            // 注意：Rust端期望参数名为 request，包含 name 字段
            await invoke('hub_update', { id: hubId, request: { name: trimmedName } });

            // 更新Store
            updateHub(hubId, { name: trimmedName });

            setIsRenaming(false);
            onClose();
        } catch (err) {
            logger.error('重命名Hub失败:', err);
            // 错误时恢复原名称
            setNewName(hub?.name ?? '');
            setIsRenaming(false);
        }
    }, [newName, hub?.name, hubId, updateHub, onClose]);

    // 重命名输入键盘事件
    const handleRenameKeyDown = useCallback(
        (event: React.KeyboardEvent) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                void handleRenameSubmit();
            }
        },
        [handleRenameSubmit]
    );

    // 打开删除确认对话框
    const handleDeleteClick = useCallback(() => {
        setShowDeleteConfirm(true);
    }, []);

    // 确认删除
    const handleConfirmDelete = useCallback(async () => {
        setIsDeleting(true);
        try {
            // 调用Tauri命令删除Hub（软删除到回收站）
            await invoke('hub_delete', { id: hubId });
            visualEnhancementJobManager.cancelContext(hubId);

            // 从Store移除
            removeHub(hubId);

            setShowDeleteConfirm(false);
            onClose();
        } catch (err) {
            logger.error('删除Hub失败:', err);
        } finally {
            setIsDeleting(false);
        }
    }, [hubId, removeHub, onClose]);

    // 取消删除
    const handleCancelDelete = useCallback(() => {
        setShowDeleteConfirm(false);
    }, []);

    if (!hub) {
        return null;
    }

    return (
        <>
            <div ref={menuRef} className={styles.contextMenu} style={menuStyle}>
                {isRenaming ? (
                    <input
                        ref={inputRef}
                        type="text"
                        className={styles.renameInput}
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={handleRenameKeyDown}
                        onBlur={handleRenameSubmit}
                        maxLength={50}
                    />
                ) : (
                    <>
                        <button className={styles.menuItem} onClick={handleRename}>
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <path d="M9.5 3.5l3 3M3 10.5V13h2.5L13 5.5l-3-3L3 10.5z" />
                            </svg>
                            {t('common.rename')}
                        </button>
                        <div className={styles.divider} />
                        <button className={styles.menuItem} data-danger="true" onClick={handleDeleteClick}>
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <path d="M3 4h10M6 4V3h4v1M5 4v9h6V4" />
                            </svg>
                            {t('common.delete')}
                        </button>
                    </>
                )}
            </div>

            {/* 删除确认对话框 */}
            <ConfirmDialog
                open={showDeleteConfirm}
                onClose={handleCancelDelete}
                onConfirm={handleConfirmDelete}
                title={t('hub.context.deleteTitle')}
                description={t('hub.context.deleteDescription', { name: hub.name })}
                confirmText={t('common.delete')}
                cancelText={t('common.cancel')}
                variant="danger"
                isLoading={isDeleting}
            />
        </>
    );
}
