/**
 * ProjectPathButton - 项目路径关联按钮
 *
 * 功能：
 * - 点击后通过系统目录选择器选取外部项目文件夹
 * - 弹出授权确认对话框，告知用户 Agent 将拥有该目录的读写权限
 * - 用户确认后将 projectPath 持久化到数据库并更新 agentStore
 * - 已关联时显示项目名称标签，可点击解除关联
 *
 * 设计决策：
 * - 授权弹窗使用 ConfirmDialog（warning variant），降低用户误操作风险
 * - 解除关联时直接清除，无需二次确认（低风险操作，仅移除关联不删除文件）
 */

import { useState, useCallback, memo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, X } from 'lucide-react';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Tooltip } from '@components/ui/Tooltip';
import { useAgentStore } from '@stores/agentStore';
import { useI18n } from '@/i18n';
import styles from './ProjectPathButton.module.css';
import { getLogger } from '@services/logger';

const logger = getLogger('ProjectPathButton');

interface ProjectPathButtonProps {
    /** 当前 Agent ID */
    agentId: string;
    /** 当前关联的项目路径（null/undefined 表示未关联） */
    projectPath?: string | null;
    /** 是否禁用按钮 */
    disabled?: boolean;
}

/**
 * 从完整路径中提取最后一级目录名作为显示标签
 */
function extractFolderName(fullPath: string): string {
    const segments = fullPath.replace(/[\\/]+$/, '').split(/[\\/]/);
    return segments[segments.length - 1] ?? fullPath;
}

export const ProjectPathButton = memo(function ProjectPathButton({
    agentId,
    projectPath,
    disabled = false,
}: ProjectPathButtonProps) {
    const { t } = useI18n();
    const updateAgent = useAgentStore((state) => state.updateAgent);
    const [pendingPath, setPendingPath] = useState<string | null>(null);
    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    /**
     * 打开目录选择器
     *
     * 用户选中目录后不立即保存，而是先弹出授权确认对话框，
     * 让用户明确知道 Agent 将获得该目录的读写权限。
     */
    const handleOpenPicker = useCallback(async () => {
        try {
            const selectedPath = await open({
                directory: true,
                multiple: false,
                title: t('chat.projectSelectTitle'),
            });

            if (selectedPath && typeof selectedPath === 'string') {
                setPendingPath(selectedPath);
                setIsConfirmOpen(true);
            }
        } catch (error) {
            logger.error('[ProjectPathButton] 打开目录选择器失败:', error);
        }
    }, [t]);

    /**
     * 用户确认授权后持久化 projectPath
     *
     * 写入路径：invoke('agent_update') → DB，同步更新 agentStore
     */
    const handleConfirmBind = useCallback(async () => {
        if (!pendingPath) return;

        setIsSaving(true);
        try {
            await invoke('agent_update', {
                id: agentId,
                request: { project_path: pendingPath },
            });

            updateAgent(agentId, { projectPath: pendingPath });
            logger.info('[ProjectPathButton] 项目路径已关联:', pendingPath);
        } catch (error) {
            logger.error('[ProjectPathButton] 保存项目路径失败:', error);
        } finally {
            setIsSaving(false);
            setIsConfirmOpen(false);
            setPendingPath(null);
        }
    }, [agentId, pendingPath, updateAgent]);

    /**
     * 解除项目关联
     *
     * 低风险操作：仅清除数据库中的 projectPath 字段，不删除任何文件。
     * 传空字符串让后端写 NULL。
     */
    const handleUnlink = useCallback(async () => {
        setIsSaving(true);
        try {
            await invoke('agent_update', {
                id: agentId,
                request: { project_path: '' },
            });

            updateAgent(agentId, { projectPath: null });
            logger.info('[ProjectPathButton] 项目路径已解除关联');
        } catch (error) {
            logger.error('[ProjectPathButton] 解除项目关联失败:', error);
        } finally {
            setIsSaving(false);
        }
    }, [agentId, updateAgent]);

    const handleCloseConfirm = useCallback(() => {
        setIsConfirmOpen(false);
        setPendingPath(null);
    }, []);

    // 已关联项目：显示项目名称标签 + 解除按钮
    if (projectPath) {
        const folderName = extractFolderName(projectPath);
        return (
            <>
                <Tooltip content={t('chat.projectLinkedTitle', { path: projectPath })}>
                    <div className={styles.linkedBadge}>
                        <FolderOpen size={12} className={styles.badgeIcon} />
                        <span className={styles.badgeName}>{folderName}</span>
                        <button
                            className={styles.unlinkBtn}
                            onClick={handleUnlink}
                            disabled={disabled || isSaving}
                            aria-label={t('chat.projectUnlinkAria')}
                        >
                            <X size={10} />
                        </button>
                    </div>
                </Tooltip>
            </>
        );
    }

    // 未关联：显示"打开项目"按钮
    return (
        <>
            <Tooltip content={t('chat.projectOpenTitle')}>
                <button
                    className={styles.openProjectBtn}
                    onClick={handleOpenPicker}
                    disabled={disabled || isSaving}
                    aria-label={t('chat.projectOpenLabel')}
                >
                    <FolderOpen size={14} />
                    <span>{t('chat.projectOpenLabel')}</span>
                </button>
            </Tooltip>

            {/* 授权确认对话框 */}
            <ConfirmDialog
                open={isConfirmOpen}
                onClose={handleCloseConfirm}
                onConfirm={handleConfirmBind}
                title={t('chat.projectAuthTitle')}
                description={t('chat.projectAuthDescription', { path: pendingPath ?? '' })}
                confirmText={t('common.confirm')}
                cancelText={t('common.cancel')}
                variant="warning"
                isLoading={isSaving}
            />
        </>
    );
});
